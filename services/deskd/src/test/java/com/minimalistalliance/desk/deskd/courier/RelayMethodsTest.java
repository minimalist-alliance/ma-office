package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.SafetyNumber;
import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.courier.testkit.PeerDesk;
import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.keys.KeyPublisher;
import com.minimalistalliance.desk.deskd.courier.relay.KitApi;
import com.minimalistalliance.desk.deskd.courier.relay.RelayTransport;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The relay transport's methods through deskd's real frames, sessions and RPC layer: {@code courier.address},
 * {@code courier.invite.open}, {@code courier.contact.keys}, {@code courier.contact.verify}, {@code courier.compose.pick},
 * and a member's message sent with {@code courier.send}.
 */
@SuppressWarnings("unchecked")
class RelayMethodsTest {

    @TempDir
    Path dir;

    FakeRelay relay;
    KitApi api;
    CourierRig rig;
    RelayTransport transport;
    String address;
    TestClient owner;

    @BeforeEach
    void setUp() throws Exception {
        relay = FakeRelay.start();
        relay.addDesk("desk-a", "AKIADESKA0000000");
        address = relay.assignAddress("desk-a", "harbor", false);
        api = new KitApi(relay.baseUrl(), "desk-a");
        KeyPublisher publisher = keys -> {
            try {
                Map<String, Object> a = api.putKeys(keys.toJson());
                return new KeyPublisher.Result(KeyPublisher.Outcome.PUBLISHED, ((Number) a.get("keysVersion")).longValue(),
                        (String) a.get("fingerprint"), null, null);
            } catch (IOException e) {
                return new KeyPublisher.Result(KeyPublisher.Outcome.LATER, -1, null, null, "unreachable");
            }
        };
        Path keys = dir.resolve("keys");
        Files.createDirectory(keys, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        rig = new CourierRig(dir, dir.resolve("courier"), DeskKeys.Settings.defaults(keys), publisher);
        // The rig's clock starts on a fixed day; the fake peers stamp today, and a message from days ahead is refused.
        rig.clock.advance(Duration.between(rig.clock.instant(), java.time.Instant.now()));
        rig.module.keys().maintain();
        transport = new RelayTransport(rig.module, api, api, rig.clock,
                new RelayTransport.Settings(Duration.ofHours(1), Duration.ofMillis(50), Duration.ofSeconds(1))).start(rig.dispatcher);
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.store().outbox().canSend("ma", RelayTransport.MA_ACCOUNT));
        owner = rig.owner("s1");
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
        relay.close();
    }

    @Test
    void theAddressItsInviteAndTheRelaysState() throws Exception {
        transport.drainNow();
        Map<String, Object> a = rig.ok(owner, "courier.address");
        PublishedKeys mine = rig.module.keys().publicKeys();
        assertThat(a).containsEntry("address", address).containsEntry("domain", FakeRelay.DOMAIN)
                .containsEntry("fingerprint", mine.fingerprint())
                .containsEntry("invite", "ma://courier/" + address + "#k=" + mine.fingerprint())
                .containsEntry("doorKey", true);
        assertThat((Map<String, Object>) a.get("sending")).containsEntry("ma", true).containsEntry("email", true);
        assertThat((Map<String, Object>) a.get("relay")).containsEntry("state", "ok").containsEntry("pending", 0);
        // A teen's desk has none of it.
        rig.band.set(com.minimalistalliance.desk.deskd.platform.AgeBand.Band.TEEN);
        assertThat((Map<String, Object>) rig.err(owner, "forbidden", "courier.address").get("details")).containsEntry("reason", "teen");
    }

    @Test
    void anInviteWhoseFingerprintMatchesPinsTheContactAsChecked() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        String fp = relay.keysOf("desk-d").fingerprint();
        Map<String, Object> opened = rig.ok(owner, "courier.invite.open", "link", "ma://courier/" + dana.address() + "#k=" + fp);
        assertThat(opened).containsEntry("address", dana.address()).containsEntry("outcome", "verified");
        String number = SafetyNumber.between(rig.module.keys().publicKeys().identityKey(), dana.identityKey());
        assertThat(opened).containsEntry("safetyNumber", number);
        Map<String, Object> keys = rig.ok(owner, "courier.contact.keys", "contactId", opened.get("contactId"));
        Map<String, Object> k = ((List<Map<String, Object>>) keys.get("keys")).get(0);
        assertThat(k).containsEntry("state", "verified").containsEntry("source", "invite").containsEntry("safetyNumber", number);

        // Someone else's invite with the wrong fingerprint: nothing is pinned.
        PeerDesk lee = new PeerDesk(relay, "desk-l", "lee");
        Map<String, Object> e = rig.err(owner, "conflict", "courier.invite.open", "link", "ma://courier/" + lee.address() + "#k=" + fp);
        assertThat((Map<String, Object>) e.get("details")).containsEntry("reason", "invite_mismatch");
        Map<String, Object> none = ((List<Map<String, Object>>) rig.ok(owner, "courier.contact.keys", "address", lee.address()).get("keys")).get(0);
        assertThat(none).containsEntry("state", "none");
        assertThat((Map<String, Object>) rig.err(owner, "bad_request", "courier.invite.open", "link", "https://example.org").get("details"))
                .containsEntry("reason", "link");
        String mine = rig.module.keys().publicKeys().fingerprint();
        assertThat((Map<String, Object>) rig.err(owner, "bad_request", "courier.invite.open", "link", "ma://courier/" + address + "#k=" + mine)
                .get("details")).containsEntry("reason", "own");
    }

    @Test
    void theOfficesAddPinsOnlyWhatTheLinksFingerprintNames() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        String fp = relay.keysOf("desk-d").fingerprint();
        Map<String, Object> added = rig.ok(owner, "courier.contacts.add", "name", "dana", "fingerprint", fp, "displayName", "Dana");
        assertThat(added).containsEntry("checked", "invite").containsEntry("address", dana.address());
        assertThat(added.get("channelId")).isInstanceOf(String.class);
        Map<String, Object> person = rig.ok(owner, "courier.contact.get", "contactId", added.get("contactId"));
        assertThat(person).containsEntry("name", "Dana");
        Map<String, Object> k = ((List<Map<String, Object>>) rig.ok(owner, "courier.contact.keys", "contactId", added.get("contactId")).get("keys")).get(0);
        assertThat(k).containsEntry("state", "verified");
        // The wrong fingerprint pins nothing; no fingerprint trusts the directory on first use.
        PeerDesk lee = new PeerDesk(relay, "desk-l", "lee");
        assertThat((Map<String, Object>) rig.err(owner, "conflict", "courier.contacts.add", "name", "lee", "fingerprint", fp).get("details"))
                .containsEntry("reason", "fingerprint");
        Map<String, Object> tofu = rig.ok(owner, "courier.contacts.add", "name", "lee");
        assertThat(tofu.get("checked")).isNull();
        assertThat(((List<Map<String, Object>>) rig.ok(owner, "courier.contact.keys", "address", lee.address()).get("keys")).get(0))
                .containsEntry("state", "unverified");
        assertThat((Map<String, Object>) rig.err(owner, "not_found", "courier.contacts.add", "name", "nobody-here").get("details"))
                .containsEntry("reason", "address_unknown");
        assertThat((Map<String, Object>) rig.err(owner, "bad_request", "courier.contacts.add", "name", "Not A Name!").get("details"))
                .containsEntry("reason", "name");
        assertThat((Map<String, Object>) rig.err(owner, "bad_request", "courier.contacts.add", "name", "harbor").get("details"))
                .containsEntry("reason", "own");
    }

    @Test
    void theSafetyNumberIsCheckedBeforeItCounts() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        Map<String, Object> e = rig.err(owner, "conflict", "courier.contact.verify", "address", dana.address(), "safetyNumber",
                "00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000");
        assertThat((Map<String, Object>) e.get("details")).containsEntry("reason", "safety_number");
        String number = SafetyNumber.between(rig.module.keys().publicKeys().identityKey(), dana.identityKey());
        assertThat(rig.ok(owner, "courier.contact.verify", "address", dana.address(), "safetyNumber", number)).containsEntry("state", "verified");
        assertThat((Map<String, Object>) rig.err(owner, "bad_request", "courier.contact.verify", "address", dana.address(), "safetyNumber", "12")
                .get("details")).containsEntry("reason", "safetyNumber");
    }

    @Test
    void thePickerFollowsTheLastMessageReceived() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        dana.send(address, "hi from dana", null);
        transport.drainNow();
        String channel = (String) ((List<Map<String, Object>>) rig.ok(owner, "courier.list", "lane", "requests").get("rows")).get(0).get("channelId");
        Map<String, Object> pick = rig.ok(owner, "courier.compose.pick", "channelId", channel);
        assertThat(pick).containsEntry("medium", "ma").containsEntry("accountId", RelayTransport.MA_ACCOUNT);
        assertThat((Map<String, Object>) pick.get("reason")).containsEntry("kind", "last_inbound").containsEntry("medium", "ma");

        // Then she writes by email to the desk's address (through the door): the reply goes by email, from that address.
        rig.clock.advance(Duration.ofMinutes(1));
        String date = java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME.format(rig.clock.instant().atOffset(java.time.ZoneOffset.UTC));
        byte[] raw = ("From: " + dana.address() + "\r\nTo: " + address + "\r\nSubject: By mail\r\nMessage-ID: <m1@x.invalid>\r\n"
                + "Date: " + date + "\r\n\r\nmail body\r\n").getBytes(StandardCharsets.UTF_8);
        relay.deliverMail(address, raw, dana.address(), Map.of("dmarc", "pass", "dmarcDomain", FakeRelay.DOMAIN));
        transport.drainNow();
        pick = rig.ok(owner, "courier.compose.pick", "channelId", channel);
        assertThat(pick).containsEntry("medium", "email").containsEntry("accountId", RelayTransport.DESK_ACCOUNT);

        // A new conversation with a member's address: sealed.
        Map<String, Object> fresh = rig.ok(owner, "courier.compose.pick", "to", List.of(dana.address()));
        assertThat(fresh).containsEntry("medium", "ma");

        // Her key changes: no default until the member checks it.
        relay.swapKeys(dana.address(), relay.keysOf("desk-a"));
        rig.clock.advance(Duration.ofHours(7));
        Map<String, Object> draft = rig.ok(owner, "courier.draft.save", "medium", "ma", "accountId", "ma", "to", List.of(dana.address()), "text", "x");
        rig.ok(owner, "courier.send", "draftId", draft.get("draftId"));
        rig.clock.advance(Duration.ofSeconds(11));
        rig.store().outbox().runDue();
        await().until(() -> rig.store().relay().changed().contains(dana.address()));
        Map<String, Object> blocked = rig.ok(owner, "courier.compose.pick", "to", List.of(dana.address()));
        assertThat(blocked.get("medium")).isNull();
        assertThat((Map<String, Object>) blocked.get("reason")).containsEntry("kind", "key_changed");
    }

    @Test
    void aMembersMessageSentWithCourierSendArrivesThere() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        Map<String, Object> draft = rig.ok(owner, "courier.draft.save", "medium", "ma", "accountId", "ma", "to", List.of(dana.address()),
                "text", "sealed hello");
        Map<String, Object> sent = rig.ok(owner, "courier.send", "draftId", draft.get("draftId"));
        assertThat(sent.get("outboundId")).isNotNull();
        rig.clock.advance(Duration.ofSeconds(11));
        rig.store().outbox().runDue();
        await().atMost(Duration.ofSeconds(10)).until(() -> relay.pending("desk-d") == 1);
        List<PeerDesk.Received> got = dana.collect();
        assertThat(got).hasSize(1);
        assertThat(got.get(0).payload()).containsEntry("text", "sealed hello").containsEntry("from", address);
    }
}
