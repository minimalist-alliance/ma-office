package com.minimalistalliance.desk.deskd.session;

/**
 * Lets the control plane follow sessions. Everything here may run on the rtc reader thread, so
 * nothing may block.
 */
public interface SessionObserver {

    /**
     * A session ended, so the gateway needs a session.close.
     *
     * @param reason a reason from gateway.md 2.3's list; anything else has become closed_by_desk
     */
    void onSessionClosed(String sessionId, String reason);

    /**
     * An offer was refused, so the client needs a refusal. If the session ends over it, this comes
     * first, because the client expects the refusal and then session.closed.
     */
    default void onOfferRefused(String sessionId, String code) {}

    /** The number of connected clients may have changed. */
    default void onClientsChanged() {}

    /** desk-rtc answered configure, on first connecting or after a restart. */
    default void onRtcConfigured() {}
}
