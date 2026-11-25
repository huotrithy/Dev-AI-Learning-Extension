import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { Dexie } from "dexie";
import { ChatHistory, historyRetentionDays } from "../src/learning/history.ts";
import { createProfile } from "../src/models/profiles.ts";

const page = { title: "Queues", url: "https://example.test/queues?token=secret#example" };
const turn = { id: "first", question: "How do queues work?", answer: "They buffer work." };
const day = 24 * 60 * 60 * 1_000;

test("history is durable, groups turns by session, and drops URL queries and fragments", async () => {
  const name = crypto.randomUUID();
  const timestamp = Date.now();
  const history = new ChatHistory(name);
  const revision = await history.revision();
  await history.save(revision, "session-a", page, turn, { timestamp });
  await history.save(revision, "session-b", page, turn, { timestamp: timestamp + 1 });
  await history.save(revision, "session-a", page, { ...turn, id: "second" }, { timestamp: timestamp + 2 });

  const records = await new ChatHistory(name).list(timestamp + 2);
  assert.deepEqual(records.map(({ id, url, turns }) => [id, url, turns.map(({ id }) => id)]), [
    ["session-a", "https://example.test/queues", ["first", "second"]],
    ["session-b", "https://example.test/queues", ["first"]],
  ]);
});

test("each saved reply expires independently and can be purged", async () => {
  const history = new ChatHistory(crypto.randomUUID());
  const now = Date.now();
  const old = now - historyRetentionDays * day;
  const revision = await history.revision();
  await history.save(revision, "session", page, turn, { timestamp: old });
  await history.save(revision, "session", page, { ...turn, id: "new" }, { timestamp: old + 1 });
  assert.deepEqual((await history.list(now))[0]?.turns.map(({ id }) => id), ["new"]);
  await history.prune(now);
  assert.deepEqual((await history.list(old + 1))[0]?.turns.map(({ id }) => id), ["new"]);
});

test("video history preserves the watch ID and removes playlist and tracking data", async () => {
  const history = new ChatHistory(crypto.randomUUID());
  await history.save(await history.revision(), "video", {
    title: "Worker tutorial",
    url: "https://www.youtube.com/watch?v=abcdefghijk&t=30s&list=private#extra",
  }, turn);
  assert.equal((await history.list())[0]?.url, "https://www.youtube.com/watch?v=abcdefghijk");
});

test("clearing history prevents in-flight replies from restoring it and allows new replies", async () => {
  const name = crypto.randomUUID();
  const history = new ChatHistory(name);
  const revision = await history.revision();
  await history.save(revision, "session", page, turn);
  await new ChatHistory(name).clear();
  await history.save(revision, "session", page, { ...turn, id: "stale" });
  assert.deepEqual(await history.list(), []);
  await history.save(await history.revision(), "session", page, { ...turn, id: "new" });
  assert.deepEqual((await history.list())[0]?.turns.map(({ id }) => id), ["new"]);
});

test("resuming history restores the original source and surviving turns", async () => {
  const name = crypto.randomUUID();
  const now = Date.now();
  const previousVersion = new Dexie(name);
  previousVersion.version(1).stores({ turns: "[session+id], timestamp", settings: "id" });
  await previousVersion.table("turns").put({ ...turn, title: page.title, url: "https://example.test/queues", session: "older", timestamp: now });
  previousVersion.close();

  const history = new ChatHistory(name);
  const revision = await history.revision();
  const sourcePage = { ...page, text: "Queue workers confirm finished jobs." };
  const reader = {
    depth: "technical" as const,
    sections: { intro: "Queues coordinate independent workers." },
  };
  await history.save(revision, "resumable", sourcePage, turn, { timestamp: now, reader });
  const second = { ...turn, id: "second", answer: "The broker retries." };
  await history.save(revision, "resumable", sourcePage, second, { timestamp: now + day, reader });

  const reopened = new ChatHistory(name);
  assert.deepEqual((await reopened.list(now + day)).map(({ id, canResume }) => [id, canResume]), [
    ["resumable", true],
    ["older", false],
  ]);
  assert.equal(await reopened.resume("older", now + day), undefined);
  const resumed = await reopened.resume("resumable", now + historyRetentionDays * day);
  assert.deepEqual(resumed, {
    id: "resumable",
    source: { ...reader, page: { ...sourcePage, url: "https://example.test/queues" } },
    turns: [second],
  });
  await reopened.prune(now + (historyRetentionDays + 1) * day);
  await reopened.save(revision, "resumable", page, turn, { timestamp: now });
  assert.equal(await reopened.resume("resumable", now), undefined);
});

test("clearing history also deletes saved source snapshots", async () => {
  const history = new ChatHistory(crypto.randomUUID());
  const revision = await history.revision();
  await history.save(revision, "session", { ...page, text: "Saved article." }, turn, { reader: { depth: "new", sections: {} } });
  await history.clear();
  // A turn without a source must not expose a snapshot from before the clear.
  await history.save(await history.revision(), "session", page, turn);
  assert.equal(await history.resume("session"), undefined);
});

test("new model profiles start with generic fields and optional capabilities off", () => {
  const { label, model, endpoint, key, toolCalls, disableThinking } = createProfile();
  assert.deepEqual({ label, model, endpoint, key, toolCalls, disableThinking }, {
    label: "",
    model: "",
    endpoint: "",
    key: "",
    toolCalls: false,
    disableThinking: false,
  });
});
