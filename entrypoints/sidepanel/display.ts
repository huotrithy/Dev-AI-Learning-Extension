import { findFloatingReader, floatingReaderUrl, readerSourceWindowParam } from "../../src/learning/reader-window.ts";
import { snapshotReader, type ReaderSnapshot } from "./reader.ts";

export type View = "read" | "history" | "memory" | "settings";
type Handoff = { id: string; expires: number; reader: ReaderSnapshot; view: View };

const source = new URLSearchParams(location.search).get(readerSourceWindowParam);
export const floatingSource = source && /^\d+$/.test(source) ? Number(source) : undefined;
export const floating = floatingSource !== undefined;

function handoffKey(windowId: number, toFloating: boolean): string {
  return `readerHandoff:${windowId}:${toFloating ? "floating" : "sidebar"}`;
}

export function watchHandoff(windowId: number, receive: (handoff?: Handoff) => void): () => void {
  const key = handoffKey(windowId, floating);
  let active = true;
  let received: string | undefined;
  function accept(handoff?: Handoff) {
    if (!active || !handoff || handoff.expires < Date.now() || handoff.id === received)
      return false;
    received = handoff.id;
    receive(handoff);
    void chrome.storage.session.remove(key).catch(() => undefined);
    return true;
  }
  const changed: Parameters<typeof chrome.storage.session.onChanged.addListener>[0] = (changes) => {
    accept(changes[key]?.newValue as Handoff | undefined);
  };
  chrome.storage.session.onChanged.addListener(changed);
  void chrome.storage.session.get<Record<string, Handoff>>(key).then((items) => {
    if (!accept(items[key]) && active && !received)
      receive();
  }).catch(() => {
    if (active && !received)
      receive();
  });
  return () => {
    active = false;
    chrome.storage.session.onChanged.removeListener(changed);
  };
}

export async function switchReaderWindow(windowId: number, view: View): Promise<string> {
  const key = handoffKey(windowId, !floating);
  const handoff: Handoff = { id: crypto.randomUUID(), expires: Date.now() + 60_000, reader: snapshotReader(), view };

  if (floating) {
    await chrome.sidePanel.open({ windowId });
    await chrome.storage.session.set({ [key]: handoff });
    await chrome.windows.update(windowId, { focused: true }).catch(() => undefined);
    window.close();
    return "";
  }

  const existing = await findFloatingReader(windowId);
  await chrome.storage.session.set({ [key]: handoff });
  try {
    if (existing !== undefined)
      await chrome.windows.update(existing, { focused: true });
    else await chrome.windows.create({ url: floatingReaderUrl(windowId), type: "popup", width: 850, height: 750, focused: true });
  }
  catch (error) {
    await chrome.storage.session.remove(key).catch(() => undefined);
    throw error;
  }
  try {
    await chrome.sidePanel.close({ windowId });
    return "";
  }
  catch {
    return "The reader is open in a floating window. You can close this sidebar with the browser’s close button.";
  }
}
