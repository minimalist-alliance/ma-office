package com.minimalistalliance.desk.courier.testkit;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Expect;
import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Sample;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.SplittableRandom;

/** The samples at and past the parser's limits, built on demand: {@link MimeCorpus#large} and the rest. */
final class Limits {

    private Limits() {
    }

    private static final String DATE = "Mon, 2 Nov 2026 09:00:00 +0000";

    /**
     * A multipart/mixed of a short text part and one base64 attachment, exactly {@code bytes} long: the attachment is as
     * large as fits, and the text takes the few bytes left over.
     */
    static Sample large(int bytes) {
        String boundary = "=_large_" + bytes;
        String head = "From: Archive <archive@example.com>\r\nTo: me@desk.example\r\nSubject: A large message\r\nDate: " + DATE
                + "\r\nMessage-ID: <large-" + bytes + "@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\""
                + boundary + "\"\r\n\r\n--" + boundary + "\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\nThe archive is attached.\r\n";
        String mid = "\r\n--" + boundary + "\r\nContent-Type: application/octet-stream; name=\"archive.bin\"\r\n"
                + "Content-Disposition: attachment; filename=\"archive.bin\"\r\nContent-Transfer-Encoding: base64\r\n\r\n";
        String tail = "\r\n--" + boundary + "--\r\n";
        long room = (long) bytes - head.length() - mid.length() - tail.length();
        if (room < 0) {
            throw new IllegalArgumentException("a large sample is at least " + (bytes - room) + " bytes");
        }
        // The largest attachment whose base64 fits; what's left (under one line's worth) pads the text.
        long lo = 0;
        long hi = room;
        while (lo < hi) {
            long mid1 = (lo + hi + 1) >>> 1;
            if (base64Length(mid1) <= room) {
                lo = mid1;
            } else {
                hi = mid1 - 1;
            }
        }
        int raw = (int) lo;
        int pad = (int) (room - base64Length(raw));
        byte[] out = new byte[bytes];
        int at = put(out, 0, head);
        for (int i = 0; i < pad; i++) {
            out[at++] = 'x';
        }
        at = put(out, at, mid);
        at = base64Into(out, at, raw, new SplittableRandom(0x6c61726765L));
        at = put(out, at, tail);
        if (at != bytes) {
            throw new IllegalStateException("built " + at + " bytes, not " + bytes);
        }
        Expect expect = bytes <= MimeCorpus.MAX_BYTES ? Expect.read("A large message", "archive@example.com", 1, "archive")
                : Expect.refused(MimeCorpus.TOO_LARGE);
        return new Sample(bytes == MimeCorpus.MAX_BYTES + 1 ? "over-limit" : "large-" + bytes, "limits", out, expect);
    }

    /** Base64 of {@code n} bytes in lines of 76 joined by CRLF, with no CRLF after the last. */
    static long base64Length(long n) {
        if (n == 0) {
            return 0;
        }
        long chars = 4 * ((n + 2) / 3);
        return chars + 2 * ((chars + 75) / 76 - 1);
    }

    /** {@code n} filler bytes from {@code rnd} as base64 lines, written straight into {@code out} a block at a time. */
    private static int base64Into(byte[] out, int at, int n, SplittableRandom rnd) {
        Base64.Encoder enc = Base64.getMimeEncoder(76, new byte[] {'\r', '\n'});
        int block = 57 * 1024;
        byte[] buf = new byte[block];
        for (int done = 0; done < n; done += block) {
            int len = Math.min(block, n - done);
            byte[] chunk = len == block ? buf : new byte[len];
            for (int i = 0; i < len; i++) {
                chunk[i] = (byte) rnd.nextInt(256);
            }
            if (done > 0) {
                out[at++] = '\r';
                out[at++] = '\n';
            }
            // A whole block is a whole number of lines (57 bytes a line), so blocks join with a plain CRLF.
            byte[] encoded = enc.encode(chunk);
            System.arraycopy(encoded, 0, out, at, encoded.length);
            at += encoded.length;
        }
        return at;
    }

    private static int put(byte[] out, int at, String ascii) {
        byte[] b = ascii.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(b, 0, out, at, b.length);
        return at + b.length;
    }

    /** {@code depth} multiparts each inside the last, a text part at the bottom. */
    static Sample deep(int depth) {
        if (depth < 1 || depth > 1000) {
            throw new IllegalArgumentException("depth " + depth + ": 1 to 1,000");
        }
        StringBuilder s = new StringBuilder("From: Nest <nest@example.com>\r\nTo: me@desk.example\r\nSubject: Nested " + depth
                + " deep\r\nDate: " + DATE + "\r\nMessage-ID: <deep-" + depth + "@example.com>\r\nMIME-Version: 1.0\r\n"
                + "Content-Type: multipart/mixed; boundary=\"" + level(0) + "\"\r\n\r\n");
        for (int i = 1; i < depth; i++) {
            s.append("--").append(level(i - 1)).append("\r\nContent-Type: multipart/mixed; boundary=\"").append(level(i)).append("\"\r\n\r\n");
        }
        s.append("--").append(level(depth - 1)).append("\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\nThe bottom of the nest.\r\n");
        for (int i = depth - 1; i >= 0; i--) {
            s.append("--").append(level(i)).append("--\r\n");
        }
        Expect expect = depth <= MimeCorpus.MAX_DEPTH ? Expect.read("Nested " + depth + " deep", "nest@example.com", 0, "bottom")
                : Expect.refused(MimeCorpus.TOO_DEEP);
        return new Sample("too-deep-" + depth, "limits", s.toString().getBytes(StandardCharsets.US_ASCII), expect);
    }

    /** Boundaries no one of which starts another ("nest-1-" is not the start of "nest-10-"). */
    private static String level(int i) {
        return "nest-" + i + "-end";
    }

    /** Exactly {@code parts} MIME parts: the message, its multipart, a text part and attachments of one byte each. */
    static Sample many(int parts) {
        if (parts < 1 || parts > 50_000) {
            throw new IllegalArgumentException("parts " + parts + ": 1 to 50,000");
        }
        String head = "From: Many <many@example.com>\r\nTo: me@desk.example\r\nSubject: Parts " + parts + "\r\nDate: " + DATE
                + "\r\nMessage-ID: <parts-" + parts + "@example.com>\r\nMIME-Version: 1.0\r\n";
        String text = "Small files follow, one byte each.";
        StringBuilder s = new StringBuilder(head);
        if (parts == 1) {
            s.append("Content-Type: text/plain; charset=us-ascii\r\n\r\n").append(text).append("\r\n");
        } else {
            s.append("Content-Type: multipart/mixed; boundary=\"=_many\"\r\n\r\n--=_many\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\n")
                    .append(text).append("\r\n");
            for (int i = 0; i < parts - 2; i++) {
                s.append("--=_many\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"f")
                        .append(i).append(".bin\"\r\n\r\nx\r\n");
            }
            s.append("--=_many--\r\n");
        }
        Expect expect = parts <= MimeCorpus.MAX_PARTS ? Expect.read("Parts " + parts, "many@example.com", Math.max(0, parts - 2), "small")
                : Expect.refused(MimeCorpus.TOO_MANY_PARTS);
        return new Sample("too-many-parts-" + parts, "limits", s.toString().getBytes(StandardCharsets.US_ASCII), expect);
    }
}
