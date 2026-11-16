// The message frame (Security's conditions for Wave 1.6): no sandbox tokens at all, its own policy first in its head, only
// `data:` images and Courier's one stylesheet, and nothing in a message's HTML that could change the document's policy, base
// or loading.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES } from '../../theme/tokens';
import { MAIL_SANDBOX, mailPolicy, mailSrcdoc, textOf } from './frame';

const CSS = 'http://localhost:4173/v/e2e/assets/courier-frame-Ab_9-x.css';

describe('the frame', () => {
  it('has no sandbox tokens: no scripts, no same origin, no forms, popups or navigation', () => {
    expect(MAIL_SANDBOX).toBe('');
  });

  it("names nothing but data: images and Courier's stylesheet", () => {
    expect(mailPolicy(CSS)).toBe(`default-src 'none'; img-src data:; style-src ${CSS}; font-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`);
    // A stylesheet URL that isn't a plain absolute .css is dropped, never written into the policy or the document.
    for (const bad of ['javascript:x', "https://a.example/x.css'; script-src *", 'https://a.example/x.css?q=1', '/relative.css', 'https://a.example/x.js', '']) {
      expect(mailPolicy(bad)).toContain("style-src 'none'");
      expect(mailSrcdoc('<p>x</p>', { style: bad })).not.toContain('<link');
    }
  });

  it('puts its policy first in the head, then the stylesheet, then the message as its body', () => {
    const doc = mailSrcdoc('<p>Hello</p>', { style: CSS });
    expect(doc.startsWith('<!doctype html><html lang="en" data-paper="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\';')).toBe(true);
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
    expect(doc).toContain(`<link rel="stylesheet" href="${CSS}">`);
    expect(doc.endsWith('</head><body><p>Hello</p></body></html>')).toBe(true);
  });

  it('neutralises anything that could change the policy, the base or what loads, whatever the sanitizer wrote', () => {
    const evil = '<meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://evil.example/"><script>parent.x=1</script>< script>1</script><LINK rel=stylesheet href=https://evil.example/x.css><iframe src="https://evil.example"></iframe><object data=x></object><embed src=x><form action=https://evil.example><frame src=x>';
    const body = mailSrcdoc(evil, { style: CSS }).split('<body>')[1] ?? '';
    for (const tag of ['meta', 'base', 'script', 'link', 'iframe', 'object', 'embed', 'form', 'frame']) {
      expect(body.toLowerCase()).not.toMatch(new RegExp(`<\\s*${tag}\\b`));
    }
    expect(body).toContain('&lt;meta');
  });

  it('renames any attribute that could take the frame somewhere, in the words too', () => {
    const body = mailSrcdoc('<a HREF="https://evil.example/" data-ma-href="https://ok.example/">x</a><button formaction="https://e.example/">b</button><a ping="https://e.example/">p</a><p>use href="x" in text</p>', { style: CSS }).split('<body>')[1] ?? '';
    expect(body).not.toMatch(/\s(href|formaction|ping)\s*=/i);
    expect(body).toContain('data-x-HREF="https://evil.example/"');
    expect(body).toContain('data-ma-href="https://ok.example/"');
    expect(body).toContain('<p>use data-x-href="x" in text</p>');
  });

  it("renames it however it's written: after a quote, after a slash, past a '>' in a quoted value (Security's CA-I1)", () => {
    const body = mailSrcdoc(`<a id="x"href="https://e.example/">1</a><a/href="https://e.example/">2</a><a title=">" href="https://e.example/">3</a><a title='>'href="https://e.example/">4</a><svg><a xlink:href="https://e.example/">5</a></svg>`, { style: CSS }).split('<body>')[1] ?? '';
    expect(body).not.toMatch(/[\s"'/](href|xlink:href)\s*=/i);
    expect(body.match(/data-x-(href|xlink:href)=/gi)).toHaveLength(5);
    // Where no pattern for a tag's end matches the parser's: a quote in a name or an unquoted value (the read's follow-up).
    const odd = mailSrcdoc(`<a x"y=1 title=">" href="https://e.example/">6</a><a title=x"y z=">" href="https://e.example/">7</a>`, { style: CSS }).split('<body>')[1] ?? '';
    expect(odd).not.toMatch(/[\s"'/]href\s*=/i);
  });

  it('keeps a language tag only when it is one', () => {
    expect(mailSrcdoc('', { style: null, lang: 'fr-CA' })).toContain('<html lang="fr-CA" data-paper="light">');
    expect(mailSrcdoc('', { style: null, lang: '"><script>' })).toContain('<html lang="en" data-paper="light">');
  });

  it("reads a message's words for a description", () => {
    expect(textOf('<p>Hi&nbsp;<b>Dana</b></p>\n<p>Bye</p>')).toBe('Hi Dana Bye');
  });

  it("names the theme's paper and nothing else (the Designer's call 1)", () => {
    expect(mailSrcdoc('', { style: null, paper: 'dark' })).toContain('data-paper="dark"');
    expect(mailSrcdoc('', { style: null, paper: 'dusk' })).toContain('data-paper="dusk"');
    expect(mailSrcdoc('', { style: null, paper: '"><x' })).toContain('data-paper="light"');
  });

  it("paints Dark and Zen on their own soft white, exactly tokens.ts' mark.disc", () => {
    const css = readFileSync(new URL('./courier-frame.css', import.meta.url), 'utf8').toLowerCase();
    for (const theme of ['dusk', 'dark'] as const) {
      const rule = new RegExp(`html\\[data-paper='${theme}'\\] \\{\\s*background: (#[0-9a-f]{6});`).exec(css);
      expect(rule?.[1]).toBe(THEMES[theme].mark.disc.toLowerCase());
    }
  });
});
