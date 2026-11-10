import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';
import { parseInline, parseMarkdown, plainText } from './markdown';

const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe('Markdown: what renders', () => {
  it('paragraphs, line breaks, headings and rules', () => {
    expect(html('One\ntwo\n\nThree')).toBe('<p>One<br/>two</p><p>Three</p>');
    expect(html('# Big\n## Mid\n### Small\n#### Smaller\n#hashtag')).toBe('<h3>Big</h3><h4>Mid</h4><h5>Small</h5><h5>Smaller</h5><p>#hashtag</p>');
    expect(html('a\n\n---\n\nb')).toBe('<p>a</p><hr/><p>b</p>');
  });

  it('bold, italic and both, nested either way', () => {
    expect(html('**bold** and *it* and __b__ and _i_')).toBe('<p><strong>bold</strong> and <em>it</em> and <strong>b</strong> and <em>i</em></p>');
    expect(html('***both***')).toBe('<p><strong><em>both</em></strong></p>');
    expect(html('**bold *in* bold**')).toBe('<p><strong>bold <em>in</em> bold</strong></p>');
    expect(html('*it **bold** it*')).toBe('<p><em>it <strong>bold</strong> it</em></p>');
    expect(html('**a *b***')).toBe('<p><strong>a <em>b</em></strong></p>');
    expect(html('*a **b***')).toBe('<p><em>a <strong>b</strong></em></p>');
  });

  it("leaves what isn't emphasis alone", () => {
    expect(html('snake_case_name and 2 * 3 * 4')).toBe('<p>snake_case_name and 2 * 3 * 4</p>');
    expect(html('**not closed')).toBe('<p>**not closed</p>');
    expect(html('\\*literal\\*')).toBe('<p>*literal*</p>');
  });

  it('inline code and fenced code, with nothing inside parsed', () => {
    expect(html('Run `ssh **x**` now')).toBe('<p>Run <code>ssh **x**</code> now</p>');
    expect(html('```bash\nls -la\n<b>x</b>\n```')).toBe('<pre><code>ls -la\n&lt;b&gt;x&lt;/b&gt;</code></pre>');
    // Still streaming, with no closing fence yet.
    expect(html('```\npartial')).toBe('<pre><code>partial</code></pre>');
  });

  it('lists, ordered and not, nested, with code under an item', () => {
    expect(html('- one\n- two')).toBe('<ul><li><p>one</p></li><li><p>two</p></li></ul>');
    expect(html('3. a\n4. b')).toBe('<ol start="3"><li><p>a</p></li><li><p>b</p></li></ol>');
    expect(html('1. Open it\n   - then this\n   - and this\n2. Done')).toBe(
      '<ol><li><p>Open it</p><ul><li><p>then this</p></li><li><p>and this</p></li></ul></li><li><p>Done</p></li></ol>',
    );
    expect(html('1. Run:\n   ```\n   ls\n   ```\n2. Next')).toBe('<ol><li><p>Run:</p><pre><code>ls</code></pre></li><li><p>Next</p></li></ol>');
    expect(html('- a\n\n- b')).toBe('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  });
});

describe('Markdown: what never renders', () => {
  it('raw HTML is only text', () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="https://evil.example">x</a> <iframe src="https://evil.example"></iframe>');
    expect(out).not.toMatch(/<(script|img|a|iframe)\b/);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('no image at all: only its alt text, and its address never appears', () => {
    for (const src of ['https://minimalistalliance.com/a.png', 'https://evil.example/t.gif?d=secret', 'data:image/png;base64,AAAA']) {
      const out = html(`Look: ![the alt](${src}) done`);
      expect(out).toBe('<p>Look: the alt done</p>');
      expect(out).not.toContain(src);
    }
    expect(html('[![alt](https://evil.example/i.png)](https://minimalistalliance.com/)')).toBe('<p><a href="https://minimalistalliance.com/" target="_blank" rel="noopener noreferrer">alt</a></p>');
  });

  it('links only to our own hosts, in a new tab; any other is plain text with its address', () => {
    expect(html('[Pricing](https://minimalistalliance.com/pricing)')).toBe('<p><a href="https://minimalistalliance.com/pricing" target="_blank" rel="noopener noreferrer">Pricing</a></p>');
    expect(html('[Click](https://evil.example/x)')).toBe('<p>Click (https://evil.example/x)</p>');
    expect(html('[**Bold** here](https://evil.example)')).toBe('<p><strong>Bold</strong> here (https://evil.example)</p>');
    for (const bad of ['javascript:alert(1)', 'http://minimalistalliance.com/', 'https://minimalistalliance.com.evil.example/', 'data:text/html,x', '/relative', 'mailto:a@b.c']) {
      expect(html(`[x](${bad})`), bad).not.toContain('<a');
    }
    expect(html('<https://minimalistalliance.com/terms> and <https://evil.example>')).toBe(
      '<p><a href="https://minimalistalliance.com/terms" target="_blank" rel="noopener noreferrer">https://minimalistalliance.com/terms</a> and https://evil.example</p>',
    );
  });

  it('bare addresses: ours become links, others stay text, and trailing punctuation stays out', () => {
    expect(html('See https://minimalistalliance.com/privacy.')).toBe('<p>See <a href="https://minimalistalliance.com/privacy" target="_blank" rel="noopener noreferrer">https://minimalistalliance.com/privacy</a>.</p>');
    expect(html('(https://evil.example/x)')).toBe('<p>(https://evil.example/x)</p>');
    // A link's own text never holds another link.
    expect(html('[https://minimalistalliance.com](https://minimalistalliance.com)')).toBe('<p><a href="https://minimalistalliance.com/" target="_blank" rel="noopener noreferrer">https://minimalistalliance.com</a></p>');
  });

  it("stops nesting at a fixed depth, and doesn't choke on long or hostile input", () => {
    const deep = `${'> '.repeat(50)}deep`;
    expect(() => html(deep)).not.toThrow();
    const stars = '*'.repeat(5000);
    expect(html(stars)).not.toContain('<em>');
    const brackets = '['.repeat(3000) + 'x' + ']'.repeat(3000);
    const t = Date.now();
    html(brackets + '(https://evil.example)');
    html('*a '.repeat(2000));
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('the stub marker\'s kind of reply renders without any of it getting through', () => {
    const reply = [
      '# Heading',
      'Some **bold**, *italic* and `code`.',
      '<b>raw</b> <script>x()</script>',
      '![tracker](https://evil.example/pixel.gif?leak=1)',
      '[ours](https://minimalistalliance.com/) [theirs](https://evil.example/)',
      '- one',
      '  - nested',
      '```',
      'code <i>block</i>',
      '```',
    ].join('\n');
    const out = html(reply);
    expect(out).not.toMatch(/<(b|script|img|i)\b/);
    expect(out).not.toContain('pixel.gif');
    expect(out.match(/<a /g)).toHaveLength(1);
  });
});

describe('plainText', () => {
  it('is the words without the marks, for the live region', () => {
    expect(plainText(parseMarkdown('**Hi** there.\n\n- one\n- two\n\n[link](https://evil.example)'))).toBe('Hi there. one. two link (https://evil.example)');
  });
});

describe('parseInline', () => {
  it('turns a soft break into a line break', () => {
    expect(parseInline('a\nb')).toEqual([{ t: 'text', v: 'a' }, { t: 'br' }, { t: 'text', v: 'b' }]);
  });
});

describe('the folder', () => {
  it('never writes HTML from a string', () => {
    const dir = import.meta.dirname;
    for (const f of readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    }
  });
});
