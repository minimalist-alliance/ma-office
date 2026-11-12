package com.minimalistalliance.desk.deskd.guild;

import com.minimalistalliance.desk.deskd.agent.MemberPurges;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Predicate;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Whose agent conversations a guild desk owes a purge (ADR 0080 decision 12 and its addendum of 2026-11-10). Deletion
 * can't be undone, so a roster that's wrong must never cause one:
 *
 * <ul>
 *   <li><b>Owed</b> only when a roster newer than the last one applied doesn't list a member the last one listed. Never
 *       from a first roster (none read and none kept), a failed, malformed, older or other guild's roster, or a member
 *       who merely has no session. A malformed entry that still names the member counts as listing them. A closed
 *       guild owes nothing here: its server and data go by the Platform's rule.
 *   <li><b>Held</b> instead, all of that roster's drops, when it lists no Founder ({@code lead}), has an entry whose
 *       member id can't be read, or drops more than half of the last roster's members at once. A held purge becomes
 *       owed when a later sound roster (a Founder, every entry readable, not closed) still doesn't list the member.
 *   <li><b>Cancelled</b> when any roster lists the member again, owed or held: they keep their data.
 *   <li>An owed purge waits {@code grace} after the roster that made it owed, so a roster the Platform corrects at once
 *       costs nothing, then goes to desk-agent ({@link MemberPurges}) and leaves the list when desk-agent answers.
 * </ul>
 *
 * <p>The list is {@code /data/desk/guild-purges.json}, written whole, before the roster that changed it is kept, so a
 * crash between the two repeats the comparison instead of losing it. Another guild's list is ignored. {@code /health}
 * shows counts only, and nothing here logs a member's id.
 */
public final class GuildPurges implements MemberPurges {

    private static final Logger log = LoggerFactory.getLogger(GuildPurges.class);

    public static final String FILE = "guild-purges.json";
    /** The most kept: a roster has at most 1000 members, and a purge leaves once done. */
    private static final int MAX_KEPT = 2000;

    enum State {
        OWED("owed"),
        HELD("held");

        final String wire;

        State(String wire) {
            this.wire = wire;
        }

        static State of(Object wire) {
            for (State state : values()) {
                if (state.wire.equals(wire)) {
                    return state;
                }
            }
            return null;
        }
    }

    /** One member's purge: owed from {@code dueAtMillis}, or held since roster {@code version}. */
    record Entry(String memberId, State state, long version, long dueAtMillis) {}

    private final Path file;
    private final Clock clock;
    private final Supplier<String> guildId;
    private final Duration grace;
    private final List<Runnable> listeners = new CopyOnWriteArrayList<>();
    /** By member id, oldest first. Under this. */
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private volatile Predicate<String> listedNow = id -> false;
    private boolean loaded;
    private long done;

    GuildPurges(Path directory, Clock clock, Supplier<String> guildId, Duration grace) {
        this.file = directory.resolve(FILE);
        this.clock = clock;
        this.guildId = guildId;
        this.grace = grace;
    }

    /** Whether the roster applied now lists a member: a purge isn't sent for one who is. */
    void listedBy(Predicate<String> listed) {
        this.listedNow = listed;
    }

    /** The list kept on disk, if it's this guild's. Once, as the roster loads its own. */
    synchronized void load() {
        String guild = guildId.get();
        if (loaded || guild == null) {
            return;
        }
        loaded = true;
        try {
            byte[] bytes = AtomicFile.read(file);
            if (bytes == null) {
                return;
            }
            Map<String, Object> kept = Json.parseObject(bytes);
            if (!Objects.equals(guild, Json.string(kept, "guildId"))) {
                log.warn("guild purges: the kept list is another guild's and was ignored");
                return;
            }
            if (kept.get("done") instanceof Number n) {
                done = Math.max(0, n.longValue());
            }
            if (kept.get("purges") instanceof List<?> list) {
                for (Object item : list) {
                    Entry entry = entry(item);
                    if (entry != null && entries.size() < MAX_KEPT) {
                        entries.putIfAbsent(entry.memberId(), entry);
                    }
                }
            }
        } catch (IOException | JsonFormatException | RuntimeException e) {
            log.warn("guild purges: the kept list couldn't be read: {}", e.getClass().getSimpleName());
        }
    }

    /**
     * A newer roster was applied over {@code before}, the member ids the last one listed (null when there was none).
     *
     * @return false if the list changed and couldn't be kept: the caller then doesn't keep this roster either, so a
     *     restart compares again from the one before
     */
    boolean rosterApplied(Set<String> before, GuildRoster.Parsed next) {
        boolean kept;
        synchronized (this) {
            load();
            int[] counts = new int[4]; // cancelled, confirmed, owed, held
            for (String id : next.listed()) {
                if (entries.remove(id) != null) {
                    counts[0]++;
                }
            }
            if (!next.closed()) {
                long now = clock.millis();
                boolean sound = next.hasLead() && next.unidentified() == 0;
                if (sound) {
                    for (Entry entry : List.copyOf(entries.values())) {
                        if (entry.state() == State.HELD && entry.version() < next.version()) {
                            entries.put(entry.memberId(), new Entry(entry.memberId(), State.OWED, next.version(),
                                    now + grace.toMillis()));
                            counts[1]++;
                        }
                    }
                }
                if (before != null) {
                    List<String> dropped = new ArrayList<>();
                    for (String id : before) {
                        if (!next.listed().contains(id)) {
                            dropped.add(id);
                        }
                    }
                    boolean mass = dropped.size() * 2 > before.size();
                    State state = sound && !mass ? State.OWED : State.HELD;
                    for (String id : dropped) {
                        if (!entries.containsKey(id) && entries.size() < MAX_KEPT) {
                            entries.put(id, new Entry(id, state, next.version(),
                                    state == State.OWED ? now + grace.toMillis() : 0));
                            counts[state == State.OWED ? 2 : 3]++;
                        }
                    }
                    if (counts[3] > 0) {
                        log.warn("guild roster {}: {} members' purges held, as the roster {}; a later roster that still"
                                + " leaves them out lets them go", next.version(), counts[3],
                                !next.hasLead() ? "lists no Founder"
                                        : next.unidentified() > 0 ? "has entries that can't be read"
                                                : "drops more than half the members at once");
                    }
                }
            }
            if (counts[0] + counts[1] + counts[2] + counts[3] == 0) {
                return true;
            }
            log.info("guild roster {}: member purges {} owed, {} confirmed, {} cancelled; {} owed and {} held in all",
                    next.version(), counts[2], counts[1], counts[0], count(State.OWED), count(State.HELD));
            kept = save();
        }
        changed();
        return kept;
    }

    @Override
    public synchronized List<String> due() {
        long now = clock.millis();
        List<String> due = new ArrayList<>();
        Predicate<String> listed = listedNow;
        for (Entry entry : entries.values()) {
            if (entry.state() == State.OWED && entry.dueAtMillis() <= now && !listed.test(entry.memberId())) {
                due.add(entry.memberId());
            }
        }
        return due;
    }

    /**
     * Members whose purge is owed but still in its grace, whom apps keep data for a while yet; or null while any purge is
     * held, when nothing may be deleted on this roster's word (API.md section 19, "Members leaving").
     */
    synchronized java.util.Set<String> inGrace() {
        long now = clock.millis();
        java.util.Set<String> out = new java.util.TreeSet<>();
        for (Entry entry : entries.values()) {
            if (entry.state() == State.HELD) {
                return null;
            }
            if (entry.state() == State.OWED && entry.dueAtMillis() > now) {
                out.add(entry.memberId());
            }
        }
        return out;
    }

    /** When the next owed purge's grace ends, in the clock's millis, or {@link Long#MAX_VALUE}: then {@link #inGrace} shrinks. */
    synchronized long nextGraceEndMillis() {
        long now = clock.millis();
        long next = Long.MAX_VALUE;
        for (Entry entry : entries.values()) {
            if (entry.state() == State.OWED && entry.dueAtMillis() > now) {
                next = Math.min(next, entry.dueAtMillis());
            }
        }
        return next;
    }

    @Override
    public synchronized long nextDueAtMillis() {
        long next = Long.MAX_VALUE;
        for (Entry entry : entries.values()) {
            if (entry.state() == State.OWED) {
                next = Math.min(next, entry.dueAtMillis());
            }
        }
        return next;
    }

    @Override
    public void done(String memberId, Map<String, Object> answer) {
        synchronized (this) {
            Entry entry = entries.get(memberId);
            if (entry == null || entry.state() != State.OWED) {
                return; // re-added meanwhile, or done already
            }
            entries.remove(memberId);
            done++;
            save();
            log.info("guild purge done: {} messages and {} files' notes deleted, {} usage rows kept as the guild's; {}"
                    + " owed and {} held left", answer.get("messages"), answer.get("files"), answer.get("usage"),
                    count(State.OWED), count(State.HELD));
        }
        changed();
    }

    @Override
    public void onChange(Runnable wake) {
        listeners.add(wake);
    }

    @Override
    public synchronized Map<String, Object> health() {
        if (guildId.get() == null) {
            return Map.of();
        }
        Map<String, Object> counts = new LinkedHashMap<>();
        counts.put("owed", count(State.OWED));
        counts.put("held", count(State.HELD));
        counts.put("done", done);
        return Map.of("guildPurges", counts);
    }

    /** For tests: each member's state, or null. */
    synchronized State stateOf(String memberId) {
        Entry entry = entries.get(memberId);
        return entry == null ? null : entry.state();
    }

    private int count(State state) {
        int n = 0;
        for (Entry entry : entries.values()) {
            if (entry.state() == state) {
                n++;
            }
        }
        return n;
    }

    private void changed() {
        for (Runnable listener : listeners) {
            listener.run();
        }
    }

    /** Under this. @return whether it's on disk */
    private boolean save() {
        List<Map<String, Object>> list = new ArrayList<>();
        for (Entry entry : entries.values()) {
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("memberId", entry.memberId());
            json.put("state", entry.state().wire);
            json.put("version", entry.version());
            json.put("dueAtMs", entry.dueAtMillis());
            list.add(json);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("guildId", guildId.get());
        body.put("purges", list);
        body.put("done", done);
        try {
            AtomicFile.write(file, Json.bytes(body));
            return true;
        } catch (IOException e) {
            log.warn("guild purges: the list couldn't be kept: {}", e.getClass().getSimpleName());
            return false;
        }
    }

    private static Entry entry(Object item) {
        if (!(item instanceof Map<?, ?> map) || !(map.get("memberId") instanceof String id)
                || !GuildRoster.MEMBER_ID.matcher(id).matches()) {
            return null;
        }
        State state = State.of(map.get("state"));
        if (state == null || !(map.get("version") instanceof Number version)) {
            return null;
        }
        long due = map.get("dueAtMs") instanceof Number n ? n.longValue() : 0;
        return new Entry(id, state, version.longValue(), due);
    }
}
