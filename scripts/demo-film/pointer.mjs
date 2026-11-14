export async function installPointer(browser) {
  const source = `(${pointerDocument.toString()})()`;
  await browser.call('Page.addScriptToEvaluateOnNewDocument', {source});
  await browser.evaluate(source);
}

export async function movePointer(browser, target, duration = 420) {
  if (![target.x, target.y, duration].every(Number.isFinite) || target.x < 0 || target.y < 0 || duration < 0) throw new Error('Invalid pointer target');
  const start = await browser.evaluate('window.__razorFilmPointer.state()');
  const began = performance.now();
  let progress = 0;
  do {
    progress = duration ? Math.min(1, (performance.now() - began) / duration) : 1;
    const ease = progress * progress * (3 - 2 * progress);
    await browser.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: start.x + (target.x - start.x) * ease, y: start.y + (target.y - start.y) * ease});
    if (progress < 1) await new Promise(resolve => setTimeout(resolve, 16));
  } while (progress < 1);
  await browser.evaluate('window.__razorFilmPointer.save()');
}

export async function clickPointer(browser, target) {
  await movePointer(browser, target);
  await browser.call('Input.dispatchMouseEvent', {type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1});
  await new Promise(resolve => setTimeout(resolve, 60));
  await browser.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1});
}

function pointerDocument() {
  if (window.__razorFilmPointer) return;
  let x = 1120, y = 760;
  try {
    const saved = JSON.parse(sessionStorage.getItem('razor-film-pointer'));
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) ({x, y} = saved);
  } catch {}
  let host, arrow, ring;
  const paint = () => {
    if (!host) return;
    host.style.transform = `translate3d(${x - 4}px,${y - 3}px,0)`;
  };
  const elevate = () => {
    if (!host?.isConnected) return;
    if (host.matches(':popover-open')) host.hidePopover();
    host.showPopover();
  };
  const mount = () => {
    if (host || !document.body) return;
    const style = document.createElement('style');
    style.textContent = `
      #razor-film-pointer{position:fixed;inset:0 auto auto 0;margin:0;padding:0;width:42px;height:46px;border:0;background:transparent;overflow:visible;pointer-events:none!important;z-index:2147483647;contain:layout style}
      #razor-film-pointer::backdrop{background:transparent;pointer-events:none!important}
      #razor-film-pointer *{pointer-events:none!important}
      #razor-film-pointer svg{display:block;width:31px;height:37px;overflow:visible;filter:drop-shadow(0 2px 2px #06132955);transform-origin:4px 3px}
      #razor-film-pointer i{position:absolute;left:4px;top:3px;width:28px;height:28px;margin:-14px;border:2px solid #295bff;border-radius:50%;background:#295bff18;opacity:0}
    `;
    document.head.append(style);
    host = document.createElement('div');
    host.id = 'razor-film-pointer';
    host.setAttribute('popover', 'manual');
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = '<i></i><svg viewBox="0 0 31 37" xmlns="http://www.w3.org/2000/svg"><path d="M4 3L4 28L10.5 22L16 34L21 31.5L15.5 20L25 19Z" fill="#101525" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>';
    document.body.append(host);
    arrow = host.querySelector('svg');
    ring = host.querySelector('i');
    paint();
    elevate();
    new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes' && record.target instanceof HTMLDialogElement)) elevate();
    }).observe(document.body, {subtree: true, attributes: true, attributeFilter: ['open']});
    document.addEventListener('toggle', event => {
      if (event.target !== host && event.newState === 'open') elevate();
    }, true);
  };
  window.__razorFilmPointer = {
    save() {sessionStorage.setItem('razor-film-pointer', JSON.stringify({x, y}));},
    press() {
      mount();
      ring.animate([{opacity: 0.65, transform: 'scale(.65)'}, {opacity: 0, transform: 'scale(1.65)'}], {duration: 430, easing: 'ease-out'});
      arrow.animate([{transform: 'scale(1)'}, {transform: 'scale(.9)', offset: .4}, {transform: 'scale(1)'}], {duration: 180});
    },
    state: () => ({x, y, visible: Boolean(host?.matches(':popover-open')), pointerEvents: host ? getComputedStyle(host).pointerEvents : null}),
  };
  document.addEventListener('mousemove', event => {x = event.clientX; y = event.clientY; mount(); paint();}, true);
  document.addEventListener('mousedown', event => {if (event.button === 0) window.__razorFilmPointer.press();}, true);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, {once: true});
}
