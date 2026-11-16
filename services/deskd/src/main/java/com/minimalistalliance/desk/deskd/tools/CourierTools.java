package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.courier.CourierRead;
import com.minimalistalliance.desk.deskd.courier.store.Norm;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Courier's read tools for the desk's agents (the draft ADR "the Agent's tools and approvals", §12; API.md §21, "The
 * agent's Courier tools"): {@code courier_list}, {@code courier_search}, {@code courier_read} and {@code courier_new},
 * over Courier's {@link CourierRead}, which reads only the lanes agents may see (People, Updates and, by the setting,
 * Other; never Requests, Spam or Trash) and gives each sender as Courier's contact record, never a name in the text.
 * There's no send: nothing here writes to Courier but an agent's cursor.
 *
 * <p><b>What the model gets.</b> Every result is {@code U} and {@code S} (the declarations'), and desk-agent fences it
 * behind Courier's label as data. Here, on top of the store's own cleaning at ingest, every string a sender wrote
 * (subjects, names, titles, attachment names, text) is cleaned again of hidden and bidi characters, one line where it's a
 * line (Security's Q6 condition: subjects and attachment names are attacker text). The text is the store's plain text
 * (the sandbox turns HTML into it; deskd never reads a message's HTML), with links as their domain and quoted mail folded
 * ({@code AgentText}); attachments are named, typed and sized, never opened. Times are the member's, ISO 8601.
 *
 * <p><b>Fitting a result.</b> A result reaches the model whole or not at all: the run loop cuts any result at 20,000
 * characters, which would drop the end of a page and, for {@code courier_new}, messages the cursor had passed. So each
 * result is fitted here to {@link #BUDGET} characters as desk-agent's fence carries it (its JSON inside a JSON string):
 * whole rows only, the page's {@code next} moved back to just after the last one kept, and a single message's text cut
 * with {@code textNext} (or {@code textMore}) where even one doesn't fit.
 *
 * <p><b>{@code courier_new}'s cursor</b> (§12): one per agent, in Courier's store, moved only when a run ends
 * {@code done}. A run's place is its own, in RAM: each call gives the messages after the further of the agent's stored
 * cursor and the run's place, oldest first, without bulk mail, and moves the run's place to the last one given; a lost
 * reply asked again by its key gets the same messages, never the next. At {@code run_end} with {@code state: done},
 * desk-agent names the last cursor it received, so a reply it never got (one its key couldn't recover) is never counted
 * as seen; it's stored if this run was given exactly that here, or, when deskd holds no record of the run (it restarted
 * since), if it names a stored message exactly. A run that ends any other way, or a desk-agent restart, stores nothing,
 * and the next run is given the same messages again (To-do's dedupe makes that harmless). An agent with no cursor starts
 * {@link #FIRST_LOOK} back, stored at its first call, so a first run that fails starts the next from the same place.
 *
 * <p>Nothing here logs a subject, a name, an address, text or an id.
 */
public final class CourierTools implements HostedTool {

    private static final Logger log = LoggerFactory.getLogger(CourierTools.class);

    /** The four tools, in the ADR's order. */
    public static final List<String> TOOLS = List.of("courier_list", "courier_search", "courier_read", "courier_new");
    /**
     * The most a result may be as desk-agent's fence carries it, its JSON inside a JSON string: under the run loop's
     * 20,000, with room for the fence's own words and the loop's line before a result.
     */
    public static final int BUDGET = 18_000;
    /**
     * Attachments named a message, and the characters of each name: so one message with no text always fits, whatever
     * its sender put there. The rest are counted ({@code attachmentsMore}).
     */
    static final int ATTACHMENTS_SHOWN = 10;
    static final int ATTACHMENT_NAME = 120;
    /** People named a conversation in {@code courier_list}, and the characters of each: the rest counted. */
    static final int CONTACTS_SHOWN = 10;
    static final int CONTACT_NAME = 80;
    /** {@code courier_new}'s text a message: the rest comes with {@code courier_read} from {@code textNext}. */
    public static final int NEW_TEXT = 2_000;
    /** How far back an agent's first {@code courier_new} starts. */
    public static final Duration FIRST_LOOK = Duration.ofHours(24);
    /** Runs whose place is kept at once; past this, the one used longest ago goes (it ends, at worst, given again). */
    static final int RUNS_MAX = 256;
    /** Batch ends a run keeps: a run has at most 100 tool calls. */
    static final int GIVEN_MAX = 200;

    private static final Pattern DAY = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    /** Room for any page's {@code next} while a page is fitted: a time's digits, a dot and an id of 64 at most. */
    private static final String NEXT_ROOM = "9".repeat(20) + "." + "0".repeat(64);
    private static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX");
    private static final Map<String, Set<String>> ARGS = Map.of(
            "courier_list", Set.of("kind", "unread", "before"),
            "courier_search", Set.of("q", "channelId", "from", "fromDay", "toDay"),
            "courier_read", Set.of("messageId", "from", "channelId", "before"),
            "courier_new", Set.of());

    private final Supplier<CourierRead> read;
    private final Supplier<ZoneId> zone;
    private final Clock clock;
    /** Each run's place in the new messages, by run id, the one used longest ago first. */
    private final Map<String, Place> places = new LinkedHashMap<>(16, 0.75f, true);
    /** One agent's first cursor is made once. A lock, not {@code synchronized}: SQLite's calls block (and pin). */
    private final ReentrantLock anchoring = new ReentrantLock();

    /** A run's place: the last batch end it was given, and every batch end, which only a {@code done} end may store. */
    private static final class Place {
        /** One {@code courier_new} of a run at a time, around the store's read. */
        final ReentrantLock lock = new ReentrantLock();
        final String agentId;
        CourierRead.Cursor last;
        final LinkedHashSet<CourierRead.Cursor> given = new LinkedHashSet<>();

        Place(String agentId) {
            this.agentId = agentId;
        }
    }

    /**
     * @param read Courier's view for agents ({@code CourierModule.read()}): {@link CourierRead#NONE} while there's no store
     * @param zone the member's time zone (the account's), or null for UTC: days in a search, times in results
     */
    public CourierTools(Supplier<CourierRead> read, Supplier<ZoneId> zone, Clock clock) {
        this.read = read;
        this.zone = zone;
        this.clock = clock;
    }

    @Override
    public boolean available() {
        try {
            CourierRead r = read.get();
            return r != null && r.available();
        } catch (RuntimeException e) {
            return false;
        }
    }

    @Override
    public Look look(HostedCall call, RunLedger.Run run) throws ToolFailure {
        check(call.tool(), call.args());
        // A read: nothing is asked, and the look reads nothing either.
        return Look.plain(call.args(), Map.of("kind", "courier"));
    }

    @Override
    public Result run(HostedCall call, RunLedger.Run run) throws ToolFailure {
        Map<String, Object> a = call.args();
        check(call.tool(), a);
        CourierRead r = read.get();
        if (r == null || !r.available()) {
            throw ToolFailure.unavailable("courier");
        }
        ZoneId z = zone();
        try {
            Map<String, Object> out = switch (call.tool()) {
                case "courier_list" -> list(r, a, z);
                case "courier_search" -> search(r, a, z);
                case "courier_read" -> a.get("messageId") instanceof String id ? message(r, id, from(a), z)
                        : channel(r, (String) a.get("channelId"), (String) a.get("before"), z);
                case "courier_new" -> fresh(r, call.runId(), call.agentId(), z);
                default -> throw ToolFailure.notFound("tool");
            };
            return new Result(out, Set.of("U", "S"), Map.of());
        } catch (ToolFailure e) {
            throw e;
        } catch (IllegalArgumentException e) {
            throw ToolFailure.badArgs(word(e.getMessage()));
        } catch (IllegalStateException e) {
            throw ToolFailure.unavailable("courier");
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            // The store failed (SQLite, its disk): nothing was given, so a cursor hasn't moved.
            log.warn("courier tool failed: {}", e.getClass().getSimpleName());
            throw ToolFailure.unavailable("store");
        }
    }

    @Override
    public void runFinished(String runId, String agentId, Map<String, Object> end) {
        Place place;
        synchronized (places) {
            place = places.remove(runId);
        }
        if ((place != null && !place.agentId.equals(agentId)) || !"done".equals(end.get("state"))) {
            return;
        }
        CourierRead.Cursor reported = cursorOf(end.get("courier"));
        if (reported == null) {
            return;
        }
        try {
            CourierRead r = read.get();
            if (r == null || !r.available()) {
                return;
            }
            if (place != null) {
                place.lock.lock();
                try {
                    // Only a batch end this run was given here.
                    if (!place.given.contains(reported)) {
                        return;
                    }
                } finally {
                    place.lock.unlock();
                }
            } else if (!r.names(reported)) {
                // deskd holds no record of this run (it restarted since, or forgot the run): the cursor desk-agent names,
                // the last it received, is taken if it's a real message's place. desk-agent names only what it got, so a
                // reply it never got is never counted as seen.
                return;
            }
            r.saveCursor(agentId, reported);
        } catch (Exception e) {
            // Not stored: the next run is given the same messages again, never fewer.
            log.warn("courier cursor not stored: {}", e.getClass().getSimpleName());
        }
    }

    @Override
    public void runEnded(String runId) {
        synchronized (places) {
            places.remove(runId);
        }
    }

    // ---------------------------------------------------------------- the tools

    private Map<String, Object> list(CourierRead r, Map<String, Object> a, ZoneId z) throws Exception {
        Map<String, Object> got = r.list((String) a.get("kind"), (Boolean) a.get("unread"), (String) a.get("before"));
        List<Map<String, Object>> rows = new ArrayList<>();
        List<Long> lastAts = new ArrayList<>();
        for (Object o : (List<?>) got.get("channels")) {
            Map<?, ?> ch = (Map<?, ?>) o;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("channelId", ch.get("channelId"));
            row.put("kind", ch.get("kind"));
            row.put("title", line(ch.get("title"), 200));
            // At most 10 people named a row, each cut, so one row always fits whatever its senders wrote (CR-L3).
            List<String> names = new ArrayList<>();
            int more = 0;
            if (ch.get("contacts") instanceof List<?> contacts) {
                for (Object n : contacts) {
                    String name = line(n, CONTACT_NAME);
                    if (name == null) {
                        continue;
                    }
                    if (names.size() < CONTACTS_SHOWN) {
                        names.add(name);
                    } else {
                        more++;
                    }
                }
            }
            row.put("contacts", names);
            if (more > 0) {
                row.put("contactsMore", more);
            }
            row.put("medium", ch.get("medium"));
            // The time as the model reads it, before fitting, so the fit is what goes (CR-I2).
            row.put("lastAt", when(ch.get("lastAt"), z));
            row.put("unread", ch.get("unread"));
            row.put("lane", ch.get("lane"));
            row.put("accountLabel", line(ch.get("accountLabel"), 80));
            rows.add(row);
            lastAts.add(ch.get("lastAt") instanceof Number t ? t.longValue() : 0L);
        }
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("channels", List.of());
        frame.put("next", NEXT_ROOM);
        int fit = Math.max(Math.min(1, rows.size()), fit(frame, rows, BUDGET));
        Object next = got.get("next");
        if (fit < rows.size()) {
            next = CourierRead.pageAfter(lastAts.get(fit - 1), (String) rows.get(fit - 1).get("channelId"));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("channels", new ArrayList<>(rows.subList(0, fit)));
        out.put("next", next);
        return out;
    }

    private Map<String, Object> search(CourierRead r, Map<String, Object> a, ZoneId z) throws Exception {
        Map<String, Object> got = r.search((String) a.get("q"), (String) a.get("channelId"), (String) a.get("from"),
                (String) a.get("fromDay"), (String) a.get("toDay"), z.getId());
        List<Map<String, Object>> hits = new ArrayList<>();
        for (Object o : (List<?>) got.get("hits")) {
            Map<?, ?> h = (Map<?, ?>) o;
            Map<String, Object> hit = new LinkedHashMap<>();
            hit.put("messageId", h.get("messageId"));
            hit.put("channelId", h.get("channelId"));
            hit.put("from", from(h.get("from")));
            hit.put("at", when(h.get("at"), z));
            hit.put("medium", h.get("medium"));
            hit.put("subject", line(h.get("subject"), Norm.MAX_SUBJECT));
            hit.put("snippet", line(h.get("snippet"), 400));
            hit.put("lane", h.get("lane"));
            hit.put("accountLabel", line(h.get("accountLabel"), 80));
            hit.put("bulk", h.get("bulk"));
            hit.put("senderKnown", h.get("senderKnown"));
            hit.put("senderConfirmed", h.get("senderConfirmed"));
            hits.add(hit);
        }
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("hits", List.of());
        frame.put("more", true);
        int fit = fit(frame, hits, BUDGET);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("hits", new ArrayList<>(hits.subList(0, fit)));
        // Hits left out to fit: a narrower search finds them.
        out.put("more", fit < hits.size());
        return out;
    }

    private Map<String, Object> message(CourierRead r, String messageId, int from, ZoneId z) throws Exception {
        Map<String, Object> m = r.read(messageId, from);
        if (m == null) {
            // Not there, or not a message an agent may see (a Request, Spam, Trash): the same answer.
            throw ToolFailure.notFound("message");
        }
        String text = m.get("text") instanceof String t ? t : "";
        int textFrom = m.get("textFrom") instanceof Number n ? n.intValue() : 0;
        Integer textNext = m.get("textNext") instanceof Number n ? n.intValue() : null;
        int keep = fitText(k -> {
            Map<String, Object> v = view(m, text.substring(0, k), z);
            v.put("textFrom", textFrom);
            v.put("textNext", textFrom + k);
            return v;
        }, text);
        Map<String, Object> out = view(m, text.substring(0, keep), z);
        out.put("textFrom", textFrom);
        out.put("textNext", keep < text.length() ? Integer.valueOf(textFrom + keep) : textNext);
        return out;
    }

    private Map<String, Object> channel(CourierRead r, String channelId, String before, ZoneId z) throws Exception {
        Map<String, Object> got = r.readChannel(channelId, before);
        if (got == null) {
            throw ToolFailure.notFound("channel");
        }
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> raw = (List<Map<String, Object>>) got.get("messages");
        // Oldest first in the page: keep the newest that fit, and the next page starts just before the oldest kept.
        List<Map<String, Object>> views = new ArrayList<>();
        for (Map<String, Object> m : raw) {
            views.add(cutView(m, Integer.MAX_VALUE, z));
        }
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("channelId", channelId);
        frame.put("messages", List.of());
        frame.put("next", NEXT_ROOM);
        List<Map<String, Object>> newestFirst = new ArrayList<>(views);
        Collections.reverse(newestFirst);
        int fit = fit(frame, newestFirst, BUDGET);
        Object next = got.get("next");
        List<Map<String, Object>> kept;
        if (fit == 0 && !raw.isEmpty()) {
            // Even the newest alone is too long: its text cut to fit, and the rest of it with courier_read.
            kept = List.of(squeezed(frame, "messages", raw.get(raw.size() - 1), Integer.MAX_VALUE, z));
            fit = 1;
        } else {
            kept = new ArrayList<>(newestFirst.subList(0, fit));
            Collections.reverse(kept);
        }
        if (fit < raw.size()) {
            Map<String, Object> oldestKept = raw.get(raw.size() - fit);
            next = CourierRead.pageAfter(((Number) oldestKept.get("at")).longValue(), (String) oldestKept.get("messageId"));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("channelId", channelId);
        out.put("messages", kept);
        out.put("next", next);
        return out;
    }

    /**
     * {@code courier_new}: the run's next new messages, as many as fit, and the run's place moved past them. The store is
     * read {@link #NEW_CHUNK} at a time, only as far as a result can take, so a call costs about what it gives.
     */
    private Map<String, Object> fresh(CourierRead r, String runId, String agentId, ZoneId z) throws Exception {
        Place place = place(runId, agentId);
        place.lock.lock();
        try {
            CourierRead.Cursor stored = anchored(r, agentId);
            CourierRead.Cursor start = place.last != null && place.last.after(stored) ? place.last : stored;
            Map<String, Object> frame = new LinkedHashMap<>();
            frame.put("messages", List.of());
            frame.put("more", true);
            frame.put("cursor", Map.of("receivedAt", Long.MIN_VALUE, "messageId", "0".repeat(64)));
            List<Map<String, Object>> raw = new ArrayList<>();
            List<Map<String, Object>> views = new ArrayList<>();
            int used = size(frame);
            boolean more = false;
            CourierRead.Cursor from = start;
            Map<String, Object> tooLong = null;
            reading:
            while (true) {
                int ask = Math.min(NEW_CHUNK, AGENT_NEW_MAX - raw.size());
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> chunk = (List<Map<String, Object>>) r.newSince(from, ask).get("messages");
                for (Map<String, Object> m : chunk) {
                    Map<String, Object> v = cutView(m, NEW_TEXT, z);
                    int cost = size(v) + (views.isEmpty() ? 0 : 1);
                    if (used + cost > BUDGET) {
                        if (views.isEmpty()) {
                            tooLong = m;
                        }
                        more = true;
                        break reading;
                    }
                    used += cost;
                    raw.add(m);
                    views.add(v);
                }
                if (chunk.size() < ask) {
                    break;
                }
                if (raw.size() >= AGENT_NEW_MAX) {
                    more = true;
                    break;
                }
                Map<String, Object> last = chunk.get(chunk.size() - 1);
                from = new CourierRead.Cursor(((Number) last.get("receivedAt")).longValue(), (String) last.get("messageId"));
            }
            if (tooLong != null) {
                // The oldest alone is too long (its text all quotes, say): its text cut further, never skipped.
                raw.add(tooLong);
                views.add(squeezed(frame, "messages", tooLong, NEW_TEXT, z));
            }
            // The whole, once: never over, whatever the sum missed.
            while (views.size() > 1) {
                Map<String, Object> whole = new LinkedHashMap<>(frame);
                whole.put("messages", views);
                if (size(whole) <= BUDGET) {
                    break;
                }
                views.remove(views.size() - 1);
                raw.remove(raw.size() - 1);
                more = true;
            }
            CourierRead.Cursor end = start;
            if (!raw.isEmpty()) {
                Map<String, Object> last = raw.get(raw.size() - 1);
                end = new CourierRead.Cursor(((Number) last.get("receivedAt")).longValue(), (String) last.get("messageId"));
            }
            place.last = end;
            if (place.given.size() >= GIVEN_MAX) {
                place.given.remove(place.given.iterator().next());
            }
            place.given.add(end);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("messages", views);
            // More may be waiting: those left out to fit, or a full read's worth.
            out.put("more", more);
            out.put("cursor", end.wire());
            return out;
        } finally {
            place.lock.unlock();
        }
    }

    /** How many {@code courier_new} reads from the store at a time. */
    static final int NEW_CHUNK = 16;

    /** The store's most a {@code courier_new} reads at once (§12: 100). */
    static final int AGENT_NEW_MAX = 100;

    /** The run's place, made at its first {@code courier_new}. A run belongs to one agent (the ledger checks it too). */
    private Place place(String runId, String agentId) {
        synchronized (places) {
            Place p = places.get(runId);
            if (p == null || !p.agentId.equals(agentId)) {
                p = new Place(agentId);
                places.put(runId, p);
                while (places.size() > RUNS_MAX) {
                    places.remove(places.keySet().iterator().next());
                }
            }
            return p;
        }
    }

    /** The agent's stored cursor; for an agent with none, {@link #FIRST_LOOK} back from now, stored at once. */
    private CourierRead.Cursor anchored(CourierRead r, String agentId) throws Exception {
        anchoring.lock();
        try {
            CourierRead.Cursor c = r.cursor(agentId);
            if (c == null) {
                c = new CourierRead.Cursor(clock.millis() - FIRST_LOOK.toMillis(), "");
                r.saveCursor(agentId, c);
                CourierRead.Cursor stored = r.cursor(agentId);
                return stored == null ? c : stored;
            }
            return c;
        } finally {
            anchoring.unlock();
        }
    }

    // ---------------------------------------------------------------- shapes

    /**
     * §12's message as the model reads it, every string a sender wrote cleaned again: {@code {messageId, channelId,
     * direction, from, at, medium, subject, text, attachments: [{name, type, bytes}], bulk, authorKind, lane, senderKnown,
     * senderConfirmed, accountLabel}}.
     */
    private static Map<String, Object> view(Map<String, Object> m, String text, ZoneId z) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("messageId", m.get("messageId"));
        out.put("channelId", m.get("channelId"));
        out.put("direction", m.get("direction"));
        out.put("from", from(m.get("from")));
        out.put("at", when(m.get("at"), z));
        out.put("medium", m.get("medium"));
        out.put("subject", line(m.get("subject"), Norm.MAX_SUBJECT));
        out.put("text", Norm.clean(text, Integer.MAX_VALUE, true));
        List<Map<String, Object>> attachments = new ArrayList<>();
        int more = 0;
        if (m.get("attachments") instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> a) {
                    if (attachments.size() >= ATTACHMENTS_SHOWN) {
                        more++;
                        continue;
                    }
                    Map<String, Object> named = new LinkedHashMap<>();
                    String name = line(a.get("name"), ATTACHMENT_NAME);
                    named.put("name", name == null ? "(no name)" : name);
                    named.put("type", line(a.get("type"), 100));
                    named.put("bytes", a.get("bytes"));
                    attachments.add(named);
                }
            }
        }
        out.put("attachments", attachments);
        if (more > 0) {
            out.put("attachmentsMore", more);
        }
        out.put("bulk", m.get("bulk"));
        out.put("authorKind", m.get("authorKind"));
        out.put("lane", m.get("lane"));
        out.put("senderKnown", m.get("senderKnown"));
        out.put("senderConfirmed", m.get("senderConfirmed"));
        out.put("accountLabel", line(m.get("accountLabel"), 80));
        return out;
    }

    /**
     * A message's view with its text cut at {@code max} characters of the store's text if it's longer: {@code textMore},
     * and where it's cut, {@code textNext}, where {@code courier_read} goes on from.
     */
    private static Map<String, Object> cutView(Map<String, Object> m, int max, ZoneId z) {
        String text = m.get("text") instanceof String t ? t : "";
        int end = text.length() > max ? safeEnd(text, max) : text.length();
        boolean more = end < text.length() || Boolean.TRUE.equals(m.get("textMore"));
        Map<String, Object> v = view(m, text.substring(0, end), z);
        v.put("textMore", more);
        v.put("textNext", more ? Integer.valueOf(end) : null);
        return v;
    }

    /** One message alone in {@code frame}'s list, its text cut (at {@code max} at most) to fit. */
    private static Map<String, Object> squeezed(Map<String, Object> frame, String key, Map<String, Object> m, int max, ZoneId z) {
        String text = m.get("text") instanceof String t ? t : "";
        String upTo = text.length() > max ? text.substring(0, safeEnd(text, max)) : text;
        int keep = fitText(k -> {
            Map<String, Object> f = new LinkedHashMap<>(frame);
            f.put(key, List.of(cutView(m, k, z)));
            return f;
        }, upTo);
        return cutView(m, keep, z);
    }

    /** The contact record: {@code {contactId, name, endpoint}}, or {@code {me: true}}; the name cleaned again. */
    private static Map<String, Object> from(Object raw) {
        if (!(raw instanceof Map<?, ?> f)) {
            return null;
        }
        if (Boolean.TRUE.equals(f.get("me"))) {
            return Map.of("me", true);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("contactId", f.get("contactId"));
        out.put("name", line(f.get("name"), Norm.MAX_NAME));
        out.put("endpoint", line(f.get("endpoint"), Norm.MAX_ADDRESS));
        return out;
    }

    private static String line(Object raw, int max) {
        return raw instanceof String s ? Norm.line(s, max) : null;
    }

    private static String when(Object ms, ZoneId z) {
        return ms instanceof Number n ? ISO.format(Instant.ofEpochMilli(n.longValue()).atZone(z)) : null;
    }

    private ZoneId zone() {
        try {
            ZoneId z = zone == null ? null : zone.get();
            return z == null ? ZoneOffset.UTC : z;
        } catch (RuntimeException e) {
            return ZoneOffset.UTC;
        }
    }

    // ---------------------------------------------------------------- fitting

    /** What a result costs as desk-agent's fence carries it: its JSON, as a JSON string's characters. */
    static int size(Object content) {
        String inner = new String(Json.bytes(content), StandardCharsets.UTF_8);
        return new String(Json.bytes(Collections.singletonMap("c", inner)), StandardCharsets.UTF_8).length() - 8;
    }

    /**
     * How many of {@code rows}, from the first, fit in {@code frame}'s list within {@code budget}: each row's cost is its
     * own (a JSON string's escapes are by character), checked once whole at the end.
     */
    static int fit(Map<String, Object> frame, List<Map<String, Object>> rows, int budget) {
        int used = size(frame);
        int n = 0;
        for (Map<String, Object> row : rows) {
            int cost = size(row) + (n == 0 ? 0 : 1);
            if (used + cost > budget) {
                break;
            }
            used += cost;
            n++;
        }
        // The whole, once: never over, whatever the sum missed.
        String key = null;
        for (Map.Entry<String, Object> e : frame.entrySet()) {
            if (e.getValue() instanceof List<?>) {
                key = e.getKey();
                break;
            }
        }
        while (n > 0 && key != null) {
            Map<String, Object> whole = new LinkedHashMap<>(frame);
            whole.put(key, rows.subList(0, n));
            if (size(whole) <= budget) {
                break;
            }
            n--;
        }
        return n;
    }

    /** The most characters of {@code text}, from its start, whose result fits: never splitting a surrogate pair. */
    private static int fitText(java.util.function.IntFunction<Map<String, Object>> result, String text) {
        if (size(result.apply(text.length())) <= BUDGET) {
            return text.length();
        }
        int lo = 0;
        int hi = text.length();
        while (lo < hi) {
            int mid = (lo + hi + 1) >>> 1;
            if (size(result.apply(safeEnd(text, mid))) <= BUDGET) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return safeEnd(text, lo);
    }

    /** {@code end}, or one less if it would split a surrogate pair. */
    private static int safeEnd(String text, int end) {
        int e = Math.min(end, text.length());
        return e > 0 && e < text.length() && Character.isHighSurrogate(text.charAt(e - 1)) ? e - 1 : e;
    }

    // ---------------------------------------------------------------- arguments

    /**
     * deskd's own check of a call's arguments, before the look and again before it runs: the tool's own names only,
     * each its type and size; {@code courier_read} takes a message or a channel, never both.
     */
    static void check(String tool, Map<String, Object> a) throws ToolFailure {
        Set<String> allowed = ARGS.get(tool);
        if (allowed == null) {
            throw ToolFailure.notFound("tool");
        }
        for (String key : a.keySet()) {
            if (!allowed.contains(key)) {
                throw ToolFailure.badArgs(key.length() <= 32 && key.matches("[A-Za-z_]+") ? key : "args");
            }
        }
        switch (tool) {
            case "courier_list" -> {
                Object kind = a.get("kind");
                if (kind != null && !List.of("direct", "group", "self").contains(kind)) {
                    throw ToolFailure.badArgs("kind");
                }
                if (a.get("unread") != null && !(a.get("unread") instanceof Boolean)) {
                    throw ToolFailure.badArgs("unread");
                }
                text(a, "before", 80, false);
            }
            case "courier_search" -> {
                String q = text(a, "q", 200, true);
                if (q.isBlank()) {
                    throw ToolFailure.badArgs("q");
                }
                text(a, "channelId", 64, false);
                text(a, "from", Norm.MAX_ADDRESS, false);
                for (String day : List.of("fromDay", "toDay")) {
                    String d = text(a, day, 10, false);
                    if (d != null && !DAY.matcher(d).matches()) {
                        throw ToolFailure.badArgs(day);
                    }
                }
            }
            case "courier_read" -> {
                String message = text(a, "messageId", 64, false);
                String channel = text(a, "channelId", 64, false);
                if ((message == null) == (channel == null)) {
                    throw ToolFailure.badArgs("messageId");
                }
                if (a.get("from") != null && (message == null || !(a.get("from") instanceof Number n)
                        || n.doubleValue() != Math.rint(n.doubleValue()) || n.doubleValue() < 0
                        || n.doubleValue() > 100_000_000)) {
                    throw ToolFailure.badArgs("from");
                }
                if (a.get("before") != null && channel == null) {
                    throw ToolFailure.badArgs("before");
                }
                text(a, "before", 80, false);
            }
            default -> {
                // courier_new takes nothing.
            }
        }
    }

    private static String text(Map<String, Object> a, String key, int max, boolean required) throws ToolFailure {
        Object v = a.get(key);
        if (v == null) {
            if (required) {
                throw ToolFailure.badArgs(key);
            }
            return null;
        }
        if (!(v instanceof String s) || s.length() > max || Norm.hasHidden(s.replace('\n', ' ').replace('\t', ' '))) {
            throw ToolFailure.badArgs(key);
        }
        return s;
    }

    private static int from(Map<String, Object> a) {
        return a.get("from") instanceof Number n ? n.intValue() : 0;
    }

    /** A refusal's word from the store's: a field's name, nothing a caller wrote. */
    private static String word(String message) {
        return message != null && message.matches("[a-zA-Z_]{1,32}") ? message : "args";
    }

    /** A cursor as desk-agent names it: {@code {receivedAt, messageId}}; null for anything else. */
    static CourierRead.Cursor cursorOf(Object raw) {
        if (!(raw instanceof Map<?, ?> c) || !(c.get("receivedAt") instanceof Number at) || at.doubleValue() != Math.rint(at.doubleValue())
                || !(c.get("messageId") instanceof String id) || id.length() > 64) {
            return null;
        }
        return new CourierRead.Cursor(at.longValue(), id);
    }
}
