import type { PageSource } from "./extract.ts";

import { extractPage } from "./extract.ts";

const maxPages = 4;
const maxIndexedPages = 8;
const maxBytes = 1_000_000;
const maxTitleCharacters = 200;
const maxExcerptCharacters = 12_000;
const fetchTimeoutMs = 8_000;
const sequentialLinkWeight = 4;
const sameSectionLinkWeight = 2;

export type DocsPage = Pick<PageSource, "title" | "url" | "text">;
export type DocsReference = Pick<DocsPage, "title" | "url">;
type DocsCollection = { docs: DocsPage[]; docsIndex: DocsPage[] };

export function docsPageUrl(address: string): string {
  const url = new URL(address);
  return `${url.origin}${url.pathname}`;
}

export function docsReferences(page: PageSource): DocsReference[] | undefined {
  return page.docs && [page, ...page.docs].map(({ title, url }) => ({ title, url: docsPageUrl(url) }));
}

function resolveUrl(href: string, base: URL): URL | undefined {
  try {
    return new URL(href, base);
  }
  catch {
    return undefined;
  }
}

function relatedUrl(href: string, current: URL, base = current): string | undefined {
  if (!href)
    return;
  const url = resolveUrl(href, base);
  if (!url || !/^https?:$/.test(url.protocol) || url.origin !== current.origin
    || url.username || url.password || url.search || /^\/?$/.test(url.pathname)
    || url.pathname.replace(/\/$/, "") === current.pathname.replace(/\/$/, "")) {
    return;
  }
  const extension = url.pathname.match(/\.([a-z\d]+)$/i)?.[1];
  if (extension !== undefined && !/^(?:html?|mdx?)$/i.test(extension))
    return;
  return docsPageUrl(url.href);
}

export function docsLinks(
  document: Document | DocumentFragment,
  address: string,
  include: (url: string) => boolean = () => true,
): string[] {
  const current = new URL(address);
  const base = resolveUrl(document.querySelector("base[href]")?.getAttribute("href") ?? "", current) ?? current;
  const section = current.pathname.split("/")[1];
  const links = new Map<string, number>();
  for (const anchor of document.querySelectorAll("a[href]")) {
    if (anchor.closest("header, footer, form, [hidden]"))
      continue;
    const url = relatedUrl(anchor.getAttribute("href") ?? "", current, base);
    if (url === undefined || !include(url))
      continue;
    const score = (anchor.matches("[rel~=\"next\"], [rel~=\"prev\"]") ? sequentialLinkWeight : 0)
      + (new URL(url).pathname.split("/")[1] === section ? sameSectionLinkWeight : 0)
      + Number(Boolean(anchor.closest("main, article, [role=\"main\"]")));
    if (score)
      links.set(url, Math.max(links.get(url) ?? 0, score));
  }
  return [...links].sort((a, b) => b[1] - a[1]).slice(0, maxPages).map(([url]) => url);
}

async function readHtml(response: Response): Promise<string | undefined> {
  if (!response.body)
    return;
  if (!response.ok || !/^text\/html(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body.cancel();
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done)
        return html + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return;
      }
      html += decoder.decode(value, { stream: true });
    }
  }
  finally {
    reader.releaseLock();
  }
}

export async function loadDocs(
  page: PageSource,
  signal: AbortSignal,
  parser: DOMParser,
  fetcher: typeof fetch = fetch,
): Promise<DocsCollection> {
  const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]);
  const current = new URL(page.url);
  const key = (url: string) => docsPageUrl(url).replace(/\/$/, "");
  const visited = new Set([key(page.url)]);
  const directory = current.pathname.split("/").slice(0, -1)[1] ?? "";
  const section = directory === "" ? "/" : `/${directory}/`;
  const canIndex = (url: string) => new URL(url).pathname.startsWith(section) && !visited.has(key(url));
  const take = (links: string[], limit: number) => {
    const urls: string[] = [];
    for (const link of links) {
      const url = relatedUrl(link, current);
      if (url === undefined || visited.has(key(url)))
        continue;
      visited.add(key(url));
      urls.push(url);
      if (urls.length === limit)
        break;
    }
    return urls;
  };
  const read = async (url: string, discover: boolean) => {
    try {
      const response = await fetcher(url, {
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: fetchSignal,
      });
      const html = await readHtml(response);
      if (html === undefined || html === "")
        return;
      const document = parser.parseFromString("", "text/html");
      const template = document.createElement("template");
      template.innerHTML = html;
      const links = discover ? docsLinks(template.content, url, canIndex) : [];
      const title = template.content.querySelector("title")?.textContent?.trim().slice(0, maxTitleCharacters) ?? "";
      document.title = title === "" ? new URL(url).pathname : title;
      template.content.querySelectorAll("title, base, script, style, link, meta, img, iframe, picture, audio, video, object, embed, source, svg").forEach(node => node.remove());
      document.body.append(template.content);
      const source = extractPage(document);
      if (source)
        return { page: { title: source.title, url, text: source.text.slice(0, maxExcerptCharacters) }, links };
    }
    catch {
      signal.throwIfAborted();
    }
  };
  const readBatch = async (urls: string[], discover: boolean) => {
    signal.throwIfAborted();
    const results = await Promise.all(urls.map(async url => read(url, discover)));
    signal.throwIfAborted();
    return results.filter(result => result !== undefined);
  };
  const direct = await readBatch(take(page.relatedLinks ?? [], maxPages), true);
  const indexed = fetchSignal.aborted
    ? []
    : await readBatch(take(direct.flatMap(({ links }) => links), maxIndexedPages), false);
  signal.throwIfAborted();
  return { docs: direct.map(result => result.page), docsIndex: indexed.map(result => result.page) };
}

const tokenPattern = /[\p{L}\p{N}_]{2,}/gu;
const stopWords = new Set(["about", "can", "could", "does", "for", "from", "how", "the", "this", "what", "where", "which", "with", "would", "you"]);
const bm25Saturation = 1.2;
const bm25LengthWeight = 0.75;
const titleBoost = 2;

function terms(text: string): string[] {
  return (text.toLowerCase().match(tokenPattern) ?? []).filter(term => !stopWords.has(term));
}

export function searchDocs(page: PageSource, question: string): PageSource {
  if (!page.docs || !page.docsIndex || page.docsIndex.length === 0)
    return page;
  const query = new Set(terms(question));
  if (!query.size)
    return page;
  const indexed = [...page.docs, ...page.docsIndex].map((source) => {
    const body = terms(source.text);
    const counts = new Map<string, number>();
    for (const term of body)
      counts.set(term, (counts.get(term) ?? 0) + 1);
    return { source, counts, length: body.length, title: new Set(terms(source.title)) };
  });
  const totalTerms = indexed.reduce((sum, document) => sum + document.length, 0);
  const averageLength = totalTerms === 0 ? 1 : totalTerms / indexed.length;
  const weights = [...query].map((term) => {
    const matches = indexed.filter(document => document.counts.has(term) || document.title.has(term)).length;
    return { term, weight: Math.log1p((indexed.length - matches + 0.5) / (matches + 0.5)) };
  });
  const ranked = indexed.map(({ source, counts, length, title }, index) => {
    const normalization = bm25Saturation * (1 - bm25LengthWeight + bm25LengthWeight * length / averageLength);
    const score = weights.reduce((total, { term, weight }) => {
      const count = counts.get(term) ?? 0;
      const bodyScore = count * (bm25Saturation + 1) / (count + normalization);
      return total + weight * (bodyScore + (title.has(term) ? titleBoost : 0));
    }, 0);
    return { source, score, index };
  }).filter(document => document.score > 0);
  if (!ranked.length)
    return page;
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = [...new Set([...ranked.map(({ source }) => source), ...page.docs])].slice(0, maxPages);
  return { ...page, docs: selected };
}
