package com.minimalistalliance.desk.deskd.agent;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/**
 * desk-agent's {@code team.Canonical}, copied until the services share a module: an approval's bound fields as
 * canonical JSON, and its SHA-256, which {@link ApprovalTickets} recomputes from the arguments a tool call brings
 * (API.md section 18). The same bytes as desk-agent's and the Agent app's {@code canonicalJson}
 * ({@code web/agent/src/model/proposals.ts}): object keys sorted by UTF-16 code unit, no whitespace, strings escaped
 * as {@code JSON.stringify} does, whole numbers only. Anything else is refused with {@link IllegalArgumentException}.
 */
final class Canonical {

    private Canonical() {}

    static String json(Object value) {
        StringBuilder out = new StringBuilder();
        write(out, value);
        return out.toString();
    }

    static String sha256(Object value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(json(value).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void write(StringBuilder out, Object value) {
        switch (value) {
            case null -> out.append("null");
            case String s -> string(out, s);
            case Boolean b -> out.append(b);
            case Integer i -> out.append(i);
            case Long l -> out.append(l);
            case Short s -> out.append(s);
            case BigInteger b -> out.append(b);
            case List<?> list -> {
                out.append('[');
                for (int i = 0; i < list.size(); i++) {
                    if (i > 0) {
                        out.append(',');
                    }
                    write(out, list.get(i));
                }
                out.append(']');
            }
            case Map<?, ?> map -> {
                List<String> keys = new ArrayList<>();
                for (Object key : map.keySet()) {
                    keys.add((String) key);
                }
                keys.sort(null);
                out.append('{');
                boolean first = true;
                for (String key : keys) {
                    if (!first) {
                        out.append(',');
                    }
                    first = false;
                    string(out, key);
                    out.append(':');
                    write(out, map.get(key));
                }
                out.append('}');
            }
            default -> throw new IllegalArgumentException("not a canonical value");
        }
    }

    /** As {@code JSON.stringify}: the short escapes, other controls and lone surrogates as lower-case {@code \}u. */
    private static void string(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else if (Character.isHighSurrogate(c)) {
                        if (i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                            out.append(c).append(s.charAt(++i));
                        } else {
                            out.append(String.format("\\u%04x", (int) c));
                        }
                    } else if (Character.isLowSurrogate(c)) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }
}
