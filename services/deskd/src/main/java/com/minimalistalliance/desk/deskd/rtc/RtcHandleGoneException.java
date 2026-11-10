package com.minimalistalliance.desk.deskd.rtc;

/** The session a frame was for has ended, so the frame can't be sent. */
public final class RtcHandleGoneException extends Exception {

    private static final long serialVersionUID = 1L;

    public RtcHandleGoneException() {
        super("rtc handle gone", null, false, false);
    }
}
