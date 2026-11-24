import { create } from 'zustand';
import { liveQuery } from 'dexie';
import { LatestRequest, streamAnswer, streamLearning, type ChatTurn, type Section } from '../../src/learning/session.ts';
import type { Depth } from '../../src/learning/prompts.ts';
import { extractObservations, prepareSuggestions, type UserTurn } from '../../src/memory/observation.ts';
import { pageScope } from '../../src/memory/policy.ts';
import { DexieMemoryRepository, runWithCurrentMemory } from '../../src/memory/repository.ts';
import { emptyMemory } from '../../src/memory/types.ts';
import type { ModelSettings } from '../../src/models/profiles.ts';
import type { ModelGateway } from '../../src/models/gateway.ts';
import { readTab } from '../../src/page/active-tab.ts';
import type { PageSource } from '../../src/page/extract.ts';

interface ReaderState {
  page?: PageSource;
  tabId?: number;
  session: string;
  loading: boolean;
  working: 'learn' | 'chat' | null;
  depth: Depth;
  sections: Partial<Record<Section, string>>;
  chat: ChatTurn[];
  suggestions: string[];
  error: string;
  notice: string;
}

const initialReader: ReaderState = {
  session: '', loading: true, working: null, depth: 'new', sections: {}, chat: [],
  suggestions: [], error: '', notice: '',
};

export const memory = new DexieMemoryRepository();
export const useReader = create<ReaderState>(() => initialReader);
const request = new LatestRequest();
const navigation = new LatestRequest();
const suggestionRequest = new LatestRequest();
const observations = new Set<AbortController>();

async function selectedGateway(settings: ModelSettings) {
  const main = settings.profiles.find((profile) => profile.id === settings.main);
  const system = settings.profiles.find((profile) => profile.id === settings.system);
  if (!main) throw new Error('Select an explanation model.');
  const { createGateway } = await import('../../src/models/gateway.ts');
  return createGateway(main, system ?? main);
}

function clearSuggestions(): void {
  suggestionRequest.cancel();
  useReader.setState({ suggestions: [] });
}

export function invalidateMemoryWork(): void {
  clearSuggestions();
  stopReading();
  for (const controller of observations) controller.abort();
}

export function watchMemoryChanges(): () => void {
  let revision: number | undefined;
  const subscription = liveQuery(() => memory.status()).subscribe({
    next: (status) => {
      if (revision !== undefined && revision !== status.revision) invalidateMemoryWork();
      revision = status.revision;
    },
    error: () => undefined,
  });
  return () => subscription.unsubscribe();
}

async function readMemory(scope: string) {
  const status = await memory.status().catch(() => null);
  const context = status?.enabled
    ? await runWithCurrentMemory(memory, status.revision, () => memory.recall(scope)).catch(() => undefined)
    : undefined;
  return { status, context: context ?? emptyMemory };
}

function protectRecall(gateway: ModelGateway, revision?: number): ModelGateway {
  if (revision === undefined) return gateway;
  return { ...gateway, async *stream(input, signal) {
    const stream = await runWithCurrentMemory(memory, revision, async () => {
      signal.throwIfAborted();
      return gateway.stream(input, signal);
    });
    if (!stream) throw new Error('Memory changed while preparing the response.');
    yield* stream;
  } };
}

function resetPage(tabId?: number): void {
  request.cancel();
  clearSuggestions();
  useReader.setState({ ...initialReader, tabId, page: undefined, depth: useReader.getState().depth });
}

export function invalidateTab(tabId: number): void {
  navigation.cancel();
  resetPage(tabId);
}

export async function loadPage(): Promise<void> {
  const previous = useReader.getState();
  resetPage(previous.tabId);
  const controller = navigation.start();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!navigation.isCurrent(controller)) return;
    if (tab?.id === undefined) throw new Error('Open a web page to start reading.');
    useReader.setState({ tabId: tab.id });
    const page = await readTab(tab.id);
    if (!navigation.isCurrent(controller)) return;
    const samePage = previous.page?.url === page.url;
    useReader.setState({ page, session: samePage ? previous.session : crypto.randomUUID(), loading: false });
  } catch (error) {
    if (navigation.isCurrent(controller)) useReader.setState({ loading: false, error: error instanceof Error ? error.message : 'Unable to read the page.' });
  }
}

export function stopReading(): void {
  request.cancel();
  useReader.setState({ working: null });
}

export function closeReader(): void {
  navigation.cancel();
  request.cancel();
  suggestionRequest.cancel();
  for (const controller of observations) controller.abort();
}

export async function learn(settings: ModelSettings, depth = useReader.getState().depth): Promise<void> {
  const { page } = useReader.getState();
  if (!page) return;
  const controller = request.start();
  clearSuggestions();
  const set = useReader.setState;
  set({ working: 'learn', depth, sections: {}, error: '', notice: '' });
  const scope = pageScope(page);

  try {
    const gateway = await selectedGateway(settings);
    const { context, status } = await readMemory(scope);
    controller.signal.throwIfAborted();
    const scopedGateway = protectRecall(gateway, context.prompt ? status?.revision : undefined);
    for await (const { section, text } of streamLearning(page, depth, context.prompt, scopedGateway, controller.signal)) {
      if (!request.isCurrent(controller)) return;
      set(({ sections }) => ({ sections: { ...sections, [section]: (sections[section] ?? '') + text } }));
    }
    if (!request.isCurrent(controller)) return;
    if (!useReader.getState().sections.intro?.trim()) throw new Error('The model returned no visible text.');
    if (status?.enabled && context.intents.length) {
      const suggestion = suggestionRequest.start();
      const signal = AbortSignal.any([suggestion.signal, AbortSignal.timeout(45_000)]);
      void runWithCurrentMemory(memory, status.revision, async () => {
        signal.throwIfAborted();
        return prepareSuggestions(page, context, gateway, signal);
      }).then(async (suggestions) => {
        if (!suggestions) return;
        await runWithCurrentMemory(memory, status.revision, async () => {
          if (suggestionRequest.isCurrent(suggestion)) set({ suggestions });
        });
      }).catch(() => undefined);
    }
  } catch {
    if (request.isCurrent(controller)) set({ error: 'Could not finish the explanation. Check the model endpoint and settings, then try again.' });
  } finally {
    if (request.isCurrent(controller)) set({ working: null });
  }
}

export async function ask(text: string, origin: UserTurn['origin'], settings: ModelSettings): Promise<void> {
  const { page, session, chat, depth, working, sections } = useReader.getState();
  const question = text.trim().slice(0, 2_000);
  if (!page || !question || working) return;
  const controller = request.start();
  const observedAt = performance.timeOrigin + performance.now();
  const scope = pageScope(page);
  const set = useReader.setState;
  set({ working: 'chat', chat: [...chat, { question, answer: '' }], error: '', notice: '' });

  try {
    const gateway = await selectedGateway(settings);
    const { status, context } = await readMemory(scope);
    controller.signal.throwIfAborted();
    let answer = '';
    const scopedGateway = protectRecall(gateway, context.prompt ? status?.revision : undefined);
    for await (const chunk of streamAnswer(page, question, chat, depth, context.prompt, scopedGateway, controller.signal, sections)) {
      if (!request.isCurrent(controller)) return;
      answer += chunk;
      set({ chat: [...chat, { question, answer }] });
    }
    if (!request.isCurrent(controller)) return;
    if (!answer.trim()) throw new Error('The model returned no visible text.');

    if (status?.enabled && origin === 'user') {
      const observation = new AbortController();
      observations.add(observation);
      const signal = AbortSignal.any([observation.signal, AbortSignal.timeout(45_000)]);
      const turnId = crypto.randomUUID();
      void runWithCurrentMemory(memory, status.revision, async () => {
        signal.throwIfAborted();
        const observations = await extractObservations({ text: question, origin, scope }, gateway, signal);
        signal.throwIfAborted();
        await memory.observe({ sessionId: session, turnId, revision: status.revision, observedAt, evidence: question, observations });
      }).catch(() => undefined).finally(() => { observations.delete(observation); });
    }
  } catch {
    if (request.isCurrent(controller)) {
      set({ error: 'Could not finish the answer. Check the model settings or try asking again.' });
    }
  } finally {
    if (request.isCurrent(controller)) set({ working: null });
  }
}
