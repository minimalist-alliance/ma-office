import { describe, expect, it } from 'vitest';
import { rejectedWords, serviceRejectedWords } from '../../platform/imageCheck';
import { FilesError } from './api';
import { capDetailWords, capNote, capState, capWords, errorWords, usageDetailWords } from './words';

describe('Files words', () => {
  it('says the outcome first, with the guideline in lower case', () => {
    expect(rejectedWords('G2', 'No hate or harassment.')).toBe("This image wasn't added. It goes against guideline G2: no hate or harassment.");
    expect(rejectedWords('G9', 'AI likeness')).toBe("This image wasn't added. It goes against guideline G9: AI likeness.");
    expect(serviceRejectedWords('It goes against guideline G4: No graphic violence.', 'No graphic violence')).toBe('It goes against guideline G4: no graphic violence.');
  });
  it('keeps the private-desk wording for not_found, and contractions', () => {
    expect(errorWords(new FilesError('not_found'))).toBe("It isn't there any more. It may have been moved or deleted in another window.");
    expect(errorWords(new FilesError('invalid', { reason: 'empty' }))).toBe("That name won't work. Pick another.");
  });
  it('adds up: free is total less used, to one decimal', () => {
    const GB = 1e9;
    const w = usageDetailWords({ total: 34.4 * GB, used: 9.7 * GB, files: 211, trash: 25, uploadable: 22.5 * GB, floor: 2.147 * GB });
    expect(w).toContain('9.7 GB of 34.4 GB used');
    expect(w).toContain('24.7 GB free');
    expect(w).toContain('New files can use 22.5 GB');
  });
  describe('a free desk\'s drive', () => {
    const GIB = 1024 ** 3;
    const cap = 2 * GIB;
    const drive = { alliance: 'Alliance', allianceDrive: '25 GB' };
    it('reads "1.4 GB of 2 GB used", rounded down so it never reads full early', () => {
      expect(capWords(1.45 * GIB, cap)).toBe('1.4 GB of 2 GB used');
      expect(capWords(1.999 * GIB, cap)).toBe('1.9 GB of 2 GB used');
      expect(capWords(0, cap)).toBe('0 MB of 2 GB used');
      expect(capWords(300 * 1024 ** 2, cap)).toBe('300 MB of 2 GB used');
      expect(capWords(2.4 * GIB, cap)).toBe('2 GB of 2 GB used');
    });
    it('moves to near at 90% and full at the cap', () => {
      expect(capState(1.79 * GIB, cap)).toBe('ok');
      expect(capState(1.8 * GIB, cap)).toBe('near');
      expect(capState(cap - 1, cap)).toBe('near');
      expect(capState(cap, cap)).toBe('full');
      expect(capState(cap + 1, cap)).toBe('over');
    });
    it('says the Designer\'s lines, and only what it has the numbers for', () => {
      expect(capNote('ok', drive)).toBeNull();
      expect(capNote('near', drive)).toBe('Alliance has a 25 GB drive.');
      expect(capNote('full', drive)).toBe('Your drive is full. Delete something to make room, or get 25 GB with Alliance.');
      expect(capNote('near', { alliance: 'Alliance', allianceDrive: null })).toBeNull();
      expect(capNote('full', { alliance: 'Alliance', allianceDrive: null })).toBe('Your drive is full. Delete something to make room.');
      expect(capNote('full', null)).toBe('Your drive is full. Delete something to make room.');
      expect(capNote('near', null)).toBeNull();
      expect(capNote('over', null)).toBeNull();
      expect(capNote('over', null, { used: 31.2 * GIB, cap: 25 * GIB })).toBe('You have 31.2 GB in Files, more than 25 GB. It all stays readable; to add more, make room or move back up.');
    });
    it('describes the bar by what the cap counts', () => {
      expect(capDetailWords({ cap, used: 1.5 * GIB, files: 1.2 * GIB, trash: 0.3 * GIB })).toBe('1.5 GB of 2 GB used, Files 1.2 GB, Trash 307 MB. The trash counts toward your drive until it is emptied.');
      expect(capDetailWords({ cap, used: 100 * 1024 ** 2, files: 100 * 1024 ** 2, trash: 0 })).not.toContain('Trash 0');
    });
  });
});
