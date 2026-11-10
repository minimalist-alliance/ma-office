// One requestAnimationFrame for every Maia on the page, and none at all while no Maia needs a frame:
// asleep, hidden, off screen, paused, or settled with nothing left to move.

export interface Actor {
  /** Whether she needs frames right now. Checked before and after every frame. */
  active(): boolean;
  frame(now: number): void;
}

const actors = new Set<Actor>();
let raf = 0;

export function running(actor: Actor): boolean {
  return actors.has(actor);
}

/** Ask for frames. An actor that isn't active is let go at the next frame and has to ask again. */
export function run(actor: Actor): void {
  if (!actor.active()) return;
  actors.add(actor);
  if (!raf) raf = requestAnimationFrame(tick);
}

export function stop(actor: Actor): void {
  actors.delete(actor);
  if (!actors.size && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

function tick(now: number): void {
  raf = 0;
  for (const actor of actors) { // a Set may lose its current item mid-loop, and nothing is copied per frame
    if (actor.active()) actor.frame(now);
    if (!actor.active()) actors.delete(actor);
  }
  if (actors.size) raf = requestAnimationFrame(tick);
}
