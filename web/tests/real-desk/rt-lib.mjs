// Shared by rt-ice.mjs, rt-wake.mjs and rt-watch.mjs: real sign-in as staging test user desk-1, the wake guard, and
// the probes. Credentials stay in memory; every log line goes through scrub(). No tracing, no storage state.
import { execFile, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

// The staging test desks, from the environment: RT_DESK (the one these scripts may wake and drive), RT_OTHER_DESK (a
// second desk of the same test user) and RT_INSTANCE (RT_DESK's instance; read-only describes confirm DeskId and DeskKind=test).
export const ALLOWED = process.env.RT_DESK ?? '';
export const OTHER = process.env.RT_OTHER_DESK ?? '';
export const INSTANCE = process.env.RT_INSTANCE ?? '';
if (!/^d-[a-z0-9]{12}$/.test(ALLOWED) || !/^i-[0-9a-f]{8,17}$/.test(INSTANCE)) throw new Error('set RT_DESK and RT_INSTANCE to the staging test desk');
export const HOST = 'https://test.office.staging.minimalistalliance.com/';
const SCRATCH = new URL('../../test-results/real-desk/', import.meta.url).pathname;
mkdirSync(SCRATCH, { recursive: true });
const LAST_SIGNIN = `${SCRATCH}/rt-last-signin.txt`; // a timestamp only, so a TOTP code is never reused

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- logging

const secrets = new Set();
export function scrub(v) {
  let s = String(v);
  for (const x of secrets) if (x) s = s.split(x).join('[redacted]');
  return s
    .replace(/eyJ[\w-]+\.[\w-]+(\.[\w-]+)?/g, '[jwt]')
    .replace(/([?&](?:code|state)=)[^&\s"']+/gi, '$1[redacted]') // query strings only: state=running stays readable
    .replace(/\b(token|password|secret|credential|resumeToken|deskToken)=[^&\s"']+/gi, '$1=[redacted]');
}

const T0 = Date.now();
let markName = 'start';
let markAt = T0;
export const marks = {};
export const events = [];
/** Set `line` to take over the line format. Text arrives already scrubbed. */
export const logConfig = { line: null };
const fmt = (ms) => (ms / 1000).toFixed(3).padStart(9);

export function logAt(at, ...parts) {
  if (logConfig.line) {
    logConfig.line(at, scrub(parts.join(' ')));
    return;
  }
  const rel = `${markName}${at >= markAt ? '+' : ''}${((at - markAt) / 1000).toFixed(3)}`;
  console.log(`${fmt(at - T0)} | ${rel.padEnd(26)} | ${scrub(parts.join(' '))}`);
}
export const log = (...parts) => logAt(Date.now(), ...parts);

export function mark(name) {
  markName = name;
  markAt = Date.now();
  marks[name] = markAt;
  log('=== MARK', name);
  return markAt;
}

// ----- the page's probes. Only states, call names, counts and whitelisted fields leave the page.

export function probeInit({ allowed, watch = false }) {
  if (window.__maProbeInstalled) return;
  window.__maProbeInstalled = true;
  const send = (k, d) => {
    try {
      window.__maProbe({ at: Date.now(), k, ...d });
    } catch {
      /* binding not there yet */
    }
  };

  // Guard and record: refuses a wake of any other desk before it leaves the page.
  const nativeFetch = window.fetch;
  const describe = async (res) => {
    try {
      const b = await res.clone().json();
      const list = Array.isArray(b.desks) ? b.desks.map((d) => ({ id: d.deskId, state: d.state, phase: d.phase ?? null })) : undefined;
      return {
        state: b.state,
        phase: b.phase ?? null,
        stopAt: b.stopAt ?? null,
        retryAfterSeconds: b.retryAfterSeconds,
        pollAfterSeconds: b.pollAfterSeconds,
        queue: b.queue?.position ?? null,
        fingerprints: b.deskIdentity?.fingerprintsSha256?.length,
        errorCode: b.error?.code,
        list,
      };
    } catch {
      return {};
    }
  };
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const m = /\/v1\/desks\/([^/?]+)\/(connect|start|stop|resize|destroy|export)(?:\?|$)/.exec(url);
    if (m && method === 'POST') {
      let start;
      try {
        start = !!JSON.parse(init?.body ?? '{}').start;
      } catch {
        start = undefined;
      }
      const desk = m[1];
      const action = m[2];
      send('api.req', { desk, action, start });
      // A watch wakes nothing, anywhere. Otherwise only the allowed desk may be woken.
      if ((watch || desk !== allowed) && (action !== 'connect' || start !== false)) {
        try {
          window.__maGuard({ desk, action, start });
        } catch {
          /* the Node-side observer also trips */
        }
        return Promise.reject(new TypeError('blocked by the test guard'));
      }
      const t0 = Date.now();
      return nativeFetch.apply(this, arguments).then(
        (res) => {
          // Never holds the app back: the body is read from a copy, on the side.
          void describe(res.clone()).then((d) => send('api.res', { desk, action, start, status: res.status, ms: Date.now() - t0, retryAfter: res.headers.get('Retry-After'), ...d }));
          return res;
        },
        (err) => {
          send('api.fail', { desk, action, start, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 120) });
          throw err;
        },
      );
    }
    if (method === 'GET' && /\/v1\/desks(?:\?|$)/.test(url)) {
      return nativeFetch.apply(this, arguments).then(
        (res) => {
          if (res.status === 200) void describe(res.clone()).then((d) => send('api.list', { status: res.status, ...d }));
          else send('api.list', { status: res.status });
          return res;
        },
        (err) => {
          send('api.list.fail', { error: String(err?.message ?? err).slice(0, 120) });
          throw err;
        },
      );
    }
    return nativeFetch.apply(this, arguments);
  };

  // A watch reads gateway frames here, in the app's own order. Fields are whitelisted before they leave
  // the page, so no token, SDP or TURN credential ever crosses to Node.
  if (watch) {
    const NativeWS = window.WebSocket;
    const frame = (dir, text) => {
      if (typeof text !== 'string') return;
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (m.type === 'ping' || m.type === 'pong') return;
      send('ws', {
        dir,
        type: m.type,
        desk: m.deskId === allowed ? 'test' : m.deskId ? 'other' : undefined,
        session: m.sessionId ? `…${m.sessionId.slice(-4)}` : undefined,
        data: m.data ? { type: m.data.type, restart: m.data.restart, code: m.data.code, message: m.data.message } : undefined,
        code: m.code,
        message: m.message,
        retryable: m.retryable,
        reason: m.reason,
        state: m.state,
        phase: m.phase,
        stopAt: m.stopAt,
        stopReason: m.stopReason,
        change: m.change,
        queue: m.queue?.position,
        error: m.error ? { code: m.error.code, message: m.error.message } : undefined,
        iceServers: Array.isArray(m.iceServers) ? m.iceServers.length : undefined,
      });
    };
    window.WebSocket = class extends NativeWS {
      constructor(url, protocols) {
        super(url, protocols);
        const host = new URL(url, location.href).hostname;
        send('ws.new', { host });
        this.addEventListener('open', () => send('ws.open', { host }));
        this.addEventListener('close', (e) => send('ws.close', { host, code: e.code, reason: e.reason, clean: e.wasClean }));
        this.addEventListener('error', () => send('ws.error', { host }));
        this.addEventListener('message', (e) => frame('<-', e.data));
      }
      send(data) {
        frame('->', data);
        return super.send(data);
      }
    };
  }

  // The peer connection: state changes and the calls that matter. No SDP leaves this function.
  const Native = window.RTCPeerConnection;
  if (!Native) return;
  let seq = 0;
  window.__pcs = [];
  window.__pongs = 0;
  window.__lastPongAt = 0;
  const decoder = new TextDecoder();
  const watchChannel = (pc, dc, label) => {
    dc.addEventListener('open', () => send('dc.open', { pc: pc.__id, label }));
    dc.addEventListener('close', () => send('dc.close', { pc: pc.__id, label }));
    if (watch && label === 'ctl') {
      // The bundle's own version, from the HELLO it sends. Passes the frame on untouched.
      const nativeSend = dc.send.bind(dc);
      dc.send = (d) => {
        try {
          const bytes = d instanceof Uint8Array ? d : new Uint8Array(d);
          if (bytes[1] === 1) {
            const body = JSON.parse(decoder.decode(bytes.subarray(12)));
            send('ctl.hello.sent', { pc: pc.__id, appVersion: body.appVersion, resume: !!body.resume });
          }
        } catch {
          /* not one to read */
        }
        return nativeSend(d);
      };
    }
    if (label !== 'ctl' && label !== 'rpc') return;
    dc.addEventListener('message', (e) => {
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 12) return;
      const bytes = new Uint8Array(e.data);
      const kind = bytes[1];
      if (kind === 5) {
        window.__pongs += 1;
        window.__lastPongAt = Date.now();
        return;
      }
      if (kind === 6 || kind === 1 || kind === 9) {
        let body = {};
        try {
          body = JSON.parse(decoder.decode(bytes.subarray(12)));
        } catch {
          /* not JSON */
        }
        if (kind === 6) send('ctl.close', { pc: pc.__id, code: body.code, reason: body.reason });
        else if (kind === 1) send('ctl.hello', { pc: pc.__id, resumed: body.resumed, deskApi: body.deskApi });
        else send('rpc.err', { pc: pc.__id, code: body.code });
      } else if (kind === 8) {
        send('rpc.res', { pc: pc.__id, bytes: e.data.byteLength });
      }
    });
  };
  class Wrapped extends Native {
    constructor(config) {
      super(config);
      this.__id = ++seq;
      window.__pcs.push(this);
      send('pc.new', { pc: this.__id, iceServers: (config?.iceServers ?? []).length });
      for (const ev of ['connectionstatechange', 'iceconnectionstatechange', 'signalingstatechange']) {
        this.addEventListener(ev, () =>
          send('pc.state', { pc: this.__id, ev, connection: this.connectionState, ice: this.iceConnectionState, signaling: this.signalingState }),
        );
      }
    }
    createOffer(options) {
      send('pc.createOffer', { pc: this.__id, iceRestart: !!options?.iceRestart });
      return super.createOffer(options);
    }
    setLocalDescription(d) {
      const ufrag = /a=ice-ufrag:(\S+)/.exec(d?.sdp ?? '')?.[1];
      const changed = ufrag && this.__ufrag ? ufrag !== this.__ufrag : null;
      if (ufrag) this.__ufrag = ufrag;
      send('pc.setLocalDescription', { pc: this.__id, type: d?.type, ufragChanged: changed });
      return super.setLocalDescription(d);
    }
    setRemoteDescription(d) {
      send('pc.setRemoteDescription', { pc: this.__id, type: d?.type });
      return super.setRemoteDescription(d);
    }
    restartIce() {
      send('pc.restartIce', { pc: this.__id });
      return super.restartIce();
    }
    close() {
      send('pc.close', { pc: this.__id });
      return super.close();
    }
    createDataChannel(label, options) {
      const dc = super.createDataChannel(label, options);
      watchChannel(this, dc, label);
      return dc;
    }
  }
  window.RTCPeerConnection = Wrapped;

  window.__pcStats = async () => {
    const pc = [...window.__pcs].reverse().find((p) => p.signalingState !== 'closed');
    if (!pc) return { pc: null, pongs: window.__pongs };
    const stats = await pc.getStats();
    let transport = null;
    let msgRx = 0;
    let msgTx = 0;
    let open = 0;
    stats.forEach((r) => {
      if (r.type === 'transport') transport = r;
      if (r.type === 'data-channel') {
        msgRx += r.messagesReceived ?? 0;
        msgTx += r.messagesSent ?? 0;
        if (r.state === 'open') open += 1;
      }
    });
    const pair = transport?.selectedCandidatePairId ? stats.get(transport.selectedCandidatePairId) : null;
    const local = pair ? stats.get(pair.localCandidateId) : null;
    const remote = pair ? stats.get(pair.remoteCandidateId) : null;
    return {
      pc: pc.__id,
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      dtls: transport?.dtlsState,
      bytesRx: transport?.bytesReceived,
      bytesTx: transport?.bytesSent,
      pktRx: transport?.packetsReceived,
      pktTx: transport?.packetsSent,
      pairChanges: transport?.selectedCandidatePairChanges,
      local: local ? `${local.candidateType}/${local.protocol}${local.relayProtocol ? `/${local.relayProtocol}` : ''}` : null,
      remote: remote ? `${remote.candidateType}/${remote.protocol}` : null,
      rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      checksSent: pair?.requestsSent,
      checksAnswered: pair?.responsesReceived,
      dcOpen: open,
      msgRx,
      msgTx,
      pongs: window.__pongs,
      lastPongAgoMs: window.__lastPongAt ? Date.now() - window.__lastPongAt : null,
      hidden: document.hidden,
    };
  };

  // What the panel says, from its accessible name, at most 100 ms late.
  const labels = {};
  setInterval(() => {
    const present = new Set();
    for (const b of document.querySelectorAll('button.proxy[id^="proxy-d-"]')) {
      const id = b.id.slice('proxy-'.length);
      if (id.includes(':')) continue; // a tile, not the desk
      present.add(id);
      const l = b.getAttribute('aria-label');
      if (labels[id] !== l) {
        labels[id] = l;
        send('panel', { desk: id, label: l });
      }
    }
    if (!watch) return;
    for (const id of Object.keys(labels)) {
      if (!present.has(id) && labels[id] !== null) {
        labels[id] = null;
        send('panel', { desk: id, label: null }); // the button is gone, as on a signed-out screen
      }
    }
  }, 100);
}

// ----- the session

export function totp(secret) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(ctr).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

export const S = {
  browser: null,
  context: null,
  page: null,
  cdp: null,
  token: null,
  apiBase: null,
  labels: {},
  connects: [],
  closing: false,
  guardTripped: false,
  shot: 0,
  watch: false,
  sigExitCode: null,
  hardExitMs: 20000,
  onEvent: null,
  beforeExit: null,
  afterClose: null,
  onGuardTrip: null,
};

async function tripGuard(what) {
  if (S.onGuardTrip) {
    S.onGuardTrip(what); // the guard's own self-test
    return;
  }
  if (S.guardTripped) return;
  S.guardTripped = true;
  log('!!! GUARD TRIPPED: refused or saw', JSON.stringify(what), '- aborting at once');
  try {
    await S.browser?.close();
  } catch {
    /* closing anyway */
  }
  process.exit(2);
}

export async function shutdown(code, why) {
  if (S.closing) return;
  S.closing = true;
  setTimeout(() => process.exit(code), S.hardExitMs).unref(); // nothing below may hang the exit
  log('SHUTDOWN', why ?? '', `exit=${code}`);
  try {
    S.beforeExit?.(why);
  } catch (e) {
    log('beforeExit failed', e.message);
  }
  try {
    if (S.cdp) await S.cdp.send('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] });
  } catch {
    /* page already gone */
  }
  try {
    // Leaving the page fires pagehide, which is what sends session.close to the gateway.
    if (S.page) {
      await S.page.goto('about:blank', { timeout: 5000 });
      await wait(800);
    }
  } catch {
    /* closing anyway */
  }
  try {
    await S.browser?.close();
  } catch {
    /* gone */
  }
  log('browser closed');
  try {
    await S.afterClose?.();
  } catch (e) {
    log('afterClose failed', e.message);
  }
  process.exit(code);
}

function onProbe(e) {
  events.push(e);
  const { at, k, ...d } = e;
  if (k === 'panel') S.labels[d.desk] = d.label;
  if (S.onEvent) {
    S.onEvent(e);
    return;
  }
  if (k === 'panel') {
    logAt(at, 'PANEL', d.desk === ALLOWED ? 'test' : 'other', JSON.stringify(d.label));
    S.onPanel?.(d);
    return;
  }
  if (k === 'pc.state') {
    logAt(at, `PC#${d.pc}`, d.ev.replace('statechange', ''), `conn=${d.connection} ice=${d.ice} sig=${d.signaling}`);
    return;
  }
  logAt(at, k, JSON.stringify(d));
}

function observeSocket(ws) {
  log('ws open', new URL(ws.url()).hostname);
  const show = (dir) => (ev) => {
    const at = Date.now();
    let m;
    try {
      m = JSON.parse(ev.payload);
    } catch {
      log(dir, 'non-json');
      return;
    }
    if (m.type === 'ping' || m.type === 'pong') return;
    const safe = {
      desk: m.deskId === ALLOWED ? 'test' : m.deskId ? 'other' : undefined,
      session: m.sessionId ? `…${m.sessionId.slice(-4)}` : undefined,
      data: m.data ? { type: m.data.type, restart: m.data.restart, code: m.data.code, message: m.data.message } : undefined,
      code: m.code,
      message: m.message,
      retryable: m.retryable,
      reason: m.reason,
      state: m.state,
      phase: m.phase,
      stopAt: m.stopAt,
      stopReason: m.stopReason,
      queue: m.queue?.position,
      error: m.error ? { code: m.error.code, message: m.error.message } : undefined,
      iceServers: Array.isArray(m.iceServers) ? m.iceServers.length : undefined,
    };
    events.push({ at, k: 'ws', dir, type: m.type, ...safe });
    logAt(at, 'WS', dir, m.type, JSON.stringify(safe));
  };
  ws.on('framesent', show('->'));
  ws.on('framereceived', show('<-'));
  ws.on('close', () => log('ws close'));
}

/** The second layer: sees every request in the context, wherever it came from. */
export function observeRequests(context, { watch = false } = {}) {
  context.on('request', (r) => {
    let url;
    try {
      url = new URL(r.url());
    } catch {
      return;
    }
    if (!url.hostname.startsWith('api.')) return;
    const keep = (auth) => {
      if (!auth?.startsWith('Bearer ')) return;
      S.token = auth.slice('Bearer '.length);
      secrets.add(S.token);
      S.apiBase = url.origin;
    };
    const auth = r.headers().authorization;
    if (auth) keep(auth);
    else if (r.method() !== 'OPTIONS') void r.allHeaders().then((h) => keep(h.authorization)).catch(() => {});
    const m = /^\/v1\/desks\/([^/]+)\/(connect|start|stop|resize|destroy|export)$/.exec(url.pathname);
    if (!m || r.method() !== 'POST') return;
    let start;
    try {
      start = !!JSON.parse(r.postData() ?? '{}').start;
    } catch {
      start = undefined;
    }
    S.connects.push({ at: Date.now(), desk: m[1], action: m[2], start });
    if ((watch || m[1] !== ALLOWED) && (m[2] !== 'connect' || start !== false)) void tripGuard({ desk: m[1], action: m[2], start });
  });
}

/** Staging only, test users only. Every secret goes on the scrub list before anything can log it. */
export function readTestUser(name) {
  const u = JSON.parse(
    execFileSync('aws', ['ssm', 'get-parameter', '--name', `/ma/staging/test-users/${name}`, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  if (!u.email.toLowerCase().endsWith('@test.minimalistalliance.com')) throw new Error('refusing: not a test user');
  secrets.add(u.password);
  secrets.add(u.totpSecret);
  secrets.add(u.email);
  return u;
}

export async function openSession({ browserKind = 'shell', watch = false, onLanding = null, onContext = null, launchArgs = [], contextOptions = {} } = {}) {
  const u = readTestUser('desk-1');
  S.watch = watch;

  process.on('uncaughtException', (e) => {
    log('FATAL', e?.message ?? e);
    void shutdown(1, 'uncaught');
  });
  process.on('unhandledRejection', (e) => {
    log('FATAL', e?.message ?? e);
    void shutdown(1, 'unhandled');
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void shutdown(S.sigExitCode ?? 1, sig));

  // Playwright would otherwise close the browser itself on a signal, before the page can leave cleanly.
  const signals = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
  S.browser = await chromium.launch({ ...(browserKind === 'full' ? { channel: 'chromium' } : {}), ...signals, args: launchArgs });
  log('browser', browserKind, S.browser.version());
  S.context = await S.browser.newContext({ viewport: { width: 1440, height: 900 }, ...contextOptions });
  await S.context.exposeBinding('__maProbe', (_src, e) => onProbe(e));
  await S.context.exposeBinding('__maGuard', (_src, e) => tripGuard(e));
  await S.context.addInitScript(probeInit, { allowed: ALLOWED, watch });
  observeRequests(S.context, { watch });
  await onContext?.(S.context); // before the first page: a test's own init script goes here
  S.context.on('response', (r) => {
    try {
      const url = new URL(r.url());
      if ((url.hostname.startsWith('api.') || url.pathname === '/oauth2/token') && r.request().method() !== 'OPTIONS') {
        // A watch has its own lines for the calls it follows, so only failures show here.
        if (!watch) log('http', r.status(), r.request().method(), url.pathname);
        else if (r.status() >= 400) log('HTTP-ERR', `status=${r.status()}`, r.request().method(), url.pathname);
      }
    } catch {
      /* not a URL */
    }
  });

  S.page = await S.context.newPage();
  S.page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') {
      events.push({ at: Date.now(), k: 'console', level: t });
      log('CONSOLE', t, m.text().slice(0, 300));
    }
  });
  S.page.on('pageerror', (e) => {
    events.push({ at: Date.now(), k: 'console', level: 'pageerror' });
    log('PAGEERROR', e.message.slice(0, 300));
  });
  if (!watch) S.page.on('websocket', observeSocket);

  try {
    await signIn(u, onLanding);
  } catch (e) {
    throw new Error(`sign-in failed: ${scrub(e.message).slice(0, 400)}`);
  }
  return S;
}

async function signIn(u, onLanding) {
  const p = S.page;
  // A TOTP code can't be used twice: never sign in twice in one 30 s window.
  try {
    const since = Date.now() - Number(readFileSync(LAST_SIGNIN, 'utf8'));
    if (since < 35000) await wait(35000 - since);
  } catch {
    /* first one */
  }
  await p.goto(HOST, { waitUntil: 'load' });
  await onLanding?.(p);
  // Signed out goes straight there by itself: managed login, or our own pages at /_signin/ where client-config has
  // auth.signInPath. Only the loop guard's card has a button, and a form's own button isn't to be pressed empty.
  const THERE = /\/(login|oauth2\/authorize|_signin\/)/;
  const card = p.getByTestId('sign-in').getByRole('button', { name: 'Sign in', exact: true });
  await Promise.race([p.waitForURL(THERE, { timeout: 30000 }), card.click({ timeout: 30000 }).catch(() => undefined)]);
  await p.waitForURL(THERE, { timeout: 30000 });
  const ownPages = new URL(p.url()).pathname.startsWith('/_signin/');
  const user = ownPages ? p.locator('#email') : p.getByLabel(/email|username/i).first();
  await user.waitFor({ timeout: 30000 });
  if ((await user.inputValue()) !== u.email) await user.fill(u.email);
  const pass = ownPages ? p.locator('#password') : p.getByLabel(/^password$/i).first();
  if (!(await pass.isVisible().catch(() => false))) await p.getByRole('button', { name: /^(next|continue)$/i }).click();
  await pass.fill(u.password);
  await p.getByRole('button', { name: /^(sign in|log in|continue|next)$/i }).click();
  const field = p.getByLabel(/code/i).first();
  await field.waitFor({ timeout: 30000 });
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (left < 5) await wait((left + 1) * 1000);
  const code = totp(u.totpSecret);
  secrets.add(code);
  await field.fill(code);
  writeFileSync(LAST_SIGNIN, String(Date.now()));
  // Our own pages submit a full code by themselves.
  if (!ownPages) await p.getByRole('button', { name: /^(sign in|verify|confirm|next|continue|submit)$/i }).click();
  await p.waitForURL((url) => url.hostname === new URL(HOST).hostname && !url.pathname.startsWith('/_signin/'), { timeout: 45000 });
  log('signed in, back at', new URL(p.url()).pathname);
}

export const testLabel = () => S.labels[ALLOWED] ?? '';

/** A desk that's connected: `online · …`, or where desk-agent answers `agent.state`, its agents' word in place of that. */
export const CONNECTED = /online|no key|working|needs you|limit reached|agent error/;

export async function waitPanel(re, timeoutMs) {
  const want = re.source.startsWith('online') ? CONNECTED : re;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (want.test(testLabel())) return true;
    await wait(50);
  }
  return false;
}

export const pcStats = () => S.page.evaluate(() => window.__pcStats());

export function compact(s) {
  if (!s?.pc) return JSON.stringify(s);
  return `pc#${s.pc} conn=${s.connection} ice=${s.ice} dtls=${s.dtls} rx=${s.bytesRx}B/${s.pktRx}p tx=${s.bytesTx}B/${s.pktTx}p pair=${s.local}->${s.remote} rtt=${s.rttMs} checks=${s.checksAnswered}/${s.checksSent} dcOpen=${s.dcOpen} msgs=${s.msgRx}/${s.msgTx} pongs=${s.pongs} lastPong=${s.lastPongAgoMs}ms`;
}

export async function shot(dir, name) {
  S.shot += 1;
  const path = `${dir}/${String(S.shot).padStart(3, '0')}-${name.replace(/[^\w.+-]+/g, '_')}.png`;
  try {
    await S.page.screenshot({ path });
    log('shot', path);
  } catch (e) {
    log('shot failed', e.message.slice(0, 120));
  }
  return path;
}

// ----- read-only and lifecycle calls, as desk-1, on the one allowed desk

export async function getDesk() {
  if (!S.token || !S.apiBase) throw new Error('no token seen yet');
  if (!S.apiBase.includes('.staging.')) throw new Error('refusing: not staging');
  const r = await fetch(`${S.apiBase}/v1/desks/${ALLOWED}`, { headers: { Authorization: `Bearer ${S.token}` } });
  const b = await r.json().catch(() => ({}));
  return { status: r.status, state: b.state, phase: b.phase ?? null, stopAt: b.stopAt ?? null, stopReason: b.stopReason ?? null, stateChangedAt: b.stateChangedAt, allowedActions: b.allowedActions, kind: b.kind, errorCode: b.error?.code, lastError: b.lastError?.code, autoStopMinutes: b.autoStopMinutes, autoStopAt: b.autoStopAt ?? null, lastActiveAt: b.lastActiveAt ?? null, clientConnected: b.activity?.clientConnected, agentBusy: b.activity?.agentBusy };
}

export async function stopDesk() {
  if (!S.token || !S.apiBase) throw new Error('no token seen yet');
  if (!S.apiBase.includes('.staging.')) throw new Error('refusing: not staging');
  const r = await fetch(`${S.apiBase}/v1/desks/${ALLOWED}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${S.token}` } });
  const b = await r.json().catch(() => ({}));
  return { status: r.status, state: b.state, phase: b.phase ?? null, stopAt: b.stopAt ?? null, stopReason: b.stopReason ?? null, errorCode: b.error?.code, errorMessage: b.error?.message };
}

/** EC2's own word, read-only. */
export function ec2State() {
  return new Promise((resolve) => {
    execFile('aws', ['ec2', 'describe-instances', '--instance-ids', INSTANCE, '--query', 'Reservations[0].Instances[0].State.Name', '--output', 'text'], { encoding: 'utf8' }, (err, out) =>
      resolve(err ? 'describe-failed' : out.trim()),
    );
  });
}
