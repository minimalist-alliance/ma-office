package com.minimalistalliance.desk.deskd.rtc;

/**
 * What desk-rtc tells deskd. Unless noted, these run on the socket's reader thread, in socket order,
 * so they must not block: a parked reader would hold up every session.
 */
public interface RtcListener {

    /** configured arrived: desk-rtc accepts sessions from now on. */
    default void onRtcConfigured() {}

    /** The socket dropped. desk-rtc closes every session when that happens (desk-runtime.md 4.1). */
    default void onRtcDisconnected() {}

    /**
     * session.answer arrived with this handle. Runs before any DATA for that handle is read.
     *
     * @return false if deskd no longer wants the session, so desk-rtc is told to close it
     */
    default boolean onSessionBound(String sessionId, long handle) {
        return true;
    }

    default void onSessionState(String sessionId, String state, String transport) {}

    /** desk-rtc reports a session closed, because deskd asked or on its own. */
    default void onSessionClosed(String sessionId, String reason) {}

    /**
     * desk-rtc 0.4.0, Guild Desk: a session's final counts, from its {@code session.closed}. Runs just before
     * {@link #onSessionClosed}, and also for a session deskd closed itself or already forgot.
     *
     * @param bytesSent what desk-rtc sent the member over the session's whole life
     */
    default void onSessionFinalBytes(String sessionId, String memberId, long bytesSent, long bytesReceived) {}

    /** @param state down, warm or live. Informational (desk-runtime.md 8.4) */
    default void onStreamState(String state) {}

    /** @param at as desk-rtc sent it */
    default void onInputActivity(String sessionId, Object at) {}

    /** One frame on one channel. The session gives the credit back with {@link RtcClient#consumed}. */
    default void onData(long handle, int channel, byte[] frame) {}

    /** The sender ignored its credit. deskd holds no more than the window, so the session ends. */
    default void onCreditOverrun(long handle, int channel) {}

    /**
     * The channel's outbound queue fell under the low-water mark. Runs on the writer thread, with no
     * lock held; it must not block either.
     */
    default void onChannelDrained(long handle, int channel) {}
}
