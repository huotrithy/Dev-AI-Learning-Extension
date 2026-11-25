import { Dexie, type Table } from "dexie";
import type { PageSource } from "../page/extract.ts";
import { youtubeVideo } from "../page/youtube.ts";

export const historyRetentionDays = 30;
const retention = historyRetentionDays * 24 * 60 * 60 * 1_000;

interface SavedTurn {
  id: string;
  question: string;
  answer: string;
}

interface HistoryRow extends SavedTurn {
  session: string;
  title: string;
  url: string;
  timestamp: number;
}

export interface SavedConversation {
  id: string;
  title: string;
  url: string;
  updatedAt: number;
  turns: SavedTurn[];
}

export class ChatHistory {
  private db: Dexie;
  private turns: Table<HistoryRow>;
  private settings: Table<{ id: "history"; revision: number }, "history">;

  constructor(name = "developer-learning-history") {
    this.db = new Dexie(name);
    this.db
      .version(1)
      .stores({ turns: "[session+id], timestamp", settings: "id" });
    this.turns = this.db.table("turns");
    this.settings = this.db.table("settings");
  }

  async revision(): Promise<number> {
    return (await this.settings.get("history"))?.revision ?? 0;
  }

  async save(
    revision: number,
    session: string,
    page: Pick<PageSource, "title" | "url">,
    turn: SavedTurn,
    timestamp = Date.now(),
  ): Promise<void> {
    const { origin, pathname } = new URL(page.url);
    const url = youtubeVideo(page.url)?.url ?? origin + pathname;
    const { id, question, answer } = turn;
    await this.db.transaction("rw", this.turns, this.settings, async () => {
      if (revision !== (await this.revision()))
        return;
      await this.prune(timestamp);
      await this.turns.put({
        id,
        question,
        answer,
        session,
        title: page.title,
        url,
        timestamp,
      });
    });
  }

  async list(now = Date.now()): Promise<SavedConversation[]> {
    const rows = await this.turns
      .where("timestamp")
      .above(now - retention)
      .toArray();
    const conversations = new Map<string, SavedConversation>();
    for (const {
      session,
      title,
      url,
      timestamp,
      id,
      question,
      answer,
    } of rows) {
      let conversation = conversations.get(session);
      if (!conversation) {
        conversation = {
          id: session,
          title,
          url,
          updatedAt: timestamp,
          turns: [],
        };
        conversations.set(session, conversation);
      }
      conversation.updatedAt = timestamp;
      conversation.turns.push({ id, question, answer });
    }
    return [...conversations.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  async revise(revision: number, session: string, id: string, answer: string): Promise<void> {
    await this.db.transaction("rw", this.turns, this.settings, async () => {
      if (revision === (await this.revision()))
        await this.turns.update([session, id], { answer });
    });
  }

  async prune(now = Date.now()): Promise<void> {
    await this.turns
      .where("timestamp")
      .belowOrEqual(now - retention)
      .delete();
  }

  async clear(): Promise<void> {
    await this.db.transaction("rw", this.turns, this.settings, async () => {
      await this.settings.put({
        id: "history",
        revision: (await this.revision()) + 1,
      });
      await this.turns.clear();
    });
  }
}

export const chatHistory = new ChatHistory();
