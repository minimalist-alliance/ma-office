package com.minimalistalliance.desk.deskd.guild;

import com.minimalistalliance.desk.deskd.auth.DeskTokenVerifier;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.session.SessionAuthorizer;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
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
 * 30 s, while a newer version is wanted; a {@code 503} keeps the last roster, as the contract says.
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

    /** Timings, short in tests. */
    public record Timing(Duration minBackoff, Duration maxBackoff) {
        public static final Timing DEFAULT = new Timing(Duration.ofSeconds(1), Duration.ofSeconds(30));
    }

    private final Path file;
    private final Source source;
    private final Supplier<String> guildId;
    private final Sessions sessions;
    private final Timing timing;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    /** Null until a roster has been read or loaded. Replaced whole. */
    private volatile Map<String, Member> members;
    private volatile long version = -1;
    private volatile boolean closed;
    private long wanted = -1;
    private boolean readAsked;
    private boolean running;
    private boolean stopped;
    private long lastMismatchRead;

    public GuildRoster(Path directory, Source source, Supplier<String> guildId, Sessions sessions, Timing timing) {
        this.file = directory.resolve(FILE);
        this.source = source;
        this.guildId = guildId;
        this.sessions = sessions;
        this.timing = timing;
    }

    /** The roster kept on disk, if it's this guild's. Call once config says which guild that is. */
    public void loadKept() {
        String guild = guildId.get();
        if (guild == null || members != null) {
            return;
        }
        try {
            byte[] bytes = AtomicFile.read(file);
            if (bytes == null) {
                return;
            }
            Parsed kept = parse(Json.parseObject(bytes), guild);
            if (kept != null) {
                install(kept);
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
     * On {@code session.open} and every refresh, after the token's own checks. Before any roster, the token stands alone.
     */
    @Override
    public void check(Caller caller) throws SessionAuthorizer.RefusedException {
        Map<String, Member> now = members;
        if (now == null) {
            return;
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
            Parsed parsed = parse(source.read(), guild);
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

    /** Applies a roster read now: newer only, kept on disk, then every session it changes closed. */
    void apply(Parsed parsed) {
        lock.lock();
        try {
            if (members != null && parsed.version() <= version) {
                return;
            }
            install(parsed);
        } finally {
            lock.unlock();
        }
        save(parsed);
        enforce();
    }

    private void install(Parsed parsed) {
        members = parsed.members();
        closed = parsed.closed();
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

    record Parsed(long version, boolean closed, Map<String, Member> members, Map<String, Object> raw) {}

    /** @return null if it isn't this guild's, or isn't a roster. A malformed member is left out, so they're refused. */
    static Parsed parse(Map<String, Object> body, String guildId) {
        if (body == null || !Objects.equals(guildId, Json.string(body, "guildId"))) {
            return null;
        }
        if (!(body.get("version") instanceof Number number) || !(body.get("members") instanceof List<?> list)
                || list.size() > MAX_MEMBERS) {
            return null;
        }
        boolean closed = Boolean.TRUE.equals(body.get("closed"));
        Map<String, Member> members = new HashMap<>();
        List<Map<String, Object>> kept = new ArrayList<>();
        for (Object item : list) {
            Member member = member(item);
            if (member != null && !closed) {
                members.put(member.memberId(), member);
                kept.add(json(member));
            }
        }
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("guildId", guildId);
        raw.put("version", number.longValue());
        raw.put("closed", closed);
        raw.put("members", kept);
        if (body.get("settings") instanceof Map<?, ?> settings) {
            raw.put("settings", settings);
        }
        return new Parsed(number.longValue(), closed, Map.copyOf(members), raw);
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
