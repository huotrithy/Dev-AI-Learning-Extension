import {
  hostPermission, modelEndpoint, modelHeaders, modelRequestEndpoint,
  loadSettings, saveSettings, type ModelProfile, type ModelSettings, type PublicModelSettings,
} from './profiles.ts';
import { settingsCommandSchema, type SettingsCommand, type SettingsReply } from './worker-protocol.ts';

const profileRevision = (profile: ModelProfile) => profile.revision ?? 'legacy';

export function publicModelSettings(settings: ModelSettings): PublicModelSettings {
  return {
    main: settings.main,
    system: settings.system,
    profiles: settings.profiles.map((profile) => {
      const { id, label, provider, model, endpoint, key, customHeaders, toolCalls, disableThinking } = profile;
      return {
        id, label, provider, model, endpoint, toolCalls, disableThinking, revision: profileRevision(profile),
        keySaved: Boolean(key), headerNames: (customHeaders ?? []).map(({ name }) => name),
      };
    }),
  };
}

export function applyModelSettingsCommand(settings: ModelSettings, command: Exclude<SettingsCommand, { type: 'load-settings' }>): ModelSettings {
  const { profiles, main, system } = settings;
  if (command.type === 'assign-profile') {
    if (!profiles.some(({ id }) => id === command.id)) throw new Error('This profile is no longer available.');
    return { ...settings, [command.role]: command.id };
  }
  if (command.type === 'remove-profile') {
    const removed = profiles.find(({ id }) => id === command.id);
    if (!removed || profileRevision(removed) !== command.revision) throw new Error('This profile changed. Reopen the reader and try again.');
    const remaining = profiles.filter(({ id }) => id !== command.id);
    const fallback = remaining[0]?.id ?? '';
    return { profiles: remaining, main: main === command.id ? fallback : main, system: system === command.id ? fallback : system };
  }

  const { id, label, provider, model, endpoint, toolCalls, disableThinking, key, customHeaders, revision } = command.profile;
  const existing = profiles.find((item) => item.id === id);
  if ((existing ? profileRevision(existing) : undefined) !== revision) throw new Error('This profile changed. Reopen the reader and try again.');
  const profile: ModelProfile = { id, label, provider, model, endpoint, toolCalls, disableThinking, key: '', revision: crypto.randomUUID() };
  const destination = modelEndpoint(profile).href;
  let previous: ModelProfile | undefined;
  try {
    if (existing?.provider === provider && modelEndpoint(existing).href === destination) previous = existing;
  } catch { /* Invalid older endpoints cannot retain credentials. */ }

  profile.key = key ?? previous?.key ?? '';
  profile.customHeaders = customHeaders.map((header) => {
    if ('value' in header) return header;
    const saved = previous?.customHeaders?.[header.savedIndex];
    if (!saved || saved.name !== header.name) throw new Error('A saved header changed. Reopen this profile and enter the header value again.');
    return saved;
  });
  if (!profile.label || !profile.model) throw new Error('Enter a profile name and a model ID.');
  if (provider !== 'compatible' && !profile.key && !previous) throw new Error('Enter an API key for this provider.');
  modelRequestEndpoint(profile);
  modelHeaders(profile);
  return {
    profiles: existing ? profiles.map((item) => item.id === id ? profile : item) : [...profiles, profile],
    main: main || id,
    system: system || id,
  };
}

let pending = Promise.resolve();

export function handleModelSettings(message: unknown): Promise<SettingsReply> {
  const parsed = settingsCommandSchema.safeParse(message);
  if (!parsed.success) return Promise.resolve({ error: 'Invalid model settings request.' });
  const command = parsed.data;
  const result = pending.then(async (): Promise<SettingsReply> => {
    const current = await loadSettings();
    if (command.type === 'load-settings') return { settings: publicModelSettings(current) };

    let next: ModelSettings;
    try {
      next = applyModelSettingsCommand(current, command);
    } catch (error) {
      return { error: error instanceof TypeError ? 'Enter a valid model base URL.' : (error as Error).message };
    }
    if (command.type === 'save-profile') {
      const profile = next.profiles.find(({ id }) => id === command.profile.id)!;
      if (!await chrome.permissions.contains({ origins: [hostPermission(modelEndpoint(profile))] })) {
        return { error: 'Allow access to the model endpoint to save this profile.' };
      }
    }
    await saveSettings(next);
    return { settings: publicModelSettings(next) };
  }).catch((): SettingsReply => ({ error: 'Could not access model settings.' }));
  pending = result.then(() => undefined);
  return result;
}
