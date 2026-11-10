// One Browser window's simple-view state, as the main bundle sees it: the bar's switch, the panel and the stream read
// this, and the lazy chunk (`SimpleLayer.tsx`) writes it. Nothing here changes per frame.
import type { PageLine, SiteChoice, ViewDecision } from './decide';

/** What the desk's stream should do: `simple` keeps it warm (no picture sent), `island` streams one island's crop, `off` is the real page. */
export type SimpleStream = 'off' | 'simple' | 'island';

export interface SimpleUiState {
  /**
   * The switch is shown: the desk serves the simple view, or hasn't said yet once asked. Null while the window asks whether
   * it does at all: no switch yet, and the quality menu shows as it always has beside the real page.
   */
  available: boolean | null;
  decision: ViewDecision;
  /** The simple view covers the picture, including while the full page's first frame is on its way. */
  covering: boolean;
  stream: SimpleStream;
  /** The bar's one line beside the switch, or null. */
  line: PageLine | null;
  /** The page's host, as the switch's tooltip names it. */
  host: string;
  /**
   * The host a link in the view goes to, while the pointer or the focus is on it, for the bar's note slot (the Designer's
   * section 13: a link with no `href` still says where it goes). Empty for none.
   */
  linkHost: string;
}

/**
 * Before the desk has said it serves the simple view: the real page, started exactly as it always was, with nothing
 * covering it and no switch. The question goes beside it, never ahead of it; a desk that answers yes switches to the view.
 */
export const SIMPLE_START: SimpleUiState = {
  available: null,
  decision: { view: 'simple', canSwitch: false, why: 'waiting' },
  covering: false,
  stream: 'off',
  line: null,
  host: '',
  linkHost: '',
};

export class SimpleUi {
  private state = SIMPLE_START;
  private readonly listeners = new Set<() => void>();
  /** The chunk's switch. Until it has loaded, a press does nothing, as there's nothing to switch yet. */
  toggle: () => void = () => undefined;
  /** The switch's segments: this view, remembered for the site. */
  choose: (view: SiteChoice) => void = () => undefined;
  /** The line's action: Undo, Try again, or the real page. */
  lineAction: () => void = () => undefined;
  /** The pointer or the focus is on the line: its 8 s Undo waits (WCAG 2.2.1). */
  holdLine: (held: boolean) => void = () => undefined;

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly get = (): SimpleUiState => this.state;

  set(patch: Partial<SimpleUiState>): void {
    const keys = Object.keys(patch) as (keyof SimpleUiState)[];
    if (keys.every((k) => this.state[k] === patch[k])) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  reset(): void {
    this.toggle = () => undefined;
    this.choose = () => undefined;
    this.lineAction = () => undefined;
    this.holdLine = () => undefined;
    this.set(SIMPLE_START);
  }
}
