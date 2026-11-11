# Draft: the office draws what it last drew, at once (stale-while-revalidate)

**Status:** Draft, `sub/office-fast-start` (stream `fast-start`, Nov 10). For the UI/UX Engineer's review; the loader and
cache-header half is `ma-platform` `sub/office-fast-start` (contract 0.3.60), for the Platform Engineer's ship.

## Context
The owner, Nov 10: "I noticed that some items like the avatar on office take a while to load. Is this something we can
improve through caching or what?" The avatar is initials drawn here, so it waits only for `GET /v1/me`, which waits for a
token refresh, which waits for the bundle's own `GET /v1/client-config`, which follows the loader's page, its two
`/_loader/` files and the loader's own `GET /v1/client-config`. The usage circle waits for `GET /v1/desks/bandwidth` on
the same chain. Measured on staging with a test account (5 cold and 5 warm loads, medians; method and numbers below):

| From navigation start, ms | Cold | Warm (returning) |
|---|---|---|
| Avatar drawn | 1520 | 1299 |
| Desk list drawn | 1673 | 760 (the mirror) |
| Usage circle drawn | 1673 | 1349 |

Of a warm load's 1.3 s, about 500 ms is CloudFront going back to S3 for the `no-cache` page and loader files (a
`RefreshHit` costs about 250 ms where a `Hit` costs 20 to 40), about 120 ms the second client-config, about 300 ms the
token refresh (Cognito and the pre-token trigger) and about 120 ms `/v1/me`. Cold Lambdas add more: in prod over the last
7 days, `ma-prod-identity` started cold on 21 % of calls (init p50 422 ms) and `ma-prod-pretoken` on 54 % (init p50 298 ms).

## Decision
1. **Last-known values, drawn at once** (`web/src/platform/lastKnown.ts`). One record, `ma-desk-web-last-known`, holds
   what the chrome draws and nothing else: the member's id, display name, initials, seal (`membership.badge`), picture
   address and built avatar (when Platform sends them), client-config, and the meter. A returning visit (a token kept
   here) draws them before any request (`showLastKnown` in `session.ts`, `showLastMeter` in `bandwidth/store.ts`), and
   every fresh answer replaces them and is kept for next time. The desk list keeps its mirror, `ma.desks.v1`, as before.
2. **Per account.** The record carries the account's `sub` and the sign-in it was written under (`signedInAt`). It's drawn
   only while that sign-in is this browser's, so a new sign-in here, by anyone, draws none of it; the mirror follows the
   same check. The first token's `sub` decides: anyone else's and the record and mirror go, with what was drawn from them.
3. **Beside the token.** Both keys are kept where the refresh token is (`tokenStore.ts`' `EXTRAS`): this tab's
   sessionStorage when "Stay signed in" is `browser`, as on a borrowed computer, and localStorage otherwise. They move
   with the token and go with it: sign-out, a refused refresh (`invalid_grant`, `ma_session_ended`), a dead session
   (`session_revoked`, through `forgetMember`) and a refusal (`403`). With no token kept, nothing is written.
4. **Nothing that decides waits on it.** The kept member has no status, age band, roles, email or preferences. So the
   age rules' wait (`waitsForBand`) still waits for `/v1/me`, the no-desk cards still wait for Platform's own word, the
   tier's name and the owner's rows still come with `/v1/me`, and nothing kept is a token or anything new to this computer.
5. **The loader's client-config, taken once** (`fromLoader` in `clientConfig.ts`): where the loader hands its answer over
   as `window.__maClientConfig` (contract 0.3.60), the bundle's first ask uses it instead of asking again, so the token
   refresh starts as the bundle does. A loader without it changes nothing.
6. **Warm connections:** a returning visit preconnects to the kept `auth.domain` and API; the loader (0.3.60) does the
   same for `auth.` on every load.
7. **Every storage access is in try/catch.** Blocked or full storage means no head start, never an error.

## Measured after
The same 5 cold and 5 warm loads, against staging, with this branch's bundle served in place of staging's (Playwright
routes `/v/<version>/`, which turns off the HTTP cache for every load, so the warm loads here fetch the bundle again;
the control is `origin/main`'s bundle served the same way). Medians, ms from navigation start:

| | Avatar cold | Desks cold | Circle cold | Avatar warm | Desks warm | Circle warm |
|---|---|---|---|---|---|---|
| Staging as it is | 1520 | 1673 | 1673 | 1299 | 760 | 1349 |
| `origin/main`'s bundle, served by the test | 1523 | 1602 | 1701 | 1326 | 819 | 1450 |
| This branch | 1641 | 1641 | 1682 | **812** | **812** | **812** |
| This branch and the new loader (0.3.60, delayed 250 ms as staging's is) | 1431 | 1433 | 1528 | **814** | **814** | **814** |

A returning visit now draws all three with the shell's first paint; a first visit has nothing kept, so it's unchanged
by this half (cold differences here are noise, about 100 ms either way). The loader's handoff takes the second
client-config off the chain (the token refresh starts about 100 ms sooner, cold and warm). The CloudFront change can't
be measured before it ships; from the measured `Hit` and `RefreshHit` times it should take about 400 ms more off every
load, cold and warm.

## Not done here
- **CloudFront for the loader's page and files** (`ma-platform` `scripts/deploy.sh`, contract 0.3.60): `public, max-age=0,
  s-maxage=86400` and an invalidation per deploy, so CloudFront answers instead of S3. The Platform Engineer's ship.
- **Provisioned concurrency** for the identity, desks, member and pre-token Lambdas would remove the cold starts. It
  costs money every hour: a question for the owner, default no.

## Tests
`web/src/platform/lastKnown.test.ts` (per account, the sign-in check, cleared with the token and on a dead session,
sessionStorage under `browser`, storage that throws, the mirror, the meter, the loader's handoff);
`web/tests/e2e/fastStart.shell.spec.ts` (a returning load paints the avatar, its seal, the circle and the desks while
`/v1/me`, the meter and the list are held, then Platform's answers replace them; `browser` keeps it in this tab only and
sign-out takes it; someone else's sign-in draws none of it).
