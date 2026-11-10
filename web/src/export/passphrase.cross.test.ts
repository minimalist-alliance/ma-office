// The standalone decrypt tool (tools/export-decrypt/decrypt.mjs) opens what the Desk app writes, and refuses what it should.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encryptStream } from './passphrase';

const TOOL = resolve(__dirname, '../../../tools/export-decrypt/decrypt.mjs');

async function encrypted(plain: Uint8Array, pass: string, record: number): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  async function* one(): AsyncGenerator<Uint8Array> {
    yield plain;
  }
  for await (const c of encryptStream(one(), pass, { iterations: 2000, record })) out.push(c);
  return new Uint8Array(Buffer.concat(out));
}

describe('tools/export-decrypt/decrypt.mjs', () => {
  it('opens a download, writes the ZIP beside it, refuses a wrong passphrase and cleans up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-dec-'));
    try {
      const plain = new Uint8Array(5000).map((_, i) => (i * 31) % 251);
      const file = join(dir, 'export.zip.enc');
      writeFileSync(file, await encrypted(plain, 'a long enough passphrase', 1024));
      writeFileSync(join(dir, 'pass'), 'a long enough passphrase\n');
      writeFileSync(join(dir, 'wrong'), 'not the passphrase');

      const bad = spawnSync('node', [TOOL, file, '--passphrase-file', join(dir, 'wrong')], { encoding: 'utf8' });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('does not open this file');
      expect(existsSync(join(dir, 'export.zip')) || existsSync(join(dir, 'export.zip.part'))).toBe(false);

      execFileSync('node', [TOOL, file, '--passphrase-file', join(dir, 'pass')]);
      expect(new Uint8Array(readFileSync(join(dir, 'export.zip')))).toEqual(plain);

      const again = spawnSync('node', [TOOL, file, '--passphrase-file', join(dir, 'pass')], { encoding: 'utf8' });
      expect(again.status).toBe(1);
      expect(again.stderr).toContain('already there');

      const cut = join(dir, 'cut.zip.enc');
      writeFileSync(cut, readFileSync(file).subarray(0, 40 + 2 * (1024 + 16)));
      const short = spawnSync('node', [TOOL, cut, '--passphrase-file', join(dir, 'pass')], { encoding: 'utf8' });
      expect(short.status).toBe(1);
      expect(existsSync(join(dir, 'cut.zip'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
