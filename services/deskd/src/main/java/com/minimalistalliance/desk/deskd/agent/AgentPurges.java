package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Sends a guild desk's owed member purges to desk-agent, one at a time, as {@code desk.member.purge {memberId}} (ADR
 * 0080's addendum of 2026-11-10). Like {@link AgentPushes}, it's a plain {@code req} of deskd's own with no caller,
 * outside {@code agent.*}, which {@link AgentMethods} never relays, so no client can send it; desk-agent refuses it from
 * any frame that carries a caller.
 *
 * <p>The list is kept on {@code /data/desk} by whoever owns it ({@link MemberPurges}), so a purge owed while desk-agent
 * is down, or answered by nothing, goes on the next connection. desk-agent's purge is idempotent, so one sent twice
 * (an answer lost with the link) does no harm. After an answer that isn't done, it waits {@code retry}, doubling to 5
 * minutes while that goes on, or the next connection. An older desk-agent answers {@code not_found}: nothing more goes
 * until the next connection.
 *
 * <p>One virtual thread. Nothing here logs a member's id.
 */
final class AgentPurges implements AutoCloseable {

    static final String METHOD = "desk.member.purge";

    private static final Logger log = LoggerFactory.getLogger(AgentPurges.class);
    private static final Duration MAX_RETRY = Duration.ofMinutes(5);
    /** The longest one wait for a due time, so a clock that jumps is read again. */
    private static final Duration MAX_SLEEP = Duration.ofMinutes(1);

    private final AgentLink link;
    private final Duration wait;
    private final Duration retry;
    private final Clock clock;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    private MemberPurges queue;
    private Thread thread;
    private boolean closed;
    private boolean up;
    private long connection;
    /** This connection's desk-agent answered {@code not_found}. */
    private boolean older;
    private boolean holding;
    private long holdUntilNanos;
    private Duration backoff;

    AgentPurges(AgentLink link, Duration wait, Duration retry, Clock clock) {
        this.link = link;
        this.wait = wait;
        this.retry = retry;
        this.clock = clock;
        this.backoff = retry;
    }

    /** The list to drain: a guild desk's. Before it's set, nothing goes. */
    void queue(MemberPurges purges) {
        lock.lock();
        try {
            queue = purges;
        } finally {
            lock.unlock();
        }
        purges.onChange(this::wake);
        wake();
    }

    void start() {
        lock.lock();
        try {
            if (thread == null && !closed) {
                thread = Thread.ofVirtual().name("agent-purges").start(this::run);
            }
        } finally {
            lock.unlock();
        }
    }

    void connected() {
        lock.lock();
        try {
            up = true;
            connection++;
            older = false;
            holding = false;
            backoff = retry;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    void disconnected() {
        lock.lock();
        try {
            up = false;
        } finally {
            lock.unlock();
        }
    }

    /** The list changed. Never blocks for long. */
    void wake() {
        lock.lock();
        try {
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** What {@code /health} adds. */
    Map<String, Object> health() {
        MemberPurges now;
        lock.lock();
        try {
            now = queue;
        } finally {
            lock.unlock();
        }
        return now == null ? Map.of() : now.health();
    }

    @Override
    public void close() {
        Thread running;
        lock.lock();
        try {
            closed = true;
            running = thread;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
        if (running != null) {
            running.interrupt();
        }
    }

    private record Next(String memberId, long connection, MemberPurges queue) {}

    private void run() {
        try {
            while (true) {
                Next next = next();
                if (next == null) {
                    return;
                }
                try {
                    Object answer = link.call(METHOD, Map.of("memberId", next.memberId()), wait);
                    next.queue().done(next.memberId(), answerOf(answer));
                    lock.lock();
                    try {
                        backoff = retry;
                    } finally {
                        lock.unlock();
                    }
                } catch (RpcException e) {
                    answered(next, e);
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static Map<String, Object> answerOf(Object answer) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (answer instanceof Map<?, ?> map) {
            map.forEach((k, v) -> out.put(String.valueOf(k), v));
        }
        return out;
    }

    /** @return null once closed */
    private Next next() throws InterruptedException {
        lock.lockInterruptibly();
        try {
            while (!closed) {
                if (holding) {
                    long left = holdUntilNanos - System.nanoTime();
                    if (left > 0) {
                        wake.awaitNanos(left);
                        continue;
                    }
                    holding = false;
                }
                if (up && !older && queue != null) {
                    List<String> due = queue.due();
                    if (!due.isEmpty()) {
                        return new Next(due.get(0), connection, queue);
                    }
                    long at = queue.nextDueAtMillis();
                    if (at != Long.MAX_VALUE) {
                        long millis = Math.max(1, Math.min(at - clock.millis(), MAX_SLEEP.toMillis()));
                        wake.await(millis, TimeUnit.MILLISECONDS);
                        continue;
                    }
                }
                wake.await();
            }
            return null;
        } finally {
            lock.unlock();
        }
    }

    private void answered(Next next, RpcException e) {
        lock.lock();
        try {
            if (next.connection() != connection) {
                return; // a new connection sends it again anyway
            }
            if (RpcException.NOT_FOUND.equals(e.code())) {
                if (!older) {
                    older = true;
                    log.info("agent link: this desk-agent can't purge a removed member yet; they wait for one that can");
                }
                return;
            }
            if (!RpcException.UNAVAILABLE.equals(e.code())) {
                log.warn("agent link: desk-agent didn't purge a removed member: {}; trying again in {} s", e.code(),
                        backoff.toSeconds());
            }
            holding = true;
            holdUntilNanos = System.nanoTime() + backoff.toNanos();
            backoff = backoff.multipliedBy(2).compareTo(MAX_RETRY) > 0 ? MAX_RETRY : backoff.multipliedBy(2);
        } finally {
            lock.unlock();
        }
    }
}
