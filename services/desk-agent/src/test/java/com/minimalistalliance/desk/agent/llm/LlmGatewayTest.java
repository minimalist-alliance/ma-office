package com.minimalistalliance.desk.agent.llm;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.limits.Limit;
import com.minimalistalliance.desk.agent.limits.LimitPolicy;
import com.minimalistalliance.desk.agent.limits.LimitReachedException;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.limits.Scope;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The limits and the audit log against the fake provider. Every call here sends 300 bytes and allows 100 tokens
 * out, so its worst case is 100 tokens in and 100 out: 200 tokens, and 300 µ$ at the rig's $1 and $2 a million. The
 * fake's default answer reports 100 in and 20 out: 120 tokens and 140 µ$.
 */
class LlmGatewayTest {

    private static final LimitPolicy NO_LIMITS =
            new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, 1000);

    @TempDir
    Path dir;

    private Rig rig;
    private int runs;

    @BeforeEach
    void setUp() throws Exception {
        rig = new Rig(dir);
    }

    @AfterEach
    void tearDown() {
        rig.close();
    }

    @Test
    void aCallIsReservedSettledAndAuditedOnce() throws Exception {
        List<String> deltas = new ArrayList<>();
        LlmGateway.Outcome outcome = rig.gateway.call(call("manager", "r1"), request(Rig.MODEL), NO_LIMITS,
                deltas::add);

        assertThat(outcome.result().text()).isEqualTo("Hello from the fake.");
        assertThat(deltas).containsExactly("Hello", " from", " the fake.");
        assertThat(outcome.costMicroUsd()).isEqualTo(140);
        assertThat(rig.ledger.agentToday("manager")).isEqualTo(new UsageLedger.Spent(120, 140));
        assertThat(rig.provider.seen).singleElement().satisfies(seen -> assertThat(seen.key()).isEqualTo(Rig.KEY));

        List<AuditLog.Row> rows = rig.audit.read(0, 10);
        assertThat(rows).extracting(row -> row.entry().action()).containsExactly("key.add", "llm.call");
        AuditLog.Entry call = rows.get(1).entry();
        assertThat(call.actor()).isEqualTo("agent:manager");
        assertThat(call.target()).isEqualTo("key:k1 model:fake/fake-model");
        assertThat(call.decision()).isEqualTo("ok");
        assertThat(call.costMicroUsd()).isEqualTo(140);
        assertThat(call.payloadSha256()).hasSize(32);
        assertThat(rig.audit.verify().intact()).isTrue();
    }

    @Test
    void theDayLimitRefusesTheCallThatWouldPassItAndNothingIsSent() throws Exception {
        // 500 µ$: two calls settle at 140 each, and a third's worst case of 300 would make 580.
        LimitPolicy policy = only(new LimitPolicy(Limit.usd("0.0005"), Limit.NONE, Limit.NONE, Limit.NONE,
                Limit.NONE, Limit.NONE, 1000));
        rig.gateway.call(call("manager", next()), request(Rig.MODEL), policy, DeltaSink.NONE);
        rig.gateway.call(call("manager", next()), request(Rig.MODEL), policy, DeltaSink.NONE);

        assertThatThrownBy(() -> rig.gateway.call(call("manager", next()), request(Rig.MODEL), policy, DeltaSink.NONE))
                .isInstanceOfSatisfying(LimitReachedException.class, e -> {
                    assertThat(e.scope()).isEqualTo(Scope.AGENT_DAY);
                    assertThat(e.unit()).isEqualTo("usd");
                    assertThat(e.spent()).isEqualTo(280);
                    assertThat(e.needed()).isEqualTo(300);
                });
        assertThat(rig.provider.seen).hasSize(2);
        assertThat(rig.audit.read(0, 10)).last().satisfies(row -> {
            assertThat(row.entry().action()).isEqualTo("limit.hit");
            assertThat(row.entry().target()).isEqualTo("scope:agent_day key:k1 model:fake/fake-model");
            assertThat(row.entry().decision()).isEqualTo("refused:usd");
        });

        // Tomorrow it's allowed again.
        rig.clock.advance(Duration.ofDays(1));
        rig.gateway.call(call("manager", next()), request(Rig.MODEL), policy, DeltaSink.NONE);
        assertThat(rig.provider.seen).hasSize(3);
    }

    @Test
    void stepsStopARunawayRun() throws Exception {
        LimitPolicy policy = new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, 3);
        for (int i = 0; i < 3; i++) {
            rig.gateway.call(call("manager", "loop"), request(Rig.MODEL), policy, DeltaSink.NONE);
        }
        assertThatThrownBy(() -> rig.gateway.call(call("manager", "loop"), request(Rig.MODEL), policy, DeltaSink.NONE))
                .isInstanceOfSatisfying(LimitReachedException.class, e -> {
                    assertThat(e.scope()).isEqualTo(Scope.RUN_STEPS);
                    assertThat(e.unit()).isEqualTo("steps");
                });
        // Another run isn't affected.
        rig.gateway.call(call("manager", "other"), request(Rig.MODEL), policy, DeltaSink.NONE);
    }

    @Test
    void aRunsDollarLimitCountsOnlyThatRun() throws Exception {
        LimitPolicy policy = only(new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE,
                Limit.usd("0.0004"), 1000));
        rig.gateway.call(call("manager", "a"), request(Rig.MODEL), policy, DeltaSink.NONE);
        assertThatThrownBy(() -> rig.gateway.call(call("manager", "a"), request(Rig.MODEL), policy, DeltaSink.NONE))
                .isInstanceOfSatisfying(LimitReachedException.class, e -> assertThat(e.scope()).isEqualTo(Scope.RUN));
        rig.gateway.call(call("manager", "b"), request(Rig.MODEL), policy, DeltaSink.NONE);
    }

    @Test
    void theDeskAndKeyLimitsCountEveryAgent() throws Exception {
        LimitPolicy desk = only(new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, Limit.usd("0.0004"), Limit.NONE,
                Limit.NONE, 1000));
        rig.gateway.call(call("manager", next()), request(Rig.MODEL), desk, DeltaSink.NONE);
        assertThatThrownBy(() -> rig.gateway.call(call("writer", next()), request(Rig.MODEL), desk, DeltaSink.NONE))
                .isInstanceOfSatisfying(LimitReachedException.class,
                        e -> assertThat(e.scope()).isEqualTo(Scope.DESK_MONTH));

        LimitPolicy key = only(new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE, Limit.tokens(300),
                Limit.NONE, 1000));
        assertThatThrownBy(() -> rig.gateway.call(call("writer", next()), request(Rig.MODEL), key, DeltaSink.NONE))
                .isInstanceOfSatisfying(LimitReachedException.class, e -> {
                    assertThat(e.scope()).isEqualTo(Scope.KEY_MONTH);
                    assertThat(e.unit()).isEqualTo("tokens");
                });
    }

    @Test
    void aWeekStartsOnMondayAndAMonthOnTheFirst() throws Exception {
        // 2026-11-04 is a Wednesday.
        LimitPolicy week = only(new LimitPolicy(Limit.NONE, Limit.tokens(300), Limit.NONE, Limit.NONE, Limit.NONE,
                Limit.NONE, 1000));
        rig.gateway.call(call("manager", next()), request(Rig.MODEL), week, DeltaSink.NONE);
        rig.clock.advance(Duration.ofDays(4)); // Sunday
        assertThatThrownBy(() -> rig.gateway.call(call("manager", next()), request(Rig.MODEL), week, DeltaSink.NONE))
                .isInstanceOf(LimitReachedException.class);
        rig.clock.advance(Duration.ofDays(1)); // Monday
        rig.gateway.call(call("manager", next()), request(Rig.MODEL), week, DeltaSink.NONE);

        LimitPolicy month = only(new LimitPolicy(Limit.NONE, Limit.NONE, Limit.tokens(300), Limit.NONE, Limit.NONE,
                Limit.NONE, 1000));
        assertThatThrownBy(() -> rig.gateway.call(call("manager", next()), request(Rig.MODEL), month, DeltaSink.NONE))
                .isInstanceOf(LimitReachedException.class);
        rig.clock.advance(Duration.ofDays(22)); // December 1st
        rig.gateway.call(call("manager", next()), request(Rig.MODEL), month, DeltaSink.NONE);
    }

    /**
     * ADR 0043: a model the table doesn't list counts at its provider's highest listed price, in the reservation and in
     * what's settled, so a dollar limit binds it, where it used to pass every default limit and count as $0.
     */
    @Test
    void anUnlistedModelCountsAtItsProvidersHighestPriceSoADollarLimitBindsIt() throws Exception {
        LimitPolicy dollars = only(new LimitPolicy(Limit.usd("0.000001"), Limit.NONE, Limit.NONE, Limit.NONE,
                Limit.NONE, Limit.NONE, 1000));
        assertThatThrownBy(() ->
                        rig.gateway.call(call("manager", next()), request(Rig.UNPRICED_MODEL), dollars, DeltaSink.NONE))
                .isInstanceOfSatisfying(LimitReachedException.class, e -> {
                    assertThat(e.unit()).isEqualTo("usd");
                    // 100 tokens in and 100 out at the rig's one price.
                    assertThat(e.needed()).isEqualTo(300);
                });
        assertThat(rig.provider.seen).isEmpty();

        LlmGateway.Outcome outcome =
                rig.gateway.call(call("manager", next()), request(Rig.UNPRICED_MODEL), NO_LIMITS, DeltaSink.NONE);
        assertThat(outcome.costMicroUsd()).isEqualTo(140);
        assertThat(rig.ledger.agentToday("manager")).isEqualTo(new UsageLedger.Spent(120, 140));
        assertThat(rig.audit.read(0, 10)).last().satisfies(row -> assertThat(row.entry().costMicroUsd()).isEqualTo(140));
        // The table still has no price for it, which is what a client shows.
        assertThat(rig.pricing.price(FakeProvider.ID, Rig.UNPRICED_MODEL)).isNull();

        LimitPolicy tokens = only(new LimitPolicy(Limit.tokens(250), Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE,
                Limit.NONE, 1000));
        assertThatThrownBy(() ->
                        rig.gateway.call(call("manager", next()), request(Rig.UNPRICED_MODEL), tokens, DeltaSink.NONE))
                .isInstanceOfSatisfying(LimitReachedException.class, e -> assertThat(e.unit()).isEqualTo("tokens"));
    }

    /** With a table that has no models, which production never has, only tokens and steps can bind. */
    @Test
    void withNoPricesAtAllACallCostsNothingKnown() throws Exception {
        LlmGateway gateway = new LlmGateway(rig.providers, rig.keys, Pricing.of(Map.of()), rig.ledger, rig.audit);
        assertThat(gateway.call(call("manager", next()), request(Rig.MODEL), NO_LIMITS, DeltaSink.NONE).costMicroUsd())
                .isNull();
    }

    /** ADR 0043: a new table prices the next call. One already reserved settles at the price it reserved at. */
    @Test
    void aNewTableChangesTheNextCallAndNotOneAlreadyGoing() throws Exception {
        LlmGateway.Reserved going = rig.gateway.reserve(call("manager", next()), request(Rig.MODEL), NO_LIMITS);
        assertThat(rig.prices.apply("""
                {"version": 1, "checked": "2027-01-02", "models": {"fake/fake-model": {"input": "10", "output": "20"}}}"""
                .getBytes(StandardCharsets.UTF_8))).isTrue();

        assertThat(rig.gateway.complete(going, DeltaSink.NONE).costMicroUsd()).isEqualTo(140);
        assertThat(rig.gateway.call(call("manager", next()), request(Rig.MODEL), NO_LIMITS, DeltaSink.NONE).costMicroUsd())
                .isEqualTo(1400);
        assertThat(rig.ledger.agentToday("manager")).isEqualTo(new UsageLedger.Spent(240, 1540));

        // A bad table changes nothing, and the agent goes on.
        assertThat(rig.prices.apply("{}".getBytes(StandardCharsets.UTF_8))).isFalse();
        assertThat(rig.gateway.call(call("manager", next()), request(Rig.MODEL), NO_LIMITS, DeltaSink.NONE).costMicroUsd())
                .isEqualTo(1400);
    }

    @Test
    void theDesksDayRefusesAcrossAgentsAndIsAudited() throws Exception {
        LimitPolicy day = new LimitPolicy(Limit.NONE, Limit.NONE, Limit.NONE, Limit.usd("0.0004"), Limit.NONE, Limit.NONE,
                Limit.NONE, 1000);
        rig.gateway.call(call("manager", next()), request(Rig.MODEL), day, DeltaSink.NONE);
        assertThatThrownBy(() -> rig.gateway.call(call("writer", next()), request(Rig.MODEL), day, DeltaSink.NONE))
                .isInstanceOfSatisfying(LimitReachedException.class, e -> assertThat(e.scope()).isEqualTo(Scope.DESK_DAY));
        assertThat(rig.audit.read(0, 10)).last().satisfies(row -> {
            assertThat(row.entry().action()).isEqualTo("limit.hit");
            assertThat(row.entry().target()).startsWith("scope:desk_day ");
        });
    }

    @Test
    void aCallRefusedBeforeGeneratingCostsNothing() throws Exception {
        rig.provider.then(FakeProvider.Step.fail(ProviderException.Kind.AUTH, false));
        assertThatThrownBy(() -> rig.gateway.call(call("manager", "r"), request(Rig.MODEL), NO_LIMITS, DeltaSink.NONE))
                .isInstanceOfSatisfying(ProviderException.class,
                        e -> assertThat(e.kind()).isEqualTo(ProviderException.Kind.AUTH));
        assertThat(rig.ledger.agentToday("manager")).isEqualTo(new UsageLedger.Spent(0, 0));
        assertThat(rig.audit.read(0, 10)).last().satisfies(row -> {
            assertThat(row.entry().decision()).isEqualTo("error:auth");
            assertThat(row.entry().costMicroUsd()).isNull();
        });
    }

    @Test
    void aCallCutShortCountsItsWholeReservation() throws Exception {
        rig.provider.then(FakeProvider.Step.fail(ProviderException.Kind.TIMEOUT, true));
        assertThatThrownBy(() -> rig.gateway.call(call("manager", "r"), request(Rig.MODEL), NO_LIMITS, DeltaSink.NONE))
                .isInstanceOf(ProviderException.class);
        assertThat(rig.ledger.agentToday("manager")).isEqualTo(new UsageLedger.Spent(200, 300));
        assertThat(rig.audit.read(0, 10)).last().satisfies(row -> {
            assertThat(row.entry().decision()).isEqualTo("error:timeout");
            assertThat(row.entry().costMicroUsd()).isEqualTo(300);
        });
    }

    @Test
    void aFailedStepSaysWhatItLeftSpent() throws Exception {
        rig.provider.then(FakeProvider.Step.fail(ProviderException.Kind.TIMEOUT, true));
        LlmGateway.Reserved reserved = rig.gateway.reserve(call("manager", "r"), request(Rig.MODEL), NO_LIMITS);
        assertThatThrownBy(() -> rig.gateway.complete(reserved, DeltaSink.NONE)).isInstanceOf(ProviderException.class);
        assertThat(reserved.keptMicroUsd()).isEqualTo(300);
        // A refused call that was never billed leaves nothing.
        rig.provider.then(FakeProvider.Step.fail(ProviderException.Kind.AUTH, false));
        LlmGateway.Reserved free = rig.gateway.reserve(call("manager", "r2"), request(Rig.MODEL), NO_LIMITS);
        assertThatThrownBy(() -> rig.gateway.complete(free, DeltaSink.NONE)).isInstanceOf(ProviderException.class);
        assertThat(free.keptMicroUsd()).isZero();
    }

    /** xAI's output cap is for visible text only, so its calls reserve room for reasoning too. */
    @Test
    void anXaiCallReservesReasoningHeadroomOverTheCap() throws Exception {
        rig.providers.register(new FakeProvider(ProviderId.XAI));
        rig.keys.put("xai-key", ProviderId.XAI, "xai-0123456789".getBytes(StandardCharsets.US_ASCII));
        LlmGateway.Reserved reserved = rig.gateway.reserve(
                new LlmGateway.Call("manager", "r", "xai-key", ProviderId.XAI), request("grok-4.5"), NO_LIMITS);
        assertThat(rig.ledger.agentToday("manager").tokens()).isEqualTo(100 + 4 * 100);
        rig.gateway.complete(reserved, DeltaSink.NONE);
    }

    /**
     * Ten runs at once against room for three worst cases (1000 µ$ over 300 each). The calls are held in the
     * provider, so all ten reservations happen before any settles: exactly three go out.
     */
    @Test
    void concurrentRunsCantOverspend() throws Exception {
        LimitPolicy policy = only(new LimitPolicy(Limit.usd("0.001"), Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE,
                Limit.NONE, 1000));
        CountDownLatch release = new CountDownLatch(1);
        for (int i = 0; i < 10; i++) {
            rig.provider.then(FakeProvider.Step.answer(new Usage(100, 0, 0, 20, 0), "x").heldBy(release));
        }
        AtomicInteger refused = new AtomicInteger();
        AtomicInteger answered = new AtomicInteger();
        CountDownLatch done = new CountDownLatch(10);
        for (int i = 0; i < 10; i++) {
            String runId = next();
            Thread.ofVirtual().start(() -> {
                try {
                    rig.gateway.call(call("manager", runId), request(Rig.MODEL), policy, DeltaSink.NONE);
                    answered.incrementAndGet();
                } catch (LimitReachedException e) {
                    refused.incrementAndGet();
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                } finally {
                    done.countDown();
                }
            });
        }
        // Seven refusals come back while three calls are held in the provider.
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (refused.get() < 7 && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertThat(refused.get()).isEqualTo(7);
        assertThat(rig.provider.seen).hasSize(3);
        release.countDown();
        assertThat(done.await(10, TimeUnit.SECONDS)).isTrue();
        assertThat(answered.get()).isEqualTo(3);
        assertThat(rig.ledger.agentToday("manager")).isEqualTo(new UsageLedger.Spent(360, 420));
        assertThat(rig.audit.verify().intact()).isTrue();
    }

    @Test
    void reservationsACrashLeftCountAsSpent() throws Exception {
        rig.ledger.reserve(new UsageLedger.Call("manager", "r", Rig.KEY_ID, FakeProvider.ID, Rig.MODEL),
                new UsageLedger.Estimate(200, 300L), NO_LIMITS);
        rig.ledger.close();
        rig.ledger.open();
        assertThat(rig.ledger.orphansAtOpen()).isEqualTo(1);
        assertThat(rig.ledger.agentToday("manager")).isEqualTo(new UsageLedger.Spent(200, 300));
    }

    /** A key is only ever sent to the provider it belongs to. */
    @Test
    void aKeyForAnotherProviderIsNeverSent() throws Exception {
        rig.keys.put("openai-key", ProviderId.OPENAI, "sk-proj-0123456789".getBytes(StandardCharsets.US_ASCII));
        assertThatThrownBy(() -> rig.gateway.call(new LlmGateway.Call("manager", "r", "openai-key", FakeProvider.ID),
                        request(Rig.MODEL), NO_LIMITS, DeltaSink.NONE))
                .isInstanceOfSatisfying(GatewayException.class,
                        e -> assertThat(e.reason()).isEqualTo(GatewayException.Reason.KEY_PROVIDER_MISMATCH));
        assertThatThrownBy(() -> rig.gateway.call(new LlmGateway.Call("manager", "r", "absent", FakeProvider.ID),
                        request(Rig.MODEL), NO_LIMITS, DeltaSink.NONE))
                .isInstanceOfSatisfying(GatewayException.class,
                        e -> assertThat(e.reason()).isEqualTo(GatewayException.Reason.NO_KEY));
        assertThatThrownBy(() -> rig.gateway.call(new LlmGateway.Call("manager", "r", "openai-key", ProviderId.OPENAI),
                        request(Rig.MODEL), NO_LIMITS, DeltaSink.NONE))
                .isInstanceOfSatisfying(GatewayException.class,
                        e -> assertThat(e.reason()).isEqualTo(GatewayException.Reason.NO_PROVIDER));
        assertThat(rig.provider.seen).isEmpty();
    }

    @Test
    void withTheAuditLogClosedNothingIsSent() {
        rig.audit.close();
        assertThatThrownBy(() -> rig.gateway.call(call("manager", "r"), request(Rig.MODEL), NO_LIMITS, DeltaSink.NONE))
                .isInstanceOfSatisfying(GatewayException.class,
                        e -> assertThat(e.reason()).isEqualTo(GatewayException.Reason.NOT_READY));
        assertThat(rig.provider.seen).isEmpty();
    }

    private static LimitPolicy only(LimitPolicy policy) {
        return policy;
    }

    private String next() {
        return "run-" + (++runs);
    }

    private static LlmGateway.Call call(String agentId, String runId) {
        return new LlmGateway.Call(agentId, runId, Rig.KEY_ID, FakeProvider.ID);
    }

    private static ChatRequest request(String model) {
        return new ChatRequest(model, "", List.of(ChatMessage.user("x".repeat(300))), 100);
    }
}
