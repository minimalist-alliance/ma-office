package com.minimalistalliance.desk.deskd.desks;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * This desk's own keys for messages between the member's desks (draft ADR "the Agent's tools and approvals", §14; design
 * §8.5): an Ed25519 key that signs every envelope this desk sends and an X25519 key that envelopes to it are sealed to.
 * Made once, on first use, and kept in deskd's own {@code /data/desk/desk-keys.json} (0600 from its creation, written
 * whole), which desk-agent's user can't read. Only the public halves ever leave: in an {@code offer} or an
 * {@code accept}, where the other desk pins them for that grant. The box key is signed by the signing key
 * ({@link Pub#binding}), so nothing can pair this desk's identity with another desk's box key.
 *
 * <p>A file that isn't ours (another desk's id, a link, not a file, a wrong shape) is set aside as {@code .bad} and new
 * keys are made: the grants pinned to the old ones then refuse, and the member pairs again. Nothing here logs a key.
 */
public final class DeskKeys {

    private static final Logger log = LoggerFactory.getLogger(DeskKeys.class);

    public static final String FILE = "desk-keys.json";
    private static final HexFormat HEX = HexFormat.of();
    static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
    static final Base64.Decoder UNB64 = Base64.getUrlDecoder();
    /** SubjectPublicKeyInfo prefixes for a raw 32-byte key (RFC 8410). */
    private static final byte[] ED25519_SPKI = HEX.parseHex("302a300506032b6570032100");
    private static final byte[] X25519_SPKI = HEX.parseHex("302a300506032b656e032100");
    static final Pattern DESK_ID = Pattern.compile("[a-z0-9-]{1,64}");
    private static final Set<String> FIELDS = Set.of("v", "deskId", "sigPriv", "boxPriv", "sigPub", "boxPub");

    /**
     * A desk's public keys, as an offer or an accept carries them and the other desk pins them.
     *
     * @param sig the Ed25519 public key, 32 bytes
     * @param box the X25519 public key, 32 bytes
     * @param binding the signing key's signature of the box key, bound to the desk's id
     */
    public record Pub(String deskId, byte[] sig, byte[] box, byte[] binding) {
        public Pub {
            Objects.requireNonNull(deskId, "deskId");
            sig = sig.clone();
            box = box.clone();
            binding = binding.clone();
        }

        public PublicKey sigKey() throws GeneralSecurityException {
            return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(Hpke.concat(ED25519_SPKI, sig)));
        }

        public PublicKey boxKey() throws GeneralSecurityException {
            return KeyFactory.getInstance("X25519").generatePublic(new X509EncodedKeySpec(Hpke.concat(X25519_SPKI, box)));
        }

        /** Whether the box key is the one this desk's signing key signed for this desk. */
        public boolean bindingValid() {
            try {
                return sig.length == 32 && box.length == 32 && verify(sigKey(), bindingMessage(deskId, box), binding);
            } catch (GeneralSecurityException | RuntimeException e) {
                return false;
            }
        }

        public boolean sameAs(Pub other) {
            return other != null && deskId.equals(other.deskId) && Arrays.equals(sig, other.sig)
                    && Arrays.equals(box, other.box);
        }

        /** 128 bits of SHA-256 over the desk's id and both keys, in 8 groups of 4 hex, for a person to compare. */
        public String fingerprint() {
            try {
                MessageDigest d = MessageDigest.getInstance("SHA-256");
                d.update(("ma-desk-key/v1\n" + deskId + "\n").getBytes(StandardCharsets.UTF_8));
                d.update(sig);
                d.update(box);
                String h = HEX.formatHex(Arrays.copyOf(d.digest(), 16));
                StringBuilder b = new StringBuilder();
                for (int i = 0; i < h.length(); i += 4) {
                    b.append(i == 0 ? "" : "-").append(h, i, i + 4);
                }
                return b.toString();
            } catch (GeneralSecurityException e) {
                throw new IllegalStateException(e);
            }
        }

        /** {@code {sig, box, binding}}, base64url: what a payload's {@code keys} holds. */
        public Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("sig", B64.encodeToString(sig));
            out.put("box", B64.encodeToString(box));
            out.put("binding", B64.encodeToString(binding));
            return out;
        }

        /** A payload's {@code keys} for this desk, or null for one that isn't whole or whose binding fails. */
        public static Pub fromJson(String deskId, Object value) {
            if (deskId == null || !(value instanceof Map<?, ?> m) || !(m.get("sig") instanceof String s)
                    || !(m.get("box") instanceof String b) || !(m.get("binding") instanceof String bind)
                    || m.size() != 3) {
                return null;
            }
            try {
                Pub pub = new Pub(deskId, UNB64.decode(s), UNB64.decode(b), UNB64.decode(bind));
                return pub.bindingValid() ? pub : null;
            } catch (IllegalArgumentException e) {
                return null;
            }
        }

        /** No keys in logs. */
        @Override
        public String toString() {
            return "Pub[" + deskId + "]";
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Pub p && sameAs(p) && Arrays.equals(binding, p.binding);
        }

        @Override
        public int hashCode() {
            return Objects.hash(deskId, Arrays.hashCode(sig), Arrays.hashCode(box));
        }
    }

    private final String deskId;
    private final PrivateKey sigPriv;
    private final PrivateKey boxPriv;
    private final Pub pub;

    private DeskKeys(String deskId, PrivateKey sigPriv, PrivateKey boxPriv, byte[] sigPub, byte[] boxPub)
            throws GeneralSecurityException {
        this.deskId = deskId;
        this.sigPriv = sigPriv;
        this.boxPriv = boxPriv;
        this.pub = new Pub(deskId, sigPub, boxPub, sign(sigPriv, bindingMessage(deskId, boxPub)));
    }

    /** New keys in memory only: a test's desk, or one whose data directory isn't known yet. */
    public static DeskKeys fresh(String deskId) {
        try {
            KeyPair s = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
            KeyPair b = KeyPairGenerator.getInstance("X25519").generateKeyPair();
            return new DeskKeys(deskId, s.getPrivate(), b.getPrivate(), raw(s.getPublic()), raw(b.getPublic()));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("the JDK has no Ed25519 or X25519", e);
        }
    }

    /**
     * This desk's keys from {@code dir}, made and kept there the first time.
     *
     * @throws IOException when they can't be read or kept: nothing is signed or sealed then
     */
    public static DeskKeys loadOrCreate(Path dir, String deskId) throws IOException {
        if (deskId == null || !DESK_ID.matcher(deskId).matches()) {
            throw new IOException("no desk id");
        }
        Path file = dir.resolve(FILE);
        if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            DeskKeys read = read(file, deskId);
            if (read != null) {
                return read;
            }
            setAside(file);
        }
        DeskKeys made = fresh(deskId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("v", 1);
        body.put("deskId", deskId);
        body.put("sigPriv", B64.encodeToString(made.sigPriv.getEncoded()));
        body.put("boxPriv", B64.encodeToString(made.boxPriv.getEncoded()));
        body.put("sigPub", B64.encodeToString(made.pub.sig()));
        body.put("boxPub", B64.encodeToString(made.pub.box()));
        writePrivate(file, Json.bytes(body));
        return made;
    }

    private static DeskKeys read(Path file, String deskId) {
        try {
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > 8192) {
                return null;
            }
            Map<String, Object> m = Json.parseObject(Files.readAllBytes(file));
            if (!m.keySet().equals(FIELDS) || !Envelope.one(m.get("v")) || !deskId.equals(m.get("deskId"))) {
                return null;
            }
            PrivateKey s = KeyFactory.getInstance("Ed25519").generatePrivate(
                    new PKCS8EncodedKeySpec(UNB64.decode(Json.string(m, "sigPriv"))));
            PrivateKey b = KeyFactory.getInstance("X25519").generatePrivate(
                    new PKCS8EncodedKeySpec(UNB64.decode(Json.string(m, "boxPriv"))));
            DeskKeys keys = new DeskKeys(deskId, s, b, UNB64.decode(Json.string(m, "sigPub")),
                    UNB64.decode(Json.string(m, "boxPub")));
            // The public halves must be the private ones': a sealed test message and a signature both ways.
            byte[] probe = "ma-desk-key/v1 probe".getBytes(StandardCharsets.UTF_8);
            if (!verify(keys.pub.sigKey(), probe, keys.sign(probe))) {
                return null;
            }
            Hpke.Sealed sealed = Hpke.seal(keys.pub.boxKey(), probe, probe, probe);
            if (!Arrays.equals(probe, Hpke.open(keys.boxPriv, sealed.enc(), probe, probe, sealed.ct()))) {
                return null;
            }
            return keys;
        } catch (IOException | JsonFormatException | GeneralSecurityException | RuntimeException e) {
            log.warn("this desk's message keys didn't read back ({}), so new ones are made", e.getClass().getSimpleName());
            return null;
        }
    }

    private static void setAside(Path file) {
        try {
            Files.move(file, file.resolveSibling(FILE + ".bad"), StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            try {
                Files.deleteIfExists(file);
            } catch (IOException again) {
                // The write below replaces it.
            }
        }
    }

    public String deskId() {
        return deskId;
    }

    public Pub pub() {
        return pub;
    }

    /** This desk's Ed25519 signature of {@code data}. */
    public byte[] sign(byte[] data) throws GeneralSecurityException {
        return sign(sigPriv, data);
    }

    PrivateKey boxPrivate() {
        return boxPriv;
    }

    static byte[] raw(PublicKey k) {
        byte[] enc = k.getEncoded();
        return Arrays.copyOfRange(enc, enc.length - 32, enc.length);
    }

    static byte[] bindingMessage(String deskId, byte[] box) {
        return ("ma-desk-key/v1 box\n" + deskId + "\n" + B64.encodeToString(box)).getBytes(StandardCharsets.UTF_8);
    }

    static byte[] sign(PrivateKey k, byte[] data) throws GeneralSecurityException {
        Signature s = Signature.getInstance("Ed25519");
        s.initSign(k);
        s.update(data);
        return s.sign();
    }

    static boolean verify(PublicKey k, byte[] data, byte[] sig) throws GeneralSecurityException {
        if (sig == null || sig.length != 64) {
            return false;
        }
        Signature s = Signature.getInstance("Ed25519");
        s.initVerify(k);
        s.update(data);
        return s.verify(sig);
    }

    /** Written whole, 0600 from its creation: a temporary file, an fsync, a rename and the directory's fsync. */
    static void writePrivate(Path file, byte[] bytes) throws IOException {
        Path temporary = file.resolveSibling(file.getFileName() + ".tmp");
        Files.deleteIfExists(temporary);
        try {
            Set<StandardOpenOption> options = Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
            FileChannel opened;
            try {
                opened = FileChannel.open(temporary, options,
                        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            } catch (UnsupportedOperationException e) {
                opened = FileChannel.open(temporary, options); // not a POSIX file system: only in a test
            }
            try (FileChannel channel = opened) {
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE);
            try (FileChannel directory = FileChannel.open(file.getParent(), StandardOpenOption.READ)) {
                directory.force(true);
            } catch (IOException e) {
                // Some file systems can't open a directory to sync it; the rename is still atomic.
            }
        } finally {
            Arrays.fill(bytes, (byte) 0);
            Files.deleteIfExists(temporary);
        }
    }
}
