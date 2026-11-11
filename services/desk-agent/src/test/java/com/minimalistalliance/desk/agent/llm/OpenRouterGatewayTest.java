package com.minimalistalliance.desk.agent.llm;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.limits.Limit;
import com.minimalistalliance.desk.agent.limits.LimitPolicy;
import com.minimalistalliance.desk.agent.limits.LimitReachedException;
import com.minimalistalliance.desk.agent.limits.PriceTable;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import com.minimalistalliance.desk.agent.provider.http.HttpTransport;
import com.minimalistalliance.desk.agent.provider.openrouter.OpenRouterProvider;
import com.minimalistalliance.desk.agent.testing.FakeOpenRouter;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The "$0 first Agent run": OpenRouter's free models through the real gateway, ledger and bundled price table. A
 * free model costs a real $0, so no dollar limit refuses it, while token limits still bind; a cost OpenRouter reports
 * is charged; a paid model the table doesn't list still counts at the table's highest.
 */
class OpenRouterGatewayTest {

    private static final String FREE = "nvidia/nemotron-3.5-super-vl:free";

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-11T10:00:00Z"));
    private FakeOpenRouter server;
    private AuditLog audit;
    private UsageLedger ledger;
    private KeyRing keys;
    private LlmGateway gateway;

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeOpenRouter();
        audit = new AuditLog(dir.resolve("audit.db"), clock);
        ledger = new UsageLedger(dir.resolve("usage.db"), clock, ZoneOffset.UTC);
        audit.open();
        ledger.open();
        keys = new KeyRing((action, target, decision) -> {});
        keys.put("k1", ProviderId.OPENROUTER, FakeOpenRouter.KEY.getBytes(StandardCharsets.US_ASCII));
        ProviderRegistry providers = new ProviderRegistry();
        providers.register(new OpenRouterProvider(new HttpTransport(
                new HttpTransport.Timeouts(Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofSeconds(2)), null),
                HttpTransport.baseUri(server.url())));
        gateway = new LlmGateway(providers, keys, new PriceTable(Pricing.bundled()), ledger, audit);
    }

    @AfterEach
    void tearDown() {
        keys.dropAll();
        ledger.close();
        audit.close();
        server.close();
    }

    private static LimitPolicy agentDay(Limit limit) {
        return new LimitPolicy(limit, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, 50);
    }

    private static ChatRequest request(String model, int maxOutput) {
        return new ChatRequest(model, "", List.of(ChatMessage.user("Hello?")), maxOutput);
    }

    private LlmGateway.Call call() {
        return new LlmGateway.Call("manager", "r1", "k1", ProviderId.OPENROUTER);
    }

    @Test
    void aFreeModelCostsARealZeroSoNoDollarLimitRefusesIt() throws Exception {
        // One micro-dollar a day: anything priced at all would be refused.
        LlmGateway.Outcome outcome = gateway.call(call(), request(FREE, 4096), agentDay(new Limit(1L, null)),
                text -> {});
        assertThat(outcome.costMicroUsd()).isZero();
        assertThat(outcome.result().text()).isEqualTo("Hello from the stand-in.");
        assertThat(ledger.agentToday("manager")).isEqualTo(new UsageLedger.Spent(120, 0));
        assertThat(audit.read(0, 10)).last().satisfies(row -> {
            assertThat(row.entry().target()).isEqualTo("key:k1 model:openrouter/" + FREE);
            assertThat(row.entry().decision()).isEqualTo("ok");
            assertThat(row.entry().costMicroUsd()).isZero();
        });
        // The free router too.
        assertThat(gateway.call(call(), request(OpenRouterProvider.FREE_ROUTER, 64), agentDay(new Limit(1L, null)),
                text -> {}).costMicroUsd()).isZero();
    }

    @Test
    void aTokenLimitStillBindsAFreeModel() {
        assertThatThrownBy(() -> gateway.call(call(), request(FREE, 4096), agentDay(Limit.tokens(1000)), text -> {}))
                .isInstanceOf(LimitReachedException.class);
        assertThat(server.requests).isEmpty();
    }

    @Test
    void whatOpenRouterSaysItBilledIsChargedWhenItsMore() throws Exception {
        server.then(FakeOpenRouter.answer(FREE, 100, 0, 20, "0.0012", "Not so free."));
        assertThat(gateway.call(call(), request(FREE, 64), agentDay(Limit.NONE), text -> {}).costMicroUsd())
                .isEqualTo(1200);
        assertThat(ledger.agentToday("manager").microUsd()).isEqualTo(1200);
    }

    @Test
    void aPaidModelTheTableDoesntListStillCountsAtItsHighest() {
        // The bundled table lists no OpenRouter model, so the whole table's highest output price applies, and 100,000
        // tokens out at it are far past a $1 day.
        assertThatThrownBy(() -> gateway.call(call(), request("acme/paid-model", 100_000), agentDay(Limit.usd("1")),
                text -> {})).isInstanceOf(LimitReachedException.class);
        assertThat(server.requests).isEmpty();
    }
}
