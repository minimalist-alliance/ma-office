package com.minimalistalliance.desk.deskd.protocol;

/**
 * A message went over a limit. Its bytes are already released.
 *
 * <p>When {@code recoverable} is true, only this message is lost: the rest of its frames are dropped
 * as they arrive, and a request can be answered with too_large. Otherwise the sender has too many
 * incomplete messages or too many bytes held, and its session has to close.
 */
public final class TooLargeException extends Exception {

    private static final long serialVersionUID = 1L;

    private final transient FrameKind kind;
    private final long id;
    private final boolean recoverable;

    TooLargeException(FrameKind kind, long id, boolean recoverable) {
        super("message over limit", null, false, false);
        this.kind = kind;
        this.id = id;
        this.recoverable = recoverable;
    }

    public FrameKind kind() {
        return kind;
    }

    public long id() {
        return id;
    }

    public boolean recoverable() {
        return recoverable;
    }
}
