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

  // 1.8.1: the subtitle-source readout shipped defaulting ON while the offset
  // work was being diagnosed. Flipping the default alone leaves it on screen
  // for anyone who already has `true` stored, so retire it explicitly.
  await apply('debug-subs-off-1.8.1', { debugSubs: false });

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

/**
 * Settings are cached in memory purely so the click path never has to await
 * storage. `null` is fine to pass — the content script keeps its own copy.
 */
let settingsCache = null;
getSettings().then((s) => { settingsCache = s; }).catch(() => {});

/**
 * THE RULE FOR THIS FILE: nothing may be awaited between a user gesture and the
 * chrome.scripting call that acts on it.
 *
 * requestPictureInPicture() and documentPictureInPicture.requestWindow() both
 * require transient user activation in the target frame. The activation that a
 * toolbar click grants is forwarded through chrome.scripting.executeScript, but
 * only while the worker still holds it — every awaited call in between spends
 * it, and the page-side request is then refused with "Must be handling a user
 * gesture". Probing for the content script, reading storage and re-injecting all
 * did exactly that. Recovery work happens AFTER the injection, never before.
 */
export function togglePiP(tabId, { report = true } = {}) {
  let results;
  const done = (res) => {
    if (!res.ok && report) reportToUser(tabId, res.reason);
    return res;
  };
  // force: true, single pass. The old code ran a probe pass and then a second
  // "forced" pass at the best frame, but that second call came after an await
  // and so arrived without the gesture. Frames with no video return no-video
  // and do nothing, so one forced pass is safe.
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: invokeToggle,
    args: [true, settingsCache]
  }).then((r) => {
    results = r;
    const acted = results.find(x => x.result && x.result.ok);
    if (acted) return acted.result;
    return recover(tabId, results).then(done);
  }).catch((e) => done({ ok: false, reason: 'inject-failed: ' + e.message }));
}

/**
 * Ran after a failed pass, so awaits are free here. Its job is to explain the
 * failure, and to repair the one case it can: a tab that predates the extension
 * and therefore has no content script at all.
 */
async function recover(tabId, results) {
  const noScript = results.length && results.every(r => r.result && r.result.reason === 'no-content-script');
  if (noScript) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && RESTRICTED.test(tab.url || '')) return { ok: false, reason: 'restricted-page' };
    await ensureInjected(tabId);
    // Deliberately not retried here: the gesture is gone, so the retry would be
    // refused anyway. The script is in place now, so the next press works.
    return { ok: false, reason: 'injected-retry' };
  }

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

  // A frame scored but did not act, so the pass reached it and was refused for
  // a real reason. Report that, rather than re-injecting without a gesture.
  const r = results.find(x => x.frameId === best.frameId);
  return { ok: false, reason: (r && r.result && r.result.reason) || 'forced-failed' };
}

/**
 * A failed toggle must never be silent. Preferred channel is the content
 * script's own on-page overlay; when the page is unreachable (restricted URL,
 * blocked injection) the badge is all we have.
 */
async function reportToUser(tabId, reason) {
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

// Clicking the toolbar icon pops out immediately — no popup, no second click,
// and never a confirmation. Settings live on the options page.
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) togglePiP(tab.id);
});

/**
 * Manifest content_scripts only cover future navigations, so tabs that were
 * already open when the extension was installed or reloaded have no content
 * script. That used to be repaired at click time, which cost the user gesture.
 * Do it up front instead, so the click path never has to.
 */
async function injectAllTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
  for (const t of tabs) {
    if (t.id == null) continue;
    chrome.scripting.executeScript({
      target: { tabId: t.id, allFrames: true }, func: probePresence
    }).then((res) => {
      if (res.some(r => r.result)) return;
      return ensureInjected(t.id);
    }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(injectAllTabs);
chrome.runtime.onStartup.addListener(injectAllTabs);
injectAllTabs();   // also covers a plain service-worker restart

// Same rule as the click path: no await before the injection. `tab` is supplied
// with the event, so the query that used to sit here is not needed.
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd !== 'toggle-pip') return;
  if (tab && tab.id != null) { togglePiP(tab.id); return; }
  chrome.tabs.query({ active: true, currentWindow: true })
    .then(([t]) => { if (t) togglePiP(t.id); }).catch(() => {});
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
