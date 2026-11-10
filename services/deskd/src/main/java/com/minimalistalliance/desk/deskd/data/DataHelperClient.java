package com.minimalistalliance.desk.deskd.data;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedByInterruptException;
import java.nio.channels.SocketChannel;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * deskd's side of /run/desk/data.sock, where the root helper {@code desk-data} reads the owner's files for an export
 * (the task 32 draft ADR, Appendix). One request per connection, and the helper closes it after the reply. So each call
 * is its own connection, and a {@code read} keeps its connection for as long as its body lasts.
 *
 * <p>Nothing here believes the helper more than it has to: the reply's header line is bounded, a read's chunks are
 * bounded and counted, and anything that isn't the protocol fails that one request. A missing socket, a refused
 * connection, a timeout or a reply that isn't the protocol all come out as {@link HelperException#UNAVAILABLE}.
 *
 * <p>Reads go through {@link SocketChannel} directly, which parks a virtual thread, rather than a stream wrapper that
 * could pin it. An interrupt closes the channel, which is how a cancel, a deadline or a stopped transfer ends a call.
 */
public final class DataHelperClient {

    /** What the Appendix allows a request line, its newline included. A path near PATH_MAX fits, and its JSON escapes. */
    static final int MAX_REQUEST_BYTES = 16 * 1024;
    /** The most a read's chunk can be. */
    static final int MAX_CHUNK_BYTES = 65_536;
    /** 32 bytes of SHA-256, then the u64be size. */
    static final int TRAILER_BYTES = 40;
    /** A read's header is a few numbers. */
    private static final int MAX_READ_HEADER_BYTES = 4096;
    private static final int BUFFER_BYTES = 16 * 1024;
    /** A parts walk over a large /data can take a while on a cold disk. */
    public static final Duration WAIT = Duration.ofMinutes(2);

    private final Path socket;
    private final Duration wait;

    public DataHelperClient(Path socket) {
        this(socket, WAIT);
    }

    DataHelperClient(Path socket, Duration wait) {
        this.socket = socket;
        this.wait = wait;
    }

    /**
     * One request whose reply is its header line: parts or manifest.
     *
     * @param maxReplyBytes the longest reply line taken; past it, {@link HelperException#REPLY_TOO_LONG}
     * @return the reply, which said {@code ok: true}
     * @throws HelperException the helper's code, or one of deskd's
     */
    Map<String, Object> call(Map<String, Object> request, int maxReplyBytes) throws HelperException, InterruptedException {
        byte[] line = requestLine(request);
        Connection connection = connect();
        try {
            connection.write(line);
            return connection.header(maxReplyBytes);
        } finally {
            connection.close();
        }
    }

    /**
     * A read: the header now, and the body from the returned {@link Read}, which keeps the connection until it's closed.
     *
     * @throws HelperException the helper's code, or one of deskd's
     */
    Read read(String part, String path, long offset) throws HelperException, InterruptedException {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("v", 1);
        request.put("op", "read");
        request.put("part", part);
        request.put("path", path);
        request.put("offset", offset);
        byte[] line = requestLine(request);
        Connection connection = connect();
        boolean handedOver = false;
        try {
            connection.write(line);
            Map<String, Object> header = connection.header(MAX_READ_HEADER_BYTES);
            long size = wholeNumber(header.get("size"));
            long mtimeMs = header.get("mtimeMs") instanceof Number number ? number.longValue() : 0;
            if (size < 0) {
                throw new HelperException(HelperException.UNAVAILABLE);
            }
            Read read = new Read(connection, size, mtimeMs, offset);
            handedOver = true;
            return read;
        } finally {
            if (!handedOver) {
                connection.close();
            }
        }
    }

    /** @throws HelperException {@link HelperException#REQUEST_TOO_LONG} past what the Appendix allows */
    static byte[] requestLine(Map<String, Object> request) throws HelperException {
        byte[] json = Json.bytes(request);
        if (json.length + 1 > MAX_REQUEST_BYTES) {
            throw new HelperException(HelperException.REQUEST_TOO_LONG);
        }
        byte[] line = Arrays.copyOf(json, json.length + 1);
        line[json.length] = '\n';
        return line;
    }

    private Connection connect() throws HelperException, InterruptedException {
        SocketChannel channel;
        try {
            channel = SocketChannel.open(StandardProtocolFamily.UNIX);
        } catch (IOException e) {
            throw new HelperException(HelperException.UNAVAILABLE);
        }
        Connection connection = new Connection(channel, wait);
        try {
            channel.connect(UnixDomainSocketAddress.of(socket));
            return connection;
        } catch (ClosedByInterruptException e) {
            connection.close();
            Thread.interrupted();
            throw new InterruptedException();
        } catch (IOException | RuntimeException e) {
            connection.close();
            throw new HelperException(HelperException.UNAVAILABLE);
        }
    }

    /** An integer of at most 2^53, or -1. */
    static long wholeNumber(Object value) {
        if ((value instanceof Integer || value instanceof Long) && ((Number) value).longValue() >= 0) {
            long number = ((Number) value).longValue();
            return number <= (1L << 53) ? number : -1;
        }
        return -1;
    }

    /**
     * One connection. Its watchdog closes it once {@code wait} has passed, unless the header has come by then, so a
     * helper that never answers can't hold a call. A read's body has no such limit: the transfer waits for the reader's
     * credit as long as it likes, and it's the transfer that ends it.
     */
    private static final class Connection {
        final SocketChannel channel;
        final ByteBuffer in = ByteBuffer.allocate(BUFFER_BYTES).flip();
        final AtomicBoolean timedOut = new AtomicBoolean();
        final Thread watchdog;

        Connection(SocketChannel channel, Duration wait) {
            this.channel = channel;
            this.watchdog = Thread.ofVirtual().name("data-helper-timeout").start(() -> {
                try {
                    Thread.sleep(wait);
                    timedOut.set(true);
                    closeQuietly(channel);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
        }

        void write(byte[] line) throws HelperException, InterruptedException {
            ByteBuffer out = ByteBuffer.wrap(line);
            try {
                while (out.hasRemaining()) {
                    channel.write(out);
                }
            } catch (IOException e) {
                throw failure(e);
            }
        }

        /** The reply's first line, parsed: ok, or the helper's code. The watchdog stops here either way. */
        Map<String, Object> header(int maxBytes) throws HelperException, InterruptedException {
            try {
                byte[] line = readLine(maxBytes);
                Map<String, Object> reply;
                try {
                    reply = Json.parseObject(line);
                } catch (JsonFormatException e) {
                    throw new HelperException(HelperException.UNAVAILABLE);
                }
                if (Boolean.TRUE.equals(reply.get("ok"))) {
                    return reply;
                }
                String code = Json.string(reply, "code");
                throw new HelperException(HelperException.isHelperCode(code) ? code : HelperException.UNAVAILABLE);
            } catch (IOException e) {
                throw failure(e);
            } finally {
                watchdog.interrupt();
            }
        }

        private byte[] readLine(int maxBytes) throws IOException, HelperException {
            ByteArrayOutputStream line = new ByteArrayOutputStream(256);
            while (true) {
                while (in.hasRemaining()) {
                    byte b = in.get();
                    if (b == '\n') {
                        return line.toByteArray();
                    }
                    if (line.size() >= maxBytes) {
                        throw new HelperException(HelperException.REPLY_TOO_LONG);
                    }
                    line.write(b);
                }
                if (!fill()) {
                    throw new EOFException();
                }
            }
        }

        /** @return false at the end of the stream */
        boolean fill() throws IOException {
            in.compact();
            try {
                return channel.read(in) >= 0;
            } finally {
                in.flip();
            }
        }

        void readFully(byte[] into, int offset, int length) throws IOException {
            int done = 0;
            while (done < length) {
                int got = readSome(into, offset + done, length - done);
                if (got < 0) {
                    throw new EOFException();
                }
                done += got;
            }
        }

        /** Up to {@code length} bytes, at least one, or -1 at the end of the stream. */
        int readSome(byte[] into, int offset, int length) throws IOException {
            if (!in.hasRemaining()) {
                if (length >= in.capacity()) {
                    // Straight into the caller's array: there's nothing in between to copy.
                    int got;
                    do {
                        got = channel.read(ByteBuffer.wrap(into, offset, length));
                    } while (got == 0);
                    return got;
                }
                do {
                    if (!fill()) {
                        return -1;
                    }
                } while (!in.hasRemaining());
            }
            int take = Math.min(length, in.remaining());
            in.get(into, offset, take);
            return take;
        }

        HelperException failure(IOException e) throws InterruptedException {
            if (e instanceof ClosedByInterruptException) {
                Thread.interrupted();
                throw new InterruptedException();
            }
            return new HelperException(HelperException.UNAVAILABLE);
        }

        void close() {
            watchdog.interrupt();
            closeQuietly(channel);
        }
    }

    /**
     * A read's body, after its header: the file's bytes from the offset asked for, then the trailer. Only one thread
     * reads from it, the transfer's. {@link #close} may come from any thread, and ends a read that's parked.
     */
    static final class Read implements Transfer.Body {
        private final Connection connection;
        private final long size;
        private final long mtimeMs;
        private final long offset;
        private long chunkLeft;
        private long bodyBytes;
        private boolean ended;
        private byte[] trailer;

        private Read(Connection connection, long size, long mtimeMs, long offset) {
            this.connection = connection;
            this.size = size;
            this.mtimeMs = mtimeMs;
            this.offset = offset;
        }

        /** What will be sent counting from byte 0, as the helper said. */
        @Override
        public long size() {
            return size;
        }

        @Override
        public long mtimeMs() {
            return mtimeMs;
        }

        /**
         * True once the body has ended, which reads the next chunk's length if the last one is used up, and the trailer
         * after the zero that ends them.
         *
         * @throws IOException if the helper broke the protocol or went away
         */
        @Override
        public boolean atEnd() throws IOException {
            if (ended) {
                return true;
            }
            if (chunkLeft > 0) {
                return false;
            }
            byte[] length = new byte[4];
            connection.readFully(length, 0, 4);
            long next = ByteBuffer.wrap(length).getInt() & 0xFFFFFFFFL;
            if (next == 0) {
                byte[] last = new byte[TRAILER_BYTES];
                connection.readFully(last, 0, TRAILER_BYTES);
                trailer = last;
                ended = true;
                return true;
            }
            // A file that grew stops at size, so the body can't run past it.
            if (next > MAX_CHUNK_BYTES || offset + bodyBytes + next > Math.max(size, offset)) {
                throw new IOException("not the read protocol");
            }
            chunkLeft = next;
            return false;
        }

        /**
         * Fills {@code into} from its start with up to {@code length} bytes of the file, across chunks, stopping early only
         * where the body ends.
         *
         * @return how many, 0 only at the end
         */
        @Override
        public int read(byte[] into, int length) throws IOException {
            int filled = 0;
            while (filled < length && !atEnd()) {
                int got = connection.readSome(into, filled, (int) Math.min(length - filled, chunkLeft));
                if (got < 0) {
                    throw new EOFException();
                }
                filled += got;
                chunkLeft -= got;
                bodyBytes += got;
            }
            return filled;
        }

        /** The helper's 40 bytes, once {@link #atEnd} has said so. */
        @Override
        public byte[] trailer() {
            return trailer;
        }

        @Override
        public void close() {
            connection.close();
        }
    }

    private static void closeQuietly(SocketChannel channel) {
        try {
            channel.close();
        } catch (IOException e) {
            // It's being abandoned.
        }
    }
}
