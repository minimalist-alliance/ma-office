package com.minimalistalliance.desk.agent.attach.worker;

import java.util.List;
import java.util.Map;

/**
 * The documents mode's answers as JSON, by hand: maps, lists, strings, numbers and booleans only. No library is loaded
 * for it, so nothing new needs warming before the security manager.
 */
final class MiniJson {

    private MiniJson() {}

    static String write(Object value) {
        StringBuilder out = new StringBuilder(4096);
        write(out, value);
        return out.toString();
    }

    private static void write(StringBuilder out, Object v) {
        if (v == null) {
            out.append("null");
        } else if (v instanceof String s) {
            string(out, s);
        } else if (v instanceof Boolean b) {
            out.append(b ? "true" : "false");
        } else if (v instanceof Integer || v instanceof Long) {
            out.append(v);
        } else if (v instanceof Number n) {
            double d = n.doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) {
                out.append('0');
            } else if (d == Math.rint(d) && Math.abs(d) < 1e15) {
                out.append((long) d);
            } else {
                out.append(Double.toString(Math.round(d * 10000.0) / 10000.0));
            }
        } else if (v instanceof Map<?, ?> m) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                string(out, String.valueOf(e.getKey()));
                out.append(':');
                write(out, e.getValue());
            }
            out.append('}');
        } else if (v instanceof List<?> l) {
            out.append('[');
            for (int i = 0; i < l.size(); i++) {
                if (i > 0) {
                    out.append(',');
                }
                write(out, l.get(i));
            }
            out.append(']');
        } else {
            throw new IllegalArgumentException("json");
        }
    }

    private static void string(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\t' -> out.append("\\t");
                case '\r' -> out.append("\\r");
                default -> {
                    if (c >= 0xD800 && c <= 0xDFFF && !validSurrogate(s, i)) {
                        out.append('\uFFFD');
                    } else if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    private static boolean validSurrogate(String s, int i) {
        char c = s.charAt(i);
        if (Character.isHighSurrogate(c)) {
            return i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1));
        }
        return i > 0 && Character.isHighSurrogate(s.charAt(i - 1));
    }
}
