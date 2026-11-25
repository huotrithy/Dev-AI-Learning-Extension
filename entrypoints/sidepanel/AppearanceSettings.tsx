import { useEffect, useLayoutEffect, useState } from "react";
import { z } from "zod";
import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Card } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/src/components/ui/native-select";

const storageKey = "appearance";
const minTextSize = 12;
const maxTextSize = 32;
const textSize = z.number().int().min(minTextSize).max(maxTextSize);
const presetSizes: Record<string, number> = { "standard": 17, "large": 19, "extra-large": 21 };
const appearanceSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).catch("light"),
  font: z.enum(["atkinson", "system", "serif"]).catch("atkinson"),
  size: z.preprocess(value => typeof value === "string" ? presetSizes[value] : value, textSize).catch(17),
});

type Appearance = z.infer<typeof appearanceSchema>;

function readAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    const result = appearanceSchema.safeParse(saved);
    if (result.success)
      return result.data;
  }
  catch {
    // A missing or unreadable entry uses the default appearance.
  }
  return appearanceSchema.parse({});
}

export function useAppearance() {
  const [appearance, setAppearance] = useState(readAppearance);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === storageKey || event.key === null)
        setAppearance(readAppearance());
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const preference = matchMedia("(prefers-color-scheme: dark)");
    function applyTheme() {
      root.classList.toggle("dark", appearance.theme === "dark" || (appearance.theme === "system" && preference.matches));
    }
    root.dataset.font = appearance.font;
    root.style.setProperty("--reader-font-size", `${appearance.size}px`);
    applyTheme();
    preference.addEventListener("change", applyTheme);
    return () => preference.removeEventListener("change", applyTheme);
  }, [appearance]);

  function change<Field extends keyof Appearance>(field: Field, value: Appearance[Field]) {
    const next = appearanceSchema.parse({ ...readAppearance(), [field]: value });
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setAppearance(next);
      setSaveError(false);
    }
    catch {
      setSaveError(true);
    }
  }

  return { appearance, change, saveError };
}

const fields = [
  { key: "theme", label: "Theme", options: { light: "Light", dark: "Dark", system: "Match system" } },
  { key: "font", label: "Font", options: { atkinson: "Atkinson Hyperlegible Next", system: "System sans-serif", serif: "Georgia" } },
] as const;

export function AppearanceSettings({ appearance, change, saveError }: ReturnType<typeof useAppearance>) {
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const invalidSize = sizeDraft !== null && !textSize.safeParse(Number(sizeDraft)).success;

  return (
    <Card
      role="region"
      className="control-panel"
      aria-labelledby="appearance-heading"
    >
      <h2 id="appearance-heading">Appearance</h2>
      <div className="form-grid appearance-fields">
        {fields.map(({ key, label, options }) => (
          <div className="field" key={key}>
            <Label htmlFor={`appearance-${key}`}>{label}</Label>
            <NativeSelect
              id={`appearance-${key}`}
              value={appearance[key]}
              onChange={event => change(key, appearanceSchema.shape[key].parse(event.target.value))}
            >
              {Object.entries(options).map(([value, name]) => <NativeSelectOption key={value} value={value}>{name}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        ))}
        <div className="field">
          <Label htmlFor="appearance-size">Text size (px)</Label>
          <Input
            id="appearance-size"
            type="number"
            min={minTextSize}
            max={maxTextSize}
            step={1}
            aria-describedby="appearance-size-range"
            aria-invalid={invalidSize}
            value={sizeDraft ?? appearance.size}
            onChange={(event) => {
              setSizeDraft(event.target.value);
              const size = textSize.safeParse(event.target.valueAsNumber);
              if (size.success)
                change("size", size.data);
            }}
            onBlur={() => setSizeDraft(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing)
                event.currentTarget.blur();
            }}
          />
          <small id="appearance-size-range">
            {minTextSize}
            –
            {maxTextSize}
            {" "}
            px
          </small>
        </div>
      </div>
      {saveError && <Alert variant="destructive"><AlertDescription>Could not save appearance settings.</AlertDescription></Alert>}
    </Card>
  );
}
