# bell-kit: the one notification panel (ADR 0125)

The Product Designer's spec (`~/ma-coord/design-drafts/notifications-brand-review.md`, Nov 10): the bell on Community Forums, the account site and the office shows the same panel. The words and the row model come from `model.mjs` here, shared by relative import in `ma-platform` (`web/forums`, `web/platform`) and vendored as a copy in `ma-desk` `packages/bell-kit` (as `avatar-kit` is). Each app renders the layout below with its own tokens; the numbers don't move.

## The panel
- `role="dialog"`, labelled "Notifications"; `min(360px, 100vw - 32px)` wide, panel radius 16 px, padding 8 px, the app's overlay surface, 1 px border, menu elevation.
- **Header**, only when something is unread: "Notifications" (14 px, 600, text primary) left; "Mark all read" as a text link right.
- **Rows**, newest change first, each a link to `item.link` (read first, then go). Row radius 10 px, padding 10 px 8 px, hover sunken surface.
  - **Left:** a 28 px round chip, sunken surface, holding the 16 px kind icon (`family`: `thread`, `card`, `desk`, `account`, `note`; stroke icons, no stars).
  - **Title:** who first, 14 px, 500, wraps to two lines.
  - **Second line:** the thing, 13 px, text secondary, one line, truncated.
  - **Right column:** the time (12 px, text tertiary) on top, an 8 px accent dot under it when unread. Never red.
- **Empty:** "Nothing new." (13 px, text secondary), no header, footer still there.
- **Footer:** "All notifications" alone, left-aligned, a text link to the account site's `/notifications`.
- **Touch** (`pointer: coarse`): header link and footer link 44 px tall.
- The `system.quiet` type is not shown (the footer link already says there's more).

## The words (`rowOf`)
| Type | Title | Second line |
|---|---|---|
| `forums.reply` | "{actor} replied to your thread"; group: "{actor} and N others replied to your thread" | the thread title (`item.body`) |
| `forums.thread` | "{actor} replied in {thread}"; group: "{actor} and N others replied in {thread}" | "Community Forums" |
| `forums.mention` | "{actor} mentioned you" | the thread title |
| `forums.notice` | "A notice from Community Forums" | the rule (`item.body`) |
| anything else | `item.title` | `item.body` |

`N` is `item.count - 1`. With no actor the server's title stands. The time is `timeLabel(updatedAt, now)`: "now" under a minute, "5 min", "1 h", "2 d", then "Nov 1" (the month's short name and the day; the year is added when it isn't this year). Never "ago", "hr" or "5m".

## The count
On the bell button: nothing at 0, the number to 9, then "9+", in the accent tint on text-on-accent. `aria-label` "Notifications" at 0, else "Notifications, N unread".
