package com.minimalistalliance.desk.deskd.rpc;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.protocol.Message;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The requests of one session: REQ, SUB, UNSUB and CANCEL off the rpc channel. {@link #onMessage}
 * runs on the channel's serial thread and doesn't wait for handlers, because each call has its own
 * virtual thread. That's why CANCEL can pass a request that's still running.
 */
public final class RpcSession {

    private static final Logger log = LoggerFactory.getLogger(RpcSession.class);

    /** Rejected requests in a row before the session closes with 4429. */
    static final int MAX_REJECT_STREAK = 1000;
    /** Longest deadline deskd arms; a longer one is cut to this. */
    private static final long MAX_DEADLINE_MS = Duration.ofHours(1).toMillis();
    private static final int MAX_IDEM_CHARS = 128;
    private static final String INTERNAL_MESSAGE = "Internal error";
    private static final String MAY_HAVE_APPLIED = "mayHaveApplied";

    private final RpcDispatcher dispatcher;
    private final RpcPeer peer;
    private final TokenBucket bucket;
    private final Map<Long, Call> calls = new ConcurrentHashMap<>();
    private int rejectStreak;
    private long arrivals;
    private volatile boolean shutdown;

    RpcSession(RpcDispatcher dispatcher, RpcPeer peer) {
        this.dispatcher = dispatcher;
        this.peer = peer;
        int perSecond = dispatcher.limits().requestsPerSecond();
        this.bucket = new TokenBucket(perSecond, perSecond, dispatcher.nanoTime());
    }

    /**
     * Takes one message from the rpc channel. A refusal parks here while the channel is out of
     * credit, which stops a client that floods without reading: its next frames get no credit.
     */
    public void onMessage(Message message) throws InterruptedException {
        switch (message.kind()) {
            case REQ, SUB, UNSUB -> onRequest(message);
            case CANCEL -> {
                Call call = calls.get(message.id());
                if (call != null) {
                    call.cancel();
                }
            }
            default -> log.debug("ignoring {} on rpc", message.kind());
        }
    }

    /** Refuses a request that went over its size limit. */
    public void refuseTooLarge(long id) throws InterruptedException {
        sendError(id, new RpcException(RpcException.TOO_LARGE, "Request too large"));
    }

    /**
     * The session has ended. Reads stop. Mutations run on to the end so their results are there for
     * a retry, since a half-done mutation is worse than an unread reply. One that hasn't called
     * {@link RpcContext#beginEffect} yet hasn't started on anything, and that's where it stops.
     */
    public void shutdown() {
        shutdown = true;
        for (Call call : calls.values()) {
            call.sessionEnded();
        }
    }

    /** Calls whose thread hasn't finished. */
    public int inFlight() {
        return calls.size();
    }

    private void onRequest(Message message) throws InterruptedException {
        if (shutdown) {
            return;
        }
        if (!peer.ready()) {
            sendError(message.id(), new RpcException(RpcException.UNAUTHORIZED, "Send HELLO first"));
            return;
        }
        if (!bucket.tryAcquire()) {
            if (++rejectStreak >= MAX_REJECT_STREAK) {
                peer.closeRateLimited();
                return;
            }
            sendError(message.id(), new RpcException(
                    RpcException.RATE_LIMITED, "Too many requests", Map.of("limit", "requestsPerSecond")));
            return;
        }
        rejectStreak = 0;
        if (calls.size() >= dispatcher.limits().maxConcurrentRequests()) {
            sendError(message.id(), new RpcException(
                    RpcException.RATE_LIMITED, "Too many requests in flight", Map.of("limit", "concurrentRequests")));
            return;
        }
        Call call = new Call(message, ++arrivals);
        // The thread comes first: from the moment a call is in the table, shutdown can interrupt it.
        call.thread = Thread.ofVirtual().unstarted(call);
        if (calls.putIfAbsent(message.id(), call) != null) {
            sendError(message.id(), new RpcException(RpcException.BAD_REQUEST, "Request id already in flight"));
            return;
        }
        // shutdown() sets the flag, then goes through the table. So it either finds this call, or this sees the flag.
        if (shutdown) {
            calls.remove(message.id(), call);
            return;
        }
        call.thread.start();
    }

    private void sendError(long id, RpcException error) throws InterruptedException {
        try {
            peer.send(FrameKind.ERR, id, errorPayload(error));
        } catch (RpcPeer.PeerGoneException e) {
            log.debug("session gone before an error could be sent");
        }
    }

    private static byte[] errorPayload(RpcException error) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", error.code());
        body.put("message", error.getMessage());
        body.put("details", error.details());
        return Json.bytes(body);
    }

    /** How far a call has got, for what can still stop it. */
    private enum Stage {
        WORKING,
        /** Past {@link RpcContext#beginEffect}: nothing stops it now. */
        APPLYING,
        /** A cancel, a deadline or the session's end got there first. */
        STOPPED
    }

    private final class Call implements Runnable {
        private final Message request;
        private final RpcContext context;
        /** Whoever flips this answers the client: the handler, a cancel or the deadline. */
        private final AtomicBoolean answered = new AtomicBoolean();
        private final AtomicReference<Stage> stage = new AtomicReference<>(Stage.WORKING);
        private volatile Thread thread;
        private volatile boolean mutation;
        private volatile Thread deadlineTimer;
        private volatile boolean deadlineReached;

        Call(Message request, long arrival) {
            this.request = request;
            this.context = new RpcContext(peer::principal, request.id(), arrival, this::beginEffect);
        }

        private boolean beginEffect() {
            return stage.compareAndSet(Stage.WORKING, Stage.APPLYING) || stage.get() == Stage.APPLYING;
        }

        @Override
        public void run() {
            try {
                serve();
            } catch (InterruptedException e) {
                // Whoever interrupted this call has answered it, or nobody is left to answer.
                Thread.currentThread().interrupt();
            } finally {
                Thread timer = deadlineTimer;
                if (timer != null && !deadlineReached) {
                    timer.interrupt();
                }
                calls.remove(request.id(), this);
            }
        }

        void cancel() throws InterruptedException {
            abort(new RpcException(RpcException.CANCELLED, "Cancelled"));
        }

        void sessionEnded() {
            answered.set(true);
            stage.compareAndSet(Stage.WORKING, Stage.STOPPED);
            if (!mutation) {
                thread.interrupt();
            }
        }

        private void abort(RpcException error) throws InterruptedException {
            if (answered.compareAndSet(false, true)) {
                // Past beginEffect the handler finishes, and its result waits for a retry.
                if (stage.compareAndSet(Stage.WORKING, Stage.STOPPED)) {
                    thread.interrupt();
                }
                sendError(request.id(), error);
            }
        }

        private void serve() throws InterruptedException {
            Map<String, Object> body;
            try {
                body = Json.parseObject(request.payload());
            } catch (JsonFormatException e) {
                answer(true, errorPayload(new RpcException(RpcException.BAD_REQUEST, "Invalid JSON")));
                return;
            }
            Outcome outcome = request.kind() == FrameKind.REQ ? serveRequest(body) : serveSubscription(body);
            if (outcome == null) {
                // The handler gave up. If a cancel or the deadline caused that, it has answered, and
                // answer() sends nothing. Otherwise the handler chose to stop, and the client is told.
                Thread.interrupted();
                outcome = Outcome.error(new RpcException(RpcException.CANCELLED, "Cancelled"));
            }
            answer(outcome.error(), outcome.payload());
        }

        private Outcome serveSubscription(Map<String, Object> body) {
            // Every topic is the owner's, what they show being what an export token mustn't see, except the few a guild
            // member may have, which each topic says for itself (Topic.forGuildMembers), checked in SessionEvents.
            String scope = context.principal().scope();
            if (!RpcPrincipal.OWNER.equals(scope) && !RpcPrincipal.GUILD_MEMBER.equals(scope)) {
                return Outcome.error(scopeForbidden());
            }
            return invoke(request.kind().name(), context -> request.kind() == FrameKind.SUB
                    ? peer.subscriptions().subscribe(context, body)
                    : peer.subscriptions().unsubscribe(context, body));
        }

        private Outcome serveRequest(Map<String, Object> body) throws InterruptedException {
            String name = Json.string(body, "m");
            Map<String, Object> params = body.containsKey("p") && body.get("p") != null ? Json.object(body, "p") : Map.of();
            if (name == null || params == null) {
                return Outcome.error(new RpcException(RpcException.BAD_REQUEST, "Request needs m and an object p"));
            }
            if (body.containsKey("deadlineMs") && !armDeadline(body.get("deadlineMs"))) {
                return Outcome.error(new RpcException(RpcException.BAD_REQUEST, "deadlineMs must be a positive number"));
            }
            RpcDispatcher.Method method = dispatcher.method(name);
            String scope = context.principal().scope();
            // Any scope but the owner's is told nothing, not even which methods exist.
            if (method == null && RpcPrincipal.OWNER.equals(scope)) {
                return Outcome.error(new RpcException(RpcException.NOT_FOUND, "No such method"));
            }
            if (method == null || !method.scopes().contains(scope)) {
                return Outcome.error(scopeForbidden());
            }
            if (!method.mutation()) {
                return invokeMethod(name, method, params);
            }
            mutation = true;
            String idem = Json.string(body, "idem");
            if (idem == null || idem.isEmpty() || idem.length() > MAX_IDEM_CHARS) {
                return Outcome.error(new RpcException(RpcException.BAD_REQUEST, "This method needs idem"));
            }
            context.idem(idem);
            return runOnce(name, method, params, idem);
        }

        /** Runs the mutation unless the same key already has, or is doing so now. */
        private Outcome runOnce(String name, RpcDispatcher.Method method, Map<String, Object> params, String idem)
                throws InterruptedException {
            while (true) {
                IdempotencyStore.Claim claim = dispatcher.idempotency().claim(
                        context.principal().sub(), method.sessionBound() ? name + '\0' + context.principal().sessionId() : name, idem);
                if (!claim.isOwner()) {
                    IdempotencyStore.Stored earlier = claim.await();
                    if (earlier != null) {
                        return new Outcome(earlier.error(), earlier.payload(), true);
                    }
                    continue;
                }
                boolean finished = false;
                try {
                    Outcome outcome = invokeMethod(name, method, params);
                    if (outcome != null && outcome.store()) {
                        claim.finish(new IdempotencyStore.Stored(outcome.error(), outcome.payload()));
                        finished = true;
                    }
                    return outcome;
                } finally {
                    if (!finished) {
                        claim.abandon();
                    }
                }
            }
        }

        private Outcome invokeMethod(String name, RpcDispatcher.Method method, Map<String, Object> params) {
            return invoke(name, context -> method.handler().handle(context, params));
        }

        /**
         * @param label a method that exists, or a frame kind: never free text from the client
         * @return the outcome, or null if the handler gave up without applying anything
         */
        private Outcome invoke(String label, Invocation invocation) {
            try {
                Object result = invocation.call(context);
                byte[] payload = Json.bytes(result == null ? Map.of() : result);
                if (payload.length > FrameKind.RES.maxMessageBytes()) {
                    log.warn("rpc {} result over the size limit", label);
                    return noVerdict(new RpcException(RpcException.TOO_LARGE, "Result too large"));
                }
                return new Outcome(false, payload, true);
            } catch (RpcException e) {
                if (RpcException.CANCELLED.equals(e.code()) || RpcException.DEADLINE_EXCEEDED.equals(e.code())) {
                    return gaveUp(label);
                }
                return RpcException.UNAVAILABLE.equals(e.code()) ? noVerdict(e) : Outcome.error(e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return gaveUp(label);
            } catch (Exception | Error e) {
                // Class and place only: exception text can quote the payload.
                log.error("rpc {} failed: {} at {}", label, e.getClass().getName(), topFrame(e));
                return noVerdict(new RpcException(RpcException.INTERNAL, INTERNAL_MESSAGE));
            }
        }

        /**
         * An error that doesn't say whether the mutation's effect happened, unlike a handler's not_found
         * or forbidden, which say it didn't. This is the one place the flag is set, from the call's own
         * state, so no handler can forget it. Past {@link RpcContext#beginEffect} the command may have
         * gone out: the flag says so, and the reply stays on the key, so a retry can't send it twice while
         * the store has it. Before it nothing was done, and unavailable can go differently next time, so
         * that's not kept.
         */
        private Outcome noVerdict(RpcException error) {
            if (effectBegan()) {
                Map<String, Object> details = new LinkedHashMap<>(error.details());
                details.put(MAY_HAVE_APPLIED, true);
                return Outcome.error(new RpcException(error.code(), error.getMessage(), details));
            }
            return RpcException.UNAVAILABLE.equals(error.code()) ? Outcome.notStored(error) : Outcome.error(error);
        }

        /**
         * The handler stopped. Before the effect that leaves nothing to keep. Nothing here stops a call
         * past it, but if a handler ever does stop itself there, the key still can't be given up.
         */
        private Outcome gaveUp(String label) {
            if (!effectBegan()) {
                return null;
            }
            log.error("rpc {} stopped after it began applying", label);
            Thread.interrupted();
            return noVerdict(new RpcException(RpcException.INTERNAL, INTERNAL_MESSAGE));
        }

        /** Only a mutation has an effect to speak of, whatever a read's handler may call. */
        private boolean effectBegan() {
            return mutation && stage.get() == Stage.APPLYING;
        }

        private void answer(boolean error, byte[] payload) throws InterruptedException {
            boolean sent = false;
            try {
                if (answered.compareAndSet(false, true)) {
                    peer.send(error ? FrameKind.ERR : FrameKind.RES, request.id(), payload);
                    sent = true;
                }
            } catch (RpcPeer.PeerGoneException e) {
                log.debug("session gone before a reply could be sent");
            } finally {
                context.runAfterReply(sent);
            }
        }

        private boolean armDeadline(Object value) {
            if (!(value instanceof Number number) || number.doubleValue() <= 0) {
                return false;
            }
            long millis = Math.min(number.longValue(), MAX_DEADLINE_MS);
            deadlineTimer = Thread.ofVirtual().start(() -> {
                try {
                    Thread.sleep(Math.max(1, millis));
                    // From here on nothing interrupts this thread, or the error could be lost.
                    deadlineReached = true;
                    abort(new RpcException(RpcException.DEADLINE_EXCEEDED, "Deadline exceeded"));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            return true;
        }
    }

    @FunctionalInterface
    private interface Invocation {
        Object call(RpcContext context) throws Exception;
    }

    /** @param store false to give up the key, so that a retry runs the method again */
    private record Outcome(boolean error, byte[] payload, boolean store) {
        static Outcome error(RpcException error) {
            return new Outcome(true, errorPayload(error), true);
        }

        static Outcome notStored(RpcException error) {
            return new Outcome(true, errorPayload(error), false);
        }
    }

    private static RpcException scopeForbidden() {
        return new RpcException(RpcException.FORBIDDEN, "The token's scope doesn't allow this", Map.of("reason", "scope"));
    }

    private static String topFrame(Throwable error) {
        StackTraceElement[] frames = error.getStackTrace();
        return frames.length == 0 ? "unknown" : frames[0].toString();
    }
}
