package com.minimalistalliance.desk.courier.parse;

import java.net.IDN;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A link as Courier shows it (the launch plan §3.2): the real destination, made plain. Only {@code http}, {@code https},
 * {@code mailto} and {@code tel} are links; anything else ({@code javascript:}, {@code data:}, {@code file:}, a relative
 * path) isn't one, and its words stay as text. The host is in ASCII (a lookalike shows as punycode), the user-info a URL
 * can hide its real host behind is dropped, known tracking parameters are removed, and the warnings say what the member
 * should know before opening it:
 * <ul>
 * <li>{@code mismatch}: the link's words name one domain and it goes to another;</li>
 * <li>{@code ip}: it goes to a bare IP address (in any of the forms a browser reads: dotted, one number, hex, octal);</li>
 * <li>{@code punycode}: its host is an internationalized name, which can look like another;</li>
 * <li>{@code userinfo}: it had a {@code user@} part, often a trick ({@code https://paypal.com@evil.example});</li>
 * <li>{@code tracker}: its host is on ADR 0076's lists.</li>
 * </ul>
 * Nothing here fetches anything: it reads strings.
 */
final class Links {

    private Links() {}

    static final int MAX_URL = 2048;

    enum Kind { WEB, MAILTO, TEL }

    /** A link made plain. {@code host} is the ASCII host (web) or the address's domain (mailto). */
    record Link(Kind kind, String url, String host, Set<String> warnings) {}

    /** Tracking parameters, by exact name or (ending in {@code *}) prefix, as the Browser and mail clients strip them. */
    private static final Set<String> TRACKING = Set.of(
            "utm_*", "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "mc_cid", "mc_eid", "_hsenc", "_hsmi",
            "__hssc", "__hstc", "__hsfp", "hsctatracking", "mkt_tok", "yclid", "ysclid", "igshid", "oly_anon_id", "oly_enc_id",
            "vero_id", "vero_conv", "_kx", "rb_clickid", "s_cid", "ttclid", "twclid", "li_fat_id", "epik", "sc_cid",
            "wickedid", "_openstat", "ml_subscriber", "ml_subscriber_hash", "ck_subscriber_id", "srsltid", "_ga", "_gl",
            "spm", "scm", "cmpid", "trk_contact", "trk_msg", "trk_module", "trk_sid", "elqtrackid", "elqtrack", "elq", "elqaid",
            "elqat", "elqcampaignid", "pk_campaign", "pk_kwd", "pk_source", "pk_medium", "piwik_campaign", "piwik_kwd",
            "mtm_*", "hsa_*", "matomo_*", "irclickid", "irgwc", "cjevent", "ef_id", "s_kwcid", "obclid", "fb_action_ids",
            "fb_action_types", "fb_ref", "fb_source", "action_object_map", "action_type_map", "action_ref_map");

    /**
     * The link an {@code href} names, with the words it's shown with, or null when it isn't one we keep.
     *
     * @param words the link's visible text, for the mismatch check, or null
     */
    static Link inspect(String href, String words) {
        if (href == null) {
            return null;
        }
        String s = strip(href);
        if (s.isEmpty() || s.length() > MAX_URL) {
            return null;
        }
        String lower = s.toLowerCase(Locale.ROOT);
        if (lower.startsWith("mailto:")) {
            return mailto(s.substring(7));
        }
        if (lower.startsWith("tel:")) {
            String number = s.substring(4).replaceAll("[^0-9+*#,;()\\-. ]", "");
            return number.isBlank() ? null : new Link(Kind.TEL, "tel:" + number.trim(), null, Set.of());
        }
        String rest;
        String scheme;
        if (lower.startsWith("https:")) {
            scheme = "https";
            rest = s.substring(6);
        } else if (lower.startsWith("http:")) {
            scheme = "http";
            rest = s.substring(5);
        } else if (s.startsWith("//") || s.startsWith("\\\\")) {
            scheme = "https";
            rest = s;
        } else {
            return null;
        }
        rest = rest.replace('\\', '/');
        int slashes = 0;
        while (slashes < rest.length() && rest.charAt(slashes) == '/') {
            slashes++;
        }
        rest = rest.substring(slashes);
        int end = firstOf(rest, "/?#");
        String authority = rest.substring(0, end);
        String tail = rest.substring(end);
        Set<String> warnings = new LinkedHashSet<>();
        int at = authority.lastIndexOf('@');
        if (at >= 0) {
            warnings.add("userinfo");
            authority = authority.substring(at + 1);
        }
        String host;
        String port = "";
        if (authority.startsWith("[")) {
            int close = authority.indexOf(']');
            if (close < 0) {
                return null;
            }
            host = authority.substring(0, close + 1).toLowerCase(Locale.ROOT);
            if (!host.matches("\\[[0-9a-f:.]{2,45}]")) {
                return null;
            }
            String after = authority.substring(close + 1);
            if (after.startsWith(":")) {
                port = after.substring(1);
            }
            warnings.add("ip");
        } else {
            int colon = authority.lastIndexOf(':');
            if (colon >= 0) {
                port = authority.substring(colon + 1);
                authority = authority.substring(0, colon);
            }
            host = asciiHost(authority);
            if (host == null) {
                return null;
            }
            // A host written with anything but ASCII was rewritten to reach here (IDN, full-width letters, the German sharp
            // s): the member should see that it isn't what the sender's words showed (Security CP-I3).
            if (!percentDecode(authority).chars().allMatch(c -> c < 0x80)) {
                warnings.add("punycode");
            }
            if (ipv4(host)) {
                warnings.add("ip");
            }
        }
        if (!port.isEmpty() && (!port.matches("[0-9]{1,5}") || Integer.parseInt(port) > 65535)) {
            return null;
        }
        if (port.equals("80") && scheme.equals("http") || port.equals("443") && scheme.equals("https")) {
            port = "";
        }
        for (String label : host.split("\\.")) {
            if (label.startsWith("xn--")) {
                warnings.add("punycode");
                break;
            }
        }
        String clean = scheme + "://" + host + (port.isEmpty() ? "" : ":" + port) + encode(dropTracking(tail));
        if (clean.length() > MAX_URL) {
            return null;
        }
        String shown = wordsHost(words);
        if (shown != null && !related(shown, host)) {
            warnings.add("mismatch");
        }
        if (Trackers.current().listed(host)) {
            warnings.add("tracker");
        }
        return new Link(Kind.WEB, clean, host, Set.copyOf(warnings));
    }

    /** Tabs, newlines and controls anywhere, and spaces at the ends, go, as a browser drops them. */
    static String strip(String s) {
        StringBuilder out = new StringBuilder(Math.min(s.length(), MAX_URL + 1));
        for (int i = 0; i < s.length() && out.length() <= MAX_URL; i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c == 0x7F || c >= 0x80 && c < 0xA0 || Character.getType(c) == Character.FORMAT) {
                continue;
            }
            out.append(c);
        }
        return out.toString().strip();
    }

    private static int firstOf(String s, String chars) {
        for (int i = 0; i < s.length(); i++) {
            if (chars.indexOf(s.charAt(i)) >= 0) {
                return i;
            }
        }
        return s.length();
    }

    private static final Pattern LABEL = Pattern.compile("[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?");

    /** A host in lowercase ASCII (IDN to punycode, percent-escapes decoded first), or null if it isn't one. */
    static String asciiHost(String raw) {
        String h = percentDecode(raw).strip().toLowerCase(Locale.ROOT);
        // The full-stop lookalikes a browser treats as dots.
        h = h.replace('。', '.').replace('．', '.').replace('｡', '.');
        if (h.endsWith(".")) {
            h = h.substring(0, h.length() - 1);
        }
        if (h.isEmpty() || h.length() > 253) {
            return null;
        }
        try {
            h = IDN.toASCII(h, IDN.ALLOW_UNASSIGNED).toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException e) {
            return null;
        }
        for (String label : h.split("\\.", -1)) {
            if (!LABEL.matcher(label).matches()) {
                return null;
            }
        }
        return h;
    }

    /** Whether a browser would read the host as an IPv4 address: every label a number in decimal, hex or octal. */
    static boolean ipv4(String host) {
        String[] labels = host.split("\\.");
        if (labels.length > 4) {
            return false;
        }
        for (String l : labels) {
            if (!l.matches("0[xX][0-9a-fA-F]*|[0-9]+")) {
                return false;
            }
        }
        return true;
    }

    private static Link mailto(String rest) {
        String decoded = percentDecode(rest);
        int q = decoded.indexOf('?');
        String to = (q >= 0 ? decoded.substring(0, q) : decoded).strip();
        int comma = to.indexOf(',');
        String first = comma >= 0 ? to.substring(0, comma) : to;
        int at = first.lastIndexOf('@');
        if (at <= 0 || at == first.length() - 1 || first.length() > 254) {
            return null;
        }
        String domain = asciiHost(first.substring(at + 1));
        if (domain == null) {
            return null;
        }
        String local = first.substring(0, at);
        if (!local.matches("[^\\s<>\"(),;:\\[\\]\\\\]{1,64}")) {
            return null;
        }
        Set<String> warnings = domain.contains("xn--") ? Set.of("punycode") : Set.of();
        return new Link(Kind.MAILTO, "mailto:" + encode(local) + "@" + domain, domain, warnings);
    }

    /** The domain a link's words name, if they look like an address or a URL ({@code paypal.com}, {@code www.x.org}). */
    private static final Pattern WORDS_HOST = Pattern.compile(
            "(?i)^\\s*(?:https?://)?(?:[^\\s/@]+@)?((?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?\\.)+[\\p{L}]{2,63})(?::\\d{1,5})?(?:[/?#]\\S*)?\\s*$");

    static String wordsHost(String words) {
        if (words == null || words.length() > MAX_URL) {
            return null;
        }
        Matcher m = WORDS_HOST.matcher(strip(words));
        if (!m.matches()) {
            return null;
        }
        return asciiHost(m.group(1));
    }

    /** Same site: equal, or one under the other ({@code www.}, {@code mail.}). */
    static boolean related(String a, String b) {
        String x = a.startsWith("www.") ? a.substring(4) : a;
        String y = b.startsWith("www.") ? b.substring(4) : b;
        return x.equals(y) || x.endsWith("." + y) || y.endsWith("." + x);
    }

    /** The path, query and fragment, without tracking parameters. */
    static String dropTracking(String tail) {
        int hash = tail.indexOf('#');
        String fragment = hash >= 0 ? tail.substring(hash) : "";
        String beforeHash = hash >= 0 ? tail.substring(0, hash) : tail;
        int q = beforeHash.indexOf('?');
        if (q < 0) {
            return tail;
        }
        String path = beforeHash.substring(0, q);
        StringBuilder query = new StringBuilder();
        for (String pair : beforeHash.substring(q + 1).split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String name = percentDecode(eq >= 0 ? pair.substring(0, eq) : pair).toLowerCase(Locale.ROOT);
            if (tracking(name)) {
                continue;
            }
            if (query.length() > 0) {
                query.append('&');
            }
            query.append(pair);
        }
        return path + (query.length() > 0 ? "?" + query : "") + fragment;
    }

    static boolean tracking(String name) {
        if (TRACKING.contains(name)) {
            return true;
        }
        for (String t : TRACKING) {
            if (t.endsWith("*") && name.startsWith(t.substring(0, t.length() - 1))) {
                return true;
            }
        }
        return false;
    }

    /** Percent-encodes what isn't safe to show or carry in an attribute: spaces, quotes, angle brackets, non-ASCII. */
    static String encode(String s) {
        StringBuilder out = new StringBuilder(s.length());
        byte[] bytes = s.getBytes(StandardCharsets.UTF_8);
        for (byte b : bytes) {
            int c = b & 0xFF;
            if (c > 0x20 && c < 0x7F && c != '"' && c != '\'' && c != '<' && c != '>' && c != '`' && c != '\\'
                    && c != '{' && c != '}' && c != '|' && c != '^') {
                out.append((char) c);
            } else {
                out.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16)))
                        .append(Character.toUpperCase(Character.forDigit(c & 15, 16)));
            }
        }
        return out.toString();
    }

    static String percentDecode(String s) {
        if (s.indexOf('%') < 0) {
            return s;
        }
        byte[] out = new byte[s.length() * 3];
        int n = 0;
        byte[] src = s.getBytes(StandardCharsets.UTF_8);
        for (int i = 0; i < src.length; i++) {
            if (src[i] == '%' && i + 2 < src.length && hex(src[i + 1]) >= 0 && hex(src[i + 2]) >= 0) {
                out[n++] = (byte) (hex(src[i + 1]) * 16 + hex(src[i + 2]));
                i += 2;
            } else {
                out[n++] = src[i];
            }
        }
        return new String(out, 0, n, StandardCharsets.UTF_8);
    }

    private static int hex(byte b) {
        return Character.digit((char) b, 16);
    }

    /** Web addresses in plain text ({@code https://...}, {@code www....}), for removing tracking parameters there too. */
    private static final Pattern TEXT_URL = Pattern.compile("(?i)\\bhttps?://[^\\s<>\"'\\x00-\\x1F]{1,2048}");

    /** Plain text with each web address's tracking parameters removed; nothing else changes. */
    static String cleanText(String text) {
        if (text == null || text.indexOf("://") < 0) {
            return text;
        }
        Matcher m = TEXT_URL.matcher(text);
        StringBuilder out = null;
        int last = 0;
        while (m.find()) {
            String url = m.group();
            String trail = "";
            // Punctuation that ends a sentence isn't part of the address.
            while (!url.isEmpty() && ".,;:!?)]}".indexOf(url.charAt(url.length() - 1)) >= 0) {
                trail = url.charAt(url.length() - 1) + trail;
                url = url.substring(0, url.length() - 1);
            }
            int q = url.indexOf('?');
            if (q < 0) {
                continue;
            }
            String cleaned = url.substring(0, q) + dropTracking(url.substring(q));
            if (!cleaned.equals(url)) {
                if (out == null) {
                    out = new StringBuilder(text.length());
                }
                out.append(text, last, m.start()).append(cleaned).append(trail);
                last = m.end();
            }
        }
        if (out == null) {
            return text;
        }
        out.append(text, last, text.length());
        return out.toString();
    }
}
