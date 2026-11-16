package com.minimalistalliance.desk.deskd.courier.relay;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.courier.envelope.BodySource;
import com.minimalistalliance.desk.courier.envelope.BoxKeyPair;
import com.minimalistalliance.desk.courier.envelope.Drop;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.Signed;
import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.courier.testkit.PeerDesk;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.imds.ImdsClient;
import com.minimalistalliance.desk.deskd.platform.AgentClient;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * deskd's own client of the relay, signed with SigV4 as every agent route (the fake reads the access key id the signature
 * names), against the test kit's fake: every route, its 201 and 202 answers, refusals with their codes, and the drop links.
 */
@SuppressWarnings("unchecked")
class PlatformRelayApiTest {

    private FakePlatform platform;
    private PlatformHttp http;
    private FakeRelay relay;
    private PlatformRelayApi api;
    private String address;

    @BeforeEach
    void setUp() throws Exception {
        platform = new FakePlatform();
        http = new PlatformHttp();
        relay = FakeRelay.start();
        relay.addDesk("desk-s", FakePlatform.ACCESS_KEY);
        address = relay.assignAddress("desk-s", "signed", false);
        RoleCredentials credentials = new RoleCredentials(new ImdsClient(http, platform.url()), Clock.systemUTC());
        api = new PlatformRelayApi(new AgentClient(http, credentials, relay::baseUrl, Clock.systemUTC()), http, true);
    }

    @AfterEach
    void tearDown() {
        relay.close();
        http.close();
        platform.close();
    }

    @Test
    void everyRouteWorksSigned() throws Exception {
        Map<String, Object> a = api.addresses();
        assertThat(((Map<String, Object>) a.get("address")).get("address")).isEqualTo(address);
        assertThat(a.get("domain")).isEqualTo(FakeRelay.DOMAIN);
        assertThat((List<Object>) a.get("doorKeys")).hasSize(1);

        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        // A lookup with a plus tag answers the canonical address.
        Map<String, Object> keys = api.lookup(dana.address().replace("@", "+shop@"));
        assertThat(keys.get("address")).isEqualTo(dana.address());
        PublishedKeys theirs = PublishedKeys.fromJson(keys);

        // Our own keys, so the relay lets us send.
        IdentityKeyPair me = IdentityKeyPair.generate(new SecureRandom());
        BoxKeyPair box = BoxKeyPair.generate(new SecureRandom(), Instant.now().toEpochMilli());
        new AgentClient(http, new RoleCredentials(new ImdsClient(http, platform.url()), Clock.systemUTC()), relay::baseUrl, Clock.systemUTC())
                .putKeys(PublishedKeys.bind(me, box.publicKey()).toJson());

        // A drop: reserved (201), uploaded to its link, then an envelope naming it (202), sent twice with one key.
        byte[] body = new byte[100_000];
        new SecureRandom().nextBytes(body);
        Drop.Sealer sealer = Drop.sealer(BodySource.of(body));
        Map<String, Object> reserved = api.reserveDrop(dana.address(), sealer.bucket());
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        sealer.write(bytes);
        // Without the signed headers the upload is refused, as S3 refuses it; with them (the length as the body's), taken.
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> api.upload((String) reserved.get("url"), Map.of(), bytes.toByteArray()))
                .isInstanceOf(RelayApi.Refused.class);
        Map<String, String> signed = new LinkedHashMap<>();
        ((Map<String, Object>) reserved.get("headers")).forEach((k, v) -> signed.put(k, (String) v));
        assertThat(signed).containsKey("Content-Length");
        api.upload((String) reserved.get("url"), signed, bytes.toByteArray());
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", 1);
        p.put("kind", "message");
        p.put("id", "01JD0000000000000000000001");
        p.put("from", address);
        p.put("to", dana.address());
        p.put("at", Payloads.at(System.currentTimeMillis()));
        p.put("drop", sealer.reference((String) reserved.get("dropId")));
        Envelope.Sealed s = Signed.seal(me, theirs, p);
        Map<String, Object> env = new LinkedHashMap<>(s.toJson());
        env.put("drops", List.of(reserved.get("dropId")));
        Map<String, Object> sent = api.send(env, "oKEY0000000000000001-aaaa");
        assertThat(sent.get("id")).isInstanceOf(String.class);
        assertThat(api.send(env, "oKEY0000000000000001-aaaa").get("id")).isEqualTo(sent.get("id"));
        assertThat(dana.collect()).hasSize(1).first().satisfies(r -> assertThat(r.dropBody()).isEqualTo(body));

        // Collect, download, ack, pending.
        dana.send(address, "back", null, new byte[70_000]);
        Map<String, Object> page = api.collect(null, 10);
        List<Map<String, Object>> envs = (List<Map<String, Object>>) page.get("envelopes");
        assertThat(envs).hasSize(1);
        Map<String, Object> d = ((List<Map<String, Object>>) envs.get(0).get("drops")).get(0);
        try (InputStream in = api.download((String) d.get("url"), ((Number) d.get("bytes")).longValue())) {
            assertThat(in.readAllBytes()).hasSize(((Number) d.get("bytes")).intValue());
        }
        assertThat(api.pending().get("pending")).isEqualTo(1);
        api.ack(List.of((String) envs.get(0).get("id")));
        assertThat(api.pending().get("pending")).isEqualTo(0);
    }

    @Test
    void refusalsCarryTheContractsCodes() {
        assertThatThrownBy(() -> api.lookup("nobody@" + FakeRelay.DOMAIN))
                .isInstanceOfSatisfying(RelayApi.Refused.class, r -> {
                    assertThat(r.status()).isEqualTo(404);
                    assertThat(r.code()).isEqualTo("address_unknown");
                });
        relay.setPaused(true);
        assertThatThrownBy(() -> api.collect(null, 10))
                .isInstanceOfSatisfying(RelayApi.Refused.class, r -> assertThat(r.code()).isEqualTo("courier_paused"));
    }

    @Test
    void onlyHttpsDropLinksAreFollowed() throws Exception {
        assertThatThrownBy(() -> PlatformRelayApi.dropUri("http://example.org/d/x", true)).isInstanceOf(IOException.class);
        assertThatThrownBy(() -> PlatformRelayApi.dropUri("https://user:pw@example.org/d/x", true)).isInstanceOf(IOException.class);
        assertThatThrownBy(() -> PlatformRelayApi.dropUri("file:///etc/passwd", true)).isInstanceOf(IOException.class);
        assertThatThrownBy(() -> PlatformRelayApi.dropUri("ftp://example.org/x", true)).isInstanceOf(IOException.class);
        assertThatThrownBy(() -> PlatformRelayApi.dropUri("http://10.0.0.1/x", true)).isInstanceOf(IOException.class);
        // Plain http to loopback only when built for the test kit (CT-I1).
        assertThatThrownBy(() -> PlatformRelayApi.dropUri("http://127.0.0.1:9/x", false)).isInstanceOf(IOException.class);
        assertThat(PlatformRelayApi.dropUri("http://127.0.0.1:9/x", true).getPort()).isEqualTo(9);
        assertThat(PlatformRelayApi.dropUri("https://example.org/d/x", false).getHost()).isEqualTo("example.org");
    }

    @Test
    void anInviteLinkReadsStrictly() {
        String fp = "3f2a-91c0-0000-1111-2222-3333-4444-5555";
        assertThat(Invite.parse("ma://courier/Dana+x@courier.example.com#k=" + fp.toUpperCase()))
                .isEqualTo(new Invite("dana@courier.example.com", fp));
        assertThat(Invite.parse("ma://courier/dana@courier.example.com")).isNull();
        assertThat(Invite.parse("ma://courier/dana@courier.example.com#k=3f2a")).isNull();
        assertThat(Invite.parse("https://evil/ma://courier/dana@courier.example.com#k=" + fp)).isNull();
        assertThat(Invite.parse("ma://courier/da..na@courier.example.com#k=" + fp)).isNull();
        assertThat(Invite.link("dana@courier.example.com", fp)).isEqualTo("ma://courier/dana@courier.example.com#k=" + fp);
    }
}
