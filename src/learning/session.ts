import { z } from 'zod';
import type { ModelGateway } from '../models/gateway.ts';
import type { PageSource } from '../page/extract.ts';
import { explanationPrompt, pageContext, teacherPrompt, type Depth } from './prompts.ts';

export const sections = {
  intro: "Like I'm new",
  example: 'Example',
  uses: "Where it's used",
  steps: 'Step-by-step walkthrough',
  diagram: 'Diagram',
};

export type Section = keyof typeof sections;
export interface LearningEvent { section: Section; text: string }
export interface ChatTurn { question: string; answer: string }

const routeSchema = z.object({ sourceType: z.enum(['page', 'paper', 'docs', 'repo']), diagram: z.boolean() });

const instructions: Record<Exclude<Section, 'intro'>, string> = {
  example: 'Give one concrete example or short code snippet. Output the section body only.',
  uses: 'Give two or three relevant uses. Name real libraries if supported, and distinguish extrapolation from claims made in the source. Output the section body only.',
  steps: 'Give a numbered walkthrough of how this works. For a paper cover problem, method, results, and limitations if present. Output the section body only.',
  diagram: 'Write one small Mermaid flowchart showing the main relationships. Return only Mermaid syntax, with no links, directives, or fences.',
};

export class LatestRequest {
  private current?: AbortController;

  start(): AbortController {
    this.cancel();
    this.current = new AbortController();
    return this.current;
  }

  cancel(): void {
    this.current?.abort();
    this.current = undefined;
  }

  isCurrent(controller: AbortController): boolean {
    return this.current === controller;
  }
}

export async function* streamLearning(
  page: PageSource, depth: Depth, memory: string, gateway: ModelGateway, signal: AbortSignal,
): AsyncGenerator<LearningEvent, void> {
  const system = explanationPrompt(depth, memory);
  const opening = gateway.stream({
    system,
    prompt: `Explain what this is and why it matters in 2–3 sentences. Output the body only.\n${pageContext(page, 5_000)}`,
    maxOutputTokens: 700,
  }, signal);
  const iterator = opening[Symbol.asyncIterator]();
  const first = iterator.next();
  const route = gateway.decide({
    system: `${teacherPrompt} Classify the source type and decide if a flowchart would help.`,
    prompt: pageContext(page, 1_000),
    maxOutputTokens: 200,
  }, routeSchema, signal).catch(() => undefined);

  try {
    for (let chunk = await first; !chunk.done; chunk = await iterator.next()) {
      yield { section: 'intro', text: chunk.value };
    }
  } finally {
    await iterator.return?.();
  }
  const classification = routeSchema.safeParse(await route);
  const sourceType = classification.data?.sourceType ?? 'page';
  const order: Exclude<Section, 'intro'>[] = ['example', 'uses', 'steps'];
  if (classification.data?.diagram) order.push('diagram');

  for (const section of order) {
    signal.throwIfAborted();
    const focus = `${page.title} ${instructions[section]}`;
    for await (const text of gateway.stream({
      system,
      prompt: `${instructions[section]}\nSource type: ${sourceType}\n${pageContext(page, 12_000, focus)}`,
      maxOutputTokens: section === 'steps' ? 1_500 : 900,
    }, signal)) yield { section, text };
  }
}

export function streamAnswer(
  page: PageSource, question: string, history: ChatTurn[], depth: Depth, memory: string,
  gateway: ModelGateway, signal: AbortSignal, explanation: Partial<Record<Section, string>> = {},
): AsyncIterable<string> {
  const previous = history.slice(-3).map(({ question, answer }) => ({ question: question.slice(0, 400), answer: answer.slice(0, 700) }));
  const priorExplanation = Object.entries(explanation).map(([section, content]) => ({ section, content: content.slice(0, 1_200) }));
  return gateway.stream({
    system: explanationPrompt(depth, memory),
    prompt: `Answer the user's question using the source. Use the previous explanation to resolve references to it. Say if the source doesn't cover the answer.\nSource: ${pageContext(page, 12_000, question)}\nPrevious explanation: ${JSON.stringify(priorExplanation)}\nRecent conversation: ${JSON.stringify(previous)}\nQuestion: ${question}`,
    maxOutputTokens: 1_500,
  }, signal);
}
