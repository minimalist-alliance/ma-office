package com.minimalistalliance.desk.courier.testkit;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.List;
import java.util.Locale;

/**
 * The IMAP wire for {@link FakeImapServer}: reading a command with its literals, tokens, sequence sets, quoting, modified
 * UTF-7 mailbox names and dates. RFC 3501's grammar, read a little more leniently than it's written.
 */
final class ImapWire {

    /** Stands in a command's text for a literal, which is kept apart as bytes. A command line can't hold a NUL. */
    static final char LITERAL = '\u0000';

    static final DateTimeFormatter INTERNALDATE = DateTimeFormatter.ofPattern("dd-MMM-yyyy HH:mm:ss xx", Locale.ENGLISH);

    private static final DateTimeFormatter DATE_TIME_IN = new DateTimeFormatterBuilder().parseCaseInsensitive()
        .appendPattern("d-MMM-yyyy HH:mm:ss xx").toFormatter(Locale.ENGLISH);

    private static final DateTimeFormatter DATE_IN = new DateTimeFormatterBuilder().parseCaseInsensitive()
        .appendPattern("d-MMM-yyyy").toFormatter(Locale.ENGLISH);

    private ImapWire() {
    }

    /** A malformed or unsupported command: a tagged BAD. */
    static final class Bad extends RuntimeException {
        Bad(String message) {
            super(message, null, false, false);
        }
    }

    /** The command line is longer than the server's limit. */
    static final class LineTooLong extends IOException {
        LineTooLong() {
            super("line too long");
        }
    }

    /** One command as read: its text with {@link #LITERAL} for each literal, the literals in order. */
    record Command(String text, List<byte[]> literals, boolean nonSyncRefused) {
    }

    /** What the server says when a literal is announced: go on, refuse it (tagged NO), or end the connection. */
    interface LiteralGate {
        /** Returns null to read it, or a tagged response's text (after the tag) to refuse a synchronizing one. */
        String announce(String textSoFar, long size, boolean nonSync) throws IOException;
    }

    /** A synchronizing literal refused before it was sent: answer the tag and read the next command. */
    static final class Refused extends IOException {
        final String tag;
        final String response;

        Refused(String tag, String response) {
            super(response);
            this.tag = tag;
            this.response = response;
        }
    }

    /** Reads commands (and lines, for IDLE's DONE and AUTHENTICATE's response) from a client. */
    static final class Reader {
        private final InputStream in;
        private final int maxLine;

        Reader(InputStream in, int maxLine) {
            this.in = in;
            this.maxLine = maxLine;
        }

        /** One line without its CRLF (a bare LF is taken too), or null at the end of the stream. */
        String line() throws IOException {
            ByteArrayOutputStream buf = new ByteArrayOutputStream(64);
            while (true) {
                int c = in.read();
                if (c == -1) {
                    return null;
                }
                if (c == '\n') {
                    byte[] b = buf.toByteArray();
                    int n = b.length;
                    if (n > 0 && b[n - 1] == '\r') {
                        n--;
                    }
                    return new String(b, 0, n, StandardCharsets.UTF_8);
                }
                if (buf.size() >= maxLine) {
                    throw new LineTooLong();
                }
                buf.write(c);
            }
        }

        /** One command, its literals read; null at the end of the stream. */
        Command command(LiteralGate gate) throws IOException {
            String line = line();
            if (line == null) {
                return null;
            }
            StringBuilder text = new StringBuilder();
            List<byte[]> literals = new ArrayList<>();
            boolean nonSyncRefused = false;
            while (true) {
                int open = literalStart(line);
                if (open < 0) {
                    text.append(line);
                    return new Command(text.toString(), literals, nonSyncRefused);
                }
                boolean nonSync = line.charAt(line.length() - 2) == '+';
                String digits = line.substring(open + 1, line.length() - (nonSync ? 2 : 1));
                long size;
                try {
                    size = Long.parseLong(digits);
                } catch (NumberFormatException e) {
                    throw new LineTooLong();
                }
                text.append(line, 0, open);
                String refusal = gate.announce(text.toString(), size, nonSync);
                if (refusal != null) {
                    if (nonSync) {
                        // The bytes come anyway: read and drop them, then answer BAD once the command is read.
                        in.skipNBytes(size);
                        nonSyncRefused = true;
                        text.append(LITERAL);
                        literals.add(new byte[0]);
                    } else {
                        String t = text.toString();
                        int sp = t.indexOf(' ');
                        throw new Refused(sp > 0 ? t.substring(0, sp) : "*", refusal);
                    }
                } else {
                    byte[] data = in.readNBytes((int) size);
                    if (data.length < size) {
                        return null;
                    }
                    text.append(LITERAL);
                    literals.add(data);
                }
                line = line();
                if (line == null) {
                    return null;
                }
            }
        }

        /** Where a trailing {n} or {n+} starts, outside a quoted string; -1 if the line doesn't end with one. */
        static int literalStart(String line) {
            int n = line.length();
            if (n < 3 || line.charAt(n - 1) != '}') {
                return -1;
            }
            int i = n - 2;
            if (line.charAt(i) == '+') {
                i--;
            }
            int end = i;
            while (i >= 0 && Character.isDigit(line.charAt(i))) {
                i--;
            }
            if (i < 0 || i == end || line.charAt(i) != '{') {
                return -1;
            }
            boolean quoted = false;
            for (int j = 0; j < i; j++) {
                char c = line.charAt(j);
                if (quoted && c == '\\') {
                    j++;
                } else if (c == '"') {
                    quoted = !quoted;
                }
            }
            return quoted ? -1 : i;
        }
    }

    /** Walks one command's text. Words stop at a space or a parenthesis, except inside [ ], where both are kept. */
    static final class Tokens {
        private final String s;
        private final List<byte[]> literals;
        private int pos;
        private int literal;

        Tokens(Command c) {
            this.s = c.text();
            this.literals = c.literals();
        }

        boolean atEnd() {
            return pos >= s.length();
        }

        char peek() {
            return atEnd() ? '\n' : s.charAt(pos);
        }

        void sp() {
            expect(' ');
        }

        void expect(char c) {
            if (peek() != c) {
                throw new Bad(atEnd() ? "Missing arguments" : "Expected '" + c + "' at " + pos);
            }
            pos++;
        }

        boolean skip(char c) {
            if (peek() == c) {
                pos++;
                return true;
            }
            return false;
        }

        void end() {
            if (!atEnd()) {
                throw new Bad("Unexpected arguments: " + s.substring(pos).replace(LITERAL, '?'));
            }
        }

        /** An atom-like word: a flag, a number, a sequence set, a fetch item with its [section] and partial. */
        String word() {
            int start = pos;
            int depth = 0;
            while (pos < s.length()) {
                char c = s.charAt(pos);
                if (c == '[') {
                    depth++;
                } else if (c == ']') {
                    depth = Math.max(0, depth - 1);
                } else if (depth == 0 && (c == ' ' || c == '(' || c == ')' || c == '"' || c == LITERAL)) {
                    break;
                } else if (c < 0x20 && c != LITERAL) {
                    break;
                }
                pos++;
            }
            if (pos == start) {
                throw new Bad(atEnd() ? "Missing arguments" : "Expected a word at " + start);
            }
            return s.substring(start, pos);
        }

        /** The next word, upper case, without taking it; "" if there's none. */
        String peekWord() {
            int save = pos;
            try {
                return word();
            } catch (Bad e) {
                return "";
            } finally {
                pos = save;
            }
        }

        long number() {
            String w = word();
            try {
                long v = Long.parseLong(w);
                if (v < 0 || w.startsWith("+")) {
                    throw new Bad("Not a number: " + w);
                }
                return v;
            } catch (NumberFormatException e) {
                throw new Bad("Not a number: " + w);
            }
        }

        /** An astring: an atom, a quoted string or a literal (as UTF-8). */
        String astring() {
            char c = peek();
            if (c == '"') {
                return quoted();
            }
            if (c == LITERAL) {
                return new String(literalBytes(), StandardCharsets.UTF_8);
            }
            return word();
        }

        /** A quoted string or a literal, not an atom. */
        String string() {
            char c = peek();
            if (c == '"') {
                return quoted();
            }
            if (c == LITERAL) {
                return new String(literalBytes(), StandardCharsets.UTF_8);
            }
            throw new Bad("Expected a string at " + pos);
        }

        boolean atLiteral() {
            return peek() == LITERAL;
        }

        byte[] literalBytes() {
            expect(LITERAL);
            return literals.get(literal++);
        }

        String quoted() {
            expect('"');
            StringBuilder b = new StringBuilder();
            while (true) {
                if (atEnd()) {
                    throw new Bad("Unterminated quoted string");
                }
                char c = s.charAt(pos++);
                if (c == '"') {
                    return b.toString();
                }
                if (c == '\\') {
                    if (atEnd()) {
                        throw new Bad("Unterminated quoted string");
                    }
                    char d = s.charAt(pos++);
                    if (d != '\\' && d != '"') {
                        throw new Bad("Bad escape in quoted string");
                    }
                    b.append(d);
                } else if (c == LITERAL) {
                    throw new Bad("Bad quoted string");
                } else {
                    b.append(c);
                }
            }
        }

        /** A parenthesized list: each item a String (word, quoted or literal) or a nested List. */
        List<Object> list() {
            expect('(');
            List<Object> out = new ArrayList<>();
            if (skip(')')) {
                return out;
            }
            while (true) {
                char c = peek();
                if (c == '(') {
                    out.add(list());
                } else if (c == '"' || c == LITERAL) {
                    out.add(string());
                } else {
                    out.add(word());
                }
                if (skip(')')) {
                    return out;
                }
                sp();
            }
        }
    }

    /** An IMAP sequence set: numbers and ranges, with {@code *} as {@link #STAR}. */
    record SeqSet(List<long[]> ranges) {
        static final long STAR = -1;

        static SeqSet parse(String text) {
            List<long[]> ranges = new ArrayList<>();
            if (text.isEmpty()) {
                throw new Bad("Empty sequence set");
            }
            for (String part : text.split(",", -1)) {
                int colon = part.indexOf(':');
                if (colon < 0) {
                    long v = value(part);
                    ranges.add(new long[] {v, v});
                } else {
                    ranges.add(new long[] {value(part.substring(0, colon)), value(part.substring(colon + 1))});
                }
            }
            return new SeqSet(ranges);
        }

        static boolean looksLike(String text) {
            if (text.isEmpty()) {
                return false;
            }
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (!(Character.isDigit(c) || c == ':' || c == ',' || c == '*')) {
                    return false;
                }
            }
            return true;
        }

        private static long value(String v) {
            if (v.equals("*")) {
                return STAR;
            }
            try {
                long n = Long.parseLong(v);
                if (n <= 0 || n > 0xFFFFFFFFL || v.startsWith("+")) {
                    throw new Bad("Invalid sequence number: " + v);
                }
                return n;
            } catch (NumberFormatException e) {
                throw new Bad("Invalid sequence set: " + v);
            }
        }

        /** Whether {@code v} is in the set, {@code *} being {@code star} (the largest number in use). */
        boolean contains(long v, long star) {
            for (long[] r : ranges) {
                long a = r[0] == STAR ? star : r[0];
                long b = r[1] == STAR ? star : r[1];
                if (v >= Math.min(a, b) && v <= Math.max(a, b)) {
                    return true;
                }
            }
            return false;
        }

        /** The largest number named outright, {@code *} being {@code star}. */
        long max(long star) {
            long m = 0;
            for (long[] r : ranges) {
                m = Math.max(m, Math.max(r[0] == STAR ? star : r[0], r[1] == STAR ? star : r[1]));
            }
            return m;
        }

        boolean hasStar() {
            for (long[] r : ranges) {
                if (r[0] == STAR || r[1] == STAR) {
                    return true;
                }
            }
            return false;
        }
    }

    /** {@code 1:3,5,7:9}: runs of consecutive numbers merged, the order kept (COPYUID's two sets must match up). */
    static String set(Collection<Long> values) {
        StringBuilder b = new StringBuilder();
        long start = -1;
        long prev = -1;
        for (long v : values) {
            if (start >= 0 && v == prev + 1) {
                prev = v;
                continue;
            }
            appendRun(b, start, prev);
            start = v;
            prev = v;
        }
        appendRun(b, start, prev);
        return b.toString();
    }

    private static void appendRun(StringBuilder b, long start, long end) {
        if (start < 0) {
            return;
        }
        if (!b.isEmpty()) {
            b.append(',');
        }
        b.append(start);
        if (end != start) {
            b.append(':').append(end);
        }
    }

    /** A string as an atom when it can be one, else quoted; a literal when it holds CR, LF or 8-bit characters. */
    static String astring(String v) {
        if (isAtom(v)) {
            return v;
        }
        return quote(v);
    }

    static boolean isAtom(String v) {
        if (v.isEmpty() || v.equalsIgnoreCase("NIL")) {
            return false;
        }
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c <= 0x20 || c >= 0x7f || "(){%*\"\\]".indexOf(c) >= 0) {
                return false;
            }
        }
        return true;
    }

    /** A quoted string, or a literal when the text can't be quoted. */
    static String quote(String v) {
        boolean literal = false;
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '\r' || c == '\n' || c == 0 || c >= 0x7f) {
                literal = true;
                break;
            }
        }
        if (literal) {
            byte[] b = v.getBytes(StandardCharsets.UTF_8);
            return "{" + b.length + "}\r\n" + v;
        }
        return "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    /** A mailbox name on the wire: modified UTF-7, then an astring. */
    static String mailbox(String name) {
        return astring(encodeMailbox(name));
    }

    /** RFC 3501 section 5.1.3's modified UTF-7. */
    static String encodeMailbox(String name) {
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < name.length()) {
            char c = name.charAt(i);
            if (c >= 0x20 && c <= 0x7e) {
                out.append(c == '&' ? "&-" : String.valueOf(c));
                i++;
                continue;
            }
            int j = i;
            while (j < name.length() && (name.charAt(j) < 0x20 || name.charAt(j) > 0x7e)) {
                j++;
            }
            byte[] utf16 = name.substring(i, j).getBytes(StandardCharsets.UTF_16BE);
            String b64 = Base64.getEncoder().withoutPadding().encodeToString(utf16).replace('/', ',');
            out.append('&').append(b64).append('-');
            i = j;
        }
        return out.toString();
    }

    static String decodeMailbox(String wire) {
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < wire.length()) {
            char c = wire.charAt(i);
            if (c != '&') {
                out.append(c);
                i++;
                continue;
            }
            int end = wire.indexOf('-', i);
            if (end < 0) {
                throw new Bad("Invalid modified UTF-7 in mailbox name");
            }
            if (end == i + 1) {
                out.append('&');
            } else {
                String b64 = wire.substring(i + 1, end).replace(',', '/');
                try {
                    byte[] bytes = Base64.getDecoder().decode(b64);
                    if (bytes.length % 2 != 0) {
                        throw new Bad("Invalid modified UTF-7 in mailbox name");
                    }
                    out.append(StandardCharsets.UTF_16BE.decode(ByteBuffer.wrap(bytes)));
                } catch (IllegalArgumentException e) {
                    throw new Bad("Invalid modified UTF-7 in mailbox name");
                }
            }
            i = end + 1;
        }
        return out.toString();
    }

    static OffsetDateTime parseDateTime(String v) {
        try {
            return OffsetDateTime.parse(v.trim(), DATE_TIME_IN);
        } catch (DateTimeParseException e) {
            throw new Bad("Invalid date-time: " + v);
        }
    }

    static LocalDate parseDate(String v) {
        try {
            return LocalDate.parse(v.trim(), DATE_IN);
        } catch (DateTimeParseException e) {
            throw new Bad("Invalid date: " + v);
        }
    }

    /** {@code (a b c)} */
    static String parenthesized(Collection<String> items) {
        return "(" + String.join(" ", items) + ")";
    }
}
