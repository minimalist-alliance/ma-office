package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FilesUnusableTreeTest {

    @TempDir
    Path dir;

    @Test
    void aTreeThatIsNotOwnerOnlyMakesEveryFilesCallUnavailableWithReasonTree() throws Exception {
        Path tree = dir.resolve("files");
        Files.createDirectory(tree);
        Files.setPosixFilePermissions(tree, PosixFilePermissions.fromString("rwxr-xr-x"));
        try (FilesRig rig = new FilesRig(dir)) {
            assertThat(rig.files.available()).isFalse();
            var owner = rig.owner("s-1");
            for (String m : new String[] {"files.list", "files.usage", "files.mkdir", "files.upload.begin", "files.read"}) {
                Map<String, Object> reply = rig.call(owner, m, "path", "a", "size", 1L);
                assertThat(reply).as(m).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
                assertThat((Map<String, Object>) reply.get("details")).containsEntry("reason", "tree");
            }
            // The export session still can't call them, and says why.
            var export = rig.export("s-2");
            assertThat(rig.call(export, "files.list", "path", "")).containsEntry("code", "forbidden");
        }
        // Nothing was changed in the directory.
        assertThat(Files.getPosixFilePermissions(tree)).isEqualTo(PosixFilePermissions.fromString("rwxr-xr-x"));
    }
}
