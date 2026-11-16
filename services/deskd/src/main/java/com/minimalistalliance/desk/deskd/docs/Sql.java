package com.minimalistalliance.desk.deskd.docs;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;

/** Prepared statements without the noise, as To-do's store has them. Every value is bound, never spliced into the text. */
final class Sql {

    private Sql() {}

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
            } else if (a instanceof Double d) {
                ps.setDouble(at, d);
            } else {
                throw new IllegalArgumentException("can't bind " + a.getClass().getSimpleName());
            }
        }
    }

    static int update(Connection c, String sql, Object... args) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            bind(ps, args);
            return ps.executeUpdate();
        }
    }

    static <T> List<T> list(Connection c, String sql, Row<T> row, Object... args) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            bind(ps, args);
            try (ResultSet r = ps.executeQuery()) {
                List<T> out = new ArrayList<>();
                while (r.next()) {
                    out.add(row.map(r));
                }
                return out;
            }
        }
    }

    static <T> T one(Connection c, String sql, Row<T> row, Object... args) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            bind(ps, args);
            try (ResultSet r = ps.executeQuery()) {
                return r.next() ? row.map(r) : null;
            }
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

    static Long nullableLong(ResultSet r, String column) throws SQLException {
        long v = r.getLong(column);
        return r.wasNull() ? null : v;
    }

    static Integer nullableInt(ResultSet r, String column) throws SQLException {
        int v = r.getInt(column);
        return r.wasNull() ? null : v;
    }
}
