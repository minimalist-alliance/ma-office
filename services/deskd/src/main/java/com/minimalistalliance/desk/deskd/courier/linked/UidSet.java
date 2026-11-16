package com.minimalistalliance.desk.deskd.courier.linked;

import java.util.Arrays;

/** IMAP sequence sets of UIDs ({@code 1:5,7,9:12}), both ways. */
final class UidSet {

    private UidSet() {}

    /** The most UIDs a set from a server may name: a set past this is the server's mistake, refused. */
    static final int MAX = 2_000_000;

    /** A set for the UIDs given, in any order, duplicates folded. */
    static String of(long... uids) {
        if (uids.length == 0) {
            throw new IllegalArgumentException("empty");
        }
        long[] u = uids.clone();
        Arrays.sort(u);
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < u.length) {
            long start = u[i];
            long end = start;
            while (i + 1 < u.length && (u[i + 1] == end || u[i + 1] == end + 1)) {
                end = u[++i];
            }
            if (!out.isEmpty()) {
                out.append(',');
            }
            out.append(start);
            if (end != start) {
                out.append(':').append(end);
            }
            i++;
        }
        return out.toString();
    }

    /** {@code from:to}, or {@code from:*} with {@code to} 0. */
    static String range(long from, long to) {
        return to <= 0 ? from + ":*" : from + ":" + to;
    }

    /** The UIDs a server's set names, ascending; {@code *} isn't taken (a server names real UIDs). */
    static long[] parse(String set) throws ImapException {
        long[] r = parseOrdered(set);
        Arrays.sort(r);
        return r;
    }

    /** As the set lists them, for COPYUID's two sets, which pair up in order. */
    static long[] parseOrdered(String set) throws ImapException {
        return parseOrdered(set, MAX);
    }

    /** As {@link #parseOrdered(String)}, naming at most {@code max} UIDs: past that, {@link ImapException.TooLarge}. */
    static long[] parseOrdered(String set, long max) throws ImapException {
        if (set == null || set.isEmpty()) {
            return new long[0];
        }
        long[] out = new long[16];
        int n = 0;
        for (String part : set.split(",", -1)) {
            int colon = part.indexOf(':');
            long a = ImapReader.number(colon < 0 ? part : part.substring(0, colon));
            long b = colon < 0 ? a : ImapReader.number(part.substring(colon + 1));
            if (a <= 0 || b <= 0) {
                throw new ImapException.Protocol("set");
            }
            long lo = Math.min(a, b);
            long hi = Math.max(a, b);
            if (hi - lo + n > MAX) {
                throw new ImapException.Protocol("set");
            }
            if (hi - lo + 1 + n > max) {
                throw new ImapException.TooLarge();
            }
            for (long u = lo; u <= hi; u++) {
                if (n == out.length) {
                    out = Arrays.copyOf(out, out.length * 2);
                }
                out[n++] = u;
            }
        }
        return Arrays.copyOf(out, n);
    }
}
