package com.minimalistalliance.desk.deskd.notebook;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** desk-notebook's storage state read from its health frame, for /health and the heartbeat (main 6216d1e8, audit D6). */
class NotebookStorageTest {

    @TempDir
    Path dir;

    private FakeNotebookSocket service;
    private NotebookRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (service != null) {
            service.close();
        }
    }

    private Path socket() {
        return dir.resolve("notebook.sock");
    }

    private static Map<String, Object> degraded(boolean refusing) {
        Map<String, Object> storage = new LinkedHashMap<>();
        storage.put("state", "degraded");
        storage.put("unsavedPages", 3);
        storage.put("unsavedBytes", 524288);
        storage.put("refusing", refusing);
        storage.put("degradedSeconds", 41);
        return storage;
    }

    @Test
    void healthShowsTheStorageStateAsCountsBesideTheLinksWord() throws Exception {
        service = new FakeNotebookSocket(socket());
        rig = new NotebookRig(dir, socket());
        // The first look finds nothing read yet, and starts a read; /health never waits on desk-notebook.
        Map<String, Object> health = rig.module.health();
        assertThat(health).containsEntry("notebook", "waiting");
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(5)).until(() -> rig.module.health().get("notebookStorage") != null);
        assertThat(rig.module.health().get("notebookStorage")).isEqualTo(Map.of(
                "state", "ok", "unsavedPages", 0L, "unsavedBytes", 0L, "refusing", false, "degradedSeconds", 0L));
    }

    @Test
    void healthNeverWaitsOnAStalledDeskNotebook() throws Exception {
        service = new FakeNotebookSocket(socket());
        rig = new NotebookRig(dir, socket());
        service.stallAll();
        long started = System.nanoTime();
        for (int i = 0; i < 5; i++) {
            assertThat(rig.module.health()).containsEntry("notebookStorage", null);
        }
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofMillis(500));
        service.resumeAll();
    }

    @Test
    void aDegradedStoreIsReadWithItsCountsAndNothingElseOfTheFrame() throws Exception {
        service = new FakeNotebookSocket(socket());
        Map<String, Object> said = degraded(true);
        // Whatever else a later build puts in the block stays behind: counts and the state only.
        said.put("pageIds", List.of("p-secret"));
        said.put("lastError", "SQLITE_FULL on page Title Of A Private Note");
        service.storage = said;
        NotebookStorage storage = new NotebookStorage(socket(), Duration.ZERO, Duration.ofSeconds(2));
        assertThat(storage.read()).isEqualTo(Map.of(
                "state", "degraded", "unsavedPages", 3L, "unsavedBytes", 524288L, "refusing", true, "degradedSeconds", 41L));

        service.storage = degraded(false);
        assertThat(storage.read()).containsEntry("refusing", false);
    }

    @Test
    void itAsksAtMostOnceInTheFreshWindow() throws Exception {
        service = new FakeNotebookSocket(socket());
        NotebookStorage storage = new NotebookStorage(socket(), Duration.ofHours(1), Duration.ofSeconds(2));
        storage.read();
        service.storage = degraded(false);
        assertThat(storage.read()).containsEntry("state", "ok");
        assertThat(service.healthAsks).hasValue(1);
        // The connection was its own, and is closed.
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(5)).until(() -> service.openConnections() == 0);
    }

    @Test
    void noDeskNotebookAStalledOneOrAnOlderBuildIsUnknown() throws Exception {
        NotebookStorage none = new NotebookStorage(socket(), Duration.ZERO, Duration.ofMillis(500));
        assertThat(none.read()).isNull();

        service = new FakeNotebookSocket(socket());
        service.stallAll();
        long started = System.nanoTime();
        assertThat(none.read()).isNull();
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(3));
        service.resumeAll();

        service.storage = null;
        assertThat(none.read()).isNull();
        service.storage = Map.of("state", "something-new");
        assertThat(none.read()).isNull();
    }
}
