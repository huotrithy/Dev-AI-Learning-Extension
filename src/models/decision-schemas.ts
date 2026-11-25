import { z } from "zod";
import { choiceSchema } from "../memory/types.ts";

export const decisionSchemas = {
  route: z.object({ sourceType: z.enum(["page", "paper", "docs", "repo"]), diagram: z.boolean() }),
  observations: z.object({ observations: z.array(z.object({
    choice: choiceSchema,
    topicSpecific: z.boolean(),
    evidence: z.string().trim().min(1).max(200).optional(),
  })).max(3) }),
  suggestions: z.object({ questions: z.array(z.string().trim().min(4).max(140)).max(3) }),
  architecture: z.object({
    components: z.array(z.object({
      name: z.string().min(1).max(48),
      files: z.array(z.string()).min(1).max(3),
    })).max(7),
    connections: z.array(z.object({
      from: z.number().int().min(0),
      to: z.number().int().min(0),
      label: z.string().min(1).max(36),
    })).max(10),
  }),
};
