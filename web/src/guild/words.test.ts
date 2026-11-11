// The product's term is "Guild Desk", everywhere a member reads about it (the Product Designer, Nov 8; ADR 0080 section 1).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESK_WORDS, GUILD_WORDS, REMOVED_LINE } from './words';

const WEB = join(import.meta.dirname, '..', '..');
const sources = [
  ...readdirSync(join(WEB, 'src', 'guild')).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts')).map((f) => join(WEB, 'src', 'guild', f)),
  join(WEB, 'src', 'agent', 'AgentBody.tsx'),
  join(WEB, 'agent', 'src', 'ui', 'AgentApp.tsx'),
  join(WEB, 'agent', 'src', 'ui', 'Keys.tsx'),
];

describe('the Guild Desk’s name', () => {
  it('the windows say "the Guild Desk"', () => {
    for (const line of Object.values(GUILD_WORDS)) expect(line).toMatch(/the Guild Desk/i);
    expect(REMOVED_LINE).toContain('Guild Desk');
  });

  it('the wake button matches the asleep line', () => {
    expect(DESK_WORDS.wake).toBe('Wake this desk');
    expect(GUILD_WORDS.wake).toBe('Wake the Guild Desk');
  });

  it('no screen of it says "your guild’s desk", nor "the guild’s desk"', () => {
    for (const file of sources) expect(readFileSync(file, 'utf8'), file).not.toMatch(/guild['’]s desk/i);
  });
});
