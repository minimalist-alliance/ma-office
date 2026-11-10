// summarize.mjs <label>...: a table per run from results/<label>.json, and runs/<label>.json to commit: the numbers, without the raw
// per-trial arrays or anything that holds an address (no candidate, SDP or public IP is recorded in the first place).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const f = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '–' : Number(x).toFixed(d));
const ms = (x) => (x === null || x === undefined ? '–' : Math.round(x));

for (const label of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(join(here, 'results', `${label}.json`), 'utf8'));
  const levels = (r.levels ?? []).map((l) => {
    const slim = (seg) => seg && { client: Object.fromEntries(Object.entries(seg.client).filter(([k]) => !['perSecondVideoMbps', 'perSecondDecoded'].includes(k))), deskPage: seg.deskPage, deskCpu: { machinePct: seg.deskCpu?.machinePct, unitPctOfOneCore: seg.deskCpu?.unitPctOfOneCore } };
    const inp = (x) => x && { trials: x.trials, detected: x.detected, misses: x.misses, keydownsSeenByThePage: x.keydownsSeenByThePage, callbackMs: x.callbackMs, displayMs: x.displayMs, lastPacketMs: x.lastPacketMs, iceRttMs: x.iceRttMs };
    const sw = l.switch && { noChange: l.switch.noChange, inEffectBefore: l.switch.inEffectBefore, replyMs: l.switch.replyMs, reply: l.switch.reply, firstKeyframeMs: l.switch.firstKeyframeMs, firstFrameAtNewSizeMs: l.switch.firstFrameAtNewSizeMs, from: l.switch.from, to: l.switch.to, sizeChanges: l.switch.sizeChanges };
    return { level: l.level, run: l.run, startedAt: l.startedAt, videoPage: l.videoPage, switch: sw, afterSwitch: l.afterSwitch, sizeMismatch: l.sizeMismatch, video: slim(l.video), scroll: slim(l.scroll), still: slim(l.still), input: inp(l.input), inputLoaded: inp(l.inputLoaded), desk: l.desk };
  });
  const out = { label, startedAt: r.startedAt, endedAt: r.endedAt, order: r.order, seconds: r.seconds, trials: r.trials, client: r.client, desk: r.desk, pagesOnTheDesk: r['pages on the desk'], session: r.session, pingMs: r['ctl PING to PONG'], repliesOnViewing: r['quality replies on viewing'], aborted: r.aborted, levels, journal: r['desk journal: level lines and warnings'], finish: r.finish, removed: r['removed from the desk'] };
  const text = JSON.stringify(out, null, 1);
  if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text.replace(/"[0-9.]+"/g, ''))) console.error(`${label}: something looks like an address; check before committing`);
  writeFileSync(join(here, 'runs', `${label}.json`), text);

  console.log(`\n## ${label} (${r.startedAt} to ${r.endedAt ?? '?'})${r.aborted ? `  ABORTED: ${r.aborted}` : ''}\n`);
  console.log('| Level (run) | Picture | Switch: reply / keyframe / new size, ms | Video: fps, Mbit/s, GB/h | Scroll: fps, GB/h | Still: fps, GB/h | Audio GB/h | Input p50 / p95, ms | Page fps: video / scroll | Clip dropped | Desk CPU % video / scroll |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const l of levels) {
    const v = l.video?.client, s = l.scroll?.client, st = l.still?.client;
    const drop = l.video?.deskPage?.videoFrames ? `${f((100 * l.video.deskPage.videoDropped) / l.video.deskPage.videoFrames, 0)}%` : '–';
    console.log(`| ${l.level} (${l.run}) | ${v?.size ?? '–'} | ${l.switch?.noChange ? 'no change' : `${ms(l.switch?.replyMs)} / ${ms(l.switch?.firstKeyframeMs)} / ${l.switch?.sizeChanges ? ms(l.switch?.firstFrameAtNewSizeMs) : 'same size'}`} | ${f(v?.decodedFps)}, ${f(v?.videoMbps, 2)}, ${f(v?.videoGBh, 2)} | ${f(s?.decodedFps)}, ${f(s?.videoGBh, 2)} | ${f(st?.decodedFps)}, ${f(st?.videoGBh, 3)} | ${f(v?.audioGBh, 3)} | ${f(l.input?.callbackMs?.p50)} / ${f(l.input?.callbackMs?.p95)} | ${f(l.video?.deskPage?.avg)} / ${f(l.scroll?.deskPage?.avg)} | ${drop} | ${f(l.video?.deskCpu?.machinePct, 0)} / ${f(l.scroll?.deskCpu?.machinePct, 0)} |`);
  }
  const highs = levels.filter((l) => l.level === 'high');
  if (highs.length >= 2) {
    const [a, b] = highs;
    const noise = (get) => Math.abs(get(a) - get(b));
    const p50 = (l) => l.input?.callbackMs?.p50, p95 = (l) => l.input?.callbackMs?.p95, vfps = (l) => l.video?.deskPage?.avg, sfps = (l) => l.scroll?.deskPage?.avg;
    console.log(`\nHigh's two runs differ by: input p50 ${f(noise(p50))} ms, p95 ${f(noise(p95))} ms; page fps video ${f(noise(vfps))}, scroll ${f(noise(sfps))}.`);
    for (const l of levels.filter((x) => x.level !== 'high')) {
      const worse = (get) => get(l) - Math.max(get(a), get(b));
      const lower = (get) => Math.min(get(a), get(b)) - get(l);
      console.log(`${l.level}: input p50 ${f(worse(p50))} ms and p95 ${f(worse(p95))} ms above High's worse run; page fps ${f(lower(vfps))} (video) and ${f(lower(sfps))} (scroll) below High's lower run.`);
    }
  }
  console.log(`\nruns/${label}.json written`);
}
