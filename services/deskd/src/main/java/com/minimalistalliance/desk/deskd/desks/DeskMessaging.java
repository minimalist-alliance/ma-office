package com.minimalistalliance.desk.deskd.desks;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's half of messages between the member's desks (draft ADR "the Agent's tools and approvals", §14): this desk's
 * keys ({@link DeskKeys}), its record of the grants' halves ({@link DeskGrants}), and every envelope it makes or takes
 * in. desk-agent never sees a private key, and never makes or opens an envelope: it asks for one here, through a tool
 * deskd runs ({@link DeskTools}) or the member's relayed call, and it's handed what an envelope that came in said only
 * once it's been checked here.
 *
 * <p><b>What every envelope that comes in is checked for</b> ({@link #open}), before desk-agent hears of it: that it's
 * for this desk, sealed to this desk's key where it must be, signed by the key this desk pinned for its grant (an
 * offer's own key, and an accept's, are the ones it carries, through the office: the ADR's honest statement of the
 * office's trust at pairing), that it names this desk's owner's account, that it's no older than 7 days, that this desk's
 * half of its grant is in a state that takes it (a revoked half refuses the very next one, and an answer on a send half
 * this desk revoked is refused), and the inbound cap. Never on a Guild Desk, and never with no account known: both
 * refuse. Nothing here logs content, a key, a name or a desk.
 */
public final class DeskMessaging {

    private static final Logger log = LoggerFactory.getLogger(DeskMessaging.class);

    /** An envelope older than this is refused, never delivered late (ADR 0017's agent retention). */
    public static final long MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;
    /** How far ahead of this desk's clock an envelope's time may be. */
    static final long MAX_AHEAD_MS = 5L * 60 * 1000;
    /** Messages a grant a day, and answers likewise (draft ADR §14's {@code rate}). */
    public static final int PER_DAY = 20;
    public static final int MAX_TEXT = 8_000;
    static final int MAX_NAME = 60;
    private static final long DAY_MS = 24L * 60 * 60 * 1000;
    private static final Pattern AGENT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final Pattern WORD = Pattern.compile("[a-z][a-z0-9_]{0,31}");

    /** A refusal, one word. */
    public static final class Refused extends Exception {
        private static final long serialVersionUID = 1L;
        private final String reason;

        public Refused(String reason) {
            super(reason, null, false, false);
            this.reason = reason;
        }

        public String reason() {
            return reason;
        }
    }

    /** An envelope made for desk-agent's outbox: its id, grant, receiving desk, kind, {@code seq} and bytes. */
    public record Made(String id, String grantId, String toDeskId, String kind, long seq, Map<String, Object> envelope) {
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

        DeskGrants.Owed owed() {
            return new DeskGrants.Owed(id, grantId, toDeskId, kind, seq, envelope);
        }

        @Override
        public String toString() {
            return "Made[" + kind + "]";
        }
    }

    private final Clock clock;
    private final Supplier<String> deskId;
    private final Supplier<String> account;
    private final BooleanSupplier guildDesk;
    private final DeskGrants grants;
    /** To-do's source kind {@code desk}: which run was given which message (API.md §22). */
    private final DeskSources sources;
    private final ReentrantLock keysLock = new ReentrantLock();
    private volatile DeskKeys keys;
    private volatile Path directory;
    /** Each grant's envelopes taken in today, by id, for the inbound cap: a retry of the same one counts once. */
    private final Map<String, Map<String, Long>> inToday = new ConcurrentHashMap<>();

    /**
     * @param deskId this desk's id, once IMDS has said
     * @param account this desk's owner's account (the user id every owner token's {@code sub} must be), or null
     * @param guildDesk whether this is a Guild Desk, where none of this runs
     */
    public DeskMessaging(Clock clock, Supplier<String> deskId, Supplier<String> account, BooleanSupplier guildDesk) {
        this.clock = Objects.requireNonNull(clock);
        this.deskId = deskId;
        this.account = account;
        this.guildDesk = guildDesk;
        this.grants = new DeskGrants(clock);
        this.sources = new DeskSources(clock);
    }

    /** Keeps the record, and this desk's keys, in deskd's own data directory. */
    public void keepIn(Path dir) {
        directory = dir;
        grants.keepIn(dir);
    }

    public DeskGrants grants() {
        return grants;
    }

    /** This desk's keys, made the first time they're needed; null while the desk's id isn't known or they can't be kept. */
    public DeskKeys keys() {
        DeskKeys known = keys;
        if (known != null) {
            return known;
        }
        keysLock.lock();
        try {
            if (keys != null) {
                return keys;
            }
            String id = deskId.get();
            if (id == null || !DeskKeys.DESK_ID.matcher(id).matches()) {
                return null;
            }
            Path dir = directory;
            try {
                keys = dir == null ? DeskKeys.fresh(id) : DeskKeys.loadOrCreate(dir, id);
            } catch (IOException e) {
                log.warn("this desk's message keys couldn't be kept ({}), so it sends and takes in nothing",
                        e.getClass().getSimpleName());
                return null;
            }
            return keys;
        } finally {
            keysLock.unlock();
        }
    }

    /** For tests: these keys, in place of the desk's own. */
    public void keysForTest(DeskKeys testKeys) {
        this.keys = testKeys;
    }

    private void requireOn() throws Refused {
        if (guildDesk.getAsBoolean()) {
            throw new Refused("guild");
        }
    }

    private DeskKeys requireKeys() throws Refused {
        DeskKeys k = keys();
        if (k == null) {
            throw new Refused("unavailable");
        }
        return k;
    }

    private String requireAccount() throws Refused {
        String a = account.get();
        if (a == null || a.isEmpty()) {
            throw new Refused("account");
        }
        return a;
    }

    private Map<String, Object> payload(DeskKeys me, String kind, String id, String grantId, String to, long seq)
            throws Refused {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", 1);
        p.put("kind", kind);
        p.put("id", id);
        p.put("grantId", grantId);
        p.put("from", me.deskId());
        p.put("to", to);
        p.put("account", requireAccount());
        p.put("sentAt", clock.millis());
        p.put("seq", seq);
        return p;
    }

    // ---------------------------------------------------------------- envelopes out

    /**
     * The member switched {@code peerDeskId} on for agent X (their relayed {@code agent.access.set}), and desk-agent made
     * the send half {@code grantId}: recorded {@code offered}, and the offer made, signed only, with this desk's keys.
     * Null when the half was already there (the offer went then).
     */
    public Made offer(String grantId, String agentId, String agentName, String peerDeskId) throws Refused {
        requireOn();
        DeskKeys me = requireKeys();
        // A desk id or agent id that isn't one would make the record unreadable at the next load, so none is recorded.
        if (peerDeskId == null || !DeskKeys.DESK_ID.matcher(peerDeskId).matches() || agentId(agentId) == null) {
            throw new Refused("input");
        }
        if (peerDeskId.equals(me.deskId())) {
            throw new Refused("self");
        }
        if (grants.half(grantId) != null) {
            return null;
        }
        grants.sendOffered(grantId, agentId, peerDeskId);
        long seq = grants.nextSeq(grantId, false, 0);
        String id = Envelope.newId();
        Map<String, Object> p = payload(me, "offer", id, grantId, peerDeskId, seq);
        p.put("fromAgentId", agentId);
        p.put("fromAgentName", name(agentName));
        p.put("keys", me.pub().toJson());
        try {
            return owe(new Made(id, grantId, peerDeskId, "offer", seq, Envelope.signed(me, peerDeskId, p)));
        } catch (GeneralSecurityException e) {
            throw new Refused("unavailable");
        }
    }

    /**
     * The member allowed an offer here (their relayed {@code agent.desks.answer}) with agent Y answering: the answer half
     * {@code active}, and the accept made, sealed to the key the offer carried, with this desk's keys and Y.
     */
    public Made accept(String grantId, String agentId, String agentName) throws Refused {
        requireOn();
        DeskKeys me = requireKeys();
        DeskGrants.Half half = grants.half(grantId);
        if (half == null || half.role() != DeskGrants.Role.ANSWER || half.revoked()) {
            throw new Refused("no_grant");
        }
        boolean already = half.active();
        DeskGrants.Half after = grants.answerAllowed(grantId, agentId);
        if (after == null || !after.active()) {
            throw new Refused("no_grant");
        }
        if (already && agentId.equals(half.agentId())) {
            return null;
        }
        long seq = grants.nextSeq(grantId, false, 0);
        String id = Envelope.newId();
        Map<String, Object> p = payload(me, "accept", id, grantId, half.peerDeskId(), seq);
        p.put("answeredBy", agentId);
        p.put("answeredByName", name(agentName));
        p.put("keys", me.pub().toJson());
        try {
            return owe(new Made(id, grantId, half.peerDeskId(), "accept", seq, Envelope.seal(me, half.peer(), p)));
        } catch (GeneralSecurityException e) {
            throw new Refused("unavailable");
        }
    }

    /** Not now: the offer stays, {@code declined}, and nothing goes back. */
    public void decline(String grantId) {
        grants.answerDeclined(grantId);
    }

    /**
     * This desk's half revoked (either side's Stop, or a deleted agent), and a revoke made for the other desk: sealed
     * when there's a key pinned for it, else signed only. Null for a half that's gone or was already revoked.
     */
    public Made revoke(String grantId) {
        DeskGrants.Half half = grants.half(grantId);
        if (half == null || half.revoked()) {
            return null;
        }
        grants.revoke(grantId);
        DeskKeys me = keys();
        if (me == null || guildDesk.getAsBoolean()) {
            return null;
        }
        try {
            long seq = grants.nextSeq(grantId, false, 0);
            String id = Envelope.newId();
            Map<String, Object> p = payload(me, "revoke", id, grantId, half.peerDeskId(), seq);
            Map<String, Object> env = half.peer() != null ? Envelope.seal(me, half.peer(), p)
                    : Envelope.signed(me, half.peerDeskId(), p);
            return owe(new Made(id, grantId, half.peerDeskId(), "revoke", seq, env));
        } catch (Refused | GeneralSecurityException e) {
            return null;
        }
    }

    /** Every live half of a deleted agent revoked, each with its revoke for the other desk. */
    public List<Made> agentGone(String agentId) {
        List<Made> out = new ArrayList<>();
        for (DeskGrants.Half half : grants.liveOf(agentId)) {
            Made made = revoke(half.grantId());
            if (made != null) {
                out.add(made);
            }
        }
        return out;
    }

    /**
     * {@code desk_message}'s envelope (draft ADR §14): agent X's active send half to {@code peerDeskId} by this desk's
     * own record, within the day's {@link #PER_DAY}, sealed to the key pinned for it.
     */
    public Made message(String agentId, String agentName, String peerDeskId, String text) throws Refused {
        return message(agentId, agentName, peerDeskId, text, false);
    }

    /**
     * The same, saying whether the sending run held the member's private data here ({@code S}, deskd's own ledger), so
     * the answering run on the other desk starts with it too and its browsing asks (Security's DMA-M1): a message Desk
     * Maia sends under her grant without a card can carry what she read from another of the member's desks.
     */
    public Made message(String agentId, String agentName, String peerDeskId, String text, boolean privateData)
            throws Refused {
        requireOn();
        DeskKeys me = requireKeys();
        DeskGrants.Half half = grants.activeSend(agentId, peerDeskId);
        if (half == null || half.peer() == null) {
            throw new Refused("no_grant");
        }
        requireText(text);
        long seq = grants.nextSeq(half.grantId(), true, PER_DAY);
        if (seq < 0) {
            throw new Refused("rate");
        }
        String id = Envelope.newId();
        Map<String, Object> p = payload(me, "msg", id, half.grantId(), peerDeskId, seq);
        p.put("fromAgentId", agentId);
        p.put("fromAgentName", name(agentName));
        p.put("text", text);
        p.put("private", privateData);
        try {
            return new Made(id, half.grantId(), peerDeskId, "msg", seq, Envelope.seal(me, half.peer(), p));
        } catch (GeneralSecurityException e) {
            throw new Refused("unavailable");
        }
    }

    /**
     * {@code desk_answer}'s envelope: agent Y's active answer half {@code grantId} by this desk's own record, Y being the
     * agent the member chose, sealed back to desk A. {@code failed}, a word, in place of a text when Y couldn't answer;
     * {@code privateData} says Y's run held the member's private data here (A marks the answer so).
     */
    public Made answer(String agentId, String agentName, String grantId, String replyTo, String text, String failed,
            boolean privateData) throws Refused {
        requireOn();
        DeskKeys me = requireKeys();
        DeskGrants.Half half = grants.half(grantId);
        if (half == null || half.role() != DeskGrants.Role.ANSWER || !half.active() || half.peer() == null
                || !agentId.equals(half.agentId())) {
            throw new Refused("no_grant");
        }
        if (replyTo == null || !Envelope.ID.matcher(replyTo).matches()) {
            throw new Refused("input");
        }
        if (failed == null) {
            requireText(text);
        } else if (!WORD.matcher(failed).matches()) {
            throw new Refused("input");
        }
        long seq = grants.nextSeq(grantId, true, PER_DAY);
        if (seq < 0) {
            throw new Refused("rate");
        }
        String id = Envelope.newId();
        Map<String, Object> p = payload(me, "answer", id, grantId, half.peerDeskId(), seq);
        p.put("replyTo", replyTo);
        p.put("answeredBy", agentId);
        p.put("answeredByName", name(agentName));
        if (failed == null) {
            p.put("text", text);
        } else {
            p.put("failed", failed);
        }
        p.put("private", privateData);
        try {
            return new Made(id, grantId, half.peerDeskId(), "answer", seq, Envelope.seal(me, half.peer(), p));
        } catch (GeneralSecurityException e) {
            throw new Refused("unavailable");
        }
    }

    /** Whether agent X can message that desk now, by this record: {@code null}, or the refusal's word. */
    public String messageRefusal(String agentId, String peerDeskId) {
        if (guildDesk.getAsBoolean()) {
            return "guild";
        }
        DeskGrants.Half half = grants.activeSend(agentId, peerDeskId);
        if (half == null || half.peer() == null) {
            return "no_grant";
        }
        if (clock.millis() - half.day() < DAY_MS && half.dayCount() >= PER_DAY) {
            return "rate";
        }
        return null;
    }

    /** Whether agent Y can answer on that grant now: {@code null}, or the refusal's word. */
    public String answerRefusal(String agentId, String grantId) {
        if (guildDesk.getAsBoolean()) {
            return "guild";
        }
        DeskGrants.Half half = grants.half(grantId);
        if (half == null || half.role() != DeskGrants.Role.ANSWER || !half.active() || !agentId.equals(half.agentId())) {
            return "no_grant";
        }
        if (clock.millis() - half.day() < DAY_MS && half.dayCount() >= PER_DAY) {
            return "rate";
        }
        return null;
    }

    private Made owe(Made made) {
        if (!grants.owe(made.owed())) {
            log.warn("too many envelopes wait for desk-agent's outbox: this one is dropped");
        }
        return made;
    }

    private static void requireText(String text) throws Refused {
        if (text == null || text.isBlank() || text.length() > MAX_TEXT) {
            throw new Refused("input");
        }
    }

    /** A name as far as an envelope carries it: the other desk shows it as plain text only. */
    static String name(String name) {
        if (name == null) {
            return null;
        }
        String n = name.strip();
        return n.length() > MAX_NAME ? n.substring(0, MAX_NAME) : n;
    }

    // ---------------------------------------------------------------- envelopes in

    /**
     * An envelope the office brought ({@code agent.desks.deliver}), checked as the class says, with this desk's record
     * changed for what it says (an offer pending, an accept active, a revoke revoked): what desk-agent is handed, only
     * the fields each kind has, every one checked.
     */
    public Map<String, Object> open(Object envelope) throws Refused {
        requireOn();
        if (Envelope.size(envelope) > Envelope.MAX_BYTES) {
            throw new Refused("too_large");
        }
        DeskKeys me = requireKeys();
        Envelope.Opened opened;
        try {
            opened = Envelope.open(me, envelope);
        } catch (Envelope.Rejected e) {
            throw new Refused(e.reason());
        }
        Map<String, Object> p = opened.payload();
        if (!requireAccount().equals(p.get("account"))) {
            throw new Refused("account");
        }
        long sentAt = ((Number) p.get("sentAt")).longValue();
        long now = clock.millis();
        if (sentAt > now + MAX_AHEAD_MS) {
            throw new Refused("envelope");
        }
        if (now - sentAt > MAX_AGE_MS) {
            throw new Refused("expired");
        }
        String grantId = opened.grantId();
        DeskGrants.Half half = grants.half(grantId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", opened.id());
        out.put("kind", opened.kind());
        out.put("grantId", grantId);
        out.put("fromDeskId", opened.from());
        out.put("seq", ((Number) p.get("seq")).longValue());
        out.put("sentAt", sentAt);
        switch (opened.kind()) {
            case "offer" -> {
                DeskKeys.Pub peer = DeskKeys.Pub.fromJson(opened.from(), p.get("keys"));
                String fromAgent = agentId(p.get("fromAgentId"));
                if (peer == null || fromAgent == null || !Envelope.verify(peer, opened)) {
                    throw new Refused("bad_signature");
                }
                if (half != null && half.revoked()) {
                    throw new Refused("revoked");
                }
                if (!grants.answerPending(grantId, opened.from(), fromAgent, peer)) {
                    // Another desk's offer under the same grant id, or another key: never the first one's grant.
                    throw new Refused("bad_signature");
                }
                out.put("fromAgentId", fromAgent);
                out.put("fromAgentName", nameOf(p.get("fromAgentName")));
            }
            case "accept" -> {
                if (half == null || half.role() != DeskGrants.Role.SEND || !half.peerDeskId().equals(opened.from())) {
                    throw new Refused("no_grant");
                }
                if (half.revoked()) {
                    throw new Refused("revoked");
                }
                DeskKeys.Pub peer = DeskKeys.Pub.fromJson(opened.from(), p.get("keys"));
                String answeredBy = agentId(p.get("answeredBy"));
                // Sealed to this desk's key, which only the offer carried: and signed by the key it carries.
                if (!opened.sealed() || peer == null || answeredBy == null || !Envelope.verify(peer, opened)) {
                    throw new Refused("bad_signature");
                }
                if (half.peer() != null && !half.peer().sameAs(peer)) {
                    throw new Refused("bad_signature");
                }
                grants.accepted(grantId, answeredBy, peer);
                out.put("answeredBy", answeredBy);
                out.put("answeredByName", nameOf(p.get("answeredByName")));
            }
            case "msg" -> {
                requireHalf(half, DeskGrants.Role.ANSWER, opened);
                String fromAgent = agentId(p.get("fromAgentId"));
                if (fromAgent == null || !fromAgent.equals(half.peerAgentId())) {
                    throw new Refused("no_grant");
                }
                String text = textOf(p.get("text"));
                countIn(grantId, opened.id(), now);
                out.put("fromAgentId", fromAgent);
                out.put("fromAgentName", nameOf(p.get("fromAgentName")));
                out.put("agentId", half.agentId());
                out.put("text", text);
                // Only Desk Maia's brief carries it (DeskTools): her words held the member's private data (DMA-M1).
                boolean privateBrief = DeskTools.MAIA.equals(fromAgent) && Boolean.TRUE.equals(p.get("private"));
                out.put("private", privateBrief);
                sources.received(opened.id(), half.agentId(), opened.from(), nameOf(p.get("fromAgentName")),
                        privateBrief);
            }
            case "answer" -> {
                requireHalf(half, DeskGrants.Role.SEND, opened);
                if (!(p.get("replyTo") instanceof String replyTo) || !Envelope.ID.matcher(replyTo).matches()) {
                    throw new Refused("envelope");
                }
                String answeredBy = agentId(p.get("answeredBy"));
                if (answeredBy == null) {
                    throw new Refused("envelope");
                }
                countIn(grantId, opened.id(), now);
                out.put("replyTo", replyTo);
                out.put("answeredBy", answeredBy);
                out.put("answeredByName", nameOf(p.get("answeredByName")));
                out.put("agentId", half.agentId());
                boolean privateAnswer = Boolean.TRUE.equals(p.get("private"));
                if (p.get("failed") instanceof String failed && WORD.matcher(failed).matches()) {
                    out.put("failed", failed);
                } else {
                    out.put("text", textOf(p.get("text")));
                    // An answer with words, for this desk's agent by its grant: a To-do source its later run may name.
                    sources.answered(opened.id(), half.agentId(), opened.from(), nameOf(p.get("answeredByName")),
                            privateAnswer);
                }
                out.put("private", privateAnswer);
            }
            case "revoke" -> {
                if (half == null || !half.peerDeskId().equals(opened.from())) {
                    throw new Refused("no_grant");
                }
                DeskKeys.Pub key = half.peer();
                if (key == null || (!opened.sealed() && half.role() == DeskGrants.Role.SEND)) {
                    // A send half not yet accepted has no key pinned, and nothing but its own desk can take it back.
                    throw new Refused("bad_signature");
                }
                if (!Envelope.verify(key, opened)) {
                    throw new Refused("bad_signature");
                }
                grants.revoke(grantId);
                out.put("agentId", half.agentId());
            }
            default -> throw new Refused("envelope");
        }
        return out;
    }

    /** A sealed envelope on an active half of this role, from the desk it names, signed by its pinned key. */
    private static void requireHalf(DeskGrants.Half half, DeskGrants.Role role, Envelope.Opened opened) throws Refused {
        if (half == null || half.role() != role || !half.peerDeskId().equals(opened.from())) {
            throw new Refused("no_grant");
        }
        if (half.revoked()) {
            throw new Refused("revoked");
        }
        if (!half.active()) {
            throw new Refused("no_grant");
        }
        if (!opened.sealed() || !Envelope.verify(half.peer(), opened)) {
            throw new Refused("bad_signature");
        }
    }

    /** The inbound cap: {@link #PER_DAY} distinct envelopes a grant a day, a retry of one counting once. */
    private void countIn(String grantId, String id, long now) throws Refused {
        Map<String, Long> seen = inToday.computeIfAbsent(grantId, g -> new ConcurrentHashMap<>());
        seen.values().removeIf(at -> now - at >= DAY_MS);
        if (!seen.containsKey(id) && seen.size() >= PER_DAY) {
            throw new Refused("rate");
        }
        seen.putIfAbsent(id, now);
    }

    /** To-do's source kind {@code desk}: which run was given which message from another of the member's desks. */
    public DeskSources sources() {
        return sources;
    }

    /** The other desk refused an envelope of this half as revoked: this half is too. Only takes away. */
    public void peerRevoked(String grantId) {
        grants.revoke(grantId);
    }

    private static String agentId(Object value) {
        return value instanceof String s && AGENT_ID.matcher(s).matches() ? s : null;
    }

    private static String nameOf(Object value) {
        return value instanceof String s ? name(s) : null;
    }

    private static String textOf(Object value) throws Refused {
        if (!(value instanceof String s) || s.isBlank() || s.length() > MAX_TEXT) {
            throw new Refused("envelope");
        }
        return s;
    }

    /** No content in logs. */
    @Override
    public String toString() {
        return "DeskMessaging[" + grants.all().size() + " halves]";
    }

    /** The envelopes desk-agent hasn't taken yet, as {@code desk.desks.queue}'s params. */
    public Map<String, Object> queueParams() {
        List<Object> list = new ArrayList<>();
        for (DeskGrants.Owed o : grants.owed()) {
            list.add(o.toJson());
        }
        return Map.of("envelopes", list);
    }

    /** desk-agent's answer to {@code desk.desks.queue}: what it has, which stops being owed. */
    public void queued(Object answer) {
        if (answer instanceof Map<?, ?> a && a.get("ids") instanceof List<?> ids) {
            List<String> taken = new ArrayList<>();
            for (Object id : ids) {
                if (id instanceof String s) {
                    taken.add(s);
                }
            }
            grants.handed(taken);
        }
    }

    static String json(Object value) {
        return new String(Json.bytes(value), java.nio.charset.StandardCharsets.UTF_8);
    }
}
