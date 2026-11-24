import type { PageSource } from './extract.ts';

export interface YouTubeVideo {
  id: string;
  url: string;
}

interface CaptionExcerpt {
  seconds: number;
  end: number;
  time: string;
  url: string;
  text: string;
}

interface TranscriptSnapshot {
  id: string;
  title: string;
  truncated: boolean;
  rows: { timestamp: string; text: string }[];
}

export interface VideoTranscript {
  id: string;
  excerpts: CaptionExcerpt[];
  truncated: boolean;
}

export function youtubeVideo(href: string): YouTubeVideo | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  if (!['https://www.youtube.com', 'https://youtube.com'].includes(url.origin) || url.pathname !== '/watch') return;
  const id = url.searchParams.get('v');
  if (!id || !/^[\w-]{11}$/.test(id) || url.username || url.password) return;
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

// Chrome injects this function without its module scope.
export function captureTranscript(): TranscriptSnapshot | undefined {
  const url = new URL(location.href);
  if (!['https://www.youtube.com', 'https://youtube.com'].includes(url.origin) || url.pathname !== '/watch') return;
  const id = url.searchParams.get('v');
  const watch = document.querySelector('ytd-watch-flexy:not([hidden])');
  if (!id || watch?.getAttribute('video-id') !== id || watch.getAttribute('is-watch-page') === 'false') return;
  const segments = 'transcript-segment-view-model, ytd-transcript-segment-renderer';
  const hidden = '[aria-hidden="true"], [hidden]';
  const panels = watch.querySelectorAll('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]:not([hidden])');
  const panel = Array.from(panels).find((candidate) => !candidate.closest(hidden) && candidate.querySelector(segments));
  if (!panel || Array.from(panel.querySelectorAll('ytd-continuation-item-renderer, yt-content-loading-renderer'))
    .some((indicator) => !indicator.closest(hidden))) return;

  const rows: TranscriptSnapshot['rows'] = [];
  let remaining = 240_000;
  let truncated = false;
  for (const segment of panel.querySelectorAll(segments)) {
    if (segment.closest(hidden)) continue;
    const timestamp = segment.querySelector('.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp')?.textContent?.trim();
    const caption = segment.querySelector('.ytAttributedStringHost, [role="text"], .segment-text')?.cloneNode(true) as Element | undefined;
    caption?.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
    const text = (caption?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!timestamp || timestamp.length > 12 || !text) continue;
    if (rows.length >= 8_000 || text.length > remaining) {
      truncated = true;
      break;
    }
    rows.push({ timestamp, text });
    remaining -= text.length;
  }
  return { id, title: document.title.replace(/\s+- YouTube$/, '').slice(0, 300), rows, truncated };
}

function timestampSeconds(value: string): number | undefined {
  if (!/^\d{1,5}(?::[0-5]\d){1,2}$/.test(value)) return;
  const parts = value.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function videoSource(video: YouTubeVideo, snapshot?: TranscriptSnapshot): PageSource | undefined {
  if (!snapshot || snapshot.id !== video.id) return;
  const excerpts: CaptionExcerpt[] = [];
  let truncated = snapshot.truncated;
  for (const { timestamp, text } of snapshot.rows) {
    const seconds = timestampSeconds(timestamp);
    const previous = excerpts.at(-1);
    if (seconds === undefined) continue;
    if (previous && seconds < previous.end) return;
    if (text.length > 900) truncated = true;
    if (previous && seconds < previous.seconds + 30 && previous.text.length + text.length < 900) {
      previous.text += ` ${text}`;
      previous.end = seconds;
    } else {
      excerpts.push({ seconds, end: seconds, time: timestamp, url: `${video.url}&t=${seconds}s`, text: text.slice(0, 900) });
    }
  }
  if (!excerpts.length) return;
  return {
    title: snapshot.title.trim() || 'YouTube video',
    url: video.url,
    text: excerpts.slice(0, 2).map(({ text }) => text).join('\n'),
    video: { id: video.id, excerpts, truncated },
  };
}

export function videoContext(title: string, video: VideoTranscript, budget: number, question: string): string {
  const context = { title, truncated: video.truncated, sampled: true, transcript: [] as { time: string; url: string; text: string }[] };
  const candidates = video.excerpts.map(({ time, url, text, seconds, end }, index) => {
    const excerpt = { time, url, text };
    return { excerpt, index, seconds, end, cost: JSON.stringify(excerpt).length + 1 };
  });
  let remaining = budget - JSON.stringify(context).length;
  let order: typeof candidates;
  if (question) {
    const terms = new Set(question.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []);
    const times = (question.match(/(?<![\d:])\d{1,5}(?::[0-5]\d){1,2}(?![\d:])/g) ?? []).map(timestampSeconds);
    const ranked = candidates.map((candidate) => {
      const { seconds, end, excerpt } = candidate;
      const lower = excerpt.text.toLowerCase();
      const score = [...terms].filter((term) => lower.includes(term)).length;
      const distance = Math.min(...times.map((time) => time === undefined ? Infinity : Math.max(seconds - time, time - end, 0)));
      return { candidate, score, distance };
    });
    order = ranked.sort((a, b) => a.distance - b.distance || b.score - a.score || a.candidate.index - b.candidate.index)
      .map(({ candidate }) => candidate);
  } else {
    const count = Math.min(candidates.length, Math.max(1, Math.floor(remaining / Math.max(...candidates.map(({ cost }) => cost)))));
    const indexes = new Set(Array.from({ length: count }, (_, index) =>
      count === 1 ? 0 : Math.round(index * (candidates.length - 1) / (count - 1))));
    order = candidates.filter(({ index }) => indexes.has(index));
  }
  const chosen = order.filter(({ cost }) => {
    if (cost > remaining) return false;
    remaining -= cost;
    return true;
  });
  context.transcript = chosen.sort((a, b) => a.index - b.index).map(({ excerpt }) => excerpt);
  context.sampled = chosen.length !== candidates.length;
  return JSON.stringify(context);
}
