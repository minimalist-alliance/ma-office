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
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Desk Maia's calls through the gateway on Minimalist Alliance's service ({@code ma}): no key is lent but the empty
 * company lease, no price row is needed, no dollars are reserved or kept (her calls are the company's, the owner, Nov
 * 15), no dollar limit of the member's binds or counts her, a refusal before the call settles nothing, and the service is
 * hers alone.
 */
class LlmGatewayCompanyTest {

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Rig.START);
    private AuditLog audit;
    private UsageLedger ledger;
    private KeyRing keys;
    private final ProviderRegistry providers = new ProviderRegistry();
    private final FakeProvider company = new FakeProvider(ProviderId.MA);
    private final FakeProvider member = new FakeProvider();
    private LlmGateway gateway;

    private static final LimitPolicy OPEN = new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE,
            Limit.NONE, Limit.NONE, 1000);

    @BeforeEach
    void setUp() throws Exception {
        audit = new AuditLog(dir.resolve("audit.db"), clock);
        ledger = new UsageLedger(dir.resolve("usage.db"), clock, ZoneOffset.UTC);
        audit.open();
        ledger.open();
        keys = new KeyRing((action, target, decision) -> audit.append(AuditLog.Entry.of("system", action, target,
                decision)));
        keys.put("k1", FakeProvider.ID, "sk-test-0123456789abcdef".getBytes(StandardCharsets.US_ASCII));
        providers.register(company);
        providers.register(member);
        // A table that prices the member's model only: nothing names her service.
        gateway = new LlmGateway(providers, keys, new PriceTable(Pricing.of(Map.of(FakeProvider.ID.id() + "/"
                + Rig.MODEL, new Pricing.Price(1_000_000, 100_000, 1_250_000, 2_000_000)))), ledger, audit);
    }

    @AfterEach
    void tearDown() {
        keys.dropAll();
        ledger.close();
        audit.close();
    }

    private static ChatRequest turn() {
        return new ChatRequest("turn", "ctx", List.of(ChatMessage.user("hi")), 4_000);
    }

    private static LlmGateway.Call maia() {
        return new LlmGateway.Call("maia", "run-1", KeyRing.COMPANY, ProviderId.MA);
    }

    @Test
    void herCallNeedsNoKeyNoPriceRowAndKeepsNoDollars() throws Exception {
        company.then(FakeProvider.Step.answer(new Usage(1000, 0, 0, 100, 0), "On it."));
        LlmGateway.Reserved reserved = gateway.reserve(maia(), turn(), OPEN);
        assertThat(reserved.call().provider()).isEqualTo(ProviderId.MA);
        LlmGateway.Outcome outcome = gateway.complete(reserved, t -> {});
        assertThat(outcome.result().text()).isEqualTo("On it.");
        // The company lease is empty: no key went anywhere.
        assertThat(company.seen.peek().key()).isEmpty();
        // Her calls are the company's (the owner, Nov 15): no dollar figure of hers on the member's ledger.
        assertThat(outcome.costMicroUsd()).isNull();

        // Even when a provider under her id says what it cost, and a table names her service: none kept.
        LlmGateway priced = new LlmGateway(registryWith(new CostingProvider(21384L)), keys,
                new PriceTable(Pricing.of(Map.of(ProviderId.MA.id() + "/turn", new Pricing.Price(9_000_000, 0, 0,
                        90_000_000)))), ledger, audit);
        assertThat(priced.call(maia(), turn(), OPEN, t -> {}).costMicroUsd()).isNull();
        assertThat(ledger.agentToday("maia").microUsd()).isZero();
        // Her tokens are still on her own rows, for her run's steps and the team view's counts.
        assertThat(ledger.agentToday("maia").tokens()).isPositive();
    }

    @Test
    void noDollarLimitOfTheMembersBindsHerOrCountsHer() throws Exception {
        // Every dollar limit at its tightest: her agent's day, week and month, the desk's day and month, a key's month, a
        // run's. None binds her: her calls are the company's.
        LimitPolicy tight = new LimitPolicy(new Limit(1L, null), new Limit(1L, null), new Limit(1L, null),
                new Limit(1L, null), new Limit(1L, null), new Limit(1L, null), new Limit(1L, null), 1000);
        company.then(FakeProvider.Step.answer(new Usage(1000, 0, 0, 100, 0), "One."));
        gateway.complete(gateway.reserve(maia(), turn(), tight), t -> {});
        assertThat(company.requests()).hasSize(1);
        // The desk's own token limits are the member's too: they don't bind her either.
        LimitPolicy deskTokens = new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, Limit.tokens(1), Limit.tokens(1),
                Limit.tokens(1), Limit.NONE, 1000);
        company.then(FakeProvider.Step.answer(new Usage(1000, 0, 0, 100, 0), "Two."));
        gateway.complete(gateway.reserve(maia(), turn(), deskTokens), t -> {});
        assertThat(company.requests()).hasSize(2);

        // And what she spent doesn't count against the member's own agents: the desk's month ($20 by default) and day
        // see none of it, tokens and all.
        // Her two calls settled 2,200 tokens: counted, they'd refuse this one at the desk's 1,000.
        LimitPolicy deskOnly = new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, new Limit(1_000_000L, 1_000L),
                new Limit(1_000_000L, 1_000L), Limit.NONE, Limit.NONE, 1000);
        member.then(FakeProvider.Step.answer(new Usage(10, 0, 0, 10, 0), "Mine."));
        gateway.complete(gateway.reserve(new LlmGateway.Call("manager", "run-2", "k1", FakeProvider.ID),
                new ChatRequest(Rig.MODEL, "", List.of(ChatMessage.user("hi")), 100), deskOnly), t -> {});
        assertThat(member.requests()).hasSize(1);
        for (UsageLedger.ScopeUsage scope : ledger.usage("manager", "k1")) {
            if (scope.scope() == com.minimalistalliance.desk.agent.limits.Scope.DESK_DAY
                    || scope.scope() == com.minimalistalliance.desk.agent.limits.Scope.DESK_MONTH) {
                assertThat(scope.spent().tokens()).as(scope.scope().name()).isLessThan(1_000);
            }
        }
        // A run's step count still binds her: it stops a runaway loop, and it's no one's money.
        LimitPolicy oneStep = new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE,
                Limit.NONE, 1);
        company.then(FakeProvider.Step.answer(new Usage(10, 0, 0, 10, 0), "Three."));
        gateway.complete(gateway.reserve(new LlmGateway.Call("maia", "run-3", KeyRing.COMPANY, ProviderId.MA),
                turn(), oneStep), t -> {});
        assertThatThrownBy(() -> gateway.reserve(new LlmGateway.Call("maia", "run-3", KeyRing.COMPANY, ProviderId.MA),
                turn(), oneStep)).isInstanceOf(LimitReachedException.class);
    }

    @Test
    void aRefusalBeforeTheCallSettlesNothing() throws Exception {
        for (ProviderException.Kind kind : List.of(ProviderException.Kind.LIMIT, ProviderException.Kind.RATE_LIMITED,
                ProviderException.Kind.FORBIDDEN, ProviderException.Kind.TOO_LARGE, ProviderException.Kind.BAD_REQUEST,
                ProviderException.Kind.UNAVAILABLE)) {
            company.then(FakeProvider.Step.fail(kind, false));
            LlmGateway.Reserved reserved = gateway.reserve(maia(), turn(), OPEN);
            assertThatThrownBy(() -> gateway.complete(reserved, t -> {})).isInstanceOf(ProviderException.class);
            assertThat(reserved.keptMicroUsd()).as(kind.name()).isZero();
        }
        assertThat(ledger.agentToday("maia").microUsd()).isZero();
    }

    @Test
    void theServiceIsHersAloneAndSheUsesNothingElse() throws Exception {
        assertThatThrownBy(() -> gateway.reserve(new LlmGateway.Call("manager", "r", KeyRing.COMPANY, ProviderId.MA),
                turn(), OPEN)).isInstanceOfSatisfying(GatewayException.class,
                        e -> assertThat(e.reason()).isEqualTo(GatewayException.Reason.KEY_PROVIDER_MISMATCH));
        assertThatThrownBy(() -> gateway.reserve(new LlmGateway.Call("maia", "r", "k1", FakeProvider.ID),
                new ChatRequest(Rig.MODEL, "", List.of(ChatMessage.user("hi")), 100), OPEN))
                .isInstanceOfSatisfying(GatewayException.class,
                        e -> assertThat(e.reason()).isEqualTo(GatewayException.Reason.KEY_PROVIDER_MISMATCH));
        // A member's key never stands for it, and the company "key" is never another provider's.
        assertThatThrownBy(() -> gateway.reserve(new LlmGateway.Call("maia", "r", "k1", ProviderId.MA), turn(), OPEN))
                .isInstanceOf(GatewayException.class);
        assertThat(company.requests()).isEmpty();
        assertThat(member.requests()).isEmpty();
    }

    private ProviderRegistry registryWith(FakeProviderLike provider) {
        ProviderRegistry registry = new ProviderRegistry();
        registry.register(provider);
        return registry;
    }

    /** A provider under {@code ma} that says what each call cost. */
    private interface FakeProviderLike extends com.minimalistalliance.desk.agent.provider.ChatProvider {}

    private static final class CostingProvider implements FakeProviderLike {
        private final long cost;

        CostingProvider(long cost) {
            this.cost = cost;
        }

        @Override
        public com.minimalistalliance.desk.agent.provider.ProviderInfo info() {
            return new com.minimalistalliance.desk.agent.provider.ProviderInfo(ProviderId.MA, "x", "");
        }

        @Override
        public ChatResult chat(ChatRequest request, com.minimalistalliance.desk.agent.key.KeyLease key,
                com.minimalistalliance.desk.agent.provider.DeltaSink sink) {
            return new ChatResult("ok", new Usage(5000, 0, 0, 500, 0), "maia", "end_turn", List.of(), cost);
        }

        @Override
        public List<com.minimalistalliance.desk.agent.provider.ModelInfo> models(
                com.minimalistalliance.desk.agent.key.KeyLease key) {
            return List.of();
        }
    }
}
