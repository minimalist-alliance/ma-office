package com.minimalistalliance.desk.agent.harness;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.RunCallStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.io.TempDir;

/**
 * The fault matrix (draft ADR §17, "Faults"; durable runs' sizing §4): every kill point a call goes through, times
 * three faults (desk-agent killed, deskd restarted, the whole desk stopped), times six kinds of call (a read, the
 * agent's own write, a write the member approves, a write done without asking under the member's switch, a delete, a
 * send), plus the tool's store away and its disk full. Against the {@link CountingDeskd}, which counts every call deskd
 * actually ran.
 *
 * <p>The bar, for every case: <b>0 double executions and 0 silent losses</b>. After the fault and the desk's own
 * recovery, the call ran at most once; a call that ran is recorded {@code done}, or {@code interrupted} ("it may have
 * happened: check"), never {@code failed} or {@code expired}; one that didn't run is never recorded {@code done};
 * nothing is left {@code pending}, {@code approved}, {@code started} or {@code streaming}; the audit chain verifies;
 * a call that changed the member's things shows the member how it ended (its card, or for one done without asking its
 * approval row, §15); and the member's yes to the old card after it all runs nothing.
 *
 * <p>Then {@link #everyHostedTool} puts every registered deskd tool ({@link ToolCases}) through the kill points that
 * matter most, so a new tool is fault-tested by its registration line alone.
 *
 * <p><b>Known failures</b> ({@link #KNOWN}) are today's, each with its owner, and listed in
 * {@code target/harness/fault-matrix.md}. The list is strict: a known failure that now passes fails too, so whoever
 * fixed it deletes its line.
 */
class FaultMatrixTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    /** Where a fault strikes. */
    enum Point {
        /** The model is writing the step that makes the call. */
        MODEL,
        /** deskd is looking at the call, before any card. */
        LOOK,
        /** The card waits for the member. */
        ASKED,
        /** deskd has the member's yes (its ticket); desk-agent hasn't heard it yet. */
        RELAYED,
        /** The call's frame is on its way to deskd. */
        SENT,
        /** deskd is running the call; it hasn't taken effect. */
        RUNNING,
        /** The call took effect; its answer hasn't come back. */
        RAN,
        /** The call's record is settled; its card isn't yet. */
        SETTLING,
        /** The call is settled; the model is writing the next step. */
        SETTLED,
        /** The run has ended. */
        ENDED
    }

    enum Fault { AGENT_KILL, DESKD_RESTART, DESK_STOP, STORE_AWAY, DISK_FULL }

    /** The six kinds of call, each with the tool that stands for it. */
    enum CallKind {
        READ("files_read", false, false),
        OWN("workspace_write", false, false),
        WRITE("files_write", true, false),
        AUTO("files_write", false, true),
        DELETE("files_trash", true, false),
        SEND("browser_click", true, false);

        final String tool;
        final boolean asks;
        final boolean auto;

        CallKind(String tool, boolean asks, boolean auto) {
            this.tool = tool;
            this.asks = asks;
            this.auto = auto;
        }

        boolean hosted() {
            return ToolCases.of(tool).hosted();
        }

        boolean changes() {
            return this != READ;
        }
    }

    /**
     * Today's failures, by case id, each with what it is and whose it is. Strict: delete a line when its case passes.
     * None since Nov 14: the five cases of an unasked call cut off by a kill (`auto/{running,ran,settling}/agent-kill`,
     * `auto/{ran,settling}/desk-stop`, HIDDEN) pass with W3's approval rows and the durable resume on main. A new line
     * is {@code Map.entry("<case>", "<what, and whose>")} here, with its exact problems in {@link #KNOWN_PROBLEMS}.
     */
    static final Map<String, String> KNOWN = Map.of();

    /** Each known case's problems, exactly, as the judge names them: anything more in it fails (Security's MMH-L1). */
    static final Map<String, List<String>> KNOWN_PROBLEMS = Map.of();

    private static final Map<String, Result> RESULTS = new ConcurrentHashMap<>();

    @TempDir
    static Path root;

    record Result(String id, boolean applicable, List<String> problems, String detail) {}

    // ---------------------------------------------------------------- the factories

    @TestFactory
    Stream<DynamicTest> matrix() {
        List<DynamicTest> tests = new ArrayList<>();
        for (CallKind kind : CallKind.values()) {
            for (Point point : Point.values()) {
                for (Fault fault : List.of(Fault.AGENT_KILL, Fault.DESKD_RESTART, Fault.DESK_STOP)) {
                    if (applies(kind, point)) {
                        String id = id(kind.name(), point, fault);
                        tests.add(DynamicTest.dynamicTest(id, () -> judge(id, run(id, kind.tool, kind, point,
                                fault))));
                    }
                }
            }
            if (kind.hosted()) {
                for (Fault fault : List.of(Fault.STORE_AWAY, Fault.DISK_FULL)) {
                    String id = id(kind.name(), Point.RUNNING, fault);
                    tests.add(DynamicTest.dynamicTest(id, () -> judge(id, run(id, kind.tool, kind, Point.RUNNING,
                            fault))));
                }
            }
        }
        return tests.stream();
    }

    @TestFactory
    Stream<DynamicTest> everyHostedTool() {
        List<DynamicTest> tests = new ArrayList<>();
        for (ToolCases.Case c : ToolCases.all().values()) {
            if (!c.hosted() || ToolCases.NOT_IN_MATRIX.containsKey(c.tool())) {
                continue;
            }
            CallKind kind = switch (c.kind()) {
                case READ -> CallKind.READ;
                case DELETE -> CallKind.DELETE;
                case SEND -> CallKind.SEND;
                default -> CallKind.WRITE;
            };
            for (Point point : List.of(Point.RUNNING, Point.RAN)) {
                for (Fault fault : List.of(Fault.AGENT_KILL, Fault.DESKD_RESTART)) {
                    String id = "tool:" + c.tool() + "/" + point.name().toLowerCase() + "/" + word(fault);
                    tests.add(DynamicTest.dynamicTest(id, () -> judge(id, run(id, c.tool(), kind, point, fault))));
                }
            }
        }
        return tests.stream();
    }

    private static String id(String kind, Point point, Fault fault) {
        return kind.toLowerCase() + "/" + point.name().toLowerCase() + "/" + word(fault);
    }

    private static String word(Fault fault) {
        return fault.name().toLowerCase().replace('_', '-');
    }

    static boolean applies(CallKind kind, Point point) {
        return switch (point) {
            case LOOK, SENT, RUNNING, RAN -> kind.hosted();
            case ASKED, RELAYED -> kind.asks;
            default -> true;
        };
    }

    private static void judge(String id, Result result) {
        RESULTS.put(id, result);
        String known = KNOWN.get(id);
        if (result.problems().isEmpty()) {
            assertThat(known).as("%s now passes: delete its line from FaultMatrixTest.KNOWN (%s)", id, result.detail())
                    .isNull();
        } else {
            assertThat(known).as("%s: %s (%s)", id, result.problems(), result.detail()).isNotNull();
            // A known case passes only with exactly its own problem, so a new one in it (a double, a loss) still fails.
            assertThat(result.problems()).as("%s has more than its known problem (%s)", id, result.detail())
                    .containsExactlyElementsOf(KNOWN_PROBLEMS.get(id));
        }
    }

    // ---------------------------------------------------------------- one case

    /** One start of desk-agent on the case's files, with its own link to the case's deskd. */
    private static final class Desk {
        final TeamDesk desk;
        final CountingDeskd.Link link;

        Desk(TeamDesk desk, CountingDeskd.Link link) {
            this.desk = desk;
            this.link = link;
        }
    }

    private static Desk start(Path data, MutableClock clock, CountingDeskd deskd, boolean auto) throws Exception {
        TeamDesk desk = new TeamDesk(data, clock);
        CountingDeskd.Link link = deskd.attach();
        desk.service.deskLink(link);
        // A short look-again window: the restarted deskd answers at once, and a killed process's thread lets go soon.
        desk.service.agentTools().confirmFor(Duration.ofSeconds(2));
        if (auto) {
            HarnessDesk.autoOn(desk.service, Set.of("files"));
        }
        return new Desk(desk, link);
    }

    @SuppressWarnings("unchecked")
    static Result run(String id, String tool, CallKind kind, Point point, Fault fault) throws Exception {
        return run(id, tool, kind, point, fault, deskd -> { });
    }

    /** One case, with {@code broken} setting the counting deskd up first (the self-test breaks it on purpose). */
    static Result run(String id, String tool, CallKind kind, Point point, Fault fault,
            java.util.function.Consumer<CountingDeskd> broken) throws Exception {
        Path data = Files.createDirectories(root.resolve(id.replaceAll("[^a-z0-9_-]", "_")));
        String canary = "mm" + Integer.toHexString(id.hashCode() & 0xffffff);
        MutableClock clock = new MutableClock(Rig.START);
        CountingDeskd deskd = new CountingDeskd();
        deskd.clock = clock::millis;
        ToolCases.Case c = ToolCases.of(tool);
        if (c.result() != null) {
            deskd.results.put(tool, args -> c.result().apply(canary));
        }
        if (c.lookRisk() != null) {
            deskd.lookRisk.put(tool, c.lookRisk());
        }
        broken.accept(deskd);
        CountDownLatch release = new CountDownLatch(1);
        List<TeamDesk> dead = new ArrayList<>();
        Desk d = start(data, clock, deskd, kind.auto);
        try {
            String a = d.desk.agent("Alice");
            if (tool.startsWith("courier_")) {
                // Courier is off for a new agent until the member switches it on (§12).
                d.desk.service.call("agent.access.set", HarnessDesk.m("agentId", a, "apps", Map.of("courier", true)));
            }
            if (kind.auto) {
                deskd.switchOn(a, "files");
            }
            Map<String, Object> args = ToolCases.args(tool, null, canary);
            AtomicInteger chats = new AtomicInteger();
            d.desk.provider.onChat = r -> chats.incrementAndGet();
            Step first = Step.calls(USAGE, List.of(new ToolCall("c1", tool, args)), "Step one.");
            Step second = Step.answer(USAGE, "Done.");
            d.desk.provider.then(point == Point.MODEL ? first.heldBy(release) : first)
                    .then(point == Point.SETTLED ? second.heldBy(release) : second);
            if (fault == Fault.STORE_AWAY) {
                deskd.store = CountingDeskd.Store.AWAY;
            } else if (fault == Fault.DISK_FULL) {
                deskd.store = CountingDeskd.Store.FULL;
            }
            CountDownLatch settling = new CountDownLatch(1);
            if (point == Point.SETTLING) {
                TeamDesk at = d.desk;
                at.service.runCalls().afterSettledForTest(key -> {
                    try {
                        RunCallStore.Call call = at.service.runCalls().store().get(key);
                        if (call != null && call.tool().equals(tool)) {
                            settling.countDown();
                            release.await(30, TimeUnit.SECONDS);
                        }
                    } catch (Exception e) {
                        // a closed store after the kill: nothing to wait for
                    }
                });
            }
            boolean storeFault = fault == Fault.STORE_AWAY || fault == Fault.DISK_FULL;
            switch (storeFault ? Point.ENDED : point) {
                case LOOK -> deskd.holdAt(CountingDeskd.Point.LOOK, tool);
                case SENT -> deskd.holdAt(CountingDeskd.Point.RECEIVED, tool);
                case RUNNING -> deskd.holdAt(CountingDeskd.Point.RUNNING, tool);
                case RAN -> deskd.holdAt(CountingDeskd.Point.RAN, tool);
                default -> { }
            }
            Map<String, Object> sent = d.desk.call("agent.message.send", "agentId", a, "text", "Do it.");
            String runId = (String) sent.get("runId");

            // ---- drive to the point
            boolean relayed = false;
            Map<String, Object> card = null;
            switch (storeFault ? Point.ENDED : point) {
                case MODEL -> await().atMost(Duration.ofSeconds(10)).until(() -> chats.get() >= 1);
                case LOOK -> assertThat(deskd.awaitHeld(Duration.ofSeconds(10))).as("the look").isTrue();
                case ASKED -> card = awaitCard(d.desk, a);
                case RELAYED -> {
                    card = awaitCard(d.desk, a);
                    deskd.relay((String) card.get("id"), sha(card), a);
                    relayed = true;
                }
                case SENT, RUNNING, RAN -> {
                    if (kind.asks) {
                        approve(d.desk, deskd, awaitCard(d.desk, a));
                    }
                    assertThat(deskd.awaitHeld(Duration.ofSeconds(10))).as("the call at %s", point).isTrue();
                }
                case SETTLING -> {
                    if (kind.asks) {
                        approve(d.desk, deskd, awaitCard(d.desk, a));
                    }
                    assertThat(settling.await(10, TimeUnit.SECONDS)).as("the settle").isTrue();
                }
                case SETTLED -> {
                    if (kind.asks) {
                        approve(d.desk, deskd, awaitCard(d.desk, a));
                    }
                    await().atMost(Duration.ofSeconds(10)).until(() -> chats.get() >= 2);
                }
                case ENDED -> {
                    if (kind.asks) {
                        approve(d.desk, deskd, awaitCard(d.desk, a));
                    }
                    d.desk.reply(a, 2);
                }
            }

            // ---- the fault
            boolean killAgent = fault == Fault.AGENT_KILL || fault == Fault.DESK_STOP;
            boolean restartDeskd = fault == Fault.DESKD_RESTART || fault == Fault.DESK_STOP;
            if (killAgent) {
                if (point == Point.SENT) {
                    // The frame died with the connection: deskd never read it.
                    deskd.dropHeld();
                }
                deskd.cut(d.link);
                d.desk.kill();
                dead.add(d.desk);
            }
            if (restartDeskd) {
                deskd.restart();
            }
            deskd.release();
            if (killAgent) {
                d = start(data, clock, deskd, kind.auto);
            } else if (point == Point.MODEL || point == Point.SETTLED || point == Point.SETTLING) {
                release.countDown();
            }
            if (relayed && !killAgent) {
                // The member's yes reaches desk-agent after deskd restarted: deskd no longer holds its ticket.
                d.desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", true, "sha256",
                        sha(card));
            }

            // ---- the desk's own recovery, the member answering any card that's still asking
            TeamDesk now = d.desk;
            await().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(50)).until(() -> {
                for (Map<String, Object> pending : list(now.call("agent.approvals.list", "agentId", a)
                        .get("approvals"))) {
                    approve(now, deskd, pending);
                }
                return settled(now, a, runId);
            });

            // ---- what happened
            int runs = runsOf(kind, tool, deskd, data, canary);
            List<Map<String, Object>> cards = list(now.call("agent.approvals.list", "agentId", a, "state", "all")
                    .get("approvals"));
            List<Map<String, Object>> mine = cards.stream().filter(x -> tool.equals(x.get("tool"))).toList();
            List<RunCallStore.Call> records = now.service.runCalls().store().ofRun(runId).stream()
                    .filter(x -> x.tool().equals(tool)).toList();
            Map<String, Object> reply = replyOf(now, a, runId);

            // The member's yes to every old card, after it all: nothing runs.
            int before = runs;
            boolean staleRan = false;
            for (Map<String, Object> old : mine) {
                try {
                    now.call("agent.approval.decide", "approvalId", old.get("id"), "approve", true, "sha256",
                            sha(old));
                } catch (RpcError expected) {
                    // answered, expired: refused, as it should be
                }
            }
            Thread.sleep(50);
            if (runsOf(kind, tool, deskd, data, canary) != before) {
                staleRan = true;
            }

            List<String> problems = new ArrayList<>();
            String cardState = mine.isEmpty() ? "none" : String.valueOf(mine.get(mine.size() - 1).get("state"));
            String recordState = records.isEmpty() ? "none" : records.get(records.size() - 1).state();
            if (runs > 1) {
                problems.add("DOUBLE");
            }
            if (mine.size() > 1) {
                problems.add("TWO_CARDS");
            }
            if (runs == 1 && kind.changes()) {
                if (!Set.of("done", "interrupted").contains(recordState)) {
                    problems.add("SILENT_LOSS(record " + recordState + ")");
                }
                if (kind.asks && !Set.of("done", "interrupted").contains(cardState)) {
                    problems.add("SILENT_LOSS(card " + cardState + ")");
                }
            }
            if (runs == 0 && (recordState.equals("done") || cardState.equals("done"))) {
                problems.add("PHANTOM");
            }
            if (Set.of("pending", "approved").contains(cardState) || recordState.equals("started")
                    || "streaming".equals(reply.get("state"))) {
                problems.add("STUCK");
            }
            if (!now.audit.verify().intact()) {
                problems.add("CHAIN");
            }
            if (kind.auto && runs == 1 && mine.isEmpty() && !chipShows(reply, tool)) {
                // §15: every unasked call writes an approval row the member sees, with how it ended.
                problems.add("HIDDEN");
            }
            if (staleRan) {
                problems.add("STALE_YES");
            }
            String detail = "ran " + runs + ", card " + cardState + ", record " + recordState + ", reply "
                    + reply.get("state") + (reply.get("errorDetail") != null ? " " + reply.get("errorDetail") : "");
            return new Result(id, true, problems, detail);
        } finally {
            release.countDown();
            deskd.release();
            for (TeamDesk t : dead) {
                t.service.stopAll();
            }
            d.desk.close();
        }
    }

    // ---------------------------------------------------------------- helpers

    private static Map<String, Object> awaitCard(TeamDesk desk, String agentId) {
        List<Map<String, Object>> last = new ArrayList<>();
        await().atMost(Duration.ofSeconds(10)).until(() -> {
            last.clear();
            last.addAll(list(desk.call("agent.approvals.list", "agentId", agentId).get("approvals")));
            return !last.isEmpty();
        });
        return last.get(0);
    }

    private static String sha(Map<String, Object> card) {
        return Approvals.hash((String) card.get("agentId"), (String) card.get("runId"), (String) card.get("tool"),
                (String) card.get("context"), map(card.get("payload")));
    }

    /** The member's yes from their session: deskd relays it (its ticket), then desk-agent hears it. */
    static void approve(TeamDesk desk, CountingDeskd deskd, Map<String, Object> card) throws Exception {
        deskd.relay((String) card.get("id"), sha(card), (String) card.get("agentId"));
        try {
            desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", true, "sha256", sha(card));
        } catch (RpcError e) {
            // decided meanwhile
        }
    }

    private static boolean settled(TeamDesk desk, String agentId, String runId) throws Exception {
        for (Map<String, Object> m : desk.thread(agentId)) {
            if ("streaming".equals(m.get("state"))) {
                return false;
            }
        }
        if (!list(desk.call("agent.approvals.list", "agentId", agentId).get("approvals")).isEmpty()) {
            return false;
        }
        return desk.service.runCalls().store().startedOf(runId).isEmpty();
    }

    private static Map<String, Object> replyOf(TeamDesk desk, String agentId, String runId) throws Exception {
        Map<String, Object> last = Map.of();
        for (Map<String, Object> m : desk.thread(agentId)) {
            if (runId.equals(m.get("runId")) || "assistant".equals(m.get("role"))) {
                last = m;
            }
        }
        return last;
    }

    private static boolean chipShows(Map<String, Object> reply, String tool) {
        Object tools = reply.get("tools");
        if (!(tools instanceof List<?> chips)) {
            return false;
        }
        for (Object chip : chips) {
            if (chip instanceof Map<?, ?> m && tool.equals(m.get("name"))) {
                return true;
            }
        }
        return false;
    }

    /** How many times the call took effect: deskd's count, or for the agent's own write, whether its file is there. */
    private static int runsOf(CallKind kind, String tool, CountingDeskd deskd, Path data, String canary)
            throws IOException {
        if (kind.hosted()) {
            return deskd.executionsOf(tool).size();
        }
        String name = "notes-" + canary + ".md";
        try (Stream<Path> files = Files.walk(data)) {
            return (int) files.filter(p -> p.getFileName().toString().equals(name)).count();
        }
    }

    // ---------------------------------------------------------------- the report

    @AfterAll
    static void report() throws IOException {
        if (RESULTS.isEmpty()) {
            return;
        }
        Map<String, Result> sorted = new TreeMap<>(RESULTS);
        StringBuilder md = new StringBuilder();
        long failing = sorted.values().stream().filter(r -> !r.problems().isEmpty()).count();
        long mayHave = sorted.values().stream().filter(r -> r.detail().startsWith("ran 1")
                && r.detail().contains("interrupted,")).count();
        md.append("# Fault matrix\n\n").append(sorted.size()).append(" cases, ").append(failing)
                .append(" failing (all of them known: the test fails on any other). ").append(mayHave)
                .append(" end `interrupted` though the call ran (\"it may have happened: check\"): honest; the"
                        + " durable resume settles the rest by key.\n\n")
                .append("| Case | Result | What happened |\n|---|---|---|\n");
        for (Result r : sorted.values()) {
            md.append("| `").append(r.id()).append("` | ")
                    .append(r.problems().isEmpty() ? "pass" : "**" + String.join(", ", r.problems()) + "**")
                    .append(" | ").append(r.detail()).append(KNOWN.containsKey(r.id()) ? " — " + KNOWN.get(r.id()) : "")
                    .append(" |\n");
        }
        md.append("\nHosted tools not in the per-tool rows: ");
        ToolCases.NOT_IN_MATRIX.forEach((tool, why) -> md.append("`").append(tool).append("` (").append(why).append("); "));
        md.append("\n");
        Path out = Path.of("target", "harness");
        Files.createDirectories(out);
        Files.writeString(out.resolve("fault-matrix.md"), md.toString(), StandardCharsets.UTF_8);
    }

    // Keeps the import of ChatRequest honest for readers of what the provider saw.
    @SuppressWarnings("unused")
    private static int requests(TeamDesk desk) {
        List<ChatRequest> r = desk.requests();
        return r.size();
    }

    @SuppressWarnings("unused")
    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }
}
