package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.data.Transfer;
import java.io.EOFException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * What files.read sends: one handle to the file, opened once with no-follow, so a rename or delete during the read
 * changes nothing that is sent. The trailer is the SHA-256 of the whole file from byte 0 and its size, as the export's
 * read sends it, so a read from an offset first hashes what comes before it.
 */
final class FileBody implements Transfer.Body {

    private final FileChannel channel;
    private final long size;
    private final long mtimeMs;
    private final long offset;
    private final Runnable activity;
    private final MessageDigest digest;
    private long position;
    private boolean primed;
    private byte[] trailer;

    FileBody(FileChannel channel, long size, long mtimeMs, long offset, Runnable activity) {
        this.channel = channel;
        this.size = size;
        this.mtimeMs = mtimeMs;
        this.offset = offset;
        this.activity = activity;
        try {
            this.digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public long size() {
        return size;
    }

    @Override
    public long mtimeMs() {
        return mtimeMs;
    }

    /** Hashes what comes before the offset, once, on the transfer's own thread. */
    private void prime() throws IOException {
        if (primed) {
            return;
        }
        primed = true;
        ByteBuffer buf = ByteBuffer.allocate(1 << 20);
        long at = 0;
        while (at < offset) {
            buf.clear().limit((int) Math.min(buf.capacity(), offset - at));
            int n = channel.read(buf, at);
            if (n < 0) {
                throw new EOFException();
            }
            digest.update(buf.array(), 0, n);
            at += n;
            if (Thread.currentThread().isInterrupted()) {
                throw new java.io.InterruptedIOException();
            }
        }
        position = offset;
    }

    @Override
    public boolean atEnd() throws IOException {
        prime();
        if (position < size) {
            return false;
        }
        if (trailer == null) {
            ByteBuffer out = ByteBuffer.allocate(40);
            out.put(digest.digest());
            out.putLong(size);
            trailer = out.array();
        }
        return true;
    }

    @Override
    public int read(byte[] into, int length) throws IOException {
        prime();
        int want = (int) Math.min(length, size - position);
        if (want <= 0) {
            return 0;
        }
        ByteBuffer buf = ByteBuffer.wrap(into, 0, want);
        int filled = 0;
        while (filled < want) {
            int n = channel.read(buf, position + filled);
            if (n < 0) {
                // The file got shorter than it was when it was opened.
                throw new EOFException();
            }
            filled += n;
        }
        digest.update(into, 0, filled);
        position += filled;
        activity.run();
        return filled;
    }

    @Override
    public byte[] trailer() {
        return trailer;
    }

    @Override
    public void close() {
        try {
            channel.close();
        } catch (IOException e) {
            // Done with it.
        }
    }
}
