package com.minimalistalliance.desk.courier.envelope;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.courier.envelope.KeyCheck.Verdict;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Published keys and their binding, fingerprints, safety numbers, pin checks and padding sizes. */
class KeysTest {

    private final TestDesk dana = new TestDesk("dana@courier.example");
    private final TestDesk sam = new TestDesk("sam@courier.example");

    @Test
    void theBindingVerifiesRoundTripsAndRefusesAnyChange() throws Exception {
        PublishedKeys k = sam.keys();
        assertThat(k.bindingValid()).isTrue();
        assertThat(k.toJson().keySet()).containsExactly("identityKey", "boxKey", "binding");
        PublishedKeys back = PublishedKeys.fromJson(k.toJson());
        assertThat(back.sameKeys(k)).isTrue();
        assertThat(back.bindingValid()).isTrue();
        assertThat(back.keysVersion()).isEqualTo(-1);

        // A directory answer with the platform's extra fields.
        Map<String, Object> answer = new LinkedHashMap<>(k.toJson());
        answer.put("address", sam.address());
        answer.put("fingerprint", "0000-0000-0000-0000-0000-0000-0000-0000");
        answer.put("keysVersion", 4);
        assertThat(PublishedKeys.fromJson(answer).keysVersion()).isEqualTo(4);

        assertThat(new PublishedKeys(k.identityKey(), dana.keys().boxKey(), k.binding(), -1).bindingValid()).isFalse();
        assertThat(new PublishedKeys(dana.identityKey(), k.boxKey(), k.binding(), -1).bindingValid()).isFalse();
        Map<String, Object> bad = new LinkedHashMap<>(k.toJson());
        bad.put("binding", "AAAA");
        assertThatThrownBy(() -> PublishedKeys.fromJson(bad)).isInstanceOf(EnvelopeException.class);
    }

    @Test
    void theBindingIsTheContractsSignatureOverTheBoxKeysText() {
        PublishedKeys k = sam.keys();
        byte[] input = ("ma-courier-key/v1 bind\n" + k.boxKey().text()).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        assertThat(k.identityKey().verifies(input, k.binding())).isTrue();
    }

    @Test
    void theFingerprintIsTheContractsAndCoversBothKeys() throws Exception {
        PublishedKeys k = sam.keys();
        assertThat(k.fingerprint()).matches("([0-9a-f]{4}-){7}[0-9a-f]{4}");
        byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(
                java.nio.ByteBuffer.allocate(18 + 64).put("ma-courier-key/v1\n".getBytes()).put(k.identityKey().bytes()).put(k.boxKey().bytes()).array());
        assertThat(k.fingerprint().replace("-", "")).isEqualTo(java.util.HexFormat.of().formatHex(d, 0, 16));
        assertThat(k.matches(k.fingerprint().toUpperCase())).isTrue();
        assertThat(dana.keys().matches(k.fingerprint())).isFalse();
        sam.rotate();
        assertThat(sam.keys().fingerprint()).isNotEqualTo(k.fingerprint());
    }

    @Test
    void safetyNumbersAreSymmetricSixtyDigitsAndFollowOnlyTheIdentities() {
        String ds = SafetyNumber.between(dana.identityKey(), sam.identityKey());
        assertThat(ds).matches("(\\d{5} ){11}\\d{5}");
        assertThat(SafetyNumber.between(sam.identityKey(), dana.identityKey())).isEqualTo(ds);
        sam.rotate();
        assertThat(SafetyNumber.between(dana.identityKey(), sam.keys().identityKey())).isEqualTo(ds);
        TestDesk reset = new TestDesk(sam.address());
        assertThat(SafetyNumber.between(dana.identityKey(), reset.identityKey())).isNotEqualTo(ds);
    }

    @Test
    void aSafetyNumberIsStableAcrossReleases() {
        // Known answer: a change here changes every member's numbers, so it must be deliberate.
        IdentityKey a = IdentityKeyPair.fromSeed(seed(1)).publicKey();
        IdentityKey b = IdentityKeyPair.fromSeed(seed(2)).publicKey();
        assertThat(SafetyNumber.between(a, b)).isEqualTo(KnownAnswers.SAFETY_NUMBER_1_2);
    }

    static byte[] seed(int n) {
        byte[] s = new byte[32];
        java.util.Arrays.fill(s, (byte) n);
        return s;
    }

    @Test
    void pinChecksFollowThePlansRules() {
        PublishedKeys k = new PublishedKeys(sam.keys().identityKey(), sam.keys().boxKey(), sam.keys().binding(), 2);
        assertThat(KeyCheck.check(null, -1, k, null)).isEqualTo(Verdict.FIRST_UNVERIFIED);
        assertThat(KeyCheck.check(null, -1, k, k.fingerprint())).isEqualTo(Verdict.FIRST_VERIFIED);
        assertThat(KeyCheck.check(null, -1, k, dana.keys().fingerprint())).isEqualTo(Verdict.INVITE_MISMATCH);
        assertThat(KeyCheck.check(sam.identityKey(), 2, k, null)).isEqualTo(Verdict.SAME);
        assertThat(KeyCheck.check(dana.identityKey(), 2, k, null)).isEqualTo(Verdict.CHANGED);

        // A box key rotation under the same identity is the same contact; an older answer is kept out.
        sam.rotate();
        PublishedKeys rotated = new PublishedKeys(sam.keys().identityKey(), sam.keys().boxKey(), sam.keys().binding(), 3);
        assertThat(KeyCheck.check(sam.identityKey(), 2, rotated, null)).isEqualTo(Verdict.SAME);
        assertThat(KeyCheck.check(sam.identityKey(), 3, k, null)).isEqualTo(Verdict.STALE);

        byte[] b = k.binding();
        b[3] ^= 1;
        assertThat(KeyCheck.check(sam.identityKey(), -1, new PublishedKeys(k.identityKey(), k.boxKey(), b, 2), null)).isEqualTo(Verdict.INVALID);
        assertThat(KeyCheck.check(sam.identityKey(), -1, null, null)).isEqualTo(Verdict.INVALID);
        // A box key bound by someone else's identity is a different identity, whatever the box key.
        PublishedKeys crossed = PublishedKeys.bind(dana.identity, sam.keys().boxKey());
        assertThat(KeyCheck.check(sam.identityKey(), -1, crossed, null)).isEqualTo(Verdict.CHANGED);

        assertThat(Verdict.SAME.usable()).isTrue();
        assertThat(Verdict.FIRST_UNVERIFIED.usable()).isTrue();
        assertThat(Verdict.CHANGED.usable()).isFalse();
        assertThat(Verdict.STALE.usable()).isFalse();
        assertThat(KeyCheck.sender(null, dana.identityKey())).isEqualTo(Verdict.FIRST_UNVERIFIED);
        assertThat(KeyCheck.sender(dana.identityKey(), dana.identityKey())).isEqualTo(Verdict.SAME);
        assertThat(KeyCheck.sender(dana.identityKey(), sam.identityKey())).isEqualTo(Verdict.CHANGED);
    }

    @Test
    void theContractsBuckets() {
        assertThat(Padding.envelopeBucket(0)).isEqualTo(256);
        assertThat(Padding.envelopeBucket(255)).isEqualTo(256);
        assertThat(Padding.envelopeBucket(256)).isEqualTo(512);
        assertThat(Padding.envelopeBucket(4095)).isEqualTo(4096);
        assertThat(Padding.envelopeBucket(4096)).isEqualTo(8192);
        assertThat(Padding.envelopeBucket(65_535)).isEqualTo(65_536);
        assertThat(Padding.envelopeBucket(65_536)).isEqualTo(-1);
        for (int b : new int[] {256, 512, 768, 3840, 4096, 8192, 16_384, 32_768, 65_536}) {
            assertThat(Padding.isEnvelopeBucket(b)).as("%d", b).isTrue();
        }
        for (int b : new int[] {0, 255, 300, 4352, 12_288, 65_537, 131_072}) {
            assertThat(Padding.isEnvelopeBucket(b)).as("%d", b).isFalse();
        }
        assertThat(Padding.dropBucket(1)).isEqualTo(65_536);
        assertThat(Padding.dropBucket(65_537)).isEqualTo(131_072);
        assertThat(Padding.dropBucket(64L << 20)).isEqualTo(64L << 20);
        assertThat(Padding.dropBucket((64L << 20) + 1)).isEqualTo(-1);
        assertThat(Padding.dropBucket(Drop.ciphertextLength(Drop.MAX_BODY))).isEqualTo(64L << 20);
    }
}
