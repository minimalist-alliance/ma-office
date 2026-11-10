package com.minimalistalliance.desk.deskd.auth;

import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSVerifier;
import com.nimbusds.jose.crypto.ECDSAVerifier;
import com.nimbusds.jose.jwk.Curve;
import com.nimbusds.jose.jwk.ECKey;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.text.ParseException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Platform's token signing keys (auth.md 4.3). Cached for an hour and refreshed on use, so there's no
 * timer: a known key answers at once while the refresh runs on the side. An unknown kid may fetch at
 * most once a minute. If api. can't be reached, known keys stay good for 24 hours, and after that
 * nothing verifies.
 *
 * <p>The lock here only guards which fetch is running. No thread holds it across the network, so a
 * session never waits on another's fetch for longer than its own bounded wait.
 */
public final class JwksCache {

    private static final Logger log = LoggerFactory.getLogger(JwksCache.class);

    static final Duration MAX_AGE = Duration.ofHours(1);
    static final Duration KEEP_WHEN_UNREACHABLE = Duration.ofHours(24);
    static final Duration MIN_FETCH_SPACING = Duration.ofMinutes(1);
    private static final Duration FETCH_TIMEOUT = Duration.ofSeconds(3);
    /** Less than the 5 s the gateway gives session.open. */
    private static final Duration WAIT_FOR_FETCH = Duration.ofMillis(3500);

    /** No key can be trusted right now, as opposed to this kid being unknown. */
    public static final class KeysUnavailableException extends Exception {
        private static final long serialVersionUID = 1L;

        KeysUnavailableException() {
            super("no usable keys", null, false, false);
        }
    }

    private record KeySet(Map<String, JWSVerifier> verifiers, Instant fetchedAt) {}

    private final PlatformHttp http;
    private final Supplier<String> url;
    private final Clock clock;
    private final ReentrantLock lock = new ReentrantLock();
    private volatile KeySet keys;
    private CompletableFuture<Void> inFlight;
    private Instant lastAttempt;

    /** @param url read at each fetch, since it comes from config; null until config has arrived */
    public JwksCache(PlatformHttp http, Supplier<String> url, Clock clock) {
        this.http = http;
        this.url = url;
        this.clock = clock;
    }

    /**
     * The key to verify a token with. May park while a fetch runs, holding no lock.
     *
     * @return null if the key set is fresh enough to trust and this kid isn't in it
     * @throws KeysUnavailableException if no key set can be trusted
     */
    JWSVerifier verifierFor(String kid) throws KeysUnavailableException, InterruptedException {
        return verifierForKid(kid);
    }

    /**
     * The same read, for the Files app's verdict tokens (a typ of their own, signed with the keys of desk tokens). No
     * behaviour of its own: it is {@link #verifierFor} with a public door.
     *
     * @return null if the key set is fresh enough to trust and this kid isn't in it
     * @throws KeysUnavailableException if no key set can be trusted
     */
    public JWSVerifier verdictVerifierFor(String kid) throws KeysUnavailableException, InterruptedException {
        return verifierForKid(kid);
    }

    private JWSVerifier verifierForKid(String kid) throws KeysUnavailableException, InterruptedException {
        KeySet current = usableKeys();
        JWSVerifier known = current == null ? null : current.verifiers().get(kid);
        if (known != null) {
            if (!clock.instant().isBefore(current.fetchedAt().plus(MAX_AGE))) {
                startFetch();
            }
            return known;
        }
        CompletableFuture<Void> fetch = startFetch();
        if (fetch != null) {
            await(fetch);
        }
        current = usableKeys();
        if (current == null) {
            throw new KeysUnavailableException();
        }
        return current.verifiers().get(kid);
    }

    /** At boot, so the first session doesn't pay for the fetch. Retries until it has keys. */
    public void loadInBackground(Duration firstBackoff, Duration maxBackoff) {
        Thread.ofVirtual().name("jwks-load").start(() -> {
            Duration backoff = firstBackoff;
            try {
                while (keys == null) {
                    fetch(claimFetch(true));
                    if (keys == null) {
                        Thread.sleep(backoff);
                        Duration doubled = backoff.multipliedBy(2);
                        backoff = doubled.compareTo(maxBackoff) > 0 ? maxBackoff : doubled;
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
    }

    private KeySet usableKeys() {
        KeySet current = keys;
        if (current == null || !clock.instant().isBefore(current.fetchedAt().plus(KEEP_WHEN_UNREACHABLE))) {
            return null;
        }
        return current;
    }

    /** @return the fetch running now, which may have just started, or null if the limit says wait */
    private CompletableFuture<Void> startFetch() {
        CompletableFuture<Void> claimed = claimFetch(false);
        if (claimed == null) {
            lock.lock();
            try {
                return inFlight;
            } finally {
                lock.unlock();
            }
        }
        Thread.ofVirtual().name("jwks-fetch").start(() -> fetch(claimed));
        return claimed;
    }

    /** @return a new fetch for this caller to run, or null if one is running or it's too soon */
    private CompletableFuture<Void> claimFetch(boolean ignoreSpacing) {
        lock.lock();
        try {
            Instant now = clock.instant();
            if (inFlight != null
                    || (!ignoreSpacing && lastAttempt != null && now.isBefore(lastAttempt.plus(MIN_FETCH_SPACING)))) {
                return null;
            }
            lastAttempt = now;
            inFlight = new CompletableFuture<>();
            return inFlight;
        } finally {
            lock.unlock();
        }
    }

    private void fetch(CompletableFuture<Void> claim) {
        if (claim == null) {
            return;
        }
        try {
            String location = url.get();
            if (location != null) {
                keys = new KeySet(parse(download(location)), clock.instant());
            }
        } catch (IOException | JsonFormatException | RuntimeException e) {
            log.warn("JWKS fetch failed: {}", e.getClass().getSimpleName());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            lock.lock();
            try {
                inFlight = null;
            } finally {
                lock.unlock();
            }
            claim.complete(null);
        }
    }

    private byte[] download(String location) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(location)).timeout(FETCH_TIMEOUT).GET().build();
        HttpResponse<byte[]> response = http.send(request, HttpResponse.BodyHandlers.ofByteArray(), FETCH_TIMEOUT);
        if (response.statusCode() != 200) {
            throw new IOException("JWKS answered " + response.statusCode());
        }
        return response.body();
    }

    /** Takes only EC P-256 signing keys with a kid. One bad key doesn't lose the others. */
    private static Map<String, JWSVerifier> parse(byte[] body) throws JsonFormatException, IOException {
        if (!(Json.parseObject(body).get("keys") instanceof List<?> list)) {
            throw new IOException("JWKS has no keys");
        }
        Map<String, JWSVerifier> verifiers = new HashMap<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> raw) {
                @SuppressWarnings("unchecked")
                Map<String, Object> jwk = (Map<String, Object>) raw;
                JWSVerifier verifier = verifierFrom(jwk);
                if (verifier != null) {
                    verifiers.put(Json.string(jwk, "kid"), verifier);
                }
            }
        }
        return Map.copyOf(verifiers);
    }

    private static JWSVerifier verifierFrom(Map<String, Object> jwk) {
        String use = Json.string(jwk, "use");
        String alg = Json.string(jwk, "alg");
        if (!"EC".equals(Json.string(jwk, "kty"))
                || !Curve.P_256.getName().equals(Json.string(jwk, "crv"))
                || Json.string(jwk, "kid") == null
                || (jwk.containsKey("use") && !"sig".equals(use))
                || (jwk.containsKey("alg") && !"ES256".equals(alg))) {
            return null;
        }
        try {
            // Parsing checks that the point is on the curve.
            return new ECDSAVerifier(ECKey.parse(jwk).toECPublicKey());
        } catch (ParseException | JOSEException e) {
            log.warn("JWKS key skipped: {}", e.getClass().getSimpleName());
            return null;
        }
    }

    private static void await(CompletableFuture<Void> fetch) throws InterruptedException {
        try {
            fetch.get(WAIT_FOR_FETCH.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException | ExecutionException e) {
            log.debug("JWKS fetch didn't finish in time");
        }
    }
}
