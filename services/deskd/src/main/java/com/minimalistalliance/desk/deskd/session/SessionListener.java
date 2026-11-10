package com.minimalistalliance.desk.deskd.session;

/**
 * What the Browser and data modules follow about sessions. Everything here may run on the rtc reader thread, so
 * nothing may block.
 */
public interface SessionListener {

    /** A session has been admitted, with a verified token, before its offer. */
    default void onSessionOpened(String sessionId) {}

    /** A session has ended, whichever way: closed, revoked, expired, replaced or lost with desk-rtc. */
    default void onSessionEnded(String sessionId) {}

    /**
     * desk-rtc 0.4.0 told a guild session's final counts, in its {@code session.closed}. May come before or after
     * {@link #onSessionEnded}, since deskd's own close ends a session first. Not for sessions of other desks.
     */
    default void onSessionFinalBytes(String sessionId, String memberId, long bytesSent, long bytesReceived) {}

    /** @param state what desk-rtc last said about desk-stream: down, warm or live */
    default void onStreamState(String state) {}

    /**
     * desk-rtc put a session's input on the desk's screen: its {@code input.activity}, which comes with the first event
     * after a second without any. Not a client's own ACTIVITY, which is input it handled locally.
     */
    default void onDeskInput(String sessionId) {}

    /**
     * A refresh changed who the session's caller is, short of the person: a guild member's role, grants, name, badge or
     * teen flag. A relay that told a service who the caller is tells it again.
     */
    default void onCallerChanged(String sessionId) {}
}
