package com.minimalistalliance.desk.courier.envelope;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.bouncycastle.crypto.InvalidCipherTextException;
import org.bouncycastle.crypto.hpke.AEAD;
import org.bouncycastle.crypto.hpke.HPKE;

/**
 * A body too big for an envelope, in the platform's ciphertext drop (contract 0.4.0 §2.3: "the sender makes a random
 * content key, encrypts the body itself (chunked AEAD ...; Desk-owned), uploads the ciphertext as one or more drops, and
 * puts the content key and the drop ids inside the envelope's sealed payload").
 *
 * <p>The content key is 44 random bytes: a ChaCha20-Poly1305 key (32) and a base nonce (12), used for this one body. The
 * body is cut into 64 KiB chunks, each sealed by Bouncy Castle's HPKE AEAD context ({@link AEAD}: RFC 9180 §5.2's
 * nonce, {@code base_nonce XOR seq}, and its sequence counter) with
 * {@code aad = "ma-courier/v1 drop\n" || u64be index || last (0 or 1)}. The drop is the sealed chunks, then zeros up to its
 * bucket ({@link Padding#dropBucket}). The reference that goes in the signed payload,
 * {@code {"id","key","len","sha256","bytes"}}, gives the body's length and SHA-256, so a drop that's cut, grown, reordered
 * or swapped for another fails, and the sender's signature covers the body too.
 */
public final class Drop {

    public static final int CHUNK = 64 * 1024;
    /** The largest body in one drop: the store keeps raw mail up to 48 MiB. */
    public static final long MAX_BODY = 48L * 1024 * 1024;
    static final int KEY_BYTES = 32 + 12;
    private static final byte[] AAD = "ma-courier/v1 drop\n".getBytes(StandardCharsets.US_ASCII);
    private static final Set<String> FIELDS = Set.of("id", "key", "len", "sha256", "bytes");
    private static final java.util.regex.Pattern DROP_ID = java.util.regex.Pattern.compile("dr-[0-9A-HJKMNP-TV-Z]{26}");
    private static final SecureRandom RANDOM = new SecureRandom();

    private Drop() {}

    /** The sealed size of a body: each chunk's bytes plus its 16-byte tag. */
    public static long ciphertextLength(long bodyLength) {
        long chunks = Math.max(1, (bodyLength + CHUNK - 1) / CHUNK);
        return bodyLength + chunks * Envelope.TAG_BYTES;
    }

    static byte[] aad(long index, boolean last) {
        return ByteBuffer.allocate(AAD.length + 9).put(AAD).putLong(index).put((byte) (last ? 1 : 0)).array();
    }

    private static AEAD aead(byte[] key) {
        return new AEAD(HPKE.aead_CHACHA20_POLY1305, Arrays.copyOf(key, 32), Arrays.copyOfRange(key, 32, KEY_BYTES));
    }

    /** Seals one body: digest it, reserve {@link #bucket()} bytes of drop, {@link #write} it, then put {@link #reference} in the payload. */
    public static final class Sealer {
        private final BodySource body;
        private final long length;
        private final byte[] sha256;
        private final byte[] key;
        private boolean written;

        private Sealer(BodySource body, long length, byte[] sha256, byte[] key) {
            this.body = body;
            this.length = length;
            this.sha256 = sha256;
            this.key = key;
        }

        public long bodyLength() {
            return length;
        }

        /** The drop's size: what {@code POST /v1/agent/relay/drops} reserves. */
        public long bucket() {
            return Padding.dropBucket(ciphertextLength(length));
        }

        /**
         * Writes the drop: every chunk sealed, in order, then zeros to the bucket. Once only.
         *
         * @throws IOException if the source's bytes aren't the ones digested (the output is then useless), or the output fails
         */
        public synchronized void write(OutputStream out) throws IOException {
            if (written) {
                throw new IllegalStateException("a drop is written once");
            }
            written = true;
            AEAD aead = aead(key);
            MessageDigest d = sha256();
            long chunks = Math.max(1, (length + CHUNK - 1) / CHUNK);
            long left = length;
            try (InputStream in = body.open()) {
                for (long i = 0; i < chunks; i++) {
                    int size = (int) Math.min(CHUNK, left);
                    byte[] chunk = in.readNBytes(size);
                    if (chunk.length != size) {
                        throw new IOException("the body's source ended early");
                    }
                    d.update(chunk);
                    left -= size;
                    try {
                        out.write(aead.seal(aad(i, i == chunks - 1), chunk));
                    } catch (InvalidCipherTextException e) {
                        throw new IllegalStateException("ChaCha20-Poly1305 refused to seal", e);
                    } finally {
                        Arrays.fill(chunk, (byte) 0);
                    }
                }
                if (in.read() >= 0) {
                    throw new IOException("the body's source grew after it was digested");
                }
            }
            if (!MessageDigest.isEqual(d.digest(), sha256)) {
                throw new IOException("the body's source changed after it was digested");
            }
            byte[] zeros = new byte[CHUNK];
            for (long pad = bucket() - ciphertextLength(length); pad > 0; pad -= zeros.length) {
                out.write(zeros, 0, (int) Math.min(zeros.length, pad));
            }
        }

        /** What goes in the signed payload (as {@code drop}, say) once the platform gave the drop its id. */
        public Map<String, Object> reference(String dropId) {
            if (dropId == null || !DROP_ID.matcher(dropId).matches()) {
                throw new IllegalArgumentException("not a drop id");
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", dropId);
            m.put("key", B64.encode(key));
            m.put("len", length);
            m.put("sha256", B64.encode(sha256));
            m.put("bytes", bucket());
            return m;
        }
    }

    /**
     * Prepares a body for the drop, digesting it once.
     *
     * @throws EnvelopeException {@code too_large} past {@link #MAX_BODY}; an empty body has no drop ({@code format})
     */
    public static Sealer sealer(BodySource body) throws EnvelopeException, IOException {
        byte[] key = new byte[KEY_BYTES];
        RANDOM.nextBytes(key);
        return sealer(body, key);
    }

    /** With a fixed content key, for published test vectors only. */
    static Sealer sealer(BodySource body, byte[] key) throws EnvelopeException, IOException {
        long length = body.length();
        if (length > MAX_BODY) {
            throw new EnvelopeException(EnvelopeException.TOO_LARGE, "the body is over the drop's limit");
        }
        if (length <= 0) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "an empty body needs no drop");
        }
        MessageDigest d = sha256();
        long seen = 0;
        byte[] buffer = new byte[CHUNK];
        try (InputStream in = body.open()) {
            for (int n; (n = in.read(buffer)) > 0 && seen <= length; ) {
                d.update(buffer, 0, n);
                seen += n;
            }
        }
        if (seen != length) {
            throw new IOException("the body's source didn't give its length");
        }
        return new Sealer(body, length, d.digest(), key.clone());
    }

    /**
     * Reads and checks a drop against its reference from a verified payload, writing the body to {@code out} as it goes.
     * Write it somewhere staged: nothing written may be used unless this returns, as only then is the whole body proven.
     *
     * @param bytes the drop's size as the relay gave it ({@code drops[].bytes})
     * @throws EnvelopeException {@code format} for a bad reference or sizes that don't agree, {@code truncated} for a drop
     *     that ends early or runs long, {@code cannot_open} for a chunk that doesn't open (changed, reordered, another
     *     body's), {@code body_mismatch} for a body whose SHA-256 isn't the signed one
     */
    public static void open(Map<String, Object> reference, long bytes, InputStream in, OutputStream out) throws EnvelopeException, IOException {
        if (reference == null || !reference.keySet().equals(FIELDS) || !(reference.get("id") instanceof String id)
                || !DROP_ID.matcher(id).matches()) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not a drop reference");
        }
        byte[] key = B64.decode(reference.get("key"), KEY_BYTES);
        long length = Json.longValue(reference.get("len"));
        byte[] sha = B64.decode(reference.get("sha256"), 32);
        long declared = Json.longValue(reference.get("bytes"));
        if (length <= 0 || length > MAX_BODY || declared != Padding.dropBucket(ciphertextLength(length)) || bytes != declared) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "the drop's sizes don't agree");
        }
        AEAD aead = aead(key);
        Arrays.fill(key, (byte) 0);
        MessageDigest d = sha256();
        long chunks = Math.max(1, (length + CHUNK - 1) / CHUNK);
        long left = length;
        for (long i = 0; i < chunks; i++) {
            int size = (int) Math.min(CHUNK, left);
            byte[] sealed = in.readNBytes(size + Envelope.TAG_BYTES);
            if (sealed.length != size + Envelope.TAG_BYTES) {
                throw new EnvelopeException(EnvelopeException.TRUNCATED, "the drop ended early");
            }
            byte[] plain;
            try {
                plain = aead.open(aad(i, i == chunks - 1), sealed);
            } catch (InvalidCipherTextException | RuntimeException e) {
                throw new EnvelopeException(EnvelopeException.CANNOT_OPEN, "a drop chunk didn't open");
            }
            d.update(plain);
            out.write(plain);
            Arrays.fill(plain, (byte) 0);
            left -= size;
        }
        long pad = declared - ciphertextLength(length);
        byte[] skip = new byte[CHUNK];
        while (pad > 0) {
            int n = in.read(skip, 0, (int) Math.min(skip.length, pad));
            if (n < 0) {
                throw new EnvelopeException(EnvelopeException.TRUNCATED, "the drop's padding ended early");
            }
            pad -= n;
        }
        if (in.read() >= 0) {
            throw new EnvelopeException(EnvelopeException.TRUNCATED, "the drop runs past its size");
        }
        if (!MessageDigest.isEqual(d.digest(), sha)) {
            throw new EnvelopeException(EnvelopeException.BODY_MISMATCH, "the drop's body isn't the one signed");
        }
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
