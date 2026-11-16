package com.minimalistalliance.desk.courier.parse;

/**
 * Why the Courier mode won't read something, as one word on the answer line ({@code ERR <reason>}). It carries no part of
 * what was read, and no stack.
 */
public final class Refusal extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public static final String TOO_LARGE = "too_large";
    public static final String TOO_DEEP = "too_deep";
    public static final String TOO_MANY_PARTS = "too_many_parts";
    public static final String TIMEOUT = "timeout";
    public static final String MALFORMED = "malformed";
    public static final String TOO_COMPLEX = "too_complex";
    public static final String UNSUPPORTED = "unsupported";
    public static final String NOT_FOUND = "not_found";
    public static final String BAD_REQUEST = "bad_request";

    private final String reason;

    public Refusal(String reason) {
        super(reason, null, false, false);
        this.reason = reason;
    }

    public String reason() {
        return reason;
    }
}
