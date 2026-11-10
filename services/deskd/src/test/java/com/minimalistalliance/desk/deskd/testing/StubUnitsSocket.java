package com.minimalistalliance.desk.deskd.testing;

import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * Stands in for desk-units on a real Unix socket: one request per connection, and the reply when the
 * "job" is done. It keeps what each unit would be doing, so a test can read off where the desk ended
 * up, and it can hold a request open, as a slow systemctl does.
 *
 * <p><b>Freeze and thaw</b> (ADR 0045) as the image's desk-units does them on systemd 257, which never thaws a unit for a
 * job: {@code freeze} of a unit that isn't running answers {@code err inactive}, {@code thaw} of one that isn't frozen
 * answers ok, a {@code stop} of a frozen unit is refused ({@code JOB_FROZEN}) and changes nothing, and a {@code start} of a
 * running frozen unit answers ok and leaves it frozen. A reply set with {@link #reply} still wins, and then nothing changes.
 */
public final class StubUnitsSocket implements AutoCloseable {

    private final Path socket;
    private final ServerSocketChannel server;
    private final List<String> requests = new CopyOnWriteArrayList<>();
    private final Map<String, String> replies = new ConcurrentHashMap<>();
    private final Map<String, CountDownLatch> gates = new ConcurrentHashMap<>();
    private final Map<String, Boolean> running = new ConcurrentHashMap<>();
    private final Map<String, Boolean> frozen = new ConcurrentHashMap<>();
    private final Map<String, CountDownLatch> arrivals = new ConcurrentHashMap<>();
    private volatile Consumer<String> onRequest = request -> {};
    private volatile boolean closed;

    public StubUnitsSocket(Path socket) throws IOException {
        this.socket = socket;
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(socket));
        Thread.ofVirtual().name("stub-units").start(this::acceptLoop);
    }

    /** Every request so far, in the order they came: "start desk-stream". */
    public List<String> requests() {
        return List.copyOf(requests);
    }

    public void clearRequests() {
        requests.clear();
    }

    /** Whether the stub's idea of this unit is running, after all the jobs that have finished. */
    public boolean isRunning(String unit) {
        return running.getOrDefault(unit, false);
    }

    /** Whether the stub's idea of this unit is frozen, after all the jobs that have finished. */
    public boolean isFrozen(String unit) {
        return frozen.getOrDefault(unit, false);
    }

    /**
     * deskd thaws Chromium once as it starts (ADR 0045). Waits for that request to arrive and drops it from {@link
     * #requests}, so a test reads only what came after. It doesn't wait for the reply.
     */
    public void forgetStartupThaw() throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!requests.remove("thaw desk-browser")) {
            if (System.nanoTime() > deadline) {
                throw new IllegalStateException("no thaw as deskd started: " + requests);
            }
            Thread.sleep(5);
        }
    }

    /** As if a deskd before this one had left the unit running and frozen. */
    public void leaveFrozen(String unit) {
        running.put(unit, true);
        frozen.put(unit, true);
    }

    /** From now on, this request gets this reply line instead of ok. */
    public void reply(String request, String line) {
        replies.put(request, line);
    }

    public void replyOk(String request) {
        replies.remove(request);
    }

    /** The next requests like this one wait, past their arrival, until {@link #release}. */
    public void hold(String request) {
        gates.put(request, new CountDownLatch(1));
        arrivals.put(request, new CountDownLatch(1));
    }

    public void release(String request) {
        CountDownLatch gate = gates.remove(request);
        if (gate != null) {
            gate.countDown();
        }
    }

    /** Waits for a request that {@link #hold} is holding to have arrived. */
    public void awaitHeld(String request) throws InterruptedException {
        if (!arrivals.get(request).await(10, TimeUnit.SECONDS)) {
            throw new IllegalStateException("nothing arrived: " + request + " after " + requests);
        }
    }

    /** Runs as each request arrives, before its reply. */
    public void onRequest(Consumer<String> action) {
        onRequest = action;
    }

    @Override
    public void close() throws IOException {
        closed = true;
        gates.values().forEach(CountDownLatch::countDown);
        server.close();
        Files.deleteIfExists(socket);
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                SocketChannel client = server.accept();
                Thread.ofVirtual().name("stub-units-request").start(() -> serve(client));
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(SocketChannel client) {
        try (client) {
            ByteBuffer in = ByteBuffer.allocate(128);
            String request = null;
            while (request == null && client.read(in) >= 0) {
                String sofar = new String(in.array(), 0, in.position(), StandardCharsets.US_ASCII);
                if (sofar.endsWith("\n")) {
                    request = sofar.substring(0, sofar.length() - 1);
                }
            }
            if (request == null) {
                return;
            }
            requests.add(request);
            onRequest.accept(request);
            CountDownLatch arrival = arrivals.get(request);
            if (arrival != null) {
                arrival.countDown();
            }
            CountDownLatch gate = gates.get(request);
            if (gate != null) {
                gate.await();
            }
            String reply = replies.getOrDefault(request, "ok");
            String[] parts = request.split(" ");
            if (!replies.containsKey(request)) {
                if (parts[0].equals("freeze") && !isRunning(parts[1])) {
                    reply = "err inactive " + parts[1] + " isn't running";
                } else if (isFrozen(parts[1]) && (parts[0].equals("stop") || parts[0].equals("start") && !isRunning(parts[1]))) {
                    reply = "err failed " + request + ": Job for " + parts[1] + ".service failed because the unit is frozen";
                }
            }
            if (reply.equals("ok")) {
                switch (parts[0]) {
                    case "freeze" -> frozen.put(parts[1], true);
                    case "thaw" -> frozen.remove(parts[1]);
                    // A start of a running frozen unit is ok, and it stays frozen.
                    default -> running.put(parts[1], parts[0].equals("start"));
                }
            }
            client.write(ByteBuffer.wrap((reply + "\n").getBytes(StandardCharsets.US_ASCII)));
        } catch (IOException e) {
            // deskd went away, as it may.
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
