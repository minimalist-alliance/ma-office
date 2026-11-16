package com.minimalistalliance.desk.courier.envelope;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A desk's public keys as the platform's key directory holds them (contract 0.4.0 §2.1 and §3.1): its Ed25519
 * {@code identityKey}, its X25519 {@code boxKey}, and the {@code binding}, the identity key's signature over
 * {@code "ma-courier-key/v1 bind\n" + boxKey} (the box key's base64url text, as UTF-8). The binding pairs the box key with
 * the identity, so neither the directory nor anyone else can pair one desk's identity with another box key.
 *
 * <p>{@code keysVersion} is the platform's counter of changes, unsigned, so it says nothing a desk relies on for safety;
 * {@link KeyCheck} uses it only to keep a newer answer over an older one. It's -1 where the platform didn't give one.
 */
public record PublishedKeys(IdentityKey identityKey, BoxKey boxKey, byte[] binding, long keysVersion) {

    private static final String BIND = "ma-courier-key/v1 bind\n";
    private static final byte[] FINGERPRINT = "ma-courier-key/v1\n".getBytes(StandardCharsets.UTF_8);

    public PublishedKeys {
        binding = binding.clone();
    }

    /** Binds a box key to this desk's identity: what {@code PUT /v1/agent/keys} sends. */
    public static PublishedKeys bind(IdentityKeyPair identity, BoxKey box) {
        return new PublishedKeys(identity.publicKey(), box, identity.sign(bindInput(box)), -1);
    }

    static byte[] bindInput(BoxKey box) {
        return (BIND + box.text()).getBytes(StandardCharsets.UTF_8);
    }

    /** Whether the binding is the identity key's signature over this box key. */
    public boolean bindingValid() {
        return identityKey.verifies(bindInput(boxKey), binding);
    }

    @Override
    public byte[] binding() {
        return binding.clone();
    }

    /**
     * Contract 0.4.0 §2.1's {@code fingerprint}: SHA-256 over {@code "ma-courier-key/v1\n" || identityKey || boxKey}, the
     * first 16 bytes as lowercase hex in 8 groups of 4 joined by {@code -}. What an invite link carries
     * ({@code ma://courier/<address>#k=<fingerprint>}). It covers the box key too, so it changes when the box key rotates;
     * the safety number ({@link SafetyNumber}) covers the identity only and doesn't.
     */
    public String fingerprint() {
        byte[] d = Arrays.copyOf(IdentityKey.digest("SHA-256", FINGERPRINT, identityKey.bytes(), boxKey.bytes()), 16);
        String hex = HexFormat.of().formatHex(d);
        StringBuilder out = new StringBuilder(39);
        for (int i = 0; i < hex.length(); i += 4) {
            if (i > 0) {
                out.append('-');
            }
            out.append(hex, i, i + 4);
        }
        return out.toString();
    }

    /** Whether an invite's {@code #k=} names these keys (case-insensitive hex, compared in constant time). */
    public boolean matches(String inviteFingerprint) {
        return inviteFingerprint != null && java.security.MessageDigest.isEqual(
                fingerprint().getBytes(StandardCharsets.US_ASCII), inviteFingerprint.toLowerCase(java.util.Locale.ROOT).getBytes(StandardCharsets.US_ASCII));
    }

    /** {@code PUT /v1/agent/keys}' body. */
    public Map<String, Object> toJson() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("identityKey", identityKey.text());
        m.put("boxKey", boxKey.text());
        m.put("binding", B64.encode(binding));
        return m;
    }

    /**
     * From a directory answer ({@code GET /v1/agent/keys/lookup} or {@code GET /v1/agent/keys}). Its other fields
     * ({@code address}, {@code fingerprint}, {@code updatedAt}, {@code devices}) are the platform's and aren't trusted or
     * needed here. The binding isn't checked here: {@link #bindingValid} or {@link KeyCheck} does.
     *
     * @throws EnvelopeException {@code format} for a missing or malformed key or binding
     */
    public static PublishedKeys fromJson(Map<String, Object> m) throws EnvelopeException {
        if (m == null) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "no keys");
        }
        long version = -1;
        Object v = m.get("keysVersion");
        if (v != null) {
            version = Json.longValue(v);
        }
        return new PublishedKeys(IdentityKey.parse(m.get("identityKey")), BoxKey.parse(m.get("boxKey")),
                B64.decode(m.get("binding"), IdentityKey.SIGNATURE_BYTES), version);
    }

    /** The same keys (identity and box), whatever the platform's counter says. */
    public boolean sameKeys(PublishedKeys o) {
        return o != null && identityKey.equals(o.identityKey) && boxKey.equals(o.boxKey);
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof PublishedKeys p && sameKeys(p) && Arrays.equals(binding, p.binding) && keysVersion == p.keysVersion;
    }

    @Override
    public int hashCode() {
        return identityKey.hashCode() * 31 + boxKey.hashCode();
    }

    @Override
    public String toString() {
        return "PublishedKeys[" + fingerprint() + ", v" + keysVersion + "]";
    }
}
