package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.platform.TierLimits;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.tier.BrowserTime;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The simplified view's RPCs and topic, through a client's frames, with Chromium's side a fake whose page answers as
 * deskd's own half would. What the real half does is {@link MinifiedChromiumIT}'s: this is what deskd does with its
 * answers, and what it never sends.
 */
class MinifiedMethodsTest {

    private static final String TAB = "T1";
    private static final String SESSION = FakeCdp.sessionOf(TAB);

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private BrowserRig rig;
    private TestClient client;
    private final Page page = new Page();

    /** The page's half, as deskd's proxy.js would answer each op. */
    private static final class Page implements Function<FakeCdp.Command, Object> {
        final List<String> ops = new CopyOnWriteArrayList<>();
        final List<Map<String, Object>> args = new CopyOnWriteArrayList<>();
        volatile Map<String, Object> snapshot;
        volatile boolean snapshotGone;
        volatile long disarmMillis;
        /** Added to each world's id: a new one makes every kept context answer as another world (T47N-2). */
        volatile String widSalt = "";
        volatile java.util.concurrent.CountDownLatch snapshotGate;
        final List<String> finished = new CopyOnWriteArrayList<>();
        volatile Map<String, Object> prepare = Map.of("ok", true, "x", 20, "y", 30);
        volatile Map<String, Object> result = Map.of("seen", Map.of("pointerdown", 1, "pointerup", 1, "click", 1));
        volatile Map<String, Object> arm = Map.of("ok", true);
        volatile Map<String, Object> media = Map.of("ok", true, "paused", false, "at", 12.5, "dur", 600.0, "buf", 40.2, "vol", 0.8, "cc", 1);
        volatile Map<String, Object> island = Map.of("x", 10, "y", 20, "width", 640, "height", 360, "vw", 1280, "vh", 800,
                "dpr", 1, "visible", true, "covered", false, "fullscreen", false);
        volatile long count = 1;

        @SuppressWarnings("unchecked")
        @Override
        public Object apply(FakeCdp.Command command) {
            Map<String, Object> value = (Map<String, Object>) ((Map<String, Object>) ((List<Object>) command.params().get("arguments")).get(0)).get("value");
            String op = (String) value.get("op");
            ops.add(op);
            args.add(value);
            if ("disarm".equals(op) && disarmMillis > 0) {
                try {
                    Thread.sleep(disarmMillis);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            finished.add(op);
            if ("snapshot".equals(op) && snapshotGone) {
                // The document went while it was read, as mid-navigation.
                return Map.of("_error", -32000);
            }
            Map<String, Object> answer = switch (op) {
                case "snapshot" -> snapshot;
                case "changed" -> {
                    try {
                        Thread.sleep(50);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    yield Map.of("count", count, "timeout", count <= ((Number) value.get("since")).longValue());
                }
                case "prepare" -> prepare;
                case "result" -> result;
                case "arm" -> arm;
                case "island" -> island;
                case "media" -> media;
                default -> Map.of("ok", true);
            };
            Map<String, Object> tagged = new LinkedHashMap<>(answer);
            // deskd's half answers with its world's own id, as proxy.js does (T47N-2).
            tagged.put("wid", "w" + command.params().get("executionContextId") + widSalt);
            return Map.of("result", Map.of("type", "object", "value", tagged));
        }
    }

    /** A page in the distiller's line format, with what deskd's half saw of its refs. */
    private static Map<String, Object> snapshot(String meta, List<String> blocks, Map<String, Object> nodes, long count) {
        StringBuilder text = new StringBuilder(meta);
        for (String block : blocks) {
            text.append("\nh\t").append(block);
        }
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("chunks", List.of(text.toString()));
        value.put("nodes", nodes);
        value.put("media", List.of(Map.of("island", "vq.1", "fp", "isl", "m", "video", "w", 640, "h", 360, "x", 0, "y", 900, "paused", true)));
        value.put("signals", List.of());
        value.put("stats", Map.of("ready", "complete", "formControls", 2));
        value.put("extras", Map.of());
        value.put("count", count);
        return value;
    }

    private static final String PROSE = "x".repeat(200);

    private void standardPage() {
        page.snapshot = snapshot("{\"mode\":\"page\"}", List.of(
                "{\"k\":\"h\",\"l\":1,\"c\":[\"Hello\"]}",
                "{\"k\":\"p\",\"c\":[\"" + PROSE + "\",[\"btn\",\"e.1\",\"Archive\",0],[\"in\",\"e.2\",{\"t\":\"text\",\"v\":\"\",\"l\":\"Name\"}],"
                        + "[\"sel\",\"e.3\",{\"v\":\"b\",\"o\":[[\"a\",\"Small\"],[\"b\",\"Large\"]],\"l\":\"Size\"}]]}",
                "{\"k\":\"img\",\"s\":\"https://cdn.example.com/a.png\",\"a\":\"pic\",\"w\":300,\"h\":200}",
                "{\"k\":\"media\",\"m\":\"video\",\"w\":640,\"h\":360,\"n\":\"Trailer\"}"),
                Map.of("e.1", Map.of("fp", "fp1"), "e.2", Map.of("fp", "fp2"), "e.3", Map.of("fp", "fp3", "si", 1)), 1);
    }

    @BeforeEach
    void setUp() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage(TAB, "https://example.com/a", "A");
        cdp.answer("Runtime.callFunctionOn", page);
        standardPage();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        start(MinifiedSwitch.fixed(true, false, false));
    }

    /** The same rig, with a snapshot limit of 4 s rather than 400 ms. */
    private void withLongSnapshots() throws Exception {
        rig.close();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(4), Duration.ofSeconds(4), Duration.ofSeconds(2), Duration.ofMillis(10), Duration.ofMillis(50),
                Duration.ofSeconds(3)), MinifiedSwitch.fixed(true, false, false));
        client = rig.connect("cs-a");
    }

    private void start(MinifiedSwitch flags) throws Exception {
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(2), Duration.ofMillis(400), Duration.ofSeconds(2), Duration.ofMillis(10), Duration.ofMillis(50),
                Duration.ofSeconds(3)), flags);
        client = rig.connect("cs-a");
    }

    @AfterEach
    void tearDown() throws Exception {
        if (time != null) {
            time.close();
        }
        rig.close();
        cdp.close();
    }

    private Map<String, Object> get() throws Exception {
        return rig.call(client, "browser.minified.get", Map.of("tabId", TAB), null);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> run(String r, String words) throws Exception {
        Map<String, Object> mdoc = Json.object(get(), "mdoc");
        for (Map<String, Object> block : (List<Map<String, Object>>) mdoc.get("blocks")) {
            for (Object run : block.get("runs") instanceof List<?> runs ? runs : List.of()) {
                if (run instanceof Map<?, ?> m && r.equals(m.get("r")) && new String(Json.bytes(m), StandardCharsets.UTF_8).contains(words)) {
                    Map<String, Object> found = new LinkedHashMap<>((Map<String, Object>) m);
                    found.put("_block", block.get("key"));
                    found.put("_rev", mdoc.get("rev"));
                    return found;
                }
            }
        }
        throw new AssertionError("no " + r + " with " + words);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> block(String t) throws Exception {
        Map<String, Object> mdoc = Json.object(get(), "mdoc");
        return ((List<Map<String, Object>>) mdoc.get("blocks")).stream().filter(b -> t.equals(b.get("t"))).findFirst().orElseThrow();
    }

    private Map<String, Object> act(Map<String, Object> run, String action, Object value) throws Exception {
        return act(client, run, action, value, run.get("fp"), run.get("_block"));
    }

    private Map<String, Object> act(TestClient as, Map<String, Object> run, String action, Object value, Object fp, Object block) throws Exception {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("tabId", TAB);
        params.put("nodeId", run.get("node"));
        params.put("action", action);
        if (value != null) {
            params.put("value", value);
        }
        params.put("fp", fp);
        params.put("block", block);
        params.put("rev", run.getOrDefault("_rev", 1L));
        return rig.call(as, "browser.minified.act", params);
    }

    private List<String> mouse() {
        List<String> types = new ArrayList<>();
        cdp.commands("Input.dispatchMouseEvent").forEach(c -> types.add((String) c.params().get("type")));
        return types;
    }

    private static Map<String, Object> details(Map<String, Object> reply) {
        return Json.object(reply, "details");
    }

    // ---- the view

    @Test
    void aPageBecomesAnMDocThroughDeskdsOwnConstantsOnly() throws Exception {
        Map<String, Object> reply = get();
        assertThat(reply).containsEntry("_kind", "RES").containsEntry("view", "simplified").containsEntry("tabId", TAB);
        Map<String, Object> mdoc = Json.object(reply, "mdoc");
        assertThat(mdoc).containsEntry("v", 1).containsEntry("url", "https://example.com/a").containsEntry("origin", "https://example.com");
        assertThat(new String(Json.bytes(mdoc), StandardCharsets.UTF_8)).doesNotContain("cdn.example.com");

        FakeCdp.Command added = minifiedScripts().get(0);
        assertThat(added.sessionId()).isEqualTo(SESSION);
        assertThat(added.params()).containsEntry("worldName", "ma-minify");
        assertThat((String) added.params().get("source")).contains("__maProxy");
        assertThat(cdp.commands("Target.setAutoAttach").get(0).params())
                .containsEntry("waitForDebuggerOnStart", true).containsEntry("flatten", true);
        for (FakeCdp.Command call : cdp.commands("Runtime.callFunctionOn")) {
            assertThat(call.params().get("functionDeclaration")).isEqualTo("function(a){var p=globalThis.__maProxy;return p?p.run(a):{missing:true}}");
            assertThat(call.params()).containsKey("executionContextId");
        }
        assertThat(cdp.commands("Runtime.enable")).isEmpty();

        // The same rev again says so, and nothing more.
        long rev = ((Number) reply.get("rev")).longValue();
        assertThat(rig.call(client, "browser.minified.get", Map.of("tabId", TAB, "since", rev), null))
                .containsEntry("unchanged", true).doesNotContainKey("mdoc");
    }

    @Test
    void aViewWhosePageWentIsNeverSaidAsUnchanged() throws Exception {
        // Review 4: the page navigates and the next look fails, as mid-navigation; the old view must not stand.
        Map<String, Object> reply = get();
        long rev = ((Number) reply.get("rev")).longValue();
        assertThat(reply).containsEntry("view", "simplified").containsKey("mdoc");
        page.snapshotGone = true;
        cdp.event("Page.frameNavigated", Map.of("frame", Map.of("id", TAB, "loaderId", "L2", "url", "https://example.com/b")), SESSION);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(rig.call(client, "browser.minified.get",
                Map.of("tabId", TAB, "since", rev), null))
                .doesNotContainKey("unchanged").doesNotContainKey("mdoc").containsEntry("view", "pending"));
        Map<String, Object> pending = rig.call(client, "browser.minified.get", Map.of("tabId", TAB), null);
        assertThat(((Number) pending.get("rev")).longValue()).isGreaterThan(rev);

        // The next look that works is a view again, at a later rev still.
        page.snapshotGone = false;
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(get()).containsEntry("view", "simplified").containsKey("mdoc"));
        assertThat(((Number) get().get("rev")).longValue()).isGreaterThan(((Number) pending.get("rev")).longValue());
    }

    @Test
    void aTabClosedWithNoConnectionIsLetGoOnTheNext() throws Exception {
        // Review 5: only Target.targetDestroyed let a tab's state go, so tabs closed while disconnected stayed to the cap.
        cdp.addPage("T2", "https://example.com/b", "B");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(rig.call(client, "browser.minified.get",
                Map.of("tabId", "T2"), null)).containsEntry("view", "simplified"));
        get();
        assertThat(rig.module.minified().health()).containsEntry("tabs", 2);
        cdp.removeQuietly("T2");
        cdp.dropConnections();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(rig.module.minified().health()).containsEntry("tabs", 1));
        assertThat(get()).containsEntry("view", "simplified");
    }

    @Test
    void aLeaveNeverUndoesAnInjectionItDidntSee() throws Exception {
        // Review 6: a leave that cleared the tab's injection and then queued for its work let an act ahead of it inject
        // again, then took the script and the frames' attach off while the tab said injected, for good.
        Map<String, Object> archive = run("button", "Archive");
        assertThat(lastAutoAttach()).isTrue();
        TestClient other = rig.connect("cs-b");
        MinifiedModule module = rig.module.minified();
        java.lang.reflect.Method stateOf = MinifiedModule.class.getDeclaredMethod("state", String.class);
        stateOf.setAccessible(true);
        java.lang.reflect.Method leave = MinifiedModule.class.getDeclaredMethod("leave", stateOf.getReturnType(), boolean.class);
        leave.setAccessible(true);
        Object state = stateOf.invoke(module, TAB);

        cdp.hold("Runtime.callFunctionOn");
        int asked = cdp.commands("Runtime.callFunctionOn").size();
        CompletableFuture<Map<String, Object>> first = CompletableFuture.supplyAsync(() -> actQuietly(client, archive));
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Runtime.callFunctionOn").size() > asked);
        // The first act holds the tab's work; the second queues for it, then the leave does.
        CompletableFuture<Map<String, Object>> second = CompletableFuture.supplyAsync(() -> actQuietly(other, archive));
        Thread.sleep(300);
        leave.invoke(module, state, false);
        Thread.sleep(300);
        cdp.answerHeld("Runtime.callFunctionOn");
        first.get(10, TimeUnit.SECONDS);
        second.get(10, TimeUnit.SECONDS);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(lastAutoAttach()).as("the leave went through").isFalse());

        get();
        assertThat(lastAutoAttach()).as("the tab never says injected without being so: the next look puts deskd's half back").isTrue();
    }

    private Map<String, Object> actQuietly(TestClient as, Map<String, Object> run) {
        try {
            return act(as, run, "click", null, run.get("fp"), run.get("_block"));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private boolean lastAutoAttach() {
        List<FakeCdp.Command> calls = cdp.commands("Target.setAutoAttach");
        return !calls.isEmpty() && Boolean.TRUE.equals(calls.get(calls.size() - 1).params().get("autoAttach"));
    }

    @Test
    void theAdBlockingOffListIsTheDesksAloneAndGoesWithHistory() throws Exception {
        // T47S-3, deskd's half: 0640, emptied by clear-history, kept by registrable domain for the image's blocklist.
        Map<String, Object> off = rig.call(client, "browser.adblock.site.set", Map.of("host", "news.example.com", "on", false));
        assertThat(off).containsEntry("host", "example.com").containsEntry("on", false);
        Path file = dir.resolve("adblock-off");
        assertThat(Files.readString(file)).isEqualTo("example.com\n");
        assertThat(java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(file))).isEqualTo("rw-r-----");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(Json.object(Json.object(get(), "mdoc"), "hidden")).containsEntry("blocking", false));
        assertThat(rig.call(client, "browser.adblock.site.set", Map.of("host", "example.com", "on", "no"))).containsEntry("code", "bad_request");

        // Clear-history empties it, with the view switched on or off.
        assertThat(rig.call(client, "browser.minified.sites.clear", Map.of(), null)).containsEntry("_kind", "RES");
        assertThat(Files.readString(file)).isEmpty();
        assertThat(java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(file))).isEqualTo("rw-r-----");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            Map<String, Object> hidden = Json.object(Json.object(get(), "mdoc"), "hidden");
            assertThat(hidden == null ? Map.of() : hidden).doesNotContainKey("blocking");
        });
        rig.call(client, "browser.adblock.site.set", Map.of("host", "example.com", "on", false));
        restartWith(MinifiedSwitch.fixed(false, false, false));
        assertThat(rig.call(client, "browser.minified.sites.clear", Map.of(), null)).containsEntry("_kind", "RES");
        assertThat(Files.readString(file)).isEmpty();
    }

    private void oneFrame(String loader) {
        cdp.answer("Page.getFrameTree", command -> Map.of("frameTree", Map.of(
                "frame", Map.of("id", TAB, "loaderId", "L1", "url", "https://example.com/a"),
                "childFrames", List.of(Map.of("frame", Map.of("id", "F2", "parentId", TAB, "loaderId", loader, "url", "https://ads.example/"))))));
    }

    private long worldsFor(String frameId) {
        return cdp.commands("Page.createIsolatedWorld").stream().filter(c -> frameId.equals(c.params().get("frameId"))).count();
    }

    /** T47D-2: a frame near the point refuses, by Chromium's own boxes, whatever the page's DOM walk could see. */
    @Test
    void aFrameNearThePointRefusesByChromiumsOwnBoxes() throws Exception {
        oneFrame("L2");
        cdp.answer("DOM.getFrameOwner", command -> Map.of("backendNodeId", 41));
        // prepare's point is (20, 30); this box is 10 px from it, inside the 24.
        cdp.answer("DOM.getBoxModel", command -> Map.of("model", Map.of("border", List.of(30, 25, 130, 25, 130, 65, 30, 65))));
        Map<String, Object> refused = act(run("button", "Archive"), "click", null);
        assertThat(details(refused)).containsEntry("reason", "frame_near");
        assertThat(mouse()).isEmpty();
        assertThat(cdp.commands("DOM.getFrameOwner")).anySatisfy(c -> assertThat(c.params()).containsEntry("frameId", "F2"));
        assertThat(cdp.commands("DOM.getBoxModel")).anySatisfy(c -> assertThat(c.params()).containsEntry("backendNodeId", 41));

        // Far from the point, the click goes; and a frame with no box (not rendered) isn't near.
        cdp.answer("DOM.getBoxModel", command -> Map.of("model", Map.of("border", List.of(300, 300, 400, 300, 400, 350, 300, 350))));
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        cdp.answer("DOM.getBoxModel", command -> Map.of("_error", -32000));
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
    }

    /** B8, cut 2: another frame's world is made once per document, not once per action, and made again when it goes. */
    @Test
    void aFramesWorldIsMadeOncePerDocument() throws Exception {
        java.util.Set<Long> f2Worlds = java.util.concurrent.ConcurrentHashMap.newKeySet();
        java.util.concurrent.atomic.AtomicLong worlds = new java.util.concurrent.atomic.AtomicLong(9000);
        cdp.answer("Page.createIsolatedWorld", command -> {
            long world = worlds.incrementAndGet();
            if ("F2".equals(command.params().get("frameId"))) {
                f2Worlds.add(world);
            }
            return Map.of("executionContextId", world);
        });
        oneFrame("L2");
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        long made = worldsFor("F2");
        assertThat(made).isPositive();
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        assertThat(worldsFor("F2")).isEqualTo(made);

        // A new document in the frame is a new world.
        oneFrame("L3");
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        assertThat(worldsFor("F2")).isEqualTo(made + 1);

        // A world whose document went fails its call, and is made again, the op run once.
        java.util.Set<Long> gone = java.util.Set.copyOf(f2Worlds);
        cdp.answer("Runtime.callFunctionOn", command -> command.params().get("executionContextId") instanceof Number id
                && gone.contains(id.longValue()) ? Map.of("_error", -32000) : page.apply(command));
        page.ops.clear();
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        assertThat(worldsFor("F2")).isEqualTo(made + 2);
        assertThat(page.ops.stream().filter("arm"::equals).count()).isEqualTo(1);

        // T47N-2: a kept context id that another world answers on is forgotten, and the frame's own world made again.
        page.widSalt = "-another-process";
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        assertThat(worldsFor("F2")).isEqualTo(made + 3);
        page.ops.clear();
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        assertThat(worldsFor("F2")).as("the new world is kept").isEqualTo(made + 3);
    }

    /** B8, cut 1: the reply doesn't wait for the frames' disarm, which still comes, and before the next action arms. */
    @Test
    void theReplyComesBeforeTheFramesDisarm() throws Exception {
        oneFrame("L2");
        Map<String, Object> archive = run("button", "Archive");
        page.disarmMillis = 800;
        long started = System.nanoTime();
        assertThat(act(archive, "click", null)).containsEntry("done", true);
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofMillis(700));
        await().atMost(Duration.ofSeconds(5)).until(() -> page.finished.contains("disarm"));
        page.disarmMillis = 0;
        page.finished.clear();
        page.disarmMillis = 300;
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        page.disarmMillis = 0;
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        await().atMost(Duration.ofSeconds(5)).until(() -> page.finished.stream().filter("disarm"::equals).count() == 2);
        // The second action's arm came only after the first's disarm.
        List<String> order = page.finished.stream().filter(op -> op.equals("arm") || op.equals("disarm")).toList();
        assertThat(order).startsWith("arm", "disarm", "arm", "disarm");
    }

    /** B8, cut 3: an action goes ahead of a look at the page that hasn't started; it waits for one that has. */
    @Test
    void anActionGoesAheadOfALookThatHasntStarted() throws Exception {
        // A snapshot's own limit long enough for the held look to stay a look, not a timeout.
        withLongSnapshots();
        Map<String, Object> archive = run("button", "Archive");
        TestClient other = rig.connect("cs-b");
        TestClient third = rig.connect("cs-c");
        cdp.hold("Runtime.callFunctionOn");
        int asked = cdp.commands("Runtime.callFunctionOn").size();
        CompletableFuture<Map<String, Object>> running = CompletableFuture.supplyAsync(() -> quietGet(client));
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Runtime.callFunctionOn").size() > asked);
        // A second look queues for the tab's work, then an action does.
        CompletableFuture<Map<String, Object>> next = CompletableFuture.supplyAsync(() -> quietGet(other));
        Thread.sleep(300);
        CompletableFuture<Map<String, Object>> action = CompletableFuture.supplyAsync(() -> actQuietly(third, archive));
        Thread.sleep(300);
        page.finished.clear();
        cdp.release("Runtime.callFunctionOn");
        cdp.answerHeld("Runtime.callFunctionOn");
        Map<String, Object> first = running.get(10, TimeUnit.SECONDS);
        Map<String, Object> acted = action.get(10, TimeUnit.SECONDS);
        Map<String, Object> second = next.get(10, TimeUnit.SECONDS);
        List<String> order = page.finished.stream().filter(op -> op.equals("snapshot") || op.equals("prepare")).toList();
        // The running look's snapshot, then the action, then the look that hadn't started.
        assertThat(order).as("%s / %s / %s / %s", page.finished, first, acted, second).startsWith("snapshot", "prepare", "snapshot");
    }

    private Map<String, Object> quietGet(TestClient as) {
        try {
            return rig.call(as, "browser.minified.get", Map.of("tabId", TAB), null);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void theStreamIsSaidWithAReason() throws Exception {
        page.snapshot = Map.of("error", "distiller");
        assertThat(details2(get())).containsEntry("reason", "distiller_error");

        cdp.navigateInPage(TAB, "https://example.org/b", "B");
        page.snapshot = Map.of("tooLarge", true);
        await().untilAsserted(() -> assertThat(details2(get())).containsEntry("reason", "too_large"));

        cdp.navigateInPage(TAB, "https://example.org/c", "C");
        cdp.hold("Runtime.callFunctionOn");
        await().untilAsserted(() -> assertThat(details2(get())).containsEntry("reason", "timeout"));
        cdp.release("Runtime.callFunctionOn");

        cdp.navigateInPage(TAB, "https://mail.google.com/mail/u/0", "Inbox");
        await().untilAsserted(() -> assertThat(details2(get())).containsEntry("reason", "sensitive_site"));

        cdp.navigateInPage(TAB, "about:blank", "");
        await().untilAsserted(() -> assertThat(details2(get())).containsEntry("reason", "not_page"));
    }

    private static Map<String, Object> details2(Map<String, Object> reply) {
        assertThat(reply).containsEntry("view", "stream");
        return Json.object(reply, "fallback");
    }

    @Test
    void theMembersChoicesAreKeptOnTheDesk() throws Exception {
        assertThat(rig.call(client, "browser.minified.site.set", Map.of("tabId", TAB, "view", "stream"), null))
                .containsEntry("host", "example.com").containsEntry("view", "stream").containsEntry("sensitive", false);
        assertThat(details2(get())).containsEntry("reason", "member_choice");
        assertThat(rig.call(client, "browser.minified.site.set", Map.of("host", "example.com", "sensitive", true), null))
                .containsEntry("view", "stream").containsEntry("sensitive", true);
        assertThat(details2(get())).containsEntry("reason", "sensitive_site");
        assertThat((List<?>) rig.call(client, "browser.minified.sites.list", Map.of(), null).get("sites")).hasSize(1);
        assertThat(rig.call(client, "browser.minified.site.set", Map.of("host", "Not A Host"), null)).containsEntry("code", "bad_request");
        assertThat(rig.call(client, "browser.minified.sites.clear", Map.of(), null)).containsEntry("_kind", "RES");
        assertThat(get()).containsEntry("view", "simplified");
        assertThat((List<?>) rig.call(client, "browser.minified.sites.list", Map.of(), null).get("sites")).isEmpty();
        await().until(() -> Files.exists(dir.resolve("minified-sites.json")) && !Files.readString(dir.resolve("minified-sites.json")).contains("example.com"));
    }

    // ---- the action proxy

    @Test
    void aClickIsPressAndReleaseWithNoMoveAndCountsOnlyIfTheTargetGotIt() throws Exception {
        Map<String, Object> archive = run("button", "Archive");
        assertThat(act(archive, "click", null)).containsEntry("_kind", "RES").containsEntry("done", true);
        assertThat(mouse()).containsExactly("mousePressed", "mouseReleased");
        assertThat(page.ops).containsSubsequence("prepare", "result");
        Map<String, Object> prepared = page.args.get(page.ops.indexOf("prepare"));
        assertThat(prepared).containsEntry("node", "e.1").containsEntry("fp", "fp1").containsEntry("action", "click").doesNotContainKey("margin");

        page.result = Map.of("seen", Map.of("pointerdown", 1, "pointerup", 1));
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", false).containsEntry("reason", "missed");
        page.result = Map.of("seen", Map.of("pointerdown", 1, "pointerup", 1, "click", 1), "tripped", "pointerdown");
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", false).containsEntry("reason", "missed");
    }

    @Test
    void whatTheMemberSawHasToMatchOrNothingIsSent() throws Exception {
        Map<String, Object> archive = run("button", "Archive");
        page.ops.clear();
        Map<String, Object> wrongFp = act(client, archive, "click", null, "other", archive.get("_block"));
        assertThat(wrongFp).containsEntry("code", "conflict");
        assertThat(details(wrongFp)).containsEntry("reason", "changed");
        assertThat(details(act(client, archive, "click", null, archive.get("fp"), "otherblock"))).containsEntry("reason", "changed");
        assertThat(details(act(client, Map.of("node", "e.404"), "click", null, "fp", archive.get("_block")))).containsEntry("reason", "changed");
        assertThat(page.ops).doesNotContain("prepare");

        // The page's own look, in the same call as the hit-test: a reused node refuses.
        page.prepare = Map.of("refused", "changed");
        assertThat(details(act(archive, "click", null))).containsEntry("reason", "changed");
        page.prepare = Map.of("refused", "frame_near");
        assertThat(details(act(archive, "click", null))).containsEntry("reason", "frame_near");
        page.prepare = Map.of("refused", "covered");
        assertThat(details(act(archive, "click", null))).containsEntry("reason", "covered");
        assertThat(mouse()).isEmpty();
        // A kind of action the node isn't for refuses before the page is asked.
        assertThat(details(act(archive, "fill", "x"))).containsEntry("reason", "kind");
    }

    @Test
    void aFieldFoundSensitiveIsRefusedAndStaysRefused() throws Exception {
        Map<String, Object> name = run("field", "Name");
        page.prepare = Map.of("refused", "sensitive", "kind", "password");
        Map<String, Object> refused = act(name, "fill", "hunter2");
        assertThat(refused).containsEntry("code", "forbidden");
        assertThat(details(refused)).containsEntry("reason", "sensitive").containsEntry("kind", "password");
        page.prepare = Map.of("ok", true);
        page.ops.clear();
        assertThat(details(act(name, "fill", "hunter2"))).containsEntry("reason", "sensitive");
        assertThat(page.ops).doesNotContain("prepare");
        assertThat(cdp.commands("Input.insertText")).isEmpty();
    }

    @Test
    void everyOtherFrameIsArmedFirstAndAFrameThatWontSayRefuses() throws Exception {
        cdp.answer("Page.getFrameTree", command -> Map.of("frameTree", Map.of(
                "frame", Map.of("id", TAB, "loaderId", "L1", "url", "https://example.com/a"),
                "childFrames", List.of(Map.of("frame", Map.of("id", "F2", "parentId", TAB, "loaderId", "L2", "url", "https://ads.example/"))))));
        Map<String, Object> archive = run("button", "Archive");
        page.ops.clear();
        assertThat(act(archive, "click", null)).containsEntry("done", true);
        // The disarm comes after the reply (B8), so it's waited for.
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(page.ops).containsSubsequence("arm", "prepare", "result", "disarm"));
        assertThat(cdp.commands("Page.createIsolatedWorld")).anySatisfy(c -> assertThat(c.params()).containsEntry("frameId", "F2"));

        page.arm = Map.of("error", "threw");
        Map<String, Object> refused = act(run("button", "Archive"), "click", null);
        assertThat(refused).containsEntry("code", "conflict");
        assertThat(details(refused)).containsEntry("reason", "frames");
        assertThat(mouse()).containsExactly("mousePressed", "mouseReleased");
    }

    private static Map<String, Object> typed(int valueLen, String valueHash, int dataLen, String dataHash, boolean focused) {
        return Map.of("seen", Map.of("beforeinput", 1), "valueLen", valueLen, "valueHash", valueHash,
                "dataLen", dataLen, "dataHash", dataHash, "focused", focused);
    }

    @Test
    void typingIsCheckedInTheFieldItself() throws Exception {
        Map<String, Object> name = run("field", "Name");
        // deskd's half sends a length and a hash (the proxy's cyrb53, hashes taken from it in Node), never the text (review 3).
        page.result = typed(3, "10lixtxfbxd", 3, "10lixtxfbxd", true);
        assertThat(act(name, "fill", "Ann")).containsEntry("done", true);
        assertThat(cdp.commands("Input.insertText").get(0).params()).containsEntry("text", "Ann");

        page.result = typed(9, "3b2c1a", 6, "d58idk9g9k", true);
        assertThat(act(run("field", "Name"), "fill", "555123")).containsEntry("done", true).containsEntry("reformatted", true);

        page.result = typed(0, "wvjl67o803", 0, "wvjl67o803", false);
        assertThat(act(run("field", "Name"), "fill", "lost")).containsEntry("done", false).containsEntry("reason", "value");

        // The same length is not the same text.
        page.result = typed(3, "10lixtxfbxe", 3, "10lixtxfbxe", true);
        assertThat(act(run("field", "Name"), "fill", "Ann")).containsEntry("done", false).containsEntry("reason", "value");

        // Past the 4096 characters deskd's reader keeps of a string, up to section 14's 65,536.
        page.result = typed(65536, "1nqutjrw0v7", 65536, "1nqutjrw0v7", true);
        assertThat(act(run("field", "Name"), "fill", "x".repeat(65536))).containsEntry("done", true);

        page.result = Map.of("seen", Map.of(), "tripped", "blur");
        assertThat(act(run("field", "Name"), "fill", "x")).containsEntry("done", false).containsEntry("reason", "missed");
    }

    @Test
    void aSelectGoesByIndexAndOnlyIfTheLabelStillReads() throws Exception {
        Map<String, Object> size = run("select", "Size");
        assertThat(size).containsEntry("selected", 1).containsEntry("options", List.of("Small", "Large"));
        Map<String, Object> wrong = act(size, "select", Map.of("index", 0, "label", "Large"));
        assertThat(details(wrong)).containsEntry("reason", "label");
        page.ops.clear();
        cdp.answer("Runtime.callFunctionOn", command -> {
            Object answer = page.apply(command);
            String op = page.ops.get(page.ops.size() - 1);
            return "select".equals(op) && Boolean.TRUE.equals(page.args.get(page.args.size() - 1).get("check"))
                    ? Map.of("result", Map.of("type", "object", "value", Map.of("label", "Small")))
                    : answer;
        });
        assertThat(act(size, "select", Map.of("index", 0, "label", "Small"))).containsEntry("done", true);
        assertThat(page.args.get(page.args.size() - 1)).containsEntry("index", 0).containsEntry("label", "Small").containsEntry("check", false);
    }

    @Test
    void aDialogStopsTheWaitAndIsNeverAnswered() throws Exception {
        Map<String, Object> archive = run("button", "Archive");
        cdp.hold("Input.dispatchMouseEvent");
        Thread.ofVirtual().start(() -> {
            try {
                Thread.sleep(150);
            } catch (InterruptedException e) {
                return;
            }
            cdp.event("Page.javascriptDialogOpening", Map.of("url", "https://example.com/a", "message", "Sure?", "type", "confirm"), SESSION);
        });
        assertThat(act(archive, "click", null)).containsEntry("done", false).containsEntry("reason", "dialog");
        assertThat(details2(get())).containsEntry("reason", "dialog");
        assertThat(cdp.commands("Page.handleJavaScriptDialog")).isEmpty();
        cdp.event("Page.javascriptDialogClosed", Map.of("result", false), SESSION);
        cdp.release("Input.dispatchMouseEvent");
        await().untilAsserted(() -> assertThat(get()).containsEntry("view", "simplified"));
    }

    @Test
    void actionsAreRateLimited() throws Exception {
        Map<String, Object> archive = run("button", "Archive");
        int limited = 0;
        for (int i = 0; i < 45; i++) {
            Map<String, Object> reply = act(client, archive, "click", null, "wrong", archive.get("_block"));
            if ("rate_limited".equals(reply.get("code"))) {
                limited++;
                assertThat(details(reply)).containsEntry("limit", "minified");
            }
        }
        assertThat(limited).isPositive();
    }

    // ---- who may

    @Test
    void onlyTheOwnersSessionsAndOnlyWithWhatTheirTokenAllows() throws Exception {
        TestClient export = rig.open("cs-x", "export", false, false);
        export.hello();
        Map<String, Object> scope = rig.call(export, "browser.minified.get", Map.of("tabId", TAB), null);
        assertThat(scope).containsEntry("code", "forbidden");
        assertThat(details(scope)).containsEntry("reason", "scope");
        assertThat(export.subscribe("browser.minified:" + TAB, null)).containsEntry("code", "forbidden");

        TestClient watcher = rig.connect("cs-w", true, false);
        assertThat(rig.call(watcher, "browser.minified.get", Map.of("tabId", TAB), null)).containsEntry("_kind", "RES");
        Map<String, Object> archive = run("button", "Archive");
        Map<String, Object> noInput = act(watcher, archive, "click", null, archive.get("fp"), archive.get("_block"));
        assertThat(details(noInput)).containsEntry("reason", "permission");
        assertThat(rig.call(watcher, "browser.minified.site.set", Map.of("tabId", TAB, "view", "stream"), null)).containsEntry("code", "forbidden");

        TestClient blind = rig.connect("cs-b", false, false);
        assertThat(rig.call(blind, "browser.minified.get", Map.of("tabId", TAB), null)).containsEntry("code", "forbidden");
        assertThat(blind.subscribe("browser.minified:" + TAB, null)).containsEntry("code", "forbidden");
        assertThat(mouse()).isEmpty();
    }

    // ---- images, islands, the topic, and what waits on Security

    @Test
    void anImageIsChromiumsCopyAndOnlyARasterOne() throws Exception {
        String imageId = (String) block("image").get("image");
        byte[] png = new byte[6000];
        System.arraycopy(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}, 0, png, 0, 8);
        cdp.answer("Page.getResourceContent", command -> {
            assertThat(command.params()).containsEntry("url", "https://cdn.example.com/a.png").containsEntry("frameId", TAB);
            return Map.of("content", Base64.getEncoder().encodeToString(png), "base64Encoded", true);
        });
        Map<String, Object> image = rig.call(client, "browser.minified.image", Map.of("tabId", TAB, "imageId", imageId), null);
        assertThat(image).containsEntry("mime", "image/png");
        // Past the 4096 characters every other string from Chromium is cut to.
        assertThat(Base64.getDecoder().decode((String) image.get("data"))).isEqualTo(png);

        // Review 9: a reply whose first piece is too short to show its id was read with the short limit, so the image
        // came back cut. It fails instead.
        cdp.splitNextReply("Page.getResourceContent", 3);
        assertThat(details(rig.call(client, "browser.minified.image", Map.of("tabId", TAB, "imageId", imageId), null)))
                .containsEntry("reason", "image");
        image = rig.call(client, "browser.minified.image", Map.of("tabId", TAB, "imageId", imageId), null);
        assertThat(Base64.getDecoder().decode((String) image.get("data"))).isEqualTo(png);

        byte[] svg = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>".getBytes(StandardCharsets.UTF_8);
        cdp.answer("Page.getResourceContent", command -> Map.of("content", Base64.getEncoder().encodeToString(svg), "base64Encoded", true));
        assertThat(details(rig.call(client, "browser.minified.image", Map.of("tabId", TAB, "imageId", imageId), null)))
                .containsEntry("reason", "image_type");
        cdp.answer("Page.getResourceContent", command -> Map.of("_error", -32000));
        assertThat(details(rig.call(client, "browser.minified.image", Map.of("tabId", TAB, "imageId", imageId), null)))
                .containsEntry("reason", "image");
        assertThat(details(rig.call(client, "browser.minified.image", Map.of("tabId", TAB, "imageId", "i9.9"), null)))
                .containsEntry("reason", "image");
    }

    @Test
    void anIslandsBoxComesWithAnEpochThatMovesWithIt() throws Exception {
        Map<String, Object> island = block("island");
        assertThat(island).containsEntry("island", "vq.1").containsEntry("state", "live");
        Map<String, Object> first = rig.call(client, "browser.minified.island", Map.of("tabId", TAB, "islandId", "vq.1"), null);
        assertThat(first).containsEntry("live", true).containsEntry("kind", "video");
        assertThat(Json.object(first, "rect")).containsEntry("width", 640).containsEntry("x", 10);
        long epoch = ((Number) first.get("epoch")).longValue();
        assertThat(((Number) rig.call(client, "browser.minified.island", Map.of("tabId", TAB, "islandId", "vq.1"), null).get("epoch")).longValue())
                .isEqualTo(epoch);
        page.island = Map.of("x", 10, "y", 120, "width", 640, "height", 360, "vw", 1280, "vh", 800, "dpr", 1,
                "visible", true, "covered", true, "fullscreen", false);
        Map<String, Object> moved = rig.call(client, "browser.minified.island", Map.of("tabId", TAB, "islandId", "vq.1"), null);
        assertThat(((Number) moved.get("epoch")).longValue()).isGreaterThan(epoch);
        assertThat(moved).containsEntry("live", false).containsEntry("reason", "covered");
        assertThat(details(rig.call(client, "browser.minified.island", Map.of("tabId", TAB, "islandId", "vq.9"), null)))
                .containsEntry("reason", "island");

        Map<String, Object> verb = rig.call(client, "browser.minified.act", Map.of("tabId", TAB, "nodeId", "vq.1", "action", "media",
                "value", Map.of("verb", "play"), "fp", "isl", "block", island.get("key"), "rev", 1));
        assertThat(details(verb)).containsEntry("reason", "disabled");
    }

    @Test
    void mediaVerbsBehindTheirFlagStillGoByWhatTheMemberSaw() throws Exception {
        rig.close();
        cdp.close();
        cdp = new FakeCdp();
        cdp.addPage(TAB, "https://example.com/a", "A");
        cdp.answer("Runtime.callFunctionOn", page);
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        start(MinifiedSwitch.fixed(true, true, false));
        Map<String, Object> island = block("island");
        Map<String, Object> wrong = rig.call(client, "browser.minified.act", Map.of("tabId", TAB, "nodeId", "vq.1", "action", "media",
                "value", Map.of("verb", "play"), "fp", "other", "block", island.get("key"), "rev", 1));
        assertThat(details(wrong)).containsEntry("reason", "changed");
        Map<String, Object> play = rig.call(client, "browser.minified.act", Map.of("tabId", TAB, "nodeId", "vq.1", "action", "media",
                "value", Map.of("verb", "seek", "time", 12.5), "fp", "isl", "block", island.get("key"), "rev", 1));
        assertThat(play).containsEntry("done", true);
        // The element's state after the verb, as UI/UX's island controls asked for it.
        assertThat(play).containsEntry("paused", false).containsEntry("time", 12.5).containsEntry("duration", 600.0)
                .containsEntry("buffered", 40.2).containsEntry("volume", 0.8).containsEntry("muted", false).containsEntry("captions", true);
        assertThat(page.args.get(page.args.size() - 1)).containsEntry("op", "media").containsEntry("verb", "seek").containsEntry("time", 12.5);
        assertThat(mouse()).isEmpty();
    }

    @Test
    void subscribersGetTheViewsStateAndThenPatches() throws Exception {
        get();
        Map<String, Object> sub = client.subscribe("browser.minified:" + TAB, null);
        assertThat(sub).containsEntry("_kind", "RES");
        Map<String, Object> first = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(first).containsEntry("type", "snapshot");
        assertThat(Json.object(first, "data")).containsEntry("view", "simplified").containsEntry("tabId", TAB);

        Map<String, Object> changed = new LinkedHashMap<>(page.snapshot);
        String text = (String) ((List<?>) changed.get("chunks")).get(0);
        changed.put("chunks", List.of(text + "\nh\t{\"k\":\"p\",\"c\":[\"A new paragraph\"]}"));
        changed.put("count", 2L);
        page.snapshot = changed;
        page.count = 2;
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
            assertThat(event).containsEntry("type", "patch");
            assertThat(new String(Json.bytes(event), StandardCharsets.UTF_8)).contains("A new paragraph");
        });
        assertThat(rig.module.minified().health()).containsEntry("watched", 1);

        assertThat(client.subscribe("browser.minified:bad id!", null)).containsEntry("code", "bad_request");
    }

    @Test
    void aClosedTabsWatchersHearSo() throws Exception {
        get();
        client.subscribe("browser.minified:" + TAB, null);
        client.nextJson(Channels.EVENTS, FrameKind.EVT);
        cdp.destroy(TAB);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
            assertThat(Json.object(event, "data")).containsEntry("view", "closed");
        });
        await().untilAsserted(() -> assertThat(rig.module.minified().health()).containsEntry("kept", 0));
    }

    // ---- the review's findings, each a test that fails without its fix

    /** Review 5: off on every desk until its switch says on, and then nothing reaches a page. */
    @Test
    void theViewIsOffUntilTheSwitchSaysOn() throws Exception {
        rig.close();
        cdp.close();
        cdp = new FakeCdp();
        cdp.addPage(TAB, "https://example.com/a", "A");
        cdp.answer("Runtime.callFunctionOn", page);
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        start(MinifiedSwitch.fixed(false, true, true));
        Map<String, Object> off = get();
        assertThat(off).containsEntry("code", "unavailable");
        assertThat(details(off)).containsEntry("reason", "disabled");
        assertThat(details(rig.call(client, "browser.minified.sites.list", Map.of(), null))).containsEntry("reason", "disabled");
        assertThat(client.subscribe("browser.minified:" + TAB, null)).containsEntry("code", "unavailable");
        assertThat(minifiedScripts()).isEmpty();
        assertThat(cdp.commands("Runtime.callFunctionOn")).isEmpty();
    }

    /** The owner's rule: the switch only turns things off, and with no file everything is on. */
    @Test
    void theSwitchIsAKillSwitchOnTheDataVolumeReadAtRunTime() throws Exception {
        Path file = dir.resolve("switch-test").resolve(MinifiedSwitch.FILE);
        Files.createDirectories(file.getParent());
        MinifiedSwitch flags = MinifiedSwitch.file(file.getParent());
        assertThat(flags.on()).isTrue();
        assertThat(flags.mediaActions()).isTrue();
        assertThat(flags.consentReject()).isTrue();
        Files.writeString(file, "media-actions-off\n");
        await().atMost(Duration.ofSeconds(5)).until(() -> !flags.mediaActions());
        assertThat(flags.on()).isTrue();
        assertThat(flags.consentReject()).isTrue();
        Files.writeString(file, "consent-reject-off on media-actions\n");
        await().atMost(Duration.ofSeconds(5)).until(() -> !flags.consentReject() && flags.mediaActions());
        Files.writeString(file, "off\n");
        await().atMost(Duration.ofSeconds(5)).until(() -> !flags.on() && !flags.mediaActions() && !flags.consentReject());
        Files.delete(file);
        await().atMost(Duration.ofSeconds(5)).until(flags::on);
        // A file deskd can't read as a plain small one meant to stop something: off.
        Files.writeString(dir.resolve("anywhere"), "");
        Files.createSymbolicLink(file, dir.resolve("anywhere"));
        await().atMost(Duration.ofSeconds(5)).until(() -> !flags.on());
        Files.delete(file);
        Files.writeString(file, "x".repeat(2000));
        await().atMost(Duration.ofSeconds(5)).until(() -> !flags.on());
    }

    /** Review 1: no press once the arm is older than a third of the guard's life, so no frame's guard can lapse under it. */
    @Test
    void aPressIsNeverSentOnceTheArmIsOld() throws Exception {
        Map<String, Object> archive = run("button", "Archive");
        // A page that holds up the hit-test, as a top page running long tasks does. The fake's own reader never waits.
        cdp.hold("Runtime.callFunctionOn");
        Thread.ofVirtual().start(() -> {
            try {
                Thread.sleep(1300);
            } catch (InterruptedException e) {
                return;
            }
            cdp.answerHeld("Runtime.callFunctionOn");
        });
        Map<String, Object> refused = act(archive, "click", null);
        assertThat(details(refused)).containsEntry("reason", "frames");
        assertThat(mouse()).isEmpty();
        // Every frame is armed for the guard's whole life, not a moment.
        cdp.answer("Page.getFrameTree", command -> Map.of("frameTree", Map.of(
                "frame", Map.of("id", TAB, "loaderId", "L1", "url", "https://example.com/a"),
                "childFrames", List.of(Map.of("frame", Map.of("id", "F2", "parentId", TAB, "loaderId", "L2", "url", "https://ads.example/"))))));
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
        assertThat(page.args.stream().filter(a -> "arm".equals(a.get("op"))).findFirst().orElseThrow()).containsEntry("ms", 3000);
    }

    /**
     * Review 6: Blink's frame tree skips a frame in another process, so deskd sees one only through its own session. One
     * that Chromium lists under the tab's frames but that deskd holds no session for (attach off, a session lost) refuses.
     */
    @Test
    void aFrameInAnotherProcessWithNoSessionRefuses() throws Exception {
        Map<String, Object> archive = run("button", "Archive");
        cdp.answer("Target.getTargets", command -> Map.of("targetInfos", List.of(
                Map.of("targetId", "F7", "type", "iframe", "url", "https://pay.example/", "title", "", "attached", false,
                        "parentFrameId", TAB, "canAccessOpener", false, "browserContextId", "B"),
                Map.of("targetId", "F8", "type", "iframe", "url", "https://other.example/", "title", "", "attached", false,
                        "parentFrameId", "ELSEWHERE", "canAccessOpener", false, "browserContextId", "B"))));
        assertThat(details(act(archive, "click", null))).containsEntry("reason", "frames");
        assertThat(mouse()).isEmpty();
        // Another tab's frame isn't this one's.
        cdp.answer("Target.getTargets", command -> Map.of("targetInfos", List.of(
                Map.of("targetId", "F8", "type", "iframe", "url", "https://other.example/", "title", "", "attached", false,
                        "parentFrameId", "ELSEWHERE", "canAccessOpener", false, "browserContextId", "B"))));
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
    }

    /** T47N-1: a frame's session gets Page enabled before deskd's script, so the script runs at its next document's start. */
    @Test
    void aFramesSessionHasPageEnabledBeforeTheGuard() throws Exception {
        get();
        cdp.event("Target.attachedToTarget", Map.of("sessionId", "F7", "waitingForDebugger", true,
                "targetInfo", Map.of("targetId", "F7", "type", "iframe", "url", "https://other.example/frame")), SESSION);
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Runtime.runIfWaitingForDebugger").stream().anyMatch(c -> "F7".equals(c.sessionId())));
        List<String> onFrame = cdp.commands().stream().filter(c -> "F7".equals(c.sessionId())).map(FakeCdp.Command::method).toList();
        assertThat(onFrame).containsSubsequence("Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Runtime.runIfWaitingForDebugger");
    }

    /** T47N-1: a frames re-read before the press that a page keeps busy past a second refuses, whatever it finds. */
    @Test
    void aSlowReReadOfTheFramesRefuses() throws Exception {
        rig.close();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(4), Duration.ofSeconds(2), Duration.ofSeconds(2), Duration.ofMillis(10), Duration.ofMillis(50),
                Duration.ofSeconds(30)), MinifiedSwitch.fixed(true, false, false));
        client = rig.connect("cs-a");
        cdp.answer("Page.getFrameTree", command -> Map.of("frameTree", Map.of(
                "frame", Map.of("id", TAB, "loaderId", "L1", "url", "https://example.com/a"),
                "childFrames", List.of(Map.of("frame", Map.of("id", "F2", "parentId", TAB, "loaderId", "L2", "url", "https://ads.example/"))))));
        Map<String, Object> archive = run("button", "Archive");
        // The arm's read answers at once; the re-read before the press, 1.3 s later, as a page keeping a frame busy would.
        int before = cdp.commands("Page.getFrameTree").size();
        cdp.hold("Page.getFrameTree");
        Thread slow = Thread.ofVirtual().start(() -> {
            try {
                await().atMost(Duration.ofSeconds(10)).until(() -> cdp.commands("Page.getFrameTree").size() >= before + 1);
                cdp.answerNewestHeld("Page.getFrameTree");
                await().atMost(Duration.ofSeconds(10)).until(() -> cdp.commands("Page.getFrameTree").size() >= before + 2);
                Thread.sleep(1300);
                cdp.answerHeld("Page.getFrameTree");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        assertThat(details(act(archive, "click", null))).containsEntry("reason", "frames");
        slow.join(10_000);
        assertThat(mouse()).isEmpty();
        assertThat(act(run("button", "Archive"), "click", null)).containsEntry("done", true);
    }

    /** Review 2: a frame that came, went or navigated between the arm and the press refuses it. */
    @Test
    void framesThatChangeBetweenArmAndPressRefuse() throws Exception {
        java.util.concurrent.atomic.AtomicInteger reads = new java.util.concurrent.atomic.AtomicInteger();
        cdp.answer("Page.getFrameTree", command -> Map.of("frameTree", Map.of(
                "frame", Map.of("id", TAB, "loaderId", "L1", "url", "https://example.com/a"),
                "childFrames", List.of(Map.of("frame", Map.of("id", "F2", "parentId", TAB,
                        "loaderId", reads.incrementAndGet() <= 1 ? "L2" : "L3", "url", "https://ads.example/"))))));
        Map<String, Object> archive = run("button", "Archive");
        reads.set(0);
        assertThat(details(act(archive, "click", null))).containsEntry("reason", "frames");
        assertThat(mouse()).isEmpty();
    }

    /** Review 2: a frame that can't be armed, gone or scriptless, isn't skipped as gone: it refuses. */
    @Test
    void aFrameThatCantBeArmedRefuses() throws Exception {
        cdp.answer("Page.getFrameTree", command -> Map.of("frameTree", Map.of(
                "frame", Map.of("id", TAB, "loaderId", "L1", "url", "https://example.com/a"),
                "childFrames", List.of(Map.of("frame", Map.of("id", "F2", "parentId", TAB, "loaderId", "L2", "url", "https://ads.example/"))))));
        java.util.concurrent.atomic.AtomicLong worlds = new java.util.concurrent.atomic.AtomicLong(5000);
        cdp.answer("Page.createIsolatedWorld", command -> "F2".equals(command.params().get("frameId"))
                ? Map.of("_error", -32000)
                : Map.of("executionContextId", worlds.incrementAndGet()));
        Map<String, Object> archive = run("button", "Archive");
        assertThat(details(act(archive, "click", null))).containsEntry("reason", "frames");
        assertThat(mouse()).isEmpty();
    }

    /** Review 2: past what deskd keeps track of, a tab's frames can't all be armed, so its actions refuse. */
    @Test
    void framesDeskdCouldntRecordRefuseTheTabsActions() throws Exception {
        Map<String, Object> archive = run("button", "Archive");
        for (int i = 0; i < 70; i++) {
            cdp.event("Target.attachedToTarget", Map.of("sessionId", "C" + i, "waitingForDebugger", false,
                    "targetInfo", Map.of("targetId", "FT" + i, "type", "iframe", "url", "https://ads.example/" + i)), SESSION);
        }
        await().untilAsserted(() -> assertThat(details(act(archive, "click", null))).containsEntry("reason", "frames"));
        assertThat(mouse()).isEmpty();
    }

    /** Review 5: an act names the rev it was made in, and one from before the tab's current document refuses. */
    @Test
    void anActFromAnotherDocumentRefuses() throws Exception {
        Map<String, Object> archive = run("button", "Archive");
        cdp.navigateInPage(TAB, "https://example.com/next", "Next");
        // A look that races the commit can be of the page going: the next one is of the new.
        await().untilAsserted(() -> assertThat(Json.object(get(), "mdoc")).containsEntry("url", "https://example.com/next"));
        Map<String, Object> fresh = run("button", "Archive");
        assertThat(((Number) fresh.get("_rev")).longValue()).isGreaterThan(((Number) archive.get("_rev")).longValue());
        // The same node and block as now, from the old page's view: refused.
        Map<String, Object> stale = act(client, fresh, "click", null, fresh.get("fp"), fresh.get("_block"));
        assertThat(stale).containsEntry("done", true);
        Map<String, Object> old = new LinkedHashMap<>(fresh);
        old.put("_rev", archive.get("_rev"));
        assertThat(details(act(client, old, "click", null, fresh.get("fp"), fresh.get("_block")))).containsEntry("reason", "changed");
        assertThat(rig.call(client, "browser.minified.act", Map.of("tabId", TAB, "nodeId", "e.1", "action", "click", "fp", "fp1",
                "block", fresh.get("_block")))).containsEntry("code", "bad_request");
    }

    /** Review 6: a new document drops the old one's view, so nothing answers for a page that's gone. */
    @Test
    void aNewDocumentDropsTheOldView() throws Exception {
        get();
        assertThat(rig.module.minified().mayShareWithModel(TAB)).isTrue();
        assertThat(rig.module.mayShareWithModel(TAB)).isTrue();
        cdp.hold("Runtime.callFunctionOn");
        cdp.navigateInPage(TAB, "https://example.com/next", "Next");
        await().untilAsserted(() -> assertThat(rig.module.minified().mayShareWithModel(TAB)).isFalse());
        assertThat(rig.module.minified().health()).containsEntry("kept", 0);
        cdp.release("Runtime.callFunctionOn");
    }

    /** Review 6: a topic key alone makes no state for a tab that isn't there. */
    @Test
    void aTopicForATabThatIsntThereMakesNoState() throws Exception {
        assertThat(client.subscribe("browser.minified:T404", null)).containsEntry("_kind", "RES");
        Map<String, Object> first = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(Json.object(first, "data")).containsEntry("view", "closed");
        assertThat(rig.module.minified().health()).containsEntry("tabs", 0);
    }

    /** Review 6: once nobody watches, Chromium stops holding the tab's new frames for deskd, and deskd's script comes off. */
    @Test
    void leavingTheViewLetsTheTabsFramesRunFree() throws Exception {
        cdp.answer("Page.addScriptToEvaluateOnNewDocument", command -> Map.of("identifier", "7"));
        get();
        Map<String, Object> sub = client.subscribe("browser.minified:" + TAB, null);
        client.nextJson(Channels.EVENTS, FrameKind.EVT);
        client.sendJson(Channels.RPC, FrameKind.UNSUB, 91_000, Map.of("subId", sub.get("subId")));
        assertThat(client.nextReply()).containsEntry("_id", 91_000L);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            assertThat(cdp.commands("Target.setAutoAttach")).anySatisfy(c -> assertThat(c.params())
                    .containsEntry("autoAttach", false).containsEntry("waitForDebuggerOnStart", false));
            assertThat(cdp.commands("Page.removeScriptToEvaluateOnNewDocument")).anySatisfy(c ->
                    assertThat(c.params()).containsEntry("identifier", "7"));
        });
        // And a later look puts both back.
        cdp.clearCommands();
        assertThat(get()).containsEntry("view", "simplified");
        assertThat(cdp.commands("Target.setAutoAttach")).anySatisfy(c -> assertThat(c.params()).containsEntry("waitForDebuggerOnStart", true));
    }

    /** Review 6: a snapshot past the 2 MB deskd reads is a size failure at once, not a page that timed out. */
    @Test
    void aSnapshotTooLargeToReadIsTooLargeNotATimeout() throws Exception {
        // Two and a half megabytes take a loaded build machine past the unit tests' 400 ms snapshot limit: a longer one here,
        // so what's tested is the size, not the machine.
        withLongSnapshots();
        cdp.answer("Runtime.callFunctionOn", command -> Map.of("result", Map.of("type", "object", "value",
                Map.of("chunks", List.of("x".repeat(3000)), "pad", List.of("y".repeat(4000)).stream().toList(),
                        "big", java.util.Collections.nCopies(600, "z".repeat(4000))))));
        assertThat(details2(get())).containsEntry("reason", "too_large");
    }

    /** Review 7: a sensitive signal sticks to the whole site, not one host of it. */
    @Test
    void sensitivityStickstoTheSiteNotTheHost() throws Exception {
        cdp.navigateInPage(TAB, "https://login.example.co.uk/in", "In");
        Map<String, Object> signedIn = new LinkedHashMap<>(page.snapshot);
        signedIn.put("signals", List.of(Map.of("kind", "password", "origin", "https://login.example.co.uk")));
        page.snapshot = signedIn;
        await().untilAsserted(() -> assertThat(Json.object(get(), "mdoc")).containsEntry("sensitive", true));
        standardPage();
        cdp.navigateInPage(TAB, "https://shop.example.co.uk/", "Shop");
        await().untilAsserted(() -> assertThat(Json.object(get(), "mdoc")).containsEntry("sensitive", true)
                .containsEntry("url", "https://shop.example.co.uk/"));
        assertThat(rig.module.mayShareWithModel(TAB)).isFalse();
    }

    /** Review 9: a slow page, as one just thawed is, isn't held against its site. */
    @Test
    void aTimeoutIsNeverRememberedAgainstTheSite() throws Exception {
        cdp.hold("Runtime.callFunctionOn");
        for (String path : List.of("/one", "/two", "/three")) {
            cdp.navigateInPage(TAB, "https://slow.example" + path, "Slow");
            await().untilAsserted(() -> assertThat(details2(get())).containsEntry("reason", "timeout"));
        }
        cdp.release("Runtime.callFunctionOn");
        assertThat((List<?>) rig.call(client, "browser.minified.sites.list", Map.of(), null).get("sites")).isEmpty();
    }

    // ---- off is off

    /** Every CDP method the simplified view's own work sends. With the switch off, none of them is ever sent. */
    private static final Set<String> ITS_METHODS = Set.of("Page.addScriptToEvaluateOnNewDocument", "Page.removeScriptToEvaluateOnNewDocument",
            "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger", "Runtime.callFunctionOn", "Page.getResourceContent",
            "Page.getFrameTree", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText");

    /**
     * The view's scripts, in its own world. The Browser's attach puts one of its own in each tab's page, ProtectedMedia's,
     * which has no world name and isn't the view's.
     */
    private List<FakeCdp.Command> minifiedScripts() {
        return cdp.commands("Page.addScriptToEvaluateOnNewDocument").stream()
                .filter(c -> "ma-minify".equals(c.params().get("worldName")))
                .toList();
    }

    private List<FakeCdp.Command> itsCommands() {
        List<FakeCdp.Command> its = new ArrayList<>();
        for (FakeCdp.Command command : cdp.commands()) {
            boolean ownWorld = "Page.createIsolatedWorld".equals(command.method()) && "ma-minify".equals(command.params().get("worldName"));
            boolean browsers = "Page.addScriptToEvaluateOnNewDocument".equals(command.method())
                    && !"ma-minify".equals(command.params().get("worldName"));
            if ((ITS_METHODS.contains(command.method()) && !browsers) || ownWorld) {
                its.add(command);
            }
        }
        return its;
    }

    /** Everything a client could ask of the view, and the Browser used as usual, its pages changing. */
    private void everythingAClientCouldAsk() throws Exception {
        assertThat(client.subscribe(BrowserTabs.TOPIC, null)).containsEntry("_kind", "RES");
        assertThat(details(get())).containsEntry("reason", "disabled");
        Map<String, Object> act = new LinkedHashMap<>(Map.of("tabId", TAB, "nodeId", "e.1", "action", "click", "fp", "fp1", "block", "b", "rev", 1));
        assertThat(details(rig.call(client, "browser.minified.act", act))).containsEntry("reason", "disabled");
        assertThat(details(rig.call(client, "browser.minified.image", Map.of("tabId", TAB, "imageId", "i.1"), null))).containsEntry("reason", "disabled");
        assertThat(details(rig.call(client, "browser.minified.island", Map.of("tabId", TAB, "islandId", "vq.1"), null))).containsEntry("reason", "disabled");
        assertThat(details(rig.call(client, "browser.minified.site.get", Map.of("tabId", TAB), null))).containsEntry("reason", "disabled");
        assertThat(details(rig.call(client, "browser.minified.site.set", Map.of("host", "example.com", "view", "stream"))))
                .containsEntry("reason", "disabled");
        assertThat(client.subscribe("browser.minified:" + TAB, null)).containsEntry("code", "unavailable");
        cdp.navigateInPage(TAB, "https://example.com/b", "B");
        cdp.event("Target.attachedToTarget", Map.of("sessionId", "F9", "waitingForDebugger", false,
                "targetInfo", Map.of("targetId", "F9", "type", "iframe", "url", "https://ads.example/frame")), SESSION);
        await().until(() -> !cdp.commands("Page.enable").isEmpty());
        Thread.sleep(300);
    }

    private void restartWith(MinifiedSwitch flags) throws Exception {
        rig.close();
        cdp.clearCommands();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        start(flags);
    }

    /** The kill switch's check: with the file saying off, deskd injects nothing, attaches nothing and opens no world. */
    @Test
    void withTheSwitchOffNothingOfTheViewReachesChromium() throws Exception {
        for (String says : List.of("off\n", "  off media-actions-off\n", "consent-reject-off\noff")) {
            Path volume = Files.createTempDirectory(dir, "volume-");
            Files.writeString(volume.resolve(MinifiedSwitch.FILE), says);
            restartWith(MinifiedSwitch.file(volume));
            everythingAClientCouldAsk();
            assertThat(itsCommands()).as(says).isEmpty();
            assertThat(rig.module.minified().health()).containsEntry("kept", 0).containsEntry("watched", 0);
        }
    }

    /** With no switch file, the view is on, as every finished feature ships on. */
    @Test
    void withNoSwitchFileTheViewIsOn() throws Exception {
        Path volume = dir.resolve("volume-absent");
        Files.createDirectories(volume);
        restartWith(MinifiedSwitch.file(volume));
        assertThat(get()).containsEntry("view", "simplified");
    }

    /** Turned off at run time: calls refuse, the watched tab leaves, and a new frame runs free with nothing of deskd's. */
    @Test
    void turnedOffAtRunTimeTheTabLeavesAndNewFramesRunFree() throws Exception {
        Path volume = dir.resolve("volume-flip");
        Files.createDirectories(volume);
        Path file = volume.resolve(MinifiedSwitch.FILE);
        Files.writeString(file, "media-actions-off\n");
        cdp.answer("Page.addScriptToEvaluateOnNewDocument", c -> Map.of("identifier", "7"));
        restartWith(MinifiedSwitch.file(volume));
        assertThat(get()).containsEntry("view", "simplified");
        assertThat(client.subscribe("browser.minified:" + TAB, null)).containsEntry("_kind", "RES");
        await().until(() -> page.ops.contains("changed"));

        Files.writeString(file, "off\n");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            assertThat(cdp.commands("Target.setAutoAttach")).anyMatch(c -> Boolean.FALSE.equals(c.params().get("autoAttach")));
            assertThat(cdp.commands("Page.removeScriptToEvaluateOnNewDocument")).isNotEmpty();
        });
        assertThat(details(get())).containsEntry("reason", "disabled");
        cdp.clearCommands();
        cdp.event("Target.attachedToTarget", Map.of("sessionId", "F8", "waitingForDebugger", true,
                "targetInfo", Map.of("targetId", "F8", "type", "iframe", "url", "https://ads.example/late")), SESSION);
        await().until(() -> !cdp.commands("Runtime.runIfWaitingForDebugger").isEmpty());
        Thread.sleep(300);
        assertThat(cdp.commands()).extracting(FakeCdp.Command::method).doesNotContain(
                "Page.addScriptToEvaluateOnNewDocument", "Page.createIsolatedWorld", "Runtime.callFunctionOn");
        assertThat(cdp.commands("Target.setAutoAttach")).noneMatch(c -> Boolean.TRUE.equals(c.params().get("autoAttach")));
    }

    // ---- lever 2 (ADR 0045): work thaws Chromium first and holds off a freeze; watching does neither

    private static final String FREEZE = "freeze desk-browser";
    private static final String THAW = "thaw desk-browser";
    /** Nobody looking for 300 ms, and no work for 800 ms. */
    private static final BrowserFreeze.Timing FREEZING = new BrowserFreeze.Timing(Duration.ofMillis(300), Duration.ofMillis(800),
            Duration.ofMillis(200), Duration.ofSeconds(3), Duration.ofMillis(50), Duration.ofSeconds(3), Duration.ofSeconds(2));

    /** A desk nobody looks at, with lever 2's graces short. */
    private void restartFreezing() throws Exception {
        rig.close();
        cdp.clearCommands();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, new DeskAttention.Timing(Duration.ofMillis(100)), FREEZING);
        start(MinifiedSwitch.fixed(true, false, false));
        // Looked at and live, as the freeze tests start, then nobody looking.
        assertThat(rig.call(client, "desk.attention.set", Map.of("seen", true), null)).containsEntry("_kind", "RES");
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "live"), null)).containsEntry("state", "live");
        assertThat(rig.call(client, "desk.attention.set", Map.of("seen", false), null)).containsEntry("_kind", "RES");
    }

    private long units(String request) {
        return rig.units.requests().stream().filter(request::equals).count();
    }

    private void awaitFrozen() {
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.units.isFrozen("desk-browser") && rig.module.browserFrozen());
    }

    /** Review 9: the topic's watch for changes isn't work, so a watched tab still freezes, and the watch never thaws it. */
    @Test
    void aWatchedTabStillFreezesAndTheWatchNeverThawsIt() throws Exception {
        restartFreezing();
        assertThat(client.subscribe("browser.minified:" + TAB, null)).containsEntry("_kind", "RES");
        await().until(() -> page.ops.contains("changed"));
        awaitFrozen();
        long thaws = units(THAW);
        // Review 1: and it parks, rather than spinning, the whole time Chromium is frozen.
        long passes = rig.module.minified().watchPasses();
        await().during(Duration.ofMillis(2500)).atMost(Duration.ofSeconds(8))
                .until(() -> units(THAW) == thaws && rig.units.isFrozen("desk-browser"));
        assertThat(rig.module.minified().watchPasses() - passes).isLessThanOrEqualTo(4);
    }

    /** Review 1 and 2: a watched tab that goes to the stream parks its watcher, and lets its frames and script go. */
    @Test
    void aWatchedTabThatGoesToTheStreamParksAndLetsGo() throws Exception {
        cdp.answer("Page.addScriptToEvaluateOnNewDocument", c -> Map.of("identifier", "7"));
        restartWith(MinifiedSwitch.fixed(true, false, false));
        assertThat(client.subscribe("browser.minified:" + TAB, null)).containsEntry("_kind", "RES");
        await().until(() -> page.ops.contains("changed"));
        assertThat(rig.call(client, "browser.minified.site.set", Map.of("host", "example.com", "view", "stream"))).containsEntry("view", "stream");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            assertThat(cdp.commands("Target.setAutoAttach")).anyMatch(c -> Boolean.FALSE.equals(c.params().get("autoAttach")));
            assertThat(cdp.commands("Page.removeScriptToEvaluateOnNewDocument")).isNotEmpty();
        });
        long passes = rig.module.minified().watchPasses();
        Thread.sleep(2500);
        assertThat(rig.module.minified().watchPasses() - passes).isLessThanOrEqualTo(4);
    }

    /** Lever 2: a call thaws Chromium before anything of it reaches Chromium. */
    @Test
    void aCallThawsChromiumBeforeAnythingReachesIt() throws Exception {
        restartFreezing();
        assertThat(get()).containsEntry("view", "simplified");
        awaitFrozen();
        for (String method : List.of("browser.minified.get", "browser.minified.site.get", "browser.minified.island")) {
            awaitFrozen();
            rig.units.hold(THAW);
            cdp.clearCommands();
            Map<String, Object> params = "browser.minified.island".equals(method) ? Map.of("tabId", TAB, "islandId", "vq.1") : Map.of("tabId", TAB);
            long id = rig.send(client, method, params, null);
            rig.units.awaitHeld(THAW);
            Thread.sleep(200);
            assertThat(cdp.commands()).as(method).isEmpty();
            rig.units.release(THAW);
            Map<String, Object> reply = client.nextReply();
            assertThat(reply).as(method).containsEntry("_id", id);
            if ("browser.minified.island".equals(method)) {
                // The view went with the connection the freeze closed: the client gets it again first.
                assertThat(reply).containsEntry("code", "not_found");
            } else {
                assertThat(reply).as(method).containsEntry("_kind", "RES");
            }
            rig.call(client, "desk.attention.set", Map.of("seen", false), null);
        }
    }

    /** Review 9: an action in flight is work, and no freeze comes under it however long the page takes. */
    @Test
    void anActionInFlightHoldsOffAFreeze() throws Exception {
        restartFreezing();
        Map<String, Object> archive = run("button", "Archive");
        int before = cdp.commands("Runtime.callFunctionOn").size();
        cdp.hold("Runtime.callFunctionOn");
        CompletableFuture<Map<String, Object>> acted = CompletableFuture.supplyAsync(() -> {
            try {
                return act(archive, "click", null);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        await().until(() -> cdp.commands("Runtime.callFunctionOn").size() > before);
        long freezes = units(FREEZE);
        // Well past the 800 ms with no work that would freeze it, and inside the action's own 2 s wait for the page.
        await().during(Duration.ofMillis(1500)).atMost(Duration.ofSeconds(5)).until(() -> units(FREEZE) == freezes);
        cdp.answerHeld("Runtime.callFunctionOn");
        acted.get(10, TimeUnit.SECONDS);
        awaitFrozen();
    }

    // ---- Browser time on a free desk (ADR 0090 section 2): the simplified view in use counts, and is refused at the limit

    private static final TierLimits.Limits FREE = new TierLimits.Limits("free", 45, 2, 30);
    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-09T15:00:00Z"));
    private final AtomicLong nanos = new AtomicLong(1_000_000_000L);
    private BrowserTime time;

    /** Browser time as the desk wires it, on clocks the test moves, with its timer running. */
    private void meter(TierLimits.Limits limits) {
        time = new BrowserTime(dir.resolve(BrowserTime.FILE), dir.resolve(BrowserTime.LIVE_FILE), "boot-1", clock, nanos::get, () -> null, limits);
        time.onOut(rig.module::browserTimeUsed);
        rig.module.followBrowserTime(time::outUntil, time::live);
        time.start();
    }

    private void pass(Duration by) {
        clock.advance(by);
        nanos.addAndGet(by.toNanos());
    }

    private long usedMillis() {
        return time.view().usedMillis();
    }

    private void looking(boolean seen) throws Exception {
        assertThat(rig.call(client, "desk.attention.set", Map.of("seen", seen), null)).containsEntry("_kind", "RES");
    }

    private Map<String, Object> subscribeView() throws Exception {
        Map<String, Object> sub = client.subscribe("browser.minified:" + TAB, null);
        assertThat(sub).containsEntry("_kind", "RES");
        client.nextJson(Channels.EVENTS, FrameKind.EVT);
        return sub;
    }

    private void unsubscribe(Map<String, Object> sub) throws Exception {
        client.sendJson(Channels.RPC, FrameKind.UNSUB, 91_001, Map.of("subId", sub.get("subId")));
        assertThat(client.nextReply()).containsEntry("_id", 91_001L);
    }

    private void assertTimeRefusal(Map<String, Object> reply) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
        assertThat(details(reply))
                .containsEntry("reason", "bandwidth_limit")
                .containsEntry("resumesAt", time.outUntil().toString())
                .containsEntry("limit", "browser_time");
    }

    /** The day's time used up: the desk looked at, a subscription, a quiet clock, then the limit lowered under the use. */
    private void runOut() throws Exception {
        looking(true);
        subscribeView();
        pass(Duration.ofMinutes(2));
        time.limitsChanged(new TierLimits.Limits("free", 1, 2, 30));
        await().atMost(Duration.ofSeconds(10)).until(() -> time.outUntil() != null);
    }

    @Test
    void theSimplifiedViewAloneCountsWhileItIsLookedAtAndSubscribed() throws Exception {
        meter(FREE);
        looking(true);
        assertThat(time.view().live()).isFalse();
        Map<String, Object> sub = subscribeView();
        assertThat(time.view().live()).isTrue();
        pass(Duration.ofSeconds(90));
        assertThat(usedMillis()).isBetween(89_000L, 91_000L);
        assertThat(time.liveSecondsSinceBoot()).isBetween(89L, 91L);

        // Nobody looking: a subscription held by a hidden tab costs nothing.
        looking(false);
        assertThat(time.view().live()).isFalse();
        pass(Duration.ofMinutes(10));
        assertThat(usedMillis()).isBetween(89_000L, 91_000L);
        looking(true);
        assertThat(time.view().live()).isTrue();
        unsubscribe(sub);
        assertThat(time.view().live()).isFalse();
        pass(Duration.ofMinutes(10));
        assertThat(usedMillis()).isBetween(89_000L, 91_000L);
        assertThat(time.liveSecondsSinceBoot()).isBetween(89L, 91L);
    }

    @Test
    void aPageCallCountsForALeaseEvenWithNoSubscription() throws Exception {
        rig.module.minified().useLease(Duration.ofMillis(400));
        meter(FREE);
        assertThat(get()).containsEntry("view", "simplified");
        assertThat(time.view().live()).isTrue();
        await().atMost(Duration.ofSeconds(5)).until(() -> !time.view().live());
    }

    @Test
    void theSimplifiedViewAndLiveTogetherAreCountedOnce() throws Exception {
        meter(FREE);
        looking(true);
        Map<String, Object> sub = subscribeView();
        pass(Duration.ofSeconds(30));
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "live"), null)).containsEntry("state", "live");
        pass(Duration.ofSeconds(60));
        assertThat(usedMillis()).isBetween(89_000L, 91_000L);

        // The view ends first, live carries on; then live ends and the view is back, then both end.
        unsubscribe(sub);
        assertThat(time.view().live()).isTrue();
        pass(Duration.ofSeconds(30));
        assertThat(usedMillis()).isBetween(119_000L, 121_000L);
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "off"), null)).containsEntry("state", "off");
        assertThat(time.view().live()).isFalse();
        pass(Duration.ofMinutes(5));
        assertThat(usedMillis()).isBetween(119_000L, 121_000L);
        assertThat(time.liveSecondsSinceBoot()).isBetween(119L, 121L);
    }

    @Test
    void atTheLimitTheViewsPageCallsAndSubscriptionAreRefusedAsLiveIsAndOpenOnesEnd() throws Exception {
        meter(FREE);
        Map<String, Object> archive = run("button", "Archive");
        runOut();

        // The open subscription is ended with an error event, as the live pause leaves its sessions off.
        Map<String, Object> ended = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(ended).containsEntry("type", "error");
        assertThat(Json.object(ended, "data")).containsEntry("code", "unavailable");

        assertTimeRefusal(get());
        assertTimeRefusal(act(archive, "click", null));
        assertTimeRefusal(rig.call(client, "browser.minified.image", Map.of("tabId", TAB, "imageId", "i1"), null));
        assertTimeRefusal(rig.call(client, "browser.minified.island", Map.of("tabId", TAB, "islandId", "vq.1"), null));
        assertTimeRefusal(client.subscribe("browser.minified:" + TAB, null));
        assertThat(time.view().live()).isFalse();

        // The same shape live gets, and what isn't the page carries on.
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "live"), null)).satisfies(this::assertTimeRefusal);
        assertThat(rig.call(client, "browser.minified.sites.list", Map.of(), null)).containsEntry("_kind", "RES");
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "warm"), null)).containsEntry("state", "warm");
        // Nothing of the tab or the session was touched (ADR 0035).
        assertThat(cdp.commands("Target.closeTarget")).isEmpty();
        assertThat(cdp.commands("Network.clearBrowserCookies")).isEmpty();
        assertThat(cdp.commands("Storage.clearDataForOrigin")).isEmpty();
        assertThat(rig.units.requests()).doesNotContain("stop desk-browser");
    }

    @Test
    void theRefusalLiftsAtTheResetAndOnAnUpgrade() throws Exception {
        meter(FREE);
        runOut();
        assertTimeRefusal(get());

        // At resumesAt, with nothing said to the desk.
        Instant resumes = time.outUntil();
        pass(Duration.between(clock.instant(), resumes).plusSeconds(1));
        assertThat(get()).containsEntry("view", "simplified");
        assertThat(client.subscribe("browser.minified:" + TAB, null)).containsEntry("_kind", "RES");

        // And on an upgrade, the limits gone at the next config.
        client.nextJson(Channels.EVENTS, FrameKind.EVT);
        pass(Duration.ofMinutes(2));
        time.limitsChanged(new TierLimits.Limits("free", 1, 2, 30));
        await().atMost(Duration.ofSeconds(10)).until(() -> time.outUntil() != null);
        assertTimeRefusal(get());
        time.limitsChanged(null);
        assertThat(time.outUntil()).isNull();
        assertThat(get()).containsEntry("view", "simplified");
        assertThat(client.subscribe("browser.minified:" + TAB, null)).containsEntry("_kind", "RES");
    }

    @Test
    void aDeskWithNoLimitsIsNeverRefusedAndStillCounts() throws Exception {
        meter(null);
        looking(true);
        subscribeView();
        pass(Duration.ofHours(5));
        assertThat(time.outUntil()).isNull();
        assertThat(get()).containsEntry("view", "simplified");
        assertThat(rig.call(client, "browser.minified.island", Map.of("tabId", TAB, "islandId", "vq.1"), null)).containsEntry("_kind", "RES");
        assertThat(client.subscribe("browser.minified:" + TAB, null)).containsEntry("_kind", "RES");
        assertThat(time.liveSecondsSinceBoot()).isEqualTo(5 * 3600L);
        assertThat(time.view().limited()).isFalse();
    }
}
