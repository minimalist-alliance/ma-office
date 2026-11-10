package com.minimalistalliance.desk.deskd.session;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Collections;
import org.junit.jupiter.api.Test;

class SdpFingerprintsTest {

    private static final String HEX = "ab".repeat(32);
    private static final String COLONS = String.join(":", Collections.nCopies(32, "AB"));
    private static final String OTHER = String.join(":", Collections.nCopies(32, "CD"));

    @Test
    void oneLinePerSectionAsChromeWrites() {
        String sdp = "v=0\r\nm=audio\r\na=fingerprint:sha-256 " + COLONS + "\r\nm=application\r\na=fingerprint:sha-256 " + COLONS + "\r\n";
        assertThat(SdpFingerprints.offerMatches(sdp, HEX)).isTrue();
    }

    @Test
    void oneLineAtSessionLevelAsFirefoxWrites() {
        String sdp = "v=0\r\na=fingerprint:sha-256 " + COLONS + "\r\nm=audio\r\nm=application\r\n";
        assertThat(SdpFingerprints.offerMatches(sdp, HEX)).isTrue();
    }

    @Test
    void lowercaseAndBareNewlinesAreFine() {
        String sdp = "a=fingerprint:SHA-256 " + COLONS.toLowerCase() + "\n";
        assertThat(SdpFingerprints.offerMatches(sdp, HEX)).isTrue();
    }

    @Test
    void anyOtherLineFailsTheWholeOffer() {
        String sdp = "a=fingerprint:sha-256 " + COLONS + "\r\na=fingerprint:sha-256 " + OTHER + "\r\n";
        assertThat(SdpFingerprints.offerMatches(sdp, HEX)).isFalse();
    }

    @Test
    void anotherHashFailsTheWholeOffer() {
        String sdp = "a=fingerprint:sha-256 " + COLONS + "\r\na=fingerprint:sha-1 " + COLONS + "\r\n";
        assertThat(SdpFingerprints.offerMatches(sdp, HEX)).isFalse();
    }

    @Test
    void noLineAtAllFails() {
        assertThat(SdpFingerprints.offerMatches("v=0\r\nm=audio\r\n", HEX)).isFalse();
    }

    @Test
    void malformedValuesFail() {
        assertThat(SdpFingerprints.offerMatches("a=fingerprint:sha-256\r\n", HEX)).isFalse();
        assertThat(SdpFingerprints.offerMatches("a=fingerprint:sha-256 zz:zz\r\n", HEX)).isFalse();
        assertThat(SdpFingerprints.offerMatches("a=fingerprint:sha-256 AB:AB\r\n", HEX)).isFalse();
        assertThat(SdpFingerprints.offerMatches("a=fingerprint:sha-256 " + COLONS + "\r\n", "not hex")).isFalse();
    }
}
