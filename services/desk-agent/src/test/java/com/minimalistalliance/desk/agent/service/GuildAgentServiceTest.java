package com.minimalistalliance.desk.agent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.key.KeyVault;
import com.minimalistalliance.desk.agent.limits.LimitSettings;
import com.minimalistalliance.desk.agent.limits.PriceTable;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.llm.LlmGateway;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.provider.ChatProvider;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ModelInfo;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderInfo;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * desk-agent on a guild desk (deskd's API.md section 14): each member's own agent and thread, private from every other
 * member and from the owner's view; the member's caps and the guild's both binding; runs a day and at once; teens.
 */
class GuildAgentServiceTest {

    private static final String KEY = "sk-fake-guild-0123456789abcdef";
    private static final String A = "gm-aaaa0001";
    private static final String B = "gm-bbbb0001";

    /** Answers at once, or once {@link #hold} is counted down. */
    private static final class HeldProvider implements ChatProvider {
        final FakeProvider fake = new FakeProvider();
        volatile CountDownLatch hold = new CountDownLatch(0);

        @Override
        public ProviderInfo info() {
            return fake.info();
        }

        @Override
        public List<ModelInfo> models(KeyLease key) throws ProviderException {
            return fake.models(key);
        }

        @Override
        public ChatResult chat(ChatRequest request, KeyLease key, DeltaSink sink) throws ProviderException {
            try {
                hold.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new ProviderException(ProviderException.Kind.CANCELLED, true);
            }
            sink.delta("ok");
            return new ChatResult("ok", new Usage(100, 0, 0, 20, 0), request.model(), "end_turn");
        }
    }

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private final HeldProvider provider = new HeldProvider();
    private final TopicHub topics = new TopicHub();
    private AuditLog audit;
    private UsageLedger ledger;
    private AgentStore store;
    private KeyRing keys;
    private AgentService service;
    private String keyId;

    static Caller member(String memberId, String role, List<String> grants, boolean teen) {
        return new Caller(Caller.MEMBER_KIND, memberId, role, grants, teen);
    }

    private static final Caller MEMBER_A = member(A, "member", List.of(), false);
    private static final Caller MEMBER_B = member(B, "member", List.of(), false);
    private static final Caller LEAD = member("gm-lead0001", "lead",
            List.of("moderate", "invite", "remove_member", "manage_spaces", "manage_agents"), false);

    @BeforeEach
    void start() throws Exception {
        audit = new AuditLog(data.resolve("audit.db"), clock);
        ledger = new UsageLedger(data.resolve("usage.db"), clock, ZoneOffset.UTC);
        store = new AgentStore(data.resolve("agent.db"), clock);
        audit.open();
        ledger.open();
        store.open();
        keys = new KeyRing((action, target, decision) -> audit.append(AuditLog.Entry.of("user", action, target, decision)));
        ProviderRegistry providers = new ProviderRegistry();
        providers.register(provider);
        PriceTable prices = new PriceTable(Pricing.of(Map.of(FakeProvider.ID.id() + "/" + Rig.MODEL,
                new Pricing.Price(1_000_000, 100_000, 1_250_000, 2_000_000))));
        LimitSettings limits = new LimitSettings();
        ManagerAgent manager = new ManagerAgent(new LlmGateway(providers, keys, prices, ledger, audit), keys, limits, clock);
        service = new AgentService(store, manager, keys, new KeyVault(data.resolve("keys")), providers, prices, limits,
                ledger, audit, topics, clock, com.minimalistalliance.desk.agent.testing.Teams.team(store, limits, audit,
                        data, clock));
        service.restore();
        // The guild's key, added by its Founder.
        ByteBuffer secret = ByteBuffer.allocateDirect(KEY.length()).put(KEY.getBytes(StandardCharsets.US_ASCII)).flip();
        keyId = (String) ((Map<?, ?>) service.keyAdd(Map.of("provider", FakeProvider.ID.id(), "label", "Guild"), secret, LEAD)
                .get("key")).get("keyId");
        guild(1, 10, 20, 50, 2);
        for (Caller member : List.of(MEMBER_A, MEMBER_B)) {
            service.call("agent.bind", Map.of("agentId", member.memberId(), "keyId", keyId, "model", Rig.MODEL), member);
        }
    }

    @AfterEach
    void stop() {
        provider.hold.countDown();
        service.stopAll();
        keys.dropAll();
        store.close();
        ledger.close();
        audit.close();
    }

    /** deskd's push of the guild's settings, as GuildSettings shapes them. */
    private void guild(Object usdPerDay, Object usdPerMonth, Integer runsPerDay, Object guildUsdPerMonth, int runsAtOnce)
            throws Exception {
        Map<String, Object> perMember = new LinkedHashMap<>();
        perMember.put("runsPerDay", runsPerDay);
        perMember.put("usdPerDay", usdPerDay);
        perMember.put("usdPerMonth", usdPerMonth);
        Map<String, Object> perGuild = new LinkedHashMap<>();
        perGuild.put("usdPerMonth", guildUsdPerMonth);
        perGuild.put("runsAtOnce", runsAtOnce);
        service.call("desk.guild.set", Map.of("agents", Map.of("perMember", perMember, "perGuild", perGuild,
                "tools", Map.of(), "ownKeys", false)));
    }

    private String send(Caller caller, String text) throws Exception {
        return (String) service.call("agent.message.send", Map.of("agentId", caller.memberId(), "text", text), caller).get("runId");
    }

    private void awaitIdle(Caller caller) {
        await().atMost(10, TimeUnit.SECONDS).until(() -> !"working".equals(agentsOf(caller).get(0).get("status")));
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> agentsOf(Caller caller) throws Exception {
        return (List<Map<String, Object>>) service.call("agent.list", Map.of(), caller).get("agents");
    }

    private static void refused(ThrowingCall call, String code, String key, String value) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(RpcError.class, e -> {
            assertThat(e.code()).isEqualTo(code);
            if (key != null) {
                assertThat(e.details()).containsEntry(key, value);
            }
        });
    }

    @FunctionalInterface
    interface ThrowingCall {
        void run() throws Exception;
    }

    @Test
    void eachMemberSeesOnlyTheirOwnAgentAndThread() throws Exception {
        assertThat(agentsOf(MEMBER_A)).extracting(a -> a.get("id")).containsExactly(A);
        assertThat(agentsOf(MEMBER_B)).extracting(a -> a.get("id")).containsExactly(B);
        send(MEMBER_A, "A's secret plan");
        awaitIdle(MEMBER_A);
        Map<String, Object> mine = service.call("agent.thread.get", Map.of("agentId", A), MEMBER_A);
        assertThat(mine.toString()).contains("A's secret plan");
        // B can't read, write, stop, see the limits of, or watch A's agent: it's as if it didn't exist.
        refused(() -> service.call("agent.thread.get", Map.of("agentId", A), MEMBER_B), "not_found", null, null);
        refused(() -> service.call("agent.message.send", Map.of("agentId", A, "text", "hi"), MEMBER_B), "not_found", null, null);
        refused(() -> service.call("agent.limits.get", Map.of("agentId", A), MEMBER_B), "not_found", null, null);
        refused(() -> service.call("agent.seen", Map.of("agentId", A), MEMBER_B), "not_found", null, null);
        refused(() -> service.call("agent.update", Map.of("agentId", A, "name", "Mine"), MEMBER_B), "not_found", null, null);
        refused(() -> service.call("agent.bind", Map.of("agentId", A, "keyId", keyId, "model", Rig.MODEL), MEMBER_B),
                "not_found", null, null);
        refused(() -> service.call("agent.thread.get", Map.of("agentId", AgentStore.MANAGER), MEMBER_B), "not_found", null, null);
        assertThat(service.knows(AgentService.CONVERSATION_PREFIX + A, MEMBER_B)).isFalse();
        assertThat(service.knows(AgentService.CONVERSATION_PREFIX + A, MEMBER_A)).isTrue();
        // The Founder sees usage, never a member's thread (draft decision 6), and the owner's view has no member in it.
        refused(() -> service.call("agent.thread.get", Map.of("agentId", A), LEAD), "not_found", null, null);
        assertThat(service.agents()).extracting(a -> a.get("id")).containsExactly(AgentStore.MANAGER);
        assertThat(service.knows(AgentService.CONVERSATION_PREFIX + A, Caller.OWNER)).isFalse();
        // Only deskd's own view, for the heartbeat, has everyone's status, and it can't call anything.
        assertThat(service.stateSnapshot(Caller.SYSTEM).toString()).contains(A).contains(B);
        assertThat(service.stateSnapshot(Caller.SYSTEM).toString()).doesNotContain("secret");
        refused(() -> service.call("agent.list", Map.of(), Caller.SYSTEM), "forbidden", "reason", "caller");
    }

    @Test
    void aMemberCantStopAnotherMembersRun() throws Exception {
        provider.hold = new CountDownLatch(1);
        String run = send(MEMBER_A, "long one");
        service.call("agent.run.stop", Map.of("runId", run), MEMBER_B);
        Thread.sleep(100);
        assertThat(agentsOf(MEMBER_A).get(0)).containsEntry("status", "working");
        service.call("agent.run.stop", Map.of("runId", run), MEMBER_A);
        awaitIdle(MEMBER_A);
    }

    @Test
    void theStateTopicHasAViewPerMemberAndAChangeReachesOnlyItsOwn() throws Exception {
        List<String> seenByA = new CopyOnWriteArrayList<>();
        List<String> seenByB = new CopyOnWriteArrayList<>();
        topics.subscribe(1, AgentService.hubTopic(AgentService.STATE_TOPIC, MEMBER_A),
                service.snapshotFor(AgentService.STATE_TOPIC, MEMBER_A), (t, seq, type, d) -> seenByA.add(d.toString()));
        topics.subscribe(2, AgentService.hubTopic(AgentService.STATE_TOPIC, MEMBER_B),
                service.snapshotFor(AgentService.STATE_TOPIC, MEMBER_B), (t, seq, type, d) -> seenByB.add(d.toString()));
        assertThat(seenByA.get(0)).contains(A).doesNotContain(B);
        assertThat(seenByB.get(0)).contains(B).doesNotContain(A);
        int before = seenByB.size();
        service.call("agent.update", Map.of("agentId", A, "name", "Ana's"), MEMBER_A);
        assertThat(seenByA.getLast()).contains("Ana's");
        assertThat(seenByB).hasSize(before);
    }

    @Test
    void theMembersOwnCapBinds() throws Exception {
        // A cap a single call's reservation passes, with the guild's ample.
        guild(0.001, 10, 20, 50, 2);
        refused(() -> send(MEMBER_A, "hi"), "precondition_failed", "scope", "agent_day");
        guild(1, 0.001, 20, 50, 2);
        refused(() -> send(MEMBER_A, "hi"), "precondition_failed", "scope", "agent_month");
    }

    @Test
    void theGuildsCapBindsEveryMemberTooAndDeskdsSettingsArentAClientsToSet() throws Exception {
        guild(1, 10, 20, 0.001, 2);
        refused(() -> send(MEMBER_A, "hi"), "precondition_failed", "scope", "desk_month");
        refused(() -> send(MEMBER_B, "hi"), "precondition_failed", "scope", "desk_month");
        // A member can't lift it: desk.* is deskd's alone.
        refused(() -> service.call("desk.guild.set", Map.of("agents", Map.of()), LEAD), "forbidden", "reason", "permission");
        guild(null, null, null, null, 2);
        send(MEMBER_A, "now it goes");
        awaitIdle(MEMBER_A);
    }

    @Test
    void runsADayAndRunsAtOnce() throws Exception {
        guild(1, 10, 1, 50, 1);
        send(MEMBER_A, "one");
        awaitIdle(MEMBER_A);
        refused(() -> send(MEMBER_A, "two"), "precondition_failed", "scope", "member_runs_day");
        provider.hold = new CountDownLatch(1);
        send(MEMBER_B, "held");
        guild(1, 10, 5, 50, 1);
        refused(() -> send(MEMBER_A, "while B runs"), "precondition_failed", "scope", "guild_runs");
        provider.hold.countDown();
        awaitIdle(MEMBER_B);
        send(MEMBER_A, "after");
        awaitIdle(MEMBER_A);
    }

    @Test
    void aTeenMemberIsRefusedAndSoIsAMalformedCaller() throws Exception {
        Caller teen = member("gm-teen0001", "member", List.of(), true);
        refused(() -> service.call("agent.list", Map.of(), teen), "forbidden", "reason", "age_band");
        refused(() -> service.call("agent.message.send", Map.of("agentId", "gm-teen0001", "text", "hi"), teen),
                "forbidden", "reason", "age_band");
        assertThat(service.knows(AgentService.CONVERSATION_PREFIX + "gm-teen0001", teen)).isFalse();
        refused(() -> Caller.parse(Map.of("kind", "guild_member")), "forbidden", "reason", "caller");
        refused(() -> Caller.parse(Map.of("kind", "guild_member", "memberId", "user-1")), "forbidden", "reason", "caller");
        refused(() -> Caller.parse(Map.of("kind", "root")), "forbidden", "reason", "caller");
        refused(() -> Caller.parse("owner"), "forbidden", "reason", "caller");
        assertThat(Caller.parse(null)).isEqualTo(Caller.OWNER);
        // A member whose teen flag is missing reads as a teen, never as an adult.
        assertThat(Caller.parse(Map.of("kind", "guild_member", "memberId", A)).teen()).isTrue();
    }

    @Test
    void theGuildsKeysLimitsAndAuditAreForManagers() throws Exception {
        for (String method : List.of("agent.key.delete", "agent.limits.set", "agent.audit.list")) {
            refused(() -> service.call(method, Map.of("keyId", keyId, "agentId", A), MEMBER_A), "forbidden", "reason", "grant");
        }
        ByteBuffer secret = ByteBuffer.allocateDirect(KEY.length()).put(KEY.getBytes(StandardCharsets.US_ASCII)).flip();
        refused(() -> service.keyAdd(Map.of("provider", FakeProvider.ID.id(), "label", "Mine"), secret, MEMBER_A),
                "forbidden", "reason", "grant");
        assertThat(service.call("agent.key.list", Map.of(), MEMBER_A).get("keys")).asList().hasSize(1);
        assertThat(service.call("agent.audit.list", Map.of(), LEAD)).containsKey("entries");
    }

    @Test
    void usageIsPerMemberCountsForTheFounderAndOfficersOnly() throws Exception {
        send(MEMBER_A, "a private question");
        awaitIdle(MEMBER_A);
        refused(() -> service.call("agent.guild.usage", Map.of(), MEMBER_B), "forbidden", "reason", "grant");
        Map<String, Object> usage = service.call("agent.guild.usage", Map.of(), member("gm-off00001", "officer", List.of(), false));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> members = (List<Map<String, Object>>) usage.get("members");
        Map<String, Object> a = members.stream().filter(m -> A.equals(m.get("memberId"))).findFirst().orElseThrow();
        assertThat(((Map<?, ?>) a.get("today")).get("runs")).isEqualTo(1L);
        assertThat(((Number) ((Map<?, ?>) a.get("month")).get("microUsd")).longValue()).isPositive();
        Map<String, Object> b = members.stream().filter(m -> B.equals(m.get("memberId"))).findFirst().orElseThrow();
        assertThat(((Map<?, ?>) b.get("today")).get("runs")).isEqualTo(0L);
        assertThat(usage.toString()).doesNotContain("private");
    }

    @Test
    void anOwnersDeskIsUnchanged() throws Exception {
        assertThat(service.call("agent.list", Map.of()).get("agents")).asList().hasSize(1);
        service.call("agent.bind", Map.of("agentId", AgentStore.MANAGER, "keyId", keyId, "model", Rig.MODEL));
        assertThat(service.call("agent.message.send", Map.of("agentId", AgentStore.MANAGER, "text", "hi"))).containsKey("runId");
    }
}
