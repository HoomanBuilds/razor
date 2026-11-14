const lineLimit = 44;
const timeEpsilon = 0.0001;

export function segmentCaptions(segment, alignment) {
  const {characters, character_start_times_seconds: starts, character_end_times_seconds: ends} = alignment ?? {};
  if (!Array.isArray(characters) || !characters.length || !Array.isArray(starts) || !Array.isArray(ends) || characters.length !== starts.length || characters.length !== ends.length) throw new Error(`Missing or invalid caption alignment: ${segment.id}`);
  if (![segment.startSeconds, segment.durationSeconds, segment.voiceOffset, segment.rawAudioSeconds].every(Number.isFinite) || segment.startSeconds < 0 || segment.durationSeconds <= 0 || segment.voiceOffset < 0 || segment.rawAudioSeconds <= 0) throw new Error(`Invalid caption timeline: ${segment.id}`);
  if (segment.captionPosition && !['top', 'bottom'].includes(segment.captionPosition)) throw new Error(`Invalid caption position: ${segment.id}`);
  const pauses = segment.pauses ?? [];
  if (pauses.some((pause) => !Number.isFinite(pause.at) || !Number.isFinite(pause.seconds) || pause.at <= 0 || pause.at >= segment.rawAudioSeconds || pause.seconds <= 0)) throw new Error(`Invalid caption pause: ${segment.id}`);
  for (let index = 0; index < characters.length; index++) {
    if (typeof characters[index] !== 'string' || !Number.isFinite(starts[index]) || !Number.isFinite(ends[index]) || starts[index] < 0 || ends[index] < starts[index] || (index && starts[index] < starts[index - 1])) throw new Error(`Invalid caption character timing: ${segment.id}`);
  }
  const offset = segment.startSeconds + segment.voiceOffset;
  const shifted = (at, isStart) => offset + at + pauses.filter((pause) => isStart ? pause.at <= at + timeEpsilon : pause.at < at - timeEpsilon).reduce((sum, pause) => sum + pause.seconds, 0);
  const words = [];
  let current;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (/\s/.test(character)) {if (current) {words.push(current); current = undefined;} continue;}
    if (!current) current = {text: '', start: shifted(Math.min(starts[index], segment.rawAudioSeconds), true), end: 0};
    current.text += character;
    current.end = shifted(Math.min(ends[index], segment.rawAudioSeconds), false);
  }
  if (current) words.push(current);
  if (!words.length) throw new Error(`Empty caption narration: ${segment.id}`);
  const groups = [];
  let group = [];
  const flush = () => {if (group.length) groups.push(group); group = [];};
  for (const word of words) {
    const candidate = [...group, word];
    if (group.length && (candidate.length > 9 || word.end - group[0].start > 3.7 || word.start - group.at(-1).end > 0.5 || !wrap(candidate.map((item) => item.text).join(' ')))) flush();
    group.push(word);
    if (/[.!?]$/.test(word.text) || (group.length >= 3 && /[,;:]$/.test(word.text))) flush();
  }
  flush();
  return groups.map((items, index) => {
    const text = items.map((item) => item.text).join(' ');
    const lines = wrap(text);
    if (!lines) throw new Error(`Caption exceeds two readable lines: ${segment.id}`);
    const start = items[0].start;
    const end = Math.min(items.at(-1).end + 0.12, groups[index + 1]?.[0].start ?? Infinity, segment.startSeconds + segment.durationSeconds);
    if (end <= start) throw new Error(`Caption exceeds narration duration: ${segment.id}`);
    return {start, end, lines, position: segment.captionPosition ?? 'bottom', segmentId: segment.id};
  });
}

function wrap(text) {
  if (text.length <= lineLimit) return [text];
  const words = text.split(' ');
  let best;
  for (let index = 1; index < words.length; index++) {
    const lines = [words.slice(0, index).join(' '), words.slice(index).join(' ')];
    if (lines.every((line) => line.length <= lineLimit) && (!best || Math.abs(lines[0].length - lines[1].length) < Math.abs(best[0].length - best[1].length))) best = lines;
  }
  return best;
}

function timestamp(seconds, ass = false) {
  let ticks = Math.round(seconds * (ass ? 100 : 1000));
  const unit = ass ? 100 : 1000;
  const fraction = ticks % unit;
  ticks = Math.floor(ticks / unit);
  const sec = ticks % 60, min = Math.floor(ticks / 60) % 60, hours = Math.floor(ticks / 3600);
  return `${ass ? hours : String(hours).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}${ass ? '.' : ','}${String(fraction).padStart(ass ? 2 : 3, '0')}`;
}

export function toSrt(captions) {
  const escaped = (line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return captions.map((caption, index) => `${index + 1}\n${timestamp(caption.start)} --> ${timestamp(caption.end)}\n${caption.lines.map(escaped).join('\n')}\n`).join('\n');
}

export function toAss(captions) {
  const escaped = (line) => line.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/[\r\n]/g, ' ');
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Bottom,Arial,42,&H00FFFFFF,&H00FFFFFF,&H20271810,&H20271810,0,0,0,0,100,100,0,0,3,8,0,2,180,180,38,1\nStyle: Top,Arial,42,&H00FFFFFF,&H00FFFFFF,&H20271810,&H20271810,0,0,0,0,100,100,0,0,3,8,0,8,180,180,34,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + captions.map((caption) => `Dialogue: 0,${timestamp(caption.start, true)},${timestamp(caption.end, true)},${caption.position === 'top' ? 'Top' : 'Bottom'},,0,0,0,,${caption.lines.map(escaped).join('\\N')}\n`).join('');
}

export function subtitleFilter(path) {
  return `subtitles=filename='${path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\\\''").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]')}'`;
}
