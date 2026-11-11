# American Standard Version (`asv`): source

Format `ma-bible-text 2` (see `../README.md`).

## Edition and publisher

- **Edition:** the American Standard Version of 1901, as eBible.org publishes it under the id `eng-asv`. The archive's files are dated 2026-10-29 and 2026-10-30, as is eBible.org's page for it.
- **Publisher:** the 1901 translation is long out of copyright; the distributor is eBible.org. Its statements are in `STATEMENT.txt`.
- **Fetched:** 2026-11-11, from ebible.org only.

## Files fetched

Used to build `asv.tsv` (pinned in `tools/fetch.sh`):

| URL | Bytes | SHA-256 |
|---|---|---|
| https://ebible.org/Scriptures/eng-asv_usfm.zip | 2,875,616 | `00b7b6c76cb1eb67b22ca51bd5ac13c2df526c13e1c38e78b862a7a2367f7071` |

Fetched to check the result, not used to build it:

| URL | Bytes | SHA-256 |
|---|---|---|
| https://ebible.org/Scriptures/eng-asv_vpl.zip | 4,333,699 | `6c41b8020cba9cf7041689f2356c55859e28023405537388be08bad93df2b050` |

Page read for the statement: https://ebible.org/find/details.php?id=eng-asv.

## What normalizing kept and left out

Kept, all of the text, headings and footnotes:

- **Verse words:** every word of the text. The ASV's added words (printed in italics, `\add` here) are kept as plain words; Strong's numbers are dropped and the word kept; "Selah" (`\qs`) is kept as the ASV prints it, "[Selah", with its one opening bracket (73 times, in Psalms and Habakkuk 3).
- **Headings:** the Psalm titles (`\d`, 116) as `d`; "BOOK I" to "BOOK V" in Psalms (`\ms1`) as level `1`; Psalm 119's 22 letter headings ("א ALEPH."), which this source writes as centered poetry lines (`\qc`) holding no verse, as level `2`.
- **Habakkuk 3:19's last line**, "For the Chief Musician, on my stringed instruments.": the source puts it in a `\d` after the book's last verse. eBible.org's own verse-per-line ASV prints it as part of 3:19, as the KJV and the WEB have it, so it is kept as the verse's last segment, of kind `d` (a title inside the verse).
- **Segments:** `\p` and `\m` are prose that starts a paragraph, `\nb` prose that doesn't; `\q1`, `\q2`, `\q3` are kinds 1 to 3; the indented paragraphs `\pi1` (14, the songs of Revelation 4, 5, 7, 11, 12, 15 and 19) are `i`, starting a paragraph. `\b` before a verse is its `b` flag.
- **Breaks inside a verse:** 103 paragraph starts (`p`, 2 with a stanza break too) and 7 stanza breaks (`b`, those 2 included) fall inside a verse and are on its segments.
- **Footnotes:** this edition keeps only 16 of the 1901 edition's marginal notes, one for each verse it leaves out (Matthew 17:21, 18:11, 23:14; Mark 7:16, 9:44, 9:46, 11:26, 15:28; Luke 17:36, 23:17; John 5:4; Acts 8:37, 15:34, 24:7, 28:29; Romans 16:24), each holding the verse ("Many authorities, some ancient, insert v. 21. But this kind goeth not out save by prayer and fasting. See Mrk 9:29."). Those 16 verses have no `V` line and their footnotes are at the end of the verse before.
- **Book names:** each book's `\toc2`.

Left out:

- The front matter and the 1901 preface (`FRT`, `INT`) in the archive.
- The 16 omitted verses' own lines (above), and the book headers; `books.tsv` keeps the short name. There are no cross-references or Apocrypha in this archive.

## Counts

| | |
|---|---|
| Books | 66 |
| Chapters | 1,189 |
| Verses (`V`) | 31,086 |
| Headings (`H`) | 143: level 1, 5; level 2, 22; `d`, 116; `e`, none |
| Heading footnotes (`G`) | 0 |
| Segments (`Q`) | 11,800: `0` 208, `p0` 88, `pb0` 2; `1` 11,413, `b1` 5; `2` 59; `3` 2; `i` 9, `pi` 13; `d` 1 |
| Titles inside a verse | 1 (Habakkuk 3:19) |
| Footnotes (`F`) | 16 (all) |
| Cross-references left out | none in the source |
| Flags | `p` 4,655 verses, `b` 434, `q` 5,168 |

Against the KJV's versification the ASV lacks the 16 verses above and has none the KJV lacks. It joins no verses.

## Checked against eBible.org's own verse-per-line text

All 31,086 verses are identical to `eng-asv_vpl.zip`'s, once the VPL's square brackets around added words are taken out and its Psalm titles, which it runs into verse 1, are set aside as here.

## Spot checks (from `asv.tsv`)

```
V	GEN	1	1	p	In the beginning God created the heavens and the earth.
H	PSA	23	1	d	A Psalm of David.
V	PSA	23	1	q	Jehovah is my shepherd; I shall not want.
Q	PSA	23	1	1	Jehovah is my shepherd; I shall not want.
V	JHN	3	16	p	For God so loved the world, that he gave his only begotten Son, that whosoever believeth on him should not perish, but have eternal life.
V	REV	22	21	pb	The grace of the Lord Jesus be with the saints. Amen.
```

## Rights

- **Public domain.** eBible.org: "The American Standard Version of the Holy Bible is in the Public Domain. Copy freely."
- There is no condition on the name.
