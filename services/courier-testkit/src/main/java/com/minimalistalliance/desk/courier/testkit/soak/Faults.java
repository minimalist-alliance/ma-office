package com.minimalistalliance.desk.courier.testkit.soak;

import com.minimalistalliance.desk.courier.testkit.FakeBlueBubbles;
import com.minimalistalliance.desk.courier.testkit.FakeMailServer;
import com.minimalistalliance.desk.courier.testkit.FakeRelay;

/**
 * The faults the fakes can make (the launch plan §7's list, the source side). The desk's own faults (deskd killed, the
 * desk stopped, the disk full, the clock skewed) are {@link #hook}s the run on a real desk gives.
 */
public final class Faults {

    private Faults() {}

    /** A fault's two halves. */
    @FunctionalInterface
    public interface Step {
        void run() throws Exception;
    }

    public static Soak.Fault hook(String name, Step begin, Step end) {
        return new Soak.Fault() {
            @Override
            public String name() {
                return name;
            }

            @Override
            public void begin() throws Exception {
                begin.run();
            }

            @Override
            public void end() throws Exception {
                end.run();
            }
        };
    }

    /** The relay and the mail door's store unreachable: every route answers 503. */
    public static Soak.Fault relayDown(FakeRelay relay) {
        return hook("relay-down", () -> relay.setDown(true), () -> relay.setDown(false));
    }

    /** Every ack lost on the way: each envelope comes again until the window ends. */
    public static Soak.Fault relayLosesAcks(FakeRelay relay) {
        return hook("relay-loses-acks", () -> relay.loseNextAcks(Integer.MAX_VALUE), () -> relay.loseNextAcks(0));
    }

    /** Collects return the previous page again, and pages come in a random order. */
    public static Soak.Fault relayDuplicates(FakeRelay relay) {
        return hook("relay-duplicates", () -> {
            relay.duplicateNextFetches(Integer.MAX_VALUE);
            relay.reorderFetches(true);
        }, () -> {
            relay.duplicateNextFetches(0);
            relay.reorderFetches(false);
        });
    }

    /** The member's Mac asleep or its server gone: REST answers 503 and sockets drop. Messages keep arriving on the Mac. */
    public static Soak.Fault imessageGone(FakeBlueBubbles server) {
        return hook("imessage-gone", () -> server.setDown(true), () -> server.setDown(false));
    }

    /** The provider resets a folder's UIDVALIDITY: every UID changes, and the desk must re-sync without doubling. */
    public static Soak.Fault imapUidValidity(FakeMailServer server, String address) {
        return hook("imap-uidvalidity", () -> server.resetUidValidity(address, "INBOX"), () -> { });
    }
}
