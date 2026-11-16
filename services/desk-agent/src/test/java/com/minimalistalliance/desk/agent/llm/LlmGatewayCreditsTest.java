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
 * Helpers on the member's MA credits through the gateway ({@code ma-credits}, ma-platform desk-helpers.md): any of the member's
 * own agents on the credits "key" only, never Desk Maia; the empty lease; no dollars reserved or kept (the Platform meters in
 * credits); the desk's token limits still bind; a member's key never pairs with the credits provider.
 */
class LlmGatewayCreditsTest {

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Rig.START);
    private AuditLog audit;
    private UsageLedger ledger;
    private KeyRing keys;
    private final ProviderRegistry providers = new ProviderRegistry();
    private final FakeProvider credits = new FakeProvider(ProviderId.MA_CREDITS);
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
        providers.register(credits);
        providers.register(company);
        providers.register(member);
        gateway = new LlmGateway(providers, keys, new PriceTable(Pricing.of(Map.of(FakeProvider.ID.id() + "/"
                + Rig.MODEL, new Pricing.Price(1_000_000, 100_000, 1_250_000, 2_000_000)))), ledger, audit);
    }

    @AfterEach
    void tearDown() {
        keys.dropAll();
        ledger.close();
        audit.close();
    }

    private static ChatRequest call() {
        return new ChatRequest("auto", "You are Research.", List.of(ChatMessage.user("hi")), 8_000);
    }

    @Test
    void aHelperOnTheMembersCreditsNeedsNoKeyAndKeepsNoDollars() throws Exception {
        credits.then(FakeProvider.Step.answer(new Usage(1500, 0, 0, 120, 0), "Opening it."));
        LlmGateway.Outcome outcome = gateway.call(new LlmGateway.Call("research", "run-1", KeyRing.CREDITS,
                ProviderId.MA_CREDITS), call(), OPEN, t -> {});
        assertThat(outcome.result().text()).isEqualTo("Opening it.");
        assertThat(credits.seen.peek().key()).isEmpty();
        assertThat(outcome.costMicroUsd()).isNull();
        assertThat(ledger.agentToday("research").microUsd()).isZero();
        assertThat(ledger.agentToday("research").tokens()).isEqualTo(1620);
    }

    @Test
    void theDesksTokenLimitsStillBindAHelperOnCredits() {
        LimitPolicy tight = new LimitPolicy(new Limit(null, 10L), Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE,
                Limit.NONE, Limit.NONE, 1000);
        assertThatThrownBy(() -> gateway.reserve(new LlmGateway.Call("research", "run-1", KeyRing.CREDITS,
                ProviderId.MA_CREDITS), call(), tight)).isInstanceOf(LimitReachedException.class);
    }

    @Test
    void deskMaiaNeverRunsOnTheMembersCreditsAndNoKeyPairsWithTheirProviderButTheCredits() {
        assertThatThrownBy(() -> gateway.reserve(new LlmGateway.Call("maia", "run-1", KeyRing.CREDITS,
                ProviderId.MA_CREDITS), call(), OPEN)).isInstanceOfSatisfying(GatewayException.class,
                        e -> assertThat(e.reason()).isEqualTo(GatewayException.Reason.KEY_PROVIDER_MISMATCH));
        // The credits key under another provider, or a member's key under the credits provider: refused.
        assertThatThrownBy(() -> gateway.reserve(new LlmGateway.Call("research", "run-1", KeyRing.CREDITS,
                FakeProvider.ID), call(), OPEN)).isInstanceOf(GatewayException.class);
        assertThatThrownBy(() -> gateway.reserve(new LlmGateway.Call("research", "run-1", "k1", ProviderId.MA_CREDITS),
                call(), OPEN)).isInstanceOf(GatewayException.class);
        // And a helper never on Maia's own service.
        assertThatThrownBy(() -> gateway.reserve(new LlmGateway.Call("research", "run-1", KeyRing.COMPANY,
                ProviderId.MA), call(), OPEN)).isInstanceOf(GatewayException.class);
        assertThat(credits.seen).isEmpty();
    }

    @Test
    void theKeyRingNeverHoldsAKeyForTheCreditsAndLendsAnEmptyLease() {
        assertThat(keys.providerOf(KeyRing.CREDITS)).isEqualTo(ProviderId.MA_CREDITS);
        assertThat(keys.lend(KeyRing.CREDITS).bytes()).isEmpty();
        assertThatThrownBy(() -> keys.put(KeyRing.CREDITS, FakeProvider.ID,
                "sk-test-0123456789abcdef".getBytes(StandardCharsets.US_ASCII))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> keys.put("k2", ProviderId.MA_CREDITS,
                "sk-test-0123456789abcdef".getBytes(StandardCharsets.US_ASCII))).isInstanceOf(IllegalArgumentException.class);
    }
}
