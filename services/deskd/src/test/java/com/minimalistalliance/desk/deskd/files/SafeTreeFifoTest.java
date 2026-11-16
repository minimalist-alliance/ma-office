package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

/**
 * A FIFO where a folder is expected (found by the Agent's path fuzz, {@code tools/FilesPathFuzzTest}): opening one as a
 * directory used to call {@code openat} with {@code O_RDONLY}, which blocks until a writer comes, holding the caller's
 * carrier thread for good, for the member's {@code files.list} as for the Agent's {@code files_list}. Now only a directory
 * is opened as one, and everything else is not there, at once.
 */
class SafeTreeFifoTest {

    @TempDir
    Path dir;

    private SafeTree tree;
    private Path root;

    @BeforeEach
    void setUp() throws Exception {
        root = dir.resolve("files");
        tree = SafeTree.open(root, -1);
        Files.createDirectories(root.resolve("docs"));
        Process p = new ProcessBuilder("mkfifo", root.resolve("pipe").toString(), root.resolve("docs/pipe").toString())
                .inheritIO().start();
        assertThat(p.waitFor()).isZero();
        Files.writeString(root.resolve("docs/a.txt"), "a");
    }

    @AfterEach
    void tearDown() {
        tree.close();
    }

    @Test
    @Timeout(value = 10, unit = TimeUnit.SECONDS)
    void aFifoIsNeverOpenedAsAFolderOrAFileAndAnswersAtOnce() throws Exception {
        for (String[] path : new String[][] {{"pipe"}, {"pipe", "x"}, {"docs", "pipe"}, {"docs", "pipe", "y", "z"}}) {
            assertThatThrownBy(() -> tree.list(path, null, 10, true)).isInstanceOf(SafeTree.TreeException.class);
            assertThatThrownBy(() -> tree.openRead(path)).isInstanceOf(SafeTree.TreeException.class);
            assertThatThrownBy(() -> tree.openDir(path)).isInstanceOf(SafeTree.TreeException.class);
            assertThat(tree.stat(path)).isNull();
            assertThat(tree.tally(path, 100, () -> false, false).entries()).isZero();
        }
        // A file in the middle of a path is still not a folder, and a real folder still opens.
        assertThatThrownBy(() -> tree.openDir(new String[] {"docs", "a.txt"}))
                .isInstanceOfSatisfying(SafeTree.TreeException.class, e -> assertThat(e.kind()).isEqualTo(
                        SafeTree.Kind.NOT_A_DIR));
        try (SafeTree.Dir docs = tree.openDir(new String[] {"docs"})) {
            assertThat(docs.real.getFileName().toString()).isEqualTo("docs");
        }
        assertThat(tree.list(new String[] {"docs"}, null, 10, true).entries()).extracting(SafeTree.Entry::name)
                .containsExactly("a.txt");
    }
}
