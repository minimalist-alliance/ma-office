# deskd's simplified view on real pages

Task 47. Scores what deskd itself makes of the 42 public pages of the prototype's run (`sites.json`, copied unchanged from that run's kit on `sub/minified-real-sites`, `24ab060`), with the Product Designer's acceptance check. Nothing here is a test or runs in a build: both harnesses are named to match neither surefire's nor failsafe's patterns, so they run only when asked for by name, and only with their environment set. They're outside `e2e/`'s gating `testDir`.

**The captures are not in git.** The MDocs copy third-party pages, so they go to a folder you name, outside the repo.

## The two harnesses

**`MinifiedRealSites`** (`src/test/java/.../browser/`): deskd end to end, as a desk runs it. A real headless Chromium on the public web, deskd's Browser module and its simplified view on it with the switch on (`media-actions` and `consent-reject` off), and a client asking through the same RPCs the Desk app uses. Per page, one tab, one page at a time:
1. `browser.tab.navigate`, then wait until the tab stops loading (up to 45 s), then 2 s.
2. Scroll the real page through 8 screens and back, as the prototype's run did, so lazy content is there. This is the harness's own debugging socket, not deskd.
3. `browser.minified.get` until the view is `simplified` or `stream` (up to 25 s); a `simplified` view of a document still loading (a page that went on to another address) is asked again until it's loaded, as a client gets the loaded one from the topic (round 4). Its result, as a client gets it, is `PNN.mdoc.json`.
4. `browser.minified.island` for the main island, if there is one. That reply, the timings and the tab's URL go to `PNN.run.json`.
5. 4 s before the next page.

Signed out, no account. Nothing is clicked and no consent banner is answered. deskd's site memory starts empty for each run, so a site's second fallback in a run is remembered for the rest of it, as on a desk.

**`MinifiedV2Replay`** (`src/test/java/.../browser/minified/`): distiller v2's saved output from the prototype's run, through deskd's own `MDocBuilder`, with a stand-in for deskd's in-page half that saw every control and media element and no sensitive field. It isolates the builder: what deskd keeps and drops of v2's blocks. It writes bare MDocs and copies v2's own sidecars (`PNN.detail.json`: the fallback, island and heights a bare MDoc doesn't carry).

## Run

From `services/`, with Playwright's Chromium (build 1248 was used):

```bash
JAVA_HOME=$HOME/.local/share/ma-desk-toolchain/jdk-21 DESKD_CHROMIUM_BIN=<chrome> MINIFIED_RUN_OUT=<folder outside git> nice -n 10 ./mvnw -q -f deskd/pom.xml test -Dtest=MinifiedRealSites -Dsurefire.failIfNoSpecifiedTests=false
```

`MINIFIED_RUN_ONLY=P03,P05` runs some pages; `MINIFIED_RUN_SITES` takes another page list (`sites-2026-11-11.json`: 16 of the day's common sites, T01 to T16, which have no targets in the check). The whole list takes about 15 minutes. `MINIFIED_RUN_SHOTS=1` also saves, for a rater, the images the view names as `browser.minified.image` gives them (`PNN.img/`, with why each missing one is missing in `PNN.run.json`) and the real page's first three 1800 px screens at half size (`PNN.orig-N.jpg`), any place the page names blanked first by `LocationBlank`'s rule. `MINIFIED_RUN_NO_SCROLL=1` skips the harness's own scroll-through, as a member's tab is: nothing but deskd's own pre-scroll scrolls it. Since round 3 the harness waits for deskd's pre-scroll to end after the first `simplified` view and asks `get` again, as a member's client does when the topic says the view changed; `PNN.run.json` has what the pre-scroll did (`prescroll`) and the first view's size (`firstView`). `MINIFIED_RUN_NO_PRESCROLL=1` turns deskd's pre-scroll off, as its `prescroll-off` switch does. Rounds and the rater's method: `docs/sub-status/simple-view-quality.md`.

```bash
JAVA_HOME=$HOME/.local/share/ma-desk-toolchain/jdk-21 MINIFIED_V2_IN=<v2 run's captures> MINIFIED_RUN_OUT=<folder outside git> ./mvnw -q -f deskd/pom.xml test -Dtest=MinifiedV2Replay -Dsurefire.failIfNoSpecifiedTests=false
```

Then the check, which reads deskd's format as it is (no adapter):

```bash
python3 -I check.py targets.json <folder>
```

`check.py` and `targets.json` are the Product Designer's, in the coordination repo's `design-drafts/simplified/targets/`.

## Distiller v9, 2026-11-08 (`0277becd`; the Designer's check as of `ma-coord` `b7070a3`)

Only the three pages v9 fixes on deskd's side, rescored end to end on the second build box with a desk's user agent (`deskd-live-12`): **P10, P30 and P38 all pass great.** P10: the all-ad module drops whole without the filter lists, and content comes first (1 block before it; 5 with v8). P30: the "Why this ad?" box marks its ad (it passed with v8 too). P38: posts get their video's poster as a card thumbnail, 5 cards with a title and a thumbnail (2 with v8, 3 needed). The other 27 weren't rerun.

## Scores with distiller v8, 2026-11-08 (`907c67c5`, the commit v8's own run scored; the Designer's check as of `ma-coord` `b7070a3`)

deskd end to end on the second build box, a desk's user agent (`deskd-live-9`): **16 of 30** core pass, 14 great (v7: 14 and 12). v8's own run, scored here with the same check: 22 of 30, 20 great. Where they differ:
- **P32 (AP), deskd's, fixed in `34cfddb7`:** AP's donation banner, which says "This is not a paywall" and can be collapsed, covered the page, and deskd's wall check read the word "paywall" and ended the view after 7 blocks. A box the member can close or collapse is now a nag, as the distiller and section 14 have it, and the word no longer makes a wall. P32 alone after the fix: great. The full run after it (`deskd-live-11`, 14 of 30) lost P32 to the harness's own timeout on AP's heavy page, and P06 and P08 to the page's load (ads not yet in their slots, a recipe clip not yet playing), so it isn't a fair count of the fix.
- **P03 (Amazon) and P11:** refused the build box (`http_error`, a person check). **P12 (eBay):** serves its page where the targets expect the 403 they saw.
- **P21 (Bing), P38:** the pages served this browser cards without the thumbnails v8's run got. **P17 (Vimeo):** the player lays out smaller in the harness's headless Chromium and isn't read as a player; to check on a desk's screen. **P29:** the blocklist's hints. **P10:** content order, one check.
- deskd is ahead on P22.

## Scores, 2026-11-08 late (`f8e801c6`, distiller v7; the Designer's check as of `ma-coord` `b7070a3`)

deskd end to end on the second build box, with the harness now presenting a desk's own user agent (a real desk's kiosk Chromium never says "HeadlessChrome"): **14 of 30** core pass, 12 great (11 and 9 before). The prototype's runs of the same distiller: 18 of 30.
- **P06 (The Verge) fixed in deskd:** the page has a hidden copy of its own title beside the shown one, and deskd's "never more than the real page shows" rule took the shown one out too. Text the page also shows is no longer counted as hidden (`MinifiedChromiumIT.aTitleTheSiteAlsoHidesIsStillShown`).
- **Most "bot walls" were the harness's headless user agent, not the network:** with a desk's user agent, P08, P17, P30, P32 and P38 serve their pages, from this machine and from the build box alike. P03 (Amazon, `http_error`) and P11 (`challenge`) still refuse the build box. P12 (eBay) now serves its page where the targets expect the 403 they saw.
- **P28 (TED) passes:** its player was there this time; on the build server's network TED served a generic page.
- **Still failing, traced:** P21 (Bing) and P32 (AP) serve this browser results without the thumbnails the prototype's runs got: the same page through deskd's own distiller in a Playwright browser has none either, so it's the page, not deskd. P17 (Vimeo): deskd's own adapted distiller finds the player as an island in a Playwright browser at 1366 by 900, but in the harness's raw headless Chromium the player lays out smaller (420 px high, not 595) and its controls come out as text; to be checked on a desk's real screen. P30, P10, P38: one check each (an ad label, content order, card thumbnails). P29 still needs the blocklist's hints.

## Scores for the merge, 2026-11-08 (distiller v7, `c29486e7`; the Designer's check as of `ma-coord` `4bc5165`)

deskd end to end, run on the build server (its own network, outputs blanked of any location by `LocationBlank`): **11 of 30** core pass, 9 great, the same page by page as with v6 (`69538671`). **Every page that should fall back does, for its reason,** P02 (BBC) now included: its terms modal, drawn by its consent platform's frame, opens the real page as `terms_wall`. The prototype's own runs of the same distiller (`real-sites-v6`, `-v7`) score 18 of 30 on the same check. The difference, page by page:
- **Bot walls and errors, not deskd:** P03, P17, P30 and P32 answered the build server, and P08, P11 and P38 too, with a 403, a 429 or a person check. deskd falls back as it should for what it's shown.
- **The blocklist deskd doesn't have yet:** P29 (GOV.UK's in-flow cookie banner) and P10 (Google's shopping ads) are hidden in the prototype by its kit's filter lists; deskd ships a small built-in rule set until the System Engineer's blocklist gives it the same hints.
- **Still to trace:** P28 (TED: no main player island), P21 (Google Images: no image of 80 px or more in the check's reading of MDoc v1), P06 (The Verge: its title).
- P25 (CNN) falls back as `low_confidence`, where the check expects `terms_wall`: a fallback all the same.

## Scores after the re-sync, 2026-11-08 (the Designer's check as of `ma-coord` `7181aa8`, 30 pages that should simplify)

deskd end to end with the distiller at `sub/distiller-v2` `e1a139e4` (Security's `T47X-1` to `-3` fixed in it) and the correctness review's fixes: **11 of 30** core pass, 9 great. The previous pin's run (`79b3aca6`, `803dda38`), scored again with the same check: also 11 of 30, 9 great. Outputs are written through `LocationBlank` (no location in them).

Per page, `79b3aca6` → `e1a139e4`:
- **Now pass:** P01 and P22 (great).
- **Now fail:** P28 (TED): the title is now the talk's, but the main player is no longer an island (40 blocks to 18), so `video_island` and `content_first` fail; P29 (GOV.UK): its cookie banner sits in the page's flow, not fixed, and is no longer hidden as one (`hidden` counts it as `other`), so its text shows and `no_text` fails. Both are the distiller's side, P29 most likely its `T47X-1` fix, which deskd's own consent press needs (a fixed box only).
- **Every expected fallback falls back**, as before. P02 (BBC) simplifies where the check now expects a terms wall, in both runs. Wrong fallbacks left: P08, P11, P17, P30, P38, bot walls this machine is shown (unchanged); P25 falls back as `low_confidence`, where `terms_wall` is expected.
- The distiller's ten `tests/security/` pages pass through deskd's own path (`MinifiedChromiumIT.theDistillersSecurityPagesHoldThroughDeskd`).

## Scores after the port, 2026-11-07, evening (the Designer's recalibrated check, 32 pages)

deskd end to end, its pinned distiller (`sub/distiller-v2` `79b3aca6`) and its retuned fallbacks (`803dda38`): **12 of 32** core pass, 10 great. The same check gives the prototype's v3 9 of 32, deskd before the port 0 of 32, and deskd with the first port (`e050ad72`, `8945a795`) 11 of 32.

Per page, before the port → first port → `803dda38`:
- **Now pass:** P02 (BBC: no longer an ad frame's fallback), P04, P07, P09, P16 (IKEA: the form rule counts fields, not filter boxes), P18, P20, P26, P28, P29, P15 and P24 (core), P14 (TodoMVC falls back as an app).
- **Every expected fallback falls back:** P12, P13 and P36 as `http_error`, P19 `challenge (sign_in)`, P39 `challenge (payment)`, P40 and P42 `challenge (person_check)`, P37 and P41 `canvas_app`, P14 `app`.
- **Better, still failing one or two core checks:** P03 (Amazon: no longer a fallback), P05, P21, P22, P23, P31 (Allbirds: no longer a fallback), P33, P34.
- **Wrong fallbacks left:** P08, P11, P17, P30 and P38 answered this machine with a 403, a 429 or a bot check after a day of runs (`http_error` or `challenge (person_check)`, which is right for what deskd was shown); P25 (CNN) is `low_confidence`, its text not reaching the view, not yet traced.
- P01 and P06 lost a check to live-page drift and the wall rule (P06's view now ends at its subscription wall, by policy).

## Scores, 2026-11-07

The check's core pass, of the 33 pages that should simplify (the raters' "better than the original"):

| Run | Core pass | Great | Fallbacks wrong |
|---|---|---|---|
| The prototype, v1 distiller (the rated run) | 5 | 1 | 3 |
| The prototype, distiller v2 | 9 | 8 | 2 (P31, P33) |
| v2's output through deskd's builder, before the card fix (the Designer's harness) | 6 | 5 | 2 |
| **v2's output through deskd's builder** (`MinifiedV2Replay`, `84fd1017`) | **10** | 9 | 2 (P31, P33, from v2's sidecars) |
| **deskd end to end** (`MinifiedRealSites`: deskd's walker with its shipped distiller, v1, no blocklist) | **1** (P14) | 1 | 10 |

**v2 through deskd's builder** matches the prototype's v2 page for page but four: P05 passes, and P17 and P22 have one core failure fewer, because the check counts what deskd folds under a `group` as present; P34 has one more ("Unread", from a menu the prototype's shape hides from the check).

**deskd end to end** is the distiller it ships (the prototype's v1 `extract.js`), plus deskd's own fallback rules, which were a first guess waiting for this run:
- **Five wrong fallbacks.** P02 (BBC) and P31 (Allbirds) `cross_origin_frames`: deskd counts every other site's frame but players and payment frames, so an ad or consent frame over 40% of the screen trips it, where the prototype's rule left ads and consent out. P03 (Amazon), P08 (Allrecipes) and P25 (CNN) `low_confidence`: most likely the form rule (a page with 6 or more visible controls whose view keeps under half), since v1 drops filters and widgets. Which rule fired isn't recorded.
- **Five missed fallbacks.** P12 (eBay's 403): deskd falls back on 401 and 407 only. P19 (a sign-in page), P36 (a sign-in wall), P39 (checkout) and P40 (reCAPTCHA): v1 flags no `challenge`, and deskd shows a password field as a "Sign in on" line, not as a reason to fall back.
- **v1's content:** nothing hidden and counted (so `no_hosts` 0 of 8), no menus (`chrome_bar` 0 of 7), no cards, no comment depth.
- `max_length_ratio` is n/a: there's no renderer's height in deskd's output.

So the distance from 1 to 10 is distiller v2 in deskd (with the blocklist it reads) and deskd's fallback rules tuned on this run. Live pages drift between runs (search, front pages, the live blog).
