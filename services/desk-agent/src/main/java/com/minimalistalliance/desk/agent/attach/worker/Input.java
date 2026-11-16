package com.minimalistalliance.desk.agent.attach.worker;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import org.apache.pdfbox.io.RandomAccessRead;
import org.apache.pdfbox.io.RandomAccessReadView;

/**
 * A file from standard input, held once at its own size in fixed {@link #CHUNK}-byte arrays. A growing buffer doubled
 * to 32 MiB past 16 MiB and was then copied, so a 72 MiB heap ended at about 17 MiB, short of the 20 MiB a desk owner
 * may allow a file (ADR 0049 item 5). Read as a stream from its start as often as wanted ({@link #stream()}: the zip
 * formats, xlsx in two passes) and as PDFBox's {@link RandomAccessRead} (PDFs), neither copying it.
 *
 * <p>Only the worker's thread uses it. {@link #close()} lets go of the chunks.
 */
final class Input implements RandomAccessRead {

    static final int SHIFT = 16;
    /** 64 KiB: small enough to fit the young generation of a small heap, large enough to be few. */
    static final int CHUNK = 1 << SHIFT;
    private static final int MASK = CHUNK - 1;

    private byte[][] chunks;
    private final long length;
    private long position;

    private Input(byte[][] chunks, long length) {
        this.chunks = chunks;
        this.length = length;
    }

    /**
     * {@code in} to its end.
     *
     * @throws IOException past {@code max} bytes, as {@code input}, before taking more than one chunk over
     */
    static Input read(InputStream in, long max) throws IOException {
        List<byte[]> chunks = new ArrayList<>();
        long length = 0;
        while (true) {
            byte[] chunk = new byte[CHUNK];
            int filled = fill(in, chunk, CHUNK);
            if (filled == 0) {
                break;
            }
            length += filled;
            if (length > max) {
                throw new IOException("input");
            }
            chunks.add(chunk);
            if (filled < CHUNK) {
                break;
            }
        }
        return new Input(chunks.toArray(new byte[0][]), length);
    }

    /** Reads into {@code into} until {@code count} bytes or the end; how many. A short read isn't the end. */
    static int fill(InputStream in, byte[] into, int count) throws IOException {
        int filled = 0;
        while (filled < count) {
            int n = in.read(into, filled, count - filled);
            if (n < 0) {
                break;
            }
            filled += n;
        }
        return filled;
    }

    /** A new stream over the whole file from its first byte. It doesn't move {@link #getPosition()}. */
    InputStream stream() throws IOException {
        checkOpen();
        return new InputStream() {
            private long at;

            @Override
            public int read() throws IOException {
                if (at >= length) {
                    return -1;
                }
                return byteAt(at++);
            }

            @Override
            public int read(byte[] buffer, int offset, int count) throws IOException {
                Objects.checkFromIndexSize(offset, count, buffer.length);
                if (count == 0) {
                    return 0;
                }
                if (at >= length) {
                    return -1;
                }
                int n = copy(at, buffer, offset, count);
                at += n;
                return n;
            }

            @Override
            public long skip(long n) {
                long skipped = Math.max(0, Math.min(n, length - at));
                at += skipped;
                return skipped;
            }

            @Override
            public int available() {
                return (int) Math.min(length - at, Integer.MAX_VALUE);
            }
        };
    }

    private int byteAt(long at) throws IOException {
        checkOpen();
        return chunks[(int) (at >>> SHIFT)][(int) (at & MASK)] & 0xFF;
    }

    /** Up to {@code count} bytes from {@code at}, which is before the end; how many it copied. */
    private int copy(long at, byte[] buffer, int offset, int count) throws IOException {
        checkOpen();
        int n = (int) Math.min(count, length - at);
        int done = 0;
        while (done < n) {
            long from = at + done;
            int in = (int) (from & MASK);
            int take = Math.min(n - done, CHUNK - in);
            System.arraycopy(chunks[(int) (from >>> SHIFT)], in, buffer, offset + done, take);
            done += take;
        }
        return n;
    }

    private void checkOpen() throws IOException {
        if (chunks == null) {
            throw new IOException("closed");
        }
    }

    // ------------------------------------------------------- RandomAccessRead, as PDFBox's RandomAccessReadBuffer

    @Override
    public int read() throws IOException {
        checkOpen();
        if (position >= length) {
            return -1;
        }
        return byteAt(position++);
    }

    @Override
    public int read(byte[] buffer, int offset, int count) throws IOException {
        checkOpen();
        Objects.checkFromIndexSize(offset, count, buffer.length);
        if (position >= length) {
            return -1;
        }
        if (count == 0) {
            return 0;
        }
        int n = copy(position, buffer, offset, count);
        position += n;
        return n;
    }

    @Override
    public long getPosition() throws IOException {
        checkOpen();
        return position;
    }

    /** Past the end means at the end; before the start is an error. */
    @Override
    public void seek(long to) throws IOException {
        checkOpen();
        if (to < 0) {
            throw new IOException("Invalid position " + to);
        }
        position = Math.min(to, length);
    }

    @Override
    public long length() throws IOException {
        checkOpen();
        return length;
    }

    @Override
    public boolean isClosed() {
        return chunks == null;
    }

    @Override
    public boolean isEOF() throws IOException {
        checkOpen();
        return position >= length;
    }

    /** A window onto these same bytes, as PDFBox reads a stream's data: no copy. */
    @Override
    public RandomAccessReadView createView(long start, long count) throws IOException {
        checkOpen();
        return new RandomAccessReadView(this, start, count);
    }

    @Override
    public void close() {
        chunks = null;
    }

    // ------------------------------------------------------------------------------------------------ the text kind

    /** A stream that ends the read with {@code input} once more than {@code max} bytes have come through it. */
    static final class Limited extends FilterInputStream {
        private final long max;
        private long count;

        Limited(InputStream in, long max) {
            super(in);
            this.max = max;
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            if (b >= 0) {
                counted(1);
            }
            return b;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int n = super.read(buffer, offset, length);
            if (n > 0) {
                counted(n);
            }
            return n;
        }

        @Override
        public long skip(long n) throws IOException {
            // Through read, so what is skipped is counted.
            byte[] sink = new byte[(int) Math.min(Math.max(n, 0), 8192)];
            long skipped = 0;
            while (skipped < n) {
                int read = read(sink, 0, (int) Math.min(sink.length, n - skipped));
                if (read < 0) {
                    break;
                }
                skipped += read;
            }
            return skipped;
        }

        @Override
        public boolean markSupported() {
            return false;
        }

        /** Reads to the end, keeping nothing: the cap still applies to what the reader didn't need. */
        void drain() throws IOException {
            byte[] sink = new byte[1 << 16];
            while (read(sink, 0, sink.length) >= 0) {
                // Counted, discarded.
            }
        }

        private void counted(int n) throws IOException {
            count += n;
            if (count > max) {
                throw new IOException("input");
            }
        }
    }
}
