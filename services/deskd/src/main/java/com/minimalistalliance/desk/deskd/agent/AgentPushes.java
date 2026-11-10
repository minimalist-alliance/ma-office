package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * What deskd tells desk-agent that no client asked (ADR 0043): the Platform's price table and the account's values for
 * the desk's limits, on every connection and whenever they change. desk-agent keeps neither on disk.
 *
 * <p><b>Version skew.</b> An older desk-agent drops the link on a {@code t} it doesn't know, and an older deskd does the
 * same, so neither side can announce anything with a new one. So these are plain {@code req}s, with methods outside
 * {@code agent.*}: an older desk-agent answers {@code not_found}, as for any method it doesn't know, the link stays up,
 * and nothing more goes out until the next connection. An older deskd sends none, and desk-agent stays on its bundled
 * table. No client can send these: {@link AgentMethods} relays only the methods it lists.
 *
 * <p>One virtual thread, as a call waits for its answer and {@link AgentLink.Listener} mustn't block. Only the latest of
 * each goes out. Nothing here logs what's sent.
 */
final class AgentPushes implements AutoCloseable {

    static final String PRICES = "desk.prices.set";
    static final String ACCOUNT = "desk.account.set";
    /** A guild desk's agent settings (API.md section 14), which desk-agent turns into each member's limits. */
    static final String GUILD = "desk.guild.set";

    private static final Logger log = LoggerFactory.getLogger(AgentPushes.class);

    private record Push(String method, Map<String, Object> params, long version, long connection) {}

    private final AgentLink link;
    private final Duration wait;
    private final Duration retry;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    private Thread thread;
    private boolean closed;
    private boolean up;
    /** Counts connections, so an answer from the last one can't mark anything sent on this one. */
    private long connection;
    /** This connection's desk-agent answered {@code not_found}. */
    private boolean older;
    /** After no answer: nothing goes until this {@link System#nanoTime}, or a new connection. */
    private boolean holding;
    private long holdUntilNanos;
    private byte[] table;
    private long tableVersion;
    private long tableSent;
    private Map<String, Object> account;
    /** The owner's age band as deskd holds it ({@code adult}, {@code teen} or {@code unknown}), sent with the account's values. */
    private String band;
    private long accountVersion;
    private long accountSent;
    private Map<String, Object> guild;
    private long guildVersion;
    private long guildSent;

    AgentPushes(AgentLink link, Duration wait, Duration retry) {
        this.link = link;
        this.wait = wait;
        this.retry = retry;
    }

    void start() {
        lock.lock();
        try {
            if (thread == null && !closed) {
                thread = Thread.ofVirtual().name("agent-pushes").start(this::run);
            }
        } finally {
            lock.unlock();
        }
    }

    /** A new connection: everything known goes again. Never blocks. */
    void connected() {
        lock.lock();
        try {
            up = true;
            connection++;
            older = false;
            holding = false;
            tableSent = 0;
            accountSent = 0;
            guildSent = 0;
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

    /** The latest table. Never blocks. */
    void prices(byte[] latest) {
        lock.lock();
        try {
            table = latest;
            tableVersion++;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** The guild's latest agent settings, on a guild desk. Never blocks. */
    void guild(Map<String, Object> latest) {
        lock.lock();
        try {
            guild = latest;
            guildVersion++;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** The owner's age band, {@code adult}, {@code teen} or {@code unknown}: desk-agent starts no timer's or message's run unless adult. Never blocks. */
    void band(String latest) {
        lock.lock();
        try {
            if (!latest.equals(band)) {
                band = latest;
                accountVersion++;
                wake.signalAll();
            }
        } finally {
            lock.unlock();
        }
    }

    /** The account's latest values. Never blocks. */
    void account(Map<String, Object> latest) {
        lock.lock();
        try {
            account = latest;
            accountVersion++;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
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

    private void run() {
        try {
            while (true) {
                Push push = next();
                if (push == null) {
                    return;
                }
                try {
                    link.call(push.method(), push.params(), wait);
                    sent(push);
                } catch (RpcException e) {
                    answered(push, e);
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** The account's first, as it can change what a call is allowed to spend. @return null once closed */
    private Push next() throws InterruptedException {
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
                if (up && !older) {
                    // The guild's limits first: until desk-agent has them, it holds members to its own defaults.
                    if (guild != null && guildSent != guildVersion) {
                        return new Push(GUILD, guild, guildVersion, connection);
                    }
                    if ((account != null || band != null) && accountSent != accountVersion) {
                        Map<String, Object> params = new java.util.LinkedHashMap<>();
                        if (account != null) {
                            params.putAll(account);
                        }
                        if (band != null) {
                            params.put("band", band);
                        }
                        return new Push(ACCOUNT, params, accountVersion, connection);
                    }
                    if (table != null && tableSent != tableVersion) {
                        return new Push(PRICES, Map.of("table", new String(table, StandardCharsets.UTF_8)), tableVersion, connection);
                    }
                }
                wake.await();
            }
            return null;
        } finally {
            lock.unlock();
        }
    }

    private void sent(Push push) {
        lock.lock();
        try {
            if (push.connection() == connection) {
                if (push.method().equals(ACCOUNT)) {
                    accountSent = push.version();
                } else if (push.method().equals(GUILD)) {
                    guildSent = push.version();
                } else {
                    tableSent = push.version();
                }
            }
        } finally {
            lock.unlock();
        }
    }

    private void answered(Push push, RpcException e) {
        if (RpcException.NOT_FOUND.equals(e.code())) {
            lock.lock();
            try {
                if (push.connection() == connection && !older) {
                    older = true;
                    log.info("agent link: this desk-agent takes no prices or account values yet");
                }
            } finally {
                lock.unlock();
            }
        } else if (RpcException.UNAVAILABLE.equals(e.code())) {
            // No answer in time, or the link went. A new connection sends again anyway; this is for the one that stays up.
            lock.lock();
            try {
                if (push.connection() == connection) {
                    holding = true;
                    holdUntilNanos = System.nanoTime() + retry.toNanos();
                }
            } finally {
                lock.unlock();
            }
        } else {
            log.warn("agent link: desk-agent refused {}: {}", push.method(), e.code());
            sent(push);
        }
    }
}
