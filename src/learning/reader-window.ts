export const readerPath = 'sidepanel.html';
export const readerSourceWindowParam = 'sourceWindow';
export const pageAccessGranted = 'page-access-granted';

export function floatingReaderUrl(windowId: number): string {
  return chrome.runtime.getURL(`${readerPath}?${readerSourceWindowParam}=${windowId}`);
}

export async function findFloatingReader(windowId: number): Promise<number | undefined> {
  const contexts = await chrome.runtime.getContexts({ documentUrls: [floatingReaderUrl(windowId)] });
  return contexts.find((context) => context.windowId >= 0)?.windowId;
}
