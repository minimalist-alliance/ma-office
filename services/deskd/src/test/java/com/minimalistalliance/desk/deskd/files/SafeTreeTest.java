package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SafeTreeTest {

    @TempDir
    Path dir;

    Path root;
    SafeTree tree;

    @BeforeEach
    void setUp() throws Exception {
        root = dir.resolve("files");
        tree = SafeTree.open(root, -1);
    }

    @AfterEach
    void tearDown() {
        tree.close();
    }

    private static String[] p(String path) {
        return path.isEmpty() ? new String[0] : path.split("/");
    }

    private void write(String rel, String text) throws IOException {
        Path f = root.resolve(rel);
        Files.createDirectories(f.getParent());
        Files.writeString(f, text);
    }

    private List<String> names(String path) throws Exception {
        return tree.list(p(path), null, 2000, true).entries().stream().map(SafeTree.Entry::name).toList();
    }

    @Test
    void theTreeIsMadeWithItsTwoDirectoriesAndMode0700() throws Exception {
        assertThat(Files.getPosixFilePermissions(root)).isEqualTo(PosixFilePermissions.fromString("rwx------"));
        assertThat(Files.isDirectory(root.resolve(".uploads"))).isTrue();
        assertThat(Files.isDirectory(root.resolve(".trash"))).isTrue();
        assertThat(names("")).isEmpty();
    }

    @Test
    void aTreeThatIsNotOwnerOnlyIsRefused() throws Exception {
        Path loose = dir.resolve("loose");
        Files.createDirectory(loose);
        Files.setPosixFilePermissions(loose, PosixFilePermissions.fromString("rwxr-x---"));
        assertThatThrownBy(() -> SafeTree.open(loose, -1)).isInstanceOf(SafeTree.Unusable.class).hasMessage("mode");
        Path mine = dir.resolve("mine");
        Files.createDirectory(mine);
        Files.setPosixFilePermissions(mine, PosixFilePermissions.fromString("rwx------"));
        assertThatThrownBy(() -> SafeTree.open(mine, 4_000_001)).isInstanceOf(SafeTree.Unusable.class).hasMessage("owner");
    }

    @Test
    void aRootThatIsASymlinkIsRefused() throws Exception {
        Path real = dir.resolve("real");
        Files.createDirectory(real, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        Path link = dir.resolve("link");
        Files.createSymbolicLink(link, real);
        assertThatThrownBy(() -> SafeTree.open(link, -1)).isInstanceOf(SafeTree.Unusable.class);
    }

    @Test
    void listingSortsFoldersFirstThenCaseFoldedNames() throws Exception {
        write("b.txt", "1");
        write("A.txt", "1");
        write("a2.txt", "1");
        write("Zed/x", "1");
        write("alpha/x", "1");
        assertThat(names("")).containsExactly("alpha", "Zed", "A.txt", "a2.txt", "b.txt");
    }

    @Test
    void cursorsPageWithoutRepeatingOrSkipping() throws Exception {
        for (int i = 0; i < 25; i++) {
            write(String.format("f%02d", i), "x");
        }
        SafeTree.Page first = tree.list(p(""), null, 10, true);
        assertThat(first.entries()).hasSize(10);
        assertThat(first.next()).isNotNull();
        // An entry added behind the cursor changes nothing ahead of it.
        write("a-new", "x");
        SafeTree.Page second = tree.list(p(""), SafeTree.parseCursor(first.next()), 10, true);
        assertThat(second.entries().get(0).name()).isEqualTo("f10");
        SafeTree.Page third = tree.list(p(""), SafeTree.parseCursor(second.next()), 10, true);
        assertThat(third.entries()).extracting(SafeTree.Entry::name).containsExactly("f20", "f21", "f22", "f23", "f24");
        assertThat(third.next()).isNull();
    }

    @Test
    void symlinksDevicesAndFifosAreNotThereAndAreCounted() throws Exception {
        write("real.txt", "x");
        Files.createSymbolicLink(root.resolve("link-to-file"), Path.of("real.txt"));
        Files.createSymbolicLink(root.resolve("link-to-dir"), dir);
        Files.createSymbolicLink(root.resolve("dangling"), Path.of("nowhere"));
        new ProcessBuilder("mkfifo", root.resolve("pipe").toString()).start().waitFor();
        SafeTree.Page page = tree.list(p(""), null, 2000, true);
        assertThat(page.entries()).extracting(SafeTree.Entry::name).containsExactly("real.txt");
        assertThat(page.skipped()).isEqualTo(4);
        assertThat(tree.stat(p("link-to-file"))).isNull();
        assertThat(tree.stat(p("pipe"))).isNull();
        assertThatThrownBy(() -> tree.openRead(p("link-to-file"))).isInstanceOf(SafeTree.TreeException.class);
    }

    @Test
    void aHardLinkIsSkipped() throws Exception {
        write("one", "x");
        Files.createLink(root.resolve("two"), root.resolve("one"));
        write("solo", "x");
        SafeTree.Page page = tree.list(p(""), null, 2000, true);
        assertThat(page.entries()).extracting(SafeTree.Entry::name).containsExactly("solo");
        assertThat(page.skipped()).isEqualTo(2);
        assertThat(tree.stat(p("one"))).isNull();
        assertThatThrownBy(() -> tree.openRead(p("two"))).isInstanceOf(SafeTree.TreeException.class);
    }

    @Test
    void aSymlinkedFolderIsNeverWalkedThrough() throws Exception {
        Path outside = dir.resolve("outside");
        Files.createDirectory(outside);
        Files.writeString(outside.resolve("secret"), "s");
        Files.createSymbolicLink(root.resolve("door"), outside);
        assertThatThrownBy(() -> tree.list(p("door"), null, 10, true)).isInstanceOf(SafeTree.TreeException.class);
        assertThat(tree.stat(p("door/secret"))).isNull();
        assertThatThrownBy(() -> tree.openRead(p("door/secret"))).isInstanceOf(SafeTree.TreeException.class);
        assertThatThrownBy(() -> tree.mkdir(p("door/new"))).isInstanceOf(SafeTree.TreeException.class);
        assertThat(Files.exists(outside.resolve("new"))).isFalse();
        assertThatThrownBy(() -> tree.move(p("door/secret"), p("taken"))).isInstanceOf(SafeTree.TreeException.class);
        assertThat(Files.exists(outside.resolve("secret"))).isTrue();
    }

    @Test
    void aFolderSwappedForASymlinkAfterTheCheckFailsInsteadOfEscaping() throws Exception {
        Path outside = dir.resolve("outside");
        Files.createDirectory(outside);
        Files.writeString(outside.resolve("secret"), "s");
        write("sub/inner.txt", "inner");
        // The walk has "checked" sub; now sub is swapped for a link to the outside.
        try (SafeTree.Dir held = tree.openDir(p("sub"))) {
            assertThat(held.stream).isNotNull();
            Files.delete(root.resolve("sub/inner.txt"));
            Files.delete(root.resolve("sub"));
            Files.createSymbolicLink(root.resolve("sub"), outside);
            // A fresh walk of the swapped path fails; the held handle still sees the original directory.
            assertThatThrownBy(() -> tree.openDir(p("sub"))).isInstanceOf(SafeTree.TreeException.class);
            assertThatThrownBy(() -> tree.openRead(p("sub/secret"))).isInstanceOf(SafeTree.TreeException.class);
            java.util.List<String> seen = new java.util.ArrayList<>();
            tree.eachChild(held, e -> seen.add(e.name()));
            assertThat(seen).isEmpty();
        }
    }

    @Test
    void namesThatAreNotNfcOrNotUtf8AreSkipped() throws Exception {
        write("fine.txt", "x");
        String decomposed = java.text.Normalizer.normalize("é", java.text.Normalizer.Form.NFD) + ".txt";
        try {
            write(decomposed, "x");
        } catch (java.nio.file.InvalidPathException e) {
            return; // A locale that can't name it.
        }
        assertThat(names("")).containsExactly("fine.txt");
        assertThat(tree.list(p(""), null, 10, true).skipped()).isEqualTo(1);
    }

    @Test
    void invalidUtf8NamesAreSkipped() throws Exception {
        write("fine.txt", "x");
        Process shell = new ProcessBuilder("sh", "-c", "printf x > \"$1/bad$(printf '\\377')name\"", "sh", root.toString())
                .redirectErrorStream(true).start();
        shell.waitFor();
        assertThat(names("")).containsExactly("fine.txt");
        assertThat(tree.list(p(""), null, 10, true).skipped()).isGreaterThanOrEqualTo(1);
    }

    @Test
    void reservedNamesAreHiddenAtTheRootForTheClientOnly() throws Exception {
        write("a", "x");
        assertThat(names("")).containsExactly("a");
        assertThat(tree.list(p(""), null, 10, false).entries()).extracting(SafeTree.Entry::name).contains(".uploads", ".trash", "a");
    }

    @Test
    void moveIsOneRenameAndReplacesAFile() throws Exception {
        write("a.txt", "first");
        write("dir/b.txt", "second");
        tree.move(p("a.txt"), p("dir/b.txt"));
        assertThat(Files.readString(root.resolve("dir/b.txt"))).isEqualTo("first");
        assertThat(Files.exists(root.resolve("a.txt"))).isFalse();
        assertThatThrownBy(() -> tree.move(p("missing"), p("x"))).isInstanceOf(SafeTree.TreeException.class);
    }

    @Test
    void mkdirsMakesTheWayAndRefusesAFile() throws Exception {
        assertThat(tree.mkdirs(p("a/b/c"))).isTrue();
        assertThat(tree.mkdirs(p("a/b/c"))).isFalse();
        write("file", "x");
        assertThatThrownBy(() -> tree.mkdirs(p("file/inside"))).isInstanceOf(SafeTree.TreeException.class)
                .extracting(e -> ((SafeTree.TreeException) e).kind()).isEqualTo(SafeTree.Kind.NOT_A_DIR);
        assertThat(Files.getPosixFilePermissions(root.resolve("a/b"))).isEqualTo(PosixFilePermissions.fromString("rwx------"));
    }

    @Test
    void deleteTreeRemovesFoldersAndLeavesLinkTargetsAlone() throws Exception {
        Path outside = dir.resolve("outside.txt");
        Files.writeString(outside, "keep");
        write("d/e/f.txt", "x");
        Files.createSymbolicLink(root.resolve("d/e/link"), outside);
        tree.deleteTree(p("d"));
        assertThat(Files.exists(root.resolve("d"))).isFalse();
        assertThat(Files.readString(outside)).isEqualTo("keep");
    }

    @Test
    void readsGoThroughOneHandle() throws Exception {
        write("a.txt", "hello");
        SafeTree.Opened opened = tree.openRead(p("a.txt"));
        try (var ch = opened.channel()) {
            tree.move(p("a.txt"), p("b.txt"));
            Files.writeString(root.resolve("a.txt"), "different");
            var buf = java.nio.ByteBuffer.allocate(16);
            ch.read(buf);
            assertThat(new String(buf.array(), 0, buf.position(), StandardCharsets.UTF_8)).isEqualTo("hello");
            assertThat(opened.size()).isEqualTo(5);
        }
    }

    @Test
    void aBigFolderIsPagedInOnePassWithRoomForOnePageOnly() throws Exception {
        Path big = root.resolve("big");
        Files.createDirectory(big);
        for (int i = 0; i < 3000; i++) {
            Files.createFile(big.resolve(String.format("n%05d", i)));
        }
        SafeTree.Entry after = null;
        int seen = 0;
        String last = "";
        while (true) {
            SafeTree.Page page = tree.list(p("big"), after, 700, true);
            for (SafeTree.Entry e : page.entries()) {
                assertThat(e.name()).isGreaterThan(last);
                last = e.name();
                seen++;
            }
            if (page.next() == null) {
                break;
            }
            after = SafeTree.parseCursor(page.next());
        }
        assertThat(seen).isEqualTo(3000);
    }

    @Test
    void deleteTreeTakesAFolderOfThousandsInBatches() throws Exception {
        Path big = root.resolve("many");
        Files.createDirectories(big.resolve("sub"));
        for (int i = 0; i < 1500; i++) {
            Files.createFile(big.resolve("f" + i));
            Files.createFile(big.resolve("sub").resolve("g" + i));
        }
        tree.deleteTree(p("many"));
        assertThat(Files.exists(big)).isFalse();
    }

    @Test
    void nonAsciiNamesWork() throws Exception {
        write("日本語/é-ü.txt", "x");
        assertThat(names("")).containsExactly("日本語");
        assertThat(names("日本語")).containsExactly("é-ü.txt");
        assertThat(tree.stat(p("日本語/é-ü.txt"))).isNotNull();
    }

    @Test
    void tallyAddsUpFilesAndStopsAtItsCap() throws Exception {
        write("a", "12345");
        write("d/b", "123");
        write(".trash/x/item", "99999");
        SafeTree.Tally t = tree.tally(p(""), 100, () -> false, true);
        assertThat(t.bytes()).isEqualTo(8);
        assertThat(t.entries()).isEqualTo(3);
        assertThat(t.capped()).isFalse();
        assertThat(tree.tally(p(""), 1, () -> false, true).capped()).isTrue();
    }
}
