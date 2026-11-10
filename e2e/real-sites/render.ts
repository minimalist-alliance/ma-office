// The results table, from one or more results/*.json. Used by the spec after every site, and by hand to merge runs:
//   node real-sites/render.ts real-sites/results/<a>.json real-sites/results/<b>.json > real-sites/results/<name>.md
// Only erasable TypeScript here, so Node runs it as it is.
import { readFileSync } from 'node:fs';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Run = any;

const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(d));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function render(runs: Run[]): string {
  const visits = runs.flatMap((r) => (r.visits ?? []).map((v: any) => ({ ...v, run: r.label })));
  const out: string[] = [];
  out.push(`# Real sites from a desk: ${runs.map((r) => r.label).join(', ')}`, '');
  const r0 = runs[0] ?? {};
  out.push(`Desk ${r0.desk?.deskId ?? '-'} (${r0.desk?.type ?? '-'}, image ${r0.desk?.info?.image ?? '-'}, screen ${r0.desk?.screen ?? '-'}), Chromium ${r0.desk?.info?.chromium ?? '-'}, \`desk-stream\` ${r0.desk?.info?.['desk-stream'] ?? '-'} (\`${r0.desk?.info?.x264 ?? '-'}\`).`, '');
  for (const r of runs) out.push(`- ${r.label}: started ${r.startedAt}, \`desk-rtc\` ${r.desk?.info?.['desk-rtc'] ?? '-'}, \`deskd\` ${r.desk?.info?.deskd ?? '-'}, app ${r.client?.appVersion ?? '-'}, DRM ${r.chromium?.drm ? JSON.stringify(r.chromium.drm) : "not asked in this run"}`);
  out.push('');
  out.push('Stream GB/h is what the member\'s browser received from the desk (WebRTC transport bytes, client side) over the whole visit: load, then typical use. "Still" and "use" split it. Desk tx is the desk\'s own NIC counter over the same visit, headers and all. Download is what the sites sent the desk (NIC rx).', '');
  out.push('| # | Site | Category | Result | Notes | Stream GB/h | still | use | Desk tx GB/h | Download GB/h |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const v of visits) {
    // A person's look at the frame, when there is one, says it better than the script's reason.
    const note = [v.manual ? `by eye: ${v.manual}` : v.why, v.error ? `error: ${v.error}` : ''].filter(Boolean).join('; ').replaceAll('|', '/');
    out.push(`| ${v.id} | ${v.name} | ${v.category} | **${v.verdict}** | ${note} | ${f(v.gbh?.visit)} | ${f(v.gbh?.still)} | ${f(v.gbh?.use)} | ${f(v.gbh?.deskTx)} | ${f(v.gbh?.deskRx)} |`);
  }
  // An extra (sites.ts EXTRA) is there for a number, and isn't counted among the sites.
  const counted = visits.filter((v) => !String(v.category).includes('extra'));
  const by = (k: string) => counted.filter((v) => v.verdict === k).length;
  out.push('', `**${by('pass')} pass, ${by('challenge')} challenge, ${by('block')} block, ${by('unclear')} unclear**, of ${counted.length}${counted.length < visits.length ? `, not counting ${visits.length - counted.length} extra` : ''}.`, '');
  // Typical browsing is the sites that worked: a check page is a still page, and would pull the mean down.
  const browse = visits.filter((v) => v.use !== 'video' && v.verdict === 'pass' && v.gbh?.visit != null);
  const video = visits.filter((v) => v.use === 'video' && v.verdict === 'pass' && v.gbh?.use != null);
  const vals = (k: string) => browse.map((v) => v.gbh[k]).filter((x) => x != null);
  out.push(`- Browsing, the ${browse.length} sites that passed (not video): mean stream ${f(mean(vals('visit')))} GB/h over a visit, range ${f(Math.min(...vals('visit')))} to ${f(Math.max(...vals('visit')))}; still ${f(mean(vals('still')))}; while scrolling or zooming ${f(mean(vals('use')))}.`);
  out.push(`- Video that played, while playing: ${video.map((v) => `${v.name} ${f(v.gbh.use)} GB/h`).join(', ') || 'none'}.`);
  out.push(`- Desk tx over the same browsing visits: ${f(mean(vals('deskTx')))} GB/h. The sites' download (desk rx): ${f(mean(vals('deskRx')))} GB/h.`);
  return out.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(render(process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')))));
}
