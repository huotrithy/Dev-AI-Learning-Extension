export const depthLabels = {
  new: "New to this",
  technical: "More technical",
};

export type Depth = keyof typeof depthLabels;
export const defaultDepth: Depth = "new";

export const sections = {
  intro: "Like I'm new",
  moments: "Key moments",
  reading: "Suggested reading path",
  example: "Example",
  uses: "Where it's used",
  steps: "Step-by-step walkthrough",
  diagram: "Diagram",
};

export type Section = keyof typeof sections;

export const learningLimits = {
  context: { classification: 1_000, introduction: 5_000, detailed: 12_000, suggestions: 4_500 },
  outputTokens: { classification: 200, introduction: 700, section: 900, detailed: 1_500, architecture: 1_000, diagram: 1_000, observation: 350, suggestions: 280 },
  chat: { questionCharacters: 2_000, previousTurns: 3, previousQuestionCharacters: 400, previousAnswerCharacters: 700, explanationSectionCharacters: 1_200, revisionAnswerCharacters: 6_000 },
  observationCharacters: 1_500,
  personalizationTimeoutMs: 45_000,
} as const;
