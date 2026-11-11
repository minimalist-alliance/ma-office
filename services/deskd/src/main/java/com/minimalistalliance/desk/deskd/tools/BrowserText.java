package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * A page's MDoc (API.md section 14) as text the model reads, with a short ref on every control it may act on, and the
 * table that maps each ref back to the node, fingerprint and block the walker gave it. Everything in an MDoc came from
 * the page, so all of it is untrusted: square brackets in page text are escaped, so a page can't write something that
 * reads as one of deskd's own refs. What a sensitive field is (a password, a one-time code, a card, a masked field, a
 * payment provider's frame) is said, and it never has a ref: it's never a field here (T47-1).
 *
 * <p>Also deskd's words for what a control looks like it does, by its label: paying ({@code spend}) and sending a form
 * ({@code send}). These only ever raise a call's class (draft ADR section 2, "Spending").
 */
final class BrowserText {

    /** One page the model reads, in characters. */
    static final int PAGE_CHARS = 20_000;
    private static final int STRUCTURED_CHARS = 2_000;
    private static final int LABEL_CHARS = 200;

    /**
     * One control the model may act on.
     *
     * @param kind deskd's word for it, from the MDoc: {@code link}, {@code button}, {@code field}, {@code check},
     *     {@code select}
     * @param fieldKind a field's kind on the wire ({@code plain}, {@code query}, {@code multiline}, …), or null
     * @param label what it shows, as the page showed it; untrusted
     * @param name its accessible name when it isn't the label, or null; untrusted
     * @param enter a field the page submits on Enter
     * @param primary the page's main action
     * @param url for a link, where the walker read it goes, or null; untrusted, and checked again on the element itself
     *     as it's clicked
     */
    record Ref(String ref, String node, String fp, String block, long rev, String kind, String fieldKind, String label,
            String name, boolean enter, boolean primary, String url) {
        Ref(String ref, String node, String fp, String block, long rev, String kind, String fieldKind, String label,
                String name, boolean enter, boolean primary) {
            this(ref, node, fp, block, rev, kind, fieldKind, label, name, enter, primary, null);
        }
    }

    /**
     * @param refs every control with a ref, by ref
     * @param payment a payment provider's frame or a card field is on the page
     * @param fields a field the model could type into is on the page
     */
    record Rendered(String text, Map<String, Ref> refs, boolean payment, boolean fields) {}

    private BrowserText() {}

    /**
     * @param mdoc the MDoc as {@code browser.minified.get} gives it
     * @param refFor the ref for a node id, the same for the same node in the same document
     */
    static Rendered render(Map<String, Object> mdoc, Function<String, String> refFor) {
        Writer w = new Writer(mdoc, refFor);
        w.head();
        if (mdoc.get("blocks") instanceof List<?> blocks) {
            for (Object block : blocks) {
                if (block instanceof Map<?, ?> map) {
                    w.block(cast(map));
                }
            }
        }
        if (Boolean.TRUE.equals(mdoc.get("truncated"))) {
            w.line("[The page goes on past what deskd reads.]");
        }
        return new Rendered(w.out.toString().strip(), w.refs, w.payment, w.fields);
    }

    /**
     * One page of the text, from {@code from}, cut at a line's end under {@link #PAGE_CHARS} where there is one.
     *
     * @return {@code {text, from, next, total}}, {@code next} null on the last page
     */
    static Map<String, Object> page(String text, int from) {
        int start = Math.max(0, Math.min(from, text.length()));
        int end = Math.min(text.length(), start + PAGE_CHARS);
        if (end < text.length()) {
            int newline = text.lastIndexOf('\n', end);
            if (newline > start + PAGE_CHARS / 2) {
                end = newline + 1;
            }
            // Never between the two halves of a surrogate pair.
            if (end > start && Character.isHighSurrogate(text.charAt(end - 1))) {
                end--;
            }
        }
        Map<String, Object> page = new LinkedHashMap<>();
        page.put("text", text.substring(start, end));
        page.put("from", start);
        page.put("next", end < text.length() ? end : null);
        page.put("total", text.length());
        return page;
    }

    // ---- what a control looks like it does

    /** A control labelled buy, pay, place order, checkout, subscribe, donate or confirm purchase, in any case. */
    private static final Pattern PAYING = Pattern.compile(
            "\\b(buy|pay|paying|place\\s+(?:my\\s+|your\\s+|the\\s+)?order|check\\s?-?out|subscribe|donate|"
                    + "confirm\\s+(?:and\\s+pay|purchase|payment|order)|purchase|complete\\s+(?:purchase|payment|order)|"
                    + "order\\s+now|proceed\\s+to\\s+(?:checkout|payment)|start\\s+(?:my\\s+|your\\s+)?subscription)\\b",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);

    /** A button that delivers what's on the page to someone: a form's submit, by what it says. */
    private static final Pattern SENDING = Pattern.compile(
            "\\b(submit|send|post|publish|reply|comment|tweet|share|sign\\s?-?up|register|create\\s+(?:an\\s+|my\\s+|your\\s+)?account|"
                    + "apply|book|reserve|request|contact|message|invite|upload|report|rsvp|enquire|inquire|join|confirm)\\b",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);

    /** A field that's never to be typed into by the Agent, by its label, whatever the page's own markup says (T47-1). */
    private static final Pattern SENSITIVE_FIELD = Pattern.compile(
            "\\b(password|passcode|pass\\s?phrase|pin|one[-\\s]?time|otp|verification\\s+code|security\\s+code|auth(?:entication)?\\s+code|"
                    + "2fa|two[-\\s]?factor|cvv2?|cvc2?|csc|card\\s*(?:number|no\\.?|#|holder)|credit\\s+card|debit\\s+card|"
                    + "expir(?:y|ation)(?:\\s+date)?|iban|routing\\s+number|account\\s+number|sort\\s+code|ssn|social\\s+security)\\b",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);

    static boolean looksLikePaying(Ref ref) {
        return ref != null && (find(PAYING, ref.label()) || find(PAYING, ref.name()));
    }

    /**
     * A button that looks like it sends a form: its words say so, or it's the page's main action on a page with a field
     * the model could type into. Links navigate, and aren't sending.
     */
    static boolean looksLikeSubmit(Ref ref, boolean pageHasFields) {
        if (ref == null || !"button".equals(ref.kind())) {
            return false;
        }
        return find(SENDING, ref.label()) || find(SENDING, ref.name()) || (ref.primary() && pageHasFields);
    }

    static boolean looksSensitive(Ref ref) {
        return ref != null && (find(SENSITIVE_FIELD, ref.label()) || find(SENSITIVE_FIELD, ref.name()));
    }

    /** Text that holds a card number: 13 to 19 digits, spaces or dashes between, that pass the Luhn check. */
    static boolean holdsCardNumber(String text) {
        if (text == null) {
            return false;
        }
        StringBuilder digits = new StringBuilder();
        for (int i = 0; i <= text.length(); i++) {
            char c = i < text.length() ? text.charAt(i) : 'x';
            if (c >= '0' && c <= '9') {
                digits.append(c);
            } else if ((c == ' ' || c == '-') && digits.length() > 0 && i + 1 < text.length() && Character.isDigit(text.charAt(i + 1))) {
                continue;
            } else {
                if (digits.length() >= 13 && digits.length() <= 19 && luhn(digits.toString())) {
                    return true;
                }
                digits.setLength(0);
            }
        }
        return false;
    }

    private static boolean luhn(String digits) {
        int sum = 0;
        boolean twice = false;
        for (int i = digits.length() - 1; i >= 0; i--) {
            int d = digits.charAt(i) - '0';
            if (twice) {
                d *= 2;
                if (d > 9) {
                    d -= 9;
                }
            }
            sum += d;
            twice = !twice;
        }
        return sum % 10 == 0 && !digits.chars().allMatch(c -> c == '0');
    }

    private static boolean find(Pattern pattern, String text) {
        return text != null && pattern.matcher(text).find();
    }

    // ---- the writer

    private static final class Writer {
        final StringBuilder out = new StringBuilder();
        final Map<String, Ref> refs = new LinkedHashMap<>();
        final Map<String, Object> mdoc;
        final Function<String, String> refFor;
        final long rev;
        boolean payment;
        boolean fields;

        Writer(Map<String, Object> mdoc, Function<String, String> refFor) {
            this.mdoc = mdoc;
            this.refFor = refFor;
            this.rev = mdoc.get("rev") instanceof Number n ? n.longValue() : 0;
        }

        void line(String text) {
            out.append(text).append('\n');
        }

        void head() {
            Map<String, Object> site = Json.object(mdoc, "site");
            if (site != null && site.get("actions") instanceof List<?> actions && !actions.isEmpty()) {
                StringBuilder line = new StringBuilder("Site actions:");
                for (Object action : actions) {
                    if (action instanceof Map<?, ?> a) {
                        Map<String, Object> act = cast(a);
                        String label = text(act.get("label"));
                        String ref = control(act, "site", "button", null, label, null, false, false, null);
                        line.append(' ').append(ref == null ? "[" + label + "]" : "[" + ref + " " + str(act.get("tag")) + ": " + label + "]");
                    }
                }
                line(line.toString());
            }
            if (mdoc.get("challenge") instanceof Map<?, ?> challenge && "payment".equals(challenge.get("reason"))) {
                payment = true;
            }
            if (Boolean.TRUE.equals(mdoc.get("loading"))) {
                line("[The page is still loading.]");
            }
        }

        void block(Map<String, Object> b) {
            String t = str(b.get("t"));
            String key = str(b.get("key"));
            String dialog = Boolean.TRUE.equals(b.get("dialog")) ? "[dialog] " : "";
            String indent = b.get("depth") instanceof Number d ? "  ".repeat(Math.max(0, Math.min(8, d.intValue()))) : "";
            switch (t) {
                case "heading" -> {
                    int level = b.get("level") instanceof Number n ? Math.max(1, Math.min(6, n.intValue())) : 2;
                    line("");
                    line(dialog + "#".repeat(level) + " " + runs(b.get("runs"), key));
                }
                case "para" -> line(dialog + indent + (b.get("quote") instanceof Number q && q.intValue() > 0 ? "> " : "") + runs(b.get("runs"), key));
                case "item" -> {
                    int ordinal = b.get("ordinal") instanceof Number n ? n.intValue() : 0;
                    line(dialog + indent + (ordinal > 0 ? ordinal + ". " : "- ") + runs(b.get("runs"), key));
                }
                case "code" -> {
                    line("```");
                    line(str(b.get("text")));
                    line("```");
                }
                case "rule" -> line("---");
                case "image" -> {
                    String image = "[image: " + text(b.get("alt")) + "]";
                    if (b.get("link") instanceof Map<?, ?> link) {
                        image = run(cast(link), key) + " " + image;
                    }
                    line(dialog + image);
                }
                case "table" -> {
                    if (b.get("rows") instanceof List<?> rows) {
                        for (Object row : rows) {
                            if (row instanceof List<?> cells) {
                                List<String> parts = new ArrayList<>();
                                for (Object cell : cells) {
                                    parts.add(cell instanceof List<?> ? runs(cell, key) : cell instanceof Map<?, ?> m && m.get("runs") != null
                                            ? runs(m.get("runs"), key) : text(cell));
                                }
                                line("| " + String.join(" | ", parts) + " |");
                            }
                        }
                    }
                }
                case "meta" -> line(dialog + runs(b.get("runs"), key));
                case "controls", "bar", "filters" -> {
                    StringBuilder line = new StringBuilder(dialog).append(runs(b.get("runs"), key));
                    if (b.get("sort") instanceof Map<?, ?> sort) {
                        line.append(" Sort: ").append(run(cast(sort), key));
                    }
                    line(line.toString());
                    menus(b.get("menus"), key);
                }
                case "cards" -> cards(b.get("items"), key);
                case "group" -> line(dialog + text(b.get("label")) + (b.get("size") instanceof Number n ? " (" + n + ")" : ""));
                case "fold" -> line(dialog + text(b.get("label")) + (b.get("meta") != null ? ": " + text(b.get("meta")) : ""));
                case "island" -> line(dialog + "[" + str(b.get("kind")) + (b.get("label") != null ? ": " + text(b.get("label")) : "")
                        + (Boolean.TRUE.equals(b.get("ad")) ? ", an ad" : "") + "]");
                case "sensitive" -> line(dialog + sensitive(b));
                case "structured" -> {
                    String data = new String(Json.bytes(b.get("data") instanceof Map<?, ?> m ? cast(m) : Map.of()), StandardCharsets.UTF_8);
                    if (data.length() > STRUCTURED_CHARS) {
                        data = data.substring(0, STRUCTURED_CHARS) + "…";
                    }
                    line("[" + str(b.get("type")) + " data: " + escape(data) + "]");
                }
                case "answer" -> {
                    line(dialog + text(b.get("label")) + ": " + runs(b.get("runs"), key));
                    String sources = runs(b.get("sources"), key);
                    if (!sources.isBlank()) {
                        line("Sources: " + sources);
                    }
                }
                case "comment" -> {
                    StringBuilder line = new StringBuilder(dialog).append(indent);
                    if (b.get("author") instanceof Map<?, ?> author) {
                        line.append(text(author.get("name"))).append(": ");
                    }
                    line.append(runs(b.get("runs"), key));
                    if (b.get("score") != null) {
                        line.append(" (score ").append(text(b.get("score"))).append(')');
                    }
                    for (String part : List.of("up", "down", "reply")) {
                        if (b.get(part) instanceof Map<?, ?> r) {
                            line.append(' ').append(run(cast(r), key));
                        }
                    }
                    line(line.toString());
                }
                case "paywall" -> line("[The rest is for subscribers: only the member can read on, on the real page.]");
                default -> {
                    if (b.get("runs") != null) {
                        line(dialog + runs(b.get("runs"), key));
                    }
                }
            }
        }

        void menus(Object menus, String block) {
            if (menus instanceof List<?> list) {
                for (Object menu : list) {
                    if (menu instanceof Map<?, ?> m) {
                        line("  " + text(m.get("label")) + ": " + runs(m.get("runs"), block));
                    }
                }
            }
        }

        void cards(Object items, String block) {
            if (!(items instanceof List<?> list)) {
                return;
            }
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> m)) {
                    continue;
                }
                Map<String, Object> card = cast(m);
                StringBuilder line = new StringBuilder("- ");
                if (card.get("title") instanceof Map<?, ?> title) {
                    Map<String, Object> t = cast(title);
                    String label = text(t.get("text"));
                    String ref = control(t, block, "link", null, label, null, false, false, t.get("url") instanceof String u ? u : null);
                    line.append(ref == null ? label : "[" + ref + " link: " + label + "]");
                    if (t.get("url") instanceof String url) {
                        line.append(" <").append(escape(url)).append('>');
                    }
                }
                for (String fact : List.of("price", "listPrice", "rating", "ratingCount", "badge", "deal", "delivery", "duration", "meta")) {
                    if (card.get(fact) != null) {
                        line.append(" · ").append(fact).append(' ').append(text(card.get(fact)));
                    }
                }
                if (card.get("snippet") != null) {
                    line.append(" — ").append(text(card.get("snippet")));
                }
                if (card.get("actions") != null) {
                    line.append(' ').append(runs(card.get("actions"), block));
                }
                line(line.toString());
            }
        }

        String runs(Object runs, String block) {
            if (runs instanceof String s) {
                return escape(s);
            }
            if (!(runs instanceof List<?> list)) {
                return "";
            }
            StringBuilder text = new StringBuilder();
            for (Object r : list) {
                if (r instanceof String s) {
                    text.append(escape(s));
                } else if (r instanceof Map<?, ?> m) {
                    text.append(run(cast(m), block));
                }
            }
            return text.toString();
        }

        String run(Map<String, Object> r, String block) {
            String kind = str(r.get("r"));
            return switch (kind) {
                case "b", "i", "s", "sup", "sub" -> runs(r.get("runs"), block);
                case "code" -> "`" + runs(r.get("runs"), block) + "`";
                case "br" -> "\n";
                case "image" -> "[image: " + text(r.get("alt")) + "]";
                case "link" -> {
                    String label = runs(r.get("runs"), block).strip();
                    String ref = control(r, block, "link", null, label, text(r.get("name")), false, Boolean.TRUE.equals(r.get("primary")),
                            r.get("url") instanceof String u ? u : null);
                    String url = r.get("url") instanceof String u ? " <" + escape(u) + ">" : "";
                    yield ref == null ? label + url : "[" + ref + " link: " + label + url + "]";
                }
                case "button" -> {
                    String label = text(r.get("label"));
                    String ref = control(r, block, "button", null, label, text(r.get("name")), false, Boolean.TRUE.equals(r.get("primary")),
                            null);
                    String flags = Boolean.TRUE.equals(r.get("disabled")) ? ", disabled" : "";
                    yield "[" + (ref == null ? "" : ref + " ") + "button: " + label + flags + "]";
                }
                case "field" -> {
                    String label = text(r.get("label"));
                    String fieldKind = str(r.get("kind"));
                    String ref = control(r, block, "field", fieldKind, label, null, Boolean.TRUE.equals(r.get("enter")), false, null);
                    if (ref != null) {
                        fields = true;
                    }
                    StringBuilder f = new StringBuilder("[");
                    if (ref != null) {
                        f.append(ref).append(' ');
                    }
                    f.append("field ").append(fieldKind).append(": ").append(label);
                    String value = text(r.get("value"));
                    if (!value.isEmpty()) {
                        f.append(" = \"").append(value).append('"');
                    } else if (r.get("placeholder") != null) {
                        f.append(" (placeholder: ").append(text(r.get("placeholder"))).append(')');
                    }
                    if (Boolean.TRUE.equals(r.get("disabled"))) {
                        f.append(", disabled");
                    }
                    yield f.append(']').toString();
                }
                case "check" -> {
                    String label = text(r.get("label"));
                    String ref = control(r, block, "check", null, label, null, false, false, null);
                    yield "[" + (ref == null ? "" : ref + " ") + str(r.get("kind")) + ": " + label
                            + (Boolean.TRUE.equals(r.get("checked")) ? ", checked" : ", not checked") + "]";
                }
                case "select" -> {
                    String label = text(r.get("label"));
                    String ref = control(r, block, "select", null, label, null, false, false, null);
                    List<String> options = new ArrayList<>();
                    if (r.get("options") instanceof List<?> list) {
                        for (Object option : list) {
                            options.add(text(option));
                        }
                    }
                    int selected = r.get("selected") instanceof Number n ? n.intValue() : -1;
                    String chosen = selected >= 0 && selected < options.size() ? options.get(selected) : "";
                    yield "[" + (ref == null ? "" : ref + " ") + "select: " + label + " = \"" + chosen + "\" (options: "
                            + String.join(" | ", options) + ")]";
                }
                case "sensitive" -> sensitive(r);
                case "vote" -> {
                    StringBuilder v = new StringBuilder("[score ").append(text(r.get("score")));
                    for (String side : List.of("up", "down")) {
                        if (r.get(side) instanceof Map<?, ?> arrow) {
                            String ref = control(cast(arrow), block, "button", null, side + "vote", null, false, false, null);
                            if (ref != null) {
                                v.append("; ").append(ref).append(' ').append(side).append("vote");
                            }
                        }
                    }
                    yield v.append(']').toString();
                }
                default -> runs(r.get("runs"), block);
            };
        }

        String sensitive(Map<String, Object> s) {
            String kind = str(s.get("kind"));
            if ("payment".equals(kind) || "card".equals(kind)) {
                payment = true;
            }
            String origin = s.get("origin") instanceof String o ? " on " + escape(o) : "";
            return "[" + kind.replace('_', ' ') + " field" + origin + ": only the member can use it, on the real page]";
        }

        /** A ref for a control with a node and a fingerprint, or null for one that isn't usable here. */
        String control(Map<String, Object> r, String block, String kind, String fieldKind, String label, String name, boolean enter,
                boolean primary, String url) {
            if (!(r.get("node") instanceof String node) || !(r.get("fp") instanceof String fp) || block == null) {
                return null;
            }
            String ref = refFor.apply(node);
            if (ref == null) {
                return null;
            }
            refs.put(ref, new Ref(ref, node, fp, block, rev, kind, fieldKind, cut(label), name == null || name.isEmpty() ? null : cut(name),
                    enter, primary, url));
            return ref;
        }
    }

    // ---- small things

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Map<?, ?> map) {
        return (Map<String, Object>) map;
    }

    private static String str(Object value) {
        return value instanceof String s ? s : value == null ? "" : String.valueOf(value);
    }

    private static String text(Object value) {
        return escape(str(value));
    }

    private static String cut(String label) {
        return label.length() <= LABEL_CHARS ? label : label.substring(0, LABEL_CHARS);
    }

    /** Page text never makes a bracket of deskd's own. */
    static String escape(String s) {
        if (s == null || s.isEmpty()) {
            return "";
        }
        if (s.indexOf('[') < 0 && s.indexOf(']') < 0) {
            return s;
        }
        return s.replace("[", "\\[").replace("]", "\\]");
    }
}
