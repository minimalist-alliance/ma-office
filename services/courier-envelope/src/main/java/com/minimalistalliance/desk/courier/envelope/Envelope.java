package com.minimalistalliance.desk.courier.envelope;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.bouncycastle.crypto.InvalidCipherTextException;
import org.bouncycastle.crypto.hpke.HPKE;
import org.bouncycastle.crypto.hpke.HPKEContext;
import org.bouncycastle.crypto.hpke.HPKEContextWithEncapsulation;

/**
 * The relay's envelope (contract 0.4.0 §2.2): one HPKE seal of a padded plaintext to the recipient's box key. HPKE is RFC
 * 9180 base mode with DHKEM(X25519, HKDF-SHA256) {@code 0x0020}, HKDF-SHA256 {@code 0x0001} and ChaCha20-Poly1305
 * {@code 0x0003}, all from Bouncy Castle; this class only builds {@code info}, {@code aad} and the padding.
 *
 * <pre>
 * info = "ma-courier/v1 " + kind
 * aad  = "ma-courier/v1 env\n" + kind + "\n" + to            to: the recipient's canonical address
 * pt   = plaintext || 0x80 || 0x00... to a bucket           ({@link Padding})
 * enc, ct = HPKE.Seal(boxKey, info, aad, pt)                 len(ct) - 16 is a bucket; the relay refuses anything else
 * </pre>
 *
 * The outer shape the relay carries is {@code {kind, to, enc, ct, drops?}} ({@link Sealed#toJson}). What the plaintext
 * is depends on the kind: {@link Signed} for {@code ma} (and, as proposed, for the mail door's {@code mail}).
 *
 * <p>Opening: the recipient's canonical address is in {@code aad}, and envelopes don't say which box key they were sealed
 * to, so a desk tries its current address and key first, then its closed addresses (newest first: a sender may have
 * looked it up before a rename) and the retired box keys it still keeps.
 */
public final class Envelope {

    public static final String MA = "ma";
    public static final String MAIL = "mail";
    public static final int ENC_BYTES = 32;
    public static final int TAG_BYTES = 16;
    /** The largest {@code ct}: the largest bucket plus the tag (the relay's {@code too_large} line). */
    public static final int MAX_CT = Padding.MAX_ENVELOPE + TAG_BYTES;

    static final Pattern KIND = Pattern.compile("[a-z]{1,16}");
    static final int MAX_ADDRESS = 320;

    /** A sealed envelope, as the relay's {@code send} takes it and its {@code GET /v1/agent/relay} returns it. */
    public record Sealed(String kind, String to, byte[] enc, byte[] ct) {
        public Sealed {
            enc = enc.clone();
            ct = ct.clone();
        }

        @Override
        public byte[] enc() {
            return enc.clone();
        }

        @Override
        public byte[] ct() {
            return ct.clone();
        }

        /** {@code {to, kind, enc, ct}} for {@code POST /v1/agent/relay/send}; the transport adds {@code drops}. */
        public Map<String, Object> toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("to", to);
            m.put("kind", kind);
            m.put("enc", B64.encode(enc));
            m.put("ct", B64.encode(ct));
            return m;
        }

        /**
         * Reads {@code kind}, {@code to}, {@code enc} and {@code ct} from a relay answer's envelope; its other fields
         * ({@code id}, {@code receivedAt}, {@code expiresAt}, {@code drops}) are the transport's.
         */
        public static Sealed fromJson(Map<String, Object> m) throws EnvelopeException {
            if (m == null) {
                throw new EnvelopeException(EnvelopeException.FORMAT, "no envelope");
            }
            String kind = Json.string(m.get("kind"), 16);
            String to = Json.string(m.get("to"), MAX_ADDRESS);
            if (!KIND.matcher(kind).matches()) {
                throw new EnvelopeException(EnvelopeException.FORMAT, "an unknown kind");
            }
            byte[] ct = B64.decodeUpTo(m.get("ct"), MAX_CT);
            return new Sealed(kind, to, B64.decode(m.get("enc"), ENC_BYTES), ct);
        }
    }

    /** What a desk opens with. */
    public interface Recipient {
        /** Its canonical addresses: the open one first, then the closed ones, newest first. */
        List<String> addresses();

        /** Its box key pairs: the current one first, then the retired ones it still keeps, newest first. */
        List<BoxKeyPair> boxKeys();
    }

    /** What opened: the plaintext, and which of the recipient's addresses and box keys opened it. */
    public record Opened(byte[] plaintext, String address, BoxKeyPair boxKey) {}

    private Envelope() {}

    static HPKE hpke() {
        return new HPKE(HPKE.mode_base, HPKE.kem_X25519_SHA256, HPKE.kdf_HKDF_SHA256, HPKE.aead_CHACHA20_POLY1305);
    }

    static byte[] info(String kind) {
        return ("ma-courier/v1 " + kind).getBytes(StandardCharsets.UTF_8);
    }

    static byte[] aad(String kind, String to) {
        return ("ma-courier/v1 env\n" + kind + "\n" + to).getBytes(StandardCharsets.UTF_8);
    }

    /**
     * A canonical Courier address (contract 0.4.0 §1): a name of 3 to 32 of {@code a-z 0-9 . -}, starting and ending with a
     * letter or digit, with no two separators in a row; an {@code @}; and a lower-case DNS domain. No {@code +tag}.
     */
    static final Pattern ADDRESS = Pattern.compile(
            "[a-z0-9](?:[a-z0-9]|[.-](?=[a-z0-9])){1,30}[a-z0-9]@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}");

    static void checkKindAndAddress(String kind, String to) throws EnvelopeException {
        if (kind == null || !KIND.matcher(kind).matches()) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "an unknown kind");
        }
        Json.string(to, MAX_ADDRESS);
        if (!ADDRESS.matcher(to).matches()) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not a canonical address");
        }
    }

    /** Seals {@code plaintext} to {@code to}'s box key. */
    public static Sealed seal(String kind, String to, BoxKey boxKey, byte[] plaintext) throws EnvelopeException {
        return seal(kind, to, boxKey, plaintext, null);
    }

    /** {@code ikmE} fixes HPKE's ephemeral key (RFC 9180 DeriveKeyPair), for published test vectors only. */
    static Sealed seal(String kind, String to, BoxKey boxKey, byte[] plaintext, byte[] ikmE) throws EnvelopeException {
        checkKindAndAddress(kind, to);
        byte[] padded = Padding.pad(plaintext);
        try {
            HPKE hpke = hpke();
            HPKEContextWithEncapsulation ctx = ikmE == null
                    ? hpke.setupBaseS(hpke.deserializePublicKey(boxKey.bytes()), info(kind))
                    : hpke.setupBaseS(hpke.deserializePublicKey(boxKey.bytes()), info(kind), hpke.deriveKeyPair(ikmE));
            byte[] ct = ctx.seal(aad(kind, to), padded);
            return new Sealed(kind, to, ctx.getEncapsulation(), ct);
        } catch (InvalidCipherTextException e) {
            throw new IllegalStateException("ChaCha20-Poly1305 refused to seal", e);
        } catch (RuntimeException e) {
            throw new EnvelopeException(EnvelopeException.RECIPIENT_KEY, "HPKE couldn't seal to that box key");
        } finally {
            java.util.Arrays.fill(padded, (byte) 0);
        }
    }

    /**
     * Opens an envelope of {@code kind}, trying each of the recipient's addresses with each of its box keys.
     *
     * @throws EnvelopeException {@code format} for a bad shape or padding, {@code cannot_open} when no address and key
     *     opens it (changed, sealed to someone else, or to a box key this desk no longer keeps)
     */
    public static Opened open(String kind, Recipient me, byte[] enc, byte[] ct) throws EnvelopeException {
        if (kind == null || !KIND.matcher(kind).matches() || enc == null || enc.length != ENC_BYTES || ct == null
                || ct.length > MAX_CT || !Padding.isEnvelopeBucket(ct.length - TAG_BYTES)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not an envelope's shape");
        }
        HPKE hpke = hpke();
        byte[] info = info(kind);
        for (BoxKeyPair key : me.boxKeys()) {
            HPKEContext ctx;
            try {
                ctx = hpke.setupBaseR(enc, key.forHpke(), info);
            } catch (RuntimeException e) {
                // Bouncy Castle refuses an enc that gives an all-zero shared secret (RFC 9180 §7.1.4) by throwing.
                throw new EnvelopeException(EnvelopeException.CANNOT_OPEN, "HPKE refused the encapsulated key");
            }
            for (String address : me.addresses()) {
                byte[] padded;
                try {
                    // A fresh context for each try, so a failed open never moves a sequence number on.
                    padded = (ctx == null ? hpke.setupBaseR(enc, key.forHpke(), info) : ctx).open(aad(kind, address), ct);
                } catch (InvalidCipherTextException e) {
                    ctx = null;
                    continue;
                }
                try {
                    return new Opened(Padding.unpad(padded), address, key);
                } finally {
                    java.util.Arrays.fill(padded, (byte) 0);
                }
            }
        }
        throw new EnvelopeException(EnvelopeException.CANNOT_OPEN, "no address and box key of this desk opens it");
    }
}
