// Dev and test only, like `mockDeskLink.ts`, which is all that imports this: never in a production bundle (scripts/build-release.mjs
// checks). A Guild Desk's side for `MockDeskLink` (task 48): deskd's `guild.*` methods as contract 3.3 has them, a small Commons
// room server speaking Commons' own protocol (`apps/commons/web/src/net/protocol.ts`) over the `commons` channel, and the demo
// content an engineering team's guild would have, so screenshots and shell tests show something real-looking. Nothing here is
// anyone's real data. Steer it as `window.__maDeskMock.guild`, or before load with `window.__maGuildMockInit`.
import * as Y from 'yjs';
import { packStroke, putItem, type Ink } from '../../../apps/commons/web/src/board/model.ts';
import { boardPrefix, ctrl, decodeCtrl, eachRecord, readBoardId, readU32, record, REC, u32 } from '../../../apps/commons/web/src/net/protocol.ts';
import type { GuildAgentLimits, GuildHello, GuildRole, GuildSettings, GuildUsage } from '../guild/api';
import { guildIdOfPanel, DEFAULT_LIMITS } from '../guild/panel';
import { useGuildStore } from '../guild/guildStore';
import { useSession } from '../platform/session';
import type { CollabChannel, CollabEnd } from './deskLink';

export interface MockGuildControl {
  /** How long a starting Guild Desk takes to say `running`, as the harness answers, between the link's polls. */
  pollMs: number;
  /** This member's name as deskd says it. Null: the session's own. */
  myName: string | null;
  /** Each guild's agent limits, by guild id. */
  settings: Record<string, GuildAgentLimits>;
  /** Others on the Notebook's pages, by name, sent as awareness. */
  presence: string[];
  /** Others in Commons. */
  room: { name: string; in: boolean; muted: boolean; speaking?: boolean }[];
  /** Fill the Notebook, Commons and the Agent with an engineering team's demo content on first open. */
  seed: boolean;
  /** Every `guild.*` call, in order. */
  calls: { m: string; p: Record<string, unknown> }[];
  /** deskd closes this member's session, as on a roster change (contract 3.3): the link asks for a fresh token. */
  kick(deskId: string): void;
}

const init = (window as unknown as { __maGuildMockInit?: Partial<MockGuildControl> }).__maGuildMockInit ?? {};

export const guildControl: MockGuildControl = {
  pollMs: 400,
  myName: null,
  settings: {},
  presence: ['Marcus Lee', 'Priya Raman'],
  room: [
    { name: 'Priya Raman', in: true, muted: false, speaking: true },
    { name: 'Marcus Lee', in: true, muted: false },
    { name: 'Jordan Ellis', in: true, muted: true },
    { name: 'Sam Okafor', in: false, muted: false },
  ],
  seed: true,
  calls: [],
  kick: () => {},
  ...init,
};

const refused = (code: string): Error => Object.assign(new Error(`mock guild: ${code}`), { code, details: {} });

function whoAmI(guildId: string): { role: GuildRole; grants: string[] } {
  const g = useGuildStore.getState().guilds.find((x) => x.guildId === guildId);
  return { role: g?.role ?? 'member', grants: g?.grants ?? [] };
}

const manages = (r: { role: GuildRole; grants: string[] }): boolean => r.role === 'lead' || (r.role === 'officer' && r.grants.includes('manage_agents'));

/** As deskd counts: by `memberId`, with no names (the harness's `/people` has them), dollars and micro-dollars. */
function usage(): GuildUsage {
  const rows: [string, number, number, number, number][] = [
    ['gm-priyaraman01', 6, 0.84, 71, 7.92],
    ['gm-marcuslee002', 4, 0.41, 52, 5.1],
    ['gm-jordanellis3', 2, 0.18, 33, 3.46],
    ['gm-samokafor004', 0, 0, 19, 1.88],
    ['gm-aishabello05', 1, 0.07, 8, 0.64],
  ];
  const money = (usd: number) => ({ usd, microUsd: Math.round(usd * 1_000_000) });
  return {
    members: rows.map(([memberId, tr, tu, mr, mu]) => ({ memberId, today: { runs: tr, ...money(tu) }, month: { runs: mr, ...money(mu) } })),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

const PATHS: [keyof GuildAgentLimits, string[]][] = [
  ['perMember', ['runsPerDay', 'usdPerDay', 'usdPerMonth']],
  ['perGuild', ['usdPerMonth', 'runsAtOnce']],
  ['tools', ['read', 'search', 'edit', 'post', 'boards']],
];

/** deskd's check on a set: every field there, or `bad_request` naming the first that isn't. */
function missingField(a: Partial<GuildAgentLimits>): string | null {
  for (const [group, keys] of PATHS) {
    const g = a[group] as Record<string, unknown> | undefined;
    for (const k of keys) if (!g || !(k in g)) return `agents.${group}.${k}`;
  }
  return typeof a.ownKeys === 'boolean' ? null : 'agents.ownKeys';
}

/** Who deskd's token says a Guild Desk's Notebook session is, for the awareness it relays; null on a member's own desk. */
export function guildCaller(deskId: string): { memberId: string; name: string } | null {
  const guildId = guildIdOfPanel(deskId);
  if (!guildId) return null;
  const name = guildControl.myName ?? useGuildStore.getState().hello[guildId]?.name ?? useSession.getState().me?.displayName ?? 'Member';
  return { memberId: `gm-${name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'member'}`, name };
}

/** deskd's `guild.*`, checking the caller's role as deskd does from the token. */
export function answerGuild(deskId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  guildControl.calls.push({ m: method, p: params });
  const guildId = guildIdOfPanel(deskId);
  if (!guildId) return Promise.reject(refused('not_found'));
  const me = whoAmI(guildId);
  switch (method) {
    case 'guild.hello': {
      const name = guildControl.myName ?? useSession.getState().me?.displayName ?? 'Member';
      return Promise.resolve({ guildId, memberId: 'gm-thismember01', role: me.role, grants: me.grants, name, apps: ['commons', 'notebook', 'agent'] } satisfies GuildHello);
    }
    case 'guild.settings.get':
      // Any member may read them; only the Founder or `manage_agents` may set them (deskd API.md section 14).
      return Promise.resolve({ agents: guildControl.settings[guildId] ?? DEFAULT_LIMITS, updatedAt: null, updatedBy: null } satisfies GuildSettings);
    case 'guild.settings.set': {
      if (!manages(me)) return Promise.reject(Object.assign(refused('forbidden'), { details: { reason: 'grant' } }));
      const p = (params['agents'] ?? {}) as Partial<GuildAgentLimits>;
      const missing = missingField(p);
      if (missing) return Promise.reject(Object.assign(refused('bad_request'), { details: { reason: 'settings', detail: missing } }));
      const next = structuredClone(p) as GuildAgentLimits;
      guildControl.settings[guildId] = next;
      return Promise.resolve({ agents: next, updatedAt: new Date().toISOString(), updatedBy: 'gm-thismember01' } satisfies GuildSettings);
    }
    case 'guild.usage.get':
      if (me.role !== 'lead' && me.role !== 'officer') return Promise.reject(refused('forbidden'));
      return Promise.resolve(usage());
    default:
      return Promise.reject(refused('not_found'));
  }
}

// ----- Commons: a room server on the page, per Guild Desk, on Commons' room-link protocol v2 (`apps/commons/web/src/net/
// protocol.ts`, the twin of `server/internal/room`): channels, each with its boards and its chat, members by channel, settings.
// Who this member is comes from here, as Commons hears it from deskd, never from the client's own hello.

const COLORS = 8;
const HOUR = 3_600_000;

interface Conn {
  member: number;
  ch: string;
  joined: boolean;
  muted: boolean;
  send(bytes: Uint8Array): void;
}

interface Who {
  id: string;
  name: string;
  role: GuildRole;
  grants: string[];
}

interface MockBoard {
  id: string;
  name: string;
  created: number;
  updated: number;
  by: string;
  doc: Y.Doc;
  seq: number;
}

interface MockChannel {
  id: string;
  name: string;
  main?: boolean;
  created: number;
  by: string;
  boards: MockBoard[];
  active: string;
  chat: { seq: number; from: string; name: string; badge?: 'officer' | 'lead'; text: string; at: number; nonce?: string }[];
}

/** The demo's others, as the roster would name them. */
const OTHERS: { id: string; name: string; role: GuildRole; badge?: 'officer' | 'lead'; ch: string }[] = [
  { id: 'gm-priyaraman01', name: 'Priya Raman', role: 'officer', badge: 'officer', ch: 'general' },
  { id: 'gm-marcuslee002', name: 'Marcus Lee', role: 'officer', badge: 'officer', ch: 'general' },
  { id: 'gm-jordanellis3', name: 'Jordan Ellis', role: 'member', ch: 'general' },
  { id: 'gm-samokafor004', name: 'Sam Okafor', role: 'member', ch: 'incidents' },
];

const badgeOf = (role: GuildRole): 'officer' | 'lead' | undefined => (role === 'lead' ? 'lead' : role === 'officer' ? 'officer' : undefined);

class MockRoom {
  private readonly channels: MockChannel[] = [];
  private readonly conns = new Set<Conn>();
  private nextMember = 20;
  private nextBoard = 1;
  private settings = { joinMuted: false, maxChannels: 10 };

  constructor() {
    const now = Date.now();
    const general = this.addChannel('general', 'General', 'Priya Raman', now - 40 * 24 * HOUR, true);
    const sprint = this.addBoard(general, 'Sprint 42 planning', 'Priya Raman', now - 2 * HOUR);
    if (guildControl.seed) seedBoard(sprint.doc);
    this.addBoard(general, 'Q1 architecture', 'Jordan Ellis', now - 9 * 24 * HOUR);
    general.active = sprint.id;
    const incidents = this.addChannel('incidents', 'Incidents', 'Marcus Lee', now - 30 * 24 * HOUR);
    incidents.active = this.addBoard(incidents, 'Checkout latency, Tuesday', 'Marcus Lee', now - 3 * 24 * HOUR).id;
    const design = this.addChannel('design', 'Design reviews', 'Jordan Ellis', now - 20 * 24 * HOUR);
    design.active = this.addBoard(design, 'API gateway rate limits', 'Jordan Ellis', now - 6 * 24 * HOUR).id;
    if (guildControl.seed) {
      const say = (ch: MockChannel, who: (typeof OTHERS)[number], text: string, ago: number): void => {
        ch.chat.push({ seq: ch.chat.length + 1, from: who.id, name: who.name, ...(who.badge ? { badge: who.badge } : {}), text, at: now - ago });
      };
      const [priya, marcus, jordan, sam] = OTHERS as [(typeof OTHERS)[number], (typeof OTHERS)[number], (typeof OTHERS)[number], (typeof OTHERS)[number]];
      say(general, marcus, 'Load test is booked for Thursday at 10. Same traffic shape as last peak, doubled.', 95 * 60_000);
      say(general, priya, 'Cart cache is in. p95 on checkout dropped from 410 ms to 280 ms in staging.', 70 * 60_000);
      say(general, jordan, 'Nice. I put the gateway limits on the board, next to the cache.', 52 * 60_000);
      say(general, sam, 'Who takes the queue-depth alert? It has no owner on the sprint page yet.', 31 * 60_000);
      say(general, priya, 'Sprint review in here at 3. Drop in when you can.', 12 * 60_000);
      say(incidents, marcus, 'Tuesday’s checkout latency: timeline is on the board. Root cause was the payments queue backing up.', 3 * 24 * HOUR);
      say(design, jordan, 'Draft for per-key token buckets is up. Comments by Friday, please.', 6 * 24 * HOUR);
    }
  }

  private addChannel(id: string, name: string, by: string, at: number, main = false): MockChannel {
    const ch: MockChannel = { id, name, ...(main ? { main } : {}), created: at, by, boards: [], active: '', chat: [] };
    this.channels.push(ch);
    return ch;
  }

  private addBoard(ch: MockChannel, name: string, by: string, at: number): MockBoard {
    const b: MockBoard = { id: `b${this.nextBoard++}`, name, created: at, updated: at, by, doc: new Y.Doc(), seq: 0 };
    ch.boards.push(b);
    return b;
  }

  private channel(id: string): MockChannel | undefined {
    return this.channels.find((c) => c.id === id);
  }

  private channelsList() {
    return this.channels.map((c) => ({ id: c.id, name: c.name, ...(c.main ? { main: true } : {}), created: c.created, by: c.by, last: c.chat.at(-1)?.seq ?? 0 }));
  }

  private boardsMsg(ch: MockChannel) {
    return {
      list: ch.boards.map((b) => ({ id: b.id, name: b.name, created: b.created, updated: b.updated, by: b.by, empty: b.doc.getMap('items').size === 0, bytes: Y.encodeStateAsUpdate(b.doc).length })),
      active: ch.active,
    };
  }

  private settingsMsg() {
    return { settings: { ...this.settings }, max: this.settings.maxChannels, ceiling: 10 };
  }

  private others() {
    return OTHERS.map((o, n) => {
      const r = guildControl.room.find((x) => x.name === o.name);
      return { i: n + 1, id: o.id, name: o.name, ...(o.badge ? { badge: o.badge } : {}), role: o.role, color: (n * 3 + 1) % COLORS, ch: o.ch, in: r?.in ?? false, muted: r?.muted ?? false };
    });
  }

  private me(conn: Conn, who: Who) {
    const badge = badgeOf(who.role);
    return { i: conn.member, id: who.id, name: who.name, ...(badge ? { badge } : {}), role: who.role, color: 2, ch: conn.ch, in: conn.joined, muted: conn.muted };
  }

  private can(who: Who) {
    return { manage: who.role === 'lead' || who.grants.includes('manage_spaces'), moderate: who.role === 'lead' || who.grants.includes('moderate') };
  }

  connect(send: (bytes: Uint8Array) => void): Conn {
    const conn: Conn = { member: this.nextMember++, ch: 'general', joined: false, muted: false, send };
    this.conns.add(conn);
    return conn;
  }

  drop(conn: Conn): void {
    this.conns.delete(conn);
  }

  receive(conn: Conn, msg: Uint8Array, who: () => Who): void {
    eachRecord(msg, (type, p) => {
      if (type === REC.ctrl) this.onCtrl(conn, decodeCtrl(p), who());
      else if (type === REC.boardUpdate) {
        const { id, rest } = readBoardId(p);
        const b = this.channels.flatMap((c) => c.boards).find((x) => x.id === id);
        if (!b) return;
        const ref = readU32(rest);
        Y.applyUpdate(b.doc, rest.subarray(4));
        b.seq += 1;
        b.updated = Date.now();
        conn.send(record(REC.boardAck, boardPrefix(id), u32(b.seq), u32(ref)));
      }
    });
  }

  private sendBoard(conn: Conn): void {
    const ch = this.channel(conn.ch);
    const b = ch?.boards.find((x) => x.id === ch.active);
    if (!ch || !b) return;
    b.seq = Math.max(b.seq, 1);
    conn.send(record(REC.boardEntry, boardPrefix(b.id), u32(b.seq), Y.encodeStateAsUpdate(b.doc)));
    conn.send(ctrl({ t: 'board-ready', id: b.id }));
    const others = this.others();
    const speaking = guildControl.room.flatMap((m) => {
      const o = others.find((x) => x.name === m.name);
      return m.speaking && m.in && o && o.ch === conn.ch ? [o.i] : [];
    });
    const sp = new Uint8Array(2 + speaking.length * 2);
    const dv = new DataView(sp.buffer);
    dv.setUint16(0, speaking.length, true);
    speaking.forEach((m, k) => dv.setUint16(2 + k * 2, m, true));
    conn.send(record(REC.speaking, sp));
    if (conn.ch !== 'general') return;
    // Two others' pointers on the board, as a live room has.
    const cursor = (member: number, x: number, y: number): Uint8Array => {
      const c = new Uint8Array(10);
      const v = new DataView(c.buffer);
      v.setUint16(0, member, true);
      v.setFloat32(2, x, true);
      v.setFloat32(6, y, true);
      return record(REC.cursor, c);
    };
    conn.send(cursor(1, -10, -380));
    conn.send(cursor(2, -250, -200));
  }

  private sendChat(conn: Conn): void {
    const ch = this.channel(conn.ch);
    if (!ch) return;
    conn.send(ctrl({ t: 'chat-page', ch: ch.id, msgs: ch.chat.slice(-50), more: ch.chat.length > 50, latest: true }));
  }

  private broadcast(msg: object, except?: Conn): void {
    for (const c of this.conns) if (c !== except) c.send(ctrl(msg));
  }

  private onCtrl(conn: Conn, m: Record<string, unknown> & { t: string }, who: Who): void {
    switch (m.t) {
      case 'hello': {
        const ch = this.channel(conn.ch)!;
        conn.send(ctrl({
          t: 'welcome', v: 2, you: this.me(conn, who), room: 'guild', members: this.others(), channels: this.channelsList(), ch: conn.ch,
          boards: this.boardsMsg(ch), settings: this.settingsMsg(), can: this.can(who), slots: 0, speaking: [],
        }));
        window.setTimeout(() => {
          this.sendBoard(conn);
          this.sendChat(conn);
        }, 0);
        break;
      }
      case 'join':
        conn.joined = true;
        conn.muted = m['muted'] === true;
        this.broadcast({ t: 'member', m: this.me(conn, who) });
        break;
      case 'leave':
        conn.joined = false;
        this.broadcast({ t: 'member', m: this.me(conn, who) });
        break;
      case 'mute':
        conn.muted = m['muted'] === true;
        this.broadcast({ t: 'member', m: this.me(conn, who) });
        break;
      case 'ping':
        conn.send(ctrl({ t: 'pong', n: m['n'] }));
        break;
      case 'settings':
        if (!this.can(who).manage) {
          conn.send(ctrl({ t: 'error', code: 'settings', reason: 'forbidden' }));
          return;
        }
        if (typeof m['joinMuted'] === 'boolean') this.settings.joinMuted = m['joinMuted'];
        this.broadcast({ t: 'settings', ...this.settingsMsg() });
        break;
      case 'chat-send': {
        const ch = this.channel(String(m['ch']));
        const text = String(m['text'] ?? '').trim().slice(0, 4000);
        if (!ch || !text) return;
        const badge = badgeOf(who.role);
        const msg = { seq: (ch.chat.at(-1)?.seq ?? 0) + 1, from: who.id, name: who.name, ...(badge ? { badge } : {}), text, at: Date.now() };
        ch.chat.push(msg);
        for (const c of this.conns) c.send(ctrl({ t: 'chat', ch: ch.id, m: c === conn ? { ...msg, nonce: m['nonce'] } : msg }));
        break;
      }
      case 'chat-history':
        conn.send(ctrl({ t: 'chat-page', ch: m['ch'], msgs: [], more: false, before: m['before'] }));
        break;
      case 'channel': {
        const op = m['op'];
        if (op === 'switch') {
          const ch = this.channel(String(m['id']));
          if (!ch) return;
          conn.ch = ch.id;
          this.broadcast({ t: 'member', m: this.me(conn, who) });
          conn.send(ctrl({ t: 'channel', ch: ch.id, boards: this.boardsMsg(ch) }));
          window.setTimeout(() => {
            this.sendBoard(conn);
            this.sendChat(conn);
          }, 0);
          return;
        }
        if (!this.can(who).manage) {
          conn.send(ctrl({ t: 'error', code: 'channel', reason: 'forbidden', op }));
          return;
        }
        if (op === 'create') {
          const name = String(m['name'] ?? '').trim().slice(0, 40) || 'New channel';
          const ch = this.addChannel(`c${Date.now().toString(36)}`, name, who.name, Date.now());
          ch.active = this.addBoard(ch, '', who.name, Date.now()).id;
        } else if (op === 'rename') {
          const ch = this.channel(String(m['id']));
          if (ch) ch.name = String(m['name'] ?? '').trim().slice(0, 40) || ch.name;
        }
        this.broadcast({ t: 'channels', list: this.channelsList() });
        break;
      }
      case 'boards': {
        const ch = this.channel(conn.ch);
        if (!ch) return;
        const op = m['op'];
        if (op === 'new') ch.active = this.addBoard(ch, '', who.name, Date.now()).id;
        else if (op === 'switch' && ch.boards.some((b) => b.id === m['id'])) ch.active = String(m['id']);
        else if (op === 'rename') {
          const b = ch.boards.find((x) => x.id === m['id']);
          if (b) b.name = String(m['name'] ?? '').slice(0, 80);
        } else if (op !== 'list') return; // `empty` and the rest: nothing to say back
        for (const c of this.conns) {
          if (c.ch !== ch.id) continue;
          c.send(ctrl({ t: 'boards', ch: ch.id, ...this.boardsMsg(ch), by: c === conn ? '' : who.name }));
          if (op === 'new' || op === 'switch') window.setTimeout(() => this.sendBoard(c), 0);
        }
        break;
      }
      default:
    }
  }
}

/** A sprint board: a heading, sticky notes by column, a sketch and an arrow, around the board's middle, where a room opens. */
function seedBoard(doc: Y.Doc): void {
  let z = 1;
  const X = -560;
  const Y0 = -560;
  const note = (x: number, y: number, c: Ink, tx: string): void => void putItem(doc, { k: 'n', x: X + x, y: Y0 + y, w: 200, h: 150, c, s: 1, z: z++, tx });
  const text = (x: number, y: number, tx: string, s: 0 | 1 | 2 = 1, w = 360): void => void putItem(doc, { k: 't', x: X + x, y: Y0 + y, w, h: 40, c: 'ink', s, z: z++, tx });
  doc.transact(() => {
    text(0, 0, 'Sprint 42: checkout and on-call', 2, 1000);
    text(0, 90, 'Doing', 1);
    text(240, 90, 'Next', 1);
    text(480, 90, 'Done', 1);
    note(0, 140, 'amber', 'Cache the cart totals per session. Priya');
    note(0, 310, 'blue', 'Split the payments worker into two queues. Marcus');
    note(240, 140, 'green', 'Load test at 2x last peak. Jordan');
    note(240, 310, 'violet', 'Runbook: rotating the API keys');
    note(480, 140, 'green', 'p95 checkout under 300 ms');
    putItem(doc, { k: 'r', x: X + 760, y: Y0 + 140, w: 260, h: 150, c: 'blue', s: 1, z: z++ });
    text(780, 160, 'API gateway', 0, 220);
    putItem(doc, { k: 'e', x: X + 800, y: Y0 + 360, w: 180, h: 110, c: 'green', s: 1, z: z++ });
    text(835, 400, 'Cart cache', 0, 140);
    putItem(doc, { k: 'a', x: X + 890, y: Y0 + 290, w: 0, h: 70, c: 'ink', s: 1, z: z++ });
    const pts: number[] = [];
    for (let i = 0; i <= 40; i += 1) pts.push(X + 480 + i * 6, Y0 + 360 + Math.sin(i / 4) * 14 + i * 1.5, 0.5);
    const st = packStroke(pts);
    putItem(doc, { k: 's', x: st.x, y: st.y, w: 0, h: 0, c: 'red', s: 1, z: z++, p: st.p });
  });
}

const rooms = new Map<string, MockRoom>();
const roomOf = (deskId: string): MockRoom => {
  let r = rooms.get(deskId);
  if (!r) rooms.set(deskId, (r = new MockRoom()));
  return r;
};

/** One session's `commons`: a loopback to this Guild Desk's room, in order, a task later, as a channel would. */
export class MockCommonsChannel implements CollabChannel {
  open = true;
  onOpen: (() => void) | null = null;
  onMessage: ((bytes: Uint8Array<ArrayBuffer>) => void) | null = null;
  onEnd: ((why: CollabEnd) => void) | null = null;
  private readonly conn: Conn;
  private readonly room: MockRoom;

  constructor(private readonly deskId: string) {
    this.room = roomOf(deskId);
    this.conn = this.room.connect((bytes) => {
      const copy = bytes.slice() as Uint8Array<ArrayBuffer>;
      window.setTimeout(() => {
        if (this.open) this.onMessage?.(copy);
      }, 0);
    });
  }

  send(bytes: Uint8Array): boolean {
    if (!this.open) return false;
    const copy = bytes.slice();
    window.setTimeout(() => {
      if (!this.open) return;
      this.room.receive(this.conn, copy, () => this.who());
    }, 0);
    return true;
  }

  /** Who deskd says this is: the member's role and grants in the guild, and their name in it. */
  private who(): { id: string; name: string; role: GuildRole; grants: string[] } {
    const guildId = guildIdOfPanel(this.deskId) ?? '';
    const me = whoAmI(guildId);
    const name = guildControl.myName ?? useGuildStore.getState().hello[guildId]?.name ?? useSession.getState().me?.displayName ?? 'Member';
    return { id: 'gm-thismember01', name, role: me.role, grants: me.grants };
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    this.room.drop(this.conn);
    this.onEnd?.('ended');
  }
}

// ----- the Notebook and the Agent: an engineering team's guild

const seeded = new Set<string>();

/** The guild's Notebook, once per Guild Desk and browser, before its first session opens. */
export async function seedGuildDesk(deskId: string, notebook: () => Promise<typeof import('./mockNotebook')>): Promise<void> {
  if (!guildControl.seed || seeded.has(deskId)) return;
  seeded.add(deskId);
  const m = await notebook();
  m.mockNotebookControl.presence[deskId] = guildControl.presence;
  const desk = m.mockDesk(deskId);
  if (await desk.hasNotes()) return;
  await desk.local.importData(guildNotes());
}

type PMNode = { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: { type: string }[] };
const t = (text: string, ...marks: string[]): PMNode => ({ type: 'text', text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...c: (PMNode | string)[]): PMNode => ({ type: 'paragraph', content: c.map((x) => (typeof x === 'string' ? t(x) : x)) });
const h = (level: number, text: string): PMNode => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const tasks = (...items: [string, boolean][]): PMNode => ({ type: 'taskList', content: items.map(([x, checked]) => ({ type: 'taskItem', attrs: { checked }, content: [p(x)] })) });
const bullets = (...items: string[]): PMNode => ({ type: 'bulletList', content: items.map((x) => ({ type: 'listItem', content: [p(x)] })) });
const doc = (...blocks: PMNode[]): PMNode => ({ type: 'doc', content: blocks });

function guildNotes() {
  const now = Date.now();
  const nb = { id: 'nb-eng', title: 'Platform team', sortKey: 1, createdAt: now - 30 * 86_400_000, updatedAt: now, rowVersion: 1 };
  const tab = (id: string, title: string, color: string, sortKey: number) => ({ id, notebookId: nb.id, title, color, sortKey, createdAt: nb.createdAt, updatedAt: now, rowVersion: 1 });
  const tabs = [tab('tb-sprint', 'Sprints', 'blue', 1), tab('tb-oncall', 'On-call', 'amber', 2), tab('tb-design', 'Design docs', 'green', 3)];
  const page = (id: string, tabId: string, sortKey: number, body: PMNode, ago: number) => ({
    rec: { id, tabId, sortKey, title: '', snippet: '', wordCount: 0, hasChecklist: false, createdAt: now - ago - 86_400_000, updatedAt: now - ago, deletedAt: null, rowVersion: 1 },
    doc: body,
  });
  const pages = [
    page('pg-s42', 'tb-sprint', 1, doc(
      h(1, 'Sprint 42 plan'),
      p('Goal: checkout p95 under ', t('300 ms', 'bold'), ' before the holiday freeze, and a quieter on-call.'),
      h(2, 'Committed'),
      tasks(['Cache cart totals per session (Priya)', true], ['Split the payments worker into two queues (Marcus)', false], ['Load test at 2x last peak (Jordan)', false], ['Alert on queue depth, not just errors (Sam)', false]),
      h(2, 'Risks'),
      bullets('The card processor sandbox rate-limits at 50 requests a second.', 'Two people out the week of the 24th.'),
      p('Load test results: ', { type: 'text', text: 'grafana.example.com/d/checkout', marks: [{ type: 'link', attrs: { href: 'https://grafana.example.com/d/checkout' } } as unknown as { type: string }] }),
      p('Demo on Friday in Commons, on the Sprint 42 board.'),
    ), 2 * 3600_000),
    page('pg-s41', 'tb-sprint', 2, doc(h(1, 'Sprint 41 retro'), bullets('Went well: zero-downtime migration of the orders table.', 'To change: release notes written before the deploy, not after.')), 9 * 86_400_000),
    page('pg-oncall', 'tb-oncall', 1, doc(
      h(1, 'On-call handbook'),
      p('First step for any page: check the status board, then the last deploy.'),
      tasks(['Acknowledge within 5 minutes', true], ['Post in the Commons incident channel', true], ['Write the timeline while it is fresh', false]),
      p('Dashboards: ', t('https://status.example.com', 'bold')),
    ), 4 * 86_400_000),
    page('pg-gateway', 'tb-design', 1, doc(h(1, 'API gateway: rate limits'), p('Per-key token buckets at the edge, with a shared budget per account. Draft for review.')), 6 * 86_400_000),
  ];
  return { notebooks: [nb], tabs, pages } as unknown as Parameters<import('../../notebook/src/local/localBackend.ts').LocalBackend['importData']>[0];
}

/** The Agent on a Guild Desk: this member's own seat, with a conversation that's theirs alone. */
export function seedGuildAgent(client: unknown): void {
  if (!guildControl.seed) return;
  const now = Date.now();
  const c = client as { threads: Record<string, unknown[]>; agents: { id: string; name: string; status: string; binding: unknown }[]; seqs: Record<string, number>; keys: unknown[] };
  // A neutral model name: the guild demo's shots name no provider's model (the deck's words rules).
  const badge = { provider: 'anthropic', providerName: 'Anthropic', model: 'standard' };
  const usage = (text: string) => ({ inputTokens: 900 + Math.ceil(text.length / 6), cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: Math.ceil(text.length / 4), reasoningTokens: 0 });
  const q = 'Summarize what changed on the Sprint 42 page since Monday, and what still has no owner.';
  const a = 'Since Monday: the cart cache task is done, and the load test moved to Thursday. Two items have no owner yet: the queue-depth alert and the release notes check. Want me to add them to the page as open tasks?';
  // On a Guild Desk a member's agent runs on the guild's key, under the Founder's limits (draft ADR section 7).
  c.keys = [{ keyId: 'k-guild-1', provider: 'anthropic', providerName: 'Anthropic', label: 'Guild key', last4: '7Hq2', createdAt: now - 20 * 86_400_000, createdByDesk: 'Platform team' }];
  const manager = c.agents.find((x) => x.id === 'manager');
  if (manager) {
    manager.name = 'Assistant';
    manager.status = 'online';
    manager.binding = { keyId: 'k-guild-1', provider: 'anthropic', providerName: 'Anthropic', model: 'standard' };
  }
  c.threads['manager'] = [
    { id: 'g1', role: 'user', text: q, at: now - 25 * 60_000 },
    { id: 'g2', role: 'assistant', text: a, at: now - 25 * 60_000 + 6000, badge, usage: usage(a), costMicroUsd: 21_000, stopReason: 'end_turn', state: 'done' },
  ];
  c.seqs['manager'] = 2;
  c.agents.splice(0, c.agents.length, ...c.agents.filter((x) => x.id === 'manager'));
}
