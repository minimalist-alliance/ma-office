package com.minimalistalliance.desk.agent.service;

import static org.assertj.core.api.Assertions.assertThat;
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
import com.minimalistalliance.desk.agent.store.AgentRow;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@link AgentService} under calls at once, as deskd's relay makes them: each request on a thread of its own while a
 * reply streams on its run's. Real SQLite files and a real vault in a temporary directory, wired as AgentConfiguration
 * wires them. Nothing here waits without a limit, so a deadlock fails the test rather than hanging it.
 */
class AgentServiceConcurrencyTest {

    private static final String KEY = "sk-fake-service-0123456789abcdef";
    private static final String TOPIC = AgentService.CONVERSATION_PREFIX + AgentStore.MANAGER;

    /** Answers with {@code pieces} deltas, {@code pace} apart, so a reply can keep {@link Deltas} flushing. */
    private static final class PacedProvider implements ChatProvider {
        final FakeProvider fake = new FakeProvider();
        volatile int pieces = 3;
        volatile Duration pace = Duration.ZERO;

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
            StringBuilder text = new StringBuilder();
            for (int i = 0; i < pieces; i++) {
                String piece = i + " ";
                sink.delta(piece);
                text.append(piece);
                if (!pace.isZero()) {
                    try {
                        Thread.sleep(pace);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        throw new ProviderException(ProviderException.Kind.CANCELLED, true);
                    }
                }
            }
            return new ChatResult(text.toString(), new Usage(100, 0, 0, 20, 0), request.model(), "end_turn");
        }
    }

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private final PacedProvider provider = new PacedProvider();
    private final TopicHub topics = new TopicHub();
    private AuditLog audit;
    private UsageLedger ledger;
    private AgentStore store;
    private KeyRing keys;
    private AgentService service;

    @BeforeEach
    void start() throws Exception {
        audit = new AuditLog(data.resolve("audit.db"), clock);
        ledger = new UsageLedger(data.resolve("usage.db"), clock, ZoneOffset.UTC);
        store = new AgentStore(data.resolve("agent.db"), clock);
        audit.open();
        ledger.open();
        store.open();
        keys = new KeyRing((action, target, decision) -> audit.append(AuditLog.Entry.of("user", action, target,
                decision)));
        ProviderRegistry providers = new ProviderRegistry();
        providers.register(provider);
        PriceTable prices = new PriceTable(Pricing.of(Map.of(FakeProvider.ID.id() + "/" + Rig.MODEL,
                new Pricing.Price(1_000_000, 100_000, 1_250_000, 2_000_000))));
        LimitSettings limits = new LimitSettings();
        ManagerAgent manager =
                new ManagerAgent(new LlmGateway(providers, keys, prices, ledger, audit), keys, limits, clock);
        service = new AgentService(store, manager, keys, new KeyVault(data.resolve("keys")), providers, prices, limits,
                ledger, audit, topics, clock, com.minimalistalliance.desk.agent.testing.Teams.team(store, limits, audit,
                        data, clock));
        service.restore();
        ByteBuffer secret = ByteBuffer.allocateDirect(KEY.length()).put(KEY.getBytes(StandardCharsets.US_ASCII)).flip();
        Map<?, ?> key = (Map<?, ?>) service.keyAdd(Map.of("provider", FakeProvider.ID.id(), "label", "Main"), secret)
                .get("key");
        service.call("agent.bind", Map.of("agentId", AgentStore.MANAGER, "keyId", key.get("keyId"), "model", Rig.MODEL));
    }

    @AfterEach
    void stop() {
        service.stopAll();
        keys.dropAll();
        store.close();
        ledger.close();
        audit.close();
    }

    /**
     * The Agent window opened while a reply streams: {@code agent.thread.get} and a subscription's snapshot, each in a
     * loop on its own thread, while the reply flushes a delta every 33 ms. They used to take the topic's lock and the
     * reply's in the opposite order to a flush, and the conversation froze until desk-agent restarted.
     */
    @Test
    void openingTheThreadWhileAReplyStreamsNeverFreezesIt() throws Exception {
        provider.pieces = 1000;
        provider.pace = Duration.ofMillis(1);
        List<String> deltas = new CopyOnWriteArrayList<>();
        CompletableFuture<Map<?, ?>> ended = new CompletableFuture<>();
        topics.subscribe(1, TOPIC, service.snapshotFor(TOPIC), (topic, seq, type, d) -> {
            if (type.equals("delta")) {
                deltas.add((String) d.get("text"));
            } else if (type.equals("message") && d.get("message") instanceof Map<?, ?> message
                    && "assistant".equals(message.get("role")) && !"streaming".equals(message.get("state"))) {
                ended.complete(message);
            }
        });
        AtomicBoolean streaming = new AtomicBoolean(true);
        AtomicInteger reads = new AtomicInteger();
        AtomicInteger snapshots = new AtomicInteger();

        service.call("agent.message.send", Map.of("agentId", AgentStore.MANAGER, "text", "Count, slowly."));
        FutureTask<Void> reader = startVirtual(() -> {
            while (streaming.get()) {
                service.call("agent.thread.get", Map.of("agentId", AgentStore.MANAGER));
                reads.incrementAndGet();
            }
            return null;
        });
        FutureTask<Void> subscriber = startVirtual(() -> {
            for (long sid = 100; streaming.get(); sid++) {
                topics.subscribe(sid, TOPIC, service.snapshotFor(TOPIC), (topic, seq, type, d) -> {});
                topics.unsubscribe(sid);
                snapshots.incrementAndGet();
            }
            return null;
        });

        Map<?, ?> reply = ended.get(30, TimeUnit.SECONDS);
        streaming.set(false);
        reader.get(10, TimeUnit.SECONDS);
        subscriber.get(10, TimeUnit.SECONDS);

        assertThat(reply.get("state")).isEqualTo("done");
        assertThat(reads.get()).as("thread reads during the reply").isPositive();
        assertThat(snapshots.get()).as("snapshots during the reply").isPositive();
        assertThat(deltas.size()).as("flushes").isGreaterThan(10);
        assertThat(String.join("", deltas)).as("every delta once, in order").isEqualTo(reply.get("text"));

        // Not busy: the next send runs. The run had ended before its final message went.
        provider.pieces = 3;
        provider.pace = Duration.ZERO;
        assertThat(service.call("agent.message.send", Map.of("agentId", AgentStore.MANAGER, "text", "Again?")))
                .containsKey("runId");
    }

    /**
     * {@code agent.seen} and {@code agent.limits.set} at once, many times: each used to read the whole row and write it
     * all back, so one could put back the other's older copy, and a lowered limit came back at the next restart.
     */
    @Test
    @SuppressWarnings("unchecked")
    void seenAndLimitsSetAtOnceKeepWhatEachWrote() throws Exception {
        Map<String, Object> policy = new LinkedHashMap<>(
                (Map<String, Object>) service.call("agent.limits.get", Map.of("agentId", AgentStore.MANAGER))
                        .get("policy"));
        policy.remove("deskDay");
        policy.remove("deskMonth");
        for (int round = 1; round <= 150; round++) {
            service.call("agent.message.send", Map.of("agentId", AgentStore.MANAGER, "text", "Round " + round));
            await().atMost(Duration.ofSeconds(10)).pollDelay(Duration.ZERO).pollInterval(Duration.ofMillis(2))
                    .until(() -> store.agent(AgentStore.MANAGER).unseen() > 0);
            long cap = 1_000_000_000L + round;
            Map<String, Object> next = new LinkedHashMap<>(policy);
            Map<String, Object> agentDay = new LinkedHashMap<>();
            agentDay.put("maxMicroUsd", cap);
            agentDay.put("maxTokens", null);
            next.put("agentDay", agentDay);

            CyclicBarrier together = new CyclicBarrier(2);
            FutureTask<Map<String, Object>> seen = startVirtual(() -> {
                together.await(5, TimeUnit.SECONDS);
                return service.call("agent.seen", Map.of("agentId", AgentStore.MANAGER));
            });
            FutureTask<Map<String, Object>> set = startVirtual(() -> {
                together.await(5, TimeUnit.SECONDS);
                return service.call("agent.limits.set", Map.of("agentId", AgentStore.MANAGER, "policy", next));
            });
            seen.get(10, TimeUnit.SECONDS);
            set.get(10, TimeUnit.SECONDS);

            AgentRow row = store.agent(AgentStore.MANAGER);
            assertThat(row.unseen()).as("unseen after round %d", round).isZero();
            assertThat(LimitSettings.AgentLimits.fromJson(row.limits()).day().maxMicroUsd())
                    .as("the stored agentDay after round %d", round).isEqualTo(cap);
        }
    }

    private static <T> FutureTask<T> startVirtual(Callable<T> work) {
        FutureTask<T> task = new FutureTask<>(work);
        Thread.ofVirtual().start(task);
        return task;
    }
}
