// numbers.md, from what measure.spec.ts recorded: every run, with the RTT and client load beside it. Budgets are design 2.2's, as
// docs/benchmarks/2026-11-real-stack.md states them. It says when a number can't be read against one, and gives no verdict on the size.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { B11, B12, B13_MS } from '../tests/streamlib';
import { CROP, SETTLE_MS } from './w3lib';

/* eslint-disable @typescript-eslint/no-explicit-any */
const n = (v: unknown, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-');
const row = (cells: unknown[]) => `| ${cells.map((c) => String(c ?? '-')).join(' | ')} |`;
const table = (head: string[], rows: unknown[][]) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const medianOf = (xs: unknown[]) => { const s = xs.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const load = (r: any) => (r.clientLoad ? `${n(r.clientLoad.loadavg1m, 2)}/${r.clientLoad.cores}` : '-');
const failed = (runs: any[]) => runs.filter((r) => r.error).map((r) => `- Round ${r.round} failed: ${r.error}`).join('\n');

function fpsTable(runs: any[]) {
  return table(
    ['Run', 'Page fps avg', 'p5', 'min', 'Long frames %', 'Longest gap ms', 'Decoded fps (not the verdict)', 'Dropped', 'Freezes', 'Mbps', 'Desk CPU %', 'desk-stream / Chromium % of a core', 'RTT ms', 'Client load/cores'],
    runs.filter((r) => r.page).map((r) => [r.round, n(r.page.avg), n(r.page.p5), n(r.page.min), n(r.page.longFramePct), n(r.page.maxGapMs, 0), n(r.client?.decodedFps), r.client?.dropped, r.client?.freezes, n(r.client?.mbps, 2), n(r.deskCpu?.machinePct), `${n(r.deskCpu?.unitPctOfOneCore?.['desk-stream'], 0)} / ${n(r.deskCpu?.unitPctOfOneCore?.['desk-browser'], 0)}`, n(r.client?.rttMs), load(r)]),
  );
}

export function renderNumbers(r: any): string {
  const runs = r.runs ?? {};
  const get = (k: string): any[] => runs[k] ?? [];
  const out: string[] = [`# W3 numbers: ${r.label}`, ''];
  if (r.smoke) out.push(`**Smoke run: ${r.input?.runs} round(s), fewer than the 3 a verdict needs.**`, '');
  const info = r.desk?.info ?? {};
  out.push(table(['', ''], [
    ['Desk', `${r.desk?.deskId ?? '-'}, ${r.desk?.instance ?? '-'}, ${r.desk?.type ?? '-'}, ${r.desk?.az ?? '-'}, tags ${JSON.stringify(r.desk?.tags ?? {})}`],
    ['Screen', r.screen ? `screen ${r.screen.screen}, page ${r.screen.viewport}, stream ${r.screen.stream}, DPR ${r.screen.dpr}; xrandr: ${r.screen.xrandr ?? '-'}` : '-'],
    ['Versions', `image ${info.image ?? '-'} (AMI ${r.desk?.amiId ?? '-'}), desk-rtc ${info['desk-rtc'] ?? '-'}, desk-stream ${info['desk-stream'] ?? '-'}, deskd ${info.deskd ?? '-'}, Chromium ${info.chromium ?? '-'}`],
    ['Stream config', `stream.conf ${info.streamConf ?? '-'}: ${info.x264 ?? '-'}`],
    ['Video clip', r.clip ? `${r.clip.kind}${r.clip.source && r.clip.kind === 'url' ? ` from ${r.clip.source}` : ''}${r.clip.bytes ? `, ${r.clip.bytes} bytes` : ''}${r.clip.cut ? `, ${r.clip.cut}` : ''}${r.clip.facts ? `, ${r.clip.facts.seconds} s, ${r.clip.facts.frames} frames, ${r.clip.facts.fps} fps, ${r.clip.facts.audioTracks} audio tracks, video bytes sha256 ${r.clip.facts.videoBytesSha256.slice(0, 16)}` : ''}${r.clip.error ? `: ${r.clip.error}` : ''}` : '-'],
    ['CPU credits', r.desk?.creditsAtStart?.specification ? `${r.desk.creditsAtStart.specification}; balance at start ${n(r.desk.creditsAtStart.CPUCreditBalance)}, at end ${n(r.desk?.creditsAtEnd?.CPUCreditBalance)}; surplus at end ${n(r.desk?.creditsAtEnd?.CPUSurplusCreditBalance)}` : 'not a burstable type, or not readable'],
    ['Client', `${r.client?.viewport ?? '-'}, app ${r.client?.appVersion ?? '-'}, Chrome for Testing ${r.client?.chrome ?? '-'} (new headless, software decode); ${r.client?.load?.uptime ?? '-'}`],
    ['When', `${r.startedAt ?? '-'} to ${r.finishedAt ?? 'still running'}`],
  ]), '');

  const rtts = [...get('scroll'), ...get('static'), ...get('motion')].map((x) => x.client?.rttMs);
  const rtt = medianOf(rtts);
  const loads = [...get('latencyIdle'), ...get('latencyLoaded')].map((x) => x.clientLoad).filter(Boolean);
  const worst = loads.length ? Math.max(...loads.map((l: any) => l.loadavg1m / l.cores)) : null;
  // The real-stack report's own runs at 30 ms read 30 to 33 ms over ICE.
  const judged = rtt !== null && rtt <= B12.atRttMs + 3 && worst !== null && worst <= 1;
  out.push('## Read this first', '',
    '- **The verdict number is page fps,** the rAF callback inside the desk\'s Chromium. Decoded fps sits beside it because the encoder repeats frames when the page stalls, so it can read 60 while the page doesn\'t. `expectedDisplayTime` is a prediction and isn\'t quoted.',
    `- **Latency:** median RTT ${n(rtt)} ms, worst client load ${n(worst, 2)} per core. B12 assumes ${B12.atRttMs} ms and an unloaded client, so these runs are **${judged ? 'readable against B12' : 'not a B12 verdict'}**${judged ? '' : ', and compare only with a run from the same client at the same RTT'}. A 60 Hz display adds up to one frame on top of any of them.`);
  const fo = r.firstOpen;
  if (fo) out.push(`- **First open on this boot (in no average):** ${fo.chromiumWasRunning ? 'Chromium was already running, so this says nothing about a cold root' : 'Chromium was not running'}: ${n(fo.firstFrameMs, 0)} ms to the first frame, ${n(fo.chromiumReachableAfterMs, 0)} ms until its tabs answered. Booted ${fo.bootedAt ?? '-'}.`);
  for (const note of r.notes ?? []) out.push(`- ${note}`);
  out.push('');

  const section = (title: string, key: string, extra?: string) => {
    const rs = get(key);
    out.push(`## ${title}`, '');
    if (extra) out.push(extra, '');
    if (rs.some((x) => x.page)) out.push(fpsTable(rs), '');
    const f = failed(rs); if (f) out.push(f, '');
  };
  section('Static text article', 'static', 'The page changes nothing, so the stream sends its 10 fps heartbeat.');
  section('Sustained wheel scrolling', 'scroll', `60 s at about 1200 px/s through the app's wheel listener, reversing every 4 s. B11: page avg >= ${B11.avg}, p5 >= ${B11.p5}, zero freezes.`);
  if (get('scroll').length) out.push(table(['Run', 'Px sent', 'Px scrolled on the page', 'Scroll-change fps'], get('scroll').filter((x) => x.page).map((x) => [x.round, x.pxSent, x.page.scrolledPx, n(x.page.scrollChangeFps)])), '');

  const fl = get('flick').filter((x) => x.flicks);
  out.push('## Fast scroll flick', '', 'How far each flick travelled, in px on the page. `desk-rtc` sends 120 px clicks in batches of 8 (960 px), at most 20 per event, and keeps a remainder of up to 119 px, so a gap within that isn\'t a shortfall.', '');
  if (fl.length) {
    out.push(table(['Flick', 'Sent', 'Reachable', ...fl.map((x) => `Run ${x.round} travelled`)], fl[0].flicks.map((f: any, i: number) => [f.flick, f.sent, f.reachable, ...fl.map((x) => x.flicks[i]?.travelled)])), '');
    out.push(table(['Run', 'Page fps across the flicks', 'p5', 'Longest gap ms', 'RTT ms', 'Client load/cores'], fl.map((x) => [x.round, n(x.page?.avg), n(x.page?.p5), n(x.page?.maxGapMs, 0), n(x.rttMs), load(x)])), '');
  }
  const ff = failed(get('flick')); if (ff) out.push(ff, '');

  section('Motion', 'motion', '24 moving gradients on a canvas over the whole screen: every frame changes everywhere, with no video decode.');
  section('Video', 'video', 'The clip fills the page, 1080p60 H.264, decoded by the desk\'s Chromium in software.');
  const vids = get('video').filter((x) => x.video);
  if (vids.length) out.push(table(['Run', 'Presented fps', 'Callback fps', 'Decoded fps', 'Dropped', 'Paused', 'Error', 'Clip'], vids.map((x) => [x.round, n(x.video.presentedFps), n(x.video.callbackFps), n(x.video.decodedFps), x.video.dropped, x.video.paused, x.video.error, x.video.size])), '');
  const skippedVideo = get('video').find((x) => x.skipped); if (skippedVideo) out.push(`Not run: ${skippedVideo.skipped}.`, '');

  const lat = (key: string) => get(key).filter((x) => x.callbackMs).map((x) => [x.round, x.load, `${x.detected}/${x.trials}`, n(x.callbackMs.p50), n(x.callbackMs.p95), n(x.callbackMs.max), n(x.iceRttMs?.p50), n(x.jitterBufferMs), n(x.decodeMs), x.aligned ? 'yes' : 'NO', x.dropped, x.freezes, n(x.deskCpu?.machinePct), load(x)]);
  out.push('## Input to screen', '', `Key press in the client to the changed pixel in the decoded frame's callback (stream.spec.ts' method). Idle and loaded. B12: p50 <= ${B12.p50}, p95 <= ${B12.p95} at ${B12.atRttMs} ms RTT.`, '',
    table(['Run', 'Load', 'Detected', 'p50 ms', 'p95 ms', 'max ms', 'ICE RTT ms', 'Jitter buffer ms', 'Decode ms', 'One keydown per press', 'Dropped', 'Freezes', 'Desk CPU %', 'Client load/cores'], [...lat('latencyIdle'), ...lat('latencyLoaded')]), '');
  for (const f of [failed(get('latencyIdle')), failed(get('latencyLoaded'))]) if (f) out.push(f, '');

  const ty = get('typing').filter((x) => x.keyToScreenMs);
  out.push('## Typing', '', 'About 80 words a minute, each key timed as above, then the same text at a 40 ms gap to see that every character lands in order.', '',
    table(['Run', 'Key to screen p50 ms', 'p95 ms', 'Missed', 'Paced text right', 'Burst text right', 'Page fps', 'p5', 'RTT ms', 'Client load/cores'], ty.map((x) => [x.round, n(x.keyToScreenMs.p50), n(x.keyToScreenMs.p95), x.misses, x.pacedTextRight ? 'yes' : `NO: ${x.pacedGot}`, x.burstTextRight ? 'yes' : `NO: ${x.burstGot}`, n(x.page?.avg), n(x.page?.p5), n(x.rttMs), load(x)])), '');
  const ft = failed(get('typing')); if (ft) out.push(ft, '');

  const wl = get('warmToLive').filter((x) => x.firstFrameMs);
  out.push('## `warm` to `live`', '', `12 switches a run, the first of 13 discarded, as proof2.mjs. B13: <= ${B13_MS} ms. Sent on the app's own \`rpc\` channel, because a member's route (a tab hidden for 5 minutes) is too slow to repeat.`, '',
    table(['Run', 'First frame p50 ms', 'p95 ms', 'max ms', 'Misses', 'RTT ms', 'Client load/cores'], wl.map((x) => [x.round, n(x.firstFrameMs.p50), n(x.firstFrameMs.p95), n(x.firstFrameMs.max), x.misses, n(x.rttMs), load(x)])), '');
  const fw = failed(get('warmToLive')); if (fw) out.push(fw, '');

  const op = get('firstFrame').filter((x) => x.opens);
  out.push('## Time to first frame', '', 'Closing the real window (`off`) and opening it again from the tile, with Chromium already up. From the window\'s open mark to the app\'s first-frame mark.', '',
    table(['Run', 'Opens, first frame ms', 'RTT ms', 'Client load/cores'], op.map((x) => [x.round, x.opens.map((o: any) => o.firstFrameMs).join(', '), n(x.rttMs), load(x)])), '');
  const fo2 = failed(get('firstFrame')); if (fo2) out.push(fo2, '');

  if (r.baseline) out.push('## Before the rounds', '', `Desk CPU ${n(r.baseline.deskCpu?.machinePct)}% on an idle page, with the stream live, after the warm-up.`, '');
  if (r.consoleErrors?.length) out.push('## Console errors in the app', '', ...r.consoleErrors.map((e: string) => `- ${e}`), '');
  return out.join('\n');
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** What's in this folder, what each pair is and how it was made. Rewritten after every page, from what was recorded, with no opinion. */
export function writeLabelReadme(root: string): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const recs: any[] = readdirSync(root).filter((f) => /^capture-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(root, f), 'utf8')));
  const first = recs[0];
  const lines = [`# W3 captures: ${first?.label}`, '',
    `Desk ${first?.desk?.deskId}, ${first?.desk?.type}, AMI ${first?.desk?.amiId}, image ${first?.desk?.info?.image}; Japanese fonts on the desk: ${first?.desk?.info?.fontsJa}, Arabic: ${first?.desk?.info?.fontsAr}. Client: app ${first?.client?.appVersion}, Chrome for Testing ${first?.client?.chrome}, new headless, software decode.`, '',
    '**A pair** is the same path under this label and under the other desk\'s: same client window, Browser window at the app\'s default "fill the screen", same page asked for. `pairs-*` beside this folder holds the crops side by side, once both desks have run (README.md in `e2e/w3`).', '',
    '## The files', '',
    '- `<profile>/<page>-top.decoded.png`: the page as it opens. The decoded video frame through a canvas at the stream\'s own size, one pixel per desk pixel, nothing scaled. PNG, so nothing added after the stream\'s own encoding.',
    '- `<profile>/<page>-top.window.png`: the same moment as a member\'s screen would show it: a screenshot of the client page at that profile\'s size and scale, with the app around the picture and the frame scaled into the Browser window by the client.',
    `- \`<profile>/<page>-small.crop-window.png\`, \`-body.crop-window.png\`: ${CROP.w}x${CROP.h} device pixels from that screenshot, at 100%, at the same words on both desks, starting where their paragraph, list item or table cell starts when that keeps them in the crop. \`small\` is the page's smallest text at 9 px or more, \`body\` its main text. The words were moved to the middle of the screen first, and each crop waited until they had stayed put for ${SETTLE_MS / 1000} s.`,
    `- \`<profile>/<page>-small.crop-decoded.png\`, \`-body.crop-decoded.png\`: ${CROP.w}x${CROP.h} pixels of the decoded frame at the same words, at 100%.`,
    '- `<profile>/<page>-attemptN.window.png`: a page that was tried and refused, as it showed.', '',
    '## How it was made', '',
    `The real Desk app on staging, signed in as a test account, the real Browser window opened from its tile, each address typed into its address bar. Frames were taken at least ${SETTLE_MS / 1000} s after the page last changed, past the stream's 4 s keyframe. The words and the scrolling use Chromium's debugging port on the desk, over SSM.`, '',
    'The client scaling in `*.window.png` is headless Chrome\'s software path. A browser using a GPU may scale differently, and a real display may add its own.', ''];
  for (const r of recs) {
    lines.push(`## ${r.profile?.name}: ${r.profile?.width}x${r.profile?.height} at scale ${r.profile?.scale}`, '', '| Page | Asked for | What it showed | Stream | Picture on the client, CSS px | Device px per desk px | Still 4.5 s later |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const [kind, e] of Object.entries<any>(r.pages ?? {})) {
      lines.push(`| ${kind}${e.fixture ? ' (**fixture on the desk, no public page showed**)' : ''}${e.sameAsFirstDesk ? '' : ' (**not the page the first desk used**)'} | ${e.asked} | ${(e.showed?.title ?? '-').replaceAll('|', '/')}, ${e.showed?.textLength ?? '-'} characters | ${e.top?.streamSize ?? '-'} | ${e.picture ? `${Math.round(e.picture.width)}x${Math.round(e.picture.height)} in ${Math.round(e.picture.elWidth)}x${Math.round(e.picture.elHeight)}` : '-'} | ${e.picture?.deviceFullPxPerDeskPx?.toFixed(3) ?? '-'} | ${e.top?.stillAfter4500ms ?? '-'} |`);
    }
    lines.push('');
    for (const [kind, e] of Object.entries<any>(r.pages ?? {})) {
      for (const a of e.attempts ?? []) if (a.refused) lines.push(`- ${kind}: ${a.asked} refused: ${a.refused}`);
      for (const [mode, c] of Object.entries<any>(e.crops ?? {})) lines.push(c.missing ? `- ${kind} ${mode}: ${c.missing}` : `- ${kind} ${mode}: ${c.fontPx} px ${c.fontFamily}, "${c.anchor}"${c.sameWordsAsFirstDesk ? '' : ' (**the first desk\'s words weren\'t found here**)'}`);
    }
    lines.push('');
  }
  writeFileSync(join(root, 'README.md'), lines.join('\n'));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
