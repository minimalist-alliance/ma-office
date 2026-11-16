package com.minimalistalliance.desk.courier.parse;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Bytes held in 64 KiB chunks up to a cap, so a part of tens of MiB is held once and never copied while it grows (a
 * doubling buffer would need twice its size at the moment it grows, past the worker's 72 MiB heap).
 */
final class Chunks extends OutputStream {

    private static final int CHUNK = 64 * 1024;

    private final List<byte[]> chunks = new ArrayList<>();
    private final long cap;
    private long size;
    private boolean over;

    Chunks(long cap) {
        this.cap = cap;
    }

    @Override
    public void write(int b) {
        write(new byte[] {(byte) b}, 0, 1);
    }

    @Override
    public void write(byte[] b, int off, int len) {
        if (over) {
            return;
        }
        if (size + len > cap) {
            over = true;
            return;
        }
        while (len > 0) {
            int at = (int) (size % CHUNK);
            if (at == 0) {
                chunks.add(new byte[CHUNK]);
            }
            byte[] last = chunks.get(chunks.size() - 1);
            int n = Math.min(len, CHUNK - at);
            System.arraycopy(b, off, last, at, n);
            size += n;
            off += n;
            len -= n;
        }
    }

    /** Whether more than the cap was written; what's held is then only the first part. */
    boolean over() {
        return over;
    }

    long size() {
        return size;
    }

    /** The first {@code n} bytes, copied (for magic numbers). */
    byte[] head(int n) {
        int len = (int) Math.min(n, size);
        byte[] out = new byte[len];
        int done = 0;
        for (byte[] c : chunks) {
            if (done >= len) {
                break;
            }
            int k = Math.min(CHUNK, len - done);
            System.arraycopy(c, 0, out, done, k);
            done += k;
        }
        return out;
    }

    void writeTo(OutputStream out) throws IOException {
        long left = size;
        for (byte[] c : chunks) {
            int k = (int) Math.min(CHUNK, left);
            out.write(c, 0, k);
            left -= k;
        }
    }

    InputStream inputStream() {
        return new InputStream() {
            private long pos;

            @Override
            public int read() {
                if (pos >= size) {
                    return -1;
                }
                byte b = chunks.get((int) (pos / CHUNK))[(int) (pos % CHUNK)];
                pos++;
                return b & 0xFF;
            }

            @Override
            public int read(byte[] b, int off, int len) {
                if (pos >= size) {
                    return -1;
                }
                int at = (int) (pos % CHUNK);
                int n = (int) Math.min(Math.min(len, CHUNK - at), size - pos);
                System.arraycopy(chunks.get((int) (pos / CHUNK)), at, b, off, n);
                pos += n;
                return n;
            }

            @Override
            public int available() {
                return (int) Math.min(Integer.MAX_VALUE, size - pos);
            }
        };
    }
}
