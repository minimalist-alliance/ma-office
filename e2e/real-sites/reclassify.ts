// Calls a run's verdicts again from the whole reads it kept in out/<label>/, with today's classify.ts, and adds what a person saw
// in each frame from results/<label>.checked.json: { "<id>": { "note": "what the frame shows", "verdict"?: "pass" } }. A verdict
// there overrides the script's, and the note says why. Then it writes results/<label>.json and .md again.
//   node real-sites/reclassify.ts <label>
// Needs the run's out/ folder, which stays on the machine that ran it. Only erasable TypeScript here, so Node runs it as it is.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify, redact, type Verdict } from './classify.ts';
import { render } from './render.ts';

const label = process.argv[2];
if (!label || !/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('usage: node real-sites/reclassify.ts <label>');
const here = new URL('.', import.meta.url).pathname;
const resultsPath = join(here, 'results', `${label}.json`);
const checkedPath = join(here, 'results', `${label}.checked.json`);
const report = JSON.parse(readFileSync(resultsPath, 'utf8'));
const checked: Record<string, { note: string; verdict?: Verdict }> = existsSync(checkedPath) ? JSON.parse(readFileSync(checkedPath, 'utf8')) : {};

/* eslint-disable @typescript-eslint/no-explicit-any */
for (const v of report.visits as any[]) {
  const reads = join(here, 'out', label, `${String(v.id).padStart(2, '0')}.json`);
  if (existsSync(reads)) {
    const { atLoad, afterUse } = JSON.parse(readFileSync(reads, 'utf8'));
    const call = classify(atLoad, afterUse, v.use === 'video');
    Object.assign(v, { scriptVerdict: call.verdict, verdict: call.verdict, why: call.why, atLoadCall: call.atLoad, afterUseCall: call.afterUse });
  }
  // What the run kept, redacted again with today's rules.
  for (const k of ['atLoad', 'afterUse']) if (v[k]) for (const f of ['title', 'path', 'textStart']) if (typeof v[k][f] === 'string') v[k][f] = redact(v[k][f]);
  const c = checked[String(v.id)];
  if (c) {
    v.manual = c.note;
    if (c.verdict && c.verdict !== v.verdict) { v.scriptVerdict = v.verdict; v.verdict = c.verdict; }
  }
}
report.reclassifiedAt = new Date().toISOString();
writeFileSync(resultsPath, JSON.stringify(report, null, 2));
writeFileSync(join(here, 'results', `${label}.md`), render([report]));
console.log((report.visits as any[]).map((v) => `${v.id} ${v.name}: ${v.verdict}${v.scriptVerdict && v.scriptVerdict !== v.verdict ? ` (script: ${v.scriptVerdict})` : ''}`).join('\n'));
