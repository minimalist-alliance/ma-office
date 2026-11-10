package com.minimalistalliance.desk.deskd.session;

/**
 * Verifies desk tokens. It's the only way a session comes to exist. deskd has one implementation,
 * DeskTokenVerifier; tests of the data plane use a stub. Calls may block, and implementations must
 * never log a token.
 */
public interface SessionAuthorizer {

    /** Whether a verified token may open a session right now, such as whether the desk has a slot. */
    @FunctionalInterface
    interface Admission {
        void check(SessionGrant grant) throws RefusedException;
    }

    /** Checks a token from session.open. */
    default SessionGrant authorizeOpen(String deskToken) throws RefusedException {
        return authorizeOpen(deskToken, grant -> {});
    }

    /**
     * Checks a token from session.open, then asks whether it may open a session. A token that the
     * admission turns away hasn't been used up, so a client can try it again.
     */
    SessionGrant authorizeOpen(String deskToken, Admission admission) throws RefusedException;

    /** Checks a token from session.refresh or AUTH against the session it's meant to extend. */
    SessionGrant authorizeRefresh(String deskToken, SessionGrant current) throws RefusedException;

    /** True if a revocation now covers what this grant was made from. */
    boolean isRevoked(SessionGrant grant);

    /** The token, offer or session was refused. The code goes to the gateway or the client. */
    final class RefusedException extends Exception {
        private static final long serialVersionUID = 1L;

        private final String code;

        public RefusedException(String code) {
            super(code, null, false, false);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }
}
