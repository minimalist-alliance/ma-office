package com.minimalistalliance.desk.deskd.rtc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The clipboard's side of rtc.sock (desk-rtc/README.md, "The clipboard"), against a fake desk-rtc on a real socket. */
class RtcClipboardTest {

    private static final Duration WAIT = Duration.ofSeconds(5);

    @TempDir
    Path dir;

    private FakeDeskRtc fake;
    private RtcClient client;

    @BeforeEach
    void setUp() throws Exception {
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        client = new RtcClient(new RtcClient.Config(socket, 4, () -> "203.0.113.7"));
        client.start(new RtcListener() {});
        await().until(client::isConfigured);
    }

    @AfterEach
    void tearDown() throws Exception {
        client.close();
        fake.close();
    }

    private static byte[] random(int bytes) {
        byte[] out = new byte[bytes];
        new Random(bytes).nextBytes(out);
        return out;
    }

    private <T> CompletableFuture<T> async(Call<T> call) {
        CompletableFuture<T> result = new CompletableFuture<>();
        Thread.ofVirtual().start(() -> {
            try {
                result.complete(call.run());
            } catch (Throwable e) {
                result.completeExceptionally(e);
            }
        });
        return result;
    }

    @FunctionalInterface
    private interface Call<T> {
        T run() throws Exception;
    }

    private static String codeOf(CompletableFuture<?> call) {
        try {
            call.get(10, TimeUnit.SECONDS);
        } catch (Exception e) {
            if (e.getCause() instanceof RtcException failure) {
                return failure.code();
            }
            throw new AssertionError(e);
        }
        throw new AssertionError("no failure");
    }

    @Test
    void aSetGoesAsBytesInPartsOfAtMost45KiBAndOkIsItsAnswer() throws Exception {
        fake.autoClipboard(true);
        byte[] text = random(1_000_000);
        client.clipboardSet(text, WAIT);
        assertThat(fake.clipboard()).isEqualTo(text);

        List<Map<String, Object>> parts = new ArrayList<>();
        for (int i = 0; i < 22; i++) {
            parts.add(fake.awaitJson("clipboard.set"));
        }
        Object id = parts.get(0).get("id");
        for (int i = 0; i < parts.size(); i++) {
            Map<String, Object> part = parts.get(i);
            assertThat(part).containsEntry("id", id).containsEntry("part", i).containsEntry("last", i == 21);
            assertThat(Base64.getDecoder().decode((String) part.get("data")).length).isLessThanOrEqualTo(45 * 1024);
        }
        assertThat(((Number) id).longValue()).isBetween(0L, (1L << 53) - 1);
    }

    @Test
    void eachEnvelopeIsJsonThatFitsOne() throws Exception {
        byte[] text = random(45 * 1024 * 2 + 1);
        List<byte[]> envelopes = RtcClipboard.setEnvelopes(7, text);
        assertThat(envelopes).hasSize(3);
        ByteArrayOutputStream joined = new ByteArrayOutputStream();
        for (int i = 0; i < envelopes.size(); i++) {
            ByteBuffer envelope = ByteBuffer.wrap(envelopes.get(i));
            int length = envelope.getInt();
            assertThat(length).isEqualTo(envelopes.get(i).length - 4).isLessThanOrEqualTo(RtcEnvelope.MAX_LENGTH);
            assertThat(envelope.get()).isEqualTo((byte) RtcEnvelope.TYPE_JSON);
            byte[] body = Arrays.copyOfRange(envelopes.get(i), 5, envelopes.get(i).length);
            Map<String, Object> message = Json.parseObject(body);
            assertThat(message).containsEntry("t", "clipboard.set").containsEntry("id", 7).containsEntry("part", i)
                    .containsEntry("last", i == 2);
            joined.write(Base64.getDecoder().decode((String) message.get("data")));
        }
        assertThat(joined.toByteArray()).isEqualTo(text);
    }

    @Test
    void aGetJoinsItsPartsAsBytes() throws Exception {
        fake.autoClipboard(true);
        // A 3-byte character straddles the first part's end: only the joined bytes are text.
        byte[] text = new byte[100_000];
        Arrays.fill(text, (byte) 'a');
        text[45 * 1024 - 1] = (byte) 0xE2;
        text[45 * 1024] = (byte) 0x98;
        text[45 * 1024 + 1] = (byte) 0x83;
        fake.clipboard(text);
        assertThat(client.clipboardGet(1_000_000, WAIT)).isEqualTo(text);
        assertThat(fake.awaitJson("clipboard.get")).containsEntry("maxBytes", 1_000_000);

        fake.clipboard(null);
        assertThat(client.clipboardGet(1_000_000, WAIT)).isNull();
    }

    @Test
    void desdRtcsCodesComeThroughAndAnyOtherIsInternal() throws Exception {
        for (String code : List.of("no_display", "timeout", "too_large", "internal", "something_new")) {
            CompletableFuture<byte[]> get = async(() -> client.clipboardGet(10, WAIT));
            Object id = fake.awaitJson("clipboard.get").get("id");
            fake.sendJson(Map.of("t", "clipboard.error", "id", id, "code", code));
            assertThat(codeOf(get)).isEqualTo(code.equals("something_new") ? "internal" : code);
        }
    }

    @Test
    void moreThanWasAskedForIsTooLargeAndNeverACutPiece() throws Exception {
        CompletableFuture<byte[]> get = async(() -> client.clipboardGet(10, WAIT));
        Object id = fake.awaitJson("clipboard.get").get("id");
        fake.sendClipboardText(id, random(20), 100);
        assertThat(codeOf(get)).isEqualTo("too_large");
    }

    @Test
    void aPartOutOfOrderOrABadOneFailsTheGet() throws Exception {
        List<Map<String, Object>> bad = List.of(
                Map.of("t", "clipboard.text", "part", 1, "last", true, "data", "YQ=="),
                Map.of("t", "clipboard.text", "part", 0, "last", true, "data", "not base64!"),
                Map.of("t", "clipboard.text", "part", 0, "last", true),
                Map.of("t", "clipboard.text", "part", 0, "last", false, "none", true),
                Map.of("t", "clipboard.ok"));
        for (Map<String, Object> message : bad) {
            CompletableFuture<byte[]> get = async(() -> client.clipboardGet(10, WAIT));
            Map<String, Object> reply = new LinkedHashMap<>(message);
            reply.put("id", fake.awaitJson("clipboard.get").get("id"));
            fake.sendJson(reply);
            assertThat(codeOf(get)).as("%s", message).isEqualTo("internal");
        }
    }

    @Test
    void lateRepliesSecondRepliesAndIdsDeskdNeverSentAreDropped() throws Exception {
        CompletableFuture<byte[]> late = async(() -> client.clipboardGet(10, Duration.ofMillis(300)));
        Object lateId = fake.awaitJson("clipboard.get").get("id");
        // Heard, so this wait running out isn't taken for a desk-rtc without a clipboard.
        fake.clipboardChanged();
        assertThat(codeOf(late)).isEqualTo("no_reply");
        fake.sendClipboardText(lateId, "late".getBytes(), 10);
        for (Object id : List.of(-1, 1.5, "1", 1L << 53)) {
            fake.sendJson(Map.of("t", "clipboard.ok", "id", id));
        }

        CompletableFuture<byte[]> get = async(() -> client.clipboardGet(10, WAIT));
        Object id = fake.awaitJson("clipboard.get").get("id");
        assertThat(id).isNotEqualTo(lateId);
        fake.sendClipboardText(id, "now".getBytes(), 10);
        fake.sendJson(Map.of("t", "clipboard.error", "id", id, "code", "internal"));
        assertThat(get.get(10, TimeUnit.SECONDS)).isEqualTo("now".getBytes());
        assertThat(client.isConfigured()).isTrue();
    }

    @Test
    void aConnectionWhoseClipboardNeverAnswersIsSilentUntilItSpeaksOrIsReplaced() throws Exception {
        assertThat(codeOf(async(() -> {
            client.clipboardSet("x".getBytes(), Duration.ofMillis(300));
            return null;
        }))).isEqualTo("no_reply");
        fake.awaitJson("clipboard.set");

        long started = System.nanoTime();
        assertThat(codeOf(async(() -> client.clipboardGet(10, WAIT)))).isEqualTo("no_reply");
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(2));
        assertThat(fake.pollJson(200)).isNull();

        fake.clipboardChanged();
        await().untilAsserted(() -> {
            CompletableFuture<byte[]> get = async(() -> client.clipboardGet(10, Duration.ofMillis(200)));
            assertThat(fake.awaitJson("clipboard.get")).isNotNull();
            codeOf(get);
        });

        // Silent again, then a new connection starts afresh.
        codeOf(async(() -> client.clipboardGet(10, Duration.ofMillis(200))));
        fake.drop();
        await().until(() -> fake.connectionCount() == 2 && client.isConfigured());
        fake.autoClipboard(true);
        fake.clipboard("back".getBytes());
        assertThat(client.clipboardGet(10, WAIT)).isEqualTo("back".getBytes());
    }

    @Test
    void anInterruptDoesntCutASetsWaitShort() throws Exception {
        CompletableFuture<Boolean> interrupted = new CompletableFuture<>();
        Thread setter = Thread.ofVirtual().start(() -> {
            try {
                client.clipboardSet("text".getBytes(), WAIT);
                interrupted.complete(Thread.currentThread().isInterrupted());
            } catch (Throwable e) {
                interrupted.completeExceptionally(e);
            }
        });
        Object id = fake.awaitJson("clipboard.set").get("id");
        setter.interrupt();
        Thread.sleep(300);
        assertThat(interrupted).isNotDone();
        fake.sendJson(Map.of("t", "clipboard.ok", "id", id));
        assertThat(interrupted.get(10, TimeUnit.SECONDS)).as("interrupt kept").isTrue();
    }

    @Test
    void aSecondSetWhileOneIsUnderWayIsABug() throws Exception {
        CompletableFuture<Object> first = async(() -> {
            client.clipboardSet("one".getBytes(), WAIT);
            return null;
        });
        Object id = fake.awaitJson("clipboard.set").get("id");
        assertThatThrownBy(() -> client.clipboardSet("two".getBytes(), WAIT)).isInstanceOf(IllegalStateException.class);
        fake.sendJson(Map.of("t", "clipboard.ok", "id", id));
        first.get(10, TimeUnit.SECONDS);
        assertThat(fake.pollJson(200)).isNull();
    }

    @Test
    void aDroppedConnectionFailsWhatsPendingAndThereIsNoConnectionUntilTheNext() throws Exception {
        CompletableFuture<byte[]> get = async(() -> client.clipboardGet(10, WAIT));
        fake.awaitJson("clipboard.get");
        fake.close();
        assertThat(codeOf(get)).isEqualTo("unavailable");
        await().until(() -> !client.isConfigured());
        assertThat(codeOf(async(() -> client.clipboardGet(10, WAIT)))).isEqualTo("unavailable");
    }

    @Test
    void watchGoesOnEveryConnectionAfterConfigureWhileItsWanted() throws Exception {
        fake.autoClipboard(true);
        client.clipboardWatch(true);
        await().until(fake::watching);
        client.clipboardWatch(true);

        fake.recordOrder(true);
        fake.drop();
        await().until(() -> fake.connectionCount() == 2 && fake.watching());
        assertThat(fake.order()).containsSubsequence("configure", "clipboard.watch");
        assertThat(fake.order().stream().filter("clipboard.watch"::equals)).hasSize(1);

        client.clipboardWatch(false);
        await().until(() -> !fake.watching());
        fake.drop();
        await().until(() -> fake.connectionCount() == 3 && client.isConfigured());
        Thread.sleep(200);
        assertThat(fake.order().stream().filter("clipboard.watch"::equals)).hasSize(2);
    }

    @Test
    void changedRunsTheListener() throws Exception {
        AtomicInteger changes = new AtomicInteger();
        client.onClipboardChanged(changes::incrementAndGet);
        fake.clipboardChanged();
        fake.clipboardChanged();
        await().until(() -> changes.get() == 2);
    }

    @Test
    void aSetsPartsGoBelowSessionDataAndStillGetThrough() throws Exception {
        long handle = client.createSession("cs-1", "offer", "ab".repeat(32), true, false).handle();
        List<byte[]> frames = new ArrayList<>();
        for (int i = 0; i < 1024; i++) {
            frames.add(new Frame(FrameKind.DATA, Frame.BIN, i, 0, new byte[Frame.MAX_FRAME_BYTES - Frame.HEADER_BYTES]).encode());
        }
        fake.autoClipboard(true);
        fake.recordOrder(true);
        // 16 MiB of session data waiting, and a set of 1 MB queued behind it before any more is read.
        byte[] text = random(1_000_000);
        fake.pauseReading(true);
        assertThat(client.offer(handle, Channels.EVENTS, frames)).isTrue();
        CompletableFuture<Object> set = async(() -> {
            client.clipboardSet(text, Duration.ofSeconds(30));
            return null;
        });
        Thread.sleep(300);
        fake.pauseReading(false);
        set.get(30, TimeUnit.SECONDS);
        assertThat(fake.clipboard()).isEqualTo(text);

        List<String> order = fake.order();
        int firstPart = order.indexOf("clipboard.set");
        int lastPart = order.lastIndexOf("clipboard.set");
        assertThat(order.subList(0, firstPart)).as("data first").anyMatch(entry -> entry.startsWith("data:"));
        long dataBeforeLast = order.subList(0, lastPart).stream().filter(entry -> entry.startsWith("data:")).count();
        assertThat(dataBeforeLast).as("the set isn't starved").isLessThan(frames.size());
        // Between one part and the next, session data went, so the parts didn't go ahead of it all at once.
        List<Long> gaps = new ArrayList<>();
        long dataSince = 0;
        for (String entry : order.subList(firstPart + 1, lastPart + 1)) {
            if (entry.startsWith("data:")) {
                dataSince += Long.parseLong(entry.substring(5));
            } else if (entry.equals("clipboard.set")) {
                gaps.add(dataSince);
                dataSince = 0;
            }
        }
        assertThat(gaps).hasSize(21);
        assertThat(gaps.stream().filter(gap -> gap > 0).count()).as("gaps with data in them: %s", gaps).isGreaterThanOrEqualTo(10);
        assertThat(gaps).as("none waits much past its share").allMatch(gap -> gap <= RtcClient.CLIPBOARD_SHARE + 64 * 1024);
    }
}
