package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket;
import com.minimalistalliance.desk.deskd.testing.NotebookService;
import java.nio.file.Path;

class NotebookContractOnFakeTest extends NotebookContractChecks {

    @Override
    NotebookService start(Path dir) throws Exception {
        FakeNotebookSocket fake = new FakeNotebookSocket(dir.resolve("notebook.sock"));
        fake.likeTheService();
        return fake;
    }
}
