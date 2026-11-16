package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.testkit.FakeBlueBubbles;
import com.minimalistalliance.desk.courier.testkit.FakeTls;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgSink;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgTransport;
import com.minimalistalliance.desk.deskd.courier.imsg.bluebubbles.BlueBubblesPath;
import com.minimalistalliance.desk.deskd.courier.linked.Net;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * iMessage through the member's own Mac (the launch plan's Wave 2.6), BlueBubbles' path of the {@code imsg} seam, against
 * the test kit's fake BlueBubbles Server: Courier as deskd wires it (the real session and RPC layers, Files, and the real
 * Courier mode answering on a socket), the transport connecting out to the fake as it will to a member's Mac.
 */
class ImessageTest {

    private static final String PW = "bb-pass-Secret-7781";
    private static final String DANA = "+15551230001";
    private static final String JULES = "+15551230002";

    private static final class Rig implements AutoCloseable {
        final AttachmentsRig rig;
        final FakeBlueBubbles bb;
        final TestClient owner;
        ImsgSink.Settings files = ImsgSink.Settings.DEFAULT;
        ImsgTransport transport;
        String accountId;

        Rig(Path dir, FakeBlueBubbles bb) throws Exception {
            this.rig = new AttachmentsRig(dir);
            this.bb = bb;
            this.owner = rig.owner("s-1");
        }

        ImsgTransport start() {
            Net net = Net.forTests(FakeTls.clientContext());
            BlueBubblesPath.Settings st = BlueBubblesPath.Settings.forTests(bb.socketPort(), 50);
            transport = new ImsgTransport(rig.module, Clock.systemUTC(), files, Duration.ofMillis(300))
                    .register(BlueBubblesPath.PATH, BlueBubblesPath.factory(net, st), BlueBubblesPath.prober(net, st)).start();
            return transport;
        }

        String connect() throws Exception {
            if (transport == null) {
                start();
            }
            Map<String, Object> r = rig.ok(owner, "courier.accounts.add", "kind", "imessage", "server", bb.baseUrl(), "secret", PW);
            accountId = (String) r.get("accountId");
            return accountId;
        }

        Map<String, Object> account() throws Exception {
            for (Object a : (List<?>) rig.ok(owner, "courier.accounts.list").get("accounts")) {
                Map<?, ?> m = (Map<?, ?>) a;
                if (accountId.equals(m.get("accountId"))) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> out = (Map<String, Object>) m;
                    return out;
                }
            }
            return null;
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> sync() throws Exception {
            Map<String, Object> a = account();
            return a == null ? null : (Map<String, Object>) a.get("sync");
        }

        Connection db() throws Exception {
            return DriverManager.getConnection("jdbc:sqlite:" + rig.dir.resolve("courier").resolve("courier.db"));
        }

        record Row(String id, String medium, String direction, String lane, String text, String channel, String externalId) {}

        List<Row> rows() throws Exception {
            List<Row> out = new ArrayList<>();
            try (Connection c = db(); Statement s = c.createStatement();
                    ResultSet r = s.executeQuery("SELECT id, medium, direction, lane, body_text, channel_id, external_id FROM messages ORDER BY seq")) {
                while (r.next()) {
                    out.add(new Row(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5), r.getString(6), r.getString(7)));
                }
            }
            return out;
        }

        Row text(String text) throws Exception {
            for (Row r : rows()) {
                if (text.equals(r.text())) {
                    return r;
                }
            }
            return null;
        }

        long count(String sql) throws Exception {
            try (Connection c = db(); Statement s = c.createStatement(); ResultSet r = s.executeQuery(sql)) {
                return r.next() ? r.getLong(1) : 0;
            }
        }

        void awaitText(String text) {
            await().atMost(Duration.ofSeconds(20)).pollInterval(Duration.ofMillis(100)).until(() -> text(text) != null);
        }

        void switchTo(String words) throws Exception {
            Path f = rig.dir.resolve("desk").resolve("courier-switch");
            if (words == null) {
                Files.deleteIfExists(f);
            } else {
                Files.writeString(f, words);
            }
            Thread.sleep(1_100);
        }

        @Override
        public void close() throws Exception {
            if (transport != null) {
                transport.close();
            }
            rig.close();
            bb.close();
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> m(Object o) {
        return (Map<String, Object>) o;
    }

    @Test
    void connectingChecksTheMacAndSealsItsAddressAndPasswordTogether(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            String chat = r.bb.directChat(DANA);
            r.bb.receive(chat, DANA, "are you around?", Instant.now().minus(Duration.ofHours(2)));
            r.start();
            // The office's no's: a wrong password, an address that isn't HTTPS (outside tests), a port that isn't a Mac's.
            Map<String, Object> e = r.rig.err(r.owner, "forbidden", "courier.accounts.add", "kind", "imessage", "server", r.bb.baseUrl(), "secret", "nope");
            assertThat(m(e.get("details"))).containsEntry("reason", "sign_in").containsEntry("cause", "password");
            e = r.rig.err(r.owner, "bad_request", "courier.accounts.add", "kind", "imessage", "server", "ftp://mac.example.net", "secret", PW);
            assertThat(m(e.get("details"))).containsEntry("reason", "server");
            e = r.rig.err(r.owner, "bad_request", "courier.accounts.add", "kind", "imessage", "server", "https://user:pw@mac.example.net", "secret", PW);
            assertThat(m(e.get("details"))).containsEntry("reason", "server");
            assertThat(r.rig.store().accounts()).noneMatch(a -> a.kind().equals("imessage"));

            String id = r.connect();
            assertThat(id).startsWith("imessage-");
            r.awaitText("are you around?");
            await().atMost(Duration.ofSeconds(10)).until(() -> "live".equals(r.sync().get("state")));
            Map<String, Object> a = r.account();
            assertThat(a).containsEntry("kind", "imessage").containsEntry("signedIn", true).containsEntry("sending", true)
                    .containsEntry("label", "iMessage on your Mac");
            assertThat(r.sync()).containsEntry("path", "bluebubbles").containsEntry("mode", "basic").containsEntry("through", "own")
                    .containsEntry("certificate", "trusted");
            // The address and password are sealed together: in no row, and not readable in the vault's file.
            Path courier = dir.resolve("courier");
            for (String f : List.of("courier.db", "courier.db-wal")) {
                Path p = courier.resolve(f);
                if (Files.exists(p)) {
                    String bytes = new String(Files.readAllBytes(p), StandardCharsets.ISO_8859_1);
                    assertThat(bytes).doesNotContain(PW).doesNotContain(r.bb.baseUrl()).doesNotContain("127.0.0.1:" + r.bb.port());
                }
            }
            Path sealed = courier.resolve("keys").resolve(id + ".sealed");
            assertThat(sealed).exists();
            assertThat(new String(Files.readAllBytes(sealed), StandardCharsets.ISO_8859_1)).doesNotContain(PW).doesNotContain("127.0.0.1");
            // One Mac a desk.
            e = r.rig.err(r.owner, "conflict", "courier.accounts.add", "kind", "imessage", "server", r.bb.baseUrl(), "secret", PW);
            assertThat(m(e.get("details"))).containsEntry("reason", "too_many");
            // Removing it: the row, its messages unless kept, then the sealed file.
            r.rig.ok(r.owner, "courier.accounts.remove", "accountId", id, "keepMail", true);
            assertThat(sealed).doesNotExist();
            assertThat(r.text("are you around?")).isNotNull();
        }
    }

    @Test
    void textsAndIMessagesFromOnePersonAreOneThreadAndAStrangerWaitsInRequests(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            String im = r.bb.directChat(DANA);
            String sms = r.bb.directChat(DANA, "SMS");
            String stranger = r.bb.directChat("+15559990000");
            Instant t = Instant.now().minus(Duration.ofHours(3));
            r.bb.receive(im, DANA, "by imessage", t);
            r.bb.receive(sms, DANA, "by text", t.plusSeconds(60));
            r.bb.sendFromPhone(im, "my reply from the phone", t.plusSeconds(120));
            r.bb.receive(stranger, "+15559990000", "you won a prize", t.plusSeconds(180));
            r.connect();
            r.awaitText("you won a prize");
            Rig.Row a = r.text("by imessage");
            Rig.Row b = r.text("by text");
            Rig.Row mine = r.text("my reply from the phone");
            assertThat(a.medium()).isEqualTo("imessage");
            assertThat(b.medium()).isEqualTo("sms");
            assertThat(a.channel()).isEqualTo(b.channel()).isEqualTo(mine.channel());
            assertThat(mine.direction()).isEqualTo("out");
            // The member wrote to Dana from the phone, so Dana is let in; the stranger is a Request, which no agent sees.
            await().atMost(Duration.ofSeconds(5)).until(() -> "people".equals(r.text("by imessage").lane()));
            assertThat(r.text("by text").lane()).isEqualTo("people");
            assertThat(r.text("you won a prize").lane()).isEqualTo("requests");
            assertThat(r.count("SELECT count(*) FROM channels WHERE kind = 'direct'")).isEqualTo(2);
        }
    }

    @Test
    void aMacThatSleptLosesNothingAndAWakeOrARestartDoublesNothing(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            String chat = r.bb.directChat(DANA);
            r.bb.receive(chat, DANA, "before", Instant.now().minusSeconds(600));
            r.connect();
            r.awaitText("before");
            // The Mac goes to sleep: the desk says so, and keeps trying.
            r.bb.setDown(true);
            await().atMost(Duration.ofSeconds(15)).until(() -> "away".equals(r.sync().get("state")));
            assertThat(r.sync().get("reason")).isEqualTo("asleep");
            // The desk sleeps too; meanwhile the Mac keeps 120 messages (more than two pages).
            r.transport.close();
            Instant t = Instant.now().minusSeconds(300);
            for (int i = 0; i < 120; i++) {
                r.bb.receive(chat, DANA, "while away " + i, t.plusMillis(i * 10L));
            }
            r.bb.setDown(false);
            r.bb.restart();
            r.start();
            r.awaitText("while away 119");
            r.rig.ok(r.owner, "courier.accounts.check", "accountId", r.accountId);
            Thread.sleep(1_500);
            // A deskd restart starts the path again over the same store: the overlap brings nothing twice.
            r.transport.close();
            r.start();
            await().atMost(Duration.ofSeconds(10)).until(() -> "live".equals(r.sync().get("state")));
            Thread.sleep(1_000);
            assertThat(r.count("SELECT count(*) FROM messages WHERE body_text LIKE 'while away %'")).isEqualTo(120);
            assertThat(r.count("SELECT count(*) FROM messages")).isEqualTo(121);
            assertThat(r.count("SELECT count(DISTINCT external_id) FROM messages")).isEqualTo(121);
        }
    }

    @Test
    void reactionsEditsAndUnsendsAreWordsFromWhoeverMadeThem(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            String chat = r.bb.directChat(DANA);
            String g = r.bb.receive(chat, DANA, "see you at 6", Instant.now().minusSeconds(120));
            r.connect();
            r.awaitText("see you at 6");
            r.bb.tapback(chat, DANA, g, "love");
            r.awaitText("Loved “see you at 6”");
            r.bb.edit(g, "see you at 7");
            r.awaitText("Edited “see you at 6”: see you at 7");
            String g2 = r.bb.receive(chat, DANA, "oops wrong chat", null);
            r.awaitText("oops wrong chat");
            r.bb.retract(g2);
            r.awaitText("Unsent a message.");
            r.bb.tapback(chat, DANA, g, "-love");
            r.awaitText("Removed a heart from “see you at 6”");
            // Each is its own message, in Dana's conversation, from Dana, stored once.
            Rig.Row orig = r.text("see you at 6");
            for (String w : List.of("Loved “see you at 6”", "Edited “see you at 6”: see you at 7", "Unsent a message.")) {
                Rig.Row row = r.text(w);
                assertThat(row.channel()).isEqualTo(orig.channel());
                assertThat(row.direction()).isEqualTo("in");
            }
            r.rig.ok(r.owner, "courier.accounts.check", "accountId", r.accountId);
            Thread.sleep(1_500);
            assertThat(r.count("SELECT count(*) FROM messages WHERE body_text LIKE 'Edited %'")).isEqualTo(1);
            assertThat(r.count("SELECT count(*) FROM messages WHERE body_text LIKE 'Loved %'")).isEqualTo(1);
        }
    }

    @Test
    void aGroupChatIsOneConversationNamedAsOnThePhone(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            String group = r.bb.groupChat("Climbing", DANA, JULES);
            r.bb.receive(group, DANA, "crag at 9?", Instant.now().minusSeconds(300));
            r.bb.receive(group, JULES, "in", Instant.now().minusSeconds(200));
            r.connect();
            r.awaitText("in");
            assertThat(r.text("crag at 9?").channel()).isEqualTo(r.text("in").channel());
            String channel = r.text("in").channel();
            r.bb.renameGroup(group, "Crag day");
            r.awaitText("Named the conversation “Crag day”.");
            r.bb.addParticipant(group, "+15551230003");
            r.awaitText("Added someone to the conversation.");
            r.bb.receive(group, "+15551230003", "hi all", null);
            r.awaitText("hi all");
            // Whoever joins, it's the same conversation, renamed.
            assertThat(r.text("hi all").channel()).isEqualTo(channel);
            try (Connection c = r.db(); Statement s = c.createStatement();
                    ResultSet rs = s.executeQuery("SELECT kind, title FROM channels WHERE id = '" + channel + "'")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getString(1)).isEqualTo("group");
                assertThat(rs.getString(2)).isEqualTo("Crag day");
            }
            // The group's chat is known here, so a reply goes back to it.
            assertThat(r.rig.store().imessage().chatFor(r.accountId, channel)).isEqualTo(group);
        }
    }

    @Test
    void filesComeInThroughTheSandboxAndIntoFilesWithEmailsSafetyRules(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            r.files = new ImsgSink.Settings(1024 * 1024, 1024 * 1024);
            String chat = r.bb.directChat(DANA);
            byte[] note = "a plain note".getBytes(StandardCharsets.UTF_8);
            byte[] exe = new byte[2048];
            exe[0] = 'M';
            exe[1] = 'Z';
            byte[] big = new byte[2 * 1024 * 1024];
            r.bb.receive(chat, DANA, "files", Instant.now().minusSeconds(60), new FakeBlueBubbles.Attachment("note.txt", "text/plain", note),
                    new FakeBlueBubbles.Attachment("setup.exe", "application/octet-stream", exe),
                    new FakeBlueBubbles.Attachment("video.mov", "video/quicktime", big));
            r.connect();
            await().atMost(Duration.ofSeconds(20)).until(() -> r.rows().stream().anyMatch(x -> x.text() != null && x.text().startsWith("files")));
            Rig.Row row = r.rows().stream().filter(x -> x.text() != null && x.text().startsWith("files")).findFirst().orElseThrow();
            // The one over the limit stays on the Mac, said in words.
            assertThat(row.text()).contains("video.mov").contains("it stays in Messages on your Mac");
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> atts = (List<Map<String, Object>>) r.rig.store().queries().message(row.id(), 0).get("attachments");
            assertThat(atts).hasSize(2);
            Map<String, Object> txt = atts.stream().filter(a -> "note.txt".equals(a.get("name"))).findFirst().orElseThrow();
            Map<String, Object> program = atts.stream().filter(a -> "setup.exe".equals(a.get("name"))).findFirst().orElseThrow();
            assertThat(program.get("danger")).isEqualTo("program");
            assertThat(txt.get("danger")).isNull();
            // Save to Files: through Files' own door, into Courier/<date> <subject>/.
            Map<String, Object> saved = r.rig.ok(r.owner, "courier.attachment.save", "messageId", row.id(), "part", txt.get("part"));
            String path = (String) ((Map<?, ?>) saved).get("path");
            assertThat(path).startsWith("Courier/").endsWith("note.txt");
            assertThat(Files.readAllBytes(r.rig.filesRoot.resolve(path))).isEqualTo(note);
            // A program needs the second press.
            Map<String, Object> e = r.rig.err(r.owner, "forbidden", "courier.attachment.save", "messageId", row.id(), "part", program.get("part"));
            assertThat(m(e.get("details"))).containsEntry("reason", "danger").containsEntry("danger", "program");
        }
    }

    @Test
    void aSendGoesThroughTheMacOnceAndItsEchoIsTheSameMessage(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            String chat = r.bb.directChat(DANA);
            String sms = r.bb.directChat(DANA, "SMS");
            r.bb.receive(chat, DANA, "where are you?", Instant.now().minusSeconds(60));
            r.connect();
            r.awaitText("where are you?");
            String channel = r.text("where are you?").channel();
            Map<String, Object> d = r.rig.ok(r.owner, "courier.draft.save", "channelId", channel, "medium", "imessage", "accountId", r.accountId,
                    "text", "on my way");
            r.rig.ok(r.owner, "courier.send", "draftId", d.get("draftId"));
            r.rig.clock.advance(Duration.ofSeconds(11));
            r.rig.store().outbox().poke();
            await().atMost(Duration.ofSeconds(15)).until(() -> r.bb.sent().size() == 1);
            assertThat(r.bb.sent().get(0)).containsEntry("text", "on my way");
            assertThat(((Map<?, ?>) ((List<?>) r.bb.sent().get(0).get("chats")).get(0)).get("guid")).isEqualTo(chat);
            await().atMost(Duration.ofSeconds(10)).until(() -> r.count("SELECT count(*) FROM outbound WHERE state = 'sent'") == 1);
            r.rig.ok(r.owner, "courier.accounts.check", "accountId", r.accountId);
            Thread.sleep(2_000);
            assertThat(r.count("SELECT count(*) FROM messages WHERE body_text = 'on my way'")).isEqualTo(1);

            // A Mac that fails a send: waiting to send, then out on the retry, once.
            r.bb.failNextSends(1);
            Map<String, Object> d2 = r.rig.ok(r.owner, "courier.draft.save", "channelId", channel, "medium", "sms", "accountId", r.accountId,
                    "text", "by text this time");
            r.rig.ok(r.owner, "courier.send", "draftId", d2.get("draftId"));
            r.rig.clock.advance(Duration.ofSeconds(11));
            r.rig.store().outbox().poke();
            await().atMost(Duration.ofSeconds(10)).until(() -> r.count("SELECT count(*) FROM outbound WHERE state = 'retry'") == 1);
            r.rig.clock.advance(Duration.ofSeconds(70));
            r.rig.store().outbox().poke();
            await().atMost(Duration.ofSeconds(15)).until(() -> r.bb.sent().size() == 2);
            assertThat(((Map<?, ?>) ((List<?>) r.bb.sent().get(1).get("chats")).get(0)).get("guid")).isEqualTo(sms);
            r.rig.ok(r.owner, "courier.accounts.check", "accountId", r.accountId);
            Thread.sleep(2_000);
            assertThat(r.count("SELECT count(*) FROM messages WHERE body_text = 'by text this time'")).isEqualTo(1);
        }
    }

    @Test
    void theMacsContactsGiveNamesAndCardSuggestionsButLinkNoOne(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            r.bb.addContact(new FakeBlueBubbles.Contact("Dana", "Ortiz", null, List.of("+1 (555) 123-0001", "555-123-0002"), List.of()));
            String a = r.bb.directChat(DANA);
            String b = r.bb.directChat(JULES);
            Instant t = Instant.now().minusSeconds(600);
            r.bb.receive(a, DANA, "from my phone", t);
            r.bb.sendFromPhone(a, "hey Dana", t.plusSeconds(10));
            r.bb.receive(b, JULES, "this is my work phone", t.plusSeconds(20));
            r.connect();
            r.awaitText("this is my work phone");
            await().atMost(Duration.ofSeconds(10)).until(() -> r.rig.store().imessage().cards("mac:" + r.accountId) == 1);
            await().atMost(Duration.ofSeconds(10)).until(() -> r.count("SELECT count(*) FROM contacts WHERE name = 'Dana Ortiz'") >= 1);
            List<Map<String, Object>> s = r.rig.store().links().suggest("phone", JULES);
            assertThat(s).hasSize(1);
            assertThat(s.get(0)).containsEntry("source", "mac").containsEntry("strength", "card");
            assertThat(m(s.get(0).get("into"))).containsEntry("name", "Dana Ortiz");
            // Nothing was linked, and the work phone still waits in Requests until the member says.
            assertThat(r.text("this is my work phone").lane()).isEqualTo("requests");
            assertThat(r.text("this is my work phone").channel()).isNotEqualTo(r.text("from my phone").channel());
        }
    }

    @Test
    void aMacWithItsOwnCertificateIsPinnedOnFirstConnect(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(FakeBlueBubbles.Options.defaults(PW).withTls(FakeTls.serverContext())))) {
            String chat = r.bb.directChat(DANA);
            r.bb.receive(chat, DANA, "over https", Instant.now().minusSeconds(60));
            assertThat(r.bb.baseUrl()).startsWith("https://");
            r.connect();
            r.awaitText("over https");
            await().atMost(Duration.ofSeconds(10)).until(() -> Boolean.TRUE.equals(r.sync().get("socket")));
            assertThat(r.sync()).containsEntry("certificate", "pinned").containsEntry("through", "own");
            r.bb.receive(chat, DANA, "live over wss", null);
            r.awaitText("live over wss");
        }
    }

    @Test
    void theKillSwitchStopsItBothWaysAndTurningItOnPicksUp(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            String chat = r.bb.directChat(DANA);
            r.bb.receive(chat, DANA, "first", Instant.now().minusSeconds(60));
            r.connect();
            r.awaitText("first");
            String channel = r.text("first").channel();
            r.switchTo("imessage-off");
            await().atMost(Duration.ofSeconds(5)).until(() -> "off".equals(r.sync().get("state")));
            r.bb.receive(chat, DANA, "while off", null);
            Map<String, Object> d = r.rig.ok(r.owner, "courier.draft.save", "channelId", channel, "medium", "imessage", "accountId", r.accountId,
                    "text", "held");
            r.rig.ok(r.owner, "courier.send", "draftId", d.get("draftId"));
            r.rig.clock.advance(Duration.ofSeconds(11));
            r.rig.store().outbox().poke();
            Thread.sleep(2_000);
            assertThat(r.bb.sent()).isEmpty();
            assertThat(r.text("while off")).isNull();
            r.switchTo(null);
            r.awaitText("while off");
            r.rig.clock.advance(Duration.ofSeconds(70));
            r.rig.store().outbox().poke();
            await().atMost(Duration.ofSeconds(15)).until(() -> r.bb.sent().size() == 1);
        }
    }

    @Test
    void aNewPasswordOrANewAddressIsSignInAgain(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            r.connect();
            await().atMost(Duration.ofSeconds(10)).until(() -> "live".equals(r.sync().get("state")));
            // The Mac's password changed (the fake can't change it, so the desk's sealed one is replaced by a wrong one).
            Map<String, Object> e = r.rig.err(r.owner, "forbidden", "courier.accounts.signin", "accountId", r.accountId, "secret", "wrong");
            assertThat(m(e.get("details"))).containsEntry("cause", "password");
            try (FakeBlueBubbles other = FakeBlueBubbles.start(PW)) {
                String chat = other.directChat(DANA);
                other.receive(chat, DANA, "from the new address", null);
                // A Cloudflare tunnel's address changes when BlueBubbles restarts: sign in again with the new one.
                r.rig.ok(r.owner, "courier.accounts.signin", "accountId", r.accountId, "secret", PW, "server", other.baseUrl());
                // (The test's socket port is the first fake's: the REST catch-up alone brings it.)
                r.awaitText("from the new address");
            }
            Set<String> seen = new HashSet<>();
            for (Rig.Row row : r.rows()) {
                assertThat(seen.add(row.externalId())).isTrue();
            }
        }
    }

    @Test
    void aChangedCertificateIsNeverAcceptedWithoutTheMembersWord(@TempDir Path dir) throws Exception {
        try (FakeBlueBubbles bb = FakeBlueBubbles.start(FakeBlueBubbles.Options.defaults(PW).withTls(FakeTls.serverContext()))) {
            Net net = Net.forTests(FakeTls.clientContext());
            ImsgTransport.Prober prober = BlueBubblesPath.prober(net, BlueBubblesPath.Settings.forTests(bb.socketPort(), 50));
            byte[] pw = PW.getBytes(StandardCharsets.UTF_8);
            // First connect: the member's own address with its own certificate is pinned.
            var first = prober.probe(bb.baseUrl(), pw.clone(), null, null);
            assertThat(first.server()).contains("\"pin\":\"sha256:");
            // Sign in again to the same Mac: the pin holds, nothing to accept.
            assertThat(prober.probe(bb.baseUrl() + "/", pw.clone(), first.server(), null).server()).isEqualTo(first.server());
            // The pin the desk holds isn't what the Mac shows now: refused before any password goes, with the new one named.
            String stale = first.server().replaceAll("sha256:[0-9a-f]{64}", "sha256:" + "0".repeat(64));
            String fp = first.server().replaceAll(".*\"pin\":\"(sha256:[0-9a-f]{64})\".*", "$1");
            try {
                prober.probe(bb.baseUrl(), pw.clone(), stale, null);
                throw new AssertionError("accepted a changed certificate");
            } catch (com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts.Rejected rj) {
                assertThat(rj.reason()).isEqualTo("certificate_changed");
                assertThat(rj.detail()).isEqualTo(fp);
            }
            try {
                prober.probe(bb.baseUrl(), pw.clone(), stale, "sha256:" + "1".repeat(64));
                throw new AssertionError("accepted another fingerprint");
            } catch (com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts.Rejected rj) {
                assertThat(rj.reason()).isEqualTo("certificate_changed");
            }
            // The member's word, naming exactly that certificate: pinned.
            assertThat(prober.probe(bb.baseUrl(), pw.clone(), stale, fp).server()).isEqualTo(first.server());
            // A Mac the desk trusted through the JDK (no pin) that now shows a certificate the JDK doesn't trust: a change too.
            String trusted = first.server().replaceAll(",?\"pin\":\"sha256:[0-9a-f]{64}\"", ",\"pin\":null").replace("{,", "{");
            try {
                prober.probe(bb.baseUrl(), pw.clone(), trusted, null);
                throw new AssertionError("trusted a new certificate on first use again");
            } catch (com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts.Rejected rj) {
                assertThat(rj.reason()).isEqualTo("certificate_changed");
                assertThat(rj.detail()).isEqualTo(fp);
            }
            assertThat(prober.probe(bb.baseUrl(), pw.clone(), trusted, fp).server()).isEqualTo(first.server());
        }
    }

    @Test
    void aMacThatFloodsIsCappedForTheDay(@TempDir Path dir) throws Exception {
        try (Rig r = new Rig(dir, FakeBlueBubbles.start(PW))) {
            String chat = r.bb.directChat(DANA);
            Instant t = Instant.now().minusSeconds(600);
            for (int i = 0; i < 30; i++) {
                r.bb.receive(chat, DANA, "flood " + i, t.plusMillis(i));
            }
            Net net = Net.forTests(FakeTls.clientContext());
            BlueBubblesPath.Settings st = BlueBubblesPath.Settings.forTests(r.bb.socketPort(), 10).withDailyCap(10);
            r.transport = new ImsgTransport(r.rig.module, Clock.systemUTC(), r.files, Duration.ofMillis(300))
                    .register(BlueBubblesPath.PATH, BlueBubblesPath.factory(net, st), BlueBubblesPath.prober(net, st)).start();
            r.connect();
            await().atMost(Duration.ofSeconds(15)).until(() -> "daily_cap".equals(r.sync().get("reason")));
            assertThat(r.sync().get("state")).isEqualTo("waiting");
            Thread.sleep(1_500);
            assertThat(r.count("SELECT count(*) FROM messages WHERE body_text LIKE 'flood %'")).isEqualTo(10);
        }
    }
}
