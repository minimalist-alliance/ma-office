// The golden frames of files.md section 9 (`services/deskd/docs/files-vectors.json`, written by the deskd builder, so only there once
// both branches are together): what this side sends is those bytes, and what the mock desk answers has the shapes they show. Skipped
// where the file isn't (this branch alone).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFrame, decodeJson, encodeFrame, encodeJson, FLAG_BIN, Kind } from '../../desk/rtc/frames';
import { MockFilesDesk } from '../../desk/mockDeskFiles';
import { MockBulk, newDataControl } from '../../desk/mockDeskData';

const PATH = new URL('../../../../services/deskd/docs/files-vectors.json', import.meta.url);
interface Vector {
  name: string;
  kind: string;
  flags: number;
  id: number;
  seq: number;
  frameHex: string;
  payloadJson?: Record<string, unknown>;
  payloadHex?: string;
}
const have = existsSync(PATH);
const vectors: Vector[] = have ? (JSON.parse(readFileSync(PATH, 'utf8')) as { vectors: Vector[] }).vectors : [];
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const named = (name: string): Vector => vectors.find((v) => v.name === name) as Vector;
const keys = (o: unknown): string[] => Object.keys(o as object).sort();

describe.skipIf(!have)('files.md golden frames', () => {
  it('requests and the first CHUNK encode to exactly the golden bytes', () => {
    for (const name of ['upload.begin request', 'upload.finish request', 'files.list request']) {
      const v = named(name);
      expect(hex(encodeJson(Kind.REQ, v.id, v.payloadJson)[0]!)).toBe(v.frameHex);
    }
    const c = named('first CHUNK');
    expect(hex(encodeFrame(Kind.CHUNK, FLAG_BIN, c.id, c.seq, new TextEncoder().encode('0123456789abcdef')))).toBe(c.frameHex);
  });

  it('the desk frames decode as this side reads them: CREDIT with committed and a terminal error', () => {
    for (const name of ['progress CREDIT', 'terminal CREDIT, credit violation']) {
      const f = decodeFrame(new Uint8Array(Buffer.from(named(name).frameHex, 'hex')));
      expect(f.kind).toBe(Kind.CREDIT);
      expect(decodeJson(f.payload)).toEqual(named(name).payloadJson);
    }
  });

  it('the mock desk answers with the shapes the vectors show', async () => {
    const desk = new MockFilesDesk().seed();
    const bulk = new MockBulk(newDataControl(), () => {});
    const ctx = { bulk, scope: 'owner', idem: 'idem-0001' };
    const begin = (await desk.answer('files.upload.begin', named('upload.begin request').payloadJson!['p'] as Record<string, unknown>, ctx)) as Record<string, unknown>;
    expect(keys(begin)).toEqual(keys(named('upload.begin reply').payloadJson));
    const list = (await desk.answer('files.list', { path: 'Photos' }, ctx)) as { entries: unknown[] };
    expect(keys(list.entries[0])).toEqual(keys((named('files.list reply').payloadJson as { entries: unknown[] }).entries[0]));
    expect(keys(list)).toEqual(keys(named('files.list reply').payloadJson));
    // An image without a token is check_required, with its format; too big a file is no_space with the three numbers.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const up = (await desk.answer('files.upload.begin', { path: 'x.jpg', size: jpeg.length }, { ...ctx, idem: 'a' })) as { uploadId: string; transferId: number };
    bulk.send(up.transferId, 0, jpeg);
    const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', jpeg)));
    const err = await desk.answer('files.upload.finish', { uploadId: up.uploadId, sha256: digest, size: jpeg.length }, { ...ctx, idem: 'b' }).catch((e: { code: string; details: Record<string, unknown> }) => e);
    expect((err as { code: string }).code).toBe((named('check_required').payloadJson as { code: string }).code);
    expect(keys((err as { details: object }).details)).toEqual(keys((named('check_required').payloadJson as { details: object }).details));
    const big = await desk.answer('files.upload.begin', { path: 'huge.bin', size: 2 ** 40 }, { ...ctx, idem: 'c' }).catch((e: { code: string; details: Record<string, unknown> }) => e);
    expect(keys((big as { details: object }).details)).toEqual(keys((named('no_space').payloadJson as { details: object }).details));
  });
});
