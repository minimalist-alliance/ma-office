// The welcome's talk, beat by beat (CONCEPT.md §2): the threshold, the greeting, the questions with an acknowledgement and an
// echo after each, desk events in the gaps, the fill steps while a desk builds, "Here's what I heard", Maia's consent, the
// apply, the reveal and the farewell. One store, outside React; `WelcomeLayer.tsx` draws it. Nothing advances a question by
// time: a line holds for its reading time (`readMs`), and a question waits for the member as long as they like.
import { create } from 'zustand';
import { useDeskStore, type DeskInfo } from '../state/deskStore';
import { getLive } from '../desk/liveStore';
import { onMemberChange } from '../platform/auth';
import { setLayoutPref } from '../shell/layoutSync';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { setThemePref, getTheme } from '../theme/themeStore';
import { chooseBackground } from '../theme/backdrop';
import { ACKS, DEFAULT_SCENE, QUESTIONS, TEEN_ACKS, W, labelsOf, mentionsEmail, templateEcho, type QId } from './catalogue';
import { FOLLOW_UP_CAP, STEP_CAP, fillSteps, nextQuestion, offerWrapUp, onlyKnown, pickAck, questionSet, readMs, resolved, skipped, stepsTaken, type Answer, type Fill, type FollowUp, type Who } from './flow';
import { MODEL_WAIT_MS, forgetTalk, newTalkId, sendPlan, sendTurn, type TurnReply } from './net';
import { attentionFor, callbackFor, checkHelper, checkModelPlan, heardLines, mergePlan, helpersFrom, setupNotesDoc, type Callback, type HeardLine, type ModelHelper, type OwnDesk } from './plan';
import { asksSecret, cleanText, placeLocally } from './secret';
import { namesFrom, reachFor } from './seams';
import { enqueue, type NewItem } from './apply';
import type { WelcomeAudio } from './audio/engine';

export type Phase =
  | 'threshold'
  | 'resume'
  | 'greeting'
  | 'ask'
  | 'listening'
  | 'ack'
  | 'event'
  | 'fill'
  | 'heard'
  | 'consent'
  | 'reveal'
  | 'farewell'
  | 'later'
  | 'done';

export type DeskStep = 'placing' | 'making' | 'starting' | 'ready' | 'failed';

export interface StageDesk {
  id: string;
  kind: string;
  name: string;
  step: DeskStep;
}

export interface Start {
  who: Who;
  name: string | null;
  base: string | null;
  model: boolean;
  /** A talk kept from before (L3), or the answers to preselect on a redo. */
  kept: { talkId: string; answers: Answer[]; followUps: FollowUp[] } | null;
  redo: boolean;
  /** A free member: S6's honest line for "Making room". */
  free: boolean;
  /** Maia's desk role is on already: no consent sheet. */
  maiaOn: boolean;
}

interface WelcomeState {
  phase: Phase;
  /** Phase before Pause, to go back to it. */
  paused: Phase | null;
  who: Who;
  name: string | null;
  base: string | null;
  model: boolean;
  free: boolean;
  set: QId[];
  talkId: string;
  answers: Record<string, Answer>;
  followUps: FollowUp[];
  /** The question on screen: a catalogue id, `f1`/`f2`, or null. */
  current: string | null;
  fill: Fill | null;
  fillsDone: Fill[];
  picks: string[];
  /** Preselected by a redo or a kept talk. */
  scene: string;
  /** Maia's big line, and the secondary line under her (the echo, a reason, a privacy line). */
  line: string;
  sub: string | null;
  /** Choices under an event line (D2, S4, S5, S6, L3). */
  eventChoices: { id: string; label: string }[];
  /** A short notice (P6, L4), polite. */
  notice: string | null;
  lastAck: string | null;
  acks: number;
  custom: ModelHelper | null;
  /** Desk events already said, once each. */
  said: string[];
  wrapUpOffered: boolean;
  /** "Change something": the question re-asked, then back to the summary. */
  changing: boolean;
  heard: HeardLine[];
  /** What "Here's what I heard" shows, and so what applies: the answers with the plan's reading of their words. */
  resolvedAnswers: Partial<Record<QId, string[]>> | null;
  callback: Callback | null;
  /** The pencilled helpers on the stage, by desk id. */
  pencilled: Record<string, string[]>;
  /** Q4's names, to-dos and desk names: this browser and the desk only. */
  names: string[];
  todos: string[];
  deskNames: Record<string, string>;
  email: string | null;
  /** The sound: on at "Begin with sound". */
  sound: { on: boolean; music: boolean; volume: number; muted: boolean };
  maiaOn: boolean | null;
  startedAt: number;
}

const NO_WHO: Who = { teen: false, tier: null, maia: false, shield: false, rename: false, courier: false };

const INITIAL = (): WelcomeState => ({
  phase: 'threshold',
  paused: null,
  who: NO_WHO,
  name: null,
  base: null,
  model: false,
  free: false,
  set: [],
  talkId: '',
  answers: {},
  followUps: [],
  current: null,
  fill: null,
  fillsDone: [],
  picks: [],
  scene: DEFAULT_SCENE,
  line: '',
  sub: null,
  eventChoices: [],
  notice: null,
  lastAck: null,
  acks: 0,
  custom: null,
  said: [],
  wrapUpOffered: false,
  changing: false,
  heard: [],
  resolvedAnswers: null,
  callback: null,
  pencilled: {},
  names: [],
  todos: [],
  deskNames: {},
  email: null,
  sound: { on: false, music: true, volume: 0.7, muted: false },
  maiaOn: null,
  startedAt: 0,
});
export const useWelcomeRun = create<WelcomeState>(INITIAL);

const get = useWelcomeRun.getState;
const set = useWelcomeRun.setState;

// ----- audio (its own chunk, fetched while the threshold shows; "Begin quietly" never starts it)
let audio: WelcomeAudio | null = null;
let audioModule: Promise<typeof import('./audio/engine')> | null = null;
let audioMod: typeof import('./audio/engine') | null = null;
/** The engine's chunk (about 4 KB), fetched while the threshold shows, so "Begin with sound" can start it inside the press. */
export const prefetchAudio = (): void => {
  audioModule ??= import('./audio/engine');
  audioModule.then(
    (m) => (audioMod = m),
    () => (audioModule = null),
  );
};
export const audioReady = (): boolean => audioMod !== null;
export const getAudio = (): WelcomeAudio | null => audio;

// ----- timers: one line at a time
let timer: number | undefined;
const after = (ms: number, then: () => void): void => {
  window.clearTimeout(timer);
  timer = window.setTimeout(then, ms);
};
export const stopTimers = (): void => window.clearTimeout(timer);

// ----- desks
export function ownDesks(desks: readonly DeskInfo[] = useDeskStore.getState().desks): DeskInfo[] {
  return desks.filter((d) => (d.kind === 'personal' || d.kind === 'work') && !d.removed && !d.ended && !d.notInPlan);
}

export function stepOf(d: DeskInfo): DeskStep {
  const live = getLive(d.id);
  // The desk answering on its own session is ready, whatever the list's last word; a free desk waiting for room is making room.
  if (live.link === 'open') return 'ready';
  if (live.busy) return 'making';
  if (d.vm === 'error') return 'failed';
  if (d.vm === 'setting-up') return d.queuePosition != null ? 'making' : 'placing';
  if (d.vm === 'running') return d.phase == null || d.phase === 'ready' ? 'ready' : 'starting';
  if (d.vm === 'stopped' || d.vm === 'held') return 'ready';
  if (d.vm === 'starting' && d.queuePosition != null) return 'making';
  return 'starting';
}

export const stageDesks = (desks?: readonly DeskInfo[]): StageDesk[] => ownDesks(desks).map((d) => ({ id: d.id, kind: d.kind, name: kindName(d), step: stepOf(d) }));
const kindName = (d: DeskInfo): string => d.name || (d.kind === 'work' ? 'Work' : 'Personal');
const asOwn = (): OwnDesk[] => ownDesks().map((d) => ({ id: d.id, kind: d.kind, name: get().deskNames[d.id] ?? kindName(d) }));
const allReady = (): boolean => stageDesks().every((d) => d.step === 'ready');

// ----- the start
export function begin(start: Start): void {
  const answers: Record<string, Answer> = {};
  const redo = start.redo && start.kept;
  for (const a of start.kept?.answers ?? []) answers[a.q] = a;
  // Every run starts from nothing of the last one's (Security's WEL-10): no to-dos, names or helper carried over.
  prior = {};
  pendingPlan = null;
  set({
    ...INITIAL(),
    phase: start.kept && !start.redo ? 'resume' : start.redo ? 'greeting' : 'threshold',
    who: start.who,
    name: start.who.teen ? null : start.name,
    base: start.who.teen ? null : start.base,
    model: start.model && !start.who.teen,
    free: start.free,
    set: questionSet(start.who),
    talkId: start.kept?.talkId ?? newTalkId(),
    // A redo starts at Q1 with the last answers selected; a kept talk resumes where it was.
    answers: redo ? {} : answers,
    followUps: start.kept?.followUps ?? [],
    line: '',
    startedAt: Date.now(),
    maiaOn: start.maiaOn ? true : null,
  });
  if (redo) prior = answers;
  // Every welcome opens in Zen with Ocean cliff (§13), except under more contrast, where it keeps the device's Light or Dark
  // with no photo; Q1 then lets them choose. "I'll explore myself" puts their own light back.
  if (!start.redo && !window.matchMedia('(prefers-contrast: more)').matches && getTheme().resolved !== 'dusk') {
    themeBefore = getTheme().pref;
    setThemePref({ mode: 'dusk' });
  }
  if (start.kept && !start.redo) set({ line: W.l3, eventChoices: [{ id: 'pickUp', label: W.pickUp }, { id: 'startOver', label: W.startOver }, { id: 'notNow', label: W.notNow }] });
  if (start.redo) greet();
}

/** A redo's last answers, to preselect. */
let prior: Record<string, Answer> = {};
/** The member's light before the welcome opened in Zen. */
let themeBefore: ReturnType<typeof getTheme>['pref'] | null = null;

/** "Begin with sound" (inside the press, the gesture browsers need) or "Begin quietly". */
export function beginWith(sound: boolean): void {
  if (sound) startSound();
  greet();
}

/** The music, from a press (the gesture browsers need): "Begin with sound", or the speaker after a quiet beginning. */
export function startSound(): void {
  const go = (m: typeof import('./audio/engine')): void => {
    if (audio) {
      audio.setMuted(false);
      set({ sound: { ...get().sound, on: true, muted: false } });
      return;
    }
    const a = m.createWelcomeAudio();
    audio = a;
    const s = get();
    a.setVolume(s.sound.volume);
    a.setMusic(s.sound.music);
    set({ sound: { ...s.sound, on: true, muted: false } });
    void a.start().then((ok) => {
      if (!ok) {
        audio = null;
        set({ sound: { ...get().sound, on: false } });
        return;
      }
      // Joining late: the layers the talk has reached so far.
      if (Object.keys(get().answers).length) a.answered();
      const ready = stageDesks().filter((d) => d.step === 'ready').length;
      if (ready) a.deskReady(ready);
    });
  };
  if (audioMod) go(audioMod);
  else void import('./audio/engine').then(go, () => undefined);
}

function greet(): void {
  const { who } = get();
  const g1 = who.teen ? W.g1Teen : W.g1;
  const g2 = ownDesks().length > 1 ? W.g2 : W.g2One;
  set({ phase: 'greeting', line: g1, sub: null, eventChoices: [] });
  after(readMs(g1, who.teen) + 400, () => {
    set({ line: g2 });
    after(readMs(g2, who.teen) + 400, () => askNext(null));
  });
}

// ----- questions
function askNext(modelPick: string | null): void {
  const s = get();
  if (s.changing) return toHeard();
  // A follow-up the model wrote comes first, once (at most two per welcome, §4.2).
  const fu = s.followUps.find((f) => !s.answers[f.id]);
  if (fu) return ask(fu.id);
  const q = nextQuestion(s.set, s.answers, modelPick);
  if (q && stepsTaken(s.answers, s.fillsDone) < STEP_CAP) return ask(q);
  return toFill();
}

export function ask(id: string): void {
  const s = get();
  const fu = s.followUps.find((f) => f.id === id);
  const q = fu ? null : QUESTIONS[id as QId];
  if (!fu && !q) return;
  const was = s.answers[id] ?? prior[id];
  const picks = was ? (fu ? was.choices : onlyKnown(id as QId, was.choices)) : id === 'q1' ? [themeChoice()] : [];
  set({
    phase: 'ask',
    current: id,
    picks,
    line: fu ? fu.question : q!.say,
    sub: fu ? null : q!.why,
    eventChoices: [],
    notice: null,
  });
}

const themeChoice = (): string => {
  const r = getTheme().resolved;
  return r === 'dusk' ? 'zen' : r;
};

/** A tap on a choice: Q1 changes the office live; a single choice moves on 300 ms after the tap (§4.1). */
export function pick(id: string): void {
  const s = get();
  const cur = s.current;
  if (s.phase !== 'ask' || !cur) return;
  const fu = s.followUps.find((f) => f.id === cur);
  const picks = fu ? [id] : toggleFor(cur as QId, s.picks, id);
  set({ picks });
  if (cur === 'q1') liveTheme(id);
  const single = fu || !QUESTIONS[cur as QId].multi;
  if (single && cur !== 'q1') after(300, () => submit());
}

function toggleFor(q: QId, picks: string[], id: string): string[] {
  const def = QUESTIONS[q];
  const choice = def.choices.find((c) => c.id === id);
  if (!choice) return picks;
  if (!def.multi) return [id];
  if (picks.includes(id)) return picks.filter((p) => p !== id);
  if (choice.only) return [id];
  const kept = picks.filter((p) => !def.choices.find((c) => c.id === p)?.only);
  return def.max && kept.length >= def.max ? kept : [...kept, id];
}

/** Q1 live: the office's light as they tap; Zen opens the scene row (the scene is chosen with "This one"). */
export function liveTheme(id: string): void {
  const mode = id === 'zen' ? 'dusk' : id === 'dark' ? 'dark' : 'light';
  setThemePref({ mode });
  if (id === 'zen') chooseBackground(get().scene);
}

export function pickScene(scene: string): void {
  set({ scene });
  chooseBackground(scene);
}

/** "That's it", "Next", Enter, or "Use my words": the answer goes, with the member's own words if they typed some. */
export function submit(rawText = ''): void {
  const s = get();
  const cur = s.current;
  if (s.phase !== 'ask' || !cur) return;
  window.clearTimeout(timer);
  const q = QUESTIONS[cur as QId] as (typeof QUESTIONS)[QId] | undefined;
  const { text, cleared } = cleanText(rawText);
  if (cleared) {
    // P6: cleared here, never sent; the question stays for another try.
    set({ notice: W.p6 });
    if (!s.picks.length) return;
  }
  // Q4's words and a teen's stay in this browser (P9): names go to the home desk only.
  const local = !!q?.local || s.who.teen;
  if (cur === 'q4' && text) set({ names: namesFrom(text) });
  const answer: Answer = { q: cur, choices: [...s.picks], text: local ? null : text };
  if (local && text && cur !== 'q4') answer.choices = answer.choices.length ? answer.choices : placeLocally(cur as QId, text);
  if (!answer.choices.length && !answer.text && !(cur === 'q4' && text)) return skip();
  commit(answer, local ? null : text, cur === 'q4' && !!text);
}

export function skip(): void {
  const s = get();
  const cur = s.current;
  if (!cur || s.phase !== 'ask') return;
  window.clearTimeout(timer);
  const isFu = cur === 'f1' || cur === 'f2';
  const a: Answer = isFu ? { q: cur, choices: [], text: null, skipped: true } : skipped(cur as QId);
  if (cur === 'q1') liveTheme('zen');
  commit(a, null, false);
}

function commit(answer: Answer, text: string | null, byName: boolean): void {
  const s = get();
  const answers = { ...s.answers, [answer.q]: answer };
  set({ answers, phase: 'listening', notice: null });
  audio?.answered();
  const detail = answers['q7']?.choices[0] ?? null;
  // What goes up: ids, the member's words (not Q4's, not a teen's), and `byName` for a name typed under Q4.
  const wire = { q: answer.q, choices: byName ? [...answer.choices.filter((c) => c !== 'nothing'), 'byName'].slice(0, 5) : answer.choices, text, skipped: !!answer.skipped && !answer.choices.length };
  if (wire.skipped) wire.choices = [];
  const usesModel = s.model && !s.who.teen && !!s.base;
  const reply = usesModel ? sendTurn(s.base, { talkId: s.talkId, set: s.set, answer: wire, detail }) : Promise.resolve(null);
  if (!usesModel && s.base && !s.who.teen) void sendTurn(s.base, { talkId: s.talkId, set: s.set, answer: wire, detail }, MODEL_WAIT_MS).catch(() => undefined);
  void reply.then((r) => heardBack(answer, r));
}

function heardBack(answer: Answer, r: TurnReply | null): void {
  const s = get();
  if (s.phase !== 'listening') return;
  if (r?.cleared) set({ notice: W.p6 });
  let answers = s.answers;
  // The model's reading of their words onto this question's ids, checked again; and questions their words already answered.
  // q8's answers are permissions: they come from taps alone, never from a reading of words (Security's WEL-1).
  if (r && answer.text && r.placed && !answer.choices.length && (r.placed.q ?? answer.q) === answer.q && answer.q in QUESTIONS && answer.q !== 'q8') {
    const ids = onlyKnown(answer.q as QId, r.placed.choices);
    if (ids.length) answers = { ...answers, [answer.q]: { ...answer, choices: ids } };
  } else if (!r && answer.text && !answer.choices.length && answer.q in QUESTIONS && answer.q !== 'q8') {
    const ids = onlyKnown(answer.q as QId, placeLocally(answer.q as QId, answer.text));
    if (ids.length) answers = { ...answers, [answer.q]: { ...answer, choices: ids } };
  }
  for (const p of r?.preAnswered ?? []) {
    if (!s.set.includes(p.q as QId) || answers[p.q] || p.q === 'q8') continue;
    const ids = onlyKnown(p.q as QId, p.choices);
    if (ids.length) answers = { ...answers, [p.q]: { q: p.q, choices: ids, text: null, pre: true } };
  }
  const custom = answer.q === 'q3' && r?.helper ? (checkHelper(r.helper, s.name) ?? s.custom) : s.custom;
  const usedFollowUps = s.followUps.length;
  const followUps = r?.followUp && usedFollowUps < FOLLOW_UP_CAP && !s.followUps.some((f) => f.id === r.followUp!.id) && plainFollowUp(r.followUp) ? [...s.followUps, { ...r.followUp, after: answer.q }] : s.followUps;
  const allowed = s.who.teen ? TEEN_ACKS : (Object.keys(ACKS) as string[]);
  const ackId = pickAck(r?.ack ?? null, s.lastAck, allowed, s.acks);
  const echo = r?.echo && echoOk(r.echo, s) ? r.echo : scriptedEcho(answer, answers);
  const ack = ACKS[ackId as keyof typeof ACKS];
  set({ answers, custom, followUps, lastAck: ackId, acks: s.acks + 1, phase: 'ack', line: ack, sub: echo, pencilled: pencilledNow(answers, custom) });
  after(Math.max(readMs(`${ack} ${echo ?? ''}`, s.who.teen), 1600), () => gap(r?.next ?? null));
}

/** A follow-up from the model, checked as `ask_member` is: plain, short, 2 to 4 distinct choices, never asking for a secret. */
function plainFollowUp(f: { question: string; choices: string[] }): boolean {
  const plain = (t: string) => t.length > 0 && !/[<>*_`#[\]]|https?:/i.test(t) && !/maia mode/i.test(t) && !asksSecret(t);
  return plain(f.question) && f.question.length <= 60 && f.choices.length >= 2 && f.choices.length <= 4 && new Set(f.choices.map((c) => c.toLowerCase())).size === f.choices.length && f.choices.every((c) => plain(c) && c.length <= 28);
}

/** The model's echo, checked by code (§3.2): no name, no markup, no promises, no "Maia Mode", short once Q7 says one line. */
function echoOk(echo: string, s: WelcomeState): boolean {
  const max = s.answers['q7']?.choices[0] === 'line' ? 32 : 60;
  if (echo.length > max || /[<>*_`#[\]{}]|https?:|www\./i.test(echo) || /maia mode|\bi will\b|\bi promise\b|\bguarantee/i.test(echo) || asksSecret(echo)) return false;
  return !(s.name && echo.toLowerCase().includes(s.name.toLowerCase()));
}

function scriptedEcho(answer: Answer, answers: Record<string, Answer>): string | null {
  const q = QUESTIONS[answer.q as QId];
  if (!q) return null;
  const a = answers[answer.q] ?? answer;
  if (answer.skipped) return null;
  const echo = templateEcho(labelsOf(q, a.choices));
  if (!echo) return answer.text ? 'In your own words.' : null;
  return answers['q7']?.choices[0] === 'line' && echo.length > 32 ? null : echo;
}

function pencilledNow(answers: Record<string, Answer>, custom: ModelHelper | null): Record<string, string[]> {
  const q3 = answers['q3'] ? onlyKnown('q3', answers['q3'].choices) : [];
  const out: Record<string, string[]> = {};
  for (const h of helpersFrom(q3, custom, asOwn(), undefined)) (out[h.deskId] ??= []).push(h.name);
  return out;
}

/** The gap after an acknowledgement: a desk line goes here, never over a question (§3.3). */
function gap(modelPick: string | null): void {
  const s = get();
  const desks = stageDesks();
  const ready = desks.filter((d) => d.step === 'ready');
  // D2: every desk ready with 3 or more core questions left.
  if (!s.wrapUpOffered && desks.length && offerWrapUp(s.set, s.answers, ready.length === desks.length) && !s.changing) {
    set({ wrapUpOffered: true, phase: 'event', line: W.d2, sub: null, eventChoices: [{ id: 'finish', label: W.letsFinish }, { id: 'wrap', label: W.wrapUp }] });
    nextPick = modelPick;
    audio?.deskReady(ready.length);
    return;
  }
  // D1: the first desk ready, and it isn't the only one.
  if (desks.length > 1 && ready.length >= 1 && !s.said.includes('d1')) {
    const line = W.d1(ready[0]!.name);
    set({ said: [...s.said, 'd1'], phase: 'event', line, sub: null, eventChoices: [] });
    audio?.deskReady(ready.length);
    after(readMs(line, s.who.teen) + 300, () => askNext(modelPick));
    return;
  }
  if (ready.length >= 2) audio?.deskReady(ready.length);
  askNext(modelPick);
}
let nextPick: string | null = null;

/** An event's choice (D2, S1 to S6, L3). */
export function choose(id: string): void {
  switch (id) {
    case 'finish':
      return askNext(nextPick);
    case 'wrap':
    case 'skipRest':
      return toHeard();
    case 'keepGoing':
      return toHeard();
    case 'goNow':
    case 'goToOffice':
      return toHeard();
    case 'talk':
      window.open('https://minimalistalliance.com/contact', '_blank', 'noopener');
      return;
    case 'pickUp':
      return greet();
    case 'startOver': {
      void forgetTalk(get().base);
      set({ answers: {}, followUps: [], talkId: newTalkId(), phase: 'threshold', line: '', eventChoices: [] });
      return;
    }
    case 'notNow':
      return later();
  }
}

// ----- fill steps (§4.3)
function toFill(): void {
  const s = get();
  if (allReady() || stepsTaken(s.answers, s.fillsDone) >= STEP_CAP) return toHeard();
  const r = resolved(s.set, s.answers);
  const next = fillSteps(s.who, ownDesks().length, mentionsEmail(r), s.fillsDone)[0];
  if (!next) return slowLine();
  const notReady = stageDesks().find((d) => d.step !== 'ready');
  const line = next === 'names' ? W.fNames(notReady?.name ?? 'your desk') : next === 'todos' ? (s.who.teen ? W.fTodosTeen : W.fTodos) : next === 'email' ? W.fEmail : W.fBreath;
  const sub = next === 'names' ? W.p7 : next === 'todos' ? W.p5 : next === 'email' ? W.p8 : null;
  set({ phase: 'fill', fill: next, current: null, line, sub, eventChoices: [] });
}

/** A fill step's answer: names, to-dos, email or the breath. */
export function fillDone(fill: Fill, value?: { names?: Record<string, string>; todos?: string[]; email?: string | null }): void {
  const s = get();
  const patch: Partial<WelcomeState> = { fillsDone: [...s.fillsDone, fill] };
  if (value?.names) patch.deskNames = { ...s.deskNames, ...value.names };
  if (value?.todos) patch.todos = value.todos.map((t) => cleanText(t).text).filter((t): t is string => !!t).slice(0, 3);
  if (value?.email !== undefined) patch.email = value.email;
  set(patch);
  toFill();
}

/** S1, S6, S4, S5: a desk still isn't ready once the fill steps are done. */
function slowLine(): void {
  const s = get();
  const slow = stageDesks().find((d) => d.step !== 'ready');
  if (!slow) return toHeard();
  const mins = (Date.now() - s.startedAt) / 60_000;
  if (slow.step === 'failed') return event(W.s5(slow.name), [{ id: 'talk', label: W.talkToPerson }, { id: 'goToOffice', label: W.goToOffice }]);
  if (mins > 10) return event(W.s4(slow.name), [{ id: 'talk', label: W.talkToPerson }, { id: 'goToOffice', label: W.goToOffice }]);
  if (s.free && slow.step === 'making') return event(W.s6, [{ id: 'keepGoing', label: W.keepGoing }, { id: 'goNow', label: W.goNow }]);
  const line = W.s1(slow.name);
  set({ phase: 'event', line, sub: null, eventChoices: [] });
  after(readMs(line, s.who.teen) + 300, () => toHeard());
}

function event(line: string, choices: { id: string; label: string }[]): void {
  set({ phase: 'event', line, sub: null, eventChoices: choices });
}

// ----- Here's what I heard (§2 beat 6)
export function toHeard(): void {
  const s = get();
  set({ phase: 'listening', changing: false, current: null, fill: null, line: W.heard, sub: null, eventChoices: [] });
  // The model's plan comes before the summary (Security's WEL-1), so "Looks right" approves exactly what applies.
  const plan = s.model && s.base && !s.who.teen ? sendPlan(s.base, s.talkId, s.set, resolved(s.set, s.answers).q7?.[0] ?? null) : Promise.resolve(null);
  void plan.then((raw) => {
    const now = get();
    if (now.phase !== 'listening' || now.talkId !== s.talkId) return;
    const { r, custom } = mergePlan(now.set, now.answers, now.custom, checkModelPlan(raw, now.set), now.name);
    const helpers = helpersFrom(r.q3 ?? [], custom, asOwn(), r.q7?.[0]);
    set({ phase: 'heard', resolvedAnswers: r, custom, line: W.heard, heard: heardLines(now.set, now.answers, r, helpers, now.who, now.scene) });
  });
}

/** "Change something", then a tap on a line: only that question again, then back here. */
export function changeLine(q: QId): void {
  set({ changing: true });
  ask(q);
}

/** "Looks right": the model's plan if it comes in time and passes the checks, else code's; then consent, apply and reveal. */
export function looksRight(): void {
  const s = get();
  const r = s.resolvedAnswers ?? resolved(s.set, s.answers);
  set({ phase: 'listening', line: W.heard });
  // The cadence starts here and ends at the reveal (§7.1).
  audio?.cadence(7000);
  const t0 = Date.now();
  if (s.who.maia && !s.who.teen && maiaWasOn() !== true) {
    set({ phase: 'consent', line: W.c1, sub: null });
    pendingPlan = { r, t0 };
    return;
  }
  finish(r, t0, maiaWasOn() === true);
}
let pendingPlan: { r: Partial<Record<QId, string[]>>; t0: number } | null = null;
const maiaWasOn = (): boolean | null => get().maiaOn;


/** The consent sheet's answer: "Turn on" (with its checkbox) or "Not now". */
export function consent(on: boolean): void {
  const p = pendingPlan;
  pendingPlan = null;
  if (!p) return;
  if (on) {
    // This member's prefs say on with the disclosure (as `maiamode/ui.ts` `accept` does), here and on every device.
    void import('../maiamode/prefs').then((m) => m.savePrefs({ on: true, offPending: false, disclosure: { version: 2, at: new Date().toISOString() }, offered: true }));
  }
  set({ maiaOn: on });
  finish(p.r, p.t0, on);
}

/** Apply, then the reveal: account items at once, desk items through the queue (§5.3). */
function finish(r: Partial<Record<QId, string[]>>, t0: number, maiaOn: boolean): void {
  const s = get();
  const own = asOwn();
  const home = own.find((d) => d.kind === 'personal') ?? own[0] ?? null;
  const helpers = s.who.teen ? [] : helpersFrom(r.q3 ?? [], s.custom, own, r.q7?.[0]);
  const items: NewItem[] = [];
  // Q1: the light was set live; the scene too. Desk names (F1), then each desk's part.
  for (const [deskId, name] of Object.entries(s.deskNames)) {
    const was = ownDesks().find((d) => d.id === deskId)?.name ?? '';
    if (name && name !== was) items.push({ kind: 'rename', id: `rename-${deskId}`, deskId, name, was });
  }
  for (const h of helpers) items.push({ kind: 'helper', id: `helper-${h.template}-${h.name}`, deskId: h.deskId, helper: h });
  if (home) {
    for (const [i, t] of s.todos.entries()) items.push({ kind: 'todo', id: `todo-${i}`, deskId: home.id, title: t });
    if (maiaOn) items.push({ kind: 'maia', id: 'maia', deskId: home.id, attention: attentionFor(r.q5) as Record<string, number> | null, notes: (r.q8 ?? []).includes('notes') });
    if (maiaOn && s.who.shield) items.push({ kind: 'reach', id: 'reach', deskId: home.id, reach: reachFor(r, s.names) });
  }
  const heard = heardLines(s.set, s.answers, r, helpers, s.who, s.scene);
  if (home) items.push({ kind: 'notes', id: 'notes', deskId: home.id, doc: setupNotesDoc(heard, s.todos.length ? [`On your list: ${s.todos.join('; ')}.`] : [], new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })) });
  enqueue(items);
  const callback = callbackFor(r, own, s.who.courier, helpers);
  // The account's part, now: the startup chooser answered, the tour not started by itself (offered at the farewell), done.
  void import('../maiamode/prefs').then((m) => m.savePrefs({ offered: true, startup: { ask: false, mode: 'last' } })).catch(() => undefined);
  void import('../tour/prefs').then((m) => m.setTourOff(true)).catch(() => undefined);
  setLayoutPref({ welcome: { state: 'done', at: new Date().toISOString() } });
  if (Object.keys(s.deskNames).length) void import('../setup/prefs').then((m) => m.markDone('name-desks')).catch(() => undefined);
  void forgetTalkWhenApplied(s.base);
  const wait = Math.max(0, 7000 - (Date.now() - t0));
  set({ phase: 'listening', heard, callback, line: '', sub: null });
  after(wait, () => reveal());
}

async function forgetTalkWhenApplied(base: string | null): Promise<void> {
  // The talk on the Platform goes once the plan is read: the setup itself lives on the desks and in this browser's queue.
  await forgetTalk(base);
}

function reveal(): void {
  const s = get();
  audio?.hero();
  set({ phase: 'reveal', line: s.who.teen ? W.r1Teen : W.r1(s.name), sub: s.callback?.line ?? null, eventChoices: [] });
}

/** "Show me around" or "I'm all set": the farewell, then the office is just the office (§2 beats 9 and 10). */
export function farewell(tour: boolean): void {
  set({ phase: 'farewell', line: W.f1, sub: null });
  after(readMs(W.f1, get().who.teen) + 200, () => {
    set({ phase: 'done' });
    if (tour) void import('../tour/door').then((m) => m.startTour(null));
  });
}

// ----- Pause (L1), Finish later (L2), Not now
export function pause(): void {
  const s = get();
  if (s.paused || s.phase === 'done' || s.phase === 'threshold') return;
  window.clearTimeout(timer);
  audio?.pause();
  set({ paused: s.phase });
}

export function resume(): void {
  const s = get();
  if (!s.paused) return;
  audio?.resume();
  const was = s.paused;
  set({ paused: null });
  // Whatever was on screen comes back; a line that was reading on goes on to what's next.
  if (was === 'greeting') greet();
  else if (was === 'ack' || was === 'event' || was === 'listening') askNext(null);
}

export function later(): void {
  window.clearTimeout(timer);
  audio?.stop();
  setLayoutPref({ welcome: { state: 'later', at: new Date().toISOString() } });
  set({ paused: null, phase: 'later', line: W.l2, sub: null, eventChoices: [] });
  after(readMs(W.l2, get().who.teen) + 300, () => set({ phase: 'done' }));
}

/** "I'll explore myself": today's first load, tour included (§1). */
export function explore(): void {
  window.clearTimeout(timer);
  if (themeBefore) setThemePref(themeBefore);
  themeBefore = null;
  setLayoutPref({ welcome: { state: 'explored', at: new Date().toISOString() } });
  set({ phase: 'done' });
}

/** Sound controls (§7.2). */
export function setSound(patch: Partial<WelcomeState['sound']>): void {
  const sound = { ...get().sound, ...patch };
  set({ sound });
  if (patch.muted !== undefined) audio?.setMuted(patch.muted);
  if (patch.music !== undefined) audio?.setMusic(patch.music);
  if (patch.volume !== undefined) audio?.setVolume(patch.volume);
}

export function setOffline(off: boolean): void {
  set({ notice: off ? W.l4 : get().notice === W.l4 ? null : get().notice });
}

/** For tests: the prefs the welcome reads. */
export const welcomePref = (): unknown => useLayoutPrefs.getState()['welcome'];

/**
 * Another member signed in on this browser (ISS-67, ISS-89; Security's WEL-3): nothing of this run goes on, not a timer, a
 * sound, an answer, a plan or a consent. The door decides afresh for the new member.
 */
onMemberChange((_sub, before) => {
  if (before === null) return;
  window.clearTimeout(timer);
  audio?.stop();
  audio = null;
  prior = {};
  pendingPlan = null;
  themeBefore = null;
  useWelcomeRun.setState(INITIAL(), true);
});
