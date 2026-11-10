package com.minimalistalliance.desk.deskd.session;

import com.minimalistalliance.desk.deskd.events.SessionEvents;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameException;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.protocol.Message;
import com.minimalistalliance.desk.deskd.protocol.Reassembler;
import com.minimalistalliance.desk.deskd.protocol.ReassemblyBudget;
import com.minimalistalliance.desk.deskd.protocol.TooLargeException;
import com.minimalistalliance.desk.deskd.rpc.RpcPeer;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rpc.RpcSession;
import com.minimalistalliance.desk.deskd.rpc.SubscriptionService;
import com.minimalistalliance.desk.deskd.rpc.TokenBucket;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.rtc.RtcHandleGoneException;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One client connection: a token deskd verified, then a peer connection in desk-rtc, then the frames
 * that come over it. Sessions are made only by {@link SessionManager#open}, after the token passes,
 * and {@link SessionManager} is the only way frames reach one.
 */
public final class Session implements RpcPeer, SessionEvents.Sink {

    private static final Logger log = LoggerFactory.getLogger(Session.class);

    /** PING, ACTIVITY and AUTH per second. A real client sends far fewer. */
    private static final int CTL_PER_SECOND = 50;
    private static final int MAX_CTL_REJECT_STREAK = 1000;
    private static final Duration CLOSE_FLUSH = Duration.ofSeconds(1);

    enum State {
        /** Token verified, no offer yet. */
        ACCEPTED,
        /** session.create sent. */
        NEGOTIATING,
        /** desk-rtc has given a handle. */
        BOUND
    }

    private final SessionManager manager;
    private final RtcClient rtc;
    private final String sessionId;
    private final SessionTiming timing;
    private final ChannelLane[] lanes = new ChannelLane[Channels.COUNT];
    private final Reassembler[] reassemblers = new Reassembler[Channels.COUNT];
    private final RpcSession rpc;
    private final TokenBucket ctlBucket;
    private final AtomicBoolean ended = new AtomicBoolean();
    private final AtomicBoolean authInFlight = new AtomicBoolean();
    /** Keeps what desk-rtc hears about permissions in the order the grants changed. Never held across a wait. */
    private final ReentrantLock permissions = new ReentrantLock();
    private volatile SessionGrant grant;
    /** The grant whose permissions desk-rtc last heard, or will hear in session.create. */
    private SessionGrant toldRtc;
    private final AtomicReference<State> state = new AtomicReference<>(State.ACCEPTED);
    private volatile long handle = -1;
    private volatile boolean helloDone;
    private volatile SessionEvents events;
    private volatile byte[] resumeToken;
    private volatile String rtcState;
    private volatile String transport;
    private volatile Thread expiryTimer;
    private volatile Thread offerTimer;
    private volatile Thread dormantTimer;
    private int ctlRejectStreak;

    Session(SessionManager manager, RtcClient rtc, String sessionId, SessionGrant grant, SessionTiming timing) {
        this.manager = manager;
        this.rtc = rtc;
        this.sessionId = sessionId;
        this.timing = timing;
        this.grant = grant;
        this.toldRtc = grant;
        this.rpc = manager.rpcDispatcher().newSession(this);
        this.ctlBucket = new TokenBucket(CTL_PER_SECOND, CTL_PER_SECOND, System::nanoTime);
        ReassemblyBudget budget = new ReassemblyBudget(ReassemblyBudget.DEFAULT_BYTES);
        for (int channel = 0; channel < Channels.COUNT; channel++) {
            int lane = channel;
            reassemblers[channel] = new Reassembler(budget);
            lanes[channel] = new ChannelLane(frame -> onFrame(lane, frame));
        }
    }

    public String sessionId() {
        return sessionId;
    }

    public SessionGrant grant() {
        return grant;
    }

    @Override
    public boolean ready() {
        return helloDone && !ended.get();
    }

    @Override
    public RpcPrincipal principal() {
        SessionGrant current = grant;
        return new RpcPrincipal(current.sub(), current.scope(), sessionId, current.video(), current.input(), current.caller());
    }

    @Override
    public SubscriptionService subscriptions() {
        return events;
    }

    @Override
    public void send(FrameKind kind, long id, byte[] payload) throws InterruptedException, PeerGoneException {
        send(Channels.RPC, kind, 0, id, 0, payload);
        timing.replied(id);
    }

    /**
     * Sends one message, fragmented as needed, parking while the channel is out of credit. Only the
     * caller waits. Other channels keep moving.
     *
     * @param flags BIN and END as the message needs them
     * @throws PeerGoneException if the session has ended
     */
    public void send(int channel, FrameKind kind, int flags, long id, long seq, byte[] payload)
            throws InterruptedException, PeerGoneException {
        if (ended.get() || handle < 0) {
            throw new PeerGoneException();
        }
        try {
            for (byte[] frame : Frame.fragments(kind, flags, id, seq, payload)) {
                rtc.send(handle, channel, frame);
            }
        } catch (RtcHandleGoneException e) {
            throw new PeerGoneException();
        }
    }

    /** True if this session's client is subscribed to the topic now. For a module that keeps one thing per session. */
    public boolean isSubscribed(String topicKey) {
        SessionEvents current = events;
        return current != null && !ended.get() && current.isSubscribed(topicKey);
    }

    @Override
    public void closeRateLimited() {
        closeByDesk(CloseCodes.RATE_LIMITED, "rate_limited", false, true);
    }

    @Override
    public void enqueue(long subId, long seq, byte[] payload) {
        long current = handle;
        if (current >= 0 && !ended.get()) {
            rtc.offer(current, Channels.EVENTS, Frame.fragment(FrameKind.EVT, 0, subId, seq, payload));
        }
    }

    @Override
    public long queuedBytes() {
        long current = handle;
        return current < 0 ? 0 : rtc.queuedBytes(current, Channels.EVENTS);
    }

    SessionTiming timing() {
        return timing;
    }

    String rtcState() {
        return rtcState;
    }

    String transport() {
        return transport;
    }

    boolean isHelloDone() {
        return helloDone;
    }

    boolean hasEnded() {
        return ended.get();
    }

    State state() {
        return state.get();
    }

    byte[] resumeToken() {
        return resumeToken;
    }

    SessionEvents events() {
        return events;
    }

    long handle() {
        return handle;
    }

    /** Moves on from ACCEPTED once: an offer in any other state is refused. */
    boolean beginNegotiating() {
        if (!state.compareAndSet(State.ACCEPTED, State.NEGOTIATING)) {
            return false;
        }
        interrupt(offerTimer);
        return true;
    }

    /** desk-rtc refused the session, so closing has nothing to tell it. */
    void negotiationRefused() {
        state.compareAndSet(State.NEGOTIATING, State.ACCEPTED);
    }

    /** The grant to put in session.create. A refresh from here on goes to desk-rtc once it's bound. */
    SessionGrant grantForCreate() {
        permissions.lock();
        try {
            toldRtc = grant;
            return toldRtc;
        } finally {
            permissions.unlock();
        }
    }

    void bind(long boundHandle) {
        timing.answerReceived();
        handle = boundHandle;
        permissions.lock();
        try {
            state.set(State.BOUND);
            tellRtcIfChanged();
        } finally {
            permissions.unlock();
        }
    }

    /** With the permissions lock held. Before the bind there's no session in desk-rtc to tell. */
    private void tellRtcIfChanged() {
        SessionGrant current = grant;
        if (state.get() == State.BOUND && (toldRtc.video() != current.video() || toldRtc.input() != current.input())) {
            toldRtc = current;
            rtc.setPermissions(sessionId, current.video(), current.input());
        }
    }

    /** HELLO has passed. The manager calls this with its lock held, so closing sees all of it or none. */
    void completeHello(SessionEvents helloEvents, byte[] token) {
        events = helloEvents;
        resumeToken = token;
        helloDone = true;
    }

    void onRtcState(String newState, String newTransport) {
        rtcState = newState;
        if (newTransport != null) {
            transport = newTransport;
        }
    }

    /** From the rtc reader. Never blocks. */
    void onData(int channel, byte[] frame) {
        if (!ended.get()) {
            timing.frameArrived(channel, frame);
            lanes[channel].enqueue(frame);
        }
    }

    void applyRefresh(SessionGrant refreshed) {
        SessionGrant previous;
        permissions.lock();
        try {
            previous = grant;
            // Refreshes can reach deskd out of order, on the gateway and on ctl. An older token, though
            // valid, must not shorten the session.
            if (refreshed.validUntil().isBefore(previous.validUntil())) {
                return;
            }
            grant = refreshed;
            armExpiry();
            tellRtcIfChanged();
        } finally {
            permissions.unlock();
        }
        boolean callerChanged = !previous.caller().equals(refreshed.caller());
        SessionEvents current = events;
        if (current != null && (previous.video() != refreshed.video() || previous.input() != refreshed.input() || callerChanged)) {
            current.reauthorize(principal());
        }
        if (callerChanged) {
            manager.callerChanged(sessionId);
        }
    }

    void armExpiry() {
        Thread previous = expiryTimer;
        expiryTimer = OneShot.after(Duration.between(Instant.now(), grant.validUntil()), this::checkExpiry);
        if (previous != null) {
            previous.interrupt();
        }
    }

    void armOfferTimer(Duration timeout) {
        offerTimer = OneShot.after(timeout, () -> {
            if (state.get() == State.ACCEPTED) {
                log.info("session closed: no offer came");
                closeByDesk(CloseCodes.PROTOCOL_ERROR, CloseCodes.REASON_CLOSED_BY_DESK, false, false);
            }
        });
    }

    void armDormantDrop(Duration window) {
        SessionEvents current = events;
        dormantTimer = OneShot.after(window, current::dropDormant);
    }

    /**
     * Ends the session from deskd's side.
     *
     * @param retain keep subscriptions for a resume
     * @param notifyClient send CLOSE on ctl first
     * @return the thread flushing the close to desk-rtc, or null if nothing has to go there
     */
    Thread closeByDesk(int code, String reason, boolean retain, boolean notifyClient) {
        if (!ended.compareAndSet(false, true)) {
            return null;
        }
        long current = handle;
        if (current >= 0 && notifyClient) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("code", code);
            body.put("reason", reason);
            if (code == CloseCodes.DESK_API_MISMATCH) {
                body.put("deskApi", SessionManager.DESK_API);
            }
            rtc.offer(current, Channels.CTL, List.of(new Frame(FrameKind.CLOSE, 0, 0, 0, Json.bytes(body)).encode()));
        }
        manager.sessionEnded(this, reason, retain);
        stopLocal();
        if (state.get() == State.ACCEPTED) {
            return null;
        }
        return Thread.ofVirtual().name("session-close").start(() -> {
            try {
                if (current >= 0) {
                    rtc.awaitDrained(current, Channels.CTL, CLOSE_FLUSH);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                rtc.closeSession(sessionId, code, reason);
            }
        });
    }

    /** desk-rtc says the session is gone, or the socket dropped. Nothing is left to tell it. */
    void closedByRtc(String reason) {
        if (ended.compareAndSet(false, true)) {
            manager.sessionEnded(this, reason, true);
            stopLocal();
        }
    }

    private void stopLocal() {
        timing.sessionEnded();
        rpc.shutdown();
        for (ChannelLane lane : lanes) {
            lane.stop();
        }
        interrupt(expiryTimer);
        interrupt(offerTimer);
        interrupt(dormantTimer);
    }

    private static void interrupt(Thread thread) {
        if (thread != null && thread != Thread.currentThread()) {
            thread.interrupt();
        }
    }

    private void checkExpiry() {
        if (ended.get()) {
            return;
        }
        if (Instant.now().isBefore(grant.validUntil())) {
            armExpiry();
            return;
        }
        log.info("session closed: token expired");
        closeByDesk(CloseCodes.TOKEN_EXPIRED_OR_REVOKED, CloseCodes.REASON_TOKEN_EXPIRED, true, true);
    }

    /** On the channel's lane. Credit goes back once the frame is dealt with, whatever happened. */
    private void onFrame(int channel, byte[] bytes) {
        try {
            if (ended.get()) {
                return;
            }
            Frame frame = Frame.decode(bytes);
            if (frame.kind() == FrameKind.UNKNOWN) {
                return;
            }
            Message message = reassemblers[channel].accept(frame);
            if (message != null) {
                route(channel, message);
            }
        } catch (FrameException | JsonFormatException e) {
            log.warn("session closed: protocol error on channel {}", channel);
            closeByDesk(CloseCodes.PROTOCOL_ERROR, "protocol_error", false, true);
        } catch (TooLargeException e) {
            onTooLarge(channel, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            // The class alone: exception text can quote the payload.
            log.error("session closed: failed on channel {}: {}", channel, e.getClass().getName());
            closeByDesk(CloseCodes.INTERNAL, "internal", false, true);
        } finally {
            rtc.consumed(handle, channel, bytes.length);
        }
    }

    private void onTooLarge(int channel, TooLargeException error) {
        if (error.recoverable() && channel == Channels.RPC && error.kind().isRequest()) {
            try {
                rpc.refuseTooLarge(error.id());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return;
        }
        log.warn("session closed: message over limit on channel {}", channel);
        closeByDesk(CloseCodes.TOO_LARGE, "too_large", false, true);
    }

    private void route(int channel, Message message) throws JsonFormatException, InterruptedException, FrameException {
        switch (channel) {
            case Channels.CTL -> onControl(message);
            case Channels.RPC -> {
                switch (message.kind()) {
                    case REQ, SUB, UNSUB, CANCEL -> {
                        timing.requestRead(message.kind(), message.id());
                        if (message.kind() == FrameKind.REQ || message.kind() == FrameKind.SUB) {
                            noteGuildActivity();
                        }
                        rpc.onMessage(message);
                    }
                    default -> throw new FrameException("kind not allowed on rpc");
                }
            }
            case Channels.EVENTS -> throw new FrameException("events is desk to client only");
            default -> {
                // Default deny: nothing reaches a module before HELLO.
                if (helloDone) {
                    ChannelHandler handler = manager.channelHandler(channel);
                    // collab is the owner's, and a guild member's on a guild desk. Channel 4 is mdoc for the owner, and
                    // commons for a guild member (API.md section 14). bulk stays open: export sessions read with data.read.
                    // Each handler checks the caller again: this only keeps an export session's DATA from reaching one.
                    boolean ownerOrMember = channel == Channels.COLLAB || channel == Channels.MDOC;
                    String scope = grant.scope();
                    if (handler != null && (!ownerOrMember
                            || RpcPrincipal.OWNER.equals(scope) || RpcPrincipal.GUILD_MEMBER.equals(scope))) {
                        if (ownerOrMember) {
                            noteGuildActivity();
                        }
                        handler.onMessage(this, message);
                    }
                }
            }
        }
    }

    private void noteGuildActivity() {
        if (grant.caller().isGuildMember()) {
            manager.noteGuildActivity();
        }
    }

    private void onControl(Message message) throws JsonFormatException, InterruptedException, FrameException {
        switch (message.kind()) {
            case HELLO -> onHello(message);
            case CLOSE -> onClientClose(message);
            case PING -> {
                if (allowControl()) {
                    sendControl(FrameKind.PONG, message.id(), message.payload());
                }
            }
            case PONG -> log.trace("pong");
            case ACTIVITY -> {
                requireHello();
                // As desk-rtc does: a session without input has nothing to report.
                if (allowControl() && grant.input()) {
                    onActivity(message);
                }
            }
            case AUTH -> {
                requireHello();
                if (allowControl()) {
                    onAuth(message);
                }
            }
            default -> throw new FrameException("kind not allowed on ctl");
        }
    }

    private void requireHello() throws FrameException {
        if (!helloDone) {
            throw new FrameException("HELLO must come first");
        }
    }

    /** Over the limit, frames are ignored, unless it goes on so long that the session has to close. */
    private boolean allowControl() {
        if (ctlBucket.tryAcquire()) {
            ctlRejectStreak = 0;
            return true;
        }
        if (++ctlRejectStreak >= MAX_CTL_REJECT_STREAK) {
            closeRateLimited();
        }
        return false;
    }

    private void onHello(Message message) throws JsonFormatException, InterruptedException, FrameException {
        if (helloDone) {
            throw new FrameException("second HELLO");
        }
        Map<String, Object> body = Json.parseObject(message.payload());
        String deskApi = Json.string(body, "deskApi");
        if (!SessionManager.sameMajor(deskApi)) {
            log.info("session closed: deskApi mismatch");
            closeByDesk(CloseCodes.DESK_API_MISMATCH, "desk_api_mismatch", false, true);
            return;
        }
        SessionManager.HelloOutcome outcome = manager.completeHello(this, Json.object(body, "resume"));
        if (outcome != null) {
            sendControl(FrameKind.HELLO, message.id(), Json.bytes(manager.helloReply(this, outcome)));
            timing.helloReplied();
        }
    }

    private void onClientClose(Message message) {
        int code = 1000;
        try {
            Map<String, Object> body = Json.parseObject(message.payload());
            if (body.get("code") instanceof Number number) {
                code = number.intValue();
            }
        } catch (JsonFormatException e) {
            log.debug("client CLOSE without a readable body");
        }
        closeByDesk(code, CloseCodes.REASON_CLOSED_BY_CLIENT, false, false);
    }

    private void onActivity(Message message) throws JsonFormatException {
        Instant at = parseTime(Json.parseObject(message.payload()).get("lastInputAt"));
        if (at != null) {
            manager.noteInput(at);
        }
    }

    /** Verification can fetch keys, so it runs apart from ctl, and PINGs still get their PONGs. */
    private void onAuth(Message message) throws JsonFormatException, InterruptedException {
        String token = Json.string(Json.parseObject(message.payload()), "deskToken");
        if (token == null || !authInFlight.compareAndSet(false, true)) {
            sendAuthReply(message.id(), token == null ? "invalid_token" : "rate_limited");
            return;
        }
        Thread.ofVirtual().name("session-auth").start(() -> {
            try {
                String failure = manager.refresh(this, token);
                sendAuthReply(message.id(), failure);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                authInFlight.set(false);
            }
        });
    }

    private void sendAuthReply(long id, String failure) throws InterruptedException {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("ok", failure == null);
        if (failure == null) {
            reply.put("validUntil", grant.validUntil().toString());
        } else {
            reply.put("code", failure);
        }
        sendControl(FrameKind.AUTH, id, Json.bytes(reply));
    }

    private void sendControl(FrameKind kind, long id, byte[] payload) throws InterruptedException {
        try {
            send(Channels.CTL, kind, 0, id, 0, payload);
        } catch (PeerGoneException e) {
            log.debug("session gone before a control reply could be sent");
        }
    }

    /** RFC 3339, or epoch milliseconds from desk-rtc; null if it's neither. */
    static Instant parseTime(Object value) {
        if (value instanceof Number number) {
            return Instant.ofEpochMilli(number.longValue());
        }
        if (value instanceof String text) {
            try {
                return OffsetDateTime.parse(text).toInstant();
            } catch (DateTimeParseException e) {
                return null;
            }
        }
        return null;
    }
}
