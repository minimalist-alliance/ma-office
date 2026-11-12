# The view bridge: how an app's window talks to its app (appApi 1.0)

The view's side of the desk app contract's window (draft contract §3.2, ADR 0054). An app's window is its view, three files in its package (`views.window`: HTML, script, style), shown by the Desk app in a sandboxed frame with no network. Its one way out is a `MessagePort` the Desk app hands it, in the protocol below. It's the protocol of the sample app's view (`spikes/app-contract-sample/app/view/view.js`, whose first 40 lines are a complete client), and it only grows: a new field or message kind may come; nothing is renamed or removed.

## How the view runs

- The frame is `<iframe sandbox="allow-scripts" allow="clipboard-write">` built from `srcdoc`: an opaque origin, no `allow-same-origin`, no forms, popups, top navigation or downloads.
- **The clipboard is write only** (contract §3.2 as ADR 0054 changes it): `navigator.clipboard.writeText` works inside the member's own tap or key press in your view, so a Copy button can copy. Reading the clipboard is always refused. Check `document.featurePolicy?.allowsFeature("clipboard-write")` if you keep a fallback for older offices.
- Your HTML is the frame's `<body>`; put no `<script>`, `<style>`, `<link>` or `style="…"` in it (the policy refuses them). Your script runs once that body is parsed, so its elements are there. Your style is applied as a stylesheet for you. Setting styles from your script (`el.style.x`, `classList`) is fine.
- The frame's policy: `default-src 'none'`, your script and your style only by their SHA-256, `img-src data:`, `font-src data:`, `form-action 'none'`, `base-uri 'none'`. So: no `fetch`, WebSocket, images or fonts by URL, `eval`, `new Function`, or any script but your own file. Images and fonts you need go in as `data:` URLs from your own files.
- Never navigate the frame (`location`, links with no `target`, `<meta http-equiv="refresh">`): a frame that leaves its document is closed and the member sees "This app couldn't be opened safely."
- The Desk app checks MA's review signature over your manifest and every file's SHA-256 before it builds anything, so what runs is exactly what was signed.

## Start

Listen for the Desk app's first message before anything else, and accept it only from `parent`, only once:

```js
addEventListener("message", (e) => {
  if (e.source !== parent || !e.data || e.data.t !== "ma.bridge" || !e.ports[0] || port) return;
  port = e.ports[0];
  // e.data.appApi: "1.0"; e.data.tokens: the theme (below)
});
```

`{t: "ma.bridge", appApi: "1.0", tokens}` with the port in `e.ports[0]`. Everything after goes over the port. Ignore fields and message kinds you don't know.

## Calls

The view sends `{t: "call", m, p, idem, id}`:

| Field | |
|---|---|
| `m` | One of your manifest's `methods` by name. Anything else is refused by the Desk app with `not_found`, before deskd hears of it |
| `p` | An object (absent is `{}`) |
| `idem` | For a method your manifest marks `mutation: true`: a key of 8 to 64 characters from `[A-Za-z0-9_-]` (a UUIDv7, as the sample makes). Keep one key for one thing the member did, across every retry: deskd and your app answer a repeat with the first reply, so a retry can't apply twice. A mutation without one is refused with `bad_request` `{reason: "idem"}`. For a read it's ignored |
| `id` | Yours: a number or a string of up to 64 characters, echoed in the answer |

The Desk app sends a read as deskd's `apps.call` and a mutation as `apps.mutate`, by your manifest's flag for that method, never the other way round. The answer is `{t: "res", id, res}` with your app's result, or `{t: "err", id, err}` with `err` `{code, message, details?}`:
- your app's own error, when its code is one of deskd's (`bad_request`, `forbidden`, `not_found`, `precondition_failed`, `conflict`, `too_large`, `rate_limited`, `unavailable`, `deadline_exceeded`, `cancelled`); any other is `internal`;
- `unavailable` `{reason: "link"}` when the desk isn't connected: retry with the same key, as the sample does;
- `rate_limited` `{limit: "appCalls"}` past 32 calls at once;
- `deadline_exceeded` after 30 s.

## Subscriptions

The view sends `{t: "sub", topic, id}` with one of your manifest's `topics`. The Desk app subscribes to deskd's `app:<id>:<topic>` and answers `{t: "res", id, res: {subId}}` just before the first event, so your listener is in place first; then each event as `{t: "evt", sub: subId, evt: {type, data}}`, `type` `snapshot` first and `patch` after, `data` exactly as your app sent it. A patch carries values, never increments (deskd's rule: one may repeat what a snapshot had). An undeclared topic is `{t: "err", id, err: {code: "not_found"}}`; one deskd refuses before its first event is an `err` with deskd's code. A view has at most 16 subscriptions. They end when the window closes.

## Theme

`tokens` is a flat object of the office's semantic tokens (ADR 0065) by their dotted names, plus two more. It comes in `ma.bridge` and again, whole, as `{t: "theme", tokens}` on every switch of Light, Zen and Dark. Set each as a custom property, as the sample does (`"surface.window"` → `--ma-surface-window`):

| Group | Keys |
|---|---|
| `surface.` | `window`, `sunken`, `fill`, `fillStrong`, `overlay`, `scrim` |
| `text.` | `primary`, `secondary`, `tertiary`, `link`, `onAccent`, `disabled`, `danger` |
| `glyph.` | `default`, `soft`, `page` |
| `accent.` | `default`, `hover`, `pressed`, `subtle` |
| `border.` | `hairline`, `default`, `strong` |
| `focus.` | `ring` |
| `status.` | `online`, `warn`, `error` |
| `theme` | `light`, `dusk` (Zen) or `dark` |
| `font` | The office's UI font stack (its `--ma-font-ui`): `"Inter Variable", system-ui, …`. The Desk app has already loaded Inter in your frame from its bytes, so `font-family: var(--ma-font)` is all a view needs; ship no font of your own for it |

Colors are CSS color strings. An app with its own ink (the office's `APP_INKS`, keyed `app:<manifest id>`: the Bible's Lapis today; a package can't declare one yet) gets `surface.window`, `surface.sunken`, the four `accent.` values, `focus.ring`, `text.onAccent` and `text.link` in its ink while it shows in its window, as its window wears them; in an open tile or a phone's carousel it gets the office's. Keep no copy of either: take what comes, again on every `theme`.

## Limits the Desk app keeps

- The view's three files total at most 512 KiB.
- **The frame budget:** a view must not hold the office's main thread. Three frames over 50 ms in 10 s while the view shows and the office is otherwise idle, and the view is unloaded with "Paused to keep your desk smooth" and Resume. Keep work in small pieces.
- No pop-ups, notifications or sound outside the window; a notification is the widget's badge, only for something that needs the member.
