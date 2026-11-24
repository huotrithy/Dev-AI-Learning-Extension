import { extractPage, type PageSource } from './extract.ts';

export async function readTab(tabId: number): Promise<PageSource> {
  let snapshot;
  try {
    [snapshot] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const copy = document.documentElement.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('script, style, link, img, iframe, picture, audio, video, object, embed').forEach((node) => node.remove());
        return { markup: copy.outerHTML.slice(0, 2_000_000), url: location.href };
      },
    });
  } catch {
    throw new Error('Open a web page and click the extension icon on that tab to grant access.');
  }
  if (!snapshot?.result || !/^https?:/.test(snapshot.result.url)) {
    throw new Error('Open an HTTP or HTTPS article to learn from it.');
  }

  const parser = new DOMParser();
  const copy = parser.parseFromString(snapshot.result.markup, 'text/html');
  const source = extractPage(copy);
  if (!source) throw new Error('There is too little readable text on this page.');
  return { ...source, url: snapshot.result.url, title: source.title || new URL(snapshot.result.url).hostname };
}
