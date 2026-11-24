import assert from 'node:assert/strict';
import test from 'node:test';
import { applyModelSettingsCommand, publicModelSettings } from '../src/models/settings-worker.ts';
import { createProfile, type ModelSettings } from '../src/models/profiles.ts';

const headerName = 'CF-Access-Client-Secret';
const profile = {
  ...createProfile(), id: 'saved', label: 'Fixture', model: 'fixture',
  endpoint: 'https://example.test/v1', key: 'fixture-key',
  customHeaders: [{ name: headerName, value: 'fixture-secret' }],
};
const stored: ModelSettings = { profiles: [profile], main: profile.id, system: profile.id };

test('model settings expose only credential status and custom header names', () => {
  const [visible] = publicModelSettings(stored).profiles;
  assert.ok(visible);
  assert.equal(visible.keySaved, true);
  assert.deepEqual(visible.headerNames, ['CF-Access-Client-Secret']);
  assert.equal(JSON.stringify(visible).includes('fixture-key'), false);
  assert.equal(JSON.stringify(visible).includes('fixture-secret'), false);
});

test('profile edits preserve, replace, or remove credentials explicitly', () => {
  const [visible] = publicModelSettings(stored).profiles;
  assert.ok(visible);
  const edit = (customHeaders: ({ name: string; savedIndex: number } | { name: string; value: string })[], key?: string) => {
    const [updated] = applyModelSettingsCommand(stored, { type: 'save-profile', profile: { ...visible, model: 'updated', key, customHeaders } }).profiles;
    assert.ok(updated);
    return updated;
  };
  assert.equal(edit([{ name: headerName, savedIndex: 0 }]).key, profile.key);
  assert.deepEqual(edit([{ name: headerName, savedIndex: 0 }]).customHeaders, profile.customHeaders);
  assert.deepEqual(edit([{ name: headerName, value: 'replacement' }], '').customHeaders, [{ name: headerName, value: 'replacement' }]);
  assert.equal(edit([], '').key, '');
  assert.deepEqual(edit([]).customHeaders, []);
});

test('saved credentials cannot be reused when the profile destination changes', () => {
  const [visible] = publicModelSettings(stored).profiles;
  assert.ok(visible);
  const updated = { ...visible, endpoint: 'https://example.test/another-server' };
  assert.throws(() => applyModelSettingsCommand(stored, {
    type: 'save-profile', profile: { ...updated, customHeaders: [{ name: headerName, savedIndex: 0 }] },
  }), /saved header/i);
  const [saved] = applyModelSettingsCommand(stored, {
    type: 'save-profile', profile: { ...updated, customHeaders: [] },
  }).profiles;
  assert.ok(saved);
  assert.equal(saved.key, '');
});

test('a stale profile editor cannot overwrite credentials saved in another reader', () => {
  const [visible] = publicModelSettings(stored).profiles;
  assert.ok(visible);
  const updated = applyModelSettingsCommand(stored, {
    type: 'save-profile', profile: { ...visible, customHeaders: [{ name: headerName, value: 'new-token' }] },
  });
  assert.throws(() => applyModelSettingsCommand(updated, {
    type: 'save-profile', profile: { ...visible, label: 'Renamed', customHeaders: [] },
  }), /profile changed/i);
});
