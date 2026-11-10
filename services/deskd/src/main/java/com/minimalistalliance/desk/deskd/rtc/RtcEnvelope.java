package com.minimalistalliance.desk.deskd.rtc;

import java.nio.ByteBuffer;

/**
 * The rtc.sock envelope (desk-runtime.md 4.2): u32be length of what follows, u8 type, body.
 *
 * <p>Length counts the type byte and the body, and is at most 64 KiB.
 */
final class RtcEnvelope {

    static final int TYPE_JSON = 0x01;
    static final int TYPE_DATA = 0x02;
    static final int TYPE_CREDIT = 0x03;

    static final int LENGTH_BYTES = 4;
    static final int MAX_LENGTH = 64 * 1024;
    /** type, handle and channel: what a DATA envelope adds to the length besides the frame. */
    static final int DATA_PREFIX_BYTES = 1 + 4 + 1;
    private static final int CREDIT_LENGTH = 1 + 4 + 1 + 4;

    private RtcEnvelope() {}

    static byte[] json(byte[] body) {
        if (1 + body.length > MAX_LENGTH) {
            throw new IllegalArgumentException("rtc message over 64 KiB");
        }
        ByteBuffer out = ByteBuffer.allocate(LENGTH_BYTES + 1 + body.length);
        out.putInt(1 + body.length);
        out.put((byte) TYPE_JSON);
        out.put(body);
        return out.array();
    }

    static byte[] credit(long handle, int channel, long bytes) {
        ByteBuffer out = ByteBuffer.allocate(LENGTH_BYTES + CREDIT_LENGTH);
        out.putInt(CREDIT_LENGTH);
        out.put((byte) TYPE_CREDIT);
        out.putInt((int) handle);
        out.put((byte) channel);
        out.putInt((int) bytes);
        return out.array();
    }

    /** Writes a DATA envelope in place, so a frame costs no extra allocation on its way out. */
    static void putData(ByteBuffer out, long handle, int channel, byte[] frame) {
        out.putInt(DATA_PREFIX_BYTES + frame.length);
        out.put((byte) TYPE_DATA);
        out.putInt((int) handle);
        out.put((byte) channel);
        out.put(frame);
    }

    static int dataEnvelopeBytes(byte[] frame) {
        return LENGTH_BYTES + DATA_PREFIX_BYTES + frame.length;
    }
}
