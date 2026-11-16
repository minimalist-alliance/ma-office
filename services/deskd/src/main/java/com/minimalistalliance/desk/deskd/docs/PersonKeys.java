package com.minimalistalliance.desk.deskd.docs;

import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.util.HexFormat;
import java.util.Locale;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Person keys (deskd {@code API.md} §25 "A document"): {@code pk_} and 16 hex characters, an HMAC-SHA-256 of the
 * normalised address under a key the member's desks share, so "from Rosa" matches across desks without an address ever
 * leaving the desk that holds it. The key is {@code /data/desk/docs-person.key} (32 random bytes, 0600), made on first
 * use; the office may give every desk the same one ({@code docs.key.set}). Pseudonymous, not anonymous: whoever holds the
 * key and an address can test a match, so the key never leaves the member's own desks and channel.
 */
final class PersonKeys {

    private final Path file;
    private volatile byte[] key;

    PersonKeys(Path file) {
        this.file = file;
    }

    String of(String address) {
        if (address == null || address.isBlank()) {
            return null;
        }
        String norm = Normalizer.normalize(address.strip(), Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key(), "HmacSHA256"));
            byte[] h = mac.doFinal(norm.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return "pk_" + HexFormat.of().formatHex(h, 0, 8);
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The key itself, as 64 hex characters: only for {@code docs.key.get}, and only once the office set it. */
    String hex() {
        return HexFormat.of().formatHex(key());
    }

    /** A short id of the key, never the key: whether two desks share one. */
    String keyId() {
        return HexFormat.of().formatHex(Bytes.sha256(key()).getBytes(java.nio.charset.StandardCharsets.US_ASCII), 0, 4);
    }

    /** The office's shared key for every desk of the member: 32 bytes as 64 hex characters. Returns whether it changed. */
    synchronized boolean set(String hex) throws IOException {
        if (hex == null || !hex.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("key");
        }
        byte[] k = HexFormat.of().parseHex(hex);
        if (java.util.Arrays.equals(k, key())) {
            return false;
        }
        write(k);
        key = k;
        return true;
    }

    private synchronized byte[] key() {
        if (key != null) {
            return key;
        }
        try {
            if (Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
                byte[] k = Files.readAllBytes(file);
                if (k.length == 32) {
                    key = k;
                    return key;
                }
            }
            byte[] k = new byte[32];
            new SecureRandom().nextBytes(k);
            write(k);
            key = k;
        } catch (IOException e) {
            // A key in memory only for this run: person keys match within the run, and a later run makes a new file.
            byte[] k = new byte[32];
            new SecureRandom().nextBytes(k);
            key = k;
        }
        return key;
    }

    private void write(byte[] k) throws IOException {
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.deleteIfExists(tmp);
        try {
            Files.write(Files.createFile(tmp, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))), k,
                    StandardOpenOption.WRITE);
        } catch (FileAlreadyExistsException e) {
            throw new IOException("busy");
        }
        Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rw-------"));
        Files.move(tmp, file, java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }
}
