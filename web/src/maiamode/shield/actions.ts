// What the held line's buttons do in the desk view (the focus shield; CONCEPT.md §7): a card's one thing opens where it lives (the
// desk's own approval card in its Agent window, the app's window, a desk switch if needed), Back restores the working set this
// page kept for the card, and every answer goes to the home desk as `agent.maia.reach.*`. A sender's name for `{who}` and a
// message's subject for a card's quote come from that desk's own Courier when the card is drawn, and are never sent anywhere.
import type { AppId } from '../../canvas/layout';
import { readPerson, readThread } from '../../apps/courier/wire';
import { wakeDesk } from '../../desk/liveStore';
import { focusDesk, goOverview, openItem } from '../../shell/actions';
import { useLayoutStore } from '../../state/layoutStore';
import { useViewStore } from '../../state/viewStore';
import { openWindow, raiseWindow, requestClose, setWindowRect, toggleFull, useWindowStore } from '../../state/windowStore';
import { restorePlan, type Snapshot } from '../back';
import { enterMaiaMode } from '../door';
import { snapshotNow } from '../focusEnv';
import { deskRead, reachCall } from '../focusSource';
import type { CatchUp, ReachBack, ReachCard, ReachGo, Who } from '../reach';
import { lastBack, snapshots, useShieldUi } from './state';

/** The app a go opens, as the office names its apps. */
export function appOfGo(go: ReachGo): { deskId: string; app: string } | null {
  switch (go.kind) {
    case 'approvals':
      return { deskId: go.deskId, app: 'agent' };
    case 'show':
      return { deskId: go.deskId, app: go.app };
    case 'doc':
      return { deskId: go.deskId, app: 'files' };
    case 'notes':
      return go.deskId ? { deskId: go.deskId, app: 'notebook' } : null;
    case 'back':
      return go.deskId && go.app ? { deskId: go.deskId, app: go.app } : null;
    default:
      return null;
  }
}

/** Opens `app` on `deskId` the way a tile does: the desk comes to the front first if it isn't, and wakes if it's asleep. */
export function openApp(deskId: string, app: string): void {
  const desk = useLayoutStore.getState().desks[deskId];
  const item = desk?.items.find((i) => i.app === app);
  if (item) openItem(deskId, item.id);
  else focusDesk(deskId);
}

/** A card's, a rider's or a catch-up line's one thing, in the desk view. */
export function runGo(go: ReachGo, deskId: string | null = null): void {
  if (go.kind === 'back') {
    restoreBack({ cardId: go.cardId, deskId: go.deskId, app: go.app, item: go.item, label: '', resume: '', surface: null, until: null });
    return;
  }
  if (go.kind === 'result') {
    enterMaiaMode(null);
    return;
  }
  if (go.kind === 'wake') {
    const id = go.deskId ?? deskId;
    if (id) {
      wakeDesk(id);
      focusDesk(id);
    }
    return;
  }
  const at = appOfGo(go.kind === 'notes' && !go.deskId && deskId ? { kind: 'notes', deskId } : go);
  if (at) openApp(at.deskId, at.app);
}

/** Puts a snapshot back exactly: the camera, every window at its place, the stacking, the active one (`back.ts`'s plan). */
export function restore(s: Snapshot): void {
  const { windows } = useWindowStore.getState();
  const view = useViewStore.getState();
  const plan = restorePlan(s, Object.values(windows), { camera: view.mode, deskId: view.activeDesk });
  if (plan.camera?.mode === 'overview') goOverview();
  else if (plan.camera) focusDesk(plan.camera.deskId);
  for (const k of plan.close) requestClose(k);
  for (const w of plan.open) openWindow(w.deskId, w.app as AppId, w.itemId);
  for (const p of plan.places) {
    setWindowRect(p.key, p.rect);
    const cur = useWindowStore.getState().windows[p.key];
    if (cur && cur.mode !== p.mode) toggleFull(p.key);
  }
  for (const k of plan.raise) raiseWindow(k);
  if (plan.active) raiseWindow(plan.active);
}

/**
 * "Back to …": the windows this page kept for the card, else the desk, app and item the desk names (another device's card). The
 * ready-to-resume line shows over the item for 5 s; the desk hears it was taken.
 */
export function restoreBack(back: ReachBack): void {
  const snap = snapshots.get(back.cardId);
  if (snap) restore(snap);
  else if (back.deskId && back.app) openApp(back.deskId, back.app);
  else if (back.deskId) focusDesk(back.deskId);
  if (back.resume) useShieldUi.setState({ resume: { text: back.resume, at: Date.now() } });
  snapshots.drop(back.cardId);
  if (lastBack.back?.cardId === back.cardId) lastBack.back = null;
  void reachCall('agent.maia.reach.back', { cardId: back.cardId, taken: true }).catch(() => undefined);
}

/** A card this page shows for the first time: the working set as it is now, kept for Back. */
export function keepSnapshot(card: ReachCard): void {
  if (!snapshots.get(card.cardId)) snapshots.put(snapshotNow(card.cardId));
}

// ----- answers

export const answerCard = (card: ReachCard, answer: string): Promise<unknown> => reachCall('agent.maia.reach.answer', { cardId: card.cardId, answer });
export const answerItem = (itemId: string, answer: string): Promise<unknown> => reachCall('agent.maia.reach.answer', { itemId, answer });
export const answerCatchup = (c: CatchUp, answer: 'open' | 'dismiss'): Promise<unknown> => reachCall('agent.maia.reach.answer', { catchupId: c.catchupId, answer });

/** A catch-up question's choice: the plain answers by name, a week pick or a pace by `pick` (§23). */
export function answerQuestion(c: CatchUp, questionId: string, choiceId: string): Promise<unknown> {
  const pick = questionId === 'pace' || (questionId === 'week_pick' && choiceId.startsWith('pick-')) || !/^[a-z_]{1,24}$/.test(choiceId);
  return reachCall('agent.maia.reach.answer', { catchupId: c.catchupId, questionId, ...(pick ? { pick: choiceId } : { answer: choiceId }) });
}

export const hold = (how: { minutes: number } | { until: 'catchup' | 'tomorrow' } | { clear: true }): Promise<unknown> => reachCall('agent.maia.reach.hold', how);
export const clearWorking = (): Promise<unknown> => reachCall('agent.maia.reach.working.clear', {});

// ----- names and quotes, from that desk's Courier at draw time (never kept past the page, never sent)

const names = new Map<string, Promise<string | null>>();
/** The sender's name as that desk's Courier has it, for `{who}`; null when the desk can't say (the words say "Someone"). */
export function nameOf(w: Who | null): Promise<string | null> {
  if (!w) return Promise.resolve(null);
  const key = `${w.deskId}|${w.contactId}`;
  let p = names.get(key);
  if (!p) {
    p = deskRead(w.deskId, 'courier.contact.get', { contactId: w.contactId }).then(
      (r) => readPerson(r)?.name || null,
      () => null,
    );
    names.set(key, p);
    // A failure is asked again on the next card.
    void p.then((n) => n ?? names.delete(key));
  }
  return p;
}

/** The newest subject they wrote in that channel, in their own words, for the card's quote; null when there's none. */
export function quoteOf(q: { deskId: string; channelId: string } | null): Promise<string | null> {
  if (!q) return Promise.resolve(null);
  return deskRead(q.deskId, 'courier.thread', { channelId: q.channelId, limit: 5 }).then(
    (r) => {
      const t = readThread(r);
      const theirs = t?.messages.filter((m) => m.direction === 'in' && m.subject.trim()).sort((a, b) => b.at - a.at)[0];
      return theirs ? theirs.subject.replace(/\s+/g, ' ').trim().slice(0, 120) : null;
    },
    () => null,
  );
}

/** A change of member: no name stays. */
export function forgetNames(): void {
  names.clear();
}
