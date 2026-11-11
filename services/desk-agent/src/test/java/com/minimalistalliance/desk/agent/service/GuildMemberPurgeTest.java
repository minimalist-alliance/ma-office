package com.minimalistalliance.desk.agent.service;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.limits.Scope;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A removed guild member's agent conversations are deleted (ADR 0080 decision 12 and its addendum of 2026-11-10):
 * deskd's {@code desk.member.purge}, on real SQLite files, read back byte by byte, WALs included.
 */
class GuildMemberPurgeTest {

    private static final String A = "gm-aaaa0001";
    private static final String B = "gm-bbbb0001";
    private static final Caller MEMBER_A = new Caller(Caller.MEMBER_KIND, A, "officer", List.of("manage_agents"), false);
    private static final Caller MEMBER_B = new Caller(Caller.MEMBER_KIND, B, "member", List.of(), false);
    private static final String A_SAYS = "A-wrote-7f3e91-in-confidence";
    private static final String A_FILE = "plan-of-A-5c2d0e.txt";
    private static final String B_SAYS = "B-wrote-41aa07-to-keep";

    @TempDir
    Path data;

    private TeamDesk desk;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data);
        String key = desk.key();
        for (Caller member : List.of(MEMBER_A, MEMBER_B)) {
            desk.service.call("agent.bind", m("agentId", member.memberId(), "keyId", key, "model", Rig.MODEL), member);
        }
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    private String send(Caller member, String text, String... uploads) throws Exception {
        String runId = (String) desk.service.call("agent.message.send",
                m("agentId", member.memberId(), "text", text, "attachments", List.of(uploads)), member).get("runId");
        await().atMost(Duration.ofSeconds(10)).until(() -> !working(member));
        return runId;
    }

    private boolean working(Caller member) throws Exception {
        return list(desk.service.call("agent.list", m(), member).get("agents")).stream()
                .anyMatch(agent -> "working".equals(agent.get("status")));
    }

    private String upload(Caller member, String name, String text) throws Exception {
        String id = "up-" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        desk.service.call("agent.attach.put", m("agentId", member.memberId(), "uploadId", id, "name", name, "size",
                bytes.length, "index", 0, "data", Base64.getEncoder().encodeToString(bytes)), member);
        return id;
    }

    private Map<String, Object> purge(String memberId) throws Exception {
        return desk.service.call(AgentService.MEMBER_PURGE, m("memberId", memberId));
    }

    private List<Map<String, Object>> thread(Caller member) throws Exception {
        return list(desk.service.call("agent.thread.get", m("agentId", member.memberId()), member).get("messages"));
    }

    /** The bytes of a SQLite file and its WAL, as anyone reading the volume would see them. */
    private byte[] onDisk(String name) throws Exception {
        byte[] file = Files.readAllBytes(data.resolve(name));
        Path wal = data.resolve(name + "-wal");
        byte[] log = Files.exists(wal) ? Files.readAllBytes(wal) : new byte[0];
        byte[] both = new byte[file.length + log.length];
        System.arraycopy(file, 0, both, 0, file.length);
        System.arraycopy(log, 0, both, file.length, log.length);
        return both;
    }

    private boolean found(String name, String text) throws Exception {
        byte[] haystack = onDisk(name);
        byte[] needle = text.getBytes(StandardCharsets.UTF_8);
        outer:
        for (int i = 0; i + needle.length <= haystack.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return true;
        }
        return false;
    }

    private static Map<String, Object> noCaps(int runMaxSteps) {
        Map<String, Object> none = new LinkedHashMap<>();
        none.put("maxMicroUsd", null);
        none.put("maxTokens", null);
        Map<String, Object> p = new LinkedHashMap<>();
        for (String scope : List.of("agentDay", "agentWeek", "agentMonth", "keyMonth", "run")) {
            p.put(scope, new LinkedHashMap<>(none));
        }
        p.put("runMaxSteps", runMaxSteps);
        return p;
    }

    private long deskMonth() throws Exception {
        return desk.ledger.usage(B, null).stream().filter(s -> s.scope() == Scope.DESK_MONTH).findFirst().orElseThrow()
                .spent().microUsd();
    }

    /**
     * S-14: a member's own agent remembers, the member alone sees and deletes it (the Founder's view has no member's
     * agent), and a purge takes every line and the thread's summary, from the file and its WAL.
     */
    @Test
    void aMembersMemoryIsTheirsAloneAndGoesWithThem() throws Exception {
        String line = "A-remembers-9e21c4 likes sailing";
        Usage usage = new Usage(100, 0, 0, 20, 0);
        desk.provider.then(FakeProvider.Step.calls(usage, List.of(FakeProvider.Step.call("m1",
                com.minimalistalliance.desk.agent.memory.Memories.TOOL, "text", line))))
                .then(FakeProvider.Step.answer(usage, "Noted."));
        send(MEMBER_A, "Remember that I like sailing.");
        assertThat(list(desk.service.call("agent.memory.list", m("agentId", A), MEMBER_A).get("memories")))
                .singleElement().satisfies(item -> assertThat(item).containsEntry("text", line));
        com.minimalistalliance.desk.agent.memory.MemoryStore memory =
                new com.minimalistalliance.desk.agent.memory.MemoryStore(desk.store);
        String summary = "A-summary-6b0f3d of the thread";
        assertThat(memory.replaceSummary(null, new com.minimalistalliance.desk.agent.memory.MemoryStore.Summary(
                "sum-test", A, 1, "x", summary, 0, 1, false))).isTrue();

        for (Caller other : List.of(MEMBER_B, Caller.OWNER)) {
            assertThatThrownBy(() -> desk.service.call("agent.memory.list", m("agentId", A), other))
                    .isInstanceOfSatisfying(RpcError.class, e -> assertThat(e.code()).isEqualTo("not_found"));
            assertThatThrownBy(() -> desk.service.call("agent.memory.clear", m("agentId", A), other))
                    .isInstanceOf(RpcError.class);
        }
        Caller teen = new Caller(Caller.MEMBER_KIND, A, "member", List.of(), true);
        assertThatThrownBy(() -> desk.service.call("agent.memory.list", m("agentId", A), teen))
                .isInstanceOfSatisfying(RpcError.class, e -> assertThat(e.code()).isEqualTo("forbidden"));
        assertThat(found("agent.db", line)).isTrue();

        assertThat(purge(A)).containsEntry("memories", 1);

        assertThat(found("agent.db", line)).isFalse();
        assertThat(found("agent.db", summary)).isFalse();
        assertThat(found("audit.db", line)).isFalse();
        assertThat(memory.list(A)).isEmpty();
        assertThat(memory.summary(A)).isNull();
    }

    @Test
    void aRemovedMembersRowsAreGoneFromTheFilesAndTheirWalsAndNobodyElsesAre() throws Exception {
        String aRun = send(MEMBER_A, A_SAYS, upload(MEMBER_A, A_FILE, "the file's own words"));
        desk.service.call("agent.limits.set", m("agentId", A, "policy", noCaps(7)), MEMBER_A);
        upload(MEMBER_A, "half-attached.txt", "never sent");
        String bRun = send(MEMBER_B, B_SAYS);
        long spent = deskMonth();
        assertThat(spent).isPositive();
        // The scan sees them before, so its not seeing them after means something.
        assertThat(found("agent.db", A_SAYS)).isTrue();
        assertThat(found("agent.db", A_FILE)).isTrue();
        assertThat(found("usage.db", A)).isTrue();

        Map<String, Object> answer = purge(A);

        assertThat(answer).containsEntry("purged", true).containsEntry("agents", 1).containsEntry("messages", 2)
                .containsEntry("files", 1).containsEntry("usage", 1).containsEntry("staged", 1);
        for (String text : List.of(A_SAYS, A_FILE, A, aRun)) {
            assertThat(found("agent.db", text)).as("agent.db and its WAL: " + text).isFalse();
            assertThat(found("usage.db", text)).as("usage.db and its WAL: " + text).isFalse();
        }
        assertThat(Files.size(data.resolve("agent.db-wal"))).isZero();
        assertThat(Files.size(data.resolve("usage.db-wal"))).isZero();
        assertThat(desk.staging.count()).isZero();
        // B is as before: their thread, their spend, their row in the guild's usage.
        assertThat(found("agent.db", B_SAYS)).isTrue();
        assertThat(found("usage.db", bRun)).isTrue();
        assertThat(thread(MEMBER_B).toString()).contains(B_SAYS);
        // The guild's month still counts what A spent, under no one's id.
        assertThat(deskMonth()).isEqualTo(spent);
        Map<String, Object> usage = desk.service.call("agent.guild.usage", m(),
                new Caller(Caller.MEMBER_KIND, "gm-lead0001", "lead", List.of(), false));
        assertThat(list(usage.get("members"))).extracting(row -> row.get("memberId")).doesNotContain(A)
                .doesNotContain(UsageLedger.DEPARTED);
        // The audit log keeps its rows, which hold no content, and says the purge happened.
        List<AuditLog.Row> rows = desk.audit.read(0, 1000);
        assertThat(rows).extracting(row -> row.entry().action()).contains("member.purge");
        assertThat(rows.toString()).doesNotContain(A_SAYS).doesNotContain(A_FILE);
        assertThat(desk.audit.verify().intact()).isTrue();
    }

    @Test
    void aMemberWhoComesBackStartsWithNothing() throws Exception {
        send(MEMBER_A, A_SAYS);
        desk.service.call("agent.limits.set", m("agentId", A, "policy", noCaps(7)), MEMBER_A);
        assertThat(desk.limits.policyFor(A).runMaxSteps()).isEqualTo(7);
        purge(A);
        assertThat(desk.limits.policyFor(A).runMaxSteps()).isNotEqualTo(7);
        // They rejoin: the same id, a new agent, no binding, no thread, no limits of their own.
        List<Map<String, Object>> agents = list(desk.service.call("agent.list", m(), MEMBER_A).get("agents"));
        assertThat(agents).hasSize(1);
        assertThat(agents.get(0)).containsEntry("id", A).containsEntry("binding", null);
        assertThat(thread(MEMBER_A)).isEmpty();
        assertThat(desk.store.agent(A).limits()).isNull();
    }

    @Test
    void aRunGoingIsStoppedFirstAndDoingItAgainFindsNothing() throws Exception {
        CountDownLatch never = new CountDownLatch(1);
        desk.provider.then(FakeProvider.Step.answer(new Usage(100, 0, 0, 20, 0), "slow").heldBy(never));
        desk.service.call("agent.message.send", m("agentId", A, "text", A_SAYS), MEMBER_A);
        await().until(() -> working(MEMBER_A));

        assertThat(purge(A)).containsEntry("agents", 1).containsEntry("messages", 2);
        assertThat(found("agent.db", A_SAYS)).isFalse();
        assertThat(found("usage.db", A)).isFalse();

        Map<String, Object> again = purge(A);
        assertThat(again).containsEntry("purged", true).containsEntry("agents", 0).containsEntry("messages", 0)
                .containsEntry("usage", 0);
        assertThat(desk.audit.read(0, 1000)).filteredOn(row -> row.entry().action().equals("member.purge")).hasSize(1);
    }

    @Test
    void onlyAMembersIdIsTakenSoTheOwnersAgentsCantBeNamed() throws Exception {
        desk.bindLead();
        String helper = desk.agent("Helper");
        for (Object id : new Object[] {"manager", helper, "gm-x", null, 7}) {
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("memberId", id);
            assertThatThrownBy(() -> desk.service.call(AgentService.MEMBER_PURGE, p))
                    .as(String.valueOf(id))
                    .isInstanceOfSatisfying(RpcError.class, e -> assertThat(e.code()).isEqualTo("bad_request"));
        }
        assertThat(desk.agentView("manager")).containsEntry("id", "manager");
        assertThat(desk.agentView(helper)).containsEntry("id", helper);
        // On the owner's desk a member's id names nothing: the owner's agents are as they were.
        assertThat(purge("gm-cccc0001")).containsEntry("agents", 0);
        assertThat(list(desk.call("agent.list").get("agents"))).extracting(a -> a.get("id"))
                .containsExactlyInAnyOrder("manager", helper);
    }

    @Test
    void aMemberCantCallIt() throws Exception {
        send(MEMBER_B, B_SAYS);
        assertThatThrownBy(() -> desk.service.call(AgentService.MEMBER_PURGE, m("memberId", B), MEMBER_A))
                .isInstanceOfSatisfying(RpcError.class, e -> {
                    assertThat(e.code()).isEqualTo("forbidden");
                    assertThat(e.details()).containsEntry("reason", "permission");
                });
        assertThat(thread(MEMBER_B).toString()).contains(B_SAYS);
    }
}
