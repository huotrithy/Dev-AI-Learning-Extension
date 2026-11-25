import { useState } from "react";

import { Button } from "@/src/components/ui/button";

import type { AnswerStyle } from "../../src/learning/answer-style.ts";

import { answerStyles } from "../../src/learning/answer-style.ts";
import { choiceLabel } from "../../src/memory/policy.ts";
import { memory } from "./reader.ts";

const styles = Object.keys(answerStyles) as AnswerStyle[];

export function AnswerFeedback({ style, disabled, revise }: {
  style?: AnswerStyle;
  disabled: boolean;
  revise: (style: AnswerStyle) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedStyle, setSavedStyle] = useState<AnswerStyle>();
  const [error, setError] = useState("");
  const preference = style ? answerStyles[style].preference : undefined;

  async function changeStyle(next: AnswerStyle) {
    setError("");
    setSavedStyle(undefined);
    setPending(true);
    try {
      await revise(next);
    }
    catch (error) {
      setError(error instanceof Error ? error.message : "Could not revise this answer. Try again.");
    }
    finally {
      setPending(false);
    }
  }

  async function remember() {
    if (!preference || !style)
      return;
    setError("");
    setSaving(true);
    try {
      await memory.update({ ...preference, scope: "global" });
      setSavedStyle(style);
    }
    catch {
      setError("Could not save this style to Memory. Try again.");
    }
    finally {
      setSaving(false);
    }
  }

  const locked = disabled || pending || saving;
  return (
    <div className="answer-feedback">
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label="Revise this answer"
      >
        {styles.map(next => (
          <Button
            key={next}
            size="sm"
            variant={style === next ? "secondary" : "outline"}
            disabled={locked}
            onClick={() => void changeStyle(next)}
          >
            {answerStyles[next].label}
          </Button>
        ))}
        {preference && (
          <Button
            size="sm"
            variant="ghost"
            title={choiceLabel(preference.kind, preference.value)}
            disabled={locked}
            onClick={() => void remember()}
          >
            Remember this style
          </Button>
        )}
      </div>
      {error && <p className="text-destructive" role="alert">{error}</p>}
      <span className="muted" role="status">
        {pending ? "Revising answer…" : saving ? "Saving style…" : savedStyle && savedStyle === style ? "Saved to Memory." : ""}
      </span>
    </div>
  );
}
