package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.todo.TodoStore;
import com.minimalistalliance.desk.deskd.todo.TodoText;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * To-do's area of the Agent's tools (API.md §22, "The agent's To-do tools"; the To-do VISION's Part 2 §4, which is the
 * spec; the draft ADR's §13 and §15): {@code todo_list}, {@code todo_get}, {@code todo_add}, {@code todo_update} and
 * {@code todo_close}, on the desk's own {@code todo.db}, as the agent's owner, on this desk only.
 *
 * <p><b>deskd decides every call from its own facts,</b> never desk-agent's: the item's maker and run, deskd's copy of the
 * run's taint, and whether the member started the run ({@link RunLedger.Run#attended}). {@link #outcome} is the table in
 * API.md §22: a call is in the {@code todos} group (done without asking when the member switched it on for this agent,
 * which {@link ToolHost} checks against deskd's own record), asks on a card, records a suggestion ({@code todo_close}'s
 * floor is {@code own}, and only a close rises to {@code write}), or is refused {@code not_yours} before anyone is asked.
 *
 * <p><b>Provenance:</b> {@code todo_add}'s source must be one this run was given by a tool deskd hosts ({@link Provenance}),
 * or for {@code agent_chat} the member's message that started this run, or for {@code desk} ({@code {}}) the last message
 * from another of the member's desks deskd gave this run; otherwise {@code source_unknown}. Its label is
 * deskd's record of that source, never the model's. <b>Security's ATA-L1:</b> in a run holding U, an add is done without
 * asking only with a source whose content is itself untrusted and was read in this run ({@code courier}, {@code browser},
 * {@code files}); a {@code notebook} or {@code agent_chat} source then asks, as the member's own words would lend a
 * planted title their trust.
 *
 * <p>Nothing here logs a title, a note, a label or a ref.
 */
public final class TodoTools implements HostedTool {

    private static final Logger log = LoggerFactory.getLogger(TodoTools.class);

    /** The auto-approve group these tools are in (the draft ADR's §15). */
    public static final String GROUP = "todos";
    /** The source kinds an agent may cite. */
    static final Set<String> AGENT_KINDS = Set.of("courier", "notebook", "browser", "files", "agent_chat", "desk");
    /**
     * Kinds whose content is a third party's: in a run holding U, only these add without asking (ATA-L1). Not
     * {@code files}, {@code notebook} or {@code agent_chat}: each would lend a planted title the member's own trust
     * (Security's TD-L1). {@code desk}, a message from another of the member's desks, is untrusted there as here (§14).
     */
    static final Set<String> UNTRUSTED_KINDS = Set.of("courier", "browser", "desk");
    static final int LIST_DEFAULT = 20;
    static final int LIST_MAX = 50;
    static final int GET_EVENTS = 20;
    static final int Q_MAX = 100;
    private static final Pattern ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern AGENT = Pattern.compile("agent:[A-Za-z0-9_-]{1,64}");
    private static final Pattern REF_ID = Pattern.compile("[A-Za-z0-9_:.-]{1,128}");

    /** What deskd's policy makes of one call (API.md §22's table). */
    public enum Outcome {
        /** In the {@code todos} group: done without asking if the member's switch is on, else a card. */
        AUTO,
        /** A card, whatever the switch. */
        ASK,
        /** A suggestion on the item: no card, nothing closed. {@code todo_close} only. */
        SUGGEST,
        /** Refused {@code not_yours} before anyone is asked. */
        NOT_YOURS
    }

    private final Supplier<TodoStore> store;
    /**
     * The outcome deskd's look decided for a close about to run, by run and call id: {@link ToolHost} checked the ticket
     * or the switch against that look, so the run does what it decided and nothing more (Security's TD-I1). Taken once.
     */
    private final Map<Same, Outcome> decided = java.util.Collections.synchronizedMap(
            new java.util.LinkedHashMap<>(16, 0.75f, false) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<Same, Outcome> eldest) {
                    return size() > 1024;
                }
            });

    /**
     * The one call object {@link ToolHost} hands both the look and the run, by identity: two calls in flight with the same
     * run and id are two keys (the rest of Security's TD-I1).
     */
    private record Same(HostedCall call) {
        @Override
        public boolean equals(Object o) {
            return o instanceof Same other && other.call == call;
        }

        @Override
        public int hashCode() {
            return System.identityHashCode(call);
        }
    }

    /** @param store the open store, or null while there's none (no file, To-do switched off) */
    public TodoTools(Supplier<TodoStore> store) {
        this.store = store;
    }

    @Override
    public boolean available() {
        return store.get() != null;
    }

    // ---------------------------------------------------------------- the policy

    /** {@code todo_add}: without asking, but in a run holding U only with an untrusted-content source (ATA-L1). */
    public static Outcome addOutcome(boolean untrusted, String sourceKind) {
        return !untrusted || UNTRUSTED_KINDS.contains(sourceKind) ? Outcome.AUTO : Outcome.ASK;
    }

    /**
     * {@code todo_update}: its own item without asking in a clean run, and on a card after U; anyone else's (the member's
     * or another agent's) on a card when the member started the run, and never from a run nobody attended (§15: the
     * switch covers only the agent's own to-dos; Security's TD-L2).
     */
    public static Outcome updateOutcome(boolean untrusted, boolean attended, boolean own) {
        if (own) {
            return untrusted ? Outcome.ASK : Outcome.AUTO;
        }
        return attended ? Outcome.ASK : Outcome.NOT_YOURS;
    }

    /**
     * {@code todo_close}: in a clean run, its own item closes without asking when it's from this run or the member started
     * the run ("tick off ones it added"); otherwise a card when the member started the run, and only a suggestion when
     * nobody did. After U it never closes unasked, not even what this run added (an injected message could add a real
     * to-do and close it in one run).
     */
    public static Outcome closeOutcome(boolean untrusted, boolean attended, boolean own, boolean fromThisRun) {
        if (!untrusted && own && (fromThisRun || attended)) {
            return Outcome.AUTO;
        }
        return attended ? Outcome.ASK : Outcome.SUGGEST;
    }

    // ---------------------------------------------------------------- look

    @Override
    public Look look(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
        TodoStore s = need();
        return switch (call.tool()) {
            case "todo_list" -> Look.plain(listPayload(call.args()), Map.of("kind", "todos"));
            case "todo_get" -> {
                String id = id(call.args());
                yield Look.plain(Map.of("id", id), Map.of("kind", "todo", "id", id));
            }
            case "todo_add" -> lookAdd(s, call, run);
            case "todo_update" -> lookUpdate(s, call, run);
            case "todo_close" -> lookClose(s, call, run);
            default -> throw ToolFailure.notFound("tool");
        };
    }

    /** A checked add: what it would write and where its source came from. */
    private record Add(Map<String, Object> payload, String title, String note, TodoStore.Due due, TodoStore.Source source,
            String sameAs) {}

    private Look lookAdd(TodoStore s, HostedCall call, RunLedger.Run run) throws ToolFailure {
        Add add;
        try {
            add = add(s, call.args(), run);
        } catch (Refusal r) {
            return new Look(ToolRisk.WRITE, "agent", Map.of("kind", "todo"), call.args(), null, r.word);
        }
        Map<String, Object> target = new LinkedHashMap<>();
        target.put("kind", "todo");
        target.put("title", add.title());
        target.put("source", Map.of("kind", add.source().kind(), "label", add.source().label()));
        if (add.sameAs() != null) {
            // The card names the item it would merge into (Security's TD-M2), not only the new title.
            TodoStore.Facts into = facts(s, add.sameAs());
            String refusal = itemRefusal(into);
            if (refusal != null) {
                return new Look(ToolRisk.WRITE, "agent", target, add.payload(), null, refusal);
            }
            target.put("mergeInto", Map.of("id", into.id(), "title", into.title()));
        }
        String cap = capBefore(s, call.agentId(), call.runId());
        Outcome outcome = addOutcome(run.untrusted(), add.source().kind());
        return new Look(ToolRisk.WRITE, "agent", target, add.payload(), null, cap,
                outcome == Outcome.AUTO ? GROUP : null);
    }

    private Look lookUpdate(TodoStore s, HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
        Map<String, Object> payload = updatePayload(s, call.args());
        String id = (String) payload.get("id");
        TodoStore.Facts item = facts(s, id);
        Map<String, Object> target = target(id, item);
        String refusal = itemRefusal(item);
        if (refusal == null && item.rev() != ((Number) payload.get("rev")).longValue()) {
            refusal = "stale";
        }
        if (refusal != null) {
            return new Look(ToolRisk.WRITE, "agent", target, payload, null, refusal);
        }
        Outcome outcome = updateOutcome(run.untrusted(), run.attended(), own(item, call));
        Map<String, Object> before = new LinkedHashMap<>();
        before.put("title", item.title());
        return new Look(ToolRisk.WRITE, "agent", target, payload, before,
                outcome == Outcome.NOT_YOURS ? "not_yours" : null, outcome == Outcome.AUTO ? GROUP : null);
    }

    private Look lookClose(TodoStore s, HostedCall call, RunLedger.Run run) throws ToolFailure {
        Map<String, Object> payload = closePayload(call.args());
        String id = (String) payload.get("id");
        TodoStore.Facts item = facts(s, id);
        Map<String, Object> target = target(id, item);
        String refusal = itemRefusal(item);
        if (refusal != null) {
            return new Look(ToolRisk.WRITE, "agent", target, payload, null, refusal);
        }
        Outcome outcome = closeOutcome(run.untrusted(), run.attended(), own(item, call),
                call.runId().equals(item.runId()) && own(item, call));
        if (!call.look()) {
            decided.put(new Same(call), outcome);
        }
        if (outcome == Outcome.SUGGEST) {
            // A suggestion is the agent's own note on the item for the member's tap: it stays at the floor, own.
            return new Look(ToolRisk.OWN, "agent", target, payload, null, null);
        }
        Map<String, Object> before = new LinkedHashMap<>();
        before.put("title", item.title());
        return new Look(ToolRisk.WRITE, "agent", target, payload, before, null, outcome == Outcome.AUTO ? GROUP : null);
    }

    // ---------------------------------------------------------------- run

    @Override
    public Result run(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
        TodoStore s = need();
        try {
            return switch (call.tool()) {
                case "todo_list" -> list(s, call, run);
                case "todo_get" -> get(s, call);
                case "todo_add" -> runAdd(s, call, run);
                case "todo_update" -> runUpdate(s, call, run);
                case "todo_close" -> runClose(s, call, run);
                default -> throw ToolFailure.notFound("tool");
            };
        } catch (TodoStore.Refused r) {
            throw refused(r);
        } catch (SQLException e) {
            log.warn("a to-do tool's store failed: {}", e.getClass().getSimpleName());
            throw ToolFailure.unavailable("store");
        }
    }

    private Result list(TodoStore s, HostedCall call, RunLedger.Run run) throws SQLException, TodoStore.Refused,
            ToolFailure {
        Map<String, Object> p = listPayload(call.args());
        String view = (String) p.getOrDefault("view", "open");
        String by = (String) p.get("by");
        if ("me".equals(by)) {
            by = "agent:" + call.agentId();
        }
        int limit = p.get("limit") instanceof Number n ? n.intValue() : LIST_DEFAULT;
        Map<String, Object> page = s.list(new TodoStore.ListQuery(view, by, (String) p.get("source"), (String) p.get("q"),
                (String) p.get("due_before"), (String) p.get("cursor"), limit));
        List<Object> items = new ArrayList<>();
        boolean untrusted = false;
        if (page.get("items") instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> item) {
                    items.add(brief(item));
                    untrusted |= Boolean.TRUE.equals(item.get("untrusted"));
                }
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", items);
        if (page.get("next") != null) {
            out.put("next", page.get("next"));
        }
        if (page.get("more") instanceof Number more && more.longValue() > 0) {
            out.put("more", more);
        }
        out.put("today", page.get("today"));
        return new Result(out, untrusted ? Set.of("U") : Set.of(), Map.of("target", Map.of("kind", "todos")));
    }

    private Result get(TodoStore s, HostedCall call) throws SQLException, ToolFailure {
        String id = id(call.args());
        Map<String, Object> got = s.get(id, GET_EVENTS);
        if (got == null) {
            throw ToolFailure.notFound("not_found");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> item = (Map<String, Object>) got.get("item");
        Map<String, Object> out = new LinkedHashMap<>(brief(item));
        out.put("note", item.get("note"));
        out.put("snoozed", item.get("snoozedUntil") != null);
        out.put("alsoFrom", labels(item.get("alsoFrom")));
        out.put("createdAt", item.get("createdAt"));
        List<Object> events = new ArrayList<>();
        if (got.get("events") instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> e) {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("op", e.get("op"));
                    m.put("at", e.get("at"));
                    m.put("by", e.get("actor"));
                    events.add(m);
                }
            }
        }
        out.put("events", events);
        boolean untrusted = Boolean.TRUE.equals(item.get("untrusted"));
        return new Result(out, untrusted ? Set.of("U") : Set.of(), Map.of("target", target(id, item.get("title"))));
    }

    private Result runAdd(TodoStore s, HostedCall call, RunLedger.Run run) throws SQLException, TodoStore.Refused,
            ToolFailure {
        Add add;
        try {
            add = add(s, call.args(), run);
        } catch (Refusal r) {
            throw ToolFailure.forbidden(r.word);
        }
        onceUnasked(s, call);
        String key = key(call);
        TodoStore.AddResult result = s.agentAdd(new TodoStore.AgentAdd(call.agentId(), call.runId(), key, add.title(),
                add.note(), add.due(), add.source(), run.untrusted(), add.sameAs()));
        Map<String, Object> out = new LinkedHashMap<>(result.wire());
        out.put("rev", result.rev());
        if (!result.created()) {
            out.put("note", result.merged()
                    ? "Merged into a to-do already on the list; its new source is kept with it."
                    : "Already on the list: nothing was added.");
        }
        return new Result(out, Set.of(), Map.of("target", target(result.id(), result.title())));
    }

    private Result runUpdate(TodoStore s, HostedCall call, RunLedger.Run run) throws SQLException, TodoStore.Refused,
            ToolFailure {
        Map<String, Object> p = updatePayload(s, call.args());
        Map<String, Object> changes = new LinkedHashMap<>(p);
        changes.remove("id");
        changes.remove("rev");
        onceUnasked(s, call);
        TodoStore.Facts item = s.agentUpdate(call.agentId(), call.runId(), key(call), (String) p.get("id"),
                ((Number) p.get("rev")).longValue(), changes, run.untrusted());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", item.id());
        out.put("rev", item.rev());
        return new Result(out, Set.of(), Map.of("target", target(item.id(), item.title())));
    }

    private Result runClose(TodoStore s, HostedCall call, RunLedger.Run run) throws SQLException, TodoStore.Refused,
            ToolFailure {
        Map<String, Object> p = closePayload(call.args());
        String id = (String) p.get("id");
        TodoStore.Facts item = facts(s, id);
        String refusal = itemRefusal(item);
        if (refusal != null) {
            throw ToolFailure.forbidden(refusal);
        }
        // What the look in this same call decided, which ToolHost checked the ticket or the switch against; with none, a
        // suggestion, which needs neither.
        Outcome outcome = decided.remove(new Same(call));
        if (outcome == null) {
            outcome = Outcome.SUGGEST;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        if (outcome == Outcome.SUGGEST) {
            TodoStore.Facts after = s.agentSuggest(call.agentId(), call.runId(), id, (String) p.get("as"),
                    (String) p.get("reason"), run.untrusted());
            out.put("result", "suggested");
            out.put("note", "Nothing was closed: the member sees \"Looks done?\" on it and decides.");
            return new Result(out, Set.of(), Map.of("target", target(id, after.title())));
        }
        // A close runs only as deskd's tool host let it: the member's redeemed approval, or its own check of the switch.
        if (call.approval() == null && call.autoApprovalId() == null) {
            throw ToolFailure.forbidden("approval_required");
        }
        onceUnasked(s, call);
        TodoStore.Facts after = s.agentClose(call.agentId(), call.runId(), key(call), id, (String) p.get("as"));
        out.put("result", "closed");
        return new Result(out, Set.of(), Map.of("target", target(id, after.title())));
    }

    /**
     * The member's undo of a call done without asking (W3's {@code agent.approval.undo}, from deskd's own ledger): what
     * that call did to the To-do, by its approval id, put back; one that changed nothing is {@code not_done}. Nothing
     * runs unasked on a Guild Desk, so the caller is the owner. It's To-do's only undo by approval id, and it takes back
     * only the events of the agent deskd's ledger says made the call (an add closed as not needed, a merge's source taken
     * out, an edit or a close undone).
     */
    @Override
    public Map<String, Object> undoAuto(com.minimalistalliance.desk.deskd.rpc.Caller caller, AutoLedger.Entry entry)
            throws ToolFailure {
        TodoStore s = need();
        if (entry.agentId().isBlank()) {
            // The store never undoes without an agent; a ledger row with none took back nothing.
            throw ToolFailure.refused("not_done");
        }
        Map<String, Object> undone;
        try {
            undone = s.undoByApproval(AUTO_KEY + entry.id(), "agent:" + entry.agentId());
        } catch (TodoStore.Refused r) {
            throw refused(r);
        } catch (SQLException e) {
            throw ToolFailure.unavailable("store");
        }
        if (undone == null) {
            throw ToolFailure.refused("not_done");
        }
        return undone;
    }

    // ---------------------------------------------------------------- arguments

    /** A word for the model, from a check before anything is done. */
    private static final class Refusal extends Exception {
        private static final long serialVersionUID = 1L;
        final String word;

        Refusal(String word) {
            super(word, null, false, false);
            this.word = word;
        }
    }

    /** The add's arguments checked, and its source found in deskd's record of this run. */
    private Add add(TodoStore s, Map<String, Object> args, RunLedger.Run run) throws ToolFailure, Refusal {
        only(args, Set.of("title", "note", "due", "source", "same_as"));
        String title = args.get("title") instanceof String t ? TodoText.title(t) : null;
        if (title == null) {
            throw ToolFailure.badArgs("title");
        }
        String note;
        try {
            note = args.get("note") == null ? null : args.get("note") instanceof String n ? TodoText.note(n) : bad("note");
        } catch (IllegalArgumentException e) {
            throw ToolFailure.badArgs("note");
        }
        Map<String, Object> due = due(s, args.get("due"));
        if (!(args.get("source") instanceof Map<?, ?> rawSource) || !(rawSource.get("kind") instanceof String kind)
                || !AGENT_KINDS.contains(kind) || !(rawSource.get("ref") instanceof Map<?, ?> rawRef)) {
            throw ToolFailure.badArgs("source");
        }
        for (Object k : rawSource.keySet()) {
            if (!"kind".equals(k) && !"ref".equals(k)) {
                throw ToolFailure.badArgs("source");
            }
        }
        Map<String, Object> ref = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : rawRef.entrySet()) {
            if (!(e.getKey() instanceof String k) || !(e.getValue() instanceof String v) || v.length() > 2048) {
                throw ToolFailure.badArgs("source");
            }
            ref.put(k, v);
        }
        String sameAs = null;
        if (args.get("same_as") != null) {
            if (!(args.get("same_as") instanceof String id) || !ID.matcher(id).matches()) {
                throw ToolFailure.badArgs("same_as");
            }
            sameAs = id;
        }
        TodoStore.Source source = source(kind, ref, run);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("title", title);
        if (note != null) {
            payload.put("note", note);
        }
        if (due != null) {
            payload.put("due", due);
        }
        payload.put("source", Map.of("kind", kind, "ref", source.ref()));
        if (sameAs != null) {
            payload.put("same_as", sameAs);
        }
        TodoStore.Due d = due == null ? null : new TodoStore.Due((String) due.get("date"), (String) due.get("time"), null);
        return new Add(payload, title, note, d, source, sameAs);
    }

    /**
     * The source as deskd recorded it for this run: a ref a tool deskd hosts gave the run, or the member's message that
     * started it. Its ref and label are deskd's own; the model's ref only names it.
     */
    static TodoStore.Source source(String kind, Map<String, Object> ref, RunLedger.Run run) throws Refusal {
        if ("agent_chat".equals(kind)) {
            // The member's message that started this run, by deskd's record of the send it relayed. The model needn't
            // know its id: an empty ref means that message, and a ref naming another is refused.
            String started = run.startedBy();
            Object named = ref.get("messageId");
            Object agent = ref.get("agentId");
            if (started == null || (named != null && !started.equals(named))
                    || (agent != null && !run.agentId().equals(agent))) {
                throw new Refusal("source_unknown");
            }
            String messageId = started;
            Map<String, Object> clean = new LinkedHashMap<>();
            clean.put("agentId", run.agentId());
            clean.put("threadId", run.agentId());
            clean.put("messageId", messageId);
            return new TodoStore.Source("agent_chat", clean, "Your message to the agent", "agent_chat:" + run.agentId());
        }
        String key = Provenance.key(kind, ref);
        RunLedger.Given given = key == null ? null : run.given(key);
        if (given == null && "desk".equals(kind) && ref.isEmpty()) {
            // A message from another of the member's desks: the model never sees its id, so {} names the last one deskd
            // gave this run (the message that started it, or an answer its waiting desk_message took).
            given = run.latest("desk");
        }
        if (given == null) {
            throw new Refusal("source_unknown");
        }
        return new TodoStore.Source(kind, given.ref(), given.label(), given.threadKey());
    }

    /** {@code due: {date, time?}}: a real day, not more than a day past or 400 days ahead in the member's zone. */
    private static Map<String, Object> due(TodoStore s, Object raw) throws ToolFailure {
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof Map<?, ?> due) || !(due.get("date") instanceof String date)) {
            throw invalid("due");
        }
        for (Object k : due.keySet()) {
            if (!"date".equals(k) && !"time".equals(k)) {
                throw invalid("due");
            }
        }
        LocalDate day;
        try {
            day = LocalDate.parse(date);
        } catch (DateTimeParseException e) {
            throw invalid("due");
        }
        LocalDate today = s.today();
        if (day.isBefore(today.minusDays(1)) || day.isAfter(today.plusDays(400)) || !date.equals(day.toString())) {
            throw invalid("due");
        }
        String time = null;
        if (due.get("time") != null) {
            if (!(due.get("time") instanceof String t) || !t.matches("\\d{2}:\\d{2}")) {
                throw invalid("due");
            }
            try {
                LocalTime.parse(t);
            } catch (DateTimeParseException e) {
                throw invalid("due");
            }
            time = t;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("date", date);
        if (time != null) {
            out.put("time", time);
        }
        return out;
    }

    private static Map<String, Object> listPayload(Map<String, Object> args) throws ToolFailure {
        only(args, Set.of("view", "by", "source", "due_before", "q", "limit", "cursor"));
        Map<String, Object> out = new LinkedHashMap<>();
        if (args.get("view") != null) {
            if (!(args.get("view") instanceof String v) || !Set.of("needs_you", "open", "done").contains(v)) {
                throw ToolFailure.badArgs("view");
            }
            out.put("view", v);
        }
        if (args.get("by") != null) {
            if (!(args.get("by") instanceof String b) || !(b.equals("me") || b.equals("member") || AGENT.matcher(b).matches())) {
                throw ToolFailure.badArgs("by");
            }
            out.put("by", b);
        }
        if (args.get("source") != null) {
            if (!(args.get("source") instanceof String k) || !TodoStore.SOURCE_KINDS.contains(k)) {
                throw ToolFailure.badArgs("source");
            }
            out.put("source", k);
        }
        if (args.get("due_before") != null) {
            if (!(args.get("due_before") instanceof String d)) {
                throw ToolFailure.badArgs("due_before");
            }
            try {
                if (!d.equals(LocalDate.parse(d).toString())) {
                    throw ToolFailure.badArgs("due_before");
                }
            } catch (DateTimeParseException e) {
                throw ToolFailure.badArgs("due_before");
            }
            out.put("due_before", d);
        }
        if (args.get("q") != null) {
            if (!(args.get("q") instanceof String q) || q.length() > Q_MAX) {
                throw ToolFailure.badArgs("q");
            }
            out.put("q", q);
        }
        if (args.get("limit") != null) {
            if (!(args.get("limit") instanceof Number n) || n.doubleValue() != n.intValue() || n.intValue() < 1
                    || n.intValue() > LIST_MAX) {
                throw ToolFailure.badArgs("limit");
            }
            out.put("limit", n.intValue());
        }
        if (args.get("cursor") != null) {
            if (!(args.get("cursor") instanceof String c) || !c.matches("\\d{1,7}")) {
                throw ToolFailure.badArgs("cursor");
            }
            out.put("cursor", c);
        }
        return out;
    }

    private static Map<String, Object> updatePayload(TodoStore s, Map<String, Object> args) throws ToolFailure {
        only(args, Set.of("id", "rev", "title", "note", "due"));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id(args));
        if (!(args.get("rev") instanceof Number rev) || rev.doubleValue() != rev.longValue() || rev.longValue() < 0) {
            throw ToolFailure.badArgs("rev");
        }
        out.put("rev", rev.longValue());
        if (args.containsKey("title")) {
            String title = args.get("title") instanceof String t ? TodoText.title(t) : null;
            if (title == null) {
                throw ToolFailure.badArgs("title");
            }
            out.put("title", title);
        }
        if (args.containsKey("note")) {
            try {
                out.put("note", args.get("note") == null ? null : args.get("note") instanceof String n ? TodoText.note(n)
                        : bad("note"));
            } catch (IllegalArgumentException e) {
                throw ToolFailure.badArgs("note");
            }
        }
        if (args.containsKey("due")) {
            out.put("due", due(s, args.get("due")));
        }
        if (out.size() == 2) {
            throw ToolFailure.badArgs("nothing");
        }
        return out;
    }

    private static Map<String, Object> closePayload(Map<String, Object> args) throws ToolFailure {
        only(args, Set.of("id", "as", "reason"));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id(args));
        if (!(args.get("as") instanceof String as) || !Set.of("done", "not_needed").contains(as)) {
            throw ToolFailure.badArgs("as");
        }
        out.put("as", as);
        if (!(args.get("reason") instanceof String reason)) {
            throw ToolFailure.badArgs("reason");
        }
        String clean = TodoText.reason(reason);
        if (clean.isEmpty() || reason.codePointCount(0, reason.length()) > TodoText.REASON_MAX) {
            throw ToolFailure.badArgs("reason");
        }
        out.put("reason", clean);
        return out;
    }

    private static String id(Map<String, Object> args) throws ToolFailure {
        if (!(args.get("id") instanceof String id) || !ID.matcher(id).matches()) {
            throw ToolFailure.badArgs("id");
        }
        return id;
    }

    private static void only(Map<String, Object> args, Set<String> keys) throws ToolFailure {
        for (String k : args.keySet()) {
            if (!keys.contains(k)) {
                throw ToolFailure.badArgs("input");
            }
        }
    }

    private static <T> T bad(String field) {
        throw new IllegalArgumentException(field);
    }

    private static ToolFailure invalid(String field) {
        return new ToolFailure(com.minimalistalliance.desk.deskd.rpc.RpcException.FORBIDDEN, "invalid",
                Map.of("field", field));
    }

    // ---------------------------------------------------------------- helpers

    private TodoStore need() throws ToolFailure {
        TodoStore s = store.get();
        if (s == null) {
            throw ToolFailure.unavailable("todo");
        }
        return s;
    }

    private static TodoStore.Facts facts(TodoStore s, String id) throws ToolFailure {
        try {
            return s.facts(id);
        } catch (SQLException e) {
            throw ToolFailure.unavailable("store");
        }
    }

    /** A cap an add would meet, checked before anyone is asked; the store checks again in the add's own transaction. */
    private static String capBefore(TodoStore s, String agentId, String runId) {
        try {
            return s.capFor(agentId, runId) == null ? null : "cap";
        } catch (SQLException e) {
            return null;
        }
    }

    private static String itemRefusal(TodoStore.Facts item) {
        if (item == null) {
            return "not_found";
        }
        if (item.trashed()) {
            return "trashed";
        }
        return "open".equals(item.state()) ? null : "closed";
    }

    private static boolean own(TodoStore.Facts item, HostedCall call) {
        return item != null && ("agent:" + call.agentId()).equals(item.by());
    }

    /**
     * The key the store does a write once under: the member's approval id, or {@code auto:<id>} for a call done without
     * asking, a space no member's approval can use, so an unasked call can't take an approved card's place, nor its undo
     * the card's change (Security's AAB-L2, as AAW-L2 for the Notebook).
     */
    private static String key(HostedCall call) {
        String key = call.approval() != null ? call.approval().approvalId()
                : call.autoApprovalId() != null ? AUTO_KEY + call.autoApprovalId() : null;
        return key != null && REF_ID.matcher(key).matches() ? key : null;
    }

    /** The prefix of an unasked call's key. */
    static final String AUTO_KEY = "auto:";

    /**
     * An unasked call runs once under its own key: one the store has seen is {@code approval_used}, never "already on
     * the list" (deskd's ledger refuses an id again before this; this holds if the ledger lost one).
     */
    private static void onceUnasked(TodoStore s, HostedCall call) throws ToolFailure {
        String key = key(call);
        if (call.approval() == null && key != null && key.startsWith(AUTO_KEY)) {
            try {
                if (s.keyUsed(key)) {
                    throw ToolFailure.forbidden("approval_used");
                }
            } catch (SQLException e) {
                throw ToolFailure.unavailable("store");
            }
        }
    }

    private static Map<String, Object> target(String id, Object title) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("kind", "todo");
        t.put("id", id);
        t.put("title", title instanceof String s ? s : "");
        return t;
    }

    private static Map<String, Object> target(String id, TodoStore.Facts item) {
        return target(id, item == null ? "" : item.title());
    }

    /** VISION §4's list item: no notes, the source as its kind and label. */
    private static Map<String, Object> brief(Map<?, ?> item) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", item.get("id"));
        m.put("rev", item.get("rev"));
        m.put("title", item.get("title"));
        m.put("due", item.get("due"));
        m.put("state", item.get("state"));
        m.put("by", item.get("by"));
        if (item.get("source") instanceof Map<?, ?> source) {
            m.put("source", Map.of("kind", source.get("kind"), "label", source.get("label") == null ? ""
                    : source.get("label")));
        }
        m.put("untrusted", item.get("untrusted"));
        if (item.get("suggestion") != null) {
            m.put("suggestion", item.get("suggestion"));
        }
        return m;
    }

    private static List<Object> labels(Object alsoFrom) {
        List<Object> out = new ArrayList<>();
        if (alsoFrom instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m) {
                    out.add(Map.of("kind", m.get("kind"), "label", m.get("label") == null ? "" : m.get("label")));
                }
            }
        }
        return out;
    }

    private static ToolFailure refused(TodoStore.Refused r) {
        String word = switch (r.reason()) {
            case "not_found", "closed", "trashed", "stale", "cap", "changed" -> r.reason();
            case "rev" -> "stale";
            default -> "invalid";
        };
        Map<String, Object> extra = new LinkedHashMap<>();
        if (r.details().get("which") != null) {
            extra.put("which", r.details().get("which"));
            extra.put("limit", r.details().get("limit"));
        }
        return new ToolFailure(com.minimalistalliance.desk.deskd.rpc.RpcException.FORBIDDEN, word, extra);
    }
}
