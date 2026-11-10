package com.minimalistalliance.desk.deskd.testing;

import java.nio.file.Path;

/**
 * What a relay test asks of desk-notebook, whichever stands behind the socket: {@link FakeNotebookSocket}, or the real
 * service in {@code notebook/RealDeskNotebookIT}. {@code notebook/NotebookContractChecks} is written against this
 * alone, so the same checks run against both.
 */
public interface NotebookService extends AutoCloseable {

    /** Where it listens. */
    Path socket();

    /** Stops and starts it, as an update would: every connection breaks, and its data stays. Returns once it's back. */
    void restart() throws Exception;
}
