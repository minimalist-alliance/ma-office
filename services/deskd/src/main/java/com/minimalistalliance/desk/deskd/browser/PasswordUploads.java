package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.Message;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPeer;
import com.minimalistalliance.desk.deskd.session.Session;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * A passwords file on its way in from the member's own browser (API.md section 10, "Signing in"), held in deskd's memory
 * and nowhere else: no file in Files, under {@code /data}, in {@code /tmp} or at any path, so no snapshot of the desk's
 * volumes can hold it. {@code browser.import.begin} makes a buffer of the size the client says; the client sends the
 * file's bytes on {@code bulk} as CHUNK frames, as a Files upload does (files.md section 5.2), with credit for the whole
 * file from the start; and {@code browser.import.finish} takes the buffer for the import, which zeroes it.
 *
 * <p>Each chunk is copied into the buffer on the bulk lane, with no queue and no disk, and the chunk's own array is zeroed
 * at once. The buffer is zeroed when the import is done with it, when the member aborts, when the transfer goes wrong,
 * {@link Timing#idle} after its last byte (or its begin), when its session ends, and when deskd stops. At most one is
 * held on the desk at a time. Nothing here logs.
 *
 * <p>What deskd can't zero: the transport's own copies of the bytes (desk-rtc's buffers, the rtc socket's read buffer, each
 * frame's array before its payload is cut out) and the Java strings the parser and the CDP call make. They're memory
 * only, garbage once the import is done, and deskd's container may not swap (its run script gives docker a swap limit
 * equal to its memory limit), so none of it can be written to the volume either.
 */
final class PasswordUploads implements AutoCloseable {

    /**
     * @param idle how long a buffer is kept with no byte arriving and no finish: then it's zeroed
     * @param lastByteWait how long finish waits for a byte, as frames on bulk and the call on rpc aren't ordered
     */
    record Timing(Duration idle, Duration lastByteWait) {
        static final Timing DEFAULT = new Timing(Duration.ofSeconds(60), Duration.ofSeconds(30));
    }

    /** The upload's id: 22 characters of base64url, for 128 random bits. */
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{22}");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Transfers transfers;
    private final Function<String, Session> sessions;
    private final Timing timing;
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "password-upload-idle");
        thread.setDaemon(true);
        return thread;
    });
    /** The CREDIT frames, in order, off the bulk lane, which must never wait on a send. */
    private final ExecutorService sender = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "password-upload-credit");
        thread.setDaemon(true);
        return thread;
    });

    /** The one upload the desk holds, or null. Guarded by this. */
    private Upload current;
    /** For tests: sees each whole file's buffer as the import takes it, to check it's zeroed after. */
    volatile java.util.function.Consumer<byte[]> onTake = bytes -> {};

    PasswordUploads(Transfers transfers, Function<String, Session> sessions, Timing timing) {
        this.transfers = transfers;
        this.sessions = sessions;
        this.timing = timing;
    }

    /** What begin gives the client. */
    record Begun(String uploadId, long transferId, int size) {
        Map<String, Object> reply() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("uploadId", uploadId);
            out.put("transferId", transferId);
            out.put("window", size);
            out.put("size", size);
            return out;
        }
    }

    /**
     * Makes room for a file of {@code size} bytes in this session. Another upload of this session's is zeroed first: the
     * client gave up on it.
     *
     * @throws RpcException {@code conflict} {@code reason: busy} while another session's is held; {@code too_many} from
     *     the transfer table; {@code unavailable} if the session has ended
     */
    synchronized Begun begin(String sessionId, int size) throws RpcException {
        if (current != null) {
            if (!current.sessionId.equals(sessionId)) {
                throw new RpcException(RpcException.CONFLICT, "Another passwords file is on its way in", Map.of("reason", "busy"));
            }
            drop(current, "superseded");
        }
        Session session = sessions.apply(sessionId);
        if (session == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
        }
        byte[] raw = new byte[16];
        RANDOM.nextBytes(raw);
        Upload upload = new Upload(Base64.getUrlEncoder().withoutPadding().encodeToString(raw), session, size);
        upload.slot = transfers.reserveUpload(sessionId, upload);
        current = upload;
        upload.idleCheck = timer.schedule(() -> idleCheck(upload), timing.idle().toNanos(), TimeUnit.NANOSECONDS);
        return new Begun(upload.id, upload.slot.id(), size);
    }

    /**
     * The whole file, once its last byte is in, out of this table: the caller owns the array now and must zero it.
     *
     * @throws RpcException {@code bad_request} {@code reason: uploadId}; {@code not_found} {@code reason: upload} for none
     *     of this session's by that id; {@code conflict} {@code reason: incomplete} with {@code committed}, the bytes
     *     that came, if they stopped coming before the last or the transfer ended, and then the upload is gone
     */
    synchronized byte[] take(String sessionId, Object uploadId) throws RpcException, InterruptedException {
        if (!(uploadId instanceof String id) || !ID.matcher(id).matches()) {
            throw new RpcException(RpcException.BAD_REQUEST, "uploadId is not valid", Map.of("reason", "uploadId"));
        }
        Upload upload = current;
        if (upload == null || !upload.id.equals(id) || !upload.sessionId.equals(sessionId)) {
            throw notFound();
        }
        long wait = timing.lastByteWait().toNanos();
        while (current == upload && !upload.complete()) {
            long left = upload.lastByteNanos + wait - System.nanoTime();
            if (left <= 0) {
                break;
            }
            TimeUnit.NANOSECONDS.timedWait(this, left);
        }
        if (current != upload || !upload.complete()) {
            int received = upload.filled;
            if (current == upload) {
                drop(upload, null);
            }
            throw new RpcException(RpcException.CONFLICT, "Not every byte has arrived",
                    Map.of("reason", "incomplete", "committed", received));
        }
        current = null;
        upload.end();
        onTake.accept(upload.buffer);
        return upload.buffer;
    }

    /** The member gave up: zeroed. Nothing for an id that isn't this session's. */
    synchronized void abort(String sessionId, Object uploadId) throws RpcException {
        if (!(uploadId instanceof String id) || !ID.matcher(id).matches()) {
            throw new RpcException(RpcException.BAD_REQUEST, "uploadId is not valid", Map.of("reason", "uploadId"));
        }
        if (current != null && current.id.equals(id) && current.sessionId.equals(sessionId)) {
            drop(current, "aborted");
        }
    }

    /** How many bytes are held now, for tests. */
    synchronized int heldBytes() {
        return current == null ? 0 : current.buffer.length;
    }

    @Override
    public void close() {
        synchronized (this) {
            if (current != null) {
                drop(current, null);
            }
        }
        timer.shutdownNow();
        sender.shutdownNow();
    }

    private synchronized void idleCheck(Upload upload) {
        if (current != upload) {
            return;
        }
        long left = upload.touchedNanos + timing.idle().toNanos() - System.nanoTime();
        if (left <= 0) {
            drop(upload, "expired");
            return;
        }
        upload.idleCheck = timer.schedule(() -> idleCheck(upload), left, TimeUnit.NANOSECONDS);
    }

    /** Zeroes it and ends its transfer, telling the client with {@code error} unless that's null. Holds this. */
    private void drop(Upload upload, String error) {
        if (current == upload) {
            current = null;
        }
        Arrays.fill(upload.buffer, (byte) 0);
        upload.end();
        if (error != null) {
            credit(upload, 0, error);
        }
        notifyAll();
    }

    private void credit(Upload upload, long bytes, String error) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("bytes", bytes);
        body.put("committed", upload.filled);
        if (error != null) {
            body.put("error", error);
        }
        byte[] payload = Json.bytes(body);
        long transferId = upload.slot.id();
        try {
            sender.execute(() -> {
                try {
                    upload.session.send(Channels.BULK, FrameKind.CREDIT, 0, transferId, 0, payload);
                } catch (RpcPeer.PeerGoneException e) {
                    // Nobody to tell.
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            // deskd is stopping.
        }
    }

    private static RpcException notFound() {
        return new RpcException(RpcException.NOT_FOUND, "No such passwords upload", Map.of("reason", "upload"));
    }

    /** One file on its way in. Everything but the finals is guarded by the table's monitor. */
    private final class Upload implements Transfers.ChunkSink {
        final String id;
        final Session session;
        final String sessionId;
        final byte[] buffer;
        Transfers.Slot slot;
        ScheduledFuture<?> idleCheck;
        int filled;
        long expectSeq;
        long touchedNanos = System.nanoTime();
        long lastByteNanos = touchedNanos;
        private boolean ended;

        Upload(String id, Session session, int size) {
            this.id = id;
            this.session = session;
            this.sessionId = session.sessionId();
            this.buffer = new byte[size];
        }

        boolean complete() {
            return filled == buffer.length;
        }

        /** Its place in the transfer table and its idle check go. Once. */
        void end() {
            if (ended) {
                return;
            }
            ended = true;
            if (idleCheck != null) {
                idleCheck.cancel(false);
            }
            slot.release();
        }

        /** On the bulk lane: copied straight into the buffer and the frame's array zeroed. Never waits but on the monitor. */
        @Override
        public void chunk(Session from, Message message) {
            byte[] payload = message.payload();
            try {
                synchronized (PasswordUploads.this) {
                    if (current != this || ended) {
                        return;
                    }
                    if (message.seq() != expectSeq) {
                        drop(this, "seq");
                        return;
                    }
                    expectSeq++;
                    if (payload.length == 0) {
                        return;
                    }
                    if (payload.length > buffer.length - filled) {
                        drop(this, "credit_violation");
                        return;
                    }
                    System.arraycopy(payload, 0, buffer, filled, payload.length);
                    filled += payload.length;
                    touchedNanos = System.nanoTime();
                    lastByteNanos = touchedNanos;
                    if (complete()) {
                        // As a Files upload's last acknowledgement: no more credit, and every byte is in.
                        credit(this, 0, null);
                        PasswordUploads.this.notifyAll();
                    }
                }
            } finally {
                Arrays.fill(payload, (byte) 0);
            }
        }

        @Override
        public void sessionEnded() {
            synchronized (PasswordUploads.this) {
                if (current == this) {
                    drop(this, null);
                } else {
                    end();
                }
            }
        }
    }
}
