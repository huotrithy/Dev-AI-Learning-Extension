import type { ModelGateway } from "../models/gateway.ts";
import type { RepositoryFile } from "../page/github.ts";

import { decisionSchemas } from "../models/decision-schemas.ts";
import { FreeLlmDecisionError } from "../models/freellm-decisions.ts";
import { DecisionEndpointAsChatError } from "../models/profiles.ts";

export type ActivityStatus
  = | "running"
    | "done"
    | "stopped"
    | "error"
    | "fallback";
export type ActivityStep = {
  label: string;
  detail?: string;
  files?: Pick<RepositoryFile, "path" | "url">[];
  status: ActivityStatus;
};

export function createActivity(
  signal: AbortSignal,
  update: (steps: ActivityStep[]) => void,
) {
  let steps: ActivityStep[] = [];
  signal.addEventListener(
    "abort",
    () => {
      if (!steps.some(({ status }) => status === "running"))
        return;
      steps = steps.map(step =>
        step.status === "running" ? { ...step, status: "stopped" } : step,
      );
      update(steps);
    },
    { once: true },
  );

  return {
    start(label: string, detail?: string) {
      signal.throwIfAborted();
      const index = steps.length;
      steps = [...steps, { label, detail, status: "running" }];
      update(steps);
      return (
        status: Exclude<ActivityStatus, "running"> = "done",
        result?: Pick<ActivityStep, "detail" | "files">,
      ) => {
        if (steps[index]?.status !== "running")
          return;
        steps = steps.map((step, current) =>
          current === index ? { ...step, ...result, status } : step,
        );
        update(steps);
      };
    },
  };
}

export function trackModelActivity(
  gateway: ModelGateway,
  activity: ReturnType<typeof createActivity>,
  models: { main: string; system: string; classificationOnly?: boolean },
): ModelGateway {
  return {
    async* stream(request, signal) {
      const finish = activity.start(
        request.activity ?? "Generate response",
        models.main,
      );
      try {
        yield* gateway.stream(request, signal);
        finish();
      }
      catch (error) {
        const result = error instanceof DecisionEndpointAsChatError ? { detail: `${models.main} · ${error.message}` } : undefined;
        finish(signal.aborted ? "stopped" : "error", result);
        throw error;
      }
      finally {
        finish("stopped");
      }
    },
    async decide(request, schema, signal) {
      const model = schema === decisionSchemas.diagram || (models.classificationOnly && schema !== decisionSchemas.route)
        ? models.main
        : models.system;
      const finish = activity.start(request.activity ?? "Make a routing decision", model);
      try {
        const decision = await gateway.decide(request, schema, signal);
        finish(decision === undefined ? "fallback" : "done");
        return decision;
      }
      catch (error) {
        const result = error instanceof FreeLlmDecisionError || error instanceof DecisionEndpointAsChatError
          ? { detail: `${model} · ${error.message}` }
          : undefined;
        finish(signal.aborted ? "stopped" : "error", result);
        throw error;
      }
    },
  };
}
