// What the glass tiles (the owner's pick C, Nov 16) cost while panning and zooming the office, against the solid tile they fall
// back to under reduced transparency (release 6.6's), alternated in one session, on the Product Designer's two profiles
// (landing-showcase SPEC): a mid laptop (1440 x 900 at 2x, the GPU, CPU 2x slower) and a Pixel 7 (412 x 915 at 2.625x, touch, CPU 4x
// slower). Four desks of nine icon tiles, Plain or White oak (the textured desk is the glass's worst case: each tile bends the
// wood under it, so it has a bitmap of its own). Per look: a pan's frames, a zoom's frames (the camera moving, bitmaps reused),
// and the settle after each zoom (every tile rastered again at the new scale: where the glass's cost lands). Full Chromium on
// the GPU. Skipped unless GLASS_PERF names the JSON file:
//   GLASS_PERF=/abs/out.json GLASS_PROFILE=laptop|pixel7 [GLASS_TRIALS=2] MA_PW_PORT=5181 npx playwright test --project=shell apptiles.glass.perf --workers=1
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn } from './helpers';

const OUT = process.env['GLASS_PERF'] ?? '';
const PROFILE = process.env['GLASS_PROFILE'] === 'pixel7' ? 'pixel7' : 'laptop';
const TRIALS = Number(process.env['GLASS_TRIALS'] ?? 1);
const BIBLE = 'com.minimalistalliance.bible';
const P = PROFILE === 'pixel7'
  ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, cpu: 4, s: 0.6 }
  : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false, cpu: 2, s: 0.8 };

test.skip(!OUT, 'GLASS_PERF names the file for the numbers');
test.use({
  channel: 'chromium',
  launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=vulkan', '--enable-features=Vulkan'] },
  viewport: P.viewport,
  deviceScaleFactor: P.deviceScaleFactor,
  isMobile: P.isMobile,
  hasTouch: P.hasTouch,
});
test.setTimeout(180_000);

type Hook = { __maDesk: { spriteBytes(): number; glassLensStats(): { ms: number; count: number }; camera: { isMoving(): boolean; set(c: { x: number; y: number; s: number }): void; getStage(): unknown } } };
const APPS = ['browser', 'files', 'notebook', 'agent', 'courier', 'commons', 'todo', 'documents', `app:${BIBLE}`];
const ids = ['d-glass00000010', 'd-glass00000020', 'd-glass00000030', 'd-glass00000040'];
const COLS = 5;
function desk(id: string, n: number, style: string) {
  const w = 24 + COLS * 92 - 16 + 24;
  const h = 24 + 2 * 92 - 16 + 60;
  const items = APPS.map((app, k) => ({ id: `${id}:${app}`, app, x: 24 + (k % COLS) * 92, y: 24 + Math.floor(k / COLS) * 92, w: 76, h: 76 }));
  return { x: (n % 2) * (w + 80), y: Math.floor(n / 2) * (h + 80), w, h, style, items };
}

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 8_000 }).toBe(false);
  await page.waitForTimeout(400);
}

const q = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]! * 100) / 100;
};
const frames = (dt: number[]) => ({ n: dt.length, medianMs: q(dt, 0.5), p95Ms: q(dt, 0.95), maxMs: q(dt, 1), fps: Math.round((1000 / (dt.reduce((a, b) => a + b, 0) / Math.max(1, dt.length))) * 10) / 10, under17_5: Math.round((dt.filter((d) => d <= 17.5).length / Math.max(1, dt.length)) * 1000) / 10, over33: dt.filter((d) => d > 33.4).length });

for (let trial = 1; trial <= TRIALS; trial += 1) {
  for (const style of ['white-oak', 'plain']) {
    for (const look of ['solid', 'glass']) {
      test(`${PROFILE} ${style} ${look} #${trial}`, async ({ page, request }) => {
        await page.addInitScript(() => { (window as unknown as { __maTestDeskStyles: unknown }).__maTestDeskStyles = []; });
        // The solid tile is the glass's fallback, under reduced transparency.
        const media = await page.context().newCDPSession(page);
        if (look === 'solid') await media.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
        await page.addInitScript((init) => {
          (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
        }, { available: true, installMs: 60_000, preinstalled: Object.fromEntries(ids.map((d) => [d, [BIBLE]])), tamper: {} });
        await setTheme(page, 'light');
        await harness(request, { reset: true });
        await harness(request, {
          fleet: ids.map((deskId, n) => ({ deskId, name: `Desk ${n + 1}`, kind: n === 0 ? 'personal' : 'work', state: 'running' })),
          files: { enabled: true },
          appFrames: true,
          layoutDocs: { 'u-test': { version: 1, updatedAt: '2026-11-16T00:00:00Z', layout: { schemaVersion: 2, desks: Object.fromEntries(ids.map((id, n) => [id, desk(id, n, style)])), z: ids } } },
        });
        await signIn(page, '/?widgets=none');
        await canvasPainted(page);
        await page.waitForTimeout(1500);
        const gpu = await page.evaluate(() => {
          const gl = document.createElement('canvas').getContext('webgl');
          const ext = gl?.getExtension('WEBGL_debug_renderer_info');
          return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'none';
        });
        const set = (s: number, x: number, y: number): Promise<void> => page.evaluate(({ s, x, y }) => (window as unknown as Hook).__maDesk.camera.set({ s, x, y }), { s, x, y });
        await set(P.s, 20, 80);
        await settled(page);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: P.cpu });
        // Every draw of the canvas's layer, timed; and every frame's interval.
        await page.evaluate(() => {
          const w = window as unknown as { __draws: number[] } & Hook;
          w.__draws = [];
          const layer = (w.__maDesk.camera.getStage() as { getLayers(): { drawScene(...a: unknown[]): unknown }[] }).getLayers()[0]!;
          const own = layer.drawScene.bind(layer);
          layer.drawScene = (...a: unknown[]) => {
            const t0 = performance.now();
            const r = own(...a);
            w.__draws.push(performance.now() - t0);
            return r;
          };
        });
        const take = (): Promise<number[]> => page.evaluate(() => {
          const w = window as unknown as { __draws: number[] };
          const d = w.__draws;
          w.__draws = [];
          return d;
        });
        const lens = (): Promise<{ ms: number; count: number }> => page.evaluate(() => (window as unknown as Hook).__maDesk.glassLensStats());
        // A motion of `n` frames, the camera set once per frame from `at(f)`; the frames' intervals.
        const move = (n: number, kind: 'pan' | 'zoom', s0: number, s1: number): Promise<number[]> => page.evaluate(async ({ n, kind, s0, s1 }) => {
          const c = (window as unknown as Hook).__maDesk.camera;
          const dt: number[] = [];
          let last = await new Promise<number>((r) => requestAnimationFrame(r));
          for (let f = 1; f <= n; f += 1) {
            const k = f / n;
            if (kind === 'pan') c.set({ s: s0, x: 20 - f * 5, y: 80 - f * 1.5 });
            else {
              const s = s0 * (s1 / s0) ** k;
              // Zoom about the screen's middle.
              const mx = innerWidth / 2;
              const my = innerHeight / 2;
              c.set({ s, x: mx - ((mx - 20) / s0) * s, y: my - ((my - 80) / s0) * s });
            }
            const now = await new Promise<number>((r) => requestAnimationFrame(r));
            dt.push(now - last);
            last = now;
          }
          return dt;
        }, { n, kind, s0, s1 });
        const l0 = await lens();
        await take();
        const pan = await move(150, 'pan', P.s, P.s);
        const panDraws = await take();
        await set(P.s, 20, 80);
        await settled(page);
        await take();
        const settles: number[] = [];
        const zoomDt: number[] = [];
        const zoomDraws: number[] = [];
        for (const [a, b] of [[P.s, P.s * 1.5], [P.s * 1.5, P.s * 0.75], [P.s * 0.75, P.s * 1.1]] as const) {
          zoomDt.push(...(await move(90, 'zoom', a, b)));
          zoomDraws.push(...(await take()));
          await settled(page);
          // The settle: the one draw that rasters every tile at the new scale.
          settles.push(Math.max(0, ...(await take())));
          await page.evaluate(({ s }) => (window as unknown as Hook).__maDesk.camera.set({ s, x: innerWidth / 2 - ((innerWidth / 2 - 20) / s) * s, y: innerHeight / 2 - ((innerHeight / 2 - 80) / s) * s }), { s: b });
          await settled(page);
          await take();
        }
        const l1 = await lens();
        const mb = await page.evaluate(() => Math.round((window as unknown as Hook).__maDesk.spriteBytes() / 10_000) / 100);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        const row = {
          profile: PROFILE, style, look, trial, gpu, cpu: P.cpu,
          pan: { ...frames(pan), drawP95Ms: q(panDraws, 0.95), drawMedianMs: q(panDraws, 0.5) },
          zoom: { ...frames(zoomDt), drawP95Ms: q(zoomDraws, 0.95), drawMedianMs: q(zoomDraws, 0.5) },
          settleMs: settles.map((x) => Math.round(x * 10) / 10),
          lens: { tiles: l1.count - l0.count, ms: Math.round((l1.ms - l0.ms) * 10) / 10, perTileMs: l1.count > l0.count ? Math.round(((l1.ms - l0.ms) / (l1.count - l0.count)) * 100) / 100 : 0 },
          spriteMb: mb,
        };
        const all = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as unknown[]) : [];
        all.push(row);
        writeFileSync(OUT, JSON.stringify(all, null, 1));
      });
    }
  }
}
