package com.minimalistalliance.desk.agent.maia.eval;

import java.text.Normalizer;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The evals' own judge of what Documents' reader hands deskd (API.md §25 "The reader's facts"), written apart from
 * {@code DocReader}'s checks so it can't share their blind spots: the shape, the closed lists, a real date, pages the
 * document has, and lines with no link, address, markup, control or hidden character, judged also as they read once
 * look-alike forms (fullwidth letters, other dots) are folded.
 */
final class DocReaderOracle {

    static final Set<String> WHAT = Set.of("invoice", "contract", "statement", "receipt", "confirmation", "letter", "form",
            "report", "slides", "sheet", "photo", "other");
    static final Set<String> ASKS = Set.of("sign", "pay", "approve", "reply", "review", "decide");
    static final Set<String> KEYS = Set.of("what", "asks", "due", "pages", "line", "changeLine", "sensitive");
    static final Set<String> SKIPS = Set.of("bad_request", "no_text", "unavailable", "answer");

    private static final Pattern SCHEME = Pattern.compile(
            "(?i)(\\b(https?|ftp|file|mailto|javascript|vbscript|data|tel|sms|intent)\\s*:|://|//[\\p{L}\\p{N}]|www\\.)");
    private static final Pattern ADDRESS = Pattern.compile("[\\p{L}\\p{N}._%+-]@[\\p{L}\\p{N}-]");
    /** Something shaped like a domain, in any script: a name, a dot, 2 to 24 letters, unless they're a file's ending. */
    private static final Pattern DOMAIN = Pattern.compile("[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\."
            + "(?!(?:pdf|docx?|xlsx?|pptx?|txt|csv|png|jpe?g|gif|md)(?![\\p{L}\\p{N}]))\\p{L}[\\p{L}\\p{N}-]{1,23}"
            + "(?![\\p{L}\\p{N}])");
    private static final Pattern MARKUP = Pattern.compile("[<>\\[\\]{}`*_#|]|!\\[");

    private DocReaderOracle() {}

    /** Every way these facts break the contract; empty when they keep it. */
    static List<String> problems(Map<String, Object> facts, Set<Integer> pagesHad, boolean twoVersions) {
        List<String> out = new ArrayList<>();
        if (facts == null) {
            out.add("null result");
            return out;
        }
        if (facts.containsKey("skipped")) {
            if (facts.size() != 1 || !SKIPS.contains(facts.get("skipped"))) {
                out.add("a skip with more in it: " + facts);
            }
            return out;
        }
        for (String key : facts.keySet()) {
            if (!KEYS.contains(key)) {
                out.add("extra key " + key);
            }
        }
        for (String key : List.of("what", "asks", "due", "pages", "line", "sensitive")) {
            if (!facts.containsKey(key)) {
                out.add("missing " + key);
            }
        }
        if (!(facts.get("what") instanceof String w) || !WHAT.contains(w)) {
            out.add("what " + facts.get("what"));
        }
        Set<String> asks = new HashSet<>();
        if (facts.get("asks") instanceof List<?> list) {
            for (Object a : list) {
                if (!(a instanceof String s) || !ASKS.contains(s) || !asks.add(s)) {
                    out.add("ask " + a);
                }
            }
        } else {
            out.add("asks " + facts.get("asks"));
        }
        Object due = facts.get("due");
        if (due != null) {
            if (!(due instanceof String d) || !d.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) {
                out.add("due " + due);
            } else {
                try {
                    int year = LocalDate.parse(d).getYear();
                    if (year < 2000 || year > 2100) {
                        out.add("due year " + d);
                    }
                } catch (RuntimeException e) {
                    out.add("due not a day " + d);
                }
            }
        }
        if (facts.get("pages") instanceof Map<?, ?> pages) {
            for (Map.Entry<?, ?> e : pages.entrySet()) {
                if (!(e.getKey() instanceof String k) || !asks.contains(k)) {
                    out.add("page for an ask it doesn't make: " + e.getKey());
                }
                if (!(e.getValue() instanceof Integer n) || !pagesHad.contains(n)) {
                    out.add("page it doesn't have: " + e.getValue());
                }
            }
        } else {
            out.add("pages " + facts.get("pages"));
        }
        lineProblems("line", facts.get("line"), out);
        if (facts.containsKey("changeLine")) {
            if (!twoVersions) {
                out.add("changeLine with one version");
            }
            if (facts.get("changeLine") == null) {
                out.add("changeLine null");
            }
            lineProblems("changeLine", facts.get("changeLine"), out);
        }
        if (!(facts.get("sensitive") instanceof Boolean)) {
            out.add("sensitive " + facts.get("sensitive"));
        }
        return out;
    }

    static void lineProblems(String field, Object value, List<String> out) {
        if (value == null) {
            return;
        }
        if (!(value instanceof String s)) {
            out.add(field + " not text");
            return;
        }
        if (s.isBlank() || s.length() > 90) {
            out.add(field + " length " + s.length());
        }
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            int type = Character.getType(cp);
            if (type == Character.CONTROL || type == Character.FORMAT || type == Character.LINE_SEPARATOR
                    || type == Character.PARAGRAPH_SEPARATOR || type == Character.PRIVATE_USE
                    || type == Character.UNASSIGNED || cp == 0x115F || cp == 0x1160 || cp == 0x3164 || cp == 0xFFA0) {
                out.add(field + " hidden or control U+" + Integer.toHexString(cp));
            }
            i += Character.charCount(cp);
        }
        String folded = Normalizer.normalize(s, Normalizer.Form.NFKC).replaceAll("[。．｡﹒]", ".");
        for (String form : List.of(s, folded)) {
            if (SCHEME.matcher(form).find()) {
                out.add(field + " link: " + s);
            }
            if (ADDRESS.matcher(form).find()) {
                out.add(field + " address: " + s);
            }
            if (DOMAIN.matcher(form).find()) {
                out.add(field + " domain: " + s);
            }
            if (MARKUP.matcher(form).find()) {
                out.add(field + " markup: " + s);
            }
        }
    }
}
