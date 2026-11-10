# Real sites from a desk (TD-212)

The 20 sites a general member would try first, from the test desk's real Browser, through the shipped app at `test.office.staging.minimalistalliance.com` as `desk-1`. Each is recorded as **pass**, **challenge** (a CAPTCHA or bot check) or **block**, with the stream's GB per hour over a visit of typical use, for TD-46.

It sits outside the gate's `testDir`, so `npx playwright test` never sees it, and the spec skips unless `REAL_SITES=1`. The browser here runs headless with `DISPLAY` removed, so nothing reaches `:10`.

**Results:** `results/`. The latest is in "Results" below.

## Run

```bash
export PATH=$HOME/.local/node-v24/bin:$PATH
cd e2e && npm ci && npx playwright install chromium   # once

# The test desk is shared: hold its lock, in chunks under 45 minutes.
flock ~/work/.test-desk.lock env REAL_SITES=1 REAL_SITES_ONLY=1-10 REAL_SITES_LABEL=<date>-a nice -n 10 npx playwright test -c real-sites --output test-results-real-sites
flock ~/work/.test-desk.lock env REAL_SITES=1 REAL_SITES_ONLY=11-21 REAL_SITES_LABEL=<date>-b nice -n 10 npx playwright test -c real-sites --output test-results-real-sites

# One table from both chunks:
node real-sites/render.ts real-sites/results/<date>-a.json real-sites/results/<date>-b.json > real-sites/results/<date>.md
```

About 12 minutes for 10 sites, 3 for two. `REAL_SITES_ONLY` takes ids and ranges (`5,7` or `1-10`); with none it runs all 20, about 25 minutes. Site 21 isn't one of the 20: it's a video that plays, for the video GB/h, since YouTube walls a desk, and it runs only when named. `REAL_SITES_LABEL` names the results; the default is the start time. `REAL_SITES_ALLOW_BUSY=1` runs even if someone else is streaming from the desk, which adds their stream to every desk counter. Needs AWS credentials that read `/ma/staging/test-users/desk-1` and send SSM commands to the test desk, as the gate does.

## What a visit is

Sites and their kind of use are in `sites.ts`. For each one, in a tab of its own, through the window's address bar:

1. Type the address; wait 15 s (load).
2. Read the page on screen over CDP (`classify.ts` `PROBE`): title, address, main document status, text, frames, videos.
3. Typical use, by kind:
   - **read:** 10 s still, then a 360 px wheel step every 5 s for 40 s.
   - **video:** click the player if it's paused, then 60 s of watching.
   - **maps:** 10 s still, then a wheel zoom-in every 5 s for 30 s.
   - **login:** 20 s still. A sign-in page is looked at, never filled in.
4. Read the page again, and grab the decoded picture at half size.

The verdict is `classify.ts`'s, from both reads: a known phrase or address (Cloudflare, reCAPTCHA, PerimeterX, Amazon, Imperva, YouTube's "not a bot") makes a challenge; "Access Denied", "blocked" or a bare 403 or 429 makes a block; a check that cleared by itself before the second read is a pass, noted. A video counts as a pass only if it played 20 s or more. Anything else is `unclear`. **Confirm each call by eye** from the frames in `out/<label>/`: write what each frame shows in `results/<label>.checked.json` (`{ "<id>": { "note": "...", "verdict"?: "pass" } }`, a verdict there overriding the script's), then `node real-sites/reclassify.ts <label>`. That also calls the verdicts again with today's `classify.ts`, from the whole reads in `out/`.

## What it measures

- **Stream GB/h**: what the member's browser received from the desk, from `getStats` on the app's own peer connections (transport bytes: video, audio, data channels). This is what the allowance meters. "still" and "use" split each visit.
- **Desk tx GB/h**: the desk's own NIC counter (`/sys/class/net/<dev>/statistics`) over the same visit. Headers and anything else the desk sent are in it, so it reads a little over the stream.
- **Download GB/h**: the desk's NIC rx, which is what the sites sent the desk.

The stream is the desk's: `c7g.large` at 1920x1080 with the default profile (`desk-stream`'s `stream.conf`), whatever the client's window. ADR 0033's 0.59 and 0.41 GB/h are at 1280x800, so read these against them with that in mind.

## What it does to the desk

- Over SSM: reads versions, units, tabs and NIC counters. Writes only `/var/tmp/ma-e2e-real-sites/probe.py`, removed at the end.
- Over Chromium's debugging port, as root: reads the tab on screen, and counts the profile's cookies for each site's domain (counts and known clearance-cookie names only, never a value), before and after. Once a run, on the first https page, asks whether Chromium can play protected video (Widevine, ClearKey).
- In the app: opens the Browser window and a tab of its own, visits the sites in it, closes both. Checks the stream is off, the tab count is back where it was, and `desk-1`'s other desk is still in the state it was.
- **It leaves the visits in the desk's profile:** history, and whatever cookies the sites set. It never clears them (ADR 0035), and it never writes to `/data/browser/profile` itself. So a rerun is a return visit, not a first one: the cookie counts before each run say how fresh it was.
- It signs in to no site, types nothing but the addresses, and clicks only a video's own player.

## What it keeps

`results/<label>.json` and `.md`, in git: verdicts, a short redacted start of each page's text, frame hosts, video state, bytes and GB/h. `out/<label>/` (ignored by git) holds the frames and the whole reads: some check pages print the visitor's address, so they stay out of git. Every text kept in `results/` has IP addresses replaced with `[ip]`.

## Results, 2026-11-06

The whole table, with every note: `results/2026-11-06.md` (runs `-a` and `-b`). Return visits: `results/2026-11-06-c-return.md`. Every verdict was checked by eye against its frame; two of the script's `unclear` calls became passes (Chase, PayPal), and one false challenge (Netflix's reCAPTCHA notice) was fixed in `classify.ts`.

Test desk `c7g.large`, image 0.2.2, screen 1920x1080, `desk-stream` 0.2.1 at the default profile (quantizer 23, 8 Mbps cap), Chromium 156. Each site's cookie count was 0 before its visit, so these are a new member's first visits.

**16 pass, 2 challenge, 2 block** of 20.

| # | Site | Result | Stream GB/h | What a member sees |
|---|---|---|---|---|
| 1 | Gmail | pass | 0.08 | Google's sign-in page |
| 2 | Outlook.com | pass | 0.40 | Microsoft's Outlook page |
| 3 | Google Search | pass | 0.36 | Real results, no reCAPTCHA, placed in the Washington DC area |
| 4 | Bing | pass | 0.26 | Real results, Washington DC |
| 5 | YouTube | **challenge** | 0.45 | "Sign in to confirm you're not a bot" in the player; the video doesn't play. Same on a return visit |
| 6 | Netflix | pass | 0.41 | The landing page. Playing needs Widevine, which the desk doesn't have |
| 7 | AP News | **challenge** | 0.09 | Cloudflare's "Verify you are human", still up after 70 s. Same on a return visit |
| 8 | CNN | pass | 0.35 | The home page under a terms modal; its video tile says "DRM System Not Supported" |
| 9 | The New York Times | pass | 0.94 | The home page |
| 10 | Amazon | pass | 0.73 | The home page, no robot check |
| 11 | eBay | **block** | 0.12 | 403: "Something went wrong on our end. Please go back and try again" |
| 12 | Walmart | pass | 0.64 | The home page, no "press and hold" |
| 13 | Chase sign-in | pass | 0.65 | The sign-in form |
| 14 | Bank of America sign-in | pass | 0.15 | The sign-in form |
| 15 | PayPal sign-in | pass | 0.06 | The sign-in form |
| 16 | Google Maps | pass | 1.06 | The map, centred on northern Virginia |
| 17 | Google Docs | pass | 0.08 | Google's sign-in page |
| 18 | Wikipedia | pass | 0.70 | The Main Page |
| 19 | Facebook | pass | 0.37 | The log-in page |
| 20 | Reddit | **block** | 0.09 | 403: "You've been blocked by network security. To continue, log in" |
| extra | Wikimedia Commons video | pass | 2.56 visit, **3.19 playing** | Big Buck Bunny in Commons' player, 1920x1080 source in a 898x561 player |

**AP News and YouTube still challenge** a desk, on a first visit and on a return visit about an hour later, the second with YouTube's cookies from the first. **Reddit and eBay now refuse it outright.** Google Search, Amazon, Walmart, the New York Times and all three banks' sign-in pages load.

**GB/h for TD-46,** stream bytes the member's browser received, at 1920x1080 on the default profile:
- **Browsing, the 16 sites that passed: 0.45 GB/h over a visit** (range 0.06 to 1.06). 0.49 on a page left still, 0.57 while scrolling or zooming. The desk's NIC sent 0.52 GB/h over the same visits, headers included.
- What moves on a page costs, not what's on it: sign-in pages cost 0.06 to 0.15, Maps 1.06, and the New York Times and Amazon 0.7 to 0.9 from ads and carousels that move while the page sits still.
- **Video while playing: 3.19 GB/h** stream, in a 898x561 player (2.56 over the whole visit, 2.67 on the desk's NIC). A larger player reaches the 8 Mbps cap, 3.6 GB/h.
- The sites themselves sent the desk 0.58 GB/h while browsing (NIC rx), and 2.8 over the video's visit.

### Recommendations

For TD-46's data cap, my reading. Platform and the System Engineer decide.
- **The 0.59 GB/h browsing figure holds as a planning number.** Real sites came in under it, at 0.45 stream and 0.52 on the NIC, even at 1080p rather than ADR 0033's 1280x800. Plan on the NIC figure, since that's what the cloud bills: about 15% over the stream's own bytes.
- **Video sets the allowance, not browsing.** At 100 GB that's about 190 h of browsing (0.52 GB/h), or about 28 h of video at the cap (3.6 GB/h). A mixed hour, 80% browsing and 20% video, is about 1.1 GB/h, or about 90 h a month, about 3 h a day.
- **These numbers are short visits (40 to 80 s) and a light scroll** (360 px every 5 s). A long read sits nearer the still-page figure, and fast scrolling higher. They aren't the capped profile, a 1280x800 desk or a full-screen video. Rerun this check when W3 settles the member size.

For members, worth telling them up front:
- **Some sites check or refuse a cloud desk's address.** YouTube asks you to sign in before it plays a video; AP News asks you to tick "Verify you are human"; Reddit asks you to log in; eBay refuses. Your browser session carries over, so signing in once on your desk should stick (not tested: signing in to a third-party site was out of scope).
- **Protected streaming won't play in a desk's Browser.** The desk's Chromium has no Widevine (`NotSupportedError`; ClearKey works), so Netflix, Prime Video, Disney+, Hulu, Spotify and CNN's videos can't play there.
- **Sites think you're in northern Virginia,** where the desk runs: search results, weather, maps and store pickers start there until you set your own location.
