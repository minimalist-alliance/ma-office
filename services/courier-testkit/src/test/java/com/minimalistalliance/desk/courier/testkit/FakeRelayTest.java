package com.minimalistalliance.desk.courier.testkit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.courier.envelope.BoxKeyPair;
import com.minimalistalliance.desk.courier.envelope.Drop;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.Signed;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The fake relay against contract 0.4.0 §3, driven by real envelopes from the envelope library. */
@SuppressWarnings("unchecked")
class FakeRelayTest {

    FakeRelay relay;
    PeerDesk dana;
    PeerDesk sam;

    @BeforeEach
    void start() throws Exception {
        relay = FakeRelay.start();
        dana = new PeerDesk(relay, "d-dana", "dana");
        sam = new PeerDesk(relay, "d-sam", "sam");
    }

    @AfterEach
    void stop() {
        relay.close();
    }

    private static int status(ThrowingCall c) throws Exception {
        try {
            c.run();
            return 200;
        } catch (RelayClient.Refused r) {
            return r.status;
        }
    }

    private static String code(ThrowingCall c) throws Exception {
        try {
            c.run();
            return null;
        } catch (RelayClient.Refused r) {
            return r.code;
        }
    }

    interface ThrowingCall {
        void run() throws Exception;
    }

    @Test
    void aMessageGoesSealedWaitsAndIsCollectedThenAcked() throws Exception {
        List<String> pushes = new CopyOnWriteArrayList<>();
        relay.onNotify((desk, reason) -> pushes.add(desk + " " + reason));
        String id = dana.send(sam.address(), "Lunch at noon?", null);
        assertThat(id).matches("[0-7][0-9A-HJKMNP-TV-Z]{25}");
        assertThat(relay.pending("d-sam")).isEqualTo(1);
        Map<String, Object> pending = sam.client().pending();
        assertThat(((Number) pending.get("pending")).intValue()).isEqualTo(1);

        List<PeerDesk.Received> got = sam.collect();
        assertThat(got).hasSize(1);
        assertThat(got.get(0).from()).isEqualTo(dana.address());
        assertThat(got.get(0).payload().get("text")).isEqualTo("Lunch at noon?");
        assertThat(relay.pending("d-sam")).isZero();
        org.awaitility.Awaitility.await().until(() -> pushes.contains("d-sam envelopes"));
    }

    @Test
    void theRelayNeverSeesTheTextOrTheSender() throws Exception {
        String canary = "canary-" + Long.toHexString(new SecureRandom().nextLong());
        dana.send(sam.address(), canary, null);
        Map<String, Object> page = sam.client().collect(null, 10);
        Map<String, Object> env = (Map<String, Object>) ((List<Object>) page.get("envelopes")).get(0);
        assertThat(env.keySet()).containsExactly("id", "kind", "to", "receivedAt", "expiresAt", "enc", "ct", "drops");
        assertThat(env.toString()).doesNotContain("dana");
        for (FakeRelay.Seen s : relay.seen()) {
            String body = new String(s.body(), StandardCharsets.ISO_8859_1);
            assertThat(body).doesNotContain(canary).doesNotContain(Base64.getEncoder().encodeToString(canary.getBytes()));
        }
    }

    @Test
    void keysAreCheckedAndChangesCappedAndCounted() throws Exception {
        IdentityKeyPair id = IdentityKeyPair.generate(new SecureRandom());
        RelayClient c = dana.client();
        PublishedKeys good = PublishedKeys.bind(id, BoxKeyPair.generate(new SecureRandom(), 0).publicKey());
        Map<String, Object> first = c.putKeys(good.toJson());
        assertThat(first).containsEntry("changed", true).containsEntry("fingerprint", good.fingerprint());
        assertThat(c.putKeys(good.toJson())).containsEntry("changed", false);
        Map<String, Object> badBinding = new LinkedHashMap<>(good.toJson());
        badBinding.put("binding", PublishedKeys.bind(IdentityKeyPair.generate(new SecureRandom()), good.boxKey()).toJson().get("binding"));
        assertThat(code(() -> c.putKeys(badBinding))).isEqualTo("binding_invalid");
        Map<String, Object> smallOrder = new LinkedHashMap<>(good.toJson());
        smallOrder.put("boxKey", Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]));
        assertThat(code(() -> c.putKeys(smallOrder))).isEqualTo("keys_invalid");
        // Three changes a day (the first publish of the day above already counted one change from the peer's own keys).
        c.putKeys(PublishedKeys.bind(id, BoxKeyPair.generate(new SecureRandom(), 0).publicKey()).toJson());
        c.putKeys(PublishedKeys.bind(id, BoxKeyPair.generate(new SecureRandom(), 0).publicKey()).toJson());
        assertThat(code(() -> c.putKeys(PublishedKeys.bind(id, BoxKeyPair.generate(new SecureRandom(), 0).publicKey()).toJson())))
                .isEqualTo("keys_change_limit");
    }

    @Test
    void lookupsAnswerTheContractsCodes() throws Exception {
        RelayClient c = dana.client();
        Map<String, Object> k = c.lookup("SAM+shop@" + FakeRelay.DOMAIN);
        assertThat(k.get("address")).isEqualTo(sam.address());
        assertThat(PublishedKeys.fromJson(k).bindingValid()).isTrue();
        assertThat(code(() -> c.lookup("nobody@" + FakeRelay.DOMAIN))).isEqualTo("address_unknown");
        relay.addDesk("d-new", "AKIANEW");
        relay.assignAddress("d-new", "fresh", false);
        assertThat(code(() -> c.lookup("fresh@" + FakeRelay.DOMAIN))).isEqualTo("keys_not_set");
        relay.assignAddress("d-sam", "samuel", true);
        assertThat(code(() -> c.lookup("sam@" + FakeRelay.DOMAIN))).isEqualTo("address_closed");
        assertThatThrownBy(() -> relay.assignAddress("d-new", "sam", true)).hasMessage("name_taken");
        Map<String, Object> a = sam.client().addresses();
        assertThat(((Map<String, Object>) a.get("address")).get("address")).isEqualTo("samuel@" + FakeRelay.DOMAIN);
        assertThat((List<Object>) a.get("closed")).hasSize(1);
        relay.caps().lookupsPerHour = 6;
        for (int i = 0; i < 2; i++) {
            c.lookup("samuel@" + FakeRelay.DOMAIN);
        }
        assertThat(code(() -> c.lookup("samuel@" + FakeRelay.DOMAIN))).isEqualTo("rate_limited");
    }

    @Test
    void sendRefusesWhatTheRealRelayRefuses() throws Exception {
        RelayClient c = dana.client();
        PublishedKeys theirs = PublishedKeys.fromJson(c.lookup(sam.address()));
        Envelope.Sealed s = Envelope.seal("ma", sam.address(), theirs.boxKey(), "x".getBytes());
        Map<String, Object> ok = new LinkedHashMap<>(s.toJson());
        Map<String, Object> unpadded = new LinkedHashMap<>(ok);
        unpadded.put("ct", Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[300]));
        assertThat(code(() -> c.send(unpadded, null))).isEqualTo("unpadded");
        Map<String, Object> huge = new LinkedHashMap<>(ok);
        huge.put("ct", Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[65_536 * 2 + 16]));
        assertThat(code(() -> c.send(huge, null))).isEqualTo("too_large");
        Map<String, Object> mail = new LinkedHashMap<>(ok);
        mail.put("kind", "mail");
        assertThat(code(() -> c.send(mail, null))).isEqualTo("kind_not_allowed");
        Map<String, Object> badDrop = new LinkedHashMap<>(ok);
        badDrop.put("drops", List.of("dr-01JCQ4V9X3M7K2P8R5T6W0Y1Z9"));
        assertThat(code(() -> c.send(badDrop, null))).isEqualTo("drop_missing");
        Map<String, Object> unknown = new LinkedHashMap<>(ok);
        unknown.put("to", "nobody@" + FakeRelay.DOMAIN);
        assertThat(code(() -> c.send(unknown, null))).isEqualTo("address_unknown");
        // Idempotency: the same key and body once; the same key with another body is refused.
        Map<String, Object> a = c.send(ok, "key-0123456789abcdef");
        assertThat(c.send(ok, "key-0123456789abcdef")).isEqualTo(a);
        Map<String, Object> other = new LinkedHashMap<>(Envelope.seal("ma", sam.address(), theirs.boxKey(), "y".getBytes()).toJson());
        assertThat(code(() -> c.send(other, "key-0123456789abcdef"))).isEqualTo("idempotency_key_reused");
        assertThat(relay.pending("d-sam")).isEqualTo(1);
        // A sender without an address can't send.
        relay.closeAddress("d-dana");
        assertThat(code(() -> c.send(ok, null))).isEqualTo("no_address");
    }

    @Test
    void capsKillSwitchAndDeskKinds() throws Exception {
        relay.caps().sendsPerHour = 2;
        dana.send(sam.address(), "1", null);
        dana.send(sam.address(), "2", null);
        assertThatThrownBy(() -> dana.send(sam.address(), "3", null))
                .isInstanceOfSatisfying(RelayClient.Refused.class, r -> assertThat(r.code).isEqualTo("rate_limited"));
        relay.caps().sendsPerHour = 300;
        relay.caps().maxPendingEnvelopes = 2;
        assertThatThrownBy(() -> dana.send(sam.address(), "4", null))
                .isInstanceOfSatisfying(RelayClient.Refused.class, r -> assertThat(r.code).isEqualTo("recipient_full"));
        relay.setPaused(true);
        assertThat(code(() -> sam.client().pending())).isEqualTo("courier_paused");
        relay.setPaused(false);
        assertThat(relay.pending("d-sam")).isEqualTo(2);
        relay.setDeskKind("d-sam", "guild", false);
        assertThat(code(() -> sam.client().pending())).isEqualTo("desk_kind");
        relay.setDeskKind("d-sam", "personal", true);
        assertThat(code(() -> sam.client().lookup(dana.address()))).isEqualTo("courier_teen");
    }

    @Test
    void aBigBodyGoesThroughTheDrop() throws Exception {
        byte[] body = new byte[700_000];
        new SecureRandom().nextBytes(body);
        int before = relay.dropCount();
        dana.send(sam.address(), "the photos", null, body);
        List<PeerDesk.Received> got = sam.collect();
        assertThat(got).hasSize(1);
        assertThat(got.get(0).dropBody()).isEqualTo(body);
        assertThat(relay.dropCount()).isEqualTo(before);
        // A drop that isn't a bucket can't be reserved.
        assertThat(code(() -> dana.client().reserveDrop(sam.address(), 70_000))).isEqualTo("unpadded");
    }

    @Test
    void envelopesExpireByKindAgainstTheRelaysClock() throws Exception {
        AtomicReference<Instant> now = new AtomicReference<>(Instant.parse("2026-11-14T12:00:00Z"));
        relay.setClock(new Clock() {
            @Override
            public ZoneOffset getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(java.time.ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return now.get();
            }
        });
        dana.send(sam.address(), "member", null);
        relay.deliverMail(sam.address(), "Subject: hi\r\n\r\nhello\r\n".getBytes(), "alex@example.org", Map.of("dmarc", "PASS"));
        assertThat(relay.pending("d-sam")).isEqualTo(2);
        now.set(now.get().plus(Duration.ofDays(30)));
        assertThat(relay.pending("d-sam")).isEqualTo(1);
        now.set(now.get().plus(Duration.ofDays(60)));
        assertThat(relay.pending("d-sam")).isZero();
    }

    @Test
    void lostAcksAndDuplicatesBringEnvelopesAgainAndReorderingShufflesAPage() throws Exception {
        for (int i = 0; i < 5; i++) {
            dana.send(sam.address(), "m" + i, null);
        }
        relay.loseNextAcks(1);
        assertThat(sam.collect()).hasSize(5);
        assertThat(relay.pending("d-sam")).isEqualTo(5);
        relay.duplicateNextFetches(1);
        Map<String, Object> page = sam.client().collect(null, 100);
        Map<String, Object> page2 = sam.client().collect(null, 100);
        assertThat((List<Object>) page.get("envelopes")).hasSize(10);
        assertThat((List<Object>) page2.get("envelopes")).hasSize(5);
        relay.reorderFetches(true);
        List<String> texts = new ArrayList<>();
        for (PeerDesk.Received r : sam.collect()) {
            texts.add((String) r.payload().get("text"));
        }
        assertThat(texts).containsExactlyInAnyOrder("m0", "m1", "m2", "m3", "m4");
        assertThat(relay.pending("d-sam")).isZero();
        assertThat(page).containsKey("pending");
    }

    @Test
    void pagingWalksEverythingOnce() throws Exception {
        for (int i = 0; i < 23; i++) {
            dana.send(sam.address(), "p" + i, null);
        }
        List<String> seenIds = new ArrayList<>();
        String after = null;
        do {
            Map<String, Object> page = sam.client().collect(after, 10);
            for (Object o : (List<Object>) page.get("envelopes")) {
                seenIds.add((String) ((Map<String, Object>) o).get("id"));
            }
            after = (String) page.get("next");
        } while (after != null);
        assertThat(seenIds).hasSize(23).doesNotHaveDuplicates().isSorted();
    }

    @Test
    void theMailDoorSealsMailADeskOpensAndVerifiesWithTheDoorsKey() throws Exception {
        byte[] small = "From: Alex <alex@example.org>\r\nSubject: Hello\r\n\r\nHi Sam.\r\n".getBytes(StandardCharsets.US_ASCII);
        byte[] big = new byte[200_000];
        new SecureRandom().nextBytes(big);
        relay.deliverMail("SAM+news@" + FakeRelay.DOMAIN, small, "alex@example.org", Map.of("dmarc", "PASS"));
        relay.deliverMail(sam.address(), big, "alex@example.org", Map.of("dmarc", "FAIL"));
        Map<String, Object> page = sam.client().collect(null, 10);
        List<Object> envs = (List<Object>) page.get("envelopes");
        assertThat(envs).hasSize(2);
        // Sam's keys, from the peer desk's own view, open them; the door's key verifies them.
        BoxKeyPair samBox = boxOf(sam);
        Envelope.Recipient me = new Envelope.Recipient() {
            @Override
            public List<String> addresses() {
                return List.of(sam.address());
            }

            @Override
            public List<BoxKeyPair> boxKeys() {
                return List.of(samBox);
            }
        };
        Map<String, Object> e0 = (Map<String, Object>) envs.get(0);
        Envelope.Sealed s0 = Envelope.Sealed.fromJson(e0);
        assertThat(s0.kind()).isEqualTo("mail");
        Signed.Verified v0 = Signed.open("mail", me, s0.enc(), s0.ct()).verify(relay.doorKey());
        assertThat(Base64.getUrlDecoder().decode((String) v0.payload().get("raw"))).isEqualTo(small);
        assertThat(((Map<String, Object>) v0.payload().get("verdicts")).get("dmarc")).isEqualTo("PASS");
        Map<String, Object> e1 = (Map<String, Object>) envs.get(1);
        Envelope.Sealed s1 = Envelope.Sealed.fromJson(e1);
        Signed.Verified v1 = Signed.open("mail", me, s1.enc(), s1.ct()).verify(relay.doorKey());
        Map<String, Object> d = (Map<String, Object>) ((List<Object>) e1.get("drops")).get(0);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        Drop.open((Map<String, Object>) v1.payload().get("drop"), ((Number) d.get("bytes")).longValue(),
                new ByteArrayInputStream(sam.client().download((String) d.get("url"))), out);
        assertThat(out.toByteArray()).isEqualTo(big);
        // A peer's key doesn't verify the door's mail.
        assertThatThrownBy(() -> Signed.open("mail", me, s0.enc(), s0.ct()).verify(dana.identityKey())).isInstanceOf(EnvelopeException.class);
    }

    @Test
    void aDirectoryThatSwapsKeysIsCaughtByThePin() throws Exception {
        dana.send(sam.address(), "first", null);
        PeerDesk mallory = new PeerDesk(relay, "d-mallory", "mallory");
        relay.swapKeys(sam.address(), PublishedKeys.fromJson(dana.client().lookup(mallory.address())));
        assertThatThrownBy(() -> dana.send(sam.address(), "second", null))
                .isInstanceOfSatisfying(EnvelopeException.class, e -> assertThat(e.getMessage()).contains("CHANGED"));
        relay.swapKeys(sam.address(), null);
        dana.send(sam.address(), "third", null);
    }

    @Test
    void deskdsSignedCallsAreKnownByTheirAccessKeyAndDownOrSlowIsAnswered() throws Exception {
        relay.addDesk("d-deskd", "AKIAEXAMPLEDESKD");
        HttpRequest r = HttpRequest.newBuilder(URI.create(relay.baseUrl() + "/v1/agent/courier-addresses"))
                .header("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEDESKD/20261114/us-east-1/execute-api/aws4_request, SignedHeaders=host, Signature=00")
                .GET().build();
        HttpResponse<String> ok = HttpClient.newHttpClient().send(r, HttpResponse.BodyHandlers.ofString());
        assertThat(ok.statusCode()).isEqualTo(200);
        assertThat(ok.body()).contains("\"address\":null");
        HttpResponse<String> nobody = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(relay.baseUrl() + "/v1/agent/relay")).build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(nobody.statusCode()).isEqualTo(403);
        relay.setDown(true);
        assertThat(status(() -> sam.client().pending())).isEqualTo(503);
        assertThat(code(() -> sam.client().pending())).isNull();
        relay.setDown(false);
        relay.setLatency(Duration.ofMillis(300));
        long t = System.nanoTime();
        sam.client().pending();
        assertThat(Duration.ofNanos(System.nanoTime() - t)).isGreaterThanOrEqualTo(Duration.ofMillis(300));
        relay.setLatency(Duration.ZERO);
        relay.failNextSends(1);
        assertThat(status(() -> dana.send(sam.address(), "x", null))).isEqualTo(500);
        dana.send(sam.address(), "y", null);
    }

    /** The peer's box key, read back through its own collect: Sam opens its own mail with the same keys it published. */
    private static BoxKeyPair boxOf(PeerDesk desk) throws Exception {
        java.lang.reflect.Field f = PeerDesk.class.getDeclaredField("box");
        f.setAccessible(true);
        return (BoxKeyPair) f.get(desk);
    }
}
