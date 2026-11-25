import assert from "node:assert/strict";
import { cp, readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";

const prompts = [];
const authorizationHeaders = [];
const serviceTokens = [];
const repoHome = "https://github.com/example/fixture-reader";
const repoCommit = "a".repeat(40);
const repoFile = `${repoHome}/blob/${repoCommit}/src/index.ts`;
const server = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "*");
  response.setHeader("access-control-allow-private-network", "true");
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }

  if (request.url !== "/v1/chat/completions") {
    const title = request.url === "/third" ? "Queue rate limits" : request.url === "/second" ? "Queue acknowledgments" : "Reliable work queues";
    response.writeHead(200, { "content-type": "text/html" });
    const related = request.url === "/first"
      ? '<a rel="next" href="/second">Read about acknowledgments</a>'
      : request.url === "/second" ? '<a rel="next" href="/third">Read about rate limits</a>' : "";
    const text = request.url === "/third"
      ? "Throttle job processing by configuring max_concurrency for each worker."
      : "Jobs are acknowledged after processing. A broker can redeliver jobs a worker does not acknowledge.";
    response.end(`<title>${title}</title><article><h1>${title}</h1><p>${text}</p>${related}</article>`);
    return;
  }

  authorizationHeaders.push(request.headers.authorization);
  serviceTokens.push([request.headers["cf-access-client-id"], request.headers["cf-access-client-secret"]]);
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const { stream, messages } = JSON.parse(Buffer.concat(chunks));
  const system = messages[0].content;
  const prompt = messages.at(-1).content;
  const envelope = { id: "fixture", model: "fixture", created: 0 };
  if (!stream) {
    let decision = { sourceType: "page", diagram: true };
    if (system.includes("Identify supported")) {
      decision = { observations: [{ choice: { kind: "example-language", value: "typescript" }, topicSpecific: false, evidence: "Always use TypeScript examples." }] };
    }
    if (system.includes("Write one or two short"))
      decision = { questions: ["What happens if a worker crashes before acknowledging a job?"] };
    if (system.includes("Extract a small flowchart")) {
      decision = {
        nodes: ["Broker", "Worker"],
        connections: [{
          from: 0,
          to: 1,
          label: "redelivers jobs",
          evidence: "A broker can redeliver jobs a worker does not acknowledge.",
        }],
      };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...envelope, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(decision) }, finish_reason: "stop" }] }));
    return;
  }

  prompts.push({ system, prompt });
  const content = system.includes("Revise the answer in simpler language")
    ? "A broker checks whether the worker finished the job."
    : system.includes("Add a concrete example to the answer")
      ? "For example, a worker sends an acknowledgment after sending an email."
      : system.includes("Expand the answer with more detail")
        ? " "
        : system.includes("The repository tree is a sample")
    ? `Fixture architecture uses [the entry point](${repoFile}). [Invented source](https://example.org/invented)`
    : prompt.includes("Question: How do I set max_concurrency?")
      ? `Set the [worker concurrency limit](http://127.0.0.1:${server.address().port}/third).`
      : prompt.includes("What does the broker track?")
        ? "Acknowledgments let a broker track whether a job finished.\n\n| Item | Meaning |\n| --- | --- |\n| ACK | Job finished |"
        : "Acknowledgments let a broker track whether a job finished.";
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});

await new Promise(ready => server.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const modelEndpoint = `http://localhost:${server.address().port}/v1`;
const testRoot = resolve(".superpowers");
await mkdir(testRoot, { recursive: true });
const profile = await mkdtemp(join(testRoot, "chromium-smoke-"));
let context;

try {
  const extension = join(profile, "extension");
  await cp(resolve(".output/chrome-mv3"), extension, { recursive: true });
  const manifestPath = join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // The fixture preloads a saved profile, including the host access granted during normal profile setup.
  manifest.host_permissions = [...(manifest.host_permissions ?? []), "http://localhost/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(profile, "browser"), {
    channel: process.env.EXTENSION_TEST_CHANNEL ?? "chromium",
    headless: true,
    executablePath: process.env.EXTENSION_TEST_EXECUTABLE,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--remote-debugging-port=0"],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async (endpoint) => {
    await chrome.storage.local.set({ models: {
      main: "fixture",
      system: "fixture",
      profiles: [{
        id: "fixture",
        label: "Fixture",
        provider: "compatible",
        model: "fixture",
        endpoint,
        key: "fixture-key",
        toolCalls: false,
        disableThinking: false,
        customHeaders: [
          { name: "CF-Access-Client-Id", value: "fixture-id" },
          { name: "CF-Access-Client-Secret", value: "fixture-secret" },
        ],
      }],
    } });
  }, modelEndpoint);

  const article = context.pages()[0] ?? await context.newPage();
  await article.goto(`${origin}/first`);
  const tabCdp = await context.newCDPSession(article);
  const { targetInfos } = await tabCdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
  const articleTarget = targetInfos.find(({ url }) => url === article.url());
  assert.ok(articleTarget, "Article tab is available");
  const [port] = (await readFile(join(profile, "browser", "DevToolsActivePort"), "utf8")).split(/\r?\n/);
  const client = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const cdp = await client.newBrowserCDPSession();
  await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: articleTarget.targetId });

  let panelTarget;
  for (let attempt = 0; attempt < 30 && !panelTarget; attempt += 1) {
    const { targetInfos: targets } = await cdp.send("Target.getTargets", { filter: [{ type: "page" }] });
    panelTarget = targets.find(({ url }) => url === `chrome-extension://${extensionId}/sidepanel.html`);
    if (!panelTarget)
      await setTimeout(100);
  }
  assert.ok(panelTarget, "The toolbar action opens the native side panel");
  let { sessionId } = await cdp.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: false });
  let commandId = 0;

  async function sendPanel(method, params) {
    const id = ++commandId;
    const reply = Promise.withResolvers();
    const receive = ({ message, sessionId: source }) => {
      if (source !== sessionId)
        return;
      const answer = JSON.parse(message);
      if (answer.id === id)
        reply.resolve(answer);
    };
    cdp.on("Target.receivedMessageFromTarget", receive);
    try {
      await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) });
      const { error, result } = await Promise.race([reply.promise, setTimeout(4_000, null, { ref: false }).then(() => { throw new Error("Side panel CDP timeout"); })]);
      assert.ok(!error && !result?.exceptionDetails, JSON.stringify(error ?? result?.exceptionDetails));
      return result;
    }
    finally {
      cdp.off("Target.receivedMessageFromTarget", receive);
    }
  }

  async function evaluate(expression) {
    const { result } = await sendPanel("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    return result.value;
  }

  async function waitFor(text, scope = "body") {
    let body;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      body = await evaluate(`document.querySelector(${JSON.stringify(scope)})?.innerText`);
      if (body?.includes(text))
        return;
      await setTimeout(125);
    }
    assert.fail(`Could not find ${text} in native side panel:\n${body}`);
  }

  async function waitForAnswer(question, answer) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`Array.from(document.querySelectorAll('.chat-turn')).some((turn) =>
        turn.querySelector('h2')?.textContent === ${JSON.stringify(question)} &&
        turn.querySelector('.prose')?.textContent.includes(${JSON.stringify(answer)}))`)) {
        return;
      }
      await setTimeout(125);
    }
    assert.fail(`Could not find the answer to ${question} in the native side panel`);
  }

  async function checkNarrowLayout(view) {
    assert.equal(await evaluate(`window.innerWidth === 320 &&
      document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, `${view} fits a 320-pixel sidebar`);
  }

  async function click(text, scope = "body") {
    assert.equal(await evaluate(`(() => {
      const button = [...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') ?? item.textContent.trim()) === ${JSON.stringify(text)});
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`), true, text);
  }

  async function select(label, value) {
    const changed = await evaluate(`(() => {
      const field = [...document.querySelectorAll('select')].find((item) =>
        [...item.labels].some((associated) => associated.textContent.trim() === ${JSON.stringify(label)}));
      if (!field || field.disabled) return false;
      field.value = ${JSON.stringify(value)};
      field.dispatchEvent(new Event('change', { bubbles: true })); return true;
    })()`);
    assert.ok(changed, `Select ${label}`);
  }

  await waitFor("Reliable work queues");
  await waitFor("Include related docs");
  assert.deepEqual(await evaluate(`(() => {
    const controls = document.querySelector('.read-actions');
    const toggle = controls.querySelector('[role="checkbox"]');
    return {
      buttons: [...controls.querySelectorAll('button')].map((button) => button.textContent.trim()),
      checked: toggle?.getAttribute('aria-checked'),
    };
  })()`), { buttons: ["Learn this page"], checked: "false" }, "Docs scope is optional and shares the page action");
  await sendPanel("Emulation.setDeviceMetricsOverride", { width: 960, height: 720, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate(`(() => {
    const depth = document.querySelector('#depth').getBoundingClientRect();
    const docs = document.querySelector('.related-docs-option').getBoundingClientRect();
    const action = document.querySelector('.read-actions > button').getBoundingClientRect();
    const gap = docs.left - depth.right;
    return gap >= 0 && gap <= 24 && action.left - docs.right > gap;
  })()`), true, "The related-docs checkbox sits next to Depth in the wide reader");
  const docsCheckbox = "document.querySelector(\".read-actions [role=checkbox]\")";
  const pageOnlyStart = prompts.length;
  await click("Learn this page");
  await waitFor("Explain again");
  assert.ok(prompts.length > pageOnlyStart);
  assert.ok(prompts.slice(pageOnlyStart).every(({ system }) => !system.includes("The first page is where the reader started")));

  // Simulate Chrome granting the site's optional permission. The fixture also allows CORS.
  await evaluate(`(() => {
    window.originalPermissionsRequest = chrome.permissions.request;
    window.docsPermissionsRequested = [];
    chrome.permissions.request = async ({ origins }) => {
      window.docsPermissionsRequested.push(...origins);
      return true;
    };
  })()`);
  await evaluate(`${docsCheckbox}.click()`);
  assert.equal(await evaluate(`${docsCheckbox}.getAttribute("aria-checked")`), "true");
  await waitFor("Select Explain again to apply the new scope.");
  await click("Refresh page");
  await waitFor("Select Learn this page to apply the new scope.");
  assert.equal(await evaluate(`${docsCheckbox}.getAttribute("aria-checked")`), "true", "Refreshing the same page keeps the selected scope");
  await click("Learn this page");
  await waitFor("Documentation pages read (2)");
  await waitFor("Suggested reading path");
  await waitFor("Explain again");
  assert.deepEqual(await evaluate("window.docsPermissionsRequested"), ["http://127.0.0.1/*"]);
  assert.ok(prompts.some(({ system, prompt }) => system.includes("The first page is where the reader started") && prompt.includes(`${origin}/second`)));
  assert.ok(prompts.every(({ prompt }) => !prompt.includes(`${origin}/third`)), "The overview stays on directly linked docs");
  await evaluate(`(() => {
    const question = document.querySelector('#question');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(question, 'How do I set max_concurrency?');
    question.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click("Send question");
  await waitForAnswer("How do I set max_concurrency?", "Set the worker concurrency limit.");
  assert.ok(prompts.some(({ prompt }) => prompt.includes("Question: How do I set max_concurrency?") && prompt.includes(`${origin}/third`)));
  assert.equal(await evaluate("document.querySelector('.chat-turn a')?.getAttribute('href')"), `${origin}/third`);
  await evaluate("chrome.permissions.request = window.originalPermissionsRequest");
  await evaluate(`${docsCheckbox}.click()`);
  await waitFor("Select Explain again to apply the new scope.");
  const pendingScopeStart = prompts.length;
  await select("Depth", "technical");
  await waitFor("Select Explain again to apply the new scope.");
  assert.equal(prompts.length, pendingScopeStart, "Changing depth does not rerun the old scope");
  await evaluate(`(() => {
    const question = document.querySelector('#question');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(question, 'Could this still use related docs?');
    question.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(await evaluate("document.querySelector(\".composer button[type=submit]\").disabled"), true);
  await evaluate(`(() => {
    const question = document.querySelector('#question');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(question, '');
    question.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click("Explain again");
  await waitFor("Explain again");
  assert.equal(await evaluate("document.body.innerText.includes(\"Documentation pages read\")"), false);
  const storageProtected = await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find(item => item.url === url);
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        try {
          return !(await chrome.storage.local.get("models")).models;
        }
        catch {
          return true;
        }
      },
    });
    return probe.result;
  }, article.url());
  assert.equal(storageProtected, true, "Code injected into the webpage cannot read model profiles");
  await sendPanel("Emulation.setDeviceMetricsOverride", { width: 320, height: 720, deviceScaleFactor: 1, mobile: false });
  await checkNarrowLayout("Read");
  assert.equal(await evaluate(`(() => {
    const question = document.querySelector('#question');
    const form = question.form;
    const send = form.querySelector('button[type="submit"]');
    const style = getComputedStyle(question);
    question.focus();
    return send.disabled && !send.textContent.trim() && Boolean(send.querySelector('svg')) &&
      question.clientHeight <= Math.ceil(parseFloat(style.lineHeight)) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) &&
      send.getBoundingClientRect().left >= question.getBoundingClientRect().right &&
      getComputedStyle(form).outlineStyle === 'solid';
  })()`), true, "The empty composer fits one line with an inline icon-only Send button");
  await evaluate(`(() => {
    const question = document.querySelector('#question');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(question, 'Always use TypeScript examples.');
    question.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click("Send question");
  await waitFor("Acknowledgments let a broker track");
  assert.equal(authorizationHeaders.at(-1), "Bearer fixture-key", "The stored key is used for the loopback model");
  assert.deepEqual(serviceTokens.at(-1), ["fixture-id", "fixture-secret"], "The worker sends the saved Cloudflare headers");
  await checkNarrowLayout("Read with a reply");
  await sendPanel("Emulation.setDeviceMetricsOverride", { width: 1130, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(await evaluate(`(() => {
    const turn = document.querySelector('.chat-turn');
    const question = turn.querySelector('.chat-message-user');
    const reply = turn.querySelector('.chat-message-assistant');
    if (!question || !reply) return null;
    return {
      roles: [...turn.querySelectorAll('.chat-message-label')].map(label => label.textContent.trim()),
      distinctBackgrounds: getComputedStyle(question).backgroundColor !== getComputedStyle(reply).backgroundColor,
      questionAlignedRight: question.getBoundingClientRect().left > reply.getBoundingClientRect().left,
    };
  })()`), { roles: ["You", "AI"], distinctBackgrounds: true, questionAlignedRight: true }, "Questions and replies are labeled and visually distinct");
  const readingLayout = await evaluate(`(async () => {
    const paragraph = document.querySelector('.chat-turn .prose p');
    const style = getComputedStyle(paragraph);
    const fonts = await document.fonts.load(style.fontSize + ' ' + style.fontFamily, paragraph.textContent);
    return {
      fontSize: parseFloat(style.fontSize),
      fontLoaded: fonts.some((font) => font.family.includes('Atkinson Hyperlegible Next') && font.status === 'loaded'),
      cardWidth: paragraph.closest('.chat-turn').getBoundingClientRect().width,
      lineWidth: paragraph.getBoundingClientRect().width,
      composerWidth: document.querySelector('.composer form').getBoundingClientRect().width,
    };
  })()`);
  assert.ok(readingLayout.fontSize >= 17 && readingLayout.fontLoaded, `Use the larger, bundled reading font: ${JSON.stringify(readingLayout)}`);
  assert.ok(readingLayout.cardWidth >= 900, "Reading cards grow on a wide sidebar");
  assert.ok(readingLayout.lineWidth < readingLayout.cardWidth - 100, "Prose keeps a readable line length on a wide sidebar");
  assert.ok(Math.abs(readingLayout.composerWidth - readingLayout.cardWidth) < 1, "The composer aligns with the reading cards");
  await sendPanel("Emulation.setDeviceMetricsOverride", { width: 320, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitFor("Explain again");
  await setTimeout(400);
  await click("Simpler", ".chat-turn");
  await waitFor("A broker checks whether the worker finished the job.", ".chat-turn");
  assert.match(prompts.at(-1).prompt, /Previous answer:.*Acknowledgments let a broker track/);
  await click("More detail", ".chat-turn");
  await waitFor("Could not revise this answer.");
  await waitFor("A broker checks whether the worker finished the job.", ".chat-turn");
  await click("Memory");
  assert.equal(await evaluate("document.body.innerText.includes('Use plain language and keep explanations concise')"), false);
  await click("Read");
  await click("Remember this style", ".chat-turn");
  await waitFor("Saved to Memory.");
  await click("Show an example", ".learning-section.intro");
  await waitFor("For example, a worker sends an acknowledgment after sending an email.", ".learning-section.intro");
  await checkNarrowLayout("Read with answer controls");
  await click("History");
  await waitFor("Reliable work queues");
  await evaluate("document.querySelectorAll('[aria-labelledby=history-heading] details').forEach(detail => { detail.open = true; })");
  await waitFor("A broker checks whether the worker finished the job.", "[aria-labelledby=history-heading]");
  await click("Memory");
  await waitFor("Use plain language and keep explanations concise within the selected depth.");
  await waitFor("Why this was saved");
  await checkNarrowLayout("Memory");
  assert.equal(await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Why this was saved');
    if (!trigger || trigger.getAttribute('aria-expanded') !== 'false') return false;
    trigger.focus();
    if (!trigger.matches(':focus-visible') || getComputedStyle(trigger).boxShadow === 'none') return false;
    trigger.click();
    return true;
  })()`), true, "The evidence control is keyboard focusable and starts collapsed");
  await waitFor("Always use TypeScript examples.");
  await select("Preference type", "intent");
  await click("Save preference");
  await waitFor("Preference saved.");
  await click("Read");

  await article.goto(`${origin}/second`);
  await click("Refresh page");
  await waitFor("Queue acknowledgments");
  await click("Learn this page");
  await waitFor("What happens if a worker crashes before acknowledging a job?");
  assert.ok(prompts.some(({ system, prompt }) => system.includes("TypeScript") && prompt.includes("Queue acknowledgments")));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate("Boolean(document.querySelector(\".diagram img\")?.naturalWidth)"))
      break;
    await setTimeout(125);
  }
  assert.equal(await evaluate("Boolean(document.querySelector(\".diagram img\")?.naturalWidth)"), true, `The model flowchart renders under MV3:\n${await evaluate("document.body.innerText")}`);
  await click("Memory");
  await waitFor("Why this was saved");
  assert.equal(await evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((item) => item.textContent.trim() === 'Use learning memory');
    if (!label?.control || label.control.disabled) return false;
    label.click();
    return true;
  })()`), true, "The memory control has an associated label");
  await waitFor("Memory is paused.");
  await click("Read");
  const count = prompts.length;
  await click("Explain again");
  await waitFor("Copy as Mermaid");
  assert.ok(prompts.length > count);
  assert.ok(prompts.slice(count).every(({ system }) => !system.includes("TypeScript")));
  assert.equal(await evaluate("document.querySelectorAll(\".suggestions button\").length"), 0);
  await click("Memory");
  await click("Clear memory");
  await waitFor("Clear all saved preferences, questions, and supporting evidence?");
  await click("Cancel");
  await waitFor("Why this was saved");
  assert.equal(await evaluate(`(() => {
    const record = [...document.querySelectorAll('.memory-records li')].find((item) => item.querySelector('strong')?.textContent.includes('TypeScript'));
    const edit = [...record?.querySelectorAll('button') ?? []].find((button) => button.textContent.trim() === 'Edit');
    if (!edit) return false;
    edit.click();
    return true;
  })()`), true, "The learned language preference can be edited");
  await waitFor("Edit memory");
  await select("Preference", "python");
  await click("Save preference");
  await waitFor("Preference saved.");
  assert.equal(await evaluate(`[...document.querySelectorAll('.memory-records strong')].some((item) => item.textContent.includes('Python'))`), true, "The updated language is shown in the saved memory list");
  await click("Clear memory");
  await click("Clear all");
  await waitFor("No saved preferences yet.");
  await click("Settings");
  await waitFor("Appearance");
  await waitFor("Model settings");
  await checkNarrowLayout("Settings");
  assert.equal(await evaluate("document.querySelector('dialog[open]') === null"), true, "Profile fields start outside the settings flow");
  await click("Add profile");
  assert.equal(await evaluate("document.querySelector('dialog[open] #profile-name') !== null"), true, "Profile creation opens a modal");
  await checkNarrowLayout("Profile editor");
  assert.deepEqual(await evaluate(`['profile-name', 'model-id'].map((id) => document.getElementById(id).value)`), ["", ""]);
  await select("Provider", "anthropic");
  assert.equal(await evaluate("document.querySelector(\"#base-url\") === null"), true, "Hosted profiles hide the base URL field");
  await evaluate(`(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const id of ['profile-name', 'model-id']) {
      const field = document.getElementById(id);
      set.call(field, 'new-fixture');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await click("Save profile");
  await waitFor("Enter an API key for this provider.");
  await click("Cancel");
  assert.equal(await evaluate("document.querySelector('dialog[open]') === null"), true, "Cancel closes the profile modal");
  await click("Edit Fixture");
  await waitFor("Base URL");
  assert.equal(await evaluate("document.querySelector(\"#profile-name\").value"), "Fixture");
  await waitFor("Key saved");
  assert.equal(await evaluate("document.querySelector(\"#header-value-1\").value"), "");
  await evaluate(`(() => {
    const label = document.querySelector('#profile-name');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(label, 'Updated fixture');
    label.dispatchEvent(new Event('input', { bubbles: true }));
    const field = document.querySelector('#header-value-1');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'rotated-fixture-secret');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click("Save changes");
  await waitFor("Profile saved.");
  assert.equal(await evaluate("document.querySelector('dialog[open]') === null"), true, "Saving closes the editor");
  await click("Edit Updated fixture");
  assert.equal(await evaluate("document.querySelector('#profile-name').value"), "Updated fixture", "The saved profile is editable");
  assert.equal(await evaluate("document.querySelector(\"#header-value-1\").value"), "");
  await click("Cancel");
  await select("Theme", "dark");
  await select("Font", "serif");
  async function enterTextSize(value) {
    await evaluate(`(() => {
      const input = document.querySelector('#appearance-size');
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  }
  await enterTextSize("23");
  assert.deepEqual(await evaluate(`(() => {
    const style = getComputedStyle(document.body);
    return { theme: style.colorScheme, font: style.fontFamily.split(',')[0], size: style.fontSize };
  })()`), { theme: "dark", font: "Georgia", size: "23px" });
  await enterTextSize("99");
  assert.equal(await evaluate(`document.querySelector('#appearance-size').getAttribute('aria-invalid')`), "true");
  assert.equal(await evaluate("getComputedStyle(document.body).fontSize"), "23px");
  await evaluate(`document.querySelector('#appearance-size').blur()`);
  assert.equal(await evaluate(`document.querySelector('#appearance-size').value`), "23");
  await checkNarrowLayout("Settings with custom text size");
  await select("Theme", "system");
  for (const value of ["light", "dark"]) {
    await sendPanel("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    let applied;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      applied = await evaluate("getComputedStyle(document.body).colorScheme");
      if (applied === value)
        break;
      await setTimeout(50);
    }
    assert.equal(applied, value, "The sidebar reacts to system theme changes");
  }
  await select("Theme", "dark");

  await click("Read");
  await waitFor("Copy as Mermaid");
  assert.equal(await evaluate("document.querySelector('#question').matches('textarea')"), true, "The follow-up field accepts multiple lines");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#question')).fontSize"), "23px");
  await evaluate(`(() => {
    const input = document.querySelector('#question');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'What does the broker track?');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click("Send question");
  await waitForAnswer("What does the broker track?", "Acknowledgments let a broker track");
  await waitForAnswer("What does the broker track?", "Job finished");
  assert.deepEqual(await evaluate(`[...document.querySelectorAll(".chat-turn table th, .chat-turn table td")]
    .map(cell => cell.textContent)`), ["Item", "Meaning", "ACK", "Job finished"], "Markdown reply tables render as header and body cells");
  await checkNarrowLayout("Read with a reply table");
  assert.deepEqual(serviceTokens.at(-1), ["fixture-id", "rotated-fixture-secret"], "Replacing a header leaves other credentials intact");
  const draft = "Draft follows the reader\nwith more context";
  await evaluate(`(() => {
    const input = document.querySelector('#question');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(draft)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(await evaluate(`(() => {
    const question = document.querySelector('#question');
    const style = getComputedStyle(question);
    return question.clientHeight > parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  })()`), true, "The composer grows for multiline drafts");
  const [floating] = await Promise.all([
    context.waitForEvent("page", { timeout: 10_000 }),
    click("Open floating window"),
  ]);
  await floating.getByRole("heading", { name: "Queue acknowledgments" }).waitFor();
  await floating.getByText("Copy as Mermaid").waitFor();
  await floating.getByRole("heading", { name: "What does the broker track?" }).waitFor();
  assert.equal(await floating.locator("#question").inputValue(), draft);
  assert.equal(await floating.evaluate(async () => (await chrome.windows.getCurrent()).type), "popup");
  assert.equal(await floating.evaluate(() => getComputedStyle(document.body).colorScheme), "dark");
  const sidebarUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  const targets = () => cdp.send("Target.getTargets", { filter: [{ type: "page" }] });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await targets()).targetInfos.some(({ url }) => url === sidebarUrl))
      break;
    await setTimeout(100);
  }
  assert.ok(!(await targets()).targetInfos.some(({ url }) => url === sidebarUrl), "Undocking closes the native side panel");
  await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: articleTarget.targetId });
  await setTimeout(250);
  assert.ok(!(await targets()).targetInfos.some(({ url }) => url === sidebarUrl), "The toolbar reuses the floating reader");
  await Promise.all([
    floating.waitForEvent("close", { timeout: 10_000 }),
    floating.getByRole("button", { name: "Dock to sidebar" }).click(),
  ]);
  panelTarget = (await targets()).targetInfos.find(({ url }) => url === sidebarUrl);
  assert.ok(panelTarget, "Docking reopens the native side panel");
  ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: false }));
  await waitFor("Copy as Mermaid");
  await waitForAnswer("What does the broker track?", "Acknowledgments let a broker track");
  assert.equal(await evaluate("document.querySelector('#question').value"), draft);

  const { sameHostTab, otherHostTab } = await worker.evaluate(async (origin) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const sameHost = await chrome.tabs.create({ windowId: tab.windowId, active: false, url: `${origin}/first` });
    const otherHost = await chrome.tabs.create({ windowId: tab.windowId, active: false, url: `${origin.replace("127.0.0.1", "localhost")}/third` });
    return { sameHostTab: sameHost.id, otherHostTab: otherHost.id };
  }, origin);
  const activate = tabId => worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
  const articleTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, article.url());
  await activate(sameHostTab);
  await setTimeout(300);
  await waitForAnswer("What does the broker track?", "Acknowledgments let a broker track");
  await activate(otherHostTab);
  await waitForAnswer("What does the broker track?", "Acknowledgments let a broker track");
  await activate(articleTab);
  await article.goto(`${origin}/guides/first`);
  await waitForAnswer("What does the broker track?", "Acknowledgments let a broker track");
  await waitFor("Queue acknowledgments");
  assert.equal(await evaluate("document.querySelector('#question').value"), draft);
  const [floatingAgain] = await Promise.all([
    context.waitForEvent("page", { timeout: 10_000 }),
    click("Open floating window"),
  ]);
  await floatingAgain.getByRole("heading", { name: "Queue acknowledgments" }).waitFor();
  await activate(otherHostTab);
  await floatingAgain.getByRole("heading", { name: "What does the broker track?" }).waitFor();
  assert.equal(await floatingAgain.locator("#question").inputValue(), draft);
  await activate(articleTab);
  await floatingAgain.getByRole("button", { name: "Refresh page", exact: true }).click();
  await floatingAgain.getByRole("heading", { name: "Reliable work queues" }).waitFor();
  assert.equal(await floatingAgain.getByRole("heading", { name: "What does the broker track?" }).count(), 0);
  await activate(otherHostTab);
  await floatingAgain.getByRole("heading", { name: "Queue rate limits" }).waitFor();
  await activate(articleTab);
  await floatingAgain.getByRole("heading", { name: "Reliable work queues" }).waitFor();
  await Promise.all([
    floatingAgain.waitForEvent("close", { timeout: 10_000 }),
    floatingAgain.getByRole("button", { name: "Dock to sidebar" }).click(),
  ]);
  panelTarget = (await targets()).targetInfos.find(({ url }) => url === sidebarUrl);
  assert.ok(panelTarget, "Docking reopens the native side panel");
  ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: false }));
  await waitFor("Reliable work queues");
  await activate(otherHostTab);
  await waitFor("Queue rate limits");

  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await reopened.getByRole("button", { name: "Settings" }).click();
  await reopened.getByRole("button", { name: "Edit Updated fixture", exact: true }).click();
  await reopened.getByText("Key saved", { exact: true }).waitFor();
  assert.equal(await reopened.locator("#api-key").inputValue(), "", "The saved key is absent from the form");
  assert.equal(await reopened.locator("#header-name-1").inputValue(), "CF-Access-Client-Secret");
  assert.equal(await reopened.locator("#header-value-1").inputValue(), "", "The saved service token is absent from the form");
  await reopened.keyboard.press("Escape");
  await reopened.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await reopened.getByRole("button", { name: "Edit Updated fixture", exact: true }).evaluate(button => button === document.activeElement), true, "Escape returns focus to the Edit button");
  assert.deepEqual(await Promise.all(["Theme", "Font", "Text size (px)", "Explanation model", "System 1 model"].map(label => reopened.getByLabel(label, { exact: true }).inputValue())), ["dark", "serif", "23", "fixture", "fixture"]);
  await reopened.getByRole("button", { name: "History", exact: true }).click();
  await reopened.locator("summary").filter({ hasText: "Queue acknowledgments" }).click();
  await reopened.getByRole("heading", { name: "What does the broker track?" }).waitFor();
  const savedTurn = reopened.locator(".chat-turn").filter({ has: reopened.getByRole("heading", { name: "What does the broker track?" }) });
  assert.deepEqual(await savedTurn.locator(".chat-message-label").allTextContents(), ["You", "AI"], "Saved turns keep the speaker labels");
  assert.deepEqual(await reopened.getByRole("table").getByRole("cell").allTextContents(), ["ACK", "Job finished"], "Saved replies retain their Markdown tables");
  await reopened.getByRole("button", { name: "Clear history", exact: true }).click();
  await reopened.getByRole("button", { name: "Clear all", exact: true }).click();
  await reopened.getByText("No saved conversations yet.").waitFor();
  await reopened.getByRole("button", { name: "Settings" }).click();
  await reopened.getByRole("button", { name: "Add profile", exact: true }).click();
  await reopened.getByLabel("Profile name", { exact: true }).fill("Exact chat fixture");
  await reopened.getByLabel("Base URL", { exact: true }).fill("https://previous.example.test/v1");
  await reopened.locator("#api-key").fill("draft-key");
  await reopened.getByLabel("Chat endpoint URL (optional)", { exact: true }).fill(`${modelEndpoint}/chat/completions`);
  assert.equal(await reopened.locator("#api-key").inputValue(), "", "Draft credentials are cleared when the destination changes");
  await reopened.getByLabel("Base URL", { exact: true }).fill("");
  assert.equal(await reopened.getByLabel("Base URL", { exact: true }).getAttribute("required"), null);
  await reopened.getByLabel("Model ID", { exact: true }).fill("fixture");
  await reopened.getByRole("button", { name: "Save profile", exact: true }).click();
  await reopened.getByRole("dialog").waitFor({ state: "hidden" });
  await reopened.getByRole("button", { name: "Edit Exact chat fixture", exact: true }).click();
  assert.equal(await reopened.getByLabel("Chat endpoint URL (optional)", { exact: true }).inputValue(), `${modelEndpoint}/chat/completions`);
  await reopened.keyboard.press("Escape");
  await reopened.getByRole("button", { name: "Add profile", exact: true }).click();
  await reopened.getByLabel("Provider", { exact: true }).selectOption({ label: "OpenAI" });
  await reopened.getByLabel("Type", { exact: true }).selectOption({ label: "Decision" });
  assert.equal(await reopened.getByLabel("Decision endpoint URL", { exact: true }).count(), 0);
  await reopened.getByLabel("Provider", { exact: true }).selectOption({ label: "FreeLLM" });
  assert.equal(await reopened.getByLabel("Type", { exact: true }).inputValue(), "decision");
  await reopened.getByLabel("Profile name", { exact: true }).fill("Decision fixture");
  await reopened.getByLabel("Decision endpoint URL", { exact: true }).fill(`${modelEndpoint}/decisions`);
  assert.equal(await reopened.getByLabel("Model ID", { exact: true }).inputValue(), "auto");
  await reopened.getByRole("button", { name: "Save profile", exact: true }).click();
  await reopened.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await reopened.getByLabel("Explanation model", { exact: true }).getByRole("option", { name: "Decision fixture" }).count(), 0);
  await reopened.getByLabel("System 1 model", { exact: true }).selectOption({ label: "Decision fixture" });
  await reopened.locator("#system-model:enabled").waitFor();
  assert.equal(await reopened.locator("#system-model option:checked").textContent(), "Decision fixture");
  await reopened.close();

  await context.route(repoHome, route => route.fulfill({ contentType: "text/html", body: "<title>Public repository fixture</title>" }));
  await article.goto(repoHome);
  await activate(articleTab);
  await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: articleTarget.targetId });
  panelTarget = undefined;
  for (let attempt = 0; attempt < 40 && !panelTarget; attempt += 1) {
    panelTarget = (await targets()).targetInfos.find(({ url }) => url === sidebarUrl);
    if (!panelTarget)
      await setTimeout(100);
  }
  assert.ok(panelTarget, "The toolbar opens the sidebar for a GitHub repository");
  ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: false }));
  await sendPanel("Emulation.setDeviceMetricsOverride", { width: 320, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitFor("Learn this repo");
  await evaluate(`(() => {
    const api = 'https://api.github.com/repos/example/fixture-reader';
    const commit = ${JSON.stringify(repoCommit)};
    const tree = 'b'.repeat(40);
    const realFetch = globalThis.fetch;
    chrome.permissions.request = async ({ origins }) => {
      if (origins.join() !== 'https://api.github.com/*') throw new Error('Unexpected permissions request');
      return true;
    };
    globalThis.fetch = async (url, options) => {
      if (url === api) return Response.json({ default_branch: 'main' });
      if (url === api + '/commits/main') return Response.json({ sha: commit, commit: { tree: { sha: tree } } });
      if (url === api + '/git/trees/' + tree + '?recursive=1') return Response.json({ truncated: false, tree: [{ path: 'src/index.ts', type: 'blob', mode: '100644', size: 43 }] });
      if (url === api + '/contents/src/index.ts?ref=' + commit) return new Response('startReader renders the fixture architecture');
      return realFetch(url, options);
    };
  })()`);
  await click("Learn this repo");
  await waitFor("Files inspected (1)");
  await waitFor("Explain again");
  assert.ok(prompts.some(({ prompt }) => prompt.includes("startReader") && prompt.includes(repoFile)), "The overview receives the inspected code and commit link");
  assert.equal(await evaluate(`document.querySelector('.learning-section .prose a')?.href`), repoFile);
  assert.equal(await evaluate(`Boolean(document.querySelector('.learning-section a[href="https://example.org/invented"]'))`), false);
  await checkNarrowLayout("Repo Mode");
  await evaluate(`(() => {
    const question = document.querySelector('#question');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(question, 'Where is startReader called?');
    question.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click("Send question");
  await waitForAnswer("Where is startReader called?", "Fixture architecture uses");
  assert.ok(prompts.some(({ prompt }) => prompt.includes("Question: Where is startReader called?") && prompt.includes(repoFile)));
  await client.close();
  console.log("Browser smoke passed: reader windows, appearance, settings, page and docs scopes, chat, memory, diagrams, and GitHub Repo Mode.");
}
finally {
  await context?.close();
  server.close();
  const absolute = resolve(profile);
  if (absolute.startsWith(join(testRoot, "chromium-smoke-")))
    await rm(absolute, { recursive: true, force: true });
}
