// Runs that survive a desk restart (sub/mm-durable-resume): the reply's `resumed` line, an `interrupted` chip and a call whose
// ticket the restart lost (`approval_unknown`), in the member's words.
import { describe, expect, it } from 'vitest';
import type { Message, ToolChip } from '../client/types';
import { seed } from '../mock/fixtures';
import { failedWords } from './approvals';
import { RESUMED_NOTE, resumedNote, runSummaryOf } from './runSummary';
import { chipOf, interruptedText } from './tools';

const reply = (over: Partial<Message> = {}): Message => ({ id: 'm1', role: 'assistant', text: 'Done.', at: 1, state: 'done', ...over });
const chip = (over: Partial<ToolChip> = {}): ToolChip => ({ name: 'files_write', summary: 'Saved a file in your Files', ok: false, interrupted: true, risk: 'write', ...over });

describe('a reply whose run picked up again after a restart', () => {
  it('says so once, while it streams and after it ends, and never a count', () => {
    expect(RESUMED_NOTE).toBe('Picked up where it left off after the desk restarted.');
    expect(resumedNote(reply({ resumed: 1 }))).toBe(RESUMED_NOTE);
    expect(resumedNote(reply({ resumed: 3, state: 'streaming' }))).toBe(RESUMED_NOTE);
    expect(resumedNote(reply({ resumed: 2, state: 'failed' }))).toBe(RESUMED_NOTE);
  });

  it('says nothing for a run that never restarted, or a member’s message', () => {
    expect(resumedNote(reply())).toBeNull();
    expect(resumedNote(reply({ resumed: 0 }))).toBeNull();
    expect(resumedNote({ role: 'user', resumed: 1 })).toBeNull();
  });
});

describe('a chip a restart cut off (`interrupted`)', () => {
  it('reads as not finished and says to check its target', () => {
    expect(interruptedText('notes/plan.md')).toBe('Didn’t finish: the desk restarted. It may have happened: check notes/plan.md before you ask again.');
    const v = chipOf(chip({ target: { kind: 'file', path: 'notes/plan.md' } }));
    expect(v).toMatchObject({ word: 'Didn’t finish', result: 'failed', target: 'notes/plan.md', why: 'Didn’t finish: the desk restarted. It may have happened: check notes/plan.md before you ask again.' });
    expect(v?.note).toBe(v?.why);
    expect(chipOf(chip({ name: 'notebook_write', target: { kind: 'page', pageId: 'p', title: 'Home office' } }))?.note).toBe('Didn’t finish: the desk restarted. It may have happened: check “Home office” before you ask again.');
  });

  it('says “check it” with no target', () => {
    expect(interruptedText(null)).toBe('Didn’t finish: the desk restarted. It may have happened: check it before you ask again.');
    expect(chipOf(chip())?.why).toBe('Didn’t finish: the desk restarted. It may have happened: check it before you ask again.');
  });

  it('is never done, even if a desk sent ok; a stop stays a stop', () => {
    expect(chipOf(chip({ ok: true }))?.result).toBe('failed');
    expect(chipOf(chip({ stopped: true }))).toMatchObject({ result: 'stopped', word: 'Stopped' });
    expect(chipOf(chip({ stopped: true }))?.note).toBeUndefined();
  });

  it('leaves the line to its card when it asked', () => {
    const v = chipOf(chip({ approval: { id: 'ap-1', decision: 'interrupted' } }));
    expect(v?.why).toBe('Didn’t finish: the desk restarted. It may have happened: check it before you ask again.');
    expect(v?.note).toBeUndefined();
  });

  it('a chip that wasn’t cut off has no line', () => {
    expect(chipOf(chip({ interrupted: undefined }))?.note).toBeUndefined();
    expect(chipOf(chip({ interrupted: false, ok: true }))).toMatchObject({ result: 'done', why: null });
  });
});

describe('a call whose ticket a restart lost before it ran (`approval_unknown`)', () => {
  it('says nothing was done', () => {
    expect(failedWords('approval_unknown')).toBe('The desk restarted before this ran, so nothing was done. Ask again if you still want it.');
    expect(failedWords('timeout')).toBe('The site didn’t answer in time.');
  });
});

describe('the demo shows both', () => {
  it('Writer’s reply picked up after a restart and has a call the restart cut off', () => {
    const tw2 = seed('tools', 1_000_000_000).threads['writer']?.find((m) => m.id === 'tw2');
    expect(resumedNote(tw2!)).toBe(RESUMED_NOTE);
    const cut = tw2!.tools!.map((t) => chipOf(t)).find((v) => v?.note);
    expect(cut?.note).toBe('Didn’t finish: the desk restarted. It may have happened: check “Drafts older than a year” before you ask again.');
    expect(runSummaryOf(tw2!)).toMatchObject({ tools: 2, unasked: 1, failed: 0, unfinished: 1 });
  });
});
