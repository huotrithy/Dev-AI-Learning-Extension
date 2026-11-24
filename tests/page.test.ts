import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { extractPage } from '../src/page/extract.ts';

test('extracts the article with its title and URL', () => {
  const url = 'https://example.test/queues';
  const document = new JSDOM(`<!doctype html><title>Reliable queues</title>
    <nav>Private navigation menu</nav><main><article><h1>Reliable queues</h1>
    <p>A producer places jobs on the queue. A consumer acknowledges a job after processing.</p>
    <p>Repeated delivery means the handler should support idempotent execution.</p></article></main>`, { url }).window.document;

  const source = extractPage(document);
  assert.equal(source?.title, 'Reliable queues');
  assert.equal(source?.url, url);
  assert.match(source?.text ?? '', /acknowledges a job/);
  assert.doesNotMatch(source?.text ?? '', /Private navigation menu/);
});

test('returns no source for a page with only controls', () => {
  const document = new JSDOM('<nav>Go back</nav><main><form><button>Continue</button></form></main>', {
    url: 'https://example.test/',
  }).window.document;
  assert.equal(extractPage(document), null);
});
