// The demo page. Every piece of text goes in through textContent; no markup is ever built from strings.
import { THEMES, createAvatar, defineMaiaAvatar, parseScore } from '../src/index.js';
import type { AvatarState, MaiaAvatar, MaiaAvatarElement, Theme } from '../src/index.js';

const svgs = import.meta.glob('../../../docs/assets/maia/svg/maia-*-{sm,md,lg}.svg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const svgFor = (theme: Theme, tier: string) => svgs[`../../../docs/assets/maia/svg/maia-${theme}-${tier}.svg`] ?? '';

defineMaiaAvatar();
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = document.documentElement;
const theme = (): Theme => (THEMES as readonly string[]).includes(root.dataset['theme'] ?? '') ? (root.dataset['theme'] as Theme) : 'light';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}

/** A bare canvas in a bubble, for createAvatar. */
const handles = new Set<MaiaAvatar>();
function bubble(size: number, opts: { still?: boolean; reducedMotion?: boolean } = {}): { box: HTMLElement; avatar: MaiaAvatar } {
  const canvas = el('canvas');
  const box = el('span', { class: 'bubble' }, canvas);
  box.style.width = `${size}px`;
  box.style.height = `${size}px`;
  const avatar = createAvatar(canvas, { size, theme: theme(), activityTarget: box, ...(opts.reducedMotion === undefined ? {} : { reducedMotion: opts.reducedMotion }) });
  if (opts.still) avatar.pause();
  handles.add(avatar);
  return { box, avatar };
}
const stills = new Set<MaiaAvatar>();

// ---- her bubble
const elements = [...document.querySelectorAll<MaiaAvatarElement>('maia-avatar')];
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-state]')) {
  b.addEventListener('click', () => {
    const s = b.dataset['state'] as AvatarState;
    for (const m of elements) {
      if (s === 'speaking') m.setRate(32);
      m.setState(s);
    }
  });
}
byId('wake').addEventListener('click', () => { for (const m of elements) m.wake(); });

// ---- DANCE: the Party routine at 64 and 200 px, as the dance preview shows it
const reducedBox = byId<HTMLInputElement>('dance-reduced'), streamBox = byId<HTMLInputElement>('dance-stream');
// The demo's own switches. An app leaves reducedMotion out and she follows prefers-reduced-motion by herself;
// here the switch fixes it, so she's made again with it.
reducedBox.checked = matchMedia('(prefers-reduced-motion: reduce)').matches;
const dancers: { box: HTMLElement; avatar: MaiaAvatar }[] = [];
function makeDancers(): void {
  for (const d of dancers.splice(0)) { d.avatar.destroy(); handles.delete(d.avatar); }
  dancers.push(bubble(64, { reducedMotion: reducedBox.checked }), bubble(200, { reducedMotion: reducedBox.checked }));
  for (const d of dancers) d.avatar.setStreamMode(streamBox.checked);
  byId('dance-figs').replaceChildren(...dancers.map((d) => d.box));
}
makeDancers();
function dancePlay(): void {
  for (const d of dancers) d.avatar.playRoutine(); // her one dance, whichever it is
}
byId('dance-play').addEventListener('click', dancePlay);
reducedBox.addEventListener('change', makeDancers);
streamBox.addEventListener('change', () => { for (const d of dancers) d.avatar.setStreamMode(streamBox.checked); });
let danceSeen = '';
setInterval(() => {
  const s = dancers[1]!.avatar.state;
  const text = s === 'routine' ? 'Dancing.' : reducedBox.checked || streamBox.checked ? 'Less motion or a desk stream: a smile instead of a dance.' : 'Press Dance to watch it again.';
  if (text !== danceSeen) byId('dance-readout').textContent = danceSeen = text;
}, 250);

// ---- rest pose beside the stills: sm, md and lg
const TIERS: [string, number][] = [['sm', 40], ['md', 64], ['lg', 200]];
function pairs(): void {
  for (const a of stills) { a.destroy(); handles.delete(a); }
  stills.clear();
  const host = byId('pairs');
  host.replaceChildren();
  for (const [tier, size] of TIERS) {
    const { box, avatar } = bubble(size, { still: true });
    stills.add(avatar);
    const img = el('img', { class: 'still', src: svgFor(theme(), tier), width: String(size), height: String(size), alt: `Version 7 still, ${theme()}, ${tier}` });
    const ref = el('span', { class: 'bubble' }, img);
    ref.style.width = `${size}px`;
    ref.style.height = `${size}px`;
    host.append(el('div', { class: 'pair', 'data-tier': tier }, el('div', { class: 'figs' }, box, ref), el('span', { class: 'label', text: `${tier}, ${size} px: package, then still` })));
  }
}
pairs();

// ---- moods, with the reference preview's scores
const beats = (...list: [number, string, number][]) => list.map(([t, d, level]) => ({ t, do: d, level }));
const SCORES: Record<string, { rhythm: string; beats: ReturnType<typeof beats> }> = {
  calm: { rhythm: 'breath', beats: beats([3, 'flick', 1], [9, 'bob', 1], [15, 'curl', 1]) },
  warm: { rhythm: 'breath', beats: beats([1, 'wave', 2], [4, 'smile', 2], [9, 'bob', 2], [15, 'smile', 1], [17, 'nod', 2]) },
  curious: { rhythm: 'lively', beats: beats([2, 'lift', 1], [5, 'lean', 2], [9, 'glance', 2], [13, 'flick', 2], [17, 'lean', 1]) },
  focused: { rhythm: 'quiet', beats: beats([3, 'curl', 2], [8, 'nod', 1], [14, 'glance', 2]) },
  gentle: { rhythm: 'quiet', beats: beats([3, 'soften', 2], [8, 'bob', 1], [14, 'nod', 1], [18, 'soften', 1]) },
  bright: { rhythm: 'lively', beats: beats([1, 'hop', 3], [2, 'smile', 2], [8, 'wave', 3], [12, 'flutter', 2], [14, 'hop', 2]) },
};
for (const [mood, s] of Object.entries(SCORES)) {
  const score = { v: 1, mood, seconds: 24, ...s };
  const small = bubble(64), big = bubble(112);
  small.avatar.playScore(score);
  big.avatar.playScore(score);
  byId('mood-grid').append(el('div', { class: 'mood' }, el('h3', { text: mood }), el('div', { class: 'figs' }, small.box, big.box)));
}

// ---- try a score
const input = byId<HTMLTextAreaElement>('score-input');
input.value = '{"v": 1, "mood": "curious", "rhythm": "drift", "seconds": 26,\n "beats": [\n  {"t": 1, "do": "lift", "level": 2},\n  {"t": 3, "do": "lean", "level": 2},\n  {"t": 5, "do": "glance", "level": 2},\n  {"t": 11, "do": "curl", "level": 2},\n  {"t": 16, "do": "hop", "level": 1},\n  {"t": 19, "do": "dance", "level": 3}\n ]}';
const trial = [bubble(64), bubble(120)];
for (const t of trial) byId('try-figs').append(t.box);
function play(): void {
  let parsed = parseScore(input.value);
  for (const t of trial) parsed = t.avatar.playScore(input.value);
  byId('score-out').textContent = parsed ? `Playing: ${JSON.stringify(parsed)}` : 'Not a score she can use, so she plays calm.';
}
byId('score-play').addEventListener('click', play);
play();

// ---- theme and pause
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
  r.addEventListener('change', () => {
    root.dataset['theme'] = r.value; // <maia-avatar> follows <html data-theme> by itself
    for (const a of handles) a.setTheme(theme());
    pairs();
  });
}
const pause = byId<HTMLButtonElement>('pause');
pause.addEventListener('click', () => {
  const on = pause.getAttribute('aria-pressed') !== 'true';
  pause.setAttribute('aria-pressed', String(on));
  pause.textContent = on ? 'Resume' : 'Pause';
  for (const m of elements) m.toggleAttribute('paused', on);
  for (const a of handles) {
    if (stills.has(a)) continue;
    if (on) a.pause();
    else a.resume();
  }
});

// ---- what the launcher is doing, once a second (the demo's own timer, not the package's)
const launcher = byId<MaiaAvatarElement>('launcher');
let seen = { frames: 0, steps: 0 };
setInterval(() => {
  const a = launcher.avatar;
  if (!a) return;
  const now = { frames: a.stats.frames, steps: a.stats.steps };
  byId('readout').textContent = `64 px: ${a.state}, ${now.frames - seen.frames} frames drawn and ${now.steps - seen.steps} engine steps in the last second`;
  seen = now;
}, 1000);

(window as unknown as { maiaDemo: object }).maiaDemo = { elements, handles, stills, dancers, dancePlay };
