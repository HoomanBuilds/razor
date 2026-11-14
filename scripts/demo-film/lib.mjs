import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createReadStream, existsSync, mkdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const output = resolve(process.env.RAZOR_FILM_OUTPUT ?? resolve(root, '.data/demo-film'));
export const voice = Object.freeze({id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', model: 'eleven_v4', seed: 30102026, settings: {stability: 0.5, similarity_boost: 0.8, speed: 1}});
export const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function directory(name) {
  const path = resolve(output, name);
  mkdirSync(path, {recursive: true});
  return path;
}
export function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error || result.stdout}`);
  return result.stdout;
}
export function probe(path) {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]));
}
export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function loadStory(path) {
  const {story} = await import(pathToFileURL(resolve(path ?? resolve(root, 'scripts/demo-film/story.mjs'))));
  if (!story || !Array.isArray(story.segments) || !story.segments.length) throw new Error('Story requires segments');
  const ids = new Set();
  for (const segment of story.segments) {
    if (!/^[a-z0-9-]+$/.test(segment.id) || ids.has(segment.id)) throw new Error('Segment IDs must be unique and use lowercase letters, digits and hyphens');
    ids.add(segment.id);
    if (!['card', 'shot'].includes(segment.type) || !Number.isFinite(segment.seconds) || segment.seconds <= 0) throw new Error(`Invalid segment: ${segment.id}`);
    if (typeof segment.narration !== 'string' || !segment.narration.trim()) throw new Error(`Narration is missing: ${segment.id}`);
    for (const action of segment.actions ?? []) if (!Number.isFinite(action.at) || action.at < 0 || action.at >= segment.seconds) throw new Error(`Action lies outside ${segment.id}`);
  }
  if (story.segments.reduce((sum, segment) => sum + segment.seconds, 0) > 240) throw new Error('Planned film exceeds four minutes');
  return story;
}
export function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Capture requires an HTTP loopback address');
  return url;
}
export function cachedFingerprint(path, fingerprint) {
  return existsSync(path) && existsSync(`${path}.sha256`) && readFileSync(`${path}.sha256`, 'utf8') === fingerprint;
}
