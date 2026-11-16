// The pure parts of the Agent tools' real-desk scripts: no browser, no AWS, no file system. Unit tested by
// `*.test.mjs` beside this file (`node --test`). The driver, the cases and both scripts build on these.

/** The driver's whole world: a Files folder and a Notebook tab of this name. Nothing outside them is touched. */
export const HARNESS_DIR = 'Harness';
export const HARNESS_TAB = 'Harness';

// ------------------------------------------------------------------ guards

/** A Files path inside `Harness/`, as Files names it (no leading slash, no dots, no backslash). Throws otherwise. */
export function harnessPath(path) {
  if (typeof path !== 'string') throw new Error('refusing: a path must be a string');
  const p = path.endsWith('/') ? path.slice(0, -1) : path;
  const parts = p.split('/');
  if (parts[0] !== HARNESS_DIR) throw new Error(`refusing: ${JSON.stringify(path)} is outside ${HARNESS_DIR}/`);
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('\\')) throw new Error(`refusing: ${JSON.stringify(path)} isn't a plain path`);
  }
  return p;
}

export const isHarnessPath = (path) => {
  try {
    harnessPath(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * The only methods the page's injector may send. Files and Notebook: the ones those apps already call (`web/src/apps/files/api.ts`,
 * `web/src/notebook/deskBackend.ts`). Timing only: the reply never leaves the page, only how long it took and its error code.
 */
export const INJECT = {
  files: ['files.list', 'files.stat', 'files.mkdir', 'files.delete', 'files.trash.list', 'files.upload.begin', 'files.upload.finish', 'files.upload.abort', 'files.read', 'files.read.stop'],
  notebook: ['notebook.tree', 'notebook.tab.create', 'notebook.page.import', 'notebook.page.content', 'notebook.page.trash', 'notebook.page.agentEdits', 'notebook.page.agentUndo'],
  timingOnly: ['agent.approvals.list', 'harness.noop'],
  mutations: ['files.mkdir', 'files.delete', 'files.upload.begin', 'files.upload.finish', 'files.upload.abort', 'notebook.tab.create', 'notebook.page.import', 'notebook.page.trash', 'notebook.page.agentUndo'],
};

/** `full` hands the result to Node (Files and Notebook only), `timing` only {ms, ok, code}. */
export function allowedMethod(method, mode) {
  if (mode === 'timing') return INJECT.timingOnly.includes(method) || INJECT.files.includes(method) || INJECT.notebook.includes(method);
  if (mode === 'full') return INJECT.files.includes(method) || INJECT.notebook.includes(method);
  return false;
}

/** The run's preconditions: refuse unless run under the lock (the variable, and the file's probe when given) and, where the key is needed, with the key's parameter named. */
export function preconditions(env, { needKey = true, lock } = {}) {
  const problems = [];
  if (env.MA_TEST_DESK_LOCK !== 'held') problems.push('not under the test desk lock: run it as the README says (flock ~/work/.test-desk.lock env MA_TEST_DESK_LOCK=held ...)');
  // The lock file itself, probed by the caller (lock.mjs): unless it's held, refused (Security's MMH-I2).
  else if (lock !== undefined && lock !== 'held') problems.push(`the test desk lock isn't held (${lock}): run it under flock ~/work/.test-desk.lock`);
  const param = env.MA_AGENT_TEST_KEY_PARAM || null;
  const good = param !== null && /^\/ma\/staging\/[A-Za-z0-9_./-]+$/.test(param) && !param.includes('..');
  if (param !== null && !good) problems.push('MA_AGENT_TEST_KEY_PARAM must name a parameter under /ma/staging/');
  if (needKey && param === null) problems.push("MA_AGENT_TEST_KEY_PARAM isn't set: it names the capped staging model key's SSM parameter");
  return { ok: problems.length === 0, problems, keyParam: good ? param : null };
}

/** Every secret out of a line: each one as it is, and the parts of it a log might cut it into. */
export function redactor(secrets) {
  const list = [...secrets].filter((s) => typeof s === 'string' && s.length >= 8);
  return (line) => {
    let s = String(line);
    for (const x of list) s = s.split(x).join('[redacted]');
    return s;
  };
}

// ------------------------------------------------------------------ the canary and the vars

/** One a run, `mmcanary-<16 hex>`, as the contract says. */
export const makeCanary = (hex16) => `mmcanary-${hex16}`;

/** World text with the canary on its own last line. */
export const withCanary = (text, canary) => `${String(text).replace(/\n+$/, '')}\n${canary}\n`;

/** Text with every line that is exactly the canary taken out, and the trailing newlines it leaves. */
export function stripCanary(text, canary) {
  return String(text)
    .split('\n')
    .filter((l) => l.trim() !== canary)
    .join('\n')
    .replace(/\n+$/, '');
}

/** `{name}` in every string of a value, from `vars`. Regexes, numbers and booleans stay as they are. */
export function fill(value, vars) {
  if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value instanceof RegExp || value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [fill(k, vars), fill(v, vars)]));
}

// ------------------------------------------------------------------ the card, read off the page

/**
 * The Tool row ("App · Name") of each tool this app has a card template for (`web/agent/src/model/approvals.ts`, TOOLS). A tool
 * the app doesn't know shows its wire name in that row, which is read as it is.
 */
export const TOOL_ROWS = {
  'Files · Save a file': 'files_write',
  'Files · Make a folder': 'files_mkdir',
  'Files · Move a file': 'files_move',
  'Files · Move a file to Trash': 'files_trash',
  'Notebook · Write in a page': 'notebook_write',
  'Notebook · Move a page to Trash': 'notebook_trash',
  'Browser · Open a page': 'browser_open',
  'Browser · Click': 'browser_click',
  'Browser · Press a key': 'browser_press',
  'Browser · Type': 'browser_type',
  'Browser · Use your signed-in session': 'browser_use_my_session',
  'Browser · Go back a page': 'browser_back',
  'Agent · Set a follow-up': 'follow_up',
  'Memory · Save a memory': 'memory_save',
};

/** The words the card shows for an untrusted run: the line, or the taint note in its place (`NOTE_TEXT`). */
export const UNTRUSTED_WORDS = ['This agent has read web pages, files or messages in this task.', 'It asks because this task has read', 'It asks because this task read a web page'];

const unquote = (s) => {
  const m = /^[“"](.*)[”"]$/.exec(String(s ?? '').trim());
  return m ? m[1] : String(s ?? '');
};

/**
 * One card as the page shows it: `{title, level, state, rows: [{label, value}], untrustedLine, note}`, read by the driver from
 * `[data-testid="approval"]`. The payload is put back together from the rows, by the tool's template. A pending card has its
 * fields in view; a decided one keeps them under "What it was".
 */
export function parseCard(raw) {
  const rows = Array.isArray(raw?.rows) ? raw.rows : [];
  const row = (label) => rows.find((r) => r.label === label)?.value ?? null;
  const toolRow = row('Tool') ?? '';
  const tool = TOOL_ROWS[toolRow] ?? (toolRow.includes(' · ') ? null : toolRow || null);
  const title = String(raw?.title ?? '');
  const payload = {};
  switch (tool) {
    case 'files_write':
      payload.path = row('File');
      payload.text = row('Text');
      if (row('Replaces') !== null || title.startsWith('Replace ')) payload.replace = true;
      break;
    case 'files_mkdir':
      payload.path = row('Folder');
      break;
    case 'files_move':
      payload.from = row('From');
      payload.to = row('To');
      break;
    case 'files_trash':
      payload.path = row('File');
      break;
    case 'notebook_write': {
      const made = /^Make the page (.+) in Notebook$/.exec(title);
      if (made) {
        payload.op = 'create';
        payload.new = { title: unquote(made[1]) };
      } else if (title.startsWith('Change text in ')) {
        payload.op = 'replace_text';
        payload.find = row('Find');
      } else payload.op = 'append';
      if (payload.op !== 'create') payload.page = row('Page');
      payload.markdown = row('Text') ?? row('Replace with');
      break;
    }
    case 'notebook_trash':
      payload.page = row('Page');
      break;
    case 'browser_open':
      payload.url = row('Address');
      break;
    case 'browser_click':
      payload.what = row('What');
      payload.origin = row('Site');
      break;
    case 'browser_type':
      payload.into = row('Into');
      payload.text = row('Text');
      payload.origin = row('Site');
      break;
    case 'browser_press':
      payload.key = row('Key');
      payload.in = row('In');
      payload.origin = row('Site');
      break;
    case 'browser_use_my_session':
      payload.site = row('Site');
      break;
    default:
      for (const r of rows) if (r.label !== 'Tool' && r.label !== 'Uses') payload[r.label] = r.value;
  }
  const note = raw?.note ? String(raw.note) : null;
  const untrusted = Boolean(raw?.untrustedLine) || (note !== null && UNTRUSTED_WORDS.some((w) => note.includes(w)));
  return {
    tool,
    title,
    level: raw?.level ?? null,
    state: raw?.state ?? null,
    untrusted,
    memberSession: row('Uses'),
    payload,
    rows,
  };
}

/**
 * The page's cards beside the wire's approvals (ids, run, hash, risk, untrusted; never a payload or a title). Both are oldest first
 * for one agent's thread; a pair must agree on the tool. A card the wire hasn't sent yet, or the other way round, stays unpaired.
 */
export function pairCards(domCards, wire) {
  const left = [...wire].sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  const out = [];
  for (const card of domCards) {
    const i = left.findIndex((w) => (card.tool === null || w.tool === card.tool) && (card.state === null || stateFits(card.state, w.state)));
    if (i < 0) {
      out.push({ ...card, id: null, paired: false });
      continue;
    }
    const w = left.splice(i, 1)[0];
    out.push({ ...card, id: w.id, runId: w.runId, sha256: w.sha256, risk: w.risk, wireUntrusted: w.untrusted, wireState: w.state, result: w.result ?? null, createdAt: w.createdAt, paired: true });
  }
  return out;
}

/** The page's `data-state` against the wire's: the page can be a step behind (a card still drawn pending or approved). */
function stateFits(page, wire) {
  if (page === wire) return true;
  if (page === 'pending') return wire === 'pending' || wire === 'approved';
  if (page === 'approved') return wire === 'done' || wire === 'failed' || wire === 'interrupted';
  return false;
}

// ------------------------------------------------------------------ Notebook pages: Markdown in, text out

const textNode = (t) => (t ? [{ type: 'text', text: t }] : undefined);
const para = (t) => {
  const content = textNode(t);
  return content ? { type: 'paragraph', content } : { type: 'paragraph' };
};

/**
 * A page for `notebook.page.import`, from the little Markdown a world uses: `#`, `##`, `###`, `- ` and `* ` lists, `1. ` lists,
 * `- [ ] ` and `- [x] ` checklists, and paragraphs. The first line is the page's title, an h1, as a new page starts
 * (`BLANK_PAGE` in `web/notebook/src/model/schema.ts`); a body that doesn't start with `# <title>` gets one.
 */
export function mdToDoc(title, markdown) {
  const lines = String(markdown ?? '').split('\n');
  const blocks = [];
  let list = null;
  const flush = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) {
      flush();
      continue;
    }
    if ((m = /^(#{1,3}) (.*)$/.exec(line))) {
      flush();
      blocks.push({ type: 'heading', attrs: { level: m[1].length }, ...(textNode(m[2]) ? { content: textNode(m[2]) } : {}) });
    } else if ((m = /^[-*] \[( |x)\] (.*)$/i.exec(line))) {
      if (list?.type !== 'taskList') flush();
      list ??= { type: 'taskList', content: [] };
      list.content.push({ type: 'taskItem', attrs: { checked: m[1].toLowerCase() === 'x' }, content: [para(m[2])] });
    } else if ((m = /^[-*] (.*)$/.exec(line))) {
      if (list?.type !== 'bulletList') flush();
      list ??= { type: 'bulletList', content: [] };
      list.content.push({ type: 'listItem', content: [para(m[1])] });
    } else if ((m = /^\d+\. (.*)$/.exec(line))) {
      if (list?.type !== 'orderedList') flush();
      list ??= { type: 'orderedList', attrs: { start: 1 }, content: [] };
      list.content.push({ type: 'listItem', content: [para(m[1])] });
    } else {
      flush();
      blocks.push(para(line));
    }
  }
  flush();
  const first = blocks[0];
  const titled = first?.type === 'heading' && first.attrs.level === 1 && first.content?.[0]?.text === title;
  if (!titled) blocks.unshift({ type: 'heading', attrs: { level: 1 }, content: textNode(title) ?? [] });
  return { type: 'doc', content: blocks };
}

/** A page's ProseMirror JSON as Markdown-ish lines: enough for `contains` checks, not the desk's exact Markdown. */
export function docToText(doc) {
  const out = [];
  const inline = (n) => (n?.type === 'text' ? (n.text ?? '') : n?.type === 'hardBreak' ? '\n' : (n?.content ?? []).map(inline).join(''));
  const block = (n, prefix = '') => {
    if (!n) return;
    switch (n.type) {
      case 'heading':
        out.push(`${'#'.repeat(n.attrs?.level ?? 1)} ${inline(n)}`);
        break;
      case 'paragraph':
        out.push(prefix + inline(n));
        break;
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        (n.content ?? []).forEach((item, i) => {
          const mark = n.type === 'orderedList' ? `${i + 1}. ` : n.type === 'taskList' ? `- [${item.attrs?.checked ? 'x' : ' '}] ` : '- ';
          (item.content ?? []).forEach((c, j) => block(c, j === 0 ? prefix + mark : `${prefix}  `));
        });
        break;
      case 'blockquote':
        (n.content ?? []).forEach((c) => block(c, `${prefix}> `));
        break;
      case 'codeBlock':
        out.push('```', inline(n), '```');
        break;
      case 'horizontalRule':
        out.push('---');
        break;
      default:
        (n.content ?? []).forEach((c) => block(c, prefix));
    }
  };
  (doc?.content ?? []).forEach((c) => block(c));
  return out.join('\n');
}

// ------------------------------------------------------------------ checks

const lc = (s) => String(s ?? '').toLowerCase();
const has = (hay, needle) => lc(hay).includes(lc(needle));

/**
 * A case's checks against what the desk shows after its run. `state` is
 * `{files: {path: text|null}, trash: [name], pages: [{tab, title, text, trashed}], reply: {state, text, untrusted, untrustedShown,
 * chips: [{name, words, session, approvalId}], summary}, cards: [parsed and paired], wireCards: [{tool, state, result, untrusted}],
 * audit: [{seq, action, decision, canaryHit}], canary}`. Each check gives `{kind, ok, detail}`.
 */
export function runChecks(checks, state) {
  const canary = state.canary ?? '';
  const clean = (t) => (t == null ? t : stripCanary(t, canary));
  const pagesIn = (tab, title) => (state.pages ?? []).filter((p) => p.tab === tab && p.title === title && !p.trashed);
  return (checks ?? []).map((c) => {
    const r = (ok, detail = '') => ({ kind: c.kind, ok: Boolean(ok), detail, label: c.label ?? describeCheck(c) });
    switch (c.kind) {
      case 'file': {
        const t = state.files?.[c.path];
        if (t == null) return r(false, `${c.path} isn't there`);
        const text = clean(t);
        if (c.equals != null && text !== stripCanary(c.equals, canary)) return r(false, `${c.path} differs (${text.length} characters)`);
        const missing = (c.contains ?? []).filter((x) => !text.includes(x));
        const extra = (c.notContains ?? []).filter((x) => text.includes(x));
        return r(!missing.length && !extra.length, missing.length ? `missing ${JSON.stringify(missing)}` : extra.length ? `has ${JSON.stringify(extra)}` : '');
      }
      case 'noFile':
        return r(!(c.path in (state.files ?? {})), c.path in (state.files ?? {}) ? `${c.path} is there` : '');
      case 'trashed':
        return r((state.trash ?? []).includes(c.name), `trash holds ${JSON.stringify(state.trash ?? [])}`);
      case 'notTrashed':
        return r(!(state.trash ?? []).includes(c.name), `trash holds ${JSON.stringify(state.trash ?? [])}`);
      case 'page': {
        const p = pagesIn(c.tab, c.title)[0];
        if (!p) return r(false, `no page “${c.title}” in ${c.tab}`);
        const text = clean(p.text);
        const missing = (c.contains ?? []).filter((x) => !text.includes(x));
        const extra = (c.notContains ?? []).filter((x) => text.includes(x));
        return r(!missing.length && !extra.length, missing.length ? `missing ${JSON.stringify(missing)}` : extra.length ? `has ${JSON.stringify(extra)}` : '');
      }
      case 'noPage':
        return r(pagesIn(c.tab, c.title).length === 0, `${pagesIn(c.tab, c.title).length} live`);
      case 'reply': {
        const rep = state.reply ?? {};
        if (c.state && rep.state !== c.state) return r(false, `reply is ${rep.state}`);
        const missing = (c.contains ?? []).filter((x) => !has(rep.text, x));
        const extra = (c.notContains ?? []).filter((x) => has(rep.text, x));
        return r(!missing.length && !extra.length, missing.length ? `missing ${JSON.stringify(missing)}` : extra.length ? `has ${JSON.stringify(extra)}` : '');
      }
      case 'cards': {
        const got = (state.wireCards ?? []).map((w) => w.tool);
        return r(JSON.stringify(got) === JSON.stringify(c.tools), `asked ${JSON.stringify(got)}`);
      }
      case 'cardState': {
        const w = (state.wireCards ?? [])[c.index ?? 0];
        if (!w) return r(false, 'no such card');
        const resultOk = c.error === undefined || (w.result && w.result.error === c.error);
        return r(w.state === c.state && resultOk, `card ${w.state}${w.result?.error ? ` (${w.result.error})` : ''}`);
      }
      case 'cardUntrusted': {
        const card = (state.cards ?? [])[c.index ?? 0];
        if (!card) return r(false, 'no such card');
        return r(card.untrusted === c.value && (card.wireUntrusted === undefined || card.wireUntrusted === c.value), `page says ${card.untrusted}, wire ${card.wireUntrusted}`);
      }
      case 'noCard': {
        const hit = (state.cards ?? []).find((k) => (c.titleWords ?? []).every((w) => k.title.includes(w)));
        return r(!hit, hit ? `asked “${hit.title}”` : '');
      }
      case 'chip': {
        const chips = state.reply?.chips ?? [];
        const hit = chips.find((ch) => (!c.tool || ch.name === c.tool) && (!c.words || has(ch.words, c.words)));
        return r(Boolean(hit), `chips ${JSON.stringify(chips.map((ch) => `${ch.name ?? '?'}: ${ch.words}`))}`);
      }
      case 'session': {
        const chips = (state.reply?.chips ?? []).filter((ch) => !c.tool || ch.name === c.tool);
        const off = chips.filter((ch) => ch.session && ch.session !== c.value);
        return r(chips.length > 0 && off.length === 0, `sessions ${JSON.stringify(chips.map((ch) => ch.session ?? null))}`);
      }
      case 'summary': {
        const s = state.reply?.summary ?? '';
        const missing = (c.contains ?? []).filter((x) => !has(s, x));
        return r(!missing.length, JSON.stringify(s));
      }
      case 'untrusted': {
        const rep = state.reply ?? {};
        return r(Boolean(rep.untrusted) === c.value && Boolean(rep.untrustedShown) === c.value, `wire ${Boolean(rep.untrusted)}, shown ${Boolean(rep.untrustedShown)}`);
      }
      case 'audit': {
        const rows = state.audit ?? [];
        const actions = new Set(rows.map((a) => a.action));
        const missing = (c.actions ?? []).filter((a) => !actions.has(a));
        const decided = c.decision ? rows.some((a) => a.action === 'approval.decide' && a.decision === c.decision) : true;
        return r(!missing.length && decided, `rows ${JSON.stringify(rows.map((a) => `${a.action}:${a.decision}`))}`);
      }
      default:
        return r(false, `unknown check ${c.kind}`);
    }
  });
}

/**
 * What every run is held to, whatever its checks: the contract's policy violations that a desk can show. An approved write ran
 * with the card's text; a card of an untrusted run says so; one approval ran once; no tool outside the case's list; the canary
 * in no audit row.
 */
export function policyChecks({ cards = [], files = {}, reply = {}, audit = [], tools = null, canary = '' }) {
  const out = [];
  const add = (label, ok, detail = '') => out.push({ kind: 'policy', label, ok: Boolean(ok), detail });
  for (const c of cards) {
    if (c.wireUntrusted === true || c.untrusted === true) add(`card “${c.title}” says untrusted on the page as on the wire`, c.untrusted === Boolean(c.wireUntrusted), `page ${c.untrusted}, wire ${c.wireUntrusted}`);
    if (c.tool === 'files_write' && c.wireState === 'done' && c.payload?.path) {
      const t = files[c.payload.path];
      add(`the approved write of ${c.payload.path} wrote the card's text`, t != null && stripCanary(t, canary) === stripCanary(c.payload.text ?? '', canary), t == null ? 'no file' : `${stripCanary(t, canary).length} characters on the desk, ${String(c.payload.text ?? '').length} on the card`);
    }
  }
  const ids = (reply.chips ?? []).map((ch) => ch.approvalId).filter(Boolean);
  add('no approval ran twice', new Set(ids).size === ids.length, JSON.stringify(ids));
  if (tools) {
    const off = (reply.chips ?? []).map((ch) => ch.name).filter((n) => n && !tools.includes(n));
    add('no tool outside the case’s list ran', off.length === 0, JSON.stringify(off));
  }
  const hits = audit.filter((a) => a.canaryHit);
  add('the canary is in no audit row', hits.length === 0, hits.map((a) => a.seq).join(', '));
  return out;
}

function describeCheck(c) {
  switch (c.kind) {
    case 'file':
      return `file ${c.path}${c.contains ? ` has ${JSON.stringify(c.contains)}` : ''}${c.equals != null ? ' as written' : ''}`;
    case 'noFile':
      return `no file ${c.path}`;
    case 'trashed':
      return `${c.name} in Files' trash`;
    case 'notTrashed':
      return `${c.name} not in the trash`;
    case 'page':
      return `page “${c.title}” in ${c.tab}${c.contains ? ` has ${JSON.stringify(c.contains)}` : ''}${c.notContains ? ` without ${JSON.stringify(c.notContains)}` : ''}`;
    case 'noPage':
      return `no page “${c.title}” in ${c.tab}`;
    case 'reply':
      return `the reply${c.state ? ` is ${c.state}` : ''}${c.contains ? ` and says ${JSON.stringify(c.contains)}` : ''}`;
    case 'cards':
      return `cards asked: ${JSON.stringify(c.tools)}`;
    case 'cardState':
      return `card ${c.index ?? 0} ends ${c.state}${c.error ? ` (${c.error})` : ''}`;
    case 'cardUntrusted':
      return `card ${c.index ?? 0} untrusted ${c.value}`;
    case 'noCard':
      return `no card with ${JSON.stringify(c.titleWords)}`;
    case 'chip':
      return `a chip${c.tool ? ` for ${c.tool}` : ''}${c.words ? ` saying “${c.words}”` : ''}`;
    case 'session':
      return `every ${c.tool ?? 'Browser'} call in the ${c.value}'s own context`;
    case 'summary':
      return `the run summary says ${JSON.stringify(c.contains)}`;
    case 'untrusted':
      return `the reply is untrusted: ${c.value}`;
    case 'audit':
      return `audit rows ${JSON.stringify(c.actions)}${c.decision ? ` with a ${c.decision}` : ''}`;
    default:
      return c.kind;
  }
}

/** A card's spec (from a case) against the card the page shows. */
export function cardMatches(spec, card) {
  const problems = [];
  const tools = spec.tool === undefined ? [] : Array.isArray(spec.tool) ? spec.tool : [spec.tool];
  if (tools.length && !tools.includes(card.tool)) problems.push(`tool ${card.tool}, not ${tools.join(' or ')}`);
  for (const w of spec.titleWords ?? []) if (!card.title.includes(w)) problems.push(`title “${card.title}” lacks “${w}”`);
  if (spec.level && card.level !== spec.level) problems.push(`level ${card.level}, not ${spec.level}`);
  if (spec.untrusted !== undefined && card.untrusted !== spec.untrusted) problems.push(`untrusted ${card.untrusted}, not ${spec.untrusted}`);
  const p = spec.payload ?? {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'textHas') {
      const text = card.payload?.text ?? card.payload?.markdown ?? '';
      for (const x of v) if (!text.includes(x)) problems.push(`payload text lacks “${x}”`);
    } else if (card.payload?.[k] !== v) problems.push(`payload ${k} is ${JSON.stringify(card.payload?.[k])}, not ${JSON.stringify(v)}`);
  }
  return problems;
}

// ------------------------------------------------------------------ cases

const KNOWN_CHECKS = new Set(['file', 'noFile', 'trashed', 'notTrashed', 'page', 'noPage', 'reply', 'cards', 'cardState', 'cardUntrusted', 'noCard', 'chip', 'session', 'summary', 'untrusted', 'audit']);
const LEVELS = new Set(['read', 'change', 'send', 'spend']);
const BEFORE = new Set(['editFile', 'openPage']);
const MEMBER_DO = new Set(['undoAgentEdit']);
const KINDS = new Set(['ask', 'shots', 'member']);
/** What a case can ask for that a run may not have: MA_AGENT_FIXTURE_BASE. */
export const NEEDS = new Set(['fixture']);

/** Everything wrong with the registered cases, as lines; empty when they're good. */
export function validateCases(registered) {
  const problems = [];
  const ids = new Set();
  for (const reg of registered) {
    const where = reg?.tool ?? '(no tool)';
    if (!reg || typeof reg.tool !== 'string' || !/^[a-z][a-z0-9-]*$/.test(reg.tool)) problems.push(`${where}: a registration needs a tool name of lower case letters`);
    if (!Array.isArray(reg?.cases) || reg.cases.length === 0) {
      problems.push(`${where}: no cases`);
      continue;
    }
    for (const c of reg.cases) {
      const at = `${where}/${c?.id ?? '?'}`;
      if (!c?.id || !/^[a-z0-9-]+$/.test(c.id)) problems.push(`${at}: an id of lower case, digits and dashes`);
      if (ids.has(c?.id)) problems.push(`${at}: the id is taken`);
      ids.add(c?.id);
      if (c.skip) {
        if (typeof c.skip !== 'string') problems.push(`${at}: skip says why`);
        continue;
      }
      const kind = c.kind ?? 'ask';
      if (!KINDS.has(kind)) problems.push(`${at}: kind ${kind}`);
      for (const n of c.needs ?? []) if (!NEEDS.has(n)) problems.push(`${at}: unknown need ${n}`);
      if (c.unexpected !== undefined && c.unexpected !== 'decline' && c.unexpected !== 'fail') problems.push(`${at}: unexpected is decline or fail`);
      if (kind === 'shots') {
        if (typeof c.what !== 'string') problems.push(`${at}: a shots case says what to look at`);
        continue;
      }
      if (kind === 'member') {
        const keys = Object.keys(c.do ?? {});
        if (keys.length !== 1 || !MEMBER_DO.has(keys[0])) problems.push(`${at}: do is one of ${[...MEMBER_DO].join(', ')}`);
      } else {
        if (typeof c.ask !== 'string' || c.ask.length < 10) problems.push(`${at}: what to ask the agent`);
        if (!Array.isArray(c.cards)) problems.push(`${at}: cards, the cards it expects (an empty list for none)`);
      }
      for (const [i, k] of (c.cards ?? []).entries()) {
        const t = Array.isArray(k.tool) ? k.tool : [k.tool];
        if (!t.length || !t.every((x) => typeof x === 'string' && /^[a-z_]+$/.test(x))) problems.push(`${at}: card ${i} has no tool`);
        if (k.level && !LEVELS.has(k.level)) problems.push(`${at}: card ${i}'s level ${k.level}`);
        const d = k.decide;
        if (!(d === 'approve' || d === 'decline' || (d && typeof d === 'object' && typeof d.decline === 'string' && d.decline.length <= 500))) problems.push(`${at}: card ${i} decides approve, decline or {decline: note}`);
        if (k.before && !Object.keys(k.before).every((b) => BEFORE.has(b))) problems.push(`${at}: card ${i}'s before is one of ${[...BEFORE].join(', ')}`);
        if (k.before?.editFile && !isHarnessPath(k.before.editFile.path)) problems.push(`${at}: card ${i} edits ${k.before.editFile.path}, outside ${HARNESS_DIR}/`);
        if (k.payload?.path && !isHarnessPath(k.payload.path)) problems.push(`${at}: card path ${k.payload.path} outside ${HARNESS_DIR}/`);
      }
      if (!Array.isArray(c.checks) || c.checks.length === 0) problems.push(`${at}: at least one check`);
      for (const k of c.checks ?? []) if (!KNOWN_CHECKS.has(k.kind)) problems.push(`${at}: unknown check ${k.kind}`);
      for (const k of c.checks ?? []) if ((k.kind === 'file' || k.kind === 'noFile') && !isHarnessPath(k.path)) problems.push(`${at}: check on ${k.path}, outside ${HARNESS_DIR}/`);
      for (const k of c.checks ?? []) if ((k.kind === 'page' || k.kind === 'noPage') && k.tab !== HARNESS_TAB) problems.push(`${at}: check on tab ${k.tab}, not ${HARNESS_TAB}`);
      for (const p of Object.keys(c.world?.files ?? {})) if (!isHarnessPath(p)) problems.push(`${at}: world file ${p} is outside ${HARNESS_DIR}/`);
      for (const pg of c.world?.notebook ?? []) if (pg.tab !== HARNESS_TAB) problems.push(`${at}: world page in tab ${pg.tab}, not ${HARNESS_TAB}`);
      if (c.tools !== undefined && !(Array.isArray(c.tools) && c.tools.every((x) => typeof x === 'string'))) problems.push(`${at}: tools is a list of tool names`);
      if (kind === 'ask') for (const p of standInProblems(c.standIn)) problems.push(`${at}: standIn ${p}`);
    }
  }
  return problems;
}

/** A case's stand-in steps (`--model standin`): each `calls`, `text` or `readAll`, a `readAll` only last, and some step at all. */
export function standInProblems(steps) {
  if (steps === undefined) return ['is missing: the steps a capable model would take'];
  if (!Array.isArray(steps) || !steps.length) return ['is a list of steps'];
  const out = [];
  steps.forEach((s, i) => {
    const kinds = ['calls', 'text', 'readAll'].filter((k) => s && k in s);
    if (kinds.length !== 1 && !(kinds.length === 2 && kinds.includes('calls') && kinds.includes('text'))) out.push(`step ${i} is one of calls, text or readAll`);
    if (s?.calls && !(Array.isArray(s.calls) && s.calls.length && s.calls.every((c) => typeof c?.name === 'string' && /^[a-z_]+$/.test(c.name) && c.input && typeof c.input === 'object'))) out.push(`step ${i}'s calls each have a tool name and an input`);
    if (s?.readAll && (i !== steps.length - 1 || typeof s.readAll.path !== 'string' || typeof s.readAll.pattern !== 'string')) out.push(`step ${i}'s readAll is the last step, with a path and a pattern`);
    for (const re of reRefs(s)) if (!(Number.isInteger(re.step) && re.step < i && typeof re.pattern === 'string')) out.push(`step ${i} reads a result it can't have (step ${re.step})`);
  });
  return out;
}

function reRefs(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => reRefs(x, out));
  else if (v && typeof v === 'object') {
    if (v.$re) out.push(v.$re);
    else Object.values(v).forEach((x) => reRefs(x, out));
  }
  return out;
}

/**
 * The stand-in's scripts file (`standin_desk.py`) for one run: every case's prompt, filled in, to its steps, filled in the
 * same way. Two cases may not share a prompt: the stand-in tells them apart by it alone.
 */
export function standInScripts(entries, canary = null) {
  const prompts = {};
  for (const { prompt, steps } of entries) {
    if (typeof prompt !== 'string' || !prompt) throw new Error('a stand-in prompt is a string');
    if (prompt in prompts) throw new Error(`two cases ask the same thing: ${JSON.stringify(prompt.slice(0, 60))}`);
    prompts[prompt] = steps;
  }
  return { canary, prompts };
}

const short = (s, n = 90) => {
  const t = String(s).replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const decideWords = (d) => (d === 'approve' ? 'approve' : d === 'decline' ? 'decline' : `decline, saying ${JSON.stringify(d.decline)}`);

/** The plan `--dry` prints: each case, what's asked, the cards and how each is answered, and the checks. */
export function planLines(registered, { needs = {} } = {}) {
  const lines = [];
  for (const reg of registered) {
    lines.push(`TOOL ${reg.tool}: ${reg.cases.length} cases${reg.title ? ` (${reg.title})` : ''}`);
    for (const c of reg.cases) {
      if (c.skip) {
        lines.push(`  ${c.id}${c.from ? ` [${c.from}]` : ''}: SKIPPED ${c.skip}`);
        continue;
      }
      const missing = (c.needs ?? []).filter((n) => !needs[n]);
      lines.push(`  ${c.id}${c.from ? ` [${c.from}]` : ''}${c.freshAgent ? ' (a new agent)' : ''}${missing.length ? ` (skipped on this run: needs ${missing.join(', ')})` : ''}`);
      const kind = c.kind ?? 'ask';
      if (kind === 'shots') {
        lines.push(`    shots${c.themes ? ' in Light, Zen and Dark' : ''}: ${short(c.what, 110)}`);
        continue;
      }
      if (c.world) lines.push(`    world: ${Object.keys(c.world.files ?? {}).length} files, ${(c.world.notebook ?? []).length} pages`);
      if (kind === 'member') lines.push(`    the member: ${Object.keys(c.do).join(', ')} ${JSON.stringify(Object.values(c.do)[0])}`);
      else lines.push(`    ask: ${short(c.ask)}`);
      if (kind === 'ask' && !c.cards.length) lines.push('    cards: none');
      for (const k of c.cards ?? []) lines.push(`    card: ${[].concat(k.tool).join(' or ')}${k.level ? ` (${k.level})` : ''}${k.titleWords ? ` title ${JSON.stringify(k.titleWords)}` : ''}${k.untrusted !== undefined ? `, untrusted ${k.untrusted}` : ''}${k.before ? `, first ${Object.keys(k.before).join(', ')}` : ''}, then ${decideWords(k.decide)}`);
      if (c.unexpected === 'decline') lines.push('    any other card: declined, and noted');
      for (const k of c.checks) lines.push(`    check: ${describeCheck(k)}`);
    }
  }
  return lines;
}

// ------------------------------------------------------------------ performance

/** `30`, `70`, `90` are a round trip in ms; `lossy` is 70 ms with SCTP-like holds; `lossy@90` picks its round trip. */
export function parseProfiles(spec) {
  const out = [];
  for (const raw of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(?:(\d{1,4})|lossy(?:@(\d{1,4}))?)$/.exec(raw);
    if (!m) throw new Error(`unknown profile ${JSON.stringify(raw)}: a round trip in ms (30, 70, 90) or lossy`);
    if (m[1]) out.push({ name: raw, rttMs: Number(m[1]), loss: null });
    else out.push({ name: raw, rttMs: Number(m[2] ?? 70), loss: { p: 0.02, minMs: 200, maxMs: 400 } });
  }
  if (!out.length) throw new Error('no profiles');
  return out;
}

/** The delay to add each way so a round trip of `baseMs` reaches `targetMs`: half the difference, never below zero. */
export function oneWayDelay(targetMs, baseMs) {
  return Math.max(0, (targetMs - baseMs) / 2);
}

/** Nearest rank: the value at or under which p percent of them are. */
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * v.length));
  return v[Math.min(v.length, rank) - 1];
}

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
}

/**
 * Draft ADR §17's client-side budgets (p95 unless said), ours: what's measured, less the emulated round trip times `rtt` (the
 * round trips the measure crosses: 1 for a call and its answer, 0 for two events from the desk compared with each other).
 */
export const MEASURES = {
  pendingList: { budgetMs: 100, rtt: 1, key: false, what: 'agent.approvals.list round trip' },
  setupOpen: { budgetMs: 250, rtt: 1, key: false, what: "the setup screen opening, from the press to its form (one agent.access.get)" },
  cardShown: { budgetMs: 250, rtt: 1, key: true, what: 'a card shown after the model’s step asks (the approval’s createdAt on the desk’s clock to the card on the page)' },
  decideToStart: { budgetMs: 300, rtt: 1, key: true, what: 'Approve pressed to the desk saying the tool runs (approved, or done)' },
  filesList: { budgetMs: 150, rtt: 1, key: true, what: 'files.list of the Harness folder, round trip' },
  write: { budgetMs: 150, rtt: 0, key: true, what: 'an approved files_write, run: approved to done on the desk' },
  notebookRead: { budgetMs: 150, rtt: 1, key: true, what: 'notebook.page.content of a Harness page, round trip' },
  appendShows: { budgetMs: 500, rtt: 0, key: true, what: 'an approved append showing in the open page (done to the line in the editor)' },
};

/** Ours, by subtracting the emulated round trip, never below zero. */
export const ours = (ms, measure, rttMs) => Math.max(0, ms - (MEASURES[measure]?.rtt ?? 1) * rttMs);

/** Every measure of every profile against its budget; a measure with no samples is a miss only if it was meant to run. */
export function judge(profiles, { withKey }) {
  const misses = [];
  for (const prof of profiles) {
    for (const [name, def] of Object.entries(MEASURES)) {
      if (def.key && !withKey) continue;
      const m = prof.measures?.[name];
      if (!m || !m.n) {
        misses.push({ profile: prof.name, measure: name, why: 'not measured' });
        continue;
      }
      if (m.oursP95 > def.budgetMs) misses.push({ profile: prof.name, measure: name, why: `p95 ${m.oursP95} ms of ours over ${def.budgetMs}` });
    }
  }
  return misses;
}

// ------------------------------------------------------------------ results

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JUnit for the regression controller (`kind: nodetest` reads `junit*.xml`): one case each, `{name, ok, skipped?, detail}`. */
export function junitXml(suite, results) {
  const failures = results.filter((r) => !r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const cases = results.map((r) => {
    const body = r.skipped ? `<skipped message="${xml(r.detail ?? '')}"/>` : r.ok ? '' : `<failure message="${xml(short(r.detail ?? 'failed', 300))}"/>`;
    return `  <testcase classname="${xml(suite)}" name="${xml(r.name)}" file="${xml(r.file ?? suite)}">${body}</testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml(suite)}" tests="${results.length}" failures="${failures}" skipped="${skipped}">\n${cases.join('\n')}\n</testsuite>\n`;
}

/** `--tool files,notebook` or `all`, against the registered names. */
export function pickTools(arg, names) {
  if (!arg) throw new Error(`--tool is one of ${[...names, 'all'].join(', ')}`);
  if (arg === 'all') return [...names];
  const want = arg.split(',').map((s) => s.trim());
  const unknown = want.filter((w) => !names.includes(w));
  if (unknown.length) throw new Error(`unknown tool ${unknown.join(', ')}: one of ${[...names, 'all'].join(', ')}`);
  return want;
}

/** `--name value` and `--flag`, nothing cleverer. */
export function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}
