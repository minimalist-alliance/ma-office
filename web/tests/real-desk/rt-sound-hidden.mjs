// Sound in a hidden tab (task 22, ADR 0038), on the real test desk as desk-1, with this checkout's own bundle in place of
// staging's (`dist/release`, served by page.route at the app's own origin, so sign-in, CSP and the gateway are the real ones).
// Hold ~/work/.test-desk.lock for the whole run. About 20 minutes. Changes nothing on the desk but a page server of its own,
// which it removes, and one tab, which it closes.
//
// 1. Music on a still page in the desk's Browser, the tab hidden for real minutes: past 5 minutes the stream stays live and the
//    sound keeps coming. The music ends; a minute later the stream goes warm, and showing the tab brings the picture back.
// 2. The same with the page's clock run fast (45 s steps, each with a real second for the stats to hear the sound): past 60
//    minutes hidden the session stays open while the music plays; once it stops, the stream goes warm and the session closes.
//    Showing the tab opens it again with `start: false`.
//
// "Hidden" is `document.hidden` and `visibilitychange`, as the app's own specs do: headless Chromium never hides a page, and
// there's no X server here for a headed one. Sound is Chrome's fake output device (`--disable-audio-output`), so nothing plays
// on this machine.
//
//   npm run build:release && node tests/real-desk/rt-sound-hidden.mjs
//   MA_EXPECT_VERSION=2026.11.06-abc1234 node tests/real-desk/rt-sound-hidden.mjs   # staging's own bundle, once it's promoted there
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { ALLOWED, INSTANCE, events, getDesk, log, openSession, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const run = promisify(execFile);
const DIST = new URL('../../dist/release/', import.meta.url).pathname;
const OUT = new URL('../../test-results/real-desk/rt-sound-hidden/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
/** Set: staging's own bundle, which must be this version. Unset: this checkout's `dist/release` in its place. */
const EXPECTED = process.env.MA_EXPECT_VERSION ?? null;
const release = EXPECTED ? { version: EXPECTED, entry: null } : JSON.parse(readFileSync(`${DIST}ma-release.json`, 'utf8'));
const PORT = 18769; // stream.spec 18765, browser-session 18766, W3 18767, av-sync 18768
const DIR = '/var/tmp/ma-sound22';
const UNIT = 'ma-sound22-pages';
const page = (secs) => `http://127.0.0.1:${PORT}/music.html?s=${secs}`;
/** `SOUND_PARTS=2` runs only the fast-clock part. */
const PARTS = new Set((process.env.SOUND_PARTS ?? '1,2').split(','));

/** A still page that plays an arpeggio for `s` seconds after a click, then stops, as a music player at the end of a playlist. */
const MUSIC_HTML = `<!doctype html><meta charset="utf-8"><title>Mready</title>
<style>html,body{margin:0;height:100%;background:#20242a;color:#cfd3da;font:40px sans-serif;display:flex;align-items:center;justify-content:center}</style>
<body><p id="t">Click to play</p><script>
const secs = Number(new URLSearchParams(location.search).get('s') || 300), t = document.getElementById('t');
const notes = [261.63, 329.63, 392, 523.25, 392, 329.63, 293.66, 349.23];
let ctx = null, end = 0;
const pub = () => {
  const left = ctx ? Math.max(0, Math.ceil((end - performance.now()) / 1000)) : -1;
  document.title = left > 0 ? 'Mplay ' + left : left === 0 ? 'Mdone' : 'Mready';
  t.textContent = left > 0 ? 'Playing, ' + left + ' s left' : left === 0 ? 'Done' : 'Click to play';
};
addEventListener('click', () => {
  if (ctx) ctx.close();
  ctx = new AudioContext();
  end = performance.now() + secs * 1000;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = 'triangle';
  const t0 = ctx.currentTime + 0.05;
  for (let i = 0; i * 0.25 < secs; i++) {
    osc.frequency.setValueAtTime(notes[i % notes.length], t0 + i * 0.25);
    gain.gain.setValueAtTime(0.25, t0 + i * 0.25);
    gain.gain.linearRampToValueAtTime(0.08, t0 + i * 0.25 + 0.22);
  }
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + secs);
  osc.onended = () => { ctx.close(); pub(); };
  pub();
}, true);
setInterval(pub, 1000);
pub();
</script></body>`;

// ----- the desk, over SSM: only the test desk, and only this run's own files and unit

async function deskRun(command, timeoutS = 90) {
  const env = { ...process.env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' };
  const aws = async (...a) => (await run('aws', a, { encoding: 'utf8', env, maxBuffer: 16 << 20 })).stdout;
  const id = (await aws('ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--parameters', JSON.stringify({ commands: [command] }), '--query', 'Command.CommandId', '--output', 'text')).trim();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    await wait(800);
    let inv;
    try {
      inv = JSON.parse(await aws('ssm', 'get-command-invocation', '--command-id', id, '--instance-id', INSTANCE, '--output', 'json'));
    } catch {
      continue;
    }
    if (inv.Status === 'Success') return inv.StandardOutputContent;
    if (['Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) throw new Error(`ssm ${inv.Status}: ${inv.StandardErrorContent.slice(0, 300)}`);
  }
  throw new Error('ssm timed out');
}

const versions = async () =>
  (await deskRun(`for c in desk-rtc desk-stream deskd; do echo "$c=$(basename "$(readlink -f /opt/ma/$c/current)")"; done; echo "image=$(grep '^version=' /etc/ma-release | cut -d= -f2)"`)).trim().replace(/\n/g, ' ');
const health = async () => {
  const out = await deskRun(`curl -s -m 3 --unix-socket /run/desk/deskd-admin.sock http://desk/health`);
  try {
    const h = JSON.parse(out);
    return { stream: h.stream ?? null, clients: h.clients ?? null };
  } catch {
    return { stream: null };
  }
};

async function deployPage() {
  const out = await deskRun(`set -e
systemctl stop ${UNIT} 2>/dev/null || true; systemctl reset-failed ${UNIT} 2>/dev/null || true
rm -rf ${DIR}; install -d -m 755 ${DIR}
echo ${Buffer.from(MUSIC_HTML).toString('base64')} | base64 -d > ${DIR}/music.html; chmod 644 ${DIR}/music.html
systemd-run --quiet --collect --unit=${UNIT} --uid=65534 --gid=65534 -p RuntimeMaxSec=3600 /usr/bin/python3 -I -m http.server ${PORT} --bind 127.0.0.1 --directory ${DIR}
sleep 1
curl -s -m 3 -o /dev/null -w 'HTTP=%{http_code}' http://127.0.0.1:${PORT}/music.html`);
  if (!out.includes('HTTP=200')) throw new Error(`the page server didn't answer: ${out.slice(0, 120)}`);
}
const removePage = () => deskRun(`systemctl stop ${UNIT} 2>/dev/null || true; systemctl reset-failed ${UNIT} 2>/dev/null || true; rm -rf ${DIR}; echo removed`);

// ----- the client

/** Records what the app sends as `browser.stream.set`, its PeerConnections, and lets the test hide the page. Changes nothing else. */
function clientProbe() {
  const w = window;
  const t22 = (w.__t22 = { pcs: [], sets: [], hidden: undefined });
  const Native = w.RTCPeerConnection;
  w.RTCPeerConnection = class extends Native {
    constructor(c) {
      super(c);
      t22.pcs.push(this);
    }
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function sendAndNote(d) {
    try {
      if (this.label === 'rpc' && d && d.byteLength < 4096) {
        const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        const m = /"m":"browser\.stream\.set","p":\{"state":"(\w+)"/.exec(new TextDecoder().decode(bytes));
        if (m) t22.sets.push(m[1]);
      }
    } catch {
      /* never in the way */
    }
    return send.call(this, d);
  };
  t22.hide = (h) => {
    if (t22.hidden === undefined) Object.defineProperty(document, 'hidden', { configurable: true, get: () => t22.hidden });
    t22.hidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  t22.stats = async () => {
    const pc = t22.pcs.filter((p) => p.connectionState !== 'closed').pop();
    const none = { packets: 0, bytes: 0, energy: 0, frames: 0 };
    if (!pc) return { open: false, audio: none, video: none };
    const out = { open: pc.connectionState === 'connected', audio: none, video: none };
    (await pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp') out[r.kind] = { packets: r.packetsReceived ?? 0, bytes: r.bytesReceived ?? 0, energy: r.totalAudioEnergy ?? 0, frames: r.framesDecoded ?? 0 };
    });
    return out;
  };
}

const failures = [];
const step = (name, ok, text) => {
  if (!ok) failures.push(name);
  log(`STEP ${name} ${ok ? 'PASS' : 'FAIL'} ${text}`);
};
const report = { bundle: release.version, steps: [] };
const note = (k, v) => {
  report[k] = v;
  writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
};
const until = async (fn, ms, every = 250) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await wait(every);
  }
};

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 35 * 60 * 1000);
watchdog.unref();

log('bundle', release.version, 'versions on the desk:', await versions().catch((e) => `unread: ${e.message.slice(0, 80)}`));
note('deskBefore', await versions().catch(() => null));
await deployPage();
S.afterClose = async () => {
  log('page server', (await removePage().catch((e) => e.message.slice(0, 80))).trim());
  note('deskAfter', await versions().catch(() => null));
};

await openSession({
  browserKind: 'full',
  launchArgs: ['--disable-audio-output'],
  onContext: async (ctx) => {
    await ctx.clock.install();
    await ctx.addInitScript(clientProbe);
    // This checkout's bundle in place of the one staging names, at the same paths, so nothing else about the page changes.
    if (EXPECTED) return;
    await ctx.route(/\/v\/[^/]+\/ma-release\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(release) }));
    await ctx.route(/\/v\/[^/]+\/assets\/[^/?]+/, (route) => {
      const file = `${DIST}assets/${new URL(route.request().url()).pathname.split('/').pop()}`;
      return existsSync(file) ? route.fulfill({ path: file, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } }) : route.continue();
    });
  },
});
const p = S.page;
const stats = () => p.evaluate(() => window.__t22.stats());
const sets = () => p.evaluate(() => window.__t22.sets.slice());
const hide = (h) => p.evaluate((x) => window.__t22.hide(x), h);
const ff = (mmss) => p.clock.fastForward(mmss);

const btn = p.locator(`#proxy-${ALLOWED}`);
await btn.waitFor({ state: 'attached', timeout: 60_000 });
const desk = await getDesk();
if (desk.state !== 'running') {
  log(`STOP: the desk is ${desk.state}`);
  await shutdown(1, 'desk not running');
}
const loaded = await p.evaluate(() => [...document.querySelectorAll('script[type="module"]')].map((e) => e.src).find((n) => /\/assets\//.test(n)) ?? null);
step('0 bundle', EXPECTED ? Boolean(loaded?.includes(`/v/${EXPECTED}/`)) : Boolean(loaded?.endsWith(release.entry.split('/').pop())), EXPECTED ? `staging's ${loaded}` : `this checkout's ${release.version} (${release.entry})`);

await btn.focus();
await p.keyboard.press('Enter');
await waitPanel(/online/, 60_000);
const proxy = p.locator(`[id="proxy-${ALLOWED}:browser"]`);
await proxy.focus();
await p.keyboard.press('Enter');
await p.getByRole('dialog', { name: 'Browser' }).first().waitFor({ state: 'visible', timeout: 10_000 });
const video = p.locator('video.br-video');
const frames = () => video.evaluate((v) => v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0);
step('1 picture', Boolean(await until(async () => (await frames()) > 0, 45_000)), `frames ${await frames()}`);
/** Sound from the desk over 2 s, as the client hears it: anything playing there that this run didn't start shows here. */
const desksSound = async () => {
  const a = await stats();
  await wait(2000);
  const b = await stats();
  return +(b.audio.energy - a.audio.energy).toFixed(4);
};

const tablist = p.getByRole('group', { name: 'Tabs on this desk' });
const titles = async () => (await tablist.innerText().catch(() => '')).replace(/\s+/g, ' ');
const address = p.getByTestId('browser-address');
log('tabs at the start', JSON.stringify(await until(async () => (await titles()) || null, 15_000)), 'sound before', await desksSound());

/** The music page in a new tab of its own, started by a click in the picture, as a member would. */
async function startMusic(secs, label) {
  if (!/Mready|Mplay|Mdone/.test(await titles())) {
    await p.getByRole('button', { name: 'New tab', exact: true }).click();
    await wait(1500);
  }
  await address.click();
  await address.fill(page(secs));
  await p.keyboard.press('Enter');
  await until(async () => /Mready/.test(await titles()), 20_000);
  await wait(1500);
  const box = await video.boundingBox();
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const playing = await until(async () => /Mplay/.test(await titles()), 10_000);
  const a = await stats();
  await wait(2000);
  const b = await stats();
  step(`${label} sound`, Boolean(playing) && b.audio.energy > a.audio.energy, `page says ${JSON.stringify((await titles()).match(/M\w+( \d+)?/)?.[0])}; energy at the client ${a.audio.energy.toFixed(3)} then ${b.audio.energy.toFixed(3)}`);
  await shot(OUT, `${label}-playing`);
}

// ----- 1: real minutes
if (PARTS.has('1')) {
  await startMusic(400, '2');
  const startedAt = Date.now();
  await hide(true);
  const hiddenAt = Date.now();
  const setsAtHide = (await sets()).length;
  const samples = [];
  let prev = await stats();
  while (Date.now() - hiddenAt < 5 * 60_000 + 40_000) {
    await wait(20_000);
    const s = await stats();
    const dt = (Date.now() - (samples.at(-1)?.at ?? hiddenAt)) / 1000;
    samples.push({ at: Date.now(), hiddenS: Math.round((Date.now() - hiddenAt) / 1000), audioPkts: s.audio.packets - prev.audio.packets, audioKbps: Math.round(((s.audio.bytes - prev.audio.bytes) * 8) / dt / 1000), videoKbps: Math.round(((s.video.bytes - prev.video.bytes) * 8) / dt / 1000), energy: +(s.audio.energy - prev.audio.energy).toFixed(4) });
    prev = s;
    log('hidden', JSON.stringify(samples.at(-1)));
  }
  const after5 = (await sets()).slice(setsAtHide);
  const h5 = await health();
  const lastTwo = samples.slice(-2);
  step('3 past 5 minutes', !after5.includes('warm') && lastTwo.every((x) => x.audioPkts > 0 && x.energy > 0) && h5.stream?.wanted === 'live', `hidden ${samples.at(-1).hiddenS} s: sent since hiding ${JSON.stringify(after5)}; desk wants ${h5.stream?.wanted}, desk-rtc ${h5.stream?.rtc}; last samples ${JSON.stringify(lastTwo)}`);
  note('hiddenSamples', samples);

  // The music ends 400 s after its click; a minute later the stream goes warm.
  const done = await until(async () => /Mdone/.test(await titles()), 400_000 - (Date.now() - startedAt) + 30_000, 1000);
  const doneAt = Date.now();
  log('music done', Boolean(done), `${Math.round((doneAt - startedAt) / 1000)} s after the click`);
  const warm = await until(async () => (await sets()).slice(setsAtHide).includes('warm'), 100_000, 500);
  const warmAfter = Math.round((Date.now() - doneAt) / 1000);
  const quiet1 = await stats();
  await wait(5000);
  const quiet2 = await stats();
  const hw = await health();
  step('4 quiet a minute: warm', Boolean(done && warm) && warmAfter >= 55 && warmAfter <= 75 && quiet2.video.packets === quiet1.video.packets && quiet2.audio.packets === quiet1.audio.packets && hw.stream?.wanted === 'warm', `warm ${warmAfter} s after the music ended; packets in 5 s after: video ${quiet2.video.packets - quiet1.video.packets}, audio ${quiet2.audio.packets - quiet1.audio.packets}; desk wants ${hw.stream?.wanted}`);

  const f0 = await frames();
  const back0 = Date.now();
  await hide(false);
  const backed = await until(async () => (await frames()) > f0, 10_000, 10);
  const backMs = Date.now() - back0;
  step('5 back: picture', Boolean(backed), `first new frame ${backMs} ms after the tab showed again; sent ${JSON.stringify((await sets()).slice(setsAtHide))}`);
  note('part1', { warmAfterS: warmAfter, backMs, samples: samples.length });
  await shot(OUT, 'back');

}

// ----- 2: past 60 minutes, on a fast clock
if (PARTS.has('2')) {
  await startMusic(170, '6');
  await hide(true);
  const setsAtHide2 = (await sets()).length;
  let fake = 0;
  const fastStart = Date.now();
  while (fake < 62 * 60) {
    await ff('00:45');
    fake += 45;
    await wait(1000);
  }
  const fast = await stats();
  await wait(2000);
  const fast2 = await stats();
  const h60 = await health();
  const sent60 = (await sets()).slice(setsAtHide2);
  step('7 past 60 minutes', fast2.open && fast2.audio.packets > fast.audio.packets && fast2.audio.energy > fast.audio.energy && !sent60.includes('warm') && h60.stream?.wanted === 'live', `${fake / 60} fake minutes hidden in ${Math.round((Date.now() - fastStart) / 1000)} s: session open ${fast2.open}, audio ${fast2.audio.packets - fast.audio.packets} packets in 2 s, sent ${JSON.stringify(sent60)}; desk wants ${h60.stream?.wanted}`);

  const done2 = await until(async () => /Mdone/.test(await titles()), 170_000, 1000);
  await wait(3000); // the stats hear the silence
  await ff('00:45');
  await wait(1000);
  const stillLive = !(await sets()).slice(setsAtHide2).includes('warm');
  await ff('00:30');
  const warm2 = await until(async () => (await sets()).slice(setsAtHide2).includes('warm'), 10_000);
  await ff('01:00');
  await wait(1000);
  await ff('01:00');
  const closed = await until(async () => !(await stats()).open, 15_000);
  step('8 quiet: warm, then closed', Boolean(done2) && stillLive && Boolean(warm2) && Boolean(closed), `music done ${Boolean(done2)}; live at 45 s ${stillLive}; warm by 75 s ${Boolean(warm2)}; session closed ${Boolean(closed)}`);

  const c0 = events.filter((e) => e.k === 'api.req' && e.action === 'connect').length;
  // A new session's picture: the element gets the new session's stream, and then a frame of it. Its frame count starts again with a
  // new stream, and the page's fake clock keeps performance marks from being read, so neither can say.
  await p.evaluate(() => {
    window.__t22.oldSrc = document.querySelector('video.br-video')?.srcObject ?? null;
  });
  const back2 = Date.now();
  await hide(false);
  const reopened = await p
    .evaluate(
      () =>
        new Promise((done) => {
          const end = performance.now() + 30_000;
          const look = () => {
            const v = document.querySelector('video.br-video');
            if (v?.srcObject && v.srcObject !== window.__t22.oldSrc) v.requestVideoFrameCallback(() => done(true));
            else if (performance.now() > end) done(false);
            else setTimeout(look, 20);
          };
          look();
        }),
    )
    .catch(() => false);
  const reopenMs = Date.now() - back2;
  const g0 = await frames();
  const moving = await until(async () => (await frames()) > g0, 10_000, 50);
  const connects = events.filter((e) => e.k === 'api.req' && e.action === 'connect').slice(c0);
  step('9 back: reopened', Boolean(reopened && moving) && connects.length > 0 && connects.every((e) => e.start === false), `a new session's first frame ${reopened ? `${reopenMs} ms` : 'never'} after the tab showed, frames moving ${Boolean(moving)}; ${connects.length} connect(s), start ${JSON.stringify([...new Set(connects.map((e) => e.start))])}`);
  note('part2', { reopenMs: reopened ? reopenMs : null });
  await shot(OUT, 'reopened');

}

// ----- leave the desk as it was: close the music tab, then the window
const musicTab = tablist.locator('.br-tab', { hasText: /Mready|Mplay|Mdone/ });
if (await musicTab.count()) {
  await musicTab.first().getByRole('button', { name: /^Close / }).click({ timeout: 5000 }).catch((e) => log('close tab failed', e.message.slice(0, 80)));
  await wait(1500);
}
const after = await desksSound();
step('11 quiet after', after === 0, `tabs left ${JSON.stringify(await titles())}; sound from the desk over 2 s: ${after}`);
await p.keyboard.press('Escape');
await p.getByRole('button', { name: 'Close Browser' }).click({ timeout: 4000 }).catch(() => undefined);
await wait(1000);

const problems = events.filter((e) => e.k === 'console').length;
step('10 console', problems === 0, `console problems ${problems}`);
note('failures', failures);
log(failures.length ? `${failures.length} FAILED: ${failures.join(', ')}` : 'ALL PASS');
await shutdown(failures.length ? 1 : 0, 'done');
