package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.desks.DeskTools;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's own record of Maia Mode on this desk (API.md §23): whether the member turned it on, and Desk Maia's grant for
 * each of their other desks ({@code brief}, {@code show}, "keeps to itself", when it expires). Recorded <b>only</b> from
 * the member's relayed {@code agent.maia.set}, {@code agent.maia.grant.set} and {@code agent.maia.grant.revoke}, and
 * only what desk-agent's answer also holds, as {@link AccessRecord} records an agent's access. deskd's
 * {@code desk_message} goes by it for Desk Maia's briefs ({@link DeskTools.MaiaGrants}): no grant, no brief, whatever
 * desk-agent says.
 *
 * <p><b>Narrowing first.</b> What the member takes away (Maia Mode off, a grant revoked, a scope or "keeps to itself"
 * changed) holds here before desk-agent hears, whatever it answers; what widens waits for desk-agent's answer and is cut
 * to it: on only where both agree, scopes in both, the expiry the earlier of desk-agent's and 30 days from now.
 *
 * <p><b>Where.</b> {@code /data/desk/maia-record.json}, deskd's own file (mode 0600, written whole), with an HMAC-SHA256
 * over its canonical JSON under {@code maia-record.key} (32 random bytes made once beside it, 0600). <b>It fails
 * closed:</b> a file that doesn't verify is set aside as {@code .bad} and nothing is recorded, so Maia Mode reads as off
 * here and every brief of hers is refused until the member turns it on again; a write that fails sets the last file
 * aside as {@code .unsaved}, so a restart before the next good write records nothing.
 *
 * <p>Nothing here logs a desk, a scope or a name: an outcome word at most.
 */
public final class MaiaRecord implements DeskTools.MaiaGrants {

    private static final Logger log = LoggerFactory.getLogger(MaiaRecord.class);

    public static final String FILE = "maia-record.json";
    public static final String KEY = "maia-record.key";
    /** Desk Maia's fixed agent id (desk-agent's {@code MaiaAgent.ID}). */
    public static final String MAIA = "maia";
    static final String SET = "agent.maia.set";
    static final String GRANT_SET = "agent.maia.grant.set";
    static final String GRANT_REVOKE = "agent.maia.grant.revoke";
    static final Duration MAX_GRANT = Duration.ofDays(30);
    static final int MAX_GRANTS = 20;
    static final int MAX_BYTES = 64 * 1024;
    private static final int KEY_BYTES = 32;
    private static final Pattern DESK_ID = Pattern.compile("d-[a-z0-9]{1,40}");
    static final Set<String> SCOPES = Set.of("brief", "show");

    /** One grant as deskd holds it. */
    public record Grant(String deskId, Set<String> scopes, boolean keepsToItself, long expiresAt) {
        public Grant {
            scopes = Set.copyOf(scopes);
        }

        Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("scopes", new ArrayList<>(new TreeSet<>(scopes)));
            out.put("keepsToItself", keepsToItself);
            out.put("expiresAt", expiresAt);
            return out;
        }

        static Grant fromJson(String deskId, Object value) {
            if (!(value instanceof Map<?, ?> m) || !(m.get("scopes") instanceof List<?> scopes)
                    || !(m.get("keepsToItself") instanceof Boolean keeps) || !(m.get("expiresAt") instanceof Number at)) {
                return null;
            }
            Set<String> s = new TreeSet<>();
            for (Object scope : scopes) {
                if (!(scope instanceof String word) || !SCOPES.contains(word)) {
                    return null;
                }
                s.add(word);
            }
            return new Grant(deskId, s, keeps, at.longValue());
        }

        boolean live(long now) {
            return expiresAt > now;
        }
    }

    /** The whole record: on, and the grants by desk. */
    record State(boolean on, Map<String, Grant> grants) {
        static final State NOTHING = new State(false, Map.of());

        State {
            grants = Map.copyOf(grants);
        }
    }

    private final Clock clock;
    private final SecureRandom random = new SecureRandom();
    private final ReentrantLock lock = new ReentrantLock();
    private volatile State state = State.NOTHING;
    private volatile Path directory;

    public MaiaRecord(Clock clock) {
        this.clock = Objects.requireNonNull(clock);
    }

    /** Reads the record from {@code dir} ({@code /data/desk}) and keeps it there from now on. Until then: nothing. */
    public void keepIn(Path dir) {
        lock.lock();
        try {
            this.directory = dir;
            this.state = load(dir);
        } finally {
            lock.unlock();
        }
    }

    // ---------------------------------------------------------------- DeskTools.MaiaGrants

    @Override
    public boolean mayBrief(String deskId) {
        State s = state;
        Grant g = deskId == null ? null : s.grants().get(deskId);
        return s.on() && g != null && g.live(clock.millis()) && g.scopes().contains("brief");
    }

    @Override
    public boolean keepsToItself(String deskId) {
        State s = state;
        Grant g = deskId == null ? null : s.grants().get(deskId);
        return g == null || !g.live(clock.millis()) || g.keepsToItself();
    }

    /** Whether the member's Maia Mode is on, as deskd recorded it. */
    public boolean on() {
        return state.on();
    }

    /** The grant for a desk as recorded, or null. */
    public Grant grant(String deskId) {
        return state.grants().get(deskId);
    }

    // ---------------------------------------------------------------- recording

    /**
     * Before the call goes to desk-agent: what the member takes away holds now. {@code agent.maia.set {on: false}}
     * turns it off and drops every grant; {@code grant.revoke} drops that desk's; {@code grant.set} narrows that desk's
     * scopes to those asked for and, when asked, marks it "keeps to itself".
     */
    /**
     * How many times Maia Mode was turned off or a grant revoked: a {@code grant.set} answer recorded after one of these
     * began never puts back what it took away (Security's DMA-L4).
     */
    private long takenAway;

    /** The count {@link #recordAnswer(String, Map, Object, long)} compares; read as the call begins. */
    public long generation() {
        lock.lock();
        try {
            return takenAway;
        } finally {
            lock.unlock();
        }
    }

    public void recordNarrowing(String method, Map<String, Object> params) {
        lock.lock();
        try {
            State s = state;
            switch (method) {
                case SET -> {
                    if (Boolean.FALSE.equals(params.get("on"))) {
                        takenAway++;
                    }
                    if (Boolean.FALSE.equals(params.get("on")) && (s.on() || !s.grants().isEmpty())) {
                        save(State.NOTHING);
                    }
                }
                case GRANT_REVOKE -> {
                    takenAway++;
                    String deskId = deskId(params.get("deskId"));
                    if (deskId != null && s.grants().containsKey(deskId)) {
                        Map<String, Grant> next = new TreeMap<>(s.grants());
                        next.remove(deskId);
                        save(new State(s.on(), next));
                    }
                }
                case GRANT_SET -> {
                    String deskId = deskId(params.get("deskId"));
                    Grant before = deskId == null ? null : s.grants().get(deskId);
                    if (before == null) {
                        return;
                    }
                    Set<String> asked = scopes(params.get("scopes"));
                    Set<String> narrowed = new TreeSet<>(before.scopes());
                    narrowed.retainAll(asked == null ? Set.of() : asked);
                    boolean keeps = before.keepsToItself() || Boolean.TRUE.equals(params.get("keepsToItself"));
                    if (!narrowed.equals(before.scopes()) || keeps != before.keepsToItself()) {
                        // Narrowed: a wider grant.set answered after this began never puts it back (DMA-L4).
                        takenAway++;
                        Map<String, Grant> next = new TreeMap<>(s.grants());
                        next.put(deskId, new Grant(deskId, narrowed, keeps, before.expiresAt()));
                        save(new State(s.on(), next));
                    }
                }
                default -> {}
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * After desk-agent answered the member's call (a refusal records nothing): the member's params cut to what the answer
     * holds.
     */
    public void recordAnswer(String method, Map<String, Object> params, Object answer) {
        recordAnswer(method, params, answer, -1);
    }

    /**
     * {@code generation}: {@link #generation()} as the call began, or -1 for none; a {@code grant.set} answered after
     * Maia Mode was turned off or a grant revoked since then records nothing (DMA-L4).
     */
    public void recordAnswer(String method, Map<String, Object> params, Object answer, long generation) {
        // One hold of the (reentrant) lock across the check and the record, so nothing is taken away in between.
        lock.lock();
        try {
            if (GRANT_SET.equals(method) && generation >= 0 && takenAway != generation) {
                return;
            }
            recordAnswerNow(method, params, answer);
        } finally {
            lock.unlock();
        }
    }

    private void recordAnswerNow(String method, Map<String, Object> params, Object answer) {
        if (!(answer instanceof Map<?, ?> a)) {
            return;
        }
        lock.lock();
        try {
            State s = state;
            switch (method) {
                case SET -> {
                    if (!(a.get("maia") instanceof Map<?, ?> maia)) {
                        return;
                    }
                    boolean held = Boolean.TRUE.equals(maia.get("on"));
                    if (Boolean.TRUE.equals(params.get("on")) && held && !s.on()) {
                        save(new State(true, s.grants()));
                    } else if (!held && (s.on() || !s.grants().isEmpty())) {
                        // desk-agent holds it off: nothing of it stays here.
                        save(State.NOTHING);
                    }
                }
                case GRANT_SET -> {
                    String deskId = deskId(params.get("deskId"));
                    if (deskId == null || !(a.get("grant") instanceof Map<?, ?> grant)
                            || !deskId.equals(grant.get("deskId"))) {
                        return;
                    }
                    Set<String> asked = scopes(params.get("scopes"));
                    Set<String> held = scopes(grant.get("scopes"));
                    if (asked == null || held == null) {
                        return;
                    }
                    Set<String> both = new TreeSet<>(asked);
                    both.retainAll(held);
                    if (!(grant.get("expiresAt") instanceof Number at)) {
                        return;
                    }
                    long now = clock.millis();
                    // The member's own days (7 when absent), never longer than desk-agent's answer (DMA-L4).
                    long days = params.get("days") instanceof Number d && d.longValue() >= 1
                            && d.longValue() <= MAX_GRANT.toDays() ? d.longValue() : 7;
                    long expires = Math.min(Math.min(at.longValue(), now + Duration.ofDays(days).toMillis()),
                            now + MAX_GRANT.toMillis());
                    Grant before = s.grants().get(deskId);
                    if (before == null && s.grants().size() >= MAX_GRANTS) {
                        return;
                    }
                    // "Keeps to itself" only ever narrows: either side saying so is enough.
                    boolean keeps = Boolean.TRUE.equals(params.get("keepsToItself"))
                            || Boolean.TRUE.equals(grant.get("keepsToItself"))
                            || (params.get("keepsToItself") == null && before != null && before.keepsToItself());
                    Map<String, Grant> next = new TreeMap<>(s.grants());
                    if (both.isEmpty() || expires <= now) {
                        next.remove(deskId);
                    } else {
                        next.put(deskId, new Grant(deskId, both, keeps, expires));
                    }
                    save(new State(s.on(), next));
                }
                case GRANT_REVOKE -> {
                    // Taken away before desk-agent heard (recordNarrowing); nothing more to do.
                }
                default -> {}
            }
        } finally {
            lock.unlock();
        }
    }

    private static String deskId(Object value) {
        return value instanceof String id && DESK_ID.matcher(id).matches() ? id : null;
    }

    /** A list of known scopes, or null when it isn't one. */
    private static Set<String> scopes(Object value) {
        if (!(value instanceof List<?> list)) {
            return null;
        }
        Set<String> out = new TreeSet<>();
        for (Object o : list) {
            if (!(o instanceof String word) || !SCOPES.contains(word)) {
                return null;
            }
            out.add(word);
        }
        return out;
    }

    // ---------------------------------------------------------------- the file

    /** Under {@link #lock}: holds at once; a failed write sets the last file aside (fails closed). */
    private void save(State next) {
        state = next;
        Path dir = directory;
        if (dir == null) {
            return;
        }
        try {
            byte[] key = key(dir, true);
            Map<String, Object> body = body(next);
            Map<String, Object> file = new LinkedHashMap<>(body);
            file.put("mac", AccessRecord.mac(key, body));
            java.util.Arrays.fill(key, (byte) 0);
            writer.write(dir.resolve(FILE), Json.bytes(file));
        } catch (IOException | GeneralSecurityException | RuntimeException e) {
            log.warn("Maia Mode's record wasn't written ({}), so the last one is set aside: after a restart Maia Mode"
                    + " reads as off here until the next change is written", e.getClass().getSimpleName());
            retire(dir.resolve(FILE));
        }
    }

    private static void retire(Path file) {
        try {
            Files.move(file, file.resolveSibling(FILE + ".unsaved"), StandardCopyOption.REPLACE_EXISTING);
        } catch (java.nio.file.NoSuchFileException e) {
            // None yet.
        } catch (IOException e) {
            try {
                Files.deleteIfExists(file);
            } catch (IOException again) {
                log.error("Maia Mode's last record couldn't be set aside: {}", again.getClass().getSimpleName());
            }
        }
    }

    private volatile AccessRecord.Writer writer = AccessRecord::write;

    /** A test's writer, in place of {@link AccessRecord#write}. */
    void writerForTest(AccessRecord.Writer testWriter) {
        this.writer = testWriter;
    }

    private static Map<String, Object> body(State s) {
        Map<String, Object> grants = new TreeMap<>();
        for (Map.Entry<String, Grant> e : s.grants().entrySet()) {
            grants.put(e.getKey(), e.getValue().toJson());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("v", 1);
        body.put("on", s.on());
        body.put("grants", grants);
        return body;
    }

    private State load(Path dir) {
        Path file = dir.resolve(FILE);
        try {
            if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
                return State.NOTHING;
            }
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_BYTES) {
                return setAside(file, "not a file");
            }
            byte[] key = key(dir, false);
            if (key == null) {
                return setAside(file, "no key");
            }
            Map<String, Object> read = new LinkedHashMap<>(Json.parseObject(Files.readAllBytes(file)));
            Object mac = read.remove("mac");
            if (!(mac instanceof String claimed) || !(read.get("v") instanceof Number v) || v.intValue() != 1
                    || v.doubleValue() != 1 || !(read.get("on") instanceof Boolean on)
                    || !(read.get("grants") instanceof Map<?, ?> listed) || read.size() != 3) {
                java.util.Arrays.fill(key, (byte) 0);
                return setAside(file, "shape");
            }
            boolean ok = MessageDigest.isEqual(claimed.getBytes(StandardCharsets.US_ASCII),
                    AccessRecord.mac(key, read).getBytes(StandardCharsets.US_ASCII));
            java.util.Arrays.fill(key, (byte) 0);
            if (!ok) {
                return setAside(file, "mac");
            }
            Map<String, Grant> grants = new TreeMap<>();
            for (Map.Entry<?, ?> e : listed.entrySet()) {
                String deskId = e.getKey() instanceof String id ? deskId(id) : null;
                Grant g = deskId == null ? null : Grant.fromJson(deskId, e.getValue());
                if (g == null || grants.size() >= MAX_GRANTS) {
                    return setAside(file, "entry");
                }
                grants.put(deskId, g);
            }
            return new State(on, grants);
        } catch (IOException | GeneralSecurityException | JsonFormatException | RuntimeException e) {
            return setAside(file, e.getClass().getSimpleName());
        }
    }

    private static State setAside(Path file, String why) {
        log.warn("Maia Mode's record didn't verify ({}), so Maia Mode reads as off here", why);
        try {
            Files.move(file, file.resolveSibling(FILE + ".bad"), StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            try {
                Files.deleteIfExists(file);
            } catch (IOException again) {
                // The next save writes over it.
            }
        }
        return State.NOTHING;
    }

    private byte[] key(Path dir, boolean make) throws IOException {
        Path path = dir.resolve(KEY);
        if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && Files.size(path) == KEY_BYTES) {
            return Files.readAllBytes(path);
        }
        if (!make) {
            return null;
        }
        byte[] key = new byte[KEY_BYTES];
        random.nextBytes(key);
        Files.deleteIfExists(path);
        AccessRecord.write(path, key);
        return key;
    }
}
