import { describe, expect, it } from 'vitest';
import { rejectedWords, serviceRejectedWords } from '../../platform/imageCheck';
import { FilesError } from './api';
import { errorWords, usageDetailWords } from './words';

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
});
