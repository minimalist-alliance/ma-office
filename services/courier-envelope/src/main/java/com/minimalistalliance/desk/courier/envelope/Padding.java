package com.minimalistalliance.desk.courier.envelope;

import java.util.Arrays;

/**
 * Sizes on the wire (contract 0.4.0 §2.2 and §2.3; the task 08 spike's Q-C7), so a message's size says little about its
 * length.
 *
 * <ul>
 *   <li><b>An envelope's plaintext</b> gets one {@code 0x80} byte, then {@code 0x00} bytes up to the smallest bucket that
 *       holds both: 256, 512, ... 4,096 (steps of 256), then 8,192, 16,384, 32,768 and 65,536. So {@code len(ct) - 16} is
 *       always a bucket, and the relay refuses anything else ({@code unpadded}).
 *   <li><b>A drop</b> (a body too big for an envelope) is padded to a power of two from 64 KiB to 64 MiB.
 * </ul>
 */
public final class Padding {

    /** The largest padded envelope plaintext. */
    public static final int MAX_ENVELOPE = 64 * 1024;
    public static final long MIN_DROP = 64 * 1024;
    public static final long MAX_DROP = 64L * 1024 * 1024;

    private static final int STEP = 256;
    private static final int LINEAR_UNTIL = 4096;

    private Padding() {}

    /** The bucket for a plaintext of {@code length} bytes (its {@code 0x80} included), or -1 if it can't be one. */
    public static int envelopeBucket(int length) {
        int needed = length + 1;
        if (length < 0 || needed > MAX_ENVELOPE) {
            return -1;
        }
        if (needed <= LINEAR_UNTIL) {
            return (needed + STEP - 1) / STEP * STEP;
        }
        return Integer.highestOneBit(needed - 1) << 1;
    }

    /** Whether {@code size} is an envelope bucket. */
    public static boolean isEnvelopeBucket(int size) {
        if (size <= 0 || size > MAX_ENVELOPE) {
            return false;
        }
        return size <= LINEAR_UNTIL ? size % STEP == 0 : Integer.bitCount(size) == 1;
    }

    /** {@code plaintext || 0x80 || 0x00...} to its bucket. */
    static byte[] pad(byte[] plaintext) throws EnvelopeException {
        int bucket = envelopeBucket(plaintext.length);
        if (bucket < 0) {
            throw new EnvelopeException(EnvelopeException.TOO_LARGE, "the plaintext doesn't fit in an envelope");
        }
        byte[] padded = Arrays.copyOf(plaintext, bucket);
        padded[plaintext.length] = (byte) 0x80;
        return padded;
    }

    /** Strips the zeros and the {@code 0x80}; the input must be a whole bucket. */
    static byte[] unpad(byte[] padded) throws EnvelopeException {
        if (!isEnvelopeBucket(padded.length)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not a bucket's size");
        }
        int i = padded.length - 1;
        while (i >= 0 && padded[i] == 0) {
            i--;
        }
        if (i < 0 || padded[i] != (byte) 0x80) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "the padding isn't 0x80 then zeros");
        }
        // The shortest padding: a plaintext that would fit a smaller bucket was padded too far.
        if (envelopeBucket(i) != padded.length) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "padded past its bucket");
        }
        return Arrays.copyOf(padded, i);
    }

    /** The drop bucket for {@code length} bytes of ciphertext, or -1 past 64 MiB. */
    public static long dropBucket(long length) {
        if (length < 0 || length > MAX_DROP) {
            return -1;
        }
        long b = MIN_DROP;
        while (b < length) {
            b <<= 1;
        }
        return b;
    }

    public static boolean isDropBucket(long size) {
        return size >= MIN_DROP && size <= MAX_DROP && Long.bitCount(size) == 1;
    }
}
