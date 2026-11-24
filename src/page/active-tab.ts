import { extractPage, type PageSource } from './extract.ts';
import { docsLinks } from './docs.ts';
import { captureTranscript, videoSource, type YouTubeVideo } from './youtube.ts';

export async function readYouTube(tabId: number, video: YouTubeVideo): Promise<PageSource | undefined> {
  const [snapshot] = await chrome.scripting.executeScript({ target: { tabId }, func: captureTranscript }).catch(() => {
    throw new Error('Click the extension icon on the YouTube tab to grant access.');
  });
  return videoSource(video, snapshot?.result);
}

export async function seekYouTube(tabId: number, id: string, seconds: number): Promise<boolean> {
  const [seek] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [id, seconds] as const,
    func: (id, seconds) => {
      const url = new URL(location.href);
      if (!['https://www.youtube.com', 'https://youtube.com'].includes(url.origin) ||
        url.pathname !== '/watch' || url.searchParams.get('v') !== id) return false;
      const watch = document.querySelector('ytd-watch-flexy:not([hidden])');
      if (watch?.getAttribute('video-id') !== id) return false;
      const player = watch.querySelector('#movie_player:not(.ad-showing) video');
      if (!(player instanceof HTMLVideoElement) || !Number.isFinite(player.duration) ||
        !Number.isFinite(seconds) || seconds < 0 || seconds > player.duration) return false;
      player.currentTime = seconds;
      return true;
    },
  }).catch(() => []);
  return seek?.result === true;
}

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
  const { url } = snapshot.result;
  return { ...source, url, title: source.title || new URL(url).hostname, relatedLinks: docsLinks(copy, url) };
}
