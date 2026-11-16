package com.minimalistalliance.desk.deskd.docs;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.Locale;

/**
 * Near copies (deskd {@code API.md} §25 "Copies and versions"): a 64-bit simhash over three-word shingles of the
 * normalised text. Two documents within {@link #NEAR} bits, each with at least {@link #MIN_CHARS} characters, are asked
 * about once ("This looks like…"); nothing is stacked or deleted on its strength alone.
 */
final class SimHash {

    static final int NEAR = 3;
    static final int MIN_CHARS = 400;

    private SimHash() {}

    static String normal(String text) {
        return Normalizer.normalize(text, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]+", " ").strip();
    }

    /** The hash, or null for text too short to judge. */
    static Long of(String text) {
        if (text == null) {
            return null;
        }
        String n = normal(text);
        if (n.length() < MIN_CHARS) {
            return null;
        }
        String[] w = n.split(" ");
        int[] v = new int[64];
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        int count = 0;
        for (int i = 0; i + 2 < w.length && count < 50_000; i++, count++) {
            byte[] d = md.digest((w[i] + ' ' + w[i + 1] + ' ' + w[i + 2]).getBytes(StandardCharsets.UTF_8));
            long h = 0;
            for (int k = 0; k < 8; k++) {
                h = (h << 8) | (d[k] & 0xFF);
            }
            for (int b = 0; b < 64; b++) {
                v[b] += ((h >>> b) & 1L) == 1L ? 1 : -1;
            }
        }
        long out = 0;
        for (int b = 0; b < 64; b++) {
            if (v[b] > 0) {
                out |= 1L << b;
            }
        }
        return out;
    }

    static int distance(long a, long b) {
        return Long.bitCount(a ^ b);
    }
}
