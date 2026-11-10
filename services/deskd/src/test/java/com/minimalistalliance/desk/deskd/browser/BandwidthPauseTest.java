package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.ControlPlaneRig;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Platform's bandwidth pause (ma-platform ADR 0095, contract bandwidth.md, "What a desk hears"), from the Platform's
 * own replies through the control plane as it's wired, to a client's {@code browser.stream.set} and the units: a new
 * {@code live} is refused and an open one ended while the pause is on, Chromium is never stopped, and nothing else
 * changes.
 */
class BandwidthPauseTest {

    private static final String TAB = "ab".repeat(32);
    private static final String START_BROWSER = "start desk-browser";
    private static final String STOP_BROWSER = "stop desk-browser";
    private static final String STOP_STREAM = "stop desk-stream";
    private static final HeartbeatLoop.Timing FAST_BEATS =
            new HeartbeatLoop.Timing(Duration.ofMillis(300), Duration.ofMillis(100), Duration.ofSeconds(5));

    @TempDir
    Path dir;

    private ControlPlaneRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    private ControlPlaneRig rig(HeartbeatLoop.Timing beats) throws Exception {
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, beats);
        // Every heartbeat at the loop's own period, not the reply's 60 s.
        rig.platform.nextHeartbeatSeconds = null;
        return rig;
    }

    private static Map<String, Object> streaming(String profile, Instant resumesAt) {
        Map<String, Object> streaming = new LinkedHashMap<>();
        streaming.put("streamProfile", profile);
        streaming.put("allowanceRemainingGb", "paused".equals(profile) ? 0 : 58.3);
        streaming.put("targetKbps", null);
        streaming.put("reason", "paused".equals(profile) ? "weekly_limit" : null);
        streaming.put("resumesAt", resumesAt == null ? null : resumesAt.toString());
        return streaming;
    }

    private static Map<String, Object> message(String type, Object... pairs) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("type", type);
        for (int i = 0; i < pairs.length; i += 2) {
            message.put((String) pairs[i], pairs[i + 1]);
        }
        return message;
    }

    /** All the way to a bound session that has said HELLO, through the gateway with a real token. */
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

    private static void assertPausedRefusal(Map<String, Object> reply, Instant resumesAt) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
        Map<String, Object> details = Json.object(reply, "details");
        assertThat(details).containsEntry("reason", "bandwidth_limit").containsEntry("resumesAt", resumesAt.toString());
    }

    /** session.video for this session until one says view is false, or fails after the fake's wait. */
    private void awaitVideoCut() throws Exception {
        while (true) {
            Map<String, Object> video = rig.rtc.awaitJson("session.video");
            if (Boolean.FALSE.equals(video.get("view"))) {
                return;
            }
        }
    }

    @SuppressWarnings("unchecked")
    private Object pausedInHealth() {
        return ((Map<String, Object>) rig.browser.health().get("browser")).get("bandwidthPaused");
    }

    @Test
    void whilePausedLiveIsRefusedAndWarmAndEverythingElseStillWork() throws Exception {
        Instant resumesAt = Instant.now().plus(Duration.ofDays(2)).truncatedTo(ChronoUnit.SECONDS);
        rig(ControlPlaneRig.SLOW_BEATS).platform.streaming = streaming("paused", resumesAt);
        // Hello's config carries it, so the pause is known before any session can come.
        rig.bootToReady();
        TestClient client = connect("cs-1", 1);

        assertPausedRefusal(stream(client, "live"), resumesAt);
        assertThat(rig.units.requests()).doesNotContain(START_BROWSER);
        assertThat(stream(client, "warm")).containsEntry("_kind", "RES").containsEntry("state", "warm");
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");
        assertThat(pausedInHealth()).isEqualTo(resumesAt.toString());
        // Asked again, still no: nothing reached the units for Chromium.
        assertPausedRefusal(stream(client, "live"), resumesAt);
        assertThat(rig.units.requests()).doesNotContain(START_BROWSER, STOP_BROWSER);
    }

    @Test
    void aHeartbeatThatSaysPausedEndsAnOpenStreamAndLeavesChromiumRunningUntilItSaysNormal() throws Exception {
        rig(FAST_BEATS).bootToReady();
        TestClient client = connect("cs-1", 1);
        assertThat(stream(client, "live")).containsEntry("_kind", "RES").containsEntry("state", "live");
        assertThat(rig.rtc.awaitJson("session.video")).containsEntry("view", true);
        assertThat(rig.units.isRunning("desk-browser")).isTrue();

        Instant resumesAt = Instant.now().plus(Duration.ofDays(2)).truncatedTo(ChronoUnit.SECONDS);
        rig.platform.streaming = streaming("paused", resumesAt);
        awaitVideoCut();
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.units.requests().contains(STOP_STREAM));
        // The stream stops. Chromium, its tabs and its profile are left alone (ADR 0035).
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER);
        assertThat(rig.units.isRunning("desk-browser")).isTrue();
        assertPausedRefusal(stream(client, "live"), resumesAt);
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");

        rig.platform.streaming = streaming("normal", null);
        await().atMost(Duration.ofSeconds(10)).until(() -> pausedInHealth() == null);
        assertThat(stream(client, "live")).containsEntry("_kind", "RES").containsEntry("state", "live");
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER);
    }

    @Test
    void thePauseEndsByItselfAtResumesAtWithNoNewReply() throws Exception {
        Instant resumesAt = Instant.now().plusSeconds(3).truncatedTo(ChronoUnit.SECONDS).plusSeconds(1);
        rig(ControlPlaneRig.SLOW_BEATS).platform.streaming = streaming("paused", resumesAt);
        rig.bootToReady();
        TestClient client = connect("cs-1", 1);
        assertPausedRefusal(stream(client, "live"), resumesAt);

        await().atMost(Duration.ofSeconds(10)).until(() -> !Instant.now().isBefore(resumesAt));
        assertThat(stream(client, "live")).containsEntry("_kind", "RES").containsEntry("state", "live");
    }

    @Test
    void anOwnersDataReadHearsThePauseFromTheHeartbeatAndComesBackWithIt() throws Exception {
        rig(FAST_BEATS).bootToReady();
        TestClient client = connect("cs-1", 1);
        Map<String, Object> read = Map.of("part", "files", "path", "a.bin");
        // The rig has no desk-data, so a read that isn't refused for the pause is refused for that.
        assertThat(Json.object(client.call("data.read", read), "details")).containsEntry("reason", "helper");

        Instant resumesAt = Instant.now().plus(Duration.ofDays(2)).truncatedTo(ChronoUnit.SECONDS);
        rig.platform.streaming = streaming("paused", resumesAt);
        await().atMost(Duration.ofSeconds(10)).until(() -> pausedInHealth() != null);
        assertPausedRefusal(client.call("data.read", read), resumesAt);
        assertThat(client.call("data.parts.list", Map.of())).containsEntry("code", "unavailable")
                .extracting(reply -> Json.object(reply, "details")).isEqualTo(Map.of("reason", "helper"));

        rig.platform.streaming = streaming("normal", null);
        await().atMost(Duration.ofSeconds(10)).until(() -> pausedInHealth() == null);
        assertThat(Json.object(client.call("data.read", read), "details")).containsEntry("reason", "helper");
    }

    @Test
    void aPlatformThatSaysNothingOfStreamingPausesNothing() throws Exception {
        rig(FAST_BEATS).bootToReady();
        TestClient client = connect("cs-1", 1);
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.platform.countApi("/v1/agent/heartbeat") >= 2);
        assertThat(stream(client, "live")).containsEntry("_kind", "RES").containsEntry("state", "live");
        assertThat(pausedInHealth()).isNull();
    }
}
