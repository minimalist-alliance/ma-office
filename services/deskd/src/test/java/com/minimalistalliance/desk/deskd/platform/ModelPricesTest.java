package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.testing.ControlPlaneRig;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.FakePlatform.Reply;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** ADR 0043: deskd's fetch of the Platform's price table, against a real HTTP port and a real file. */
@ExtendWith(OutputCaptureExtension.class)
class ModelPricesTest {

    private static final String SENTINEL = "sentinel-model-name";
    private static final String TABLE = "{\"version\":1,\"checked\":\"2027-01-02\",\"note\":\"" + SENTINEL + "\",\"models\":{\"anthropic/"
            + SENTINEL + "\":{\"input\":\"1\",\"output\":\"2\"}}}";
    private static final String OTHER = "{\"version\":1,\"checked\":\"2027-02-03\",\"models\":{\"openai/x\":{\"input\":\"3\",\"output\":\"4\"}}}";
    /** The next fetch comes at once, and a failure after a short backoff that grows. */
    private static final ModelPrices.Timing FAST = new ModelPrices.Timing(
            Duration.ZERO, Duration.ofMillis(5), Duration.ZERO, Duration.ofMillis(5), Duration.ofMillis(20), Duration.ofSeconds(5));

    static {
        TestTiming.pollFast();
    }

    @TempDir
    Path dir;

    private FakePlatform platform;
    private PlatformHttp http;
    private ModelPrices prices;
    private final AtomicInteger changes = new AtomicInteger();

    @BeforeEach
    void setUp() throws Exception {
        platform = new FakePlatform();
        http = new PlatformHttp();
    }

    @AfterEach
    void tearDown() {
        if (prices != null) {
            prices.close();
        }
        http.close();
        platform.close();
    }

    private ModelPrices start(ModelPrices.Timing timing) {
        prices = new ModelPrices(http, platform::url, dir, timing);
        prices.onChange(changes::incrementAndGet);
        prices.start();
        return prices;
    }

    private Path file() {
        return dir.resolve(ModelPrices.FILE);
    }

    private String current() {
        byte[] table = prices.current();
        return table == null ? null : new String(table, StandardCharsets.UTF_8);
    }

    private long fetches() {
        return platform.countApi(FakePlatform.MODEL_PRICES);
    }

    /** Waits for the replies queued so far to be taken and one more fetch, so whatever they did has been done. */
    private void awaitTaken() {
        long seen = fetches();
        await().until(() -> platform.modelPricesReplies.isEmpty() && fetches() > seen);
    }

    @Test
    void a200IsCheckedKeptAndHandedOnAndItsEtagGoesBack() throws Exception {
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        start(FAST);

        FakePlatform.Request first = platform.awaitApi(FakePlatform.MODEL_PRICES);
        assertThat(first.method()).isEqualTo("GET");
        assertThat(first.header("if-none-match")).isNull();
        // No auth: this path isn't signed.
        assertThat(first.header("authorization")).isNull();
        await().until(() -> TABLE.equals(current()));
        assertThat(changes.get()).isEqualTo(1);
        assertThat(Files.readString(file())).isEqualTo(TABLE);
        assertThat(dir.resolve(ModelPrices.FILE + ".tmp")).doesNotExist();
        assertThat(platform.awaitApi(FakePlatform.MODEL_PRICES).header("if-none-match")).isEqualTo("\"v1\"");
    }

    @Test
    void a304ChangesNothing() throws Exception {
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        platform.modelPricesReplies.add(Reply.of(304, ""));
        platform.modelPricesReplies.add(Reply.of(304, ""));
        start(FAST);
        awaitTaken();
        assertThat(current()).isEqualTo(TABLE);
        assertThat(changes.get()).isEqualTo(1);
        assertThat(Files.readString(file())).isEqualTo(TABLE);
    }

    @Test
    void anUnchangedBodyIsNoChange() throws Exception {
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v2\""));
        start(FAST);
        await().until(() -> fetches() >= 3);
        assertThat(changes.get()).isEqualTo(1);
    }

    @Test
    void aNewTableReplacesTheOldOne() throws Exception {
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        platform.modelPricesReplies.add(Reply.of(200, OTHER, "\"v2\""));
        start(FAST);
        await().until(() -> OTHER.equals(current()));
        assertThat(changes.get()).isEqualTo(2);
        assertThat(Files.readString(file())).isEqualTo(OTHER);
    }

    /** The Platform hasn't got it yet, which is normal: nothing kept, nothing said, and no backing off. */
    @Test
    void a404IsQuietAndNormal(CapturedOutput output) throws Exception {
        start(FAST);
        await().until(() -> fetches() >= 5);
        assertThat(prices.current()).isNull();
        assertThat(changes.get()).isZero();
        assertThat(file()).doesNotExist();
        assertThat(output.getAll()).doesNotContain("the fetch failed");
    }

    @Test
    void a404KeepsTheLastGoodTable() throws Exception {
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        start(FAST);
        await().until(() -> TABLE.equals(current()));
        long seen = fetches();
        await().until(() -> fetches() >= seen + 3);
        assertThat(current()).isEqualTo(TABLE);
        assertThat(Files.readString(file())).isEqualTo(TABLE);
    }

    /** Backing off: each gap at least double the first, up to the most. One line for the whole run of failures. */
    @Test
    void a500BacksOffKeepsTheTableAndSaysSoOnce(CapturedOutput output) throws Exception {
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        for (int i = 0; i < 4; i++) {
            platform.modelPricesReplies.add(Reply.of(500, "broken " + SENTINEL));
        }
        ModelPrices.Timing timing = new ModelPrices.Timing(
                Duration.ZERO, Duration.ZERO, Duration.ZERO, Duration.ofMillis(40), Duration.ofMillis(160), Duration.ofSeconds(5));
        start(timing);
        platform.awaitApi(FakePlatform.MODEL_PRICES);
        await().until(() -> TABLE.equals(current()));
        long[] at = new long[5];
        for (int i = 0; i < at.length; i++) {
            platform.awaitApi(FakePlatform.MODEL_PRICES);
            at[i] = System.nanoTime();
        }
        assertThat(Duration.ofNanos(at[1] - at[0])).isGreaterThanOrEqualTo(Duration.ofMillis(30));
        assertThat(Duration.ofNanos(at[2] - at[1])).isGreaterThanOrEqualTo(Duration.ofMillis(70));
        assertThat(Duration.ofNanos(at[3] - at[2])).isGreaterThanOrEqualTo(Duration.ofMillis(150));
        assertThat(current()).isEqualTo(TABLE);
        assertThat(Files.readString(file())).isEqualTo(TABLE);
        assertThat(output.getAll().lines().filter(line -> line.contains("the fetch failed"))).hasSize(1);
        assertThat(output.getAll()).doesNotContain(SENTINEL);
    }

    @Test
    void aHugeBodyIsCutOffAndNothingKept() throws Exception {
        String huge = "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"1\",\"output\":\"1\"}},\"note\":\"" + "x".repeat(ModelPrices.MAX_BYTES) + "\"}";
        platform.modelPricesReplies.add(Reply.of(200, huge, "\"big\""));
        platform.modelPricesReplies.add(Reply.chunked(200, huge));
        start(FAST);
        awaitTaken();
        assertThat(prices.current()).isNull();
        assertThat(file()).doesNotExist();

        // Exactly the limit is allowed, and the fetches after a refusal still work.
        String padded = OTHER.substring(0, OTHER.length() - 1) + ",\"note\":\"";
        String most = padded + "x".repeat(ModelPrices.MAX_BYTES - padded.length() - 2) + "\"}";
        assertThat(most.getBytes(StandardCharsets.UTF_8)).hasSize(ModelPrices.MAX_BYTES);
        platform.modelPricesReplies.add(Reply.chunked(200, most));
        await().until(() -> most.equals(current()));
    }

    /** What desk-agent takes is what deskd keeps: the bundled table's shapes all pass. */
    @Test
    void aTableDeskAgentCanUsePasses() throws Exception {
        for (String good : new String[] {
            TABLE,
            OTHER,
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"0.075\",\"output\":\"0.30\",\"cachedInput\":\"0.0075\",\"cacheWrite\":\"0.09\"}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"1\",\"output\":\"2\",\"above\":{\"inputTokens\":200000,\"input\":\"2\",\"output\":\"4\"}}}}",
            "{\"version\":1,\"models\":{\"a/free\":{\"input\":\"0\",\"output\":\"0\"},\"a/b\":{\"input\":\"100000\",\"output\":\"2\"}}}",
        }) {
            assertThat(ModelPrices.valid(good.getBytes(StandardCharsets.UTF_8))).as(good).isTrue();
        }
        // desk-agent's bundled table is the format's reference: the Platform's is the same file.
        assertThat(ModelPrices.valid(Files.readAllBytes(Path.of("../desk-agent/src/main/resources/pricing.json")))).isTrue();
    }

    @Test
    void whatIsntATableIsNeverKept(CapturedOutput output) throws Exception {
        for (String bad : new String[] {
            "not json " + SENTINEL,
            "[\"" + SENTINEL + "\"]",
            "{\"version\":2,\"models\":{\"a/" + SENTINEL + "\":{}}}",
            "{\"version\":\"1\",\"models\":{\"a/b\":{}}}",
            "{\"version\":1,\"note\":\"" + SENTINEL + "\"}",
            "{\"version\":1,\"models\":{},\"note\":\"" + SENTINEL + "\"}",
            "{\"version\":1,\"models\":[1]}",
            "{\"version\":1,\"models\":{\"a/b\":{}}} trailing",
            // What desk-agent's parse refuses, so it never keeps a table it couldn't use: a price that isn't a decimal string,
            // one missing, one that isn't an object, a long prompt's tier without its length, and nothing priced at all.
            "{\"version\":1,\"models\":{\"a/b\":{}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"1\"}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":1,\"output\":\"2\"}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"1\",\"output\":\"2\",\"cachedInput\":0.5}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"one\",\"output\":\"2\"}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"-1\",\"output\":\"2\"}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"1e3\",\"output\":\"2\"}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"0.0000001\",\"output\":\"2\"}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"100000.000001\",\"output\":\"2\"}}}",
            "{\"version\":1,\"models\":{\"a/b\":3}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"1\",\"output\":\"2\",\"above\":{\"input\":\"2\",\"output\":\"4\"}}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"1\",\"output\":\"2\",\"above\":{\"inputTokens\":10,\"input\":\"2\"}}}}",
            "{\"version\":1,\"models\":{\"a/b\":{\"input\":\"0\",\"output\":\"0.00\"}}}",
            "{\"version\":1.0,\"models\":{\"a/b\":{\"input\":\"1\",\"output\":\"2\"}}}",
        }) {
            assertThat(ModelPrices.valid(bad.getBytes(StandardCharsets.UTF_8))).as(bad).isFalse();
            platform.modelPricesReplies.add(Reply.of(200, bad, "\"bad\""));
        }
        start(FAST);
        awaitTaken();
        assertThat(prices.current()).isNull();
        assertThat(changes.get()).isZero();
        assertThat(file()).doesNotExist();
        assertThat(output.getAll()).doesNotContain(SENTINEL);
    }

    @Test
    void badJsonLeavesTheLastGoodTable() throws Exception {
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        platform.modelPricesReplies.add(Reply.of(200, "not json", "\"v2\""));
        start(FAST);
        awaitTaken();
        assertThat(current()).isEqualTo(TABLE);
        assertThat(Files.readString(file())).isEqualTo(TABLE);
        assertThat(changes.get()).isEqualTo(1);
        // The bad reply's tag was never kept, so the next ask has the good one's.
        assertThat(platform.apiRequests.stream().filter(r -> FakePlatform.MODEL_PRICES.equals(r.path())).toList().getLast()
                .header("if-none-match")).isEqualTo("\"v1\"");
    }

    @Test
    void theLastGoodTableSurvivesARestartAndComesBeforeAnyFetch() throws Exception {
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        start(FAST);
        await().until(() -> TABLE.equals(current()));
        prices.close();

        changes.set(0);
        // A first fetch that's a long way off: what's there can only have come from the file.
        ModelPrices.Timing slow = new ModelPrices.Timing(
                Duration.ofHours(1), Duration.ofHours(1), Duration.ZERO, Duration.ofHours(1), Duration.ofHours(1), Duration.ofSeconds(5));
        long seen = fetches();
        start(slow);
        await().until(() -> TABLE.equals(current()));
        assertThat(changes.get()).isEqualTo(1);
        assertThat(fetches()).isEqualTo(seen);
    }

    @Test
    void aKeptFileThatIsntATableIsIgnoredAndReplaced(CapturedOutput output) throws Exception {
        Files.writeString(file(), "junk " + SENTINEL);
        ModelPrices.Timing slow = new ModelPrices.Timing(
                Duration.ofHours(1), Duration.ofHours(1), Duration.ZERO, Duration.ofHours(1), Duration.ofHours(1), Duration.ofSeconds(5));
        start(slow);
        await().until(() -> output.getAll().contains("the kept table isn't valid"));
        assertThat(prices.current()).isNull();
        assertThat(changes.get()).isZero();
        assertThat(output.getAll()).doesNotContain(SENTINEL);
        prices.close();

        platform.modelPricesReplies.add(Reply.of(200, OTHER, "\"v1\""));
        start(FAST);
        await().until(() -> OTHER.equals(current()));
        assertThat(Files.readString(file())).isEqualTo(OTHER);
    }

    /** A volume it can't write costs only surviving a restart: desk-agent still gets it, and the next fetch tries again. */
    @Test
    void aSaveThatFailsStillHandsItOnAndTriesAgain(CapturedOutput output) throws Exception {
        Files.createDirectory(file().resolveSibling("gone"));
        prices = new ModelPrices(http, platform::url, file().resolveSibling("gone").resolve("nothing"), FAST);
        prices.onChange(changes::incrementAndGet);
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        prices.start();
        await().until(() -> TABLE.equals(current()));
        assertThat(changes.get()).isEqualTo(1);
        assertThat(output.getAll()).contains("can't keep the table");
        // Not recorded, so the Platform sends the whole table again.
        await().until(() -> fetches() >= 3);
        assertThat(platform.apiRequests.stream().filter(r -> FakePlatform.MODEL_PRICES.equals(r.path())).toList().getLast()
                .header("if-none-match")).isNull();
    }

    @Test
    void anEtagThatCantBeSentBackIsDropped() throws Exception {
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "x".repeat(300)));
        start(FAST);
        await().until(() -> TABLE.equals(current()));
        long seen = fetches();
        await().until(() -> fetches() >= seen + 2);
        assertThat(platform.apiRequests.stream().filter(r -> FakePlatform.MODEL_PRICES.equals(r.path())).toList().getLast()
                .header("if-none-match")).isNull();
    }

    @Test
    void noBaseYetAsksNothingAndSaysNothing(CapturedOutput output) throws Exception {
        String[] base = {null};
        prices = new ModelPrices(http, () -> base[0], dir, FAST);
        prices.start();
        Thread.sleep(50);
        assertThat(fetches()).isZero();
        assertThat(output.getAll()).doesNotContain("the fetch failed");
        base[0] = platform.url();
        await().until(() -> fetches() > 0);
    }

    /** No body in any line, across every way a fetch goes. */
    @Test
    void noBodyInAnyLog(CapturedOutput output) throws Exception {
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        platform.modelPricesReplies.add(Reply.of(404, SENTINEL));
        platform.modelPricesReplies.add(Reply.of(500, SENTINEL));
        platform.modelPricesReplies.add(Reply.of(503, SENTINEL));
        platform.modelPricesReplies.add(Reply.of(200, "bad " + SENTINEL, "\"v2\""));
        platform.modelPricesReplies.add(Reply.of(304, ""));
        start(FAST);
        await().until(() -> platform.modelPricesReplies.isEmpty());
        prices.close();
        assertThat(current()).isEqualTo(TABLE);
        assertThat(output.getAll()).doesNotContain(SENTINEL);
    }

    @Test
    void aStalledBodyTimesOutAndTheNextFetchWorks() throws Exception {
        platform.modelPricesReplies.add(Reply.STALLED);
        platform.modelPricesReplies.add(Reply.of(200, TABLE, "\"v1\""));
        start(new ModelPrices.Timing(
                Duration.ZERO, Duration.ofHours(1), Duration.ZERO, Duration.ofMillis(5), Duration.ofMillis(5), Duration.ofMillis(100)));
        await().atMost(Duration.ofSeconds(10)).until(() -> TABLE.equals(current()));
    }

    /** It never answers, and has an hour to: the desk beats on, and stopping doesn't wait for the fetch. */
    @Test
    void aFetchHangingForeverDoesntTouchHeartbeats() throws Exception {
        try (ControlPlaneRig rig = new ControlPlaneRig(
                dir, ControlPlaneRig.FAST_LINK, new HeartbeatLoop.Timing(Duration.ofMillis(50), Duration.ofMillis(20), Duration.ofSeconds(5)))) {
            rig.platform.nextHeartbeatSeconds = null;
            rig.platform.modelPricesReplies.add(Reply.STALLED);
            rig.bootToReady();
            rig.prices.start();
            rig.platform.awaitApi(FakePlatform.MODEL_PRICES);

            long beats = rig.platform.countApi("/v1/agent/heartbeat");
            await().atMost(Duration.ofSeconds(10)).until(() -> rig.platform.countApi("/v1/agent/heartbeat") >= beats + 5);
            assertThat(rig.link.isReady()).isTrue();
            assertThat(rig.platform.countApi(FakePlatform.MODEL_PRICES)).as("still the one fetch").isEqualTo(1);

            long before = System.nanoTime();
            rig.prices.close();
            assertThat(Duration.ofNanos(System.nanoTime() - before)).isLessThan(Duration.ofSeconds(2));
        }
    }
}
