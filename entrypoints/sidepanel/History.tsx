import { liveQuery } from "dexie";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { chatHistory, historyRetentionDays, type ResumableConversation, type SavedConversation } from "../../src/learning/history.ts";

import { ChatTurn } from "./ChatTurn.tsx";

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function History({ renderAnswer, onResume, activeSession, hasDraft, working }: {
  renderAnswer: (text: string) => ReactNode;
  onResume: (conversation: ResumableConversation) => void;
  activeSession: string;
  hasDraft: boolean;
  working: boolean;
}) {
  const [conversations, setConversations] = useState<SavedConversation[]>();
  const [loadingError, setLoadingError] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmResume, setConfirmResume] = useState<string>();
  const [resuming, setResuming] = useState<string>();
  const [resumeError, setResumeError] = useState(false);
  const resumeRequest = useRef<AbortController>(null);

  useEffect(() => {
    const subscription = liveQuery(() => chatHistory.list()).subscribe({
      next: setConversations,
      error: () => setLoadingError(true),
    });
    return () => {
      subscription.unsubscribe();
      resumeRequest.current?.abort();
    };
  }, []);

  async function resume(id: string) {
    const controller = new AbortController();
    resumeRequest.current?.abort();
    resumeRequest.current = controller;
    setResuming(id);
    setConfirmResume(undefined);
    setResumeError(false);
    try {
      const conversation = await chatHistory.resume(id);
      if (controller.signal.aborted)
        return;
      if (conversation)
        onResume(conversation);
      else
        setResumeError(true);
    }
    catch {
      if (!controller.signal.aborted)
        setResumeError(true);
    }
    finally {
      if (!controller.signal.aborted)
        setResuming(undefined);
    }
  }

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
        {"Completed replies and their source are saved in this browser for "}
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
                    {conversations.map(({ id, title, url, updatedAt, canResume, turns }) => (
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
                            {canResume
                              ? confirmResume === id
                                ? (
                                    <Alert>
                                      <AlertDescription>Discard the current draft and resume this conversation?</AlertDescription>
                                      <div className="button-row">
                                        <Button size="sm" disabled={working || clearing} onClick={() => void resume(id)}>Discard draft and resume</Button>
                                        <Button size="sm" variant="ghost" onClick={() => setConfirmResume(undefined)}>Cancel</Button>
                                      </div>
                                    </Alert>
                                  )
                                : (
                                    <Button
                                      className="justify-self-start"
                                      size="sm"
                                      disabled={working || clearing || Boolean(resuming)}
                                      onClick={() => {
                                        if (hasDraft && activeSession !== id)
                                          setConfirmResume(id);
                                        else
                                          void resume(id);
                                      }}
                                    >
                                      {resuming === id ? "Opening…" : "Resume conversation"}
                                    </Button>
                                  )
                              : <p className="muted">This older conversation has no saved source.</p>}
                            {turns.map(({ id: turnId, question, answer }) => (
                              <ChatTurn key={turnId} question={question} heading="h3">
                                {renderAnswer(answer)}
                              </ChatTurn>
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
                  disabled={clearing || Boolean(resuming)}
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
              disabled={Boolean(resuming) || (!conversations?.length && !loadingError)}
              onClick={() => { setNotice(""); setConfirmClear(true); }}
            >
              Clear history
            </Button>
          )}
      {clearError && <Alert variant="destructive"><AlertDescription>Could not clear conversation history.</AlertDescription></Alert>}
      {resumeError && <Alert variant="destructive"><AlertDescription>Could not resume this conversation. It may have expired or been cleared.</AlertDescription></Alert>}
      {notice && <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert>}
    </Card>
  );
}
