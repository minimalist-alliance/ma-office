package com.minimalistalliance.desk.deskd.rtc;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * The clipboard's messages on rtc.sock (desk-rtc/README.md, "The clipboard"), and one request waiting for its answer.
 * Text goes in parts of at most {@link #PART_BYTES}, as base64, and a part can end in the middle of a UTF-8 character,
 * so only the joined bytes are text, and they're the caller's to clean. Nothing here logs a part, its data, its number
 * or how many there were: together they'd say how long the text is.
 */
final class RtcClipboard {

    /** The most text in one part: its base64, with the rest of the JSON, fits one 64 KiB envelope. desk-rtc's ClipPartMax. */
    static final int PART_BYTES = 45 * 1024;
    /** Ids are integers from 0 to 2^53 - 1, so that JavaScript and Go both read them exactly. */
    static final long MAX_ID = (1L << 53) - 1;
    /** desk-rtc's codes. Anything else it sends is taken as internal. */
    static final Set<String> CODES = Set.of("no_display", "timeout", "too_large", "internal");

    private static final Base64.Encoder ENCODER = Base64.getEncoder();
    private static final Base64.Decoder DECODER = Base64.getDecoder();
    private static final byte[] SET_TAIL = "\"}".getBytes(StandardCharsets.US_ASCII);

    private RtcClipboard() {}

    /**
     * One clipboard.set or clipboard.get waiting for its answer. The reader is the only thread that joins parts, and
     * whoever completes {@link #done} first wins, so a second answer for the same id changes nothing.
     */
    static final class Pending {
        final long id;
        final boolean get;
        final int maxBytes;
        /** The connection's count of clipboard messages heard when this went out. */
        final long heardWhenSent;
        /** A set's answer is an empty array. A get's is the joined bytes, or null when the clipboard holds no text. */
        final CompletableFuture<byte[]> done = new CompletableFuture<>();
        private int nextPart;
        private byte[] joined;
        private int size;

        Pending(long id, boolean get, int maxBytes, long heardWhenSent) {
            this.id = id;
            this.get = get;
            this.maxBytes = maxBytes;
            this.heardWhenSent = heardWhenSent;
        }

        /**
         * One message for this id, on the reader thread.
         *
         * @return true once this request has its answer
         */
        boolean accept(String type, Map<String, Object> message) {
            switch (type) {
                case "clipboard.ok" -> {
                    return get ? fail("internal") : done.complete(new byte[0]);
                }
                case "clipboard.error" -> {
                    String code = Json.string(message, "code");
                    return fail(code != null && CODES.contains(code) ? code : "internal");
                }
                case "clipboard.text" -> {
                    return get ? acceptText(message) : fail("internal");
                }
                default -> {
                    return false;
                }
            }
        }

        private boolean acceptText(Map<String, Object> message) {
            Integer part = integer(message.get("part"));
            Object last = message.get("last");
            if (part == null || !(last instanceof Boolean isLast) || part != nextPart) {
                return fail("internal");
            }
            if (Boolean.TRUE.equals(message.get("none"))) {
                return part == 0 && isLast && message.get("data") == null ? done.complete(null) : fail("internal");
            }
            if (!(message.get("data") instanceof String data)) {
                return fail("internal");
            }
            byte[] bytes;
            try {
                bytes = DECODER.decode(data);
            } catch (IllegalArgumentException e) {
                return fail("internal");
            }
            if ((long) size + bytes.length > maxBytes) {
                // desk-rtc stops at maxBytes, so this is more than was asked for: never a cut piece.
                return fail("too_large");
            }
            if (joined == null) {
                joined = new byte[Math.min(maxBytes, Math.max(bytes.length, PART_BYTES))];
            } else if (size + bytes.length > joined.length) {
                joined = Arrays.copyOf(joined, (int) Math.min(maxBytes, Math.max(2L * joined.length, size + bytes.length)));
            }
            System.arraycopy(bytes, 0, joined, size, bytes.length);
            size += bytes.length;
            nextPart++;
            if (!isLast) {
                return false;
            }
            byte[] text = size == joined.length ? joined : Arrays.copyOf(joined, size);
            joined = null;
            return done.complete(text);
        }

        boolean fail(String code) {
            joined = null;
            return done.completeExceptionally(new RtcException(code));
        }
    }

    /**
     * The id of a message from desk-rtc, or -1 if it has none that could be one of deskd's: an integer from 0 to
     * 2^53 - 1, not a fraction or a string.
     */
    static long idOf(Map<String, Object> message) {
        Object id = message.get("id");
        long value;
        if (id instanceof Integer number) {
            value = number;
        } else if (id instanceof Long number) {
            value = number;
        } else {
            return -1;
        }
        return value >= 0 && value <= MAX_ID ? value : -1;
    }

    private static Integer integer(Object value) {
        return value instanceof Integer number && number >= 0 ? number : null;
    }

    /**
     * The envelopes of one clipboard.set, in order. Empty text is one empty last part, though deskd never sends that.
     * The JSON is written by hand, since base64 needs no escaping, so a part is encoded once and copied once.
     */
    static List<byte[]> setEnvelopes(long id, byte[] text) {
        int parts = Math.max(1, (text.length + PART_BYTES - 1) / PART_BYTES);
        List<byte[]> envelopes = new ArrayList<>(parts);
        for (int part = 0; part < parts; part++) {
            int from = part * PART_BYTES;
            int length = Math.min(PART_BYTES, text.length - from);
            boolean last = part == parts - 1;
            byte[] head = ("{\"t\":\"clipboard.set\",\"id\":" + id + ",\"part\":" + part + ",\"last\":" + last + ",\"data\":\"")
                    .getBytes(StandardCharsets.US_ASCII);
            ByteBuffer data = ENCODER.encode(ByteBuffer.wrap(text, from, length));
            int bodyLength = 1 + head.length + data.remaining() + SET_TAIL.length;
            ByteBuffer out = ByteBuffer.allocate(RtcEnvelope.LENGTH_BYTES + bodyLength);
            out.putInt(bodyLength);
            out.put((byte) RtcEnvelope.TYPE_JSON);
            out.put(head);
            out.put(data);
            out.put(SET_TAIL);
            envelopes.add(out.array());
        }
        return envelopes;
    }

    static byte[] getEnvelope(long id, int maxBytes) {
        return RtcEnvelope.json(Json.bytes(Map.of("t", "clipboard.get", "id", id, "maxBytes", maxBytes)));
    }

    static byte[] watchEnvelope(boolean on) {
        return RtcEnvelope.json(Json.bytes(Map.of("t", "clipboard.watch", "on", on)));
    }
}
