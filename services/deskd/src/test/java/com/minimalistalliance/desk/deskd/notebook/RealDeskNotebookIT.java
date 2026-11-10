package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.testing.NotebookService;
import java.nio.file.Path;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * The relay against the real desk-notebook, on real Unix sockets: {@link NotebookContractChecks}, with no fake.
 * {@code verify} skips it unless {@code DESK_NOTEBOOK_CMD} is a shell command that runs the service in the foreground
 * ({@link RealNotebookService}):
 *
 * <pre>
 * DESK_NOTEBOOK_CMD='exec node services/notebook/dist/desk-notebook.mjs' ./mvnw -q -pl deskd verify \
 *     -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=RealDeskNotebookIT
 * </pre>
 *
 * {@link RealDeskNotebookCollabIT} carries real providers' bytes through the same relay.
 */
@EnabledIfEnvironmentVariable(named = RealNotebookService.CMD, matches = ".+")
class RealDeskNotebookIT extends NotebookContractChecks {

    @Override
    NotebookService start(Path dir) throws Exception {
        return new RealNotebookService(dir);
    }
}
