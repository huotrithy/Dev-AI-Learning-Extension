import type { PageSource } from "../page/extract.ts";

import { docsPageUrl } from "../page/docs.ts";
import { videoContext } from "../page/youtube.ts";

const minimumTermLength = 4;
const repoTreeCharacters = 1_200;
const repoTreeBudgetDivisor = 5;
const docsChunkCharacters = 900;
const pageChunkCharacters = 1_500;
const searchTermsPattern = new RegExp(`[\\p{L}\\p{N}_-]{${minimumTermLength},}`, "gu");

export function pageContext(
  page: PageSource,
  length: number,
  question = "",
): string {
  if (page.video)
    return videoContext(page.title, page.video, length, question);
  if (page.repository) {
    const { branch, commit, paths, truncated, files } = page.repository;
    const terms = new Set(question.toLowerCase().match(searchTermsPattern) ?? []);
    const ranked = files.map((file) => {
      const path = file.path.toLowerCase();
      const text = file.text.toLowerCase();
      const score = [...terms].reduce((total, term) => total + (path.includes(term) ? 2 : Number(text.includes(term))), 0);
      return { file, score };
    }).sort((a, b) => b.score - a.score);
    const treeSample = paths.join("\n").slice(0, Math.min(repoTreeCharacters, Math.floor(length / repoTreeBudgetDivisor)));
    let remaining = length - treeSample.length;
    const excerpts = [];
    for (const { file } of ranked) {
      if (remaining <= 0)
        break;
      const text = file.text.slice(0, remaining);
      excerpts.push({ ...file, text });
      remaining -= text.length;
    }
    return JSON.stringify({ title: page.title, url: page.url, description: page.text, branch, commit, treeSample, truncated, files: excerpts });
  }
  if (page.docs) {
    const sources = [page, ...page.docs];
    const budget = Math.floor(length / sources.length);
    return JSON.stringify({ pages: sources.map(({ title, url, text }) => ({
      title,
      url: docsPageUrl(url),
      text: question && text.length > budget && budget >= docsChunkCharacters
        ? rankedExcerpts(text, question, budget, docsChunkCharacters).join("\n\n")
        : text.slice(0, budget),
    })) });
  }
  const text = page.text;
  const endpoint = new URL(page.url);
  const url = `${endpoint.origin}${endpoint.pathname}`;
  if (text.length <= length || !question) {
    return JSON.stringify({
      title: page.title,
      url,
      text: text.slice(0, length),
    });
  }

  return JSON.stringify({ title: page.title, url, excerpts: rankedExcerpts(text, question, length, pageChunkCharacters) });
}

function rankedExcerpts(text: string, question: string, length: number, chunkLength: number): string[] {
  const terms = new Set(
    question.toLowerCase().match(searchTermsPattern) ?? [],
  );
  const chunks = text.match(new RegExp(`[\\s\\S]{1,${chunkLength}}`, "g")) ?? [];
  const ranked = chunks.map((chunk, index) => ({
    chunk,
    index,
    score: [...terms].filter(term => chunk.toLowerCase().includes(term)).length,
  }));
  ranked.sort(
    (left, right) => right.score - left.score || left.index - right.index,
  );
  return ranked.slice(0, Math.floor(length / chunkLength))
    .sort((left, right) => left.index - right.index)
    .map(({ chunk }) => chunk);
}
