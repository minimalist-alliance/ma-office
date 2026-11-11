package com.minimalistalliance.desk.agent.limits;

import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.time.Clock;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.TemporalAdjusters;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The usage ledger behind the limits (design 9.9, ADR 0020), in its own SQLite file.
 *
 * <p>Before a call, {@link #reserve} adds up what each scope has spent, refuses if the call's worst case would pass
 * any limit, and otherwise writes a {@code reserved} row, all in one transaction: two runs reserving at once can't
 * both fit into the same remainder. After the call, {@link #settle} replaces the reservation with what the provider
 * reported. A call that failed before generating is {@link #release}d to nothing, and one that may have been billed
 * is {@link #keep}t at its reservation. So a limit is passed by at most what one call's actual use exceeds its
 * estimate.
 *
 * <p>Reservations left by a crash are kept as spent when the ledger opens, since the provider may have billed them.
 *
 * <p>Days, weeks (from Monday) and months begin at midnight in the member's zone (ADR 0043), read for each call. No
 * period is stored: rows keep {@code at_ms}, so a changed zone just windows the same rows differently.
 *
 * <p>A finished row goes once it's older than {@link #KEEP}, at open and then once a day while open, so the file stops
 * growing at about 200 bytes a call (review finding 22). A reservation still out is never pruned.
 */
public final class UsageLedger implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(UsageLedger.class);

    /**
     * How long a finished row is kept: past the longest period any limit reads, a month, with room to spare for a
     * changed zone. A run's own limits read all of its rows, and no run lasts this long.
     */
    public static final Duration KEEP = Duration.ofDays(100);

    /** How often an open ledger prunes, after the prune at open. */
    static final Duration PRUNE_EVERY = Duration.ofDays(1);

    /** One model call, for the ledger: who, in which run, on which key, to which model. */
    public record Call(String agentId, String runId, String keyId, ProviderId provider, String model) {}

    /** A call's worst case: tokens always, and µ$, null only with a price table that has no models. */
    public record Estimate(long tokens, Long microUsd) {}

    public record Reservation(long id, Call call, Estimate estimate) {}

    /** What a scope has used so far in its period. A row with no dollars (from before ADR 0043) adds tokens only. */
    public record Spent(long tokens, long microUsd) {}

    private static final List<SqliteDatabase.Step> SCHEMA = List.of(connection -> {
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE usage (
                      id INTEGER PRIMARY KEY,
                      at_ms INTEGER NOT NULL,
                      agent_id TEXT NOT NULL,
                      run_id TEXT NOT NULL,
                      key_id TEXT NOT NULL,
                      provider TEXT NOT NULL,
                      model TEXT NOT NULL,
                      state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'kept')),
                      tokens INTEGER NOT NULL,
                      microusd INTEGER,
                      input_tokens INTEGER,
                      cached_input_tokens INTEGER,
                      cache_write_tokens INTEGER,
                      output_tokens INTEGER,
                      reasoning_tokens INTEGER,
                      settled_at_ms INTEGER
                    ) STRICT""");
            statement.execute("CREATE INDEX usage_at ON usage (at_ms)");
            statement.execute("CREATE INDEX usage_run ON usage (run_id)");
        }
    });

    private final Path file;
    private final Clock clock;
    private final Supplier<ZoneId> zone;
    private final Duration pruneEvery;
    private volatile SqliteDatabase database;
    private volatile int orphansAtOpen;
    private volatile Thread pruner;

    public UsageLedger(Path file, Clock clock, ZoneId zone) {
        this(file, clock, () -> zone);
    }

    /** @param zone the zone periods run in now. Must not block: it's read for every reservation */
    public UsageLedger(Path file, Clock clock, Supplier<ZoneId> zone) {
        this(file, clock, zone, PRUNE_EVERY);
    }

    /** @param pruneEvery how often an open ledger prunes: {@link #PRUNE_EVERY}, but for tests */
    UsageLedger(Path file, Clock clock, Supplier<ZoneId> zone, Duration pruneEvery) {
        this.file = file;
        this.clock = clock;
        this.zone = zone;
        this.pruneEvery = pruneEvery;
    }

    /**
     * Opens the file, creating or migrating it, keeps any reservation a crash left as spent, and prunes. It then prunes
     * every {@link #PRUNE_EVERY} until it's closed.
     */
    public void open() throws SQLException {
        SqliteDatabase opened = SqliteDatabase.open("usage", file, SCHEMA);
        int pruned;
        try {
            orphansAtOpen = opened.transaction(connection -> {
                try (Statement statement = connection.createStatement()) {
                    return statement.executeUpdate(
                            "UPDATE usage SET state = 'kept', settled_at_ms = at_ms WHERE state = 'reserved'");
                }
            });
            pruned = opened.transaction(this::prune);
        } catch (SQLException | RuntimeException e) {
            opened.close();
            throw e;
        }
        database = opened;
        logPruned(pruned);
        pruner = Thread.ofVirtual().name("usage-prune").start(() -> pruneWhileOpen(opened));
    }

    /** Deletes finished rows past {@link #KEEP}. A reservation still out stays, however old. */
    private int prune(Connection connection) throws SQLException {
        try (PreparedStatement delete = connection.prepareStatement(
                "DELETE FROM usage WHERE at_ms < ? AND state <> 'reserved'")) {
            delete.setLong(1, clock.millis() - KEEP.toMillis());
            return delete.executeUpdate();
        }
    }

    /** Asleep in between, so an idle ledger costs nothing. A prune that fails is tried again next time. */
    private void pruneWhileOpen(SqliteDatabase opened) {
        while (true) {
            try {
                Thread.sleep(pruneEvery);
            } catch (InterruptedException e) {
                return;
            }
            if (database != opened) {
                return;
            }
            try {
                logPruned(opened.transaction(this::prune));
            } catch (SQLException | RuntimeException e) {
                // One that lost a race with close says nothing.
                if (database == opened) {
                    log.warn("usage ledger: pruning failed ({}), trying again in {}", e.getClass().getSimpleName(),
                            pruneEvery);
                }
            }
        }
    }

    private static void logPruned(int pruned) {
        if (pruned > 0) {
            log.info("usage ledger dropped {} finished rows older than {} days", pruned, KEEP.toDays());
        }
    }

    /** For tests: every row, finished or not. */
    long rowsForTest() throws SQLException {
        return open(database).call(connection -> {
            try (Statement statement = connection.createStatement();
                    ResultSet result = statement.executeQuery("SELECT COUNT(*) FROM usage")) {
                result.next();
                return result.getLong(1);
            }
        });
    }

    public boolean isOpen() {
        return database != null;
    }

    /** Reservations a crash left behind, found by the last {@link #open}. */
    public int orphansAtOpen() {
        return orphansAtOpen;
    }

    /**
     * Checks every scope and writes the reservation, in one transaction.
     *
     * @throws LimitReachedException naming the first scope that refuses; nothing is written
     */
    public Reservation reserve(Call call, Estimate estimate, LimitPolicy policy)
            throws SQLException, LimitReachedException {
        long now = clock.millis();
        ZoneId in = zone.get();
        Instant day = startOfDay(now, in);
        Instant week = startOfWeek(now, in);
        Instant month = startOfMonth(now, in);
        LimitReachedException[] refused = new LimitReachedException[1];
        Reservation reservation = open(database).transaction(connection -> {
            long steps = count(connection, "SELECT COUNT(*) FROM usage WHERE run_id = ?", call.runId());
            if (steps >= policy.runMaxSteps()) {
                refused[0] = new LimitReachedException(Scope.RUN_STEPS, "steps", policy.runMaxSteps(), steps, 1);
                return null;
            }
            String byAgent = "SELECT COALESCE(SUM(tokens), 0), COALESCE(SUM(microusd), 0) FROM usage"
                    + " WHERE at_ms >= ? AND agent_id = ?";
            String byDesk = "SELECT COALESCE(SUM(tokens), 0), COALESCE(SUM(microusd), 0) FROM usage WHERE at_ms >= ?";
            String byKey = byDesk + " AND key_id = ?";
            String byRun = "SELECT COALESCE(SUM(tokens), 0), COALESCE(SUM(microusd), 0) FROM usage"
                    + " WHERE at_ms >= ? AND run_id = ?";
            Object[][] checks = {
                {Scope.AGENT_DAY, policy.agentDay(), byAgent, day.toEpochMilli(), call.agentId()},
                {Scope.AGENT_WEEK, policy.agentWeek(), byAgent, week.toEpochMilli(), call.agentId()},
                {Scope.AGENT_MONTH, policy.agentMonth(), byAgent, month.toEpochMilli(), call.agentId()},
                {Scope.DESK_DAY, policy.deskDay(), byDesk, day.toEpochMilli(), null},
                {Scope.DESK_MONTH, policy.deskMonth(), byDesk, month.toEpochMilli(), null},
                {Scope.KEY_MONTH, policy.keyMonth(), byKey, month.toEpochMilli(), call.keyId()},
                {Scope.RUN, policy.run(), byRun, 0L, call.runId()},
            };
            for (Object[] check : checks) {
                Limit limit = (Limit) check[1];
                if (limit.isNone()) {
                    continue;
                }
                Spent spent = spent(connection, (String) check[2], (Long) check[3], (String) check[4]);
                LimitReachedException over = over((Scope) check[0], limit, spent, estimate);
                if (over != null) {
                    refused[0] = over;
                    return null;
                }
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO usage (at_ms, agent_id, run_id, key_id, provider, model, state, tokens, microusd)"
                            + " VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)",
                    Statement.RETURN_GENERATED_KEYS)) {
                insert.setLong(1, now);
                insert.setString(2, call.agentId());
                insert.setString(3, call.runId());
                insert.setString(4, call.keyId());
                insert.setString(5, call.provider().id());
                insert.setString(6, call.model());
                insert.setLong(7, estimate.tokens());
                setNullableLong(insert, 8, estimate.microUsd());
                insert.executeUpdate();
                try (ResultSet keys = insert.getGeneratedKeys()) {
                    keys.next();
                    return new Reservation(keys.getLong(1), call, estimate);
                }
            }
        });
        if (refused[0] != null) {
            throw refused[0];
        }
        return reservation;
    }

    private static LimitReachedException over(Scope scope, Limit limit, Spent spent, Estimate estimate) {
        if (limit.maxTokens() != null && spent.tokens() + estimate.tokens() > limit.maxTokens()) {
            return new LimitReachedException(scope, "tokens", limit.maxTokens(), spent.tokens(), estimate.tokens());
        }
        if (limit.maxMicroUsd() != null
                && estimate.microUsd() != null
                && spent.microUsd() + estimate.microUsd() > limit.maxMicroUsd()) {
            return new LimitReachedException(scope, "usd", limit.maxMicroUsd(), spent.microUsd(), estimate.microUsd());
        }
        return null;
    }

    /** Replaces the reservation with what the provider reported. */
    public void settle(Reservation reservation, Usage usage, Long microUsd) throws SQLException {
        long now = clock.millis();
        open(database).transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE usage SET state = 'settled', tokens = ?, microusd = ?, input_tokens = ?,"
                            + " cached_input_tokens = ?, cache_write_tokens = ?, output_tokens = ?,"
                            + " reasoning_tokens = ?, settled_at_ms = ? WHERE id = ? AND state = 'reserved'")) {
                update.setLong(1, usage.totalTokens());
                setNullableLong(update, 2, microUsd);
                update.setLong(3, usage.inputTokens());
                update.setLong(4, usage.cachedInputTokens());
                update.setLong(5, usage.cacheWriteTokens());
                update.setLong(6, usage.outputTokens());
                update.setLong(7, usage.reasoningTokens());
                update.setLong(8, now);
                update.setLong(9, reservation.id());
                requireOne(update.executeUpdate());
            }
            return null;
        });
    }

    /** The call failed before anything was generated: it costs nothing, though it still counts as a step. */
    public void release(Reservation reservation) throws SQLException {
        finish(reservation, "UPDATE usage SET state = 'released', tokens = 0, microusd = 0, settled_at_ms = ?"
                + " WHERE id = ? AND state = 'reserved'");
    }

    /** The call failed after the provider may have billed it: its reservation counts as spent. */
    public void keep(Reservation reservation) throws SQLException {
        finish(reservation, "UPDATE usage SET state = 'kept', settled_at_ms = ? WHERE id = ? AND state = 'reserved'");
    }

    private void finish(Reservation reservation, String sql) throws SQLException {
        long now = clock.millis();
        open(database).transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement(sql)) {
                update.setLong(1, now);
                update.setLong(2, reservation.id());
                requireOne(update.executeUpdate());
            }
            return null;
        });
    }

    /** One scope's use in its current period, and when that period ends (null for a run, which has none). */
    public record ScopeUsage(Scope scope, Spent spent, Instant resetsAt) {}

    /**
     * What each period scope has used so far, for {@code agent.limits.get}: the agent's day, week and month, the
     * desk's day and month, and the month of the key, when there is one.
     */
    public List<ScopeUsage> usage(String agentId, String keyId) throws SQLException {
        long now = clock.millis();
        ZoneId in = zone.get();
        Instant day = startOfDay(now, in);
        Instant week = startOfWeek(now, in);
        Instant month = startOfMonth(now, in);
        LocalDate today = localDate(now, in);
        Instant nextDay = today.plusDays(1).atStartOfDay(in).toInstant();
        Instant nextWeek = today.with(TemporalAdjusters.next(DayOfWeek.MONDAY)).atStartOfDay(in).toInstant();
        Instant nextMonth = today.withDayOfMonth(1).plusMonths(1).atStartOfDay(in).toInstant();
        String byAgent = "SELECT COALESCE(SUM(tokens), 0), COALESCE(SUM(microusd), 0) FROM usage"
                + " WHERE at_ms >= ? AND agent_id = ?";
        String byDesk = "SELECT COALESCE(SUM(tokens), 0), COALESCE(SUM(microusd), 0) FROM usage WHERE at_ms >= ?";
        return open(database).call(connection -> {
            List<ScopeUsage> scopes = new java.util.ArrayList<>();
            scopes.add(new ScopeUsage(Scope.AGENT_DAY, spent(connection, byAgent, day.toEpochMilli(), agentId),
                    nextDay));
            scopes.add(new ScopeUsage(Scope.AGENT_WEEK, spent(connection, byAgent, week.toEpochMilli(), agentId),
                    nextWeek));
            scopes.add(new ScopeUsage(Scope.AGENT_MONTH, spent(connection, byAgent, month.toEpochMilli(), agentId),
                    nextMonth));
            scopes.add(new ScopeUsage(Scope.DESK_DAY, spent(connection, byDesk, day.toEpochMilli(), null), nextDay));
            scopes.add(new ScopeUsage(Scope.DESK_MONTH, spent(connection, byDesk, month.toEpochMilli(), null),
                    nextMonth));
            if (keyId != null) {
                scopes.add(new ScopeUsage(Scope.KEY_MONTH,
                        spent(connection, byDesk + " AND key_id = ?", month.toEpochMilli(), keyId), nextMonth));
            }
            return scopes;
        });
    }

    /**
     * Who a removed guild member's spend is kept under (ADR 0080's addendum of 2026-11-10): no agent can have this id,
     * as an agent's has no colon, so it adds to the desk's and the key's totals and to no agent's.
     */
    public static final String DEPARTED = "guild:departed";

    /**
     * A removed guild member's rows, kept as the guild's spend and no longer theirs: the agent and run ids become
     * {@link #DEPARTED} and the token breakdown goes, while the time, key, model, tokens and dollars stay, so the guild's
     * month and its key's month still count what was spent. They go at {@link #KEEP} as every row. Then the WAL is
     * emptied. Doing it again finds nothing.
     *
     * @return the rows changed
     * @throws IllegalStateException if a reservation of the agent is still out: a run is going
     */
    public int forget(String agentId) throws SQLException {
        int changed = open(database).transaction(connection -> {
            if (count(connection, "SELECT COUNT(*) FROM usage WHERE agent_id = ? AND state = 'reserved'", agentId) > 0) {
                throw new IllegalStateException("a reservation is still out");
            }
            try (PreparedStatement update = connection.prepareStatement("UPDATE usage SET agent_id = ?, run_id = ?,"
                    + " input_tokens = NULL, cached_input_tokens = NULL, cache_write_tokens = NULL,"
                    + " output_tokens = NULL, reasoning_tokens = NULL WHERE agent_id = ?")) {
                update.setString(1, DEPARTED);
                update.setString(2, DEPARTED);
                update.setString(3, agentId);
                return update.executeUpdate();
            }
        });
        if (!open(database).checkpoint()) {
            throw new SQLException("the WAL couldn't be emptied");
        }
        return changed;
    }

    /** One agent's runs and spend in a period: a run is the calls of one run id, not counting released ones. */
    public record AgentPeriod(String agentId, long runs, long microUsd) {}

    /**
     * Every agent's runs and spend today and this month, in the desk's zone, for a guild's {@code guild.usage.get}.
     *
     * @return {@code [today, month]}, each by agent id
     */
    public List<Map<String, AgentPeriod>> byAgent() throws SQLException {
        long now = clock.millis();
        ZoneId in = zone.get();
        long day = startOfDay(now, in).toEpochMilli();
        long month = startOfMonth(now, in).toEpochMilli();
        String sql = "SELECT agent_id, COUNT(DISTINCT CASE WHEN state <> 'released' THEN run_id END),"
                + " COALESCE(SUM(microusd), 0) FROM usage WHERE at_ms >= ? GROUP BY agent_id";
        return open(database).call(connection -> List.of(periods(connection, sql, day), periods(connection, sql, month)));
    }

    private static Map<String, AgentPeriod> periods(Connection connection, String sql, long since) throws SQLException {
        Map<String, AgentPeriod> periods = new java.util.LinkedHashMap<>();
        try (PreparedStatement select = connection.prepareStatement(sql)) {
            select.setLong(1, since);
            try (ResultSet result = select.executeQuery()) {
                while (result.next()) {
                    periods.put(result.getString(1), new AgentPeriod(result.getString(1), result.getLong(2), result.getLong(3)));
                }
            }
        }
        return periods;
    }

    /** An agent's runs today, in the desk's zone, for a guild member's runs a day. */
    public long runsToday(String agentId) throws SQLException {
        long day = startOfDay(clock.millis(), zone.get()).toEpochMilli();
        return open(database).call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT COUNT(DISTINCT run_id) FROM usage"
                    + " WHERE at_ms >= ? AND agent_id = ? AND state <> 'released'")) {
                select.setLong(1, day);
                select.setString(2, agentId);
                try (ResultSet result = select.executeQuery()) {
                    result.next();
                    return result.getLong(1);
                }
            }
        });
    }

    /** What an agent has used today, for the Agent tile's "today's spend vs limit" (design 3.4). */
    public Spent agentToday(String agentId) throws SQLException {
        long day = startOfDay(clock.millis(), zone.get()).toEpochMilli();
        return open(database).call(connection -> spent(connection,
                "SELECT COALESCE(SUM(tokens), 0), COALESCE(SUM(microusd), 0) FROM usage"
                        + " WHERE at_ms >= ? AND agent_id = ?",
                day, agentId));
    }

    private static Spent spent(Connection connection, String sql, long since, String id) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement(sql)) {
            select.setLong(1, since);
            if (id != null) {
                select.setString(2, id);
            }
            try (ResultSet result = select.executeQuery()) {
                result.next();
                return new Spent(result.getLong(1), result.getLong(2));
            }
        }
    }

    private static long count(Connection connection, String sql, String id) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement(sql)) {
            select.setString(1, id);
            try (ResultSet result = select.executeQuery()) {
                result.next();
                return result.getLong(1);
            }
        }
    }

    private static void setNullableLong(PreparedStatement statement, int index, Long value) throws SQLException {
        if (value == null) {
            statement.setNull(index, Types.INTEGER);
        } else {
            statement.setLong(index, value);
        }
    }

    private static void requireOne(int updated) throws SQLException {
        if (updated != 1) {
            throw new SQLException("that reservation is already settled");
        }
    }

    private static Instant startOfDay(long millis, ZoneId zone) {
        return localDate(millis, zone).atStartOfDay(zone).toInstant();
    }

    private static Instant startOfWeek(long millis, ZoneId zone) {
        LocalDate monday = localDate(millis, zone).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
        return monday.atStartOfDay(zone).toInstant();
    }

    private static Instant startOfMonth(long millis, ZoneId zone) {
        return localDate(millis, zone).withDayOfMonth(1).atStartOfDay(zone).toInstant();
    }

    private static LocalDate localDate(long millis, ZoneId zone) {
        return Instant.ofEpochMilli(millis).atZone(zone).toLocalDate();
    }

    private static SqliteDatabase open(SqliteDatabase database) throws SQLException {
        if (database == null) {
            throw new SQLException("the usage ledger isn't open");
        }
        return database;
    }

    @Override
    public void close() {
        SqliteDatabase closing = database;
        database = null;
        Thread pruning = pruner;
        pruner = null;
        if (pruning != null) {
            pruning.interrupt();
        }
        if (closing != null) {
            closing.close();
        }
    }
}
