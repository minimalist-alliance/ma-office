import { describe, expect, it } from 'vitest';
import { FRAME_ALLOW, SANDBOX, viewPolicy, viewSrcdoc } from './frame';

const BOOT = 'https://office.minimalistalliance.com/v/2026.11.11-abc/assets/boot-Ab12_x.js';
const files = { html: '<main><p id="count">0</p></main>', script: 'console.log(1)', style: 'body{margin:0}', scriptHash: 'abc+/DEF=', styleHash: 'xyz0=' };
const unblock = (doc: string, id: string): string => {
  const m = new RegExp(`<script type="text/plain" id="${id}"[^>]*>([^<]*)</script>`).exec(doc);
  return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : '';
};

describe("the view's policy (contract 3.2)", () => {
  it('is nothing but the boot script, the script by its hash, the style by its hash, data: images and fonts, no forms, no base', () => {
    expect(viewPolicy(BOOT, 'abc+/DEF=', 'xyz0=')).toBe(
      `default-src 'none'; script-src ${BOOT} 'sha256-abc+/DEF='; style-src 'sha256-xyz0='; img-src data:; font-src data:; form-action 'none'; base-uri 'none'`,
    );
  });

  it('refuses anything that could break out of the policy or the attribute', () => {
    expect(() => viewPolicy("https://o.example/x.js 'unsafe-inline'", 'a=', 'b=')).toThrow();
    expect(() => viewPolicy('https://o.example/x.js";x', 'a=', 'b=')).toThrow();
    expect(() => viewPolicy('javascript:alert(1)', 'a=', 'b=')).toThrow();
    expect(() => viewPolicy(BOOT, "a=' 'unsafe-eval", 'b=')).toThrow();
    expect(() => viewPolicy(BOOT, 'a=', 'b; script-src *')).toThrow();
  });

  it('the sandbox is scripts only: never allow-same-origin', () => {
    expect(SANDBOX).toBe('allow-scripts');
    // Copy, never paste: the clipboard's write alone.
    expect(FRAME_ALLOW).toBe('clipboard-write');
  });
});

describe('the srcdoc document', () => {
  const doc = viewSrcdoc(files, { bootUrl: BOOT, font: { family: 'Inter Variable', bytes: new Uint8Array([1, 2, 3]) }, lang: 'en' });

  it('holds the policy first in the head, then the files as data blocks, then the boot, deferred', () => {
    const head = doc.slice(0, doc.indexOf('</head>'));
    expect(head.indexOf('http-equiv="Content-Security-Policy"')).toBeGreaterThan(-1);
    expect(head.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(head.indexOf('id="ma-style"'));
    expect(head).toContain(`<script src="${BOOT}" defer></script>`);
    expect(head.indexOf('id="ma-view"')).toBeLessThan(head.indexOf(`<script src="${BOOT}"`));
    expect(doc).toContain('data-integrity="sha256-abc+/DEF="');
  });

  it("carries the script, style and font exactly, as base64, and the view's markup as the body", () => {
    expect(unblock(doc, 'ma-view')).toBe(files.script);
    expect(unblock(doc, 'ma-style')).toBe(files.style);
    expect(doc).toContain('data-family="Inter Variable"');
    expect(doc.endsWith(`<body>${files.html}</body></html>`)).toBe(true);
  });

  it('has no inline script that runs: only data blocks and the boot by URL', () => {
    const scripts = [...doc.matchAll(/<script([^>]*)>/g)].map((m) => m[1]!);
    for (const attrs of scripts) expect(attrs.includes('type="text/plain"') || attrs.includes(`src="${BOOT}"`)).toBe(true);
  });

  it('a script that would close its own tag stays inside its data block', () => {
    const d = viewSrcdoc({ ...files, script: 'x = "</script><script>alert(1)</script>"' }, { bootUrl: BOOT });
    expect(unblock(d, 'ma-view')).toContain('</script>');
    expect(d.match(/<script/g)?.length).toBe(3);
  });

  it('leaves out a font with an odd family name, and an odd lang', () => {
    const d = viewSrcdoc(files, { bootUrl: BOOT, font: { family: 'x" onload="y', bytes: new Uint8Array([1]) }, lang: 'en"><x' });
    expect(d).not.toContain('ma-font');
    expect(d).toContain('<html lang="en">');
  });
});
