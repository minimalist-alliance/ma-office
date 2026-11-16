package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.testkit.FakeMac;
import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgSink;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgTransport;
import com.minimalistalliance.desk.deskd.courier.imsg.connector.ConnectorLinks;
import com.minimalistalliance.desk.deskd.courier.imsg.connector.ConnectorLinksAccess;
import com.minimalistalliance.desk.deskd.courier.imsg.connector.ConnectorPath;
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
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * MA Connector for Mac's path on the desk (relay.md 0.4.3; the draft ADR "Courier's Mac connector"): pairing with the code
 * the member types, the Mac's sealed pages into Courier through the {@code imsg} seam, sends and their echoes, the place
 * and its gaps, and every way a pairing ends. The Mac is the test kit's {@link FakeMac} on its {@link FakeRelay}; the Swift
 * app is checked against the same relay end to end with its harness on a Mac.
 */
@SuppressWarnings("unchecked")
class MacConnectorTest {

    private static final String DANA = "+15551230001";
    private static final String CHAT = "iMessage;-;" + DANA;

    @TempDir
    Path dir;

    FakeRelay relay;
    KitApi api;
    CourierRig rig;
    ConnectorLinks links;
    ImsgTransport imsg;
    RelayTransport transport;
    TestClient owner;

    void setUp(boolean withAddress) throws Exception {
        relay = FakeRelay.start();
        relay.addDesk("desk-a", "AKIADESKA0000000");
        if (withAddress) {
            relay.assignAddress("desk-a", "harbor", false);
        }
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
        rig.clock.advance(Duration.between(rig.clock.instant(), Instant.now()));
        rig.module.keys().maintain();
        links = new ConnectorLinks(rig.module, api, rig.clock,
                new ConnectorPath.Settings(Duration.ofSeconds(4), Duration.ofMillis(200), Duration.ofSeconds(1), 30));
        imsg = new ImsgTransport(rig.module, rig.clock, ImsgSink.Settings.DEFAULT, Duration.ofMillis(300))
                .register(ConnectorPath.PATH, links.factory(), null);
        links.transport(imsg).registerMethods(rig.dispatcher);
        imsg.start();
        transport = new RelayTransport(rig.module, api, api, rig.clock,
                new RelayTransport.Settings(Duration.ofHours(1), Duration.ofMillis(50), Duration.ofSeconds(1))).devicesThrough(links)
                .start(rig.dispatcher);
        links.drainWith(transport::drainSoon);
        relay.onNotify((desk, reason) -> transport.notify(reason));
        owner = rig.owner("s1");
    }

    @AfterEach
    void tearDown() throws Exception {
        if (imsg != null) {
            imsg.close();
        }
        if (rig != null) {
            rig.close();
        }
        if (relay != null) {
            relay.close();
        }
    }

    /** The member types the Mac's code into Courier; the Mac sees it's paired and reads the desk's hello. */
    String pair(FakeMac mac) throws Exception {
        String code = mac.startPairing();
        Map<String, Object> r = rig.ok(owner, "courier.imsg.pair", "code", code.toLowerCase().replace("-", " "));
        assertThat(r.get("fingerprint")).asString().matches("[0-9a-f]{4}-[0-9a-f]{4}");
        await().atMost(Duration.ofSeconds(5)).until(mac::paired);
        return (String) r.get("accountId");
    }

    List<FakeMac.Down> awaitDown(FakeMac mac, String type) {
        List<FakeMac.Down> got = new CopyOnWriteArrayList<>();
        await().atMost(Duration.ofSeconds(10)).pollInterval(Duration.ofMillis(100)).until(() -> {
            got.addAll(mac.receive());
            return got.stream().anyMatch(d -> type.equals(d.type()));
        });
        return got;
    }

    static Map<String, Object> page(String epoch, long after, long through, List<Map<String, Object>> messages) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("epoch", epoch);
        p.put("after", after);
        p.put("through", through);
        p.put("messages", messages);
        p.put("more", false);
        return p;
    }

    long count(String sql) throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("courier").resolve("courier.db"));
                Statement s = c.createStatement(); ResultSet r = s.executeQuery(sql)) {
            return r.next() ? r.getLong(1) : 0;
        }
    }

    String one(String sql) throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("courier").resolve("courier.db"));
                Statement s = c.createStatement(); ResultSet r = s.executeQuery(sql)) {
            return r.next() ? r.getString(1) : null;
        }
    }

    Map<String, Object> sync(String accountId) throws Exception {
        for (Object a : (List<?>) rig.ok(owner, "courier.accounts.list").get("accounts")) {
            Map<String, Object> m = (Map<String, Object>) a;
            if (accountId.equals(m.get("accountId"))) {
                return (Map<String, Object>) m.get("sync");
            }
        }
        return null;
    }

    @Test
    void theCodePairsTheMacAndItsPagesComeInWithTheirFiles() throws Exception {
        setUp(true);
        FakeMac mac = new FakeMac(relay);
        String account = pair(mac);
        List<FakeMac.Down> downs = awaitDown(mac, "hello");
        FakeMac.Down hello = downs.stream().filter(d -> "hello".equals(d.type())).findFirst().orElseThrow();
        assertThat(hello.fields()).containsEntry("account", account).containsEntry("backfillDays", 30);
        assertThat(relay.deviceIds("desk-a")).containsExactly(mac.deviceId());

        byte[] note = "the plan for Sunday".getBytes(StandardCharsets.UTF_8);
        FakeMac.Uploaded file = mac.upload(note);
        Map<String, Object> withFile = FakeMac.message(11, "G-0002", CHAT, DANA, "here it is", Instant.now().minusSeconds(30));
        withFile.put("files", List.of(Map.of("guid", "A-0001", "name", "plan.txt", "mime", "text/plain", "bytes", note.length, "drop",
                file.reference())));
        mac.sendUp("page", page("e1", 5, 11, List.of(FakeMac.message(10, "G-0001", CHAT, DANA, "lunch at noon?", Instant.now().minusSeconds(60)),
                withFile)), List.of(file.dropId()));
        transport.drainNow();
        await().atMost(Duration.ofSeconds(10)).until(() -> count("SELECT count(*) FROM messages WHERE medium = 'imessage'") == 2);
        assertThat(one("SELECT body_text FROM messages WHERE external_id = 'imsg1:G-0001'")).isEqualTo("lunch at noon?");
        String withId = one("SELECT id FROM messages WHERE external_id = 'imsg1:G-0002'");
        List<Map<String, Object>> atts = (List<Map<String, Object>>) rig.store().queries().message(withId, 0).get("attachments");
        assertThat(atts).hasSize(1);
        assertThat(atts.get(0)).containsEntry("name", "plan.txt");
        assertThat(rig.store().cursor(account, "mac:place")).isEqualTo("e1:11");
        assertThat(sync(account)).containsEntry("path", "connector").containsEntry("state", "live");
        // Nothing was left waiting in the relay.
        assertThat(relay.pending("desk-a")).isZero();
    }

    @Test
    void aGapAsksTheMacToGoAgainAndANewEpochStartsOver() throws Exception {
        setUp(true);
        FakeMac mac = new FakeMac(relay);
        String account = pair(mac);
        awaitDown(mac, "hello");
        mac.sendUp("page", page("e1", 0, 10, List.of(FakeMac.message(10, "G-1", CHAT, DANA, "one", Instant.now().minusSeconds(90)))), List.of());
        transport.drainNow();
        await().atMost(Duration.ofSeconds(5)).until(() -> "e1:10".equals(rig.store().cursor(account, "mac:place")));
        // Page 11 to 12 was lost; 13 arrives: not kept, and the Mac is asked to go again from 10.
        mac.sendUp("page", page("e1", 12, 13, List.of(FakeMac.message(13, "G-3", CHAT, DANA, "three", Instant.now()))), List.of());
        transport.drainNow();
        List<FakeMac.Down> downs = awaitDown(mac, "resume");
        FakeMac.Down resume = downs.stream().filter(d -> "resume".equals(d.type())).findFirst().orElseThrow();
        assertThat(resume.fields()).containsEntry("epoch", "e1");
        assertThat(((Number) resume.fields().get("after")).longValue()).isEqualTo(10);
        assertThat(count("SELECT count(*) FROM messages WHERE body_text = 'three'")).isZero();
        // The Mac goes again from 10: everything arrives once.
        mac.sendUp("page", page("e1", 10, 13, List.of(FakeMac.message(12, "G-2", CHAT, DANA, "two", Instant.now().minusSeconds(10)),
                FakeMac.message(13, "G-3", CHAT, DANA, "three", Instant.now()))), List.of());
        // A copy of the same page (a lost answer on the Mac): nothing twice.
        mac.sendUp("page", page("e1", 10, 13, List.of(FakeMac.message(12, "G-2", CHAT, DANA, "two", Instant.now().minusSeconds(10)),
                FakeMac.message(13, "G-3", CHAT, DANA, "three", Instant.now()))), List.of());
        transport.drainNow();
        await().atMost(Duration.ofSeconds(5)).until(() -> "e1:13".equals(rig.store().cursor(account, "mac:place")));
        assertThat(count("SELECT count(*) FROM messages WHERE medium = 'imessage'")).isEqualTo(3);
        // A new database on the Mac (a new epoch): taken whatever its place, the same guids stored once.
        mac.sendUp("page", page("e2", 0, 3, List.of(FakeMac.message(2, "G-2", CHAT, DANA, "two", Instant.now().minusSeconds(10)),
                FakeMac.message(3, "G-4", CHAT, DANA, "four", Instant.now()))), List.of());
        transport.drainNow();
        await().atMost(Duration.ofSeconds(5)).until(() -> "e2:3".equals(rig.store().cursor(account, "mac:place")));
        assertThat(count("SELECT count(*) FROM messages WHERE medium = 'imessage'")).isEqualTo(4);
    }

    @Test
    void aSendGoesToTheMacOnceAndItsEchoIsTheSameMessage() throws Exception {
        setUp(true);
        FakeMac mac = new FakeMac(relay);
        String account = pair(mac);
        awaitDown(mac, "hello");
        mac.sendUp("page", page("e1", 0, 1, List.of(FakeMac.message(1, "G-in", CHAT, DANA, "where are you?", Instant.now().minusSeconds(60)))),
                List.of());
        transport.drainNow();
        await().atMost(Duration.ofSeconds(5)).until(() -> count("SELECT count(*) FROM messages WHERE external_id = 'imsg1:G-in'") == 1);
        String channel = one("SELECT channel_id FROM messages WHERE external_id = 'imsg1:G-in'");

        // The Mac: answer each send with its guid, then the page that holds the sent message.
        AtomicBoolean stop = new AtomicBoolean();
        List<Map<String, Object>> sends = new CopyOnWriteArrayList<>();
        Thread macThread = Thread.ofVirtual().start(() -> {
            long seq = 2;
            while (!stop.get()) {
                try {
                    for (FakeMac.Down d : mac.receive()) {
                        if ("send".equals(d.type())) {
                            sends.add(d.fields());
                            String guid = "G-out-" + seq;
                            mac.sendUp("sent", Map.of("outboundId", d.fields().get("outboundId"), "replyTo", d.fields().get("id"), "result", "sent",
                                    "guid", guid), List.of());
                            mac.sendUp("page", page("e1", seq - 1, seq, List.of(FakeMac.message(seq, guid, CHAT, null,
                                    (String) d.fields().get("text"), Instant.now()))), List.of());
                            seq++;
                        }
                    }
                    Thread.sleep(100);
                } catch (Exception e) {
                    // keep going
                }
            }
        });
        try {
            Map<String, Object> d = rig.ok(owner, "courier.draft.save", "channelId", channel, "medium", "imessage", "accountId", account, "text",
                    "on my way");
            rig.ok(owner, "courier.send", "draftId", d.get("draftId"));
            rig.clock.advance(Duration.ofSeconds(11));
            rig.store().outbox().poke();
            await().atMost(Duration.ofSeconds(15)).until(() -> count("SELECT count(*) FROM outbound WHERE state = 'sent'") == 1);
            assertThat(sends).hasSize(1);
            assertThat(sends.get(0)).containsEntry("chatGuid", CHAT).containsEntry("text", "on my way").containsEntry("medium", "imessage");
            transport.drainNow();
            Thread.sleep(500);
            transport.drainNow();
            assertThat(count("SELECT count(*) FROM messages WHERE body_text = 'on my way'")).isEqualTo(1);
        } finally {
            stop.set(true);
            macThread.join(2000);
        }
    }

    @Test
    void noAnswerIsMayHaveGoneAndTheRetryAsksTheMacToLookFirst() throws Exception {
        setUp(true);
        FakeMac mac = new FakeMac(relay);
        String account = pair(mac);
        awaitDown(mac, "hello");
        mac.sendUp("page", page("e1", 0, 1, List.of(FakeMac.message(1, "G-in", CHAT, DANA, "hello?", Instant.now().minusSeconds(60)))), List.of());
        transport.drainNow();
        await().atMost(Duration.ofSeconds(5)).until(() -> count("SELECT count(*) FROM messages WHERE external_id = 'imsg1:G-in'") == 1);
        String channel = one("SELECT channel_id FROM messages WHERE external_id = 'imsg1:G-in'");
        Map<String, Object> d = rig.ok(owner, "courier.draft.save", "channelId", channel, "medium", "imessage", "accountId", account, "text", "hi");
        rig.ok(owner, "courier.send", "draftId", d.get("draftId"));
        rig.clock.advance(Duration.ofSeconds(11));
        rig.store().outbox().poke();
        // The Mac says nothing for the path's wait: the try is "may have gone", and it waits for a retry.
        await().atMost(Duration.ofSeconds(15)).until(() -> count("SELECT count(*) FROM outbound WHERE state = 'retry'") == 1);
        List<FakeMac.Down> first = mac.receive();
        assertThat(first.stream().filter(x -> "send".equals(x.type()))).hasSize(1);
        rig.clock.advance(Duration.ofMinutes(10));
        rig.store().outbox().poke();
        List<FakeMac.Down> second = awaitDown(mac, "send");
        Map<String, Object> retry = second.stream().filter(x -> "send".equals(x.type())).findFirst().orElseThrow().fields();
        assertThat(retry).containsEntry("maybeSentBefore", true);
    }

    @Test
    void forgedStaleAndUnknownDevicesAreRefused() throws Exception {
        setUp(true);
        FakeMac mac = new FakeMac(relay);
        String account = pair(mac);
        awaitDown(mac, "hello");
        // Signed by a key that isn't the pinned Mac's.
        IdentityKeyPair stranger = IdentityKeyPair.generate(new java.security.SecureRandom());
        mac.sendUp("page", page("e1", 0, 1, List.of(FakeMac.message(1, "G-forged", CHAT, DANA, "forged", Instant.now()))), List.of(), Instant.now(),
                stranger);
        // Older than the relay keeps anything.
        mac.sendUp("page", page("e1", 0, 1, List.of(FakeMac.message(1, "G-old", CHAT, DANA, "replayed", Instant.now()))), List.of(),
                Instant.now().minus(Duration.ofDays(120)), null);
        transport.drainNow();
        assertThat(count("SELECT count(*) FROM messages WHERE medium = 'imessage'")).isZero();
        assertThat(relay.pending("desk-a")).isZero();

        // The account goes: the Mac is told, the platform forgets the device, and the Mac's next request is refused.
        rig.ok(owner, "courier.accounts.remove", "accountId", account, "keepMail", true);
        await().atMost(Duration.ofSeconds(5)).until(() -> relay.deviceIds("desk-a").isEmpty());
        try {
            mac.receive();
            throw new AssertionError("the Mac still reached the relay");
        } catch (FakeMac.Refused r) {
            assertThat(r.status).isEqualTo(401);
            assertThat(r.code).isEqualTo("device_unknown");
        }
    }

    @Test
    void aDeviceWithNoAccountHereIsForgottenOnThePlatform() throws Exception {
        setUp(true);
        // A Mac the platform paired with this desk, whose account isn't here (the desk restored from an older backup).
        FakeMac mac = new FakeMac(relay);
        String code = mac.startPairing();
        api.claimDevice(code);
        await().atMost(Duration.ofSeconds(5)).until(mac::paired);
        mac.sendUp("status", Map.of("app", "1.0.0", "fullDisk", true), List.of());
        transport.drainNow();
        await().atMost(Duration.ofSeconds(5)).until(() -> relay.deviceIds("desk-a").isEmpty());
        assertThat(relay.pending("desk-a")).isZero();
    }

    @Test
    void theMemberRemovingTheMacElsewhereShowsInTheAccountsRow() throws Exception {
        setUp(true);
        FakeMac mac = new FakeMac(relay);
        String account = pair(mac);
        awaitDown(mac, "hello");
        mac.sendUp("status", Map.of("app", "1.0.0", "os", "15.7", "fullDisk", false, "automation", true, "paused", false), List.of());
        transport.drainNow();
        await().atMost(Duration.ofSeconds(5)).until(() -> "needs_you".equals(sync(account).get("state")));
        assertThat(sync(account)).containsEntry("reason", "full_disk");
        assertThat((Map<String, Object>) sync(account).get("mac")).containsEntry("fullDisk", false).containsEntry("app", "1.0.0");
        mac.sendUp("status", Map.of("app", "1.0.0", "os", "15.7", "fullDisk", true, "automation", true, "paused", false), List.of());
        transport.drainNow();
        await().atMost(Duration.ofSeconds(5)).until(() -> "live".equals(sync(account).get("state")));
        // Removed in the account site: the push says so, and the row asks the member.
        relay.removeDeviceAsMember(mac.deviceId());
        await().atMost(Duration.ofSeconds(5)).until(() -> "unpaired".equals(sync(account).get("reason")));
    }

    @Test
    void aDeskWithoutAnAddressStillHearsItsMacAndBigPagesComeThroughADrop() throws Exception {
        setUp(false);
        FakeMac mac = new FakeMac(relay);
        String account = pair(mac);
        awaitDown(mac, "hello");
        String longText = "é".repeat(19_000);
        mac.sendUp("page", page("e1", 0, 1, List.of(FakeMac.message(1, "G-long", CHAT, DANA, longText, Instant.now()))), List.of());
        transport.drainNow();
        await().atMost(Duration.ofSeconds(5)).until(() -> count("SELECT count(*) FROM messages WHERE external_id = 'imsg1:G-long'") == 1);
        assertThat(one("SELECT body_text FROM messages WHERE external_id = 'imsg1:G-long'")).isEqualTo(longText);
        assertThat(rig.store().cursor(account, "mac:place")).isEqualTo("e1:1");
    }

    @Test
    void oneMacADeskAndTheCodesOwnNos() throws Exception {
        setUp(true);
        Map<String, Object> e = rig.err(owner, "bad_request", "courier.imsg.pair", "code", "hello");
        assertThat((Map<String, Object>) e.get("details")).containsEntry("reason", "code");
        e = rig.err(owner, "not_found", "courier.imsg.pair", "code", "BCDF-GHJK");
        assertThat((Map<String, Object>) e.get("details")).containsEntry("reason", "code");
        FakeMac mac = new FakeMac(relay);
        pair(mac);
        FakeMac second = new FakeMac(relay);
        String code = second.startPairing();
        e = rig.err(owner, "conflict", "courier.imsg.pair", "code", code);
        assertThat((Map<String, Object>) e.get("details")).containsEntry("reason", "too_many");
        // The second Mac was never claimed.
        assertThat(second.paired()).isFalse();
        assertThat(relay.deviceIds("desk-a")).hasSize(1);
    }

    @Test
    void iMessageSwitchedOffKeepsNothingAndTheMacGoesAgainOnceItsBack() throws Exception {
        setUp(true);
        FakeMac mac = new FakeMac(relay);
        String account = pair(mac);
        awaitDown(mac, "hello");
        mac.sendUp("page", page("e1", 0, 1, List.of(FakeMac.message(1, "G-1", CHAT, DANA, "one", Instant.now()))), List.of());
        transport.drainNow();
        await().atMost(Duration.ofSeconds(5)).until(() -> "e1:1".equals(rig.store().cursor(account, "mac:place")));
        Path sw = dir.resolve("desk").resolve(CourierSwitch.FILE);
        Files.writeString(sw, "imessage-off");
        Thread.sleep(1_100);
        mac.sendUp("page", page("e1", 1, 2, List.of(FakeMac.message(2, "G-2", CHAT, DANA, "two", Instant.now()))), List.of());
        transport.drainNow();
        assertThat(count("SELECT count(*) FROM messages WHERE body_text = 'two'")).isZero();
        assertThat(relay.pending("desk-a")).isZero();
        assertThat(rig.store().cursor(account, "mac:place")).isEqualTo("e1:1");
        Files.delete(sw);
        Thread.sleep(1_100);
        mac.sendUp("page", page("e1", 2, 3, List.of(FakeMac.message(3, "G-3", CHAT, DANA, "three", Instant.now()))), List.of());
        transport.drainNow();
        List<FakeMac.Down> downs = awaitDown(mac, "resume");
        assertThat(((Number) downs.stream().filter(d -> "resume".equals(d.type())).findFirst().orElseThrow().fields().get("after")).longValue())
                .isEqualTo(1);
    }

    @Test
    void theCheckNumberIsTheMacsToo() throws Exception {
        // The envelope vectors' recipient as the desk and sender as the Mac (connectors/mac CryptoTests holds the same number).
        byte[] desk = java.util.Base64.getUrlDecoder().decode("0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc");
        byte[] mac = java.util.Base64.getUrlDecoder().decode("F8t5-ytBIPKx7GXkGY1uCLKOgT_rAeSkAIObheGAgM4");
        assertThat(ConnectorLinksAccess.check(desk, mac)).isEqualTo("7728 7949 2691");
        setUp(true);
        FakeMac m = new FakeMac(relay);
        String code = m.startPairing();
        Map<String, Object> r = rig.ok(owner, "courier.imsg.pair", "code", code);
        String expect = ConnectorLinksAccess.check(rig.module.keys().identity().publicKey().bytes(), m.identityKey().bytes());
        assertThat(r).containsEntry("check", expect);
        await().atMost(Duration.ofSeconds(5)).until(() -> sync((String) r.get("accountId")) != null);
        assertThat((Map<String, Object>) sync((String) r.get("accountId")).get("device")).containsEntry("check", expect);
    }

    @Test
    void theRelaysDeviceSwitchPausesPairing() throws Exception {
        setUp(true);
        FakeMac mac = new FakeMac(relay);
        String code = mac.startPairing();
        relay.setDevicesEnabled(false);
        Map<String, Object> e = rig.err(owner, "unavailable", "courier.imsg.pair", "code", code);
        assertThat((Map<String, Object>) e.get("details")).containsEntry("reason", "paused");
        relay.setDevicesEnabled(true);
        List<String> ok = new ArrayList<>();
        ok.add((String) rig.ok(owner, "courier.imsg.pair", "code", code).get("accountId"));
        assertThat(ok).hasSize(1);
    }
}
