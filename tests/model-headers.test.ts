import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createGateway } from '../src/models/gateway.ts';
import { createProfile } from '../src/models/profiles.ts';

test('model requests use the headers for their own profile', async (t) => {
  const requests: Headers[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Headers(init?.headers));
    const reply = { id: 'fixture', model: 'fixture', created: 0 };
    if (requests.length === 1) {
      const chunk = { ...reply, choices: [{ index: 0, delta: { content: 'Ready' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return Response.json({
      ...reply, choices: [{ index: 0, message: { role: 'assistant', content: '{"ready":true}' }, finish_reason: 'stop' }],
    });
  });
  const base = { ...createProfile(), endpoint: 'https://example.test/v1', key: 'fixture-key', toolCalls: false };
  const main = { ...base, customHeaders: [{ name: 'X-Tenant', value: 'main' }, { name: 'X-Main-Only', value: 'yes' }] };
  const system = { ...base, customHeaders: [{ name: 'x-tenant', value: 'system' }] };
  const gateway = createGateway(main, system);
  const request = { system: 'Fixture', prompt: 'Fixture', maxOutputTokens: 10 };
  const signal = new AbortController().signal;
  for await (const _chunk of gateway.stream(request, signal)) { /* Consume the stream. */ }
  assert.deepEqual(await gateway.decide(request, z.object({ ready: z.boolean() }), signal), { ready: true });
  assert.deepEqual(requests.map((headers) => [headers.get('x-tenant'), headers.get('x-main-only'), headers.get('authorization')]), [
    ['main', 'yes', 'Bearer fixture-key'],
    ['system', null, 'Bearer fixture-key'],
  ]);
});

test('custom headers require HTTPS outside loopback', () => {
  const profile = { ...createProfile(), endpoint: 'http://192.168.1.5:8080/v1', customHeaders: [{ name: 'X-API-Key', value: 'fixture' }] };
  assert.throws(() => createGateway(profile, profile), /Use HTTPS/);
  const local = { ...profile, endpoint: 'http://localhost:8080/v1' };
  assert.doesNotThrow(() => createGateway(local, local));
});
