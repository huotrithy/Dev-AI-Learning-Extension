import type { ModelGateway } from "../models/gateway.ts";
import type { PageSource } from "../page/extract.ts";

import { decisionSchemas } from "../models/decision-schemas.ts";
import { learningLimits } from "./config.ts";
import { pageContext } from "./context.ts";
import { mermaidFlowchart } from "./flowchart.ts";
import { diagramInstructions, diagramRepair } from "./prompts.ts";

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function readPageDiagram(page: PageSource, gateway: ModelGateway, signal: AbortSignal): Promise<string | undefined> {
  const budget = learningLimits.context.detailed;
  const excerpt = page.text.slice(0, budget);
  const source = pageContext({ ...page, text: excerpt }, budget);
  const evidence = normalizeWhitespace(excerpt);
  for (const retry of [false, true]) {
    signal.throwIfAborted();
    const decision = await gateway.decide({
      system: diagramInstructions,
      prompt: retry ? `${diagramRepair}\n${source}` : source,
      maxOutputTokens: learningLimits.outputTokens.diagram,
      activity: retry ? "Retry diagram relationships" : "Extract diagram relationships",
    }, decisionSchemas.diagram, signal).catch(() => undefined);
    signal.throwIfAborted();
    const parsed = decisionSchemas.diagram.safeParse(decision);
    if (!parsed.success || !parsed.data.connections.length)
      return undefined;
    const { nodes, connections } = parsed.data;
    const valid = connections.every(({ from, to, evidence: quote }) =>
      from !== to && from < nodes.length && to < nodes.length && evidence.includes(normalizeWhitespace(quote)),
    );
    if (valid) {
      const connected = new Set(connections.flatMap(({ from, to }) => [from, to]));
      const components = nodes.flatMap((name, id) => connected.has(id) ? [{ id, name }] : []);
      return mermaidFlowchart({ components, connections });
    }
  }
}
