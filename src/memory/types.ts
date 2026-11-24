import { z } from 'zod';

export const options = {
  'example-language': ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp', 'sql', 'shell'],
  'example-placement': ['example first', 'concept first'],
  depth: ['concise', 'detailed'],
  intent: ['failure modes', 'trade-offs', 'implementation', 'real-world use', 'performance', 'comparison', 'prerequisites'],
} as const;

export const choiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('example-language'), value: z.enum(options['example-language']) }),
  z.object({ kind: z.literal('example-placement'), value: z.enum(options['example-placement']) }),
  z.object({ kind: z.literal('depth'), value: z.enum(options.depth) }),
  z.object({ kind: z.literal('intent'), value: z.enum(options.intent) }),
]);

export type Choice = z.infer<typeof choiceSchema>;
export type Observation = Choice & { scope: string; explicit: boolean };

export interface Evidence { sessionId: string; turnId: string; text: string }
export type MemoryRecord = Observation & { id: string; evidence: Evidence[]; updatedAt: number };

export interface ObservationBatch {
  sessionId: string;
  turnId: string;
  revision: number;
  observedAt: number;
  evidence: string;
  observations: Observation[];
}

export interface MemoryContext {
  prompt: string;
  intents: string[];
}

export interface MemoryStatus { enabled: boolean; revision: number }

export interface MemoryRepository {
  status(): Promise<MemoryStatus>;
  recall(scope: string): Promise<MemoryContext>;
  observe(batch: ObservationBatch): Promise<void>;
  list(): Promise<MemoryRecord[]>;
  update(observation: Choice & { scope: string }, replaceId?: string): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
}

export const emptyMemory: MemoryContext = { prompt: '', intents: [] };
