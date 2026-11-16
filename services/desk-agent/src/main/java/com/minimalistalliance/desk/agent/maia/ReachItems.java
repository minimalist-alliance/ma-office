package com.minimalistalliance.desk.agent.maia;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What enters the shield (the shield concept §3.2): the list's own items ({@link Attention}), each desk's People-lane
 * Courier threads and its documents' places, as the office passes them in {@code agent.maia.observe}, structure only.
 * Never Requests, Spam or Trash, never a Guild Desk, and never a desk's words as a signal: a subject saying "URGENT"
 * isn't here to read. Pure.
 */
public final class ReachItems {

    static final int MAX_THREADS = 50;
    static final int MAX_DOCS = 50;
    /** A result whose agent is blocked this long is "a desk or agent stuck". */
    static final long STUCK_AFTER = 30 * 60_000L;

    private ReachItems() {}

    /** A People-lane Courier thread with something unread, from that desk's {@code courier.attention}. */
    public record Thread(String channelId, String kind, List<Focus.Person> contacts, boolean known, boolean confirmed,
            boolean bulk, Long theyWroteLastAt, int replyBand, int unread, long newestAt) {}

    /** A document's place, from the documents index: ids only. */
    public record Doc(String docId, String place, List<Focus.Person> contacts, String agentId, String channelId,
            String todoId, String approvalId, Long dueAt, boolean changed, long at) {}

    /** The extras one desk sent beside the list's own fields. */
    public record Extras(List<Thread> threads, List<Doc> docs) {
        static final Extras NONE = new Extras(List.of(), List.of());
    }

    /** {@code desks[].courier} and {@code desks[].docs}, read leniently: a bad entry is skipped. */
    public static Extras parse(String deskId, Object courier, Object docs) {
        List<Thread> threads = new ArrayList<>();
        if (courier instanceof Map<?, ?> c && c.get("threads") instanceof List<?> l) {
            for (Object o : l) {
                if (threads.size() >= MAX_THREADS) {
                    break;
                }
                if (!(o instanceof Map<?, ?> t) || !(t.get("channelId") instanceof String ch) || !ulid(ch)) {
                    continue;
                }
                String kind = "group".equals(t.get("kind")) ? "group" : "direct";
                threads.add(new Thread(ch, kind, people(deskId, t.get("contactIds")),
                        Boolean.TRUE.equals(t.get("known")), Boolean.TRUE.equals(t.get("confirmed")),
                        Boolean.TRUE.equals(t.get("bulk")), time(t.get("theyWroteLastAt")),
                        (int) Math.max(0, Math.min(3, num(t.get("replyBand")))), (int) Math.max(0, Math.min(10_000,
                        num(t.get("unread")))), time(t.get("newestAt")) == null ? 0 : time(t.get("newestAt"))));
            }
        }
        List<Doc> ds = new ArrayList<>();
        if (docs instanceof List<?> l) {
            for (Object o : l) {
                if (ds.size() >= MAX_DOCS) {
                    break;
                }
                if (!(o instanceof Map<?, ?> d) || !(d.get("docId") instanceof String id)
                        || !id.matches("[A-Za-z0-9_:-]{1,80}") || !(d.get("place") instanceof String place)
                        || !Set.of("needs_you", "maybe", "read_later", "records").contains(place)) {
                    continue;
                }
                ds.add(new Doc(id, place, people(deskId, d.get("contactIds")), idOr(d.get("agentId")),
                        d.get("channelId") instanceof String ch && ulid(ch) ? ch : null, idOr(d.get("todoId")),
                        idOr(d.get("approvalId")), time(d.get("dueAt")), Boolean.TRUE.equals(d.get("changed")),
                        time(d.get("at")) == null ? 0 : time(d.get("at"))));
            }
        }
        return new Extras(threads, ds);
    }

    private static List<Focus.Person> people(String deskId, Object raw) {
        List<Focus.Person> out = new ArrayList<>();
        if (raw instanceof List<?> l) {
            for (Object o : l) {
                if (out.size() >= 8) {
                    break;
                }
                if (o instanceof String c && Focus.contactId(c)) {
                    out.add(new Focus.Person(deskId, c));
                }
            }
        }
        return out;
    }

    private static boolean ulid(String s) {
        return Focus.contactId(s);
    }

    private static String idOr(Object o) {
        return o instanceof String s && s.matches("[A-Za-z0-9_:-]{1,80}") ? s : null;
    }

    private static Long time(Object o) {
        return o instanceof Number n && n.longValue() > 0 ? n.longValue() : null;
    }

    private static long num(Object o) {
        return o instanceof Number n ? n.longValue() : 0;
    }

    /** Work or Personal, by the desk's kind. */
    static String scope(String kind) {
        return "work".equals(kind) ? "work" : "personal";
    }

    /** Every item for the shield, now. */
    public static List<Reach.Item> all(List<Attention.Item> list, List<Attention.Desk> desks,
            Map<String, Extras> extras, Map<String, String> resultStatus, long now, ZoneId zone) {
        Map<String, Attention.Desk> byId = new LinkedHashMap<>();
        for (Attention.Desk d : desks) {
            byId.put(d.deskId(), d);
        }
        List<Reach.Item> out = new ArrayList<>();
        for (Attention.Item i : list) {
            Reach.Item r = fromList(i, byId.get(i.deskId()), resultStatus, now, zone);
            if (r != null) {
                out.add(r);
            }
        }
        for (Attention.Desk d : desks) {
            if ("guild".equals(d.kind())) {
                continue;
            }
            // One item per to-do due later today or tomorrow (the list's own Now covers the last 2 hours).
            for (Attention.DueSoon due : d.dueSoon()) {
                if (due.dueAt() - now > Attention.TODO_NOW) {
                    out.add(fromDue(due, d, now, zone));
                }
            }
            Extras x = extras.getOrDefault(d.deskId(), Extras.NONE);
            for (Thread t : x.threads()) {
                out.add(fromThread(t, d));
            }
            for (Doc doc : x.docs()) {
                out.add(fromDoc(doc, d, now, zone));
            }
        }
        return out;
    }

    static Reach.Item fromList(Attention.Item i, Attention.Desk desk, Map<String, String> resultStatus, long now,
            ZoneId zone) {
        String scope = desk == null ? null : scope(desk.kind());
        String deskName = i.deskName();
        boolean codeNow = "now".equals(i.urgency());
        // A to-do due within 2 hours is the list's Now only when it's the member's own: one an agent made (or changed
        // after reading something untrusted) never opens the gate or rings the bell (Security's FS-L2, SF2-M1).
        if ("todos".equals(i.kind()) && codeNow && i.expiresAt() != null && desk != null && desk.dueSoon().stream()
                .anyMatch(x -> x.dueAt() == i.expiresAt() && Boolean.FALSE.equals(x.mine()))) {
            codeNow = false;
        }
        Set<String> tags = new HashSet<>();
        String need;
        String app;
        String agentId = null;
        String source = deskName == null ? "Maia" : deskName;
        Reach.Sender sender = new Reach.Sender(null, "own", true, 0, null, false);
        Long deadline = i.expiresAt();
        boolean expires = false;
        String goLabel = null;
        switch (i.kind()) {
            case "approval" -> {
                need = "you";
                app = "agent";
                expires = true;
                goLabel = "Review";
                if (desk != null && !desk.approvals().isEmpty()) {
                    agentId = desk.approvals().get(0).agentId();
                    String name = agentName(desk, agentId);
                    source = deskName + " · " + name;
                }
            }
            case "limit" -> {
                need = "you";
                app = "agent";
                tags.add("money");
                if (i.action() != null && i.action().get("ref") instanceof String ref) {
                    agentId = ref;
                    source = deskName + " · " + agentName(desk, ref);
                }
            }
            case "desk_failed" -> {
                need = "you";
                app = null;
                tags.add("stuck");
                goLabel = "See";
            }
            case "cap" -> {
                need = "you";
                app = "maia";
                tags.add("money");
                scope = null;
                goLabel = "See";
            }
            case "todos" -> {
                app = "todo";
                need = "action";
                if (i.expiresAt() != null && (desk == null || desk.dueSoon().stream().noneMatch(
                        x -> x.dueAt() == i.expiresAt() && Boolean.FALSE.equals(x.mine())))) {
                    // A to-do due today; a date-only one counts as the end of the workday (concept §3.2).
                    LocalDate due = Instant.ofEpochMilli(i.expiresAt()).atZone(zone).toLocalDate();
                    if (due.equals(Instant.ofEpochMilli(now).atZone(zone).toLocalDate())) {
                        tags.add("due_today");
                    }
                }
            }
            case "result" -> {
                app = "maia";
                String status = resultStatus.getOrDefault(i.deskId(), "done");
                // The report's status is the answering agent's word: it may say someone waits (needs you), never open
                // the gate (Security's FS-L2): "a desk stuck" is the desk's own failed state only.
                need = "needs_decision".equals(status) || "blocked".equals(status) ? "you" : "action";
                goLabel = "See result";
            }
            case "notes_unsure" -> {
                app = "maia";
                need = "action";
                scope = null;
                goLabel = "Sort";
            }
            case "notes" -> {
                app = "notebook";
                need = "info";
                tags.add("done");
                scope = null;
            }
            case "desk_asleep" -> {
                app = null;
                need = "info";
                goLabel = "Wake";
            }
            default -> {
                app = null;
                need = "info";
            }
        }
        Reach.Refs refs = new Reach.Refs(app, null, null, null, agentId, null, List.of());
        return new Reach.Item(i.key(), i.kind(), i.deskId(), deskName, scope, codeNow, refs, sender, deadline, expires,
                need, tags, i.count(), i.createdAt(), Attention.dismissable(i.kind()), i.title(), source, i.action(),
                goLabel);
    }

    static Reach.Item fromDue(Attention.DueSoon due, Attention.Desk d, long now, ZoneId zone) {
        Set<String> tags = new HashSet<>();
        // "Anything due today" counts the member's own to-dos: one an agent made (or changed after reading something
        // untrusted) doesn't open the gate by its due date (Security's FS-L2).
        if (!Boolean.FALSE.equals(due.mine()) && Instant.ofEpochMilli(due.dueAt()).atZone(zone).toLocalDate()
                .equals(Instant.ofEpochMilli(now).atZone(zone).toLocalDate())) {
            tags.add("due_today");
        }
        Map<String, Object> go = new LinkedHashMap<>();
        go.put("kind", "show");
        go.put("deskId", d.deskId());
        go.put("app", "todo");
        go.put("ref", due.id().isEmpty() ? "needs_you" : due.id());
        String id = due.id().isEmpty() ? Long.toString(due.dueAt(), 36) : due.id();
        Reach.Refs refs = new Reach.Refs("todo", null, due.id().isEmpty() ? null : due.id(), null, null, null,
                List.of());
        return new Reach.Item("todo:" + d.deskId() + ":" + id, "todo", d.deskId(), d.name(), scope(d.kind()), false,
                refs, new Reach.Sender(null, "own", true, 0, null, false), due.dueAt(), false, "action", tags, 1, now,
                true, "Due " + Rhythm.dayWords(due.dueAt(), now, zone) + " at " + Rhythm.clock(due.dueAt(), zone)
                + " on " + d.name() + ": " + MaiaAgent.plain(due.title(), Attention.NAME_MAX), d.name() + " · To-do",
                go, "Open");
    }

    static Reach.Item fromThread(Thread t, Attention.Desk d) {
        // A direct thread's one person; a group's newest sender isn't known by id, so no person stands for it (another
        // member's message never opens the gate for the first contact: Security's SF2-L1).
        Focus.Person who = !"direct".equals(t.kind()) || t.contacts().isEmpty() ? null : t.contacts().get(0);
        String standing = t.bulk() ? "bulk" : t.known() ? (t.confirmed() ? "known_confirmed" : "known") : "unknown";
        boolean direct = "direct".equals(t.kind());
        boolean theyLast = t.theyWroteLastAt() != null;
        String need = t.bulk() ? "info" : direct && t.known() && theyLast ? "you" : "action";
        Reach.Sender sender = new Reach.Sender(who, standing, t.confirmed(), t.replyBand(), t.theyWroteLastAt(),
                direct);
        Reach.Refs refs = new Reach.Refs("courier", t.channelId(), null, null, null, null, t.contacts());
        Map<String, Object> go = new LinkedHashMap<>();
        go.put("kind", "show");
        go.put("deskId", d.deskId());
        go.put("app", "courier");
        go.put("ref", t.channelId());
        String title = direct ? "{who} wrote on " + d.name() : "New messages in a group on " + d.name();
        return new Reach.Item("message:" + d.deskId() + ":" + t.channelId(), "message", d.deskId(), d.name(),
                scope(d.kind()), false, refs, sender, null, false, need, Set.of(), Math.max(1, t.unread()),
                t.newestAt(), true, title, d.name() + " · Courier", go, direct ? "Reply" : "Open");
    }

    static Reach.Item fromDoc(Doc doc, Attention.Desk d, long now, ZoneId zone) {
        Focus.Person who = doc.contacts().isEmpty() ? null : doc.contacts().get(0);
        String need = switch (doc.place()) {
            case "needs_you" -> doc.approvalId() != null || doc.todoId() != null ? "you" : "action";
            case "records" -> "record";
            default -> "info";
        };
        Set<String> tags = new HashSet<>();
        if (doc.changed()) {
            tags.add("changed");
        }
        if (doc.dueAt() != null && Instant.ofEpochMilli(doc.dueAt()).atZone(zone).toLocalDate()
                .equals(Instant.ofEpochMilli(now).atZone(zone).toLocalDate())) {
            tags.add("due_today");
        }
        Reach.Sender sender = who == null ? new Reach.Sender(null, doc.agentId() != null ? "own" : "own", true, 0,
                null, false) : new Reach.Sender(who, "known", false, 0, null, false);
        Reach.Refs refs = new Reach.Refs("files", doc.channelId(), doc.todoId(), doc.docId(), doc.agentId(), null,
                doc.contacts());
        Map<String, Object> go = new LinkedHashMap<>();
        go.put("kind", "doc");
        go.put("deskId", d.deskId());
        go.put("docId", doc.docId());
        String title = switch (doc.place()) {
            case "needs_you" -> who != null ? "A document from {who} needs you" : "A document needs you on "
                    + d.name();
            case "records" -> "A record on " + d.name();
            default -> doc.changed() ? "A document changed on " + d.name() : "A document to read on " + d.name();
        };
        return new Reach.Item("doc:" + d.deskId() + ":" + doc.docId(), "doc", d.deskId(), d.name(), scope(d.kind()),
                false, refs, sender, doc.dueAt(), false, need, tags, 1, doc.at() == 0 ? now : doc.at(), true, title,
                d.name() + " · Documents", go, "Open");
    }

    private static String agentName(Attention.Desk desk, String agentId) {
        if (desk != null) {
            for (Attention.Agent a : desk.agents()) {
                if (a.agentId().equals(agentId)) {
                    return a.name().isEmpty() ? "An agent" : a.name();
                }
            }
        }
        return "An agent";
    }
}
