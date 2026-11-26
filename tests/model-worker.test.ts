import type { TestContext } from "node:test";

import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityStep } from "../src/learning/activity.ts";
import type { ModelProfile } from "../src/models/profiles.ts";

import { createActivity, trackModelActivity } from "../src/learning/activity.ts";
import { decisionSchemas } from "../src/models/decision-schemas.ts";
import { createProfile } from "../src/models/profiles.ts";
import { createWorkerGateway, ModelProfileChangedError } from "../src/models/worker-client.ts";
import { serveModelPort } from "../src/models/worker.ts";

const profile = {
  ...createProfile(),
  model: "fixture",
  endpoint: "https://example.test/v1",
  customHeaders: [
    { name: "CF-Access-Client-Id", value: "fixture-id" },
    { name: "CF-Access-Client-Secret", value: "fixture-secret" },
  ],
};
const request = { system: "Fixture", prompt: "Fixture", maxOutputTokens: 20 };

function channel<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    addListener: (listener: (value: T) => void) => listeners.add(listener),
    removeListener: (listener: (value: T) => void) => listeners.delete(listener),
    emit: (value: T) => { for (const listener of listeners) listener(value); },
  };
}

function connectWorker(t: TestContext, profiles: ModelProfile[] = [profile]) {
  const messages: unknown[] = [];
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  t.after(() => {
    if (originalChrome)
      Object.defineProperty(globalThis, "chrome", originalChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  });
  const chromeFixture = {
    storage: { local: { setAccessLevel: async () => {}, get: async () => ({ models: { profiles } }) } },
    permissions: { contains: async () => true },
    runtime: { connect: () => {
      const clientMessages = channel<unknown>();
      const workerMessages = channel<unknown>();
      const workerDisconnect = channel<void>();
      let open = true;
      serveModelPort({
        onMessage: workerMessages,
        onDisconnect: workerDisconnect,
        postMessage: (value: unknown) => clientMessages.emit(value),
      } as unknown as chrome.runtime.Port);
      return {
        onMessage: clientMessages,
        onDisconnect: channel<void>(),
        postMessage: (value: unknown) => {
          messages.push(value);
          queueMicrotask(() => {
            if (open)
              workerMessages.emit(value);
          });
        },
        disconnect: () => {
          if (!open)
            return;
          open = false;
          workerDisconnect.emit();
        },
      };
    } },
  };
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: chromeFixture });
  return messages;
}

test("the worker streams with saved Cloudflare headers and uses the system profile for structured requests", async (t) => {
  const system = { ...profile, id: "system", endpoint: "http://127.0.0.1:8080/v1", customHeaders: [] };
  const messages = connectWorker(t, [profile, system]);
  const requests: { url: string; headers: Headers; redirect?: RequestRedirect }[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
    const base = { id: "fixture", model: "fixture", created: 0 };
    if (requests.length === 1) {
      const chunk = { ...base, choices: [{ index: 0, delta: { content: "Ready" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      ...base,
      choices: [{ index: 0, message: { role: "assistant", content: "{\"sourceType\":\"page\",\"diagram\":false}" }, finish_reason: "stop" }],
    });
  });
  const gateway = createWorkerGateway(profile, system);
  const signal = new AbortController().signal;
  const chunks = [];
  for await (const chunk of gateway.stream(request, signal)) chunks.push(chunk);
  assert.deepEqual(chunks, ["Ready"]);
  assert.deepEqual(await gateway.decide(request, decisionSchemas.route, signal), { sourceType: "page", diagram: false });
  assert.deepEqual(requests.map(({ url, headers, redirect }) => [
    url,
    headers.get("cf-access-client-id"),
    headers.get("cf-access-client-secret"),
    headers.get("authorization"),
    redirect,
  ]), [
    ["https://example.test/v1/chat/completions", "fixture-id", "fixture-secret", null, "error"],
    ["http://127.0.0.1:8080/v1/chat/completions", null, null, null, "error"],
  ]);
  assert.equal(JSON.stringify(messages).includes("fixture-secret"), false);
});

test("stopping in the reader aborts the worker fetch", async (t) => {
  connectWorker(t);
  const received = Promise.withResolvers<AbortSignal>();
  t.mock.method(globalThis, "fetch", (_input: RequestInfo | URL, init: RequestInit) => {
    const signal = init.signal!;
    received.resolve(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const result = createWorkerGateway(profile, profile).stream(request, controller.signal)[Symbol.asyncIterator]().next();
  const aborted = assert.rejects(result, { name: "AbortError" });
  const fetchSignal = await received.promise;
  controller.abort();
  await aborted;
  assert.equal(fetchSignal.aborted, true);
});

test("a stale reader cannot send page text to a profile that has moved", async (t) => {
  connectWorker(t, [{ ...profile, endpoint: "https://another.test/v1" }]);
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("A stale profile must not fetch"));
  const iterator = createWorkerGateway(profile, profile).stream(request, new AbortController().signal)[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), ModelProfileChangedError);
  assert.equal(fetch.mock.callCount(), 0);
});

void test("an exact chat URL is used for both streaming and structured chat", async (t) => {
  const chat = { ...profile, endpoint: "", chatEndpoint: "https://example.test/custom/generate" };
  connectWorker(t, [chat]);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    const base = { id: "fixture", model: "fixture", created: 0 };
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    if (body.stream === true) {
      const chunk = { ...base, choices: [{ index: 0, delta: { content: "Ready" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      ...base,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ sourceType: "page", diagram: false }) }, finish_reason: "stop" }],
    });
  });
  const gateway = createWorkerGateway(chat, chat);
  const signal = new AbortController().signal;
  const chunks = [];
  for await (const chunk of gateway.stream(request, signal)) chunks.push(chunk);
  assert.deepEqual(chunks, ["Ready"]);
  assert.deepEqual(await gateway.decide(request, decisionSchemas.route, signal), { sourceType: "page", diagram: false });
  assert.deepEqual(urls, [chat.chatEndpoint, chat.chatEndpoint]);
});

void test("the worker sends native classification to FreeLLM and uses chat for generated decisions", async (t) => {
  const system = { ...profile, id: "clef", provider: "freellm-decisions" as const, model: "auto", endpoint: "https://decision.test/v1/decisions", key: "decision-key", customHeaders: [] };
  connectWorker(t, [profile, system]);
  const requests: { url: string; auth: string | null; redirect?: RequestRedirect; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect, body });
    if (requests.length === 1)
      return Response.json({ answers: { sourceType: { type: "choice", choice: "paper" }, diagram: { type: "noul", noul: 0.8 } } });
    return Response.json({
      id: "fixture",
      model: "fixture",
      created: 0,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ questions: ["Why does this work?"] }) }, finish_reason: "stop" }],
    });
  });
  const gateway = createWorkerGateway(profile, system);
  const signal = new AbortController().signal;
  assert.deepEqual(await gateway.decide(request, decisionSchemas.route, signal), { sourceType: "paper", diagram: true });
  assert.deepEqual(await gateway.decide(request, decisionSchemas.suggestions, signal), { questions: ["Why does this work?"] });
  assert.deepEqual(requests.map(({ url, auth, redirect }) => [url, auth, redirect]), [
    [system.endpoint, "Bearer decision-key", "error"],
    [`${profile.endpoint}/chat/completions`, null, "error"],
  ]);
  assert.equal(requests[0]?.body.state, request.prompt);
  assert.equal(requests[0]?.body.model, "auto");
  assert.deepEqual(Object.keys(requests[0]?.body.questions as object), ["sourceType", "diagram"]);
  assert.equal("messages" in requests[0].body, false);
});

void test("an OpenAI decision profile classifies through Chat Completions", async (t) => {
  const system = { ...profile, id: "openai-decision", provider: "openai" as const, type: "decision" as const, customHeaders: [], key: "fixture-key" };
  connectWorker(t, [profile, system]);
  const fetch = t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as { messages?: unknown[] };
    assert.ok(body.messages?.length);
    return Response.json({
      id: "fixture",
      model: "fixture",
      created: 0,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ sourceType: "paper", diagram: false }) }, finish_reason: "stop" }],
    });
  });
  const gateway = createWorkerGateway(profile, system);
  const signal = new AbortController().signal;
  assert.deepEqual(await gateway.decide(request, decisionSchemas.route, signal), { sourceType: "paper", diagram: false });
  assert.equal(fetch.mock.callCount(), 1);
});

void test("FreeLLM classification exposes safe failure details in Activity", async (t) => {
  const system = { ...profile, id: "clef", provider: "freellm-decisions" as const, model: "auto", endpoint: "https://decision.test/v1/decisions" };
  connectWorker(t, [profile, system]);
  const responses = [
    Response.json({ error: { code: "no_decision_keys", message: "private provider response" } }, { status: 503 }),
    new Response("private proxy response", { status: 404 }),
    Response.json({ answers: {} }),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift()!);
  const signal = new AbortController().signal;
  let steps: ActivityStep[] = [];
  const activity = createActivity(signal, (next) => {
    steps = next;
  });
  const gateway = trackModelActivity(createWorkerGateway(profile, system), activity, { main: profile.model, system: system.model });
  for (const expected of [/Cloudflare or OpenRouter key/, /HTTP 404/, /invalid classification/])
    await assert.rejects(gateway.decide(request, decisionSchemas.route, signal), expected);
  assert.deepEqual(steps.map(({ status }) => status), ["error", "error", "error"]);
  assert.match(steps[0]?.detail ?? "", /Cloudflare or OpenRouter key/);
  assert.match(steps[1]?.detail ?? "", /HTTP 404/);
  assert.doesNotMatch(JSON.stringify(steps), /private|decision\.test/);
});

void test("a saved chat profile pointing to FreeLLM decisions fails before sending the architecture prompt", async (t) => {
  const chat = { ...profile, chatEndpoint: "https://example.test/v1/decisions" };
  connectWorker(t, [chat]);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 400 }));
  const signal = new AbortController().signal;
  let steps: ActivityStep[] = [];
  const activity = createActivity(signal, (next) => {
    steps = next;
  });
  const gateway = trackModelActivity(createWorkerGateway(chat, chat), activity, { main: chat.model, system: chat.model });
  await assert.rejects(gateway.decide(request, decisionSchemas.architecture, signal), /FreeLLM Decision API/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.match(steps[0]?.detail ?? "", /FreeLLM Decision API/);
});

void test("a stale reader cannot send to a changed exact chat URL", async (t) => {
  const chat = { ...profile, chatEndpoint: "https://example.test/previous" };
  connectWorker(t, [{ ...chat, chatEndpoint: "https://example.test/replacement" }]);
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("A stale profile must not fetch"));
  const iterator = createWorkerGateway(chat, chat).stream(request, new AbortController().signal)[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), ModelProfileChangedError);
  assert.equal(fetch.mock.callCount(), 0);
});
