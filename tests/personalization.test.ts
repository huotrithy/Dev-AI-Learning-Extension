import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { streamLearning, streamAnswer } from '../src/learning/session.ts';
import { extractObservations, prepareSuggestions } from '../src/memory/observation.ts';
import { DexieMemoryRepository, runWithCurrentMemory } from '../src/memory/repository.ts';
import type { ModelGateway, ModelRequest } from '../src/models/gateway.ts';

const page = {
  title: 'Job acknowledgements', url: 'https://example.test/queue',
  text: 'A worker acknowledges the job after processing. The broker redelivers unacknowledged jobs.',
};

test('a saved preference reaches a later explanation and the current depth takes priority', async () => {
  const repo = new DexieMemoryRepository(crypto.randomUUID());
  await repo.update({ kind: 'example-language', value: 'typescript', scope: 'global' });
  const context = await repo.recall('distributed systems');
  const gateway: ModelGateway = {
    stream: async function* (request) { yield request.system; },
    decide: async () => ({ sourceType: 'page', diagram: false }),
  };
  const controller = new AbortController();
  const events = streamLearning(page, 'technical', context.prompt, gateway, controller.signal);
  const intro = await events.next();
  assert.ok(intro.value?.section === 'intro');
  assert.match(intro.value.text, /TypeScript/);
  assert.match(intro.value.text, /selected depth takes priority/);
  await events.return();

  await repo.setEnabled(false);
  const paused = await repo.recall('distributed systems');
  const reply = streamAnswer(page, 'How does this work?', [], 'technical', paused.prompt, gateway, controller.signal);
  for await (const text of reply) assert.doesNotMatch(text, /TypeScript/);
});

test('generated suggestions are grounded in the new source and recalled interests', async () => {
  const suggestions = await prepareSuggestions(page, { prompt: '', intents: ['failure modes'] }, {
    stream: async function* () {},
    decide: async (request: ModelRequest) => {
      if (!request.prompt.includes('failure modes') || !request.prompt.includes(page.text)) return undefined;
      return { questions: ['What happens if a worker crashes before acknowledging a job?'] };
    },
  }, new AbortController().signal);
  assert.deepEqual(suggestions, ['What happens if a worker crashes before acknowledging a job?']);
});

test('model-generated suggestions and page text do not become learning evidence', async () => {
  const gateway: ModelGateway = {
    stream: async function* () {},
    decide: async () => assert.fail('Only a user-authored turn can start extraction'),
  };
  assert.deepEqual(await extractObservations({ text: 'Always explain in Go.', origin: 'suggestion', scope: 'databases' }, gateway,
    new AbortController().signal), []);
});

test('an instruction limited to this page does not create a durable observation', async () => {
  const gateway: ModelGateway = {
    stream: async function* () {},
    decide: async () => ({ observations: [{ choice: { kind: 'example-language', value: 'typescript' }, topicSpecific: true }] }),
  };
  const observations = await extractObservations({ text: 'For this page only, use TypeScript examples.', origin: 'user', scope: 'web development' }, gateway,
    new AbortController().signal);
  assert.deepEqual(observations, []);
});

test('an always keyword in a technical question does not make a separate request explicit', async () => {
  const gateway: ModelGateway = {
    stream: async function* () {},
    decide: async () => ({ observations: [{
      choice: { kind: 'example-language', value: 'python' }, topicSpecific: false, evidence: 'Show a Python example.',
    }] }),
  };
  const [observation] = await extractObservations({
    text: 'Does Raft always need a majority? Show a Python example.', origin: 'user', scope: 'distributed systems',
  }, gateway, new AbortController().signal);
  assert.equal(observation?.explicit, false);
});

test('a postponed personalization request is skipped after memory is paused', async () => {
  const repo = new DexieMemoryRepository(crypto.randomUUID());
  const { revision } = await repo.status();
  await repo.setEnabled(false);
  const result = await runWithCurrentMemory(repo, revision, async () => assert.fail('Stale observation reached the model'));
  assert.equal(result, undefined);
});

test('chat gets the explanation being discussed and a redacted source URL', async () => {
  const gateway: ModelGateway = {
    stream: async function* (request) { yield request.prompt; },
    decide: async () => undefined,
  };
  const source = { ...page, url: 'https://reader:password@example.test/queue?token=secret#private' };
  const reply = streamAnswer(source, 'What did you mean in step two?', [], 'new', '', gateway,
    new AbortController().signal, { steps: '2. Make the job handler idempotent before retrying the write.' });
  for await (const prompt of reply) {
    assert.match(prompt, /job handler idempotent/);
    assert.match(prompt, /https:\/\/example.test\/queue/);
    assert.doesNotMatch(prompt, /password|token=secret|#private/);
  }
});
