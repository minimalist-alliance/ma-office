package com.minimalistalliance.desk.agent.attach.worker;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/**
 * Text, Markdown, CSV, JSON and code: decoded as UTF-8 (or UTF-16 with a mark), control characters dropped. Decoded
 * from the stream as it comes, so the file itself is never held: only the first bytes (for the mark and the binary
 * check) and the text kept.
 */
final class PlainText {

    /** How far the binary check looks for a NUL. */
    private static final int LOOK = 8192;

    private PlainText() {}

    /**
     * Reads no more of {@code in} than the cap needs (4 bytes a char at most in UTF-8, plus slack for what is dropped)
     * and one byte more, to know if the file went on. The caller reads the rest.
     */
    static ParseWorker.Result read(InputStream in, int maxChars) throws IOException {
        byte[] buffered = new byte[LOOK + 3];
        int got = Input.fill(in, buffered, buffered.length);
        if (got == 0) {
            return ParseWorker.Result.error("empty");
        }
        byte[] head = got == buffered.length ? buffered : java.util.Arrays.copyOf(buffered, got);
        Charset charset = StandardCharsets.UTF_8;
        int start = 0;
        if (head.length >= 3 && (head[0] & 0xFF) == 0xEF && (head[1] & 0xFF) == 0xBB && (head[2] & 0xFF) == 0xBF) {
            start = 3;
        } else if (head.length >= 2 && (head[0] & 0xFF) == 0xFF && (head[1] & 0xFF) == 0xFE) {
            charset = StandardCharsets.UTF_16LE;
            start = 2;
        } else if (head.length >= 2 && (head[0] & 0xFF) == 0xFE && (head[1] & 0xFF) == 0xFF) {
            charset = StandardCharsets.UTF_16BE;
            start = 2;
        } else {
            int look = Math.min(head.length, LOOK);
            for (int i = 0; i < look; i++) {
                if (head[i] == 0) {
                    return ParseWorker.Result.error("binary");
                }
            }
        }
        long take = (long) maxChars * 4 + 16;
        Bounded first = new Bounded(head, start, in, take);
        ParseWorker.Capped out = new ParseWorker.Capped(maxChars);
        // The decoder replaces what isn't valid, as new String(bytes, charset) did, a sequence cut at the end included.
        Reader reader = new InputStreamReader(first, charset);
        char[] buffer = new char[LOOK];
        StringBuilder piece = new StringBuilder();
        boolean carriage = false;
        int n;
        while (!out.full() && (n = reader.read(buffer)) >= 0) {
            for (int i = 0; i < n; i++) {
                char c = buffer[i];
                // A CR is a newline, and a CR LF one newline; the pair may straddle two reads.
                if (carriage) {
                    carriage = false;
                    if (c != '\n') {
                        piece.append('\n');
                    }
                }
                if (c == '\r') {
                    carriage = true;
                    continue;
                }
                if (c < 0x20 && c != '\n' && c != '\t' || c == 0x7F || (c >= 0x80 && c < 0xA0)) {
                    continue;
                }
                piece.append(c);
            }
            if (piece.length() >= 4096) {
                out.append(piece);
                piece.setLength(0);
            }
        }
        if (carriage) {
            piece.append('\n');
        }
        out.append(piece);
        // What the cap didn't need of the first take is skipped, not decoded; a byte after it means the file was cut.
        first.skipToEnd();
        boolean cut = first.more();
        String text = out.toString();
        if (cut && text.endsWith("�")) {
            text = text.substring(0, text.length() - 1);
        }
        if (text.isBlank()) {
            return ParseWorker.Result.error("empty");
        }
        return ParseWorker.Result.ok(text, cut || out.full() ? "cut" : null);
    }

    /**
     * The head's bytes from {@code at}, then the stream's, up to {@code max} in all. It never closes the stream, which
     * the worker reads to its end afterwards.
     */
    private static final class Bounded extends InputStream {
        private final byte[] head;
        private int at;
        private final InputStream in;
        private long left;

        Bounded(byte[] head, int at, InputStream in, long max) {
            this.head = head;
            this.at = at;
            this.in = in;
            this.left = max;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) {
                return -1;
            }
            int b = at < head.length ? head[at++] & 0xFF : in.read();
            if (b >= 0) {
                left--;
            }
            return b;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            java.util.Objects.checkFromIndexSize(offset, length, buffer.length);
            if (length == 0) {
                return 0;
            }
            if (left <= 0) {
                return -1;
            }
            int want = (int) Math.min(length, left);
            int n;
            if (at < head.length) {
                n = Math.min(want, head.length - at);
                System.arraycopy(head, at, buffer, offset, n);
                at += n;
            } else {
                n = in.read(buffer, offset, want);
            }
            if (n > 0) {
                left -= n;
            }
            return n;
        }

        @Override
        public void close() {
            // The worker reads the rest.
        }

        void skipToEnd() throws IOException {
            byte[] sink = new byte[1 << 16];
            while (read(sink, 0, sink.length) >= 0) {
                // Read and dropped: the cap is full.
            }
        }

        /** Whether the file goes on past the bound: a byte is taken from the stream to know. */
        boolean more() throws IOException {
            return at < head.length || in.read() >= 0;
        }
    }
}
