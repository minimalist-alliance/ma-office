package com.minimalistalliance.desk.courier.envelope;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** The outer envelope, the signed payload and the drop, against contract 0.4.0 §2.2 and §2.3. */
class EnvelopeTest {

    private final TestDesk dana = new TestDesk("dana@courier.example");
    private final TestDesk sam = new TestDesk("sam@courier.example");

    interface ThrowingRunnable {
        void run() throws Exception;
    }

    static String reason(ThrowingRunnable r) {
        try {
            r.run();
        } catch (EnvelopeException e) {
            return e.reason();
        } catch (Exception e) {
            throw new AssertionError("expected an EnvelopeException, got " + e, e);
        }
        throw new AssertionError("expected an EnvelopeException");
    }

    private static byte[] bytes(int n, int seed) {
        byte[] b = new byte[n];
        new java.util.Random(seed).nextBytes(b);
        return b;
    }

    @Test
    void aMemberMessageRoundTripsAndIsVerifiedOnlyWithTheSendersKey() throws Exception {
        Map<String, Object> payload = dana.payload(sam, "Lunch at noon?");
        Envelope.Sealed s = Signed.seal(dana.identity, sam.keys(), payload);
        assertThat(s.kind()).isEqualTo("ma");
        assertThat(s.to()).isEqualTo(sam.address());
        assertThat(s.enc()).hasSize(32);
        assertThat(Padding.isEnvelopeBucket(s.ct().length - 16)).isTrue();

        Signed.Unverified u = Signed.open("ma", sam, s.enc(), s.ct());
        assertThat(u.from()).isEqualTo(dana.address());
        assertThat(u.to()).isEqualTo(sam.address());
        assertThat(u.id()).isEqualTo(payload.get("id"));
        assertThat(u.payload().get("text")).isEqualTo("Lunch at noon?");
        Signed.Verified v = u.verify(dana.identityKey());
        assertThat(v.signer()).isEqualTo(dana.identityKey());
        assertThat(reason(() -> u.verify(sam.identityKey()))).isEqualTo(EnvelopeException.BAD_SIGNATURE);
        assertThat(reason(() -> u.verify(null))).isEqualTo(EnvelopeException.BAD_SIGNATURE);
    }

    @Test
    void theSendersAddressIsOnlyInsideTheSeal() throws Exception {
        Envelope.Sealed s = Signed.seal(dana.identity, sam.keys(), dana.payload(sam, "hi"));
        String outer = new String(Json.bytes(s.toJson()), StandardCharsets.UTF_8);
        assertThat(outer).doesNotContain("dana").contains("sam@courier.example");
        assertThat(s.toJson().keySet()).containsExactly("to", "kind", "enc", "ct");
        Envelope.Sealed back = Envelope.Sealed.fromJson(new LinkedHashMap<>(s.toJson()));
        assertThat(back.enc()).isEqualTo(s.enc());
        assertThat(back.ct()).isEqualTo(s.ct());
    }

    @Test
    void everyCiphertextIsABucketAndShortMessagesLookAlike() throws Exception {
        int first = -1;
        for (int n : new int[] {0, 1, 10, 30}) {
            Envelope.Sealed s = Signed.seal(dana.identity, sam.keys(), dana.payload(sam, "x".repeat(n)));
            first = first < 0 ? s.ct().length : first;
            assertThat(s.ct().length).isEqualTo(first);
        }
        for (int n : new int[] {0, 1, 254, 255, 256, 4094, 4095, 4096, 5000, 30_000, 65_534, 65_535}) {
            Envelope.Sealed s = Envelope.seal("ma", sam.address(), sam.keys().boxKey(), bytes(n, n));
            assertThat(Padding.isEnvelopeBucket(s.ct().length - 16)).as("plaintext %d", n).isTrue();
            assertThat(s.ct().length - 16).isEqualTo(Padding.envelopeBucket(n));
            assertThat(Envelope.open("ma", sam, s.enc(), s.ct()).plaintext()).isEqualTo(bytes(n, n));
        }
        assertThat(reason(() -> Envelope.seal("ma", sam.address(), sam.keys().boxKey(), new byte[65_536]))).isEqualTo(EnvelopeException.TOO_LARGE);
    }

    @Test
    void sealingTwiceGivesDifferentBytes() throws Exception {
        byte[] pt = "same".getBytes();
        Envelope.Sealed a = Envelope.seal("ma", sam.address(), sam.keys().boxKey(), pt);
        Envelope.Sealed b = Envelope.seal("ma", sam.address(), sam.keys().boxKey(), pt);
        assertThat(a.enc()).isNotEqualTo(b.enc());
        assertThat(a.ct()).isNotEqualTo(b.ct());
    }

    @Test
    void everyChangedByteFailsToOpen() throws Exception {
        Envelope.Sealed s = Signed.seal(dana.identity, sam.keys(), dana.payload(sam, "hi"));
        for (int i = 0; i < s.ct().length; i++) {
            byte[] ct = s.ct();
            ct[i] ^= 0x01;
            assertThat(reason(() -> Signed.open("ma", sam, s.enc(), ct))).as("ct byte %d", i).isEqualTo(EnvelopeException.CANNOT_OPEN);
        }
        for (int i = 0; i < 32; i++) {
            byte[] enc = s.enc();
            enc[i] ^= 0x01;
            assertThat(reason(() -> Signed.open("ma", sam, enc, s.ct()))).as("enc byte %d", i).isEqualTo(EnvelopeException.CANNOT_OPEN);
        }
        assertThat(reason(() -> Signed.open("ma", sam, s.enc(), Arrays.copyOf(s.ct(), s.ct().length - 1)))).isEqualTo(EnvelopeException.FORMAT);
        assertThat(reason(() -> Signed.open("ma", sam, s.enc(), Arrays.copyOf(s.ct(), s.ct().length + 256)))).isEqualTo(EnvelopeException.CANNOT_OPEN);
        assertThat(reason(() -> Signed.open("ma", sam, Arrays.copyOf(s.enc(), 31), s.ct()))).isEqualTo(EnvelopeException.FORMAT);
        // The kind is bound in info and aad: an ma envelope doesn't open as mail.
        assertThat(reason(() -> Signed.open("mail", sam, s.enc(), s.ct()))).isEqualTo(EnvelopeException.CANNOT_OPEN);
    }

    @Test
    void theRecipientsAddressIsBoundAndClosedAddressesStillOpen() throws Exception {
        Envelope.Sealed s = Signed.seal(dana.identity, sam.keys(), dana.payload(sam, "before the rename"));
        // Sam renames: the old address closes, the new one is first.
        sam.addresses.add(0, "samuel@courier.example");
        Signed.Unverified u = Signed.open("ma", sam, s.enc(), s.ct());
        assertThat(u.to()).isEqualTo("sam@courier.example");
        // Without the old address, it doesn't open.
        sam.addresses.remove("sam@courier.example");
        assertThat(reason(() -> Signed.open("ma", sam, s.enc(), s.ct()))).isEqualTo(EnvelopeException.CANNOT_OPEN);
    }

    @Test
    void aRotatedDeskOpensWhatWasSealedToItsOlderKeyUntilItDropsIt() throws Exception {
        Envelope.Sealed old = Signed.seal(dana.identity, sam.keys(), dana.payload(sam, "old"));
        sam.rotate();
        Envelope.Sealed fresh = Signed.seal(dana.identity, sam.keys(), dana.payload(sam, "new"));
        assertThat(Signed.open("ma", sam, old.enc(), old.ct()).payload().get("text")).isEqualTo("old");
        assertThat(Signed.open("ma", sam, fresh.enc(), fresh.ct()).payload().get("text")).isEqualTo("new");
        sam.boxes.remove(1);
        assertThat(reason(() -> Signed.open("ma", sam, old.enc(), old.ct()))).isEqualTo(EnvelopeException.CANNOT_OPEN);
    }

    @Test
    void anotherDeskCantOpenIt() throws Exception {
        Envelope.Sealed s = Signed.seal(dana.identity, sam.keys(), dana.payload(sam, "hi"));
        TestDesk eve = new TestDesk("sam@courier.example");   // even claiming Sam's address
        assertThat(reason(() -> Signed.open("ma", eve, s.enc(), s.ct()))).isEqualTo(EnvelopeException.CANNOT_OPEN);
    }

    @Test
    void aPayloadSignedForSomeoneElseAndResealedIsRefused() throws Exception {
        // Eve got a message from Dana, and seals its exact plaintext again to Sam: p.to names Eve, not Sam.
        TestDesk eve = new TestDesk("eve@courier.example");
        Envelope.Sealed toEve = Signed.seal(dana.identity, eve.keys(), dana.payload(eve, "for eve only"));
        byte[] plaintext = Envelope.open("ma", eve, toEve.enc(), toEve.ct()).plaintext();
        Envelope.Sealed resealed = Envelope.seal("ma", sam.address(), sam.keys().boxKey(), plaintext);
        assertThat(reason(() -> Signed.open("ma", sam, resealed.enc(), resealed.ct()))).isEqualTo(EnvelopeException.NOT_FOR_ME);
    }

    @Test
    void thePayloadIsStrict() throws Exception {
        byte[] good = Signed.wrap(dana.identity, dana.payload(sam, "hi"));
        assertThat(Signed.unwrap(good).from()).isEqualTo(dana.address());
        String g = new String(good, StandardCharsets.UTF_8);
        assertThat(reason(() -> Signed.unwrap(g.replace("{\"p\"", "{\"x\":1,\"p\"").getBytes()))).isEqualTo(EnvelopeException.FORMAT);
        assertThat(reason(() -> Signed.unwrap(g.replace("{\"p\"", "{\"p\":\"x\",\"p\"").getBytes()))).isEqualTo(EnvelopeException.FORMAT);
        assertThat(reason(() -> Signed.unwrap((g + "{}").getBytes()))).isEqualTo(EnvelopeException.FORMAT);
        assertThat(reason(() -> Signed.unwrap("[]".getBytes()))).isEqualTo(EnvelopeException.FORMAT);
        for (String[] change : new String[][] {
            {"v", "2"}, {"kind", "\"Bad Kind\""}, {"id", "\"not-a-ulid\""}, {"from", "\"Dana@courier.example\""},
            {"to", "\"sam+tag@courier.example\""}, {"at", "\"2026-11-14T20:00:00Z\""}, {"at", "\"yesterday\""},
        }) {
            Map<String, Object> p = dana.payload(sam, "hi");
            p.put(change[0], Json.parseObject(("{\"x\":" + change[1] + "}").getBytes(), 0, change[1].length() + 6).get("x"));
            assertThatThrownBy(() -> Signed.wrap(dana.identity, p)).as(change[0]).isInstanceOf(IllegalArgumentException.class);
        }
        Map<String, Object> missing = dana.payload(sam, "hi");
        missing.remove("at");
        assertThatThrownBy(() -> Signed.wrap(dana.identity, missing)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void thePaddingIsStrict() throws Exception {
        byte[] ok = Padding.pad("hello".getBytes());
        assertThat(ok).hasSize(256);
        assertThat(Padding.unpad(ok)).isEqualTo("hello".getBytes());
        byte[] noMarker = ok.clone();
        noMarker[5] = 0;
        assertThat(reason(() -> Padding.unpad(noMarker))).isEqualTo(EnvelopeException.FORMAT);
        byte[] junk = ok.clone();
        junk[200] = 1;
        assertThat(reason(() -> Padding.unpad(junk))).isEqualTo(EnvelopeException.FORMAT);
        byte[] tooLong = Arrays.copyOf(ok, 512);
        assertThat(reason(() -> Padding.unpad(tooLong))).isEqualTo(EnvelopeException.FORMAT);
        assertThat(reason(() -> Padding.unpad(new byte[300]))).isEqualTo(EnvelopeException.FORMAT);
        // A well-sealed envelope whose padding is wrong still fails after HPKE.
        byte[] padded = Padding.pad("x".getBytes());
        padded[100] = 9;
        org.bouncycastle.crypto.hpke.HPKE hpke = Envelope.hpke();
        var ctx = hpke.setupBaseS(hpke.deserializePublicKey(sam.keys().boxKey().bytes()), Envelope.info("ma"));
        byte[] ct = ctx.seal(Envelope.aad("ma", sam.address()), padded);
        assertThat(reason(() -> Envelope.open("ma", sam, ctx.getEncapsulation(), ct))).isEqualTo(EnvelopeException.FORMAT);
    }

    @Test
    void lowOrderKeysAndEncsAreRefused() throws Exception {
        HexFormat hex = HexFormat.of();
        String[] low = {
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0100000000000000000000000000000000000000000000000000000000000000",
            "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
            "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        };
        for (String k : low) {
            assertThatThrownBy(() -> BoxKey.of(hex.parseHex(k))).as(k).isInstanceOf(EnvelopeException.class);
        }
        Envelope.Sealed s = Signed.seal(dana.identity, sam.keys(), dana.payload(sam, "hi"));
        assertThat(reason(() -> Signed.open("ma", sam, new byte[32], s.ct()))).isEqualTo(EnvelopeException.CANNOT_OPEN);
        byte[] identityPoint = new byte[32];
        identityPoint[0] = 1;
        assertThatThrownBy(() -> IdentityKey.of(identityPoint)).isInstanceOf(EnvelopeException.class);
        assertThatThrownBy(() -> IdentityKey.of(new byte[31])).isInstanceOf(EnvelopeException.class);
        assertThatThrownBy(() -> IdentityKey.parse(dana.identityKey().text() + "=")).isInstanceOf(EnvelopeException.class);
    }

    @Test
    void addressesAndKindsAreChecked() {
        assertThat(reason(() -> Envelope.seal("MA", sam.address(), sam.keys().boxKey(), new byte[1]))).isEqualTo(EnvelopeException.FORMAT);
        assertThat(reason(() -> Envelope.seal("ma", "Sam@courier.example", sam.keys().boxKey(), new byte[1]))).isEqualTo(EnvelopeException.FORMAT);
        assertThat(reason(() -> Envelope.seal("ma", "sam\n@courier.example", sam.keys().boxKey(), new byte[1]))).isEqualTo(EnvelopeException.FORMAT);
        assertThat(reason(() -> Envelope.seal("ma", "nobody", sam.keys().boxKey(), new byte[1]))).isEqualTo(EnvelopeException.FORMAT);
    }

    @Test
    void anInvalidBindingIsNotSealedTo() throws Exception {
        PublishedKeys k = sam.keys();
        byte[] b = k.binding();
        b[0] ^= 1;
        PublishedKeys forged = new PublishedKeys(k.identityKey(), k.boxKey(), b, 3);
        assertThat(reason(() -> Signed.seal(dana.identity, forged, dana.payload(sam, "x")))).isEqualTo(EnvelopeException.RECIPIENT_KEY);
    }

    @Test
    @SuppressWarnings("unchecked")
    void aBigBodyRoundTripsThroughTheDrop() throws Exception {
        for (int n : new int[] {1, 65_000, Drop.CHUNK, Drop.CHUNK + 1, Drop.CHUNK * 3, 1_000_000, 5_000_000}) {
            byte[] body = bytes(n, n);
            Drop.Sealer sealer = Drop.sealer(BodySource.of(body));
            ByteArrayOutputStream drop = new ByteArrayOutputStream();
            sealer.write(drop);
            assertThat((long) drop.size()).isEqualTo(sealer.bucket());
            assertThat(Padding.isDropBucket(drop.size())).isTrue();
            // The reference travels inside the signed payload, as JSON.
            Map<String, Object> p = dana.payload(sam, "see the drop");
            p.put("drop", sealer.reference("dr-01JCQ4V9X3M7K2P8R5T6W0Y1A1"));
            Envelope.Sealed s = Signed.seal(dana.identity, sam.keys(), p);
            Signed.Verified v = Signed.open("ma", sam, s.enc(), s.ct()).verify(dana.identityKey());
            Map<String, Object> ref = (Map<String, Object>) v.payload().get("drop");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            Drop.open(ref, drop.size(), new ByteArrayInputStream(drop.toByteArray()), out);
            assertThat(out.toByteArray()).as("body %d", n).isEqualTo(body);
        }
    }

    @Test
    void aDropThatsCutGrownReorderedSwappedOrChangedFails() throws Exception {
        byte[] body = bytes(Drop.CHUNK * 4 + 777, 9);
        Drop.Sealer sealer = Drop.sealer(BodySource.of(body));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        sealer.write(out);
        byte[] drop = out.toByteArray();
        Map<String, Object> ref = roundTrip(sealer.reference("dr-01JCQ4V9X3M7K2P8R5T6W0Y1A2"));
        int sealedChunk = Drop.CHUNK + 16;
        long bytes = drop.length;

        assertThat(openDrop(ref, bytes, drop)).isNull();
        assertThat(openDrop(ref, bytes, Arrays.copyOf(drop, sealedChunk * 2))).isEqualTo(EnvelopeException.TRUNCATED);
        assertThat(openDrop(ref, bytes, Arrays.copyOf(drop, drop.length - 1))).isEqualTo(EnvelopeException.TRUNCATED);
        assertThat(openDrop(ref, bytes, Arrays.copyOf(drop, drop.length + 1))).isEqualTo(EnvelopeException.TRUNCATED);
        assertThat(openDrop(ref, bytes * 2, drop)).isEqualTo(EnvelopeException.FORMAT);
        byte[] swapped = drop.clone();
        System.arraycopy(drop, 0, swapped, sealedChunk, sealedChunk);
        System.arraycopy(drop, sealedChunk, swapped, 0, sealedChunk);
        assertThat(openDrop(ref, bytes, swapped)).isEqualTo(EnvelopeException.CANNOT_OPEN);
        for (int at : new int[] {0, 17, sealedChunk - 1, sealedChunk * 2 + 5, sealedChunk * 4 + 700}) {
            byte[] flipped = drop.clone();
            flipped[at] ^= 0x40;
            assertThat(openDrop(ref, bytes, flipped)).as("byte %d", at).isEqualTo(EnvelopeException.CANNOT_OPEN);
        }
        // The last chunk can't be dropped and the one before passed off as last: its aad says "not last".
        Map<String, Object> shorter = new LinkedHashMap<>(ref);
        shorter.put("len", (long) Drop.CHUNK * 4);
        shorter.put("bytes", Padding.dropBucket(Drop.ciphertextLength(Drop.CHUNK * 4L)));
        assertThat(openDrop(shorter, (long) shorter.get("bytes"), Arrays.copyOf(drop, (int) (long) (Long) shorter.get("bytes")))).isEqualTo(EnvelopeException.CANNOT_OPEN);
        // Another body's drop under this key, or this drop under another key.
        Drop.Sealer other = Drop.sealer(BodySource.of(body));
        ByteArrayOutputStream o2 = new ByteArrayOutputStream();
        other.write(o2);
        assertThat(openDrop(ref, bytes, o2.toByteArray())).isEqualTo(EnvelopeException.CANNOT_OPEN);
        // A changed digest in the reference: every chunk opens, the body doesn't match.
        Map<String, Object> wrongSha = new LinkedHashMap<>(ref);
        wrongSha.put("sha256", java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]));
        assertThat(openDrop(wrongSha, bytes, drop)).isEqualTo(EnvelopeException.BODY_MISMATCH);
        Map<String, Object> extra = new LinkedHashMap<>(ref);
        extra.put("more", 1);
        assertThat(openDrop(extra, bytes, drop)).isEqualTo(EnvelopeException.FORMAT);
    }

    private static Map<String, Object> roundTrip(Map<String, Object> m) throws Exception {
        byte[] b = Json.bytes(m);
        return Json.parseObject(b, 0, b.length);
    }

    private static String openDrop(Map<String, Object> ref, long bytes, byte[] drop) throws IOException {
        try {
            Drop.open(ref, bytes, new ByteArrayInputStream(drop), new ByteArrayOutputStream());
            return null;
        } catch (EnvelopeException e) {
            return e.reason();
        }
    }

    @Test
    void aSourceThatChangesAfterDigestingFailsTheDrop() throws Exception {
        byte[] body = bytes(200_000, 4);
        AtomicInteger opens = new AtomicInteger();
        BodySource changing = new BodySource() {
            @Override
            public long length() {
                return body.length;
            }

            @Override
            public InputStream open() {
                byte[] b = body.clone();
                if (opens.getAndIncrement() > 0) {
                    b[150_000] ^= 1;
                }
                return new ByteArrayInputStream(b);
            }
        };
        Drop.Sealer s = Drop.sealer(changing);
        assertThatThrownBy(() -> s.write(new ByteArrayOutputStream())).isInstanceOf(IOException.class).hasMessageContaining("changed");
        assertThatThrownBy(() -> s.write(new ByteArrayOutputStream())).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> s.reference("not-an-id")).isInstanceOf(IllegalArgumentException.class);
        assertThat(reason(() -> Drop.sealer(BodySource.of(new byte[0])))).isEqualTo(EnvelopeException.FORMAT);
        BodySource huge = new BodySource() {
            @Override
            public long length() {
                return Drop.MAX_BODY + 1;
            }

            @Override
            public InputStream open() {
                throw new AssertionError("not read");
            }
        };
        assertThat(reason(() -> Drop.sealer(huge))).isEqualTo(EnvelopeException.TOO_LARGE);
    }

    @Test
    void aMailPayloadRidesOnlyInAMailEnvelopeUnderItsOwnSigningDomain() throws Exception {
        IdentityKeyPair door = IdentityKeyPair.generate(TestDesk.RANDOM);
        Map<String, Object> mail = dana.payload(sam, "spoofed");
        mail.put("kind", "mail");
        mail.put("from", "mailer-daemon@courier.example");
        mail.put("verdicts", Map.of("dmarc", "PASS"));
        // Security CK-L1: a member's desk seals a "mail" payload in an ordinary ma envelope: refused.
        Envelope.Sealed asMa = Envelope.seal("ma", sam.address(), sam.keys().boxKey(), Signed.wrap(dana.identity, mail));
        assertThat(reason(() -> Signed.open("ma", sam, asMa.enc(), asMa.ct()))).isEqualTo(EnvelopeException.FORMAT);
        // A member's message in a mail envelope: refused too.
        Envelope.Sealed msgAsMail = Envelope.seal("mail", sam.address(), sam.keys().boxKey(), Signed.wrap(dana.identity, dana.payload(sam, "x")));
        assertThat(reason(() -> Signed.open("mail", sam, msgAsMail.enc(), msgAsMail.ct()))).isEqualTo(EnvelopeException.FORMAT);
        // The door's own: opens, and verifies only with the door's key, under the mail signing domain.
        Envelope.Sealed real = Envelope.seal("mail", sam.address(), sam.keys().boxKey(), Signed.wrap(door, mail));
        Signed.Unverified u = Signed.open("mail", sam, real.enc(), real.ct());
        assertThat(u.verify(door.publicKey()).kind()).isEqualTo("mail");
        assertThat(reason(() -> u.verify(dana.identityKey()))).isEqualTo(EnvelopeException.BAD_SIGNATURE);
        // A desk's signature over the same bytes, in the ma domain, doesn't stand for the door's.
        String p = u.p();
        byte[] maSig = door.sign(("ma-courier/v1 sig\n" + p).getBytes(StandardCharsets.UTF_8));
        Signed.Unverified crossDomain = new Signed.Unverified(p, maSig, u.payload());
        assertThat(reason(() -> crossDomain.verify(door.publicKey()))).isEqualTo(EnvelopeException.BAD_SIGNATURE);
    }

    @Test
    void addressesFollowTheContractsGrammarAndPayloadsNeverPrintTheirText() throws Exception {
        for (String bad : new String[] {"a b@courier.example", "da@courier.example", "dana@@courier.example", "dana@courier",
            "dana..x@courier.example", "-dana@courier.example", "dana/x@courier.example", "dańa@courier.example", "dana@courier.example."}) {
            Map<String, Object> p = dana.payload(sam, "hi");
            p.put("from", bad);
            assertThatThrownBy(() -> Signed.wrap(dana.identity, p)).as(bad).isInstanceOf(IllegalArgumentException.class);
        }
        Envelope.Sealed s = Signed.seal(dana.identity, sam.keys(), dana.payload(sam, "a private sentence"));
        Signed.Unverified u = Signed.open("ma", sam, s.enc(), s.ct());
        assertThat(u.toString()).doesNotContain("private").contains("message");
        assertThat(u.verify(dana.identityKey()).toString()).doesNotContain("private");
    }
}
