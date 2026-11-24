export type Provider = 'compatible' | 'openai' | 'anthropic';

export interface ModelHeader {
  name: string;
  value: string;
}

export interface ModelProfileDetails {
  id: string;
  label: string;
  provider: Provider;
  model: string;
  endpoint: string;
  toolCalls: boolean;
  disableThinking: boolean;
}

export interface ModelProfile extends ModelProfileDetails {
  key: string;
  customHeaders?: ModelHeader[];
  revision?: string;
}

export interface PublicModelProfile extends ModelProfileDetails {
  keySaved: boolean;
  headerNames: string[];
  revision: string;
}

export interface PublicModelSettings {
  profiles: PublicModelProfile[];
  main: string;
  system: string;
}

export interface ModelSettings {
  profiles: ModelProfile[];
  main: string;
  system: string;
}

export const defaultSettings = { profiles: [], main: '', system: '' };

export function createProfileDetails(): ModelProfileDetails {
  return {
    id: crypto.randomUUID(),
    label: '',
    provider: 'compatible',
    model: '',
    endpoint: '',
    toolCalls: false,
    disableThinking: false,
  };
}

export function createProfile(): ModelProfile {
  return { ...createProfileDetails(), key: '' };
}

export function modelEndpoint(profile: ModelProfileDetails): URL {
  if (profile.provider === 'openai') return new URL('https://api.openai.com/v1');
  if (profile.provider === 'anthropic') return new URL('https://api.anthropic.com/v1');
  const endpoint = new URL(profile.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Enter an HTTP or HTTPS base URL without credentials, a query, or a fragment.');
  }
  return endpoint;
}

export function hostPermission(endpoint: URL): string {
  return `${endpoint.protocol}//${endpoint.hostname}/*`;
}

function isRemoteHttp(endpoint: URL): boolean {
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  return endpoint.protocol === 'http:' && !loopback;
}

export function modelHeaders(profile: ModelProfile): Headers {
  if (profile.customHeaders?.length && isRemoteHttp(modelEndpoint(profile))) {
    throw new Error('Use HTTPS to send custom headers to a model endpoint outside this computer.');
  }
  const headers = new Headers();
  for (const [index, header] of (profile.customHeaders ?? []).entries()) {
    const name = header.name.trim();
    try {
      headers.append(name, header.value);
    } catch {
      throw new Error(`Enter a valid HTTP header name and value for header ${index + 1}.`);
    }
  }
  return headers;
}

export class InsecureModelEndpointError extends Error {
  constructor() {
    super('Use HTTPS to send an API key to a model endpoint outside this computer.');
  }
}

export function modelRequestEndpoint(profile: ModelProfile): URL {
  const endpoint = modelEndpoint(profile);
  if (profile.key && isRemoteHttp(endpoint)) throw new InsecureModelEndpointError();
  return endpoint;
}

export function restrictModelStorage(): Promise<void> {
  return chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function loadSettings(): Promise<ModelSettings> {
  await restrictModelStorage();
  const stored = await chrome.storage.local.get<{ models?: ModelSettings }>('models');
  return stored.models ?? defaultSettings;
}

export async function saveSettings(settings: ModelSettings): Promise<void> {
  await restrictModelStorage();
  await chrome.storage.local.set({ models: settings });
}
