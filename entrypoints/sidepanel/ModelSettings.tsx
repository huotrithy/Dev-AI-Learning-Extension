import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/src/components/ui/alert';
import { Button } from '@/src/components/ui/button';
import { Card } from '@/src/components/ui/card';
import { Checkbox } from '@/src/components/ui/checkbox';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/src/components/ui/native-select';
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

  return <Card role="region" className="control-panel" aria-labelledby="models-heading">
    <h2 id="models-heading">Model settings</h2>
    {settings.profiles.length > 0 && <div className="form-grid">
      <div className="field">
        <Label htmlFor="explanation-model">Explanation model</Label>
        <NativeSelect id="explanation-model" value={settings.main} onChange={(event) => void assign('main', event.target.value)}>
          {settings.profiles.map(({ id, label }) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <div className="field">
        <Label htmlFor="system-model">System 1 model</Label>
        <NativeSelect id="system-model" value={settings.system} onChange={(event) => void assign('system', event.target.value)}>
          {settings.profiles.map(({ id, label }) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <div className="field">
        <Label htmlFor="edit-profile">Edit profile</Label>
        <NativeSelect id="edit-profile" value={settings.profiles.some(({ id }) => id === profile.id) ? profile.id : 'new'} onChange={(event) => {
          setProfile(settings.profiles.find(({ id }) => id === event.target.value) ?? createProfile());
          setError('');
          setNotice('');
        }}>
          {settings.profiles.map(({ id, label }) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
          <NativeSelectOption value="new">New profile</NativeSelectOption>
        </NativeSelect>
      </div>
    </div>}
    <form className="form-grid" onSubmit={(event) => void save(event)}>
      <div className="field">
        <Label htmlFor="profile-name">Profile name</Label>
        <Input id="profile-name" required value={profile.label} onChange={(event) => change('label', event.target.value)} />
      </div>
      <div className="field">
        <Label htmlFor="provider">Provider</Label>
        <NativeSelect id="provider" value={profile.provider} onChange={(event) => change('provider', event.target.value as Provider)}>
          {Object.entries(providers).map(([id, label]) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      {profile.provider === 'compatible' && <div className="field">
        <Label htmlFor="base-url">Base URL</Label>
        <Input id="base-url" required type="url" placeholder="http://localhost:8080/v1" value={profile.endpoint} onChange={(event) => change('endpoint', event.target.value)} />
      </div>}
      <div className="field">
        <Label htmlFor="model-id">Model ID</Label>
        <Input id="model-id" required value={profile.model} onChange={(event) => change('model', event.target.value)} />
      </div>
      <div className="field">
        <Label htmlFor="api-key">API key{profile.provider === 'compatible' ? ' (optional)' : ''}</Label>
        <Input id="api-key" type="password" autoComplete="off" value={profile.key} onChange={(event) => change('key', event.target.value)} />
      </div>
      <div className="checkbox-row">
        <Checkbox id="tool-calls" checked={profile.toolCalls} onCheckedChange={(checked) => change('toolCalls', checked)} />
        <Label htmlFor="tool-calls">Support forced tool calls</Label>
      </div>
      {profile.provider === 'compatible' && <div className="checkbox-row">
        <Checkbox id="disable-thinking" checked={profile.disableThinking} onCheckedChange={(checked) => change('disableThinking', checked)} />
        <Label htmlFor="disable-thinking">Disable thinking (MLX)</Label>
      </div>}
      <p className="muted">This profile sends model requests and its API key to <strong>{destination}</strong>. Requests can include page text, questions, and relevant memories.</p>
      <div className="button-row">
        <Button type="submit" disabled={saving}>Save profile</Button>
        {settings.profiles.some(({ id }) => id === profile.id) && <Button type="button" variant="ghost" onClick={() => void remove()}>Remove</Button>}
      </div>
    </form>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert>}
  </Card>;
}
