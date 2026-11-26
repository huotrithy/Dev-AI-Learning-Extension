import { useEffect, useState } from "react";
import { Button } from "@/src/components/ui/button";

export function Diagram({ source, description = "Flowchart of the main relationships described on this page" }: { source: string; description?: string }) {
  const code = source.trim().replace(/^```(?:mermaid)?\s*|\s*```$/gi, "");
  const [rendered, setRendered] = useState<{ source: string; url?: string }>();
  const [copied, setCopied] = useState("");

  useEffect(() => {
    let active = true;
    let imageUrl: string | undefined;
    async function render() {
      try {
        if (!/^(?:flowchart|graph)\s/i.test(code) || code.length > 3_000 || /%%\{|\bclick\s|\bhref\s/i.test(code)) {
          throw new Error("Unsupported flowchart syntax");
        }
        const { default: mermaid } = await import("mermaid");
        if (!active)
          return;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", flowchart: { htmlLabels: false } });
        const { svg } = await mermaid.render(`diagram-${crypto.randomUUID()}`, code);
        if (!active)
          return;
        imageUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setRendered({ source: code, url: imageUrl });
      }
      catch {
        if (active)
          setRendered({ source: code });
      }
    }
    void render();
    return () => {
      active = false;
      if (imageUrl)
        URL.revokeObjectURL(imageUrl);
    };
  }, [code]);

  return (
    <div className="diagram">
      {rendered?.source !== code
        ? <p className="muted">Rendering diagram…</p>
        : rendered.url
          ? <img src={rendered.url} alt={description} />
          : (
              <>
                <p className="muted">This diagram could not be rendered. Mermaid source is shown below.</p>
                <pre>{code}</pre>
              </>
            )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void navigator.clipboard.writeText(code).then(
          () => setCopied("Copied"),
          () => setCopied("Clipboard unavailable"),
        )}
      >
        Copy as Mermaid
      </Button>
      <small aria-live="polite">{copied}</small>
    </div>
  );
}
