package com.minimalistalliance.desk.deskd.notebook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Page text through deskd's real relay on {@code collab}, between real {@code @hocuspocus/provider} clients and the real
 * desk-notebook. The providers run in Node, in {@code services/notebook/tests/helpers/provider-bridge.mjs}, which shapes
 * its virtual socket as the app does, and this carries their bytes both ways. Skipped unless both commands are set:
 *
 * <pre>
 * DESK_NOTEBOOK_CMD="exec node $PWD/notebook/dist/desk-notebook.mjs" \
 * DESK_NOTEBOOK_CLIENT_CMD="exec node $PWD/notebook/tests/helpers/provider-bridge.mjs" \
 *     ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=RealDeskNotebookCollabIT
 * </pre>
 *
 * deskd's timing is production's. {@code NOTEBOOK_KILL_ROUNDS} sets how many SIGKILLs each test has (5).
 */
@EnabledIfEnvironmentVariable(named = RealNotebookService.CMD, matches = ".+")
@EnabledIfEnvironmentVariable(named = RealDeskNotebookCollabIT.CLIENT_CMD, matches = ".+")
class RealDeskNotebookCollabIT {

    static final String CLIENT_CMD = "DESK_NOTEBOOK_CLIENT_CMD";
    private static final Duration SETTLE = Duration.ofSeconds(30);
    private static final int ROUNDS = Integer.parseInt(System.getenv().getOrDefault("NOTEBOOK_KILL_ROUNDS", "5"));

    @TempDir
    Path dir;

    private RealNotebookService service;
    private NotebookRig rig;
    private TestClient client;
    private Bridge bridge;
    /** By provider, and by page across providers. */
    private final Map<Integer, List<String>> typed = new HashMap<>();
    private final Map<String, List<String>> onPage = new HashMap<>();
    private final Map<Integer, String> pageOf = new HashMap<>();

    @BeforeEach
    void setUp() throws Exception {
        service = new RealNotebookService(dir);
        rig = new NotebookRig(dir, service.socket(), NotebookModule.Timing.DEFAULT);
        client = rig.connect("a");
        bridge = new Bridge(rig, client, 1000);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (bridge != null) {
            bridge.close();
        }
        rig.close();
        service.close();
    }

    /** The release check's case: two pages open in one session, desk-notebook SIGKILLed, and both sync again. */
    @Test
    void bothPagesSyncAgainAfterASigkill() throws Exception {
        List<String> pages = twoPages();
        int a = open(pages.get(0));
        int b = open(pages.get(1));
        type(a, "first");
        type(b, "first");
        awaitSettled();

        Random random = new Random(seed());
        for (int round = 1; round <= ROUNDS; round++) {
            Duration away = Duration.ofMillis(random.nextInt(2500));
            System.err.printf("round %d of %d: away %d ms%n", round, ROUNDS, away.toMillis());
            // An edit in flight as it dies, and one while it's away: both reach it once it's back.
            type(a, "before-kill-" + round);
            type(b, "before-kill-" + round);
            service.kill(away);
            type(a, "while-away-" + round);
            type(b, "while-away-" + round);
            awaitSettled();
            // And an edit after it's back is acknowledged, which is what stayed false on the desk.
            type(a, "after-" + round);
            type(b, "after-" + round);
            awaitSettled();
        }
        assertContent(pages);
    }

    /**
     * The release check's read-back, where the desk's page stayed unsynced: once desk-notebook is back from a SIGKILL,
     * every provider and the transport go, and new ones open the same pages on the same session at once, with the
     * check's 200 ms reconnect. Then the same again with no SIGKILL. An edit on each new provider must be acknowledged.
     */
    @Test
    void pagesReopenedRightAfterASigkillSync() throws Exception {
        bridge.close();
        bridge = new Bridge(rig, client, 200);
        List<String> pages = twoPages();
        type(open(pages.get(0)), "first");
        type(open(pages.get(1)), "first");
        awaitSettled();

        Random random = new Random(seed());
        for (int round = 1; round <= ROUNDS; round++) {
            Duration away = Duration.ofMillis(random.nextInt(2500));
            System.err.printf("round %d of %d: away %d ms%n", round, ROUNDS, away.toMillis());
            service.kill(away);
            awaitSettled();
            for (String step : List.of("reopened-", "reopened-again-")) {
                bridge.fresh();
                type(open(pages.get(0)), step + round);
                type(open(pages.get(1)), step + round);
                awaitSettled();
            }
        }
        assertContent(pages);
    }

    /** The same read-back with desk-notebook up throughout: a page closed and opened again at once, many times. */
    @Test
    void pagesReopenedOnALiveSessionSync() throws Exception {
        bridge.close();
        bridge = new Bridge(rig, client, 200);
        List<String> pages = twoPages();
        type(open(pages.get(0)), "first");
        type(open(pages.get(1)), "first");
        awaitSettled();
        for (int round = 1; round <= 4 * ROUNDS; round++) {
            bridge.fresh();
            type(open(pages.get(0)), "reopened-" + round);
            type(open(pages.get(1)), "reopened-" + round);
            awaitSettled();
        }
        assertContent(pages);
    }

    private static long seed() {
        long seed = System.nanoTime();
        System.err.println("seed " + seed);
        return seed;
    }

    private int open(String page) throws Exception {
        int i = bridge.open(page);
        pageOf.put(i, page);
        return i;
    }

    private void assertContent(List<String> pages) throws Exception {
        for (String page : pages) {
            assertThat(content(page)).contains(onPage.get(page));
        }
    }

    /** A notebook's first page and a second one in its tab. */
    private List<String> twoPages() throws Exception {
        Map<String, Object> created = rig.call(client, "notebook.notebook.create", Map.of("title", "Kill"));
        assertThat(created).containsEntry("_kind", "RES");
        String first = (String) ((Map<?, ?>) created.get("page")).get("id");
        String tab = (String) ((Map<?, ?>) created.get("tab")).get("id");
        Map<String, Object> second = rig.call(client, "notebook.page.create", Map.of("tabId", tab));
        assertThat(second).containsEntry("_kind", "RES");
        return List.of(first, (String) ((Map<?, ?>) second.get("page")).get("id"));
    }

    /** Each marker carries its provider's index, so no page's marker is another's. */
    private void type(int provider, String text) throws Exception {
        String marker = "p" + provider + "-" + text;
        bridge.type(provider, marker);
        typed.computeIfAbsent(provider, k -> new ArrayList<>()).add(marker);
        onPage.computeIfAbsent(pageOf.get(provider), k -> new ArrayList<>()).add(marker);
    }

    /** Every open provider synced, nothing unacknowledged, and each page holding what was typed into it. */
    private void awaitSettled() throws Exception {
        long deadline = System.nanoTime() + SETTLE.toNanos();
        Map<String, Object> state = null;
        while (System.nanoTime() < deadline) {
            state = bridge.state();
            if (settled(state)) {
                return;
            }
            Thread.sleep(50);
        }
        fail("not settled in " + SETTLE.toSeconds() + " s: " + state);
    }

    @SuppressWarnings("unchecked")
    private boolean settled(Map<String, Object> state) {
        for (Map<String, Object> page : (List<Map<String, Object>>) state.get("pages")) {
            if (Boolean.TRUE.equals(page.get("gone"))) {
                continue;
            }
            if (!Boolean.TRUE.equals(page.get("synced")) || ((Number) page.get("unsynced")).intValue() != 0) {
                return false;
            }
            String text = (String) page.get("text");
            if (!typed.getOrDefault(((Number) page.get("i")).intValue(), List.of()).stream().allMatch(text::contains)) {
                return false;
            }
        }
        return true;
    }

    /** What desk-notebook has, read over RPC, as a fresh client would. */
    private String content(String pageId) throws Exception {
        StringBuilder text = new StringBuilder();
        Map<String, Object> params = new LinkedHashMap<>(Map.of("pageId", pageId));
        while (true) {
            Map<String, Object> part = rig.call(client, "notebook.page.content", params);
            assertThat(part).containsEntry("_kind", "RES");
            text.append((String) part.get("part"));
            if (part.get("next") == null) {
                return text.toString();
            }
            params.put("cursor", part.get("next"));
        }
    }

    /** The Node process and the two pumps between it and deskd. */
    private static final class Bridge implements AutoCloseable {
        private final NotebookRig rig;
        private final TestClient client;
        private final Process process;
        private final OutputStream stdin;
        private final ReentrantLock writing = new ReentrantLock();
        private final BlockingQueue<Map<String, Object>> replies = new LinkedBlockingQueue<>();
        private final Thread fromNode;
        private final Thread fromDeskd;
        private volatile boolean closing;

        /** @param reconnectMs the transport's reconnect delay: the app's is 1 s, the release check's 200 ms */
        Bridge(NotebookRig rig, TestClient client, int reconnectMs) throws Exception {
            this.rig = rig;
            this.client = client;
            ProcessBuilder builder = new ProcessBuilder("sh", "-c", System.getenv(CLIENT_CMD));
            builder.environment().put("BRIDGE_RECONNECT_MS", Integer.toString(reconnectMs));
            builder.redirectError(ProcessBuilder.Redirect.INHERIT);
            process = builder.start();
            stdin = process.getOutputStream();
            fromNode = Thread.ofPlatform().daemon().name("bridge-from-node").start(this::readNode);
            fromDeskd = Thread.ofPlatform().daemon().name("bridge-from-deskd").start(this::readDeskd);
        }

        int open(String page) throws Exception {
            write(Map.of("op", "open", "page", page));
            return ((Number) reply("opened").get("i")).intValue();
        }

        void type(int i, String text) throws Exception {
            write(Map.of("op", "type", "i", i, "text", text));
            reply("typed");
        }

        void fresh() throws Exception {
            write(Map.of("op", "fresh"));
            reply("freshed");
        }

        Map<String, Object> state() throws Exception {
            write(Map.of("op", "state"));
            return reply("state");
        }

        private Map<String, Object> reply(String op) throws Exception {
            Map<String, Object> reply = replies.poll(10, TimeUnit.SECONDS);
            if (reply == null || !op.equals(reply.get("op"))) {
                fail("the bridge didn't answer " + op + ": " + reply);
            }
            return reply;
        }

        private void write(Map<String, Object> message) {
            byte[] line = (new String(Json.bytes(message), StandardCharsets.UTF_8) + "\n").getBytes(StandardCharsets.UTF_8);
            writing.lock();
            try {
                stdin.write(line);
                stdin.flush();
            } catch (Exception e) {
                if (!closing) {
                    throw new IllegalStateException("the bridge has gone", e);
                }
            } finally {
                writing.unlock();
            }
        }

        /** Node's socket sends: each one a BIN DATA, in order. */
        private void readNode() {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    Map<String, Object> message = Json.parseObject(line.getBytes(StandardCharsets.UTF_8));
                    if ("out".equals(message.get("op"))) {
                        rig.sendCollab(client, Base64.getDecoder().decode((String) message.get("b64")));
                    } else {
                        replies.add(message);
                    }
                }
            } catch (Exception e) {
                if (!closing) {
                    e.printStackTrace();
                }
            }
        }

        /** deskd's DATA on collab, joined: a message for the providers, or a reset for the socket. */
        private void readDeskd() {
            ByteArrayOutputStream joined = new ByteArrayOutputStream();
            try {
                while (!closing) {
                    Frame frame = rig.rtcFake.pollFrame(client.handle(), Channels.COLLAB, 100);
                    if (frame == null) {
                        continue;
                    }
                    joined.writeBytes(frame.payload());
                    if (frame.more()) {
                        continue;
                    }
                    NotebookRig.Data data = new NotebookRig.Data((frame.flags() & Frame.BIN) != 0, joined.toByteArray());
                    joined.reset();
                    if (data.binary()) {
                        write(Map.of("op", "in", "b64", Base64.getEncoder().encodeToString(data.bytes())));
                    } else if (data.isReset()) {
                        write(Map.of("op", "reset"));
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        @Override
        public void close() throws Exception {
            closing = true;
            fromDeskd.join(5_000);
            process.destroy();
            process.waitFor(5, TimeUnit.SECONDS);
            process.destroyForcibly();
            fromNode.join(5_000);
        }
    }
}
