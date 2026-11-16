package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A stand-in for {@code desk-parse}'s Courier mode, in tests only: deskd never parses MIME (ADR 0097; the launch plan
 * §2.1). It reads enough of RFC 5322, 2045 to 2047 and 2231 for the corpus: unfolded headers, encoded words, address lists
 * with quoted names, groups and comments, dates, multipart bodies with base64 and quoted-printable parts in their
 * charsets, and attachment names. It answers in {@code parse-courier 1}'s map, which goes through
 * {@link ParsedMessage#fromWire}, so the store sees exactly what the sandbox's wire would give it.
 */
public final class TestMime implements CourierParser {

    public static final TestMime PARSER = new TestMime();
    private static final int MAX_PARTS = 2000;
    private static final int MAX_DEPTH = 20;

    @Override
    public Result parse(byte[] raw) {
        try {
            if (raw.length > 40 * 1024 * 1024) {
                return new Refused("too_large");
            }
            Map<String, Object> wire = wire(raw);
            return new Parsed(ParsedMessage.fromWire(wire));
        } catch (TooDeep e) {
            return new Refused("too_deep");
        } catch (TooMany e) {
            return new Refused("too_many_parts");
        } catch (RuntimeException e) {
            return new Refused("malformed");
        }
    }

    static final class TooDeep extends RuntimeException {
        private static final long serialVersionUID = 1L;
    }

    static final class TooMany extends RuntimeException {
        private static final long serialVersionUID = 1L;
    }

    /** The message's head and body, split at the first empty line. */
    record Entity(Map<String, List<String>> headers, byte[] body) {
        String header(String name) {
            List<String> v = headers.get(name.toLowerCase(Locale.ROOT));
            return v == null || v.isEmpty() ? null : v.get(0);
        }
    }

    static Entity entity(byte[] raw) {
        String text = new String(raw, StandardCharsets.ISO_8859_1);
        int split = -1;
        int skip = 0;
        int crlf = text.indexOf("\r\n\r\n");
        int lf = text.indexOf("\n\n");
        if (crlf >= 0 && (lf < 0 || crlf < lf)) {
            split = crlf;
            skip = 4;
        } else if (lf >= 0) {
            split = lf;
            skip = 2;
        }
        String head = split < 0 ? text : text.substring(0, split);
        byte[] body = split < 0 ? new byte[0] : java.util.Arrays.copyOfRange(raw, split + skip, raw.length);
        Map<String, List<String>> headers = new LinkedHashMap<>();
        String current = null;
        StringBuilder value = new StringBuilder();
        for (String line : head.split("\r?\n")) {
            if (!line.isEmpty() && (line.charAt(0) == ' ' || line.charAt(0) == '\t') && current != null) {
                value.append(' ').append(line.strip());
                continue;
            }
            if (current != null) {
                headers.computeIfAbsent(current, k -> new ArrayList<>()).add(value.toString().strip());
            }
            int colon = line.indexOf(':');
            if (colon <= 0) {
                current = null;
                continue;
            }
            current = line.substring(0, colon).strip().toLowerCase(Locale.ROOT);
            value = new StringBuilder(line.substring(colon + 1));
        }
        if (current != null) {
            headers.computeIfAbsent(current, k -> new ArrayList<>()).add(value.toString().strip());
        }
        // RFC 6532: raw UTF-8 in headers, which most clients now send; anything else stays Latin-1.
        for (List<String> values : headers.values()) {
            for (int i = 0; i < values.size(); i++) {
                values.set(i, utf8OrLatin1(values.get(i)));
            }
        }
        return new Entity(headers, body);
    }

    private static String utf8OrLatin1(String latin1) {
        byte[] bytes = latin1.getBytes(StandardCharsets.ISO_8859_1);
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                    .decode(java.nio.ByteBuffer.wrap(bytes)).toString();
        } catch (java.nio.charset.CharacterCodingException e) {
            return latin1;
        }
    }

    static Map<String, Object> wire(byte[] raw) {
        Entity e = entity(raw);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("v", 1);
        List<Map<String, Object>> from = addresses(decodeWords(e.header("from")));
        m.put("from", from.isEmpty() ? null : from.get(0));
        m.put("replyTo", addresses(decodeWords(e.header("reply-to"))));
        m.put("to", addresses(decodeWords(joined(e, "to"))));
        m.put("cc", addresses(decodeWords(joined(e, "cc"))));
        m.put("bcc", addresses(decodeWords(joined(e, "bcc"))));
        m.put("subject", decodeWords(e.header("subject")));
        m.put("date", date(e.header("date")));
        m.put("messageId", e.header("message-id"));
        m.put("inReplyTo", e.header("in-reply-to"));
        m.put("references", joined(e, "references"));
        m.put("listId", decodeWords(e.header("list-id")));
        m.put("listUnsubscribe", e.header("list-unsubscribe") != null);
        // The sandbox's own reading of the Authentication-Results fields, topmost first (courier-parse's AuthResults).
        List<String> ar = e.headers().get("authentication-results");
        m.put("authResults", com.minimalistalliance.desk.courier.parse.AuthResults.read(ar == null ? List.of() : ar));
        m.put("precedence", e.header("precedence"));
        m.put("autoSubmitted", e.header("auto-submitted"));
        List<Map<String, Object>> parts = new ArrayList<>();
        StringBuilder text = new StringBuilder();
        String[] html = {null};
        walk(e, 0, parts, text, html, new int[] {0});
        m.put("text", text.toString());
        m.put("html", html[0]);
        m.put("attachments", parts);
        return m;
    }

    private static String joined(Entity e, String name) {
        List<String> v = e.headers().get(name);
        return v == null ? null : String.join(", ", v);
    }

    private static void walk(Entity e, int depth, List<Map<String, Object>> parts, StringBuilder text, String[] html, int[] count) {
        if (depth > MAX_DEPTH) {
            throw new TooDeep();
        }
        if (++count[0] > MAX_PARTS) {
            throw new TooMany();
        }
        String type = e.header("content-type");
        String mime = type == null ? "text/plain" : type.split(";", 2)[0].strip().toLowerCase(Locale.ROOT);
        if (mime.startsWith("multipart/")) {
            String boundary = param(type, "boundary");
            if (boundary == null) {
                return;
            }
            for (byte[] part : split(e.body(), boundary)) {
                walk(entity(part), depth + 1, parts, text, html, count);
            }
            return;
        }
        String disposition = e.header("content-disposition");
        String name = disposition == null ? null : param(disposition, "filename");
        if (name == null && type != null) {
            name = param(type, "name");
        }
        boolean attachment = disposition != null && disposition.toLowerCase(Locale.ROOT).startsWith("attachment");
        byte[] decoded = decode(e.body(), e.header("content-transfer-encoding"));
        if (!attachment && name == null && mime.equals("text/plain") && text.isEmpty()) {
            text.append(new String(decoded, charset(type)).replace("\r\n", "\n"));
            return;
        }
        if (!attachment && name == null && mime.equals("text/html") && html[0] == null) {
            String h = new String(decoded, charset(type));
            html[0] = h.replaceAll("(?is)<script.*?</script>", "");
            if (text.isEmpty()) {
                text.append(h.replaceAll("(?s)<[^>]*>", " ").replaceAll("[ \\t]+", " ").strip());
            }
            return;
        }
        if (mime.equals("message/rfc822")) {
            name = name == null ? "message.eml" : name;
        }
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("part", Integer.toString(count[0]));
        p.put("name", name == null ? null : decodeWords(name));
        p.put("type", mime);
        p.put("bytes", decoded.length);
        String cid = e.header("content-id");
        p.put("contentId", cid == null ? null : cid.replace("<", "").replace(">", ""));
        p.put("inline", disposition != null && disposition.toLowerCase(Locale.ROOT).startsWith("inline"));
        String lower = name == null ? "" : name.toLowerCase(Locale.ROOT);
        p.put("danger", lower.matches(".*\\.(exe|scr|bat|cmd|js|vbs|lnk|dmg|iso|html?|docm|xlsm)$") ? "program" : null);
        parts.add(p);
    }

    private static List<byte[]> split(byte[] body, String boundary) {
        String text = new String(body, StandardCharsets.ISO_8859_1);
        String delim = "--" + boundary;
        List<byte[]> out = new ArrayList<>();
        int i = text.indexOf(delim);
        while (i >= 0) {
            int start = text.indexOf('\n', i);
            if (start < 0) {
                break;
            }
            start++;
            if (text.startsWith(delim + "--", i)) {
                break;
            }
            int next = text.indexOf("\n" + delim, start);
            int end = next < 0 ? text.length() : next;
            if (end > start && text.charAt(end - 1) == '\r') {
                end--;
            }
            out.add(text.substring(start, Math.max(start, end)).getBytes(StandardCharsets.ISO_8859_1));
            i = next < 0 ? -1 : next + 1;
        }
        return out;
    }

    private static byte[] decode(byte[] body, String encoding) {
        String enc = encoding == null ? "" : encoding.strip().toLowerCase(Locale.ROOT);
        if (enc.equals("base64")) {
            String clean = new String(body, StandardCharsets.ISO_8859_1).replaceAll("[^A-Za-z0-9+/=]", "");
            try {
                return Base64.getDecoder().decode(clean);
            } catch (IllegalArgumentException e) {
                return Base64.getMimeDecoder().decode(clean.replace("=", ""));
            }
        }
        if (enc.equals("quoted-printable")) {
            return qp(new String(body, StandardCharsets.ISO_8859_1), false);
        }
        return body;
    }

    private static byte[] qp(String s, boolean underscores) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            if (c == '=') {
                if (i + 1 < n && (s.charAt(i + 1) == '\r' || s.charAt(i + 1) == '\n')) {
                    i++;
                    if (s.charAt(i) == '\r' && i + 1 < n && s.charAt(i + 1) == '\n') {
                        i++;
                    }
                    continue;
                }
                if (i + 2 < n) {
                    int hi = Character.digit(s.charAt(i + 1), 16);
                    int lo = Character.digit(s.charAt(i + 2), 16);
                    if (hi >= 0 && lo >= 0) {
                        out.write(hi * 16 + lo);
                        i += 2;
                        continue;
                    }
                }
            }
            out.write(underscores && c == '_' ? ' ' : c);
        }
        return out.toByteArray();
    }

    private static Charset charset(String type) {
        String cs = type == null ? null : param(type, "charset");
        try {
            return cs == null ? StandardCharsets.US_ASCII : Charset.forName(cs);
        } catch (RuntimeException e) {
            return StandardCharsets.ISO_8859_1;
        }
    }

    /** A header parameter, with RFC 2231's {@code name*=charset''value} and continuations. */
    static String param(String header, String name) {
        if (header == null) {
            return null;
        }
        Matcher star = Pattern.compile("(?i);\\s*" + name + "\\*(?:0\\*?)?=\\s*([^;]+)").matcher(header);
        if (star.find()) {
            StringBuilder all = new StringBuilder(star.group(1).strip().replace("\"", ""));
            for (int n = 1; n < 50; n++) {
                Matcher more = Pattern.compile("(?i);\\s*" + name + "\\*" + n + "\\*?=\\s*([^;]+)").matcher(header);
                if (!more.find()) {
                    break;
                }
                all.append(more.group(1).strip().replace("\"", ""));
            }
            String v = all.toString();
            int q = v.indexOf("''");
            if (q >= 0) {
                String cs = v.substring(0, q);
                byte[] bytes = pct(v.substring(q + 2));
                try {
                    return new String(bytes, Charset.forName(cs.isEmpty() ? "US-ASCII" : cs));
                } catch (RuntimeException e) {
                    return new String(bytes, StandardCharsets.ISO_8859_1);
                }
            }
            return v;
        }
        Matcher m = Pattern.compile("(?i);\\s*" + name + "\\s*=\\s*(\"((?:[^\"\\\\]|\\\\.)*)\"|[^;\\s]+)").matcher(header);
        if (!m.find()) {
            return null;
        }
        return m.group(2) != null ? m.group(2).replaceAll("\\\\(.)", "$1") : m.group(1);
    }

    private static byte[] pct(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            if (c == '%' && i + 2 < n) {
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi >= 0 && lo >= 0) {
                    out.write(hi * 16 + lo);
                    i += 2;
                    continue;
                }
            }
            out.write(c);
        }
        return out.toByteArray();
    }

    private static final Pattern WORD = Pattern.compile("=\\?([^?]+)\\?([bBqQ])\\?([^?]*)\\?=");

    /** RFC 2047's encoded words, with the space between two adjacent ones dropped. */
    static String decodeWords(String s) {
        if (s == null) {
            return null;
        }
        String joined = s.replaceAll("\\?=\\s+=\\?", "?==?");
        Matcher m = WORD.matcher(joined);
        StringBuilder out = new StringBuilder();
        int last = 0;
        while (m.find()) {
            out.append(joined, last, m.start());
            String cs = m.group(1).split("\\*", 2)[0];
            byte[] bytes = m.group(2).equalsIgnoreCase("b")
                    ? Base64.getMimeDecoder().decode(m.group(3))
                    : qp(m.group(3), true);
            try {
                out.append(new String(bytes, Charset.forName(cs)));
            } catch (RuntimeException e) {
                out.append(new String(bytes, StandardCharsets.ISO_8859_1));
            }
            last = m.end();
        }
        out.append(joined.substring(last));
        return out.toString();
    }

    /** An address list: {@code "Name, Q." <a@b>}, {@code a@b (Comment)}, {@code group: a@b, c@d;}. */
    static List<Map<String, Object>> addresses(String header) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (header == null) {
            return out;
        }
        List<String> items = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean quoted = false;
        int angle = 0;
        int paren = 0;
        for (int i = 0; i < header.length(); i++) {
            char c = header.charAt(i);
            if (c == '\\' && quoted && i + 1 < header.length()) {
                cur.append(header.charAt(++i));
                continue;
            }
            if (c == '"') {
                quoted = !quoted;
            } else if (!quoted && c == '<') {
                angle++;
            } else if (!quoted && c == '>') {
                angle = Math.max(0, angle - 1);
            } else if (!quoted && c == '(') {
                paren++;
            } else if (!quoted && c == ')') {
                paren = Math.max(0, paren - 1);
            } else if (!quoted && angle == 0 && paren == 0 && (c == ',' || c == ';')) {
                items.add(cur.toString());
                cur = new StringBuilder();
                continue;
            } else if (!quoted && angle == 0 && paren == 0 && c == ':') {
                cur = new StringBuilder();
                continue;
            }
            cur.append(c);
        }
        items.add(cur.toString());
        for (String item : items) {
            String it = item.strip();
            if (it.isEmpty()) {
                continue;
            }
            String name = null;
            String address;
            int lt = it.lastIndexOf('<');
            int gt = it.lastIndexOf('>');
            if (lt >= 0 && gt > lt) {
                address = it.substring(lt + 1, gt).strip();
                name = it.substring(0, lt).strip().replace("\"", "");
            } else {
                String a = it.replaceAll("\\([^)]*\\)", " ").strip();
                Matcher comment = Pattern.compile("\\(([^)]*)\\)").matcher(it);
                if (comment.find()) {
                    name = comment.group(1).strip();
                }
                address = a.replace("\"", "");
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", name == null || name.isEmpty() ? null : name);
            m.put("address", address);
            out.add(m);
        }
        return out;
    }

    private static final DateTimeFormatter[] DATES = {
        DateTimeFormatter.RFC_1123_DATE_TIME,
        DateTimeFormatter.ofPattern("d MMM yyyy HH:mm:ss Z", Locale.ROOT),
        DateTimeFormatter.ofPattern("EEE, d MMM yyyy HH:mm Z", Locale.ROOT),
    };

    static Long date(String header) {
        if (header == null) {
            return null;
        }
        String d = header.replaceAll("\\([^)]*\\)", "").replaceAll("\\s+", " ").strip();
        d = d.replace(" GMT", " +0000").replace(" UT", " +0000").replace(" EST", " -0500").replace(" PST", " -0800");
        for (DateTimeFormatter f : DATES) {
            try {
                return ZonedDateTime.parse(d, f).toInstant().toEpochMilli();
            } catch (DateTimeParseException e) {
                // the next
            }
        }
        return null;
    }
}
