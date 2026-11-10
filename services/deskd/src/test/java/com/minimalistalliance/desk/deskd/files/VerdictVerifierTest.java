package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import com.nimbusds.jose.crypto.ECDSAVerifier;
import java.security.KeyPair;
import java.security.interfaces.ECPublicKey;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class VerdictVerifierTest {

    private static final String SHA = "ab".repeat(32);
    private static final Instant NOW = Instant.parse("2026-11-08T12:00:00Z");

    private final TestTokens tokens = new TestTokens();
    private final MutableClock clock = new MutableClock(NOW);

    private VerdictVerifier verifier(boolean allowUnchecked) {
        ECPublicKey key = (ECPublicKey) tokens.keys().getPublic();
        return new VerdictVerifier(
                kid -> TestTokens.KID.equals(kid) ? new ECDSAVerifier(key) : null,
                new VerdictVerifier.Identity() {
                    public String deskId() {
                        return TestTokens.DESK_ID;
                    }

                    public String issuer() {
                        return TestTokens.ISSUER;
                    }
                },
                clock, VerdictVerifier.Mode.REAL, allowUnchecked);
    }

    private Map<String, Object> claims() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("iss", TestTokens.ISSUER);
        c.put("aud", TestTokens.DESK_ID);
        c.put("sub", "member-1");
        c.put("iat", NOW.getEpochSecond());
        c.put("exp", NOW.getEpochSecond() + 600);
        c.put("jti", "j1");
        c.put("ma_feature", "files");
        c.put("ma_img", "img-1");
        c.put("ma_sha256", SHA);
        c.put("ma_bytes", 1234L);
        c.put("ma_state", "ok");
        return c;
    }

    private Map<String, Object> header() {
        Map<String, Object> h = new LinkedHashMap<>();
        h.put("alg", "ES256");
        h.put("typ", VerdictVerifier.TYPE);
        h.put("kid", TestTokens.KID);
        return h;
    }

    private String reasonOf(String token, boolean allowUnchecked) throws Exception {
        try {
            verifier(allowUnchecked).verify(token, "member-1", SHA, 1234);
            return "ok";
        } catch (VerdictVerifier.Invalid e) {
            return e.reason();
        }
    }

    private String reasonOf(Map<String, Object> claims) throws Exception {
        return reasonOf(tokens.es256(header(), claims), true);
    }

    @Test
    void aGoodTokenPasses() throws Exception {
        assertThat(reasonOf(claims())).isEqualTo("ok");
    }

    @Test
    void uncheckedPassesOnlyWhenTheSwitchAllowsIt() throws Exception {
        Map<String, Object> c = claims();
        c.put("ma_state", "unchecked");
        assertThat(reasonOf(tokens.es256(header(), c), true)).isEqualTo("ok");
        assertThat(reasonOf(tokens.es256(header(), c), false)).isEqualTo("state");
        c.put("ma_state", "rejected");
        assertThat(reasonOf(c)).isEqualTo("state");
    }

    @Test
    void theSignatureAndHeaderAreCheckedFirst() throws Exception {
        KeyPair other = TestTokens.newKeyPair();
        assertThat(reasonOf(TestTokens.es256(header(), com.minimalistalliance.desk.deskd.protocol.Json.bytes(claims()), other), true)).isEqualTo("signature");
        Map<String, Object> wrongType = header();
        wrongType.put("typ", "ma-desk+jwt");
        assertThat(reasonOf(tokens.es256(wrongType, claims()), true)).isEqualTo("signature");
        Map<String, Object> wrongKid = header();
        wrongKid.put("kid", "nope");
        assertThat(reasonOf(tokens.es256(wrongKid, claims()), true)).isEqualTo("signature");
        assertThat(reasonOf("not.a.token", true)).isEqualTo("signature");
        assertThat(reasonOf(tokens.unsigned(claims()), true)).isEqualTo("signature");
        assertThat(reasonOf(tokens.hs256WithPublicKey(claims()), true)).isEqualTo("signature");
        // A desk token (typ ma-desk+jwt, with a scope) is never a verdict.
        assertThat(reasonOf(tokens.mint("cd".repeat(32), NOW), true)).isEqualTo("signature");
    }

    @Test
    void deskMemberExpiryFeatureStateSizeAndHashEachHaveTheirReason() throws Exception {
        Map<String, Object> c = claims();
        c.put("aud", "d-other");
        assertThat(reasonOf(c)).isEqualTo("desk");
        c = claims();
        c.put("iss", "https://elsewhere.invalid");
        assertThat(reasonOf(c)).isEqualTo("desk");
        c = claims();
        c.put("sub", "someone-else");
        assertThat(reasonOf(c)).isEqualTo("member");
        c = claims();
        c.put("exp", NOW.getEpochSecond() - 60);
        c.put("iat", NOW.getEpochSecond() - 600);
        assertThat(reasonOf(c)).isEqualTo("expired");
        c = claims();
        c.put("exp", NOW.getEpochSecond() + 3600);
        assertThat(reasonOf(c)).isEqualTo("expired");
        c = claims();
        c.put("ma_feature", "forums");
        assertThat(reasonOf(c)).isEqualTo("feature");
        c = claims();
        c.put("ma_bytes", 1235L);
        assertThat(reasonOf(c)).isEqualTo("size");
        c = claims();
        c.put("ma_sha256", "cd".repeat(32));
        assertThat(reasonOf(c)).isEqualTo("hash");
        c = claims();
        c.remove("ma_img");
        assertThat(reasonOf(c)).isEqualTo("signature");
    }

    @Test
    void theTokenExpiresWithTheClockAndAllowsASkew() throws Exception {
        String token = tokens.es256(header(), claims());
        clock.advance(Duration.ofSeconds(620));
        assertThat(reasonOf(token, true)).isEqualTo("ok");
        clock.advance(Duration.ofSeconds(20));
        assertThat(reasonOf(token, true)).isEqualTo("expired");
    }

    @Test
    void theChecksRunInTheContractsOrder() throws Exception {
        Map<String, Object> c = claims();
        c.put("aud", "d-other");
        c.put("sub", "someone-else");
        c.put("ma_bytes", 1L);
        assertThat(reasonOf(c)).isEqualTo("desk");
    }

    @Test
    void beforeTheHashIsKnownOnlyTheClaimsAreChecked() {
        assertThatCode(() -> verifier(true).verify(tokens.es256(header(), claims()), "member-1", null, 1234)).doesNotThrowAnyException();
        assertThatThrownBy(() -> verifier(true).verify(tokens.es256(header(), claims()), "member-1", null, 99)).isInstanceOf(VerdictVerifier.Invalid.class);
    }

    @Test
    void keysThatCantBeLoadedAreUnavailableNotInvalid() {
        VerdictVerifier v = new VerdictVerifier(
                kid -> {
                    throw new IllegalStateException("no key set");
                },
                new VerdictVerifier.Identity() {
                    public String deskId() {
                        return TestTokens.DESK_ID;
                    }

                    public String issuer() {
                        return TestTokens.ISSUER;
                    }
                },
                clock, VerdictVerifier.Mode.REAL, true);
        assertThatThrownBy(() -> v.verify(tokens.es256(header(), claims()), "member-1", SHA, 1234))
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo("unavailable");
                    assertThat(e.details()).containsEntry("reason", "keys");
                });
    }

    @Test
    void theStubTokenIsAcceptedOnlyInStubMode() throws Exception {
        VerdictVerifier stub = new VerdictVerifier(kid -> null, new VerdictVerifier.Identity() {
            public String deskId() {
                return null;
            }

            public String issuer() {
                return null;
            }
        }, clock, VerdictVerifier.Mode.STUB, true);
        stub.verify("stub." + SHA, "anyone", SHA, 5);
        assertThatThrownBy(() -> stub.verify("stub." + "cd".repeat(32), "anyone", SHA, 5)).isInstanceOf(VerdictVerifier.Invalid.class);
        assertThat(reasonOf("stub." + SHA, true)).isEqualTo("signature");
    }

    @Test
    void aJwksFileGivesTheKeys() throws Exception {
        String jwks = new String(com.minimalistalliance.desk.deskd.protocol.Json.bytes(tokens.jwks()), java.nio.charset.StandardCharsets.UTF_8);
        VerdictVerifier v = new VerdictVerifier(
                VerdictVerifier.keysFrom(() -> jwks),
                new VerdictVerifier.Identity() {
                    public String deskId() {
                        return TestTokens.DESK_ID;
                    }

                    public String issuer() {
                        return TestTokens.ISSUER;
                    }
                },
                clock, VerdictVerifier.Mode.REAL, true);
        v.verify(tokens.es256(header(), claims()), "member-1", SHA, 1234);
    }
}
