# Flox — pop-out video player with live subtitles

A Manifest V3 extension for Chrome, Opera GX, Edge, Brave, Vivaldi and any other
Chromium 116+ browser. One click pops the playing video into an always-on-top
window — and unlike every other pop-out extension, the subtitles come with it.

## Install

1. Open `chrome://extensions` (Opera GX: `opera://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select this folder
4. Click the toolbar icon, or press **Alt+P**, while a video is playing

Alt+P toggles: press it again — in either window — to put the video back.

## Two window modes

**Bezel-less (default).** The video and its subtitles are composited into a canvas
that feeds the browser's own picture-in-picture window. No title bar, no chrome,
just the picture. Requires readable frames, so it is used on everything except
DRM-protected sites.

**Framed.** A Document Picture-in-Picture window that hosts the real `<video>`
element plus a subtitle overlay, a control bar, and an opacity slider. Used
automatically on DRM sites (Netflix, Prime Video, Max, Disney+, Hulu), where the
protected picture cannot be composited by an extension.

Both are always-on-top. Modes can be forced from the options page.

## Subtitles

Four independent sources, merged by priority — the first one producing text wins,
and they hand over automatically if a player switches renderers mid-stream.

1. **Network subtitle file.** A `MAIN`-world hook installed at `document_start`
   watches `fetch` / `XMLHttpRequest` for the subtitle payload the player itself
   downloads — TTML/IMSC (including Netflix's tick-based timings) or WebVTT — and
   parses it into cues. Exact text, exact timings, immune to DOM changes.
   Read-only: responses are passed through untouched.
2. **Native `TextTrack` cues.** Any track the player switches to `showing` is taken
   over (`mode = 'hidden'`, so cues still fire but the browser stops drawing them)
   and re-rendered with your styling. Original modes are restored on close.
3. **Host caption DOM.** `MutationObserver` on the player's caption container.
   Profiles for YouTube, Netflix, Prime Video, Disney+/Hotstar, Max, Hulu, Vimeo,
   Crunchyroll, Twitch, Peacock, Paramount+, Plex, Jellyfin/Emby and Bilibili, plus
   generic matchers for video.js, Shaka, JW Player, Plyr, MediaElement, Flowplayer.
4. **Positional detection.** For players whose captions carry no identifying class
   names (utility-class CSS), caption-shaped text over the lower part of the video
   is detected by geometry — rejecting timecodes, control bars and interactive
   elements.

Canvas-rendered subtitle layers (ASS/SSA via libass) are mirrored pixel-for-pixel.

## Video transfer

The live `<video>` element is moved into the pop-out rather than duplicated: one
element, one decode, one paint, and nothing left playing behind you in the tab. A
same-size placeholder holds the page layout, and the element is restored with its
original inline styles on close.

Every move is verified ~260 ms later. If the media resource did not survive
adoption, the element is put back (seeking to where the viewer was) and a
`captureStream` mirror takes over instead. A watchdog guarantees the mount path can
never hang with a blank window on screen.

## Controls

| Action | Control |
| --- | --- |
| Toggle pop-out | toolbar icon, `Alt+P` |
| Play / pause | click the video, `Space`, `K` |
| Seek ±5 s / ±10 s | `←` `→` / `J` `L`, or the seek bar |
| Volume / mute | `↑` `↓` / `M` |
| Speed 0.25×–3× | the `1×` button |
| Subtitles on/off | `C` or `CC` |
| Opacity | slider in the control bar |
| Fit to video aspect | `⤢` |
| Back to tab | `⇱` |
| Close | `Esc`, `✕` |

The control bar auto-hides after 2.2 s of no pointer movement.

## Options

Right-click the toolbar icon → **Options**.

Subtitles on/off, size, background plate, vertical position, colour, drop shadow ·
window transparency and opacity · control bar visibility and auto-hide · remember
window size · capture mode · DRM window mode · auto pop-out when leaving the tab ·
pause on close. Changes apply to an open window immediately.

## Notes

- Frames are handled: the content script runs in every frame and scores candidate
  videos by size, playback state, visibility and duration, so embedded players win
  over ad iframes.
- DRM-protected video cannot be composited by any extension — the browser refuses
  frame access for EME media (`captureStream` throws, canvas readback returns
  black). That is why DRM sites use the framed window, where subtitles are drawn as
  DOM over the real element.
- If protected video appears black in the pop-out, disable
  `chrome://settings/system` → "Use graphics acceleration when available"; the
  hardware-protected output path does not composite into a PiP surface.

## Layout

```
manifest.json
src/background.js   service worker: frame routing, badge, settings relay, migrations
src/content.js      video discovery, window sessions, subtitle engine, hotkey
src/page-hook.js    MAIN-world hook: subtitle network interception + cue capture
src/settings.js     defaults and storage helpers
ui/popup.*          options page
icons/
```
