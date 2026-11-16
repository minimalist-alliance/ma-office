package com.minimalistalliance.desk.courier.testkit.soak;

import com.minimalistalliance.desk.courier.testkit.FakeBlueBubbles;
import com.minimalistalliance.desk.courier.testkit.FakeMailServer;
import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.courier.testkit.PeerDesk;
import java.nio.charset.StandardCharsets;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Map;

/**
 * The soak's sources, one per Courier channel, each carrying the item's marker where the desk will show it: an email's
 * subject and {@code Message-ID}, a member message's text, an iMessage's text. Names match {@link Soak.Plan#launchBar}.
 */
public final class Channels {

    private Channels() {}

    /** A linked mailbox: a plain email into the user's INBOX at the fake provider. */
    public static Soak.Channel imap(FakeMailServer server, String address) {
        return new Soak.Channel() {
            @Override
            public String name() {
                return "imap";
            }

            @Override
            public void inject(Soak.Item item) {
                server.deliver(address, email(item, address));
            }
        };
    }

    /** The desk's own address: an email the fake mail door seals to the desk. */
    public static Soak.Channel door(FakeRelay relay, String rcpt) {
        return new Soak.Channel() {
            @Override
            public String name() {
                return "door";
            }

            @Override
            public void inject(Soak.Item item) {
                relay.deliverMail(rcpt, email(item, rcpt), "soak@example.org", Map.of("spf", "PASS", "dkim", "PASS", "dmarc", "PASS"));
            }
        };
    }

    /** Another member: a sealed message from a fake peer desk, through the relay's HTTP routes. */
    public static Soak.Channel member(PeerDesk from, String to) {
        return new Soak.Channel() {
            @Override
            public String name() {
                return "ma";
            }

            @Override
            public void inject(Soak.Item item) throws Exception {
                from.send(to, item.marker(), null);
            }
        };
    }

    /** iMessage: a message arriving on the member's Mac, in one chat. */
    public static Soak.Channel imessage(FakeBlueBubbles server, String chatGuid, String fromAddress) {
        return new Soak.Channel() {
            @Override
            public String name() {
                return "imessage";
            }

            @Override
            public void inject(Soak.Item item) {
                server.receive(chatGuid, fromAddress, item.marker());
            }
        };
    }

    /** A small, plain RFC 5322 message: the marker in its subject, its Message-ID and its body. */
    public static byte[] email(Soak.Item item, String to) {
        String date = DateTimeFormatter.RFC_1123_DATE_TIME.format(item.at().atOffset(ZoneOffset.UTC));
        return ("From: Soak <soak@example.org>\r\nTo: " + to + "\r\nSubject: " + item.marker() + "\r\nMessage-ID: <" + item.marker()
                + "@soak.invalid>\r\nDate: " + date + "\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSoak message " + item.marker()
                + ".\r\n").getBytes(StandardCharsets.UTF_8);
    }
}
