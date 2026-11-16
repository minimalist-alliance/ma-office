package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.todo.TodoModule;
import com.minimalistalliance.desk.deskd.tools.TodoTools;
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
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * To-do's agent tools end to end across the two processes (API.md §22; the draft ADR's §13, §15 and §17): the real
 * desk-agent jar on a real Unix socket, with its real registry, policy and gate; deskd's real relay, {@code ToolHost},
 * tickets, access record, run ledger and {@code TodoTools} on a real {@code todo.db}; the member's {@code todo.*} on the
 * same session; and a stand-in for Anthropic's Messages API on loopback. A member's message, the model's
 * {@code todo_add} from it, done without asking under the member's switch (deskd's group and its own record of the
 * switch and of the run the member started) or asked on a card with it off and run once on the member's yes; a source the
 * run never read refused with no card. {@code verify} skips it unless {@code DESK_AGENT_JAR} names desk-agent's jar.
 */
@EnabledIfEnvironmentVariable(named = "DESK_AGENT_JAR", matches = ".+")
@SuppressWarnings("unchecked")
class RealDeskAgentTodoIT {

    /** A stand-in's key, in Anthropic's shape. Nothing real. */
    private static final String KEY = "sk-ant-api03-stand-in-key-0001";
    private static final String MODEL = "claude-sonnet-5-5";

    @TempDir
    Path dir;

    private HttpServer provider;
    /** What the model does at each step: given the request's JSON, the stream to answer with. */
    private final AtomicReference<Function<String, String>> script = new AtomicReference<>();
    private final ConcurrentLinkedQueue<String> requests = new ConcurrentLinkedQueue<>();
    private Process deskAgent;
    private AgentRig rig;
    private TodoModule todo;
    private ToolHost host;
    private TestClient owner;

    void start(boolean todosWithoutAsking) throws Exception {
        provider = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        provider.createContext("/", this::answer);
        provider.start();
        // deskd first, wired as DataPlaneConfiguration wires it, so desk-agent's first connection hears the tools.
        rig = new AgentRig(dir, false);
        rig.module.keepAccessIn(Files.createDirectories(dir.resolve("desk")));
        todo = new TodoModule(rig.dispatcher, rig.hub, dir.resolve("desk"), () -> false,
                () -> java.time.ZoneId.of("America/Denver"), rig.clock);
        host = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
        host.agentApps(rig.module.accessRecord());
        host.access(rig.module.accessRecord());
        host.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
            var redeemed = rig.module.approvalTickets().redeem(approvalId, sha256, agentId, runId, tool, context, args);
            return redeemed.ok() ? null : redeemed.refusal().code();
        });
        host.area(HostedDecls.TODO, new TodoTools(todo::store));
        rig.module.onMemberRun(host.ledger()::memberStarted);
        rig.module.hostTools(host);
        Files.createDirectories(dir.resolve("agent-data"));
        int uid = (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        String url = "http://127.0.0.1:" + provider.getAddress().getPort();
        List<String> command = new ArrayList<>(List.of(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-jar", System.getenv("DESK_AGENT_JAR"),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.admin.socket=" + dir.resolve("agent-admin.sock"),
                "--desk.agent.data.dir=" + dir.resolve("agent-data"),
                "--desk.agent.peer.uid=" + uid,
                "--desk.agent.anthropic.url=" + url, "--desk.agent.openai.url=" + url, "--desk.agent.xai.url=" + url));
        deskAgent = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(dir.resolve("desk-agent.log")
                .toFile()).start();
        await().atMost(Duration.ofSeconds(60)).until(() -> rig.module.link().isConnected() || !deskAgent.isAlive());
        assertThat(deskAgent.isAlive()).as("desk-agent started").isTrue();
        owner = rig.connect("a");
        Map<String, Object> added = rig.call(owner, "agent.key.add", Map.of("provider", "anthropic", "label", "Main",
                "secret", KEY));
        assertThat(added).as(String.valueOf(added)).containsEntry("_kind", "RES");
        String keyId = (String) ((Map<String, Object>) added.get("key")).get("keyId");
        Map<String, Object> bound = rig.call(owner, "agent.bind", Map.of("agentId", "manager", "keyId", keyId, "model",
                MODEL));
        assertThat(bound).as(String.valueOf(bound)).containsEntry("_kind", "RES");
        // The agent's setup screen, saved as the member does: To-dos on, and its switch as the test says.
        Map<String, Object> apps = new LinkedHashMap<>();
        apps.put("notebook", true);
        apps.put("files", true);
        apps.put("browser", true);
        apps.put("courier", false);
        apps.put("todos", true);
        Map<String, Object> auto = new LinkedHashMap<>();
        auto.put("notebook", null);
        auto.put("files", null);
        auto.put("todos", todosWithoutAsking);
        Map<String, Object> access = new LinkedHashMap<>();
        access.put("agentId", "manager");
        access.put("apps", apps);
        access.put("auto", auto);
        Map<String, Object> saved = rig.call(owner, "agent.access.set", access);
        assertThat(saved).as(String.valueOf(saved)).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.module.accessRecord().autoOn(Caller.THE_OWNER, "manager",
                "todos") == todosWithoutAsking);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (deskAgent != null) {
            deskAgent.destroy();
            deskAgent.waitFor();
        }
        if (todo != null) {
            todo.close();
        }
        if (provider != null) {
            provider.stop(0);
        }
    }

    // ---------------------------------------------------------------- the stand-in model

    private void answer(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        boolean keyOk = KEY.equals(exchange.getRequestHeaders().getFirst("x-api-key"));
        byte[] body;
        if (!keyOk) {
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
            Function<String, String> step = script.get();
            body = (step == null ? text("Nothing to do.") : step.apply(request)).getBytes(StandardCharsets.UTF_8);
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

    /** One step that calls these tools, each {@code [name, inputJson]}. */
    private static String calls(String[]... tools) {
        StringBuilder b = new StringBuilder(start());
        for (int i = 0; i < tools.length; i++) {
            b.append(event("content_block_start", Map.of("index", i, "content_block", Map.of("type", "tool_use", "id",
                    "toolu_" + i + "_" + System.nanoTime(), "name", tools[i][0], "input", Map.of()))));
            b.append(event("content_block_delta", Map.of("index", i, "delta", Map.of("type", "input_json_delta",
                    "partial_json", tools[i][1]))));
            b.append(event("content_block_stop", Map.of("index", i)));
        }
        return b.append(end("tool_use")).toString();
    }

    private static String text(String words) {
        return start() + event("content_block_start", Map.of("index", 0, "content_block", Map.of("type", "text", "text",
                ""))) + event("content_block_delta", Map.of("index", 0, "delta", Map.of("type", "text_delta", "text",
                words))) + event("content_block_stop", Map.of("index", 0)) + end("end_turn");
    }

    private static int count(String text, String part) {
        int n = 0;
        for (int at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length())) {
            n++;
        }
        return n;
    }

    /** The model calls {@code first} on a member's turn, then answers in words once a tool's result came back. */
    private void model(String first) {
        script.set(request -> request.contains("\"tool_result\"") ? text("Done.") : first);
    }

    // ---------------------------------------------------------------- helpers

    private List<Map<String, Object>> approvals(String state) throws Exception {
        Map<String, Object> res = rig.call(owner, "agent.approvals.list", Map.of("agentId", "manager", "state", state));
        assertThat(res).as(String.valueOf(res)).containsEntry("_kind", "RES");
        return (List<Map<String, Object>>) res.get("approvals");
    }

    private Map<String, Object> awaitCard() {
        AtomicReference<Map<String, Object>> card = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(30)).until(() -> {
            List<Map<String, Object>> pending = approvals("pending");
            if (pending.size() == 1) {
                card.set(pending.get(0));
                return true;
            }
            return false;
        });
        return card.get();
    }

    private static String sha(Map<String, Object> card) {
        return ToolHost.hash((String) card.get("agentId"), (String) card.get("runId"), (String) card.get("tool"),
                (String) card.get("context"), (Map<String, Object>) card.get("payload"));
    }

    private Map<String, Object> lastReply() throws Exception {
        Map<String, Object> res = rig.call(owner, "agent.thread.get", Map.of("agentId", "manager"));
        List<Map<String, Object>> messages = (List<Map<String, Object>>) res.get("messages");
        return messages.get(messages.size() - 1);
    }

    private Map<String, Object> awaitEnded() {
        AtomicReference<Map<String, Object>> reply = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(30)).until(() -> {
            Map<String, Object> last = lastReply();
            reply.set(last);
            return "assistant".equals(last.get("role")) && List.of("done", "failed", "stopped").contains(last.get("state"));
        });
        return reply.get();
    }

    private void send(String text) throws Exception {
        Map<String, Object> res = rig.call(owner, "agent.message.send", Map.of("agentId", "manager", "text", text));
        assertThat(res).as(String.valueOf(res)).containsEntry("_kind", "RES");
    }

    private List<Map<String, Object>> todos() throws Exception {
        Map<String, Object> res = rig.call(owner, "todo.list", Map.of("view", "open"));
        assertThat(res).as(String.valueOf(res)).containsEntry("_kind", "RES");
        return (List<Map<String, Object>>) res.get("items");
    }

    private static final String ADD = "{\"title\":\"Call the bank about the card\",\"source\":{\"kind\":\"agent_chat\","
            + "\"ref\":{}}}";

    // ---------------------------------------------------------------- the flows

    @Test
    void underTheMembersSwitchAnAddFromTheirOwnMessageRunsWithoutAskingOnce() throws Exception {
        start(true);
        model(calls(new String[] {"todo_add", ADD}));
        send("Remind me to call the bank about the card.");
        Map<String, Object> reply = awaitEnded();
        assertThat(reply.get("state")).as(String.valueOf(reply)).isEqualTo("done");
        assertThat(approvals("pending")).isEmpty();
        List<Map<String, Object>> items = todos();
        assertThat(items).hasSize(1);
        assertThat(items.get(0)).containsEntry("title", "Call the bank about the card").containsEntry("by", "agent:manager")
                .containsEntry("untrusted", false);
        assertThat((Map<String, Object>) items.get(0).get("source")).containsEntry("kind", "agent_chat")
                .containsEntry("label", "Your message to the agent");
        Map<String, Object> chip = ((List<Map<String, Object>>) reply.get("tools")).get(0);
        assertThat(chip).containsEntry("ok", true);
        assertThat(String.valueOf(chip.get("summary"))).isEqualTo("Added a to-do");
        // The model read deskd's answer, which names the item by id and never its text back.
        assertThat(requests).anyMatch(r -> r.contains("\\\"created\\\":true"));
        // The audit holds ids and hashes only.
        String rows = String.valueOf(rig.call(owner, "agent.audit.list", Map.of()).get("entries"));
        assertThat(rows).contains("tool.call").doesNotContain("Call the bank");
        assertThat(Files.readString(dir.resolve("desk-agent.log"))).doesNotContain("Call the bank");
    }

    @Test
    void withTheSwitchOffTheAddAsksAndRunsOnceOnTheMembersYes() throws Exception {
        start(false);
        model(calls(new String[] {"todo_add", ADD}));
        send("Remind me to call the bank about the card.");
        Map<String, Object> card = awaitCard();
        assertThat(card).containsEntry("tool", "todo_add").containsEntry("risk", "write");
        assertThat(card.get("title")).isEqualTo("Add “Call the bank about the card” to To-do");
        assertThat((Map<String, Object>) ((Map<String, Object>) card.get("payload")).get("source"))
                .containsEntry("kind", "agent_chat");
        assertThat(todos()).isEmpty();
        Map<String, Object> decided = rig.call(owner, "agent.approval.decide", Map.of("approvalId", card.get("id"),
                "approve", true, "sha256", sha(card)));
        assertThat(decided).as(String.valueOf(decided)).containsEntry("_kind", "RES");
        assertThat(awaitEnded().get("state")).isEqualTo("done");
        assertThat(todos()).hasSize(1);
        assertThat(rig.call(owner, "agent.approval.decide", Map.of("approvalId", card.get("id"), "approve", true,
                "sha256", sha(card)))).containsEntry("code", "conflict");
        assertThat(todos()).hasSize(1);
    }

    @Test
    void aSourceTheRunNeverReadIsRefusedWithNoCard() throws Exception {
        start(true);
        model(calls(new String[] {"todo_add", "{\"title\":\"Wire the deposit\",\"source\":{\"kind\":\"browser\","
                + "\"ref\":{\"url\":\"https://pay.example.com/now\"}}}"}));
        send("Anything to do?");
        assertThat(awaitEnded().get("state")).isEqualTo("done");
        assertThat(approvals("all")).isEmpty();
        assertThat(requests).anyMatch(r -> r.contains("Not allowed: source_unknown."));
        assertThat(todos()).isEmpty();
    }
}
