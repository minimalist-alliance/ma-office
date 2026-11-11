package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The idle file's {@code exports}: an export session's transfers and holds, told as they change, and nothing else. */
class ExportsGoingTest {

    @TempDir
    Path dir;

    private DataRig rig;

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    @Test
    void anExportSessionsReadAndHoldCountWhileTheyLastAndAnOwnersReadDoesNot() throws Exception {
        rig = new DataRig(dir);
        AtomicInteger told = new AtomicInteger();
        rig.data.onExportsChange(told::incrementAndGet);
        rig.helper.part("files", "Files");
        rig.helper.file("files", "a.bin", new byte[3 * 1024 * 1024]);
        assertThat(rig.data.exportsGoing()).isZero();

        TestClient owner = rig.owner("cs-1");
        assertThat(rig.call(owner, "data.read", Map.of("part", "files", "path", "a.bin", "offset", 0))).containsEntry("_kind", "RES");
        // An owner's transfer is the member's own, and its session counts as a session in the idle file already.
        assertThat(rig.data.exportsGoing()).isZero();
        assertThat(told.get()).isZero();

        TestClient export = rig.export("cs-2");
        assertThat(rig.call(export, "data.read", Map.of("part", "files", "path", "a.bin", "offset", 0))).containsEntry("_kind", "RES");
        assertThat(rig.data.exportsGoing()).isEqualTo(1);
        assertThat(told.get()).isEqualTo(1);
        assertThat(rig.call(export, "data.browser.hold", Map.of())).containsEntry("held", true);
        assertThat(rig.data.exportsGoing()).isEqualTo(2);

        assertThat(rig.call(export, "data.browser.release", Map.of())).containsEntry("_kind", "RES");
        assertThat(rig.data.exportsGoing()).isEqualTo(1);
        export.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000, "reason", "done"));
        await().untilAsserted(() -> assertThat(rig.data.exportsGoing()).isZero());
        // The count drops under Transfers' lock and the listener is told just after it, so the count reaching zero doesn't
        // mean the last telling has happened: wait for it, bounded, rather than assume the order.
        await().untilAsserted(() -> assertThat(told.get()).isGreaterThanOrEqualTo(4));
    }

    @Test
    void aHoldAMoveKeptPastItsSessionIsNotAnExportGoing() throws Exception {
        rig = new DataRig(dir);
        TestClient move = rig.export("cs-1");
        assertThat(rig.call(move, "data.browser.hold", Map.of())).containsEntry("held", true);
        assertThat(rig.call(move, "data.browser.keep", Map.of())).containsEntry("kept", true);
        assertThat(rig.call(move, "data.browser.release", Map.of())).containsEntry("held", true);
        move.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000, "reason", "done"));
        // Still held, until its owner lets go, and that would stop every update for good if it counted.
        await().untilAsserted(() -> assertThat(rig.data.exportsGoing()).isZero());
        assertThat(rig.data.hold().held()).isTrue();
    }
}
