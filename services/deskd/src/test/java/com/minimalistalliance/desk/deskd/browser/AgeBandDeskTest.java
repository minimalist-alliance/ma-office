package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.testing.ControlPlaneRig;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * The teen Browser lock from the Platform's own answers through the control plane as it's wired, to the file, a client's
 * {@code browser.stream.set} and the units: each answer the config can give, how a change of band arrives with no restart
 * of deskd, and what it does to a Chromium that's running.
 */
@ExtendWith(OutputCaptureExtension.class)
class AgeBandDeskTest {

    private static final String TAB = "ab".repeat(32);
    private static final String CONFIG = "/v1/agent/config";
    private static final String START_BROWSER = "start desk-browser";
    private static final String STOP_BROWSER = "stop desk-browser";
    private static final HeartbeatLoop.Timing FAST_BEATS =
            new HeartbeatLoop.Timing(Duration.ofMillis(300), Duration.ofMillis(100), Duration.ofSeconds(5));
    private static final FakePlatform.Reply UNREADABLE = FakePlatform.Reply.of(
            503, "{\"error\":{\"code\":\"service_unavailable\",\"message\":\"The membership can't be read.\",\"retryable\":true}}");
    private static final long QUIET_MILLIS = 200;

    @TempDir
    Path dir;

    private ControlPlaneRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    private ControlPlaneRig rig() throws Exception {
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, ControlPlaneRig.SLOW_BEATS);
        return rig;
    }

    /** The file as an earlier deskd left it. */
    private ControlPlaneRig rigWithFile(String line) throws Exception {
        Files.writeString(Files.createDirectories(dir.resolve("data")).resolve(AgeBand.FILE), line);
        return rig();
    }

    private Path file() {
        return rig.dataDir.resolve(AgeBand.FILE);
    }

    private String onDisk() throws IOException {
        return Files.readString(file());
    }

    /** The band reads as the Platform's word before the file does, on purpose: a start is gated on the file. */
    private void awaitFile(String line) {
        await().atMost(Duration.ofSeconds(10)).until(() -> Files.exists(file()) && onDisk().equals(line));
    }

    private static Map<String, Object> message(String type, Object... pairs) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("type", type);
        for (int i = 0; i < pairs.length; i += 2) {
            message.put((String) pairs[i], pairs[i + 1]);
        }
        return message;
    }

    private TestClient connect() throws Exception {
        rig.gateway.send(message(
                "session.open", "sessionId", "cs-1", "deskToken", rig.platform.tokens.mint(TAB, Instant.now()),
                "openedAt", Instant.now().toString()));
        assertThat(rig.gateway.await("session.accept")).containsEntry("sessionId", "cs-1");
        rig.gateway.send(message("signal", "sessionId", "cs-1", "data", Map.of("type", "offer", "sdp", TestClient.offerFor(TAB))));
        assertThat(rig.gateway.await("signal")).containsEntry("sessionId", "cs-1");
        TestClient client = new TestClient(rig.rtc, 1);
        client.hello();
        return client;
    }

    private static Map<String, Object> stream(TestClient client, String state) throws Exception {
        return client.call("browser.stream.set", Map.of("state", state));
    }

    private static void assertGated(Map<String, Object> reply) {
        assertThat(reply)
                .containsEntry("_kind", "ERR")
                .containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("reason", "age_band"));
    }

    private long count(String request) {
        return rig.units.requests().stream().filter(request::equals).count();
    }

    private void assertNoMoreRequests() throws InterruptedException {
        List<String> before = rig.units.requests();
        Thread.sleep(QUIET_MILLIS);
        assertThat(rig.units.requests()).isEqualTo(before);
    }

    /** A push telling the desk to read its config: it works whichever the heartbeat period is. */
    private void platformSays(Object band) {
        rig.platform.ageBand = band;
        rig.platform.configVersion++;
        rig.gateway.send(message("notify", "topic", "config", "configVersion", rig.platform.configVersion));
    }

    private void goLive(TestClient client) throws Exception {
        assertThat(stream(client, "live")).containsEntry("_kind", "RES").containsEntry("state", "live");
    }

    @SuppressWarnings("unchecked")
    private Object ageGateInHealth() {
        return ((Map<String, Object>) rig.browser.health().get("browser")).get("ageGate");
    }

    // ---- each answer

    @Test
    void anAdultFromHellosConfigIsWrittenOnceAndNothingElseChanges() throws Exception {
        rig().bootToReady();
        assertThat(onDisk()).isEqualTo("adult\n");
        assertThat(rig.platform.countApi(CONFIG)).isZero();

        TestClient client = connect();
        goLive(client);
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER);
        assertThat(ageGateInHealth()).isNull();
    }

    @Test
    void aTeenFromHellosConfigIsWrittenBeforeAnySessionCanAsk() throws Exception {
        rig();
        rig.platform.ageBand = "teen";
        rig.bootToReady();
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.TEEN);

        TestClient client = connect();
        goLive(client);
        List<String> requests = rig.units.requests();
        assertThat(requests.indexOf(STOP_BROWSER)).isLessThan(requests.indexOf(START_BROWSER));
    }

    @Test
    void noFieldOnTheGetWithNoFileIsAnAdultAndAdultIsWritten() throws Exception {
        rig();
        rig.platform.helloCarriesConfig = false;
        rig.platform.ageBand = FakePlatform.NO_AGE_BAND;
        rig.bootToReady();
        await().until(() -> rig.ageBand.band() == AgeBand.Band.ADULT);
        // As on main: absent means adult, and the file says so.
        await().untilAsserted(() -> assertThat(file()).hasContent("adult\n"));
        goLive(connect());
        await().until(() -> count(START_BROWSER) == 1);
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER);
        assertThat(rig.platform.countApi(CONFIG)).isEqualTo(1);
    }

    // ---- a Platform that leaves the field out never lowers a band (TD-2)

    @Test
    void aTeensFileOutlastsAPlatformWithoutTheField() throws Exception {
        rigWithFile("teen\n");
        rig.platform.ageBand = FakePlatform.NO_AGE_BAND;
        rig.bootToReady();
        // Hello's copy says nothing, so it asks the GET, which says nothing too.
        await().until(() -> rig.platform.countApi(CONFIG) == 1);
        Thread.sleep(QUIET_MILLIS);
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(rig.platform.countApi(CONFIG)).isEqualTo(1);
        goLive(connect());
    }

    @Test
    void aPlatformThatLosesTheFieldMidRunLeavesATeenATeen() throws Exception {
        rig();
        rig.platform.ageBand = "teen";
        rig.bootToReady();
        TestClient client = connect();
        goLive(client);
        assertThat(onDisk()).isEqualTo("teen\n");
        rig.units.clearRequests();

        // A rollback of the Platform, or its env var gone: the config still comes, with no ageBand.
        long reads = rig.platform.countApi(CONFIG);
        platformSays(FakePlatform.NO_AGE_BAND);
        await().until(() -> rig.platform.countApi(CONFIG) > reads);
        Thread.sleep(QUIET_MILLIS);
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER, START_BROWSER);

        // Only an explicit adult brings it down.
        platformSays("adult");
        awaitFile("adult\n");
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.ADULT);
    }

    @Test
    void anExplicitAdultInHellosCopyBringsATeenDown() throws Exception {
        rigWithFile("teen\n");
        rig.platform.ageBand = "adult";
        rig.bootToReady();
        assertThat(onDisk()).isEqualTo("adult\n");
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.ADULT);
        assertThat(rig.platform.countApi(CONFIG)).isZero();
    }

    @Test
    void anExplicitTeenInHellosCopyRaisesAnAdult() throws Exception {
        rigWithFile("adult\n");
        rig.platform.ageBand = "teen";
        rig.bootToReady();
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(rig.platform.countApi(CONFIG)).isZero();
    }

    @Test
    void aCorruptFileIsATeensUntilThePlatformSays() throws Exception {
        rigWithFile("adult\r\n");
        rig.platform.ageBand = FakePlatform.NO_AGE_BAND;
        rig.bootToReady();
        await().until(() -> rig.platform.countApi(CONFIG) == 1);
        Thread.sleep(QUIET_MILLIS);
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(onDisk()).isEqualTo("adult\r\n");
        // The image locks anything but exactly adult, so the Browser needn't wait.
        TestClient client = connect();
        goLive(client);

        platformSays("adult");
        awaitFile("adult\n");
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.ADULT);
    }

    @Test
    void helloWithoutTheFieldAsksTheGetAndATeenIsNeverTakenForAnAdultMeanwhile() throws Exception {
        rig();
        List<AgeBand.Band> seen = new CopyOnWriteArrayList<>();
        rig.ageBand.onSettled(() -> seen.add(rig.ageBand.band()));
        rig.platform.helloOmitsAgeBand = true;
        rig.platform.ageBand = "teen";
        rig.bootToReady();

        awaitFile("teen\n");
        await().until(() -> !seen.isEmpty());
        assertThat(seen).containsOnly(AgeBand.Band.TEEN);
        assertThat(rig.platform.countApi(CONFIG)).isEqualTo(1);
    }

    @Test
    void helloWithoutTheFieldOnAPlatformThatDoesntHaveItEndsAsAnAdultWithTheDefaultWritten() throws Exception {
        rig();
        rig.platform.helloOmitsAgeBand = true;
        rig.platform.ageBand = FakePlatform.NO_AGE_BAND;
        rig.bootToReady();
        await().until(() -> rig.ageBand.band() == AgeBand.Band.ADULT);
        await().untilAsserted(() -> assertThat(file()).hasContent("adult\n"));
    }

    @Test
    void a503WithABandOnDiskIsRetriedAndAnAdultsBrowserDoesntWaitForIt() throws Exception {
        rigWithFile("adult\n");
        rig.platform.helloOmitsAgeBand = true;
        for (int i = 0; i < 1000; i++) {
            rig.platform.configReplies.add(UNREADABLE);
        }
        rig.bootToReady();
        TestClient client = connect();
        await().until(() -> rig.platform.countApi(CONFIG) >= 3);

        goLive(client);
        assertThat(onDisk()).isEqualTo("adult\n");
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.ADULT);

        long then = rig.platform.countApi(CONFIG);
        rig.platform.configReplies.clear();
        rig.platform.ageBand = "teen";
        awaitFile("teen\n");
        assertThat(rig.platform.countApi(CONFIG)).isGreaterThan(then);
        // And it's quiet once a read has worked.
        long settled = rig.platform.countApi(CONFIG);
        Thread.sleep(QUIET_MILLIS);
        assertThat(rig.platform.countApi(CONFIG)).isEqualTo(settled);
    }

    @Test
    void unknownAtStartGatesTheBrowserUntilABandReleasesTheWaitingLive() throws Exception {
        rig();
        rig.platform.helloOmitsAgeBand = true;
        for (int i = 0; i < 1000; i++) {
            rig.platform.configReplies.add(UNREADABLE);
        }
        rig.bootToReady();
        TestClient client = connect();

        assertGated(stream(client, "live"));
        assertThat(rig.units.requests()).doesNotContain(START_BROWSER);
        assertThat(ageGateInHealth()).isEqualTo("closed");
        assertThat(file()).doesNotExist();
        // Nothing else in the Browser, or on the desk, waits for it.
        assertThat(client.call("desk.status.get", Map.of())).containsEntry("_kind", "RES");

        rig.platform.configReplies.clear();
        rig.platform.ageBand = "adult";
        assertThat(rig.rtc.awaitJson("session.video")).containsEntry("view", true);
        assertThat(rig.units.requests()).contains(START_BROWSER);
        awaitFile("adult\n");
        assertThat(ageGateInHealth()).isNull();
    }

    @Test
    void aReplyThatIsntAConfigIsNeverTakenForAMissingField() throws Exception {
        rig();
        rig.platform.helloOmitsAgeBand = true;
        rig.platform.configReplies.add(FakePlatform.Reply.of(200, "{\"message\":\"not a config\"}"));
        rig.platform.configReplies.add(FakePlatform.Reply.of(200, "not even JSON"));
        for (int i = 0; i < 1000; i++) {
            rig.platform.configReplies.add(UNREADABLE);
        }
        rig.bootToReady();
        await().until(() -> rig.platform.countApi(CONFIG) >= 4);
        assertThat(rig.ageBand.band()).isNull();
        assertThat(file()).doesNotExist();
    }

    @Test
    void anOddValueKeepsWhatsOnDiskAndDoesntHoldTheBrowser() throws Exception {
        rigWithFile("teen\n");
        rig.platform.ageBand = "zebra-value";
        rig.bootToReady();
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.TEEN);
        goLive(connect());
        assertThat(rig.platform.countApi(CONFIG)).isZero();
    }

    @Test
    void aNullOnAnUnknownDeskStaysGatedAndATrueAnswerReleasesIt() throws Exception {
        rig();
        rig.platform.ageBand = null;
        rig.bootToReady();
        TestClient client = connect();
        assertGated(stream(client, "live"));
        assertThat(file()).doesNotExist();

        rig.platform.ageBand = "teen";
        assertThat(rig.rtc.awaitJson("session.video")).containsEntry("view", true);
        awaitFile("teen\n");
    }

    // ---- how a change arrives, with no restart of deskd

    @Test
    void aNewConfigVersionOnAHeartbeatBringsABandChange() throws Exception {
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, FAST_BEATS);
        rig.platform.nextHeartbeatSeconds = null;
        rig.bootToReady();
        assertThat(onDisk()).isEqualTo("adult\n");
        goLive(connect());

        rig.platform.ageBand = "teen";
        rig.platform.configVersion = 13;
        await().atMost(Duration.ofSeconds(10)).until(() -> count(STOP_BROWSER) == 1 && count(START_BROWSER) == 2);
        assertThat(onDisk()).isEqualTo("teen\n");
    }

    @Test
    void aNotifyConfigBringsABandChange() throws Exception {
        rig().bootToReady();
        platformSays("teen");
        awaitFile("teen\n");
    }

    @Test
    void aHelloTheHeartbeatAsksForBringsABandChange() throws Exception {
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, FAST_BEATS);
        rig.platform.nextHeartbeatSeconds = null;
        rig.bootToReady();
        rig.platform.ageBand = "teen";
        rig.platform.heartbeatReplies.add(FakePlatform.Reply.of(200, rig.platform.heartbeatReply(List.of("hello_required"))));
        awaitFile("teen\n");
    }

    @Test
    void withTheSameVersionAndNoPushNothingArrives() throws Exception {
        // Why this needs the Platform to bump configVersion on a change of band: deskd has no poll to find it by.
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, FAST_BEATS);
        rig.platform.nextHeartbeatSeconds = null;
        rig.bootToReady();
        rig.platform.ageBand = "teen";
        long beats = rig.platform.countApi("/v1/agent/heartbeat");
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.platform.countApi("/v1/agent/heartbeat") >= beats + 3);
        assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.ADULT);
        assertThat(rig.platform.countApi(CONFIG)).isZero();
    }

    // ---- a change of band, with Chromium running

    @Test
    void adultToTeenRestartsChromiumNow() throws Exception {
        rig().bootToReady();
        TestClient client = connect();
        goLive(client);
        assertThat(rig.rtc.awaitJson("session.video")).containsEntry("view", true);
        rig.units.clearRequests();

        platformSays("teen");
        await().until(() -> count(START_BROWSER) == 1);
        assertThat(rig.units.requests()).containsExactly(STOP_BROWSER, START_BROWSER);
        assertThat(rig.units.isRunning("desk-browser")).isTrue();
        assertThat(onDisk()).isEqualTo("teen\n");
        goLive(client);
    }

    @Test
    void adultToTeenWithChromiumDownStartsNoChromium() throws Exception {
        rig().bootToReady();
        platformSays("teen");
        await().until(() -> count(STOP_BROWSER) == 1);
        Thread.sleep(QUIET_MILLIS);
        assertThat(rig.units.requests()).doesNotContain(START_BROWSER);
    }

    @Test
    void teenToAdultWaitsForTheNextStart() throws Exception {
        rigWithFile("teen\n");
        rig.platform.ageBand = "teen";
        rig.bootToReady();
        TestClient client = connect();
        goLive(client);
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER);
        rig.units.clearRequests();

        platformSays("adult");
        awaitFile("adult\n");
        Thread.sleep(QUIET_MILLIS);
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER, START_BROWSER);
    }

    @Test
    void teenToAdultRestartsChromiumOnceNobodyStreamsAndKeepsThatOwedMeanwhile() throws Exception {
        rigWithFile("teen\n");
        rig.platform.ageBand = "teen";
        rig.bootToReady();
        TestClient client = connect();
        goLive(client);
        rig.units.clearRequests();

        platformSays("adult");
        awaitFile("adult\n");
        await().until(() -> Files.exists(rig.dataDir.resolve(BrowserModule.UNLOCK_OWED_MARKER)));
        assertThat(Files.readString(rig.dataDir.resolve(BrowserModule.UNLOCK_OWED_MARKER))).isEqualTo(ControlPlaneRig.BOOT_ID + "\n");
        // Never where rtc can write.
        assertThat(Files.exists(dir.resolve(BrowserModule.UNLOCK_OWED_MARKER))).isFalse();
        Thread.sleep(QUIET_MILLIS);
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER, START_BROWSER);

        assertThat(stream(client, "off")).containsEntry("_kind", "RES");
        await().until(() -> count(START_BROWSER) == 1);
        assertThat(rig.units.requests().stream().filter(r -> r.endsWith("desk-browser")).toList()).containsExactly(STOP_BROWSER, START_BROWSER);
        assertThat(rig.units.isRunning("desk-browser")).isTrue();
        await().until(() -> !Files.exists(rig.dataDir.resolve(BrowserModule.UNLOCK_OWED_MARKER)));
        assertThat(Files.exists(rig.dataDir.resolve(BrowserModule.LOCK_OWED_MARKER))).isFalse();
    }

    @Test
    void aFirstBootsAdultAsksNoStopOfAChromiumThatsDown() throws Exception {
        rig().bootToReady();
        awaitFile("adult\n");
        await().until(() -> !Files.exists(rig.dataDir.resolve(BrowserModule.UNLOCK_OWED_MARKER)));
        assertNoMoreRequests();
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER, START_BROWSER);
    }

    @Test
    void aLockOwedByAnEarlierDeskdOfThisBootStopsChromiumAsTheNextOneStarts() throws Exception {
        Files.writeString(Files.createDirectories(dir.resolve("data")).resolve(BrowserModule.LOCK_OWED_MARKER), ControlPlaneRig.BOOT_ID + "\n");
        rigWithFile("teen\n");
        rig.platform.ageBand = "teen";
        await().until(() -> count(STOP_BROWSER) == 1);
        await().until(() -> !Files.exists(rig.dataDir.resolve(BrowserModule.LOCK_OWED_MARKER)));
        rig.bootToReady();
        TestClient client = connect();
        goLive(client);
    }

    @Test
    void aLockOwedBeforeARebootAsksNothingAndGoes() throws Exception {
        // The data volume outlives a reboot, and Chromium doesn't: another boot's marker asks nothing, and goes.
        Files.writeString(Files.createDirectories(dir.resolve("data")).resolve(BrowserModule.LOCK_OWED_MARKER),
                "99999999-0000-4000-8000-000000000099\n");
        rigWithFile("adult\n");
        assertThat(Files.exists(rig.dataDir.resolve(BrowserModule.LOCK_OWED_MARKER))).isFalse();
        rig.bootToReady();
        assertNoMoreRequests();
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER, START_BROWSER);
    }

    @Test
    void aRestartWaitsForAHoldAndThenBringsChromiumBack() throws Exception {
        rig().bootToReady();
        TestClient client = connect();
        goLive(client);
        rig.units.clearRequests();

        rig.browser.holdBrowser().join();
        assertThat(rig.units.requests()).containsExactly(STOP_BROWSER);
        assertThat(rig.units.isRunning("desk-browser")).isFalse();

        platformSays("teen");
        awaitFile("teen\n");
        assertNoMoreRequests();
        // A hold keeps saying what it says, whatever the gate does.
        assertThat(stream(client, "live")).containsEntry("details", Map.of("reason", "held"));

        rig.browser.releaseBrowser();
        await().until(() -> count(START_BROWSER) == 1);
        List<String> requests = rig.units.requests();
        assertThat(requests.subList(0, 3)).containsExactly(STOP_BROWSER, STOP_BROWSER, START_BROWSER);
        assertThat(rig.units.isRunning("desk-browser")).isTrue();
    }

    // ---- a write that fails

    @Test
    void aFailedWriteKeepsATeensDeskGatedUntilTheFileIsRight(CapturedOutput output) throws Exception {
        rig().bootToReady();
        TestClient client = connect();
        goLive(client);
        assertThat(onDisk()).isEqualTo("adult\n");
        rig.units.clearRequests();

        Files.setPosixFilePermissions(rig.dataDir, PosixFilePermissions.fromString("r-xr-xr-x"));
        try {
            assumeFalse(Files.isWritable(rig.dataDir));
            platformSays("teen");
            // Chromium stops, as it can't stay on the adult policy, and doesn't come back.
            await().until(() -> count(STOP_BROWSER) == 1);
            await().until(() -> output.getAll().contains("couldn't write"));
            Thread.sleep(QUIET_MILLIS);
            assertThat(rig.units.requests()).doesNotContain(START_BROWSER);
            assertThat(onDisk()).isEqualTo("adult\n");
            assertThat(rig.ageBand.band()).isEqualTo(AgeBand.Band.TEEN);
            assertGated(stream(client, "live"));
            assertThat(ageGateInHealth()).isEqualTo("closed");
            // It keeps reading, so it isn't left like this once the volume is back.
            long reads = rig.platform.countApi(CONFIG);
            await().until(() -> rig.platform.countApi(CONFIG) > reads);
        } finally {
            Files.setPosixFilePermissions(rig.dataDir, PosixFilePermissions.fromString("rwx------"));
        }

        awaitFile("teen\n");
        await().until(() -> count(START_BROWSER) == 1);
        assertThat(rig.units.isRunning("desk-browser")).isTrue();
        assertThat(ageGateInHealth()).isNull();
    }

    // ---- the log

    @Test
    void theLogHasNoAccountAndNoBandButTheTransition(CapturedOutput output) throws Exception {
        rig().bootToReady();
        goLive(connect());
        platformSays("teen");
        await().until(() -> count(START_BROWSER) == 2);
        assertThat(output.getAll()).contains("age band: unknown to adult", "age band: adult to teen");
        assertThat(output.getAll().lines().filter(line -> line.contains("age band")))
                .allSatisfy(line -> assertThat(line).doesNotContain(com.minimalistalliance.desk.deskd.testing.TestTokens.OWNER_ID));
    }
}
