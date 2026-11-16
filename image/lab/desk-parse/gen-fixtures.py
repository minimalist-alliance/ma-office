#!/usr/bin/env python3
"""gen-fixtures.py <outdir> [MiB]: the worker's worst-case files at the per-file ceiling, one of each kind (desk-agent's
SizedFixtures, in Python so a lab box needs no JDK or Maven): text, pdf-text (dense pages, deflated), pdf-image (a 2 MiB
picture a page), docx (40% text), pptx (10% text), xlsx (one sheet of rows, deflated), plus pdf-500 (a 500-page text PDF of
the same pages: the worst case of files_read's ask). Each is at most the size asked. Fixed seed, so every run is the same."""
import os, random, sys, zipfile, zlib, io

out = sys.argv[1]
MIB = int(sys.argv[2]) if len(sys.argv) > 2 else 20
SIZE = MIB << 20
os.makedirs(out, exist_ok=True)
rnd = random.Random(1109)
LET = "abcdefghijklmnopqrstuvwxyz"

def word(prose):
    w = "".join(rnd.choice(LET) for _ in range(2 + rnd.randrange(9)))
    if prose:
        k = rnd.randrange(120)
        w = w + "’s" if k == 0 else "café" if k == 1 else "–" if k == 2 else w
    return w

def line(n, prose=False):
    s = []
    ln = 0
    while ln < n:
        w = word(prose); s.append(w); ln += len(w) + 1
    return " ".join(s)

def w(name, data):
    with open(os.path.join(out, name), "wb") as f:
        f.write(data)
    print(f"{name} {len(data)}")

def text(size):
    b = bytearray()
    while len(b) < size:
        b += (line(60 + rnd.randrange(40), True) + "\n").encode()
    b = bytearray(b[:size])
    for i in range(max(0, len(b) - 4), len(b)):
        if b[i] & 0x80: b[i] = 0x2e
    return bytes(b)

def pdf(pages_of, npages, size_cap=None):
    """pages_of(i) -> (content bytes, extra objects needed): plain text pages, deflated content, Helvetica."""
    objs = []   # bytes of each object body, numbered from 1
    font = 3 + 2 * npages
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(npages))
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {npages} >>".encode())
    for i in range(npages):
        c = pages_of(i)
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + 2 * i} 0 R /Resources << /Font << /F1 {font} 0 R >> >> >>".encode())
        objs.append(f"<< /Length {len(c)} /Filter /FlateDecode >>\nstream\n".encode() + c + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    return assemble(objs)

def assemble(objs):
    out_ = io.BytesIO(); out_.write(b"%PDF-1.4\n"); offs = []
    for i, o in enumerate(objs, 1):
        offs.append(out_.tell()); out_.write(b"%d 0 obj\n" % i + o + b"\nendobj\n")
    x = out_.tell()
    out_.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs))
    out_.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x))
    return out_.getvalue()

def textpage(i):
    s = ["BT /F1 8 Tf 10 TL 40 760 Td (Page %d) Tj" % (i + 1)]
    for _ in range(70):
        s.append("T* (%s) Tj" % line(110))
    s.append("ET")
    return zlib.compress("\n".join(s).encode("latin-1"))

def textpdf_to(size):
    pages = []
    total = 4000
    # grow pages until the file would pass the size: estimate from page 0 length
    one = len(textpage(0)) + 200
    n = max(1, int((size - 2000) / one))
    pg = [textpage(i) for i in range(n)]
    data = pdf(lambda i: pg[i], n)
    while len(data) > size and n > 1:
        n -= max(1, (len(data) - size) // one + 1); data = pdf(lambda i: pg[i], n)
    return data

def imagepdf(size):
    n = max(1, size // (2 << 20)); per = (size - 2000 - n * 600) // n
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", ("<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join(f"{3 + 3 * i} 0 R" for i in range(n)), n)).encode()]
    font = 3 + 3 * n
    for i in range(n):
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + 3 * i} 0 R /Resources << /Font << /F1 {font} 0 R >> /XObject << /Im{i} {5 + 3 * i} 0 R >> >> >>".encode())
        c = f"q 468 0 0 351 72 300 cm /Im{i} Do Q BT /F1 11 Tf 72 260 Td (Figure {i + 1}: {line(60)}) Tj ET".encode()
        objs.append(f"<< /Length {len(c)} >>\nstream\n".encode() + c + b"\nendstream")
        img = rnd.randbytes(per)
        objs.append(f"<< /Type /XObject /Subtype /Image /Width 1600 /Height 1200 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode /Length {per} >>\nstream\n".encode() + img + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    return assemble(objs)

def zipped(parts, media, size):
    def build(sizes):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
            for k, v in parts.items(): z.writestr(k, v)
            for i, s in enumerate(sizes):
                z.writestr(zipfile.ZipInfo(f"{media}image{i + 1:03d}.jpeg"), rnd.randbytes(s), compress_type=zipfile.ZIP_STORED)
        return b.getvalue()
    base = len(build([]))
    room = size - base
    if room <= 0: return build([])
    count = (room + (2 << 20) - 1) // (2 << 20)
    each = max(0, (room - count * 140) // count)
    sizes = [each] * count
    d = build(sizes); sizes[-1] = max(0, sizes[-1] + size - len(d))
    return build(sizes)

def docx(size):
    body = ['<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>']
    n = 0
    while n < size // 5 * 2:
        p = '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % line(300 + rnd.randrange(300), True)
        body.append(p); n += len(p)
    body.append("</w:body></w:document>")
    return zipped({"[Content_Types].xml": "<Types/>", "word/document.xml": "".join(body)}, "word/media/", size)

def pptx(size):
    parts = {"[Content_Types].xml": "<Types/>"}; written = 0; s = 1
    while written < size // 10:
        x = '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree>' + "".join(
            '<p:sp><p:txBody><a:p><a:r><a:rPr lang="en-US"/><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp>' % line(120, True) for _ in range(8)) + "</p:spTree></p:cSld></p:sld>"
        nt = '<p:notes xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>%s</a:t></a:r></a:p></p:notes>' % line(400, True)
        parts[f"ppt/slides/slide{s}.xml"] = x; parts[f"ppt/notesSlides/notesSlide{s}.xml"] = nt
        written += len(x) + len(nt); s += 1
    return zipped(parts, "ppt/media/", size)

def xlsx(size):
    pool = 20000
    shared = '<sst count="%d">' % pool + "".join("<si><t>%s</t></si>" % line(4 + rnd.randrange(20), True) for _ in range(pool)) + "</sst>"
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/workbook.xml", '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", shared)
        with z.open("xl/worksheets/sheet1.xml", "w") as sh:
            sh.write(b"<worksheet><sheetData>")
            row = 1; cols = "ABCDEFGH"
            while b.tell() < size - (160 << 10):
                r = ['<row r="%d">' % row]
                for c, L in enumerate(cols):
                    ref = f"{L}{row}"
                    if c in (0, 3, 6): r.append(f'<c r="{ref}" t="s"><v>{rnd.randrange(pool)}</v></c>')
                    elif c == 1: r.append(f'<c r="{ref}"><v>{rnd.randrange(1000000)}</v></c>')
                    elif c == 5: r.append(f'<c r="{ref}" s="2"><v>{40000 + rnd.randrange(10000)}</v></c>')
                    else: r.append(f'<c r="{ref}" s="1"><v>{rnd.randrange(100000)}.{rnd.randrange(100)}</v></c>')
                r.append("</row>"); sh.write("".join(r).encode()); row += 1
            sh.write(b"</sheetData></worksheet>")
    return b.getvalue()

w(f"text-{MIB}.bin", text(SIZE))
w(f"pdf-text-{MIB}.bin", textpdf_to(SIZE))
w("pdf-500.bin", pdf(lambda i, c={}: c.setdefault(i, textpage(i)), 500))
w(f"pdf-image-{MIB}.bin", imagepdf(SIZE))
w(f"docx-{MIB}.bin", docx(SIZE))
w(f"xlsx-{MIB}.bin", xlsx(SIZE))
w(f"pptx-{MIB}.bin", pptx(SIZE))
