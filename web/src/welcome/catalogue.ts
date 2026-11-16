// Maia's welcome: every question, choice, reason and fixed line (design-drafts/maia-welcome/CONCEPT.md §3 and §4, direction A,
// the owner's pick, Nov 15). The catalogue asks and the model listens: the interviewer on the Platform only picks among these
// ids (ma-platform contract maia.md "Welcome"), so the scripted path runs on this file unchanged. Calm, short and plain: no
// exclamation marks, no "Maia Mode" (an internal name), no dollars or credits. Every line fits 2 caption lines of 42 characters.
// The owner's change: at every question the member may type their own reply or tap a choice, whichever they like, so the
// "Something else" chip of the concept is an input that's always there instead.

export type QId = 'q1' | 'q2' | 'q3' | 'q4' | 'q5' | 'q6' | 'q7' | 'q8' | 't2';

export interface Choice {
  id: string;
  label: string;
  /** Picking it clears the rest, and picking another clears it ("Nothing, hold it all"). */
  only?: boolean;
}

export interface Question {
  id: QId;
  say: string;
  why: string;
  choices: readonly Choice[];
  multi: boolean;
  /** Most picks (multi). */
  max?: number;
  /** What Skip applies. */
  skip: readonly string[];
  /** The placeholder of the always-there input. */
  own: string;
  /** Under the input, small (P3 or P9). */
  ownNote: string;
  /** Free text that never leaves the browser: names (Q4) and a teen's words. */
  local?: boolean;
}

const OWN = 'Or say it in your own words';
const P3 = 'Keep private details for your desks. Passwords and keys never go here.';

export const QUESTIONS: Readonly<Record<QId, Question>> = {
  q1: {
    id: 'q1',
    say: 'First, which light suits you?',
    why: 'Your office changes as you tap.',
    choices: [
      { id: 'light', label: 'Light' },
      { id: 'zen', label: 'Zen' },
      { id: 'dark', label: 'Dark' },
    ],
    multi: false,
    skip: ['zen'],
    own: OWN,
    ownNote: P3,
  },
  q2: {
    id: 'q2',
    say: 'What fills most of your day?',
    why: 'So I know what to bring you first.',
    choices: [
      { id: 'email', label: 'Email and messages' },
      { id: 'meetings', label: 'Meetings' },
      { id: 'writing', label: 'Writing' },
      { id: 'research', label: 'Research' },
      { id: 'numbers', label: 'Numbers and spreadsheets' },
      { id: 'code', label: 'Code' },
    ],
    multi: true,
    skip: [],
    own: OWN,
    ownNote: P3,
  },
  q3: {
    id: 'q3',
    say: 'What would you like help with first?',
    why: 'I’ll set up a helper for each. Pick up to three.',
    choices: [
      { id: 'sorting', label: 'Sorting email' },
      { id: 'research', label: 'Research' },
      { id: 'drafts', label: 'Writing drafts' },
      { id: 'errands', label: 'Errands and bookings' },
      { id: 'todos', label: 'Keeping track of to-dos' },
    ],
    multi: true,
    max: 3,
    skip: [],
    own: OWN,
    ownNote: P3,
  },
  q4: {
    id: 'q4',
    say: 'What should always reach you?',
    why: 'Everything else waits for a good moment.',
    choices: [
      { id: 'family', label: 'Family' },
      { id: 'boss', label: 'My boss or clients' },
      { id: 'due', label: 'Anything due today' },
      { id: 'bills', label: 'Bills and things to sign' },
      { id: 'nothing', label: 'Nothing, hold it all', only: true },
    ],
    multi: true,
    max: 5,
    skip: ['due', 'bills'],
    own: 'Someone by name, or anything else',
    ownNote: 'Names stay on your desk.',
    local: true,
  },
  q5: {
    id: 'q5',
    say: 'When would you like me to catch you up?',
    why: 'I’ll hold the rest until then.',
    choices: [
      { id: 'three', label: 'Start, middle and end of day' },
      { id: 'two', label: 'Start and end of day' },
      { id: 'often', label: 'Every couple of hours' },
      { id: 'ask', label: 'Only when I ask' },
    ],
    multi: false,
    skip: ['three'],
    own: OWN,
    ownNote: P3,
  },
  q6: {
    id: 'q6',
    say: 'When do you do your best focused work?',
    why: 'So I keep those hours quiet.',
    choices: [
      { id: 'mornings', label: 'Mornings' },
      { id: 'afternoons', label: 'Afternoons' },
      { id: 'varies', label: 'It varies, I’ll say when' },
      { id: 'none', label: 'No set times', only: true },
    ],
    multi: true,
    skip: ['none'],
    own: OWN,
    ownNote: P3,
  },
  q7: {
    id: 'q7',
    say: 'When I bring you something, how much?',
    why: 'You can always tap for more.',
    choices: [
      { id: 'line', label: 'One line' },
      { id: 'paragraph', label: 'A short paragraph' },
      { id: 'full', label: 'The full picture' },
    ],
    multi: false,
    skip: ['paragraph'],
    own: OWN,
    ownNote: P3,
  },
  q8: {
    id: 'q8',
    say: 'What may I do without asking?',
    why: 'I always ask before anything leaves a desk.',
    choices: [
      { id: 'notes', label: 'File notes and to-dos' },
      { id: 'drafts', label: 'Draft replies for you to check' },
      { id: 'ask', label: 'Nothing yet, ask me first', only: true },
    ],
    multi: true,
    skip: ['ask'],
    own: OWN,
    ownNote: P3,
  },
  // A teen's second question (§4.4): scripted, and their own words stay in the browser.
  t2: {
    id: 't2',
    say: 'What will you mostly use your desk for?',
    why: 'So the right app is open when you arrive.',
    choices: [
      { id: 'school', label: 'School' },
      { id: 'making', label: 'Making things' },
      { id: 'learning', label: 'Learning something new' },
      { id: 'games', label: 'Games and fun' },
    ],
    multi: false,
    skip: [],
    own: OWN,
    ownNote: 'Your words stay here.',
    local: true,
  },
};

/** The four approved scenes Q1 offers under Zen (ADR 0094's ids), Ocean cliff first: the welcome opens on it. */
export const SCENES: readonly { id: string; label: string }[] = [
  { id: 'ocean-cliff', label: 'Ocean cliff' },
  { id: 'mountain-lake', label: 'Mountain lake' },
  { id: 'snow-ridge', label: 'Snow ridge' },
  { id: 'moonlit-sea', label: 'Moonlit sea' },
];
export const DEFAULT_SCENE = 'ocean-cliff';

/** Acknowledgements (§3.2): the model picks one id; never the same twice in a row. Teens get the first three only. */
export const ACKS = {
  got_it: 'Got it.',
  okay: 'Okay.',
  noted: 'Noted.',
  lovely: 'Lovely.',
  that_helps: 'That helps.',
  good_to_know: 'Good to know.',
} as const;
export type AckId = keyof typeof ACKS;
export const TEEN_ACKS: readonly AckId[] = ['got_it', 'okay', 'noted'];

/** The fixed lines (§3.1, §3.3, §3.4). `{name}` and `{desk}` are code's slots, never the model's. */
export const W = {
  t1: (name: string | null) => (name ? `Hi ${name}, I’m Maia.` : 'Hi, I’m Maia.'),
  t1Teen: 'Hi there, I’m Maia.',
  t2: 'Shall we set up your office together?',
  t2Teen: 'Shall we set up your desk together?',
  t3Long: 'About 4 minutes · Best with headphones',
  t3Short: 'About 3 minutes · Best with headphones',
  t3Teen: 'About 2 minutes · Sound is up to you',
  beginSound: 'Begin with sound',
  beginQuiet: 'Begin quietly',
  beginQuietHint: 'Captions only. Best with a screen reader.',
  explore: 'I’ll explore myself',
  g1: 'I’m an AI, and I’ll look after your office.',
  g1Teen: 'I’m an AI, and I’ll help you set up.',
  g2: 'While your desks get ready, a few quick questions.',
  g2One: 'While your desk gets ready, a few quick questions.',
  p2: 'I ask how you work, never what’s in it.',
  heard: 'Here’s what I heard',
  looksRight: 'Looks right',
  change: 'Change something',
  whichPart: 'Which part?',
  p4: 'This goes onto your desks, not into my memory. Our chat is deleted once it’s set up.',
  c1: 'One thing before I start: here’s what I can see and do.',
  r1: (name: string | null) => (name ? `Your office is ready, ${name}.` : 'Your office is ready.'),
  r1Teen: 'Your desk is ready.',
  showMe: 'Show me around',
  allSet: 'I’m all set',
  f1: 'I’ll be right here.',
  thatsIt: 'That’s it',
  next: 'Next',
  skip: 'Skip',
  send: 'Use my words',
  thisOne: 'This one',
  d1: (desk: string) => `Your ${desk} desk is ready.`,
  d2: 'Your desks are ready. No rush.',
  letsFinish: 'Let’s finish',
  wrapUp: 'Wrap up now',
  s1: (desk: string) => `${desk} is still getting its room. Everything you choose is saved.`,
  s6: 'Free desks wait for room on a shared machine. That can take a while at busy times.',
  keepGoing: 'Keep going',
  goNow: 'Go to my office now',
  s4: (desk: string) => `${desk} is taking longer than it should. We’ve been told.`,
  s5: (desk: string) => `${desk} didn’t start. We’ve been told, and your setup will apply when it does.`,
  talkToPerson: 'Talk to a person',
  goToOffice: 'Go to my office',
  l1: 'Paused.',
  resume: 'Resume',
  finishLater: 'Finish later',
  skipRest: 'Skip the rest',
  l2: 'No problem. I’ve kept your answers for a day.',
  l3: 'Welcome back. Pick up where we left off?',
  pickUp: 'Pick up',
  startOver: 'Start over',
  notNow: 'Not now',
  l4: 'You’re offline. I’ll wait.',
  p6: 'That looked like a password or key, so I cleared it. Keys go in your desk’s own settings.',
  finishing: (desk: string) => `Finishing your ${desk} desk’s setup.`,
  // Fill steps (§4.3).
  fNames: (desk: string) => `While ${desk} gets its room, want to name your desks?`,
  p7: 'Desk names help me and your helpers find the right desk.',
  saveNames: 'Save names',
  keepNames: 'Keep these',
  fTodos: 'Anything on your mind I should put on your list?',
  fTodosTeen: 'Anything coming up you’d like on your list?',
  p5: 'These go straight to your desk. I don’t read them.',
  addTodos: 'Add to my list',
  noTodos: 'Nothing for now',
  fEmail: 'Which email do you use for work?',
  p8: 'Your password goes in Courier’s own form, never to me.',
  fBreath: 'Want to take three slow breaths while I finish?',
  yes: 'Yes',
  noThanks: 'No thanks',
  breatheIn: 'Breathe in',
  breatheMore: 'And a little more',
  breatheOut: 'Breathe out, slowly',
  // Sound controls (§7.2).
  sound: 'Sound',
  mute: 'Mute',
  unmute: 'Turn sound on',
  music: 'Music',
  volume: 'Volume',
  captionsOn: 'Captions are always on',
  pause: 'Pause',
  pauseMotion: 'Pause Maia’s motion',
  // The reveal list (§5.3).
  pencilled: 'pencilled in',
  setsUpWhen: (desk: string) => `Sets up when ${desk} is ready`,
  didntTake: 'Didn’t take',
  tryAgain: 'Try again',
  undo: 'Undo',
  needsKey: 'Needs a key',
  helpersHeld: 'I didn’t add helpers yet: they need credits or your own AI key, which you can add in Agent.',
  addKey: 'Add a key',
  welcome: 'Welcome',
  setUpWithMaia: 'Set up my office with Maia',
  setUpAgain: 'Set up my office again',
  notesTitle: 'Your setup notes',
} as const;

/** "Writing and meetings." from chip labels: the scripted path's echo (§3.2's fallback). */
export function templateEcho(labels: readonly string[]): string | null {
  if (!labels.length) return null;
  const lower = labels.map((l, i) => (i === 0 ? l : l.charAt(0).toLowerCase() + l.slice(1)));
  const joined = lower.length === 1 ? lower[0]! : `${lower.slice(0, -1).join(', ')} and ${lower[lower.length - 1]}`;
  const line = `${joined}.`;
  return line.length <= 60 ? line : `${lower[0]} and more.`;
}

/** The labels of the ids, in the question's order. */
export function labelsOf(q: Question, ids: readonly string[]): string[] {
  return q.choices.filter((c) => ids.includes(c.id)).map((c) => c.label);
}

/** The helper templates (§5.2). `desk` is where it lives: `work` with two desks, else the one; `home` is the Personal desk. */
export interface HelperTemplate {
  id: 'sorting' | 'research' | 'drafts' | 'errands' | 'todos';
  name: string;
  desk: 'work' | 'personal' | 'home';
  apps: { notebook: boolean; files: boolean; browser: boolean; courier: boolean; todos: boolean };
  purpose: string;
}

export const HELPERS: Readonly<Record<HelperTemplate['id'], HelperTemplate>> = {
  sorting: { id: 'sorting', name: 'Inbox', desk: 'work', apps: { notebook: true, files: false, browser: false, courier: true, todos: true }, purpose: 'Sorts new email, files to-dos, drafts replies for you to check. Never sends.' },
  research: { id: 'research', name: 'Research', desk: 'work', apps: { notebook: true, files: true, browser: true, courier: false, todos: false }, purpose: 'Looks things up and writes short findings in Notebook.' },
  drafts: { id: 'drafts', name: 'Drafts', desk: 'work', apps: { notebook: true, files: true, browser: false, courier: false, todos: false }, purpose: 'Turns notes into first drafts in Notebook.' },
  errands: { id: 'errands', name: 'Errands', desk: 'personal', apps: { notebook: false, files: false, browser: true, courier: false, todos: true }, purpose: 'Finds options and gets bookings ready. Asks before anything is booked or paid.' },
  todos: { id: 'todos', name: 'To-dos', desk: 'home', apps: { notebook: true, files: false, browser: false, courier: false, todos: true }, purpose: 'Keeps your list tidy and reminds you at catch-ups.' },
};
/**
 * A helper the model named from the member's own words: Notebook and To-do on, Files, Browser and Courier off until the member
 * turns them on in the Agent app (Security's WEL-4: a purpose the model wrote gets the least).
 */
export const CUSTOM_APPS = { notebook: true, files: false, browser: false, courier: false, todos: true } as const;

/** Q7 "One line": every helper's purpose gets this (§5.1). */
export const ONE_LINE_PURPOSE = 'Keep reports to one line unless asked.';

/** Q5's mapping onto today's attention fields (§5.1), until the shield's catch-ups exist. */
export const CATCH_UPS: Readonly<Record<string, { interruptEveryMin: number; batchEveryMin: number; visible?: number }>> = {
  three: { interruptEveryMin: 60, batchEveryMin: 240 },
  two: { interruptEveryMin: 120, batchEveryMin: 240 },
  often: { interruptEveryMin: 30, batchEveryMin: 120 },
  ask: { interruptEveryMin: 120, batchEveryMin: 240, visible: 1 },
};

/** Q2 or Q3 mentions email: F3 may ask which (with Courier on). */
export const mentionsEmail = (a: Partial<Record<QId, readonly string[]>>): boolean => (a.q2 ?? []).includes('email') || (a.q3 ?? []).includes('sorting');

/** The email providers F3 offers (Courier's named tiles). */
export const PROVIDERS: readonly { id: string; label: string }[] = [
  { id: 'gmail', label: 'Gmail' },
  { id: 'outlook', label: 'Outlook' },
  { id: 'icloud', label: 'iCloud Mail' },
  { id: 'fastmail', label: 'Fastmail' },
  { id: 'other', label: 'Other' },
];
