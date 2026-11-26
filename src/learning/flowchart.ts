type Flowchart = {
  components: { id: number; name: string }[];
  connections: { from: number; to: number; label: string }[];
};

function diagramLabel(text: string, fallback: string): string {
  const label = text
    .replace(/[^\p{L}\p{M}\p{N} ._+#/-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label.replace(/\b(click|href) /gi, "$1-") || fallback;
}

export function mermaidFlowchart({ components, connections }: Flowchart): string {
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
