package com.minimalistalliance.desk.deskd.session;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.SessionEvents;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.Reassembler;
import com.minimalistalliance.desk.deskd.protocol.ReassemblyBudget;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.rtc.RtcException;
import com.minimalistalliance.desk.deskd.rtc.RtcListener;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Predicate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The live sessions of this desk. Nothing is processed for a session that didn't come through
 * {@link #open} with a token the {@link SessionAuthorizer} verified: frames for any other handle are
 * dropped on arrival.
 *
 * <p>The gateway link drives {@link #open}, {@link #offer}, {@link #iceRestart},
 * {@link #refresh(String, String)} and {@link #close}. desk-rtc drives the rest, through
 * {@link RtcListener}.
 */
public final class SessionManager implements RtcListener {

    private static final Logger log = LoggerFactory.getLogger(SessionManager.class);

    public static final String DESK_API = "1.0";
    /** Platform's limit, desk-endpoint.md section 6. */
    public static final int MAX_SESSIONS = 4;
    /** A guild desk's members, each with their own sessions outside the owner's limit (API.md section 14). */
    public static final int MAX_GUILD_MEMBERS = 200;
    /** Sessions per member on a guild desk: a 4th from another tab is refused, as the owner's 5th is. */
    public static final int MAX_MEMBER_SESSIONS = 3;
    /** Every session a guild desk can have. */
    public static final int MAX_GUILD_SESSIONS = MAX_GUILD_MEMBERS * MAX_MEMBER_SESSIONS;
    /** On ctl, with 4401: the guild's roster changed this member, who comes back with a fresh token, or not at all. */
    public static final String REASON_MEMBER_CHANGED = "member_changed";
    /** How long a dropped client's state waits for a resume (design 4.2.7). */
    public static final Duration RESUME_WINDOW = Duration.ofMinutes(2);

    /** A session with a verified token but no offer gives its slot back after this. */
    private static final Duration OFFER_TIMEOUT = Duration.ofSeconds(60);
    /** Retained states beyond the live sessions; past it the oldest goes. */
    private static final int MAX_RETAINED = 8;
    /** The same on a guild desk, where many more come and go. Each holds its subscriptions' rings, up to 1 MiB. */
    private static final int MAX_GUILD_RETAINED = 64;
    private static final int RESUME_TOKEN_BYTES = 32;
    private static final int MAX_SESSION_ID_CHARS = 128;
    private static final Map<String, Object> LIMITS = buildLimits(MAX_SESSIONS);
    private static final Map<String, Object> MEMBER_LIMITS = buildLimits(MAX_MEMBER_SESSIONS);

    /** What HELLO produces: the client's state, new or carried over, and its new resume token. */
    record HelloOutcome(SessionEvents events, byte[] token, boolean resumed) {}

    private record Retained(String sessionId, byte[] token, SessionGrant grant, SessionEvents events,
            AtomicReference<Thread> timer) {}

    private final RtcClient rtc;
    private final SessionAuthorizer authorizer;
    private final RpcDispatcher rpc;
    private final EventHub hub;
    private final DeskFacts facts;
    private final String version;
    private final Instant startedAt;
    private final Duration resumeWindow;
    private final SecureRandom random = new SecureRandom();
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, Session> live = new LinkedHashMap<>();
    private final Map<String, Retained> retained = new LinkedHashMap<>();
    private final Map<Long, Session> byHandle = new ConcurrentHashMap<>();
    private final Map<Integer, ChannelHandler> channelHandlers = new ConcurrentHashMap<>();
    /** True until a session gets past session.open, which is the one {@link SessionTiming} calls first. */
    private final AtomicBoolean noSessionYet = new AtomicBoolean(true);
    private volatile SessionObserver observer = (sessionId, reason) -> {};
    private final List<SessionListener> sessionListeners = new CopyOnWriteArrayList<>();
    private volatile Instant lastInputAt;
    /** The last time a guild member used the guild: a request, a subscription, or a message on collab or commons. */
    private volatile Instant lastGuildActivityAt;
    private volatile boolean stopping;

    public SessionManager(
            RtcClient rtc,
            SessionAuthorizer authorizer,
            RpcDispatcher rpc,
            EventHub hub,
            DeskFacts facts,
            String version,
            Instant startedAt) {
        this(rtc, authorizer, rpc, hub, facts, version, startedAt, RESUME_WINDOW);
    }

    SessionManager(
            RtcClient rtc,
            SessionAuthorizer authorizer,
            RpcDispatcher rpc,
            EventHub hub,
            DeskFacts facts,
            String version,
            Instant startedAt,
            Duration resumeWindow) {
        this.rtc = rtc;
        this.authorizer = authorizer;
        this.rpc = rpc;
        this.hub = hub;
        this.facts = facts;
        this.version = version;
        this.startedAt = startedAt;
        this.resumeWindow = resumeWindow;
    }

    public void setObserver(SessionObserver observer) {
        this.observer = observer;
    }

    /** For the modules that follow sessions as they end: the Browser, then data. They hear in the order they were added. */
    public void addSessionListener(SessionListener listener) {
        sessionListeners.add(listener);
    }

    /** Gives collab, mdoc or bulk to a module. Until one does, their messages are dropped. */
    public void registerChannelHandler(int channel, ChannelHandler handler) {
        if (channel < Channels.COLLAB || channel > Channels.BULK) {
            throw new IllegalArgumentException("not a module channel");
        }
        channelHandlers.put(channel, handler);
    }

    /**
     * session.open from the gateway: verifies the token and reserves a slot. Nothing is allocated in
     * desk-rtc until the offer.
     *
     * @throws SessionAuthorizer.RefusedException with a code for session.reject
     */
    public void open(String sessionId, String deskToken) throws SessionAuthorizer.RefusedException {
        open(sessionId, deskToken, System.nanoTime());
    }

    /**
     * {@link #open(String, String)}, for a caller that knows when the message arrived.
     *
     * @param received {@link System#nanoTime} on arrival, for {@link SessionTiming}
     */
    public void open(String sessionId, String deskToken, long received) throws SessionAuthorizer.RefusedException {
        if (sessionId == null || sessionId.isEmpty() || sessionId.length() > MAX_SESSION_ID_CHARS) {
            throw new SessionAuthorizer.RefusedException("invalid_token");
        }
        if (stopping || !rtc.isConfigured()) {
            throw new SessionAuthorizer.RefusedException("desk_not_ready");
        }
        List<Session> replaced = new ArrayList<>();
        // Before the jti is used up, so a token turned away from a full desk can try again.
        SessionGrant grant = authorizer.authorizeOpen(deskToken, candidate -> {
            lock.lock();
            try {
                if (live.containsKey(sessionId)) {
                    throw new SessionAuthorizer.RefusedException("invalid_token");
                }
                for (Session session : live.values()) {
                    if (session.grant().sameHolder(candidate)) {
                        replaced.add(session);
                    }
                }
                if (!roomFor(candidate, replaced.size())) {
                    throw new SessionAuthorizer.RefusedException("session_limit_reached");
                }
            } finally {
                lock.unlock();
            }
        });
        // One tab holds one session per desk, so a new one from the same certificate replaces it.
        for (Session session : replaced) {
            log.info("session replaced by a newer one from the same tab");
            session.closeByDesk(CloseCodes.REPLACED, CloseCodes.REASON_REPLACED, true, true);
        }
        SessionTiming timing = new SessionTiming(received);
        Session session = new Session(this, rtc, sessionId, grant, timing);
        lock.lock();
        try {
            if (!roomFor(grant, 0) || live.containsKey(sessionId)) {
                throw new SessionAuthorizer.RefusedException("session_limit_reached");
            }
            live.put(sessionId, session);
        } finally {
            lock.unlock();
        }
        // A revocation records itself and then scans live, so one that came after the token's check
        // and before the put scanned nothing, and its repeats scan nothing either. Either it shows
        // here, or its scan comes after the put and finds this session.
        if (authorizer.isRevoked(grant)) {
            lock.lock();
            try {
                live.remove(sessionId, session);
            } finally {
                lock.unlock();
            }
            throw new SessionAuthorizer.RefusedException("invalid_token");
        }
        timing.first(noSessionYet.getAndSet(false));
        session.armExpiry();
        session.armOfferTimer(OFFER_TIMEOUT);
        for (SessionListener listener : sessionListeners) {
            listener.onSessionOpened(sessionId);
        }
    }

    /** What desk-rtc is told it may hold: a guild desk's members' sessions, or the owner's 4. */
    public static int maxSessions(boolean guildDesk) {
        return guildDesk ? MAX_GUILD_SESSIONS : MAX_SESSIONS;
    }

    /**
     * With the lock held. The owner has 4 sessions. A guild member has 3, outside that limit, and the desk 200 members:
     * a member's 4th from another tab, or a 201st member, is refused, as the owner's 5th is, and the same tab replaces its
     * own session, as the owner's does.
     *
     * @param leaving sessions this one replaces, which don't count
     */
    private boolean roomFor(SessionGrant candidate, int leaving) {
        if (!candidate.caller().isGuildMember()) {
            int owners = 0;
            for (Session session : live.values()) {
                if (!session.grant().caller().isGuildMember()) {
                    owners++;
                }
            }
            return owners - leaving < MAX_SESSIONS;
        }
        String memberId = candidate.caller().memberId();
        int mine = 0;
        java.util.Set<String> members = new java.util.HashSet<>();
        for (Session session : live.values()) {
            Caller caller = session.grant().caller();
            if (caller.isGuildMember()) {
                members.add(caller.memberId());
                if (memberId.equals(caller.memberId())) {
                    mine++;
                }
            }
        }
        if (mine - leaving >= MAX_MEMBER_SESSIONS) {
            return false;
        }
        return mine > 0 || members.size() < MAX_GUILD_MEMBERS;
    }

    /**
     * The guild's roster dropped this member, or changed their role, grants or teen flag: each of their sessions closes
     * now with 4401, keeping nothing for a resume, and its relays with it. A client still wanted comes back through
     * {@code connect} with a fresh token, which carries the change.
     *
     * @return how many sessions closed
     */
    public int closeMember(String memberId) {
        List<Session> toClose = new ArrayList<>();
        lock.lock();
        try {
            for (Session session : live.values()) {
                if (memberId.equals(session.grant().caller().memberId())) {
                    toClose.add(session);
                }
            }
            Iterator<Retained> iterator = retained.values().iterator();
            while (iterator.hasNext()) {
                Retained entry = iterator.next();
                if (memberId.equals(entry.grant().caller().memberId())) {
                    iterator.remove();
                    discard(entry);
                }
            }
        } finally {
            lock.unlock();
        }
        for (Session session : toClose) {
            session.closeByDesk(CloseCodes.TOKEN_EXPIRED_OR_REVOKED, REASON_MEMBER_CHANGED, false, true);
        }
        // And any of theirs desk-rtc has that deskd doesn't yet, such as one still being created.
        if (facts.guildDesk()) {
            rtc.closeMember(memberId, REASON_MEMBER_CHANGED);
        }
        return toClose.size();
    }

    /** Every guild member with a session now, as each session's caller says: one entry per session. */
    public List<Caller> memberCallers() {
        List<Caller> callers = new ArrayList<>();
        for (Session session : snapshot()) {
            Caller caller = session.grant().caller();
            if (caller.isGuildMember()) {
                callers.add(caller);
            }
        }
        return callers;
    }

    /** Guild members with a session open now, each once. */
    public int connectedMembers() {
        java.util.Set<String> members = new java.util.HashSet<>();
        for (Session session : snapshot()) {
            Caller caller = session.grant().caller();
            if (caller.isGuildMember() && session.isHelloDone()) {
                members.add(caller.memberId());
            }
        }
        return members.size();
    }

    /** The last time a guild member used the guild, for the heartbeat's {@code guild}. Null if none has since deskd started. */
    public Instant lastGuildActivityAt() {
        return lastGuildActivityAt;
    }

    /** A guild member did something: never moves back. */
    void noteGuildActivity() {
        Instant now = Instant.now();
        Instant last = lastGuildActivityAt;
        if (last == null || now.isAfter(last)) {
            lastGuildActivityAt = now;
        }
    }

    /** The accept for this session has been written. */
    public void openAnswered(String sessionId) {
        Session session = liveSession(sessionId);
        if (session != null) {
            session.timing().openAnswered();
        }
    }

    /**
     * The reject for a session.open has been written, which is all there'll be of it.
     *
     * @param received the arrival {@link #open(String, String, long)} was given
     */
    public void openRefused(long received) {
        SessionTiming.logRefused(noSessionYet.get(), received);
    }

    /**
     * The client's offer, from signal: checks it and asks desk-rtc for a session. Parks until
     * desk-rtc answers. Any refusal also reaches {@link SessionObserver#onOfferRefused} and ends the
     * session.
     *
     * @return the SDP answer
     * @throws SessionAuthorizer.RefusedException with the refusal's code
     */
    public String offer(String sessionId, String sdp)
            throws SessionAuthorizer.RefusedException, InterruptedException {
        return offer(sessionId, sdp, System.nanoTime());
    }

    /**
     * {@link #offer(String, String)}, for a caller that knows when the message arrived.
     *
     * @param received {@link System#nanoTime} on arrival, for {@link SessionTiming}
     */
    public String offer(String sessionId, String sdp, long received)
            throws SessionAuthorizer.RefusedException, InterruptedException {
        Session session = requireForOffer(sessionId);
        session.timing().offerReceived(received);
        SessionGrant grant = session.grant();
        if (!SdpFingerprints.offerMatches(sdp, grant.expectedFingerprint())) {
            log.warn("session closed: offer fingerprint differs from the token's");
            throw refuse(session, CloseCodes.REASON_IDENTITY_MISMATCH, CloseCodes.FORBIDDEN, CloseCodes.REASON_IDENTITY_MISMATCH);
        }
        if (!session.beginNegotiating()) {
            throw refuse(session, "bad_state", CloseCodes.PROTOCOL_ERROR, CloseCodes.REASON_CLOSED_BY_DESK);
        }
        SessionGrant permitted = session.grantForCreate();
        session.timing().createSent();
        try {
            return rtc.createSession(sessionId, sdp, grant.expectedFingerprint(), permitted.video(), permitted.input(),
                    grant.caller().memberId()).answer();
        } catch (RtcException e) {
            log.warn("session closed: desk-rtc refused it: {}", e.code());
            // After a timeout desk-rtc may have allocated it, so it still needs to hear the close.
            if (!"timeout".equals(e.code())) {
                session.negotiationRefused();
            }
            throw refuse(session, e.code(), CloseCodes.INTERNAL, e.code());
        }
    }

    /**
     * An ICE restart: a later offer on a live session, checked the same way. Parks until desk-rtc
     * answers. A refusal ends the session, and the client then starts a new connection and resumes.
     */
    public String iceRestart(String sessionId, String sdp)
            throws SessionAuthorizer.RefusedException, InterruptedException {
        Session session = requireForOffer(sessionId);
        if (session.state() != Session.State.BOUND) {
            throw refuse(session, "bad_state", CloseCodes.PROTOCOL_ERROR, CloseCodes.REASON_CLOSED_BY_DESK);
        }
        if (!SdpFingerprints.offerMatches(sdp, session.grant().expectedFingerprint())) {
            log.warn("session closed: restart offer fingerprint differs from the token's");
            throw refuse(session, CloseCodes.REASON_IDENTITY_MISMATCH, CloseCodes.FORBIDDEN, CloseCodes.REASON_IDENTITY_MISMATCH);
        }
        try {
            return rtc.iceRestart(sessionId, sdp).answer();
        } catch (RtcException e) {
            log.warn("session closed: ICE restart failed: {}", e.code());
            throw refuse(session, e.code(), CloseCodes.INTERNAL, e.code());
        }
    }

    /** The answer to this session's offer has been written. */
    public void answerSent(String sessionId) {
        Session session = liveSession(sessionId);
        if (session != null) {
            session.timing().answerSent();
        }
    }

    /** Refuses an answer deskd can't deliver, such as one too large for the gateway. */
    public void abandonOffer(String sessionId, String code) {
        Session session = liveSession(sessionId);
        if (session != null) {
            refuse(session, code, CloseCodes.INTERNAL, CloseCodes.REASON_CLOSED_BY_DESK);
        }
    }

    private Session requireForOffer(String sessionId) throws SessionAuthorizer.RefusedException {
        Session session = liveSession(sessionId);
        if (session == null) {
            // The gateway thinks it's open, so it needs to hear otherwise.
            observer.onOfferRefused(sessionId, "unknown_session");
            observer.onSessionClosed(sessionId, CloseCodes.REASON_CLOSED_BY_DESK);
            throw new SessionAuthorizer.RefusedException("unknown_session");
        }
        return session;
    }

    /** Tells the client first, then ends the session, so the gateway relays them in that order. */
    private SessionAuthorizer.RefusedException refuse(Session session, String code, int closeCode, String reason) {
        observer.onOfferRefused(session.sessionId(), code);
        session.closeByDesk(closeCode, reason, false, true);
        return new SessionAuthorizer.RefusedException(code);
    }

    /**
     * session.refresh from the gateway.
     *
     * @throws SessionAuthorizer.RefusedException if the token doesn't pass
     */
    public void refresh(String sessionId, String deskToken) throws SessionAuthorizer.RefusedException {
        String failure = refresh(require(sessionId), deskToken);
        if (failure != null) {
            throw new SessionAuthorizer.RefusedException(failure);
        }
    }

    /**
     * session.close from the gateway. Its client_gone and closed_by_client can both come before the
     * client opens a new session and resumes: closed_by_client is how the web client ends a session
     * whose ICE restart failed. So both keep the state for the resume window. CLOSE on ctl doesn't.
     */
    public void close(String sessionId, int code, String reason) {
        Session session;
        lock.lock();
        try {
            session = live.get(sessionId);
        } finally {
            lock.unlock();
        }
        if (session != null) {
            boolean retain = CloseCodes.REASON_CLIENT_GONE.equals(reason) || CloseCodes.REASON_CLOSED_BY_CLIENT.equals(reason);
            session.closeByDesk(code, reason, retain, true);
        }
    }

    /** A revocation: matching sessions close at once with 4401, and no resume state survives. */
    public void revoke(Predicate<SessionGrant> matches) {
        List<Session> toClose = new ArrayList<>();
        lock.lock();
        try {
            for (Session session : live.values()) {
                if (matches.test(session.grant())) {
                    toClose.add(session);
                }
            }
            Iterator<Retained> iterator = retained.values().iterator();
            while (iterator.hasNext()) {
                Retained entry = iterator.next();
                if (matches.test(entry.grant())) {
                    iterator.remove();
                    discard(entry);
                }
            }
        } finally {
            lock.unlock();
        }
        for (Session session : toClose) {
            session.closeByDesk(CloseCodes.TOKEN_EXPIRED_OR_REVOKED, CloseCodes.REASON_REVOKED, false, true);
        }
    }

    /**
     * deskd is going down, and no new sessions open. 4503 tells a client to stop retrying, so it's only
     * for when the desk really is stopping. Otherwise this is a restart, as ma-update does, and clients
     * should come straight back.
     *
     * @param deskStopping true if the desk is going down too: 4503, not 4002
     */
    public void stop(boolean deskStopping) {
        stopping = true;
        int code = deskStopping ? CloseCodes.DESK_STOPPING : CloseCodes.DESKD_RESTARTING;
        String reason = deskStopping ? CloseCodes.REASON_DESK_STOPPING : CloseCodes.REASON_DESKD_RESTARTING;
        List<Thread> closing = new ArrayList<>();
        for (Session session : snapshot()) {
            Thread thread = session.closeByDesk(code, reason, false, true);
            if (thread != null) {
                closing.add(thread);
            }
        }
        for (Thread thread : closing) {
            try {
                thread.join(Duration.ofMillis(1500));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /**
     * The session open now with this id, for a module that sends on one of its channels, or null. Once it has ended
     * this stays null, and its {@link Session#send} fails.
     */
    public Session session(String sessionId) {
        return liveSession(sessionId);
    }

    /** True while this session is open. Once it has ended this stays false: ids aren't reused. */
    public boolean isLive(String sessionId) {
        return liveSession(sessionId) != null;
    }

    /** The ids of the sessions open now, for ready and the heartbeat. */
    public List<String> sessionIds() {
        lock.lock();
        try {
            return List.copyOf(live.keySet());
        } finally {
            lock.unlock();
        }
    }

    /** Sessions past HELLO and connected, as far as desk-rtc last said. */
    public int connectedCount() {
        int count = 0;
        for (Session session : snapshot()) {
            if (session.isHelloDone() && "connected".equals(session.rtcState())) {
                count++;
            }
        }
        return count;
    }

    /** How many of the sessions {@link #connectedCount} counts use each of udp, tcp and relay. */
    public Map<String, Integer> transportCounts() {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Session session : snapshot()) {
            if (session.isHelloDone() && "connected".equals(session.rtcState()) && session.transport() != null) {
                counts.merge(session.transport(), 1, Integer::sum);
            }
        }
        return counts;
    }

    /** Latest real input from any session, for the heartbeat. Null if there has been none. */
    public Instant lastInputAt() {
        return lastInputAt;
    }

    @Override
    public boolean onSessionBound(String sessionId, long handle) {
        Session session;
        lock.lock();
        try {
            session = live.get(sessionId);
            // An ICE restart's answer repeats the handle. Another one would move the client's frames.
            if (session == null || (session.handle() >= 0 && session.handle() != handle)) {
                return false;
            }
            byHandle.put(handle, session);
        } finally {
            lock.unlock();
        }
        session.bind(handle);
        return true;
    }

    @Override
    public void onData(long handle, int channel, byte[] frame) {
        Session session = byHandle.get(handle);
        if (session != null) {
            session.onData(channel, frame);
        }
    }

    @Override
    public void onSessionState(String sessionId, String state, String transport) {
        Session session = liveSession(sessionId);
        if (session != null) {
            // disconnected and failed wait for an ICE restart; desk-rtc closes the session if none
            // comes. Missing client PINGs never matter (desk-runtime.md 4.4). closed comes just
            // before session.closed, which has the reason, so that one is what ends the session.
            session.onRtcState(state, transport);
            observer.onClientsChanged();
        }
    }

    @Override
    public void onRtcConfigured() {
        observer.onRtcConfigured();
    }

    @Override
    public void onSessionFinalBytes(String sessionId, String memberId, long bytesSent, long bytesReceived) {
        for (SessionListener listener : sessionListeners) {
            listener.onSessionFinalBytes(sessionId, memberId, bytesSent, bytesReceived);
        }
    }

    @Override
    public void onSessionClosed(String sessionId, String reason) {
        if (CloseCodes.REASON_RTC_PROTOCOL_ERROR.equals(reason) || CloseCodes.REASON_RTC_OVER_BUDGET.equals(reason)) {
            log.info("desk-rtc closed session {}: {}", sessionId, reason);
        }
        Session session = liveSession(sessionId);
        if (session != null) {
            session.closedByRtc(reason);
        }
    }

    @Override
    public void onInputActivity(String sessionId, Object at) {
        Session session = liveSession(sessionId);
        if (session != null) {
            Instant parsed = Session.parseTime(at);
            noteInput(parsed == null ? Instant.now() : parsed);
            for (SessionListener listener : sessionListeners) {
                listener.onDeskInput(sessionId);
            }
        }
    }

    @Override
    public void onStreamState(String state) {
        for (SessionListener listener : sessionListeners) {
            listener.onStreamState(state);
        }
    }

    @Override
    public void onRtcDisconnected() {
        for (Session session : snapshot()) {
            session.closedByRtc(CloseCodes.REASON_CLOSED_BY_DESK);
        }
    }

    @Override
    public void onCreditOverrun(long handle, int channel) {
        Session session = byHandle.get(handle);
        if (session != null) {
            session.closeByDesk(CloseCodes.PROTOCOL_ERROR, CloseCodes.REASON_CREDIT_VIOLATION, false, false);
        }
    }

    @Override
    public void onChannelDrained(long handle, int channel) {
        Session session = byHandle.get(handle);
        if (session != null && channel == Channels.EVENTS) {
            SessionEvents events = session.events();
            if (events != null) {
                events.onChannelDrained();
            }
        }
    }

    RpcDispatcher rpcDispatcher() {
        return rpc;
    }

    ChannelHandler channelHandler(int channel) {
        return channelHandlers.get(channel);
    }

    /** @return null if the token passed, or else the refusal code */
    String refresh(Session session, String deskToken) {
        SessionGrant current = session.grant();
        try {
            SessionGrant refreshed = authorizer.authorizeRefresh(deskToken, current);
            if (!current.sameSession(refreshed)) {
                return "invalid_token";
            }
            session.applyRefresh(refreshed);
            return null;
        } catch (SessionAuthorizer.RefusedException e) {
            return e.code();
        }
    }

    /** A refresh changed a guild member's role, grants, name, badge or teen flag: the relays tell their services. */
    void callerChanged(String sessionId) {
        for (SessionListener listener : sessionListeners) {
            listener.onCallerChanged(sessionId);
        }
    }

    private static final long TRANSFER_NOTE_NANOS = Duration.ofMinutes(1).toNanos();
    private final java.util.concurrent.atomic.AtomicLong lastTransferNote = new java.util.concurrent.atomic.AtomicLong(System.nanoTime() - TRANSFER_NOTE_NANOS);

    /**
     * Bytes of a Files transfer moved for an owner session: the member is here, as far as the idle rule goes (ADR 0026
     * counts file transfers as activity). Notes input at most once a minute, so a transfer costs one lock a minute.
     */
    public void noteTransferActivity() {
        long now = System.nanoTime();
        long last = lastTransferNote.get();
        if (now - last >= TRANSFER_NOTE_NANOS && lastTransferNote.compareAndSet(last, now)) {
            noteInput(Instant.now());
        }
    }

    /** Input happened at this time. Only ever moves forward, and never past now. */
    void noteInput(Instant at) {
        Instant now = Instant.now();
        Instant clamped = at.isAfter(now) ? now : at;
        lock.lock();
        try {
            if (lastInputAt == null || clamped.isAfter(lastInputAt)) {
                lastInputAt = clamped;
            }
        } finally {
            lock.unlock();
        }
    }

    /** Called once, by the session, as it ends. */
    void sessionEnded(Session session, String reason, boolean retain) {
        lock.lock();
        try {
            live.remove(session.sessionId(), session);
            if (session.handle() >= 0) {
                byHandle.remove(session.handle(), session);
            }
            SessionEvents events = session.events();
            if (events != null) {
                if (retain && session.isHelloDone()) {
                    retainState(session, events);
                } else {
                    hub.release(events);
                }
            }
        } finally {
            lock.unlock();
        }
        for (SessionListener listener : sessionListeners) {
            listener.onSessionEnded(session.sessionId());
        }
        observer.onSessionClosed(session.sessionId(), CloseCodes.forGateway(reason));
        observer.onClientsChanged();
    }

    /**
     * HELLO, past the version check: a resume that checks out carries the old state over, and
     * anything else gets a fresh one. A failed resume isn't an error, since the client just starts
     * clean.
     *
     * @return null if the session ended in the meantime
     */
    HelloOutcome completeHello(Session session, Map<String, Object> resume) {
        byte[] newToken = new byte[RESUME_TOKEN_BYTES];
        random.nextBytes(newToken);
        SessionEvents carried = resume == null ? null : takeOver(session, resume);
        lock.lock();
        try {
            SessionEvents events = carried != null ? carried : hub.newSession();
            if (session.hasEnded()) {
                hub.release(events);
                return null;
            }
            events.attach(session);
            session.completeHello(events, newToken);
            if (carried != null) {
                session.armDormantDrop(resumeWindow);
            }
            return new HelloOutcome(events, newToken, carried != null);
        } finally {
            lock.unlock();
        }
    }

    Map<String, Object> helloReply(Session session, HelloOutcome outcome) {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("deskApi", DESK_API);
        reply.put("sessionId", session.sessionId());
        reply.put("resumeToken", Base64.getUrlEncoder().withoutPadding().encodeToString(outcome.token()));
        reply.put("resumed", outcome.resumed());
        reply.put("serverTime", Instant.now().toString());
        reply.put("limits", session.grant().caller().isGuildMember() ? MEMBER_LIMITS : LIMITS);
        reply.put("service", "deskd");
        reply.put("version", version);
        reply.put("deskId", facts.deskId());
        reply.put("startedAt", startedAt.toString());
        reply.put("runtime", "java-21");
        return reply;
    }

    /** True if the version given is the same major as ours. Anything unreadable isn't. */
    static boolean sameMajor(String deskApi) {
        if (deskApi == null) {
            return false;
        }
        int dot = deskApi.indexOf('.');
        String major = dot < 0 ? deskApi : deskApi.substring(0, dot);
        return major.equals(DESK_API.substring(0, DESK_API.indexOf('.')));
    }

    private SessionEvents takeOver(Session session, Map<String, Object> resume) {
        String oldId = Json.string(resume, "sessionId");
        String encoded = Json.string(resume, "resumeToken");
        if (oldId == null || encoded == null) {
            return null;
        }
        byte[] presented;
        try {
            presented = Base64.getUrlDecoder().decode(encoded);
        } catch (IllegalArgumentException e) {
            return null;
        }
        SessionGrant grant = session.grant();
        Session stillLive;
        lock.lock();
        try {
            stillLive = live.get(oldId);
            if (stillLive == session
                    || stillLive == null
                    || !stillLive.isHelloDone()
                    || !MessageDigest.isEqual(stillLive.resumeToken(), presented)
                    || !stillLive.grant().sub().equals(grant.sub())
                    || !stillLive.grant().scope().equals(grant.scope())) {
                stillLive = null;
            }
        } finally {
            lock.unlock();
        }
        // desk-rtc hasn't seen the old connection go yet, but the client has moved on.
        if (stillLive != null) {
            stillLive.closeByDesk(CloseCodes.REPLACED, CloseCodes.REASON_REPLACED, true, true);
        }
        lock.lock();
        try {
            Retained entry = retained.get(oldId);
            if (entry == null
                    || !MessageDigest.isEqual(entry.token(), presented)
                    || !entry.grant().sub().equals(grant.sub())
                    || !entry.grant().scope().equals(grant.scope())) {
                return null;
            }
            retained.remove(oldId);
            Thread timer = entry.timer().get();
            if (timer != null) {
                timer.interrupt();
            }
            return entry.events();
        } finally {
            lock.unlock();
        }
    }

    private void retainState(Session session, SessionEvents events) {
        events.detach();
        Retained entry = new Retained(
                session.sessionId(), session.resumeToken(), session.grant(), events, new AtomicReference<>());
        retained.put(entry.sessionId(), entry);
        entry.timer().set(OneShot.after(resumeWindow, () -> expireRetained(entry)));
        Iterator<Retained> oldest = retained.values().iterator();
        int cap = facts.guildDesk() ? MAX_GUILD_RETAINED : MAX_RETAINED;
        while (retained.size() > cap && oldest.hasNext()) {
            Retained evicted = oldest.next();
            oldest.remove();
            discard(evicted);
        }
    }

    private void expireRetained(Retained entry) {
        lock.lock();
        try {
            if (retained.remove(entry.sessionId(), entry)) {
                hub.release(entry.events());
            }
        } finally {
            lock.unlock();
        }
    }

    private void discard(Retained entry) {
        Thread timer = entry.timer().get();
        if (timer != null) {
            timer.interrupt();
        }
        hub.release(entry.events());
    }

    private Session require(String sessionId) throws SessionAuthorizer.RefusedException {
        Session session = liveSession(sessionId);
        if (session == null) {
            throw new SessionAuthorizer.RefusedException("unknown_session");
        }
        return session;
    }

    private Session liveSession(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        lock.lock();
        try {
            return live.get(sessionId);
        } finally {
            lock.unlock();
        }
    }

    private List<Session> snapshot() {
        lock.lock();
        try {
            return new ArrayList<>(live.values());
        } finally {
            lock.unlock();
        }
    }

    private static Map<String, Object> buildLimits(int maxSessions) {
        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("maxFrameBytes", Frame.MAX_FRAME_BYTES);
        limits.put("maxRequestBytes", FrameKind.REQ.maxMessageBytes());
        limits.put("maxResponseBytes", FrameKind.RES.maxMessageBytes());
        limits.put("maxEventBytes", FrameKind.EVT.maxMessageBytes());
        limits.put("maxDataBytes", FrameKind.DATA.maxMessageBytes());
        limits.put("maxIncompleteMessagesPerChannel", Reassembler.MAX_INCOMPLETE);
        limits.put("maxIncompleteBytes", ReassemblyBudget.DEFAULT_BYTES);
        limits.put("requestsPerSecond", RpcDispatcher.Limits.DEFAULT.requestsPerSecond());
        limits.put("maxConcurrentRequests", RpcDispatcher.Limits.DEFAULT.maxConcurrentRequests());
        limits.put("maxSubscriptions", SessionEvents.MAX_SUBSCRIPTIONS);
        limits.put("maxSessions", maxSessions);
        limits.put("resumeWindowSec", RESUME_WINDOW.toSeconds());
        limits.put("idempotencyRetentionSec", 600);
        return Collections.unmodifiableMap(limits);
    }
}
