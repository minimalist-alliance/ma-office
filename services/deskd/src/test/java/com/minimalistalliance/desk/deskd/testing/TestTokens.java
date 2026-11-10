package com.minimalistalliance.desk.deskd.testing;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Mints desk tokens the way Platform does, with real ES256 keys. It signs with JDK crypto, apart from
 * the code under test, and can make any bad token a test asks for.
 */
public final class TestTokens {

    public static final String KID = "dt-test";
    public static final String DESK_ID = "d-testdesk0001";
    public static final String OWNER_ID = "7d1c0e4a-5b3f-4c2d-9e8a-1f2b3c4d5e6f";
    public static final String ISSUER = "https://api.test.invalid";

    private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
    private final AtomicLong nextJti = new AtomicLong();
    private final KeyPair keys = newKeyPair();

    public static KeyPair newKeyPair() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"));
            return generator.generateKeyPair();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public KeyPair keys() {
        return keys;
    }

    /** The JWKS body with this key under {@link #KID}. */
    public Map<String, Object> jwks() {
        return Map.of("keys", List.of(jwk(keys, KID)));
    }

    public static Map<String, Object> jwk(KeyPair pair, String kid) {
        ECPublicKey key = (ECPublicKey) pair.getPublic();
        Map<String, Object> jwk = new LinkedHashMap<>();
        jwk.put("kty", "EC");
        jwk.put("crv", "P-256");
        jwk.put("kid", kid);
        jwk.put("use", "sig");
        jwk.put("alg", "ES256");
        jwk.put("x", B64.encodeToString(fixed(key.getW().getAffineX())));
        jwk.put("y", B64.encodeToString(fixed(key.getW().getAffineY())));
        return jwk;
    }

    private static byte[] fixed(BigInteger value) {
        byte[] raw = value.toByteArray();
        byte[] out = new byte[32];
        int copy = Math.min(raw.length, 32);
        System.arraycopy(raw, raw.length - copy, out, 32 - copy, copy);
        return out;
    }

    public static Map<String, Object> header() {
        Map<String, Object> header = new LinkedHashMap<>();
        header.put("alg", "ES256");
        header.put("typ", "ma-desk+jwt");
        header.put("kid", KID);
        return header;
    }

    /** Good claims for the fixed desk and owner, bound to this certificate, at this time. */
    public Map<String, Object> claims(String fingerprintHex, Instant now) {
        long seconds = now.getEpochSecond();
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", ISSUER);
        claims.put("aud", DESK_ID);
        claims.put("sub", OWNER_ID);
        claims.put("scope", "owner");
        claims.put("sid", "s-testsession");
        claims.put("jti", "jt-" + nextJti.incrementAndGet());
        claims.put("iat", seconds);
        claims.put("nbf", seconds);
        claims.put("exp", seconds + 300);
        claims.put("auth_time", seconds);
        claims.put("cnf", Map.of("x5t#S256", B64.encodeToString(HexFormat.of().parseHex(fingerprintHex))));
        claims.put("ma_owner", OWNER_ID);
        claims.put("ma_kind", "personal");
        claims.put("ma_name", "Test Owner");
        return claims;
    }

    /** A guild desk's guild, and one of its members (auth.md 4.5 on sub/guild-desk). */
    public static final String GUILD_ID = "gu-k3m7q2x7v4ab";
    public static final String MEMBER_ID = "gm-q7xk2m4p5v3a";

    public static Map<String, Object> guildHeader() {
        Map<String, Object> header = header();
        header.put("typ", "ma-guild+jwt");
        return header;
    }

    /** Good claims for a member of {@link #GUILD_ID} on the fixed desk, as an officer with two grants. */
    public Map<String, Object> memberClaims(String fingerprintHex, Instant now) {
        long seconds = now.getEpochSecond();
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", ISSUER);
        claims.put("aud", DESK_ID);
        claims.put("sub", MEMBER_ID);
        claims.put("scope", "guild_member");
        claims.put("sid", "s-membersession");
        claims.put("jti", "jt-" + nextJti.incrementAndGet());
        claims.put("iat", seconds);
        claims.put("nbf", seconds);
        claims.put("exp", seconds + 300);
        claims.put("auth_time", seconds);
        claims.put("cnf", Map.of("x5t#S256", B64.encodeToString(HexFormat.of().parseHex(fingerprintHex))));
        claims.put("ma_gid", GUILD_ID);
        claims.put("ma_grole", "officer");
        claims.put("ma_grants", List.of("moderate", "invite"));
        claims.put("ma_name", "Sam");
        claims.put("ma_badge", "officer");
        claims.put("ma_teen", false);
        return claims;
    }

    /** A good member token. */
    public String mintMember(String fingerprintHex, Instant now) {
        return es256(guildHeader(), memberClaims(fingerprintHex, now));
    }

    /** A good token. */
    public String mint(String fingerprintHex, Instant now) {
        return es256(header(), claims(fingerprintHex, now));
    }

    public String es256(Map<String, Object> header, Map<String, Object> claims) {
        return es256(header, Json.bytes(claims), keys);
    }

    public static String es256(Map<String, Object> header, byte[] payload, KeyPair signer) {
        String input = encode(header) + "." + B64.encodeToString(payload);
        try {
            Signature signature = Signature.getInstance("SHA256withECDSAinP1363Format");
            signature.initSign(signer.getPrivate());
            signature.update(input.getBytes(StandardCharsets.US_ASCII));
            return input + "." + B64.encodeToString(signature.sign());
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The classic confusion attack: HS256 with the public key as the secret. */
    public String hs256WithPublicKey(Map<String, Object> claims) {
        Map<String, Object> header = header();
        header.put("alg", "HS256");
        String input = encode(header) + "." + B64.encodeToString(Json.bytes(claims));
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(keys.getPublic().getEncoded(), "HmacSHA256"));
            return input + "." + B64.encodeToString(mac.doFinal(input.getBytes(StandardCharsets.US_ASCII)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public String unsigned(Map<String, Object> claims) {
        Map<String, Object> header = header();
        header.put("alg", "none");
        return encode(header) + "." + B64.encodeToString(Json.bytes(claims)) + ".";
    }

    private static String encode(Map<String, Object> value) {
        return B64.encodeToString(Json.bytes(value));
    }
}
