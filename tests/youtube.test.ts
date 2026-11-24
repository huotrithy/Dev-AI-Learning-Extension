import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { captureTranscript, youtubeVideo, videoSource } from '../src/page/youtube.ts';
import { pageContext } from '../src/learning/prompts.ts';
import { streamAnswer, streamLearning } from '../src/learning/session.ts';

const url = 'https://www.youtube.com/watch?v=abcdefghijk';
const expanded = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
const row = `<transcript-segment-view-model>
  <div class="ytwTranscriptSegmentViewModelTimestamp">1:02</div>
  <div>1 minute, 2 seconds</div><span role="text">Retry<br>the job.</span>
</transcript-segment-view-model>`;

function capture(content: string, renderedId = 'abcdefghijk', visibility = expanded, href = url) {
  const { window } = new JSDOM(`<title>Worker tutorial - YouTube</title>
    <ytd-watch-flexy video-id="${renderedId}">
      <ytd-engagement-panel-section-list-renderer visibility="${visibility}">
        ${content}
      </ytd-engagement-panel-section-list-renderer>
    </ytd-watch-flexy>`, { url: href, runScripts: 'outside-only' });
  try {
    // Chrome serializes the injected function without its module scope.
    return window.eval(`(${captureTranscript.toString()})()`) as ReturnType<typeof captureTranscript>;
  } finally {
    window.close();
  }
}

test('only desktop YouTube watch URLs become video sources and retain only the video ID', () => {
  assert.deepEqual(youtubeVideo(`${url}&list=private&t=30s#extra`), { id: 'abcdefghijk', url });
  assert.equal(youtubeVideo('https://youtube.com.evil.test/watch?v=abcdefghijk'), undefined);
  assert.equal(youtubeVideo('https://www.youtube.com/shorts/abcdefghijk'), undefined);
  assert.equal(youtubeVideo('https://www.youtube.com/watch?v=wrong'), undefined);
});

test('the injected reader captures visible captions in both transcript layouts', () => {
  const legacy = `<ytd-transcript-segment-renderer>
    <div class="segment-timestamp">1:00:15</div><yt-formatted-string class="segment-text">Review the log.</yt-formatted-string>
  </ytd-transcript-segment-renderer>`;
  assert.deepEqual(videoSource(youtubeVideo(url)!, capture(row))?.video?.excerpts,
    [{ seconds: 62, end: 62, time: '1:02', url: `${url}&t=62s`, text: 'Retry the job.' }]);
  assert.deepEqual(videoSource(youtubeVideo(url)!, capture(legacy))?.video?.excerpts,
    [{ seconds: 3615, end: 3615, time: '1:00:15', url: `${url}&t=3615s`, text: 'Review the log.' }]);
});

test('stale, collapsed, and loading panels cannot supply transcript text', () => {
  const video = youtubeVideo(url)!;
  assert.equal(videoSource(video, capture(row, 'differentid')), undefined);
  assert.equal(videoSource(video, capture(row, video.id, 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN')), undefined);
  assert.equal(videoSource(video, capture(row + '<yt-content-loading-renderer/>')), undefined);
});

test('the injected reader rejects off-site documents even when a navigation preserves ID and markup', () => {
  assert.equal(capture(row, 'abcdefghijk', expanded, 'https://outside.test/watch?v=abcdefghijk'), undefined);
});

test('hidden loading placeholders leave the displayed captions available', () => {
  const snapshot = capture(row + '<div hidden><yt-content-loading-renderer></yt-content-loading-renderer></div>');
  assert.equal(videoSource(youtubeVideo(url)!, snapshot)?.video?.excerpts[0]?.text, 'Retry the job.');
});

test('caption sets with a backwards timestamp are rejected as inconsistent', () => {
  const snapshot = capture(row + row.replace('1:02', '0:02'));
  assert.equal(videoSource(youtubeVideo(url)!, snapshot), undefined);
});

test('a bounded overview reaches the end while a follow-up finds the requested timestamp', () => {
  const source = videoSource(youtubeVideo(url)!, {
    id: 'abcdefghijk', title: 'Tutorial', truncated: false,
    rows: Array.from({ length: 120 }, (_, i) => ({
      timestamp: `${Math.floor(i / 2)}:${i % 2 ? '30' : '00'}`, text: `Topic ${i}. ` + 'Caption '.repeat(45),
    })),
  })!;
  const overview = pageContext(source, 1500);
  assert.ok(overview.length <= 1500);
  assert.match(overview, /Topic 0\./);
  assert.match(overview, /Topic 119\./);
  const answer = pageContext(source, 1000, 'What is discussed at 37:30?');
  assert.match(answer, /Topic 75\./);
  assert.match(answer, /&t=2250s/);
});

test('video learning and chat request caption-grounded answers with exact timestamp links', async () => {
  const source = videoSource(youtubeVideo(url)!, capture(row))!;
  const calls: { system: string; prompt: string }[] = [];
  const gateway = {
    stream: async function* (input: { system: string; prompt: string }) { calls.push(input); yield 'Text'; },
    decide: async () => assert.fail('A watch page already has a known source type'),
  };
  const signal = new AbortController().signal;
  const sections = [];
  for await (const chunk of streamLearning(source, 'new', '', gateway, signal)) sections.push(chunk.section);
  assert.deepEqual(sections, ['intro', 'moments']);
  for await (const _ of streamAnswer(source, 'When should I retry?', [], 'new', '', gateway, signal)) { /* Consume the answer. */ }
  assert.equal(calls.length, 3);
  for (const { system, prompt } of calls) {
    assert.match(system, /exact timestamp URLs/);
    assert.match(prompt, /Retry the job/);
    assert.match(prompt, /&t=62s/);
  }
});
