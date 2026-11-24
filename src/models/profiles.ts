export type Provider = 'compatible' | 'openai' | 'anthropic';

export interface ModelHeader {
  name: string;
  value: string;
}

export interface ModelProfile {
  id: string;
  label: string;
  provider: Provider;
  model: string;
  endpoint: string;
  key: string;
  customHeaders?: ModelHeader[];
  toolCalls: boolean;
  disableThinking: boolean;
}

export interface ModelSettings {
  profiles: ModelProfile[];
  main: string;
  system: string;
}

export const defaultSettings: ModelSettings = { profiles: [], main: '', system: '' };

export function createProfile(): ModelProfile {
  return {
    id: crypto.randomUUID(),
    label: 'Local Qwen',
    provider: 'compatible',
    model: 'mlx-community/Qwen3.5-4B-MLX-4bit',
    endpoint: '',
    key: '',
    toolCalls: true,
    disableThinking: true,
  };
}

export function modelEndpoint(profile: ModelProfile): URL {
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

export async function loadSettings(): Promise<ModelSettings> {
  const stored = await chrome.storage.local.get<{ models?: ModelSettings }>('models');
  return stored.models ?? defaultSettings;
}

export async function saveSettings(settings: ModelSettings): Promise<void> {
  await chrome.storage.local.set({ models: settings });
}
