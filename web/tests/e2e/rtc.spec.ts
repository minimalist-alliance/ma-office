// The real path: the shipping bundle in Chromium, through gateway-shim and desk-rtc, to fake-deskd.
// Real WebRTC, no mocks. Where a test sits between the page and the gateway, it edits one SDP line.
//
// Evidence lands in test-results/rtc/: each tool's log, and offer.sdp and answer.sdp from the last run.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { encodeJson, Kind } from '../../src/desk/rtc/frames';
import { harness, signIn, watchConsole } from './helpers';
import { buildTools, DESK_ID, Stack } from './rtcStack';

const EVIDENCE = resolve('test-results/rtc');
const ONLINE = /^Personal desk, 4 apps, online · dev · up /;

const stack = new Stack(EVIDENCE);
const proxy = (page: Page) => page.getByRole('button', { name: /^Personal desk, 4 apps, / });

interface GwFrame {
  dir: 'sent' | 'received';
  msg: { type: string; sessionId?: string; reason?: string; data?: { type?: string; sdp?: string; restart?: boolean } };
}

/** Watches the page's gateway WebSocket from outside, touching nothing. */
function watchGateway(page: Page): GwFrame[] {
  const frames: GwFrame[] = [];
  const add = (dir: GwFrame['dir'], payload: string | Buffer): void => {
    frames.push({ dir, msg: JSON.parse(String(payload)) as GwFrame['msg'] });
  };
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => add('sent', f.payload));
    ws.on('framereceived', (f) => add('received', f.payload));
  });
  return frames;
}

const ofType = (frames: GwFrame[], dir: GwFrame['dir'], type: string): GwFrame[] => frames.filter((f) => f.dir === dir && f.msg.type === type);

interface RouteOptions {
  /** Change the desk's answer on its way in. */
  editAnswer?: (sdp: string) => string;
  /** Change the page's offer on its way out. */
  editOffer?: (sdp: string) => string;
  /** Don't pass on messages of these types, as if the gateway had gone quiet. */
  drop?: string[];
  /** Don't pass these on to the page, as if the gateway never sent them. */
  dropFromGateway?: string[];
}

/** Sits between the page and the gateway, for the tests that need one line changed. */
async function routeGateway(page: Page, opts: RouteOptions): Promise<{ closeFromServer: (code: number) => Promise<void>; toGateway: (m: object) => void }> {
  let current: { close: (o: { code: number; reason: string }) => Promise<void> } | null = null;
  let toServer: ((text: string) => void) | null = null;
  await page.routeWebSocket(/\/v1$/, (ws) => {
    current = ws;
    const server = ws.connectToServer();
    toServer = (text) => server.send(text);
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m)) as GwFrame['msg'];
      if (opts.drop?.includes(msg.type)) return;
      if (msg.type === 'signal' && msg.data?.type === 'offer' && msg.data.sdp && opts.editOffer) msg.data.sdp = opts.editOffer(msg.data.sdp);
      server.send(JSON.stringify(msg));
    });
    server.onMessage((m) => {
      const msg = JSON.parse(String(m)) as GwFrame['msg'];
      if (opts.dropFromGateway?.includes(msg.type)) return;
      if (msg.type === 'signal' && msg.data?.type === 'answer' && msg.data.sdp && opts.editAnswer) msg.data.sdp = opts.editAnswer(msg.data.sdp);
      ws.send(JSON.stringify(msg));
    });
  });
  return {
    closeFromServer: async (code) => {
      await current?.close({ code, reason: 'test' });
    },
    toGateway: (m) => toServer?.(JSON.stringify(m)),
  };
}

/** What a browser without H.264 would offer: the desk answers m=video 0. */
function withoutH264(sdp: string): string {
  const h264 = new Set([...sdp.matchAll(/^a=rtpmap:(\d+) H264\//gm)].map((m) => m[1] as string));
  for (const [, rtx, apt] of sdp.matchAll(/^a=fmtp:(\d+) apt=(\d+)/gm)) {
    if (h264.has(apt as string)) h264.add(rtx as string);
  }
  return sdp
    .split('\r\n')
    .filter((l) => {
      const pt = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/.exec(l)?.[1];
      return !pt || !h264.has(pt);
    })
    .map((l) => (l.startsWith('m=video') ? l.split(' ').filter((t) => !h264.has(t)).join(' ') : l))
    .join('\r\n');
}

interface SentFrame {
  label: string;
  kind: number;
  id: number;
  text: string;
}
const KIND = { HELLO: 1, AUTH: 2, PING: 4, REQ: 7 };

/** Records the page's PeerConnections and what it writes to channels. Changes no behaviour. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __pcs: RTCPeerConnection[]; __sent: SentFrame[]; __ctl?: RTCDataChannel; RTCPeerConnection: typeof RTCPeerConnection };
    w.__pcs = [];
    w.__sent = [];
    const Native = window.RTCPeerConnection;
    w.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config);
        w.__pcs.push(this);
      }

      override createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
        const dc = super.createDataChannel(label, init);
        if (label === 'ctl') w.__ctl = dc;
        return dc;
      }
    };
    const send = RTCDataChannel.prototype.send as (this: RTCDataChannel, d: Uint8Array<ArrayBuffer>) => void;
    (RTCDataChannel.prototype as unknown as { send: typeof send }).send = function sendAndRecord(d) {
      const id = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(4);
      w.__sent.push({ label: this.label, kind: d[1] as number, id, text: new TextDecoder().decode(d.subarray(12)) });
      send.call(this, d);
    };
  });
}

const sentFrames = (page: Page): Promise<SentFrame[]> => page.evaluate(() => (window as unknown as { __sent: SentFrame[] }).__sent);

/** The live PeerConnection: how many there are, and how many messages `ctl` has brought in. */
function peerFacts(page: Page): Promise<{ live: number; state: string; ctlIn: number; transceivers: string[] }> {
  return page.evaluate(async () => {
    const live = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((p) => p.signalingState !== 'closed');
    const pc = live[live.length - 1];
    if (!pc) return { live: 0, state: 'none', ctlIn: 0, transceivers: [] };
    let ctlIn = 0;
    (await pc.getStats()).forEach((r: { type: string; label?: string; messagesReceived?: number }) => {
      if (r.type === 'data-channel' && r.label === 'ctl') ctlIn = r.messagesReceived ?? 0;
    });
    return { live: live.length, state: pc.connectionState, ctlIn, transceivers: pc.getTransceivers().map((t) => t.receiver.track.kind) };
  });
}

async function about(page: Page): Promise<string> {
  const menu = page.getByRole('button', { name: 'Account' });
  await menu.click();
  const toggle = page.getByTestId('about-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const text = (await page.getByTestId('about-desk').innerText()).replace(/\s+/g, ' ');
  await page.keyboard.press('Escape');
  return text;
}

async function openCount(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByName('ma:desk-link-open').length);
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test.beforeAll(async () => {
  test.setTimeout(600_000);
  rmSync(EVIDENCE, { recursive: true, force: true });
  mkdirSync(EVIDENCE, { recursive: true });
  buildTools();
  await stack.start();
});

test.afterAll(async () => {
  await stack.stop();
});

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
  await harness(request, { shim: stack.api, roles: ['owner'] }); // About this desk is the owner's only
});

test('over UDP: the panel shows what fake-deskd reports', async ({ page, request }, info) => {
  const errors = watchConsole(page);
  const frames = watchGateway(page);
  await instrument(page);
  await signIn(page);

  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  await page.screenshot({ path: join(EVIDENCE, 'panel-online.png') });
  const text = await about(page);
  expect(text).toContain('deskd fake-deskd');
  expect(text).toContain('Instance dev');
  expect(text).toContain('Java none (fake-deskd)');
  expect(text).toContain(`Desk ${DESK_ID}`);
  expect(text).toMatch(/Connection udp · \d+ ms/);

  // Order per design 4.2.1, and a real connect on the way. The desk is running, so nothing asks to wake it.
  const sent = frames.filter((f) => f.dir === 'sent').map((f) => f.msg.type);
  expect(sent.indexOf('session.open')).toBeLessThan(sent.indexOf('signal'));
  const log = (await (await request.get('/__harness')).json()).log as string[];
  expect(log.filter((l) => l.startsWith('connect start='))[0]).toBe('connect start=false');

  // Never trickled: the only signal this page sends is the one offer.
  const signals = ofType(frames, 'sent', 'signal');
  expect(signals).toHaveLength(1);
  const offer = signals[0]?.msg.data?.sdp ?? '';
  const answer = ofType(frames, 'received', 'signal')[0]?.msg.data?.sdp ?? '';
  writeFileSync(join(EVIDENCE, 'offer.sdp'), offer);
  writeFileSync(join(EVIDENCE, 'answer.sdp'), answer);
  expect(offer.match(/^m=\w+/gm)).toEqual(['m=audio', 'm=video', 'm=application']);
  expect((await peerFacts(page)).live).toBe(1);

  // HELLO on ctl and then the status on rpc, in the agreed shapes.
  const writes = await sentFrames(page);
  const hello = writes.find((f) => f.kind === KIND.HELLO);
  expect(hello?.label).toBe('ctl');
  expect(hello?.id).toBe(0);
  expect(writes[0]).toEqual(hello); // first on ctl, and before anything on rpc
  expect(JSON.parse(hello?.text ?? '{}')).toMatchObject({ deskApi: '1.0' });
  expect(JSON.parse(hello?.text ?? '{}')).not.toHaveProperty('resume');
  const req = writes.find((f) => f.kind === KIND.REQ);
  expect(req?.label).toBe('rpc');
  expect(JSON.parse(req?.text ?? '{}')).toEqual({ m: 'desk.status.get', p: {} });

  const measures = await page.evaluate(() => performance.getEntriesByName('ma:desk-link-open').map((e) => e.duration));
  info.annotations.push({ type: 'setup', description: `${Math.round(measures[0] ?? -1)} ms; ${text}` });
  console.log(`UDP setup ${Math.round(measures[0] ?? -1)} ms; ${text}`);
  expect(errors).toEqual([]);
});

test('over ICE-TCP, when the UDP candidate is out of the answer', async ({ page }) => {
  const errors = watchConsole(page);
  await routeGateway(page, { editAnswer: (sdp) => sdp.split('\r\n').filter((l) => !/^a=candidate:.* udp /i.test(l)).join('\r\n') });
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 30_000 });
  const text = await about(page);
  expect(text).toMatch(/Connection tcp · \d+ ms/);
  console.log(`TCP: ${text}`);
  expect(errors).toEqual([]);
});

test('killing desk-rtc shows reconnecting, then can\'t reach desk; a restart recovers without a reload', async ({ page }) => {
  const errors = watchConsole(page);
  const frames = watchGateway(page);
  await instrument(page);
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  await page.evaluate(() => {
    (window as unknown as { __notReloaded: boolean }).__notReloaded = true;
  });

  await stack.killDesk();
  const lostAt = Date.now();
  await expect(proxy(page)).toHaveAccessibleName(/reconnecting…$/, { timeout: 20_000 });
  console.log(`reconnecting… after ${Date.now() - lostAt} ms`);
  expect(await about(page)).toMatch(/^Reconnecting to this desk\. Last path udp, last round trip \d+ ms\.$/);

  await expect(proxy(page)).toHaveAccessibleName(/can't reach desk$/, { timeout: 45_000 });
  await page.screenshot({ path: join(EVIDENCE, 'panel-unreachable.png') });
  expect(await about(page)).toMatch(/^Can't reach this desk\. Last path udp, last round trip \d+ ms\.$/);

  await stack.startDesk();
  const backAt = Date.now();
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 40_000 });
  console.log(`recovered ${Date.now() - backAt} ms after the desk came back`);
  expect(await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded)).toBe(true);
  expect(await openCount(page)).toBe(2);
  // Fresh numbers from the new desk (the old one had been up for over 30 s), over a new session.
  const uptime = /Uptime (\d+)s/.exec(await about(page))?.[1];
  expect(Number(uptime)).toBeLessThan(25);
  expect(ofType(frames, 'sent', 'session.open').length).toBeGreaterThan(1);
  const hellos = (await sentFrames(page)).filter((f) => f.kind === KIND.HELLO).map((f) => JSON.parse(f.text) as { resume?: { sessionId?: string; resumeToken?: string } });
  expect(hellos).toHaveLength(2);
  expect(hellos[1]?.resume).toEqual({ sessionId: ofType(frames, 'received', 'session.opened')[0]?.msg.sessionId, resumeToken: 'fake-resume-token' });
  expect((await peerFacts(page)).live).toBe(1);
  expect(errors).toEqual([]);
});

test('a stalled desk recovers by ICE restart, on the same PeerConnection', async ({ page }) => {
  const errors = watchConsole(page);
  const frames = watchGateway(page);
  await instrument(page);
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  await expect.poll(() => ofType(frames, 'sent', 'signal').length).toBe(1);

  stack.signalRtc('SIGSTOP');
  try {
    await expect.poll(() => ofType(frames, 'sent', 'signal').filter((f) => f.msg.data?.restart).length, { timeout: 30_000 }).toBe(1);
  } finally {
    stack.signalRtc('SIGCONT');
  }
  await page.waitForFunction(() => performance.getEntriesByName('ma:desk-ice-restarted').length === 1, undefined, { timeout: 20_000 });
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 5_000 });
  expect(await openCount(page)).toBe(1);
  expect(ofType(frames, 'sent', 'session.open')).toHaveLength(1);
  // The channels carried on: a later PONG arrives on the same `ctl`.
  const { ctlIn } = await peerFacts(page);
  await expect.poll(async () => (await peerFacts(page)).ctlIn, { timeout: 25_000 }).toBeGreaterThan(ctlIn);
  expect((await peerFacts(page)).live).toBe(1);
  expect(errors).toEqual([]);
});

test('a blip under 1 s shows nothing', async ({ page }) => {
  const errors = watchConsole(page);
  const frames = watchGateway(page);
  await instrument(page);
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  await page.evaluate(() => {
    const w = window as unknown as { __pcs: RTCPeerConnection[]; __labels: string[] };
    w.__labels = [];
    const button = [...document.querySelectorAll('button.proxy')].find((b) => b.getAttribute('aria-label')?.startsWith('Personal desk')) as HTMLElement;
    new MutationObserver(() => w.__labels.push(button.getAttribute('aria-label') ?? '')).observe(button, { attributes: true, attributeFilter: ['aria-label'] });
    // The connection reports `disconnected` for one event, as a real blip would. The repair is real.
    const pc = w.__pcs.filter((p) => p.signalingState !== 'closed').at(-1) as RTCPeerConnection;
    Object.defineProperty(pc, 'connectionState', { get: () => 'disconnected', configurable: true });
    pc.dispatchEvent(new Event('connectionstatechange'));
    delete (pc as unknown as { connectionState?: string }).connectionState;
  });
  await expect.poll(() => ofType(frames, 'received', 'signal').length, { timeout: 5_000 }).toBe(2);
  await page.waitForTimeout(1_500);
  expect(await page.evaluate(() => (window as unknown as { __labels: string[] }).__labels)).toEqual([]);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE);
  expect(await openCount(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('the status is fetched again about every 15 s while the tab is visible', async ({ page }) => {
  await instrument(page);
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  const statusCalls = async (): Promise<number> => (await sentFrames(page)).filter((f) => f.kind === KIND.REQ).length;
  const first = await statusCalls();
  expect(first).toBeGreaterThanOrEqual(1);
  await expect.poll(statusCalls, { timeout: 20_000 }).toBeGreaterThan(first);
});

test('a token refresh goes connect {start:false}, then session.refresh', async ({ page, request }) => {
  const errors = watchConsole(page);
  const frames = watchGateway(page);
  await harness(request, { refreshAfterSec: 6 });
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });

  await expect.poll(() => ofType(frames, 'received', 'session.refreshed').length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  const log = (await (await request.get('/__harness')).json()).log as string[];
  const connects = log.filter((l) => l.startsWith('connect start='));
  expect(connects.length).toBeGreaterThanOrEqual(2);
  expect(new Set(connects)).toEqual(new Set(['connect start=false']));
  await expect(proxy(page)).toHaveAccessibleName(ONLINE);
  expect(await openCount(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('with no answer to session.refresh, the token goes to the desk as AUTH on ctl', async ({ page, request }) => {
  const errors = watchConsole(page);
  await instrument(page);
  await harness(request, { refreshAfterSec: 3 });
  await routeGateway(page, { drop: ['session.refresh'] });
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  const auths = async (): Promise<SentFrame[]> => (await sentFrames(page)).filter((f) => f.kind === KIND.AUTH);
  await expect.poll(async () => (await auths()).length, { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
  const auth = (await auths())[0];
  expect(auth?.label).toBe('ctl');
  expect(JSON.parse(auth?.text ?? '{}').deskToken).toMatch(/^eyJ/);
  expect(errors).toEqual([]);
});

const TRIGGER_FAILED = { status: 400, body: { error: 'PreTokenGenerationV2_0 failed with error Internal. Error Code: UserLambdaValidationException; Request ID: 1234' } };

test('a token refresh that keeps failing leaves the session up, and session.refresh follows when it works', async ({ page, request }) => {
  const errors = watchConsole(page);
  const frames = watchGateway(page);
  await harness(request, { refreshAfterSec: 3, expiresIn: 4 }); // inside the 5 minute margin, so every `connect` refreshes first
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });

  await harness(request, { refreshFailure: TRIGGER_FAILED });
  await page.waitForTimeout(5_000); // the access token is gone by now
  const refreshed = ofType(frames, 'received', 'session.refreshed').length;
  await page.waitForTimeout(8_000);
  expect(ofType(frames, 'received', 'session.refreshed').length).toBe(refreshed);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE);
  await expect(page.getByTestId('sign-in')).toHaveCount(0);
  expect(await openCount(page)).toBe(1);

  await harness(request, { refreshFailure: null });
  await expect.poll(() => ofType(frames, 'received', 'session.refreshed').length, { timeout: 30_000 }).toBeGreaterThan(refreshed);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE);
  expect(await openCount(page)).toBe(1); // the same session, carried across
  expect(errors.filter((e) => !e.startsWith('Failed to load resource'))).toEqual([]);
});

test('with the gateway silent as well, AUTH on ctl carries the token once the refresh works', async ({ page, request }) => {
  await instrument(page);
  await harness(request, { refreshAfterSec: 3, expiresIn: 4 });
  await routeGateway(page, { drop: ['session.refresh'] });
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });

  await harness(request, { refreshFailure: TRIGGER_FAILED });
  await page.waitForTimeout(13_000); // past any AUTH already on its way when the refresh began to fail
  const auths = async (): Promise<number> => (await sentFrames(page)).filter((f) => f.kind === KIND.AUTH).length;
  const before = await auths();
  await page.waitForTimeout(5_000);
  expect(await auths()).toBe(before);

  await harness(request, { refreshFailure: null });
  await expect.poll(auths, { timeout: 40_000 }).toBeGreaterThan(before);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE);
  await expect(page.getByTestId('sign-in')).toHaveCount(0);
  expect(await openCount(page)).toBe(1);
});

test('a video section the desk rejects does not break the data path', async ({ page }) => {
  const errors = watchConsole(page);
  const frames = watchGateway(page);
  await instrument(page);
  await routeGateway(page, { editOffer: withoutH264 });
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  const answer = ofType(frames, 'received', 'signal')[0]?.msg.data?.sdp ?? '';
  expect(answer).toMatch(/^m=video 0 /m);
  expect(answer).toMatch(/^m=audio 9 /m);
  expect(errors).toEqual([]);
});

test('a wrong fingerprint in the answer is refused', async ({ page }) => {
  const frames = watchGateway(page);
  await routeGateway(page, { editAnswer: (sdp) => sdp.replace(/^a=fingerprint:sha-256 .*$/gm, `a=fingerprint:sha-256 ${'AB:'.repeat(31)}AB`) });
  await signIn(page);
  await expect.poll(() => ofType(frames, 'sent', 'session.close').filter((f) => f.msg.reason === 'identity_mismatch').length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await expect(proxy(page)).toHaveAccessibleName(/reconnecting…$/);
  expect(await openCount(page)).toBe(0);
});

test('a desk that is not ready shows the state from connect, and opens no session until it is', async ({ page, request }) => {
  const errors = watchConsole(page);
  const frames = watchGateway(page);
  await harness(request, { connectOverride: { state: 'starting', phase: 'booting' } });
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(/waking · 2 of 4$/, { timeout: 10_000 });
  await page.waitForTimeout(2_500);
  expect(ofType(frames, 'sent', 'session.open')).toHaveLength(0);

  await harness(request, { connectOverride: null });
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('the gateway closing 1001 means session.resume, and the PeerConnection never notices', async ({ page }) => {
  const errors = watchConsole(page);
  const frames = watchGateway(page);
  await instrument(page);
  const gw = await routeGateway(page, {});
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  const before = ofType(frames, 'received', 'session.opened')[0]?.msg.sessionId;
  expect(before).toBeTruthy();

  await gw.closeFromServer(1001);
  await expect.poll(() => ofType(frames, 'sent', 'session.resume').length, { timeout: 20_000 }).toBe(1);
  await expect.poll(() => ofType(frames, 'received', 'session.opened').length, { timeout: 20_000 }).toBe(2);
  expect(ofType(frames, 'received', 'session.opened')[1]?.msg.sessionId).toBe(before);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE);
  expect(await openCount(page)).toBe(1);
  // No new offer, and the same connection keeps working.
  expect(ofType(frames, 'sent', 'signal')).toHaveLength(1);
  const { ctlIn, live } = await peerFacts(page);
  expect(live).toBe(1);
  await expect.poll(async () => (await peerFacts(page)).ctlIn, { timeout: 25_000 }).toBeGreaterThan(ctlIn);
  expect(errors).toEqual([]);
});

test('a link stops retrying once the desk is stopped, and the desk list bringing it back reopens it without waking', async ({ page, request }) => {
  const errors = watchConsole(page);
  await instrument(page);
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });

  await harness(request, { connectOverride: { state: 'stopped', phase: 'stopped' } });
  await stack.killDesk();
  await expect(proxy(page)).toHaveAccessibleName(/asleep$/, { timeout: 30_000 });
  const connects = async (): Promise<number> => ((await (await request.get('/__harness')).json()).log as string[]).filter((l) => l.startsWith('connect start=')).length;
  const settled = await connects();
  await page.waitForTimeout(4_000);
  expect(await connects()).toBe(settled);

  // The next poll of the desk list says it's running again. No reload.
  await harness(request, { connectOverride: null });
  await stack.startDesk();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  expect(await openCount(page)).toBe(2);
  const log = (await (await request.get('/__harness')).json()).log as string[];
  expect(log).toContain('list 304'); // the list reads the same, and that alone brought the link back
  expect(log.filter((l) => l === 'connect start=true')).toHaveLength(0);
  expect(errors).toEqual([]);
});

// ----- deskd restarting while the instance stays up

const harnessLog = async (request: APIRequestContext): Promise<string[]> => ((await (await request.get('/__harness')).json()) as { log: string[] }).log;
const isConnect = (l: string): boolean => l.startsWith('connect start=');

/** The list has just been polled, so for the next 60 s nothing but the link itself can bring it back. */
async function listJustPolled(page: Page, request: APIRequestContext): Promise<void> {
  const polls = async (): Promise<number> => (await harnessLog(request)).filter((l) => l === 'GET /v1/desks').length;
  const before = await polls();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(polls).toBeGreaterThan(before);
  await page.waitForTimeout(200); // the poll's answer has rescheduled the next one
}

/**
 * CLOSE arriving on the real `ctl`, as a message event in the page. fake-deskd has no way to send one:
 * it only forwards `session.close` to desk-rtc, which closes the connection without a frame.
 */
async function closeOnCtl(page: Page, code: number, reason: string): Promise<void> {
  const bytes = [...(encodeJson(Kind.CLOSE, 0, { code, reason })[0] as Uint8Array)];
  await page.evaluate((b) => {
    const ctl = (window as unknown as { __ctl: RTCDataChannel }).__ctl;
    ctl.dispatchEvent(new MessageEvent('message', { data: new Uint8Array(b).buffer }));
  }, bytes);
}

/** When the nth session came up, as epoch ms. 0 until then. */
function openedAt(page: Page, nth: number): Promise<number> {
  return page.evaluate((n) => {
    const e = performance.getEntriesByName('ma:desk-link-open')[n];
    return e ? performance.timeOrigin + e.startTime + e.duration : 0;
  }, nth);
}

interface CloseRig {
  page: Page;
  gw: Awaited<ReturnType<typeof routeGateway>>;
  sessionId: string;
}

/**
 * The real gateway-shim and desk-rtc carry this one: the close goes in where deskd's would come from the
 * gateway's point of view, the tab hears a real `session.closed`, and desk-rtc tears the connection down
 * with that reason. Only the start is staged, since fake-deskd never closes that way itself.
 */
const gatewayCloses = (reason: string) => ({ gw, sessionId }: CloseRig): Promise<void> => {
  gw.toGateway({ type: 'session.close', sessionId, reason });
  return Promise.resolve();
};
const closedByGateway = gatewayCloses('desk_stopping');

/** Signed in, online, and the list just polled. */
async function onlineSession(page: Page, request: APIRequestContext, route: RouteOptions = {}): Promise<{ rig: CloseRig; frames: GwFrame[]; errors: string[] }> {
  const errors = watchConsole(page);
  const frames = watchGateway(page);
  await instrument(page);
  const gw = await routeGateway(page, route);
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  const sessionId = ofType(frames, 'received', 'session.opened')[0]?.msg.sessionId ?? '';
  expect(sessionId).toBeTruthy();
  await listJustPolled(page, request);
  return { rig: { page, gw, sessionId }, frames, errors };
}

/** Every label the panel takes from now on. */
async function watchLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __labels: string[] };
    w.__labels = [];
    const button = [...document.querySelectorAll('button.proxy')].find((b) => b.getAttribute('aria-label')?.startsWith('Personal desk')) as HTMLElement;
    new MutationObserver(() => w.__labels.push(button.getAttribute('aria-label') ?? '')).observe(button, { attributes: true, attributeFilter: ['aria-label'] });
  });
}

const seenLabels = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __labels: string[] }).__labels);

const RESTARTS: { word: string; say: (rig: CloseRig) => Promise<void> }[] = [
  { word: 'session.closed desk_stopping', say: closedByGateway },
  { word: 'CLOSE 4503 on ctl', say: ({ page }) => closeOnCtl(page, 4503, 'desk_stopping') },
  { word: 'CLOSE 4002 on ctl', say: ({ page }) => closeOnCtl(page, 4002, 'deskd_restarting') },
  { word: 'session.closed closed_by_desk', say: gatewayCloses('closed_by_desk') },
  { word: 'no word, only the channel dying', say: () => Promise.resolve() },
];

for (const { word, say } of RESTARTS) {
  test(`deskd restarting, ${word}: back in seconds, by itself, and nothing asks to wake`, async ({ page, request }) => {
    const { rig, errors } = await onlineSession(page, request);
    await watchLabels(page);
    const logMark = (await harnessLog(request)).length;

    const closedAt = Date.now();
    await say(rig);
    await stack.stopDeskd();
    await page.waitForTimeout(Math.max(0, 2_000 - (Date.now() - closedAt)));
    await stack.startDeskd();
    await expect.poll(() => openedAt(page, 1), { timeout: 75_000, intervals: [100] }).toBeGreaterThan(0);

    const recoveredMs = Math.round((await openedAt(page, 1)) - closedAt);
    const log = (await harnessLog(request)).slice(logMark);
    console.log(`${word}: new session ${recoveredMs} ms after the close; ${log.filter(isConnect).length} connects, ${log.filter((l) => l === 'GET /v1/desks').length} list polls`);
    expect(log.filter((l) => l === 'connect start=true')).toEqual([]);
    expect(recoveredMs).toBeLessThan(8_000);
    expect(log.filter((l) => l === 'GET /v1/desks')).toEqual([]); // the link did this, not the list
    expect(log.filter(isConnect).length).toBeLessThanOrEqual(5);
    await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 5_000 });
    expect(await openCount(page)).toBe(2);
    expect((await stack.state()).sessions).toHaveLength(1);
    expect(await seenLabels(page)).not.toContainEqual(expect.stringMatching(/going to sleep/));
    expect(errors).toEqual([]);
  });
}

const RESTS: { close: string; say: (rig: CloseRig) => Promise<void>; said: string; override: object; label: RegExp }[] = [
  { close: 'session.closed desk_stopping', say: closedByGateway, said: 'stopping', override: { state: 'stopping', phase: 'stopped', retryAfterSeconds: null }, label: /going to sleep$/ },
  { close: 'session.closed desk_stopping', say: closedByGateway, said: 'stopped', override: { state: 'stopped', phase: 'stopped', retryAfterSeconds: null }, label: /asleep$/ },
  { close: 'CLOSE 4503 on ctl', say: ({ page }) => closeOnCtl(page, 4503, 'desk_stopping'), said: 'stopped', override: { state: 'stopped', phase: 'stopped', retryAfterSeconds: null }, label: /asleep$/ },
  { close: 'CLOSE 4002 on ctl', say: ({ page }) => closeOnCtl(page, 4002, 'deskd_restarting'), said: 'stopped', override: { state: 'stopped', phase: 'stopped', retryAfterSeconds: null }, label: /asleep$/ },
  { close: 'session.closed closed_by_desk', say: gatewayCloses('closed_by_desk'), said: 'stopped', override: { state: 'stopped', phase: 'stopped', retryAfterSeconds: null }, label: /asleep$/ },
];

for (const { close, say, said, override, label } of RESTS) {
  test(`${close}, and connect says ${said}: it rests, and nothing asks to wake`, async ({ page, request }) => {
    const { rig, errors } = await onlineSession(page, request);
    await harness(request, { connectOverride: override });
    const logMark = (await harnessLog(request)).length;
    await say(rig);
    await expect(proxy(page)).toHaveAccessibleName(label, { timeout: 10_000 });
    await page.waitForTimeout(4_000);
    expect((await harnessLog(request)).slice(logMark).filter(isConnect)).toEqual(['connect start=false']);
    expect(await openCount(page)).toBe(1);
    expect(errors).toEqual([]);
  });
}

test('a long outage: it keeps trying, says it cannot reach the desk, never that it is going to sleep, and is back as soon as deskd is', async ({ page, request }) => {
  const { rig, errors, frames } = await onlineSession(page, request);
  await watchLabels(page);
  const logMark = (await harnessLog(request)).length;
  const closedAt = Date.now();
  await closedByGateway(rig);
  await stack.stopDeskd();
  await expect(proxy(page)).toHaveAccessibleName(/reconnecting…$/, { timeout: 5_000 });
  await expect(proxy(page)).toHaveAccessibleName(/can't reach desk$/, { timeout: 35_000 });
  const outageMs = Date.now() - closedAt;

  const startedAt = Date.now();
  await stack.startDeskd();
  await expect.poll(() => openedAt(page, 1), { timeout: 15_000, intervals: [100] }).toBeGreaterThan(0);
  const recoveredMs = Math.round((await openedAt(page, 1)) - startedAt);
  const log = (await harnessLog(request)).slice(logMark);
  console.log(`outage ${outageMs} ms: new session ${recoveredMs} ms after deskd started; ${log.filter(isConnect).length} connects, ${log.filter((l) => l === 'GET /v1/desks').length} list polls`);
  expect(recoveredMs).toBeLessThan(3_000); // the push ends the wait, however long it had grown
  expect(log.filter((l) => l === 'GET /v1/desks')).toEqual([]);
  expect(log.filter(isConnect).length).toBeLessThanOrEqual(9); // about 2 s, then 3, 4.5, 6.75 and 10 s steps
  expect(new Set(log.filter(isConnect))).toEqual(new Set(['connect start=false']));
  expect(ofType(frames, 'sent', 'session.open')).toHaveLength(2);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 5_000 });
  expect(await seenLabels(page)).not.toContainEqual(expect.stringMatching(/going to sleep/));
  expect(errors).toEqual([]);
});

test('with the ready push lost, the next look finds deskd, no more than 10 s on', async ({ page, request }) => {
  const { rig, errors } = await onlineSession(page, request, { dropFromGateway: ['desk.progress'] });
  const closedAt = Date.now();
  await closedByGateway(rig);
  await stack.stopDeskd();
  await page.waitForTimeout(17_000 - (Date.now() - closedAt)); // just past the look at about 16 s, the next being 10 s off

  const startedAt = Date.now();
  await stack.startDeskd();
  await expect.poll(() => openedAt(page, 1), { timeout: 15_000, intervals: [100] }).toBeGreaterThan(0);
  const recoveredMs = Math.round((await openedAt(page, 1)) - startedAt);
  console.log(`push lost: new session ${recoveredMs} ms after deskd started`);
  expect(recoveredMs).toBeGreaterThan(3_000);
  expect(recoveredMs).toBeLessThan(12_000);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 5_000 });
  expect(errors).toEqual([]);
});

test('a 304 from the list leaves an open link alone', async ({ page, request }) => {
  const { errors, frames } = await onlineSession(page, request);
  const logMark = (await harnessLog(request)).length;
  await listJustPolled(page, request);
  const log = (await harnessLog(request)).slice(logMark);
  expect(log).toContain('list 304');
  expect(log.filter(isConnect)).toEqual([]);
  expect(ofType(frames, 'sent', 'session.open')).toHaveLength(1);
  expect(await openCount(page)).toBe(1);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE);
  expect(errors).toEqual([]);
});
