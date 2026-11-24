import { useState, type FormEvent } from 'react';
import {
  createProfile, hostPermission, modelEndpoint, saveSettings, type ModelProfile, type ModelSettings as Settings,
  type Provider,
} from '../../src/models/profiles.ts';

const providers: Record<Provider, string> = {
  compatible: 'OpenAI-compatible (local or hosted)', openai: 'OpenAI', anthropic: 'Anthropic',
};

export function ModelSettings({ settings, onSave }: { settings: Settings; onSave: (settings: Settings) => void }) {
  const [profile, setProfile] = useState(() => settings.profiles.find(({ id }) => id === settings.main) ?? createProfile());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  function change<K extends keyof ModelProfile>(key: K, value: ModelProfile[K]) {
    setProfile((current) => {
      const next = { ...current, [key]: value };
      if (key === 'provider' && value !== current.provider) next.key = '';
      if (key === 'endpoint' && value !== current.endpoint && settings.profiles.some(({ id }) => id === current.id)) next.key = '';
      return next;
    });
    setError('');
    setNotice('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    setSaving(true);
    try {
      const candidate = { ...profile, label: profile.label.trim(), model: profile.model.trim(), endpoint: profile.endpoint.trim(), key: profile.key.trim() };
      if (!candidate.label || !candidate.model) throw new Error('Enter a profile name and a model ID.');
      if (candidate.provider !== 'compatible' && !candidate.key) throw new Error('Enter an API key for this provider.');
      const endpoint = modelEndpoint(candidate);
      const granted = await chrome.permissions.request({ origins: [hostPermission(endpoint)] });
      if (!granted) throw new Error('Allow access to the model endpoint to save this profile.');
      const existing = settings.profiles.some(({ id }) => id === candidate.id);
      const profiles = existing
        ? settings.profiles.map((item) => item.id === candidate.id ? candidate : item)
        : [...settings.profiles, candidate];
      const next = { profiles, main: settings.main || candidate.id, system: settings.system || candidate.id };
      await saveSettings(next);
      setProfile(candidate);
      onSave(next);
      setNotice('Profile saved.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not save the profile.');
    } finally {
      setSaving(false);
    }
  }

  async function assign(role: 'main' | 'system', id: string) {
    const next = { ...settings, [role]: id };
    try {
      await saveSettings(next);
      onSave(next);
    } catch {
      setError('Could not save the model assignment.');
    }
  }

  async function remove() {
    const profiles = settings.profiles.filter(({ id }) => id !== profile.id);
    const fallback = profiles[0]?.id ?? '';
    const next = { profiles, main: settings.main === profile.id ? fallback : settings.main, system: settings.system === profile.id ? fallback : settings.system };
    try {
      await saveSettings(next);
      onSave(next);
      setProfile(profiles[0] ?? createProfile());
      setNotice('Profile removed.');
    } catch {
      setError('Could not remove the profile.');
    }
  }

  let destination = 'your configured endpoint';
  try { destination = modelEndpoint(profile).origin; } catch { /* A URL is validated on save. */ }

  return <section className="control-panel" aria-labelledby="models-heading">
    <h2 id="models-heading">Model settings</h2>
    {settings.profiles.length > 0 && <div className="form-grid">
      <label>Explanation model<select value={settings.main} onChange={(event) => void assign('main', event.target.value)}>
        {settings.profiles.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <label>System 1 model<select value={settings.system} onChange={(event) => void assign('system', event.target.value)}>
        {settings.profiles.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <label>Edit profile<select value={settings.profiles.some(({ id }) => id === profile.id) ? profile.id : 'new'} onChange={(event) => {
        setProfile(settings.profiles.find(({ id }) => id === event.target.value) ?? createProfile());
        setError('');
        setNotice('');
      }}>
        {settings.profiles.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        <option value="new">New profile</option>
      </select></label>
    </div>}
    <form className="form-grid" onSubmit={(event) => void save(event)}>
      <label>Profile name<input required value={profile.label} onChange={(event) => change('label', event.target.value)} /></label>
      <label>Provider<select value={profile.provider} onChange={(event) => change('provider', event.target.value as Provider)}>
        {Object.entries(providers).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      {profile.provider === 'compatible' && <label>Base URL<input required type="url" placeholder="http://localhost:8080/v1" value={profile.endpoint} onChange={(event) => change('endpoint', event.target.value)} /></label>}
      <label>Model ID<input required value={profile.model} onChange={(event) => change('model', event.target.value)} /></label>
      <label>API key{profile.provider === 'compatible' ? ' (optional)' : ''}<input type="password" autoComplete="off" value={profile.key} onChange={(event) => change('key', event.target.value)} /></label>
      <label className="checkbox"><input type="checkbox" checked={profile.toolCalls} onChange={(event) => change('toolCalls', event.target.checked)} /> Support forced tool calls</label>
      {profile.provider === 'compatible' && <label className="checkbox"><input type="checkbox" checked={profile.disableThinking} onChange={(event) => change('disableThinking', event.target.checked)} /> Disable thinking (MLX)</label>}
      <p className="muted">This profile sends model requests and its API key to <strong>{destination}</strong>. Requests can include page text, questions, and relevant memories.</p>
      <div className="button-row">
        <button type="submit" className="primary" disabled={saving}>Save profile</button>
        {settings.profiles.some(({ id }) => id === profile.id) && <button type="button" className="text-button" onClick={() => void remove()}>Remove</button>}
      </div>
    </form>
    {error && <p role="alert" className="status error">{error}</p>}
    {notice && <p role="status" className="status">{notice}</p>}
  </section>;
}
