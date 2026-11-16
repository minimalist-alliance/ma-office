package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.desks.DeskMessaging;
import com.minimalistalliance.desk.deskd.desks.DeskTools;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.FakeMaiaPlatform;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.todo.TodoModule;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
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
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Desk Maia's briefs across three of the member's desks (Maia Mode, API.md §23; the concept's §4 and §8.1), each desk a
 * real deskd relay with its own keys and records ({@link DeskMessaging}, {@link DeskTools} with deskd's
 * {@code MaiaRecord}) over a real desk-agent jar on real Unix sockets, a stand-in for Anthropic's API on loopback, and
 * the test as the office carrying the envelopes. Desk A is her home desk; B (Work) and C (Personal) answer her with their
 * Lead. Without a Maia grant her brief is refused {@code maia_grant} before anyone is asked; under a grant it goes with
 * no card, even from a run holding the member's private data (the concept's {@code delegate}); and once her run has read
 * a private answer from a desk that keeps to itself, a brief to another desk asks on a card. {@code verify} skips it
 * unless {@code DESK_AGENT_JAR} names desk-agent's jar.
 */
@EnabledIfEnvironmentVariable(named = "DESK_AGENT_JAR", matches = ".+")
@SuppressWarnings("unchecked")
class RealDeskAgentMaiaBriefsIT {

    private static final String KEY = "sk-ant-api03-stand-in-key-0010";
    private static final String MODEL = "claude-sonnet-5-5";
    /** What only a run answering another desk's message reads. */
    private static final String ANSWERING = "on another of the member's desks, not from the member";
    private static final String TO_WORK = "What's on at Work today?";
    private static final String TO_HOME = "Anything at home today?";

    @TempDir
    Path dir;

    private HttpServer provider;
    private final ConcurrentLinkedQueue<String> requests = new ConcurrentLinkedQueue<>();
    /** Her service on Minimalist Alliance's account: her steps and her note-taker's go there, through deskd. */
    private FakeMaiaPlatform platform;
    /** Her own steps, given her request as the contract's JSON: the note-taker's is fixed below. */
    private final AtomicReference<Function<String, FakeMaiaPlatform.Reply>> maiaScript = new AtomicReference<>();
    private final Desk a = new Desk("a", "d-aaaa");
    private final Desk b = new Desk("b", "d-bbbb");
    private final Desk c = new Desk("c", "d-cccc");

    /** One desk: its deskd relay, keys and records, its To-do, its desk-agent, and the office's session to it. */
    private final class Desk {
        final String name;
        final String deskId;
        AgentRig rig;
        DeskMessaging messaging;
        TodoModule todo;
        Process process;
        TestClient session;
        String keyId;

        Desk(String name, String deskId) {
            this.name = name;
            this.deskId = deskId;
        }

        Path dir() {
            return dir.resolve(name);
        }

        void open() throws Exception {
            Files.createDirectories(dir().resolve("agent-data"));
            // Listed for Maia Mode (API.md §23): the switch says on.
            Files.writeString(dir().resolve("agent-data").resolve("maia-switch"), "on\n");
            Files.createDirectories(dir().resolve("desk-data"));
            rig = new AgentRig(dir(), false);
            rig.module.keepAccessIn(dir().resolve("desk-data"));
            messaging = new DeskMessaging(rig.clock, () -> deskId, () -> "user-1", () -> false);
            messaging.keepIn(dir().resolve("desk-data"));
            rig.module.desks(messaging, () -> false);
            todo = new TodoModule(rig.dispatcher, rig.hub, dir().resolve("desk-data"), () -> false,
                    () -> ZoneId.of("America/Denver"), rig.clock);
            ToolHost host = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
            host.agentApps(rig.module.accessRecord());
            host.access(rig.module.accessRecord());
            host.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
                var redeemed = rig.module.approvalTickets().redeem(approvalId, sha256, agentId, runId, tool, context,
                        args);
                return redeemed.ok() ? null : redeemed.refusal().code();
            });
            // As DataPlaneConfiguration wires it: her briefs go by deskd's own record of her grants, and the messages
            // and answers deskd gives a run are its sources (her desk origins among them).
            host.area(HostedDecls.DESKS, new DeskTools(messaging, rig.module::agentName).maia(rig.module.maiaRecord()));
            host.area(HostedDecls.TODO, new TodoTools(todo::store));
            messaging.sources().runs(host.ledger()::find);
            host.origins(messaging.sources()::origin);
            rig.module.onMemberRun(host.ledger()::memberStarted);
            rig.module.hostTools(host);
            // Her model through deskd to her service (only the home desk runs her).
            rig.module.maiaModel(new MaiaModel(platform.client(java.time.Clock.systemUTC()), () -> false, () -> true,
                    () -> false));
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
            session = rig.connect(name);
            Map<String, Object> added = call("agent.key.add", Map.of("provider", "anthropic", "label", "Main", "secret",
                    KEY));
            assertThat(added).as(String.valueOf(added)).containsEntry("_kind", "RES");
            keyId = (String) map(added.get("key")).get("keyId");
            res("agent.bind", m("agentId", "manager", "keyId", keyId, "model", MODEL));
            res("agent.access.set", m("agentId", "manager", "apps", m("notebook", true, "files", false, "browser",
                    false, "courier", false, "todos", true), "auto", m("notebook", null, "files", null, "todos", false)));
        }

        Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
            boolean mutation = AgentMethods.MUTATIONS.contains(method)
                    || List.of(DeskMethods.DELIVER, DeskMethods.DONE, DeskMethods.ANSWER).contains(method);
            return rig.call(session, method, params, mutation ? UUID.randomUUID().toString() : null);
        }

        Map<String, Object> res(String method, Map<String, Object> params) throws Exception {
            Map<String, Object> r = call(method, params);
            assertThat(r).as(name + " " + method + " " + r).containsEntry("_kind", "RES");
            return r;
        }

        List<Map<String, Object>> thread(String agentId) throws Exception {
            return list(res("agent.thread.get", Map.of("agentId", agentId)).get("messages"));
        }

        List<Map<String, Object>> pending(String agentId) throws Exception {
            return list(res("agent.approvals.list", Map.of("agentId", agentId)).get("approvals"));
        }

        void close() throws Exception {
            if (rig != null) {
                rig.close();
            }
            if (process != null) {
                process.destroy();
                process.waitFor();
            }
            if (todo != null) {
                todo.close();
            }
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        provider = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        provider.createContext("/", this::answer);
        provider.start();
        platform = new FakeMaiaPlatform();
        platform.script.set(request -> {
            String json = new String(Json.bytes(request), StandardCharsets.UTF_8);
            if ("notes".equals(request.get("task"))) {
                return FakeMaiaPlatform.text("{\"notes\": []}");
            }
            Function<String, FakeMaiaPlatform.Reply> step = maiaScript.get();
            return step == null ? FakeMaiaPlatform.text("Hello.") : step.apply(json);
        });
        a.open();
        b.open();
        c.open();
        // Her home desk: Maia Mode on with the disclosure, her access, and her send halves to B and C. She needs no key.
        a.res("agent.maia.set", m("on", true, "disclosure", "maia-mode-v2", "notesTabId", "tab-maia", "homeDeskId",
                a.deskId));
        a.res("agent.access.set", m("agentId", "maia", "apps", m("notebook", true, "files", false, "browser", false,
                "courier", false, "todos", true), "auto", m("notebook", m("tabId", "tab-maia"), "files", null,
                "todos", true)));
        pair(b, "Work");
        pair(c, "Personal");
    }

    @AfterEach
    void tearDown() throws Exception {
        for (Desk d : List.of(a, b, c)) {
            d.close();
        }
        if (provider != null) {
            provider.stop(0);
        }
        if (platform != null) {
            platform.close();
        }
    }

    // ---------------------------------------------------------------- the office

    private int carry(Desk from, Desk to) throws Exception {
        Map<String, Object> taken = from.call(DeskMethods.TAKE, m("toDeskId", to.deskId));
        if (!"RES".equals(taken.get("_kind"))) {
            return 0;
        }
        List<Map<String, Object>> results = new ArrayList<>();
        for (Map<String, Object> e : list(taken.get("envelopes"))) {
            Map<String, Object> answer = to.call(DeskMethods.DELIVER, m("envelope", e.get("envelope")));
            if ("RES".equals(answer.get("_kind"))) {
                results.add(m("id", e.get("id"), "outcome", answer.get("outcome")));
            } else if (List.of("bad_request", "forbidden", "conflict", "too_large").contains(answer.get("code"))) {
                results.add(m("id", e.get("id"), "outcome", "refused", "reason", map(answer.get("details"))
                        .get("reason")));
            } else {
                break;
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
            moved = carry(a, b) + carry(b, a) + carry(a, c) + carry(c, a);
        } while (moved > 0);
    }

    /** Her send half to {@code to}, allowed there with its Lead answering: the W6 flow, through both relays. */
    private void pair(Desk to, String deskName) throws Exception {
        Map<String, Object> set = a.res("agent.access.set", m("agentId", "maia", "desks", List.of(m("deskId",
                to.deskId, "deskName", deskName, "on", true))));
        String grantId = list(map(set.get("access")).get("desks")).stream().filter(h -> to.deskId.equals(h.get(
                "toDeskId"))).findFirst().orElseThrow().get("grantId").toString();
        await().atMost(Duration.ofSeconds(10)).until(() -> carry(a, to) > 0);
        to.res(DeskMethods.ANSWER, m("grantId", grantId, "allow", true, "agentId", "manager"));
        await().atMost(Duration.ofSeconds(10)).until(() -> carry(to, a) > 0);
        await().atMost(Duration.ofSeconds(10)).until(() -> a.messaging.grants().half(grantId).active());
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
            if (request.contains(ANSWERING) && request.contains(TO_WORK)) {
                // Work's Lead reads the member's To-do there (private data), then answers.
                reply = request.contains("\"tool_result\"") ? text("Work: two meetings, 10:00 and 15:00.")
                        : call("todo_list", "{}");
            } else if (request.contains(ANSWERING)) {
                reply = text("Home: nothing new.");
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

    private static int count(String text, String part) {
        int n = 0;
        for (int at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length())) {
            n++;
        }
        return n;
    }

    /** Her steps: brief Work, then (after its answer) brief Personal, then say she's done. */
    private void briefWorkThenHome() {
        maiaScript.set(request -> switch (count(request, "\"toolResults\"")) {
            case 0 -> FakeMaiaPlatform.call("desk_message", Map.of("desk", "Work", "text", TO_WORK));
            case 1 -> FakeMaiaPlatform.call("desk_message", Map.of("desk", "Personal", "text", TO_HOME));
            default -> FakeMaiaPlatform.text("Done.");
        });
    }

    private void grant(Desk to, String name, boolean keepsToItself) throws Exception {
        a.res("agent.maia.grant.set", m("deskId", to.deskId, "deskName", name, "scopes", List.of("brief"),
                "keepsToItself", keepsToItself));
        await().atMost(Duration.ofSeconds(5)).until(() -> a.rig.module.maiaRecord().mayBrief(to.deskId));
    }

    /** Work's answer asks on Work as a send (its run read the member's To-do there): the member there says yes. */
    private void approveWorksAnswer() throws Exception {
        await().atMost(Duration.ofSeconds(30)).until(() -> {
            settle();
            return !b.pending("manager").isEmpty();
        });
        Map<String, Object> card = b.pending("manager").get(0);
        assertThat(card).containsEntry("tool", "desk_answer").containsEntry("risk", "send");
        String sha = ToolHost.hash((String) card.get("agentId"), (String) card.get("runId"), (String) card.get("tool"),
                (String) card.get("context"), map(card.get("payload")));
        b.res("agent.approval.decide", m("approvalId", card.get("id"), "approve", true, "sha256", sha));
    }

    private boolean homeGotIt() throws Exception {
        return c.thread("manager").stream().anyMatch(x -> String.valueOf(x.get("text")).contains(TO_HOME));
    }

    private Map<String, Object> herLastReply() throws Exception {
        List<Map<String, Object>> t = a.thread("maia");
        return t.get(t.size() - 1);
    }

    // ---------------------------------------------------------------- the flows

    @Test
    void withoutAGrantHerBriefIsRefusedBeforeAnyoneIsAsked() throws Exception {
        maiaScript.set(request -> count(request, "\"toolResults\"") == 0
                ? FakeMaiaPlatform.call("desk_message", Map.of("desk", "Work", "text", TO_WORK))
                : FakeMaiaPlatform.text("I can't reach Work."));
        a.res("agent.message.send", m("agentId", "maia", "text", "Ask Work what's on."));
        await().atMost(Duration.ofSeconds(30)).until(() -> "done".equals(herLastReply().get("state")));
        assertThat(herLastReply().get("text")).isEqualTo("I can't reach Work.");
        assertThat(platform.bodies).anyMatch(r -> r.contains("maia_grant"));
        assertThat(a.pending("maia")).isEmpty();
        // Nothing went to Work: no envelope waits, and Work's Lead never ran.
        assertThat(list(a.res(DeskMethods.TAKE, m("toDeskId", b.deskId)).get("envelopes"))).isEmpty();
        assertThat(requests).noneMatch(r -> r.contains(ANSWERING));
        // deskd's own record refuses it too: Maia Mode is on, and no grant for Work.
        assertThat(a.rig.module.maiaRecord().on()).isTrue();
        assertThat(a.rig.module.maiaRecord().mayBrief(b.deskId)).isFalse();
    }

    @Test
    void underHerGrantsABriefGoesWithNoCardEvenAfterPrivateDataFromADeskThatDoesntKeepToItself() throws Exception {
        grant(b, "Work", false);
        grant(c, "Personal", false);
        briefWorkThenHome();
        a.res("agent.message.send", m("agentId", "maia", "text", "Check Work, then home."));
        approveWorksAnswer();
        await().atMost(Duration.ofSeconds(60)).until(() -> {
            settle();
            return "done".equals(herLastReply().get("state"));
        });
        assertThat(herLastReply().get("text")).isEqualTo("Done.");
        // Work's private answer reached her run, and her brief home still went with no card (delegate).
        assertThat(platform.bodies).anyMatch(r -> r.contains("Work: two meetings"));
        assertThat(homeGotIt()).isTrue();
        assertThat(list(a.res("agent.approvals.list", m("agentId", "maia", "state", "all")).get("approvals")))
                .isEmpty();
        // The audit holds ids only.
        String audit = String.valueOf(a.res("agent.audit.list", m("limit", 300)).get("entries"));
        assertThat(audit).contains("maia.brief").doesNotContain("two meetings").doesNotContain(TO_HOME);
    }

    @Test
    void afterAPrivateAnswerFromADeskThatKeepsToItselfABriefElsewhereAsks() throws Exception {
        grant(b, "Work", true);
        grant(c, "Personal", false);
        briefWorkThenHome();
        a.res("agent.message.send", m("agentId", "maia", "text", "Check Work, then home."));
        approveWorksAnswer();
        AtomicReference<Map<String, Object>> card = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(60)).until(() -> {
            settle();
            List<Map<String, Object>> pending = a.pending("maia");
            if (pending.isEmpty()) {
                return false;
            }
            card.set(pending.get(0));
            return true;
        });
        assertThat(card.get()).containsEntry("tool", "desk_message").containsEntry("risk", "send");
        assertThat(map(card.get().get("target"))).containsEntry("deskId", c.deskId);
        assertThat(homeGotIt()).isFalse();
        // The member says no: nothing goes home.
        String sha = ToolHost.hash((String) card.get().get("agentId"), (String) card.get().get("runId"),
                (String) card.get().get("tool"), (String) card.get().get("context"), map(card.get().get("payload")));
        a.res("agent.approval.decide", m("approvalId", card.get().get("id"), "approve", false, "sha256", sha));
        await().atMost(Duration.ofSeconds(30)).until(() -> {
            settle();
            return List.of("done", "failed", "stopped").contains(herLastReply().get("state"));
        });
        settle();
        assertThat(homeGotIt()).isFalse();
        assertThat(list(a.res(DeskMethods.TAKE, m("toDeskId", c.deskId)).get("envelopes"))).isEmpty();
    }

    // ---------------------------------------------------------------- helpers

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    private static List<Map<String, Object>> list(Object value) {
        return (List<Map<String, Object>>) value;
    }
}
