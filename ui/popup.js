import { DEFAULTS, getSettings } from '../src/settings.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const err = $('#err');

let tab = null;
let settings = { ...DEFAULTS };

/* ---------------------------------------------------------------- toggle */
// Injected into the page. Same isolated world as the content script, and calling
// it straight from this click keeps the user activation the PiP API demands.
function invokeToggle(force, s) {
  const api = globalThis.__FLOX__;
  if (!api) return { ok: false, score: 0, reason: 'no-content-script' };
  try { return api.toggle({ force, settings: s }); }
  catch (e) { return { ok: false, score: 0, reason: String(e && e.message || e) }; }
}
function probe() {
  const api = globalThis.__FLOX__;
  return api ? { score: api.probe(), open: api.isOpen() } : { score: 0, open: false };
}

async function run(force) {
  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true }, func: invokeToggle, args: [force, settings]
  });
  const hit = res.find(r => r.result && r.result.ok);
  if (hit) return hit.result;

  let best = null;
  for (const r of res) {
    const sc = (r.result && r.result.score) || 0;
    if (sc > 0 && (!best || sc > best.score)) best = { frameId: r.frameId, score: sc };
  }
  if (!best) return { ok: false, reason: (res[0] && res[0].result && res[0].result.reason) || 'no-video' };
  const forced = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [best.frameId] }, func: invokeToggle, args: [true, settings]
  });
  return (forced[0] && forced[0].result) || { ok: false, reason: 'failed' };
}

const REASONS = {
  'no-video': 'No video found on this page.',
  'no-content-script': 'Reload the page, then try again.',
  'not-playing': 'Video found but paused — retrying…'
};

$('#pop').addEventListener('click', async () => {
  err.textContent = '';
  try {
    const r = await run(false);
    if (r.ok) { window.close(); return; }
    err.textContent = REASONS[r.reason] || r.reason || 'Could not pop out.';
  } catch (e) {
    err.textContent = e.message;
  }
});

/* -------------------------------------------------------------- settings */
function paint() {
  for (const el of $$('[data-key]')) {
    const k = el.dataset.key, v = settings[k];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = String(v);
  }
  for (const o of $$('[data-out]')) {
    const k = o.dataset.out, v = Number(settings[k]);
    o.textContent = k === 'subtitleBg' || k === 'opacity' ? Math.round(v * 100) + '%'
                  : k === 'subtitleBottom' ? v + '%'
                  : v.toFixed(1);
  }
}

for (const el of $$('[data-key]')) {
  const k = el.dataset.key;
  const commit = async () => {
    const v = el.type === 'checkbox' ? el.checked
            : el.type === 'range' ? Number(el.value)
            : el.value;
    settings[k] = v;
    paint();
    await chrome.storage.sync.set({ [k]: v });   // background relays to live windows
  };
  el.addEventListener(el.type === 'range' || el.type === 'color' ? 'input' : 'change', commit);
}

$('#reset').addEventListener('click', async () => {
  settings = { ...DEFAULTS };
  await chrome.storage.sync.set(DEFAULTS);
  paint();
});

/* ---------------------------------------------------------------- status */
(async () => {
  settings = await getSettings();
  paint();

  // Opened as the options page (the toolbar icon now pops out directly, so this
  // page is reached via right-click → Options). There is no "active tab" to act
  // on from here, so the pop-out button and status line don't apply.
  const ownTab = await chrome.tabs.getCurrent().catch(() => null);
  if (ownTab) {
    $('#pop').remove();
    $('#status').textContent = 'settings';
    $('#state-dot').className = 'dot ready';
    return;
  }

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const dot = $('#state-dot'), status = $('#status'), label = $('#pop-label');
  if (!tab || /^(chrome|edge|opera|about|devtools|chrome-extension):/i.test(tab.url || '')) {
    status.textContent = 'not available here';
    $('#pop').disabled = true;
    return;
  }
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, func: probe
    });
    const open = res.some(r => r.result && r.result.open);
    const score = Math.max(0, ...res.map(r => (r.result && r.result.score) || 0));
    if (open) { dot.className = 'dot live'; status.textContent = 'popped out'; label.textContent = 'Close pop-out'; }
    else if (score > 0) { dot.className = 'dot ready'; status.textContent = 'video ready'; }
    else { status.textContent = 'no video detected'; }
  } catch {
    status.textContent = 'reload the page';
  }
})();
