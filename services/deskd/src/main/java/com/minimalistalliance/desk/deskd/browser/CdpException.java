package com.minimalistalliance.desk.deskd.browser;

/**
 * A CDP call that didn't get a result. It holds no words from Chromium: they can quote a URL, and this
 * class's message is only ever the kind.
 */
final class CdpException extends Exception {

    private static final long serialVersionUID = 1L;

    enum Kind {
        /** There's no connection, or it went while the call was out. */
        DISCONNECTED,
        /** It went out, and no reply came in the call's time. */
        TIMEOUT,
        /** It never went out: too many are out already, or no session for it came in time. */
        NOT_SENT,
        /** Chromium answered with an error. */
        REMOTE
    }

    /** Chromium's code for "no target with this id", which is also its generic invalid params. */
    static final int INVALID_PARAMS = -32602;
    /** deskd's own code: the reply was past what deskd reads in one message, so it was cut or dropped (minified's CdpFailure). */
    static final int TOO_LARGE = -1;
    /** Chromium's code for "session with given id not found". */
    static final int SESSION_NOT_FOUND = -32001;

    private final Kind kind;
    private final int code;

    private CdpException(Kind kind, int code) {
        super(kind.name(), null, false, false);
        this.kind = kind;
        this.code = code;
    }

    static CdpException disconnected() {
        return new CdpException(Kind.DISCONNECTED, 0);
    }

    static CdpException timeout() {
        return new CdpException(Kind.TIMEOUT, 0);
    }

    static CdpException notSent() {
        return new CdpException(Kind.NOT_SENT, 0);
    }

    static CdpException remote(int code) {
        return new CdpException(Kind.REMOTE, code);
    }

    Kind kind() {
        return kind;
    }

    int code() {
        return code;
    }
}
