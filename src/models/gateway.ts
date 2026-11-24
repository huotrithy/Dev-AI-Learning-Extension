import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { modelEndpoint, type ModelProfile } from './profiles.ts';

export interface ModelRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
}

export interface ModelGateway {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<string>;
  decide(request: ModelRequest, schema: z.ZodType, signal: AbortSignal): Promise<unknown>;
}

export async function decideWithFallback<T>(
  schema: z.ZodType<T>,
  invoke: { tool?: () => Promise<unknown>; text: (repair?: string) => Promise<string> },
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (invoke.tool) {
    try {
      const result = schema.safeParse(await invoke.tool());
      if (result.success) return result.data;
    } catch {
      signal?.throwIfAborted();
    }
  }

  let repair: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted();
    const text = await invoke.text(repair);
    try {
      const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
      const result = schema.safeParse(JSON.parse(json));
      if (result.success) return result.data;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    repair = text.slice(0, 1_000);
  }
  return undefined;
}

const providerFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });

function createModel(profile: ModelProfile): LanguageModel {
  const { key, model, provider } = profile;
  if (provider === 'openai') return createOpenAI({ apiKey: key, fetch: providerFetch }).chat(model);
  if (provider === 'anthropic') {
    return createAnthropic({
      apiKey: key,
      fetch: providerFetch,
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    })(model);
  }

  return createOpenAICompatible({
    name: 'compatible',
    baseURL: modelEndpoint(profile).href.replace(/\/+$/, ''),
    apiKey: key || undefined,
    fetch: providerFetch,
    transformRequestBody: profile.disableThinking
      ? (body) => ({ ...body, chat_template_kwargs: { enable_thinking: false } })
      : undefined,
  }).chatModel(model);
}

export function createGateway(main: ModelProfile, system: ModelProfile): ModelGateway {
  const mainModel = createModel(main);
  const systemModel = createModel(system);
  return {
    async *stream(request, signal) {
      signal.throwIfAborted();
      const result = streamText({ ...request, model: mainModel, abortSignal: signal, maxRetries: 0, onError: () => undefined });
      for await (const part of result.fullStream) {
        if (part.type === 'error') throw part.error;
        if (part.type === 'text-delta') yield part.text;
      }
      signal.throwIfAborted();
    },
    decide(request, schema, signal) {
      const options = { ...request, model: systemModel, abortSignal: signal, maxRetries: 0 };
      return decideWithFallback(schema, {
        tool: system.toolCalls ? async () => {
          const result = await generateText({
            ...options,
            tools: { report: tool({ description: 'Return the requested decision', inputSchema: schema }) },
            toolChoice: { type: 'tool', toolName: 'report' },
          });
          return result.toolCalls[0]?.input;
        } : undefined,
        text: async (repair) => {
          const prior = repair === undefined ? '' : `\nThe prior reply was invalid. Repair it: ${JSON.stringify(repair)}`;
          const result = await generateText({
            ...options,
            system: `${request.system}\nReturn a single JSON object conforming to ${JSON.stringify(z.toJSONSchema(schema))}.`,
            prompt: request.prompt + prior,
          });
          return result.text;
        },
      }, signal);
    },
  };
}
