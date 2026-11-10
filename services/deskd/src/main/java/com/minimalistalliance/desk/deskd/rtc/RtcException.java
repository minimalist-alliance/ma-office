package com.minimalistalliance.desk.deskd.rtc;

/**
 * desk-rtc refused a request, or couldn't be asked.
 *
 * <p>The code is one of desk-runtime.md 4.3's (not_configured, session_limit_reached,
 * identity_mismatch, bad_offer, internal), one of the clipboard's (no_display, timeout, too_large,
 * internal: desk-rtc/README.md), or one of deskd's: unavailable (no connection), timeout (no reply in
 * time), no_reply (the clipboard's own: no reply in time, or a connection whose clipboard never
 * answers) and closed (the session ended first).
 */
public final class RtcException extends Exception {

    private static final long serialVersionUID = 1L;

    private final String code;

    public RtcException(String code) {
        super(code, null, false, false);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
