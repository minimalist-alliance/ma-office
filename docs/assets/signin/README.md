# Sign-in page: brand review and spec

From the Product Designer, for the Platform Engineer. Nothing here is live. **The owner approves before anything reaches prod;** staging is fine for testing.

**Decision (the owner, 2026-11-05):** "we should have our own pages". It replaces "not building our own sign-in UI now" in Platform's ADR 0076. Platform has taken that ADR's costs to the coordinator for the owner's decision, and the build waits on that. Mocks are safe now.

**The owner's earlier words**
- "Sign in is fine but the form felt off brand. Didn't seem sleek and premium"
- On the live page: "The input boxes and sign in button are not premium nor on brand at all..."

**The mock and its renders** (`mock.html`, the sheets and previews) are kept out of the public repository: they are a branded sign-in form, which shouldn't be at a public URL. The written spec below is the source of truth.

## What feels off
1. **The inputs and buttons.** They are 32 px tall with 14 px Open Sans; the site's are 46 px with Inter. Bold text in a short pill reads as an admin console. The owner named these directly. Cognito locks their size and font.
2. **The old logo.** The page still shows the Nunito lockup; the site's header has used Jost capitals since ADR 0061.
3. **Everything is bold.** "Sign in", two section headings, labels and both buttons compete, and the headings "With other accounts" and "With existing account" read as a default template.
4. **A gray card on an empty white page,** with a heavy 2 px outline around the Google button and italic placeholders.

## Our own pages: the design
The values are the apps' tokens from ADR 0065, plus the additions listed below. The landing page moves to the same tokens (ADR 0065).

| Part | Value |
|---|---|
| Font | Nunito, self-hosted (ADR 0065): weight 500 for 15-16 px running text, 600 for labels and small text, 700 for the heading and buttons. Details in `docs/assets/brand/ui/type.txt`. The mock loads it from Google Fonts for convenience |
| Card | 420 px wide, 40 px padding, radius 22, 1 px border. Fills the screen at 483 px wide or less, with 24 px side padding |
| Ground | `signin-ground-inline.svg`, pasted over the page's inline SVG: the new mark's two ribbons as flat silhouettes, the right over the left, cropped by the page. Colors come from the page's tokens through classes, with no masks or `style=`, so `.arm-l` and `.arm-r` set `fill`, not `stroke`. Hidden on phones |
| Logo | `signin-logo-*.svg`, 200 px wide, centered. Dusk uses `dark` (ADR 0061) |
| Heading | 26 px, weight 700, tracking -0.008 em |
| Line under it | 15 px, weight 500, `--ma-text-2` |
| Labels | 13 px, weight 600, `--ma-text-2`. No placeholders |
| Fields | 46 px tall, radius 12, 1 px border, 16 px text so iOS doesn't zoom on focus |
| Buttons | 46 px tall, pill, 15 px, weight 700, no tracking |
| Theme | Light, Dusk and Dark. The pages sit at a path on each app's host, such as `/_signin/`, so they read that app's saved `ma-theme`. With nothing saved, they follow the OS. Carrying the choice across hosts is optional, UI/UX's call |

**Colors beyond the app tokens** (all in `docs/assets/brand/ui/tokens.json`, `signin_only`)

| Use | Light | Dusk | Dark |
|---|---|---|---|
| Field and secondary button border | `888c94` | `a5abb6` | `7a808a` |
| Card line | `e4e4df` | `666d79` | `3f434c` |
| Google button fill | `ffffff` | `131314` | `131314` |
| Google button border | `747775` | `8e918f` | `8e918f` |
| Google button text | `1f1f1f` | `e3e3e3` | `e3e3e3` |
| Error text and border | `d0201f` | `ffc9c2` | `f2747a` |
| Error fill | `fcf2f2` | `5c4b52` | `40343a` |

**Contrast:** text and borders meet 4.5:1 and 3:1 in all three themes, except Google's border on Dusk's card at 2.39:1. Its dark fill and label identify the button; judge it on staging. See `docs/assets/brand/ui/contrast.txt`.

## The screens

| Screen | `#name` | Behavior |
|---|---|---|
| Sign in | `sign-in` | Real form, `autocomplete="username"` and `current-password`. Google above the form. No autofocus, so no ring on load. "Show" toggles the password |
| Enter a code | `code` | One field, `inputmode="numeric"`, `autocomplete="one-time-code"`. Strips anything but digits, so `123 456` pastes. Submits on the sixth digit; Continue stays as the fallback. Takes focus. "Start over" and "Can't sign in?" |
| Set up an authenticator | `setup` | QR on white in every theme. The key always shows under the QR, with Copy, then this line: "Keep a backup: save this key somewhere safe, or use an app that syncs across your devices. You can't reset this yourself, and getting help takes time." App entry named Minimalist Alliance. Then a code, as above |
| Can't sign in | `cant-sign-in` | Recovery is by a person (`admin_only`), so it promises no reset. Address is selectable, with Copy and a mail link. Not "Forgot password" |
| Confirm it's you | `confirm` | Email read-only but still `autocomplete="username"`, so password managers match it. Then the code step |
| Confirm it's you, Google account | `confirm-google` | Same heading and fixed email, "Continue with Google", no password or code. The contract re-runs sign-in with `prompt=login`. Says only to continue, because Google may ask nothing if they're already signed in |

| Error | `#name` | Wording |
|---|---|---|
| Wrong email or password | `error-password` | "That email or password isn't right. Check them and try again." Same for both, no field marked, focus on Password |
| Too many passwords | `error-attempts` | "Too many attempts. Try again later." No time stated, per the note in contract `auth.md` |
| Too many codes | `error-code-attempts` | "Too many attempts. Try again later." No number: the limit and its message are unknown until the build tests them |
| Google failed | `error-google`, `error-confirm-google` | "Google sign-in didn't finish. Try again." |
| Our side | `error-server` | "Something went wrong on our side. Try again in a moment." |
| Wrong code | `error-code`, `error-setup-code` | "That code didn't work. Enter the one your app shows now." Under the field, field marked |
| Timed out | `error-timeout` | "That took too long", with one button: "Sign in again". No time stated, so it stays true if the 15-minute setting changes |
| Wrong password on confirm | `error-confirm` | "That password isn't right. Try again." Field marked, since the email is fixed |

**The "New here?" line** follows the same setting as the landing page's buttons (UI/UX), so its words change with where it goes:

| The landing page's buttons | Line | Goes to |
|---|---|---|
| Open the join page | "New here? Join Minimalist Alliance" | `platform./join` (shown in the mock) |
| Open an email | "New here? Email us to join" | The same address, subject and body as those buttons |
| Show the waitlist | "New here? Join the waitlist" | The landing page's waitlist form |

Wording is mine and not yet seen by the owner. The QR code and key are placeholders; the QR encodes nothing. Sample address: `member@example.com`.

**Checked:** all 16 screens, three themes, two sizes (96 frames) in headless Chromium, with no sideways overflow, clipped content or console errors. Scripted: paste, sixth-digit submit, show password, copy key.

**Not checked:** real password managers, real one-time-code autofill, Safari and iOS, and screen readers. UI/UX checks these when building.

## Open
- **Wrong-code limit:** how many wrong codes trigger it, and what comes back, gets tested in the build. The wording stays generic until then.
- **Google's button:** fills follow Google's guidelines: `FFFFFF`, and `131314` on Dusk and Dark. Google's own G. Label in Nunito at 15 px, and our 46 px full-width pill, both our choice over Google's Google Sans and 40 px image. Change them if Google's OAuth review objects. Judge Dusk on staging, and use `F2F2F2` if it looks too heavy.
- **Idea:** on a phone, an "Add to authenticator app" link (`otpauth://`) would beat copying a key.
- **Logo:** `signin-logo-*.svg` are re-exported with the mark the owner approved (ADR 0066). `docs/assets/brand/export.py` makes them. The older sheets and previews still show the old mark.

## Stopgap: Cognito changes until our pages ship, in rank order
Platform recommends skipping this, since no paying members see the page yet. It is the coordinator's and the owner's call, so no more work has gone into it.

Values are `RRGGBBAA`, as in `terraform/auth_branding.tf`. Anything not listed stays as it is. Keep center/center, `DYNAMIC` and `REGULAR`.

**1. Logo.** `FORM_LOGO`, in the card as today:
- `signin-logo-light.svg` and `signin-logo-dark.svg`: the approved stacked full logo with its `<title>` removed, since I can't check AWS's SVG list.
- 3.2:1, so it shows at 192 x 60 px, above the 185 px minimum (ADR 0061). Measured in the preview by swapping the file.
- These now carry the new mark (ADR 0066), which uses masks and gradients. Cognito accepted the matching lockup files with them.

**2. Page background and card.** `PAGE_BACKGROUND`, one each for light and dark:
- `signin-bg-light.jpg` and `signin-bg-dark.jpg`, 2560 x 1600, about 150 KB, or the matching `.svg` (under 1 KB) if AWS's list accepts `linearGradient`.
- The new mark's two ribbons as flat silhouettes, the right over the left. Quiet behind the card. These files are only for this setting; our own pages inline `signin-ground-inline.svg`.
- Measured: `body` already has `background-size: cover` and `background-position: center`. At 483 px wide or less, the card's color fills the screen and the image doesn't show, so phones rely on token changes alone.

| Token | Light | Dark |
|---|---|---|
| `page` (shows while the image loads) | `e9ebefff` | `1a1d21ff` |
| `card` | `ffffffff` | unchanged |
| `card_border` | `e6e8ecff` | unchanged |
| `error_bg` (recomputed for the white card) | `fcf2f2ff` | unchanged |
| `success_bg` | `f0f8f4ff` | unchanged |
| `warning_bg` | `f9f4ecff` | unchanged |

`dropDown.hover.itemBackgroundColor` uses `card` today; point it at the Google button's fill below, or a hovered item won't show on the white card.

**3. Google and other outlined buttons.** Border color equals the fill, so Cognito's 2 px outline disappears.

| State (`idpButton`, `secondaryButton`: background and border) | Light | Dark |
|---|---|---|
| Default | `eef0f3ff` | `31353cff` |
| Hover | `e4e7ecff` | `3a3e45ff` |
| Active | `dce0e8ff` | `434850ff` |

**4. Fields and labels.**

| Setting | Light | Dark |
|---|---|---|
| `field` | `f5f6f8ff` | `1e2126ff` |
| `field_border` | `8a8f97ff` | `7a808aff` |
| `divider` | `e4e6eaff` | unchanged |
| `inputLabel.textColor` | `5f6166ff` (`text_2`) | `b7bbc2ff` (`text_2`) |

Radii: `input` 8 and `alert` 8, from 12 (12 on a 46 px field is proportionally 8 on 32 px), `dropDown` 8. Buttons stay 24, card stays 22.

**Contrast, computed:** text is 5.08:1 or better and field borders 3.01:1 or better, in both modes. Placeholders keep `text_3`, because a lighter one would fail AA.

**If only some can ship:** 1 and 2 stop the page looking like a default. 3 and 4 tidy the controls but can't fix them.

**Not checked:** the error, forgot-password and authenticator screens with these values. I didn't submit anything on the form, so please look at them on staging.
