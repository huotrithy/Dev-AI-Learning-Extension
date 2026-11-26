import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { LearningEvent } from "../src/learning/session.ts";

import { streamAnswer, streamLearning } from "../src/learning/session.ts";
import { docsLinks, docsReferences, loadDocs, searchDocs } from "../src/page/docs.ts";

const url = "https://example.test/docs/start";
const page = { title: "Start", url: `${url}?private=token#top`, text: "Install the CLI to work with queues." };
const retry = "https://example.test/docs/retries";
const other = "https://example.test/docs/jobs";
const parser = new (new JSDOM().window.DOMParser)();
const signal = new AbortController().signal;
const html = (title: string) => `<title>${title}</title><main><h1>${title}</h1><p>Backoff controls how long the worker waits before retrying.</p></main>`;

void test("docs discovery skips external, query, file, and unrelated navigation links", () => {
  const document = parser.parseFromString(`<nav>
    <a href="retries#limit">Retries</a><a href="/docs/retries">Duplicate</a><a href="start">Current</a>
    <a href="//example.test:8443/docs/admin">Different port</a><a href="http://example.test/docs/jobs">Different scheme</a>
    <a href="jobs?access_token=secret">Query</a><a href="archive.zip">File</a>
    <a href="/docs/jobs" rel="next">Jobs</a><a href="/">Home</a><a href="/account">Account</a></nav>`, "text/html");
  assert.deepEqual(docsLinks(document, page.url), [other, retry]);
});

void test("docs discovery respects a page base address and checks the origin after resolving", () => {
  const withBase = (base: string) => parser.parseFromString(`<base href="${base}"><main><a href="install">Install</a></main>`, "text/html");
  assert.deepEqual(docsLinks(withBase("/manual/v3/"), url), ["https://example.test/manual/v3/install"]);
  assert.deepEqual(docsLinks(withBase("https://outside.test/"), url), []);
});

void test("docs reads at most four same-origin HTML pages and keeps partial results", async () => {
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
  assert.deepEqual(result.docs.map(({ title, url }) => ({ title, url })), [{ title: "Retries", url: retry }]);
  assert.match(result.docs[0]?.text ?? "", /Backoff controls/);
});

void test("docs indexing follows one extra level within the same section with a shared eight-page limit", async () => {
  const direct = [retry, other, ...[1, 2].map(index => `https://example.test/docs/guide-${index}`)];
  const calls: string[] = [];
  const result = await loadDocs({ ...page, relatedLinks: direct }, signal, parser, async (input) => {
    const address = String(input);
    calls.push(address);
    const index = direct.indexOf(address);
    const links = index === -1
      ? `<a href="/docs/third-level">Third level</a>`
      : `<a href="/account">Account</a><a href="${retry}/">Duplicate</a>
         <a href="/docs/start">Original</a><a href="/docs/private?token=secret">Query</a>
         <a href="https://outside.test/docs/install">External</a>
         ${[1, 2, 3].map(item => `<a href="/docs/topic-${index}-${item}">Topic</a>`).join("")}`;
    return new Response(`${html("Guide")}<main>${links}</main>`, { headers: { "content-type": "text/html" } });
  });
  const indexed = ["0-1", "0-2", "0-3", "1-1", "1-2", "1-3", "2-1", "2-2"].map(topic => `https://example.test/docs/topic-${topic}`);
  assert.deepEqual(calls, [...direct, ...indexed]);
  assert.deepEqual(result.docs.map(source => source.url), direct);
  assert.deepEqual(result.docsIndex.map(source => source.url), indexed);
});

void test("a docs follow-up can cite a relevant indexed page missing from the overview", async () => {
  const throttling = "https://example.test/docs/rate-limits";
  const source = {
    ...page,
    docs: [
      { title: "Retries", url: retry, text: "Use exponential backoff." },
      { title: "Jobs", url: other, text: "Enqueue jobs." },
      { title: "Workers", url: "https://example.test/docs/workers", text: "Run the worker process." },
      { title: "Installation", url: "https://example.test/docs/install", text: "Install the CLI." },
    ],
    docsIndex: [{ title: "Rate limits", url: throttling, text: "Throttle workers by setting max_concurrency." }],
  };
  assert.ok(docsReferences(source)?.every(reference => reference.url !== throttling));
  assert.strictEqual(searchDocs(source, "zzz"), source);

  const question = "Where do I set max_concurrency?";
  const selected = searchDocs(source, question);
  assert.deepEqual(docsReferences(selected)?.map(reference => reference.url), [
    url,
    throttling,
    retry,
    other,
    "https://example.test/docs/workers",
  ]);
  const prompts: string[] = [];
  const gateway = {
    async* stream({ prompt }: { prompt: string }) {
      prompts.push(prompt);
      yield "Text";
    },
    decide: async () => assert.fail("Docs follow-ups do not need model routing"),
  };
  for await (const _chunk of streamAnswer(selected, question, [], "new", "", gateway, signal)) { /* drain */ }
  assert.match(prompts[0] ?? "", /Throttle workers by setting max_concurrency/);
  assert.ok(prompts[0]?.includes(throttling));
});

void test("docs excerpts preserve short technical terms that matched during page search", async () => {
  const automation = "https://example.test/docs/automation";
  const source = {
    ...page,
    docs: [{ title: "Retries", url: retry, text: "Use exponential backoff." }],
    docsIndex: [{ title: "Automation", url: automation, text: `${"Queue processing. ".repeat(450)}CI runs the integration checks.` }],
  };
  const question = "How does CI work?";
  const prompts: string[] = [];
  const gateway = {
    async* stream({ prompt }: { prompt: string }) {
      prompts.push(prompt);
      yield "Text";
    },
    decide: async () => assert.fail("Docs follow-ups do not need model routing"),
  };
  for await (const _chunk of streamAnswer(searchDocs(source, question), question, [], "new", "", gateway, signal)) { /* drain */ }
  assert.match(prompts[0] ?? "", /CI runs the integration checks/);
});

void test("docs section landing pages exclude unrelated second-hop links with or without a trailing slash", async () => {
  for (const landing of ["https://example.test/docs", "https://example.test/docs/"]) {
    const calls: string[] = [];
    await loadDocs({ ...page, url: landing, relatedLinks: [retry] }, signal, parser, async (input) => {
      const address = String(input);
      calls.push(address);
      const links = address === retry
        ? `<main><a href="/account/profile" rel="next">Profile</a><a href="/docs/jobs">Jobs</a></main>`
        : "";
      return new Response(html("Guide") + links, { headers: { "content-type": "text/html" } });
    });
    assert.deepEqual(calls, [retry, other]);
  }
});

void test("docs overview includes a reading path and answers use loaded excerpts with exact citation URLs", async () => {
  const source = { ...page, docs: [{ title: "Retries", url: retry, text: "Use exponential backoff." }] };
  assert.deepEqual(docsReferences(source), [{ title: "Start", url }, { title: "Retries", url: retry }]);
  const prompts: string[] = [];
  const gateway = {
    async* stream({ prompt, system }: { prompt: string; system: string }) {
      prompts.push(`${system}\n${prompt}`);
      yield "Text";
    },
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

void test("cancelling docs learning aborts linked fetches and discards the collection", async () => {
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
