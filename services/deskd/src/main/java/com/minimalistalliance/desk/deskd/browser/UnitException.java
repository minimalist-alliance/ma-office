package com.minimalistalliance.desk.deskd.browser;

import java.time.Instant;

/**
 * A unit request that didn't end in {@code ok}. The code goes to the client; {@link #text} is desk-units'
 * own words, for the log only.
 */
public final class UnitException extends Exception {

    private static final long serialVersionUID = 1L;

    /** desk-runtime.md 8.3 lists denied, bad_request, failed and timeout. These are deskd's own. */
    public static final String UNREACHABLE = "unreachable";
    public static final String BAD_REPLY = "bad_reply";
    public static final String TIMEOUT = "timeout";
    public static final String INTERNAL = "internal";
    /** No unit was asked: the Browser is held for a copy of its profile ({@link BrowserStream#hold}). */
    public static final String HELD = "held";
    /** No unit was asked: the Platform has paused this member's streaming at a bandwidth limit (ma-platform ADR 0095). */
    public static final String PAUSED = "paused";
    /** No unit was asked: a start of Chromium has to wait for the owner's age band ({@link BrowserStream#ageGateFrom}). */
    public static final String AGE_BAND = "age_band";
    /** No unit was asked: a free desk's Browser time for the day is used up (ADR 0090, {@link BrowserStream#timeUsedFrom}). */
    public static final String BROWSER_TIME = "browser_time";

    private static final String FAILED = "failed";
    /** desk-units: a freeze refused because the desk is working: {@code sound} or {@code download} in the text (ADR 0045). */
    static final String BUSY = "busy";
    /** desk-units: a freeze of a unit that isn't running. */
    static final String INACTIVE = "inactive";
    /** desk-units: a request it doesn't know, as a freeze is to one before ADR 0045. */
    static final String BAD_REQUEST = "bad_request";
    static final String DENIED = "denied";
    /** How desk-units begins its text for a failed start of desk-browser. */
    private static final String BROWSER_START_TEXT = "start desk-browser:";
    /** desk-browser-start's own words when it won't start Chromium on this profile (ADR 0035). */
    private static final String REFUSED_MARKER = "REFUSING TO START";

    private final String unit;
    private final String code;
    private final String text;

    UnitException(String unit, String code, String text) {
        super(code, null, false, false);
        this.unit = unit;
        this.code = code;
        this.text = text;
    }

    /** A {@code live} or {@code warm} refused because the Browser is held. */
    static UnitException held() {
        return new UnitException(UnitsClient.DESK_BROWSER, HELD, null);
    }

    /** A {@code live} that has to wait for the owner's age band. */
    static UnitException ageBand() {
        return new UnitException(UnitsClient.DESK_BROWSER, AGE_BAND, null);
    }

    /** {@link #ageBand}: nothing was asked of units.sock. desk-units never answers with this code. */
    boolean isAgeBand() {
        return AGE_BAND.equals(code);
    }

    /**
     * A {@code live} refused because the Platform's bandwidth pause is on. {@link #text} carries when it ends, or null if
     * the Platform didn't say.
     */
    static UnitException paused(Instant until) {
        return new UnitException(UnitsClient.DESK_BROWSER, PAUSED, until == null || until.equals(Instant.MAX) ? null : until.toString());
    }

    /** {@link #paused}: nothing was asked of units.sock. desk-units never answers with this code. */
    boolean isPaused() {
        return PAUSED.equals(code);
    }

    /** For {@link #paused}, when the pause ends, as the Platform's ISO time, or null. */
    String resumesAt() {
        return isPaused() ? text : null;
    }

    /** A {@code live} refused because today's Browser time is used up. {@link #text} carries when it resets. */
    static UnitException timeUsed(java.time.Instant resetsAt) {
        return new UnitException(UnitsClient.DESK_BROWSER, BROWSER_TIME, resetsAt.toString());
    }

    /** {@link #timeUsed}: nothing was asked of units.sock. desk-units never answers with this code. */
    boolean isTimeUsed() {
        return BROWSER_TIME.equals(code);
    }

    /** For {@link #timeUsed}, when the day resets, as an ISO time. */
    String resetsAt() {
        return isTimeUsed() ? text : null;
    }

    /** {@link #held}: nothing was asked of units.sock. */
    boolean isHeld() {
        return HELD.equals(code) && text == null;
    }

    /** A freeze desk-units didn't do and needn't be thawed: the desk was busy, or Chromium wasn't running. */
    boolean freezeDeclined() {
        return BUSY.equals(code) || INACTIVE.equals(code);
    }

    /** desk-units doesn't know the verb, so this image can't freeze at all, and nothing it did froze anything. */
    boolean verbUnknown() {
        return BAD_REQUEST.equals(code) || DENIED.equals(code);
    }

    public String unit() {
        return unit;
    }

    public String code() {
        return code;
    }

    public String text() {
        return text;
    }

    /**
     * desk-units asked desk-browser-start before starting Chromium, and it refused: the profile last ran a newer
     * Chromium, or the two versions can't be compared (desk-runtime.md 8.3, ADR 0035). This is the one place that
     * recognizes it. Retrying can't help until something on the desk is fixed: a newer image, or Chromium updated in
     * place.
     */
    boolean browserRefused() {
        return UnitsClient.DESK_BROWSER.equals(unit)
                && FAILED.equals(code)
                && text != null
                && text.startsWith(BROWSER_START_TEXT)
                && text.contains(REFUSED_MARKER);
    }
}
