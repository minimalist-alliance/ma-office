package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's one connection to Chromium: the browser-level WebSocket, with flat sessions for pages
 * (ADR 0041). The endpoint comes from GET /json/version, but only its path: the host and port are
 * always the loopback ones deskd was told, since a page can't choose them.
 *
 * <p><b>Origin.</b> The JDK's client sends none, and Chromium only checks --remote-allow-origins for a
 * request that has one, so no such flag is needed. Checked once against Chrome 156: a handshake with an
 * Origin is refused and one without is accepted.
 *
 * <p><b>Reconnecting.</b> One connector thread exists only while something wants the connection, as
 * {@code wanted} says. On an idle desk there's no thread, no timer and no socket, Chromium or not.
 * Closing this connection, or this process ending, disturbs nothing in Chromium.
 *
 * <p><b>Memory.</b> Everything Chromium sends is untrusted, as web content sets much of it. It comes in
 * through {@link BoundedJsonText}, one message at a time, and the next isn't asked for until this one is
 * dealt with, so the socket pushes back instead of a queue growing here.
 *
 * <p><b>A connection that went unnoticed.</b> On JDK 21 an end of input that arrives while the listener
 * is taking a message is lost: the transport has no demand then, {@code acknowledgeReception} throws
 * InternalError on its own thread, and neither onClose nor onError ever comes. It happened in about 2 of
 * 5 tries with a socket closed right after a burst of messages, which is how a crash looks. So while the
 * connection is open and wanted, a small command every few seconds proves it's alive.
 *
 * <p><b>Who's listening.</b> Anyone local can bind the port while Chromium is down, so {@link CdpListener} is asked
 * before each request to it, and again once a WebSocket is open, before anything is sent or believed. Whoever answers
 * a request stays in that table for as long as they hold the connection, listening or not, and the client's keep-alive
 * pool can't take a request back to them unseen. What can't be shown either way is the one request that lands in the
 * moment after a look, and those send nothing: /json/version gives only a path, which has to match, and /json/list
 * only the order of tabs deskd knows.
 *
 * <p><b>Where titles come from.</b> Target.* over this connection, as the page set them. /json/list has them too, but
 * Chromium escapes them for HTML there and only there (checked on Chrome 156), so nothing but its order is read.
 *
 * <p><b>Threads.</b> Calls park on their own threads. No lock is held across any wait for Chromium.
 */
final class CdpClient implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(CdpClient.class);

    /** One string in a message. Well past any limit of the model, and it fits in a few MB of targets. */
    static final int MAX_STRING_CHARS = 4096;
    /** One message, once its strings are cut. A target list or a tab's history fits many times over. */
    static final int MAX_MESSAGE_CHARS = 2 * 1024 * 1024;
    /**
     * One string in the reply to {@link #callLong}, such as an image's bytes in base64. The message as a whole still
     * keeps to {@link #MAX_MESSAGE_CHARS}.
     */
    static final int LONG_STRING_CHARS = 1_000_000;
    /** Calls out at once. Sessions' own limits are lower, so only a stuck Chromium gets here. */
    static final int MAX_IN_FLIGHT = 256;

    private static final Pattern BROWSER_PATH = Pattern.compile("/devtools/browser/[A-Za-z0-9-]{1,64}");
    private static final Duration STABLE = Duration.ofSeconds(5);
    /**
     * How long after a start of Chromium attempts stay at the smallest gap. systemctl says the unit has
     * started as soon as the process has, and it listens some seconds later, or tens of them on a desk
     * whose disk is still loading.
     */
    private static final Duration COMING_UP = Duration.ofSeconds(30);

    /**
     * @param http one request to /json, whole, and what a read of the tabs waits for its {@link CdpClient#ask}
     * @param open the WebSocket handshake
     * @param minBackoff and the smallest gap between two attempts, however a call hurries them
     * @param wantCheck how often an open connection asks whether it's still wanted, and if so makes
     *     sure Chromium is still there
     * @param probe how long Chromium gets to answer that
     */
    record Timing(Duration http, Duration open, Duration minBackoff, Duration maxBackoff, Duration wantCheck, Duration probe) {
        static final Timing DEFAULT = new Timing(
                Duration.ofSeconds(2), Duration.ofSeconds(3), Duration.ofMillis(250), Duration.ofSeconds(5), Duration.ofSeconds(5), Duration.ofSeconds(5));
    }

    /** What the connection's owner hears. */
    interface Events {
        /** One event, in order. Runs on the read path, so it must not block or make a call. */
        void onEvent(String method, String sessionId, Map<String, Object> params);

        /**
         * A connection is open. Runs on the connector thread and may make calls.
         *
         * @throws CdpException to give up on this connection and try again
         */
        void onConnected() throws CdpException, InterruptedException;

        /**
         * The connection that {@link #onConnected} heard about is gone.
         *
         * @param unexpected false if deskd closed it because nothing wants it now
         */
        void onDisconnected(boolean unexpected);

        /** An attempt to connect failed. */
        void onAttemptFailed();

        /**
         * Chromium is up where deskd won't go ({@link CdpListener.Kind#DISPLACED}), as of a look at the port, which can be
         * on any thread and comes again with each look. Must not block.
         */
        void onDisplaced();
    }

    /** Whoever is on the port isn't to be trusted. Not an error of the port's, so it has its own log line. */
    private static final class ListenerRefused extends IOException {
        private static final long serialVersionUID = 1L;

        ListenerRefused() {
            super("not the expected listener", null);
        }
    }

    private final PlatformHttp http;
    private final int port;
    private final Supplier<CdpListener.Verdict> listener;
    private final Events events;
    private final BooleanSupplier wanted;
    private final Timing timing;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition changed = lock.newCondition();
    private final AtomicLong nextId = new AtomicLong();
    private volatile Connection current;
    private volatile long hurryUntilNanos = System.nanoTime() - 1;
    /** The last look at the port found someone who isn't to be trusted, or Chromium off the port, or couldn't tell. */
    private volatile CdpListener.Verdict refusal;
    private Thread connector;
    private boolean wakePending;
    private boolean closed;
    private boolean loggedDown;
    /** What's been logged since the last listener that was trusted, which is what says when to log again. */
    private CdpListener.Verdict loggedRefusal;

    CdpClient(PlatformHttp http, int port, Supplier<CdpListener.Verdict> listener, Events events, BooleanSupplier wanted, Timing timing) {
        this.http = http;
        this.port = port;
        this.listener = listener;
        this.events = events;
        this.wanted = wanted;
        this.timing = timing;
    }

    /** Something may want the connection now. Starts the connector, or hurries it. Never blocks. */
    void wake() {
        lock.lock();
        try {
            if (closed) {
                return;
            }
            wakePending = true;
            changed.signalAll();
            if (connector == null) {
                connector = Thread.ofVirtual().name("cdp-connector").start(this::connectLoop);
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * Chromium is being started, so it's about to answer. Backing off from the attempts it refused while it
     * was down would make a client wait up to {@code maxBackoff} for a browser that's already there, so for
     * the next while attempts keep to the smallest gap. Until something listens, each is one read of a table.
     */
    void hurry() {
        hurryUntilNanos = System.nanoTime() + COMING_UP.toNanos();
        wake();
    }

    boolean isConnected() {
        Connection connection = current;
        return connection != null && connection.alive.get();
    }

    /** For /health: why the last look at the port refused it, or null if it didn't. */
    CdpListener.Verdict refusal() {
        return refusal;
    }

    /**
     * Parks until the connector thread, and so any connection, is gone, as it goes once nothing wants it and it's woken.
     *
     * @return true if it went within the wait
     */
    boolean awaitIdle(Duration wait) throws InterruptedException {
        long remaining = wait.toNanos();
        lock.lockInterruptibly();
        try {
            while (connector != null && remaining > 0) {
                remaining = changed.awaitNanos(remaining);
            }
            return connector == null;
        } finally {
            lock.unlock();
        }
    }

    /** True while the connector thread exists. */
    boolean isRunning() {
        lock.lock();
        try {
            return connector != null;
        } finally {
            lock.unlock();
        }
    }

    /**
     * One command, parked on until its reply.
     *
     * @param sessionId a page's session, or null for the browser itself
     * @throws CdpException if there's no result, for any reason
     */
    Map<String, Object> call(String sessionId, String method, Map<String, Object> params, Duration timeout)
            throws CdpException, InterruptedException {
        Connection connection = current;
        if (connection == null || !connection.alive.get()) {
            throw CdpException.disconnected();
        }
        return connection.call(sessionId, method, params, timeout);
    }

    /**
     * {@link #call}, for a reply with a long string in it: its strings are kept to {@link #LONG_STRING_CHARS}. Chromium
     * writes a reply's id first, so the reader knows the reply by it before any string. A reply cut all the same, as one
     * whose first piece is too short to show its id, fails rather than come back short.
     */
    Map<String, Object> callLong(String sessionId, String method, Map<String, Object> params, Duration timeout)
            throws CdpException, InterruptedException {
        Connection connection = current;
        if (connection == null || !connection.alive.get()) {
            throw CdpException.disconnected();
        }
        return connection.call(sessionId, method, params, timeout, result -> {}, true);
    }

    /**
     * {@link #call} for the browser itself, when what the reply says has to take effect in its place among the events.
     * An event right after it can say the opposite, and the thread parked here can wake up after that event has been
     * dealt with, and undo it.
     *
     * @param onReply runs on the read path, before this returns. Like {@link Events#onEvent}, it must not block or make
     *     a call
     */
    Map<String, Object> call(String method, Map<String, Object> params, Duration timeout, Consumer<Map<String, Object>> onReply)
            throws CdpException, InterruptedException {
        Connection connection = current;
        if (connection == null || !connection.alive.get()) {
            throw CdpException.disconnected();
        }
        return connection.call(null, method, params, timeout, onReply);
    }

    /**
     * A command for the browser itself, sent now, that a caller can do without. No reply in time says nothing about
     * the connection, as it would for {@link #call}: {@code onReply} just never runs, and the probe is what says
     * Chromium has gone.
     *
     * @param onReply runs on the read path, in the order Chromium sent things, so a reply can't land on an event that
     *     came after it. Like {@link Events#onEvent}, it must not block or make a call
     * @return done once {@code onReply} has run, or failed if there's no reply for it. A caller that's done waiting
     *     cancels this, and a reply after that is dropped
     */
    CompletableFuture<Void> ask(String method, Map<String, Object> params, Consumer<Map<String, Object>> onReply) {
        Connection connection = current;
        if (connection == null || !connection.alive.get()) {
            return CompletableFuture.failedFuture(CdpException.disconnected());
        }
        return connection.ask(method, params, onReply);
    }

    /**
     * The ids of the pages in /json/list, most recently shown or made first. So a tab opened in the background comes
     * first while it's hidden: the order alone doesn't say which tab is on screen.
     */
    List<String> pageOrder() throws IOException, InterruptedException {
        Map<String, Object> list;
        try {
            list = Json.parseObject(("{\"list\":" + get("/json/list") + "}").getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            throw new IOException("unreadable target list");
        }
        List<String> order = new ArrayList<>();
        if (list.get("list") instanceof List<?> entries) {
            for (Object entry : entries) {
                if (entry instanceof Map<?, ?> map && "page".equals(map.get("type")) && map.get("id") instanceof String id) {
                    order.add(id);
                }
            }
        }
        return order;
    }

    @Override
    public void close() {
        Connection connection;
        Thread running;
        lock.lock();
        try {
            closed = true;
            connection = current;
            running = connector;
            changed.signalAll();
        } finally {
            lock.unlock();
        }
        if (connection != null) {
            connection.die(false);
        }
        if (running != null) {
            running.interrupt();
        }
    }

    private void connectLoop() {
        long backoff = timing.minBackoff().toNanos();
        try {
            while (true) {
                boolean want = wanted.getAsBoolean();
                lock.lock();
                try {
                    if (closed || (!want && !wakePending)) {
                        connector = null;
                        changed.signalAll();
                        return;
                    }
                    wakePending = false;
                } finally {
                    lock.unlock();
                }
                if (!want) {
                    continue;
                }
                Connection connection = attempt();
                if (connection != null) {
                    long opened = System.nanoTime();
                    boolean lost = run(connection);
                    if (!lost) {
                        continue;
                    }
                    if (System.nanoTime() - opened >= STABLE.toNanos()) {
                        backoff = timing.minBackoff().toNanos();
                    }
                }
                pause(backoff);
                backoff = System.nanoTime() - hurryUntilNanos < 0
                        ? timing.minBackoff().toNanos()
                        : Math.min(backoff * 2, timing.maxBackoff().toNanos());
            }
        } catch (InterruptedException e) {
            lock.lock();
            try {
                connector = null;
                changed.signalAll();
            } finally {
                lock.unlock();
            }
        }
    }

    /** Waits out the backoff. A wake cuts it short, but never below the smallest gap. */
    private void pause(long backoff) throws InterruptedException {
        long start = System.nanoTime();
        long deadline = start + backoff;
        long earliest = start + timing.minBackoff().toNanos();
        lock.lock();
        try {
            while (!closed) {
                long now = System.nanoTime();
                if (now >= deadline || (wakePending && now >= earliest)) {
                    return;
                }
                changed.awaitNanos(wakePending ? earliest - now : deadline - now);
            }
        } finally {
            lock.unlock();
        }
    }

    private Connection attempt() throws InterruptedException {
        try {
            Connection connection = open();
            logUp();
            return connection;
        } catch (ListenerRefused e) {
            events.onAttemptFailed();
            return null;
        } catch (IOException | RuntimeException e) {
            logDown(e);
            events.onAttemptFailed();
            return null;
        }
    }

    private void logDown(Exception e) {
        lock.lock();
        try {
            if (loggedDown) {
                return;
            }
            loggedDown = true;
        } finally {
            lock.unlock();
        }
        log.info("chromium not reachable, retrying while something wants it: {}", e.getClass().getSimpleName());
    }

    private void logUp() {
        lock.lock();
        try {
            loggedDown = false;
        } finally {
            lock.unlock();
        }
        log.info("chromium connected");
    }

    private Connection open() throws IOException, InterruptedException {
        URI endpoint = browserEndpoint(get("/json/version"));
        Connection connection = new Connection();
        CompletableFuture<WebSocket> opening =
                http.client().newWebSocketBuilder().connectTimeout(timing.open()).buildAsync(endpoint, connection);
        try {
            connection.socket = opening.get(timing.open().toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException e) {
            opening.cancel(true);
            opening.whenComplete((socket, error) -> {
                if (socket != null) {
                    socket.abort();
                }
            });
            throw new IOException("no handshake in time");
        } catch (ExecutionException e) {
            throw new IOException("handshake failed");
        }
        try {
            requireListener();
        } catch (IOException e) {
            connection.die(false);
            throw e;
        }
        lock.lock();
        try {
            if (closed) {
                connection.socket.abort();
                throw new IOException("closed");
            }
            current = connection;
        } finally {
            lock.unlock();
        }
        return connection;
    }

    /** Only the path comes from Chromium's answer. */
    private URI browserEndpoint(String version) throws IOException {
        try {
            Map<String, Object> fields = Json.parseObject(version.getBytes(StandardCharsets.UTF_8));
            String advertised = Json.string(fields, "webSocketDebuggerUrl");
            String path = advertised == null ? null : new URI(advertised).getRawPath();
            if (path == null || !BROWSER_PATH.matcher(path).matches()) {
                throw new IOException("no browser endpoint");
            }
            return new URI("ws://127.0.0.1:" + port + path);
        } catch (JsonFormatException | URISyntaxException e) {
            throw new IOException("unreadable browser endpoint");
        }
    }

    /** @return true if the connection went by itself, false if deskd closed it */
    private boolean run(Connection connection) throws InterruptedException {
        connection.announced = true;
        try {
            events.onConnected();
        } catch (CdpException e) {
            log.info("chromium connection given up: {}", e.kind());
            connection.die(true);
            return true;
        } catch (RuntimeException e) {
            log.error("chromium connection given up: {}", e.getClass().getName());
            connection.die(true);
            return true;
        }
        long lastProbe = System.nanoTime();
        while (awaitChange(connection) && wanted.getAsBoolean()) {
            if (System.nanoTime() - lastProbe >= timing.wantCheck().toNanos()) {
                lastProbe = System.nanoTime();
                probe(connection);
            }
        }
        boolean lost = !connection.alive.get();
        connection.die(false);
        return lost;
    }

    /** @return false once the connection has gone or this client has closed */
    private boolean awaitChange(Connection connection) throws InterruptedException {
        lock.lock();
        try {
            if (connection.alive.get() && !closed) {
                changed.await(timing.wantCheck().toNanos(), TimeUnit.NANOSECONDS);
            }
            return connection.alive.get() && !closed;
        } finally {
            lock.unlock();
        }
    }

    /** No reply to a command for the browser itself drops the connection, which is all this is for. */
    private void probe(Connection connection) throws InterruptedException {
        try {
            connection.call(null, "Browser.getVersion", Map.of(), timing.probe());
        } catch (CdpException e) {
            log.debug("chromium didn't answer a probe: {}", e.kind());
        }
    }

    /** @throws IOException if there's nobody to connect to, or nobody who should be connected to */
    private void requireListener() throws IOException {
        CdpListener.Verdict verdict = listener.get();
        switch (verdict.kind()) {
            case TRUSTED -> {
                refusal = null;
                forgetLoggedRefusal();
            }
            case NONE -> {
                refusal = null;
                throw new IOException("nothing is listening");
            }
            case DISPLACED -> {
                refusal = verdict;
                logRefusal(verdict);
                events.onDisplaced();
                throw new ListenerRefused();
            }
            default -> {
                refusal = verdict;
                logRefusal(verdict);
                throw new ListenerRefused();
            }
        }
    }

    /** One line for each listener that's refused: retrying says nothing new, and it may be someone's way in. */
    private void logRefusal(CdpListener.Verdict verdict) {
        lock.lock();
        try {
            if (verdict.equals(loggedRefusal)) {
                return;
            }
            loggedRefusal = verdict;
        } finally {
            lock.unlock();
        }
        if (verdict.kind() == CdpListener.Kind.FOREIGN) {
            log.warn("refusing chromium's debugging port: listener has uid {}", verdict.uid());
        } else if (verdict.kind() == CdpListener.Kind.DISPLACED) {
            log.warn("chromium's debugging port is on ::1, as 127.0.0.1 was taken when it started: restarting it");
        } else {
            log.warn("refusing chromium's debugging port: can't read who holds it");
        }
    }

    private void forgetLoggedRefusal() {
        lock.lock();
        try {
            loggedRefusal = null;
        } finally {
            lock.unlock();
        }
    }

    private String get(String path) throws IOException, InterruptedException {
        requireListener();
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).GET().build();
        HttpResponse<String> response = http.send(request, info -> new BoundedBody(), timing.http());
        if (response.statusCode() != 200) {
            throw new IOException("status " + response.statusCode());
        }
        return response.body();
    }

    /**
     * A response body through {@link BoundedJsonText}, byte by byte, so a cut can fall inside a UTF-8
     * sequence: that decodes to U+FFFD. Goes over the limit and the request fails.
     */
    private static final class BoundedBody implements HttpResponse.BodySubscriber<String> {
        private final BoundedJsonText text = new BoundedJsonText(MAX_STRING_CHARS, MAX_MESSAGE_CHARS);
        private final CompletableFuture<String> result = new CompletableFuture<>();
        private Flow.Subscription subscription;

        @Override
        public CompletionStage<String> getBody() {
            return result;
        }

        @Override
        public void onSubscribe(Flow.Subscription newSubscription) {
            subscription = newSubscription;
            subscription.request(1);
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                while (buffer.hasRemaining()) {
                    text.append((char) (buffer.get() & 0xFF));
                }
            }
            if (text.overflowed()) {
                subscription.cancel();
                result.completeExceptionally(new IOException("body over the limit"));
                return;
            }
            subscription.request(1);
        }

        @Override
        public void onError(Throwable error) {
            result.completeExceptionally(error);
        }

        @Override
        public void onComplete() {
            result.complete(new String(text.text().getBytes(StandardCharsets.ISO_8859_1), StandardCharsets.UTF_8));
        }
    }

    private final class Connection implements WebSocket.Listener {
        final AtomicBoolean alive = new AtomicBoolean(true);
        final Map<Long, CompletableFuture<Map<String, Object>>> pending = new ConcurrentHashMap<>();
        /** Ids of calls whose replies may hold a long string. */
        final java.util.Set<Long> longReplies = ConcurrentHashMap.newKeySet();
        final ReentrantLock sendLock = new ReentrantLock();
        final ArrayDeque<String> outbound = new ArrayDeque<>();
        volatile WebSocket socket;
        volatile boolean announced;
        private boolean sending;
        private BoundedJsonText reading;
        private long readingLong = -1;
        private long readingId = -1;

        Map<String, Object> call(String sessionId, String method, Map<String, Object> params, Duration timeout)
                throws CdpException, InterruptedException {
            return call(sessionId, method, params, timeout, result -> {});
        }

        Map<String, Object> call(
                String sessionId, String method, Map<String, Object> params, Duration timeout, Consumer<Map<String, Object>> onReply)
                throws CdpException, InterruptedException {
            return call(sessionId, method, params, timeout, onReply, false);
        }

        Map<String, Object> call(
                String sessionId,
                String method,
                Map<String, Object> params,
                Duration timeout,
                Consumer<Map<String, Object>> onReply,
                boolean longReply)
                throws CdpException, InterruptedException {
            if (pending.size() >= MAX_IN_FLIGHT) {
                throw CdpException.notSent();
            }
            long id = nextId.incrementAndGet();
            if (longReply) {
                longReplies.add(id);
            }
            CompletableFuture<Map<String, Object>> reply = new CompletableFuture<>();
            // Hooked up before it's sent, so this can only run where the reply is settled: on the read path.
            CompletableFuture<Map<String, Object>> taken = reply.thenApply(result -> {
                onReply.accept(result);
                return result;
            });
            pending.put(id, reply);
            try {
                send(command(id, sessionId, method, params));
                // Whatever fails replies does so after alive turns false, so one of the two sees this.
                if (!alive.get()) {
                    throw CdpException.disconnected();
                }
                return taken.get(timeout.toNanos(), TimeUnit.NANOSECONDS);
            } catch (TimeoutException e) {
                // A page can be hung while the browser is fine. The browser itself not answering isn't.
                if (sessionId == null) {
                    log.warn("chromium isn't answering {}: dropping the connection", method);
                    die(true);
                }
                throw CdpException.timeout();
            } catch (ExecutionException e) {
                throw e.getCause() instanceof CdpException cause ? cause : CdpException.disconnected();
            } finally {
                pending.remove(id);
                longReplies.remove(id);
            }
        }

        CompletableFuture<Void> ask(String method, Map<String, Object> params, Consumer<Map<String, Object>> onReply) {
            if (pending.size() >= MAX_IN_FLIGHT) {
                return CompletableFuture.failedFuture(CdpException.timeout());
            }
            long id = nextId.incrementAndGet();
            CompletableFuture<Map<String, Object>> reply = new CompletableFuture<>();
            // Hooked up before it's sent, so this can only run where the reply is settled: on the read path.
            CompletableFuture<Void> handled = reply.thenAccept(onReply);
            handled.whenComplete((done, error) -> pending.remove(id));
            pending.put(id, reply);
            send(command(id, null, method, params));
            // Whatever fails replies does so after alive turns false, so one of the two sees this.
            if (!alive.get()) {
                reply.completeExceptionally(CdpException.disconnected());
            }
            return handled;
        }

        private static String command(long id, String sessionId, String method, Map<String, Object> params) {
            Map<String, Object> command = new LinkedHashMap<>();
            command.put("id", id);
            command.put("method", method);
            command.put("params", params);
            if (sessionId != null) {
                command.put("sessionId", sessionId);
            }
            return new String(Json.bytes(command), StandardCharsets.UTF_8);
        }

        /** The JDK's client allows one send at a time, so each one starts the next. */
        private void send(String text) {
            sendLock.lock();
            try {
                if (!alive.get()) {
                    return;
                }
                outbound.addLast(text);
                if (!sending) {
                    sending = true;
                    sendNext();
                }
            } finally {
                sendLock.unlock();
            }
        }

        private void sendNext() {
            String next = outbound.pollFirst();
            if (next == null) {
                sending = false;
                return;
            }
            try {
                socket.sendText(next, true).whenComplete((sent, error) -> {
                    if (error != null) {
                        die(true);
                        return;
                    }
                    sendLock.lock();
                    try {
                        sendNext();
                    } finally {
                        sendLock.unlock();
                    }
                });
            } catch (RuntimeException e) {
                sending = false;
                Thread.ofVirtual().name("cdp-send-failed").start(() -> die(true));
            }
        }

        void die(boolean unexpected) {
            if (!alive.compareAndSet(true, false)) {
                return;
            }
            WebSocket open = socket;
            if (open != null) {
                open.abort();
            }
            sendLock.lock();
            try {
                outbound.clear();
            } finally {
                sendLock.unlock();
            }
            pending.values().forEach(reply -> reply.completeExceptionally(CdpException.disconnected()));
            lock.lock();
            try {
                if (current == this) {
                    current = null;
                }
                changed.signalAll();
            } finally {
                lock.unlock();
            }
            if (announced) {
                events.onDisconnected(unexpected);
            }
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            try {
                if (reading == null) {
                    readingId = replyId(data);
                    readingLong = readingId >= 0 && longReplies.contains(readingId) ? readingId : -1;
                    reading = new BoundedJsonText(readingLong >= 0 ? LONG_STRING_CHARS : MAX_STRING_CHARS, MAX_MESSAGE_CHARS);
                }
                reading.append(data);
                if (last) {
                    BoundedJsonText message = reading;
                    reading = null;
                    long cutLong = readingLong >= 0 ? readingLong : message.cut() ? longReplyIn(message.text()) : -1;
                    if (cutLong >= 0 && message.cut()) {
                        // A long call's reply cut all the same, its first piece read with the short limit included
                        // (review 9): it fails rather than come back short.
                        failReply(cutLong);
                    } else if (!message.overflowed()) {
                        dispatch(message.text());
                    } else {
                        log.debug("message from chromium over the limit, dropped");
                        // A reply too large to read fails its call now, as too large, rather than leave it to time out.
                        failReply(readingId);
                    }
                }
            } catch (RuntimeException e) {
                // The class alone: exception text can quote what Chromium sent.
                log.error("message from chromium failed: {}", e.getClass().getName());
            }
            webSocket.request(1);
            return null;
        }

        /**
         * @return the id of the long call this whole message replies to, for one whose first piece was too short to
         *     show it, or -1
         */
        private long longReplyIn(String text) {
            long id = replyId(text);
            return id >= 0 && longReplies.contains(id) ? id : -1;
        }

        /** @return the id of the reply this message starts, as Chromium writes a reply's id first, or -1 */
        private long replyId(CharSequence first) {
            String prefix = "{\"id\":";
            int length = first.length();
            if (length <= prefix.length() || !first.subSequence(0, prefix.length()).toString().equals(prefix)) {
                return -1;
            }
            long id = 0;
            int i = prefix.length();
            for (; i < length && i < prefix.length() + 18 && Character.isDigit(first.charAt(i)); i++) {
                id = id * 10 + (first.charAt(i) - '0');
            }
            return i > prefix.length() && i < length && first.charAt(i) == ',' ? id : -1;
        }

        /** The call this reply was for fails as too large: what it said was cut or dropped. */
        private void failReply(long id) {
            CompletableFuture<Map<String, Object>> reply = id < 0 ? null : pending.remove(id);
            if (reply != null) {
                reply.completeExceptionally(CdpException.remote(CdpException.TOO_LARGE));
            }
        }

        private void dispatch(String text) {
            // Until it's announced this connection has passed no second look at who's on the port, and Chromium
            // has been asked nothing, so there's nothing to hear.
            if (!alive.get() || !announced) {
                return;
            }
            Map<String, Object> message;
            try {
                message = Json.parseObject(text.getBytes(StandardCharsets.UTF_8));
            } catch (JsonFormatException e) {
                log.debug("unreadable message from chromium, dropped");
                return;
            }
            if (message.get("id") instanceof Number id) {
                settle(id.longValue(), message);
                return;
            }
            String method = Json.string(message, "method");
            if (method != null) {
                Map<String, Object> params = Json.object(message, "params");
                events.onEvent(method, Json.string(message, "sessionId"), params == null ? Map.of() : params);
            }
        }

        private void settle(long id, Map<String, Object> message) {
            CompletableFuture<Map<String, Object>> reply = pending.remove(id);
            if (reply == null) {
                return;
            }
            Map<String, Object> error = Json.object(message, "error");
            if (error != null) {
                reply.completeExceptionally(CdpException.remote(error.get("code") instanceof Number code ? code.intValue() : 0));
                return;
            }
            Map<String, Object> result = Json.object(message, "result");
            reply.complete(result == null ? Map.of() : result);
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            die(true);
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            die(true);
        }
    }
}
