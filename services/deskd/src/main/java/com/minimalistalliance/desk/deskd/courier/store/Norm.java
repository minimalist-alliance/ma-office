package com.minimalistalliance.desk.deskd.courier.store;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Normalizing what parsers and transports hand the store. Everything here works on strings that have already come out of
 * the {@code desk-parse} sandbox or a transport's structured reply, never on raw MIME, and treats them as hostile anyway:
 * lengths are capped, control characters dropped, and nothing here can fail on any input.
 */
public final class Norm {

    private Norm() {}

    /** RFC 5321's limit for a path, and well past any address a person uses. */
    public static final int MAX_ADDRESS = 320;
    public static final int MAX_MSGID = 250;
    public static final int MAX_REFS = 100;
    public static final int MAX_SUBJECT = 998;
    public static final int MAX_NAME = 200;

    /**
     * Drops, by code point: C0 and C1 controls but tab and newline; every format character (Unicode's {@code Cf}: the bidi
     * overrides and marks a sender could hide a name behind, zero-width characters, the tag characters that can carry
     * text an agent's model reads but the member can't see); line and paragraph separators; the Hangul fillers that show
     * as nothing; and a lone surrogate (Security CS-L2). Multi-line text ({@code keepNewlines}) keeps the zero-width joiner
     * and non-joiner, which Persian, the Indic scripts and emoji need and which carry no text of their own.
     */
    public static String clean(String s, int max, boolean keepNewlines) {
        if (s == null) {
            return null;
        }
        StringBuilder out = new StringBuilder(Math.min(s.length(), max));
        for (int i = 0; i < s.length() && out.length() < max; ) {
            int cp = s.codePointAt(i);
            i += Character.charCount(cp);
            if (cp == '\n' || cp == '\t') {
                out.append(keepNewlines ? (char) cp : ' ');
            } else if (cp == '\r') {
                if (!keepNewlines) {
                    out.append(' ');
                }
            } else if (hidden(cp) && !(keepNewlines && (cp == 0x200C || cp == 0x200D))) {
                // dropped
            } else if (Character.isSupplementaryCodePoint(cp) && out.length() + 2 > max) {
                break;
            } else {
                out.appendCodePoint(cp);
            }
        }
        return out.toString();
    }

    /** Whether a string holds a code point {@link #hidden} drops: an address that does isn't one, on any path. */
    public static boolean hasHidden(String s) {
        if (s == null) {
            return false;
        }
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            if (hidden(cp)) {
                return true;
            }
            i += Character.charCount(cp);
        }
        return false;
    }

    /** A code point that shows as nothing or steers how others show: never kept in what the store shows or reads. */
    static boolean hidden(int cp) {
        if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F)) {
            return true;
        }
        int type = Character.getType(cp);
        return type == Character.FORMAT || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR
                || type == Character.SURROGATE || cp == 0x115F || cp == 0x1160 || cp == 0x3164 || cp == 0xFFA0;
    }

    /** A one-line display string: no controls, runs of space made one, trimmed. Null for nothing left. */
    public static String line(String s, int max) {
        String c = clean(s, max * 2, false);
        if (c == null) {
            return null;
        }
        String one = c.replaceAll("\\s+", " ").strip();
        if (one.length() > max) {
            one = one.substring(0, Character.isHighSurrogate(one.charAt(max - 1)) ? max - 1 : max);
        }
        return one.isEmpty() ? null : one;
    }

    /**
     * An email address as the store keys it: no angle brackets or spaces, the domain lowercased (and the local part, as
     * every provider people use treats it so), a trailing dot dropped. Null for something that isn't one address.
     */
    public static String email(String s) {
        if (s == null) {
            return null;
        }
        String a = s.strip();
        if (a.startsWith("<") && a.endsWith(">")) {
            a = a.substring(1, a.length() - 1).strip();
        }
        if (a.regionMatches(true, 0, "mailto:", 0, 7)) {
            a = a.substring(7);
        }
        if (a.isEmpty() || a.length() > MAX_ADDRESS) {
            return null;
        }
        int at = a.lastIndexOf('@');
        if (at <= 0 || at == a.length() - 1) {
            return null;
        }
        for (int i = 0; i < a.length(); ) {
            int c = a.codePointAt(i);
            i += Character.charCount(c);
            // No space of any kind, and nothing hidden: an address that shows as another one isn't one (Security CS-L2).
            if (c <= ' ' || c == '<' || c == '>' || c == ',' || c == ';' || hidden(c) || Character.isSpaceChar(c)) {
                return null;
            }
        }
        String domain = a.substring(at + 1).toLowerCase(Locale.ROOT);
        while (domain.endsWith(".")) {
            domain = domain.substring(0, domain.length() - 1);
        }
        if (domain.isEmpty() || domain.startsWith(".") || domain.contains("..")) {
            return null;
        }
        return a.substring(0, at).toLowerCase(Locale.ROOT) + "@" + domain;
    }

    /** The domain of a normalized address. */
    public static String domain(String email) {
        int at = email == null ? -1 : email.lastIndexOf('@');
        return at < 0 ? null : email.substring(at + 1);
    }

    /** {@code name+tag@d} to {@code name@d}, for matching the member's own address; null if there's no tag. */
    public static String withoutTag(String email) {
        int at = email == null ? -1 : email.lastIndexOf('@');
        if (at < 0) {
            return null;
        }
        int plus = email.indexOf('+');
        return plus > 0 && plus < at ? email.substring(0, plus) + email.substring(at) : null;
    }

    /** The tag of {@code name+tag@d}, shown as a label; null if there's none. */
    public static String tag(String email) {
        int at = email == null ? -1 : email.lastIndexOf('@');
        int plus = email == null ? -1 : email.indexOf('+');
        if (plus <= 0 || plus >= at - 1) {
            return null;
        }
        return line(email.substring(plus + 1, at), 64);
    }

    /** A phone number: digits with one leading {@code +} kept. Null for fewer than 3 digits or more than 15. */
    public static String phone(String s) {
        if (s == null) {
            return null;
        }
        String t = s.strip();
        StringBuilder digits = new StringBuilder();
        boolean plus = t.startsWith("+");
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c >= '0' && c <= '9') {
                digits.append(c);
            } else if (c == ' ' || c == '-' || c == '.' || c == '(' || c == ')' || (c == '+' && i == 0)) {
                // separators
            } else {
                return null;
            }
        }
        if (digits.length() < 3 || digits.length() > 15) {
            return null;
        }
        return (plus ? "+" : "") + digits;
    }

    /** An endpoint's value by its kind; null when it isn't one. */
    public static String endpoint(String kind, String value) {
        return switch (kind) {
            case "email", "ma" -> email(value);
            case "phone" -> phone(value);
            case "apple" -> value != null && value.contains("@") ? email(value) : phone(value);
            default -> null;
        };
    }

    private static final Pattern MSGID = Pattern.compile("<([^<>\\s]{1," + MAX_MSGID + "})>");

    /** The message ids in a header, in order: every {@code <...>}, or with no brackets at all, each word holding an {@code @}. */
    public static List<String> msgids(String header) {
        List<String> out = new ArrayList<>();
        if (header == null) {
            return out;
        }
        String h = header.length() > 64 * 1024 ? header.substring(0, 64 * 1024) : header;
        Matcher m = MSGID.matcher(h);
        while (m.find()) {
            String id = cleanId(m.group(1));
            if (id != null) {
                out.add(id);
            }
        }
        // Bare ids only from a header with no brackets at all: one with a broken <...> names nothing.
        if (out.isEmpty() && h.indexOf('<') < 0) {
            for (String word : h.split("[\\s,]+")) {
                if (word.indexOf('@') > 0 && word.length() <= MAX_MSGID) {
                    String id = cleanId(word.replace("<", "").replace(">", ""));
                    if (id != null) {
                        out.add(id);
                    }
                }
            }
        }
        return out;
    }

    /** One message id, or null. */
    public static String msgid(String header) {
        List<String> ids = msgids(header);
        return ids.isEmpty() ? null : ids.get(0);
    }

    private static String cleanId(String id) {
        if (id == null || id.isEmpty() || id.length() > MAX_MSGID) {
            return null;
        }
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if (c <= ' ' || c >= 0x7F) {
                return null;
            }
        }
        return id;
    }

    /**
     * What a message names as its parents, nearest last: References in order, then In-Reply-To's first id if it isn't
     * already there, without the message's own id and repeats. Over 100, the first (the thread's root) and the last 99.
     */
    public static List<String> parents(List<String> references, List<String> inReplyTo, String self) {
        Set<String> seen = new LinkedHashSet<>();
        if (references != null) {
            for (String r : references) {
                if (r != null && !r.equals(self)) {
                    seen.add(r);
                }
            }
        }
        if (inReplyTo != null && !inReplyTo.isEmpty() && inReplyTo.get(0) != null && !inReplyTo.get(0).equals(self)) {
            seen.remove(inReplyTo.get(0));
            seen.add(inReplyTo.get(0));
        }
        List<String> all = new ArrayList<>(seen);
        if (all.size() <= MAX_REFS) {
            return all;
        }
        List<String> kept = new ArrayList<>(MAX_REFS);
        kept.add(all.get(0));
        kept.addAll(all.subList(all.size() - (MAX_REFS - 1), all.size()));
        return kept;
    }

    // Reply and forward prefixes across the languages mail clients write them in, with an optional count: "Re[2]:".
    private static final Pattern PREFIX = Pattern.compile(
            "^\\s*(?:re|fw|fwd|aw|wg|sv|vs|antw|antwort|doorst|tr|rif|r|ref|res|enc|odp|pd|ynt|atb|ha|vá|rv|"
                    + "回复|回覆|答复|转发|轉寄|返信|転送|답장|전달)\\s*(?:\\[\\d{1,4}]|\\(\\d{1,4}\\))?\\s*[:：]\\s*",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern LIST_TAG = Pattern.compile("^\\s*\\[[^\\]]{1,40}]\\s*");

    /** Whether a subject says it's a reply or forward. */
    public static boolean isReplySubject(String subject) {
        if (subject == null) {
            return false;
        }
        String s = LIST_TAG.matcher(subject).replaceFirst("");
        return PREFIX.matcher(s).find();
    }

    /** A subject as threads compare it: every prefix and list tag gone, spaces made one, folded. Null for nothing left. */
    public static String subject(String subject) {
        if (subject == null) {
            return null;
        }
        String s = line(subject, MAX_SUBJECT);
        if (s == null) {
            return null;
        }
        for (int i = 0; i < 20; i++) {
            String before = s;
            s = LIST_TAG.matcher(s).replaceFirst("");
            s = PREFIX.matcher(s).replaceFirst("");
            if (s.equals(before)) {
                break;
            }
        }
        s = fold(s).strip();
        return s.isEmpty() ? null : s;
    }

    /** Lowercased with accents removed, as FTS5's {@code remove_diacritics 2} sees it, for matching and highlights. */
    public static String fold(String s) {
        if (s == null) {
            return null;
        }
        String d = Normalizer.normalize(s, Normalizer.Form.NFD);
        StringBuilder out = new StringBuilder(d.length());
        for (int i = 0; i < d.length(); i++) {
            char c = d.charAt(i);
            if (Character.getType(c) == Character.NON_SPACING_MARK) {
                continue;
            }
            out.append(c);
        }
        return out.toString().toLowerCase(Locale.ROOT);
    }
}
