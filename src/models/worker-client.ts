import type { ModelGateway } from "./gateway.ts";

import { decisionSchemas } from "./decision-schemas.ts";
import { FreeLlmDecisionError } from "./freellm-decisions.ts";
import { DecisionEndpointAsChatError, InsecureModelEndpointError, isNativeDecision } from "./profiles.ts";
import {
  modelPortName,
  modelSettingsChannel,
  type ModelCommand,
  type ModelReply,
  type SettingsCommand,
  type SettingsReply,
} from "./worker-protocol.ts";

export async function updateModelSettings(command: SettingsCommand) {
  const failure = "Could not reach model settings. Reload the extension and try again.";
  const worker = (await navigator.serviceWorker.getRegistration())?.active;
  if (!worker)
    throw new Error(failure);

  const { port1, port2 } = new MessageChannel();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await new Promise<SettingsReply>((resolve, reject) => {
      port1.onmessage = (event: MessageEvent<SettingsReply>) => resolve(event.data);
      timeout = setTimeout(() => reject(new Error(failure)), 15_000);
      worker.postMessage({ channel: modelSettingsChannel, command }, [port2]);
    });
    if ("error" in reply)
      throw new Error(reply.error);
    return reply.settings;
  }
  finally {
    clearTimeout(timeout);
    port1.close();
    port2.close();
  }
}

export class ModelProfileChangedError extends Error {
  constructor() {
    super("The model profile changed in another window. Reopen the reader and try again.");
  }
}

async function* requestModel(command: ModelCommand, signal: AbortSignal): AsyncGenerator<Exclude<ModelReply, { type: "error" }>> {
  signal.throwIfAborted();
  const port = chrome.runtime.connect({ name: modelPortName });
  let messages: ModelReply[] = [];
  let disconnected = false;
  let wake: (() => void) | undefined;
  const receive = (message: ModelReply) => {
    messages.push(message);
    wake?.();
  };
  const loseConnection = () => {
    void chrome.runtime.lastError;
    disconnected = true;
    wake?.();
  };
  const stop = () => {
    port.disconnect();
    wake?.();
  };

  port.onMessage.addListener(receive);
  port.onDisconnect.addListener(loseConnection);
  signal.addEventListener("abort", stop, { once: true });
  // Chrome resets the worker's idle timer on port messages, including during quiet model calls.
  const heartbeat = setInterval(() => {
    if (disconnected || signal.aborted)
      return;
    try { port.postMessage({ type: "keep-alive" }); }
    catch { loseConnection(); }
  }, 20_000);
  try {
    port.postMessage(command);
    while (true) {
      signal.throwIfAborted();
      if (!messages.length) {
        if (disconnected)
          throw new Error("The model connection closed.");
        await new Promise<void>((resolve) => { wake = resolve; });
        continue;
      }
      const batch = messages;
      messages = [];
      for (const message of batch) {
        signal.throwIfAborted();
        if (message.type === "error") {
          if (message.code === "endpoint")
            throw new InsecureModelEndpointError();
          if (message.code === "decision-endpoint-as-chat")
            throw new DecisionEndpointAsChatError();
          if (message.code === "profile-changed")
            throw new ModelProfileChangedError();
          if (message.code === "decision")
            throw new FreeLlmDecisionError(message.failure);
          throw new Error("The model request failed.");
        }
        yield message;
        if (message.type === "done")
          return;
      }
    }
  }
  finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", stop);
    port.onMessage.removeListener(receive);
    port.onDisconnect.removeListener(loseConnection);
    stop();
  }
}

export function createWorkerGateway(main: ModelCommand["profile"], system: ModelCommand["profile"]): ModelGateway {
  const binding = ({ id, provider, type, endpoint, chatEndpoint, model }: ModelCommand["profile"]) => ({ id, provider, type, endpoint, chatEndpoint, model });
  const mainProfile = binding(main);
  const systemProfile = binding(system);
  return {
    async* stream(request, signal) {
      for await (const reply of requestModel({ profile: mainProfile, request }, signal)) {
        if (reply.type === "chunk")
          yield reply.text;
      }
    },
    async decide(request, schema, signal) {
      const names = Object.keys(decisionSchemas) as (keyof typeof decisionSchemas)[];
      const decision = names.find(name => decisionSchemas[name] === schema);
      if (!decision)
        throw new Error("Unknown model decision schema.");
      const profile = decision === "diagram" || (isNativeDecision(systemProfile) && decision !== "route")
        ? mainProfile
        : systemProfile;
      for await (const reply of requestModel({ profile, request, decision }, signal)) {
        if (reply.type === "done")
          return reply.decision;
      }
      return undefined;
    },
  };
}
