package com.minimalistalliance.desk.deskd.session;

import java.util.Set;

/**
 * CLOSE codes on ctl (design 4.2.7). 4000 to 4399 are Desk-defined; the others are the design's.
 * Reasons use Platform's words where one fits (gateway.md 2.3).
 */
public final class CloseCodes {

    /** The gateway ended the session and nothing went wrong, such as the client leaving. */
    public static final int NORMAL = 1000;
    /** The frames or JSON broke the protocol. */
    public static final int PROTOCOL_ERROR = 4000;
    /** Too many or too large incomplete messages. */
    public static final int TOO_LARGE = 4001;
    /** deskd is restarting, and as far as it knows the desk isn't stopping. */
    public static final int DESKD_RESTARTING = 4002;
    /** deskd failed on its side. */
    public static final int INTERNAL = 4003;
    public static final int TOKEN_EXPIRED_OR_REVOKED = 4401;
    public static final int FORBIDDEN = 4403;
    public static final int REPLACED = 4409;
    public static final int DESK_API_MISMATCH = 4426;
    public static final int RATE_LIMITED = 4429;
    public static final int DESK_STOPPING = 4503;

    public static final String REASON_CLOSED_BY_CLIENT = "closed_by_client";
    public static final String REASON_CLOSED_BY_DESK = "closed_by_desk";
    public static final String REASON_TOKEN_EXPIRED = "token_expired";
    public static final String REASON_REVOKED = "revoked";
    public static final String REASON_DESK_STOPPING = "desk_stopping";
    /** On ctl only: it isn't on gateway.md 2.3's list, so the gateway hears closed_by_desk. */
    public static final String REASON_DESKD_RESTARTING = "deskd_restarting";
    public static final String REASON_IDENTITY_MISMATCH = "identity_mismatch";
    public static final String REASON_REPLACED = "replaced";
    public static final String REASON_CREDIT_VIOLATION = "credit_violation";
    /** The gateway gave up waiting for the client, which may yet come back on a new connection. */
    public static final String REASON_CLIENT_GONE = "client_gone";

    /**
     * desk-rtc 0.4.0, Guild Desk, its own reasons: a member's client sent data on a stream that isn't one of the eight
     * channels or broke an SCTP limit, and a stalled member's queue passed the desk's budget. Neither is on
     * gateway.md 2.3's list, so the gateway hears closed_by_desk. There is no CLOSE for the client: desk-rtc has
     * already ended its connection.
     */
    public static final String REASON_RTC_PROTOCOL_ERROR = "protocol_error";
    public static final String REASON_RTC_OVER_BUDGET = "over_budget";

    private static final Set<String> GATEWAY_REASONS = Set.of(
            REASON_CLOSED_BY_CLIENT,
            REASON_CLOSED_BY_DESK,
            REASON_TOKEN_EXPIRED,
            REASON_REVOKED,
            REASON_DESK_STOPPING,
            "desk_disconnected",
            REASON_CLIENT_GONE,
            REASON_IDENTITY_MISMATCH,
            REASON_REPLACED);

    private CloseCodes() {}

    /** The CLOSE code for a session.close from the gateway. */
    public static int forGatewayReason(String reason) {
        if (reason == null) {
            return NORMAL;
        }
        return switch (reason) {
            case REASON_TOKEN_EXPIRED, REASON_REVOKED -> TOKEN_EXPIRED_OR_REVOKED;
            case REASON_DESK_STOPPING -> DESK_STOPPING;
            case REASON_REPLACED -> REPLACED;
            case REASON_IDENTITY_MISMATCH -> FORBIDDEN;
            default -> NORMAL;
        };
    }

    /** The reason to give the gateway: itself if gateway.md 2.3 lists it, or else closed_by_desk. */
    static String forGateway(String reason) {
        if (REASON_RTC_PROTOCOL_ERROR.equals(reason) || REASON_RTC_OVER_BUDGET.equals(reason)) {
            return REASON_CLOSED_BY_DESK;
        }
        return reason != null && GATEWAY_REASONS.contains(reason) ? reason : REASON_CLOSED_BY_DESK;
    }
}
