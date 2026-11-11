# King James Version (`kjv`): source

Format `ma-bible-text 2` (see `../README.md`).

## Edition and publisher

- **Edition:** the King James (Authorized) Version in its standardized text of 1769, as eBible.org publishes it under the id `eng-kjv2006`: "protocanon only, with Strong's numbers added". The archive's files are dated 2026-11-09, as is eBible.org's page for it.
- **Publisher:** the translation is of 1611 and the 1769 text long out of copyright; the distributor is eBible.org, which credits the CrossWire Bible Society for this text. Its statements are in `STATEMENT.txt`.
- **Fetched:** 2026-11-11, from ebible.org only.

## Files fetched

Used to build `kjv.tsv` (pinned in `tools/fetch.sh`):

| URL | Bytes | SHA-256 |
|---|---|---|
| https://ebible.org/Scriptures/eng-kjv2006_usfm.zip | 2,466,540 | `dce1ec3ea45a155ac05e975fc8d817da403a817713d554eb9cc3a2177a6cfd1c` |

Fetched to compare or check, not used to build it:

| URL | Bytes | SHA-256 | Why |
|---|---|---|---|
| https://ebible.org/Scriptures/eng-kjv_usfm.zip | 2,771,069 | `941ef56e3e38a5cd7d72a2ea582559e37e9da5be0b241cf8caf71014650b8133` | eBible.org's "King James Version + Apocrypha": its 66 book files are byte for byte those of `eng-kjv2006`, so the edition without the Apocrypha is the one used |
| https://ebible.org/Scriptures/eng-kjv2006_vpl.zip | 4,372,244 | `ee4cae32cddded36d9dfcb524c70c03dcf930cf04924ca34c9b805bac39210d4` | eBible.org's verse-per-line text, for the check below |

Pages read for the statement: https://ebible.org/find/details.php?id=eng-kjv2006 and https://ebible.org/find/details.php?id=eng-kjv.

## What normalizing kept and left out

Kept, all of the text, headings and footnotes:

- **Verse words:** every word of the text. The KJV's added words (printed in italics, `\add` here) are kept as plain words, as are the words in small capitals (`\nd`, "LORD"), the words of Jesus (`\wj`) and transliterations (`\tl`). Strong's numbers are dropped and the word kept. 1 John 2:23's bracketed clause "[but] he that acknowledgeth the Son hath the Father also" keeps its brackets: the 1769 text prints them.
- **Pilcrows:** the KJV's 2,970 `¶` all open a verse, and every one of those verses also starts a `\p` paragraph in the source; each is the `p` flag and the `¶` itself is dropped. So the `p` flags (4,635) are the source's `\p` paragraphs, which include every `¶`.
- **Headings:** the Psalm titles (`\d`, 116) as `d`; Psalm 119's 22 letter headings ("א ALEPH.", `\s1` with `\tl`) as level `1`.
- **Poetry:** the source marks only the Psalms as poetry, one `\q1` line per verse: 2,461 verses with `q` and one segment of kind `1` each. `\b` (209) always falls before a verse: the `b` flag. No break falls inside a verse, so no other verse has segments.
- **Footnotes:** all 6,959 (the KJV's marginal notes, such as "the light from…: Heb. between the light and between the darkness"). The source puts every note at the end of its verse, so every `F` offset equals its verse's length; each note starts with the words it refers to.
- **Book names:** each book's `\toc2`.

- **The 14 subscriptions** after Paul's letters and Hebrews ("Written to the Romans from Corinthus, and sent by Phebe servant of the church at Cenchrea."), headings after a book's last verse: `H` lines of level `e` after that verse's lines, for Romans, 1 and 2 Corinthians, Galatians, Ephesians, Philippians, Colossians, 1 and 2 Thessalonians, 1 and 2 Timothy, Titus, Philemon, Hebrews. Their added words (`\add`) are kept as plain words.

Left out:

- Book headers; `books.tsv` keeps the short name. There are no cross-references or Apocrypha in this archive, and the KJV omits no verse.

## Counts

| | |
|---|---|
| Books | 66 |
| Chapters | 1,189 |
| Verses (`V`) | 31,102 |
| Headings (`H`) | 152: level 1, 22; `d`, 116; `e`, 14 (the subscriptions) |
| Heading footnotes (`G`) | 0 |
| Segments (`Q`) | 2,461, all `1` |
| Titles inside a verse | none (the source puts every title outside the verse) |
| Footnotes (`F`) | 6,959 (all) |
| Cross-references left out | none in the source |
| Flags | `p` 4,635 verses, `b` 209, `q` 2,461 |

The KJV's versification is the reference the check compares the others with. It joins no verses.

## Checked against eBible.org's own verse-per-line text

All 31,102 verses are identical to `eng-kjv2006_vpl.zip`'s, once the VPL's square brackets around added words and its `¶` are taken out and its Psalm titles, which it runs into verse 1, are set aside as here.

## Spot checks (from `kjv.tsv`)

```
V	GEN	1	1	p	In the beginning God created the heaven and the earth.
H	PSA	23	1	d	A Psalm of David.
V	PSA	23	1	q	The LORD is my shepherd; I shall not want.
Q	PSA	23	1	1	The LORD is my shepherd; I shall not want.
V	JHN	3	16	p	For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.
V	REV	22	21	-	The grace of our Lord Jesus Christ be with you all. Amen.
```

And a subscription, after Romans 16:27's line:

```
V	ROM	16	27	-	To God only wise, be glory through Jesus Christ for ever. Amen.
H	ROM	16	27	e	Written to the Romans from Corinthus, and sent by Phebe servant of the church at Cenchrea.
```

## Rights

- **United States and most of the world: public domain.** eBible.org: "This royal decree has no effect outside of the UK, where this work is firmly in the Public Domain."
- **United Kingdom:** the Crown's letters patent still govern printing it there. eBible.org: "Letters patent issued by King James with no expiration date means that to print this translation in the United Kingdom or import printed copies into the UK, you need permission", the right being held today by Cambridge University Press, Oxford University Press and Collins. The patent is about printing and importing printed copies; whether showing the text in an app to members in the United Kingdom counts is not settled by these statements. That is for the Desk Engineer (and the owner) to weigh if members in the United Kingdom matter at launch.
- There is no condition on the name.
