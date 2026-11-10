package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.JWSObject;
import com.nimbusds.jose.JWSVerifier;
import com.nimbusds.jose.crypto.ECDSAVerifier;
import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jose.jwk.JWK;
import com.nimbusds.jose.jwk.JWKSet;
import java.text.ParseException;
import java.time.Clock;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Supplier;

/**
 * The image gate's token (files.md section 6): a JWS from the Platform saying this exact image, by its SHA-256, was
 * checked for this desk and this member. deskd decides here and nowhere else; the order of the checks is the contract's,
 * and the first that fails is the reason.
 *
 * <p>The key source and two switches are configuration, so a test desk can run before the Platform has the token route:
 * {@link Keys} is the desk's cached JWKS, or a JWKS file; {@code allowUnchecked} says whether {@code ma_state}
 * {@code unchecked} (the checker was offline, which the owner's rule treats as ok) is taken; and {@link Mode#STUB}
 * accepts {@code stub.<sha256>}. No release image sets the stub.
 */
final class VerdictVerifier {

    static final String TYPE = "ma-image-verdict+jwt";
    static final String FEATURE = "files";
    static final long MAX_LIFETIME_SECONDS = 30 * 60;
    private static final long SKEW_SECONDS = 30;
    private static final String STUB_PREFIX = "stub.";

    enum Mode {
        /** Tokens from the Platform, checked against its keys. */
        REAL,
        /** {@code stub.<sha256>} is a valid token. Test rigs and test desks only. */
        STUB
    }

    /** Where the verifying keys come from. */
    @FunctionalInterface
    interface Keys {
        /** @return the verifier for this kid, or null for none @throws Exception if no key set can be trusted */
        JWSVerifier verifierFor(String kid) throws Exception;
    }

    /** The desk's identity, as it is known now. Null parts mean not known yet, and nothing then passes. */
    interface Identity {
        String deskId();

        String issuer();
    }

    /** The check_invalid reasons, in the contract's words. */
    static final class Invalid extends Exception {
        private static final long serialVersionUID = 1L;
        private final String reason;

        Invalid(String reason) {
            super(reason, null, false, false);
            this.reason = reason;
        }

        String reason() {
            return reason;
        }
    }

    private final Keys keys;
    private final Identity identity;
    private final Clock clock;
    private final Mode mode;
    private final boolean allowUnchecked;

    VerdictVerifier(Keys keys, Identity identity, Clock clock, Mode mode, boolean allowUnchecked) {
        this.keys = keys;
        this.identity = identity;
        this.clock = clock;
        this.mode = mode;
        this.allowUnchecked = allowUnchecked;
    }

    Mode mode() {
        return mode;
    }

    /** Keys from a JWKS document: EC P-256 keys with a kid. */
    static Keys keysFrom(Supplier<String> jwks) {
        return kid -> {
            JWKSet set = JWKSet.parse(jwks.get());
            JWK jwk = set.getKeyByKeyId(kid);
            if (jwk instanceof ECKey ec) {
                return new ECDSAVerifier(ec.toECPublicKey());
            }
            return null;
        };
    }

    /**
     * @param sha256 the lowercase hex of what deskd holds, or null where only the token's own claims can be checked yet
     * @param size the size to be written
     * @throws Invalid with the first reason that fails
     * @throws RpcException unavailable, {@code reason: keys}, if no key set can be trusted yet
     */
    void verify(String token, String member, String sha256, long size) throws Invalid, RpcException, InterruptedException {
        if (mode == Mode.STUB && token != null && token.startsWith(STUB_PREFIX)) {
            String carried = token.substring(STUB_PREFIX.length());
            if (sha256 != null && !carried.equalsIgnoreCase(sha256)) {
                throw new Invalid("hash");
            }
            return;
        }
        if (token == null || token.length() > 8192) {
            throw new Invalid("signature");
        }
        JWSObject jws;
        try {
            jws = JWSObject.parse(token);
        } catch (ParseException | RuntimeException e) {
            throw new Invalid("signature");
        }
        JWSHeader header = jws.getHeader();
        if (!JWSAlgorithm.ES256.equals(header.getAlgorithm())
                || header.getType() == null
                || !TYPE.equals(header.getType().getType())
                || header.getKeyID() == null
                || header.getKeyID().isEmpty()) {
            throw new Invalid("signature");
        }
        JWSVerifier verifier;
        try {
            verifier = keys.verifierFor(header.getKeyID());
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw new RpcException(RpcException.UNAVAILABLE, "The image check's keys aren't known yet", Map.of("reason", "keys"));
        }
        if (verifier == null) {
            throw new Invalid("signature");
        }
        try {
            if (!jws.verify(verifier)) {
                throw new Invalid("signature");
            }
        } catch (JOSEException | RuntimeException e) {
            throw new Invalid("signature");
        }
        Map<String, Object> claims;
        try {
            claims = Json.parseObject(jws.getPayload().toBytes());
        } catch (JsonFormatException e) {
            throw new Invalid("signature");
        }
        if (Json.string(claims, "jti") == null || Json.string(claims, "ma_img") == null) {
            throw new Invalid("signature");
        }
        String deskId = identity.deskId();
        String issuer = identity.issuer();
        if (deskId == null || issuer == null || !deskId.equals(Json.string(claims, "aud")) || !issuer.equals(Json.string(claims, "iss"))) {
            throw new Invalid("desk");
        }
        if (member == null || !member.equals(Json.string(claims, "sub"))) {
            throw new Invalid("member");
        }
        Long iat = whole(claims.get("iat"));
        Long exp = whole(claims.get("exp"));
        long now = clock.instant().getEpochSecond();
        if (iat == null || exp == null || exp <= iat || exp - iat > MAX_LIFETIME_SECONDS || now >= exp + SKEW_SECONDS || now < iat - SKEW_SECONDS) {
            throw new Invalid("expired");
        }
        if (!FEATURE.equals(Json.string(claims, "ma_feature"))) {
            throw new Invalid("feature");
        }
        String state = Json.string(claims, "ma_state");
        if (!"ok".equals(state) && !("unchecked".equals(state) && allowUnchecked)) {
            throw new Invalid("state");
        }
        Long bytes = whole(claims.get("ma_bytes"));
        if (bytes == null || bytes != size) {
            throw new Invalid("size");
        }
        String carried = Json.string(claims, "ma_sha256");
        if (carried == null || (sha256 != null && !carried.equals(sha256))) {
            throw new Invalid("hash");
        }
    }

    private static Long whole(Object value) {
        if (value instanceof Long l) {
            return l;
        }
        if (value instanceof Integer i) {
            return i.longValue();
        }
        if (value instanceof Double d && d == Math.rint(d) && Math.abs(d) < 9.0e15) {
            return d.longValue();
        }
        return null;
    }

    /** A copy for tests that need to name the claims they put in. */
    static Map<String, Object> claimsOf(String token) throws Exception {
        return new HashMap<>(Json.parseObject(JWSObject.parse(token).getPayload().toBytes()));
    }
}
