# World English Bible (`web`): source

Format `ma-bible-text 2` (see `../README.md`).

## Edition and publisher

- **Edition:** the World English Bible's "2020 stable text edition", as eBible.org publishes it under the id `eng-web` (titled "World English Bible Classic": American English, "Yahweh" for God's name, with the full ecumenical book set). The archive's files are dated 2026-11-09; its copyright page says it was generated "from source files dated 10 Nov 2026".
- **Publisher:** eBible.org, which made the translation and dedicated it to the public domain. Its statements are in `STATEMENT.txt`.
- **Fetched:** 2026-11-11, from ebible.org only.

## Files fetched

Used to build `web.tsv` (pinned in `tools/fetch.sh`):

| URL | Bytes | SHA-256 |
|---|---|---|
| https://ebible.org/Scriptures/eng-web_usfm.zip | 3,250,238 | `c521fbee9abc01733eb0347baa1ebc863c5531070aa31099f044238feaaeb0f7` |

Fetched to check the result, not used to build it:

| URL | Bytes | SHA-256 |
|---|---|---|
| https://ebible.org/Scriptures/eng-web_vpl.zip | 5,345,557 | `ae3b6acaaca97356311410e0e9a318d964140f8a4082394e8810776a111f944c` |

Page read for the statement: https://ebible.org/find/details.php?id=eng-web.

## What normalizing kept and left out

Kept, all of the text, headings and footnotes:

- **Verse words:** every word of the USFM text, verbatim. Strong's numbers (`\w word|strong="H1234"\w*`) are dropped and the word kept; the words of Jesus (`\wj`), book titles (`\bk`) and "Selah" (`\qs`) are kept as plain words. Segments meet with one space, as the source's line breaks are.
- **Headings:** `\d` as `d` (138: the Psalm titles, and Psalm 119's 22 letter names "ALEPH" to "TAV", which the WEB marks as `\d`; the source puts all of them outside the verse); `\ms1` ("BOOK 1" to "BOOK 5" in Psalms) as level `1`; the 33 speaker labels of Song of Solomon (`\sp`: "Beloved", "Lover", "Friends", "Brothers") as level `2`, 28 before a verse and 5 inside one, between its segments (1:4 "Friends" and "Beloved", 5:1 "Friends", 6:13 "Lover", 8:5 "Beloved").
- **Heading footnotes:** the 3 footnotes on Psalm titles (Psalms 46, 90 and 145, such as "Alamoth is a musical term.") are `G` lines after their headings.
- **Segments:** `\q1` and `\q2` are kinds 1 and 2; `\p` and `\m` are prose that starts a paragraph, `\nb` prose that doesn't; the indented paragraphs `\pi1` (39: the letters and decrees in Ezra, Nebuchadnezzar's proclamation in Daniel 4, Jeremiah's letter in Jeremiah 29, and Jeremiah 32), `\mi` (7: Cyrus's decree in Ezra 1 and others in Ezra, and Jeremiah 32:17) and the list items `\li1` (72, in Ezra and Nehemiah) are `i`, starting a paragraph.
- **Breaks inside a verse:** 808 paragraph starts (`p`, 5 with a stanza break too) and 22 stanza breaks (`b`, those 5 included) fall inside a verse and are on its segments, such as Genesis 3:13 "Yahweh God said to the woman, “What have you done?”" then `p0` "The woman said…".
- **Footnotes:** all 1,127, with the note's words (`\ft`, `\fq`, `\fqa`, `\fl`), including Hebrew and Greek words in notes (`\+wh`, NFC-normalized).
- **Five verses the WEB leaves out** and keeps only as a footnote (Luke 17:36, Acts 8:37, 15:34, 24:7, Romans 16:25): each has no `V` line and its footnote ("Some Greek manuscripts add: …") is at the end of the verse before.
- **Book names:** each book's `\toc2`.

Left out:

- **340 cross-references** (`\x`).
- **The deuterocanon and the front and back matter** in the archive: Tobit, Judith, Esther (Greek), Wisdom, Sirach, Baruch, 1 and 2 Maccabees, 1 Esdras, the Prayer of Manasses, Psalm 151, 3 Maccabees, 2 Esdras, 4 Maccabees, Daniel (Greek), the preface and the glossary. A later addition, not a refusal.
- The 5 omitted verses' own lines (above), the chapter label `\cl Psalm`, and the book headers; `books.tsv` keeps the short name.

## Counts

| | |
|---|---|
| Books | 66 |
| Chapters | 1,189 |
| Verses (`V`) | 31,098 |
| Headings (`H`) | 176: level 1, 5; level 2, 33 (5 inside a verse); `d`, 138; `e`, none |
| Heading footnotes (`G`) | 3 |
| Segments (`Q`) | 20,837: `0` 962, `p0` 791, `pb0` 2; `1` 8,162, `b1` 17; `2` 10,682; `pi` 12, `pbi` 3, `i` 206 |
| Titles inside a verse | none (the source puts every title outside the verse) |
| Footnotes (`F`) | 1,127 (all) |
| Cross-references left out | 340 |
| Flags | `p` 7,560 verses, `b` 733, `q` 7,153 |

Against the KJV's versification the WEB has 3 verses the KJV lacks, Romans 14:24–26 (the doxology the KJV has as Romans 16:25–27), and lacks 7: Luke 17:36, Acts 8:37, 15:34 and 24:7 (each given only in a footnote), and Romans 16:25–27 (moved to 14:24–26; the footnote that says so is at the end of 16:24). It joins no verses in these 66 books (its 6 joined verses are all in the deuterocanon).

## Checked against eBible.org's own verse-per-line text

`eng-web_vpl.zip` is eBible.org's verse-per-line WEB built from the same sources. Of our 31,098 verses, 31,072 are identical to it. The other 26 differ only where the VPL runs a heading into a verse: in 21 verses of Psalm 119 it puts the next stanza's letter name onto the stanza's last verse ("…forsake me. BETH"), here a `d` heading before the next verse; in 4 verses of Song of Solomon it runs a speaker label into the verse, here a heading between the verse's segments; and in Psalm 68:32 the source writes `Lord—\qs Selah—\qs*`, which by USFM's rule (a marker takes the one space after it) reads "Lord—Selah—" while the VPL prints "Lord— Selah—".

## Spot checks (from `web.tsv`)

```
V	GEN	1	1	p	In the beginning, God created the heavens and the earth.
F	GEN	1	1	21	The Hebrew word rendered “God” is “אֱלֹהִ֑ים” (Elohim).
H	PSA	23	1	d	A Psalm by David.
V	PSA	23	1	q	Yahweh is my shepherd; I shall lack nothing.
Q	PSA	23	1	1	Yahweh is my shepherd;
Q	PSA	23	1	2	I shall lack nothing.
V	JHN	3	16	-	For God so loved the world, that he gave his only born Son, that whoever believes in him should not perish, but have eternal life.
F	JHN	3	16	54	The phrase “only born” is from the Greek word “μονογενη”, which is sometimes translated “only begotten” or “one and only”.
V	REV	22	21	p	The grace of the Lord Jesus Christ be with all the saints. Amen.
```

## Rights

- **Public domain.** eBible.org: "The World English Bible is in the Public Domain. That means that it is not copyrighted." Anyone may copy, distribute, sell and use it "as much as you want".
- **The name.** "World English Bible" is a trademark of eBible.org, and it asks that "if you CHANGE the actual text of the World English Bible in any way, you not call the result the World English Bible any more." The actual text is unchanged: every verse is word for word the source's (the comparison above), with every heading, title, speaker label and footnote the WEB has, each where the WEB puts it. Removing markup changes no text: Strong's numbers are study tags attached to the words, not words. What is left out is the cross-references (study apparatus, not text) and the deuterocanon (a selection of books, not a change to any book's text). The app may call this the World English Bible.
