import { learningLimits } from "../learning/config.ts";
import { observationInstructions, suggestionInstructions, suggestionPrompt } from "../learning/prompts.ts";
import { decisionSchemas } from '../models/decision-schemas.ts';
import type { ModelGateway } from '../models/gateway.ts';
import type { PageSource } from '../page/extract.ts';
import type { MemoryContext, Observation } from './types.ts';

export interface UserTurn {
  text: string;
  origin: 'user' | 'suggestion';
  scope: string;
}

const { observations: observationSchema, suggestions: suggestionsSchema } = decisionSchemas;
const standingRequest = /^(?:(?:please|can you|could you)\s+)?(?:always\s+(?:use|give|start|show|include|explain|prefer|write|keep|put|lead|walk|answer)\b|from now on\b|in (?:the )?future\b|by default\b|remember\b|my preference\b|i prefer\b)/i;

export async function extractObservations(turn: UserTurn, gateway: ModelGateway, signal: AbortSignal): Promise<Observation[]> {
  const text = turn.text.trim().slice(0, learningLimits.observationCharacters);
  if (turn.origin !== 'user' || !text || /\b(?:this (?:page|article|answer) only|just (?:for )?this|for this (?:page|article|answer|time))\b/i.test(text)) return [];

  const result = await gateway.decide({
    system: observationInstructions,
    prompt: JSON.stringify({ scope: turn.scope, userTurn: text }),
    maxOutputTokens: learningLimits.outputTokens.observation,
  }, observationSchema, signal);
  const parsed = observationSchema.safeParse(result);
  const sentences = text.split(/(?<=[.!?;\n])\s*/);
  return parsed.data?.observations.map(({ choice, topicSpecific, evidence }) => ({
    ...choice,
    scope: topicSpecific ? turn.scope : 'global',
    explicit: choice.kind !== 'intent' && Boolean(evidence && standingRequest.test(evidence)
      && sentences.some((sentence) => sentence.startsWith(evidence))),
  })) ?? [];
}

export async function prepareSuggestions(
  page: PageSource, context: MemoryContext, gateway: ModelGateway, signal: AbortSignal,
): Promise<string[]> {
  if (context.intents.length === 0) return [];
  const result = await gateway.decide({
    system: suggestionInstructions,
    prompt: suggestionPrompt(page, context.intents),
    maxOutputTokens: learningLimits.outputTokens.suggestions,
  }, suggestionsSchema, signal);
  const parsed = suggestionsSchema.safeParse(result);
  return [...new Set(parsed.data?.questions.filter((question) => question.endsWith('?')) ?? [])];
}
