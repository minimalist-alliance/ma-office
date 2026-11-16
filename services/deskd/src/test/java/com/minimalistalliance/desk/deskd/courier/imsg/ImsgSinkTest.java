package com.minimalistalliance.desk.deskd.courier.imsg;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.TestMime;
import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The {@code imsg} seam's shared mapping: what a Mac's message becomes in Courier, whichever path brought it. */
class ImsgSinkTest {

    private static final ImsgMessage.Chat DIRECT = new ImsgMessage.Chat("iMessage;-;+15551230001", false, null, List.of("+15551230001"));

    private static ImsgMessage msg(String guid, boolean fromMe, String sender, ImsgMessage.Chat chat, String text) {
        return new ImsgMessage(guid, 1_700_000_000_000L, fromMe, sender, "iMessage", chat, text, null, List.of(), null, null, null, null,
                false, false);
    }

    @Test
    void reactionsAreApplesOwnWords() {
        assertThat(ImsgSink.reaction("love", null, "see you at 6")).isEqualTo("Loved “see you at 6”");
        assertThat(ImsgSink.reaction("-emphasize", null, null)).isEqualTo("Removed an exclamation from a message");
        assertThat(ImsgSink.reaction("emoji", "👍", "ok")).isEqualTo("Reacted 👍 to “ok”");
        assertThat(ImsgSink.reaction("sticker-message", null, null)).isEqualTo("Sent a sticker.");
        assertThat(ImsgSink.reaction("something-new", null, "x")).isEqualTo("Reacted to “x”");
        assertThat(ImsgSink.reaction("", null, "x")).isNull();
        assertThat(ImsgSink.quote("a".repeat(100))).hasSize(60).endsWith("…");
        assertThat(ImsgSink.event("named", "Crag day")).isEqualTo("Named the conversation “Crag day”.");
        assertThat(ImsgSink.event("other", null)).isNull();
    }

    @Test
    void textsAreSmsAndEveryHandleIsNormalized() {
        assertThat(ImsgSink.medium("SMS;-;+15551230001", null)).isEqualTo("sms");
        assertThat(ImsgSink.medium("RCS;-;+15551230001", null)).isEqualTo("sms");
        assertThat(ImsgSink.medium("any;-;+15551230001", "SMS")).isEqualTo("sms");
        assertThat(ImsgSink.medium("iMessage;-;dana@icloud.example", "SMS")).isEqualTo("imessage");
        assertThat(ImsgSink.endpoint("tel:+1 (555) 123-0001")).isEqualTo("+15551230001");
        assertThat(ImsgSink.endpoint("mailto:Dana@iCloud.example")).isEqualTo("dana@icloud.example");
        assertThat(ImsgSink.endpoint("not a handle")).isNull();
        assertThat(ImsgSink.target("p:0/ABC-123")).isEqualTo("ABC-123");
        assertThat(ImsgSink.target("bp:ABC-123")).isEqualTo("ABC-123");
    }

    @Test
    void aMessageIsPlannedOnlyWhenItIsOne() {
        ImsgSink.Quotes none = g -> null;
        assertThat(ImsgSink.plan("imessage-a", msg("bad guid with spaces", false, "+15551230001", DIRECT, "x"), none)).isNull();
        assertThat(ImsgSink.plan("imessage-a", msg("G1", false, "bogus", new ImsgMessage.Chat("iMessage;+;chat1", true, null, List.of()), "x"),
                none)).isNull();
        ImsgMessage failed = new ImsgMessage("G2", 1L, true, null, null, DIRECT, "didn't go", null, List.of(), null, null, null, null, true, false);
        assertThat(ImsgSink.plan("imessage-a", failed, none)).isNull();

        ImsgSink.Planned in = ImsgSink.plan("imessage-a", msg("G3", false, null, DIRECT, "hi￼"), none);
        assertThat(in.externalId()).isEqualTo("imsg1:G3");
        assertThat(in.inbound().medium()).isEqualTo("imessage");
        assertThat(in.inbound().parsed().from().address()).isEqualTo("+15551230001");
        assertThat(in.inbound().parsed().text()).isEqualTo("hi");
        assertThat(in.inbound().group()).isNull();
        assertThat(in.chat()).isNull();

        ImsgSink.Planned mine = ImsgSink.plan("imessage-a", msg("G4", true, null, new ImsgMessage.Chat("SMS;-;+15551230001", false, null, List.of()),
                "from the phone"), none);
        assertThat(mine.inbound().outgoing()).isTrue();
        assertThat(mine.inbound().medium()).isEqualTo("sms");
        assertThat(mine.inbound().parsed().to()).extracting(a -> a.address()).containsExactly("+15551230001");

        ImsgMessage.Chat group = new ImsgMessage.Chat("iMessage;+;chat123", true, "Climbing", List.of("+15551230001", "+15551230002"));
        ImsgSink.Planned g = ImsgSink.plan("imessage-a", msg("G5", false, "+15551230002", group, "in"), none);
        Courier.Group key = g.inbound().group();
        assertThat(key.title()).isEqualTo("Climbing");
        assertThat(key.key()).startsWith("im1:").doesNotContain("chat123");
        assertThat(g.inbound().parsed().to()).extracting(a -> a.address()).containsExactly("+15551230001");
        assertThat(g.chat()).containsExactly("iMessage;+;chat123", "imessage");

        ImsgMessage empty = msg("G6", false, "+15551230001", DIRECT, null);
        assertThat(ImsgSink.plan("imessage-a", empty, none).inbound().parsed().text()).isEqualTo("Sent something only Messages can show.");
    }

    @Test
    void anEditAndAnUnsendAreEachTheirOwnMessage() {
        ImsgMessage edited = new ImsgMessage("G7", 1_700_000_000_000L, false, "+15551230001", null, DIRECT, "at 7", null, List.of(), null, null,
                1_700_000_100_000L, null, false, false);
        ImsgSink.Planned e = ImsgSink.change("imessage-a", edited, g -> "at 6");
        assertThat(e.externalId()).isEqualTo("imsg1e:G7:1700000100000");
        assertThat(e.inbound().parsed().text()).isEqualTo("Edited “at 6”: at 7");
        ImsgMessage unsent = new ImsgMessage("G8", 1_700_000_000_000L, false, "+15551230001", null, DIRECT, null, null, List.of(), null, null,
                null, 1_700_000_200_000L, false, false);
        assertThat(ImsgSink.change("imessage-a", unsent, g -> null).inbound().parsed().text()).isEqualTo("Unsent a message.");
        assertThat(ImsgSink.change("imessage-a", msg("G9", false, "+15551230001", DIRECT, "x"), g -> null)).isNull();
    }

    @Test
    void aFileNameCantBreakOutOfItsHeader() {
        assertThat(ImsgSink.fileName("../../etc/passwd", 1)).isEqualTo("_.._etc_passwd");
        assertThat(ImsgSink.fileName("a\"b\r\nX-Evil: 1.png", 1)).doesNotContain("\r").doesNotContain("\n").doesNotContain("\"");
        assertThat(ImsgSink.fileName(null, 3)).isEqualTo("file-3");
        assertThat(ImsgSink.size(5L * 1024 * 1024)).isEqualTo("5.0 MB");
    }

    private static CourierStore store(Path dir) throws Exception {
        CourierStore st = CourierStore.open(dir.resolve("courier"), TestMime.PARSER, Clock.systemUTC(), CourierStore.Settings.DEFAULT);
        st.putAccount(new Courier.Account("imessage-a", "imessage", "iMessage on your Mac", null, "ok"), List.of());
        return st;
    }

    private static ImsgMessage withFile(String guid, long date, int bytes) {
        return new ImsgMessage(guid, date, false, "+15551230001", "iMessage", DIRECT, "photo " + guid, null,
                List.of(new ImsgMessage.File("at_" + guid, guid + ".bin", "application/octet-stream", bytes)), null, null, null, null, false,
                false);
    }

    @Test
    void eachMessageWithFilesIsCommittedAloneSoOneMessagesFilesAreInTheHeapAtATime(@TempDir Path dir) throws Exception {
        try (CourierStore st = store(dir)) {
            ImsgSink sink = new ImsgSink(st, TestMime.PARSER, new ImsgSink.Settings(1 << 20, 1 << 20));
            List<ImsgMessage> page = new ArrayList<>();
            long t = System.currentTimeMillis() - 60_000;
            page.add(msg("T1", false, "+15551230001", DIRECT, "text before"));
            for (int i = 0; i < 4; i++) {
                page.add(withFile("F" + i, t + i, 600 * 1024));
            }
            page.add(msg("T2", false, "+15551230001", DIRECT, "text after"));
            ImsgSink.Result r = sink.store("imessage-a", page, n -> new Courier.CursorUpdate("imessage-a", "test", Integer.toString(n)),
                    (f, max) -> new byte[(int) f.bytes()], 0);
            assertThat(r.stored()).isEqualTo(6);
            // Before each file message, the file message alone, and the rest at the end: 1 + 4 + 4 + ... at least one per file message.
            assertThat(sink.commits.get()).isGreaterThanOrEqualTo(5);
            assertThat(st.cursor("imessage-a", "test")).isEqualTo("6");
        }
    }

    @Test
    void aSandboxThatCantBeReachedHoldsThePageWithWhatCameBeforeStored(@TempDir Path dir) throws Exception {
        try (CourierStore st = store(dir)) {
            AtomicInteger calls = new AtomicInteger();
            CourierParser flaky = raw -> {
                if (calls.incrementAndGet() >= 2) {
                    throw new CourierParser.Unavailable("down");
                }
                return TestMime.PARSER.parse(raw);
            };
            ImsgSink sink = new ImsgSink(st, flaky, new ImsgSink.Settings(1 << 20, 1 << 20));
            long t = System.currentTimeMillis() - 60_000;
            List<ImsgMessage> page = List.of(withFile("A", t, 1000), withFile("B", t + 1, 1000), withFile("C", t + 2, 1000));
            try {
                sink.store("imessage-a", page, n -> new Courier.CursorUpdate("imessage-a", "test", Integer.toString(n)), (f, max) -> new byte[1000], 0);
                throw new AssertionError("no hold");
            } catch (ImsgSink.Hold h) {
                assertThat(h.stored()).isEqualTo(1);
            }
            assertThat(st.cursor("imessage-a", "test")).isEqualTo("1");
            assertThat(st.imessage().known("imessage", List.of("imsg1:A", "imsg1:B"))).containsExactly("imsg1:A");
        }
    }

    @Test
    void aFileTheMacCantServeIsTriedAFewTimesThenLeftThereSoItCantStallTheRest(@TempDir Path dir) throws Exception {
        try (CourierStore st = store(dir)) {
            ImsgSink sink = new ImsgSink(st, TestMime.PARSER, new ImsgSink.Settings(1 << 20, 1 << 20));
            List<ImsgMessage> page = List.of(withFile("D", System.currentTimeMillis() - 60_000, 1000));
            ImsgSink.Files broken = (f, max) -> {
                throw new IOException("reset");
            };
            for (int i = 1; i < ImsgSink.FILE_TRIES; i++) {
                try {
                    sink.store("imessage-a", page, n -> null, broken, 0);
                    throw new AssertionError("stored on try " + i);
                } catch (IOException expected) {
                    // tried again next look
                }
            }
            ImsgSink.Result r = sink.store("imessage-a", page, n -> null, broken, 0);
            assertThat(r.stored()).isEqualTo(1);
            assertThat(st.imessage().textOf("imessage-a", "imsg1:D", "D")).contains("D.bin").contains("it stays in Messages on your Mac");
        }
    }

    @Test
    void aFirstSyncsOlderMessagesAreBackfillNotNewToAgents(@TempDir Path dir) throws Exception {
        try (CourierStore st = store(dir)) {
            ImsgSink sink = new ImsgSink(st, TestMime.PARSER, ImsgSink.Settings.DEFAULT);
            long now = System.currentTimeMillis();
            ImsgMessage old = new ImsgMessage("OLD", now - 5L * 86_400_000, false, "+15551230001", null, DIRECT, "last week", null, List.of(),
                    null, null, null, null, false, false);
            ImsgMessage fresh = new ImsgMessage("NEW", now - 60_000, false, "+15551230001", null, DIRECT, "just now", null, List.of(), null,
                    null, null, null, false, false);
            sink.store("imessage-a", List.of(old, fresh), n -> null, (f, m) -> null, now - 86_400_000);
            try (var c = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("courier").resolve("courier.db"));
                    var s = c.createStatement();
                    var rs = s.executeQuery("SELECT external_id, origin FROM messages ORDER BY external_id")) {
                List<String> rows = new ArrayList<>();
                while (rs.next()) {
                    rows.add(rs.getString(1) + "=" + rs.getString(2));
                }
                assertThat(rows).containsExactly("imsg1:NEW=live", "imsg1:OLD=backfill");
            }
        }
    }

    @Test
    void theContainerIsExactlyTheSizeItWasMadeForAndAFileIsOnePart() {
        ImsgSink sink = new ImsgSink(null, TestMime.PARSER, ImsgSink.Settings.DEFAULT);
        for (int n : new int[] {0, 1, 2, 3, 56, 57, 58, 1000, 65_537}) {
            List<byte[]> bytes = new ArrayList<>(List.of(new byte[n]));
            byte[] c = sink.container("héllo", List.of(new ImsgMessage.File("g", "évidence.pdf", "message/rfc822", n)), bytes);
            String text = new String(c, java.nio.charset.StandardCharsets.ISO_8859_1);
            assertThat(text).contains("Content-Type: application/octet-stream").doesNotContain("message/rfc822")
                    .contains("filename*=utf-8''%C3%A9vidence.pdf").endsWith("--\r\n");
            assertThat(bytes.get(0)).as("dropped once encoded").isNull();
            assertThat(TestMime.PARSER.parse(c)).isInstanceOf(CourierParser.Parsed.class);
        }
        assertThat(ImsgSink.base64Size(0)).isEqualTo(2);
        assertThat(ImsgSink.base64Size(57)).isEqualTo(76 + 2);
        assertThat(ImsgSink.base64Size(58)).isEqualTo(80 + 2 + 2);
    }
}
