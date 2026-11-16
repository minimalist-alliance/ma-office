package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.memory.Memories;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.MessageRow;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Use case A, notes from conversation (the concept's §5; deskd {@code API.md} §23, "Notes").
 *
 * <ol>
 *   <li><b>Take.</b> After each message the member sends her, a note-taker model call reads <b>only the member's own
 *       recent messages</b> in her thread: never her replies, agents' answers, tool results, files or anything another
 *       desk wrote. So it never holds untrusted content, and text a desk planted can't become a note this way. It
 *       returns at most 5 notes; code checks each and drops anything shaped like a secret ({@link Memories#cleanNote}).
 *   <li><b>Route.</b> {@code work} and {@code personal} by the taker, under the member's own word rules, which code
 *       applies over it; {@code unsure} is held on the home desk.
 *   <li><b>File, in code.</b> Each area's notes of a turn go on that day's page for the area in the member's "From
 *       Maia" tab, as one {@code notebook_write} by Maia's code in a clean run of its own that read nothing, done
 *       without asking under her access's Notebook switch for that tab. Nothing here ever puts a card in front of the
 *       member: a call that would ask isn't made. The approval row is the note's record and its Undo.
 *   <li><b>Confirm.</b> A chip under her reply, "Noted for Work · Undo".
 *   <li><b>Unsure.</b> Held until the conversation goes quiet (10 minutes), then one question in her thread, written
 *       by code, with choices: "Work", "Personal", "Don't keep".
 * </ol>
 */
public final class Notes implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(Notes.class);

    static final int MAX_NOTES = 5;
    static final int MAX_TEXT = 280;
    /** The member's messages the taker reads: the newest, and a few before it for context. */
    static final int READS = 6;
    /** The conversation is quiet after this long: held notes are asked about once. */
    static final long QUIET = 10 * Attention.MINUTE;
    /** Held notes not answered in this long are dropped. */
    static final long HELD_FOR = 7L * 24 * 60 * Attention.MINUTE;
    static final Set<String> AREAS = Set.of("work", "personal", "unsure");
    static final Set<String> KINDS = Set.of("fact", "decision", "reminder", "idea");

    static final String TAKER = """
            You take notes for a person from what they say to their assistant. You get their own recent messages as \
            JSON, oldest first; take notes only from the last one, using the others for context. A note is something \
            worth keeping for them later: a fact about their life or work, a decision they made, a reminder, or an \
            idea. Most messages have none: questions, small talk and requests to do something are not notes.
            Each note is one plain sentence in their words, at most 280 characters. Never copy a password, code, PIN, \
            card or account number, or key: leave that note out. Say whether it belongs to their work or their \
            personal life; if you can't tell, say unsure.
            Answer with JSON only, no other text: {"notes": [{"text": "...", "area": "work|personal|unsure", \
            "kind": "fact|decision|reminder|idea", "due": "YYYY-MM-DD or null"}]}, at most 5 notes, or {"notes": []}.""";

    private final MaiaMode maia;
    private final CodeCalls calls;
    /** Her thread's newest messages, at most this many, oldest first. */
    private final Function<Integer, List<MessageRow>> thread;
    /** Posts a message of hers written by code, with these extras; @return its id. */
    private final Poster poster;
    private final ExecutorService work = Executors.newSingleThreadExecutor(Thread.ofVirtual().name("maia-notes")
            .factory());
    private final ScheduledExecutorService quiet = Executors.newSingleThreadScheduledExecutor(
            Thread.ofVirtual().name("maia-notes-quiet").factory());
    private ScheduledFuture<?> asking;
    private final Object lock = new Object();

    /** Writes one message of hers that code wrote (the "could go either way" question). */
    @FunctionalInterface
    public interface Poster {
        String post(String text, Map<String, Object> extras) throws SQLException;
    }

    public Notes(MaiaMode maia, CodeCalls calls, Function<Integer, List<MessageRow>> thread, Poster poster) {
        this.maia = maia;
        this.calls = calls;
        this.thread = thread;
        this.poster = poster;
    }

    /** The member sent her a message: take notes from it, in the background. Its reply gets the chips. */
    public void after(String replyId) {
        if (!maia.active()) {
            return;
        }
        work.execute(() -> {
            try {
                take(replyId);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (SQLException | RuntimeException e) {
                log.warn("notes weren't taken: {}", e.getClass().getSimpleName());
            }
        });
        scheduleQuiet();
    }

    /** Waits for the notes of messages sent so far: tests. */
    public void drain() throws InterruptedException {
        java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        work.execute(done::countDown);
        done.await(30, TimeUnit.SECONDS);
    }

    // ---------------------------------------------------------------- take

    /** One note as the taker gave it and code checked it. */
    record Taken(String text, String area, String kind, String due) {}

    /** The label the member tapped on this reply of hers, or null. */
    private String tapped(String messageId) {
        Map<String, Object> extras = maia.extras(messageId);
        if (extras == null || !(extras.get("choices") instanceof Map<?, ?> c) || !"answered".equals(c.get("state"))
                || !(c.get("answer") instanceof String answer) || !(c.get("options") instanceof List<?> options)) {
            return null;
        }
        for (Object o : options) {
            if (o instanceof Map<?, ?> option && answer.equals(option.get("id")) && option.get("label") instanceof String l) {
                return l;
            }
        }
        return null;
    }

    void take(String replyId) throws InterruptedException, SQLException {
        if (!maia.active()) {
            // Off since this was queued (the switch, or the member): nothing is taken (DMA-I4).
            return;
        }
        List<String> said = memberMessages();
        if (said.isEmpty()) {
            return;
        }
        String user = new String(Json.bytes(Map.of("messages", said)), StandardCharsets.UTF_8);
        String answer = calls.complete(MaiaAgent.ID, "notes", TAKER, user, 600);
        if (answer == null) {
            return;
        }
        List<Taken> notes = parse(answer, maia.today());
        if (notes.isEmpty()) {
            return;
        }
        Map<String, List<Taken>> byArea = new LinkedHashMap<>();
        for (Taken n : notes) {
            String area = routed(n);
            if (!maia.store().take(maia.today(), "note", "all", maia.notesPerDay())) {
                // Past the day's cap: no more notes today, quietly.
                break;
            }
            byArea.computeIfAbsent(area, k -> new ArrayList<>()).add(new Taken(n.text(), area, n.kind(), n.due()));
        }
        for (Map.Entry<String, List<Taken>> e : byArea.entrySet()) {
            if ("unsure".equals(e.getKey())) {
                hold(replyId, e.getValue());
            } else {
                fileNow(replyId, e.getKey(), e.getValue());
            }
        }
        maia.room().rebuild();
    }

    /**
     * The member's own messages in her thread, newest last: role {@code user} with no origin, never anything else. A
     * tapped choice is left out too: its words are hers, which she may have taken from what she read (DMA-I3).
     */
    List<String> memberMessages() {
        List<String> out = new ArrayList<>();
        String tappedLabel = null;
        for (MessageRow row : thread.apply(40)) {
            if ("assistant".equals(row.role())) {
                tappedLabel = tapped(row.id());
                continue;
            }
            if ("user".equals(row.role()) && row.origin() == null && row.text() != null && !row.text().isBlank()
                    && !row.text().equals(tappedLabel)) {
                out.add(row.text().length() > 4000 ? row.text().substring(0, 4000) : row.text());
            }
            tappedLabel = null;
        }
        return out.size() > READS ? out.subList(out.size() - READS, out.size()) : out;
    }

    /** The taker's answer, checked: JSON only, at most 5, each field in its set, secrets dropped. */
    static List<Taken> parse(String answer, String today) {
        String json = answer.strip();
        int start = json.indexOf('{');
        int end = json.lastIndexOf('}');
        if (start < 0 || end < start) {
            return List.of();
        }
        Map<String, Object> m;
        try {
            m = Json.parseObject(json.substring(start, end + 1).getBytes(StandardCharsets.UTF_8));
        } catch (com.minimalistalliance.desk.agent.json.JsonFormatException | RuntimeException e) {
            return List.of();
        }
        if (!(m.get("notes") instanceof List<?> list)) {
            return List.of();
        }
        List<Taken> out = new ArrayList<>();
        for (Object o : list) {
            if (out.size() == MAX_NOTES) {
                break;
            }
            if (!(o instanceof Map<?, ?> n)) {
                continue;
            }
            String text = Memories.cleanNote(n.get("text"), MAX_TEXT);
            if (text == null) {
                continue;
            }
            String area = n.get("area") instanceof String a && AREAS.contains(a) ? a : "unsure";
            String kind = n.get("kind") instanceof String k && KINDS.contains(k) ? k : "fact";
            String due = null;
            if (n.get("due") instanceof String d) {
                try {
                    LocalDate date = LocalDate.parse(d);
                    LocalDate from = LocalDate.parse(today);
                    if (!date.isBefore(from.minusDays(1)) && date.isBefore(from.plusYears(5))) {
                        due = date.toString();
                    }
                } catch (RuntimeException e) {
                    due = null;
                }
            }
            out.add(new Taken(text, area, kind, due));
        }
        return out;
    }

    /** The member's own word rules ({@code noteRules}), over the taker's area: code, not the model. */
    String routed(Taken n) {
        Object rules = maia.mode().get("noteRules");
        if (rules instanceof List<?> list) {
            String text = n.text().toLowerCase(Locale.ROOT);
            for (Object o : list) {
                if (o instanceof Map<?, ?> r && r.get("word") instanceof String w && r.get("area") instanceof String a
                        && !w.isBlank() && java.util.regex.Pattern.compile("\\b" + java.util.regex.Pattern.quote(
                                w.toLowerCase(Locale.ROOT)) + "\\b").matcher(text).find()) {
                    return a;
                }
            }
        }
        return n.area();
    }

    // ---------------------------------------------------------------- file

    /** Files one area's notes of a turn now, in code: one write, one approval row, one chip. */
    void fileNow(String replyId, String area, List<Taken> notes) throws InterruptedException, SQLException {
        if (!maia.active()) {
            return;
        }
        String day = maia.today();
        long now = maia.clock().millis();
        List<MaiaStore.Note> rows = new ArrayList<>();
        for (Taken n : notes) {
            MaiaStore.Note row = new MaiaStore.Note(MaiaMode.newId("mn"), day, area, n.kind(), "pending", n.text(),
                    n.due(), null, null, replyId, now);
            maia.store().putNote(row);
            rows.add(row);
        }
        chip(replyId, area, rows.get(0).id(), "pending", null);
        Filed filed = file(day, area, rows);
        for (MaiaStore.Note row : rows) {
            maia.store().putNote(new MaiaStore.Note(row.id(), day, area, row.kind(), filed.ok() ? "filed" : "failed",
                    filed.ok() ? null : row.text(), row.due(), filed.approvalId(), filed.pageId(), replyId, row.at()));
            if (filed.ok()) {
                maia.audit("agent:maia", "maia.note", "note:" + row.id() + " area:" + area + " ap:" + filed.approvalId(),
                        "ok");
            } else {
                maia.audit("agent:maia", "maia.note", "note:" + row.id() + " area:" + area, "refused:" + filed.why());
            }
        }
        chip(replyId, area, rows.get(0).id(), filed.ok() ? "filed" : "failed", filed.approvalId());
    }

    record Filed(boolean ok, String approvalId, String pageId, String why) {}

    /** The write itself: append to the day's page for the area, or create it, in a clean run that read nothing. */
    Filed file(String day, String area, List<MaiaStore.Note> rows) throws InterruptedException, SQLException {
        String tab = maia.notesTabId();
        if (tab == null) {
            return new Filed(false, null, null, "no_tab");
        }
        StringBuilder md = new StringBuilder();
        for (MaiaStore.Note n : rows) {
            md.append("- ").append(markdownSafe(n.text()));
            if (n.due() != null) {
                md.append(" (by ").append(LocalDate.parse(n.due()).format(DateTimeFormatter.ofPattern("EEE MMM d",
                        Locale.ENGLISH))).append(')');
            }
            md.append('\n');
        }
        String runId = "mnr-" + MaiaMode.newId("r").substring(2);
        Map<String, Object> origin = Map.of("kind", "maia_notes");
        String replyId = rows.get(0).messageId();
        try {
            String pageId = maia.store().page(day, area);
            CodeCalls.Result r = null;
            if (pageId != null) {
                Map<String, Object> input = new LinkedHashMap<>();
                input.put("pageId", pageId);
                input.put("op", "append");
                input.put("markdown", md.toString());
                r = calls.call(MaiaAgent.ID, runId, origin, replyId, Set.of(), "notebook_write", input);
                if (!r.ok()) {
                    // The page went (trashed, moved out of the tab, edited away): a new page for the day.
                    maia.store().forgetPage(day, area);
                    pageId = null;
                }
            }
            if (pageId == null) {
                Map<String, Object> made = new LinkedHashMap<>();
                made.put("tabId", tab);
                made.put("title", title(area, day));
                Map<String, Object> input = new LinkedHashMap<>();
                input.put("new", made);
                input.put("op", "create");
                input.put("markdown", md.toString());
                r = calls.call(MaiaAgent.ID, runId, origin, replyId, Set.of(), "notebook_write", input);
                if (r.ok() && pageIdOf(r.content()) instanceof String id) {
                    maia.store().putPage(day, area, id);
                    pageId = id;
                }
            }
            return r.ok() ? new Filed(true, r.approvalId(), pageId, null) : new Filed(false, null, null, r.refusal());
        } finally {
            calls.ended(MaiaAgent.ID, runId, true);
        }
    }

    /** "Work · Sat Nov 14": the day's page for an area. */
    static String title(String area, String day) {
        LocalDate d = LocalDate.parse(day);
        return ("work".equals(area) ? "Work" : "Personal") + " · "
                + d.format(DateTimeFormatter.ofPattern("EEE MMM d", Locale.ENGLISH));
    }

    /** A note as one Markdown list line: what would make it a heading, a link or a block is escaped. */
    static String markdownSafe(String text) {
        String one = text.replaceAll("\\s+", " ").strip();
        StringBuilder out = new StringBuilder();
        for (char c : one.toCharArray()) {
            if ("\\`*_[]<>#|!".indexOf(c) >= 0) {
                out.append('\\');
            }
            out.append(c);
        }
        return out.toString();
    }

    static Object pageIdOf(Object content) {
        Map<String, Object> m = CodeResults.object(content);
        return m == null ? null : m.get("pageId");
    }

    private void chip(String replyId, String area, String noteId, String state, String approvalId)
            throws SQLException {
        if (replyId == null) {
            return;
        }
        Map<String, Object> chip = new LinkedHashMap<>();
        chip.put("noteId", noteId);
        chip.put("area", area);
        chip.put("state", state);
        chip.put("approvalId", approvalId);
        chip.put("line", switch (state) {
            case "failed" -> "Couldn't save that note";
            case "undone" -> "Note removed";
            default -> switch (area) {
                case "work" -> "Noted for Work";
                case "personal" -> "Noted for Personal";
                default -> "Noted, I'll ask where";
            };
        });
        maia.putNoteChip(replyId, chip);
    }

    // ---------------------------------------------------------------- unsure

    private void hold(String replyId, List<Taken> notes) throws SQLException {
        long now = maia.clock().millis();
        String first = null;
        for (Taken n : notes) {
            String id = MaiaMode.newId("mn");
            first = first == null ? id : first;
            maia.store().putNote(new MaiaStore.Note(id, maia.today(), "unsure", n.kind(), "held", n.text(), n.due(),
                    null, null, replyId, now));
        }
        chip(replyId, "unsure", first, "held", null);
    }

    private void scheduleQuiet() {
        synchronized (lock) {
            if (asking != null) {
                asking.cancel(false);
            }
            if (!quiet.isShutdown()) {
                asking = quiet.schedule(this::askOnce, QUIET, TimeUnit.MILLISECONDS);
            }
        }
    }

    /**
     * The conversation went quiet: held notes not asked about yet get one question, written by code, with choices.
     * Held notes older than 7 days are dropped first.
     */
    public void askOnce() {
        try {
            long now = maia.clock().millis();
            maia.store().sweepNotes(now - HELD_FOR, LocalDate.parse(maia.today()).minusDays(90).toString());
            if (!maia.active()) {
                return;
            }
            List<String> ids = new ArrayList<>();
            for (MaiaStore.Note n : maia.store().notesInState("held")) {
                if (!"asked".equals(n.kind()) && n.messageId() != null) {
                    ids.add(n.id());
                }
            }
            if (ids.isEmpty() || asked(ids)) {
                return;
            }
            String text = ids.size() == 1 ? "A note could go either way. Where should it go?"
                    : ids.size() + " notes could go either way. Where should they go?";
            Map<String, Object> choices = new LinkedHashMap<>();
            choices.put("question", text);
            choices.put("options", List.of(Map.of("id", "work", "label", "Work"), Map.of("id", "personal", "label",
                    "Personal"), Map.of("id", "drop", "label", "Don't keep")));
            choices.put("recommended", "work");
            choices.put("other", false);
            choices.put("state", "open");
            choices.put("answer", null);
            choices.put("kind", "notes");
            choices.put("noteIds", ids);
            Map<String, Object> extras = new LinkedHashMap<>();
            extras.put("choices", choices);
            poster.post(text, extras);
            maia.room().rebuild();
        } catch (SQLException | RuntimeException e) {
            log.warn("held notes weren't asked about: {}", e.getClass().getSimpleName());
        }
    }

    /** Whether these held notes were asked about already (a question naming them is still open). */
    private boolean asked(List<String> ids) throws SQLException {
        String open = maia.store().openChoices();
        if (open == null) {
            return false;
        }
        Map<String, Object> extras = maia.store().extras(open);
        return extras != null && extras.get("choices") instanceof Map<?, ?> c && "notes".equals(c.get("kind"))
                && c.get("noteIds") instanceof List<?> l && l.containsAll(ids);
    }

    /** {@code agent.maia.note.file}: the member's answer for one held note. */
    public Map<String, Object> file(String noteId, String area) throws RpcError, SQLException {
        if (!Set.of("work", "personal", "drop").contains(area)) {
            throw RpcError.badRequest("area");
        }
        MaiaStore.Note n = maia.store().note(noteId);
        if (n == null) {
            throw RpcError.notFound("note");
        }
        if (!"held".equals(n.state())) {
            throw RpcError.of("conflict", "reason", "answered");
        }
        if ("drop".equals(area)) {
            MaiaStore.Note dropped = new MaiaStore.Note(n.id(), n.day(), n.area(), n.kind(), "dropped", null, n.due(),
                    null, null, n.messageId(), n.at());
            maia.store().putNote(dropped);
            maia.audit("user", "maia.note", "note:" + n.id() + " area:drop", "ok");
            maia.room().rebuild();
            return noteView(dropped);
        }
        try {
            Filed filed = file(maia.today(), area, List.of(n));
            MaiaStore.Note after = new MaiaStore.Note(n.id(), n.day(), area, n.kind(), filed.ok() ? "filed" : "held",
                    filed.ok() ? null : n.text(), n.due(), filed.approvalId(), filed.pageId(), n.messageId(), n.at());
            maia.store().putNote(after);
            maia.audit("user", "maia.note", "note:" + n.id() + " area:" + area + (filed.ok() ? " ap:"
                    + filed.approvalId() : ""), filed.ok() ? "ok" : "refused:" + filed.why());
            if (filed.ok() && n.messageId() != null) {
                chip(n.messageId(), area, n.id(), "filed", filed.approvalId());
            }
            maia.room().rebuild();
            if (!filed.ok()) {
                throw RpcError.of("unavailable", "reason", filed.why() == null ? "notes" : filed.why());
            }
            return noteView(after);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw RpcError.of("unavailable", "reason", "stopped");
        }
    }

    /** A note's Undo went through ({@code agent.approval.undo}): its chip and log say so. */
    public void undone(String approvalId) {
        try {
            MaiaStore.Note n = maia.store().noteByApproval(approvalId);
            if (n == null) {
                return;
            }
            for (MaiaStore.Note each : maia.store().notesOfDay(n.day())) {
                if (approvalId.equals(each.approvalId())) {
                    maia.store().putNote(new MaiaStore.Note(each.id(), each.day(), each.area(), each.kind(), "undone",
                            null, each.due(), each.approvalId(), each.pageId(), each.messageId(), each.at()));
                }
            }
            maia.audit("user", "maia.note.undo", "note:" + n.id() + " ap:" + approvalId, "ok");
            if (n.messageId() != null) {
                chip(n.messageId(), n.area(), n.id(), "undone", approvalId);
            }
            maia.room().rebuild();
        } catch (SQLException e) {
            log.warn("a note's undo wasn't recorded: {}", e.getClass().getSimpleName());
        }
    }

    static Map<String, Object> noteView(MaiaStore.Note n) {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("noteId", n.id());
        v.put("area", n.area());
        v.put("kind", n.kind());
        v.put("state", n.state());
        v.put("approvalId", n.approvalId());
        v.put("pageId", n.pageId());
        v.put("at", n.at());
        return v;
    }

    /** The answer to the code's question ({@code agent.maia.choose} on it): every held note it named. */
    public void answer(List<?> noteIds, String area) throws SQLException {
        for (Object id : noteIds) {
            if (id instanceof String noteId) {
                try {
                    file(noteId, area);
                } catch (RpcError e) {
                    log.warn("a held note wasn't filed: {}", e.code());
                }
            }
        }
    }

    static long dayStart(String day, java.time.ZoneId zone) {
        return LocalDate.parse(day).atStartOfDay(zone).toInstant().toEpochMilli();
    }

    static String dayOf(long at, java.time.ZoneId zone) {
        return LocalDate.ofInstant(Instant.ofEpochMilli(at), zone).toString();
    }

    @Override
    public void close() {
        work.shutdownNow();
        quiet.shutdownNow();
    }
}
