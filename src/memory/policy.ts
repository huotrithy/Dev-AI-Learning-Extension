import type { PageSource } from '../page/extract.ts';
import type { MemoryContext, MemoryRecord, Observation } from './types.ts';

const names: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', go: 'Go',
  rust: 'Rust', java: 'Java', csharp: 'C#', sql: 'SQL', shell: 'Shell',
};

export function choiceLabel(kind: Observation['kind'], value: string): string {
  if (kind === 'example-language') return `Use ${names[value] ?? value} examples where relevant.`;
  if (kind === 'example-placement') return value === 'example first'
    ? 'Start the opening explanation with a concrete example.'
    : 'Start by explaining the concept, then give an example.';
  if (kind === 'depth') return value === 'concise'
    ? 'Favor concise explanations within the selected depth.'
    : 'Give concrete detail within the selected depth.';
  return value;
}

export function memoryId(observation: Observation): string {
  const value = observation.explicit && observation.kind !== 'intent' ? '' : observation.value;
  return JSON.stringify([observation.scope, observation.kind, observation.explicit, value]);
}

export function isDurable(record: MemoryRecord): boolean {
  return record.explicit || new Set(record.evidence.map(({ sessionId }) => sessionId)).size >= 2;
}

export function recallRecords(records: MemoryRecord[], scope: string): MemoryContext {
  const eligible = records.filter((record) => (record.scope === 'global' || record.scope === scope) && isDurable(record));
  eligible.sort((left, right) => Number(right.explicit) - Number(left.explicit)
    || Number(right.scope === scope) - Number(left.scope === scope)
    || right.evidence.length - left.evidence.length
    || right.updatedAt - left.updatedAt);
  const preferences = new Map<string, string>();
  const intents = new Set<string>();
  for (const record of eligible) {
    if (record.kind === 'intent') intents.add(record.value);
    else if (!preferences.has(record.kind)) preferences.set(record.kind, choiceLabel(record.kind, record.value));
  }
  return { prompt: [...preferences.values()].join(' ').slice(0, 600), intents: [...intents].slice(0, 3) };
}

const topics: [string, RegExp][] = [
  ['distributed systems', /\b(queues?|consensus|raft|kafka|distributed|idempotenc\w*|replication)\b/i],
  ['databases', /\b(databases?|sql|postgres\w*|mysql|indexes|transactions?)\b/i],
  ['machine learning', /\b(transformers?|embeddings?|neural|machine learning|llm|attention mechanism)\b/i],
  ['web development', /\b(react|typescript|javascript|css|dom|browser|frontend)\b/i],
  ['infrastructure', /\b(kubernetes|docker|terraform|deployments?|containers?)\b/i],
];

export function pageScope(page: PageSource): string {
  const header = `${page.title} ${new URL(page.url).pathname}`;
  const match = topics.find(([, pattern]) => pattern.test(header))
    ?? topics.find(([, pattern]) => pattern.test(page.text.slice(0, 1_000)));
  return match?.[0] ?? new URL(page.url).hostname;
}
