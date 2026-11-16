package com.minimalistalliance.desk.courier.parse;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * JSON written by hand, for the answers deskd reads: objects of strings, numbers, booleans, nulls, lists and maps, in the
 * order given. Strings escape the quote, the backslash and every control, and a lone surrogate becomes U+FFFD, so the
 * output is always valid UTF-8 and valid JSON, whatever the message held.
 */
final class Wire {

    private Wire() {}

    static byte[] json(Object value) {
        StringBuilder b = new StringBuilder(4096);
        write(b, value);
        return b.toString().getBytes(StandardCharsets.UTF_8);
    }

    static void write(OutputStream out, Object value) throws IOException {
        out.write(json(value));
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder b, Object v) {
        if (v == null) {
            b.append("null");
        } else if (v instanceof String s) {
            string(b, s);
        } else if (v instanceof Boolean bool) {
            b.append(bool ? "true" : "false");
        } else if (v instanceof Long || v instanceof Integer) {
            b.append(v);
        } else if (v instanceof Map<?, ?> m) {
            b.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) {
                    b.append(',');
                }
                first = false;
                string(b, (String) e.getKey());
                b.append(':');
                write(b, e.getValue());
            }
            b.append('}');
        } else if (v instanceof List<?> l) {
            b.append('[');
            for (int i = 0; i < l.size(); i++) {
                if (i > 0) {
                    b.append(',');
                }
                write(b, l.get(i));
            }
            b.append(']');
        } else {
            throw new IllegalArgumentException("type");
        }
    }

    private static void string(StringBuilder b, String s) {
        b.append('"');
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') {
                b.append('\\').append(c);
            } else if (c < 0x20 || c == 0x7F || c == 0x2028 || c == 0x2029) {
                b.append(String.format("\\u%04x", (int) c));
            } else if (Character.isHighSurrogate(c)) {
                if (i + 1 < n && Character.isLowSurrogate(s.charAt(i + 1))) {
                    b.append(c).append(s.charAt(i + 1));
                    i++;
                } else {
                    b.append('�');
                }
            } else if (Character.isLowSurrogate(c)) {
                b.append('�');
            } else {
                b.append(c);
            }
        }
        b.append('"');
    }
}
