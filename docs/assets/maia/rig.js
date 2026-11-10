// Maia rig. Pure functions, no dependencies, no DOM. Coordinates are reference pixels, the SVG's user space.
// Feed each function the `rig` object from parts-{lg,md,sm}.json for the tier on screen.
//
//   const posed = poseHair(parts.rig.hair, { droop: 0.4, bend: -3 });
//   shapeEl.setAttribute('d', maiaShapeD(parts.rig.hair, posed));
//   const eye = eyePaths(parts.rig.eye, 'l', { shift: 12 });
//   crescentEl.setAttribute('d', eye.crescent);
//   lashesEl.setAttribute('d', eye.lashes);
//
// Keep the fill of maia-shape as it is in the SVG: one gradient in user space. The gradient never moves,
// so the body's colours cannot change and the hair picks up its colour from wherever it is.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (a) => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
const num = (v) => { const s = v.toFixed(2); return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s; };
const pt = (p) => `${num(p[0])} ${num(p[1])}`;
const rad = (d) => (d * Math.PI) / 180;

const ease = (t) => t * t * (3 - 2 * t);
const ramp = (t, w) => ease(Math.min(1, Math.max(0, (t - w[0]) / (w[1] - w[0]))));
const unit01 = (t, w) => Math.min(1, Math.max(0, (t - w[0]) / (w[1] - w[0])));
const rampIn = (t, w) => unit01(t, w) ** 2;
const rampOut = (t, w) => { const x = unit01(t, w); return x * (2 - x); };
const droopDeg = (p, t, j) => p.rotateDeg[j] * ramp(t, p.rotateWindow) + p.uncurlDeg[j] * rampIn(t, p.uncurlWindow) + p.settleDeg[j] * rampOut(t, p.settleWindow);
const liftDeg = (p, t, j) => p.rotateDeg[j] * ramp(t, p.rotateWindow) + p.uncurlDeg[j] * ramp(t, p.uncurlWindow);

// Rest headings and the rest turning that curl scales, one per stretch.
function restTable(strand) {
  const S = strand.spine, base = [], curl = [], L = [];
  let h0 = 0, prev = 0, cum = 0;
  for (let j = 0; j < S.length - 1; j += 1) {
    const v = sub(S[j + 1], S[j]), h = Math.atan2(v[1], v[0]);
    if (j === 0) h0 = h;
    else {
      let turn = h - prev;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      h0 += turn;
      cum += turn * strand.curlWeights[j];
    }
    prev = h; base.push(h0); curl.push(cum); L.push(Math.hypot(v[0], v[1]));
  }
  return { base, curl, L };
}
// One strand's offsets from rest, one per stretch, in radians.
function strandOffsets(strand, pose) {
  const { bend = 0, curl = 1, droop = 0, lift = 0 } = pose;
  const n = strand.spine.length - 1, T = restTable(strand);
  const ca = (curl - 1) * (1 - rampIn(droop, strand.poses.droop.uncurlWindow));
  return T.curl.map((c, j) => ca * c + rad((bend * j) / (n - 1) + droopDeg(strand.poses.droop, droop, j) + liftDeg(strand.poses.lift, lift, j)));
}
function walk(strand, h, x, y) {
  const T = restTable(strand), out = [[x, y]];
  for (let j = 0; j < h.length; j += 1) {
    const a = T.base[j] + h[j];
    x += T.L[j] * Math.cos(a); y += T.L[j] * Math.sin(a);
    out.push([x, y]);
  }
  return out;
}
const pointAt = (S, u) => { const j = Math.min(Math.floor(u), S.length - 2), f = u - j; return add(S[j], mul(sub(S[j + 1], S[j]), f)); };
// How far a strand has turned at a spine point u.
function turnAt(h, u) {
  const n = h.length, T = [h[0]];
  for (let j = 1; j < n; j += 1) T.push((h[j - 1] + h[j]) / 2);
  T.push(h[n - 1]);
  const j = Math.min(Math.floor(u), n - 1), f = u - j;
  return T[j] + (T[j + 1] - T[j]) * f;
}
const rotate = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [c * v[0] - s * v[1], s * v[0] + c * v[1]]; };
function toSpine(p, r, S, W, from, to) {
  let g = 1e9;
  for (let j = from; j < to; j += 1) {
    const d = sub(S[j + 1], S[j]), e = sub(p, S[j]), t = Math.min(1, Math.max(0, dot(e, d) / (dot(d, d) || 1)));
    g = Math.min(g, Math.hypot(e[0] - d[0] * t, e[1] - d[1] * t) - W[j] - (W[j + 1] - W[j]) * t - r);
  }
  return g;
}
// The spines for a pose. Length is kept: only headings change, measured from each strand's root.
//   bend:  degrees of extra heading reached at each tip, growing evenly along the strand.
//   curl:  1 is rest. Above 1 is tighter, below is looser.
//   droop: 0 to 1, hair relaxed down the body's right side. Three moves: the hair swings as a plain rotation of the rest shape, the curl
//          opens until each strand is almost straight, then each strand arcs over and lies against her. No strand bends two ways at once.
//   lift:  0 to 1, hair raised, curl opened.
// All four add, in heading space, so any mix moves smoothly. The inner strand's root rides on the outer strand. If the strands near each other
// the outer strand opens its curl, by hair.parting. Rest and ordinary poses are nowhere near it.
export function poseHair(hair, pose = {}) {
  const limits = hair.parting, O = hair.outer, I = hair.inner, n = O.spine.length - 1;
  const h = strandOffsets(O, pose), HI = strandOffsets(I, pose), at = I.attach, carried = turnAt(h, at);
  const ih = HI.map((v) => v + carried);
  const outer0 = walk(O, h, O.spine[0][0], O.spine[0][1]);
  const off = rotate(sub(I.spine[0], pointAt(O.spine, at)), carried);
  const root = add(pointAt(outer0, at), off);
  const inner = walk(I, ih, root[0], root[1]);
  const a = toSpine(inner[n], 0, outer0, O.halfWidths, 3, n), b = toSpine(inner[n - 2], I.halfWidths[n - 2], outer0, O.halfWidths, 3, n), c = toSpine(outer0[n], 0, inner, I.halfWidths, 3, n);
  const x = limits.startUnits - Math.min(a, b, c);
  let hl = h, outer = outer0;
  if (x > 0) {
    const k = limits.startUnits - limits.floorUnits, d = (x - k * (1 - Math.exp(-x / k))) / limits.leverUnits;
    hl = h.map((v, j) => v + d * O.partWeights[j]);
    outer = walk(O, hl, O.spine[0][0], O.spine[0][1]);
  }
  return { outer, inner, outerTurn: hl, innerTurn: ih };
}

// The d string for maia-shape: her hair's outline, every node carried on its bound spine point and turned with it, then the body's fixed run.
export function maiaShapeD(hair, posed) {
  const c = hair.contour, count = c.segments.length + 1, P = [], Turn = [];
  let rest = c.start;
  for (let i = 0; i < count; i += 1) {
    const [st, u] = c.bind[i];
    if (st < 0) { P.push(rest); Turn.push(0); } else {
      const S0 = st ? hair.inner.spine : hair.outer.spine, S1 = st ? posed.inner : posed.outer, t = turnAt(st ? posed.innerTurn : posed.outerTurn, u);
      P.push(add(pointAt(S1, u), rotate(sub(rest, pointAt(S0, u)), t))); Turn.push(t);
    }
    if (i < count - 1) rest = c.segments[i][2];
  }
  let d = `M${pt(P[0])}`, from = c.start;
  for (let i = 0; i < count - 1; i += 1) {
    const q = c.segments[i], chord = Math.hypot(q[2][0] - from[0], q[2][1] - from[1]), r = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]) / chord;
    d += `C${pt(add(P[i], mul(rotate(sub(q[0], from), Turn[i]), r)))} ${pt(add(P[i + 1], mul(rotate(sub(q[1], q[2]), Turn[i + 1]), r)))} ${pt(P[i + 1])}`;
    from = q[2];
  }
  for (const s of hair.fixed.segments) d += `C${pt(s[0])} ${pt(s[1])} ${pt(s[2])}`;
  return `${d}Z`;
}

const rotAbout = (c, a) => (p) => {
  const s = Math.sin(a);
  const k = Math.cos(a);
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + x * k - y * s, c[1] + x * s + y * k];
};

// One closed eye's d strings. side: 'l' or 'r'. The rig stores the left eye; the right is its mirror.
// This covers her closed eyes and nothing more. Her open eye, with its iris, gaze and moving lashes, is eyeCompute in the engine, and the engine
// gives md a closed lash bunch borrowed from lg (buildLash), which this file does not. Leave open at 0.
//   depth: 1 is rest. Curve depth of the crescent, 0 is flat.
//   dy:    vertical offset, positive down.
//   tilt:  degrees about the eye's pivot, mirrored so a positive value lifts both outer corners.
//   shift: sideways offset in user space. Pass the same value to both eyes, positive moves right on screen.
// The lash fan and the crescent's outer end share one frame, and the fan's root overlaps the end, so they cannot part.
export function eyePaths(eye, side, params = {}) {
  const { open = 0, depth = 1, dy = 0, tilt = 0, shift = 0 } = params;
  const c = eye.crescent;
  const phi0 = rad(eye.endAngleDeg);
  const dphi = Math.asin(Math.min(0.999, Math.max(-0.999, depth * Math.sin(phi0)))) - phi0;
  // The fan turns part of the way with the crescent's end, and draws in a little as she opens.
  const fanTurn = rotAbout(eye.O, dphi * eye.lashFollow + rad(eye.openFanDeg) * open);
  const fanScale = 1 + (eye.openFanScale - 1) * open;
  const fan = (p) => fanTurn(add(eye.O, mul(sub(p, eye.O), fanScale)));
  const turn = rotAbout([0, 0], dphi);
  const rI = rotAbout(eye.I, -dphi);
  const lift = (p, k) => add(p, mul(eye.up, k * open));

  const U = fan(c.U);
  const L = fan(c.L);
  const Iu = rI(c.Iu);
  const Il = rI(c.Il);
  const hU = lift(add(U, turn(sub(c.hU, c.U))), eye.openUpperU);
  const hIu = lift(rI(c.hIu), eye.openUpperI);
  const hL = lift(add(L, turn(sub(c.hL, c.L))), eye.openLowerL);
  const hIl = lift(rI(c.hIl), eye.openLowerI);
  // The inner corner's small cap keeps its join with both edges as they turn.
  const capA = sub(Iu, mul(unit(sub(hIu, Iu)), dist(c.capA, c.Iu)));
  const capB = sub(Il, mul(unit(sub(hIl, Il)), dist(c.capB, c.Il)));
  const capC = fan(c.capC);
  const capD = fan(c.capD);

  const tiltFn = rotAbout(eye.pivot, rad(tilt));
  const place = (p) => {
    const q = tiltFn(p);
    const x = side === 'r' ? 2 * eye.axisX - q[0] : q[0];
    return [x + shift, q[1] + dy];
  };
  const C = (a, b, e) => `C${pt(place(a))} ${pt(place(b))} ${pt(place(e))}`;

  const crescent = `M${pt(place(U))}${C(hU, hIu, Iu)}${C(capA, capB, Il)}${C(hIl, hL, L)}${C(capC, capD, U)}Z`;
  let lashes = `M${pt(place(fan(eye.lashes.start)))}`;
  for (const s of eye.lashes.segments) lashes += C(fan(s[0]), fan(s[1]), fan(s[2]));
  lashes += 'Z';
  return { crescent, lashes };
}
