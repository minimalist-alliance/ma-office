package com.minimalistalliance.desk.deskd;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.notebook.NotebookModule;
import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.ControlPlaneRig;
import com.minimalistalliance.desk.deskd.testing.FakeAgentSocket;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.FakeGateway;
import com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.StubUnitsSocket;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * A stalled desk-notebook, with one session piled up on it, against everything else: the Browser, /health, heartbeats,
 * {@code agent.*}, another session and SIGTERM. The first test is the real application through its real sockets and real
 * timings, and the second the control plane's rig, as only that can watch several heartbeats go by quickly.
 */
class NotebookIsolationTest {

    private static final String TAB_A = "ab".repeat(32);
    private static final String TAB_B = "cd".repeat(32);
    private static final int MIB_4 = 4 << 20;

    static {
        TestTiming.pollFast();
    }

    @TempDir
    Path dir;

    private final AtomicLong ids = new AtomicLong(50_000);

    /** One call, skipping any replies in the way: calls stuck on desk-notebook answer whenever they fail. */
    private Map<String, Object> call(TestClient client, String method, Map<String, Object> params) throws Exception {
        long id = ids.incrementAndGet();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("m", method);
        body.put("p", params);
        client.sendJson(Channels.RPC, FrameKind.REQ, id, body);
        while (true) {
            Map<String, Object> reply = client.nextReply();
            if (Long.valueOf(id).equals(reply.get("_id"))) {
                return reply;
            }
        }
    }

    private static void sendCollab(FakeDeskRtc rtc, TestClient client, byte[] message) {
        for (byte[] frame : Frame.fragment(FrameKind.DATA, Frame.BIN, 7, 0, message)) {
            rtc.sendData(client.handle(), Channels.COLLAB, frame);
        }
    }

    /** As much as a client can stick on it: a message that fills the socket, and calls past the limit. */
    private void pileUp(FakeDeskRtc rtc, TestClient client) {
        Thread.ofVirtual().start(() -> sendCollab(rtc, client, new byte[MIB_4]));
        for (int i = 0; i < 40; i++) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("m", "notebook.search");
            body.put("p", Map.of("query", "x"));
            client.sendJson(Channels.RPC, FrameKind.REQ, ids.incrementAndGet(), body);
        }
    }

    private static TestClient open(FakePlatform platform, FakeGateway gateway, FakeDeskRtc rtc, String sessionId, String tab, long handle)
            throws Exception {
        gateway.send(message("session.open", "sessionId", sessionId, "deskToken", platform.tokens.mint(tab, Instant.now())));
        assertThat(gateway.await("session.accept")).containsEntry("sessionId", sessionId);
        gateway.send(message("signal", "sessionId", sessionId, "data", Map.of("type", "offer", "sdp", TestClient.offerFor(tab))));
        gateway.await("signal");
        TestClient client = new TestClient(rtc, handle);
        client.hello();
        return client;
    }

    private static Map<String, Object> message(String type, Object... pairs) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("type", type);
        for (int i = 0; i < pairs.length; i += 2) {
            message.put((String) pairs[i], pairs[i + 1]);
        }
        return message;
    }

    @Test
    void theRealApplicationGoesOnWithDeskNotebookStalled() throws Exception {
        try (FakePlatform platform = new FakePlatform();
                FakeGateway gateway = new FakeGateway(platform.timeline);
                FakeDeskRtc rtc = new FakeDeskRtc(dir.resolve("rtc.sock"));
                StubUnitsSocket units = new StubUnitsSocket(dir.resolve("units.sock"));
                FakeAgentSocket agent = new FakeAgentSocket(dir.resolve("agent.sock"));
                FakeNotebookSocket notebook = new FakeNotebookSocket(dir.resolve("notebook.sock"))) {
            rtc.autoStats(true);
            agent.handlers.put("agent.list", p -> Map.of("agents", List.of()));
            notebook.handlers.put("notebook.tree", p -> Map.of("notebooks", List.of()));
            platform.gatewayUrl = gateway.url();
            List<String> args = new ArrayList<>(List.of(DeskdApplicationTests.args(dir, platform)));
            args.add("--deskd.agent.socket=" + dir.resolve("agent.sock"));
            args.add("--deskd.notebook.socket=" + dir.resolve("notebook.sock"));
            ConfigurableApplicationContext context = DeskdApplication.application().run(args.toArray(String[]::new));
            try {
                await().atMost(Duration.ofSeconds(20)).until(context.getBean(GatewayLink.class)::isReady);
                assertThat(DeskdApplicationTests.health(dir)).contains("200 OK", "\"notebook\":\"waiting\"");

                TestClient piled = open(platform, gateway, rtc, "cs-piled", TAB_A, 1);
                TestClient other = open(platform, gateway, rtc, "cs-other", TAB_B, 2);
                assertThat(call(piled, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
                assertThat(call(other, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
                assertThat(DeskdApplicationTests.health(dir)).contains("200 OK", "\"status\":\"ok\"", "\"notebook\":\"connected\"");

                notebook.stallAll();
                pileUp(rtc, piled);
                Thread.sleep(100);

                // None of these waits on it, in the session that piled up or the other. Under load, they're all well inside 4 s.
                long started = System.nanoTime();
                for (TestClient client : List.of(piled, other)) {
                    assertThat(call(client, "desk.status.get", Map.of())).containsEntry("_kind", "RES");
                    assertThat(call(client, "agent.list", Map.of())).containsEntry("_kind", "RES");
                    assertThat(call(client, "browser.tab.list", Map.of()))
                            .containsEntry("code", "unavailable")
                            .containsEntry("details", Map.of("reason", "chromium"));
                    assertThat(call(client, "browser.stream.set", Map.of("state", "warm"))).containsEntry("_kind", "RES");
                    assertThat(call(client, "browser.stream.set", Map.of("state", "off"))).containsEntry("_kind", "RES");
                    assertThat(DeskdApplicationTests.health(dir)).contains("200 OK", "\"status\":\"ok\"", "\"notebook\":");
                }
                assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(4));
                assertThat(units.requests()).contains("start desk-stream");
                assertThat(platform.apiRequests.stream().filter(request -> "/v1/agent/heartbeat".equals(request.path()))).isNotEmpty();

                // SIGTERM's path, with a write stalled and calls waiting: the 5 s budget, and the last heartbeat.
                started = System.nanoTime();
                context.close();
                assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
                assertThat(platform.apiRequests.stream()
                                .filter(request -> "/v1/agent/heartbeat".equals(request.path()))
                                .map(FakePlatform.Request::json))
                        .anyMatch(body -> Boolean.TRUE.equals(body.get("final")));
                notebook.resumeAll();
                await().until(() -> notebook.openConnections() == 0);
            } finally {
                context.close();
            }
        }
    }

    @Test
    void heartbeatsKeepGoingWithDeskNotebookStalled() throws Exception {
        try (ControlPlaneRig rig = new ControlPlaneRig(
                        dir, ControlPlaneRig.FAST_LINK, new HeartbeatLoop.Timing(Duration.ofMillis(200), Duration.ofMillis(100), Duration.ofSeconds(5)));
                FakeNotebookSocket notebook = new FakeNotebookSocket(dir.resolve("notebook.sock"))) {
            rig.platform.nextHeartbeatSeconds = null;
            NotebookModule module = new NotebookModule(
                    notebook.socket(), rig.sessions, rig.dispatcher, rig.hub, NotebookModule.Timing.DEFAULT);
            rig.bootToReady();
            rig.sessions.open("cs-1", rig.platform.tokens.mint(TAB_A, Instant.now()));
            rig.sessions.offer("cs-1", TestClient.offerFor(TAB_A));
            TestClient client = new TestClient(rig.rtc, 1);
            client.hello();
            notebook.handlers.put("notebook.tree", p -> Map.of());
            assertThat(call(client, "notebook.tree", Map.of())).containsEntry("_kind", "RES");

            notebook.stallAll();
            pileUp(rig.rtc, client);
            Thread.sleep(100);

            long before = heartbeats(rig);
            await().atMost(Duration.ofSeconds(5)).until(() -> heartbeats(rig) >= before + 3);
            module.close();
        }
    }

    private static long heartbeats(ControlPlaneRig rig) {
        return rig.platform.apiRequests.stream().filter(request -> "/v1/agent/heartbeat".equals(request.path())).count();
    }
}
