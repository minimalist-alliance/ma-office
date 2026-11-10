package com.minimalistalliance.desk.deskd.protocol;

/** A whole message after reassembly: one frame, or several joined. */
public record Message(FrameKind kind, boolean binary, boolean end, long id, long seq, byte[] payload) {

    static Message of(Frame frame, byte[] payload) {
        return new Message(
                frame.kind(),
                (frame.flags() & Frame.BIN) != 0,
                (frame.flags() & Frame.END) != 0,
                frame.id(),
                frame.seq(),
                payload);
    }
}
