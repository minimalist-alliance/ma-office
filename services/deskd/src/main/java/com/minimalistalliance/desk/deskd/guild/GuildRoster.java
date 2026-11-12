package com.minimalistalliance.desk.deskd.guild;

import com.minimalistalliance.desk.deskd.auth.DeskTokenVerifier;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.session.SessionAuthorizer;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A guild desk's roster: who's in the guild now, and with what role, grants and teen flag (ma-platform guild-sharing.md,
 * "Roster push"). The Platform says when it changes ({@code notify guild.roster}, a heartbeat reply's
 * {@code guildVersion}, config's {@code guild.rosterVersion}), and deskd reads {@code GET /v1/agent/guild/roster}.
 *
 * <p><b>The roster wins over the token</b> (auth.md section 4.5). Once one has been read, a member must be on it, with
 * the same role, grants and teen flag as the token, to open a session or refresh one: otherwise {@code invalid_token},
 * and the client asks for a fresh token. A roster that drops a member, or changes their role, grants or teen flag, closes
 * each of their sessions at once with 4401, and its relays with it (collab, agent, commons), as the gateway also does.
 * A closed guild closes everyone. A name or badge alone changing closes nothing: the next refresh carries it.
 *
 * <p>A version no newer than the last applied is ignored. The last roster is kept in {@code /data/desk/guild-roster.json},
 * written whole, so a restart holds members to it before the first read. A read that fails is tried again, 1 s up to
 * 30 s, while a newer version is wanted; a {@code 503} keeps the last roster, as the contract says. Until a roster has
 * been read or loaded, no member gets in: {@code desk_not_ready} (audit Z30).
 *
 * <p><b>Leaving deletes the member's agent conversations</b> (ADR 0080 decision 12). Each roster applied is compared
 * with the last one, and {@link GuildPurges} decides whose purge that owes or holds, before this roster is kept.
 *
 * <p>Nothing here logs a member's id or name.
 */
public final class GuildRoster implements DeskTokenVerifier.MemberCheck {

    private static final Logger log = LoggerFactory.getLogger(GuildRoster.class);

    public static final String FILE = "guild-roster.json";
    static final Pattern MEMBER_ID = Pattern.compile("gm-[a-z0-9]{4,40}");
    private static final int MAX_MEMBERS = 1000;
    /** A token that disagrees with the roster asks for a read, at most this often. */
    private static final Duration MISMATCH_READ_EVERY = Duration.ofSeconds(5);

    /** One member as the roster has them. */
    public record Member(String memberId, String role, List<String> grants, String name, String badge, boolean teen) {

        /** The same rights as this caller: what decides whether their session stands. */
        boolean sameRights(Caller caller) {
            return role.equals(caller.role()) && grants.equals(caller.grants()) && teen == caller.teen();
        }
    }

    /** Where a roster comes from: {@code GET /v1/agent/guild/roster}. */
    @FunctionalInterface
    public interface Source {
        Map<String, Object> read() throws IOException, InterruptedException;
    }

    /** What the roster acts on: the live sessions. */
    public interface Sessions {
        /** Every guild member with a session now, as their sessions' callers say. */
        Collection<Caller> callers();

        /** Closes each of this member's sessions and relays now. */
        void closeMember(String memberId);
    }

    /** Timings, short in tests. {@code purgeGrace}: how long an owed purge waits ({@link GuildPurges}). */
    public record Timing(Duration minBackoff, Duration maxBackoff, Duration purgeGrace) {
        public static final Duration PURGE_GRACE = Duration.ofMinutes(10);
        public static final Timing DEFAULT = new Timing(Duration.ofSeconds(1), Duration.ofSeconds(30), PURGE_GRACE);

        public Timing(Duration minBackoff, Duration maxBackoff) {
            this(minBackoff, maxBackoff, PURGE_GRACE);
        }
    }

    private final Path file;
    private final Source source;
    private final Supplier<String> guildId;
    private final Sessions sessions;
    private final Timing timing;
    private final GuildPurges purges;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    /** Null until a roster has been read or loaded. Replaced whole. */
    private volatile Map<String, Member> members;
    /** Every member id the applied roster lists, a malformed entry's too: what the next one is compared with. */
    private volatile Set<String> listed = Set.of();
    private volatile long version = -1;
    private volatile boolean closed;
    /** Whether the applied roster has a Founder and every entry's id could be read. */
    private volatile boolean sound;
    /**
     * Whether the applied roster came over an earlier one, or is the one kept on disk: a first roster read with nothing to
     * compare it to had no drop guard, so apps aren't told to delete on its word (Security's L2).
     */
    private volatile boolean compared;
    private final List<Runnable> listeners = new java.util.concurrent.CopyOnWriteArrayList<>();
    private long wanted = -1;
    private boolean readAsked;
    private boolean running;
    private boolean stopped;
    private long lastMismatchRead;

    public GuildRoster(Path directory, Source source, Supplier<String> guildId, Sessions sessions, Timing timing) {
        this(directory, source, guildId, sessions, timing, Clock.systemUTC());
    }

    public GuildRoster(Path directory, Source source, Supplier<String> guildId, Sessions sessions, Timing timing,
            Clock clock) {
        this.file = directory.resolve(FILE);
        this.source = source;
        this.guildId = guildId;
        this.sessions = sessions;
        this.timing = timing;
        this.purges = new GuildPurges(directory, clock, guildId, timing.purgeGrace());
        purges.listedBy(id -> listed.contains(id));
    }

    /** Whose agent conversations this desk owes a purge: desk-agent is sent them ({@code AgentModule#memberPurges}). */
    public GuildPurges purges() {
        return purges;
    }

    /**
     * The members apps may keep data for (API.md section 19, "Members leaving"), through the purges' own guard: nothing while
     * no roster is known, the guild is closed, the roster has no Founder or an entry whose id can't be read, or any purge is
     * held. Otherwise the roster's members and those whose purge is still in its grace.
     */
    public com.minimalistalliance.desk.deskd.apps.AppMembers appMembers() {
        return new com.minimalistalliance.desk.deskd.apps.AppMembers() {
            @Override
            public Set<String> retained() {
                Set<String> now;
                lock.lock();
                try {
                    if (members == null || closed || !sound || !compared || listed.isEmpty()) {
                        return null;
                    }
                    now = listed;
                } finally {
                    lock.unlock();
                }
                Set<String> grace = purges.inGrace();
                if (grace == null) {
                    return null;
                }
                Set<String> all = new java.util.TreeSet<>(now);
                all.addAll(grace);
                return Set.copyOf(all);
            }

            @Override
            public long nextChangeAtMillis() {
                return purges.nextGraceEndMillis();
            }

            @Override
            public void onChange(Runnable wake) {
                listeners.add(wake);
                purges.onChange(wake);
            }
        };
    }

    /** The roster kept on disk, if it's this guild's. Call once config says which guild that is. */
    public void loadKept() {
        String guild = guildId.get();
        if (guild == null || members != null) {
            return;
        }
        purges.load();
        try {
            byte[] bytes = AtomicFile.read(file);
            if (bytes == null) {
                return;
            }
            Parsed kept = parse(Json.parseObject(bytes), guild, true);
            if (kept != null) {
                install(kept);
                compared = true;
            }
        } catch (IOException | JsonFormatException | RuntimeException e) {
            log.warn("guild roster: the kept one couldn't be read: {}", e.getClass().getSimpleName());
        }
    }

    /** The Platform says the roster is at this version: read it if that's newer than what's applied. Never blocks. */
    public void versionIs(long announced) {
        lock.lock();
        try {
            if (announced > version && announced > wanted) {
                wanted = announced;
                startOrWake();
            }
        } finally {
            lock.unlock();
        }
    }

    /** Read it now, whatever its version: at boot, and when a token disagrees with it. Never blocks. */
    public void read() {
        lock.lock();
        try {
            readAsked = true;
            startOrWake();
        } finally {
            lock.unlock();
        }
    }

    public void stop() {
        lock.lock();
        try {
            stopped = true;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** The roster's version applied, or -1 before one. */
    public long version() {
        return version;
    }

    /** A member on the roster now, or null: also null before any roster. */
    public Member member(String memberId) {
        Map<String, Member> now = members;
        return now == null ? null : now.get(memberId);
    }

    /** True once a roster has been read or loaded. */
    public boolean known() {
        return members != null;
    }

    /**
     * On {@code session.open} and every refresh, after the token's own checks. Before any roster has been read or kept,
     * no member gets in: {@code desk_not_ready}, and the client tries again (audit Z30), so a removed member's unexpired
     * token can't stand alone on a fresh desk, or after a restart with no kept roster and a failed read.
     */
    @Override
    public void check(Caller caller) throws SessionAuthorizer.RefusedException {
        Map<String, Member> now = members;
        if (now == null) {
            throw new SessionAuthorizer.RefusedException("desk_not_ready");
        }
        Member member = closed ? null : now.get(caller.memberId());
        if (member == null) {
            throw new SessionAuthorizer.RefusedException("invalid_token");
        }
        if (!member.sameRights(caller)) {
            // The token may be newer than this roster: look again, and the client's next token gets in.
            askAfterMismatch();
            throw new SessionAuthorizer.RefusedException("invalid_token");
        }
    }

    private void askAfterMismatch() {
        lock.lock();
        try {
            long now = System.nanoTime();
            if (lastMismatchRead == 0 || now - lastMismatchRead >= MISMATCH_READ_EVERY.toNanos()) {
                lastMismatchRead = now;
                readAsked = true;
                startOrWake();
            }
        } finally {
            lock.unlock();
        }
    }

    // ---- reading

    /** With the lock held. */
    private void startOrWake() {
        if (stopped) {
            return;
        }
        if (running) {
            wake.signalAll();
        } else {
            running = true;
            Thread.ofVirtual().name("guild-roster").start(this::run);
        }
    }

    private void run() {
        long backoff = timing.minBackoff().toNanos();
        while (true) {
            lock.lock();
            try {
                if (stopped || (!readAsked && wanted <= version)) {
                    running = false;
                    return;
                }
                readAsked = false;
            } finally {
                lock.unlock();
            }
            boolean ok = readOnce();
            lock.lock();
            try {
                // A read that came back older than what was announced is the Platform catching up: wait, then again.
                if (ok && wanted <= version) {
                    backoff = timing.minBackoff().toNanos();
                    continue;
                }
                // Try again while something still wants it.
                readAsked = readAsked || wanted > version || members == null;
                if (stopped) {
                    running = false;
                    return;
                }
                wake.awaitNanos(backoff);
                backoff = Math.min(backoff * 2, timing.maxBackoff().toNanos());
            } catch (InterruptedException e) {
                running = false;
                return;
            } finally {
                lock.unlock();
            }
        }
    }

    /** @return true if a roster was read, applied or not */
    private boolean readOnce() {
        String guild = guildId.get();
        if (guild == null) {
            return false;
        }
        try {
            Parsed parsed = parse(source.read(), guild, false);
            if (parsed == null) {
                log.warn("guild roster: a roster that isn't this guild's, or isn't well formed, was ignored");
                return false;
            }
            apply(parsed);
            return true;
        } catch (IOException | RuntimeException e) {
            log.warn("guild roster: the read failed: {}", e.getClass().getSimpleName());
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * Applies a roster read now: newer only; the purges it owes, holds or cancels kept first, then the roster, then it's
     * in force, then every session it changes closed. A purge list that couldn't be kept leaves the last roster on disk,
     * so a restart compares again from it. Only the roster's own thread applies one.
     */
    void apply(Parsed parsed) {
        Set<String> before;
        lock.lock();
        try {
            if (members != null && parsed.version() <= version) {
                return;
            }
            before = members == null ? null : listed;
        } finally {
            lock.unlock();
        }
        if (purges.rosterApplied(before, parsed)) {
            save(parsed);
        } else {
            log.warn("guild roster {}: not kept, as the purges it changed couldn't be", parsed.version());
        }
        lock.lock();
        try {
            install(parsed);
            compared = before != null || compared;
        } finally {
            lock.unlock();
        }
        enforce();
        for (Runnable listener : listeners) {
            listener.run();
        }
    }

    private void install(Parsed parsed) {
        members = parsed.members();
        listed = parsed.listed();
        closed = parsed.closed();
        sound = parsed.hasLead() && parsed.unidentified() == 0;
        version = parsed.version();
    }

    /** Closes the sessions of every member who's gone or whose rights changed. */
    void enforce() {
        Map<String, Member> now = members;
        if (now == null) {
            return;
        }
        List<String> toClose = new ArrayList<>();
        for (Caller caller : sessions.callers()) {
            Member member = closed ? null : now.get(caller.memberId());
            if ((member == null || !member.sameRights(caller)) && !toClose.contains(caller.memberId())) {
                toClose.add(caller.memberId());
            }
        }
        for (String memberId : toClose) {
            sessions.closeMember(memberId);
        }
        if (!toClose.isEmpty()) {
            log.info("guild roster {}: closed the sessions of {} members", version, toClose.size());
        }
    }

    private void save(Parsed parsed) {
        try {
            AtomicFile.write(file, Json.bytes(parsed.raw()));
        } catch (IOException e) {
            log.warn("guild roster: it couldn't be kept: {}", e.getClass().getSimpleName());
        }
    }

    // ---- the shape

    /**
     * A roster as read. {@code listed}: every member id it names, a malformed entry's too, so a member whose entry is
     * malformed is refused but never taken as gone. {@code unidentified}: entries with no member id that can be read.
     */
    record Parsed(long version, boolean closed, Map<String, Member> members, Set<String> listed, int unidentified,
            Map<String, Object> raw) {

        /** Whether a Founder is on it, as on every sound roster of an open guild. */
        boolean hasLead() {
            return members.values().stream().anyMatch(member -> Caller.LEAD.equals(member.role()));
        }
    }

    /**
     * @param kept whether it's the copy deskd kept, whose {@code listed} it wrote itself
     * @return null if it isn't this guild's, or isn't a roster. A malformed member is left out, so they're refused.
     */
    static Parsed parse(Map<String, Object> body, String guildId, boolean kept) {
        if (body == null || !Objects.equals(guildId, Json.string(body, "guildId"))) {
            return null;
        }
        if (!(body.get("version") instanceof Number number) || !(body.get("members") instanceof List<?> list)
                || list.size() > MAX_MEMBERS) {
            return null;
        }
        boolean closed = Boolean.TRUE.equals(body.get("closed"));
        Map<String, Member> members = new HashMap<>();
        Set<String> listed = new TreeSet<>();
        int unidentified = 0;
        List<Map<String, Object>> keep = new ArrayList<>();
        for (Object item : list) {
            String id = item instanceof Map<?, ?> map && map.get("memberId") instanceof String text
                    && MEMBER_ID.matcher(text).matches() ? text : null;
            if (id == null) {
                unidentified++;
            } else {
                listed.add(id);
            }
            Member member = member(item);
            if (member != null && !closed) {
                members.put(member.memberId(), member);
                keep.add(json(member));
            }
        }
        if (kept && body.get("listed") instanceof List<?> more && more.size() <= MAX_MEMBERS) {
            for (Object id : more) {
                if (id instanceof String text && MEMBER_ID.matcher(text).matches()) {
                    listed.add(text);
                }
            }
        }
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("guildId", guildId);
        raw.put("version", number.longValue());
        raw.put("closed", closed);
        raw.put("members", keep);
        raw.put("listed", List.copyOf(listed));
        if (body.get("settings") instanceof Map<?, ?> settings) {
            raw.put("settings", settings);
        }
        return new Parsed(number.longValue(), closed, Map.copyOf(members), Set.copyOf(listed), unidentified, raw);
    }

    private static Member member(Object item) {
        if (!(item instanceof Map<?, ?> map)) {
            return null;
        }
        Object id = map.get("memberId");
        Object role = map.get("role");
        if (!(id instanceof String memberId) || !MEMBER_ID.matcher(memberId).matches()
                || !(Caller.LEAD.equals(role) || Caller.OFFICER.equals(role) || Caller.MEMBER.equals(role))
                || !(map.get("grants") instanceof List<?> grants) || !(map.get("teen") instanceof Boolean teen)) {
            return null;
        }
        List<String> claimed = new ArrayList<>();
        for (Object grant : grants) {
            if (!(grant instanceof String text)) {
                return null;
            }
            claimed.add(text);
        }
        Object badge = map.get("badge");
        String name = map.get("name") instanceof String text ? text : null;
        return new Member(memberId, (String) role, Caller.effectiveGrants((String) role, claimed), name,
                badge instanceof String text ? text : null, teen);
    }

    private static Map<String, Object> json(Member member) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("memberId", member.memberId());
        json.put("role", member.role());
        json.put("grants", member.grants());
        json.put("name", member.name());
        json.put("badge", member.badge());
        json.put("teen", member.teen());
        return json;
    }
}
