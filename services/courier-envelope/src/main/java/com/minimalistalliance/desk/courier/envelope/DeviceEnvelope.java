package com.minimalistalliance.desk.courier.envelope;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.bouncycastle.crypto.InvalidCipherTextException;
import org.bouncycastle.crypto.hpke.HPKE;
import org.bouncycastle.crypto.hpke.HPKEContext;
import org.bouncycastle.crypto.hpke.HPKEContextWithEncapsulation;

/**
 * A paired device's envelope (kind {@code device}; ma-platform {@code relay.md} 0.4.3 and the draft ADR "Courier's Mac
 * connector" §B): the same HPKE seal, padding and buckets as every envelope, with the device's id where an address goes, in
 * both directions, and its own signing domain.
 *
 * <pre>
 * info = "ma-courier/v1 device"
 * aad  = "ma-courier/v1 env\ndevice\n" + deviceId           up (device to desk) sealed to the desk's box key, down to the device's
 * pt   = {"p": &lt;payload string&gt;, "s": Ed25519 over "ma-courier/v1 device sig\n" + p}, padded
 * p    = {v: 1, kind: "device", id (ULID), device, dir: "up" | "down", at (RFC 3339, ms), type, ...}
 * </pre>
 *
 * The device's own signing domain means a device's signature never stands for a desk's member message or the mail door's
 * mail, and the {@code device} info and aad mean its envelope never opens as either. MA Connector for Mac builds the same
 * bytes with CryptoKit (ma-desk {@code connectors/mac}); the two are checked against each other end to end.
 */
public final class DeviceEnvelope {

    public static final String KIND = "device";
    public static final String UP = "up";
    public static final String DOWN = "down";
    /** The most a device envelope may hold (relay.md 0.4.3: the body stays under the firewall's limit). */
    public static final int MAX_PLAINTEXT_BUCKET = 32 * 1024;
    public static final Pattern DEVICE_ID = Pattern.compile("dv-[a-z2-7]{12}");
    static final String SIG_PREFIX = "ma-courier/v1 device sig\n";
    private static final Pattern TYPE = Pattern.compile("[a-z][a-z0-9_-]{0,31}");
    private static final Pattern AT = Pattern.compile("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}(Z|[+-]\\d{2}:\\d{2})");
    private static final Set<String> OUTER = Set.of("p", "s");

    private DeviceEnvelope() {}

    static void checkDevice(String deviceId) throws EnvelopeException {
        if (deviceId == null || !DEVICE_ID.matcher(deviceId).matches()) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not a device id");
        }
    }

    /** Seals a plaintext to {@code to}'s box key for the device {@code deviceId}. */
    public static Envelope.Sealed seal(String deviceId, BoxKey to, byte[] plaintext) throws EnvelopeException {
        checkDevice(deviceId);
        byte[] padded = Padding.pad(plaintext);
        if (padded.length > MAX_PLAINTEXT_BUCKET) {
            java.util.Arrays.fill(padded, (byte) 0);
            throw new EnvelopeException(EnvelopeException.TOO_LARGE, "over a device envelope's size");
        }
        try {
            HPKE hpke = Envelope.hpke();
            HPKEContextWithEncapsulation ctx = hpke.setupBaseS(hpke.deserializePublicKey(to.bytes()), Envelope.info(KIND));
            byte[] ct = ctx.seal(Envelope.aad(KIND, deviceId), padded);
            return new Envelope.Sealed(KIND, deviceId, ctx.getEncapsulation(), ct);
        } catch (InvalidCipherTextException e) {
            throw new IllegalStateException("ChaCha20-Poly1305 refused to seal", e);
        } catch (RuntimeException e) {
            throw new EnvelopeException(EnvelopeException.RECIPIENT_KEY, "HPKE couldn't seal to that box key");
        } finally {
            java.util.Arrays.fill(padded, (byte) 0);
        }
    }

    /** Opens an envelope for {@code deviceId} with each of {@code keys} (the current one first). */
    public static byte[] open(String deviceId, List<BoxKeyPair> keys, byte[] enc, byte[] ct) throws EnvelopeException {
        checkDevice(deviceId);
        if (enc == null || enc.length != Envelope.ENC_BYTES || ct == null || ct.length > MAX_PLAINTEXT_BUCKET + Envelope.TAG_BYTES
                || !Padding.isEnvelopeBucket(ct.length - Envelope.TAG_BYTES)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not a device envelope's shape");
        }
        HPKE hpke = Envelope.hpke();
        for (BoxKeyPair key : keys) {
            byte[] padded;
            try {
                HPKEContext ctx = hpke.setupBaseR(enc, key.forHpke(), Envelope.info(KIND));
                padded = ctx.open(Envelope.aad(KIND, deviceId), ct);
            } catch (InvalidCipherTextException e) {
                continue;
            } catch (RuntimeException e) {
                throw new EnvelopeException(EnvelopeException.CANNOT_OPEN, "HPKE refused the encapsulated key");
            }
            try {
                return Padding.unpad(padded);
            } finally {
                java.util.Arrays.fill(padded, (byte) 0);
            }
        }
        throw new EnvelopeException(EnvelopeException.CANNOT_OPEN, "no box key opens it");
    }

    /** A payload proven signed by the peer, for this device and direction. */
    public record Payload(String p, Map<String, Object> fields) {
        public Payload {
            fields = Collections.unmodifiableMap(fields);
        }

        public String id() {
            return (String) fields.get("id");
        }

        public String type() {
            return (String) fields.get("type");
        }

        public String at() {
            return (String) fields.get("at");
        }

        /** Never the content: its type and id only. */
        @Override
        public String toString() {
            return "DeviceEnvelope.Payload[" + type() + " " + id() + "]";
        }
    }

    /** Signs a payload: {@code fields} gets {@code v}, {@code kind}, {@code id}, {@code device}, {@code dir}, {@code at} and {@code type}. */
    public static byte[] wrap(IdentityKeyPair signer, String deviceId, String dir, String type, Map<String, Object> fields, String id, String at)
            throws EnvelopeException {
        checkDevice(deviceId);
        if (!UP.equals(dir) && !DOWN.equals(dir) || type == null || !TYPE.matcher(type).matches() || id == null
                || !Signed.ULID.matcher(id).matches() || at == null || !AT.matcher(at).matches()) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "the payload's head is out of range");
        }
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", 1);
        p.put("kind", KIND);
        p.put("id", id);
        p.put("device", deviceId);
        p.put("dir", dir);
        p.put("at", at);
        p.put("type", type);
        for (Map.Entry<String, Object> e : fields.entrySet()) {
            p.putIfAbsent(e.getKey(), e.getValue());
        }
        String text = new String(Json.bytes(p), StandardCharsets.UTF_8);
        Map<String, Object> outer = new LinkedHashMap<>();
        outer.put("p", text);
        outer.put("s", B64.encode(signer.sign((SIG_PREFIX + text).getBytes(StandardCharsets.UTF_8))));
        return Json.bytes(outer);
    }

    /**
     * Reads a plaintext strictly, checks its signature under {@code signer}, then that it's for {@code deviceId} going
     * {@code dir}. Nothing in it is read before the signature checks.
     */
    public static Payload unwrap(byte[] plaintext, IdentityKey signer, String deviceId, String dir) throws EnvelopeException {
        checkDevice(deviceId);
        Map<String, Object> outer = Json.parseObject(plaintext, 0, plaintext.length);
        if (!outer.keySet().equals(OUTER) || !(outer.get("p") instanceof String p)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not {p, s}");
        }
        byte[] signature = B64.decode(outer.get("s"), IdentityKey.SIGNATURE_BYTES);
        if (signer == null || !signer.verifies((SIG_PREFIX + p).getBytes(StandardCharsets.UTF_8), signature)) {
            throw new EnvelopeException(EnvelopeException.BAD_SIGNATURE, "the payload's signature doesn't verify");
        }
        byte[] pBytes = p.getBytes(StandardCharsets.UTF_8);
        Map<String, Object> fields = Json.parseObject(pBytes, 0, pBytes.length);
        if (!Json.isInt(fields.get("v"), 1) || !KIND.equals(fields.get("kind"))) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not a version 1 device payload");
        }
        String id = Json.string(fields.get("id"), 26);
        String type = Json.string(fields.get("type"), 32);
        String at = Json.string(fields.get("at"), 40);
        if (!Signed.ULID.matcher(id).matches() || !TYPE.matcher(type).matches() || !AT.matcher(at).matches()) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "the payload's head is out of range");
        }
        try {
            OffsetDateTime.parse(at);
        } catch (DateTimeParseException e) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "the payload's time isn't RFC 3339");
        }
        if (!deviceId.equals(fields.get("device")) || !dir.equals(fields.get("dir"))) {
            throw new EnvelopeException(EnvelopeException.NOT_FOR_ME, "for another device or direction");
        }
        return new Payload(p, fields);
    }

    /**
     * Reads a payload carried whole in a drop ({@code type: big}): the drop's digest is in the signed reference, so these
     * bytes are proven; they're read with the same strict rules, as a plain JSON object.
     */
    public static Map<String, Object> parse(byte[] json) throws EnvelopeException {
        return Json.parseObject(json, 0, json.length);
    }

    /** Milliseconds of an RFC 3339 time with milliseconds. */
    public static long millis(String at) throws EnvelopeException {
        try {
            return OffsetDateTime.parse(at).toInstant().toEpochMilli();
        } catch (DateTimeParseException | NullPointerException e) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not a time");
        }
    }
}
