// Task 49's pure rules: timers in the member's zone, proposals' canonical JSON and what a card shows, PNG checks, workspace
// paths and links.
import { describe, expect, it } from 'vitest';
import type { Timer } from '../client/types';
import { hasHiddenChars, nameKey, pausedText } from './agents';
import { a2aStateText, charCount, linkProblems } from './links';
import { crc32, fromBase64, pngCheck, pngRefusalText, toBase64 } from './png';
import { canonicalJson, describeProposal, proposalChecks, proposalOpen, runsPerMonth, sha256Hex } from './proposals';
import { daysText, durationText, isFinished, lastStateText, nextRun, offsetAt, scheduleText, timerProblem, wallAt, wallToEpoch, whenText, zoneName } from './timers';
import { bytesText, fullness, fullnessText, nameOf, parentOf, parseMb, pathProblem, refusedSaveText } from './workspace';

const CAPS = { promptMax: 2000, timerMinMinutes: 5 };
const DENVER = 'America/Denver';
// Sunday Nov 8 2026, 03:15 in Denver (MST, UTC-7): 10:15 UTC.
const NOW = Date.UTC(2026, 10, 8, 10, 15);

function timer(over: Partial<Timer>): Timer {
  return { id: 't', label: 'L', kind: 'repeat', days: null, time: null, everyMinutes: null, at: null, prompt: 'p', enabled: true, zone: DENVER, nextAt: null, lastAt: null, lastState: null, spentMicroUsd: 0, createdAt: NOW - 1000, ...over };
}

describe('workspace and run words (task 49 fix)', () => {
  it('says when a workspace is nearly full or full, and why a file was not saved', () => {
    expect(fullness(79, 100)).toBeNull();
    expect(fullness(80, 100)).toBe('nearly');
    expect(fullness(100, 100)).toBe('full');
    expect(fullness(1, 0)).toBeNull();
    expect(fullnessText('nearly', 'Scout')).toBe('Nearly full. Scout can’t save more once it’s full.');
    expect(fullnessText('full', 'Scout')).toBe('Full. Scout can’t save files until you delete some or make it bigger.');
    expect(refusedSaveText('notes.txt', 'workspace_full')).toBe('Couldn’t save notes.txt: the workspace is full.');
    expect(refusedSaveText('notes.txt', 'disk_low')).toBe('Couldn’t save notes.txt: this desk is low on storage.');
  });
  it('says why an agent is paused', () => {
    expect(pausedText('agent_cap')).toBe('Paused: this desk has more agents than its plan allows. Remove one to start the rest again.');
    expect(pausedText(null)).toBe('Paused: agents can’t run on this account right now.');
  });
  it('compares names the way the desk does, and finds hidden characters', () => {
    expect(nameKey(' Ｓcout ')).toBe(nameKey('scout'));
    expect(nameKey('Sсout')).toBe(nameKey('Scout'));
    expect(nameKey('Sc\u200Bout')).toBe(nameKey('Scout'));
    expect(nameKey('Scout 2')).not.toBe(nameKey('Scout'));
    expect(hasHiddenChars('a\u202Eb')).toBe(true);
    expect(hasHiddenChars('plain')).toBe(false);
  });
});

describe('timer words (task 49 fix)', () => {
  it('says what each last state means and what to do next', () => {
    expect(lastStateText('busy')).toBe('Ran a little late: it was busy');
    expect(lastStateText('no_key')).toBe('Skipped: no key. Pick one in Key and model.');
    expect(lastStateText('limit_reached')).toBe('Skipped: a spending limit was reached. See Usage and limits.');
    expect(lastStateText('failed')).toBe('Didn’t finish. Its thread says why.');
    expect(lastStateText('paused')).toBe('Paused: agents can’t run on this account right now.');
    expect(lastStateText('over_cap')).toBe('Skipped: more timers than the plan allows. Delete one to start it again.');
  });
  it('a finished one-shot has run; a repeat never finishes', () => {
    expect(isFinished({ kind: 'once', lastAt: 5 })).toBe(true);
    expect(isFinished({ kind: 'once', lastAt: null })).toBe(false);
    expect(isFinished({ kind: 'repeat', lastAt: 5 })).toBe(false);
  });
  it('names a zone as a member says it, and no days as words', () => {
    expect(zoneName('America/Denver', Date.UTC(2026, 10, 9))).toBe('Mountain Time');
    expect(zoneName(null)).toBe('UTC');
    expect(daysText([])).toBe('no days');
  });
});

describe('timers: zones', () => {
  it('reads a wall clock in a zone, with its weekday', () => {
    expect(wallAt(NOW, DENVER)).toMatchObject({ y: 2026, mo: 10, d: 8, h: 3, mi: 15, wd: 7 });
    expect(wallAt(NOW, 'UTC')).toMatchObject({ h: 10, wd: 7 });
    expect(offsetAt(NOW, DENVER)).toBe(-7 * 3_600_000);
  });

  it('turns a wall time back into an instant, and runs a skipped one at the first instant after the gap', () => {
    expect(wallToEpoch(2026, 10, 9, 8, 0, DENVER)).toBe(Date.UTC(2026, 10, 9, 15, 0));
    // Mar 8 2026, 02:30 doesn't exist in Denver: clocks go from 02:00 MST to 03:00 MDT, at 09:00 UTC.
    expect(wallToEpoch(2026, 2, 8, 2, 30, DENVER)).toBe(Date.UTC(2026, 2, 8, 9, 0));
    // Nov 1 2026, 01:30 happens twice: the first, in MDT.
    expect(wallToEpoch(2026, 10, 1, 1, 30, DENVER)).toBe(Date.UTC(2026, 10, 1, 7, 30));
  });
});

describe('timers: the next run', () => {
  it('every weekday at 8:00 in the member\'s zone, from a Sunday night', () => {
    const t = timer({ days: [1, 2, 3, 4, 5], time: '08:00' });
    expect(nextRun(t, NOW, DENVER)).toBe(Date.UTC(2026, 10, 9, 15, 0)); // Monday 08:00 MST
    expect(nextRun(t, Date.UTC(2026, 10, 13, 15, 0), DENVER)).toBe(Date.UTC(2026, 10, 16, 15, 0)); // Friday's has passed: Monday
  });

  it('every so many minutes counts from the last run, or when it was made', () => {
    const t = timer({ everyMinutes: 30, createdAt: NOW - 45 * 60_000 });
    expect(nextRun(t, NOW, DENVER)).toBe(NOW + 15 * 60_000);
    expect(nextRun({ ...t, lastAt: NOW - 10 * 60_000 }, NOW, DENVER)).toBe(NOW + 20 * 60_000);
  });

  it('once: its time, until it has run or passed; and none while off', () => {
    const t = timer({ kind: 'once', at: NOW + 7_200_000 });
    expect(nextRun(t, NOW, DENVER)).toBe(NOW + 7_200_000);
    expect(nextRun({ ...t, lastAt: NOW }, NOW, DENVER)).toBeNull();
    expect(nextRun({ ...t, at: NOW - 1 }, NOW, DENVER)).toBeNull();
    expect(nextRun({ ...t, enabled: false }, NOW, DENVER)).toBeNull();
  });
});

describe('timers: in words', () => {
  it('says days, schedules and durations as a member would', () => {
    expect(daysText([1, 2, 3, 4, 5])).toBe('weekdays');
    expect(daysText([6, 7])).toBe('weekends');
    expect(daysText([7, 1, 2, 3, 4, 5, 6])).toBe('every day');
    expect(daysText([1, 3, 5])).toBe('Mon, Wed and Fri');
    expect(daysText([2])).toBe('Tuesdays');
    expect(scheduleText(timer({ days: [1, 2, 3, 4, 5], time: '08:00' }), DENVER)).toBe('Weekdays at 8:00 AM');
    expect(scheduleText(timer({ days: [6], time: '17:30' }), DENVER)).toBe('Saturdays at 5:30 PM');
    expect(scheduleText(timer({ everyMinutes: 90 }), DENVER)).toBe('Every 1 hour 30 minutes');
    expect(scheduleText(timer({ kind: 'once', at: Date.UTC(2026, 10, 9, 15, 0) }), DENVER)).toBe('Once, Mon, Nov 9, 8:00 AM');
    expect(whenText(Date.UTC(2026, 10, 9, 15, 0), 'UTC')).toBe('Mon, Nov 9, 3:00 PM');
    expect(durationText(5)).toBe('5 minutes');
    expect(durationText(1440)).toBe('1 day');
  });
});

describe('timers: the desk\'s checks', () => {
  const ok = { label: 'Brief', prompt: 'Go' };
  it('takes each valid shape', () => {
    expect(timerProblem({ ...ok, kind: 'repeat', days: [1, 5], time: '08:00' }, CAPS, NOW)).toBeNull();
    expect(timerProblem({ ...ok, kind: 'repeat', everyMinutes: 5 }, CAPS, NOW)).toBeNull();
    expect(timerProblem({ ...ok, kind: 'once', inMinutes: 120 }, CAPS, NOW)).toBeNull();
    expect(timerProblem({ ...ok, kind: 'once', at: NOW + 60_000 }, CAPS, NOW)).toBeNull();
  });
  it('refuses each field in the desk\'s words', () => {
    expect(timerProblem({ ...ok, label: ' ', kind: 'once', inMinutes: 5 }, CAPS, NOW)).toBe('label');
    expect(timerProblem({ ...ok, prompt: 'x'.repeat(2001), kind: 'once', inMinutes: 5 }, CAPS, NOW)).toBe('prompt');
    expect(timerProblem({ ...ok, kind: 'once', inMinutes: 0 }, CAPS, NOW)).toBe('inMinutes');
    expect(timerProblem({ ...ok, kind: 'once', at: NOW - 1 }, CAPS, NOW)).toBe('at');
    expect(timerProblem({ ...ok, kind: 'once', at: NOW + 400 * 86_400_000 }, CAPS, NOW)).toBe('at');
    expect(timerProblem({ ...ok, kind: 'repeat', everyMinutes: 4 }, CAPS, NOW)).toBe('everyMinutes');
    expect(timerProblem({ ...ok, kind: 'repeat', everyMinutes: 30, days: [1], time: '08:00' }, CAPS, NOW)).toBe('everyMinutes');
    expect(timerProblem({ ...ok, kind: 'repeat', days: [], time: '' }, CAPS, NOW)).toBe('days');
    expect(timerProblem({ ...ok, kind: 'repeat', days: [8], time: '08:00' }, CAPS, NOW)).toBe('days');
    expect(timerProblem({ ...ok, kind: 'repeat', days: [1, 1], time: '08:00' }, CAPS, NOW)).toBe('days');
    expect(timerProblem({ ...ok, kind: 'repeat', days: [1], time: '24:00' }, CAPS, NOW)).toBe('time');
  });
});

describe('proposals', () => {
  it('canonical JSON sorts keys at every level, drops absent members and keeps arrays in order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' }, u: undefined })).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
    expect(canonicalJson('“quoted”\n')).toBe('"“quoted”\\n"');
  });

  it('a card checks its payload against its sha256, and a changed payload fails', async () => {
    const payload = { name: 'Scout', icon: 'compass', solo: true };
    const sha256 = await sha256Hex(canonicalJson(payload));
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await proposalChecks({ payload, sha256 })).toBe(true);
    expect(await proposalChecks({ payload: { ...payload, solo: false }, sha256 })).toBe(false);
  });

  it('is open while pending and inside its 24 hours', () => {
    expect(proposalOpen({ state: 'pending', expiresAt: 10 }, 5)).toBe(true);
    expect(proposalOpen({ state: 'pending', expiresAt: 10 }, 10)).toBe(false);
    expect(proposalOpen({ state: 'applied', expiresAt: 10 }, 5)).toBe(false);
  });

  const ctx = { agents: [{ id: 'ag-a', name: 'Scout' }, { id: 'ag-b', name: 'Writer' }], zone: DENVER, iconLabel: (id: string) => `icon ${id}`, toneLabel: (id: string) => `tone ${id}`, keyLabel: () => 'Personal · Anthropic' };

  it('shows every field of a create, its links with their rules, and its timers', () => {
    const v = describeProposal(
      {
        action: 'agent.create',
        payload: { name: 'Scout', purpose: 'Brief me.', icon: 'compass', tone: 'teal', keyId: 'k1', model: 'm1', solo: false, workspaceMb: 50, links: [{ to: 'ag-b', rules: 'Only summaries.' }], timers: [{ label: 'Morning', kind: 'repeat', days: [1, 2, 3, 4, 5], time: '08:00', prompt: 'Brief.' }], extra: 7 },
      },
      ctx,
    );
    expect(v.title).toBe('Add the agent “Scout”');
    expect(v.rows.map((r) => `${r.label}: ${r.value}`)).toEqual([
      'Name: Scout',
      'Purpose: Brief me.',
      'Icon: icon compass',
      'Color: tone teal',
      'Key: Personal · Anthropic',
      'Model: m1',
      'Messages other agents: Yes, as its links allow',
      'Workspace: 50 MB',
      // A field the card doesn't know still shows.
      'Other change: extra: 7',
    ]);
    expect(v.links).toMatchObject([{ to: 'Writer', rules: 'Only summaries.', gone: false }]);
    expect(v.timers).toEqual([{ label: 'Morning', schedule: 'Weekdays at 8:00 AM', prompt: 'Brief.', enabled: true }]);
    expect(v.look).toEqual({ icon: 'compass', tone: 'teal' });
  });

  it('says what each card costs or how to undo it, and what a removal takes', () => {
    const c = describeProposal({ action: 'agent.create', payload: { name: 'X', keyId: 'k1' } }, { ...ctx, keyName: () => 'Personal' });
    expect(c.note).toBe('Runs on your Personal key and counts toward its limits. Change or delete it any time in its settings.');
    const t = describeProposal({ action: 'timer.set', payload: { agentId: 'ag-a', timer: { label: 'W', kind: 'repeat', days: [1, 2, 3, 4, 5], time: '08:00', prompt: 'x' } } }, ctx);
    expect(t.note).toBe('Each run counts toward Scout’s limits, about 22 runs a month. It skips a run when a limit is reached.');
    expect(runsPerMonth({ kind: 'repeat', everyMinutes: 60 })).toBe(720);
    expect(runsPerMonth({ kind: 'once' })).toBe(1);
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-a', name: 'Y' } }, ctx).note).toBe('You can change this back in Scout’s settings.');
    expect(describeProposal({ action: 'agent.links', payload: { agentId: 'ag-a', links: [] } }, ctx).note).toBe('You can change this back in Scout’s settings.');
    const d = describeProposal({ action: 'agent.delete', payload: { agentId: 'ag-a' } }, ctx);
    expect(d.note).toBe('This can’t be undone.');
    expect(d.remove?.button).toBe('Remove Scout');
    expect(d.remove?.goesWith).toContain('Agent messages log for 100 days');
  });

  it('names the agent a change, a removal, links or a timer is about', () => {
    expect(describeProposal({ action: 'agent.delete', payload: { agentId: 'ag-a' } }, ctx).title).toBe('Remove Scout');
    const links = describeProposal({ action: 'agent.links', payload: { agentId: 'ag-b', solo: false, links: [{ to: 'ag-a', rules: 'Be brief.' }] } }, ctx);
    expect(links.title).toBe('Change whom Writer may message');
    expect(links.links).toMatchObject([{ to: 'Scout', rules: 'Be brief.' }]);
    const t = describeProposal({ action: 'timer.set', payload: { agentId: 'ag-a', timer: { label: 'Check', kind: 'once', inMinutes: 120, prompt: 'Look.' } } }, ctx);
    expect(t.title).toBe('Add a timer to Scout');
    expect(t.timers[0]?.schedule).toBe('Once, in 2 hours');
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-gone', name: 'X' } }, ctx).title).toBe('Change a deleted agent');
  });
});

describe('png', () => {
  // A 1 x 1 transparent PNG.
  const ONE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const limits = { maxBytes: 262_144, maxPx: 512 };

  it('reads the header of a real PNG', () => {
    expect(pngCheck(fromBase64(ONE), limits)).toEqual({ ok: true, width: 1, height: 1 });
    expect(toBase64(fromBase64(ONE))).toBe(ONE);
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });

  it('refuses, in the desk\'s order: not a PNG, too large, a broken header, too many pixels', () => {
    expect(pngCheck(new TextEncoder().encode('GIF89a...'), limits)).toEqual({ ok: false, reason: 'not_png' });
    expect(pngCheck(fromBase64(ONE), { ...limits, maxBytes: 10 })).toEqual({ ok: false, reason: 'too_large' });
    const broken = fromBase64(ONE);
    broken[20] = 9; // the height changes, the CRC doesn't
    expect(pngCheck(broken, limits)).toEqual({ ok: false, reason: 'corrupt' });
    const big = fromBase64(ONE);
    big.set([0, 0, 2, 1], 16); // 513 wide
    const crc = crc32(big.subarray(12, 29));
    big.set([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255], 29);
    expect(pngCheck(big, limits)).toEqual({ ok: false, reason: 'too_many_pixels' });
    expect(pngRefusalText('too_large', limits)).toBe('That file is over 256 KB. Pick a smaller one.');
  });
});

describe('workspace', () => {
  it('checks paths as the desk does', () => {
    expect(pathProblem('notes/a.md')).toBeNull();
    expect(pathProblem('')).toBe('empty');
    expect(pathProblem('/etc/passwd')).toBe('absolute');
    expect(pathProblem('a/../b')).toBe('dot');
    expect(pathProblem('a//b')).toBe('dot');
    expect(pathProblem('a\0b')).toBe('nul');
    expect(pathProblem(Array(17).fill('a').join('/'))).toBe('deep');
    expect(pathProblem('x'.repeat(1025))).toBe('long');
  });
  it('says sizes and splits paths', () => {
    expect(bytesText(512)).toBe('512 bytes');
    expect(bytesText(18_233)).toBe('17.8 KB');
    expect(bytesText(209_715_200)).toBe('200 MB');
    expect(nameOf('a/b/c.md')).toBe('c.md');
    expect(parentOf('a/b/c.md')).toBe('a/b');
    expect(parentOf('c.md')).toBe('');
    expect(parseMb('50', 1024)).toBe(50);
    expect(parseMb('0', 1024)).toBeNull();
    expect(parseMb('2000', 1024)).toBeNull();
    expect(parseMb('1.5', 1024)).toBeNull();
  });
});

describe('links', () => {
  const agents = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('finds each link the desk would refuse', () => {
    expect(linkProblems('a', [{ to: 'b', rules: 'ok' }], agents, 500)).toEqual([]);
    expect(
      linkProblems('a', [{ to: 'a', rules: 'x' }, { to: 'z', rules: 'x' }, { to: 'b', rules: 'x' }, { to: 'b', rules: 'y' }, { to: 'c', rules: '  ' }], agents, 500).map((p) => p.problem),
    ).toEqual(['self', 'unknown', 'duplicate', 'empty']);
    expect(linkProblems('a', [{ to: 'b', rules: 'x'.repeat(501) }], agents, 500)).toEqual([{ to: 'b', problem: 'long' }]);
  });
  it('counts characters as the desk does, and says what came of a message', () => {
    expect(charCount('ab😀')).toBe(4);
    expect(a2aStateText({ state: 'refused', reason: 'rate' })).toBe('Stopped: the most messages an hour between these two');
    expect(a2aStateText({ state: 'refused', reason: 'desk_rate' })).toBe('Stopped: the most messages an hour on this desk');
    expect(a2aStateText({ state: 'refused', reason: 'desk_spend' })).toBe('Stopped: agents have used this desk’s share of today’s limit for messages');
    expect(a2aStateText({ state: 'refused', reason: 'solo' })).toBe('Stopped: the sender is solo');
    expect(a2aStateText({ state: 'failed', reason: 'unavailable' })).toBe('Failed: unavailable');
    expect(a2aStateText({ state: 'replied', reason: null })).toBe('Replied');
  });
});
