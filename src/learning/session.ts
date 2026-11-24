import { decisionSchemas } from '../models/decision-schemas.ts';
import type { ModelGateway } from '../models/gateway.ts';
import type { PageSource } from '../page/extract.ts';
import type { RepositoryFile } from '../page/github.ts';
import type { ActivityStep } from './activity.ts';
import { readArchitecture, type RepositoryArchitecture } from './architecture.ts';
import { explanationPrompt, pageContext, teacherPrompt, type Depth } from './prompts.ts';

export const sections = {
  intro: "Like I'm new",
  moments: 'Key moments',
  reading: 'Suggested reading path',
  example: 'Example',
  uses: "Where it's used",
  steps: 'Step-by-step walkthrough',
  diagram: 'Diagram',
};

export type Section = keyof typeof sections;
export type LearningEvent =
  | { section: Section; text: string }
  | { section: 'architecture'; map: RepositoryArchitecture | null };
export interface ChatTurn {
  question: string;
  answer: string;
  repositoryFiles?: Pick<RepositoryFile, 'path' | 'url'>[];
  repositoryNotice?: string;
  activity?: ActivityStep[];
}

const routeSchema = decisionSchemas.route;

const sectionActivities: Record<Exclude<Section, 'intro'>, string> = {
  moments: 'Find key moments',
  reading: 'Suggest a reading path',
  example: 'Write the example',
  uses: 'Describe use cases',
  steps: 'Write the walkthrough',
  diagram: 'Generate Mermaid source',
};

const instructions: Record<Exclude<Section, 'intro'>, string> = {
  moments: 'List three to five useful moments in chronological order, or fewer if the excerpts are short. For each, link the timestamp and explain what the speaker covers. Output the list only.',
  reading: 'Suggest a short ordered reading path from the supplied documentation pages. Link each step to a supplied page and explain what the reader will learn there. Output the list only.',
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
  const system = explanationPrompt(depth, memory) + sourceGuidance(page);
  if (page.video) {
    for (const section of ['intro', 'moments'] as const) {
      signal.throwIfAborted();
      for await (const text of gateway.stream({
        system,
        prompt: `${section === 'intro'
          ? 'Explain what the video teaches and why it matters. Output the body only.'
          : instructions.moments}\n${pageContext(page, section === 'intro' ? 5_000 : 12_000)}`,
        maxOutputTokens: section === 'intro' ? 700 : 900,
        activity: section === 'intro' ? 'Write the explanation' : sectionActivities.moments,
      }, signal)) yield { section, text };
    }
    return;
  }
  const introduction = page.repository
    ? 'Explain what this repository does, how its main parts fit together, and where a developer can start reading. Cite relevant files.'
    : page.docs
      ? 'Explain the main topic of the starting docs page and why it matters. Cite the supplied documentation.'
      : 'Explain what this is and why it matters in 2–3 sentences.';
  const opening = gateway.stream({
    system,
    prompt: `${introduction} Output the body only.\n${pageContext(page, 5_000)}`,
    maxOutputTokens: 700,
    activity: 'Write the explanation',
  }, signal);
  const iterator = opening[Symbol.asyncIterator]();
  const first = iterator.next();
  const architecture = page.repository
    ? readArchitecture({ ...page, repository: page.repository }, gateway, signal).catch(() => null)
    : undefined;
  const route = architecture || page.docs ? undefined : gateway.decide({
    system: `${teacherPrompt} Classify the source type and decide if a flowchart would help.`,
    prompt: pageContext(page, 1_000),
    maxOutputTokens: 200,
    activity: 'Classify the source',
  }, routeSchema, signal).catch(() => undefined);

  try {
    for (let chunk = await first; !chunk.done; chunk = await iterator.next()) {
      yield { section: 'intro', text: chunk.value };
    }
  } finally {
    await iterator.return?.();
  }
  if (architecture) {
    const map = await architecture;
    signal.throwIfAborted();
    yield { section: 'architecture', map };
  }
  const classification = routeSchema.safeParse(await route);
  const sourceType = page.repository ? 'repo' : page.docs ? 'docs' : classification.data?.sourceType ?? 'page';
  const order: Exclude<Section, 'intro'>[] = ['example', 'uses', 'steps'];
  if (page.docs?.length) order.unshift('reading');
  if (classification.data?.diagram) order.push('diagram');

  for (const section of order) {
    signal.throwIfAborted();
    const focus = `${page.title} ${instructions[section]}`;
    for await (const text of gateway.stream({
      system,
      prompt: `${instructions[section]}\nSource type: ${sourceType}\n${pageContext(page, 12_000, focus)}`,
      maxOutputTokens: section === 'steps' ? 1_500 : 900,
      activity: sectionActivities[section],
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
    system: explanationPrompt(depth, memory) + sourceGuidance(page),
    prompt: `Answer the user's question using the source. Use the previous explanation to resolve references to it. Say if the source doesn't cover the answer.${page.repository ? ' For a code trace, follow the calls in order and cite the source for each step.' : ''}\nSource: ${pageContext(page, 12_000, question)}\nPrevious explanation: ${JSON.stringify(priorExplanation)}\nRecent conversation: ${JSON.stringify(previous)}\nQuestion: ${question}`,
    maxOutputTokens: 1_500,
    activity: 'Write the answer',
  }, signal);
}

function sourceGuidance(page: PageSource): string {
  if (page.video) return '\nUse only the supplied caption excerpts as evidence. Cite claims with Markdown links whose labels are the supplied times and whose destinations are the exact timestamp URLs. Say when the captions do not cover something, including visuals. The transcript may be sampled or truncated.';
  if (page.docs) return '\nThe first page is where the reader started. Cite documentation claims with Markdown links using the exact URLs supplied in the source for this request. Say when the excerpts do not cover a question.';
  return page.repository
    ? '\nThe repository tree is a sample and the files are excerpts. Cite claims about the code with Markdown links using the exact URLs of supplied files. Distinguish README claims from behavior seen in code. Identify any step the excerpts do not establish.'
    : '';
}
