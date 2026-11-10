package com.minimalistalliance.desk.deskd.protocol;

/**
 * Frame kinds (design 4.2.4). The design names them without numbers; these numbers are the wire
 * values, published in docs/API.md and in the golden vectors.
 *
 * <p>Each kind has a limit on the reassembled message. Design 4.2.4 sets those of REQ, RES, EVT and
 * DATA. The control kinds are small, so they share 64 KiB. A CHUNK is one frame.
 */
public enum FrameKind {
    /** Any code this version doesn't know. Receivers ignore these frames; nothing can send one. */
    UNKNOWN(0, 0),
    HELLO(1, Limits.KIB_64),
    AUTH(2, Limits.KIB_64),
    ACTIVITY(3, Limits.KIB_64),
    PING(4, Limits.KIB_64),
    PONG(5, Limits.KIB_64),
    CLOSE(6, Limits.KIB_64),
    REQ(7, Limits.MIB_1),
    RES(8, Limits.MIB_1),
    ERR(9, Limits.KIB_64),
    SUB(10, Limits.KIB_64),
    UNSUB(11, Limits.KIB_64),
    EVT(12, Limits.KIB_64),
    CANCEL(13, Limits.KIB_64),
    DATA(14, 4 * Limits.MIB_1),
    CHUNK(15, Frame.MAX_PAYLOAD_BYTES),
    CREDIT(16, Limits.KIB_64);

    private static final FrameKind[] BY_CODE = values();

    private final int code;
    private final int maxMessageBytes;

    FrameKind(int code, int maxMessageBytes) {
        this.code = code;
        this.maxMessageBytes = maxMessageBytes;
    }

    public int code() {
        return code;
    }

    /** The largest payload this kind may reassemble to. */
    public int maxMessageBytes() {
        return maxMessageBytes;
    }

    /** True for the kinds a client answers with RES or ERR, so an oversize one fails on its own. */
    public boolean isRequest() {
        return this == REQ || this == SUB || this == UNSUB;
    }

    static FrameKind fromCode(int code) {
        return code > 0 && code < BY_CODE.length ? BY_CODE[code] : UNKNOWN;
    }

    private static final class Limits {
        static final int KIB_64 = 64 * 1024;
        static final int MIB_1 = 1024 * 1024;
    }
}
