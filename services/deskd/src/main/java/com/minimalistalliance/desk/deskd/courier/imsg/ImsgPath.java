package com.minimalistalliance.desk.deskd.courier.imsg;

import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import java.io.IOException;
import java.time.Clock;
import java.util.Map;

/**
 * One way a desk reaches one member's Mac, for one iMessage account (the {@code imsg} seam, ma-desk
 * {@code docs/sub-status/imsg-seam.md}): BlueBubbles Server ({@code bluebubbles}, the member's own server, over HTTPS out
 * from the desk), or MA's own Mac connector ({@code connector}, a paired device, through the sealed relay). A path reads
 * the Mac's messages and hands them to {@link Context#sink()}, and sends what the member wrote; {@link ImsgTransport}
 * does everything else (the account, the outbound queue, the chat a reply goes to, the switches, the status's frame).
 *
 * <p>A path must: store only through the sink (one way in, idempotent on the Mac's guid); keep its place in
 * {@code courier.db}'s cursors, committed with the messages it brought; record the guid each send got before it lets the
 * next page in ({@link Context#recordSent}), so the echo isn't a second message; keep the account's secrets only in the
 * vault ({@link Context#signIn}), never in a row or a log; and never connect anywhere the member didn't name.
 */
public interface ImsgPath {

    /** Starts reading the Mac: at once, then as the path sees fit. */
    void start();

    /** Stops for good: the account is going, or deskd is stopping. */
    void stop();

    /**
     * The member removed the account (not deskd stopping): a path with a peer to tell or a pairing to end does it here, then
     * stops. MA's Mac connector ends its pairing on the platform, so the Mac forgets it too.
     */
    default void removed() {
        stop();
    }

    /** Look now: "Check again", a switch turned back on, a send just done. */
    void poke();

    /**
     * What the office's Accounts row shows (API.md §21, {@code courier.accounts.list}'s {@code sync}): at least
     * {@code state} ({@code connecting}, {@code syncing}, {@code live}, {@code away}, {@code needs_you}, {@code off}),
     * {@code reason} and {@code path}; never an address, a password or a key.
     */
    Map<String, Object> status();

    /** Sends one message to one chat. Interrupted means deskd is stopping: the queue keeps the row. */
    ImsgSend.Result send(ImsgSend send) throws InterruptedException;

    /** What a path is given. */
    interface Context {
        String accountId();

        CourierStore store();

        ImsgSink sink();

        /** The account's sealed sign-in, which the caller closes once used; an IOException means "Sign in again". */
        SignIn signIn() throws IOException;

        Clock clock();

        /** Whether it may read now: Courier usable, and neither {@code imessage-off} nor {@code off}. */
        boolean receiving();

        /** Whether it may send now: receiving, and neither {@code send-off} nor {@code imessage-send-off}. */
        boolean sending();

        /** Before a send's call returns: the guid the Mac gave the message Courier sent. */
        void recordSent(String guid, String messageId) throws java.sql.SQLException;

        /** The account's state changed: the office reads it again ({@code courier.changed}'s accounts flag). */
        void changed();
    }

    /** Opens a path of one kind for an account. */
    @FunctionalInterface
    interface Factory {
        ImsgPath open(Context context);
    }
}
