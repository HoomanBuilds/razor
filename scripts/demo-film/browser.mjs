import {spawn} from 'node:child_process';
import {openSync, closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {directory, localUrl, wait} from './lib.mjs';

export async function openBrowser({port = 9224, executable = process.env.CHROME_PATH ?? '/usr/bin/chromium', endpoint} = {}) {
  const address = localUrl(endpoint ?? `http://127.0.0.1:${port}`).origin;
  let child;
  if (!endpoint) {
    try {
      const occupied = await fetch(`${address}/json/version`, {signal: AbortSignal.timeout(300)});
      if (occupied.ok) throw new Error(`Browser port ${port} is in use; choose another port`);
    } catch (error) {
      if (error.message.includes('is in use')) throw error;
    }
    const log = openSync(resolve(directory('browser'), 'chromium.log'), 'a');
    child = spawn(executable, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${port}`, `--user-data-dir=${directory('browser/profile')}`, 'about:blank'], {stdio: ['ignore', log, log]});
    closeSync(log);
  }
  let target;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {target = await fetch(`${address}/json/new?about:blank`, {method: 'PUT', signal: AbortSignal.timeout(500)}).then((response) => response.json()); break;}
      catch {await wait(200);}
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('Chromium did not expose a target');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true});});
    let id = 0;
    const pending = new Map();
    const handlers = new Map();
    socket.addEventListener('message', ({data}) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timeout);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      } else for (const handler of handlers.get(message.method) ?? []) handler(message.params);
    });
    socket.addEventListener('close', () => {for (const request of pending.values()) {clearTimeout(request.timeout); request.reject(new Error('Chromium connection closed'));} pending.clear();});
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => {pending.delete(requestId); reject(new Error(`Chromium timeout: ${method}`));}, 30000);
      pending.set(requestId, {resolve, reject, timeout});
      socket.send(JSON.stringify({id: requestId, method, params}));
    });
    const on = (method, handler) => {
      const values = handlers.get(method) ?? new Set();
      values.add(handler); handlers.set(method, values);
      return () => values.delete(handler);
    };
    const evaluate = async (expression) => {
      const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
    return {call, on, evaluate, async close() {socket.close(); await fetch(`${address}/json/close/${target.id}`).catch(() => {}); if (child) child.kill('SIGTERM');}};
  } catch (error) {if (child) child.kill('SIGTERM'); throw error;}
}

export async function ready(browser, url, {width = 1920, height = 1080} = {}) {
  await browser.call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
  const navigation = await browser.call('Page.navigate', {url});
  if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await browser.evaluate('document.readyState === "complete" && document.body.innerText.trim().length > 0')) break;
    await wait(200);
  }
  await browser.evaluate('document.fonts.ready.then(() => true)');
  await wait(900);
}
