// The Courier window: the Agent's host (`agent/AgentWindow.tsx`, `HostedWindow`) with Courier's words and `CourierBody` as the
// lazy chunk. Only this file and `door.ts` are in the initial chunk. Rendering wakes nothing; once open it stays mounted through
// a dropped link or a sleeping desk, so a half-written reply is never lost: the list stays readable, dimmed and inert.
import { lazy } from 'react';
import { HostedWindow, type HostCopy } from '../../agent/AgentWindow';
import { loadCourierBody } from '../chunks';
import type { AppWindowProps } from '../registry';

const CourierBody = lazy(loadCourierBody);
const COPY: HostCopy = { name: 'courier', title: 'Courier', asleepLine: 'Your messages wait on your desk.', dim: true };

export function CourierWindow(props: AppWindowProps) {
  return <HostedWindow {...props} Body={CourierBody} load={loadCourierBody} copy={COPY} />;
}
