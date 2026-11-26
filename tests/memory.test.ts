import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { DexieMemoryRepository } from "../src/memory/repository.ts";
import type { Observation } from "../src/memory/types.ts";

const language: Observation = { kind: "example-language", value: "typescript", scope: "global", explicit: true };
const failures: Observation = { kind: "intent", value: "failure modes", scope: "distributed systems", explicit: false };

async function observe(repo: DexieMemoryRepository, turnId: string, sessionId: string, ...observations: Observation[]) {
  await repo.observe({
    turnId,
    sessionId,
    observations,
    revision: (await repo.status()).revision,
    evidence: "A user-authored request",
    observedAt: Date.now(),
  });
}

test("recalls an explicit preference from a second repository instance", async () => {
  const name = crypto.randomUUID();
  await observe(new DexieMemoryRepository(name), "1", "a", language);
  const recalled = await new DexieMemoryRepository(name).recall("distributed systems");
  assert.match(recalled.prompt, /TypeScript/);
});

test("retries and repeated signals in one session do not promote a pattern", async () => {
  const repo = new DexieMemoryRepository(crypto.randomUUID());
  await observe(repo, "1", "a", failures);
  await observe(repo, "1", "a", failures);
  await observe(repo, "2", "a", failures);
  assert.deepEqual((await repo.recall("distributed systems")).intents, []);

  await observe(repo, "3", "b", failures);
  assert.deepEqual((await repo.recall("distributed systems")).intents, ["failure modes"]);
  assert.deepEqual((await repo.recall("databases")).intents, []);
});

test("explicit preferences override a recurring conflicting preference", async () => {
  const repo = new DexieMemoryRepository(crypto.randomUUID());
  const python: Observation = { ...language, value: "python", explicit: false };
  await observe(repo, "1", "a", python);
  await observe(repo, "2", "b", python);
  await observe(repo, "3", "b", language);
  const recalled = await repo.recall("databases");
  assert.match(recalled.prompt, /TypeScript/);
  assert.doesNotMatch(recalled.prompt, /Python/);
});

test("pausing, deleting, or clearing invalidates an in-flight observation", async () => {
  const repo = new DexieMemoryRepository(crypto.randomUUID());
  await observe(repo, "1", "a", language);
  const [record] = await repo.list();
  assert.ok(record);
  const revision = (await repo.status()).revision;
  await repo.remove(record.id);
  await repo.observe({ revision, sessionId: "b", turnId: "2", evidence: "Always use TypeScript", observations: [language], observedAt: Date.now() });
  assert.deepEqual(await repo.list(), []);

  await observe(repo, "3", "c", language);
  await repo.setEnabled(false);
  assert.equal((await repo.recall("databases")).prompt, "");
  const pausedRevision = (await repo.status()).revision;
  await repo.clear();
  await repo.setEnabled(true);
  await repo.observe({ revision: pausedRevision, sessionId: "d", turnId: "4", evidence: "Always use TypeScript", observations: [language], observedAt: Date.now() });
  assert.deepEqual(await repo.list(), []);
});

test("an older explicit instruction cannot replace a newer one that finished first", async () => {
  const repo = new DexieMemoryRepository(crypto.randomUUID());
  const { revision } = await repo.status();
  await repo.observe({ revision, sessionId: "a", turnId: "2", evidence: "Use TypeScript", observations: [language], observedAt: 200 });
  await repo.observe({ revision, sessionId: "a", turnId: "1", evidence: "Use Python", observations: [{ ...language, value: "python" }], observedAt: 100 });
  assert.match((await repo.recall("databases")).prompt, /TypeScript/);
});

test("reports the evidence behind a promoted preference", async () => {
  const repo = new DexieMemoryRepository(crypto.randomUUID());
  await observe(repo, "1", "a", language);
  const [record] = await repo.list();
  assert.ok(record);
  assert.equal(record.explicit, true);
  assert.deepEqual(record.evidence.map(({ text }) => text), ["A user-authored request"]);
});
