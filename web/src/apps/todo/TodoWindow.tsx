// The To-do window: the Agent's host (`agent/AgentWindow.tsx`, `HostedWindow`) with To-do's words and `TodoBody` as the lazy
// chunk. Only this file is in the initial chunk. Rendering wakes nothing: "Wake this desk" is the member's own press, and
// opening the window already asked (`shell/actions.ts`). Once open it stays mounted through a dropped link or a sleeping desk,
// so a half-typed to-do is never lost: the list stays readable, dimmed and inert, under what's wrong.
import { lazy } from 'react';
import { HostedWindow, type HostCopy } from '../../agent/AgentWindow';
import { loadTodoBody } from '../chunks';
import type { AppWindowProps } from '../registry';

const TodoBody = lazy(loadTodoBody);
const COPY: HostCopy = { name: 'todo', title: 'To-do', asleepLine: 'Your to-dos wait on your desk.', dim: true };

export function TodoWindow(props: AppWindowProps) {
  return <HostedWindow {...props} Body={TodoBody} load={loadTodoBody} copy={COPY} />;
}
