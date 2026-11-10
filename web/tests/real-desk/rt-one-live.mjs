// One live picture per member (task 46, lever 2) on the real test desk as desk-1, with this checkout's own bundle in place of
// staging's (`dist/release`, served by page.route at the app's own origin, so sign-in, CSP and the gateway are the real ones),
// in full Chromium for H.264. Hold ~/work/.test-desk.lock. Never wakes anything: the desk must be running.
//
// It proves, against the real deskd: the desk being looked at hears `desk.attention.set {seen: true}`, and hears `{seen: false}`
// when the member goes to the overview or hides the tab, and what deskd answers (a deskd before the Desk Engineer's part says
// `not_found`, once a session); the topic `desk.attention` is asked for, and what comes of it; and the switch back, timed
// SWITCH_RUNS times (5) after AWAY_MS (8 s, past deskd's 5 s grace) away: from the click to the signal leaving, to deskd's
// answer, and to the first real frame, with every display frame in between looked at for a blank one. On a deskd that knows
// the method, FROZEN_RUNS (2) more go away until the topic says `frozen: true` (60 s with nobody viewing the Browser, up to
// FROZEN_WAIT_MS) and time the switch back from a truly frozen desk, with the topic's thaw and whether "Resuming…" showed. It reads names, `seen`,
// codes and versions off the `rpc` channel, never anything else. It changes nothing on the desk; it opens the Browser window,
// which is already open on the desk's Chromium, and closes it again at the end.
//
//   npm run build:release && flock ~/work/.test-desk.lock timeout 45m nice -n 15 node tests/real-desk/rt-one-live.mjs
//   MA_EXPECT_VERSION=2026.11.07-abc1234 … node tests/real-desk/rt-one-live.mjs   # staging's own bundle, once it's promoted there
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ALLOWED, events, getDesk, log, openSession, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const DIST = new URL('../../dist/release/', import.meta.url).pathname;
const OUT = new URL('../../test-results/real-desk/rt-one-live/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const EXPECTED = process.env.MA_EXPECT_VERSION ?? null;
const release = EXPECTED ? { version: EXPECTED } : JSON.parse(readFileSync(`${DIST}ma-release.json`, 'utf8'));
const RUNS = Number(process.env.SWITCH_RUNS ?? 5);
const AWAY_MS = Number(process.env.AWAY_MS ?? 8_000);
/** Switches back from a desk deskd has frozen (60 s with nobody viewing its Browser), once it says so. Only on a deskd that knows the method. */
const FROZEN_RUNS = Number(process.env.FROZEN_RUNS ?? 2);
const FROZEN_WAIT_MS = Number(process.env.FROZEN_WAIT_MS ?? 120_000);

const results = [];
const notes = {};
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const until = async (fn, ms, every = 200) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await wait(every);
  }
  return null;
};

/**
 * What the page says and hears on `rpc` about attention, the stream and the desk's versions: method names, `seen`, `state`,
 * error codes and reasons, versions, and `seen`/`frozen` on the topic. Never any other value. Records CSP violations too.
 */
function attentionProbe() {
  const w = window;
  const seen = (w.__rtLive = { sent: [], replies: [], events: [], violations: [] });
  document.addEventListener('securitypolicyviolation', (e) => seen.violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI }));
  const asked = new Map();
  const subIds = new Set();
  const text = (bytes) => new TextDecoder().decode(bytes.subarray(12));
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function sendAndNote(d) {
    try {
      if (this.label === 'rpc' && d?.byteLength > 12) {
        const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        const kind = bytes[1];
        const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
        const body = text(bytes);
        const m = /"m":"([a-z.]+)"/.exec(body)?.[1];
        let entry = null;
        if (kind === 7 && m === 'desk.attention.set') entry = { m, seen: JSON.parse(body).p?.seen };
        else if (kind === 7 && m === 'browser.stream.set') entry = { m, state: JSON.parse(body).p?.state };
        else if (kind === 7 && m === 'desk.status.get') entry = { m };
        else if (kind === 10 && /"topic":"desk\.attention"/.test(body)) entry = { m: 'SUB desk.attention' };
        if (entry) {
          Object.assign(entry, { at: performance.now(), pc: this.__pc });
          seen.sent.push(entry);
          asked.set(`${this.__pc}:${id}`, entry);
        }
      }
    } catch {
      /* never in the way */
    }
    return send.call(this, d);
  };
  const Native = w.RTCPeerConnection;
  let pcs = 0;
  w.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      this.__n = ++pcs;
    }
    createDataChannel(label, init) {
      const dc = super.createDataChannel(label, init);
      dc.__pc = this.__n;
      if (label === 'events') {
        // Topic events (EVT frames, kind 12) arrive on the `events` channel, not on `rpc`; the frame's id is the subId.
        dc.addEventListener('message', (e) => {
          try {
            const bytes = new Uint8Array(e.data);
            const key = `${dc.__pc}:${new DataView(e.data).getUint32(4)}`;
            if (bytes[1] !== 12 || !subIds.has(key)) return;
            const b = JSON.parse(text(bytes));
            seen.events.push({ at: performance.now(), pc: dc.__pc, type: b.type, seen: b.data?.seen, frozen: b.data?.frozen });
          } catch {
            /* a piece of a long frame */
          }
        });
        return dc;
      }
      if (label !== 'rpc') return dc;
      dc.addEventListener('message', (e) => {
        try {
          const bytes = new Uint8Array(e.data);
          const kind = bytes[1];
          const id = new DataView(e.data).getUint32(4);
          const key = `${dc.__pc}:${id}`;
          const entry = asked.get(key);
          if ((kind === 8 || kind === 9) && entry) {
            asked.delete(key);
            const b = JSON.parse(text(bytes));
            const r = { m: entry.m, seen: entry.seen, state: entry.state, pc: dc.__pc, ms: Math.round(performance.now() - entry.at), answer: kind === 8 ? 'ok' : b.code, reason: b.details?.reason ?? null };
            if (entry.m === 'desk.status.get' && kind === 8) Object.assign(r, { deskd: b.deskdVersion, rtc: b.rtcVersion });
            if (entry.m === 'desk.attention.set' && kind === 8) r.frozen = typeof b.frozen === 'boolean' ? b.frozen : null;
            if (entry.m === 'SUB desk.attention' && kind === 8) subIds.add(`${dc.__pc}:${b.subId}`);
            entry.answer = r.answer;
            entry.ms = r.ms;
            seen.replies.push(r);
          } else if (kind === 12 && subIds.has(key)) {
            const b = JSON.parse(text(bytes));
            seen.events.push({ at: performance.now(), pc: dc.__pc, type: b.type, seen: b.data?.seen, frozen: b.data?.frozen });
          }
        } catch {
          /* a piece of a long frame, or something else */
        }
      });
      return dc;
    }
  };
}

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 25 * 60 * 1000);
watchdog.unref();

await openSession({
  browserKind: 'full',
  onContext: async (ctx) => {
    await ctx.addInitScript(attentionProbe);
    if (EXPECTED) return;
    await ctx.route(/\/v\/[^/]+\/ma-release\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(release) }));
    await ctx.route(/\/v\/[^/]+\/assets\/[^/?]+/, (route) => {
      const file = `${DIST}assets/${new URL(route.request().url()).pathname.split('/').pop()}`;
      return existsSync(file) ? route.fulfill({ path: file, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } }) : route.continue();
    });
  },
});
const p = S.page;
const live = () => p.evaluate(() => JSON.parse(JSON.stringify(window.__rtLive)));
const attention = async () => (await live()).sent.filter((e) => e.m === 'desk.attention.set');

S.beforeExit = () => {
  try {
    writeFileSync(`${OUT}report.json`, JSON.stringify({ bundle: release.version, results, notes }, null, 2));
  } catch {
    /* the log has it all */
  }
};

const btn = p.locator(`#proxy-${ALLOWED}`);
await btn.waitFor({ state: 'attached', timeout: 60_000 });
const loaded = await p.evaluate(() => [...document.querySelectorAll('script[type="module"]')].map((e) => e.src).find((n) => /\/assets\//.test(n)) ?? null);
const mainAsset = release.entry ? release.entry.split('/').pop() : null;
step('bundle', EXPECTED ? Boolean(loaded?.includes(`/v/${EXPECTED}/`)) : Boolean(mainAsset && loaded?.endsWith(mainAsset)), `${release.version}: ${loaded}`);
const desk = await getDesk();
log('desk', desk.state, desk.phase ?? '');
if (desk.state !== 'running') {
  log(`STOP: the desk is ${desk.state}, and focusing it would wake it`);
  await shutdown(1, 'desk not running');
}

// ----- arriving: desk-1 has two desks, so the office opens on the overview, and the test desk's first session hears unseen
const arrived = await until(async () => (await attention()).find((e) => e.answer), 60_000);
notes.arrival = arrived ? { seen: arrived.seen, answer: arrived.answer, ms: arrived.ms } : null;
step('1 on arrival in the overview, the desk hears seen: false, and answers', arrived?.seen === false, JSON.stringify(notes.arrival));
/** A deskd before the Desk Engineer's part: asked once a session, and no more in it. */
const refused = arrived?.answer === 'not_found';
if (refused) log('NOTE: this deskd answers not_found to desk.attention.set: the office asks no more on this session, so the switches below time the picture only');

// ----- looked at: the desk, its Browser, a picture
await btn.focus();
await p.keyboard.press('Enter');
step('2 the link is open', await waitPanel(/online/, 60_000));
await p.locator(`[id="proxy-${ALLOWED}:browser"]`).focus();
await p.keyboard.press('Enter');
await p.getByRole('dialog', { name: 'Browser' }).first().waitFor({ state: 'visible', timeout: 10_000 });
const video = p.locator('video.br-video');
const frames = () => video.evaluate((v) => v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0);
const playing = async (ms = 45_000) => {
  const a = await until(async () => ((await video.evaluate((v) => v.videoWidth)) > 0 ? frames() : null), ms);
  if (a === null) return false;
  return Boolean(await until(async () => (await frames()) > a, 10_000));
};
step('3 the picture plays', await playing());
await shot(OUT, 'playing');
const l1 = await live();
const status = l1.replies.find((r) => r.m === 'desk.status.get' && r.deskd);
notes.desk = status ? { deskd: status.deskd, rtc: status.rtc } : null;
log('on the desk:', JSON.stringify(notes.desk));
const pcs = [...new Set(l1.sent.map((e) => e.pc))];
notes.peerConnections = pcs.length;
const first = l1.sent.filter((e) => e.m === 'desk.attention.set');
const said = JSON.stringify(first.map((e) => ({ seen: e.seen, answer: e.answer ?? 'none yet', ms: e.ms })));
step('4 focused, the desk hears seen: true, or nothing more where it refused', refused ? first.length === 1 : first.some((e) => e.seen === true && e.answer), `sent ${said}; ${pcs.length} session(s) on this page`);
const sub = l1.sent.find((e) => e.m === 'SUB desk.attention');
notes.topic = sub ? { answer: sub.answer ?? 'none', ms: sub.ms ?? null, events: l1.events } : null;
step('5 the topic is asked for', Boolean(sub?.answer), `desk.attention: ${JSON.stringify(notes.topic)}`);

/**
 * The desk again, from the overview, timed in the page: the click, the signal leaving, the first real frame, every display
 * frame in between looked at for a blank one, and the panels that showed (past their delay). Then deskd's answer to that
 * seen: true, and, on a desk that froze, when the topic said it had thawed.
 */
async function timedSwitch(before) {
  const s = await p.locator(`#proxy-${ALLOWED}`).evaluate(async (button) => {
    const probe = window.__rtLive;
    performance.clearMeasures('ma:browser-back');
    const marks = performance.getEntriesByName('ma:browser-first-frame').length;
    const samples = [];
    const t0 = performance.now();
    button.click();
    await new Promise((done) => {
      const end = performance.now() + 20_000;
      const tick = () => {
        const win = document.querySelector('[data-testid="window-browser"]');
        const held = document.querySelector('[data-testid="browser-held"]');
        const el = document.querySelector('video.br-video');
        const panel = document.querySelector('[data-testid="browser-panel"]');
        samples.push({
          visible: !!win && win.offsetParent !== null,
          still: !!held && !held.hidden && held.width > 0,
          stream: !!el && el.srcObject !== null && el.readyState >= 2 && el.videoWidth > 0,
          panel: panel && Number(getComputedStyle(panel).opacity) > 0.01 ? panel.getAttribute('data-panel') : null,
          panelInDom: panel?.getAttribute('data-panel') ?? null,
        });
        if (performance.getEntriesByName('ma:browser-first-frame').length > marks || performance.now() > end) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const firstFrame = performance.getEntriesByName('ma:browser-first-frame').at(-1);
    const back = performance.getEntriesByName('ma:browser-back').at(-1);
    const sent = probe.sent.filter((e) => e.m === 'desk.attention.set' && e.seen === true && e.at >= t0)[0] ?? null;
    const shown = samples.filter((x) => x.visible);
    // More frames after the first, counted from it (the element's count starts again when it takes the stream back): the
    // picture is moving, not one frame of an old buffer.
    const count = () => document.querySelector('video.br-video')?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const atFirst = count();
    const moving = await new Promise((done) => {
      const end = performance.now() + 5_000;
      const look = () => {
        if (count() > atFirst || performance.now() > end) done(count() - atFirst);
        else setTimeout(look, 20);
      };
      look();
    });
    // "Resuming…" can show only while the desk says seen and frozen, past its delay: watch a little longer for it.
    const resumingUntil = performance.now() + 2_000;
    let resumingShown = shown.some((x) => x.panel === 'resuming');
    while (!resumingShown && performance.now() < resumingUntil) {
      const panel = document.querySelector('[data-testid="browser-panel"]');
      resumingShown = !!panel && panel.getAttribute('data-panel') === 'resuming' && Number(getComputedStyle(panel).opacity) > 0.01;
      await new Promise((r) => setTimeout(r, 20));
    }
    return {
      t0,
      seenSentMs: sent ? Math.round(sent.at - t0) : null,
      firstFrameMs: firstFrame && firstFrame.startTime >= t0 ? Math.round(firstFrame.startTime - t0) : null,
      backMs: back ? Math.round(back.duration) : null,
      blank: shown.filter((x) => !x.still && !x.stream).length,
      panels: [...new Set(shown.map((x) => x.panel).filter(Boolean))],
      panelsInDom: [...new Set(shown.map((x) => x.panelInDom).filter(Boolean))],
      resumingShown,
      streamCalls: probe.sent.filter((e) => e.m === 'browser.stream.set' && e.at >= t0).map((e) => e.state),
      samples: shown.length,
      newFrames: moving,
    };
  });
  // deskd's answer to that seen: true, once it's there.
  const answered = refused ? null : await until(async () => (await attention()).slice(before).find((e) => e.seen === true && e.answer), 5_000);
  s.seenAnswer = answered?.answer ?? null;
  s.seenAnswerMs = answered?.ms ?? null;
  const reply = answered ? (await live()).replies.find((r) => r.m === 'desk.attention.set' && r.seen === true && r.pc === answered.pc && r.ms === answered.ms) : null;
  s.seenAnswerFrozen = reply?.frozen ?? null;
  const thawed = (await live()).events.find((e) => e.at >= s.t0 && e.seen === true && e.frozen === false);
  s.thawedMs = thawed ? Math.round(thawed.at - s.t0) : null;
  delete s.t0;
  return s;
}

// ----- away and back, RUNS times
const switches = [];
for (let i = 1; i <= RUNS; i += 1) {
  const before = (await attention()).length;
  await p.getByRole('button', { name: /show all desks/ }).evaluate((el) => el.click());
  const away = refused ? null : await until(async () => (await attention()).slice(before).find((e) => e.seen === false && e.answer), 10_000);
  await wait(300);
  const parked = await p.evaluate(() => {
    const v = document.querySelector('video.br-video');
    const held = document.querySelector('[data-testid="browser-held"]');
    return { attached: v?.srcObject !== null, still: !!held && !held.hidden && held.width > 0 };
  });
  if (i === 1) {
    step('6 unseen in the overview: seen: false (unless refused), and the window keeps a still with no stream on it', (refused || Boolean(away)) && !parked.attached && parked.still, `${refused ? 'refused, so nothing sent' : `answer ${away?.answer} in ${away?.ms} ms`}; element attached ${parked.attached}, still ${parked.still}`);
  }
  await wait(AWAY_MS);
  const s = await timedSwitch(before);
  switches.push(s);
  log(`SWITCH ${i}: ${JSON.stringify(s)}`);
  if (i === 1) await shot(OUT, 'back');
  await until(async () => (await frames()) > 0, 5_000);
}
notes.switches = switches;
const med = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const max = (xs) => Math.max(...xs.filter((x) => typeof x === 'number'));
const summary = {
  runs: switches.length,
  awayMs: AWAY_MS,
  seenSentP50: med(switches.map((s) => s.seenSentMs)),
  seenAnswerP50: med(switches.map((s) => s.seenAnswerMs)),
  answers: [...new Set(switches.map((s) => s.seenAnswer))],
  firstFrameP50: med(switches.map((s) => s.firstFrameMs)),
  firstFrameMax: max(switches.map((s) => s.firstFrameMs)),
  backP50: med(switches.map((s) => s.backMs)),
  blank: switches.reduce((n, s) => n + s.blank, 0),
  samples: switches.reduce((n, s) => n + s.samples, 0),
  panels: [...new Set(switches.flatMap((s) => s.panels))],
};
notes.summary = summary;
log(`SWITCH real, ${summary.runs} runs after ${AWAY_MS} ms away: seen:true left the page p50 ${summary.seenSentP50} ms after the click, deskd answered ${JSON.stringify(summary.answers)} p50 ${summary.seenAnswerP50} ms after it left; first real frame p50 ${summary.firstFrameP50} ms (max ${summary.firstFrameMax}); element to frame p50 ${summary.backP50} ms; ${summary.blank} blank of ${summary.samples} display frames; panels ${JSON.stringify(summary.panels)}`);
step('7 the switch back: seen goes at once (unless refused), the picture returns, and no display frame is blank', (refused || (summary.seenSentP50 !== null && summary.seenSentP50 < 100)) && summary.blank === 0 && switches.every((s) => s.firstFrameMs !== null && s.newFrames > 0), JSON.stringify(summary));

// ----- away until deskd has frozen the desk's Chromium (60 s with nobody viewing it), then back: the real thaw
const frozenRuns = [];
if (!refused && FROZEN_RUNS > 0) {
  for (let i = 1; i <= FROZEN_RUNS; i += 1) {
    const before = (await attention()).length;
    const leftAt = await p.evaluate(() => performance.now());
    await p.getByRole('button', { name: /show all desks/ }).evaluate((el) => el.click());
    const froze = await until(async () => (await live()).events.find((e) => e.at >= leftAt && e.frozen === true), FROZEN_WAIT_MS, 500);
    if (!froze) {
      log(`FROZEN ${i}: the desk didn't say frozen within ${FROZEN_WAIT_MS} ms (sound, a download, a load, or an image without the freeze)`);
      frozenRuns.push({ froze: false });
      await p.locator(`#proxy-${ALLOWED}`).evaluate((b) => b.click());
      await playing(20_000);
      continue;
    }
    const frozeAfterMs = Math.round(froze.at - leftAt);
    await wait(2_000);
    const s = await timedSwitch(before);
    Object.assign(s, { froze: true, frozeAfterMs });
    frozenRuns.push(s);
    log(`FROZEN ${i}: ${JSON.stringify(s)}`);
    if (i === 1) await shot(OUT, 'back-from-frozen');
    await until(async () => (await frames()) > 0, 5_000);
  }
  notes.frozenRuns = frozenRuns;
  const done = frozenRuns.filter((r) => r.froze);
  notes.frozenSummary = {
    runs: done.length,
    frozeAfterP50: med(done.map((r) => r.frozeAfterMs)),
    seenAnswerP50: med(done.map((r) => r.seenAnswerMs)),
    answeredFrozen: done.map((r) => r.seenAnswerFrozen),
    thawedP50: med(done.map((r) => r.thawedMs)),
    firstFrameP50: med(done.map((r) => r.firstFrameMs)),
    firstFrameMax: done.length ? max(done.map((r) => r.firstFrameMs)) : null,
    resumingShown: done.filter((r) => r.resumingShown).length,
    blank: done.reduce((n, r) => n + r.blank, 0),
    streamCalls: done.map((r) => r.streamCalls),
  };
  log(`SWITCH real, from a frozen desk, ${done.length} runs: frozen ${notes.frozenSummary.frozeAfterP50} ms after leaving (p50); seen:true answered p50 ${notes.frozenSummary.seenAnswerP50} ms (frozen in the answer: ${JSON.stringify(notes.frozenSummary.answeredFrozen)}); the topic said thawed p50 ${notes.frozenSummary.thawedP50} ms after the click; first real frame p50 ${notes.frozenSummary.firstFrameP50} ms (max ${notes.frozenSummary.firstFrameMax}); "Resuming…" shown in ${notes.frozenSummary.resumingShown}; ${notes.frozenSummary.blank} blank`);
  step('7b back from a frozen desk: it thaws, the picture returns with no blank frame, and the stream is asked nothing', done.length > 0 && notes.frozenSummary.blank === 0 && done.every((r) => r.firstFrameMs !== null && r.newFrames > 0 && r.thawedMs !== null && r.streamCalls.length === 0), JSON.stringify(notes.frozenSummary));
} else {
  log(refused ? 'FROZEN: skipped, this deskd answers not_found' : 'FROZEN: skipped, FROZEN_RUNS=0');
}

// ----- a hidden tab: unseen, then seen
const beforeHide = (await attention()).length;
await p.evaluate(() => {
  window.__hide = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hide === true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hide ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
});
const hiddenSaid = refused ? null : await until(async () => (await attention()).slice(beforeHide).find((e) => e.seen === false && e.answer), 10_000);
await wait(AWAY_MS);
const t = await p.evaluate(() => {
  window.__hide = false;
  const at = performance.now();
  document.dispatchEvent(new Event('visibilitychange'));
  return at;
});
const shownSaid = refused ? null : await until(async () => (await attention()).slice(beforeHide).find((e) => e.seen === true && e.answer), 10_000);
const stillPlaying = await playing(20_000);
step('8 a hidden tab: seen: false, then seen: true on return (unless refused), and the picture plays', (refused || Boolean(hiddenSaid && shownSaid)) && stillPlaying, `hidden: ${hiddenSaid?.answer ?? '-'} in ${hiddenSaid?.ms ?? '-'} ms; shown: sent ${shownSaid ? Math.round(shownSaid.at - t) : '-'} ms after, ${shownSaid?.answer ?? '-'} in ${shownSaid?.ms ?? '-'} ms; playing ${stillPlaying}`);
await shot(OUT, 'after-hidden');

// ----- what deskd made of it all, and leaving it as found
const l2 = await live();
const consoleBeforeReload = events.filter((e) => e.k === 'console').length;
notes.attentionSent = l2.sent.filter((e) => e.m === 'desk.attention.set').map((e) => ({ seen: e.seen, answer: e.answer ?? null, ms: e.ms ?? null, pc: e.pc }));
notes.topicEvents = l2.events;
notes.answers = [...new Set(notes.attentionSent.map((e) => e.answer))];
log('desk.attention.set answers:', JSON.stringify(notes.answers), `${notes.attentionSent.length} sent;`, 'topic events', JSON.stringify(l2.events));
const notFound = notes.answers.includes('not_found');
const refusals = notes.attentionSent.filter((e) => e.answer === 'not_found').length;
const sessions = new Set(notes.attentionSent.map((e) => e.pc)).size;
step('9 an older deskd is asked once a session and no more', !notFound || refusals <= sessions, `${refusals} not_found over ${sessions} session(s), ${notes.attentionSent.length} sent in all`);

// ----- a new session while the desk is looked at: its first word is seen: true (the reload keeps desk mode, and wakes nothing
// on a running desk)
await p.reload({ waitUntil: 'load' });
await p.locator(`#proxy-${ALLOWED}`).waitFor({ state: 'attached', timeout: 60_000 });
const again = await until(async () => (await attention()).find((e) => e.answer), 60_000);
notes.newSession = again ? { seen: again.seen, answer: again.answer, ms: again.ms } : null;
step('10 a new session on the desk looked at says seen: true first', again?.seen === true, JSON.stringify(notes.newSession));
const l3 = await live();
notes.topicAfterReload = l3.sent.filter((e) => e.m === 'SUB desk.attention').map((e) => e.answer ?? null);

if (await p.getByRole('dialog', { name: 'Browser' }).count()) {
  await p.getByRole('dialog', { name: 'Browser' }).first().focus().catch(() => {});
  await p.getByRole('button', { name: 'Close Browser' }).click({ timeout: 4000 }).catch(() => p.keyboard.press('Escape'));
}
await wait(1000);
const wakes = events.filter((e) => e.k === 'api.req' && e.start === true).length;
step('11 nothing woke a desk', wakes === 0, `${wakes} start: true`);
step('12 no CSP violation', l2.violations.length === 0 && l3.violations.length === 0, JSON.stringify([...l2.violations, ...l3.violations]));
const consoleProblems = events.filter((e) => e.k === 'console').length;
step('13 no console error', consoleProblems === 0, `${consoleProblems} (${consoleBeforeReload} before the reload)`);
const failed = results.filter((r) => !r.ok).length;
log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
await shutdown(failed === 0 ? 0 : 1, 'done');
