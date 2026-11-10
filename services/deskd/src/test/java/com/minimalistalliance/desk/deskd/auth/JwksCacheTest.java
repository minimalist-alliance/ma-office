package com.minimalistalliance.desk.deskd.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class JwksCacheTest {

    static {
        TestTiming.pollFast();
    }

    private FakePlatform platform;
    private PlatformHttp http;
    private MutableClock clock;
    private JwksCache cache;

    @BeforeEach
    void setUp() throws Exception {
        platform = new FakePlatform();
        http = new PlatformHttp();
        clock = new MutableClock(Instant.parse("2026-11-05T12:00:00Z"));
        cache = new JwksCache(http, () -> platform.url() + "/.well-known/jwks.json", clock);
    }

    @AfterEach
    void tearDown() {
        http.close();
        platform.close();
    }

    /**
     * Regression: a fetch that stalled after its headers never ended, so inFlight stayed set and no
     * other fetch could ever start, until a restart.
     */
    @Test
    void aFetchThatStallsAfterItsHeadersDoesntWedgeTheCache() throws Exception {
        platform.jwksStallsLeft.set(1);
        assertThatThrownBy(() -> cache.verifierFor(TestTokens.KID))
                .isInstanceOf(JwksCache.KeysUnavailableException.class);
        assertThat(platform.jwksFetches).hasValue(1);
        clock.advance(Duration.ofSeconds(61));
        assertThat(cache.verifierFor(TestTokens.KID)).isNotNull();
        assertThat(platform.jwksFetches).hasValue(2);
    }

    @Test
    void aKnownKeyIsCachedForAnHour() throws Exception {
        assertThat(cache.verifierFor(TestTokens.KID)).isNotNull();
        clock.advance(Duration.ofMinutes(59));
        assertThat(cache.verifierFor(TestTokens.KID)).isNotNull();
        assertThat(platform.jwksFetches).hasValue(1);
    }

    @Test
    void afterAnHourTheKeyAnswersAtOnceAndARefreshRunsOnTheSide() throws Exception {
        cache.verifierFor(TestTokens.KID);
        clock.advance(Duration.ofMinutes(61));
        platform.jwksDelayMillis = 2000;
        long started = System.nanoTime();
        assertThat(cache.verifierFor(TestTokens.KID)).isNotNull();
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(1));
        await().until(() -> platform.jwksFetches.get() == 2);
    }

    @Test
    void anUnknownKidFetchesAtMostOnceAMinute() throws Exception {
        cache.verifierFor(TestTokens.KID);
        assertThat(cache.verifierFor("dt-unknown-1")).isNull();
        assertThat(platform.jwksFetches).hasValue(1);
        clock.advance(Duration.ofSeconds(59));
        assertThat(cache.verifierFor("dt-unknown-2")).isNull();
        assertThat(platform.jwksFetches).hasValue(1);
        clock.advance(Duration.ofSeconds(2));
        assertThat(cache.verifierFor("dt-unknown-3")).isNull();
        assertThat(platform.jwksFetches).hasValue(2);
    }

    @Test
    void aRotatedKeyIsPickedUpOnAnUnknownKid() throws Exception {
        cache.verifierFor(TestTokens.KID);
        clock.advance(Duration.ofSeconds(61));
        platform.jwksBody = Map.of("keys", List.of(
                TestTokens.jwk(platform.tokens.keys(), TestTokens.KID),
                TestTokens.jwk(TestTokens.newKeyPair(), "dt-next")));
        assertThat(cache.verifierFor("dt-next")).isNotNull();
    }

    @Test
    void whenApiIsUnreachableKnownKeysLast24HoursAndThenNothingVerifies() throws Exception {
        cache.verifierFor(TestTokens.KID);
        platform.jwksUp = false;
        clock.advance(Duration.ofHours(23));
        assertThat(cache.verifierFor(TestTokens.KID)).isNotNull();
        clock.advance(Duration.ofMinutes(59));
        assertThat(cache.verifierFor(TestTokens.KID)).isNotNull();
        clock.advance(Duration.ofMinutes(2));
        assertThatThrownBy(() -> cache.verifierFor(TestTokens.KID)).isInstanceOf(JwksCache.KeysUnavailableException.class);
    }

    @Test
    void afterThatOutageAFetchBringsThemBack() throws Exception {
        cache.verifierFor(TestTokens.KID);
        platform.jwksUp = false;
        clock.advance(Duration.ofHours(25));
        assertThatThrownBy(() -> cache.verifierFor(TestTokens.KID)).isInstanceOf(JwksCache.KeysUnavailableException.class);
        platform.jwksUp = true;
        clock.advance(Duration.ofMinutes(2));
        assertThat(cache.verifierFor(TestTokens.KID)).isNotNull();
    }

    @Test
    void aSlowFetchHoldsNoLockThatAnotherSessionWaitsOn() throws Exception {
        cache.verifierFor(TestTokens.KID);
        clock.advance(Duration.ofSeconds(61));
        platform.jwksDelayMillis = 1500;
        CompletableFuture<Object> unknown = new CompletableFuture<>();
        Thread.ofVirtual().start(() -> {
            try {
                unknown.complete(cache.verifierFor("dt-unknown"));
            } catch (Exception e) {
                unknown.completeExceptionally(e);
            }
        });
        await().until(() -> platform.jwksFetches.get() == 2);

        long started = System.nanoTime();
        assertThat(cache.verifierFor(TestTokens.KID)).isNotNull();
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofMillis(500));
        assertThat(unknown.get(5, TimeUnit.SECONDS)).isNull();
    }

    @Test
    void onlyEcP256SigningKeysWithAKidAreTaken() throws Exception {
        Map<String, Object> good = TestTokens.jwk(platform.tokens.keys(), "good");
        Map<String, Object> rsa = Map.of("kty", "RSA", "kid", "rsa", "n", "AQAB", "e", "AQAB");
        Map<String, Object> encryption = new HashMap<>(TestTokens.jwk(platform.tokens.keys(), "enc"));
        encryption.put("use", "enc");
        Map<String, Object> otherAlg = new HashMap<>(TestTokens.jwk(platform.tokens.keys(), "es384"));
        otherAlg.put("alg", "ES384");
        Map<String, Object> offCurve = new HashMap<>(TestTokens.jwk(platform.tokens.keys(), "off"));
        offCurve.put("x", offCurve.get("y"));
        Map<String, Object> noKid = new HashMap<>(TestTokens.jwk(platform.tokens.keys(), "x"));
        noKid.remove("kid");
        platform.jwksBody = Map.of("keys", List.of(rsa, encryption, otherAlg, offCurve, noKid, good, "not a key"));

        assertThat(cache.verifierFor("good")).isNotNull();
        for (String kid : List.of("rsa", "enc", "es384", "off")) {
            assertThat(cache.verifierFor(kid)).isNull();
        }
    }

    @Test
    void anUnusableResponseKeepsTheKeysItHad() throws Exception {
        cache.verifierFor(TestTokens.KID);
        platform.jwksBody = Map.of("nope", 1);
        clock.advance(Duration.ofSeconds(61));
        assertThat(cache.verifierFor("dt-unknown")).isNull();
        assertThat(cache.verifierFor(TestTokens.KID)).isNotNull();
    }

    @Test
    void loadingInTheBackgroundRetriesUntilItHasKeys() throws Exception {
        platform.jwksUp = false;
        cache.loadInBackground(Duration.ofMillis(10), Duration.ofMillis(20));
        await().until(() -> platform.jwksFetches.get() >= 2);
        platform.jwksUp = true;
        await().until(() -> {
            try {
                return cache.verifierFor(TestTokens.KID) != null;
            } catch (JwksCache.KeysUnavailableException e) {
                return false;
            }
        });
    }
}
