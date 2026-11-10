# Notebook editor (`web/notebook/`)

The Notebook app's editor (backlog S-13 and the Notebook part of TD-74), as a module the Desk app
imports from source. It's TipTap 3 with Yjs (ADR 0015, design section 5), the Tab and Temporal views,
versions, search and export, in Light, Dusk and Dark. Storage and sync sit behind one interface,
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
| Temporal, search | `activity(from, to)`, `activeDays()`, `search(q, opts)` | `notebook.activity`, `notebook.activity.days`, `notebook.search` |

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
- **Temporal view**: month calendar with up to three activity dots a day, the day's pages as
  Created or Edited with first and last edit time and a snippet, the days list, ← and → between
  active days, a date picker, search within it, and "As of this day": the page's day-end version,
  read-only, with Restore.
- **History**: a page's versions by day with why each was kept, a read-only preview, Restore, and
  "Save a version now".
- **Search**: Ctrl/Cmd+K anywhere in the Notebook. Every word must match, by prefix, ignoring case
  and accents; title hits rank five times body hits; `has:checklist`; all notebooks or this one.
- **Export**: Markdown (GitHub flavour, checklists as `- [ ]`), a self-contained HTML file, and
  print or PDF through the browser's own print of the page alone.
- **Themes**: Light, Dusk and Dark from the brand kit's tokens, Nunito with the type rule's
  weights, and the kit's metric-matched fallback face (in `demo/demo.css`; the app has its own).

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
view, then Dusk and Dark. Playwright's own video of headless Chromium, re-encoded to H.264 with
`-map_metadata -1` and `-fflags +bitexact`. ffprobe finds only the container's brand tags, the
handler name and `encoder: Lavc libx264`; the H.264 stream carries x264's settings string. No
dates, names, paths or hosts.
