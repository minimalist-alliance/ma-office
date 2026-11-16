package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.courier.CourierFixture;
import com.minimalistalliance.desk.deskd.courier.CourierRead;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.todo.TodoModule;
import com.minimalistalliance.desk.deskd.tools.CourierTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.TodoTools;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Courier's read tools over the real agent socket (the draft ADR's §12 and §17, the Courier row): desk-agent's
 * {@code tcall}s through the real {@link AgentLink} and {@link ToolHost}, wired as {@code DataPlaneConfiguration} wires
 * them, to the real {@link CourierTools} on Courier's real store, filled by fixture ingest (no transport exists yet), and
 * To-do's real {@link TodoTools} on a real {@code todo.db} beside it.
 *
 * <p>The hello names the tools only while Courier's store is there; an agent the member hasn't given Courier gets
 * {@code scope}; every result is {@code U} and {@code S}; {@code courier_new}'s reply is kept by its key and its cursor
 * moves at a {@code run_end} of {@code done}; and To-do takes a Courier source only for a message the run read.
 */
@SuppressWarnings("unchecked")
class CourierToolsDeskdIntegrationTest {

    private static final String AGENT = "ag-courier0sock1";
    private static final String NO_COURIER = "ag-nocourier0001";

    @TempDir
    Path dir;

    private AgentRig rig;
    private CourierFixture fx;
    private TodoModule todo;
    private ToolHost host;
    private final AtomicBoolean courierThere = new AtomicBoolean(true);
    private final Map<String, Boolean> switches = new ConcurrentHashMap<>();
    private final Map<Long, Map<String, Object>> answers = new ConcurrentHashMap<>();
    private long nextId = 5_000;
    private int nextKey = 1;
    private int nextApproval;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentRig(Files.createDirectories(dir.resolve("agent")));
        rig.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of()));
        fx = new CourierFixture(dir.resolve("courier"));
        todo = new TodoModule(rig.dispatcher, rig.hub, dir, () -> false, () -> ZoneId.of("America/Denver"), rig.clock);
        host = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
        // deskd's own record of the member's apps: Courier on for one agent only (§16: off until the member says).
        host.agentApps((agentId, area) -> HostedDecls.COURIER.equals(area) && !AGENT.equals(agentId) ? "scope" : null);
        host.access((caller, agentId, group) -> Boolean.TRUE.equals(switches.get(agentId + "/" + group)));
        host.area(HostedDecls.COURIER, new CourierTools(() -> courierThere.get() ? fx.read() : CourierRead.NONE,
                () -> ZoneId.of("America/Denver"), rig.clock));
        host.area(HostedDecls.TODO, new TodoTools(todo::store));
        rig.module.onMemberRun(host.ledger()::memberStarted);
        rig.module.hostTools(host);
        rig.agent.drop();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.agent.connections() >= 2 && rig.module.link().isConnected());
    }

    @AfterEach
    void tearDown() throws Exception {
        host.close();
        todo.close();
        fx.close();
        rig.close();
    }

    // ---------------------------------------------------------------- helpers

    private Map<String, Object> tcall(String run, String agent, String tool, Map<String, Object> args, List<String> taint,
            Map<String, Object> extra) throws InterruptedException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", nextId++);
        m.put("runId", run);
        m.put("agentId", agent);
        m.put("tool", tool);
        m.put("args", args);
        m.put("taint", taint);
        if (extra != null) {
            m.putAll(extra);
        }
        return answer(m);
    }

    private Map<String, Object> answer(Map<String, Object> call) throws InterruptedException {
        long id = ((Number) call.get("id")).longValue();
        rig.agent.sendJson(call);
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < until) {
            Map<String, Object> mine = answers.remove(id);
            if (mine != null) {
                return mine;
            }
            Map<String, Object> m = rig.agent.received.poll(50, TimeUnit.MILLISECONDS);
            if (m != null && ("tres".equals(m.get("t")) || "terr".equals(m.get("t"))) && m.get("id") instanceof Number n) {
                if (n.longValue() == id) {
                    return m;
                }
                answers.put(n.longValue(), m);
            }
        }
        throw new AssertionError("no answer to " + id);
    }

    private String key() {
        long ms = rig.clock.millis();
        return String.format("%08x-%04x-7abc-9def-%012x", ms >>> 16, ms & 0xffff, nextKey++);
    }

    private String approvalId() {
        String alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        StringBuilder out = new StringBuilder("ap-");
        long v = nextApproval++;
        for (int i = 0; i < 20; i++) {
            out.append(alphabet.charAt((int) (v & 31)));
            v >>= 5;
        }
        return out.toString();
    }

    private static Map<String, Object> r(Map<String, Object> reply) {
        assertThat(reply.get("t")).as("%s", reply).isEqualTo("tres");
        return (Map<String, Object>) reply.get("r");
    }

    private static Map<String, Object> content(Map<String, Object> reply) {
        return (Map<String, Object>) r(reply).get("content");
    }

    private static String refused(Map<String, Object> reply) {
        assertThat(reply.get("t")).as("%s", reply).isEqualTo("terr");
        return (String) ((Map<String, Object>) reply.get("details")).get("reason");
    }

    private static List<String> ids(Map<String, Object> content, String key) {
        List<String> out = new ArrayList<>();
        for (Map<String, Object> m : (List<Map<String, Object>>) content.get(key)) {
            out.add((String) m.get("messageId"));
        }
        return out;
    }

    private Map<String, Object> nextHello() throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < until) {
            Map<String, Object> m = rig.agent.received.poll(50, TimeUnit.MILLISECONDS);
            if (m != null && "req".equals(m.get("t")) && ToolHost.HELLO.equals(m.get("m"))) {
                return (Map<String, Object>) m.get("p");
            }
        }
        throw new AssertionError("no hello");
    }

    // ---------------------------------------------------------------- the tests

    @Test
    void theHelloNamesTheToolsOnlyWhileCouriersStoreIsThere() throws Exception {
        rig.agent.drop();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.agent.connections() >= 3 && rig.module.link().isConnected());
        assertThat((List<String>) nextHello().get("tools")).containsAll(CourierTools.TOOLS);
        courierThere.set(false);
        rig.agent.drop();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.agent.connections() >= 4 && rig.module.link().isConnected());
        Map<String, Object> hello = nextHello();
        while (((List<String>) hello.get("tools")).contains("courier_new")) {
            hello = nextHello();
        }
        assertThat((List<String>) hello.get("tools")).doesNotContainAnyElementsOf(CourierTools.TOOLS).contains("todo_add");
        assertThat(refused(tcall("run-x", AGENT, "courier_new", Map.of(), List.of(), Map.of("key", key()))))
                .isEqualTo("courier");
    }

    @Test
    void anAgentWithoutCourierGetsScopeAndOneWithItGetsUAndSFromEveryTool() throws Exception {
        fx.known("dana@example.com");
        String id = fx.email("Dana <dana@example.com>").id("d@x").subject("Dinner").text("Dinner at 7?").deliver();
        assertThat(refused(tcall("run-n", NO_COURIER, "courier_list", Map.of(), List.of(), null))).isEqualTo("scope");
        assertThat(refused(tcall("run-n", NO_COURIER, "courier_new", Map.of(), List.of(), Map.of("phase", "look"))))
                .isEqualTo("scope");
        for (Map.Entry<String, Map<String, Object>> c : Map.of(
                "courier_list", Map.<String, Object>of(),
                "courier_search", Map.<String, Object>of("q", "dinner"),
                "courier_read", Map.<String, Object>of("messageId", id),
                "courier_new", Map.<String, Object>of()).entrySet()) {
            Map<String, Object> extra = c.getKey().equals("courier_new") ? Map.of("key", key()) : null;
            Map<String, Object> reply = tcall("run-" + c.getKey(), AGENT, c.getKey(), c.getValue(), List.of(), extra);
            assertThat((List<String>) r(reply).get("taints")).as(c.getKey()).containsExactlyInAnyOrder("U", "S");
            assertThat((List<String>) reply.get("taint")).as(c.getKey()).containsExactlyInAnyOrder("U", "S");
            assertThat(r(reply).get("risk")).isEqualTo("read");
        }
        Map<String, Object> m = content(tcall("run-r", AGENT, "courier_read", Map.of("messageId", id), List.of(), null));
        assertThat((Map<String, Object>) m.get("from")).containsEntry("endpoint", "dana@example.com");
        assertThat(m.get("text")).isEqualTo("Dinner at 7?");
    }

    @Test
    void courierNewsReplyIsKeptByItsKeyAndItsCursorMovesOnlyAtADoneEnd() throws Exception {
        fx.known("dana@example.com");
        List<String> sent = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            sent.add(fx.email("Dana <dana@example.com>").id("n" + i + "@x").text("new " + i).deliver());
        }
        String k = key();
        Map<String, Object> first = content(tcall("run-1", AGENT, "courier_new", Map.of(), List.of(), Map.of("key", k)));
        assertThat(ids(first, "messages")).isEqualTo(sent);
        // The link went before desk-agent read it: asked again by the key, the same reply.
        Map<String, Object> again = content(tcall("run-1", AGENT, "courier_new", Map.of(), List.of(),
                Map.of("key", k, "retry", true)));
        assertThat(ids(again, "messages")).isEqualTo(sent);
        // A run that fails leaves it: the next is given the same.
        Map<String, Object> end = new LinkedHashMap<>();
        end.put("state", "ended");
        assertThat(tcall("run-1", AGENT, "run_end", end, List.of(), null).get("t")).isEqualTo("tres");
        Map<String, Object> second = content(tcall("run-2", AGENT, "courier_new", Map.of(), List.of(), Map.of("key", key())));
        assertThat(ids(second, "messages")).isEqualTo(sent);
        // Done, naming what it got: stored, and the next run is given nothing old.
        assertThat(tcall("run-2", AGENT, "run_end", Map.of("state", "done", "courier", second.get("cursor")), List.of(), null)
                .get("t")).isEqualTo("tres");
        Map<String, Object> stored = (Map<String, Object>) second.get("cursor");
        assertThat(fx.read().cursor(AGENT)).isEqualTo(new CourierRead.Cursor(((Number) stored.get("receivedAt")).longValue(),
                (String) stored.get("messageId")));
        assertThat(ids(content(tcall("run-3", AGENT, "courier_new", Map.of(), List.of(), Map.of("key", key()))), "messages"))
                .isEmpty();
    }

    @Test
    void toDoTakesACourierSourceOnlyForAMessageTheRunReadAndLabelsItFromTheContactRecord() throws Exception {
        switches.put(AGENT + "/todos", true);
        fx.known("dana@example.com");
        String read = fx.email("Dana <dana@example.com>").id("rent@x").subject("Rent due Friday")
                .text("Please pay the rent by Friday.").dmarc("pass").deliver();
        String hit = fx.email("Dana <dana@example.com>").id("hit@x").subject("Rent receipt").text("Rent receipt attached.")
                .dmarc("pass").deliver();
        // Only searched: the hit isn't a read, so no To-do source.
        tcall("run-t", AGENT, "courier_search", Map.of("q", "rent"), List.of(), null);
        Map<String, Object> add = new LinkedHashMap<>();
        add.put("title", "Pay the rent");
        add.put("source", Map.of("kind", "courier", "ref", Map.of("messageId", hit)));
        Map<String, Object> look = r(tcall("run-t", AGENT, "todo_add", add, List.of("U", "S"), Map.of("phase", "look")));
        assertThat(look).containsEntry("refusal", "source_unknown");
        // Read whole: a source, done without asking under the switch even after U (ATA-L1: a third party's message).
        tcall("run-t", AGENT, "courier_read", Map.of("messageId", read), List.of(), null);
        add.put("source", Map.of("kind", "courier", "ref", Map.of("messageId", read)));
        look = r(tcall("run-t", AGENT, "todo_add", add, List.of("U", "S"), Map.of("phase", "look")));
        assertThat(look).containsEntry("refusal", null).containsEntry("group", "todos");
        Map<String, Object> added = content(tcall("run-t", AGENT, "todo_add", (Map<String, Object>) look.get("payload"),
                List.of("U", "S"), Map.of("auto", "todos", "autoApprovalId", approvalId(), "context", "agent")));
        assertThat(added).containsEntry("created", true);
        Map<String, Object> item = (Map<String, Object>) todo.store().get((String) added.get("id"), 0).get("item");
        assertThat((Map<String, Object>) item.get("source")).containsEntry("kind", "courier")
                .containsEntry("label", "Email from Dana · Rent due Friday");
        assertThat(item.get("untrusted")).isEqualTo(true);
    }
}
