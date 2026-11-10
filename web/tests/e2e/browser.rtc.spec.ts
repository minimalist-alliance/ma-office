// The Browser window on real media: the shipping bundle, real desk-rtc and real WebRTC, with ffmpeg as desk-stream
// and fake-deskd as deskd. So H.264 is really decoded and audio really plays. fake-deskd has no tab methods and
// no X display, so tabs are the `shell` project's, and injection into X is desk-rtc's own proof (test/stream/).
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { encodeJson, Kind } from '../../src/desk/rtc/frames';
import { FakeDeskStream } from './fakeDeskStream';
import { harness, signIn, watchConsole } from './helpers';
import { buildTools, Stack } from './rtcStack';

const EVIDENCE = resolve('test-results/rtc-browser');
const stack = new Stack(EVIDENCE, true);
let stream: FakeDeskStream;

interface PageHooks {
  __pcs: RTCPeerConnection[];
  __channels: Record<string, RTCDataChannel>;
  __tracks: { kind: string; trackId: string; streamId: string | undefined }[];
  __sent: { label: string; bytes: number[] }[];
  RTCPeerConnection: typeof RTCPeerConnection;
}

/** Records the page's PeerConnections and what it writes to channels. Changes no behaviour. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as PageHooks;
    w.__pcs = [];
    w.__channels = {};
    w.__tracks = [];
    w.__sent = [];
    const Native = window.RTCPeerConnection;
    w.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config);
        w.__pcs.push(this);
        this.addEventListener('track', (e: RTCTrackEvent) => {
          w.__tracks.push({ kind: e.track.kind, trackId: e.track.id, streamId: e.streams[0]?.id });
        });
      }

      override createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
        const dc = super.createDataChannel(label, init);
        w.__channels[label] = dc;
        return dc;
      }
    };
    const send = RTCDataChannel.prototype.send as (this: RTCDataChannel, d: Uint8Array<ArrayBuffer>) => void;
    (RTCDataChannel.prototype as unknown as { send: typeof send }).send = function sendAndRecord(d) {
      w.__sent.push({ label: this.label, bytes: [...d] });
      send.call(this, d);
    };
  });
}

const browserWindow = (page: Page) => page.getByRole('dialog', { name: /Browser/ });
const video = (page: Page) => page.getByTestId('browser-video');
const panel = (page: Page) => page.getByTestId('browser-panel');

async function openBrowser(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /^Personal desk, 4 apps, online/ })).toHaveCount(1, { timeout: 20_000 });
  await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(browserWindow(page)).toBeVisible();
}

const frames = (page: Page): Promise<number> => video(page).evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);

async function expectPicture(page: Page): Promise<void> {
  await expect(panel(page)).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight]), { timeout: 10_000 }).toEqual([1280, 800]);
  const before = await frames(page);
  await expect.poll(() => frames(page), { timeout: 10_000 }).toBeGreaterThan(before);
}

/** One RPC on the page's own `rpc` channel, reading the reply straight from it, as `test.*` needs. */
async function rpc<T>(page: Page, m: string): Promise<T> {
  const id = 900_000 + Math.floor(Math.random() * 90_000);
  const bytes = [...(encodeJson(Kind.REQ, id, { m, p: {} })[0] as Uint8Array)];
  return page.evaluate(
    ({ id: reqId, frame }) =>
      new Promise<T>((done, fail) => {
        const dc = (window as unknown as PageHooks).__channels['rpc'] as RTCDataChannel;
        const onMessage = (e: MessageEvent<ArrayBuffer>): void => {
          const view = new DataView(e.data);
          if (view.getUint32(4) !== reqId) return;
          dc.removeEventListener('message', onMessage);
          done(JSON.parse(new TextDecoder().decode(new Uint8Array(e.data, 12))) as T);
        };
        dc.addEventListener('message', onMessage);
        window.setTimeout(() => fail(new Error('no reply')), 5_000);
        dc.send(new Uint8Array(frame));
      }),
    { id, frame: bytes },
  );
}

interface RtcStats {
  stream?: { state?: string; viewers?: number; videoPackets?: number; audioPackets?: number };
  sessions?: { viewing?: boolean; inputDropped?: number; keysDropped?: number; rtpDropped?: number }[];
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test.beforeAll(async () => {
  test.setTimeout(600_000);
  rmSync(EVIDENCE, { recursive: true, force: true });
  mkdirSync(EVIDENCE, { recursive: true });
  buildTools();
  await stack.start();
  stream = new FakeDeskStream(stack.streamSocket);
  await stream.start();
});

test.afterAll(async () => {
  stream.stop();
  await stack.stop();
});

test.beforeEach(async ({ request }) => {
  stream.silent = false;
  await harness(request, { reset: true });
  await harness(request, { shim: stack.api });
});

test('real H.264 and Opus reach the video element, on the offer as today, with nothing renegotiated', async ({ page }) => {
  const errors = watchConsole(page);
  await instrument(page);
  await signIn(page);
  await openBrowser(page);
  await expectPicture(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(EVIDENCE, 'browser-live.png') });

  const facts = await page.evaluate(() => {
    const w = window as unknown as PageHooks;
    const pc = w.__pcs[w.__pcs.length - 1] as RTCPeerConnection;
    const v = document.querySelector('[data-testid="browser-video"]') as HTMLVideoElement;
    const receiver = pc.getReceivers().find((r) => r.track.kind === 'video') as RTCRtpReceiver & { jitterBufferTarget?: number | null };
    return {
      tracks: w.__tracks,
      streamTracks: (v.srcObject as MediaStream).getTracks().map((t) => t.kind).sort(),
      jitterBufferTarget: receiver.jitterBufferTarget,
      playsInline: v.playsInline,
      paused: v.paused,
      muted: v.muted,
      senders: pc.getSenders().filter((s) => s.track).length,
    };
  });
  console.log(`tracks ${JSON.stringify(facts.tracks)}, jitterBufferTarget ${facts.jitterBufferTarget}`);
  expect(facts.streamTracks).toEqual(['audio', 'video']);
  expect(facts.tracks.map((t) => [t.kind, t.streamId]).sort()).toEqual([['audio', 'desk-audio'], ['video', 'desk-video']]);
  expect(facts.jitterBufferTarget).toBe(0);
  expect(facts.playsInline).toBe(true);
  expect(facts.paused).toBe(false);
  expect(facts.muted).toBe(false);
  expect(facts.senders).toBe(0);

  const stats = await rpc<RtcStats>(page, 'test.rtc.stats');
  expect(stats.stream?.state).toBe('live');
  expect(stats.stream?.viewers).toBe(1);
  expect(stats.stream?.audioPackets).toBeGreaterThan(0);
  expect(stats.sessions?.[0]?.viewing).toBe(true);
  expect(stream.commands).toContain('resume');
  expect(errors).toEqual([]);
});

test('closing the window pauses the stream, and opening it again is quick', async ({ page }) => {
  await instrument(page);
  await signIn(page);
  await openBrowser(page);
  await expectPicture(page);
  await page.keyboard.press('Shift+Escape');
  await expect(browserWindow(page)).toHaveCount(0);
  await expect.poll(async () => (await rpc<RtcStats>(page, 'test.rtc.stats')).stream?.viewers ?? -1).toBe(0);
  await expect.poll(async () => (await rpc<RtcStats>(page, 'test.rtc.stats')).stream?.state).toBe('warm');

  const start = Date.now();
  await openBrowser(page);
  await expectPicture(page);
  console.log(`window open to picture moving: ${Date.now() - start} ms`);
});

test('no H.264 in the offer: the desk answers m=video 0, the window says so, and the data path stays', async ({ page }) => {
  const errors = watchConsole(page);
  await instrument(page);
  await page.routeWebSocket(/\/v1$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { type: string; data?: { type?: string; sdp?: string } };
      if (msg.type === 'signal' && msg.data?.type === 'offer' && msg.data.sdp) msg.data.sdp = withoutH264(msg.data.sdp);
      server.send(JSON.stringify(msg));
    });
    server.onMessage((m) => ws.send(m));
  });
  await signIn(page);
  await openBrowser(page);
  await expect(panel(page)).toHaveAttribute('data-panel', 'unplayable');
  await expect(video(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(EVIDENCE, 'browser-unplayable.png') });
  const sent = await page.evaluate(() => (window as unknown as PageHooks).__sent.filter((s) => s.label === 'rpc').map((s) => new TextDecoder().decode(new Uint8Array(s.bytes).subarray(12))));
  expect(sent.some((s) => s.includes('browser.stream.set'))).toBe(false);
  expect(errors).toEqual([]);
});

test('real input: every event is accepted by the real desk-rtc, on the right channel, and none dropped', async ({ page }) => {
  const errors = watchConsole(page);
  await instrument(page);
  await signIn(page);
  await openBrowser(page);
  await expectPicture(page);
  const b = (await video(page).boundingBox()) as { x: number; y: number; width: number; height: number };
  const before = (await rpc<{ inputActivity: number }>(page, 'test.counters')).inputActivity;

  await page.mouse.move(b.x + 100, b.y + 100);
  await page.mouse.move(b.x + 200, b.y + 150, { steps: 10 });
  await page.waitForTimeout(100);
  await page.mouse.click(b.x + 200, b.y + 150);
  await page.mouse.click(b.x + 210, b.y + 150, { button: 'right' });
  await page.mouse.click(b.x + 210, b.y + 150, { button: 'middle' });
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(50);
  await expect(page.getByTestId('browser-keys')).toBeFocused();
  await page.keyboard.type('Hi!');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowLeft');
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); // RELEASE_ALL
  await page.waitForTimeout(200);

  const sent = await page.evaluate(() => (window as unknown as PageHooks).__sent.filter((s) => s.label === 'input' || s.label === 'keys'));
  expect(sent.length).toBeGreaterThan(10);
  expect(sent.every((m) => m.bytes.length === 16)).toBe(true);
  const seqOf = (m: { bytes: number[] }): number => new DataView(new Uint8Array(m.bytes).buffer).getUint32(4);
  expect(sent.map(seqOf)).toEqual(sent.map((_, i) => i + 1)); // one counter across both channels, from 1
  expect(new Set(sent.filter((m) => m.label === 'input').map((m) => m.bytes[0]))).toEqual(new Set([1])); // MOVE only
  // HOLD (6) goes on keys too, not as input, when the picture hold had engaged before the input began (pictureHold.ts, ADR 0037),
  // and QUALITY (7) as keys opens (stream-quality.md section 3).
  expect(new Set(sent.filter((m) => m.label === 'keys' && m.bytes[0] !== 6 && m.bytes[0] !== 7).map((m) => m.bytes[0]))).toEqual(new Set([2, 3, 4, 5]));

  const stats = await rpc<RtcStats>(page, 'test.rtc.stats');
  expect(stats.sessions?.[0]?.inputDropped ?? 0).toBe(0); // desk-rtc counts any it can't parse
  expect(stats.sessions?.[0]?.keysDropped ?? 0).toBe(0);
  const after = (await rpc<{ inputActivity: number }>(page, 'test.counters')).inputActivity;
  expect(after).toBeGreaterThan(before);
  console.log(`${sent.length} input events, none dropped; input.activity ${before} to ${after}`);
  expect(errors).toEqual([]);
});

test('a desk with no clipboard yet: a paste takes the old way with no key, 1 MB crosses the real channel, and a copy touches nothing', async ({ page, context }) => {
  const errors = watchConsole(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await instrument(page);
  await signIn(page);
  await openBrowser(page);
  await expectPicture(page);
  await page.evaluate(() => navigator.clipboard.writeText('the member had this'));
  const b = (await video(page).boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.getByTestId('browser-keys')).toBeFocused();

  // What went out on `rpc`, by method, reading only the first frame of each message.
  const methods = (): Promise<string[]> =>
    page.evaluate(() =>
      (window as unknown as PageHooks).__sent
        .filter((s) => s.label === 'rpc' && s.bytes[1] === 7)
        .map((s) => /^\{"m":"([^"]+)"/.exec(new TextDecoder().decode(new Uint8Array(s.bytes).subarray(12)))?.[1] ?? '')
        .filter((m) => m.startsWith('browser.clipboard') || m === 'browser.text.insert'),
    );
  const pasteKeysSent = (): Promise<number> =>
    page.evaluate(() =>
      (window as unknown as PageHooks).__sent.filter((s) => {
        if (s.label !== 'keys' || s.bytes[0] !== 4) return false;
        return new DataView(new Uint8Array(s.bytes).buffer).getUint32(12) === 0x76;
      }).length,
    );

  await page.keyboard.press('Control+v');
  await expect.poll(methods).toEqual(['browser.clipboard.write', 'browser.text.insert']); // fake-deskd knows neither
  await expect(page.getByTestId('browser-notice')).toHaveText("That text didn't reach the page.");
  expect(await pasteKeysSent()).toBe(0);

  // The real framing takes it, and the session carries on. It's `not_found` by now, so this one goes the old way too.
  await page.getByTestId('browser-keys').evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'a'.repeat(1_000_000));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await methods()).length).toBeGreaterThanOrEqual(3);
  expect((await rpc<{ inputActivity: number }>(page, 'test.counters')).inputActivity).toBeGreaterThan(0);
  expect(await pasteKeysSent()).toBe(0);

  // No `changed` can come from here, so the chord is only a key.
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(2_200);
  expect((await methods()).filter((m) => m === 'browser.clipboard.read')).toEqual([]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('the member had this');
  expect(errors).toEqual([]);
});

test('a CURSOR on the real keys channel becomes the pointer, under the shipping CSP', async ({ page }) => {
  const errors = watchConsole(page);
  await instrument(page);
  await signIn(page);
  await openBrowser(page);
  await expectPicture(page);
  // A real 1x1 PNG. With no X display desk-rtc has no cursor to send, so this arrives as if it had.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';
  await page.evaluate((b64) => {
    const body = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const m = new Uint8Array(10 + body.length);
    const v = new DataView(m.buffer);
    m[0] = 0x81;
    v.setUint16(2, 3);
    v.setUint16(4, 4);
    v.setUint16(6, 1);
    v.setUint16(8, 1);
    m.set(body, 10);
    (window as unknown as PageHooks).__channels['keys']?.dispatchEvent(new MessageEvent('message', { data: m.buffer }));
  }, png);
  expect(await video(page).evaluate((v: HTMLVideoElement) => v.style.cursor)).toContain('data:image/png;base64,');
  const b = (await video(page).boundingBox()) as { x: number; y: number };
  await page.mouse.move(b.x + 50, b.y + 50); // the image is fetched when it's needed, under img-src data:
  await page.waitForTimeout(150);
  expect(errors).toEqual([]);
});

/** This page's sessions, not a closed page's that the shim still holds for its resume window. */
async function sessionsSince(): Promise<() => Promise<string[]>> {
  const before = (await stack.state()).sessions;
  return async () => (await stack.state()).sessions.filter((id) => !before.includes(id));
}

test('the idle rule, on the real path: 60 minutes hidden closes the session, keeps the watch, and never asks to wake', async ({ page, request }) => {
  const errors = watchConsole(page);
  const mine = await sessionsSince();
  stream.silent = true; // a desk playing sound keeps its session (task 22), which has its own test
  await page.clock.install();
  await instrument(page);
  await signIn(page);
  await openBrowser(page);
  await expectPicture(page);
  expect(await mine()).toHaveLength(1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => (window as unknown as { __hidden: boolean }).__hidden });
    (window as unknown as { __hidden: boolean }).__hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward('59:00');
  await page.waitForTimeout(300);
  expect(await mine()).toHaveLength(1);
  await page.clock.fastForward('02:00');
  await expect.poll(mine, { timeout: 10_000 }).toHaveLength(0);
  await expect(page.getByRole('button', { name: /^Personal desk, 4 apps, paused, no recent input$/ })).toHaveCount(1);

  await page.evaluate(() => {
    (window as unknown as { __hidden: boolean }).__hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(mine, { timeout: 20_000 }).toHaveLength(1);
  await expectPicture(page);
  const log = ((await (await request.get('/__harness')).json()) as { log: string[] }).log.filter((l) => l.startsWith('connect start='));
  expect(log.length).toBeGreaterThan(1);
  expect(log.every((l) => l === 'connect start=false')).toBe(true);
  expect(errors).toEqual([]);
});

/** `document.hidden` as the test says. Chromium headless never hides a page by itself. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    const w = window as unknown as { __hidden?: boolean };
    if (w.__hidden === undefined) Object.defineProperty(document, 'hidden', { configurable: true, get: () => w.__hidden });
    w.__hidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** The page's own audio receiver: packets and energy, as `peer.ts` reads them. */
const audioIn = (page: Page): Promise<{ packets: number; energy: number }> =>
  page.evaluate(async () => {
    const w = window as unknown as PageHooks;
    const pc = w.__pcs[w.__pcs.length - 1] as RTCPeerConnection;
    let out = { packets: 0, energy: 0 };
    (await pc.getReceivers().find((r) => r.track.kind === 'audio')?.getStats())?.forEach((r: { type: string; packetsReceived?: number; totalAudioEnergy?: number }) => {
      if (r.type === 'inbound-rtp') out = { packets: r.packetsReceived ?? 0, energy: r.totalAudioEnergy ?? 0 };
    });
    return out;
  });

test('sound in a hidden tab (task 22): it plays on past 5 and 60 minutes, and a minute after it stops the stream goes warm and the session closes', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  const mine = await sessionsSince();
  await page.clock.install();
  await instrument(page);
  await signIn(page);
  await openBrowser(page);
  await expectPicture(page);
  const before = await audioIn(page);
  await page.waitForTimeout(1_000);
  expect((await audioIn(page)).energy).toBeGreaterThan(before.energy); // the fake desk's 440 Hz is really heard

  const from = stream.commands.length;
  await setHidden(page, true);
  // Fake time goes on in steps shorter than the quiet minute, each with a real second for the stats to hear the sound,
  // as a hidden tab's timers still run once a second. One big jump would be a laptop asleep, which hears nothing.
  for (let minutes = 0; minutes < 66; minutes += 0.75) {
    await page.clock.fastForward('00:45');
    await page.waitForTimeout(1_000);
  }
  const playing = await rpc<RtcStats>(page, 'test.rtc.stats');
  expect(playing.stream?.state).toBe('live');
  expect(playing.sessions?.[0]?.viewing).toBe(true);
  expect(await mine()).toHaveLength(1);
  const late = await audioIn(page);
  await page.waitForTimeout(1_000);
  expect((await audioIn(page)).packets).toBeGreaterThan(late.packets);
  expect(stream.commands.slice(from)).not.toContain('pause');

  stream.silent = true;
  await page.waitForTimeout(1_500); // the stats hear the silence
  await page.clock.fastForward('00:45');
  await page.waitForTimeout(500);
  expect((await rpc<RtcStats>(page, 'test.rtc.stats')).stream?.state).toBe('live'); // not yet a minute
  await page.clock.fastForward('00:30');
  await expect.poll(async () => (await rpc<RtcStats>(page, 'test.rtc.stats').catch(() => ({}) as RtcStats)).stream?.state, { timeout: 10_000 }).toBe('warm');
  expect(stream.commands.slice(from)).toContain('pause');
  // Past 60 minutes hidden, and the sound has stopped: the next checks close the session, as before.
  await page.clock.fastForward('01:00');
  await page.waitForTimeout(300);
  await page.clock.fastForward('01:00');
  await expect.poll(mine, { timeout: 10_000 }).toHaveLength(0);

  stream.silent = false;
  await setHidden(page, false);
  await expect.poll(mine, { timeout: 20_000 }).toHaveLength(1);
  await expectPicture(page);
  const log = ((await (await request.get('/__harness')).json()) as { log: string[] }).log.filter((l) => l.startsWith('connect start='));
  expect(log.every((l) => l === 'connect start=false')).toBe(true);
  expect(errors).toEqual([]);
});

test('sound in a hidden tab (task 22): coming back brings nothing to wait for, because the picture never stopped', async ({ page }) => {
  await page.clock.install();
  await instrument(page);
  await signIn(page);
  await openBrowser(page);
  await expectPicture(page);
  await setHidden(page, true);
  for (let minutes = 0; minutes < 6; minutes += 0.75) {
    await page.clock.fastForward('00:45');
    await page.waitForTimeout(1_000);
  }
  expect((await rpc<RtcStats>(page, 'test.rtc.stats')).stream?.state).toBe('live');
  const sets = (): Promise<number> => page.evaluate(() => (window as unknown as PageHooks).__sent.filter((m) => m.label === 'rpc' && new TextDecoder().decode(new Uint8Array(m.bytes)).includes('browser.stream.set')).length);
  const asked = await sets();
  await setHidden(page, false);
  const start = Date.now();
  await expectPicture(page);
  console.log(`back to frames advancing: ${Date.now() - start} ms`);
  expect(await sets()).toBe(asked);
});

test('24 hours with no input closes it even when visible, and the next click brings it back', async ({ page, request }) => {
  const mine = await sessionsSince();
  await page.clock.install();
  // A certificate's `expires` runs on the real clock, so past a day of fake time every one would look expired.
  await page.addInitScript(() => {
    Object.defineProperty(RTCCertificate.prototype, 'expires', { get: () => Number.MAX_SAFE_INTEGER });
  });
  await instrument(page);
  await signIn(page);
  await openBrowser(page);
  await expectPicture(page);
  await page.clock.fastForward('23:59:00');
  await page.waitForTimeout(300);
  expect(await mine()).toHaveLength(1);
  await page.clock.fastForward('02:00');
  await expect.poll(mine, { timeout: 10_000 }).toHaveLength(0);
  await expect(panel(page)).toHaveAttribute('data-panel', 'resting');
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(EVIDENCE, 'browser-resting.png') });
  await panel(page).click();
  await expect.poll(mine, { timeout: 20_000 }).toHaveLength(1);
  await expectPicture(page);
  const log = ((await (await request.get('/__harness')).json()) as { log: string[] }).log.filter((l) => l.startsWith('connect start='));
  expect(log.every((l) => l === 'connect start=false')).toBe(true);
});

test('a desk restart holds the last frame under a scrim, and the picture comes back by itself', async ({ page }) => {
  await instrument(page);
  await signIn(page);
  await openBrowser(page);
  await expectPicture(page);
  const lastFrames = await frames(page);
  await stack.killDesk();
  await expect(panel(page)).toHaveAttribute('data-panel', /reconnecting|opening/, { timeout: 25_000 });
  await expect(panel(page)).toHaveClass(/over-picture/);
  // Past the ICE restart the PeerConnection is closed, and that's when the element itself goes black.
  await expect(page.getByTestId('browser-held')).toBeVisible({ timeout: 25_000 });
  const held = await page.getByTestId('browser-held').evaluate((c: HTMLCanvasElement) => {
    const [r, g, b] = (c.getContext('2d') as CanvasRenderingContext2D).getImageData(c.width / 8, c.height / 2, 1, 1).data;
    return { width: c.width, bright: (r as number) + (g as number) + (b as number) };
  });
  expect(held.width).toBe(1280);
  expect(held.bright).toBeGreaterThan(100); // testsrc2 is all color
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(EVIDENCE, 'browser-reconnecting.png') });
  await stack.startDesk();
  await expectPicture(page);
  await expect(page.getByTestId('browser-held')).toBeHidden();
  await page.screenshot({ path: join(EVIDENCE, 'browser-recovered.png') });
  console.log(`frames before the restart ${lastFrames}`);
});

// ----- Stream quality (ADR 0039, docs/interfaces/stream-quality.md): the player's QUALITY on the real `keys`, the
// `level` line the real desk-rtc sends desk-stream, and desk-rtc's stats. ffmpeg doesn't follow `level`, so what a
// level does to the picture is desk-stream's own proof (section 5); this is everything up to that line.

const ME = 'u-test'; // the harness's member

interface QualityStats {
  stream?: { viewers?: number; level?: string; limit?: string | null };
  sessions?: { sessionId?: string; viewing?: boolean; quality?: string; keysDropped?: number }[];
}

const levelLines = (from = 0) => stream.lines.slice(from).filter((l) => l.line.startsWith('level '));

/** The QUALITY events the page sent on `keys`. */
const qualitySent = (page: Page): Promise<number[][]> =>
  page.evaluate(() => (window as unknown as PageHooks).__sent.filter((s) => s.label === 'keys' && s.bytes[0] === 7).map((s) => s.bytes));

/** desk-rtc's "session created", once per `session.create` from fake-deskd, in every desk-rtc this spec started. */
const sessionsCreated = (): number => readFileSync(join(EVIDENCE, 'desk-rtc.log'), 'utf8').split('\n').filter((l) => l.includes('msg="session created"')).length;

/** Online, and no closed page's session still viewing: the level in effect is the highest ask among viewers. */
async function onlyViewerToBe(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /^Personal desk, 4 apps, online/ })).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(async () => (await rpc<QualityStats>(page, 'test.rtc.stats').catch(() => ({}) as QualityStats)).stream?.viewers, { timeout: 40_000 }).toBe(0);
}

test('stream quality never set: desk-stream heard "level high" first, and the QUALITY the page sends changes nothing', async ({ page }) => {
  const errors = watchConsole(page);
  const from = stream.lines.length;
  // desk-rtc's first line on every desk-stream connection, before resume, with or without viewers.
  expect(stream.lines.find((l) => l.conn === stream.conns)?.line).toBe('level high');
  expect(levelLines().at(-1)?.line).toBe('level high');
  const mine = await sessionsSince();
  await instrument(page);
  await signIn(page);
  await onlyViewerToBe(page);
  await openBrowser(page);
  await expectPicture(page);
  const settled = stream.lines.length;
  await page.waitForTimeout(2_000);

  // Once, as keys opened, at High, with this session's seq, and not again.
  const sent = await qualitySent(page);
  expect(sent.map((b) => [b.length, ...b.slice(0, 4)])).toEqual([[16, 7, 3, 0, 0]]);
  expect(new DataView(new Uint8Array(sent[0] as number[]).buffer).getUint32(4)).toBeGreaterThan(0);
  // Already High: no line, so desk-stream forces no keyframe for it, and nothing more once the picture is up.
  expect(levelLines(from)).toEqual([]);
  expect(stream.lines.slice(settled).map((l) => l.line).filter((l) => l === 'keyframe' || l.startsWith('level '))).toEqual([]);
  const keyframes = stream.lines.slice(from).filter((l) => l.line === 'keyframe').length;
  expect(keyframes).toBeLessThanOrEqual(10); // a join's own: one, then one per 150 ms until ffmpeg's next (1 s GOP)

  const [id] = await mine();
  const stats = await rpc<QualityStats>(page, 'test.rtc.stats');
  expect(stats.stream?.level).toBe('high');
  expect(stats.stream?.limit).toBeNull();
  expect(stats.sessions?.find((s) => s.sessionId === id)).toMatchObject({ viewing: true, quality: 'high' });
  expect(stats.sessions?.find((s) => s.sessionId === id)?.keysDropped ?? 0).toBe(0);
  console.log(`keyframe requests for the join: ${keyframes}`);
  expect(errors).toEqual([]);
});

test('a Low override saved before the window opens: desk-stream hears "level low" within 1 s of live', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { streamQualityDocs: { [ME]: { default: 'high', apps: { browser: 'low' }, updatedAt: '2026-11-06T10:00:00.000Z' } } });
  const mine = await sessionsSince();
  await instrument(page);
  await signIn(page);
  await onlyViewerToBe(page);
  const from = stream.lines.length;
  expect(levelLines().at(-1)?.line).toBe('level high');
  await openBrowser(page);
  await expectPicture(page);
  await expect(page.getByRole('button', { name: /^Picture quality/ })).toHaveAccessibleName('Picture quality: Low');

  const live = stream.lines.slice(from).find((l) => l.line === 'resume');
  const low = levelLines(from).find((l) => l.line === 'level low');
  expect(live).toBeTruthy();
  expect(low).toBeTruthy();
  console.log(`level low ${(low?.at ?? 0) - (live?.at ?? 0)} ms from resume`);
  expect(Math.abs((low?.at ?? 0) - (live?.at ?? 0))).toBeLessThanOrEqual(1_000);
  expect(levelLines(from).map((l) => l.line)).toEqual(['level low']);
  expect((await qualitySent(page)).at(-1)?.slice(0, 3)).toEqual([7, 1, 0]);

  const [id] = await mine();
  const stats = await rpc<QualityStats>(page, 'test.rtc.stats');
  expect(stats.stream?.level).toBe('low');
  expect(stats.stream?.limit).toBeNull();
  expect(stats.sessions?.find((s) => s.sessionId === id)).toMatchObject({ viewing: true, quality: 'low' });
  expect(errors).toEqual([]);
});

test('a change in the Picture quality menu while live: a new level line within about 1 s, paced, and nothing reconnects', async ({ page, request }) => {
  const errors = watchConsole(page);
  const mine = await sessionsSince();
  await instrument(page);
  await signIn(page);
  await onlyViewerToBe(page);
  await openBrowser(page);
  await expectPicture(page);
  const ids = await mine();
  expect(ids).toHaveLength(1);
  await page.waitForTimeout(600); // past desk-rtc's pace from this session's own line, if it sent one
  const created = sessionsCreated();
  const streamSets = (): Promise<number> => page.evaluate(() => (window as unknown as PageHooks).__sent.filter((m) => m.label === 'rpc' && new TextDecoder().decode(new Uint8Array(m.bytes)).includes('browser.stream.set')).length);
  const setsBefore = await streamSets();
  const pcs = (): Promise<string[]> => page.evaluate(() => (window as unknown as PageHooks).__pcs.map((pc) => pc.connectionState));
  const pcsBefore = await pcs();
  expect(pcsBefore.at(-1)).toBe('connected');
  await page.evaluate(() => {
    const w = window as unknown as PageHooks & { __replies: number[][] };
    w.__replies = [];
    w.__channels['keys']?.addEventListener('message', (e: MessageEvent<ArrayBuffer>) => {
      const b = new Uint8Array(e.data);
      if (b[0] === 0x82) w.__replies.push([...b]);
    });
  });
  const replies = (): Promise<number[][]> => page.evaluate(() => (window as unknown as { __replies: number[][] }).__replies.map((b) => b.slice(0, 5)));
  const from = stream.lines.length;
  const button = page.getByRole('button', { name: /^Picture quality/ });
  const choice = (name: string) => page.getByRole('menu', { name: 'Picture quality' }).getByRole('menuitemradio', { name, exact: true });

  await button.click();
  const askedMedium = Date.now();
  await choice('Medium').click();
  await expect.poll(() => levelLines(from).map((l) => l.line), { timeout: 3_000 }).toEqual(['level medium']);
  const medium = levelLines(from)[0] as { at: number };
  await button.click();
  const askedLow = Date.now();
  await choice('Low').click();
  await expect.poll(() => levelLines(from).map((l) => l.line), { timeout: 3_000 }).toEqual(['level medium', 'level low']);
  const low = levelLines(from)[1] as { at: number };
  console.log(`level medium ${medium.at - askedMedium} ms after the choice, level low ${low.at - askedLow} ms, ${low.at - medium.at} ms apart`);
  expect(medium.at - askedMedium).toBeLessThanOrEqual(1_000);
  expect(low.at - askedLow).toBeLessThanOrEqual(1_000);
  expect(low.at - medium.at).toBeGreaterThanOrEqual(450); // desk-rtc's 500 ms pace, less the socket's jitter
  // The desk's reply on keys follows, at what was chosen, so the menu has no reason to give.
  await expect.poll(replies).toEqual([[0x82, 2, 0, 0, 0], [0x82, 1, 0, 0, 0]]);
  await button.click();
  await expect(choice('Low')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('quality-reason')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect.poll(async () => ((await (await request.get('/__harness')).json()) as { streamQualityDocs?: Record<string, { apps: Record<string, string> }> }).streamQualityDocs?.[ME]?.apps).toEqual({ browser: 'low' });

  const stats = await rpc<QualityStats>(page, 'test.rtc.stats');
  expect(stats.stream?.level).toBe('low');
  expect(stats.sessions?.find((s) => s.sessionId === ids[0])).toMatchObject({ viewing: true, quality: 'low' });
  // The same session, PeerConnection and stream: no session.create, no new offer, no stream.set again.
  const before = await frames(page);
  await expect.poll(() => frames(page)).toBeGreaterThan(before);
  expect(await mine()).toEqual(ids);
  expect(await pcs()).toEqual(pcsBefore);
  expect(await streamSets()).toBe(setsBefore);
  await page.waitForTimeout(300); // desk-rtc's log reaches the file through a pipe
  expect(sessionsCreated()).toBe(created);
  await expect(panel(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

/** What a browser without H.264 would offer. */
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
