package com.minimalistalliance.desk.deskd.todo;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.StringJoiner;

/** Prepared statements without the noise, as Courier's store has them. Every value is bound, never spliced into the text. */
final class TodoSql {

    private TodoSql() {}

    /**
     * Prepared statements kept per connection, as the same few statements run again and again. A connection is only ever
     * used by one thread at a time (the writer's own, or the reader that took it), so its own map needs no lock.
     */
    private static final java.util.Map<Connection, java.util.Map<String, PreparedStatement>> CACHE =
            java.util.Collections.synchronizedMap(new java.util.WeakHashMap<>());

    private static PreparedStatement prepare(Connection c, String sql) throws SQLException {
        java.util.Map<String, PreparedStatement> mine = CACHE.computeIfAbsent(c, k -> new java.util.LinkedHashMap<>(64, 0.75f, true) {
            private static final long serialVersionUID = 1L;

            @Override
            protected boolean removeEldestEntry(java.util.Map.Entry<String, PreparedStatement> eldest) {
                if (size() > 160) {
                    try {
                        eldest.getValue().close();
                    } catch (SQLException e) {
                        // dropped either way
                    }
                    return true;
                }
                return false;
            }
        });
        PreparedStatement ps = mine.get(sql);
        if (ps == null || ps.isClosed()) {
            ps = c.prepareStatement(sql);
            mine.put(sql, ps);
        } else {
            ps.clearParameters();
        }
        return ps;
    }

    @FunctionalInterface
    interface Row<T> {
        T map(ResultSet r) throws SQLException;
    }

    static void bind(PreparedStatement ps, Object... args) throws SQLException {
        for (int i = 0; i < args.length; i++) {
            Object a = args[i];
            int at = i + 1;
            if (a == null) {
                ps.setNull(at, Types.NULL);
            } else if (a instanceof String s) {
                ps.setString(at, s);
            } else if (a instanceof Long l) {
                ps.setLong(at, l);
            } else if (a instanceof Integer n) {
                ps.setLong(at, n);
            } else if (a instanceof Boolean b) {
                ps.setInt(at, b ? 1 : 0);
            } else if (a instanceof byte[] bytes) {
                ps.setBytes(at, bytes);
            } else {
                throw new IllegalArgumentException("can't bind " + a.getClass().getSimpleName());
            }
        }
    }

    static int update(Connection c, String sql, Object... args) throws SQLException {
        PreparedStatement ps = prepare(c, sql);
        bind(ps, args);
        return ps.executeUpdate();
    }

    /** An insert's new rowid. */
    static long insert(Connection c, String sql, Object... args) throws SQLException {
        PreparedStatement ps = prepare(c, sql);
        bind(ps, args);
        ps.executeUpdate();
        try (ResultSet r = prepare(c, "SELECT last_insert_rowid()").executeQuery()) {
            return r.getLong(1);
        }
    }

    static <T> List<T> list(Connection c, String sql, Row<T> row, Object... args) throws SQLException {
        PreparedStatement ps = prepare(c, sql);
        bind(ps, args);
        try (ResultSet r = ps.executeQuery()) {
            List<T> out = new ArrayList<>();
            while (r.next()) {
                out.add(row.map(r));
            }
            return out;
        }
    }

    /** The first row, or null. */
    static <T> T one(Connection c, String sql, Row<T> row, Object... args) throws SQLException {
        PreparedStatement ps = prepare(c, sql);
        bind(ps, args);
        try (ResultSet r = ps.executeQuery()) {
            return r.next() ? row.map(r) : null;
        }
    }

    static Long longOne(Connection c, String sql, Object... args) throws SQLException {
        return one(c, sql, r -> {
            long v = r.getLong(1);
            return r.wasNull() ? null : v;
        }, args);
    }

    static String stringOne(Connection c, String sql, Object... args) throws SQLException {
        return one(c, sql, r -> r.getString(1), args);
    }

    static boolean exists(Connection c, String sql, Object... args) throws SQLException {
        return one(c, sql, r -> Boolean.TRUE, args) != null;
    }

    /** {@code ?, ?, ?} for n values. */
    static String marks(int n) {
        StringJoiner j = new StringJoiner(", ");
        for (int i = 0; i < n; i++) {
            j.add("?");
        }
        return j.toString();
    }

    static Object[] args(Collection<?> values, Object... before) {
        Object[] out = new Object[before.length + values.size()];
        System.arraycopy(before, 0, out, 0, before.length);
        int i = before.length;
        for (Object v : values) {
            out[i++] = v;
        }
        return out;
    }

    static Long nullableLong(ResultSet r, String column) throws SQLException {
        long v = r.getLong(column);
        return r.wasNull() ? null : v;
    }
}
