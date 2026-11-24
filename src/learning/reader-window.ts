const panel = 'sidepanel.html';

export function floatingReaderUrl(windowId: number): string {
  return chrome.runtime.getURL(`${panel}?sourceWindow=${windowId}`);
}

export async function findFloatingReader(windowId: number): Promise<number | undefined> {
  const contexts = await chrome.runtime.getContexts({ documentUrls: [floatingReaderUrl(windowId)] });
  return contexts.find((context) => context.windowId >= 0)?.windowId;
}
