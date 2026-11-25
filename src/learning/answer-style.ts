import type { Choice } from "../memory/types.ts";

export const answerStyles = {
  simpler: { label: "Simpler", preference: { kind: "depth", value: "plain language" } },
  detailed: { label: "More detail", preference: { kind: "depth", value: "detailed" } },
  example: { label: "Show an example", preference: { kind: "example-frequency", value: "include examples" } },
} as const satisfies Record<string, { label: string; preference: Choice }>;

export type AnswerStyle = keyof typeof answerStyles;

export type AnswerRevision = {
  style: AnswerStyle;
  previousAnswer: string;
};
