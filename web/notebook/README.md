# Notebook editor (`web/notebook/`)

The Notebook app's editor (backlog S-13 and the Notebook part of TD-74), as a module the Desk app
imports from source. It's TipTap 3 with Yjs (ADR 0015, design section 5), the Tab and Temporal views,
versions, search and export, in Light, Zen and Dark. Storage and sync sit behind one interface,
`NotebookBackend`. On a member's desk that's the app's `DeskBackend` (`web/src/notebook/`, contract:
`services/deskd/docs/API.md` section 13). The only backend in this package is a local one in this browser's
IndexedDB, for the demo and for the Desk app's mock desk: no network, no sign-in, no provider names.
A member's build has none of it (`web/scripts/build-release.mjs` checks).

The look and behaviour follow `prototype/`'s Notebook, which the owner has seen. Colors come from
`docs/assets/brand/ui/tokens.json` and the type from `docs/assets/brand/ui/type.txt` (Nunito).

## Run the demo

```bash
export PATH=$HOME/.local/node-v24/bin:$PATH   # Node 24; the system Node is too old
cd web/notebook && npm ci && npm run demo
```

Then open <http://127.0.0.1:5180/>. `npm run demo` builds the page and serves it with the Desk
harness's CSP as a header (`default-src 'self'`, no inline script or style), so the demo proves
the module needs nothing the Desk app's policy refuses. The notes are fake and live only in that
browser. "Reset the demo" under the window starts again. URL options: `?theme=light|dusk|dark`,
`?fresh=1` (a clean database), `?fixture=long&words=150000&pages=300` (the perf fixture, in its own
database).

| Command | What it does |
|---|---|
| `npm run demo` | Build, then serve on `127.0.0.1:5180` with the CSP |
| `npm run dev` | Vite with hot reload on `127.0.0.1:5181`, without the CSP (React's refresh needs an inline script) |
| `npm run typecheck`, `npm run lint`, `npm test` | TypeScript, ESLint plus the CSS color check, Vitest (backend on fake-indexeddb, and the pure model) |
| `npm run e2e` | Build, then Playwright on the demo in headless Chromium. `MA_NB_PORT` moves it off 5182 |
| `npm run perf` | Build, then typing and scrolling on a long page. See [Performance](#performance). `tests/perf/profile.mjs` shows where a keystroke's time goes |
| `npm run record` | Build, then a screen recording of the demo to `media/notebook-demo.mp4`, metadata stripped |
| `npm run check` | typecheck, lint, test and e2e |

Wrap heavy runs in `flock ~/work/.build.lock nice -n 10 …` on the shared box.

## Why a folder of its own

`web/` is one Vite app with one `package.json`, not a workspace. A module that the UI/UX Engineer
wires in later must not change that app's files, its lockfile, its ESLint config or its tsconfig
while they're working in them. So this is its own package beside the app, built and tested on its
own:

- Its own `package.json` and `package-lock.json`, with the app's exact versions for everything they
  share (React 19.3.1, TypeScript 5.9.3, Vite 8.3.5, Vitest 5.1.0, Playwright 1.64.1, ESLint 10.14.0).
- The app's compiler options (`tsconfig.json` is a copy) and the app's color-literal rules: ESLint's
  from `web/eslint-rules/no-color-literals.js`, and `web/scripts/check-css-literals.mjs` for CSS, as
  they stand.
- Laid out like its sibling `web/agent/` (task 07): `ma-desk-*` package name, `.node-version`,
  `media/` for the recording, its own Playwright port.
- No library build: the app imports `src/` as source, so its own Vite build tree-shakes and splits
  it. The app's `vite.config.ts` dedupes what the two share, so a `node_modules` here does no harm.
  How the app adopted it: `STATUS.md`.

## Using it

The demo, on the local backend. The Desk app does the same with its `DeskBackend`, in `web/src/notebook/NotebookApp.tsx`.

```tsx
import { LocalBackend, Notebook } from '../notebook/src/index.ts';
import '../notebook/src/ui/notebook.css';
import 'virtual:ma-notebook-themes.css'; // notebookThemesPlugin() in vite.config.ts

const backend = new LocalBackend({ dbName: `ma-notebook:${deskId}` });
<Notebook backend={backend} stateKey={`ma.notebook.ui.${deskId}`} onOpenLink={openInDeskBrowser} />;
```

`Notebook` fills its container. It reads the Desk app's tokens (`--ma-surface-window`,
`--ma-text-primary`, `--ma-accent` and the rest, the names `web/src/theme/themeCss.ts` makes) and
follows `data-theme` on `<html>`, so it themes with the app. Its own few colors (binder tab colors,
the highlight) are `--ma-nb-*`, from `src/theme/tokens.ts`, the package's only file with color
literals. `headerStart` and `headerEnd` put the host's title and close button in its header row;
the demo uses them to look like the prototype's window. Every class is under `.ma-nb`, or
`.ma-nb-portal` for menus and the print view, so nothing leaks into the app.

## The interface

`src/model/backend.ts`. Everything the UI does goes through it. A desk can be away, so any of its promises can
reject: the UI catches that and draws nothing further, and the host says what's wrong, from what its backend reports.

| Group | Calls | On a desk (`DeskBackend`, API.md section 13) |
|---|---|---|
| Tree | `ready()`, `tree()`, `subscribe(fn)` | `notebook.tree`, read in pages, and the `notebook.tree` topic, which only says a newer `rev` |
| Structure | `createNotebook`, `renameNotebook`, `createTab`, `renameTab`, `recolorTab`, `addTabAtPage`, `createPage`, `movePage`, `trashPage`, `restorePage` | `notebook.notebook.*`, `notebook.tab.*`, `notebook.page.*` with `idem`. Last writer wins |
| Text | `openPage(id)` gives a `PageSession`: a `Y.Doc`, `ready`, `close()`, and optionally `onReadOnly`. `pageContent(id)` reads without a session | One `HocuspocusProvider` per open page on the same `Y.Doc`, over the `collab` channel. `notebook.page.content` in parts. A full page goes read-only |
| History | `versions`, `version`, `saveVersion`, `restoreVersion`, `versionAsOf(page, day)` | `notebook.version.*` |
| Temporal, search | `activity(from, to)`, `activeDays()`, `search(q, opts)` | `notebook.activity`, `notebook.activity.days`, `notebook.search` (`opts.labels` filters by label) |
| Colors (ADR 0091) | `setPageLabel(pageId, id \| null)`, `duplicatePage(pageId)`, `importPage(tabId, page, {after?})` | `notebook.page.label`, `notebook.page.duplicate`, `notebook.page.import` |

`tree()` returns a new immutable object after every change, so React reads it with
`useSyncExternalStore`. Records follow design 5.4's tables (`NotebookRec`, `TabRec`, `PageRec`,
`VersionMeta`, `ActivityRow` in `src/model/types.ts`), so a desk backend fills them from
`notebook.db` without translation. Page text is only ever a Y.Doc, bound to the editor at
`doc.getXmlFragment('default')` (`DOC_FIELD`). The schema (`src/model/schema.ts`) has no DOM in
it, so the same one runs headless, as the desk's agent tools need.

**`LocalBackend`** (`src/local/`) plays both halves in the tab:
- the client's cache: each page's Yjs updates appended to IndexedDB, batched for 150 ms, compacted
  to one row when a page opens with more than 20;
- deskd's `onStoreDocument`: 2 s after typing stops and at least every 10 s while it goes on, it
  derives the title (first line), snippet, word count and checklist flag, the search text, and the
  day's `page_activity` row, all in one transaction;
- versions as design 5.3 has them: at the end of an editing session (5 minutes idle, a page switch,
  the tab closing), every 30 minutes of continuous editing, at local midnight (the first edit after
  it snapshots the page as the day left it), on request, and on restore. All are kept 30 days, then
  the last of each day. Restore first versions what's on the page, then writes the old text as a
  new edit with its own version, so it never loses text;
- Trash: deleted pages are kept 30 days, then purged on the next start.

One database per desk: `dbName`. `importData()` (not part of the interface) writes fixtures.

## What's built

- **Editor** (`src/ui/Editor.tsx`): Title, Heading, Subheading and Body; bold, italic, underline,
  strikethrough, highlight; bulleted, numbered and nested checklists (Apple Notes' round boxes);
  quote, code block, rule and links through Markdown input rules (`#`, `-`, `1.`, `[ ]`, `>`,
  three backticks, `---`). A paste over about 1 MiB goes in several transactions (`src/ui/pasteSplit.ts`), so no message on a
  desk's `collab` comes near the 4 MiB that closes the session: at block boundaries, and a single block over that becomes
  several of its kind. Undo is Yjs's. Shortcuts: Mod-B, I, U; Mod-Shift-H highlight; Mod-Shift-L
  checklist; Mod-Alt-1, 2, 3 and 0 for the four styles. Mod-click on a link calls `onOpenLink`;
  nothing in the Notebook ever opens or fetches one. Paste keeps only what the schema has.
- **Tab view**: notebooks, the tab's pages (title live as it's typed), binder tabs in six colors
  stored by name, "Add tab at this page" (design 5.2), paging on across tab boundaries, pages
  dragged to another tab or within one, rename by double-click, recolor from a tab's menu (right
  click, or Shift+F10), Trash with Restore.
- **Narrow** (a container query on `.ma-nb`, `container: ma-nb`): under 640 px of its own width on a screen over 720 px (a
  narrow window, or the Desk app's open tile, ADR 0053), the notebooks and pages column (the days, in By day) steps aside
  behind a toggle at the head's start ("Notebooks and pages", or "Days", `aria-expanded`), and the page takes the width;
  open, the column comes over the page from the left, and choosing a page, Esc or a press on the page closes it. The head
  and toolbar tighten as on a phone. A phone keeps its own layout (the column above the page).
- **Context menus** (`src/ui/menu/`): one menu for the whole Notebook. It opens by right click, a long press on touch, and
  Shift+F10 or the Menu key; arrows, Home, End and a letter move, Enter or Space chooses, Right opens a submenu and Left or
  Esc closes it, Tab leaves, and focus goes back where it was (`nav.ts`, `gestures.ts`, pure and unit tested). Color
  submenus are a grid of swatches, each a radio item named for its color. On a phone (under 600 px, or a coarse pointer)
  a menu is never drawn over what it acts on, the selection or the pressed row (`placement.ts`), and a submenu opens in
  its place with Back. The Desk app has no shared menu component the Notebook could import (its desk menu, hidden list and
  Files menu each draw `.menu.desk-menu` themselves), so this is the Notebook's own, with the same keys.
  - **On selected text** (`editorMenu.ts`): Highlight, Text color, Turn into callout, Clear formatting, Cut, Copy, Paste,
    Block style. Cut, copy and paste use the async Clipboard API where the browser allows it; copy and cut fall back to the
    browser's own command, and a refused paste says quietly which keys to press (`clipboard.ts`).
  - **On a block** (the caret's): Turn into callout and Block style (the toolbar's and Markdown shortcuts' styles), Paste.
  - **On a page row**: Label, Rename (selects the page's first line, which is its name), Duplicate, Delete page, which
    asks in the footer as before with Keep focused. The ⋯ menu has Label and Duplicate page too.
  - Every change goes through `colorCommands.ts`, the one door to `nb-data`'s commands (`model/commands.ts`,
    `setPageLabel`, `duplicatePage`).
- **Page labels**: a label shows as a dot after the page's title (and is in its accessible name). The filter button in
  "Pages in …" appears once a page in the notebook has a label: show pages with one or several labels, or none, and sort
  by label (palette order, unlabeled last, manual order within each). Remembered per notebook in this browser only, under
  `<stateKey>.pages` (`pageView.ts`); it never reaches the desk.
- **Colors** (`src/ui/palette.ts`), the Product Designer's (`~/ma-coord/design-drafts/app-colors/`, Nov 10, their picks
  while the owner chooses from the stills; another pick changes only the values):
  - **Organizing colors:** Amber, Blue, Green, Rose, Violet and Slate, stored by name, the binder tabs' (`TAB_COLORS`):
    one color means the same thing on a tab, a label, a highlight and a callout. Amber comes first in every row: it's the
    default highlight, and the old yellow reads as it. Each has highlight, text, callout and label values per theme. A
    color submenu is one row of round swatches filled with the label color, named for screen readers, the checked one
    ringed in the accent, then "none". `tests/unit/palette.test.ts` holds any palette to the Designer's contrast
    (text.primary on a highlight or callout 7:1 in Light and 4.5:1 in Zen and Dark, colored text 4.5:1 on the window,
    the page and its callout). The values reach CSS as `--ma-nb-amber-highlight` and so on through `notebookThemesPlugin`,
    and files that leave the app get the light ones (`exportPalette()`); pasted colors from elsewhere map to the nearest
    (`nearestPaletteId`).
  - **Preview and the last color** (the Designer's spec): a swatch under the pointer or the keyboard shows on the text
    before it's chosen (`colorPreview.ts`, a decoration, never an edit). The color last chosen in any row is the host's
    (`Notebook`'s `lastColor` and `onLastColorChange`): the rows start on it, and Turn into callout applies it at once
    and then shows the row to change it. On a desk it's `notebookColor` in the member's layout `prefs`
    (`web/src/notebook/NotebookApp.tsx`), saved with the layout once `prefs` keeps keys it doesn't name
    (`sub/setup-circle`); the demo keeps it in `localStorage`.
  - **The Notebook's own scheme, "Navy ink":** `NOTEBOOK_SCHEME` re-declares the office's surface and accent
    properties (window, sidebar, accent, accent subtle, on accent, link; text, borders, status and danger stay the
    office's) on `.ma-nb`, its menus (`.ma-nb-portal`) and, on a desk, its window with the title bar
    (`.ma-window[data-app="notebook"]`, the scope the Desk app's `APP_INKS` gives Files). Nothing outside them changes.
    The Notebook's surfaces read them through `--nb-scheme-*` (`src/ui/color.css`). All surfaces are cool (hue 255, accent 262; the Designer, Nov 11; it replaced the warm "Paper and ink" the owner
    called brown). Light window `#FBFCFE`, sidebar `#EFF3F8`; Zen window `#4B5160`, sidebar `#444A59`; Dark window
    `#24272C`, sidebar `#1D2126`. Contrast, 270 of 270 pass: text 13.44:1 (Light), 7.15:1 (Zen), 12.79:1 (Dark) on the
    window; accent on window 5.38, 4.70 and 6.03; link 5.38, 5.35 and 6.03.
- **Temporal view**: month calendar with up to three activity dots a day, the day's pages as
  Created or Edited with first and last edit time and a snippet, the days list, ← and → between
  active days, a date picker, search within it, and "As of this day": the page's day-end version,
  read-only, with Restore.
- **History**: a page's versions by day with why each was kept, a read-only preview, Restore, and
  "Save a version now".
- **Search**: Ctrl/Cmd+K anywhere in the Notebook. Every word must match, by prefix, ignoring case
  and accents; title hits rank five times body hits; `has:checklist`; all notebooks or this one.
  A page opened from it takes the cursor, once: `PageEditor`'s effect is its only autofocus, never TipTap's own as
  well, whose second `view.focus()` a frame later took the box from a search opened straight after.
- **Export**: Markdown (GitHub flavour, checklists as `- [ ]`), a self-contained HTML file, and
  print or PDF through the browser's own print of the page alone.
- **Colors as data** ([ADR 0091](../../docs/decisions/0091-notebook-colors.md)): the binder tabs' six names (`blue`, `green`,
  `amber`, `rose`, `violet`, `slate`; `src/model/colors.ts`), never color values. The `highlight` mark takes a name (an old
  page's `yellow` is kept and reads as `amber`, the default), a
  `textColor` mark, `color` on blocks (`COLOR_BLOCK_TYPES`), and `PageRec.label`. Rendered as `data-color`,
  `data-text-color` and `data-block-color`, never a style. Commands for the menus in `src/model/commands.ts`
  (`setHighlight`, `setTextColor`, `clearFormatting`, `setBlockColor`, `colorsAt`, `blockAt`), label helpers in
  `src/model/tree.ts`, and the notebook's own file in `src/model/notebookFile.ts`, which round-trips pages exactly
  (`exportNotebookFile` and `importNotebookFile` in `src/ui/exporting.ts`). Markdown and HTML export draw colors from
  the UI palette's light values when given them. The palette's values and the menus are `ui/palette.ts` and the
  context menus (`sub/notebook-color-menus`).
- **Themes**: Light, Zen and Dark from the brand kit's tokens, Nunito with the type rule's
  weights, and the kit's metric-matched fallback face (in `demo/demo.css`; the app has its own).
  Zen was Dusk: the demo's picker says Zen, as the office does (ADR 0093), and the id stays `dusk` everywhere else
  (`data-theme`, the saved choice, CSS, `?theme=dusk`, the specs' screenshot names), so a saved choice still holds. The page is
  `surface.tile`, and `notebook.spec.ts` pins Zen's to the kit's `#474D5B` (ADR 0093's cool slate, from Nov 10).

## Performance

`npm run perf` (`tests/perf/perf.mjs`) opens the perf fixture in headless Chromium at 1440x900,
DPR 1: one page of about 150,000 words of generated lorem (headings, paragraphs, lists and
checklists, about 300 printed pages) and a tab of 300 short pages. With real CDP input it measures:
switching to the long page; typing 25 characters a second for 14 s in the middle of it (so the
store's 10 s ceiling falls inside), as keystroke to the next frame (rAF, then a task), Event
Timing, frame intervals from a rAF loop and long tasks; wheel scrolling 100 px a frame for 3 s
down and back; Ctrl+End and Ctrl+Home; the 300-page list; and search. `--words 20000` is budget
B3's 20k-word note. Three trials each; the table has the median.

**Indicative only.** Headless Chromium with software compositing, on two x86 machines, neither of
them a member's device. Other work ran on both (load averages below). Budgets B1 and B3 are proven
only on the reference devices (design 2.2).

| 3 trials, medians | Ryzen 5 7600X, 6 vCPU, shared box | | EPYC 7402, 48 threads, build server | |
|---|---|---|---|---|
| words in the page | 150,472 | 20,035 | 150,472 | 20,035 |
| open the page (click to painted), ms | 264 | 39 | 505 | 85 |
| typing: key to frame, p50 / p95 / max, ms | 26 / 31 / 38 | 13 / 19 / 21 | 49 / 67 / 146 | 18 / 23 / 31 |
| typing: fps, frames missed | 60, 0% | 60, 0% | 49, 17% | 60, 0% |
| typing: long tasks over 50 ms | 0 | 0 | 8 | 0 |
| scrolling: fps, frames missed, worst frame | 60, 0.1%, 33 ms | 60, 0%, 17 ms | 60, 0.3%, 33 ms | 60, 0%, 17 ms |
| Ctrl+End and back: worst frame, ms | 17 | 17 | 17 | 17 |
| 300-page list scrolling: fps | 60 | 60 | 60 | 60 |
| search: first query (loads the index) / after, ms | 95 / 0.5 | 29 / 0.3 | 242 / 0.9 | 92 / 0.6 |
| load average at start → end | 0.8 → 1.9 | 1.9 → 0.9 | 14.4 → 10.4 | 10.4 → 10.7 |

The EPYC columns are from `dab8247`. The Ryzen columns are from `0f7cf22`, the same editor before
two lines that don't touch typing or scrolling (a fixed grid row, no modulepreload polyfill); the
shared box's build queue was too long to repeat them. Result files go to `tests/perf/results/`
(ignored by git); `node tests/perf/summarize.mjs <files>` makes the table.

What it says:
- **B3's 20k-word note holds 60 fps** with no missed frames on both machines, keystroke to frame
  13 to 18 ms at p50, under B3's 32 ms.
- **The 150,000-word page holds 60 fps on the faster core and not on the slower one** (49 fps,
  key to frame 49 ms p50). `tests/perf/profile.mjs` shows why: the JavaScript per keystroke is
  about 5 ms (ProseMirror and the Yjs binding); the rest is Chromium's own editing work in a
  contenteditable, which grows with the rendered page. The EPYC's cores are much slower one at a time.
- **The 8 long tasks** are the local backend's store, which derives the whole page's text and JSON
  on the main thread every 10 s of continuous typing. On a desk, deskd does that work. For the
  local backend, a worker would take it off the main thread (left, below).
- **Tried and left out:** `content-visibility: auto` on the page's blocks. On the EPYC it brought
  the 150k-word page to 60 fps (key to frame 31 ms) and halved the open time, but Chromium then
  moves the caret wrongly through blocks it hasn't rendered: PageDown three times and typing lost
  the keys, and Ctrl+End landed at the start of the last block. Correct text comes first. A
  windowed version (render the blocks around the caret) is a possible next step.
- Scrolling, jumping to the end and the long page list stay at 60 fps on both.

## What's left

- **Very long pages on slow cores** (above): a worker for the local backend's store, and perhaps a
  windowed `content-visibility` that keeps the caret's surroundings rendered.

- **The Product Designer's looks 6 to 9** (`~/subcontractor-tasks/DECISIONS.md`): 6, 7 and 9 are in, from the brand
  review. Red text is `text.danger` (in `web/src/theme/tokens.ts` and the kit), links and ticked items in a highlight are
  `text.primary`, menus fade in over 120 ms and the search sheet rises over 160 ms, with none under reduced motion. Look 8
  is in for list snippets, from the integration on `main`: `derive()` joins a page's blocks and list items with " · "
  (`src/model/derive.ts`). The desk's service bundles that file, so a desk shows it only once `desk-notebook` is rebuilt
  from this model; until then its stored snippets run together. Search snippets still run blocks together, both
  `search.ts`'s and the desk service's own. Looks 1 to 5 are as decided.
- On `LocalBackend` only: two browser tabs on the same page don't see each other's typing until it reopens (both keep their
  edits; Yjs merges them). On a desk they do.
- Images and attachments (need `blobs.put` over `bulk`), pinned pages, dashed lists, tables
  (Phase 4), the "Edited by Agent · Undo" banner, the "In Trash, Restore?" banner, ZIP export of a
  notebook (Phase 2), search inside past versions, search scoped to a date range in the UI (the
  backend takes `fromDay` and `toDay`), a time zone setting (days use this browser's).
- Drag and drop has no keyboard equivalent beyond "Move to tab" in the page's menu, and no reorder
  of tabs or notebooks yet.
- Not checked on Safari, Firefox, phones or a real Retina screen; only headless Chromium on Linux.
- A command key sent within a millisecond of a click or a caret key (End, Ctrl+End) can still act
  on the old selection, because ProseMirror hears of the browser's caret move on the next
  `selectionchange`. People can't type that fast; scripts can (the long-page test waits 50 ms).

## Recording

`media/notebook-demo.mp4`, 25 s, 1280x800, 0.7 MB: a new page with bold, highlight and a
checklist, binder tabs and paging across them, search, an older version in History, the Temporal
view, then Zen (its picker still said Dusk when this was recorded) and Dark. Playwright's own
video of headless Chromium, re-encoded to H.264 with
`-map_metadata -1` and `-fflags +bitexact`. ffprobe finds only the container's brand tags, the
handler name and `encoder: Lavc libx264`; the H.264 stream carries x264's settings string. No
dates, names, paths or hosts.
