import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { derToRaw, keyIdOf, verifyView, type ReviewKey } from './verify';

const APP = 'org.example.tally';
const HTML = '<main><p id="count">0</p><button id="plus">+</button></main>';
const JS = 'document.getElementById("plus").onclick = () => {};';
const CSS = 'body { margin: 0; }';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const spkiOf = (k: KeyObject): Buffer => k.export({ type: 'spki', format: 'der' });

function manifest(id = APP, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    manifest: 1, id, name: 'Tally', version: '0.1.0', publisher: 'Example',
    views: { window: { html: 'view/index.html', script: 'view/view.js', style: 'view/view.css', width: 360, height: 280 }, widget: true },
    methods: [{ name: 'tally.get', mutation: false }, { name: 'tally.add', mutation: true }],
    topics: ['tally'],
    files: {
      'bin/tally': { sha256: sha('binary'), size: 6, mode: '0755' },
      'view/index.html': { sha256: sha(HTML), size: Buffer.byteLength(HTML), mode: '0644' },
      'view/view.js': { sha256: sha(JS), size: Buffer.byteLength(JS), mode: '0644' },
      'view/view.css': { sha256: sha(CSS), size: Buffer.byteLength(CSS), mode: '0644' },
    },
    ...extra,
  }, null, 2);
}

interface Signer {
  key: ReviewKey;
  keyId: string;
  sign(data: string): string;
}

function ed25519(tier: ReviewKey['tier'] = 'first-party'): Signer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = spkiOf(publicKey);
  return {
    key: { tier, spki: spki.toString('base64') },
    keyId: createHash('sha256').update(spki).digest('hex').slice(0, 16),
    sign: (data) => nodeSign(null, Buffer.from(data), privateKey).toString('base64'),
  };
}

/** P-256, its signature DER over SHA-256, as the cloud key service gives it. */
function p256(tier: ReviewKey['tier'] = 'first-party'): Signer {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = spkiOf(publicKey);
  return {
    key: { tier, spki: spki.toString('base64') },
    keyId: createHash('sha256').update(spki).digest('hex').slice(0, 16),
    sign: (data) => nodeSign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
  };
}

function viewGet(m: string, signers: Signer[], files: Record<string, string> = { 'view/index.html': HTML, 'view/view.js': JS, 'view/view.css': CSS }) {
  return {
    id: APP,
    version: '0.1.0',
    manifest: m,
    signatures: JSON.stringify({ signatures: [{ role: 'developer', keyId: '0123456789abcdef', sig: 'AAAA' }, ...signers.map((s) => ({ role: 'review', keyId: s.keyId, sig: s.sign(m) }))] }),
    files,
  };
}

describe('the review signature over the manifest exact bytes', () => {
  it('a good Ed25519 review signature and every file hash: verified, with the declared methods and topics', async () => {
    const k = ed25519();
    const v = await verifyView(viewGet(manifest(), [k]), [k.key], { appId: APP });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.view.trust).toBe('first-party');
    expect([...v.view.methods]).toEqual([['tally.get', false], ['tally.add', true]]);
    expect([...v.view.topics]).toEqual(['tally']);
    expect(v.view.script).toBe(JS);
    expect(v.view.scriptHash).toBe(createHash('sha256').update(JS).digest('base64'));
    expect(v.view.manifestSha256).toBe(sha(manifest()));
  });

  it('a good P-256 review signature (DER, SHA-256) verifies too', async () => {
    const k = p256();
    expect((await verifyView(viewGet(manifest(), [k]), [k.key], { appId: APP })).ok).toBe(true);
  });

  it('two keys shipped at once: either one checks', async () => {
    const a = ed25519();
    const b = p256();
    expect((await verifyView(viewGet(manifest(), [b]), [a.key, b.key], { appId: APP })).ok).toBe(true);
    expect((await verifyView(viewGet(manifest(), [a]), [a.key, b.key], { appId: APP })).ok).toBe(true);
  });

  it('a changed file: refused on its hash', async () => {
    const k = ed25519();
    const v = await verifyView(viewGet(manifest(), [k], { 'view/index.html': HTML, 'view/view.js': `${JS}\nfetch("/x")`, 'view/view.css': CSS }), [k.key], { appId: APP });
    expect(v).toEqual({ ok: false, why: 'hash' });
  });

  it('a changed manifest: the signature no longer checks', async () => {
    const k = ed25519();
    const raw = viewGet(manifest(), [k]);
    raw.manifest = raw.manifest.replace('"Tally"', '"Tally!"');
    expect(await verifyView(raw, [k.key], { appId: APP })).toEqual({ ok: false, why: 'signature' });
  });

  it('even a byte of whitespace in the manifest breaks it: the check is over the exact bytes', async () => {
    const k = ed25519();
    const raw = viewGet(manifest(), [k]);
    raw.manifest = `${raw.manifest} `;
    expect(await verifyView(raw, [k.key], { appId: APP })).toEqual({ ok: false, why: 'signature' });
  });

  it('a signature by a key the Desk app does not ship: refused', async () => {
    const shipped = ed25519();
    const stranger = ed25519();
    expect(await verifyView(viewGet(manifest(), [stranger]), [shipped.key], { appId: APP })).toEqual({ ok: false, why: 'signature' });
  });

  it('a developer signature alone is not a review: refused', async () => {
    const k = ed25519();
    const raw = viewGet(manifest(), []);
    raw.signatures = JSON.stringify({ signatures: [{ role: 'developer', keyId: k.keyId, sig: k.sign(raw.manifest) }] });
    expect(await verifyView(raw, [k.key], { appId: APP })).toEqual({ ok: false, why: 'signature' });
  });

  it('a key the catalog says is revoked: refused', async () => {
    const k = ed25519();
    expect(await verifyView(viewGet(manifest(), [k]), [k.key], { appId: APP, revokedKeys: new Set([k.keyId]) })).toEqual({ ok: false, why: 'signature' });
  });

  it('a manifest the catalog says is revoked: refused', async () => {
    const k = ed25519();
    expect(await verifyView(viewGet(manifest(), [k]), [k.key], { appId: APP, revokedManifests: new Set([sha(manifest())]) })).toEqual({ ok: false, why: 'revoked' });
  });

  it('two review signatures of different tiers give the lower tier (C3)', async () => {
    const first = ed25519('first-party');
    const community = p256('community');
    const v = await verifyView(viewGet(manifest(), [first, community]), [first.key, community.key], { appId: APP });
    expect(v.ok && v.view.trust).toBe('community');
  });

  it('another app id, a file the manifest does not name, or a missing file: refused', async () => {
    const k = ed25519();
    expect((await verifyView(viewGet(manifest(), [k]), [k.key], { appId: 'org.example.other' })).ok).toBe(false);
    expect(await verifyView(viewGet(manifest(), [k], { 'view/index.html': HTML, 'view/view.js': JS, 'view/view.css': CSS, 'view/extra.js': 'x' }), [k.key], { appId: APP })).toEqual({ ok: false, why: 'files' });
    expect(await verifyView(viewGet(manifest(), [k], { 'view/index.html': HTML, 'view/view.js': JS }), [k.key], { appId: APP })).toEqual({ ok: false, why: 'files' });
  });

  it('no keys shipped (as in production until Platform gives them): nothing but a bundled app opens', async () => {
    const k = ed25519();
    expect(await verifyView(viewGet(manifest(), [k]), [], { appId: APP })).toEqual({ ok: false, why: 'signature' });
  });
});

describe('a bundled first-party app (deskd image)', () => {
  const BUNDLED = 'com.minimalistalliance.bible';
  const bundled = (files: Record<string, string> = { 'view/index.html': HTML, 'view/view.js': JS, 'view/view.css': CSS }, id = BUNDLED) => ({ id, version: '0.1.0', manifest: manifest(id), signatures: null, bundled: true, files });

  it('on its file hashes alone: verified, with no key at all', async () => {
    const v = await verifyView(bundled(), [], { appId: BUNDLED });
    expect(v.ok && v.view.trust).toBe('bundled');
  });

  it('with a changed file: refused on its hash', async () => {
    expect(await verifyView(bundled({ 'view/index.html': HTML, 'view/view.js': JS, 'view/view.css': `${CSS} body{display:none}` }), [], { appId: BUNDLED })).toEqual({ ok: false, why: 'hash' });
  });

  it('only for an id of ours: a community id claiming to be bundled is refused', async () => {
    expect(await verifyView(bundled(undefined, APP), [], { appId: APP })).toEqual({ ok: false, why: 'bundled' });
  });

  it('signatures null without bundled: refused', async () => {
    expect(await verifyView({ ...bundled(), bundled: false }, [], { appId: BUNDLED })).toEqual({ ok: false, why: 'signature' });
  });
});

describe('the key id (C3) and DER signatures', () => {
  it('is the first 8 bytes of SHA-256 over the SPKI, as 16 hex digits, for Ed25519 and P-256 alike', async () => {
    for (const s of [ed25519(), p256()]) {
      const spki = Buffer.from(s.key.spki, 'base64');
      expect(await keyIdOf(new Uint8Array(spki))).toBe(createHash('sha256').update(spki).digest('hex').slice(0, 16));
      expect(s.keyId).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('turns DER into the 64 raw bytes, padding a short integer and dropping a sign byte', () => {
    const r = new Uint8Array(32).fill(0x80);
    const s = new Uint8Array(31).fill(0x01);
    const der = Uint8Array.from([0x30, 2 + 33 + 2 + 31, 0x02, 33, 0x00, ...r, 0x02, 31, ...s]);
    const raw = derToRaw(der)!;
    expect(raw.length).toBe(64);
    expect([...raw.subarray(0, 32)]).toEqual([...r]);
    expect(raw[32]).toBe(0);
    expect([...raw.subarray(33)]).toEqual([...s]);
    expect(derToRaw(Uint8Array.from([0x31, 0]))).toBeNull();
    expect(derToRaw(Uint8Array.from([...der, 0]))).toBeNull();
  });
});
