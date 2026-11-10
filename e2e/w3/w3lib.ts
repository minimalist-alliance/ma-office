// W3's shared parts: what it's told, the guard around the desk, and the driving of the real Browser window. Sign-in, the page hooks
// and the percentiles are lib.ts' and streamlib.ts'. Their SSM and client code is fixed to one instance and one desk id, so what needs
// another desk is here, doing the same things in the same way (deskCpu, deskUnits, the probe in page2.js).
import { execFile, execFileSync } from 'node:child_process';
import { cpus, homedir, loadavg } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { generate } from 'otplib';
import { APP, INIT_SCRIPT, REGION, loadUser, type TestUser, type Watch } from '../tests/lib';
import { pct, sleep, type CpuSample } from '../tests/streamlib';

const run = promisify(execFile);

export const W3_ON = !!process.env.W3_DESK;
export const W3_SKIP = 'W3_DESK is not set. This harness runs only when asked: see README.md in this folder.';

/** The crops, in device pixels, the same on both desks. */
export const CROP = { w: 720, h: 400 };
/** Longer than the 4 s between keyframes (stream.conf), so a still page has been sent whole since it last changed. */
export const SETTLE_MS = 6000;

// test.office. is desk-1's handle: the API refuses every other account there (desk_host_forbidden, contract desks.md), so a desk on another
// account can only be reached through office., as a member's is. The same app build and the same API answer on both.
const STAGING_APPS = ['https://office.staging.minimalistalliance.com', APP];

export interface W3Input { url: string; label: string; userPath: string; deskId: string | null; expectScreen: string | null; out: string; runs: number; trials: number; video: string; only: string[] | null; allowBusy: boolean; level: string | null }

export function w3Input(): W3Input {
  const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required: see README.md in this folder`); return v; };
  const url = need('W3_DESK');
  if (!STAGING_APPS.includes(new URL(url).origin)) throw new Error(`W3_DESK must be one of ${STAGING_APPS.join(', ')} (test accounts on staging only), not ${new URL(url).origin}`);
  const label = need('W3_LABEL');
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('W3_LABEL: letters, digits, dot, dash and underscore only');
  const userPath = need('W3_USER_SSM');
  if (!/^\/ma\/staging\/test-users\/[A-Za-z0-9_-]+$/.test(userPath)) throw new Error('W3_USER_SSM must be /ma/staging/test-users/<name>');
  const deskId = process.env.W3_DESK_ID ?? null;
  if (deskId && !/^d-[a-z0-9]+$/.test(deskId)) throw new Error('W3_DESK_ID looks wrong');
  const expectScreen = process.env.W3_EXPECT_SCREEN ?? null;
  if (expectScreen && !/^\d+x\d+$/.test(expectScreen)) throw new Error('W3_EXPECT_SCREEN looks like 1280x800');
  const runs = Number(process.env.W3_RUNS ?? 3);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('W3_RUNS: a whole number');
  if (process.env.W3_LEVEL && !['low', 'medium', 'high', 'max'].includes(process.env.W3_LEVEL)) throw new Error('W3_LEVEL: low, medium, high or max');
  const video = process.env.W3_VIDEO ?? 'gen';
  if (video !== 'gen' && video !== 'off' && !/^https:\/\/[^\s']+$/.test(video)) throw new Error('W3_VIDEO: gen, off or an https url');
  return { url, label, userPath, deskId, expectScreen, out: process.env.W3_OUT ?? join(homedir(), 'ma-design-drafts', 'w3'), runs, trials: Number(process.env.W3_TRIALS ?? 60), video, only: process.env.W3_SCENARIOS?.split(',') ?? null, allowBusy: process.env.W3_ALLOW_BUSY === '1', level: process.env.W3_LEVEL ?? null };
}

export const loadW3User = (i: W3Input): TestUser => loadUser(basename(i.userPath));

// lib.ts' signInApp and managedLogin, with the origin as an argument: lib.ts is fixed to test.office. and is the gate's. Secrets only go through fill().
let lastTotpWindow = 0;
export async function signIn(context: BrowserContext, page: Page, u: TestUser, app: string): Promise<void> {
  const origin = new URL(app).origin;
  const onOwnPages = () => new URL(page.url()).pathname.startsWith('/_signin/');
  await context.addInitScript(INIT_SCRIPT);
  await page.goto(origin);
  const start = page.getByRole('button', { name: 'Sign in', exact: true });
  await start.waitFor({ timeout: 30_000 });
  await start.click();
  await page.waitForURL(/\/(login|oauth2\/authorize|_signin\/)/, { timeout: 30_000 });
  if (onOwnPages()) {
    const email = page.locator('#email');
    await email.waitFor({ timeout: 30_000 });
    if ((await email.inputValue()) !== u.email) await email.fill(u.email);
    await page.locator('#password').fill(u.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  } else {
    const user = page.getByLabel(/email|username/i).first();
    await user.waitFor({ timeout: 30_000 });
    await user.fill(u.email);
    const pass = page.getByLabel(/^password$/i).first();
    if (!(await pass.isVisible().catch(() => false))) await page.getByRole('button', { name: /^(next|continue)$/i }).click();
    await pass.fill(u.password);
    await page.getByRole('button', { name: /^(sign in|log in|continue|next)$/i }).click();
  }
  const field = page.getByLabel(/code/i).first();
  await field.waitFor({ timeout: 30_000 });
  let accepted = false;
  // Cognito refuses a code it has seen, and other sessions sign in on staging too, so allow a third window.
  for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
    let win = Math.floor(Date.now() / 30_000);
    const left = 30 - (Math.floor(Date.now() / 1000) % 30);
    if (win <= lastTotpWindow || left < 4) { await page.waitForTimeout((left + 1) * 1000); win = Math.floor(Date.now() / 30_000); }
    lastTotpWindow = win;
    await field.fill(await generate({ secret: u.totpSecret }));
    if (!onOwnPages()) await page.getByRole('button', { name: /^(sign in|verify|confirm|next|continue|submit)$/i }).click();
    accepted = await page.waitForURL((url) => !url.pathname.includes('/mfa') && !url.pathname.startsWith('/_signin/'), { timeout: 12_000 }).then(() => true, () => false);
  }
  if (!accepted) throw new Error('sign-in: the TOTP code was refused three times');
  await page.waitForURL((url) => url.origin === origin, { timeout: 45_000 });
}
export const clientLoad = () => ({ cores: cpus().length, loadavg1m: +loadavg()[0].toFixed(2), uptime: execFileSync('uptime', { encoding: 'utf8' }).trim() });

async function aws(...args: string[]): Promise<string> {
  const { stdout } = await run('aws', args, { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION } });
  return stdout;
}

// The owner's desk, refused by name as well as by its tags. W3 never goes near it.
// Desks a test must never touch (the production desks), from the environment: comma-separated desk and instance IDs.
const PROTECTED = new Set((process.env['W3_PROTECTED'] ?? '').split(',').map((x) => x.trim()).filter(Boolean));

/** A desk the tags say is a staging test desk. The only way to get one is resolve(), and the only way to reach a desk is through one. */
export class TestDesk {
  private constructor(readonly instance: string, readonly deskId: string, readonly type: string, readonly ami: string, readonly az: string, readonly tags: Record<string, string>) {}

  static async resolve(deskId: string): Promise<TestDesk> {
    if (PROTECTED.has(deskId)) throw new Error("that's a protected desk");
    const found = JSON.parse(await aws('ec2', 'describe-instances', '--filters', `Name=tag:DeskId,Values=${deskId}`, 'Name=instance-state-name,Values=pending,running,stopping,stopped', '--query', 'Reservations[].Instances[]', '--output', 'json'));
    if (found.length !== 1) throw new Error(`${found.length} instances carry DeskId=${deskId}`);
    const i = found[0];
    const tags: Record<string, string> = Object.fromEntries((i.Tags ?? []).map((t: { Key: string; Value: string }) => [t.Key, t.Value]));
    if (PROTECTED.has(i.InstanceId)) throw new Error("that's a protected desk");
    if (tags.DeskKind !== 'test') throw new Error(`${i.InstanceId} has DeskKind=${tags.DeskKind}: W3 only runs on DeskKind=test`);
    if (tags.Env !== 'staging') throw new Error(`${i.InstanceId} has Env=${tags.Env}: W3 only runs on staging`);
    if (i.State.Name !== 'running') throw new Error(`${i.InstanceId} is ${i.State.Name}: ask Platform to start it`);
    return new TestDesk(i.InstanceId, deskId, i.InstanceType, i.ImageId, i.Placement.AvailabilityZone, tags);
  }

  /** A shell command over SSM, without blocking the event loop. Everything W3 does to a desk goes through here. */
  async run(command: string, timeoutS = 90): Promise<string> {
    const id = (await aws('ssm', 'send-command', '--instance-ids', this.instance, '--document-name', 'AWS-RunShellScript', '--parameters', JSON.stringify({ commands: [command] }), '--query', 'Command.CommandId', '--output', 'text')).trim();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutS * 1000) {
      await sleep(700);
      let inv: { Status: string; StandardOutputContent: string; StandardErrorContent: string };
      try { inv = JSON.parse(await aws('ssm', 'get-command-invocation', '--command-id', id, '--instance-id', this.instance, '--output', 'json')); } catch { continue; }
      if (inv.Status === 'Success') return inv.StandardOutputContent;
      if (['Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) throw new Error(`ssm ${inv.Status}: ${inv.StandardErrorContent.slice(0, 300)}`);
    }
    throw new Error('ssm command timed out');
  }

  /** Versions, screen and what would change a number. Read only. */
  async info(): Promise<Record<string, string>> {
    const out = await this.run([
      `for c in desk-rtc desk-stream deskd; do echo "$c=$(basename "$(readlink -f /opt/ma/$c/current)")"; done`,
      `echo "image=$(grep '^version=' /etc/ma-release | cut -d= -f2)"`,
      `echo "bootedAt=$(uptime -s)"; echo "vcpus=$(nproc)"; echo "memMiB=$(free -m | awk '/^Mem:/{print $2}')"`,
      `echo "chromium=$(dpkg-query -W -f='\${Version}' chromium)"`,
      `echo "streamConf=$(sha256sum /opt/ma/desk-stream/current/stream.conf | cut -c1-16)"; echo "x264=$(grep '^x264' /opt/ma/desk-stream/current/stream.conf)"; echo "convert=$(grep '^convert' /opt/ma/desk-stream/current/stream.conf)"`,
      `echo "fontsJa=$(fc-list :lang=ja 2>/dev/null | wc -l)"; echo "fontsAr=$(fc-list :lang=ar 2>/dev/null | wc -l)"`,
      `cd /tmp; echo "xrandr=$(DISPLAY=:99 runuser -u stream -- xrandr --current 2>/dev/null | head -1)"`,
      `win=$(DISPLAY=:99 runuser -u stream -- xdotool search --onlyvisible --classname /data/browser/profile 2>/dev/null | head -1); [ -n "$win" ] && echo "window=$(DISPLAY=:99 runuser -u stream -- xdotool getwindowgeometry --shell "$win" | tr '\\n' ' ')"`,
      `echo "xorgConf=$(grep -E 'Virtual|Modes' /etc/ma/xorg-dummy.conf | tr -s ' ' | tr '\\n' ';')"; echo "browserStart=$(grep -m1 -E '^W=' /usr/local/lib/ma/desk-browser-start)"; true`,
    ].join('\n'));
    return Object.fromEntries(out.trim().split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  }

  /** deskd's own lines for its last stream changes. They hold timings and no page content. */
  async streamTimings(): Promise<string[]> {
    const out = await this.run(`journalctl -u deskd --no-pager -o short-iso | grep 'browser.stream.set timing' | cut -c1-240 | tail -6; true`);
    return out.trim().split('\n').filter(Boolean);
  }

  /** As streamlib's deskUnits. */
  async units(): Promise<{ units: Record<string, { active: string; pid: number }>; stream: { wanted?: string; rtc?: string } | null; healthStatus: string | null }> {
    const out = await this.run(`for u in desk-stream desk-browser desk-xorg desk-audio desk-rtc deskd; do echo "U $u $(systemctl is-active $u) $(systemctl show -p MainPID --value $u)"; done; echo "H $(curl -s -m 3 --unix-socket /run/desk/deskd-admin.sock http://desk/health)"`);
    const units: Record<string, { active: string; pid: number }> = {};
    let health: { stream?: { wanted?: string; rtc?: string }; status?: string } = {};
    for (const line of out.split('\n')) {
      const [tag, a, b, c] = line.split(' ');
      if (tag === 'U') units[a] = { active: b, pid: Number(c) };
      if (tag === 'H') { try { health = JSON.parse(line.slice(2)); } catch { /* deskd isn't answering */ } }
    }
    return { units, stream: health.stream ?? null, healthStatus: health.status ?? null };
  }

  /** As streamlib's deskCpu, whose result cpuBetween reads. */
  async cpu(): Promise<CpuSample> {
    const names = ['desk-stream', 'desk-browser', 'deskd', 'desk-rtc', 'desk-xorg', 'desk-audio'];
    const out = await this.run(`date +%s.%N; head -1 /proc/stat; for u in ${names.join(' ')}; do systemctl show -p CPUUsageNSec --value $u; done; ` +
      `grep '^Udp:' /proc/net/snmp; dev=$(ip -o route get 1.1.1.1 | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p'); ethtool -S "$dev" 2>/dev/null | grep -E 'allowance_exceeded' | sed 's/^ */NIC /'; tc -s qdisc show dev "$dev" 2>/dev/null | grep -oE 'dropped [0-9]+' | sed 's/^/QDISC /'`);
    const lines = out.trim().split('\n');
    const f = lines[1].trim().split(/\s+/).slice(1).map(Number);
    const units: Record<string, number> = {};
    names.forEach((n, i) => { const v = Number(lines[2 + i]); if (Number.isFinite(v)) units[n] = v; });
    const nic: Record<string, number> = {};
    for (const l of lines) {
      const m = /^NIC (\S+): (\d+)/.exec(l); if (m) nic[m[1]] = Number(m[2]);
      const q = /^QDISC dropped (\d+)/.exec(l); if (q) nic.qdiscDropped = (nic.qdiscDropped ?? 0) + Number(q[1]);
    }
    const rows = lines.filter((l) => l.startsWith('Udp:')).map((l) => l.split(/\s+/).slice(1));
    const udp = rows.length < 2 ? {} : Object.fromEntries(rows[0].map((k, i) => [k, Number(rows[1][i])]));
    return { at: Number(lines[0]), total: f.reduce((a, b) => a + b, 0), idle: f[3] + f[4], units, udp, nic };
  }

  /** Only burstable types answer. Best effort: this is context for a number, and never a reason to stop. */
  async credits(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    // AWS answers `standard` for a type that has no credits at all (seen for c7g.large), which numbers.md would print as a credit mode.
    if (!/^t\d/.test(this.type)) return { specification: null };
    try { out.specification = JSON.parse(await aws('ec2', 'describe-instance-credit-specifications', '--instance-ids', this.instance, '--query', 'InstanceCreditSpecifications[0].CpuCredits', '--output', 'json')); } catch { out.specification = null; }
    const end = new Date();
    const start = new Date(end.getTime() - 15 * 60_000);
    for (const metric of ['CPUCreditBalance', 'CPUSurplusCreditBalance']) {
      try {
        const r = JSON.parse(await aws('cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/EC2', '--metric-name', metric, '--dimensions', `Name=InstanceId,Value=${this.instance}`, '--start-time', start.toISOString(), '--end-time', end.toISOString(), '--period', '300', '--statistics', 'Average', '--output', 'json'));
        const points = (r.Datapoints ?? []).sort((a: { Timestamp: string }, b: { Timestamp: string }) => a.Timestamp.localeCompare(b.Timestamp));
        out[metric] = points.length ? points[points.length - 1].Average : null;
      } catch { out[metric] = null; }
    }
    return out;
  }
}

/** The account's desk by id if W3_DESK_ID says, or the only one it has. Never by position. */
export async function pickDesk(page: Page, w: Watch, i: W3Input): Promise<string> {
  await expect.poll(() => w.desks.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const d = i.deskId ? w.desks.find((x) => x.deskId === i.deskId) : w.desks.length === 1 ? w.desks[0] : null;
  if (!d) throw new Error(i.deskId ? `${i.deskId} is not in this account's list (${w.desks.length} desks)` : `this account has ${w.desks.length} desks: set W3_DESK_ID`);
  await page.locator('.ma-shell').waitFor({ timeout: 30_000 });
  return d.deskId;
}

/** The app build, from the path it loads from (/v/<version>/). Both desks should read the same. */
export const appVersion = (page: Page): Promise<string | null> => page.evaluate(() => {
  const src = [...document.querySelectorAll('script[src],link[href]')].map((e) => (e as HTMLScriptElement).src || (e as HTMLLinkElement).href).find((s) => /\/v\/[^/]+\//.test(s));
  return src ? /\/v\/([^/]+)\//.exec(src)![1] : null;
});

// ---- In the client page ----
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Before the app runs: keeps the data channels, so warm to live can use the app's own `rpc` channel. lib's INIT_SCRIPT calls through this. */
export const channelHook = () => {
  const w = window as any;
  w.__w3ch = w.__w3ch ?? [];
  const orig = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, label: string, init?: RTCDataChannelInit) {
    const dc = orig.call(this, label, init);
    w.__w3ch.push({ label, dc });
    return dc;
  } as typeof orig;
};

/**
 * The probe, on the app's own `<video>`. Latency is page2.js' and streamlib's: a keydown's stamp in the listener, then the frame's
 * callback `now` once the pixel in the middle has flipped. `display` (expectedDisplayTime) is kept but is a prediction, never the number.
 */
export const installProbe = () => {
  const w = window as any;
  if (w.W3) return;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const px = document.createElement('canvas'); px.width = 8; px.height = 8;
  const pctx = px.getContext('2d', { willReadFrequently: true })!;
  const P: any = { frames: 0, read: false, lastLum: null, arm: null, armed: false, results: [], firstAfter: null, firstAt: null, lastFrameAt: 0 };
  let video: HTMLVideoElement | null = null;

  const attach = () => {
    const v = document.querySelector('video[data-testid="browser-video"]') as HTMLVideoElement | null;
    if (!v) return false;
    if (v !== video) {
      video = v;
      const onFrame = (now: number, m: any) => {
        if (v !== video) return;
        P.frames++;
        P.lastFrameAt = now;
        if (P.firstAfter !== null && P.firstAt === null) P.firstAt = { now, display: m.expectedDisplayTime };
        if (P.read) {
          pctx.drawImage(v, v.videoWidth / 2 - 4, v.videoHeight / 2 - 4, 8, 8, 0, 0, 8, 8);
          const d = pctx.getImageData(0, 0, 8, 8).data;
          let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i];
          const lum = s / 64;
          if (P.arm && (lum > 128) === P.arm.white) {
            P.results.push({ cb: now - P.arm.t0, display: m.expectedDisplayTime - P.arm.t0, recv: m.receiveTime ? m.receiveTime - P.arm.t0 : null });
            P.arm = null;
          }
          P.lastLum = lum;
        }
        v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
    }
    return true;
  };
  // Capture, on window: this runs before the app's listener on its hidden textarea.
  addEventListener('keydown', () => {
    const t0 = performance.now();
    if (P.armed) { P.arm = { t0, white: !(P.lastLum > 128) }; P.armed = false; }
  }, true);

  // What the page on the desk last said, from the window's own tab strip. Only changes are kept, each with the client's clock.
  const titles: [number, string][] = [];
  let lastTitle = '';
  setInterval(() => {
    const t = (document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null)?.title ?? '';
    if (t && t !== lastTitle) { lastTitle = t; titles.push([performance.now(), t]); if (titles.length > 5000) titles.shift(); }
  }, 200);

  const peer = (): RTCPeerConnection | null => { const l = (w.__e2e?.pcs ?? []).filter((p: RTCPeerConnection) => p.connectionState !== 'closed'); return l[l.length - 1] ?? null; };
  const stats = async () => {
    const out: any = { t: performance.now(), frames: P.frames, videoW: video?.videoWidth ?? 0, videoH: video?.videoHeight ?? 0 };
    const pc = peer();
    if (!pc) return out;
    out.connection = pc.connectionState;
    const s = await pc.getStats();
    const byId: any = {}; s.forEach((r: any) => { byId[r.id] = r; });
    s.forEach((r: any) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        out.video = { framesDecoded: r.framesDecoded, framesDropped: r.framesDropped ?? 0, framesReceived: r.framesReceived, bytes: r.bytesReceived, packetsLost: r.packetsLost, jitterBufferDelay: r.jitterBufferDelay, jitterBufferEmittedCount: r.jitterBufferEmittedCount, totalDecodeTime: r.totalDecodeTime,
          w: r.frameWidth, h: r.frameHeight, decoder: r.decoderImplementation, codec: byId[r.codecId]?.mimeType, freezeCount: r.freezeCount, totalFreezesDuration: r.totalFreezesDuration, nackCount: r.nackCount, pliCount: r.pliCount, keyFramesDecoded: r.keyFramesDecoded };
      }
      if (r.type === 'transport' && r.selectedCandidatePairId) {
        const p = byId[r.selectedCandidatePairId], rc = byId[p?.remoteCandidateId], lc = byId[p?.localCandidateId];
        out.pair = { rtt: p?.currentRoundTripTime, remote: rc ? { address: rc.address ?? rc.ip, port: rc.port, protocol: rc.protocol, type: rc.candidateType } : null, local: lc ? { protocol: lc.protocol, type: lc.candidateType } : null };
      }
    });
    return out;
  };

  // browser.stream.set on the app's own channel, with ids far past the app's own, whose replies the app ignores (peer.ts: no waiter, no action).
  // A member gets here by a tab hidden for 5 minutes, which is too slow to repeat. The app still thinks `live`, and every pass ends on `live`.
  let nextId = 0x40000000;
  const replies = new Map<number, (r: any) => void>();
  const watched = new WeakSet<RTCDataChannel>();
  const rpcChannel = (): RTCDataChannel | null => {
    const l = (w.__w3ch as { label: string; dc: RTCDataChannel }[]).filter((c) => c.label === 'rpc' && c.dc.readyState === 'open');
    const dc = l[l.length - 1]?.dc ?? null;
    if (dc && !watched.has(dc)) {
      watched.add(dc);
      dc.addEventListener('message', (e) => {
        const b = new Uint8Array(e.data as ArrayBuffer), v = new DataView(e.data as ArrayBuffer);
        const r = replies.get(v.getUint32(4));
        if (r) { replies.delete(v.getUint32(4)); r({ kind: b[1], body: JSON.parse(new TextDecoder().decode(b.subarray(12))) }); }
      });
    }
    return dc;
  };
  const setStream = (state: string) => new Promise<any>((res) => {
    const dc = rpcChannel();
    if (!dc) { res({ ok: false, code: 'no_channel' }); return; }
    const id = nextId++;
    const timer = setTimeout(() => { replies.delete(id); res({ ok: false, code: 'client_timeout' }); }, 45_000);
    replies.set(id, (r) => { clearTimeout(timer); res(r.kind === 9 ? { ok: false, code: r.body.code } : { ok: true, result: r.body }); });
    const body = new TextEncoder().encode(JSON.stringify({ m: 'browser.stream.set', p: { state }, deadlineMs: 40_000 }));
    const f = new Uint8Array(12 + body.length), v = new DataView(f.buffer);
    f[0] = 1; f[1] = 7; v.setUint32(4, id); f.set(body, 12); // API.md section 2: version, REQ, flags, id, seq
    dc.send(f);
  });
  const firstFrame = async (a: { state?: string; waitMs?: number } = {}) => {
    const before = P.frames;
    P.firstAt = null; P.firstAfter = before;
    const t0 = performance.now();
    const r = await setStream(a.state ?? 'live');
    const rpcMs = performance.now() - t0;
    if (!r.ok) { P.firstAfter = null; return { rpcMs, error: r.code, firstCbMs: null }; }
    while (P.firstAt === null && performance.now() - t0 < (a.waitMs ?? 8000)) await pause(2);
    const at = P.firstAt; P.firstAfter = null;
    return { rpcMs: +rpcMs.toFixed(1), firstCbMs: at ? +(at.now - t0).toFixed(1) : null };
  };

  // The picture's box, and the wheel into the app's own listener on the video: page2.js' 1200 px/s, reversing every 4 s, one event a frame.
  const box = () => {
    const v = video!, r = v.getBoundingClientRect();
    const scale = v.videoWidth ? Math.min(r.width / v.videoWidth, r.height / v.videoHeight) : 0;
    const width = v.videoWidth * scale, height = v.videoHeight * scale;
    return { elLeft: r.left, elTop: r.top, elWidth: r.width, elHeight: r.height, left: r.left + (r.width - width) / 2, top: r.top + (r.height - height) / 2, width, height, vw: v.videoWidth, vh: v.videoHeight, scale, dsf: devicePixelRatio, deviceFullPxPerDeskPx: scale * devicePixelRatio };
  };
  const wheelEvent = (dy: number) => {
    const b = box();
    video!.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: dy, deltaMode: 0, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, bubbles: true, cancelable: true }));
  };
  let wheelOn = false, wheelSent = 0;
  const wheelStart = () => {
    wheelOn = true; wheelSent = 0;
    const t0 = performance.now(); let last = t0;
    const step = (now: number) => {
      if (!wheelOn) return;
      const dy = Math.round((now - last) * 1.2) * (((now - t0) % 8000) < 4000 ? 1 : -1);
      last = now;
      if (dy) { wheelEvent(dy); wheelSent += Math.abs(dy); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const wheelBurst = (a: { frames: number; dy: number }) => new Promise<void>((res) => {
    let n = 0;
    const step = () => { wheelEvent(a.dy); if (++n >= a.frames) res(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });

  const canvasOf = (sx: number, sy: number, cw: number, ch: number) => {
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    c.getContext('2d', { willReadFrequently: true })!.drawImage(video!, sx, sy, cw, ch, 0, 0, cw, ch);
    return c;
  };

  w.W3 = {
    attach, stats, setStream, firstFrame, wheelStart, wheelStop: () => { wheelOn = false; return wheelSent; }, wheelBurst, box,
    now: () => performance.now(), frames: () => P.frames,
    setRead: (on: boolean) => { P.read = on; }, arm: () => { P.armed = true; }, disarm: () => { P.arm = null; P.armed = false; }, results: () => P.results, resultCount: () => P.results.length, clearResults: () => { P.results = []; P.arm = null; P.armed = false; },
    titlesBetween: (a: [number, number]) => titles.filter(([t]) => t >= a[0] && t <= a[1]).map(([, s]) => s),
    segment: async (a: { seconds: number }) => { const ticks: any[] = [await stats()]; for (let i = 0; i < a.seconds; i++) { await pause(1000); ticks.push(await stats()); } return ticks; },
    marks: (name: string) => performance.getEntriesByName(name).map((e) => e.startTime),
    // The decoded frame, as it left the decoder, through a canvas at the stream's own size: nothing scaled, and PNG is lossless.
    grab: () => { const v = video!; return { w: v.videoWidth, h: v.videoHeight, png: canvasOf(0, 0, v.videoWidth, v.videoHeight).toDataURL('image/png') }; },
    grabCrop: (a: { x: number; y: number; w: number; h: number }) => canvasOf(a.x, a.y, a.w, a.h).toDataURL('image/png'),
    frameHash: () => {
      const v = video!, d = canvasOf(0, 0, v.videoWidth, v.videoHeight).getContext('2d')!.getImageData(0, 0, v.videoWidth, v.videoHeight).data;
      let h = 2166136261; for (let i = 0; i < d.length; i += 4) { h ^= d[i] ^ (d[i + 1] << 8) ^ (d[i + 2] << 16); h = Math.imul(h, 16777619); }
      return (h >>> 0).toString(16);
    },
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- The real Browser window, from the test. Locators and steps are browser-window.spec.ts' ----
export interface Picture { left: number; top: number; width: number; height: number; elLeft: number; elTop: number; elWidth: number; elHeight: number; vw: number; vh: number; scale: number; dsf: number; deviceFullPxPerDeskPx: number }

export class BrowserWin {
  readonly win: Locator; readonly video: Locator; readonly keys: Locator; readonly address: Locator; readonly tabs: Locator; readonly activeTab: Locator;
  private ownTab = false;

  constructor(readonly page: Page, readonly deskId: string) {
    this.win = page.getByRole('dialog', { name: /Browser/ });
    this.video = this.win.getByLabel("The page in this desk's browser", { exact: true });
    this.keys = this.win.getByLabel("Keyboard for the page in this desk's browser", { exact: true });
    this.address = this.win.getByRole('textbox', { name: 'Address' });
    this.tabs = this.win.getByTestId('browser-tab');
    this.activeTab = this.win.getByRole('tab', { selected: true });
  }

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  W<T = any>(fn: string, arg?: unknown): Promise<T> {
    return this.page.evaluate(([f, a]) => (window as unknown as Record<string, Record<string, (x: unknown) => unknown>>).W3[f as string](a), [fn, arg] as const) as Promise<T>;
  }

  /** A real click on the tile, through the canvas. Returns the wall clock of the click. */
  async open(): Promise<number> {
    const deskProxy = this.page.locator(`#proxy-${this.deskId}`);
    await deskProxy.focus();
    await this.page.keyboard.press('Enter');
    const tile = deskProxy.locator('..').getByRole('button', { name: /^Browser/ });
    // The canvas takes no click while the camera moves, and the move can start after a first read: the box has to hold for a second.
    // Run against the app on MockDeskLink, a click right after the box first held did nothing.
    let box = await tile.boundingBox();
    let held = 0;
    for (let i = 0; i < 60 && held < 4; i++) {
      await sleep(250);
      const now = await tile.boundingBox();
      held = now && JSON.stringify(now) === JSON.stringify(box) ? held + 1 : 0;
      box = now;
    }
    if (!box) throw new Error('no Browser tile on this desk');
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await this.page.mouse.move(x, y);
    await sleep(150);
    let at = 0;
    for (let i = 0; i < 3 && !(await this.win.isVisible()); i++) {
      at = Date.now();
      await this.page.mouse.click(x, y);
      await this.win.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
    }
    await expect(this.win, 'the window opened').toBeVisible({ timeout: 15_000 });
    // The video element is mounted once the stream is live; on a desk whose Browser was frozen that is a moment after the window.
    await expect.poll(() => this.W('attach'), { message: "the app's video element", timeout: 30_000, intervals: [250] }).toBe(true);
    return at;
  }

  async waitPicture(ms: number): Promise<void> {
    await expect(this.win.getByTestId('browser-panel'), 'no panel left over the picture').toHaveCount(0, { timeout: ms });
    await expect.poll(() => this.video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  }

  async close(): Promise<void> {
    await this.win.getByRole('button', { name: 'Close Browser', exact: true }).click();
    await expect(this.win, 'the window closed').toHaveCount(0);
  }

  /** Tabs arriving means Chromium is up. */
  async waitTabs(ms: number): Promise<void> {
    await expect.poll(() => this.tabs.count(), { timeout: ms }).toBeGreaterThan(0);
  }

  /** The tabs a desk already has stay as they are: W3 works in one of its own. */
  async newTab(): Promise<void> {
    await this.waitTabs(180_000);
    const before = await this.tabs.count();
    await this.win.getByRole('button', { name: 'New tab', exact: true }).click();
    await expect(this.tabs, 'the new tab').toHaveCount(before + 1, { timeout: 20_000 });
    this.ownTab = true;
  }

  async closeOwnTab(): Promise<void> {
    if (!this.ownTab) return;
    this.ownTab = false;
    const close = this.tabs.filter({ has: this.page.getByRole('tab', { selected: true }) }).getByRole('button', { name: /^Close / });
    await close.click({ timeout: 5000 }).catch(() => {});
  }

  async go(url: string): Promise<void> {
    await this.address.click();
    await this.address.fill(url);
    await this.address.press('Enter');
  }

  /** The newest report from the page on screen, from the window's tab strip. The last one seen if `ok` never holds. */
  async report<T>(ok: (s: T) => boolean = () => true, ms = 8000): Promise<T | null> {
    const t0 = Date.now();
    let last: T | null = null;
    while (Date.now() - t0 < ms) {
      const s = titleOf<T>((await this.activeTab.getAttribute('title', { timeout: 2000 }).catch(() => null)) ?? undefined);
      if (s) { last = s; if (ok(s)) return s; }
      await sleep(120);
    }
    return last;
  }

  picture(): Promise<Picture> { return this.W('box'); }

  /** Desk pixels to the client's CSS pixels. */
  /** Set when the stream is smaller than the screen (picture quality Low streams 1280x720 of a 1920x1080 screen): desk pixels to stream pixels. */
  deskWidth: number | null = null;
  toClient(p: Picture, x: number, y: number) { const k = this.deskWidth && p.vw ? p.vw / this.deskWidth : 1; return { x: p.left + x * k * p.scale, y: p.top + y * k * p.scale }; }

  async clickDesk(p: Picture, x: number, y: number): Promise<void> {
    const c = this.toClient(p, x, y);
    await this.page.mouse.move(c.x, c.y);
    await this.page.mouse.click(c.x, c.y);
  }

  async moveOver(p: Picture): Promise<void> { await this.page.mouse.move(p.left + p.width / 2, p.top + p.height / 2); }
}

/** A page's report in its title (streamlib's titleState, tag R): `~` stands for `"`, because titles reach the client HTML-escaped. */
export function titleOf<T>(title: string | undefined): T | null {
  if (!title || !title.startsWith('R')) return null;
  try { return JSON.parse(title.slice(1).replaceAll('~', '"')) as T; } catch { return null; }
}

// ---- Reading the numbers ----
export type PageSample = { t: number; f: number; sf: number; px: number; lf: number; gm: number; y: number; vis: string; n: string; [k: string]: unknown };

/** The page's own rAF rate between reports, as stream.spec.ts test 2 computes it. Each report carries the page's clock, so a late title changes nothing. */
export function pageFps(titles: string[]) {
  const seen = new Set<number>();
  const pts = titles.map((t) => titleOf<PageSample>(t)).filter((s): s is PageSample => !!s).filter((s) => !seen.has(s.t) && !!seen.add(s.t)).sort((a, b) => a.t - b.t);
  const perInterval: number[] = [];
  for (let i = 1; i < pts.length; i++) perInterval.push(+(((pts[i].f - pts[i - 1].f) * 1000) / (pts[i].t - pts[i - 1].t)).toFixed(1));
  const first = pts[0], last = pts[pts.length - 1];
  const dt = last && first ? (last.t - first.t) / 1000 : 0;
  return {
    samples: pts.length, seconds: +dt.toFixed(1), avg: dt ? +((last.f - first.f) / dt).toFixed(1) : null, p5: pct(perInterval, 5), min: perInterval.length ? Math.min(...perInterval) : null,
    maxGapMs: pts.length > 1 ? Math.max(...pts.slice(1).map((p) => p.gm ?? 0)) : null, scrollChangeFps: dt ? +((last.sf - first.sf) / dt).toFixed(1) : null, scrolledPx: last && first ? last.px - first.px : 0,
    longFramePct: dt && last.f > first.f ? +((100 * (last.lf - first.lf)) / (last.f - first.f)).toFixed(1) : null, visibility: last?.vis, perInterval, first: first ?? null, last: last ?? null,
  };
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Tick = any;
export const rttMs = (s: Tick) => (s?.pair?.rtt !== undefined ? +(s.pair.rtt * 1000).toFixed(1) : null);

/** Decoded at the client, as stream.spec.ts test 2 computes it. Stream fps: never the verdict. */
export function clientNumbers(T: Tick[]) {
  const a = T[0], b = T[T.length - 1];
  const dt = (b.t - a.t) / 1000;
  const perSec = T.slice(1).map((x, i) => x.video.framesDecoded - T[i].video.framesDecoded);
  return {
    seconds: +dt.toFixed(1), decodedFps: +((b.video.framesDecoded - a.video.framesDecoded) / dt).toFixed(1), decodedP5: pct(perSec, 5), decodedMin: Math.min(...perSec), receivedFps: +((b.video.framesReceived - a.video.framesReceived) / dt).toFixed(1),
    dropped: b.video.framesDropped - a.video.framesDropped, freezes: b.video.freezeCount - a.video.freezeCount, freezeSeconds: +(b.video.totalFreezesDuration - a.video.totalFreezesDuration).toFixed(3),
    mbps: +(((b.video.bytes - a.video.bytes) * 8) / dt / 1e6).toFixed(2), gbPerHour: +(((b.video.bytes - a.video.bytes) / dt) * 3600 / 1e9).toFixed(3), packetsLost: b.video.packetsLost - a.video.packetsLost, nacks: b.video.nackCount - a.video.nackCount, plis: b.video.pliCount - a.video.pliCount, keyframes: b.video.keyFramesDecoded - a.video.keyFramesDecoded,
    jitterBufferMs: +((1000 * (b.video.jitterBufferDelay - a.video.jitterBufferDelay)) / Math.max(1, b.video.jitterBufferEmittedCount - a.video.jitterBufferEmittedCount)).toFixed(1), decodeMs: +((1000 * (b.video.totalDecodeTime - a.video.totalDecodeTime)) / Math.max(1, b.video.framesDecoded - a.video.framesDecoded)).toFixed(1),
    decoder: b.video.decoder, codec: b.video.codec, rttMs: pct(T.map(rttMs), 50), path: b.pair ? { remote: b.pair.remote, local: b.pair.local } : null,
  };
}

/**
 * The kit measures the streamed page, and from app 2026.11.10-96df0766 the Browser draws a simplified view of a page it can
 * (task 47), with the stream kept `warm`. Client-config's `simpleView: { enabled: false }` is that feature's own kill switch;
 * this sets it in this test browser only, for every call to client-config, and nothing else is changed.
 */
export async function noSimpleView(context: BrowserContext): Promise<void> {
  await context.route(/\/v1\/client-config/, async (route) => {
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return route.fulfill({ response: res });
    await route.fulfill({ response: res, json: { ...body, simpleView: { enabled: false } } });
  });
}
