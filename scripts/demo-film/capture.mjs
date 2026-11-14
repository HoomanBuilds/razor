import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {openBrowser, ready} from './browser.mjs';
import {clickPointer, installPointer, movePointer} from './pointer.mjs';
import {directory, loadStory, localUrl, run, wait} from './lib.mjs';

const {values} = parseArgs({options: {story: {type: 'string'}, origin: {type: 'string', default: 'http://localhost:3400'}, port: {type: 'string', default: '9224'}, only: {type: 'string'}, reset: {type: 'boolean', default: false}}});
const story = await loadStory(values.story);
const origin = localUrl(values.origin).origin;
const recordingUrl = (path) => {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error('Recording navigation must remain on the local demo');
  url.searchParams.set('recording', '1');
  return url.href;
};
const selectedIds = values.only?.split(',');
const shots = story.segments.filter((segment) => segment.type === 'shot' && (!selectedIds || selectedIds.includes(segment.id)));
if (!shots.length) throw new Error('No matching capture segment');
let browser;
let state;
const substitute = (value) => typeof value === 'string' ? value.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_, path) => {
  const resolved = path.split('.').reduce((object, key) => object?.[key], state);
  if (typeof resolved !== 'string') throw new Error(`Unknown demo state field: ${path}`);
  return resolved;
}) : value;
const control = async (endpoint, body = {}) => {
  if (!endpoint.startsWith('/__demo/')) throw new Error('Only local demo controls are allowed');
  const response = await fetch(`${origin}${endpoint}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (!response.ok) throw new Error(`Demo control ${endpoint} failed: ${response.status}`);
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(';');
    const split = pair.indexOf('=');
    if (browser) await browser.call('Network.setCookie', {name: pair.slice(0, split), value: pair.slice(split + 1), url: origin, path: '/', httpOnly: attributes.some((attribute) => attribute.trim().toLowerCase() === 'httponly'), sameSite: 'Strict'});
  }
  return response.json();
};
if (values.reset) await control('/__demo/reset');
browser = await openBrowser({port: Number(values.port)});
const reportPath = resolve(directory('capture'), 'report.json');
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : [];
try {
  await installPointer(browser);
  await browser.call('Fetch.enable', {patterns: [{urlPattern: '*'}]});
  browser.on('Fetch.requestPaused', ({requestId, request}) => {
    let allowed = false;
    try {const parsed = new URL(request.url); allowed = ['data:', 'blob:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));} catch {}
    void browser.call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? {requestId} : {requestId, errorReason: 'BlockedByClient'}).catch(() => {});
  });
  for (const segment of shots) {
    for (const setup of segment.setup ?? []) await control(setup.endpoint, setup.body);
    state = await fetch(`${origin}/__demo/state`).then((response) => response.json());
    if (state.fictional !== true || state.noBroadcast !== true) throw new Error('Capture requires the isolated no-broadcast demo server');
    if (segment.profile) await control('/__demo/profile', {profile: segment.profile});
    const path = substitute(segment.path ?? '/app');
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Shot paths must be local');
    await ready(browser, recordingUrl(path));
    if (segment.profile) {
      const session = await browser.evaluate(`fetch('/api/auth/session').then(response=>response.json())`);
      const expected = state.profiles[segment.profile]?.id;
      if (!expected || session.user?.id !== expected) throw new Error(`Wrong authenticated local profile: ${segment.profile}`);
    }
    if (segment.frame) {
      await browser.evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(segment.frame.selector)});if(!target)throw new Error('Framing target not found');scrollTo({top:target.getBoundingClientRect().top+scrollY-${segment.frame.offset ?? 100},behavior:'instant'})})()`);
      await wait(250);
    }
    const snapshot = () => browser.evaluate('({title:document.title,text:document.body.innerText,scrollWidth:document.documentElement.scrollWidth,width:innerWidth,brokenImages:[...document.images].filter(image=>image.complete&&!image.naturalWidth).length,pointer:window.__razorFilmPointer?.state()})');
    await movePointer(browser, segment.pointerStart ?? {x: 1120, y: 760}, 0);
    const before = await snapshot();
    if (!before.pointer?.visible || before.pointer.pointerEvents !== 'none') throw new Error(`Recording pointer is unavailable: ${segment.id}`);
    const frameDirectory = resolve(directory('capture'), segment.id);
    mkdirSync(frameDirectory, {recursive: true});
    const frames = [];
    const exceptions = [];
    const removeException = browser.on('Runtime.exceptionThrown', ({exceptionDetails}) => exceptions.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    const removeFrame = browser.on('Page.screencastFrame', ({data, metadata, sessionId}) => {
      const file = `${String(frames.length).padStart(6, '0')}.jpg`;
      writeFileSync(resolve(frameDirectory, file), Buffer.from(data, 'base64'));
      frames.push({file, timestamp: metadata.timestamp, received: performance.now()});
      void browser.call('Page.screencastFrameAck', {sessionId}).catch(() => {});
    });
    const captureSeconds = segment.captureSeconds ?? segment.seconds - (segment.overview ?? 0);
    const started = performance.now();
    await browser.call('Page.startScreencast', {format: 'jpeg', quality: 93, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1});
    const events = [];
    for (const action of [...(segment.actions ?? [])].sort((a, b) => a.at - b.at)) {
      if (action.at >= captureSeconds) throw new Error(`Action exceeds footage duration: ${segment.id}`);
      const cursorLead = ['click', 'fill', 'select', 'point'].includes(action.type) ? 420 : 0;
      await wait(Math.max(0, action.at * 1000 - cursorLead - (performance.now() - started)));
      try {await perform(action);}
      catch (error) {throw new Error(`${segment.id} action ${action.type} at ${action.at}s (${action.selector ?? action.text ?? action.path ?? ''}): ${error.message}`);}
      events.push({...action, actualSeconds: (performance.now() - started) / 1000});
    }
    await wait(Math.max(0, captureSeconds * 1000 - (performance.now() - started)));
    await browser.call('Page.stopScreencast');
    removeFrame(); removeException();
    const after = await snapshot();
    if (!after.pointer?.visible || after.pointer.pointerEvents !== 'none') throw new Error(`Recording pointer disappeared: ${segment.id}`);
    if (!frames.length) throw new Error(`No screencast frames: ${segment.id}`);
    const duration = Math.max(captureSeconds, (performance.now() - started) / 1000);
    const startTimestamp = frames[0].timestamp;
    const timeline = frames.map((frame, index) => {
      const current = index === 0 ? 0 : frame.timestamp - startTimestamp;
      const next = index + 1 < frames.length ? frames[index + 1].timestamp - startTimestamp : duration;
      return `file '${frame.file}'\nduration ${Math.max(0.001, next - current).toFixed(6)}`;
    }).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
    writeFileSync(resolve(frameDirectory, 'frames.ffconcat'), timeline);
    const video = resolve(directory('cuts'), `${segment.id}.mp4`);
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', resolve(frameDirectory, 'frames.ffconcat'), '-vf', 'fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,format=yuv420p', '-t', duration.toFixed(3), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-threads', '2', video]);
    const previous = report.findIndex((item) => item.id === segment.id);
    if (previous >= 0) report.splice(previous, 1);
    report.push({id: segment.id, path, duration, frameCount: frames.length, before, after, actions: events, exceptions});
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Captured ${segment.id}: ${duration.toFixed(2)}s, ${frames.length} frames`);
  }
} finally {await browser.close();}

async function perform(action) {
  if (action.type === 'navigate') {
    const path = substitute(action.path);
    if (!path?.startsWith('/') || path.startsWith('//')) throw new Error('Navigation must remain local');
    await ready(browser, recordingUrl(path)); return;
  }
  if (action.type === 'scroll') {
    const end = action.by === undefined ? String(Number(action.y)) : `scrollY+${Number(action.by)}`;
    await browser.evaluate(`new Promise(resolve=>{const start=scrollY,end=${end},begin=performance.now(),duration=650;function frame(now){const t=Math.min(1,(now-begin)/duration),ease=t*t*(3-2*t);scrollTo({top:start+(end-start)*ease,behavior:'instant'});if(t<1)requestAnimationFrame(frame);else resolve(true)}requestAnimationFrame(frame)})`); return;
  }
  if (action.type === 'control') {await control(action.endpoint, action.body); return;}
  if (action.type === 'checkAll') {
    const count = await browser.evaluate(`document.querySelectorAll(${JSON.stringify(action.selector)}).length`);
    for (let index = 0; index < count; index++) {
      const target = await browser.evaluate(`(()=>{const element=[...document.querySelectorAll(${JSON.stringify(action.selector)})][${index}];if(element.checked)return null;const r=element.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      if (!target) continue;
      if (target.x < 0 || target.y < 0 || target.x > 1920 || target.y > 1080) throw new Error('Checkbox lies outside the frame; scroll before checking');
      await clickPointer(browser, target); await wait(100);
    }
    return;
  }
  const selector = action.selector ? `document.querySelector(${JSON.stringify(substitute(action.selector))})` : `[...document.querySelectorAll('button,a,summary,[role="button"],[role="option"]')].find(element=>element.textContent.trim()===${JSON.stringify(action.text)}&&element.getBoundingClientRect().width&&element.getBoundingClientRect().height)`;
  if (action.type === 'reveal') {
    await browser.evaluate(`(()=>{const element=${selector};if(!element)throw new Error('Reveal target not found');element.scrollIntoView({behavior:'smooth',block:${JSON.stringify(action.block ?? 'center')}});return true})()`);
    await wait(700); return;
  }
  const target = await browser.evaluate(`(()=>{const element=${selector};if(!element)throw new Error('Capture target not found');const rect=element.getBoundingClientRect();if(!rect.width||!rect.height)throw new Error('Capture target is hidden');return {x:rect.x+rect.width*${action.anchorX ?? 0.5},y:rect.y+rect.height*${action.anchorY ?? 0.5}}})()`);
  if (target.x < 0 || target.y < 0 || target.x > 1920 || target.y > 1080) throw new Error('Capture target lies outside the frame');
  if (action.type === 'point') {await movePointer(browser, target); return;}
  await clickPointer(browser, target);
  if (action.type === 'fill') {
    await browser.call('Input.dispatchKeyEvent', {type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2});
    await browser.call('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2});
    await browser.call('Input.insertText', {text: action.value});
  } else if (action.type === 'select') {
    await browser.evaluate(`(()=>{const element=${selector};element.value=${action.optionText ? `[...element.options].find(option=>option.textContent===${JSON.stringify(action.optionText)})?.value` : JSON.stringify(action.value)};element.dispatchEvent(new Event('change',{bubbles:true}));return element.value})()`);
  } else if (action.type !== 'click') throw new Error(`Unknown capture action: ${action.type}`);
}
