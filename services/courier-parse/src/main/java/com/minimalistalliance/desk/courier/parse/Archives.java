package com.minimalistalliance.desk.courier.parse;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * An archive's file list, read without unpacking anything (the launch plan §2.8): a ZIP's central directory from the
 * end of the file, and a tar's headers as they stream past. Nothing is inflated, written or run.
 */
final class Archives {

    private Archives() {}

    /** One file in an archive. {@code packed} is its compressed size, -1 when the format has none. */
    record Entry(String name, long bytes, long packed, boolean encrypted, boolean dir) {}

    /** A listing: the first {@link Limits#MAX_ARCHIVE_ENTRIES} entries, how many there are, and whether it's whole. */
    record Listing(String format, List<Entry> entries, long total, boolean truncated) {}

    private static final Charset CP437 = cp437();

    private static Charset cp437() {
        try {
            return Charset.forName("IBM437");
        } catch (RuntimeException e) {
            return Charsets.WINDOWS_1252;
        }
    }

    /**
     * A ZIP's listing from the last bytes of the file, or null when its central directory isn't all in them (an archive
     * with very many files), or it isn't a ZIP.
     *
     * @param tail the last {@code tail.length} bytes of a file of {@code size} bytes
     */
    static Listing zip(byte[] tail, long size) {
        int eocd = -1;
        for (int i = tail.length - 22; i >= 0 && i >= tail.length - 22 - 65535; i--) {
            if (tail[i] == 0x50 && tail[i + 1] == 0x4B && tail[i + 2] == 0x05 && tail[i + 3] == 0x06) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) {
            return null;
        }
        long total = u16(tail, eocd + 10);
        long cdSize = u32(tail, eocd + 12);
        long cdOffset = u32(tail, eocd + 16);
        int cdEnd = eocd;
        if (total == 0xFFFF || cdSize == 0xFFFFFFFFL || cdOffset == 0xFFFFFFFFL) {
            // ZIP64: the locator sits just before the end record and names the ZIP64 end record.
            int loc = eocd - 20;
            if (loc < 0 || !(tail[loc] == 0x50 && tail[loc + 1] == 0x4B && tail[loc + 2] == 0x06 && tail[loc + 3] == 0x07)) {
                return null;
            }
            long recordAt = u64(tail, loc + 8) - (size - tail.length);
            if (recordAt < 0 || recordAt + 56 > tail.length) {
                return null;
            }
            int r = (int) recordAt;
            if (!(tail[r] == 0x50 && tail[r + 1] == 0x4B && tail[r + 2] == 0x06 && tail[r + 3] == 0x06)) {
                return null;
            }
            total = u64(tail, r + 32);
            cdSize = u64(tail, r + 40);
            cdOffset = u64(tail, r + 48);
            cdEnd = r;
        }
        long start = cdEnd - cdSize;
        if (start < 0 || cdSize > tail.length) {
            return null;
        }
        List<Entry> entries = new ArrayList<>();
        int p = (int) start;
        long seen = 0;
        while (p + 46 <= cdEnd && seen < total) {
            if (!(tail[p] == 0x50 && tail[p + 1] == 0x4B && tail[p + 2] == 0x01 && tail[p + 3] == 0x02)) {
                return entries.isEmpty() ? null : new Listing("zip", entries, Math.max(total, seen), true);
            }
            int flags = u16(tail, p + 8);
            long packed = u32(tail, p + 20);
            long bytes = u32(tail, p + 24);
            int nameLen = u16(tail, p + 28);
            int extraLen = u16(tail, p + 30);
            int commentLen = u16(tail, p + 32);
            if (p + 46 + nameLen + extraLen + commentLen > cdEnd) {
                break;
            }
            String name = new String(tail, p + 46, nameLen, (flags & 0x800) != 0 ? StandardCharsets.UTF_8 : CP437);
            if (packed == 0xFFFFFFFFL || bytes == 0xFFFFFFFFL) {
                long[] z = zip64Sizes(tail, p + 46 + nameLen, extraLen, bytes == 0xFFFFFFFFL, packed == 0xFFFFFFFFL);
                if (bytes == 0xFFFFFFFFL) {
                    bytes = z[0];
                }
                if (packed == 0xFFFFFFFFL) {
                    packed = z[1];
                }
            }
            if (entries.size() < Limits.MAX_ARCHIVE_ENTRIES) {
                entries.add(new Entry(name, bytes, packed, (flags & 1) != 0, name.endsWith("/")));
            }
            seen++;
            p += 46 + nameLen + extraLen + commentLen;
        }
        return new Listing("zip", entries, Math.max(total, seen), seen > entries.size() || seen < total);
    }

    private static long[] zip64Sizes(byte[] b, int at, int len, boolean wantBytes, boolean wantPacked) {
        long[] out = {-1, -1};
        int end = at + len;
        while (at + 4 <= end) {
            int id = u16(b, at);
            int size = u16(b, at + 2);
            if (id == 0x0001) {
                int q = at + 4;
                if (wantBytes && q + 8 <= at + 4 + size) {
                    out[0] = u64(b, q);
                    q += 8;
                }
                if (wantPacked && q + 8 <= at + 4 + size) {
                    out[1] = u64(b, q);
                }
                break;
            }
            at += 4 + size;
        }
        return out;
    }

    static int u16(byte[] b, int i) {
        return (b[i] & 0xFF) | (b[i + 1] & 0xFF) << 8;
    }

    static long u32(byte[] b, int i) {
        return (b[i] & 0xFFL) | (b[i + 1] & 0xFFL) << 8 | (b[i + 2] & 0xFFL) << 16 | (b[i + 3] & 0xFFL) << 24;
    }

    static long u64(byte[] b, int i) {
        return u32(b, i) | u32(b, i + 4) << 32;
    }

    /** A tar's headers, read as its bytes stream past. */
    static final class Tar {
        private final List<Entry> entries = new ArrayList<>();
        private final byte[] header = new byte[512];
        private int filled;
        private long position;
        private long nextHeader;
        private long total;
        private boolean ended;
        private boolean broken;
        /** A GNU long name ({@code L}) or a pax header ({@code x}) whose data is being collected for the next entry. */
        private byte[] pending;
        private int pendingFilled;
        private char pendingType;
        private String longName;

        void write(byte[] b, int off, int len) {
            int end = off + len;
            while (off < end && !ended && !broken) {
                if (pending != null && position < nextHeader) {
                    long dataLeft = nextHeader - position;
                    int n = (int) Math.min(end - off, dataLeft);
                    int keep = Math.min(n, pending.length - pendingFilled);
                    System.arraycopy(b, off, pending, pendingFilled, Math.max(0, keep));
                    pendingFilled += Math.max(0, keep);
                    off += n;
                    position += n;
                    if (position == nextHeader) {
                        finishPending();
                    }
                    continue;
                }
                if (position < nextHeader) {
                    int n = (int) Math.min(end - off, nextHeader - position);
                    off += n;
                    position += n;
                    continue;
                }
                int n = Math.min(end - off, 512 - filled);
                System.arraycopy(b, off, header, filled, n);
                filled += n;
                off += n;
                position += n;
                if (filled == 512) {
                    filled = 0;
                    header();
                }
            }
        }

        private void finishPending() {
            String text = new String(pending, 0, pendingFilled, StandardCharsets.UTF_8);
            if (pendingType == 'L') {
                int nul = text.indexOf('\0');
                longName = nul >= 0 ? text.substring(0, nul) : text;
            } else {
                for (String record : text.split("\n")) {
                    int sp = record.indexOf(' ');
                    if (sp > 0 && record.startsWith("path=", sp + 1)) {
                        longName = record.substring(sp + 6);
                    }
                }
            }
            pending = null;
        }

        private void header() {
            boolean zero = true;
            for (byte x : header) {
                if (x != 0) {
                    zero = false;
                    break;
                }
            }
            if (zero) {
                ended = true;
                return;
            }
            long size = size(header, 124, 12);
            if (size < 0) {
                broken = true;
                return;
            }
            char type = (char) header[156];
            nextHeader = position + (size + 511) / 512 * 512;
            if (type == 'L' || type == 'x') {
                if (size == 0) {
                    return;
                }
                pending = new byte[(int) Math.min(size, 4096)];
                pendingFilled = 0;
                pendingType = type;
                return;
            }
            if (type == 'g') {
                return;
            }
            String name = longName != null ? longName : name(header);
            longName = null;
            total++;
            if (entries.size() < Limits.MAX_ARCHIVE_ENTRIES) {
                entries.add(new Entry(name, size, -1, false, type == '5' || name.endsWith("/")));
            }
        }

        private static String name(byte[] h) {
            String name = cstring(h, 0, 100);
            if (h[257] == 'u' && h[258] == 's' && h[259] == 't' && h[260] == 'a' && h[261] == 'r') {
                String prefix = cstring(h, 345, 155);
                if (!prefix.isEmpty()) {
                    name = prefix + "/" + name;
                }
            }
            return name;
        }

        private static String cstring(byte[] b, int at, int len) {
            int n = 0;
            while (n < len && b[at + n] != 0) {
                n++;
            }
            return new String(b, at, n, StandardCharsets.UTF_8);
        }

        /** An octal number, or GNU's base-256 when its first byte's high bit is set; -1 if it's neither. */
        static long size(byte[] h, int at, int len) {
            if ((h[at] & 0x80) != 0) {
                long v = 0;
                for (int i = 1; i < len; i++) {
                    v = v << 8 | (h[at + i] & 0xFF);
                    if (v < 0 || v > (1L << 40)) {
                        return -1;
                    }
                }
                return v;
            }
            long v = 0;
            boolean any = false;
            for (int i = 0; i < len; i++) {
                int c = h[at + i];
                if (c == 0 || c == ' ') {
                    if (any) {
                        break;
                    }
                    continue;
                }
                if (c < '0' || c > '7') {
                    return -1;
                }
                v = v * 8 + (c - '0');
                any = true;
            }
            return v;
        }

        /** Whether the first header looked like a tar's ({@code ustar} or a v7 checksum that adds up). */
        static boolean looksLike(byte[] head) {
            if (head.length < 512) {
                return false;
            }
            if (head[257] == 'u' && head[258] == 's' && head[259] == 't' && head[260] == 'a' && head[261] == 'r') {
                return true;
            }
            long sum = size(head, 148, 8);
            long actual = 0;
            for (int i = 0; i < 512; i++) {
                actual += i >= 148 && i < 156 ? ' ' : head[i] & 0xFF;
            }
            return sum > 0 && sum == actual;
        }

        Listing listing() {
            return broken && entries.isEmpty() ? null : new Listing("tar", List.copyOf(entries), total, total > entries.size() || broken);
        }
    }
}
