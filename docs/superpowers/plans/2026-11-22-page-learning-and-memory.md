# Page Learning and Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn a technical page in an unpacked Chrome sidebar and personalize future reading sessions from user feedback and recurring questions.

**Architecture:** The side panel keeps page extraction, prompt construction, provider requests, and memory behind separate interfaces. The panel reads a small local memory snapshot before generation and records durable observations asynchronously after responses. Dexie owns persistence and supports a future OpenViking adapter through the same memory interface.

**Tech Stack:** Chrome Manifest V3, WXT, TypeScript, React, Tailwind, Zustand, Dexie, Vercel AI SDK, Node-based tests with a fake IndexedDB implementation.

**Spec:** `docs/superpowers/specs/2026-11-22-dev-learning-extension-design.md`, personal v1 only.

## Global Constraints

- V1 is loaded unpacked for personal use. Public distribution has its own milestone.
- Local Qwen, OpenAI, and Anthropic are supported as BYOM options. Model requests go to the endpoint selected by the user.
- Long-lived streaming runs in the side panel. The service worker handles opening the panel.
- Reading and memory work with a local model and browser storage. Internet research, full repos, docs crawling, and PDF handling follow the v1 delivery milestone.
- Memory stores only validated learning observations derived from user-authored requests or feedback. Page contents, generated text, and unclicked suggestions are excluded as evidence.

## Review Focus

- A changed tab must never display a stream or follow-up from the previous page. Cover stale responses in Task 2.
- MLX may ignore schema response formats or return malformed structured output. Cover tool fallback and repair in Task 2.
- A retried turn must never count twice. Cover duplicate observations and transaction boundaries in Task 3.
- A one-time depth request and page instructions must not become global preferences. Cover provenance and precedence in Tasks 3 and 4.
- Pausing or clearing memory during extraction must prevent the in-flight write. Cover write invalidation in Tasks 3 and 4.

## Task 1. Side panel, page extraction, and model settings

Files `package.json`, `wxt.config.ts`, `entrypoints/background.ts`, `entrypoints/sidepanel/`, `src/page/extract.ts`, `src/models/profiles.ts`, and `tests/page.test.ts`.

Interfaces `extractPage(document: Document): PageSource | null`, where `PageSource` contains `title`, `url`, and `text`. `ModelProfile` contains a provider kind, endpoint where applicable, model ID, optional credential, tool-call capability, and thinking toggle.

- [x] Create the WXT scaffold and a fixture test. Assert an article fixture yields its title and body without navigation text, and a content-free fixture yields `null`. Run the test and confirm the extraction behavior is missing.
- [x] Implement extraction on a cloned document with Readability or an attributed MIT module. Run extraction via `chrome.scripting` when the panel opens from the toolbar and when the user requests the active page. Show an actionable error for restricted tabs and a refresh action for a changed page. Keep profile credentials in extension-owned local storage. Request custom-origin access from an explicit settings action and display the destination that receives the page text.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build`. Load `.output/chrome-mv3` in Chrome and verify that opening the action displays the panel and extracts a fixture page. Commit when Git is available.

## Task 2. Layered learning, System 1, and grounded chat

Files `src/models/gateway.ts`, `src/learning/session.ts`, `src/learning/prompts.ts`, `entrypoints/sidepanel/`, and `tests/learning.test.ts`.

Interfaces `ModelGateway.stream(request, signal): AsyncIterable<string>` and `ModelGateway.decide(request, schema, signal): Promise<unknown>`. A reading session accepts a `PageSource`, an explanation depth, and bounded recalled context. Stream events identify the reading session and section.

- [x] Add tests asserting the introductory explanation starts before System 1 completes, a response from an old session is ignored after a source change, and an invalid structured tool result falls back to prompt JSON with at most one repair. Observe the expected failures.
- [x] Implement provider adapters with the AI SDK. Send MLX's thinking toggle on compatible System 1 requests. Force a named tool if supported, then fall back to prompt JSON, schema validation, and one repair attempt. Use a safe route after malformed output. Start the introduction using the bounded excerpt, then stream the example, use cases, and walkthrough. Keep depth controls and grounded chat in the panel. Render an optional Mermaid diagram with strict rendering, a copy action, and a useful fallback if the syntax is invalid. Cancel old work on tab change, regeneration, or panel close.
- [x] Run the test, typecheck, and build commands. Use a fixture endpoint for streaming and the owner's Qwen profile for an end-to-end check when reachable. Verify that the introduction, depth change, and grounded follow-up work before wiring in memory. Commit when Git is available.

## Task 3. Browser-local memory and precedence

Files `src/memory/types.ts`, `src/memory/repository.ts`, `src/memory/policy.ts`, and `tests/memory.test.ts`.

Interfaces `MemoryRepository.recall(scope): Promise<MemoryContext>`, `observe(batch): Promise<void>`, `list(): Promise<MemoryRecord[]>`, `update(record): Promise<void>`, `remove(id): Promise<void>`, `clear(): Promise<void>`, and `setEnabled(enabled): Promise<void>`. A write batch carries source `sessionId` and `turnId`, validated observations, and the memory revision captured before extraction. A record carries an ID, kind, value, scope, evidence references, and whether it was explicit or inferred.

- [x] Add IndexedDB-backed tests asserting an explicit preference is recalled after one interaction, an inferred pattern needs evidence from two distinct sessions, duplicate turns count once, and topic-scoped memory does not leak into unrelated prompts. Assert a pending batch is rejected following pause, deletion, or clear, and a newer explicit edit wins over inference. Observe the expected failures.
- [x] Implement stable preference and intent keys, evidence deduplication, and atomic writes. Use structured explanation categories such as example language, example placement, depth, and recurring follow-up intent. A one-off phrasing request stays in the reading session unless the user marks it as a durable preference. `recall` returns relevant topic and global entries, with explicit preferences taking precedence and a hard 600-character cap on formatted prompt context. Keep references to the supporting turns so the user can inspect why a record exists. Invalidation on pause, edit, delete, or clear prevents stale asynchronous writes.
- [x] Run the memory test, full test suite, typecheck, and build. Verify a round trip across two repository instances and confirm a paused store returns no recalled context. Commit when Git is available.

## Task 4. Personalization, follow-up suggestions, and controls

Files `src/memory/observation.ts`, `src/learning/session.ts`, `src/learning/prompts.ts`, `entrypoints/sidepanel/`, and `tests/personalization.test.ts`.

Interfaces `extractObservations(turn: UserTurn, gateway: ModelGateway): Promise<Observation[]>` and `prepareSuggestions(page: PageSource, context: MemoryContext): Promise<string[]>`. The observation input contains user text and a page topic label. The repository supplies saved evidence and preferences for the memory view.

- [x] Add flow tests asserting a saved TypeScript preference reaches a later page's generation prompt, a repeated failure-mode intent produces a suggestion grounded in the new page, and page text or an unclicked suggestion cannot create an observation. Assert current depth wins over memory and paused memory yields ordinary learning output. Observe the expected failures.
- [x] Read bounded memory before streaming. After a completed answer, extract observations from the user's message and any explicit feedback with a bounded request. Keep generation usable on extraction failure. Render optional page-specific suggested questions, and route selected suggestions through the existing question input. Add a memory view with evidence, editing, deletion, pause, and clear controls. Explain that recalled preferences can be included in requests to the selected model.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build`. In Chrome, set a preference, learn a different article, check the applied preference and suggested prompts, then pause memory and repeat. Record any steps that could not be verified on Chrome or the local Qwen endpoint. Commit when Git is available.
