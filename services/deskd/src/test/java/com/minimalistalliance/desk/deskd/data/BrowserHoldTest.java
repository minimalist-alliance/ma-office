package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** data.browser.hold and release, through the real Browser module down to a stub units.sock. */
class BrowserHoldTest {

    private static final String STOP_BROWSER = "stop desk-browser";
    private static final String START_BROWSER = "start desk-browser";

    @TempDir
    Path dir;

    private DataRig rig;

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private Map<String, Object> live(TestClient client) throws Exception {
        return rig.call(client, "browser.stream.set", Map.of("state", "live"));
    }

    private static void assertHeldRefusal(Map<String, Object> reply) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
        assertThat(Json.object(reply, "details")).isEqualTo(Map.of("reason", "held"));
    }

    @Test
    void aHoldStopsChromiumAndRefusesLiveAndWarmUntilTheHoldingSessionEnds() throws Exception {
        rig = new DataRig(dir);
        TestClient owner = rig.owner("cs-1");
        TestClient export = rig.export("cs-2");

        Map<String, Object> held = rig.call(export, "data.browser.hold", Map.of());
        assertThat(held).containsEntry("_kind", "RES").containsEntry("held", true);
        assertThat(Instant.parse((String) held.get("until")))
                .isCloseTo(Instant.now().plus(Duration.ofMinutes(30)), within(1, ChronoUnit.MINUTES));
        // The reply came once Chromium had stopped.
        assertThat(rig.units.requests()).containsExactly(STOP_BROWSER);
        assertThat(rig.units.isRunning("desk-browser")).isFalse();
        assertThat(DataRig.map(rig.browser.health().get("browser"))).containsEntry("held", true);

        assertHeldRefusal(live(owner));
        assertHeldRefusal(rig.call(owner, "browser.stream.set", Map.of("state", "warm")));
        assertThat(rig.call(owner, "browser.stream.set", Map.of("state", "off"))).containsEntry("_kind", "RES");
        assertThat(rig.units.requests()).containsExactly(STOP_BROWSER);

        export.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000, "reason", "done"));
        await().until(() -> !((Map<?, ?>) rig.browser.health().get("browser")).containsKey("held"));
        assertThat(live(owner)).containsEntry("_kind", "RES").containsEntry("state", "live");
        assertThat(rig.units.requests()).contains(START_BROWSER);
    }

    @Test
    void aHoldsStoredReplyIsOnlyGoodInTheSessionThatHolds() throws Exception {
        rig = new DataRig(dir);
        TestClient first = rig.export("cs-1");
        long id = rig.send(first, "data.browser.hold", Map.of(), "same-key");
        Map<String, Object> held = first.nextReply();
        assertThat(held).containsEntry("_id", id).containsEntry("held", true);
        // A retry in the same session still gets the stored reply.
        rig.send(first, "data.browser.hold", Map.of(), "same-key");
        assertThat(first.nextReply()).containsEntry("held", true).containsEntry("until", held.get("until"));

        first.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000, "reason", "done"));
        await().until(() -> !((Map<?, ?>) rig.browser.health().get("browser")).containsKey("held"));

        // Another session's retry with the key runs again, so the hold is real.
        TestClient second = rig.export("cs-2");
        rig.send(second, "data.browser.hold", Map.of(), "same-key");
        assertThat(second.nextReply()).containsEntry("_kind", "RES").containsEntry("held", true);
        assertThat(DataRig.map(rig.browser.health().get("browser"))).containsEntry("held", true);
    }

    @Test
    void aReleaseLetsLiveThroughAndBringsChromiumBackForWhoeverWantedIt() throws Exception {
        rig = new DataRig(dir);
        TestClient owner = rig.owner("cs-1");
        assertThat(live(owner)).containsEntry("state", "live");
        rig.units.clearRequests();

        TestClient export = rig.export("cs-2");
        assertThat(rig.call(export, "data.browser.hold", Map.of())).containsEntry("held", true);
        // Held again: the same hold, and no second stop.
        assertThat(rig.call(export, "data.browser.hold", Map.of())).containsEntry("held", true);
        assertThat(rig.units.requests()).containsExactly(STOP_BROWSER);

        assertThat(rig.call(export, "data.browser.release", Map.of())).containsEntry("_kind", "RES").containsEntry("held", false);
        // The owner's session still wanted live, so Chromium comes back without its asking.
        await().until(() -> rig.units.isRunning("desk-browser"));
        assertThat(rig.units.requests()).containsExactly(STOP_BROWSER, START_BROWSER);
        // Released again, or never held: fine.
        assertThat(rig.call(export, "data.browser.release", Map.of())).containsEntry("held", false);
        assertThat(rig.call(owner, "data.browser.release", Map.of())).containsEntry("held", false);
    }

    @Test
    void aReleaseStartsAChromiumThatWasRunningWithNobodyViewing() throws Exception {
        // Chromium's port, held by this uid as kiosk would hold it: running, with no session live or warm.
        try (ServerSocket chromium = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            rig = new DataRig(dir, chromium.getLocalPort(), true, DataRig.FAST);
            TestClient export = rig.export("cs-1");
            assertThat(rig.call(export, "data.browser.hold", Map.of())).containsEntry("held", true);
            assertThat(rig.call(export, "data.browser.release", Map.of())).containsEntry("held", false);
            // Let go of, a hold leaves the desk as it found it. A move keeps its hold instead (MovedHoldTest).
            await().until(() -> rig.units.isRunning("desk-browser"));
            assertThat(rig.units.requests()).containsExactly(STOP_BROWSER, START_BROWSER);
        }
    }

    @Test
    void aReleaseLeavesAChromiumThatWasntRunningStopped() throws Exception {
        rig = new DataRig(dir);
        TestClient export = rig.export("cs-1");
        assertThat(rig.call(export, "data.browser.hold", Map.of())).containsEntry("held", true);
        assertThat(rig.call(export, "data.browser.release", Map.of())).containsEntry("held", false);
        // A round trip on the same session, so a start the release asked for would have gone by now.
        assertThat(rig.call(export, "desk.status.get", Map.of())).containsEntry("_kind", "RES");
        Thread.sleep(200);
        assertThat(rig.units.requests()).containsExactly(STOP_BROWSER);
    }

    @Test
    void aLiveStillWaitingIsRefusedByTheHold() throws Exception {
        rig = new DataRig(dir);
        TestClient owner = rig.owner("cs-1");
        TestClient export = rig.export("cs-2");
        rig.units.hold(START_BROWSER);
        long id = rig.send(owner, "browser.stream.set", Map.of("state", "live"), null);
        rig.units.awaitHeld(START_BROWSER);
        long holdId = rig.send(export, "data.browser.hold", Map.of(), UUID.randomUUID().toString());
        Map<String, Object> refused = owner.nextReply();
        assertThat(refused).containsEntry("_id", id);
        assertHeldRefusal(refused);
        rig.units.release(START_BROWSER);
        Map<String, Object> held = export.nextReply();
        assertThat(held).containsEntry("_id", holdId).containsEntry("held", true);
        // The start that was under way finished, and the stop came after it.
        assertThat(rig.units.requests()).containsExactly(START_BROWSER, STOP_BROWSER);
        assertThat(rig.units.isRunning("desk-browser")).isFalse();
    }

    @Test
    void aHoldRunsOutOnItsOwn() throws Exception {
        rig = new DataRig(dir, 9, true, new DataModule.Timing(
                Duration.ofSeconds(5), Duration.ofMillis(400), Duration.ofSeconds(5), Duration.ofSeconds(30), Duration.ofMillis(100)));
        TestClient owner = rig.owner("cs-1");
        TestClient export = rig.export("cs-2");
        assertThat(rig.call(export, "data.browser.hold", Map.of())).containsEntry("held", true);
        assertHeldRefusal(live(owner));
        await().atMost(Duration.ofSeconds(5)).until(() -> !((Map<?, ?>) rig.browser.health().get("browser")).containsKey("held"));
        assertThat(live(owner)).containsEntry("state", "live");
    }

    @Test
    void aStopThatFailsHoldsNothing() throws Exception {
        rig = new DataRig(dir);
        TestClient owner = rig.owner("cs-1");
        TestClient export = rig.export("cs-2");
        rig.units.reply(STOP_BROWSER, "err failed stop desk-browser: it wouldn't");
        Map<String, Object> reply = rig.call(export, "data.browser.hold", Map.of());
        assertThat(reply).containsEntry("code", "unavailable");
        assertThat(Json.object(reply, "details")).containsEntry("reason", "chromium").containsEntry("code", "failed")
                .containsEntry("mayHaveApplied", true);
        assertThat(live(owner)).containsEntry("state", "live");
    }

    @Test
    void anExportSessionCantDriveTheStreamButCanHold() throws Exception {
        rig = new DataRig(dir);
        TestClient export = rig.export("cs-1");
        assertThat(rig.call(export, "browser.stream.set", Map.of("state", "live"))).containsEntry("code", "forbidden");
        assertThat(rig.call(export, "data.browser.hold", Map.of())).containsEntry("held", true);
        // A mutation needs idem, as any does.
        long id = rig.send(export, "data.browser.release", Map.of(), null);
        Map<String, Object> noIdem = export.nextReply();
        assertThat(noIdem).containsEntry("_id", id).containsEntry("code", "bad_request");
    }
}
