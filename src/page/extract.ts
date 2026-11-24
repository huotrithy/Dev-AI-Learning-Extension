import { Readability } from '@mozilla/readability';
import type { RepositorySource } from './github.ts';
import type { DocsPage } from './docs.ts';
import type { VideoTranscript } from './youtube.ts';

export interface PageSource {
  title: string;
  url: string;
  text: string;
  repository?: RepositorySource;
  relatedLinks?: string[];
  docs?: DocsPage[];
  video?: VideoTranscript;
}

export function extractPage(document: Document): PageSource | null {
  const copy = document.cloneNode(true) as Document;
  copy.querySelectorAll('script, style, nav, form, button, iframe, [hidden]').forEach((element) => element.remove());

  const parsed = new Readability(copy.cloneNode(true) as Document, { charThreshold: 80 }).parse();
  let content = copy.querySelector('main, article, [role="main"]') ?? copy.body;
  if (parsed?.content) {
    const article = copy.createElement('template');
    article.innerHTML = parsed.content;
    content = article.content.firstElementChild ?? content;
  }
  if (!content) return null;

  content.querySelectorAll('p, h1, h2, h3, h4, pre, li, blockquote, tr, br').forEach((element) => {
    element.append(copy.createTextNode('\n\n'));
  });
  const text = (content.textContent ?? '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 30) return null;

  return { title: document.title.trim() || parsed?.title || new URL(document.URL).hostname, url: document.URL, text };
}
