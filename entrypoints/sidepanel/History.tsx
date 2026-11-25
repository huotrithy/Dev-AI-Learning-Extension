import { liveQuery } from "dexie";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { chatHistory, historyRetentionDays, type SavedConversation } from "../../src/learning/history.ts";

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function History({ renderAnswer }: { renderAnswer: (text: string) => ReactNode }) {
  const [conversations, setConversations] = useState<SavedConversation[]>();
  const [loadingError, setLoadingError] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const subscription = liveQuery(() => chatHistory.list()).subscribe({
      next: setConversations,
      error: () => setLoadingError(true),
    });
    return () => subscription.unsubscribe();
  }, []);

  async function clear() {
    setClearing(true);
    setClearError(false);
    try {
      await chatHistory.clear();
      setConfirmClear(false);
      setNotice("Conversation history cleared.");
    }
    catch {
      setClearError(true);
    }
    finally {
      setClearing(false);
    }
  }

  return (
    <Card
      role="region"
      className="control-panel"
      aria-labelledby="history-heading"
    >
      <h2 id="history-heading">Conversation history</h2>
      <p className="muted">
        {"Completed replies are saved in this browser for "}
        {historyRetentionDays}
        {" days."}
      </p>
      {loadingError
        ? <Alert variant="destructive"><AlertDescription>Could not load conversation history.</AlertDescription></Alert>
        : !conversations
            ? <p role="status" className="muted">Loading history…</p>
            : conversations.length === 0
              ? <p className="muted">No saved conversations yet.</p>
              : (
                  <ul className="divide-y divide-border">
                    {conversations.map(({ id, title, url, updatedAt, turns }) => (
                      <li key={id} className="py-3 [overflow-wrap:anywhere]">
                        <details>
                          <summary className="cursor-pointer font-medium">
                            {title || new URL(url).hostname}
                            <span className="block text-sm font-normal text-muted-foreground">
                              {new URL(url).hostname}
                              {" · "}
                              <time dateTime={new Date(updatedAt).toISOString()}>{date.format(updatedAt)}</time>
                            </span>
                          </summary>
                          <div className="mt-3 grid gap-3">
                            {turns.map(({ id: turnId, question, answer }) => (
                              <section className="chat-turn" key={turnId}>
                                <h3 className="whitespace-pre-wrap font-semibold">{question}</h3>
                                {renderAnswer(answer)}
                              </section>
                            ))}
                          </div>
                        </details>
                      </li>
                    ))}
                  </ul>
                )}
      {confirmClear
        ? (
            <Alert>
              <AlertDescription>Delete all saved conversations from this browser?</AlertDescription>
              <div className="button-row">
                <Button
                  variant="destructive"
                  disabled={clearing}
                  onClick={() => void clear()}
                >
                  Clear all
                </Button>
                <Button
                  variant="ghost"
                  disabled={clearing}
                  onClick={() => { setConfirmClear(false); setClearError(false); }}
                >
                  Cancel
                </Button>
              </div>
            </Alert>
          )
        : (
            <Button
              className="justify-self-start"
              variant="outline"
              disabled={!conversations?.length && !loadingError}
              onClick={() => { setNotice(""); setConfirmClear(true); }}
            >
              Clear history
            </Button>
          )}
      {clearError && <Alert variant="destructive"><AlertDescription>Could not clear conversation history.</AlertDescription></Alert>}
      {notice && <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert>}
    </Card>
  );
}
