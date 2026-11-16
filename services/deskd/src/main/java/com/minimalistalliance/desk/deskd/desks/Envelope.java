package com.minimalistalliance.desk.deskd.desks;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The one object that goes from one of the member's desks to another (draft ADR "the Agent's tools and approvals", §14;
 * the chat spike's envelope, {@code spikes/chat/README.md} §1, with this protocol's own labels):
 *
 * <pre>
 * envelope = {v: 1, id, from, to, enc, ct}         all the office, or a relay later, can see
 * ct       = HPKE.seal(to.box, info = "ma-desk-msg/v1", aad = "ma-desk-msg/v1 env\n" + id + "\n" + from + "\n" + to, {p, s})
 * s        = Ed25519(from.sig, "ma-desk-msg/v1 sig\n" + p)
 * p        = the payload, a JSON object as a string: {v: 1, kind, id, grantId, from, to, account, sentAt, seq, ...}
 * </pre>
 *
 * An {@code offer}, and a {@code revoke} of a half the other desk never accepted, can't be sealed, as the sender has no
 * key of the other desk yet: they're {@code {v: 1, id, from, to, p, s}}, signed only, and an offer carries the sender's
 * public keys in {@code p.keys}. The payload's id, sender and receiver must be the envelope's.
 *
 * <p>Opening never logs, and a refusal says one word ({@link Rejected#reason}).
 */
public final class Envelope {

    static final byte[] INFO = "ma-desk-msg/v1".getBytes(StandardCharsets.UTF_8);
    /** An envelope's JSON, at most: an 8,000-character text in base64 and JSON, with room. */
    public static final int MAX_BYTES = 64 * 1024;
    static final Pattern ID = Pattern.compile("env-[a-z2-7]{26}");
    private static final Set<String> SEALED_FIELDS = Set.of("v", "id", "from", "to", "enc", "ct");
    private static final Set<String> SIGNED_FIELDS = Set.of("v", "id", "from", "to", "p", "s");
    public static final Set<String> KINDS = Set.of("offer", "accept", "msg", "answer", "revoke");
    private static final char[] BASE32 = "abcdefghijklmnopqrstuvwxyz234567".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    /** An envelope refused, with one word that says why: {@code envelope}, {@code not_for_me}, {@code cannot_open}, … */
    public static final class Rejected extends Exception {
        private static final long serialVersionUID = 1L;
        private final String reason;

        public Rejected(String reason) {
            super(reason, null, false, false);
            this.reason = reason;
        }

        public String reason() {
            return reason;
        }
    }

    /**
     * An envelope opened, its signature not yet checked: that needs the key pinned for its grant ({@link #verify}).
     *
     * @param sealed whether it came sealed to this desk; an offer or an early revoke doesn't
     * @param p the payload's exact text, which the signature covers
     * @param payload the payload, parsed
     */
    public record Opened(String id, String from, String to, boolean sealed, String p, byte[] sig,
            Map<String, Object> payload) {

        public String kind() {
            return Json.string(payload, "kind");
        }

        public String grantId() {
            return Json.string(payload, "grantId");
        }

        /** No content in logs. */
        @Override
        public String toString() {
            return "Opened[" + id + ", " + kind() + "]";
        }
    }

    private Envelope() {}

    /** A new envelope's id: {@code env-} and 26 base32 characters, 130 random bits. */
    public static String newId() {
        char[] id = new char[26];
        for (int i = 0; i < id.length; i++) {
            id[i] = BASE32[RANDOM.nextInt(32)];
        }
        return "env-" + new String(id);
    }

    static byte[] sigInput(String p) {
        return ("ma-desk-msg/v1 sig\n" + p).getBytes(StandardCharsets.UTF_8);
    }

    static byte[] aad(String id, String from, String to) {
        return ("ma-desk-msg/v1 env\n" + id + "\n" + from + "\n" + to).getBytes(StandardCharsets.UTF_8);
    }

    /** The payload sealed to {@code to}'s box key and signed by this desk. {@code payload}'s id, from and to are the envelope's. */
    public static Map<String, Object> seal(DeskKeys me, DeskKeys.Pub to, Map<String, Object> payload)
            throws GeneralSecurityException {
        String id = (String) payload.get("id");
        String p = new String(Json.bytes(payload), StandardCharsets.UTF_8);
        byte[] s = me.sign(sigInput(p));
        Map<String, Object> inner = new LinkedHashMap<>();
        inner.put("p", p);
        inner.put("s", DeskKeys.B64.encodeToString(s));
        Hpke.Sealed sealed = Hpke.seal(to.boxKey(), INFO, aad(id, me.deskId(), to.deskId()), Json.bytes(inner));
        Map<String, Object> env = new LinkedHashMap<>();
        env.put("v", 1);
        env.put("id", id);
        env.put("from", me.deskId());
        env.put("to", to.deskId());
        env.put("enc", DeskKeys.B64.encodeToString(sealed.enc()));
        env.put("ct", DeskKeys.B64.encodeToString(sealed.ct()));
        return env;
    }

    /** Signed only: an offer, or a revoke of a half the other desk never accepted, which have no key to seal to. */
    public static Map<String, Object> signed(DeskKeys me, String toDeskId, Map<String, Object> payload)
            throws GeneralSecurityException {
        String p = new String(Json.bytes(payload), StandardCharsets.UTF_8);
        Map<String, Object> env = new LinkedHashMap<>();
        env.put("v", 1);
        env.put("id", payload.get("id"));
        env.put("from", me.deskId());
        env.put("to", toDeskId);
        env.put("p", p);
        env.put("s", DeskKeys.B64.encodeToString(me.sign(sigInput(p))));
        return env;
    }

    /**
     * Opens an envelope sent to this desk: its shape, that it's for this desk, the seal (when it's sealed), and that the
     * payload names the same id, sender and receiver. The signature is the caller's to check, with the key pinned for
     * the payload's grant ({@link #verify}).
     */
    public static Opened open(DeskKeys me, Object raw) throws Rejected {
        if (!(raw instanceof Map<?, ?> m0)) {
            throw new Rejected("envelope");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> env = (Map<String, Object>) m0;
        if (!one(env.get("v")) || !(env.get("id") instanceof String id) || !ID.matcher(id).matches()
                || !(env.get("from") instanceof String from) || !DeskKeys.DESK_ID.matcher(from).matches()
                || !(env.get("to") instanceof String to) || !DeskKeys.DESK_ID.matcher(to).matches()) {
            throw new Rejected("envelope");
        }
        boolean sealed = env.keySet().equals(SEALED_FIELDS);
        if (!sealed && !env.keySet().equals(SIGNED_FIELDS)) {
            throw new Rejected("envelope");
        }
        if (!to.equals(me.deskId())) {
            throw new Rejected("not_for_me");
        }
        String p;
        byte[] sig;
        try {
            if (sealed) {
                if (!(env.get("enc") instanceof String enc) || !(env.get("ct") instanceof String ct)) {
                    throw new Rejected("envelope");
                }
                byte[] inner;
                try {
                    inner = Hpke.open(me.boxPrivate(), DeskKeys.UNB64.decode(enc), INFO, aad(id, from, to),
                            DeskKeys.UNB64.decode(ct));
                } catch (GeneralSecurityException | IllegalArgumentException e) {
                    throw new Rejected("cannot_open");
                }
                Map<String, Object> in = Json.parseObject(inner);
                if (!(in.get("p") instanceof String ps) || !(in.get("s") instanceof String ss) || in.size() != 2) {
                    throw new Rejected("envelope");
                }
                p = ps;
                sig = DeskKeys.UNB64.decode(ss);
            } else {
                if (!(env.get("p") instanceof String ps) || !(env.get("s") instanceof String ss)) {
                    throw new Rejected("envelope");
                }
                p = ps;
                sig = DeskKeys.UNB64.decode(ss);
            }
            Map<String, Object> payload = Json.parseObject(p.getBytes(StandardCharsets.UTF_8));
            if (!one(payload.get("v")) || !id.equals(payload.get("id"))
                    || !from.equals(payload.get("from")) || !to.equals(payload.get("to"))
                    || !(payload.get("kind") instanceof String kind) || !KINDS.contains(kind)
                    || !(payload.get("grantId") instanceof String grantId) || grantId.length() > 64
                    || !(payload.get("sentAt") instanceof Number) || !(payload.get("seq") instanceof Number)
                    || !(payload.get("account") instanceof String)) {
                throw new Rejected("envelope");
            }
            // Only these two may come unsealed: nothing private is in them.
            if (!sealed && !kind.equals("offer") && !kind.equals("revoke")) {
                throw new Rejected("envelope");
            }
            return new Opened(id, from, to, sealed, p, sig, payload);
        } catch (JsonFormatException | IllegalArgumentException e) {
            throw new Rejected("envelope");
        }
    }

    /** Whether a JSON value is the number 1, however the parser typed it. */
    static boolean one(Object value) {
        return value instanceof Number n && n.doubleValue() == 1 && n.longValue() == 1;
    }

    /** Whether {@code key} signed the opened envelope's payload. */
    public static boolean verify(DeskKeys.Pub key, Opened opened) {
        try {
            return key != null && key.deskId().equals(opened.from()) && DeskKeys.verify(key.sigKey(),
                    sigInput(opened.p()), opened.sig());
        } catch (GeneralSecurityException | RuntimeException e) {
            return false;
        }
    }

    /** The envelope's size as JSON, which the office's {@code deliver} is held to ({@link #MAX_BYTES}). */
    public static int size(Object envelope) {
        try {
            return Json.bytes(envelope).length;
        } catch (IllegalArgumentException e) {
            return Integer.MAX_VALUE;
        }
    }
}
