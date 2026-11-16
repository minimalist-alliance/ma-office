package com.minimalistalliance.desk.courier.testkit;

import com.minimalistalliance.desk.courier.envelope.BodySource;
import com.minimalistalliance.desk.courier.envelope.BoxKeyPair;
import com.minimalistalliance.desk.courier.envelope.Drop;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKey;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.KeyCheck;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.Signed;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Another member's desk, for tests and the soak harness: its own keys and address on a {@link FakeRelay}, sending sealed
 * messages to a desk under test and collecting what comes back, exactly as contract 0.4.0 and the envelope library say. It
 * pins contacts' identities on first contact ({@link KeyCheck}), so it also notices a directory that swaps keys.
 */
public final class PeerDesk {

    /** A message this desk opened and verified. */
    public record Received(String relayId, String from, Map<String, Object> payload, byte[] dropBody) {}

    private static final SecureRandom RANDOM = new SecureRandom();

    private final FakeRelay relay;
    private final RelayClient client;
    private final IdentityKeyPair identity = IdentityKeyPair.generate(RANDOM);
    private final BoxKeyPair box = BoxKeyPair.generate(RANDOM, System.currentTimeMillis());
    private final String address;
    private final Map<String, IdentityKey> pins = new HashMap<>();
    private long ids;

    /** Adds the desk to the relay, gives it {@code name}'s address and publishes its keys. */
    public PeerDesk(FakeRelay relay, String deskId, String name) throws IOException {
        this.relay = relay;
        relay.addDesk(deskId, "AKIAPEER" + Math.abs(deskId.hashCode()));
        this.address = relay.assignAddress(deskId, name, false);
        this.client = new RelayClient(relay.baseUrl(), deskId);
        client.putKeys(PublishedKeys.bind(identity, box.publicKey()).toJson());
    }

    public String address() {
        return address;
    }

    public IdentityKey identityKey() {
        return identity.publicKey();
    }

    public RelayClient client() {
        return client;
    }

    /** Looks the recipient up, checks its keys against the pin, and seals and sends a message. Returns the relay's id. */
    public String send(String to, String text, Map<String, Object> extra) throws IOException, EnvelopeException {
        return send(to, text, extra, null);
    }

    /** As {@link #send(String, String, Map)}, with {@code body} in the ciphertext drop. */
    public String send(String to, String text, Map<String, Object> extra, byte[] body) throws IOException, EnvelopeException {
        PublishedKeys theirs = PublishedKeys.fromJson(client.lookup(to));
        KeyCheck.Verdict v = KeyCheck.check(pins.get(to), -1, theirs, null);
        if (!v.usable()) {
            throw new EnvelopeException(EnvelopeException.RECIPIENT_KEY, "key check: " + v);
        }
        pins.putIfAbsent(to, theirs.identityKey());
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", 1);
        p.put("kind", "message");
        p.put("id", nextId());
        p.put("from", address);
        p.put("to", to);
        p.put("at", Instant.now().truncatedTo(ChronoUnit.MILLIS).toString().replaceFirst("(\\d{2}:\\d{2}:\\d{2})Z$", "$1.000Z"));
        p.put("text", text);
        if (extra != null) {
            p.putAll(extra);
        }
        List<String> drops = new ArrayList<>();
        if (body != null) {
            Drop.Sealer sealer = Drop.sealer(BodySource.of(body));
            Map<String, Object> reserved = client.reserveDrop(to, sealer.bucket());
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) sealer.bucket());
            sealer.write(out);
            @SuppressWarnings("unchecked")
            Map<String, Object> signed = reserved.get("headers") instanceof Map<?, ?> h ? (Map<String, Object>) h : Map.of();
            client.upload((String) reserved.get("url"), signed, out.toByteArray());
            String dropId = (String) reserved.get("dropId");
            p.put("drop", sealer.reference(dropId));
            drops.add(dropId);
        }
        Envelope.Sealed s = Signed.seal(identity, theirs, p);
        Map<String, Object> env = new LinkedHashMap<>(s.toJson());
        if (!drops.isEmpty()) {
            env.put("drops", drops);
        }
        return (String) client.send(env, "peer-" + p.get("id")).get("id");
    }

    /** Collects everything waiting, opens and verifies each, then acks: the whole receive side, done simply. */
    @SuppressWarnings("unchecked")
    public List<Received> collect() throws IOException, EnvelopeException {
        List<Received> out = new ArrayList<>();
        String after = null;
        Envelope.Recipient me = new Envelope.Recipient() {
            @Override
            public List<String> addresses() {
                return List.of(address);
            }

            @Override
            public List<BoxKeyPair> boxKeys() {
                return List.of(box);
            }
        };
        while (true) {
            Map<String, Object> page = client.collect(after, 100);
            List<String> ids = new ArrayList<>();
            for (Object o : (List<Object>) page.get("envelopes")) {
                Map<String, Object> e = (Map<String, Object>) o;
                Envelope.Sealed s = Envelope.Sealed.fromJson(e);
                Signed.Unverified u = Signed.open(s.kind(), me, s.enc(), s.ct());
                // Mail is signed by the door's key (the proposed 0.4.1 payload), a member's message by the member's pinned key.
                IdentityKey signer = Envelope.MAIL.equals(s.kind()) ? relay.doorKey() : pins.get(u.from());
                if (signer == null) {
                    PublishedKeys k = PublishedKeys.fromJson(client.lookup(u.from()));
                    signer = k.identityKey();
                    pins.put(u.from(), signer);
                }
                Signed.Verified v = u.verify(signer);
                byte[] dropBody = null;
                if (v.payload().get("drop") instanceof Map<?, ?> ref) {
                    Map<String, Object> d = (Map<String, Object>) ((List<Object>) e.get("drops")).get(0);
                    byte[] drop = client.download((String) d.get("url"));
                    ByteArrayOutputStream body = new ByteArrayOutputStream();
                    Drop.open((Map<String, Object>) ref, ((Number) d.get("bytes")).longValue(), new ByteArrayInputStream(drop), body);
                    dropBody = body.toByteArray();
                }
                out.add(new Received((String) e.get("id"), u.from(), v.payload(), dropBody));
                ids.add((String) e.get("id"));
            }
            if (!ids.isEmpty()) {
                client.ack(ids);
            }
            after = (String) page.get("next");
            if (after == null) {
                return out;
            }
        }
    }

    private synchronized String nextId() {
        long ms = System.currentTimeMillis();
        long n = ids++;
        String crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        StringBuilder s = new StringBuilder(26);
        for (int i = 9; i >= 0; i--) {
            s.append(crockford.charAt((int) ((ms >>> (5 * i)) & 31)));
        }
        long tag = Math.abs((long) address.hashCode());
        for (int i = 7; i >= 0; i--) {
            s.append(crockford.charAt((int) ((tag >>> (5 * i)) & 31)));
        }
        for (int i = 7; i >= 0; i--) {
            s.append(crockford.charAt((int) ((n >>> (5 * i)) & 31)));
        }
        return s.toString();
    }
}
