// Proves desk-rtc against real headless Chromium over UDP and ICE-TCP. Pion-to-Pion can hide problems,
// and a browser is the real client.
//
//   cd desk-rtc && ./build.sh && cd test/browser && npm install --ignore-scripts && npm run check
//
// Starts gateway-shim, desk-rtc and fake-deskd on loopback from dist/amd64. Results go to results/.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, '../../dist/amd64');
const DESK_ID = 'd-dev0000000000';
const BULK_BYTES = 8 * 1024 * 1024;

const failures = [];
function check(scenario, name, ok, detail = '') {
  if (!ok) failures.push(`${scenario}: ${name}${detail ? ` (${detail})` : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const tcp = net.createServer();
    tcp.on('error', reject);
    tcp.listen(0, '127.0.0.1', () => {
      const { port } = tcp.address();
      tcp.close(() => {
        const udp = dgram.createSocket('udp4');
        udp.on('error', () => resolve(freePort()));
        udp.bind(port, '127.0.0.1', () => udp.close(() => resolve(port)));
      });
    });
  });
}

const dir = mkdtempSync(path.join(tmpdir(), 'drtc-browser-'));
const children = [];
const logs = {};
function start(name, args) {
  const child = spawn(path.join(bin, name), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  logs[name] = '';
  child.stdout.on('data', (d) => { logs[name] += d; });
  child.stderr.on('data', (d) => { logs[name] += d; });
  children.push(child);
  return child;
}
function cleanup() {
  for (const c of children) c.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}

const pageServer = createServer((req, res) => {
  if (req.url === '/page.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(readFileSync(path.join(here, 'page.js')));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>desk-rtc check</title><script src="/page.js"></script>');
});
const pagePort = await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', () => resolve(pageServer.address().port)));
const origin = `http://127.0.0.1:${pagePort}`;

const apiPort = await freePort();
const rtcPort = await freePort();
const api = `http://127.0.0.1:${apiPort}`;
const sock = path.join(dir, 'rtc.sock');
start('gateway-shim', ['--addr', `127.0.0.1:${apiPort}`, '--origins', origin]);
// A short consent timeout, so the hold and vanish scenarios below finish quickly.
const CONSENT_SECONDS = 6;
start('desk-rtc', ['--socket', sock, '--data-dir', path.join(dir, 'rtc'), '--bind', '127.0.0.1', '--port', String(rtcPort), '--consent-timeout', `${CONSENT_SECONDS}s`]);
start('fake-deskd', ['--rtc-sock', sock, '--api', api, '--public-ip', '127.0.0.1']);

for (let i = 0; ; i++) {
  try {
    if ((await (await fetch(`${api}/dev/state`)).json()).ready) break;
  } catch { /* not up yet */ }
  if (i > 100) throw new Error('the desk never reached ready');
  await new Promise((r) => setTimeout(r, 100));
}

// GATEFLOOD=127.0.1.1,127.0.2.1,127.0.3.1 runs every scenario while those source networks flood the ICE-TCP gate with
// silent connections (test/gateflood, built into dist/amd64): the browser's own ICE-TCP must still get through.
const flooding = process.env.GATEFLOOD ?? '';
if (flooding) {
  start('gateflood', ['--target', `127.0.0.1:${rtcPort}`, '--sources', flooding, '--workers', '40', '--duration', '30m']);
  await new Promise((r) => setTimeout(r, 3000));
}

// The sandbox and loopback flags are for this headless run. Chromium leaves loopback out of
// WebRTC unless told, and everything here is on loopback.
// Default: full Chromium in new headless mode. HEADLESS_SHELL=1 tries the smaller headless shell.
const browser = await chromium.launch({
  ...(process.env.HEADLESS_SHELL ? {} : { channel: 'chromium' }),
  headless: true,
  args: ['--allow-loopback-in-peer-connection', '--no-sandbox'],
});
console.log(`Chromium ${browser.version()}`);

const results = {};
async function scenario(name, options, { keepPage = false } = {}) {
  console.log(`\n== ${name}`);
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  page.on('pageerror', (e) => consoleLines.push('pageerror: ' + e.message));
  await page.goto(origin);
  let r;
  try {
    r = await page.evaluate((o) => window.runScenario(o), { api, deskId: DESK_ID, bulkBytes: BULK_BYTES, ...options });
  } catch (e) {
    check(name, 'scenario ran', false, e.message.split('\n')[0]);
    console.log(consoleLines.join('\n'));
    r = { error: e.message };
  }
  results[name] = r;
  if (keepPage) return { r, page };
  await page.close();
  return r;
}

function judgeConnected(name, r, wantProtocol) {
  if (r.error) return;
  check(name, 'gateway echoed the subprotocol', r.subprotocol === 'ma.gw.v1', r.subprotocol);
  check(name, 'iceServers is [] and expiry null', Array.isArray(r.iceServers) && r.iceServers.length === 0 && r.iceServersExpireAt === null);
  check(name, 'offer order is audio, video, application', r.offer?.sectionOrder?.join() === 'audio,video,application', r.offer?.sectionOrder?.join());
  check(name, 'offer carries no candidates', r.offer?.candidates === 0, String(r.offer?.candidates));
  check(name, 'Chrome wrote a fingerprint line per section', r.offer?.fingerprintLines === 3, String(r.offer?.fingerprintLines));
  check(name, 'signal frame fits 32 KiB', r.offer?.signalFrameBytes <= 32 * 1024, `${r.offer?.signalFrameBytes} bytes, H.264 offered: ${r.offer?.hasH264}`);
  check(name, 'answer has a=ice-lite', r.answer?.iceLite === true);
  check(name, 'answer has exactly two candidates', r.answer?.candidates?.length === 2, r.answer?.candidates?.map((c) => c.split(' ').slice(2, 8).join(' ')).join(' | '));
  check(name, 'answer fingerprints are in deskIdentity', r.answer?.fingerprintOk === true);
  check(name, 'audio answered sendonly, non-zero port', r.answer?.audio?.includes('a=sendonly') && !/^m=audio 0 /.test(r.answer.audio[0]), r.answer?.audio?.join(' '));
  if (r.offer?.hasH264) {
    check(name, 'video answered sendonly, non-zero port', r.answer?.video?.includes('a=sendonly') && !/^m=video 0 /.test(r.answer.video[0]), r.answer?.video?.join(' '));
  } else {
    check(name, 'no H.264 in the offer: video alone rejected', /^m=video 0 /.test(r.answer?.video?.[0] ?? ''), r.answer?.video?.join(' '));
  }
  check(name, 'BUNDLE keeps audio and data', /BUNDLE 0( 1)? 2/.test(r.answer?.bundle ?? ''), r.answer?.bundle);
  check(name, 'data section advertises 16 KiB', r.answer?.data?.includes('a=max-message-size:16384'), r.answer?.data?.join(' '));
  check(name, 'browser accepted the answer and connected', r.states?.conn === 'connected' && r.states?.dtls === 'connected', JSON.stringify(r.states));
  check(name, 'HELLO answered', r.hello?.sessionId === r.sessionId);
  check(name, 'desk.status.get answered', r.status?.deskId === DESK_ID, `${r.statusRttMs} ms`);
  check(name, `browser's selected pair is ${wantProtocol}`, r.pair?.local?.protocol === wantProtocol && r.pair?.remote?.protocol === wantProtocol, JSON.stringify(r.pair));
  if (wantProtocol === 'tcp') check(name, 'browser dialed out, desk passive', r.pair?.remote?.tcpType === 'passive', r.pair?.remote?.tcpType);
  check(name, `desk-rtc reports ${wantProtocol}`, r.deskStats?.transport === wantProtocol && r.deskSideTransport === wantProtocol, `stats=${r.deskStats?.transport} state=${r.deskSideTransport}`);
  check(name, 'stats carry RTT and bytes', r.deskStats?.rttMs > 0 && r.deskStats?.bytesSent > 0, JSON.stringify(r.deskStats));
  check(name, 'input and keys counted, activity reported', r.deskStats?.inputDropped >= 1 && r.deskStats?.keysDropped >= 1 && r.inputActivity >= 1);
  check(name, 'download intact', r.download?.bytes === r.download?.want, `${r.download?.bytes} bytes, ${r.download?.mbit} Mbit/s`);
  check(name, 'upload intact', r.upload?.bytes === r.upload?.want, `${r.upload?.bytes} bytes, ${r.upload?.mbit} Mbit/s`);
  console.log(`       ctl idle ${JSON.stringify(r.ctlIdleMs)}`);
  console.log(`       ctl during download ${JSON.stringify(r.download?.ctlMs)}`);
  console.log(`       ctl during upload ${JSON.stringify(r.upload?.ctlMs)}`);
  if (r.restart) {
    check(name, 'ICE restart: new credentials, channels up', r.restart.newCredentials && r.restart.channelStillOpen && r.restart.status === DESK_ID, JSON.stringify(r.restart));
    check(name, `ICE restart stays on ${wantProtocol}`, r.restart.pair?.local?.protocol === wantProtocol, r.restart.pair?.local?.protocol);
  }
  check(name, 'session.close reaches session.closed', r.closedReason === 'closed_by_client', r.closedReason);
}

try {
  judgeConnected('udp', await scenario('udp', { restart: true }), 'udp');
  judgeConnected('tcp', await scenario('tcp', { tcpOnly: true, restart: true }), 'tcp');

  // The case a browser without H.264 hits: video alone is rejected, and audio's BUNDLE tag has to hold.
  const noH264 = await scenario('no H.264', { noH264: true });
  if (!noH264.error) {
    check('no H.264', 'the offer really has no H.264', noH264.offer?.hasH264 === false);
    check('no H.264', 'video alone rejected, port 0', /^m=video 0 /.test(noH264.answer?.video?.[0] ?? ''), noH264.answer?.video?.join(' '));
    check('no H.264', 'audio sendonly, non-zero port', noH264.answer?.audio?.includes('a=sendonly') && !/^m=audio 0 /.test(noH264.answer.audio[0]), noH264.answer?.audio?.join(' '));
    check('no H.264', 'BUNDLE leaves video out', noH264.answer?.bundle === 'a=group:BUNDLE 0 2', noH264.answer?.bundle);
    check('no H.264', 'browser accepted it and connected', noH264.states?.conn === 'connected', JSON.stringify(noH264.states));
    check('no H.264', 'RPC works', noH264.status?.deskId === DESK_ID);
    // A rejected section stops its transceiver, and the browser removes it from getTransceivers().
    check('no H.264', 'only audio is left, recvonly', noH264.transceivers?.length === 1 && noH264.transceivers[0].kind === 'audio' && noH264.transceivers[0].current === 'recvonly', JSON.stringify(noH264.transceivers));
  }

  const hold = await scenario('idle past the consent timeout', { holdIdleMs: (CONSENT_SECONDS + 2) * 1000 });
  if (!hold.error) {
    check('idle', `up after ${CONSENT_SECONDS + 2} s idle with a ${CONSENT_SECONDS} s timeout`, hold.afterHold?.conn === 'connected' && hold.afterHoldStatus === DESK_ID, JSON.stringify(hold.afterHold));
  }

  // The tab goes away without closing anything. Whatever Chromium sends or doesn't, the desk must free
  // the session by itself within the consent timeout.
  const gone = await scenario('tab vanishes', { vanish: true }, { keepPage: true });
  if (!gone.r.error) {
    const id = gone.r.sessionId;
    const t0 = Date.now();
    await gone.page.close();
    let reason = null;
    while (Date.now() - t0 < (CONSENT_SECONDS + 4) * 1000 && !reason) {
      reason = (logs['desk-rtc'].match(new RegExp(`session closed" session=${id} reason=(\\S+)`)) || [])[1] ?? null;
      await new Promise((r) => setTimeout(r, 100));
    }
    check('vanish', 'desk-rtc freed the session', reason !== null, `reason=${reason} after ${Date.now() - t0} ms`);
  } else {
    await gone.page.close();
  }

  const bad = await scenario('wrong fingerprint', { badCnf: true });
  check('wrong fingerprint', 'refused with identity_mismatch', bad.refusal?.code === 'identity_mismatch', JSON.stringify(bad.refusal));
  check('wrong fingerprint', 'session closed as identity_mismatch', bad.closedReason === 'identity_mismatch', bad.closedReason);

  const state = await (await fetch(`${api}/dev/state`)).json();
  check('end', 'no sessions left open', state.sessions.length === 0, JSON.stringify(state.sessions));
  if (flooding) {
    const held = (logs.gateflood.trim().split('\n').pop() ?? '');
    check('flood', 'the gate turned the flood away while the browser got through', /ICE-TCP gate turning connections away/.test(logs['desk-rtc']), held.slice(0, 400));
  }
} finally {
  await browser.close();
  pageServer.close();
  mkdirSync(path.join(here, 'results'), { recursive: true });
  writeFileSync(path.join(here, 'results', 'result.json'), JSON.stringify({ chromium: browser.version(), results, failures }, null, 2));
  writeFileSync(path.join(here, 'results', 'logs.txt'), Object.entries(logs).map(([k, v]) => `--- ${k} ---\n${v}`).join('\n'));
  cleanup();
}

console.log(failures.length ? `\nFAILED ${failures.length}:\n  ${failures.join('\n  ')}` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
