package com.minimalistalliance.desk.deskd.rpc;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * The method table and what all sessions share. Methods are registered by name in code, so there's
 * no scanning or reflection. Each session gets its own {@link RpcSession}.
 *
 * <p><b>Scopes.</b> Each method names the token scopes that may call it, and a method that names none is the owner's
 * alone. So a new scope reaches nothing until a method says it may. A session of any other scope gets
 * {@code forbidden} with {@code reason: scope}, for a method that doesn't exist too, and so do its SUB and UNSUB.
 */
public final class RpcDispatcher {

    /** What a method is unless it says otherwise. */
    public static final Set<String> OWNER_ONLY = Set.of(RpcPrincipal.OWNER);
    /** desk.status.get and data.*: the owner's sessions and export ones. */
    public static final Set<String> OWNER_OR_EXPORT = Set.of(RpcPrincipal.OWNER, RpcPrincipal.EXPORT);

    /** Per-session limits. */
    public record Limits(int requestsPerSecond, int maxConcurrentRequests) {
        /** 200 requests/s from design 4.2.6; the concurrency figure is deskd's. */
        public static final Limits DEFAULT = new Limits(200, 32);
    }

    /** @param sessionBound a stored reply is good only in the session that ran it, so a retry from another runs again */
    record Method(RpcHandler handler, boolean mutation, Set<String> scopes, boolean sessionBound) {}

    private final Map<String, Method> methods = new ConcurrentHashMap<>();
    private final IdempotencyStore idempotency;
    private final Limits limits;
    private final LongSupplier nanoTime;

    public RpcDispatcher() {
        this(Limits.DEFAULT, System::nanoTime);
    }

    public RpcDispatcher(Limits limits, LongSupplier nanoTime) {
        this(
                limits,
                nanoTime,
                new IdempotencyStore(
                        nanoTime,
                        IdempotencyStore.DEFAULT_TTL_NANOS,
                        IdempotencyStore.DEFAULT_MAX_ENTRIES,
                        IdempotencyStore.DEFAULT_MAX_BYTES));
    }

    RpcDispatcher(Limits limits, LongSupplier nanoTime, IdempotencyStore idempotency) {
        this.limits = limits;
        this.nanoTime = nanoTime;
        this.idempotency = idempotency;
    }

    /** Registers a read for the owner: it runs every time and needs no idempotency key. */
    public void register(String method, RpcHandler handler) {
        register(method, OWNER_ONLY, handler);
    }

    /** Registers a read that sessions of these scopes may call. */
    public void register(String method, Set<String> scopes, RpcHandler handler) {
        add(method, new Method(handler, false, Set.copyOf(scopes), false));
    }

    /** Registers a mutation for the owner: requests must carry idem, and a replay returns the stored result. */
    public void registerMutation(String method, RpcHandler handler) {
        registerMutation(method, OWNER_ONLY, handler);
    }

    /** Registers a mutation that sessions of these scopes may call. */
    public void registerMutation(String method, Set<String> scopes, RpcHandler handler) {
        add(method, new Method(handler, true, Set.copyOf(scopes), false));
    }

    /**
     * Registers a mutation whose effect lasts only as long as the session that made it. Its idem key also names the
     * session, so a retry from another session runs it again rather than getting a reply about a session that ended.
     */
    public void registerSessionMutation(String method, Set<String> scopes, RpcHandler handler) {
        add(method, new Method(handler, true, Set.copyOf(scopes), true));
    }

    /** The per-session side, for a new session. */
    public RpcSession newSession(RpcPeer peer) {
        return new RpcSession(this, peer);
    }

    public Limits limits() {
        return limits;
    }

    Method method(String name) {
        return methods.get(name);
    }

    IdempotencyStore idempotency() {
        return idempotency;
    }

    LongSupplier nanoTime() {
        return nanoTime;
    }

    private void add(String name, Method method) {
        if (methods.putIfAbsent(name, method) != null) {
            throw new IllegalStateException("method registered twice: " + name);
        }
    }
}
