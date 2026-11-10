package com.minimalistalliance.desk.deskd.protocol;

/** Bytes that break the framing rules. The session that sent them closes with protocol_error. */
public final class FrameException extends Exception {

    private static final long serialVersionUID = 1L;

    public FrameException(String message) {
        super(message, null, false, false);
    }
}
