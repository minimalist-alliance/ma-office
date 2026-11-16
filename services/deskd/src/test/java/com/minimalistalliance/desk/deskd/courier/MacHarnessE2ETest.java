package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgSink;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgTransport;
import com.minimalistalliance.desk.deskd.courier.imsg.connector.ConnectorLinks;
import com.minimalistalliance.desk.deskd.courier.imsg.connector.ConnectorPath;
import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.keys.KeyPublisher;
import com.minimalistalliance.desk.deskd.courier.relay.KitApi;
import com.minimalistalliance.desk.deskd.courier.relay.RelayTransport;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

/**
 * The real MA Connector for Mac (its Swift bridge, run by {@code connector-harness} on a Mac against a synthetic Messages
 * database and a fake Messages) against this desk's real {@code connector} path, through the test kit's fake relay reached
 * over SSH tunnels: the two languages' envelopes, signatures, drops and request signing checked against each other. Run by
 * {@code connectors/mac/scripts/e2e-fake-relay.sh}; skipped unless {@code -Dma.mac.e2e.port} is set. Never touches a real
 * Messages database.
 */
@EnabledIfSystemProperty(named = "ma.mac.e2e.port", matches = "\\d+")
class MacHarnessE2ETest {

    @TempDir
    Path dir;

    @Test
    void theSwiftConnectorAndTheDeskAgree() throws Exception {
        int port = Integer.parseInt(System.getProperty("ma.mac.e2e.port"));
        Path out = Path.of(System.getProperty("ma.mac.e2e.out", "target/mac-e2e.json"));
        Map<String, Object> result = new LinkedHashMap<>();
        try (FakeRelay relay = FakeRelay.start(port)) {
            relay.addDesk("desk-a", "AKIADESKA0000000");
            relay.assignAddress("desk-a", "harbor", false);
            KitApi api = new KitApi(relay.baseUrl(), "desk-a");
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
            try (CourierRig rig = new CourierRig(dir, dir.resolve("courier"), DeskKeys.Settings.defaults(keys), publisher)) {
                rig.clock.advance(Duration.between(rig.clock.instant(), Instant.now()));
                rig.module.keys().maintain();
                ConnectorLinks links = new ConnectorLinks(rig.module, api, rig.clock, ConnectorPath.Settings.DEFAULT);
                ImsgTransport imsg = new ImsgTransport(rig.module, rig.clock, ImsgSink.Settings.DEFAULT, Duration.ofMillis(300))
                        .register(ConnectorPath.PATH, links.factory(), null);
                links.transport(imsg).registerMethods(rig.dispatcher);
                imsg.start();
                RelayTransport transport = new RelayTransport(rig.module, api, api, rig.clock,
                        new RelayTransport.Settings(Duration.ofSeconds(5), Duration.ofMillis(200), Duration.ofSeconds(2))).devicesThrough(links)
                        .start(rig.dispatcher);
                links.drainWith(transport::drainSoon);
                relay.onNotify((desk, reason) -> transport.notify(reason));
                TestClient owner = rig.owner("s1");
                System.out.println("MAC-E2E ready " + relay.baseUrl());

                // 1. The Mac shows a code; the member types it into Courier.
                await().atMost(Duration.ofMinutes(3)).pollInterval(Duration.ofMillis(250)).until(() -> relay.lastUserCode() != null);
                Map<String, Object> paired = rig.ok(owner, "courier.imsg.pair", "code", relay.lastUserCode());
                String account = (String) paired.get("accountId");
                result.put("paired", paired);
                System.out.println("MAC-E2E paired " + paired.get("fingerprint") + " check " + paired.get("check"));

                // 2. The Mac's backfill: the fixture's last 30 days (14 messages; the 40-day-old one stays behind).
                await().atMost(Duration.ofMinutes(3)).pollInterval(Duration.ofMillis(500))
                        .until(() -> count(dir, "SELECT count(*) FROM messages WHERE medium IN ('imessage','sms')") >= 12);
                Thread.sleep(3000);
                result.put("stored", count(dir, "SELECT count(*) FROM messages WHERE medium IN ('imessage','sms')"));
                result.put("sms", count(dir, "SELECT count(*) FROM messages WHERE medium = 'sms'"));
                result.put("old", count(dir, "SELECT count(*) FROM messages WHERE body_text = 'From long ago'"));
                result.put("archiveOnly", count(dir, "SELECT count(*) FROM messages WHERE body_text = 'Only in the archive'"));
                result.put("long", count(dir, "SELECT count(*) FROM messages WHERE length(body_text) > 19000"));
                result.put("attachments", count(dir, "SELECT count(*) FROM attachments"));
                result.put("place", rig.store().cursor(account, "mac:place"));

                // 3. The member replies in Courier: sealed down, sent by the fake Messages, answered with its guid, echo once.
                String channel = one(dir, "SELECT channel_id FROM messages WHERE body_text = 'Lunch at noon?'");
                Map<String, Object> d = rig.ok(owner, "courier.draft.save", "channelId", channel, "medium", "imessage", "accountId", account,
                        "text", "On my way");
                rig.ok(owner, "courier.send", "draftId", d.get("draftId"));
                rig.clock.advance(Duration.ofSeconds(11));
                rig.store().outbox().poke();
                await().atMost(Duration.ofMinutes(2)).pollInterval(Duration.ofMillis(500))
                        .until(() -> count(dir, "SELECT count(*) FROM outbound WHERE state = 'sent'") == 1);
                Thread.sleep(8000);
                transport.drainNow();
                result.put("sent", count(dir, "SELECT count(*) FROM outbound WHERE state = 'sent'"));
                result.put("echoes", count(dir, "SELECT count(*) FROM messages WHERE body_text = 'On my way'"));
                result.put("sync", rig.ok(owner, "courier.accounts.list").get("accounts"));
                result.put("relayPending", relay.pending("desk-a"));

                // 4. The member removes the Mac: the platform forgets it, and the Mac forgets its pairing on its next look.
                rig.ok(owner, "courier.accounts.remove", "accountId", account, "keepMail", true);
                await().atMost(Duration.ofSeconds(20)).until(() -> relay.deviceIds("desk-a").isEmpty());
                result.put("removed", true);
                Files.write(out, Json.bytes(result));
                System.out.println("MAC-E2E removed; waiting for the Mac to look");
                Thread.sleep(Long.getLong("ma.mac.e2e.linger", 30_000L));
                imsg.close();
            }
        }
        assertThat(((Number) result.get("echoes")).longValue()).isEqualTo(1);
        assertThat(((Number) result.get("sent")).longValue()).isEqualTo(1);
        assertThat(((Number) result.get("old")).longValue()).isZero();
        assertThat(((Number) result.get("archiveOnly")).longValue()).isEqualTo(1);
    }

    static long count(Path dir, String sql) throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("courier").resolve("courier.db"));
                Statement s = c.createStatement(); ResultSet r = s.executeQuery(sql)) {
            return r.next() ? r.getLong(1) : 0;
        }
    }

    static String one(Path dir, String sql) throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("courier").resolve("courier.db"));
                Statement s = c.createStatement(); ResultSet r = s.executeQuery(sql)) {
            return r.next() ? r.getString(1) : null;
        }
    }
}
