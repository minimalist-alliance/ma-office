// The walking skeleton that gates promotion to the owner's real desk: the shipping web app on staging's
// test host, through Platform's API and gateway, over WebRTC to the real desk-rtc and deskd on the
// real test desk. Serial, one browser context, no mocks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  API, APP, B14_MS, DESK_ID, aboutValues, apiToken, deskTruth, focusTestDesk, loadUser, onDesk, openAbout,
  percentile, signInApp, watch, type DeskTruth, type Watch,
} from './lib';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let w: Watch;
let truth: DeskTruth;
const report: Record<string, unknown> = {};
const note = (k: string, v: unknown) => { report[k] = v; console.log(`[e2e] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const marks = () => page.evaluate(() => (window as unknown as { __e2e: { marks: Record<string, number[]> } }).__e2e.marks);

/** Open the desk panel on the test desk and wait for live status. */
async function focusAndAbout(): Promise<string> {
  // The proxy buttons sit under the canvas (the keyboard and screen-reader path), so use the keyboard.
  await page.locator(`#proxy-${DESK_ID}`).focus();
  await page.keyboard.press('Enter');
  return openAbout(page);
}

test.beforeAll(async ({ browser }) => {
  mkdirSync('screenshots', { recursive: true });
  truth = await deskTruth();
  note('desk truth', { deskId: truth.deskId, deskdVersion: truth.deskdVersion, rtcVersion: truth.rtcVersion, publicIp: truth.publicIp });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  w = watch(page);
  await signInApp(context, page, loadUser('desk-1'));
});

test.afterAll(async () => {
  // Closing the context ends our sessions; the desk allows 4.
  await context?.close();
  writeFileSync('screenshots/report.json', JSON.stringify(report, null, 2));
});

test('1 sign-in to live status matches what the desk says', async () => {
  const name = await focusTestDesk(page, w);
  note('test desk name in list', name);
  let text: string;
  try { text = await focusAndAbout(); } catch (e) {
    await page.screenshot({ path: 'screenshots/1-failure.png' });
    note('failure page text', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400));
    note('proxy buttons', await page.locator('button.proxy').evaluateAll((els) => els.map((x) => x.id)));
    throw e;
  }
  const v = aboutValues(text);
  expect(truth.deskId).toBe(DESK_ID); // the desk itself agrees on its ID
  expect(v.deskId).toBe(DESK_ID);
  expect(v.deskdVersion).toBe(truth.deskdVersion);
  expect(v.rtcVersion).toBe(truth.rtcVersion);
  await page.screenshot({ path: 'screenshots/1-desk-panel.png' });
  expect(w.errors, 'console / CSP errors').toEqual([]);
});

test('2 WebRTC direct to the desk: public IPv4 on 443', async () => {
  const stats = await page.evaluate(async () => {
    const pcs = (window as unknown as { __e2e: { pcs: RTCPeerConnection[] } }).__e2e.pcs;
    const out: Record<string, unknown>[] = [];
    for (const pc of pcs) {
      if (pc.connectionState !== 'connected') continue;
      const s = await pc.getStats();
      let pairId = '';
      s.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      const pair = s.get(pairId);
      const remote = pair && s.get(pair.remoteCandidateId);
      const local = pair && s.get(pair.localCandidateId);
      if (remote) out.push({ remoteAddress: remote.address ?? remote.ip, remotePort: remote.port, remoteProtocol: remote.protocol, remoteType: remote.candidateType, localType: local?.candidateType, localProtocol: local?.protocol });
    }
    return out;
  });
  note('selected candidate pairs', stats);
  expect(stats.length, 'at least one connected RTCPeerConnection').toBeGreaterThan(0);
  const s = stats[stats.length - 1];
  expect(s.localType, 'not via TURN').not.toBe('relay');
  expect(s.remoteType, 'not via TURN').not.toBe('relay');
  expect(s.remoteAddress).toBe(truth.publicIp);
  expect(s.remotePort).toBe(443);
  const journal = await onDesk(`journalctl -u desk-rtc -u deskd --no-pager --since '10 minutes ago' | grep -iE 'session|peer|ice|dtls|offer|answer|webrtc' | tail -15 | cut -c1-220`);
  note('desk journal (session lines, last 10 min)', journal.trim().split('\n').slice(-8));
});

test('3 timing: session.open to first status, 5 opens, budget B14', async () => {
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.reload();
    await page.waitForFunction(() => {
      const m = (window as unknown as { __e2e?: { marks: Record<string, number[]> } }).__e2e?.marks;
      return !!m && m.sessionOpen.length > 0 && m.rpcMsg.length > 0;
    }, null, { timeout: 60_000 });
    const m = await marks();
    const ms = m.rpcMsg.find((t) => t >= m.sessionOpen[0])! - m.sessionOpen[0];
    samples.push(Math.round(ms));
    await sleep(3000);
  }
  const p50 = percentile(samples, 50), worst = Math.max(...samples);
  note('B14 session.open -> first rpc reply (ms)', { samples, first: samples[0], p50, worst, budget: B14_MS });
  // The first status must also be what the panel shows, so the mark is the status and not some other rpc reply.
  expect(aboutValues(await focusAndAbout()).deskdVersion).toBe(truth.deskdVersion);
  expect(p50, `p50 ${p50} ms vs B14 ${B14_MS} ms`).toBeLessThanOrEqual(B14_MS);
});

test('4 token refresh: one session stays live for 6+ minutes', async () => {
  await page.reload();
  await focusAndAbout();
  await page.keyboard.press('Escape');
  const t0 = Date.now();
  const before = (await marks()).rpcMsg.length;
  const boot0 = await page.evaluate(() => document.querySelector('[data-testid=about-desk]')?.textContent ?? '');
  void boot0;
  await sleep(6.5 * 60_000);
  const text = await focusAndAbout(); // opening the panel asks for a fresh desk.status.get
  const m = await marks();
  expect(m.rpcMsg.length, 'a fresh rpc reply after 6.5 min').toBeGreaterThan(before);
  const v = aboutValues(text);
  expect(v.deskId).toBe(DESK_ID);
  expect(v.deskdVersion).toBe(truth.deskdVersion);
  expect(text).not.toMatch(/Reconnecting|Can't reach/);
  expect(w.connectStatuses.filter((s) => s >= 400), 'no failed connect').toEqual([]);
  note('token refresh', { openedForSec: Math.round((Date.now() - t0) / 1000), rpcRepliesDuring: m.rpcMsg.length - before });
});

test('5 reconnect after a deskd restart, without a reload', async () => {
  await focusAndAbout();
  await page.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });
  const m0 = await marks();
  const rpcBefore = m0.rpcMsg.length, pcBefore = m0.pcCreated.length;
  const tIssue = Date.now();
  await onDesk('systemctl restart deskd && systemctl is-active deskd', 120);
  const tRestarted = Date.now();
  // Recovered = the tab built a new PeerConnection by itself, the rpc channel answered on it, and the panel is live again.
  // (The bootId is the OS boot, so it doesn't change when only deskd restarts; the new PeerConnection is the proof.)
  let tLive = 0;
  const panel = page.getByTestId('about-desk');
  while (Date.now() - tIssue < 180_000) {
    const m = await marks();
    const txt = await panel.innerText().catch(() => '');
    if (m.pcCreated.length > pcBefore && m.rpcMsg.filter((t) => t > m.pcCreated[pcBefore]).length > 0 && /^Service/.test(txt)) { tLive = Date.now(); break; }
    await sleep(250);
  }
  note('deskd restart', { restartCommandSec: +((tRestarted - tIssue) / 1000).toFixed(1), recoveredAfterIssueSec: tLive ? +((tLive - tIssue) / 1000).toFixed(1) : null, recoveredAfterRestartDoneSec: tLive ? +((tLive - tRestarted) / 1000).toFixed(1) : null, newPeerConnections: (await marks()).pcCreated.length - pcBefore });
  expect(tLive, 'panel live again on a new connection within 180 s').toBeGreaterThan(0);
  expect(aboutValues(await panel.innerText()).deskdVersion).toBe(truth.deskdVersion);
  expect(await page.evaluate(() => (window as unknown as { __sentinel?: number }).__sentinel), 'no reload happened').toBe(1);
  await page.screenshot({ path: 'screenshots/5-after-restart.png' });
});

test('6 access: another account is refused for this desk', async () => {
  const names = (await onDeskNames()).filter((n) => n !== 'desk-1');
  note('other test accounts in SSM', names);
  test.skip(names.length === 0, 'no second test account under /ma/staging/test-users/');
  const other = names.includes('member-1') ? 'member-1' : names[0];
  const ctx2 = await context.browser()!.newContext();
  try {
    const token = await apiToken(ctx2, loadUser(other));
    // start:false never wakes anything.
    const fp = 'sha-256 ' + Array.from({ length: 32 }, (_, i) => ((i * 7 + 3) & 255).toString(16).padStart(2, '0').toUpperCase()).join(':');
    const post = (headers: Record<string, string>) => fetch(`${API}/v1/desks/${DESK_ID}/connect`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ clientDtlsFingerprint: fp, start: false }) });
    const refused = await post({ authorization: `Bearer ${token}` });
    const body = await refused.json().catch(() => ({}));
    const anon = await post({});
    note('access', { account: other, connectStatus: refused.status, errorCode: body?.error?.code ?? null, deskTokenIssued: 'deskToken' in body, anonymousStatus: anon.status });
    expect([403, 404]).toContain(refused.status);
    expect('deskToken' in body).toBe(false);
    expect([401, 403]).toContain(anon.status);
  } finally {
    await ctx2.close();
  }
});

async function onDeskNames(): Promise<string[]> {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('aws', ['ssm', 'get-parameters-by-path', '--path', '/ma/staging/test-users/', '--query', 'Parameters[].Name', '--output', 'text'], { encoding: 'utf8', env: { ...process.env, AWS_REGION: 'us-east-1' } });
  return out.trim().split(/\s+/).filter(Boolean).map((n) => n.split('/').pop()!);
}
void APP;
