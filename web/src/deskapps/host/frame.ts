// The view's sandboxed frame (contract 3.2, ADR 0054): `<iframe sandbox="allow-scripts">` from `srcdoc`, never
// `allow-same-origin`, with its own policy on top of the office's. Pure, so the policy and the document are tested alone.
//
// A `srcdoc` frame inherits the office's own policy, whose `script-src` is `'self'`, so the view's script can't be inline: the
// document holds the files as data blocks, and a small boot script of ours (`boot.js`, from the office's own origin) runs the
// view's script from a `blob:` URL with its hash as `integrity`, applies its style as a constructed stylesheet and its font
// from bytes. The view's own policy lets in only that boot script and the script with that hash (CSP 3 matches a hash against an
// external script's `integrity`), so the view can run no other code, `blob:` or not. The office's policy needs `blob:` in
// `script-src` for it (the Platform's half, in `docs/sub-status/apps-host.md`); without it the frame says it couldn't start.
import { base64 } from './verify';

export interface FrameFiles {
  html: string;
  script: string;
  style: string;
  scriptHash: string;
  styleHash: string;
}

export interface FrameOptions {
  /** The boot script's absolute URL on the office's origin. */
  bootUrl: string;
  /** The UI font for the view, by family name and bytes (woff2): loaded with `FontFace`, so it needs no `data:` URL. */
  font?: { family: string; bytes: Uint8Array } | null;
  lang?: string;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** An absolute https (or a test's http) URL with nothing a policy or an attribute could be broken by. */
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.:[\]-]+\/[A-Za-z0-9._~/-]*$/;

/** The view's own policy (contract 3.2): nothing but its own script and style, `data:` images and fonts, no forms, no base. */
export function viewPolicy(bootUrl: string, scriptHash: string, styleHash: string): string {
  if (!SAFE_URL.test(bootUrl) || !B64.test(scriptHash) || !B64.test(styleHash)) throw new Error('frame: bad policy input');
  return `default-src 'none'; script-src ${bootUrl} 'sha256-${scriptHash}'; style-src 'sha256-${styleHash}'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'`;
}

const block = (id: string, bytes: Uint8Array, attrs = ''): string => `<script type="text/plain" id="${id}"${attrs}>${base64(bytes)}</script>`;
const FAMILY = /^[A-Za-z0-9 ]{1,40}$/;

/**
 * The frame's whole document. The head holds the policy, the data blocks and the boot script (deferred, so it runs once the
 * view's markup is parsed, and nothing in that markup can swallow it); the body is the view's own markup.
 */
export function viewSrcdoc(files: FrameFiles, opts: FrameOptions): string {
  const enc = new TextEncoder();
  const policy = viewPolicy(opts.bootUrl, files.scriptHash, files.styleHash);
  const lang = /^[a-zA-Z-]{2,16}$/.test(opts.lang ?? '') ? opts.lang : 'en';
  const font = opts.font && FAMILY.test(opts.font.family) ? block('ma-font', opts.font.bytes, ` data-family="${opts.font.family}"`) : '';
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    block('ma-style', enc.encode(files.style)) +
    font +
    block('ma-view', enc.encode(files.script), ` data-integrity="sha256-${files.scriptHash}"`) +
    `<script src="${opts.bootUrl}" defer></script>` +
    `</head><body>${files.html}</body></html>`
  );
}

/** The sandbox: scripts and nothing else. Never `allow-same-origin`, forms, popups, top navigation or downloads. */
export const SANDBOX = 'allow-scripts';

/**
 * What the frame may use beyond that (its `allow`): writing the clipboard, inside a tap of the view's own, so Copy works
 * (contract 3.2, "no clipboard" made "write only" by ADR 0054). Never `clipboard-read`; nothing else.
 */
export const FRAME_ALLOW = 'clipboard-write';
