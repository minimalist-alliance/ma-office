// Renaming a desk (contract tiers.md section 8, words.md): who may, what a name may be, and the failures in plain words.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIER_NAMES, tierNamesFrom } from '../platform/tiers';
import { cleanName, DIDNT_SAVE, kindLabel, kindTipFor, mayRename, NAME_RULE, nameProblem, renameFailure, withoutControls } from './rename';

describe('nameProblem', () => {
  it('takes 1 to 40 characters, trimmed, counted as code points', () => {
    expect(nameProblem('Studio')).toBeNull();
    expect(nameProblem('  S  ')).toBeNull();
    expect(nameProblem('x'.repeat(40))).toBeNull();
    expect(nameProblem('😀'.repeat(40))).toBeNull();
    for (const bad of ['', '   ', 'x'.repeat(41), '😀'.repeat(41), `a${String.fromCharCode(7)}b`, `a${String.fromCharCode(127)}`]) expect(nameProblem(bad)).toBe(NAME_RULE);
    // A tab is a space to Platform, as here.
    expect(nameProblem(`a${String.fromCharCode(9)}b`)).toBeNull();
    expect(NAME_RULE).toBe('Use 1 to 40 characters.');
  });
  it('makes each run of spaces one, as Platform does, before it counts', () => {
    expect(cleanName('  Night   Owls ')).toBe('Night Owls');
    expect(nameProblem(`${'x'.repeat(20)}${' '.repeat(30)}${'y'.repeat(19)}`)).toBeNull();
  });
  it('turns a pasted control character into a space', () => {
    expect(withoutControls(`Stu${String.fromCharCode(9)}dio${String.fromCharCode(10)}`)).toBe('Stu dio ');
  });
});

describe('kind', () => {
  it('stays visible whatever the name', () => {
    expect(kindLabel('personal')).toBe('Personal desk');
    expect(kindLabel('work')).toBe('Work desk');
    expect(kindLabel('guild')).toBe('Guild desk');
    expect(kindLabel('custom')).toBe('Desk');
  });
  it('is said beside a name only where the name doesn’t say it', () => {
    expect(kindTipFor('Personal', 'personal')).toBeNull();
    expect(kindTipFor(' work ', 'work')).toBeNull();
    expect(kindTipFor('Studio', 'personal')).toBe('Personal desk');
    expect(kindTipFor('Night Owls', 'guild')).toBe('Guild desk');
    expect(kindTipFor('Home', 'custom')).toBeNull();
  });
});

describe('mayRename', () => {
  it('needs Platform’s `rename` and a tier that renames', () => {
    expect(mayRename({ canRename: true }, 'officer')).toBe(true);
    expect(mayRename({ canRename: true }, 'lead')).toBe(true);
    expect(mayRename({ canRename: true }, 'alliance')).toBe(false);
    expect(mayRename({ canRename: true }, null)).toBe(false);
    expect(mayRename({}, 'officer')).toBe(false);
    expect(mayRename(undefined, 'lead')).toBe(false);
  });
});

describe('renameFailure', () => {
  const names = tierNamesFrom({ alliance: 'Cadet', officer: 'Captain', lead: 'Pathfinder' });
  it('says each refusal in plain words', () => {
    expect(renameFailure({ status: 400, code: 'invalid_request' }, DEFAULT_TIER_NAMES)).toBe(NAME_RULE);
    expect(renameFailure({ status: 403, code: 'tier_required', details: { tiers: ['officer', 'lead'] } }, DEFAULT_TIER_NAMES)).toBe('Renaming a desk comes with Officer or Founder.');
    expect(renameFailure({ status: 403, code: 'tier_required', details: { tiers: ['officer', 'lead'] } }, names)).toBe('Renaming a desk comes with Captain or Pathfinder.');
    expect(renameFailure({ status: 403, code: 'tier_required', details: null }, names)).toBe('Renaming a desk comes with Captain or Pathfinder.');
    expect(renameFailure({ status: 404, code: 'not_found' }, names)).toBe("That desk isn't in your office.");
    expect(renameFailure({ status: 409, code: 'invalid_state' }, names)).toBe("This desk can't be renamed right now.");
    expect(renameFailure({ status: 403, code: 'desk_unavailable' }, names)).toBe("This desk can't be renamed right now.");
  });
  it('says a passing failure didn’t save', () => {
    for (const err of [null, {}, { status: 503, code: 'unavailable' }, { status: 429, code: 'rate_limited' }, { status: 500, code: null }]) {
      expect(renameFailure(err, names)).toBe(DIDNT_SAVE);
    }
  });
});
