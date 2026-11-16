package com.minimalistalliance.desk.agent.attach;

import com.minimalistalliance.desk.agent.attach.worker.ParseRequest;
import com.minimalistalliance.desk.agent.attach.worker.ParseWorker;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Reads a file to text in a process of its own (ADR 0049, and ADR 0097 for the sidecar), one at a time, with a
 * deadline and a bound on the answer. Which process is ADR 0097's marker rule:
 * <ul>
 * <li><b>The parse sidecar,</b> once desk-agent has seen the marker ({@code <dir>/required}) or the socket
 * ({@code <dir>/sock/parse.sock}), {@code dir} being {@value #DEFAULT_DIR} ({@code desk.agent.parse.dir}). desk-agent
 * connects, writes the {@link ParseRequest} line and the file's bytes, half-closes, and reads the answer. The sandbox
 * (uid 1113, no network, no {@code /data}, no capabilities) runs one worker JVM per connection.</li>
 * <li><b>The in-container child,</b> only while neither has ever been seen: an image from before the sidecar, where
 * desk-agent's {@code run} mounts nothing at {@code /run/desk-parse}. It goes with the move to JDK 24, which drops the
 * security manager it relies on.</li>
 * <li><b>Fails closed:</b> once either has been seen, no child starts for the rest of this process's life, and the
 * sidecar's failures are ADR 0097's table: {@code err busy} waits and tries again within the 15 s busy window, then
 * {@code busy}; no socket, a refused connection, {@code err denied} or any first line that isn't {@code OK} or
 * {@code ERR <word>} is {@code unavailable}; a stream that ends before a line is {@code too_complex}; the deadline is
 * {@code timeout}.</li>
 * </ul>
 * The way is logged once at start and when the marker is first seen, then counts at most hourly; never a file's name
 * or content.
 *
 * <p>What the child isolates, exactly:
 * <ul>
 * <li><b>Memory and time:</b> a 72 MiB heap that exits when it fills, a deadline, one child at a time. A zip bomb or a
 * huge PDF ends that process and not desk-agent.</li>
 * <li><b>Secrets in memory:</b> the child has an empty environment and shares nothing with desk-agent's heap, where the
 * provider keys are.</li>
 * <li><b>A Java security manager inside the child</b> ({@code worker/Sandbox}, AGENT-PARSE-1): it may read its own jars
 * and the JDK, and nothing else. It cannot write a file, open a socket, start a process, load native code or replace
 * the manager. Its working directory is a new empty directory removed afterwards.</li>
 * </ul>
 * What it does not do: the child has desk-agent's user id, mounts and network namespace, so it is not a kernel
 * sandbox. A bug in the JVM itself, or native code reached some other way, is outside the security manager. The
 * sidecar is the container-level close of that (ISS20-P1), with the same manager inside it while on JDK 21.
 */
public final class Parsers implements AutoCloseable {

    /** A file read to text, with {@code cut} when the character cap stopped it. */
    public record Text(String text, boolean cut) {}

    /** Parses so far by way and outcome, for the log line and tests. */
    public record Counts(long sidecar, long sidecarFailed, long child, long childFailed) {}

    private static final Logger log = LoggerFactory.getLogger(Parsers.class);
    /** The sidecar's directory on a desk: the marker, and the socket in {@code sock/} (ADR 0097 section 2). */
    public static final String DEFAULT_DIR = "/run/desk-parse";
    /** How long a parse waits for the one slot, and for the sidecar to stop answering {@code err busy}. */
    static final long BUSY_WINDOW_MS = 15_000;
    /**
     * Between tries after {@code err busy}. Short, because the commonest busy is the last file's worker not yet reaped:
     * its socket closes as it exits, a moment before the sandbox's {@code desk-svc} can count it gone.
     */
    static final long BUSY_RETRY_MS = 50;
    /**
     * When the sidecar's {@code desk-svc} kills a worker ({@code -deadline-sec} in the image's {@code desk-parse-run}), and
     * how long desk-agent waits for an answer from the sidecar: past that kill and its clean-up, so a connection always ends
     * by desk-svc's own close and a worker that took itself over can't be on the socket for the next file (Security CP-I1,
     * the same order as deskd's CP-L1). The in-container child is killed by desk-agent itself, at {@code timeoutSeconds}.
     */
    static final long DESK_SVC_KILL_SECONDS = 35;
    static final long SIDECAR_WAIT_SECONDS = DESK_SVC_KILL_SECONDS + 5;
    /** At most one line of counts an hour. */
    private static final long COUNTS_EVERY_NANOS = TimeUnit.HOURS.toNanos(1);
    /** An {@code ERR} line's reason: a word, as the worker writes them. */
    private static final Pattern REASON = Pattern.compile("[a-z_]{1,32}");

    /** Only for a developer chasing a parser bug: lets the child's stack traces through. Never set on a desk. */
    private static final boolean DEBUG = Boolean.getBoolean("ma.attach.debug");
    static final String WORKER = "com.minimalistalliance.desk.agent.attach.worker.ParseWorker";

    private final long timeoutSeconds;
    private final long sidecarSeconds;
    private final long busyWindowMs;
    private final Path marker;
    private final Path socket;
    /** ADR 0097's latch: set once the marker or the socket has been seen, and never cleared. */
    private final AtomicBoolean sidecarSeen = new AtomicBoolean();
    /** One parse at a time: a second JVM beside desk-agent's would take the container past its limit (ADR 0049). */
    private final Semaphore slots = new Semaphore(1);
    private final ExecutorService readers = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "attach-parse-reader");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicLong sidecar = new AtomicLong();
    private final AtomicLong sidecarFailed = new AtomicLong();
    private final AtomicLong child = new AtomicLong();
    private final AtomicLong childFailed = new AtomicLong();
    private volatile long countsLoggedAt = System.nanoTime();
    private volatile long countsLogged;

    /** With the desk's own directory. */
    public Parsers(long timeoutSeconds) {
        this(timeoutSeconds, Path.of(DEFAULT_DIR));
    }

    /** With the sidecar's directory at {@code dir}: its {@code required} marker and its {@code sock/parse.sock}. */
    public Parsers(long timeoutSeconds, Path dir) {
        this(timeoutSeconds, dir, BUSY_WINDOW_MS);
    }

    /** With a shorter busy window, for tests. */
    Parsers(long timeoutSeconds, Path dir, long busyWindowMs) {
        this(timeoutSeconds, dir, busyWindowMs, Math.max(timeoutSeconds, SIDECAR_WAIT_SECONDS));
    }

    /** With the sidecar's wait given, for tests. */
    Parsers(long timeoutSeconds, Path dir, long busyWindowMs, long sidecarSeconds) {
        this.timeoutSeconds = timeoutSeconds;
        this.sidecarSeconds = sidecarSeconds;
        this.busyWindowMs = busyWindowMs;
        Path absolute = dir.toAbsolutePath();
        this.marker = absolute.resolve("required");
        this.socket = absolute.resolve("sock").resolve("parse.sock");
        if (sidecar()) {
            log.info("attached files are read by the parse sidecar (ADR 0097)");
        } else {
            log.info("attached files are read by an in-container child: this image has no parse sidecar");
        }
    }

    /**
     * Whether files go to the sidecar: true from the first time the marker or the socket is there, for the rest of this
     * process's life. Nothing is followed: a link at either path counts as being there.
     */
    public boolean sidecar() {
        if (sidecarSeen.get()) {
            return true;
        }
        if (Files.exists(marker, LinkOption.NOFOLLOW_LINKS) || Files.exists(socket, LinkOption.NOFOLLOW_LINKS)) {
            if (!sidecarSeen.getAndSet(true)) {
                log.info("the parse sidecar's marker is here: no in-container child starts from now on");
            }
            return true;
        }
        return false;
    }

    /** Health's {@code parse}: {@code sidecar} or {@code child}. */
    public String mode() {
        return sidecar() ? "sidecar" : "child";
    }

    public Counts counts() {
        return new Counts(sidecar.get(), sidecarFailed.get(), child.get(), childFailed.get());
    }

    /**
     * @param kind {@code text}, {@code pdf}, {@code docx}, {@code xlsx} or {@code pptx}
     * @throws AttachException {@code empty}, {@code binary}, {@code encrypted}, {@code no_text}, {@code unreadable},
     *     {@code too_complex}, {@code timeout}, {@code busy}, {@code too_large} or {@code unavailable}
     */
    public Text read(String kind, byte[] bytes, int maxChars, int maxPages, String name) throws AttachException {
        long busyUntil = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(busyWindowMs);
        try {
            if (!slots.tryAcquire(busyWindowMs, TimeUnit.MILLISECONDS)) {
                throw new AttachException("busy", name);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AttachException("busy", name);
        }
        boolean viaSidecar = false;
        boolean ok = false;
        try {
            viaSidecar = sidecar();
            Text text = viaSidecar ? viaSidecar(kind, bytes, maxChars, maxPages, name, busyUntil)
                    : viaChild(kind, bytes, maxChars, maxPages, name);
            ok = true;
            return text;
        } finally {
            count(viaSidecar, ok);
            slots.release();
        }
    }

    /** The parse sidecar, tried again after {@code err busy} until the busy window closes. */
    private Text viaSidecar(String kind, byte[] bytes, int maxChars, int maxPages, String name, long busyUntil)
            throws AttachException {
        // The contract's ceilings are ADR 0097 section 2's (2,000,000 characters, 500 pages), which is what files_read
        // asks for, so nothing a caller asks for is cut; the clamp is only a bound.
        int chars = Math.min(maxChars, ParseRequest.MAX_CHARS);
        int pages = Math.min(maxPages, ParseRequest.MAX_PAGES);
        byte[] header;
        try {
            header = new ParseRequest(kind, chars, pages).header();
        } catch (IllegalArgumentException e) {
            throw new AttachException("unreadable", name);
        }
        if (bytes.length > ParseRequest.MAX_BYTES) {
            throw new AttachException("too_large", name, (long) ParseRequest.MAX_BYTES);
        }
        while (true) {
            byte[] out = exchange(header, bytes, chars * 4 + 1024, name);
            Answer answer = answer(out);
            if (answer != Answer.BUSY) {
                return answer.text(out, name);
            }
            if (System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(BUSY_RETRY_MS) - busyUntil > 0) {
                throw new AttachException("busy", name);
            }
            try {
                Thread.sleep(BUSY_RETRY_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AttachException("busy", name);
            }
        }
    }

    /** One connection: the line and the bytes in, a half-close, the answer out, all within the deadline. */
    private byte[] exchange(byte[] header, byte[] bytes, int limit, String name) throws AttachException {
        if (!Files.exists(socket, LinkOption.NOFOLLOW_LINKS)) {
            throw new AttachException("unavailable", name);
        }
        SocketChannel channel;
        try {
            channel = SocketChannel.open(StandardProtocolFamily.UNIX);
        } catch (IOException e) {
            throw new AttachException("unavailable", name);
        }
        try (channel) {
            Future<byte[]> answer = readers.submit(() -> {
                try {
                    channel.connect(UnixDomainSocketAddress.of(socket));
                } catch (IOException | RuntimeException e) {
                    throw new NotConnected();
                }
                try {
                    writeAll(channel, header);
                    writeAll(channel, bytes);
                    channel.shutdownOutput();
                } catch (IOException e) {
                    // The other end stopped taking it: err busy or denied, or a worker that ended first. What it sent says
                    // which.
                }
                return readAnswer(Channels.newInputStream(channel), limit);
            });
            try {
                return answer.get(sidecarSeconds, TimeUnit.SECONDS);
            } catch (TimeoutException e) {
                // Only after desk-svc's own kill and clean-up (35 s, then -clean), so this close ends nothing it hadn't.
                answer.cancel(true);
                throw new AttachException("timeout", name);
            } catch (ExecutionException e) {
                throw new AttachException(e.getCause() instanceof NotConnected ? "unavailable" : "unreadable", name);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                answer.cancel(true);
                throw new AttachException("timeout", name);
            }
        } catch (IOException e) {
            throw new AttachException("unreadable", name);
        }
    }

    /** The connection was refused, or the path isn't a socket. */
    private static final class NotConnected extends IOException {
        private static final long serialVersionUID = 1L;

        NotConnected() {
            super("not connected", null);
        }
    }

    /**
     * The sidecar's answer to its end. A Unix socket whose other end closed with our bytes unread (desk-svc's
     * {@code err busy}, or a worker that stopped reading) reads what it was sent, then fails with a reset: that is the
     * end of the answer, not a failure of it. Past {@code limit} it fails, as the child's does.
     */
    private static byte[] readAnswer(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(1 << 14);
        byte[] chunk = new byte[1 << 14];
        while (true) {
            int read;
            try {
                read = in.read(chunk);
            } catch (IOException e) {
                if (Thread.currentThread().isInterrupted()) {
                    throw e;
                }
                return buffer.toByteArray();
            }
            if (read < 0) {
                return buffer.toByteArray();
            }
            if (buffer.size() + read > limit) {
                throw new IOException("output");
            }
            buffer.write(chunk, 0, read);
        }
    }

    /** What the sidecar's first line says, ADR 0097's failure table. */
    enum Answer {
        OK, ERR, BUSY, UNAVAILABLE, ENDED;

        Text text(byte[] out, String name) throws AttachException {
            return switch (this) {
                case OK, ERR -> parse(out, name);
                case BUSY -> throw new AttachException("busy", name);
                case UNAVAILABLE -> throw new AttachException("unavailable", name);
                case ENDED -> throw new AttachException("too_complex", name);
            };
        }
    }

    static Answer answer(byte[] out) {
        int newline = newline(out);
        if (newline < 0) {
            // No line in the first 64 bytes: the stream ended first (the worker died), or it isn't a worker's answer.
            return out.length < 64 ? Answer.ENDED : Answer.UNAVAILABLE;
        }
        String head = new String(out, 0, newline, StandardCharsets.UTF_8);
        if (head.equals("err busy")) {
            return Answer.BUSY;
        }
        if (head.equals("OK") || head.startsWith("OK ")) {
            return Answer.OK;
        }
        if (head.startsWith("ERR ")) {
            String reason = head.substring(4);
            // bad_request means the two ends disagree on the contract: not the file's doing, so unavailable.
            return REASON.matcher(reason).matches() && !reason.equals("bad_request") ? Answer.ERR : Answer.UNAVAILABLE;
        }
        // err denied, desk-svc's other err lines, or anything else.
        return Answer.UNAVAILABLE;
    }

    private static void writeAll(SocketChannel channel, byte[] bytes) throws IOException {
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        while (buffer.hasRemaining()) {
            channel.write(buffer);
        }
    }

    /** Today's child JVM, only where the sidecar has never been seen. */
    private Text viaChild(String kind, byte[] bytes, int maxChars, int maxPages, String name) throws AttachException {
        Process process = null;
        Path home = null;
        try {
            ProcessBuilder builder = new ProcessBuilder(command(kind, maxChars, maxPages));
            builder.environment().clear();
            home = Files.createTempDirectory("attach-parse-");
            builder.directory(home.toFile());
            builder.redirectError(DEBUG ? ProcessBuilder.Redirect.INHERIT : ProcessBuilder.Redirect.DISCARD);
            process = builder.start();
            Process started = process;
            Thread writer = new Thread(() -> {
                try (OutputStream stdin = started.getOutputStream()) {
                    stdin.write(bytes);
                } catch (IOException e) {
                    // The child ended first; its answer says why.
                }
            }, "attach-parse-writer");
            writer.setDaemon(true);
            writer.start();
            int limit = maxChars * 4 + 1024;
            Future<byte[]> answer = readers.submit(() -> readBounded(started.getInputStream(), limit));
            byte[] out;
            try {
                out = answer.get(timeoutSeconds, TimeUnit.SECONDS);
            } catch (TimeoutException e) {
                throw new AttachException("timeout", name);
            } catch (ExecutionException e) {
                throw new AttachException("unreadable", name);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AttachException("timeout", name);
            }
            return parse(out, name);
        } catch (IOException e) {
            throw new AttachException("unreadable", name);
        } finally {
            if (process != null) {
                process.destroyForcibly();
            }
            if (home != null) {
                try {
                    Files.deleteIfExists(home);
                } catch (IOException e) {
                    // The child can't write there; if the directory is somehow not empty it stays in tmpfs.
                }
            }
        }
    }

    private static int newline(byte[] out) {
        for (int i = 0; i < out.length && i < 64; i++) {
            if (out[i] == '\n') {
                return i;
            }
        }
        return -1;
    }

    private static Text parse(byte[] out, String name) throws AttachException {
        int newline = newline(out);
        if (newline < 0) {
            // The child died before answering: out of memory, or killed.
            throw new AttachException("too_complex", name);
        }
        String head = new String(out, 0, newline, StandardCharsets.UTF_8);
        if (head.startsWith("ERR ")) {
            throw new AttachException(head.substring(4).strip(), name);
        }
        if (!head.startsWith("OK")) {
            throw new AttachException("unreadable", name);
        }
        String text = new String(out, newline + 1, out.length - newline - 1, StandardCharsets.UTF_8);
        return new Text(text, head.contains("cut"));
    }

    private static byte[] readBounded(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(1 << 14);
        byte[] chunk = new byte[1 << 14];
        int read;
        while ((read = in.read(chunk)) >= 0) {
            if (buffer.size() + read > limit) {
                throw new IOException("output");
            }
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    private void count(boolean viaSidecar, boolean ok) {
        (viaSidecar ? sidecar : child).incrementAndGet();
        if (!ok) {
            (viaSidecar ? sidecarFailed : childFailed).incrementAndGet();
        }
        long now = System.nanoTime();
        if (now - countsLoggedAt >= COUNTS_EVERY_NANOS) {
            countsLoggedAt = now;
            logCounts();
        }
    }

    private void logCounts() {
        Counts c = counts();
        long total = c.sidecar() + c.child();
        if (total == countsLogged) {
            return;
        }
        countsLogged = total;
        log.info("attached files read since start: sidecar {} ({} failed), child {} ({} failed)", c.sidecar(),
                c.sidecarFailed(), c.child(), c.childFailed());
    }

    /**
     * The worker's JVM flags, for the child here and, the same list, {@code docker/parse.options} in the image, which the
     * sidecar runs as {@code java @/app/parse.options} ({@code ParseOptionsTest} compares them): the heap, no dumps or
     * core files, no attach, the default CDS archive only, and the security manager allowed so {@code worker/Sandbox}
     * can install itself. The JVM's own output goes to stderr, which is discarded, so stdout carries only the worker's
     * answer: HotSpot prints "Terminating due to java.lang.OutOfMemoryError" and unified logging's warnings on stdout
     * by default, which a sidecar's reader would take for a first line that isn't an answer.
     */
    static final List<String> WORKER_FLAGS = List.of(
            "-Xmx72m", "-Xms8m", "-Xss512k", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1",
            "-XX:MaxMetaspaceSize=96m", "-XX:+ExitOnOutOfMemoryError", "-XX:-HeapDumpOnOutOfMemoryError",
            "-XX:-CreateCoredumpOnCrash", "-XX:ErrorFile=/dev/null", "-XX:-UsePerfData",
            "-XX:+DisableAttachMechanism", "-XX:+DisplayVMOutputToStderr", "-Xlog:disable",
            "-Xlog:all=warning:stderr", "-Xshare:auto", "-Djava.awt.headless=true", "-Djava.security.manager=allow");

    static List<String> command(String kind, int maxChars, int maxPages) {
        List<String> command = new ArrayList<>();
        command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
        command.addAll(WORKER_FLAGS);
        command.addAll(List.of("-Dma.attach.debug=" + DEBUG, "-cp", System.getProperty("java.class.path"), WORKER,
                kind, Integer.toString(maxChars), Integer.toString(maxPages)));
        return command;
    }

    /** The sidecar's worker as {@code java @/app/parse.options} starts it, with this JVM's classpath: for tests. */
    static List<String> streamCommand() {
        List<String> command = new ArrayList<>();
        command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
        command.addAll(WORKER_FLAGS);
        command.addAll(List.of("-Dma.attach.debug=false", "-cp", System.getProperty("java.class.path"), WORKER,
                ParseWorker.FROM_STREAM));
        return command;
    }

    @Override
    public void close() {
        readers.shutdownNow();
        logCounts();
    }
}
