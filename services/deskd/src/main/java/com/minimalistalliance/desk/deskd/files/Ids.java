package com.minimalistalliance.desk.deskd.files;

import java.security.SecureRandom;
import java.util.regex.Pattern;

/** 26-character ids of {@code [0-9A-Z]}, time-ordered (ULID layout): trash ids and upload ids. */
final class Ids {

    private static final char[] ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();
    static final Pattern PATTERN = Pattern.compile("[0-9A-Za-z]{26}");

    private Ids() {}

    static String next(long timeMs) {
        char[] out = new char[26];
        long time = timeMs & ((1L << 48) - 1);
        for (int i = 9; i >= 0; i--) {
            out[i] = ALPHABET[(int) (time & 31)];
            time >>>= 5;
        }
        byte[] random = new byte[10];
        RANDOM.nextBytes(random);
        long hi = 0;
        for (int i = 0; i < 5; i++) {
            hi = (hi << 8) | (random[i] & 0xFF);
        }
        long lo = 0;
        for (int i = 5; i < 10; i++) {
            lo = (lo << 8) | (random[i] & 0xFF);
        }
        for (int i = 17; i >= 10; i--) {
            out[i] = ALPHABET[(int) (hi & 31)];
            hi >>>= 5;
        }
        for (int i = 25; i >= 18; i--) {
            out[i] = ALPHABET[(int) (lo & 31)];
            lo >>>= 5;
        }
        return new String(out);
    }

    static boolean valid(Object value) {
        return value instanceof String s && PATTERN.matcher(s).matches();
    }
}
