// The Files window: the Agent's host (`agent/AgentWindow.tsx`, `HostedWindow`) with Files' words and `FilesBody` as the lazy chunk.
// Only this file is in the initial chunk. Rendering wakes nothing, here as everywhere: "Wake this desk" is the member's own press
// (and opening the window already asked, `shell/actions.ts`). Once the app has opened it stays mounted, parked or not, through a
// dropped link or a sleeping desk, so the list it last showed, a transfer in progress and an open dialog are never lost: what is
// wrong shows over it, and the list is dimmed and read-only (inert) until the session is back.
import { lazy } from 'react';
import { HostedWindow, type HostCopy } from '../../agent/AgentWindow';
import { loadFilesBody } from '../chunks';
import type { AppWindowProps } from '../registry';

const loadBody = loadFilesBody;
const FilesBody = lazy(loadBody);
const COPY: HostCopy = { name: 'files', title: 'Files', asleepLine: 'Your files wait on your desk.', dim: true };

export function FilesWindow(props: AppWindowProps) {
  return <HostedWindow {...props} Body={FilesBody} load={loadBody} copy={COPY} />;
}
