#!/usr/bin/env python3
"""Check the four Bible texts against the ma-bible-text 2 format (../README.md).

Usage:
    python3 -I check.py [--downloads DIR] [TEXTS]

TEXTS defaults to the texts folder this script lives in (apps/bible/texts).
With --downloads (the folder fetch.sh filled), it also checks that every
BSB verse's text equals the publisher's bsb.txt; without it, it says that
check was skipped. Standard library only. Prints per-translation counts
and, as information, the verses each translation has or lacks against the
KJV's versification. Exits 1 if any rule is broken.
"""

import os
import re
import sys
import unicodedata

CODES = ("bsb", "web", "kjv", "asv")
CANON = (
    "GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB "
    "PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP "
    "HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI "
    "2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV"
).split()
ORDER = {b: i for i, b in enumerate(CANON)}
REMNANTS = set("\\|<>{}*\u00b6")
FLAGS = re.compile(r"^(-|p?b?q?)$")
Q_KIND = re.compile(r"^(p|b|pb)?([0-4id])$")
VERSE = re.compile(r"^([1-9][0-9]*)(?:-([1-9][0-9]*))?$")
CHAPTER = re.compile(r"^[1-9][0-9]*$")
OFFSET = re.compile(r"^(0|[1-9][0-9]*)$")
H_LEVELS = {"1", "2", "d", "r", "e"}
ASCII_WS = re.compile(r"[ \t\r\n\f\v]+")
MAX_ERRORS = 30


class Checker:
    def __init__(self, code):
        self.code = code
        self.errors = []

    def err(self, where, msg):
        self.errors.append("%s %s: %s" % (self.code, where, msg))

    def text_ok(self, where, text):
        if not text:
            self.err(where, "empty text")
            return
        if text != text.strip() or "  " in text:
            self.err(where, "spaces not collapsed")
        if unicodedata.normalize("NFC", text) != text:
            self.err(where, "not NFC")
        for ch in text:
            cat = unicodedata.category(ch)
            if cat in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp") or ch in "\t\n\r":
                self.err(where, "control or format character U+%04X" % ord(ch))
                break
            if ch in REMNANTS:
                self.err(where, "markup remnant %r" % ch)
                break


def read_lines(chk, path):
    with open(path, "rb") as f:
        data = f.read()
    if data.startswith(b"\xef\xbb\xbf"):
        chk.err(path, "has a BOM")
    if b"\r" in data:
        chk.err(path, "has CR line ends")
    if not data.endswith(b"\n"):
        chk.err(path, "does not end with a newline")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        chk.err(path, "not UTF-8: %s" % e)
        return []
    lines = text.split("\n")[:-1]
    for i, line in enumerate(lines, 1):
        if line != line.rstrip(" \t"):
            chk.err("%s:%d" % (os.path.basename(path), i), "trailing space")
    return lines


def expand(vs):
    m = VERSE.match(vs)
    a = int(m.group(1))
    return a, int(m.group(2)) if m.group(2) else a


def splits(text, parts):
    """Do the parts, in order, make up text with zero or one space between?"""
    pos = 0
    for k, part in enumerate(parts):
        if k and text.startswith(" ", pos):
            pos += 1
        if not part or part != part.strip() or not text.startswith(part, pos):
            return False
        pos += len(part)
    return pos == len(text)


def finish(chk, v):
    """Rules for a whole verse, once all its lines are read."""
    if v is None:
        return
    where = v["where"]
    q = [(k, t) for k, t in v["q"]]
    poetry = any(Q_KIND.match(k).group(2) in "1234" for k, _ in q if Q_KIND.match(k))
    if ("q" in v["flags"]) != poetry:
        chk.err(where, "the q flag does not match its poetry lines")
    if not q:
        if v["inner"]:
            chk.err(where, "a heading inside a verse with no Q lines")
        return
    if len(q) == 1 and q[0][0] == "0":
        chk.err(where, "a single prose Q line that says nothing")
    if Q_KIND.match(q[0][0]) and Q_KIND.match(q[0][0]).group(1):
        chk.err(where, "its first Q line has a break (the V flags carry it)")
    if not splits(v["text"], [t for _, t in q]):
        chk.err(where, "its Q lines do not split its text")


def check_code(texts, code, plain):
    chk = Checker(code)
    base = os.path.join(texts, code)
    lines = read_lines(chk, os.path.join(base, code + ".tsv"))
    book_lines = read_lines(chk, os.path.join(base, "books.tsv"))
    stats = {"H": 0, "G": 0, "V": 0, "Q": 0, "F": 0, "joined": [],
             "inner": 0, "e": 0, "qkinds": {}}
    verses = set()
    texts_by_key = {}
    chapters = {}
    if not lines or lines[0] != "# ma-bible-text 2 %s" % code:
        chk.err("line 1", "header is not '# ma-bible-text 2 %s'" % code)
    last_pos = None
    closed = set()  # books whose 'e' headings have been read
    cur = None  # the current verse
    held = []  # H lines read but not yet placed: (key, level, text, where)
    prev = None  # the previous line's kind and key
    last_h = None  # (key, text) of the last H line, for its G lines
    for n, line in enumerate(lines[1:], 2):
        where = "line %d" % n
        f = line.split("\t")
        if len(f) != 6:
            chk.err(where, "has %d fields, not 6" % len(f))
            prev = None
            continue
        kind, book, ch, vs, field, text = f
        if kind not in ("H", "G", "V", "Q", "F"):
            chk.err(where, "unknown line kind %r" % kind)
            continue
        if book not in ORDER or not CHAPTER.match(ch) or not VERSE.match(vs):
            chk.err(where, "bad place %r %r %r" % (book, ch, vs))
            continue
        where = "line %d (%s %s %s:%s)" % (n, kind, book, ch, vs)
        key = (book, int(ch), vs)
        chk.text_ok(where, text)
        stats[kind] += 1
        if book in closed:
            chk.err(where, "comes after its book's closing headings")
        if kind == "G":
            if prev is None or prev[0] not in ("H", "G") or last_h is None or last_h[0] != key:
                chk.err(where, "does not follow its heading")
            elif not OFFSET.match(field) or int(field) > len(last_h[1]):
                chk.err(where, "offset %r outside 0..%d" % (field, len(last_h[1])))
            prev = (kind, key)
            continue
        if kind == "H":
            if field not in H_LEVELS:
                chk.err(where, "heading level %r" % field)
            last_h = (key, text)
            if field == "e":
                stats["e"] += 1
                if cur is None or cur["key"] != key or held:
                    chk.err(where, "an 'e' heading not right after its book's last verse")
                if cur is not None:
                    cur["closed"] = True
                prev = (kind, key)
                continue
            if cur is not None and cur.get("closed") and cur["key"][0] == book:
                chk.err(where, "a heading after its book's closing headings")
            held.append((key, where))
            prev = (kind, key)
            continue
        if kind == "V":
            for hkey, hwhere in held:
                if hkey != key:
                    chk.err(hwhere, "is not just before its verse")
            held = []
            finish(chk, cur)
            if cur is not None and cur.get("closed"):
                closed.add(cur["key"][0])
                if book in closed:
                    chk.err(where, "a verse after its book's closing headings")
            if not FLAGS.match(field) or field == "":
                chk.err(where, "flags %r" % field)
            a, b = expand(vs)
            if "-" in vs:
                if b <= a:
                    chk.err(where, "verse range does not ascend")
                stats["joined"].append("%s %s:%s" % (book, ch, vs))
            here = (ORDER[book], int(ch))
            if last_pos is not None:
                if here == last_pos[:2] and a <= last_pos[2]:
                    chk.err(where, "verse does not ascend within its chapter")
                elif here < last_pos[:2]:
                    chk.err(where, "out of order")
            last_pos = (ORDER[book], int(ch), b)
            chapters.setdefault(book, set()).add(int(ch))
            for x in range(a, b + 1):
                verses.add((book, int(ch), x))
            texts_by_key[key] = text
            cur = {"key": key, "text": text, "flags": field, "q": [], "f": False,
                   "inner": 0, "where": where}
            prev = (kind, key)
            continue
        # Q and F belong to the verse just above.
        if cur is None or cur["key"] != key or cur.get("closed"):
            chk.err(where, "does not belong to the verse just above")
            prev = (kind, key)
            continue
        if kind == "Q":
            if cur["f"]:
                chk.err(where, "a Q line after an F line")
            if not Q_KIND.match(field):
                chk.err(where, "segment kind %r" % field)
            stats["qkinds"][field] = stats["qkinds"].get(field, 0) + 1
            if held:
                # Headings between two Q lines of one verse: inside the verse.
                for hkey, hwhere in held:
                    if hkey != key:
                        chk.err(hwhere, "a heading inside another verse")
                if not cur["q"]:
                    chk.err(where, "headings between a verse and its first Q line")
                cur["inner"] += len(held)
                stats["inner"] += len(held)
                held = []
            cur["q"].append((field, text))
        else:
            if held:
                chk.err(where, "an F line after a heading")
                held = []
            cur["f"] = True
            if not OFFSET.match(field) or int(field) > len(cur["text"]):
                chk.err(where, "offset %r outside 0..%d" % (field, len(cur["text"])))
        prev = (kind, key)
    finish(chk, cur)
    for hkey, hwhere in held:
        chk.err(hwhere, "a heading with no verse after it")
    # books.tsv
    names = []
    for i, line in enumerate(book_lines, 1):
        f = line.split("\t")
        if len(f) != 3:
            chk.err("books.tsv:%d" % i, "has %d fields, not 3" % len(f))
            continue
        names.append(f[0])
        chk.text_ok("books.tsv:%d" % i, f[1])
        want = len(chapters.get(f[0], ()))
        if not f[2].isdigit() or int(f[2]) != want:
            chk.err("books.tsv:%d" % i, "%s has %s chapters, the text %d" % (f[0], f[2], want))
    if names != CANON:
        chk.err("books.tsv", "is not the 66 books in canonical order")
    if sorted(chapters) != sorted(CANON):
        chk.err(code + ".tsv", "does not hold the 66 books")
    for b, chs in chapters.items():
        if sorted(chs) != list(range(1, len(chs) + 1)):
            chk.err(code + ".tsv", "%s chapters are not 1 to n" % b)
    stats["chapters"] = sum(len(c) for c in chapters.values())
    stats["books"] = len(chapters)
    check_notice(chk, base)
    if plain is not None:
        check_plain(chk, texts_by_key, plain, book_lines)
    return chk, stats, verses


def check_notice(chk, base):
    """STATEMENT.txt, SOURCE.md and NOTICE.txt are there, and every paragraph of NOTICE.txt (what the app shows) is
    word for word in STATEMENT.txt."""
    for name in ("STATEMENT.txt", "SOURCE.md", "NOTICE.txt"):
        if not os.path.isfile(os.path.join(base, name)):
            chk.err(name, "is missing")
    path = os.path.join(base, "NOTICE.txt")
    if not os.path.isfile(path):
        return
    lines = read_lines(chk, path)
    notice = "\n".join(lines)
    with open(os.path.join(base, "STATEMENT.txt"), encoding="utf-8") as f:
        statement = f.read()
    paragraphs = notice.split("\n\n")
    for i, para in enumerate(paragraphs, 1):
        if not para or "\n" in para or para != para.strip():
            chk.err("NOTICE.txt", "paragraph %d is not one line between single blank lines" % i)
        elif para not in statement:
            chk.err("NOTICE.txt", "paragraph %d is not word for word in STATEMENT.txt" % i)


def check_plain(chk, texts_by_key, path, book_lines):
    """Every BSB verse's text is bsb.txt's, after NFC and collapsing spaces."""
    names = {line.split("\t")[1]: line.split("\t")[0] for line in book_lines}
    names["Psalm"] = "PSA"  # bsb.txt's references say "Psalm 23:1"
    with open(path, "rb") as f:
        text = f.read().decode("utf-8-sig")
    started, seen, same = False, set(), 0
    for line in text.splitlines():
        if not started:
            started = line.startswith("Verse\t")
            continue
        ref, _, verse = line.partition("\t")
        m = re.match(r"(.+) ([0-9]+):([0-9]+)$", ref)
        if not m or m.group(1) not in names:
            chk.err("bsb.txt", "bad line %r" % line[:40])
            continue
        key = (names[m.group(1)], int(m.group(2)), m.group(3))
        want = ASCII_WS.sub(" ", unicodedata.normalize("NFC", verse)).strip()
        if not want:
            if key in texts_by_key:
                chk.err("bsb.txt", "%s %d:%s is empty there but has a V line" % key)
            continue
        seen.add(key)
        if texts_by_key.get(key) != want:
            chk.err("bsb.txt", "%s %d:%s differs from the plain text" % key)
        else:
            same += 1
    for key in texts_by_key:
        if key not in seen:
            chk.err("bsb.txt", "%s %d:%s is not in the plain text" % key)
    chk.plain_same = same


def main(argv):
    args = argv[1:]
    downloads = None
    if args[:1] == ["--downloads"] and len(args) >= 2:
        downloads = args[1]
        args = args[2:]
    texts = args[0] if args else os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))
    results = {}
    failed = False
    for code in CODES:
        plain = os.path.join(downloads, "bsb", "bsb.txt") if downloads and code == "bsb" else None
        chk, stats, verses = check_code(texts, code, plain)
        results[code] = (stats, verses)
        status = "PASS" if not chk.errors else "FAIL (%d)" % len(chk.errors)
        print("%s: %s  books %d, chapters %d, verses %d, H %d (inside a verse %d, after a book %d), "
              "G %d, Q %d, F %d" % (code, status, stats["books"], stats["chapters"], stats["V"],
                                    stats["H"], stats["inner"], stats["e"], stats["G"],
                                    stats["Q"], stats["F"]))
        print("     Q kinds: %s" % (", ".join("%s %d" % kv for kv in sorted(stats["qkinds"].items()))
                                   or "none"))
        if code == "bsb":
            if plain is None:
                print("     bsb.txt: skipped (give --downloads to check it)")
            elif hasattr(chk, "plain_same"):
                print("     bsb.txt: %d verses identical to the plain text" % chk.plain_same)
        for e in chk.errors[:MAX_ERRORS]:
            print("  " + e)
        if len(chk.errors) > MAX_ERRORS:
            print("  ... %d more" % (len(chk.errors) - MAX_ERRORS))
        failed = failed or bool(chk.errors)
    print()
    print("Versification against the KJV (information, not a failure):")
    kjv = results["kjv"][1]
    for code in CODES:
        if code == "kjv":
            continue
        stats, verses = results[code]
        extra = sorted(verses - kjv, key=lambda k: (ORDER[k[0]], k[1], k[2]))
        lack = sorted(kjv - verses, key=lambda k: (ORDER[k[0]], k[1], k[2]))
        fmt = lambda ks: ", ".join("%s %d:%d" % k for k in ks) or "none"
        print("%s: %d verses the KJV lacks: %s" % (code, len(extra), fmt(extra)))
        print("%s: %d KJV verses it lacks: %s" % (code, len(lack), fmt(lack)))
        if stats["joined"]:
            print("%s: joined in the source: %s" % (code, ", ".join(stats["joined"])))
    print()
    print("check: %s" % ("FAIL" if failed else "PASS"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
