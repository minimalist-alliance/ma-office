package com.minimalistalliance.desk.agent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.key.KeyVault;
import com.minimalistalliance.desk.agent.limits.LimitSettings;
import com.minimalistalliance.desk.agent.limits.PriceTable;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.llm.LlmGateway;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.tool.DeskLink;
import com.minimalistalliance.desk.agent.tool.DeskLink.Reply;
import java.nio.file.Path;
import java.time.Duration;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Helpers on the member's MA credits in the agent service (API.md §24): the credits as a row of the Keys list while deskd
 * offers them, the one model, no delete; a new agent with no key goes on the credits when the member has some; a bind needs
 * the offer and the model {@code auto}; a run on the credits goes through deskd's {@code helpers_model}; MA's credits are never
 * a provider a member makes a key for.
 */
@SuppressWarnings("unchecked")
class AgentServiceCreditsTest {

    @TempDir
    Path data;

    /** deskd as a script: offers helpers, answers the credits read and each model call. */
    static final class Link implements DeskLink {
        final List<Map<String, Object>> calls = new CopyOnWriteArrayList<>();
        volatile boolean offers = true;
        volatile Map<String, Object> credits = Map.of("left", 262, "starting", 262, "topUp", 0, "lighter", false);
        volatile Function<Map<String, Object>, Reply> model = call -> new Reply(true, Map.of("v", 1, "text",
                "Three flights found.", "stopReason", "end_turn", "usage", Map.of("inputTokens", 900, "outputTokens", 40),
                "costCredits", 0.3, "credits", Map.of("left", 261, "starting", 261, "topUp", 0, "lighter", false)), null,
                null, List.of());

        @Override
        public Set<String> offered() {
            return Set.of();
        }

        @Override
        public boolean helpersModel() {
            return offers;
        }

        @Override
        public Reply call(Map<String, Object> call, Duration wait) {
            calls.add(call);
            if ("helpers_credits".equals(call.get("tool"))) {
                return new Reply(true, Map.of("v", 1, "enabled", true, "credits", credits), null, null, List.of());
            }
            return model.apply(call);
        }
    }

    private final MutableClock clock = new MutableClock(Rig.START);
    private AuditLog audit;
    private UsageLedger ledger;
    private AgentStore store;
    private KeyRing keys;
    private AgentService service;
    private final Link link = new Link();

    @BeforeEach
    void setUp() throws Exception {
        audit = new AuditLog(data.resolve("audit.db"), clock);
        ledger = new UsageLedger(data.resolve("usage.db"), clock, ZoneOffset.UTC);
        store = new AgentStore(data.resolve("agent.db"), clock);
        audit.open();
        ledger.open();
        store.open();
        keys = new KeyRing((action, target, decision) -> audit.append(AuditLog.Entry.of("user", action, target, decision)));
        ProviderRegistry providers = new ProviderRegistry();
        providers.register(new FakeProvider());
        PriceTable prices = new PriceTable(Pricing.of(Map.of(FakeProvider.ID.id() + "/" + Rig.MODEL,
                new Pricing.Price(1_000_000, 100_000, 1_250_000, 2_000_000))));
        LimitSettings limits = new LimitSettings();
        ManagerAgent manager = new ManagerAgent(new LlmGateway(providers, keys, prices, ledger, audit), keys, limits, clock);
        service = new AgentService(store, manager, keys, new KeyVault(data.resolve("keys")), providers, prices, limits,
                ledger, audit, new TopicHub(), clock,
                com.minimalistalliance.desk.agent.testing.Teams.team(store, limits, audit, data, clock));
        service.restore();
        service.deskLink(link);
    }

    @AfterEach
    void tearDown() {
        service.stopAll();
        keys.dropAll();
        store.close();
        ledger.close();
        audit.close();
    }

    private static Map<String, Object> view(Object o) {
        return (Map<String, Object>) o;
    }

    private List<Map<String, Object>> keyList() throws Exception {
        return (List<Map<String, Object>>) service.call("agent.key.list", Map.of()).get("keys");
    }

    @Test
    void theCreditsAreARowOfTheKeysWhileOfferedWithOneModelAndNoDelete() throws Exception {
        Map<String, Object> row = keyList().getFirst();
        assertThat(row).containsEntry("keyId", KeyRing.CREDITS).containsEntry("provider", "ma-credits")
                .containsEntry("providerName", "Minimalist Alliance").containsEntry("label", "MA credits")
                .containsEntry("available", true);
        assertThat(view(row.get("credits"))).containsEntry("left", 262L);
        List<Map<String, Object>> models = (List<Map<String, Object>>) service.call("agent.key.models",
                Map.of("keyId", KeyRing.CREDITS)).get("models");
        assertThat(models).extracting(m -> m.get("id")).containsExactly("auto");
        assertThatThrownBy(() -> service.call("agent.key.delete", Map.of("keyId", KeyRing.CREDITS)))
                .isInstanceOfSatisfying(RpcError.class, e -> assertThat(e.code()).isEqualTo("forbidden"));
        List<Map<String, Object>> providers = (List<Map<String, Object>>) service.call("agent.providers", Map.of())
                .get("providers");
        assertThat(providers).extracting(p -> p.get("id")).doesNotContain("ma-credits", "ma");
        // Not offered (an older deskd, or the service off): no row, and no bind.
        link.offers = false;
        assertThat(keyList()).extracting(k -> k.get("keyId")).doesNotContain(KeyRing.CREDITS);
        assertThatThrownBy(() -> service.call("agent.bind", Map.of("agentId", AgentStore.MANAGER, "keyId", KeyRing.CREDITS,
                "model", "auto"))).isInstanceOfSatisfying(RpcError.class,
                        e -> assertThat(e.code()).isEqualTo("precondition_failed"));
    }

    @Test
    void aNewAgentWithNoKeyGoesOnTheCreditsWhenTheMemberHasSome() throws Exception {
        Map<String, Object> agent = view(service.call("agent.create", Map.of("name", "Research")).get("agent"));
        Map<String, Object> binding = view(agent.get("binding"));
        assertThat(binding).containsEntry("keyId", KeyRing.CREDITS).containsEntry("provider", "ma-credits")
                .containsEntry("providerName", "Minimalist Alliance").containsEntry("model", "auto");
        // Used up with no lighter model: it waits for a key as before.
        link.credits = Map.of("left", 0, "starting", 0, "topUp", 0, "lighter", false);
        clock.advance(Duration.ofMinutes(2));
        Map<String, Object> second = view(service.call("agent.create", Map.of("name", "Drafts")).get("agent"));
        assertThat(second.get("binding")).isNull();
        // A key given wins over the credits.
        assertThat(audit.readBefore(null, 200).stream().filter(r -> r.entry().decision().equals("credits")).count())
                .isEqualTo(1);
    }

    private int agentCount() throws Exception {
        return ((List<?>) service.call("agent.list", Map.of()).get("agents")).size();
    }

    private void assertCantRun(Map<String, Object> params) throws Exception {
        int before = agentCount();
        assertThatThrownBy(() -> service.call("agent.create", params)).isInstanceOfSatisfying(RpcError.class, e -> {
            assertThat(e.code()).isEqualTo("precondition_failed");
            assertThat(e.details()).containsEntry("reason", "cant_run");
        });
        assertThat(agentCount()).as("nothing made").isEqualTo(before);
    }

    /**
     * The welcome's helpers ({@code ifRunnable}, the owner, Nov 15): with no key, made only when they can run now on
     * the member's credits, so none sits dead on the desk; otherwise {@code cant_run} and nothing is made. With a key
     * it changes nothing.
     */
    @Test
    void aHelperAskedForIfRunnableIsMadeOnlyWhenItCanRunOnTheCredits() throws Exception {
        Map<String, Object> agent = view(service.call("agent.create", Map.of("name", "Research", "ifRunnable", true))
                .get("agent"));
        assertThat(view(agent.get("binding"))).containsEntry("keyId", KeyRing.CREDITS).containsEntry("model", "auto");
        assertThatThrownBy(() -> service.call("agent.create", Map.of("name", "Odd", "ifRunnable", "yes")))
                .isInstanceOfSatisfying(RpcError.class, e -> {
                    assertThat(e.code()).isEqualTo("bad_request");
                    assertThat(e.details()).containsEntry("detail", "ifRunnable");
                });

        // Used up, with no lighter model: refused, and nothing made.
        link.credits = Map.of("left", 0, "starting", 0, "topUp", 0, "lighter", false);
        clock.advance(Duration.ofMinutes(2));
        assertCantRun(Map.of("name", "Drafts", "ifRunnable", true));
        // Without ifRunnable (or with it false), today's create: made, waiting for a key.
        assertThat(view(service.call("agent.create", Map.of("name", "Waits", "ifRunnable", false)).get("agent"))
                .get("binding")).isNull();
        // A key given: ifRunnable changes nothing.
        Map<String, Object> keyed = view(service.call("agent.create", Map.of("name", "Keyed", "ifRunnable", true,
                "keyId", KeyRing.CREDITS, "model", "auto")).get("agent"));
        assertThat(view(keyed.get("binding"))).containsEntry("keyId", KeyRing.CREDITS);

        // The lighter model's share for today is usable.
        link.credits = Map.of("left", 0, "starting", 0, "topUp", 0, "lighter", true, "lighterLeft", 4);
        clock.advance(Duration.ofMinutes(2));
        assertThat(view(view(service.call("agent.create", Map.of("name", "Light", "ifRunnable", true)).get("agent"))
                .get("binding"))).containsEntry("keyId", KeyRing.CREDITS);

        // Not offered (an older deskd, or the service off): refused.
        link.offers = false;
        assertCantRun(Map.of("name", "Offline", "ifRunnable", true));
        // The credits read failing is the same.
        link.offers = true;
        link.credits = Map.of("left", "lots");
        clock.advance(Duration.ofMinutes(2));
        assertCantRun(Map.of("name", "Unread", "ifRunnable", true));
    }

    /**
     * The member's one wallet (contract 0.4.10, the coordinator's decision of Nov 15): an agent's answer on MA's credits
     * reports the same wallet Desk Maia's room and the Keys list show; the team view gives that agent's usage in credits,
     * never dollars, and an agent on the member's own key keeps its own provider's dollars.
     */
    @Test
    void anAgentsAnswerIsTheOneWalletAndItsUsageIsInCredits() throws Exception {
        Map<String, Object> wallet = new java.util.LinkedHashMap<>();
        wallet.put("left", 2059);
        wallet.put("month", 2500);
        wallet.put("monthLeft", 1549);
        wallet.put("starting", 210);
        wallet.put("topUp", 300);
        wallet.put("topUpLeft", 300);
        wallet.put("day", 200);
        wallet.put("dayUsed", 201);
        wallet.put("week", 800);
        wallet.put("weekUsed", 120);
        wallet.put("drawingFrom", "week");
        wallet.put("lighter", false);
        wallet.put("renewsAt", "2026-12-01T07:00:00Z");
        link.model = call -> new Reply(true, Map.of("v", 1, "text", "Three flights found.", "stopReason", "end_turn",
                "usage", Map.of("inputTokens", 900, "outputTokens", 40), "costCredits", 0.36, "credits", wallet), null,
                null, List.of());
        service.call("agent.bind", Map.of("agentId", AgentStore.MANAGER, "keyId", KeyRing.CREDITS, "model", "auto"));
        com.minimalistalliance.desk.agent.testing.Setups.setUp(service, AgentStore.MANAGER);
        service.call("agent.message.send", Map.of("agentId", AgentStore.MANAGER, "text", "Find three flights"));
        await().atMost(Duration.ofSeconds(10)).until(() -> audit.readBefore(null, 200).stream()
                .anyMatch(r -> r.entry().action().equals("llm.call") && r.entry().target().contains("ma-credits/auto")));

        // The Keys list's row is the one wallet: left, starting, top-ups, the month's part; never money.
        Map<String, Object> credits = view(keyList().getFirst().get("credits"));
        assertThat(credits).containsEntry("left", 2059L).containsEntry("starting", 210L).containsEntry("topUp", 300L)
                .containsEntry("monthLeft", 1549L).containsEntry("month", 2500L);
        // Desk Maia's room shows the same wallet, though she hasn't answered yet.
        Map<String, Object> allowance = view(service.snapshotFor(com.minimalistalliance.desk.agent.maia.MaiaMode.TOPIC)
                .get().get("allowance"));
        assertThat(view(allowance.get("credits"))).containsEntry("left", 2059L).containsEntry("starting", 210L)
                .containsEntry("topUpLeft", 300L).containsEntry("drawingFrom", "week");
        assertThat(String.valueOf(allowance)).doesNotContain("$").doesNotContainPattern("(?i)usd");

        // The team view: the agent on MA's credits in credits (0.36 today), no dollars of it.
        await().atMost(Duration.ofSeconds(10)).until(() -> todayRow(AgentStore.MANAGER).get("spendCredits") != null
                && ((Number) todayRow(AgentStore.MANAGER).get("spendCredits")).doubleValue() >= 0.36);
        Map<String, Object> today = todayRow(AgentStore.MANAGER);
        assertThat(((Number) today.get("spendMicroUsd")).longValue()).isZero();
        assertThat(agentRow(AgentStore.MANAGER)).containsEntry("source", "credits");
    }

    private Map<String, Object> agentRow(String agentId) throws Exception {
        List<Map<String, Object>> agents = (List<Map<String, Object>>) service.call("agent.usage.summary",
                Map.of("days", 7)).get("agents");
        return agents.stream().filter(a -> agentId.equals(a.get("agentId"))).findFirst().orElseThrow();
    }

    private Map<String, Object> todayRow(String agentId) throws Exception {
        return ((List<Map<String, Object>>) agentRow(agentId).get("days")).getLast();
    }

    @Test
    void aBindNeedsTheModelAutoAndARunOnTheCreditsGoesThroughDeskd() throws Exception {
        assertThatThrownBy(() -> service.call("agent.bind", Map.of("agentId", AgentStore.MANAGER, "keyId", KeyRing.CREDITS,
                "model", "claude-opus-5-5"))).isInstanceOfSatisfying(RpcError.class,
                        e -> assertThat(e.code()).isEqualTo("bad_request"));
        service.call("agent.bind", Map.of("agentId", AgentStore.MANAGER, "keyId", KeyRing.CREDITS, "model", "auto"));
        com.minimalistalliance.desk.agent.testing.Setups.setUp(service, AgentStore.MANAGER);
        service.call("agent.message.send", Map.of("agentId", AgentStore.MANAGER, "text", "Find three flights"));
        await().atMost(Duration.ofSeconds(10)).until(() -> link.calls.stream()
                .anyMatch(c -> "helpers_model".equals(c.get("tool"))));
        Map<String, Object> sent = link.calls.stream().filter(c -> "helpers_model".equals(c.get("tool"))).findFirst()
                .orElseThrow();
        assertThat(sent).containsEntry("agentId", "helper");
        assertThat(view(sent.get("args"))).containsEntry("task", "agent").doesNotContainKey("model");
        // The run's call kept no dollars on the desk.
        await().atMost(Duration.ofSeconds(10)).until(() -> audit.readBefore(null, 200).stream()
                .anyMatch(r -> r.entry().action().equals("llm.call") && r.entry().target().contains("ma-credits/auto")));
        assertThat(ledger.agentToday(AgentStore.MANAGER).microUsd()).isZero();
    }
}
