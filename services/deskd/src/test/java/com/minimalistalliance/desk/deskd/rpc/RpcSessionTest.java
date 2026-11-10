package com.minimalistalliance.desk.deskd.rpc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.protocol.Message;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

@ExtendWith(OutputCaptureExtension.class)
class RpcSessionTest {

    static {
        TestTiming.pollFast();
    }

    private record Sent(FrameKind kind, long id, byte[] payload) {
        Map<String, Object> body() throws JsonFormatException {
            return Json.parseObject(payload);
        }
    }

    private static final class FakePeer implements RpcPeer {
        final BlockingQueue<Sent> sent = new LinkedBlockingQueue<>();
        final AtomicBoolean closedRateLimited = new AtomicBoolean();
        volatile boolean ready = true;
        volatile String sub = "user-1";
        volatile boolean input = true;
        volatile String scope = RpcPrincipal.OWNER;
        /** Runs when the session asks if HELLO is done, the last thing it asks before a call enters its table. */
        volatile Runnable onReadyCheck = () -> { };
        SubscriptionService subscriptions;

        @Override
        public boolean ready() {
            onReadyCheck.run();
            return ready;
        }

        @Override
        public RpcPrincipal principal() {
            return new RpcPrincipal(sub, scope, "cs-1", true, input);
        }

        @Override
        public SubscriptionService subscriptions() {
            return subscriptions;
        }

        @Override
        public void send(FrameKind kind, long id, byte[] payload) {
            sent.add(new Sent(kind, id, payload));
        }

        @Override
        public void closeRateLimited() {
            closedRateLimited.set(true);
        }

        Sent next() throws InterruptedException {
            Sent reply = sent.poll(5, TimeUnit.SECONDS);
            assertThat(reply).as("a reply").isNotNull();
            return reply;
        }
    }

    private final AtomicLong clock = new AtomicLong(1_000);
    private final RpcDispatcher dispatcher = new RpcDispatcher(RpcDispatcher.Limits.DEFAULT, clock::get);
    private final FakePeer peer = new FakePeer();
    private final RpcSession session = dispatcher.newSession(peer);

    private static Message request(long id, Object method, Object... rest) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("m", method);
        for (int i = 0; i < rest.length; i += 2) {
            body.put((String) rest[i], rest[i + 1]);
        }
        return new Message(FrameKind.REQ, false, false, id, 0, Json.bytes(body));
    }

    private Sent call(long id, Object method, Object... rest) throws Exception {
        session.onMessage(request(id, method, rest));
        return peer.next();
    }

    private static void assertError(Sent reply, long id, String code) throws Exception {
        assertThat(reply.kind()).isEqualTo(FrameKind.ERR);
        assertThat(reply.id()).isEqualTo(id);
        assertThat(reply.body()).containsEntry("code", code).containsKeys("message", "details");
    }

    @Test
    void aMethodIsTheOwnersAloneUnlessItNamesAnotherScope() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        dispatcher.register("owners", (context, params) -> Map.of("ran", ran.incrementAndGet()));
        dispatcher.registerMutation("owners.change", (context, params) -> Map.of("ran", ran.incrementAndGet()));
        dispatcher.register("shared", RpcDispatcher.OWNER_OR_EXPORT, (context, params) -> Map.of("ran", ran.incrementAndGet()));
        peer.scope = RpcPrincipal.EXPORT;
        Sent owners = call(1, "owners");
        assertError(owners, 1, "forbidden");
        assertThat(Json.object(owners.body(), "details")).containsEntry("reason", "scope");
        // Not even whether a method exists, and before idem is looked at.
        assertError(call(2, "no.such"), 2, "forbidden");
        assertError(call(3, "owners.change"), 3, "forbidden");
        assertThat(call(4, "shared").kind()).isEqualTo(FrameKind.RES);
        session.onMessage(new Message(FrameKind.SUB, false, false, 5, 0, Json.bytes(Map.of("topic", "browser.tabs"))));
        assertError(peer.next(), 5, "forbidden");
        session.onMessage(new Message(FrameKind.UNSUB, false, false, 6, 0, Json.bytes(Map.of("subId", 1))));
        assertError(peer.next(), 6, "forbidden");
        // A scope nothing names reaches nothing.
        peer.scope = "support";
        assertError(call(7, "shared"), 7, "forbidden");
        peer.scope = RpcPrincipal.OWNER;
        assertError(call(8, "no.such"), 8, "not_found");
        assertThat(call(9, "owners").kind()).isEqualTo(FrameKind.RES);
        assertThat(ran.get()).isEqualTo(2);
    }

    /**
     * Regression: a call was in the table before it had a thread, so a close from another thread
     * threw NullPointerException, which skipped telling desk-rtc and any other revoked sessions.
     */
    @Test
    void aSessionEndingWhileACallIsStartingDoesntThrow() throws Exception {
        RpcDispatcher busy = new RpcDispatcher(new RpcDispatcher.Limits(100_000_000, 1_000_000), System::nanoTime);
        busy.register("x", (context, params) -> Map.of());
        byte[] body = Json.bytes(Map.of("m", "x", "p", Map.of()));
        for (int round = 0; round < 500; round++) {
            RpcSession racing = busy.newSession(new FakePeer());
            AtomicBoolean going = new AtomicBoolean(true);
            Thread lane = Thread.ofPlatform().start(() -> {
                long id = 1;
                try {
                    while (going.get()) {
                        racing.onMessage(new Message(FrameKind.REQ, false, false, id++, 0, body));
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            Thread.sleep(0, 100_000);
            try {
                racing.shutdown();
            } finally {
                going.set(false);
                lane.join();
            }
            // Each round finishes its calls, so virtual threads don't pile up for the next test.
            await().until(() -> racing.inFlight() == 0);
        }
    }

    /** Regression: this killed the call's thread with no reply, and a stack trace on stderr. */
    @Test
    void aRequestWhosePayloadIsJustNullIsABadRequest() throws Exception {
        session.onMessage(new Message(FrameKind.REQ, false, false, 7, 0, "null".getBytes(StandardCharsets.UTF_8)));
        assertError(peer.next(), 7, RpcException.BAD_REQUEST);
    }

    @Test
    void aRequestGetsAnAnswerWithItsIdAndParams() throws Exception {
        dispatcher.register("echo", (context, params) -> Map.of("got", params, "sub", context.principal().sub()));
        Sent reply = call(7, "echo", "p", Map.of("a", 1));
        assertThat(reply.kind()).isEqualTo(FrameKind.RES);
        assertThat(reply.id()).isEqualTo(7);
        assertThat(reply.body()).containsEntry("got", Map.of("a", 1)).containsEntry("sub", "user-1");
    }

    @Test
    void aNullResultIsAnEmptyObjectAndUnknownFieldsAreIgnored() throws Exception {
        dispatcher.register("nothing", (context, params) -> null);
        Sent reply = call(1, "nothing", "somethingNew", true);
        assertThat(reply.kind()).isEqualTo(FrameKind.RES);
        assertThat(new String(reply.payload(), StandardCharsets.UTF_8)).isEqualTo("{}");
    }

    @Test
    void unknownMethodIsNotFound() throws Exception {
        assertError(call(1, "no.such.method"), 1, "not_found");
    }

    @Test
    void badBodiesAreBadRequest() throws Exception {
        dispatcher.register("x", (context, params) -> null);
        session.onMessage(new Message(FrameKind.REQ, false, false, 1, 0, "not json".getBytes(StandardCharsets.UTF_8)));
        assertError(peer.next(), 1, "bad_request");
        assertError(call(2, 42), 2, "bad_request");
        assertError(call(3, "x", "p", "not an object"), 3, "bad_request");
        assertError(call(4, "x", "deadlineMs", -1), 4, "bad_request");
        assertError(call(5, "x", "deadlineMs", "soon"), 5, "bad_request");
    }

    @Test
    void beforeHelloEveryRequestIsRefused() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        dispatcher.register("x", (context, params) -> ran.incrementAndGet());
        peer.ready = false;
        assertError(call(1, "x"), 1, "unauthorized");
        assertThat(ran).hasValue(0);
    }

    @Test
    void handlerExceptionsNeverReachTheClientOrTheLog(CapturedOutput output) throws Exception {
        dispatcher.register("boom", (context, params) -> {
            throw new IllegalStateException("secret-password-in-exception");
        });
        Sent reply = call(1, "boom", "p", Map.of("note", "secret-note-in-payload"));
        assertError(reply, 1, "internal");
        assertThat(new String(reply.payload(), StandardCharsets.UTF_8))
                .doesNotContain("secret")
                .doesNotContain("IllegalStateException");
        assertThat(output.getAll())
                .contains("rpc boom failed", "IllegalStateException")
                .doesNotContain("secret-password-in-exception")
                .doesNotContain("secret-note-in-payload");
    }

    @Test
    void anRpcExceptionReachesTheClientAsWritten() throws Exception {
        dispatcher.register("stale", (context, params) -> {
            throw new RpcException(RpcException.PRECONDITION_FAILED, "Row changed", Map.of("rowVersion", 9));
        });
        Sent reply = call(1, "stale");
        assertError(reply, 1, "precondition_failed");
        assertThat(reply.body()).containsEntry("message", "Row changed").containsEntry("details", Map.of("rowVersion", 9));
    }

    @Test
    void aResultOverTheLimitIsTooLarge(CapturedOutput output) throws Exception {
        dispatcher.register("huge", (context, params) -> Map.of("v", "x".repeat(FrameKind.RES.maxMessageBytes())));
        assertError(call(1, "huge"), 1, "too_large");
        assertThat(output.getAll()).doesNotContain("xxxx");
    }

    @Test
    void anIdStillInFlightIsRefused() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.register("slow", (context, params) -> {
            release.await();
            return "done";
        });
        session.onMessage(request(1, "slow"));
        await().until(() -> session.inFlight() == 1);
        assertError(call(1, "slow"), 1, "bad_request");
        release.countDown();
        assertThat(peer.next().kind()).isEqualTo(FrameKind.RES);
    }

    @Test
    void mutationsRequireAnIdempotencyKey() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> ran.incrementAndGet());
        assertError(call(1, "do"), 1, "bad_request");
        assertError(call(2, "do", "idem", ""), 2, "bad_request");
        assertError(call(3, "do", "idem", 12), 3, "bad_request");
        assertError(call(4, "do", "idem", "k".repeat(129)), 4, "bad_request");
        assertThat(ran).hasValue(0);
    }

    @Test
    void aReplayReturnsTheStoredResultWithoutRunningTheHandler() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> Map.of("run", ran.incrementAndGet()));
        Sent first = call(1, "do", "idem", "key-1");
        Sent replay = call(2, "do", "idem", "key-1");
        assertThat(first.kind()).isEqualTo(FrameKind.RES);
        assertThat(replay.kind()).isEqualTo(FrameKind.RES);
        assertThat(replay.id()).isEqualTo(2);
        assertThat(replay.payload()).isEqualTo(first.payload());
        assertThat(ran).hasValue(1);

        Sent other = call(3, "do", "idem", "key-2");
        assertThat(other.body()).containsEntry("run", 2);
    }

    @Test
    void anErrorOutcomeIsStoredToo() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> {
            ran.incrementAndGet();
            throw new RpcException(RpcException.CONFLICT, "Taken");
        });
        assertError(call(1, "do", "idem", "key"), 1, "conflict");
        assertError(call(2, "do", "idem", "key"), 2, "conflict");
        assertThat(ran).hasValue(1);
    }

    @Test
    void aRetryOfACallStillRunningWaitsForIt() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            ran.incrementAndGet();
            release.await();
            return Map.of("ok", true);
        });
        session.onMessage(request(1, "do", "idem", "key"));
        await().until(() -> ran.get() == 1);
        session.onMessage(request(2, "do", "idem", "key"));
        await().until(() -> session.inFlight() == 2);
        assertThat(peer.sent).isEmpty();
        release.countDown();
        Sent a = peer.next();
        Sent b = peer.next();
        assertThat(a.payload()).isEqualTo(b.payload());
        assertThat(ran).hasValue(1);
    }

    @Test
    void keysBelongToOneUserAndOneMethod() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        dispatcher.registerMutation("a", (context, params) -> Map.of("run", ran.incrementAndGet()));
        dispatcher.registerMutation("b", (context, params) -> Map.of("run", ran.incrementAndGet()));
        call(1, "a", "idem", "key");
        call(2, "b", "idem", "key");
        peer.sub = "user-2";
        call(3, "a", "idem", "key");
        assertThat(ran).hasValue(3);
    }

    @Test
    void storedResultsExpireAfterTenMinutes() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> Map.of("run", ran.incrementAndGet()));
        call(1, "do", "idem", "key");

        clock.addAndGet(TimeUnit.MINUTES.toNanos(9));
        call(2, "do", "idem", "key");
        assertThat(ran).hasValue(1);

        clock.addAndGet(TimeUnit.MINUTES.toNanos(1));
        call(3, "do", "idem", "key");
        assertThat(ran).hasValue(2);
        assertThat(dispatcher.idempotency().size()).isEqualTo(1);
    }

    @Test
    void theStoreIsBoundedByCountAndBytes() {
        IdempotencyStore byCount = new IdempotencyStore(clock::get, Long.MAX_VALUE, 3, Long.MAX_VALUE);
        for (int i = 0; i < 10; i++) {
            byCount.claim("u", "m", "k" + i).finish(new IdempotencyStore.Stored(false, new byte[10]));
        }
        assertThat(byCount.size()).isEqualTo(3);
        assertThat(byCount.storedBytes()).isEqualTo(30);

        IdempotencyStore byBytes = new IdempotencyStore(clock::get, Long.MAX_VALUE, 1000, 100);
        for (int i = 0; i < 10; i++) {
            byBytes.claim("u", "m", "k" + i).finish(new IdempotencyStore.Stored(false, new byte[40]));
        }
        assertThat(byBytes.storedBytes()).isLessThanOrEqualTo(100);
        assertThat(byBytes.size()).isEqualTo(2);
    }

    @Test
    void theOldestStoredResultsGoFirstAndRunningCallsStay() {
        IdempotencyStore store = new IdempotencyStore(clock::get, Long.MAX_VALUE, 2, Long.MAX_VALUE);
        IdempotencyStore.Claim running = store.claim("u", "m", "running");
        store.claim("u", "m", "old").finish(new IdempotencyStore.Stored(false, new byte[1]));
        store.claim("u", "m", "new").finish(new IdempotencyStore.Stored(false, new byte[1]));
        assertThat(store.size()).isEqualTo(2);
        assertThat(store.claim("u", "m", "running").isOwner()).isFalse();
        assertThat(store.claim("u", "m", "new").isOwner()).isFalse();
        assertThat(store.claim("u", "m", "old").isOwner()).isTrue();
        running.abandon();
    }

    @Test
    void cancelAbortsARunningRequest() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch interrupted = new CountDownLatch(1);
        dispatcher.register("slow", (context, params) -> {
            started.countDown();
            try {
                new CountDownLatch(1).await();
            } catch (InterruptedException e) {
                interrupted.countDown();
                throw e;
            }
            return "never";
        });
        session.onMessage(request(5, "slow"));
        started.await();
        session.onMessage(new Message(FrameKind.CANCEL, false, false, 5, 0, new byte[0]));
        assertError(peer.next(), 5, "cancelled");
        assertThat(interrupted.await(5, TimeUnit.SECONDS)).isTrue();
        await().until(() -> session.inFlight() == 0);
        assertThat(peer.sent).isEmpty();
    }

    @Test
    void aCancelThatLandsAfterTheWorkIsDoneRunsTheDroppedTaskNotTheSentOne() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch finish = new CountDownLatch(1);
        AtomicInteger sent = new AtomicInteger();
        AtomicInteger dropped = new AtomicInteger();
        dispatcher.register("work", (context, params) -> {
            started.countDown();
            try {
                finish.await();
            } catch (InterruptedException e) {
                // The work was already done, so the cancel finds nobody to stop.
            }
            context.afterReply(sent::incrementAndGet, dropped::incrementAndGet);
            return Map.of();
        });
        session.onMessage(request(5, "work"));
        started.await();
        session.onMessage(new Message(FrameKind.CANCEL, false, false, 5, 0, new byte[0]));
        assertError(peer.next(), 5, "cancelled");
        finish.countDown();
        await().until(() -> session.inFlight() == 0);
        assertThat(dropped).hasValue(1);
        assertThat(sent).hasValue(0);
        assertThat(peer.sent).isEmpty();

        dispatcher.register("quick", (context, params) -> {
            context.afterReply(sent::incrementAndGet, dropped::incrementAndGet);
            return Map.of();
        });
        assertThat(call(6, "quick").kind()).isEqualTo(FrameKind.RES);
        await().untilAtomic(sent, org.hamcrest.Matchers.equalTo(1));
        assertThat(dropped).hasValue(1);
    }

    @Test
    void cancelForAnIdNotRunningDoesNothing() throws Exception {
        session.onMessage(new Message(FrameKind.CANCEL, false, false, 99, 0, new byte[0]));
        assertThat(peer.sent).isEmpty();
    }

    @Test
    void aMutationAbortedByCancelCanBeRetried() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch started = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            if (runs.incrementAndGet() == 1) {
                started.countDown();
                new CountDownLatch(1).await();
            }
            return Map.of("run", runs.get());
        });
        session.onMessage(request(5, "do", "idem", "key"));
        started.await();
        session.onMessage(new Message(FrameKind.CANCEL, false, false, 5, 0, new byte[0]));
        assertError(peer.next(), 5, "cancelled");
        await().until(() -> session.inFlight() == 0);

        assertThat(call(6, "do", "idem", "key").body()).containsEntry("run", 2);
    }

    @Test
    void aMutationThatFinishesDespiteCancelKeepsItsResult() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch cancelled = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            started.countDown();
            try {
                new CountDownLatch(1).await();
            } catch (InterruptedException ignored) {
                cancelled.countDown();
            }
            return Map.of("applied", true);
        });
        session.onMessage(request(5, "do", "idem", "key"));
        started.await();
        session.onMessage(new Message(FrameKind.CANCEL, false, false, 5, 0, new byte[0]));
        assertError(peer.next(), 5, "cancelled");
        cancelled.await();
        await().until(() -> session.inFlight() == 0);

        assertThat(call(6, "do", "idem", "key").body()).containsEntry("applied", true);
        assertThat(runs).hasValue(1);
    }

    /** Once a handler has started on what it can't take back, the client stops waiting but it doesn't stop. */
    @Test
    void aDeadlineAfterBeginEffectKeepsTheResultForARetry() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch release = new CountDownLatch(1);
        AtomicBoolean interrupted = new AtomicBoolean();
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            try {
                release.await();
            } catch (InterruptedException e) {
                interrupted.set(true);
                throw e;
            }
            return Map.of("run", runs.get());
        });
        session.onMessage(request(5, "do", "idem", "key", "deadlineMs", 30));
        assertError(peer.next(), 5, "deadline_exceeded");
        session.onMessage(request(6, "do", "idem", "key"));
        await().until(() -> session.inFlight() == 2);
        release.countDown();
        assertThat(peer.next().body()).containsEntry("run", 1);
        assertThat(runs).hasValue(1);
        assertThat(interrupted).isFalse();
    }

    @Test
    void aCancelAfterBeginEffectKeepsTheResultForARetry() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            started.countDown();
            release.await();
            return Map.of("run", runs.get());
        });
        session.onMessage(request(5, "do", "idem", "key"));
        started.await();
        session.onMessage(new Message(FrameKind.CANCEL, false, false, 5, 0, new byte[0]));
        assertError(peer.next(), 5, "cancelled");
        release.countDown();
        await().until(() -> session.inFlight() == 0);
        assertThat(call(6, "do", "idem", "key").body()).containsEntry("run", 1);
    }

    @Test
    void aSessionEndingBeforeBeginEffectStopsTheHandlerAndARetryRunsIt() throws Exception {
        AtomicInteger effects = new AtomicInteger();
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            started.countDown();
            release.await();
            context.beginEffect();
            return Map.of("effect", effects.incrementAndGet());
        });
        session.onMessage(request(5, "do", "idem", "key"));
        started.await();
        session.shutdown();
        release.countDown();
        await().until(() -> session.inFlight() == 0);
        assertThat(effects).hasValue(0);
        assertThat(peer.sent).isEmpty();

        FakePeer nextPeer = new FakePeer();
        dispatcher.newSession(nextPeer).onMessage(request(6, "do", "idem", "key"));
        assertThat(nextPeer.next().body()).containsEntry("effect", 1);
    }

    /**
     * Regression. shutdown() goes through the table, and a call about to enter it wasn't there to be
     * stopped, so it got past beginEffect after a revocation. In real life that's another thread ending
     * the session in that gap. Doing it from the last check before the gap is the same order of events.
     */
    @Test
    void aSessionEndingJustBeforeACallEntersTheTableStopsItToo() throws Exception {
        AtomicInteger effects = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> {
            context.beginEffect();
            return Map.of("effect", effects.incrementAndGet());
        });
        peer.onReadyCheck = session::shutdown;
        session.onMessage(request(5, "do", "idem", "key"));
        await().until(() -> session.inFlight() == 0);
        assertThat(effects).hasValue(0);
        assertThat(peer.sent).isEmpty();

        FakePeer nextPeer = new FakePeer();
        dispatcher.newSession(nextPeer).onMessage(request(6, "do", "idem", "key"));
        assertThat(nextPeer.next().body()).containsEntry("effect", 1);
        assertThat(effects).hasValue(1);
    }

    @Test
    void aSessionEndingAfterBeginEffectLetsTheHandlerFinishAndKeepsItsResult() throws Exception {
        AtomicInteger effects = new AtomicInteger();
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            context.beginEffect();
            started.countDown();
            release.await();
            return Map.of("effect", effects.incrementAndGet());
        });
        session.onMessage(request(5, "do", "idem", "key"));
        started.await();
        session.shutdown();
        release.countDown();
        await().until(() -> session.inFlight() == 0);

        FakePeer nextPeer = new FakePeer();
        dispatcher.newSession(nextPeer).onMessage(request(6, "do", "idem", "key"));
        assertThat(nextPeer.next().body()).containsEntry("effect", 1);
        assertThat(effects).hasValue(1);
    }

    @Test
    void aCancelBeforeBeginEffectStopsTheHandler() throws Exception {
        AtomicInteger effects = new AtomicInteger();
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            started.countDown();
            try {
                release.await();
            } catch (InterruptedException e) {
                // A handler that shrugs off the interrupt still can't pass the gate.
            }
            context.beginEffect();
            return Map.of("effect", effects.incrementAndGet());
        });
        session.onMessage(request(5, "do", "idem", "key"));
        started.await();
        session.onMessage(new Message(FrameKind.CANCEL, false, false, 5, 0, new byte[0]));
        assertError(peer.next(), 5, "cancelled");
        await().until(() -> session.inFlight() == 0);
        assertThat(effects).hasValue(0);
    }

    // ---- what an error says about a mutation's effect

    private static RpcException unavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "Not reachable", Map.of("reason", "chromium"));
    }

    private static final Map<String, Object> FLAGGED = Map.of("reason", "chromium", "mayHaveApplied", true);

    private static void assertUnavailable(Sent reply, long id, Map<String, Object> details) throws Exception {
        assertError(reply, id, RpcException.UNAVAILABLE);
        assertThat(reply.body()).containsEntry("details", details);
    }

    @Test
    void unavailableBeforeTheEffectIsNotStoredAndARetryOnTheSameKeyRunsTheMethod() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> {
            if (runs.incrementAndGet() == 1) {
                throw unavailable();
            }
            context.beginEffect();
            return Map.of("run", runs.get());
        });
        assertUnavailable(call(1, "do", "idem", "key"), 1, Map.of("reason", "chromium"));
        assertThat(dispatcher.idempotency().size()).isZero();

        assertThat(call(2, "do", "idem", "key").body()).containsEntry("run", 2);
        assertThat(runs).hasValue(2);
    }

    @Test
    void unavailableAfterTheEffectIsFlaggedAndARetryOnTheSameKeyReplaysItWithoutRunningTheMethod() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            throw unavailable();
        });
        Sent first = call(1, "do", "idem", "key");
        assertUnavailable(first, 1, FLAGGED);
        assertThat(first.body()).containsEntry("message", "Not reachable");

        Sent replay = call(2, "do", "idem", "key");
        assertUnavailable(replay, 2, FLAGGED);
        assertThat(replay.payload()).isEqualTo(first.payload());
        assertThat(runs).hasValue(1);
    }

    @Test
    void aWaiterClaimsTheKeyWhenTheOwnerFailsBeforeTheEffect() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch ownerRunning = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            if (runs.incrementAndGet() == 1) {
                ownerRunning.countDown();
                release.await();
                throw unavailable();
            }
            context.beginEffect();
            return Map.of("run", runs.get());
        });
        session.onMessage(request(1, "do", "idem", "key"));
        ownerRunning.await();
        session.onMessage(request(2, "do", "idem", "key"));
        await().until(() -> session.inFlight() == 2);
        assertThat(peer.sent).isEmpty();
        release.countDown();

        Map<Long, Sent> replies = new HashMap<>();
        for (int i = 0; i < 2; i++) {
            Sent reply = peer.next();
            replies.put(reply.id(), reply);
        }
        assertUnavailable(replies.get(1L), 1, Map.of("reason", "chromium"));
        assertThat(replies.get(2L).kind()).isEqualTo(FrameKind.RES);
        assertThat(replies.get(2L).body()).containsEntry("run", 2);
        assertThat(runs).hasValue(2);
    }

    @Test
    void aWaiterGetsTheFlaggedReplyWhenTheOwnerFailsAfterTheEffect() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch applying = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            applying.countDown();
            release.await();
            throw unavailable();
        });
        session.onMessage(request(1, "do", "idem", "key"));
        applying.await();
        session.onMessage(request(2, "do", "idem", "key"));
        await().until(() -> session.inFlight() == 2);
        release.countDown();

        Sent a = peer.next();
        Sent b = peer.next();
        assertUnavailable(a, a.id(), FLAGGED);
        assertUnavailable(b, b.id(), FLAGGED);
        assertThat(runs).hasValue(1);
    }

    @Test
    void aDeadlinePastTheEffectThenUnavailableLeavesTheFlaggedReplyForARetry() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            release.await();
            throw unavailable();
        });
        session.onMessage(request(1, "do", "idem", "key", "deadlineMs", 30));
        assertError(peer.next(), 1, RpcException.DEADLINE_EXCEEDED);
        release.countDown();
        await().until(() -> session.inFlight() == 0);
        assertThat(peer.sent).isEmpty();

        assertUnavailable(call(2, "do", "idem", "key"), 2, FLAGGED);
        assertThat(runs).hasValue(1);
    }

    @Test
    void aCancelPastTheEffectThenUnavailableLeavesTheFlaggedReplyForARetry() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch applying = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            applying.countDown();
            release.await();
            throw unavailable();
        });
        session.onMessage(request(1, "do", "idem", "key"));
        applying.await();
        session.onMessage(new Message(FrameKind.CANCEL, false, false, 1, 0, new byte[0]));
        assertError(peer.next(), 1, RpcException.CANCELLED);
        release.countDown();
        await().until(() -> session.inFlight() == 0);

        assertUnavailable(call(2, "do", "idem", "key"), 2, FLAGGED);
        assertThat(runs).hasValue(1);
    }

    @Test
    void aSessionEndingPastTheEffectThenUnavailableLeavesTheFlaggedReplyForANewSession() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch applying = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            applying.countDown();
            release.await();
            throw unavailable();
        });
        session.onMessage(request(1, "do", "idem", "key"));
        applying.await();
        session.shutdown();
        release.countDown();
        await().until(() -> session.inFlight() == 0);

        FakePeer nextPeer = new FakePeer();
        dispatcher.newSession(nextPeer).onMessage(request(2, "do", "idem", "key"));
        assertUnavailable(nextPeer.next(), 2, FLAGGED);
        assertThat(runs).hasValue(1);
    }

    @Test
    void internalAfterTheEffectIsFlaggedAndStoredWithItsFixedMessage() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            throw new IllegalStateException("secret-password-in-exception");
        });
        Sent first = call(1, "do", "idem", "key");
        assertError(first, 1, RpcException.INTERNAL);
        assertThat(first.body()).containsEntry("message", "Internal error").containsEntry("details", Map.of("mayHaveApplied", true));
        assertThat(new String(first.payload(), StandardCharsets.UTF_8)).doesNotContain("secret");

        assertThat(call(2, "do", "idem", "key").payload()).isEqualTo(first.payload());
        assertThat(runs).hasValue(1);
    }

    @Test
    void internalBeforeTheEffectStaysStoredWithNoFlag() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            throw new IllegalStateException("broken");
        });
        Sent first = call(1, "do", "idem", "key");
        assertError(first, 1, RpcException.INTERNAL);
        assertThat(first.body()).containsEntry("details", Map.of());
        assertThat(call(2, "do", "idem", "key").payload()).isEqualTo(first.payload());
        assertThat(runs).hasValue(1);
    }

    @Test
    void aResultTooLargeAfterTheEffectIsFlaggedAndStored() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            return Map.of("v", "x".repeat(FrameKind.RES.maxMessageBytes()));
        });
        Sent first = call(1, "do", "idem", "key");
        assertError(first, 1, RpcException.TOO_LARGE);
        assertThat(first.body()).containsEntry("details", Map.of("mayHaveApplied", true));
        assertThat(call(2, "do", "idem", "key").payload()).isEqualTo(first.payload());
        assertThat(runs).hasValue(1);
    }

    @Test
    void aResultTooLargeBeforeTheEffectStaysStoredWithNoFlag() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        dispatcher.registerMutation("do", (context, params) -> {
            runs.incrementAndGet();
            return Map.of("v", "x".repeat(FrameKind.RES.maxMessageBytes()));
        });
        Sent first = call(1, "do", "idem", "key");
        assertError(first, 1, RpcException.TOO_LARGE);
        assertThat(first.body()).containsEntry("details", Map.of());
        assertThat(call(2, "do", "idem", "key").payload()).isEqualTo(first.payload());
        assertThat(runs).hasValue(1);
    }

    /** They say the command didn't apply, so a flag would be wrong. */
    @Test
    void otherHandlerErrorsAfterTheEffectStayAsTheyAre() throws Exception {
        for (String code : List.of(RpcException.NOT_FOUND, RpcException.FORBIDDEN, RpcException.CONFLICT, RpcException.TOO_LARGE)) {
            AtomicInteger runs = new AtomicInteger();
            dispatcher.registerMutation("do." + code, (context, params) -> {
                runs.incrementAndGet();
                context.beginEffect();
                throw new RpcException(code, "No", Map.of("reason", "tab"));
            });
            Sent first = call(1, "do." + code, "idem", "key");
            assertError(first, 1, code);
            assertThat(first.body()).containsEntry("details", Map.of("reason", "tab"));
            assertThat(call(2, "do." + code, "idem", "key").payload()).isEqualTo(first.payload());
            assertThat(runs).hasValue(1);
            // The next round uses these ids again, and a call leaves the table just after its reply.
            await().until(() -> session.inFlight() == 0);
        }
    }

    /** Nothing stops a call past its effect, but a handler that stops itself there still can't free the key. */
    @Test
    void aHandlerGivingUpPastTheEffectKeepsTheKey() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        dispatcher.registerMutation("stopped", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            throw new InterruptedException();
        });
        dispatcher.registerMutation("cancelled", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            throw new RpcException(RpcException.CANCELLED, "Cancelled");
        });
        for (String method : List.of("stopped", "cancelled")) {
            runs.set(0);
            Sent first = call(1, method, "idem", "key");
            assertError(first, 1, RpcException.INTERNAL);
            assertThat(first.body()).containsEntry("details", Map.of("mayHaveApplied", true));
            assertThat(call(2, method, "idem", "key").payload()).isEqualTo(first.payload());
            assertThat(runs).hasValue(1);
        }
    }

    /** Only a mutation has an effect to speak of, even if a read's handler goes through the same code. */
    @Test
    void aReadOrASubscriptionIsNeverFlagged() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        dispatcher.register("read", (context, params) -> {
            runs.incrementAndGet();
            context.beginEffect();
            throw unavailable();
        });
        assertUnavailable(call(1, "read"), 1, Map.of("reason", "chromium"));
        assertUnavailable(call(2, "read"), 2, Map.of("reason", "chromium"));
        assertThat(runs).hasValue(2);

        peer.subscriptions = new SubscriptionService() {
            @Override
            public Object subscribe(RpcContext context, Map<String, Object> request) throws RpcException {
                context.beginEffect();
                throw unavailable();
            }

            @Override
            public Object unsubscribe(RpcContext context, Map<String, Object> request) {
                return Map.of();
            }
        };
        session.onMessage(new Message(FrameKind.SUB, false, false, 3, 0, Json.bytes(Map.of("topic", "t"))));
        assertUnavailable(peer.next(), 3, Map.of("reason", "chromium"));
    }

    @Test
    void aHandlerAlwaysSeesTheSessionsCurrentPermissions() throws Exception {
        AtomicReference<RpcContext> seen = new AtomicReference<>();
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch started = new CountDownLatch(1);
        dispatcher.register("look", (context, params) -> {
            seen.set(context);
            started.countDown();
            release.await();
            return Map.of("input", context.principal().input());
        });
        session.onMessage(request(5, "look"));
        started.await();
        assertThat(seen.get().principal().input()).isTrue();
        peer.input = false;
        release.countDown();
        assertThat(peer.next().body()).containsEntry("input", false);
    }

    @Test
    void aDeadlineAnswersDeadlineExceededAndInterruptsTheHandler() throws Exception {
        CountDownLatch interrupted = new CountDownLatch(1);
        dispatcher.register("slow", (context, params) -> {
            try {
                new CountDownLatch(1).await();
            } catch (InterruptedException e) {
                interrupted.countDown();
                throw e;
            }
            return "never";
        });
        long start = System.nanoTime();
        session.onMessage(request(1, "slow", "deadlineMs", 50));
        assertError(peer.next(), 1, "deadline_exceeded");
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isGreaterThanOrEqualTo(Duration.ofMillis(50));
        assertThat(interrupted.await(5, TimeUnit.SECONDS)).isTrue();
        await().until(() -> session.inFlight() == 0);
    }

    @Test
    void aDeadlineNotReachedChangesNothing() throws Exception {
        dispatcher.register("quick", (context, params) -> "done");
        Sent reply = call(1, "quick", "deadlineMs", 10_000);
        assertThat(reply.kind()).isEqualTo(FrameKind.RES);
        await().until(() -> session.inFlight() == 0);
    }

    @Test
    void theRateLimitAllows200AndThenRefusesUntilItRefills() throws Exception {
        dispatcher.register("x", (context, params) -> Map.of());
        for (int i = 0; i < 200; i++) {
            session.onMessage(request(i, "x"));
            assertThat(peer.next().kind()).as("request %d", i).isEqualTo(FrameKind.RES);
        }
        Sent refused = call(1000, "x");
        assertError(refused, 1000, "rate_limited");

        clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(50));
        for (int i = 0; i < 10; i++) {
            assertThat(call(1001 + i, "x").kind()).isEqualTo(FrameKind.RES);
        }
        assertError(call(2000, "x"), 2000, "rate_limited");
    }

    @Test
    void aClientThatIgnoresRateLimitedGetsClosed() throws Exception {
        dispatcher.register("x", (context, params) -> Map.of());
        for (int i = 0; i < 200; i++) {
            session.onMessage(request(i, "x"));
        }
        for (int i = 0; i < RpcSession.MAX_REJECT_STREAK; i++) {
            assertThat(peer.closedRateLimited).isFalse();
            session.onMessage(request(1000 + i, "x"));
        }
        assertThat(peer.closedRateLimited).isTrue();
    }

    @Test
    void concurrentRequestsAreBounded() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        dispatcher.register("slow", (context, params) -> {
            release.await();
            return Map.of();
        });
        int limit = RpcDispatcher.Limits.DEFAULT.maxConcurrentRequests();
        for (int i = 0; i < limit; i++) {
            session.onMessage(request(i, "slow"));
        }
        await().until(() -> session.inFlight() == limit);
        assertError(call(9999, "slow"), 9999, "rate_limited");
        release.countDown();
        await().until(() -> session.inFlight() == 0);
    }

    @Test
    void aFloodDoesntStopCancelReachingARunningCall() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        dispatcher.register("slow", (context, params) -> {
            started.countDown();
            new CountDownLatch(1).await();
            return "never";
        });
        session.onMessage(request(1, "slow"));
        started.await();
        for (int i = 0; i < 400; i++) {
            session.onMessage(request(100 + i, "unknown"));
        }
        session.onMessage(new Message(FrameKind.CANCEL, false, false, 1, 0, new byte[0]));
        await().until(() -> session.inFlight() == 0);
    }

    @Test
    void whenTheSessionEndsReadsStopAndMutationsFinishForTheirRetry() throws Exception {
        CountDownLatch started = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch readInterrupted = new CountDownLatch(1);
        AtomicInteger mutationRuns = new AtomicInteger();
        dispatcher.register("read", (context, params) -> {
            started.countDown();
            try {
                new CountDownLatch(1).await();
            } catch (InterruptedException e) {
                readInterrupted.countDown();
                throw e;
            }
            return "never";
        });
        dispatcher.registerMutation("write", (context, params) -> {
            mutationRuns.incrementAndGet();
            started.countDown();
            release.await();
            return Map.of("applied", true);
        });
        session.onMessage(request(1, "read"));
        session.onMessage(request(2, "write", "idem", "key"));
        started.await();

        session.shutdown();
        assertThat(readInterrupted.await(5, TimeUnit.SECONDS)).isTrue();
        await().until(() -> session.inFlight() == 1);
        release.countDown();
        await().until(() -> session.inFlight() == 0);
        assertThat(peer.sent).isEmpty();

        // The retry, from a new session, finds the result.
        FakePeer newPeer = new FakePeer();
        RpcSession next = dispatcher.newSession(newPeer);
        next.onMessage(request(3, "write", "idem", "key"));
        assertThat(newPeer.next().body()).containsEntry("applied", true);
        assertThat(mutationRuns).hasValue(1);
    }

    @Test
    void anOversizeRequestIsRefusedOnItsOwn() throws Exception {
        session.refuseTooLarge(44);
        assertError(peer.next(), 44, "too_large");
    }
}
