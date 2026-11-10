package com.minimalistalliance.desk.deskd.data;

import java.util.Set;

/**
 * A request to desk-data that didn't end in {@code ok}. The code is the helper's own, from the Appendix's list, or one of
 * deskd's. Never carries the helper's message, which can name a path.
 */
final class HelperException extends Exception {

    private static final long serialVersionUID = 1L;

    /** deskd's: no socket, a refused or dropped connection, a timeout, or a reply that isn't the protocol. */
    static final String UNAVAILABLE = "unavailable";
    /** deskd's: the request line is over the Appendix's 16 KiB, as a very long path or cursor makes it. */
    static final String REQUEST_TOO_LONG = "request_too_long";
    /** deskd's: the reply's header line is over what the caller takes. */
    static final String REPLY_TOO_LONG = "reply_too_long";

    static final String DENIED = "denied";
    static final String BAD_REQUEST = "bad_request";
    static final String NOT_FOUND = "not_found";
    static final String INVALID = "invalid";
    static final String FAILED = "failed";

    private static final Set<String> HELPER_CODES = Set.of(DENIED, BAD_REQUEST, NOT_FOUND, INVALID, FAILED);

    private final String code;

    HelperException(String code) {
        super(code, null, false, false);
        this.code = code;
    }

    String code() {
        return code;
    }

    static boolean isHelperCode(String code) {
        return code != null && HELPER_CODES.contains(code);
    }
}
