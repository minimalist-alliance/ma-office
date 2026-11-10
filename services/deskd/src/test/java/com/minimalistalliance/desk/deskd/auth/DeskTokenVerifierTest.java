package com.minimalistalliance.desk.deskd.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.session.SessionAuthorizer;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Every row of the check table in design 4.2.2 and auth.md 4.4, with real ES256 keys. */
class DeskTokenVerifierTest {

    private static final String TAB = "ab".repeat(32);
    private static final Instant NOW = Instant.parse("2026-11-05T12:00:00Z");

    private FakePlatform platform;
    private PlatformHttp http;
    private MutableClock clock;
    private Revocations revocations;
    private DeskTokenVerifier verifier;
    private volatile String deskId = TestTokens.DESK_ID;
    private volatile String userId = TestTokens.OWNER_ID;
    private volatile String issuer = TestTokens.ISSUER;

    @BeforeEach
    void setUp() throws Exception {
        platform = new FakePlatform();
        http = new PlatformHttp();
        clock = new MutableClock(NOW);
        revocations = new Revocations(clock);
        JwksCache keys = new JwksCache(http, () -> platform.url() + "/.well-known/jwks.json", clock);
        DeskTokenVerifier.Trust trust = new DeskTokenVerifier.Trust() {
            @Override
            public String deskId() {
                return deskId;
            }

            @Override
            public String userId() {
                return userId;
            }

            @Override
            public String issuer() {
                return issuer;
            }
        };
        verifier = new DeskTokenVerifier(trust, keys, revocations, clock);
    }

    @AfterEach
    void tearDown() {
        http.close();
        platform.close();
    }

    private Map<String, Object> claims() {
        return platform.tokens.claims(TAB, NOW);
    }

    private String sign(Map<String, Object> claims) {
        return platform.tokens.es256(TestTokens.header(), claims);
    }

    private void assertRefused(String token, String code) {
        assertThatThrownBy(() -> verifier.authorizeOpen(token))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo(code));
    }

    // ---- what a good token gives

    @Test
    void aGoodTokenPassesAndTheGrantCarriesTheFingerprintAsHex() throws Exception {
        SessionGrant grant = verifier.authorizeOpen(platform.tokens.mint(TAB, NOW));
        assertThat(grant.sub()).isEqualTo(TestTokens.OWNER_ID);
        assertThat(grant.sid()).isEqualTo("s-testsession");
        assertThat(grant.scope()).isEqualTo("owner");
        assertThat(grant.expectedFingerprint()).isEqualTo(TAB);
        assertThat(grant.video()).isTrue();
        assertThat(grant.input()).isTrue();
        assertThat(grant.issuedAt()).isEqualTo(NOW);
        assertThat(grant.validUntil()).isEqualTo(NOW.plusSeconds(330));
    }

    @Test
    void unknownClaimsAreIgnored() throws Exception {
        Map<String, Object> claims = claims();
        claims.put("ma_something_new", List.of(1, 2));
        assertThat(verifier.authorizeOpen(sign(claims)).sid()).isEqualTo("s-testsession");
    }

    // ---- row 1: header

    @Test
    void algNoneIsRefused() {
        assertRefused(platform.tokens.unsigned(claims()), "invalid_token");
    }

    @Test
    void hs256SignedWithThePublicKeyIsRefused() {
        assertRefused(platform.tokens.hs256WithPublicKey(claims()), "invalid_token");
    }

    @Test
    void es384IsRefused() {
        Map<String, Object> header = TestTokens.header();
        header.put("alg", "ES384");
        assertRefused(platform.tokens.es256(header, claims()), "invalid_token");
    }

    @Test
    void aWrongOrMissingTypIsRefused() {
        Map<String, Object> guild = TestTokens.header();
        guild.put("typ", "ma-guild+jwt");
        assertRefused(platform.tokens.es256(guild, claims()), "invalid_token");
        Map<String, Object> none = TestTokens.header();
        none.remove("typ");
        assertRefused(platform.tokens.es256(none, claims()), "invalid_token");
        Map<String, Object> jwt = TestTokens.header();
        jwt.put("typ", "JWT");
        assertRefused(platform.tokens.es256(jwt, claims()), "invalid_token");
    }

    @Test
    void aMissingOrUnknownKidIsRefused() {
        Map<String, Object> none = TestTokens.header();
        none.remove("kid");
        assertRefused(platform.tokens.es256(none, claims()), "invalid_token");
        Map<String, Object> unknown = TestTokens.header();
        unknown.put("kid", "dt-other");
        assertRefused(platform.tokens.es256(unknown, claims()), "invalid_token");
    }

    @Test
    void aCriticalHeaderNobodyUnderstandsIsRefused() {
        Map<String, Object> header = TestTokens.header();
        header.put("crit", List.of("exp2"));
        header.put("exp2", 1);
        assertRefused(platform.tokens.es256(header, claims()), "invalid_token");
    }

    @Test
    void garbageIsRefused() {
        assertRefused("", "invalid_token");
        assertRefused(null, "invalid_token");
        assertRefused("not.a.token", "invalid_token");
        assertRefused("a.b", "invalid_token");
        assertRefused(platform.tokens.mint(TAB, NOW) + "." + "x".repeat(5000), "invalid_token");
    }

    // ---- row 2: signature

    @Test
    void aForgedTokenSignedByAnotherKeyUnderTheSameKidIsRefused() {
        KeyPair attacker = TestTokens.newKeyPair();
        String forged = TestTokens.es256(TestTokens.header(), Json.bytes(claims()), attacker);
        assertRefused(forged, "invalid_token");
    }

    @Test
    void aTamperedPayloadIsRefused() {
        String token = platform.tokens.mint(TAB, NOW);
        String[] parts = token.split("\\.");
        Map<String, Object> claims = claims();
        claims.put("sub", "someone-else");
        parts[1] = Base64.getUrlEncoder().withoutPadding().encodeToString(Json.bytes(claims));
        assertRefused(String.join(".", parts), "invalid_token");
    }

    @Test
    void anAllZeroSignatureIsRefused() {
        String token = platform.tokens.mint(TAB, NOW);
        String head = token.substring(0, token.lastIndexOf('.'));
        assertRefused(head + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[64]), "invalid_token");
    }

    @Test
    void aWrongIssuerIsRefused() {
        Map<String, Object> claims = claims();
        claims.put("iss", "https://api.minimalistalliance.com");
        assertRefused(sign(claims), "invalid_token");
    }

    // ---- row 3: this desk and this owner

    @Test
    void aWrongAudIsWrongDesk() {
        Map<String, Object> claims = claims();
        claims.put("aud", "d-otherdesk0000");
        assertRefused(sign(claims), "wrong_desk");
    }

    @Test
    void anAudArrayIsRefusedEvenWithThisDeskInIt() {
        Map<String, Object> claims = claims();
        claims.put("aud", List.of(TestTokens.DESK_ID));
        assertRefused(sign(claims), "wrong_desk");
    }

    @Test
    void aWrongOwnerIsWrongDesk() {
        Map<String, Object> claims = claims();
        claims.put("ma_owner", "someone-else");
        assertRefused(sign(claims), "wrong_desk");
    }

    @Test
    void anOwnerScopeTokenForAnotherUserIsRefused() {
        Map<String, Object> claims = claims();
        claims.put("sub", "someone-else");
        assertRefused(sign(claims), "invalid_token");
    }

    @Test
    void aGrantFromBeforeARevocationCountsAsRevoked() throws Exception {
        SessionGrant grant = verifier.authorizeOpen(platform.tokens.mint(TAB, NOW));
        assertThat(verifier.isRevoked(grant)).isFalse();
        revocations.apply(List.of(grant.sid()), List.of(), null);
        assertThat(verifier.isRevoked(grant)).isTrue();
    }

    /**
     * Regression: Nimbus throws NullPointerException on a header of null, which became desk_not_ready
     * on session.open, which errors.md says to retry, and no reply at all on AUTH.
     */
    @Test
    void aTokenWhoseHeaderOrClaimsArentAnObjectIsInvalid() throws Exception {
        Base64.Encoder encoder = Base64.getUrlEncoder().withoutPadding();
        for (String header : List.of("null", "[]", "1", "\"x\"", "{}")) {
            String part = encoder.encodeToString(header.getBytes(StandardCharsets.UTF_8));
            assertRefused(part + ".e30.AAAA", "invalid_token");
        }
        for (String claims : List.of("null", "{}x")) {
            byte[] payload = claims.getBytes(StandardCharsets.UTF_8);
            assertRefused(TestTokens.es256(TestTokens.header(), payload, platform.tokens.keys()), "invalid_token");
        }
    }

    // ---- row 4: times

    @Test
    void expiredIsRefusedAtExactlyExpPlus30AndGoodJustBefore() throws Exception {
        clock.advance(Duration.ofSeconds(329));
        verifier.authorizeOpen(platform.tokens.es256(TestTokens.header(), claims()));
        clock.advance(Duration.ofSeconds(1));
        assertRefused(sign(claims()), "invalid_token");
    }

    @Test
    void notBeforeHasThirtySecondsOfSkew() throws Exception {
        Instant future = NOW.plusSeconds(30);
        verifier.authorizeOpen(platform.tokens.mint(TAB, future));
        assertRefused(platform.tokens.mint(TAB, NOW.plusSeconds(31)), "invalid_token");
    }

    @Test
    void aLifetimeOver300SecondsIsRefused() {
        Map<String, Object> claims = claims();
        claims.put("exp", NOW.getEpochSecond() + 301);
        assertRefused(sign(claims), "invalid_token");
    }

    @Test
    void missingOrNonNumericTimesAreRefused() {
        for (String name : List.of("iat", "nbf", "exp")) {
            Map<String, Object> missing = claims();
            missing.remove(name);
            assertRefused(sign(missing), "invalid_token");
            Map<String, Object> text = claims();
            text.put(name, "1793826000");
            assertRefused(sign(text), "invalid_token");
        }
    }

    // ---- row 5: scope

    @Test
    void supportScopeIsRefusedForNow() {
        Map<String, Object> claims = claims();
        claims.put("scope", "support");
        claims.put("ma_support_until", NOW.plusSeconds(3600).toString());
        assertRefused(sign(claims), "invalid_token");
    }

    @Test
    void anExportTokenPassesWithNeitherVideoNorInput() throws Exception {
        Map<String, Object> claims = claims();
        claims.put("scope", "export");
        SessionGrant grant = verifier.authorizeOpen(sign(claims));
        assertThat(grant.scope()).isEqualTo("export");
        assertThat(grant.sub()).isEqualTo(TestTokens.OWNER_ID);
        assertThat(grant.video()).isFalse();
        assertThat(grant.input()).isFalse();
        assertThat(grant.validUntil()).isEqualTo(NOW.plusSeconds(330));
    }

    @Test
    void anExportTokenForAnotherUserIsRefused() {
        Map<String, Object> claims = claims();
        claims.put("scope", "export");
        claims.put("sub", "someone-else");
        assertRefused(sign(claims), "invalid_token");
    }

    @Test
    void aRefreshCantTurnOneScopeIntoTheOther() throws Exception {
        SessionGrant owner = current();
        Map<String, Object> export = claims();
        export.put("scope", "export");
        assertRefreshRefused(export, owner);
        Map<String, Object> exportOpen = claims();
        exportOpen.put("scope", "export");
        exportOpen.put("sid", "s-export");
        SessionGrant exportSession = verifier.authorizeOpen(sign(exportOpen));
        Map<String, Object> ownerRefresh = claims();
        ownerRefresh.put("sid", "s-export");
        assertRefreshRefused(ownerRefresh, exportSession);
        Map<String, Object> exportRefresh = claims();
        exportRefresh.put("scope", "export");
        exportRefresh.put("sid", "s-export");
        assertThat(verifier.authorizeRefresh(sign(exportRefresh), exportSession).scope()).isEqualTo("export");
    }

    @Test
    void anUnknownOrMissingScopeIsRefused() {
        Map<String, Object> claims = claims();
        claims.put("scope", "owner support");
        assertRefused(sign(claims), "invalid_token");
        claims.put("scope", "Export");
        assertRefused(sign(claims), "invalid_token");
        claims.remove("scope");
        assertRefused(sign(claims), "invalid_token");
    }

    // ---- row 6: replay and revocation

    @Test
    void aReplayedJtiIsRefused() throws Exception {
        String token = platform.tokens.mint(TAB, NOW);
        verifier.authorizeOpen(token);
        assertRefused(token, "invalid_token");
    }

    @Test
    void aTokenRefusedOnAnotherCheckDoesntUseUpItsJti() throws Exception {
        Map<String, Object> claims = claims();
        Map<String, Object> wrongDesk = new LinkedHashMap<>(claims);
        wrongDesk.put("aud", "d-otherdesk0000");
        assertRefused(sign(wrongDesk), "wrong_desk");
        assertThat(verifier.authorizeOpen(sign(claims))).isNotNull();
    }

    @Test
    void jtisAreForgottenOnceTheTokenCouldNoLongerVerifyAndTheCacheIsBounded() {
        ReplayCache cache = new ReplayCache();
        for (int i = 0; i < ReplayCache.MAX_ENTRIES; i++) {
            assertThat(cache.claim("jti-" + i, NOW.plusSeconds(330), NOW)).isTrue();
        }
        // Full, and nothing has expired: it fails closed rather than forgetting a live jti.
        assertThat(cache.claim("one-more", NOW.plusSeconds(330), NOW)).isFalse();
        assertThat(cache.claim("one-more", NOW.plusSeconds(1000), NOW.plusSeconds(330))).isTrue();
        assertThat(cache.claim("jti-0", NOW.plusSeconds(1000), NOW.plusSeconds(330))).isTrue();
    }

    @Test
    void aMissingJtiSidOrSubIsRefused() {
        for (String name : List.of("jti", "sid", "sub")) {
            Map<String, Object> claims = claims();
            claims.remove(name);
            assertRefused(sign(claims), "invalid_token");
        }
    }

    @Test
    void aRevokedSidIsRefused() {
        revocations.apply(List.of("s-testsession"), List.of(), null);
        assertRefused(platform.tokens.mint(TAB, NOW), "invalid_token");
    }

    @Test
    void aRevokedUserIsRefusedUntilANewTokenIsIssuedAfterwards() throws Exception {
        revocations.apply(List.of(), List.of(TestTokens.OWNER_ID), null);
        assertRefused(platform.tokens.mint(TAB, NOW), "invalid_token");
        clock.advance(Duration.ofSeconds(10));
        verifier.authorizeOpen(platform.tokens.mint(TAB, clock.instant()));
    }

    @Test
    void tokensValidAfterRefusesOlderTokensAndNeverMovesBack() throws Exception {
        revocations.apply(List.of(), List.of(), NOW.plusSeconds(1).toString());
        assertRefused(platform.tokens.mint(TAB, NOW), "invalid_token");
        verifier.authorizeOpen(platform.tokens.mint(TAB, NOW.plusSeconds(1)));
        revocations.apply(List.of(), List.of(), NOW.minusSeconds(100).toString());
        assertRefused(platform.tokens.mint(TAB, NOW), "invalid_token");
    }

    @Test
    void revocationsLastAsLongAsAnyTokenTheyCouldBeAbout() throws Exception {
        revocations.apply(List.of("s-testsession"), List.of(), null);
        clock.advance(Duration.ofMinutes(14));
        assertRefused(platform.tokens.mint(TAB, clock.instant()), "invalid_token");
        clock.advance(Duration.ofMinutes(2));
        verifier.authorizeOpen(platform.tokens.mint(TAB, clock.instant()));
    }

    // ---- check 7's input: cnf

    @Test
    void aMissingOrMalformedCnfIsRefused() {
        Map<String, Object> missing = claims();
        missing.remove("cnf");
        assertRefused(sign(missing), "invalid_token");
        Map<String, Object> shortOne = claims();
        shortOne.put("cnf", Map.of("x5t#S256", Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[31])));
        assertRefused(sign(shortOne), "invalid_token");
        Map<String, Object> notBase64 = claims();
        notBase64.put("cnf", Map.of("x5t#S256", "not base64!"));
        assertRefused(sign(notBase64), "invalid_token");
    }

    // ---- refresh

    private SessionGrant current() throws Exception {
        return verifier.authorizeOpen(platform.tokens.mint(TAB, NOW));
    }

    private void assertRefreshRefused(Map<String, Object> claims, SessionGrant current) {
        assertThatThrownBy(() -> verifier.authorizeRefresh(sign(claims), current))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("invalid_token"));
    }

    @Test
    void aRefreshWithTheSameSessionPasses() throws Exception {
        SessionGrant current = current();
        clock.advance(Duration.ofSeconds(240));
        SessionGrant fresh = verifier.authorizeRefresh(platform.tokens.mint(TAB, clock.instant()), current);
        assertThat(fresh.validUntil()).isAfter(current.validUntil());
    }

    @Test
    void aRefreshMustKeepSidSubScopeAndCnf() throws Exception {
        SessionGrant current = current();
        Map<String, Object> otherSid = claims();
        otherSid.put("sid", "s-other");
        assertRefreshRefused(otherSid, current);
        Map<String, Object> otherTab = platform.tokens.claims("cd".repeat(32), NOW);
        assertRefreshRefused(otherTab, current);
        // A different sub or scope is refused before it even reaches the comparison.
        Map<String, Object> otherSub = claims();
        otherSub.put("sub", "someone-else");
        assertRefreshRefused(otherSub, current);
        SessionGrant otherScopeSession = new SessionGrant(
                current.sub(), current.sid(), "support", current.expectedFingerprint(), true, true, NOW, NOW.plusSeconds(60));
        assertRefreshRefused(claims(), otherScopeSession);
    }

    @Test
    void aFailedRefreshKeepsItsJtiForALaterCorrectUse() throws Exception {
        SessionGrant current = current();
        Map<String, Object> claims = claims();
        SessionGrant other = new SessionGrant("x", "y", "owner", TAB, true, true, NOW, NOW);
        assertThatThrownBy(() -> verifier.authorizeRefresh(sign(claims), other))
                .isInstanceOf(SessionAuthorizer.RefusedException.class);
        assertThat(verifier.authorizeRefresh(sign(claims), current)).isNotNull();
    }

    // ---- fail closed

    @Test
    void withoutIdentityOrConfigEverythingIsRefused() {
        String token = platform.tokens.mint(TAB, NOW);
        deskId = null;
        assertRefused(token, "desk_not_ready");
        deskId = TestTokens.DESK_ID;
        userId = null;
        assertRefused(token, "desk_not_ready");
        userId = TestTokens.OWNER_ID;
        issuer = null;
        assertRefused(token, "desk_not_ready");
    }

    @Test
    void withNoKeysEverFetchedEverythingIsRefused() {
        platform.jwksUp = false;
        assertRefused(platform.tokens.mint(TAB, NOW), "desk_not_ready");
    }

    @Test
    void refusalsNeverCarryTokenTextIntoTheException() {
        String token = platform.tokens.unsigned(claims());
        assertThatThrownBy(() -> verifier.authorizeOpen(token))
                .hasMessageNotContaining(token.substring(0, 20))
                .hasNoCause();
    }

    @Test
    void aSignedPayloadThatIsNotOneJsonObjectIsRefused() {
        String notAnObject = TestTokens.es256(
                TestTokens.header(), "[1,2,3]".getBytes(StandardCharsets.UTF_8), platform.tokens.keys());
        assertRefused(notAnObject, "invalid_token");
        String repeatedKey = TestTokens.es256(
                TestTokens.header(),
                ("{\"iss\":\"" + TestTokens.ISSUER + "\",\"iss\":\"x\"}").getBytes(StandardCharsets.UTF_8),
                platform.tokens.keys());
        assertRefused(repeatedKey, "invalid_token");
    }
}
