package com.minimalistalliance.desk.deskd.desks;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.PublicKey;
import javax.crypto.Cipher;
import javax.crypto.KEM;
import javax.crypto.Mac;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * HPKE (RFC 9180) base mode, single shot, for one suite: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305.
 *
 * <p>The KEM is the JDK's own {@code DHKEM} (JEP 452, Java 21), which is RFC 9180 section 4.1. Only the key schedule
 * (section 5.1) is written here, and {@code HpkeTest} checks it against the RFC's test vector A.2.1. This replaces the
 * design's {@code crypto_box_seal}, which needs libsodium and has no JDK equivalent, with a standard that does.
 *
 * <p>From the chat spike ({@code spikes/chat}, task 08), unchanged but for its visibility: messages between the member's
 * desks (draft ADR "the Agent's tools and approvals", §14) seal with it.
 */
public final class Hpke {
    private static final byte[] SUITE_ID = {'H', 'P', 'K', 'E', 0x00, 0x20, 0x00, 0x01, 0x00, 0x03};
    private static final byte[] VERSION = "HPKE-v1".getBytes(StandardCharsets.US_ASCII);
    private static final int NK = 32;
    private static final int NN = 12;

    public record Sealed(byte[] enc, byte[] ct) {}

    record KeySchedule(byte[] key, byte[] baseNonce) {}

    private Hpke() {}

    public static Sealed seal(PublicKey recipient, byte[] info, byte[] aad, byte[] plaintext) throws GeneralSecurityException {
        KEM.Encapsulated e = KEM.getInstance("DHKEM").newEncapsulator(recipient).encapsulate();
        KeySchedule ks = keySchedule(e.key().getEncoded(), info);
        return new Sealed(e.encapsulation(), aead(Cipher.ENCRYPT_MODE, ks, aad, plaintext));
    }

    public static byte[] open(PrivateKey recipient, byte[] enc, byte[] info, byte[] aad, byte[] ct) throws GeneralSecurityException {
        byte[] shared = KEM.getInstance("DHKEM").newDecapsulator(recipient).decapsulate(enc).getEncoded();
        return aead(Cipher.DECRYPT_MODE, keySchedule(shared, info), aad, ct);
    }

    /** RFC 9180 section 5.1, mode_base: no PSK. */
    static KeySchedule keySchedule(byte[] sharedSecret, byte[] info) throws GeneralSecurityException {
        byte[] pskIdHash = labeledExtract(new byte[0], "psk_id_hash", new byte[0]);
        byte[] infoHash = labeledExtract(new byte[0], "info_hash", info);
        byte[] context = concat(new byte[] {0x00}, pskIdHash, infoHash);
        byte[] secret = labeledExtract(sharedSecret, "secret", new byte[0]);
        return new KeySchedule(labeledExpand(secret, "key", context, NK), labeledExpand(secret, "base_nonce", context, NN));
    }

    private static byte[] aead(int mode, KeySchedule ks, byte[] aad, byte[] in) throws GeneralSecurityException {
        // Single shot: sequence number 0, so the nonce is base_nonce itself. Each message has its own key.
        Cipher c = Cipher.getInstance("ChaCha20-Poly1305");
        c.init(mode, new SecretKeySpec(ks.key(), "ChaCha20"), new IvParameterSpec(ks.baseNonce()));
        c.updateAAD(aad);
        return c.doFinal(in);
    }

    private static byte[] labeledExtract(byte[] salt, String label, byte[] ikm) throws GeneralSecurityException {
        return hmac(salt, concat(VERSION, SUITE_ID, label.getBytes(StandardCharsets.US_ASCII), ikm));
    }

    private static byte[] labeledExpand(byte[] prk, String label, byte[] info, int length) throws GeneralSecurityException {
        byte[] labeled = concat(new byte[] {(byte) (length >> 8), (byte) length}, VERSION, SUITE_ID,
                label.getBytes(StandardCharsets.US_ASCII), info);
        // HKDF-Expand (RFC 5869). Every length here fits in one SHA-256 block.
        byte[] t = hmac(prk, concat(labeled, new byte[] {0x01}));
        byte[] out = new byte[length];
        System.arraycopy(t, 0, out, 0, length);
        return out;
    }

    private static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        // An empty salt is HashLen zero bytes (RFC 5869); HMAC pads keys with zeros, so the two are the same.
        mac.init(new SecretKeySpec(key.length == 0 ? new byte[32] : key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) {
            n += p.length;
        }
        byte[] out = new byte[n];
        int at = 0;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, out, at, p.length);
            at += p.length;
        }
        return out;
    }
}
