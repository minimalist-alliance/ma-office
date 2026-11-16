// Maia in the room (CONCEPT.md §2, "Maia herself"): the approved avatar package, never changed here, at about three times her
// 64 px bubble, hovering over the chat in a soft glow of the theme's accent. She breathes and moves as the package's engine
// does, and the field drifts slowly round its place (opacity and transform only, on the compositor; none under reduced motion
// or while her motion is paused). Entering, she grows from her corner into the room (FLIP, 600 ms; a crossfade under reduced
// motion). Her canvas is `aria-hidden`; the pause button is her WCAG 2.2.2 control, kept in the same place as her panel's.
import { createAvatar, type MaiaAvatar } from '@minimalist-alliance/maia-avatar';
import { useEffect, useRef, useState } from 'react';
import { watchOfficeActivity } from '../maia/officeActivity';
import { getTheme, useTheme } from '../theme/themeStore';
import { MOVE_MS, useRoomUi } from './ui';
import { W } from './words';

/** Her panel's own key: one pause for both Maias. */
const MOTION_KEY = 'ma.maia.motion.v1';

const motionPaused = (): boolean => {
  try {
    return localStorage.getItem(MOTION_KEY) === 'paused';
  } catch {
    return false;
  }
};

export interface FieldHandle {
  /** A Now item arrived: one glance, never a flash (the package's `noticing` beat is still to come: it wakes her). */
  notice(): void;
  thinking(on: boolean): void;
}

export function Field({ size, scale, handle }: { size: number; scale: number; handle: { current: FieldHandle | null } }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const theme = useTheme((s) => s.resolved);
  const [paused, setPaused] = useState(motionPaused);
  const avatar = useRef<MaiaAvatar | null>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return undefined;
    const a = createAvatar(c, { theme: getTheme().resolved, size, activityTarget: box.current, textSide: 1 });
    avatar.current = a;
    if (motionPaused()) a.pause();
    // The room counts as use, as the office does for her bubble: she sleeps only once the whole page has been idle.
    const activity = watchOfficeActivity(() => a.wake());
    handle.current = {
      notice: () => a.wake(),
      thinking: (on) => a.setState(on ? 'thinking' : 'calm'),
    };
    return () => {
      handle.current = null;
      activity.stop();
      a.destroy();
      avatar.current = null;
    };
  }, [size, handle]);

  useEffect(() => avatar.current?.setTheme(theme), [theme]);

  // Grows from her corner into the room as it opens (FLIP): her box now, played from where her bubble was.
  useEffect(() => {
    const el = box.current;
    const { phase, from } = useRoomUi.getState();
    if (!el || phase !== 'entering' || !from || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const to = el.getBoundingClientRect();
    if (!to.width) return;
    const s = from.size / to.width;
    const dx = from.x + from.size / 2 - (to.left + to.width / 2);
    const dy = from.y + from.size / 2 - (to.top + to.height / 2);
    el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: MOVE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  }, []);

  const toggle = (): void => {
    const next = !paused;
    setPaused(next);
    try {
      if (next) localStorage.setItem(MOTION_KEY, 'paused');
      else localStorage.removeItem(MOTION_KEY);
    } catch {
      /* the choice holds for this page */
    }
    if (next) avatar.current?.pause();
    else avatar.current?.resume();
  };

  return (
    <div className={`mm-field${paused ? ' still' : ''}`} ref={box}>
      <div className="mm-drift" style={{ transform: `scale(${scale})` }}>
        <canvas ref={canvas} className="mm-maia" width={size} height={size} aria-hidden="true" />
      </div>
      <button type="button" className="mm-pause" aria-pressed={paused} aria-label={W.pauseMotion} title={paused ? 'Resume Maia’s motion' : W.pauseMotion} onClick={toggle}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {paused ? <path d="M9 7v10l8-5Z" /> : <path d="M9 7v10M15 7v10" />}
        </svg>
      </button>
    </div>
  );
}
