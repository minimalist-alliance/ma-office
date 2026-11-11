package com.minimalistalliance.desk.deskd.tier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.platform.TierLimits;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.ControlPlaneRig;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A free desk's Browser time through the control plane as it's wired (ADR 0090), from the Platform's config to a client's
 * {@code browser.stream.set} and the units: {@code live} refused with the bandwidth pause's shape once the day's time is
 * used, an open stream ended as the time runs out with Chromium left running, the limit lifted by an upgrade and brought
 * by a downgrade at the next config, a failed or malformed read changing nothing, and the heartbeat's count.
 */
class BrowserTimeDeskTest {

    private static final String TAB = "ab".repeat(32);
    private static final String START_BROWSER = "start desk-browser";
    private static final String STOP_BROWSER = "stop desk-browser";
    private static final String STOP_STREAM = "stop desk-stream";
    private static final HeartbeatLoop.Timing FAST_BEATS =
            new HeartbeatLoop.Timing(Duration.ofMillis(300), Duration.ofMillis(100), Duration.ofSeconds(5));
    /** A minute a day, so a test can watch it run out. */
    private static final Map<String, Object> ONE_MINUTE = Map.of("tier", "free", "browserMinutesPerDay", 1, "filesGb", 2, "idleStopMinutes", 30);

    @TempDir
    Path dir;

    private ControlPlaneRig rig;
    private final Instant midnight = BrowserTime.nextMidnight(Instant.now(), ZoneOffset.UTC);

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    /** Today, as an earlier deskd left it: this much of it used. */
    private void used(Duration used) throws Exception {
        Path data = Files.createDirectories(dir.resolve("data"));
        Map<String, Object> day = new LinkedHashMap<>();
        day.put("openedAt", Instant.now().minusSeconds(120).toString());
        day.put("resetsAt", midnight.toString());
        day.put("zone", "Z");
        day.put("usedMs", used.toMillis());
        Files.write(data.resolve(BrowserTime.FILE), Json.bytes(Map.of("day", day)));
    }

    private ControlPlaneRig rig(HeartbeatLoop.Timing beats, Object tierLimits) throws Exception {
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, beats);
        rig.platform.nextHeartbeatSeconds = null;
        rig.platform.tierLimits = tierLimits;
        return rig;
    }

    private static Map<String, Object> message(String type, Object... pairs) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("type", type);
        for (int i = 0; i < pairs.length; i += 2) {
            message.put((String) pairs[i], pairs[i + 1]);
        }
        return message;
    }

    private TestClient connect(String sessionId, long handle) throws Exception {
        rig.gateway.send(message(
                "session.open", "sessionId", sessionId, "deskToken", rig.platform.tokens.mint(TAB, Instant.now()),
                "openedAt", Instant.now().toString()));
        assertThat(rig.gateway.await("session.accept")).containsEntry("sessionId", sessionId);
        rig.gateway.send(message("signal", "sessionId", sessionId, "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
        assertThat(rig.gateway.await("signal")).containsEntry("sessionId", sessionId);
        TestClient client = new TestClient(rig.rtc, handle);
        client.hello();
        return client;
    }

    private static Map<String, Object> stream(TestClient client, String state) throws Exception {
        return client.call("browser.stream.set", Map.of("state", state));
    }

    private void assertTimeRefusal(Map<String, Object> reply) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
        assertThat(Json.object(reply, "details"))
                .containsEntry("reason", "bandwidth_limit")
                .containsEntry("resumesAt", midnight.toString())
                .containsEntry("limit", "browser_time");
    }

    private void awaitVideoCut() throws Exception {
        while (!Boolean.FALSE.equals(rig.rtc.awaitJson("session.video").get("view"))) {
            // Earlier ones.
        }
    }

    @SuppressWarnings("unchecked")
    private Object timeUsedInHealth() {
        return ((Map<String, Object>) rig.browser.health().get("browser")).get("timeUsedUntil");
    }

    /** The heartbeat's config read: a new configVersion, which the next heartbeat reply says. */
    private void newConfig() {
        rig.platform.configVersion++;
    }

    @Test
    void outOfTimeLiveIsRefusedAsThePauseIsAndWarmAndEverythingElseWork() throws Exception {
        used(Duration.ofMinutes(2));
        rig(ControlPlaneRig.SLOW_BEATS, ONE_MINUTE).bootToReady();
        TestClient client = connect("cs-1", 1);

        assertTimeRefusal(stream(client, "live"));
        assertThat(rig.units.requests()).doesNotContain(START_BROWSER);
        assertThat(stream(client, "warm")).containsEntry("_kind", "RES").containsEntry("state", "warm");
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");
        // The tabs aren't refused for the time: the rig's Chromium simply isn't there.
        assertThat(Json.object(client.call("browser.tab.list", Map.of()), "details")).containsEntry("reason", "chromium");
        assertThat(timeUsedInHealth()).isEqualTo(midnight.toString());
        assertTimeRefusal(stream(client, "live"));
        assertThat(rig.units.requests()).doesNotContain(START_BROWSER, STOP_BROWSER);
    }

    @Test
    void theTimeRunningOutWhileLiveEndsTheStreamAndLeavesChromiumRunning() throws Exception {
        used(Duration.ofSeconds(57));
        rig(ControlPlaneRig.SLOW_BEATS, ONE_MINUTE).bootToReady();
        TestClient client = connect("cs-1", 1);
        assertThat(stream(client, "live")).containsEntry("_kind", "RES").containsEntry("state", "live");
        assertThat(rig.rtc.awaitJson("session.video")).containsEntry("view", true);

        awaitVideoCut();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.units.requests().contains(STOP_STREAM));
        // Chromium, its tabs and its profile are left alone (ADR 0035).
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER);
        assertThat(rig.units.isRunning("desk-browser")).isTrue();
        assertTimeRefusal(stream(client, "live"));
        assertThat(rig.browserTime.view().usedMillis()).isGreaterThanOrEqualTo(60_000);
        // Kept, so a restart of deskd finds it used.
        Map<String, Object> kept = Json.parseObject(Files.readAllBytes(rig.dataDir.resolve(BrowserTime.FILE)));
        assertThat(((Number) Json.object(kept, "day").get("usedMs")).longValue()).isGreaterThanOrEqualTo(60_000);
    }

    @Test
    void anUpgradeLiftsTheLimitAtTheNextConfigWithNothingRestarted() throws Exception {
        used(Duration.ofMinutes(2));
        rig(FAST_BEATS, ONE_MINUTE).bootToReady();
        TestClient client = connect("cs-1", 1);
        assertTimeRefusal(stream(client, "live"));

        rig.platform.tierLimits = FakePlatform.NO_TIER_LIMITS;
        newConfig();
        await().atMost(Duration.ofSeconds(10)).until(() -> timeUsedInHealth() == null);
        assertThat(rig.state.tierLimits().current()).isNull();
        assertThat(stream(client, "live")).containsEntry("_kind", "RES").containsEntry("state", "live");
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER);
        Map<String, Object> kept = Json.parseObject(Files.readAllBytes(rig.dataDir.resolve(TierLimits.FILE)));
        assertThat(kept).containsEntry("limits", null);
    }

    @Test
    void limitsThatAppearOnARunningDeskEndAStreamWhoseDayIsAlreadyUsed() throws Exception {
        // Free this morning, paid for a while, free again: this morning's two minutes still count today.
        used(Duration.ofMinutes(2));
        rig(FAST_BEATS, FakePlatform.NO_TIER_LIMITS).bootToReady();
        TestClient client = connect("cs-1", 1);
        assertThat(stream(client, "live")).containsEntry("_kind", "RES").containsEntry("state", "live");
        assertThat(rig.rtc.awaitJson("session.video")).containsEntry("view", true);

        rig.platform.tierLimits = ONE_MINUTE;
        newConfig();
        awaitVideoCut();
        assertTimeRefusal(stream(client, "live"));
        assertThat(rig.units.isRunning("desk-browser")).isTrue();
        assertThat(stream(client, "warm")).containsEntry("_kind", "RES").containsEntry("state", "warm");
    }

    @Test
    void aFailedReadOrAMalformedFieldKeepsTheLimits() throws Exception {
        used(Duration.ofMinutes(2));
        rig(FAST_BEATS, ONE_MINUTE).bootToReady();
        TestClient client = connect("cs-1", 1);
        assertTimeRefusal(stream(client, "live"));

        // A read that fails: nothing changes.
        rig.platform.tierLimits = FakePlatform.NO_TIER_LIMITS;
        // Each heartbeat asks again while the version differs, so enough failures for the whole check.
        for (int i = 0; i < 40; i++) {
            rig.platform.configReplies.add(new FakePlatform.Reply(
                    503, "{\"error\":{\"code\":\"unavailable\",\"message\":\"later\"}}", Map.of("Retry-After", "30")));
        }
        long reads = rig.platform.countApi("/v1/agent/config");
        newConfig();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.platform.countApi("/v1/agent/config") > reads);
        assertTimeRefusal(stream(client, "live"));
        assertThat(rig.state.tierLimits().current()).isNotNull();
    }

    @Test
    void aMalformedFieldKeepsTheLimitsAndAGoodConfigLiftsThem() throws Exception {
        used(Duration.ofMinutes(2));
        rig(FAST_BEATS, ONE_MINUTE).bootToReady();
        TestClient client = connect("cs-1", 1);

        rig.platform.tierLimits = "free";
        long reads = rig.platform.countApi("/v1/agent/config");
        newConfig();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.platform.countApi("/v1/agent/config") > reads);
        assertTimeRefusal(stream(client, "live"));
        assertThat(rig.state.tierLimits().current().browserMinutesPerDay()).isEqualTo(1);

        rig.platform.tierLimits = FakePlatform.NO_TIER_LIMITS;
        newConfig();
        await().atMost(Duration.ofSeconds(10)).until(() -> timeUsedInHealth() == null);
        assertThat(stream(client, "live")).containsEntry("_kind", "RES").containsEntry("state", "live");
    }

    @Test
    void helloWhoseConfigThePlatformCouldntFinishLiftsNothing() throws Exception {
        used(Duration.ofMinutes(2));
        Files.write(dir.resolve("data").resolve(TierLimits.FILE), Json.bytes(Map.of("limits", ONE_MINUTE)));
        rig(ControlPlaneRig.SLOW_BEATS, FakePlatform.NO_TIER_LIMITS);
        rig.platform.helloConfigVersion = 0L;
        // And the read that would follow fails for a while, so what hello's copy did is what stands.
        for (int i = 0; i < 3; i++) {
            rig.platform.configReplies.add(new FakePlatform.Reply(
                    503, "{\"error\":{\"code\":\"unavailable\",\"message\":\"later\"}}", Map.of("Retry-After", "30")));
        }
        rig.bootToReady();
        TestClient client = connect("cs-1", 1);
        assertTimeRefusal(stream(client, "live"));
        assertThat(rig.state.tierLimits().current()).isEqualTo(new TierLimits.Limits("free", 1, 2, 30));
    }

    @Test
    void theHeartbeatCarriesTheSecondsTheBrowserWasLiveSinceBoot() throws Exception {
        rig(FAST_BEATS, FakePlatform.NO_TIER_LIMITS).bootToReady();
        TestClient client = connect("cs-1", 1);
        assertThat(stream(client, "live")).containsEntry("_kind", "RES").containsEntry("state", "live");
        assertThat(rig.rtc.awaitJson("session.video")).containsEntry("view", true);
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.browserTime.liveSecondsSinceBoot() >= 2);
        assertThat(stream(client, "off")).containsEntry("_kind", "RES");
        long seconds = rig.browserTime.liveSecondsSinceBoot();
        await().atMost(Duration.ofSeconds(10)).until(() -> {
            FakePlatform.Request beat = rig.platform.awaitApi("/v1/agent/heartbeat");
            Map<String, Object> media = Json.object(beat.json(), "media");
            return media != null && media.get("browserLiveSeconds") instanceof Number n && n.longValue() == seconds;
        });
        // On a paid desk nothing is held to a day.
        assertThat(rig.browserTime.view().limited()).isFalse();
        assertThat(rig.browserTime.outUntil()).isNull();
    }
}
