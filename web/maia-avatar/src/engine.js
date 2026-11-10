// Maia motion engine, draft. One path, one gradient, redrawn each frame; blends mix parameters, never images.
// The render step is fixed at 1/30 s and everything it holds is a preallocated array. The only per-frame
// allocations are the Path2D objects, and those are skipped when nothing moved.
//
// Package copy of version 7's reference engine, docs/assets/maia/engine/src/engine.js (blob 9c774071, approved in
// ma-desk 8c8ae28). It keeps the reference's indentation so `diff` against it shows only the changes, all marked
// "package:": an ES module instead of a script, the data imported from src/art/ (written by scripts/art.mjs from the
// reference's own build), `walk` exported for the drawing between steps, and no parseScore, because the package
// parses with the AI Engineer's score.ts (docs/contracts/maia-score.md). Motion and drawing are untouched.
//
// DANCE: the Product Designer's dance, ported line for line from preview-dance/src/engine.js (dance/engine.diff is its
// diff against version 7). Every line it adds or changes is marked DANCE, as in the draft. Not approved by the owner yet.
// package: the reference's data and vocabulary blocks, as JSON.
import DATA from './art/data.json';
import V from './art/vocab.json';
// package: DANCE, the dance's settings and her one routine with its moves, both written by scripts/dance.mjs from the draft.
import DANCE from './art/dance.json';
import ROUTINE from './art/routine.json';
// package: build.py's line that lends md's hair to sm and lg, and the body's fixed run to every tier.
for (const t of ['sm', 'lg']) { const b = DATA.parts.md.rig.hair; DATA.parts[t].rig.hair = DATA.parts[t].rig.hair || b; DATA.parts[t].rig.hair.fixed = b.fixed; }
// package: DANCE, where the draft's vocab.js has them. Version 7's vocabulary is otherwise as approved: no new beats.
V.dance = { ...DANCE, moves: ROUTINE.moves }; V.routines = { [ROUTINE.name]: ROUTINE.routine };
  const DT = 1 / V.timing.fps;
  const TAU = Math.PI * 2;
  const RAD = Math.PI / 180;
  const { sin, cos, atan2, sqrt, exp, abs } = Math;

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const mix = (a, b, k) => a + (b - a) * k;
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (6 * x - 15) + 10)); // zero slope and curvature at ends
  const hermite = (t) => t * t * (3 - 2 * t);
  const ramp = (t, w) => hermite(clamp((t - w[0]) / (w[1] - w[0]), 0, 1));
  // Uncurl speeds up into its end and settle slows down from its start, so a strand passes through straight at speed and never pauses there.
  const rampIn = (t, w) => { const x = clamp((t - w[0]) / (w[1] - w[0]), 0, 1); return x * x; };
  const rampOut = (t, w) => { const x = clamp((t - w[0]) / (w[1] - w[0]), 0, 1); return x * (2 - x); };
  // Attack, hold, release envelope; 0 at both ends with zero slope.
  const envelope = (u, a, h) => (u < a ? smooth(u / a) : u < a + h ? 1 : smooth(1 - (u - a - h) / (1 - a - h)));

  // Slots in the eleven posture values.
  const SAG = 0, BEND = 1, CURL = 2, OPEN = 3, DEPTH = 4, DY = 5, TILT = 6, SQUINT = 7, BX = 8, BY = 9, ROT = 10;
  const NP = 11;
  const poseArray = (hair, eyes, body) => Float64Array.of(hair.sag, hair.bend, hair.curl, eyes.open, eyes.depth === undefined ? 1 : eyes.depth, eyes.dy, eyes.tilt, eyes.squint || 0, body.x, body.y, body.rot);
  const STAGE = V.stage;

  // ---------------------------------------------------------------- the lash bunch as point lists
  // Closed and open hold the same points in the same order, so opening moves each point and nothing swaps, fades or pops.
  // Both lists end the same way whatever the number of lashes: outer lash tip, outer corner, root on the lid, first point.
  // Closed, the corner and root points sit together at the bunch's base.
  function buildLash(rig) {
    const eye = rig.eye, spec = V.eyes[rig.tier].lash;
    const from = spec.bunch ? DATA.parts[spec.bunch].rig.eye : eye, k = spec.bunchK || 1;
    const sk = (p) => [p[0] * k, p[1] * k], s0 = spec.bunch ? V.eyes[spec.bunch].lash.stand : spec.stand;
    const st = { tip: sk(s0.tip), first: s0.first.map(sk), last: s0.last.map(sk) };
    const shape = (p) => [eye.O[0] + (p[0] - from.O[0]) * k, eye.O[1] + (p[1] - from.O[1]) * k];
    const openSegs = from.lashes.segments.map((seg) => seg.map(shape));
    // A borrowed bunch is borrowed closed too: its lashes laid on this eye's crescent end, ending on this crescent's own outer edge.
    let rest = eye.lashes;
    if (spec.bunch) {
      // Along the crescent's end it stretches to fit, so tip and base land exactly on this crescent. Outward, closedK sets how far the lashes reach.
      const U0 = from.crescent.U, L0 = from.crescent.L, U1 = eye.crescent.U, L1 = eye.crescent.L, ck = spec.closedK || k;
      const ax0 = L0[0] - U0[0], ay0 = L0[1] - U0[1], al0 = Math.hypot(ax0, ay0), ax1 = L1[0] - U1[0], ay1 = L1[1] - U1[1], al1 = Math.hypot(ax1, ay1);
      const lay = (p) => {
        const x = p[0] - U0[0], y = p[1] - U0[1], al = ((x * ax0 + y * ay0) / al0) * (al1 / al0), ou = ((x * -ay0 + y * ax0) / al0) * ck;
        return [U1[0] + (al * ax1 - ou * ay1) / al1, U1[1] + (al * ay1 + ou * ax1) / al1];
      };
      const segs = from.lashes.segments.map((seg) => seg.map(lay)), own = eye.lashes.segments;
      segs[segs.length - 2][2] = L1.slice();
      segs[segs.length - 1] = own[own.length - 1].map((p) => p.slice());
      rest = { start: U1.slice(), segments: segs };
    }
    const flat = (start, segs) => { const out = [start[0], start[1]]; for (const seg of segs) out.push(seg[0][0], seg[0][1], seg[1][0], seg[1][1], seg[2][0], seg[2][1]); return out; };
    // The root point goes in just before the closing edge, as a zero-length stretch.
    const withRoot = (list) => { const i = list.length - 6, x = list[i - 2], y = list[i - 1]; list.splice(i, 0, x, y, x, y, x, y); return list; };
    const closed = withRoot(flat(rest.start, rest.segments)), opened = withRoot(flat(shape(from.lashes.start), openSegs));
    const a = -spec.deg * RAD, c = cos(a), n = sin(a);
    const put = (i, p) => { opened[2 * i] = eye.O[0] + p[0] * c - p[1] * n; opened[2 * i + 1] = eye.O[1] + p[0] * n + p[1] * c; };
    const last = opened.length / 2 - 1;
    put(0, st.tip); put(1, st.first[0]); put(2, st.first[1]);
    put(last - 2, st.last[0]); put(last - 1, st.last[1]); put(last, st.tip);
    eye.restLashes = rest;
    eye.lashRest = Float64Array.from(flat(rest.start, rest.segments));
    eye.lashClosed = Float64Array.from(closed);
    eye.lashOpen = Float64Array.from(opened);
    eye.lashN = (closed.length / 2 - 1) / 3;
  }

  // ---------------------------------------------------------------- rig tables, one per tier
  // One strand's tables. Its spine is a chain of stretches; poses and motion turn the stretches, never change their lengths.
  function strandTables(d) {
    const S = d.spine, n = S.length - 1, deg = (a) => Float64Array.from(a, (x) => x * RAD), P = d.poses;
    const out = {
      n, x0: S[0][0], y0: S[0][1], L: new Float64Array(n), base: new Float64Array(n), curlTurn: new Float64Array(n), hw: Float64Array.from(d.halfWidths), rest: S,
      dR: deg(P.droop.rotateDeg), dU: deg(P.droop.uncurlDeg), dS: deg(P.droop.settleDeg), lR: deg(P.lift.rotateDeg), lU: deg(P.lift.uncurlDeg),
      dRW: P.droop.rotateWindow, dUW: P.droop.uncurlWindow, dSW: P.droop.settleWindow, lRW: P.lift.rotateWindow, lUW: P.lift.uncurlWindow,
    };
    let base = 0, prev = 0, cum = 0;
    for (let j = 0; j < n; j += 1) {
      const vx = S[j + 1][0] - S[j][0], vy = S[j + 1][1] - S[j][1], h = atan2(vy, vx);
      if (j === 0) base = h;
      else {
        let turn = h - prev;
        turn = atan2(sin(turn), cos(turn));
        base += turn;
        cum += turn * d.curlWeights[j];
      }
      prev = h;
      out.base[j] = base;
      out.curlTurn[j] = cum;
      out.L[j] = Math.hypot(vx, vy);
    }
    return out;
  }
  // The outline of her hair at rest, cut into nodes. Each node is bound to a point on a spine, as strand (0 outer, 1 inner, -1 fixed) and
  // stretch plus fraction. It rides on that point and turns with it, and so do its handles. At rest that is the drawing, to the digit.
  function outlineTables(c, outer, inner) {
    const m = c.segments.length, count = m + 1, K = {
      count, strand: new Int8Array(count), j: new Int32Array(count), f: new Float64Array(count), ox: new Float64Array(count), oy: new Float64Array(count),
      ax: new Float64Array(m), ay: new Float64Array(m), bx: new Float64Array(m), by: new Float64Array(m), chord: new Float64Array(m),
    };
    let px = c.start[0], py = c.start[1];
    for (let i = 0; i < count; i += 1) {
      const st = c.bind[i][0], u = c.bind[i][1];
      K.strand[i] = st;
      if (st < 0) { K.ox[i] = px; K.oy[i] = py; } else {
        const S = st ? inner : outer, j = Math.min(Math.floor(u), S.length - 2), f = u - j;
        K.j[i] = j; K.f[i] = f;
        K.ox[i] = px - (S[j][0] + (S[j + 1][0] - S[j][0]) * f); K.oy[i] = py - (S[j][1] + (S[j + 1][1] - S[j][1]) * f);
      }
      if (i < m) {
        const q = c.segments[i];
        K.ax[i] = q[0][0] - px; K.ay[i] = q[0][1] - py; K.bx[i] = q[1][0] - q[2][0]; K.by[i] = q[1][1] - q[2][1];
        K.chord[i] = Math.hypot(q[2][0] - px, q[2][1] - py);
        px = q[2][0]; py = q[2][1];
      }
    }
    return K;
  }
  function buildRig(parts) {
    const hair = parts.rig.hair, O = strandTables(hair.outer), In = strandTables(hair.inner);
    const rig = Object.assign(O, {
      tier: parts.tier, params: parts.params, eye: parts.rig.eye, center: parts.circle.center, inner: In, look: V.eyes[parts.tier],
      K: outlineTables(hair.contour, hair.outer.spine, hair.inner.spine), fixed: Float64Array.from(hair.fixed.segments.flat(2)),
      parting: hair.parting, part: Float64Array.from(hair.outer.partWeights), yieldO: Float64Array.from(hair.outer.yieldWeights), yieldI: Float64Array.from(hair.inner.yieldWeights), attachJ: Math.floor(hair.inner.attach), attachF: hair.inner.attach - Math.floor(hair.inner.attach), follow: hair.inner.follow,
    });
    const aj = rig.attachJ, af = rig.attachF, os = hair.outer.spine;
    rig.attachX = os[aj][0] + (os[aj + 1][0] - os[aj][0]) * af; rig.attachY = os[aj][1] + (os[aj + 1][1] - os[aj][1]) * af;
    rig.rootOX = In.x0 - rig.attachX; rig.rootOY = In.y0 - rig.attachY;
    buildLash(rig);
    return rig;
  }
  const RIGS = { sm: buildRig(DATA.parts.sm), md: buildRig(DATA.parts.md), lg: buildRig(DATA.parts.lg) };
  // The drawing tier follows her size on screen, which is the bubble times the stage scale.
  const tierFor = (px) => { const e = px * STAGE.scale; return e < 40 ? 'sm' : e < 96 ? 'md' : 'lg'; };
  // Thin lashes and the hair tip twinkle when small paths are rasterised one to one, because the browser
  // samples small paths at quarter-pixel rows. Below 128 device px the backing store doubles and CSS scales it down.
  const backingScale = (px, dpr) => (px * dpr < 128 ? dpr * 2 : dpr);

  // ---------------------------------------------------------------- hair geometry, the same math as rig.js in flat arrays
  // Heading offsets from rest, one per spine stretch, for one strand. Only the droop's swing and settle turn stretch 0.
  // The droop's three moves never overlap in a way that bends a strand two ways at once: rotate is a plain rotation of the rest shape,
  // uncurl opens the curl until the strand is almost straight, and settle starts only where uncurl has ended.
  function hairTargets(rig, sag, bend, curl, H) {
    const droop = sag > 0 ? sag : 0, lift = sag < 0 ? -sag : 0;
    const du = rampIn(droop, rig.dUW), dr = ramp(droop, rig.dRW), ds = rampOut(droop, rig.dSW), lr = ramp(lift, rig.lRW), lu = ramp(lift, rig.lUW);
    const ca = (curl - 1) * (1 - du), b = (bend * RAD) / (rig.n - 1);
    for (let j = 0; j < rig.n; j += 1) {
      H[j] = ca * rig.curlTurn[j] + b * j + rig.dR[j] * dr + rig.dU[j] * du + rig.dS[j] * ds + rig.lR[j] * lr + rig.lU[j] * lu;
    }
  }
  function walk(rig, h, sp, x, y) {
    sp[0] = x; sp[1] = y;
    for (let j = 0; j < rig.n; j += 1) {
      const a = rig.base[j] + h[j];
      x += rig.L[j] * cos(a);
      y += rig.L[j] * sin(a);
      sp[2 * j + 2] = x; sp[2 * j + 3] = y;
    }
  }
  function spineFrom(rig, h, sp) { walk(rig, h, sp, rig.x0, rig.y0); }
  // How far a strand has turned at each of its spine points, from its stretches' offsets.
  function turnsAt(h, n, T) {
    T[0] = h[0];
    for (let j = 1; j < n; j += 1) T[j] = (h[j - 1] + h[j]) / 2;
    T[n] = h[n - 1];
  }
  // How far the outer strand has turned where the inner strand is carried.
  function carried(rig, h) {
    const j = rig.attachJ, f = rig.attachF, a = j === 0 ? h[0] : (h[j - 1] + h[j]) / 2;
    return a + ((h[j] + h[j + 1]) / 2 - a) * f;
  }
  // The inner strand's root rides on the outer strand, so the two are one lock that parts at the crotch.
  function innerFrom(rig, h, ih, sp, ip) {
    const j = rig.attachJ, f = rig.attachF, a = carried(rig, h), c = cos(a), s = sin(a);
    const x = sp[2 * j] + (sp[2 * j + 2] - sp[2 * j]) * f + c * rig.rootOX - s * rig.rootOY;
    const y = sp[2 * j + 1] + (sp[2 * j + 3] - sp[2 * j + 1]) * f + s * rig.rootOX + c * rig.rootOY;
    walk(rig.inner, ih, ip, x, y);
  }

  // How close the strands are: from the inner strand's tip and last knuckle to the outer strand's edge, and from the outer tip to the inner
  // strand's edge. Spine points with their half widths, so it costs a few square roots.
  function toSpine(px, py, r, S, W, from, to) {
    let g = 1e9;
    for (let j = from; j < to; j += 1) {
      const ax = S[2 * j], ay = S[2 * j + 1], dx = S[2 * j + 2] - ax, dy = S[2 * j + 3] - ay, ex = px - ax, ey = py - ay, l = dx * dx + dy * dy;
      let t = (ex * dx + ey * dy) / (l || 1); t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ex - dx * t, qy = ey - dy * t, d = sqrt(qx * qx + qy * qy) - W[j] - (W[j + 1] - W[j]) * t - r;
      if (d < g) g = d;
    }
    return g;
  }
  function strandGap(rig, sp, ip) {
    const n = rig.n, In = rig.inner, a = toSpine(ip[2 * n], ip[2 * n + 1], 0, sp, rig.hw, 3, n), b = toSpine(ip[2 * n - 4], ip[2 * n - 3], In.hw[n - 2], sp, rig.hw, 3, n), c = toSpine(sp[2 * n], sp[2 * n + 1], 0, ip, In.hw, 3, n);
    return a < b ? (a < c ? a : c) : (b < c ? b : c);
  }
  // The parting. The strands must never touch, whatever a score asks for, so as they near each other the outer strand opens its curl, just enough.
  // Rest and ordinary motion are nowhere near it. It is a smooth function of the pose, so it cannot jump.
  function partOuter(rig, sp, ip, h, hl) {
    const PART = rig.parting, g = strandGap(rig, sp, ip), x = PART.startUnits - g;
    if (x <= 0) { hl.set(h); return; }
    const a = PART.startUnits - PART.floorUnits, d = (x - a * (1 - exp(-x / a))) / PART.leverUnits;
    for (let j = 0; j < h.length; j += 1) hl[j] = h[j] + d * rig.part[j];
    spineFrom(rig, hl, sp);
  }

  const NMAX = 16;
  const TO = new Float64Array(NMAX), TI = new Float64Array(NMAX);
  const OMAX = 64;
  const NX = new Float64Array(OMAX), NY = new Float64Array(OMAX), NC = new Float64Array(OMAX), NS = new Float64Array(OMAX), HC = new Float64Array(6 * OMAX);
  // The outline, in the frame the spines now give it. Every node keeps one turn for both its handles, so a smooth join stays smooth,
  // and the handles scale with their chord, so a stretch of outline bends rather than bulges.
  function bodyEdges(rig, sp, ip, h, ih) {
    const K = rig.K, count = K.count, st = K.strand, J = K.j, F = K.f, OX = K.ox, OY = K.oy;
    turnsAt(h, rig.n, TO); turnsAt(ih, rig.inner.n, TI);
    for (let i = 0; i < count; i += 1) {
      const q = st[i];
      if (q < 0) { NX[i] = OX[i]; NY[i] = OY[i]; NC[i] = 1; NS[i] = 0; continue; }
      const j = J[i], f = F[i], S = q ? ip : sp, T = q ? TI : TO, a = T[j] + (T[j + 1] - T[j]) * f, c = cos(a), s = sin(a), o = 2 * j;
      NC[i] = c; NS[i] = s;
      NX[i] = S[o] + (S[o + 2] - S[o]) * f + c * OX[i] - s * OY[i];
      NY[i] = S[o + 1] + (S[o + 3] - S[o + 1]) * f + s * OX[i] + c * OY[i];
    }
    const AX = K.ax, AY = K.ay, BX = K.bx, BY = K.by, CH = K.chord;
    for (let i = 0; i < count - 1; i += 1) {
      const x0 = NX[i], y0 = NY[i], x1 = NX[i + 1], y1 = NY[i + 1], dx = x1 - x0, dy = y1 - y0, r = sqrt(dx * dx + dy * dy) / CH[i], o = 6 * i;
      HC[o] = x0 + r * (NC[i] * AX[i] - NS[i] * AY[i]); HC[o + 1] = y0 + r * (NS[i] * AX[i] + NC[i] * AY[i]);
      HC[o + 2] = x1 + r * (NC[i + 1] * BX[i] - NS[i + 1] * BY[i]); HC[o + 3] = y1 + r * (NS[i + 1] * BX[i] + NC[i + 1] * BY[i]);
      HC[o + 4] = x1; HC[o + 5] = y1;
    }
  }
  // Writes to any target with moveTo, bezierCurveTo and closePath, so the same code feeds Path2D and the checks.
  function traceBody(rig, p) {
    const m = 6 * (rig.K.count - 1), F = rig.fixed;
    p.moveTo(NX[0], NY[0]);
    for (let i = 0; i < m; i += 6) p.bezierCurveTo(HC[i], HC[i + 1], HC[i + 2], HC[i + 3], HC[i + 4], HC[i + 5]);
    for (let i = 0; i < F.length; i += 6) p.bezierCurveTo(F[i], F[i + 1], F[i + 2], F[i + 3], F[i + 4], F[i + 5]);
    p.closePath();
  }

  // ---------------------------------------------------------------- eye geometry
  // At open 0 this is the reference's crescent and lashes, exactly. Opening raises the upper edge into a soft round top.
  const EPN = 76; // 12 crescent points, the lash start, up to 7 lash segments, and 3 points for the lid line's start
  const LID = 68;
  const SWEEP_MAX = 40 * RAD;
  const EP = new Float64Array(EPN);
  let lashSegs = 4, lashC = 1, lashS = 0, lashK = 1, lashOX = 0, lashOY = 0;
  let fc = 0, fs = 0, fk = 1, ox = 0, oy = 0, ic = 0, is = 0, ix = 0, iy = 0;
  function putFan(i, p) {
    const dx = (p[0] - ox) * fk, dy = (p[1] - oy) * fk;
    EP[2 * i] = ox + dx * fc - dy * fs; EP[2 * i + 1] = oy + dx * fs + dy * fc;
  }
  function putLash(i, px, py) {
    const dx = (px - lashOX) * lashK, dy = (py - lashOY) * lashK;
    EP[2 * i] = ox + dx * lashC - dy * lashS; EP[2 * i + 1] = oy + dx * lashS + dy * lashC;
  }
  function putInner(i, p) {
    const dx = p[0] - ix, dy = p[1] - iy;
    EP[2 * i] = ix + dx * ic - dy * is; EP[2 * i + 1] = iy + dx * is + dy * ic;
  }
  function eyeCompute(E, look, open, depth, squint) {
    const c = E.crescent, phi0 = E.endAngleDeg * RAD;
    const dphi = Math.asin(clamp(depth * sin(phi0), -0.999, 0.999)) - phi0;
    const op = Math.min(open, 1);
    const fa = dphi * E.lashFollow + look.fanDeg * RAD * op;
    fc = cos(fa); fs = sin(fa); fk = 1 + (look.fanScale - 1) * op; ox = E.O[0]; oy = E.O[1];
    const tc = cos(dphi), ts = sin(dphi);
    ic = tc; is = -ts; ix = E.I[0]; iy = E.I[1];
    const ux = E.up[0], uy = E.up[1], low = op * (1 + 0) , sq = squint * look.squint * op;
    putFan(0, c.U); putInner(3, c.Iu); putInner(6, c.Il); putFan(9, c.L); putFan(10, c.capC); putFan(11, c.capD);
    // The upper edge: closed, the crescent's own handles. Open, handles rising straight up from each end, which makes a round top.
    let dx = c.hU[0] - c.U[0], dy = c.hU[1] - c.U[1];
    const hx = EP[0] + dx * tc - dy * ts, hy = EP[1] + dx * ts + dy * tc;
    EP[2] = mix(hx, EP[0] - look.out, op); EP[3] = hy + (EP[1] - look.top - hy) * open;
    putInner(2, c.hIu);
    EP[4] = mix(EP[4], EP[6] + look.out, op); EP[5] += (EP[7] - look.top - EP[5]) * open;
    dx = c.hL[0] - c.L[0]; dy = c.hL[1] - c.L[1];
    const lowL = look.lowerL * low + sq, lowI = look.lowerI * low + sq;
    EP[16] = EP[18] + dx * tc - dy * ts + ux * lowL; EP[17] = EP[19] + dx * ts + dy * tc + uy * lowL;
    putInner(7, c.hIl); EP[14] += ux * lowI; EP[15] += uy * lowI;
    // The inner corner's small cap keeps its join with both edges as they turn.
    let ax = EP[4] - EP[6], ay = EP[5] - EP[7], al = sqrt(ax * ax + ay * ay) || 1;
    let cd = Math.hypot(c.capA[0] - c.Iu[0], c.capA[1] - c.Iu[1]);
    EP[8] = EP[6] - (ax / al) * cd; EP[9] = EP[7] - (ay / al) * cd;
    ax = EP[14] - EP[12]; ay = EP[15] - EP[13]; al = sqrt(ax * ax + ay * ay) || 1;
    cd = Math.hypot(c.capB[0] - c.Il[0], c.capB[1] - c.Il[1]);
    EP[10] = EP[12] - (ax / al) * cd; EP[11] = EP[13] - (ay / al) * cd;
    // The crescent's blunt inner end closes to a point as she opens, so nothing is left hanging below the raised lower lid.
    const ki = smooth(open / look.innerClose);
    if (ki > 0) {
      EP[14] += (EP[6] - EP[12]) * ki * look.innerLid;
      EP[12] += (EP[6] - EP[12]) * ki; EP[13] += (EP[7] - EP[13]) * ki;
      EP[8] += (EP[6] - EP[8]) * ki; EP[9] += (EP[7] - EP[9]) * ki;
      EP[10] += (EP[12] - EP[10]) * ki; EP[11] += (EP[13] - EP[11]) * ki;
    }
    // The lash bunch is the reference's own shape. Closed, it sits at the crescent's outer end, exactly as drawn.
    // Opening slides that same bunch along the upper lid and turns it to reach up, so nothing swaps or fades.
    const m = look.lash, s2 = smooth(open / m.by), t = m.t * s2, u = 1 - t;
    const lx = u * u * u * EP[0] + 3 * u * u * t * EP[2] + 3 * u * t * t * EP[4] + t * t * t * EP[6], ly = u * u * u * EP[1] + 3 * u * u * t * EP[3] + 3 * u * t * t * EP[5] + t * t * t * EP[7];
    // Where the bunch's base is: on the lid when open, at the crescent's end when closed.
    // The bunch turns with the lid's direction at the corner, so at any openness the outer lash stays in line with the eye's outer edge.
    const lidUp = atan2(EP[3] - EP[1], EP[2] - EP[0]) + Math.PI / 2;
    const a0 = dphi * E.lashFollow + (m.deg * RAD + lidUp) * s2, lk = 1 + (m.scale - 1) * s2;
    ox = lx + (E.O[0] - EP[0]) * (1 - s2) + m.inset * 0.6 * s2;
    oy = ly + (E.O[1] - EP[1]) * (1 - s2) + m.inset * s2;
    lashC = cos(a0); lashS = sin(a0); lashK = lk; lashOX = E.O[0]; lashOY = E.O[1];
    if (open <= 0) { // Closed: this size's closed drawing, without the extra root point.
      const LR = E.lashRest;
      lashSegs = (LR.length / 2 - 1) / 3;
      for (let i = 0; i < LR.length; i += 2) putLash(12 + i / 2, LR[i], LR[i + 1]);
      return;
    }
    // Same bunch throughout, except the lash at its inner end: it moves point by point from where it is drawn closed to standing up.
    const LC = E.lashClosed, LO = E.lashOpen;
    lashSegs = E.lashN;
    for (let i = 0; i < LC.length; i += 2) putLash(12 + i / 2, LC[i] + (LO[i] - LC[i]) * s2, LC[i + 1] + (LO[i + 1] - LC[i + 1]) * s2);
    // The join. Whatever the number of lashes, one edge runs from the outer corner along the lid's own direction and on to the outer lash's tip, as one arc,
    // and the bunch's inner side follows the lid from the corner to its root. So the line starts hair-thin at the corner and widens into the outer lash.
    const iT = 2 * (12 + 3 * (E.lashN - 3)), iC = iT + 6, iR = iC + 6;
    const tr = m.root * s2;
    const ax1 = EP[0] + (EP[2] - EP[0]) * tr, ay1 = EP[1] + (EP[3] - EP[1]) * tr;
    const bx1 = EP[2] + (EP[4] - EP[2]) * tr, by1 = EP[3] + (EP[5] - EP[3]) * tr;
    const cx1 = EP[4] + (EP[6] - EP[4]) * tr, cy1 = EP[5] + (EP[7] - EP[5]) * tr;
    const abx = ax1 + (bx1 - ax1) * tr, aby = ay1 + (by1 - ay1) * tr, bcx = bx1 + (cx1 - bx1) * tr, bcy = by1 + (cy1 - by1) * tr;
    const rx = abx + (bcx - abx) * tr, ry = aby + (bcy - aby) * tr;
    EP[LID] = rx; EP[LID + 1] = ry; EP[LID + 2] = bcx; EP[LID + 3] = bcy; EP[LID + 4] = cx1; EP[LID + 5] = cy1;
    const sx = EP[iC] + (EP[0] - EP[iC]) * s2, sy = EP[iC + 1] + (EP[1] - EP[iC + 1]) * s2;
    const tx = EP[iT], ty = EP[iT + 1];
    // Sweep: an arc from the corner to the tip. It leaves along the lid's tangent; the end tangent mirrors it about the chord.
    let dx0 = EP[2] - EP[0], dy0 = EP[3] - EP[1], dl = sqrt(dx0 * dx0 + dy0 * dy0) || 1; dx0 /= dl; dy0 /= dl;
    const chx0 = tx - sx, chy0 = ty - sy, chl = sqrt(chx0 * chx0 + chy0 * chy0) || 1e-6, chx = chx0 / chl, chy = chy0 / chl;
    // Nearly closed, the lid still runs inward and the arc would loop. Then it leaves at no more than a set angle from the straight line to the tip.
    const off = atan2(chx * dy0 - chy * dx0, chx * dx0 + chy * dy0);
    if (abs(off) > SWEEP_MAX) { const a = off > 0 ? SWEEP_MAX : -SWEEP_MAX, ca = cos(a), sa = sin(a); dx0 = chx * ca - chy * sa; dy0 = chx * sa + chy * ca; }
    const dd = 2 * (dx0 * chx + dy0 * chy), ex = chx * dd - dx0, ey = chy * dd - dy0;
    const th = atan2(dx0 * ey - dy0 * ex, dx0 * ex + dy0 * ey), q = cos(th / 4), hk = chl / (3 * q * q);
    EP[iT + 2] += (tx - ex * hk - EP[iT + 2]) * s2; EP[iT + 3] += (ty - ey * hk - EP[iT + 3]) * s2;
    EP[iT + 4] += (sx + dx0 * hk - EP[iT + 4]) * s2; EP[iT + 5] += (sy + dy0 * hk - EP[iT + 5]) * s2;
    EP[iC] = sx; EP[iC + 1] = sy;
    // Inner side: the lid, corner to root, held just under the eye's edge so no skin shows between them.
    let nx = bcx - abx, ny = bcy - aby, nl = sqrt(nx * nx + ny * ny) || 1; nx /= nl; ny /= nl;
    const un = m.under;
    EP[iC + 2] += (ax1 - dy0 * un - EP[iC + 2]) * s2; EP[iC + 3] += (ay1 + dx0 * un - EP[iC + 3]) * s2;
    EP[iC + 4] += (abx - ny * un - EP[iC + 4]) * s2; EP[iC + 5] += (aby + nx * un - EP[iC + 5]) * s2;
    EP[iR] += (rx - ny * un - EP[iR]) * s2; EP[iR + 1] += (ry + nx * un - EP[iR + 1]) * s2;
  }
  const PL = new Float64Array(EPN);
  let pk = 1, pc = 1, ps = 0, ppx = 0, ppy = 0, pax = 0, pmir = false, pdy = 0, pshift = 0;
  // Open eyes are a little larger than the crescent and sit a little further apart.
  function placeSetup(E, look, mirror, open, tilt, dy, shift) {
    const op = hermite(clamp(open, 0, 1)), ta = (tilt + look.lift * op) * RAD;
    pk = 1 + look.grow * op; pc = cos(ta); ps = sin(ta); ppx = E.pivot[0]; ppy = E.pivot[1]; pax = 2 * E.axisX; pmir = mirror;
    pdy = dy; pshift = shift + (mirror ? 1 : -1) * look.spread * op;
  }
  let qx = 0, qy = 0;
  function place(x0, y0) {
    const x = (x0 - ppx) * pk, y = (y0 - ppy) * pk, xr = ppx + x * pc - y * ps;
    qx = (pmir ? pax - xr : xr) + pshift;
    qy = ppy + x * ps + y * pc + pdy;
  }
  function eyePlace(count) {
    for (let i = 0; i < count; i += 2) { place(EP[i], EP[i + 1]); PL[i] = qx; PL[i + 1] = qy; }
  }
  function traceCrescent(p) {
    p.moveTo(PL[0], PL[1]);
    p.bezierCurveTo(PL[2], PL[3], PL[4], PL[5], PL[6], PL[7]);
    p.bezierCurveTo(PL[8], PL[9], PL[10], PL[11], PL[12], PL[13]);
    p.bezierCurveTo(PL[14], PL[15], PL[16], PL[17], PL[18], PL[19]);
    p.bezierCurveTo(PL[20], PL[21], PL[22], PL[23], PL[0], PL[1]);
    p.closePath();
  }
  // The lid line starts at the bunch's root, so the outer edge has the same tapered line in every theme.
  function traceLid(p) {
    place(EP[LID], EP[LID + 1]); p.moveTo(qx, qy);
    place(EP[LID + 2], EP[LID + 3]); const a = qx, b = qy;
    place(EP[LID + 4], EP[LID + 5]); const c = qx, d = qy;
    p.bezierCurveTo(a, b, c, d, PL[6], PL[7]);
  }
  function traceLashes(p) {
    p.moveTo(PL[24], PL[25]);
    for (let i = 26, e = 26 + 6 * lashSegs; i < e; i += 6) p.bezierCurveTo(PL[i], PL[i + 1], PL[i + 2], PL[i + 3], PL[i + 4], PL[i + 5]);
    p.closePath();
  }

  // ---------------------------------------------------------------- DANCE: moves and routines, data from vocab.js
  // A move is a few beats of keyframes over her channels. A routine places moves on a beat grid, and moves layer by adding.
  // Every move starts and ends at zero, so nothing pops when one starts or stops. All of this is compiled once, so a step allocates nothing.
  const CHN = V.dance.channels, NCH = CHN.length, CHI = Object.fromEntries(CHN.map((n, i) => [n, i]));
  const C_X = CHI.x, C_Y = CHI.y, C_ROT = CHI.rot, C_SQ = CHI.sq, C_SPIN = CHI.spin, C_YAW = CHI.yaw, C_SAG = CHI.sag, C_BEND = CHI.bend, C_CURL = CHI.curl, C_LAG = CHI.lag, C_TIP = CHI.tip;
  const C_SHUT = CHI.shut, C_OPEN = CHI.open, C_SQUINT = CHI.squint, C_TILT = CHI.tilt, C_DY = CHI.dy, C_GX = CHI.gx, C_GY = CHI.gy, C_WINK = CHI.wink;
  const FLIPS = Int8Array.from(CHN, (n) => (V.dance.flips.includes(n) ? 1 : 0));
  const EASES = { io: 0, out: 1, in: 2, lin: 3 };
  const easeAt = (e, u) => (e === 0 ? u * u * (3 - 2 * u) : e === 1 ? u * (2 - u) : e === 2 ? u * u : u);
  function compileMove(def) {
    const tracks = [];
    for (const name of CHN) {
      const keys = def[name];
      if (!keys) continue;
      const pts = keys.map((k) => [k[0], k[1], EASES[k[2] || 'io']]);
      if (pts[0][0] > 0) pts.unshift([0, 0, 0]);
      if (pts[pts.length - 1][0] < def.len) pts.push([def.len, 0, 0]);
      tracks.push({ ch: CHI[name], flip: FLIPS[CHI[name]], whole: name === 'spin' || name === 'yaw' || name === 'wink', n: pts.length, t: Float64Array.from(pts, (p) => p[0]), v: Float64Array.from(pts, (p) => p[1]), e: Uint8Array.from(pts, (p) => p[2]) });
    }
    return { len: def.len, tracks };
  }
  const MOVES = new Map(Object.entries(V.dance.moves).map(([k, d]) => [k, compileMove(d)]));
  const BEAT_MOVES = new Map(Object.entries(V.beats).filter(([, d]) => d.move).map(([k, d]) => [k, MOVES.get(d.move)]));
  // Adds one move at b beats from its start.
  function addMove(m, b, g, f, RV) {
    const T = m.tracks;
    for (let i = 0; i < T.length; i += 1) {
      const tr = T[i], t = tr.t, n = tr.n;
      let j = 1;
      while (j < n - 1 && t[j] < b) j += 1;
      const u = clamp((b - t[j - 1]) / (t[j] - t[j - 1] || 1), 0, 1), a = tr.v[j - 1];
      const val = a + (tr.v[j] - a) * easeAt(tr.e[j], u);
      RV[tr.ch] += tr.whole ? val : tr.flip ? val * g * f : val * g;
    }
  }
  function compileRoutine(def) {
    const steps = [], cues = [];
    for (const s of def.steps) {
      const [at, name, g = 1, f = 1, times = 1, alt = 0] = s;
      if (BEATS_EYES.has(name)) { cues.push({ at, name, level: g }); continue; }
      const m = MOVES.get(name);
      // Repeats follow each other. With alt, every second repeat is mirrored at that gain.
      for (let i = 0; i < times; i += 1) steps.push({ at: at + i * m.len, end: at + (i + 1) * m.len, m, g: i % 2 && alt ? alt : g, f: i % 2 && alt ? -f : f });
    }
    cues.sort((a, b) => a.at - b.at);
    return { bps: def.bpm / 60, lead: def.lead === undefined ? V.dance.leadS : def.lead, seconds: (def.beats * 60) / def.bpm, pose: poseArray(def.pose.hair, def.pose.eyes, def.pose.body), steps, cues };
  }
  const BEATS_EYES = new Set(Object.keys(V.beats).filter((k) => V.beats[k].track === 'eyes'));
  const ROUTINES = new Map(Object.entries(V.routines).map(([k, d]) => [k, compileRoutine(d)]));

  // ---------------------------------------------------------------- the score: untrusted data only
  const MOODS = new Map(Object.entries(V.moods));
  const RHYTHMS = new Map(Object.entries(V.rhythms));
  const BEATS = new Map(Object.entries(V.beats));
  const R = V.rules;

  // package: no parseScore here. Scores come in through score.ts's makeParser, and compileScore takes its result.

  // Small seeded generator, so a score always gets the same added blinks.
  function hashScore(p) {
    let h = 2166136261;
    const s = `${p.mood}|${p.rhythm}|${p.seconds}|${p.beats.map((b) => b.do + b.t + b.level).join()}`;
    for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  const nextRand = (x) => (Math.imul(x, 1664525) + 1013904223) >>> 0;

  // Turns a parsed score into the timeline the engine plays: whole cycles, two tracks, added blinks.
  function compileScore(parsed) {
    const p = parsed || { mood: R.defaultMood, rhythm: R.defaultRhythm, seconds: 24, beats: [], notes: [] };
    const cycle = V.rhythms[p.rhythm].cycle;
    let k = Math.round(p.seconds / cycle);
    while (k * cycle > R.seconds[1]) k -= 1;
    while (k * cycle < R.seconds[0]) k += 1;
    const seconds = k * cycle;
    const out = { mood: p.mood, rhythm: p.rhythm, askedSeconds: p.seconds, seconds, cycles: k, hair: [], eyes: [], body: [], notes: p.notes.slice(), seed: hashScore(p) };
    if (p.routine) out.routine = p.routine; // DANCE
    const sorted = p.beats.slice().sort((a, b) => a.t - b.t);
    const end = { hair: -Infinity, eyes: -Infinity, body: -Infinity };
    let kept = 0;
    for (const b of sorted) {
      const def = V.beats[b.do], dur = def.dur[b.level - 1], label = `${b.do} at ${b.t} s`;
      if (b.t + dur > seconds - R.endMarginS) { out.notes.push(`${label} dropped, too close to the end of the loop`); continue; }
      if (b.t < end[def.track] + R.gapS) { out.notes.push(`${label} dropped, collides on the ${def.track} track`); continue; }
      if (kept >= R.capBeats) { out.notes.push(`${label} dropped, over the cap of ${R.capBeats}`); continue; }
      end[def.track] = b.t + dur;
      kept += 1;
      out[def.track].push({ t: b.t, do: b.do, level: b.level, dur, auto: false });
    }
    // Fill any long gap on the eye track with the engine's own blinks.
    let seed = out.seed, cursor = 0;
    const next = [];
    const blinkDur = V.beats.blink.dur[0];
    const fill = (from, to) => {
      let at = from;
      while (to - at > R.blinkGapMaxS) {
        seed = nextRand(seed);
        at += mix(R.blinkEveryS[0], R.blinkEveryS[1], seed / 4294967296);
        next.push({ t: Math.round(at * 10) / 10, do: 'blink', level: 1, dur: blinkDur, auto: true });
        at += blinkDur;
      }
    };
    for (const b of out.eyes) { fill(cursor, b.t); next.push(b); cursor = b.t + b.dur; }
    fill(cursor, seconds - R.endMarginS);
    out.eyes = next;
    out.kept = kept;
    // Where she looks: somewhere new every few seconds, chosen from the mood, the same every time for the same score.
    const look = V.moods[p.mood].look, G = V.eyes.gaze;
    const gaze = [];
    let g = seed, at2 = 0, spot = 0;
    while (at2 < seconds - 0.5) {
      g = nextRand(g);
      const pick = g / 4294967296;
      let x = 0, y = 0;
      const list = G[look.spots];
      spot = look.spots === 'around' ? (spot + 1 + Math.floor(pick * (list.length - 1))) % list.length : (spot + 1) % list.length;
      x = list[spot][0] + (pick - 0.5) * 0.14; y = list[spot][1] + (pick - 0.5) * 0.1;
      gaze.push({ t: at2, x, y });
      g = nextRand(g);
      at2 += mix(look.every[0], look.every[1], g / 4294967296);
    }
    out.gaze = gaze;
    return out;
  }

  // ---------------------------------------------------------------- the avatar
  const HN = 10; // spine stretches in every tier
  // Exact transition over one fixed step for a damped spring, so the integrator cannot go unstable.
  function springCoef(w, z) {
    const zz = Math.min(z, 0.9995), wd = w * sqrt(1 - zz * zz), e = exp(-zz * w * DT), c = cos(wd * DT), s = sin(wd * DT);
    return [e * (c + ((zz * w) / wd) * s), (e * s) / wd, -(e * w * w * s) / wd, e * (c - ((zz * w) / wd) * s)];
  }
  const HAIR_COEF = (() => {
    const a = new Float64Array(4 * HN);
    for (let j = 0; j < HN; j += 1) a.set(springCoef(V.timing.hairOmega[j], V.timing.hairDamping[j]), 4 * j);
    return a;
  })();
  const ST = V.states, TM = V.timing;
  const TH = ST.thinking, SP = ST.speaking, ZZ = ST.sleeping, WK = ST.waking, UN = ST.unavailable;
  const SLEEP_POSE = poseArray(ZZ.hair, ZZ.eyes, ZZ.body);
  const UNAVAILABLE_POSE = poseArray(UN.hair, UN.eyes, UN.body);
  const THINK_POSE = poseArray(TH.hair, TH.eyes, TH.body);
  const SPEAK_POSE = poseArray(SP.hair, SP.eyes, SP.body);
  const REST_POSE = poseArray(V.moods.calm.hair, V.moods.calm.eyes, V.moods.calm.body);
  const moodPose = Object.fromEntries(Object.entries(V.moods).map(([k, m]) => [k, poseArray(m.hair, m.eyes, m.body)]));
  const CALM = compileScore(null);
  const BODY_COEF = springCoef(TM.bodyOmega, 1);
  const DANCE_COEF = springCoef(V.dance.bodyOmega, 1); // DANCE
  const WINK_K = 1 - exp(-DT * TM.eyeOmega * 0.7); // DANCE
  const GAZE_COEF = springCoef(TM.gazeOmega, 1);
  const SC = STAGE.scale, CX = STAGE.center[0], CY = STAGE.center[1], PX = STAGE.pivot[0], PY = STAGE.pivot[1];
  // A hop: a small crouch, the air, a small give on landing. Used for her beats and for bright's bounce.
  function hopCurve(u) {
    if (u < 0.22) { const s = sin((Math.PI * u) / 0.22); return -0.2 * s * s; }
    if (u < 0.8) return sin((Math.PI * (u - 0.22)) / 0.58);
    const s = sin((Math.PI * (u - 0.8)) / 0.2);
    return -0.14 * s * s;
  }

  let wOver = 0, wUX = 0, wUY = 0, wJ = 0, wS = null;
  class Avatar {
    constructor(canvas, opts) {
      this.canvas = canvas || null;
      this.size = opts.size;
      this.dpr = opts.dpr || 1;
      this.rig = RIGS[opts.tier || tierFor(opts.size)];
      this.tier = this.rig.tier;
      this.reduced = !!opts.reduced;
      this.textSide = opts.textSide === -1 ? -1 : 1;
      this.t = 0;
      this.frames = 0;
      this.state = 'score';
      this.P = new Float64Array(NP); this.PV = new Float64Array(NP); this.PT = new Float64Array(NP); this.PS = new Float64Array(NP);
      this.E = Float64Array.of(0.8, 1, 0, 0, 0); this.EV = new Float64Array(5); this.ET = new Float64Array(5); this.ED = Float64Array.of(-9, 9, 9, 9, 9, 9, 9);
      this.gx = 0; this.gy = 0; this.gvx = 0; this.gvy = 0; this.gtx = 0; this.gty = 0.2;
      this.tx = 0; this.ty = 0; this.rot = 0; this.tvx = 0; this.tvy = 0; this.rv = 0; this.pvy = 0; this.sq = 0;
      this.m = new Float64Array(6);
      this.H = new Float64Array(HN); this.h = new Float64Array(HN); this.hv = new Float64Array(HN); this.hd = new Float64Array(HN).fill(9);
      this.sp = new Float64Array(2 * (HN + 1));
      this.ih = new Float64Array(HN); this.ip = new Float64Array(2 * (HN + 1)); this.Hp = new Float64Array(HN); this.HI = new Float64Array(HN); this.pih = new Float64Array(HN); this.hl = new Float64Array(HN); this.il = new Float64Array(HN); this.ihd = new Float64Array(HN).fill(9);
      this.bodyPath = null; this.domes = null; this.lashes = null; this.irises = null; this.pupils = null; this.glints = null; this.lids = null;
      this.chainK = TM.hairCoupling;
      this.gR = 1; this.gT = 0; this.gS = 0; this.gZ = 0; this.gB = 1;
      // Smoothed rhythm and mood movement, so a change of either never pops.
      this.R = new Float64Array(14);
      this.phR = 0; this.phW = 0; this.np1 = 0; this.np2 = 0; this.phB = 0; this.phS = 0;
      this.rate = 0; this.rateSmooth = 0;
      this.hb = null; this.hbT = 0; this.hbL = 0; this.hbK = 1; this.hbD = 1;
      this.eb = null; this.ebT = 0; this.ebL = 0; this.ebD = 1;
      this.bb = null; this.bbT = 0; this.bbL = 0; this.bbD = 1;
      this.beatScale = 1; this.stepLimit = 0; this.streaming = false; this.pTipX = NaN; this.pTrack = new Float64Array(8); this.pNow = new Float64Array(8);
      this.ph = new Float64Array(HN); this.pBody = new Float64Array(4);
      this.rand = (opts.seed === undefined ? 12345 : opts.seed) >>> 0;
      this.nextBlink = 3; this.nextLook = 0; this.lookSpot = 0;
      this.timer = 0; this.sleepClock = 0;
      this.dormant = false; this.quiet = 0;
      // DANCE: what the channels ask for this step, the routine playing, and the transforms that aren't in her resting rig.
      this.RV = new Float64Array(NCH); this.rOn = false; this.ro = null; this.rPend = null; this.rT = 0; this.rE = 0; this.rFading = false; this.rFade = 1;
      this.spinA = 0; this.spinV = 0; this.yawA = 0; this.wk = 0; this.wkD = 0; this.domesB = null; this.lidsB = null; this.lidWB = 0;
      this.noNoise = !!opts.noNoise;
      this.setPostureOmega(TM.postureOmega.score);
      this.eyeCoef = springCoef(this.reduced ? ST.reducedMotion.fadeOmega : TM.eyeOmega, 1);
      this.gainK = 1 - exp(-DT / TM.gainTauS);
      this.rhythmK = 1 - exp(-DT / TM.rhythmTauS);
      this.rateK = 1 - exp(-DT / SP.rateSmoothS);
      this.sqK = 1 - exp(-DT / TM.squashTauS);
      this.ctx = canvas ? canvas.getContext('2d') : null;
      this.scale = 1;
      if (canvas) this.setCanvasSize(opts.size, this.dpr, opts.backing);
      this.theme = 'light';
      if (opts.theme) this.setTheme(opts.theme);
      this.playCompiled(CALM);
      this.loadRhythmNow();
      this.snap();
    }

    // ---- inputs
    setCanvasSize(px, dpr, backing) {
      const w = Math.round(px * (backing || backingScale(px, dpr)));
      this.canvas.width = w; this.canvas.height = w;
      this.scale = w / 720;
    }
    setTheme(name) {
      this.theme = name;
      this.colors = DATA.themes[name].tiers[this.tier];
      this.eyeColor = this.colors.eye;
      this.look = V.eyes.colors[name];
      this.lashColor = this.look.lash;
      this.openMax = 1.3;
      if (this.ctx) this.grad = this.makeGradient(this.ctx);
      this.ED[0] = -9; this.hd[0] = 9;
      this.wakeLoop();
    }
    makeGradient(ctx) {
      const g = DATA.gradient, c = this.colors, lg = ctx.createLinearGradient(g.x1, g.y1, g.x2, g.y2);
      lg.addColorStop(0, c.light);
      lg.addColorStop(1, c.dark);
      return lg;
    }
    wakeLoop() { this.dormant = false; this.quiet = 0; }
    setPostureOmega(w) { this.pc = springCoef(w, 1); }
    setRate(cps) { this.rate = clamp(cps, 0, SP.ratePerS[1] * 1.5); }
    // While a desk stream plays: 15 fps, the same size of movement, a cap on each frame's step, longer beats.
    setStreamMode(on) {
      const m = V.modes.stream;
      this.streaming = !!on;
      this.beatScale = on ? m.beatStretch : 1;
      this.stepLimit = on ? ((m.maxStepPxAt56 / (56 / 720)) * m.fps * DT) : 0;
      this.pTipX = NaN;
      if (on && (this.ro || this.rPend)) { this.rPend = null; this.stopRoutine(); this.fireEye('smile', 2); } // DANCE: no dance during a stream, a smile instead
    }
    setReduced(on) {
      this.reduced = !!on;
      this.eyeCoef = springCoef(this.reduced ? ST.reducedMotion.fadeOmega : TM.eyeOmega, 1);
      if (this.reduced && (this.ro || this.rPend)) { // DANCE: no dance with reduced motion, a smile instead
        this.rPend = null; this.ro = null; this.rOn = false; this.RV.fill(0); this.spinA = 0; this.spinV = 0; this.yawA = 0; this.wk = 0;
        if (this.state === 'routine') this.leaveRoutine();
        this.fireEye('smile', 2);
      }
      this.wakeLoop();
    }
    random() { this.rand = nextRand(this.rand); return this.rand / 4294967296; }

    // package: playScore lives in avatar.ts, which parses with score.ts and then calls playCompiled.
    playCompiled(c) {
      this.score = c;
      this.scoreT = -DT;
      this.nh = 0; this.ne = 0; this.nb = 0; this.ng = 0; this.loop = 0;
      this.rand = c.seed;
      this.np1 = this.random() * TAU; this.np2 = this.random() * TAU;
      this.moodName = c.mood; this.rhythmName = c.rhythm;
      if (this.state === 'falling' || this.state === 'sleeping') this.toWaking();
      else if (this.state !== 'waking') this.toState('score');
      // DANCE: a score's routine starts on the next score step, so a sleeping Maia wakes first. Reduced motion and a stream get a smile.
      if (this.ro) this.stopRoutine();
      this.rPend = null;
      if (c.routine) { if (this.reduced || this.streaming) this.fireEye('smile', 2); else this.rPend = c.routine; }
      this.wakeLoop();
    }
    setMood(name) { if (MOODS.has(name)) { this.moodName = name; this.wakeLoop(); } }
    setRhythm(name) { if (RHYTHMS.has(name)) { this.rhythmName = name; this.wakeLoop(); } }
    // Plays one beat now, on its own track, ahead of whatever the score has scheduled.
    beat(name, level) {
      if (!BEATS.has(name)) return;
      const lv = clamp(Math.round(level || 1), 1, 3), track = V.beats[name].track;
      if (this.reduced) { if (name === 'smile' || name === 'soften') this.fireEye(name, lv); } else if (track === 'hair') this.fireHair(name, lv);
      else if (track === 'body') this.fireBody(name, lv);
      else this.fireEye(name, lv);
      this.wakeLoop();
    }
    fireHair(name, lv) {
      this.hb = name; this.hbL = lv; this.hbT = 0; this.hbD = V.beats[name].dur[lv - 1] * this.beatScale;
      this.hbK = 1 + (this.random() - 0.5) * 0.12;
    }
    fireEye(name, lv) { this.eb = name; this.ebL = lv; this.ebT = 0; this.ebD = V.beats[name].dur[lv - 1]; }
    fireBody(name, lv) { this.bb = name; this.bbL = lv; this.bbT = 0; this.bbD = V.beats[name].dur[lv - 1] * this.beatScale; if (BEAT_MOVES.has(name)) this.rOn = true; } // DANCE: rOn

    // ---- DANCE: routines
    startRoutine(name) {
      this.ro = ROUTINES.get(name); this.rT = -DT; this.rE = 0; this.rFading = false; this.rFade = 1; this.rOn = true;
      this.state = 'routine'; this.timer = 0; this.hb = null; this.bb = null; this.eb = null;
      const G = V.eyes.gaze.person; this.gtx = G[0]; this.gty = G[1];
      this.setPostureOmega(TM.postureOmega.score);
    }
    leaveRoutine() { this.toState('score'); this.scoreT = -DT; this.nh = 0; this.ne = 0; this.nb = 0; this.ng = 0; }
    // Cut short: the pose it had reached fades out, a turn by the short way, then her score carries on.
    stopRoutine() { if (this.ro && !this.rFading) { this.rFading = true; this.rFade = 1; if (this.state === 'routine') { const r = this.ro; this.ro = null; this.leaveRoutine(); this.ro = r; } } }
    // Fills the channels for this step. Values add, so a beat can play over anything.
    stepChannels() {
      const RV = this.RV, ro = this.ro;
      RV.fill(0);
      let on = false;
      if (ro !== null) {
        on = true;
        if (!this.rFading) this.rT += DT;
        const b = (this.rT + ro.lead) * ro.bps, S = ro.steps;
        for (let i = 0; i < S.length; i += 1) { const q = S[i]; if (b >= q.at && b < q.end) addMove(q.m, b - q.at, q.g, q.f, RV); }
        if (this.rFading) {
          this.rFade -= DT / V.dance.fadeS;
          const k = smooth(this.rFade);
          RV[C_SPIN] = atan2(sin(RV[C_SPIN] * RAD), cos(RV[C_SPIN] * RAD)) / RAD;
          RV[C_YAW] = atan2(sin(RV[C_YAW] * RAD), cos(RV[C_YAW] * RAD)) / RAD;
          for (let i = 0; i < NCH; i += 1) RV[i] *= k;
          if (this.rFade <= 0) { this.ro = null; on = false; }
        } else {
          const C = ro.cues;
          while (this.rE < C.length && C[this.rE].at <= b) { const q = C[this.rE]; this.fireEye(q.name, q.level); this.rE += 1; }
          if (this.rT >= ro.seconds) { this.ro = null; RV.fill(0); if (this.state === 'routine') this.leaveRoutine(); }
        }
      }
      if (this.bb !== null) {
        const mv = BEAT_MOVES.get(this.bb);
        if (mv) { on = true; addMove(mv, (this.bbT / this.bbD) * mv.len, V.beats[this.bb].gain[this.bbL - 1], 1, RV); }
      }
      // During a stream no turn plays: a turn's frames would step past the cap. The rest of a beat plays under the cap like any beat.
      // A routine cut short by a stream starting fades its turn out instead, so nothing pops.
      if (this.streaming && !this.rFading) { RV[C_SPIN] = 0; RV[C_YAW] = 0; }
      this.spinV = (RV[C_SPIN] - this.spinA) / DT; this.spinA = RV[C_SPIN]; this.yawA = RV[C_YAW];
      if (!on) { this.rOn = false; this.spinA = 0; this.spinV = 0; this.yawA = 0; RV.fill(0); }
    }

    // ---- states
    setState(name) {
      if (name === 'calm') this.playCompiled(CALM);
      else if (name === 'sleeping') this.fallAsleep();
      else if (name === 'waking') this.wake();
      else this.toState(name);
      this.wakeLoop();
    }
    toState(name) {
      if (this.ro) this.stopRoutine(); // DANCE
      this.state = name;
      this.timer = 0;
      if (name === 'thinking' || name === 'speaking') { this.nextBlink = this.t + mix(1.5, 3, this.random()); this.nextLook = this.t; }
      const O = TM.postureOmega;
      this.setPostureOmega(O[name] || O.score);
    }
    fallAsleep() {
      if (this.state === 'falling' || this.state === 'sleeping') return;
      if (this.ro) this.stopRoutine(); // DANCE
      this.state = 'falling';
      this.timer = 0;
      this.PS.set(this.P);
      this.setPostureOmega(TM.postureOmega.timed);
      this.wakeLoop();
    }
    wake() { if (this.state === 'falling' || this.state === 'sleeping') this.toWaking(); this.wakeLoop(); }
    toWaking() {
      if (this.ro) this.stopRoutine(); // DANCE
      this.state = 'waking';
      this.timer = 0;
      this.PS.set(this.P);
      this.setPostureOmega(TM.postureOmega.timed);
    }

    // ---- one fixed step of 1/30 s
    step() {
      this.t += DT;
      this.frames += 1;
      this.postureTarget();
      const P = this.P, PV = this.PV, PT = this.PT, c = this.pc;
      for (let i = 0; i < NP; i += 1) {
        const x = P[i] - PT[i], v = PV[i];
        P[i] = PT[i] + c[0] * x + c[1] * v;
        PV[i] = c[2] * x + c[3] * v;
      }
      if (this.state === 'score') this.tickScore();
      if (this.rOn) this.stepChannels(); // DANCE
      this.updateGains();
      const limited = this.stepLimit > 0 && !this.reduced;
      if (limited) { this.ph.set(this.h); this.pih.set(this.ih); this.pBody[0] = this.tx; this.pBody[1] = this.ty; this.pBody[2] = this.rot; this.pBody[3] = this.sq; }
      if (this.reduced) { this.h.fill(0); this.hv.fill(0); this.ih.fill(0); this.hb = null; this.bb = null; this.tx = this.ty = this.rot = this.sq = 0; this.rOn = false; this.spinA = 0; this.yawA = 0; } else { this.stepBody(); this.stepHair(); } // DANCE: rOn, spinA, yawA
      this.stepEyes();
      this.layHair();
      this.placeBody();
      if (limited) this.limitStep();
      this.checkQuiet();
    }
    layHair() { spineFrom(this.rig, this.h, this.sp); innerFrom(this.rig, this.h, this.ih, this.sp, this.ip); partOuter(this.rig, this.sp, this.ip, this.h, this.hl); this.il.set(this.ih); }
    postureTarget() {
      const PT = this.PT, s = this.state;
      if (s === 'score') { PT.set(moodPose[this.moodName]); return; }
      if (s === 'routine') { PT.set(this.ro.pose); return; } // DANCE
      if (s === 'thinking') { PT.set(THINK_POSE); return; }
      if (s === 'speaking') { PT.set(SPEAK_POSE); return; }
      if (s === 'unavailable') { PT.set(UNAVAILABLE_POSE); return; }
      if (s === 'sleeping') { PT.set(SLEEP_POSE); this.sleepClock += DT; return; }
      this.timer += DT;
      const PS = this.PS;
      if (s === 'falling') {
        const eyes = smooth(this.timer / ZZ.eyesEndS), hair = hermite(clamp((this.timer - ZZ.hairStartS) / (ZZ.hairEndS - ZZ.hairStartS), 0, 1));
        for (let i = 0; i < NP; i += 1) PT[i] = mix(PS[i], SLEEP_POSE[i], i < 3 || i >= BX ? hair : eyes);
        if (this.timer >= ZZ.fallS) { this.state = 'sleeping'; this.sleepClock = 0; }
      } else if (s === 'waking') {
        const dest = moodPose[this.moodName];
        const eyes = smooth(this.timer / WK.eyesEndS), hair = hermite(clamp(this.timer / WK.durS, 0, 1));
        for (let i = 0; i < NP; i += 1) PT[i] = mix(PS[i], dest[i], i < 3 || i >= BX ? hair : eyes);
        // A lifted mood's lift comes after she has woken, at the score's slower pace.
        PT[SAG] = mix(PS[SAG], Math.max(dest[SAG], WK.sagFloor), hair);
        if (this.timer >= WK.durS) { this.toState('score'); this.scoreT = -DT; this.nh = 0; this.ne = 0; this.nb = 0; this.ng = 0; }
      }
    }
    tickScore() {
      if (this.rPend !== null && this.ro === null) { const name = this.rPend; this.rPend = null; this.startRoutine(name); return; } // DANCE
      const S = this.score;
      let T = this.scoreT + DT;
      if (T >= S.seconds) {
        T -= S.seconds;
        this.nh = 0; this.ne = 0; this.nb = 0; this.ng = 0; this.loop += 1;
        // Noise is windowed to zero at the loop point, so each pass can differ without a jump.
        this.np1 = this.random() * TAU; this.np2 = this.random() * TAU;
      }
      this.scoreT = T;
      while (this.nh < S.hair.length && S.hair[this.nh].t <= T) { const b = S.hair[this.nh]; if (!this.reduced) this.fireHair(b.do, b.level); this.nh += 1; }
      while (this.nb < S.body.length && S.body[this.nb].t <= T) { const b = S.body[this.nb]; if (!this.reduced) this.fireBody(b.do, b.level); this.nb += 1; }
      while (this.ne < S.eyes.length && S.eyes[this.ne].t <= T) {
        const b = S.eyes[this.ne];
        if (!this.reduced || b.do === 'smile' || b.do === 'soften') this.fireEye(b.do, b.level);
        this.ne += 1;
      }
      if (!this.reduced) while (this.ng < S.gaze.length && S.gaze[this.ng].t <= T) { const g = S.gaze[this.ng]; this.gtx = g.x * this.textSide; this.gty = g.y; this.ng += 1; }
    }
    loadRhythmNow() { this.fillRhythm(1); }
    fillRhythm(q) {
      const r = V.rhythms[this.rhythmName], m = V.moods[this.moodName].move, R = this.R;
      const T = [r.x * m.sway, r.y * m.bob, r.rot * m.rock, r.bend * m.hair, r.curl * m.hair, r.ripple * m.hair, r.wander, r.noise, m.bounce];
      for (let i = 0; i < T.length; i += 1) R[i] += (T[i] - R[i]) * q;
    }
    updateGains() {
      const s = this.state, k = this.gainK;
      this.gR += ((s === 'score' ? 1 : 0) - this.gR) * k;
      this.gT += ((s === 'thinking' ? 1 : 0) - this.gT) * k;
      this.gS += ((s === 'speaking' ? 1 : 0) - this.gS) * k;
      this.gZ += ((s === 'sleeping' || s === 'falling' ? 1 : 0) - this.gZ) * k;
      this.gB += ((s === 'score' || s === 'thinking' || s === 'speaking' || s === 'routine' ? 1 : 0) - this.gB) * k; // DANCE: routine
      this.fillRhythm(this.rhythmK);
      const r = V.rhythms[this.rhythmName], S = this.score, loop = S.rhythm === this.rhythmName ? S.seconds : r.cycle * S.cycles;
      const mv = V.moods[this.moodName].move;
      this.yHarm = mv.yHarm;
      this.bounceN = mv.bounce ? Math.max(1, Math.round(r.cycle / mv.bouncePeriod)) : 0;
      this.phR = (this.phR + (DT * TAU) / r.cycle) % TAU;
      this.phW = (this.phW + (DT * TAU * (S.cycles + 1)) / loop) % TAU;
      this.rateSmooth += (this.rate - this.rateSmooth) * this.rateK;
    }

    // Body: where she swims to. A spring follows the target, and her speed and acceleration feed the squash and the hair.
    stepBody() {
      const P = this.P, R = this.R, gR = this.gR, gT = this.gT, gS = this.gS, t = this.t;
      let X = P[BX], Y = P[BY], A = P[ROT];
      const ph = this.phR, yh = this.yHarm || 2;
      X += gR * R[0] * sin(ph);
      Y += gR * R[1] * sin(yh * ph + 0.9);
      A += gR * R[2] * sin(ph + 1.1);
      if (gR > 0.001 && R[8] > 0.5 && this.bounceN) {
        const u = ((this.bounceN * ph) / TAU) % 1;
        Y -= gR * R[8] * hopCurve(u);
      }
      if (gT > 0.001) {
        X += gT * TH.driftX * sin((TAU * t) / TH.driftXPeriod);
        Y += gT * TH.driftY * sin((TAU * t) / TH.driftYPeriod);
        A += gT * TH.rock * sin((TAU * t) / TH.rockPeriod);
      }
      if (gS > 0.001) {
        const k = clamp(this.rateSmooth / SP.ratePerS[1], 0, 1);
        Y += gS * mix(SP.bobPx[0], SP.bobPx[1], k) * sin((TAU * t) / SP.bobPeriod);
        X += gS * SP.swayX * sin((TAU * t) / SP.swayPeriod);
        A += gS * SP.rock * sin((TAU * t) / SP.swayPeriod + 1);
      }
      if (this.gZ > 0.001 && this.state === 'sleeping') {
        const b = (1 - cos((TAU * this.sleepClock) / ZZ.cycle)) / 2;
        Y -= this.gZ * ZZ.breathY * b;
      }
      // She turns a little toward where she is looking.
      X += TM.gazeLean * this.gx * this.gB;
      A += TM.gazeRock * this.gx * this.gB;
      if (this.bb !== null) {
        this.bbT += DT;
        const u = this.bbT / this.bbD, L = this.bbL - 1, d = V.beats[this.bb], g = this.gB;
        if (u >= 1) this.bb = null;
        else if (this.bb === 'hop') {
          const n = d.hops[L], v = (u * n) % 1;
          Y -= g * d.height[L] * hopCurve(v);
        } else if (this.bb === 'bob') {
          const s = sin(Math.PI * d.times[L] * u);
          Y += g * d.depth[L] * s * s;
        } else if (this.bb === 'lean') {
          const pull = u < 0.14 ? sin((Math.PI * u) / 0.14) * -0.14 : 0;
          const v = g * (envelope(u, 0.25, 0.4) + pull);
          X += this.textSide * d.x[L] * v; A += this.textSide * d.rot[L] * v;
        }
      }
      if (this.hb === 'nod') {
        const u = this.hbT / this.hbD, L = this.hbL - 1, d = V.beats.nod;
        if (u < 1) { const s = sin(Math.PI * d.dips[L] * u), v = s * s * this.gB; Y += d.body[L] * v; A += d.rot[L] * v; }
      }
      if (this.rOn) { X += this.RV[C_X]; Y += this.RV[C_Y]; A += this.RV[C_ROT]; } // DANCE
      const c = this.rOn ? DANCE_COEF : BODY_COEF; // DANCE: rOn
      let x = this.tx - X, v = this.tvx;
      this.tx = X + c[0] * x + c[1] * v; this.tvx = c[2] * x + c[3] * v;
      x = this.ty - Y; v = this.tvy;
      this.ty = Y + c[0] * x + c[1] * v; const nvy = c[2] * x + c[3] * v;
      const ay = (nvy - this.tvy) / DT;
      this.tvy = nvy;
      x = this.rot - A; v = this.rv;
      this.rot = A + c[0] * x + c[1] * v; this.rv = c[2] * x + c[3] * v;
      // Stretch with speed, squash when pushing off the floor of the move.
      const want = this.gZ > 0.5 ? -0.03 + ZZ.breathSquash * (this.state === 'sleeping' ? (1 - cos((TAU * this.sleepClock) / ZZ.cycle)) / 2 : 0) : clamp(TM.stretchSpeed * abs(nvy) + TM.squashAccel * ay, -TM.squashMax, TM.squashMax);
      this.sq += ((this.rOn ? clamp(want * V.dance.autoSquash + this.RV[C_SQ], -V.dance.squashMax, V.dance.squashMax) : want) - this.sq) * this.sqK; // DANCE: rOn
    }

    // Hair: posture, then rhythm and beats, into heading targets, then the spring chain that makes the tip lag the root.
    stepHair() {
      const P = this.P, H = this.H, h = this.h, hv = this.hv, rig = this.rig, n = rig.n, R = this.R;
      let sag = P[SAG], bend = P[BEND], curl = P[CURL];
      const gR = this.gR, sr = sin(this.phR);
      bend += gR * (R[3] * sr + R[6] * sin(this.phW));
      curl += gR * R[4] * sin(this.phR - 0.7);
      if (gR > 0.001 && !this.noNoise && this.state === 'score') {
        const S = this.score, u = clamp(this.scoreT / S.seconds, 0, 1), w = sin(Math.PI * u), wn = w * w * R[7] * gR;
        bend += wn * (sin((TAU * 3 * u) + this.np1) + 0.6 * sin((TAU * 5 * u) + this.np2));
      }
      const gT = this.gT, t = this.t;
      if (gT > 0.001) {
        curl += gT * TH.windCurl * sin((TAU * t) / TH.windPeriod);
      }
      const gZ = this.gZ;
      if (gZ > 0.001 && this.state === 'sleeping') {
        const b = (1 - cos((TAU * this.sleepClock) / ZZ.cycle)) / 2;
        sag -= gZ * ZZ.breathSag * b;
        bend += gZ * ZZ.breathBend * b;
      }
      let tipKick = 0, waveU = -1, waveDeg = 0;
      if (this.hb !== null) {
        this.hbT += DT;
        const u = this.hbT / this.hbD, L = this.hbL - 1, d = V.beats[this.hb], g = this.gB * this.hbK;
        if (u >= 1) this.hb = null;
        else if (this.hb === 'lift') {
          const v = envelope(u, 0.35, 0.15) * d.amount[L] * g;
          sag += (-1 - sag) * v;
          curl -= 0.05 * v; bend -= 1.2 * v;
        } else if (this.hb === 'nod') {
          const s = sin(Math.PI * d.dips[L] * u), v = s * s * g;
          sag += d.amount[L] * v;
        } else if (this.hb === 'flick') {
          tipKick = (u < 0.3 ? smooth(u / 0.3) : smooth(1 - (u - 0.3) / 0.7)) * d.tipDeg[L] * RAD * g;
        } else if (this.hb === 'wave') {
          waveU = u; waveDeg = d.deg[L] * g;
        } else if (this.hb === 'curl') {
          const v = envelope(u, 0.3, 0.35) * g;
          curl += d.amount[L] * v;
          bend -= 2.5 * d.amount[L] * v;
        }
      }
      if (this.rOn) { sag += this.RV[C_SAG]; bend += this.RV[C_BEND]; curl += this.RV[C_CURL]; } // DANCE
      const PH = rig.params.hair;
      const cSag = clamp(sag, -1, 1), cBend = clamp(bend, PH.bend.min * 1.6, PH.bend.max * 1.6), cCurl = clamp(curl, PH.curl.min * 0.9, PH.curl.max * 1.06);
      hairTargets(rig, cSag, cBend, cCurl, H);
      this.Hp.set(H); hairTargets(rig.inner, cSag, cBend, cCurl, this.HI);
      // Travelling ripples, added straight to the headings, plus the drag of her own movement.
      const m = n - 1, rip = R[5] * gR * RAD, phR = this.phR, gS = this.gS;
      let ampS = 0, phS = 0, ampT = 0, phT = 0;
      if (gS > 0.001) {
        const k = clamp(this.rateSmooth / SP.ratePerS[1], 0, 1);
        ampS = gS * mix(SP.rippleDeg[0], SP.rippleDeg[1], k) * RAD;
        phS = (TAU * t) / SP.ripplePeriod;
      }
      if (gT > 0.001) { ampT = gT * TH.swirlDeg * RAD; phT = (TAU * t) / TH.swirlPeriod; }
      const dragV = clamp(-(this.tvy * TM.dragPerUnit) - this.tvx * TM.dragPerUnit * 0.5, -TM.dragMax, TM.dragMax) * this.gB;
      for (let j = 1; j < n; j += 1) {
        const x = j / m, w = 0.3 + 0.7 * x;
        H[j] += rip * w * sin(phR - TAU * 0.8 * x);
        H[j] += dragV * x * x;
        if (ampS) H[j] += ampS * w * sin(phS - TAU * 0.9 * x);
        if (ampT) H[j] += ampT * w * sin(phT - TAU * 0.75 * x);
        if (tipKick) H[j] += tipKick * x * x * x;
        if (waveU >= 0) {
          const lag = V.beats.wave.lag, du = waveU * (1 + lag) - lag * x;
          if (du > 0 && du < 1) {
            const s = sin(Math.PI * du);
            H[j] += waveDeg * RAD * w * s * s * sin(TAU * V.beats.wave.cycles * du);
          }
        }
      }
      // DANCE: lag is a plain arc added along the strand, tip a kick at the tips. A turn drags the hair behind it: clockwise winds it tighter, counterclockwise only a little.
      if (this.rOn) {
        const RV = this.RV, rv = this.rv + this.spinV, D = V.dance;
        const lag = (RV[C_LAG] - clamp(rv * (rv > 0 ? D.spinDrag : D.spinDragBack), -D.spinDragMax, D.spinDragMax)) * RAD, tip = RV[C_TIP] * RAD;
        for (let j = 1; j < n; j += 1) { const x = j / m; H[j] += lag * x + tip * x * x * x; }
      }
      // The chain: each stretch chases its target plus what the stretch before it has not reached yet.
      const timed = this.state === 'falling' || this.state === 'waking';
      this.chainK += ((timed ? TM.timedCoupling : TM.hairCoupling) - this.chainK) * this.gainK;
      const K = this.chainK, C = HAIR_COEF, vmax = V.limits.headingSpeedRadS;
      let lagPrev = 0;
      for (let j = 0; j < n; j += 1) {
        const tgt = H[j] + K * lagPrev, x = h[j] - tgt, v = hv[j], o = 4 * j;
        const nv = C[o + 2] * x + C[o + 3] * v, was = h[j], lim = vmax * DT;
        const nh = tgt + C[o] * x + C[o + 1] * v;
        // The speed cap holds whatever the targets do, so nothing a score says can make her snap.
        h[j] = nh > was + lim ? was + lim : nh < was - lim ? was - lim : nh;
        hv[j] = nv > vmax ? vmax : nv < -vmax ? -vmax : nv;
        lagPrev = h[j] - H[j];
      }
      this.innerFromChain();
    }
    // The inner strand has no chain of its own. It takes its pose from its own tables and everything else, every ripple, kick and lag,
    // from the outer strand at the same fraction of its length, a touch behind. So one wave passes through both.
    innerFromChain() {
      const h = this.h, Hp = this.Hp, HI = this.HI, ih = this.ih, rig = this.rig, a = carried(rig, h), fo = rig.follow;
      let prev = 0;
      for (let j = 0; j < HN; j += 1) {
        const res = h[j] - Hp[j];
        ih[j] = a + HI[j] + res * (1 - fo) + prev * fo;
        prev = res;
      }
    }

    stepEyes() {
      const P = this.P, ET = this.ET, E = this.E, EV = this.EV, t = this.t, s = this.state;
      let open = P[OPEN], depth = P[DEPTH], dy = P[DY], tilt = P[TILT], squint = P[SQUINT];
      if (!this.reduced) {
        if (s === 'thinking') {
          this.gtx = TH.lookX * sin((TAU * t) / TH.lookXPeriod);
          this.gty = TH.lookY + TH.lookYAmp * sin((TAU * t) / TH.lookYPeriod);
        } else if (s === 'speaking' && t >= this.nextLook) {
          this.nextLook = t + mix(SP.lookEvery[0], SP.lookEvery[1], this.random());
          this.lookSpot = 1 - this.lookSpot;
          const G = V.eyes.gaze[this.lookSpot ? 'text' : 'person'];
          this.gtx = G[0] * this.textSide; this.gty = G[1];
        } else if (s === 'falling' || s === 'sleeping') { this.gtx = 0; this.gty = 0.5; } else if (s === 'unavailable') { this.gtx = UN.look[0]; this.gty = UN.look[1]; }
        if ((s === 'thinking' || s === 'speaking') && t >= this.nextBlink) {
          const every = s === 'thinking' ? TH.blinkEvery : SP.blinkEvery;
          this.nextBlink = t + mix(every[0], every[1], this.random());
          if (this.eb === null) this.fireEye('blink', 1);
        }
      } else { this.gtx = 0; this.gty = 0.1; }
      let gtx = this.gtx, gty = this.gty;
      if (this.eb !== null) {
        this.ebT += DT;
        const u = this.ebT / this.ebD, L = this.ebL - 1, d = V.beats[this.eb], g = this.gB;
        if (u >= 1) this.eb = null;
        else if (this.eb === 'wink') { /* DANCE: read below */ } else if (this.eb === 'blink') {
          const v = (u < 0.38 ? smooth(u / 0.38) : smooth(1 - (u - 0.38) / 0.62)) * g;
          open *= 1 - v;
          depth = mix(depth, d.flat[L], v);
        } else if (this.eb === 'flutter') {
          const q = sin(Math.PI * d.lashes[L] * u), v = q * q * g;
          open *= 1 - v * 0.85;
        } else if (this.eb === 'smile') {
          const v = envelope(u, 0.22, 0.45) * g;
          open *= 1 - v; squint *= 1 - v;
          tilt += d.tilt[L] * v; dy += d.dy[L] * v;
        } else if (this.eb === 'soften') {
          const v = envelope(u, 0.3, 0.35) * g;
          open *= 1 - (1 - d.keep[L]) * v; tilt += d.tilt[L] * v; dy += d.dy[L] * v;
        } else if (this.eb === 'glance') {
          const v = envelope(u, 0.2, 0.45) * g;
          gtx = mix(gtx, this.textSide * d.reach[L], v); gty = mix(gty, V.eyes.gaze.text[1], v);
        }
      }
      // DANCE: eye channels. shut closes like smile does. wink closes one eye only.
      let wk = 0;
      if (this.eb === 'wink') { const u = this.ebT / this.ebD; wk = envelope(clamp(u, 0, 1), 0.2, 0.42); }
      if (this.rOn) {
        const RV = this.RV, sh = clamp(RV[C_SHUT], 0, 1);
        open = (open + RV[C_OPEN]) * (1 - sh); squint = (squint + RV[C_SQUINT]) * (1 - sh); tilt += RV[C_TILT]; dy += RV[C_DY]; gtx += RV[C_GX]; gty += RV[C_GY];
        if (RV[C_WINK] > wk) wk = RV[C_WINK];
      }
      this.wk += (clamp(wk, 0, 1) - this.wk) * WINK_K;
      if (wk === 0 && this.wk < 1e-3) this.wk = 0;
      const EPR = this.rig.params.eye;
      // With reduced motion every still is eyes open, so her eyes never close all the way.
      ET[0] = clamp(this.reduced ? Math.max(open, 0.45) : open, 0, this.openMax);
      ET[1] = clamp(depth, EPR.depth.min, EPR.depth.max);
      ET[2] = clamp(dy, EPR.dy.min, EPR.dy.max);
      ET[3] = clamp(tilt, EPR.tilt.min, EPR.tilt.max);
      ET[4] = clamp(squint, 0, 1);
      const c = this.eyeCoef;
      for (let i = 0; i < 5; i += 1) {
        const x = E[i] - ET[i], v = EV[i];
        E[i] = ET[i] + c[0] * x + c[1] * v;
        EV[i] = c[2] * x + c[3] * v;
      }
      const gc = GAZE_COEF;
      let x = this.gx - gtx, v = this.gvx;
      this.gx = gtx + gc[0] * x + gc[1] * v; this.gvx = gc[2] * x + gc[3] * v;
      x = this.gy - gty; v = this.gvy;
      this.gy = gty + gc[0] * x + gc[1] * v; this.gvy = gc[2] * x + gc[3] * v;
    }
    // Stream mode: if any of her moving extremes, either hair tip, the long strand's bulge or her body, would step further than the cap,
    // this step goes only part of the way.
    trackPoints(T) {
      const M = this.m, sp = this.sp, ip = this.ip, n = this.rig.n, BC = STAGE.bodyCircle;
      T[0] = sp[2 * n]; T[1] = sp[2 * n + 1]; T[2] = ip[2 * n]; T[3] = ip[2 * n + 1]; T[4] = sp[12]; T[5] = sp[13]; T[6] = BC[0]; T[7] = BC[1];
      for (let i = 0; i < 8; i += 2) { const x = T[i], y = T[i + 1]; T[i] = M[0] * x + M[2] * y + M[4]; T[i + 1] = M[1] * x + M[3] * y + M[5]; }
    }
    limitStep() {
      const T = this.pNow, P = this.pTrack, B = this.pBody, h = this.h, ph = this.ph, ih = this.ih, pih = this.pih;
      for (let pass = 0; pass < 3; pass += 1) {
        this.trackPoints(T);
        if (this.pTipX !== this.pTipX) { P.set(T); this.pTipX = 0; return; }
        let d = 0;
        for (let i = 0; i < 8; i += 2) { const q = sqrt((T[i] - P[i]) * (T[i] - P[i]) + (T[i + 1] - P[i + 1]) * (T[i + 1] - P[i + 1])); if (q > d) d = q; }
        if (d <= this.stepLimit) { P.set(T); return; }
        const k = (this.stepLimit * 0.95) / d;
        for (let j = 0; j < HN; j += 1) { h[j] = ph[j] + (h[j] - ph[j]) * k; ih[j] = pih[j] + (ih[j] - pih[j]) * k; }
        this.tx = B[0] + (this.tx - B[0]) * k; this.ty = B[1] + (this.ty - B[1]) * k; this.rot = B[2] + (this.rot - B[2]) * k; this.sq = B[3] + (this.sq - B[3]) * k;
        this.layHair();
        this.placeBody();
      }
      this.trackPoints(P);
    }
    yieldHair(d) {
      const rig = this.rig;
      for (let j = 0; j < HN; j += 1) { this.hl[j] += d * rig.yieldO[j]; this.il[j] += d * rig.yieldI[j]; }
      spineFrom(rig, this.hl, this.sp);
      walk(rig.inner, this.il, this.ip, this.ip[0], this.ip[1]);
    }
    // Which spine point of either strand is furthest past the wall, and which way is out.
    scanWall(ex, ey) {
      const M = this.m, G = STAGE.guardRadius, n = this.rig.n;
      wOver = 0; wUX = 0; wUY = 0; wJ = 0; wS = this.sp;
      for (let q = 0; q < 2; q += 1) {
        const S = q ? this.ip : this.sp, W = q ? this.rig.inner.hw : this.rig.hw;
        for (let j = 3; j <= n; j += 1) {
          const qx2 = M[0] * S[2 * j] + M[2] * S[2 * j + 1] + ex - CX, qy2 = M[1] * S[2 * j] + M[3] * S[2 * j + 1] + ey - CY, l = sqrt(qx2 * qx2 + qy2 * qy2), rr = l + W[j] * SC;
          if (rr - G > wOver) { wOver = rr - G; const k = l || 1; wUX = qx2 / k; wUY = qy2 / k; wJ = j; wS = S; }
        }
      }
    }
    // One transform for all of her: art units to bubble units. The gradient lives in art units, so it travels with her.
    placeBody() {
      const sy = 1 + this.sq, sx = 1 / sy, r = this.rot * RAD, c = cos(r), s = sin(r), M = this.m;
      const a = c * sx, b = s * sx, d = -s * sy, e = c * sy;
      let ex = CX + SC * (PX - CX) + this.tx - SC * (a * PX + d * PY);
      let ey = CY + SC * (PY - CY) + this.ty - SC * (b * PX + e * PY);
      M[0] = SC * a; M[1] = SC * b; M[2] = SC * d; M[3] = SC * e;
      // DANCE: still one transform. Yaw is a turn seen from the side: her x scale goes through cos(yaw), about a vertical axis. Spin is a plain rotation of the whole of her about a point that travels with her.
      if (this.yawA !== 0 || this.spinA !== 0) {
        // She has some depth, so edge on she keeps a share of her width and never thins to a line.
        const yc = cos(this.yawA * RAD), ys = sin(this.yawA * RAD) * V.dance.yawDepth, ym = sqrt(yc * yc + ys * ys), k = yc < 0 ? -ym : ym, ax = V.dance.yawAxis * (1 - k), SA = V.dance.spinAt;
        ex += M[0] * ax; ey += M[1] * ax; M[0] *= k; M[1] *= k;
        const sa = this.spinA * RAD, sc = cos(sa), sn = sin(sa), m0 = M[0], m1 = M[1], m2 = M[2], m3 = M[3];
        M[0] = sc * m0 - sn * m1; M[1] = sn * m0 + sc * m1; M[2] = sc * m2 - sn * m3; M[3] = sn * m2 + sc * m3;
        const qcx = CX + SC * (SA[0] - CX) + this.tx, qcy = CY + SC * (SA[1] - CY) + this.ty, ux = ex - qcx, uy = ey - qcy;
        ex = qcx + sc * ux - sn * uy; ey = qcy + sn * ux + sc * uy;
      }
      // A soft wall inside the bubble. Her hair reaches further than her moves were made for, so at the wall the hair gives first: it turns
      // from a point part way along, as far as that helps. Whatever is left holds her back. Both are smooth functions of the pose, so nothing jumps.
      const G = STAGE.guardRadius, BC = STAGE.bodyCircle, rig = this.rig;
      this.scanWall(ex, ey);
      if (wOver > 0) {
        const px = wS[2 * wJ], py = wS[2 * wJ + 1], ax = this.sp[6], ay = this.sp[7], dx = -(py - ay), dy = px - ax;
        const PART = rig.parting, J = (M[0] * dx + M[2] * dy) * wUX + (M[1] * dx + M[3] * dy) * wUY, L = PART.wallDampUnits;
        let d = (-wOver * J) / (J * J + L * L);
        d = d > PART.wallMaxRad ? PART.wallMaxRad : d < -PART.wallMaxRad ? -PART.wallMaxRad : d;
        // The strands' parting comes first, so the hair only gives as far as the gap between them allows.
        const g0 = strandGap(rig, this.sp, this.ip);
        this.yieldHair(d);
        const g1 = strandGap(rig, this.sp, this.ip), f = PART.floorUnits;
        if (g1 < f) { const k = g0 > f && g0 > g1 ? (g0 - f) / (g0 - g1) : 0; this.yieldHair(d * (k - 1)); }
        this.scanWall(ex, ey);
      }
      let over = wOver, ox2 = wUX, oy2 = wUY;
      const bx = M[0] * BC[0] + M[2] * BC[1] + ex - CX, by = M[1] * BC[0] + M[3] * BC[1] + ey - CY, br = sqrt(bx * bx + by * by) + BC[2] * SC * 1.04;
      if (br - G > over) { over = br - G; const l = sqrt(bx * bx + by * by) || 1; ox2 = bx / l; oy2 = by / l; }
      if (over > 0) { ex -= ox2 * over; ey -= oy2 * over; }
      M[4] = ex; M[5] = ey;
    }
    // A state that does not loop stops asking for frames once nothing is moving.
    checkQuiet() {
      const timed = this.state === 'falling' || this.state === 'waking';
      const canRest = !timed && (this.state === 'unavailable' || this.reduced);
      if (!canRest || this.hb !== null || this.eb !== null) { this.quiet = 0; return; }
      let d = abs(this.gx - this.gtx) + abs(this.gy - this.gty);
      for (let i = 0; i < 5; i += 1) d += abs(this.E[i] - this.ET[i]);
      if (!this.reduced) { d += abs(this.tvx) * 0.01 + abs(this.tvy) * 0.01 + abs(this.rv) * 0.01; for (let j = 0; j < HN; j += 1) d += abs(this.h[j] - this.H[j]); }
      this.quiet = d < 0.006 ? this.quiet + 1 : 0;
      if (this.quiet > 8) this.dormant = true;
    }
    // Jumps straight to the current posture, for a first frame or a still.
    snap() {
      this.postureTarget();
      this.P.set(this.PT); this.PV.fill(0);
      const rest = this.reduced;
      hairTargets(this.rig, rest ? 0 : this.P[SAG], rest ? 0 : this.P[BEND], rest ? 1 : this.P[CURL], this.H);
      this.h.set(this.H); this.hv.fill(0); this.Hp.set(this.H);
      hairTargets(this.rig.inner, rest ? 0 : this.P[SAG], rest ? 0 : this.P[BEND], rest ? 1 : this.P[CURL], this.HI);
      this.innerFromChain();
      this.tx = rest ? 0 : this.P[BX]; this.ty = rest ? 0 : this.P[BY]; this.rot = rest ? 0 : this.P[ROT];
      this.stepEyes();
      this.E.set(this.ET); this.EV.fill(0);
      this.gx = this.gtx; this.gy = this.gty;
      this.layHair();
      this.placeBody();
    }
    // Every still she ever shows goes through here: rest pose, eyes open, looking at the person. Pause and a render error use it,
    // and an over-budget fallback would, though none is built. Her moving state is put back afterward, so she can carry on.
    drawStill() {
      const keep = { h: this.h.slice(), ih: this.ih.slice(), hl: this.hl.slice(), il: this.il.slice(), ip: this.ip.slice(), sp: this.sp.slice(), m: this.m.slice(), E: this.E.slice(), gx: this.gx, gy: this.gy, tx: this.tx, ty: this.ty, rot: this.rot, sq: this.sq, spinA: this.spinA, yawA: this.yawA, wk: this.wk }; // DANCE: spinA, yawA, wk
      this.spinA = 0; this.yawA = 0; this.wk = 0; // DANCE
      this.h.fill(0); this.ih.fill(0); this.layHair();
      this.E[0] = V.moods.calm.eyes.open; this.E[1] = 1; this.E[2] = 0; this.E[3] = 0; this.E[4] = 0;
      this.gx = V.eyes.gaze.person[0]; this.gy = V.eyes.gaze.person[1];
      this.tx = this.ty = this.rot = this.sq = 0;
      this.placeBody();
      this.draw();
      this.isStill = true;
      this.h.set(keep.h); this.ih.set(keep.ih); this.hl.set(keep.hl); this.il.set(keep.il); this.ip.set(keep.ip); this.sp.set(keep.sp); this.m.set(keep.m); this.E.set(keep.E);
      this.gx = keep.gx; this.gy = keep.gy; this.tx = keep.tx; this.ty = keep.ty; this.rot = keep.rot; this.sq = keep.sq; this.spinA = keep.spinA; this.yawA = keep.yawA; this.wk = keep.wk; // DANCE: spinA, yawA, wk
      this.hd[0] = 9; this.ED[0] = -9;
    }
    // Runs to the settled sleeping pose without drawing, at the top of the breath.
    settleAsleep() {
      this.fallAsleep();
      while (this.state !== 'sleeping') this.step();
    }

    // ---- drawing
    buildPaths() {
      const rig = this.rig, hd = this.hd, E = this.E, ED = this.ED, look = rig.look;
      let hairMoved = false, eyesMoved = false;
      const hl = this.hl, il = this.il, ihd = this.ihd;
      for (let j = 0; j < HN; j += 1) if (abs(hl[j] - hd[j]) > 2e-5 || abs(il[j] - ihd[j]) > 2e-5) { hairMoved = true; break; }
      for (let i = 0; i < 5; i += 1) if (abs(E[i] - ED[i]) > 2e-4) { eyesMoved = true; break; }
      if (abs(this.gx - ED[5]) > 3e-3 || abs(this.gy - ED[6]) > 3e-3) eyesMoved = true;
      if (abs(this.wk - this.wkD) > 2e-4) eyesMoved = true; // DANCE
      if (hairMoved || !this.bodyPath) {
        hd.set(hl); ihd.set(il);
        bodyEdges(rig, this.sp, this.ip, hl, il);
        this.bodyPath = new Path2D();
        traceBody(rig, this.bodyPath);
      }
      if (eyesMoved && this.wk > 0) { this.buildWinkEyes(); return true; } // DANCE
      if (eyesMoved || !this.domes) {
        ED.set(E); ED[5] = this.gx; ED[6] = this.gy;
        this.wkD = 0; this.domesB = null; this.lidsB = null; // DANCE
        const eye = rig.eye, open = E[0];
        eyeCompute(eye, look, open, E[1], E[4]);
        this.domes = new Path2D(); this.lashes = new Path2D(); this.lids = this.look.lid && open > 0.02 ? new Path2D() : null;
        this.lidW = 7 * smooth(open / 0.25);
        const count = 26 + 6 * lashSegs, shift = this.gx * look.shift;
        const iris = open > 0.03, showGlint = look.glint && this.size * STAGE.scale >= V.eyes.highlightMinPx;
        const ir = look.iris[2] * smooth(open / 0.4), gx = this.gx * look.range[0], gy = this.gy * look.range[1];
        if (iris) { this.irises = new Path2D(); this.glints = showGlint ? new Path2D() : null; this.pupils = look.pupil ? new Path2D() : null; }
        for (let side = 0; side < 2; side += 1) {
          placeSetup(eye, look, side === 1, open, E[3], E[2], shift);
          eyePlace(count);
          traceCrescent(this.domes); traceLashes(this.lashes);
          if (this.lids) traceLid(this.lids);
          if (iris) {
            place(look.iris[0], look.iris[1]);
            const cx = qx + gx * pk, cy = qy + gy * pk, r = ir * pk;
            this.irises.moveTo(cx + r, cy); this.irises.arc(cx, cy, r, 0, TAU);
            if (this.pupils) { const pr = look.pupil * pk * smooth(open / 0.4); this.pupils.moveTo(cx + pr, cy); this.pupils.arc(cx, cy, pr, 0, TAU); }
            if (this.glints) { const gr = look.glint * pk * smooth(open / 0.5), kx = cx - r * 0.34 - gx * 0.25 * pk, ky = cy - r * 0.42 - gy * 0.25 * pk; this.glints.moveTo(kx + gr, ky); this.glints.arc(kx, ky, gr, 0, TAU); }
          }
        }
        this.irisOn = iris;
        this.scleraFill = this.eyeFillFor(open);
      }
      return true;
    }
    // DANCE: both eyes, one of them closing on its own. The same eye math per side; a closing eye below the colour change goes in its own path.
    buildWinkEyes() {
      const rig = this.rig, E = this.E, ED = this.ED, look = rig.look, eye = rig.eye, open = E[0];
      ED.set(E); ED[5] = this.gx; ED[6] = this.gy; this.wkD = this.wk;
      const win = open * (1 - this.wk), shift = this.gx * look.shift, gx = this.gx * look.range[0], gy = this.gy * look.range[1];
      const showGlint = look.glint && this.size * STAGE.scale >= V.eyes.highlightMinPx;
      this.domes = new Path2D(); this.lashes = new Path2D(); this.lids = this.look.lid && open > 0.02 ? new Path2D() : null;
      this.lidsB = this.look.lid && win > 0.02 ? new Path2D() : null; this.lidW = 7 * smooth(open / 0.25); this.lidWB = 7 * smooth(win / 0.25);
      this.domesB = win < 0.16 ? new Path2D() : null;
      this.irises = new Path2D(); this.glints = showGlint ? new Path2D() : null; this.pupils = look.pupil ? new Path2D() : null;
      for (let side = 0; side < 2; side += 1) {
        const op = side === V.dance.winkSide ? win : open;
        eyeCompute(eye, look, op, E[1], E[4]);
        placeSetup(eye, look, side === 1, op, E[3], E[2], shift);
        eyePlace(26 + 6 * lashSegs);
        traceCrescent(side === V.dance.winkSide && this.domesB ? this.domesB : this.domes); traceLashes(this.lashes);
        const lid = side === V.dance.winkSide ? this.lidsB : this.lids;
        if (lid) traceLid(lid);
        if (op > 0.03) {
          place(look.iris[0], look.iris[1]);
          const cx = qx + gx * pk, cy = qy + gy * pk, r = look.iris[2] * smooth(op / 0.4) * pk;
          this.irises.moveTo(cx + r, cy); this.irises.arc(cx, cy, r, 0, TAU);
          if (this.pupils) { const pr = look.pupil * pk * smooth(op / 0.4); this.pupils.moveTo(cx + pr, cy); this.pupils.arc(cx, cy, pr, 0, TAU); }
          if (this.glints) { const gr = look.glint * pk * smooth(op / 0.5), kx = cx - r * 0.34 - gx * 0.25 * pk, ky = cy - r * 0.42 - gy * 0.25 * pk; this.glints.moveTo(kx + gr, ky); this.glints.arc(kx, ky, gr, 0, TAU); }
        }
      }
      this.irisOn = true;
      this.scleraFill = this.eyeFillFor(open);
    }
    // Closed, the eye is the reference's colour; open, its white. In Light and Dark those are the same. In Dusk there is no blend,
    // so no grey frame: the eye is only a thin sliver when the colour changes, and the dark lid line carries it.
    eyeFillFor(open) {
      return open < 0.16 ? this.eyeColor : this.look.sclera;
    }
    draw() {
      this.buildPaths();
      this.paint(this.ctx, this.grad, this.canvas.width);
      return true;
    }
    // The whole picture, under one transform: one path and one gradient for body and hair, and the eyes.
    // The eye goes down first on the empty canvas. Iris, pupil and highlight are cut by the alpha it left, not by a clip, so an edge pixel
    // gets the eye's coverage once and no white shows along the rim. Lashes, then body, go in behind it.
    paint(ctx, grad, W, opts) {
      const s = W / 720, M = this.m;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, W);
      ctx.setTransform(s * M[0], s * M[1], s * M[2], s * M[3], s * (M[4] - 201), s * (M[5] - 107));
      const body = !opts || opts.body !== false, eyeFill = opts && opts.eyeFill;
      if (opts && opts.eyes === false) { if (body) { ctx.fillStyle = grad; ctx.fill(this.bodyPath); } return; }
      const look = this.look;
      ctx.fillStyle = eyeFill || this.scleraFill;
      ctx.fill(this.domes);
      if (this.domesB) { ctx.fillStyle = eyeFill || this.eyeColor; ctx.fill(this.domesB); } // DANCE
      if (this.irisOn && !eyeFill) {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = look.iris; ctx.fill(this.irises);
        if (this.pupils) { ctx.fillStyle = look.pupil; ctx.fill(this.pupils); }
        if (this.glints) { ctx.fillStyle = look.glint; ctx.fill(this.glints); }
      }
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = eyeFill || this.lashColor;
      ctx.fill(this.lashes);
      if (body) { ctx.fillStyle = grad; ctx.fill(this.bodyPath); }
      ctx.globalCompositeOperation = 'source-over';
      if (this.lids && !eyeFill) { ctx.strokeStyle = look.lid; ctx.lineWidth = this.lidW; ctx.lineCap = 'round'; ctx.stroke(this.lids); }
      if (this.lidsB && !eyeFill) { ctx.strokeStyle = look.lid; ctx.lineWidth = this.lidWB; ctx.lineCap = 'round'; ctx.stroke(this.lidsB); } // DANCE
    }
  }


  // Sleep's breath, drawn once to a strip: half a breath of hair and body, each frame the same one path and one gradient.
  // A CSS steps() transform plays it there and back, so the render loop stops. Frames are drawn at the live backing size
  // and scaled down once, so the first frame matches the last live frame.
  function makeSleepStrip({ size, dpr, theme, frames }) {
    const cell = Math.round(size * dpr), W = Math.round(size * backingScale(size, dpr));
    const canvas = document.createElement('canvas');
    canvas.width = cell * frames; canvas.height = cell;
    const out = canvas.getContext('2d');
    const temp = document.createElement('canvas');
    temp.width = W; temp.height = W;
    const ctx = temp.getContext('2d');
    const sim = new Avatar(null, { size, dpr, theme });
    sim.scale = W / 720;
    sim.settleAsleep();
    const grad = sim.makeGradient(ctx), half = Math.round((ZZ.cycle / 2) / DT);
    let at = 0;
    for (let i = 0; i < frames; i += 1) {
      const want = Math.round((i * half) / (frames - 1));
      while (at < want) { sim.step(); at += 1; }
      sim.buildPaths();
      sim.paint(ctx, grad, W);
      out.drawImage(temp, i * cell, 0, cell, cell);
    }
    return { canvas, frames, cell, halfS: ZZ.cycle / 2 };
  }

  // package: named exports instead of root.MaiaEngine, and walk added to internal.
export {
    Avatar, compileScore, makeSleepStrip, tierFor, backingScale, DT, V as VOCAB, ROUTINES, // DANCE: ROUTINES
};
export const internal = { RIGS, buildLash, hairTargets, spineFrom, walk, innerFrom, partOuter, strandGap, carried, bodyEdges, traceBody, eyeCompute, placeSetup, eyePlace, traceCrescent, traceLashes };
