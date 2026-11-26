import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { readPageDiagram } from "../src/learning/page-diagram.ts";
import { LatestRequest, streamLearning } from "../src/learning/session.ts";
import { createGateway, decideWithFallback } from "../src/models/gateway.ts";
import { createProfile } from "../src/models/profiles.ts";

test("streams the introduction while classification is pending", async () => {
  const route = Promise.withResolvers<unknown>();
  const events = streamLearning({ title: "Queues", url: "https://example.test/", text: "Jobs are acknowledged." }, "new", "", {
    stream: async function* () { yield "A queue gives work to a consumer."; },
    decide: () => route.promise,
  }, new AbortController().signal);

  const first = await events.next();
  assert.deepEqual(first.value, { section: "intro", text: "A queue gives work to a consumer." });
  route.resolve({ sourceType: "page", diagram: false });
  await events.return();
});

test("page learning compiles a supported graph and removes Mermaid syntax from its labels", async () => {
  const events = [];
  const calls: (string | undefined)[] = [];
  for await (const event of streamLearning(
    { title: "Queues", url: "https://example.test/", text: "A queue delivers jobs\n to a worker." },
    "new", "", {
      stream: async function* (request) {
        assert.doesNotMatch(request.prompt, /Return only Mermaid syntax/);
        yield "Queue explanation.";
      },
      decide: async (request) => {
        calls.push(request.activity);
        if (calls.length === 1)
          return { sourceType: "page", diagram: true };
        assert.match(request.prompt, /A queue delivers jobs/);
        return {
          nodes: ["C++/CLI", 'C# worker\nclick n0 "https://example.test/"'],
          connections: [{ from: 0, to: 1, label: "delivers jobs", evidence: "A queue delivers jobs to a worker." }],
        };
      },
    }, new AbortController().signal,
  )) events.push(event);
  assert.deepEqual(calls, ["Classify the source", "Extract diagram relationships"]);
  const diagram = events.find(event => event.section === "diagram");
  assert.ok(diagram && "text" in diagram);
  assert.match(diagram.text, /^flowchart TD\n/);
  assert.match(diagram.text, /n0\["C\+\+\/CLI"\]/);
  assert.match(diagram.text, /n1\["C# worker/);
  assert.match(diagram.text, /n0 -->\|delivers jobs\| n1/);
  assert.doesNotMatch(diagram.text, /click |https:\/\//);
});

void test("page diagram evidence can come from a relevant excerpt late in the page", async () => {
  const quote = "The queue delivers jobs to the worker.";
  const text = `${"Unrelated reference text. ".repeat(600)}\n${quote}`;
  const diagram = await readPageDiagram(
    { title: "Queue worker", url: "https://example.test/", text },
    {
      async *stream() { yield ""; },
      async decide({ prompt }) {
        assert.ok(prompt.includes(quote));
        return { nodes: ["Queue", "Worker"], connections: [{ from: 0, to: 1, label: "delivers jobs", evidence: quote }] };
      },
    },
    new AbortController().signal,
  );
  assert.match(diagram ?? "", /n0 -->\|delivers jobs\| n1/);
});

test("an unsupported page diagram gets one retry and leaves the walkthrough visible", async () => {
  let attempts = 0;
  const events = [];
  for await (const event of streamLearning(
    { title: "Queues", url: "https://example.test/", text: "A queue delivers jobs to a worker." },
    "new", "", {
      stream: async function* () { yield "Queue explanation."; },
      decide: async (request) => {
        if (request.activity === "Classify the source")
          return { sourceType: "page", diagram: true };
        attempts++;
        return {
          nodes: ["Queue", "Worker"],
          connections: [{ from: 0, to: attempts === 1 ? 1 : 5, label: "delivers jobs", evidence: attempts === 1 ? "A queue sends email." : "A queue delivers jobs to a worker." }],
        };
      },
    }, new AbortController().signal,
  )) events.push(event);
  assert.equal(attempts, 2);
  assert.ok(events.some(event => event.section === "steps"));
  assert.ok(events.every(event => event.section !== "diagram"));
});

test("a new request invalidates updates and aborts network work from the old page", () => {
  const gate = new LatestRequest();
  const previous = gate.start();
  const current = gate.start();
  assert.equal(previous.signal.aborted, true);
  assert.equal(gate.isCurrent(previous), false);
  assert.equal(gate.isCurrent(current), true);
});

test("malformed tool output falls back to JSON with one repair attempt", async () => {
  const responses = ["Prose only", "{\"route\":\"page\"}"];
  const result = await decideWithFallback(z.object({ route: z.literal("page") }), {
    tool: async () => ({ route: "unsupported" }),
    text: async () => responses.shift() ?? assert.fail("Unexpected extra repair"),
  });
  assert.deepEqual(result, { route: "page" });
  assert.deepEqual(responses, []);
});

test("unusable structured output gives the caller a safe fallback", async () => {
  const result = await decideWithFallback(z.object({ route: z.literal("page") }), {
    text: async () => "{\"route\":\"other\"}",
  });
  assert.equal(result, undefined);
});

test("provider errors after visible text still reject the response", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    "data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Partial\"},\"finish_reason\":null}]}",
    "data: {\"error\":{\"message\":\"Fixture provider error\",\"type\":\"server_error\"}}",
    "data: [DONE]",
    "",
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
  try {
    const profile = { id: "x", label: "Fixture", provider: "compatible", model: "fixture", endpoint: "https://example.test/v1", key: "", toolCalls: false, disableThinking: false } as const;
    const result = createGateway(profile, profile).stream({ system: "Fixture", prompt: "Fixture", maxOutputTokens: 10 }, new AbortController().signal);
    const chunks: string[] = [];
    await assert.rejects(async () => { for await (const chunk of result) chunks.push(chunk); });
    assert.deepEqual(chunks, ["Partial"]);
  }
  finally {
    globalThis.fetch = fetch;
  }
});

test("model credentials require HTTPS outside loopback", () => {
  const profile = { ...createProfile(), endpoint: "http://192.168.1.5:8080/v1" };
  assert.doesNotThrow(() => createGateway(profile, profile), "Keyless LAN models still work");
  const keyed = { ...profile, key: "fixture-key" };
  assert.throws(() => createGateway(profile, keyed), /Use HTTPS/);
  for (const endpoint of ["http://localhost:8080/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1", "https://example.test/v1"]) {
    const local = { ...keyed, endpoint };
    assert.doesNotThrow(() => createGateway(local, local), endpoint);
  }
});
