/// <reference lib="webworker" />

import { readerPath } from "../learning/reader-window.ts";
import { decisionSchemas } from "./decision-schemas.ts";
import { classifyWithFreeLlm, FreeLlmDecisionError } from "./freellm-decisions.ts";
import { createGateway } from "./gateway.ts";
import { DecisionEndpointAsChatError, hostPermission, InsecureModelEndpointError, isNativeDecision, loadSettings, modelRequestEndpoint, profileType } from "./profiles.ts";
import { handleModelSettings } from "./settings-worker.ts";
import { modelCommandSchema, modelPortName, modelSettingsChannel, type ModelReply } from "./worker-protocol.ts";

function isReaderUrl(url?: string): boolean {
  return url?.split(/[?#]/, 1)[0] === chrome.runtime.getURL(readerPath);
}

export function serveModelPort(port: chrome.runtime.Port): void {
  const controller = new AbortController();
  const { signal } = controller;
  port.onDisconnect.addListener(() => controller.abort());
  const reply = (message: ModelReply) => {
    if (signal.aborted)
      return;
    try {
      port.postMessage(message);
    }
    catch {
      controller.abort();
    }
  };
  const start = (message: unknown) => {
    // One model call per port. Further messages only keep the worker awake.
    port.onMessage.removeListener(start);
    void run(message);
  };
  port.onMessage.addListener(start);

  async function run(message: unknown) {
    const parsed = modelCommandSchema.safeParse(message);
    if (!parsed.success) {
      reply({ type: "error", code: "request" });
      return;
    }
    try {
      const { profile: expected, request, decision } = parsed.data;
      const { profiles } = await loadSettings();
      signal.throwIfAborted();
      const profile = profiles.find(({ id }) => id === expected.id);
      if (!profile || profile.provider !== expected.provider || profile.endpoint !== expected.endpoint
        || profile.chatEndpoint !== expected.chatEndpoint || profile.model !== expected.model || profileType(profile) !== profileType(expected)) {
        reply({ type: "error", code: "profile-changed" });
        return;
      }
      const endpoint = modelRequestEndpoint(profile);
      if (!await chrome.permissions.contains({ origins: [hostPermission(endpoint)] })) {
        throw new Error("Model endpoint permission unavailable.");
      }
      signal.throwIfAborted();
      if (isNativeDecision(profile)) {
        if (decision !== "route")
          throw new Error("This profile only classifies sources.");
        const result = await classifyWithFreeLlm(profile, request, signal);
        reply({ type: "done", decision: result });
        return;
      }
      if (!decision && profileType(profile) !== "chat")
        throw new Error("Select a chat profile for the explanation model.");
      const gateway = createGateway(profile, profile);
      if (decision) {
        const result = await gateway.decide(request, decisionSchemas[decision], signal);
        reply(result === undefined ? { type: "done" } : { type: "done", decision: result });
      }
      else {
        for await (const text of gateway.stream(request, signal)) reply({ type: "chunk", text });
        reply({ type: "done" });
      }
    }
    catch (error) {
      if (error instanceof DecisionEndpointAsChatError) {
        reply({ type: "error", code: "decision-endpoint-as-chat" });
        return;
      }
      if (error instanceof FreeLlmDecisionError) {
        reply({ type: "error", code: "decision", failure: error.failure });
        return;
      }
      reply({ type: "error", code: error instanceof InsecureModelEndpointError ? "endpoint" : "request" });
    }
  }
}

export function registerModelWorker(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== modelPortName)
      return;
    if (port.sender?.id === chrome.runtime.id && isReaderUrl(port.sender.url))
      serveModelPort(port);
    else port.disconnect();
  });
  const worker = globalThis as unknown as ServiceWorkerGlobalScope;
  worker.addEventListener("message", (event) => {
    const source = event.source;
    const [port] = event.ports;
    if (event.data?.channel !== modelSettingsChannel || !port || !source || !("url" in source)
      || source.type !== "window" || !isReaderUrl(source.url)) {
      return;
    }
    event.waitUntil(handleModelSettings(event.data.command).then((reply) => {
      port.postMessage(reply);
      port.close();
    }));
  });
}
