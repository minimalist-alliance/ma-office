package com.minimalistalliance.desk.deskd.courier.store;

import java.net.IDN;
import java.sql.Connection;
import java.sql.SQLException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The sender warnings (the launch plan §3.5; draft ADR "Courier's store" §17), made once, as a stranger's message arrives,
 * and kept with it ({@code messages.warn}). Who sent a message always comes from its endpoint and its authentication,
 * never from a display name; these say when something about the sender is built to look like someone else:
 * <ul>
 * <li>{@code not_usual_address}: the display name is a known contact's name, but the address isn't one of theirs ("This
 *     isn't Dana's usual address").</li>
 * <li>{@code lookalike}: the address's domain is drawn to look like a domain the member knows (a contact's, their own) or
 *     one that's often imitated ({@code paypa1.com}, {@code rnicrosoft.com}, {@code paypal.com.secure.example}), by the
 *     confusable letters of Unicode's UTS #39 that matter in practice, one letter changed in a well-known name, or a
 *     well-known domain put in front of another.</li>
 * <li>{@code punycode}: the domain is internationalized and mixes scripts, or is spelled entirely in letters that pass for
 *     Latin ones: the office shows its ASCII form ({@code xn--...}) instead.</li>
 * <li>{@code name_held_address}: the display name held an address, which is dropped (an address in a name passes for the
 *     real one); the office shows the real address.</li>
 * </ul>
 * Each check is a lookup or a short scan: the contacts' names and domains are matched through their keys
 * ({@code contacts.name_key}, {@code endpoints.skel}), which this class makes, so a message costs a few indexed reads.
 */
public final class Senders {

    private Senders() {}

    public static final String NOT_USUAL_ADDRESS = "not_usual_address";
    public static final String LOOKALIKE = "lookalike";
    public static final String PUNYCODE = "punycode";
    public static final String NAME_HELD_ADDRESS = "name_held_address";

    /**
     * Domains people are often sent imitations of: the big providers, banks, shops, carriers and sign-in pages, and MA's
     * own. Only their registrable names matter ({@link #registrable}); a brand's own subdomains are the brand.
     */
    static final List<String> WELL_KNOWN = List.of(
            "minimalistalliance.com",
            "paypal.com", "apple.com", "icloud.com", "me.com", "google.com", "gmail.com", "youtube.com", "microsoft.com",
            "outlook.com", "live.com", "hotmail.com", "office.com", "office365.com", "microsoftonline.com", "amazon.com",
            "netflix.com", "facebook.com", "instagram.com", "whatsapp.com", "linkedin.com", "twitter.com", "dropbox.com",
            "docusign.com", "docusign.net", "adobe.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com",
            "americanexpress.com", "capitalone.com", "usbank.com", "usps.com", "ups.com", "fedex.com", "dhl.com", "irs.gov",
            "coinbase.com", "binance.com", "kraken.com", "stripe.com", "intuit.com", "yahoo.com", "aol.com", "zoom.us",
            "spotify.com", "ebay.com", "walmart.com", "target.com", "bestbuy.com", "costco.com", "steampowered.com",
            "steamcommunity.com", "discord.com", "github.com", "proton.me", "protonmail.com", "fastmail.com", "venmo.com",
            "cash.app", "zelle.com", "squareup.com", "shopify.com", "booking.com", "airbnb.com", "uber.com", "lyft.com");

    /** The well-known domains by skeleton, made on first use (after every table it's made with). */
    private static final class Known {
        static final Map<String, String> SKELETONS = new HashMap<>();
        /** Each well-known registrable domain, its first label and that label's skeleton. */
        static final List<String[]> LABELS = new ArrayList<>();

        static {
            for (String d : WELL_KNOWN) {
                String reg = registrable(d);
                SKELETONS.put(skeleton(reg), reg);
                String label = reg.substring(0, reg.indexOf('.'));
                LABELS.add(new String[] {reg, label, skeleton(label)});
            }
        }
    }

    /** Words that are a mailbox's role, not a person: a contact named one of them never makes a not-usual warning. */
    private static final Set<String> ROLE_NAMES = Set.of("support", "info", "team", "admin", "service", "noreply", "no reply",
            "notifications", "notification", "help", "sales", "billing", "newsletter", "news", "hello", "contact", "mailer daemon",
            "postmaster", "customer service", "accounts", "security", "alerts", "updates", "office", "reception");

    /**
     * Letters that pass for Latin ones, mapped to them: the confusables of UTS #39 that occur in real lookalike domains
     * (Cyrillic, Greek, Armenian and Latin look-alikes, the dotless i, Roman numerals and the like). Full-width and other
     * compatibility forms are folded first by NFKC, and accents are dropped.
     */
    private static final Map<Integer, String> CONFUSABLE = new HashMap<>();

    static {
        String[][] pairs = {
            // Cyrillic
            {"\u0430", "a"}, {"\u0432", "b"}, {"\u0435", "e"}, {"\u0451", "e"}, {"\u043e", "o"}, {"\u0440", "p"}, {"\u0441", "c"}, {"\u0443", "y"}, {"\u0445", "x"},
            {"\u0456", "i"}, {"\u0457", "i"}, {"\u0458", "j"}, {"\u0455", "s"}, {"\u04bb", "h"}, {"\u0501", "d"}, {"\u051b", "q"}, {"\u051d", "w"}, {"\u043a", "k"},
            {"\u043c", "m"}, {"\u043d", "h"}, {"\u0442", "t"}, {"\u04cf", "l"}, {"\u0261", "g"}, {"\u04af", "y"}, {"\u0269", "l"}, {"\u044c", "b"}, {"\u043f", "n"},
            {"\u0433", "r"}, {"\u0578", "n"}, {"\u057d", "u"}, {"\u0585", "o"}, {"\u0566", "q"}, {"\u0581", "g"}, {"\u0570", "h"},
            // Greek
            {"\u03b1", "a"}, {"\u03b2", "b"}, {"\u03b5", "e"}, {"\u03b7", "n"}, {"\u03b9", "i"}, {"\u03ba", "k"}, {"\u03bd", "v"}, {"\u03bf", "o"}, {"\u03c1", "p"},
            {"\u03c4", "t"}, {"\u03c5", "u"}, {"\u03c7", "x"}, {"\u03c9", "w"}, {"\u03f2", "c"}, {"\u03f3", "j"}, {"\u03b3", "y"},
            // Latin look-alikes and symbols
            {"\u0131", "i"}, {"\u0251", "a"}, {"\u0252", "a"}, {"\u029f", "l"}, {"\u026a", "i"}, {"\u0274", "n"}, {"\u0280", "r"}, {"\uabaa", "s"}, {"\uab75", "v"},
            {"\u2170", "i"}, {"\u217c", "l"}, {"\u217d", "c"}, {"\u217e", "d"}, {"\u217f", "m"}, {"\u2113", "l"}, {"\u0185", "b"}, {"\u0257", "d"}, {"\u0199", "k"},
            {"\u0140", "l"}, {"\u0142", "l"}, {"\u0111", "d"}, {"\u0127", "h"}, {"\u00f8", "o"}, {"\u00df", "ss"}, {"\u00e6", "ae"}, {"\u0153", "oe"},
        };
        for (String[] p : pairs) {
            CONFUSABLE.put(p[0].codePointAt(0), p[1]);
        }
    }

    // ---- keys

    /**
     * A contact's name as the not-usual check compares it: folded (case, accents, compatibility forms), punctuation gone,
     * its words sorted, so "Smith, Dana" and "dana smith" are one. Null for a name too short or a mailbox's role.
     */
    public static String nameKey(String name) {
        if (name == null) {
            return null;
        }
        String folded = Norm.fold(Normalizer.normalize(name, Normalizer.Form.NFKC));
        if (folded == null) {
            return null;
        }
        StringBuilder letters = new StringBuilder(folded.length());
        for (int i = 0; i < folded.length(); ) {
            int cp = folded.codePointAt(i);
            i += Character.charCount(cp);
            letters.appendCodePoint(Character.isLetterOrDigit(cp) ? cp : ' ');
        }
        String[] words = letters.toString().strip().split("\\s+");
        if (words.length == 0 || words[0].isEmpty()) {
            return null;
        }
        String asWritten = String.join(" ", words);
        Arrays.sort(words);
        String key = String.join(" ", words);
        if (key.codePointCount(0, key.length()) < 3 || key.length() > 120 || ROLE_NAMES.contains(asWritten) || ROLE_NAMES.contains(key)) {
            return null;
        }
        return key;
    }

    /** An endpoint's domain key for lookalike matches: the skeleton of its registrable domain; null for a phone. */
    public static String endpointSkel(String kind, String value) {
        if (value == null || !("email".equals(kind) || "ma".equals(kind) || "apple".equals(kind)) || value.indexOf('@') < 0) {
            return null;
        }
        String domain = Norm.domain(value);
        return domain == null ? null : skeleton(registrable(domain));
    }

    /**
     * What a domain looks like, letter for letter: NFKC, accents dropped, case folded, each confusable letter as the Latin
     * one it passes for, then the ASCII tricks ({@code rn} as {@code m}, {@code vv} as {@code w}, {@code cl} as {@code d},
     * {@code 0} as {@code o}, {@code 1}, {@code i} and {@code |} as {@code l}, {@code 5} as {@code s}), and hyphens dropped.
     */
    static String skeleton(String domain) {
        if (domain == null) {
            return null;
        }
        String n = Normalizer.normalize(domain, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        StringBuilder mapped = new StringBuilder(n.length());
        for (int i = 0; i < n.length(); ) {
            int cp = n.codePointAt(i);
            i += Character.charCount(cp);
            String m = CONFUSABLE.get(cp);
            if (m != null) {
                mapped.append(m);
                continue;
            }
            String d = Normalizer.normalize(new String(Character.toChars(cp)), Normalizer.Form.NFD);
            for (int j = 0; j < d.length(); ) {
                int c = d.codePointAt(j);
                j += Character.charCount(c);
                if (Character.getType(c) == Character.NON_SPACING_MARK) {
                    continue;
                }
                String again = CONFUSABLE.get(c);
                if (again != null) {
                    mapped.append(again);
                } else {
                    mapped.appendCodePoint(c);
                }
            }
        }
        String s = mapped.toString()
                .replace("rn", "m").replace("vv", "w").replace("cl", "d")
                .replace('0', 'o').replace('1', 'l').replace('i', 'l').replace('|', 'l').replace('5', 's')
                .replace("-", "");
        return s;
    }

    private static final Set<String> SECOND_LEVELS = Set.of("co", "com", "org", "net", "ac", "gov", "edu", "ne", "or", "go", "gv");

    /**
     * The registrable part of a domain, near enough without the Public Suffix List: its last two labels, or its last three
     * when the second-last is a common second level under a country's two letters ({@code example.co.uk}).
     */
    static String registrable(String domain) {
        if (domain == null) {
            return null;
        }
        String[] labels = domain.split("\\.");
        if (labels.length <= 2) {
            return domain;
        }
        String tld = labels[labels.length - 1];
        String second = labels[labels.length - 2];
        int keep = tld.length() == 2 && SECOND_LEVELS.contains(second) ? 3 : 2;
        keep = Math.min(keep, labels.length);
        return String.join(".", Arrays.copyOfRange(labels, labels.length - keep, labels.length));
    }

    // ---- the warnings

    /**
     * The warnings for a stranger's message, in the order the office shows them; empty for none.
     *
     * @param address the sender's normalized address
     * @param shownName the display name as kept (null if dropped or none)
     * @param rawName the display name as the message had it, for the address-in-a-name check
     * @param senderContactId the sender's own contact, which a name match to itself never warns about
     */
    static List<Map<String, Object>> warnings(Connection c, String kind, String address, String shownName, String rawName,
            String senderContactId) throws SQLException {
        List<Map<String, Object>> out = new ArrayList<>();
        if (address == null || !("email".equals(kind) || "ma".equals(kind))) {
            return out;
        }
        String domain = Norm.domain(address);
        // A known contact's name on an address that isn't theirs.
        String key = nameKey(shownName);
        if (key != null) {
            Object[] match = Sql.one(c, """
                    SELECT ct.id, ct.name FROM contacts ct
                    WHERE ct.name_key = ? AND ct.id <> ?
                      AND EXISTS (SELECT 1 FROM endpoints e WHERE e.contact_id = ct.id AND e.standing = 'known')
                    LIMIT 1""", r -> new Object[] {r.getString(1), r.getString(2)}, key, senderContactId == null ? "" : senderContactId);
            if (match != null) {
                Map<String, Object> w = new LinkedHashMap<>();
                w.put("kind", NOT_USUAL_ADDRESS);
                w.put("contactId", match[0]);
                w.put("name", Norm.line((String) match[1], Norm.MAX_NAME));
                out.add(w);
            }
        }
        if (domain != null) {
            String like = lookalikeOf(c, domain);
            if (like != null) {
                Map<String, Object> w = new LinkedHashMap<>();
                w.put("kind", LOOKALIKE);
                w.put("domain", ascii(domain));
                w.put("like", like);
                out.add(w);
            }
            if (deceptiveIdn(domain)) {
                Map<String, Object> w = new LinkedHashMap<>();
                w.put("kind", PUNYCODE);
                w.put("domain", ascii(domain));
                out.add(w);
            }
        }
        if (rawName != null && shownName == null && rawName.indexOf('@') >= 0) {
            out.add(Map.of("kind", NAME_HELD_ADDRESS));
        }
        return out;
    }

    /**
     * The domain a sender's domain is drawn to look like, or null: the member's own domains, known contacts' domains (by
     * {@code endpoints.skel}) and the well-known ones, matched by skeleton with a different registrable domain; one letter
     * from a well-known name of five or more; or a well-known domain written in front of another.
     */
    static String lookalikeOf(Connection c, String domain) throws SQLException {
        String reg = registrable(domain);
        String skel = skeleton(reg);
        if (reg == null || skel == null || Known.SKELETONS.containsValue(reg)) {
            // A well-known domain itself is never anyone's lookalike.
            return null;
        }
        // The member's own domains first: mail that looks like it's from the member's own provider or domain.
        for (String own : Sql.list(c, "SELECT DISTINCT value FROM own_addresses WHERE kind IN ('email', 'ma')", r -> r.getString(1))) {
            String ownReg = registrable(Norm.domain(own));
            if (ownReg != null && !ownReg.equals(reg) && skel.equals(skeleton(ownReg))) {
                return ascii(ownReg);
            }
        }
        // A known contact's domain.
        for (String value : Sql.list(c, """
                SELECT value FROM endpoints WHERE skel = ? AND standing = 'known' AND kind IN ('email', 'ma') LIMIT 8""",
                r -> r.getString(1), skel)) {
            String theirs = registrable(Norm.domain(value));
            if (theirs != null && !theirs.equals(reg)) {
                return ascii(theirs);
            }
        }
        String known = Known.SKELETONS.get(skel);
        if (known != null && !known.equals(reg)) {
            return known;
        }
        String label = reg.indexOf('.') > 0 ? reg.substring(0, reg.indexOf('.')) : reg;
        String labelSkel = skeleton(label);
        for (String[] w : Known.LABELS) {
            String wReg = w[0];
            if (wReg.equals(reg)) {
                return null;
            }
            String wLabel = w[1];
            if (wLabel.length() >= 6 && !wLabel.equals(label) && oneEditApart(w[2], labelSkel)) {
                return wReg;
            }
            // paypal.com.secure-login.example: a well-known domain in front of another.
            if (!reg.equals(wReg) && domain.startsWith(wReg + ".")) {
                return wReg;
            }
        }
        return null;
    }

    /** Whether two strings are one insertion, deletion, substitution or swap of neighbours apart. */
    static boolean oneEditApart(String a, String b) {
        if (a == null || b == null || a.equals(b)) {
            return false;
        }
        int la = a.length();
        int lb = b.length();
        if (Math.abs(la - lb) > 1) {
            return false;
        }
        if (la == lb) {
            int first = -1;
            int diffs = 0;
            for (int i = 0; i < la; i++) {
                if (a.charAt(i) != b.charAt(i)) {
                    if (diffs == 0) {
                        first = i;
                    }
                    diffs++;
                }
            }
            if (diffs == 1) {
                return true;
            }
            return diffs == 2 && first + 1 < la && a.charAt(first) == b.charAt(first + 1) && a.charAt(first + 1) == b.charAt(first);
        }
        String shorter = la < lb ? a : b;
        String longer = la < lb ? b : a;
        int i = 0;
        int j = 0;
        boolean skipped = false;
        while (i < shorter.length() && j < longer.length()) {
            if (shorter.charAt(i) == longer.charAt(j)) {
                i++;
                j++;
            } else if (skipped) {
                return false;
            } else {
                skipped = true;
                j++;
            }
        }
        return true;
    }

    /**
     * Whether an internationalized domain should be shown as ASCII: a label that mixes scripts (Latin with Cyrillic, say), or
     * one spelled entirely in letters that pass for Latin ones ({@code \u0430\u0440\u0440l\u0435} in Cyrillic). One script that doesn't pass for
     * Latin ({@code \u043f\u043e\u0447\u0442\u0430.\u0440\u0444}, {@code \u4f8b\u3048.jp}) shows as written.
     */
    static boolean deceptiveIdn(String domain) {
        boolean ascii = true;
        for (int i = 0; i < domain.length(); i++) {
            if (domain.charAt(i) >= 0x80) {
                ascii = false;
                break;
            }
        }
        if (ascii) {
            return false;
        }
        for (String label : domain.split("\\.")) {
            Set<Character.UnicodeScript> scripts = new java.util.HashSet<>();
            boolean nonAscii = false;
            boolean allPass = true;
            for (int i = 0; i < label.length(); ) {
                int cp = label.codePointAt(i);
                i += Character.charCount(cp);
                if (cp >= 0x80) {
                    nonAscii = true;
                    if (!CONFUSABLE.containsKey(cp)) {
                        allPass = false;
                    }
                }
                Character.UnicodeScript script = Character.UnicodeScript.of(cp);
                if (script != Character.UnicodeScript.COMMON && script != Character.UnicodeScript.INHERITED) {
                    scripts.add(script);
                }
            }
            if (nonAscii && (!highlyRestrictive(scripts) || allPass)) {
                return true;
            }
        }
        return false;
    }

    /**
     * UTS #39's "highly restrictive" level: one script, or Latin with the scripts Chinese, Japanese and Korean are written in
     * together (Han with Hiragana and Katakana, with Bopomofo, or with Hangul). Anything else mixed, such as Latin with
     * Cyrillic or Greek, is how a lookalike is made.
     */
    private static boolean highlyRestrictive(Set<Character.UnicodeScript> scripts) {
        if (scripts.size() <= 1) {
            return true;
        }
        Set<Character.UnicodeScript> rest = new java.util.HashSet<>(scripts);
        rest.remove(Character.UnicodeScript.LATIN);
        if (rest.size() <= 1) {
            Character.UnicodeScript only = rest.isEmpty() ? null : rest.iterator().next();
            // Latin with one other script is fine only for the scripts that have no Latin lookalikes of their own here.
            return only == null || only == Character.UnicodeScript.HAN || only == Character.UnicodeScript.HIRAGANA
                    || only == Character.UnicodeScript.KATAKANA || only == Character.UnicodeScript.HANGUL || only == Character.UnicodeScript.BOPOMOFO;
        }
        Set<Character.UnicodeScript> japanese = Set.of(Character.UnicodeScript.HAN, Character.UnicodeScript.HIRAGANA, Character.UnicodeScript.KATAKANA);
        Set<Character.UnicodeScript> chinese = Set.of(Character.UnicodeScript.HAN, Character.UnicodeScript.BOPOMOFO);
        Set<Character.UnicodeScript> korean = Set.of(Character.UnicodeScript.HAN, Character.UnicodeScript.HANGUL);
        return japanese.containsAll(rest) || chinese.containsAll(rest) || korean.containsAll(rest);
    }

    /** A domain's ASCII form ({@code xn--} for an internationalized one); the domain itself if it can't be converted. */
    static String ascii(String domain) {
        try {
            return IDN.toASCII(domain, IDN.ALLOW_UNASSIGNED).toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException e) {
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < domain.length(); i++) {
                char ch = domain.charAt(i);
                out.append(ch < 0x80 ? ch : '?');
            }
            return out.toString();
        }
    }

    /** The warnings as kept: compact JSON, {@code {"w": [...]}}; null for none. */
    static String wire(List<Map<String, Object>> warnings) {
        if (warnings == null || warnings.isEmpty()) {
            return null;
        }
        return new String(com.minimalistalliance.desk.deskd.protocol.Json.bytes(Map.of("w", warnings)), java.nio.charset.StandardCharsets.UTF_8);
    }

    /** The warnings as kept, read back for the office; an empty list for none or anything unreadable. */
    @SuppressWarnings("unchecked")
    static List<Object> read(String json) {
        if (json == null) {
            return List.of();
        }
        try {
            Object o = com.minimalistalliance.desk.deskd.protocol.Json.parseObject(json.getBytes(java.nio.charset.StandardCharsets.UTF_8)).get("w");
            return o instanceof List<?> l ? (List<Object>) l : List.of();
        } catch (RuntimeException | com.minimalistalliance.desk.deskd.protocol.JsonFormatException e) {
            return List.of();
        }
    }
}
