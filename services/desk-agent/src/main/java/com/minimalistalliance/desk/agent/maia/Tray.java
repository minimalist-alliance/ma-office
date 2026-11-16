package com.minimalistalliance.desk.agent.maia;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The decision tray (the owner, Nov 15: "an assistant putting some brief papers and supporting materials on an executive
 * desk"; {@code ~/ma-coord/design-drafts/maia-tray/SPEC.md}; deskd {@code API.md} §23 "The tray"): every held thing
 * that needs the member's decision becomes <b>a paper</b>, with who's asking, a line on what, the supporting materials
 * and the answers that fit, built here by code and never by a model. Pure: {@link Room} passes the moment in, the
 * paper's state ({@link State}) comes from {@link TrayStore}.
 *
 * <ul>
 *   <li><b>Sources</b>, one paper each: a pending approval (the shield's merged {@code approval:<desk>} split into one
 *       paper per approval), a Phase 2 report that needs a decision or is blocked, a document in Needs you, a person
 *       waiting a day or more on the member's reply, and a to-do due today that came from someone.</li>
 *   <li><b>Answers</b> are code's per kind; for a report, her {@code paper_note} (in the turn she already runs) or the
 *       agent's own {@code ask} may replace them with up to 3 in the member's words, each through {@link #label}.
 *       She can't add an approve, accept, wake or batch answer, nor change the kind, the deadline or where it goes.</li>
 *   <li><b>Send, spend, delete and egress</b> carry a {@code confirm}: the first tap never acts. No pick is marked on
 *       those or on Decline.</li>
 *   <li><b>Later</b> only while the shield's deadline floor allows it: the next catch-up before the deadline, else
 *       "In 20 min" if that fits, else none. Approvals, limits and failed desks can't be dismissed.</li>
 *   <li><b>Never stored here:</b> free-form text, a message's subject, a document's text. Names and titles from a desk
 *       are plain and cut; the browser draws a sender's name ({@code {who}}) at draw time.</li>
 * </ul>
 */
public final class Tray {

    public static final int LINE_MAX = 140;
    public static final int LABEL_MAX = 28;
    public static final int TITLE_MAX = 80;
    public static final int PART_MAX = 60;
    public static final int NOTE_MAX = 500;
    public static final int MESSAGE_MAX = 2_000;
    public static final int MAX_PAPERS = 50;
    public static final int ANSWERS_MAX = 3;
    static final long MINUTE = 60_000L;
    static final long IN_20 = 20 * MINUTE;
    /** A person waiting on the member's reply this long, on a workday, gets a paper. */
    static final long REPLY_AFTER = 24 * 60 * MINUTE;
    /** Later three times: the next time offers "Let {asker} know: not now". */
    static final int LATER_NUDGE = 3;
    public static final Set<String> KINDS = Set.of("approval", "report", "doc", "reply", "todo");
    public static final Set<String> STATES = Set.of("open", "answered", "sending", "sent", "queued", "failed",
            "expired", "withdrawn");
    /** What an answer does. {@code open} only opens the material or the asker's app: it never files the paper. */
    public static final Set<String> DOES = Set.of("approve", "decline", "revise", "done", "follow_up", "move", "reply",
            "custom", "open", "not_now");
    private static final Pattern PAPER_ID = Pattern.compile("pp-[a-z2-7]{20}");
    private static final Pattern ANSWER_ID = Pattern.compile("[a-z][a-z0-9_]{0,23}");
    /**
     * A link, an address or markup in a label, after NFKC (full-width forms fold to ASCII): any dotted name (the
     * ideographic full stops too, which NFKC keeps), any slash.
     */
    private static final Pattern LINKY = Pattern.compile(
            "(?i)(https?|www[.\\u3002\\uFF61]|\\p{L}{2,}[.\\u3002\\uFF61]\\p{L}{2,}|[a-z0-9-][.\\u3002\\uFF61][a-z]{2,}\\b"
                    + "|[@/\\\\:<>\\[\\]`{}|])");

    private Tray() {}

    // ---------------------------------------------------------------- inputs

    /** The agent's own question in a REPORT line ({@link Reports.Ask}), and its summary, as the home desk read them. */
    public record ReportFacts(String messageId, String deskId, String deskName, String agentName, String status,
            String summary, Reports.Ask ask, String writeupId, long at) {}

    /** Her line and answers for one paper ({@code paper_note}), written in the turn she already runs. */
    public record Note(String line, List<String> answers, int pick, long at) {
        public Note {
            answers = answers == null ? List.of() : List.copyOf(answers);
        }
    }

    /** One paper's state on the home desk ({@code maia_tray_papers}): ids, times and labels only. */
    public record State(String paperId, String key, String kind, String deskId, String state, long laterUntil,
            int laterCount, String answerId, String answerLabel, long answeredAt, String device, long firstShownAt,
            long createdAt) {

        public static State fresh(String paperId, String key, String kind, String deskId, long now) {
            return new State(paperId, key, kind, deskId, "open", 0, 0, null, null, 0, null, 0, now);
        }

        State with(String state) {
            return new State(paperId, key, kind, deskId, state, laterUntil, laterCount, answerId, answerLabel,
                    answeredAt, device, firstShownAt, createdAt);
        }

        State later(long until) {
            return new State(paperId, key, kind, deskId, state, until, laterCount + 1, answerId, answerLabel,
                    answeredAt, device, firstShownAt, createdAt);
        }

        State answered(String id, String label, long at, String dev, String st) {
            return new State(paperId, key, kind, deskId, st, laterUntil, laterCount, id, label, at, dev, firstShownAt,
                    createdAt);
        }

        /** Remind me {day}: the paper comes back then, open; not a Later. */
        State remind(long until) {
            return new State(paperId, key, kind, deskId, state, until, laterCount, answerId, answerLabel, answeredAt,
                    device, firstShownAt, createdAt);
        }

        State shown(long at) {
            return firstShownAt > 0 ? this : new State(paperId, key, kind, deskId, state, laterUntil, laterCount,
                    answerId, answerLabel, answeredAt, device, at, createdAt);
        }

        public boolean open() {
            return "open".equals(state);
        }
    }

    /** What one build is given. */
    /**
     * What one build is given. {@code seen}: when each paper was first built in this run (the caller's own map, filled
     * here), so a paper whose source has no time of its own keeps its place in the stack.
     */
    public record Input(long now, ZoneId zone, Reach.Settings settings, List<Attention.Desk> desks,
            Map<String, ReachItems.Extras> extras, List<ReportFacts> reports, List<Reach.Item> items,
            Map<String, State> states, Map<String, Note> notes, Map<String, Long> seen) {
        public Input {
            seen = seen == null ? new HashMap<>() : seen;
            desks = List.copyOf(desks);
            extras = extras == null ? Map.of() : Map.copyOf(extras);
            reports = reports == null ? List.of() : List.copyOf(reports);
            items = items == null ? List.of() : List.copyOf(items);
            states = states == null ? Map.of() : Map.copyOf(states);
            notes = notes == null ? Map.of() : Map.copyOf(notes);
        }
    }

    // ---------------------------------------------------------------- a paper

    public record Answer(String id, String label, String does, String value, String confirm) {
        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", id);
            v.put("label", label);
            v.put("does", does);
            if (value != null) {
                v.put("value", value);
            }
            if (confirm != null) {
                v.put("confirm", Map.of("verb", confirm));
            }
            return v;
        }
    }

    public record Material(String materialId, String kind, String deskId, Map<String, Object> ref, String label) {
        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("materialId", materialId);
            v.put("kind", kind);
            v.put("deskId", deskId);
            v.put("ref", ref);
            v.put("label", label);
            return v;
        }
    }

    /** A built paper: what the room's snapshot carries ({@code reach.tray.papers}) and {@code agent.maia.tray.get}. */
    public record Paper(String paperId, String itemKey, String itemId, String kind, Map<String, Object> asker,
            String title, Map<String, Object> line, List<Answer> answers, Integer pick, Map<String, Object> freeform,
            Map<String, Object> later, boolean dismissable, List<Material> materials, Map<String, Object> reply,
            Long dueAt, Long expiresAt, boolean untrusted, String risk, State state, long at) {

        public String deskId() {
            return (String) reply.get("deskId");
        }

        public Answer answer(String id) {
            for (Answer a : answers) {
                if (a.id().equals(id)) {
                    return a;
                }
            }
            return null;
        }

        public Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("paperId", paperId);
            v.put("itemId", itemId);
            v.put("kind", kind);
            v.put("asker", asker);
            v.put("title", title);
            v.put("line", line);
            v.put("answers", answers.stream().map(Answer::view).toList());
            v.put("pick", pick);
            v.put("freeform", freeform);
            v.put("later", later);
            v.put("dismissable", dismissable);
            v.put("materials", materials.stream().map(Material::view).toList());
            v.put("reply", reply);
            v.put("dueAt", dueAt);
            v.put("expiresAt", expiresAt);
            v.put("untrusted", untrusted);
            v.put("risk", risk);
            v.put("state", state.state());
            v.put("laterCount", state.laterCount());
            if (state.answerId() != null) {
                Map<String, Object> a = new LinkedHashMap<>();
                a.put("answerId", state.answerId());
                a.put("label", state.answerLabel());
                a.put("at", state.answeredAt());
                v.put("answer", a);
            }
            v.put("at", at);
            return v;
        }
    }

    // ---------------------------------------------------------------- ids and labels

    /** "pp-" and 20 base32 characters of the SHA-256 of the paper's source key: the same paper on every build. */
    public static String paperId(String key) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(("tray:" + key).getBytes(StandardCharsets.UTF_8));
            String alphabet = "abcdefghijklmnopqrstuvwxyz234567";
            StringBuilder out = new StringBuilder("pp-");
            for (int i = 0; i < 20; i++) {
                out.append(alphabet.charAt((h[i] & 0xff) % 32));
            }
            return out.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static boolean paperIdOk(String s) {
        return s != null && PAPER_ID.matcher(s).matches();
    }

    public static boolean answerIdOk(String s) {
        return s != null && ANSWER_ID.matcher(s).matches();
    }

    /**
     * A label for an answer written by her or an agent: plain, at most 28 characters, and dropped (null) when it holds a
     * link, an address, an @, a number of 5 digits or more, markup or a hidden character, so an injected "Yes, send it
     * to x@evil.com" never becomes a button.
     */
    public static String label(Object raw) {
        if (!(raw instanceof String s)) {
            return null;
        }
        String before = s.strip();
        String p = MaiaAgent.plain(before, 200);
        if (p.isEmpty() || p.length() > LABEL_MAX || !p.equals(before.replaceAll("\\s+", " "))) {
            // Hidden characters were taken out, or it's too long: not hers to show.
            return null;
        }
        return safe(p) ? p : null;
    }

    /**
     * No link, address, markup or long number in words that become a button or a heading (Security's TRAY-L1): checked on
     * the NFKC form, and digits counted across spaces, dots, dashes and a plus (5 or more is a number to refuse).
     */
    static boolean safe(String text) {
        String k = java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFKC);
        if (LINKY.matcher(k).find()) {
            return false;
        }
        int digits = 0;
        for (int i = 0; i < k.length(); i++) {
            char c = k.charAt(i);
            if (Character.isDigit(c)) {
                if (++digits >= 5) {
                    return false;
                }
            } else if (c != ' ' && c != '.' && c != '-' && c != '+' && c != ',') {
                digits = 0;
            }
        }
        return true;
    }

    /** Up to 3 of her (or the agent's) answers through {@link #label}; any bad one drops them all (the defaults stay). */
    public static List<String> labels(Object raw) {
        if (!(raw instanceof List<?> l) || l.isEmpty() || l.size() > ANSWERS_MAX) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (Object o : l) {
            String x = label(o);
            if (x == null || out.stream().anyMatch(y -> y.equalsIgnoreCase(x))) {
                return List.of();
            }
            out.add(x);
        }
        return out;
    }

    // ---------------------------------------------------------------- Later

    /**
     * Later, by the shield's deadline floor: to the next catch-up when it comes before the deadline, else "In 20 min"
     * when that fits, else not offered. With no deadline, the next catch-up (or 20 minutes when the member set none).
     */
    static Map<String, Object> later(Long deadline, long now, ZoneId zone, Reach.Settings s) {
        Map<String, Object> v = new LinkedHashMap<>();
        Long next = Rhythm.next(now, zone, s);
        if (next != null && (deadline == null || next < deadline)) {
            v.put("allowed", true);
            v.put("until", next);
            v.put("kind", "catchup");
            return v;
        }
        if (deadline == null || now + IN_20 < deadline - 5 * MINUTE) {
            v.put("allowed", true);
            v.put("until", now + IN_20);
            v.put("kind", "in_20");
            return v;
        }
        v.put("allowed", false);
        v.put("until", null);
        v.put("kind", null);
        return v;
    }

    /** The day after today that's a workday, at the start of work: "Remind me Mon" and "Move to Mon". */
    static long nextWorkday(long now, ZoneId zone, Reach.Settings s) {
        return Rhythm.nextWorkdayStart(now, zone, s);
    }

    static String dayLabel(long at, long now, ZoneId zone) {
        String d = Rhythm.dayWords(at, now, zone);
        return "tomorrow".equals(d) ? "tomorrow" : d;
    }

    private static boolean workday(long at, ZoneId zone) {
        DayOfWeek d = Instant.ofEpochMilli(at).atZone(zone).getDayOfWeek();
        return d != DayOfWeek.SATURDAY && d != DayOfWeek.SUNDAY;
    }

    // ---------------------------------------------------------------- build

    /** Every open paper now, in stack order: soonest deadline within 3 hours first, then by asker and when it came. */
    public static List<Paper> build(Input in) {
        Map<String, Reach.Item> byKey = new HashMap<>();
        for (Reach.Item i : in.items()) {
            byKey.put(i.key(), i);
        }
        List<Paper> out = new ArrayList<>();
        for (Attention.Desk d : in.desks()) {
            if ("guild".equals(d.kind())) {
                continue;
            }
            for (Attention.Approval a : d.approvals()) {
                if (a.expiresAt() > 0 && a.expiresAt() <= in.now()) {
                    continue;
                }
                out.add(approval(in, d, a, byKey));
            }
            ReachItems.Extras x = in.extras().getOrDefault(d.deskId(), ReachItems.Extras.NONE);
            for (ReachItems.Doc doc : x.docs()) {
                if ("needs_you".equals(doc.place())) {
                    out.add(doc(in, d, doc, byKey));
                }
            }
            for (ReachItems.Thread t : x.threads()) {
                if (waiting(t, in.now(), in.zone())) {
                    out.add(reply(in, d, t, byKey));
                }
            }
            for (Attention.DueSoon due : d.dueSoon()) {
                if (due.from() != null && !due.id().isEmpty() && today(due.dueAt(), in.now(), in.zone())) {
                    out.add(todo(in, d, due, byKey));
                }
            }
        }
        for (ReportFacts r : in.reports()) {
            if ("needs_decision".equals(r.status()) || "blocked".equals(r.status())) {
                Attention.Desk d = in.desks().stream().filter(x -> x.deskId().equals(r.deskId())).findFirst()
                        .orElse(null);
                if (d != null && "guild".equals(d.kind())) {
                    continue;
                }
                out.add(report(in, d, r, byKey));
            }
        }
        long soon = in.now() + 3 * 60 * MINUTE;
        Map<String, Long> groupAt = new HashMap<>();
        for (Paper p : out) {
            groupAt.merge(group(p), p.at(), Math::min);
        }
        out.sort(Comparator.<Paper>comparingInt(p -> deadline(p) != null && deadline(p) <= soon ? 0 : 1)
                .thenComparingLong(p -> deadline(p) != null && deadline(p) <= soon ? deadline(p) : 0)
                .thenComparingLong(p -> groupAt.get(group(p)))
                .thenComparing(Tray::group)
                .thenComparingLong(Paper::at)
                .thenComparing(Paper::paperId));
        return out.size() > MAX_PAPERS ? List.copyOf(out.subList(0, MAX_PAPERS)) : out;
    }

    private static String group(Paper p) {
        Object agent = p.asker().get("agentId");
        return p.deskId() + "|" + (agent == null ? p.kind() : agent);
    }

    static Long deadline(Paper p) {
        return p.expiresAt() != null ? p.expiresAt() : p.dueAt();
    }

    private static boolean today(long at, long now, ZoneId zone) {
        return Instant.ofEpochMilli(at).atZone(zone).toLocalDate()
                .equals(Instant.ofEpochMilli(now).atZone(zone).toLocalDate());
    }

    /** A known, confirmed person in a direct thread who wrote last a day or more ago, on a workday. */
    static boolean waiting(ReachItems.Thread t, long now, ZoneId zone) {
        return "direct".equals(t.kind()) && t.known() && t.confirmed() && !t.bulk() && !t.contacts().isEmpty()
                && t.theyWroteLastAt() != null && now - t.theyWroteLastAt() >= REPLY_AFTER && workday(now, zone);
    }

    private static State state(Input in, String paperId, String key, String kind, String deskId, long at) {
        State s = in.states().get(paperId);
        long first = in.seen().computeIfAbsent(paperId, k -> at);
        return s != null ? s : State.fresh(paperId, key, kind, deskId, first);
    }

    private static String itemId(Map<String, Reach.Item> byKey, String key) {
        Reach.Item i = byKey.get(key);
        return i == null ? Attention.id(key) : i.id();
    }

    private static Map<String, Object> asker(String kind, Attention.Desk d, String deskId, String agentId,
            Focus.Person who, String rest) {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("kind", kind);
        a.put("deskId", deskId);
        if (agentId != null) {
            a.put("agentId", agentId);
        }
        if (who != null) {
            a.put("who", Map.of("deskId", who.deskId(), "contactId", who.contactId()));
        }
        String desk = d == null ? "Your desk" : MaiaAgent.plain(d.name(), PART_MAX);
        a.put("label", desk + " · " + MaiaAgent.plain(rest, PART_MAX));
        a.put("name", MaiaAgent.plain(rest, PART_MAX));
        return a;
    }

    private static String agentName(Attention.Desk d, String agentId) {
        if (d != null && agentId != null) {
            for (Attention.Agent a : d.agents()) {
                if (a.agentId().equals(agentId) && !a.name().isEmpty()) {
                    return MaiaAgent.plain(a.name(), PART_MAX);
                }
            }
        }
        return "An agent";
    }

    private static Map<String, Object> line(String text, String by, String from) {
        if (text == null || text.isBlank()) {
            return null;
        }
        Map<String, Object> l = new LinkedHashMap<>();
        l.put("text", MaiaAgent.plain(text, LINE_MAX));
        l.put("by", by);
        l.put("from", from);
        return l;
    }

    /**
     * The box under the answers. A suggested reply to a person (her reading their mail, on credits) is the owner's open
     * question, default no: nothing here ever sets a draft; a {@code draft} field would be the seam, and the office would
     * only put it in the box for the member to send.
     */
    private static Map<String, Object> freeform(String to, int max, String as) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("to", to);
        f.put("max", max);
        f.put("as", as);
        return f;
    }

    private static Map<String, Object> reply(String kind, String deskId, Object... pairs) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("kind", kind);
        r.put("deskId", deskId);
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            if (pairs[i + 1] != null) {
                r.put((String) pairs[i], pairs[i + 1]);
            }
        }
        return r;
    }

    private static Map<String, Object> ref(Object... pairs) {
        Map<String, Object> r = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            if (pairs[i + 1] != null) {
                r.put((String) pairs[i], pairs[i + 1]);
            }
        }
        return r;
    }

    /** Later three times: "Let {who} know: not now" is offered (never done for the member). */
    private static List<Answer> nudge(List<Answer> answers, State s, String who, String does) {
        if (s.laterCount() < LATER_NUDGE) {
            return answers;
        }
        List<Answer> out = new ArrayList<>(answers);
        String label = MaiaAgent.plain("Tell " + who + ": not now", LABEL_MAX);
        out.add(new Answer("not_now", label.length() < LABEL_MAX ? label : "Say not now", does, "Not now", null));
        return out;
    }

    // ---- an approval: one paper per approval

    static Paper approval(Input in, Attention.Desk d, Attention.Approval a, Map<String, Reach.Item> byKey) {
        String key = "approval:" + d.deskId() + ":" + a.approvalId();
        String id = paperId(key);
        String itemKey = "approval:" + d.deskId();
        String agent = agentName(d, a.agentId());
        // An approval whose class the office didn't say (or doesn't know) gets the confirm strip too (Security's TRAY-L3).
        String risk = a.risk();
        boolean confirm = risk == null || !Set.of("write", "own").contains(risk);
        Long expires = a.expiresAt() > 0 ? a.expiresAt() : null;
        State s = state(in, id, key, "approval", d.deskId(), in.now());
        List<Answer> answers = new ArrayList<>();
        answers.add(new Answer("approve", confirm ? "Approve…" : "Approve", "approve", null,
                confirm ? verb(risk) : null));
        answers.add(new Answer("revise", "Ask for changes", "revise", null, null));
        answers.add(new Answer("decline", "Decline", "decline", null, null));
        List<Material> materials = List.of(new Material("m-payload", "payload", d.deskId(),
                ref("approvalId", a.approvalId()), "What " + agent + " wants to do"));
        return new Paper(id, itemKey, itemId(byKey, itemKey), "approval",
                asker("agent", d, d.deskId(), a.agentId().isEmpty() ? null : a.agentId(), null, agent),
                MaiaAgent.plain(agent + " needs your OK", TITLE_MAX),
                line(agent + " asked while working. Nothing happens until you answer.", "code", null),
                nudge(answers, s, agent, "decline"), confirm ? null : 0, freeform(agent, NOTE_MAX, "note"),
                later(expires, in.now(), in.zone(), in.settings()), false, materials,
                reply("approval", d.deskId(), "approvalId", a.approvalId(), "agentId",
                        a.agentId().isEmpty() ? null : a.agentId()),
                null, expires, a.untrusted(), risk, s, s.createdAt());
    }

    /** The confirm strip's verb, by the approval's class; an unknown one just asks to go ahead. */
    static String verb(String risk) {
        return switch (risk == null ? "" : risk) {
            case "spend" -> "pay";
            case "delete" -> "delete";
            case "egress" -> "share";
            case "send" -> "send";
            default -> "approve";
        };
    }

    // ---- a report that needs a decision or is blocked

    static Paper report(Input in, Attention.Desk d, ReportFacts r, Map<String, Reach.Item> byKey) {
        String key = "report:" + r.deskId() + ":" + r.messageId();
        String id = paperId(key);
        String itemKey = "result:" + r.deskId();
        String agent = MaiaAgent.plain(r.agentName() == null ? "An agent" : r.agentName(), PART_MAX);
        boolean blocked = "blocked".equals(r.status());
        State s = state(in, id, key, "report", r.deskId(), r.at());
        Note note = in.notes().get(id);
        List<Answer> answers = new ArrayList<>();
        Integer pick = null;
        List<String> mine = note == null ? List.of() : labels(note.answers());
        List<String> theirs = r.ask() == null ? List.of() : labels(r.ask().options());
        List<String> chosen = !mine.isEmpty() ? mine : theirs;
        for (int i = 0; i < chosen.size(); i++) {
            answers.add(new Answer("a" + (i + 1), chosen.get(i), "custom", chosen.get(i), null));
        }
        if (!chosen.isEmpty()) {
            // "Something else" is the free-form box under them, addressed to the agent.
            pick = note != null && !mine.isEmpty() ? Math.max(0, Math.min(chosen.size() - 1, note.pick())) : 0;
        } else if (blocked) {
            answers.add(new Answer("open", "Open " + MaiaAgent.plain(agent, 20), "open", null, null));
            answers.add(new Answer("stop", "Stop it", "custom", "Please stop this task.", null));
        } else {
            answers.add(new Answer("reply", "Reply", "reply", null, null));
        }
        Map<String, Object> line;
        if (note != null && !note.line().isBlank()) {
            line = line(note.line(), "maia", r.writeupId() == null ? null : "m-writeup");
        } else if (r.summary() != null && !r.summary().isBlank()) {
            line = line(r.summary(), "agent", r.writeupId() == null ? null : "m-writeup");
        } else {
            line = line(blocked ? agent + " is stuck and can't go on without you."
                    : agent + " needs you to choose before going on.", "code", null);
        }
        // The agent's own question heads the paper only when it holds no link, address or long number (TRAY-I2).
        String question = r.ask() == null || r.ask().question() == null ? "" : MaiaAgent.plain(r.ask().question(),
                TITLE_MAX);
        String title = !question.isBlank() && safe(question) ? question
                : blocked ? agent + " is stuck" : agent + " needs your decision";
        List<Material> materials = new ArrayList<>();
        if (r.writeupId() != null) {
            materials.add(new Material("m-writeup", "writeup", r.deskId(), ref("writeupId", r.writeupId()),
                    agent + "’s write-up"));
        }
        Long due = r.ask() == null ? null : r.ask().dueAt();
        return new Paper(id, itemKey, itemId(byKey, itemKey), "report",
                asker("agent", d, r.deskId(), null, null, agent), title, line,
                nudge(answers, s, agent, "custom"), pick, freeform(agent, MESSAGE_MAX, "message"),
                later(due, in.now(), in.zone(), in.settings()), true, materials,
                reply("maia_brief", r.deskId(), "messageId", r.messageId()), due, null, true, null, s, r.at());
    }

    // ---- a document in Needs you

    static Paper doc(Input in, Attention.Desk d, ReachItems.Doc doc, Map<String, Reach.Item> byKey) {
        String key = "doc:" + d.deskId() + ":" + doc.docId();
        String id = paperId(key);
        Focus.Person who = doc.contacts().isEmpty() ? null : doc.contacts().get(0);
        String agent = doc.agentId() != null ? agentName(d, doc.agentId()) : null;
        State s = state(in, id, key, "doc", d.deskId(), doc.at() == 0 ? in.now() : doc.at());
        long remind = nextWorkday(in.now(), in.zone(), in.settings());
        List<Answer> answers = List.of(new Answer("open", "Open", "open", null, null),
                new Answer("done", "Done", "done", null, null),
                new Answer("remind", "Remind me " + dayLabel(remind, in.now(), in.zone()), "follow_up",
                        Long.toString(remind), null));
        Map<String, Object> free = who != null && doc.channelId() != null ? freeform("{who}", MESSAGE_MAX, "reply")
                : agent != null ? freeform(agent, MESSAGE_MAX, "message") : freeform(null, 0, "none");
        String title = who != null ? "A document from {who} needs you" : agent != null
                ? MaiaAgent.plain(agent + " made a document for you", TITLE_MAX) : "A document needs you";
        return new Paper(id, "doc:" + d.deskId() + ":" + doc.docId(), itemId(byKey, key), "doc",
                asker(who != null ? "person" : agent != null ? "agent" : "desk", d, d.deskId(), doc.agentId(), who,
                        who != null ? "{who}" : agent != null ? agent : "Documents"),
                title, line(doc.changed() ? "It changed since you last opened it." : "It’s waiting in Needs you.",
                        "code", null), answers, null, free, later(doc.dueAt(), in.now(), in.zone(), in.settings()),
                true, List.of(new Material("m-doc", "doc", d.deskId(), ref("docId", doc.docId()), "Document")),
                reply("doc", d.deskId(), "docId", doc.docId(), "channelId", doc.channelId(), "agentId",
                        doc.agentId()),
                doc.dueAt(), null, true, null, s, s.createdAt());
    }

    // ---- a person waiting on the member's reply

    static Paper reply(Input in, Attention.Desk d, ReachItems.Thread t, Map<String, Reach.Item> byKey) {
        String key = "reply:" + d.deskId() + ":" + t.channelId() + ":" + t.theyWroteLastAt();
        String id = paperId(key);
        String itemKey = "message:" + d.deskId() + ":" + t.channelId();
        Focus.Person who = t.contacts().get(0);
        State s = state(in, id, key, "reply", d.deskId(), t.theyWroteLastAt());
        long remind = nextWorkday(in.now(), in.zone(), in.settings());
        List<Answer> answers = List.of(new Answer("reply", "Reply", "reply", null, null),
                new Answer("remind", "Remind me " + dayLabel(remind, in.now(), in.zone()), "follow_up",
                        Long.toString(remind), null),
                new Answer("none", "No reply needed", "done", null, null));
        return new Paper(id, itemKey, itemId(byKey, itemKey), "reply", asker("person", d, d.deskId(), null, who,
                "{who}"), "{who} is waiting on your reply",
                line("{who} wrote " + Rhythm.dayWords(t.theyWroteLastAt(), in.now(), in.zone())
                        + " · waiting on your reply", "code", null),
                answers, 0, freeform("{who}", MESSAGE_MAX, "reply"), later(null, in.now(), in.zone(), in.settings()),
                true, List.of(new Material("m-thread", "thread", d.deskId(), ref("channelId", t.channelId()),
                        "Conversation")),
                reply("courier", d.deskId(), "channelId", t.channelId()), null, null, true, null, s,
                t.theyWroteLastAt());
    }

    // ---- a to-do due today that came from someone

    static Paper todo(Input in, Attention.Desk d, Attention.DueSoon due, Map<String, Reach.Item> byKey) {
        String key = "todo:" + d.deskId() + ":" + due.id() + ":" + due.dueAt();
        String id = paperId(key);
        String itemKey = "todo:" + d.deskId() + ":" + due.id();
        State s = state(in, id, key, "todo", d.deskId(), in.now());
        long move = nextWorkday(in.now(), in.zone(), in.settings());
        List<Answer> answers = List.of(new Answer("done", "Done", "done", null, null),
                new Answer("move", "Move to " + dayLabel(move, in.now(), in.zone()), "move", Long.toString(move),
                        null));
        String from = switch (due.from()) {
            case "courier" -> "From a message";
            case "desk" -> "From another desk";
            case "agent_chat" -> "From an agent’s chat";
            default -> "From " + due.from();
        };
        return new Paper(id, itemKey, byKey.containsKey(itemKey) ? itemId(byKey, itemKey)
                : itemId(byKey, "todos:" + d.deskId()), "todo", asker("desk", d, d.deskId(), null, null, "To-do"),
                MaiaAgent.plain("Due " + Rhythm.clock(due.dueAt(), in.zone()) + ": " + due.title(), TITLE_MAX),
                line(from + " · due today", "code", null), answers, 0, freeform(null, 0, "none"),
                later(due.dueAt(), in.now(), in.zone(), in.settings()), true,
                List.of(new Material("m-todo", "todo", d.deskId(), ref("todoId", due.id()), "To-do")),
                reply("todo", d.deskId(), "todoId", due.id()), due.dueAt(), null, false, null, s, s.createdAt());
    }

    // ---------------------------------------------------------------- the snapshot

    /**
     * {@code reach.tray}: {@code count} (open papers, Later ones too), {@code now} (open and not put off), and the papers
     * not put off, in stack order. A screen share or call hides the words (the browser says "A paper from Writer").
     */
    public static Map<String, Object> view(List<Paper> papers, long now) {
        List<Map<String, Object>> shown = new ArrayList<>();
        int open = 0;
        int later = 0;
        for (Paper p : papers) {
            if (!p.state().open()) {
                continue;
            }
            open++;
            if (p.state().laterUntil() > now) {
                later++;
                continue;
            }
            shown.add(p.view());
        }
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("count", open);
        v.put("now", shown.size());
        v.put("later", later);
        v.put("papers", shown);
        return v;
    }

    // ---------------------------------------------------------------- answering

    /** What an answer does to the paper's state on the home desk. */
    public record Answered(State state, String deliver) {}

    /**
     * The member's answer, checked against the paper as built: an answer id the paper offers (or {@code custom} with
     * their words, only where it takes free-form), the text within its limit. {@code deliver}: who carries it
     * ({@code office} for the asking desk's own method, {@code home} for her brief's follow-up, {@code none} for an
     * answer that only files the paper here).
     */
    public static Answered answer(Paper p, String answerId, String text, String device, long now)
            throws com.minimalistalliance.desk.agent.service.RpcError {
        if (!p.state().open()) {
            throw com.minimalistalliance.desk.agent.service.RpcError.of("conflict", "reason", "answered");
        }
        String does;
        String label;
        if ("custom".equals(answerId)) {
            if ("none".equals(p.freeform().get("as"))) {
                throw com.minimalistalliance.desk.agent.service.RpcError.badRequest("answerId");
            }
            int max = (int) p.freeform().get("max");
            if (text == null || text.isBlank() || text.length() > max || hidden(text)) {
                throw com.minimalistalliance.desk.agent.service.RpcError.badRequest("text");
            }
            does = "approval".equals(p.kind()) ? "decline" : "reply";
            label = "approval".equals(p.kind()) ? "Sent back with your note" : "Your reply";
        } else {
            Answer a = p.answer(answerId);
            if (a == null) {
                throw com.minimalistalliance.desk.agent.service.RpcError.badRequest("answerId");
            }
            if ("open".equals(a.does())) {
                throw com.minimalistalliance.desk.agent.service.RpcError.badRequest("answerId");
            }
            if (("revise".equals(a.does()) || "reply".equals(a.does())) && (text == null || text.isBlank())) {
                // Ask for changes and Reply carry the member's words.
                throw com.minimalistalliance.desk.agent.service.RpcError.badRequest("text");
            }
            if (text != null && !text.isBlank()) {
                int max = p.freeform().get("max") instanceof Integer m ? m : 0;
                if (max == 0 || text.length() > max || hidden(text)) {
                    throw com.minimalistalliance.desk.agent.service.RpcError.badRequest("text");
                }
            }
            does = a.does();
            // Filed as said: "Approve", never "Approve…" (the dots only mean a confirm step follows).
            label = a.label().endsWith("…") ? a.label().substring(0, a.label().length() - 1) : a.label();
        }
        // Remind me is the tray's own (the paper comes back that day); No reply needed only files it. Everything else
        // goes back to whoever asked: her brief's follow-up from here, the rest by the member's own device.
        String deliver = "follow_up".equals(does) || "reply".equals(p.kind()) && "done".equals(does) ? "none"
                : "maia_brief".equals(p.reply().get("kind")) ? "home" : "office";
        if ("follow_up".equals(does)) {
            Answer a = p.answer(answerId);
            long until = a != null && a.value() != null ? Long.parseLong(a.value()) : now + 24 * 60 * MINUTE;
            return new Answered(p.state().remind(until), "none");
        }
        return new Answered(p.state().answered(answerId, MaiaAgent.plain(label, LABEL_MAX + 12), now, device,
                "office".equals(deliver) || "home".equals(deliver) ? "sending" : "answered"), deliver);
    }

    static boolean hidden(String text) {
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            i += Character.charCount(cp);
            if (cp == '\n' || cp == '\t') {
                continue;
            }
            int type = Character.getType(cp);
            if (Character.isISOControl(cp) || type == Character.FORMAT || type == Character.PRIVATE_USE
                    || com.minimalistalliance.desk.agent.team.TextChecks.hidden(new String(Character.toChars(cp)))) {
                return true;
            }
        }
        return false;
    }

    /** Later on a paper: only while it's offered; it stays in Needs you and All held. */
    public static State laterOn(Paper p, long now) throws com.minimalistalliance.desk.agent.service.RpcError {
        if (!p.state().open()) {
            throw com.minimalistalliance.desk.agent.service.RpcError.of("conflict", "reason", "answered");
        }
        if (!Boolean.TRUE.equals(p.later().get("allowed")) || !(p.later().get("until") instanceof Long until)) {
            throw com.minimalistalliance.desk.agent.service.RpcError.of("bad_request", "reason", "deadline");
        }
        return p.state().later(until);
    }

    /** A paper whose source left (answered elsewhere, expired, the agent gone): withdrawn, unless the member answered. */
    static State gone(State s, Long expiresAt, long now) {
        if (!s.open()) {
            return s;
        }
        return s.with(expiresAt != null && expiresAt <= now ? "expired" : "withdrawn");
    }

    /** Today's date in the zone, for logs and the store. */
    static LocalDate day(long now, ZoneId zone) {
        return Instant.ofEpochMilli(now).atZone(zone).toLocalDate();
    }
}
