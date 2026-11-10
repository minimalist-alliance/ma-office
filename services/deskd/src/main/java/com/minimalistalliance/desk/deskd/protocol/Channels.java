package com.minimalistalliance.desk.deskd.protocol;

/** Data channels 0 to 5 (design 4.2.3). desk-rtc keeps 6 (input) and 7 (keys) to itself. */
public final class Channels {

    public static final int CTL = 0;
    public static final int RPC = 1;
    public static final int EVENTS = 2;
    public static final int COLLAB = 3;
    public static final int MDOC = 4;
    public static final int BULK = 5;

    /** How many channels reach deskd. */
    public static final int COUNT = 6;

    /** The send priority of design 4.2.6, without the channels desk-rtc handles alone. */
    private static final int[] PRIORITY = {CTL, RPC, MDOC, EVENTS, COLLAB, BULK};

    private Channels() {}

    public static boolean isValid(int channel) {
        return channel >= 0 && channel < COUNT;
    }

    /** The channel in the given place of the send order: 0 is sent first. */
    public static int byPriority(int place) {
        return PRIORITY[place];
    }
}
