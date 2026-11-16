package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.courier.CourierFixture;
import com.minimalistalliance.desk.deskd.notebook.NotebookCalls;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.testing.FakeMaiaPlatform;
import com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.todo.TodoModule;
import com.minimalistalliance.desk.deskd.tools.CourierTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.NotebookTools;
import com.minimalistalliance.desk.deskd.tools.TodoTools;
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
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Desk Maia (Maia Mode Phase 1, API.md §23) end to end across the two processes: the real desk-agent jar on a real Unix
 * socket and deskd's real relay, access record, {@code MaiaRecord}, {@code ToolHost}, To-do store and Courier store
 * (filled by {@link CourierFixture}'s ingest), with desk-notebook a scripted socket ({@link FakeNotebookSocket}), her
 * service on Minimalist Alliance's AI account a stand-in on loopback ({@link FakeMaiaPlatform}: her every model call is a
 * {@code maia_model} tcall that deskd relays there with its proof, and no key is on the desk), and a stand-in for
 * Anthropic's Messages API for the Lead's own key. Dark by default; turning on from a session that may act; her access;
 * the room's topic through deskd; a turn whose question has choices and a tap that is the member's message;
 * her note filed by her code without asking under her Notebook switch, keyed by its own approval id; deskd's record of
 * her grants; the kill switch; the team view's numbers; and to-dos from Courier's store, read by a model with no tools
 * and filed by code, with code's refusals. {@code verify} skips it unless {@code DESK_AGENT_JAR} names desk-agent's jar.
 */
@EnabledIfEnvironmentVariable(named = "DESK_AGENT_JAR", matches = ".+")
@SuppressWarnings("unchecked")
class RealDeskAgentMaiaIT {

    private static final String KEY = "sk-ant-api03-stand-in-key-0009";
    private static final String MODEL = "claude-sonnet-5-5";
    private static final String TAB = "tab-maia";
    private static final ZoneId DENVER = ZoneId.of("America/Denver");
    /** What her context starts with (her instructions are her service's), the note-taker's rules, the to-do reader's. */
    private static final String MAIA = "The member's home desk adds";
    private static final String TAKER = "You take notes";
    private static final String READER = "You read a batch of email";

    @TempDir
    Path dir;

    private HttpServer provider;
    private final ConcurrentLinkedQueue<String> requests = new ConcurrentLinkedQueue<>();
    /** What the model answers, given the request's JSON. */
    private final AtomicReference<Function<String, String>> script = new AtomicReference<>();
    private Process deskAgent;
    private AgentRig rig;
    private TodoModule todo;
    private CourierFixture courier;
    private FakeNotebookSocket notebook;
    private final List<Map<String, Object>> edits = new CopyOnWriteArrayList<>();
    private TestClient owner;
    private String keyId;
    private FakeMaiaPlatform platform;

    @BeforeEach
    void open() throws Exception {
        provider = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        provider.createContext("/", this::answer);
        provider.start();
        notebook = new FakeNotebookSocket(dir.resolve("notebook.sock"));
        notebook.handlers.put("notebook.page.agentEdit", p -> {
            edits.add(new LinkedHashMap<>(p));
            String page = p.get("pageId") instanceof String id ? id : "pg-from-maia-1";
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("pageId", page);
            r.put("title", p.get("new") instanceof Map<?, ?> made ? made.get("title") : "Work");
            r.put("op", p.get("op"));
            r.put("tabId", TAB);
            if (Boolean.TRUE.equals(p.get("dryRun"))) {
                r.put("dryRun", true);
            } else {
                r.put("versionId", "v-1");
            }
            return r;
        });
        courier = new CourierFixture(dir.resolve("courier"));
        rig = new AgentRig(dir, false);
        rig.module.keepAccessIn(Files.createDirectories(dir.resolve("desk")));
        todo = new TodoModule(rig.dispatcher, rig.hub, dir.resolve("desk"), () -> false, () -> DENVER, rig.clock);
        ToolHost host = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
        host.agentApps(rig.module.accessRecord());
        host.access(rig.module.accessRecord());
        host.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
            var redeemed = rig.module.approvalTickets().redeem(approvalId, sha256, agentId, runId, tool, context, args);
            return redeemed.ok() ? null : redeemed.refusal().code();
        });
        host.area(HostedDecls.TODO, new TodoTools(todo::store));
        host.area(HostedDecls.NOTEBOOK, new NotebookTools(new NotebookCalls(notebook.socket(), () -> null,
                Duration.ofSeconds(5)), () -> false));
        host.area(HostedDecls.COURIER, new CourierTools(courier.reads(), () -> DENVER, courier.clock()));
        rig.module.onMemberRun(host.ledger()::memberStarted);
        rig.module.hostTools(host);
        // Her model, as DataPlaneConfiguration wires it: relayed to her service, refused by deskd's own facts first.
        platform = new FakeMaiaPlatform();
        rig.module.maiaModel(new MaiaModel(platform.client(java.time.Clock.systemUTC()), () -> false,
                () -> rig.band == AgeBand.Band.ADULT, () -> false));
        Files.createDirectories(dir.resolve("agent-data"));
        // This desk is listed for Maia Mode (API.md §23: the switch says on, as the owner's desk's rollout writes it).
        Files.writeString(dir.resolve("agent-data").resolve("maia-switch"), "on\n");
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
    }

    /** The member's own key, for the Lead: Maia needs none. */
    private String key() throws Exception {
        if (keyId == null) {
            Map<String, Object> added = rig.call(owner, "agent.key.add", Map.of("provider", "anthropic", "label", "Main",
                    "secret", KEY));
            assertThat(added).as(String.valueOf(added)).containsEntry("_kind", "RES");
            keyId = (String) ((Map<String, Object>) added.get("key")).get("keyId");
        }
        return keyId;
    }

    @AfterEach
    void tearDown(org.junit.jupiter.api.TestInfo info) throws Exception {
        if (Files.exists(dir.resolve("desk-agent.log"))) {
            // Kept beside the build for a failure's reading: the stand-in's words only, never a real key or content.
            Path logs = Files.createDirectories(Path.of("target", "maia-it-logs"));
            Files.copy(dir.resolve("desk-agent.log"), logs.resolve(info.getTestMethod().map(
                    java.lang.reflect.Method::getName).orElse("x") + ".log"),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
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
        if (courier != null) {
            courier.close();
        }
        if (notebook != null) {
            notebook.close();
        }
        if (provider != null) {
            provider.stop(0);
        }
        if (platform != null) {
            platform.close();
        }
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

    private long requestsWith(String part) {
        return requests.stream().filter(r -> r.contains(part)).count();
    }

    // ---------------------------------------------------------------- helpers

    private Map<String, Object> res(TestClient client, String method, Map<String, Object> params) throws Exception {
        Map<String, Object> r = rig.call(client, method, params);
        assertThat(r).as(method + " " + r).containsEntry("_kind", "RES");
        return r;
    }

    private Map<String, Object> err(TestClient client, String method, Map<String, Object> params) throws Exception {
        Map<String, Object> r = rig.call(client, method, params);
        assertThat(r).as(method + " " + r).containsEntry("_kind", "ERR");
        return r;
    }

    private static Map<String, Object> details(Map<String, Object> err) {
        return (Map<String, Object>) err.get("details");
    }

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    /** Maia Mode on and her access saved, as the room's first-run sheet does. She needs no key. */
    private void turnOn() throws Exception {
        Map<String, Object> on = res(owner, "agent.maia.set", m("on", true, "disclosure", "maia-mode-v2",
                "notesTabId", TAB, "homeDeskId", "d-home1"));
        assertThat((Map<String, Object>) on.get("maia")).containsEntry("on", true);
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.module.maiaRecord().on());
        res(owner, "agent.access.set", m("agentId", "maia", "apps", m("notebook", true, "files", false, "browser",
                false, "courier", false, "todos", true), "auto", m("notebook", m("tabId", TAB), "files", null, "todos",
                true)));
        await().atMost(Duration.ofSeconds(10)).until(() -> TAB.equals(rig.module.accessRecord().place("maia",
                "notebook")));
    }

    private List<Map<String, Object>> thread(String agentId) throws Exception {
        return (List<Map<String, Object>>) res(owner, "agent.thread.get", m("agentId", agentId)).get("messages");
    }

    private Map<String, Object> awaitReply(String agentId, int size) {
        AtomicReference<Map<String, Object>> last = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(30)).until(() -> {
            List<Map<String, Object>> t = thread(agentId);
            if (t.size() < size) {
                return false;
            }
            Map<String, Object> m = t.get(t.size() - 1);
            last.set(m);
            return "assistant".equals(m.get("role")) && List.of("done", "failed", "stopped").contains(m.get("state"));
        });
        return last.get();
    }

    /** The newest {@code agent.maia} snapshot this session has had within the wait that {@code until} accepts. */
    private Map<String, Object> roomUntil(TestClient client, java.util.function.Predicate<Map<String, Object>> until)
            throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos();
        while (System.nanoTime() < deadline) {
            Frame frame = rig.rtcFake.pollFrame(client.handle(), Channels.EVENTS, 500);
            if (frame == null) {
                continue;
            }
            byte[] payload = frame.payload();
            while (frame.more()) {
                frame = rig.rtcFake.awaitFrame(client.handle(), Channels.EVENTS);
                byte[] joined = new byte[payload.length + frame.payload().length];
                System.arraycopy(payload, 0, joined, 0, payload.length);
                System.arraycopy(frame.payload(), 0, joined, payload.length, frame.payload().length);
                payload = joined;
            }
            Map<String, Object> evt = TestClient.parse(payload);
            if ("snapshot".equals(evt.get("type")) && evt.get("data") instanceof Map<?, ?> room
                    && until.test((Map<String, Object>) room)) {
                return (Map<String, Object>) room;
            }
        }
        throw new AssertionError("no agent.maia snapshot came");
    }

    /** A session with video and no input: a viewer, who may watch but not act. */
    private TestClient viewer(String sessionId) throws Exception {
        String fingerprint = String.format("%02x", 40).repeat(32);
        SessionGrant grant = new SessionGrant("user-1", "sid-" + sessionId, "owner", fingerprint, true, false,
                Instant.now(), Instant.now().plus(Duration.ofHours(1)));
        return rig.connect(sessionId, grant);
    }

    // ---------------------------------------------------------------- the flows

    @Test
    void darkByDefaultThenOnFromASessionThatMayActWithTheRoomThroughDeskd() throws Exception {
        Map<String, Object> got = (Map<String, Object>) res(owner, "agent.maia.get", Map.of()).get("maia");
        assertThat(got).containsEntry("on", false).containsEntry("killed", false);
        assertThat(details(err(owner, "agent.maia.observe", m("desks", List.of())))).containsEntry("reason",
                "maia_off");
        assertThat(rig.module.maiaRecord().on()).isFalse();
        // A viewer can't turn it on: deskd refuses before desk-agent hears.
        TestClient watching = viewer("v");
        Map<String, Object> refused = rig.call(watching, "agent.maia.set", m("on", true, "disclosure",
                "maia-mode-v2"), UUID.randomUUID().toString());
        assertThat(refused).containsEntry("code", "forbidden");
        assertThat(details(refused)).containsEntry("reason", "permission");
        assertThat(rig.module.maiaRecord().on()).isFalse();
        // Without the disclosure it stays off.
        assertThat(details(err(owner, "agent.maia.set", m("on", true)))).containsEntry("reason", "disclosure");

        turnOn();
        // The room's topic through deskd: the office's picture makes a list of at most 3, at most 1 now.
        TestClient room = rig.connect("room");
        room.subscribe("agent.maia", null);
        long now = System.currentTimeMillis();
        res(owner, "agent.maia.observe", m("desks", List.of(
                m("deskId", "d-work1", "name", "Work", "kind", "work", "state", "running", "link", "open",
                        "agents", List.of(m("agentId", "ag-scout", "name", "Scout", "status", "working")),
                        "approvals", List.of(m("approvalId", "ap-1", "agentId", "ag-scout", "expiresAt",
                                now + 20 * 60_000L)),
                        "stopped", List.of(m("agentId", "ag-scout", "reason", "limit_reached", "at", now)),
                        "todo", m("newFromAgents", 2)),
                m("deskId", "d-pers1", "name", "Personal", "kind", "personal", "state", "failed", "link", "open")),
                "typing", false));
        Map<String, Object> snap = roomUntil(room, r -> ((Map<String, Object>) r.get("status")).get("desks")
                .equals(2));
        Map<String, Object> list = (Map<String, Object>) snap.get("todo");
        List<Map<String, Object>> items = (List<Map<String, Object>>) list.get("items");
        assertThat(items).hasSizeLessThanOrEqualTo(3).isNotEmpty();
        assertThat(items.stream().filter(i -> "now".equals(i.get("urgency")))).hasSize(1);
        assertThat(((Map<String, Object>) snap.get("status")).get("line"))
                .isEqualTo("Watching 2 desks · 1 agent · 1 working");
        // Her allowance, never money (Nov 15): no spend in dollars on the room's stream.
        assertThat(snap).containsKey("allowance").doesNotContainKey("spend").containsKey("foot").containsEntry("on",
                true);
        // Her own usage is never money; the foot's briefs line is the member's own keys (the wallet), in dollars.
        assertThat(String.valueOf(snap.get("allowance"))).doesNotContain("$").doesNotContain("Usd");
        // A viewer can't subscribe to it as another member, and an export session gets scope.
        TestClient export = rig.connect("x", "export");
        Map<String, Object> sub = export.subscribe("agent.maia", null);
        assertThat(sub).containsEntry("_kind", "ERR");
    }

    @Test
    void aTurnWithChoicesATapThatIsTheMembersMessageAndHerNoteFiledByCode() throws Exception {
        turnOn();
        platform.script.set(request -> {
            String json = new String(Json.bytes(request), StandardCharsets.UTF_8);
            if ("notes".equals(request.get("task"))) {
                // The note-taker's small job: one note for Work, from the member's own words.
                return FakeMaiaPlatform.text("{\"notes\": [{\"text\": \"The Acme renewal is due Friday\", \"area\":"
                        + " \"work\", \"kind\": \"reminder\", \"due\": null}]}");
            }
            if (json.contains("Which laptops should I compare?")) {
                // Her next run, after the tap: her last reply is in its thread.
                return FakeMaiaPlatform.text("On it.");
            }
            if ("step".equals(request.get("task"))) {
                return FakeMaiaPlatform.text("Which laptops should I compare?");
            }
            return FakeMaiaPlatform.call("ask_member", Map.of("question", "Which laptops?", "choices",
                    List.of("Three under $1,000", "Only ultralights")));
        });
        res(owner, "agent.message.send", m("agentId", "maia", "text",
                "Remember the Acme renewal is due Friday. And compare some laptops."));
        Map<String, Object> reply = awaitReply("maia", 2);
        assertThat(reply.get("state")).as(String.valueOf(reply)).isEqualTo("done");
        assertThat(reply.get("text")).isEqualTo("Which laptops should I compare?");
        Map<String, Object> choices = (Map<String, Object>) reply.get("choices");
        assertThat(choices).as(String.valueOf(reply)).containsEntry("state", "open").containsEntry("other", true);
        assertThat((List<Map<String, Object>>) choices.get("options")).extracting(o -> o.get("label"))
                .containsExactly("Three under $1,000", "Only ultralights");
        // Her own tools only: the request offered no Files, Browser, Notebook or Courier tool. It went to her service,
        // never to a provider with a member's key.
        String first = platform.bodies.stream().filter(r -> r.contains(MAIA)).findFirst().orElseThrow();
        assertThat(first).contains("\"ask_member\"").contains("\"office_desks\"").doesNotContain("\"files_read\"")
                .doesNotContain("\"notebook_write\"").doesNotContain("\"courier_new\"")
                .doesNotContain("\"browser_open\"");
        assertThat(requests).isEmpty();

        // Her note: the taker read the member's words only, and her code filed it under her switch, keyed by its own
        // approval id, in the From Maia tab, with the chip on her reply.
        await().atMost(Duration.ofSeconds(30)).until(() -> {
            Map<String, Object> last = thread("maia").stream().filter(x -> reply.get("id").equals(x.get("id")))
                    .findFirst().orElseThrow();
            return last.get("notes") instanceof List<?> l && !l.isEmpty()
                    && "filed".equals(((Map<String, Object>) l.get(0)).get("state"));
        });
        Map<String, Object> filed = thread("maia").stream().filter(x -> reply.get("id").equals(x.get("id")))
                .findFirst().orElseThrow();
        Map<String, Object> chip = ((List<Map<String, Object>>) filed.get("notes")).get(0);
        assertThat(chip).containsEntry("area", "work").containsEntry("line", "Noted for Work");
        String approvalId = (String) chip.get("approvalId");
        assertThat(approvalId).matches("ap-[a-z2-7]{20}");
        String taker = platform.bodies.stream().filter(r -> r.contains(TAKER)).findFirst().orElseThrow();
        assertThat(taker).contains("\"task\":\"notes\"").contains("Acme renewal")
                .doesNotContain("Which laptops should I compare?").contains("\"tools\":[]");
        Map<String, Object> edit = edits.stream().filter(e -> !Boolean.TRUE.equals(e.get("dryRun"))).findFirst()
                .orElseThrow();
        assertThat(edit).containsEntry("op", "create").containsEntry("key", "auto:" + approvalId)
                .containsEntry("tab", TAB);
        assertThat((Map<String, Object>) edit.get("new")).containsEntry("tabId", TAB);
        assertThat(String.valueOf(edit.get("markdown"))).contains("Acme renewal");
        Map<String, Object> row = (Map<String, Object>) res(owner, "agent.approval.get", m("approvalId", approvalId))
                .get("approval");
        assertThat(row).containsEntry("decidedBy", "auto").containsEntry("state", "done");
        // No card came for any of it.
        assertThat((List<?>) res(owner, "agent.approvals.list", m("agentId", "maia")).get("approvals")).isEmpty();

        // The tap: a member's message, exactly the label, starting her next run.
        Map<String, Object> tapped = res(owner, "agent.maia.choose", m("messageId", reply.get("id"), "choiceId", "c1"));
        assertThat(tapped).containsKey("runId");
        Map<String, Object> next = awaitReply("maia", 4);
        assertThat(next.get("text")).isEqualTo("On it.");
        List<Map<String, Object>> t = thread("maia");
        assertThat(t.get(t.size() - 2)).containsEntry("role", "user").containsEntry("text", "Three under $1,000");
        Map<String, Object> counts = (Map<String, Object>) res(owner, "agent.maia.choices.get", Map.of())
                .get("choices");
        assertThat(((Number) counts.get("tapped")).intValue()).isEqualTo(1);
        assertThat(((Number) counts.get("offered")).intValue()).isEqualTo(1);
        // A viewer can't tap.
        assertThat(rig.call(viewer("v2"), "agent.maia.choose", m("messageId", reply.get("id"), "choiceId", "c2"),
                UUID.randomUUID().toString())).containsEntry("code", "forbidden");
        // The audit holds ids only; desk-agent's log no note text.
        String audit = String.valueOf(res(owner, "agent.audit.list", m("limit", 200)).get("entries"));
        assertThat(audit).contains("maia.note").doesNotContain("Acme");
        assertThat(Files.readString(dir.resolve("desk-agent.log"))).doesNotContain("Acme");

        // The team view: her calls today, from this desk's ledger, counts only: her calls are the company's, so her
        // dollars are 0 (Nov 15).
        Map<String, Object> summary = res(owner, "agent.usage.summary", m("days", 7));
        List<Map<String, Object>> agents = (List<Map<String, Object>>) summary.get("agents");
        Map<String, Object> hers = agents.stream().filter(a -> "maia".equals(a.get("agentId"))).findFirst()
                .orElseThrow();
        List<Map<String, Object>> days = (List<Map<String, Object>>) hers.get("days");
        assertThat(days).hasSize(7);
        Map<String, Object> today = days.get(6);
        assertThat(((Number) today.get("calls")).intValue()).isGreaterThanOrEqualTo(3);
        assertThat(((Number) today.get("spendMicroUsd")).longValue()).isZero();
        assertThat(((Number) today.get("tasksDone")).intValue()).isEqualTo(2);
        assertThat(String.valueOf(summary)).doesNotContain("laptop").doesNotContain("Acme");
    }

    @Test
    void deskdRecordsHerGrantsAndTheKillSwitchStopsHerThroughTheRelay() throws Exception {
        turnOn();
        Map<String, Object> grant = (Map<String, Object>) res(owner, "agent.maia.grant.set", m("deskId", "d-work1",
                "deskName", "Work", "scopes", List.of("brief", "show"), "days", 7, "keepsToItself", true)).get("grant");
        assertThat(grant).containsEntry("deskId", "d-work1").containsEntry("keepsToItself", true);
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.module.maiaRecord().mayBrief("d-work1"));
        assertThat(rig.module.maiaRecord().keepsToItself("d-work1")).isTrue();
        // Scopes outside brief and show are refused, and change nothing in deskd's record.
        assertThat(err(owner, "agent.maia.grant.set", m("deskId", "d-pers1", "deskName", "Personal", "scopes",
                List.of("approve")))).containsEntry("code", "bad_request");
        assertThat(rig.module.maiaRecord().mayBrief("d-pers1")).isFalse();
        res(owner, "agent.maia.grant.revoke", m("deskId", "d-work1"));
        assertThat(rig.module.maiaRecord().mayBrief("d-work1")).isFalse();
        // Turning it off takes every grant at once, in deskd's record too.
        res(owner, "agent.maia.grant.set", m("deskId", "d-work1", "deskName", "Work", "scopes", List.of("brief")));
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.module.maiaRecord().mayBrief("d-work1"));
        res(owner, "agent.maia.set", m("on", false));
        assertThat(rig.module.maiaRecord().on()).isFalse();
        assertThat(rig.module.maiaRecord().mayBrief("d-work1")).isFalse();
        res(owner, "agent.maia.set", m("on", true));

        // The kill switch in desk-agent's data directory: off at once, whatever the member chose.
        Files.writeString(dir.resolve("agent-data").resolve("maia-switch"), "off\n");
        assertThat((Map<String, Object>) res(owner, "agent.maia.get", Map.of()).get("maia")).containsEntry("killed",
                true);
        assertThat(details(err(owner, "agent.maia.observe", m("desks", List.of())))).containsEntry("reason",
                "maia_off");
        assertThat(details(err(owner, "agent.message.send", m("agentId", "maia", "text", "hi"))))
                .containsEntry("reason", "maia_off");
        // No switch at all: this desk isn't listed, and Desk Maia is refused (the Platform's MMP-L1).
        Files.delete(dir.resolve("agent-data").resolve("maia-switch"));
        assertThat(details(err(owner, "agent.maia.observe", m("desks", List.of())))).containsEntry("reason",
                "not_listed");
        Files.writeString(dir.resolve("agent-data").resolve("maia-switch"), "on\n");
        res(owner, "agent.maia.observe", m("desks", List.of()));
    }

    // ---------------------------------------------------------------- her model, through deskd

    @Test
    void herTurnGoesThroughDeskdToHerServiceWithNoKeyOnTheDesk() throws Exception {
        turnOn();
        assertThat((List<?>) res(owner, "agent.key.list", Map.of()).get("keys")).isEmpty();
        // Nobody can bind her to anything else.
        Map<String, Object> bind = err(owner, "agent.bind", m("agentId", "maia", "keyId", "ma-maia", "model", MODEL));
        assertThat(details(bind)).containsEntry("reason", "company");
        platform.script.set(request -> "notes".equals(request.get("task")) ? FakeMaiaPlatform.text("{\"notes\": []}")
                : FakeMaiaPlatform.text("Hi. I'm on it."));
        res(owner, "agent.message.send", m("agentId", "maia", "text", "Hello Maia"));
        Map<String, Object> reply = awaitReply("maia", 2);
        assertThat(reply.get("state")).as(String.valueOf(reply)).isEqualTo("done");
        assertThat(reply.get("text")).isEqualTo("Hi. I'm on it.");
        // Her calls are the company's (contract 0.4.8): no dollar figure of hers on the desk, whatever the answer said,
        // and nothing on the member's own limits.
        assertThat(reply.get("costMicroUsd")).isNull();
        for (Object scope : (List<?>) res(owner, "agent.limits.get", m("agentId", "maia")).get("usage")) {
            assertThat(((Number) ((Map<?, ?>) scope).get("spentMicroUsd")).longValue()).isZero();
        }
        // Her service got the task and the desk's context with deskd's proof over the exact body; nothing else did.
        assertThat(platform.refusedProofs).isEmpty();
        Map<String, Object> turn = Json.parseObject(platform.bodies.stream().filter(b -> b.contains("\"task\":\"turn\""))
                .findFirst().orElseThrow().getBytes(StandardCharsets.UTF_8));
        assertThat(turn.keySet()).containsExactly("v", "task", "callId", "context", "messages", "tools",
                "maxOutputTokens", "units", "note");
        // Contract 0.4.8: she asks for credits, so her service's answer carries no dollars (MC-M1).
        assertThat(turn).containsEntry("units", "credits");
        assertThat((String) turn.get("context")).startsWith(MAIA).doesNotContain("You are Maia")
                .doesNotContain("own key").doesNotContain("Now: ").doesNotContain("Briefs left");
        // Contract 0.4.6: what changes on every call is her note, which her service sends after the thread.
        assertThat((String) turn.get("note")).startsWith("Now: ").contains("Briefs left today: ");
        assertThat(String.valueOf(turn.get("messages"))).contains("Hello Maia");
        assertThat(requests).as("no provider with a member's key was asked").isEmpty();

        // Her allowance used up: one reply that says when it resets, nothing billed, and nothing tried until then.
        String resets = Instant.now().plus(Duration.ofHours(6)).truncatedTo(java.time.temporal.ChronoUnit.SECONDS)
                .toString();
        platform.script.set(request -> FakeMaiaPlatform.refused(429, "limit", Map.of("reason", "limit_personal",
                "window", "day", "resetsAt", resets)));
        res(owner, "agent.message.send", m("agentId", "maia", "text", "Plan my week"));
        Map<String, Object> limited = awaitReply("maia", 4);
        assertThat(limited).containsEntry("state", "failed").containsEntry("errorDetail", "limit");
        assertThat((Map<String, Object>) limited.get("limit")).containsEntry("reason", "limit_personal")
                .containsEntry("window", "day").containsEntry("resetsAt", resets);
        res(owner, "agent.message.send", m("agentId", "maia", "text", "Please?"));
        Map<String, Object> again = awaitReply("maia", 6);
        assertThat(again).containsEntry("errorDetail", "limit");
        // Neither her turn nor her note-taker sent anything of it: refused on the desk until the reset.
        await().pollDelay(Duration.ofMillis(500)).atMost(Duration.ofSeconds(2)).until(() -> true);
        assertThat(platform.bodies).noneMatch(b -> b.contains("Please?"));
        // The turn after her first answer carried the member's credits in its note, never money.
        Map<String, Object> planned = Json.parseObject(platform.bodies.stream().filter(b -> b.contains("Plan my week"))
                .filter(b -> b.contains("\"task\":\"turn\"")).findFirst().orElseThrow()
                .getBytes(StandardCharsets.UTF_8));
        // Contract 0.4.10: the member's one wallet, shared with their agents.
        assertThat((String) planned.get("note")).contains("\nCredits: 1,760 left (1,550 of this month's 2,500, 210"
                + " starting), shared with the member's agents; this month's renew ")
                .contains("\nToday's and this week's shares are used, so this is coming from this month's.");
        // No dollar figure on any line of her own usage (her briefs' wallet lines are the member's own money).
        assertThat(((String) planned.get("note")).lines()
                .filter(l -> l.toLowerCase(java.util.Locale.ROOT).contains("credit") || l.contains("allowance")))
                .isNotEmpty().noneMatch(l -> l.contains("$"));
        assertThat(Files.readString(dir.resolve("desk-agent.log"))).doesNotContain("Hello Maia")
                .doesNotContain("Plan my week");
    }


    // ---------------------------------------------------------------- to-dos from Courier

    @Test
    void toDosFromCouriersStoreAreReadByAModelWithNoToolsAndFiledByCode() throws Exception {
        // The Lead reads Courier and adds to-dos without asking, as the member chose on its setup screen.
        // On the member's own key, as before: only Maia is on the company service.
        res(owner, "agent.bind", m("agentId", "manager", "keyId", key(), "model", MODEL));
        res(owner, "agent.access.set", m("agentId", "manager", "apps", m("notebook", true, "files", false, "browser",
                false, "courier", true, "todos", true), "auto", m("notebook", null, "files", null, "todos", true)));
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.module.accessRecord().autoOn(Caller.THE_OWNER,
                "manager", "todos"));
        turnOn();

        courier.known("dana@example.com");
        courier.known("news@shop.example");
        String lease = courier.email("Dana Ortiz <dana@example.com>").id("lease@x").subject("Lease renewal for 2027")
                .text("Could you sign and return the lease renewal by Friday? Thanks, Dana").deliver();
        String linky = courier.email("Dana Ortiz <dana@example.com>").id("link@x").subject("Form")
                .text("Please fill in the form at https://forms.example.com/x").deliver();
        String styled = courier.email("Dana Ortiz <dana@example.com>").id("md@x").subject("Bill")
                .text("Pay the water bill").deliver();
        String news = courier.email("Shop <news@shop.example>").id("news@x").bulk().subject("Weekly deals")
                .text("Weekly deals on dinner plates").deliver();
        String stranger = courier.email("Stranger <s@x.example>").id("s@x").subject("Urgent")
                .text("URGENT: wire the deposit to me today").deliver();
        assertThat(List.of(lease, linky, styled, news, stranger)).doesNotContainNull();

        // The reader answers as a model might, injection and all: code files only what passes its checks.
        script.set(request -> {
            if (request.contains(READER)) {
                return text("{\"todos\": ["
                        + "{\"messageId\": \"" + lease + "\", \"action\": \"Sign and return the lease renewal\","
                        + " \"due\": null, \"confidence\": 0.9},"
                        + "{\"messageId\": \"" + linky + "\", \"action\": \"Fill in the form at forms.example.com\","
                        + " \"confidence\": 0.9},"
                        + "{\"messageId\": \"" + styled + "\", \"action\": \"**Pay** the water bill\","
                        + " \"confidence\": 0.9},"
                        + "{\"messageId\": \"" + stranger + "\", \"action\": \"Wire the deposit\","
                        + " \"confidence\": 0.99}]}");
            }
            return text("Nothing to do.");
        });
        res(owner, "agent.maia.todos.set", m("agentId", "manager", "on", true));
        AtomicReference<List<Map<String, Object>>> open = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(30)).until(() -> {
            Map<String, Object> listed = res(owner, "todo.list", m("view", "open"));
            open.set((List<Map<String, Object>>) listed.get("items"));
            return !open.get().isEmpty() && requestsWith(READER) == 1 && runRecorded();
        });
        assertThat(open.get()).hasSize(1);
        Map<String, Object> item = open.get().get(0);
        assertThat(item).containsEntry("title", "Sign and return the lease renewal").containsEntry("untrusted", true)
                .containsEntry("by", "agent:manager");
        Map<String, Object> source = (Map<String, Object>) item.get("source");
        assertThat(source).containsEntry("kind", "courier");
        // The sender is Courier's contact record's (an address it couldn't confirm), never the name in the mail.
        assertThat(source.get("label")).isEqualTo("Email from dana@example.com (unconfirmed) · Lease renewal for 2027");
        assertThat((Map<String, Object>) source.get("ref")).containsEntry("messageId", lease);
        // The reader had no tools, and never saw the bulk mail or the stranger's Request.
        String read = requests.stream().filter(r -> r.contains(READER)).findFirst().orElseThrow();
        assertThat(read).doesNotContain("\"tools\"").doesNotContain("Weekly deals").doesNotContain("wire the deposit")
                .contains("lease renewal").contains("Untrusted content from Courier");

        // A second run reads nothing new: the cursor moved at the first run's end.
        res(owner, "agent.maia.todos.set", m("agentId", "manager", "on", true));
        await().atMost(Duration.ofSeconds(30)).until(() -> runs() >= 2);
        assertThat(requestsWith(READER)).isEqualTo(1);
        assertThat((List<?>) res(owner, "todo.list", m("view", "open")).get("items")).hasSize(1);
        // No card was asked for any of it.
        assertThat((List<?>) res(owner, "agent.approvals.list", m("agentId", "manager")).get("approvals")).isEmpty();
        String audit = String.valueOf(res(owner, "agent.audit.list", m("limit", 200)).get("entries"));
        assertThat(audit).contains("maia.todos").doesNotContain("lease").doesNotContain("Dana");
    }

    /** Whether the to-do run's end was audited (its last step: the cursor's run_end has gone to deskd before). */
    private boolean runRecorded() throws Exception {
        return runs() >= 1;
    }

    private int runs() throws Exception {
        String audit = String.valueOf(res(owner, "agent.audit.list", m("limit", 500)).get("entries"));
        int n = 0;
        for (int at = audit.indexOf("read:"); at >= 0; at = audit.indexOf("read:", at + 5)) {
            n++;
        }
        return n;
    }
}
