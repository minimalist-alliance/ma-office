// Maia's welcome, direction A "Lounge" (design-drafts/maia-welcome/CONCEPT.md §2 and §13, the owner's pick, Nov 15): Maia in the
// middle, her line and the choices under her, the member's real desks along the bottom of the room, over the dimmed office.
// The owner's change: at every question an input for their own words is always there beside the choices. Captions are the
// interface (her line is the large text, and can't be turned off); music only with "Begin with sound"; no voice at launch.
// Its own chunk and stylesheet (`welcome.css`), fetched only when the door says this is a new member's first load or a redo.
import { createAvatar, type MaiaAvatar } from '@minimalist-alliance/maia-avatar';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useDeskStore } from '../state/deskStore';
import { useLiveStore } from '../desk/liveStore';
import { useLayoutStore } from '../state/layoutStore';
import { openItem } from '../shell/actions';
import { useSession } from '../platform/session';
import { ageBandOf } from '../platform/age';
import { getTheme, useTheme } from '../theme/themeStore';
import { loadScenes, useBackdrop } from '../theme/backdrop';
import { maiaBase } from '../maia/gate';
import { courierOn } from '../apps/courier/door';
import { DISCLOSURE } from '../maiamode/words';
import { QUESTIONS, SCENES, W, PROVIDERS, type QId } from './catalogue';
import { dots, type Fill } from './flow';
import { fetchKept } from './net';
import { retry, useQueue, type Item } from './apply';
import { homeTakesReach, shieldReady } from './seams';
import { linkOf } from '../desk/liveStore';
import { welcomePainted } from './door';
import { useWelcomeDoor, type LayerProps } from './store';
import {
  begin,
  beginWith,
  changeLine,
  choose,
  consent,
  explore,
  farewell,
  fillDone,
  getAudio,
  later,
  looksRight,
  pause,
  pick,
  pickScene,
  prefetchAudio,
  resume,
  setOffline,
  setSound,
  skip,
  startSound,
  stageDesks,
  stopTimers,
  submit,
  useWelcomeRun,
  type StageDesk,
} from './run';
import welcomeCssUrl from './welcome.css?url';
import markOnDark from '../assets/brand/ma-mark-on-dark.svg';
import markOnLight from '../assets/brand/ma-mark-primary.svg';
import markZen from '../assets/brand/ma-mark-zen.svg';

const WAVE = { v: 1, mood: 'warm', rhythm: 'lively', seconds: 24, beats: [{ t: 0.4, do: 'wave', level: 2 }, { t: 3, do: 'smile', level: 1 }, { t: 12, do: 'flick', level: 1 }] };

/** The member's first name, for the threshold and the reveal only (never sent anywhere). */
function firstName(display: string | null | undefined): string | null {
  const first = (display ?? '').trim().split(/\s+/)[0] ?? '';
  return /^[\p{L}][\p{L}'’-]{0,23}$/u.test(first) ? first : null;
}

const reduced = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function WelcomeLayer({ redo, onEnd }: LayerProps) {
  const me = useSession((s) => s.me);
  const config = useSession((s) => s.config);
  const phase = useWelcomeRun((s) => s.phase);
  const paused = useWelcomeRun((s) => s.paused);
  const line = useWelcomeRun((s) => s.line);
  const sub = useWelcomeRun((s) => s.sub);
  const notice = useWelcomeRun((s) => s.notice);
  const teen = useWelcomeRun((s) => s.who.teen);
  const [started, setStarted] = useState(false);

  // The start: who they are (never asked), the kept talk (L3) or the last answers (a redo).
  useEffect(() => {
    let live = true;
    const tier = me?.membership?.tier ?? null;
    const band = ageBandOf(me);
    const maia = import('../maiamode/prefs').then((m) => ({ allowed: m.allowedFor(me, config), on: m.isOn(m.currentPrefs()) }));
    const base = maiaBase(config, window.location, import.meta.env.MODE !== 'production');
    // The shield's questions only when its home desk can take the answers (an older desk-agent can't).
    const own = useDeskStore.getState().desks.filter((d) => d.kind !== 'guild');
    const home = own.find((d) => d.kind === 'personal') ?? own[0] ?? null;
    const homeLink = home && useLiveStore.getState().desks[home.id]?.link === 'open' ? linkOf(home.id) : null;
    const shield = band !== 'teen' && shieldReady(config)
      ? homeTakesReach(homeLink ? (method, params) => homeLink.call(method as never, params as never, { deadlineMs: 3_000 }) : null)
      : Promise.resolve(false);
    void Promise.all([maia, band === 'teen' ? Promise.resolve(null) : fetchKept(base), shield]).then(([m, kept, shieldOk]) => {
      if (!live) return;
      const desks = useDeskStore.getState().desks;
      begin({
        who: { teen: band === 'teen', tier, maia: band !== 'teen' && m.allowed, shield: shieldOk, rename: tier === 'officer' || tier === 'lead' ? desks.some((d) => d.canRename) : false, courier: courierOn(config) },
        name: firstName(me?.displayName),
        base: band === 'teen' ? null : base,
        model: !!kept?.model,
        kept: kept?.talk ? { talkId: kept.talk.talkId, answers: kept.talk.answers, followUps: kept.talk.followUps } : null,
        redo,
        free: tier === 'free',
        maiaOn: m.on,
      });
      setStarted(true);
    });
    prefetchAudio();
    void loadScenes();
    return () => {
      live = false;
      stopTimers();
    };
    // Once a run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The overlay fades into the threshold (ADR 0058's `welcome` reason).
  useEffect(() => {
    if (started) welcomePainted();
  }, [started]);

  // The end: the office is just the office.
  useEffect(() => {
    if (phase !== 'done') return;
    const audio = getAudio();
    audio?.stop();
    const { callback } = useWelcomeRun.getState();
    if (callback?.deskId && callback.app) openOn(callback.deskId, callback.app);
    useWelcomeDoor.setState({ lifted: false });
    onEnd();
  }, [phase, onEnd]);

  // The reveal lifts the dimming and shows the office (the Shell's `wl-on` goes).
  useEffect(() => {
    if (phase === 'reveal' || phase === 'farewell') useWelcomeDoor.setState({ lifted: true });
  }, [phase]);

  // A hidden tab: the music fades and pauses, then comes back gently (§7.1). Offline: L4, and the answers wait here.
  useEffect(() => {
    const vis = (): void => getAudio()?.setHidden(document.hidden);
    const off = (): void => setOffline(true);
    const on = (): void => setOffline(false);
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    if (!navigator.onLine) setOffline(true);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('offline', off);
      window.removeEventListener('online', on);
    };
  }, []);

  // Esc opens Pause (§11).
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const s = useWelcomeRun.getState();
      if (s.paused) resume();
      else pause();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  if (!started) return <div className="wl wl-wait" aria-hidden="true" />;
  const lifted = phase === 'reveal' || phase === 'farewell' || phase === 'done';
  // Here's what I heard and the consent sheet stand where Maia and her line were (the stills' A-desk-heard).
  const card = phase === 'heard' || phase === 'consent';
  const cls = `wl wl-${phase}${lifted ? ' wl-lifted' : ''}${card ? ' wl-carded' : ''}${teen ? ' wl-teen' : ''}`;
  return (
    <div className={cls} role="dialog" aria-modal="true" aria-label={W.welcome} data-testid="welcome">
      <div className="wl-dim" aria-hidden="true" />
      {!lifted && <TopControls />}
      {!lifted && (
        <main className="wl-main">
          {phase === 'heard' ? (
            <Heard />
          ) : phase === 'consent' ? (
            <Consent />
          ) : (
            <>
              <Maia wave={phase === 'threshold'} />
              {phase === 'threshold' ? (
                <Threshold />
              ) : (
                <>
                  <Line text={line} sub={sub} />
                  <Body />
                </>
              )}
            </>
          )}
          {notice && (
            <p className="wl-notice" role="status" data-testid="welcome-notice">
              {notice}
            </p>
          )}
        </main>
      )}
      {!lifted && phase !== 'consent' && <Stage />}
      {(phase === 'reveal' || phase === 'farewell') && <RevealCard />}
      {paused && <Paused />}
    </div>
  );
}

/** Opens the callback's app on its desk (§3.1, R2). */
function openOn(deskId: string, app: string): void {
  const items = useLayoutStore.getState().desks[deskId]?.items ?? [];
  const item = items.find((i) => i.app === app);
  if (item) openItem(deskId, item.id);
}

// ---------------------------------------------------------------- Maia herself
function Maia({ wave = false, small = false }: { wave?: boolean; small?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phase = useWelcomeRun((s) => s.phase);
  const paused = useWelcomeRun((s) => s.paused);
  const theme = useTheme((s) => s.resolved);
  const avatar = useRef<MaiaAvatar | null>(null);
  const [still, setStill] = useState(false);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return undefined;
    const a = createAvatar(c, { theme: getTheme().resolved, size: small ? 46 : 112 });
    avatar.current = a;
    // She waves at 2.2 s on the threshold (the fixed score from maia-voice §2), once.
    const t = wave ? window.setTimeout(() => a.playScore(WAVE), reduced() ? 0 : 2200) : undefined;
    return () => {
      window.clearTimeout(t);
      a.destroy();
      avatar.current = null;
    };
    // Once per Maia: her wave is the threshold's alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => avatar.current?.setTheme(theme), [theme]);
  useEffect(() => {
    const a = avatar.current;
    if (!a) return;
    if (phase === 'listening') a.setState('thinking');
    else a.setState('calm');
  }, [phase]);
  useEffect(() => {
    if (paused || still) avatar.current?.pause();
    else avatar.current?.resume();
  }, [paused, still]);
  return (
    <div className={small ? 'wl-maia small' : 'wl-maia'}>
      <div className="wl-field" aria-hidden="true">
        <canvas ref={canvas} width={small ? 46 : 112} height={small ? 46 : 112} />
      </div>
      {!small && (
      <button type="button" className="wl-still" aria-pressed={still} aria-label={W.pauseMotion} title={W.pauseMotion} onClick={() => setStill(!still)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {still ? <path d="M9 7v10l8-5Z" /> : <path d="M9 7v10M15 7v10" />}
        </svg>
      </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the top: the mark, the sound, Pause
function TopControls() {
  const sound = useWelcomeRun((s) => s.sound);
  const phase = useWelcomeRun((s) => s.phase);
  const [open, setOpen] = useState(false);
  const off = !sound.on || sound.muted;
  const speaker = (): void => {
    if (!sound.on) {
      // A press is the gesture audio needs: the speaker can start the music after a quiet beginning.
      startSound();
      return;
    }
    setSound({ muted: !sound.muted });
  };
  if (phase === 'done') return null;
  return (
    <header className="wl-top">
      {/* The brand kit's mark for the theme, exactly as the top bar shows it (ADR 0060). */}
      <span className="wl-mark" aria-hidden="true">
        <img className="home-mark-img on-light" src={markOnLight} alt="" width={45} height={28} />
        <img className="home-mark-img on-dark" src={markOnDark} alt="" width={45} height={28} />
        <img className="home-mark-img on-zen" src={markZen} alt="" width={45} height={28} />
      </span>
      <div className="wl-ctrls">
        <div className="wl-pill">
          <button type="button" className="wl-icon" aria-label={off ? W.unmute : W.mute} aria-pressed={!off} onClick={speaker} data-testid="welcome-speaker">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9h4l5-4v14l-5-4H4Z" />
              {off ? <path d="m16 9 5 6m0-6-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
            </svg>
          </button>
          <input
            type="range"
            className="wl-volume"
            min={0}
            max={100}
            value={Math.round(sound.volume * 100)}
            aria-label={W.volume}
            disabled={!sound.on}
            onChange={(e) => setSound({ volume: Number(e.currentTarget.value) / 100 })}
          />
          <button type="button" className="wl-icon wl-cc" aria-label={W.sound} aria-expanded={open} title={W.captionsOn} onClick={() => setOpen(!open)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="6" width="18" height="12" rx="3" />
              <path d="M10 10.5a2 2 0 1 0 0 3M16 10.5a2 2 0 1 0 0 3" />
            </svg>
          </button>
          {open && (
            <div className="wl-menu" role="group" aria-label={W.sound}>
              <label>
                <input type="checkbox" checked={sound.music} disabled={!sound.on} onChange={(e) => setSound({ music: e.currentTarget.checked })} />
                {W.music}
              </label>
              <p>{W.captionsOn}</p>
            </div>
          )}
        </div>
        {phase !== 'threshold' && phase !== 'reveal' && phase !== 'farewell' && phase !== 'later' && (
          <button type="button" className="wl-round" aria-label={W.pause} title={W.pause} onClick={pause} data-testid="welcome-pause">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 7v10M15 7v10" />
            </svg>
          </button>
        )}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- the threshold (§2 beat 1, T1 to T4)
function Threshold() {
  const name = useWelcomeRun((s) => s.name);
  const teen = useWelcomeRun((s) => s.who.teen);
  const short = useWelcomeRun((s) => !s.who.maia);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => first.current?.focus({ preventScroll: true }), reduced() ? 0 : 4400);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <section className="wl-thr" aria-labelledby="wl-t1">
      <h1 id="wl-t1" className="wl-say wl-in1">
        {teen ? W.t1Teen : W.t1(name)}
      </h1>
      <p className="wl-say wl-soft wl-in2">{teen ? W.t2Teen : W.t2}</p>
      <p className="wl-meta wl-in3">{teen ? W.t3Teen : short ? W.t3Short : W.t3Long}</p>
      <div className="wl-acts wl-in3 wl-begin">
        <button ref={first} type="button" className="wl-btn primary" onClick={() => beginWith(true)} data-testid="welcome-sound">
          {W.beginSound}
        </button>
        <button type="button" className="wl-btn second" aria-describedby="wl-quiet-hint" onClick={() => beginWith(false)} data-testid="welcome-quiet">
          {W.beginQuiet}
        </button>
        <span id="wl-quiet-hint" className="wl-sr">
          {W.beginQuietHint}
        </span>
        <button type="button" className="wl-quiet" onClick={explore} data-testid="welcome-explore">
          {W.explore}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- her line: the captions
function Line({ text, sub }: { text: string; sub: string | null }) {
  const phase = useWelcomeRun((s) => s.phase);
  const current = useWelcomeRun((s) => s.current);
  const ref = useRef<HTMLHeadingElement>(null);
  // Focus moves to each new question, as a heading (§11).
  useEffect(() => {
    if (phase === 'ask' || phase === 'fill' || phase === 'event' || phase === 'heard' || phase === 'consent' || phase === 'reveal' || phase === 'resume') ref.current?.focus({ preventScroll: true });
  }, [phase, current, text]);
  const echo = phase === 'ack';
  return (
    <div className="wl-line">
      <h2 ref={ref} tabIndex={-1} className="wl-say" aria-live="polite" data-testid="welcome-line">
        {text}
      </h2>
      {sub && (
        <p className={echo ? 'wl-echo' : 'wl-why'} aria-live={echo ? 'polite' : undefined} data-testid={echo ? 'welcome-echo' : 'welcome-why'}>
          {sub}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- what's under her line
function Body() {
  const phase = useWelcomeRun((s) => s.phase);
  const choices = useWelcomeRun((s) => s.eventChoices);
  if (phase === 'ask') return <Question />;
  if (phase === 'fill') return <FillStep />;
  if ((phase === 'event' || phase === 'resume') && choices.length)
    return (
      <div className="wl-acts">
        {choices.map((c, i) => (
          <button key={c.id} type="button" className={i === 0 ? 'wl-btn primary' : 'wl-btn second'} onClick={() => choose(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
    );
  return null;
}

function Question() {
  const current = useWelcomeRun((s) => s.current);
  const picks = useWelcomeRun((s) => s.picks);
  const followUps = useWelcomeRun((s) => s.followUps);
  const set = useWelcomeRun((s) => s.set);
  const answers = useWelcomeRun((s) => s.answers);
  const scene = useWelcomeRun((s) => s.scene);
  const teen = useWelcomeRun((s) => s.who.teen);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const shown = useRef(false);
  useEffect(() => setText(''), [current]);
  if (!current) return null;
  const fu = followUps.find((f) => f.id === current);
  const q = fu ? null : QUESTIONS[current as QId];
  const options = fu ? fu.choices.map((c) => ({ id: c, label: c, only: false })) : q!.choices;
  const multi = !fu && q!.multi;
  const isQ1 = current === 'q1';
  const primary = isQ1 ? (picks[0] === 'zen' ? W.thisOne : W.next) : multi ? W.thatsIt : W.next;
  const showPrimary = isQ1 || (multi && picks.length > 0) || text.trim().length > 0;
  const { total, at } = dots(set, answers, current);
  const firstQuestion = !shown.current && current === set[0];
  shown.current = true;
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const n = Number(e.key);
    if (n >= 1 && n <= options.length) {
      e.preventDefault();
      pick(options[n - 1]!.id);
    } else if (e.key === 'Enter' && showPrimary) {
      e.preventDefault();
      submit(text);
    }
  };
  return (
    <div className="wl-q" onKeyDown={onKey}>
      <div className="wl-chips" role={multi ? 'group' : 'radiogroup'} aria-label={fu ? fu.question : q!.say}>
        {options.map((c, i) => {
          const on = picks.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className={on ? 'wl-chip on' : 'wl-chip'}
              role={multi ? undefined : 'radio'}
              aria-pressed={multi ? on : undefined}
              aria-checked={multi ? undefined : on}
              aria-keyshortcuts={String(i + 1)}
              onClick={() => pick(c.id)}
              data-choice={c.id}
            >
              {on && (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              )}
              {c.label}
            </button>
          );
        })}
      </div>
      {isQ1 && picks[0] === 'zen' && <Scenes scene={scene} />}
      <form
        className="wl-own"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <label className="wl-sr" htmlFor="wl-own-input">
          {q?.own ?? W.send}
        </label>
        <input id="wl-own-input" className="wl-own-input" type="text" maxLength={500} autoComplete="off" spellCheck placeholder={q?.own ?? 'Or say it in your own words'} value={text} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(e) => setText(e.currentTarget.value)} data-testid="welcome-own" />
        <button type="submit" className="wl-icon wl-send" aria-label={W.send} disabled={!text.trim()} data-testid="welcome-send">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h13M13 6l6 6-6 6" />
          </svg>
        </button>
      </form>
      {/* P3 (or P9) under the input only while they're at it, so it isn't said again under every question. */}
      {(focused || text) && <p className="wl-small">{q?.ownNote ?? ''}</p>}
      <div className="wl-acts">
        {showPrimary && (
          <button type="button" className="wl-btn primary" onClick={() => submit(text)} data-testid="welcome-primary">
            {primary}
          </button>
        )}
        <button type="button" className="wl-quiet" onClick={skip} data-testid="welcome-skip">
          {W.skip}
        </button>
      </div>
      <div className="wl-dots" role="img" aria-label={`Question ${at + 1} of ${total}`}>
        {Array.from({ length: total }, (_, i) => (
          <i key={i} className={i === at ? 'c' : i < at ? 'd' : undefined} />
        ))}
      </div>
      {firstQuestion && !teen && <p className="wl-small wl-p2">{W.p2}</p>}
    </div>
  );
}

function Scenes({ scene }: { scene: string }) {
  const scenes = useBackdrop((s) => s.scenes);
  const shown = SCENES.map((s) => ({ ...s, placeholder: scenes?.find((x) => x.id === s.id)?.placeholder ?? '' }));
  return (
    <div className="wl-scenes" role="radiogroup" aria-label="Background">
      {shown.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={scene === s.id}
          className={scene === s.id ? 'wl-scene on' : 'wl-scene'}
          style={s.placeholder ? ({ backgroundImage: `url("${s.placeholder}")` } as CSSProperties) : undefined}
          onClick={() => pickScene(s.id)}
          data-scene={s.id}
        >
          <span>{s.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- fill steps (§4.3)
function FillStep() {
  const fill = useWelcomeRun((s) => s.fill);
  if (fill === 'names') return <Names />;
  if (fill === 'todos') return <Todos />;
  if (fill === 'email') return <Email />;
  if (fill === 'breath') return <Breath />;
  return null;
}

function Names() {
  const desks = stageDesks();
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(desks.map((d) => [d.id, d.name])));
  return (
    <form
      className="wl-fill"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = Object.fromEntries(Object.entries(names).map(([k, v]) => [k, v.trim().slice(0, 40)]).filter(([, v]) => v));
        fillDone('names', { names: clean });
      }}
    >
      {desks.map((d) => (
        <label key={d.id} className="wl-field-row">
          <span>{d.kind === 'work' ? 'Work desk' : 'Personal desk'}</span>
          <input type="text" maxLength={40} value={names[d.id] ?? ''} onChange={(e) => setNames({ ...names, [d.id]: e.currentTarget.value })} />
        </label>
      ))}
      <div className="wl-acts">
        <button type="submit" className="wl-btn primary">
          {W.saveNames}
        </button>
        <button type="button" className="wl-quiet" onClick={() => fillDone('names')}>
          {W.keepNames}
        </button>
      </div>
    </form>
  );
}

function Todos() {
  const [items, setItems] = useState(['', '', '']);
  return (
    <form
      className="wl-fill"
      onSubmit={(e) => {
        e.preventDefault();
        fillDone('todos', { todos: items.filter((t) => t.trim()) });
      }}
    >
      {items.map((t, i) => (
        <input key={i} type="text" maxLength={200} aria-label={`To-do ${i + 1}`} value={t} onChange={(e) => setItems(items.map((x, j) => (j === i ? e.currentTarget.value : x)))} data-testid={`welcome-todo-${i}`} />
      ))}
      <div className="wl-acts">
        <button type="submit" className="wl-btn primary" disabled={!items.some((t) => t.trim())}>
          {W.addTodos}
        </button>
        <button type="button" className="wl-quiet" onClick={() => fillDone('todos')}>
          {W.noTodos}
        </button>
      </div>
    </form>
  );
}

function Email() {
  return (
    <div className="wl-q">
      <div className="wl-chips" role="radiogroup" aria-label={W.fEmail}>
        {PROVIDERS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={false} className="wl-chip" onClick={() => fillDone('email', { email: p.id })}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="wl-acts">
        <button type="button" className="wl-quiet" onClick={() => fillDone('email', { email: null })}>
          {W.notNow}
        </button>
      </div>
    </div>
  );
}

/** Three slow breaths: a double inhale (2 s and 1 s) and a 6 s exhale, three times; a count in text under reduced motion. */
function Breath() {
  const [on, setOn] = useState(false);
  const [beat, setBeat] = useState<{ n: number; step: 0 | 1 | 2 } | null>(null);
  useEffect(() => {
    if (!on) return undefined;
    const steps: [0 | 1 | 2, number][] = [
      [0, 2000],
      [1, 1000],
      [2, 6000],
    ];
    let n = 0;
    let i = 0;
    let t: number;
    const tick = (): void => {
      if (n >= 3) return fillDone('breath');
      setBeat({ n, step: steps[i]![0] });
      t = window.setTimeout(() => {
        i += 1;
        if (i === steps.length) {
          i = 0;
          n += 1;
        }
        tick();
      }, steps[i]![1]);
    };
    tick();
    return () => window.clearTimeout(t);
  }, [on]);
  if (!on)
    return (
      <div className="wl-acts">
        <button type="button" className="wl-btn primary" onClick={() => setOn(true)}>
          {W.yes}
        </button>
        <button type="button" className="wl-quiet" onClick={() => fillDone('breath')}>
          {W.noThanks}
        </button>
      </div>
    );
  const words = beat?.step === 0 ? W.breatheIn : beat?.step === 1 ? W.breatheMore : W.breatheOut;
  return (
    <div className="wl-breath" data-step={beat?.step ?? 0}>
      <div className="wl-ring" aria-hidden="true" />
      <p aria-live="polite">
        {words} · {(beat?.n ?? 0) + 1} of 3
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- the desks along the bottom (§6)
function Stage() {
  const desks = useDeskStore((s) => s.desks);
  // A desk's session opening makes it ready on the stage (`stepOf`).
  useLiveStore((s) => s.desks);
  const pencilled = useWelcomeRun((s) => s.pencilled);
  const deskNames = useWelcomeRun((s) => s.deskNames);
  const list = stageDesks(desks);
  if (!list.length) return null;
  return (
    <section className="wl-stage" aria-label="Your desks">
      {list.map((d) => (
        <StageCard key={d.id} desk={d} name={deskNames[d.id] ?? d.name} helpers={pencilled[d.id] ?? []} />
      ))}
    </section>
  );
}

/** The four apps' glyphs, simplified as the mocks draw them (the office's own tiles show at the reveal). */
const GLYPHS = {
  notebook: <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20ZM14 3.5V8h4M10 12h5M10 15.5h5" />,
  files: <path d="M3.5 7.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z" />,
  browser: <path d="M4 5.5h16v13H4ZM4 9h16M12 11a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7M8.5 14.5h7" />,
  agent: <path d="M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM5.5 19.5c.8-3.4 3.4-5.5 6.5-5.5s5.7 2.1 6.5 5.5" />,
} as const;

const STEP_WORDS: Record<StageDesk['step'], string> = {
  placing: 'Finding it a place',
  making: 'Making room',
  starting: 'Starting up',
  ready: 'Ready',
  failed: 'Didn’t start',
};

function StageCard({ desk, name, helpers }: { desk: StageDesk; name: string; helpers: string[] }) {
  return (
    <div className={`wl-desk ${desk.step}`} data-testid="welcome-desk" data-step={desk.step}>
      <span className="wl-etch">{name.toUpperCase()}</span>
      <div className="wl-tiles" aria-hidden="true">
        {(['notebook', 'files', 'browser', 'agent'] as const).map((a) => (
          <span key={a} className={`wl-tile t-${a}`}>
            <svg viewBox="0 0 24 24">{GLYPHS[a]}</svg>
          </span>
        ))}
        {helpers.map((h) => (
          <span key={h} className="wl-pen" title={h}>
            {h.charAt(0)}
          </span>
        ))}
      </div>
      {helpers.length > 0 && <span className="wl-pen-names">{`${helpers.join(', ')} ${W.pencilled}`}</span>}
      <span className="wl-state">
        {desk.step === 'ready' ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        ) : (
          <i className="wl-glint" aria-hidden="true" />
        )}
        {`${name}: ${STEP_WORDS[desk.step]}`}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- Here's what I heard (§2 beat 6, H1, H2, P4)
function Heard() {
  const heard = useWelcomeRun((s) => s.heard);
  const [which, setWhich] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => title.current?.focus({ preventScroll: true }), [which]);
  return (
    <section className="wl-card wl-heard" aria-labelledby="wl-heard-h" data-testid="welcome-heard">
      <div className="wl-card-head">
        <Maia small />
        <h2 id="wl-heard-h" ref={title} tabIndex={-1} className="wl-card-title" aria-live="polite" data-testid="welcome-line">
          {which ? W.whichPart : W.heard}
        </h2>
      </div>
      <ul className="wl-rows">
        {heard.map((l) => (
          <li key={l.q}>
            {which ? (
              <button type="button" className="wl-row" onClick={() => changeLine(l.q)}>
                <span className="wl-t">{l.title}</span>
                <span className="wl-s">{l.sets}</span>
              </button>
            ) : (
              <div className="wl-row">
                <span className="wl-t">{l.title}</span>
                <span className="wl-s">{l.sets}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="wl-small">{W.p4}</p>
      {!which && (
        <div className="wl-acts">
          <button type="button" className="wl-btn primary" onClick={() => void looksRight()} data-testid="welcome-looks-right">
            {W.looksRight}
          </button>
          <button type="button" className="wl-btn second" onClick={() => setWhich(true)}>
            {W.change}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Maia's consent (§2 beat 7): the disclosure as is, retitled
function Consent() {
  const [agreed, setAgreed] = useState(false);
  return (
    <section className="wl-card wl-consent" role="dialog" aria-modal="true" aria-labelledby="wl-consent-h" data-testid="welcome-consent">
      <h2 id="wl-consent-h" className="wl-sheet-title">
        {DISCLOSURE.title}
      </h2>
      <p>{DISCLOSURE.lead}</p>
      {DISCLOSURE.sections.map(([h, body]) => (
        <div key={h} className="wl-section">
          <h3>{h}</h3>
          <p>{body}</p>
        </div>
      ))}
      <label className="wl-agree">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.currentTarget.checked)} />
        {DISCLOSURE.agree}
      </label>
      <div className="wl-acts">
        <button type="button" className="wl-btn primary" disabled={!agreed} onClick={() => consent(true)}>
          {DISCLOSURE.turnOn}
        </button>
        <button type="button" className="wl-btn second" onClick={() => consent(false)}>
          {DISCLOSURE.notNow}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the reveal (§2 beat 9) and the list that fills in (§5.3)
function RevealCard() {
  const phase = useWelcomeRun((s) => s.phase);
  const line = useWelcomeRun((s) => s.line);
  const sub = useWelcomeRun((s) => s.sub);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus({ preventScroll: true }), []);
  const items = useQueue((s) => s.items);
  // A helper that couldn't run wasn't made: it leaves the list, and one line says why.
  const held = items.some((i) => i.kind === 'helper' && i.skipped);
  const shown = items.filter((i) => (i.kind !== 'notes' || i.state !== 'done') && !(i.kind === 'helper' && i.skipped));
  return (
    <section className="wl-card wl-reveal-card" aria-labelledby="wl-reveal-h" data-testid="welcome-reveal">
      <div className="wl-card-head">
        <Maia small />
        <h2 id="wl-reveal-h" ref={title} tabIndex={-1} className="wl-card-title" aria-live="polite" data-testid="welcome-line">
          {line}
        </h2>
      </div>
      {sub && <p className="wl-why">{sub}</p>}
      {shown.length > 0 && (
        <ul className="wl-list">
          {shown.map((i) => (
            <RevealItem key={i.id} item={i} />
          ))}
        </ul>
      )}
      {held && (
        <p className="wl-why" data-testid="welcome-helpers-held">
          {W.helpersHeld}
        </p>
      )}
      {phase === 'reveal' && (
        <div className="wl-acts">
          <button type="button" className="wl-btn second" onClick={() => farewell(true)} data-testid="welcome-tour">
            {W.showMe}
          </button>
          <button type="button" className="wl-btn primary" onClick={() => farewell(false)} data-testid="welcome-all-set">
            {W.allSet}
          </button>
        </div>
      )}
    </section>
  );
}

function itemWords(i: Item): string {
  switch (i.kind) {
    case 'helper':
      return `${i.helper.name} on ${i.helper.deskName}`;
    case 'todo':
      return `On your list: ${i.title}`;
    case 'maia':
      return 'Maia on your desks';
    case 'reach':
      return 'What reaches you';
    case 'notes':
      return W.notesTitle;
    case 'rename':
      return `Desk named ${i.name}`;
  }
}

function RevealItem({ item }: { item: Item }) {
  const desk = useDeskStore((s) => s.desks.find((d) => d.id === item.deskId));
  const words = itemWords(item);
  const sub = item.state === 'failed' ? W.didntTake : item.state === 'done' ? (item.kind === 'helper' && item.needsKey ? W.needsKey : null) : W.setsUpWhen(desk?.name ?? 'your desk');
  return (
    <li className={`wl-item ${item.state}`} data-state={item.state}>
      {item.state === 'done' ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      ) : (
        <i className="wl-pen-dot" aria-hidden="true" />
      )}
      <span>{words}</span>
      {sub && <span className="wl-w">{sub}</span>}
      {item.state === 'failed' && (
        <button type="button" className="wl-quiet" onClick={() => retry(item.id)}>
          {W.tryAgain}
        </button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- Pause (L1)
function Paused() {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <section className="wl-card wl-paused" role="dialog" aria-modal="true" aria-labelledby="wl-paused-h" data-testid="welcome-paused">
      <h2 id="wl-paused-h" className="wl-say">
        {W.l1}
      </h2>
      <div className="wl-acts">
        <button ref={ref} type="button" className="wl-btn primary" onClick={resume}>
          {W.resume}
        </button>
        <button type="button" className="wl-btn second" onClick={later}>
          {W.finishLater}
        </button>
        <button type="button" className="wl-quiet" onClick={() => {
          resume();
          choose('skipRest');
        }}>
          {W.skipRest}
        </button>
      </div>
    </section>
  );
}

/** The welcome's styles are a file of their own, fetched with the chunk; a failed load rejects like a failed chunk. */
let sheet: Promise<void> | undefined;
function loadSheet(): Promise<void> {
  sheet ??= new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = welcomeCssUrl;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      sheet = undefined;
      reject(new Error('The welcome stylesheet did not load'));
    };
    document.head.appendChild(link);
  });
  return sheet;
}

export const ready = (): Promise<typeof WelcomeLayer> => loadSheet().then(() => WelcomeLayer);

export type { Fill };
