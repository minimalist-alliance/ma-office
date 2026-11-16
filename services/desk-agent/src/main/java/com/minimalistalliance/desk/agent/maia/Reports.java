package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.json.Json;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a desk agent sends back to Desk Maia, as code reads it (Maia Mode Phase 2, draft-desk-maia.md decision 12): pure.
 *
 * <ul>
 *   <li><b>Her brief</b> carries what she expects ({@code expect}: up to 6 field names, {@code then} {@code report} or
 *       {@code think}, and what counts as urgent), and code adds a fixed block asking for a full write-up and one
 *       {@code REPORT {...}} line ({@link #briefBlock}).</li>
 *   <li><b>On the answering desk</b>, code reads the agent's reply ({@link #parseReply}): the full reply is the write-up,
 *       kept on that desk ({@code WriteUps}); what goes back is the short report, at most 1,500 characters, with a pointer
 *       to the write-up ({@link #compact}).</li>
 *   <li><b>On the home desk</b>, code reads that report ({@link #parseCompact}) and decides when her model reads it
 *       ({@code ReportQueue}). Everything in it came from another desk's agent: {@code U}, data only. Its urgency and
 *       importance only decide when she reads; never what reaches the member.</li>
 *   <li><b>Her reader's request</b> ({@code maia_read}) rides the same message, marked by {@link #READ_HEAD}, and is
 *       answered by the other desk's code from what already exists there, with no agent run.</li>
 * </ul>
 */
public final class Reports {

    public static final int REPORT_MAX = 1_500;
    public static final int SUMMARY_MAX = 600;
    public static final int FIELDS_MAX = 6;
    public static final int FIELD_NAME_MAX = 40;
    public static final int FIELD_VALUE_MAX = 300;
    public static final int URGENT_IF_MAX = 200;
    public static final Set<String> STATUSES = Set.of("done", "needs_decision", "blocked", "unknown", "failed");
    public static final Set<String> URGENCIES = Set.of("now", "soon", "later");
    public static final Set<String> IMPORTANCES = Set.of("critical", "normal", "low");
    /** The first line of a report as the answering desk's code writes it. */
    static final Pattern HEAD = Pattern.compile("^\\[report\\] status=([a-z_]{1,20}) urgency=([a-z]{1,10}) "
            + "importance=([a-z]{1,10}) writeup=(wu-[a-z2-7]{20}|none)$");
    public static final Pattern WRITEUP_ID = Pattern.compile("wu-[a-z2-7]{20}");
    private static final Pattern FIELD_NAME = Pattern.compile("[A-Za-z0-9_ -]{1,40}");
    /** Her reader's request, as the first line of a message to another desk. */
    public static final String READ_HEAD = "[maia-read v1]";

    private Reports() {}

    /** What she asked for in a brief. */
    public record Expect(List<String> fields, String then, String urgentIf, boolean newWork) {
        public static final Expect NONE = new Expect(List.of(), "think", null, false);

        /** Her {@code expect} as she sent it, read leniently; anything out of shape is left out. */
        public static Expect of(Object raw) {
            if (!(raw instanceof Map<?, ?> m)) {
                return NONE;
            }
            List<String> fields = new ArrayList<>();
            if (m.get("fields") instanceof List<?> list) {
                for (Object f : list) {
                    if (f instanceof String s && FIELD_NAME.matcher(s.strip()).matches() && fields.size() < FIELDS_MAX
                            && !fields.contains(s.strip())) {
                        fields.add(s.strip());
                    }
                }
            }
            String then = "report".equals(m.get("then")) ? "report" : "think";
            String urgent = m.get("urgentIf") instanceof String u && !u.isBlank()
                    ? MaiaAgent.plain(u, URGENT_IF_MAX) : null;
            return new Expect(List.copyOf(fields), then, urgent, Boolean.TRUE.equals(m.get("newWork")));
        }

        /** The same with code's sentence of what counts as urgent, when she gave none (the focus shield's list). */
        public Expect withUrgentIf(String sentence) {
            if (urgentIf != null || sentence == null || sentence.isBlank()) {
                return this;
            }
            return new Expect(fields, then, MaiaAgent.plain(sentence, URGENT_IF_MAX), newWork);
        }

        public Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("fields", fields);
            out.put("then", then);
            if (urgentIf != null) {
                out.put("urgentIf", urgentIf);
            }
            return out;
        }
    }

    /**
     * What counts as urgent for a desk agent, from the member's let-through list (the focus shield concept §9.3), as
     * one clause for the brief's "now only if …": kinds only, never a name. Agents' urgency still only decides when
     * she reads; it never opens the member's gate.
     */
    public static String urgentIfFrom(Reach.Settings s) {
        java.util.List<String> parts = new ArrayList<>();
        boolean people = false;
        for (Reach.Rule r : s.letThrough()) {
            switch (r.kind()) {
                case "match" -> parts.add(switch (r.match()) {
                    case "money" -> "money is at risk";
                    case "due_today" -> "something is due today";
                    default -> "someone has waited a day for the member's reply";
                });
                default -> people = true;
            }
        }
        if (people) {
            parts.add("someone on the member's list is waiting on them");
        }
        parts.add("a desk or agent is stuck");
        String clause = parts.size() == 1 ? parts.get(0) : String.join(", ", parts.subList(0, parts.size() - 1))
                + " or " + parts.get(parts.size() - 1);
        return clause.length() <= URGENT_IF_MAX ? clause : clause.substring(0, URGENT_IF_MAX);
    }

    /** The block code adds to her brief: the write-up, then one report line. Fixed words, her fields as data. */
    /** The block's line for new work about a write-up named in the brief (her {@code expect.newWork}). */
    public static final String NEW_WORK = "This is new work about the write-up named above.";

    public static String briefBlock(Expect e) {
        StringBuilder b = new StringBuilder(e.newWork() ? "\n\n" + NEW_WORK : "").append("\n\n---\nWhen you finish: write your full answer as your reply. It's kept on"
                + " this desk as your write-up. End your reply with one line, exactly:\nREPORT {\"status\":"
                + "\"done|needs_decision|blocked\",\"urgency\":\"now|soon|later\",\"importance\":\"critical|normal|low\","
                + "\"summary\":\"under 600 characters\",\"fields\":{");
        for (int i = 0; i < e.fields().size(); i++) {
            b.append(i == 0 ? "" : ",").append(new String(Json.bytes(e.fields().get(i)), StandardCharsets.UTF_8))
                    .append(":\"…\"");
        }
        b.append("}}\nUrgency is when Maia must read it: now only if ")
                .append(e.urgentIf() == null ? "the member must act within the hour" : e.urgentIf())
                .append("; soon for anything she should see shortly; later for the rest. Importance is how much it"
                        + " matters. needs_decision when the member or Maia must choose something: then you may add"
                        + " \"ask\":{\"question\":\"under 140 characters\",\"options\":[\"up to 4 short answers\"]}"
                        + " to the line, and the member answers you directly.");
        return b.toString();
    }

    /**
     * The agent's own question for the member, optional in a REPORT line (the decision tray, SPEC §10): a question of at
     * most 140 characters, up to 4 answers of at most 28 each (through {@link Tray#labels}, so a link, an address or a
     * long number drops them all), and when it's needed by. The agent's words: data, shown labelled as theirs.
     */
    public record Ask(String question, List<String> options, Long dueAt) {
        public static final int QUESTION_MAX = 140;
        public static final int OPTIONS_MAX = 4;

        public Ask {
            options = options == null ? List.of() : List.copyOf(options);
        }

        /** Read leniently: null when there's no question. */
        static Ask of(Object raw) {
            if (!(raw instanceof Map<?, ?> m) || !(m.get("question") instanceof String q) || q.isBlank()) {
                return null;
            }
            List<String> options = List.of();
            if (m.get("options") instanceof List<?> l && !l.isEmpty() && l.size() <= OPTIONS_MAX) {
                List<String> got = new ArrayList<>();
                for (Object o : l) {
                    String x = Tray.label(o);
                    if (x == null) {
                        got = null;
                        break;
                    }
                    got.add(x);
                }
                options = got == null ? List.of() : got.subList(0, Math.min(Tray.ANSWERS_MAX, got.size()));
            }
            Long due = m.get("dueAt") instanceof Number n && n.longValue() > 0 ? n.longValue() : null;
            return new Ask(MaiaAgent.plain(q, QUESTION_MAX), options, due);
        }

        Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("question", question);
            if (!options.isEmpty()) {
                out.put("options", options);
            }
            if (dueAt != null) {
                out.put("dueAt", dueAt);
            }
            return out;
        }
    }

    /** A report, as either desk's code holds it. Every string in it is the other agent's: plain, cut, data. */
    public record Report(String status, String urgency, String importance, String summary, Map<String, String> fields,
            String writeupId, Ask ask) {

        public Report(String status, String urgency, String importance, String summary, Map<String, String> fields,
                String writeupId) {
            this(status, urgency, importance, summary, fields, writeupId, null);
        }

        public boolean needsNothing() {
            return "done".equals(status) && !"now".equals(urgency) && !"critical".equals(importance);
        }
    }

    /**
     * The answering agent's reply, on its desk: its last {@code REPORT {...}} line read leniently. A reply without one is
     * {@code unknown}, read soon, with its opening as the summary.
     */
    public static Report parseReply(String reply) {
        String text = reply == null ? "" : reply.strip();
        int at = text.lastIndexOf("\nREPORT ");
        String line = at >= 0 ? text.substring(at + 1) : text.startsWith("REPORT ") ? text : null;
        if (line != null) {
            int end = line.indexOf('\n');
            String json = (end < 0 ? line : line.substring(0, end)).substring("REPORT ".length()).strip();
            try {
                Map<String, Object> r = Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
                String status = word(r.get("status"), STATUSES, "unknown");
                String urgency = word(r.get("urgency"), URGENCIES, "soon");
                String importance = word(r.get("importance"), IMPORTANCES, "normal");
                String summary = r.get("summary") instanceof String s ? MaiaAgent.plain(s, SUMMARY_MAX) : "";
                // Only a report that needs the member carries its question to the decision tray.
                Ask ask = "needs_decision".equals(status) || "blocked".equals(status) ? Ask.of(r.get("ask")) : null;
                return new Report(status, urgency, importance, summary.isEmpty() ? opening(text, at) : summary,
                        fields(r.get("fields")), null, ask);
            } catch (RuntimeException | com.minimalistalliance.desk.agent.json.JsonFormatException e) {
                // Not JSON: as if there were none.
            }
        }
        return new Report("unknown", "soon", "normal", opening(text, at), Map.of(), null);
    }

    private static String opening(String text, int reportAt) {
        String body = reportAt > 0 ? text.substring(0, reportAt) : text;
        return MaiaAgent.plain(body, SUMMARY_MAX);
    }

    private static String word(Object v, Set<String> allowed, String fallback) {
        return v instanceof String s && allowed.contains(s.strip().toLowerCase(Locale.ROOT))
                ? s.strip().toLowerCase(Locale.ROOT) : fallback;
    }

    private static Map<String, String> fields(Object raw) {
        Map<String, String> out = new LinkedHashMap<>();
        if (raw instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (out.size() == FIELDS_MAX) {
                    break;
                }
                if (e.getKey() instanceof String k && FIELD_NAME.matcher(k).matches()) {
                    Object v = e.getValue();
                    String s = v instanceof String str ? str : v == null ? "" : String.valueOf(v);
                    out.put(k, MaiaAgent.plain(s, FIELD_VALUE_MAX));
                }
            }
        }
        return out;
    }

    /** The short report the answering desk's code sends back: a fixed head line, the fields, the summary; at most 1,500. */
    public static String compact(Report r, String writeupId) {
        StringBuilder b = new StringBuilder("[report] status=").append(r.status()).append(" urgency=")
                .append(r.urgency()).append(" importance=").append(r.importance()).append(" writeup=")
                .append(writeupId == null ? "none" : writeupId);
        if (!r.fields().isEmpty()) {
            b.append("\nfields: ").append(new String(Json.bytes(r.fields()), StandardCharsets.UTF_8));
        }
        if (r.ask() != null) {
            b.append("\nask: ").append(new String(Json.bytes(r.ask().toJson()), StandardCharsets.UTF_8));
        }
        b.append("\nsummary: ").append(r.summary());
        String out = b.toString();
        return out.length() <= REPORT_MAX ? out : out.substring(0, REPORT_MAX);
    }

    /** A report as the home desk's code reads it, or null when the text isn't one (an older desk's plain answer). */
    public static Report parseCompact(String text) {
        if (text == null) {
            return null;
        }
        String[] lines = text.split("\n", -1);
        Matcher m = HEAD.matcher(lines[0].strip());
        if (!m.matches()) {
            return null;
        }
        Map<String, String> fields = Map.of();
        String summary = "";
        Ask ask = null;
        for (int i = 1; i < lines.length; i++) {
            String l = lines[i];
            if (l.startsWith("fields: ") && fields.isEmpty()) {
                try {
                    fields = fields(Json.parseObject(l.substring(8).getBytes(StandardCharsets.UTF_8)));
                } catch (RuntimeException | com.minimalistalliance.desk.agent.json.JsonFormatException e) {
                    fields = Map.of();
                }
            } else if (l.startsWith("ask: ") && ask == null) {
                try {
                    ask = Ask.of(Json.parseObject(l.substring(5).getBytes(StandardCharsets.UTF_8)));
                } catch (RuntimeException | com.minimalistalliance.desk.agent.json.JsonFormatException e) {
                    ask = null;
                }
            } else if (l.startsWith("summary: ")) {
                summary = MaiaAgent.plain(String.join(" ", java.util.Arrays.copyOfRange(lines, i, lines.length))
                        .substring(9), SUMMARY_MAX);
                break;
            }
        }
        String status = word(m.group(1), STATUSES, "unknown");
        return new Report(status, word(m.group(2), URGENCIES, "soon"),
                word(m.group(3), IMPORTANCES, "normal"), summary, fields,
                "none".equals(m.group(4)) ? null : m.group(4),
                "needs_decision".equals(status) || "blocked".equals(status) ? ask : null);
    }

    // ---------------------------------------------------------------- her reader's request

    /** A read request: a write-up by its id, or the latest write-ups matching some words. Her question stays home. */
    public record ReadRequest(String writeupId, String query) {}

    public static String readText(ReadRequest r) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (r.writeupId() != null) {
            body.put("writeup", r.writeupId());
        }
        if (r.query() != null) {
            body.put("query", r.query());
        }
        return READ_HEAD + "\n" + new String(Json.bytes(body), StandardCharsets.UTF_8);
    }

    /** The other desk's code reads it; null when the text isn't one. */
    public static ReadRequest parseRead(String text) {
        if (text == null || !text.startsWith(READ_HEAD + "\n")) {
            return null;
        }
        try {
            Map<String, Object> m = Json.parseObject(text.substring(READ_HEAD.length() + 1).strip()
                    .getBytes(StandardCharsets.UTF_8));
            String id = m.get("writeup") instanceof String w && WRITEUP_ID.matcher(w).matches() ? w : null;
            String q = m.get("query") instanceof String s && !s.isBlank() ? MaiaAgent.plain(s, 200) : null;
            return id == null && q == null ? null : new ReadRequest(id, q);
        } catch (RuntimeException | com.minimalistalliance.desk.agent.json.JsonFormatException e) {
            return null;
        }
    }
}
