import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {openBrowser} from './browser.mjs';
import {directory, loadStory, root, wait} from './lib.mjs';

const {values} = parseArgs({options: {story: {type: 'string'}, port: {type: 'string', default: '9224'}}});
const story = await loadStory(values.story);
const font = readFileSync(resolve(root, 'public/fonts/geist-latin.woff2')).toString('base64');
const mark = readFileSync(resolve(root, 'public/brand/razor-mark.svg')).toString('base64');
const escape = (text = '') => text.replace(/[&<>"']/g, (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const browser = await openBrowser({port: Number(values.port)});
try {
  await browser.call('Emulation.setDeviceMetricsOverride', {width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false});
  for (const segment of story.segments.filter((segment) => segment.type === 'card' || segment.overview)) {
    const chapters = Math.max(...story.segments.map((item) => item.chapter ?? 0));
    const html = `<!doctype html><html><head><style>
      @font-face{font-family:Geist;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}body{margin:0;width:1920px;height:1080px;background:#f7f8fc;color:#101320;font-family:Geist,Arial,sans-serif;overflow:hidden}.glow{position:absolute;inset:0;background:radial-gradient(ellipse at 92% 94%,#d7e1ff 0,transparent 53%)}.brand{position:absolute;top:86px;left:100px;display:flex;align-items:center;gap:16px;font-size:34px;font-weight:550;letter-spacing:-1.5px}.brand img{width:45px;height:45px}.rule{height:30px;width:1px;background:#d5d9e4;margin:0 10px}.brand small{font-size:15px;letter-spacing:2px;font-weight:450;color:#777f92}.copy{position:absolute;left:150px;right:150px;top:326px}.eyebrow{color:#7c8599;letter-spacing:3px;font-size:17px;margin-bottom:29px;text-transform:uppercase}h1{font-size:96px;line-height:1.09;font-weight:500;letter-spacing:-5px;margin:0}h1 span{color:#1849ff}.description{font-size:27px;line-height:1.5;color:#687389;max-width:1400px;margin-top:28px}.footer{position:absolute;left:100px;right:100px;bottom:70px;display:flex;justify-content:space-between;align-items:center;font-size:16px;color:#7c8599}.progress{display:flex;gap:9px}.progress i{width:48px;height:4px;background:#dbe1ee;border-radius:4px}.progress i.active{background:#1849ff}.simulation{position:absolute;top:100px;right:100px;font-size:14px;color:#687389;border:1px solid #dbe1ee;border-radius:30px;padding:9px 15px}
      </style></head><body><div class="glow"></div><div class="brand"><img src="data:image/svg+xml;base64,${mark}">Razor<div class="rule"></div><small>BUILT ON NEAR</small></div><div class="copy"><div class="eyebrow">${escape(segment.eyebrow ?? `Chapter ${String(segment.chapter ?? 1).padStart(2, '0')}`)}</div><h1>${escape(segment.title)}${segment.accent ? `<br><span>${escape(segment.accent)}</span>` : ''}</h1><div class="description">${escape(segment.description)}</div></div><div class="footer"><span>razorfi.xyz</span><div class="progress">${Array.from({length: chapters}, (_, index) => `<i class="${index < (segment.chapter ?? 0) ? 'active' : ''}"></i>`).join('')}</div></div></body></html>`;
    const frameTree = await browser.call('Page.getFrameTree');
    await browser.call('Page.setDocumentContent', {frameId: frameTree.frameTree.frame.id, html});
    await browser.evaluate('document.fonts.ready.then(() => true)');
    await wait(150);
    const {data} = await browser.call('Page.captureScreenshot', {format: 'png'});
    writeFileSync(resolve(directory('cards'), `${segment.id}.png`), Buffer.from(data, 'base64'));
    console.log(`Card ${segment.id}`);
  }
} finally {await browser.close();}
