# `@minimalist-alliance/maia-avatar`

Maia, version 7, the one the owner approved ("Maia 7 is great", ADR 0067), as a framework-free package: Canvas 2D, no runtime dependencies, 28.3 KB gzipped with the dance. It reaches a product only with the owner's own OK. Reviewers: the AI Engineer leads, and the Product Designer reviews the look.

**On `sub/maia-dance` she also dances "Party", the Product Designer's draft, which the owner hasn't approved. It isn't for `main` until he approves this Maia version.** Everything about version 7 stays exactly as approved; only the dance is added (below, "The dance").

Her motion spec is `docs/assets/maia/README.md`, and the API she serves is `ma-platform` `docs/contracts/maia.md` and `maia-score.md`. This file says how the package keeps her exactly as approved, and how to use it.

## Exactly version 7
Nothing about her was redrawn or retuned.
- **Her art comes from the reference's own build.** `scripts/art.mjs` copies `docs/assets/maia/` to a temporary folder, runs its `engine/build.py` there, and takes the data and vocabulary blocks it inlines. `src/art/` is that output, less the vocabulary's `say` descriptions, which the engine never reads. `tests/unit/art.test.ts` fails if `src/art/` drifts from what the reference builds.
- **Her engine is the reference engine.** `src/engine.js` is `docs/assets/maia/engine/src/engine.js` with five changes, each marked `package:`: an ES module, the data imported, `walk` exported, and no page `parseScore` or `Avatar.playScore`. It keeps the reference's indentation, so `diff` shows only those. `art.test.ts` checks every added line is one of them.
- **She moves exactly as the reference does.** `tests/unit/engine.test.ts` runs the reference engine and the package's side by side, through the preview's own scores and chat, every state, every tier, stream mode and reduced motion, and compares every number a frame is drawn from after every one of 27,688 steps. Making one line of it one part in ten million stronger fails 27 of the 28 scenes.
- **She looks exactly as the reference does.** `tests/e2e/pixels.spec.ts` draws her rest pose in every theme and tier: not one pixel differs from the reference engine's own still in Chromium, and against the committed SVG stills only edge antialiasing differs (at most 16 of 255 up to 200 px).
- **Screenshots:** `screenshots/maia-{light,dusk,dark}.png`, the demo paused, with each tier's still beside her.

## The dance (draft, `sub/maia-dance`)
- **The source** is the Product Designer's `preview-dance/src/` (not in this repo): `engine.js` and `vocab.js`, every change marked `DANCE`. The owner picked "Party (2)".
- **The engine** is the draft's engine with the package's own changes, line for line. `dance/engine.diff` is the draft's diff against version 7; applied to `docs/assets/maia/engine/src/engine.js` it gives the draft's engine byte for byte (its SHA-256 is checked), and `art.test.ts` checks `src/engine.js` against that with only `package:` lines added. Its parser lines aren't here: `routine` comes through the AI Engineer's `score.ts` (below).
- **The data** comes from the draft's `vocab.js` through `scripts/dance.mjs`: `src/art/dance.json` is the dance's settings every routine shares (channels, spring, fade, turn depth, wink side), and `src/art/routine.json` is the one routine she knows, with only the moves it uses. Her vocabulary gains no beats: the draft's six new beats (`twirl`, `shimmy`, `giggle`, `cheer`, `stretch`, `wink`) aren't in the package, and Party cues only version 7's `flutter` and `smile`.
- **Another dance is a swap of one routine:** `npm run dance -- groove` (or any routine in the draft) rewrites `routine.json` with that routine and its moves, and nothing else changes.
- **She dances exactly as the draft:** `tests/unit/dance.test.ts` runs the draft's engine and the package's side by side through Party in 13 scenes (four sizes, a score after it, cut short by a turn, a score, a second dance, a stream, reduced motion, sleep, unavailable, beats over it), 10,756 steps, 198 numbers each, all identical. Where the draft is on the machine, the reference runs with the draft's own `vocab.js`. Making the hair's lag channel one part in ten million stronger fails 8 of the 13.
- **Version 7 is unchanged:** `engine.test.ts`'s 28 scenes still match the version 7 reference engine exactly, and the rest pose still matches it to the pixel.

## Use

Her canvas goes inside her bubble: an element with `position` set, round, with the bubble's color as its CSS background. **Nothing is ever drawn behind her on her canvas,** because her lashes and body are painted behind what's already there (spec, "Drawing model"). Every frame clears the canvas first.

```ts
import { createAvatar, parseScore } from '@minimalist-alliance/maia-avatar';

const maia = createAvatar(canvas, { theme: 'dusk', size: 64, sleepAfterMs: state.animation.sleepAfterSec * 1000, activityTarget: widget });
maia.setState('thinking');               // turn sent
maia.setRate(charsPerSecond);            // while text frames arrive
maia.setState('speaking');
maia.playScore(frame.score);             // the `animation` frame; null or junk plays calm
maia.setState('calm');                   // the stream ended with no score
maia.setState('unavailable');            // a `stop` frame
maia.playRoutine();                      // DANCE: her dance (Party), once, then she settles into warm
```

Or the element, for any framework. It is the bubble, so style it: `maia-avatar { background: var(--surface-overlay) }`.

```html
<maia-avatar size="64" sleep-after-ms="300000"></maia-avatar>
<script type="module">import { defineMaiaAvatar } from '@minimalist-alliance/maia-avatar'; defineMaiaAvatar();</script>
```
Without a `theme` attribute it follows `<html data-theme>` (`light`, `dusk`, `dark`), then `prefers-color-scheme`. `paused` stops all motion. Hover, a press or focus on it counts as use. Its methods are the handle's below; they do nothing until it's connected, and a change of `size` or `sleep-after-ms` starts her again.

| `createAvatar(canvas, options)` | |
|---|---|
| `theme` | `light` (default), `dusk` or `dark` |
| `size` | Her canvas in CSS px, the bubble. She's drawn at 76% of it, and the drawing tier follows. Default: the canvas's width, or 64 |
| `reducedMotion` | `true` or `false` to fix it. Left out, she follows `prefers-reduced-motion` as it changes |
| `sleepAfterMs` | Default 300000, 5 minutes. A default still open to the owner (ADR 0067) |
| `activityTarget` | An element whose hover, press or focus counts as use. Usually her widget |
| `textSide` | `1` (default) if her text is to her right as you look at her, `-1` if to her left. Where she glances |
| `dpr` | Default `devicePixelRatio`, at most 3 |

| Handle | |
|---|---|
| `setState(s)` | `calm`, `thinking`, `speaking`, `unavailable`, or `sleeping` to sleep now. A new turn goes straight to `thinking`, even from sleep |
| `playScore(input)` | Parses with `parseScore`, plays it, and returns what was parsed. DANCE: a score's `routine` plays once first |
| `playRoutine(name?)` | DANCE: dances the named routine once (`party`; with no name, the one she knows, so a new dance needs no change in the app), then settles into its mood, `warm`, on the ordinary rhythm. With reduced motion, or during a desk stream, she smiles instead. False, doing nothing, for a name she doesn't know |
| `wake()` | She was used: wakes her if she's asleep, and starts the sleep clock again |
| `pause()`, `resume()`, `paused` | Pause shows her rest pose, eyes open, with no frames (WCAG 2.2.2) |
| `setTheme(t)`, `setRate(cps)` | Theme, and characters a second while `speaking` |
| `setStreamMode(on)` | While a desk stream plays: 15 frames a second, beats drawn out (spec, "Performance") |
| `state` | `score` (awake, playing the last score or calm), `thinking`, `speaking`, `unavailable`, `falling`, `sleeping`, `waking`, and `routine` while she dances |
| `stats` | Frames drawn and engine steps, for tests and perf |
| `destroy()` | Removes her listeners, timer and observer |

`parseScore(input)` is `makeParser(vocabulary)` from the AI Engineer's `src/score.ts`, copied unchanged (DANCE: from `ma-platform` `6bee406`, which adds the optional `routine`, `groove`, `party` or `swim`; the package drops any routine its engine doesn't know, today all but `party`, as the contract says, and the score plays without it) (`tests/unit/score.test.ts` checks it byte for byte and runs the contract's vectors). The browser bundle carries the vocabulary's words and tracks but not its descriptions, which only the model reads; `tests/unit/parse.test.ts` shows it answers exactly as `makeParser(vocabulary.json)` on every vector and 5,000 random scores. Servers import `@minimalist-alliance/maia-avatar/score` (`makeParser`, `scoreJsonSchema`, no DOM code) and `@minimalist-alliance/maia-avatar/vocabulary.json`, the full file.

## Frames
- **The engine steps at exactly 1/30 s,** as approved. Each display frame, up to 60 a second, draws her between the last two steps: hair headings blended and walked out (so no stretch changes length), the transform, eyes and gaze blended as numbers. Every step's pose is drawn exactly as the engine made it, one frame later; the frames between are blends of two of them. At 120 Hz she draws every other frame.
- **DANCE: the blend carries her wink,** an eye number like the others, so it closes and opens at 60 frames a second. **It never blends her transform across a turn's mirror:** as the pirouette passes edge on her width changes sign, and halfway between it would be nothing. On that one frame the transform holds the nearer step's, as the dance preview does, while hair and eyes still blend. `tests/unit/blend.test.ts` proves both on every step pair of the dance (a plain blend would draw her at 6% of her width there), and `tests/e2e/dance.spec.ts` reads each 60 fps frame's ink in Chromium.
- **During a desk stream,** every second step, 15 a second, exactly as the reference page does. DANCE: no dance during a stream, a smile instead, as the draft says.
- **No frames at all** while she's asleep, paused, settled (reduced motion or `unavailable`), off screen (an `IntersectionObserver`), `display: none`, or in a hidden tab. Every Maia on a page shares one `requestAnimationFrame`, and none is asked for when none needs one.
- **Asleep,** she breathes from the engine's bitmap strip, a canvas added beside hers and moved by a Web Animations transform with `steps()`, so only the compositor works. It pauses where it can't be seen. If she falls asleep where nobody can see her, she's simply asleep when they look again. Without a positioned parent there's nowhere to put the strip, so she sleeps still and says so once in the console.
- **Sleep:** after `sleepAfterMs` without use, one timer, checked when due, so frequent use never touches it. The clock stands still while she's `thinking` or `speaking`, and a reply, `calm` or `unavailable` starts it again. Use is `wake()`, a score, a state, or hover, a press or focus on `activityTarget`.
- **Reduced motion:** hair and body at rest, only the eyes fade, never closed past 0.45, no strip. All of this is the engine's own behavior.
- **A render error** logs once and leaves her rest pose.
- **Measured** (DANCE: and the dance, 0.01 to 0.1 ms a frame at 30 fps, `tests/e2e/frame-cost.spec.ts`, budget 1.5 ms) in headless Chromium with software rendering on a shared 6-core machine, a 64 px Maia at 2x playing `bright` with big beats: 60 frames and 30 steps a second, 0.1 to 0.2 ms of main thread per frame at the median, 0.7 ms at the 95th percentile, and 7 to 14 ms a second in all. The timer's resolution is 0.1 ms, and this machine is noisy.

**CSP:** only CSSOM style properties, one constructed stylesheet for the element's `:host`, and the Web Animations API, so a strict `style-src 'self'` is enough. The tests run under platform.'s policy.

## Commands
Node 24 (`export PATH=$HOME/.local/node-v24/bin:$PATH`). Run from `web/maia-avatar/`.

| Command | What it does |
|---|---|
| `npm ci` | Install. All dev dependencies; nothing ships but `dist/lib/` |
| `npm run demo` | Builds, then serves the demo at `http://127.0.0.1:5184/` under the apps' CSP. `MAIA_PORT` moves it |
| `npm run typecheck`, `npm run lint`, `npm test` | TypeScript, ESLint, Vitest (`tests/unit/`) |
| `npm run e2e` | Builds the package and demo, then Playwright in Chromium (`tests/e2e/`). `MAIA_TEST_PORT` moves the server from 47920 |
| `npm run check` | All of the above |
| `npm run build` | `dist/lib/`: `maia-avatar.js`, `score.js`, `vocabulary.json` and types. Fails over 29 KB gzipped on this branch (25 KB in `docs/maia.md` §14 in `ma-platform`; the dance adds 3.9 KB) or on `eval`, `innerHTML` and the like |
| `npm run screenshots` | Rewrites `screenshots/*.png`, metadata stripped |
| `npm run art` | Rewrites `src/art/` from `docs/assets/maia/`. Only with a new approved version, and with the parity tests updated in the same change |
| `npm run dance [-- <routine>]` | DANCE: rewrites `src/art/dance.json` and `routine.json` from the draft (`MAIA_DANCE_SRC`, default `~/ma-design-drafts/preview-dance/src`). `--check` fails on drift |
| `npm run dance:capture` | DANCE: rewrites `dance/party-package.mp4` and `dance/party-strip.png` (needs ffmpeg; `MAIA_DANCE_PREVIEW` names the preview's video for the strip's second row) |
| `npm pack` | The versioned tarball apps keep in their own `vendor/` (contract, "The package") |

## Files
| Path | Holds |
|---|---|
| `src/engine.js` | Version 7's reference engine, as above. `engine.d.ts` types the parts `avatar.ts` uses |
| `src/avatar.ts` | `createAvatar`: frames, sleep, the strip, visibility, reduced motion, pause |
| `src/element.ts` | `<maia-avatar>` |
| `src/idle.ts`, `src/loop.ts` | The sleep clock, and the one shared `requestAnimationFrame` |
| `src/score.ts`, `src/parse.ts` | The AI Engineer's parser, unchanged, and `parseScore` |
| `src/art/` | Written by `scripts/art.mjs`, and DANCE's `dance.json` and `routine.json` by `scripts/dance.mjs`; never edit by hand |
| `dance/` | DANCE: `engine.diff`, the draft's engine against version 7; `party-package.mp4` and `party-strip.png`, the package dancing, to compare with the preview |
| `demo/` | The demo page. `scripts/serve.mjs` serves it, the built package, the test page, the reference engine and the stills |
| `tests/unit/`, `tests/e2e/` | Vitest and Playwright, as above |

## Not built
- The over-budget fallback (spec, "Performance"): nothing measures frame time or halves her rate. `drawStill()` is the still it would use. Dropping the blending would halve her cost first.
- An `OffscreenCanvas` worker (`docs/maia.md` §14 leaves it to UI/UX once measured): the measurements above don't call for one.
- A change of `devicePixelRatio` while she's shown, as when a window moves to another screen, keeps the old backing store until she's made again.
- Tested in Chromium only, like the reference.
