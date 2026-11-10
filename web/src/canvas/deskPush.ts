// Desks on the canvas never overlap (ADR 0064). Pure: no DOM, no Konva, no stores.
//
// A moved or growing desk pushes its neighbours aside. Every position is worked out from where everything was
// when the drag began, each time the pointer moves, so a retreat brings neighbours back and nothing drifts. The
// only thing a push remembers between moves is who is pushing whom, and which way.
//
// What keeps it from hopping. A neighbour is displaced along one side by how far the pusher's edge has come,
// less how far the pusher has gone off the neighbour's other axis:
//
//   displacement = (pusher's edge + gap - neighbour's edge at rest) - (distance beyond the gap on the other axis)
//
// That is continuous everywhere, moves no more than the pointer did, and is exact while they're level. So a
// neighbour pushed right, by a desk that then rises away, comes back one unit per unit risen, rather than jumping
// home the moment they stop being level. A new contact takes the face it came in by, the shallower at a corner. That
// face was clear just before this move, so the overlap is no bigger than the move: no first contact can hop either.
import type { Point, Rect } from './layout';

/** The clear gap between two desks, matching a desk's inner padding (ADR 0064). */
export const DESK_GAP = 24;

// New desks are placed further apart than the minimum, so an office has room until someone packs it tighter.
const NEW_DESK_SPACE = 72;
const EPS = 1e-6;

export interface DeskBox extends Rect {
  id: string;
}

export interface DeskAt extends Point {
  id: string;
}

const clearX = (a: Rect, b: Rect): number => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
const clearY = (a: Rect, b: Rect): number => Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));

/** How far apart two boxes are: positive is clear, zero is touching, negative is overlapping. */
export const separation = (a: Rect, b: Rect): number => Math.max(clearX(a, b), clearY(a, b));

// Two decimals, like everything else in the layout doc, rounded away from whatever is being kept clear of.
const upTo2 = (v: number): number => Math.ceil(v * 100 - EPS) / 100;
const downTo2 = (v: number): number => Math.floor(v * 100 + EPS) / 100;

// ----- a saved layout that overlaps: the smallest moves that clear it, before first paint.

function nearestClear(d: DeskBox, others: readonly Rect[]): Point {
  const xs = [d.x, ...others.flatMap((o) => [downTo2(o.x - d.w - DESK_GAP), upTo2(o.x + o.w + DESK_GAP)])];
  const ys = [d.y, ...others.flatMap((o) => [downTo2(o.y - d.h - DESK_GAP), upTo2(o.y + o.h + DESK_GAP)])];
  let best: Point = { x: d.x, y: d.y };
  let bestCost = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const cost = Math.hypot(x - d.x, y - d.y);
      // Equal moves prefer down, then right, so the answer doesn't depend on the order they're tried in.
      const better = cost < bestCost - EPS || (cost < bestCost + EPS && (y > best.y + EPS || (y > best.y - EPS && x > best.x + EPS)));
      if (better && others.every((o) => separation({ x, y, w: d.w, h: d.h }, o) >= DESK_GAP - EPS)) {
        best = { x, y };
        bestCost = cost;
      }
    }
  }
  return best;
}

function placeInOrder(fixed: readonly DeskBox[], order: readonly DeskBox[]): { moves: DeskAt[]; cost: number } {
  const placed: { box: Rect; moved: boolean }[] = fixed.map((box) => ({ box, moved: false }));
  const moves: DeskAt[] = [];
  let cost = 0;
  for (const d of order) {
    // Two desks where they were saved may stay as close as they were. Anything newly placed keeps the full gap.
    const stays = placed.every((p) => separation(d, p.box) >= (p.moved ? DESK_GAP : 0) - EPS);
    if (stays) {
      placed.push({ box: d, moved: false });
      continue;
    }
    const at = nearestClear(d, placed.map((p) => p.box));
    moves.push({ id: d.id, ...at });
    cost += Math.hypot(at.x - d.x, at.y - d.y);
    placed.push({ box: { ...d, ...at }, moved: true });
  }
  return { moves, cost };
}

/**
 * The moves that leave no two of these desks overlapping. None at all if none overlap, whatever their gaps,
 * so a clean layout is never touched and a second run changes nothing. Desks that overlap nothing never move.
 * Of those that do, it tries keeping the largest in place and, if given, keeping `first` in place, and takes whichever
 * moves less, unless `firstStays` says the order in `first` is what counts: a desk just dropped stays where it was
 * dropped. Deterministic: the order the desks arrive in makes no difference.
 */
export function separateDesks(desks: readonly DeskBox[], first: readonly string[] = [], firstStays = false): DeskAt[] {
  const sorted = [...desks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tangled = sorted.filter((d) => sorted.some((o) => o !== d && separation(d, o) < -EPS));
  if (!tangled.length) return [];
  const fixed = sorted.filter((d) => !tangled.includes(d));
  const rank = (id: string): number => {
    const i = first.indexOf(id);
    return i < 0 ? first.length : i;
  };
  const largest = placeInOrder(fixed, [...tangled].sort((a, b) => b.w * b.h - a.w * a.h));
  if (!first.length) return largest.moves;
  const named = placeInOrder(fixed, [...tangled].sort((a, b) => rank(a.id) - rank(b.id)));
  return !firstStays && largest.cost < named.cost - EPS ? largest.moves : named.moves;
}

/** A new desk's spot: where it was going, or further right past whatever is there, with the room new desks get. */
export function clearSpot(rect: Rect, others: readonly Rect[]): Point {
  let { x } = rect;
  for (let pass = 0; pass <= others.length; pass += 1) {
    const hits = others.filter((o) => separation({ ...rect, x }, o) < DESK_GAP - EPS);
    if (!hits.length) break;
    x = Math.max(...hits.map((o) => o.x + o.w)) + NEW_DESK_SPACE;
  }
  return { x, y: rect.y };
}

// ----- the push itself.

// When, in 0..1 of a move by d, a span `near..far` away is first and last within reach. Not moving, it's always or never.
const entersAt = (d: number, near: number, far: number): number => {
  if (Math.abs(d) < EPS) return near < 0 && far > 0 ? -Infinity : Infinity;
  return d > 0 ? near / d : far / d;
};
const leavesAt = (d: number, near: number, far: number): number => {
  if (Math.abs(d) < EPS) return near < 0 && far > 0 ? Infinity : -Infinity;
  return d > 0 ? far / d : near / d;
};

type Side = 'right' | 'left' | 'down' | 'up';
const SIDES: readonly Side[] = ['right', 'down', 'left', 'up'];
const OPPOSITE: Record<Side, Side> = { right: 'left', left: 'right', down: 'up', up: 'down' };

interface Body extends DeskAt {
  index: number;
  homeX: number;
  homeY: number;
  w: number;
  h: number;
  // How far each side has pushed it in this solve, and where it was after the last one.
  right: number;
  left: number;
  down: number;
  up: number;
  next: Record<Side, number>;
  lastX: number;
  lastY: number;
  lastW: number;
  lastH: number;
  /** How many pushes away from the desk in hand. The lower of two pushes the higher. */
  rank: number;
  /** Did this solve move it? */
  changed: boolean;
}

interface Contact {
  from: Body;
  to: Body;
  side: Side;
  gap: number;
  /** `reach` after the last solve, and whether the neighbour was at rest as far as this contact goes. */
  reach: number;
  resting: boolean;
  gone: boolean;
}

export interface DeskPush {
  /** Every desk, with the one in hand at this rect. Allocates only for a new contact, so it can run per pointer move. */
  step(held: Rect): readonly (DeskAt & { changed: boolean })[];
  /** The same, in two decimals like the rest of the layout doc, and never nearer than the gap. */
  final(held: Rect): readonly (DeskAt & { changed: boolean })[];
  /** Times it found no way through with the pushes it had, and placed desks afresh. Only tests read this. */
  readonly untangled: number;
}

/** Start a push: `desks` as they are right now, and the one in hand. */
export function createDeskPush(desks: readonly DeskBox[], heldId: string): DeskPush {
  const n = desks.length;
  const bodies: Body[] = desks.map((d, index) => ({
    id: d.id, index, homeX: d.x, homeY: d.y, w: d.w, h: d.h, x: d.x, y: d.y,
    right: 0, left: 0, down: 0, up: 0, next: { right: 0, left: 0, down: 0, up: 0 }, lastX: d.x, lastY: d.y, lastW: d.w, lastH: d.h, rank: Infinity, changed: false,
  }));
  const hand = bodies.find((b) => b.id === heldId);
  // Two desks closer than the gap to begin with may stay that close: holding them to the full gap would make one
  // jump the moment anything moved. Two already overlapping are left to the store's check at the drop.
  const gaps = new Float64Array(n * n);
  for (let a = 0; a < n; a += 1) {
    for (let b = 0; b < n; b += 1) {
      const apart = a === b ? -1 : separation(desks[a]!, desks[b]!);
      gaps[a * n + b] = apart < -EPS ? -1 : Math.min(DESK_GAP, Math.max(apart, 0));
    }
  }
  const linked = new Array<Contact | null>(n * n).fill(null);
  const contacts: Contact[] = [];
  let round = false;
  let untangled = 0;

  const moved = (b: Body): boolean => b === hand || b.right > 0 || b.left > 0 || b.down > 0 || b.up > 0;

  const place = (b: Body): void => {
    const x = b.homeX + b.right - b.left;
    const y = b.homeY + b.down - b.up;
    // In the last solve a pushed desk rounds away from what pushed it, so rounding can't take from the gap.
    b.x = !round || b.right === b.left ? x : b.right > b.left ? upTo2(x) : downTo2(x);
    b.y = !round || b.down === b.up ? y : b.down > b.up ? upTo2(y) : downTo2(y);
  };

  // How far off this neighbour's other axis the pusher has gone, beyond the gap. Measured to where the neighbour was
  // after the last move: from where it is now, two pushes at a corner would each give way to the other and run off
  // together along the diagonal. Level as things stand, there's nothing to take off.
  const offX = (a: Body, b: Body, gap: number): number => (clearX(a, b) < gap ? 0 : Math.max(0, Math.max(b.lastX - (a.x + a.w), a.x - (b.lastX + b.w)) - gap));
  const offY = (a: Body, b: Body, gap: number): number => (clearY(a, b) < gap ? 0 : Math.max(0, Math.max(b.lastY - (a.y + a.h), a.y - (b.lastY + b.h)) - gap));

  /** How far this contact wants its neighbour pushed along its side, from rest. */
  const wanted = ({ from: a, to: b, side, gap }: Contact): number => {
    switch (side) {
      case 'right':
        return a.x + a.w + gap - offY(a, b, gap) - b.homeX + b.left;
      case 'left':
        return b.homeX + b.w + gap - offY(a, b, gap) - a.x + b.right;
      case 'down':
        return a.y + a.h + gap - offX(a, b, gap) - b.homeY + b.up;
      default:
        return b.homeY + b.h + gap - offX(a, b, gap) - a.y + b.down;
    }
  };

  /** Has `a` come within the gap of `b` in this move, or gone right past it between two pointer events? */
  const meets = (a: Body, b: Body, gap: number): boolean => {
    if (clearX(a, b) < gap - EPS && clearY(a, b) < gap - EPS) return true;
    const dx = a.x - a.lastX - (b.x - b.lastX);
    const dy = a.y - a.lastY - (b.y - b.lastY);
    if (dx === 0 && dy === 0) return false;
    // How far a's box at its last place is from touching b's, with the gap, on each side.
    const nearX = b.lastX - gap - (a.lastX + a.lastW);
    const farX = b.lastX + b.w + gap - a.lastX;
    const nearY = b.lastY - gap - (a.lastY + a.lastH);
    const farY = b.lastY + b.h + gap - a.lastY;
    const enter = Math.max(entersAt(dx, nearX, farX), entersAt(dy, nearY, farY));
    const leave = Math.min(leavesAt(dx, nearX, farX), leavesAt(dy, nearY, farY));
    return enter < leave && enter < 1 && leave > 0;
  };

  /**
   * Which way a new contact pushes: the face it came in by, which was clear before this move and so is no deeper
   * than the move. Coming in at a corner, both were clear, and it takes the shallower.
   */
  const faceOf = (a: Body, b: Body, gap: number): Side => {
    const depth: Record<Side, number> = {
      right: a.x + a.w + gap - b.x,
      left: b.x + b.w + gap - a.x,
      down: a.y + a.h + gap - b.y,
      up: b.y + b.h + gap - a.y,
    };
    const wasClear: Record<Side, boolean> = {
      right: a.lastX + a.lastW + gap <= b.lastX + EPS,
      left: b.lastX + b.w + gap <= a.lastX + EPS,
      down: a.lastY + a.lastH + gap <= b.lastY + EPS,
      up: b.lastY + b.h + gap <= a.lastY + EPS,
    };
    const faces = SIDES.filter((s) => wasClear[s]);
    return (faces.length ? faces : SIDES).reduce((best, s) => (depth[s] < depth[best] - EPS ? s : best));
  };

  /** How far this desk's edge on this side came in this move. A desk on its way home isn't pushing anything. */
  const closing = (b: Body, side: Side): number => {
    if (b !== hand && b[side] <= 0) return 0;
    switch (side) {
      case 'right':
        return b.x + b.w - (b.lastX + b.lastW);
      case 'left':
        return b.lastX - b.x;
      case 'down':
        return b.y + b.h - (b.lastY + b.lastH);
      default:
        return b.lastY - b.y;
    }
  };

  const meetNew = (): boolean => {
    let found = false;
    for (const first of bodies) {
      if (!moved(first)) continue;
      for (const other of bodies) {
        if (other === first || other === hand) continue;
        const gap = gaps[first.index * n + other.index]!;
        if (gap < 0 || linked[first.index * n + other.index] || linked[other.index * n + first.index]) continue;
        if (!meets(first, other, gap)) continue;
        // Both may be on the move. Whichever is being pushed into the other does the pushing, and if neither is, the
        // one nearer the hand. So pushes run outward from the hand, and a desk can't be pinned between it and
        // something it could have moved.
        const side = faceOf(first, other, gap);
        const mine = Math.max(0, closing(first, side));
        const theirs = Math.max(0, closing(other, OPPOSITE[side]));
        const swap = first !== hand && (theirs > mine + EPS || (theirs > mine - EPS && other.rank < first.rank));
        const from = swap ? other : first;
        const to = swap ? first : other;
        const contact: Contact = { from, to, gap, side: swap ? OPPOSITE[side] : side, reach: Infinity, resting: false, gone: false };
        contacts.push(contact);
        linked[from.index * n + to.index] = contact;
        found = true;
      }
    }
    return found;
  };

  /** How far the pusher's edge is past where this neighbour's edge rests, whatever their other axis. */
  const reach = ({ from: a, to: b, side, gap }: Contact): number => {
    switch (side) {
      case 'right':
        return a.x + a.w + gap - b.homeX;
      case 'left':
        return b.homeX + b.w + gap - a.x;
      case 'down':
        return a.y + a.h + gap - b.homeY;
      default:
        return b.homeY + b.h + gap - a.y;
    }
  };

  /**
   * A direction is held for the rest of the drag, even while it's pushing nothing, so a retreat comes back the way it
   * went. It lets go once the neighbour is at rest and the pusher is behind where they first met, or has gone wholly
   * past where the neighbour rests.
   */
  const letsGo = (c: Contact): boolean => {
    if (wanted(c) > EPS) return false;
    const { from: a, to: b, side, gap } = c;
    if (reach(c) <= EPS) return true;
    switch (side) {
      case 'right':
        return a.x - gap >= b.homeX + b.w - EPS;
      case 'left':
        return a.x + a.w + gap <= b.homeX + EPS;
      case 'down':
        return a.y - gap >= b.homeY + b.h - EPS;
      default:
        return a.y + a.h + gap <= b.homeY + EPS;
    }
  };

  const blocked = (a: Body, b: Body): boolean => {
    const gap = gaps[a.index * n + b.index]!;
    return gap >= 0 && clearX(a, b) < gap - EPS && clearY(a, b) < gap - EPS;
  };

  /** No way through: one desk squeezed between two pushes. Everything from rest, nearest the hand first. */
  const placeAfresh = (): void => {
    untangled += 1;
    const others = bodies.filter((b) => b !== hand).sort((a, b) => a.rank - b.rank || a.index - b.index);
    const placed: Body[] = hand ? [hand] : [];
    for (const b of others) {
      b.x = b.homeX;
      b.y = b.homeY;
      if (placed.some((p) => blocked(p, b))) Object.assign(b, nearestClear(b, placed));
      placed.push(b);
    }
  };

  /**
   * A desk moved along by two pushes at once, on both axes, can be asked to go further in a step than the pointer
   * went. Nothing makes it hurry unless it's actually in the way, so it follows at the pointer's pace, and catches up.
   */
  const keepToPointer = (): void => {
    if (!hand) return;
    const pace = Math.max(
      Math.abs(hand.x - hand.lastX) + Math.abs(hand.y - hand.lastY),
      Math.abs(hand.x + hand.w - hand.lastX - hand.lastW) + Math.abs(hand.y + hand.h - hand.lastY - hand.lastH),
    );
    // More than once, since one can be held up by a neighbour that's about to slow down too.
    for (let round = 0; round < 4; round += 1) {
      let slowed = false;
      for (const b of bodies) {
        if (b === hand || (Math.abs(b.x - b.lastX) <= pace + EPS && Math.abs(b.y - b.lastY) <= pace + EPS)) continue;
        const { x, y } = b;
        b.x = b.lastX + Math.min(pace, Math.max(-pace, x - b.lastX));
        b.y = b.lastY + Math.min(pace, Math.max(-pace, y - b.lastY));
        if (bodies.some((o) => o !== b && blocked(o, b))) {
          b.x = x;
          b.y = y;
        } else {
          slowed = true;
        }
      }
      if (!slowed) break;
    }
  };

  const solve = (held: Rect, last: boolean): readonly Body[] => {
    round = last;
    for (const b of bodies) {
      b.right = 0;
      b.left = 0;
      b.down = 0;
      b.up = 0;
      b.x = b.homeX;
      b.y = b.homeY;
      b.rank = Infinity;
    }
    if (hand) {
      hand.x = held.x;
      hand.y = held.y;
      hand.w = held.w;
      hand.h = held.h;
      hand.rank = 0;
    }
    // Each pass works every displacement out again from where the last pass left the others, so one wanted only on
    // the way there doesn't stick. If that hasn't settled by the time a chain as long as the office would have,
    // displacements may only grow, and it either settles or is pinned.
    let settled = false;
    const passes = 4 * n + 8;
    for (let pass = 0; pass < passes && !settled; pass += 1) {
      settled = true;
      const exact = pass < n + 4;
      for (const b of bodies) {
        for (const side of SIDES) b.next[side] = exact ? 0 : b[side];
      }
      for (const c of contacts) {
        if (c.gone) continue;
        const want = wanted(c);
        if (want <= EPS) continue;
        // At rest, with the pusher going further along its way, not back: that's going round, not a retreat. It
        // would otherwise pick the neighbour up from a distance and drag it out from under the desk.
        if (c.resting && reach(c) > c.reach + EPS) {
          c.gone = true;
          linked[c.from.index * n + c.to.index] = null;
          settled = false;
          continue;
        }
        c.to.rank = Math.min(c.to.rank, c.from.rank + 1);
        if (want > c.to.next[c.side]) c.to.next[c.side] = want;
      }
      for (const b of bodies) {
        if (b === hand) continue;
        let differs = false;
        for (const side of SIDES) {
          if (Math.abs(b.next[side] - b[side]) > EPS) {
            b[side] = b.next[side];
            differs = true;
          }
        }
        if (differs) {
          place(b);
          settled = false;
        }
      }
      if (meetNew()) settled = false;
    }
    if (!settled) placeAfresh();
    if (!last) keepToPointer();
    let kept = 0;
    for (const c of contacts) {
      if (c.gone || letsGo(c)) {
        // A new contact between the same two may already have taken its place.
        if (linked[c.from.index * n + c.to.index] === c) linked[c.from.index * n + c.to.index] = null;
      } else {
        c.reach = reach(c);
        c.resting = wanted(c) <= EPS;
        contacts[kept] = c;
        kept += 1;
      }
    }
    contacts.length = kept;
    for (const b of bodies) {
      b.changed = b.x !== b.lastX || b.y !== b.lastY;
      b.lastX = b.x;
      b.lastY = b.y;
      b.lastW = b.w;
      b.lastH = b.h;
    }
    return bodies;
  };

  return {
    step: (held) => solve(held, false),
    final: (held) => solve(held, true),
    get untangled() {
      return untangled;
    },
  };
}
