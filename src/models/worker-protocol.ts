import { z } from "zod";
import type { PublicModelSettings } from "./profiles.ts";
import { providers } from "./profiles.ts";
import { decisionSchemas } from "./decision-schemas.ts";

export const modelPortName = "model-request";
export const modelSettingsChannel = "model-settings";

export const settingsCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("load-settings") }),
  z.object({
    type: z.literal("save-profile"),
    profile: z.object({
      id: z.string().min(1),
      label: z.string().trim(),
      provider: z.enum(providers),
      model: z.string().trim(),
      endpoint: z.string().trim(),
      chatEndpoint: z.string().trim().optional(),
      toolCalls: z.boolean(),
      disableThinking: z.boolean(),
      revision: z.string().optional(),
      key: z.string().trim().optional(),
      customHeaders: z.array(z.union([
        z.object({ name: z.string().min(1), savedIndex: z.number().int().nonnegative() }),
        z.object({ name: z.string().trim().min(1), value: z.string() }),
      ])),
    }),
  }),
  z.object({ type: z.literal("assign-profile"), role: z.enum(["main", "system"]), id: z.string().min(1) }),
  z.object({ type: z.literal("remove-profile"), id: z.string().min(1), revision: z.string() }),
]);

export type SettingsCommand = z.infer<typeof settingsCommandSchema>;
export type SettingsReply = { settings: PublicModelSettings } | { error: string };

export const modelCommandSchema = z.object({
  profile: z.object({
    id: z.string().min(1),
    provider: z.enum(providers),
    endpoint: z.string(),
    chatEndpoint: z.string().optional(),
    model: z.string(),
  }),
  request: z.object({
    system: z.string(),
    prompt: z.string(),
    maxOutputTokens: z.number().int().positive(),
  }),
  decision: z.keyof(z.object(decisionSchemas)).optional(),
});

export type ModelCommand = z.infer<typeof modelCommandSchema>;
export type ModelReply
  = | { type: "chunk"; text: string }
    | { type: "done"; decision?: unknown }
    | { type: "error"; code: "endpoint" | "profile-changed" | "request" };
