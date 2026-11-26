import assert from "node:assert/strict";
import { test } from "node:test";
import { githubRepository, loadRepository, traceRepository } from "../src/page/github.ts";
import { pageContext } from "../src/learning/context.ts";
import { streamLearning, type LearningEvent } from "../src/learning/session.ts";
import { architectureFlowchart } from "../src/learning/architecture.ts";

const repo = { owner: "example", name: "reader" };
const commit = "a".repeat(40);
const tree = "b".repeat(40);
const signal = new AbortController().signal;

const architecturePage = {
  title: "example/reader",
  url: "https://github.com/example/reader",
  text: "",
  repository: {
    branch: "main",
    commit,
    truncated: false,
    paths: ["src/index.ts", "src/worker.ts", "src/unread.ts"],
    files: [
      { path: "src/index.ts", url: `https://github.com/example/reader/blob/${commit}/src/index.ts`, text: "import { run } from \"./worker\"; run();" },
      { path: "src/worker.ts", url: `https://github.com/example/reader/blob/${commit}/src/worker.ts`, text: "export function run() {}" },
    ],
  },
};

test("repo learning publishes one architecture map with source links from the inspected commit", async () => {
  const events: LearningEvent[] = [];
  for await (const event of streamLearning(architecturePage, "new", "", {
    stream: async function* () { yield "Explanation text"; },
    decide: async () => ({
      components: [
        { name: "Entry point", files: ["src/index.ts"], url: "https://example.test/invented" },
        { name: "Worker", files: ["src/worker.ts", "src/unread.ts"] },
        { name: "Uninspected", files: ["src/unread.ts"] },
      ],
      connections: [
        { from: 0, to: 1, label: "calls" },
        { from: 0, to: 2, label: "calls" },
        { from: 0, to: 8, label: "calls" },
      ],
    }),
  }, signal)) events.push(event);
  assert.equal(events[0]?.section, "intro");
  assert.deepEqual(events.filter(({ section }) => section === "architecture"), [{
    section: "architecture",
    map: {
      components: [
        { id: 0, name: "Entry point", files: [{ path: "src/index.ts", url: `https://github.com/example/reader/blob/${commit}/src/index.ts` }] },
        { id: 1, name: "Worker", files: [{ path: "src/worker.ts", url: `https://github.com/example/reader/blob/${commit}/src/worker.ts` }] },
      ],
      connections: [{ from: 0, to: 1, label: "calls" }],
    },
  }]);
  assert.ok(events.some(({ section }) => section === "steps"));
  assert.ok(events.every(({ section }) => section !== "diagram"));
});

test("an unavailable architecture map leaves the repo explanation and walkthrough readable", async () => {
  const events: LearningEvent[] = [];
  for await (const event of streamLearning(architecturePage, "new", "", {
    stream: async function* () { yield "Explanation text"; },
    decide: async () => { throw new Error("Provider unavailable"); },
  }, signal)) events.push(event);
  assert.deepEqual(events.find(({ section }) => section === "architecture"), { section: "architecture", map: null });
  assert.ok(events.some(({ section }) => section === "steps"));
});

test("the architecture diagram turns model labels into text, even when they contain Mermaid syntax", () => {
  const source = architectureFlowchart({
    components: [
      { id: 0, name: "Input\"]\nclick n0 href \"https://example.test\"", files: [] },
      { id: 1, name: "<Worker>", files: [] },
    ],
    connections: [{ from: 0, to: 1, label: "calls|\n%%{init: {}}" }],
  });
  assert.equal(source.split("\n").length, 4);
  assert.doesNotMatch(source, /\b(?:click|href)\s|%%\{|<Worker>|https:\/\//);
  assert.match(source, /n1\["Worker"\]/);
  assert.match(source, /n0 -->\|calls init\| n1/);
});

test("recognizes GitHub repository home pages without matching unrelated GitHub URLs", () => {
  assert.deepEqual(githubRepository("https://github.com/example/reader/?tab=readme-ov-file"), repo);
  for (const url of [
    "https://github.com.evil.example/example/reader",
    "https://github.com/topics/typescript",
    "https://github.com/example/reader/issues",
    "https://github.com/example/reader/blob/main/README.md",
    "https://github.com/example/%2Freader",
    "https://name@github.com/example/reader",
  ]) assert.equal(githubRepository(url), undefined, url);
});

test("reads public source excerpts from the same commit and skips binary and generated files", async () => {
  const paths: string[] = [];
  const page = await loadRepository(repo, signal, async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/repos/example/reader", "");
    paths.push(path);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    if (path === "")
      return Response.json({ default_branch: "main", description: "A browser reader" });
    if (path === "/commits/main")
      return Response.json({ sha: commit, commit: { tree: { sha: tree } } });
    if (path === `/git/trees/${tree}`) {
      return Response.json({ truncated: true, tree: [
        { path: "README.md", type: "blob", mode: "100644", size: 12 },
        { path: "src/index.ts", type: "blob", mode: "100644", size: 10 },
        { path: "src/worker.ts", type: "blob", mode: "100644", size: 14 },
        { path: "dist/index.js", type: "blob", mode: "100644", size: 21 },
        { path: "pnpm-lock.yaml", type: "blob", mode: "100644", size: 19 },
        { path: "logo.png", type: "blob", mode: "100644", size: 15 },
        { path: "src/symlink.ts", type: "blob", mode: "120000", size: 15 },
      ] });
    }
    assert.equal(url.searchParams.get("ref"), commit);
    return new Response(path.endsWith("worker.ts") ? "renderScheduler dispatches work" : "Project context");
  });
  assert.deepEqual(paths.slice(3).sort(), ["/contents/README.md", "/contents/src/index.ts", "/contents/src/worker.ts"]);
  assert.equal(page.repository?.truncated, true);
  const context = JSON.parse(pageContext(page, 5_000, "Where does renderScheduler dispatch work?"));
  assert.equal(context.files[0].url, `https://github.com/example/reader/blob/${commit}/src/worker.ts`);
  assert.equal(context.files[0].text, "renderScheduler dispatches work");
  assert.equal(context.files.length, 3);
});

test("reports GitHub rate limits before calling the model", async () => {
  await assert.rejects(loadRepository(repo, signal, async () => new Response("", {
    status: 403,
    headers: { "x-ratelimit-remaining": "0" },
  })), /rate limit/i);
});

test("explains that a missing or private GitHub repository cannot be read", async () => {
  await assert.rejects(loadRepository(repo, signal, async () => new Response("", { status: 404 })), /repository is public/i);
});

test("a trace fetches the named source file and a relative import at the original commit", async () => {
  const root = "https://github.com/example/reader";
  const page = { title: "example/reader", url: root, text: "", repository: {
    branch: "main",
    commit,
    truncated: false,
    paths: [],
    candidatePaths: ["src/dispatch-jobs.ts", "src/runtime/runner.ts", "src/unrelated.ts"],
    files: [{ path: "src/index.ts", url: `${root}/blob/${commit}/src/index.ts`, text: "export const started = true;" }],
  } };
  const calls: string[] = [];
  const question = "How does dispatchJobs work?";
  const source = await traceRepository(page, question, signal, async (input) => {
    const url = new URL(String(input));
    assert.equal(url.host, "api.github.com");
    assert.equal(url.searchParams.get("ref"), commit);
    const path = url.pathname.split("/contents/")[1]!;
    calls.push(path);
    if (path === "src/dispatch-jobs.ts") {
      return new Response([
        "import { run } from './runtime/runner.js';",
        ...Array(70).fill("// More context for the implementation."),
        "export function dispatchJobs() { return run(); }",
      ].join("\n"));
    }
    if (path === "src/runtime/runner.ts")
      return new Response("export const run = () => executeNextJob();");
    assert.fail(`Unexpected fetch: ${path}`);
  });
  assert.deepEqual(calls, ["src/dispatch-jobs.ts", "src/runtime/runner.ts"]);
  const context = JSON.parse(pageContext(source, 12_000, question));
  const dispatch = context.files.find(({ path }: { path: string }) => path === "src/dispatch-jobs.ts");
  assert.match(dispatch.text, /export function dispatchJobs/);
  assert.match(dispatch.url, new RegExp(`/blob/${commit}/src/dispatch-jobs\\.ts#L\\d+-L72$`));
  assert.ok(context.files.some(({ text }: { text: string }) => text.includes("executeNextJob")));
});

test("a trace reads beyond the overview excerpt when the question names that file", async () => {
  const path = "src/index.ts";
  const url = `https://github.com/example/reader/blob/${commit}/${path}`;
  const page = { title: "example/reader", url: "https://github.com/example/reader", text: "", repository: {
    branch: "main",
    commit,
    truncated: false,
    paths: [path],
    candidatePaths: [path],
    files: [{ path, url, text: "export const started = true;" }],
  } };
  const traced = await traceRepository(page, "How does finishJob work in src/index.ts?", signal, async () => new Response(`${Array(70).fill("// Extra lines in the file.").join("\n")}\nfunction finishJob() { closeQueue(); }`));
  assert.equal(traced.repository?.files.length, 1);
  assert.match(traced.repository?.files[0]?.text ?? "", /closeQueue/);
  assert.match(traced.repository?.files[0]?.url ?? "", /#L\d+-L71$/);
  assert.equal(page.repository.files[0]?.url, url);
});

test("one question makes at most three requests for source files", async () => {
  const page = { title: "example/reader", url: "https://github.com/example/reader", text: "", repository: {
    branch: "main",
    commit,
    truncated: false,
    paths: [],
    files: [],
    candidatePaths: ["src/jobs/start.ts", "src/jobs/queue.ts", "src/jobs/retry.ts", "src/jobs/stop.ts"],
  } };
  let requests = 0;
  const traced = await traceRepository(page, "How do jobs work?", signal, async () => {
    requests += 1;
    return new Response("export const enabled = true;");
  });
  assert.equal(requests, 3);
  assert.equal(traced.repository?.files.length, 3);
});
