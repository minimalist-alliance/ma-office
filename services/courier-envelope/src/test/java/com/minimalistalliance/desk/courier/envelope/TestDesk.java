package com.minimalistalliance.desk.courier.envelope;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** A desk's keys and addresses in memory, for tests: the newest box key and address are current. */
final class TestDesk implements Envelope.Recipient {

    static final SecureRandom RANDOM = new SecureRandom();
    private static final AtomicLong IDS = new AtomicLong();

    final List<String> addresses = new ArrayList<>();
    final IdentityKeyPair identity;
    final List<BoxKeyPair> boxes = new ArrayList<>();

    TestDesk(String address) {
        this(address, IdentityKeyPair.generate(RANDOM));
    }

    TestDesk(String address, IdentityKeyPair identity) {
        this.addresses.add(address);
        this.identity = identity;
        rotate();
    }

    String address() {
        return addresses.get(0);
    }

    BoxKeyPair rotate() {
        BoxKeyPair b = BoxKeyPair.generate(RANDOM, System.currentTimeMillis());
        boxes.add(0, b);
        return b;
    }

    PublishedKeys keys() {
        return PublishedKeys.bind(identity, boxes.get(0).publicKey());
    }

    static String ulid() {
        String n = Long.toString(IDS.incrementAndGet(), 32).toUpperCase().replace('I', 'X').replace('L', 'Y').replace('O', 'Z').replace('U', 'W');
        return ("01JTEST" + "0".repeat(19 - Math.min(19, n.length())) + n).substring(0, 26);
    }

    Map<String, Object> payload(TestDesk to, String text) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", 1);
        p.put("kind", "message");
        p.put("id", ulid());
        p.put("from", address());
        p.put("to", to.address());
        p.put("at", "2026-11-14T20:00:00.123Z");
        p.put("text", text);
        return p;
    }

    IdentityKey identityKey() {
        return identity.publicKey();
    }

    @Override
    public List<String> addresses() {
        return addresses;
    }

    @Override
    public List<BoxKeyPair> boxKeys() {
        return boxes;
    }

    static String now() {
        return Instant.now().toString();
    }
}
