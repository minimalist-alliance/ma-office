package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.ControlPlaneRig;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** media.freeBytesSent on the heartbeat, from the control plane as it's wired, and the file beside rtc.sock. */
class FreeBytesHeartbeatTest {

    private static final String BEAT = "/v1/agent/heartbeat";

    @TempDir
    Path dir;

    private ControlPlaneRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new ControlPlaneRig(dir, ControlPlaneRig.FAST_LINK, new HeartbeatLoop.Timing(
                Duration.ofMillis(300), Duration.ofMillis(100), Duration.ofSeconds(5)));
        rig.platform.nextHeartbeatSeconds = null;
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private boolean aHeartbeatSaid(long freeBytes) {
        return rig.platform.apiRequests.stream()
                .filter(request -> BEAT.equals(request.path()))
                .map(request -> Json.object(request.json(), "media"))
                .anyMatch(media -> media != null && media.get("freeBytesSent") instanceof Number n && n.longValue() == freeBytes);
    }

    @Test
    void theHeartbeatsMediaCarriesFreeBytesBesideWhatWasThere() throws Exception {
        rig.bootToReady();
        Map<String, Object> first = Json.object(rig.platform.awaitApi(BEAT).json(), "media");
        assertThat(first).containsEntry("bytesSent", 1000).containsEntry("bytesReceived", 2000).containsEntry("peerBytesSent", 0)
                .containsEntry("peerBytesReceived", 0).containsEntry("freeBytesSent", 0);
        rig.data.freeBytes().add(16_384);
        rig.data.freeBytes().add(52);
        await().atMost(Duration.ofSeconds(10)).until(() -> aHeartbeatSaid(16_436));
    }

    @Test
    void theFileHasTheBootIdAndTheCountAndIsRewrittenAsItChanges() throws Exception {
        Path file = dir.resolve(DataModule.FREE_BYTES_FILE);
        assertThat(file).doesNotExist();
        rig.data.freeBytes().add(100);
        await().until(() -> Files.exists(file) && Files.readString(file).equals(rig.state.bootId() + " 100\n"));
        rig.data.freeBytes().add(23);
        // At most every 10 s while it changes, so the next one waits.
        Thread.sleep(300);
        assertThat(Files.readString(file)).isEqualTo(rig.state.bootId() + " 100\n");
        // On the way out it's written at once.
        rig.data.close();
        assertThat(Files.readString(file)).isEqualTo(rig.state.bootId() + " 123\n");
        assertThat(dir.resolve(".free-bytes.tmp")).doesNotExist();
    }

    @Test
    void aFileThatCantBeWrittenIsOneLogLineAndTheCountGoesOn() throws Exception {
        Path file = dir.resolve(DataModule.FREE_BYTES_FILE);
        Files.createDirectory(file);
        rig.data.freeBytes().add(5);
        rig.data.close();
        assertThat(rig.data.freeBytesSent()).isEqualTo(5);
        assertThat(file).isDirectory();
    }
}
