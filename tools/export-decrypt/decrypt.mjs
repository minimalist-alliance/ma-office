#!/usr/bin/env node
// Opens a Minimalist Alliance data download that was protected with a passphrase (a file ending in .zip.enc).
// Node 18 or newer, nothing to install:
//
//   node decrypt.mjs minimalist-alliance-export-2026-11-08.zip.enc
//
// It asks for the passphrase (typing is hidden; it is never taken on the command line, so it stays out of your shell's
// history), and writes the ZIP beside the file. To run it without a person at the keyboard, put the passphrase in a file
// only you can read and give --passphrase-file <file>. It will not overwrite a file that is already there.
//
// The format is described in README.md here, and in web/src/export/passphrase.ts. It reads the file a piece at a time,
// so a download of any size opens in a little memory. It writes to "<name>.part" and renames it only when every record
// has checked out and the end of the file has been reached, so a wrong passphrase, a damaged file or one cut short
// leaves no half-opened archive behind.
import { createDecipheriv, pbkdf2 } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';

const HEADER = 40;
const TAG = 16;
const MAGIC = 'MAEXPORT';
const pbkdf2p = promisify(pbkdf2);

const fail = (m) => {
  console.error(`decrypt: ${m}`);
  process.exit(1);
};

/** The passphrase typed with nothing shown. */
function ask(prompt) {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stderr.write(chunk); cb(); } });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(prompt, (a) => { rl.close(); process.stderr.write('\n'); resolve(a); });
    muted = true;
  });
}

export function parseHeader(h) {
  if (h.length < HEADER || h.subarray(0, 8).toString('latin1') !== MAGIC) throw new Error('this is not an encrypted download from Minimalist Alliance');
  if (h[8] !== 1 || h[9] !== 1 || h[10] !== 1) throw new Error('this file uses a newer format than this tool knows');
  const iterations = h.readUInt32BE(12);
  const record = h.readUInt32BE(32);
  if (iterations < 1 || iterations > 50_000_000 || record < 1 || record > 64 * 1024 * 1024) throw new Error('the file header is damaged');
  return { iterations, salt: h.subarray(16, 32), record, prefix: h.subarray(36, 40) };
}

const be64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

/** Plaintext pieces from the encrypted file's pieces, or a thrown error. */
export async function* decrypt(chunks, passphrase) {
  let pending = Buffer.alloc(0);
  const it = chunks[Symbol.asyncIterator]();
  let ended = false;
  const need = async (n) => {
    while (pending.length < n && !ended) {
      const r = await it.next();
      if (r.done) { ended = true; break; }
      pending = Buffer.concat([pending, r.value]);
    }
    return pending.length >= n;
  };
  if (!(await need(HEADER))) throw new Error('this is not an encrypted download from Minimalist Alliance');
  const header = Buffer.from(pending.subarray(0, HEADER));
  pending = pending.subarray(HEADER);
  const { iterations, salt, record, prefix } = parseHeader(header);
  const key = await pbkdf2p(Buffer.from(passphrase.normalize('NFC'), 'utf8'), salt, iterations, 32, 'sha256');
  for (let index = 0; ; index += 1) {
    await need(record + TAG + 1);
    const last = pending.length <= record + TAG;
    const len = Math.min(pending.length, record + TAG);
    if (len < TAG) throw new Error('the file is cut short');
    const iv = Buffer.concat([prefix, be64(index)]);
    const aad = Buffer.concat([header, be64(index), Buffer.from([last ? 1 : 0])]);
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(aad);
    d.setAuthTag(pending.subarray(len - TAG, len));
    let plain;
    try {
      plain = Buffer.concat([d.update(pending.subarray(0, len - TAG)), d.final()]);
    } catch {
      throw new Error('that passphrase does not open this file, or the file is damaged or cut short');
    }
    pending = pending.subarray(len);
    yield plain;
    if (last) return;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let file = null;
  let passFile = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--passphrase-file') passFile = args[++i];
    else if (args[i] === '-h' || args[i] === '--help') { console.log('usage: node decrypt.mjs <file.zip.enc> [--passphrase-file <file>]'); return; }
    else if (!file) file = args[i];
    else fail('one file at a time');
  }
  if (!file) fail('usage: node decrypt.mjs <file.zip.enc> [--passphrase-file <file>]');
  if (!existsSync(file)) fail(`${file} isn't there`);
  const out = file.replace(/\.enc$/i, '') === file ? `${file}.zip` : file.replace(/\.enc$/i, '');
  if (existsSync(out)) fail(`${out} is already there. Move it first; this won't overwrite it.`);
  const pass = passFile ? readFileSync(passFile, 'utf8').replace(/\r?\n$/, '') : await ask('Passphrase: ');
  if (!pass) fail('no passphrase given');
  const part = `${out}.part`;
  const fd = openSync(part, 'wx', 0o600);
  try {
    for await (const plain of decrypt(createReadStream(file, { highWaterMark: 1 << 20 }), pass)) writeSync(fd, plain);
    closeSync(fd);
    renameSync(part, out);
    console.log(`Opened. Your archive is ${out}`);
  } catch (err) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(part, { force: true });
    fail(err.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
