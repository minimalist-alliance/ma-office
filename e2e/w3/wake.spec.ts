// TD-227: how long a member waits for an Alliance desk, split into phases, through the real Desk app and its real `startsWithOffice` wake.
// Each sample stops the desk (EC2's own StopInstances, as the sweep's last step does), waits for EC2 and the desks table to say
// stopped, then loads the office afresh. The page wakes the desk by itself, as the member's office does; nothing is clicked to wake.
// Writes samples.json per label to ~/ma-design-drafts/w3/<W3_LABEL>/wake-<WAKE_LABEL>.json and the guest's own boot data beside it.
//
// Needs WAKE_INSTANCE (a staging DeskKind=test instance tagged Owner=<WAKE_OWNER>...), W3_DESK, W3_USER_SSM, W3_DESK_ID, W3_LABEL, WAKE_LABEL.
// WAKE_OWNER is the task's AWS owner tag (default syseng-td227, the task that wrote this); the instance's Owner tag must start with it.
// WAKE_N samples (default 5). Skips unless WAKE_INSTANCE is set. Test desk only: it refuses the owner's desk and anything not tagged.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from '@playwright/test';
import { watch } from '../tests/lib';
import { BrowserWin, channelHook, clientLoad, installProbe, loadW3User, pickDesk, signIn, w3Input } from './w3lib';

const run = promisify(execFile);
const INSTANCE = process.env.WAKE_INSTANCE ?? '';
const OWNER = process.env.WAKE_OWNER ?? 'syseng-td227';
test.skip(!INSTANCE, 'WAKE_INSTANCE is not set');
test.setTimeout(3 * 60 * 60_000);

const env = { ...process.env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' };
const aws = async (...a: string[]) => (await run('aws', a, { encoding: 'utf8', env, maxBuffer: 64 << 20 })).stdout;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ssm(command: string, timeoutS = 120): Promise<string> {
  const id = (await aws('ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--parameters', JSON.stringify({ commands: [command] }), '--query', 'Command.CommandId', '--output', 'text')).trim();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    await sleep(800);
    try {
      const inv = JSON.parse(await aws('ssm', 'get-command-invocation', '--command-id', id, '--instance-id', INSTANCE, '--output', 'json'));
      if (inv.Status === 'Success') return inv.StandardOutputContent;
      if (['Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) throw new Error(`ssm ${inv.Status}: ${inv.StandardErrorContent.slice(0, 300)}`);
    } catch (e) { if (String(e).includes('ssm ')) throw e; }
  }
  throw new Error('ssm timeout');
}

const GUEST = `
echo "BOOT_EPOCH $(awk -v n=$(date +%s.%N) '{printf "%.3f", n-$1}' /proc/uptime)"
echo "UPTIME $(cut -d' ' -f1 /proc/uptime)"
systemd-analyze 2>&1 | head -1
echo "--- journal (monotonic)"
journalctl -b -o short-monotonic --no-pager | grep -E "Reached target (multi-user|network-online|basic|local-fs|sysinit|network-pre)|Started (deskd|desk-rtc|docker|containerd|desk-notebook|desk-agent|cloud-init|amazon-ssm)|Finished (cloud-init|desk-firstboot|desk-datadirs|desk-kind|desk-egress)|ReadinessReporter|hello accepted|gateway link up|BrowserFreeze|Starting (deskd|desk-rtc)|desk-xorg|desk-browser|desk-stream|stream.*ready|Started desk-(xorg|browser|stream|audio)|Linux version|systemd\\[1\\]: Startup" | cut -c1-210
echo "--- critical-chain deskd"
systemd-analyze critical-chain deskd.service --no-pager 2>&1 | head -40
echo "--- blame"
systemd-analyze blame --no-pager 2>&1 | head -25
echo "--- units"
for u in desk-xorg desk-browser desk-stream desk-audio; do echo "$u $(systemctl show -p ActiveEnterTimestampMonotonic --value $u)"; done
`;

test('Alliance desk wake samples', async ({ browser }) => {
  const inp = w3Input();
  const label = process.env.WAKE_LABEL ?? 'asbuilt';
  const n = Number(process.env.WAKE_N ?? 5);
  const dir = join(inp.out, inp.label);
  mkdirSync(dir, { recursive: true });

  const inst = JSON.parse(await aws('ec2', 'describe-instances', '--instance-ids', INSTANCE, '--query', 'Reservations[0].Instances[0]', '--output', 'json'));
  const tags: Record<string, string> = Object.fromEntries((inst.Tags ?? []).map((t: { Key: string; Value: string }) => [t.Key, t.Value]));
  if (INSTANCE === '<instance>' || INSTANCE === '<instance>' || tags.DeskKind !== 'test' || tags.Env !== 'staging' || !OWNER.startsWith('syseng-') || !tags.Owner?.startsWith(OWNER)) throw new Error(`refusing ${INSTANCE}: not a staging test desk of this task`);
  const deskId = tags.DeskId;
  if (deskId !== inp.deskId) throw new Error('W3_DESK_ID must be this instance\'s DeskId');

  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await context.addInitScript(channelHook);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const w = watch(page);
  await signIn(context, page, loadW3User(inp), inp.url);
  await pickDesk(page, w, inp);

  const rowState = async () => JSON.parse(await aws('dynamodb', 'get-item', '--table-name', 'ma-staging-desks', '--key', JSON.stringify({ desk_id: { S: deskId } }), '--consistent-read', '--output', 'json')).Item;
  const samples: unknown[] = [];
  const skipped: { sample: number; why: string }[] = [];
  const save = () => writeFileSync(join(dir, `wake-${label}.json`), JSON.stringify({ label, instance: INSTANCE, deskId, type: inst.InstanceType, ami: inst.ImageId, skipped, samples }, null, 2));

  for (let k = 1; k <= n; k++) {
    // ---- down: EC2's stop, then wait until the instance and the desks row both say stopped, then settle
    let state = (await aws('ec2', 'describe-instances', '--instance-ids', INSTANCE, '--query', 'Reservations[0].Instances[0].State.Name', '--output', 'text')).trim();
    if (state === 'pending') { await aws('ec2', 'wait', 'instance-running', '--instance-ids', INSTANCE); state = 'running'; }
    if (state === 'running') await aws('ec2', 'stop-instances', '--instance-ids', INSTANCE);
    await aws('ec2', 'wait', 'instance-stopped', '--instance-ids', INSTANCE);
    for (let i = 0; i < 90; i++) { const r = await rowState(); if (r?.state?.S === 'stopped') break; await sleep(2000); }
    await sleep(8000);

    // ---- up: a fresh load of the office wakes it
    const ev: { t: number; what: string; detail?: string }[] = [];
    const mark = (what: string, detail?: string) => ev.push({ t: Date.now(), what, detail });
    const onWs = (ws: import('@playwright/test').WebSocket) => {
      ws.on('framereceived', (f) => {
        const s = typeof f.payload === 'string' ? f.payload : '';
        if (s.includes('desk.progress') || s.includes('desk.state')) {
          try { const m = JSON.parse(s); mark(`ws:${m.type}`, m.phase ?? m.state); } catch { /* not json */ }
        }
      });
    };
    const onReq = (r: import('@playwright/test').Request) => { if (/\/connect$/.test(new URL(r.url()).pathname)) mark('connect:request'); };
    const onRes = (r: import('@playwright/test').Response) => { if (/\/connect$/.test(new URL(r.url()).pathname)) mark('connect:response', String(r.status())); };
    page.on('websocket', onWs); page.on('request', onReq); page.on('response', onRes);

    let running = 0, runningSeen: number | null = null, pending: number | null = null;
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const s = (await aws('ec2', 'describe-instances', '--instance-ids', INSTANCE, '--query', 'Reservations[0].Instances[0].State.Name', '--output', 'text').catch(() => '')).trim();
        const t = Date.now();
        if (s === 'pending' && pending === null) pending = t;
        if (s === 'running' && runningSeen === null) { runningSeen = t; running = t; }
        if (runningSeen !== null) break;
        await sleep(150);
      }
    })();

    const load0 = clientLoad();
    const t0 = Date.now();
    await page.goto(inp.url, { waitUntil: 'commit' });
    mark('page:commit');
    const shell = await page.locator('.ma-shell').waitFor({ timeout: 30_000 }).then(() => true, () => false);
    if (!shell) {
      // The platform answered "Desk is unavailable right now" (seen once on staging): not a sample. Start this one again.
      polling = false; await poller;
      page.off('websocket', onWs); page.off('request', onReq); page.off('response', onRes);
      skipped.push({ sample: k, why: ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 120) });
      console.log(`[wake ${label}] sample ${k}: the office did not load (${JSON.stringify(skipped[skipped.length - 1])}), again`);
      if (skipped.length > 5) throw new Error('the office failed to load 6 times');
      k--;
      continue;
    }
    mark('page:shell');
    await page.evaluate(installProbe);
    const bw = new BrowserWin(page, deskId);
    // the member opens the Browser as soon as the office is up
    let tClick = 0, openErr: string | null = null;
    try { tClick = await Promise.race([bw.open(), sleep(150_000).then(() => { throw new Error('no window in 150 s'); })]); mark('browser:window'); } catch (e) { openErr = String(e).slice(0, 200); }
    let frameAbs: number | null = null, openAbs: number | null = null;
    try {
      await bw.waitPicture(240_000);
      mark('browser:picture');
      await bw.waitTabs(240_000);
      mark('browser:tabs');
      const org = await page.evaluate(() => performance.timeOrigin);
      const [om] = await bw.W<number[]>('marks', 'ma:window-open:browser');
      const [fm] = await bw.W<number[]>('marks', 'ma:browser-first-frame');
      openAbs = om === undefined ? null : Math.round(org + om);
      frameAbs = fm === undefined ? null : Math.round(org + fm);
    } catch (e) { openErr = openErr ?? String(e).slice(0, 200); }
    polling = false; await poller;
    const guest = await ssm(GUEST).catch((e) => `ssm failed: ${e}`);
    const row = await rowState();
    writeFileSync(join(dir, `wake-${label}-${k}-guest.txt`), guest);
    const bootEpoch = Number(/BOOT_EPOCH ([\d.]+)/.exec(guest)?.[1] ?? NaN);
    samples.push({
      sample: k, valid: Number.isFinite(bootEpoch) && bootEpoch * 1000 > t0 - 3000, t0, clickAt: tClick || null, tClickMs: tClick ? tClick - t0 : null, openErr,
      events: ev.map((e) => ({ ms: e.t - t0, what: e.what, detail: e.detail })),
      pendingSeenMs: pending ? pending - t0 : null, runningSeenMs: runningSeen ? runningSeen - t0 : null,
      bootEpochMs: Number.isFinite(bootEpoch) ? Math.round(bootEpoch * 1000 - t0) : null,
      windowOpenMs: openAbs ? openAbs - t0 : null, firstFrameMs: frameAbs ? frameAbs - t0 : null, firstFrameAfterClickMs: frameAbs && openAbs ? frameAbs - openAbs : null, tabsMs: (ev.find((e) => e.what === 'browser:tabs')?.t ?? NaN) - t0,
      rowChangedAt: row?.state_changed_at?.S, rowState: row?.state?.S, clientLoadBefore: load0.loadavg1m, clientLoadAfter: clientLoad().loadavg1m,
    });
    save();
    console.log(`[wake ${label}] sample ${k}: first frame ${frameAbs ? frameAbs - t0 : 'none'} ms, running seen ${runningSeen ? runningSeen - t0 : '?'} ms`);
    page.off('websocket', onWs); page.off('request', onReq); page.off('response', onRes);
    await bw.close().catch(() => {});
    void running;
  }
  await context.close();
});
