// A stand-in for Desk Maia, for `npm run dev` and the shell specs only: never in a production bundle (`room.tsx` imports it
// behind `import.meta.env.MODE`, and `build-release.mjs` fails on its names). Demo data only: example.org, no key, no member's
// name. `window.__maMaiaModeMock` steers it from a spec: `say`, `now`, `show`, `link`, `problem`, `clear`, and `log`, every call the room made.
import { EMPTY_ROOM, type AttentionItem, type ChoiceSet, type RoomMessage, type RoomSource, type RoomState, type ShowRequest, type ViewApp } from './source';

interface Steer {
  say(text: string, options?: string[]): void;
  /**
   * Her reply arriving as a model streams it: in uneven bursts of a few words, some close together and some far apart (a seeded
   * pattern, the same every run), then her choices. For the glide's smoothness check.
   */
  stream(text: string, options?: string[]): void;
  now(item: Partial<AttentionItem> & { title: string }): void;
  clearNow(): void;
  problem(line: string, action: string | null): void;
  /** An empty thread, as a new member's: her history gone without the menu. */
  clear(): void;
  show(deskId: string, app: ViewApp): void;
  /** Her handover (deskd API.md §24): a reply with a document's card under it, drawn from that desk's own `docs.get`. */
  handover(text: string, docId?: string, deskId?: string): void;
  link(state: RoomState['link']): void;
  desks(): MockDesk[];
  log: { method: string; args: unknown[] }[];
}

/** The mock's desks: the office's own list, so names and ids are real ones under the fixtures. */
export interface MockDesk {
  id: string;
  name: string;
}

/** The mock desk's sample contract (`desk/mockDeskDocs.ts`), on the Personal desk. */
const CONTRACT = 'd_01JCMA00000000000000000001';

let n = 0;
const id = (p: string): string => `${p}-${(n += 1)}`;

export function MockRoomSource(desks: () => MockDesk[]): RoomSource {
  const fns = new Set<() => void>();
  const work = (): MockDesk => desks().find((d) => /work/i.test(d.name)) ?? desks()[0] ?? { id: 'd-none', name: 'Work' };
  const personal = (): MockDesk => desks().find((d) => /personal/i.test(d.name)) ?? desks()[0] ?? work();
  const t0 = Date.now() - 40 * 60_000;
  const choices = (options: string[]): ChoiceSet => ({ id: id('c'), options: options.map((label, i) => ({ id: `o${i + 1}`, label })), answered: null });
  let state: RoomState = {
    ...EMPTY_ROOM,
    link: 'ready',
    messages: [
      { id: id('m'), from: 'maia', text: 'Morning. Your desks are quiet, and nothing needs you yet.', at: t0 },
      { id: id('m'), from: 'member', text: 'Anything I should know about today?', at: t0 + 60_000 },
      { id: id('m'), from: 'maia', text: 'Just one: the Q3 deck is due Friday. I’ve asked Writer to start an outline on your Work desk.', at: t0 + 90_000 },
      { id: id('m'), from: 'member', text: 'Can you have Scout compare three laptops under $1,000?', at: t0 + 600_000 },
      { id: id('m'), from: 'maia', text: 'On it. Scout’s reading reviews on your Work desk now. I’ll tell you when it’s ready.', at: t0 + 620_000 },
      { id: id('m'), from: 'member', text: 'Remind me to call the venue about Saturday. And the Q3 budget review moved to Thursday.', at: t0 + 1_500_000 },
      {
        id: id('m'), from: 'maia', text: 'Got it, both noted.', at: t0 + 1_520_000,
        notes: [
          { id: 'n-personal', line: `Noted for ${personal().name}`, state: 'filed', undo: 'ap-personal' },
          { id: 'n-work', line: `Noted for ${work().name}`, state: 'filed', undo: 'ap-work' },
        ],
      },
      {
        id: id('m'), from: 'maia', text: 'Writer has the newsletter ready to go through the sign-up form on example.org. Sending outside your desk is always your call.', at: t0 + 2_000_000,
        card: { id: 'k-writer', deskId: work().id, level: 'send', agentName: 'Writer', title: 'Submit the sign-up form on example.org' },
      },
      { id: id('m'), from: 'maia', text: 'Scout’s comparison is ready too. Want it now, or after the newsletter?', at: t0 + 2_100_000, choices: choices(['Show me now', 'After the newsletter', 'Tomorrow']) },
    ],
    status: { desks: Math.max(1, desks().length), agents: 5, working: 2 },
    foot: { onIt: 2, doneToday: 5, briefs: { todayUsd: 1.2, monthUsd: 8.4, budgetUsd: 3, desks: [{ deskId: work().id, name: work().name, todayUsd: 0.8, monthUsd: 6.1 }, { deskId: personal().id, name: personal().name, todayUsd: 0.4, monthUsd: 2.3 }] } },
    // Her credits, never money (the owner, Nov 15): the month renews in 16 days; today's share is used, so this week's pays.
    allowance: { fraction: 0.62, resetsAt: new Date(t0 + 16 * 86_400_000).toISOString(), usedUp: false, lighter: false, credits: { month: 2500, monthLeft: 1550, topUpLeft: 0, drawingFrom: 'week', left: 1760, starting: 210, lighterLeft: null }, today: 12.5, cap: null },
    attention: [
      { id: 'writer-form', kind: 'approval', deskId: work().id, urgency: 'now', title: 'Writer wants to submit a form on example.org', meta: 'Sends outside your desk, so it’s your call', go: { kind: 'view', app: 'agent', ref: 'k-writer' }, at: t0 + 2_000_000 },
      { id: 'scout-done', kind: 'result', deskId: work().id, urgency: 'next', title: 'Scout’s laptop comparison is ready', meta: 'Finished 20 min ago', go: { kind: 'view', app: 'notebook', ref: null }, at: t0 + 2_100_000 },
      { id: 'notes-today', kind: 'notes', deskId: work().id, urgency: 'later', title: '6 notes taken today', meta: null, go: { kind: 'view', app: 'notebook', ref: null }, at: t0 },
      { id: 'personal-asleep', kind: 'desk_asleep', deskId: personal().id, urgency: 'later', title: 'Personal is asleep', meta: null, go: { kind: 'wake' }, at: t0 },
    ],
  };
  let seq = 0;
  const set = (patch: Partial<RoomState>): void => {
    state = { ...state, ...patch };
    for (const f of fns) f();
  };
  const log: Steer['log'] = [];
  const push = (m: Omit<RoomMessage, 'id' | 'at'>): void => set({ messages: [...state.messages, { ...m, id: id('m'), at: Date.now(), live: true }] });
  const answer = (setId: string, a: NonNullable<ChoiceSet['answered']>): void =>
    set({ messages: state.messages.map((m) => (m.choices?.id === setId ? { ...m, choices: { ...m.choices, answered: a } } : m)) });
  const show = (r: ShowRequest): void => set({ show: { ...r, seq: (seq += 1) } });
  const reply = (text: string): void => {
    set({ busy: true });
    setTimeout(() => {
      set({ busy: false });
      if (/contract|document/i.test(text)) {
        push({ from: 'maia', text: 'Here’s the contract Rosa sent. Page 3 is the change.', doc: { deskId: personal().id, docId: CONTRACT } });
      } else if (/show|notes?\b|today/i.test(text)) {
        push({ from: 'maia', text: 'Six so far: four for Work and two for Personal. Here are Work’s, filed by its Lead. Undo any you don’t want.' });
        show({ deskId: work().id, app: 'notebook', ref: null });
      } else if (/option|choice|choose|pick/i.test(text)) {
        push({ from: 'maia', text: 'Which should Writer start with?', choices: choices(['The Q3 deck', 'The newsletter', 'The vendor list']) });
      } else push({ from: 'maia', text: 'On it. I’ll tell you when it’s done.' });
    }, 250);
  };
  const source: RoomSource = {
    get: () => state,
    subscribe(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    send(text, answering) {
      log.push({ method: 'send', args: [text, answering ?? null] });
      if (answering) answer(answering.choices, answering.as === 'other' ? { kind: 'other', text } : { kind: 'ignored' });
      push({ from: 'member', text });
      reply(text);
    },
    choose(messageId, optionId) {
      log.push({ method: 'choose', args: [messageId, optionId] });
      const m = state.messages.find((x) => x.id === messageId);
      if (!m?.choices) return;
      const label = m.choices.options.find((o) => o.id === optionId)?.label ?? '';
      answer(m.choices.id, { kind: 'option', id: optionId });
      push({ from: 'member', text: label });
      reply(label);
    },
    undoNote(noteId) {
      log.push({ method: 'undoNote', args: [noteId] });
      set({ messages: state.messages.map((m) => (m.notes ? { ...m, notes: m.notes.map((x) => (x.undo === noteId ? { ...x, state: 'undone' as const, undo: null } : x)) } : m)) });
    },
    snooze(itemId) {
      log.push({ method: 'snooze', args: [itemId] });
      set({ attention: state.attention.map((a) => (a.id === itemId || (a.go.kind === 'view' && a.go.ref === itemId) ? { ...a, urgency: 'later' as const } : a)) });
    },
    setOn(on) {
      log.push({ method: 'setOn', args: [on] });
      return Promise.resolve(true);
    },
    forget() {
      log.push({ method: 'forget', args: [] });
      set({ messages: [] });
      return Promise.resolve(true);
    },
    typing(on) {
      log.push({ method: 'typing', args: [on] });
    },
    seen(back) {
      log.push({ method: 'seen', args: [back] });
    },
    fix() {
      log.push({ method: 'fix', args: [] });
      set({ problem: null });
    },
    close() {
      fns.clear();
    },
  };
  if (import.meta.env.MODE !== 'production') {
    const steer: Steer = {
      say: (text, options) => push({ from: 'maia', text, ...(options ? { choices: choices(options) } : {}) }),
      stream: (text, options) => {
        const words = text.split(/(?<=\s)/);
        const mid = id('m');
        set({ busy: true, messages: [...state.messages, { id: mid, from: 'maia', text: '', at: Date.now(), live: true }] });
        let seed = 7;
        const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        let at = 400;
        for (let i = 0; i < words.length; ) {
          const n = 1 + Math.floor(rnd() * 6);
          const chunk = words.slice(i, i + n).join('');
          i += n;
          at += rnd() < 0.3 ? 400 + rnd() * 500 : 15 + rnd() * 60;
          setTimeout(() => set({ messages: state.messages.map((m) => (m.id === mid ? { ...m, text: m.text + chunk } : m)) }), at);
        }
        setTimeout(() => set({ busy: false, messages: state.messages.map((m) => (m.id === mid && options ? { ...m, choices: choices(options) } : m)) }), at + 60);
      },
      now: (item) => set({ noticeAt: Date.now(), attention: [...state.attention.filter((a) => a.urgency !== 'now'), { id: id('a'), kind: 'approval', deskId: work().id, urgency: 'now', meta: null, go: { kind: 'view', app: 'agent', ref: null }, at: Date.now(), ...item }] }),
      problem: (line, action) => set({ problem: { line, action } }),
      clear: () => set({ messages: [] }),
      clearNow: () => set({ attention: state.attention.filter((a) => a.urgency !== 'now') }),
      show: (deskId, app) => show({ deskId, app, ref: null }),
      handover: (text, docId = CONTRACT, deskId = personal().id) => push({ from: 'maia', text, doc: { deskId, docId } }),
      link: (link) => set({ link }),
      desks: () => desks(),
      log,
    };
    (window as unknown as Record<string, unknown>)['__maMaiaModeMock'] = steer;
  }
  return source;
}

// ----- What reaches the member (the focus shield), for `npm run dev` and the shell specs with `?shield`: a sample `reach` on the
// held line, a card with a rider, Back after its one thing, a catch-up, Hold everything, All held and What reaches you, all on a
// stand-in desk (`setReachStandIn`). `window.__maShieldMock` steers it: `card()`, `offer()`, `catchup()`, `back()`, `clear()`,
// `log`, every call the line made. Demo data only.

interface ShieldSteer {
  card(): void;
  offer(): void;
  catchup(): void;
  back(): void;
  heads(): void;
  clear(): void;
  /** Something may break through on Personal's agents: its tile keeps the accent (`reach.accent`). */
  accent(): void;
  /** The decision tray: three papers waiting (Scout's laptop question, Writer's two sends), and a catch-up with them. */
  tray(): void;
  /** A person's message as an offer card (quick reply), from the mock Courier's direct thread on Personal. */
  message(): Promise<void>;
  log: { method: string; params: Record<string, unknown> }[];
}

export function startMockReach(): () => void {
  let stopped = false;
  // The office's own fixture desks: real ids under the fixtures, so a card's one thing opens a real tile.
  let deskList: { id: string; name: string; kind: string }[] = [];
  let readReach: (r: unknown) => unknown = () => null;
  let setReach: (patch: Record<string, unknown>) => void = () => undefined;
  void Promise.all([import('../state/deskStore'), import('./reach'), import('./focusSource'), import('../state/tileCalm')]).then(([d, r, f, t]) => {
    deskList = d.useDeskStore.getState().desks.filter((x) => x.kind !== 'guild').map((x) => ({ id: x.id, name: x.name, kind: x.kind }));
    readReach = r.readReach;
    setReach = (patch) => {
      f.useReach.setState(patch as never);
      // The tiles follow the stand-in's `reach` too: still counts, the accent where the card's item waits.
      t.setTileCalm((patch['reach'] as Parameters<typeof t.setTileCalm>[0]) ?? null);
    };
    f.setReachStandIn(answer);
    push();
  });
  const work = (): { id: string; name: string } => deskList.find((d) => d.kind === 'work') ?? deskList[0] ?? { id: 'd-work', name: 'Work' };
  const personal = (): { id: string; name: string } => deskList.find((d) => d.kind === 'personal') ?? deskList[0] ?? { id: 'd-personal', name: 'Personal' };
  const log: ShieldSteer['log'] = [];
  let seq = 0;
  let card: Record<string, unknown> | null = null;
  let back: Record<string, unknown> | null = null;
  let catchup: Record<string, unknown> | null = null;
  let hold: number | null = null;
  let accentOn = false;
  let working: string | null = 'Q3 plan';
  let heads = false;
  // The decision tray's sample papers (demo data only): built as the home desk builds them (`maia/Tray.java`).
  let papers: Record<string, unknown>[] = [];
  let filed: Record<string, unknown>[] = [];
  let laterN = 0;
  const pid = (n: number): string => `pp-${'abcdefghijklmnopqrstuvwxyz234567'[n]!.repeat(20)}`;
  const contract = 'd_01JCMA00000000000000000001';
  const fri = (): number => {
    const d = new Date();
    d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
    d.setHours(17, 0, 0, 0);
    return d.getTime();
  };
  // The approvals behind the two approval papers, on the mock work desk's agent: Approve shows only once one loads and its hash
  // checks out, as on a real desk.
  const seedApprovals = (): void => {
    const agent = (window as unknown as { __maDeskMock?: { agent?: { seedApproval?: (deskId: string, seed: unknown) => void } } }).__maDeskMock?.agent;
    const at = Date.now();
    agent?.seedApproval?.(work().id, { id: 'ap-mockmockmockmockmock', agentId: 'writer', tool: 'mock_send', risk: 'send', title: 'Send the Acme proposal to Sam Lee', payload: { to: 'Sam Lee', subject: 'Acme proposal v3' }, expiresAt: at + 3 * 3_600_000 + 10 * 60_000 });
    agent?.seedApproval?.(work().id, { id: 'ap-mocknewsnewsnewsnews', agentId: 'writer', tool: 'mock_send', risk: 'send', title: 'Send the November newsletter', payload: { to: '412 readers', subject: 'November newsletter' }, expiresAt: at + 2 * 3_600_000 + 40 * 60_000 });
  };
  const makePapers = (): Record<string, unknown>[] => [
    {
      paperId: pid(0), itemId: 'mi-result', kind: 'report',
      asker: { kind: 'agent', deskId: work().id, label: `${work().name} · Scout`, name: 'Scout' },
      title: 'Pick a laptop for Dana’s team',
      line: { text: 'Three fit the $1,200 budget. Scout leans to the X1 Carbon for battery life; the Air is lighter and $150 less.', by: 'maia', from: 'm-writeup' },
      answers: [{ id: 'a1', label: 'X1 Carbon', does: 'custom', value: 'X1 Carbon' }, { id: 'a2', label: 'MacBook Air', does: 'custom', value: 'MacBook Air' }, { id: 'a3', label: 'Look again', does: 'custom', value: 'Look again' }],
      pick: 0, freeform: { to: 'Scout', max: 2000, as: 'message' }, later: { allowed: true, until: Date.now() + 4 * 3_600_000, kind: 'catchup' }, dismissable: true,
      materials: [{ materialId: 'm-writeup', kind: 'writeup', deskId: personal().id, ref: { docId: contract }, label: 'Write-up' }, { materialId: 'm-doc', kind: 'doc', deskId: personal().id, ref: { docId: contract }, label: 'Comparison' }],
      reply: { kind: 'maia_brief', deskId: work().id, messageId: 'msg-1' }, dueAt: fri(), expiresAt: null, untrusted: true, risk: null, state: 'open', laterCount: 0, at: Date.now() - 600_000,
    },
    {
      paperId: pid(1), itemId: 'mi-approval', kind: 'approval',
      asker: { kind: 'agent', deskId: work().id, agentId: 'writer', label: `${work().name} · Writer`, name: 'Writer' },
      title: 'Send the Acme proposal to Sam Lee',
      line: { text: 'Same as v2 except pricing on page 2: $18,400, down from $19,900. Writer’s note asks about the support option.', by: 'maia', from: 'm-doc' },
      answers: [{ id: 'approve', label: 'Approve…', does: 'approve', confirm: { verb: 'send' } }, { id: 'revise', label: 'Ask for changes', does: 'revise' }, { id: 'decline', label: 'Decline', does: 'decline' }],
      pick: null, freeform: { to: 'Writer', max: 500, as: 'note' }, later: { allowed: true, until: Date.now() + 3 * 3_600_000, kind: 'catchup' }, dismissable: false,
      materials: [{ materialId: 'm-doc', kind: 'doc', deskId: personal().id, ref: { docId: contract }, label: 'Proposal v3' }, { materialId: 'm-payload', kind: 'payload', deskId: work().id, ref: { approvalId: 'ap-mockmockmockmockmock' }, label: 'Writer’s note' }],
      reply: { kind: 'approval', deskId: work().id, approvalId: 'ap-mockmockmockmockmock', agentId: 'writer' }, dueAt: null, expiresAt: Date.now() + 3 * 3_600_000 + 10 * 60_000, untrusted: false, risk: 'send', state: 'open', laterCount: 0, at: Date.now() - 300_000,
    },
    {
      paperId: pid(2), itemId: 'mi-approval', kind: 'approval',
      asker: { kind: 'agent', deskId: work().id, agentId: 'writer', label: `${work().name} · Writer`, name: 'Writer' },
      title: 'Send the November newsletter',
      line: { text: '412 readers. The Acme story moved to the top, and every link was checked this morning.', by: 'maia', from: 'm-writeup' },
      answers: [{ id: 'approve', label: 'Approve…', does: 'approve', confirm: { verb: 'send' } }, { id: 'revise', label: 'Ask for changes', does: 'revise' }, { id: 'decline', label: 'Decline', does: 'decline' }],
      pick: null, freeform: { to: 'Writer', max: 500, as: 'note' }, later: { allowed: false, until: null, kind: null }, dismissable: false,
      materials: [{ materialId: 'm-doc', kind: 'doc', deskId: personal().id, ref: { docId: contract }, label: 'Newsletter' }, { materialId: 'm-writeup', kind: 'writeup', deskId: personal().id, ref: { docId: contract }, label: 'Write-up' }],
      reply: { kind: 'approval', deskId: work().id, approvalId: 'ap-mocknewsnewsnewsnews', agentId: 'writer' }, dueAt: null, expiresAt: Date.now() + 2 * 3_600_000 + 40 * 60_000, untrusted: false, risk: 'send', state: 'open', laterCount: 0, at: Date.now() - 200_000,
    },
  ];
  // A person's direct thread on the mock Courier (Personal), for quick reply's card, row and paper: ids from the desk itself.
  let person: { channelId: string; contactId: string } | null = null;
  const readPerson = async (): Promise<{ channelId: string; contactId: string } | null> => {
    if (person) return person;
    try {
      const f = await import('./focusSource');
      const r = (await f.deskRead(personal().id, 'courier.attention', {})) as { threads?: { channelId: string; kind: string; contactIds?: string[] }[] };
      // One whose way of sending can send (a desk's receive-only address can't), as the office shows the reply arrow.
      const q = await import('./shield/quickReply');
      for (const t of (r.threads ?? []).filter((x) => x.kind === 'direct' && x.contactIds?.length)) {
        const c = await q.replyContext({ deskId: personal().id, channelId: t.channelId, who: null });
        // The mock Courier sends by email only (an MA message's relay isn't in it).
        if (c.canSend && c.medium === 'email') {
          person = { channelId: t.channelId, contactId: t.contactIds![0]! };
          break;
        }
      }
    } catch {
      person = null;
    }
    return person;
  };
  const replyPaper = (p: { channelId: string; contactId: string }): Record<string, unknown> => ({
    paperId: pid(3), itemId: 'mi-message', kind: 'reply',
    asker: { kind: 'person', deskId: personal().id, who: { deskId: personal().id, contactId: p.contactId }, label: `${personal().name} · {who}`, name: '{who}' },
    title: '{who} is waiting on your reply',
    line: { text: '{who} wrote yesterday · waiting on your reply', by: 'code', from: null },
    answers: [{ id: 'reply', label: 'Reply', does: 'reply' }, { id: 'remind', label: 'Remind me tomorrow', does: 'follow_up', value: String(Date.now() + 86_400_000) }, { id: 'none', label: 'No reply needed', does: 'done' }],
    pick: 0, freeform: { to: '{who}', max: 2000, as: 'reply' }, later: { allowed: true, until: Date.now() + 3 * 3_600_000, kind: 'catchup' }, dismissable: true,
    materials: [{ materialId: 'm-thread', kind: 'thread', deskId: personal().id, ref: { channelId: p.channelId }, label: 'Conversation' }],
    reply: { kind: 'courier', deskId: personal().id, channelId: p.channelId }, dueAt: null, expiresAt: null, untrusted: true, risk: null, state: 'open', laterCount: 0, at: Date.now() - 100_000,
  });
  const trayView = (): Record<string, unknown> | null => (papers.length || filed.length ? { count: papers.length + laterN, now: papers.length, later: laterN, papers, filed } : null);
  let settings: Record<string, unknown> = {
    letThrough: [
      { ruleId: 'mr-due', kind: 'match', match: 'due_today', anyTime: false, source: 'welcome' },
      { ruleId: 'mr-money', kind: 'match', match: 'money', anyTime: false, source: 'welcome' },
      { ruleId: 'mr-rosa', kind: 'person', person: { pendingName: 'Rosa' }, anyTime: false, source: 'welcome' },
    ],
    holdAll: false,
    catchUps: ['09:00', '13:00', '17:00'],
    focusHours: [{ from: '09:00', to: '12:00' }],
    quietHours: null,
    evenings: 'hold',
    detail: 'paragraph',
    showAll: false,
  };
  let learned = [{ ruleId: 'ml-news', line: 'Newsletters wait for catch-ups (you said Not important, Nov 14)', at: Date.now() - 86_400_000 }];
  const clock = (at: number): string => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
  const line = (): Record<string, unknown> => {
    if (heads) return { kind: 'heads_up', text: 'One thing in a moment', held: 6, dot: 'accent', action: null };
    if (back) return { kind: 'back', text: back['label'], held: 6, dot: 'none', action: { kind: 'back', cardId: back['cardId'] } };
    if (catchup && catchup['waiting']) return { kind: 'catchup', text: 'Your 1:00 catch-up is ready', held: 6, dot: 'none', action: { kind: 'catchup', catchupId: catchup['catchupId'] } };
    if (hold) return { kind: 'hold', text: `Holding until ${clock(hold)} · your list still gets through`, held: 6, dot: 'none', action: null };
    return { kind: 'held', text: '6 held · nothing urgent', held: 6, dot: 'none', action: null };
  };
  const push = (): void => {
    if (stopped) return;
    seq += 1;
    setReach({
        reach: readReach({ on: !settings['showAll'], device: null, line: line(), card, catchup, back, working: working ? { label: working } : null, hold: hold ? { until: hold } : null, held: { count: 6, now: card && card['level'] === 'interrupt' ? 1 : 0 }, tray: trayView(), accent: [...(card && card['level'] === 'interrupt' && typeof card['deskId'] === 'string' ? [{ deskId: card['deskId'], app: card['kind'] === 'message' ? 'courier' : 'agent', agentId: null }] : []), ...(accentOn ? [{ deskId: personal().id, app: 'agent', agentId: null }] : [])] }),
        room: {
          todo: {
            items: [
              { id: 'mi-approval', kind: 'approval', deskId: work().id, urgency: 'now', title: 'Writer wants to send the newsletter', action: { kind: 'approvals', deskId: work().id, approvalIds: ['ap-1'] }, createdAt: Date.now() - 120_000 },
              { id: 'mi-result', kind: 'result', deskId: work().id, urgency: 'next', title: 'Scout’s laptop comparison is ready', action: { kind: 'show', deskId: work().id, app: 'notebook', ref: null }, createdAt: Date.now() - 600_000 },
            ],
            later: { count: 6, lines: ['4 updates', '2 receipts'] },
          },
        },
        ready: true,
    });
  };
  const newCard = (level: 'interrupt' | 'offer'): void => {
    heads = false;
    const id = `mc-${seq + 1}`;
    card =
      level === 'interrupt'
        ? {
            cardId: id, itemId: 'mi-approval', level, kind: 'approval', deskId: work().id, source: `${work().name} · Writer`, what: 'Writer needs your OK to send the newsletter.', why: 'Expires in 40 min',
            whyMore: 'You asked to hear about money right away', go: { kind: 'approvals', deskId: work().id, approvalIds: ['ap-1'] }, goLabel: 'Review',
            choices: [{ id: 'in_20', label: 'In 20 min' }], quote: null, first: null, after: null, at: Date.now(), tuckAt: null,
            more: [{ itemId: 'mi-due', kind: 'todo', source: `${personal().name} · To-do`, what: 'Call the venue about Saturday is due at 3:00.', why: 'Due today', go: { kind: 'show', deskId: personal().id, app: 'todo', ref: null }, goLabel: 'Open' }],
          }
        : {
            cardId: id, itemId: 'mi-result', level, kind: 'result', deskId: work().id, source: `${work().name} · Scout`, what: 'Scout’s laptop comparison is ready.', why: 'For the Q3 plan',
            whyMore: null, go: { kind: 'show', deskId: work().id, app: 'notebook', ref: null }, goLabel: 'See result',
            choices: [{ id: 'after_this', label: 'After this' }, { id: 'not_now', label: 'Not now' }], quote: null, first: { text: 'I let this through because it’s for what you’re working on.', choices: [{ id: 'keep', label: 'Keep' }, { id: 'not_for_this', label: 'Not for this' }] }, after: null, at: Date.now(), tuckAt: Date.now() + 20_000, more: [],
          };
    push();
  };
  const offerBack = (cardId: string): void => {
    back = { cardId, label: `Back to ${working ?? 'Notebook'}`, resume: `You were on ${working ?? 'your page'} in Notebook, ${work().name}. Last change 3 min ago.`, deskId: work().id, app: 'notebook', item: null, surface: 'desk', until: Date.now() + 60_000 };
    push();
  };
  const ok = (v: unknown = {}): Promise<unknown> => new Promise((r) => setTimeout(() => r(v), 120));
  function answer(method: string, params: Record<string, unknown>): Promise<unknown> {
      log.push({ method, params });
      switch (method) {
        case 'agent.maia.reach.answer': {
          const a = params['answer'];
          if (params['catchupId']) {
            if (a === 'dismiss') catchup = null;
            else if (a === 'open' && catchup) catchup = { ...catchup, waiting: false };
            else if (params['questionId'] && catchup) catchup = { ...catchup, question: null };
          } else if (a === 'replied') {
            if (card && (params['cardId'] === card['cardId'] || params['itemId'] === card['itemId'])) card = null;
          } else if (card && (params['cardId'] === card['cardId'] || params['itemId'] === card['itemId'])) {
            const id = String(card['cardId']);
            if (a === 'go') {
              card = null;
              setTimeout(() => offerBack(id), 1_500);
            } else if (a === 'not_now' || a === 'at_catchup') {
              card = { ...card, after: { text: 'Held until 1:00', choices: [{ id: 'not_important', label: 'Not important' }, { id: 'undo', label: 'Undo' }], until: Date.now() + 5_000 } };
              setTimeout(() => {
                if (card && card['cardId'] === id) card = null;
                push();
              }, 5_000);
            } else if (a === 'keep' || a === 'not_for_this') card = { ...card, first: null };
            else card = null;
          }
          push();
          return ok();
        }
        case 'agent.maia.tray.get': {
          if (params['paperId']) return ok({ paper: papers.find((p) => p['paperId'] === params['paperId']) ?? null });
          return ok({ papers, out: [] });
        }
        case 'agent.maia.tray.answer': {
          if (params['outId']) return ok({});
          const p = papers.find((x) => x['paperId'] === params['paperId']);
          if (!p) return Promise.reject(Object.assign(new Error('conflict'), { code: 'conflict' }));
          const answers = p['answers'] as { id: string; label: string; does: string }[];
          const a = answers.find((x) => x.id === params['answerId']);
          const label = params['answerId'] === 'custom' ? (p['kind'] === 'approval' ? 'Sent back with your note' : 'Your reply') : (a?.label ?? '');
          papers = papers.filter((x) => x !== p);
          filed = [{ paperId: p['paperId'], kind: p['kind'], label: a?.id === 'approve' ? 'Sent' : label, to: (p['asker'] as { name: string }).name, who: (p['asker'] as { who?: unknown }).who ?? null, state: 'sent', at: Date.now() }, ...filed].slice(0, 5);
          setTimeout(push, 200);
          // A reply to a person goes for real to the mock desk's Courier (the office carries it); the rest stop here.
          if (p['kind'] === 'reply' && params['text']) return ok({ deliver: 'office', outId: `po-${'m'.repeat(20)}`, paper: { ...p, state: 'sending' } });
          return ok({ deliver: 'none', paper: { ...p, state: 'answered' } });
        }
        case 'agent.maia.tray.later': {
          const p = papers.find((x) => x['paperId'] === params['paperId']);
          if (!p) return Promise.reject(Object.assign(new Error('not_found'), { code: 'not_found' }));
          papers = papers.filter((x) => x !== p);
          laterN += 1;
          setTimeout(push, 200);
          return ok({ paper: p, until: Date.now() + 3 * 3_600_000 });
        }
        case 'agent.maia.reach.back':
          back = null;
          push();
          return ok();
        case 'agent.maia.reach.hold':
          hold = params['clear'] ? null : Date.now() + (typeof params['minutes'] === 'number' ? params['minutes'] * 60_000 : 3 * 3_600_000);
          push();
          return ok({ hold: hold ? { until: hold } : null });
        case 'agent.maia.reach.working.clear':
          working = null;
          push();
          return ok();
        case 'agent.maia.reach.held':
          return ok({
            items: [
              { itemId: 'mh-1', kind: 'result', deskId: work().id, deskName: work().name, title: 'Scout’s laptop comparison is ready', level: 'periphery', reason: 'Read later', at: Date.now() - 600_000 },
              { itemId: 'mh-2', kind: 'message', deskId: personal().id, deskName: personal().name, title: 'New messages in a group', level: 'hold', reason: 'Held for the catch-up', at: Date.now() - 1_200_000 },
              { itemId: 'mh-3', kind: 'notes', deskId: work().id, deskName: work().name, title: '6 notes taken today', level: 'hold', reason: 'Held for the catch-up', at: Date.now() - 3_600_000 },
              ...(person ? [{ itemId: 'mh-4', kind: 'message', deskId: personal().id, deskName: personal().name, title: '{who} wrote on Personal', level: 'periphery', reason: 'Waiting on your reply', at: Date.now() - 300_000, who: { deskId: personal().id, contactId: person.contactId }, go: { kind: 'show', deskId: personal().id, app: 'courier', ref: person.channelId } }] : []),
            ].filter((i) => (!params['deskId'] || i.deskId === params['deskId']) && (!params['kind'] || i.kind === params['kind'])),
          });
        case 'agent.maia.reach.get':
          return ok({ reach: { ...settings, learned, counts: { heldToday: 6, deliveredToday: 2, missedThisWeek: 0 } } });
        case 'agent.maia.reach.set':
          settings = { ...settings, ...params };
          push();
          return ok({ reach: { ...settings } });
        case 'agent.maia.reach.learned.undo':
          learned = learned.filter((l) => l.ruleId !== params['ruleId']);
          return ok({ reach: { ...settings, learned } });
        case 'agent.maia.reach.learned.reset':
          learned = [];
          return ok({ reach: { ...settings, learned } });
        default:
          return Promise.reject(Object.assign(new Error('not_found'), { code: 'not_found' }));
      }
  }
  const steer: ShieldSteer = {
    tray: () => {
      papers = makePapers();
      seedApprovals();
      filed = [];
      laterN = 0;
      steer.catchup();
      // A person's paper only where Courier can send (the office's switch), as the home desk would have one.
      void Promise.all([readPerson(), import('../apps/courier/door')]).then(([p, door]) => {
        if (p && papers.length && door.courierOn()) {
          papers = [...papers, replyPaper(p)];
          push();
        }
      });
    },
    message: async () => {
      const p = await readPerson();
      if (!p) return;
      heads = false;
      card = {
        cardId: `mc-${seq + 1}`, itemId: 'mi-message', level: 'offer', kind: 'message', deskId: personal().id, source: `${personal().name} · {who}`, what: '{who} wrote on Personal', why: 'Waiting on your reply since yesterday',
        whyMore: null, go: { kind: 'show', deskId: personal().id, app: 'courier', ref: p.channelId }, goLabel: 'Open',
        choices: [{ id: 'after_this', label: 'After this' }, { id: 'not_now', label: 'Not now' }], quote: { deskId: personal().id, channelId: p.channelId }, who: { deskId: personal().id, contactId: p.contactId },
        first: null, after: null, at: Date.now(), tuckAt: null, more: [],
      };
      push();
    },
    accent: () => {
      accentOn = true;
      push();
    },
    card: () => newCard('interrupt'),
    offer: () => newCard('offer'),
    catchup: () => {
      catchup = {
        catchupId: `cu-${seq + 1}`, kind: 'catchup', head: papers.length ? 'Your 1:00 catch-up · 5 things · nothing urgent' : 'Your 1:00 catch-up · 5 things, nothing urgent', waiting: false, at: Date.now(), end: 'That’s all for now.',
        groups: [
          { id: 'needs_you', label: 'Needs you', items: [{ itemId: 'mi-approval', line: 'Writer needs your OK to send the newsletter', go: { kind: 'approvals', deskId: work().id, approvalIds: ['ap-1'] }, goLabel: 'Review', choices: [{ id: 'sooner', label: 'Sooner next time' }] }], summary: null },
          { id: 'working_on', label: 'Working on', items: [{ itemId: 'mi-result', line: 'Scout’s laptop comparison is ready', go: { kind: 'show', deskId: work().id, app: 'notebook', ref: null }, goLabel: 'Open', choices: [{ id: 'not_important', label: 'Not important' }, { id: 'sooner', label: 'Sooner next time' }] }], summary: null },
          { id: 'read_later', label: 'Read later', items: [], summary: '4 updates' },
          { id: 'records', label: 'Records', items: [], summary: '2 receipts' },
        ],
        lines: ['Cleared without you: 3'],
        question: { questionId: 'keep_for_catchups', text: 'You’ve held these three times. Keep them for catch-ups?', choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
      };
      push();
    },
    back: () => offerBack(`mc-${seq}`),
    heads: () => {
      heads = true;
      push();
      setTimeout(() => newCard('interrupt'), 8_000);
    },
    clear: () => {
      card = null;
      back = null;
      catchup = null;
      papers = [];
      filed = [];
      laterN = 0;
      hold = null;
      heads = false;
      push();
    },
    log,
  };
  (window as unknown as Record<string, unknown>)['__maShieldMock'] = steer;
  const q = new URLSearchParams(location.search).get('shield');
  if (q === 'card') setTimeout(() => newCard('interrupt'), 300);
  if (q === 'catchup') setTimeout(() => steer.catchup(), 300);
  if (q === 'tray') setTimeout(() => steer.tray(), 300);
  return () => {
    stopped = true;
    void import('./focusSource').then((m) => m.setReachStandIn(null));
    delete (window as unknown as Record<string, unknown>)['__maShieldMock'];
  };
}
