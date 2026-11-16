package com.minimalistalliance.desk.courier.envelope;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The plaintext inside an {@code ma} envelope (contract 0.4.0 §2.2, "Inner, kind ma"): a signed payload, with the
 * sender's address inside the seal, never on the relay's record (sealed sender).
 *
 * <pre>
 * plaintext = UTF-8 JSON {"p": &lt;payload, a JSON object as a string&gt;, "s": &lt;signature, base64url&gt;}
 * p         at least v (1), kind, id (a ULID the sender makes), from and to (canonical addresses), at (RFC 3339, ms)
 * s         Ed25519 by the sender's identityKey over UTF-8 "ma-courier/v1 sig\n" + p
 * </pre>
 *
 * The signature covers {@code p}'s exact bytes, so the receiver verifies before trusting anything in it. The sender's key
 * isn't in the envelope: the receiver takes the keys pinned for {@code p.from} (or looks them up on first contact, then
 * pins, {@link KeyCheck}), so opening gives an {@link Unverified} payload, and {@link Unverified#verify} needs that key.
 * The mail door's {@code mail} envelopes use the same layout under the door's own key and its own signing domain
 * ({@code "ma-courier/v1 mail sig\n"}), as proposed for 0.4.1 (draft ADR "Courier's envelopes" §9); {@link #open} refuses
 * a {@code mail} payload in any other envelope, and any other payload in a {@code mail} one. Verify a {@code mail} payload
 * with the door's key only, never a key looked up for its {@code from}.
 */
public final class Signed {

    static final String SIG_PREFIX = "ma-courier/v1 sig\n";
    /** The mail door's own signing domain (proposed for 0.4.1), so a door's signature and a desk's never stand for each other. */
    static final String MAIL_SIG_PREFIX = "ma-courier/v1 mail sig\n";
    /** The payload kind the mail door uses, and only it, only in a {@code mail} envelope. */
    public static final String MAIL_KIND = "mail";
    /** A ULID: 26 Crockford base32 characters, the first at most 7 (the contract's envelope ids). */
    public static final Pattern ULID = Pattern.compile("[0-7][0-9A-HJKMNP-TV-Z]{25}");
    static final Pattern PAYLOAD_KIND = Pattern.compile("[a-z][a-z0-9._-]{0,31}");
    private static final Pattern AT = Pattern.compile("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}(Z|[+-]\\d{2}:\\d{2})");
    private static final Set<String> OUTER = Set.of("p", "s");

    private Signed() {}

    /** A payload whose signature hasn't been checked: read {@link #from()}, find its pinned key, then {@link #verify}. */
    public record Unverified(String p, byte[] signature, Map<String, Object> payload) {
        public Unverified {
            signature = signature.clone();
            payload = Collections.unmodifiableMap(payload);
        }

        @Override
        public byte[] signature() {
            return signature.clone();
        }

        public String kind() {
            return (String) payload.get("kind");
        }

        public String id() {
            return (String) payload.get("id");
        }

        public String from() {
            return (String) payload.get("from");
        }

        public String to() {
            return (String) payload.get("to");
        }

        public String at() {
            return (String) payload.get("at");
        }

        /**
         * @throws EnvelopeException {@code bad_signature} unless {@code signer} signed {@code p}
         */
        public Verified verify(IdentityKey signer) throws EnvelopeException {
            if (signer == null || !signer.verifies(sigInput(kind(), p), signature)) {
                throw new EnvelopeException(EnvelopeException.BAD_SIGNATURE, "the payload's signature doesn't verify");
            }
            return new Verified(signer, p, payload);
        }

        /** Never the message: its kind and id only, so a log line that names one carries no text. */
        @Override
        public String toString() {
            return "Unverified[" + kind() + " " + id() + "]";
        }
    }

    /** A payload proven signed by {@code signer}. Whether that's the contact it claims is {@link KeyCheck#sender}'s. */
    public record Verified(IdentityKey signer, String p, Map<String, Object> payload) {
        public String kind() {
            return (String) payload.get("kind");
        }

        public String id() {
            return (String) payload.get("id");
        }

        public String from() {
            return (String) payload.get("from");
        }

        public String to() {
            return (String) payload.get("to");
        }

        public String at() {
            return (String) payload.get("at");
        }

        /** Never the message: its kind, id and signer only. */
        @Override
        public String toString() {
            return "Verified[" + kind() + " " + id() + ", " + signer + "]";
        }
    }

    /** {@code "ma-courier/v1 sig\n" + p} (contract 0.4.0 §2.2), or the mail door's own domain for a {@code mail} payload. */
    static byte[] sigInput(String payloadKind, String p) {
        return ((MAIL_KIND.equals(payloadKind) ? MAIL_SIG_PREFIX : SIG_PREFIX) + p).getBytes(StandardCharsets.UTF_8);
    }

    /**
     * Signs a payload into an envelope's plaintext. The map's order is kept in {@code p}.
     *
     * @throws IllegalArgumentException if a required field is missing or out of range
     */
    public static byte[] wrap(IdentityKeyPair signer, Map<String, Object> payload) {
        try {
            check(payload);
        } catch (EnvelopeException e) {
            throw new IllegalArgumentException("the payload: " + e.getMessage());
        }
        String p = new String(Json.bytes(payload), StandardCharsets.UTF_8);
        Map<String, Object> outer = new LinkedHashMap<>();
        outer.put("p", p);
        outer.put("s", B64.encode(signer.sign(sigInput((String) payload.get("kind"), p))));
        return Json.bytes(outer);
    }

    /**
     * Reads an envelope's plaintext. Nothing in it is proven until {@link Unverified#verify}.
     *
     * @throws EnvelopeException {@code format} unless it's exactly {@code {"p", "s"}} with a payload that has every
     *     required field in range
     */
    public static Unverified unwrap(byte[] plaintext) throws EnvelopeException {
        Map<String, Object> outer = Json.parseObject(plaintext, 0, plaintext.length);
        if (!outer.keySet().equals(OUTER) || !(outer.get("p") instanceof String p)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not {p, s}");
        }
        byte[] signature = B64.decode(outer.get("s"), IdentityKey.SIGNATURE_BYTES);
        byte[] pBytes = p.getBytes(StandardCharsets.UTF_8);
        Map<String, Object> payload = Json.parseObject(pBytes, 0, pBytes.length);
        check(payload);
        return new Unverified(p, signature, payload);
    }

    static void check(Map<String, Object> payload) throws EnvelopeException {
        if (payload == null || !Json.isInt(payload.get("v"), 1)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not a version 1 payload");
        }
        String kind = Json.string(payload.get("kind"), 32);
        String id = Json.string(payload.get("id"), 26);
        if (!PAYLOAD_KIND.matcher(kind).matches() || !ULID.matcher(id).matches()) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "the payload's kind or id is out of range");
        }
        Envelope.checkKindAndAddress("ma", Json.string(payload.get("from"), Envelope.MAX_ADDRESS));
        Envelope.checkKindAndAddress("ma", Json.string(payload.get("to"), Envelope.MAX_ADDRESS));
        String at = Json.string(payload.get("at"), 40);
        try {
            if (!AT.matcher(at).matches()) {
                throw new DateTimeParseException("not RFC 3339 with milliseconds", at, 0);
            }
            OffsetDateTime.parse(at);
        } catch (DateTimeParseException e) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "the payload's time isn't RFC 3339 with milliseconds");
        }
    }

    /**
     * Signs and seals a payload to its {@code to}: the whole send side for an {@code ma} message.
     *
     * @param recipient the recipient's keys, already checked ({@link KeyCheck#check} usable)
     */
    public static Envelope.Sealed seal(IdentityKeyPair signer, PublishedKeys recipient, Map<String, Object> payload) throws EnvelopeException {
        if (!recipient.bindingValid()) {
            throw new EnvelopeException(EnvelopeException.RECIPIENT_KEY, "the recipient's binding doesn't verify");
        }
        byte[] plaintext = wrap(signer, payload);
        return Envelope.seal(Envelope.MA, (String) payload.get("to"), recipient.boxKey(), plaintext);
    }

    /**
     * Opens an envelope of {@code kind} and reads its payload, checking that {@code p.to} is the address that opened it,
     * so a payload signed for someone else and sealed again to this desk is refused.
     *
     * @throws EnvelopeException as {@link Envelope#open} and {@link #unwrap}, or {@code not_for_me}
     */
    public static Unverified open(String kind, Envelope.Recipient me, byte[] enc, byte[] ct) throws EnvelopeException {
        Envelope.Opened opened = Envelope.open(kind, me, enc, ct);
        try {
            Unverified u = unwrap(opened.plaintext());
            if (!opened.address().equals(u.to())) {
                throw new EnvelopeException(EnvelopeException.NOT_FOR_ME, "the payload is addressed to someone else");
            }
            // A mail payload only in a mail envelope, and a mail envelope only with one (Security CK-L1): a member can't pass
            // a message off as the door's, nor the door's as a member's.
            if (Envelope.MAIL.equals(kind) != MAIL_KIND.equals(u.kind())) {
                throw new EnvelopeException(EnvelopeException.FORMAT, "the payload's kind doesn't match the envelope's");
            }
            return u;
        } finally {
            java.util.Arrays.fill(opened.plaintext(), (byte) 0);
        }
    }
}
