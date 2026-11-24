import type { z } from "zod";
import { decisionSchemas } from "../models/decision-schemas.ts";
import type { ModelGateway } from "../models/gateway.ts";
import type { PageSource } from "../page/extract.ts";
import type { RepositoryFile, RepositorySource } from "../page/github.ts";
import { pageContext, teacherPrompt } from "./prompts.ts";

const architectureSchema = decisionSchemas.architecture;

export interface RepositoryArchitecture {
  components: {
    id: number;
    name: string;
    files: Pick<RepositoryFile, "path" | "url">[];
  }[];
  connections: z.infer<typeof architectureSchema>["connections"];
}

export async function readArchitecture(
  page: PageSource & { repository: RepositorySource },
  gateway: ModelGateway,
  signal: AbortSignal,
): Promise<RepositoryArchitecture | null> {
  const decision = await gateway
    .decide(
      {
        system: `${teacherPrompt}
Build a small architecture map of the repository. Use only components supported by the supplied file excerpts. For each component, return its short name and the exact file paths from those excerpts. Connect components only when the excerpts support the relationship. Connection endpoints are zero-based indices into components, and labels are short verbs such as "queues work for" or "calls". Return empty arrays when the excerpts do not establish an architecture.`,
        prompt: pageContext(page, 12_000),
        maxOutputTokens: 1_000,
        activity: "Map repository architecture",
      },
      architectureSchema,
      signal,
    )
    .catch(() => undefined);
  signal.throwIfAborted();
  const parsed = architectureSchema.safeParse(decision);
  if (!parsed.success) return null;

  const sourceFiles = new Map(
    page.repository.files.map(({ path, url }) => [path, { path, url }]),
  );
  const components = parsed.data.components.flatMap(({ name, files }, id) => {
    const sources = [...new Set(files)].flatMap((path) => {
      const file = sourceFiles.get(path);
      return file ? [file] : [];
    });
    return name.trim() && sources.length
      ? [{ id, name: name.trim(), files: sources }]
      : [];
  });
  if (!components.length) return null;

  const ids = new Set(components.map(({ id }) => id));
  const connections = parsed.data.connections.filter(
    ({ from, to, label }) =>
      from !== to && ids.has(from) && ids.has(to) && label.trim(),
  );
  return { components, connections };
}

function diagramLabel(text: string, fallback: string): string {
  const label = text
    .replace(/[^\p{L}\p{M}\p{N} ._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label.replace(/\b(click|href) /gi, "$1-") || fallback;
}

export function architectureFlowchart({
  components,
  connections,
}: RepositoryArchitecture): string {
  return [
    "flowchart TD",
    ...components.map(
      ({ id, name }) => `n${id}["${diagramLabel(name, "Component")}"]`,
    ),
    ...connections.map(
      ({ from, to, label }) =>
        `n${from} -->|${diagramLabel(label, "connects to")}| n${to}`,
    ),
  ].join("\n");
}
