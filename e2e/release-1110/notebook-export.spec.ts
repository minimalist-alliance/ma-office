// Notebook export and print, end to end, on the staging test desk as the e2e test account (S-13). A page with every block, mark
// and color the editor has is made over a desk RPC session. Then the real Notebook window, on staging's own bundle, exports it as
// Markdown and as a web page and prints it, as a member would from the page menu; a second page, long enough to come back from
// the desk in parts, is pasted into the window and exported the same way. Every file is opened and read back against the page
// as the desk holds it. Also
// `notebook.activity`'s paging (S-13's other half), on whatever desk-notebook the test desk runs. Run after the gate, never
// beside it, under ~/work/.test-desk.lock:  npx playwright test -c release-1110 notebook-export.spec.ts
// Logged: method names, counts, sizes, booleans. No page text beyond a random marker and fixed fake sentences.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { APP, DESK_ID, apiToken, focusTestDesk, loadUser, signInApp, watch, type Watch } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, sleep, type OpenResult } from '../tests/streamlib';

test.describe.configure({ mode: 'serial' });
const note = (k: string, v: unknown) => console.log(`[nbx] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
  content?: PMNode[];
}

const MARKER = `nbx${randomBytes(4).toString('hex')}`;
const TITLE = `Export check ${MARKER}`;
const LINK = 'https://example.com/notes?a=1';
const t = (text: string, ...marks: NonNullable<PMNode['marks']>): PMNode => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const para = (...content: PMNode[]): PMNode => ({ type: 'paragraph', content });
const item = (type: 'listItem' | 'taskItem', text: string, extra: Partial<PMNode> = {}): PMNode => ({ type, ...extra, content: [para(t(text)), ...(extra.content ?? [])] });

/** Every block, mark and color the editor has (`web/notebook/src/model/schema.ts`), with fake text. */
const RICH: PMNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [t(TITLE)] },
    para(
      t('Plain words, then '),
      t('bold', { type: 'bold' }),
      t(', '),
      t('italic', { type: 'italic' }),
      t(', '),
      t('struck', { type: 'strike' }),
      t(', '),
      t('underlined', { type: 'underline' }),
      t(', '),
      t('inline code', { type: 'code' }),
      t(' and '),
      t('a link', { type: 'link', attrs: { href: LINK } }),
      t('.'),
    ),
    para(t('Marked '), t('in green', { type: 'highlight', attrs: { color: 'green' } }), t(' and '), t('rose text', { type: 'textColor', attrs: { color: 'rose' } }), t('.')),
    { type: 'heading', attrs: { level: 2, color: 'violet' }, content: [t('A violet heading')] },
    { type: 'bulletList', content: [item('listItem', 'First point'), item('listItem', 'Second point', { content: [{ type: 'bulletList', content: [item('listItem', 'A nested point')] }] })] },
    { type: 'orderedList', attrs: { start: 3 }, content: [item('listItem', 'Third step'), item('listItem', 'Fourth step')] },
    { type: 'taskList', content: [item('taskItem', 'Pack the tent', { attrs: { checked: true } }), item('taskItem', 'Charge the lamp', { attrs: { checked: false } })] },
    { type: 'blockquote', content: [para(t('A quoted line'))] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [t('const x = 1;\nconsole.log(x);')] },
    { type: 'horizontalRule' },
    para(t('Line one'), { type: 'hardBreak' }, t('line two')),
    { type: 'paragraph', attrs: { color: 'amber' }, content: [t('A callout in amber')] },
    { type: 'heading', attrs: { level: 3 }, content: [t('Special characters')] },
    para(t('Ampersand & angle <b> and "quotes" and a 😀 and ünïcödé')),
  ],
};

/** `toMarkdown`'s rules (`web/notebook/src/model/export.ts`), written out by hand, with each color's value as #COLOR. */
const RICH_MD = [
  `# ${TITLE}`,
  `Plain words, then **bold**, _italic_, ~~struck~~, <u>underlined</u>, \`inline code\` and [a link](${LINK}).`,
  'Marked <mark style="background-color: #COLOR">in green</mark> and <span style="color: #COLOR">rose text</span>.',
  '## A violet heading',
  '- First point\n- Second point\n  - A nested point',
  '3. Third step\n4. Fourth step',
  '- [x] Pack the tent\n- [ ] Charge the lamp',
  '> A quoted line',
  '```js\nconst x = 1;\nconsole.log(x);\n```',
  '---',
  'Line one\\\nline two',
  'A callout in amber',
  '### Special characters',
  'Ampersand & angle \\<b\\> and "quotes" and a 😀 and ünïcödé',
].join('\n\n') + '\n';

/**
 * A long page, typed and pasted in the window as a member would: plain paragraphs, about 800 KB as the desk's JSON, so it comes
 * back in two parts. (An import that size can't go: this RPC client sends a request as one data channel message, unlike the app.)
 */
const LONG_TITLE = `Long export check ${MARKER}`;
const LONG_PASTE = Array.from({ length: 3500 }, (_, i) => `Paragraph ${i + 1} of the long export check, with words enough to fill a line or two of a printed page, and a number at the end: ${(i * 7919) % 10007}.`);
const LONG_LINES = [LONG_TITLE, ...LONG_PASTE];
const LONG_MD = `# ${LONG_TITLE}\n\n${LONG_PASTE.join('\n\n')}\n`;

/**
 * The page's text as lines, as a browser shows it: one per text block, a hard break or a code line starting another. With
 * `numbers`, an ordered list's items start with their number, as a printed page has them in its text.
 */
function linesOf(doc: PMNode, numbers = false): string[] {
  const out: string[] = [];
  const walk = (n: PMNode, lead = ''): void => {
    if (['paragraph', 'heading', 'codeBlock'].includes(n.type)) {
      const text = (n.content ?? []).map((c) => (c.type === 'hardBreak' ? '\n' : (c.text ?? ''))).join('');
      out.push(...text.split('\n').map((l, i) => (i === 0 ? lead + l : l)));
      return;
    }
    const start = Number(n.attrs?.['start'] ?? 1);
    (n.content ?? []).forEach((c, i) => walk(c, numbers && n.type === 'orderedList' ? `${start + i}.` : i === 0 ? lead : ''));
  };
  walk(doc);
  return out.map((l) => l.trim()).filter(Boolean);
}
const textLines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Everything the input says is in what the desk gives back: the same blocks, text and marks, with no attribute lost. */
function keeps(input: PMNode, back: PMNode, path = 'doc'): string[] {
  const out: string[] = [];
  if (input.type !== back.type) return [`${path}: ${input.type} became ${back.type}`];
  if (input.text !== back.text) out.push(`${path}: text differs`);
  for (const [k, v] of Object.entries(input.attrs ?? {})) if (v !== null && JSON.stringify(back.attrs?.[k]) !== JSON.stringify(v)) out.push(`${path}: attr ${k}`);
  const marks = (n: PMNode) => (n.marks ?? []).map((m) => m.type).sort().join(',');
  if (marks(input) !== marks(back)) out.push(`${path}: marks ${marks(input)} became ${marks(back)}`);
  for (const m of input.marks ?? []) {
    const b = back.marks?.find((x) => x.type === m.type);
    for (const [k, v] of Object.entries(m.attrs ?? {})) if (JSON.stringify(b?.attrs?.[k]) !== JSON.stringify(v)) out.push(`${path}: ${m.type}.${k}`);
  }
  const kids = input.content ?? [];
  if (kids.length !== (back.content ?? []).length) return [...out, `${path}: ${kids.length} children became ${(back.content ?? []).length}`];
  kids.forEach((c, i) => out.push(...keeps(c, (back.content ?? [])[i] as PMNode, `${path}/${i}:${c.type}`)));
  return out;
}

/**
 * The text of a PDF that Chromium printed (Skia's writer): each page's runs by their place, through each font's ToUnicode map.
 * Enough to read back what a print holds; not a general PDF reader.
 */
function pdfText(pdf: Buffer): string[] {
  const s = pdf.toString('latin1');
  const objects = new Map<string, { dict: string; stream: Buffer | null }>();
  for (const m of s.matchAll(/(\d+) 0 obj\b([\s\S]*?)endobj/g)) {
    const body = m[2] as string;
    const at = body.search(/stream\r?\n/);
    if (at < 0) {
      objects.set(m[1] as string, { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, at);
    let raw = Buffer.from(body.slice(at + (body[at + 6] === '\r' ? 8 : 7), body.lastIndexOf('endstream')).replace(/\r?\n$/, ''), 'latin1');
    if (/\/FlateDecode/.test(dict)) raw = inflateSync(raw);
    objects.set(m[1] as string, { dict, stream: raw });
  }
  const utf16 = (hex: string): string => String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));
  const cmaps = new Map<string, Map<number, string>>();
  const cmapOf = (fontRef: string): Map<number, string> => {
    const known = cmaps.get(fontRef);
    if (known) return known;
    const map = new Map<number, string>();
    cmaps.set(fontRef, map);
    const ref = /\/ToUnicode (\d+) 0 R/.exec(objects.get(fontRef)?.dict ?? '')?.[1];
    const text = ref ? (objects.get(ref)?.stream?.toString('latin1') ?? '') : '';
    for (const b of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of (b[1] as string).matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(p[1] as string, 16), utf16(p[2] as string));
    for (const b of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const r of (b[1] as string).matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
        const lo = parseInt(r[1] as string, 16);
        const hi = parseInt(r[2] as string, 16);
        const dst = r[3] as string;
        if (dst.startsWith('[')) [...dst.matchAll(/<([0-9A-Fa-f]+)>/g)].forEach((d, i) => map.set(lo + i, utf16(d[1] as string)));
        else {
          const units = (dst.slice(1, -1).match(/.{4}/g) ?? []).map((h) => parseInt(h, 16));
          for (let c = lo; c <= hi; c += 1) map.set(c, String.fromCharCode(...units.slice(0, -1), (units.at(-1) as number) + c - lo));
        }
      }
    }
    return map;
  };
  const kids = /\/Kids \[([^\]]*)\]/.exec([...objects.values()].find((o) => /\/Type \/Pages\b/.test(o.dict))?.dict ?? '')?.[1] ?? '';
  return [...kids.matchAll(/(\d+) 0 R/g)].map((k) => {
    const dict = objects.get(k[1] as string)?.dict ?? '';
    const fonts = new Map([...(/\/Font <<([^>]*)>>/.exec(dict)?.[1] ?? '').matchAll(/\/(\w+) (\d+) 0 R/g)].map((f) => [f[1] as string, f[2] as string]));
    const contents = [...(/\/Contents (\[[^\]]*\]|\d+ 0 R)/.exec(dict)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((c) => objects.get(c[1] as string)?.stream?.toString('latin1') ?? '').join('\n');
    const runs: { x: number; y: number; text: string }[] = [];
    let font = '';
    let x = 0;
    let y = 0;
    for (const m of contents.matchAll(/\/(\w+) [\d.]+ Tf|1 0 0 -1 (-?[\d.]+) (-?[\d.]+) Tm|<([0-9A-Fa-f]*)> Tj|\[([^\]]*)\] TJ/g)) {
      if (m[1]) font = fonts.get(m[1]) ?? '';
      else if (m[2] !== undefined) [x, y] = [Number(m[2]), Number(m[3])];
      else {
        const hex = m[4] ?? [...(m[5] ?? '').matchAll(/<([0-9A-Fa-f]*)>/g)].map((h) => h[1]).join('');
        const map = cmapOf(font);
        // A Type0 font's codes are two bytes; a Type3 one's (a web font such as the window's Inter) are one.
        const width = /\/Subtype \/Type0\b/.test(objects.get(font)?.dict ?? '') ? 4 : 2;
        runs.push({ x, y, text: (hex.match(new RegExp(`.{${width}}`, 'g')) ?? []).map((g) => map.get(parseInt(g, 16)) ?? '�').join('') });
      }
    }
    const lines = new Map<number, typeof runs>();
    for (const r of runs) (lines.get(Math.round(r.y)) ?? lines.set(Math.round(r.y), []).get(Math.round(r.y)))?.push(r);
    return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, rs]) => rs.sort((a, b) => a.x - b.x).map((r) => r.text).join('')).join('\n');
  });
}

let context: BrowserContext;
let rpcPage: Page;
let client: DeskClient;
const made: { rich?: string; long?: string } = {};

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const bearer = await apiToken(context, loadUser('desk-1'));
  rpcPage = await context.newPage();
  await rpcPage.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
  await rpcPage.goto(`${APP}${FIXTURE_PATH}`);
  client = new DeskClient(rpcPage, bearer, randomBytes(3).toString('hex'));
  await client.init();
  let opened: OpenResult = { ok: false };
  for (let i = 0; i < 12 && !opened.ok; i++) {
    opened = await client.open(false);
    if (!opened.ok) await sleep(5000);
  }
  if (!opened.ok) throw new Error(`no session: ${JSON.stringify({ step: opened.step, code: opened.code })}`);
});
test.afterAll(async () => {
  for (const id of [made.rich, made.long]) if (id) await client?.rpcTry('notebook.page.trash', { pageId: id }, { idem: true });
  note('test pages trashed', Object.values(made).length);
  await client?.finish().catch(() => {});
  await context?.close();
});

/** A page's JSON as the window reads it (`DeskBackend.pageContent`): parts joined until `next` is null. */
async function content(pageId: string): Promise<{ doc: PMNode; parts: number }> {
  let text = '';
  let cursor: string | null = null;
  let parts = 0;
  do {
    const r: { part: string; next: string | null } = await client.rpc('notebook.page.content', { pageId, ...(cursor ? { cursor } : {}) });
    text += r.part;
    cursor = r.next;
    parts += 1;
  } while (cursor);
  return { doc: JSON.parse(text) as PMNode, parts };
}

test('the desk keeps every block, mark and color an export reads', async () => {
  test.setTimeout(5 * 60_000);
  type Tree = { notebooks: { id: string; title: string }[]; tabs: { id: string; notebookId: string }[] };
  const tree: Tree = await client.rpc('notebook.tree');
  let notebook = tree.notebooks.find((n) => n.title === 'Export check');
  let tabId = notebook ? tree.tabs.find((x) => x.notebookId === notebook?.id)?.id : undefined;
  if (!tabId) {
    const nb: { notebook: { id: string; title: string }; tab: { id: string } } = await client.rpc('notebook.notebook.create', { title: 'Export check' }, { idem: true });
    notebook = nb.notebook;
    tabId = nb.tab.id;
  }
  note('notebook', { reused: tree.notebooks.some((n) => n.id === notebook?.id) });
  const richId = (await client.rpc<{ page: { id: string } }>('notebook.page.import', { tabId, doc: RICH }, { idem: true })).page.id;
  made.rich = richId;
  const rich = await content(richId);
  const lost = keeps(RICH, rich.doc);
  note('rich page read back', { parts: rich.parts, lost });
  expect(lost).toEqual([]);
});

test("the Notebook window exports Markdown and a web page and prints, and what comes out is the page's text", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  expect(made.rich).toBeTruthy();
  const desk = { rich: (await content(made.rich as string)).doc };
  const page = await context.newPage();
  const w: Watch = watch(page);
  // The window opens on this page (its own UI state, `ma.notebook.ui.<desk>`), and the browser's print dialog is a counter.
  await context.addInitScript(
    ({ key, pageId, origin }) => {
      if (location.origin !== origin) return;
      try {
        localStorage.setItem(key, JSON.stringify({ view: 'tabs', sel: { pageId } }));
      } catch {
        /* the window then opens on another page, and the test says so */
      }
      const win = window as unknown as { __prints: number; print: () => void };
      win.__prints = 0;
      win.print = () => {
        win.__prints += 1;
      };
    },
    { key: `ma.notebook.ui.${DESK_ID}`, pageId: made.rich as string, origin: APP },
  );
  await signInApp(context, page, loadUser('desk-1'));
  await focusTestDesk(page, w);
  const deskProxy = page.locator(`[id="proxy-${DESK_ID}"]`);
  await deskProxy.focus();
  await page.keyboard.press('Enter');
  await sleep(1500);
  const tile = page.locator(`[id="proxy-${DESK_ID}:notebook"]`);
  await tile.focus();
  await page.keyboard.press('Enter');
  const win = page.getByRole('dialog', { name: /Notebook/ }).first();
  await win.waitFor({ state: 'visible', timeout: 30_000 });
  const editor = win.getByTestId('note-editor');
  await expect(editor, 'the window opens on the test page').toContainText(MARKER, { timeout: 120_000 });
  note('window open on the page', true);

  const exported = async (label: string): Promise<{ name: string; text: string; path: string }> => {
    await win.getByRole('button', { name: 'Page actions' }).first().click();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByRole('menuitem', { name: label }).click()]);
    const path = test.info().outputPath(dl.suggestedFilename().replace(/[^\w.-]+/g, '_'));
    await dl.saveAs(path);
    return { name: dl.suggestedFilename(), text: readFileSync(path, 'utf8'), path };
  };

  /** Opens an exported web page as a file, alone, and reads what a reader sees. Nothing but the file may load. */
  const openHtml = async (path: string) => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const requests: string[] = [];
    p.on('request', (r) => requests.push(r.url()));
    await p.goto(pathToFileURL(path).href);
    const seen = await p.evaluate(() => ({
      title: document.title,
      text: (document.querySelector('main') as HTMLElement).innerText,
      tags: {
        strong: document.querySelectorAll('main strong').length,
        em: document.querySelectorAll('main em').length,
        s: document.querySelectorAll('main s').length,
        u: document.querySelectorAll('main u').length,
        code: document.querySelectorAll('main p code').length,
        link: document.querySelector('main a')?.getAttribute('href') ?? null,
        mark: document.querySelector('main mark')?.getAttribute('data-color') ?? null,
        markPainted: document.querySelector('main mark') ? getComputedStyle(document.querySelector('main mark') as Element).backgroundColor : null,
        textColor: document.querySelector('main [data-text-color]')?.getAttribute('data-text-color') ?? null,
        h2Color: document.querySelector('main h2')?.getAttribute('data-block-color') ?? null,
        callout: document.querySelector('main p[data-block-color]')?.getAttribute('data-block-color') ?? null,
        olStart: document.querySelector('main ol')?.getAttribute('start') ?? null,
        tasksDone: document.querySelectorAll('main li.task.done input[checked]').length,
        tasksOpen: document.querySelectorAll('main li.task:not(.done)').length,
        nested: document.querySelectorAll('main ul ul li').length,
        quote: document.querySelectorAll('main blockquote').length,
        pre: document.querySelector('main pre code')?.textContent ?? null,
        hr: document.querySelectorAll('main hr').length,
        br: document.querySelectorAll('main br').length,
      },
    }));
    await ctx.close();
    return { ...seen, requests };
  };

  // Markdown
  const md = await exported('Markdown (.md)');
  const mdNormal = md.text.replace(/#[0-9a-fA-F]{6}\b/g, '#COLOR');
  note('Markdown', { name: md.name === `${TITLE}.md`, bytes: Buffer.byteLength(md.text), exact: mdNormal === RICH_MD });
  expect(md.name).toBe(`${TITLE}.md`);
  expect(mdNormal).toBe(RICH_MD);

  // A web page
  const html = await exported('Web page (.html)');
  const h = await openHtml(html.path);
  note('web page', { name: html.name === `${TITLE}.html`, bytes: Buffer.byteLength(html.text), requests: h.requests.length, tags: h.tags, title: h.title === TITLE });
  expect(html.name).toBe(`${TITLE}.html`);
  expect(h.title).toBe(TITLE);
  expect(textLines(h.text)).toEqual(linesOf(desk.rich));
  expect(h.requests).toEqual([pathToFileURL(html.path).href]);
  expect(h.tags).toMatchObject({ strong: 1, em: 1, s: 1, u: 1, code: 1, link: LINK, mark: 'green', textColor: 'rose', h2Color: 'violet', callout: 'amber', olStart: '3', tasksDone: 1, tasksOpen: 1, nested: 1, quote: 1, pre: 'const x = 1;\nconsole.log(x);', hr: 1, br: 1 });
  expect(h.tags.markPainted).not.toBe('rgba(0, 0, 0, 0)');

  // Print, as the menu does it: the page read again from the desk into a print view, then the browser's print.
  await win.getByRole('button', { name: 'Page actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Print or save as PDF' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints), { timeout: 30_000 }).toBe(1);
  await page.emulateMedia({ media: 'print' });
  // What prints, as text: TipTap's task items carry a label clipped to nothing for screen readers ("Task item checkbox for …"),
  // which innerText counts and paper never shows, so it's left out for the reading and put back.
  const printed = await page.evaluate(() => {
    const hidden = [...document.querySelectorAll<HTMLElement>('.nb-print *')].filter((el) => getComputedStyle(el).clip === 'rect(0px, 0px, 0px, 0px)');
    for (const el of hidden) el.style.setProperty('display', 'none');
    const text = document.body.innerText;
    for (const el of hidden) el.style.removeProperty('display');
    return text;
  });
  const pdf = await page.pdf({ format: 'Letter', printBackground: true });
  writeFileSync(test.info().outputPath(`${made.rich}-print.pdf`), pdf);
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.getByTestId('print-view'), 'the print view goes after printing').toHaveCount(0, { timeout: 10_000 });
  // The PDF's own text: list numbers are text there, bullets and boxes are drawn. Spaces aren't compared, as a line wraps where
  // the paper says.
  const pdfPages = pdfText(pdf);
  const bare = (s: string): string => s.replace(/[\s•◦▪]+/g, '');
  const pdfSaid = bare(pdfPages.join(''));
  const pdfMatches = pdfSaid === bare(linesOf(desk.rich, true).join('')) || pdfSaid === bare(linesOf(desk.rich).join(''));
  note('print', { lines: textLines(printed).length, pdfBytes: pdf.length, pdfPages: pdfPages.length, onlyThePage: squash(printed) === squash(linesOf(desk.rich).join(' ')), pdfMatches });
  if (!pdfMatches) writeFileSync(test.info().outputPath(`${made.rich}-print.txt`), pdfPages.join('\n\f\n'));
  // Under print, the page is all there is: none of the office, the window or its menus.
  expect(squash(printed)).toBe(squash(linesOf(desk.rich).join(' ')));
  expect(pdfMatches).toBe(true);

  // The long page: a new page in the same tab, its title typed and its paragraphs pasted, saved, then read back from the desk.
  await win.getByTestId('new-page').click();
  const focused = await page
    .waitForFunction(() => Boolean(document.activeElement?.closest('[data-testid="note-editor"]')) && document.activeElement?.getAttribute('contenteditable') === 'true', undefined, { timeout: 10_000 })
    .then(() => true, () => false);
  if (!focused) await editor.click();
  const current = win.locator('.nb-page-btn[aria-current="true"]');
  await expect.poll(async () => (await current.getAttribute('data-page-id').catch(() => null)) ?? made.rich, { timeout: 20_000 }).not.toBe(made.rich);
  made.long = (await current.getAttribute('data-page-id')) ?? undefined;
  expect(made.long, 'the new page is in the list').toBeTruthy();
  await page.keyboard.type(LONG_TITLE);
  await page.keyboard.press('Enter');
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.querySelector('[data-testid="note-editor"]')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, LONG_PASTE.join('\n'));
  await expect(editor).toContainText(LONG_PASTE.at(-1) as string, { timeout: 60_000 });
  // "Not saved yet." shows after 2 s without the desk's word; its absence for a while after is the desk's answer.
  const line = win.getByTestId('notebook-line');
  await expect(line).toBeHidden({ timeout: 90_000 });
  await sleep(4_000);
  await expect(line).toBeHidden({ timeout: 60_000 });
  await sleep(12_000); // the store's debounce, so a closed read is the stored page too
  const long = await content(made.long as string);
  note('long page read back', { parts: long.parts, bytes: Buffer.byteLength(JSON.stringify(long.doc)), lines: linesOf(long.doc).length, same: JSON.stringify(linesOf(long.doc)) === JSON.stringify(LONG_LINES) });
  expect(long.parts).toBeGreaterThan(1);
  expect(linesOf(long.doc)).toEqual(LONG_LINES);
  const longMd = await exported('Markdown (.md)');
  note('long Markdown', { bytes: Buffer.byteLength(longMd.text), exact: longMd.text === LONG_MD });
  expect(longMd.name).toBe(`${LONG_TITLE}.md`);
  expect(longMd.text).toBe(LONG_MD);
  const longHtml = await exported('Web page (.html)');
  const lh = await openHtml(longHtml.path);
  note('long web page', { bytes: Buffer.byteLength(longHtml.text), lines: textLines(lh.text).length });
  expect(textLines(lh.text)).toEqual(LONG_LINES);
  note('console errors', w.errors.length);
});

test("notebook.activity: a reply says next, a cursor carries on from a row, and one that isn't the desk's is refused", async () => {
  type Row = { pageId: string; day: string };
  const first = await client.rpcTry('notebook.activity', { fromDay: '0000-01-01', toDay: '9999-12-31' });
  const r = first as unknown as { ok: boolean; result?: { rows: Row[]; next?: string | null } };
  expect(r.ok).toBe(true);
  const rows = r.result?.rows ?? [];
  const paged = r.result !== undefined && 'next' in r.result;
  note('notebook.activity', { rows: rows.length, hasNext: paged, next: r.result?.next ?? null, bytes: Buffer.byteLength(JSON.stringify(r.result)) });
  test.skip(!paged, 'this desk-notebook is older than paging: no next in its reply');
  const ordered = rows.every((x, i) => i === 0 || (rows[i - 1] as Row).day > x.day || ((rows[i - 1] as Row).day === x.day && (rows[i - 1] as Row).pageId > x.pageId));
  expect(ordered).toBe(true);
  expect(rows.length).toBeGreaterThan(2);
  // The cursor is the last row's day and page id (services/notebook/README.md): from row k, the rest follow exactly.
  const k = Math.floor(rows.length / 2);
  const from = rows[k] as Row;
  const rest: { rows: Row[]; next: string | null } = await client.rpc('notebook.activity', { fromDay: '0000-01-01', toDay: '9999-12-31', cursor: `a:${from.day}:${from.pageId}` });
  note('from a cursor', { rows: rest.rows.length, expected: rows.length - k - 1, next: rest.next });
  expect(rest.rows).toEqual(rows.slice(k + 1));
  const bad = await client.rpcTry('notebook.activity', { fromDay: '0000-01-01', toDay: '9999-12-31', cursor: 'not-a-cursor' });
  note('a cursor that is not one', { ok: bad.ok, code: bad.code, details: bad.details });
  expect(bad.ok).toBe(false);
  expect(bad.code).toBe('bad_request');
  expect(bad.details).toEqual({ reason: 'cursor' });
});
