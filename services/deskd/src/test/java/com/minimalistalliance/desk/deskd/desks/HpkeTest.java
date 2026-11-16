package com.minimalistalliance.desk.deskd.desks;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.spec.NamedParameterSpec;
import java.security.spec.XECPrivateKeySpec;
import java.util.HexFormat;
import javax.crypto.AEADBadTagException;
import javax.crypto.KEM;
import org.junit.jupiter.api.Test;

/** RFC 9180 appendix A.2.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305, base mode. */
class HpkeTest {
    private static final HexFormat HEX = HexFormat.of();
    private static final byte[] INFO = HEX.parseHex("4f6465206f6e2061204772656369616e2055726e");
    private static final byte[] SK_RM = HEX.parseHex("8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb");
    private static final byte[] ENC = HEX.parseHex("1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a");
    private static final byte[] SHARED = HEX.parseHex("0bbe78490412b4bbea4812666f7916932b828bba79942424abb65244930d69a7");
    private static final byte[] KEY = HEX.parseHex("ad2744de8e17f4ebba575b3f5f5a8fa1f69c2a07f6e7500bc60ca6e3e3ec1c91");
    private static final byte[] BASE_NONCE = HEX.parseHex("5c4d98150661b848853b547f");
    private static final byte[] PT = HEX.parseHex("4265617574792069732074727574682c20747275746820626561757479");
    private static final byte[] AAD0 = HEX.parseHex("436f756e742d30");
    private static final byte[] CT0 = HEX.parseHex(
            "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28");

    private static PrivateKey skR() throws Exception {
        return KeyFactory.getInstance("XDH").generatePrivate(new XECPrivateKeySpec(NamedParameterSpec.X25519, SK_RM));
    }

    @Test
    void jdkDhkemMatchesTheRfcSharedSecret() throws Exception {
        byte[] shared = KEM.getInstance("DHKEM").newDecapsulator(skR()).decapsulate(ENC).getEncoded();
        assertThat(shared).isEqualTo(SHARED);
    }

    @Test
    void keyScheduleMatchesTheRfc() throws Exception {
        Hpke.KeySchedule ks = Hpke.keySchedule(SHARED, INFO);
        assertThat(ks.key()).isEqualTo(KEY);
        assertThat(ks.baseNonce()).isEqualTo(BASE_NONCE);
    }

    @Test
    void opensTheRfcsFirstCiphertext() throws Exception {
        assertThat(Hpke.open(skR(), ENC, INFO, AAD0, CT0)).isEqualTo(PT);
    }

    @Test
    void roundTripsAndRejectsTampering() throws Exception {
        KeyPair r = KeyPairGenerator.getInstance("X25519").generateKeyPair();
        byte[] msg = "hello desk".getBytes(StandardCharsets.UTF_8);
        byte[] aad = "aad".getBytes(StandardCharsets.UTF_8);
        Hpke.Sealed s = Hpke.seal(r.getPublic(), INFO, aad, msg);
        assertThat(Hpke.open(r.getPrivate(), s.enc(), INFO, aad, s.ct())).isEqualTo(msg);

        byte[] bad = s.ct().clone();
        bad[0] ^= 1;
        assertThatThrownBy(() -> Hpke.open(r.getPrivate(), s.enc(), INFO, aad, bad)).isInstanceOf(AEADBadTagException.class);
        assertThatThrownBy(() -> Hpke.open(r.getPrivate(), s.enc(), INFO, "other".getBytes(StandardCharsets.UTF_8), s.ct()))
                .isInstanceOf(AEADBadTagException.class);
    }
}
