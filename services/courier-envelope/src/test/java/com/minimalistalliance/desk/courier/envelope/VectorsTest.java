package com.minimalistalliance.desk.courier.envelope;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Published test vectors, for anyone else who seals or opens Courier envelopes (Platform's relay checks the outer shape;
 * the mail door will seal {@code mail} envelopes): from these inputs, exactly these bytes. HPKE's ephemeral key is fixed by
 * {@code ikmE} (RFC 9180's DeriveKeyPair), a drop's content key by {@code dropKey}; Ed25519 is deterministic. The file is
 * {@code src/test/resources/courier-envelope/vectors.json}; this test regenerates it and fails if a byte differs. To change
 * the format on purpose, run with {@code -Dcourier.envelope.writeVectors=true} and say so in the commit.
 */
class VectorsTest {

    private static final HexFormat HEX = HexFormat.of();
    static final Path FILE = Path.of("src/test/resources/courier-envelope/vectors.json");

    static byte[] seed(int n) {
        byte[] s = new byte[32];
        Arrays.fill(s, (byte) n);
        return s;
    }

    @Test
    void theVectorsAreReproducedByteForByte() throws Exception {
        String generated = new String(Json.MAPPER.with(tools.jackson.jr.ob.JSON.Feature.PRETTY_PRINT_OUTPUT).asBytes(generate()),
                StandardCharsets.UTF_8) + "\n";
        if (Boolean.getBoolean("courier.envelope.writeVectors")) {
            Files.writeString(FILE, generated);
        }
        assertThat(Files.readString(FILE)).isEqualTo(generated);
    }

    private static Map<String, Object> m(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    static Map<String, Object> generate() throws Exception {
        IdentityKeyPair samId = IdentityKeyPair.fromSeed(seed(0x11));
        BoxKeyPair samBox = BoxKeyPair.fromSecret(seed(0x22), 0);
        PublishedKeys samKeys = PublishedKeys.bind(samId, samBox.publicKey());
        IdentityKeyPair dana = IdentityKeyPair.fromSeed(seed(0x33));
        BoxKeyPair danaBox = BoxKeyPair.fromSecret(seed(0x34), 0);
        IdentityKeyPair door = IdentityKeyPair.fromSeed(seed(0x44));
        String samAddress = "sam@courier.minimalistalliance.com";
        String danaAddress = "dana@courier.minimalistalliance.com";
        Envelope.Recipient sam = new Envelope.Recipient() {
            @Override
            public List<String> addresses() {
                return List.of(samAddress);
            }

            @Override
            public List<BoxKeyPair> boxKeys() {
                return List.of(samBox);
            }
        };

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("format", "ma-platform contract 0.4.0 section 2 (relay.md); ma-desk draft ADR \"Courier's envelopes\"");
        out.put("hpke", "RFC 9180 base mode; KEM 0x0020 DHKEM(X25519, HKDF-SHA256), KDF 0x0001 HKDF-SHA256, AEAD 0x0003 ChaCha20-Poly1305");
        out.put("recipient", m("address", samAddress, "identitySeed", HEX.formatHex(seed(0x11)), "boxSecret", HEX.formatHex(seed(0x22)),
                "publish", samKeys.toJson(), "fingerprint", samKeys.fingerprint()));
        PublishedKeys danaKeys = PublishedKeys.bind(dana, danaBox.publicKey());
        out.put("sender", m("address", danaAddress, "identitySeed", HEX.formatHex(seed(0x33)), "boxSecret", HEX.formatHex(seed(0x34)),
                "publish", danaKeys.toJson(), "fingerprint", danaKeys.fingerprint()));
        out.put("safetyNumber", SafetyNumber.between(dana.publicKey(), samId.publicKey()));

        List<Object> cases = new ArrayList<>();
        Map<String, Object> p1 = m("v", 1, "kind", "message", "id", "01JCQ4V9X3M7K2P8R5T6W0Y1Z2", "from", danaAddress, "to", samAddress,
                "at", "2026-11-14T20:00:00.123Z", "text", "Lunch at noon?");
        cases.add(sealed("ma-inline", Envelope.MA, dana, samKeys, sam, p1, seed(0x55)));

        byte[] big = new byte[150_000];
        for (int i = 0; i < big.length; i++) {
            big[i] = (byte) (i * 31 + 7);
        }
        byte[] dropKey = new byte[Drop.KEY_BYTES];
        Arrays.fill(dropKey, (byte) 0x66);
        Drop.Sealer sealer = Drop.sealer(BodySource.of(big), dropKey);
        ByteArrayOutputStream dropOut = new ByteArrayOutputStream();
        sealer.write(dropOut);
        byte[] drop = dropOut.toByteArray();
        Map<String, Object> p2 = m("v", 1, "kind", "message", "id", "01JCQ4V9X3M7K2P8R5T6W0Y1Z3", "from", danaAddress, "to", samAddress,
                "at", "2026-11-14T20:00:01.000Z", "text", "The photos", "drop", sealer.reference("dr-01JCQ4V9X3M7K2P8R5T6W0Y1Z4"));
        Map<String, Object> c2 = sealed("ma-with-drop", Envelope.MA, dana, samKeys, sam, p2, seed(0x77));
        c2.put("dropBody", "byte i = (i * 31 + 7) mod 256, " + big.length + " bytes, SHA-256 " + HEX.formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(big)));
        c2.put("dropKey", HEX.formatHex(dropKey));
        c2.put("dropLength", drop.length);
        c2.put("dropSha256", HEX.formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(drop)));
        c2.put("dropFirst64Hex", HEX.formatHex(drop, 0, 64));
        ByteArrayOutputStream back = new ByteArrayOutputStream();
        Drop.open(sealer.reference("dr-01JCQ4V9X3M7K2P8R5T6W0Y1Z4"), drop.length, new ByteArrayInputStream(drop), back);
        assertThat(back.toByteArray()).isEqualTo(big);
        cases.add(c2);

        // Proposed for 0.4.1 (CR-2.3): the mail door seals a signed payload under its own key and signing domain, from a reserved
        // name, with the raw message inline.
        Map<String, Object> verdicts = m("spf", "PASS", "dkim", "PASS", "dmarc", "PASS", "spam", "PASS", "virus", "PASS");
        byte[] mail = ("From: Alex <alex@example.org>\r\nTo: " + samAddress + "\r\nSubject: Hello\r\nMessage-ID: <vector-1@example.org>\r\n"
                + "Date: Fri, 14 Nov 2026 20:00:00 +0000\r\n\r\nHi Sam.\r\n").getBytes(StandardCharsets.US_ASCII);
        Map<String, Object> p3 = m("v", 1, "kind", "mail", "id", "01JCQ4V9X3M7K2P8R5T6W0Y1Z5", "from", "mailer-daemon@courier.minimalistalliance.com",
                "to", samAddress, "at", "2026-11-14T20:00:02.000Z", "mailFrom", "alex@example.org", "verdicts", verdicts,
                "raw", java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(mail));
        Map<String, Object> c3 = sealed("mail-proposed", Envelope.MAIL, door, samKeys, sam, p3, seed(0x88));
        c3.put("doorIdentitySeed", HEX.formatHex(seed(0x44)));
        c3.put("doorIdentityKey", door.publicKey().text());
        cases.add(c3);
        out.put("cases", cases);
        return out;
    }

    private static Map<String, Object> sealed(String name, String kind, IdentityKeyPair signer, PublishedKeys to, Envelope.Recipient opener,
            Map<String, Object> payload, byte[] ikmE) throws Exception {
        byte[] plaintext = Signed.wrap(signer, payload);
        Envelope.Sealed s = Envelope.seal(kind, (String) payload.get("to"), to.boxKey(), plaintext, ikmE);
        Signed.Unverified u = Signed.open(kind, opener, s.enc(), s.ct());
        assertThat(u.verify(signer.publicKey()).p()).isEqualTo(new String(Json.bytes(payload), StandardCharsets.UTF_8));
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("name", name);
        v.put("kind", kind);
        v.put("ikmE", HEX.formatHex(ikmE));
        v.put("plaintext", new String(plaintext, StandardCharsets.UTF_8));
        v.put("paddedLength", Padding.envelopeBucket(plaintext.length));
        v.put("relay", s.toJson());
        return v;
    }
}
