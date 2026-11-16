# The welcome's music engine (`src/welcome/audio/`)

Maia's welcome plays quiet music while the member answers her questions and their desks set up (design: CONCEPT.md §7.1 Music and
§7.2 Controls, in `ma-coord/design-drafts/maia-welcome/`). This folder is the engine: our own Web Audio graph, with every sound
written in code. There are no samples, no files and nothing to license. **No voice for launch** (the owner, Nov 15: captions and
music only), so `duck()` is only the seam a later voice would use.

| File | What it holds |
|---|---|
| `engine.ts` | The API (`WelcomeAudio`, `createWelcomeAudio`), the graph, the scheduler, fades, pause, hidden tab and the end |
| `voices.ts` | The voices: pluck (felt piano), glass (soft FM), sustain (sine plus triangle), the phrase shape, the cadence's chord |
| `score.ts` | Pure data and rules: the key, levels, fades, the 12 motifs, the phrase rule, the no-repeat picker, motif spacing, cadence timing, a seeded random |
| `fakeAudio.ts` | A fake `AudioContext` for the tests (records the graph and every automation event, and evaluates gains over time) |
| `engine.test.ts`, `score.test.ts` | Vitest tests |

## Using it (the welcome UI's side)
```ts
const ctx = new AudioContext({ latencyHint: 'playback' });       // in the "Begin with sound" click, before any await
const { createWelcomeAudio } = await import('./audio/engine');    // the lazy chunk, only after the press
const audio = createWelcomeAudio({ context: () => ctx });
const on = await audio.start();                                   // false: blocked or failed, so show the speaker off
```
- **Make the context inside the click**, then hand it in through `context`. Safari counts the press only while its handler runs,
  and the chunk loads after the press. `start()` calls `resume()` before it awaits anything. If audio still isn't running
  1.5 s later, it closes the context, returns `false` and sets `state` to `'blocked'`. A later press may call `start()` again with
  a fresh context.
- **The flow's calls:** `answered()` after the first answer (L2). `deskReady(n)` as desks come up (1 → L3, 2 or more → L4;
  idempotent). `cadence(ms)` at **Looks right**, with the time until the reveal. `hero()` at the reveal. After the hero there's
  silence and the context closes by itself. `stop()` (1.5 s fade, then close) is for leaving early.
- **The controls (§7.2):** `setMuted` (the speaker button), `setMusic` (the menu's **Music**), `setVolume(0..1)` (the slider;
  the gain is the value squared, so the slider feels even), `pause()` and `resume()` (the flow's Pause), and
  `setHidden(document.visibilityState === 'hidden')` from `visibilitychange`. Settings made before `start()` are kept.
- **`reducedCpu: true`** (for example on a low-end phone or when the page asks for less motion) drops the triangle and octave partials,
  the FM shimmer and the air's sway, uses a 1 s noise buffer, and schedules every 1 s instead of every 0.5 s.
- **`random`** is injectable: `seeded(n)` from `score.ts` gives the same performance every time (the tests use it).
- **`state`:** `idle` before the press, `running`, `paused` (the flow's Pause or a hidden tab: faded out and suspended),
  `blocked` (the press didn't get audio), `closed` (after the hero, `stop()`, or `stop()` before any press).

## The graph
```
L0 air ──┐
L1 pad ──┤
L2 motif ┤→ music (Music on/off) → duck → out (every fade) → master (mute × volume²) → limiter → speakers
L3 glass ┤                                 ↑
L4 low ──┤                               hero (beside the music: Music off still lets the hero ring; mute silences all)
cadence ─┘
```
- **Long-lived nodes:** the buses, the air's looped noise buffer and band-pass, the pad's two sustains (retuned only in a silence)
  and the low sustain. Their phrases are gain shapes, so nothing is rebuilt per phrase.
- **One-shot voices** (plucks, glass, the cadence, the hero) are a few oscillators and gains each. Each stops itself, and its
  nodes are disconnected when its last oscillator ends.
- **Scheduling:** a timer every 0.5 s writes the next phrase onto the audio clock up to 1.5 s ahead. Every sound is timed by
  `AudioContext.currentTime`, never by the timer, so the timer's jitter is never heard, and a suspended context's frozen clock
  pauses the score with it.
- **No ScriptProcessor, no AudioWorklet**, no per-sample JavaScript. The only JavaScript sample loop fills the 2 s noise buffer once.

## Layers and the score (CONCEPT §7.1)
One key throughout (D major; the music itself has no fourth, which appears only in the cadence's lean), beatless. The score is
a run of **phrases of 8 to 12 s with real silences of 2 to 6 s** between them, when only the air is left. Every layer plays
inside the phrases.

| Layer | Starts | What it is |
|---|---|---|
| L0 Air | at the press | Looped white noise, band-passed at 2.2 kHz (Q 0.6), breathing ±30 % at 0.06 Hz |
| L1 Pad | +4 s (the first phrase) | A two-note sustain per phrase from six dyads (never the same twice running), each note a sine with a detuned triangle a third as loud, low-passed at 1.1 kHz. 2.5 s up, held, 2.5 s down |
| L2 Motif | the next phrase after `answered()` | 3 to 5 felt-piano plucks (a triangle with a 12 ms attack and a 0.32 s decay, an octave sine that fades faster, through a shared 1.7 kHz low-pass). Picked from 12 variants, never one of the last 3. Played 0.9 to 1.15 times as slow, with ±40 ms of timing and ±10 % of velocity, so it never audibly loops. It comes 20 to 40 s apart: at a phrase start once 20 s have passed (a coin decides), and always when waiting would pass 40 s |
| L3 Glass | the next phrase after `deskReady(1)` | 1 or 2 notes per phrase: a sine with a 2:1 FM shimmer that fades in half a second, 0.25 s up, 4.5 s to silence |
| L4 Low | the next phrase after `deskReady(2)` | A low sine (D2, sometimes A1 or B1), 3 s up and 3 s down across the phrase |
| Cadence | `cadence(ms)` | 6 to 8 s long, timed so it **ends at** now + ms. If that's under 6 s it starts at once and is shorter. A Gmaj9 leans into D (the home chord lands at 55 %), with a pluck line B4 A4 F#4 E4 D4 and one glass D6 on the resolution. The other layers step aside over 2 s as it begins (the air stays), no new phrases start, and the cadence bus reaches silence exactly at the end. Once only |
| Hero | `hero()` | The one glassy chord (D4 A4 E5 F#5 C#6, the glass voice): 0.9 s swell, 1.8 s decay to silence (2.7 s). Everything else fades in 0.8 s. The context closes 0.2 s after the decay. Once only |

## Levels
All gains are in `score.ts` (`LEVEL`, `LIMITER`, `FADE`), at volume 1. The numbers below are a calculation. A meter has not
checked them yet (see Open).

| Voice | Gain | RMS (K-weighted, dBFS) |
|---|---|---|
| L0 air | −26 dB on noise band-passed to about −11 dBFS | about −34.5 |
| L1 pad | −28 dB per note (sine), triangle a third | about −28 for the dyad |
| L2 motif | −20 dB peak per pluck | about −32 over a motif's 3 s |
| L3 glass | −30 dB peak | about −40 over 3 s |
| L4 low | −25 dB | about −30 (K-weighting takes about 2 dB off at 73 Hz) |
| Cadence | −28 dB per chord note | about −25 at its sustain |
| Hero | −26 dB per note at the swell's top | about −21.5 at the top |

- **The limiter** is a `DynamicsCompressorNode` used as a brick wall: threshold −2.6 dB, knee 0, ratio 20, attack 2 ms, release
  250 ms. Web Audio's compressor adds its own fixed make-up gain, (1 / gain at 0 dBFS)^0.6, which here is **+1.48 dB**. A full-scale
  input comes out at −1.0 dBFS, and even +6 dBFS overs come out at −0.7, so **nothing clips and the ceiling is about −1 dBTP**.
  The music sits far under the threshold, so the only thing the limiter does to it is the +1.48 dB.
- **The music with every layer** sounding: about **−23.7 LUFS** short-term (−24.5 dB K-weighted, −0.69, +1.48). Early in the
  welcome, with L0 and L1 alone, it's about −26.5. In a silence, with only the air, it's about −33.
- **The hero:** its swell tops out at about **−20.7 LUFS momentary, 3 dB over the full music**. Its sample peak is about −10.5 dBFS,
  well under the −1 dBTP ceiling.
- **Fades:** 4 s from silence at the press (eased: slow at first). A hidden tab fades out over 2 s and then suspends; when the tab
  shows again, it resumes and fades back in over 2 s from silence. The flow's Pause fades out in 0.4 s and suspends; Resume fades
  in over 2 s. Mute takes 80 ms, volume 50 ms, Music on or off 0.8 s, and `stop()` 1.5 s. Every fade starts from the gain's
  current value, so turning round mid-fade never jumps.
- **Duck (the voice seam):** the music bus goes to −10 dB with a 150 ms attack and an 800 ms release. The hero isn't ducked.

## Stems later (CONCEPT §7.1: A + B)
If the owner says yes to a composer, the stems replace the voices, and the API and the score stay. Each layer's bus stays where
it is, and only what feeds it changes:
- **L0, L1 and L4** become looped stems: an `AudioBufferSourceNode` (decoded Opus/WebM, or AAC) into the same bus. The gain
  shape on each phrase stays, or the stem's own phrasing is used and the bus just fades.
- **L2 motif variants** become 12 short one-shot stems. `picker` and `motifDue` keep choosing which one plays and when, with
  `pluck` replaced by a buffer start.
- **L3, the cadence and the hero** become one-shots started at the same times (`cadence` still ends at `end`, and the hero still
  sets `closeAt`).
- **The fetching** goes in `start()` or before it. Only the first 10 s stem is fetched while the threshold shows; **Begin
  quietly** fetches nothing.
- **What stays:** the fades, the duck, the limiter and the tests of the schedule rules. The voice tests become tests of buffer starts.

## Size and CPU
- About **3.9 KB gzipped** (8.6 KB minified with Rolldown, `engine.ts` with its imports). Only the welcome's lazy chunk imports
  it, never the first load.
- **CPU:** 6 long-lived oscillators, plus the one-shots in a phrase (a motif is up to 10 short oscillators). All
  nodes are native, and the context uses the `playback` latency hint (bigger buffers). It's suspended while the tab is hidden or
  the flow is paused.

## Tests
`npx vitest run src/welcome/audio`, with the fake context:
- the graph;
- the 4 s fade-in;
- L1 at +4 s, and the phrase and silence lengths;
- no motif before the answer, then 20 to 40 s spacing and no repeat of the last 3 (each motif identified from its notes);
- the plucks disconnected after they ring out;
- L3 and L4 by desk count;
- the cadence's end time (long and short);
- the hero once, then closed;
- the gains for mute, Music, volume and duck, and settings made before the press;
- hidden: fade, suspend, and a gentle return, including turning round mid-fade;
- pause and resume;
- `stop()`;
- a blocked start (a throw, a resume that never answers, a refusal), and a retry;
- `reducedCpu`.

`score.test.ts` checks the key and the rules on their own.

## Open
- **A meter check:** render a minute in a browser (an `OfflineAudioContext` or a recording of the real page) and measure the
  short-term LUFS and the true peak, then trim `LEVEL` if it's off by more than about 1 dB. The numbers above are calculated,
  not yet measured.
- **The hero's level:** CONCEPT says the hero "peaks at −1 dBTP, about 3 dB over the music". Taken literally, a peak at −1 dBTP
  is about 12 dB over the music, not 3. The default here is about 3 dB over the music, with −1 dBTP as the limiter's ceiling.
  For a literal −1 dBTP peak, set `LEVEL.hero` to about `db(-16)`.
