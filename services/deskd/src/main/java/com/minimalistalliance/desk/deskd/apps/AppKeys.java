package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The keys an app or the catalog may be signed with, and checking a signature (the desk app contract, section 6.2).
 *
 * <p><b>A key's id</b> is the first 8 bytes of SHA-256 over its SubjectPublicKeyInfo (DER), as 16 hex digits, the same rule
 * for Ed25519 and ECDSA P-256 keys. Ed25519 signatures are the raw 64 bytes; P-256 ones DER, as the cloud key service gives
 * them, over SHA-256.
 *
 * <p><b>Review keys</b> are MA's, one per tier, and only the image puts them on a desk: PEM files named
 * {@code <tier>.<name>.pem} in {@code /opt/ma/etc/app-keys} (the image's) and {@code /etc/ma/app-keys.d} (a test desk's
 * drop-in, root's like the image), both mounted read-only into deskd's container. Anything else in those directories is
 * skipped. <b>Developer keys</b> come only from a catalog index a review key has signed.
 */
public final class AppKeys {

    public static final String REVIEW = "review";
    public static final String DEVELOPER = "developer";
    static final int MAX_PEM_BYTES = 8 << 10;
    static final int MAX_SIG_FILE_BYTES = 16 << 10;
    static final int MAX_SIGNATURES = 8;
    private static final Pattern KEY_ID = Pattern.compile("[0-9a-f]{16}");
    private static final Pattern FILE = Pattern.compile("(community|first-party)\\.[A-Za-z0-9_-]{1,64}\\.pem");

    /** A key deskd trusts: a review key with its tier, or a developer key with its publisher. */
    public record TrustedKey(String keyId, PublicKey key, String role, String tier, String publisher) {}

    /** One entry of {@code ma-app.sig}. */
    public record Sig(String role, String keyId, byte[] sig) {}

    private AppKeys() {}

    /** @throws GeneralSecurityException if it isn't an Ed25519 or P-256 public key */
    public static PublicKey publicKey(byte[] spki) throws GeneralSecurityException {
        X509EncodedKeySpec spec = new X509EncodedKeySpec(spki);
        try {
            return KeyFactory.getInstance("Ed25519").generatePublic(spec);
        } catch (GeneralSecurityException e) {
            PublicKey key = KeyFactory.getInstance("EC").generatePublic(spec);
            if (key instanceof ECPublicKey ec && ec.getParams().getCurve().getField().getFieldSize() == 256) {
                return key;
            }
            throw new GeneralSecurityException("not P-256");
        }
    }

    public static String keyId(PublicKey key) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(key.getEncoded());
            return HexFormat.of().formatHex(digest, 0, 8);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** False for a bad signature, an algorithm this key isn't for, or any failure to check. */
    public static boolean verify(PublicKey key, byte[] data, byte[] signature) {
        try {
            Signature verifier = Signature.getInstance(key instanceof ECPublicKey ? "SHA256withECDSA" : "Ed25519");
            verifier.initVerify(key);
            verifier.update(data);
            return verifier.verify(signature);
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    /**
     * The review keys in these directories, in order, a file that can't be read or isn't a key left out. A directory that
     * isn't there gives none: that's every desk until the image carries a key, and such a desk installs nothing.
     */
    public static List<TrustedKey> loadReviewKeys(List<Path> directories) {
        List<TrustedKey> keys = new ArrayList<>();
        for (Path directory : directories) {
            if (!Files.isDirectory(directory)) {
                continue;
            }
            try (DirectoryStream<Path> files = Files.newDirectoryStream(directory)) {
                List<Path> sorted = new ArrayList<>();
                files.forEach(sorted::add);
                sorted.sort(null);
                for (Path file : sorted) {
                    String name = file.getFileName().toString();
                    if (!FILE.matcher(name).matches() || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
                        continue;
                    }
                    try {
                        if (Files.size(file) > MAX_PEM_BYTES) {
                            continue;
                        }
                        PublicKey key = publicKey(pem(Files.readString(file, StandardCharsets.US_ASCII)));
                        String tier = name.substring(0, name.indexOf('.'));
                        keys.add(new TrustedKey(keyId(key), key, REVIEW, tier, null));
                    } catch (IOException | GeneralSecurityException | IllegalArgumentException e) {
                        // Not a key this deskd can use: as if it weren't there.
                    }
                }
            } catch (IOException e) {
                // An unreadable directory holds no keys.
            }
        }
        return List.copyOf(keys);
    }

    /** The DER inside one {@code PUBLIC KEY} PEM block. */
    static byte[] pem(String text) {
        String begin = "-----BEGIN PUBLIC KEY-----";
        String end = "-----END PUBLIC KEY-----";
        int from = text.indexOf(begin);
        int to = text.indexOf(end);
        if (from < 0 || to < from) {
            throw new IllegalArgumentException("no PUBLIC KEY block");
        }
        return Base64.getMimeDecoder().decode(text.substring(from + begin.length(), to));
    }

    /**
     * {@code ma-app.sig}: {@code {"signatures": [{"role", "keyId", "sig"}]}}, the signature in base64. Strict, as the manifest is.
     *
     * @throws IllegalArgumentException naming what's wrong
     */
    public static List<Sig> parseSignatures(byte[] bytes) {
        if (bytes.length == 0 || bytes.length > MAX_SIG_FILE_BYTES) {
            throw new IllegalArgumentException("ma-app.sig: size");
        }
        Map<String, Object> json;
        try {
            json = Json.parseObject(bytes);
        } catch (JsonFormatException e) {
            throw new IllegalArgumentException("ma-app.sig: json");
        }
        if (!Set.of("signatures").containsAll(json.keySet()) || !(json.get("signatures") instanceof List<?> list)
                || list.isEmpty() || list.size() > MAX_SIGNATURES) {
            throw new IllegalArgumentException("ma-app.sig: signatures");
        }
        List<Sig> sigs = new ArrayList<>();
        for (Object item : list) {
            sigs.add(sig(item, true));
        }
        return List.copyOf(sigs);
    }

    /** One {@code {role?, keyId, sig}}; the role is required in {@code ma-app.sig} and absent from the catalog's. */
    static Sig sig(Object item, boolean withRole) {
        if (!(item instanceof Map<?, ?>)) {
            throw new IllegalArgumentException("signature");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> s = (Map<String, Object>) item;
        Set<String> known = withRole ? Set.of("role", "keyId", "sig", "alg") : Set.of("keyId", "sig", "alg");
        if (!known.containsAll(s.keySet())) {
            throw new IllegalArgumentException("signature: unknown field");
        }
        String role = Json.string(s, "role");
        String keyId = Json.string(s, "keyId");
        String sig = Json.string(s, "sig");
        if ((withRole && !REVIEW.equals(role) && !DEVELOPER.equals(role)) || keyId == null || !KEY_ID.matcher(keyId).matches()
                || sig == null || sig.length() > 512) {
            throw new IllegalArgumentException("signature");
        }
        return new Sig(role, keyId, Base64.getDecoder().decode(sig));
    }

    /** The trusted key with this id and role, or null. Developer keys are looked up for one publisher only. */
    static TrustedKey find(List<TrustedKey> keys, String keyId, String role, Set<String> revokedKeys) {
        if (revokedKeys.contains(keyId)) {
            return null;
        }
        for (TrustedKey key : keys) {
            if (key.keyId().equals(keyId) && key.role().equals(role)) {
                return key;
            }
        }
        return null;
    }

    /**
     * Section 6.2: a developer signature from a key the catalog registered to the manifest's publisher, and a review
     * signature from one of MA's keys, both over the manifest's exact bytes. The review key's tier is the app's.
     *
     * @return the tier
     * @throws SecurityException naming which signature failed: {@code developer} or {@code review}
     */
    public static String verifyPackage(
            byte[] manifest, List<Sig> sigs, String publisher, List<TrustedKey> review, List<TrustedKey> developers, Set<String> revokedKeys) {
        boolean developer = false;
        String tier = null;
        for (Sig sig : sigs) {
            if (DEVELOPER.equals(sig.role())) {
                TrustedKey key = find(developers, sig.keyId(), DEVELOPER, revokedKeys);
                if (key != null && publisher.equals(key.publisher()) && verify(key.key(), manifest, sig.sig())) {
                    developer = true;
                }
            } else {
                TrustedKey key = find(review, sig.keyId(), REVIEW, revokedKeys);
                if (key != null && verify(key.key(), manifest, sig.sig())) {
                    // Two review signatures of different tiers can't raise the app: the lower one wins.
                    tier = tier == null || AppManifest.COMMUNITY.equals(key.tier()) ? key.tier() : tier;
                }
            }
        }
        if (!developer) {
            throw new SecurityException("developer");
        }
        if (tier == null) {
            throw new SecurityException("review");
        }
        return tier;
    }

    /** For the journal and the client: a key's id never says whose it is, but a count of keys is enough. */
    static Map<String, Object> describe(List<TrustedKey> keys) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("reviewKeys", keys.size());
        return json;
    }
}
