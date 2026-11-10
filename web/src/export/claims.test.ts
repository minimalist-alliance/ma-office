// LS-32: the export page's words match /privacy as it reads today. The marketing plan's Claims rule says never "we can't
// see your desk", "zero-knowledge", "end-to-end" or "unhackable": /privacy's "An honest limit" says full admin access
// could, in principle, read a disk or a running desk, so the page says what holds "in normal operation" and no more.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(join(import.meta.dirname, 'ExportPage.tsx'), 'utf8');

describe('the export page’s privacy words', () => {
  it('makes no claim /privacy does not make', () => {
    expect(page).not.toMatch(/can['’]t (read|see)/i);
    expect(page).not.toMatch(/zero[- ]knowledge|end[- ]to[- ]end|unhackable/i);
  });

  it('keeps the meaning: straight to you, encrypted through the relay, unseen in normal operation', () => {
    expect(page).toContain('Your desks send their files straight to you over an encrypted connection.');
    expect(page).toContain("If your connection needs our relay, they pass through it still encrypted, and in normal operation our services don't see them.");
  });
});
