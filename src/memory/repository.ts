import { Dexie, type Table } from "dexie";
import { isDurable, memoryId, recallRecords } from "./policy.ts";
import {
  choiceSchema,
  emptyMemory,
  type Choice,
  type MemoryContext,
  type MemoryRecord,
  type MemoryRepository,
  type MemoryStatus,
  type Observation,
  type ObservationBatch,
} from "./types.ts";

type SettingsRow = MemoryStatus & { id: "settings" };
const defaultStatus: MemoryStatus = { enabled: true, revision: 0 };

export async function runWithCurrentMemory<T>(
  repository: Pick<MemoryRepository, "status">,
  revision: number,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const current = await repository.status();
  if (!current.enabled || revision !== current.revision)
    return undefined;
  return run();
}

export class DexieMemoryRepository implements MemoryRepository {
  private db: Dexie;
  private records: Table<MemoryRecord, string>;
  private receipts: Table<{ id: string }, string>;
  private settings: Table<SettingsRow, "settings">;

  constructor(name = "developer-learning-memory") {
    this.db = new Dexie(name);
    this.db.version(1).stores({ records: "id, scope", receipts: "id", settings: "id" });
    this.records = this.db.table("records");
    this.receipts = this.db.table("receipts");
    this.settings = this.db.table("settings");
  }

  async status(): Promise<MemoryStatus> {
    const row = await this.settings.get("settings");
    return row ? { enabled: row.enabled, revision: row.revision } : defaultStatus;
  }

  async recall(scope: string): Promise<MemoryContext> {
    return this.db.transaction("r", this.records, this.settings, async () => {
      if (!(await this.status()).enabled)
        return emptyMemory;
      const records = await this.records.where("scope").anyOf(["global", scope]).toArray();
      return recallRecords(records, scope);
    });
  }

  async observe(batch: ObservationBatch): Promise<void> {
    if (!batch.observations.length || !batch.evidence.trim())
      return;
    const receipt = JSON.stringify([batch.sessionId, batch.turnId]);
    await this.db.transaction("rw", this.records, this.receipts, this.settings, async () => {
      const status = await this.status();
      if (!status.enabled || status.revision !== batch.revision || await this.receipts.get(receipt))
        return;
      for (const observation of batch.observations) {
        const choice = choiceSchema.safeParse(observation);
        if (!choice.success || !observation.scope || observation.scope.length > 255)
          continue;
        const id = memoryId(observation);
        const previous = await this.records.get(id);
        if (observation.explicit && previous && previous.updatedAt > batch.observedAt)
          continue;
        const evidence = { sessionId: batch.sessionId, turnId: batch.turnId, text: batch.evidence.trim().slice(0, 240) };
        const priorEvidence = previous?.value === observation.value ? previous.evidence : [];
        const evidenceBySession = priorEvidence.filter(({ sessionId }) => sessionId !== batch.sessionId);
        const record: MemoryRecord = {
          ...observation,
          id,
          updatedAt: Math.max(previous?.updatedAt ?? 0, batch.observedAt),
          evidence: [...evidenceBySession, evidence].slice(-8),
        };
        await this.records.put(record);
      }
      await this.receipts.put({ id: receipt });
    });
  }

  async list(): Promise<MemoryRecord[]> {
    const records = await this.records.toArray();
    return records.filter(isDurable).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async update(choice: Choice & { scope: string }, replaceId?: string): Promise<void> {
    await this.change(async () => {
      const observation: Observation = { ...choice, explicit: true };
      const id = memoryId(observation);
      if (replaceId && replaceId !== id)
        await this.records.delete(replaceId);
      await this.records.put({ ...observation, id, updatedAt: Date.now(), evidence: [] });
    });
  }

  async remove(id: string): Promise<void> {
    await this.change(async () => {
      const removed = await this.records.get(id);
      if (!removed)
        return;
      // Remove supporting candidates for the same preference in this scope.
      await this.records.where("scope").equals(removed.scope).filter(record =>
        record.kind === removed.kind && (record.kind !== "intent" || record.value === removed.value),
      ).delete();
    });
  }

  async clear(): Promise<void> {
    await this.change(async () => {
      await this.records.clear();
      await this.receipts.clear();
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.change(async () => undefined, enabled);
  }

  private async change(mutate: () => Promise<void>, enabled?: boolean): Promise<void> {
    await this.db.transaction("rw", this.records, this.receipts, this.settings, async () => {
      const status = await this.status();
      await mutate();
      await this.settings.put({ id: "settings", enabled: enabled ?? status.enabled, revision: status.revision + 1 });
    });
  }
}
