// The preview page. Every piece of text goes in through textContent; no markup is ever built from strings.
(function () {
  'use strict';
  const { createAvatar, compileScore, parseScore, makeSleepStrip, DT } = MaiaEngine;
  const V = MAIA_VOCAB;
  const byId = (id) => document.getElementById(id);
  const DPR = Math.min(window.devicePixelRatio || 1, 3);
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  let motionAnyway = false;
  const lessMotion = () => motionQuery.matches && !motionAnyway;

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const k in props || {}) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k === 'style') e.style.cssText = props[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    }
    for (const c of kids) if (c) e.append(c);
    return e;
  }
  const theme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');

  // One clock for the page, only for what is on screen. When nothing runs there is no frame callback.
  const Stage = {
    actors: new Set(), byEl: new Map(), raf: 0, last: 0, acc: 0, paused: false, ticks: 0,
    add(actor) {
      this.actors.add(actor);
      if (!this.byEl.has(actor.el)) { this.byEl.set(actor.el, []); io.observe(actor.el); }
      this.byEl.get(actor.el).push(actor);
      this.kick();
    },
    kick() { if (!this.raf && !this.paused && this.anyActive()) { this.last = performance.now(); this.raf = requestAnimationFrame((t) => this.tick(t)); } },
    anyActive() { for (const a of this.actors) if (a.visible && a.active()) return true; return false; },
    tick(now) {
      this.raf = 0;
      this.acc += Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      if (this.acc + 0.004 >= DT) {
        const steps = this.acc >= 2 * DT ? 2 : 1;
        this.acc = Math.max(0, this.acc - steps * DT);
        this.ticks += 1;
        for (const a of this.actors) if (a.visible && a.active()) a.run(steps);
      }
      if (!this.paused && this.anyActive()) this.raf = requestAnimationFrame((t) => this.tick(t));
    },
    setPaused(on) {
      this.paused = on;
      document.documentElement.classList.toggle('is-paused', on);
      if (on && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      // Every still is eyes open.
      for (const m of maias) m.onPause(on);
      this.kick();
    },
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) for (const a of Stage.byEl.get(e.target) || []) a.visible = e.isIntersecting;
    Stage.kick();
  }, { rootMargin: '32px' });

  // Sleep's breath comes from one strip per size and theme, so the render loop can stop.
  const strips = new Map();
  function stripFor(size) {
    const key = `${size}|${theme()}`;
    if (!strips.has(key)) strips.set(key, makeSleepStrip({ size, dpr: DPR, theme: theme(), frames: V.states.sleeping.stripFrames }));
    return strips.get(key);
  }

  const maias = new Set();
  function maia(size, o) {
    o = o || {};
    const canvas = el('canvas', { style: `width:${size}px;height:${size}px` });
    const box = el('span', { class: 'bubble', style: `width:${size}px;height:${size}px`, 'aria-hidden': 'true' }, canvas);
    const av = createAvatar(canvas, { size, dpr: DPR, theme: theme(), reduced: o.reduced || lessMotion(), seed: o.seed });
    if (o.stream) av.setStreamMode(true);
    av.alwaysReduced = !!o.reduced;
    av.snap();
    av.draw();
    let held = 0, stripEl = null, failed = false;
    const m = {
      av, box, size,
      toStrip() {
        const s = stripFor(size), src = s.canvas;
        const c = el('canvas', { width: String(src.width), height: String(src.height), class: 'strip', style: `width:${size * s.frames}px;height:${size}px;--dx:${-(s.frames - 1) * size}px;--steps:${s.frames};--half:${s.halfS}s` });
        c.getContext('2d').drawImage(src, 0, 0);
        stripEl = c;
        box.append(c);
        canvas.style.visibility = 'hidden';
      },
      wake() {
        if (stripEl) {
          const anim = stripEl.getAnimations()[0], clock = anim ? (anim.currentTime / 1000) % V.states.sleeping.cycle : 0;
          av.sleepClock = Math.max(0, clock - 1);
          for (let i = 0; i < 30; i += 1) av.step();
          stripEl.remove(); stripEl = null;
          canvas.style.visibility = '';
        }
        av.dormant = false;
        av.wake();
        av.draw();
      },
      onPause(on) {
        if (stripEl) { stripEl.hidden = on; canvas.style.visibility = on ? '' : 'hidden'; }
        if (on) av.drawStill(); else if (!stripEl) av.draw();
      },
      theme() {
        av.setTheme(theme());
        if (stripEl) { stripEl.remove(); m.toStrip(); }
        if (Stage.paused) av.drawStill(); else av.draw();
      },
    };
    maias.add(m);
    Stage.add({
      el: box, visible: false,
      active: () => !av.dormant && !stripEl && !failed,
      run(n) {
        try {
          for (let i = 0; i < n; i += 1) av.step();
          held += n;
          if (o.stream && held < 2) return;
          held = 0;
          if (av.state === 'sleeping' && o.strip !== false && !av.reduced) { av.draw(); m.toStrip(); return; }
          av.draw();
        } catch (err) {
          // Any render error: log once and show the eyes-open still.
          failed = true;
          console.warn('Maia stopped', err.message);
          try { av.drawStill(); } catch (e2) { /* nothing more to do */ }
        }
      },
    });
    return m;
  }
  const driver = (host, run) => Stage.add({ el: host, visible: false, active: () => true, run });
  const fig = (node, text) => el('span', { class: 'fig' }, node, el('span', { class: 'label', text }));
  const beats = (...list) => list.map(([t, d, level]) => (level ? { t, do: d, level } : { t, do: d }));

  // The score as tracks, the engine's own blinks in a lighter mark, and a playhead.
  function scoreView(host) {
    const track = (text) => el('div', { class: 'tl-row' }, el('span', { class: 'tl-name', text }));
    const rows = { hair: track('hair'), body: track('body'), eyes: track('eyes') };
    const head = el('div', { class: 'tl-head' }), time = el('div', { class: 'label' });
    host.append(el('div', { class: 'tl' }, rows.hair, rows.body, rows.eyes, head), time);
    let c = null;
    return {
      set(compiled) {
        c = compiled;
        for (const name of ['hair', 'body', 'eyes']) {
          const row = rows[name];
          while (row.children.length > 1) row.lastChild.remove();
          for (const b of c[name]) {
            const mark = el('span', { class: b.auto ? 'tl-mark auto' : 'tl-mark', text: b.do, title: `${b.do}, level ${b.level}, at ${b.t} s${b.auto ? ', added by the engine' : ''}` });
            mark.style.left = `${(b.t / c.seconds) * 100}%`;
            mark.style.width = `${(b.dur / c.seconds) * 100}%`;
            row.append(mark);
          }
        }
      },
      at(t, loop, text) {
        head.style.left = `calc(36px + (100% - 36px) * ${(Math.max(0, Math.min(1, t / c.seconds))).toFixed(4)})`;
        time.textContent = text || `${c.mood}, ${c.rhythm}: ${Math.max(0, t).toFixed(1)} s of ${c.seconds} s, loop ${loop + 1}`;
      },
    };
  }

  // ---------------------------------------------------------------- six moods, all at once
  (function moods() {
    const SCORES = {
      calm: { rhythm: 'breath', beats: beats([3, 'flick', 1], [9, 'bob', 1], [15, 'curl', 1]) },
      warm: { rhythm: 'breath', beats: beats([1, 'wave', 2], [4, 'smile', 2], [9, 'bob', 2], [15, 'smile', 1], [17, 'nod', 2]) },
      curious: { rhythm: 'lively', beats: beats([2, 'lift', 1], [5, 'lean', 2], [9, 'glance', 2], [13, 'flick', 2], [17, 'lean', 1]) },
      focused: { rhythm: 'quiet', beats: beats([3, 'curl', 2], [8, 'nod', 1], [14, 'glance', 2]) },
      gentle: { rhythm: 'quiet', beats: beats([3, 'soften', 2], [8, 'bob', 1], [14, 'nod', 1], [18, 'soften', 1]) },
      bright: { rhythm: 'lively', beats: beats([1, 'hop', 3], [2, 'smile', 2], [8, 'wave', 3], [12, 'flutter', 2], [14, 'hop', 2]) },
    };
    Object.keys(V.moods).forEach((name, i) => {
      const s = maia(56, { seed: 21 + i }), b = maia(112, { seed: 21 + i });
      const score = { v: 1, mood: name, seconds: 24, ...SCORES[name] };
      s.av.playScore(score); b.av.playScore(score);
      byId('mood-grid').append(el('div', { class: 'mood', id: `mood-${name}` }, el('h3', { text: name }), el('div', { class: 'figs' }, s.box, b.box), el('p', { class: 'small muted', text: V.moods[name].say })));
    });
  })();

  // ---------------------------------------------------------------- a chat, live
  (function chat() {
    const SCORE = { v: 1, mood: 'warm', rhythm: 'breath', seconds: 24, beats: beats([0, 'wave', 2], [1, 'smile', 2], [5, 'bob', 2], [8, 'glance', 2], [11, 'lean', 2], [12, 'flick', 2], [17, 'smile', 1], [18, 'hop', 1]) };
    const REPLY = 'Nothing went wrong. Your office holds your desks, and a desk that sits idle goes to sleep. It wakes when you open it, which takes a moment. Your files and windows will be where you left them.';
    const small = maia(V.stage.launcherPx, { seed: 11 }), big = maia(200, { seed: 11 });
    byId('chat-small').append(small.box);
    byId('chat-big').append(fig(big.box, 'The same Maia at 200 px'));
    byId('reply-ghost').textContent = REPLY;
    const textNode = document.createTextNode('');
    byId('reply-text').append(textNode);
    const stepEls = ['thinking', 'speaking', 'score', 'falling asleep', 'asleep', 'waking'].map((text) => el('li', { text }));
    byId('chat-steps').append(...stepEls);
    const tl = scoreView(byId('chat-tl'));
    const compiled = compileScore(parseScore(SCORE));
    tl.set(compiled);
    byId('chat-json').textContent = JSON.stringify(SCORE);
    let phase = 0, T = 0, shown = 0, wait = 0, rate = 0, acc = 0;
    const both = (fn) => { fn(small.av); fn(big.av); };
    const enter = (i) => {
      phase = i; T = 0;
      stepEls.forEach((e, n) => e.classList.toggle('on', n === i));
      if (i === 0) { textNode.data = ''; shown = 0; both((a) => a.setState('thinking')); }
      if (i === 1) both((a) => { a.setRate(0); a.setState('speaking'); });
      if (i === 2) { textNode.data = REPLY; both((a) => a.playScore(SCORE)); }
      if (i === 3) both((a) => a.fallAsleep());
      if (i === 5) { small.wake(); big.wake(); }
    };
    enter(0);
    driver(byId('chat'), (n) => {
      const dt = n * DT;
      T += dt;
      if (phase === 0) { if (T > 4) enter(1); tl.at(0, 0, 'Turn sent, no text yet'); }
      else if (phase === 1) {
        wait -= dt;
        let added = 0;
        if (wait <= 0) {
          acc += dt * 34;
          while (acc >= 1 && shown < REPLY.length) {
            acc -= 1; shown += 1; added += 1;
            const ch = REPLY[shown - 1];
            if (ch === '.' || ch === ',') { wait = ch === '.' ? 0.34 : 0.16; acc = 0; break; }
          }
          if (added) textNode.data = REPLY.slice(0, shown);
        }
        rate += (added / dt - rate) * 0.25;
        both((a) => a.setRate(rate));
        tl.at(0, 0, `Text is streaming, ${Math.round(rate)} characters per second`);
        if (shown >= REPLY.length) enter(2);
      } else if (phase === 2) { tl.at(big.av.scoreT, big.av.loop); if (T > compiled.seconds + 3) enter(3); }
      else if (phase === 3) { tl.at(0, 0, 'No score playing and no model call'); if (T > V.states.sleeping.fallS) enter(4); }
      else if (phase === 4) { tl.at(0, 0, 'Asleep. The render loop has stopped and a bitmap strip breathes'); if (T > 12) enter(5); }
      else { tl.at(0, 0, 'Waking'); if (T > 1.6) enter(0); }
    });
  })();

  // ---------------------------------------------------------------- vocabulary
  (function vocabulary() {
    const a = maia(56, { seed: 3 }), b = maia(120, { seed: 3 });
    byId('voc-stage').append(fig(a.box, '56 px'), fig(b.box, '120 px'));
    const cols = [a.av, b.av];
    let level = 2;
    const lists = byId('voc-lists');
    const group = (title, names, table, onPick, setting) => {
      const btns = names.map((n) => el('button', {
        class: 'voc', type: 'button', id: `voc-${n}`, 'data-name': n, onclick: (e) => onPick(n, e.currentTarget), ...(setting ? { 'aria-pressed': String(n === setting) } : {}),
      }, el('b', { text: n }), el('span', { class: 'muted', text: table[n].say })));
      lists.append(el('div', { class: 'voc-list' }, el('h3', { text: title }), ...btns));
      return btns;
    };
    const pick = (btns, target) => btns.forEach((x) => x.setAttribute('aria-pressed', String(x === target)));
    const moods = group('Moods', Object.keys(V.moods), V.moods, (n, t) => { for (const c of cols) c.setMood(n); pick(moods, t); }, 'calm');
    const rhythms = group('Rhythms', Object.keys(V.rhythms), V.rhythms, (n, t) => { for (const c of cols) c.setRhythm(n); pick(rhythms, t); }, 'breath');
    lists.append(el('div', { class: 'ranger' }, el('span', { class: 'label', text: 'Level for every beat' }), el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Beat level' }, ...[1, 2, 3].map((l) => el('label', null,
      el('input', { type: 'radio', name: 'voc-level', id: `voc-level-${l}`, value: String(l), onchange: () => { level = l; }, ...(l === 2 ? { checked: 'checked' } : {}) }), el('span', { text: `Level ${l}` }))))));
    const names = Object.keys(V.beats), hit = (n) => { for (const c of cols) c.beat(n, level); };
    const all = [];
    for (const [title, track] of [['Beats, hair', 'hair'], ['Beats, body', 'body'], ['Beats, eyes', 'eyes']]) all.push(...group(title, names.filter((n) => V.beats[n].track === track), V.beats, hit));
    driver(byId('vocabulary'), () => { const c = cols[1]; for (const x of all) { const n = x.dataset.name; x.classList.toggle('playing', c.hb === n || c.eb === n || c.bb === n); } });
  })();

  // ---------------------------------------------------------------- states
  (function states() {
    const host = byId('state-rows');
    const addRow = (id, title, text, extra, make) => {
      const figs = el('div', { class: 'figs' }), list = [];
      for (const size of [56, 112]) {
        const m = maia(size, { seed: 7, reduced: make.reduced });
        figs.append(fig(m.box, `${size} px`));
        list.push(m);
      }
      const r = el('div', { class: 'row', id: `state-${id}` }, el('div', { class: 'row-text' }, el('h3', { text: title }), el('p', { class: 'small muted', text }), extra), figs);
      host.append(r);
      if (make.init) make.init(list);
      if (make.tick) driver(r, (n) => make.tick(list, n * DT));
      return list;
    };
    addRow('thinking', 'thinking', 'Turn sent, no text yet. Looking up with her eyes moving, hair swirling, drifting.', null, { init: (l) => l.forEach((m) => m.av.setState('thinking')) });
    const rateInput = el('input', { type: 'range', id: 'speak-rate', min: '0', max: '60', value: '32', 'aria-label': 'Text rate in characters per second' });
    const rateText = el('span', { class: 'label', text: '32 characters per second' });
    const speak = addRow('speaking', 'speaking', 'While text streams. She bobs with the text rate, hair flowing, looking at the person and at her text in turn.',
      el('label', { class: 'ranger', for: 'speak-rate' }, rateInput, rateText), { init: (l) => l.forEach((m) => { m.av.setRate(32); m.av.setState('speaking'); }) });
    rateInput.addEventListener('input', () => { rateText.textContent = `${rateInput.value} characters per second`; speak.forEach((m) => m.av.setRate(Number(rateInput.value))); });
    const sleepLabel = el('span', { class: 'label', text: 'awake' });
    let wakeNow = false, T = 0, phase = 'awake';
    addRow('sleeping', 'sleeping and waking', 'The only time her eyes stay closed. They close into the crescents, then she sinks and her hair settles, both strands resting. She breathes from a bitmap strip while the render loop is stopped. She wakes eyes first.',
      el('div', { class: 'ranger' }, el('button', { class: 'btn', type: 'button', id: 'wake-now', text: 'Wake her', onclick: () => { wakeNow = true; } }), sleepLabel), {
        tick: (l, dt) => {
          T += dt;
          if (phase === 'awake' && T > 4) { phase = 'falling'; T = 0; l.forEach((m) => m.av.fallAsleep()); sleepLabel.textContent = 'falling asleep'; }
          else if (phase === 'falling' && T > V.states.sleeping.fallS + 0.2) { phase = 'asleep'; T = 0; sleepLabel.textContent = 'asleep, render loop stopped'; }
          else if ((phase === 'asleep' && T > 12) || (wakeNow && phase !== 'awake')) { phase = 'awake'; T = 0; l.forEach((m) => m.wake()); sleepLabel.textContent = 'awake'; }
          wakeNow = false;
        },
      });
    addRow('unavailable', 'unavailable', 'A limit or a refusal. Still, with soft eyes looking down. The render loop stops once she has settled.', null, { init: (l) => l.forEach((m) => m.av.setState('unavailable')) });
    const FADES = ['calm', 'warm', 'gentle', 'bright', 'focused', 'curious'];
    let fi = 0, ft = 0;
    addRow('reduced', 'reduced motion', 'For people who ask for less motion. Hair and body at rest, eyes open. Only the eyes fade between expressions, here every 3 seconds.', null, {
      reduced: true,
      tick: (l, dt) => { ft += dt; if (ft > 3) { ft = 0; fi = (fi + 1) % FADES.length; l.forEach((m) => m.av.setMood(FADES[fi])); } },
    });
  })();

  // ---------------------------------------------------------------- 15 fps while a desk stream plays
  (function stream() {
    const SCORE = { v: 1, mood: 'bright', rhythm: 'lively', seconds: 24, beats: beats([1, 'wave', 3], [2, 'hop', 3], [7, 'lift', 3], [8, 'lean', 2], [13, 'flick', 3], [14, 'hop', 2], [18, 'curl', 2]) };
    for (const [text, on] of [['30 fps', false], ['15 fps, capped', true]]) {
      for (const size of [56, 96]) {
        const m = maia(size, { seed: 15, stream: on });
        m.av.playScore(SCORE);
        byId('stream-figs').append(fig(m.box, `${text}, ${size} px`));
      }
    }
  })();

  // ---------------------------------------------------------------- sizes, with a full 12 beat score
  (function sizes() {
    const SCORE = { v: 1, mood: 'warm', rhythm: 'breath', seconds: 30, beats: beats([1, 'wave', 2], [2, 'smile', 1], [5, 'hop', 2], [7, 'lift', 2], [9, 'glance', 2], [11, 'nod', 2], [13, 'lean', 2], [15, 'flutter', 2], [17, 'flick', 3], [19, 'bob', 2], [21, 'smile', 2], [24, 'curl', 2]) };
    let first = null, c = null;
    for (const size of [24, 32, 40, 56, 64, 96]) {
      const m = maia(size, { seed: 9 });
      c = m.av.playScore(SCORE);
      first = first || m.av;
      byId('size-figs').append(fig(m.box, `${size} px`));
    }
    const tl = scoreView(byId('sizes-tl'));
    tl.set(c);
    driver(byId('sizes'), () => tl.at(first.scoreT, first.loop));
  })();

  // ---------------------------------------------------------------- try a score
  (function tryScore() {
    const input = byId('score-input');
    input.value = '{"v": 1, "mood": "curious", "rhythm": "drift", "seconds": 26,\n "beats": [\n  {"t": 1, "do": "lift", "level": 2},\n  {"t": 3, "do": "lean", "level": 2},\n  {"t": 5, "do": "glance", "level": 2},\n  {"t": 11, "do": "curl", "level": 2},\n  {"t": 16, "do": "hop", "level": 1},\n  {"t": 19, "do": "dance", "level": 3}\n ]}';
    const s = maia(56, { seed: 2 }), b = maia(120, { seed: 2 });
    byId('try-figs').append(fig(s.box, '56 px'), fig(b.box, '120 px'));
    const list = [s.av, b.av];
    const tl = scoreView(byId('try-tl'));
    function play() {
      const parsed = parseScore(input.value);
      let c = null;
      for (const a of list) c = a.playScore(input.value);
      tl.set(c);
      const lines = [];
      if (!parsed) lines.push('Not a valid score, so she plays calm.');
      else {
        lines.push(`Playing ${c.mood}, ${c.rhythm}, ${c.seconds} s, which is ${c.cycles} whole cycles${c.askedSeconds !== c.seconds ? ` (${c.askedSeconds} s asked)` : ''}.`);
        lines.push(`${c.kept} beats kept. ${c.eyes.filter((x) => x.auto).length} blinks added by the engine.`);
        for (const n of c.notes) lines.push(`${n[0].toUpperCase()}${n.slice(1)}.`);
      }
      byId('score-notes').replaceChildren(...lines.map((text) => el('li', { text })));
    }
    byId('score-play').addEventListener('click', play);
    play();
    driver(byId('try'), () => tl.at(list[0].scoreT, list[0].loop));
  })();

  // ---------------------------------------------------------------- top bar
  const syncRadios = () => { byId(`theme-${theme()}`).checked = true; };
  function applyTheme() {
    strips.clear();
    for (const m of maias) m.theme();
    syncRadios();
  }
  document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => {
    document.documentElement.dataset.theme = r.value;
    applyTheme();
  }));
  darkQuery.addEventListener('change', () => { if (!document.documentElement.dataset.theme) applyTheme(); });
  syncRadios();
  byId('pause').addEventListener('click', (e) => {
    const on = !Stage.paused;
    Stage.setPaused(on);
    e.currentTarget.textContent = on ? 'Resume' : 'Pause';
    e.currentTarget.setAttribute('aria-pressed', String(on));
  });
  function applyMotion() {
    byId('motion-note').hidden = !motionQuery.matches || motionAnyway;
    document.documentElement.classList.toggle('motion-anyway', motionAnyway);
    for (const m of maias) { m.av.setReduced(m.av.alwaysReduced || lessMotion()); if (!m.av.reduced) m.av.dormant = false; }
    Stage.kick();
  }
  byId('motion-anyway').addEventListener('click', () => { motionAnyway = true; applyMotion(); });
  motionQuery.addEventListener('change', applyMotion);
  applyMotion();
  window.MaiaPage = { Stage, maias, avatars: new Set([...maias].map((m) => m.av)) };
})();
