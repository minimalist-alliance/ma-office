// The desk's refusals the welcome reads, apart from the queue (`apply.ts`) so a test needs nothing else.
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** The desk's word that a helper couldn't run now, so it wasn't made (desk-agent's `agent.create` with `ifRunnable`). */
export function cantRun(e: unknown): boolean {
  const err = obj(e);
  return err['code'] === 'precondition_failed' && obj(err['details'])['reason'] === 'cant_run';
}
