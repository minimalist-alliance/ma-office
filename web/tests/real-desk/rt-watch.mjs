#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unused-vars */
// Holds one signed-in tab on the overview and logs what the app does, for a desk-side break by someone else.
// It never focuses a desk, never touches the page, and refuses start:true to any desk.
//
//   node rt-watch.mjs --minutes 45 --log /abs/path/watch.log
//
// Options: --expect-version <v> (default below), --linger-read <s> (keep reading the desk after the browser
// closes, to see the gateway let go of the session). SIGTERM, SIGINT and SIGHUP close it cleanly, exit 0.
// Exit: 0 finished or signalled, 1 failed, 2 the guard tripped, 64 bad arguments.
import { openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALLOWED, events, getDesk, HOST, log, logConfig, openSession, OTHER, pcStats, S, shutdown, wait } from './rt-lib.mjs';
import { LossTracker, statusOf } from './rt-watch-derive.mjs';

const DEFAULT_VERSION = '2026.11.05-b910fb7';

function usage(message) {
  process.stderr.write(`${message}\nusage: node rt-watch.mjs --minutes <n> --log <path> [--expect-version <v>] [--linger-read <seconds>]\n`);
  process.exit(64);
}
const args = { minutes: null, log: null, expectVersion: DEFAULT_VERSION, lingerRead: 0 };
for (let i = 2; i < process.argv.length; i += 2) {
  const [flag, value] = [process.argv[i], process.argv[i + 1]];
  if (value === undefined) usage(`${flag} needs a value`);
  if (flag === '--minutes') args.minutes = Number(value);
  else if (flag === '--log') args.log = value;
  else if (flag === '--expect-version') args.expectVersion = value;
  else if (flag === '--linger-read') args.lingerRead = Number(value);
  else usage(`unknown option ${flag}`);
}
if (!(args.minutes > 0)) usage('--minutes must be above 0');
if (!args.log) usage('--log is required');
if (!(args.lingerRead >= 0)) usage('--linger-read must be 0 or more');

// ----- one line per event, to the file and stdout. Nothing is written until the bundle's version heads the log.

const logPath = resolve(args.log);
let fd;
try {
  fd = openSync(logPath, 'a'); // never overwrites an earlier run: each run has its own heading
} catch (e) {
  usage(`can't open the log: ${e.message}`);
}
const started = Date.now();
let held = [];
const write = (text) => {
  writeSync(fd, `${text}\n`);
  process.stdout.write(`${text}\n`);
};
const emit = (text) => {
  if (held) held.push(text);
  else write(text);
};
logConfig.line = (at, text) => emit(`${new Date(at).toISOString()} ${`+${((at - started) / 1000).toFixed(3)}`.padStart(11)} ${text}`);

function releaseHeading(version) {
  const lines = [
    `=== rt-watch start ${new Date(started).toISOString()} pid=${process.pid} minutes=${args.minutes}`,
    `=== BUNDLE ${version ?? 'UNKNOWN'} (from the page's /v/<version>/ asset path)${version === args.expectVersion ? ' matches the expected version' : ` DOES NOT MATCH expected ${args.expectVersion}`}`,
  ];
  for (const l of lines) write(l);
  for (const l of held ?? []) write(l);
  held = null;
}

async function pageVersion(page) {
  return page.evaluate(() => {
    const re = /\/v\/([^/]+)\//;
    const urls = [...document.querySelectorAll('script[src], link[href]')].map((el) => el.src || el.href).concat(performance.getEntriesByType('resource').map((r) => r.name));
    for (const u of urls) {
      const m = re.exec(new URL(u, location.href).pathname);
      if (m) return m[1];
    }
    return null;
  });
}

// ----- the events

const tracker = new LossTracker(ALLOWED, (r) => {
  const near = (v) => (v === null ? 'none' : `${v}`);
  log(
    `DERIVED loss#${r.loss} outcome=${r.outcome} closeToNextOpenedS=${near(r.closeToNextOpenedS)} closeToOnlineS=${near(r.closeToOnlineS)}`,
    `troubleToCloseS=${near(r.troubleToCloseS)} troubleToOnlineS=${near(r.troubleToOnlineS)} closeToWinningOpenedS=${near(r.closeToWinningOpenedS)} elapsedS=${r.elapsedS}`,
    `sessionOpened=${r.sessionOpened} restartOffers=${r.restartOffers} first=${JSON.stringify(r.firstTrouble)}`,
    `closes=${JSON.stringify(r.closes)} connects=${JSON.stringify(r.connects)} statuses=${JSON.stringify(r.statuses)} statusNow=${JSON.stringify(r.statusNow)}`,
  );
});

const deskName = (id) => (id === ALLOWED ? 'test' : id === OTHER ? 'other' : '?');
const fields = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');

let opensShown = 0;
let rpcAwaited = false;
let restartOffers = 0;
let consoleProblems = 0;
const tally = { connectFalse: 0, connectTrue: 0, connectFailed: 0, desksPolls: 0, frames: 0 };

function line(e) {
  const { at, k, ...d } = e;
  switch (k) {
    case 'api.req':
      if (d.action === 'connect') {
        if (d.start === false) tally.connectFalse += 1;
        else tally.connectTrue += 1;
      }
      return `CONNECT> ${fields({ desk: deskName(d.desk), action: d.action === 'connect' ? undefined : d.action, start: d.start })}`;
    case 'api.res':
      return `CONNECT< ${fields({ desk: deskName(d.desk), action: d.action === 'connect' ? undefined : d.action, start: d.start, status: d.status, state: d.state, phase: d.phase ?? 'null', ms: d.ms, retryAfter: d.retryAfter, retryAfterSeconds: d.retryAfterSeconds, pollAfterSeconds: d.pollAfterSeconds, queue: d.queue, error: d.errorCode })}`;
    case 'api.fail':
      tally.connectFailed += 1;
      return `CONNECT! ${fields({ desk: deskName(d.desk), start: d.start, ms: d.ms, error: d.error })}`;
    case 'api.list':
      tally.desksPolls += 1;
      return `DESKS ${fields({
        status: d.status,
        pollAfterSeconds: d.pollAfterSeconds,
        test: d.list?.filter((x) => x.id === ALLOWED).map((x) => `${x.state}/${x.phase}`)[0],
        other: d.list?.filter((x) => x.id === OTHER).map((x) => `${x.state}/${x.phase}`)[0],
      })}`;
    case 'api.list.fail':
      return `DESKS! ${fields({ error: d.error })}`;
    case 'ws': {
      tally.frames += 1;
      const tag = d.dir === '->' ? 'GW>' : 'GW<';
      const { dir, type, data, ...rest } = d;
      const signal = data ? { signal: data.type, restart: data.restart, signalCode: data.code, signalMessage: data.message } : {};
      if (dir === '<-' && type === 'session.opened' && d.desk === 'test') {
        // The tracker has just counted it. A resume keeps the same session, so it says so.
        const isResume = tracker.opened === opensShown;
        opensShown = tracker.opened;
        return `${tag} ${type} ${fields({ ...rest, ...signal })} count=${tracker.opened}${isResume ? ` resumeOfSameSession=true resumed=${tracker.resumed}` : ''}`;
      }
      return `${tag} ${type} ${fields({ ...rest, ...signal })}`;
    }
    case 'ws.new':
      return `SOCKET new ${fields(d)}`;
    case 'ws.open':
      return `SOCKET open ${fields(d)}`;
    case 'ws.close':
      return `SOCKET close ${fields(d)}`;
    case 'ws.error':
      return `SOCKET error ${fields(d)}`;
    case 'pc.new':
      return `PC new ${fields(d)}`;
    case 'pc.state':
      return `PC ${fields({ pc: d.pc, change: d.ev.replace('statechange', ''), connection: d.connection, ice: d.ice, signaling: d.signaling })}`;
    case 'pc.close':
      return `PC closed-by-app ${fields(d)}`;
    case 'pc.createOffer':
      if (d.iceRestart) {
        restartOffers += 1;
        return `ICE-RESTART offer ${fields({ pc: d.pc, iceRestart: true, count: restartOffers })}`;
      }
      return `PC createOffer ${fields({ pc: d.pc, iceRestart: false })}`;
    case 'pc.setLocalDescription':
      return `PC setLocalDescription ${fields(d)}`;
    case 'pc.setRemoteDescription':
      return `PC setRemoteDescription ${fields(d)}`;
    case 'pc.restartIce':
      return `ICE-RESTART restartIce() ${fields(d)}`;
    case 'dc.open':
      return d.label === 'ctl' || d.label === 'rpc' ? `CHANNEL open ${fields(d)}` : null;
    case 'dc.close':
      return `CHANNEL close ${fields(d)}`;
    case 'ctl.close':
      return `CTL-CLOSE ${fields({ pc: d.pc, code: d.code, reason: d.reason })}`;
    case 'ctl.hello.sent':
      return `CTL-HELLO> ${fields({ pc: d.pc, appVersion: d.appVersion, resume: d.resume })}${d.appVersion === args.expectVersion ? '' : ` DOES NOT MATCH expected ${args.expectVersion}`}`;
    case 'ctl.hello':
      rpcAwaited = true;
      return `CTL-HELLO< ${fields({ pc: d.pc, resumed: d.resumed, deskApi: d.deskApi })}`;
    case 'rpc.res':
      if (!rpcAwaited) return null; // every 15 s: only the first after each session shows
      rpcAwaited = false;
      return `RPC first reply on this session ${fields(d)}`;
    case 'rpc.err':
      return `RPC-ERR ${fields(d)}`;
    case 'panel':
      return `STATUS ${fields({ desk: deskName(d.desk) })} status=${JSON.stringify(statusOf(d.label))}`;
    default:
      return `${k} ${fields(d)}`;
  }
}

S.onEvent = (e) => {
  // The tracker goes first: the session.opened line reads its count.
  tracker.feed(e);
  const text = line(e);
  if (text) logConfig.line(e.at, text);
};

// ----- closing

S.sigExitCode = 0;
S.hardExitMs = 20000 + args.lingerRead * 1000;
S.beforeExit = (why) => {
  tracker.finishOpen(Date.now());
  consoleProblems = events.filter((e) => e.k === 'console').length;
  log(
    `SUMMARY why=${JSON.stringify(why)} session.opened=${tracker.opened} resumed=${tracker.resumed} losses=${tracker.records.length}`,
    `recovered=${tracker.records.filter((r) => r.outcome !== 'not-recovered-at-exit').length} notRecovered=${tracker.records.filter((r) => r.outcome === 'not-recovered-at-exit').length}`,
    `connect.startFalse=${tally.connectFalse} connect.startTrue=${tally.connectTrue} connect.failed=${tally.connectFailed} desksPolls=${tally.desksPolls} iceRestartOffers=${restartOffers} consoleProblems=${consoleProblems}`,
  );
};
S.afterClose = async () => {
  // Read-only, from here: has the gateway let go of the session, and when may the sweep stop the desk?
  const until = Date.now() + args.lingerRead * 1000;
  let last = '';
  for (;;) {
    const d = await getDesk().catch(() => null);
    const key = JSON.stringify([d?.state, d?.clientConnected, d?.autoStopAt]);
    if (d && key !== last) {
      last = key;
      log(`DESK after close ${fields({ state: d.state, phase: d.phase, clientConnected: d.clientConnected, agentBusy: d.agentBusy, autoStopMinutes: d.autoStopMinutes, lastActiveAt: d.lastActiveAt, autoStopAt: d.autoStopAt })}`);
    }
    if (Date.now() >= until || d?.clientConnected === false) return;
    await wait(5000);
  }
};

// ----- run

await openSession({
  watch: true,
  onLanding: async (page) => {
    const limit = Date.now() + 15000;
    let version = null;
    while (!version && Date.now() < limit) {
      version = await pageVersion(page).catch(() => null);
      if (!version) await wait(100);
    }
    releaseHeading(version);
  },
});
log('signed in');

// A later load of the app (a bundle reload, a sign-in) is an event too, and may change the version.
S.page.on('load', () => {
  if (S.closing) return;
  let url;
  try {
    url = new URL(S.page.url());
  } catch {
    return;
  }
  if (url.origin !== new URL(HOST).origin) {
    log(`PAGE-LOAD host=${url.hostname} path=${url.pathname}`);
    return;
  }
  tracker.feed({ at: Date.now(), k: 'pageload' });
  void pageVersion(S.page)
    .then((v) => log(`PAGE-LOAD path=${url.pathname} bundle=${v}${v === args.expectVersion ? '' : ` DOES NOT MATCH expected ${args.expectVersion}`}`))
    .catch(() => {});
});

const endAt = Date.now() + args.minutes * 60 * 1000;
setTimeout(() => void shutdown(0, `--minutes ${args.minutes} reached`), args.minutes * 60 * 1000);
log(`holding until ${new Date(endAt).toISOString()}`);

await wait(1500);
const version = await pageVersion(S.page).catch(() => null);
log(`VERSION after sign-in bundle=${version}${version === args.expectVersion ? '' : ` DOES NOT MATCH expected ${args.expectVersion}`} view=${await S.page.evaluate(() => localStorage.getItem('ma.view.v1')).catch(() => null)}`);
try {
  const d = await getDesk();
  log(`DESK at start ${fields({ state: d.state, phase: d.phase, kind: d.kind, allowedActions: d.allowedActions, clientConnected: d.clientConnected, agentBusy: d.agentBusy, autoStopMinutes: d.autoStopMinutes, lastActiveAt: d.lastActiveAt, autoStopAt: d.autoStopAt })}`);
} catch (e) {
  log(`DESK at start not read: ${e.message}`);
}

// Which path it's on, whenever that changes, and a once-a-minute line that proves the watch is alive.
let lastPath = '';
let lastTick = Date.now();
while (!S.closing) {
  await wait(5000);
  const s = await pcStats().catch(() => null);
  if (!s) continue;
  const path = s.pc ? `pc=${s.pc} pair=${s.local}->${s.remote}` : 'no peer connection';
  if (path !== lastPath) {
    lastPath = path;
    log(`PATH ${path}`);
  }
  if (Date.now() - lastTick >= 60000) {
    lastTick = Date.now();
    log(`TICK status=${JSON.stringify(statusOf(S.labels[ALLOWED] ?? ''))} ${path} ${fields({ connection: s.connection, ice: s.ice, dtls: s.dtls, rttMs: s.rttMs, rxBytes: s.bytesRx, pongs: s.pongs, lastPongAgoMs: s.lastPongAgoMs, hidden: s.hidden })} session.opened=${tracker.opened} losses=${tracker.records.length}`);
  }
}
