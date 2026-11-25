import { z } from "zod";

import type { ModelRequest } from "./gateway.ts";
import type { ModelProfile } from "./profiles.ts";

import { decisionSchemas } from "./decision-schemas.ts";
import { modelHeaders, modelRequestEndpoint } from "./profiles.ts";

const questions = {
  sourceType: {
    type: "choice",
    instructions: "What kind of document is this excerpt from?",
    criteria: {
      page: "A general web page, article, or blog post",
      paper: "A research paper or academic preprint",
      docs: "Technical documentation, an API reference, or a project guide",
      repo: "The home page or README of a source code repository",
    },
  },
  diagram: {
    type: "noul",
    instructions: "Would a flowchart help explain a process or sequence described in this excerpt?",
  },
};

const responseSchema = z.object({
  answers: z.object({
    sourceType: z.object({ type: z.literal("choice"), choice: decisionSchemas.route.shape.sourceType }),
    diagram: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  }),
});

export async function classifyWithFreeLlm(profile: ModelProfile, request: ModelRequest, signal: AbortSignal): Promise<z.infer<typeof decisionSchemas.route> | undefined> {
  const headers = modelHeaders(profile);
  headers.set("Content-Type", "application/json");
  if (profile.key && !headers.has("Authorization"))
    headers.set("Authorization", `Bearer ${profile.key}`);

  const response = await fetch(modelRequestEndpoint(profile).href, {
    method: "POST",
    headers,
    redirect: "error",
    signal,
    body: JSON.stringify({ model: profile.model, state: request.prompt, questions }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Decision request failed (HTTP ${response.status}).`);
  }
  const result = responseSchema.safeParse(await response.json().catch(() => undefined));
  signal.throwIfAborted();
  if (!result.success)
    return undefined;
  return { sourceType: result.data.answers.sourceType.choice, diagram: result.data.answers.diagram.noul > 0.5 };
}
