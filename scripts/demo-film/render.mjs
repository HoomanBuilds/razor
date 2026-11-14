import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {cachedFingerprint, directory, digest, fileHash, loadStory, output, probe, run, voice} from './lib.mjs';

const {values} = parseArgs({options: {story: {type: 'string'}, only: {type: 'string'}, 'plan-only': {type: 'boolean', default: false}, name: {type: 'string', default: 'razor-company-demo-v1-sarah.mp4'}}});
if (!/^[a-z0-9-]+\.mp4$/.test(values.name)) throw new Error('Output name must be a simple lowercase MP4 filename');
const story = await loadStory(values.story);
const rendererHash = digest(readFileSync(new URL(import.meta.url)));
const timeline = [];
let cursor = 0;
for (const segment of story.segments) {
  const audio = resolve(directory('audio'), `${segment.id}.mp3`);
  const card = resolve(directory('cards'), `${segment.id}.png`);
  const source = segment.type === 'shot' ? resolve(directory('cuts'), `${segment.id}.mp4`) : card;
  if (!existsSync(audio)) throw new Error(`Generate Sarah narration first: ${segment.id}`);
  if (!existsSync(source) && !values['plan-only']) throw new Error(`Missing source capture/card: ${segment.id}`);
  const metadata = JSON.parse(readFileSync(resolve(directory('audio'), `${segment.id}.json`), 'utf8'));
  if (metadata.voice.id !== voice.id || metadata.text !== segment.narration) throw new Error(`Narration is stale or uses another voice: ${segment.id}`);
  const rawAudioSeconds = Number(probe(audio).format.duration);
  const transcript = metadata.alignment?.characters.join('') ?? '';
  const pauses = (segment.pauses ?? []).map((pause) => {
    const index = transcript.indexOf(pause.after);
    if (index < 0 || pause.seconds <= 0) throw new Error(`Invalid narration pause: ${segment.id}`);
    const at = metadata.alignment.character_end_times_seconds[index + pause.after.length - 1];
    if (!Number.isFinite(at) || at <= 0 || at >= rawAudioSeconds) throw new Error(`Pause is outside narration: ${segment.id}`);
    return {...pause, at};
  }).sort((left, right) => left.at - right.at);
  const audioSeconds = rawAudioSeconds + pauses.reduce((sum, pause) => sum + pause.seconds, 0);
  const rawSourceSeconds = segment.type === 'shot' && existsSync(source) ? Number(probe(source).format.duration) : 0;
  for (const [index, range] of (segment.keep ?? []).entries()) {
    if (range[0] < 0 || range[1] <= range[0] || range[1] > rawSourceSeconds + 0.1 || (index && range[0] < segment.keep[index - 1][1])) throw new Error(`Invalid footage trim: ${segment.id}`);
  }
  const sourceSeconds = segment.keep ? segment.keep.reduce((sum, [start, end]) => sum + end - start, 0) : rawSourceSeconds;
  const lead = 0.3;
  const tail = segment.type === 'card' ? 1.4 : 0.55;
  const duration = Math.ceil(Math.max(segment.seconds, audioSeconds + lead + tail, sourceSeconds + (segment.overview ?? 0)) * 30) / 30;
  timeline.push({...segment, startSeconds: cursor, durationSeconds: duration, audioSeconds, rawAudioSeconds, pauses, voiceOffset: lead, sourceSeconds, rawSourceSeconds, audio, source, card});
  cursor += duration;
}
if (cursor > Math.min(story.maxSeconds ?? 240, 240)) throw new Error(`Film measures ${cursor.toFixed(2)} seconds; trim the story below 240 seconds before rendering`);
writeFileSync(resolve(output, 'timeline.json'), JSON.stringify({title: story.title, durationSeconds: cursor, voice, segments: timeline}, null, 2) + '\n');
console.log(`Timeline: ${cursor.toFixed(2)} seconds`);
if (values['plan-only']) process.exit(0);

for (const segment of timeline) {
  if (values.only && segment.id !== values.only) continue;
  const duration = segment.durationSeconds;
  const destination = resolve(directory('render'), `${segment.id}.mkv`);
  const fingerprint = digest(JSON.stringify({segment, rendererHash, source: await fileHash(segment.source), audio: await fileHash(segment.audio), card: segment.overview ? await fileHash(segment.card) : null}));
  if (cachedFingerprint(destination, fingerprint)) {console.log(`Cached ${segment.id}`); continue;}
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const filters = [];
  if (segment.type === 'card') {
    args.push('-loop', '1', '-framerate', '30', '-i', segment.card, '-i', segment.audio);
    filters.push('[0:v]fps=30,setsar=1,format=yuv420p,fade=t=in:st=0:d=0.18:color=0xf7f8fc[v]');
    narration(filters, '1:a', segment, duration);
  } else if (segment.overview) {
    args.push('-loop', '1', '-framerate', '30', '-i', segment.card, '-i', segment.source, '-i', segment.audio);
    const remaining = duration - segment.overview;
    filters.push(`[0:v]trim=duration=${segment.overview},setpts=PTS-STARTPTS,setsar=1,fps=30,format=yuv420p,fade=t=in:st=0:d=0.12:color=0xf7f8fc[card]`);
    footage(filters, '1:v', segment, remaining, 'screen');
    filters.push('[card][screen]concat=n=2:v=1:a=0[v]');
    narration(filters, '2:a', segment, duration);
  } else {
    args.push('-i', segment.source, '-i', segment.audio);
    footage(filters, '0:v', segment, duration, 'v');
    narration(filters, '1:a', segment, duration);
  }
  args.push('-filter_complex_threads', '2', '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-t', String(duration), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', destination);
  run('ffmpeg', args);
  writeFileSync(`${destination}.sha256`, fingerprint);
  console.log(`Rendered ${segment.id}: ${duration.toFixed(2)}s`);
}
if (values.only) process.exit(0);
const concatenation = resolve(directory('render'), 'concat.txt');
writeFileSync(concatenation, timeline.map((segment) => `file '${segment.id}.mkv'`).join('\n') + '\n');
const master = resolve(directory('render'), 'narrated-master.mkv');
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatenation, '-c', 'copy', master]);
const metadataPath = resolve(directory('render'), 'chapters.ffmeta');
const escaped = (text) => text.replace(/[=;#\\]/g, '\\$&').replace(/\n/g, ' ');
writeFileSync(metadataPath, `;FFMETADATA1\ntitle=${escaped(story.title)}\ncomment=Local product demo. Transfers are simulated.\n` + timeline.map((segment) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(segment.startSeconds * 1000)}\nEND=${Math.round((segment.startSeconds + segment.durationSeconds) * 1000)}\ntitle=${escaped(segment.title)}\n`).join(''));
const destination = resolve(output, values.name);
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', master, '-i', metadataPath, '-map', '0:v', '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-c:v', 'copy', '-af', 'alimiter=limit=0.891:level=false', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', String(cursor), '-movflags', '+faststart', destination]);
const final = probe(destination);
const video = final.streams.find((stream) => stream.codec_type === 'video');
const audio = final.streams.find((stream) => stream.codec_type === 'audio');
if (Number(final.format.duration) > 240 || video?.width !== 1920 || video?.height !== 1080 || video.r_frame_rate !== '30/1' || !audio) throw new Error('Final media verification failed');
writeFileSync(resolve(output, 'verification.json'), JSON.stringify({file: destination, durationSeconds: Number(final.format.duration), width: video.width, height: video.height, frameRate: video.r_frame_rate, audioCodec: audio.codec_name, sha256: await fileHash(destination), simulatedTransfers: true}, null, 2) + '\n');
console.log(`Complete: ${destination}`);

function footage(filters, input, segment, duration, output) {
  let source = `[${input}]`;
  if (segment.keep?.length) {
    const selected = segment.keep.map(([start, end]) => `gte(t,${start})*lt(t,${end})`).join('+');
    filters.push(`${source}select='${selected}',setpts=N/(30*TB)[edited]`);
    source = '[edited]';
  }
  filters.push(`${source}setpts=PTS-STARTPTS,fps=30,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=${Math.max(0, duration - segment.sourceSeconds) + 0.1},trim=duration=${duration}[${output}]`);
}

function narration(filters, input, segment, duration) {
  let source = `[${input}]`;
  if (segment.pauses.length) {
    const boundaries = [0, ...segment.pauses.map((pause) => pause.at), segment.rawAudioSeconds];
    const parts = [];
    filters.push(`${source}asplit=${boundaries.length - 1}${boundaries.slice(1).map((_, index) => `[voice${index}]`).join('')}`);
    boundaries.slice(1).forEach((end, index) => {
      filters.push(`[voice${index}]atrim=start=${boundaries[index]}:end=${end},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[sentence${index}]`);
      parts.push(`[sentence${index}]`);
      if (segment.pauses[index]) {
        filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${segment.pauses[index].seconds}[pause${index}]`);
        parts.push(`[pause${index}]`);
      }
    });
    filters.push(`${parts.join('')}concat=n=${parts.length}:v=0:a=1[timedvoice]`);
    source = '[timedvoice]';
  }
  filters.push(`${source}loudnorm=I=-18:TP=-2:LRA=7,aresample=48000,adelay=${segment.voiceOffset * 1000}:all=1,apad,atrim=duration=${duration}[a]`);
}
