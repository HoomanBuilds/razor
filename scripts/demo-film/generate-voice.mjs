import {copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs, parseEnv} from 'node:util';
import {directory, digest, loadStory, probe, voice} from './lib.mjs';

const {values} = parseArgs({options: {story: {type: 'string'}, env: {type: 'string'}, only: {type: 'string'}, 'dry-run': {type: 'boolean', default: false}}});
const story = await loadStory(values.story);
const audioDirectory = directory('audio');
const selectedIds = values.only?.split(',');
const segments = story.segments.filter((segment) => !selectedIds || selectedIds.includes(segment.id));
if (!segments.length) throw new Error('No matching narration segment');
if (values['dry-run']) {
  console.log(JSON.stringify({voice: voice.name, voiceId: voice.id, model: voice.model, segments: segments.length, characters: segments.reduce((sum, segment) => sum + segment.narration.length, 0)}, null, 2));
  process.exit(0);
}
const configuredKey = process.env.ELEVENLABS_API_KEY;
const key = configuredKey ?? (values.env ? parseEnv(readFileSync(resolve(values.env), 'utf8')).ELEVENLABS_API_KEY : undefined);
if (!key) throw new Error('Supply ELEVENLABS_API_KEY or pass --env with the existing local credential file');
for (const segment of segments) {
  const payload = {text: segment.narration, model_id: voice.model, seed: voice.seed, voice_settings: voice.settings};
  const fingerprint = digest(JSON.stringify({voice: voice.id, payload}));
  const audioPath = resolve(audioDirectory, `${segment.id}.mp3`);
  const metadataPath = resolve(audioDirectory, `${segment.id}.json`);
  if (existsSync(audioPath) && existsSync(metadataPath) && JSON.parse(readFileSync(metadataPath, 'utf8')).fingerprint === fingerprint) {
    console.log(`Cached ${segment.id}`); continue;
  }
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.id}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST', headers: {'xi-api-key': key, 'Content-Type': 'application/json'}, body: JSON.stringify(payload), signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Sarah generation failed for ${segment.id}: HTTP ${response.status}`);
  const result = await response.json();
  const alignment = result.normalized_alignment ?? result.alignment;
  if (!result.audio_base64 || !alignment) throw new Error(`Incomplete speech response: ${segment.id}`);
  if (existsSync(audioPath) && existsSync(metadataPath)) {
    const previous = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const archive = resolve(directory('audio/history'), `${segment.id}-${previous.fingerprint}`);
    copyFileSync(audioPath, `${archive}.mp3`);
    copyFileSync(metadataPath, `${archive}.json`);
  }
  writeFileSync(audioPath, Buffer.from(result.audio_base64, 'base64'));
  const duration = Number(probe(audioPath).format.duration);
  writeFileSync(metadataPath, JSON.stringify({fingerprint, voice, text: segment.narration, duration, alignment}, null, 2) + '\n');
  console.log(`Generated ${segment.id}: ${duration.toFixed(2)}s`);
}
