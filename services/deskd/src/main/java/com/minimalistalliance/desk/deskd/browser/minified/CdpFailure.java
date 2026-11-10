package com.minimalistalliance.desk.deskd.browser.minified;

/**
 * A command to Chromium that got no result, as the Browser's own client reports it. Like that client's exception it
 * holds no words from Chromium, as they can quote a URL: only the kind and the code.
 */
public final class CdpFailure extends Exception {

    private static final long serialVersionUID = 1L;

    public enum Kind {
        /** No connection, or it went while the command was out. */
        DISCONNECTED,
        /** It went out, and no reply came in time. */
        TIMEOUT,
        /** It never went out. */
        NOT_SENT,
        /** Chromium answered with an error. */
        REMOTE,
        /** The tab isn't there any more. */
        GONE
    }

    /** Chromium's code for a context or object that's gone, as a navigation leaves an isolated world's calls. */
    public static final int SERVER_ERROR = -32000;
    /** deskd's own code: the reply was past what deskd reads from Chromium in one message, and was dropped. */
    public static final int TOO_LARGE = -1;
    /** deskd's own code: the call reached the world, and deskd's script there threw. */
    public static final int SCRIPT_THREW = -2;

    private final Kind kind;
    private final int code;

    public CdpFailure(Kind kind, int code) {
        super(kind.name(), null, false, false);
        this.kind = kind;
        this.code = code;
    }

    public Kind kind() {
        return kind;
    }

    public int code() {
        return code;
    }

    /** The reply was too large to read. */
    public boolean tooLarge() {
        return kind == Kind.REMOTE && code == TOO_LARGE;
    }

    /** The command went out, so it may have done what it was for. */
    public boolean mayHaveApplied() {
        return kind == Kind.TIMEOUT || kind == Kind.REMOTE;
    }
}
