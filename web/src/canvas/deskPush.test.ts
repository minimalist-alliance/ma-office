import { describe, expect, it } from 'vitest';
import { clearSpot, createDeskPush, DESK_GAP, separateDesks, separation, type DeskBox } from './deskPush';

const box = (id: string, x: number, y: number, w = 200, h = 100): DeskBox => ({ id, x, y, w, h });

/** A small seeded random, so a failure can be run again. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function worstPair(desks: readonly DeskBox[]): number {
  let worst = Infinity;
  for (let i = 0; i < desks.length; i += 1) {
    for (let j = i + 1; j < desks.length; j += 1) worst = Math.min(worst, separation(desks[i]!, desks[j]!));
  }
  return worst;
}

const applied = (desks: readonly DeskBox[], moves: readonly { id: string; x: number; y: number }[]): DeskBox[] =>
  desks.map((d) => {
    const m = moves.find((v) => v.id === d.id);
    return m ? { ...d, x: m.x, y: m.y } : d;
  });

/** A live push as a list of boxes: the desk in hand at `held`, the rest where the push put them. */
function run(desks: readonly DeskBox[], heldId: string): { at(held: Partial<DeskBox>): DeskBox[]; push: ReturnType<typeof createDeskPush> } {
  const push = createDeskPush(desks, heldId);
  const start = desks.find((d) => d.id === heldId)!;
  return {
    push,
    at: (held) => {
      const rect = { ...start, ...held };
      const out = push.step(rect);
      return desks.map((d) => {
        if (d.id === heldId) return rect;
        const b = out.find((o) => o.id === d.id)!;
        return { ...d, x: b.x, y: b.y };
      });
    },
  };
}

const find = (desks: readonly DeskBox[], id: string): DeskBox => desks.find((d) => d.id === id)!;

describe('the gap', () => {
  it('is one constant, matching a desk\'s padding', () => {
    expect(DESK_GAP).toBe(24);
  });

  it('measures apart, touching and overlapping', () => {
    expect(separation(box('a', 0, 0), box('b', 230, 0))).toBe(30);
    expect(separation(box('a', 0, 0), box('b', 200, 0))).toBe(0);
    expect(separation(box('a', 0, 0), box('b', 190, 50))).toBe(-10);
    expect(separation(box('a', 0, 0), box('b', 230, 150))).toBe(50); // the wider of the two axes keeps them clear
  });
});

describe('pushing a neighbour', () => {
  const pair = [box('a', 0, 0), box('b', 300, 0)]; // 100 apart

  it('leaves it alone until the gap is reached', () => {
    const { at } = run(pair, 'a');
    expect(find(at({ x: 76 }), 'b').x).toBe(300);
  });

  it('moves it exactly with the desk in hand once the gap is reached, and keeps the gap', () => {
    const { at } = run(pair, 'a');
    at({ x: 76 });
    const after = at({ x: 150 });
    expect(find(after, 'b').x).toBe(150 + 200 + DESK_GAP);
    expect(separation(find(after, 'a'), find(after, 'b'))).toBe(DESK_GAP);
  });

  it('never moves the desk in hand', () => {
    const { at } = run(pair, 'a');
    expect(find(at({ x: 777, y: 13 }), 'a')).toMatchObject({ x: 777, y: 13 });
  });

  it('brings it back on a retreat, to exactly where it was', () => {
    const { at } = run(pair, 'a');
    for (const x of [50, 100, 200, 400, 200, 100, 50]) at({ x });
    expect(find(at({ x: 0 }), 'b')).toMatchObject({ x: 300, y: 0 });
  });

  it.each([
    ['left', box('b', -300, 0), { x: -150 }, { x: -150 - DESK_GAP - 200, y: 0 }],
    ['down', box('b', 0, 200), { y: 150 }, { x: 0, y: 150 + 100 + DESK_GAP }],
    ['up', box('b', 0, -200), { y: -150 }, { x: 0, y: -150 - DESK_GAP - 100 }],
  ] as const)('works %s too, into negative coordinates', (_name, other, step, expected) => {
    const { at } = run([box('a', 0, 0), other], 'a');
    const half = { x: 'x' in step ? step.x / 3 : 0, y: 'y' in step ? step.y / 3 : 0 };
    at(half);
    expect(find(at(step), 'b')).toMatchObject(expected);
  });

  it('holds its direction for as long as it is pushed, even when the other axis gets shallower', () => {
    const { at } = run([box('a', 0, 0, 200, 100), box('b', 300, 0, 200, 100)], 'a');
    at({ x: 80 }); // first contact, from the left
    expect(find(at({ x: 200 }), 'b')).toMatchObject({ x: 424, y: 0 });
    const lower = at({ x: 200, y: 80 }); // now the shallower way out would be down
    expect(find(lower, 'b')).toMatchObject({ x: 424, y: 0 });
  });

  it('as the desk in hand rises off its level, comes back one unit per unit risen, with no jump home', () => {
    const { at } = run([box('a', 0, 0), box('b', 300, 0)], 'a');
    at({ x: 80 });
    at({ x: 400 }); // pushed 200 past rest... b is at 624
    expect(find(at({ x: 400, y: 0 }), 'b').x).toBe(624);
    // Level until a's top passes b's bottom plus the gap.
    expect(find(at({ x: 400, y: -124 }), 'b').x).toBe(624);
    expect(find(at({ x: 400, y: -134 }), 'b').x).toBe(614);
    expect(find(at({ x: 400, y: -224 }), 'b').x).toBe(524);
    expect(find(at({ x: 400, y: -1000 }), 'b').x).toBe(300);
  });

  it('a neighbour back at rest can be met from another side, with no sideways jump', () => {
    const { at } = run([box('a', 0, 0), box('b', 300, 0)], 'a');
    at({ x: 80 }); // from the left
    at({ x: 90 });
    at({ x: 0 }); // back at rest
    at({ x: 0, y: -200 }); // up
    at({ x: 300, y: -200 }); // and over it, well clear
    const touched = at({ x: 300, y: -120 }); // and down onto it
    expect(find(touched, 'b').x).toBe(300);
    expect(find(touched, 'b').y).toBeCloseTo(4, 6); // 4 past the gap: pushed down, by no more than the move
  });

  it('no swap by speed: a pointer that jumps right past a neighbour still pushes it ahead', () => {
    const { at } = run([box('a', 0, 0), box('b', 300, 0)], 'a');
    const after = at({ x: 2000 });
    expect(find(after, 'b').x).toBe(2000 + 200 + DESK_GAP);
  });

  it('a pointer that jumps past on another level touches nothing', () => {
    const { at } = run([box('a', 0, 0), box('b', 300, 0)], 'a');
    expect(find(at({ x: 2000, y: 3000 }), 'b')).toMatchObject({ x: 300, y: 0 });
  });

  it('going round: a neighbour pushed and left can be passed, and the desk in hand can land beyond it', () => {
    const { at } = run([box('a', 0, 0), box('b', 300, 0)], 'a');
    at({ x: 90 }); // touched, and pushed a little
    at({ x: 90, y: -300 }); // up and away: it's home again
    at({ x: 700, y: -300 }); // over it
    const landed = at({ x: 700, y: 0 }); // and down beyond it
    expect(find(landed, 'b')).toMatchObject({ x: 300, y: 0 });
  });

  it('a neighbour pushed before keeps its direction if it can without jumping', () => {
    const { at } = run([box('a', 0, 0), box('b', 300, 0)], 'a');
    at({ x: 90 });
    at({ x: 0 });
    // Back in on a diagonal to the same side: down would be just as shallow, and it still goes right.
    const again = at({ x: 80, y: 10 });
    expect(find(again, 'b').y).toBe(0);
    expect(find(again, 'b').x).toBeCloseTo(304, 6);
  });
});

describe('chains', () => {
  const row = [box('a', 0, 0), box('b', 250, 0), box('c', 500, 0), box('d', 750, 0)]; // 50 apart

  it('a chain of three moves on together, exactly, and keeps every gap', () => {
    const { at } = run(row, 'a');
    at({ x: 20 });
    at({ x: 40 });
    const after = at({ x: 200 });
    expect(find(after, 'b').x).toBe(200 + 224);
    expect(find(after, 'c').x).toBe(200 + 448);
    expect(find(after, 'd').x).toBe(200 + 672);
  });

  it('comes all the way back', () => {
    const { at } = run(row, 'a');
    for (const x of [20, 40, 100, 200, 100, 40, 20]) at({ x });
    const back = at({ x: 0 });
    expect(back.map((d) => d.x)).toEqual([0, 250, 500, 750]);
  });

  it('turns corners: pushed right into something, then that pushed down', () => {
    const desks = [box('a', 0, 0), box('b', 250, 0), box('c', 250, 150)];
    const { at } = run(desks, 'b');
    at({ y: 20 }); // 50 apart, so 26 still to go
    const after = at({ y: 100 });
    expect(find(after, 'c')).toMatchObject({ x: 250, y: 100 + 100 + DESK_GAP });
    expect(find(after, 'a')).toMatchObject({ x: 0, y: 0 });
  });

  it('both axes at once: one desk pushes two ways', () => {
    const desks = [box('a', 0, 0), box('b', 240, 0), box('c', 0, 140)];
    const { at } = run(desks, 'a');
    at({ x: 5, y: 5 });
    const after = at({ x: 50, y: 50 });
    expect(find(after, 'b').x).toBe(50 + 200 + DESK_GAP);
    expect(find(after, 'c').y).toBe(50 + 100 + DESK_GAP);
  });
});

describe('growing', () => {
  it('pushes what is right of the corner rightward, and what is below downward', () => {
    const desks = [box('a', 0, 0, 200, 200), box('r', 260, 0), box('b', 0, 260)];
    const { at } = run(desks, 'a');
    at({ w: 230, h: 230 });
    const after = at({ w: 400, h: 500 });
    expect(find(after, 'r')).toMatchObject({ x: 400 + DESK_GAP, y: 0 });
    expect(find(after, 'b')).toMatchObject({ x: 0, y: 500 + DESK_GAP });
    expect(find(after, 'a')).toMatchObject({ x: 0, y: 0, w: 400, h: 500 });
  });

  it('shrinking brings them back', () => {
    const desks = [box('a', 0, 0), box('r', 260, 0)];
    const { at } = run(desks, 'a');
    at({ w: 240 });
    at({ w: 500 });
    expect(find(at({ w: 200 }), 'r').x).toBe(260);
  });

  it('leaves what is to its left and above alone', () => {
    const desks = [box('a', 300, 300), box('l', 0, 300), box('t', 300, 0)];
    const { at } = run(desks, 'a');
    const after = at({ w: 800, h: 800 });
    expect(find(after, 'l')).toMatchObject({ x: 0, y: 300 });
    expect(find(after, 't')).toMatchObject({ x: 300, y: 0 });
  });

  it('a one-shot growth, like cleanup, pushes only down when only the height grew', () => {
    // `side` is only 10 to the right of it, so growing past its top reaches it: down, like everything else.
    const desks = [box('a', 0, 0, 200, 200), box('b', 0, 260), box('side', 210, 400), box('clear', 228, 400)];
    const out = createDeskPush(desks, 'a').final({ ...desks[0]!, h: 500 });
    const moved = Object.fromEntries(out.map((o) => [o.id, { x: o.x, y: o.y }]));
    expect(moved['b']).toEqual({ x: 0, y: 524 });
    expect(moved['side']).toEqual({ x: 210, y: 648 }); // and it's under `b`, which came down first
    expect(moved['clear']).toEqual({ x: 228, y: 400 }); // 28 to the right is already clear
  });
});

describe('desks closer than the gap to begin with', () => {
  it('don\'t jump the moment anything moves: they keep the gap they had', () => {
    const { at } = run([box('a', 0, 0), box('b', 210, 0)], 'a'); // 10 apart
    expect(find(at({ x: 1 }), 'b').x).toBe(211);
    expect(find(at({ x: 2 }), 'b').x).toBe(212);
    expect(find(at({ x: 0 }), 'b').x).toBe(210);
  });

  it('touching desks stay touching rather than jump', () => {
    const { at } = run([box('a', 0, 0), box('b', 200, 0)], 'a');
    expect(find(at({ x: 3 }), 'b').x).toBe(203);
  });

  it('a pair nothing touches stays as close as it was', () => {
    const { at } = run([box('a', 0, 0), box('b', 0, 500), box('c', 210, 500)], 'a');
    const after = at({ x: 100 });
    expect(find(after, 'b').x).toBe(0);
    expect(find(after, 'c').x).toBe(210);
  });
});

describe('the last solve', () => {
  it('lands in two decimals, and rounding never takes from the gap', () => {
    const desks = [box('a', 0, 0), box('b', 250.5, 0), box('c', 500.25, 0)];
    const out = createDeskPush(desks, 'a').final({ ...desks[0]!, x: 100.37 });
    const b = out.find((o) => o.id === 'b')!;
    const c = out.find((o) => o.id === 'c')!;
    expect(b.x).toBe(324.37);
    expect(c.x).toBe(548.37);
    const f = (v: number): boolean => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
    expect(f(b.x) && f(c.x)).toBe(true);
  });

  it('reports only what the solve moved', () => {
    const desks = [box('a', 0, 0), box('b', 250, 0), box('far', 5000, 0)];
    const push = createDeskPush(desks, 'a');
    const moved = (r: readonly { id: string; changed: boolean }[]): string[] => r.filter((o) => o.changed).map((o) => o.id);
    expect(moved(push.step({ ...desks[0]!, x: 100 }))).toEqual(['a', 'b']);
    expect(moved(push.step({ ...desks[0]!, x: 100 }))).toEqual([]);
  });
});

// A real office: a few desks of real sizes, all at least the gap apart, as the store keeps them.
function office(rnd: () => number, count: number): DeskBox[] {
  const placed: DeskBox[] = [];
  for (let i = 0; placed.length < count && i < count * 40; i += 1) {
    const d = box(`d${placed.length}`, Math.round(rnd() * 2400) - 1200, Math.round(rnd() * 1600) - 800, 232 + Math.round(rnd() * 500), 124 + Math.round(rnd() * 300));
    if (placed.every((p) => separation(d, p) >= DESK_GAP)) placed.push(d);
  }
  return placed;
}

// Mostly small steps with a real pointer's habits, some long sweeps, and now and then a jump.
function pointerPath(rnd: () => number, from: { x: number; y: number }, steps: number): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = [];
  let { x, y } = from;
  let heading = rnd() * Math.PI * 2;
  for (let i = 0; i < steps; i += 1) {
    if (rnd() < 0.08) heading = rnd() * Math.PI * 2;
    const speed = rnd() < 0.03 ? 200 : 2 + rnd() * 18;
    x += Math.cos(heading) * speed;
    y += Math.sin(heading) * speed;
    path.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  }
  return path;
}

describe('randomised drags: many offices, many paths', () => {
  const SEEDS = 300;

  it('never leaves an overlap or a gap under the minimum, at any step, dragging', () => {
    let untangled = 0;
    let steps = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = random(seed);
      const desks = office(rnd, 4 + Math.floor(rnd() * 12));
      const held = desks[Math.floor(rnd() * desks.length)]!;
      const { at, push } = run(desks, held.id);
      for (const p of pointerPath(rnd, held, 120)) {
        const now = at(p);
        steps += 1;
        if (worstPair(now) < DESK_GAP - 1e-6) expect.fail(`seed ${seed}: ${worstPair(now)}`);
      }
      untangled += push.untangled;
    }
    expect(steps).toBeGreaterThan(30_000);
    expect(untangled).toBe(0);
  }, 60_000);

  it('never leaves an overlap or a gap under the minimum, growing', () => {
    let untangled = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = random(seed * 7 + 1);
      const desks = office(rnd, 4 + Math.floor(rnd() * 12));
      const held = desks[Math.floor(rnd() * desks.length)]!;
      const { at, push } = run(desks, held.id);
      let { w, h } = held;
      for (let i = 0; i < 100; i += 1) {
        w = Math.max(232, w + (rnd() - 0.35) * 40);
        h = Math.max(124, h + (rnd() - 0.35) * 40);
        const worst = worstPair(at({ w, h }));
        if (worst < DESK_GAP - 1e-6) expect.fail(`seed ${seed}: ${worst}`);
      }
      untangled += push.untangled;
    }
    expect(untangled).toBe(0);
  }, 60_000);

  // The heart of it. A desk's step is measured against the pointer's |dx| + |dy|: a neighbour coming back while the
  // desk in hand also moves along it takes both. It's exact along one axis, and a cascade adds nothing.
  it('no pushed desk ever moves more in one step than the pointer did', () => {
    let worst = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = random(seed * 13 + 5);
      const desks = office(rnd, 4 + Math.floor(rnd() * 12));
      const held = desks[Math.floor(rnd() * desks.length)]!;
      const { at } = run(desks, held.id);
      let was = desks;
      let pointer = { x: held.x, y: held.y };
      for (const p of pointerPath(rnd, held, 120)) {
        const now = at(p);
        const pointerMoved = Math.abs(p.x - pointer.x) + Math.abs(p.y - pointer.y);
        for (const d of now) {
          if (d.id === held.id) continue;
          const before = find(was, d.id);
          const moved = Math.max(Math.abs(d.x - before.x), Math.abs(d.y - before.y));
          worst = Math.max(worst, moved / Math.max(pointerMoved, 1e-6));
          if (moved > pointerMoved + 1e-6) expect.fail(`seed ${seed}, ${d.id}: moved ${moved}, the pointer ${pointerMoved}`);
        }
        was = now;
        pointer = p;
      }
    }
    expect(worst).toBeGreaterThan(0.5); // it did get pushed
  }, 60_000);

  const isHome = (now: readonly DeskBox[], desks: readonly DeskBox[]): boolean =>
    desks.every((d) => Math.abs(find(now, d.id).x - d.x) < 1e-6 && Math.abs(find(now, d.id).y - d.y) < 1e-6);

  it('straight out and back along the same line brings every desk back to exactly where it was', () => {
    let pushed = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = random(seed * 17 + 9);
      const desks = office(rnd, 4 + Math.floor(rnd() * 10));
      const held = desks[Math.floor(rnd() * desks.length)]!;
      const { at } = run(desks, held.id);
      const heading = rnd() * Math.PI * 2;
      const path = Array.from({ length: 40 }, (_, i) => ({ x: held.x + Math.cos(heading) * i * 12, y: held.y + Math.sin(heading) * i * 12 }));
      for (const p of path) if (!isHome(at(p).filter((d) => d.id !== held.id), desks.filter((d) => d.id !== held.id))) pushed += 1;
      for (const p of [...path].reverse()) at(p);
      const back = at({ x: held.x, y: held.y });
      if (!isHome(back, desks)) expect.fail(`seed ${seed}: not back`);
    }
    expect(pushed).toBeGreaterThan(500); // these were real pushes
  }, 60_000);

  // A wander can leave a neighbour for good, say by rising right above it, and then come back level with it from
  // another side: that's a new contact, and it goes that way. No rule can undo that without a neighbour jumping, as
  // the desk in hand can be a few units from its start with a neighbour pushed a long way. So this one isn't zero.
  it('a retreat along a long wander brings nearly every office back exactly, and never overlaps or hops on the way', () => {
    let notBack = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = random(seed * 29 + 3);
      const desks = office(rnd, 4 + Math.floor(rnd() * 10));
      const held = desks[Math.floor(rnd() * desks.length)]!;
      const { at } = run(desks, held.id);
      const path = pointerPath(rnd, held, 60);
      for (const p of path) at(p);
      let was = at(path[path.length - 1]!);
      let pointer = path[path.length - 1]!;
      for (const p of [...path].reverse()) {
        const now = at(p);
        if (worstPair(now) < DESK_GAP - 1e-6) expect.fail(`seed ${seed}: overlap on the way back`);
        const allowed = Math.abs(p.x - pointer.x) + Math.abs(p.y - pointer.y) + 1e-6;
        for (const d of now) {
          if (d.id !== held.id && Math.max(Math.abs(d.x - find(was, d.id).x), Math.abs(d.y - find(was, d.id).y)) > allowed) expect.fail(`seed ${seed}, ${d.id}: hopped on the way back`);
        }
        was = now;
        pointer = p;
      }
      if (!isHome(at({ x: held.x, y: held.y }), desks)) notBack += 1;
    }
    expect(notBack).toBeLessThan(SEEDS * 0.08);
  }, 60_000);

  it('a hand isn\'t a ruler: out and roughly back, and every desk is where it was when the pointer is', () => {
    let notBack = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = random(seed * 41 + 7);
      const desks = office(rnd, 4 + Math.floor(rnd() * 10));
      const held = desks[Math.floor(rnd() * desks.length)]!;
      const { at } = run(desks, held.id);
      const heading = rnd() * Math.PI * 2;
      const shaky = (i: number): { x: number; y: number } => ({
        x: held.x + Math.cos(heading) * i * 12 + (rnd() - 0.5) * 8,
        y: held.y + Math.sin(heading) * i * 12 + (rnd() - 0.5) * 8,
      });
      for (let i = 1; i < 40; i += 1) at(shaky(i));
      for (let i = 39; i > 0; i -= 1) at(shaky(i));
      if (!isHome(at({ x: held.x, y: held.y }), desks)) notBack += 1;
    }
    expect(notBack).toBeLessThan(SEEDS * 0.02);
  }, 60_000);

  // Desks at the minimum gap in every direction, and a desk in hand ploughing a thousand units through them, so a
  // desk is being moved by several others on both axes at once. There's never an overlap. A desk that's being moved
  // along follows at the pointer's pace unless it's actually in the way, and now and then it is: one that has fallen
  // behind has to catch up. This holds that to the handful in 90,000 that it is, rather than pretending it's none.
  it('a packed office: never an overlap, and hardly ever a step bigger than the pointer\'s', () => {
    let steps = 0;
    let bigger = 0;
    for (let seed = 1; seed <= 100; seed += 1) {
      const rnd = random(seed * 53 + 1);
      const cols = 3 + Math.floor(rnd() * 4);
      const rows = 3 + Math.floor(rnd() * 3);
      const desks = Array.from({ length: cols * rows }, (_, i) => box(`d${i}`, (i % cols) * (400 + DESK_GAP), Math.floor(i / cols) * (200 + DESK_GAP), 400, 200));
      const held = desks[Math.floor(rnd() * desks.length)]!;
      const { at } = run(desks, held.id);
      let was = desks;
      let pointer = { x: held.x, y: held.y };
      let heading = rnd() * Math.PI * 2;
      for (let i = 0; i < 300; i += 1) {
        if (rnd() < 0.02) heading = rnd() * Math.PI * 2;
        const speed = 2 + rnd() * 18;
        const p = { x: pointer.x + Math.cos(heading) * speed, y: pointer.y + Math.sin(heading) * speed };
        const now = at(p);
        steps += 1;
        if (worstPair(now) < DESK_GAP - 1e-6) expect.fail(`seed ${seed}: overlap`);
        const allowed = Math.abs(p.x - pointer.x) + Math.abs(p.y - pointer.y) + 1e-6;
        if (now.some((d, n) => d.id !== held.id && Math.max(Math.abs(d.x - was[n]!.x), Math.abs(d.y - was[n]!.y)) > allowed)) bigger += 1;
        was = now;
        pointer = p;
      }
    }
    expect(steps).toBe(30_000);
    expect(bigger).toBeLessThanOrEqual(6);
  }, 60_000);

  it('the same path gives the same answer', () => {
    const rnd = random(99);
    const desks = office(rnd, 12);
    const path = pointerPath(rnd, desks[0]!, 80);
    const walk = (): DeskBox[] => {
      const { at } = run(desks, desks[0]!.id);
      let out = desks;
      for (const p of path) out = at(p);
      return out;
    };
    expect(walk()).toEqual(walk());
  });
});

describe('separating a saved layout', () => {
  it('leaves desks that don\'t overlap alone, whatever their gaps, even touching', () => {
    expect(separateDesks([box('a', 0, 0), box('b', 210, 0), box('c', 410, 0), box('d', 0, 100)])).toEqual([]);
  });

  it('moves the least it can', () => {
    const big = box('big', 0, 0, 800, 500);
    const small = box('small', 790, 100, 200, 100); // 10 into its right edge
    expect(separateDesks([big, small])).toEqual([{ id: 'small', x: 824, y: 100 }]);
  });

  it('takes the shorter way out, on either axis', () => {
    const a = box('a', 0, 0, 400, 100);
    const b = box('b', 10, 90, 400, 100); // 10 down, 390 along
    const moves = separateDesks([a, b]);
    const after = applied([a, b], moves);
    expect(worstPair(after)).toBe(DESK_GAP);
    expect(moves).toHaveLength(1);
    const was = moves[0]!.id === 'a' ? a : b;
    expect(Math.abs(moves[0]!.y - was.y)).toBe(34);
    expect(moves[0]!.x).toBe(was.x);
  });

  it('two identical desks: one stays, the other goes the shortest way, and it\'s always the same answer', () => {
    const moves = separateDesks([box('a', 50, 50), box('b', 50, 50)], ['a', 'b']);
    expect(moves).toEqual([{ id: 'b', x: 50, y: 50 + 100 + DESK_GAP }]);
    expect(separateDesks([box('b', 50, 50), box('a', 50, 50)], ['a', 'b'])).toEqual(moves);
  });

  it('a desk inside another comes out the nearest side, and the outer one stays', () => {
    const outer = box('outer', 0, 0, 800, 600);
    const inner = box('inner', 500, 450, 200, 100);
    expect(separateDesks([outer, inner])).toEqual([{ id: 'inner', x: 500, y: 600 + DESK_GAP }]);
  });

  it('a chain clears right through, and a desk in the way of the move is respected', () => {
    const desks = [box('a', 0, 0), box('b', 150, 0), box('c', 300, 0), box('d', 700, 0)];
    const after = applied(desks, separateDesks(desks, ['a']));
    expect(worstPair(after)).toBeGreaterThanOrEqual(DESK_GAP);
    expect(find(after, 'd')).toMatchObject({ x: 700, y: 0 }); // it overlapped nothing
  });

  it('a desk just dropped stays where it was dropped, even when moving it would be less', () => {
    const big = box('big', 0, 0, 800, 500);
    const dropped = box('dropped', 790, 100, 200, 100);
    expect(separateDesks([big, dropped], ['big'], true)).toEqual([{ id: 'dropped', x: 824, y: 100 }]);
    const moves = separateDesks([big, dropped], ['dropped'], true);
    expect(moves.map((m) => m.id)).toEqual(['big']);
  });

  it('keeps the first named in place when moving either would cost the same', () => {
    const moves = separateDesks([box('a', 0, 0), box('b', 190, 0)], ['b', 'a']);
    expect(moves.map((m) => m.id)).toEqual(['a']);
  });

  it('works in negative coordinates', () => {
    const desks = [box('a', -500, -400), box('b', -450, -350)];
    expect(worstPair(applied(desks, separateDesks(desks)))).toBeGreaterThanOrEqual(DESK_GAP);
  });

  it('randomised: no overlap and no new gap under the minimum, deterministic, and a second run does nothing', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const rnd = random(seed * 3 + 11);
      const n = 2 + Math.floor(rnd() * 22);
      const desks = Array.from({ length: n }, (_, i) => box(`d${i}`, Math.round(rnd() * 1800) - 900, Math.round(rnd() * 1200) - 600, 232 + Math.round(rnd() * 400), 124 + Math.round(rnd() * 300)));
      const moves = separateDesks(desks);
      const after = applied(desks, moves);
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const was = separation(desks[i]!, desks[j]!);
          const now = separation(after[i]!, after[j]!);
          // The gap, except for a pair that was already closer than that, without overlapping, and hasn't moved.
          const still = after[i] === desks[i] && after[j] === desks[j] && was >= 0;
          if (now < (still ? was : DESK_GAP) - 1e-6) expect.fail(`seed ${seed}, ${desks[i]!.id} and ${desks[j]!.id}: ${now}`);
        }
      }
      expect(separateDesks(after), `seed ${seed}`).toEqual([]);
      expect(separateDesks([...desks].reverse()), `seed ${seed}`).toEqual(moves);
    }
  }, 60_000);

  it('randomised: desks that overlapped nothing never moved', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rnd = random(seed * 5 + 2);
      const desks = Array.from({ length: 12 }, (_, i) => box(`d${i}`, Math.round(rnd() * 2400), Math.round(rnd() * 1600)));
      const moved = new Set(separateDesks(desks).map((m) => m.id));
      for (const d of desks) {
        if (desks.every((o) => o === d || separation(d, o) >= 0)) expect(moved.has(d.id)).toBe(false);
      }
    }
  });
});

describe('a new desk\'s spot', () => {
  it('is where it was going, if that\'s clear', () => {
    expect(clearSpot(box('n', 800, 0), [box('a', 0, 0)])).toEqual({ x: 800, y: 0 });
  });

  it('moves right past a tall desk from another row, with a new desk\'s room', () => {
    const tall = box('tall', 900, -500, 300, 800);
    expect(clearSpot(box('n', 800, 0), [tall])).toEqual({ x: 1200 + 72, y: 0 });
  });

  it('keeps moving until it\'s clear', () => {
    const others = [box('a', 900, -500, 300, 800), box('b', 1250, -500, 300, 800)];
    const spot = clearSpot(box('n', 800, 0), others);
    expect(spot).toEqual({ x: 1550 + 72, y: 0 });
    expect(others.every((o) => separation({ ...box('n', 0, 0), ...spot }, o) >= DESK_GAP)).toBe(true);
  });
});
