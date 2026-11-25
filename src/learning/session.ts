import { decisionSchemas } from "../models/decision-schemas.ts";
import type { ModelGateway } from "../models/gateway.ts";
import type { DocsReference } from "../page/docs.ts";
import type { PageSource } from "../page/extract.ts";
import type { RepositoryFile } from "../page/github.ts";
import type { ActivityStep } from "./activity.ts";
import { readArchitecture, type RepositoryArchitecture } from "./architecture.ts";
import { learningLimits, type Depth, type Section } from "./config.ts";
import { pageContext } from "./context.ts";
import { answerPrompt, classificationInstructions, explanationPrompt, introductionPrompt, sectionPrompt } from "./prompts.ts";

export type LearningEvent
  = | { section: Section; text: string }
    | { section: "architecture"; map: RepositoryArchitecture | null };
export interface ChatTurn {
  question: string;
  answer: string;
  docsReferences?: DocsReference[];
  repositoryFiles?: Pick<RepositoryFile, "path" | "url">[];
  repositoryNotice?: string;
  activity?: ActivityStep[];
}

const routeSchema = decisionSchemas.route;

const sectionActivities: Record<Exclude<Section, "intro">, string> = {
  moments: "Find key moments",
  reading: "Suggest a reading path",
  example: "Write the example",
  uses: "Describe use cases",
  steps: "Write the walkthrough",
  diagram: "Generate Mermaid source",
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
  page: PageSource,
  depth: Depth,
  memory: string,
  gateway: ModelGateway,
  signal: AbortSignal,
): AsyncGenerator<LearningEvent, void> {
  const system = explanationPrompt(page, depth, memory);
  if (page.video) {
    for (const section of ["intro", "moments"] as const) {
      signal.throwIfAborted();
      for await (const text of gateway.stream({
        system,
        prompt: section === "intro" ? introductionPrompt(page) : sectionPrompt(page, section),
        maxOutputTokens: section === "intro" ? learningLimits.outputTokens.introduction : learningLimits.outputTokens.section,
        activity: section === "intro" ? "Write the explanation" : sectionActivities.moments,
      }, signal)) yield { section, text };
    }
    return;
  }
  const opening = gateway.stream({
    system,
    prompt: introductionPrompt(page),
    maxOutputTokens: learningLimits.outputTokens.introduction,
    activity: "Write the explanation",
  }, signal);
  const iterator = opening[Symbol.asyncIterator]();
  const first = iterator.next();
  const architecture = page.repository
    ? readArchitecture({ ...page, repository: page.repository }, gateway, signal).catch(() => null)
    : undefined;
  const route = architecture || page.docs
    ? undefined
    : gateway.decide({
        system: classificationInstructions,
        prompt: pageContext(page, learningLimits.context.classification),
        maxOutputTokens: learningLimits.outputTokens.classification,
        activity: "Classify the source",
      }, routeSchema, signal).catch(() => undefined);

  try {
    for (let chunk = await first; !chunk.done; chunk = await iterator.next()) {
      yield { section: "intro", text: chunk.value };
    }
  }
  finally {
    await iterator.return?.();
  }
  if (architecture) {
    const map = await architecture;
    signal.throwIfAborted();
    yield { section: "architecture", map };
  }
  const classification = routeSchema.safeParse(await route);
  const sourceType = page.repository ? "repo" : page.docs ? "docs" : classification.data?.sourceType ?? "page";
  const order: Exclude<Section, "intro">[] = ["example", "uses", "steps"];
  if (page.docs?.length)
    order.unshift("reading");
  if (classification.data?.diagram)
    order.push("diagram");

  for (const section of order) {
    signal.throwIfAborted();
    for await (const text of gateway.stream({
      system,
      prompt: sectionPrompt(page, section, sourceType),
      maxOutputTokens: section === "steps" ? learningLimits.outputTokens.detailed : learningLimits.outputTokens.section,
      activity: sectionActivities[section],
    }, signal)) yield { section, text };
  }
}

export function streamAnswer(
  page: PageSource,
  question: string,
  history: ChatTurn[],
  depth: Depth,
  memory: string,
  gateway: ModelGateway,
  signal: AbortSignal,
  explanation: Partial<Record<Section, string>> = {},
): AsyncIterable<string> {
  return gateway.stream({
    system: explanationPrompt(page, depth, memory),
    prompt: answerPrompt(page, question, history, explanation),
    maxOutputTokens: learningLimits.outputTokens.detailed,
    activity: "Write the answer",
  }, signal);
}
