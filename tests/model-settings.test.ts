import assert from "node:assert/strict";
import test from "node:test";
import { applyModelSettingsCommand, publicModelSettings } from "../src/models/settings-worker.ts";
import { createProfile, type ModelSettings } from "../src/models/profiles.ts";

const headerName = "CF-Access-Client-Secret";
const profile = {
  ...createProfile(),
  id: "saved",
  label: "Fixture",
  model: "fixture",
  endpoint: "https://example.test/v1",
  key: "fixture-key",
  customHeaders: [{ name: headerName, value: "fixture-secret" }],
};
const stored: ModelSettings = { profiles: [profile], main: profile.id, system: profile.id };

test("model settings expose only credential status and custom header names", () => {
  const [visible] = publicModelSettings(stored).profiles;
  assert.ok(visible);
  assert.equal(visible.keySaved, true);
  assert.deepEqual(visible.headerNames, ["CF-Access-Client-Secret"]);
  assert.equal(JSON.stringify(visible).includes("fixture-key"), false);
  assert.equal(JSON.stringify(visible).includes("fixture-secret"), false);
});

test("profile edits preserve, replace, or remove credentials explicitly", () => {
  const [visible] = publicModelSettings(stored).profiles;
  assert.ok(visible);
  const edit = (customHeaders: ({ name: string; savedIndex: number } | { name: string; value: string })[], key?: string) => {
    const [updated] = applyModelSettingsCommand(stored, { type: "save-profile", profile: { ...visible, model: "updated", key, customHeaders } }).profiles;
    assert.ok(updated);
    return updated;
  };
  assert.equal(edit([{ name: headerName, savedIndex: 0 }]).key, profile.key);
  assert.deepEqual(edit([{ name: headerName, savedIndex: 0 }]).customHeaders, profile.customHeaders);
  assert.deepEqual(edit([{ name: headerName, value: "replacement" }], "").customHeaders, [{ name: headerName, value: "replacement" }]);
  assert.equal(edit([], "").key, "");
  assert.deepEqual(edit([]).customHeaders, []);
});

test("saved credentials cannot be reused when the profile destination changes", () => {
  const [visible] = publicModelSettings(stored).profiles;
  assert.ok(visible);
  const updated = { ...visible, endpoint: "https://example.test/another-server" };
  assert.throws(() => applyModelSettingsCommand(stored, {
    type: "save-profile",
    profile: { ...updated, customHeaders: [{ name: headerName, savedIndex: 0 }] },
  }), /saved header/i);
  const [saved] = applyModelSettingsCommand(stored, {
    type: "save-profile",
    profile: { ...updated, customHeaders: [] },
  }).profiles;
  assert.ok(saved);
  assert.equal(saved.key, "");
});

test("a stale profile editor cannot overwrite credentials saved in another reader", () => {
  const [visible] = publicModelSettings(stored).profiles;
  assert.ok(visible);
  const updated = applyModelSettingsCommand(stored, {
    type: "save-profile",
    profile: { ...visible, customHeaders: [{ name: headerName, value: "new-token" }] },
  });
  assert.throws(() => applyModelSettingsCommand(updated, {
    type: "save-profile",
    profile: { ...visible, label: "Renamed", customHeaders: [] },
  }), /profile changed/i);
});

void test("an exact chat URL change requires fresh credentials", () => {
  const [visible] = publicModelSettings(stored).profiles;
  assert.ok(visible);
  const updated = { ...visible, chatEndpoint: "https://example.test/custom/chat" };
  assert.throws(() => applyModelSettingsCommand(stored, {
    type: "save-profile",
    profile: { ...updated, customHeaders: [{ name: headerName, savedIndex: 0 }] },
  }), /saved header/i);
  const [saved] = applyModelSettingsCommand(stored, {
    type: "save-profile",
    profile: { ...updated, customHeaders: [] },
  }).profiles;
  assert.ok(saved);
  assert.equal(saved.key, "");
  assert.equal(saved.chatEndpoint, updated.chatEndpoint);
});

void test("a decision profile cannot become the explanation model", () => {
  const decision = { ...createProfile(), id: "decision", label: "Decision", provider: "freellm-decisions" as const, model: "auto", endpoint: "https://example.test/v1/decisions" };
  const settings = applyModelSettingsCommand(stored, { type: "save-profile", profile: { ...decision, customHeaders: [] } });
  assert.throws(() => applyModelSettingsCommand(settings, { type: "assign-profile", role: "main", id: decision.id }), /select a chat profile/i);
  const assigned = applyModelSettingsCommand(settings, { type: "assign-profile", role: "system", id: decision.id });
  const remaining = applyModelSettingsCommand(assigned, { type: "remove-profile", id: profile.id, revision: "legacy" });
  assert.equal(remaining.main, "");
  assert.equal(remaining.system, decision.id);
});

void test("an OpenAI decision profile keeps its credentials and can be assigned to System 1", () => {
  const openAi = { ...profile, provider: "openai" as const };
  const settings = { ...stored, profiles: [openAi] };
  const [visible] = publicModelSettings(settings).profiles;
  assert.ok(visible);
  const updated = applyModelSettingsCommand(settings, {
    type: "save-profile",
    profile: { ...visible, type: "decision", customHeaders: [{ name: headerName, savedIndex: 0 }] },
  });
  assert.equal(publicModelSettings(updated).profiles[0]?.type, "decision");
  const [saved] = updated.profiles;
  assert.ok(saved);
  assert.equal(saved.key, openAi.key);
  assert.deepEqual(saved.customHeaders, openAi.customHeaders);
  assert.equal(updated.main, "");
  assert.equal(applyModelSettingsCommand(updated, { type: "assign-profile", role: "system", id: openAi.id }).system, openAi.id);
  assert.throws(() => applyModelSettingsCommand(updated, { type: "assign-profile", role: "main", id: openAi.id }), /select a chat profile/i);
});

void test("a compatible profile cannot save FreeLLM's decision endpoint as a chat destination", () => {
  const chat = { ...createProfile(), label: "Chat", model: "auto", endpoint: "https://example.test/v1", customHeaders: [] };
  for (const destination of [
    { ...chat, chatEndpoint: `${chat.endpoint}/decisions` },
    { ...chat, endpoint: `${chat.endpoint}/systemone/` },
  ]) {
    assert.throws(() => applyModelSettingsCommand(stored, { type: "save-profile", profile: destination }), /FreeLLM Decision API/);
  }
});

void test("an exact chat URL cannot hide credentials in a saved base URL", () => {
  const chat = { ...createProfile(), label: "Chat", model: "fixture", endpoint: "https://example.test/v1?token=fixture", chatEndpoint: "https://example.test/generate" };
  assert.throws(() => applyModelSettingsCommand(stored, {
    type: "save-profile",
    profile: { ...chat, customHeaders: [] },
  }), /without credentials, a query, or a fragment/);
});
