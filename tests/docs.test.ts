import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { docsLinks, docsReferences, loadDocs } from "../src/page/docs.ts";
import { streamAnswer, streamLearning, type LearningEvent } from "../src/learning/session.ts";

const url = "https://example.test/docs/start";
const page = { title: "Start", url: `${url}?private=token#top`, text: "Install the CLI to work with queues." };
const retry = "https://example.test/docs/retries";
const other = "https://example.test/docs/jobs";
const parser = new (new JSDOM().window.DOMParser)();
const signal = new AbortController().signal;
const html = (title: string) => `<title>${title}</title><main><h1>${title}</h1><p>Backoff controls how long the worker waits before retrying.</p></main>`;

test("docs discovery skips external, query, file, and unrelated navigation links", () => {
  const document = parser.parseFromString(`<nav>
    <a href="retries#limit">Retries</a><a href="/docs/retries">Duplicate</a><a href="start">Current</a>
    <a href="//example.test:8443/docs/admin">Different port</a><a href="http://example.test/docs/jobs">Different scheme</a>
    <a href="jobs?access_token=secret">Query</a><a href="archive.zip">File</a>
    <a href="/docs/jobs" rel="next">Jobs</a><a href="/">Home</a><a href="/account">Account</a></nav>`, "text/html");
  assert.deepEqual(docsLinks(document, page.url), [other, retry]);
});

test("docs discovery respects a page base address and checks the origin after resolving", () => {
  const withBase = (base: string) => parser.parseFromString(`<base href="${base}"><main><a href="install">Install</a></main>`, "text/html");
  assert.deepEqual(docsLinks(withBase("/manual/v3/"), url), ["https://example.test/manual/v3/install"]);
  assert.deepEqual(docsLinks(withBase("https://outside.test/"), url), []);
});

test("docs reads at most four same-origin HTML pages and keeps partial results", async () => {
  const urls = [retry, other, ...["one", "two", "overflow"].map(slug => `https://example.test/docs/${slug}`)];
  const calls: string[] = [];
  const result = await loadDocs({ ...page, relatedLinks: ["https://outside.test/docs/", ...urls] }, signal, parser, async (input, options) => {
    const requested = String(input);
    calls.push(requested);
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.referrerPolicy, "no-referrer");
    if (requested === retry)
      return new Response(html("Retries"), { headers: { "content-type": "text/html; charset=UTF-8" } });
    if (requested === other)
      return new Response(html("Archive"), { headers: { "content-type": "application/pdf" } });
    if (requested.endsWith("/one"))
      return new Response("x".repeat(1_000_001), { headers: { "content-type": "text/html" } });
    throw new TypeError("Failed request");
  });
  assert.deepEqual(calls, urls.slice(0, 4));
  assert.deepEqual(result?.map(({ title, url }) => ({ title, url })), [{ title: "Retries", url: retry }]);
  assert.match(result?.[0]?.text ?? "", /Backoff controls/);
});

test("docs overview includes a reading path and answers use loaded excerpts with exact citation URLs", async () => {
  const source = { ...page, docs: [{ title: "Retries", url: retry, text: "Use exponential backoff." }] };
  assert.deepEqual(docsReferences(source), [{ title: "Start", url }, { title: "Retries", url: retry }]);
  const prompts: string[] = [];
  const gateway = {
    stream: async function* ({ prompt, system }: { prompt: string; system: string }) { prompts.push(`${system}\n${prompt}`); yield "Text"; },
    decide: async () => assert.fail("Docs learning already knows its source type"),
  };
  const events: LearningEvent[] = [];
  for await (const event of streamLearning(source, "new", "", gateway, signal)) events.push(event);
  assert.ok(events.some(({ section }) => section === "reading"));
  assert.ok(prompts.some(prompt => prompt.includes("reading path") && prompt.includes(retry)));
  for await (const _chunk of streamAnswer(source, "How do retries work?", [], "new", "", gateway, signal)) { /* drain */ }
  const answer = prompts.at(-1) ?? "";
  assert.match(answer, /exact URLs/);
  assert.match(answer, /Use exponential backoff/);
  assert.ok(answer.includes(retry));
  assert.ok(answer.includes(url));
  assert.doesNotMatch(answer, /private=token/);
});

test("cancelling docs learning aborts linked fetches and discards the collection", async () => {
  const controller = new AbortController();
  const result = loadDocs({ ...page, relatedLinks: [retry] }, controller.signal, parser, async (_input, options) => {
    await new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });
    return assert.fail("Cancelled fetch must not produce a response");
  });
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
});
