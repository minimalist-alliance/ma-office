// Maia's welcome's state in the first load, apart from the door so a module that only asks (the mark's menu, the tour, Maia
// Mode's startup) never pulls in the loading overlay or the canvas: whether it decides or runs, and "Set up my office with
// Maia". `door.tsx` drives it.
import type { ComponentType } from 'react';
import { create } from 'zustand';
import { useSession } from '../platform/session';
import { welcomeOn } from './seams';
import { newMember, welcomeRecord } from './due';

export type WelcomeDoor = 'deciding' | 'off' | 'due' | 'running' | 'done';

export interface LayerProps {
  redo: boolean;
  onEnd: () => void;
}

interface DoorState {
  state: WelcomeDoor;
  redo: boolean;
  /** The reveal lifted the dimming: the office shows again under the welcome's last card. */
  lifted: boolean;
  Layer: ComponentType<LayerProps> | null;
}
export const useWelcomeDoor = create<DoorState>(() => ({ state: 'deciding', redo: false, lifted: false, Layer: null }));

/**
 * While the welcome decides for a member it may be due for, or runs, the tour and Maia's first-load question wait their turn
 * (`tour/door.ts`, `maiamode/startup.ts`). A member it can't be due for (by `/v1/me`) never waits on it.
 */
export function welcomeHolds(): boolean {
  const s = useWelcomeDoor.getState().state;
  if (s === 'due' || s === 'running') return true;
  if (s !== 'deciding') return false;
  const { me, config } = useSession.getState();
  if (config && !welcomeOn(config)) return false;
  if (!me) return true;
  return newMember(me) || welcomeRecord()?.state === 'later';
}

let loading: Promise<ComponentType<LayerProps>> | null = null;
export function load(): Promise<ComponentType<LayerProps>> {
  loading ??= import('./WelcomeLayer')
    .then((m) => m.ready())
    .then(
      (Layer) => {
        useWelcomeDoor.setState({ Layer });
        return Layer;
      },
      (err: unknown) => {
        loading = null;
        throw err;
      },
    );
  return loading;
}

/** "Set up my office with Maia" (the mark's menu): a redo at Q1, the threshold skipped (§10 "Redo"). */
export function startWelcome(): void {
  void load().then(
    () => useWelcomeDoor.setState({ state: 'running', redo: true }),
    () => undefined,
  );
}
