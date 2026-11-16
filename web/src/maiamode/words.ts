// Every sentence Maia Mode's room says (CONCEPT.md Part 1 "What you see", §2 and §9; the tracker's name is "To-do", the owner,
// Nov 12). "Maia Mode" is an internal name only (the owner, Nov 15): members read "Maia", "Maia on my desks" and "Switch to Maia". Calm, short and plain: no exclamation marks, no hype. Desk-written strings never reach these templates as anything
// but plain text, cut to 60 characters (`plain` in `model.ts`).

export const W = {
  room: 'Maia',
  showDesks: 'Show my desks',
  showDesksShort: 'Desks',
  todo: 'To-do',
  collapse: 'Collapse To-do',
  expand: 'Expand To-do',
  now: 'Now',
  next: 'Next',
  later: 'Later',
  nothing: 'Nothing needs you right now.',
  composer: 'Tell Maia what you’d like done…',
  composerPhone: 'Tell Maia…',
  composerOther: 'Your own answer…',
  send: 'Send',
  connecting: 'Connecting to your home desk…',
  offline: 'Your home desk isn’t reachable right now. Your words wait here until it is.',
  thinking: 'Maia is thinking',
  conversation: 'Conversation with Maia',
  // Her rare longer part, folded under her short reply (the owner, Nov 15).
  more: 'More',
  less: 'Less',
  choices: 'Reply choices',
  other: 'Other',
  suggested: 'her pick',
  undo: 'Undo',
  noteFiling: 'Filing…',
  noteFailed: 'Couldn’t save that note',
  noteRemoved: 'Note removed',
  review: 'Review',
  notNow: 'Not now',
  showMe: 'Show me',
  // Her handover card (the documents concept §20.4).
  docCard: 'Document',
  openAtPage: (n: number): string => `Open at page ${n}`,
  whatChanged: 'What changed',
  maiaNote: 'Maia’s note. Open the document to check.',
  openOnDesk: 'Open on my desk',
  openShort: 'Open',
  shownByMaia: 'Shown by Maia',
  closeViewport: 'Close',
  viewport: 'Shown from your desk',
  pauseMotion: 'Pause Maia’s motion',
  // Her briefs' cost in the To-do foot: the member's own agents on their own keys (their provider's bill), never her own usage.
  briefsToday: 'Briefs today',
  briefsOf: 'of',
  yourKeys: 'your keys',
  briefsByDesk: 'Briefs by desk',
  briefsMonth: 'this month',
  briefsTodayShort: 'today',
  // The account menu (`menu.tsx`).
  switchLabel: 'Maia on my desks',
  switchHint: 'Maia works with your desk agents for you',
  openRoom: 'Switch to Maia',
  askAtStartup: 'Ask at startup',
  openIn: 'Open in',
  openLast: 'Last used',
  openMaia: 'Maia',
  openDesk: 'Desks',
  offPending: 'Maia leaves your desks as soon as your home desk is awake.',
  forget: 'Delete Maia’s desk history',
  forgetAsk: 'Delete your chats with Maia and her record of what she filed? The notes and to-dos themselves stay where they are.',
  forgetConfirm: 'Delete history',
  forgetting: 'Deleting…',
  forgotten: 'Maia’s desk history deleted.',
  forgetFailed: 'Your home desk didn’t answer. Try again when it’s awake.',
  cancel: 'Cancel',
  // While you're away (`awayRows.tsx`, Maia Mode Phase 2).
  awayLabel: 'Keep working while I’m away',
  awayHint: 'Maia finishes what you asked while your office is closed, and wakes only the desks you choose below. Messages between your desks pass through our service sealed, so we can’t read them.',
  awayEmail: 'Email me when she needs me',
  awayEmailHint: 'A short note when she has a question or something needs your OK. You answer in your office.',
  awayHoursLabel: 'Hours a day she may keep desks awake',
  awayHours: (n: number) => `${n} h`,
  awayWake: 'Desks she may wake',
  awayDesk: 'A desk',
  awayFailed: 'That didn’t save. Try again in a moment.',
  // Maia's own panel (`MaiaWidget.tsx`).
  panelButton: 'Switch to Maia',
  // The startup chooser (`chooser.ts`).
  chooserQuestion: 'Open your office in',
  chooserLoading: 'Your office is loading',
  chooserMaiaLine: 'Your office, with Maia',
  chooserDeskLine: 'Your desks',
  chooserLast: 'Last used · Enter',
  chooserLastShort: 'Last used',
  chooserAsk: 'Ask every time I open my office',
  stillLoading: 'Still loading your office…',
} as const;

/**
 * The disclosure (§9's draft, for the Sales Engineer to finalise). Accepted once, with a checkbox. Version 2 (Nov 14): Maia runs on
 * Minimalist Alliance's own AI service, within the member's Maia allowance, never on a member's key; a desk that holds only an
 * older acceptance refuses her until the member accepts this one (`deskSource.ts`).
 */
export const DISCLOSURE = {
  version: 2,
  title: 'Before Maia works on your desks',
  lead: 'Your desks step aside, and Maia works with your desk agents for you. Here’s what that means.',
  sections: [
    ['What Maia sees', 'What you tell her, and what your desk agents report back to her. She also sees what your office shows about your desks: their names, whether they’re awake, and what their agents are doing and waiting on. With this on, she can read your desks’ notes, files and messages through your agents, on the desks you allow.'],
    ['Where it’s kept', 'Your chats with her on your desks, and her notes and to-dos, stay on your own desks, in your Notebook. We don’t keep a copy. Chats are removed after 90 days, or sooner if you delete them.'],
    ['What goes to an AI provider', 'Maia runs on Minimalist Alliance’s AI service, within your Maia allowance. What she reads and writes passes through our service to the AI model provider we use, so its model can answer. We don’t keep it or log it, and it’s never used to train AI models. Your desk agents run on your own AI keys or on our credits; what they read and write goes to the provider of each key, or through our service for credits.'],
    ['What she does on her own, and what waits for you', 'She can brief your agents on your own desks, and file notes and to-dos in a “From Maia” section you can undo. Anything that changes your other things, sends outside a desk or costs money waits for your OK.'],
    ['Turning it off', 'Turn it off from your account menu any time. Her access to your desks stops as soon as your home desk hears it. “Delete Maia’s desk history”, in the same menu, deletes your chats with her. The notes and to-dos she filed stay yours, to keep or delete.'],
  ] as const,
  agree: 'I’ve read this',
  notNow: 'Not now',
  turnOn: 'Turn on Maia',
} as const;

/**
 * Her service refused her (her reply's `limit`, deskd §23): one plain line, and no button. With Maia Mode credits that's rare:
 * past the month's credits and top-ups she keeps working on a lighter model, so a refusal means even its share, or the allowance
 * Maia shares across members, is used up. The day and week lines are a shared tier's (no credits), as before. `cap` is the day
 * cap the member set on her, in credits (the desk's own refusal). The reset is added in the member's own time as a date or a time
 * of day, never a countdown (`allowanceLine` in `deskSource.ts`); a reset it can't read leaves the first sentence alone.
 */
export const ALLOWANCE = {
  day: 'You’ve used today’s Maia allowance.',
  week: 'You’ve used this week’s Maia allowance.',
  month: 'You’ve used this month’s Maia allowance.',
  trial: 'You’ve used Maia’s allowance for your trial.',
  pool: 'The allowance Maia shares across members is used up for now.',
  cap: 'Maia has used the credits you set for today.',
  /** The one wallet is used up and the plan has no lighter model (0.4.10 `credits_used`): no reset to name. */
  creditsUsed: 'Your credits are used up for now.',
  /** Today's lighter-model share is used too (0.4.10 `limit_lighter`). */
  lighterDay: 'Today’s lighter-model share is used up.',
  other: 'You’ve used your Maia allowance for now.',
} as const;

/** " It resets tomorrow at 5:00 PM.": `when` is "at 5:00 PM", "tomorrow at 5:00 PM", "on Tuesday at 5:00 PM" or "on December 1". */
export const resetsWords = (when: string): string => `It resets ${when}.`;
/** The month's allowance renews (a refusal for the month): " It renews on December 1." */
export const renewsWords = (when: string): string => `It renews ${when}.`;
/** The member's own cap: " She picks up again tomorrow at 12:00 AM." */
export const picksUpWords = (when: string): string => `She picks up again ${when}.`;

/**
 * Her credits, in the column's foot (ma-platform `desk-maia.md` 0.4.8; the owner, Nov 15): never a dollar figure, never a
 * countdown. The month's renewal is a date in the member's own time (`renewWhen` in `model.ts`). Today's and this week's shares
 * only pace her: when one is used, a plain line says where she's drawing from, and nothing stops.
 */
export const CREDITS = {
  left: (left: string, month: string): string => `Maia credits: ${left} of ${month} left`,
  renews: (when: string): string => `renews ${when}`,
  week: 'Today’s share is used, so Maia is drawing on this week’s.',
  month: 'Today’s and this week’s shares are used, so Maia is drawing on this month’s.',
  topUp: (left: string): string => `This month’s credits are used, so Maia is drawing on your top-up credits: ${left} left.`,
  lighter: (until: string): string => `Your Maia credits are used up, so Maia is on a lighter model until ${until}.`,
  /** A tier that shares its Maia allowance (no credits): the share left, as before. */
  share: (pct: number): string => `Maia allowance: ${pct}% left`,
  /**
   * The member's one wallet (contract 0.4.10), shared by Maia and their agents on MA's credits: what's left, and its parts.
   * The pace and lighter lines say what's in use, not who: either of them may be spending it.
   */
  wallet: (left: string): string => `Credits: ${left} left`,
  walletMonth: (left: string, month: string): string => `${left} of this month’s ${month}`,
  walletStarting: (left: string): string => `${left} starting`,
  walletTopUp: (left: string): string => `${left} top-up`,
  walletWeek: 'Today’s share is used, so this week’s is in use.',
  walletMonthNote: 'Today’s and this week’s shares are used, so this month’s is in use.',
  walletFromStarting: (left: string): string => `This month’s credits are used, so your starting credits are in use: ${left} left.`,
  walletFromTopUp: (left: string): string => `This month’s and your starting credits are used, so your top-up credits are in use: ${left} left.`,
  walletLighter: (until: string | null): string => `Your credits are used up, so Maia and your agents are on a lighter model ${until ? `until ${until}` : 'for now'}.`,
  /** Used up, and the plan has no lighter model (0.4.10 `none`): plain, never "lighter model". */
  walletNone: 'Your credits are used up for now.',
  /** The day cap the member set on her: "Today 12.5 of your 200-credit cap". */
  cap: (today: string, cap: string): string => `Today ${today} of your ${cap}-credit cap`,
} as const;

/** Credits as people read them, in the member's locale: "1,550", "12.5" (2 decimals at most). */
export const creditsWords = (n: number, locale?: string): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);

/** Her AI service didn't answer (her reply's `unavailable`, or a send refused `no_service`). */
export const UNAVAILABLE = 'Maia isn’t available right now. Try again in a few minutes.';

/** "Watching 2 desks · 5 agents · 2 working". */
export function statusWords(s: { desks: number; agents: number | null; working: number | null }): [lead: string, rest: string] {
  const desks = `Watching ${s.desks} ${s.desks === 1 ? 'desk' : 'desks'}`;
  const rest = [s.agents !== null ? `${s.agents} ${s.agents === 1 ? 'agent' : 'agents'}` : null, s.working !== null && s.working > 0 ? `${s.working} working` : null].filter(Boolean);
  return [desks, rest.length ? ` · ${rest.join(' · ')}` : ''];
}

/** The column's head: "1 now · 2 next". */
export function countWords(now: number, next: number): string {
  return [now ? `${now} now` : null, next ? `${next} next` : null].filter(Boolean).join(' · ');
}

/** The collapsed edge's one name: "To-do, 3 items, 1 now". */
export function edgeName(count: number, now: number): string {
  return `${W.todo}, ${count} ${count === 1 ? 'item' : 'items'}${now ? `, ${now} now` : ''}`;
}

/**
 * "$0.84" from a number of dollars, and whole dollars bare ("$5"), as the office shows a price (`formatUsd`). For the member's own
 * money only (her briefs' cost on their own agents and keys); never Maia's own usage, which is credits (the owner, Nov 15).
 */
export const dollars = (usd: number): string => `$${Number.isInteger(usd) ? usd : usd < 10 ? usd.toFixed(2) : Math.round(usd)}`;

/** A To-do item's urgency line ("Due in 40 min", "Overdue since Tue"); the dates are read by code, never from words. */
export function dueWords(minutes: number): string {
  if (minutes < 0) return 'Overdue';
  if (minutes < 60) return `Due in ${Math.max(1, Math.round(minutes))} min`;
  return `Due in ${Math.round(minutes / 60)} h`;
}

/**
 * What reaches the member (the focus shield; deskd API.md §23, CONCEPT.md §8's table, the Product Designer finalises): the held
 * line's menu, the card's and the catch-up's own buttons, To-do as a sheet, All held, and the settings section **What reaches
 * you**. The line, the card's words and the catch-up's lines are the desk's code's (fixed templates); these are the office's.
 * Never "shield", never the room's own name for this, no exclamation marks, never "urgent".
 */
export const R = {
  // The decision tray (the tray spec): members see "Needs you" and papers as things to answer, never "paper" or "tray".
  needsYou: 'Needs you',
  ofN: (i: number, n: number) => `${i} of ${n}`,
  goThrough: 'Go through them',
  needN: (n: number) => (n === 1 ? '1 needs you' : `${n} need you`),
  somethingElse: 'Something else',
  sendBack: 'Send back',
  sendBackTo: (to: string) => `Send back to ${to}`,
  sendTo: (to: string) => `Send to ${to}`,
  cancel: 'Cancel',
  back: 'Back',
  laterPaper: 'Later',
  in20: 'In 20 min',
  fromWriteup: (to: string) => `From ${to}’s write-up`,
  fromSource: 'See where this came from',
  noteHint: (to: string, other: string | null) => (other ? `${to} gets this as your note. Nothing goes to ${other}.` : `${to} gets this as your note.`),
  replyHint: (to: string) => `${to} gets this from you, not from Maia.`,
  readWeb: (to: string) => `${to} read web pages before asking`,
  materials: 'What it’s about',
  closeMaterial: 'Close',
  openIn: (app: string) => `Open in ${app}`,
  readAsText: 'Read as text',
  asleep: (desk: string) => `On your ${desk} desk, which is asleep. Wake it?`,
  wake: 'Wake',
  notNowShort: 'Not now',
  changed: 'This changed since it was shown.',
  showAgain: 'Show it again',
  expired: (at: string) => `Nothing was done. It expired at ${at}.`,
  askAgain: (to: string) => `Ask ${to} again`,
  done: 'Done',
  goneAgent: (to: string, desk: string) => `${to} isn’t on ${desk} anymore. Nothing was sent.`,
  hidden: (to: string) => `Something from ${to}`,
  hiddenLine: 'Hidden while someone can see your screen.',
  queuedLine: (to: string, desk: string) => `Goes to ${to} when ${desk} wakes`,
  wakeDesk: (desk: string) => `Wake ${desk}`,
  sending: 'Sending…',
  failed: 'That didn’t go. Try again.',
  loadingMaterial: 'Opening…',
  materialFailed: 'This couldn’t be opened here.',
  conversationExcerpt: 'The last few messages',
  payloadTitle: 'Exactly what it will do',
  paperName: (title: string) => `To answer: ${title}`,
  answersName: 'Your answer',
  stackName: 'Things that need your answer',
  // Quick reply (the owner, Nov 15): a reply to a person without leaving what you're doing.
  replyTo: (name: string) => `Reply to ${name}`,
  sentTo: (name: string) => `Sent to ${name}`,
  send: 'Send',
  replyFailed: 'That reply didn’t go. It’s still in Courier’s drafts.',
  cantReplyHere: 'This way of sending isn’t set up on that desk yet',
  // The held line and its menu.
  lineName: 'What’s held for you',
  menu: 'Held line options',
  holdAll: 'Hold everything',
  hold30: 'For 30 min',
  holdCatchup: 'Until the next catch-up',
  holdTomorrow: 'Until tomorrow',
  holdStop: 'Stop holding',
  workingOn: (label: string) => `Working on: ${label}`,
  clear: 'Clear',
  settings: 'What reaches you',
  notYet: 'Not yet',
  // The card.
  card: 'From Maia',
  why: 'Why this now',
  change: 'Change',
  more: (n: number) => (n === 1 ? 'And 1 more' : `And ${n} more`),
  keep: 'Keep',
  // Back and the pick-up.
  resumeName: 'Where you were',
  // To-do as a sheet, and All held.
  todo: 'To-do',
  closeTodo: 'Close To-do',
  allHeld: 'All held',
  backToTodo: 'To-do',
  openRoom: 'Open Maia’s room',
  allDesks: 'All desks',
  allKinds: 'All kinds',
  filterDesk: 'Desk',
  filterKind: 'Kind',
  nothingHeld: 'Nothing is held.',
  nothingNow: 'Nothing needs you right now.',
  heldLoading: 'Loading what’s held…',
  heldFailed: 'Your home desk didn’t answer. Try again in a moment.',
  // The catch-up.
  catchup: 'Catch-up',
  later: 'Later',
  laterName: 'Close the catch-up. It stays in To-do.',
  notImportant: 'Not important',
  sooner: 'Sooner next time',
  // What reaches you.
  close: 'Close',
  always: 'Always gets through',
  alwaysHint: 'Up to 5. A desk or agent that’s stuck always gets through too.',
  family: 'Family',
  bossClients: 'My boss or clients',
  team: 'My team',
  dueToday: 'Anything due today',
  money: 'Bills and things to sign',
  waiting: 'Waiting on my reply',
  byName: 'Someone by name…',
  byNameField: 'Their name',
  byNameHint: 'The name goes to your home desk only. Maia asks once which person you meant.',
  add: 'Add',
  remove: (what: string) => `Remove ${what}`,
  removeShort: 'Remove',
  anyTime: 'Any time, quiet hours too',
  full: 'Your list is full. Remove one to add another.',
  holdAllRow: 'Nothing, hold it all',
  catchUps: 'Catch-ups',
  catchThree: 'Start, middle and end of day',
  catchTwo: 'Start and end of day',
  catchOften: 'Every couple of hours',
  catchAsk: 'Only when I ask',
  catchCustom: 'My own times',
  addTime: 'Add a time',
  time: 'Time',
  focus: 'Focus hours',
  focusHint: 'Only what can’t wait reaches you then.',
  mornings: 'Mornings',
  afternoons: 'Afternoons',
  from: 'From',
  to: 'To',
  addSpan: 'Add hours',
  evenings: 'Evenings and weekends',
  holdWork: 'Hold Work',
  letWork: 'Let Work through',
  quiet: 'Quiet hours',
  quietAuto: 'Two hours after my last catch-up, until the first',
  quietOwn: 'My own hours',
  detail: 'Detail',
  detailHint: 'How much Maia writes when she brings you something.',
  line: 'One line',
  paragraph: 'A short paragraph',
  fullPicture: 'The full picture',
  learned: 'What I’ve learned',
  learnedNone: 'Nothing yet. When you say Not important, I hold that kind for catch-ups, and it shows here.',
  undo: 'Undo',
  reset: 'Reset what I’ve learned',
  resetAsk: 'Forget every rule and habit I’ve learned? Your list and settings stay.',
  showAll: 'Show everything as it comes',
  showAllHint: 'Everything comes as it arrives, the way it did before.',
  saveFailed: 'That didn’t save. Try again in a moment.',
  unreachable: 'Your home desk isn’t reachable right now.',
  loading: 'Loading…',
  counts: (held: number, delivered: number) => `Today: ${held} held · ${delivered} brought to you`,
} as const;
