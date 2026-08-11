// Flox — service worker.
// Responsibilities: route the toggle to the right frame (page or iframe), keep the
// badge in sync, broadcast live setting changes to open PiP windows.

import { DEFAULTS, getSettings } from './settings.js';

const activePiP = new Map(); // tabId -> { frameId, title }

const MIGRATIONS_KEY = '__migrations';

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get(null).catch(() => ({}));
  const missing = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (cur[k] === undefined) missing[k] = v;
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);

  // A changed default never reaches an existing install — the old value is
  // already stored. Migrations are applied once each, by name.
  const done = new Set(cur[MIGRATIONS_KEY] || []);
  const apply = async (name, patch) => {
    if (done.has(name)) return;
    await chrome.storage.sync.set(patch);
    done.add(name);
  };

  // 1.2.0: DRM sites go to our own window (which renders the site's subtitle
  // layer) instead of the browser's, which cannot show subtitles at all.
  await apply('drm-window-1.2.0', { drmNative: false });

  // 1.5.0: bezel-less (browser frame, subtitles composited in) is the default.
  await apply('clean-window-1.5.0', { cleanWindow: true });

  await chrome.storage.sync.set({ [MIGRATIONS_KEY]: [...done] });
});

/**
 * Injected into every frame of the tab. Runs in the SAME isolated world as the
 * content script, so it can reach the global the content script installed.
 * Calling it via chrome.scripting propagates the extension's user activation,
 * which is what documentPictureInPicture.requestWindow() requires.
 */
function invokeToggle(force, settings) {
  const api = globalThis.__FLOX__;
  if (!api) return { ok: false, score: 0, reason: 'no-content-script' };
  try {
    return api.toggle({ force, settings });
  } catch (e) {
    return { ok: false, score: 0, reason: String(e && e.message || e) };
  }
}

/** Injected to ask a frame whether the content script is present. */
function probePresence() {
  return !!globalThis.__FLOX__;
}

/** Injected to show a message on the page when the toggle failed everywhere. */
function reportFailure(reason) {
  const api = globalThis.__FLOX__;
  // Only the top frame speaks for the tab; an overlay per iframe would stack.
  if (!api || !api.notify || window.top !== window) return false;
  api.notify(reason);
  return true;
}

const RESTRICTED = /^(chrome|edge|opera|about|devtools|view-source|moz-extension|chrome-extension):/i;

/**
 * The single most common way this extension "did nothing": the tab was already
 * open when the extension was installed, updated or reloaded, so no content
 * script was ever injected into it and every call found `__FLOX__` undefined.
 * Manifest `content_scripts` only cover *future* navigations. So we check, and
 * inject on demand into whatever is already open.
 */
async function ensureInjected(tabId) {
  let present = [];
  try {
    present = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, func: probePresence
    });
  } catch (e) {
    return { ok: false, reason: 'inject-failed: ' + e.message };
  }
  if (present.some(r => r.result)) return { ok: true };

  // Inject both worlds, in the same order the manifest would have.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN', files: ['src/page-hook.js']
    });
  } catch {}   // page-hook is an enhancement; its absence must not block a pop-out
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, files: ['src/content.js']
    });
  } catch (e) {
    return { ok: false, reason: 'inject-failed: ' + e.message };
  }
  return { ok: true };
}

export async function togglePiP(tabId, { report = true } = {}) {
  const res = await runToggle(tabId);
  if (!res.ok && report) await reportToUser(tabId, res.reason);
  return res;
}

async function runToggle(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && RESTRICTED.test(tab.url || '')) return { ok: false, reason: 'restricted-page' };

  const ready = await ensureInjected(tabId);
  if (!ready.ok) return ready;

  const settings = await getSettings();
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: invokeToggle,
      args: [false, settings]
    });
  } catch (e) {
    return { ok: false, reason: 'inject-failed: ' + e.message };
  }

  const acted = results.find(r => r.result && r.result.ok);
  if (acted) return acted.result;

  // Nobody had a *playing* video. Pick the frame with the best candidate and force it.
  let best = null;
  for (const r of results) {
    const s = r.result && r.result.score || 0;
    if (s > 0 && (!best || s > best.score)) best = { frameId: r.frameId, score: s };
  }
  // No frame scored. Surface the most specific reason any frame gave rather
  // than a blanket "no-video" — "not-playing" and "no-content-script" are
  // actionable, and collapsing them is what made failures unreadable.
  if (!best) {
    const reasons = results.map(r => r.result && r.result.reason).filter(Boolean);
    const pick = reasons.find(x => x !== 'no-video' && x !== 'no-content-script');
    return { ok: false, reason: pick || reasons[0] || 'no-video' };
  }

  const forced = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [best.frameId] },
    func: invokeToggle,
    args: [true, settings]
  });
  return (forced[0] && forced[0].result) || { ok: false, reason: 'forced-failed' };
}

/**
 * A failed toggle must never be silent. Preferred channel is the content
 * script's own on-page overlay; when the page is unreachable (restricted URL,
 * blocked injection) the badge is all we have.
 */
async function reportToUser(tabId, reason) {
  // The frame already showed its own clickable prompt for this one.
  if (reason === 'needs-gesture') return;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, func: reportFailure, args: [reason || 'no-video']
    });
    if (res.some(r => r.result === true)) return;
  } catch {}
  flashBadge(tabId);
}

function flashBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#d9534f' }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 3000);
}

// Clicking the toolbar icon pops out immediately — no popup, no second click.
// Settings live on the options page (right-click the icon → Options).
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) togglePiP(tab.id);
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-pip') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) togglePiP(tab.id);
});

// The content script's own Alt+, handler routes here when it can't act locally
// (e.g. the key was pressed while a different frame owned the video).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'FLOX_HOTKEY' && sender.tab) togglePiP(sender.tab.id);
});

// Badge / state bookkeeping + live setting relay.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  const tabId = sender.tab && sender.tab.id;

  switch (msg.type) {
    case 'FLOX_OPENED':
      if (tabId != null) {
        activePiP.set(tabId, { frameId: sender.frameId, title: msg.title || '' });
        chrome.action.setBadgeText({ tabId, text: 'ON' }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#5b8cff' }).catch(() => {});
      }
      break;
    case 'FLOX_CLOSED':
      if (tabId != null) {
        activePiP.delete(tabId);
        chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      }
      break;
    case 'FLOX_TOGGLE_REQUEST':
      if (tabId != null) togglePiP(tabId).then(sendResponse);
      return true;
    case 'FLOX_FOCUS_TAB':
      if (tabId != null) {
        chrome.tabs.update(tabId, { active: true }).catch(() => {});
        if (sender.tab.windowId != null) {
          chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => {});
        }
      }
      break;
    case 'FLOX_STATUS':
      sendResponse({ open: activePiP.has(msg.tabId) });
      break;
  }
});

// Push live setting changes to every frame so an open PiP window updates instantly.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  const patch = {};
  for (const [k, v] of Object.entries(changes)) patch[k] = v.newValue;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { type: 'FLOX_SETTINGS', patch }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => activePiP.delete(tabId));
