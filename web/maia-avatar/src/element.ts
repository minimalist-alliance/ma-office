// <maia-avatar>, for any framework. It holds her canvas in a round, clipped stage of its own, and counts hover,
// a press or focus on itself as use. Style the element for her bubble: `maia-avatar { background: <overlay> }`.
//
//   <maia-avatar size="64" theme="dusk" sleep-after-ms="300000"></maia-avatar>
//
// Without `theme` it follows `<html data-theme>` (light, dusk or dark), then `prefers-color-scheme`.
// `paused` stops all motion. Methods are the same as createAvatar's handle, and do nothing until it's connected.

import { THEMES, createAvatar } from './avatar.js';
import type { AvatarState, EngineState, MaiaAvatar, Theme } from './avatar.js';
import type { Score } from './score.js';
import { parseScore } from './parse.js';

export interface MaiaAvatarElement extends HTMLElement {
  readonly avatar: MaiaAvatar | null;
  readonly state: EngineState | null;
  setState(state: AvatarState): void;
  playScore(input: unknown): Score | null;
  /** DANCE */
  playRoutine(name?: string): boolean;
  wake(): void;
  setRate(charsPerSecond: number): void;
  setStreamMode(on: boolean): void;
}

const isTheme = (v: unknown): v is Theme => typeof v === 'string' && (THEMES as readonly string[]).includes(v);

/** Registers the element once, as `maia-avatar` unless told otherwise, and returns its class. */
export function defineMaiaAvatar(tag = 'maia-avatar'): CustomElementConstructor {
  const known = customElements.get(tag);
  if (known) return known;

  let sheet: CSSStyleSheet | null = null;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(':host { display: inline-block; vertical-align: top; line-height: 0; border-radius: 50%; }');
  } catch {
    sheet = null; // older engines: the host stays inline, and the stage still sizes it
  }

  class Element extends HTMLElement implements MaiaAvatarElement {
    static readonly observedAttributes = ['theme', 'size', 'paused', 'sleep-after-ms'];
    #avatar: MaiaAvatar | null = null;
    readonly #stage = document.createElement('div');
    #canvas: HTMLCanvasElement | null = null;
    #watch: MutationObserver | null = null;
    #dark: MediaQueryList | null = null;
    readonly #onDark = () => this.#avatar?.setTheme(this.#theme());

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      if (sheet) root.adoptedStyleSheets = [sheet];
      this.#stage.setAttribute('part', 'stage');
      Object.assign(this.#stage.style, { position: 'relative', overflow: 'hidden', borderRadius: '50%' });
      root.append(this.#stage);
    }

    get avatar(): MaiaAvatar | null { return this.#avatar; }
    get state(): EngineState | null { return this.#avatar?.state ?? null; }
    setState(state: AvatarState): void { this.#avatar?.setState(state); }
    playScore(input: unknown): Score | null { return this.#avatar ? this.#avatar.playScore(input) : parseScore(input); }
    playRoutine(name?: string): boolean { return this.#avatar ? this.#avatar.playRoutine(name) : false; }
    wake(): void { this.#avatar?.wake(); }
    setRate(cps: number): void { this.#avatar?.setRate(cps); }
    setStreamMode(on: boolean): void { this.#avatar?.setStreamMode(on); }

    connectedCallback(): void {
      this.#start();
      this.#watch = new MutationObserver(this.#onDark);
      this.#watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      this.#dark = matchMedia('(prefers-color-scheme: dark)');
      this.#dark.addEventListener('change', this.#onDark);
    }

    disconnectedCallback(): void {
      this.#stop();
      this.#watch?.disconnect();
      this.#watch = null;
      this.#dark?.removeEventListener('change', this.#onDark);
      this.#dark = null;
    }

    attributeChangedCallback(name: string, before: string | null, after: string | null): void {
      if (!this.#avatar || before === after) return;
      if (name === 'theme') this.#avatar.setTheme(this.#theme());
      else if (name === 'paused') {
        if (after === null) this.#avatar.resume();
        else this.#avatar.pause();
      } else {
        this.#stop();
        this.#start();
      }
    }

    #size(): number {
      const n = Number(this.getAttribute('size'));
      return Number.isFinite(n) && n > 0 ? n : 64;
    }

    #theme(): Theme {
      const own = this.getAttribute('theme');
      if (isTheme(own)) return own;
      const page = document.documentElement.dataset['theme'];
      if (isTheme(page)) return page;
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    #start(): void {
      const size = this.#size();
      Object.assign(this.#stage.style, { width: `${size}px`, height: `${size}px` });
      // A fresh canvas each time, so nothing a previous one held can show behind her.
      this.#canvas?.remove();
      const canvas = document.createElement('canvas');
      canvas.style.display = 'block';
      this.#stage.append(canvas);
      this.#canvas = canvas;
      const ms = Number(this.getAttribute('sleep-after-ms'));
      this.#avatar = createAvatar(canvas, {
        size,
        theme: this.#theme(),
        activityTarget: this,
        ...(Number.isFinite(ms) && ms > 0 ? { sleepAfterMs: ms } : {}),
      });
      if (this.hasAttribute('paused')) this.#avatar.pause();
    }

    #stop(): void {
      this.#avatar?.destroy();
      this.#avatar = null;
    }
  }

  customElements.define(tag, Element);
  return Element;
}

declare global {
  interface HTMLElementTagNameMap {
    'maia-avatar': MaiaAvatarElement;
  }
}
