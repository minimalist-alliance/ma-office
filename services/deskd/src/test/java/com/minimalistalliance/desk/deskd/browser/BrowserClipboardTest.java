package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * browser.clipboard.write, browser.clipboard.read and the topic browser.clipboard (API.md section 10), from a
 * client's frames to a fake desk-rtc's clipboard, on real Unix sockets.
 */
@ExtendWith(OutputCaptureExtension.class)
class BrowserClipboardTest {

    private static final BrowserClipboard.Timing TIMING =
            new BrowserClipboard.Timing(Duration.ofSeconds(2), Duration.ofSeconds(2), Duration.ofMillis(250));
    private static final String WRITE = "browser.clipboard.write";
    private static final String READ = "browser.clipboard.read";
    private static final Map<String, Object> PERMISSION = Map.of("reason", "permission");
    private static final Map<String, Object> DISPLAY = Map.of("reason", "display");
    private static final Map<String, Object> CLIPBOARD = Map.of("reason", "clipboard");
    private static final Map<String, Object> TEXT = Map.of("reason", "text");
    private static final Map<String, Object> CAP = Map.of("limit", 1_000_000);

    @TempDir
    Path dir;

    private BrowserRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new BrowserRig(dir, 9, BrowserRig.FAST, new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, 9, BrowserRig.ownUid()), TIMING);
        rig.fake.autoClipboard(true);
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private Map<String, Object> write(TestClient client, Object text) throws Exception {
        Map<String, Object> params = new HashMap<>();
        params.put("text", text);
        return rig.call(client, WRITE, params, null);
    }

    private Map<String, Object> read(TestClient client) throws Exception {
        return rig.call(client, READ, Map.of(), null);
    }

    private long sendWrite(TestClient client, String text) {
        return rig.send(client, WRITE, Map.of("text", text), null);
    }

    private static void assertError(Map<String, Object> reply, String code, Map<String, Object> details) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", code);
        assertThat(reply.get("details")).isEqualTo(details);
    }

    private static void assertOk(Map<String, Object> reply) {
        assertThat(reply).containsEntry("_kind", "RES");
    }

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    /** The next clipboard message deskd sent of this type, skipping any other. */
    private Map<String, Object> next(String type) throws Exception {
        return rig.fake.awaitJson(type);
    }

    /** True if no message of this type comes within the wait. */
    private boolean noneWithin(String type, long millis) throws Exception {
        long deadline = System.currentTimeMillis() + millis;
        while (System.currentTimeMillis() < deadline) {
            Map<String, Object> message = rig.fake.pollJson(20);
            if (message != null && type.equals(message.get("t"))) {
                return false;
            }
        }
        return true;
    }

    private Map<String, Object> replyTo(TestClient client, long id) throws Exception {
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", id);
        return reply;
    }

    // ---- write and read

    @Test
    void aWriteSetsTheDesksClipboardAndAReadGetsItBack() throws Exception {
        TestClient client = rig.connect("cs-1");
        String text = "héllo ☃ 😀\nline two\ttab \"quoted\" \\";
        assertOk(write(client, text));
        assertThat(rig.fake.clipboard()).isEqualTo(utf8(text));
        assertThat(read(client)).containsEntry("_kind", "RES").containsEntry("text", text);
        assertThat(next("clipboard.get")).containsEntry("maxBytes", 1_000_000);
    }

    @Test
    void aMillionBytesGoBothWaysAndOneMoreIsRefusedWhole() throws Exception {
        TestClient client = rig.connect("cs-1");
        String text = "a".repeat(999_997) + "☃";
        assertOk(write(client, text));
        assertThat(rig.fake.clipboard()).isEqualTo(utf8(text));
        assertThat(read(client)).containsEntry("text", text);

        assertError(write(client, text + "b"), "too_large", CAP);
        assertError(write(client, "☃".repeat(333_334)), "too_large", CAP);
        assertThat(rig.fake.clipboard()).isEqualTo(utf8(text));

        byte[] over = new byte[1_000_001];
        Arrays.fill(over, (byte) 'z');
        rig.fake.clipboard(over);
        assertError(read(client), "too_large", CAP);
    }

    @Test
    void nulsCountTowardTheCapAsSentAndAreRemoved() throws Exception {
        TestClient client = rig.connect("cs-1");
        assertOk(write(client, "a\0b\0"));
        assertThat(rig.fake.clipboard()).isEqualTo(utf8("ab"));
        assertError(write(client, "a".repeat(999_999) + "\0\0"), "too_large", CAP);

        rig.fake.recordOrder(true);
        assertOk(write(client, "\0\0"));
        assertOk(write(client, ""));
        assertThat(rig.fake.order()).doesNotContain("clipboard.set");
        assertThat(rig.fake.clipboard()).isEqualTo(utf8("ab"));
    }

    @Test
    void textMustBeAStringOfWholeCharacters() throws Exception {
        TestClient client = rig.connect("cs-1");
        assertError(rig.call(client, WRITE, Map.of(), null), "bad_request", TEXT);
        assertError(write(client, 5), "bad_request", TEXT);
        assertError(write(client, List.of("a")), "bad_request", TEXT);
        // Half a surrogate pair, escaped in the JSON, as a client's JSON.stringify would send it.
        long id = 77_001;
        client.send(Channels.RPC, FrameKind.REQ, id, 0,
                "{\"m\":\"browser.clipboard.write\",\"p\":{\"text\":\"a\\ud83d\"}}".getBytes(StandardCharsets.US_ASCII));
        assertError(replyTo(client, id), "bad_request", TEXT);
        assertThat(rig.fake.clipboard()).isNull();
    }

    @Test
    void aRequestOverOneMiBOfJsonIsTooLargeAndTheSessionGoesOn() throws Exception {
        TestClient client = rig.connect("cs-1");
        // Under the cap in bytes, over 1 MiB as JSON: each newline takes 2.
        String text = "a".repeat(950_000) + "\n".repeat(50_000);
        assertError(write(client, text), "too_large", Map.of());
        assertThat(rig.fake.clipboard()).isNull();
        assertOk(write(client, "after"));
        assertThat(rig.fake.clipboard()).isEqualTo(utf8("after"));
    }

    @Test
    void aReadWhoseReplyWouldntFitIsTooLargeWithNothingElse(CapturedOutput output) throws Exception {
        TestClient client = rig.connect("cs-1");
        rig.fake.clipboard(utf8("a".repeat(950_000) + "\n".repeat(50_000)));
        assertError(read(client), "too_large", Map.of());
        assertThat(output.getAll()).doesNotContain("over the size limit");
        rig.fake.clipboard(utf8("fits"));
        assertThat(read(client)).containsEntry("text", "fits");
    }

    @Test
    void aReadIsCleanedJoinedAsBytesAndNullWhenThereIsNoText() throws Exception {
        TestClient client = rig.connect("cs-1");
        byte[] raw = new byte[100_000];
        Arrays.fill(raw, (byte) 'x');
        // A snowman across the first part's end, a NUL, a byte that's never UTF-8 and a sequence cut short.
        raw[46_079] = (byte) 0xE2;
        raw[46_080] = (byte) 0x98;
        raw[46_081] = (byte) 0x83;
        raw[10] = 0;
        raw[20] = (byte) 0xFF;
        raw[30] = (byte) 0xC3;
        String expected = new String(raw, StandardCharsets.UTF_8).replace("\0", "");
        rig.fake.clipboard(raw);
        Map<String, Object> reply = read(client);
        assertThat((String) reply.get("text")).isEqualTo(expected).contains("☃").doesNotContain("\0");
        assertThat(((String) reply.get("text")).chars().filter(c -> c == 0xFFFD).count()).isEqualTo(2);

        rig.fake.clipboard(null);
        assertThat(read(client)).containsEntry("_kind", "RES").containsEntry("text", null).containsKey("text");
        rig.fake.clipboard(new byte[] {0, 0, 0});
        assertThat(read(client)).containsEntry("text", null);
    }

    @Test
    void aReadPastTheCapOnceCleanedIsTooLarge() throws Exception {
        TestClient client = rig.connect("cs-1");
        byte[] raw = new byte[400_000];
        Arrays.fill(raw, (byte) 0xFF);
        rig.fake.clipboard(raw);
        assertError(read(client), "too_large", CAP);
    }

    // ---- who may

    @Test
    void writeNeedsInputAndReadAndTheTopicNeedVideoAndInput() throws Exception {
        TestClient watcher = rig.connect("cs-video", true, false);
        assertError(write(watcher, "x"), "forbidden", PERMISSION);
        assertError(read(watcher), "forbidden", PERMISSION);
        Map<String, Object> sub = watcher.subscribe(BrowserModule.CLIPBOARD_TOPIC, null);
        assertError(sub, "forbidden", PERMISSION);

        TestClient typist = rig.connect("cs-input", false, true);
        assertOk(write(typist, "typed"));
        assertError(read(typist), "forbidden", PERMISSION);
        assertError(typist.subscribe(BrowserModule.CLIPBOARD_TOPIC, null), "forbidden", PERMISSION);
        assertThat(rig.fake.clipboard()).isEqualTo(utf8("typed"));
        assertThat(rig.fake.watching()).isFalse();
    }

    /** The method table turns any other scope away before the clipboard's own check, which stays behind it. */
    @Test
    void onlyOwnerSessions() throws Exception {
        Map<String, Object> scope = Map.of("reason", "scope");
        for (String other : List.of("support", "export")) {
            TestClient session = rig.open("cs-" + other, other, true, true);
            session.hello();
            assertError(write(session, "x"), "forbidden", scope);
            assertError(read(session), "forbidden", scope);
            assertError(session.subscribe(BrowserModule.CLIPBOARD_TOPIC, null), "forbidden", scope);
        }
        assertThat(rig.fake.clipboard()).isNull();
    }

    @Test
    void aRefreshThatTakesAwayInputStopsAWriteWaitingItsTurn() throws Exception {
        rig.fake.autoClipboard(false);
        TestClient first = rig.connect("cs-1");
        TestClient second = rig.connect("cs-2");
        long one = sendWrite(first, "one");
        Object id = next("clipboard.set").get("id");
        long two = sendWrite(second, "two");
        assertThat(noneWithin("clipboard.set", 300)).isTrue();

        rig.refresh("cs-2", true, false, BrowserRig.fingerprintOf(second));
        rig.fake.sendJson(Map.of("t", "clipboard.ok", "id", id));
        assertOk(replyTo(first, one));
        assertError(replyTo(second, two), "forbidden", PERMISSION);
        assertThat(noneWithin("clipboard.set", 300)).isTrue();
    }

    @Test
    void aRefreshWhileAReadIsOutKeepsTheTextFromIt() throws Exception {
        rig.fake.autoClipboard(false);
        TestClient client = rig.connect("cs-1");
        long id = rig.send(client, READ, Map.of(), null);
        Object get = next("clipboard.get").get("id");
        rig.refresh("cs-1", false, true, BrowserRig.fingerprintOf(client));
        rig.fake.sendClipboardText(get, utf8("secret"), 1_000_000);
        assertError(replyTo(client, id), "forbidden", PERMISSION);
    }

    // ---- rtc.sock's rules

    @Test
    void writesGoOneAtATimeInTheOrderTheyCameAndACancelDoesntSkipTheWait() throws Exception {
        rig.fake.autoClipboard(false);
        TestClient client = rig.connect("cs-1");
        long one = sendWrite(client, "one");
        Map<String, Object> first = next("clipboard.set");
        assertThat(Base64.getDecoder().decode((String) first.get("data"))).isEqualTo(utf8("one"));
        client.send(Channels.RPC, FrameKind.CANCEL, one, 0, new byte[0]);
        assertError(replyTo(client, one), "cancelled", Map.of());

        long two = sendWrite(client, "two");
        assertThat(noneWithin("clipboard.set", 400)).as("the next set waits for the last one's answer").isTrue();
        rig.fake.sendJson(Map.of("t", "clipboard.ok", "id", first.get("id")));
        Map<String, Object> second = next("clipboard.set");
        assertThat(Base64.getDecoder().decode((String) second.get("data"))).isEqualTo(utf8("two"));
        rig.fake.sendJson(Map.of("t", "clipboard.ok", "id", second.get("id")));
        assertOk(replyTo(client, two));
    }

    @Test
    void moreThanFourWritesAtOnceAreRateLimited() throws Exception {
        rig.fake.autoClipboard(false);
        TestClient client = rig.connect("cs-1");
        List<Long> ids = new ArrayList<>();
        ids.add(sendWrite(client, "w0"));
        Object firstSet = next("clipboard.set").get("id");
        for (int i = 1; i < 5; i++) {
            ids.add(sendWrite(client, "w" + i));
        }
        Map<String, Object> refused = client.nextReply();
        assertError(refused, "rate_limited", Map.of("limit", "clipboard"));
        rig.fake.sendJson(Map.of("t", "clipboard.ok", "id", firstSet));
        List<Map<String, Object>> replies = new ArrayList<>(List.of(client.nextReply()));
        for (int i = 0; i < 3; i++) {
            rig.fake.sendJson(Map.of("t", "clipboard.ok", "id", next("clipboard.set").get("id")));
            replies.add(client.nextReply());
        }
        assertThat(replies).allSatisfy(BrowserClipboardTest::assertOk);
        List<Object> answered = new ArrayList<>(replies.stream().map(r -> r.get("_id")).toList());
        answered.add(refused.get("_id"));
        assertThat(answered).containsExactlyInAnyOrderElementsOf(ids);
    }

    @Test
    void readsThatComeWhileOneWaitsShareItsAnswer() throws Exception {
        rig.fake.autoClipboard(false);
        TestClient a = rig.connect("cs-a");
        TestClient b = rig.connect("cs-b");
        TestClient c = rig.connect("cs-c");
        long ra = rig.send(a, READ, Map.of(), null);
        Object first = next("clipboard.get").get("id");
        long rb = rig.send(b, READ, Map.of(), null);
        long rc = rig.send(c, READ, Map.of(), null);
        assertThat(noneWithin("clipboard.get", 300)).as("one get at a time").isTrue();

        rig.fake.sendClipboardText(first, utf8("first"), 1_000_000);
        assertThat(replyTo(a, ra)).containsEntry("text", "first");
        Object second = next("clipboard.get").get("id");
        rig.fake.sendClipboardText(second, utf8("second"), 1_000_000);
        assertThat(replyTo(b, rb)).containsEntry("text", "second");
        assertThat(replyTo(c, rc)).containsEntry("text", "second");
        assertThat(noneWithin("clipboard.get", 300)).isTrue();
    }

    @Test
    void deskRtcsCodesBecomeTheApisErrors() throws Exception {
        rig.fake.autoClipboard(false);
        TestClient client = rig.connect("cs-1");
        Map<String, Map<String, Object>> writes = Map.of(
                "no_display", DISPLAY, "timeout", DISPLAY, "internal", DISPLAY, "too_large", DISPLAY);
        for (Map.Entry<String, Map<String, Object>> entry : writes.entrySet()) {
            long id = sendWrite(client, "x");
            rig.fake.sendJson(Map.of("t", "clipboard.error", "id", next("clipboard.set").get("id"), "code", entry.getKey()));
            assertError(replyTo(client, id), "unavailable", entry.getValue());
        }
        Map<String, List<Object>> reads = Map.of(
                "no_display", List.of("unavailable", DISPLAY),
                "timeout", List.of("unavailable", CLIPBOARD),
                "internal", List.of("unavailable", CLIPBOARD),
                "too_large", List.of("too_large", CAP));
        for (Map.Entry<String, List<Object>> entry : reads.entrySet()) {
            long id = rig.send(client, READ, Map.of(), null);
            rig.fake.sendJson(Map.of("t", "clipboard.error", "id", next("clipboard.get").get("id"), "code", entry.getKey()));
            @SuppressWarnings("unchecked")
            Map<String, Object> details = (Map<String, Object>) entry.getValue().get(1);
            assertError(replyTo(client, id), (String) entry.getValue().get(0), details);
        }
    }

    @Test
    void aDeskRtcThatNeverAnswersIsDisplayOnceSlowlyThenAtOnceUntilItSpeaks() throws Exception {
        rig.fake.autoClipboard(false);
        TestClient client = rig.connect("cs-1");
        long started = System.nanoTime();
        assertError(write(client, "x"), "unavailable", DISPLAY);
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isGreaterThanOrEqualTo(TIMING.setWait());

        started = System.nanoTime();
        assertError(read(client), "unavailable", DISPLAY);
        assertError(write(client, "y"), "unavailable", DISPLAY);
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(TIMING.setWait());

        rig.fake.autoClipboard(true);
        rig.fake.clipboardChanged();
        await().untilAsserted(() -> assertOk(write(client, "z")));
        assertThat(rig.fake.clipboard()).isEqualTo(utf8("z"));
    }

    // ---- the topic

    @Test
    void theTopicHasNoFirstEventCarriesNoTextAndTurnsTheWatchOnAndOff() throws Exception {
        TestClient client = rig.connect("cs-1");
        Map<String, Object> sub = client.subscribe(BrowserModule.CLIPBOARD_TOPIC, null);
        assertOk(sub);
        long subId = ((Number) sub.get("subId")).longValue();
        await().until(rig.fake::watching);
        assertThat(rig.fake.pollFrame(client.handle(), Channels.EVENTS, 300)).isNull();

        rig.fake.clipboardChanged();
        Frame event = client.next(Channels.EVENTS);
        assertThat(event.id()).isEqualTo(subId);
        assertThat(Json.parseObject(event.payload())).isEqualTo(Map.of("type", "changed", "data", Map.of()));

        // A client's own write isn't a change: desk-rtc doesn't send one, and deskd makes none.
        assertOk(write(client, "mine"));
        assertThat(rig.fake.pollFrame(client.handle(), Channels.EVENTS, 300)).isNull();

        long unsub = 88_001;
        client.sendJson(Channels.RPC, FrameKind.UNSUB, unsub, Map.of("subId", subId));
        assertOk(replyTo(client, unsub));
        await().until(() -> !rig.fake.watching());
    }

    @Test
    void aRefreshThatTakesAwayVideoEndsTheTopicAndTheWatch() throws Exception {
        TestClient client = rig.connect("cs-1");
        assertOk(client.subscribe(BrowserModule.CLIPBOARD_TOPIC, null));
        await().until(rig.fake::watching);
        rig.refresh("cs-1", false, true, BrowserRig.fingerprintOf(client));
        Map<String, Object> error = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(error).isEqualTo(Map.of("type", "error", "data", Map.of("code", "forbidden")));
        await().until(() -> !rig.fake.watching());
    }

    @Test
    void theWatchStaysOnWhileAnySessionIsSubscribed() throws Exception {
        TestClient a = rig.connect("cs-a");
        TestClient b = rig.connect("cs-b");
        long subA = ((Number) a.subscribe(BrowserModule.CLIPBOARD_TOPIC, null).get("subId")).longValue();
        assertOk(b.subscribe(BrowserModule.CLIPBOARD_TOPIC, null));
        await().until(rig.fake::watching);

        a.sendJson(Channels.RPC, FrameKind.UNSUB, 99_001, Map.of("subId", subA));
        assertOk(replyTo(a, 99_001));
        Thread.sleep(300);
        assertThat(rig.fake.watching()).isTrue();

        rig.fake.clipboardChanged();
        assertThat(b.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "changed");
        assertThat(rig.fake.pollFrame(a.handle(), Channels.EVENTS, 200)).isNull();

        b.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000, "reason", "bye"));
        await().until(() -> !rig.fake.watching());
    }

    @Test
    void changesAreCoalescedToFourASecondAndTheLastAlwaysComes() throws Exception {
        TestClient client = rig.connect("cs-1");
        assertOk(client.subscribe(BrowserModule.CLIPBOARD_TOPIC, null));
        await().until(rig.fake::watching);
        for (int i = 0; i < 20; i++) {
            rig.fake.clipboardChanged();
        }
        long started = System.nanoTime();
        assertThat(client.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "changed");
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofMillis(200));
        assertThat(client.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "changed");
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isGreaterThanOrEqualTo(Duration.ofMillis(200));
        assertThat(rig.fake.pollFrame(client.handle(), Channels.EVENTS, 600)).isNull();
    }

    // ---- logs

    @Test
    void neitherTheTextNorItsLengthIsEverLogged(CapturedOutput output) throws Exception {
        TestClient client = rig.connect("cs-1");
        String marker = "zebra-marker-";
        String text = marker + "q".repeat(123_457 - marker.length());
        assertOk(write(client, text));
        assertThat(read(client)).containsEntry("text", text);
        assertError(write(client, text + "x".repeat(1_000_001 - text.length())), "too_large", CAP);
        rig.fake.clipboard(utf8(marker + "\n".repeat(999_000)));
        assertError(read(client), "too_large", Map.of());
        rig.fake.autoClipboard(false);
        long id = sendWrite(client, text);
        rig.fake.sendJson(Map.of("t", "clipboard.error", "id", next("clipboard.set").get("id"), "code", "no_display"));
        assertError(replyTo(client, id), "unavailable", DISPLAY);
        rig.fake.sendJson(Map.of("t", "clipboard.text", "id", "bad", "part", 0, "last", true, "data", "emVicmE="));

        String logged = output.getAll();
        assertThat(logged).doesNotContain(marker).doesNotContain("123457").doesNotContain("1000001").doesNotContain("999013");
        assertThat(logged).doesNotContain("emVicmE=");
    }
}
