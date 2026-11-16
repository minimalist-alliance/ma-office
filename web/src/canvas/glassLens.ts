// The desk under an icon's glass, frosted and bent at the rim (`glass.ts` says what reads as glass; `sprites.ts`
// `glassBackdropSprite` asks for it). Made only in idle time after a settle, a few per idle slice, never in a frame, so it's a
// chunk of its own, fetched with the first backdrop a textured desk asks for (release 6.11: out of the first load, the equal of
// what the theme sliders' glass put in).
import type { GlassFace } from '../theme/tokens';
import type { GlassBackdrop } from './glass';

/**
 * Where each pixel near the rim looks (the lens), worked out once per tile size, radius and raster scale and shared by every tile
 * of that size: within `band` of the edge a pixel shows the desk from further out along the edge's outward normal, by up to
 * `lens` of the band at the rim (growing as the square toward it), so the grain bends round the thick edge; `clear` is how much
 * of the sharp copy it takes over the frosted one. Inside the band every pixel is the desk straight below (a row's `inner` span).
 */
interface Field { tw: number; th: number; mpx: number; idx: Int32Array; sx: Float32Array; sy: Float32Array; clear: Float32Array; inner: Int32Array }
const fields = new Map<string, Field>();
function field(w: number, h: number, r: number, q: number, g: GlassFace): Field {
  const bandW = g.band * w;
  const reach = g.lens * bandW;
  const mpx = Math.ceil((reach + 3 * g.frost + 2) * q);
  const key = `${w}|${h}|${r}|${q}|${bandW}|${reach}|${mpx}`;
  const hit = fields.get(key);
  if (hit) return hit;
  const tw = Math.ceil(w * q);
  const th = Math.ceil(h * q);
  const hw = w / 2;
  const hh = h / 2;
  const ex = hw - r;
  const ey = hh - r;
  const idx: number[] = [];
  const sx: number[] = [];
  const sy: number[] = [];
  const clear: number[] = [];
  const inner = new Int32Array(th * 2).fill(-1);
  for (let j = 0; j < th; j += 1) {
    const v = (j + 0.5) / q - hh;
    for (let i = 0; i < tw; i += 1) {
      const u = (i + 0.5) / q - hw;
      const qx = Math.abs(u) - ex;
      const qy = Math.abs(v) - ey;
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy);
      const d = r - outside - Math.min(Math.max(qx, qy), 0); // distance in from the edge
      if (d >= bandW) {
        if (inner[2 * j]! < 0) inner[2 * j] = i;
        inner[2 * j + 1] = i + 1;
        continue;
      }
      const t = 1 - Math.max(0, d) / bandW;
      const k = reach * t * t;
      let nx = 0;
      let ny = 0;
      if (qx > 0 && qy > 0 && outside > 0) {
        nx = (ox / outside) * Math.sign(u);
        ny = (oy / outside) * Math.sign(v);
      } else if (qx > qy) nx = Math.sign(u);
      else ny = Math.sign(v);
      idx.push(j * tw + i);
      // In the copy's pixels: the copy's (mpx, mpx) is the tile's top left.
      sx.push(mpx + i + nx * k * q);
      sy.push(mpx + j + ny * k * q);
      clear.push(t);
    }
  }
  const f = { tw, th, mpx, idx: Int32Array.from(idx), sx: Float32Array.from(sx), sy: Float32Array.from(sy), clear: Float32Array.from(clear), inner };
  fields.set(key, f);
  return f;
}

/**
 * The desk under the tile, frosted and bent, as a bitmap of the tile's size at raster scale `q`: the desk drawn into a small CPU
 * canvas with a margin, frosted with the canvas's blur, then each pixel straight below the tile copied row by row and the rim's
 * gathered through the shared field, bilinearly.
 */
function backdrop(w: number, h: number, r: number, q: number, at: GlassBackdrop, g: GlassFace): OffscreenCanvas | null {
  const f = field(w, h, r, q, g);
  const { tw, th, mpx } = f;
  const sw = tw + 2 * mpx;
  const sh = th + 2 * mpx;
  const src = new OffscreenCanvas(sw, sh);
  const sctx = src.getContext('2d', { willReadFrequently: true });
  if (!sctx) return null;
  // Desk units to the copy's pixels, the tile's top left at (mpx, mpx).
  sctx.setTransform(q, 0, 0, q, mpx - at.x * q, mpx - at.y * q);
  const x0 = at.x - mpx / q;
  const y0 = at.y - mpx / q;
  sctx.fillStyle = at.base;
  sctx.fillRect(x0, y0, sw / q, sh / q);
  const pattern = sctx.createPattern(at.image, 'repeat');
  if (pattern) {
    pattern.setTransform(new DOMMatrix([1 / at.density, 0, 0, 1 / at.density, 0, 0]));
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.fillStyle = pattern;
    sctx.fillRect(x0, y0, sw / q, sh / q);
  }
  const sharp = sctx.getImageData(0, 0, sw, sh).data;
  let from = sharp;
  if (g.frost > 0) {
    const fr = new OffscreenCanvas(sw, sh);
    const fctx = fr.getContext('2d', { willReadFrequently: true });
    if (!fctx) return null;
    if (typeof (fctx as { filter?: unknown }).filter === 'string') {
      fctx.filter = `blur(${g.frost * q}px)`;
      fctx.drawImage(src, 0, 0);
    } else {
      // No canvas filter: down and back up, smoothed.
      const k = Math.max(1, Math.round(g.frost * q));
      const small = new OffscreenCanvas(Math.max(1, Math.round(sw / k)), Math.max(1, Math.round(sh / k)));
      const smctx = small.getContext('2d')!;
      smctx.imageSmoothingQuality = 'high';
      smctx.drawImage(src, 0, 0, small.width, small.height);
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(small, 0, 0, sw, sh);
    }
    from = fctx.getImageData(0, 0, sw, sh).data;
  }
  const out = new ImageData(tw, th);
  const px = out.data;
  // Straight below: whole runs of a row at once.
  for (let j = 0; j < th; j += 1) {
    const i0 = f.inner[2 * j]!;
    if (i0 < 0) continue;
    const i1 = f.inner[2 * j + 1]!;
    const s0 = ((mpx + j) * sw + mpx + i0) * 4;
    px.set(from.subarray(s0, s0 + (i1 - i0) * 4), (j * tw + i0) * 4);
  }
  // The rim: bent, and clearer toward the edge.
  const frosted = from !== sharp;
  for (let n = 0; n < f.idx.length; n += 1) {
    const fx = f.sx[n]!;
    const fy = f.sy[n]!;
    const xa = Math.max(0, Math.min(sw - 2, Math.floor(fx)));
    const ya = Math.max(0, Math.min(sh - 2, Math.floor(fy)));
    const ax = Math.max(0, Math.min(1, fx - xa));
    const ay = Math.max(0, Math.min(1, fy - ya));
    const a = (ya * sw + xa) * 4;
    const b = a + 4;
    const c = a + sw * 4;
    const e = c + 4;
    const o = f.idx[n]! * 4;
    const cl = frosted ? f.clear[n]! : 0;
    for (let ch = 0; ch < 3; ch += 1) {
      const top = from[a + ch]! + (from[b + ch]! - from[a + ch]!) * ax;
      const bot = from[c + ch]! + (from[e + ch]! - from[c + ch]!) * ax;
      let val = top + (bot - top) * ay;
      if (cl > 0) {
        const st = sharp[a + ch]! + (sharp[b + ch]! - sharp[a + ch]!) * ax;
        const sb = sharp[c + ch]! + (sharp[e + ch]! - sharp[c + ch]!) * ax;
        val += (st + (sb - st) * ay - val) * cl;
      }
      px[o + ch] = val;
    }
  }
  for (let o = 3; o < px.length; o += 4) px[o] = 255;
  const done = new OffscreenCanvas(tw, th);
  done.getContext('2d')!.putImageData(out, 0, 0);
  return done;
}

/**
 * The desk under a tile as the glass shows it (frosted, bent at the rim), clipped to the tile's rounded rect, `w` by `h` desk units
 * at raster scale `q`: a bitmap of its own under the tile's face, so the face stays shared by every tile of its app and size, and
 * this one, which depends on where the tile sits, can be made when the page is idle. Null if a canvas is unavailable.
 */
export function glassBackdrop(w: number, h: number, r: number, q: number, at: GlassBackdrop, g: GlassFace): OffscreenCanvas | null {
  const t0 = performance.now();
  const bmp = backdrop(w, h, r, q, at, g);
  if (!bmp) return null;
  const out = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.scale(bmp.width / w, bmp.height / h);
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.clip();
  ctx.drawImage(bmp, 0, 0, w, h);
  lensMs += performance.now() - t0;
  lensCount += 1;
  return out;
}

let lensMs = 0;
let lensCount = 0;
/** Time spent bending desks under glass since the page loaded, and how many tiles, for perf runs. */
export const glassLensStats = (): { ms: number; count: number } => ({ ms: lensMs, count: lensCount });
