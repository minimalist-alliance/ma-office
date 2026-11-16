package com.minimalistalliance.desk.courier.envelope;

import static org.assertj.core.api.Assertions.assertThat;

import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.HexFormat;
import org.bouncycastle.crypto.AsymmetricCipherKeyPair;
import org.bouncycastle.crypto.hpke.HPKE;
import org.bouncycastle.crypto.hpke.HPKEContext;
import org.bouncycastle.crypto.hpke.HPKEContextWithEncapsulation;
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters;
import org.junit.jupiter.api.Test;

/**
 * The primitives under the envelope, against their RFCs' published vectors: HPKE suite 1 (RFC 9180 A.2.1, base mode) and
 * Ed25519 (RFC 8032 §7.1), and Bouncy Castle's Ed25519 against the JDK's as a second opinion.
 */
class PrimitiveVectorsTest {

    private static final HexFormat HEX = HexFormat.of();

    // RFC 9180 A.2.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305.
    private static final byte[] INFO = HEX.parseHex("4f6465206f6e2061204772656369616e2055726e");
    private static final byte[] IKM_E = HEX.parseHex("909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b");
    private static final byte[] SK_RM = HEX.parseHex("8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb");
    private static final byte[] ENC = HEX.parseHex("1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a");
    private static final byte[] PT = HEX.parseHex("4265617574792069732074727574682c20747275746820626561757479");
    private static final byte[] AAD0 = HEX.parseHex("436f756e742d30");
    private static final byte[] CT0 = HEX.parseHex(
            "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28");

    @Test
    void hpkeSuiteOneOpensTheRfcsCiphertext() throws Exception {
        HPKE hpke = Envelope.hpke();
        X25519PrivateKeyParameters sk = new X25519PrivateKeyParameters(SK_RM, 0);
        HPKEContext r = hpke.setupBaseR(ENC, new AsymmetricCipherKeyPair(sk.generatePublicKey(), sk), INFO);
        assertThat(r.open(AAD0, CT0)).isEqualTo(PT);
    }

    @Test
    void hpkeSuiteOneSealsTheRfcsCiphertextFromItsEphemeralSeed() throws Exception {
        HPKE hpke = Envelope.hpke();
        X25519PrivateKeyParameters sk = new X25519PrivateKeyParameters(SK_RM, 0);
        HPKEContextWithEncapsulation s = hpke.setupBaseS(sk.generatePublicKey(), INFO, hpke.deriveKeyPair(IKM_E));
        assertThat(s.getEncapsulation()).isEqualTo(ENC);
        assertThat(s.seal(AAD0, PT)).isEqualTo(CT0);
        // The context's sequence moves on: the next seal is a different nonce, so a different ciphertext.
        assertThat(s.seal(AAD0, PT)).isNotEqualTo(CT0);
    }

    @Test
    void hpkeSequencesStayInStepAcrossManyMessages() throws Exception {
        HPKE hpke = Envelope.hpke();
        X25519PrivateKeyParameters sk = new X25519PrivateKeyParameters(SK_RM, 0);
        HPKEContextWithEncapsulation s = hpke.setupBaseS(sk.generatePublicKey(), INFO);
        HPKEContext r = hpke.setupBaseR(s.getEncapsulation(), new AsymmetricCipherKeyPair(sk.generatePublicKey(), sk), INFO);
        for (int i = 0; i < 300; i++) {
            byte[] aad = ("Count-" + i).getBytes();
            byte[] pt = ("message " + i).getBytes();
            assertThat(r.open(aad, s.seal(aad, pt))).isEqualTo(pt);
        }
    }

    // RFC 8032 §7.1, tests 1 and 2.
    @Test
    void ed25519MatchesTheRfc() throws Exception {
        check("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
                "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
                "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
        check("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
                "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
                "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00");
    }

    private static void check(String seed, String pub, String msg, String sig) throws Exception {
        IdentityKeyPair k = IdentityKeyPair.fromSeed(HEX.parseHex(seed));
        assertThat(k.publicKey().bytes()).isEqualTo(HEX.parseHex(pub));
        assertThat(k.sign(HEX.parseHex(msg))).isEqualTo(HEX.parseHex(sig));
        assertThat(k.publicKey().verifies(HEX.parseHex(msg), HEX.parseHex(sig))).isTrue();
    }

    @Test
    void bouncyCastlesEd25519AgreesWithTheJdks() throws Exception {
        SecureRandom random = new SecureRandom();
        KeyFactory kf = KeyFactory.getInstance("Ed25519");
        byte[] spki = HEX.parseHex("302a300506032b6570032100");
        for (int i = 0; i < 50; i++) {
            IdentityKeyPair k = IdentityKeyPair.generate(random);
            byte[] msg = new byte[random.nextInt(300)];
            random.nextBytes(msg);
            byte[] sig = k.sign(msg);
            PublicKey jdk = kf.generatePublic(new X509EncodedKeySpec(java.nio.ByteBuffer.allocate(44).put(spki).put(k.publicKey().bytes()).array()));
            Signature v = Signature.getInstance("Ed25519");
            v.initVerify(jdk);
            v.update(msg);
            assertThat(v.verify(sig)).isTrue();
            msg = msg.length == 0 ? new byte[] {1} : msg;
            msg[0] ^= 1;
            assertThat(k.publicKey().verifies(msg, sig)).isFalse();
        }
    }
}
