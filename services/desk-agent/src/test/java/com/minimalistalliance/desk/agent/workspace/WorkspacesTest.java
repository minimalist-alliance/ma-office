package com.minimalistalliance.desk.agent.workspace;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.workspace.WorkspaceException.Reason;
import com.minimalistalliance.desk.agent.workspace.Workspaces.Entry;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WorkspacesTest {

    private static final long QUOTA = 100_000_000;
    private static final long U = Workspaces.UNIT;

    @TempDir Path tmp;
    Path root;
    Path outside;
    AtomicLong free;
    Workspaces ws;

    @BeforeEach
    void setUp() throws Exception {
        root = tmp.resolve("workspaces");
        outside = tmp.resolve("outside");
        Files.createDirectories(outside);
        free = new AtomicLong(Long.MAX_VALUE);
        ws = new Workspaces(root, 1000, free::get);
        ws.create("a1");
        ws.create("b2");
    }

    private static void refused(Reason reason, ThrowingRunnable r) {
        assertThatThrownBy(r::run)
                .isInstanceOfSatisfying(WorkspaceException.class, e -> assertThat(e.reason()).isEqualTo(reason));
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    private String read(String agent, String path) throws Exception {
        return ws.read(agent, path, 1 << 20).text();
    }

    // ------------------------------------------------------------ basics

    @Test
    void writeReadListRemove() throws Exception {
        // A file counts at least 4 KiB, and so does a folder.
        assertThat(ws.write("a1", "notes/day1.md", "hello", false, QUOTA)).isEqualTo(U + U);
        assertThat(ws.write("a1", "top.txt", "héllo", false, QUOTA)).isEqualTo(3 * U);
        assertThat(ws.read("a1", "notes/day1.md", 100)).isEqualTo(new Workspaces.Read("notes/day1.md", "hello", 5, false));
        assertThat(ws.read("a1", "top.txt", 100).bytes()).isEqualTo(6);

        List<Entry> top = ws.list("a1", "");
        assertThat(top).extracting(Entry::path).containsExactly("notes", "top.txt");
        assertThat(top).extracting(Entry::dir).containsExactly(true, false);
        assertThat(top.get(1).bytes()).isEqualTo(6);
        assertThat(top.get(1).modifiedAt()).isNotNull();
        assertThat(ws.list("a1", "notes")).extracting(Entry::path).containsExactly("notes/day1.md");

        assertThat(ws.remove("a1", "top.txt")).isEqualTo(2 * U);
        assertThat(ws.remove("a1", "notes")).isEqualTo(0);
        assertThat(ws.list("a1", "")).isEmpty();
        refused(Reason.NOT_FOUND, () -> ws.read("a1", "top.txt", 10));
        refused(Reason.NOT_FOUND, () -> ws.remove("a1", "top.txt"));
        refused(Reason.NOT_FOUND, () -> ws.list("a1", "nope"));
        refused(Reason.NOT_FOUND, () -> ws.read("a1", "nope/x", 10));
    }

    @Test
    void readTruncatesAtACharacterBoundary() throws Exception {
        ws.write("a1", "f", "aé€😀z", false, QUOTA); // 1 + 2 + 3 + 4 + 1 bytes
        assertThat(ws.read("a1", "f", 11)).isEqualTo(new Workspaces.Read("f", "aé€😀z", 11, false));
        Workspaces.Read r = ws.read("a1", "f", 10);
        assertThat(r.text()).isEqualTo("aé€😀");
        assertThat(r.truncated()).isTrue();
        assertThat(r.bytes()).isEqualTo(11);
        assertThat(ws.read("a1", "f", 8).text()).isEqualTo("aé€"); // cuts the emoji
        assertThat(ws.read("a1", "f", 0).text()).isEmpty();
    }

    @Test
    void listIsSortedAndCappedAt500() throws Exception {
        for (int i = 700; i > 0; i--) {
            ws.write("a1", "d/f" + String.format("%04d", i), "x", false, QUOTA);
        }
        List<Entry> l = ws.list("a1", "d");
        assertThat(ws.listing("a1", "d").more()).isTrue();
        assertThat(ws.listing("a1", "").more()).isFalse();
        assertThat(l).hasSize(500);
        assertThat(l.get(0).path()).isEqualTo("d/f0001");
        assertThat(l.get(499).path()).isEqualTo("d/f0500");
    }

    @Test
    void agentIdsAreChecked() throws Exception {
        for (String bad : new String[]{"", "a/b", "..", ".", "a b", "a\0", "a".repeat(65), "é", null}) {
            refused(Reason.PATH, () -> ws.create(bad));
            refused(Reason.PATH, () -> ws.write(bad, "x", "y", false, QUOTA));
            refused(Reason.PATH, () -> ws.read(bad, "x", 5));
            refused(Reason.PATH, () -> ws.deleteAll(bad));
        }
        ws.deleteAll("a".repeat(64)); // fine, and nothing there
        refused(Reason.NOT_FOUND, () -> ws.write("ghost", "x", "y", false, QUOTA));
    }

    // ------------------------------------------------------------ paths

    @Test
    void badPathsAreRefusedEverywhere() throws Exception {
        ws.write("a1", "a/b", "x", false, QUOTA);
        Files.writeString(outside.resolve("x"), "secret");
        Files.writeString(root.resolve("b2").resolve("theirs"), "theirs");
        String[] bad = {
            "../x", "a/../../x", "/etc/passwd", "/x", "a//b", ".", "..", "a/./b", "a/..", "a/", "a/b/", "",
            "a\0b", "a\\b", "a\nb", "a\tb", "a\u007fb", "\u0001",
            "../outside/x", "../b2/theirs", "a/../../b2/theirs",
            "1/2/3/4/5/6/7/8/9/10/11/12/13/14/15/16/17",
            "x".repeat(256), "é".repeat(128), // 256 bytes
            "y".repeat(255) + "/" + "y".repeat(255) + "/" + "y".repeat(255) + "/" + "y".repeat(255) + "/z", // > 1024
            "lone\ud800surrogate"
        };
        for (String p : bad) {
            refused(Reason.PATH, () -> ws.read("a1", p, 10));
            refused(Reason.PATH, () -> ws.write("a1", p, "y", false, QUOTA));
            refused(Reason.PATH, () -> ws.write("a1", p, "y", true, QUOTA));
            refused(Reason.PATH, () -> ws.remove("a1", p));
            if (!p.isEmpty()) {
                refused(Reason.PATH, () -> ws.list("a1", p));
            }
        }
        assertThat(Files.readString(outside.resolve("x"))).isEqualTo("secret");
        assertThat(Files.readString(root.resolve("b2").resolve("theirs"))).isEqualTo("theirs");
        assertThat(ws.list("a1", "")).extracting(Entry::path).containsExactly("a");
        assertThat(ws.list("b2", "")).extracting(Entry::path).containsExactly("theirs");
    }

    @Test
    void limitsOfAGoodPath() throws Exception {
        String sixteen = String.join("/", java.util.Collections.nCopies(16, "d"));
        ws.write("a1", sixteen, "x", false, QUOTA); // 16 components, the last a file
        assertThat(read("a1", sixteen)).isEqualTo("x");
        String longName = "n".repeat(255);
        ws.write("a1", longName, "x", false, QUOTA);
        ws.write("a1", "é".repeat(127), "x", false, QUOTA); // 254 bytes
        String near = "m".repeat(255) + "/" + "m".repeat(255) + "/" + "m".repeat(255) + "/" + "m".repeat(252);
        assertThat(near.length()).isEqualTo(1020);
        ws.write("a1", near, "x", false, QUOTA);
        refused(Reason.PATH, () -> ws.write("a1", near + "xxxxx", "x", false, QUOTA));
        // Dots and dashes inside names are fine.
        ws.write("a1", "..hidden/.x/a..b", "x", false, QUOTA);
        ws.write("a1", "sp ace/ünï.txt", "x", false, QUOTA);
    }

    @Test
    void oneAgentCannotReachAnother() throws Exception {
        ws.write("b2", "secret.txt", "theirs", false, QUOTA);
        refused(Reason.PATH, () -> ws.read("a1", "../b2/secret.txt", 10));
        refused(Reason.NOT_FOUND, () -> ws.read("a1", "secret.txt", 10));
        refused(Reason.PATH, () -> ws.remove("a1", "../b2/secret.txt"));
        assertThat(read("b2", "secret.txt")).isEqualTo("theirs");
        // An id can't be a path into another folder.
        refused(Reason.PATH, () -> ws.read("../b2", "secret.txt", 10));
        refused(Reason.PATH, () -> ws.read("a1/../b2", "secret.txt", 10));
    }

    // ------------------------------------------------------------ links

    private Path outsideFile() throws IOException {
        Path f = outside.resolve("target.txt");
        Files.writeString(f, "outside");
        return f;
    }

    private void outsideUnchanged() throws IOException {
        assertThat(Files.readString(outside.resolve("target.txt"))).isEqualTo("outside");
        assertThat(Files.exists(outside.resolve("target.txt"), java.nio.file.LinkOption.NOFOLLOW_LINKS)).isTrue();
        try (var s = Files.list(outside)) {
            assertThat(s.map(p -> p.getFileName().toString()).toList()).containsExactly("target.txt");
        }
    }

    @Test
    void aLinkedFolderIsNeverFollowed() throws Exception {
        outsideFile();
        Path a1 = root.resolve("a1");
        Files.createSymbolicLink(a1.resolve("lnk"), outside);
        Files.createDirectories(a1.resolve("real"));
        Files.createSymbolicLink(a1.resolve("real").resolve("deep"), outside);

        for (String dir : new String[]{"lnk", "real/deep"}) {
            refused(Reason.PATH, () -> ws.read("a1", dir + "/target.txt", 100));
            refused(Reason.PATH, () -> ws.write("a1", dir + "/target.txt", "pwned", false, QUOTA));
            refused(Reason.PATH, () -> ws.write("a1", dir + "/target.txt", "pwned", true, QUOTA));
            refused(Reason.PATH, () -> ws.write("a1", dir + "/new/file.txt", "pwned", false, QUOTA));
            refused(Reason.PATH, () -> ws.list("a1", dir));
            refused(Reason.PATH, () -> ws.remove("a1", dir + "/target.txt"));
            refused(Reason.PATH, () -> ws.list("a1", dir + "/sub"));
        }
        outsideUnchanged();
        assertThat(ws.list("a1", "")).extracting(Entry::path).containsExactly("real"); // links aren't shown
    }

    @Test
    void aLinkedFileIsNeverFollowed() throws Exception {
        Path target = outsideFile();
        Path a1 = root.resolve("a1");
        Files.createSymbolicLink(a1.resolve("lnk.txt"), target);
        refused(Reason.PATH, () -> ws.read("a1", "lnk.txt", 100));
        // A relative link too, and one to a file inside the workspace.
        Files.writeString(a1.resolve("real.txt"), "inside");
        Files.createSymbolicLink(a1.resolve("rel.txt"), Path.of("real.txt"));
        refused(Reason.PATH, () -> ws.read("a1", "rel.txt", 100));
        // A dangling link.
        Files.createSymbolicLink(a1.resolve("dangling"), outside.resolve("nope"));
        refused(Reason.PATH, () -> ws.read("a1", "dangling", 100));
        outsideUnchanged();
    }

    @Test
    void aLinkAtTheFinalNameIsReplacedOnWriteAndItsTargetKept() throws Exception {
        Path target = outsideFile();
        Path a1 = root.resolve("a1");
        Path lnk = a1.resolve("lnk.txt");
        Files.createSymbolicLink(lnk, target);
        assertThat(ws.write("a1", "lnk.txt", "mine", false, QUOTA)).isEqualTo(U);
        assertThat(Files.isSymbolicLink(lnk)).isFalse();
        assertThat(read("a1", "lnk.txt")).isEqualTo("mine");
        outsideUnchanged();

        Path lnk2 = a1.resolve("lnk2.txt");
        Files.createSymbolicLink(lnk2, target);
        assertThat(ws.write("a1", "lnk2.txt", "app", true, QUOTA)).isEqualTo(2 * U);
        assertThat(Files.isSymbolicLink(lnk2)).isFalse();
        assertThat(read("a1", "lnk2.txt")).isEqualTo("app");
        outsideUnchanged();

        // A link to a folder at the final name is replaced the same way.
        Path lnk3 = a1.resolve("dirlink");
        Files.createSymbolicLink(lnk3, outside);
        ws.write("a1", "dirlink", "file now", false, QUOTA);
        assertThat(Files.isRegularFile(lnk3, java.nio.file.LinkOption.NOFOLLOW_LINKS)).isTrue();
        outsideUnchanged();
    }

    @Test
    void removeDeletesALinkItselfNotItsTarget() throws Exception {
        Path target = outsideFile();
        Path a1 = root.resolve("a1");
        Files.createSymbolicLink(a1.resolve("lnk.txt"), target);
        Files.createDirectories(a1.resolve("dir"));
        Files.createSymbolicLink(a1.resolve("dir").resolve("l"), outside);
        ws.write("a1", "dir/real.txt", "12345", false, QUOTA);
        ws.remove("a1", "lnk.txt");
        assertThat(Files.exists(a1.resolve("lnk.txt"), java.nio.file.LinkOption.NOFOLLOW_LINKS)).isFalse();
        assertThat(ws.remove("a1", "dir")).isEqualTo(0);
        assertThat(Files.exists(a1.resolve("dir"))).isFalse();
        outsideUnchanged();
    }

    @Test
    void anAgentFolderSwappedForALinkIsRefused() throws Exception {
        outsideFile();
        ws.write("b2", "x.txt", "keep", false, QUOTA);
        // Swap a1's folder for a link to the other agent's folder, and to outside.
        for (Path to : new Path[]{outside, root.resolve("b2")}) {
            Path a1 = root.resolve("a1");
            deleteRecursively(a1);
            Files.createSymbolicLink(a1, to);
            refused(Reason.PATH, () -> ws.read("a1", "target.txt", 10));
            refused(Reason.PATH, () -> ws.read("a1", "x.txt", 10));
            refused(Reason.PATH, () -> ws.write("a1", "new.txt", "pwned", false, QUOTA));
            refused(Reason.PATH, () -> ws.write("a1", "x.txt", "pwned", true, QUOTA));
            refused(Reason.PATH, () -> ws.list("a1", ""));
            refused(Reason.PATH, () -> ws.remove("a1", "x.txt"));
            refused(Reason.PATH, () -> ws.used("a1"));
            refused(Reason.PATH, () -> ws.create("a1"));
        }
        assertThat(read("b2", "x.txt")).isEqualTo("keep");
        assertThat(Files.exists(outside.resolve("new.txt"))).isFalse();
        // deleteAll removes the link only.
        ws.deleteAll("a1");
        assertThat(Files.exists(root.resolve("a1"), java.nio.file.LinkOption.NOFOLLOW_LINKS)).isFalse();
        assertThat(read("b2", "x.txt")).isEqualTo("keep");
        outsideUnchanged();
    }

    @Test
    void deleteAllWithLinksInsideLeavesTheTargets() throws Exception {
        outsideFile();
        Path keep = outside.resolve("folder");
        Files.createDirectories(keep);
        Files.writeString(keep.resolve("k.txt"), "k");
        Path a1 = root.resolve("a1");
        ws.write("a1", "d/e/f.txt", "text", false, QUOTA);
        Files.createSymbolicLink(a1.resolve("d").resolve("dirlink"), keep);
        Files.createSymbolicLink(a1.resolve("filelink"), outside.resolve("target.txt"));
        Files.createSymbolicLink(a1.resolve("d").resolve("e").resolve("up"), root.resolve("b2"));
        ws.write("b2", "theirs.txt", "theirs", false, QUOTA);

        ws.deleteAll("a1");
        assertThat(Files.exists(a1, java.nio.file.LinkOption.NOFOLLOW_LINKS)).isFalse();
        assertThat(Files.readString(keep.resolve("k.txt"))).isEqualTo("k");
        assertThat(Files.readString(outside.resolve("target.txt"))).isEqualTo("outside");
        assertThat(read("b2", "theirs.txt")).isEqualTo("theirs");
        ws.deleteAll("a1"); // again: nothing there
        // It can be made again, empty.
        ws.create("a1");
        assertThat(ws.list("a1", "")).isEmpty();
        assertThat(ws.used("a1")).isZero();
    }

    private static void deleteRecursively(Path p) throws IOException {
        Files.walkFileTree(p, new java.nio.file.SimpleFileVisitor<>() {
            @Override
            public java.nio.file.FileVisitResult visitFile(Path f, java.nio.file.attribute.BasicFileAttributes a)
                    throws IOException {
                Files.delete(f);
                return java.nio.file.FileVisitResult.CONTINUE;
            }

            @Override
            public java.nio.file.FileVisitResult postVisitDirectory(Path d, IOException e) throws IOException {
                Files.delete(d);
                return java.nio.file.FileVisitResult.CONTINUE;
            }
        });
    }

    // ------------------------------------------------------------ quotas

    @Test
    void quotaOnCreateOverwriteAndAppend() throws Exception {
        long q = 3 * U;
        assertThat(ws.write("a1", "f", "1234567890", false, q)).isEqualTo(U); // a small file counts 4 KiB
        assertThat(ws.write("a1", "g", "x".repeat((int) (2 * U)), false, q)).isEqualTo(3 * U); // exactly at the quota
        refused(Reason.QUOTA, () -> ws.write("a1", "h", "x", false, q));
        assertThat(ws.write("a1", "f", "1", true, q)).isEqualTo(3 * U); // inside its 4 KiB: no growth
        refused(Reason.QUOTA, () -> ws.write("a1", "f", "x".repeat((int) U + 1), false, q)); // grows by a unit
        refused(Reason.QUOTA, () -> ws.write("a1", "d/e", "", false, q)); // a file and a folder
        assertThat(read("a1", "f")).isEqualTo("12345678901");
        assertThat(ws.used("a1")).isEqualTo(3 * U);
        refused(Reason.NOT_FOUND, () -> ws.read("a1", "h", 5)); // the refused write left nothing
        // A smaller quota than the use still lets a write shrink it, not grow it.
        assertThat(ws.write("a1", "g", "1", false, U)).isEqualTo(2 * U);
        refused(Reason.QUOTA, () -> ws.write("a1", "g", "x".repeat((int) (2 * U)), false, U));
        // Another agent's quota is its own.
        assertThat(ws.write("b2", "f", "1234567890", false, q)).isEqualTo(U);
    }

    @Test
    void emptyFilesAndFoldersCountToo() throws Exception {
        ws.write("a1", "a/b/c/d/e/f", "", false, QUOTA);
        assertThat(ws.used("a1")).isEqualTo(6 * U); // five folders and a file
        assertThat(new Workspaces(root, 0, free::get).used("a1")).isEqualTo(6 * U); // a scan agrees
        assertThat(ws.remove("a1", "a/b")).isEqualTo(U); // a is left
        refused(Reason.QUOTA, () -> ws.write("a1", "q/w/e/r", "", false, 3 * U)); // three folders and a file: 4 units
    }

    @Test
    void twoThousandFolders() throws Exception {
        for (int i = 0; i < Workspaces.MAX_FOLDERS; i++) {
            Files.createDirectory(root.resolve("a1").resolve("d" + i));
        }
        assertThat(ws.used("a1")).isEqualTo(Workspaces.MAX_FOLDERS * U);
        refused(Reason.TOO_MANY_FOLDERS, () -> ws.write("a1", "new/f", "x", false, QUOTA));
        ws.write("a1", "d5/f", "x", false, QUOTA); // inside an existing one is fine
        ws.remove("a1", "d6");
        ws.write("a1", "new/f", "x", false, QUOTA);
        refused(Reason.TOO_MANY_FOLDERS, () -> ws.write("a1", "other/f", "x", false, QUOTA));
    }

    @Test
    void aFileWithSeveralHardLinksIsRefused() throws Exception {
        Path target = outsideFile();
        Files.createLink(root.resolve("a1").resolve("hard.txt"), target);
        refused(Reason.PATH, () -> ws.read("a1", "hard.txt", 100));
        refused(Reason.PATH, () -> ws.page("a1", "hard.txt", 0, 100));
        refused(Reason.PATH, () -> ws.write("a1", "hard.txt", "pwned", false, QUOTA));
        refused(Reason.PATH, () -> ws.write("a1", "hard.txt", "pwned", true, QUOTA));
        assertThat(ws.list("a1", "")).isEmpty();
        outsideUnchanged();
        ws.remove("a1", "hard.txt"); // the member may still delete the name
        assertThat(Files.exists(target)).isTrue();
        ws.write("a1", "ok.txt", "fine", false, QUOTA);
        assertThat(read("a1", "ok.txt")).isEqualTo("fine");
    }

    @Test
    void pathsWithHiddenCharactersAreRefused() {
        for (String bad : List.of("a\u202eb", "x\u200bfile", "\u2066y", "ab\u00adc", "\ufeffbom")) {
            refused(Reason.PATH, () -> ws.write("a1", bad, "x", false, QUOTA));
            refused(Reason.PATH, () -> ws.write("a1", "d/" + bad, "x", false, QUOTA));
            refused(Reason.PATH, () -> ws.read("a1", bad, 10));
        }
    }

    @Test
    void pagesCountCharactersAndSayWhatRemains() throws Exception {
        ws.write("a1", "f", "a€😀b".repeat(3), false, QUOTA); // 3 x (1 + 1 + 2 + 1) = 15 chars
        Workspaces.Page p = ws.page("a1", "f", 0, 6);
        assertThat(p.text()).isEqualTo("a€😀b".repeat(1) + "a");
        assertThat(p.offset()).isZero();
        assertThat(p.remaining()).isEqualTo(15 - 6);
        assertThat(p.truncated()).isTrue();
        // A page never ends inside an emoji.
        Workspaces.Page q = ws.page("a1", "f", 6, 2); // chars 6..7 would end on the emoji's first half
        assertThat(q.text()).isEqualTo("€");
        assertThat(q.remaining()).isEqualTo(15 - 7);
        Workspaces.Page last = ws.page("a1", "f", 7, 1000);
        assertThat(last.text()).isEqualTo("😀ba€😀b");
        assertThat(last.remaining()).isZero();
        assertThat(last.truncated()).isFalse();
        assertThat(ws.page("a1", "f", 100, 10).text()).isEmpty();
        assertThat(ws.page("a1", "f", 0, 1 << 30).remaining()).isZero();
        // At most 128 Ki characters a page.
        ws.write("a1", "big", "x".repeat(1000), true, QUOTA);
        for (int i = 0; i < 9; i++) {
            ws.write("a1", "big", "y".repeat(1024 * 1024), true, QUOTA);
        }
        Workspaces.Page big = ws.page("a1", "big", 0, 1 << 30);
        assertThat(big.text()).hasSize(Workspaces.MAX_PAGE_CHARS);
        assertThat(big.remaining()).isEqualTo(1000 + 9L * 1024 * 1024 - Workspaces.MAX_PAGE_CHARS);
        refused(Reason.NOT_FOUND, () -> ws.page("a1", "nope", 0, 10));
    }

    @Test
    void theVolumeIsInjectable() {
        Workspaces w = new Workspaces(root, 0, () -> 700, () -> 1000);
        assertThat(w.volumeBytes()).isEqualTo(1000);
        assertThat(w.volumeFreeBytes()).isEqualTo(700);
        assertThat(new Workspaces(tmp.resolve("not/made/yet"), 0).volumeBytes()).isPositive(); // nearest folder
    }

    @Test
    void aRefusedWriteLeavesNoFoldersBehind() throws Exception {
        refused(Reason.QUOTA, () -> ws.write("a1", "x/y/z/f", "toolong", false, 3));
        assertThat(ws.list("a1", "")).isEmpty();
        refused(Reason.TOO_LARGE, () -> ws.write("a1", "x/y/z/f", "a".repeat(1024 * 1024 + 1), false, QUOTA));
        assertThat(ws.list("a1", "")).isEmpty();
    }

    @Test
    void usageFollowsWritesAndRemovesAndSurvivesARestart() throws Exception {
        assertThat(ws.used("a1")).isZero();
        ws.write("a1", "a/one", "12345", false, QUOTA);
        ws.write("a1", "a/b/two", "123", false, QUOTA);
        ws.write("a1", "three", "12", false, QUOTA);
        assertThat(ws.used("a1")).isEqualTo(5 * U); // three files, folders a and a/b
        ws.write("a1", "three", "1", false, QUOTA);
        ws.write("a1", "three", "22", true, QUOTA);
        ws.write("a1", "four", "x".repeat((int) U + 1), false, QUOTA);
        assertThat(ws.used("a1")).isEqualTo(5 * U + U + 1);
        assertThat(ws.remove("a1", "a/b")).isEqualTo(4 * U + 1); // a folder and a file
        assertThat(ws.remove("a1", "a/one")).isEqualTo(3 * U + 1);
        // A fresh instance counts the same from the disk (links and the target are not counted).
        Files.createSymbolicLink(root.resolve("a1").resolve("lnk"), outside);
        Files.writeString(outside.resolve("big"), "x".repeat(5000));
        Workspaces again = new Workspaces(root, 0, free::get);
        assertThat(again.used("a1")).isEqualTo(3 * U + 1);
        assertThat(again.used("b2")).isZero();
        again.deleteAll("a1");
        refused(Reason.NOT_FOUND, () -> again.used("a1"));
    }

    @Test
    void tenThousandFiles() throws Exception {
        for (int i = 0; i < Workspaces.MAX_FILES; i++) {
            Files.createFile(root.resolve("a1").resolve("f" + i)); // placed directly, to stay quick
        }
        assertThat(ws.used("a1")).isEqualTo(Workspaces.MAX_FILES * U); // the scan counts them
        refused(Reason.TOO_MANY_FILES, () -> ws.write("a1", "one-more", "x", false, QUOTA));
        refused(Reason.TOO_MANY_FILES, () -> ws.write("a1", "d/one-more", "", false, QUOTA));
        // Overwriting or appending an existing file is not a new file.
        ws.write("a1", "f5", "abc", false, QUOTA);
        ws.write("a1", "f5", "def", true, QUOTA);
        assertThat(read("a1", "f5")).isEqualTo("abcdef");
        // Removing one makes room for exactly one.
        ws.remove("a1", "f6");
        ws.write("a1", "new", "x", false, QUOTA);
        refused(Reason.TOO_MANY_FILES, () -> ws.write("a1", "new2", "x", false, QUOTA));
    }

    @Test
    void writeSizeLimit() throws Exception {
        ws.write("a1", "max", "a".repeat(1024 * 1024), false, QUOTA * 10);
        refused(Reason.TOO_LARGE, () -> ws.write("a1", "max", "a".repeat(1024 * 1024 + 1), false, QUOTA * 10));
        refused(Reason.TOO_LARGE, () -> ws.write("a1", "max", "é".repeat(524_289), true, QUOTA * 10)); // 1 MiB + 2
        assertThat(ws.used("a1")).isEqualTo(1024 * 1024);
        // Appends add up past 1 MiB: only one write is limited.
        ws.write("a1", "max", "b", true, QUOTA * 10);
        assertThat(ws.read("a1", "max", 3).bytes()).isEqualTo(1024 * 1024 + 1);
    }

    @Test
    void diskGuard() throws Exception {
        free.set(1000); // exactly the minimum: allowed
        ws.write("a1", "f", "x", false, QUOTA);
        free.set(999);
        refused(Reason.DISK_FULL, () -> ws.write("a1", "g", "x", false, QUOTA));
        refused(Reason.DISK_FULL, () -> ws.write("a1", "f", "y", true, QUOTA));
        refused(Reason.DISK_FULL, () -> ws.write("a1", "new/dir/f", "y", false, QUOTA));
        assertThat(ws.list("a1", "")).extracting(Entry::path).containsExactly("f");
        assertThat(read("a1", "f")).isEqualTo("x");
        // Reads and removes still work on a full disk.
        assertThat(ws.remove("a1", "f")).isZero();
        free.set(5000);
        ws.write("a1", "g", "x", false, QUOTA);
    }

    @Test
    void theRealFileStoreIsTheDefault() throws Exception {
        Workspaces real = new Workspaces(root, Long.MAX_VALUE);
        refused(Reason.DISK_FULL, () -> real.write("a1", "f", "x", false, QUOTA));
        Workspaces ok = new Workspaces(root, 0);
        ok.write("a1", "f", "x", false, QUOTA);
    }

    // ------------------------------------------------------------ text

    @Test
    void notTextIsRefused() throws Exception {
        Path a1 = root.resolve("a1");
        Files.write(a1.resolve("latin1"), new byte[]{'c', 'a', 'f', (byte) 0xe9});
        Files.write(a1.resolve("binary"), new byte[]{'a', 0, 'b'});
        Files.write(a1.resolve("png"), new byte[]{(byte) 0x89, 'P', 'N', 'G'});
        Files.write(a1.resolve("bom-ok"), "﻿hi".getBytes(StandardCharsets.UTF_8));
        refused(Reason.NOT_TEXT, () -> ws.read("a1", "latin1", 100));
        refused(Reason.NOT_TEXT, () -> ws.read("a1", "binary", 100));
        refused(Reason.NOT_TEXT, () -> ws.read("a1", "png", 100));
        assertThat(ws.read("a1", "bom-ok", 100).text()).isEqualTo("﻿hi");
        refused(Reason.NOT_TEXT, () -> ws.write("a1", "n", "a\0b", false, QUOTA));
        refused(Reason.NOT_TEXT, () -> ws.write("a1", "n", "lone\ud800", false, QUOTA));
        refused(Reason.NOT_TEXT, () -> ws.write("a1", "n", null, false, QUOTA));
        assertThat(ws.list("a1", "")).extracting(Entry::path).doesNotContain("n");
    }

    @Test
    void foldersAndFilesDontMix() throws Exception {
        ws.write("a1", "d/f", "x", false, QUOTA);
        refused(Reason.PATH, () -> ws.read("a1", "d", 10)); // a folder isn't a file
        refused(Reason.PATH, () -> ws.write("a1", "d", "x", false, QUOTA));
        refused(Reason.PATH, () -> ws.write("a1", "d/f/g", "x", false, QUOTA)); // f is a file
        refused(Reason.PATH, () -> ws.read("a1", "d/f/g", 10));
        refused(Reason.PATH, () -> ws.list("a1", "d/f"));
        assertThat(read("a1", "d/f")).isEqualTo("x");
        assertThat(ws.used("a1")).isEqualTo(2 * U); // the file and its folder
    }

    @Test
    void createIsIdempotentAndKeepsFiles() throws Exception {
        ws.write("a1", "f", "x", false, QUOTA);
        ws.create("a1");
        assertThat(read("a1", "f")).isEqualTo("x");
        assertThat(ws.used("a1")).isEqualTo(U);
    }

    @Test
    void reasonWireNames() {
        assertThat(Reason.values()).extracting(Reason::wireName).containsExactly("path", "not_found", "quota",
                "not_text", "too_large", "disk_full", "too_many_files", "too_many_folders");
        assertThat(new WorkspaceException(Reason.QUOTA).getMessage()).isEqualTo("quota");
    }
}
