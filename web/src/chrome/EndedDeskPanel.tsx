// What a Work desk says once a step down has stopped it (billing spec still 15): over the desk, while it's the one in view,
// a calm panel on the `DeskClosed` pattern with its two ways on. Nothing here asks anything of the member. A lazy chunk, loaded
// only when the list holds such a desk.
import { useLayoutEffect, useRef } from 'react';
import { camera } from '../canvas/controller';
import { freeName } from '../free/wire';
import { billingUrl } from '../platform/clientConfig';
import { useSession } from '../platform/session';
import { tierNamesFrom } from '../platform/tiers';
import { openSettings } from '../settings/settingsStore';
import { useDeskStore } from '../state/deskStore';
import { useViewStore } from '../state/viewStore';
import { DOWNLOAD_LINK, endedWords, MOVE_UP_LINK } from './endedDesk';

const MAX_W = 420;
const EDGE = 16;

function Panel({ deskId }: { deskId: string }) {
  const ended = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.ended);
  const cfg = useSession((s) => s.config);
  const me = useSession((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);

  // Centred on the desk, and with it on every camera move.
  useLayoutEffect(() => {
    const el = ref.current;
    const box = camera.getStage()?.container().getBoundingClientRect();
    if (!el || !box) return undefined;
    const place = (): void => {
      const rect = camera.deskRect(deskId);
      // A phone shows one desk as a screen of its own: the middle of that screen, not the desk's place in the world.
      const phone = window.matchMedia('(max-width: 767px)').matches;
      if (!rect && !phone) return;
      const { s, x, y } = camera.cam;
      const width = Math.round(Math.max(200, Math.min(MAX_W, phone || !rect ? box.width - 2 * EDGE : rect.w * s - 2 * EDGE)));
      el.style.width = `${width}px`;
      const h = el.offsetHeight;
      const left = phone || !rect ? box.left + box.width / 2 - width / 2 : box.left + (rect.x + rect.w / 2) * s + x - width / 2;
      const top = phone || !rect ? box.top + box.height / 2 - h / 2 : box.top + (rect.y + rect.h / 2) * s + y - h / 2;
      el.style.transform = `translate(${Math.round(Math.max(8, Math.min(left, window.innerWidth - width - 8)))}px, ${Math.round(Math.max(8, Math.min(top, window.innerHeight - h - 8)))}px)`;
    };
    place();
    return camera.onMove(place);
  }, [deskId, ended]);

  if (!ended) return null;
  const membership = me?.membership;
  const tier = membership?.tier === 'free' ? freeName(cfg) : membership?.tier ? (tierNamesFrom(cfg?.tierNames) as Record<string, string>)[membership.tier === 'member' ? 'officer' : membership.tier] ?? null : null;
  const { title, body } = endedWords(ended, tier);
  const moveUp = billingUrl(cfg, membership?.billingUrl);
  return (
    <div ref={ref} className="ended-desk" role="status" data-testid="ended-desk" data-desk={deskId}>
      <p className="ended-desk-title" data-testid="ended-desk-title">{title}</p>
      <p className="ended-desk-body" data-testid="ended-desk-body">{body}</p>
      <p className="ended-desk-links">
        <button type="button" className="closed-link ended-desk-link" data-testid="ended-desk-download" onClick={(e) => openSettings('data', e.currentTarget)}>{DOWNLOAD_LINK}</button>
        {moveUp && (
          <a className="closed-link" href={moveUp} target="_blank" rel="noopener noreferrer" data-testid="ended-desk-moveup">
            {MOVE_UP_LINK}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </p>
    </div>
  );
}

/** The panel for the desk in view, if that desk is an ended one. */
export function EndedDeskPanel() {
  const deskId = useViewStore((s) => (s.mode === 'overview' ? null : s.activeDesk));
  const isEnded = useDeskStore((s) => !!deskId && !!s.desks.find((d) => d.id === deskId)?.ended);
  return deskId && isEnded ? <Panel deskId={deskId} /> : null;
}
