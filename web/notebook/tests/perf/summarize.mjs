// A Markdown table from perf.mjs result files: the median of each number across a run's trials.
//   node tests/perf/summarize.mjs tests/perf/results/*.json
import { readFileSync } from 'node:fs';

const med = (a) => {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const rows = [
  ['words in the page', (t) => t.words],
  ['open the page, ms (p50)', (t) => t.open.p50],
  ['typing: key to frame p50, ms', (t) => t.typing.keyToFrame.p50],
  ['typing: key to frame p95, ms', (t) => t.typing.keyToFrame.p95],
  ['typing: key to frame max, ms', (t) => t.typing.keyToFrame.max],
  ['typing: fps', (t) => t.typing.frames.fps],
  ['typing: frames missed, %', (t) => t.typing.frames.dropped],
  ['typing: long tasks (> 50 ms)', (t) => t.typing.longtasks.n],
  ['scroll: fps', (t) => t.scroll.frames.fps],
  ['scroll: frames missed, %', (t) => t.scroll.frames.dropped],
  ['scroll: worst frame, ms', (t) => t.scroll.frames.max],
  ['jump to end and back: worst frame, ms', (t) => t.jumpWorstFrame.max],
  ['300-page list scroll: fps', (t) => t.list.frames.fps],
  ['search, first query (builds the index), ms', (t) => t.searchMs[0]],
  ['search, later queries, ms', (t) => med(t.searchMs.slice(1))],
];
const runs = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const head = runs.map((r) => `${r.label}${r.config.contentVisibility ? ' (cv)' : ''}`);
console.log(`| | ${head.join(' | ')} |`);
console.log(`|---|${runs.map(() => '---').join('|')}|`);
for (const [name, get] of rows) console.log(`| ${name} | ${runs.map((r) => String(Number(med(r.trials.map(get)).toFixed(1)))).join(' | ')} |`);
console.log(`| load average, start → end | ${runs.map((r) => `${r.machine.load.start[0]} → ${r.machine.load.end[0]}`).join(' | ')} |`);
console.log(`| machine | ${runs.map((r) => `${r.machine.cpu}, ${r.machine.threads} threads`).join(' | ')} |`);
