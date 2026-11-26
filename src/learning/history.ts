import { Dexie, type Table } from "dexie";
import { docsPageUrl } from "../page/docs.ts";
import type { PageSource } from "../page/extract.ts";
import { youtubeVideo } from "../page/youtube.ts";
import type { RepositoryArchitecture } from "./architecture.ts";
import type { AnswerStyle } from "./answer-style.ts";
import type { Depth, Section } from "./config.ts";
import type { ChatTurn } from "./session.ts";

export const historyRetentionDays = 30;
const retention = historyRetentionDays * 24 * 60 * 60 * 1_000;

type SavedTurn = Pick<ChatTurn, "question" | "answer" | "style" | "docsReferences" | "repositoryFiles"> & { id: string };

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
  canResume: boolean;
  turns: SavedTurn[];
}

interface ReaderContext {
  depth: Depth;
  sections: Partial<Record<Section, string>>;
  introStyle?: AnswerStyle;
  architecture?: RepositoryArchitecture | null;
}

interface SavedSource extends ReaderContext {
  page: PageSource;
}

interface SourceRow {
  session: string;
  timestamp: number;
  source: SavedSource;
}

export interface ResumableConversation {
  id: string;
  source: SavedSource;
  turns: SavedTurn[];
}

function savedTurn({ id, question, answer, style, docsReferences, repositoryFiles }: SavedTurn): SavedTurn {
  return {
    id,
    question,
    answer,
    ...(style && { style }),
    ...(docsReferences && { docsReferences }),
    ...(repositoryFiles && { repositoryFiles }),
  };
}

export class ChatHistory {
  private db: Dexie;
  private turns: Table<HistoryRow>;
  private sources: Table<SourceRow, string>;
  private settings: Table<{ id: "history"; revision: number }, "history">;

  constructor(name = "developer-learning-history") {
    this.db = new Dexie(name);
    this.db
      .version(1)
      .stores({ turns: "[session+id], timestamp", settings: "id" });
    this.db
      .version(2)
      .stores({ turns: "[session+id], timestamp, session", sources: "session, timestamp" });
    this.turns = this.db.table("turns");
    this.sources = this.db.table("sources");
    this.settings = this.db.table("settings");
  }

  async revision(): Promise<number> {
    return (await this.settings.get("history"))?.revision ?? 0;
  }

  async save(
    revision: number,
    session: string,
    page: Pick<PageSource, "title" | "url"> & Partial<PageSource>,
    turn: SavedTurn,
    { timestamp = Date.now(), reader }: { timestamp?: number; reader?: ReaderContext } = {},
  ): Promise<void> {
    const { title, text, docs, docsIndex, repository, video } = page;
    const url = youtubeVideo(page.url)?.url ?? docsPageUrl(page.url);
    await this.db.transaction("rw", [this.turns, this.sources, this.settings], async () => {
      if (revision !== (await this.revision()))
        return;
      await this.prune(timestamp);
      await this.turns.put({
        ...savedTurn(turn),
        session,
        title,
        url,
        timestamp,
      });
      if (reader && text !== undefined && ((await this.sources.get(session))?.timestamp ?? -Infinity) <= timestamp) {
        await this.sources.put({
          session,
          timestamp,
          source: {
            ...reader,
            page: {
              title,
              url,
              text,
              ...(docs && { docs }),
              ...(docsIndex && { docsIndex }),
              ...(repository && { repository }),
              ...(video && { video }),
            },
          },
        });
      }
    });
  }

  async list(now = Date.now()): Promise<SavedConversation[]> {
    const cutoff = now - retention;
    const [rows, sessions] = await this.db.transaction("r", this.turns, this.sources, () => Promise.all([
      this.turns.where("timestamp").above(cutoff).toArray(),
      this.sources.where("timestamp").above(cutoff).primaryKeys(),
    ]));
    const resumable = new Set(sessions);
    const conversations = new Map<string, SavedConversation>();
    for (const row of rows) {
      const { session, title, url, timestamp } = row;
      let conversation = conversations.get(session);
      if (!conversation) {
        conversation = {
          id: session,
          title,
          url,
          updatedAt: timestamp,
          canResume: resumable.has(session),
          turns: [],
        };
        conversations.set(session, conversation);
      }
      conversation.updatedAt = timestamp;
      conversation.turns.push(savedTurn(row));
    }
    return [...conversations.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  async resume(session: string, now = Date.now()): Promise<ResumableConversation | undefined> {
    return this.db.transaction("r", this.turns, this.sources, async () => {
      const snapshot = await this.sources.get(session);
      const cutoff = now - retention;
      if (!snapshot || snapshot.timestamp <= cutoff)
        return;
      const rows = await this.turns.where("session").equals(session).filter(row => row.timestamp > cutoff).sortBy("timestamp");
      if (rows.length)
        return { id: session, source: snapshot.source, turns: rows.map(savedTurn) };
    });
  }

  async revise(revision: number, session: string, turn: SavedTurn): Promise<void> {
    await this.db.transaction("rw", this.turns, this.settings, async () => {
      if (revision === (await this.revision()))
        await this.turns.update([session, turn.id], savedTurn(turn));
    });
  }

  async prune(now = Date.now()): Promise<void> {
    const cutoff = now - retention;
    await this.db.transaction("rw", this.turns, this.sources, async () => {
      await this.turns.where("timestamp").belowOrEqual(cutoff).delete();
      await this.sources.where("timestamp").belowOrEqual(cutoff).delete();
    });
  }

  async clear(): Promise<void> {
    await this.db.transaction("rw", [this.turns, this.sources, this.settings], async () => {
      await this.settings.put({
        id: "history",
        revision: (await this.revision()) + 1,
      });
      await this.turns.clear();
      await this.sources.clear();
    });
  }
}

export const chatHistory = new ChatHistory();
