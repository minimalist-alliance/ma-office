// The message frame (the launch plan §3.1; Security's conditions for Wave 1.6 in the parse read, Q3). Pure, so the policy and
// the document are tested alone.
//
// A message's HTML is the `desk-parse` sandbox's sanitized output (`courier.message.html`): no script, no live URL, links with
// no `href`. It's shown only here, never in the office's own document, in a `srcdoc` frame:
// - `sandbox=""`: no `allow-scripts` and no `allow-same-origin`, so an opaque origin with no script, form, popup, top
//   navigation, download or plugin. A sanitizer bug still runs nothing, and the office can't be reached from it;
// - its own policy as the document's first element: nothing loads but `data:` images and Courier's one stylesheet from the
//   office's own origin, no form posts anywhere, no base URL;
// - and the office's own policy on top, which a `srcdoc` frame inherits (`default-src 'self'`, no inline style), so the frame
//   can only ever narrow it.
// A link the sanitizer let through with an `href` anyway goes nowhere: the attribute is renamed here, the office's own policy has
// no `frame-src` but the Platform's host, and the sandbox has no popups or top navigation.
// The message's own inline styles don't apply under the office's policy (it has no `style-src 'unsafe-inline'`), so a message
// shows with its structure, its table colours and widths, and Courier's stylesheet. Bringing its own styles back needs the frame
// served from its own path with its own header (the status doc's question for Platform).
import { decodeEntities } from './model';

/** The sandbox: no tokens at all. Never `allow-scripts` or `allow-same-origin`. */
export const MAIL_SANDBOX = '';

/** An absolute http(s) URL with nothing a policy or an attribute could be broken by (the office's own stylesheet). */
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.:[\]-]+\/[A-Za-z0-9._~/-]*\.css$/;

/** The frame's own policy. `style` is the stylesheet's absolute URL, or null for none. */
export function mailPolicy(style: string | null): string {
  const css = style && SAFE_URL.test(style) ? style : null;
  return `default-src 'none'; img-src data:; style-src ${css ?? "'none'"}; font-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
}

/**
 * The attributes that could take the frame somewhere, renamed wherever they're written in the message, so a link or a press
 * goes nowhere. Across the whole body, not tag by tag: no pattern for a tag's end is the HTML parser's in every case (Security's
 * CA-I1 and its follow-up). The cost is cosmetic: words such as `href="…"` in a message's text read `data-x-href="…"`.
 */
const GOES = /([\s"'/])(href|action|formaction|ping|xlink:href|srcdoc)(\s*=)/gi;

/** What the document must never carry, whatever the sanitizer wrote: a second policy or base, a refresh, a script. */
const NEVER = /<\s*(?:meta|base|script|link|iframe|frame|object|embed|form)\b/gi;

/**
 * The frame's whole document. The head holds the policy, first, then Courier's stylesheet; the body is the message. Anything
 * that could change the document's policy, base or loading (`meta`, `base`, `link`, `script`, frames, objects, forms) is
 * neutralised as text, and any attribute that could navigate (`href`, `action`, `formaction`, `ping`) renamed, before it goes
 * in: a second guard after the sanitizer's own.
 */
export function mailSrcdoc(html: string, opts: { style: string | null; lang?: string; paper?: string }): string {
  const style = opts.style && SAFE_URL.test(opts.style) ? opts.style : null;
  const lang = /^[a-zA-Z-]{2,16}$/.test(opts.lang ?? '') ? opts.lang : 'en';
  // Which paper the stylesheet paints: one of the theme's three names, nothing else ever reaches the attribute.
  const paper = opts.paper === 'dusk' || opts.paper === 'dark' ? opts.paper : 'light';
  const body = html.replace(NEVER, (m) => m.replace('<', '&lt;')).replace(GOES, '$1data-x-$2$3');
  return (
    `<!doctype html><html lang="${lang}" data-paper="${paper}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${mailPolicy(style)}">` +
    `<meta name="referrer" content="no-referrer">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    (style ? `<link rel="stylesheet" href="${style}">` : '') +
    `</head><body>${body}</body></html>`
  );
}

/** The message's text as one line of words, for a frame's accessible description where it needs one. */
export const textOf = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
