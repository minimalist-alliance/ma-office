# Bible app API (`com.minimalistalliance.bible`, appApi 1.0)

The wire between the Bible app's view (`apps/bible/view/`, the UI/UX Engineer's) and its service on the desk (`apps/bible/server/`, binary `bible-app`). The view runs in the contract's sandboxed frame and reaches the service only through the Desk app's bridge: reads with `apps.call`, mutations with `apps.mutate`, and the topic with SUB `app:com.minimalistalliance.bible:bible.marks` (deskd `API.md` §19, the desk app contract §3.2 and §5). Backlog row S-150.

Everything stays on the desk. The four translations are public domain and ship inside the package. The service has no network, no permissions and no telemetry.

## Conventions

- **Calls.** Every method takes one JSON object (`{}` when it has no params) and answers one JSON object. Unknown fields in params are ignored. JSON is camelCase; times are RFC 3339 in UTC with milliseconds, such as `2026-11-11T21:04:05.123Z`.
- **Callers.** Every call and subscription is for a caller, which deskd names in `from.caller`: `{kind: "owner"}` on a member's own desk, `{kind: "guild_member", member: "p-…", …}` on a Guild Desk. Marks, prefs, kept `idem` keys and the topic are the caller's own (see "Guild Desks"). A call with no caller, or one of a kind the service doesn't know, is `forbidden` `{reason: "caller"}`.
- **Mutations** (`bible.mark.put`, `bible.mark.remove`, `bible.highlight.clear`, `bible.prefs.set`) go through `apps.mutate`, which needs an `idem` key (UUIDv7). Keep one key per member action across retries. deskd keeps the reply 10 minutes; the service also keeps it in its own data (see "On disk"), so a retry after a restart of deskd or the service gets the first reply, not a second effect.
- **Errors** are the contract's codes with `details.reason` naming what's wrong. Branch on `code` and `reason`, never on `message`.

  | Code | When |
  |---|---|
  | `bad_request` | A param is missing, of the wrong type or out of range. `reason` is the param's name (`book`, `q`, `limit` …) or as listed per method |
  | `forbidden` | `reason: "caller"`: no caller, or not one this service knows (above) |
  | `not_found` | `reason`: `translation`, `book`, `chapter`, `ref`, `mark` |
  | `precondition_failed` | `reason: "full"`: a cap on marks or data, the caller's or the desk's (below) |
  | `conflict` | `reason: "idem"`: the same `idem` key with another method |
  | `unavailable` | `reason: "translation"`: that translation's files can't be read or fail their check (the others still work); `reason: "disk"`: the data couldn't be written, nothing changed; `reason: "data"`: the data can't be read; `reason: "starting"`: the data is still loading, retry |
  | `cancelled`, `deadline_exceeded` | deskd's, for a call that ran past its deadline or was cancelled |

- **Limits deskd enforces** before the service sees anything: 32 calls in flight, 30 s per call, 1 MiB per request and reply, 64 KiB per event. The service keeps every reply under 256 KiB.

### Translations

| `code` | `name` | `abbreviation` |
|---|---|---|
| `bsb` | Berean Standard Bible (the default) | BSB |
| `web` | World English Bible | WEB |
| `kjv` | King James Version | KJV |
| `asv` | American Standard Version | ASV |

Always in this order. A translation whose files aren't in the package isn't listed.

### Books

66 books, by their USFM ids, in canonical order. Old Testament (`"ot"`): `GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL`. New Testament (`"nt"`): `MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV`. Ids are exact (upper case). Names come from each translation's `books.tsv`, so they can differ a little between translations ("Song of Solomon", "Song of Songs").

Verse numbers are the translation's. Where a translation joins verses (`4-5`), the item has `verse: 4, verseEnd: 5`. Where it omits one, the number is simply missing.

## Data shapes

**Translation:** `{code, name, abbreviation, edition, publicDomain: true, default}`. `edition` is a short string for the menu, the edition's year (`"1901"`). `default` is true for `bsb` only.

**Book:** `{id, name, testament: "ot"|"nt", chapters, verses: [n, …]}`. `verses[i]` is the highest verse number in chapter `i + 1`.

**Ref:** `{book, chapter, verse?, verseEnd?}`. `verseEnd` only when it's more than `verse`.

**Item**, one entry of a chapter, in reading order:
- `{kind: "heading", level, text, notes?}`. `level`: `"1"` or `"2"` (section headings), `"d"` (a Psalm's superscription or a descriptive title, before verse 1), `"r"` (a parallel-passage line; none of the four has them today), or `"e"` (an end note after a book's last verse, such as a KJV subscription "Written to the Romans from Corinthus…", which comes after that verse's item). Several may come before one verse.
- `{kind: "verse", verse, verseEnd?, text, p?, b?, q?, segments?, notes?}`:
  - `text`: the publisher's words, verbatim (NFC; curly quotes and dashes as the translation has them).
  - `p: true`: a paragraph starts at this verse. `b: true`: a stanza break comes before it. `q: true`: it's poetry, at least in part.
  - `segments`: how the verse is set, in reading order, when the translation sets it in parts. Absent for a plain prose verse. Each is `{kind, level?, p?, b?, at, text}`:
    - `kind`: `"prose"`, `"poetry"` (`level` 1 to 4, the indent), `"indent"` (an indented prose paragraph), `"title"` (a title inside the verse, such as Habakkuk 3's), or `"heading"` (a heading inside the verse, with its own `level` as above and `notes?`).
    - `p: true` / `b: true`: a paragraph or a stanza break before this segment; both when a stanza break comes and then a paragraph starts. The first segment has neither: the verse's own `p` and `b` say what comes before it.
    - `at`: where it starts in `text`, in UTF-16 units; a heading's `at` is where it falls between the segments around it.
    - The segments other than headings cover `text` in order, with nothing or one space between one and the next, so `text.slice(at, at + text.length)` is the segment.
  - `notes: [{at, text}]`: footnotes. `at` is a UTF-16 offset into `text` where the marker goes, after the character before it. Search never reads them.
- A heading's `notes` are its own footnotes, `at` a UTF-16 offset into the heading's `text`.

**Mark**, anchored to verses, not to a translation, so it shows in every translation:
```
{id, kind, book, chapter, verse, verseEnd?, translation?, label?, color?, text?, createdAt, updatedAt}
```
- `kind`: `"bookmark"` (one per verse, an optional `label` of up to 80 characters), `"highlight"` (one per verse, `color` one of `"amber"`, `"green"`, `"blue"`, `"rose"`, stored by name), or `"note"` (any number per verse, `text` of 1 to 10,000 characters, over one verse or a range `verse` to `verseEnd` in one chapter).
- `translation`: the translation it was made in, for information only.
- `label` and `text` are what a member typed: untrusted plain text. Show them as text (`textContent`), never as markup.
- `id`: `m` and 24 hex digits, the service's.
- A bookmark and a highlight never have `verseEnd`.
- Characters are Unicode code points.

**Prefs**, the window's settings and place, kept in the app's data because the view has no storage of its own:
```
{textSize, oneVersePerLine, footnotes, highlightColor, place}
```
| Key | Values | Default |
|---|---|---|
| `textSize` | `16`, `18`, `20`, `22`, `24` | `18` |
| `oneVersePerLine` | boolean | `false` |
| `footnotes` | boolean | `true` |
| `highlightColor` | `"amber"`, `"green"`, `"blue"`, `"rose"`: the last one used | `"amber"` |
| `place` | `{translation, book, chapter, verse}` (the verse at the top of the column), or `null` | `null`: the view opens Genesis 1, BSB |

A highlight put also sets `highlightColor` to its color, so the bar remembers it without a second call.

## Methods

| Method | Mutation | Params | Result |
|---|---|---|---|
| `bible.state` | No | `{}` | `{available, reason?, translations, defaultTranslation, translation, books, prefs}` |
| `bible.info` | No | `{}` | `{translations, defaultTranslation}` |
| `bible.about` | No | `{translation}` | `{code, name, abbreviation, edition, statement, source, sourceUrl}` |
| `bible.books` | No | `{translation}` | `{translation, books}` |
| `bible.chapter` | No | `{translation, book, chapter}` | `{translation, book, bookName, chapter, items, prev, next, marks}` |
| `bible.lookup` | No | `{q, translation?}` | `{ref}` |
| `bible.search` | No | `{translation, q, scope?, cursor?, limit?}` | `{hits, total, counts, byBook, cursor, ref?}` |
| `bible.marks.chapter` | No | `{book, chapter}` | `{marks}` |
| `bible.marks.list` | No | `{kind?, order?, cursor?, limit?, translation?}` | `{marks, total, cursor}` |
| `bible.mark.put` | Yes | `{mark}` | `{mark, marks?}` |
| `bible.mark.remove` | Yes | `{id}` | `{}` |
| `bible.highlight.clear` | Yes | `{book, chapter, verse, verseEnd?}` | `{removed}` |
| `bible.prefs.get` | No | `{}` | the Prefs |
| `bible.prefs.set` | Yes | any of the Prefs' keys | the whole Prefs |

### `bible.state`
The one call the window makes when it opens.
- `available`: false only when no translation can be read (`reason: "texts"`). Marks and prefs still work then.
- `translations`, `defaultTranslation`: as `bible.info`.
- `translation`: the place's translation if it can be read, else `"bsb"`. `books` are that translation's, as `bible.books`.
- `prefs`: as `bible.prefs.get`.

### `bible.info`
`translations`: every translation in the package, in the order above. `defaultTranslation`: `"bsb"`.

### `bible.about`
For the translation's About sheet.
- `statement`: the notice to show the member, verbatim from the package's `texts/<code>/NOTICE.txt`: only the publisher's own paragraphs, each word for word from its `STATEMENT.txt`, one blank line between them. Show it as plain text. The audit records, `STATEMENT.txt` (the statements as read, with where and when) and `SOURCE.md`, stay in the package beside it for anyone who wants them.
- `source`: where the text came from, verbatim from `SOURCE.md` (Markdown, long: the edition, the files fetched with their hashes, what normalizing kept and dropped).
- `sourceUrl`: the publisher's page for the edition, for "its source, as a link": `https://berean.bible/terms.htm` for the BSB and eBible.org's page of each edition for the others.

Never edit either: "World English Bible" may be used only for unaltered text.

### `bible.books`
`books`: all the translation's books, in canonical order (66 for each translation at launch).

### `bible.chapter`
- `bookName`: the translation's name for the book.
- `items`: as above. Headings come right before the verse they head.
- `prev`, `next`: the chapter before and after as `{book, chapter}`, across books; `null` before Genesis 1 and after Revelation 22.
- `marks`: as `bible.marks.chapter` for this chapter.
- Errors: `not_found` with `reason` `translation`, `book` (not a book id, or not in this translation) or `chapter`.

Psalm 119, the longest chapter, is about 30 KiB.

### `bible.lookup`
Reads a reference as the member types it into Go to and gives it back clamped to what exists in the translation (`translation` defaults to `bsb`). `not_found` `{reason: "ref"}` if it isn't one. See "Reading a reference".

### `bible.search`
- `translation`: a code, or `"all"` for all four.
- `q`: the words (see "How search matches"). At most 200 characters and 12 words, else `bad_request` `{reason: "q"}`. Nothing to search for is also `bad_request` `{reason: "q"}`.
- `scope`: `"all"` (default), `"ot"`, `"nt"`, or a book id.
- `limit`: 1 to 200, default 50.
- `cursor`: from the previous page, with the same `translation`, `q` and `scope`, else `bad_request` `{reason: "cursor"}`.

Result:
- `hits`: `[{translation, book, chapter, verse, verseEnd?, text, ranges}]` in canonical order, and within one verse in the translations' order (BSB, WEB, KJV, ASV). `text` is the verse's words; `ranges` is `[[start, end], …]`, UTF-16 offsets into `text` (what JavaScript strings index), end exclusive, sorted, never overlapping, each covering a whole matched word or phrase as written (`Lord’s`).
- `total`: matching verses in the scope, over every translation searched. A joined verse counts once.
- `counts`: `{<code>: n}` for each translation searched.
- `byBook`: `[{book, count}]`, canonical order, books with no hits left out: for "214 verses" and "Show all 57" (search again with `scope` the book).
- `cursor`: for the next page, or `null` at the end. A page may hold fewer than `limit` hits to stay under 256 KiB.
- `ref`: present when `q` also reads as a reference (with a chapter number, or a book's full name), clamped as `bible.lookup` does, for "Go to John 3:16". It's for the first translation searched (`bsb` with `"all"`).

### `bible.marks.chapter`
`marks`: every mark in that chapter, ordered by `verse`, then `verseEnd`, then kind (bookmark, highlight, note), then `createdAt`. `book` and `chapter` are checked against the canon (the book's chapter count), not a translation.

### `bible.marks.list`
For Saved.
- `kind`: `"bookmark"`, `"highlight"` or `"note"`; absent for all.
- `order`: `"canon"` (default: by book, chapter, verse, then as `bible.marks.chapter`) or `"recent"` (newest `updatedAt` first).
- `limit`: 1 to 200, default 50.
- `translation`: when given, each mark also carries `verseText`, the first verse's words in that translation, cut at a word to at most 120 UTF-16 units with "…", or `""` where that translation has no such verse.
- `total`: how many marks of that kind there are. `cursor`: for the next page, or `null`. Pages don't shift when marks change between them.

### `bible.mark.put`
`mark` is a Mark without `id`, `createdAt` and `updatedAt` to create one, or with `id` to change one.
- **Create:** `kind`, `book`, `chapter`, `verse` are required; `verseEnd` only for a note or a highlight; `label` for a bookmark; `color` for a highlight (required); `text` for a note (required); `translation` optional.
  - A bookmark on a verse that has one changes that one (its `label`), with the same `id`.
  - A highlight sets each verse from `verse` to `verseEnd`, changing the color of one that's there. `mark` is the first verse's; `marks` lists every verse's, in order.
- **Change** (`id` given): only `label`, `color`, `text` and `translation` change; the kind and the verses stay (remove it and put a new one to move it). `not_found` `{reason: "mark"}` if there's no such mark.
- Errors: `bad_request` with `reason` `kind`, `book`, `chapter`, `verse`, `verseEnd`, `label`, `color`, `text` or `translation`; `precondition_failed` `{reason: "full"}`.

### `bible.mark.remove`
Removes one mark. `not_found` `{reason: "mark"}` if there's no such mark (a retry with the same `idem` gets the first reply instead).

### `bible.highlight.clear`
Removes the highlight on each verse from `verse` to `verseEnd`. `removed`: how many there were.

### `bible.prefs.get`, `bible.prefs.set`
`set` takes any of the Prefs' keys, changes those, and returns the whole Prefs. `place: null` clears the place. A wrong value is `bad_request` with the key as `reason`, and nothing changes. `place.translation` must be in the package; `book`, `chapter` and `verse` are checked against the canon.

## Topic `bible.marks`
SUB `app:com.minimalistalliance.bible:bible.marks`, for the caller deskd names. The first event is a `snapshot`, `{rev}`; after each change to any of that caller's marks, a `patch` with the new `{rev}`: a value, never a delta, since deskd may coalesce patches. When `rev` differs from the one you showed, read the marks you show again (`bible.marks.chapter`, `bible.marks.list`). `rev` only grows, across restarts too. Each caller has their own `rev`, and hears only about their own marks.

## The widget (`app.summary`)
deskd subscribes to it and draws the tile. The service asks deskd `desk.info.get` after HELLO. On a Guild Desk, and until deskd has answered: `{rows: []}`, always: a shared tile never shows one member's place. On a member's own desk, before a place exists: `{rows: []}`. After: one row, `{text: "John 3:16 · BSB", detail: <the first words of that verse in that translation, cut at a word to at most 120 UTF-16 units with "…">}`. Never a badge or a problem. At most one event a second.

## How search matches

The same rule reads the verses and the query, so they always agree.
- **Words** are runs of letters and digits. Everything else breaks words: spaces, punctuation, quotes, apostrophes (`'`, `’`, `ʼ`), hyphens and dashes (`-`, `‐`, `‑`, `–`, `—`). So `Lord’s` is the words `lord` and `s`, and `Beth-el` is `beth` and `el`.
- **Case and accents don't matter:** letters are lower-cased; accented Latin letters (Latin-1 and Latin Extended-A) match their base letter (`é` is `e`, `ł` is `l`, `æ` is `ae`, `ß` is `ss`); combining marks and the transliteration marks `ʾ` `ʿ` are dropped.
- **Every word must be in the verse** (AND), anywhere.
- **`"in the beginning"`** matches those words next to each other, in that order (punctuation between them doesn't matter).
- **A word that an apostrophe or hyphen splits** is matched as a phrase: `lord's` finds `Lord’s` and `LORD'S`; `beth-el` finds `Beth-el` and `Beth el`. Any other punctuation in `q` separates words: `faith,hope` is `faith hope`.
- **A trailing `*`** matches words that start with it: `bless*` finds `bless`, `blessed`, `blessing`. A `*` anywhere else is ignored.
- Otherwise whole words only: `love` doesn't find `loved`.
- Only the verse's words are searched: not headings, footnotes or book names.
- An unclosed `"` runs to the end of `q`.

## Reading a reference

`bible.lookup` and search's `ref` read the same way:
- **Book**, then chapter, then verse: `John 3:16`, `jn 3:16`, `John 3`, `1 Cor 13:4-7`, `Ps 23`, `song 2`, `I John 4:8`, `rev22`, `Gen 1.1`.
- **Books** by full name, by USFM id, by common abbreviation (`gen`, `ex`, `dt`, `ps`, `prov`, `isa`, `mt`, `mk`, `lk`, `jn`, `rom`, `phil`, `heb`, `jas`, `rev` and many more), or by a start of the full name that fits only one book (`deut`, `ecclesi`). Case, spaces and full stops don't matter.
- **Numbered books** take `1`, `2`, `3`, `I`, `II`, `III`, `First`, `Second`, `Third`, `1st`, `2nd`, `3rd`: `1 cor`, `1cor`, `I Cor`, `First Corinthians`.
- `:` or `.` between chapter and verse; `-`, `–` or `—` for a range. A range into the next chapter (`Gen 1:1-2:3`) ends at the first chapter's last verse.
- **A book alone** is its chapter 1. In a one-chapter book (Obadiah, Philemon, 2 John, 3 John, Jude) one number is the verse: `Jude 5` is `JUD 1:5`.
- **Clamped** to the translation: a chapter past the last is the last, a verse past the chapter's last is the last, 0 is 1, and an end before the start is dropped.

Search's `ref` is offered only when `q` has a chapter number or is a book's full name, so searching `am` or `is` alone doesn't offer "Go to" (but `job` and `mark` do).

## Limits

| What | Limit | Past it |
|---|---|---|
| Marks, per caller | 20,000 | `precondition_failed` `{reason: "full"}` |
| Stored data per caller (marks, notes included, and prefs, as stored) | 8 MiB | the same |
| Marks on the whole desk, every caller together | 30,000 | the same |
| Stored data on the whole desk | 32 MiB | the same |
| Bookmark `label` | 80 characters | `bad_request` `{reason: "label"}` |
| Note `text` | 1 to 10,000 characters | `bad_request` `{reason: "text"}` |
| Search `q` | 200 characters, 12 words | `bad_request` `{reason: "q"}` |
| `limit` (search, marks list) | 1 to 200 | `bad_request` `{reason: "limit"}` |
| A reply | 256 KiB | a shorter page with a `cursor` |

The caps keep the service small inside deskd's memory, whatever the number of members: memory holds about 160 bytes a mark, and a note's words and kept replies stay on disk. With all four translations read and searched it measured, in anonymous memory: 13 to 14.5 MiB with the owner's 20,000 highlights, 8 to 9.6 MiB with 8 MiB of notes, 15.6 to 17.7 MiB with 20 members at the desk's 30,000 marks, and 9 to 11 MiB with 20 members at its 32 MiB of notes; plus 25 MiB of page cache for the texts, which the kernel can drop (`docs/sub-status/bible-desk.md`).

## Guild Desks

A Guild Desk is shared: its Founder adds the app, and every member uses it.
- **Each member's data is their own:** marks, prefs and the place, kept `idem` keys and the `bible.marks` topic are kept per caller, by deskd's pseudonym for the member (`from.caller.member`, stable for this app on this desk, never their name). One member never sees, counts or changes another's; the same `idem` key from two members is two actions. A member's own desk has one caller, `owner`.
- **Caps:** each caller has their own (20,000 marks, 8 MiB), and the whole desk has one more (30,000 marks, 32 MiB), so memory stays small however many members there are. A member past either gets `precondition_failed` `{reason: "full"}`.
- **The widget** shows nothing on a Guild Desk.
- **When members leave**, deskd sends `app.members.retain` (below): their data goes, from memory and from the files.

### `app.members.retain` (deskd's own call)
`REQ {m: "app.members.retain", p: {members: ["p-…", …], all?}, idem, from: {kind: "desk"}}`. Every member's data whose pseudonym isn't in `members` is deleted, their marks, prefs and kept keys, and the files are rewritten without it before the reply. The `owner` data is never touched. The reply is `{removed: <how many members' data went>}`, and the same `idem` replays it.
- **An empty list is refused,** `bad_request` `{reason: "empty"}`, so a roster that lost its members by mistake never wipes everyone. To remove every member's data, deskd says so: `{members: [], all: true}`. `all: true` with a non-empty list is `bad_request` `{reason: "all"}`.
- From anyone but deskd it's `forbidden` `{reason: "caller"}`; with neither `members` nor `all`, `bad_request` `{reason: "members"}`. A view never calls it: it isn't in `ma-app.json`, since `app.` is deskd's namespace.

## On disk

The members' data is in the app's data folder (`$MA_APP_DATA`), two files of JSON lines (UTF-8, one JSON object per line, `\n` after each), readable without the app. A member's export carries this folder. Every line but the headers names its `caller`: `owner`, a member's pseudonym, or `desk` (deskd's own calls' keys).

**`state.jsonl`**, everything as of journal entry `seq`, replaced whole (written to `state.jsonl.tmp`, synced, renamed over, the folder synced):
```
{"format":"ma-bible-state","version":1,"seq":812,"savedAt":"2026-11-11T21:04:05.123Z"}
{"caller":"owner","rev":640}
{"caller":"owner","mark":{"id":"m019a…","kind":"note","book":"JHN","chapter":3,"verse":16,"translation":"bsb","text":"…","createdAt":"…","updatedAt":"…"}}
{"caller":"owner","prefs":{"textSize":18,"oneVersePerLine":false,"footnotes":true,"highlightColor":"amber","place":{"translation":"bsb","book":"JHN","chapter":3,"verse":16}}}
{"caller":"owner","idem":{"key":"019a…","m":"bible.mark.put","at":"…","res":{…}}}
{"caller":"p-…","rev":12}
…
```
The first line is the header; then, for each caller, their `rev`, one line per mark, their `prefs` and one line per kept `idem` key with the reply it got.

**`journal.jsonl`**, appended and synced before each mutation's reply:
```
{"format":"ma-bible-journal","version":1}
{"seq":813,"at":"…","m":"bible.mark.put","caller":"owner","idem":"019a…","rev":641,"put":[{…Mark…}],"res":{…}}
{"seq":814,"at":"…","m":"bible.highlight.clear","caller":"p-…","idem":"019a…","rev":13,"remove":["m019a…"],"res":{"removed":1}}
{"seq":815,"at":"…","m":"bible.prefs.set","caller":"owner","idem":"019a…","prefs":{…the whole Prefs…},"res":{…}}
{"seq":816,"at":"…","m":"app.members.retain","caller":"desk","idem":"019a…","drop":["p-…"],"res":{"removed":1}}
```
Each entry says what changed for its caller, not what was asked: `put` (marks as stored, added or replacing the one with that `id`), `remove` (ids), `prefs` (the whole Prefs), `rev` when a mark changed, `drop` (callers whose data went).

**To read it:** take `state.jsonl` (if there is one), then apply every journal entry whose `seq` is above the state's `seq`, in order. A last line without its `\n` or that doesn't parse is a write cut short by a crash, and is ignored (the service drops it before it appends). `*.tmp` files are leftovers and are ignored.

**Memory and disk:** memory holds each mark's place, kind, colour, label and times; a note's words and every kept reply are read back from these files when asked for.

**Compaction:** when the journal passes 64 KiB and is more than twice the size of the state or over 4 MiB, the service writes a new `state.jsonl` and then starts a new journal; after a retain that removed anyone, at once. A crash at any point leaves either the old or the new state, and the `seq` check keeps journal entries from being applied twice. If the service finds a retain that was never written out, or journal lines the state already holds, it compacts when it starts, so a member's removed data never stays in the files.

**`idem` keys** are kept per caller for 24 hours, or longer while they're among that caller's newest 1,000, and at most 10,000 per caller and 10,000 on the desk (the oldest go first).

**Format versions:** each file's header has `version`. A service that finds a version above its own reads nothing and answers deskd's HELLO with CLOSE 4426 (`needs_update`). A new format is written only after a HELLO has been answered.

The app keeps nothing in `$MA_APP_CACHE`.

## The texts in the package

`texts/<code>/` beside `bin/` in the package, read-only: `<code>.tsv` (the text, format `ma-bible-text 2`; `apps/bible/texts/README.md` has the format and the sources), `books.tsv` (book ids, names and chapter counts), `NOTICE.txt` (what the About sheet shows), `STATEMENT.txt` and `SOURCE.md`. The service reads a translation when it's first used, memory-maps its text, and keeps only small tables of where each verse is (about 20 bytes a verse). It checks each file's SHA-256 against the package's `ma-app.json` when it opens it, and refuses any format but 2: a translation that fails either is `unavailable` `{reason: "translation"}` while the others still work.
