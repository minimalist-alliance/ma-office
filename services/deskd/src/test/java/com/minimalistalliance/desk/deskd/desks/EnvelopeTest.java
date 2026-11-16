package com.minimalistalliance.desk.deskd.desks;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The envelope and the desk's keys (draft ADR §14): sealed, signed, and refused when anything about it is wrong. */
class EnvelopeTest {

    @TempDir
    Path dir;

    private final DeskKeys a = DeskKeys.fresh("d-aaaa");
    private final DeskKeys b = DeskKeys.fresh("d-bbbb");
    private final DeskKeys c = DeskKeys.fresh("d-cccc");

    private static Map<String, Object> payload(String kind, String from, String to) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", 1);
        p.put("kind", kind);
        p.put("id", Envelope.newId());
        p.put("grantId", "dg-aaaaaaaaaaaaaaaaaaaa");
        p.put("from", from);
        p.put("to", to);
        p.put("account", "user-1");
        p.put("sentAt", 1_762_850_000_000L);
        p.put("seq", 2);
        p.put("text", "hello, desk");
        return p;
    }

    /** As the office carries it: JSON text, parsed again. */
    private static Map<String, Object> carried(Map<String, Object> env) throws Exception {
        return Json.parseObject(Json.bytes(env));
    }

    @Test
    void aSealedEnvelopeOpensOnlyOnItsDeskAndVerifiesOnlyWithItsSendersKey() throws Exception {
        Map<String, Object> env = carried(Envelope.seal(a, b.pub(), payload("msg", "d-aaaa", "d-bbbb")));
        assertThat(env.keySet()).containsExactly("v", "id", "from", "to", "enc", "ct");
        assertThat(new String(Json.bytes(env), StandardCharsets.UTF_8)).doesNotContain("hello");

        Envelope.Opened opened = Envelope.open(b, env);
        assertThat(opened.sealed()).isTrue();
        assertThat(opened.payload()).containsEntry("text", "hello, desk");
        assertThat(Envelope.verify(a.pub(), opened)).isTrue();
        // A key pinned for another desk, or another desk's key under this one's id, never verifies it.
        assertThat(Envelope.verify(c.pub(), opened)).isFalse();
        assertThat(Envelope.verify(new DeskKeys.Pub("d-aaaa", c.pub().sig(), c.pub().box(), c.pub().binding()), opened))
                .isFalse();

        assertThatThrownBy(() -> Envelope.open(c, env)).isInstanceOf(Envelope.Rejected.class)
                .extracting(e -> ((Envelope.Rejected) e).reason()).isEqualTo("not_for_me");
    }

    @Test
    void reAddressedTamperedOrMismatchedEnvelopesAreRefused() throws Exception {
        Map<String, Object> env = carried(Envelope.seal(a, b.pub(), payload("msg", "d-aaaa", "d-bbbb")));
        // Another sender named outside: the seal binds who sent it.
        Map<String, Object> resent = new LinkedHashMap<>(env);
        resent.put("from", "d-cccc");
        assertThat(reason(resent)).isEqualTo("cannot_open");
        // Another id outside: the seal binds that too.
        Map<String, Object> renamed = new LinkedHashMap<>(env);
        renamed.put("id", Envelope.newId());
        assertThat(reason(renamed)).isEqualTo("cannot_open");
        // One bit of the ciphertext.
        Map<String, Object> flipped = new LinkedHashMap<>(env);
        String ct = (String) env.get("ct");
        flipped.put("ct", ct.substring(0, 5) + (ct.charAt(5) == 'A' ? 'B' : 'A') + ct.substring(6));
        assertThat(reason(flipped)).isEqualTo("cannot_open");
        // A field more, or one gone: not an envelope.
        Map<String, Object> extra = new LinkedHashMap<>(env);
        extra.put("note", "x");
        assertThat(reason(extra)).isEqualTo("envelope");
        // Sealed by C to B, its payload claiming A: the payload's sender must be the envelope's.
        Map<String, Object> claims = carried(Envelope.seal(c, b.pub(), payload("msg", "d-aaaa", "d-bbbb")));
        assertThat(reason(claims)).isEqualTo("envelope");
        assertThat(reason("not even a map")).isEqualTo("envelope");
    }

    @Test
    void onlyAnOfferOrARevokeMayComeUnsealedAndItsSignatureCoversEveryByte() throws Exception {
        Map<String, Object> offer = carried(Envelope.signed(a, "d-bbbb", payload("offer", "d-aaaa", "d-bbbb")));
        Envelope.Opened opened = Envelope.open(b, offer);
        assertThat(opened.sealed()).isFalse();
        assertThat(Envelope.verify(a.pub(), opened)).isTrue();

        Map<String, Object> edited = new LinkedHashMap<>(offer);
        edited.put("p", ((String) offer.get("p")).replace("hello, desk", "hello, desk!"));
        assertThat(Envelope.verify(a.pub(), Envelope.open(b, edited))).isFalse();

        // A message sent in the clear is refused, however well signed.
        Map<String, Object> plain = carried(Envelope.signed(a, "d-bbbb", payload("msg", "d-aaaa", "d-bbbb")));
        assertThat(reason(plain)).isEqualTo("envelope");
    }

    @Test
    void keysAreKeptPrivateReadBackTheSameAndAnotherDesksFileIsSetAside() throws Exception {
        DeskKeys made = DeskKeys.loadOrCreate(dir, "d-aaaa");
        Path file = dir.resolve(DeskKeys.FILE);
        assertThat(Files.getPosixFilePermissions(file)).containsExactlyInAnyOrder(PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE);
        DeskKeys again = DeskKeys.loadOrCreate(dir, "d-aaaa");
        assertThat(again.pub().sameAs(made.pub())).isTrue();
        assertThat(again.pub().bindingValid()).isTrue();
        assertThat(again.pub().fingerprint()).matches("([0-9a-f]{4}-){7}[0-9a-f]{4}");

        // The same file on another desk (a restore onto the wrong one): new keys, the old file set aside.
        DeskKeys other = DeskKeys.loadOrCreate(dir, "d-bbbb");
        assertThat(other.pub().sig()).isNotEqualTo(made.pub().sig());
        assertThat(Files.exists(dir.resolve(DeskKeys.FILE + ".bad"))).isTrue();

        // A file whose public halves aren't its private ones' is set aside too.
        Map<String, Object> body = Json.parseObject(Files.readAllBytes(file));
        body.put("sigPub", DeskKeys.B64.encodeToString(made.pub().sig()));
        Files.write(file, Json.bytes(body));
        assertThat(DeskKeys.loadOrCreate(dir, "d-bbbb").pub().sameAs(other.pub())).isFalse();
    }

    @Test
    void aPublicKeyWhoseBoxKeyIsntBoundToItsDeskIsNoKey() {
        Map<String, Object> json = new LinkedHashMap<>(a.pub().toJson());
        assertThat(DeskKeys.Pub.fromJson("d-aaaa", json)).isNotNull();
        // A's identity paired with C's box key, or A's keys under another desk's id.
        json.put("box", DeskKeys.B64.encodeToString(c.pub().box()));
        assertThat(DeskKeys.Pub.fromJson("d-aaaa", json)).isNull();
        assertThat(DeskKeys.Pub.fromJson("d-cccc", a.pub().toJson())).isNull();
        assertThat(DeskKeys.Pub.fromJson("d-aaaa", Map.of("sig", "x"))).isNull();
        assertThat(Set.of(a.pub().toString())).allMatch(s -> !s.contains(DeskKeys.B64.encodeToString(a.pub().sig())));
    }

    private String reason(Object env) {
        try {
            Envelope.open(b, env);
            return "opened";
        } catch (Envelope.Rejected e) {
            return e.reason();
        }
    }
}
