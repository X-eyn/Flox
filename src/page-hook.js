/* ==========================================================================

 * Flox — page-world hook.

 * Some players (Netflix, Prime, several DASH/HLS stacks) create TextTracks but

 * keep them `disabled` and draw captions with their own renderer, so `cuechange`

 * never fires for us. This hook records every cue the page ever adds and, while

 * PiP is active, reports whatever cue covers the current playback time.

 * It only observes — it never changes what the page renders.

 * ========================================================================== */

(() => {

  if (window.__FLOX_HOOK__) return;

  window.__FLOX_HOOK__ = true;



  const TAG = 'FLOX_HOOK';

  let active = false;

  let timer = 0;

  const tracks = new Set();          // TextTrack objects we've seen cues on

  const media = new Set();           // media elements we've seen



  const post = (payload) => window.postMessage({ __flox: TAG, ...payload }, '*');



  /* ========================================================================

   * TIMEDTEXT INTERCEPTOR

   * Players that draw their own captions (Netflix above all) fetch the

   * subtitle file over the network — TTML/IMSC or WebVTT — and never expose it

   * as a TextTrack. Reading that response gives real text WITH real timings,

   * independent of whatever DOM they render into. Read-only: the response is

   * passed through untouched, we just keep a copy.

   * ===================================================================== */

  const SUB_URL = /timedtext|dfxp|ttml|imsc|webvtt|\bsubtitle|\/\?o=\d/i;

  const SUB_BODY = /^\s*WEBVTT|<tt[\s>]|<tt:tt[\s>]|xmlns[^>]*ttml/i;

  let cues = [];            // {s, e, t} seconds + text, sorted by start



  function parseClock(v, tickRate) {

    if (v == null) return NaN;

    v = String(v).trim();

    let m = v.match(/^(\d+(?:\.\d+)?)t$/i);            // TTML ticks

    if (m) return parseFloat(m[1]) / (tickRate || 10000000);

    m = v.match(/^(\d+(?:\.\d+)?)(ms|s|h|m)$/i);       // offset time

    if (m) {

      const n = parseFloat(m[1]), u = m[2].toLowerCase();

      return u === 'ms' ? n / 1000 : u === 's' ? n : u === 'm' ? n * 60 : n * 3600;

    }

    m = v.match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/); // hh:mm:ss.mmm

    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +('0.' + m[4]) : 0);

    m = v.match(/^(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/);       // mm:ss.mmm

    if (m) return (+m[1]) * 60 + (+m[2]) + (m[3] ? +('0.' + m[3]) : 0);

    return NaN;

  }



  const clean = (s) => String(s || '')

    .replace(/<br\s*\/?>/gi, '\n')

    .replace(/<\/?[^>]+>/g, '')

    .replace(/&(#?\w+);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e]

      || (/^#\d+$/.test(e) ? String.fromCharCode(+e.slice(1)) : m)))

    .replace(/[ \t]+/g, ' ')

    .replace(/\n{2,}/g, '\n')

    .trim();



  function parseTTML(text) {

    const out = [];

    const tickM = text.match(/ttp:tickRate\s*=\s*["'](\d+)["']/i);

    const tickRate = tickM ? +tickM[1] : 10000000;

    // <p begin=".." end=".."> … </p>  (attribute order varies by encoder)

    const re = /<(?:tt:)?p\b([^>]*)>([\s\S]*?)<\/(?:tt:)?p>/gi;

    let m;

    while ((m = re.exec(text))) {

      const attrs = m[1];

      const b = (attrs.match(/\bbegin\s*=\s*["']([^"']+)["']/i) || [])[1];

      const e = (attrs.match(/\bend\s*=\s*["']([^"']+)["']/i) || [])[1];

      const dur = (attrs.match(/\bdur\s*=\s*["']([^"']+)["']/i) || [])[1];

      const s = parseClock(b, tickRate);

      let end = parseClock(e, tickRate);

      if (!isFinite(end) && dur != null) end = s + parseClock(dur, tickRate);

      const t = clean(m[2]);

      if (isFinite(s) && isFinite(end) && t) out.push({ s, e: end, t });

    }

    return out;

  }



  function parseVTT(text) {

    const out = [];

    for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {

      const line = block.split('\n').find(l => l.includes('-->'));

      if (!line) continue;

      const [a, b] = line.split('-->').map(x => x.trim().split(/\s+/)[0]);

      const s = parseClock(a), e = parseClock(b);

      const t = clean(block.split('\n').filter(l => !l.includes('-->') && !/^\d+$/.test(l.trim())).join('\n'));

      if (isFinite(s) && isFinite(e) && t) out.push({ s, e, t });

    }

    return out;

  }



  function ingest(url, text) {

    if (!text || text.length < 20 || !SUB_BODY.test(text.slice(0, 400))) return;

    let parsed = /^\s*WEBVTT/i.test(text) ? parseVTT(text) : parseTTML(text);

    if (!parsed.length) return;

    parsed.sort((a, b) => a.s - b.s);

    cues = parsed;

    // The content script owns the video element (which may have been moved into

    // a PiP document), so it resolves the current cue. We just hand over the list.

    post({ event: 'timedtext-list', count: cues.length, cues: parsed, url: String(url).slice(0, 120) });

  }



  try {

    const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (m, u) { this.__floxUrl = u; return XO.apply(this, arguments); };

    XMLHttpRequest.prototype.send = function () {

      try {

        if (SUB_URL.test(this.__floxUrl || '')) {

          this.addEventListener('load', () => {

            try {

              const rt = this.responseType;

              if (rt === '' || rt === 'text') ingest(this.__floxUrl, this.responseText);

              else if (rt === 'arraybuffer' && this.response && this.response.byteLength < 4e6) {

                ingest(this.__floxUrl, new TextDecoder().decode(new Uint8Array(this.response)));

              }

            } catch {}

          });

        }

      } catch {}

      return XS.apply(this, arguments);

    };

  } catch {}



  try {

    const of = window.fetch;

    window.fetch = function (input, init) {

      const url = typeof input === 'string' ? input : (input && input.url) || '';

      const p = of.apply(this, arguments);

      p.then((r) => {

        try {

          // Match on URL, or on a content type that could carry subtitles.

          // Anything else is never read, so normal traffic is untouched.

          const ct = (r.headers && r.headers.get('content-type') || '').toLowerCase();

          const looks = SUB_URL.test(url) || /ttml|vtt|dfxp|xml|text\/plain/.test(ct);

          if (!looks) return;

          const len = +(r.headers.get('content-length') || 0);

          if (len > 4e6) return;

          r.clone().text().then(t => ingest(url, t)).catch(() => {});

        } catch {}

      }).catch(() => {});

      return p;

    };

  } catch {}



  function activeTimedText(t) {

    if (!cues.length || !isFinite(t)) return '';

    // binary search the last cue starting at or before t

    let lo = 0, hi = cues.length - 1, idx = -1;

    while (lo <= hi) {

      const mid = (lo + hi) >> 1;

      if (cues[mid].s <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;

    }

    const parts = [];

    for (let i = Math.max(0, idx - 4); i <= idx && i >= 0; i++) {

      const c = cues[i];

      if (c && c.s <= t && c.e >= t) parts.push(c.t);

    }

    return [...new Set(parts)].join('\n');

  }



  /* --- record cues as they are added ------------------------------------- */

  try {

    const proto = window.TextTrack && window.TextTrack.prototype;

    if (proto && proto.addCue) {

      const orig = proto.addCue;

      proto.addCue = function (cue) {

        try { tracks.add(this); } catch {}

        return orig.apply(this, arguments);

      };

    }

  } catch {}



  try {

    const mp = window.HTMLMediaElement && window.HTMLMediaElement.prototype;

    if (mp && mp.addTextTrack) {

      const orig = mp.addTextTrack;

      mp.addTextTrack = function () {

        const t = orig.apply(this, arguments);

        try { tracks.add(t); media.add(this); } catch {}

        return t;

      };

    }

    if (mp && mp.play) {

      const origPlay = mp.play;

      mp.play = function () { try { media.add(this); } catch {} return origPlay.apply(this, arguments); };

    }

  } catch {}



  function cueText(cue) {

    if (!cue) return '';

    let t = typeof cue.text === 'string' ? cue.text : '';

    if (!t) { try { t = cue.getCueAsHTML().textContent || ''; } catch {} }

    // String-only: this runs in the page's own world, where Trusted-Types sites

    // (YouTube, GitHub, …) reject innerHTML outright.

    const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

    return String(t)

      .replace(/<br\s*\/?>/gi, '\n')

      .replace(/<\/?[^>]+>/g, '')

      .replace(/&(#?\w+);/g, (m, e) => (e in ent ? ent[e]

        : /^#\d+$/.test(e) ? String.fromCharCode(+e.slice(1)) : m))

      .replace(/\n{2,}/g, '\n')

      .trim();

  }



  function currentTime() {

    let best = null;

    for (const m of media) {

      if (!m.isConnected) continue;

      if (!best || (!m.paused && best.paused) ||

          (m.videoWidth || 0) * (m.videoHeight || 0) > (best.videoWidth || 0) * (best.videoHeight || 0)) best = m;

    }

    return best ? best.currentTime : NaN;

  }



  let last = '';

  function poll() {

    if (!active) return;

    const t = currentTime();

    if (!isFinite(t)) return;



    const parts = [];

    for (const track of tracks) {

      let cues = null;

      try { cues = track.cues; } catch {}

      if (!cues || !cues.length) continue;

      // linear scan is fine: caption tracks hold a few thousand cues at most,

      // and we only run this 8×/s while a PiP window is actually open.

      for (let i = 0; i < cues.length; i++) {

        const c = cues[i];

        if (c.startTime <= t && c.endTime >= t) {

          const s = cueText(c);

          if (s) parts.push(s);

        }

      }

    }

    const text = [...new Set(parts)].join('\n').trim();

    if (text !== last) { last = text; post({ event: 'cues', text }); }

  }



  window.addEventListener('message', (e) => {

    const d = e.data;

    if (!d || d.__flox !== 'FLOX_CTL') return;

    if (d.action === 'on') {
      // Subtitles are usually fetched at page load, long before a pop-out
      // exists — so replay whatever we already captured to the new listener.
      if (cues.length) post({ event: 'timedtext-list', count: cues.length, cues });
      if (!active) { active = true; last = ' '; timer = setInterval(poll, 125); }
    }

    if (d.action === 'off' && active) { active = false; clearInterval(timer); timer = 0; }

  });



  post({ event: 'ready' });

})();

