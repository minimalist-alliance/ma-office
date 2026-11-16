package com.minimalistalliance.desk.deskd.courier.parse;

import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's side of {@code desk-parse}'s Courier mode (the launch plan's Wave 1.2; ADR 0097's sandbox, amended by the draft
 * ADR "Courier's store" §4): untrusted mail goes over a Unix socket to a worker in the sandbox (uid 1113, no network, no
 * {@code /data}), and only its answer comes back. deskd never parses MIME or HTML itself.
 *
 * <p>The wire is one ASCII line ({@code courier1 <op>[ <part>]}) and the bytes, then the worker's line ({@code OK ...} or
 * {@code ERR <reason>}) and a body. Writing goes on a thread of its own while the answer is read, so neither side can
 * wait on the other, and a deadline closes the connection whatever happens. One request at a time, as the sandbox serves
 * one ({@code desk-svc -max-conn 1}); {@code err busy} is tried again for a short while.
 *
 * <p>What a failure means, so that nothing is lost and nothing hostile is half read:
 * <ul>
 * <li>no socket, a refused connection, {@code err denied} or any other {@code err} line from {@code desk-svc}, or a worker
 *     that doesn't know the request (an image older than the Courier mode): {@link CourierParser.Unavailable}, and the
 *     message waits as {@code pending} for the next sweep;</li>
 * <li>{@code ERR <reason>} for a limit or unreadable mail: a refusal with that reason;</li>
 * <li>an answer that ends before its line, twice (the worker ran out of memory or was killed): {@code too_complex};</li>
 * <li>no answer by the deadline: {@code timeout};</li>
 * <li>an answer that isn't what was asked for (bad JSON, the wrong shape, over its cap): {@code answer}.</li>
 * </ul>
 * Nothing here logs a message's content, an address or a name: only kinds of failure, as counts.
 */
public final class CourierSandbox implements CourierParser {

    private static final Logger log = LoggerFactory.getLogger(CourierSandbox.class);

    public static final String DEFAULT_SOCKET = "/run/desk-parse-courier/sock/parse.sock";

    /** The most deskd sends: the sandbox's own limit (40 MiB); over it is {@code too_large} without asking. */
    public static final int MAX_REQUEST = 40 << 20;
    /** The most of each answer read: past it the answer is refused ({@code answer}). */
    static final int MAX_MESSAGE_ANSWER = 20 << 20;
    static final int MAX_PART_ANSWER = (25 << 20) + 64;
    static final int MAX_IMAGE_ANSWER = (8 << 20) + 64;
    static final int MAX_ARCHIVE_ANSWER = 8 << 20;

    /** The refusal words a worker may send; anything else on an {@code ERR} line is the sandbox's own trouble. */
    static final Set<String> REASONS = Set.of("too_large", "too_deep", "too_many_parts", "timeout", "malformed", "too_complex",
            "unsupported", "not_found", "encrypted", "unreadable");
    private static final Pattern PART = Pattern.compile("[1-9][0-9]{0,3}(\\.[1-9][0-9]{0,3}){0,21}");

    /**
     * @param socket the sandbox's socket
     * @param deadline how long one request may take, connect to the answer's end (the worker ends itself at 10 s)
     * @param busyWindow how long {@code err busy} is tried again
     */
    public record Settings(Path socket, Duration deadline, Duration busyWindow) {
        public static Settings defaults(Path socket) {
            return new Settings(socket, DEFAULT_DEADLINE, Duration.ofSeconds(15));
        }
    }

    /** The sandbox's own end for a worker: {@code desk-svc -deadline-sec} in the image's {@code desk-parse-courier-run}. */
    public static final Duration DESK_SVC_DEADLINE = Duration.ofSeconds(15);
    /**
     * deskd's own end for one request: past {@code desk-svc}'s kill and its clean-up, so a connection always ends by
     * {@code desk-svc}'s own close after {@code -clean} (Security CP-L1). A worker that took itself over can then never hold
     * the socket's path while deskd sends the next message. The worker ends itself at 10 s, so this is reached only when
     * {@code desk-svc} itself is stuck.
     */
    public static final Duration DEFAULT_DEADLINE = DESK_SVC_DEADLINE.plusSeconds(5);

    /** What the worker answered, or why there's nothing to read. */
    public sealed interface Answer permits Ok, Declined {}

    /** {@code OK}: the words after it, and the body. */
    public record Ok(String note, byte[] body) implements Answer {
        @Override
        public String toString() {
            return "Ok[" + body.length + " bytes]";
        }
    }

    /** A reason the worker or this side gave for not reading it ({@link CourierParser.Refused}'s words, or {@code answer}). */
    public record Declined(String reason) implements Answer {}

    private final Settings settings;
    private final Semaphore one = new Semaphore(1, true);
    private final java.util.concurrent.atomic.AtomicLong unavailable = new java.util.concurrent.atomic.AtomicLong();
    private final java.util.concurrent.atomic.AtomicLong refused = new java.util.concurrent.atomic.AtomicLong();

    public CourierSandbox(Settings settings) {
        this.settings = settings;
    }

    @Override
    public Result parse(byte[] raw) throws Unavailable, InterruptedException {
        return message(raw);
    }

    /** The message read: {@code parse-courier 1} through {@link ParsedMessage#fromWire}, or a refusal. */
    public CourierParser.Result message(byte[] raw) throws CourierParser.Unavailable, InterruptedException {
        if (raw.length > MAX_REQUEST) {
            return new CourierParser.Refused("too_large");
        }
        Answer a = request("courier1 message", raw, MAX_MESSAGE_ANSWER);
        if (a instanceof Declined r) {
            return new CourierParser.Refused(r.reason());
        }
        Ok ok = (Ok) a;
        if (!ok.note().isEmpty()) {
            refusedAnswer();
            return new CourierParser.Refused("answer");
        }
        try {
            return new CourierParser.Parsed(ParsedMessage.fromWire(readAnswer(ok.body())));
        } catch (JsonFormatException | IllegalArgumentException | ClassCastException e) {
            refusedAnswer();
            return new CourierParser.Refused("answer");
        }
    }

    /** A part's decoded bytes, for "Download" and "Save to Files" (Wave 3.1), or a refusal. */
    public Answer part(byte[] raw, String part) throws CourierParser.Unavailable, InterruptedException {
        if (!PART.matcher(part).matches()) {
            return new Declined("not_found");
        }
        Answer a = request("courier1 part " + part, raw, MAX_PART_ANSWER);
        if (a instanceof Ok ok && !ok.note().equals(Integer.toString(ok.body().length))) {
            return refusedAnswer();
        }
        return a;
    }

    /** A part re-encoded as an image ({@code png} or {@code jpeg}); {@code part} null re-encodes {@code bytes} themselves. */
    public Answer image(byte[] bytes, String part) throws CourierParser.Unavailable, InterruptedException {
        if (part != null && !PART.matcher(part).matches()) {
            return new Declined("not_found");
        }
        Answer a = request("courier1 image " + (part == null ? "-" : part), bytes, MAX_IMAGE_ANSWER);
        if (a instanceof Ok ok && !ok.note().matches("(png|jpeg) [1-9][0-9]{0,4} [1-9][0-9]{0,4}")) {
            return refusedAnswer();
        }
        return a;
    }

    /** An archive part's file list, read without unpacking ({@code {v, format, entries, total, truncated, danger}}). */
    public Map<String, Object> archive(byte[] raw, String part) throws CourierParser.Unavailable, InterruptedException {
        if (!PART.matcher(part).matches()) {
            return null;
        }
        Answer a = request("courier1 archive " + part, raw, MAX_ARCHIVE_ANSWER);
        if (!(a instanceof Ok ok) || !ok.note().isEmpty()) {
            return null;
        }
        try {
            Map<String, Object> m = readAnswer(ok.body());
            return m.get("v") instanceof Number v && v.intValue() == 1 ? m : null;
        } catch (JsonFormatException e) {
            return null;
        }
    }

    /**
     * Documents' requests (deskd {@code API.md} §24, the sandbox's documents mode): a {@code docs1} line and the file, in
     * the same one-at-a-time turn as mail. A worker older than the mode answers {@code ERR bad_request}, which is
     * {@link CourierParser.Unavailable}, so an index on an older image works from structure alone. {@code encrypted} and
     * {@code unreadable} are the mode's own refusals; Courier's worker never sends them.
     */
    public Answer docs(String line, byte[] file, int cap) throws CourierParser.Unavailable, InterruptedException {
        if (line == null || !DOCS_LINE.matcher(line).matches()) {
            return new Declined("bad_request");
        }
        return request(line, file, cap);
    }

    private static final Pattern DOCS_LINE = Pattern.compile("docs1 (read (pdf|docx|xlsx|pptx|text) [1-9][0-9]{0,5} [1-9][0-9]{0,2}"
            + "|render [1-9][0-9]{0,2} [1-9][0-9]{2,3})");

    /**
     * The most JSON tokens an answer may have (Security CP-L4). The worker's largest answer (2,000 parts, 2,500 addresses,
     * the fields) is under 50,000; a hostile one inside the byte cap could otherwise be millions of empty maps, each its own
     * object on deskd's heap.
     */
    static final long MAX_TOKENS = 400_000;

    /** Answers' own parser: unpooled (mail stays in no shared buffer), nesting 16 deep, a token cap, the byte cap. */
    private static final tools.jackson.jr.ob.JSON ANSWERS = tools.jackson.jr.ob.JSON.builder(tools.jackson.core.json.JsonFactory.builder()
                    .recyclerPool(tools.jackson.core.util.JsonRecyclerPools.nonRecyclingPool())
                    .streamReadConstraints(tools.jackson.core.StreamReadConstraints.builder()
                            .maxNestingDepth(16)
                            .maxTokenCount(MAX_TOKENS)
                            .maxDocumentLength(MAX_PART_ANSWER)
                            .build())
                    .build())
            .disable(tools.jackson.jr.ob.JSON.Feature.HANDLE_JAVA_BEANS)
            .disable(tools.jackson.jr.ob.JSON.Feature.USE_DEFERRED_MAPS)
            .build();

    /** One JSON object, nothing after it and no repeated key, or {@link JsonFormatException}. */
    static Map<String, Object> readAnswer(byte[] body) throws JsonFormatException {
        try (tools.jackson.core.JsonParser parser = ANSWERS.createParser(body)) {
            Map<String, Object> object = ANSWERS.mapFrom(parser);
            if (object == null || parser.nextToken() != null) {
                throw new JsonFormatException();
            }
            return object;
        } catch (tools.jackson.core.JacksonException e) {
            throw new JsonFormatException();
        }
    }

    private Declined refusedAnswer() {
        refused.incrementAndGet();
        return new Declined("answer");
    }

    /** One request, its turn waited for, {@code err busy} tried again, and an empty answer once more. */
    Answer request(String line, byte[] input, int cap) throws CourierParser.Unavailable, InterruptedException {
        if (input.length > MAX_REQUEST) {
            return new Declined("too_large");
        }
        if (!one.tryAcquire(settings.busyWindow().toMillis() + settings.deadline().toMillis() * 2, TimeUnit.MILLISECONDS)) {
            throw unavailable("turn");
        }
        try {
            long busyUntil = System.nanoTime() + settings.busyWindow().toNanos();
            boolean retriedEmpty = false;
            while (true) {
                Exchange e = exchange(line, input, cap);
                switch (e.kind) {
                    case ANSWER -> {
                        return e.answer;
                    }
                    case BUSY -> {
                        if (System.nanoTime() > busyUntil) {
                            throw unavailable("busy");
                        }
                        Thread.sleep(50);
                    }
                    case EMPTY -> {
                        if (retriedEmpty) {
                            // Twice nothing: this message ended its worker, or no worker can run at all (a desk-agent
                            // image older than the Courier mode, Security CP-I5). A small message of deskd's own tells the
                            // two apart, so a broken sandbox leaves mail waiting, never refused for good.
                            if (!probe()) {
                                throw unavailable("worker");
                            }
                            refused.incrementAndGet();
                            return new Declined("too_complex");
                        }
                        retriedEmpty = true;
                    }
                    case UNAVAILABLE -> throw unavailable(e.why);
                    case TIMEOUT -> {
                        refused.incrementAndGet();
                        return new Declined("timeout");
                    }
                    default -> throw unavailable("state");
                }
            }
        } finally {
            one.release();
        }
    }

    private static final byte[] PROBE = "From: probe@example.com\r\nSubject: probe\r\n\r\nprobe\r\n".getBytes(StandardCharsets.US_ASCII);

    /** Whether the sandbox reads a message at all: one of deskd's own, a few lines long. Called holding the turn. */
    private boolean probe() throws InterruptedException {
        Exchange e = exchange("courier1 message", PROBE, MAX_MESSAGE_ANSWER);
        return e.kind == Kind.ANSWER && e.answer instanceof Ok;
    }

    private CourierParser.Unavailable unavailable(String why) {
        long n = unavailable.incrementAndGet();
        if (n == 1 || Long.bitCount(n) == 1) {
            log.warn("courier: the parse sandbox can't be used ({}; {} so far), mail waits for it", why, n);
        }
        return new CourierParser.Unavailable(why);
    }

    private enum Kind { ANSWER, BUSY, EMPTY, UNAVAILABLE, TIMEOUT }

    private record Exchange(Kind kind, Answer answer, String why) {
        static Exchange of(Kind kind, String why) {
            return new Exchange(kind, null, why);
        }
    }

    private Exchange exchange(String line, byte[] input, int cap) throws InterruptedException {
        SocketChannel channel;
        try {
            channel = SocketChannel.open(StandardProtocolFamily.UNIX);
        } catch (IOException e) {
            return Exchange.of(Kind.UNAVAILABLE, "socket");
        }
        AtomicBoolean timedOut = new AtomicBoolean();
        Thread closer = Thread.ofVirtual().unstarted(() -> {
            try {
                Thread.sleep(settings.deadline().toMillis());
                timedOut.set(true);
                channel.close();
            } catch (InterruptedException | IOException e) {
                // Finished first, or closed already.
            }
        });
        closer.start();
        Thread writer = null;
        try {
            try {
                channel.connect(UnixDomainSocketAddress.of(settings.socket()));
            } catch (IOException | RuntimeException e) {
                return timedOut.get() ? Exchange.of(Kind.TIMEOUT, null) : Exchange.of(Kind.UNAVAILABLE, "connect");
            }
            byte[] header = (line + "\n").getBytes(StandardCharsets.US_ASCII);
            writer = Thread.ofVirtual().start(() -> {
                try {
                    write(channel, ByteBuffer.wrap(header));
                    write(channel, ByteBuffer.wrap(input));
                    channel.shutdownOutput();
                } catch (IOException e) {
                    // The worker stopped reading: its answer says why.
                }
            });
            return read(channel, cap, timedOut);
        } finally {
            closer.interrupt();
            try {
                channel.close();
            } catch (IOException e) {
                // Closed.
            }
            if (writer != null) {
                writer.join(1000);
            }
        }
    }

    private static void write(SocketChannel channel, ByteBuffer b) throws IOException {
        while (b.hasRemaining()) {
            // At most 64 KiB a write, so the JDK's temporary direct buffer stays small.
            ByteBuffer slice = b.slice(b.position(), Math.min(b.remaining(), 64 * 1024));
            int n = channel.write(slice);
            b.position(b.position() + n);
        }
    }

    private Exchange read(SocketChannel channel, int cap, AtomicBoolean timedOut) {
        byte[] lineBytes = new byte[160];
        int lineLength = 0;
        ByteBuffer one = ByteBuffer.allocate(1);
        try {
            while (true) {
                one.clear();
                int n = channel.read(one);
                if (n < 0) {
                    return lineLength == 0 ? Exchange.of(Kind.EMPTY, null) : Exchange.of(Kind.UNAVAILABLE, "line");
                }
                if (n == 0) {
                    continue;
                }
                byte b = one.get(0);
                if (b == '\n') {
                    break;
                }
                if (lineLength == lineBytes.length || b < 0x20 || b > 0x7E) {
                    return Exchange.of(Kind.UNAVAILABLE, "line");
                }
                lineBytes[lineLength++] = b;
            }
            String first = new String(lineBytes, 0, lineLength, StandardCharsets.US_ASCII);
            if (first.equals("err busy")) {
                return Exchange.of(Kind.BUSY, null);
            }
            if (first.startsWith("err ") || first.equals("ERR unavailable") || first.equals("ERR bad_request")) {
                return Exchange.of(Kind.UNAVAILABLE, first.startsWith("err ") ? "desk-svc" : "worker");
            }
            if (first.startsWith("ERR ")) {
                String reason = first.substring(4);
                if (!REASONS.contains(reason)) {
                    return Exchange.of(Kind.UNAVAILABLE, "reason");
                }
                refused.incrementAndGet();
                return new Exchange(Kind.ANSWER, new Declined(reason), null);
            }
            if (!first.equals("OK") && !first.startsWith("OK ")) {
                return Exchange.of(Kind.UNAVAILABLE, "line");
            }
            String note = first.length() > 2 ? first.substring(3) : "";
            if (note.matches("[0-9]{1,9}")) {
                // A part's bytes, counted on its line: read into exactly that much, so a 25 MiB part isn't held twice.
                return readCounted(channel, Integer.parseInt(note), cap, note, timedOut);
            }
            java.io.ByteArrayOutputStream body = new java.io.ByteArrayOutputStream(64 * 1024);
            ByteBuffer buf = ByteBuffer.allocate(64 * 1024);
            while (true) {
                buf.clear();
                int n = channel.read(buf);
                if (n < 0) {
                    break;
                }
                if (body.size() + n > cap) {
                    return new Exchange(Kind.ANSWER, refusedAnswer(), null);
                }
                body.write(buf.array(), 0, n);
            }
            if (timedOut.get()) {
                return Exchange.of(Kind.TIMEOUT, null);
            }
            return new Exchange(Kind.ANSWER, new Ok(note, body.toByteArray()), null);
        } catch (IOException e) {
            return timedOut.get() ? Exchange.of(Kind.TIMEOUT, null) : Exchange.of(lineLength == 0 ? Kind.EMPTY : Kind.UNAVAILABLE, "read");
        }
    }

    /** An answer whose line said how many bytes follow: exactly those, then the end, or it's refused as {@code answer}. */
    private Exchange readCounted(SocketChannel channel, int n, int cap, String note, AtomicBoolean timedOut) throws IOException {
        if (n > cap) {
            return new Exchange(Kind.ANSWER, refusedAnswer(), null);
        }
        byte[] body = new byte[n];
        ByteBuffer buf = ByteBuffer.wrap(body);
        while (buf.hasRemaining()) {
            if (channel.read(buf) < 0) {
                break;
            }
        }
        if (timedOut.get()) {
            return Exchange.of(Kind.TIMEOUT, null);
        }
        if (buf.hasRemaining() || channel.read(ByteBuffer.allocate(1)) >= 0) {
            // Fewer bytes than it said, or more: not what was asked for.
            return new Exchange(Kind.ANSWER, refusedAnswer(), null);
        }
        return new Exchange(Kind.ANSWER, new Ok(note, body), null);
    }

    /** Requests that couldn't reach the sandbox, and answers that were refusals, since deskd started (for health). */
    public long unavailableCount() {
        return unavailable.get();
    }

    public long refusedCount() {
        return refused.get();
    }

    @Override
    public String toString() {
        return "CourierSandbox[" + settings.socket() + "]";
    }
}
