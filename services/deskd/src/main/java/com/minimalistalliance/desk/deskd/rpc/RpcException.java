package com.minimalistalliance.desk.deskd.rpc;

import java.util.Map;

/**
 * An error the client should see. The code and message go on the wire as written, so a handler must
 * not put payload or anything secret in them. Any other exception from a handler becomes
 * {@code internal} with a fixed message.
 */
public final class RpcException extends Exception {

    private static final long serialVersionUID = 1L;

    // Design 4.2.5, the complete list.
    public static final String BAD_REQUEST = "bad_request";
    public static final String UNAUTHORIZED = "unauthorized";
    public static final String FORBIDDEN = "forbidden";
    public static final String STEP_UP_REQUIRED = "step_up_required";
    public static final String NOT_FOUND = "not_found";
    public static final String PRECONDITION_FAILED = "precondition_failed";
    public static final String CONFLICT = "conflict";
    public static final String TOO_LARGE = "too_large";
    public static final String RATE_LIMITED = "rate_limited";
    public static final String DEADLINE_EXCEEDED = "deadline_exceeded";
    public static final String CANCELLED = "cancelled";
    public static final String UNAVAILABLE = "unavailable";
    public static final String INTERNAL = "internal";

    private final String code;
    private final transient Map<String, Object> details;

    public RpcException(String code, String message) {
        this(code, message, Map.of());
    }

    public RpcException(String code, String message, Map<String, Object> details) {
        super(message, null, false, false);
        this.code = code;
        this.details = details;
    }

    public String code() {
        return code;
    }

    public Map<String, Object> details() {
        return details;
    }
}
