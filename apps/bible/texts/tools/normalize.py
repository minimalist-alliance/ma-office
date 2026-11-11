#!/usr/bin/env python3
"""Normalize the four public-domain Bible translations into ma-bible-text 2.

Reads the sources that fetch.sh downloaded (the USFM straight from the zip
files, nothing extracted) and writes, for each translation code,
<out>/<code>/<code>.tsv and <out>/<code>/books.tsv. The format is in
../README.md.

Usage:
    python3 -I normalize.py DOWNLOADS [OUT]

DOWNLOADS is the folder given to fetch.sh (it holds <code>/<file>).
OUT defaults to the texts folder this script lives in (apps/bible/texts).

Standard library only. The output depends only on the downloads' bytes,
never on time, locale or file order, so two runs give identical files.

A USFM marker this script does not know stops the run, so a changed
source is reported instead of silently normalized. Everything the script
drops or adjusts is counted and printed, for SOURCE.md
(NORMALIZE_VERBOSE=1 lists every case).
"""

import difflib
import os
import re
import sys
import unicodedata
import zipfile

FORMAT_VERSION = "2"

CANON = (
    "GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB "
    "PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP "
    "HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI "
    "2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV"
).split()

CODES = ("bsb", "web", "kjv", "asv")

# Each translation: its archive (where fetch.sh saves it) and its own rules.
# Every rule is explained in that translation's SOURCE.md.
SOURCES = {
    "bsb": {
        "archive": "bsb/bsb_usfm.zip",
        # The BSB's \toc2 for Psalms is "Psalm", its running head for one
        # psalm ("Psalm 23"); the book is "Psalms".
        "names": {"PSA": "Psalms"},
        # The BSB's one \mr holds the last line of Habakkuk 3:19 (the note
        # to the choirmaster), which the BSB's own bsb.txt prints as part of
        # that verse: it is read as a title segment (d) inside the verse.
        "mr_is_title": True,
        # The BSB's words come from its plain text, bsb.txt: the USFM
        # differs from it in spacing around em dashes and in a few verses'
        # words (see bsb/SOURCE.md). The USFM gives the structure.
        "words": "bsb/bsb.txt",
    },
    "web": {"archive": "web/eng-web_usfm.zip", "names": {}},
    "kjv": {"archive": "kjv/eng-kjv2006_usfm.zip", "names": {}},
    "asv": {
        "archive": "asv/eng-asv_usfm.zip",
        "names": {},
        # The ASV's last line of Habakkuk 3:19 (the note to the Chief
        # Musician) is a \d after the book's last verse; eBible.org's own
        # verse-per-line ASV prints it as part of 3:19, as the KJV and WEB
        # have it, so it is read as a title segment (d) of that verse.
        "trailing_d_is_text": {"HAB"},
    },
}

MAX_MEMBER_BYTES = 16 * 1024 * 1024  # the largest real book is under 1 MB

# Body paragraphs: marker -> (segment kind, starts a paragraph).
# Kinds: 0 prose, 1 to 4 poetry indent, i indented prose, d title.
BODY = {
    "p": ("0", True), "m": ("0", True), "pmo": ("0", True),
    "pc": ("0", True),  # centered paragraph (BSB inscriptions), as prose
    "nb": ("0", False),  # "no break": the paragraph goes on
    "pi1": ("i", True), "mi": ("i", True),  # indented prose paragraphs
    "li1": ("i", True), "li2": ("i", True),  # list items, as indented prose
    "q": ("1", False), "q1": ("1", False), "q2": ("2", False),
    "q3": ("3", False), "q4": ("4", False), "qm": ("1", False),
    "qr": ("1", False),  # right-aligned poetry line (BSB), as level 1
}
COUNTED_BODY = {"pc", "pi1", "mi", "li1", "li2", "qr"}
HEADINGS = {
    "s": "1", "s1": "1", "s2": "2",
    "ms": "1", "ms1": "1",
    "d": "d",
    "qa": "2",  # acrostic letter heading (BSB Psalm 119)
    "qc": "2",  # ASV's Psalm 119 acrostic headings; a \qc holding a verse stops the run
    "sp": "2",  # speaker label (WEB Song of Solomon), like the BSB's \s2 speakers
}
# Paragraphs that are not verse text: book titles and headers (the short
# name goes to books.tsv), the chapter label, and parallel-passage
# references (\r, \mr), which are cross-references.
DROP_PARA = {"id", "ide", "usfm", "h", "toc1", "toc2", "toc3",
             "mt", "mt1", "mt2", "mt3", "r", "mr", "cl"}
# Character markers whose words are kept as plain words.
CHAR_KEEP = {"add", "nd", "w", "wj", "tl", "qs", "bk"}
# Character markers allowed inside a footnote (words kept).
NOTE_CHAR_KEEP = CHAR_KEEP | {"wh", "ref"}
# Footnote parts: kept (words) and dropped (\fr, the reference).
NOTE_KEEP = {"ft", "fq", "fqa", "fk", "fl", "fw", "fp", "fv"}
NOTE_DROP = {"fr"}

SENTINEL = "\ue000"  # a footnote's place inside a text while building
TOKEN = re.compile(r"\\(\+?)([A-Za-z0-9]+)(\*?)|([^\\]+)|(\\)")
VERSE_NUM = re.compile(r"\s*([0-9]+(?:-[0-9]+)?)\s?")
CHAPTER_NUM = re.compile(r"\s*([0-9]+)\s?")
ASCII_WS = re.compile(r"[ \t\r\n\f\v]+")


class SourceError(Exception):
    pass


def clean(text):
    """NFC, collapse whitespace, trim."""
    return ASCII_WS.sub(" ", unicodedata.normalize("NFC", text)).strip()


def place(pieces):
    """Clean a text that may hold footnote sentinels.

    Returns (text, offsets): the cleaned text and, for each sentinel in
    order, the number of code points of the cleaned text before it.
    """
    raw = unicodedata.normalize("NFC", "".join(pieces))
    out = []
    events = []
    pending_space = False
    for ch in raw:
        if ch == SENTINEL:
            events.append((len(out), pending_space))
        elif ch in " \t\r\n\f\v":
            pending_space = True
        else:
            if pending_space and out:
                out.append(" ")
            pending_space = False
            out.append(ch)
    text = "".join(out)
    offsets = []
    for at, space in events:
        # A pending space before the footnote is kept in the text only if
        # words follow it; the footnote then sits after that space.
        offsets.append(at + 1 if (space and at > 0 and len(text) > at) else at)
    return text, offsets


class Counts:
    def __init__(self):
        self.items = {}

    def add(self, kind, detail=None):
        self.items.setdefault(kind, []).append(detail)


class Book:
    """Parses one USFM book into H, G, V, Q and F records in reading order."""

    def __init__(self, book, usfm, rules, counts, words=None):
        self.book = book
        self.rules = rules
        self.counts = counts
        self.words = words  # {(chapter, verse): the publisher's plain text}
        self.records = []
        self.chapter = None
        self.verse = None  # the open verse
        self.last = None  # (chapter, verse) of the last verse written
        self.pending_headings = []
        self.pending_p = False
        self.pending_b = False
        self.kind = "0"  # segment kind of the current body paragraph
        self.para = None  # ("body"|"heading"|"drop", marker)
        self.head = None  # the heading being read
        self.chars = []  # open character markers
        self.note = None  # the footnote being read
        self.parse(usfm)

    # -- helpers ---------------------------------------------------------
    def ref(self):
        return "%s %s:%s" % (self.book, self.chapter,
                             self.verse["vs"] if self.verse else "-")

    def fail(self, msg):
        raise SourceError("%s: %s" % (self.ref(), msg))

    def end_paragraph(self):
        """Close the current paragraph; a heading is finished."""
        if self.para and self.para[0] == "heading":
            h = self.head
            text, offsets = place(h["pieces"])
            if not text:
                self.fail("empty heading \\%s" % h["marker"])
            if len(offsets) != len(h["notes"]):
                self.fail("heading footnote count")
            self.pending_headings.append({
                "level": h["level"], "marker": h["marker"], "text": text,
                "notes": list(zip(offsets, h["notes"]))})
        self.para = None
        self.head = None

    def new_segment(self):
        v = self.verse
        if v is not None:
            seg = {"kind": self.kind, "brk": "", "pieces": [], "started": False}
            v["items"].append(("seg", seg))
            v["cur"] = seg

    def emit_heading(self, ch, vs, h, level=None):
        self.records.append(("H", ch, vs, level or h["level"], h["text"]))
        for off, note in h["notes"]:
            self.records.append(("G", ch, vs, str(off), note))
        if h["notes"]:
            self.counts.add("heading-footnote-kept", "%s %s:%s" % (self.book, ch, vs))

    def end_verse(self):
        v = self.verse
        if v is None:
            return
        self.verse = None
        ref = "%s %s:%s" % (self.book, v["ch"], v["vs"])
        segs = [it for t, it in v["items"] if t == "seg"]
        texts, offsets = [], []
        pos = 0
        for seg in segs:
            t, offs = place(seg["pieces"])
            start = pos + (1 if texts and t else 0)
            for o in offs:
                offsets.append(start + o if t else pos)
            seg["text"] = t
            if t:
                texts.append(t)
                pos = start + len(t)
        if not texts:
            if any(t == "head" for t, _ in v["items"]):
                self.fail("headings inside a verse with no text")
            if v["notes"]:
                # The edition leaves this verse out and keeps only its
                # footnote: the footnote goes to the end of the verse before.
                if self.last is None or self.last[0] != v["ch"]:
                    self.fail("a verse with only a footnote, and no verse before it")
                pch, pvs, plen = self.last
                for note in v["notes"]:
                    self.records.append(("F", pch, pvs, str(plen), note))
                self.counts.add("verse-left-out-its-footnote-moved",
                                "%s (to the end of %s:%s)" % (ref, pch, pvs))
            else:
                self.counts.add("empty-verse-dropped", ref)
            self.pending_headings = v["before"] + self.pending_headings
            return
        if len(offsets) != len(v["notes"]):
            self.fail("footnote count mismatch")
        seps = [" "] * (len(texts) - 1)
        if self.words is not None:
            texts, seps, offsets = self.take_words(v, ref, texts, offsets)
        text = texts[0] + "".join(s + t for s, t in zip(seps, texts[1:]))
        live = [seg for seg in segs if seg["text"]]
        for seg, t in zip(live, texts):
            seg["text"] = t
        q = any(seg["kind"] in "1234" for seg in live)
        flags = ("p" if v["p"] else "") + ("b" if v["b"] else "") + ("q" if q else "")
        for h in v["before"]:
            self.emit_heading(v["ch"], v["vs"], h)
        self.records.append(("V", v["ch"], v["vs"], flags or "-", text))
        inner = any(t == "head" for t, _ in v["items"])
        if len(live) > 1 or live[0]["kind"] != "0" or inner:
            first = True
            for t, it in v["items"]:
                if t == "head":
                    self.emit_heading(v["ch"], v["vs"], it)
                    self.counts.add("heading-inside-verse-kept",
                                    "%s \\%s %s" % (ref, it["marker"], it["text"]))
                elif it["text"]:
                    brk = "" if first else it["brk"]
                    if brk:
                        self.counts.add("segment-break-%s-inside-verse" % brk)
                    self.records.append(("Q", v["ch"], v["vs"], brk + it["kind"], it["text"]))
                    first = False
        for off, note in zip(offsets, v["notes"]):
            self.records.append(("F", v["ch"], v["vs"], str(off), note))
        self.last = (v["ch"], v["vs"], len(text))

    def take_words(self, v, ref, texts, offsets):
        """Give the verse the words of the publisher's plain text, verbatim.

        The verse keeps the structure the USFM gives it (its segments, where
        its footnotes sit); only the words change, to those of the plain
        text. A segment boundary is the plain text's own space there, or no
        space where the plain text has none. Returns (texts, seps, offsets).
        """
        key = (v["ch"], v["vs"])
        if key not in self.words:
            self.fail("not in the plain text")
        target = clean(self.words.pop(key))
        source = " ".join(texts)
        if source == target:
            return texts, [" "] * (len(texts) - 1), offsets
        dash = lambda t: t.replace(" \u2014", "\u2014").replace("\u2014 ", "\u2014")
        kind = "dash-spacing" if dash(source) == dash(target) else "words"
        self.counts.add("plain-text-differs-%s" % kind, "%s\n      usfm: %s\n      text: %s"
                        % (ref, source, target) if kind == "words" else ref)
        ops = difflib.SequenceMatcher(None, source, target, autojunk=False).get_opcodes()

        def to_target(p):
            for tag, i1, i2, j1, j2 in ops:
                if i1 <= p < i2:
                    return j1 + (p - i1) if tag == "equal" else j1
            return len(target)

        cuts = []  # (start of the separator in target, its length)
        at = 0
        for part in texts[:-1]:
            at += len(part)
            q = to_target(at)
            if q < len(target) and target[q] == " ":
                cuts.append((q, 1))
            elif q > 0 and target[q - 1] == " ":
                cuts.append((q - 1, 1))
            else:
                cuts.append((q, 0))
                self.counts.add("segment-boundary-without-space", ref)
            at += 1
        parts, seps, last = [], [], 0
        for q, n in cuts:
            parts.append(target[last:q])
            seps.append(target[q:q + n])
            last = q + n
        parts.append(target[last:])
        if any(not p or p != p.strip() for p in parts):
            self.fail("the plain text does not split into the USFM's segments")
        if parts[0] + "".join(s + p for s, p in zip(seps, parts[1:])) != target:
            self.fail("plain text split mismatch")
        new_offsets = [min(to_target(o), len(target)) for o in offsets]
        return parts, seps, new_offsets

    def add_text(self, text):
        if self.para and self.para[0] == "drop":
            return
        if "|" in text:
            # Word attributes (\w word|strong="H1234"\w*) are not words.
            if not self.chars or self.chars[-1] != "w":
                self.fail("'|' outside \\w: %r" % text[:60])
            text = text.split("|", 1)[0]
        if self.para and self.para[0] == "heading":
            self.head["pieces"].append(text)
            return
        if self.verse is None:
            if text.strip():
                self.fail("text outside a verse: %r" % text.strip()[:60])
            return
        v = self.verse
        if "\u00b6" in text:
            parts = text.split("\u00b6")
            for i, part in enumerate(parts):
                if i > 0:
                    if not v["started"]:
                        v["pilcrow"] = True
                        self.counts.add("pilcrow-to-p-flag")
                    else:
                        self.fail("a pilcrow inside a verse")
                self.add_text(part)
            return
        seg = v["cur"]
        if text.strip() and not seg["started"]:
            seg["started"] = True
            if not v["started"]:
                v["started"] = True
                v["p"] = self.pending_p or v.get("pilcrow", False)
                v["b"] = self.pending_b
                v["before"] += self.pending_headings
            else:
                seg["brk"] = ("p" if self.pending_p else "") + ("b" if self.pending_b else "")
                if self.pending_headings:
                    # Headings inside the verse go just before this segment.
                    at = next(i for i, (t, it) in enumerate(v["items"]) if it is seg)
                    v["items"][at:at] = [("head", h) for h in self.pending_headings]
            self.pending_headings = []
            self.pending_p = False
            self.pending_b = False
        elif text.strip() and (self.pending_headings or self.pending_p or self.pending_b):
            self.fail("a break inside a line")
        seg["pieces"].append(text)

    # -- footnotes -------------------------------------------------------
    def note_token(self, plus, name, close, text):
        n = self.note
        if n["name"] == "x":
            # A cross-reference: everything inside it is dropped.
            if name == "x" and close and not plus:
                self.finish_note()
            return
        if text is not None:
            if n["mode"] == "caller":
                stripped = text.lstrip()
                caller, _, rest = stripped.partition(" ")
                n["mode"] = "keep"
                text = rest if caller else ""
                if not caller and not stripped:
                    n["mode"] = "caller"
                    return
            if n["mode"] == "drop":
                return
            if "|" in text:
                if not n["chars"] or n["chars"][-1] not in ("w", "ref"):
                    self.fail("'|' in a footnote outside \\w or \\ref")
                text = text.split("|", 1)[0]
            if not text:
                return
            if n["boundary"] and n["buf"] and n["buf"][-1][-1:].isalnum() and text[:1].isalnum():
                n["buf"].append(" ")
                self.counts.add("footnote-space-added", "%s: ...%s|%s..."
                                % (self.ref(), n["buf"][-2][-12:], text[:12]))
            if text.strip():
                n["boundary"] = False
            n["buf"].append(text)
            return
        if close and not plus and name == n["name"]:
            self.finish_note()
            return
        if name in NOTE_CHAR_KEEP:
            if close:
                if not n["chars"] or n["chars"][-1] != name:
                    self.fail("unbalanced \\%s* in a footnote" % name)
                n["chars"].pop()
            else:
                n["chars"].append(name)
            return
        if plus:
            self.fail("unknown nested marker \\+%s in a footnote" % name)
        if name in NOTE_KEEP:
            n["mode"] = "keep"
            n["boundary"] = True
            if name == "fv" and not close:
                self.counts.add("footnote-verse-number-kept")
            return
        if name in NOTE_DROP and not close:
            n["mode"] = "drop"
            return
        self.fail("unknown marker \\%s%s in a footnote" % (name, "*" if close else ""))

    def start_note(self, name):
        self.note = {"name": name, "mode": "caller", "buf": [], "chars": [], "boundary": False}

    def finish_note(self):
        n = self.note
        self.note = None
        if n["name"] == "x":
            self.counts.add("cross-reference-dropped")
            return
        text = clean("".join(n["buf"]))
        if not text:
            self.fail("empty footnote")
        if self.para and self.para[0] == "heading":
            self.head["notes"].append(text)
            self.head["pieces"].append(SENTINEL)
            return
        if self.para and self.para[0] == "drop":
            self.fail("a footnote inside a dropped \\%s" % self.para[1])
        if self.verse is None:
            self.fail("footnote outside a verse")
        self.verse["notes"].append(text)
        self.verse["cur"]["pieces"].append(SENTINEL)

    # -- parse -----------------------------------------------------------
    def parse(self, s):
        if SENTINEL in s:
            self.fail("source holds U+E000")
        pos = 0
        while pos < len(s):
            m = TOKEN.match(s, pos)
            pos = m.end()
            plus, name, close, text, stray = m.groups()
            if stray:
                self.fail("stray backslash")
            if text is not None:
                if self.note is not None:
                    self.note_token(None, None, None, text)
                else:
                    self.add_text(text)
                continue
            # A marker. An opening marker eats one following space.
            if not close and pos < len(s) and s[pos] in " \t\r\n":
                pos += 1
            if self.note is not None:
                self.note_token(plus, name, close, None)
                continue
            if name == "ref" and self.para and self.para[0] == "drop":
                continue  # a reference inside a dropped \r goes with it
            if close:
                if name in CHAR_KEEP:
                    if not self.chars or self.chars[-1] != name:
                        self.fail("unbalanced \\%s%s*" % (plus, name))
                    self.chars.pop()
                    continue
                self.fail("unknown closing marker \\%s%s*" % (plus, name))
            if plus:
                if name in CHAR_KEEP:
                    self.chars.append(name)
                    continue
                self.fail("unknown nested marker \\+%s" % name)
            if name in ("f", "x"):
                self.start_note(name)
                continue
            if name in CHAR_KEEP:
                self.chars.append(name)
                continue
            if name == "c":
                cm = CHAPTER_NUM.match(s, m.end())
                if not cm:
                    self.fail("bad chapter number")
                pos = cm.end()
                self.end_paragraph()
                self.end_verse()
                self.chars = []
                ch = int(cm.group(1))
                if self.chapter is not None and ch <= self.chapter:
                    self.fail("chapters out of order")
                self.chapter = ch
                continue
            if name == "v":
                vm = VERSE_NUM.match(s, m.end())
                if not vm:
                    self.fail("bad verse number")
                pos = vm.end()
                if self.chapter is None:
                    self.fail("verse before chapter")
                if self.para and self.para[0] == "heading":
                    h = self.head
                    if h["marker"] != "d" or "".join(h["pieces"]).strip() or h["notes"]:
                        self.fail("verse inside a \\%s heading" % h["marker"])
                    # A \d holding the verse: a title inside the verse.
                    self.para = ("body", "d")
                    self.head = None
                    self.kind = "d"
                    self.counts.add("title-inside-verse", self.ref())
                if self.para and self.para[0] == "drop":
                    self.fail("verse inside a dropped \\%s" % self.para[1])
                self.end_verse()
                self.verse = {
                    "ch": self.chapter, "vs": vm.group(1), "items": [], "notes": [],
                    "before": self.pending_headings, "started": False,
                    "p": False, "b": False,
                }
                self.pending_headings = []
                self.new_segment()
                continue
            # Paragraph-level markers.
            if name == "b":
                self.end_paragraph()
                self.para = ("body", name)
                self.pending_b = True
                self.new_segment()
                continue
            if name in BODY or (name == "mr" and self.rules.get("mr_is_title")):
                self.end_paragraph()
                self.para = ("body", name)
                kind, starts = BODY.get(name, ("d", False))
                self.kind = kind
                if starts:
                    self.pending_p = True
                if name in COUNTED_BODY or name == "mr":
                    self.counts.add("paragraph-\\%s" % name)
                self.new_segment()
                continue
            if name in HEADINGS:
                self.end_paragraph()
                self.para = ("heading", name)
                self.head = {"level": HEADINGS[name], "marker": name, "pieces": [], "notes": []}
                if name in ("qa", "qc", "ms", "ms1", "sp"):
                    self.counts.add("heading-from-\\%s" % name)
                continue
            if name in DROP_PARA:
                self.end_paragraph()
                self.para = ("drop", name)
                if name in ("r", "mr"):
                    self.counts.add("cross-reference-dropped-\\%s" % name, self.ref())
                continue
            self.fail("unknown marker \\%s" % name)
        if self.note is not None:
            self.fail("unclosed footnote")
        self.end_paragraph()
        if (self.book in self.rules.get("trailing_d_is_text", ()) and self.verse
                and self.pending_headings
                and all(h["marker"] == "d" and not h["notes"] for h in self.pending_headings)):
            for h in self.pending_headings:
                seg = {"kind": "d", "brk": "", "pieces": [h["text"]], "started": True}
                self.verse["items"].append(("seg", seg))
                self.counts.add("trailing-\\d-read-as-title-segment", "%s %s" % (self.ref(), h["text"]))
            self.pending_headings = []
        self.end_verse()
        for h in self.pending_headings:
            # After the book's last verse (the KJV's subscriptions).
            self.emit_heading(self.last[0], self.last[1], h, "e")
            self.counts.add("heading-after-last-verse-kept",
                            "%s %s:%s \\%s %s" % (self.book, self.last[0], self.last[1],
                                                  h["marker"], h["text"]))
        self.pending_headings = []


def book_id(usfm):
    m = re.match(r"\ufeff?\\id ([A-Z0-9]{3})", usfm)
    return m.group(1) if m else None


def toc2(usfm):
    m = re.search(r"^\\toc2 (.*)$", usfm, re.M)
    return clean(m.group(1)) if m else None


def read_plain_text(path, names):
    """The BSB's bsb.txt: "<Book> <c>:<v><TAB><text>" lines after a header.

    Returns {book: {(chapter, verse): text}}; a verse the edition leaves
    out (an empty line) is not in it. check.py reads it the same way.
    """
    with open(path, "rb") as f:
        data = f.read(MAX_MEMBER_BYTES)
    text = data.decode("utf-8-sig")
    words = {}
    started = False
    for line in text.splitlines():
        if not started:
            started = line.startswith("Verse\t")
            continue
        ref, tab, verse = line.partition("\t")
        m = re.match(r"(.+) ([0-9]+):([0-9]+)$", ref)
        if not tab or not m or m.group(1) not in names:
            raise SourceError("plain text: bad line %r" % line[:60])
        key = (int(m.group(2)), m.group(3))
        book = words.setdefault(names[m.group(1)], {})
        if not verse.strip():
            continue  # a verse the edition leaves out (its footnote has it)
        if key in book:
            raise SourceError("plain text: %s twice" % ref)
        book[key] = verse
    if not words:
        raise SourceError("plain text: no verses")
    return words


def read_archive(path):
    books = {}
    with zipfile.ZipFile(path) as z:
        for info in sorted(z.infolist(), key=lambda i: i.filename):
            if not info.filename.lower().endswith(".usfm"):
                continue
            if info.file_size > MAX_MEMBER_BYTES:
                raise SourceError("%s: member too large" % info.filename)
            data = z.read(info)
            if len(data) > MAX_MEMBER_BYTES:
                raise SourceError("%s: member too large" % info.filename)
            usfm = data.decode("utf-8")
            bid = book_id(usfm)
            if bid is None:
                raise SourceError("%s: no \\id" % info.filename)
            if bid in books:
                raise SourceError("%s: book %s twice" % (info.filename, bid))
            books[bid] = usfm
    return books


def normalize(code, downloads, out_dir):
    rules = SOURCES[code]
    books = read_archive(os.path.join(downloads, rules["archive"]))
    missing = [b for b in CANON if b not in books]
    if missing:
        raise SourceError("missing books %s" % " ".join(missing))
    left_out = [b for b in books if b not in CANON]
    counts = Counts()
    words = None
    if rules.get("words"):
        words = read_plain_text(os.path.join(downloads, rules["words"]),
                                {toc2(books[b]): b for b in CANON})
    lines = ["# ma-bible-text %s %s" % (FORMAT_VERSION, code)]
    book_lines = []
    for b in CANON:
        book_words = None if words is None else words.pop(b, {})
        bk = Book(b, books[b], rules, counts, book_words)
        if book_words:
            raise SourceError("%s: verses in the plain text but not the USFM: %s"
                              % (b, sorted(book_words)[:5]))
        name = rules["names"].get(b) or toc2(books[b])
        if not name:
            raise SourceError("%s: no book name" % b)
        chapters = sorted({r[1] for r in bk.records if r[0] == "V"})
        if chapters != list(range(1, len(chapters) + 1)):
            raise SourceError("%s: chapters are not 1 to n" % b)
        book_lines.append("%s\t%s\t%d" % (b, name, len(chapters)))
        for kind, ch, vs, field, text in bk.records:
            lines.append("%s\t%s\t%d\t%s\t%s\t%s" % (kind, b, ch, vs, field, text))
    os.makedirs(os.path.join(out_dir, code), exist_ok=True)
    write(os.path.join(out_dir, code, code + ".tsv"), lines)
    write(os.path.join(out_dir, code, "books.tsv"), book_lines)
    return lines, left_out, counts


def write(path, lines):
    data = ("\n".join(lines) + "\n").encode("utf-8")
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def main(argv):
    if len(argv) not in (2, 3):
        sys.stderr.write(__doc__)
        return 2
    downloads = argv[1]
    out = argv[2] if len(argv) == 3 else os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))
    verbose = os.environ.get("NORMALIZE_VERBOSE") == "1"
    for code in CODES:
        try:
            lines, left_out, counts = normalize(code, downloads, out)
        except SourceError as e:
            sys.stderr.write("normalize: %s: %s\n" % (code, e))
            return 1
        kinds = {}
        for l in lines[1:]:
            kinds[l[0]] = kinds.get(l[0], 0) + 1
        print("%s: V %d, H %d, G %d, Q %d, F %d; left out of the archive: %s"
              % (code, kinds.get("V", 0), kinds.get("H", 0), kinds.get("G", 0),
                 kinds.get("Q", 0), kinds.get("F", 0), " ".join(left_out) or "none"))
        for kind in sorted(counts.items):
            items = counts.items[kind]
            print("  %s: %d" % (kind, len(items)))
            details = [d for d in items if d]
            if details and (verbose or len(details) <= 12):
                for d in details:
                    print("    " + d)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
