package com.minimalistalliance.desk.agent.limits;

import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Supplier;

/**
 * What each agent's calls on MA's credits drew a day on this desk, in hundredths of a credit (the service's
 * {@code costCredits}): Desk Maia's on her service and any agent's on the member's MA credits (the coordinator's decision of
 * Nov 15: one wallet, and the team view's usage per source in credits). Days of the desk's zone. Counts only, never money:
 * these calls keep no dollars on the usage ledger. A table of {@code agent.db}, made when first used; days past 40 go.
 */
public final class CreditDays {

    /** How long a day's count is kept: past the team view's 7 days and a month. */
    static final int KEEP_DAYS = 40;

    private final AgentStore store;
    private final Clock clock;
    private final Supplier<ZoneId> zone;
    private volatile boolean ready;

    public CreditDays(AgentStore store, Clock clock, Supplier<ZoneId> zone) {
        this.store = store;
        this.clock = clock;
        this.zone = zone;
    }

    private SqliteDatabase db() throws SQLException {
        SqliteDatabase db = store.database();
        if (!ready) {
            synchronized (this) {
                if (!ready) {
                    db.transaction(connection -> {
                        try (Statement s = connection.createStatement()) {
                            s.execute("""
                                    CREATE TABLE IF NOT EXISTS credit_days (
                                      day TEXT NOT NULL,
                                      agent_id TEXT NOT NULL,
                                      centi INTEGER NOT NULL,
                                      PRIMARY KEY (day, agent_id)
                                    ) STRICT""");
                        }
                        return null;
                    });
                    ready = true;
                }
            }
        }
        return db;
    }

    /** Today in the desk's zone. */
    public String today() {
        return LocalDate.ofInstant(Instant.ofEpochMilli(clock.millis()), zone.get()).toString();
    }

    /** A call of this agent's drew {@code centi} hundredths of a credit: counted on today. */
    public void add(String agentId, long centi) throws SQLException {
        if (agentId == null || centi <= 0) {
            return;
        }
        String day = today();
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement("INSERT INTO credit_days (day, agent_id, centi)"
                    + " VALUES (?, ?, ?) ON CONFLICT (day, agent_id) DO UPDATE SET centi = centi + excluded.centi")) {
                up.setString(1, day);
                up.setString(2, agentId);
                up.setLong(3, centi);
                up.executeUpdate();
            }
            try (PreparedStatement del = connection.prepareStatement("DELETE FROM credit_days WHERE day < ?")) {
                del.setString(1, LocalDate.parse(day).minusDays(KEEP_DAYS).toString());
                del.executeUpdate();
            }
            return null;
        });
    }

    /** Each agent's credits a day from {@code fromDay} on: agent id, then day, in hundredths. */
    public Map<String, Map<String, Long>> since(String fromDay) throws SQLException {
        return db().call(connection -> {
            Map<String, Map<String, Long>> out = new HashMap<>();
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT agent_id, day, centi FROM credit_days WHERE day >= ?")) {
                q.setString(1, fromDay);
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        out.computeIfAbsent(r.getString(1), k -> new HashMap<>()).put(r.getString(2), r.getLong(3));
                    }
                }
            }
            return out;
        });
    }
}
