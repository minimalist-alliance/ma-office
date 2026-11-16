package com.minimalistalliance.desk.deskd.courier.linked;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.testkit.FakeImapServer;
import com.minimalistalliance.desk.courier.testkit.FakeImapServer.Capability;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The sync engine against the fake provider (CONDSTORE, QRESYNC, IDLE, MOVE, UIDPLUS by default; each fallback by turning
 * it off): the first sync, live mail, flags, moves and deletes both ways, a UIDVALIDITY reset, reconnects, sleep and wake,
 * and a deskd restart, each ending in the bar's oracle ({@link LinkedRig#check}): every message once, none missed.
 */
class LinkedSyncTest {

    @TempDir
    Path dir;

    static byte[] mail(String id, String from, String subject, String body) {
        return ("From: " + from + "\r\nTo: " + LinkedRig.LOGIN + "\r\nSubject: " + subject + "\r\nMessage-ID: <" + id
                + "@test.example>\r\nDate: Thu, 12 Nov 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
                + body + "\r\n").getBytes(StandardCharsets.UTF_8);
    }

    static byte[] mail(int n) {
        return mail("m" + n, "Person " + (n % 7) + " <p" + (n % 7) + "@people.example>", "Hello " + n, "Words of message " + n);
    }

    /** About 6 KB, so a whole message is plainly more than what the sync reads to match one. */
    static byte[] big(int n) {
        return mail("b" + n, "Person " + (n % 7) + " <p" + (n % 7) + "@people.example>", "Report " + n,
                ("Line " + n + " of a longer report, with enough words to be a real message. ").repeat(80));
    }

    private static void seed(LinkedRig rig, String folder, int from, int to, boolean seen) {
        Instant base = Instant.parse("2026-10-01T00:00:00Z");
        for (int n = from; n < to; n++) {
            rig.imap.deliver(LinkedRig.LOGIN, folder, mail(n), seen ? Set.of("\\Seen") : Set.of(), base.plusSeconds(n * 60L));
        }
    }

    private static void converged(LinkedRig rig) throws Exception {
        rig.awaitLive(Duration.ofSeconds(60));
        await().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(200)).until(() -> rig.check().isEmpty());
        assertThat(rig.check()).isEmpty();
    }

    @Test
    void theFirstSyncBringsEveryFolderOnceWithItsLaneAndReadState() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            seed(rig, "INBOX", 0, 60, false);
            seed(rig, "INBOX", 60, 80, true);
            seed(rig, "Archive", 100, 130, true);
            seed(rig, "Junk", 200, 210, false);
            seed(rig, "Trash", 300, 305, true);
            rig.imap.deliver(LinkedRig.LOGIN, "Drafts", mail(400), Set.of(), Instant.now());
            byte[] sent = mail("s1", LinkedRig.LOGIN, "From me", "I wrote this");
            rig.imap.deliver(LinkedRig.LOGIN, "Sent", sent, Set.of("\\Seen"), Instant.now());
            rig.link();
            converged(rig);
            List<LinkedRig.DeskMessage> desk = rig.deskMessages();
            // 80 + 30 + 10 + 5 + the sent one; the draft isn't synced.
            assertThat(desk).hasSize(126);
            assertThat(desk.stream().filter(m -> m.lane().equals("spam"))).hasSize(10);
            assertThat(desk.stream().filter(m -> m.lane().equals("trash"))).hasSize(5);
            assertThat(rig.desk(sent).direction()).isEqualTo("out");
            assertThat(rig.desk(mail(400))).isNull();
            // Strangers through a linked mailbox are Other, never Requests.
            assertThat(desk.stream().filter(m -> m.lane().equals("requests"))).isEmpty();
            // Mail older than a day is backfill, which courier_new never gives an agent.
            assertThat(desk.stream().filter(m -> "backfill".equals(m.origin()))).hasSize(125);
        }
    }

    @Test
    void newMailArrivesLiveAndFlagsMovesAndDeletesGoBothWays() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            seed(rig, "INBOX", 0, 10, false);
            rig.link();
            converged(rig);
            // New mail while it idles.
            long uid = rig.imap.deliver(LinkedRig.LOGIN, "INBOX", mail(50), Set.of(), Instant.now());
            await().atMost(Duration.ofSeconds(10)).until(() -> rig.desk(mail(50)) != null);
            assertThat(rig.desk(mail(50)).origin()).isEqualTo("live");
            // The provider marks it read; then the member marks it unread on the desk.
            rig.imap.setFlags(LinkedRig.LOGIN, "INBOX", uid, Set.of("\\Seen"));
            await().atMost(Duration.ofSeconds(10)).until(() -> rig.desk(mail(50)).read());
            rig.store().actions().setRead(List.of(rig.desk(mail(50)).id()), null, null, false);
            await().atMost(Duration.ofSeconds(10)).until(() -> rig.imap.messages(LinkedRig.LOGIN, "INBOX").stream()
                    .filter(m -> m.uid() == uid).allMatch(m -> !m.flags().contains("\\Seen")));
            // The provider moves one to Trash: Trash on the desk.
            long first = rig.imap.messages(LinkedRig.LOGIN, "INBOX").get(0).uid();
            byte[] firstBytes = rig.imap.messages(LinkedRig.LOGIN, "INBOX").get(0).bytes();
            rig.imap.move(LinkedRig.LOGIN, "INBOX", first, "Trash");
            await().atMost(Duration.ofSeconds(15)).until(() -> rig.desk(firstBytes).lane().equals("trash"));
            // The member restores it on the desk: back in INBOX at the provider.
            rig.store().actions().move(List.of(rig.desk(firstBytes).id()), null, null, "restore");
            await().atMost(Duration.ofSeconds(15)).until(() -> rig.imap.messages(LinkedRig.LOGIN, "INBOX").stream()
                    .anyMatch(m -> java.util.Arrays.equals(m.bytes(), firstBytes)));
            // The member moves one to Spam and another to Trash on the desk.
            byte[] two = mail(2);
            byte[] three = mail(3);
            rig.store().actions().move(List.of(rig.desk(two).id()), null, null, "spam");
            rig.store().actions().delete(List.of(rig.desk(three).id()), false);
            await().atMost(Duration.ofSeconds(15)).until(() -> inFolder(rig, "Junk", two) && inFolder(rig, "Trash", three));
            // Delete forever on the desk: gone at the provider too.
            rig.store().actions().delete(List.of(rig.desk(three).id()), true);
            await().atMost(Duration.ofSeconds(15)).until(() -> !inFolder(rig, "Trash", three));
            assertThat(rig.desk(three)).isNull();
            converged(rig);
            // The provider deletes one outright (no Trash): Trash on the desk, for its 30 days.
            byte[] four = mail(4);
            long fourUid = uidOf(rig, "INBOX", four);
            rig.imap.expunge(LinkedRig.LOGIN, "INBOX", fourUid);
            await().atMost(Duration.ofSeconds(20)).until(() -> rig.desk(four).lane().equals("trash"));
            // And empties its Trash of one the desk has in Trash: deleted for good on the desk.
            byte[] five = mail(5);
            rig.imap.move(LinkedRig.LOGIN, "INBOX", uidOf(rig, "INBOX", five), "Trash");
            await().atMost(Duration.ofSeconds(15)).until(() -> rig.desk(five).lane().equals("trash"));
            rig.imap.expunge(LinkedRig.LOGIN, "Trash", uidOf(rig, "Trash", five));
            await().atMost(Duration.ofSeconds(20)).until(() -> rig.desk(five) == null);
            converged(rig);
        }
    }

    @Test
    void aUidValidityResetFetchesNothingAgainAndDoublesNothing() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            Instant base = Instant.parse("2026-10-01T00:00:00Z");
            for (int n = 0; n < 40; n++) {
                rig.imap.deliver(LinkedRig.LOGIN, "INBOX", big(n), Set.of(), base.plusSeconds(n));
            }
            rig.link();
            converged(rig);
            long servedBefore = rig.imap.bytesServed();
            rig.imap.resetUidValidity(LinkedRig.LOGIN, "INBOX");
            rig.imap.deliver(LinkedRig.LOGIN, "INBOX", mail(99), Set.of(), Instant.now());
            await().atMost(Duration.ofSeconds(20)).until(() -> rig.desk(mail(99)) != null);
            converged(rig);
            assertThat(rig.deskMessages()).hasSize(41);
            // Matched by Message-ID, size and date: the 40 aren't fetched whole again.
            assertThat(rig.imap.bytesServed() - servedBefore).isLessThan(5L * big(0).length);
            assertThat(rig.count("SELECT count(*) FROM linked_locations")).isEqualTo(41);
        }
    }

    @Test
    void withoutCondstoreOrQresyncTheFallbacksGetTheSameAnswer() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults().without(Capability.CONDSTORE, Capability.QRESYNC,
                Capability.ESEARCH, Capability.MOVE, Capability.LITERAL_PLUS, Capability.SASL_IR))) {
            seed(rig, "INBOX", 0, 30, false);
            seed(rig, "Archive", 30, 40, true);
            rig.link();
            converged(rig);
            long uid = uidOf(rig, "INBOX", mail(1));
            rig.imap.setFlags(LinkedRig.LOGIN, "INBOX", uid, Set.of("\\Seen"));
            rig.imap.expunge(LinkedRig.LOGIN, "Archive", uidOf(rig, "Archive", mail(31)));
            rig.store().actions().delete(List.of(rig.desk(mail(2)).id()), false);
            await().atMost(Duration.ofSeconds(20)).until(() -> rig.desk(mail(1)).read() && inFolder(rig, "Trash", mail(2))
                    && rig.desk(mail(31)).lane().equals("trash"));
            converged(rig);
        }
    }

    @Test
    void reconnectsSleepWakeAndRestartsMissAndDoubleNothing() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            seed(rig, "INBOX", 0, 120, false);
            rig.link();
            // Dropped mid first sync, and cut inside a message's bytes.
            await().atMost(Duration.ofSeconds(20)).until(() -> rig.deskMessages().size() >= 20);
            rig.imap.dropConnections();
            rig.imap.cutAfterBytes(3000);
            converged(rig);
            // Asleep: mail comes, flags change and a message moves while nothing runs.
            rig.sleep();
            seed(rig, "INBOX", 500, 510, false);
            rig.imap.setFlags(LinkedRig.LOGIN, "INBOX", uidOf(rig, "INBOX", mail(7)), Set.of("\\Seen"));
            rig.imap.move(LinkedRig.LOGIN, "INBOX", uidOf(rig, "INBOX", mail(8)), "Archive");
            rig.wake();
            converged(rig);
            assertThat(rig.desk(mail(505)).origin()).isEqualTo("catchup");
            // A deskd restart.
            seed(rig, "INBOX", 600, 605, false);
            rig.restartDeskd();
            converged(rig);
            assertThat(rig.deskMessages()).hasSize(135);
        }
    }

    @Test
    void gmailSyncsAllMailWithLabelsAndSkipsDrafts() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.gmail())) {
            for (int n = 0; n < 15; n++) {
                long u = rig.imap.deliver(LinkedRig.LOGIN, "[Gmail]/All Mail", big(n), Set.of(), Instant.now().minusSeconds(86_400L * 3));
                rig.imap.labels(LinkedRig.LOGIN, u, n % 2 == 0 ? new String[] {"\\Inbox", "Receipts"} : new String[] {"\\Inbox"});
            }
            long draft = rig.imap.deliver(LinkedRig.LOGIN, "[Gmail]/All Mail", mail(90), Set.of(), Instant.now());
            rig.imap.labels(LinkedRig.LOGIN, draft, "\\Draft");
            rig.imap.deliver(LinkedRig.LOGIN, "[Gmail]/Spam", mail(80), Set.of(), Instant.now());
            rig.link();
            converged(rig);
            assertThat(rig.deskMessages()).hasSize(16);
            assertThat(rig.desk(big(0)).labels()).contains("Receipts");
            assertThat(rig.desk(mail(80)).lane()).isEqualTo("spam");
            // A label added at the provider shows on the desk; a move to Trash keeps the Gmail id and is matched, not fetched.
            long u1 = uidOf(rig, "[Gmail]/All Mail", big(1));
            rig.imap.labels(LinkedRig.LOGIN, u1, "\\Inbox", "Travel");
            await().atMost(Duration.ofSeconds(15)).until(() -> rig.desk(big(1)).labels() != null && rig.desk(big(1)).labels().contains("Travel"));
            long served = rig.imap.bytesServed();
            rig.imap.move(LinkedRig.LOGIN, "[Gmail]/All Mail", uidOf(rig, "[Gmail]/All Mail", big(3)), "[Gmail]/Trash");
            await().atMost(Duration.ofSeconds(15)).until(() -> rig.desk(big(3)).lane().equals("trash"));
            assertThat(rig.imap.bytesServed() - served).isLessThan(big(3).length / 2L);
            converged(rig);
        }
    }

    @Test
    void aRefusedSignInWaitsForTheMemberAndSigningInAgainResumes() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            seed(rig, "INBOX", 0, 5, false);
            rig.link();
            converged(rig);
            // The app password was revoked at the provider.
            rig.imap.failLogin("NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)");
            rig.imap.dropConnections();
            await().atMost(Duration.ofSeconds(20)).until(() -> "needs_you".equals(rig.status().state()) && "auth".equals(rig.status().reason()));
            int logins = rig.imap.logins();
            Thread.sleep(3_000);
            // It doesn't keep knocking.
            assertThat(rig.imap.logins()).isEqualTo(logins);
            // A new one, given by the member: checked, sealed over the old, and the sync goes on.
            rig.imap.clearFaults();
            seed(rig, "INBOX", 10, 12, false);
            rig.transport.signedIn(rig.accountId);
            converged(rig);
            assertThat(rig.deskMessages()).hasSize(7);
        }
    }

    @Test
    void gmailsAppPasswordAlertIsNamed() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            rig.link();
            rig.awaitLive(Duration.ofSeconds(30));
            rig.imap.failLogin("NO [ALERT] Application-specific password required: https://support.example/app-passwords (Failure)");
            rig.imap.dropConnections();
            await().atMost(Duration.ofSeconds(20)).until(() -> "app_password".equals(rig.status().reason()));
        }
    }

    @Test
    void theKillSwitchStopsTheSyncAndTurningItOnBringsWhatCameMeanwhile() throws Exception {
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            seed(rig, "INBOX", 0, 3, false);
            rig.link();
            converged(rig);
            for (String word : List.of("imap-off", "email-off", "off")) {
                rig.switchTo(word);
                await().atMost(Duration.ofSeconds(10)).until(() -> "off".equals(rig.status().state()));
                await().atMost(Duration.ofSeconds(10)).until(() -> rig.imap.connectionsOpen() == 0);
                int before = rig.imap.connectionsOpened();
                rig.imap.deliver(LinkedRig.LOGIN, "INBOX", mail(100 + word.length()), Set.of(), Instant.now());
                Thread.sleep(2_000);
                assertThat(rig.imap.connectionsOpened()).as(word).isEqualTo(before);
                rig.switchTo(null);
                converged(rig);
            }
            assertThat(rig.deskMessages()).hasSize(6);
        }
    }

    @Test
    void greenMailsPlainImapTooWithTheSameAnswer() throws Exception {
        // GreenMail (the kit's FakeMailServer): no CONDSTORE, QRESYNC, ENABLE, SPECIAL-USE or ESEARCH, so names find the
        // folders and the UID list finds expunges.
        try (com.minimalistalliance.desk.courier.testkit.FakeMailServer gm = com.minimalistalliance.desk.courier.testkit.FakeMailServer.start();
                LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults())) {
            gm.addUser(LinkedRig.LOGIN, LinkedRig.LOGIN, LinkedRig.PASS);
            List<byte[]> all = new ArrayList<>();
            for (com.minimalistalliance.desk.courier.testkit.MimeCorpus.Sample sample
                    : com.minimalistalliance.desk.courier.testkit.MimeCorpus.handWritten().subList(0, 60)) {
                gm.deliver(LinkedRig.LOGIN, sample.raw());
                all.add(com.minimalistalliance.desk.courier.testkit.FakeMailServer.stored(sample.raw()));
            }
            gm.deliver(LinkedRig.LOGIN, "Archive", mail(1));
            all.add(com.minimalistalliance.desk.courier.testkit.FakeMailServer.stored(mail(1)));
            String server = "{\"imapHost\":\"127.0.0.1\",\"imapPort\":" + gm.imapsPort() + ",\"smtpHost\":\"127.0.0.1\",\"smtpPort\":"
                    + gm.smtpsPort() + ",\"security\":\"tls\"}";
            rig.startTransport();
            rig.accountId = "imap-greenmail";
            rig.module.linkedAccounts().add(new com.minimalistalliance.desk.deskd.courier.store.Courier.Account(rig.accountId, "imap", "Mailbox",
                    LinkedRig.LOGIN, "ok"), List.<String[]>of(new String[] {"email", LinkedRig.LOGIN}),
                    new com.minimalistalliance.desk.deskd.courier.vault.SignIn("app_password", LinkedRig.LOGIN,
                            LinkedRig.PASS.getBytes(StandardCharsets.UTF_8), null, 0, server));
            rig.transport.added(rig.accountId);
            rig.awaitLive(Duration.ofSeconds(60));
            for (byte[] b : all) {
                assertThat(rig.desk(b)).isNotNull();
            }
            assertThat(rig.deskMessages()).hasSize(all.size());
            // An expunge there, found by the UID list.
            jakarta.mail.Folder inbox = null;
            var store = gm.greenMail().getImap().createStore();
            store.connect(LinkedRig.LOGIN, LinkedRig.PASS);
            inbox = store.getFolder("INBOX");
            inbox.open(jakarta.mail.Folder.READ_WRITE);
            inbox.getMessage(1).setFlag(jakarta.mail.Flags.Flag.DELETED, true);
            inbox.close(true);
            store.close();
            await().atMost(Duration.ofSeconds(20)).until(() -> rig.desk(all.get(0)) != null && rig.desk(all.get(0)).lane().equals("trash"));
            assertThat(rig.deskMessages()).hasSize(all.size());
        }
    }

    static boolean inFolder(LinkedRig rig, String folder, byte[] raw) {
        return rig.imap.messages(LinkedRig.LOGIN, folder).stream().anyMatch(m -> java.util.Arrays.equals(m.bytes(), raw));
    }

    static long uidOf(LinkedRig rig, String folder, byte[] raw) {
        return rig.imap.messages(LinkedRig.LOGIN, folder).stream().filter(m -> java.util.Arrays.equals(m.bytes(), raw)).findFirst()
                .orElseThrow().uid();
    }

    static List<String> lines(Path p) throws Exception {
        return Files.exists(p) ? Files.readAllLines(p) : new ArrayList<>();
    }
}
