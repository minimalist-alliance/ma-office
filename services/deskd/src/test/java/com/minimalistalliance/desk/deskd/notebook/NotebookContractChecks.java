package com.minimalistalliance.desk.deskd.notebook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.testing.NotebookService;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The contract as a client sees it through deskd, against whatever {@link #start} gives: {@code NotebookContractOnFakeTest}
 * runs these against the fake, and {@code RealDeskNotebookIT} against the real service. So a difference between them shows
 * up here, and the fake stays honest. Collab isn't here, as the real service needs Hocuspocus's own bytes.
 */
abstract class NotebookContractChecks {

    @TempDir
    Path dir;

    private NotebookService service;
    private NotebookRig rig;
    private TestClient client;

    /** Starts desk-notebook with an empty notebook. Its socket can be anywhere under {@code dir}. */
    abstract NotebookService start(Path dir) throws Exception;

    @BeforeEach
    void setUp() throws Exception {
        service = start(dir);
        rig = new NotebookRig(dir, service.socket());
        client = rig.connect("a");
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
        service.close();
    }

    private Map<String, Object> tree() throws Exception {
        return rig.call(client, "notebook.tree", Map.of());
    }

    @Test
    void anEmptyDeskHasAnEmptyTree() throws Exception {
        Map<String, Object> tree = tree();
        assertThat(tree).containsEntry("_kind", "RES").containsEntry("notebooks", List.of()).containsEntry("tabs", List.of())
                .containsEntry("pages", List.of()).containsEntry("next", null).containsKey("rev");
    }

    @Test
    void aNewNotebookIsInTheTreeAndTheSameKeyDoesntMakeTwo() throws Exception {
        String idem = UUID.randomUUID().toString();
        Map<String, Object> created = rig.call(client, "notebook.notebook.create", Map.of("title", "First"), idem);
        Map<String, Object> again = rig.call(client, "notebook.notebook.create", Map.of("title", "First"), idem);

        assertThat(created).containsEntry("_kind", "RES").containsKeys("notebook", "tab", "page");
        assertThat(again.get("notebook")).isEqualTo(created.get("notebook"));
        assertThat((List<?>) tree().get("notebooks")).hasSize(1);
    }

    @Test
    void theTopicsFirstEventIsTheRevAndAChangeBringsANewerOne() throws Exception {
        assertThat(client.subscribe("notebook.tree", null)).containsEntry("_kind", "RES");
        long rev = rev(rig.nextEvent(client));

        assertThat(rig.call(client, "notebook.notebook.create", Map.of("title", "Next"))).containsEntry("_kind", "RES");

        // The same one can come twice, as a client that subscribes while it's being heard sees both.
        long next = rev(rig.nextEvent(client));
        while (next == rev) {
            next = rev(rig.nextEvent(client));
        }
        assertThat(next).isGreaterThan(rev);
    }

    private static long rev(Map<String, Object> event) {
        assertThat(event).containsEntry("type", "snapshot");
        return ((Number) ((Map<?, ?>) event.get("data")).get("rev")).longValue();
    }

    @Test
    void aRowThatIsntThereIsNotFound() throws Exception {
        assertThat(rig.call(client, "notebook.page.trash", Map.of("pageId", "no-such-page"))).containsEntry("code", "not_found");
    }

    @Test
    void aRestartLeavesTheNotebooksAndTheSubscription() throws Exception {
        assertThat(rig.call(client, "notebook.notebook.create", Map.of("title", "Kept"))).containsEntry("_kind", "RES");
        client.subscribe("notebook.tree", null);
        rig.nextEvent(client);

        service.restart();

        // While it's away a call is unavailable. Once it's back, the tree is as it was, and the topic has spoken again.
        rig.nextEvent(client);
        await().atMost(Duration.ofSeconds(20)).until(() -> "RES".equals(tree().get("_kind")));
        assertThat((List<?>) tree().get("notebooks")).hasSize(1);
    }
}
