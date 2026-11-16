package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.todo.TodoModule;
import com.minimalistalliance.desk.deskd.todo.TodoStore;
import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * To-do's agent tools over the real agent socket (API.md §22; the draft ADR's §17, the To-dos row): desk-agent's
 * {@code tcall}s through the real {@link AgentLink} and {@link ToolHost}, wired as {@code DataPlaneConfiguration} wires
 * them, to the real {@link TodoTools} on a real {@code todo.db}; the member's own session relaying {@code agent.message.send}
 * (deskd's record of an attended run), their {@code agent.approval.decide} (deskd's ticket) and their {@code todo.*} and
 * topic {@code todo} through the real session path.
 *
 * <p>The bar: the same message twice at once, and across a restart, makes one row; the caps hold under concurrent calls; a
 * source the run didn't read is refused; nothing is lost across a restart; the member's view hears an agent's add within
 * 500 ms; dismiss, reopen and put back work. And the policy: Security's ATA-L1, {@code not_yours}, a suggestion.
 */
@SuppressWarnings("unchecked")
class TodoToolsDeskdIntegrationTest {

    private static final String AGENT = "ag-3k9x0d2m4q1z";
    private static final String OTHER = "ag-other00001";
    private static final String RUN = "run-member-1";
    private static final String PAGE = "https://renewals.example.com/lease?id=7";

    @TempDir
    Path dir;

    private AgentRig rig;
    private TodoModule todo;
    /** The store the agent's tools use: the module's, or after a restart the file opened again. */
    private final AtomicReference<TodoStore> current = new AtomicReference<>();
    private TodoStore reopened;
    private ToolHost host;
    private TestClient owner;
    private final Map<String, Boolean> switches = new ConcurrentHashMap<>();
    private long nextId = 1_000;
    private int nextApproval;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentRig(Files.createDirectories(dir.resolve("agent")));
        rig.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of()));
        rig.agent.handlers.put("agent.message.send", p -> Map.of("messageId", "msg-1", "runId", RUN));
        rig.agent.handlers.put("agent.approval.decide", p -> Map.of("approval", Map.of("id", p.get("approvalId"),
                "state", Boolean.TRUE.equals(p.get("approve")) ? "approved" : "declined")));
        todo = openTodo();
        host = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
        ApprovalTickets tickets = rig.module.approvalTickets();
        host.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
            var redeemed = tickets.redeem(approvalId, sha256, agentId, runId, tool, context, args);
            return redeemed.ok() ? null : redeemed.refusal().code();
        });
        host.access((caller, agentId, group) -> Boolean.TRUE.equals(switches.get(agentId + "/" + group)));
        host.area(HostedDecls.TODO, new TodoTools(current::get));
        host.area(HostedDecls.BROWSER, new FakeBrowser());
        rig.module.onMemberRun(host.ledger()::memberStarted);
        rig.module.hostTools(host);
        rig.agent.drop();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.agent.connections() >= 2 && rig.module.link().isConnected());
        owner = rig.connect("cs-1");
    }

    @AfterEach
    void tearDown() throws Exception {
        host.close();
        todo.close();
        if (reopened != null) {
            reopened.close();
        }
        rig.close();
    }

    private TodoModule openTodo() {
        TodoModule m = new TodoModule(rig.dispatcher, rig.hub, dir, () -> false, () -> ZoneId.of("America/Denver"),
                rig.clock);
        current.set(m.store());
        return m;
    }

    /** A Browser area that reads one page, so deskd records it as a source this run read. */
    private static final class FakeBrowser implements HostedTool {
        @Override
        public Look look(HostedCall call, RunLedger.Run run) {
            return Look.plain(call.args(), Map.of("kind", "site"));
        }

        @Override
        public Result run(HostedCall call, RunLedger.Run run) {
            Map<String, Object> page = new LinkedHashMap<>();
            page.put("tabId", "t1");
            page.put("url", PAGE + "#terms");
            page.put("title", "Your lease renewal");
            page.put("view", "page");
            return new Result(page, java.util.Set.of("U"), Map.of());
        }
    }

    // ---------------------------------------------------------------- helpers

    private Map<String, Object> tcall(String run, String agent, String tool, Map<String, Object> args, List<String> taint,
            Map<String, Object> extra) throws InterruptedException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        synchronized (this) {
            m.put("id", nextId++);
        }
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

    private final Map<Long, Map<String, Object>> answers = new ConcurrentHashMap<>();

    /** Sends a tcall over the socket and waits for its tres or terr, keeping others' answers for them. */
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

    private Map<String, Object> auto(String approvalId) {
        return Map.of("auto", "todos", "autoApprovalId", approvalId, "context", "agent");
    }

    private static Map<String, Object> r(Map<String, Object> reply) {
        assertThat(reply.get("t")).as("%s", reply).isEqualTo("tres");
        return (Map<String, Object>) reply.get("r");
    }

    private static String refused(Map<String, Object> reply) {
        assertThat(reply.get("t")).as("%s", reply).isEqualTo("terr");
        return (String) ((Map<String, Object>) reply.get("details")).get("reason");
    }

    private static Map<String, Object> content(Map<String, Object> reply) {
        return (Map<String, Object>) r(reply).get("content");
    }

    private Map<String, Object> addArgs(String title, String kind, Map<String, Object> ref) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("title", title);
        args.put("source", Map.of("kind", kind, "ref", ref));
        return args;
    }

    private Map<String, Object> browserAdd(String title) {
        return addArgs(title, "browser", Map.of("url", PAGE));
    }

    private void memberStartsTheRun() throws Exception {
        Map<String, Object> res = rig.call(owner, "agent.message.send", Map.of("agentId", AGENT, "text", "Sort my lease out"));
        assertThat(res).containsEntry("_kind", "RES").containsEntry("runId", RUN);
    }

    private void readThePage(String run, String agent) throws InterruptedException {
        assertThat(r(tcall(run, agent, "browser_read", Map.of("tabId", "t1"), List.of(), null))).isNotNull();
    }

    private Map<String, Object> member(String method, Map<String, Object> params) throws Exception {
        Map<String, Object> res = rig.call(owner, method, params, method.startsWith("todo.")
                && !List.of("todo.list", "todo.get", "todo.summary", "todo.changes").contains(method)
                ? java.util.UUID.randomUUID().toString() : null);
        assertThat(res.get("_kind")).as("%s %s", method, res).isEqualTo("RES");
        return res;
    }

    private List<Map<String, Object>> open() throws Exception {
        return (List<Map<String, Object>>) member("todo.list", Map.of("view", "open")).get("items");
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

    // ---------------------------------------------------------------- the bar

    @Test
    void aMemberStartedRunAddsFromTheirOwnMessageAndTheirViewHearsItWithin500Ms() throws Exception {
        switches.put(AGENT + "/todos", true);
        assertThat(owner.subscribe("todo", null)).containsEntry("_kind", "RES");
        Frame snapshot = owner.next(Channels.EVENTS);
        assertThat(TestClient.parse(snapshot.payload())).containsEntry("type", "snapshot");
        memberStartsTheRun();
        Map<String, Object> args = addArgs("Sign and return the lease renewal", "agent_chat", Map.of("messageId", "msg-1"));
        // deskd's look: in the todos group (a clean run the member started), so desk-agent's gate needn't ask.
        Map<String, Object> look = r(tcall(RUN, AGENT, "todo_add", args, List.of(), Map.of("phase", "look")));
        assertThat(look).containsEntry("risk", "write").containsEntry("group", "todos").containsEntry("refusal", null);
        long sent = System.nanoTime();
        Map<String, Object> added = content(tcall(RUN, AGENT, "todo_add", (Map<String, Object>) look.get("payload"), List.of(),
                auto(approvalId())));
        assertThat(added).containsEntry("created", true);
        Frame event = owner.next(Channels.EVENTS);
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - sent);
        Map<String, Object> changed = TestClient.parse(event.payload());
        assertThat(changed).containsEntry("type", "changed");
        assertThat((Map<String, Object>) changed.get("data")).containsEntry("op", "add").containsEntry("id", added.get("id"));
        assertThat(tookMs).as("the member's view hears the add").isLessThanOrEqualTo(500);
        Map<String, Object> item = open().get(0);
        assertThat(item).containsEntry("by", "agent:" + AGENT).containsEntry("untrusted", false);
        assertThat((Map<String, Object>) item.get("source")).containsEntry("kind", "agent_chat")
                .containsEntry("label", "Your message to the agent");
    }

    @Test
    void theSameMessageTwiceAtOnceIsOneRowAndAcrossARestartToo() throws Exception {
        switches.put(AGENT + "/todos", true);
        readThePage(RUN, AGENT);
        int calls = 12;
        CountDownLatch go = new CountDownLatch(1);
        List<Thread> threads = new ArrayList<>();
        List<Map<String, Object>> results = java.util.Collections.synchronizedList(new ArrayList<>());
        for (int i = 0; i < calls; i++) {
            String approval = approvalId();
            threads.add(Thread.ofVirtual().start(() -> {
                try {
                    go.await();
                    results.add(content(tcall(RUN, AGENT, "todo_add", browserAdd("Sign the lease renewal"), List.of("U"),
                            auto(approval))));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }));
        }
        go.countDown();
        for (Thread t : threads) {
            t.join(20_000);
        }
        assertThat(results).hasSize(calls);
        assertThat(results.stream().filter(m -> Boolean.TRUE.equals(m.get("created"))).count()).isEqualTo(1);
        assertThat(results.stream().map(m -> m.get("id")).distinct().count()).isEqualTo(1);
        assertThat(open()).hasSize(1);
        // deskd restarts: the store is opened again from its file, and the run's record is gone with the old process.
        todo.close();
        reopened = TodoStore.open(dir.resolve(TodoStore.FILE), rig.clock, () -> ZoneId.of("America/Denver"));
        current.set(reopened);
        host.ledger().end(RUN);
        String run2 = "run-after-restart";
        readThePage(run2, AGENT);
        Map<String, Object> again = content(tcall(run2, AGENT, "todo_add", browserAdd("Sign the lease renewal"), List.of("U"),
                auto(approvalId())));
        assertThat(again).containsEntry("created", false).containsEntry("id", results.get(0).get("id"));
        assertThat((List<?>) reopened.list(new TodoStore.ListQuery("open", null, null, null, null, null, 50)).get("items"))
                .hasSize(1);
    }

    @Test
    void aSourceTheRunDidntReadIsRefused() throws Exception {
        switches.put(AGENT + "/todos", true);
        // Nothing read yet: refused before anyone is asked, and again if called anyway.
        Map<String, Object> look = r(tcall(RUN, AGENT, "todo_add", browserAdd("Pay the deposit"), List.of(),
                Map.of("phase", "look")));
        assertThat(look).containsEntry("refusal", "source_unknown");
        assertThat(refused(tcall(RUN, AGENT, "todo_add", browserAdd("Pay the deposit"), List.of(), auto(approvalId()))))
                .isEqualTo("source_unknown");
        assertThat(refused(tcall(RUN, AGENT, "todo_add", addArgs("Reply to Dana", "courier",
                Map.of("messageId", "01JC8XK3M6N1Q9T2VWB5Z7RHDA")), List.of(), auto(approvalId())))).isEqualTo("source_unknown");
        // The member's message that started another run is not this one's.
        assertThat(refused(tcall(RUN, AGENT, "todo_add", addArgs("Reply to Dana", "agent_chat",
                Map.of("messageId", "msg-1")), List.of(), auto(approvalId())))).isEqualTo("source_unknown");
        // Another run of this agent read the page; this one didn't.
        readThePage("run-other", AGENT);
        assertThat(refused(tcall(RUN, AGENT, "todo_add", browserAdd("Pay the deposit"), List.of(), auto(approvalId()))))
                .isEqualTo("source_unknown");
        assertThat(open()).isEmpty();
    }

    @Test
    void theCapsHoldUnderConcurrentCalls() throws Exception {
        switches.put(AGENT + "/todos", true);
        readThePage(RUN, AGENT);
        // As many as deskd runs at once (ToolHost.AT_ONCE): more would be rate_limited, not capped.
        int calls = 16;
        CountDownLatch go = new CountDownLatch(1);
        List<Thread> threads = new ArrayList<>();
        List<Map<String, Object>> replies = java.util.Collections.synchronizedList(new ArrayList<>());
        for (int i = 0; i < calls; i++) {
            String title = "Different task number " + i + " " + "abcdefghijklmnopqrstuvwxy".charAt(i);
            String approval = approvalId();
            threads.add(Thread.ofVirtual().start(() -> {
                try {
                    go.await();
                    replies.add(tcall(RUN, AGENT, "todo_add", browserAdd(title), List.of("U"), auto(approval)));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }));
        }
        go.countDown();
        for (Thread t : threads) {
            t.join(20_000);
        }
        assertThat(replies).hasSize(calls);
        long made = replies.stream().filter(m -> "tres".equals(m.get("t"))).count();
        long capped = replies.stream().filter(m -> "terr".equals(m.get("t"))
                && "cap".equals(((Map<String, Object>) m.get("details")).get("reason"))).count();
        assertThat(made).isEqualTo(TodoStore.ADDS_PER_RUN);
        assertThat(capped).isEqualTo(calls - TodoStore.ADDS_PER_RUN);
        assertThat(open()).hasSize(TodoStore.ADDS_PER_RUN);
    }

    // ---------------------------------------------------------------- the policy

    @Test
    void afterUntrustedContentAnAddIsUnaskedOnlyWithAnUntrustedSourceTheRunRead() throws Exception {
        // Security's ATA-L1: in a run holding U, an unasked add needs a deskd-verified source of untrusted content.
        switches.put(AGENT + "/todos", true);
        memberStartsTheRun();
        readThePage(RUN, AGENT);
        Map<String, Object> fromPage = r(tcall(RUN, AGENT, "todo_add", browserAdd("Renew the lease"), List.of("U"),
                Map.of("phase", "look")));
        assertThat(fromPage).containsEntry("group", "todos");
        assertThat(content(tcall(RUN, AGENT, "todo_add", browserAdd("Renew the lease"), List.of("U"), auto(approvalId()))))
                .containsEntry("created", true);
        // The member's own message as the source, in a run that read a page: it asks, as it would lend a planted title
        // the member's trust. desk-agent claiming it was unasked is refused.
        Map<String, Object> chat = addArgs("Wire $4,000 to the new account", "agent_chat", Map.of("messageId", "msg-1"));
        Map<String, Object> look = r(tcall(RUN, AGENT, "todo_add", chat, List.of("U"), Map.of("phase", "look")));
        assertThat(look).doesNotContainKey("group").containsEntry("risk", "write");
        assertThat(refused(tcall(RUN, AGENT, "todo_add", chat, List.of("U"), auto(approvalId()))))
                .isEqualTo("approval_unknown");
        // The member's own yes on the card runs it, once, and it's marked untrusted.
        Map<String, Object> payload = (Map<String, Object>) look.get("payload");
        String id = approvalId();
        String sha = ToolHost.hash(AGENT, RUN, "todo_add", "agent", payload);
        assertThat(rig.call(owner, "agent.approval.decide", Map.of("approvalId", id, "approve", true, "sha256", sha)))
                .containsEntry("_kind", "RES");
        Map<String, Object> approval = Map.of("approval", Map.of("approvalId", id, "sha256", sha), "context", "agent");
        assertThat(content(tcall(RUN, AGENT, "todo_add", payload, List.of("U"), approval))).containsEntry("created", true);
        assertThat(refused(tcall(RUN, AGENT, "todo_add", payload, List.of("U"), approval))).isEqualTo("approval_used");
        assertThat(open()).hasSize(2).allSatisfy(item -> assertThat(item).containsEntry("untrusted", true));
        // And with the switch off, nothing is unasked at all.
        switches.clear();
        assertThat(refused(tcall(RUN, AGENT, "todo_add", browserAdd("Pay the late fee"), List.of("U"), auto(approvalId()))))
                .isEqualTo("approval_unknown");
    }

    @Test
    void anUnattendedRunSuggestsAndCantChangeTheMembersOwn() throws Exception {
        switches.put(AGENT + "/todos", true);
        String id = (String) ((Map<String, Object>) member("todo.add", Map.of("title", "Pay the water bill"))
                .get("item")).get("id");
        long rev = ((Number) ((Map<String, Object>) member("todo.get", Map.of("id", id)).get("item")).get("rev")).longValue();
        String timerRun = "run-timer-1";
        // A timer's run: the member's item can't be changed, and a close is only "Looks done?".
        assertThat(r(tcall(timerRun, AGENT, "todo_update", Map.of("id", id, "rev", rev, "title", "Ignore this"), List.of(),
                Map.of("phase", "look")))).containsEntry("refusal", "not_yours");
        assertThat(refused(tcall(timerRun, AGENT, "todo_update", Map.of("id", id, "rev", rev, "title", "Ignore this"),
                List.of(), auto(approvalId())))).isEqualTo("not_yours");
        Map<String, Object> close = Map.of("id", id, "as", "done", "reason", "Receipt from City Water");
        assertThat(r(tcall(timerRun, AGENT, "todo_close", close, List.of("U"), Map.of("phase", "look"))))
                .containsEntry("risk", "own").doesNotContainKey("group");
        assertThat(content(tcall(timerRun, AGENT, "todo_close", close, List.of("U"), null)))
                .containsEntry("result", "suggested");
        Map<String, Object> item = (Map<String, Object>) member("todo.get", Map.of("id", id)).get("item");
        assertThat(item).containsEntry("state", "open");
        assertThat((Map<String, Object>) item.get("suggestion")).containsEntry("as", "done").containsEntry("by", "agent:" + AGENT);
        // The member taps Done.
        assertThat((Map<String, Object>) member("todo.answer", Map.of("id", id, "accept", true)).get("item"))
                .containsEntry("state", "done").containsEntry("suggestion", null);
        // In a clean run the member started, the member's own item still asks (Security's TD-L2): never unasked, and a
        // claim that it was is refused; the member's yes closes it.
        String id2 = (String) ((Map<String, Object>) member("todo.add", Map.of("title", "Call the plumber")).get("item"))
                .get("id");
        memberStartsTheRun();
        Map<String, Object> close2 = Map.of("id", id2, "as", "done", "reason", "You said it's done");
        Map<String, Object> look2 = r(tcall(RUN, AGENT, "todo_close", close2, List.of(), Map.of("phase", "look")));
        assertThat(look2).containsEntry("risk", "write").doesNotContainKey("group");
        assertThat(refused(tcall(RUN, AGENT, "todo_close", close2, List.of(), auto(approvalId()))))
                .isEqualTo("approval_unknown");
        Map<String, Object> payload2 = (Map<String, Object>) look2.get("payload");
        String ap2 = approvalId();
        String sha2 = ToolHost.hash(AGENT, RUN, "todo_close", "agent", payload2);
        rig.call(owner, "agent.approval.decide", Map.of("approvalId", ap2, "approve", true, "sha256", sha2));
        assertThat(content(tcall(RUN, AGENT, "todo_close", payload2, List.of(),
                Map.of("approval", Map.of("approvalId", ap2, "sha256", sha2), "context", "agent"))))
                .containsEntry("result", "closed");
        // Its own item, in a clean run the member started, closes unasked.
        readThePage(RUN, AGENT);
        String mine = (String) content(tcall(RUN, AGENT, "todo_add", browserAdd("Book the plumber"), List.of("U"),
                auto(approvalId()))).get("id");
        String run2 = "run-member-clean";
        rig.agent.handlers.put("agent.message.send", p -> Map.of("messageId", "msg-2", "runId", run2));
        rig.call(owner, "agent.message.send", Map.of("agentId", AGENT, "text", "The plumber's booked"));
        assertThat(content(tcall(run2, AGENT, "todo_close", Map.of("id", mine, "as", "done", "reason", "Booked"),
                List.of(), auto(approvalId())))).containsEntry("result", "closed");
    }

    @Test
    void dismissReopenAndPutBackWork() throws Exception {
        switches.put(AGENT + "/todos", true);
        readThePage(RUN, AGENT);
        String approval = approvalId();
        Map<String, Object> added = content(tcall(RUN, AGENT, "todo_add", browserAdd("Return the signed lease"), List.of("U"),
                auto(approval)));
        String id = (String) added.get("id");
        // The agent changes its own item (a clean run of its own is unasked; this one read a page, so the member says yes).
        Map<String, Object> got = (Map<String, Object>) member("todo.get", Map.of("id", id)).get("item");
        Map<String, Object> change = new LinkedHashMap<>();
        change.put("id", id);
        change.put("rev", got.get("rev"));
        change.put("title", "Return the signed lease to Dana");
        Map<String, Object> look = r(tcall(RUN, AGENT, "todo_update", change, List.of("U"), Map.of("phase", "look")));
        assertThat(look).doesNotContainKey("group");
        String ap = approvalId();
        String sha = ToolHost.hash(AGENT, RUN, "todo_update", "agent", (Map<String, Object>) look.get("payload"));
        rig.call(owner, "agent.approval.decide", Map.of("approvalId", ap, "approve", true, "sha256", sha));
        assertThat(r(tcall(RUN, AGENT, "todo_update", (Map<String, Object>) look.get("payload"), List.of("U"),
                Map.of("approval", Map.of("approvalId", ap, "sha256", sha), "context", "agent")))).isNotNull();
        List<Map<String, Object>> events = (List<Map<String, Object>>) member("todo.get", Map.of("id", id)).get("events");
        String edit = (String) events.stream().filter(e -> "edit".equals(e.get("op"))).findFirst().orElseThrow().get("id");
        String add = (String) events.stream().filter(e -> "add".equals(e.get("op"))).findFirst().orElseThrow().get("id");
        // Put back: the title as it was.
        assertThat((Map<String, Object>) member("todo.undo", Map.of("eventId", edit)).get("item"))
                .containsEntry("title", "Return the signed lease");
        // Dismiss: the add undone is "not needed", and stays deduped.
        assertThat((Map<String, Object>) member("todo.undo", Map.of("eventId", add)).get("item"))
                .containsEntry("state", "not_needed");
        assertThat(content(tcall(RUN, AGENT, "todo_add", browserAdd("Return the signed lease"), List.of("U"),
                auto(approvalId())))).containsEntry("created", false);
        // Reopen.
        assertThat((Map<String, Object>) member("todo.reopen", Map.of("id", id)).get("item")).containsEntry("state", "open");
        // And the agent's own undo by its approval id (the draft ADR's §15), as agent.approval.undo reaches it.
        String id3 = (String) content(tcall(RUN, AGENT, "todo_add", browserAdd("Book the movers"), List.of("U"),
                auto("ap-undoundoundoundoundo"))).get("id");
        assertThat(host.undoAuto("ap-undoundoundoundoundo", Caller.THE_OWNER, (c, a) -> true, () -> { }))
                .containsEntry("outcome", "ok");
        assertThat((Map<String, Object>) member("todo.get", Map.of("id", id3)).get("item")).containsEntry("state", "not_needed");
        // W3's agent.approval.undo, from deskd's own ledger of the unasked call, reaches the same undo by its id.
        String id4 = (String) content(tcall(RUN, AGENT, "todo_add", browserAdd("Book the van"), List.of("U"),
                auto("ap-vanvanvanvanvanvanva"))).get("id");
        assertThat(host.undoAuto("ap-vanvanvanvanvanvanva", Caller.THE_OWNER, (c, a) -> true, () -> { }))
                .containsEntry("outcome", "ok");
        assertThat((Map<String, Object>) member("todo.get", Map.of("id", id4)).get("item")).containsEntry("state", "not_needed");
        assertThat(host.undoAuto("ap-vanvanvanvanvanvanva", Caller.THE_OWNER, (c, a) -> true, () -> { }))
                .containsEntry("outcome", "already");
    }

    /**
     * Security's AAB-L2: an unasked call under an approved card's id is its own (keyed {@code auto:<id>}), and the
     * member's Undo of it takes back only what that call did, never the change the member approved on the card.
     */
    @Test
    void anUnaskedCallUnderACardsIdIsItsOwnAndItsUndoLeavesTheCardsChange() throws Exception {
        switches.put(AGENT + "/todos", true);
        memberStartsTheRun();
        readThePage(RUN, AGENT);
        Map<String, Object> chat = addArgs("Wire the deposit", "agent_chat", Map.of("messageId", "msg-1"));
        Map<String, Object> look = r(tcall(RUN, AGENT, "todo_add", chat, List.of("U"), Map.of("phase", "look")));
        Map<String, Object> payload = (Map<String, Object>) look.get("payload");
        String card = approvalId();
        String sha = ToolHost.hash(AGENT, RUN, "todo_add", "agent", payload);
        assertThat(rig.call(owner, "agent.approval.decide", Map.of("approvalId", card, "approve", true, "sha256", sha)))
                .containsEntry("_kind", "RES");
        String approved = (String) content(tcall(RUN, AGENT, "todo_add", payload, List.of("U"),
                Map.of("approval", Map.of("approvalId", card, "sha256", sha), "context", "agent"))).get("id");
        // A wrong desk-agent's unasked add under the card's id: deskd's ledger never ran that id, so it runs, as its own.
        Map<String, Object> unasked = content(tcall(RUN, AGENT, "todo_add", browserAdd("Book the movers"), List.of("U"),
                auto(card)));
        assertThat(unasked).containsEntry("created", true);
        assertThat(unasked.get("id")).isNotEqualTo(approved);
        // The member's Undo of that row: only it is taken back; the card's add stays open.
        assertThat(host.undoAuto(card, Caller.THE_OWNER, (c, a) -> true, () -> { })).containsEntry("outcome", "ok");
        assertThat((Map<String, Object>) member("todo.get", Map.of("id", unasked.get("id"))).get("item"))
                .containsEntry("state", "not_needed");
        assertThat((Map<String, Object>) member("todo.get", Map.of("id", approved)).get("item"))
                .containsEntry("state", "open");
    }

    @Test
    void anotherAgentsItemIsntYoursAndAnUntrustedReadTaintsTheRun() throws Exception {
        switches.put(AGENT + "/todos", true);
        switches.put(OTHER + "/todos", true);
        readThePage("run-o", OTHER);
        String theirs = (String) content(tcall("run-o", OTHER, "todo_add", browserAdd("Renew the parking permit"),
                List.of("U"), auto(approvalId()))).get("id");
        // A clean run of another agent, unattended: its list read now holds U, from the untrusted item.
        Map<String, Object> list = r(tcall("run-x", AGENT, "todo_list", Map.of(), List.of(), null));
        assertThat((List<String>) list.get("taints")).contains("U", "S");
        assertThat((List<String>) tcall("run-x", AGENT, "todo_list", Map.of(), List.of(), null).get("taint")).contains("U");
        long rev = ((Number) ((Map<String, Object>) member("todo.get", Map.of("id", theirs)).get("item")).get("rev"))
                .longValue();
        assertThat(refused(tcall("run-y", AGENT, "todo_update", Map.of("id", theirs, "rev", rev, "note", "x"), List.of(),
                auto(approvalId())))).isEqualTo("not_yours");
        // A stale rev is refused before anything is asked.
        memberStartsTheRun();
        assertThat(r(tcall(RUN, AGENT, "todo_update", Map.of("id", theirs, "rev", rev + 99, "note", "x"), List.of(),
                Map.of("phase", "look")))).containsEntry("refusal", "stale");
    }

    /**
     * Desk Maia's away run (Maia Mode Phase 2; the staging proof of Nov 15): a run the member didn't start (a report
     * batch or a check-in, holding U from the reports), filing a to-do from what a desk's agent reported. Her run names
     * the answers in her thread ({@code origin: {kind: "maia", answers}}); deskd gives the ones it opened for her, so
     * {@code desk {}} is a source this run was given: in the {@code todos} group, done without a tap under her switch,
     * the item marked untrusted with the answer's label. The member's message isn't hers to name (she didn't start
     * from one), no other agent gets her reports, and without the origin it stays refused {@code source_unknown}.
     */
    @Test
    void deskMaiasAwayRunFilesAToDoFromAReportWithoutATapMarkedUntrusted() throws Exception {
        String maia = "maia";
        String grant = "dg-maiaaaaaaaaaaaaaaaaa";
        com.minimalistalliance.desk.deskd.desks.DeskMessaging home = new com.minimalistalliance.desk.deskd.desks
                .DeskMessaging(rig.clock, () -> "d-home", () -> "user-1", () -> false);
        home.keepIn(Files.createDirectories(dir.resolve("home")));
        com.minimalistalliance.desk.deskd.desks.DeskMessaging work = new com.minimalistalliance.desk.deskd.desks
                .DeskMessaging(rig.clock, () -> "d-work", () -> "user-1", () -> false);
        work.keepIn(Files.createDirectories(dir.resolve("work")));
        work.open(carry(home.offer(grant, maia, "Maia", "d-work")));
        home.open(carry(work.accept(grant, "manager", "Lead")));
        host.origins(home.sources()::origin);
        // The Lead's report on her brief, opened on the home desk after her wait.
        String reportId = (String) home.open(carry(work.answer("manager", "Lead", grant, "env-" + "a".repeat(26),
                "[report] status=done fields: {\"tip1\":\"Lead with the headline\"}", null, false))).get("id");
        switches.put(maia + "/todos", true);

        String away = "run-away-batch";
        Map<String, Object> origin = Map.of("origin", Map.of("kind", "maia", "answers", List.of(reportId)));
        Map<String, Object> fromReport = addArgs("Lead with the headline in the weekly update", "desk", Map.of());
        // Without the origin (desk-agent before this fix): no desk source for this run.
        assertThat(r(tcall(away, maia, "todo_add", fromReport, List.of("U"), Map.of("phase", "look"))))
                .containsEntry("refusal", "source_unknown");
        Map<String, Object> look = new LinkedHashMap<>(Map.of("phase", "look"));
        look.putAll(origin);
        Map<String, Object> seen = r(tcall(away, maia, "todo_add", fromReport, List.of("U"), look));
        assertThat(seen).containsEntry("risk", "write").containsEntry("group", "todos").containsEntry("refusal", null);
        Map<String, Object> unasked = new LinkedHashMap<>(auto(approvalId()));
        unasked.putAll(origin);
        Map<String, Object> added = content(tcall(away, maia, "todo_add", (Map<String, Object>) seen.get("payload"),
                List.of("U"), unasked));
        assertThat(added).containsEntry("created", true);
        Map<String, Object> item = open().get(0);
        assertThat(item).containsEntry("by", "agent:" + maia).containsEntry("untrusted", true);
        assertThat((Map<String, Object>) item.get("source")).containsEntry("kind", "desk")
                .containsEntry("label", "Answer from Lead on another of your desks");

        // Even if desk-agent sent no U, deskd's own record of the report marks the item untrusted.
        String clean = "run-away-clean";
        Map<String, Object> second = new LinkedHashMap<>(auto(approvalId()));
        second.putAll(origin);
        content(tcall(clean, maia, "todo_add", addArgs("Say what's blocked, with dates", "desk", Map.of()), List.of(),
                second));
        assertThat(open()).hasSize(2).allSatisfy(i -> assertThat(i).containsEntry("untrusted", true));

        // The member's message: she didn't start from one, so it isn't hers to name; nothing more is unasked.
        assertThat(r(tcall(away, maia, "todo_add", addArgs("Anything", "agent_chat", Map.of()), List.of("U"), look)))
                .containsEntry("refusal", "source_unknown");
        // Another agent naming her report is given nothing.
        Map<String, Object> theirs = new LinkedHashMap<>(Map.of("phase", "look"));
        theirs.putAll(origin);
        assertThat(r(tcall("run-other", AGENT, "todo_add", fromReport, List.of("U"), theirs)))
                .containsEntry("refusal", "source_unknown");
    }

    private static Map<String, Object> carry(com.minimalistalliance.desk.deskd.desks.DeskMessaging.Made made)
            throws Exception {
        return com.minimalistalliance.desk.deskd.protocol.Json.parseObject(
                com.minimalistalliance.desk.deskd.protocol.Json.bytes(made.envelope()));
    }
}
