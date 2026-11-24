import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const prompts = [];
const server = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', '*');
  response.setHeader('access-control-allow-private-network', 'true');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }

  if (request.url !== '/v1/chat/completions') {
    const title = request.url === '/second' ? 'Queue acknowledgments' : 'Reliable work queues';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<title>${title}</title><article><h1>${title}</h1><p>Jobs are acknowledged after processing. A broker can redeliver jobs a worker does not acknowledge.</p></article>`);
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const { stream, messages } = JSON.parse(Buffer.concat(chunks));
  const system = messages[0].content;
  const prompt = messages.at(-1).content;
  const envelope = { id: 'fixture', model: 'fixture', created: 0 };
  if (!stream) {
    let decision = { sourceType: 'page', diagram: true };
    if (system.includes('Identify supported')) {
      decision = { observations: [{ choice: { kind: 'example-language', value: 'typescript' }, topicSpecific: false, evidence: 'Always use TypeScript examples.' }] };
    }
    if (system.includes('Write one or two short')) decision = { questions: ['What happens if a worker crashes before acknowledging a job?'] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ...envelope, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(decision) }, finish_reason: 'stop' }] }));
    return;
  }

  prompts.push({ system, prompt });
  const content = prompt.startsWith('Write one small Mermaid')
    ? 'flowchart LR\nA[Broker] --> B[Worker]'
    : 'Acknowledgments let a broker track whether a job finished.';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});

await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = resolve('.output/chrome-mv3');
const testRoot = resolve('.superpowers');
await mkdir(testRoot, { recursive: true });
const profile = await mkdtemp(join(testRoot, 'chromium-smoke-'));
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async (endpoint) => {
    await chrome.storage.local.set({ models: {
      main: 'fixture', system: 'fixture', profiles: [{
        id: 'fixture', label: 'Fixture', provider: 'compatible', model: 'fixture', endpoint,
        key: '', toolCalls: false, disableThinking: false,
      }],
    } });
  }, `${origin}/v1`);

  const article = context.pages()[0] ?? await context.newPage();
  await article.goto(`${origin}/first`);
  const tabCdp = await context.newCDPSession(article);
  const { targetInfos } = await tabCdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const articleTarget = targetInfos.find(({ url }) => url === article.url());
  assert.ok(articleTarget, 'Article tab is available');
  const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/);
  const client = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const cdp = await client.newBrowserCDPSession();
  await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: articleTarget.targetId });

  let panelTarget;
  for (let attempt = 0; attempt < 30 && !panelTarget; attempt += 1) {
    const { targetInfos: targets } = await cdp.send('Target.getTargets', { filter: [{ type: 'page' }] });
    panelTarget = targets.find(({ url }) => url === `chrome-extension://${extensionId}/sidepanel.html`);
    if (!panelTarget) await setTimeout(100);
  }
  assert.ok(panelTarget, 'The toolbar action opens the native side panel');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: panelTarget.targetId, flatten: false });
  let commandId = 0;

  async function evaluate(expression) {
    const id = ++commandId;
    const reply = Promise.withResolvers();
    const receive = ({ message, sessionId: source }) => {
      if (source !== sessionId) return;
      const answer = JSON.parse(message);
      if (answer.id === id) reply.resolve(answer);
    };
    cdp.on('Target.receivedMessageFromTarget', receive);
    try {
      await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      }) });
      const { error, result } = await Promise.race([reply.promise, setTimeout(4_000, null, { ref: false }).then(() => { throw new Error('Side panel CDP timeout'); })]);
      assert.ok(!error && !result.exceptionDetails, JSON.stringify(error ?? result.exceptionDetails));
      return result.result.value;
    } finally {
      cdp.off('Target.receivedMessageFromTarget', receive);
    }
  }

  async function waitFor(text) {
    let body;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      body = await evaluate('document.body.innerText');
      if (body?.includes(text)) return;
      if (await evaluate('Boolean(document.querySelector("[role=alert]"))')) break;
      await setTimeout(125);
    }
    assert.fail(`Could not find ${text} in native side panel:\n${body}`);
  }

  async function click(text) {
    assert.equal(await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)});
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`), true, text);
  }

  async function select(label, value) {
    const changed = await evaluate(`(() => {
      const label = [...document.querySelectorAll('label')].find((item) => item.firstChild.textContent.trim() === ${JSON.stringify(label)});
      const field = label?.querySelector('select');
      if (!field) return false;
      field.value = ${JSON.stringify(value)};
      field.dispatchEvent(new Event('change', { bubbles: true })); return true;
    })()`);
    assert.ok(changed, `Select ${label}`);
  }

  await waitFor('Reliable work queues');
  await evaluate(`(() => {
    const question = document.querySelector('#question');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(question, 'Always use TypeScript examples.');
    question.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click('Send');
  await waitFor('Acknowledgments let a broker track');
  await waitFor('Learn this page');
  await setTimeout(400);
  await click('Memory');
  await waitFor('Why this was saved');
  await select('Preference type', 'intent');
  await click('Save preference');
  await waitFor('Preference saved.');
  await click('Read');

  await article.goto(`${origin}/second`);
  await waitFor('Queue acknowledgments');
  await click('Learn this page');
  await waitFor('What happens if a worker crashes before acknowledging a job?');
  assert.ok(prompts.some(({ system, prompt }) => system.includes('TypeScript') && prompt.includes('Queue acknowledgments')));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate('Boolean(document.querySelector(".diagram img")?.naturalWidth)')) break;
    await setTimeout(125);
  }
  assert.equal(await evaluate('Boolean(document.querySelector(".diagram img")?.naturalWidth)'), true,
    `The model flowchart renders under MV3:\n${await evaluate('document.body.innerText')}`);
  await click('Memory');
  await evaluate('document.querySelector("input[type=checkbox]").click()');
  await waitFor('Memory is paused.');
  await click('Read');
  const count = prompts.length;
  await click('Explain again');
  await waitFor('Copy as Mermaid');
  assert.ok(prompts.length > count);
  assert.ok(prompts.slice(count).every(({ system }) => !system.includes('TypeScript')));
  assert.equal(await evaluate('document.querySelectorAll(".suggestions button").length'), 0);
  await client.close();
  console.log('Chromium smoke passed: toolbar, extraction, chat, memory, personalized prompts, suggestions, diagram, and pause.');
} finally {
  await context?.close();
  server.close();
  const absolute = resolve(profile);
  if (absolute.startsWith(join(testRoot, 'chromium-smoke-'))) await rm(absolute, { recursive: true, force: true });
}
