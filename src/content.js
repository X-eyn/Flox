/* ==========================================================================
 * Flox — content script (isolated world)
 * Runs in every frame. Owns video discovery, the Document PiP window,
 * and the subtitle mirroring engine.
 * ========================================================================== */
(() => {
  if (globalThis.__FLOX__) return;

  const DEFAULTS = {
    subtitles: true, subtitleSize: 4.2, subtitleColor: '#ffffff', subtitleBg: 0.55,
    subtitleBottom: 6, subtitleShadow: true, opacity: 1, transparencyEnabled: false,
    showControls: true, hoverControls: true, pauseOnClose: false, returnOnClose: true,
    rememberSize: true, lastSize: { width: 640, height: 360 }, mode: 'auto',
    autoPipOnTabHide: false, keepAspect: true, drmNative: false, forceNative: false, cleanWindow: true
  };

  let S = { ...DEFAULTS };
  const hasDocPiP = 'documentPictureInPicture' in window;

  /* ---------------------------------------------------------------- utils */
  // `softOpacity` keeps a mid-fade element visible. Players fade caption boxes
  // in and out, so treating opacity 0 as gone clears the overlay mid-cue.
  const vis = (el, softOpacity) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' &&
           (softOpacity || cs.opacity !== '0');
  };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  // VTT/TTML cue text carries simple markup (<b>, <i>, <v Speaker>, <c.class>).
  // Parsed with string ops, not innerHTML: Trusted-Types sites reject HTML sinks,
  // and this runs on pages we don't control.
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  function stripCueMarkup(s) {
    return String(s || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/&(#?\w+);/g, (m, e) => (e in ENTITIES ? ENTITIES[e]
        : /^#\d+$/.test(e) ? String.fromCharCode(+e.slice(1))
        : /^#x[0-9a-f]+$/i.test(e) ? String.fromCharCode(parseInt(e.slice(2), 16)) : m))
      .replace(/\n{2,}/g, '\n')
      .trim();
  }
  const send = (msg) => { try { chrome.runtime.sendMessage(msg); } catch {} };

  /* ----------------------------------------------------------------- HUD ---
   * Every failure path used to end in a swallowed result object, so a click
   * that couldn't work looked exactly like a click that did nothing. This is a
   * shadow-DOM overlay so no host stylesheet can hide or restyle it. It only
   * ever reports; it is never interactive and never gates a pop-out.
   * ------------------------------------------------------------------------ */
  const HUD_CSS = `
#b{font:600 13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#eef2f8;
  background:rgba(14,17,23,.95);border:1px solid rgba(255,255,255,.13);border-radius:10px;
  padding:9px 13px;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:330px;
  opacity:0;transform:translateY(-6px);transition:opacity .16s ease,transform .16s ease}
#b.show{opacity:1;transform:none}`;

  let hudHost = null, hudBox = null, hudT = 0;

  function hud(msg) {
    try {
      const root = document.documentElement;
      if (!root || !msg) return;
      if (!hudHost || !hudHost.isConnected) {
        hudHost = document.createElement('div');
        hudHost.setAttribute('data-flox-hud', '1');
        hudHost.style.cssText =
          'all:initial;position:fixed;top:14px;right:14px;z-index:2147483647;';
        const sr = hudHost.attachShadow({ mode: 'open' });
        const st = document.createElement('style');
        st.textContent = HUD_CSS;
        hudBox = document.createElement('div');
        hudBox.id = 'b';
        sr.append(st, hudBox);
        root.appendChild(hudHost);
      }
      hudBox.textContent = msg;
      hudBox.classList.add('show');
      clearTimeout(hudT);
      hudT = setTimeout(hideHud, 2800);
    } catch {}
  }

  function hideHud() {
    clearTimeout(hudT);
    if (hudBox) hudBox.classList.remove('show');
  }

  // exitPictureInPicture() REJECTS a promise when nothing is in PiP — a plain
  // try/catch cannot catch that, which is why it surfaced as an uncaught
  // InvalidStateError. Guard the state and swallow the rejection properly.
  const exitPiP = () => {
    try {
      if (!document.pictureInPictureElement) return;
      const p = document.exitPictureInPicture();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  };

  // Capturing a DRM-protected video yields black frames — the whole point of the
  // protection. So mirroring must never be used as a fallback there; a black
  // rectangle with subtitles over it is worse than an honest failure.
  const DRM_HOSTS = /(netflix|primevideo|disneyplus|hotstar|starplus|hulu|peacocktv|paramountplus|max|crunchyroll)\./i;
  const isDRM = (v) => !!(v && v.mediaKeys) || DRM_HOSTS.test(location.hostname);

  // Some players fault when their <video> is torn out from under them (Netflix
  // shows "Pardon the interruption"). Move the player's own container instead:
  // the element keeps its parent chain, and the site's caption overlay travels
  // with it, so the host renders its own subtitles inside the PiP window.
  const MOVE_ROOTS = [
    { host: /netflix\.com/, sel: '.watch-video--player-view, .nf-player-container, [data-uia="video-canvas"]' },
    { host: /(primevideo|amazon)\./, sel: '.webPlayerSDKContainer, .rendererContainer, .webPlayerElement' },
    { host: /disneyplus\.com|starplus\.com|hotstar\.com/, sel: '.btm-media-client-element, .hudson-container, .video-container' },
    { host: /max\.com|hbomax\.com/, sel: '[data-testid="player-container"], .player-container' },
    { host: /hulu\.com/, sel: '.video-player, #content-video-player' }
  ];

  function moveTargetFor(video) {
    const p = MOVE_ROOTS.find(x => x.host.test(location.hostname));
    if (!p) return video;
    let el = video.parentElement;
    for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
      try { if (el.matches(p.sel)) return el; } catch {}
    }
    return video;
  }

  /* ------------------------------------------------------- video discovery */
  function allVideos() {
    const out = [];
    const walk = (root) => {
      let list;
      try { list = root.querySelectorAll('video'); } catch { return; }
      out.push(...list);
      // pierce open shadow roots (Plex, some smart-TV style players, web components)
      try {
        const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = tw.nextNode())) if (n.shadowRoot) walk(n.shadowRoot);
      } catch {}
    };
    walk(document);
    return [...new Set(out)];
  }

  function scoreVideo(v) {
    if (!v || !vis(v)) return 0;
    const r = v.getBoundingClientRect();
    let s = Math.sqrt(r.width * r.height);              // size dominates
    // `!paused` alone lies: a stalled element that never loaded still reports
    // paused === false. Require real data before calling it "playing".
    if (!v.paused && !v.ended && v.readyState >= 2) s += 4000;
    if (v.readyState >= 2) s += 200;
    if (v.duration && isFinite(v.duration) && v.duration > 60) s += 300; // not a 6s ad loop
    if (v.muted && v.paused) s -= 300;
    // penalise offscreen
    const vh = innerHeight || 1, vw = innerWidth || 1;
    const inView = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) *
                   Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    if (inView <= 0) s -= 1500;
    if (v === document.pictureInPictureElement) s += 2000;
    return Math.max(0, s);
  }

  function pickVideo() {
    let best = null, bestScore = 0;
    const all = allVideos();
    for (const v of all) {
      const s = scoreVideo(v);
      if (s > bestScore) { best = v; bestScore = s; }
    }
    if (best) return { video: best, score: bestScore };

    // Relaxed pass. scoreVideo() requires a laid-out, visible element, which a
    // real player can legitimately fail: zero-sized until the first frame,
    // opacity 0 behind a poster/ad overlay, or scaled to nothing by a custom
    // renderer. Anything holding an actual media resource is still poppable, so
    // rather than reporting "no video" we rank what we have. These scores stay
    // below the visible tier so a visible video in another frame always wins.
    for (const v of all) {
      let s = 0;
      if (!v.paused && !v.ended) s += 40;
      if (v.readyState >= 2) s += 20;
      if (v.currentTime > 0) s += 10;
      if (v.videoWidth > 0) s += 10;
      if (v.currentSrc || v.src || v.srcObject) s += 5;
      if (s > bestScore) { best = v; bestScore = s; }
    }
    return { video: best, score: bestScore };
  }

  /* =========================================================================
   * SUBTITLE ENGINE
   * Four independent sources, all normalised to plain text lines:
   *   1. native TextTrack cues (<track>, TTML/VTT injected by the player)
   *   2. host DOM caption overlays (YouTube, Netflix, Prime, JW, video.js, …)
   *   3. generic heuristic DOM scan (unknown players)
   *   4. canvas-rendered subtitles (libass / ASS) → mirrored pixel-for-pixel
   * ======================================================================= */
  const SITE_PROFILES = [
    { host: /youtube\.com|youtube-nocookie\.com/, sel: '.ytp-caption-window-container, .caption-window' },
    { host: /netflix\.com/,        sel: '.player-timedtext' },
    { host: /disneyplus\.com|starplus\.com|hotstar\.com/, sel: '.dss-hls-subtitle-overlay, .subtitle-container, [class*="subtitle"]' },
    { host: /(amazon|primevideo)\./, sel: '.atvwebplayersdk-captions-overlay, .webPlayerSDKCaptions, #dv-web-player .captions' },
    { host: /max\.com|hbomax\.com/, sel: '[data-testid="text-track"], .text-track, [class*="TextTrack"]' },
    { host: /hulu\.com/,           sel: '.closed-caption-container, .ClosedCaption' },
    { host: /vimeo\.com/,          sel: '.vp-captions, .captions' },
    { host: /crunchyroll\.com/,    sel: '.libassjs-canvas-parent, .vjs-text-track-display' },
    { host: /twitch\.tv/,          sel: '.player-captions-container, [data-a-target="player-captions"]' },
    { host: /peacocktv\.com|nbc\.com/, sel: '.subtitles, [class*="Subtitle"]' },
    { host: /paramountplus\.com/,  sel: '.closed-captions, [class*="caption"]' },
    { host: /plex\.tv|app\.plex\./, sel: '.libjass-subs, [class*="Subtitle"]' },
    { host: /jellyfin|emby/,       sel: '.subtitleAppearance, .htmlvideoplayer + .videoSubtitles, #subtitleAppearance' },
    { host: /bilibili\.com/,       sel: '.bpx-player-subtitle-wrap, .bilibili-player-subtitle-wrap' }
  ];

  const GENERIC_SEL = [
    '.vjs-text-track-display', '.shaka-text-container', '.jw-captions', '.plyr__captions',
    '.mejs__captions-layer', '.flowplayer .fp-captions', '[class*="caption" i]',
    '[class*="subtitle" i]', '[class*="timedtext" i]', '[class*="text-track" i]',
    '[id*="caption" i]', '[id*="subtitle" i]'
  ].join(',');

  // Caption overlays are few and small. Anything past this is the heuristic
  // matching site chrome, and observing it costs far more than it can ever pay.
  const MAX_SUB_ROOTS = 8;

  class SubtitleEngine {
    constructor(video) {
      this.video = video;
      this.onText = () => {};
      this.onCanvas = () => {};
      this.text = '';
      this._observers = [];
      this._trackState = new Map();   // TextTrack -> original mode
      this._domRoots = new Set();
      this._canvas = null;
      this._destroyed = false;
      this._rescan = null;
      // priority order, best first. `timedtext` is the subtitle file the player
      // itself downloaded — exact text and timings, immune to DOM changes.
      this._src = { timedtext: '', cue: '', hook: '', dom: '' };
      this._obs = new Map();                       // element -> MutationObserver
      this._produced = new Set();                  // roots that have ever yielded text
      this._seen = new Map();                      // root -> { last, changed }
      this._everHadText = false;                   // any source has ever resolved text
      this._lastMutated = null;                    // root whose TEXT changed most recently
      this._readQueued = false;
      this.onRoot = () => {};                      // notified as roots are adopted
    }

    // Mutations arrive in bursts (a player repaints its caption box many times
    // per cue). Coalesce them: one read per frame, never one read per mutation.
    _queueRead() {
      if (this._readQueued || this._destroyed) return;
      this._readQueued = true;
      requestAnimationFrame(() => { this._readQueued = false; this._readDom(); });
    }

    start() {
      this._startHook();
      this._bindTracks();
      // `change` fires when the user switches subtitle track in the site's own
      // menu; `addtrack` when the player attaches one lazily. Both just rebind.
      this._trackAddL = () => this._bindTracks();
      try {
        const tt = this.video.textTracks;
        if (tt) {
          tt.addEventListener('addtrack', this._trackAddL);
          tt.addEventListener('change', this._trackAddL);
        }
      } catch {}

      this._scanDom();
      // Players attach caption containers lazily (and swap them per-cue), so we
      // rescan — but the scan itself is a document-wide query, so it backs off
      // once a source is actually producing text instead of running forever.
      const tick = () => {
        if (this._destroyed) return;
        this._scanDom();
        const settled = this.text || this._trackState.size || this._src.hook || this._src.timedtext;
        this._rescan = setTimeout(tick, settled ? 6000 : 1500);
      };
      this._rescan = setTimeout(tick, 1500);
      return this;
    }

    /* ---- source 1b: page-world cue hook (players with self-rendered tracks) ---- */
    _startHook() {
      this._hookL = (e) => {
        const d = e.data;
        if (!d || d.__flox !== 'FLOX_HOOK' || this._destroyed) return;
        if (d.event === 'cues') this._set('hook', d.text || '');
        else if (d.event === 'timedtext-list') this._loadTimedText(d.cues);
      };
      window.addEventListener('message', this._hookL);
      // The hook itself is a MAIN-world content script at document_start — it has
      // to be in place before the player fetches its subtitle file, which happens
      // long before any pop-out is opened. Here we only switch its polling on.
      window.postMessage({ __flox: 'FLOX_CTL', action: 'on' }, '*');
    }

    /* ---- source 0: subtitle file the player fetched over the network ----
     * Exact text and timings, taken from the payload itself. Resolved here,
     * against OUR video element, because it may have been relocated into the
     * PiP document where the page-world hook cannot see it.
     */
    _loadTimedText(cues) {
      if (!Array.isArray(cues) || !cues.length) return;
      // Sites prefetch subtitle files for other servers, episodes and languages,
      // so the last file to arrive is not necessarily the one playing. Since
      // `timedtext` is the highest-priority source, letting a background fetch
      // replace a working list swaps correct subtitles for wrong ones. Keep a
      // list that is currently producing text.
      if (this._tt && this._src.timedtext) return;
      this._tt = cues;
      if (this._ttTimer) return;
      const tick = () => {
        if (this._destroyed) return;
        const t = this.video.currentTime;
        this._set('timedtext', this._ttAt(t));
      };
      this._ttTimer = setInterval(tick, 120);
      this._observers.push(() => clearInterval(this._ttTimer));
      tick();
    }

    _ttAt(t) {
      const c = this._tt;
      if (!c || !c.length || !isFinite(t)) return '';
      let lo = 0, hi = c.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (c[mid].s <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      const parts = [];
      for (let i = Math.max(0, idx - 4); i <= idx && i >= 0; i++) {
        const cue = c[i];
        if (cue && cue.s <= t && cue.e >= t) parts.push(cue.t);
      }
      return [...new Set(parts)].join('\n');
    }

    /* ---- source 1: native text tracks ---- */
    // NOTE: no per-track polling. Some players attach hundreds of tracks (cinejoy
    // ships ~200 lazy SRTs), and one timer each would bury the page. The track
    // list fires `change` whenever any track's mode flips, which is all we need.
    _bindTracks() {
      const tt = this.video.textTracks;
      if (!tt) return;

      // Reconcile what we already hold. We park our tracks at 'hidden', so any
      // other mode means the player changed it — the viewer turned subtitles
      // off, or switched language. Release it and clear the line, otherwise the
      // last cue sticks on screen forever AND (since `cue` outranks `hook` and
      // `dom`) blocks every lower-priority source from ever showing again.
      for (const [track, st] of [...this._trackState]) {
        if (track.mode === 'hidden') continue;
        try { track.removeEventListener('cuechange', st.h); } catch {}
        this._trackState.delete(track);
        this._set('cue', '');
      }

      for (const track of tt) {
        if (this._trackState.has(track)) continue;
        // Never consume our own bridge track — the engine feeds it, and taking
        // it over would set it hidden and silence the very output we injected.
        if (track.__flox || track.label === 'Flox') continue;
        if (!/subtitles|captions/i.test(track.kind || '')) continue;
        // Only mirror a track the player actually turned on; take over rendering
        // (hidden = cues still fire, UA stops drawing them) so styling is ours.
        if (track.mode !== 'showing') continue;
        const h = () => {
          const parts = [];
          for (const c of track.activeCues || []) parts.push(this._cueText(c));
          this._set('cue', parts.filter(Boolean).join('\n'));
        };
        this._trackState.set(track, { mode: track.mode, h });
        track.mode = 'hidden';
        track.addEventListener('cuechange', h);
        h();
      }
    }

    _cueText(cue) {
      if (!cue) return '';
      if (typeof cue.text === 'string') return stripCueMarkup(cue.text);
      try { return (cue.getCueAsHTML().textContent || '').trim(); } catch { return ''; }
    }

    /* ---- sources 2+3: DOM overlays ---- */
    _scanDom() {
      const container = this._playerRoot();
      const profile = SITE_PROFILES.find(p => p.host.test(location.hostname));
      const candidates = new Set();

      const collect = (root, sel) => {
        if (!root) return;
        try { root.querySelectorAll(sel).forEach(e => candidates.add(e)); } catch {}
      };
      if (profile) { collect(document, profile.sel); collect(container, profile.sel); }
      collect(container, GENERIC_SEL);
      if (!candidates.size) collect(document.body, GENERIC_SEL);

      // Name-based matching fails on players that style captions with utility
      // classes (cinejoy renders them into plain Tailwind divs). Fall back to
      // shape: short text, few children, sitting over the lower part of the video.
      //
      // Gating this on `!candidates.size` was wrong: GENERIC_SEL matches on
      // substrings like "caption", so a captions *menu* or a "no captions
      // available" notice was enough to make the set non-empty and suppress the
      // only truly generic tier. What matters is whether anything found by name
      // has ever produced text — not whether anything matched.
      //
      // But it must also stop once ANY source is working, otherwise every
      // silence looks like failure and the sweep keeps adopting player chrome
      // that sits in the caption area.
      if (!this._produced.size && !this._everHadText) {
        for (const el of this._positionalCandidates(container)) candidates.add(el);
      }

      // Prune roots the site has thrown away, or we accumulate observers forever.
      for (const el of [...this._obs.keys()]) if (!el.isConnected) this._drop(el);

      for (const el of candidates) {
        if (this._domRoots.has(el)) continue;
        if (el.contains(this.video) || el === this.video) continue;
        if (el.tagName === 'VIDEO' || el.tagName === 'BUTTON' || el.closest('button')) continue;
        const r = el.getBoundingClientRect();
        if (r.width > innerWidth * 1.5) continue;          // page-wide junk
        // Observing a big subtree and reading innerText out of it on every
        // mutation is what wedges a tab. Caption containers are tiny; anything
        // large is not one.
        if (el.getElementsByTagName('*').length > 60) continue;

        // At the cap, surrender a slot held by a root that has never produced
        // text. Evicting only on disconnect meant eight wrong-but-attached
        // elements — easily picked before the real caption container exists —
        // locked the engine out for the rest of the session.
        if (this._domRoots.size >= MAX_SUB_ROOTS) {
          const dead = [...this._domRoots].find(x => !this._produced.has(x));
          if (!dead) break;
          this._drop(dead);
        }

        this._domRoots.add(el);
        // Only content changes make a root "hot". Attribute churn (style/class)
        // is animation and state toggling — page chrome does it constantly, and
        // counting it let an animated UI element win the recency check forever.
        const mo = new MutationObserver((recs) => {
          if (recs.some(r => r.type === 'childList' || r.type === 'characterData')) {
            this._lastMutated = el;
          }
          this._queueRead();
        });
        mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
        this._obs.set(el, mo);
        this.onRoot(el);
      }
      this._scanCanvas(container);
      this._readDom();
    }

    // Geometry-based caption hunt: only runs when nothing was found by name, and
    // only inside the player's own subtree, so it stays cheap.
    _positionalCandidates(container) {
      const out = [];
      const v = this.video;
      const vr = v.getBoundingClientRect();
      if (!vr.width || !vr.height) return out;
      const root = container || v.parentElement || document.body;
      let nodes;
      try { nodes = root.querySelectorAll('div,span,p,section'); } catch { return out; }
      if (nodes.length > 4000) return out;                 // pathological DOM, skip
      for (const el of nodes) {
        if (el === v || el.contains(v)) continue;
        if (el.children.length > 4) continue;
        if (el.querySelector('video,canvas,img,input,svg')) continue;
        const txt = (el.textContent || '').trim();
        if (!txt || txt.length > 200) continue;
        // Player chrome lives down here too. Reject clocks ("0:05 / 12:14"),
        // anything inside controls, and anything interactive.
        if (/^\s*\d+:\d{2}(:\d{2})?\s*(\/|of|-)?\s*(\d+:\d{2}(:\d{2})?)?\s*$/.test(txt)) continue;
        if (!/\p{L}/u.test(txt)) continue;           // no letters => not dialogue
        if (el.closest('button,[role="button"],[role="slider"],input,a')) continue;
        if (el.closest('[class*="control" i],[class*="toolbar" i],[class*="player-bar" i],[class*="progress" i],[class*="seek" i],[class*="menu" i]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 8) continue;
        // captions live in the lower half of the frame and span its middle
        if (r.top < vr.top + vr.height * 0.45) continue;
        if (r.bottom > vr.bottom + 60) continue;
        const cx = r.left + r.width / 2, vcx = vr.left + vr.width / 2;
        if (Math.abs(cx - vcx) > vr.width * 0.35) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        out.push(el);
        if (out.length >= MAX_SUB_ROOTS) break;
      }
      return out;
    }

    _drop(el) {
      const mo = this._obs.get(el);
      if (mo) { try { mo.disconnect(); } catch {} }
      this._obs.delete(el);
      this._domRoots.delete(el);
      this._produced.delete(el);
      this._seen.delete(el);
      if (this._lastMutated === el) this._lastMutated = null;
    }

    // A root is trusted only once its text has been observed to CHANGE. Player
    // chrome that happens to sit in the caption area holds one constant string;
    // real captions always change. Without this, an adopted chrome element was
    // rendered as a permanent subtitle through every silence.
    _rootText(el) {
      const t = this._extract(el);
      let st = this._seen.get(el);
      if (!st) { this._seen.set(el, { last: t, changed: false }); return ''; }
      if (t !== st.last) { st.last = t; st.changed = true; }
      return st.changed ? t : '';
    }

    _readDom() {
      // Prefer the root whose text just changed. Captions mutate every few
      // seconds; page chrome does not. The old rule — longest text wins — let a
      // static title or description outrank the real two-word caption forever.
      const hot = this._lastMutated;
      if (hot && this._domRoots.has(hot) && hot.isConnected && vis(hot, true)) {
        const t = this._rootText(hot);
        if (t) { this._produced.add(hot); this._set('dom', t); return; }
      }
      let best = '';
      for (const el of this._domRoots) {
        // Opacity is ignored here: players fade caption boxes in and out, and
        // treating mid-fade as invisible cleared the overlay in the middle of
        // a cue.
        if (!el.isConnected || !vis(el, true)) continue;
        const t = this._rootText(el);
        if (t) this._produced.add(el);
        if (t && t.length > best.length) { best = t; bestEl = el; }
      }
      this._set('dom', best);
    }

    _extract(el) {
      // Preserve the player's own line structure: block children => new lines.
      const lines = [];
      // Keep the player's own line breaks — collapsing them reflows captions
      // into one long line and changes how they read.
      const push = (s) => {
        for (const raw of String(s || '').split(/\r?\n/)) {
          const t = raw.replace(/[ \t ]+/g, ' ').trim();
          if (t) lines.push(t);
        }
      };
      const segs = el.querySelectorAll('.ytp-caption-segment, .player-timedtext-text-container, span, div');
      if (segs.length) {
        const blocks = [...el.children].filter(c => vis(c));
        if (blocks.length) {
          for (const b of blocks) push(b.innerText || b.textContent);
        } else push(el.innerText || el.textContent);
      } else push(el.innerText || el.textContent);
      const out = lines.join('\n').trim();
      return out.length > 400 ? '' : out;     // guard against grabbing a whole UI panel
    }

    /* ---- source 4: canvas subtitles (ASS/libass, e.g. Crunchyroll) ---- */
    _scanCanvas(container) {
      if (this._canvas && this._canvas.isConnected) return;
      const root = container || document.body;
      let found = null;
      try {
        for (const c of root.querySelectorAll('canvas')) {
          if (!vis(c)) continue;
          const r = c.getBoundingClientRect(), vr = this.video.getBoundingClientRect();
          // canvas overlaying the video area == subtitle/ASS layer
          if (Math.abs(r.width - vr.width) < vr.width * 0.25 &&
              Math.abs(r.height - vr.height) < vr.height * 0.25) { found = c; break; }
        }
      } catch {}
      this._canvas = found;
      this.onCanvas(found);
    }

    // Whichever source is currently producing text wins, in priority order.
    // Sources go quiet (empty string) between cues, so this self-heals when a
    // player switches renderers mid-stream.
    //
    // Order matters for correctness, not just quality. What the player RENDERS
    // is ground truth: it reflects the viewer's subtitle-delay setting, their
    // chosen language, and any re-timing the player applied. `timedtext` is the
    // raw subtitle file straight off the network — original timings, no offset,
    // and possibly not even the selected track. Ranking it first meant a viewer
    // who had nudged subtitle timing in the site's own player got the unshifted
    // file mirrored into the pop-out, permanently out of sync with the audio.
    // It is now the last resort, used only when nothing else is producing.
    _set(kind, text) {
      text = (text || '').replace(/\n{2,}/g, '\n').trim();
      if (this._src[kind] === text) return;
      this._src[kind] = text;
      const resolved = this._src.dom || this._src.cue || this._src.hook || this._src.timedtext || '';
      if (resolved === this.text) return;
      if (resolved) this._everHadText = true;
      this.text = resolved;
      this.onText(resolved);
    }

    _playerRoot() {
      let el = this.video, best = this.video.parentElement;
      for (let i = 0; i < 8 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const r = el.getBoundingClientRect(), vr = this.video.getBoundingClientRect();
        if (r.width >= vr.width * 0.9 && r.height >= vr.height * 0.9 && r.width < innerWidth * 1.2) best = el;
      }
      return best || document.body;
    }

    destroy() {
      this._destroyed = true;
      clearTimeout(this._rescan);
      for (const mo of this._obs.values()) { try { mo.disconnect(); } catch {} }
      this._obs.clear();
      try { window.removeEventListener('message', this._hookL); } catch {}
      try { window.postMessage({ __flox: 'FLOX_CTL', action: 'off' }, '*'); } catch {}
      for (const off of this._observers) { try { off(); } catch {} }
      this._observers.length = 0;
      try {
        const tt = this.video.textTracks;
        tt.removeEventListener('addtrack', this._trackAddL);
        tt.removeEventListener('change', this._trackAddL);
      } catch {}
      for (const [track, st] of this._trackState) {
        try { track.removeEventListener('cuechange', st.h); } catch {}
        try { track.mode = st.mode; } catch {}
      }
      this._trackState.clear();
      this._domRoots.clear();
      this._produced.clear();
      this._seen.clear();
      this._lastMutated = null;
    }
  }

  /* =========================================================================
   * PIP WINDOW
   * ======================================================================= */
  const PIP_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;width:100%;background:#000;overflow:hidden;
  font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;
  -webkit-user-select:none;user-select:none;cursor:default}
#stage{position:fixed;inset:0;display:grid;place-items:center;background:#000;
  opacity:var(--flox-opacity,1);will-change:opacity;contain:strict}
#stage video{width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;
  background:#000;display:block;outline:none}
#stage video::-webkit-media-controls{display:none!important}
#subcanvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;
  object-fit:contain;image-rendering:auto}
#subs{position:absolute;left:0;right:0;bottom:calc(var(--flox-sub-bottom,6) * 1%);
  display:flex;flex-direction:column;align-items:center;gap:.18em;
  padding:0 3%;pointer-events:none;z-index:5;text-align:center;
  font-size:calc(var(--flox-sub-size,4.2) * 1vh);font-weight:600;letter-spacing:.01em;
  color:var(--flox-sub-color,#fff);text-wrap:balance}
#subs.off,#subs:empty{display:none}
#subs .line{background:rgba(0,0,0,var(--flox-sub-bg,.55));padding:.08em .38em;border-radius:.18em;
  max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}
#subs.shadow .line{text-shadow:0 .06em .12em rgba(0,0,0,.95),0 0 .04em rgba(0,0,0,.9)}
#bar{position:absolute;left:0;right:0;bottom:0;z-index:20;display:flex;flex-direction:column;
  gap:2px;padding:6px 8px 7px;background:linear-gradient(to top,rgba(8,10,14,.92),rgba(8,10,14,0));
  transform:translateY(0);transition:transform .16s ease,opacity .16s ease;opacity:1}
#bar.hidden{transform:translateY(110%);opacity:0;pointer-events:none}
#bar.gone{display:none}
#seek{-webkit-appearance:none;appearance:none;width:100%;height:14px;background:transparent;cursor:pointer}
#seek::-webkit-slider-runnable-track{height:4px;border-radius:4px;
  background:linear-gradient(to right,#5b8cff var(--p,0%),rgba(255,255,255,.25) var(--p,0%))}
#seek::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:50%;
  background:#fff;margin-top:-3.5px;box-shadow:0 0 0 1px rgba(0,0,0,.4)}
#row{display:flex;align-items:center;gap:6px}
button{background:transparent;border:0;color:#e9edf5;width:26px;height:26px;border-radius:6px;
  display:grid;place-items:center;cursor:pointer;font-size:12px;line-height:1;flex:0 0 auto;
  transition:background .12s ease,color .12s ease}
button:hover{background:rgba(255,255,255,.14)}
button.on{color:#7ea6ff}
button.wide{width:auto;padding:0 7px;font-size:11px;font-weight:600}
#time{font-variant-numeric:tabular-nums;font-size:11px;opacity:.85;padding:0 2px;white-space:nowrap}
.sp{flex:1 1 auto}
input[type=range].mini{-webkit-appearance:none;appearance:none;width:64px;height:14px;background:transparent;cursor:pointer}
input[type=range].mini::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:rgba(255,255,255,.28)}
input[type=range].mini::-webkit-slider-thumb{-webkit-appearance:none;width:9px;height:9px;border-radius:50%;
  background:#fff;margin-top:-3px}
#toast{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:30;
  background:rgba(10,12,16,.86);padding:5px 10px;border-radius:8px;font-size:11.5px;
  opacity:0;transition:opacity .18s ease;pointer-events:none;white-space:nowrap}
#toast.show{opacity:1}
`;

  const ICON = {
    play: '▶', pause: '❚❚', back: '⟲', fwd: '⟳', cc: 'CC', pin: '📌',
    close: '✕', mute: '🔊', muted: '🔇', ret: '⇱'
  };

  class PiPSession {
    constructor(video) {
      this.video = video;
      this.win = null;
      this.subs = null;
      this.placeholder = null;
      this.prevStyle = null;
      this.mirrorVideo = null;
      this.rafId = 0;
      this.closed = false;
    }

    async open(settings) {
      S = settings || S;
      const v = this.video;
      const ar = (v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : 16 / 9;
      let w = S.rememberSize && S.lastSize ? S.lastSize.width : 640;
      let h = S.rememberSize && S.lastSize ? S.lastSize.height : Math.round(640 / ar);
      w = clamp(Math.round(w), 240, screen.availWidth - 20);
      h = clamp(Math.round(h), 140, screen.availHeight - 60);
      if (S.keepAspect && (!S.rememberSize || !S.lastSize)) h = Math.round(w / ar);

      // MUST be called synchronously on the user gesture.
      const pipPromise = documentPictureInPicture.requestWindow({
        width: w, height: h, disallowReturnToOpener: false
      });
      // If the timeout below wins the race, a later rejection here would surface
      // as an uncaught error. Attach a no-op handler so it can never escape.
      pipPromise.catch(() => {});
      // requestWindow() can hand back a window while leaving its promise pending
      // forever (observed in Chrome when the opener is backgrounded). Without
      // this, the session hangs and the user is left staring at a blank window.
      const win = this.win = await Promise.race([
        pipPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('pip-window-timeout')), 5000))
      ]).catch((e) => {
        const ghost = documentPictureInPicture.window;
        if (ghost) { try { ghost.close(); } catch {} }
        throw e;
      });

      const d = win.document;
      d.title = (document.title || 'Video').slice(0, 90);
      const style = d.createElement('style');
      style.textContent = PIP_CSS;
      d.head.appendChild(style);

      // Built node-by-node, never innerHTML: the PiP document inherits the opener's
      // CSP, and Trusted-Types sites (YouTube, GitHub, …) reject HTML string sinks.
      const mk = (tag, props) => Object.assign(d.createElement(tag), props || {});
      const stage = mk('div', { id: 'stage' });
      stage.appendChild(mk('canvas', { id: 'subcanvas', hidden: true }));
      stage.appendChild(mk('div', { id: 'subs' }));
      d.body.appendChild(stage);
      d.body.appendChild(mk('div', { id: 'toast' }));

      this.stage = d.getElementById('stage');
      this.subsEl = d.getElementById('subs');
      this.subCanvas = d.getElementById('subcanvas');
      this.toastEl = d.getElementById('toast');

      // Watchdog: no mount path may hang the window open on a blank stage.
      await Promise.race([
        this._mountVideo(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('mount-timeout')), 12000))
      ]);
      this._buildControls();
      this._applySettings(S);
      this._startSubtitles();
      this._wireWindow();

      send({ type: 'FLOX_OPENED', title: d.title });
      this.toast('Popped out' + (S.subtitles ? ' · subtitles on' : ''));
      return true;
    }

    /* --- move the real element (default) or mirror its stream --- */
    async _mountVideo() {
      if (this.video.readyState < 2) await this._waitReady(8000);

      // Move first. A real Document-PiP window keeps the media resource alive
      // across adoption (verified: currentTime preserved, no reload), and moving
      // means ONE element — one decode, one paint, nothing left running behind
      // in the tab. Mirroring costs a second paint of every frame, so it is the
      // fallback, not the default.
      if (S.mode !== 'stream') {
        this._mountMove();
        if (await this._verifyMove()) {
          this._armGuard();
          this._resumePlayback();
          return;
        }
        // Adoption did tear the source down (older engines, odd players).
        // Put it back untouched and mirror instead.
        this._restoreVideo();
        await this._waitReady(3000);
        this._resumePlayback();
        await this._waitAdvancing(4000);
      }

      // Never mirror DRM: it would "succeed" into a black window.
      if (isDRM(this.video)) throw new Error('drm-move-failed');

      if (await this._mountStream()) {
        if (S.mode !== 'stream') this.toast('Mirror mode (fallback)');
        return;
      }
      throw new Error(S.mode === 'stream' ? 'capture-unavailable' : 'video-transfer-failed');
    }

    // Relocating an element can pause it; put it back to how the user had it.
    _resumePlayback() {
      const was = this._moveState;
      if (!was || was.paused !== false) return;
      const v = this.video;
      const kick = () => { if (v.paused) { try { v.play().catch(() => {}); } catch {} } };
      kick();
      setTimeout(kick, 250);   // some players re-pause once during re-attach
    }

    _waitReady(ms) {
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (ok) => {
          clearInterval(iv); clearTimeout(to);
          v.removeEventListener('canplay', onPlay);
          v.removeEventListener('loadeddata', onPlay);
          resolve(ok);
        };
        const onPlay = () => { if (v.videoWidth) done(true); };
        v.addEventListener('canplay', onPlay);
        v.addEventListener('loadeddata', onPlay);
        const iv = setInterval(() => { if (v.readyState >= 2 && v.videoWidth) done(true); }, 60);
        const to = setTimeout(() => done(false), ms);
      });
    }

    _waitAdvancing(ms) {
      const v = this.video;
      return new Promise((resolve) => {
        let last = -1;
        const t0 = Date.now();
        const iv = setInterval(() => {
          const now = v.currentTime;
          if (v.readyState >= 3 && v.videoWidth > 0 && last >= 0 && now > last) {
            clearInterval(iv); resolve(true);
          } else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
          last = now;
        }, 120);
      });
    }

    async _mountStream() {
      const v = this.video, d = this.win.document;
      if (typeof v.captureStream !== 'function' || v.mediaKeys) return false;
      try {
        // A player that hasn't buffered yet yields a track with no frames, so
        // give it real time to become ready rather than failing instantly.
        await this._waitReady(v.readyState === 0 ? 8000 : 2500);
        const stream = v.captureStream();
        if (!stream || !stream.getVideoTracks().length) return false;
        const m = d.createElement('video');
        m.autoplay = true; m.playsInline = true; m.muted = true;   // audio stays on the page
        m.srcObject = stream;
        this.stage.prepend(m);
        this.mirrorVideo = m;
        m.play().catch(() => {});   // never awaited: a frameless stream never resolves
        // Confirm real frames actually arrive before calling this a success.
        const ok = await new Promise((resolve) => {
          const t0 = Date.now();
          const iv = setInterval(() => {
            if (m.videoWidth > 0 && m.readyState >= 2) { clearInterval(iv); resolve(true); }
            else if (Date.now() - t0 > 2500) { clearInterval(iv); resolve(false); }
          }, 80);
        });
        if (!ok) { try { m.srcObject = null; m.remove(); } catch {} this.mirrorVideo = null; }
        return ok;
      } catch { return false; }
    }

    // Did the element survive the jump? MSE-backed media resets to
    // readyState 0 / currentTime 0 when its resource is torn down.
    async _verifyMove() {
      const v = this.video, before = this._moveState;
      await new Promise(r => setTimeout(r, 260));
      if (!v.isConnected || v.ownerDocument !== this.win.document) return false;
      if (v.readyState === 0 && before.readyState > 0) return false;
      if (before.time > 1 && v.currentTime < 0.2) return false;
      return true;
    }

    _mountMove() {
      const v = this.video, d = this.win.document;
      this._moveState = { time: v.currentTime, paused: v.paused, readyState: v.readyState };

      // On players that fault when the bare element is removed, relocate their
      // container instead — the video keeps its parent chain intact.
      const moveEl = this.moveEl = moveTargetFor(v);
      const ph = this.placeholder = document.createElement('div');
      const r = moveEl.getBoundingClientRect();
      ph.setAttribute('data-flox-placeholder', '1');
      ph.style.cssText =
        `width:${r.width}px;height:${r.height}px;background:#000;` +
        `display:block;position:relative;pointer-events:none;`;
      this.prevStyle = v.getAttribute('style') || '';
      this.prevStyle = moveEl.getAttribute('style') || '';
      this.prevParent = moveEl.parentNode;
      this.prevNext = moveEl.nextSibling;
      moveEl.parentNode && moveEl.parentNode.insertBefore(ph, moveEl);
      this.stage.prepend(moveEl);

      if (moveEl === v) {
        v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;max-width:100%;max-height:100%;';
      } else {
        // Container move: let the site's own layout fill the window, and keep its
        // caption overlay positioned over the video exactly as it was.
        moveEl.style.cssText = 'position:relative;width:100%;height:100%;max-width:100%;max-height:100%;background:#000;';
        this.prevVideoStyle = v.getAttribute('style') || '';
        v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
      }
      v.controls = false;
    }

    // Armed only once a move is confirmed good — otherwise it races the
    // fallback path and tears the session down mid-mount.
    _armGuard() {
      const v = this.video, d = this.win.document;
      this._mo = new MutationObserver(() => {
        if (this.closed) return;
        if (!v.isConnected || v.ownerDocument !== d) this.close();
      });
      this._mo.observe(this.stage, { childList: true });
    }

    get activeVideo() { return this.mirrorVideo || this.video; }

    /* ------------------------------- controls ------------------------------ */
    _buildControls() {
      const d = this.win.document, v = this.video;
      const mk = (tag, props, attrs) => {
        const el = Object.assign(d.createElement(tag), props || {});
        for (const [k, val] of Object.entries(attrs || {})) el.setAttribute(k, val);
        return el;
      };
      const btn = (id, label, title, cls) =>
        mk('button', { id, textContent: label, title, className: cls || '' });
      const range = (id, min, max, step, title, cls) =>
        mk('input', { id, type: 'range', title, className: cls || '' },
           { min: String(min), max: String(max), step: String(step) });

      const bar = mk('div', { id: 'bar' });
      bar.appendChild(range('seek', 0, 1000, 1, 'Seek'));
      const row = mk('div', { id: 'row' });
      row.append(
        btn('b-play', v.paused ? ICON.play : ICON.pause, 'Play/Pause (Space)'),
        btn('b-back', ICON.back, 'Back 10s (←)'),
        btn('b-fwd', ICON.fwd, 'Forward 10s (→)'),
        btn('b-mute', v.muted ? ICON.muted : ICON.mute, 'Mute (M)'),
        range('vol', 0, 1, 0.02, 'Volume', 'mini'),
        mk('span', { id: 'time', textContent: '0:00 / 0:00' }),
        mk('span', { className: 'sp' }),
        btn('b-rate', '1×', 'Playback speed', 'wide'),
        btn('b-cc', ICON.cc, 'Subtitles (C)', 'wide'),
        range('op', 0.2, 1, 0.02, 'Opacity', 'mini'),
        btn('b-fit', '⤢', 'Fit window to video aspect'),
        btn('b-ret', ICON.ret, 'Back to tab'),
        btn('b-close', ICON.close, 'Close (Esc)')
      );
      bar.appendChild(row);
      d.body.appendChild(bar);
      this.bar = bar;
      const $ = (id) => d.getElementById(id);

      const seek = $('seek'), vol = $('vol'), op = $('op'), time = $('time');
      vol.value = String(v.volume);
      op.value = String(S.opacity);

      const fmt = (t) => {
        if (!isFinite(t) || t < 0) t = 0;
        const s = Math.floor(t % 60), m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
        return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
      };

      let seeking = false;
      const sync = () => {
        if (this.closed) return;
        const dur = v.duration;
        if (!seeking && isFinite(dur) && dur > 0) {
          const p = (v.currentTime / dur) * 1000;
          seek.value = String(p);
          seek.style.setProperty('--p', (p / 10) + '%');
        }
        time.textContent = fmt(v.currentTime) + ' / ' + (isFinite(dur) ? fmt(dur) : '—');
        $('b-play').textContent = v.paused ? ICON.play : ICON.pause;
        $('b-mute').textContent = v.muted || v.volume === 0 ? ICON.muted : ICON.mute;
      };
      // 4 Hz is plenty for a clock; keeps the compositor free while dragging.
      this._tick = setInterval(sync, 250); sync();

      seek.addEventListener('pointerdown', () => { seeking = true; });
      const commit = () => {
        if (isFinite(v.duration)) v.currentTime = (Number(seek.value) / 1000) * v.duration;
      };
      seek.addEventListener('input', () => {
        seek.style.setProperty('--p', (Number(seek.value) / 10) + '%');
        if (seeking) commit();
      });
      seek.addEventListener('pointerup', () => { seeking = false; commit(); });
      seek.addEventListener('change', () => { seeking = false; commit(); });

      $('b-play').onclick = () => this.playPause();
      $('b-back').onclick = () => { v.currentTime = Math.max(0, v.currentTime - 10); };
      $('b-fwd').onclick = () => { v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10); };
      $('b-mute').onclick = () => { v.muted = !v.muted; sync(); };
      vol.oninput = () => { v.volume = Number(vol.value); v.muted = v.volume === 0; };
      const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
      $('b-rate').onclick = () => {
        const i = RATES.indexOf(v.playbackRate);
        v.playbackRate = RATES[(i + 1) % RATES.length] ?? 1;
        $('b-rate').textContent = v.playbackRate + '×';
        this.toast('Speed ' + v.playbackRate + '×');
      };
      $('b-rate').textContent = v.playbackRate + '×';
      $('b-cc').onclick = () => this.setSetting({ subtitles: !S.subtitles });
      op.oninput = () => this.setSetting({ opacity: Number(op.value) }, true);
      op.onchange = () => this.setSetting({ opacity: Number(op.value) });
      $('b-fit').onclick = () => this.fitAspect();
      $('b-ret').onclick = () => { this.returnToTab(); };
      $('b-close').onclick = () => this.close();

      // hover-to-reveal, without touching layout
      const showBar = () => {
        bar.classList.remove('hidden');
        clearTimeout(this._hideT);
        if (S.hoverControls) this._hideT = setTimeout(() => bar.classList.add('hidden'), 2200);
      };
      this.win.addEventListener('pointermove', showBar, { passive: true });
      this.win.addEventListener('pointerdown', showBar, { passive: true });
      this.win.document.addEventListener('pointerleave', () => {
        if (S.hoverControls) bar.classList.add('hidden');
      });
      this._showBar = showBar;
      showBar();

      // double-click / click on the video area
      this.stage.addEventListener('click', (e) => {
        if (e.target.closest('#bar')) return;
        this.playPause();
      });

      this.win.addEventListener('keydown', (e) => {
        const k = e.key.toLowerCase();
        // Alt+, closes from inside the window too, so the same key toggles
        // regardless of which window has focus.
        if (e.altKey && (e.code === 'Comma' || k === ',')) { e.preventDefault(); this.close(); return; }
        const map = {
          ' ': () => this.playPause(),
          k: () => this.playPause(),
          arrowleft: () => { v.currentTime -= 5; },
          arrowright: () => { v.currentTime += 5; },
          j: () => { v.currentTime -= 10; },
          l: () => { v.currentTime += 10; },
          arrowup: () => { v.volume = clamp(v.volume + 0.05, 0, 1); },
          arrowdown: () => { v.volume = clamp(v.volume - 0.05, 0, 1); },
          m: () => { v.muted = !v.muted; },
          c: () => this.setSetting({ subtitles: !S.subtitles }),
          escape: () => this.close()
        };
        const fn = map[k];
        if (fn) { e.preventDefault(); fn(); sync(); showBar(); }
      });
    }

    playPause() {
      const v = this.video;
      if (v.paused) v.play().catch(() => {}); else v.pause();
    }

    fitAspect() {
      const v = this.video;
      const ar = (v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : 16 / 9;
      const w = this.win.innerWidth;
      const chrome_ = this.win.outerHeight - this.win.innerHeight;
      try { this.win.resizeTo(this.win.outerWidth, Math.round(w / ar) + chrome_); this.toast('Aspect fitted'); }
      catch { this.toast('Resize blocked by browser'); }
    }

    returnToTab() {
      try { chrome.runtime.sendMessage({ type: 'FLOX_FOCUS_TAB' }); } catch {}
      this.close();
      try { window.focus(); this.video.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
    }

    toast(msg) {
      if (!this.toastEl) return;
      this.toastEl.textContent = msg;
      this.toastEl.classList.add('show');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => this.toastEl.classList.remove('show'), 1400);
    }

    /* ------------------------------ subtitles ------------------------------ */
    _startSubtitles() {
      // If we moved the player's container, the site's own caption overlay came
      // with it and is already rendering inside the window — drawing ours too
      // would double every line.
      if (this.moveEl && this.moveEl !== this.video) {
        const prof = SITE_PROFILES.find(p => p.host.test(location.hostname));
        if (prof) {
          try {
            if (this.win.document.querySelector(prof.sel)) {
              this._hostSubs = true;
              this.subsEl.classList.add('off');
              this.toast('Using player’s own subtitles');
            }
          } catch {}
        }
      }
      this.subs = new SubtitleEngine(this.video);
      this.subs.onText = (text) => this._renderSubs(text);
      this.subs.onCanvas = (canvas) => this._bindCanvas(canvas);
      this.subs.start();
    }

    _renderSubs(text) {
      if (this.closed || !this.subsEl) return;
      const d = this.win.document;
      // Rebuild only when content changed (SubtitleEngine already dedupes).
      this.subsEl.textContent = '';
      if (!text) return;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const el = d.createElement('div');
        el.className = 'line';
        el.textContent = line;
        this.subsEl.appendChild(el);
      }
    }

    // Pixel-mirror for canvas-rendered (ASS/libass) subtitle layers.
    _bindCanvas(src) {
      cancelAnimationFrame(this.rafId);
      if (!src || !this.subCanvas) { if (this.subCanvas) this.subCanvas.hidden = true; return; }
      const dst = this.subCanvas;
      dst.hidden = !S.subtitles;
      const ctx = dst.getContext('2d', { alpha: true, desynchronized: true });
      let lastW = 0, lastH = 0;
      const draw = () => {
        if (this.closed) return;
        this.rafId = this.win.requestAnimationFrame(draw);
        if (!S.subtitles || !src.isConnected) return;
        if (src.width !== lastW || src.height !== lastH) {
          lastW = dst.width = src.width; lastH = dst.height = src.height;
        }
        if (!lastW || !lastH) return;
        try { ctx.clearRect(0, 0, lastW, lastH); ctx.drawImage(src, 0, 0); } catch {}
      };
      this.rafId = this.win.requestAnimationFrame(draw);
    }

    /* ------------------------------ settings ------------------------------- */
    _applySettings(s) {
      S = { ...S, ...s };
      if (this.closed || !this.win) return;
      const root = this.win.document.documentElement.style;
      root.setProperty('--flox-opacity', String(S.transparencyEnabled ? S.opacity : 1));
      root.setProperty('--flox-sub-size', String(S.subtitleSize));
      root.setProperty('--flox-sub-color', S.subtitleColor);
      root.setProperty('--flox-sub-bg', String(S.subtitleBg));
      root.setProperty('--flox-sub-bottom', String(S.subtitleBottom));
      this.subsEl.classList.toggle('off', !S.subtitles || !!this._hostSubs);
      this.subsEl.classList.toggle('shadow', !!S.subtitleShadow);
      if (this.subCanvas) this.subCanvas.hidden = !S.subtitles || !this.subs || !this.subs._canvas;
      if (this.bar) {
        this.bar.classList.toggle('gone', !S.showControls);
        if (!S.hoverControls) { this.bar.classList.remove('hidden'); clearTimeout(this._hideT); }
        else if (this._showBar) this._showBar();
        const cc = this.win.document.getElementById('b-cc');
        if (cc) cc.classList.toggle('on', !!S.subtitles);
        const op = this.win.document.getElementById('op');
        if (op && op.value !== String(S.opacity)) op.value = String(S.opacity);
      }
    }

    setSetting(patch, localOnly) {
      this._applySettings(patch);
      if (!localOnly) { try { chrome.storage.sync.set(patch); } catch {} }
      if ('subtitles' in patch) this.toast('Subtitles ' + (patch.subtitles ? 'on' : 'off'));
    }

    // Puts a moved element back exactly where it came from. Safe to call twice.
    _restoreVideo() {
      const v = this.video, state = this._moveState || { paused: v.paused, time: 0 };
      if (!this.placeholder) return state;
      const moved = this.moveEl || v;
      try {
        if (this.placeholder.parentNode) this.placeholder.parentNode.insertBefore(moved, this.placeholder);
        else if (this.prevParent) this.prevParent.insertBefore(moved, this.prevNext);
        this.placeholder.remove();
        if (this.prevStyle) moved.setAttribute('style', this.prevStyle); else moved.removeAttribute('style');
        if (moved !== v) {
          if (this.prevVideoStyle) v.setAttribute('style', this.prevVideoStyle); else v.removeAttribute('style');
        }
        // A torn-down MSE resource needs a nudge back to where the user was.
        if (state.time > 1 && v.currentTime < 0.2 && isFinite(v.duration)) {
          try { v.currentTime = state.time; } catch {}
        }
      } catch {}
      this.placeholder = null;
      try { this._mo && this._mo.disconnect(); } catch {}
      return state;
    }

    /* -------------------------------- close -------------------------------- */
    _wireWindow() {
      this.win.addEventListener('pagehide', () => this.close(), { once: true });
      this.win.addEventListener('unload', () => this.close(), { once: true });
      this.win.addEventListener('resize', () => {
        clearTimeout(this._szT);
        this._szT = setTimeout(() => {
          if (this.closed || !S.rememberSize) return;
          try {
            chrome.storage.sync.set({
              lastSize: { width: this.win.outerWidth || 640, height: this.win.outerHeight || 360 }
            });
          } catch {}
        }, 400);
      }, { passive: true });
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this._tick);
      cancelAnimationFrame(this.rafId);
      try { this._mo && this._mo.disconnect(); } catch {}
      if (this.subs) { this.subs.destroy(); this.subs = null; }

      const v = this.video;
      this._restoreVideo();
      if (this.mirrorVideo) { try { this.mirrorVideo.srcObject = null; this.mirrorVideo.remove(); } catch {} }

      if (S.pauseOnClose) { try { v.pause(); } catch {} }
      try { this.win && this.win.close(); } catch {}
      this.win = null;
      send({ type: 'FLOX_CLOSED' });
      if (current === this) current = null;
    }
  }

  /* =========================================================================
   * FALLBACK: browsers without Document PiP → native PiP with burned-in subs
   * ======================================================================= */
  class CanvasFallbackSession {
    constructor(video) { this.video = video; this.closed = false; }

    async open(settings) {
      S = settings || S;
      const v = this.video;
      const c = this.canvas = document.createElement('canvas');
      c.width = v.videoWidth || 1280; c.height = v.videoHeight || 720;
      c.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none;';
      document.body.appendChild(c);
      const ctx = c.getContext('2d', { alpha: false, desynchronized: true });

      const out = this.out = document.createElement('video');
      out.muted = true; out.playsInline = true;
      // Off-screen, but never display:none — PiP refuses a non-rendered element.
      out.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;opacity:0.01;pointer-events:none;';
      // Paint one frame BEFORE capturing, so the stream carries content from its
      // very first tick. Everything between the user's click and
      // requestPictureInPicture() below spends transient user activation, which
      // Chrome expires after ~5s — that is what used to make the request fail
      // and force a confirmation prompt. Nothing slow may go above that call.
      try { ctx.drawImage(v, 0, 0, c.width, c.height); } catch {}
      out.srcObject = c.captureStream(30);
      document.body.appendChild(out);
      out.play().catch(() => {});   // never awaited: a frameless stream never resolves

      const drawFrame = () => {
        if (this.closed) return;
        if (v.videoWidth && (c.width !== v.videoWidth || c.height !== v.videoHeight)) {
          c.width = v.videoWidth; c.height = v.videoHeight;
        }
        try { ctx.drawImage(v, 0, 0, c.width, c.height); } catch {}
        const text = S.subtitles ? (this.subs.text || '') : '';
        if (text) {
          const size = Math.round(c.height * (S.subtitleSize / 100) * 1.15);
          ctx.font = `600 ${size}px system-ui, "Segoe UI", sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          const lines = text.split('\n');
          let y = c.height - c.height * (S.subtitleBottom / 100);
          for (let i = lines.length - 1; i >= 0; i--) {
            const m = ctx.measureText(lines[i]);
            ctx.fillStyle = `rgba(0,0,0,${S.subtitleBg})`;
            ctx.fillRect(c.width / 2 - m.width / 2 - size * 0.2, y - size * 1.05, m.width + size * 0.4, size * 1.25);
            ctx.fillStyle = S.subtitleColor;
            ctx.fillText(lines[i], c.width / 2, y);
            y -= size * 1.3;
          }
        }
        // Always rAF: a frame-callback loop stalls the moment the source pauses,
        // which kills the canvas stream and desyncs the window's controls.
        this._raf = requestAnimationFrame(drawFrame);
      };
      drawFrame();

      // PiP refuses an element with no frames, so we still have to wait — but a
      // frame was already painted above, so this resolves in a tick or two. The
      // budget is deliberately small: overrunning it costs the user activation.
      const ready = await new Promise((resolve) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (out.videoWidth > 0 && out.readyState >= 2) { clearInterval(iv); resolve(true); }
          else if (Date.now() - t0 > 1200) { clearInterval(iv); resolve(false); }
        }, 20);
      });
      if (!ready) throw new Error('canvas-stream-no-frames');

      // Consume the activation NOW, before subtitles or anything else runs.
      await out.requestPictureInPicture();
      out.addEventListener('leavepictureinpicture', () => this.close(), { once: true });

      this.subs = new SubtitleEngine(v);
      this.subs.start();

      /* Play/pause sync.
       *
       * The PiP window's buttons act on the element it hosts — the mirror — so
       * the mirror must track `v.paused` exactly or the button shows the wrong
       * action. That makes the two elements drive each other, and the old guard
       * was a window (`_syncing` cleared on an 80ms timer): if an event landed
       * late it was read as user intent and toggled playback back, which is the
       * stale/fighting state. The guard is now an explicit expectation, so it
       * cannot expire early or late — exactly one event is ever swallowed.
       */
      const applyToMirror = (paused) => {
        if (paused === out.paused) return;
        this._expect = paused ? 'pause' : 'play';
        if (paused) out.pause();
        else out.play().catch(() => { this._expect = null; });
      };
      const fromMirror = (paused) => {
        if (this.closed) return;
        if (this._expect === (paused ? 'pause' : 'play')) { this._expect = null; return; }
        this._expect = null;
        this._lastAction = paused ? 'user paused' : 'user played';
        if (paused === v.paused) return;             // already in the wanted state
        if (paused) v.pause();
        else v.play().catch((e) => { this._lastAction = 'play rejected: ' + e.name; });
      };

      out.addEventListener('pause', () => fromMirror(true));
      out.addEventListener('play', () => fromMirror(false));
      this._onSrcPause = () => applyToMirror(true);
      this._onSrcPlay = () => applyToMirror(false);
      v.addEventListener('pause', this._onSrcPause);
      v.addEventListener('play', this._onSrcPlay);
      applyToMirror(v.paused);                       // start already in sync

      this._wireMediaSession();
      this._hideSource();
      send({ type: 'FLOX_OPENED', title: document.title });
      return true;
    }

    /* The window's buttons belong to the browser and act on the canvas stream,
     * which has no timeline — so they did nothing. Media Session routes them to
     * the real element instead, and publishes the true position for the bar. */
    _wireMediaSession() {
      const v = this.video;
      const ms = navigator.mediaSession;
      if (!ms || !('setActionHandler' in ms)) return;
      this._msSaved = true;

      const set = (name, fn) => { try { ms.setActionHandler(name, fn); } catch {} };
      const claim = () => {
        // No play/pause handlers. The mirror's own pause/play event already
        // carries the button press; handling it here as well toggled twice and
        // left the two elements fighting.
        set('seekbackward', (d) => { v.currentTime = Math.max(0, v.currentTime - ((d && d.seekOffset) || 10)); });
        set('seekforward', (d) => { v.currentTime = Math.min(v.duration || 1e9, v.currentTime + ((d && d.seekOffset) || 10)); });
        set('seekto', (d) => { if (d && d.seekTime != null) v.currentTime = d.seekTime; });
        set('previoustrack', null);
        set('nexttrack', null);
      };
      claim();

      const publish = () => {
        if (this.closed) return;
        // Players re-register their own handlers as they update state, which
        // silently steals the window's buttons back. Re-claim them each tick.
        claim();
        try {
          ms.playbackState = v.paused ? 'paused' : 'playing';
          if (isFinite(v.duration) && v.duration > 0) {
            ms.setPositionState({
              duration: v.duration,
              playbackRate: v.playbackRate || 1,
              position: Math.min(v.currentTime, v.duration)
            });
          }
        } catch {}
      };
      this._msTimer = setInterval(publish, 500);
      publish();
    }

    /* One decode, one paint. The source keeps decoding (we draw from it) but the
     * tab must stop painting it, otherwise the video plays twice on screen. */
    _hideSource() {
      const v = this.video;
      this._srcStyle = v.getAttribute('style') || '';
      v.style.setProperty('visibility', 'hidden', 'important');
      const prof = SITE_PROFILES.find(p => p.host.test(location.hostname));
      this._hidden = [];
      const hide = (el) => {
        if (!el || el === v) return;
        this._hidden.push([el, el.getAttribute('style') || '']);
        el.style.setProperty('visibility', 'hidden', 'important');
      };
      if (prof) { try { document.querySelectorAll(prof.sel).forEach(hide); } catch {} }
      if (this.subs) {
        for (const el of this.subs._domRoots) hide(el);
        // The engine keeps discovering roots every few seconds after this point.
        // Without hiding those too, late captions float over a hidden video.
        this.subs.onRoot = hide;
      }
    }

    _restoreSource() {
      const v = this.video;
      if (this.subs) this.subs.onRoot = () => {};
      try { v.removeEventListener('play', this._onSrcPlay); } catch {}
      try { v.removeEventListener('pause', this._onSrcPause); } catch {}
      try {
        if (this._srcStyle) v.setAttribute('style', this._srcStyle);
        else v.removeAttribute('style');
      } catch {}
      for (const [el, style] of this._hidden || []) {
        try { if (style) el.setAttribute('style', style); else el.removeAttribute('style'); } catch {}
      }
      this._hidden = null;
      if (this._msTimer) { clearInterval(this._msTimer); this._msTimer = null; }
      if (this._msSaved) {
        for (const a of ['seekbackward', 'seekforward', 'seekto']) {
          try { navigator.mediaSession.setActionHandler(a, null); } catch {}
        }
        this._msSaved = false;
      }
    }

    setSetting(patch) { S = { ...S, ...patch }; try { chrome.storage.sync.set(patch); } catch {} }
    _applySettings(patch) { S = { ...S, ...patch }; }

    close() {
      if (this.closed) return;
      this.closed = true;
      cancelAnimationFrame(this._raf);
      this._restoreSource();          // un-hide the page before anything else
      this.subs && this.subs.destroy();
      exitPiP();
      try { this.out.remove(); this.canvas.remove(); } catch {}
      send({ type: 'FLOX_CLOSED' });
      if (current === this) current = null;
    }
  }

  /* =========================================================================
   * NATIVE PIP — the browser's own window.
   * For DRM (Netflix, Prime, Max…) the protected video pipeline is composited
   * by the browser, so this is the only path that reliably SHOWS the picture.
   * The tradeoff is real and unavoidable: the browser owns that window, so no
   * custom subtitle overlay can be drawn into it.
   * ======================================================================= */
  class NativePiPSession {
    constructor(video) { this.video = video; this.closed = false; }

    async open() {
      const v = this.video;
      if (!document.pictureInPictureEnabled) throw new Error('native-pip-disabled');
      try { if (v.disablePictureInPicture) v.disablePictureInPicture = false; } catch {}
      if (v.readyState < 2) {
        await new Promise((r) => {
          const done = () => { v.removeEventListener('canplay', done); r(); };
          v.addEventListener('canplay', done); setTimeout(done, 8000);
        });
      }
      await v.requestPictureInPicture();
      this._leave = () => this.close();
      v.addEventListener('leavepictureinpicture', this._leave, { once: true });
      this._startCueBridge();
      send({ type: 'FLOX_OPENED', title: document.title });
      return true;
    }

    /* --- subtitle bridge ---------------------------------------------------
     * The browser owns this window, so no overlay can be drawn into it — but it
     * DOES render native TextTrack cues. Players like Netflix draw captions as
     * DOM, which never reach it. So: read their DOM captions and feed them into
     * a synthetic track on the same element. Chrome then renders them itself,
     * inside its own PiP window, over protected video we cannot touch.
     * -------------------------------------------------------------------- */
    _startCueBridge() {
      if (!S.subtitles) return;
      let track;
      try {
        track = this.video.addTextTrack('captions', 'Flox', 'x-flox');
        try { track.__flox = true; } catch {}
        track.mode = 'showing';
      } catch { return; }
      this._track = track;

      this.subs = new SubtitleEngine(this.video);
      this.subs.onText = (text) => {
        if (this.closed) return;
        const t = this.video.currentTime;
        // End whatever is on screen, then show the new line.
        if (this._cue) {
          try { this._cue.endTime = Math.max(t, this._cue.startTime + 0.05); } catch {}
          this._cue = null;
        }
        if (!text) return;
        try {
          const Cue = window.VTTCue || window.TextTrackCue;
          const cue = new Cue(t, t + 12, text);   // trimmed when the next line lands
          cue.line = -3;
          track.addCue(cue);
          this._cue = cue;
          // Drop cues that are well behind playback — a feature-length film
          // would otherwise pile up thousands of dead ones.
          const cues = track.cues;
          if (cues && cues.length > 40) {
            for (const c of [...cues]) {
              if (c !== cue && c.endTime < t - 30) { try { track.removeCue(c); } catch {} }
            }
          }
        } catch {}
      };
      this.subs.start();
    }

    _applySettings(s) {
      S = { ...S, ...s };
      if (this._track) this._track.mode = S.subtitles ? 'showing' : 'disabled';
    }
    setSetting(patch) { this._applySettings(patch); try { chrome.storage.sync.set(patch); } catch {} }

    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.subs) { this.subs.destroy(); this.subs = null; }
      if (this._track) {
        try {
          for (const c of [...(this._track.cues || [])]) this._track.removeCue(c);
          this._track.mode = 'disabled';
        } catch {}
        this._track = null;
      }
      try { this.video.removeEventListener('leavepictureinpicture', this._leave); } catch {}
      exitPiP();
      send({ type: 'FLOX_CLOSED' });
      if (current === this) current = null;
    }
  }

  /* =========================================================================
   * ENTRY POINTS
   * ======================================================================= */
  let current = null;

  // Pop-out is never gated behind a confirmation. Both PiP APIs need transient
  // user activation, which expires ~5s after the click, so every session path
  // must reach its request call immediately — see CanvasFallbackSession.open().
  // If one still gets refused we report it and stop; we do not ask the user to
  // click again.
  const REASONS = {
    'no-video': 'Flox: no video found on this page.',
    'not-playing': 'Flox: the video is paused — start it, then try again.',
    'drm-move-failed': 'Flox: this player is DRM-protected. Turn on “use the browser’s own PiP window” in Flox settings.',
    'pip-window-timeout': 'Flox: the browser never opened the pop-out window. Try again.',
    'mount-timeout': 'Flox: the player did not hand over its video in time.',
    'capture-unavailable': 'Flox: this video cannot be captured.',
    'video-transfer-failed': 'Flox: this player refused to release its video.',
    'canvas-stream-no-frames': 'Flox: no frames from this player — try again once it is playing.',
    'native-pip-disabled': 'Flox: picture-in-picture is disabled in your browser settings.'
  };
  const explain = (reason) => REASONS[reason] || ('Flox: could not pop out (' + reason + ')');

  async function toggle({ force = false, settings } = {}) {
    if (settings) S = { ...S, ...settings };

    if (current) { current.close(); return { ok: true, action: 'closed', score: 1 }; }

    const { video, score } = pickVideo();
    if (!video) return { ok: false, score: 0, reason: 'no-video' };
    const playing = !video.paused && !video.ended;
    if (!playing && !force) return { ok: false, score, reason: 'not-playing' };

    // Sites set this attribute to block pop-out entirely. Clearing it is what
    // every working PiP extension does, and it costs nothing.
    try { if (video.disablePictureInPicture) video.disablePictureInPicture = false; } catch {}

    // DRM: the protected picture is composited by the browser, so use its own
    // PiP window. A Document-PiP window shows a black rectangle instead.
    const useNative = document.pictureInPictureEnabled &&
      (S.forceNative === true || (S.drmNative !== false && isDRM(video)));

    // Clean mode: the browser's own PiP window has no title bar, but nothing can
    // be drawn into it — so we composite video + subtitles into a canvas and send
    // that instead. Bezel-less frame, subtitles still visible. Capture is blocked
    // on DRM, so protected sites can't use it.
    const useClean = S.cleanWindow === true && !useNative && !isDRM(video) &&
      document.pictureInPictureEnabled && typeof video.captureStream === 'function';

    const Session = useNative ? NativePiPSession
      : useClean ? CanvasFallbackSession
      : (hasDocPiP ? PiPSession : CanvasFallbackSession);
    const session = new Session(video);
    current = session;
    try {
      await session.open(S);
      return { ok: true, action: 'opened', score };
    } catch (e) {
      current = null;
      try { session.close(); } catch {}
      return { ok: false, score, reason: String((e && e.message) || e) };
    }
  }

  globalThis.__FLOX__ = {
    toggle,
    // The worker arbitrates between frames, so it — not this frame — is the one
    // that knows a toggle failed everywhere. It reports back through here.
    notify: (reason) => { hud(explain(reason)); },
    isOpen: () => !!current,
    close: () => { current && current.close(); },
    probe: () => pickVideo().score,
    stats: () => {
      const s = current && current.subs;
      return {
        open: !!current,
        mode: current ? (current.mirrorVideo ? 'stream' : 'move') : null,
        subRoots: s ? s._domRoots.size : 0,
        observers: s ? s._obs.size : 0,
        text: s ? s.text : '',
        lastAction: current ? current._lastAction || null : null,
        sources: s ? s._src : null
      };
    }
  };

  /* -------------------------------------------------------------- hotkey ---
   * Alt+, is handled here, in the page, rather than through chrome.commands.
   * A real keypress carries its own user activation, so requestWindow() is
   * allowed — and it can't be lost to a shortcut-registration conflict with
   * another extension, which is how command-based hotkeys silently die.
   * (Alt+P was the old binding; Opera GX claims it for its own settings page.)
   * ------------------------------------------------------------------------ */
  function isTyping(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function onHotkey(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    // Match on physical key first: Alt on some layouts rewrites e.key entirely
    // (AltGr composition, non-US layouts), and e.code stays stable across all
    // of them. e.key is only the fallback for layouts that remap the position.
    if (e.code !== 'Comma' && e.key !== ',' && e.key !== '<') return;
    if (isTyping(e.target) || isTyping(document.activeElement)) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    if (current) { current.close(); return; }
    const { video, score } = pickVideo();
    if (video && score > 0) {
      toggle({ force: true }).then((r) => {
        if (!r.ok) hud(explain(r.reason));
      }).catch((err) => hud(explain(String(err && err.message || err))));
    } else {
      // No video in this frame — let the worker find the frame that has one.
      send({ type: 'FLOX_HOTKEY' });
    }
  }
  // capture phase, so player pages that swallow keys can't eat it first
  window.addEventListener('keydown', onHotkey, true);
  document.addEventListener('keydown', onHotkey, true);

  /* live settings + popup messages */
  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'FLOX_SETTINGS') {
      S = { ...S, ...msg.patch };
      if (current && current._applySettings) current._applySettings(S);
    } else if (msg.type === 'FLOX_PROBE') {
      respond({ score: pickVideo().score, open: !!current });
      return true;
    } else if (msg.type === 'FLOX_CLOSE') {
      current && current.close();
    }
  });

  /* initial settings load */
  try {
    chrome.storage.sync.get(DEFAULTS).then((s) => { S = { ...DEFAULTS, ...s }; }).catch(() => {});
  } catch {}

  /* optional: auto pop-out when the tab goes to the background */
  document.addEventListener('visibilitychange', () => {
    if (!S.autoPipOnTabHide || document.visibilityState !== 'hidden' || current) return;
    const { video } = pickVideo();
    if (video && !video.paused) toggle({ force: true }).catch(() => {});
  });

  /* keep the PiP window alive across SPA navigations (YouTube, Netflix) */
  window.addEventListener('pagehide', () => { current && current.close(); });
})();
