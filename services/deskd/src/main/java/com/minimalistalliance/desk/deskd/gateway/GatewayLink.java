package com.minimalistalliance.desk.deskd.gateway;

import com.minimalistalliance.desk.deskd.auth.Revocations;
import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.platform.DeskState;
import com.minimalistalliance.desk.deskd.platform.PlatformActions;
import com.minimalistalliance.desk.deskd.platform.PlatformConfig;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.session.CloseCodes;
import com.minimalistalliance.desk.deskd.session.SessionAuthorizer;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.io.IOException;
import java.net.URI;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The one outbound WebSocket to the gateway (gateway.md 3): session signaling, revocations and
 * notices. A session never depends on it once it's open, so losing the link, including the normal
 * close at 2 h, leaves live sessions up. They are listed in the next ready.
 *
 * <p><b>Threads.</b> One virtual thread connects and then writes, parked while there's nothing to
 * send, so sending never blocks a caller, and the rtc reader can send from a callback. The JDK's
 * client delivers what comes in. Work for a session runs in that session's order on a virtual thread
 * that exists only while there's something to do, as checking a token or asking desk-rtc can park.
 *
 * <p><b>Frames.</b> A message over 32 KB is never sent. The JDK's client splits text into frames of at
 * most 16 KiB, which API Gateway reassembles, so that limit also holds frame by frame.
 */
public final class GatewayLink {

    private static final Logger log = LoggerFactory.getLogger(GatewayLink.class);

    public static final String SUBPROTOCOL = "ma.gw.v1";
    public static final String AUTH_HEADER = "X-MA-Desk-Auth";
    static final int MAX_MESSAGE_BYTES = 32 * 1024;
    static final int MAX_SIGNAL_DATA_BYTES = 30 * 1024;
    private static final int MAX_INBOUND_CHARS = 128 * 1024;
    private static final int MAX_OUTBOUND = 256;
    private static final int MAX_SESSION_QUEUE = 16;
    private static final int MAX_SESSION_LANES = 64;
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration SEND_TIMEOUT = Duration.ofSeconds(10);
    private static final Outgoing PING = new Outgoing("{\"type\":\"ping\"}", null);

    /**
     * @param pingEvery at least every 45 s: the API firewall in front of {@code gw.} closes a WebSocket idle about
     *     100 s (ma-platform ADR 0108), so the default is 30 s
     * @param replyTimeout a ping or ready with no answer in this time means the connection is dead
     * @param rateLimitedDelay the least wait after a 429 or 4429
     * @param helloWhenBlockedAfter how long to wait, told not to reconnect, before asking for a hello,
     *     which is the only thing that lifts it
     * @param healthyAfter a link that lasted this long past ready resets the backoff
     */
    public record Timing(
            Duration minBackoff,
            Duration maxBackoff,
            Duration pingEvery,
            Duration replyTimeout,
            Duration rateLimitedDelay,
            Duration helloWhenBlockedAfter,
            Duration healthyAfter) {
        public static final Timing DEFAULT = new Timing(
                Duration.ofSeconds(1),
                Duration.ofSeconds(30),
                Duration.ofSeconds(30),
                Duration.ofSeconds(30),
                Duration.ofSeconds(30),
                Duration.ofMinutes(5),
                Duration.ofSeconds(30));
    }

    private enum Next {
        /** Connect again, after backoff. */
        RETRY,
        /** The gateway said not to, until the next hello succeeds. */
        BLOCK
    }

    private record Outcome(Next next, boolean healthy, Duration atLeast) {
        static final Outcome RETRY = new Outcome(Next.RETRY, false, Duration.ZERO);
        static final Outcome BLOCK = new Outcome(Next.BLOCK, false, Duration.ZERO);
    }

    private static final class Lane {
        final ArrayDeque<Runnable> tasks = new ArrayDeque<>();
    }

    /** @param written see {@link #send(Map, Runnable)} */
    private record Outgoing(String text, Runnable written) {}

    private final PlatformHttp http;
    private final RoleCredentials credentials;
    private final DeskState state;
    private final SessionManager sessions;
    private final Revocations revocations;
    private final PlatformActions actions;
    private final String version;
    private final Clock clock;
    private final Timing timing;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition changed = lock.newCondition();
    private final Map<String, Lane> lanes = new HashMap<>();
    private final Set<String> closingFromGateway = ConcurrentHashMap.newKeySet();
    private Thread thread;
    private boolean enabled;
    private boolean closed;
    private long blockedSinceNanos;
    private volatile java.util.function.LongConsumer guildRoster = version -> {};
    private volatile Connection current;
    private volatile boolean ready;

    public GatewayLink(
            PlatformHttp http,
            RoleCredentials credentials,
            DeskState state,
            SessionManager sessions,
            Revocations revocations,
            PlatformActions actions,
            String version,
            Clock clock,
            Timing timing) {
        this.http = http;
        this.credentials = credentials;
        this.state = state;
        this.sessions = sessions;
        this.revocations = revocations;
        this.actions = actions;
        this.version = version;
        this.clock = clock;
        this.timing = timing;
    }

    /** Called after each successful hello. Connects, or lifts a block; does nothing if already up. */
    public void enable() {
        lock.lock();
        try {
            enabled = true;
            if (thread == null && !closed) {
                thread = Thread.ofVirtual().name("gateway-link").start(this::run);
            }
            changed.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** True while connected and the gateway has acknowledged ready. */
    public boolean isReady() {
        return ready;
    }

    /** Parks until ready or until the wait runs out. */
    public void awaitReady(Duration maxWait) throws InterruptedException {
        long remaining = maxWait.toNanos();
        lock.lockInterruptibly();
        try {
            while (!ready && !closed && remaining > 0) {
                remaining = changed.awaitNanos(remaining);
            }
        } finally {
            lock.unlock();
        }
    }

    /** Sends what's queued, for up to the given time, and then stops for good. */
    public void close(Duration flush) {
        Thread running;
        lock.lock();
        try {
            closed = true;
            running = thread;
            changed.signalAll();
        } finally {
            lock.unlock();
        }
        Connection connection = current;
        if (connection != null) {
            connection.flushAndClose(flush);
        }
        if (running != null) {
            running.interrupt();
        }
    }

    /** A session ended. Never blocks. */
    public void sessionClosed(String sessionId, String reason) {
        if (!closingFromGateway.contains(sessionId)) {
            Map<String, Object> message = new LinkedHashMap<>();
            message.put("type", "session.close");
            message.put("sessionId", sessionId);
            message.put("reason", reason);
            send(message);
        }
    }

    /** An offer was refused. Never blocks. */
    public void offerRefused(String sessionId, String code) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("type", "refusal");
        data.put("code", code);
        data.put("message", refusalText(code));
        sendSignal(sessionId, data);
    }

    private static String refusalText(String code) {
        return switch (code) {
            case CloseCodes.REASON_IDENTITY_MISMATCH -> "The offer's fingerprint doesn't match the desk token.";
            case "session_limit_reached" -> "This desk has too many sessions.";
            default -> "The desk refused this offer.";
        };
    }

    private void sendSignal(String sessionId, Map<String, Object> data) {
        sendSignal(sessionId, data, null);
    }

    private void sendSignal(String sessionId, Map<String, Object> data, Runnable written) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("type", "signal");
        message.put("sessionId", sessionId);
        message.put("data", data);
        send(message, written);
    }

    private void send(Map<String, Object> message) {
        send(message, null);
    }

    /** @param written if not null, runs on the writer once the message is on the socket. Must not block */
    private void send(Map<String, Object> message, Runnable written) {
        byte[] bytes = Json.bytes(message);
        if (bytes.length > MAX_MESSAGE_BYTES) {
            log.error("gateway message of type {} over the limit, dropped", message.get("type"));
            return;
        }
        Connection connection = current;
        if (connection == null) {
            // ready lists what's live on the next connection, and the gateway settles the difference.
            log.debug("gateway message of type {} dropped: no link", message.get("type"));
            return;
        }
        connection.enqueue(new Outgoing(new String(bytes, StandardCharsets.UTF_8), written));
    }

    private void run() {
        Duration backoff = timing.minBackoff();
        try {
            while (awaitEnabled()) {
                Outcome outcome = connectAndServe();
                if (outcome.next() == Next.BLOCK) {
                    block();
                    backoff = timing.minBackoff();
                    continue;
                }
                if (outcome.healthy()) {
                    backoff = timing.minBackoff();
                }
                Duration delay = jitter(backoff);
                Thread.sleep(delay.compareTo(outcome.atLeast()) > 0 ? delay : outcome.atLeast());
                Duration doubled = backoff.multipliedBy(2);
                backoff = doubled.compareTo(timing.maxBackoff()) > 0 ? timing.maxBackoff() : doubled;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** ±20 %, so a fleet doesn't come back all at once (gateway.md section 1). */
    private static Duration jitter(Duration base) {
        return Duration.ofNanos((long) (base.toNanos() * ThreadLocalRandom.current().nextDouble(0.8, 1.2)));
    }

    private void block() {
        lock.lock();
        try {
            enabled = false;
            blockedSinceNanos = System.nanoTime();
        } finally {
            lock.unlock();
        }
    }

    private boolean awaitEnabled() throws InterruptedException {
        lock.lockInterruptibly();
        try {
            while (!enabled && !closed) {
                long wait = blockedSinceNanos + timing.helloWhenBlockedAfter().toNanos() - System.nanoTime();
                if (wait <= 0) {
                    blockedSinceNanos = System.nanoTime();
                    actions.requestHello("requested");
                    continue;
                }
                changed.awaitNanos(wait);
            }
            return !closed;
        } finally {
            lock.unlock();
        }
    }

    private Outcome connectAndServe() throws InterruptedException {
        PlatformConfig config = state.config();
        if (config == null) {
            return Outcome.RETRY;
        }
        Connection connection = new Connection();
        WebSocket socket;
        CompletableFuture<WebSocket> opening = null;
        try {
            AwsCredentials role = credentials.current();
            String auth = DeskAuth.header(role, config.gatewayId(), clock.instant());
            opening = http.client().newWebSocketBuilder()
                    .subprotocols(SUBPROTOCOL)
                    .header(AUTH_HEADER, auth)
                    .connectTimeout(CONNECT_TIMEOUT)
                    .buildAsync(URI.create(config.gatewayUrl()), connection);
            socket = opening.get(CONNECT_TIMEOUT.toMillis() + 1000, TimeUnit.MILLISECONDS);
        } catch (ExecutionException e) {
            return onUpgradeFailure(e.getCause());
        } catch (IOException | TimeoutException | RuntimeException e) {
            log.warn("gateway connect failed: {}", e.getClass().getSimpleName());
            if (opening != null) {
                opening.cancel(true);
            }
            return Outcome.RETRY;
        }
        return connection.serve(socket);
    }

    private Outcome onUpgradeFailure(Throwable cause) {
        if (cause instanceof WebSocketHandshakeException handshake) {
            int status = handshake.getResponse().statusCode();
            log.warn("gateway refused the upgrade: HTTP {}", status);
            return switch (status) {
                case 401 -> {
                    credentials.invalidate();
                    yield Outcome.RETRY;
                }
                case 403, 410 -> Outcome.BLOCK;
                case 429 -> new Outcome(Next.RETRY, false, timing.rateLimitedDelay());
                default -> Outcome.RETRY;
            };
        }
        log.warn("gateway connect failed: {}", cause == null ? "unknown" : cause.getClass().getSimpleName());
        return Outcome.RETRY;
    }

    private void markReady(Connection connection) {
        lock.lock();
        try {
            if (current == connection) {
                ready = true;
                changed.signalAll();
            }
        } finally {
            lock.unlock();
        }
    }

    private Map<String, Object> readyMessage() {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("type", "ready");
        message.put("bootId", state.bootId());
        message.put("runtimeVersion", version);
        message.put("deskApi", SessionManager.DESK_API);
        message.put("sessions", sessions.sessionIds());
        message.put("peerSessions", List.of());
        return message;
    }

    /** @param received {@link System#nanoTime} when the message came in, for what a session spends here */
    private void onMessage(Connection connection, Map<String, Object> message, long received) {
        String type = Json.string(message, "type");
        if (type == null) {
            return;
        }
        String sessionId = Json.string(message, "sessionId");
        switch (type) {
            case "session.open" -> inOrder(sessionId, () -> onOpen(sessionId, Json.string(message, "deskToken"), received));
            case "signal" -> inOrder(sessionId, () -> onSignal(sessionId, Json.object(message, "data"), received));
            case "session.refresh" -> inOrder(sessionId, () -> onRefresh(sessionId, Json.string(message, "deskToken")));
            case "session.close" -> inOrder(sessionId, () -> onClose(sessionId, Json.string(message, "reason")));
            case "revoke" -> revocations.apply(
                    strings(message.get("revokedSessions")),
                    strings(message.get("userIds")),
                    Json.string(message, "tokensValidAfter"));
            case "notify" -> onNotify(Json.string(message, "topic"), message);
            case "ready.ack" -> connection.onReadyAck();
            case "error" -> connection.onError(Json.string(message, "code"));
            default -> log.debug("ignoring gateway message of type {}", type);
        }
    }

    private void onNotify(String topic, Map<String, Object> message) {
        if ("config".equals(topic)) {
            actions.requestConfig();
        } else if ("heartbeat".equals(topic)) {
            actions.requestHeartbeat();
        } else if ("guild.roster".equals(topic) && message.get("version") instanceof Number version) {
            // gateway.md 3.2 (0.3.30): read the roster and drop or update sessions at once. Only a guild desk listens.
            guildRoster.accept(version.longValue());
        }
    }

    /** Hears {@code notify guild.roster}'s version. Must not block: it runs on the link's reader. */
    public void onGuildRoster(java.util.function.LongConsumer listener) {
        guildRoster = listener;
    }

    private void onOpen(String sessionId, String token, long received) {
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("sessionId", sessionId);
        Runnable written = () -> sessions.openRefused(received);
        try {
            sessions.open(sessionId, token, received);
            reply.put("type", "session.accept");
            written = () -> sessions.openAnswered(sessionId);
        } catch (SessionAuthorizer.RefusedException e) {
            log.info("session refused: {}", e.code());
            reply.put("type", "session.reject");
            reply.put("code", e.code());
            reply.put("message", rejectText(e.code()));
        } catch (RuntimeException e) {
            // The gateway wants an answer within 5 s, whatever happened. The class alone, as usual.
            log.error("session refused: failed checking it: {}", e.getClass().getName());
            reply.put("type", "session.reject");
            reply.put("code", "desk_not_ready");
            reply.put("message", rejectText("desk_not_ready"));
        }
        send(reply, written);
    }

    private static String rejectText(String code) {
        return switch (code) {
            case "invalid_token" -> "The desk token was refused.";
            case "wrong_desk" -> "This token is for another desk or owner.";
            case "session_limit_reached" -> "This desk has too many sessions.";
            default -> "The desk isn't ready.";
        };
    }

    private void onSignal(String sessionId, Map<String, Object> data, long received) {
        // Only offers come this way: clients send candidates in the offer and never trickle.
        if (data == null || !"offer".equals(Json.string(data, "type"))) {
            return;
        }
        String sdp = Json.string(data, "sdp");
        String offer = sdp == null ? "" : sdp;
        boolean restart = Boolean.TRUE.equals(data.get("restart"));
        try {
            String answer = restart ? sessions.iceRestart(sessionId, offer) : sessions.offer(sessionId, offer, received);
            Map<String, Object> reply = new LinkedHashMap<>();
            reply.put("type", "answer");
            reply.put("sdp", answer);
            if (answer == null || Json.bytes(reply).length > MAX_SIGNAL_DATA_BYTES) {
                log.error("session closed: the answer doesn't fit in a signal");
                sessions.abandonOffer(sessionId, "internal");
                return;
            }
            sendSignal(sessionId, reply, restart ? null : () -> sessions.answerSent(sessionId));
        } catch (SessionAuthorizer.RefusedException e) {
            log.debug("offer refused: {}", e.code());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** A refused refresh needs no answer. The session carries on and closes at exp + 30 s if none comes. */
    private void onRefresh(String sessionId, String token) {
        try {
            sessions.refresh(sessionId, token);
        } catch (SessionAuthorizer.RefusedException e) {
            log.info("session refresh refused: {}", e.code());
        }
    }

    private void onClose(String sessionId, String reason) {
        closingFromGateway.add(sessionId);
        try {
            sessions.close(sessionId, CloseCodes.forGatewayReason(reason), reason == null ? CloseCodes.REASON_CLOSED_BY_DESK : reason);
        } finally {
            closingFromGateway.remove(sessionId);
        }
    }

    /** Runs a session's messages one at a time and in order, apart from every other session's. */
    private void inOrder(String sessionId, Runnable task) {
        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }
        lock.lock();
        try {
            Lane lane = lanes.get(sessionId);
            if (lane == null) {
                if (lanes.size() >= MAX_SESSION_LANES) {
                    log.warn("gateway message dropped: too many sessions at once");
                    return;
                }
                lane = new Lane();
                lanes.put(sessionId, lane);
                Lane started = lane;
                Thread.ofVirtual().name("gateway-session").start(() -> drain(sessionId, started));
            }
            if (lane.tasks.size() >= MAX_SESSION_QUEUE) {
                log.warn("gateway message dropped: too many waiting for one session");
                return;
            }
            lane.tasks.addLast(task);
        } finally {
            lock.unlock();
        }
    }

    private void drain(String sessionId, Lane lane) {
        while (true) {
            Runnable task;
            lock.lock();
            try {
                task = lane.tasks.pollFirst();
                if (task == null) {
                    lanes.remove(sessionId);
                    return;
                }
            } finally {
                lock.unlock();
            }
            try {
                task.run();
            } catch (RuntimeException e) {
                // The class alone: exception text can quote a token or an SDP.
                log.error("gateway message failed: {}", e.getClass().getName());
            }
        }
    }

    private static List<String> strings(Object value) {
        if (!(value instanceof List<?> list)) {
            return List.of();
        }
        return list.stream().filter(String.class::isInstance).map(String.class::cast).toList();
    }

    /** One WebSocket, from the upgrade to the close. */
    private final class Connection implements WebSocket.Listener {
        private static final long NONE = Long.MAX_VALUE;

        private final ReentrantLock connectionLock = new ReentrantLock();
        private final Condition work = connectionLock.newCondition();
        private final ArrayDeque<Outgoing> outbound = new ArrayDeque<>();
        private final StringBuilder partial = new StringBuilder();
        private boolean oversized;
        private boolean dead;
        private boolean writing;
        private boolean replaced;
        private boolean closing;
        private int closeCode = -1;
        private long readyAtNanos = NONE;
        private long replyDeadlineNanos = NONE;
        private long nextPingNanos;
        private WebSocket socket;

        Outcome serve(WebSocket opened) throws InterruptedException {
            lock.lock();
            try {
                current = this;
            } finally {
                lock.unlock();
            }
            log.info("gateway link up");
            try {
                connectionLock.lockInterruptibly();
                try {
                    socket = opened;
                    long now = System.nanoTime();
                    outbound.addFirst(new Outgoing(new String(Json.bytes(readyMessage()), StandardCharsets.UTF_8), null));
                    replyDeadlineNanos = now + timing.replyTimeout().toNanos();
                    nextPingNanos = now + timing.pingEvery().toNanos();
                } finally {
                    connectionLock.unlock();
                }
                while (true) {
                    Outgoing next = awaitNext();
                    if (next == null) {
                        break;
                    }
                    opened.sendText(next.text(), true).get(SEND_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
                    if (next.written() != null) {
                        next.written().run();
                    }
                    connectionLock.lock();
                    try {
                        writing = false;
                        work.signalAll();
                    } finally {
                        connectionLock.unlock();
                    }
                }
            } catch (ExecutionException | TimeoutException | RuntimeException e) {
                log.info("gateway send failed: {}", e.getClass().getSimpleName());
            } finally {
                markDead();
                opened.abort();
                lock.lock();
                try {
                    if (current == this) {
                        current = null;
                    }
                    ready = false;
                    changed.signalAll();
                } finally {
                    lock.unlock();
                }
            }
            return outcome();
        }

        private Outcome outcome() {
            connectionLock.lock();
            try {
                log.info("gateway link down, close code {}", closeCode);
                boolean healthy = readyAtNanos != NONE
                        && System.nanoTime() - readyAtNanos >= timing.healthyAfter().toNanos();
                if (replaced || closeCode == 4403 || closeCode == 4409) {
                    return Outcome.BLOCK;
                }
                if (closeCode == 4401) {
                    credentials.invalidate();
                }
                Duration atLeast = closeCode == 4429 ? timing.rateLimitedDelay() : Duration.ZERO;
                return new Outcome(Next.RETRY, healthy, atLeast);
            } finally {
                connectionLock.unlock();
            }
        }

        /** @return the next message to send, or null once this connection is finished */
        private Outgoing awaitNext() throws InterruptedException {
            connectionLock.lockInterruptibly();
            try {
                while (true) {
                    if (dead) {
                        return null;
                    }
                    long now = System.nanoTime();
                    if (replyDeadlineNanos != NONE && now - replyDeadlineNanos >= 0) {
                        log.warn("gateway didn't answer in time, reconnecting");
                        return null;
                    }
                    Outgoing queued = outbound.pollFirst();
                    if (queued != null) {
                        writing = true;
                        return queued;
                    }
                    if (closing) {
                        return null;
                    }
                    if (now - nextPingNanos >= 0) {
                        nextPingNanos = now + timing.pingEvery().toNanos();
                        if (replyDeadlineNanos == NONE) {
                            replyDeadlineNanos = now + timing.replyTimeout().toNanos();
                        }
                        writing = true;
                        return PING;
                    }
                    long wait = nextPingNanos - now;
                    if (replyDeadlineNanos != NONE) {
                        wait = Math.min(wait, replyDeadlineNanos - now);
                    }
                    work.awaitNanos(wait);
                }
            } finally {
                connectionLock.unlock();
            }
        }

        void enqueue(Outgoing message) {
            connectionLock.lock();
            try {
                if (dead) {
                    return;
                }
                if (outbound.size() >= MAX_OUTBOUND) {
                    log.warn("gateway message dropped: too many waiting");
                    return;
                }
                outbound.addLast(message);
                work.signalAll();
            } finally {
                connectionLock.unlock();
            }
        }

        void flushAndClose(Duration maxWait) {
            WebSocket opened;
            connectionLock.lock();
            try {
                long remaining = maxWait.toNanos();
                while ((writing || !outbound.isEmpty()) && !dead && remaining > 0) {
                    remaining = work.awaitNanos(remaining);
                }
                closing = true;
                opened = socket;
                work.signalAll();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } finally {
                connectionLock.unlock();
            }
            if (opened != null && !opened.isOutputClosed()) {
                opened.sendClose(WebSocket.NORMAL_CLOSURE, "");
            }
        }

        void onReadyAck() {
            connectionLock.lock();
            try {
                readyAtNanos = System.nanoTime();
            } finally {
                connectionLock.unlock();
            }
            markReady(this);
        }

        void onError(String code) {
            if ("connection_replaced".equals(code)) {
                log.warn("another connection took over this desk's link");
                connectionLock.lock();
                try {
                    replaced = true;
                } finally {
                    connectionLock.unlock();
                }
            } else {
                log.info("gateway error: {}", code);
            }
        }

        private void markDead() {
            connectionLock.lock();
            try {
                dead = true;
                work.signalAll();
            } finally {
                connectionLock.unlock();
            }
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            webSocket.request(1);
            if (partial.length() + data.length() > MAX_INBOUND_CHARS) {
                oversized = true;
                partial.setLength(0);
            } else if (!oversized) {
                partial.append(data);
            }
            if (last) {
                String text = oversized ? null : partial.toString();
                partial.setLength(0);
                oversized = false;
                if (text != null) {
                    receive(text);
                } else {
                    log.warn("gateway message over the limit, dropped");
                }
            }
            return null;
        }

        private void receive(String text) {
            long received = System.nanoTime();
            connectionLock.lock();
            try {
                replyDeadlineNanos = NONE;
            } finally {
                connectionLock.unlock();
            }
            try {
                onMessage(this, Json.parseObject(text.getBytes(StandardCharsets.UTF_8)), received);
            } catch (JsonFormatException e) {
                log.warn("gateway message dropped: unparseable");
            } catch (RuntimeException e) {
                log.error("gateway message failed: {}", e.getClass().getName());
            }
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            connectionLock.lock();
            try {
                closeCode = statusCode;
            } finally {
                connectionLock.unlock();
            }
            markDead();
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            log.info("gateway connection failed: {}", error.getClass().getSimpleName());
            markDead();
        }
    }
}
