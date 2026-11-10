package com.minimalistalliance.desk.agent.testing;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.limits.PriceTable;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.llm.LlmGateway;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;

/**
 * The gateway wired as AgentConfiguration wires it, on real SQLite files in a temporary directory, with a fake
 * provider and a clock the test moves. The fake model is priced at $1 per million input tokens and $2 per million
 * output, so a token of either is easy to count in µ$.
 */
public final class Rig implements AutoCloseable {

    public static final String KEY_ID = "k1";
    public static final String KEY = "sk-test-0123456789abcdef";
    public static final String MODEL = "fake-model";
    public static final String UNPRICED_MODEL = "fake-unpriced";
    public static final Instant START = Instant.parse("2026-11-04T10:00:00Z");

    public final MutableClock clock = new MutableClock(START);
    public final AuditLog audit;
    public final UsageLedger ledger;
    public final KeyRing keys;
    public final ProviderRegistry providers = new ProviderRegistry();
    public final FakeProvider provider = new FakeProvider();
    public final Pricing pricing = Pricing.of(Map.of(
            FakeProvider.ID.id() + "/" + MODEL, new Pricing.Price(1_000_000, 100_000, 1_250_000, 2_000_000)));
    public final PriceTable prices = new PriceTable(pricing);
    public final LlmGateway gateway;

    public Rig(Path dir) throws SQLException {
        audit = new AuditLog(dir.resolve("audit.db"), clock);
        ledger = new UsageLedger(dir.resolve("usage.db"), clock, ZoneOffset.UTC);
        audit.open();
        ledger.open();
        keys = new KeyRing((action, target, decision) -> audit.append(AuditLog.Entry.of("system", action, target,
                decision)));
        providers.register(provider);
        keys.put(KEY_ID, FakeProvider.ID, KEY.getBytes(StandardCharsets.US_ASCII));
        gateway = new LlmGateway(providers, keys, prices, ledger, audit);
    }

    @Override
    public void close() {
        keys.dropAll();
        ledger.close();
        audit.close();
    }
}
