package com.minimalistalliance.desk.deskd.courier.linked;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.testkit.FakeImapServer;
import com.minimalistalliance.desk.courier.testkit.FakeSmtpServer;
import com.minimalistalliance.desk.deskd.courier.TestMime;
import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.courier.store.Outbox;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Sending from a linked mailbox: SMTP submission from the account's own address, the Sent copy, what each SMTP ending means
 * for the queue, the look in Sent after an unclear ending, and the kill switches.
 */
class LinkedSendTest {

    @TempDir
    Path dir;

    private static Outbox.Outgoing item(String id, boolean maybe, String... to) {
        List<Outbox.Recipient> rs = new java.util.ArrayList<>();
        for (int i = 0; i < to.length; i++) {
            rs.add(new Outbox.Recipient("e" + i, "email", to[i], "Friend " + i, "to"));
        }
        return new Outbox.Outgoing("o-" + id, "m-" + id, "email", null, 1, maybe, id + "@example.com", null, List.of(), "Subject " + id,
                "Hello there.\n.A line with a dot.\nBye", rs);
    }

    private static Outbox.Outgoing forAccount(Outbox.Outgoing o, String accountId) {
        return new Outbox.Outgoing(o.outboundId(), o.messageId(), o.medium(), accountId, o.attempt(), o.maybeSentBefore(), o.rfcMessageId(),
                o.inReplyTo(), o.references(), o.subject(), o.text(), o.to());
    }

    @Test
    void theMembersSendGoesFromTheAccountsAddressAndItsSentCopyFoldsIntoTheSameMessage() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            rig.link();
            rig.awaitLive(Duration.ofSeconds(30));
            Object[] draft = rig.store().actions().saveDraft(null, null, "email", rig.accountId, List.of("friend@example.net"), "Lunch?",
                    "Are you free?\n.Starts with a dot\nSee you", null, null);
            Object[] sent = rig.store().outbox().send((String) draft[0]);
            await().atMost(Duration.ofSeconds(20)).until(() -> rig.smtp.received().size() == 1);
            FakeSmtpServer.Received r = rig.smtp.received().get(0);
            assertThat(r.from()).isEqualTo(LinkedRig.LOGIN);
            assertThat(r.recipients()).containsExactly("friend@example.net");
            ParsedMessage m = ((CourierParser.Parsed) TestMime.PARSER.parse(r.data())).message();
            assertThat(m.subject()).isEqualTo("Lunch?");
            assertThat(m.from().address()).isEqualTo(LinkedRig.LOGIN);
            assertThat(m.text()).contains(".Starts with a dot").contains("See you");
            String text = new String(r.data(), StandardCharsets.UTF_8);
            assertThat(text).doesNotContain("User-Agent").doesNotContain("X-Mailer");
            // The Sent copy: filed by the desk (this provider doesn't), read, and folded into the member's own message.
            await().atMost(Duration.ofSeconds(20)).until(() -> rig.imap.messages(LinkedRig.LOGIN, "Sent").size() == 1);
            assertThat(rig.imap.messages(LinkedRig.LOGIN, "Sent").get(0).flags()).contains("\\Seen");
            await().atMost(Duration.ofSeconds(20)).until(() -> rig.count("SELECT count(*) FROM messages WHERE id = '" + sent[0]
                    + "' AND status = 'sent' AND blob IS NOT NULL") == 1);
            assertThat(rig.deskMessages()).hasSize(1);
        }
    }

    @Test
    void anUnclearEndLooksInSentAndDoesntSendAgainWhenItsThere() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            rig.link();
            // A provider that files sent mail itself, as Gmail does.
            rig.smtp.onMessage(r -> rig.imap.deliver(LinkedRig.LOGIN, "Sent", r.data(), Set.of("\\Seen"), Instant.now()));
            rig.smtp.dropAfterData(1, true);
            LinkedSender sender = new LinkedSender(rig.transport, rig.accountId);
            Outbox.Result first = sender.send(forAccount(item("u1", false, "friend@example.net"), rig.accountId));
            assertThat(first).isEqualTo(new Outbox.Retry("connection", true));
            Outbox.Result second = sender.send(forAccount(item("u1", true, "friend@example.net"), rig.accountId));
            assertThat(second).isInstanceOf(Outbox.Sent.class);
            assertThat(rig.smtp.received()).hasSize(1);
        }
    }

    @Test
    void anUnclearEndThatDidntGoIsSentOnceMore() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            rig.link();
            rig.smtp.dropAfterData(1, false);
            LinkedSender sender = new LinkedSender(rig.transport, rig.accountId);
            assertThat(sender.send(forAccount(item("u2", false, "friend@example.net"), rig.accountId)))
                    .isEqualTo(new Outbox.Retry("connection", true));
            assertThat(sender.send(forAccount(item("u2", true, "friend@example.net"), rig.accountId))).isInstanceOf(Outbox.Sent.class);
            assertThat(rig.smtp.received()).hasSize(1);
        }
    }

    @Test
    void eachSmtpEndingMeansWhatItShould() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            rig.link();
            LinkedSender sender = new LinkedSender(rig.transport, rig.accountId);
            // One recipient deferred: nothing goes, so nobody gets it twice later.
            rig.smtp.failRcpt("later@example.net", "451 4.3.0 Try again");
            assertThat(sender.send(forAccount(item("a", false, "now@example.net", "later@example.net"), rig.accountId)))
                    .isEqualTo(new Outbox.Retry("deferred"));
            assertThat(rig.smtp.received()).isEmpty();
            rig.smtp.clearFaults();
            // One refused for good: the rest get it, and that one is marked.
            rig.smtp.failRcpt("nobody@example.net", "550 5.1.1 No such user");
            Outbox.Result r = sender.send(forAccount(item("b", false, "now@example.net", "nobody@example.net"), rig.accountId));
            assertThat(r).isInstanceOf(Outbox.Sent.class);
            assertThat(((Outbox.Sent) r).recipients()).containsEntry("e0", "sent").containsEntry("e1", "refused");
            rig.smtp.clearFaults();
            // The message refused at its end: failed.
            rig.smtp.failAt(FakeSmtpServer.Stage.END_OF_DATA, 1, "554 5.7.1 Rejected");
            assertThat(sender.send(forAccount(item("c", false, "now@example.net"), rig.accountId))).isEqualTo(new Outbox.Failed("refused"));
            // Deferred at its end: clearly not taken, tried again.
            rig.smtp.failAt(FakeSmtpServer.Stage.END_OF_DATA, 1, "451 4.7.1 Later");
            assertThat(sender.send(forAccount(item("d", false, "now@example.net"), rig.accountId))).isEqualTo(new Outbox.Retry("deferred"));
            // The sign-in refused.
            rig.smtp.refuseAuth("535 5.7.8 Bad credentials");
            assertThat(sender.send(forAccount(item("e", false, "now@example.net"), rig.accountId))).isEqualTo(new Outbox.Retry("sign_in"));
            rig.smtp.clearFaults();
            // An address that can't be one is never sent to.
            assertThat(sender.send(forAccount(item("f", false, "not an address"), rig.accountId))).isEqualTo(new Outbox.Failed("recipients"));
        }
    }

    @Test
    void theSwitchesStopSending() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            rig.link();
            LinkedSender sender = new LinkedSender(rig.transport, rig.accountId);
            for (String words : List.of("imap-send-off", "send-off", "imap-off", "email-off", "off")) {
                rig.switchTo(words);
                assertThat(sender.send(forAccount(item("s", false, "now@example.net"), rig.accountId))).as(words)
                        .isEqualTo(new Outbox.Retry("switched_off"));
            }
            rig.switchTo(null);
            assertThat(sender.send(forAccount(item("s", false, "now@example.net"), rig.accountId))).isInstanceOf(Outbox.Sent.class);
            assertThat(rig.smtp.received()).hasSize(1);
        }
    }

    @Test
    void anUnclearRetryMarksTheQueueRowInterrupted() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            rig.link();
            rig.awaitLive(Duration.ofSeconds(30));
            rig.smtp.dropAfterData(1, false);
            Object[] draft = rig.store().actions().saveDraft(null, null, "email", rig.accountId, List.of("friend@example.net"), "Hi", "Hello",
                    null, null);
            Object[] sent = rig.store().outbox().send((String) draft[0]);
            await().atMost(Duration.ofSeconds(20)).until(() -> rig.count("SELECT count(*) FROM outbound WHERE id = '" + sent[1]
                    + "' AND state = 'retry' AND interrupted = 1") == 1);
        }
    }
}
