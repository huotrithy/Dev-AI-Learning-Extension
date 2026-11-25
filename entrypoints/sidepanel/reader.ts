import { create } from "zustand";
import { liveQuery } from "dexie";
import { LatestRequest, streamAnswer, streamLearning, type ChatTurn } from "../../src/learning/session.ts";
import type { AnswerStyle } from "../../src/learning/answer-style.ts";
import { introductionQuestion } from "../../src/learning/prompts.ts";
import { createActivity, trackModelActivity, type ActivityStep } from "../../src/learning/activity.ts";
import { chatHistory } from "../../src/learning/history.ts";
import { defaultDepth, learningLimits, type Depth, type Section } from "../../src/learning/config.ts";
import type { RepositoryArchitecture } from "../../src/learning/architecture.ts";
import { extractObservations, prepareSuggestions, type UserTurn } from "../../src/memory/observation.ts";
import { pageScope } from "../../src/memory/policy.ts";
import { DexieMemoryRepository, runWithCurrentMemory } from "../../src/memory/repository.ts";
import { emptyMemory } from "../../src/memory/types.ts";
import { InsecureModelEndpointError, isNativeDecision, type PublicModelSettings as ModelSettings } from "../../src/models/profiles.ts";
import { createWorkerGateway, ModelProfileChangedError } from "../../src/models/worker-client.ts";
import type { ModelGateway } from "../../src/models/gateway.ts";
import { readTab, readYouTube } from "../../src/page/active-tab.ts";
import { docsReferences, loadDocs, searchDocs } from "../../src/page/docs.ts";
import type { PageSource } from "../../src/page/extract.ts";
import { githubApiPermission, githubRepository, loadRepository, repositoryHome, RepositoryReadError, traceRepository } from "../../src/page/github.ts";
import { youtubeVideo } from "../../src/page/youtube.ts";

interface ReaderState {
  page?: PageSource;
  tabId?: number;
  session: string;
  loading: boolean;
  working: "learn" | "chat" | "revise" | null;
  depth: Depth;
  includeRelatedDocs: boolean;
  sections: Partial<Record<Section, string>>;
  introStyle?: AnswerStyle;
  architecture?: RepositoryArchitecture | null;
  activity: ActivityStep[];
  chat: ChatTurn[];
  historyError?: string;
  suggestions: string[];
  error: string;
  notice: string;
  question: string;
}

const initialReader: ReaderState = {
  session: "",
  loading: true,
  working: null,
  depth: defaultDepth,
  includeRelatedDocs: false,
  sections: {},
  introStyle: undefined,
  architecture: undefined,
  activity: [],
  chat: [],
  suggestions: [],
  error: "",
  notice: "",
  question: "",
  historyError: undefined,
};

export type ReaderSnapshot = Pick<ReaderState, "tabId" | "session" | "depth" | "includeRelatedDocs" | "sections" | "introStyle" | "architecture" | "chat" | "suggestions" | "question" | "notice"> & { url?: string; loadedSource?: PageSource; activity?: ActivityStep[] };

export function hasActiveChat({ chat, question }: Pick<ReaderState, "chat" | "question">): boolean {
  return chat.length > 0 || Boolean(question.trim());
}

export function hasPendingDocsScope({ page, includeRelatedDocs }: Pick<ReaderState, "page" | "includeRelatedDocs">): boolean {
  return Boolean(page?.docs) !== includeRelatedDocs;
}

export function snapshotReader(): ReaderSnapshot {
  const state = useReader.getState();
  const { tabId, page, session, depth, includeRelatedDocs, sections, introStyle, architecture, activity, chat, suggestions, question, notice } = state;
  const loadedSource = hasActiveChat(state) || page?.repository || page?.docs || page?.video ? page : undefined;
  return { tabId, url: page?.url, session, depth, includeRelatedDocs, sections, introStyle, architecture, activity, chat, suggestions, question, notice, loadedSource };
}

export const memory = new DexieMemoryRepository();
export const useReader = create<ReaderState>(() => initialReader);
const request = new LatestRequest();
const navigation = new LatestRequest();
const suggestionRequest = new LatestRequest();
const observations = new Set<AbortController>();

function selectedGateway(settings: ModelSettings) {
  const main = settings.profiles.find(profile => profile.id === settings.main);
  const system = settings.profiles.find(profile => profile.id === settings.system);
  if (!main)
    throw new Error("Select an explanation model.");
  return {
    gateway: createWorkerGateway(main, system ?? main),
    models: { main: main.model, system: (system ?? main).model, classificationOnly: isNativeDecision(system ?? main) },
  };
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
      if (revision !== undefined && revision !== status.revision)
        invalidateMemoryWork();
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
  if (revision === undefined)
    return gateway;
  return { ...gateway, async* stream(input, signal) {
    const stream = await runWithCurrentMemory(memory, revision, async () => {
      signal.throwIfAborted();
      return gateway.stream(input, signal);
    });
    if (!stream)
      throw new Error("Memory changed while preparing the response.");
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

function restoreReader(tabId: number | undefined, page: PageSource, snapshot: ReaderSnapshot): void {
  const { depth, includeRelatedDocs = Boolean(page.docs), sections, introStyle, architecture, activity = [], chat, suggestions, question, session, notice } = snapshot;
  useReader.setState({ tabId, page, depth, includeRelatedDocs, sections, introStyle, architecture, activity, chat, suggestions, question, session, notice, loading: false });
}

export async function loadPage(
  windowId: number,
  restore?: ReaderSnapshot,
  acceptTab?: (tab: chrome.tabs.Tab) => boolean,
): Promise<void> {
  const previous = useReader.getState();
  resetPage(previous.tabId);
  const controller = navigation.start();
  if (restore?.loadedSource && restore.loadedSource.url === restore.url && hasActiveChat(restore)) {
    restoreReader(restore.tabId, restore.loadedSource, restore);
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!navigation.isCurrent(controller))
      return;
    if (tab?.id === undefined)
      throw new Error("Open a web page to start reading.");
    if (acceptTab && !acceptTab(tab)) {
      useReader.setState({ tabId: tab.id, loading: false });
      return;
    }
    useReader.setState({ tabId: tab.id });
    const repo = githubRepository(tab.url ?? "");
    const youtube = youtubeVideo(tab.url ?? "");
    const page = repo
      ? repositoryHome(repo)
      : youtube
        ? { title: tab.title?.replace(/\s+- YouTube$/, "").trim().slice(0, 300) || "YouTube video", url: youtube.url, text: "" }
        : await readTab(tab.id);
    if (!navigation.isCurrent(controller))
      return;
    const samePage = previous.page?.url === page.url;
    if (restore?.tabId === tab.id && restore.url === page.url) {
      restoreReader(tab.id, restore.loadedSource?.url === page.url ? restore.loadedSource : page, restore);
    }
    else {
      useReader.setState({
        page,
        session: samePage ? previous.session : crypto.randomUUID(),
        includeRelatedDocs: samePage && previous.tabId === tab.id && previous.includeRelatedDocs,
        loading: false,
      });
    }
  }
  catch (error) {
    if (navigation.isCurrent(controller))
      useReader.setState({ loading: false, error: error instanceof Error ? error.message : "Unable to read the page." });
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

export async function learn(settings: ModelSettings): Promise<void> {
  const { depth, includeRelatedDocs, tabId, page: loadedPage } = useReader.getState();
  let page = loadedPage;
  if (!page)
    return;
  const controller = request.start();
  clearSuggestions();
  const set = useReader.setState;
  set({ working: "learn", depth, sections: {}, introStyle: undefined, architecture: undefined, activity: [], error: "", notice: "" });
  const repo = githubRepository(page.url);
  const youtube = youtubeVideo(page.url);
  const activity = createActivity(controller.signal, (steps) => {
    if (request.isCurrent(controller))
      set({ activity: steps });
  });
  const fetchDocs = includeRelatedDocs && !repo && !youtube && Boolean(page.relatedLinks?.length) && !page.docs;
  const finishSource = activity.start(repo && !page.repository
    ? "Read files from GitHub"
    : fetchDocs ? "Read linked documentation" : youtube && !page.video ? "Read YouTube transcript" : "Use the loaded source");

  try {
    if (repo && !page.repository) {
      const granted = await chrome.permissions.request({ origins: [githubApiPermission] });
      controller.signal.throwIfAborted();
      if (!granted)
        throw new RepositoryReadError("Allow access to api.github.com to read this repository.");
      page = await loadRepository(repo, controller.signal);
      if (!request.isCurrent(controller))
        return;
      set({ page });
    }
    if (youtube && !page.video && tabId !== undefined) {
      const source = await readYouTube(tabId, youtube);
      if (!request.isCurrent(controller))
        return;
      if (!source) {
        finishSource("fallback", { detail: "No open transcript was available" });
        set({ notice: "Expand the video description and select Show transcript if available. Try again once the captions appear." });
        return;
      }
      page = source;
      set({ page });
    }
    if (fetchDocs) {
      const url = new URL(page.url);
      const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }).catch(() => false);
      controller.signal.throwIfAborted();
      if (granted) {
        const collection = await loadDocs(page, controller.signal, new DOMParser());
        if (!request.isCurrent(controller))
          return;
        page = { ...page, ...collection };
        set({ page, chat: [] });
      }
      else {
        set({ includeRelatedDocs: false, notice: "Site access was declined. The explanation uses the current page." });
      }
    }
    else if (!includeRelatedDocs && page.docs) {
      page = { ...page, docs: undefined, docsIndex: undefined };
      set({ page, chat: [] });
    }
    const references = docsReferences(page);
    finishSource(fetchDocs && !page.docs?.length ? "fallback" : "done", page.repository
      ? {
          detail: `Commit ${page.repository.commit.slice(0, 7)}`,
          files: page.repository.files.map(({ path, url }) => ({ path, url })),
        }
      : references
        ? {
            detail: page.docs?.length ? "Used the current page and linked pages" : "Only the current page was available",
            files: references.map(({ title, url }) => ({ path: title, url })),
          }
        : page.video
          ? { detail: page.video.truncated ? "Captured part of the YouTube transcript" : "Captured the displayed YouTube transcript" }
          : { detail: new URL(page.url).hostname });
    const { gateway, models } = selectedGateway(settings);
    const { context, status } = await readMemory(pageScope(page));
    controller.signal.throwIfAborted();
    const scopedGateway = protectRecall(trackModelActivity(gateway, activity, models), context.prompt ? status?.revision : undefined);
    for await (const event of streamLearning(page, depth, context.prompt, scopedGateway, controller.signal)) {
      if (!request.isCurrent(controller))
        return;
      if (event.section === "architecture") {
        set({ architecture: event.map });
      }
      else {
        const { section, text } = event;
        set(({ sections }) => ({ sections: { ...sections, [section]: (sections[section] ?? "") + text } }));
      }
    }
    if (!request.isCurrent(controller))
      return;
    if (!useReader.getState().sections.intro?.trim())
      throw new Error("The model returned no visible text.");
    if (status?.enabled && context.intents.length) {
      const source = page;
      const suggestion = suggestionRequest.start();
      const signal = AbortSignal.any([suggestion.signal, AbortSignal.timeout(learningLimits.personalizationTimeoutMs)]);
      void runWithCurrentMemory(memory, status.revision, async () => {
        signal.throwIfAborted();
        return prepareSuggestions(source, context, gateway, signal);
      }).then(async (suggestions) => {
        if (!suggestions)
          return;
        await runWithCurrentMemory(memory, status.revision, async () => {
          if (suggestionRequest.isCurrent(suggestion))
            set({ suggestions });
        });
      }).catch(() => undefined);
    }
  }
  catch (error) {
    finishSource("error");
    if (request.isCurrent(controller)) {
      set({ error: error instanceof InsecureModelEndpointError || error instanceof ModelProfileChangedError || error instanceof RepositoryReadError
        ? error.message
        : repo && !page.repository
          ? "Could not read the repository from GitHub. Try again in a moment."
          : youtube && !page.video
            ? "Click the extension icon on the YouTube tab to grant access."
            : "Could not finish the explanation. Check the model endpoint and settings, then try again." });
    }
  }
  finally {
    if (request.isCurrent(controller))
      set({ working: null });
  }
}

async function findAnswerSource(page: PageSource, question: string, signal: AbortSignal) {
  if (page.docs)
    return { source: searchDocs(page, question) };
  try {
    return { source: await traceRepository(page, question, signal) };
  }
  catch (error) {
    signal.throwIfAborted();
    const detail = error instanceof RepositoryReadError ? `${error.message} ` : "";
    return { source: page, repositoryNotice: `${detail}This answer uses the repository excerpts already loaded.` };
  }
}

export async function ask(text: string, origin: UserTurn["origin"], settings: ModelSettings): Promise<void> {
  const reader = useReader.getState();
  const { page, session, chat, depth, working, sections } = reader;
  const question = text.trim().slice(0, learningLimits.chat.questionCharacters);
  if (!page || !question || working || hasPendingDocsScope(reader) || (githubRepository(page.url) && !page.repository) || (youtubeVideo(page.url) && !page.video))
    return;
  const controller = request.start();
  const historyRevision = chatHistory.revision().catch(() => undefined);
  const turnId = crypto.randomUUID();
  const observedAt = performance.timeOrigin + performance.now();
  const scope = pageScope(page);
  const set = useReader.setState;
  const turn: ChatTurn = { id: turnId, question, answer: "" };
  set({ working: "chat", chat: [...chat, { ...turn }], error: "", historyError: undefined });
  const publish = () => {
    if (request.isCurrent(controller))
      set({ chat: [...chat, { ...turn }] });
  };
  const activity = createActivity(controller.signal, (steps) => {
    turn.activity = steps;
    publish();
  });

  try {
    const { gateway, models } = selectedGateway(settings);
    const { status, context } = await readMemory(scope);
    controller.signal.throwIfAborted();
    const finishSource = activity.start(page.repository ? "Look for relevant repository files" : page.docs ? "Search the loaded documentation" : "Use the loaded page text");
    const { source, repositoryNotice } = await findAnswerSource(page, question, controller.signal);
    turn.repositoryNotice = repositoryNotice;
    turn.docsReferences = docsReferences(source);
    turn.repositoryFiles = source.repository?.files.map(({ path, url }) => ({ path, url }));
    if (!request.isCurrent(controller))
      return;
    const knownFiles = new Set(page.repository?.files.map(({ url }) => url));
    const focusedFiles = turn.repositoryFiles?.filter(({ url }) => !knownFiles.has(url));
    finishSource(turn.repositoryNotice ? "fallback" : "done", page.repository
      ? {
          detail: focusedFiles?.length ? "Read focused excerpts" : "Used the loaded excerpts",
          files: focusedFiles,
        }
      : turn.docsReferences
        ? { files: turn.docsReferences.map(({ title, url }) => ({ path: title, url })) }
        : { detail: new URL(page.url).hostname });
    const scopedGateway = protectRecall(trackModelActivity(gateway, activity, models), context.prompt ? status?.revision : undefined);
    for await (const chunk of streamAnswer(source, question, chat, depth, context.prompt, scopedGateway, controller.signal, sections)) {
      if (!request.isCurrent(controller))
        return;
      turn.answer += chunk;
      publish();
    }
    if (!request.isCurrent(controller))
      return;
    if (!turn.answer.trim())
      throw new Error("The model returned no visible text.");

    if (status?.enabled && origin === "user") {
      const observation = new AbortController();
      observations.add(observation);
      const signal = AbortSignal.any([observation.signal, AbortSignal.timeout(learningLimits.personalizationTimeoutMs)]);
      void runWithCurrentMemory(memory, status.revision, async () => {
        signal.throwIfAborted();
        const observations = await extractObservations({ text: question, origin, scope }, gateway, signal);
        signal.throwIfAborted();
        await memory.observe({ sessionId: session, turnId, revision: status.revision, observedAt, evidence: question, observations });
      }).catch(() => undefined).finally(() => { observations.delete(observation); });
    }

    try {
      const revision = await historyRevision;
      if (!request.isCurrent(controller))
        return;
      if (revision === undefined)
        throw new Error("History unavailable");
      await chatHistory.save(revision, session, page, { id: turnId, question, answer: turn.answer });
    }
    catch {
      if (request.isCurrent(controller))
        set({ historyError: "Could not save this reply to history." });
    }
  }
  catch (error) {
    if (request.isCurrent(controller)) {
      set({ error: error instanceof InsecureModelEndpointError || error instanceof ModelProfileChangedError
        ? error.message
        : "Could not finish the answer. Check the model settings or try asking again." });
    }
  }
  finally {
    if (request.isCurrent(controller))
      set({ working: null });
  }
}

export async function reviseAnswer(target: "intro" | number, style: AnswerStyle, settings: ModelSettings): Promise<void> {
  const reader = useReader.getState();
  const { page, chat, sections, session, depth, working } = reader;
  const turn = target === "intro" ? undefined : chat[target];
  const previousAnswer = target === "intro" ? sections.intro : turn?.answer;
  if (!page || !previousAnswer?.trim() || working || hasPendingDocsScope(reader))
    return;

  const controller = request.start();
  const { signal } = controller;
  const set = useReader.setState;
  const historyRevision = turn?.id ? chatHistory.revision().catch(() => undefined) : undefined;
  set({ working: "revise", error: "", historyError: undefined });
  try {
    const { gateway } = selectedGateway(settings);
    const { status, context } = await readMemory(pageScope(page));
    signal.throwIfAborted();
    const question = turn?.question ?? introductionQuestion;
    const { source, repositoryNotice } = turn ? await findAnswerSource(page, question, signal) : { source: page };
    signal.throwIfAborted();
    const scopedGateway = protectRecall(gateway, context.prompt ? status?.revision : undefined);
    const earlier = target === "intro" ? [] : chat.slice(0, target);
    const explanation = turn ? sections : {};
    let answer = "";
    for await (const chunk of streamAnswer(source, question, earlier, depth, context.prompt, scopedGateway, signal, explanation, { style, previousAnswer })) {
      signal.throwIfAborted();
      answer += chunk;
    }
    signal.throwIfAborted();
    if (!answer.trim())
      throw new Error("The model returned no visible text.");

    if (target === "intro") {
      set({ sections: { ...sections, intro: answer }, introStyle: style });
    }
    else if (turn) {
      const revised: ChatTurn = {
        ...turn,
        answer,
        style,
        docsReferences: docsReferences(source),
        repositoryFiles: source.repository?.files.map(({ path, url }) => ({ path, url })),
        repositoryNotice,
      };
      set({ chat: chat.map((item, index) => index === target ? revised : item) });
      if (turn.id) {
        try {
          const revision = await historyRevision;
          if (revision === undefined)
            throw new Error("History unavailable");
          if (request.isCurrent(controller))
            await chatHistory.revise(revision, session, turn.id, answer);
        }
        catch {
          if (request.isCurrent(controller))
            set({ historyError: "Could not save the revised answer to history." });
        }
      }
    }
  }
  catch (error) {
    if (!request.isCurrent(controller))
      return;
    throw error instanceof InsecureModelEndpointError || error instanceof ModelProfileChangedError
      ? error
      : new Error("Could not revise this answer. Try again.");
  }
  finally {
    if (request.isCurrent(controller))
      set({ working: null });
  }
}
