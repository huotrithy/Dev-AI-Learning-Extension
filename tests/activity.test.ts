import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import * as activity from '../src/learning/activity.ts';
import type { ModelGateway, ModelRequest } from '../src/models/gateway.ts';

const request: ModelRequest = { system: 'internal instructions', prompt: 'private source text', maxOutputTokens: 50 };

test('activity reports the selected model and task without recording request text or provider errors', async () => {
  const controller = new AbortController();
  let steps: activity.ActivityStep[] = [];
  const log = activity.createActivity(controller.signal, (next) => { steps = next; });
  const gateway: ModelGateway = {
    async *stream() { yield 'one'; throw new Error('private provider response'); },
    async decide() { return undefined; },
  };
  const tracked = activity.trackModelActivity(gateway, log, { main: 'qwen', system: 'gemma' });
  const stream = tracked.stream({ ...request, activity: 'Write the explanation' }, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value, 'one');
  assert.equal(steps[0]?.status, 'running');
  await assert.rejects(stream.next(), /private provider response/);
  assert.equal(await tracked.decide({ ...request, activity: 'Classify the source' }, z.object({}), controller.signal), undefined);
  assert.deepEqual(steps.map(({ label, detail, status }) => [label, detail, status]), [
    ['Write the explanation', 'qwen', 'error'], ['Classify the source', 'gemma', 'fallback'],
  ]);
  assert.doesNotMatch(JSON.stringify(steps), /private|internal/);
});

test('cancelling an activity marks running steps as stopped and ignores late results', () => {
  const controller = new AbortController();
  let steps: activity.ActivityStep[] = [];
  const log = activity.createActivity(controller.signal, (next) => { steps = next; });
  const done = log.start('Read source');
  done();
  const late = log.start('Write the answer');
  controller.abort();
  late();
  assert.deepEqual(steps.map(({ status }) => status), ['done', 'stopped']);
});
