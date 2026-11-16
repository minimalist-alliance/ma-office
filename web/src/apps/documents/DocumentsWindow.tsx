// The Documents window: the Agent's host (`agent/AgentWindow.tsx`, `HostedWindow`) with Documents' words and `DocumentsBody` as
// the lazy chunk, as To-do's is. Only this file is in the windows' chunk. Rendering wakes nothing: "Wake this desk" is the
// member's own press, and opening the window already asked (`shell/actions.ts`). Once open it stays mounted through a dropped
// link or a sleeping desk, the list readable, dimmed and inert, under what's wrong.
import { lazy } from 'react';
import { HostedWindow, type HostCopy } from '../../agent/AgentWindow';
import { loadDocumentsBody } from '../chunks';
import type { AppWindowProps } from '../registry';

const DocumentsBody = lazy(loadDocumentsBody);
const COPY: HostCopy = { name: 'documents', title: 'Documents', asleepLine: 'Your documents wait on your desk.', dim: true };

export function DocumentsWindow(props: AppWindowProps) {
  return <HostedWindow {...props} Body={DocumentsBody} load={loadDocumentsBody} copy={COPY} />;
}
