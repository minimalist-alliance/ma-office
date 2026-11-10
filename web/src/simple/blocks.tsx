// A simple page's blocks and runs as React elements (design 7.3). Everything here is the page's own words, so it
// renders as text through these components only (security review T47-6): no HTML, no style, class, id or name from
// the page, no `href` to a site, no `<form>`, and no field a password manager would take for a sign-in (T47-1).
import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { addressShown } from '../browser/address';
import { bareVote, plainText, secretIn, type Block, type Card, type Cell, type FigureImage, type InnerBlock, type Inline } from './mdoc';
import type { KeyedBlock } from './docStore';
import type { SimpleController } from './controller';

export interface PageContext {
  controller: SimpleController;
  /** The page's site, as the address bar shows it: what a sign-in or a dialog is "on". */
  site: string;
  /**
   * The site by its registrable domain, from the head's `origin` (security review T47O-3): the name the office's own
   * chrome gives it (the site row, the answer card, the island's chip), never the page's own name for itself.
   */
  domain: string;
  /**
   * The thread's poster (R42): their own later comments carry "OP", matched by exact name, even where the site shows
   * none. `post` is the post's own block, which doesn't.
   */
  op: { name: string; post: Block | null };
  renderIsland: (block: Extract<InnerBlock, { t: 'island' }>) => ReactNode;
}

export const Page = createContext<PageContext | null>(null);
export const usePage = (): PageContext => useContext(Page) as PageContext;

/** Attributes every field carries so no password manager offers or saves anything here (T47-1). */
const NO_MANAGER = { autoComplete: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' } as const;

// ----------------------------------------------------------------- images, only through the desk (T47-5)

export function DeskImage({ img, inline, fill = false, fallback = null }: { img: FigureImage; inline: boolean; fill?: boolean; fallback?: ReactNode }) {
  const { controller } = usePage();
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let live = true;
    void controller.image(img.src).then((u) => {
      if (!live) return;
      if (u) setUrl(u);
      else setGone(true);
    });
    return () => {
      live = false;
    };
  }, [controller, img.src]);
  // An inline picture the tab never had (a site's icon it didn't load) gives way to what the caller draws instead.
  if (inline) return url ? <img className="sv-icon" src={url} alt={img.alt} draggable={false} /> : gone ? fallback : null;
  // In a card the frame is the card's, so the picture fills it. One the tab never painted drops with its frame (R65):
  // the card stays, as a row with no photo, never a blank box.
  if (fill) return url ? <img src={url} alt="" decoding="async" draggable={false} onLoad={(e) => e.currentTarget.classList.add('in')} /> : gone ? <span className="sv-gone" hidden /> : null;
  if (gone) return img.alt ? <span className="sv-alt">{img.alt}</span> : null;
  const ratio = img.w && img.h ? `${img.w} / ${img.h}` : '16 / 9';
  return (
    <span className="sv-img" style={{ aspectRatio: ratio, maxWidth: img.w ? `${Math.max(img.w, 120)}px` : undefined }}>
      {url && <img src={url} alt={img.alt} decoding="async" draggable={false} onLoad={(e) => e.currentTarget.classList.add('in')} />}
    </span>
  );
}

// ----------------------------------------------------------------- inline runs

function Field({ r }: { r: Extract<Inline, { t: 'field' }> }) {
  const { controller } = usePage();
  const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // The page's own value wins when the member isn't mid-word (design 7.3, "Typing"): a cleared search box, a reformatted date.
  useEffect(() => {
    const input = el.current;
    if (!input || r.kind === 'checkbox' || r.kind === 'radio') return;
    if (input.value === r.value) return;
    if (document.activeElement !== input || (r.ref && controller.mayAdopt(r.ref))) input.value = r.value;
  }, [controller, r.kind, r.ref, r.value]);
  useEffect(() => {
    const input = el.current;
    if (input && (r.kind === 'checkbox' || r.kind === 'radio')) input.checked = r.checked;
  }, [r.kind, r.checked]);
  const name = r.label || r.placeholder || undefined;
  if (r.kind === 'checkbox' || r.kind === 'radio') {
    return (
      <label className="sv-check">
        <input ref={el} type={r.kind === 'radio' ? 'radio' : 'checkbox'} defaultChecked={r.checked} disabled={r.disabled || !r.ref} data-ref={r.ref ?? undefined} {...NO_MANAGER} />
        {r.label && <span>{r.label}</span>}
      </label>
    );
  }
  if (r.kind === 'lines') {
    return <textarea ref={el} className="sv-field sv-lines" defaultValue={r.value} placeholder={r.placeholder || r.label} aria-label={name} disabled={r.disabled || !r.ref} data-ref={r.ref ?? undefined} spellCheck {...NO_MANAGER} />;
  }
  // Only an on-screen keyboard from deskd's word for the field: the input is always `type="text"` (T47-1).
  const hint = r.hint === 'text' ? undefined : r.hint;
  return (
    <input
      ref={el}
      className="sv-field"
      type="text"
      inputMode={hint}
      enterKeyHint={r.enterSubmits ? (r.hint === 'search' ? 'search' : 'go') : undefined}
      defaultValue={r.value}
      placeholder={r.placeholder || r.label}
      aria-label={name}
      disabled={r.disabled || !r.ref}
      data-ref={r.ref ?? undefined}
      data-enter={r.enterSubmits ? '1' : undefined}
      spellCheck={false}
      autoCapitalize="off"
      {...NO_MANAGER}
    />
  );
}

/** The host an origin names, as the address bar shows it, or null. */
function originHost(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return addressShown(new URL(origin).host);
  } catch {
    return null;
  }
}

/**
 * Where a password, code, card or payment field would go: never an input here (T47-1), but the real page, one press
 * away. "Sign in on (origin)" or "Pay on (origin)", as section 14 says, naming the frame's own site when it's another's.
 */
function SignIn({ r }: { r: Extract<Inline, { t: 'secret' }> }) {
  const { controller, site } = usePage();
  const where = originHost(r.origin) ?? site;
  const verb = r.kind === 'pay' ? 'Pay' : 'Sign in';
  return (
    <button type="button" className="sv-signin" data-testid="simple-signin" onClick={() => controller.signIn(r.kind)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5.5" y="10.5" width="13" height="9" rx="2" />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      </svg>
      {where ? `${verb} on ${where}` : `${verb} on the real page`}
    </button>
  );
}

/**
 * A field this office never types into (T47O-1): a date, time, colour, range or file field, a select of several, or a
 * kind it doesn't know. Its label and value as text, then "Use the real page", which opens the page there.
 */
function Picker({ r }: { r: Extract<Inline, { t: 'picker' }> }) {
  const { controller } = usePage();
  const name = r.label || r.value;
  return (
    <span className="sv-picker" data-testid="simple-picker">
      {name && <span className="sv-picker-label">{name}</span>}
      {r.label && r.value && <span className="sv-picker-value">{r.value}</span>}
      <button type="button" className="sv-button" disabled={r.disabled} aria-label={name ? `${name}: use the real page` : undefined} onClick={controller.showFull}>
        Use the real page
      </button>
    </span>
  );
}

export function Runs({ c }: { c: readonly Inline[] }) {
  return (
    <>
      {c.map((r, i) => (
        <Run key={i} r={r} />
      ))}
    </>
  );
}

export function Run({ r }: { r: Inline }) {
  switch (r.t) {
    case 'text':
      return <>{r.text}</>;
    case 'br':
      return <br />;
    case 'mark': {
      const Tag = r.kind;
      return (
        <Tag>
          <Runs c={r.c} />
        </Tag>
      );
    }
    case 'link':
      // No `href` (T47-6, the Designer's section 13): Enter or a click goes to the real page, Ctrl, Cmd or a middle click
      // opens a desk tab, its host shows in the bar's note slot on hover or focus, and its menu has "Copy link".
      return (
        <a className="sv-link" role="link" tabIndex={0} aria-label={r.name || undefined} aria-disabled={r.ref ? undefined : true} data-ref={r.ref ?? undefined} data-url={r.url ?? undefined}>
          <Runs c={r.c} />
        </a>
      );
    case 'img':
      return <DeskImage img={{ src: r.src, alt: r.alt, w: r.w, h: r.h }} inline />;
    case 'button':
      return (
        <button
          type="button"
          className="sv-button"
          data-ref={r.ref ?? undefined}
          disabled={r.disabled || !r.ref}
          aria-pressed={r.pressed ?? undefined}
          aria-expanded={r.expanded ?? undefined}
          data-selected={r.selected === true ? '1' : undefined}
          data-primary={r.primary ? '1' : undefined}
          aria-label={r.name && r.name !== r.label ? r.name : undefined}
        >
          {r.label}
        </button>
      );
    case 'field':
      return <Field r={r} />;
    case 'select':
      return (
        // By index, as `act select` takes it: the page's option values never come here.
        <select className="sv-field sv-select" defaultValue={r.selected >= 0 ? String(r.selected) : ''} aria-label={r.label || undefined} disabled={r.disabled || !r.ref} data-ref={r.ref ?? undefined} {...NO_MANAGER}>
          {r.selected < 0 && <option value="" disabled hidden />}
          {r.options.map((o, i) => (
            <option key={i} value={String(i)}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'picker':
      return <Picker r={r} />;
    case 'secret':
      return <SignIn r={r} />;
    case 'vote':
      return <Vote r={r} />;
  }
}

/**
 * ▲ 60 ▼: one control for a site's votes (the spec's R26). Each arrow is the real page's own control, and only the arrows
 * the site has show (R40): a site with no score and only ▲ on its comments gets a bare ▲, with no number and no word.
 * The arrows are the spec's vote glyph (the block arrow of its real-page stills), never a plain ↑, which reads as "to top".
 */
function Vote({ r }: { r: Extract<Inline, { t: 'vote' }> }) {
  return (
    <span className={`sv-vote${!r.score && !(r.up && r.down) ? ' sv-vote-bare' : ''}`} role="group" aria-label={r.score ? `Score ${r.score}` : 'Votes'} data-state={r.state ?? undefined}>
      {r.up && (
        <button type="button" className="sv-vote-btn" data-ref={r.up} aria-label="Upvote" aria-pressed={r.state === 'up'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4.8 5.2 12.3h4.2v6.9h5.2v-6.9h4.2Z" />
          </svg>
        </button>
      )}
      {r.score && <span className="sv-vote-n">{r.score}</span>}
      {r.down && (
        <button type="button" className="sv-vote-btn" data-ref={r.down} aria-label="Downvote" aria-pressed={r.state === 'down'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19.2 5.2 11.7h4.2V4.8h5.2v6.9h4.2Z" />
          </svg>
        </button>
      )}
    </span>
  );
}

const REPLY = /^(reply|comment|answer)$/i;

/**
 * A line that's who and when, with its few actions at the right: a post's name line (R26: the vote and Reply), a video's
 * channel row (R17: name and subscribers, then Subscribe, Like and Share as one quiet row), or a folded reply's name line
 * with nothing to press ("ana_k · Nov 5"). Null for an ordinary paragraph.
 */
function nameLine(c: readonly Inline[]): { who: Inline[]; acts: Inline[]; channel: boolean } | null {
  if (c.some((r) => r.t === 'vote')) {
    return { who: c.filter((r) => r.t !== 'vote' && !(r.t === 'button' && REPLY.test(r.label))), acts: c.filter((r) => r.t === 'vote' || (r.t === 'button' && REPLY.test(r.label))), channel: false };
  }
  const buttons = c.filter((r) => r.t === 'button');
  const who = c.filter((r) => r.t !== 'button');
  const words = plainText(who).trim();
  if (buttons.length >= 2 && words.length <= 80 && /\p{L}/u.test(words) && !c.some((r) => r.t === 'field' || r.t === 'select' || r.t === 'link')) return { who, acts: buttons, channel: true };
  const first = c[0];
  if (!buttons.length && first?.t === 'mark' && first.kind === 'strong' && words.length <= 60 && words.includes(' · ')) return { who, acts: [], channel: false };
  return null;
}

/** The name a name line starts with: its first bold run, as a thread's line has it. */
export function nameOf(c: readonly Inline[]): string {
  const first = c[0];
  return first?.t === 'mark' && first.kind === 'strong' ? plainText(first.c).trim() : '';
}

/** The poster of a thread (R42): the article's own byline, else the question's author, else the first post's name line. */
export function posterOf(blocks: readonly Block[], byline: readonly string[]): { name: string; post: Block | null } {
  if (byline[0]) return { name: byline[0], post: null };
  for (const b of blocks) {
    if (b.t === 'comment' && b.kind === 'question' && b.author) return { name: b.author, post: b };
    if (b.t === 'comment' && b.author) return { name: '', post: null };
    if (b.t === 'para' && b.c.some((r) => r.t === 'vote')) {
      const name = nameOf(b.c);
      return { name, post: name ? b : null };
    }
  }
  return { name: '', post: null };
}

/** "OP", where a later comment is by the thread's poster (R42). */
function Op({ name, b }: { name: string; b: Block }) {
  const { op } = usePage();
  return op.name && name === op.name && b !== op.post ? <span className="sv-tag sv-role sv-op">OP</span> : null;
}

/** The spec's own fold chevron, for every line that opens in place: never the browser's ▶ and ▼. */
export function Chevron() {
  return (
    <svg className="sv-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 9.5 12 15l5.5-5.5" />
    </svg>
  );
}

// ----------------------------------------------------------------- blocks

function TableBlock({ rows }: { rows: Cell[][] }) {
  return (
    <div className="sv-table" tabIndex={0} role="region" aria-label="Table">
      <table>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) =>
                cell.head ? (
                  <th key={j} scope={i === 0 ? 'col' : 'row'} colSpan={cell.span > 1 ? cell.span : undefined}>
                    <Runs c={cell.c} />
                  </th>
                ) : (
                  <td key={j} colSpan={cell.span > 1 ? cell.span : undefined}>
                    <Runs c={cell.c} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Stars out of 5, as words for a screen reader and a quiet glyph for the eye, with how many rated it (R13). */
function Stars({ value, count }: { value: string; count: string }) {
  return (
    <span className="sv-card-stars" role="img" aria-label={`${value} out of 5${count ? `, ${count} ratings` : ''}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z" fill="currentColor" />
      </svg>
      <span aria-hidden="true">{value}</span>
      {count && <span className="sv-card-count" aria-hidden="true">({count})</span>}
    </span>
  );
}

/** "8:14" as words, for a screen reader: the badge is only a picture of it. */
function spokenDuration(text: string): string {
  const parts = text.split(':').map(Number);
  const seconds = parts.reduce((t, n) => t * 60 + n, 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const part = (n: number, word: string): string => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
  return [part(h, 'hour'), part(m, 'minute'), part(s, 'second')].filter(Boolean).join(' ');
}

/** A listing card's condition worth a line of its own (R13): only when it's bad. */
const BAD_CONDITION = /\b(out of stock|sold out|unavailable|no longer available|discontinued|agotado|épuisé|ausverkauft|esaurito|uitverkocht)\b/i;

/** A duration a page printed on a video's card, such as "8:14" or "1:02:05". */
const DURATION = /^\d{1,2}(:\d{2}){1,2}$/;

type CardKind = 'result' | 'video' | 'product' | 'link';

/** Which of the spec's card patterns a run of cards is: what the distiller found decides, never the site's styles. */
export function cardKind(layout: 'grid' | 'list', items: readonly Card[], inGroup: boolean): CardKind {
  if (inGroup) return 'link';
  if (layout === 'list') return 'result';
  const ratios = items.flatMap((i) => (i.img && i.img.w && i.img.h ? [i.img.w / i.img.h] : []));
  const wide = ratios.filter((r) => r > 1.4).length;
  return ratios.length && wide > ratios.length / 2 ? 'video' : 'product';
}

/**
 * Repeated things as cards (the rating's second fix; the Designer's spec, section 4): results separated by hairlines,
 * videos with a 16:9 thumbnail and duration, products with their picture, price and rating, and link cards two to a
 * row. The title is the card's link; its picture opens the same thing; its own buttons act on the real page.
 */
function Cards({ layout, items, inGroup = false }: { layout: 'grid' | 'list'; items: readonly Card[]; inGroup?: boolean }) {
  const kind = cardKind(layout, items, inGroup);
  return (
    <ul className={`sv-cards sv-cards-${kind}`} data-testid="simple-cards" data-kind={kind}>
      {items.map((it, i) => {
        // The wire's own `duration`; a capture without one may have it among the meta.
        const duration = kind === 'video' ? it.duration || it.meta.find((m) => DURATION.test(m)) : undefined;
        const meta = duration ? it.meta.filter((m) => m !== duration) : it.meta;
        // R13, as the Designer called it: one badge, one delivery line, and a condition only when it's bad; no chips.
        const product = kind === 'product';
        const condition = product ? [it.deal, ...it.meta, ...it.chips].find((x) => BAD_CONDITION.test(x)) : undefined;
        const extra = product ? '' : [it.deal, it.delivery].filter(Boolean).join(' · ');
        return (
          <li key={it.ref ?? i} className="sv-card">
            {it.img && (
              <span className="sv-card-img" data-ref={it.ref ?? undefined} data-url={it.url ?? undefined} aria-hidden="true">
                <DeskImage img={it.img} inline={false} fill />
                {duration && <span className="sv-card-dur">{duration}</span>}
              </span>
            )}
            <span className="sv-card-text">
              <a className="sv-link sv-card-title" role="link" tabIndex={0} data-ref={it.ref ?? undefined} data-url={it.url ?? undefined}>
                {it.title}
                {duration && <span className="sv-sr">, {spokenDuration(duration)}</span>}
              </a>
              {it.badge && <span className="sv-tag sv-card-badge">{it.badge}</span>}
              {(it.price || it.stars) && (
                <span className="sv-card-line">
                  {it.price && <span className="sv-card-price">{it.price}</span>}
                  {it.price && it.listPrice && <s className="sv-card-list">{it.listPrice}</s>}
                  {it.stars && <Stars value={it.stars} count={it.ratingCount} />}
                </span>
              )}
              {condition && <span className="sv-card-meta sv-card-bad">{condition}</span>}
              {product && it.delivery && <span className="sv-card-meta">{it.delivery}</span>}
              {extra && <span className="sv-card-meta">{extra}</span>}
              {it.snippet && kind === 'result' && <span className="sv-card-snippet">{it.snippet}</span>}
              {!product && meta.length > 0 && <span className="sv-card-meta">{meta.join(' · ')}</span>}
              {!product && it.chips.length > 0 && (
                <span className="sv-card-chips">
                  {it.chips.map((c, j) => (
                    <span key={j} className="sv-tag">
                      {c}
                    </span>
                  ))}
                </span>
              )}
              {it.actions.length > 0 && (
                <span className="sv-card-actions">
                  <Runs c={it.actions} />
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A code block keeps its lines, and a local Copy: the member's own clipboard, nothing sent anywhere. */
/** Code over this many lines folds (the spec's R33)... */
export const CODE_FOLD_OVER = 20;
/** ...at this many, with a fade and "Show all N lines". */
export const CODE_FOLD_AT = 12;

function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const folds = lines.length > CODE_FOLD_OVER;
  const shown = folds && !all ? lines.slice(0, CODE_FOLD_AT).join('\n') : text;
  useEffect(() => {
    if (!copied) return undefined;
    const id = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <div className="sv-block sv-code">
      <div className="sv-code-bar">
        <button
          type="button"
          className="sv-code-copy"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 8.5h9.5A1.5 1.5 0 0 1 20 10v9.5a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 19.5V10A1.5 1.5 0 0 1 9 8.5ZM16.5 8.5V5A1.5 1.5 0 0 0 15 3.5H5.5A1.5 1.5 0 0 0 4 5v9.5A1.5 1.5 0 0 0 5.5 16h2" />
          </svg>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={`sv-pre${folds && !all ? ' sv-pre-folded' : ''}`} tabIndex={0} aria-label="Code">
        {shown}
      </pre>
      {folds && (
        <button
          type="button"
          className="sv-code-all"
          aria-expanded={all}
          onClick={(e) => {
            e.stopPropagation();
            setAll(!all);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={all ? 'M6.5 14.5 12 9l5.5 5.5' : 'M6.5 9.5 12 15l5.5-5.5'} />
          </svg>
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/** "Description", "Comments · 214": one quiet line that opens in place (R17); or a post's first comments, then the rest (R32). */
function Fold({ b }: { b: Extract<Block, { t: 'fold' }> }) {
  const { controller } = usePage();
  // "119 comments" under Comments says "Comments · 119".
  const meta = b.meta.toLowerCase().endsWith(` ${b.name.toLowerCase()}`) ? b.meta.slice(0, -b.name.length - 1) : b.meta;
  if (b.lead > 0) {
    const rest = b.blocks.slice(b.lead);
    return (
      <div className={`sv-block sv-fold-lead${b.kind === 'comments' ? ' sv-fold-comments' : ''}`} data-testid="simple-fold">
        {b.blocks.slice(0, b.lead).map((x, i) => (
          <BlockBody key={i} b={x} />
        ))}
        {rest.length > 0 && (
          <details className="sv-fold-more">
            <summary>
              {b.meta || `More ${b.name.toLowerCase()}`}
              <Chevron />
            </summary>
            {rest.map((x, i) => (
              <BlockBody key={i} b={x} />
            ))}
          </details>
        )}
      </div>
    );
  }
  const head = (
    <>
      <svg className="sv-fold-ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {b.kind === 'comments' ? <path d="M5.5 5.5h13a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5v-3.5h0A1.5 1.5 0 0 1 4 15V7a1.5 1.5 0 0 1 1.5-1.5Z" /> : <path d="M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 11v5.5M12 7.75v.5" />}
      </svg>
      <span className="sv-fold-name">{b.name}</span>
      {meta && <span className="sv-fold-meta"> · {meta}</span>}
      <svg className="sv-fold-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6.5 9.5 12 15l5.5-5.5" />
      </svg>
    </>
  );
  // Nothing the view could read (YouTube keeps its comments in a side panel): the line opens the real page.
  if (!b.blocks.length) {
    return (
      <div className="sv-block sv-fold-row-wrap">
        <button type="button" className="sv-fold sv-fold-row" data-testid="simple-fold" onClick={controller.showFull}>
          {head}
        </button>
      </div>
    );
  }
  return (
    <details className={`sv-block sv-fold${b.kind === 'comments' ? ' sv-fold-comments' : ''}`} data-testid="simple-fold">
      <summary className="sv-fold-row">{head}</summary>
      <div className="sv-fold-body">
        {b.blocks.map((x, i) => (
          <BlockBody key={i} b={x} />
        ))}
      </div>
    </details>
  );
}

/** A link chip for one of an answer's sources: a letter tile and the host. */
function SourceChip({ r }: { r: Extract<Inline, { t: 'link' }> }) {
  const host = r.url ? addressShown(new URL(r.url).host).replace(/^www\./, '') : '';
  const words = r.c.length ? null : host;
  return (
    <a className="sv-src" role="link" tabIndex={0} data-ref={r.ref ?? undefined} data-url={r.url ?? undefined}>
      <span className="sv-src-tile" aria-hidden="true">
        {(host || '?').charAt(0).toUpperCase()}
      </span>
      {words ?? <Runs c={r.c} />}
    </a>
  );
}

/** The engine's own answer, as one card above the results, folded at about 8 lines (R22). */
function Answer({ b }: { b: Extract<Block, { t: 'answer' }> }) {
  const { domain } = usePage();
  const body = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // Folded at about 8 lines (R22): measured again whenever its words take their size (Nunito arriving, a narrower window).
  useEffect(() => {
    const el = body.current;
    const content = inner.current;
    if (!el || !content) return undefined;
    const check = (): void => setOverflows(content.offsetHeight > el.clientHeight + 4);
    check();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(check);
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [b]);
  return (
    <section className="sv-block sv-answer" aria-label={b.name} data-testid="simple-answer">
      <p className="sv-answer-name">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3.5 13.8 9l5.7 1.5-5.7 1.5L12 17.5 10.2 12 4.5 10.5 10.2 9ZM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" />
        </svg>
        {b.name}
        {/* The site that says so, as the office names it (T47O-3): the page's own label is never the only name here. */}
        {domain && <span className="sv-answer-host"> · {domain}</span>}
      </p>
      <div ref={body} className={`sv-answer-body${open ? ' open' : ''}${overflows && !open ? ' folded' : ''}`}>
        <div ref={inner}>
          {b.blocks.map((x, i) => (
            <BlockBody key={i} b={x} />
          ))}
        </div>
      </div>
      {(b.sources.length > 0 || overflows) && (
        <div className="sv-answer-foot">
          <span className="sv-answer-srcs">
            {b.sources.map((r, i) => (
              <SourceChip key={i} r={r} />
            ))}
          </span>
          {overflows && (
            <button type="button" className="sv-answer-more" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
              {open ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** What the site recommends after the content, folded at the end: there if wanted, never in the way. */
function Group({ name, blocks }: { name: string; blocks: readonly InnerBlock[] }) {
  return (
    <details className="sv-block sv-group" data-testid="simple-group">
      <summary>
        {name}
        <Chevron />
      </summary>
      {blocks.map((b, i) => (
        <BlockBody key={i} b={b} inGroup />
      ))}
    </details>
  );
}

const HEADINGS = ['h1', 'h2', 'h3', 'h4'] as const;

/**
 * `level`: a heading's place in the page's outline (`SimpleLayer`'s `outline`: one h1, no skipped level, the spec's
 * section 12). Without one, a heading is the site's own inside a card, fold, group or dialog, styled but not in the
 * outline. `inGroup`: inside a closing group, whose cards are link cards. `li`: an item in a list.
 */
function BlockBody({ b, inGroup = false, level, li = false, anchor }: { b: Block; inGroup?: boolean; level?: number; li?: boolean; anchor?: string }) {
  const { renderIsland } = usePage();
  switch (b.t) {
    case 'heading': {
      const Tag = level ? HEADINGS[Math.min(level, HEADINGS.length) - 1] ?? 'h4' : 'p';
      return (
        <Tag className={`sv-block sv-h sv-h${b.level}`} data-head={anchor} tabIndex={anchor ? -1 : undefined}>
          <Runs c={b.c} />
        </Tag>
      );
    }
    case 'para': {
      const cls = `sv-block sv-p${b.quote ? ' sv-quote' : ''}${b.nest ? ` sv-nest sv-n${b.nest}` : ''}`;
      const secret = secretIn(b.c);
      if (secret) return <p className={cls}><SignIn r={secret} /></p>;
      const bare = bareVote(b.c);
      if (bare) return <p className={`${cls} sv-votecell`}><Vote r={bare} /></p>;
      const line = nameLine(b.c);
      if (line) {
        // A channel's letter tile stands for its avatar, in the accent (the Designer's section 13: calmer than its colors).
        const letter = line.channel ? plainText(line.who).trim().charAt(0).toUpperCase() : '';
        return (
          <div className={`${cls} sv-nameline${line.channel ? ' sv-channel' : ''}`}>
            {letter && (
              <span className="sv-avatar" aria-hidden="true">
                {letter}
              </span>
            )}
            <span className="sv-nameline-who">
              <Runs c={line.who} />
              {!line.channel && <Op name={nameOf(b.c)} b={b} />}
            </span>
            {line.acts.length > 0 && (
              <span className="sv-nameline-acts">
                <Runs c={line.acts} />
              </span>
            )}
          </div>
        );
      }
      return (
        <p className={cls}>
          <Runs c={b.c} />
        </p>
      );
    }
    case 'byline':
      return (
        <p className="sv-block sv-byline">
          <Runs c={b.c} />
        </p>
      );
    case 'item': {
      const Tag = li ? 'li' : 'div';
      return (
        <Tag className={`sv-block sv-li sv-d${b.depth}${b.term ? ' sv-term' : ''}${b.quote ? ' sv-quote' : ''}`} data-marker={b.marker ?? (b.bullet ? '•' : undefined)}>
          {secretIn(b.c) ? <SignIn r={secretIn(b.c) as Extract<Inline, { t: 'secret' }>} /> : <Runs c={b.c} />}
        </Tag>
      );
    }
    case 'code':
      return <Code text={b.text} />;
    case 'rule':
      return <hr className="sv-block sv-hr" />;
    case 'figure':
      return (
        <figure className="sv-block sv-figure sv-wide">
          {b.ref ? (
            // An image that's a link: the press goes to the real page, as the link's would (T47-6: no `href`).
            <a className="sv-figure-link" role="link" tabIndex={0} data-ref={b.ref} data-url={b.url ?? undefined} aria-label={b.img.alt || (b.url ? addressShown(b.url) : undefined)}>
              <DeskImage img={b.img} inline={false} />
            </a>
          ) : (
            <DeskImage img={b.img} inline={false} />
          )}
        </figure>
      );
    case 'table':
      return <div className="sv-block sv-wide"><TableBlock rows={b.rows} /></div>;
    case 'island':
      return <div className={`sv-block sv-island-row${b.main ? ' sv-island-main' : ''}`}>{renderIsland(b)}</div>;
    case 'cards':
      return (
        <div className="sv-block sv-cards-row">
          <Cards layout={b.layout} items={b.items} inGroup={inGroup} />
        </div>
      );
    case 'bar':
      // The site row at the top shows it (`SiteRow.tsx`).
      return null;
    case 'group':
      return <Group name={b.name} blocks={b.blocks} />;
    case 'fold':
      return <Fold b={b} />;
    case 'answer':
      return <Answer b={b} />;
    case 'filters':
      // The filter row under the site row shows it (`FilterRow` in `SiteRow.tsx`).
      return null;
    case 'comment':
      return <Comment b={b} />;
    case 'paywall':
      return <Paywall />;
  }
}

/**
 * A comment, answer or question (R26 to R30): the name line (who, their role, the accepted mark; Reply and the vote at
 * the right), then the body, under its thread's rule. A comment the site folds stays folded, one press from its body.
 */
function Comment({ b }: { b: Extract<Block, { t: 'comment' }> }) {
  const { controller } = usePage();
  const cls = `sv-block sv-comment${b.kind === 'comment' || b.nest ? ' sv-reply' : ''}${b.nest ? ` sv-nest sv-n${b.nest}` : ''}${b.accepted ? ' sv-accepted' : ''}`;
  const who = (
    <span className="sv-nameline-who">
      {b.author && <strong>{b.author}</strong>}
      {b.role && <span className="sv-tag sv-role">{b.role}</span>}
      {!b.role && <Op name={b.author} b={b} />}
      {b.accepted && <span className="sv-tag sv-accepted-tag">Accepted</span>}
    </span>
  );
  const acts = (b.reply || b.vote) && (
    <span className="sv-nameline-acts">
      {b.reply && <Run r={b.reply} />}
      {b.vote && <Run r={b.vote} />}
    </span>
  );
  const secret = secretIn(b.c);
  const body = secret ? <SignIn r={secret} /> : <Runs c={b.c} />;
  const more = b.more > 0 && (
    // How many replies the real page holds back: the line opens it there.
    <button type="button" className="sv-comment-more" onClick={controller.showFull}>
      {b.more === 1 ? '1 more reply' : `${b.more} more replies`}
    </button>
  );
  if (b.collapsed) {
    return (
      <details className={cls}>
        <summary className="sv-nameline">
          {who}
          <Chevron />
        </summary>
        {b.c.length > 0 && <p className="sv-comment-body">{body}</p>}
        {more}
      </details>
    );
  }
  return (
    <div className={cls}>
      {(b.author || b.role || b.accepted || acts) && (
        <div className="sv-nameline">
          {who}
          {acts}
        </div>
      )}
      {b.c.length > 0 && <p className="sv-comment-body">{body}</p>}
      {more}
    </div>
  );
}

/**
 * The real page stops here for this member (section 14's policy: never more than the real page shows them). One line,
 * whose two words go to the real page, where the member can subscribe or sign in (the Designer's section 13).
 */
function Paywall() {
  const { controller } = usePage();
  return (
    <p className="sv-block sv-paywall" data-testid="simple-paywall">
      The rest is for subscribers ·{' '}
      <button type="button" className="sv-paywall-link" onClick={controller.showFull}>
        Subscribe
      </button>{' '}
      or{' '}
      <button type="button" className="sv-paywall-link" onClick={controller.showFull}>
        sign in
      </button>{' '}
      on the real page
    </p>
  );
}

/** One block. Memoized on the block, which keeps its object while it doesn't change (`docStore.ts`). */
export const BlockView = memo(function BlockView({ kb, level, li }: { kb: KeyedBlock; level?: number; li?: boolean }) {
  // A section's heading is where "In this article" takes the member (R58).
  return <BlockBody b={kb.block} level={level} li={li} anchor={level === 2 ? kb.key : undefined} />;
});

/** A dialog the page put over itself, in a frame of its own that names the site: never in the office's own look (T47-6). */
export function DialogFrame({ blocks, site }: { blocks: KeyedBlock[]; site: string }) {
  // Its own words and buttons act on the real page; a password, code or card field in it is "Sign in on (site)" (T47-1).
  return (
    <section className="sv-dialog" aria-label={site ? `From ${site}` : 'From the page'} data-testid="simple-dialog">
      <p className="sv-dialog-from">{site ? `From ${site}` : 'From the page'}</p>
      {blocks.map((kb) => (
        <BlockView key={kb.key} kb={kb} />
      ))}
    </section>
  );
}
