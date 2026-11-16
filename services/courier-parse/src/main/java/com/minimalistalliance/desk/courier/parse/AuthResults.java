package com.minimalistalliance.desk.courier.parse;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The message's own {@code Authentication-Results} fields (RFC 8601), read for deskd: for each, its authserv-id, the first
 * result of SPF, DKIM and DMARC, and the domain DMARC was checked for ({@code header.from}). In the header's order, topmost
 * first, as the fields are listed.
 *
 * <p>Anyone can write such a field into a message. This only reads them; deskd decides which to believe, by the linked
 * provider's own authserv-id and only the leading run of fields carrying it (deskd's {@code Courier.Verdicts.resolve}), and
 * keeps a DMARC pass only for the From's own domain (Security CP-L2's second half, Wave 2.1).
 */
public final class AuthResults {

    private AuthResults() {}

    static final String FIELD = "authentication-results";
    /** Fields read: a provider adds one, or a few (one per method); the rest are what came before it. */
    static final int MAX = 8;
    private static final int MAX_CHARS = 16 * 1024;
    private static final int MAX_SEGMENTS = 64;

    private static final Pattern METHOD = Pattern.compile("^\\s*([A-Za-z0-9_-]{1,32})(?:\\s*/\\s*[0-9]{1,4})?\\s*=\\s*([A-Za-z0-9_-]{1,32})");
    private static final Pattern PROPERTY = Pattern.compile(
            "([A-Za-z0-9_-]{1,32})\\s*\\.\\s*([A-Za-z0-9_.-]{1,64})\\s*=\\s*(\"(?:[^\"\\\\]|\\\\.){0,512}\"|[^\\s;\"]{1,512})");
    private static final Pattern TOKEN = Pattern.compile("[^\\s\"]{1,255}|\"(?:[^\"\\\\]|\\\\.){1,255}\"");

    /** Each field's reading, in order; a field that says nothing readable is still listed, with its authserv-id or none. */
    public static List<Map<String, Object>> read(List<String> fields) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (String f : fields) {
            if (out.size() >= MAX) {
                break;
            }
            out.add(one(f == null ? "" : f));
        }
        return out;
    }

    static Map<String, Object> one(String field) {
        String text = withoutComments(field.length() > MAX_CHARS ? field.substring(0, MAX_CHARS) : field);
        List<String> segments = split(text);
        Map<String, Object> m = new LinkedHashMap<>();
        String authServ = null;
        int first = 0;
        if (!segments.isEmpty() && !segments.get(0).contains("=")) {
            // authserv-id [version]: a value, a token or a quoted string.
            Matcher t = TOKEN.matcher(segments.get(0).strip());
            if (t.lookingAt()) {
                authServ = unquote(t.group());
            }
            first = 1;
        }
        // A field whose first part is a result has no authserv-id (one provider writes them so): it can't be told from one
        // a sender wrote, so it carries none.
        m.put("authServ", authServ == null ? null : authServ.toLowerCase(Locale.ROOT));
        for (int i = first; i < segments.size() && i < MAX_SEGMENTS; i++) {
            Matcher r = METHOD.matcher(segments.get(i));
            if (!r.lookingAt()) {
                continue;
            }
            String method = r.group(1).toLowerCase(Locale.ROOT);
            String result = r.group(2).toLowerCase(Locale.ROOT);
            if (!method.equals("spf") && !method.equals("dkim") && !method.equals("dmarc")) {
                continue;
            }
            if (m.containsKey(method)) {
                continue;
            }
            m.put(method, result);
            if (method.equals("dmarc")) {
                Matcher p = PROPERTY.matcher(segments.get(i).substring(r.end()));
                while (p.find()) {
                    if (p.group(1).equalsIgnoreCase("header") && p.group(2).equalsIgnoreCase("from")) {
                        String v = unquote(p.group(3));
                        int at = v.lastIndexOf('@');
                        m.put("dmarcFrom", (at >= 0 ? v.substring(at + 1) : v).toLowerCase(Locale.ROOT));
                        break;
                    }
                }
            }
        }
        return m;
    }

    /** RFC 5322 comments (nested, with quoted pairs) become a space; quoted strings are left as they are. */
    static String withoutComments(String s) {
        StringBuilder out = new StringBuilder(s.length());
        int depth = 0;
        boolean quoted = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (depth == 0 && quoted) {
                out.append(c);
                if (c == '\\' && i + 1 < s.length()) {
                    out.append(s.charAt(++i));
                } else if (c == '"') {
                    quoted = false;
                }
                continue;
            }
            if (c == '\\' && depth > 0) {
                i++;
                continue;
            }
            if (c == '(') {
                if (depth == 0) {
                    out.append(' ');
                }
                depth++;
                continue;
            }
            if (c == ')' && depth > 0) {
                depth--;
                continue;
            }
            if (depth > 0) {
                continue;
            }
            if (c == '"') {
                quoted = true;
            }
            out.append(c);
        }
        return out.toString();
    }

    /** Split on {@code ;} outside quoted strings. */
    private static List<String> split(String s) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean quoted = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (quoted) {
                cur.append(c);
                if (c == '\\' && i + 1 < s.length()) {
                    cur.append(s.charAt(++i));
                } else if (c == '"') {
                    quoted = false;
                }
            } else if (c == '"') {
                quoted = true;
                cur.append(c);
            } else if (c == ';') {
                out.add(cur.toString());
                cur.setLength(0);
                if (out.size() > MAX_SEGMENTS) {
                    return out;
                }
            } else {
                cur.append(c);
            }
        }
        if (!cur.toString().isBlank()) {
            out.add(cur.toString());
        }
        return out;
    }

    private static String unquote(String v) {
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
            return v.substring(1, v.length() - 1).replaceAll("\\\\(.)", "$1");
        }
        return v;
    }
}
