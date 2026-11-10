package com.minimalistalliance.desk.deskd.rtc;

import java.util.List;

/**
 * The stats reply of desk-runtime.md 4.3. Feeds the heartbeat.
 *
 * @param bytesSent cumulative, including closed sessions
 * @param bytesReceived cumulative, including closed sessions
 * @param stream null if desk-rtc sent none
 */
public record RtcStats(
        List<SessionStats> sessions, long bytesSent, long bytesReceived, long peerBytesSent, StreamStats stream) {

    /**
     * @param transport udp or tcp; relay once TURN exists
     * @param viewing media flows to this session now (desk-runtime.md 8.4)
     * @param rtpDropped packets this session's sender couldn't take
     * @param memberId a Guild Desk's row: the member's id; null elsewhere
     * @param closed desk-rtc 0.4.0, Guild Desk: the session has closed, and its bytes are final. The row stays in every
     *     stats until deskd lists the session in {@code stats.get}'s {@code ack}
     */
    public record SessionStats(
            String sessionId,
            String transport,
            Double rttMs,
            long bytesSent,
            long bytesReceived,
            boolean viewing,
            long rtpDropped,
            String memberId,
            boolean closed) {

        /** A row with no guild fields, as every desk but a guild's sends. */
        public SessionStats(
                String sessionId, String transport, Double rttMs, long bytesSent, long bytesReceived, boolean viewing, long rtpDropped) {
            this(sessionId, transport, rttMs, bytesSent, bytesReceived, viewing, rtpDropped, null, false);
        }
    }

    /**
     * What desk-rtc says about desk-stream (desk-runtime.md 8.4). Informational; a desk-rtc from before
     * milestone 2 sends none, so {@link RtcStats#stream} can be null.
     *
     * @param state down, warm or live
     */
    public record StreamStats(
            String state, long viewers, long videoPackets, long videoBytes, long audioPackets, long keyframeRequests) {}
}
