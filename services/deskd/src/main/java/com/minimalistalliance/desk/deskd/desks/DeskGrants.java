package com.minimalistalliance.desk.deskd.desks;

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
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's own record of this desk's halves of the grants between the member's desks (draft ADR "the Agent's tools and
 * approvals", §14), which every envelope is checked against, in and out. desk-agent keeps its own rows for the screens;
 * this one is the boundary: a wrong or compromised desk-agent can't send on a grant the member didn't make, nor take in
 * an envelope on one that was revoked.
 *
 * <ul>
 *   <li>A <b>send half</b> (this desk's agent X messages desk B) is recorded {@code offered} from the member's relayed
 *       {@code agent.access.set}, {@code active} once B's {@code accept} came and verified, pinning B's keys, and
 *       {@code revoked} by either desk's Stop, a deleted agent, or B refusing an envelope as revoked.
 *   <li>An <b>answer half</b> (desk A's agent X may message this desk) is {@code pending} once A's {@code offer} came,
 *       pinning A's keys as the offer carried them; {@code active} only from the member's relayed
 *       {@code agent.desks.answer}, naming the agent that answers; {@code declined} on Not now; {@code revoked} as above.
 * </ul>
 * It also counts each half's envelopes out ({@code seq}, which the receiving desk keeps in order), and keeps the control
 * envelopes deskd made for desk-agent's outbox until desk-agent has them ({@link #owed}).
 *
 * <p>{@code /data/desk/desk-grants.json}, deskd's own file (0600, written whole), with an HMAC-SHA256 under
 * {@code desk-grants.key}. <b>It fails closed:</b> a file that doesn't verify is set aside as {@code .bad} and nothing is
 * recorded, so every envelope is refused {@code no_grant} until the member pairs the desks again; a write that fails sets
 * the last file aside, so a restart can't read back a grant the member has since revoked. Nothing here logs a key, an
 * agent's name or a desk.
 */
public final class DeskGrants {

    private static final Logger log = LoggerFactory.getLogger(DeskGrants.class);

    public static final String FILE = "desk-grants.json";
    public static final String KEY = "desk-grants.key";
    static final int MAX_HALVES = 1_000;
    static final int MAX_OWED = 500;
    static final int MAX_BYTES = 4 << 20;
    private static final Pattern GRANT_ID = Pattern.compile("dg-[a-z2-7]{20}");
    private static final Pattern AGENT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final long DAY_MS = 24L * 60 * 60 * 1000;

    public enum Role {
        SEND,
        ANSWER;

        String wire() {
            return this == SEND ? "send" : "answer";
        }
    }

    /**
     * One half.
     *
     * @param agentId the send half's agent X, or the answer half's agent Y (null while pending)
     * @param peerDeskId the other desk
     * @param peerAgentId the agent on the other desk: X for an answer half, Y once known for a send half
     * @param state {@code offered}, {@code active}, {@code revoked} (send); {@code pending}, {@code declined},
     *     {@code active}, {@code revoked} (answer)
     * @param peer the other desk's keys, pinned at pairing; null for a send half not yet accepted
     * @param seq how many envelopes this desk has sent on this half: the next goes with {@code seq + 1}
     * @param day the start of the counting day, ms, and {@code dayCount} the messages or answers sent since
     */
    public record Half(String grantId, Role role, String agentId, String peerDeskId, String peerAgentId,
            String state, DeskKeys.Pub peer, long seq, long day, int dayCount, long createdAt) {
        public Half {
            Objects.requireNonNull(grantId);
            Objects.requireNonNull(role);
            Objects.requireNonNull(peerDeskId);
            Objects.requireNonNull(state);
        }

        public boolean active() {
            return "active".equals(state);
        }

        public boolean revoked() {
            return "revoked".equals(state);
        }

        Half with(String newState) {
            return new Half(grantId, role, agentId, peerDeskId, peerAgentId, newState, peer, seq, day, dayCount,
                    createdAt);
        }

        Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("grantId", grantId);
            out.put("role", role.wire());
            out.put("agentId", agentId);
            out.put("peerDeskId", peerDeskId);
            out.put("peerAgentId", peerAgentId);
            out.put("state", state);
            out.put("peer", peer == null ? null : peer.toJson());
            out.put("seq", seq);
            out.put("day", day);
            out.put("dayCount", dayCount);
            out.put("createdAt", createdAt);
            return out;
        }

        static Half fromJson(Object value) {
            if (!(value instanceof Map<?, ?> m) || !(m.get("grantId") instanceof String grantId)
                    || !GRANT_ID.matcher(grantId).matches() || !(m.get("role") instanceof String role)
                    || !(m.get("peerDeskId") instanceof String peerDesk) || !DeskKeys.DESK_ID.matcher(peerDesk).matches()
                    || !(m.get("state") instanceof String state) || !(m.get("seq") instanceof Number seq)
                    || !(m.get("day") instanceof Number day) || !(m.get("dayCount") instanceof Number count)
                    || !(m.get("createdAt") instanceof Number created)) {
                return null;
            }
            Role r = "send".equals(role) ? Role.SEND : "answer".equals(role) ? Role.ANSWER : null;
            if (r == null || !(r == Role.SEND ? List.of("offered", "active", "revoked")
                    : List.of("pending", "declined", "active", "revoked")).contains(state)) {
                return null;
            }
            String agent = m.get("agentId") instanceof String a && AGENT_ID.matcher(a).matches() ? a : null;
            String peerAgent = m.get("peerAgentId") instanceof String a && AGENT_ID.matcher(a).matches() ? a : null;
            DeskKeys.Pub peer = m.get("peer") == null ? null : DeskKeys.Pub.fromJson(peerDesk, m.get("peer"));
            if (m.get("peer") != null && peer == null) {
                return null;
            }
            return new Half(grantId, r, agent, peerDesk, peerAgent, state, peer, seq.longValue(), day.longValue(),
                    count.intValue(), created.longValue());
        }

        /** No ids of agents or keys in logs. */
        @Override
        public String toString() {
            return "Half[" + role + ", " + state + "]";
        }
    }

    /** A control envelope deskd made for desk-agent's outbox, kept until desk-agent has it. */
    public record Owed(String id, String grantId, String toDeskId, String kind, long seq, Map<String, Object> envelope) {
        public Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("id", id);
            out.put("grantId", grantId);
            out.put("toDeskId", toDeskId);
            out.put("kind", kind);
            out.put("seq", seq);
            out.put("envelope", envelope);
            return out;
        }

        @SuppressWarnings("unchecked")
        static Owed fromJson(Object value) {
            if (!(value instanceof Map<?, ?> m) || !(m.get("id") instanceof String id)
                    || !(m.get("grantId") instanceof String grantId) || !(m.get("toDeskId") instanceof String to)
                    || !(m.get("kind") instanceof String kind) || !(m.get("seq") instanceof Number seq)
                    || !(m.get("envelope") instanceof Map<?, ?> env)) {
                return null;
            }
            return new Owed(id, grantId, to, kind, seq.longValue(), (Map<String, Object>) env);
        }

        @Override
        public String toString() {
            return "Owed[" + kind + "]";
        }
    }

    private final Clock clock;
    private final SecureRandom random = new SecureRandom();
    private final ReentrantLock lock = new ReentrantLock();
    private volatile Map<String, Half> halves = Map.of();
    private volatile List<Owed> owed = List.of();
    private volatile Path directory;
    private volatile Writer writer = DeskKeys::writePrivate;

    /** How the record's bytes reach the disk: {@link DeskKeys#writePrivate}, or a test's that fails. */
    @FunctionalInterface
    interface Writer {
        void write(Path file, byte[] bytes) throws IOException;
    }

    public DeskGrants(Clock clock) {
        this.clock = Objects.requireNonNull(clock);
    }

    void writerForTest(Writer testWriter) {
        this.writer = testWriter;
    }

    /** Reads the record from {@code dir} and keeps it there; until then it's in memory only. */
    public void keepIn(Path dir) {
        lock.lock();
        try {
            directory = dir;
            load(dir);
        } finally {
            lock.unlock();
        }
    }

    // ---------------------------------------------------------------- reads

    public Half half(String grantId) {
        return grantId == null ? null : halves.get(grantId);
    }

    /** The agent's active send half to that desk, or null. */
    public Half activeSend(String agentId, String peerDeskId) {
        for (Half h : halves.values()) {
            if (h.role() == Role.SEND && h.active() && h.agentId() != null && h.agentId().equals(agentId)
                    && h.peerDeskId().equals(peerDeskId)) {
                return h;
            }
        }
        return null;
    }

    /** The agent's send half to that desk that isn't revoked: offered or active, or null. */
    public Half liveSend(String agentId, String peerDeskId) {
        for (Half h : halves.values()) {
            if (h.role() == Role.SEND && !h.revoked() && agentId.equals(h.agentId())
                    && h.peerDeskId().equals(peerDeskId)) {
                return h;
            }
        }
        return null;
    }

    /** Every half of the agent's that isn't revoked: its send halves, and the answer halves it answers. */
    public List<Half> liveOf(String agentId) {
        List<Half> out = new ArrayList<>();
        for (Half h : halves.values()) {
            if (!h.revoked() && agentId.equals(h.agentId())) {
                out.add(h);
            }
        }
        return out;
    }

    public List<Half> all() {
        return List.copyOf(halves.values());
    }

    public List<Owed> owed() {
        return owed;
    }

    // ---------------------------------------------------------------- changes

    /** The member switched a desk on for an agent, and desk-agent made its send half: {@code offered}. Idempotent. */
    public Half sendOffered(String grantId, String agentId, String peerDeskId) {
        return change(grantId, before -> {
            if (before != null) {
                return before;
            }
            return new Half(grantId, Role.SEND, agentId, peerDeskId, null, "offered", null, 0, 0, 0, clock.millis());
        });
    }

    /** A verified offer came: an answer half {@code pending}, with the sender's keys pinned. False if it can't be one. */
    public boolean answerPending(String grantId, String peerDeskId, String peerAgentId, DeskKeys.Pub peer) {
        if (!GRANT_ID.matcher(grantId).matches() || peer == null || !peer.deskId().equals(peerDeskId)) {
            return false;
        }
        boolean[] ok = new boolean[1];
        change(grantId, before -> {
            if (before == null) {
                ok[0] = halves.size() < MAX_HALVES;
                return ok[0] ? new Half(grantId, Role.ANSWER, null, peerDeskId, peerAgentId, "pending", peer, 0, 0, 0,
                        clock.millis()) : null;
            }
            // The same offer again: the same keys, the same desk.
            ok[0] = before.role() == Role.ANSWER && before.peerDeskId().equals(peerDeskId) && peer.sameAs(before.peer());
            return before;
        });
        return ok[0];
    }

    /** The member allowed an offer here, with the agent that answers: {@code active}. Null if there's no such offer. */
    public Half answerAllowed(String grantId, String agentId) {
        return change(grantId, before -> before != null && before.role() == Role.ANSWER
                && ("pending".equals(before.state()) || "declined".equals(before.state()) || before.active())
                ? new Half(before.grantId(), Role.ANSWER, agentId, before.peerDeskId(), before.peerAgentId(), "active",
                        before.peer(), before.seq(), before.day(), before.dayCount(), before.createdAt())
                : before);
    }

    /** Not now: {@code declined}, still listed. */
    public Half answerDeclined(String grantId) {
        return change(grantId, before -> before != null && before.role() == Role.ANSWER
                && "pending".equals(before.state()) ? before.with("declined") : before);
    }

    /** A verified accept came for an offered send half: {@code active}, the other desk's keys pinned. */
    public Half accepted(String grantId, String peerAgentId, DeskKeys.Pub peer) {
        return change(grantId, before -> {
            if (before == null || before.role() != Role.SEND || before.revoked()
                    || !before.peerDeskId().equals(peer.deskId())) {
                return before;
            }
            if (before.active()) {
                return before;
            }
            return new Half(before.grantId(), Role.SEND, before.agentId(), before.peerDeskId(), peerAgentId, "active",
                    peer, before.seq(), before.day(), before.dayCount(), before.createdAt());
        });
    }

    /** Either desk's Stop, a deleted agent, or the other desk's word that it's revoked: {@code revoked}. Only takes away. */
    public Half revoke(String grantId) {
        return change(grantId, before -> before == null || before.revoked() ? before : before.with("revoked"));
    }

    /**
     * The next envelope's {@code seq} on this half, counted and kept before it's used, so a restart never sends one again.
     * With {@code counts}, it's a message or an answer, held to {@code perDay} a day: -1 past it.
     */
    public long nextSeq(String grantId, boolean counts, int perDay) {
        long[] out = {-1};
        change(grantId, before -> {
            if (before == null) {
                return null;
            }
            long now = clock.millis();
            long day = before.day();
            int count = before.dayCount();
            if (counts) {
                if (now - day >= DAY_MS) {
                    day = now;
                    count = 0;
                }
                if (count >= perDay) {
                    return before;
                }
                count++;
            }
            out[0] = before.seq() + 1;
            return new Half(before.grantId(), before.role(), before.agentId(), before.peerDeskId(),
                    before.peerAgentId(), before.state(), before.peer(), out[0], day, count, before.createdAt());
        });
        return out[0];
    }

    /** A control envelope for desk-agent's outbox, kept until {@link #handed}. False when too many wait already. */
    public boolean owe(Owed envelope) {
        lock.lock();
        try {
            if (owed.size() >= MAX_OWED) {
                return false;
            }
            List<Owed> next = new ArrayList<>(owed);
            next.add(envelope);
            owed = List.copyOf(next);
            save();
            return true;
        } finally {
            lock.unlock();
        }
    }

    /** desk-agent has these in its outbox. */
    public void handed(List<String> ids) {
        lock.lock();
        try {
            List<Owed> next = new ArrayList<>();
            for (Owed o : owed) {
                if (!ids.contains(o.id())) {
                    next.add(o);
                }
            }
            if (next.size() != owed.size()) {
                owed = List.copyOf(next);
                save();
            }
        } finally {
            lock.unlock();
        }
    }

    private Half change(String grantId, java.util.function.UnaryOperator<Half> how) {
        lock.lock();
        try {
            Half before = halves.get(grantId);
            Half after = how.apply(before);
            if (after == before || (after != null && after.equals(before))) {
                return after;
            }
            Map<String, Half> next = new TreeMap<>(halves);
            if (after == null) {
                next.remove(grantId);
            } else {
                next.put(grantId, after);
            }
            halves = Map.copyOf(next);
            save();
            return after;
        } finally {
            lock.unlock();
        }
    }

    // ---------------------------------------------------------------- the file

    /** Under {@link #lock}. A failed write sets the last file aside, so a restart can't read back more than is so. */
    private void save() {
        Path dir = directory;
        if (dir == null) {
            return;
        }
        try {
            Map<String, Object> listed = new TreeMap<>();
            for (Half h : halves.values()) {
                listed.put(h.grantId(), h.toJson());
            }
            List<Object> owedJson = new ArrayList<>();
            for (Owed o : owed) {
                owedJson.add(o.toJson());
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("v", 1);
            body.put("halves", listed);
            body.put("owed", owedJson);
            String text = new String(Json.bytes(body), StandardCharsets.UTF_8);
            byte[] key = key(dir, true);
            Map<String, Object> file = new LinkedHashMap<>();
            file.put("body", text);
            file.put("mac", mac(key, text));
            Arrays.fill(key, (byte) 0);
            writer.write(dir.resolve(FILE), Json.bytes(file));
        } catch (IOException | GeneralSecurityException | RuntimeException e) {
            log.warn("the desk grants' record wasn't written ({}), so the last one is set aside", e.getClass().getSimpleName());
            try {
                Files.move(dir.resolve(FILE), dir.resolve(FILE + ".unsaved"), StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException again) {
                try {
                    Files.deleteIfExists(dir.resolve(FILE));
                } catch (IOException ignored) {
                    log.error("the desk grants' last record couldn't be set aside");
                }
            }
        }
    }

    private void load(Path dir) {
        Path file = dir.resolve(FILE);
        halves = Map.of();
        owed = List.of();
        try {
            if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
                return;
            }
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_BYTES) {
                setAside(file, "not a file");
                return;
            }
            byte[] key = key(dir, false);
            if (key == null) {
                setAside(file, "no key");
                return;
            }
            Map<String, Object> read = Json.parseObject(Files.readAllBytes(file));
            boolean ok = read.size() == 2 && read.get("body") instanceof String body && read.get("mac") instanceof String m
                    && MessageDigest.isEqual(m.getBytes(StandardCharsets.US_ASCII),
                            mac(key, body).getBytes(StandardCharsets.US_ASCII));
            Arrays.fill(key, (byte) 0);
            if (!ok) {
                setAside(file, "mac");
                return;
            }
            Map<String, Object> body = Json.parseObject(((String) read.get("body")).getBytes(StandardCharsets.UTF_8));
            if (!Envelope.one(body.get("v")) || !(body.get("halves") instanceof Map<?, ?> listed)
                    || !(body.get("owed") instanceof List<?> owedList)) {
                setAside(file, "shape");
                return;
            }
            Map<String, Half> out = new TreeMap<>();
            for (Map.Entry<?, ?> e : listed.entrySet()) {
                Half h = Half.fromJson(e.getValue());
                if (h == null || !h.grantId().equals(e.getKey())) {
                    setAside(file, "half");
                    return;
                }
                out.put(h.grantId(), h);
            }
            List<Owed> o = new ArrayList<>();
            for (Object item : owedList) {
                Owed owe = Owed.fromJson(item);
                if (owe == null) {
                    setAside(file, "owed");
                    return;
                }
                o.add(owe);
            }
            halves = Map.copyOf(out);
            owed = List.copyOf(o);
        } catch (IOException | GeneralSecurityException | JsonFormatException | RuntimeException e) {
            setAside(file, e.getClass().getSimpleName());
        }
    }

    private void setAside(Path file, String why) {
        log.warn("the desk grants' record didn't verify ({}): every envelope is refused until the desks are paired again",
                why);
        halves = Map.of();
        owed = List.of();
        try {
            Files.move(file, file.resolveSibling(FILE + ".bad"), StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            try {
                Files.deleteIfExists(file);
            } catch (IOException again) {
                // The next save writes over it.
            }
        }
    }

    static String mac(byte[] key, String body) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(body.getBytes(StandardCharsets.UTF_8)));
    }

    private byte[] key(Path dir, boolean make) throws IOException {
        Path path = dir.resolve(KEY);
        if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && Files.size(path) == 32) {
            return Files.readAllBytes(path);
        }
        if (!make) {
            return null;
        }
        byte[] key = new byte[32];
        random.nextBytes(key);
        Files.deleteIfExists(path);
        DeskKeys.writePrivate(path, key.clone());
        return key;
    }
}
