// DANCE: the recording and the frame strip of the package dancing Party, made the way the Product Designer made the
// preview's (preview-dance/tools/video.py and film.py), so the two can be compared frame for frame:
// - dance/party-package.mp4: Dusk, her at 200 px and 64 px side by side, 60 frames a second on a clock driven by hand,
//   at device scale 2 (640x464). Half a second at rest, the dance, then 2.6 s settling into warm. No sound, no metadata.
// - dance/party-strip.png: 24 frames evenly spaced over the dance and 2 s after, at 96 px. The package above, the
//   preview's own video below, at the same frame of each video (both start the dance at frame 30).
// `npm run dance:capture` (after a build) rewrites both. Needs ffmpeg. MAIA_DANCE_PREVIEW names the preview's video.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { barePng, handClock } from './helpers.js';

const OUT = new URL('../../dance/', import.meta.url).pathname;
const PREVIEW = process.env['MAIA_DANCE_PREVIEW'] ?? join(homedir(), 'ma-design-drafts', 'preview-dance', 'dance-2-party.mp4');
const W = 320, H = 232, PRE = 0.5, POST = 2.6, SECONDS = (48 * 60) / 124;
const FRAMES = Math.round((PRE + SECONDS + POST) * 60), START = Math.round(PRE * 60);

test.use({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 2 });
test.setTimeout(15 * 60_000);

const MP4 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '15', '-preset', 'slow', '-an', '-map_metadata', '-1', '-map_chapters', '-1',
  '-fflags', '+bitexact', '-flags:v', '+bitexact', '-metadata', 'creation_time=', '-movflags', '+faststart'];

test('record the package dancing Party, and a strip beside the preview', async ({ page }) => {
  await handClock(page);
  await page.goto('/test.html');
  await page.evaluate(async ({ W, H }) => {
    const w = window as unknown as { M: { createAvatar(c: HTMLCanvasElement, o: object): { playScore(s: object): unknown; playRoutine(n: string): boolean } }; maias: { playRoutine(n: string): boolean }[]; __frame(ms: number): number };
    w.M = await import('/lib/maia-avatar.js' as string);
    const cap = document.createElement('div');
    Object.assign(cap.style, { position: 'fixed', left: '0', top: '0', width: `${W}px`, height: `${H}px`, background: '#444B57', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '24px' });
    w.maias = [200, 64].map((size) => {
      const box = document.createElement('span');
      Object.assign(box.style, { position: 'relative', display: 'block', width: `${size}px`, height: `${size}px`, borderRadius: '50%', overflow: 'hidden', background: '#4F5663', boxShadow: '0 0 0 1px rgba(250, 250, 250, 0.08)' });
      const c = document.createElement('canvas');
      c.style.display = 'block';
      box.append(c);
      cap.append(box);
      const m = w.M.createAvatar(c, { size, theme: 'dusk', reducedMotion: false });
      m.playScore({ v: 1, mood: 'warm', rhythm: 'breath', seconds: 24, beats: [] });
      return m;
    });
    document.body.append(cap);
  }, { W, H });
  await page.waitForTimeout(200); // the observer's first report, on real rendering
  await page.evaluate(() => { for (let i = 0; i < 90; i += 1) (window as unknown as { __frame(ms: number): number }).__frame(1000 / 60); });

  const mp4 = join(OUT, 'party-package.mp4');
  const ff = spawn('nice', ['-n', '15', 'ffmpeg', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', '60', '-i', '-', ...MP4, mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<number>((resolve) => ff.on('close', (code) => resolve(code ?? 1)));
  for (let i = 0; i < FRAMES; i += 1) {
    if (i === START) await page.evaluate(() => { for (const m of (window as unknown as { maias: { playRoutine(n: string): boolean }[] }).maias) m.playRoutine('party'); });
    if (i) await page.evaluate(() => (window as unknown as { __frame(ms: number): number }).__frame(1000 / 60));
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H }, type: 'png' });
    if (!ff.stdin.write(shot)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  expect(await done).toBe(0);

  // The strip: the same 24 moments from both videos, the 200 px Maia cropped out at device scale 2.
  const times = Array.from({ length: 24 }, (_, i) => ((SECONDS + 2) * i) / 24);
  const picks = times.map((t) => START + Math.round(t * 60));
  const tmp = mkdtempSync(join(tmpdir(), 'maia-strip-'));
  try {
    const rows: { label: string; frames: string[] }[] = [];
    for (const [label, video] of [['This package', mp4], ['The preview', PREVIEW]] as const) {
      if (!existsSync(video)) continue;
      const sel = picks.map((n) => `eq(n\\,${n})`).join('+');
      const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', video, '-vf', `select=${sel},crop=400:400:32:32`, '-fps_mode', 'passthrough', join(tmp, `${rows.length}-%02d.png`)]);
      expect(r.status, String(r.stderr)).toBe(0);
      rows.push({ label, frames: picks.map((_, i) => readFileSync(join(tmp, `${rows.length}-${String(i + 1).padStart(2, '0')}.png`)).toString('base64')) });
    }
    const png = await page.evaluate(async ({ rows, times }) => {
      const TILE = 96, GAP = 4, LAB = 14, HEAD = 20, COLS = 12, bpm = 124;
      const block = 2 * (TILE + LAB + GAP);
      const sheet = document.createElement('canvas');
      sheet.width = COLS * (TILE + GAP) + GAP;
      sheet.height = rows.length * (HEAD + block) + GAP;
      const g = sheet.getContext('2d')!;
      g.fillStyle = '#444B57';
      g.fillRect(0, 0, sheet.width, sheet.height);
      g.imageSmoothingQuality = 'high';
      for (let r = 0; r < rows.length; r += 1) {
        const y0 = r * (HEAD + block);
        g.fillStyle = '#FAFAFA';
        g.font = '500 12px sans-serif';
        g.fillText(rows[r]!.label, GAP + 2, y0 + 14);
        for (let i = 0; i < rows[r]!.frames.length; i += 1) {
          // Decoded from bytes, since the page's CSP allows no data: images.
          const img = await createImageBitmap(new Blob([Uint8Array.from(atob(rows[r]!.frames[i]!), (c) => c.charCodeAt(0))], { type: 'image/png' }));
          const x = GAP + (i % COLS) * (TILE + GAP), y = y0 + HEAD + Math.floor(i / COLS) * (TILE + LAB + GAP);
          g.drawImage(img, x, y, TILE, TILE);
          g.fillStyle = '#E2E2E2';
          g.font = '10px sans-serif';
          const t = times[i]!;
          g.fillText(`${t.toFixed(2)} s, beat ${(t * bpm / 60).toFixed(1)}`, x + 2, y + TILE + 11);
        }
      }
      return sheet.toDataURL('image/png');
    }, { rows, times });
    writeFileSync(join(OUT, 'party-strip.png'), barePng(Buffer.from(png.split(',')[1]!, 'base64')));
    console.log(`party-package.mp4, ${FRAMES} frames; party-strip.png, rows: ${rows.map((r) => r.label).join(', ')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
