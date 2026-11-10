// A self-hosted desk, end to end on staging (README.md): pair it from a test account's Platform page, open it from that
// account's office, stream the Browser and open Notebook, check the connection went straight to the desk on the home
// network, then reboot the desk's machine and do it again. The real API, gateway and signaling; no mocks.
//
// Needs: SELFHOST_SSH, a command that runs its argument on the desk as a sudoer (an ssh wrapper); SELFHOST_REBOOT, a
// command that reboots the desk's machine from outside it (e.g. the hypervisor's); SELFHOST_USER, the staging test
// user's name in SSM (/ma/staging/test-users/<name>). Never the owner's account: the guard below refuses anything that
// isn't @test.minimalistalliance.com. Addresses are compared, never printed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { generate } from 'otplib';

const APP = 'https://office.staging.minimalistalliance.com';
const PLATFORM = 'https://platform.staging.minimalistalliance.com';
const API = 'https://api.staging.minimalistalliance.com';
const SSH = process.env.SELFHOST_SSH ?? '';
const REBOOT = process.env.SELFHOST_REBOOT ?? '';
const USER = process.env.SELFHOST_USER ?? 'selfhost-31';
const DESK_NAME = process.env.SELFHOST_DESK_NAME ?? 'Proxmox desk';
const PAGES_PORT = 18765;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

mkdirSync('screenshots', { recursive: true });
const report: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  report[k] = v;
  console.log(`[selfhost] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  writeFileSync('screenshots/report.json', JSON.stringify(report, null, 2));
};

function onDesk(cmd: string, timeoutMs = 120_000): string {
  return execFileSync(SSH, [cmd], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 << 20 });
}
interface Status { status: string; deskId?: string; code?: string; claimUrl?: string; address?: string; deskName?: string }
const deskStatus = (): Status => {
  try {
    return JSON.parse(onDesk('sudo cat /run/ma-selfhost/status.json'));
  } catch {
    return { status: 'unreachable' };
  }
};

interface TestUser { email: string; password: string; totpSecret: string }
function loadUser(name: string): TestUser {
  const rec = JSON.parse(execFileSync('aws', ['ssm', 'get-parameter', '--with-decryption', '--region', 'us-east-1', '--name', `/ma/staging/test-users/${name}`, '--query', 'Parameter.Value', '--output', 'text'], { encoding: 'utf8' }));
  if (!String(rec.email).endsWith('@test.minimalistalliance.com')) throw new Error(`${name} is not a test-domain user`);
  return { email: rec.email, password: rec.password, totpSecret: rec.totpSecret };
}

let lastTotpWindow = 0;
/** Managed login or our own pages, as e2e/tests/lib.ts does. Secrets only go through fill(). */
async function signIn(page: Page, u: TestUser): Promise<void> {
  await page.waitForURL(/\/(login|oauth2\/authorize|_signin\/)/, { timeout: 45_000 });
  if (new URL(page.url()).pathname.startsWith('/_signin')) {
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
  for (let attempt = 0; attempt < 3; attempt++) {
    let win = Math.floor(Date.now() / 30_000);
    const left = 30 - (Math.floor(Date.now() / 1000) % 30);
    if (win <= lastTotpWindow || left < 4) {
      await page.waitForTimeout((left + 1) * 1000);
      win = Math.floor(Date.now() / 30_000);
    }
    lastTotpWindow = win;
    await field.fill(await generate({ secret: u.totpSecret }));
    await page.getByRole('button', { name: /^(sign in|verify|continue|submit|confirm)$/i }).first().click();
    const left2 = await Promise.race([
      page.waitForURL((url) => !/\/(login|oauth2|_signin|mfa)/.test(url.pathname), { timeout: 20_000 }).then(() => true).catch(() => false),
    ]);
    if (left2) return;
  }
  throw new Error('sign-in: the TOTP code was refused three times');
}

/** The RTCPeerConnections the app makes, so the test can read which path a session took. */
const RECORD_PCS = () => {
  const w = window as unknown as Record<string, unknown>;
  const pcs: RTCPeerConnection[] = [];
  w.__pcs = pcs;
  const Native = window.RTCPeerConnection;
  const Wrapped = function (this: unknown, ...a: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new Native(...a);
    pcs.push(pc);
    return pc;
  } as unknown as typeof RTCPeerConnection;
  Wrapped.prototype = Native.prototype;
  Object.assign(Wrapped, Native);
  window.RTCPeerConnection = Wrapped;
};

/** The selected pair of the newest connected peer connection: types, protocol, and the remote address (kept, not printed). */
const selectedPath = (page: Page) =>
  page.evaluate(async () => {
    const pcs = ((window as unknown as Record<string, unknown>).__pcs as RTCPeerConnection[]) ?? [];
    for (const pc of [...pcs].reverse()) {
      if (pc.connectionState !== 'connected') continue;
      const stats = await pc.getStats();
      let pair: Record<string, unknown> | undefined;
      stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
      if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
      if (!pair) continue;
      const local = stats.get(pair.localCandidateId as string);
      const remote = stats.get(pair.remoteCandidateId as string);
      return { localType: local?.candidateType, remoteType: remote?.candidateType, protocol: remote?.protocol, remoteAddress: remote?.address ?? remote?.ip, remotePort: remote?.port };
    }
    return null;
  });

/** What the peer connections saw, with every address reduced to its kind: for a failure, never printed raw. */
const iceReport = (page: Page) =>
  page.evaluate(async () => {
    const kind = (a: string | undefined) => (!a ? 'none' : a.endsWith('.local') ? 'mdns' : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) ? 'private' : /:/.test(a) ? 'ipv6' : 'public');
    const pcs = ((window as unknown as Record<string, unknown>).__pcs as RTCPeerConnection[]) ?? [];
    const out = [];
    for (const pc of pcs.slice(-3)) {
      const remote = (pc.remoteDescription?.sdp ?? '').split('\r\n').filter((l) => l.startsWith('a=candidate') || l.startsWith('a=ice-lite')).map((l) => l.replace(/ (\d+\.\d+\.\d+\.\d+) /, (_m, ip) => ` <${kind(ip)}> `));
      const pairs: string[] = [];
      const stats = await pc.getStats();
      stats.forEach((st) => { if (st.type === 'candidate-pair') pairs.push(`${st.state} nominated=${st.nominated} req=${st.requestsSent} resp=${st.responsesReceived}`); });
      const locals: string[] = [];
      stats.forEach((st) => { if (st.type === 'local-candidate') locals.push(`${st.candidateType}/${st.protocol}/${kind(st.address ?? st.ip)}`); });
      out.push({ conn: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, remote, pairs, locals });
    }
    return out;
  });

const BARS = (nonce: string) => `<!doctype html><meta charset="utf-8"><title>SH-${nonce}</title>
<style>html,body{margin:0;height:100%}div{position:fixed;width:50vw;height:50vh}</style>
<div style="left:0;top:0;background:#f00"></div><div style="left:50vw;top:0;background:#0c0"></div>
<div style="left:0;top:50vh;background:#00f"></div><div style="left:50vw;top:50vh;background:#fff"></div>`;

function deployPage(nonce: string): void {
  const b64 = Buffer.from(BARS(nonce)).toString('base64');
  const out = onDesk(`set -e
sudo systemctl stop ma-sh-e2e-pages 2>/dev/null || true; sudo systemctl reset-failed ma-sh-e2e-pages 2>/dev/null || true
sudo rm -rf /run/ma-sh-e2e-pages; sudo install -d -m 755 /run/ma-sh-e2e-pages
echo ${b64} | base64 -d | sudo tee /run/ma-sh-e2e-pages/bars.html >/dev/null; sudo chmod 644 /run/ma-sh-e2e-pages/bars.html
sudo systemd-run --quiet --collect --unit=ma-sh-e2e-pages --uid=65534 --gid=65534 /usr/bin/python3 -I -m http.server ${PAGES_PORT} --bind 127.0.0.1 --directory /run/ma-sh-e2e-pages
sleep 1; curl -s -m 3 -o /dev/null -w 'HTTP=%{http_code}' http://127.0.0.1:${PAGES_PORT}/bars.html`);
  if (!out.includes('HTTP=200')) throw new Error('the page server on the desk did not answer');
}
const removePage = () => onDesk('sudo systemctl stop ma-sh-e2e-pages 2>/dev/null || true; sudo rm -rf /run/ma-sh-e2e-pages; echo removed');

let context: BrowserContext;
let page: Page;
let user: TestUser;
let deskId = '';
let deskAddress = '';
const errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  if (!SSH || !REBOOT) throw new Error('set SELFHOST_SSH and SELFHOST_REBOOT (README.md)');
  user = loadUser(USER);
  // No permissions granted: a member's Chrome as it comes. SELFHOST_LNA=1 grants Local Network Access, to compare.
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: process.env.SELFHOST_LNA ? ['local-network-access'] : [] });
  await context.addInitScript(RECORD_PCS);
  page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().replace(/[?#]\S*/g, '').replace(/\b\d+\.\d+\.\d+\.\d+\b/g, '<ip>').slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
});

test.afterAll(async () => {
  note('console errors', errors);
  try { removePage(); } catch { /* the desk may be rebooting */ }
  await context?.close();
});

async function openDeskApp(name: RegExp, dialogName: RegExp) {
  const proxy = page.locator(`#proxy-${deskId}`);
  await proxy.waitFor({ state: 'attached', timeout: 60_000 });
  await proxy.focus();
  await page.keyboard.press('Enter');
  const tile = proxy.locator('..').getByRole('button', { name });
  let box = await tile.boundingBox();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const now = await tile.boundingBox();
    if (now && JSON.stringify(now) === JSON.stringify(box)) break;
    box = now;
  }
  if (!box) throw new Error(`no ${name} tile on the desk`);
  const win = page.getByRole('dialog', { name: dialogName });
  // The desk zooms in as it opens. A click that lands before it settles can be taken as a pan, so try up to three times.
  for (let i = 0; i < 3; i++) {
    const b = (await tile.boundingBox()) ?? box;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    if (await win.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) break;
    note(`${name} tile: no window after click ${i + 1}`, true);
  }
  await expect(win).toBeVisible({ timeout: 10_000 });
  return win;
}

async function browserStreams(label: string) {
  const win = await openDeskApp(/^Browser/, /Browser/);
  const video = win.getByLabel("The page in this desk's browser", { exact: true });
  try {
    await expect(win.getByTestId('browser-panel'), `${label}: no panel left over the picture`).toHaveCount(0, { timeout: 120_000 });
  } catch (e) {
    note(`${label} ICE at the failure`, await iceReport(page));
    throw e;
  }
  const size = await video.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight]);
  note(`${label} video size`, size);
  const nonce = randomBytes(3).toString('hex');
  deployPage(nonce);
  const tabs = win.getByTestId('browser-tab');
  await expect.poll(() => tabs.count(), { timeout: 60_000 }).toBeGreaterThan(0);
  const before = await tabs.count();
  await win.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(tabs).toHaveCount(before + 1, { timeout: 20_000 });
  const address = win.getByRole('textbox', { name: 'Address' });
  await address.click();
  await address.fill(`http://127.0.0.1:${PAGES_PORT}/bars.html`);
  await address.press('Enter');
  await expect(win.getByRole('tab', { selected: true }), `${label}: the page's title in the tab strip`).toHaveAttribute('title', new RegExp(`SH-${nonce}`), { timeout: 30_000 });
  const quality = () => video.evaluate((v: HTMLVideoElement) => ({ frames: v.getVideoPlaybackQuality().totalVideoFrames, paused: v.paused }));
  const q0 = await quality();
  await sleep(3000);
  const q1 = await quality();
  note(`${label} frames in 3 s`, q1.frames - q0.frames);
  expect(q1.paused).toBe(false);
  expect(q1.frames).toBeGreaterThan(q0.frames);
  const pixels = async () => video.evaluate((v: HTMLVideoElement) => {
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const x = c.getContext('2d')!;
    x.drawImage(v, 0, 0);
    const at = (fx: number, fy: number) => [...x.getImageData(Math.floor(v.videoWidth * fx), Math.floor(v.videoHeight * fy), 1, 1).data].slice(0, 3);
    return [at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)];
  });
  const right = (p: number[][]) => p[0][0] > 150 && p[0][1] < 80 && p[1][1] > 120 && p[1][0] < 80 && p[2][2] > 150 && p[2][0] < 80 && p[3].every((c) => c > 200);
  let p = await pixels();
  for (let i = 0; i < 100 && !right(p); i++) { await sleep(100); p = await pixels(); }
  note(`${label} decoded quadrants (RGB)`, p);
  await page.screenshot({ path: `screenshots/${label}-browser.png` });
  expect(right(p), `${label}: red, green, blue and white where the page has them`).toBe(true);

  const path = await selectedPath(page);
  const sameAddress = !!path && path.remoteAddress === deskAddress;
  note(`${label} connection`, { localType: path?.localType, remoteType: path?.remoteType, protocol: path?.protocol, remotePort: path?.remotePort, toTheDeskOnTheHomeNetwork: sameAddress });
  expect(path?.remoteType, 'a host candidate, not a relay').toBe('host');
  expect(sameAddress, "straight to the desk's home-network address").toBe(true);
  // Close the tab we opened, then the window.
  await win.getByRole('tab', { selected: true }).locator('..').getByRole('button', { name: /^Close/ }).click().catch(() => {});
  await win.getByRole('button', { name: /^Close/ }).last().click().catch(() => {});
}

test('a self-hosted desk: paired from the Platform, opened from the office, streams the Browser, opens Notebook, survives a reboot', async () => {
  await test.step('1 pair it with the test account, through the Platform page', async () => {
    let s = deskStatus();
    note('desk status before', { status: s.status, paired: !!s.deskId });
    if (s.status !== 'online') {
      await expect.poll(() => { s = deskStatus(); return !!s.code; }, { timeout: 60_000 }).toBe(true);
      const code = s.code!.replace('-', '');
      await page.goto(`${PLATFORM}/self-hosted?code=${code}`);
      await signIn(page, user);
      await page.waitForURL((u) => u.origin === PLATFORM, { timeout: 45_000 });
      // Signing in comes back to the path alone. The page keeps the link's code through that from ma-platform 946637a on;
      // before it (what staging ran first), the link is opened again, now signed in.
      const field = page.getByTestId('self-hosted-code');
      await field.waitFor({ timeout: 30_000 }).catch(() => {});
      if ((await field.inputValue().catch(() => '')) !== s.code) {
        note('1 code kept through sign-in', false);
        await page.goto(`${PLATFORM}/self-hosted?code=${code}`);
      } else note('1 code kept through sign-in', true);
      await expect(field).toHaveValue(s.code!, { timeout: 30_000 });
      await page.getByTestId('self-hosted-name').fill(DESK_NAME);
      await page.getByTestId('self-hosted-submit').click();
      await expect(page.getByTestId('self-hosted-added')).toContainText(`${DESK_NAME} is in your office`, { timeout: 30_000 });
      await page.screenshot({ path: 'screenshots/1-paired.png' });
    }
    await expect.poll(() => deskStatus().status, { timeout: 120_000 }).toBe('online');
    s = deskStatus();
    deskId = s.deskId!;
    deskAddress = s.address!;
    note('1 desk', { deskId, online: true });
  });

  await test.step('2 deskd, desk-rtc and desk-notebook are healthy on the desk', async () => {
    await expect.poll(() => { try { onDesk('sudo /opt/ma/smoke-test'); return true; } catch { return false; } }, { timeout: 180_000, intervals: [5000] }).toBe(true);
    note('2 smoke test', onDesk('sudo /opt/ma/smoke-test 2>&1 | tail -1').trim());
    // What it runs, and its port as desk-rtc reads it (an older bundle's desk has only /etc/ma/desk-rtc-port).
    const versions: Record<string, string> = {};
    for (const c of ['desk-rtc', 'desk-stream', 'deskd']) versions[c] = onDesk(`cat /opt/ma/${c}/current/VERSION`).trim();
    // A bundle from before desk-notebook has none: "none".
    versions['desk-notebook'] = onDesk('cat /opt/ma/desk-notebook/current/VERSION 2>/dev/null || echo none').trim();
    versions.port = onDesk('sudo /usr/local/lib/ma/selfhost/ma-selfhost-port 2>/dev/null || cat /etc/ma/desk-rtc-port').trim();
    versions.oldPortFile = onDesk('test -e /etc/ma/desk-rtc-port && echo yes || echo no').trim();
    note('2 versions', versions);
    // desk-notebook's place, as the image's verify.sh section 3n checks it. With a release, its container has no network:
    // a self-hosted desk's firewall has no rule for uid 1105 either, and relies on that.
    const nb: Record<string, string> = {
      data: onDesk('sudo stat -c "%u:%g %a" /data/notebook').trim(),
      run: onDesk('sudo stat -c "%u:%g %a" /run/desk-notebook').trim(),
    };
    if (versions['desk-notebook'] !== 'none') {
      nb.network = onDesk("sudo docker inspect -f '{{.HostConfig.NetworkMode}}' desk-notebook").trim();
      nb.user = onDesk("sudo docker inspect -f '{{.Config.User}}' desk-notebook").trim();
      nb.socket = onDesk('sudo stat -c "%u:%g %a" /run/desk-notebook/notebook.sock').trim();
    }
    note('2 notebook', nb);
    expect(nb.data, '/data/notebook').toBe('1105:1105 700');
    expect(nb.run, '/run/desk-notebook').toBe('1105:1100 2750');
    if (nb.network !== undefined) {
      expect(nb.network, "desk-notebook's network").toBe('none');
      expect(nb.user, "desk-notebook's user").toMatch(/^1105(:1105)?$/);
      expect(nb.socket, 'notebook.sock').toBe('1105:1100 660');
    }
    // SELFHOST_EXPECT=desk-rtc=<v>,desk-stream=0.2.3,port=4443: what an update must have left the desk on.
    for (const kv of (process.env.SELFHOST_EXPECT ?? '').split(',').filter(Boolean)) {
      const [k, v] = kv.split('=');
      expect(versions[k], `the desk's ${k}`).toBe(v);
    }
  });

  await test.step('3 the office lists it, and it opens and streams the Browser, straight over the home network', async () => {
    await page.goto(APP);
    // The office either shows itself, has its own Sign in button, or goes straight to the sign-in pages.
    const shell = page.locator('.ma-shell');
    const appButton = page.locator('.ma-signed-out, [data-testid="signed-out"]').getByRole('button', { name: 'Sign in', exact: true });
    const which = await Promise.race([
      shell.waitFor({ timeout: 60_000 }).then(() => 'shell'),
      page.waitForURL((u) => /\/(login|oauth2\/authorize|_signin\/)/.test(u.pathname), { timeout: 60_000 }).then(() => 'signin'),
      appButton.waitFor({ timeout: 60_000 }).then(() => 'button'),
    ]).catch(() => 'none');
    note('3 office arrival', which);
    if (which === 'button') await appButton.click();
    if (which !== 'shell') {
      await signIn(page, user);
      await page.waitForURL((u) => u.origin === APP && !u.pathname.startsWith('/_signin'), { timeout: 45_000 });
    }
    await shell.waitFor({ timeout: 60_000 });
    await browserStreams('3');
  });

  await test.step('4 Notebook opens on it', async () => {
    const win = await openDeskApp(/^Notebook/, /Notebook/);
    note('4 notebook window', (await win.innerText()).replace(/\s+/g, ' ').slice(0, 160));
    await page.screenshot({ path: 'screenshots/4-notebook.png' });
    await win.getByRole('button', { name: /^Close/ }).last().click().catch(() => {});
  });

  await test.step('5 its machine reboots, it comes back online by itself, and streams again', async () => {
    // A new boot ID proves the machine restarted: the desk can be back online before the first look.
    const bootId = () => { try { return onDesk('cat /proc/sys/kernel/random/boot_id').trim(); } catch { return 'unreachable'; } };
    const before = bootId();
    expect(before, 'the desk answers before the restart').not.toBe('unreachable');
    const t0 = Date.now();
    execFileSync(REBOOT, [], { encoding: 'utf8', timeout: 300_000 });
    await expect.poll(() => { const b = bootId(); return b !== 'unreachable' && b !== before; }, { timeout: 600_000, intervals: [5000] }).toBe(true);
    note('5 restarted (new boot ID) after (s)', Math.round((Date.now() - t0) / 1000));
    await expect.poll(() => deskStatus().status, { timeout: 600_000, intervals: [5000] }).toBe('online');
    await expect.poll(() => { try { onDesk('sudo /opt/ma/smoke-test'); return true; } catch { return false; } }, { timeout: 300_000, intervals: [5000] }).toBe(true);
    note('5 back online after (s)', Math.round((Date.now() - t0) / 1000));
    expect(deskStatus().deskId, 'the same desk').toBe(deskId);
    await page.reload();
    await page.locator('.ma-shell').waitFor({ timeout: 60_000 });
    await browserStreams('5');
  });
});
