package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Security's NE-2: once a move has copied the Browser, the cloud desk's Chromium must not start again on the same cookies,
 * or a site that rotates its sign-in tokens signs the member out on their new desk. data.browser.keep keeps the move's
 * hold past its session, through a restart of deskd, until the owner lets go with data.browser.release {kept: true}.
 */
class MovedHoldTest {

    private static final String STOP_BROWSER = "stop desk-browser";
    private static final String START_BROWSER = "start desk-browser";

    @TempDir
    Path dir;

    private DataRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    private Path keptFile() {
        return dir.resolve(BrowserHold.KEPT_FILE);
    }

    private Map<String, Object> live(TestClient client) throws Exception {
        return rig.call(client, "browser.stream.set", Map.of("state", "live"));
    }

    private Map<String, Object> browserHealth() {
        return DataRig.map(rig.browser.health().get("browser"));
    }

    private static void assertMovedRefusal(Map<String, Object> reply, String since) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
        assertThat(Json.object(reply, "details")).isEqualTo(Map.of("reason", "moved", "since", since));
    }

    private static void close(TestClient client) {
        client.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000, "reason", "done"));
    }

    /** A move's last pass as ma-move ends it: hold, keep, release, then the session goes. */
    private String moveKeeps(TestClient move) throws Exception {
        assertThat(rig.call(move, "data.browser.hold", Map.of())).containsEntry("held", true);
        Map<String, Object> kept = rig.call(move, "data.browser.keep", Map.of());
        assertThat(kept).containsEntry("_kind", "RES").containsEntry("held", true).containsEntry("kept", true);
        String since = (String) kept.get("since");
        assertThat(Instant.parse(since)).isBeforeOrEqualTo(Instant.now());
        assertThat(rig.call(move, "data.browser.release", Map.of())).containsEntry("_kind", "RES").containsEntry("held", true);
        close(move);
        return since;
    }

    /**
     * The finding itself. Chromium was running when the move's hold stopped it, and today's release starts it again. Kept,
     * no start of desk-browser goes out after the move: not at the release, not at its session's end, not for a live.
     */
    @Test
    void afterAMoveChromiumIsNeverStartedAgainOnItsOwnOrForALive() throws Exception {
        try (ServerSocket chromium = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            rig = new DataRig(dir, chromium.getLocalPort(), true, DataRig.FAST);
            TestClient owner = rig.owner("cs-1");
            String since = moveKeeps(rig.export("cs-move"));
            await().until(() -> !rig.sessions.isLive("cs-move"));

            assertMovedRefusal(live(owner), since);
            assertMovedRefusal(rig.call(owner, "browser.stream.set", Map.of("state", "warm")), since);
            assertThat(rig.call(owner, "desk.status.get", Map.of())).containsEntry("_kind", "RES");
            Thread.sleep(200);
            assertThat(rig.units.requests()).containsExactly(STOP_BROWSER);
            assertThat(rig.units.isRunning("desk-browser")).isFalse();
            assertThat(browserHealth()).containsEntry("held", true).containsEntry("moved", since);
            assertThat(Files.readString(keptFile())).contains(since);
        }
    }

    @Test
    void aKeptHoldOutlastsARestartOfDeskdAndOnlyTheOwnerLetsGo() throws Exception {
        rig = new DataRig(dir);
        String since = moveKeeps(rig.export("cs-move"));
        await().until(() -> !rig.sessions.isLive("cs-move"));
        rig.close();
        rig = null;

        // deskd starts again: the kept hold is read, and the Browser is held before anyone can ask.
        rig = new DataRig(dir);
        assertThat(browserHealth()).containsEntry("held", true).containsEntry("moved", since);
        await().until(() -> rig.units.requests().contains(STOP_BROWSER));
        TestClient owner = rig.owner("cs-1");
        assertMovedRefusal(live(owner), since);

        // An export session, a download or a move, is never the member's word.
        TestClient export = rig.export("cs-2");
        Map<String, Object> refused = rig.call(export, "data.browser.release", Map.of("kept", true));
        assertThat(refused).containsEntry("code", "forbidden");
        assertThat(Json.object(refused, "details")).containsEntry("reason", "scope");
        assertThat(rig.call(export, "data.browser.release", Map.of())).containsEntry("held", true);
        assertThat(rig.call(owner, "data.browser.release", Map.of("kept", "yes"))).containsEntry("code", "bad_request");
        assertMovedRefusal(live(owner), since);
        assertThat(keptFile()).exists();

        assertThat(rig.call(owner, "data.browser.release", Map.of("kept", true))).containsEntry("_kind", "RES").containsEntry("held", false);
        assertThat(keptFile()).doesNotExist();
        assertThat(browserHealth()).doesNotContainKeys("held", "moved");
        assertThat(live(owner)).containsEntry("_kind", "RES").containsEntry("state", "live");
        assertThat(rig.units.requests()).contains(START_BROWSER);
        // Released again, with nothing kept: fine.
        assertThat(rig.call(owner, "data.browser.release", Map.of("kept", true))).containsEntry("held", false);
    }

    @Test
    void theOwnersReleaseWaitsForASessionStillHolding() throws Exception {
        rig = new DataRig(dir);
        String since = moveKeeps(rig.export("cs-move"));
        TestClient owner = rig.owner("cs-1");
        TestClient copy = rig.export("cs-2");
        assertThat(rig.call(copy, "data.browser.hold", Map.of())).containsEntry("held", true);
        assertMovedRefusal(live(owner), since);

        assertThat(rig.call(owner, "data.browser.release", Map.of("kept", true))).containsEntry("held", true);
        // Now it's an ordinary hold for a copy.
        Map<String, Object> reply = live(owner);
        assertThat(Json.object(reply, "details")).isEqualTo(Map.of("reason", "held"));
        assertThat(rig.call(copy, "data.browser.release", Map.of())).containsEntry("held", false);
        assertThat(live(owner)).containsEntry("state", "live");
    }

    @Test
    void aKeepNeedsThisSessionToHold() throws Exception {
        rig = new DataRig(dir);
        TestClient owner = rig.owner("cs-1");
        TestClient export = rig.export("cs-2");
        Map<String, Object> reply = rig.call(export, "data.browser.keep", Map.of());
        assertThat(reply).containsEntry("code", "unavailable");
        assertThat(Json.object(reply, "details")).containsEntry("reason", "not_held");

        // Another session's hold isn't this one's.
        TestClient other = rig.export("cs-3");
        assertThat(rig.call(other, "data.browser.hold", Map.of())).containsEntry("held", true);
        assertThat(Json.object(rig.call(export, "data.browser.keep", Map.of()), "details")).containsEntry("reason", "not_held");
        assertThat(keptFile()).doesNotExist();
        close(other);
        await().until(() -> !browserHealth().containsKey("held"));
        assertThat(live(owner)).containsEntry("state", "live");
        // A mutation needs idem, as any does.
        long id = rig.send(export, "data.browser.keep", Map.of(), null);
        assertThat(export.nextReply()).containsEntry("_id", id).containsEntry("code", "bad_request");
    }

    @Test
    void aKeepThatCantBeWrittenKeepsNothing() throws Exception {
        rig = new DataRig(dir);
        TestClient owner = rig.owner("cs-1");
        TestClient move = rig.export("cs-move");
        assertThat(rig.call(move, "data.browser.hold", Map.of())).containsEntry("held", true);
        // A rename can't replace a directory.
        Files.createDirectory(keptFile());
        Files.writeString(keptFile().resolve("x"), "x");
        Map<String, Object> reply = rig.call(move, "data.browser.keep", Map.of());
        assertThat(reply).containsEntry("code", "unavailable");
        assertThat(Json.object(reply, "details")).containsEntry("reason", "disk");
        assertThat(browserHealth()).doesNotContainKey("moved");
        close(move);
        await().until(() -> !browserHealth().containsKey("held"));
        assertThat(live(owner)).containsEntry("state", "live");
    }

    @Test
    void aKeptFileThatCantBeReadStillHolds() throws Exception {
        Files.writeString(keptFile(), "not json");
        rig = new DataRig(dir);
        assertThat(browserHealth()).containsEntry("held", true).containsKey("moved");
        TestClient owner = rig.owner("cs-1");
        assertThat(Json.object(live(owner), "details")).containsEntry("reason", "moved");
        assertThat(rig.call(owner, "data.browser.release", Map.of("kept", true))).containsEntry("held", false);
        assertThat(keptFile()).doesNotExist();
        assertThat(live(owner)).containsEntry("state", "live");
    }

    @Test
    void keptAgainItsTheSameKeepFromNow() throws Exception {
        rig = new DataRig(dir);
        moveKeeps(rig.export("cs-move"));
        // A second move, or a rerun of one, holds over the kept hold and keeps again.
        TestClient again = rig.export("cs-again");
        assertThat(rig.call(again, "data.browser.hold", Map.of())).containsEntry("held", true);
        Map<String, Object> kept = rig.call(again, "data.browser.keep", Map.of());
        assertThat(kept).containsEntry("kept", true);
        assertThat(Files.readString(keptFile())).contains((String) kept.get("since"));
        assertThat(rig.units.requests()).containsExactly(STOP_BROWSER);
    }
}
