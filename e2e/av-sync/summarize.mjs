// summarize.mjs <label>...: one committed summary per run, from results/<label>.json and, if it ran, results/<label>.stream-report.json.
// Keeps the numbers and leaves out anything with an address in it (candidates, the desk's public IP, chrony's reference).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
for (const label of process.argv.slice(2)) {
  const av = JSON.parse(readFileSync(join(here, 'results', `${label}.json`), 'utf8'));
  const out = { label, startedAt: av.startedAt, client: av.client, desk: av.desk };
  for (const k of ['desk page playing', 'desk cpu while playing', 'desk page fps', 'desk side', 'delays desk to client', 'sound after picture at the client', 'client getStats', 'input to screen while the clip plays', 'after a pause and play', 'hold']) if (k in av) out[k] = av[k];
  if (out['client getStats']) delete out['client getStats'].senderReports?.audio, delete out['client getStats'].senderReports?.video;
  out.clocks = { localAheadMs: [av.clocks?.before?.local?.aheadMs, av.clocks?.after?.local?.aheadMs], localSntpRoundTripMs: [av.clocks?.before?.local?.delayMs, av.clocks?.after?.local?.delayMs], deskAheadMs: [av.clocks?.before?.desk?.aheadMs, av.clocks?.after?.desk?.aheadMs] };
  const sr = join(here, 'results', `${label}.stream-report.json`);
  if (existsSync(sr)) {
    const s = JSON.parse(readFileSync(sr, 'utf8'));
    const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o && k in o).map((k) => [k, o[k]]));
    out.stream = {
      startedAt: s.startedAt,
      '2 page fps': pick(s['2 page fps (rAF inside the desk Chromium)'], ['samples', 'seconds', 'avg', 'p5', 'min', 'longFramePct', 'scrolledPx']),
      '2 client': pick(s['2 client'], ['seconds', 'decodedFps', 'decodedP5', 'decodedMin', 'receivedFps', 'dropped', 'freezes', 'mbps', 'packetsLost', 'nacks', 'plis', 'jitterBufferMs', 'decodeMs', 'iceRttMs', 'load']),
      '2 desk cpu': s['2 desk cpu'],
      '6 ctl PING to PONG': s['6 ctl PING to PONG'],
      '6 latency idle': pick(s['6 latency idle'], ['trials', 'detected', 'callbackMs', 'lastPacketMs', 'iceRttMs', 'jitterBufferMs', 'decodeMs', 'dropped', 'freezes', 'load']),
      '6 latency loaded': pick(s['6 latency loaded'], ['trials', 'detected', 'callbackMs', 'lastPacketMs', 'iceRttMs', 'jitterBufferMs', 'decodeMs', 'dropped', 'freezes', 'load']),
    };
  }
  const text = JSON.stringify(out, null, 1);
  if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text.replace(/"[0-9.]+"/g, ''))) console.error(`${label}: something looks like an address; check before committing`);
  writeFileSync(join(here, 'runs', `${label}.json`), text);
  console.log(`runs/${label}.json`);
}
