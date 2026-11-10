// Test 1: a real break of the WebRTC path only (CDP packetLoss: 100), then watch the app repair it.
// node rt-ice.mjs 10,45,10,20   RT_BROWSER=full for full Chromium instead of the headless shell.
import { ALLOWED, compact, events, HOST, log, mark, marks, openSession, pcStats, S, shutdown, testLabel, wait, waitPanel } from './rt-lib.mjs';

const lens = (process.argv[2] ?? '10,45,10,20').split(',').map(Number);
// rt-cdp-matrix.log: packet loss reaches WebRTC only through a global rule already in place when the
// peer connection is created. So arm first (no loss, 1 ms on HTTP and WebSocket), reload, then break.
const RULE = 'Network.emulateNetworkConditionsByRule';
const rule = (packetLoss) => ({ matchedNetworkConditions: [{ urlPattern: '', latency: 1, downloadThroughput: -1, uploadThroughput: -1, packetLoss }] });
const ARMED = rule(0);
// RT_BREAK=offline: also try to cut ICE-TCP, which packetLoss alone leaves up. Gateway, API, sign-in and the
// app's own files stay reachable, so only the WebRTC path is meant to go.
const pass = (urlPattern) => ({ urlPattern, latency: 1, downloadThroughput: -1, uploadThroughput: -1, packetLoss: 0 });
const BREAK = process.env.RT_BREAK === 'offline'
  ? {
      matchedNetworkConditions: [
        pass('https://api.staging.minimalistalliance.com/*'),
        pass('wss://gw.staging.minimalistalliance.com/*'),
        pass('https://auth.staging.minimalistalliance.com/*'),
        pass('https://test.office.staging.minimalistalliance.com/*'),
        { urlPattern: '', offline: true, latency: 1, downloadThroughput: -1, uploadThroughput: -1, packetLoss: 100 },
      ],
    }
  : rule(100);

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 15 * 60 * 1000);
watchdog.unref();

await openSession({ browserKind: process.env.RT_BROWSER ?? 'shell' });
if (!(await waitPanel(/online/, 45000))) {
  log('panel never came online:', testLabel());
  await shutdown(1, 'not online');
}
log('panel online; other desk label', JSON.stringify(S.labels));
S.cdp = await S.context.newCDPSession(S.page);
await S.cdp.send('Network.enable');
await S.cdp.send(RULE, ARMED);
log('rule armed, no loss; reloading so the peer connection is created under it');
delete S.labels[ALLOWED];
mark('reload');
await S.page.goto(HOST, { waitUntil: 'load' });
if (!(await waitPanel(/online/, 45000))) {
  log('panel never came online after the reload:', testLabel());
  await shutdown(1, 'not online after reload');
}
await wait(3000);
log('baseline', compact(await pcStats()));
log('document.hidden', await S.page.evaluate(() => document.hidden));

const results = [];
for (const [i, seconds] of lens.entries()) {
  const name = `break${i + 1}-${seconds}s`;
  const before = await pcStats();
  log('before', compact(before));
  const restartedBefore = await S.page.evaluate(() => performance.getEntriesByName('ma:desk-ice-restarted').length);

  const start = mark(`${name}:on`);
  try {
    await S.cdp.send(RULE, BREAK);
  } catch (e) {
    log('CDP refused the break:', e.message);
    await shutdown(3, 'cdp refused');
  }
  log('CDP rule accepted:', process.env.RT_BREAK === 'offline' ? 'global offline + packetLoss 100, four hosts exempt' : 'packetLoss 100');

  // Sample while it is broken. A second's grace for packets already in flight.
  let pongsAtGrace = null;
  let rxAtGrace = null;
  const firstPc = before.pc;
  let rxLastSamePc = null;
  while (Date.now() - start < seconds * 1000) {
    await wait(1000);
    const s = await pcStats();
    log('during', compact(s));
    if (Date.now() - start > 1500 && pongsAtGrace === null) {
      pongsAtGrace = s.pongs;
      if (s.pc === firstPc) rxAtGrace = s.bytesRx;
    }
    if (s.pc === firstPc) rxLastSamePc = s.bytesRx;
  }
  const pongsAtEnd = (await pcStats()).pongs;
  const end = mark(`${name}:off`);
  await S.cdp.send(RULE, ARMED);
  log('CDP back to the armed rule: packetLoss 0');

  const window = events.filter((e) => e.at >= start);
  const firstState = (key, value) => window.find((e) => e.k === 'pc.state' && e[key] === value);
  const broke = !!(firstState('ice', 'disconnected') || firstState('ice', 'failed') || firstState('connection', 'disconnected') || firstState('connection', 'failed'));
  const real = {
    iceLeftConnected: broke,
    pongsDuringBreak: pongsAtGrace === null ? null : pongsAtEnd - pongsAtGrace,
    rxBytesGrowthSamePc: rxAtGrace === null || rxLastSamePc === null ? null : rxLastSamePc - rxAtGrace,
  };
  log('BREAK CHECK', JSON.stringify(real));
  if (!broke && (real.pongsDuringBreak ?? 1) > 0) {
    log('RESULT: the CDP call did not break WebRTC. ICE stayed up and pongs kept arriving.');
    await shutdown(3, 'no break');
  }

  // Back to live: the panel online and the connection up.
  const ok = await (async () => {
    const limit = Date.now() + 150000;
    while (Date.now() < limit) {
      const s = await pcStats();
      if (/online/.test(testLabel()) && s.connection === 'connected' && s.dcOpen > 0) return true;
      await wait(100);
    }
    return false;
  })();
  const live = Date.now();
  log(ok ? `LIVE again ${(live - end) / 1000} s after the break ended` : 'NOT live 150 s after the break ended', JSON.stringify(testLabel()));
  log('after', compact(await pcStats()));

  // Is it really carrying data? Pongs go every 10 s and desk.status.get every 15 s.
  const pongsThen = (await pcStats()).pongs;
  const rpcThen = events.filter((e) => e.k === 'rpc.res').length;
  await wait(22000);
  const settled = await pcStats();
  log('settled', compact(settled), 'label', JSON.stringify(testLabel()));
  const restartedAfter = await S.page.evaluate(() => performance.getEntriesByName('ma:desk-ice-restarted').length);

  const w = events.filter((e) => e.at >= start);
  const at = (e) => (e ? +((e.at - start) / 1000).toFixed(3) : null);
  const atEnd = (e) => (e ? +((e.at - end) / 1000).toFixed(3) : null);
  const firstOf = (key, value) => w.find((e) => e.k === 'pc.state' && e[key] === value);
  const reconnected = w.find((e) => e.k === 'pc.state' && e.connection === 'connected' && e.ev === 'connectionstatechange' && e.at >= (firstOf('connection', 'disconnected')?.at ?? start));
  results.push({
    name,
    seconds,
    breakConfirmed: real,
    fromBreakOn: {
      iceDisconnected: at(firstOf('ice', 'disconnected')),
      connDisconnected: at(firstOf('connection', 'disconnected')),
      iceFailed: at(firstOf('ice', 'failed')),
      connFailed: at(firstOf('connection', 'failed')),
      restartOffers: w.filter((e) => e.k === 'pc.createOffer' && e.iceRestart).map((e) => ({ t: at(e), pc: e.pc })),
      restartSignalsSent: w.filter((e) => e.k === 'ws' && e.dir === '->' && e.type === 'signal' && e.data?.restart).map((e) => at(e)),
      answers: w.filter((e) => e.k === 'ws' && e.dir === '<-' && e.type === 'signal').map((e) => ({ t: at(e), type: e.data?.type, code: e.data?.code })),
    },
    fromBreakOff: {
      connConnected: atEnd(reconnected),
      panelOnline: +((live - end) / 1000).toFixed(3),
    },
    samePeerConnection: settled.pc === before.pc,
    pcBefore: before.pc,
    pcAfter: settled.pc,
    newPeerConnections: w.filter((e) => e.k === 'pc.new').length,
    connectCalls: w.filter((e) => e.k === 'api.req' && e.action === 'connect').map((e) => ({ t: at(e), desk: e.desk === ALLOWED ? 'test' : 'other', start: e.start })),
    sessionOpens: w.filter((e) => e.k === 'ws' && e.dir === '->' && e.type === 'session.open').map((e) => at(e)),
    sessionCloses: w.filter((e) => e.k === 'ws' && e.type === 'session.close').map((e) => ({ t: at(e), reason: e.reason })),
    sessionClosed: w.filter((e) => e.k === 'ws' && e.type === 'session.closed').map((e) => ({ t: at(e), reason: e.reason })),
    errors: w.filter((e) => e.k === 'ws' && e.type === 'error').map((e) => ({ t: at(e), code: e.code })),
    panel: w.filter((e) => e.k === 'panel' && e.desk === ALLOWED).map((e) => ({ t: at(e), label: e.label.replace(/^[^,]+, \d+ apps, /, '') })),
    consoleErrors: w.filter((e) => e.k === 'console').length,
    appIceRestartedMarks: restartedAfter - restartedBefore,
    pongsSinceLive: settled.pongs - pongsThen,
    rpcSinceLive: events.filter((e) => e.k === 'rpc.res').length - rpcThen,
    candidateAfter: `${settled.local}->${settled.remote}`,
    candidateBefore: `${before.local}->${before.remote}`,
  });
  log('RESULT', JSON.stringify(results.at(-1)));
  if (!ok) break;
}

log('marks', JSON.stringify(Object.keys(marks)));
log('SUMMARY', JSON.stringify(results));
await shutdown(0, 'done');
