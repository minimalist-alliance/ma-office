// The video island (design 7.4; the Product Designer's spec, section 6): a live crop of the site's real player, in the
// page's own column. Seamless: no border, no frame, no "stream" label, the photos' radius and a dark letterbox. Its
// controls are drawn here and drive the real media element on the desk through `deskd`, never clicks by coordinates,
// so they work the same on every site and nothing on the page can take a click meant for them (T47-4). Autoplay never
// starts it; one streams at a time. Sound comes with the session's own audio, which the Browser's element plays, so the
// element here is always muted and never plays it twice.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import type { Block } from './mdoc';
import { islandTime, type IslandState, type SimpleController } from './controller';

type IslandBlock = Extract<Block, { t: 'island' }>;

/** Playing: the controls go this long after the pointer stops (the spec's table). */
export const CONTROLS_FADE_MS = 2_000;
const SEEK_STEP = 5;

const KIND_NAMES: Record<IslandBlock['kind'], string> = { video: 'Video', audio: 'Sound', canvas: 'Drawing', frame: 'Embedded' };

// The island's own glyphs, drawn on the dark glass over the picture. In this chunk only.
const GLYPHS = {
  play: <path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" stroke="none" />,
  pause: <path d="M8.5 5.5v13M15.5 5.5v13" strokeWidth="2.6" />,
  volume: <path d="M4.5 9.5v5H8l4.5 4v-13L8 9.5ZM16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />,
  muted: <path d="M4.5 9.5v5H8l4.5 4v-13L8 9.5ZM16 9.5l4.5 5M20.5 9.5l-4.5 5" />,
  captions: <path d="M5 6.5h14A1.5 1.5 0 0 1 20.5 8v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 16V8A1.5 1.5 0 0 1 5 6.5ZM10.5 10.2a2.2 2.2 0 1 0 0 3.6M16.5 10.2a2.2 2.2 0 1 0 0 3.6" />,
  fill: <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />,
  unfill: <path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5" />,
  screen: <path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM9 20h6M12 16.5V20" />,
  up: <path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" />,
} satisfies Record<string, ReactNode>;

function Glyph({ name, size = 20 }: { name: keyof typeof GLYPHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}

/** "6:12", or "1:02:05" past an hour. */
export function clock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "18 minutes 40 seconds": a duration as words, where the badge is only a picture of it (the spec's section 12). */
export function spokenClock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const part = (n: number, word: string): string => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
  return [part(h, 'hour'), part(m, 'minute'), part(s, 'second')].filter(Boolean).join(' ') || '0 seconds';
}

/** What's said, once and politely, as the island changes (the spec's section 12). */
const SAID: Partial<Record<IslandState['phase'], string>> = { playing: 'Playing', paused: 'Paused', failed: 'This video only plays on the real page' };

function useIsland(controller: SimpleController, b: IslandBlock): IslandState {
  return useSyncExternalStore(
    (fn) => controller.subscribeIsland(b.key, fn),
    () => controller.island(b),
  );
}

/** Re-renders while `on`, a few times a second: the time and scrubber, and nothing else. */
function useTicking(on: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return undefined;
    const id = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(id);
  }, [on]);
  return on ? performance.now() : now;
}

/** The still: the player's poster, an image the tab loaded (section 14's `media.poster`). Null until it has come, or with none. */
function useStill(controller: SimpleController, b: IslandBlock): string | null {
  const [still, setStill] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    setStill(null);
    if (b.poster) void controller.image(b.poster).then((u) => on && setStill(u));
    return () => {
      on = false;
    };
  }, [controller, b.poster]);
  return still;
}

function Controls({ b, s, controller, now }: { b: IslandBlock; s: IslandState; controller: SimpleController; now: number }) {
  const t = islandTime(s, now);
  const d = s.duration ?? 0;
  const playing = s.phase === 'playing' || s.phase === 'starting';
  const pct = d ? Math.min(100, (t / d) * 100) : 0;
  const buf = d ? Math.min(100, (Math.max(s.buffered, t) / d) * 100) : 0;
  return (
    <div className="sv-isl-ctl" onClick={(e) => e.stopPropagation()}>
      {d > 0 && (
        <div className="sv-isl-track">
          <span className="sv-isl-buf" style={{ width: `${buf}%` }} />
          <span className="sv-isl-pos" style={{ width: `${pct}%` }} />
          <span className="sv-isl-knob" style={{ left: `${pct}%` }} />
          <input
            type="range"
            className="sv-isl-seek"
            min={0}
            max={d}
            step={0.1}
            value={Math.min(t, d)}
            aria-label="Seek"
            aria-valuetext={`${clock(t)} of ${clock(d)}`}
            onChange={(e) => controller.seek(b, Number(e.currentTarget.value))}
          />
        </div>
      )}
      <div className="sv-isl-row">
        <button type="button" className="sv-isl-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={() => (playing ? controller.pause(b) : controller.play(b))}>
          <Glyph name={playing ? 'pause' : 'play'} size={playing ? 20 : 18} />
        </button>
        <span className="sv-isl-vol">
          <button type="button" className="sv-isl-btn" aria-label={s.muted ? 'Unmute' : 'Mute'} onClick={() => controller.volume(b, s.volume, !s.muted)}>
            <Glyph name={s.muted || s.volume === 0 ? 'muted' : 'volume'} />
          </button>
          <input
            type="range"
            className="sv-isl-volume"
            min={0}
            max={1}
            step={0.05}
            value={s.muted ? 0 : s.volume}
            aria-label="Volume"
            style={{ backgroundSize: `${(s.muted ? 0 : s.volume) * 100}% 100%` }}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              controller.volume(b, v, v === 0);
            }}
          />
        </span>
        <span className="sv-isl-time" aria-hidden="true">
          {clock(t)}
          {d > 0 && <span> / {clock(d)}</span>}
        </span>
        <span className="sv-isl-grow" />
        {b.captions && (
          <button type="button" className="sv-isl-btn" aria-label="Captions" aria-pressed={s.captions} onClick={() => controller.captions(b)}>
            <Glyph name="captions" />
          </button>
        )}
        <FillButton b={b} controller={controller} />
      </div>
    </div>
  );
}

function FillButton({ b, controller }: { b: IslandBlock; controller: SimpleController }) {
  const filled = useSyncExternalStore(controller.subscribe, () => controller.getView().filled === b.key);
  return (
    <button type="button" className="sv-isl-btn" aria-label={filled ? 'Back to the page' : 'Fill the window'} onClick={() => controller.fillWindow(filled ? null : b.key)}>
      <Glyph name={filled ? 'unfill' : 'fill'} />
    </button>
  );
}

export function Island({ b, live, filled, controller, scroller }: { b: IslandBlock; live: boolean; filled: boolean; controller: SimpleController; scroller: () => HTMLElement | null }) {
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const held = useRef<HTMLCanvasElement>(null);
  const s = useIsland(controller, b);
  const still = useStill(controller, b);
  const [pointer, setPointer] = useState(false);
  const [focused, setFocused] = useState(false);
  const fadeTimer = useRef(0);
  const playing = s.phase === 'playing';
  const controlsOn = s.phase === 'paused' || (playing && (pointer || focused));
  const now = useTicking(playing && (controlsOn || s.away));

  // In view, and how much: under a quarter while playing, the chip; back at a half.
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof IntersectionObserver !== 'function') return undefined;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) controller.islandSeen(b.key, e.isIntersecting ? e.intersectionRatio : 0);
    }, { threshold: [0, 0.25, 0.5, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, [controller, b.key]);

  // Live: the session's picture, now the crop, from its first frame. When it stops, its last frame holds.
  useEffect(() => {
    const v = video.current;
    const c = held.current;
    if (!live || !v) return undefined;
    const attach = (): void => {
      const stream = controller.link.media()?.stream ?? null;
      if (v.srcObject !== stream) v.srcObject = stream;
      v.play().catch(() => {});
    };
    attach();
    const offMedia = controller.link.onMedia(attach);
    let id = 0;
    const seen = (): void => {
      // Only a frame of the island's own shape counts: never the whole screen, before or without a crop.
      if (typeof v.requestVideoFrameCallback === 'function' && !controller.islandFrameFits(b.key, v.videoWidth, v.videoHeight)) {
        id = v.requestVideoFrameCallback(seen);
        return;
      }
      if (c) c.hidden = true;
      controller.islandFrame(b.key);
    };
    if (typeof v.requestVideoFrameCallback === 'function') id = v.requestVideoFrameCallback(seen);
    else v.addEventListener('loadeddata', seen, { once: true });
    return () => {
      if (id) v.cancelVideoFrameCallback(id);
      v.removeEventListener('loadeddata', seen);
      offMedia();
      if (c && v.videoWidth) {
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext('2d')?.drawImage(v, 0, 0);
        c.hidden = false;
      }
      v.srcObject = null;
    };
  }, [controller, live, b.key]);

  // The end of the media rests it.
  useEffect(() => {
    if (playing && s.duration && islandTime(s, now) >= s.duration) controller.ended(b);
  }, [controller, b, s, now, playing]);

  // Filling the window: the island covers the view where the member is, and the page under it stays put.
  useLayoutEffect(() => {
    const el = frame.current;
    const box = scroller();
    if (!filled || !el || !box) return undefined;
    el.style.top = `${box.scrollTop}px`;
    el.style.height = `${box.clientHeight}px`;
    box.classList.add('sv-locked');
    el.focus({ preventScroll: true });
    return () => {
      el.style.top = '';
      el.style.height = '';
      box.classList.remove('sv-locked');
    };
  }, [filled, scroller]);

  useEffect(() => () => window.clearTimeout(fadeTimer.current), []);
  // A control that went away with the phase took the focus with it.
  useEffect(() => {
    if (!frame.current?.contains(document.activeElement)) setFocused(false);
  }, [s.phase]);
  const moved = (): void => {
    setPointer(true);
    window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => setPointer(false), CONTROLS_FADE_MS);
  };

  const toggle = (): void => {
    if (s.phase === 'failed') return;
    if (s.phase === 'playing' || s.phase === 'starting') controller.pause(b);
    else controller.play(b);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target instanceof HTMLInputElement && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    const k = e.key.toLowerCase();
    let done = true;
    if (k === ' ' || k === 'k') {
      if (e.target instanceof HTMLButtonElement && k === ' ') return;
      toggle();
    } else if (k === 'arrowleft') controller.seek(b, islandTime(s) - SEEK_STEP);
    else if (k === 'arrowright') controller.seek(b, islandTime(s) + SEEK_STEP);
    else if (k === 'm') controller.volume(b, s.volume, !s.muted);
    else if (k === 'c' && b.captions) controller.captions(b);
    else if (k === 'f') controller.fillWindow(filled ? null : b.key);
    else if (k === 'escape' && filled) controller.fillWindow(null);
    else done = false;
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const name = b.name || KIND_NAMES[b.kind];
  const showPicture = live && (playing || s.phase === 'paused');
  const label = `${name}${s.duration ? `, ${spokenClock(s.duration)}` : ''}`;
  return (
    <div
      ref={frame}
      className={`sv-isl sv-isl-${s.phase}${controlsOn ? ' ctl-on' : ''}${filled ? ' filled' : ''}${b.h > b.w ? ' sv-isl-tall' : ''}`}
      // R70: a vertical video keeps its shape, no taller than 420 px, so it never fills the column's height.
      style={{ aspectRatio: `${b.w} / ${b.h}`, ...(b.h > b.w && !filled ? { maxWidth: `${Math.round((420 * b.w) / b.h)}px` } : {}) }}
      role="group"
      tabIndex={0}
      aria-label={label}
      aria-roledescription={b.kind === 'video' ? 'video' : KIND_NAMES[b.kind].toLowerCase()}
      data-testid="simple-island"
      data-island={b.key}
      data-phase={s.phase}
      data-live={showPicture ? '1' : undefined}
      onPointerMove={moved}
      onPointerLeave={() => {
        window.clearTimeout(fadeTimer.current);
        setPointer(false);
      }}
      onFocus={(e) => {
        // The keyboard's focus shows the controls; a press of the play button doesn't keep them up.
        if ((e.target as HTMLElement).matches(':focus-visible')) setFocused(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={onKeyDown}
      onClick={toggle}
    >
      {still ? <img className="sv-isl-still" src={still} alt="" draggable={false} /> : <div className="sv-isl-still" />}
      <canvas ref={held} className="sv-isl-held" hidden />
      <span className="sv-sr" aria-live="polite" data-testid="simple-island-said">
        {SAID[s.phase] ?? ''}
      </span>
      <video ref={video} className={`sv-isl-video${showPicture ? ' on' : ''}`} muted playsInline disablePictureInPicture disableRemotePlayback tabIndex={-1} aria-hidden="true" />
      {s.phase === 'failed' ? (
        <div className="sv-isl-fail" onClick={(e) => e.stopPropagation()}>
          <p>
            This video only plays on the real page
            <span>The site wouldn&rsquo;t let it play here.</span>
          </p>
          <button type="button" className="sv-isl-real" onClick={() => controller.playOnRealPage(b)}>
            <Glyph name="screen" size={17} />
            Play on the real page
          </button>
        </div>
      ) : (
        <>
          <span className="sv-isl-shade" aria-hidden="true" />
          {s.phase === 'paused' && b.name && (
            <>
              <span className="sv-isl-shade-top" aria-hidden="true" />
              <span className="sv-isl-title" aria-hidden="true">
                {b.name}
              </span>
            </>
          )}
          {(s.phase === 'ready' || s.phase === 'paused') && (
            <button
              type="button"
              className="sv-isl-big"
              aria-label={`Play ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                controller.play(b);
              }}
            >
              <Glyph name="play" size={28} />
            </button>
          )}
          {/* After 400 ms: a spinner, or under reduced motion a still label that says the same (the spec's 29). */}
          {s.phase === 'starting' && s.slow && (
            <>
              <span className="sv-isl-spin" role="progressbar" aria-label="Starting" />
              <span className="sv-isl-startlabel" aria-hidden="true">
                Starting
              </span>
            </>
          )}
          {s.phase === 'starting' && <span className="sv-isl-load" aria-hidden="true" />}
          {s.phase === 'ready' && s.duration !== null && (
            <span className="sv-isl-dur" aria-hidden="true">
              {clock(s.duration)}
            </span>
          )}
          {(s.phase === 'playing' || s.phase === 'paused') && <Controls b={b} s={s} controller={controller} now={now} />}
        </>
      )}
    </div>
  );
}

/** Scrolled away while playing: one chip at the bottom of the view, to pause or go back to it. */
export function IslandChip({ b, host, controller, onBack }: { b: IslandBlock; host: string; controller: SimpleController; onBack: () => void }) {
  const s = useIsland(controller, b);
  const still = useStill(controller, b);
  const now = useTicking(s.phase === 'playing');
  const name = b.name || KIND_NAMES[b.kind];
  return (
    <div className="sv-chip" role="group" aria-label={`${name}, playing`} data-testid="simple-island-chip">
      <span className="sv-chip-th">{still && <img src={still} alt="" draggable={false} />}</span>
      <span className="sv-chip-tx">
        {name}
        <span>
          {/* Whose video, as the office names the site (T47O-3): the page's title is never the only name in the chip. */}
          {host && `${host} · `}
          {clock(islandTime(s, now))}
          {s.duration ? ` / ${clock(s.duration)}` : ''}
        </span>
      </span>
      <button type="button" className="sv-chip-btn solid" aria-label="Pause" onClick={() => controller.pause(b)}>
        <Glyph name="pause" size={17} />
      </button>
      <button type="button" className="sv-chip-btn" aria-label="Back to the video" onClick={onBack}>
        <Glyph name="up" size={17} />
      </button>
    </div>
  );
}
