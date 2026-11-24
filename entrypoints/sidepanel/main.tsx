import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import { Alert, AlertDescription } from '@/src/components/ui/alert';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/src/components/ui/native-select';
import { sections, type Section } from '../../src/learning/session.ts';
import type { Depth } from '../../src/learning/prompts.ts';
import { defaultSettings, loadSettings, modelEndpoint, type ModelSettings as Settings } from '../../src/models/profiles.ts';
import { Diagram } from './Diagram.tsx';
import { MemorySettings } from './MemorySettings.tsx';
import { ModelSettings } from './ModelSettings.tsx';
import { ask, closeReader, invalidateTab, learn, loadPage, stopReading, useReader, watchMemoryChanges } from './reader.ts';
import './style.css';

type View = 'read' | 'memory' | 'models';

function Prose({ text }: { text: string }) {
  return <div className="prose"><Markdown skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{text}</Markdown></div>;
}

function App() {
  const reader = useReader();
  const [settings, setSettings] = useState<Settings>();
  const [configurationError, setConfigurationError] = useState('');
  const [view, setView] = useState<View>('read');
  const [question, setQuestion] = useState('');
  const profile = settings?.profiles.find(({ id }) => id === settings.main);
  const system = settings?.profiles.find(({ id }) => id === settings.system);

  useEffect(() => {
    void loadSettings().then(setSettings).catch(() => {
      setConfigurationError('Could not open model settings.');
      setSettings(defaultSettings);
    });
    void loadPage();
    const unwatchMemory = watchMemoryChanges();
    let windowId: number | undefined;
    void chrome.windows.getCurrent().then((window) => { windowId = window.id; });
    const activated: Parameters<typeof chrome.tabs.onActivated.addListener>[0] = (info) => {
      if (windowId !== undefined && windowId !== info.windowId) return;
      void loadPage();
    };
    const updated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (tabId, change) => {
      if (tabId !== useReader.getState().tabId) return;
      if (change.status === 'loading') invalidateTab(tabId);
      else if (change.status === 'complete' || change.url) void loadPage();
    };
    const accessGranted: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message) => {
      const { tabId, page } = useReader.getState();
      if (message?.type === 'page-access-granted' && message.tabId === tabId && !page) void loadPage();
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.runtime.onMessage.addListener(accessGranted);
    return () => {
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.runtime.onMessage.removeListener(accessGranted);
      unwatchMemory();
      closeReader();
    };
  }, []);

  useEffect(() => { setQuestion(''); }, [reader.session]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || !reader.page || !profile || reader.working || !question.trim()) return;
    void ask(question, 'user', settings);
    setQuestion('');
  }

  return <div className="app-shell">
    <header className="top-bar">
      <span className="brand"><span aria-hidden="true" className="brand-mark">↗</span> Dev AI Learning</span>
      <nav aria-label="Sidebar views">
        {([['read', 'Read'], ['memory', 'Memory'], ['models', 'Models']] as const).map(([id, label]) =>
          <Button key={id} size="sm" variant={view === id ? 'secondary' : 'ghost'} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>{label}</Button>,
        )}
      </nav>
    </header>
    <main>
      {configurationError && <Alert variant="destructive"><AlertDescription>{configurationError}</AlertDescription></Alert>}
      {view === 'models' && settings && <ModelSettings settings={settings} onSave={setSettings} />}
      {view === 'memory' && <MemorySettings />}
      {view === 'read' && <>
        {reader.loading && <Alert role="status"><AlertDescription>Reading the active page…</AlertDescription></Alert>}
        {reader.error && <Alert variant="destructive"><AlertDescription>{reader.error}</AlertDescription></Alert>}
        {!reader.loading && !reader.page && <Button className="justify-self-start" variant="ghost" size="sm" onClick={() => void loadPage()}>Refresh page</Button>}
        {reader.page && <section className="source" aria-labelledby="page-title">
          <div className="source-meta">
            <a href={reader.page.url} target="_blank" rel="noreferrer" title="Open source in a new tab">{new URL(reader.page.url).hostname} ↗</a>
            <Button variant="ghost" size="sm" onClick={() => void loadPage()}>Refresh page</Button>
          </div>
          <h1 id="page-title">{reader.page.title}</h1>
          <div className="read-actions">
            <div className="field">
              <Label htmlFor="depth">Depth</Label>
              <NativeSelect id="depth" value={reader.depth} onChange={(event) => {
                const depth = event.target.value as Depth;
                useReader.setState({ depth });
                if (settings && reader.sections.intro) void learn(settings, depth);
              }}>
                <NativeSelectOption value="new">New to this</NativeSelectOption>
                <NativeSelectOption value="technical">More technical</NativeSelectOption>
              </NativeSelect>
            </div>
            {reader.working ? <Button variant="outline" onClick={stopReading}>Stop</Button>
              : <Button disabled={!profile} onClick={() => settings && void learn(settings)}>{reader.sections.intro ? 'Explain again' : 'Learn this page'}</Button>}
          </div>
          {profile && <p className="destination">Model requests go to {modelEndpoint(profile).host}{system && modelEndpoint(system).host !== modelEndpoint(profile).host ? ` and ${modelEndpoint(system).host}` : ''}.</p>}
        </section>}
        {settings && !profile && <section className="setup">
          <h2>Connect a model</h2>
          <p className="muted">Use a local OpenAI-compatible endpoint, OpenAI, or Anthropic to learn from this page.</p>
          <Button className="justify-self-start" onClick={() => setView('models')}>Set up a model</Button>
        </section>}
        {reader.working === 'learn' && !reader.sections.intro && <Alert role="status"><AlertDescription>Generating explanation…</AlertDescription></Alert>}
        {Object.entries(sections).map(([id, heading]) => {
          const text = reader.sections[id as Section];
          if (!text) return null;
          return <section className={`learning-section ${id === 'intro' ? 'intro' : ''}`} key={id}>
            <h2>{heading}</h2>
            {id === 'diagram' ? reader.working === 'learn' ? <p className="muted">Generating diagram…</p> : <Diagram source={text} /> : <Prose text={text} />}
          </section>;
        })}
        {reader.chat.map(({ question, answer }, index) => <section className="chat-turn" key={index}>
          <h2>{question}</h2>
          {answer ? <Prose text={answer} /> : reader.working === 'chat' && index === reader.chat.length - 1 ? <p role="status" className="muted">Generating answer…</p> : null}
        </section>)}
      </>}
    </main>
    {view === 'read' && reader.page && profile && <footer className="composer">
      {reader.suggestions.length > 0 && <ul className="suggestions" aria-label="Suggested questions">
        {reader.suggestions.map((suggestion) => <li key={suggestion}>
          <Button variant="secondary" className="h-auto w-full justify-start whitespace-normal py-1.5 text-left [overflow-wrap:anywhere]" disabled={Boolean(reader.working)} onClick={() => settings && void ask(suggestion, 'suggestion', settings)}>{suggestion}</Button>
        </li>)}
      </ul>}
      <form onSubmit={submit}>
        <Label className="sr-only" htmlFor="question">Ask about this page</Label>
        <Input id="question" placeholder="Ask about this page…" value={question} maxLength={2_000} onChange={(event) => setQuestion(event.target.value)} />
        <Button type="submit" aria-label="Send question" disabled={Boolean(reader.working) || !question.trim()}>Send</Button>
      </form>
    </footer>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
