# Maia

Maia is the animated avatar in the office, drawn on Canvas 2D. This is version 7, approved by the owner on 2026-11-06 (ADR 0067); nothing goes into the product without their own OK. This file is the motion spec for two readers: the UI/UX Engineer, who builds the framework-free package `@minimalist-alliance/maia-avatar` (at `web/maia-avatar/`, built 2026-11-06 and not yet wired into any app), and the AI Engineer, who owns the score schema and generates scores.

Numbers come from the code in this folder or from measurements in headless Chromium 156 on a 6-core machine with software rendering (SwiftShader, no GPU). The measuring scripts are not in this folder.

## Files

| File | What it is |
|---|---|
| `vocabulary.json` | Her moods, rhythms, beats and states, with descriptions, timing and stage numbers. Generated from `engine/src/vocab.js`. |
| `tokens.json` | Surfaces, her gradient stops per theme and tier, and the contrast figures. |
| `parts-{sm,md,lg}.json` | One drawing per tier. `rig.hair` is the two-strand rig the engine reads. `rig.eye` is the closed eye. |
| `rig.js` | Pure functions, an ES module: `poseHair`, `maiaShapeD`, `eyePaths`. The hair math matches the engine to two decimals at rest and on 400 random poses per tier. It covers closed eyes only: her open eye is `eyeCompute` in the engine, and the engine gives `md` a closed lash bunch borrowed from `lg`. It leaves out the spring chain and the wall, which need time and the transform. |
| `svg/` | 18 stills written by the engine: `maia-{light,dusk,dark}-{sm,md,lg}.svg` at rest with eyes open, and `-asleep` settled asleep. |
| `engine/` | The reference implementation: `src/engine.js` (motion and drawing), `src/vocab.js` (source of the vocabulary), `src/page.*` (the demo page), `build.py`. |

`python3 -I engine/build.py` needs Node, rewrites `vocabulary.json` and writes one self-contained page to `engine/dist/maia-preview.html`. Don't commit `dist/`.

`engine/` is a reference. The package may restructure it, as long as she looks and moves the same. `eyes.md.lashTwo` in the vocabulary is not read by the engine.

## Drawing model

One `Path2D` holds body and hair. One linear gradient fills it. One transform places all of her.

- **Art units** are the SVG's user space, `viewBox="201 107 720 720"`. Rest transform: `matrix(0.76 0 0 0.76 134.64 112.08)`.
- **Transform:** `setTransform(s*M0, s*M1, s*M2, s*M3, s*(M4-201), s*(M5-107))`, with `s = canvasWidth / 720`. Rotation and squash turn about `(470, 650)`. She is scaled 76% about the bubble's centre, `(561, 467)`.
- **Gradient:** `createLinearGradient(437.2, 313.1, 722.4, 667.6)` in art units, under the transform, so it travels with her. Same line in every tier. Stops are in `tokens.json`.
- **Outline:** one `moveTo`, 32 cubics (28 of hair, 4 of fixed body), one `closePath`. Default nonzero fill.

Paint order, every frame:

| # | What | Composite | Why |
|---|---|---|---|
| 1 | Clear the canvas | | See below |
| 2 | Both eyes | `source-over` | White when open, the closed colour below 0.16 openness |
| 3 | Iris, pupil, highlight | `source-atop` | Cut by the eye's own alpha rather than a clip, so no white rims the iris |
| 4 | Lashes | `destination-over` | They grow from behind the eye's edge |
| 5 | Body and hair | `destination-over` | Behind everything |
| 6 | Lid line, Dusk only | `source-over` | `#1F4080` stroke, round caps, width `7 * smooth(open / 0.25)` |

**Her canvas must be clear before she's drawn.** Lashes and body composite behind what is already there, so anything painted first hides them. The bubble background must be CSS or a separate layer, never drawn into her canvas.

Rebuild a path only when it moved: hair when a heading changes by more than 2e-5 rad, eyes when a value changes by more than 2e-4 or gaze by more than 3e-3.

## Sizes

The tier follows her drawn size, which is the bubble times 0.76.

| Tier | Drawn size | Bubble | Hair |
|---|---|---|---|
| `sm` | under 40 px | 52 px and under, down to 24 px | Optically adjusted, up to 12.3 art units from the still |
| `md` | 40 to under 96 px | 53 to 126 px | The still, 0.006 art units |
| `lg` | 96 px and up | 127 px and up | The still, 0.006 art units |

- The launcher bubble is 64 px, with her at 76% scale, so it uses `md`.
- **Device pixel ratio:** the backing store is `round(px * dpr)`, or `round(px * dpr * 2)` when `px * dpr` is under 128. CSS scales it down. Thin lashes and tips twinkle without this. A 64 px bubble is 128 px wide at both 1x and 2x.
- The eye highlight shows when her drawn size is 30 px or more. `sm` has none.

## The hair

Two strands carry one wave. Hair and body stay one contour, so a seam can't open between them.

| Part | Numbers |
|---|---|
| Long outer strand | Spine of 10 stretches, 44.1 art units each, root `(626, 455)` |
| Short inner strand | Spine of 10 stretches, 14.5 art units each. Its root rides on the outer strand at 0.7 of the first stretch |
| Outline nodes | 29, each bound to a point on a spine. Each rides on that point and turns with it, handles included. Handles scale with their chord |

In `parts-*.json`, `rig.hair` holds `outer`, `inner` (spines, half widths and pose tables), `contour` (the rest outline and each node's binding), `fixed` (the body's run) and `parting`.

**One wave.** Only the outer strand has a spring chain. The inner strand takes its pose from its own tables and everything else, every ripple, kick and lag, from the outer strand at the same fraction of its length, 0.3 of a stretch behind. It has no state of its own. The chain's numbers are in `timing`: `hairOmega`, `hairDamping`, coupling 0.92, or 0.1 during falling and waking.

**The parting.** As the strands near each other, the outer strand opens its curl. It starts at a spine gap of 40 art units and aims for a floor of 30, with `partWeights` along the strand. It is a smooth function of the pose, so it can't jump. These gaps are measured from spine points with their half widths, so they read lower than the true gap. Calm on `breath` never reaches it.

| Measured over 192 runs, 36,864 frames per tier | `lg` and `md` | `sm` |
|---|---|---|
| Frames where the strands cross | 0 | 0 |
| Smallest gap from a tip to the other strand | 29.8 art units, 2.0 px at a 64 px bubble | 39.3 art units |
| Smallest gap along the far 60% of the short strand | 17.9 art units, 1.2 px | 13.8 art units |

**The bubble wall.** The wall is a circle of 350 bubble units about the centre, inside a 360 bubble. Both spines are scanned. At the wall the hair gives first, turning from its fourth spine point as far as the strand gap allows. Whatever is left holds her body back. No run passed 350 units, so nothing clips.

**The way down.** Droop is three moves, so no strand bends two ways at once:

| Move | Sag window | What happens |
|---|---|---|
| Swing | 0 to 0.82 | The whole hair turns 88 degrees about its root, a plain rotation of the rest shape. `gentle` sits here at sag 0.3 |
| Relax | 0.38 to 0.72 | The curl opens until each strand is almost straight. Speeds up into its end |
| Settle | 0.72 to 1 | Each strand arcs over and lies against her. Slows down from its start |

**Bends.** S is the smaller of the largest run of turning each way along the long strand, in degrees. A plain arc scores 0. Measured over every mood with every rhythm, every beat at every level, and the states: 360 runs, 56,064 frames.

| Where | Peak S | Longest above 10 degrees | Smallest strand gap above 5 degrees |
|---|---|---|---|
| Waking | 12.2 | 0.23 s | 54.1 art units, 3.7 px at 64 |
| `nod`, level 3 | 11.6 | 0.13 s | 70.2 art units |
| Falling asleep | 11.4 | 0.07 s | 97.2 art units |
| `wave`, level 3 | 8.5 | never | 52.1 art units, 3.5 px at 64 |
| `flick`, level 3 | 5.0 | never | |
| `wave`, level 2 | 1.4 | never | |
| The other 48 names | under 1 | never | |

**Seams and cracks.** 0 seams and 0 cracks over 5,700 frames in each tier at 400 px. Inside her, colour stays within 1.3 of 255 of what the gradient gives. The checks do find a planted reversed sliver and a planted crack.

**The sleep strip.** Once settled asleep, half a breath is drawn once to a bitmap strip, 36 frames, and CSS `steps()` plays it there and back over 4.5 s each way, so the render loop stops. The strip's first frame matches the last live frame exactly, in the four size and theme pairs checked.

## `calm` as package v0

v0 can ship as `calm` on `breath` before the full engine. Calm never means barely moving. It must include all of this:

| Must have | Numbers |
|---|---|
| Eyes open while awake | Openness 0.82 |
| Blinks | A blink wherever the eyes would otherwise go 5.2 s without one, every 3 to 4.8 s from a seeded generator. 0.3 s long, closing for 38% of it. 4 in a 24 s loop |
| Gaze | Six spots shuffled, a new one every 1.9 to 3.2 s, 10 in 24 s. Follows a critically damped spring, omega 15 |
| Whole body moves | Figure eight on a 6 s cycle: x 34, y 18 at twice the rate, rotation 4 degrees. Body spring omega 11. She leans 12 units and rocks 3 degrees toward her gaze |
| Hair follows | Bend 6 degrees, curl 0.075, slow wander 1.6 degrees, ripple 5 degrees travelling root to tip, through the spring chain, both strands |
| Squash and stretch | From her own speed and acceleration, capped at 0.14 |

Measured at 56 px over 24 s: her body travels 8.1 px (7.6 across, 2.8 up), the long tip 13.4 px (12.1 across, 5.6 up), and her gaze changes 9 times. A v0 should land near those. On `calm` and `breath` the parting and the wall never engage, so v0 can leave both out. Reduced motion is still required.

## The score

The model sends one score per reply. It plays for 20 to 30 seconds, then loops.

```json
{"v":1,"mood":"warm","rhythm":"breath","seconds":24,"beats":[{"t":1,"do":"wave","level":2}]}
```

The real parser is the AI Engineer's `services/maia/src/score.ts` in `ma-platform`, not the page's `parseScore`, and it decides what gets through. `calm` and `breath` are the fallbacks. Checked: its `makeParser` accepts this `vocabulary.json` and parses the example, with each beat's track filled in. Its limits match: 20 to 30 seconds, levels 1 to 3, 12 beats, 4096 bytes.

| Field | Names |
|---|---|
| `mood` | `calm`, `warm`, `curious`, `focused`, `gentle`, `bright` |
| `rhythm` | `quiet` (7 s cycle), `breath` (6 s), `drift` (9 s), `lively` (4 s) |
| `beats`, hair track | `lift`, `nod`, `flick`, `wave`, `curl` |
| `beats`, body track | `hop`, `bob`, `lean` |
| `beats`, eyes track | `blink`, `flutter`, `smile`, `soften`, `glance` |

Each beat has `t` in seconds, `do`, and `level` 1 to 3. Descriptions and durations are in `vocabulary.json`.

What the engine does with a score: `seconds` snaps to a whole number of rhythm cycles between 20 and 30. It keeps at most 12 beats, and drops a beat that ends within 0.8 s of the loop's end or starts within 0.3 s of the last one on its track. The page's parser refuses more than 4096 bytes. The engine adds its own blinks and gaze, the same every time for the same score.

## Engine-owned states

The model can never pick these.

| State | When | Timing |
|---|---|---|
| `thinking` | Turn sent, no text yet | Pose settles at omega 4.5. Drifts on 5.3 s and 3.7 s, rocks on 4.6 s, hair swirls 14 degrees on 2.6 s. Blinks every 2.4 to 4.2 s |
| `speaking` | Text is streaming | Pose settles at omega 4. Bob 10 to 34 units on 1.05 s, scaled by text rate up to 40 characters a second, smoothed over 0.5 s. Looks between person and text every 1.4 to 2.6 s. Blinks every 2.6 to 4.6 s |
| `sleeping` | Idle | 4 s to fall: eyes closed by 1.6 s, hair moves from 0.8 s to 3.4 s. Then a 9 s breath from the strip |
| `waking` | Used again | 1.3 s. Eyes open by 0.45 s, then she rises and the hair lifts. Then the score restarts |
| `unavailable` | Limit or refusal | Still, soft eyes looking down, no loop. Pose settles at omega 3.5. The render loop stops once she has settled |

Sleep after 5 minutes without use is a default still open to the owner. The engine has no idle timer: the caller decides when to call `fallAsleep()`.

## Performance

| What | Target | Measured |
|---|---|---|
| Frame rate | 30 fps, fixed step of 1/30 s | 30.0 ticks a second on the page |
| During a desk stream | 15 fps, beats run 1.7 times longer | `setStreamMode(true)`, and draw every second step |
| Step cap at 15 fps | About 1.5 px per frame at 56 px | Tips 1.49 px, worst outline node 1.66 px, over 7,560 frames. Uncapped: 3.71 px |
| Main-thread budget | 1.5 ms a frame | See below |

Main-thread task time per frame, in a real `requestAnimationFrame` loop, at six sizes and modes, three rounds, alternating versions so that load falls on both:

| | Version 7 | Version 6 |
|---|---|---|
| Median | 0.72 ms | 0.68 ms |
| Range | 0.30 to 0.91 ms | 0.29 to 0.88 ms |
| Worst single frame of script | 2.3 ms | 2.0 ms |

- **This machine is noisy.** Version 7 measured 0.29 to 0.33 ms in a quiet run and up to 0.87 ms in a later one with almost no code change, and version 6 moved the same way when alternated with it. Treat these as a comparison, not as a real device's numbers.
- The averages are inside the budget. Single frames are not always, in either version.
- The timer's resolution is 0.1 ms. With no drawing, step and path building take about 0.007 ms. Forced raster took 0.2 to 0.3 ms at the 95th percentile.
- The heap grows about 20 KB a frame between collections. `Path2D` objects are the engine's only per-frame allocations.

**Reduced motion.** Hair and body stay at rest and only the eyes fade between expressions, at omega 5. Her eyes never close past 0.45. Blinks, hops and glances are dropped, and `smile` and `soften` stay. There are no frames while nothing is fading, and the sleep strip doesn't animate. Measured: hair headings all 0, and no change in hair or body pixels.

**The over-budget fallback isn't built.** Nothing measures frame time or drops her to a still. `drawStill()` is there and is the still it would show: rest pose, eyes open, looking at the person. Pause and a render error already use it.

## Themes

Surfaces, from the brand kit's final values:

| Theme | `surface.overlay` | `surface.sunken` | `surface.tile` | `surface.worldBase` | `accent.default` | `text.onAccent` |
|---|---|---|---|---|---|---|
| Light | `#FFFFFF` | `#F3F3EF` | `#FFFFFF` | `#E9E9E5` | `#5076AA` | `#FFFFFF` |
| Dusk | `#4F5663` | `#404652` | `#4D5461` | `#444B57` | `#A5BCDD` | `#15171B` |
| Dark | `#383C45` | `#23262C` | `#33373F` | `#15171B` | `#6A8DBF` | `#15171B` |

Her gradient, and contrast at both stops. All ratios are WCAG. The rule: body at least 3:1 on the bubble, `surface.overlay`.

| Theme | Tier | Light stop | Dark stop | On overlay | On sunken | On tile | On worldBase |
|---|---|---|---|---|---|---|---|
| Light | `lg` | `#5E86BE` | `#4D6E9C` | 3.73, 5.22 | 3.35, 4.69 | 3.73, 5.22 | 3.06, 4.29 |
| Light | `md` | `#6089C2` | `#4B6C98` | 3.59, 5.39 | 3.22, 4.84 | 3.59, 5.39 | 2.95, 4.43 |
| Light | `sm` | `#628CC6` | `#496994` | 3.45, 5.63 | 3.10, 5.06 | 3.45, 5.63 | 2.83, 4.62 |
| Dusk | `lg` | `#B6D5FF` | `#97B1D6` | 4.91, 3.37 | 6.30, 4.32 | 5.06, 3.47 | 5.84, 4.01 |
| Dusk | `md` | `#B9DAFF` | `#93ADD0` | 5.11, 3.21 | 6.56, 4.12 | 5.27, 3.31 | 6.08, 3.82 |
| Dusk | `sm` | `#BDDFFF` | `#8FA8CA` | 5.33, 3.03 | 6.84, 3.89 | 5.50, 3.13 | 6.34, 3.61 |
| Dark | `lg` | `#6A97D4` | `#5F87BF` | 3.68, 3.00 | 5.05, 4.12 | 3.97, 3.24 | 5.97, 4.87 |
| Dark | `md` | `#6C99D8` | `#5F87BF` | 3.78, 3.00 | 5.19, 4.12 | 4.09, 3.24 | 6.14, 4.87 |
| Dark | `sm` | `#6C99D8` | `#5F87BF` | 3.78, 3.00 | 5.19, 4.12 | 4.09, 3.24 | 6.14, 4.87 |

Eyes and lashes against her skin, at the light and dark stops:

| Theme | Tier | Closed eye | Closed eye on skin | Open eye (white) on skin | Open eye behind the eyes | Lash | Lash on skin |
|---|---|---|---|---|---|---|---|
| Light | `lg` | `#FFFFFF` | 3.73, 5.22 | 3.73, 5.22 | 4.34 to 4.65 | `#0C2558` | 3.96, 2.83 |
| Light | `md` | `#FFFFFF` | 3.59, 5.39 | 3.59, 5.39 | 4.34 to 4.71 | `#0C2558` | 4.12, 2.74 |
| Light | `sm` | `#FFFFFF` | 3.45, 5.63 | 3.45, 5.63 | 4.29 to 4.79 | `#0C2558` | 4.28, 2.63 |
| Dusk | `lg` | `#1E232B` | 10.49, 7.20 | 1.51, 2.19 | 1.78 to 1.93 | `#1F4080` | 6.63, 4.55 |
| Dusk | `md` | `#1E232B` | 10.92, 6.86 | 1.44, 2.30 | 1.78 to 1.96 | `#1F4080` | 6.91, 4.34 |
| Dusk | `sm` | `#1E232B` | 11.40, 6.48 | 1.38, 2.44 | 1.78 to 2.00 | `#1F4080` | 7.21, 4.10 |
| Dark | `lg` | `#FFFFFF` | 3.00, 3.68 | 3.00, 3.68 | 3.28 to 3.44 | `#12306B` | 4.21, 3.43 |
| Dark | `md` | `#FFFFFF` | 2.92, 3.68 | 2.92, 3.68 | 3.24 to 3.41 | `#12306B` | 4.33, 3.43 |
| Dark | `sm` | `#FFFFFF` | 2.92, 3.68 | 2.92, 3.68 | 3.24 to 3.41 | `#12306B` | 4.33, 3.43 |

- Dark's dark stop moved from `#577CAF` to `#5F87BF` in all tiers, because the new `surface.overlay` took it to 2.58:1. That is a 1.2085 scale in linear light, the smallest that reaches 3.00:1. Nothing else of hers moved.
- White on Dusk's skin is low, 1.78 behind the eyes. The dark iris (15.78:1 on white) and the lid line (about 5:1) carry her eye. The bubble is `surface.overlay`, so the figures on other surfaces are for reference. The lowest body figure is 2.83:1, `sm` Light's light stop on `surface.worldBase`.
- Colours for iris, pupil, highlight, lash and lid are in `vocabulary.json` under `eyes.colors`.

## Known flaws

| Flaw | Detail |
|---|---|
| Mid-fall V | The strands pass through nearly straight as they fall, a stiff V: under 40 degrees of total turning for 0.17 s falling and 0.07 s waking |
| Weaker curl | Curl acts at 0.8 on the long strand and 0.5 on the short one, so they stay apart. `focused` is less tight than in version 6 |
| Wall contact | The wall touches her in 9% of sampled frames (1,840 of 19,953; version 6, 43). Her body is held back more than 1 px at 56 px in 0.9% |
| `curious` with `lean` 3 | Held back the most: 69.5 bubble units, 5.4 px at 56 px |
| 32 px tips | One pixel is 29.6 art units here. The long strand is 12 art units wide one node from its tip, so the tip is soft at 1x |
| The notch asleep at 64 px | Small: 3.1 px from the short tip to the long strand, 1.9 px along the short strand's far edge |
| One browser | Tested in Chromium only |
| Nobody else has watched it | Only the owner has watched it play. The checks here looked at numbers and still frames |

## What can't change without the owner

- The rest shape
- Her colours
- The eyes and lashes
