package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The idempotent sink: keys, refusals, the parser's absence, cursors committed with their messages, and the raw bytes. */
class SinkTest {

    @Test
    void theSameMessageTwiceIsStoredOnce(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            Mail m = Mail.from("Dana <dana@example.com>").id("1@example.com");
            Courier.Accepted first = rig.accept(m);
            Courier.Accepted again = rig.accept(m);
            assertThat(first.kind()).isEqualTo(Courier.Accepted.Kind.STORED);
            assertThat(again.kind()).isEqualTo(Courier.Accepted.Kind.DUPLICATE);
            assertThat(again.messageId()).isEqualTo(first.messageId());
            // In one batch too.
            Courier.Inbound in = Mail.from("Dana <dana@example.com>").id("2@example.com").inbound(StoreRig.DESK);
            List<Courier.Accepted> both = rig.store.accept(List.of(in, in), null);
            assertThat(both.get(0).kind()).isEqualTo(Courier.Accepted.Kind.STORED);
            assertThat(both.get(1).kind()).isEqualTo(Courier.Accepted.Kind.DUPLICATE);
            assertThat(both.get(1).messageId()).isEqualTo(both.get(0).messageId());
        }
    }

    @Test
    void aDuplicateIsFoundBeforeAnyParse(@TempDir Path dir) throws Exception {
        int[] parses = {0};
        CourierParser counting = raw -> {
            parses[0]++;
            return TestMime.PARSER.parse(raw);
        };
        try (StoreRig rig = new StoreRig(dir, counting)) {
            Mail m = Mail.from("Dana <dana@example.com>").id("1@example.com");
            rig.accept(m);
            rig.accept(m);
            rig.accept(m);
            assertThat(parses[0]).isEqualTo(1);
        }
    }

    @Test
    void theRawBytesAreKeptExactly(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            byte[] raw = ("From: Dana <dana@example.com>\r\nTo: me@desk.example\r\nSubject: =?utf-8?B?w6l0w6k=?=\r\n"
                    + "Message-ID: <raw@example.com>\r\n\r\nline one\r\né\r\n.\r\n").getBytes(StandardCharsets.ISO_8859_1);
            Courier.Accepted a = rig.store.accept(Courier.Inbound.email(StoreRig.DESK, "e:raw", raw, Courier.Origin.LIVE));
            Map<String, Object> m = rig.store.queries().message(a.messageId(), 0);
            assertThat(m.get("subject")).isEqualTo("été");
            assertThat(m.get("rawBytes")).isEqualTo((long) raw.length);
            assertThat(rig.store.raw(a.messageId())).isEqualTo(raw);
        }
    }

    @Test
    void aSmallMessagesBytesAreARowAndALargeOnesAFileAndAPurgeTakesBoth(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            Mail small = Mail.from("Dana <dana@example.com>").id("small@example.com").text("Hello again. ".repeat(4000));
            Mail large = Mail.from("Dana <dana@example.com>").id("large@example.com").text(CourierCrashChild.noise(1, 200_000));
            Courier.Accepted s = rig.accept(small);
            Courier.Accepted l = rig.accept(large);
            // The same bytes through a second account: another message, the same blob.
            Courier.Accepted twin = rig.accept(small, StoreRig.GMAIL);
            assertThat(twin.messageId()).isNotEqualTo(s.messageId());
            assertThat(Invariants.scalar(rig.store, "SELECT count(*) FROM blob_data")).isEqualTo(1);
            assertThat(blobFiles(dir)).hasSize(1);
            assertThat(rig.store.raw(s.messageId())).isEqualTo(small.bytes());
            assertThat(rig.store.raw(twin.messageId())).isEqualTo(small.bytes());
            assertThat(rig.store.raw(l.messageId())).isEqualTo(large.bytes());
            Invariants.check(rig.store);

            // One of the two named: the row stays. Both gone: so is it. The file goes with its message.
            rig.store.actions().delete(List.of(s.messageId(), l.messageId()), false);
            rig.store.actions().delete(List.of(s.messageId(), l.messageId()), true);
            assertThat(Invariants.scalar(rig.store, "SELECT count(*) FROM blob_data")).isEqualTo(1);
            assertThat(rig.store.raw(twin.messageId())).isEqualTo(small.bytes());
            assertThat(blobFiles(dir)).isEmpty();
            rig.store.actions().delete(List.of(twin.messageId()), false);
            rig.store.actions().delete(List.of(twin.messageId()), true);
            assertThat(Invariants.scalar(rig.store, "SELECT count(*) FROM blob_data")).isZero();
            Invariants.check(rig.store);
        }
    }

    private static List<Path> blobFiles(Path dir) throws Exception {
        try (var walk = Files.walk(dir.resolve("courier/blobs"))) {
            return walk.filter(Files::isRegularFile).filter(p -> !p.toString().contains("/.staged/")).toList();
        }
    }

    @Test
    void whatIsntAMessageIsRefusedAndNothingIsKept(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            byte[] raw = Mail.from("a@b.example").bytes();
            assertThat(rig.store.accept(Courier.Inbound.email("nobody", "e:1", raw, null)).reason()).isEqualTo("account");
            assertThat(rig.store.accept(Courier.Inbound.email(StoreRig.DESK, "", raw, null)).reason()).isEqualTo("external_id");
            assertThat(rig.store.accept(Courier.Inbound.email(StoreRig.DESK, "has space", raw, null)).reason()).isEqualTo("external_id");
            assertThat(rig.store.accept(new Courier.Inbound(StoreRig.DESK, "fax", "x", null, raw, null, null, false, false, null, null)).reason())
                    .isEqualTo("medium");
            assertThat(rig.store.accept(Courier.Inbound.chat(StoreRig.MA, "ma", "m:1", null, null)).reason()).isEqualTo("content");
            assertThat(rig.store.accept(Courier.Inbound.email(StoreRig.DESK, "e:2", null, null)).reason()).isEqualTo("content");
            Map<String, Object> counts = rig.store.queries().counts();
            assertThat(counts.get("pending")).isEqualTo(0L);
            assertThat(rig.store.integrity()).containsExactly("ok");
        }
    }

    @Test
    void withNoParserAnEmailWaitsWithItsBytesAndIsReadLater(@TempDir Path dir) throws Exception {
        AtomicBoolean up = new AtomicBoolean(false);
        CourierParser sometimes = raw -> {
            if (!up.get()) {
                throw new CourierParser.Unavailable("down");
            }
            return TestMime.PARSER.parse(raw);
        };
        try (StoreRig rig = new StoreRig(dir, sometimes)) {
            Courier.Accepted a = rig.accept(Mail.from("Dana <dana@example.com>").id("w@example.com").subject("Waiting"));
            assertThat(a.kind()).isEqualTo(Courier.Accepted.Kind.PENDING);
            assertThat(rig.store.queries().counts().get("pending")).isEqualTo(1L);
            assertThat(rig.store.queries().message(a.messageId(), 0)).isNull();
            assertThat(rig.store.reparsePending(10)).isZero();
            // A second copy while it waits is still the same message.
            assertThat(rig.accept(Mail.from("Dana <dana@example.com>").id("w@example.com").subject("Waiting")).kind())
                    .isEqualTo(Courier.Accepted.Kind.DUPLICATE);
            up.set(true);
            assertThat(rig.store.reparsePending(10)).isEqualTo(1);
            assertThat(rig.store.queries().counts().get("pending")).isEqualTo(0L);
            Map<String, Object> list = rig.store.queries().list("requests", null, null, 50, false);
            List<?> rows = (List<?>) list.get("rows");
            assertThat(rows).hasSize(1);
            assertThat(((Map<?, ?>) ((Map<?, ?>) rows.get(0)).get("last")).get("subject")).isEqualTo("Waiting");
        }
    }

    @Test
    void aRefusalIsShownAsUnreadableWithTheRawKept(@TempDir Path dir) throws Exception {
        CourierParser refusing = raw -> new CourierParser.Refused("too_deep");
        try (StoreRig rig = new StoreRig(dir, refusing)) {
            byte[] raw = Mail.from("Dana <dana@example.com>").bytes();
            Courier.Accepted a = rig.store.accept(Courier.Inbound.email(StoreRig.DESK, "e:deep", raw, null));
            assertThat(a.kind()).isEqualTo(Courier.Accepted.Kind.STORED);
            Map<String, Object> m = rig.store.queries().message(a.messageId(), 0);
            assertThat(m.get("parse")).isEqualTo(Map.of("state", "refused", "reason", "too_deep"));
            assertThat(m.get("lane")).isEqualTo("requests");
            assertThat(rig.store.raw(a.messageId())).isEqualTo(raw);
        }
    }

    @Test
    void aMessageOverTheLimitIsAStubWithNoBytes(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            byte[] raw = new byte[49 * 1024 * 1024];
            java.util.Arrays.fill(raw, (byte) 'a');
            Courier.Accepted a = rig.store.accept(Courier.Inbound.email(StoreRig.GMAIL, "e:huge", raw, null));
            Map<String, Object> m = rig.store.queries().message(a.messageId(), 0);
            assertThat(m.get("parse")).isEqualTo(Map.of("state", "refused", "reason", "too_large"));
            assertThat(m.get("rawBytes")).isEqualTo((long) raw.length);
            assertThat(rig.store.raw(a.messageId())).isNull();
        }
    }

    @Test
    void theCursorCommitsWithItsMessagesOrNotAtAll(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            List<Courier.Inbound> batch = List.of(
                    Mail.from("a@x.example").id("a@x").inbound(StoreRig.GMAIL),
                    Mail.from("b@x.example").id("b@x").inbound(StoreRig.GMAIL));
            rig.store.accept(batch, new Courier.CursorUpdate(StoreRig.GMAIL, "INBOX", "uid:2"));
            assertThat(rig.store.cursor(StoreRig.GMAIL, "INBOX")).isEqualTo("uid:2");
            // A cursor the store refuses rolls the whole batch back.
            List<Courier.Inbound> more = List.of(Mail.from("c@x.example").id("c@x").inbound(StoreRig.GMAIL));
            assertThatThrownBy(() -> rig.store.accept(more, new Courier.CursorUpdate(StoreRig.GMAIL, "INBOX", "x".repeat(5000))))
                    .isInstanceOf(java.sql.SQLException.class);
            assertThat(rig.store.cursor(StoreRig.GMAIL, "INBOX")).isEqualTo("uid:2");
            assertThat(rig.store.accept(more.get(0)).kind()).isEqualTo(Courier.Accepted.Kind.STORED);
            try (var staged = Files.list(dir.resolve("courier/blobs/.staged"))) {
                assertThat(staged.toList()).isEmpty();
            }
        }
    }

    @Test
    void theMembersOwnSentMailComesBackAsTheSameMessage(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.outbox().register("email", null, item -> new com.minimalistalliance.desk.deskd.courier.store.Outbox.Sent(Map.of()));
            Object[] draft = rig.store.actions().saveDraft(null, null, "email", StoreRig.GMAIL, List.of("dana@example.com"), "Plans", "See you", null, null);
            Object[] sent = rig.store.outbox().send((String) draft[0]);
            String msgid = (String) rig.store.queries().message((String) sent[0], 0).get("rfcMessageId");
            assertThat(msgid).endsWith("@gmail.example");
            // The Sent folder's copy, synced later, is the same message.
            Courier.Accepted echo = rig.store.accept(Mail.from("Me <me@gmail.example>").to("dana@example.com").id(msgid).subject("Plans")
                    .inbound(StoreRig.GMAIL).asOutgoing());
            assertThat(echo.kind()).isEqualTo(Courier.Accepted.Kind.DUPLICATE);
            assertThat(echo.messageId()).isEqualTo(sent[0]);
        }
    }

    @Test
    void plusAddressingIsTheSameDeskWithALabel(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            Courier.Accepted a = rig.accept(Mail.from("Shop <orders@shop.example>").to("me+shop@desk.example").id("o@shop"));
            Map<String, Object> m = rig.store.queries().message(a.messageId(), 0);
            assertThat(m.get("labels")).isEqualTo(List.of("shop"));
            assertThat(m.get("direction")).isEqualTo("in");
        }
    }

    @Test
    void chatMediaComeStructured(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            ParsedMessage text = ParsedMessage.chat(new ParsedMessage.Address("Mum", "+1 555 010 2030"),
                    List.of(new ParsedMessage.Address(null, "+15550000000")), "Call me", 1_762_000_000_000L, List.of());
            Courier.Accepted a = rig.store.accept(Courier.Inbound.chat(StoreRig.IMSG, "imessage", "bb:guid-1", text, null));
            Map<String, Object> m = rig.store.queries().message(a.messageId(), 0);
            assertThat(m.get("medium")).isEqualTo("imessage");
            assertThat(m.get("text")).isEqualTo("Call me");
            assertThat(m.get("lane")).isEqualTo("requests");
            assertThat(((Map<?, ?>) ((Map<?, ?>) m.get("from")).get("endpoint")).get("value")).isEqualTo("+15550102030");
            assertThat(m.get("threadId")).isNull();
            assertThat(rig.store.accept(Courier.Inbound.chat(StoreRig.IMSG, "imessage", "bb:guid-1", text, null)).kind())
                    .isEqualTo(Courier.Accepted.Kind.DUPLICATE);
        }
    }

    @Test
    void theReceiveTimeNeverGoesBackWhenTheClockDoes(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            Courier.Accepted a = rig.accept(Mail.from("a@x.example").id("t1@x"));
            rig.clock.advance(Duration.ofHours(-5));
            Courier.Accepted b = rig.accept(Mail.from("a@x.example").id("t2@x"));
            long ra = (Long) rig.store.queries().message(a.messageId(), 0).get("receivedAt");
            long rb = (Long) rig.store.queries().message(b.messageId(), 0).get("receivedAt");
            assertThat(rb).isGreaterThanOrEqualTo(ra);
            assertThat(b.messageId()).isGreaterThan(a.messageId());
            rig.reopen();
            Courier.Accepted c = rig.accept(Mail.from("a@x.example").id("t3@x"));
            assertThat((Long) rig.store.queries().message(c.messageId(), 0).get("receivedAt")).isGreaterThanOrEqualTo(rb);
        }
    }

    @Test
    void aStoreFromANewerReleaseIsRefused(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.close();
            try (var c = java.sql.DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("courier/courier.db"));
                    var s = c.createStatement()) {
                s.execute("PRAGMA user_version = 99");
            }
            assertThatThrownBy(() -> CourierStore.open(dir.resolve("courier"), TestMime.PARSER, rig.clock, CourierStore.Settings.DEFAULT))
                    .isInstanceOf(java.sql.SQLException.class).hasMessageContaining("newer");
            rig.store = null;
        }
    }
}
