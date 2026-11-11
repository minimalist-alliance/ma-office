// Frame pacing and input latency with real input (CDP mouse, wheel and keys), on the loads a member
// has (one desk, three desks) and on budget B1's fixture of 24 desks x 12 tiles. Ported from
// prototype/tests/perf.py, with a bare-canvas control so a low number can be told apart from a slow
// machine.
//
//   node tests/perf/perf.mjs [--fixtures one,three,perf] [--themes light,dusk,dark]
//                            [--configs 1920x1080x2] [--trials 3] [--gpu] [--dist dist/e2e]
//                            [--only deskDrag,deskPush,pan] [--port 4175]
//
// --only runs just those motion trials and skips the rest, so the same trial can be repeated
// against two bundles, alternating, on a machine others share. See web/CLAUDE.md, "Comparing bundles".
//
// --gpu runs full Chromium on the host's GPU and fails if it lands on a software renderer. Without
// it, headless Chromium has software compositing and a software 2D canvas, whatever the machine has.
//
// Honest limits: absolute frame budgets are proven only on the reference devices (design 2.2). A
// software run says little about them, and a run on a desktop GPU flatters them. "draw" is Konva
// recording commands; a 2D canvas rasters them later, in the commit. So "main" (from a trace of the
// same run) is the number to hold against the 8 ms budget, and "flush" is how much of it is the
// raster. localhost has no network, so the load numbers measure this bundle's own start-up, not the
// network.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const THEMES = arg('themes', 'light').split(',');
const CONFIGS = arg('configs', '1920x1080x2').split(',').map((c) => c.split('x').map(Number));
const TRIALS = Number(arg('trials', '3'));
const FIXTURES = arg('fixtures', 'one,three,perf').split(',');
const DIST = arg('dist', 'dist/e2e');
const ONLY = arg('only', '').split(',').filter(Boolean);
const wants = (name) => !ONLY.length || ONLY.includes(name);
const GPU = process.argv.includes('--gpu');
const PORT = Number(arg('port', '4175'));
const BASE = `http://localhost:${PORT}`;

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
};
const round = (v, d = 1) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

// What each fixture needs from the trials: the keys of a focus tour and the desk to drag.
const LOADS = {
  one: { label: 'one desk', focus: ['1', '0', '1', '0', '1', '0', '1', '0'], drag: /^Personal desk/, group: 'Personal desk' },
  three: { label: 'three desks', focus: ['1', '2', '3', '0', '2', '1', '3', '0'], drag: /^Work desk/, group: 'Work desk', push: /^Personal desk/, pushFar: 240 },
  // Desk 1 is the left end of a row of six, so this drag has five desks moving by the far end of it.
  perf: { label: '24 desks x 12 tiles', focus: ['1', '2', '9', '3', '8', '0', '4', '0'], drag: /^Desk 8 desk/, group: 'Desk 8 desk', push: /^Desk 1 desk/, pushFar: 200 },
};
const TRIAL_NAMES = ['focus', 'focusSettled', 'pan', 'wheel', 'deskDrag', 'deskPush', 'deskResize', 'appDrag', 'appResize', 'cleanup'];
const GPU_ARGS = ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];

const INSTRUMENT = () => {
  const q = { frames: [], draws: [], run: false };
  window.__perf = q;
  // Budget B1 holds during motion, so each frame records whether anything was moving: a re-raster
  // in the frame after the camera lands drops nothing the eye can see. The worst frame at rest is
  // reported separately, so it can't hide.
  const loop = (t) => {
    if (q.run) q.frames.push([t, window.__maDesk.camera.isMoving()]);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // Konva draw time per frame: the main-thread work the canvas adds (design 2.2).
  const layer = window.__maDesk.camera.getStage().getLayers()[0];
  const draw = layer.draw.bind(layer);
  layer.draw = () => {
    const a = performance.now();
    const r = draw();
    if (q.run) q.draws.push(performance.now() - a);
    return r;
  };
  // B2: input to next paint.
  q.events = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name === 'click' || e.name === 'pointerdown' || e.name === 'keydown') q.events.push(e.duration);
  }).observe({ type: 'event', durationThreshold: 16, buffered: false });
  // B4: click to the window's first animation frame.
  q.opens = [];
  let t0 = 0;
  window.addEventListener('pointerup', () => { t0 = performance.now(); }, true);
  new MutationObserver((muts) => {
    if (!t0) return;
    if (muts.some((m) => [...m.addedNodes].some((n) => n.classList?.contains('ma-window')))) {
      const start = t0;
      t0 = 0;
      requestAnimationFrame(() => q.opens.push(performance.now() - start));
    }
  }).observe(document.querySelector('.window-layer'), { childList: true });
};

const START = () => {
  const q = window.__perf;
  q.frames = [];
  q.draws = [];
  q.run = true;
};
const STOP = () => {
  const q = window.__perf;
  q.run = false;
  return { frames: q.frames, draws: q.draws };
};

function summarize({ frames, draws }) {
  const d = [];
  const rest = [];
  for (let i = 1; i < frames.length; i += 1) {
    const delta = frames[i][0] - frames[i - 1][0];
    if (frames[i - 1][1]) d.push(delta);
    else rest.push(delta);
  }
  const total = d.reduce((a, b) => a + b, 0);
  const dropped = d.reduce((n, x) => n + Math.max(0, Math.round(x / (1000 / 60)) - 1), 0);
  return {
    fps: round((1000 * d.length) / total),
    p95: round(pct(d, 0.95)),
    worst: round(Math.max(...d)),
    worstAtRest: round(rest.length ? Math.max(...rest) : 0),
    droppedPct: round((100 * dropped) / (d.length + dropped)),
    drawMean: round(draws.reduce((a, b) => a + b, 0) / Math.max(1, draws.length)),
    drawP95: round(pct(draws, 0.95)),
    n: d.length,
  };
}

const CONTROL = `<!doctype html><html><body style="margin:0;overflow:hidden"><canvas id=c></canvas><script>
const c = document.getElementById('c'); const dpr = devicePixelRatio;
c.width = innerWidth * dpr; c.height = innerHeight * dpr; c.style.width = innerWidth + 'px'; c.style.height = innerHeight + 'px';
const ctx = c.getContext('2d');
window.run = (ms) => new Promise(res => { const t = []; const s = performance.now(); let i = 0;
  const f = (x) => { t.push(x); i++;
    ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,c.width,c.height); ctx.setTransform(dpr,0,0,dpr,0,0);
    const sc = 1 + Math.sin(i/10)*0.3; ctx.translate(200 + Math.sin(i/7)*100, 200); ctx.scale(sc, sc);
    for (let k=0;k<3;k++){ ctx.fillStyle='#fff'; ctx.beginPath(); ctx.roundRect(k*520, (k%2)*300, 442, 262, 28); ctx.fill();
      for (let j=0;j<4;j++){ ctx.beginPath(); ctx.roundRect(k*520+26+j*102,(k%2)*300+26,84,84,20); ctx.strokeStyle='#ddd'; ctx.stroke();
        ctx.fillStyle='#333'; ctx.font='14px sans-serif'; ctx.fillText('App '+j, k*520+40+j*102, (k%2)*300+70);} }
    if (x - s < ms) requestAnimationFrame(f); else { const d=[]; for (let j=1;j<t.length;j++) d.push(t[j]-t[j-1]);
      res(+(1000/(d.reduce((a,b)=>a+b,0)/d.length)).toFixed(1)); } };
  requestAnimationFrame(f); });
</script></body></html>`;

// As tests/e2e/helpers.ts: a signed-out member goes straight to the fake sign-in, with no card, unless the loop guard shows one.
async function signIn(page) {
  await page.goto(BASE);
  const button = page.getByRole('button', { name: 'Sign in', exact: true });
  await button.or(page.locator('.ma-shell')).first().waitFor();
  if (await button.isVisible()) await button.click();
  await page.locator('.ma-shell').waitFor();
}

// Main-thread work per frame that changed something, from a trace. Konva's draw only records
// commands, so the raster a 2D canvas does in the commit is invisible to a timer around layer.draw().
function mainThread(buffer) {
  const events = JSON.parse(buffer.toString()).traceEvents;
  const mains = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
  const frames = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || e.name !== 'ProxyMain::BeginMainFrame' || !mains.has(`${e.pid}:${e.tid}`)) continue;
    const k = `${e.pid}:${e.tid}`;
    if (!frames.has(k)) frames.set(k, []);
    frames.get(k).push(e);
  }
  const [key, list] = [...frames.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [null, []];
  const flushes = events.filter((e) => e.ph === 'X' && e.name === 'LayerTreeHost::DoUpdateLayers' && `${e.pid}:${e.tid}` === key);
  const main = [];
  const flush = [];
  for (const f of flushes) {
    const frame = list.find((b) => b.ts <= f.ts && f.ts + f.dur <= b.ts + b.dur);
    if (frame) {
      main.push(frame.dur / 1000);
      flush.push(f.dur / 1000);
    }
  }
  return {
    mainMean: round(main.reduce((a, b) => a + b, 0) / Math.max(1, main.length)),
    mainP95: round(pct(main, 0.95)),
    flushMean: round(flush.reduce((a, b) => a + b, 0) / Math.max(1, flush.length)),
    flushP95: round(pct(flush, 0.95)),
  };
}

async function measure(browser, page, action) {
  await browser.startTracing(page, { categories: ['toplevel', 'cc'] });
  await page.evaluate(START);
  await action();
  const frames = summarize(await page.evaluate(STOP));
  return { ...frames, ...mainThread(await browser.stopTracing()) };
}

async function emptyPoint(page, w, h) {
  return page.evaluate(([vw, vh]) => {
    const st = window.__maDesk.camera.getStage();
    for (let y = 120; y < vh - 120; y += 20) {
      for (let x = 60; x < vw - 60; x += 20) {
        if (!st.getIntersection({ x, y })) return [x, y];
      }
    }
    return [20, vh / 2];
  }, [w, h]);
}

/** The canvas takes its single keys only while it has focus, as after a member's press on it (shell/useKeyboard.ts). */
async function focusCanvas(page) {
  await page.locator('.canvas-wrap').focus();
}

async function overview(page) {
  await focusCanvas(page);
  await page.keyboard.press('0');
  await page.waitForTimeout(800);
}

async function themedPage(browser, theme, w, h, dpr) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('ma.prefs.theme', JSON.stringify({ mode: t, systemDark: 'dark' }));
    localStorage.setItem('ma.theme.resolved', t);
  }, theme);
  await signIn(page);
  return { ctx, page };
}

async function runControl(browser, w, h, dpr) {
  const controlPage = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })).newPage();
  await controlPage.setContent(CONTROL);
  await controlPage.waitForTimeout(200);
  const control = await controlPage.evaluate('run(1500)');
  const renderer = await controlPage.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'none';
  });
  await controlPage.context().close();
  if (GPU && /swiftshader|llvmpipe|^none$/i.test(renderer)) throw new Error(`--gpu asked for, but the renderer is ${renderer}`);
  return { control, renderer };
}

/** The camera and drag trials (B1) and load time (B15), on one fixture. */
async function runCamera(browser, fixture, theme, w, h, dpr) {
  const load = LOADS[fixture];
  const { ctx, page } = await themedPage(browser, theme, w, h, dpr);

  // B15: load to first canvas paint, on the fixture. First load in this context, then with the bundle cached.
  const paintMs = async () => {
    await page.waitForFunction(() => performance.getEntriesByName('ma:first-canvas-paint').length > 0, null, { timeout: 20000 });
    return page.evaluate(() => performance.getEntriesByName('ma:first-canvas-paint')[0].startTime);
  };
  await page.goto(`${BASE}/?fixture=${fixture}`);
  const loadFirst = await paintMs();
  await page.reload();
  const loadCached = await paintMs();
  await page.waitForTimeout(800);
  await page.evaluate(INSTRUMENT);

  const flat = await page.evaluate(() => document.documentElement.classList.contains('flat-ground'));
  const before = await page.evaluate(() => ({ ...window.__maDesk.camera.stats }));

  // Camera: focus moves (real keys), the budgeted motion. A move takes up to 480 ms and the camera
  // settles 140 ms later, so at this spacing the whole tour is one unbroken move.
  const trials = {};
  await focusCanvas(page);
  if (wants('focus')) {
    trials.focus = await measure(browser, page, async () => {
      for (const k of load.focus) {
        await page.keyboard.press(k);
        await page.waitForTimeout(520);
      }
    });
  }

  // The same tour, settling after each move as a member's would: every move starts from a canvas at
  // full resolution, with sprites at the last move's scale.
  if (wants('focusSettled')) {
    await overview(page);
    trials.focusSettled = await measure(browser, page, async () => {
      for (const k of load.focus) {
        await page.keyboard.press(k);
        await page.waitForTimeout(760);
      }
    });
  }

  // Pan: a real drag on the background, in the overview.
  if (wants('pan')) {
    await overview(page);
    const [px, py] = await emptyPoint(page, w, h);
    trials.pan = await measure(browser, page, async () => {
      await page.mouse.move(px, py);
      await page.mouse.down();
      for (let i = 0; i < 180; i += 1) {
        const dx = (i % 60) * 5 * ((Math.floor(i / 60) % 2) * -2 + 1);
        await page.mouse.move(px + dx, py + dx * 0.4);
        await page.waitForTimeout(8);
      }
      await page.mouse.up();
    });
  }

  // Wheel: real wheel zooming at the pointer. At DPR 2 CDP halves the delta, so this is about 2.6x
  // each way, from the overview in.
  if (wants('wheel')) {
    await overview(page);
    await page.mouse.move(w / 2, h / 2);
    trials.wheel = await measure(browser, page, async () => {
      for (let i = 0; i < 120; i += 1) {
        await page.mouse.wheel(0, Math.floor(i / 20) % 2 === 0 ? -60 : 60);
        await page.waitForTimeout(14);
      }
    });
  }

  // Dragging one desk: the hit graph stays live here, so this is the harder case. Konva moves the
  // desk, so nothing marks the camera as moving: count every frame as motion for this one.
  if (wants('deskDrag')) {
    await overview(page);
    await page.waitForTimeout(300);
    const box = await page.getByRole('button', { name: load.drag }).boundingBox();
    const dragX = box.x + box.width / 2;
    const dragY = box.y + box.height - 8;
    await page.evaluate(() => { window.__maDesk.camera.isMoving = () => true; });
    trials.deskDrag = await measure(browser, page, async () => {
      await page.mouse.move(dragX, dragY);
      await page.mouse.down();
      for (let i = 0; i < 120; i += 1) {
        await page.mouse.move(dragX + Math.sin(i / 8) * 120, dragY + Math.cos(i / 8) * 40);
        await page.waitForTimeout(10);
      }
      await page.mouse.up();
    });
    await page.evaluate(() => { delete window.__maDesk.camera.isMoving; });
  }

  // Pushing a chain of desks along a row and back, again and again (ADR 0064): several desks moving at once, and a
  // solve per pointer event. Against a bundle from before that, this same path is just a drag.
  if (wants('deskPush') && load.push) {
    await overview(page);
    await page.waitForTimeout(300);
    const box = await page.getByRole('button', { name: load.push }).boundingBox();
    const fromX = box.x + box.width / 2;
    const fromY = box.y + box.height - 8;
    await page.evaluate(() => { window.__maDesk.camera.isMoving = () => true; });
    trials.deskPush = await measure(browser, page, async () => {
      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      for (let i = 0; i < 120; i += 1) {
        await page.mouse.move(fromX + (1 - Math.cos(i / 8)) * load.pushFar, fromY);
        await page.waitForTimeout(10);
      }
      // Back where it started, so a drop changes nothing and the next trial finds the fixture as it was.
      await page.mouse.move(fromX, fromY, { steps: 6 });
      await page.mouse.up();
    });
    await page.evaluate(() => { delete window.__maDesk.camera.isMoving; });
  }

  // Growing and shrinking one desk by its corner: every frame is a new size. The corner is there only on a
  // desk at least 290 px wide on screen (ADR 0064), and the 24-desk fixture's fit is under that, so zoom to it.
  if (wants('deskResize')) {
    await overview(page);
    await page.evaluate(() => {
      const { camera } = window.__maDesk;
      if (camera.cam.s < 0.62) camera.zoomAt({ x: camera.vp.w / 2, y: camera.vp.h / 2 }, 0.62 / camera.cam.s);
    });
    await page.waitForTimeout(500);
    const box = await page.getByRole('button', { name: load.drag }).boundingBox();
    const cornerX = box.x + box.width - 12;
    const cornerY = box.y + box.height - 12;
    await page.evaluate(() => { window.__maDesk.camera.isMoving = () => true; });
    trials.deskResize = await measure(browser, page, async () => {
      await page.mouse.move(cornerX, cornerY);
      await page.mouse.down();
      for (let i = 0; i < 120; i += 1) {
        await page.mouse.move(cornerX + (1 - Math.cos(i / 8)) * 120, cornerY + (1 - Math.cos(i / 11)) * 60);
        await page.waitForTimeout(10);
      }
      await page.mouse.up();
    });
    await page.evaluate(() => { delete window.__maDesk.camera.isMoving; });
  }

  // Dragging one app around its desk, over its neighbors: a clamp and a move on every pointer event, nothing else.
  const firstApp = page.getByRole('group', { name: load.group }).getByRole('button', { name: /^(Chat|Notebook|Browser|Agent)/ }).first();
  if (wants('appDrag')) {
    await overview(page);
    await page.waitForTimeout(300);
    const box = await firstApp.boundingBox();
    const fromX = box.x + box.width / 2;
    const fromY = box.y + box.height / 2;
    await page.evaluate(() => { window.__maDesk.camera.isMoving = () => true; });
    trials.appDrag = await measure(browser, page, async () => {
      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      for (let i = 0; i < 120; i += 1) {
        await page.mouse.move(fromX + (1 - Math.cos(i / 8)) * 150, fromY + Math.sin(i / 11) * 60);
        await page.waitForTimeout(10);
      }
      await page.mouse.up();
    });
    await page.evaluate(() => { delete window.__maDesk.camera.isMoving; });
  }

  // Resizing one app by its corner: every frame is a new size, and it crosses a detail threshold.
  if (wants('appResize')) {
    await overview(page);
    await page.waitForTimeout(300);
    const box = await firstApp.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(120);
    const fromX = box.x + box.width - 4;
    const fromY = box.y + box.height - 4;
    await page.evaluate(() => { window.__maDesk.camera.isMoving = () => true; });
    trials.appResize = await measure(browser, page, async () => {
      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      for (let i = 0; i < 120; i += 1) {
        await page.mouse.move(fromX + (1 - Math.cos(i / 8)) * 90, fromY + (1 - Math.cos(i / 8)) * 90);
        await page.waitForTimeout(10);
      }
      await page.mouse.up();
    });
    await page.evaluate(() => { delete window.__maDesk.camera.isMoving; });
  }

  // Cleaning up one desk and undoing it, again and again: all its apps gliding together. An app that's been
  // moved is what gives it something to do.
  if (wants('cleanup')) {
    await overview(page);
    await page.waitForTimeout(300);
    const box = await firstApp.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 6, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const group = page.getByRole('group', { name: load.group });
    await page.evaluate(() => { window.__maDesk.camera.isMoving = () => true; });
    trials.cleanup = await measure(browser, page, async () => {
      for (let i = 0; i < 6; i += 1) {
        await group.getByRole('button', { name: /^(Clean up|Undo clean up)/ }).focus();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
      }
    });
    await page.evaluate(() => { delete window.__maDesk.camera.isMoving; });
  }

  const after = await page.evaluate(() => ({ ...window.__maDesk.camera.stats }));
  await ctx.close();

  return {
    fixture, theme, viewport: `${w}x${h}`, dpr, flatGround: flat,
    ...trials,
    dprDrops: after.dprDrops - before.dprDrops,
    loadFirstMs: round(loadFirst, 0),
    loadCachedMs: round(loadCached, 0),
  };
}

/** B2, B4 and B16: what doesn't depend on how many desks there are, or takes the fixture it needs. */
async function runUi(browser, theme, w, h, dpr) {
  const { ctx, page } = await themedPage(browser, theme, w, h, dpr);

  // B2 and B4: clicks. The account menu, and a tile opening its window.
  await page.goto(`${BASE}/?fixture=one`);
  await page.waitForFunction(() => performance.getEntriesByName('ma:first-canvas-paint').length > 0);
  await page.waitForTimeout(800);
  await page.evaluate(INSTRUMENT);
  const menu = page.getByRole('button', { name: 'Account', exact: true });
  for (let i = 0; i < 10; i += 1) {
    await menu.click();
    await page.waitForTimeout(60);
    await menu.click();
    await page.waitForTimeout(60);
  }
  const tile = await page.getByRole('button', { name: /^Notebook/ }).boundingBox();
  for (let i = 0; i < 10; i += 1) {
    await page.mouse.click(tile.x + tile.width / 2, tile.y + tile.height / 2);
    await page.waitForTimeout(320);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(260);
  }
  const { events, opens } = await page.evaluate(() => ({ events: window.__perf.events, opens: window.__perf.opens }));

  // B16: theme switch, the update's own work, with the fixture's sprites to rebuild.
  await page.goto(`${BASE}/?fixture=perf`);
  await page.waitForFunction(() => performance.getEntriesByName('ma:first-canvas-paint').length > 0);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  for (const name of ['Zen', 'Dark', 'Light', 'Zen', 'Dark', 'Light']) {
    await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name, exact: true }).click(); // the Background row is radios too
    await page.waitForTimeout(300);
  }
  const themeSwitch = await page.evaluate(() => performance.getEntriesByName('ma:theme-switch').map((e) => e.duration));
  await ctx.close();

  return {
    theme, viewport: `${w}x${h}`, dpr,
    eventP95: round(pct(events, 0.95)),
    eventP99: round(pct(events, 0.99)),
    eventN: events.length,
    windowOpenFrameP95: round(pct(opens, 0.95)),
    windowOpenN: opens.length,
    themeSwitchP95: round(pct(themeSwitch, 0.95)),
    themeSwitchMax: round(Math.max(...themeSwitch)),
  };
}

/**
 * A Browser window with a live picture beside the canvas. Wheel zooming on the canvas with no window, then
 * with the window open and the test picture playing. The mock draws its picture on the main thread and a real
 * stream decodes off it, so the second number is the harder of the two.
 */
async function runBrowserWindow(browser, theme, w, h, dpr) {
  const { ctx, page } = await themedPage(browser, theme, w, h, dpr);
  await page.goto(`${BASE}/?fixture=one`);
  await page.waitForFunction(() => performance.getEntriesByName('ma:first-canvas-paint').length > 0);
  await page.waitForTimeout(800);
  await page.evaluate(INSTRUMENT);
  const zoom = async () => {
    await page.mouse.move(40, h / 2);
    return measure(browser, page, async () => {
      for (let i = 0; i < 120; i += 1) {
        await page.mouse.wheel(0, Math.floor(i / 20) % 2 === 0 ? -60 : 60);
        await page.waitForTimeout(14);
      }
    });
  };
  const without = await zoom();
  await overview(page); // back to a scale where a tile opens its window, rather than focusing its desk
  await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => el.click());
  await page.getByTestId('browser-video').waitFor();
  await page.getByRole('button', { name: 'Restore window' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="browser-video"]').videoWidth > 0);
  await page.waitForTimeout(400);
  const withVideo = await zoom();
  const videoFrames = await page.getByTestId('browser-video').evaluate((v) => {
    const q = v.getVideoPlaybackQuality();
    return { total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
  });

  // What input handlers cost on the main thread. Dispatch time includes the browser's own event dispatch,
  // so it's an upper bound. `frame` is the once-per-frame write: reading the rect, encoding and sending.
  const input = await page.evaluate(async () => {
    const v = document.querySelector('[data-testid="browser-video"]');
    const keys = document.querySelector('[data-testid="browser-keys"]');
    keys.focus();
    const r = v.getBoundingClientRect();
    const COUNT = 5000;
    const time = (fn) => {
      const a = performance.now();
      for (let i = 0; i < COUNT; i += 1) fn(i);
      return ((performance.now() - a) / COUNT) * 1000;
    };
    const moves = time((i) => v.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: r.x + (i % 100), clientY: r.y + 50, bubbles: true })));
    const down = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true });
    const up = new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true });
    const key = time(() => {
      keys.dispatchEvent(down);
      keys.dispatchEvent(up);
    }) / 2;
    const wheelEvent = new WheelEvent('wheel', { deltaY: 1, clientX: r.x + 50, clientY: r.y + 50, bubbles: true, cancelable: true });
    const wheel = time(() => v.dispatchEvent(wheelEvent));

    const spent = [];
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => {
      const a = performance.now();
      cb(t);
      spent.push(performance.now() - a);
    });
    for (let i = 0; i < 120; i += 1) {
      v.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: r.x + i, clientY: r.y + 50, bubbles: true }));
      await new Promise((done) => raf(done));
    }
    window.requestAnimationFrame = raf;
    spent.sort((a, b) => a - b);
    return { moveUs: moves, keyUs: key, wheelUs: wheel, frameP95Us: spent[Math.floor(spent.length * 0.95)] * 1000, frameMaxUs: spent[spent.length - 1] * 1000 };
  });
  await ctx.close();
  return { theme, viewport: `${w}x${h}`, dpr, without, withVideo, videoFrames, input };
}

const server = spawn(process.execPath, ['harness/serve.mjs', '--dist', DIST, '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch(GPU ? { channel: 'chromium', args: GPU_ARGS } : {});
const rows = [];
const uiRows = [];
const browserRows = [];
let renderer = '';
try {
  for (let trial = 0; trial < TRIALS; trial += 1) {
    for (const theme of THEMES) {
      for (const [w, h, dpr] of CONFIGS) {
        const c = await runControl(browser, w, h, dpr);
        ({ renderer } = c);
        for (const fixture of FIXTURES) {
          const row = { trial, control: c.control, renderer, ...(await runCamera(browser, fixture, theme, w, h, dpr)) };
          rows.push(row);
          console.log(JSON.stringify(row));
        }
        if (ONLY.length) continue;
        const ui = { trial, ...(await runUi(browser, theme, w, h, dpr)) };
        uiRows.push(ui);
        console.log(JSON.stringify(ui));
        const br = { trial, ...(await runBrowserWindow(browser, theme, w, h, dpr)) };
        browserRows.push(br);
        console.log(JSON.stringify(br));
      }
    }
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(`\nMedians over ${TRIALS} trial(s). Renderer: ${renderer}. Budgets are for reference devices; see the note at the top of this file.`);
const cell = (v, width, d = 1) => String(round(v, d)).padStart(width);
for (const theme of THEMES) {
  for (const [w, h, dpr] of CONFIGS) {
    const viewport = `${w}x${h}`;
    for (const fixture of FIXTURES) {
      const rs = rows.filter((r) => r.fixture === fixture && r.theme === theme && r.viewport === viewport && r.dpr === dpr);
      const med = (f) => round(median(rs.map(f)));
      console.log(`\n${LOADS[fixture].label}, ${theme} ${viewport} DPR ${dpr}${rs[0].flatGround ? ' (flat ground)' : ''}, bare-canvas control ${med((r) => r.control)} fps, DPR drops ${med((r) => r.dprDrops)}`);
      for (const k of TRIAL_NAMES.filter((t) => wants(t) && rs[0][t])) {
        console.log(`  B1 ${k.padEnd(12)} ${cell(med((r) => r[k].fps), 5)} fps  dropped ${cell(med((r) => r[k].droppedPct), 5)}%  worst ${cell(med((r) => r[k].worst), 6)} ms (at rest ${cell(med((r) => r[k].worstAtRest), 5)})  main mean ${cell(med((r) => r[k].mainMean), 5)} p95 ${cell(med((r) => r[k].mainP95), 5)} ms  flush mean ${cell(med((r) => r[k].flushMean), 5)} ms  draw p95 ${cell(med((r) => r[k].drawP95), 5)} ms`);
      }
      console.log(`  B15 load to first canvas paint  first ${med((r) => r.loadFirstMs)} ms, cached ${med((r) => r.loadCachedMs)} ms (localhost, no network)`);
    }
    if (ONLY.length) continue;
    const us = uiRows.filter((r) => r.theme === theme && r.viewport === viewport && r.dpr === dpr);
    const med = (f) => round(median(us.map(f)));
    console.log(`\n${theme} ${viewport} DPR ${dpr}, any fixture`);
    console.log(`  B2 input to next paint  p95 ${med((r) => r.eventP95)} ms, p99 ${med((r) => r.eventP99)} ms (Event Timing, entries over 16 ms only, n=${us[0].eventN})`);
    console.log(`  B4 click to window's first frame  p95 ${med((r) => r.windowOpenFrameP95)} ms (n=${us[0].windowOpenN})`);
    console.log(`  B16 theme switch update  p95 ${med((r) => r.themeSwitchP95)} ms, max ${med((r) => r.themeSwitchMax)} ms`);
    const bs = browserRows.filter((r) => r.theme === theme && r.viewport === viewport && r.dpr === dpr);
    const medB = (f) => round(median(bs.map(f)));
    console.log(`  Canvas zoom beside a Browser window  none ${medB((r) => r.without.fps)} fps dropped ${medB((r) => r.without.droppedPct)}% main p95 ${medB((r) => r.without.mainP95)} ms; live picture ${medB((r) => r.withVideo.fps)} fps dropped ${medB((r) => r.withVideo.droppedPct)}% main p95 ${medB((r) => r.withVideo.mainP95)} ms; video frames ${medB((r) => r.videoFrames.total)}, dropped ${medB((r) => r.videoFrames.dropped)}`);
    console.log(`  Input handlers (browser's own dispatch included)  move ${medB((r) => r.input.moveUs)} us, key ${medB((r) => r.input.keyUs)} us, wheel ${medB((r) => r.input.wheelUs)} us each; per-frame write p95 ${medB((r) => r.input.frameP95Us)} us, max ${medB((r) => r.input.frameMaxUs)} us`);
  }
}

mkdirSync('tests/perf/results', { recursive: true });
const out = join('tests/perf/results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({ gpu: GPU, renderer, camera: rows, ui: uiRows, browser: browserRows }, null, 2));
console.log(`\nraw: ${out}`);
