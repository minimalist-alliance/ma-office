package com.minimalistalliance.desk.courier.envelope;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * The number two members compare, in person or on a call, to rule out anyone in the middle, the platform included (the
 * spike's Q-C2 copy: "Check a contact's safety number to rule out MA itself"). It's Signal's displayable fingerprint
 * construction, unchanged but for the key and the identifier: for each desk, SHA-512 iterated 5,200 times over a version,
 * its identity key and a fixed identifier, the first 30 bytes read as six 5-digit groups; the two desks' 30 digits are
 * put in a fixed order, so both see the same 60 digits. Iteration only slows a search for a key whose number collides.
 *
 * <p>It depends only on the two identity keys, so it stays the same when either desk's box key rotates, and changes when
 * either identity does. (Contract 0.4.0 §2.1 says the safety number is built from its {@code fingerprint}, which covers
 * the box key too; that would change every contact's number at each rotation. The number is computed only on desks, so
 * this is the Desk side's to choose; draft ADR "Courier's envelopes" asks Platform to change the sentence.)
 */
public final class SafetyNumber {

    static final int ITERATIONS = 5200;
    private static final byte[] VERSION = {0, 0};
    private static final byte[] IDENTIFIER = "ma-desk".getBytes(StandardCharsets.US_ASCII);

    private SafetyNumber() {}

    /** The 60 digits for two desks, as 12 groups of 5 separated by spaces. Symmetric: either side gets the same. */
    public static String between(IdentityKey a, IdentityKey b) {
        String da = digits(a);
        String db = digits(b);
        String joined = da.compareTo(db) <= 0 ? da + db : db + da;
        StringBuilder out = new StringBuilder(71);
        for (int i = 0; i < joined.length(); i += 5) {
            if (i > 0) {
                out.append(' ');
            }
            out.append(joined, i, i + 5);
        }
        return out.toString();
    }

    /** One desk's 30 digits. */
    static String digits(IdentityKey key) {
        byte[] k = key.bytes();
        byte[] hash = new byte[VERSION.length + k.length + IDENTIFIER.length];
        System.arraycopy(VERSION, 0, hash, 0, VERSION.length);
        System.arraycopy(k, 0, hash, VERSION.length, k.length);
        System.arraycopy(IDENTIFIER, 0, hash, VERSION.length + k.length, IDENTIFIER.length);
        MessageDigest d;
        try {
            d = MessageDigest.getInstance("SHA-512");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        for (int i = 0; i < ITERATIONS; i++) {
            d.update(hash);
            hash = d.digest(k);
        }
        StringBuilder out = new StringBuilder(30);
        for (int chunk = 0; chunk < 6; chunk++) {
            long v = 0;
            for (int j = 0; j < 5; j++) {
                v = (v << 8) | (hash[chunk * 5 + j] & 0xff);
            }
            out.append(String.format(java.util.Locale.ROOT, "%05d", v % 100_000));
        }
        return out.toString();
    }
}
