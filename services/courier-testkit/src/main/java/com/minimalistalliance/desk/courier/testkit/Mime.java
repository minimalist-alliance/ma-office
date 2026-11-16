package com.minimalistalliance.desk.courier.testkit;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;

/**
 * Writing MIME by hand, for the generator and the limit samples: entities (headers, then a body or children), the
 * transfer encodings, RFC 2047 encoded words, RFC 2231 parameters and dates. Every line ends CRLF unless a sample changes
 * that afterwards. Nothing here reads the clock or the default locale.
 */
final class Mime {

    static final String CRLF = "\r\n";
    private static final byte[] CRLF_BYTES = {'\r', '\n'};

    private Mime() {
    }

    /** A MIME entity being written: header lines, then a leaf's encoded body or a multipart's children. */
    static final class Entity {
        final List<String> headers = new ArrayList<>();
        byte[] body;
        String boundary;
        String preamble;
        String epilogue;
        final List<Entity> children = new ArrayList<>();

        /** A header, written as given (UTF-8, so RFC 6532 headers come out raw). */
        Entity header(String name, String value) {
            headers.add(name + ": " + value);
            return this;
        }

        Entity body(byte[] encoded) {
            this.body = encoded;
            return this;
        }

        Entity body(String ascii) {
            return body(ascii.getBytes(StandardCharsets.UTF_8));
        }

        /** Makes this a multipart: {@code Content-Type: multipart/<subtype>; boundary="..."} plus any extra parameters. */
        Entity multipart(String subtype, String boundary, String extraParams) {
            this.boundary = boundary;
            return header("Content-Type", "multipart/" + subtype + "; boundary=\"" + boundary + "\"" + (extraParams == null ? "" : extraParams));
        }

        Entity add(Entity child) {
            children.add(child);
            return this;
        }

        byte[] bytes() {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            writeTo(out);
            byte[] b = out.toByteArray();
            if (boundary == null && b.length > 0 && b[b.length - 1] != '\n') {
                out.writeBytes(CRLF_BYTES);
                b = out.toByteArray();
            }
            return b;
        }

        void writeTo(ByteArrayOutputStream out) {
            for (String h : headers) {
                out.writeBytes(h.getBytes(StandardCharsets.UTF_8));
                out.writeBytes(CRLF_BYTES);
            }
            out.writeBytes(CRLF_BYTES);
            if (boundary == null) {
                if (body != null) {
                    out.writeBytes(body);
                }
                return;
            }
            if (preamble != null) {
                out.writeBytes(preamble.getBytes(StandardCharsets.UTF_8));
                out.writeBytes(CRLF_BYTES);
            }
            for (Entity child : children) {
                out.writeBytes(("--" + boundary + CRLF).getBytes(StandardCharsets.US_ASCII));
                child.writeTo(out);
                out.writeBytes(CRLF_BYTES);
            }
            out.writeBytes(("--" + boundary + "--" + CRLF).getBytes(StandardCharsets.US_ASCII));
            if (epilogue != null) {
                out.writeBytes(epilogue.getBytes(StandardCharsets.UTF_8));
                out.writeBytes(CRLF_BYTES);
            }
        }
    }

    /** Base64 in lines of {@code lineLength} (a multiple of 4) joined by CRLF, or one line when it's 0. */
    static byte[] base64(byte[] data, int lineLength) {
        return lineLength <= 0 ? Base64.getEncoder().encode(data) : Base64.getMimeEncoder(lineLength, CRLF_BYTES).encode(data);
    }

    /**
     * Quoted-printable (RFC 2045 §6.7). With {@code text}, CRLF in the data are hard line breaks and stay; otherwise every
     * byte is data and CR and LF are encoded. Lines are soft-broken at 76.
     */
    static byte[] quotedPrintable(byte[] data, boolean text) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(data.length + data.length / 3 + 16);
        int col = 0;
        for (int i = 0; i < data.length; i++) {
            int b = data[i] & 0xff;
            if (text && b == '\r' && i + 1 < data.length && data[i + 1] == '\n') {
                out.writeBytes(CRLF_BYTES);
                col = 0;
                i++;
                continue;
            }
            boolean lineEnd = text && (i + 1 == data.length || (data[i + 1] == '\r' && i + 2 < data.length && data[i + 2] == '\n'));
            boolean literal = (b >= 33 && b <= 126 && b != '=') || ((b == ' ' || b == '\t') && !lineEnd);
            int width = literal ? 1 : 3;
            if (col + width > 75) {
                out.writeBytes(new byte[] {'=', '\r', '\n'});
                col = 0;
            }
            if (literal) {
                out.write(b);
            } else {
                out.write('=');
                out.write(HEX[b >> 4]);
                out.write(HEX[b & 15]);
            }
            col += width;
        }
        return out.toByteArray();
    }

    private static final byte[] HEX = "0123456789ABCDEF".getBytes(StandardCharsets.US_ASCII);

    /**
     * {@code text} as RFC 2047 encoded words in {@code charset}, each at most 75 characters and whole characters only,
     * joined by CRLF and a space, so a reader drops the folds and the spaces between them. {@code b} picks B or Q.
     */
    static String encodedWords(String text, Charset charset, String label, boolean b) {
        int max = 75 - label.length() - 7;
        int[] cps = text.codePoints().toArray();
        List<String> words = new ArrayList<>();
        int start = 0;
        while (start < cps.length) {
            int end = start + 1;
            String best = payload(cps, start, end, charset, b);
            while (end < cps.length) {
                String next = payload(cps, start, end + 1, charset, b);
                if (next.length() > max) {
                    break;
                }
                best = next;
                end++;
            }
            words.add("=?" + label + "?" + (b ? "B" : "Q") + "?" + best + "?=");
            start = end;
        }
        return String.join(CRLF + " ", words);
    }

    private static String payload(int[] cps, int from, int to, Charset charset, boolean b) {
        byte[] bytes = new String(cps, from, to - from).getBytes(charset);
        if (b) {
            return Base64.getEncoder().encodeToString(bytes);
        }
        StringBuilder q = new StringBuilder();
        for (byte x : bytes) {
            int c = x & 0xff;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '!' || c == '*' || c == '+'
                    || c == '-' || c == '/') {
                q.append((char) c);
            } else if (c == ' ') {
                q.append('_');
            } else {
                q.append('=').append((char) HEX[c >> 4]).append((char) HEX[c & 15]);
            }
        }
        return q.toString();
    }

    /**
     * An RFC 2231 parameter, {@code ; name*=charset''value}, split into {@code name*0*}, {@code name*1*} and so on past
     * {@code chunk} characters, each on its own folded line.
     */
    static String rfc2231(String name, String value, Charset charset, String label, int chunk) {
        StringBuilder pct = new StringBuilder();
        List<Integer> cuts = new ArrayList<>();
        for (byte x : value.getBytes(charset)) {
            int c = x & 0xff;
            cuts.add(pct.length());
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || "!#$&+-.^_`|~".indexOf(c) >= 0) {
                pct.append((char) c);
            } else {
                pct.append('%').append((char) HEX[c >> 4]).append((char) HEX[c & 15]);
            }
        }
        String all = pct.toString();
        if (all.length() <= chunk) {
            return ";" + CRLF + "\t" + name + "*=" + label + "''" + all;
        }
        // Cut only where a byte's encoding starts, so no %XX is split.
        cuts.add(all.length());
        List<String> pieces = new ArrayList<>();
        int start = 0;
        int last = 0;
        for (int cut : cuts) {
            if (cut - start > chunk && last > start) {
                pieces.add(all.substring(start, last));
                start = last;
            }
            last = cut;
        }
        pieces.add(all.substring(start));
        StringBuilder out = new StringBuilder();
        for (int n = 0; n < pieces.size(); n++) {
            out.append(";").append(CRLF).append("\t").append(name).append("*").append(n).append("*=")
                    .append(n == 0 ? label + "''" : "").append(pieces.get(n));
        }
        return out.toString();
    }

    private static final String[] DAYS = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"};
    private static final String[] MONTHS = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

    /** An RFC 5322 date, {@code Mon, 2 Nov 2026 09:00:00 +0100}, for an instant and an offset in minutes. */
    static String date(long epochSecond, int offsetMinutes) {
        java.time.OffsetDateTime t = java.time.Instant.ofEpochSecond(epochSecond)
                .atOffset(java.time.ZoneOffset.ofTotalSeconds(offsetMinutes * 60));
        int abs = Math.abs(offsetMinutes);
        return DAYS[t.getDayOfWeek().getValue() - 1] + ", " + t.getDayOfMonth() + " " + MONTHS[t.getMonthValue() - 1] + " "
                + t.getYear() + " " + two(t.getHour()) + ":" + two(t.getMinute()) + ":" + two(t.getSecond()) + " "
                + (offsetMinutes < 0 ? "-" : "+") + two(abs / 60) + two(abs % 60);
    }

    private static String two(int n) {
        return n < 10 ? "0" + n : Integer.toString(n);
    }

    /** HTML text: {@code &}, {@code <}, {@code >} and {@code "} escaped, nothing else. */
    static String escapeHtml(String s) {
        StringBuilder out = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&' -> out.append("&amp;");
                case '<' -> out.append("&lt;");
                case '>' -> out.append("&gt;");
                case '"' -> out.append("&quot;");
                default -> out.append(c);
            }
        }
        return out.toString();
    }

    static String lower(String s) {
        return s.toLowerCase(Locale.ROOT);
    }
}
