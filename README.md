# Flox — Pop Out Player with Live Subtitles

A Manifest V3 extension for Chrome, Opera / Opera GX, Edge, Brave, Vivaldi and any
other Chromium 116+ browser. One click pops the currently playing video into a
real always-on-top window — **with the host player's subtitles mirrored live**.

## Install (unpacked)

1. Open `chrome://extensions` (Opera GX: `opera://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → select this `flox` folder.
4. Pin the icon. Click it (or press **Alt+,**) while a video plays.

> Opera GX: also enable *Allow access to search page results / all sites* if you
> restricted extension host access. Alt+, can be re-bound at `opera://extensions/shortcuts`.
> (Alt+P — the old binding — is reserved by Opera GX for its own settings page.)

## How it works

**Window:** uses the Document Picture-in-Picture API (`documentPictureInPicture`),
not the old `<video>` PiP. That gives a real DOM document in an always-on-top OS
window, which is the only way to draw arbitrary subtitle text over the video.

**Video transfer ("Move player", default):** the live `<video>` element is relocated
into the PiP document, leaving a same-size placeholder behind so the page doesn't
reflow. It is put back with its original inline styles on close.

This matters for performance: moving means **one element — one decode, one paint**.
Nothing keeps playing behind you in the tab. Verified on YouTube: after popping out,
`document.querySelectorAll('video').length === 0` in the page, and the element plays
on in the PiP window with its position intact.

Adoption into another document normally tears down MSE/blob-backed sources, and it
does — measured in a same-origin iframe: `readyState` 4 → 0, `currentTime` → 0. Real
Document-PiP windows are exempt, which was confirmed directly rather than assumed:
moving into an actual PiP window preserved `currentTime` at 796 s with no reload.
The extension still doesn't take it on faith — every move is verified ~260 ms later,
and if the source did get torn down the element is restored to the page (seeking back
to where the user was) and **mirroring** takes over: `captureStream()` into a
`<video>` in the PiP window. Mirroring costs a second paint of every frame, which is
why it is the fallback and not the default. A 12 s watchdog guarantees the mount path
can never hang with a blank window on screen, and playback is explicitly resumed
after a move (relocation pauses the element, and some players re-pause once during
re-attach).

**Subtitles — four independent sources, merged by priority:**

1. **Native `TextTrack` cues** — any track the player switched to `showing` is taken
   over (`mode = 'hidden'`, so cues still fire but the browser stops drawing them)
   and re-rendered with your styling. Original modes are restored on close.
2. **Page-world cue hook** (`src/page-hook.js`) — patches `TextTrack.addCue` /
   `addTextTrack` in the page's own JS world to record cues from players that keep
   their tracks `disabled` and render captions themselves, then reports whichever
   cue covers the current playback time. Observe-only; it never changes what the
   page draws.
3. **Host DOM caption overlays** — `MutationObserver` on the player's own caption
   container. Site profiles ship for YouTube, Netflix, Prime Video, Disney+/Hotstar,
   Max, Hulu, Vimeo, Crunchyroll, Twitch, Peacock, Paramount+, Plex, Jellyfin/Emby
   and Bilibili, plus generic matchers for video.js, Shaka, JW Player, Plyr,
   MediaElement and Flowplayer, plus a heuristic class/id scan for unknown players.
4. **Canvas subtitle layers** (ASS/SSA via libass, e.g. Crunchyroll) — the overlay
   canvas is mirrored pixel-for-pixel into the PiP window each frame.

A rescan runs every 1.5 s, so captions still appear when the player attaches its
caption container late or swaps it mid-playback. Sources go quiet between cues, so
if a site switches renderers mid-stream the next source takes over automatically.

**Frames:** the content script runs in every frame, including embedded players.
The extension scores every video (size, playing state, visibility, duration) and
pops the right one, so embeds and ad iframes don't win.

## Controls in the PiP window

| Action | Control |
| --- | --- |
| Play / pause | click video, `Space`, `K` |
| Seek ±5 s / ±10 s | `←` `→` / `J` `L`, or the seek bar |
| Volume / mute | `↑` `↓` / `M`, or the slider |
| Speed (0.25×–3×) | the `1×` button |
| Subtitles on/off | `C` or the `CC` button |
| Opacity | the small slider in the bar |
| Fit window to video aspect | `⤢` |
| Back to the tab | `⇱` |
| Close | `Esc`, `✕`, or close the window |

The control bar auto-hides after 2.2 s of no pointer movement (toggleable).

## Options (extension popup)

Subtitles on/off · size · background plate opacity · vertical position · colour ·
drop shadow · window transparency + opacity · show/auto-hide controls · remember
window size · capture mode · auto pop-out when leaving the tab · pause on close.
Changes apply to an open PiP window instantly.

## Performance notes

The PiP document is deliberately cheap: no `backdrop-filter`, no blurs, no
per-frame JavaScript in the normal path (subtitle updates are event-driven, the
clock ticks 4×/s), `contain: strict` on the stage, and opacity applied to a single
composited layer. The only `requestAnimationFrame` loop that ever runs is the
canvas-subtitle mirror, and only on sites that actually use one.

## What has actually been tested

Run against live pages by loading the real `src/content.js` into them, with a real
same-origin `Document` substituted for the PiP window (the harness could not create
an OS-level window — see below).

| Check | Result |
| --- | --- |
| Video discovery / scoring on YouTube | picks the player video, score 5113 |
| Session opens, DOM builds under Trusted Types | pass (after fix, see below) |
| Control bar: 9 buttons, live clock | pass — `1:03 / 4:27` |
| Mirror video live in PiP document | pass — 1280×720, playing |
| Open latency | 103 ms |
| **YouTube captions mirrored live** | **pass — line-for-line exact match, incl. non-Latin script** |
| Captions keep tracking as playback advances | pass — 6 consecutive samples |
| Native `<track>`/WebVTT cues | pass — cues parsed, `<b>` markup stripped, line breaks kept |
| Host track taken over and restored | `showing` → `hidden` → `showing` on close |
| Close leaves the page intact | pass — playback continues, zero placeholders left |

Bugs this testing found and fixed, all of which would have shipped broken:

- `innerHTML` in the PiP document **threw on every Trusted-Types site** (YouTube
  included) — the PiP document inherits the opener's CSP. Now built node-by-node.
- Move-mode killed MSE playback (see above) — hence the reordered strategy.
- `await video.play()` on a torn-down element **never resolves** → the session hung
  forever. Two occurrences; both now fire-and-forget with frame verification.
- The "site stole the video back" guard raced the fallback path and nulled the
  window mid-mount. Now armed only after a mount is verified good.
- Caption line breaks were collapsed into a single line. Now preserved.

Not tested, honestly: **Netflix playback** (the account is logged out and I won't
sign in), and **creation of the real OS PiP window** — the automation browser has no
parent window, so `documentPictureInPicture.requestWindow()` returns
`InvalidStateError: Internal error: no window` there. A bare three-line call to the
same API fails identically in that environment, so it is the harness, not this code
— but it means the window-creation call itself is unverified until you run it.

## Known limits (browser-imposed, not fixable in an extension)

- **True window transparency** isn't exposed to web content; the opacity control
  fades the content against the window's black background.
- Document PiP requires Chromium **116+**. Older browsers and Firefox fall back to
  classic PiP with subtitles burned into a canvas — that fallback cannot work on
  DRM-protected video (Netflix etc.), which is a platform restriction.
- The window must be opened from a real user gesture (icon click or Alt+,);
  when the browser refuses the icon click for lack of one, Flox puts a
  click-to-pop-out prompt on the page instead of failing silently.
  "auto pop-out when leaving the tab" only works after you've interacted with the page.

## Layout

```
manifest.json
src/background.js   service worker: frame routing, badge, settings relay
src/content.js      video discovery, PiP session, subtitle engine, fallback
src/page-hook.js    page-world TextTrack cue recorder
src/settings.js     defaults + storage helpers
ui/popup.*          control panel
icons/
```
