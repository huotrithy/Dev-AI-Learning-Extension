import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { decisionSchemas } from "../src/models/decision-schemas.ts";
import { createProfile } from "../src/models/profiles.ts";
import { serveModelPort } from "../src/models/worker.ts";
import { createWorkerGateway, ModelProfileChangedError } from "../src/models/worker-client.ts";

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

function connectWorker(t: TestContext, profiles = [profile]) {
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
