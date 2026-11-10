# 0052. Account settings is a full-screen modal over the office, framing the Platform account page beside "Your data"

**Status:** Accepted (the owner's order, 2026-11-09)
**Date:** 2026-11-09

## Context
The account menu had three links that each opened a new tab, every one marked "(opens in a new tab)": "Download your data" (the office's `/export`), "Account settings" (the Platform app's `/account`, another origin) and "Report a safety concern". Picture quality's "Change your default" did the same. The owner, on 2026-11-09: "Download data doesn't need to be anywhere but in an appropriate section in account settings. I would prefer account settings to be a full screen modal instead of a new tab or page", and the "(opens in a new tab)" notes removed.

A new page in this tab would close the member's desk windows and anything unsent in them, which is why the links opened tabs. Constraints:

- **The account page has to stay the Platform app's.** Its sign-in codes and "Stay signed in" routes accept only `platform-web`'s token (ma-platform contract `auth.md`, 0.3.27): an office token is `403`. Billing, the Founder request, the streaming and agent defaults all live there too. Rebuilding it in the office would duplicate a page in two repos and still couldn't do those parts.
- **The download has to stay the office's.** Desk files go straight from each desk to the member's computer, never through the Platform (draft ADR "data export and transfer").
- Nothing was framable: the office's CSP is `default-src 'self'` with no `frame-src`, and every Platform page sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- The Platform's own sign-in pages and Cognito's managed login refuse framing, and must keep refusing it.

## Decision
1. **Account settings is a full-screen modal in the office** (`src/settings/`), opened from the account menu and from Picture quality's "Change your default". It has a close button and Esc, gives focus back to what opened it, and covers the whole screen on a phone (a 12 px margin on wider screens). It's a lazy chunk.
2. **Its "Account" section frames the Platform account page**: `links.account` with `?embed=office`, in a sandboxed `<iframe>` (scripts, same origin, forms, popups; no top navigation, so nothing in it can take the office away). Platform (contract `hostnames.md` 0.3.49) lets only the office's origins frame `/account` exactly (prod `https://office.minimalistalliance.com`; staging `https://office.staging.…` and `https://test.office.staging.…`), with no `X-Frame-Options` on that path, and adds `frame-src https://platform.<suffix>` to the office's CSP. Nothing wider: every other Platform path, and the sign-in pages, still refuse framing. Framed, the page hides its own header, "Go to your office", "Download your data" and "Sign out everywhere", and opens anything that leaves it (Billing, Stripe) in a new tab.
3. **The frame and the office speak one message**, `{type: 'ma-account', state}`, posted by the page to the office's origins only, never `*`, and read by the office only from that frame's window at the account link's origin (`accountFrame.ts`): `ready` (the page has loaded the member), `signed-out` (instead of going to sign-in, which can't be framed), `escape` (Esc pressed inside the frame).
4. **The frame shows only after `ready`.** Until then it's hidden under "Loading…", so a refused frame never shows the browser's error. If the office's own CSP refuses it (`securitypolicyviolation`, at once) or it says nothing for 10 s, the section shows the member and an "Open account settings" link to the page in its own tab. That's what prod shows until Platform's Terraform is applied. `signed-out` shows a Sign in link to the page, and the frame tries again when this tab gets focus back: the Platform keeps its sign-in in its own origin's storage, which the same-site frame shares.
5. **"Download your data" lives only in its "Your data" section**, the export page's own component (`ExportPanel inOffice`), where `export.enabled`. The account menu no longer has it. `/export` stays as a page for the Platform account page's link and for a closed account. A download keeps running with the modal closed: the section stays mounted out of sight while it runs, saves, or waits for Save, and opening Account settings again goes back to it.
6. **No "(opens in a new tab)" in the office.** "Report a safety concern" still opens its page in a new tab, said only to screen readers (`aria-description`).

## Consequences
- A member reaches every account setting without leaving the office or losing a window.
- Two origins now trust each other a little: the office may frame `platform./account`. Clickjacking of that page is possible only from the office's own origins. The message carries no data, and both sides check origin and window.
- The framed page still has the Platform's look, not the office's. Theme and type follow the Platform app.
- A member signed in to the office but not to the Platform in this browser signs in once on the Platform's page in a tab of its own, since sign-in can't be framed.
- Until Platform ships, prod's Account section is the "Open account settings" link, and "Your data" works fully.
- Tests: `settings/*.test.ts`; `settings.shell.spec.ts` covers ready, refused, silent, signed out, a stray message, Your data and a phone. The harness's `accountFrame` stands in for Platform's `frame-src`.
