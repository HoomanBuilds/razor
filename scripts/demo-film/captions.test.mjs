import assert from 'node:assert/strict';
import test from 'node:test';
import {segmentCaptions, subtitleFilter, toAss, toSrt} from './captions.mjs';

function fixture(text, overrides = {}) {
  const characters = [...text];
  return [{id: 'test', startSeconds: 10, durationSeconds: 60, rawAudioSeconds: text.length * 0.08, voiceOffset: 0.3, pauses: [], ...overrides}, {characters, character_start_times_seconds: characters.map((_, index) => index * 0.08), character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.08)}];
}

test('captions follow narration offset and inserted pauses without spanning silence', () => {
  const [segment, alignment] = fixture('First sentence. Second sentence.');
  const pauseAt = alignment.character_end_times_seconds['First sentence.'.length - 1];
  segment.pauses = [{at: pauseAt, seconds: 3}];
  const captions = segmentCaptions(segment, alignment);
  assert.equal(captions.length, 2);
  assert.equal(captions[0].start, 10.3);
  assert.ok(captions[0].end < 12);
  assert.ok(captions[1].start >= 14.5);
  assert.ok(captions[1].start - captions[0].end > 2.8);
});

test('long narration stays within two readable lines and preserves every word', () => {
  const text = 'Razor brings treasury payroll invoices and cross-chain payments into one workspace for global companies working around the world.';
  const captions = segmentCaptions(...fixture(text));
  assert.ok(captions.length > 1);
  for (const caption of captions) {
    assert.ok(caption.lines.length <= 2);
    assert.ok(caption.lines.every((line) => line.length <= 44));
  }
  assert.equal(captions.flatMap((caption) => caption.lines).join(' '), text);
  assert.ok(captions.slice(1).every((caption, index) => caption.start >= captions[index].end));
});

test('alignment failures and impossible words are rejected', () => {
  const [segment, alignment] = fixture('A valid sentence.');
  assert.throws(() => segmentCaptions(segment, undefined), /alignment/);
  assert.throws(() => segmentCaptions(segment, {...alignment, characters: []}), /alignment/);
  assert.throws(() => segmentCaptions(segment, {...alignment, character_end_times_seconds: [NaN]}), /alignment/);
  const starts = [...alignment.character_start_times_seconds]; starts[2] = -1;
  assert.throws(() => segmentCaptions(segment, {...alignment, character_start_times_seconds: starts}), /timing/);
  assert.throws(() => segmentCaptions(...fixture('a'.repeat(90))), /two readable lines/);
});

test('the final cue is clipped to the available segment and supports top placement', () => {
  const [segment, alignment] = fixture('Short.', {durationSeconds: 0.72, captionPosition: 'top'});
  const captions = segmentCaptions(segment, alignment);
  assert.equal(captions[0].end, 10.72);
  assert.match(toAss(captions), /Dialogue: .*?,Top,/);
  assert.throws(() => segmentCaptions({...segment, captionPosition: 'left'}, alignment), /position/);
});

test('subtitle files preserve clean SRT text and escape ASS control text', () => {
  const captions = [{start: 59.9996, end: 62, lines: ['Pay {one} \\ two', '<amount> & receipt'], position: 'bottom'}];
  const srt = toSrt(captions);
  assert.match(srt, /00:01:00,000 --> 00:01:02,000/);
  assert.ok(srt.includes('Pay {one} \\ two\n&lt;amount&gt; &amp; receipt'));
  const ass = toAss(captions);
  assert.ok(ass.includes('Pay \\{one\\} \\\\ two\\N<amount> & receipt'));
  assert.ok(ass.includes('Arial,42'));
  assert.equal(subtitleFilter('/tmp/captions.ass'), "subtitles=filename='/tmp/captions.ass'");
});
