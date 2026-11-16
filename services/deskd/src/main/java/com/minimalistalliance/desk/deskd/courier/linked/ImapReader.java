package com.minimalistalliance.desk.deskd.courier.linked;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Reads an IMAP server's responses (RFC 3501 §7, §9) into {@link Response}s: atoms, strings (quoted or literal, as bytes),
 * parenthesized lists and NIL. The server is the member's provider, and the member may name any host, so every size is
 * bounded before anything is allocated: a line (outside literals), the items on it, a literal (read as its bytes arrive,
 * never allocated on its header alone), a list's depth, the UIDs a command's sets may name, and the bytes a command's
 * responses may bring in all ({@link #allow}), past which the connection is dropped. A line that carries UIDs
 * ({@code SEARCH}, {@code ESEARCH}, {@code VANISHED}) may be longer, and its numbers and sets are read straight into
 * {@code long[]}s, so a million UIDs are 8 MB, not a million strings (Security's CI-M1). Nothing here parses mail: a
 * message is a literal's bytes, handed on whole.
 */
final class ImapReader {

    /** IMAP's NIL. */
    static final Object NIL = new Object() {
        @Override
        public String toString() {
            return "NIL";
        }
    };

    /** A response the server sent: a status ({@code OK}, {@code NO}, {@code BAD}, {@code BYE}, {@code PREAUTH}) or data. */
    record Response(String tag, String status, String code, List<Object> codeArgs, String text, List<Object> items) {

        boolean untagged() {
            return "*".equals(tag);
        }

        boolean continuation() {
            return "+".equals(tag);
        }

        /** For data: the first word, or the second after a number ({@code 3 EXISTS}, {@code 5 FETCH}). */
        String kind() {
            if (items.isEmpty()) {
                return status;
            }
            Object first = items.get(0);
            if (first instanceof String s && ImapReader.number(s) >= 0 && items.size() > 1 && items.get(1) instanceof String k) {
                return k.toUpperCase(Locale.ROOT);
            }
            return first instanceof String s ? s.toUpperCase(Locale.ROOT) : null;
        }

        /** The number before the kind ({@code 3} of {@code 3 EXISTS}); -1 for none. */
        long number() {
            return !items.isEmpty() && items.get(0) instanceof String s ? ImapReader.number(s) : -1;
        }

        /** No content in logs. */
        @Override
        public String toString() {
            return "Response[" + tag + " " + (status != null ? status : kind()) + (code != null ? " [" + code + "]" : "") + "]";
        }
    }

    static final int MAX_DEPTH = 16;
    /** Items on one response (outside a UID line's numbers): a FETCH, a LIST or a CAPABILITY has a few dozen. */
    static final int MAX_ITEMS = 100_000;
    /** A UID line's length: about 2 million UIDs written one by one. */
    static final int MAX_SET_LINE = 16 * 1024 * 1024;
    /** FETCH responses one command may hand on to be kept: more is windowed by the sync. */
    static final int MAX_FETCHES = 100_000;
    /** What the kept FETCHes of one command may hold on the heap, as {@link ImapClient#kept} estimates it (Security's CI-M1b). */
    static final long MAX_KEPT_BYTES = 16L * 1024 * 1024;
    /** A literal a command doesn't ask for (a folder name, a header field) is at most this; a body fetch says its own. */
    static final long LITERAL_DEFAULT = 1024 * 1024;

    private final InputStream in;
    private final byte[] buf = new byte[64 * 1024];
    private int pos;
    private int lim;
    private final int maxLine;
    private final int maxLiteral;
    /** Bytes the current command's responses may still bring; dropping the connection past it. */
    private long allowance = Long.MAX_VALUE;
    /** The largest literal the current command may bring. */
    private long literalCap = LITERAL_DEFAULT;
    /** UIDs the current command's sets may still name, across every response and response code. */
    private long uidsLeft = UidSet.MAX;
    /** FETCH responses the current command may still hand on to be kept, by count and by their estimated heap. */
    private int fetchesLeft = MAX_FETCHES;
    private long keptLeft = MAX_KEPT_BYTES;
    private long lineBytes;
    private long lineLimit;
    private int items;
    private long read;

    ImapReader(InputStream in, int maxLine, int maxLiteral) {
        this.in = in;
        this.maxLine = maxLine;
        this.lineLimit = maxLine;
        this.maxLiteral = maxLiteral;
    }

    /**
     * What the next command's responses may bring in all, literals included. It also starts the command's other budgets:
     * literals of at most {@link #LITERAL_DEFAULT} (a body fetch raises it, {@link #allowLiterals}) and {@link UidSet#MAX}
     * UIDs named in all.
     */
    void allow(long bytes) {
        this.allowance = bytes;
        this.literalCap = LITERAL_DEFAULT;
        this.uidsLeft = UidSet.MAX;
        this.fetchesLeft = MAX_FETCHES;
        this.keptLeft = MAX_KEPT_BYTES;
    }

    /**
     * Counts one FETCH response the command keeps, holding about {@code bytes} of heap: past {@link #MAX_FETCHES} or
     * {@link #MAX_KEPT_BYTES}, the connection goes.
     */
    void chargeFetch(long bytes) throws ImapException {
        keptLeft -= Math.max(0, bytes);
        if (--fetchesLeft < 0 || keptLeft < 0) {
            throw new ImapException.TooLarge();
        }
    }

    /** This command may bring literals up to {@code bytes} each (still within its allowance and the reader's largest). */
    void allowLiterals(long bytes) {
        this.literalCap = bytes;
    }

    /** UIDs the current command may still name. */
    long uidsLeft() {
        return uidsLeft;
    }

    /** Counts {@code n} UIDs against the current command's budget: past it, the connection goes. */
    void charge(long n) throws ImapException {
        uidsLeft -= n;
        if (uidsLeft < 0) {
            throw new ImapException.TooLarge();
        }
    }

    /** Bytes read since the connection opened. */
    long bytesRead() {
        return read;
    }

    /** Whether nothing of a response has been read yet: a timeout here leaves the connection in step. */
    boolean atStart() {
        return lineBytes == 0;
    }

    /** Whether a byte is already waiting, without blocking. */
    boolean ready() throws IOException {
        return pos < lim || in.available() > 0;
    }

    Response read() throws IOException {
        lineBytes = 0;
        lineLimit = maxLine;
        items = 0;
        String tag = atom();
        if (tag.isEmpty()) {
            throw new ImapException.Protocol("tag");
        }
        if (tag.equals("+")) {
            if (peek() == ' ') {
                next();
            }
            String text = restOfLine();
            return new Response(tag, null, null, List.of(), text, List.of());
        }
        expect(' ');
        String word = atom();
        String upper = word.toUpperCase(Locale.ROOT);
        if (upper.equals("OK") || upper.equals("NO") || upper.equals("BAD") || upper.equals("BYE") || upper.equals("PREAUTH")) {
            String code = null;
            List<Object> codeArgs = List.of();
            if (peek() == ' ') {
                next();
            }
            if (peek() == '[') {
                next();
                String inside = bracketed();
                ImapReader sub = new ImapReader(new java.io.ByteArrayInputStream((inside + "\r\n").getBytes(StandardCharsets.ISO_8859_1)),
                        maxLine, 0);
                code = sub.atom().toUpperCase(Locale.ROOT);
                codeArgs = sub.peek() == ' ' ? sub.itemsToEnd() : List.of();
                if (peek() == ' ') {
                    next();
                }
            }
            String text = restOfLine();
            return new Response(tag, upper, code, codeArgs, text, List.of());
        }
        List<Object> out = new ArrayList<>();
        out.add(word);
        if (upper.equals("SEARCH") || upper.equals("ESEARCH") || upper.equals("VANISHED")) {
            lineLimit = Math.max(maxLine, MAX_SET_LINE);
            out.addAll(uidLine(upper.equals("SEARCH")));
        } else {
            out.addAll(itemsToEnd());
        }
        return new Response(tag, null, null, List.of(), null, out);
    }

    /**
     * The rest of a line that carries UIDs: a set or number is a {@code long[]} (as listed; {@code SEARCH}'s numbers all in
     * one), anything else an item as usual. Each UID counts against the command's budget as it's read.
     */
    private List<Object> uidLine(boolean search) throws IOException {
        List<Object> out = new ArrayList<>();
        Longs numbers = search ? new Longs() : null;
        boolean modseq = false;
        while (true) {
            int c = peek();
            if (c == ' ') {
                next();
                continue;
            }
            if (modseq) {
                // ESEARCH's MODSEQ is a 63-bit number, not a UID (Security's CI-I5).
                modseq = false;
                out.add(item(0));
                continue;
            }
            if (c == '\r' || c == '\n') {
                endOfLine();
                if (numbers != null) {
                    out.add(0, numbers.toArray());
                }
                return out;
            }
            if (c >= '0' && c <= '9') {
                if (numbers != null) {
                    set(numbers);
                } else {
                    Longs one = new Longs();
                    set(one);
                    out.add(one.toArray());
                }
                continue;
            }
            Object it = item(0);
            modseq = it instanceof String w && w.equalsIgnoreCase("MODSEQ");
            out.add(it);
        }
    }

    /** A sequence set ({@code 1:5,7}) or a number, its UIDs added as listed; {@code *} isn't taken (a server names real UIDs). */
    private void set(Longs into) throws IOException {
        long a = -1;
        long cur = -1;
        while (true) {
            int c = peek();
            if (c >= '0' && c <= '9') {
                next();
                cur = (cur < 0 ? 0 : cur) * 10 + (c - '0');
                if (cur > 0xFFFFFFFFL) {
                    throw new ImapException.Protocol("set");
                }
                continue;
            }
            if (c == ':' && a < 0 && cur > 0) {
                next();
                a = cur;
                cur = -1;
                continue;
            }
            if (cur <= 0) {
                throw new ImapException.Protocol("set");
            }
            long lo = a < 0 ? cur : Math.min(a, cur);
            long hi = a < 0 ? cur : Math.max(a, cur);
            charge(hi - lo + 1);
            for (long u = lo; u <= hi; u++) {
                into.add(u);
            }
            if (c == ',') {
                next();
                a = -1;
                cur = -1;
                continue;
            }
            if (c == ' ' || c == '\r' || c == '\n') {
                return;
            }
            throw new ImapException.Protocol("set");
        }
    }

    /** A growable list of longs, 8 bytes each. */
    static final class Longs {
        private long[] a = new long[16];
        private int n;

        void add(long v) {
            if (n == a.length) {
                // Doubling while small, then 256 Ki at a time, so a big list holds little slack.
                a = java.util.Arrays.copyOf(a, a.length + Math.min(a.length, 1 << 18));
            }
            a[n++] = v;
        }

        void addAll(long[] v) {
            for (long x : v) {
                add(x);
            }
        }

        int size() {
            return n;
        }

        boolean isEmpty() {
            return n == 0;
        }

        void clear() {
            a = new long[16];
            n = 0;
        }

        long[] toArray() {
            return java.util.Arrays.copyOf(a, n);
        }
    }

    /** Items separated by spaces until the line's end (literals' bytes in between). */
    private List<Object> itemsToEnd() throws IOException {
        List<Object> out = new ArrayList<>();
        while (true) {
            int c = peek();
            if (c == ' ') {
                next();
                continue;
            }
            if (c == '\r' || c == '\n') {
                endOfLine();
                return out;
            }
            out.add(item(0));
        }
    }

    private Object item(int depth) throws IOException {
        if (++items > MAX_ITEMS) {
            throw new ImapException.TooLarge();
        }
        int c = peek();
        if (c == '(') {
            next();
            if (depth >= MAX_DEPTH) {
                throw new ImapException.Protocol("depth");
            }
            List<Object> list = new ArrayList<>();
            while (true) {
                int d = peek();
                if (d == ' ') {
                    next();
                    continue;
                }
                if (d == ')') {
                    next();
                    return list;
                }
                if (d == '\r' || d == '\n') {
                    throw new ImapException.Protocol("list");
                }
                list.add(item(depth + 1));
            }
        }
        if (c == '"') {
            next();
            return quoted();
        }
        if (c == '{' || c == '~') {
            if (c == '~') {
                next();
                if (peek() != '{') {
                    throw new ImapException.Protocol("literal8");
                }
            }
            next();
            return literal();
        }
        String a = atom();
        if (a.isEmpty()) {
            throw new ImapException.Protocol("item");
        }
        return a.equalsIgnoreCase("NIL") ? NIL : a;
    }

    /**
     * An atom, a number or a flag; a section in brackets is part of it ({@code BODY[HEADER.FIELDS (MESSAGE-ID)]<0>}), spaces
     * and parentheses inside included.
     */
    private String atom() throws IOException {
        StringBuilder out = new StringBuilder();
        while (true) {
            int c = peek();
            if (c < 0) {
                throw new EOFException();
            }
            if (c == ' ' || c == '(' || c == ')' || c == '\r' || c == '\n' || c == '"' || c == '{' && out.isEmpty()) {
                return out.toString();
            }
            if (c == ']' ) {
                // A stray ] ends nothing: a status response's code is read with bracketed().
                return out.toString();
            }
            next();
            out.append((char) c);
            if (c == '[') {
                out.append(bracketed()).append(']');
            }
        }
    }

    /** Up to the matching {@code ]}, nested brackets and quoted strings included; the {@code ]} consumed, not returned. */
    private String bracketed() throws IOException {
        StringBuilder out = new StringBuilder();
        int depth = 0;
        boolean quoted = false;
        while (true) {
            int c = next();
            if (c == '\r' || c == '\n') {
                throw new ImapException.Protocol("bracket");
            }
            if (quoted) {
                out.append((char) c);
                if (c == '\\') {
                    out.append((char) next());
                } else if (c == '"') {
                    quoted = false;
                }
                continue;
            }
            if (c == '"') {
                quoted = true;
            } else if (c == '[') {
                depth++;
            } else if (c == ']') {
                if (depth == 0) {
                    return out.toString();
                }
                depth--;
            }
            out.append((char) c);
        }
    }

    private byte[] quoted() throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        while (true) {
            int c = next();
            if (c == '\r' || c == '\n') {
                throw new ImapException.Protocol("quoted");
            }
            if (c == '"') {
                return out.toByteArray();
            }
            if (c == '\\') {
                c = next();
            }
            out.write(c);
        }
    }

    private byte[] literal() throws IOException {
        long n = 0;
        int digits = 0;
        while (true) {
            int c = next();
            if (c >= '0' && c <= '9') {
                n = n * 10 + (c - '0');
                if (++digits > 12) {
                    throw new ImapException.Protocol("literal");
                }
            } else if (c == '+') {
                // only clients send {n+}; take it anyway
            } else if (c == '}') {
                break;
            } else {
                throw new ImapException.Protocol("literal");
            }
        }
        endOfLine();
        if (n > maxLiteral || n > allowance || n > literalCap) {
            throw new ImapException.TooLarge();
        }
        allowance -= n;
        // Grown as the bytes arrive: a header that names 60 MB and sends nothing holds 64 KiB, not 60 MB.
        byte[] out = new byte[(int) Math.min(n, 64 * 1024)];
        int off = 0;
        while (off < n) {
            if (off == out.length) {
                out = java.util.Arrays.copyOf(out, (int) Math.min(n, (long) out.length * 2));
            }
            if (pos < lim) {
                int k = Math.min(lim - pos, out.length - off);
                System.arraycopy(buf, pos, out, off, k);
                pos += k;
                off += k;
            } else {
                int k = in.read(out, off, out.length - off);
                if (k < 0) {
                    throw new EOFException();
                }
                read += k;
                off += k;
            }
        }
        return out;
    }

    private String restOfLine() throws IOException {
        StringBuilder out = new StringBuilder();
        while (true) {
            int c = peek();
            if (c == '\r' || c == '\n') {
                endOfLine();
                return out.toString();
            }
            next();
            if (out.length() < 2048) {
                out.append((char) c);
            }
        }
    }

    private void endOfLine() throws IOException {
        int c = next();
        if (c == '\r') {
            c = next();
        }
        if (c != '\n') {
            throw new ImapException.Protocol("eol");
        }
    }

    private void expect(char want) throws IOException {
        if (next() != want) {
            throw new ImapException.Protocol("expected");
        }
    }

    private int peek() throws IOException {
        if (pos >= lim && !fill()) {
            return -1;
        }
        return buf[pos] & 0xFF;
    }

    private int next() throws IOException {
        if (pos >= lim && !fill()) {
            throw new EOFException();
        }
        if (++lineBytes > lineLimit || --allowance < 0) {
            throw new ImapException.TooLarge();
        }
        return buf[pos++] & 0xFF;
    }

    private boolean fill() throws IOException {
        int k = in.read(buf, 0, buf.length);
        if (k <= 0) {
            return false;
        }
        read += k;
        pos = 0;
        lim = k;
        return true;
    }

    /** A non-negative number, or -1. */
    static long number(String s) {
        if (s == null || s.isEmpty() || s.length() > 19) {
            return -1;
        }
        long n = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < '0' || c > '9') {
                return -1;
            }
            n = n * 10 + (c - '0');
            if (n < 0) {
                return -1;
            }
        }
        return n;
    }

    /** A string item as text: an atom as it is, a quoted or literal string as UTF-8; null for NIL or a list. */
    static String text(Object item) {
        if (item instanceof String s) {
            return s;
        }
        if (item instanceof byte[] b) {
            return new String(b, StandardCharsets.UTF_8);
        }
        return null;
    }
}
