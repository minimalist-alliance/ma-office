// An installed app's window (ADR 0054), the first load's door: every app's window is in the first load (rule "Chunks that render
// only once opened", 1), so a carousel or an open tile restored as the office comes up finds it. What it shows is the desk app
// host's chunk's (`host/AppView.tsx` `AppWindowBody`): nothing until that's here. An app's window comes from its tile, and a
// tile in the layout loads the host (`watch.ts`).
import type { AppWindowProps } from '../apps/registry';
import { useDoor } from './door';

export function DeskAppWindow(props: AppWindowProps) {
  const host = useDoor((s) => s.host);
  return host ? <host.AppWindowBody {...props} /> : null;
}
