package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.desks.DeskMessaging;
import com.minimalistalliance.desk.deskd.desks.DeskTools;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Messages between two of the member's desks end to end (draft ADR "the Agent's tools and approvals", §14), each desk a
 * real deskd relay with its own keys and record ({@link DeskMessaging}, {@link DeskTools}) over a real desk-agent jar on
 * real Unix sockets, a stand-in for Anthropic's API on loopback, and the test as the office carrying the envelopes as
 * the Desk app's carrier does: the pairing through offer and accept, a message answered within the wait, a restart of
 * the answering desk's desk-agent while the office carries (exactly once), and a Stop on the answering desk refusing the
 * very next message. {@code verify} skips it unless {@code DESK_AGENT_JAR} names desk-agent's jar.
 */
@EnabledIfEnvironmentVariable(named = "DESK_AGENT_JAR", matches = ".+")
class RealDeskAgentDesksIT {

    private static final String KEY = "sk-ant-api03-stand-in-key-0006";
    private static final String MODEL = "claude-sonnet-5-5";
    /** What only a run answering another desk's message reads: its system part and its message. */
    private static final String B_RUN = "on another of the member's desks, not from the member";

    @TempDir
    Path dir;

    private HttpServer provider;
    private final ConcurrentLinkedQueue<String> requests = new ConcurrentLinkedQueue<>();
    /** How long each delivery to a running desk took, from the office's call to its answer: §17's 500 ms. */
    private final List<Double> deliverMs = new java.util.concurrent.CopyOnWriteArrayList<>();
    private final Desk a = new Desk("a", "d-aaaa");
    private final Desk b = new Desk("b", "d-bbbb");

    /** One desk: its deskd relay, keys and record, its desk-agent, and the office's session to it. */
    private final class Desk {
        final String name;
        final String deskId;
        AgentRig rig;
        DeskMessaging messaging;
        Process process;
        TestClient session;

        Desk(String name, String deskId) {
            this.name = name;
            this.deskId = deskId;
        }

        Path dir() {
            return dir.resolve(name);
        }

        void open() throws Exception {
            Files.createDirectories(dir().resolve("agent-data"));
            Files.createDirectories(dir().resolve("desk-data"));
            rig = new AgentRig(dir(), false);
            rig.module.keepAccessIn(dir().resolve("desk-data"));
            messaging = new DeskMessaging(rig.clock, () -> deskId, () -> "user-1", () -> false);
            messaging.keepIn(dir().resolve("desk-data"));
            rig.module.desks(messaging, () -> false);
            ToolHost host = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
            host.agentApps(rig.module.accessRecord());
            host.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
                var redeemed = rig.module.approvalTickets().redeem(approvalId, sha256, agentId, runId, tool, context,
                        args);
                return redeemed.ok() ? null : redeemed.refusal().code();
            });
            host.area(HostedDecls.DESKS, new DeskTools(messaging, rig.module::agentName));
            rig.module.hostTools(host);
            start();
            session = rig.connect(name);
        }

        void start() throws IOException {
            int uid = (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
            String url = "http://127.0.0.1:" + provider.getAddress().getPort();
            List<String> command = new ArrayList<>(List.of(
                    Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                    "-jar", System.getenv("DESK_AGENT_JAR"),
                    "--desk.agent.socket=" + dir().resolve("agent.sock"),
                    "--desk.agent.admin.socket=" + dir().resolve("agent-admin.sock"),
                    "--desk.agent.data.dir=" + dir().resolve("agent-data"),
                    "--desk.agent.peer.uid=" + uid,
                    "--desk.agent.anthropic.url=" + url, "--desk.agent.openai.url=" + url,
                    "--desk.agent.xai.url=" + url));
            process = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(
                    ProcessBuilder.Redirect.appendTo(dir().resolve("desk-agent.log").toFile())).start();
            await().atMost(Duration.ofSeconds(60)).until(() -> rig.module.link().isConnected() || !process.isAlive());
            assertThat(process.isAlive()).as(name + "'s desk-agent started").isTrue();
        }

        void kill() throws InterruptedException {
            process.destroyForcibly();
            process.waitFor();
            await().until(() -> !rig.module.link().isConnected());
        }

        Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
            boolean mutation = AgentMethods.MUTATIONS.contains(method)
                    || List.of(DeskMethods.DELIVER, DeskMethods.DONE, DeskMethods.ANSWER).contains(method);
            return rig.call(session, method, params, mutation ? UUID.randomUUID().toString() : null);
        }

        void setUp() throws Exception {
            Map<String, Object> added = call("agent.key.add", Map.of("provider", "anthropic", "label", "Main", "secret",
                    KEY));
            assertThat(added).as(String.valueOf(added)).containsEntry("_kind", "RES");
            String keyId = (String) map(added.get("key")).get("keyId");
            assertThat(call("agent.bind", Map.of("agentId", "manager", "keyId", keyId, "model", MODEL)))
                    .containsEntry("_kind", "RES");
            assertThat(call("agent.access.set", m("agentId", "manager", "apps", m("notebook", true, "files", true,
                    "browser", true, "courier", false, "todos", true), "auto", m("notebook", null, "files", null,
                    "todos", false)))).containsEntry("_kind", "RES");
        }

        List<Map<String, Object>> thread() throws Exception {
            return list(call("agent.thread.get", Map.of("agentId", "manager")).get("messages"));
        }

        void close() throws Exception {
            if (rig != null) {
                rig.close();
            }
            if (process != null) {
                process.destroy();
                process.waitFor();
            }
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        provider = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        provider.createContext("/", this::answer);
        provider.start();
        a.open();
        b.open();
        a.setUp();
        b.setUp();
    }

    @AfterEach
    void tearDown() throws Exception {
        a.close();
        b.close();
        if (provider != null) {
            provider.stop(0);
        }
    }

    // ---------------------------------------------------------------- the office

    /**
     * One pass from {@code from} to {@code to}, as the Desk app's carrier does it: take, deliver each in order, done.
     * A transport failure stops the pass with no {@code done} for what wasn't delivered. @return how many it delivered
     */
    private int carry(Desk from, Desk to) throws Exception {
        Map<String, Object> taken = from.call(DeskMethods.TAKE, m("toDeskId", to.deskId));
        if (!"RES".equals(taken.get("_kind"))) {
            return 0;
        }
        List<Map<String, Object>> results = new ArrayList<>();
        for (Map<String, Object> e : list(taken.get("envelopes"))) {
            long started = System.nanoTime();
            Map<String, Object> answer = to.call(DeskMethods.DELIVER, m("envelope", e.get("envelope")));
            deliverMs.add((System.nanoTime() - started) / 1_000_000.0);
            if ("RES".equals(answer.get("_kind"))) {
                results.add(m("id", e.get("id"), "outcome", answer.get("outcome")));
            } else if (List.of("bad_request", "forbidden", "conflict", "too_large").contains(answer.get("code"))) {
                results.add(m("id", e.get("id"), "outcome", "refused", "reason", map(answer.get("details")).get("reason")));
            } else {
                break; // unavailable: the rest waits for the next pass
            }
        }
        if (!results.isEmpty()) {
            assertThat(from.call(DeskMethods.DONE, m("results", results))).containsEntry("_kind", "RES");
        }
        return results.size();
    }

    private void settle() throws Exception {
        int moved;
        do {
            moved = carry(a, b) + carry(b, a);
        } while (moved > 0);
    }

    // ---------------------------------------------------------------- the stand-in model

    private void answer(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        byte[] body;
        if (!KEY.equals(exchange.getRequestHeaders().getFirst("x-api-key"))) {
            body = "{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(401, body.length);
        } else if (path.endsWith("/v1/models")) {
            body = ("{\"data\":[{\"id\":\"" + MODEL + "\",\"display_name\":\"Claude Sonnet 5.5\"}],\"has_more\":false}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
        } else {
            String request = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            requests.add(request);
            String reply;
            if (request.contains(B_RUN)) {
                // Desk B's agent answering desk A's.
                reply = text("Two meetings: 10:00 and 15:00.");
            } else if (request.contains("\"tool_result\"")) {
                reply = text("Work has two meetings.");
            } else if (request.contains("\"desk_message\"")) {
                reply = call("desk_message", "{\"desk\":\"Work\",\"text\":\"What's on today?\"}");
            } else {
                reply = text("Hello.");
            }
            body = reply.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("content-type", "text/event-stream");
            exchange.sendResponseHeaders(200, body.length);
        }
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(body);
        }
        exchange.close();
    }

    private static String event(String type, Map<String, Object> data) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("type", type);
        d.putAll(data);
        return "event: " + type + "\ndata: " + new String(Json.bytes(d), StandardCharsets.UTF_8) + "\n\n";
    }

    private static String start() {
        return event("message_start", Map.of("message", Map.of("model", MODEL, "usage", Map.of("input_tokens", 100,
                "output_tokens", 1))));
    }

    private static String end(String stop) {
        return event("message_delta", Map.of("delta", Map.of("stop_reason", stop), "usage", Map.of("output_tokens", 20)))
                + event("message_stop", Map.of());
    }

    private static String call(String tool, String inputJson) {
        return start() + event("content_block_start", Map.of("index", 0, "content_block", Map.of("type", "tool_use",
                "id", "toolu_" + System.nanoTime(), "name", tool, "input", Map.of())))
                + event("content_block_delta", Map.of("index", 0, "delta", Map.of("type", "input_json_delta",
                        "partial_json", inputJson)))
                + event("content_block_stop", Map.of("index", 0)) + end("tool_use");
    }

    private static String text(String words) {
        return start() + event("content_block_start", Map.of("index", 0, "content_block", Map.of("type", "text", "text",
                ""))) + event("content_block_delta", Map.of("index", 0, "delta", Map.of("type", "text_delta", "text",
                words))) + event("content_block_stop", Map.of("index", 0)) + end("end_turn");
    }

    // ---------------------------------------------------------------- the run

    private String pair() throws Exception {
        Map<String, Object> set = a.call("agent.access.set", m("agentId", "manager", "desks", List.of(m("deskId",
                b.deskId, "deskName", "Work", "on", true))));
        assertThat(set).as(String.valueOf(set)).containsEntry("_kind", "RES");
        String grantId = (String) list(map(set.get("access")).get("desks")).get(0).get("grantId");
        await().atMost(Duration.ofSeconds(10)).until(() -> carry(a, b) > 0);
        Map<String, Object> offers = b.call(DeskMethods.LIST, Map.of());
        assertThat(list(offers.get("offers"))).singleElement().satisfies(o -> assertThat(o)
                .containsEntry("grantId", grantId).containsEntry("fromDeskId", a.deskId));
        assertThat(b.call(DeskMethods.ANSWER, m("grantId", grantId, "allow", true, "agentId", "manager")))
                .containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).until(() -> carry(b, a) > 0);
        Map<String, Object> access = map(a.call("agent.access.get", Map.of("agentId", "manager")).get("access"));
        assertThat(list(access.get("desks"))).singleElement().satisfies(h -> assertThat(h).containsEntry("state",
                "active"));
        assertThat(a.messaging.grants().half(grantId).active()).isTrue();
        assertThat(b.messaging.grants().half(grantId).active()).isTrue();
        return grantId;
    }

    private boolean replied(Desk desk, String words) throws Exception {
        return desk.thread().stream().anyMatch(m -> "done".equals(m.get("state")) && words.equals(m.get("text")));
    }

    @Test
    void twoRealDesksPairMessageAnswerSurviveARestartAndAStop() throws Exception {
        String grantId = pair();

        // A message and its answer, within the wait, through the real desk-agents and both deskds' envelopes.
        assertThat(a.call("agent.message.send", Map.of("agentId", "manager", "text", "Ask Work what's on.")))
                .containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(30)).until(() -> {
            settle();
            return replied(a, "Work has two meetings.");
        });
        assertThat(requests).anyMatch(r -> r.contains("Two meetings: 10:00 and 15:00.") && r.contains("tool_result"));
        assertThat(b.thread()).anySatisfy(m -> assertThat(m.get("origin")).isNotNull()
                .satisfies(o -> assertThat(map(o)).containsEntry("kind", "desk").containsEntry("role", "message")));

        // Desk B's desk-agent is down while the office carries: the envelope waits, then goes once.
        int bRunsBefore = (int) requests.stream().filter(r -> r.contains(B_RUN)).count();
        b.kill();
        assertThat(a.call("agent.message.send", Map.of("agentId", "manager", "text", "Ask Work again.")))
                .containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).until(() -> !list(a.call(DeskMethods.TAKE, m("toDeskId", b.deskId))
                .get("envelopes")).isEmpty());
        assertThat(carry(a, b)).isZero();
        b.start();
        await().atMost(Duration.ofSeconds(60)).until(() -> {
            settle();
            return replied(a, "Work has two meetings.")
                    && a.thread().stream().filter(m -> "Work has two meetings.".equals(m.get("text"))).count() == 2;
        });
        // The office tries every envelope again: each counts once on B.
        for (int i = 0; i < 3; i++) {
            settle();
        }
        long bRuns = requests.stream().filter(r -> r.contains(B_RUN)).count();
        assertThat(bRuns).isEqualTo(bRunsBefore + 1);

        // B's member stops it: the very next message is refused there, and A's thread says so.
        assertThat(b.call("agent.desks.revoke", m("grantId", grantId))).containsEntry("_kind", "RES");
        assertThat(b.messaging.grants().half(grantId).revoked()).isTrue();
        DeskMessaging.Made held = a.messaging.message("manager", "Lead", b.deskId, "sent before A heard of the Stop");
        Map<String, Object> refused = b.call(DeskMethods.DELIVER, m("envelope", Json.parseObject(Json.bytes(
                held.envelope()))));
        assertThat(refused).containsEntry("code", "forbidden");
        assertThat(map(refused.get("details"))).containsEntry("reason", "revoked");
        // B's revoke reaches A: A's half goes, and its agent has no desk_message from its next step.
        await().atMost(Duration.ofSeconds(10)).until(() -> {
            settle();
            return a.messaging.grants().half(grantId).revoked();
        });
        await().atMost(Duration.ofSeconds(10)).until(() -> list(map(a.call("agent.access.get", Map.of("agentId",
                "manager")).get("access")).get("desks")).isEmpty());
        // §17: a message reaches a running desk within 500 ms of the office taking it (each delivery here: deskd's
        // open and checks, and desk-agent's transaction, over real sockets).
        List<Double> sorted = deliverMs.stream().sorted().toList();
        double p95 = sorted.get((int) Math.ceil(sorted.size() * 0.95) - 1);
        assertThat(p95).as("p95 of %s deliveries, ms", sorted.size()).isLessThan(500);
        assertThat(Files.readString(a.dir().resolve("desk-agent.log"))).doesNotContain("What's on today?");
        assertThat(Files.readString(b.dir().resolve("desk-agent.log"))).doesNotContain("Two meetings");
    }

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Object value) {
        return (List<Map<String, Object>>) value;
    }
}
