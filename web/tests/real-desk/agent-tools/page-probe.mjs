// What the Agent tools' scripts read in the page, injected before the app loads (`addInitScript`). Self-contained, so
// Playwright can serialize it.
//
// It reads the desk's frames for ids, states, tool names, timings and hashes, never a payload, a title, a key or any text:
// outgoing frames only for their method name or topic (a regex over the first 200 bytes, as `rt-agent.mjs` does), and answers
// and events only through the sanitizers below. The one way content crosses to Node is `call` in `full` mode, for the methods
// the Files and Notebook apps already call, and only for the `Harness` folder and the `Harness` tab: the guards are here, in the
// page, so nothing outside them can leave it.
//
// Frames are deskd's (services/deskd/docs/API.md §2): a 12-byte header (version 1, kind, flags, 0, id u32, seq u32), JSON after.

/** @param {{allow: {files: string[], notebook: string[], timingOnly: string[], mutations: string[]}, dir: string, tab: string}} cfg */
export function toolsProbe(cfg) {
  const w = window;
  if (w.__rtTools) return;
  const K = { REQ: 7, RES: 8, ERR: 9, SUB: 10, EVT: 12, CHUNK: 15, CREDIT: 16 };
  const MORE = 1;
  const BIN = 2;
  const END = 4;
  const MAX_PAYLOAD = 16 * 1024 - 12;
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const DIR = cfg.dir;
  const TAB = cfg.tab;
  const allow = cfg.allow;

  const S = {
    calls: [],
    approvals: {},
    messages: {},
    tools: { serverNow: null, at: null, calls: {}, ends: [] },
    created: [],
    sends: [],
    keys: [],
    decides: [],
    audit: { entries: {}, headHash: null },
    agents: [],
    convEvents: [],
    limits: [],
    keyList: [],
    cardsShown: [],
    canaries: [],
    csp: [],
    errors: 0,
  };
  document.addEventListener('securitypolicyviolation', (e) => S.csp.push(String(e.effectiveDirective ?? '').slice(0, 40)));
  const channels = {};
  const reqs = new Map();
  const subReqs = new Map();
  const topics = new Map();
  const parts = new Map();
  const mine = new Map();
  const transfers = new Map();
  const loose = new Map();
  let looseBytes = 0;
  let nextId = 0x70000000;
  const harnessTabs = new Set();
  const harnessPages = new Set();
  const harnessEdits = new Set();

  // ------------------------------------------------------------ frames

  const header = (bytes) => {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { kind: bytes[1], flags: bytes[2], id: v.getUint32(4), seq: v.getUint32(8) };
  };
  const frame = (kind, flags, id, seq, payload) => {
    const out = new Uint8Array(12 + payload.length);
    const v = new DataView(out.buffer);
    out[0] = 1;
    out[1] = kind;
    out[2] = flags;
    v.setUint32(4, id);
    v.setUint32(8, seq);
    out.set(payload, 12);
    return out;
  };
  const frames = (kind, id, bytes, flags = 0) => {
    const out = [];
    let at = 0;
    do {
      const end = Math.min(at + MAX_PAYLOAD, bytes.length);
      out.push(frame(kind, end === bytes.length ? flags : flags | MORE, id, 0, bytes.subarray(at, end)));
      at = end;
    } while (at < bytes.length);
    return out;
  };
  /** The whole message once its last frame is in (by kind and id, as deskd's reassembly goes), else null. */
  const whole = (h, payload) => {
    const key = `${h.kind}:${h.id}`;
    const open = parts.get(key);
    if (!open && !(h.flags & MORE)) return payload;
    const list = open ?? [];
    list.push(payload.slice());
    if (h.flags & MORE) {
      parts.set(key, list);
      return null;
    }
    parts.delete(key);
    const size = list.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of list) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const json = (bytes) => {
    try {
      return JSON.parse(dec.decode(bytes));
    } catch {
      return null;
    }
  };
  const uuidv7 = () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    const now = Date.now();
    for (let i = 0; i < 6; i += 1) b[i] = Math.floor(now / 256 ** (5 - i)) % 256;
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

  // ------------------------------------------------------------ sanitizers: ids, states, names, times, hashes

  const ID = /^[A-Za-z0-9:_.-]{1,96}$/;
  const idOr = (v) => (typeof v === 'string' && ID.test(v) ? v : v == null ? null : '(text)');
  const approval = (a) => ({
    id: idOr(a.id),
    agentId: idOr(a.agentId),
    runId: idOr(a.runId),
    messageId: idOr(a.messageId),
    tool: idOr(a.tool),
    risk: idOr(a.risk),
    state: idOr(a.state),
    untrusted: a.untrusted === true,
    sha256: typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256) ? a.sha256 : null,
    context: a.context === 'agent' ? 'agent' : typeof a.context === 'string' && a.context.startsWith('member:') ? 'member' : null,
    createdAt: Number(a.createdAt) || null,
    decidedAt: Number(a.decidedAt) || null,
    expiresAt: Number(a.expiresAt) || null,
    detail: idOr(a.detail),
    decidedBy: a.decidedBy === 'owner' || a.decidedBy === 'auto' ? a.decidedBy : a.decidedBy ? 'other' : null,
    result: a.result ? { ok: a.result.ok === true, error: idOr(a.result.error ?? null), durationMs: Number(a.result.durationMs) || null } : null,
  });
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  /** A reply's usage and cost: numbers only. */
  const usageOf = (u) => (u && typeof u === 'object' ? Object.fromEntries(Object.entries(u).filter(([k, v]) => /^[a-zA-Z]{1,40}$/.test(k) && typeof v === 'number')) : null);
  const message = (m) => ({
    id: idOr(m.id),
    costMicroUsd: num(m.costMicroUsd),
    usage: usageOf(m.usage),
    model: m.badge && typeof m.badge.model === 'string' && /^[A-Za-z0-9:._/-]{1,80}$/.test(m.badge.model) ? m.badge.model : null,
    role: m.role === 'user' || m.role === 'assistant' ? m.role : null,
    state: idOr(m.state ?? 'done'),
    runId: idOr(m.runId),
    untrusted: m.untrusted === true,
    egressCount: Number(m.egressCount) || 0,
    pending: Array.isArray(m.pendingApprovals) ? m.pendingApprovals.length : 0,
    tools: (Array.isArray(m.tools) ? m.tools : []).map((t) => ({
      name: idOr(t.name),
      ok: t.ok === true,
      risk: idOr(t.risk),
      session: t.session === 'agent' || t.session === 'member' ? t.session : null,
      auto: idOr(t.auto ?? null),
      approvalId: idOr(t.approval?.id ?? null),
      decision: idOr(t.approval?.decision ?? null),
      durationMs: Number(t.durationMs) || null,
    })),
  });
  const auditRow = (e) => ({
    seq: Number(e.seq),
    atMs: Number(e.atMs) || null,
    actor: idOr(e.actor),
    action: idOr(e.action),
    decision: idOr(e.decision),
    target: idOr(e.target),
    // A row's tool and run, by name and id only (`tool:files_list run:… approval:…`), and an llm.call's cost.
    tool: (/(?:^|\s)tool:([a-z0-9_]{1,64})/.exec(String(e.target ?? '')) ?? [])[1] ?? null,
    run: idOr((/(?:^|\s)run:([A-Za-z0-9_.:-]{1,96})/.exec(String(e.target ?? '')) ?? [])[1] ?? null),
    costMicroUsd: num(e.costMicroUsd),
    model: (/(?:^|\s)model:([A-Za-z0-9._/-]{1,80})/.exec(String(e.target ?? '')) ?? [])[1] ?? null,
    payloadSha256: typeof e.payloadSha256 === 'string' && /^[0-9a-f]{64}$/.test(e.payloadSha256),
    hash: typeof e.hash === 'string' ? e.hash.slice(0, 64) : null,
    canaryHit: S.canaries.some((c) => JSON.stringify(e).includes(c)),
  });

  const noteApproval = (a, at) => {
    const s = approval(a);
    if (!s.id) return;
    const old = S.approvals[s.id];
    const states = old ? old.states : [];
    if (!old || old.state !== s.state) states.push({ state: s.state, at });
    S.approvals[s.id] = { ...s, firstAt: old?.firstAt ?? at, states };
  };
  const noteMessage = (m, at) => {
    const s = message(m);
    if (!s.id) return;
    const old = S.messages[s.id];
    S.messages[s.id] = { ...s, firstAt: old?.firstAt ?? at, at };
  };

  /** The answer to one of the app's own calls: its time and code, and for a few methods their ids. */
  const onAnswer = (id, kind, body, at) => {
    const r = reqs.get(id);
    if (!r) return;
    reqs.delete(id);
    const call = { m: r.m, ms: Math.round((performance.now() - r.t) * 10) / 10, sentAt: r.at, gotAt: at, ok: kind === K.RES, code: kind === K.ERR ? idOr(body?.code) : null, reason: kind === K.ERR ? idOr(body?.details?.reason ?? null) : null };
    S.calls.push(call);
    if (S.calls.length > 4000) S.calls.splice(0, 1000);
    if (kind !== K.RES || !body) return;
    if (r.m === 'agent.create' && body.agent) S.created.push({ agentId: idOr(body.agent.id), at });
    else if (r.m === 'agent.message.send') S.sends.push({ runId: idOr(body.runId), messageId: idOr(body.messageId), at, sentAt: r.at });
    else if (r.m === 'agent.key.add' && body.key) S.keys.push({ keyId: idOr(body.key.keyId), at });
    else if (r.m === 'agent.approval.decide' && body.approval) {
      noteApproval(body.approval, at);
      S.decides.push({ id: idOr(body.approval.id), state: idOr(body.approval.state), decidedAt: Number(body.approval.decidedAt) || null, sentAt: r.at, gotAt: at });
    } else if (r.m === 'agent.audit.list' && Array.isArray(body.entries)) {
      for (const e of body.entries) {
        const row = auditRow(e);
        if (Number.isFinite(row.seq)) S.audit.entries[row.seq] = row;
      }
      if (typeof body.headHash === 'string') S.audit.headHash = body.headHash.slice(0, 64);
    } else if (r.m === 'agent.list' && Array.isArray(body.agents)) S.agents = body.agents.map((a) => ({ id: idOr(a.id), role: idOr(a.role), status: idOr(a.status), bound: Boolean(a.binding), keyId: idOr(a.binding?.keyId ?? null), model: idOr(a.binding?.model ?? null) }));
    else if ((r.m === 'agent.limits.get' || r.m === 'agent.limits.set') && body.policy) {
      const lim = (l) => (l ? { maxMicroUsd: num(l.maxMicroUsd), maxTokens: num(l.maxTokens) } : null);
      S.limits.push({
        at,
        m: r.m,
        agentId: idOr(body.agentId),
        policy: Object.fromEntries(Object.entries(body.policy).map(([k, v]) => [k, typeof v === 'number' ? v : lim(v)])),
        usage: (Array.isArray(body.usage) ? body.usage : []).map((u) => ({ scope: idOr(u.scope), spentMicroUsd: num(u.spentMicroUsd), spentTokens: num(u.spentTokens), resetsAt: num(u.resetsAt) })),
        pricesAsOf: typeof body.pricesAsOf === 'string' ? body.pricesAsOf.slice(0, 10) : null,
      });
    } else if (r.m === 'agent.key.list' && Array.isArray(body.keys)) {
      // Last 4 and availability only, as check-keys.mjs reads them: never a key.
      S.keyList.push({ at, keys: body.keys.map((k) => ({ keyId: idOr(k.keyId), provider: idOr(k.provider), last4: typeof k.last4 === 'string' && /^[A-Za-z0-9_-]{4}$/.test(k.last4) ? k.last4 : null, available: k.available ?? null })) });
    }
  };

  // An EVT can beat its SUB's RES (API.md §3): kept a moment for a subId not known yet, and played once the RES names it.
  const early = new Map();
  const onEvent = (subId, raw, at) => {
    const topic = topics.get(subId);
    if (!raw) return;
    if (!topic) {
      const list = early.get(subId) ?? [];
      if (list.length < 50) list.push({ raw, at });
      early.set(subId, list);
      setTimeout(() => early.get(subId) === list && early.delete(subId), 10_000);
      return;
    }
    // deskd's events are `{type, data}` (API.md §3); a flat body (an older stand-in's) is read as it is.
    const body = raw.data && typeof raw.data === 'object' ? { ...raw.data, type: raw.type } : raw;
    if (topic.startsWith('agent.conversation:')) {
      // What each conversation event carried, by key and count only (for a run that finds the wire and the page disagree).
      if (S.convEvents.length < 400) S.convEvents.push({ at, type: idOr(body.type), keys: Object.keys(body).filter((k) => /^[a-zA-Z]{1,30}$/.test(k)).slice(0, 12), messages: Array.isArray(body.messages) ? body.messages.length : null, approvals: Array.isArray(body.approvals) ? body.approvals.length : null });
      if (Array.isArray(body.messages)) for (const m of body.messages) noteMessage(m, at);
      if (Array.isArray(body.approvals)) for (const a of body.approvals) noteApproval(a, at);
      if (body.type === 'message' && body.message) noteMessage(body.message, at);
      if (body.type === 'approval' && body.approval) noteApproval(body.approval, at);
    } else if (topic === 'agent.tools') {
      const t = S.tools;
      if (body.type === 'snapshot') {
        t.serverNow = Number(body.serverNow) || null;
        t.at = at;
      }
      const calls = body.type === 'snapshot' ? (body.calls ?? []) : body.type === 'call' && body.call ? [body.call] : [];
      for (const c of calls) {
        const id = idOr(c.callId);
        if (id && !t.calls[id]) t.calls[id] = { callId: id, tool: idOr(c.tool), runId: idOr(c.runId), startedAt: Number(c.startedAt) || null, seenAt: at, approvedBy: idOr(c.approvedBy) };
      }
      if (body.type === 'end') t.ends.push({ callId: idOr(body.callId), result: idOr(body.result ?? null), at });
    }
  };

  // ------------------------------------------------------------ the channels

  const watch = (dc, label) => {
    channels[label] = dc;
    if (label !== 'rpc' && label !== 'events' && label !== 'bulk') return;
    dc.addEventListener('message', (e) => {
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 12) return;
      const at = Date.now();
      try {
        const bytes = new Uint8Array(e.data);
        const h = header(bytes);
        const payload = bytes.subarray(12);
        if (label === 'bulk') return onBulk(h, payload);
        if (label === 'rpc' && (h.kind === K.RES || h.kind === K.ERR)) {
          const all = whole(h, payload);
          if (!all) return;
          const body = json(all);
          const own = mine.get(h.id);
          if (own) {
            mine.delete(h.id);
            own(h.kind, body, at);
            return;
          }
          const sub = subReqs.get(h.id);
          if (sub !== undefined) {
            subReqs.delete(h.id);
            if (h.kind === K.RES && body && Number.isFinite(body.subId)) {
              topics.set(body.subId, sub);
              const held = early.get(body.subId);
              early.delete(body.subId);
              for (const e of held ?? []) onEvent(body.subId, e.raw, e.at);
            }
          }
          onAnswer(h.id, h.kind, body, at);
        } else if (label === 'events' && h.kind === K.EVT) {
          const all = whole(h, payload);
          if (all) onEvent(h.id, json(all), at);
        }
      } catch {
        S.errors += 1;
      }
    });
  };

  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function sendAndNote(d) {
    try {
      if (this.label === 'rpc' && d && d.byteLength > 12) {
        const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        const h = header(bytes);
        if (!mine.has(h.id)) {
          const head = dec.decode(bytes.subarray(12, 212));
          if (h.kind === K.REQ) {
            const m = /"m":"([a-z][a-zA-Z.]*)"/.exec(head);
            if (m && !reqs.has(h.id)) reqs.set(h.id, { m: m[1], at: Date.now(), t: performance.now() });
          } else if (h.kind === K.SUB) {
            const t = /"topic":"([A-Za-z0-9.:_-]+)"/.exec(head);
            if (t) subReqs.set(h.id, t[1]);
          }
        }
      }
    } catch {
      S.errors += 1;
    }
    return send.call(this, d);
  };
  const Native = w.RTCPeerConnection;
  if (Native) {
    w.RTCPeerConnection = class extends Native {
      createDataChannel(label, init) {
        const dc = super.createDataChannel(label, init);
        watch(dc, label);
        return dc;
      }
    };
  }

  // ------------------------------------------------------------ the page: when a card shows, when text shows

  const cardObserver = new MutationObserver((records) => {
    const at = Date.now();
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof Element)) continue;
        const cards = n.matches?.('[data-approval-pending]') ? [n] : [...(n.querySelectorAll?.('[data-approval-pending]') ?? [])];
        for (let i = 0; i < cards.length; i += 1) S.cardsShown.push({ at });
      }
    }
  });
  const startObserving = () => cardObserver.observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) startObserving();
  else document.addEventListener('DOMContentLoaded', startObserving, { once: true });

  /** When `marker` first shows in an element matching `selector`, by this page's clock; null after `timeoutMs`. */
  const waitText = (selector, marker, timeoutMs) =>
    new Promise((resolve) => {
      const seen = () => [...document.querySelectorAll(selector)].some((el) => (el.textContent ?? '').includes(marker));
      if (seen()) return resolve(Date.now());
      const obs = new MutationObserver(() => {
        if (seen()) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(Date.now());
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeoutMs);
    });

  // ------------------------------------------------------------ calls of our own, on the app's own session

  const open = (label) => {
    const dc = channels[label];
    return dc && dc.readyState === 'open' ? dc : null;
  };
  /** `Harness`, or `Harness <more>`: the world's tabs (the capability tasks lay pages in `Harness Work`, `Harness Archive` and so on). */
  const inTab = (title) => typeof title === 'string' && (title === TAB || title.startsWith(`${TAB} `));
  const inDir = (p) => typeof p === 'string' && (p === DIR || p.startsWith(`${DIR}/`)) && !p.split('/').some((x) => x === '..' || x === '.' || x === '');

  /** The guard: what a call may name. A refusal never sends anything. */
  const guard = (method, p, mode) => {
    if (mode === 'timing') {
      if (allow.timingOnly.includes(method)) return null;
    }
    if (method.startsWith('files.')) {
      if (!allow.files.includes(method)) return 'method';
      if ('path' in p && !inDir(p.path)) return 'path';
      if ('paths' in p && !(Array.isArray(p.paths) && p.paths.every(inDir))) return 'path';
      if (method === 'files.delete' && p.permanent) return 'permanent';
      if (method === 'files.read.stop' || method === 'files.upload.finish' || method === 'files.upload.abort') return null;
      if (method === 'files.trash.list') return null;
      if (!('path' in p) && !('paths' in p)) return 'path';
      return null;
    }
    if (method.startsWith('notebook.')) {
      if (!allow.notebook.includes(method)) return 'method';
      if (method === 'notebook.tree') return null;
      if (method === 'notebook.tab.create') return inTab(p.title) ? null : 'tab';
      if (method === 'notebook.page.import') return harnessTabs.has(p.tabId) ? null : 'tab';
      if (method === 'notebook.page.agentUndo') return harnessEdits.has(p.editId) ? null : 'edit';
      return harnessPages.has(p.pageId) ? null : 'page';
    }
    return 'method';
  };

  /** What of a full answer may reach Node: Harness only. */
  const keep = (method, body) => {
    if (!body) return body;
    if (method === 'files.trash.list') return { next: body.next ?? null, items: (body.items ?? []).filter((it) => inDir(it.originalPath)).map((it) => ({ id: it.id, name: it.name, originalPath: it.originalPath, type: it.type, deletedAt: it.deletedAt })) };
    if (method === 'notebook.page.agentEdits') for (const e of body.edits ?? []) if (e.id ?? e.editId) harnessEdits.add(e.id ?? e.editId);
    if (method === 'notebook.tab.create') {
      if (body.tab?.id) harnessTabs.add(body.tab.id);
      if (body.page?.id) harnessPages.add(body.page.id);
    }
    if (method === 'notebook.page.import' && body.page?.id) harnessPages.add(body.page.id);
    return body;
  };

  const rawCall = (method, params, opts = {}) =>
    new Promise((resolve) => {
      const dc = open('rpc');
      if (!dc) return resolve({ ok: false, code: 'not_connected' });
      const id = nextId++;
      const t0 = performance.now();
      const body = { m: method, p: params ?? {} };
      if (allow.mutations.includes(method)) body.idem = uuidv7();
      if (opts.deadlineMs) body.deadlineMs = opts.deadlineMs;
      const timer = setTimeout(() => {
        mine.delete(id);
        resolve({ ok: false, code: 'timeout', ms: performance.now() - t0 });
      }, (opts.deadlineMs ?? 15000) + 5000);
      mine.set(id, (kind, answer) => {
        clearTimeout(timer);
        const ms = Math.round((performance.now() - t0) * 10) / 10;
        if (kind === K.RES) resolve({ ok: true, ms, result: answer });
        else resolve({ ok: false, ms, code: answer?.code ?? 'internal', details: answer?.details ?? {} });
      });
      try {
        for (const f of frames(K.REQ, id, enc.encode(JSON.stringify(body)))) dc.send(f);
      } catch {
        mine.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, code: 'send_failed' });
      }
    });

  const call = async (method, params = {}, opts = {}) => {
    const mode = opts.mode === 'timing' ? 'timing' : 'full';
    const why = guard(method, params, mode);
    if (why) return { ok: false, code: 'refused_by_harness', details: { reason: why } };
    const r = await rawCall(method, params, opts);
    if (mode === 'timing') return { ok: r.ok, ms: r.ms, code: r.ok ? null : r.code };
    if (!r.ok) return { ok: false, ms: r.ms, code: r.code, details: { reason: r.details?.reason ?? null } };
    return { ok: true, ms: r.ms, result: keep(method, r.result) };
  };

  /** The whole Notebook tree, and only its Harness tab's part of it: tab and page ids, titles, trashed or not. */
  const harnessTree = async () => {
    const tabs = [];
    const pages = [];
    const notebooks = [];
    let cursor = null;
    let rounds = 0;
    do {
      const r = await rawCall('notebook.tree', cursor ? { cursor } : {});
      if (!r.ok) return { ok: false, code: r.code };
      for (const n of r.result.notebooks ?? []) notebooks.push({ id: n.id, sortKey: n.sortKey });
      for (const t of r.result.tabs ?? []) if (inTab(t.title)) tabs.push({ id: t.id, notebookId: t.notebookId, title: t.title });
      pages.push(...(r.result.pages ?? []).map((p) => ({ id: p.id, tabId: p.tabId, title: p.title, deletedAt: p.deletedAt ?? null })));
      cursor = r.result.next ?? null;
      rounds += 1;
    } while (cursor && rounds < 200);
    for (const t of tabs) harnessTabs.add(t.id);
    const mineOnly = pages.filter((p) => harnessTabs.has(p.tabId));
    for (const p of mineOnly) harnessPages.add(p.id);
    notebooks.sort((a, b) => (a.sortKey ?? 0) - (b.sortKey ?? 0));
    return { ok: true, notebooks: notebooks.map((n) => n.id), tabs, pages: mineOnly };
  };

  /** A page's document, in its parts, joined (`notebook.page.content`, as the Notebook app reads it). */
  const pageDoc = async (pageId) => {
    let text = '';
    let cursor = null;
    let ms = 0;
    do {
      const r = await call('notebook.page.content', cursor ? { pageId, cursor } : { pageId });
      if (!r.ok) return r;
      ms += r.ms;
      text += r.result.part ?? '';
      cursor = r.result.next ?? null;
    } while (cursor);
    return { ok: true, ms, doc: text ? JSON.parse(text) : null };
  };

  // ------------------------------------------------------------ Files' transfers on `bulk`, for our own ids only

  const onBulk = (h, payload) => {
    const t = transfers.get(h.id);
    if (h.kind === K.CHUNK) {
      if (!t) {
        // A chunk can beat its `files.read` answer here (`rpc` and `bulk` aren't ordered): kept a moment, in case it's ours.
        if (looseBytes > 8 << 20) return;
        const list = loose.get(h.id) ?? [];
        list.push({ flags: h.flags, payload: payload.slice() });
        looseBytes += payload.length;
        loose.set(h.id, list);
        setTimeout(() => {
          const gone = loose.get(h.id);
          if (gone === list) {
            loose.delete(h.id);
            looseBytes -= list.reduce((n, x) => n + x.payload.length, 0);
          }
        }, 5000);
        return;
      }
      t.take(h.flags, payload);
    }
  };

  const readFile = (path) =>
    new Promise((resolve) => {
      (async () => {
        const r = await call('files.read', { path }, { deadlineMs: 60000 });
        if (!r.ok) return resolve(r);
        const id = r.result.transferId;
        const chunks = [];
        let got = 0;
        let credited = 1 << 20;
        const done = (out) => {
          transfers.delete(id);
          clearTimeout(timer);
          resolve(out);
        };
        const timer = setTimeout(() => done({ ok: false, code: 'timeout' }), 60000);
        const take = (flags, payload) => {
          if (flags & END) {
            if (payload.length !== 40) return done({ ok: false, code: 'transfer_failed' });
            const out = new Uint8Array(got);
            let at = 0;
            for (const c of chunks) {
              out.set(c, at);
              at += c.length;
            }
            return done({ ok: true, text: dec.decode(out), size: got });
          }
          chunks.push(payload.slice());
          got += payload.length;
          if (got > 4 << 20) {
            void rawCall('files.read.stop', { transferId: id });
            return done({ ok: false, code: 'too_large_for_harness' });
          }
          if (got + (512 << 10) > credited) {
            credited += 1 << 20;
            const dc = open('bulk');
            if (dc) for (const f of frames(K.CREDIT, id, enc.encode(JSON.stringify({ bytes: 1 << 20 })))) dc.send(f);
          }
        };
        transfers.set(id, { take });
        for (const x of loose.get(id) ?? []) take(x.flags, x.payload);
        loose.delete(id);
      })().catch(() => resolve({ ok: false, code: 'internal' }));
    });

  const writeFile = async (path, text, { replace = true } = {}) => {
    const bytes = enc.encode(text);
    if (bytes.length > 1 << 20) return { ok: false, code: 'too_large_for_harness' };
    const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
    const b = await call('files.upload.begin', { path, size: bytes.length, sha256, replace });
    if (!b.ok) return b;
    const dc = open('bulk');
    if (!dc && bytes.length) return { ok: false, code: 'not_connected' };
    let seq = 0;
    for (let at = 0; at < bytes.length; at += MAX_PAYLOAD) dc.send(frame(K.CHUNK, BIN, b.result.transferId, seq++, bytes.subarray(at, Math.min(at + MAX_PAYLOAD, bytes.length))));
    const f = await call('files.upload.finish', { uploadId: b.result.uploadId, sha256, size: bytes.length }, { deadlineMs: 60000 });
    if (!f.ok) await call('files.upload.abort', { uploadId: b.result.uploadId });
    return f.ok ? { ok: true, replaced: f.result.replaced ?? null } : f;
  };

  w.__rtTools = {
    call,
    harnessTree,
    pageDoc,
    readFile,
    writeFile,
    waitText,
    setCanaries: (list) => {
      S.canaries = list.filter((c) => typeof c === 'string' && c.length >= 12);
    },
    /** Everything recorded, as plain data: ids, states, names, times and hashes. */
    snapshot: () => JSON.parse(JSON.stringify({ ...S, audit: { headHash: S.audit.headHash, entries: Object.values(S.audit.entries).sort((a, b) => a.seq - b.seq) } })),
    connected: () => Boolean(open('rpc')),
  };
}
