package com.minimalistalliance.desk.agent.harness;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import com.minimalistalliance.desk.agent.tool.ToolRegistry;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

/**
 * The audit canary (draft ADR §7 and §17, "Audit": "a test that plants a string in every argument and finds it nowhere
 * in the log"). One run-unique string goes into every string argument of a call of every tool an agent can be offered
 * (the lead's and a staff agent's, so every declaration in {@link ToolRegistry} is reached), into every result deskd
 * gives, into the member's message, a decline's note and the model's own text; through every outcome the log records
 * (asked and approved, declined, stopped, done without asking, a memory save under U that asks, refused before
 * asking). Then it is in no audit row (actor, action, target, decision), in none of the audit file's bytes (WAL
 * included), in no form (as is, base64, upper case), and in no log line desk-agent wrote while it ran.
 */
class AuditCanaryTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private final CountingDeskd deskd = new CountingDeskd();
    private final ListAppender<ILoggingEvent> logs = new ListAppender<>();
    private TeamDesk desk;
    private String canary;

    @BeforeEach
    void start() throws Exception {
        byte[] r = new byte[8];
        new SecureRandom().nextBytes(r);
        canary = "mmcanary-" + HexFormat.of().formatHex(r);
        deskd.clock = clock::millis;
        for (ToolCases.Case c : ToolCases.all().values()) {
            if (c.result() != null) {
                deskd.results.put(c.tool(), args -> c.result().apply(canary));
            }
            if (c.lookRisk() != null) {
                deskd.lookRisk.put(c.tool(), c.lookRisk());
            }
        }
        if (LoggerFactory.getILoggerFactory() instanceof LoggerContext context) {
            logs.setContext(context);
            logs.start();
            context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME).addAppender(logs);
        }
        desk = new TeamDesk(data, clock);
        desk.service.deskLink(deskd.attach());
        desk.service.agentTools().confirmFor(Duration.ofSeconds(1));
    }

    @AfterEach
    void stop() {
        if (LoggerFactory.getILoggerFactory() instanceof LoggerContext context) {
            Logger root = context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
            root.detachAppender(logs);
        }
        desk.close();
    }

    private Map<String, Object> awaitCardOrEnd(String agentId, int before) {
        List<Map<String, Object>> cards = new ArrayList<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            cards.clear();
            cards.addAll(list(desk.call("agent.approvals.list", "agentId", agentId).get("approvals")));
            if (!cards.isEmpty()) {
                return true;
            }
            List<Map<String, Object>> thread = desk.thread(agentId);
            return thread.size() >= before + 2 && thread.stream().noneMatch(m -> "streaming".equals(m.get("state")));
        });
        return cards.isEmpty() ? null : cards.get(0);
    }

    private static String sha(Map<String, Object> card) {
        return Approvals.hash((String) card.get("agentId"), (String) card.get("runId"), (String) card.get("tool"),
                (String) card.get("context"), map(card.get("payload")));
    }

    /** One run in which the model calls {@code tool} with {@code args}; every card answered by {@code answer}. */
    private void runOne(String agentId, String tool, Map<String, Object> args, String answer) throws Exception {
        int before = desk.thread(agentId).size();
        // Every scripted step was used by the run before: the model's steps line up with this run.
        assertThat(desk.provider.pending()).as("steps left over before %s", tool).isZero();
        desk.provider.then(Step.calls(USAGE, List.of(new ToolCall("c-" + tool, tool, args)), "Working on " + canary));
        if (!answer.equals("stop")) {
            // A stopped run never asks the model again.
            desk.provider.then(Step.answer(USAGE, "Finished " + canary));
        }
        desk.call("agent.message.send", "agentId", agentId, "text", "Please do this: " + canary);
        while (true) {
            Map<String, Object> card = awaitCardOrEnd(agentId, before);
            if (card == null) {
                break;
            }
            switch (answer) {
                case "decline" -> desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", false,
                        "sha256", sha(card), "note", "No, because " + canary);
                case "stop" -> desk.call("agent.run.stop", "runId", card.get("runId"));
                default -> {
                    deskd.relay((String) card.get("id"), sha(card), agentId);
                    try {
                        desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", true, "sha256",
                                sha(card));
                    } catch (RpcError e) {
                        // decided meanwhile
                    }
                }
            }
        }
        desk.settled(agentId);
    }

    private List<ToolSpec> offered(String agentId, boolean member) throws Exception {
        return desk.service.agentTools().wrap(desk.team.setupFor(agentId), agentId, member).tools().specs();
    }

    @Test
    void aStringPlantedInEveryArgumentIsNowhereInTheLog() throws Exception {
        desk.bindLead();
        String staff = desk.agent("Alice");
        String other = desk.agent("Bob");
        desk.link(staff, other, "Anything.");
        // Courier's reads are off for a new agent (§12): on for Alice, so the canary goes through their arguments too.
        desk.call("agent.access.set", "agentId", staff, "apps", Map.of("courier", true));

        Map<String, String> who = new LinkedHashMap<>();
        Map<String, Map<String, Object>> schemas = new LinkedHashMap<>();
        for (String agent : List.of(AgentStore.MANAGER, staff)) {
            for (ToolSpec spec : offered(agent, false)) {
                who.putIfAbsent(spec.name(), agent);
                schemas.putIfAbsent(spec.name(), spec.inputSchema());
            }
        }
        // Every declared tool is reached, so a new one can't slip past the canary: a tool the setup doesn't list (the
        // memory runner's) is called with its declaration's schema.
        Set<String> declared = new LinkedHashSet<>();
        for (ToolDecl decl : new ToolRegistry().all()) {
            declared.add(decl.name());
            if (!who.containsKey(decl.name())) {
                who.put(decl.name(), staff);
                schemas.put(decl.name(), decl.schema());
            }
        }

        List<String> ran = new ArrayList<>();
        for (Map.Entry<String, String> e : who.entrySet()) {
            String tool = e.getKey();
            Map<String, Object> args = ToolCases.args(tool, schemas.get(tool), canary);
            if (tool.equals("message_agent")) {
                args = new LinkedHashMap<>(args);
                args.put("to", other);
            }
            runOne(e.getValue(), tool, args, "approve");
            ran.add(tool);
        }
        // A decline with a note, and a stop while a card waits, for every tool that asks.
        for (String tool : List.of("files_write", "files_trash", "notebook_write", "browser_click", "follow_up")) {
            runOne(staff, tool, ToolCases.args(tool, schemas.get(tool), canary), "decline");
            runOne(staff, tool, ToolCases.args(tool, schemas.get(tool), canary), "stop");
        }
        // Done without asking, under the member's switch: its approval.auto row.
        HarnessDesk.autoOn(desk.service, Set.of("files", "notebook"));
        deskd.switchOn(staff, "files");
        deskd.switchOn(staff, "notebook");
        String fresh = desk.agent("Carol");
        deskd.switchOn(fresh, "files");
        deskd.switchOn(fresh, "notebook");
        runOne(fresh, "files_write", ToolCases.args("files_write", null, canary), "approve");
        runOne(fresh, "notebook_write", ToolCases.args("notebook_write", null, canary), "approve");
        // A read that makes the run untrusted, then a memory save under U, which asks.
        int before = desk.thread(fresh).size();
        desk.provider.then(Step.calls(USAGE, List.of(new ToolCall("r1", "files_read", ToolCases.args("files_read",
                null, canary))), "Reading " + canary))
                .then(Step.calls(USAGE, List.of(new ToolCall("m1", "memory_save", ToolCases.args("memory_save",
                        schemas.get("memory_save"), canary))), "Remembering " + canary))
                .then(Step.answer(USAGE, "Done " + canary));
        desk.call("agent.message.send", "agentId", fresh, "text", "Read it and remember " + canary);
        Map<String, Object> memoryCard = awaitCardOrEnd(fresh, before);
        assertThat(memoryCard).as("a memory save under U asks").isNotNull();
        desk.call("agent.approval.decide", "approvalId", memoryCard.get("id"), "approve", true, "sha256",
                sha(memoryCard));
        desk.settled(fresh);
        // Refused before asking: a tool the member switched off for the agent (scope), and bad input.
        runOne(staff, "files_write", Map.of("path", 7, "text", canary), "approve");

        // ---- the log
        List<AuditLog.Row> rows = desk.audit.readBefore(null, 1_000_000);
        assertThat(rows).as("the log has rows").hasSizeGreaterThan(50);
        assertThat(rows.stream().map(r -> r.entry().action())).contains("tool.call", "approval.ask",
                "approval.decide", "approval.expire", "approval.auto");
        List<String> forms = List.of(canary, canary.toUpperCase(), Base64.getEncoder().encodeToString(canary
                .getBytes(StandardCharsets.UTF_8)), canary.substring("mmcanary-".length()));
        for (AuditLog.Row row : rows) {
            AuditLog.Entry e = row.entry();
            String target = e.target();
            if (e.action().equals("browser.session.grant")) {
                // The one exception, by name: §7 lists this row with the granted site, a registrable domain (an origin,
                // which §7 allows), so Activity can say which of the member's sign-ins was lent. It's the model's
                // argument, so it's checked to be only that: one site: field, a domain, nothing else of the call.
                assertThat(target).matches("site:granted-site\\.example run:[0-9a-f-]+");
                target = target.replaceFirst("^site:\\S+ ", "site:<the granted site> ");
            }
            String text = e.actor() + " " + e.action() + " " + target + " " + e.decision();
            for (String form : forms) {
                assertThat(text).as("audit row %d (%s)", row.seq(), e.action()).doesNotContain(form);
            }
        }
        assertThat(desk.audit.verify().intact()).isTrue();
        try (Stream<Path> files = Files.list(data)) {
            for (Path f : files.filter(p -> p.getFileName().toString().startsWith("audit.db")).toList()) {
                String bytes = new String(Files.readAllBytes(f), StandardCharsets.ISO_8859_1);
                for (String form : forms) {
                    assertThat(bytes).as("the bytes of %s", f.getFileName()).doesNotContain(form);
                }
            }
        }
        // ---- desk-agent's own log lines while it ran
        for (ILoggingEvent event : logs.list) {
            String line = event.getFormattedMessage() + (event.getThrowableProxy() == null ? ""
                    : " " + event.getThrowableProxy().getMessage());
            for (String form : forms) {
                assertThat(line).as("log line from %s", event.getLoggerName()).doesNotContain(form);
            }
        }
        // And the canary really went everywhere it was meant to: the model saw deskd's results, the store kept the cards.
        assertThat(TeamDesk.allText(desk.lastRequest())).contains(canary);
        assertThat(ran).containsAll(declared);
        // Each went through the gate and the log: a tool.call row names every declared tool.
        Set<String> audited = new LinkedHashSet<>();
        for (AuditLog.Row row : rows) {
            if (row.entry().action().equals("tool.call") && row.entry().target().startsWith("tool:")) {
                audited.add(row.entry().target().substring(5).split(" ")[0]);
            }
        }
        assertThat(audited).as("tools with a tool.call row").containsAll(declared);
    }
}
