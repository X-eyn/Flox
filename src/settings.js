// Shared default settings + storage helpers (used by background, popup).
// Content script has its own inlined copy of DEFAULTS to stay dependency-free.

export const DEFAULTS = {
  subtitles: true,          // mirror host player subtitles into the PiP window
  subtitleSize: 4.2,        // % of PiP window height
  subtitleColor: '#ffffff',
  subtitleBg: 0.55,         // 0..1 opacity of the caption background plate
  subtitleBottom: 6,        // % from bottom
  subtitleShadow: true,
  opacity: 1,               // window content opacity 0.2..1
  transparencyEnabled: false,
  showControls: true,       // custom control bar in the PiP window
  hoverControls: true,      // hide the bar until pointer enters
  pauseOnClose: false,      // pause the video when PiP closes
  returnOnClose: true,      // scroll/restore original player on close
  rememberSize: true,
  lastSize: { width: 640, height: 360 },
  mode: 'auto',             // 'auto'   = move the real <video> (one decode, no duplicate
                            //            playback), falling back to mirroring if the
                            //            move doesn't survive verification
                            // 'stream' = always mirror via captureStream (page untouched,
                            //            but the tab keeps painting the video too)
  autoPipOnTabHide: false,  // pop out automatically when you leave the tab
  keepAspect: true,
  cleanWindow: true,        // bezel-less: browser PiP window fed by a canvas with
                            // the subtitles burned in. No title bar, but costs a
                            // per-frame draw and can't work on DRM sites.
  forceNative: false,       // always use the browser's own PiP window
  drmNative: false          // DRM sites (Netflix/Prime/Max): false = our own window,
                            // which moves the player's container so the site's own
                            // subtitle layer renders inside it. Requires graphics
                            // acceleration OFF, or protected frames show black.
                            // true = the browser's PiP window: always shows the
                            // picture, but cannot render subtitles at all.
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS).catch(() => ({}));
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
  return patch;
}
