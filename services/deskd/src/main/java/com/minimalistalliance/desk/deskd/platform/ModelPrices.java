package com.minimalistalliance.desk.deskd.platform;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The Platform's table of model prices (ADR 0043), which every desk's Agent app takes as the source of truth. desk-agent
 * can't reach the Platform, so deskd fetches it, keeps the last good one in {@code model-prices.json} on the data volume,
 * and hands it to desk-agent's socket through {@link #onChange} (deskd's {@code agent} package).
 *
 * <p>One virtual thread of its own, sleeping nearly all the time: the file at start, the first fetch after some jitter so
 * a rollout's desks don't all come at once, then one about every 6 hours with {@code If-None-Match}, backing off on a
 * failure. It holds no lock while it waits and shares only the HTTP client with anything else, so a fetch that hangs
 * costs its own connection and its timeout, and touches no heartbeat or session.
 *
 * <p>{@code GET /v1/public/model-prices} takes no auth. A 404 is normal and quiet: the Platform hasn't got it yet, and
 * desk-agent stays on its bundled table. Nothing is kept unless it's at most 1 MiB and desk-agent could use it
 * ({@link #valid}). Nothing here logs a body, or anything read from one.
 */
public final class ModelPrices implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(ModelPrices.class);

    public static final String FILE = "model-prices.json";
    static final String PATH = "/v1/public/model-prices";
    static final int MAX_BYTES = 1 << 20;
    /** Longer than any real one, so a strange header isn't sent back. */
    private static final int MAX_ETAG_CHARS = 256;
    private static final byte[] NOTHING = new byte[0];
    /** desk-agent's format for a price: US dollars a million tokens, as a plain decimal string. */
    private static final Pattern DECIMAL = Pattern.compile("[0-9]+(\\.[0-9]+)?");
    private static final int MAX_PRICE_CHARS = 32;
    /** desk-agent's ceiling, $100,000 a million tokens, in micro-dollars. */
    private static final long MAX_PRICE = 100_000L * 1_000_000L;

    /**
     * @param startJitter the first fetch comes up to this long after start
     * @param period between fetches, give or take {@code periodJitter}
     * @param firstBackoff after the first failure, and how often to look again while there's no API base yet
     * @param maxBackoff failures double up to this
     * @param timeout for the whole response
     */
    public record Timing(
            Duration startJitter,
            Duration period,
            Duration periodJitter,
            Duration firstBackoff,
            Duration maxBackoff,
            Duration timeout) {
        public static final Timing DEFAULT = new Timing(
                Duration.ofMinutes(2),
                Duration.ofHours(6),
                Duration.ofMinutes(30),
                Duration.ofMinutes(1),
                Duration.ofHours(6),
                Duration.ofSeconds(30));
    }

    private final PlatformHttp http;
    private final Supplier<String> apiBase;
    private final Path file;
    private final Timing timing;
    private final ReentrantLock lock = new ReentrantLock();
    private Thread thread;
    private boolean closed;
    private volatile byte[] current;
    private volatile Runnable onChange = () -> {};
    /** Only the loop's thread touches these. */
    private String etag;
    private boolean failing;

    /** @param directory deskd's directory on the data volume */
    public ModelPrices(PlatformHttp http, Supplier<String> apiBase, Path directory, Timing timing) {
        this.http = http;
        this.apiBase = apiBase;
        this.file = directory.resolve(FILE);
        this.timing = timing;
    }

    /** Runs when the table changes, the one from disk included. Set before {@link #start}. Must not block. */
    public void onChange(Runnable listener) {
        onChange = listener;
    }

    /** @return the last good table, as the Platform sent it, or null if there's none yet. The caller mustn't change it */
    public byte[] current() {
        return current;
    }

    /** Loads the file and starts fetching. Later calls do nothing. */
    public void start() {
        lock.lock();
        try {
            if (thread == null && !closed) {
                thread = Thread.ofVirtual().name("model-prices").start(this::run);
            }
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
        } finally {
            lock.unlock();
        }
        if (running != null) {
            running.interrupt();
            try {
                running.join(Duration.ofSeconds(2));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private void run() {
        try {
            load();
            Thread.sleep(jittered(Duration.ZERO, timing.startJitter()));
            Duration backoff = timing.firstBackoff();
            while (true) {
                Duration next;
                try {
                    next = fetch() ? jittered(timing.period().minus(timing.periodJitter()), timing.periodJitter().multipliedBy(2))
                            : timing.firstBackoff();
                    backoff = timing.firstBackoff();
                    failing = false;
                } catch (IOException | RuntimeException e) {
                    if (!failing) {
                        // Once, and again after it works: with a Platform away, one line and no more.
                        failing = true;
                        log.warn("model prices: the fetch failed, the last good table stays ({})", e.getClass().getSimpleName());
                    }
                    next = jittered(backoff, backoff);
                    backoff = backoff.multipliedBy(2);
                    if (backoff.compareTo(timing.maxBackoff()) > 0) {
                        backoff = timing.maxBackoff();
                    }
                }
                Thread.sleep(next);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** A duration from {@code least} up to {@code least + spread}. */
    private static Duration jittered(Duration least, Duration spread) {
        long millis = spread.toMillis();
        return least.plusMillis(millis <= 0 ? 0 : ThreadLocalRandom.current().nextLong(millis + 1));
    }

    /** @return false if there's no API base yet, so nothing was asked. Anything the Platform said is true or thrown */
    private boolean fetch() throws IOException, InterruptedException {
        String base = apiBase.get();
        if (base == null) {
            return false;
        }
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + PATH))
                .timeout(timing.timeout())
                .header("accept", "application/json")
                .GET();
        if (etag != null) {
            request.header("if-none-match", etag);
        }
        HttpResponse<byte[]> response = http.send(request.build(), ModelPrices::body, timing.timeout());
        switch (response.statusCode()) {
            case 200 -> take(response);
            case 304 -> log.debug("model prices: not changed");
            case 404 -> log.debug("model prices: the Platform has none yet");
            default -> throw new IOException("HTTP " + response.statusCode());
        }
        return true;
    }

    private void take(HttpResponse<byte[]> response) throws IOException {
        byte[] body = response.body();
        if (!valid(body)) {
            throw new IOException("the table isn't valid");
        }
        boolean saved = save(body);
        // Only after a save: otherwise the next fetch gets the whole table again, and tries the save again.
        etag = saved ? response.headers().firstValue("etag").filter(ModelPrices::sendable).orElse(null) : null;
        if (!Arrays.equals(body, current)) {
            current = body;
            log.info("model prices: a new table, {} bytes", body.length);
            onChange.run();
        }
    }

    /** Printable ASCII of a sane length, so sending it back can't throw on every fetch from then on. */
    private static boolean sendable(String tag) {
        return tag.length() <= MAX_ETAG_CHARS && tag.chars().allMatch(c -> c > ' ' && c <= '~');
    }

    /**
     * What desk-agent's {@code Pricing.parse} and {@code PriceTable} check, so a table kept here is one it can use: JSON,
     * {@code version} 1, and a non-empty {@code models} of objects, each with {@code input} and {@code output}. Every price
     * given is a decimal string in whole micro-dollars, at most desk-agent's ceiling, and a long prompt's {@code above}
     * has its {@code inputTokens}. At least one model has a price: desk-agent takes 0 in and 0 out as none, and a table of
     * nothing else as no table.
     */
    static boolean valid(byte[] body) {
        if (body.length > MAX_BYTES) {
            return false;
        }
        Map<String, Object> table;
        try {
            table = Json.parseObject(body);
        } catch (JsonFormatException e) {
            return false;
        }
        Map<String, Object> models = Json.object(table, "models");
        if (!Integer.valueOf(1).equals(table.get("version")) || models == null || models.isEmpty()) {
            return false;
        }
        boolean anyPriced = false;
        for (Object value : models.values()) {
            if (!(value instanceof Map<?, ?>)) {
                return false;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> model = (Map<String, Object>) value;
            Boolean priced = tier(model);
            Map<String, Object> above = Json.object(model, "above");
            if (priced != null && above != null) {
                Boolean abovePriced = above.get("inputTokens") instanceof Number tokens && tokens.longValue() >= 1 ? tier(above) : null;
                priced = abovePriced == null ? null : priced && abovePriced;
            }
            if (priced == null) {
                return false;
            }
            anyPriced |= priced;
        }
        return anyPriced;
    }

    /** @return null if this tier's prices aren't desk-agent's format, else whether it has a price, not 0 in and 0 out */
    private static Boolean tier(Map<String, Object> prices) {
        Long input = microUsd(prices.get("input"));
        Long output = microUsd(prices.get("output"));
        if (input == null || output == null) {
            return null;
        }
        for (String optional : List.of("cachedInput", "cacheWrite")) {
            if (prices.containsKey(optional) && microUsd(prices.get(optional)) == null) {
                return null;
            }
        }
        return input != 0 || output != 0;
    }

    /** A price as desk-agent reads one, in micro-dollars, or null if it isn't one. */
    private static Long microUsd(Object value) {
        if (!(value instanceof String text) || text.length() > MAX_PRICE_CHARS || !DECIMAL.matcher(text).matches()) {
            return null;
        }
        try {
            long microUsd = new BigDecimal(text).movePointRight(6).longValueExact();
            return microUsd <= MAX_PRICE ? microUsd : null;
        } catch (ArithmeticException e) {
            return null;
        }
    }

    private void load() {
        try {
            if (Files.size(file) > MAX_BYTES) {
                log.warn("model prices: the kept table is too big, so it's ignored");
                return;
            }
            byte[] body = Files.readAllBytes(file);
            if (!valid(body)) {
                log.warn("model prices: the kept table isn't valid, so it's ignored");
                return;
            }
            current = body;
            onChange.run();
        } catch (NoSuchFileException e) {
            log.debug("model prices: none kept yet");
        } catch (IOException | RuntimeException e) {
            log.warn("model prices: can't read the kept table ({})", e.getClass().getSimpleName());
        }
    }

    /**
     * A temporary file, flushed to disk, then renamed over the real one, so a crash or a full volume leaves the last good
     * table or the new one, whole. The temporary name is removed first and made new, so nothing follows a link.
     *
     * @return false if it couldn't be saved, which costs only the table's surviving a restart
     */
    private boolean save(byte[] body) {
        Path temporary = file.resolveSibling(FILE + ".tmp");
        try {
            Files.deleteIfExists(temporary);
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(body);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE);
            return true;
        } catch (IOException | RuntimeException e) {
            log.warn("model prices: can't keep the table ({})", e.getClass().getSimpleName());
            try {
                Files.deleteIfExists(temporary);
            } catch (IOException | RuntimeException again) {
                log.debug("model prices: the temporary file stays until the next save");
            }
            return false;
        }
    }

    /** A 200's body up to the limit. Any other status's body is thrown away as it comes. */
    private static HttpResponse.BodySubscriber<byte[]> body(HttpResponse.ResponseInfo info) {
        if (info.statusCode() != 200) {
            return HttpResponse.BodySubscribers.replacing(NOTHING);
        }
        return new BoundedBody(info.headers().firstValueAsLong("content-length").orElse(0) > MAX_BYTES);
    }

    /** Fails as soon as it's over the limit, which ends the exchange and its connection: a big body costs no more than that. */
    private static final class BoundedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result = new CompletableFuture<>();
        private final boolean tooBig;
        private byte[] bytes = new byte[8192];
        private int length;
        private Flow.Subscription subscription;

        BoundedBody(boolean tooBig) {
            this.tooBig = tooBig;
        }

        @Override
        public CompletionStage<byte[]> getBody() {
            return result;
        }

        @Override
        public void onSubscribe(Flow.Subscription newSubscription) {
            subscription = newSubscription;
            if (tooBig) {
                overLimit();
                return;
            }
            subscription.request(1);
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                int size = buffer.remaining();
                if (size > MAX_BYTES - length) {
                    overLimit();
                    return;
                }
                if (size > bytes.length - length) {
                    bytes = Arrays.copyOf(bytes, Math.min(MAX_BYTES, Math.max(bytes.length * 2, length + size)));
                }
                buffer.get(bytes, length, size);
                length += size;
            }
            subscription.request(1);
        }

        private void overLimit() {
            subscription.cancel();
            result.completeExceptionally(new IOException("the body is over the limit"));
        }

        @Override
        public void onError(Throwable error) {
            result.completeExceptionally(error);
        }

        @Override
        public void onComplete() {
            result.complete(Arrays.copyOf(bytes, length));
        }
    }
}
