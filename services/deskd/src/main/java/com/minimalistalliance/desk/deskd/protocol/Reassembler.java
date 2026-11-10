package com.minimalistalliance.desk.deskd.protocol;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Joins the frames of one channel into messages. Incomplete messages are keyed by (kind, id), so a
 * short response can overtake a long one. Used by one thread at a time.
 *
 * <p>Memory is bounded three ways: a per-kind limit on each message, a count of incomplete messages,
 * and a {@link ReassemblyBudget} shared by the session's channels.
 */
public final class Reassembler {

    /** Incomplete messages per channel, including over-limit ones whose frames are being dropped. */
    public static final int MAX_INCOMPLETE = 64;

    private final ReassemblyBudget budget;
    private final Map<Long, Partial> partials = new HashMap<>();

    public Reassembler(ReassemblyBudget budget) {
        this.budget = budget;
    }

    /**
     * @return the whole message, or null while it's incomplete or being dropped
     * @throws FrameException if the frame contradicts the message it continues
     * @throws TooLargeException if a limit was hit; see {@link TooLargeException#recoverable()}
     */
    public Message accept(Frame frame) throws FrameException, TooLargeException {
        long key = (long) frame.kind().code() << 32 | frame.id();
        Partial partial = partials.get(key);
        if (partial == null) {
            if (!frame.more()) {
                return Message.of(frame, frame.payload());
            }
            if (partials.size() >= MAX_INCOMPLETE) {
                throw new TooLargeException(frame.kind(), frame.id(), false);
            }
            partial = new Partial(frame);
            partials.put(key, partial);
        } else {
            partial.checkContinues(frame);
        }

        if (partial.dropping) {
            if (!frame.more()) {
                partials.remove(key);
            }
            return null;
        }
        int length = frame.payload().length;
        if (partial.size + length > frame.kind().maxMessageBytes()) {
            budget.release(partial.size);
            partial.startDropping();
            if (!frame.more()) {
                partials.remove(key);
            }
            throw new TooLargeException(frame.kind(), frame.id(), true);
        }
        if (!budget.tryReserve(length)) {
            budget.release(partial.size);
            partials.remove(key);
            throw new TooLargeException(frame.kind(), frame.id(), false);
        }
        partial.append(frame.payload());
        if (frame.more()) {
            return null;
        }
        partials.remove(key);
        budget.release(partial.size);
        return Message.of(frame, partial.bytes());
    }

    /**
     * One growing buffer rather than a list of fragments, so a sender of one-byte fragments costs at
     * most twice the budget instead of an object per byte.
     */
    private static final class Partial {
        private final int binary;
        private final long seq;
        private byte[] buffer;
        private int size;
        private boolean dropping;

        Partial(Frame first) {
            this.binary = first.flags() & Frame.BIN;
            this.seq = first.seq();
            this.buffer = new byte[Math.max(256, first.payload().length)];
        }

        void checkContinues(Frame frame) throws FrameException {
            if ((frame.flags() & Frame.BIN) != binary || frame.seq() != seq) {
                throw new FrameException("fragment doesn't match its message");
            }
        }

        void append(byte[] payload) {
            if (size + payload.length > buffer.length) {
                buffer = Arrays.copyOf(buffer, Math.max(buffer.length * 2, size + payload.length));
            }
            System.arraycopy(payload, 0, buffer, size, payload.length);
            size += payload.length;
        }

        byte[] bytes() {
            return size == buffer.length ? buffer : Arrays.copyOf(buffer, size);
        }

        void startDropping() {
            dropping = true;
            size = 0;
            buffer = null;
        }
    }
}
