package com.minimalistalliance.desk.deskd.protocol;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;

/**
 * One frame on channels 0 to 5, exactly as design 4.2.4 lays it out: ver, kind, flags, reserved, then
 * id and seq as big-endian u32, then the payload. A frame is at most 16 KiB, header included.
 *
 * @param id unsigned, 0 to 2^32-1
 * @param seq unsigned, 0 to 2^32-1
 */
public record Frame(FrameKind kind, int flags, long id, long seq, byte[] payload) {

    public static final int VERSION = 1;
    public static final int HEADER_BYTES = 12;
    public static final int MAX_FRAME_BYTES = 16 * 1024;
    public static final int MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - HEADER_BYTES;

    /** The message continues in the next frame with the same kind and id. */
    public static final int MORE = 1;
    /** Raw bytes; otherwise UTF-8 JSON. */
    public static final int BIN = 2;
    /** Last chunk of a transfer. */
    public static final int END = 4;

    private static final int KNOWN_FLAGS = MORE | BIN | END;
    private static final long MAX_U32 = 0xFFFFFFFFL;

    public Frame {
        if (id < 0 || id > MAX_U32 || seq < 0 || seq > MAX_U32) {
            throw new IllegalArgumentException("id and seq must fit u32");
        }
        if (payload.length > MAX_PAYLOAD_BYTES) {
            throw new IllegalArgumentException("payload over one frame");
        }
    }

    public boolean more() {
        return (flags & MORE) != 0;
    }

    public byte[] encode() {
        if (kind == FrameKind.UNKNOWN) {
            throw new IllegalArgumentException("unknown kind can't be sent");
        }
        ByteBuffer out = ByteBuffer.allocate(HEADER_BYTES + payload.length);
        writeHeader(out, kind, flags, id, seq);
        out.put(payload);
        return out.array();
    }

    /** Rejects a wrong version, a set reserved byte, unknown flags and bad sizes; unknown kinds pass. */
    public static Frame decode(byte[] bytes) throws FrameException {
        if (bytes.length < HEADER_BYTES) {
            throw new FrameException("frame shorter than its header");
        }
        if (bytes.length > MAX_FRAME_BYTES) {
            throw new FrameException("frame over 16 KiB");
        }
        ByteBuffer in = ByteBuffer.wrap(bytes);
        int version = in.get() & 0xFF;
        if (version != VERSION) {
            throw new FrameException("unsupported frame version");
        }
        FrameKind kind = FrameKind.fromCode(in.get() & 0xFF);
        int flags = in.get() & 0xFF;
        if ((flags & ~KNOWN_FLAGS) != 0) {
            throw new FrameException("unknown frame flags");
        }
        if (in.get() != 0) {
            throw new FrameException("reserved byte set");
        }
        long id = in.getInt() & MAX_U32;
        long seq = in.getInt() & MAX_U32;
        byte[] payload = new byte[in.remaining()];
        in.get(payload);
        return new Frame(kind, flags, id, seq, payload);
    }

    /**
     * Encodes a message as frames of at most 16 KiB. Every frame but the last carries MORE, END can
     * only be on the last, and all of them carry the same kind, id, seq and BIN. An empty message is
     * one frame.
     *
     * @param flags BIN and END as the message needs them
     */
    public static List<byte[]> fragment(FrameKind kind, int flags, long id, long seq, byte[] payload) {
        List<byte[]> frames = new ArrayList<>(payload.length / MAX_PAYLOAD_BYTES + 1);
        fragments(kind, flags, id, seq, payload).forEach(frames::add);
        return frames;
    }

    /**
     * {@link #fragment}, encoding each frame only as it's asked for, so a caller that parks between frames never holds
     * a long message twice: a 4 MiB DATA costs one frame on top of its payload.
     */
    public static Iterable<byte[]> fragments(FrameKind kind, int flags, long id, long seq, byte[] payload) {
        if (payload.length <= MAX_PAYLOAD_BYTES) {
            return List.of(new Frame(kind, flags & ~MORE, id, seq, payload).encode());
        }
        return () -> new Iterator<>() {
            private int offset;

            @Override
            public boolean hasNext() {
                return offset < payload.length;
            }

            @Override
            public byte[] next() {
                if (!hasNext()) {
                    throw new NoSuchElementException();
                }
                int length = Math.min(MAX_PAYLOAD_BYTES, payload.length - offset);
                boolean last = offset + length == payload.length;
                ByteBuffer out = ByteBuffer.allocate(HEADER_BYTES + length);
                writeHeader(out, kind, last ? flags & ~MORE : flags & BIN | MORE, id, seq);
                out.put(payload, offset, length);
                offset += length;
                return out.array();
            }
        };
    }

    private static void writeHeader(ByteBuffer out, FrameKind kind, int flags, long id, long seq) {
        out.put((byte) VERSION);
        out.put((byte) kind.code());
        out.put((byte) flags);
        out.put((byte) 0);
        out.putInt((int) id);
        out.putInt((int) seq);
    }
}
