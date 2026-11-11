# Bible app texts

The texts the Bible app bundles: four public-domain English translations, each normalized into one plain format (`ma-bible-text 2`), with its publisher's public-domain statement and a record of its source kept beside it. The app ships them inside itself: no network, no API, no tracking. Licensed translations (NIV, ESV, NLT and the like) are not here and are never fetched.

| Code | Name | Edition | Publisher | Source | Verses |
|---|---|---|---|---|---|
| `bsb` | Berean Standard Bible | current text ("updated to 3rd Printing"); public domain since April 30, 2023 | Berean Bible (BSB Publishing), berean.bible | `bereanbible.com/bsb_usfm.zip` for structure and notes, `bereanbible.com/bsb.txt` for the words | 31,086 |
| `web` | World English Bible | the 2020 stable text, eBible.org's `eng-web` ("World English Bible Classic"), files dated 2026-11-09 | eBible.org | `ebible.org/Scriptures/eng-web_usfm.zip` | 31,098 |
| `kjv` | King James Version | the 1769 standardized text, eBible.org's `eng-kjv2006` (protocanon only) | eBible.org, with the CrossWire Bible Society | `ebible.org/Scriptures/eng-kjv2006_usfm.zip` | 31,102 |
| `asv` | American Standard Version | 1901, eBible.org's `eng-asv` | eBible.org | `ebible.org/Scriptures/eng-asv_usfm.zip` | 31,086 |

The BSB is the modern default. Each folder holds:

- `<code>.tsv`: the text, in the format below.
- `books.tsv`: the 66 books with this translation's own short names and chapter counts.
- `STATEMENT.txt`: the publisher's own public-domain statements, quoted word for word, each with the page it came from and the date it was read.
- `SOURCE.md`: the edition, every file fetched with its size and SHA-256, what normalizing kept and left out, counts, spot checks and rights notes.

## Canon

All four have the 66-book Protestant canon at launch, in the order of the table under "Books" below. The World English Bible's deuterocanon (Tobit, Judith, the Greek additions to Esther and Daniel, Wisdom, Sirach, Baruch, 1 to 4 Maccabees, 1 and 2 Esdras, the Prayer of Manasseh, Psalm 151) is in its source archive and left out here, and eBible.org's "King James Version + Apocrypha" edition (`eng-kjv`) isn't used: its 66 book files are byte for byte those of `eng-kjv2006`, which has no Apocrypha. Adding these books is a later addition, not a refusal; the format already takes any USFM book id.

## Format: `ma-bible-text 2`

Two rules carry the rest. **The verse text is the publisher's words, verbatim**, so the BSB's and the WEB's names may go with it. **Lines are in reading order**: where a line sits in the file is where its content goes on the page.

### The file

`<code>.tsv` is UTF-8 in Unicode NFC, with LF line ends, no byte-order mark, no trailing spaces, and a newline after the last line. Its first line is:

```
# ma-bible-text 2 <code>
```

Every other line has exactly six fields separated by tabs. No field holds a tab, a newline or any other control or format character. The first field says what kind of line it is: `H`, `G`, `V`, `Q` or `F`. The next three are always the place:

- `BOOK`: the USFM book id (`GEN` to `REV`, below).
- `CHAPTER`: a number from 1.
- `VERSE`: a number from 1, or `N-M` only where the source itself joins verses (none of the four does today).

Books, chapters and verses come in canonical order. Around one verse, the lines come in this order:

```
H ...        headings that come just before the verse (each followed by its G lines)
V ...        the verse
Q ...        its segments, if it has inner structure; a heading that falls
H ...          inside the verse sits between two of its Q lines, where it falls
Q ...
F ...        its footnotes, in source order
H ... e      after a book's last verse only: headings that close the book
```

### `V`: a verse

```
V <TAB> BOOK <TAB> CHAPTER <TAB> VERSE <TAB> FLAGS <TAB> TEXT
```

`TEXT` is the verse's words exactly as the publisher has them, as one line: footnotes, cross-references, Strong's numbers, word-level markup and USFM markers removed; the words of added-word markup (the KJV's italics, `\add`) kept as plain words; whitespace collapsed to single spaces; no pilcrow (`¶`). Where the verse's lines break, the text has whatever the publisher has there, one space or none: the BSB's text is its `bsb.txt` byte for byte (after NFC and the whitespace rule), so a poetry line ending in an em dash runs straight into the next ("the ground—because out of it"). It is never empty.

`FLAGS` is `-`, or one or more of these letters, in this order:

- `p`: a paragraph starts at this verse (a USFM paragraph marker such as `\p`, `\m`, `\pi`, `\li`, or the KJV's `¶`, comes just before the verse's first word).
- `b`: a stanza break (USFM `\b`) comes just before it.
- `q`: some of the verse is poetry (the `\q` family). Only poetry: an indented prose paragraph or a title is not.

So the possible values are `-`, `p`, `b`, `q`, `pb`, `pq`, `bq`, `pbq`.

### `Q`: a segment of a verse

```
Q <TAB> BOOK <TAB> CHAPTER <TAB> VERSE <TAB> KIND <TAB> TEXT
```

A verse with inner structure is given again as its segments, right after its `V` line, in order. The segments partition the `V` text: put together in order, with zero or one space between two of them exactly as the `V` text has it, they make the `V` text and nothing else. A verse has `Q` lines when it is more than one segment, or one segment that isn't plain prose; a verse that is one plain prose segment has none.

`KIND` is an optional break, then the segment's kind:

- The break: `p` (a paragraph starts at this segment), `b` (a stanza break comes just before it), or `pb` (both, as in `FLAGS`). The first segment never has one: the verse's `FLAGS` say what comes before it.
- The kind:
  - `0`: prose.
  - `1` to `4`: a poetry line indented that many steps (`\q` and `\q1` are 1, `\q2` is 2, `\q3` is 3, `\q4` is 4). The BSB's right-aligned `\qr` lines ("Selah", "declares the LORD") are 1.
  - `i`: an indented prose paragraph, not poetry (`\pi`, `\mi`, and list items `\li1` and `\li2`).
  - `d`: a descriptive title inside the verse: the BSB's Psalm titles, which the publisher puts inside verse 1, and the note to the choirmaster at the end of Habakkuk 3:19 in the BSB and the ASV.

So `KIND` is one of `0`–`4`, `i`, `d`, each alone or after `p`, `b` or `pb`.

### `H`: a heading

```
H <TAB> BOOK <TAB> CHAPTER <TAB> VERSE <TAB> LEVEL <TAB> TEXT
```

Where it sits says where it goes:

- Before a `V` line (with the same place): it comes just before that verse. Several may, in source order.
- Between two `Q` lines of a verse (with that verse's place): it falls inside the verse, between those segments, such as a speaker's name in Song of Solomon.
- After a book's last verse and its lines, with `LEVEL` `e` and that verse's place: it closes the book, such as the KJV's subscriptions to Paul's letters ("Written to the Romans from Corinthus...").

`LEVEL` is:

- `1`: a section heading (USFM `\s`, `\s1`, and the major section `\ms`, such as "BOOK I" in Psalms).
- `2`: a subsection heading (USFM `\s2`, the BSB's Psalm 119 acrostic letters `\qa`, the ASV's acrostic lines `\qc`, the WEB's speaker labels `\sp`).
- `d`: a Psalm superscription or other descriptive title (USFM `\d`) that the source puts outside the verse, as the WEB, KJV and ASV do.
- `r`: a parallel-passage line. Allowed by the format; none of the four keeps them (`\r` is a cross-reference and is left out).
- `e`: a heading after a book's last verse, as above.

### `G`: a footnote on a heading

```
G <TAB> BOOK <TAB> CHAPTER <TAB> VERSE <TAB> OFFSET <TAB> TEXT
```

Directly after the `H` line it belongs to, one per footnote in source order. `OFFSET` is the number of Unicode code points of that heading's `TEXT` before the footnote's mark, from 0 to the heading's length. `TEXT` is as for `F`.

### `F`: a footnote on a verse

```
F <TAB> BOOK <TAB> CHAPTER <TAB> VERSE <TAB> OFFSET <TAB> TEXT
```

After the verse's `V` line and its `Q` lines, one per footnote in source order. `OFFSET` is the number of Unicode code points of the `V` line's `TEXT` before the footnote's mark, from 0 to the text's length: the mark sits where the source's `\f` was. `TEXT` is the note's own words as plain text: the words of `\ft`, `\fq`, `\fqa`, `\fk`, `\fl`, `\fw` and `\fv` kept, the reference `\fr` and the caller character dropped, whitespace collapsed. Where the source runs two parts of a note together with no space between words (such as `\fqa Sheminith\ft is probably`), one space is put there and counted in `SOURCE.md`.

When an edition leaves a verse out and keeps only its footnote (such as the ASV's "Many authorities, some ancient, insert v. 21" at Matthew 17:21), the verse has no `V` line and its footnote goes to the end of the verse before it, as the BSB's own source does. `SOURCE.md` lists each one.

### `books.tsv`

One line per book, in canonical order, three fields:

```
BOOK <TAB> NAME <TAB> CHAPTERS
```

`NAME` is the translation's own short English title ("Genesis", "Song of Solomon", "1 Corinthians", "Revelation"); `CHAPTERS` equals the chapters the `.tsv` has for that book.

### Books

`GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV`

### What is left out

Nothing of the text, headings or footnotes. Left out are: cross-references (`\x`, and the BSB's parallel-passage lines `\r`); the verses an edition omits (their own empty lines; their footnotes are kept, as above); and the book headers (`\id`, `\h`, `\toc`, the long titles `\mt` such as "The First Book of Moses, called Genesis", the WEB's chapter label `\cl`), of which `books.tsv` keeps the short name. Some layout is folded: a centered paragraph (`\pc`) is prose, `\li2` is `i` like `\li1`, and `\qr` is poetry level 1. Each `SOURCE.md` counts all of it.

### From format 1

Format 2 replaced format 1 on 2026-11-11 (header `# ma-bible-text 1`): `Q` lines became segments of any verse, not only poetry; `V` text became verbatim (no space added at a line break); the BSB's Psalm titles moved back into verse 1; headings inside a verse and after a book were added, and `G` lines; `q` came to mean poetry only.

## How to reproduce

From the repo root, with any folder outside the repo for the downloads:

```bash
apps/bible/texts/tools/fetch.sh /path/to/downloads
python3 -I apps/bible/texts/tools/normalize.py /path/to/downloads
python3 -I apps/bible/texts/tools/check.py --downloads /path/to/downloads
```

- `fetch.sh` downloads each source into its own folder (`<downloads>/<code>/`) and checks its SHA-256 against the value pinned in the script; a mismatch stops it. The publishers rebuild their files from time to time, so a pin can go stale: the comment at the top of `fetch.sh` says what to do.
- `normalize.py` (standard library only) reads the archives without unpacking them and writes every `<code>.tsv` and `books.tsv`. Two runs give identical bytes. It stops on any USFM marker it doesn't know, so a changed source is reported instead of normalized wrongly, and prints what it left out or adjusted (`NORMALIZE_VERBOSE=1` lists every case).
- `check.py` (standard library only) checks every rule above, including that each verse's segments partition its text, and with `--downloads` that every BSB verse equals `bsb.txt`. It prints each translation's counts and, as information, the verses it has or lacks against the KJV's versification.

The downloads are untrusted data: keep them out of the repo, never commit them, and run the scripts with `python3 -I`.

## Rights, in short

All four are public domain; each folder's `STATEMENT.txt` quotes the publisher and its `SOURCE.md` says what that means for the app. Two conditions on names, not on use: eBible.org asks that a changed text not be called the World English Bible, and the BSB's publisher asks that a text varying from the official one not bear the Berean name. The verse text here is each publisher's own, verbatim. The KJV is public domain in the United States; in the United Kingdom the Crown's letters patent still govern printing it.
