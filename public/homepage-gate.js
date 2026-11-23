/** Homepage entry only: no static game imports or vendor hints on desktop.
 * Device/platform signals, never viewport aspect ratio, preserve mobile landscape.
 */
const agent = navigator.userAgent || '';
const hints = navigator.userAgentData;
const mobileDevice = hints?.mobile === true
  || /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle|IEMobile|Opera Mini/i.test(agent)
  || /^(Android|iOS)$/i.test(hints?.platform || '')
  || (/Macintosh|MacIntel/i.test(agent) && navigator.maxTouchPoints > 1);
const letter = document.querySelector('[data-desktop-letter]');
const mobileHome = document.querySelector('[data-mobile-home]');
document.documentElement.dataset.homepageMode = mobileDevice ? 'mobile' : 'desktop';
if (letter) letter.hidden = mobileDevice;
if (mobileHome) mobileHome.hidden = !mobileDevice;
if (mobileDevice) {
  const replay = window.__homepageReplay = { serial: 0, pending: false, navigating: false, run: null };
  const button = document.querySelector('[data-guide-replay]');
  button?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (replay.navigating) return;
    replay.serial += 1;
    replay.pending = true;
    button.title = 'Replay queued until the goal frame is ready';
    replay.run?.();
  });
  for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup']) {
    button?.addEventListener(type, (event) => event.stopPropagation());
  }
  if (button) { button.disabled = false; button.title = 'Replay the goal-frame light show'; }
  for (const image of document.querySelectorAll('img[data-mobile-src]')) image.src = image.dataset.mobileSrc;
  for (const href of [
    './vendor/rapier/rapier.mjs',
    './vendor/three.module.js',
    './vendor/three.core.js',
    './glb-transport.js?v=2026.11.23-r10',
  ]) {
    const hint = document.createElement('link');
    hint.rel = 'modulepreload';
    hint.href = new URL(href, import.meta.url).href;
    document.head.appendChild(hint);
  }
  import('./app.js?v=2026.11.23-r10').catch(() => {
    const value = document.querySelector('[data-sim-xg-value]');
    const sr = document.querySelector('[data-sim-xg-sr]');
    if (value) value.dataset.value = '--';
    if (sr) sr.textContent = 'Simulated goal probability is unavailable because game initialization failed.';
  });
}
