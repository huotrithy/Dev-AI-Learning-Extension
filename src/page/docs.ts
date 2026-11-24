import { extractPage, type PageSource } from './extract.ts';

const maxPages = 4;
const maxBytes = 1_000_000;
const maxTitleCharacters = 200;
const maxExcerptCharacters = 3_600;
const sequentialLinkWeight = 4;
const sameSectionLinkWeight = 2;

export type DocsPage = Pick<PageSource, 'title' | 'url' | 'text'>;

export function docsPageUrl(address: string): string {
  const url = new URL(address);
  return `${url.origin}${url.pathname}`;
}

export function docsReferences(page: PageSource): Pick<DocsPage, 'title' | 'url'>[] | undefined {
  return page.docs && [page, ...page.docs].map(({ title, url }) => ({ title, url: docsPageUrl(url) }));
}

function resolveUrl(href: string, base: URL): URL | undefined {
  try {
    return new URL(href, base);
  } catch {
    return;
  }
}

function relatedUrl(href: string, current: URL, base = current): string | undefined {
  if (!href) return;
  const url = resolveUrl(href, base);
  if (!url || !/^https?:$/.test(url.protocol) || url.origin !== current.origin ||
    url.username || url.password || url.search || /^\/?$/.test(url.pathname) ||
    url.pathname.replace(/\/$/, '') === current.pathname.replace(/\/$/, '')) return;
  const extension = url.pathname.match(/\.([a-z\d]+)$/i)?.[1];
  if (extension && !/^(?:html?|mdx?)$/i.test(extension)) return;
  return docsPageUrl(url.href);
}

export function docsLinks(document: Document, address: string): string[] {
  const current = new URL(address);
  const base = resolveUrl(document.querySelector('base[href]')?.getAttribute('href') ?? '', current) ?? current;
  const section = current.pathname.split('/')[1];
  const links = new Map<string, number>();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (anchor.closest('header, footer, form, [hidden]')) continue;
    const url = relatedUrl(anchor.getAttribute('href') ?? '', current, base);
    if (!url) continue;
    const score = (anchor.matches('[rel~="next"], [rel~="prev"]') ? sequentialLinkWeight : 0) +
      (new URL(url).pathname.split('/')[1] === section ? sameSectionLinkWeight : 0) +
      Number(Boolean(anchor.closest('main, article, [role="main"]')));
    if (score) links.set(url, Math.max(links.get(url) ?? 0, score));
  }
  return [...links].sort((a, b) => b[1] - a[1]).slice(0, maxPages).map(([url]) => url);
}

async function readHtml(response: Response): Promise<string | undefined> {
  if (!response.body) return;
  if (!response.ok || !/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body.cancel();
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return html + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return;
      }
      html += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function loadDocs(
  page: PageSource, signal: AbortSignal, parser: DOMParser, fetcher: typeof fetch = fetch,
): Promise<DocsPage[]> {
  signal.throwIfAborted();
  const current = new URL(page.url);
  const urls = [...new Set((page.relatedLinks ?? []).flatMap((href) => relatedUrl(href, current) ?? []))].slice(0, maxPages);
  const sources = await Promise.all(urls.map(async (url) => {
    try {
      const response = await fetcher(url, {
        credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      });
      const html = await readHtml(response);
      if (!html) return;
      const document = parser.parseFromString('', 'text/html');
      const template = document.createElement('template');
      template.innerHTML = html;
      document.title = template.content.querySelector('title')?.textContent?.trim().slice(0, maxTitleCharacters) || new URL(url).pathname;
      template.content.querySelectorAll('title, base, script, style, link, meta, img, iframe, picture, audio, video, object, embed, source, svg').forEach((node) => node.remove());
      document.body.append(template.content);
      const source = extractPage(document);
      if (source) return { title: source.title, url, text: source.text.slice(0, maxExcerptCharacters) };
    } catch {
      signal.throwIfAborted();
    }
  }));
  signal.throwIfAborted();
  return sources.filter((source) => source !== undefined);
}
