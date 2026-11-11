// Where the office's other parts say a setup step was used (the Browser's first picture, a finished upload, an Agent with a
// working provider). It imports nothing, so the desk link and the Browser can call it without pulling the setup circle,
// or its imports, into their own: `signals.ts` listens once the Shell is up, and anything said before is kept.
import type { Agent } from '../../agent/src/client/types';
import type { DeskLink } from '../desk/deskLink';
import type { StepId } from './steps';

type Listener = (id: StepId, deskId?: string) => void;
let listener: Listener | null = null;
const early: [StepId, string | undefined][] = [];

/** A step the member just used, on this desk where there's one. */
export function stepUsed(id: StepId, deskId?: string): void {
  if (listener) listener(id, deskId);
  else if (early.length < 20) early.push([id, deskId]);
}

export function onStepUsed(fn: Listener): () => void {
  listener = fn;
  for (const [id, deskId] of early.splice(0)) fn(id, deskId);
  return () => {
    if (listener === fn) listener = null;
  };
}

/** An agent that has a provider to work with: a key bound, and not dormant or failing. */
const working = (a: Pick<Agent, 'status' | 'binding'>): boolean => !!a.binding && a.status !== 'no_key' && a.status !== 'error';

/** Each `agent.state` from a desk (`desk/liveStore.ts`). Only the statuses are read, never what an agent says. */
export function agentsSeen(deskId: string, agents: readonly Pick<Agent, 'status' | 'binding'>[]): void {
  if (agents.some(working)) stepUsed('agent-key', deskId);
}

/**
 * "Put a file in Files": a desk link's `files.upload.finish` that answered, which is one upload the office itself carried
 * to the desk. Only that it finished, never its name or size. Watched on the link (`desk/liveStore.ts`, where each desk's
 * link is made), so the Files window's own code is untouched.
 */
export function watchUploads(link: DeskLink): void {
  const call = link.call.bind(link) as DeskLink['call'];
  link.call = ((method, params, options) => {
    const answer = call(method, params, options);
    if (method === 'files.upload.finish') answer.then(() => stepUsed('files', link.deskId), () => undefined);
    return answer;
  }) as DeskLink['call'];
}
