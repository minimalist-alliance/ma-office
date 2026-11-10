package com.minimalistalliance.desk.deskd.session;

import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Locale;

/**
 * The offer check of desk-runtime.md 4.4: every {@code a=fingerprint} line must be SHA-256 and equal
 * the token's. Chrome writes one per section and Firefox one at session level, so any number of lines
 * is fine, but there must be at least one. Bytes are compared, never strings, because SDP uses
 * colon-separated hex.
 */
final class SdpFingerprints {

    private static final String PREFIX = "a=fingerprint:";
    private static final int SHA256_BYTES = 32;

    private SdpFingerprints() {}

    /** @param expectedHex 64 lowercase hex chars */
    static boolean offerMatches(String sdp, String expectedHex) {
        byte[] expected;
        try {
            expected = HexFormat.of().parseHex(expectedHex);
        } catch (IllegalArgumentException e) {
            return false;
        }
        boolean found = false;
        for (String line : sdp.split("\r?\n")) {
            if (!line.regionMatches(true, 0, PREFIX, 0, PREFIX.length())) {
                continue;
            }
            String[] parts = line.substring(PREFIX.length()).trim().split("\\s+");
            if (parts.length != 2 || !parts[0].equalsIgnoreCase("sha-256")) {
                return false;
            }
            byte[] actual;
            try {
                actual = HexFormat.ofDelimiter(":").parseHex(parts[1].toLowerCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                return false;
            }
            if (actual.length != SHA256_BYTES || !MessageDigest.isEqual(actual, expected)) {
                return false;
            }
            found = true;
        }
        return found;
    }
}
