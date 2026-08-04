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

export async function togglePiP(tabId) {
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
  if (!best) return { ok: false, reason: 'no-video' };

  const forced = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [best.frameId] },
    func: invokeToggle,
    args: [true, settings]
  });
  return (forced[0] && forced[0].result) || { ok: false, reason: 'forced-failed' };
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

// The content script's own Alt+P handler routes here when it can't act locally
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
