package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.courier.envelope.BoxKeyPair;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.Signed;
import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Another member's desk whose every byte the test chooses: its identity (which it can reset), its address on the fake
 * relay, and payloads signed and sealed by hand, for what a well-behaved {@code PeerDesk} never sends (a forged sender, an
 * old message, another kind), injected straight into the relay or sent through its routes.
 */
final class ManualPeer {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    final FakeRelay relay;
    final KitApi api;
    final String address;
    IdentityKeyPair identity = IdentityKeyPair.generate(RANDOM);
    BoxKeyPair box = BoxKeyPair.generate(RANDOM, System.currentTimeMillis());
    private long n;

    ManualPeer(FakeRelay relay, String deskId, String name) throws Exception {
        this.relay = relay;
        relay.addDesk(deskId, "AKIAMP" + Math.abs(deskId.hashCode()));
        this.address = relay.assignAddress(deskId, name, false);
        this.api = new KitApi(relay.baseUrl(), deskId);
        publish();
    }

    void publish() throws Exception {
        api.putKeys(PublishedKeys.bind(identity, box.publicKey()).toJson());
    }

    /** A new identity (and box key), published: every contact sees a key change. */
    void resetIdentity() throws Exception {
        identity = IdentityKeyPair.generate(RANDOM);
        box = BoxKeyPair.generate(RANDOM, System.currentTimeMillis());
        publish();
    }

    /** A new box key under the same identity, published: contacts see nothing (the same contact). */
    void rotateBox() throws Exception {
        box = BoxKeyPair.generate(RANDOM, System.currentTimeMillis());
        publish();
    }

    PublishedKeys keys() {
        return PublishedKeys.bind(identity, box.publicKey());
    }

    /** A fresh payload id: a ULID-shaped string the envelope library takes. */
    synchronized String nextId() {
        long ms = System.currentTimeMillis();
        StringBuilder s = new StringBuilder(26);
        for (int i = 9; i >= 0; i--) {
            s.append(CROCKFORD.charAt((int) ((ms >>> (5 * i)) & 31)));
        }
        long tag = RANDOM.nextLong() >>> 1;
        for (int i = 0; i < 8; i++) {
            s.append(CROCKFORD.charAt((int) ((tag >>> (5 * i)) & 31)));
        }
        long k = n++;
        for (int i = 7; i >= 0; i--) {
            s.append(CROCKFORD.charAt((int) ((k >>> (5 * i)) & 31)));
        }
        return s.toString();
    }

    Map<String, Object> payload(String from, String to, long at, String text) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", 1);
        p.put("kind", "message");
        p.put("id", nextId());
        p.put("from", from);
        p.put("to", to);
        p.put("at", Payloads.at(at));
        p.put("text", text);
        return p;
    }

    /** Signs {@code payload} with {@code signer} and seals it to {@code recipient}'s keys, as an {@code ma} envelope. */
    static Envelope.Sealed seal(IdentityKeyPair signer, PublishedKeys recipient, Map<String, Object> payload) throws Exception {
        return Signed.seal(signer, recipient, payload);
    }

    /** Sends a payload through the relay's real send route (with an idempotency key), as a desk would. */
    String send(PublishedKeys recipient, Map<String, Object> payload) throws Exception {
        Envelope.Sealed s = seal(identity, recipient, payload);
        return (String) api.send(s.toJson(), "mp-" + payload.get("id")).get("id");
    }

    /** Puts a sealed envelope straight into a desk's queue, as a relay that misbehaves could. */
    String inject(Envelope.Sealed s) {
        return relay.inject(s.to(), s.kind(), s.enc(), s.ct());
    }

    static String b64(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }
}
