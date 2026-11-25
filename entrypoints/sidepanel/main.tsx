import { Fragment, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUp } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Button } from "@/src/components/ui/button";
import { Checkbox } from "@/src/components/ui/checkbox";
import { Label } from "@/src/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/src/components/ui/native-select";
import { Textarea } from "@/src/components/ui/textarea";
import { depthLabels, learningLimits, sections, type Depth, type Section } from "../../src/learning/config.ts";
import { chatHistory } from "../../src/learning/history.ts";
import { pageAccessGranted } from "../../src/learning/reader-window.ts";
import { githubRepository } from "../../src/page/github.ts";
import { docsReferences } from "../../src/page/docs.ts";
import { seekYouTube } from "../../src/page/active-tab.ts";
import { youtubeVideo } from "../../src/page/youtube.ts";
import {
  defaultSettings,
  modelEndpoint,
  type PublicModelSettings as Settings,
} from "../../src/models/profiles.ts";
import { updateModelSettings } from "../../src/models/worker-client.ts";
import { AppearanceSettings, useAppearance } from "./AppearanceSettings.tsx";
import { AnswerFeedback } from "./AnswerFeedback.tsx";
import { ChatTurn } from "./ChatTurn.tsx";
import { CodeSnippet } from "./CodeSnippet.tsx";
import { ReaderActivity } from "./ReaderActivity.tsx";
import {
  floating,
  floatingSource,
  switchReaderWindow,
  watchHandoff,
  type View,
} from "./display.ts";
import { Diagram } from "./Diagram.tsx";
import { History } from "./History.tsx";
import { RepositoryMap } from "./RepositoryMap.tsx";
import { MemorySettings } from "./MemorySettings.tsx";
import { ModelSettings } from "./ModelSettings.tsx";
import {
  ask,
  closeReader,
  hasActiveChat,
  hasPendingDocsScope,
  invalidateTab,
  learn,
  loadPage,
  reviseAnswer,
  stopReading,
  useReader,
  watchMemoryChanges,
} from "./reader.ts";
import "./style.css";

const depthId = "depth";
const relatedDocsId = "include-related-docs";
const fencedLanguagePrefix = "language-";

function Prose({ text, sources, onSourceClick }: {
  text: string;
  sources?: { url: string }[];
  onSourceClick?: (href: string) => void;
}) {
  return (
    <div className="prose">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => href && sources?.some(source => source.url === href)
            ? (
                <a
                  className="underline underline-offset-2"
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={onSourceClick && ((event) => {
                    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
                      return;
                    event.preventDefault();
                    onSourceClick(href);
                  })}
                >
                  {children}
                </a>
              )
            : <span>{children}</span>,
          img: () => null,
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
          pre: ({ node, children }) => {
            const code = node?.children[0];
            if (code?.type !== "element" || code.tagName !== "code")
              return <pre>{children}</pre>;
            const value = code.children.map(child => child.type === "text" ? child.value : "").join("");
            const classes = code.properties.className;
            const language = Array.isArray(classes)
              ? classes.find(value => typeof value === "string" && value.startsWith(fencedLanguagePrefix))
              : undefined;
            return <CodeSnippet code={value} language={typeof language === "string" ? language.slice(fencedLanguagePrefix.length) : ""} />;
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function App() {
  const reader = useReader();
  const appearance = useAppearance();
  const [settings, setSettings] = useState<Settings>();
  const [configurationError, setConfigurationError] = useState("");
  const [view, setView] = useState<View>("read");
  const [sourceWindow, setSourceWindow] = useState(floatingSource);
  const [switchingWindow, setSwitchingWindow] = useState(false);
  const [displayError, setDisplayError] = useState("");
  const { question } = reader;
  const repo = reader.page && githubRepository(reader.page.url);
  const repository = reader.page?.repository;
  const docs = reader.page && docsReferences(reader.page);
  const youtube = reader.page && youtubeVideo(reader.page.url);
  const video = reader.page?.video;
  const profile = settings?.profiles.find(({ id }) => id === settings.main);
  const system = settings?.profiles.find(({ id }) => id === settings.system);
  const pendingDocsScope = hasPendingDocsScope(reader);
  const learnLabel = reader.sections.intro
    ? "Explain again"
    : youtube ? "Learn this video" : repo ? "Learn this repo" : "Learn this page";

  useEffect(() => {
    void updateModelSettings({ type: "load-settings" })
      .then(setSettings)
      .catch(() => {
        setConfigurationError("Could not open model settings.");
        setSettings(defaultSettings);
      });
    if (!floating) {
      void chrome.windows
        .getCurrent()
        .then(window => setSourceWindow(window.id));
    }
  }, []);

  useEffect(() => {
    const pruneHistory = () => void chatHistory.prune().catch(() => undefined);
    pruneHistory();
    const timer = window.setInterval(pruneHistory, 60 * 60 * 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (sourceWindow === undefined)
      return;
    const unwatchMemory = watchMemoryChanges();
    const unwatchHandoff = watchHandoff(sourceWindow, (handoff) => {
      if (handoff) {
        setView(handoff.view);
        setDisplayError("");
      }
      void loadPage(sourceWindow, handoff?.reader);
    });
    const activated: Parameters<
      typeof chrome.tabs.onActivated.addListener
    >[0] = (info) => {
      if (sourceWindow !== info.windowId || hasActiveChat(useReader.getState()))
        return;
      void loadPage(sourceWindow);
    };
    const updated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (
      tabId,
      change,
    ) => {
      const reader = useReader.getState();
      const { tabId: readerTab, page } = reader;
      if (tabId !== readerTab || hasActiveChat(reader))
        return;
      if (change.status === "loading")
        invalidateTab(tabId);
      else if (change.status === "complete" || (change.url && (!page || youtubeVideo(change.url)?.url !== page.url)))
        void loadPage(sourceWindow);
    };
    const accessGranted: Parameters<
      typeof chrome.runtime.onMessage.addListener
    >[0] = (message) => {
      const { tabId, page } = useReader.getState();
      if (
        message?.type === pageAccessGranted
        && message.tabId === tabId
        && !page
      ) {
        void loadPage(sourceWindow);
      }
    };
    const windowRemoved = (windowId: number) => {
      if (sourceWindow === windowId)
        void loadPage(sourceWindow);
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.runtime.onMessage.addListener(accessGranted);
    chrome.windows.onRemoved.addListener(windowRemoved);
    return () => {
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.runtime.onMessage.removeListener(accessGranted);
      chrome.windows.onRemoved.removeListener(windowRemoved);
      unwatchHandoff();
      unwatchMemory();
      closeReader();
    };
  }, [sourceWindow]);

  function refresh() {
    if (sourceWindow === undefined)
      return;
    setDisplayError("");
    void loadPage(sourceWindow);
  }

  async function changeDisplay() {
    if (
      sourceWindow === undefined
      || switchingWindow
      || reader.loading
      || reader.working
    ) {
      return;
    }
    setSwitchingWindow(true);
    setDisplayError("");
    try {
      setDisplayError(await switchReaderWindow(sourceWindow, view));
    }
    catch {
      setDisplayError(
        floating
          ? "Could not dock the reader. Check that the original browser window is still open."
          : "Could not open a floating window. Try again.",
      );
    }
    finally {
      setSwitchingWindow(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !settings
      || !reader.page
      || (repo && !repository)
      || (youtube && !video)
      || !profile
      || reader.working
      || !question.trim()
    ) {
      return;
    }
    void ask(question, "user", settings);
    useReader.setState({ question: "" });
  }

  async function jumpToTimestamp(href: string) {
    const excerpt = video?.excerpts.find(({ url }) => url === href);
    if (!video || !excerpt || reader.tabId === undefined)
      return;
    const moved = await seekYouTube(reader.tabId, video.id, excerpt.seconds);
    const current = useReader.getState();
    if (current.tabId === reader.tabId && current.page?.video === video)
      useReader.setState({ notice: moved ? "" : "The player could not seek. Ctrl+click the timestamp to open it in a new tab." });
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <span className="brand">
          <img
            src="/icon/48.png"
            className="brand-mark"
            alt=""
            width="22"
            height="22"
          />
          Dev AI Learning
        </span>
        <nav aria-label="Reader views">
          {(
            [
              ["read", "Read"],
              ["history", "History"],
              ["memory", "Memory"],
              ["settings", "Settings"],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              size="sm"
              variant={view === id ? "secondary" : "ghost"}
              aria-current={view === id ? "page" : undefined}
              onClick={() => setView(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
        <Button
          size="sm"
          variant="outline"
          disabled={
            sourceWindow === undefined
            || reader.loading
            || Boolean(reader.working)
            || switchingWindow
          }
          onClick={() => void changeDisplay()}
        >
          {floating ? "Dock to sidebar" : "Open floating window"}
        </Button>
      </header>
      <main>
        {configurationError && (
          <Alert variant="destructive">
            <AlertDescription>{configurationError}</AlertDescription>
          </Alert>
        )}
        {displayError && (
          <Alert role="status">
            <AlertDescription>{displayError}</AlertDescription>
          </Alert>
        )}
        {view === "settings" && (
          <>
            <AppearanceSettings {...appearance} />
            {settings && (
              <ModelSettings settings={settings} onSave={setSettings} />
            )}
          </>
        )}
        {view === "memory" && <MemorySettings />}
        {view === "history" && <History renderAnswer={text => <Prose text={text} />} />}
        {view === "read" && (
          <>
            {reader.loading && (
              <Alert role="status">
                <AlertDescription>Reading the active page…</AlertDescription>
              </Alert>
            )}
            {reader.error && (
              <Alert variant="destructive">
                <AlertDescription>{reader.error}</AlertDescription>
              </Alert>
            )}
            {reader.historyError && (
              <Alert role="status"><AlertDescription>{reader.historyError}</AlertDescription></Alert>
            )}
            {!reader.loading && !reader.page && (
              <Button
                className="justify-self-start"
                variant="ghost"
                size="sm"
                onClick={refresh}
              >
                Refresh page
              </Button>
            )}
            {reader.page && (
              <section className="source" aria-labelledby="page-title">
                <header className="source-heading">
                  <div className="source-meta">
                    <a
                      href={reader.page.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open source in a new tab"
                    >
                      {new URL(reader.page.url).hostname}
                      {" ↗"}
                    </a>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={refresh}
                    >
                      Refresh page
                    </Button>
                  </div>
                  <h1 id="page-title">{reader.page.title}</h1>
                </header>
                <div className="read-actions">
                  <div className="read-options">
                    <div className="field">
                      <Label htmlFor={depthId}>Depth</Label>
                      <NativeSelect
                        id={depthId}
                        value={reader.depth}
                        disabled={Boolean(reader.working)}
                        onChange={(event) => {
                          const depth = event.target.value as Depth;
                          useReader.setState({ depth });
                          if (settings && reader.sections.intro && !pendingDocsScope)
                            void learn(settings);
                        }}
                      >
                        {Object.entries(depthLabels).map(([value, label]) => (
                          <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    {!repo && !youtube && Boolean(reader.page.relatedLinks?.length) && (
                      <div className="related-docs-option">
                        <Checkbox
                          id={relatedDocsId}
                          checked={reader.includeRelatedDocs}
                          disabled={Boolean(reader.working)}
                          onCheckedChange={includeRelatedDocs => useReader.setState({ includeRelatedDocs })}
                        />
                        <Label htmlFor={relatedDocsId}>Include related docs</Label>
                      </div>
                    )}
                  </div>
                  {reader.working
                    ? (
                        <Button variant="outline" onClick={stopReading}>
                          Stop
                        </Button>
                      )
                    : (
                        <Button
                          disabled={!profile}
                          onClick={() => settings && void learn(settings)}
                        >
                          {learnLabel}
                        </Button>
                      )}
                </div>
                {pendingDocsScope && !reader.working && (
                  <p className="destination" role="status">
                    {"Select "}
                    {learnLabel}
                    {" "}
                    to apply the new scope.
                  </p>
                )}
                {profile && (
                  <p className="destination">
                    {youtube ? "Transcript excerpts go to" : repo ? "Repository excerpts go to" : docs ? "Documentation excerpts go to" : "Model requests go to"}
                    {" "}
                    {modelEndpoint(profile).host}
                    {system
                      && modelEndpoint(system).host !== modelEndpoint(profile).host
                      ? ` and ${modelEndpoint(system).host}`
                      : ""}
                    .
                  </p>
                )}
                {youtube && !video && !reader.notice && (
                  <p className="destination">
                    {"Expand the video description and select "}
                    <strong>Show transcript</strong>
                    {" "}
                    before learning this video.
                  </p>
                )}
                {video?.truncated && (
                  <p className="destination">The transcript was too long to capture in full. Answers use the captured captions.</p>
                )}
                {repository && (
                  <details className="destination [overflow-wrap:anywhere]">
                    <summary className="cursor-pointer">
                      Files inspected (
                      {repository.files.length}
                      )
                    </summary>
                    <p>
                      {repository.branch}
                      {" "}
                      ·
                      {" "}
                      {repository.commit.slice(0, 7)}
                      {repository.truncated ? " · Partial GitHub file tree" : ""}
                    </p>
                    <ul className="list-disc pl-5">
                      {repository.files.map(({ path, url }) => (
                        <li key={path}>
                          <a
                            className="underline"
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {path}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {docs && (
                  <details className="destination">
                    <summary className="cursor-pointer">
                      Documentation pages read (
                      {docs.length}
                      )
                    </summary>
                    <ul className="list-disc pl-5">
                      {docs.map(({ title, url }) => (
                        <li key={url}>
                          <a
                            className="underline"
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {(reader.notice || docs?.length === 1) && (
                  <p className="destination" role="status">{reader.notice || "Only the current page was available. Refresh the page to try the linked docs again."}</p>
                )}
              </section>
            )}
            {settings && !profile && (
              <section className="setup">
                <h2>Connect a model</h2>
                <p className="muted">
                  Use a local OpenAI-compatible endpoint, OpenAI, or Anthropic
                  to learn from this page.
                </p>
                <Button
                  className="justify-self-start"
                  onClick={() => setView("settings")}
                >
                  Set up a model
                </Button>
              </section>
            )}
            {reader.working === "learn" && !reader.sections.intro && (
              <Alert role="status">
                <AlertDescription>{youtube && !video ? "Reading YouTube transcript…" : repo && !repository ? "Reading GitHub repository…" : "Generating explanation…"}</AlertDescription>
              </Alert>
            )}
            <ReaderActivity steps={reader.activity} />
            {Object.entries(sections).map(([id, heading]) => {
              const text = reader.sections[id as Section];
              if (!text)
                return null;
              return (
                <Fragment key={id}>
                  <section className={`learning-section ${id === "intro" ? "intro" : ""}`}>
                    <h2>{heading}</h2>
                    {id === "diagram"
                      ? (
                          reader.working === "learn"
                            ? (
                                <p className="muted">Generating diagram…</p>
                              )
                            : (
                                <Diagram source={text} />
                              )
                        )
                      : (
                          <Prose
                            text={text}
                            sources={video?.excerpts ?? docs ?? repository?.files}
                            onSourceClick={video ? jumpToTimestamp : undefined}
                          />
                        )}
                    {id === "intro" && reader.working !== "learn" && settings && profile && (
                      <AnswerFeedback
                        key={reader.session}
                        style={reader.introStyle}
                        disabled={Boolean(reader.working) || pendingDocsScope}
                        revise={style => reviseAnswer("intro", style, settings)}
                      />
                    )}
                  </section>
                  {id === "intro" && repository && (
                    <RepositoryMap map={reader.architecture} pending={reader.working === "learn" && reader.architecture === undefined} />
                  )}
                </Fragment>
              );
            })}
            {reader.chat.map(({ id, question, answer, style, docsReferences: answerDocs, repositoryFiles, repositoryNotice, activity }, index) => (
              <ChatTurn key={id ?? index} question={question}>
                <ReaderActivity steps={activity} />
                {answer
                  ? (
                      <Prose
                        text={answer}
                        sources={video?.excerpts ?? answerDocs ?? docs ?? repositoryFiles ?? repository?.files}
                        onSourceClick={video ? jumpToTimestamp : undefined}
                      />
                    )
                  : reader.working === "chat"
                    && index === reader.chat.length - 1
                    ? (
                        <p role="status" className="muted">
                          Generating answer…
                        </p>
                      )
                    : null}
                {repositoryNotice && <p className="destination" role="status">{repositoryNotice}</p>}
                {!!repositoryFiles?.length && (
                  <details className="destination [overflow-wrap:anywhere]">
                    <summary className="cursor-pointer">
                      Files inspected for this answer (
                      {repositoryFiles.length}
                      )
                    </summary>
                    <ul className="list-disc pl-5">
                      {repositoryFiles.map(({ path, url }) => (
                        <li key={path}>
                          <a
                            className="underline"
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {path}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {answer.trim() && settings && profile && (
                  <AnswerFeedback
                    style={style}
                    disabled={Boolean(reader.working) || pendingDocsScope}
                    revise={style => reviseAnswer(index, style, settings)}
                  />
                )}
              </ChatTurn>
            ))}
          </>
        )}
      </main>
      {view === "read" && reader.page && profile && (!repo || repository) && (!youtube || video) && (
        <footer className="composer">
          {reader.suggestions.length > 0 && (
            <ul className="suggestions" aria-label="Suggested questions">
              {reader.suggestions.map(suggestion => (
                <li key={suggestion}>
                  <Button
                    variant="secondary"
                    className="h-auto w-full justify-start whitespace-normal py-1.5 text-left [overflow-wrap:anywhere]"
                    disabled={Boolean(reader.working) || pendingDocsScope}
                    onClick={() =>
                      settings && void ask(suggestion, "suggestion", settings)}
                  >
                    {suggestion}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form className="composer-card" onSubmit={submit}>
            <Label className="sr-only" htmlFor="question">
              {youtube ? "Ask about this video" : repo ? "Ask about this repo" : docs ? "Ask about these docs" : "Ask about this page"}
            </Label>
            <Textarea
              id="question"
              placeholder={youtube ? "Ask about this video…" : repo ? "Ask about this repo…" : docs ? "Ask about these docs…" : "Ask about this page…"}
              value={question}
              maxLength={learningLimits.chat.questionCharacters}
              rows={1}
              onChange={event =>
                useReader.setState({ question: event.target.value })}
            />
            <Button
              className="composer-send"
              size="icon"
              type="submit"
              aria-label="Send question"
              title="Send question"
              disabled={Boolean(reader.working) || pendingDocsScope || !question.trim()}
            >
              <ArrowUp
                aria-hidden="true"
                className="size-5"
                strokeWidth={2.5}
              />
            </Button>
          </form>
        </footer>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
