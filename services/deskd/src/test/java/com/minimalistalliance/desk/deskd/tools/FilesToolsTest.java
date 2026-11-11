package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The Agent's Files tools against a real tree: scope, writes and replaces, the cap, moves, the trash, and reads. */
class FilesToolsTest {

    @TempDir
    Path dir;

    private AgentFilesRig rig;
    private Path root;
    private FilesTools tools;
    private RunLedger.Run run;
    private long nextId = 1;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentFilesRig(dir.resolve("rig"));
        root = rig.root();
        tools = new FilesTools(rig.files().agentAccess());
        run = new RunLedger(Clock.systemUTC(), id -> { }).join("run-1", "ag-1", Caller.THE_OWNER, List.of());
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    // ---- helpers

    static Map<String, Object> args(Object... pairs) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            m.put((String) pairs[i], pairs[i + 1]);
        }
        return m;
    }

    private HostedCall call(String tool, Map<String, Object> args, boolean look) {
        return new HostedCall(1, "run-1", "ag-1", tool, args, null, look, Caller.THE_OWNER, null);
    }

    private HostedTool.Look look(String tool, Object... pairs) throws Exception {
        return tools.look(call(tool, args(pairs), true), run);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> run(String tool, Object... pairs) throws Exception {
        return (Map<String, Object>) tools.run(call(tool, args(pairs), false), run).content();
    }

    private ToolFailure lookFails(String tool, Object... pairs) {
        Throwable t = org.assertj.core.api.Assertions.catchThrowable(() -> look(tool, pairs));
        assertThat(t).isInstanceOf(ToolFailure.class);
        return (ToolFailure) t;
    }

    private ToolFailure runFails(String tool, Object... pairs) {
        Throwable t = org.assertj.core.api.Assertions.catchThrowable(() -> run(tool, pairs));
        assertThat(t).isInstanceOf(ToolFailure.class);
        return (ToolFailure) t;
    }

    private Path put(String relative, String text) throws Exception {
        return put(relative, text.getBytes(StandardCharsets.UTF_8));
    }

    private Path put(String relative, byte[] bytes) throws Exception {
        Path p = root.resolve(relative);
        Files.createDirectories(p.getParent());
        Files.write(p, bytes);
        return p;
    }

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private List<Path> trashItems() throws Exception {
        Path trash = root.resolve(".trash");
        if (!Files.isDirectory(trash)) {
            return List.of();
        }
        try (Stream<Path> s = Files.list(trash)) {
            return s.map(p -> p.resolve("item")).toList();
        }
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Map<String, Object> m, String key) {
        return (List<Map<String, Object>>) m.get(key);
    }

    // ---- scope

    @Test
    void aPathOutsideTheFilesAreaIsRefusedInLookAndRun() throws Exception {
        put("docs/a.txt", "x");
        for (String bad : List.of("../x", "/etc/passwd", ".trash/a", ".uploads", ".uploads/p", "docs/.trash/x", "docs/../x",
                "docs//a.txt", "docs/", "..", "docs/.uploads")) {
            assertThat(lookFails("files_read", "path", bad).reason()).as(bad).isEqualTo("path");
            assertThat(runFails("files_read", "path", bad).reason()).as(bad).isEqualTo("path");
            assertThat(lookFails("files_write", "path", bad, "text", "t", "replace", false).reason()).as(bad).isEqualTo("path");
            assertThat(runFails("files_write", "path", bad, "text", "t", "replace", false).reason()).as(bad).isEqualTo("path");
            assertThat(lookFails("files_mkdir", "path", bad).reason()).as(bad).isEqualTo("path");
            assertThat(runFails("files_mkdir", "path", bad).reason()).as(bad).isEqualTo("path");
            assertThat(lookFails("files_trash", "path", bad).reason()).as(bad).isEqualTo("path");
            assertThat(runFails("files_trash", "path", bad).reason()).as(bad).isEqualTo("path");
            assertThat(lookFails("files_move", "from", bad, "to", "ok.txt").reason()).as(bad).isEqualTo("path");
            assertThat(runFails("files_move", "from", "docs/a.txt", "to", bad).reason()).as(bad).isEqualTo("path");
        }
        for (String bad : List.of("../x", "/etc", ".trash", ".uploads", "docs/.trash")) {
            assertThat(lookFails("files_list", "path", bad).reason()).as(bad).isEqualTo("path");
            assertThat(runFails("files_list", "path", bad).reason()).as(bad).isEqualTo("path");
            assertThat(runFails("files_search", "q", "a", "under", bad).reason()).as(bad).isEqualTo("path");
        }
        assertThat(root.resolve("docs/a.txt")).hasContent("x");
    }

    @Test
    void aLinkOutOfTheTreeIsNeverFollowed() throws Exception {
        Path outside = Files.createDirectories(dir.resolve("outside"));
        Files.writeString(outside.resolve("secret.txt"), "secret");
        Files.createSymbolicLink(root.resolve("out"), outside);
        Files.createSymbolicLink(root.resolve("secret-link.txt"), outside.resolve("secret.txt"));

        for (String path : List.of("out/secret.txt", "secret-link.txt")) {
            assertThat(runFails("files_read", "path", path).code()).as(path).isNotBlank();
        }
        runFails("files_list", "path", "out");
        lookFails("files_write", "path", "out/new.txt", "text", "t", "replace", false);
        runFails("files_write", "path", "out/new.txt", "text", "t", "replace", false);
        runFails("files_write", "path", "secret-link.txt", "text", "t", "replace", true);
        runFails("files_mkdir", "path", "out/sub");
        runFails("files_trash", "path", "out");
        runFails("files_trash", "path", "secret-link.txt");
        runFails("files_move", "from", "out", "to", "moved");
        assertThat(outside.resolve("secret.txt")).hasContent("secret");
        assertThat(outside).isDirectoryContaining(p -> p.getFileName().toString().equals("secret.txt"));
        try (Stream<Path> s = Files.list(outside)) {
            assertThat(s.count()).isEqualTo(1);
        }
    }

    // ---- write

    @Test
    void aNewFileIsWrittenAndNothingGoesToTheTrash() throws Exception {
        put("docs/keep.txt", "k");
        HostedTool.Look found = look("files_write", "path", "docs/new.txt", "text", "héllo", "replace", false);
        assertThat(found.risk()).isEqualTo(ToolRisk.WRITE);
        assertThat(found.before()).isNull();
        assertThat(found.payload()).containsEntry("replace", false).containsEntry("path", "docs/new.txt");
        assertThat(found.target()).containsEntry("kind", "file").containsEntry("path", "docs/new.txt");
        run("files_write", "path", "docs/new.txt", "text", "héllo", "replace", false);
        assertThat(root.resolve("docs/new.txt")).hasContent("héllo");
        assertThat(trashItems()).isEmpty();
        try (Stream<Path> s = Files.list(root.resolve("docs"))) {
            assertThat(s.map(p -> p.getFileName().toString()).toList()).containsExactlyInAnyOrder("keep.txt", "new.txt");
        }
    }

    @Test
    void replaceIsOptionalInTheArgsAndNormalizedToFalse() throws Exception {
        HostedTool.Look found = look("files_write", "path", "n.txt", "text", "t");
        assertThat(found.payload()).containsEntry("replace", false);
        run("files_write", "path", "n.txt", "text", "t");
        assertThat(root.resolve("n.txt")).hasContent("t");
    }

    @Test
    void aFileThereWithoutReplaceIsExists() throws Exception {
        put("a.txt", "old");
        assertThat(lookFails("files_write", "path", "a.txt", "text", "new", "replace", false).reason()).isEqualTo("exists");
        assertThat(runFails("files_write", "path", "a.txt", "text", "new", "replace", false).reason()).isEqualTo("exists");
        assertThat(root.resolve("a.txt")).hasContent("old");
    }

    @Test
    void aReplaceKeepsTheOldFileInTheTrashAndWritesTheNewOneInPlace() throws Exception {
        put("a.txt", "old text");
        HostedTool.Look found = look("files_write", "path", "a.txt", "text", "new text", "replace", true);
        assertThat(found.before()).containsEntry("sha256", sha("old text".getBytes(StandardCharsets.UTF_8)))
                .containsEntry("bytes", 8L);
        run("files_write", "path", "a.txt", "text", "new text", "replace", true);
        assertThat(root.resolve("a.txt")).hasContent("new text");
        assertThat(trashItems()).hasSize(1);
        assertThat(trashItems().get(0)).hasContent("old text");
        try (Stream<Path> s = Files.list(root)) {
            assertThat(s.map(p -> p.getFileName().toString())).noneMatch(n -> n.startsWith(".agent-"));
        }
    }

    @Test
    void aReplaceOfAFileThatChangedSinceTheLookIsChanged() throws Exception {
        put("a.txt", "old text");
        look("files_write", "path", "a.txt", "text", "new text", "replace", true);
        put("a.txt", "someone else was here");
        assertThat(runFails("files_write", "path", "a.txt", "text", "new text", "replace", true).reason()).isEqualTo("changed");
        assertThat(root.resolve("a.txt")).hasContent("someone else was here");
        assertThat(trashItems()).isEmpty();
    }

    @Test
    void aReplaceWithNoLookRememberedIsChanged() throws Exception {
        put("a.txt", "old text");
        ToolFailure f = runFails("files_write", "path", "a.txt", "text", "new text", "replace", true);
        assertThat(f.reason()).isEqualTo("changed");
        assertThat(root.resolve("a.txt")).hasContent("old text");
        // A look of other text isn't this call's look.
        look("files_write", "path", "a.txt", "text", "other", "replace", true);
        assertThat(runFails("files_write", "path", "a.txt", "text", "new text", "replace", true).reason()).isEqualTo("changed");
    }

    @Test
    void aLookIsForgottenWhenTheRunEnds() throws Exception {
        put("a.txt", "old");
        look("files_write", "path", "a.txt", "text", "new", "replace", true);
        tools.runEnded("run-1");
        assertThat(runFails("files_write", "path", "a.txt", "text", "new", "replace", true).reason()).isEqualTo("changed");
    }

    @Test
    void aReplaceOfAFileThatWasNotThereWritesItIfItStillIsnt() throws Exception {
        look("files_write", "path", "ghost.txt", "text", "now", "replace", true);
        run("files_write", "path", "ghost.txt", "text", "now", "replace", true);
        assertThat(root.resolve("ghost.txt")).hasContent("now");
        // And if it appeared in between, that is a change.
        look("files_write", "path", "ghost2.txt", "text", "now", "replace", true);
        put("ghost2.txt", "appeared");
        assertThat(runFails("files_write", "path", "ghost2.txt", "text", "now", "replace", true).reason()).isEqualTo("changed");
    }

    @Test
    void theParentMustExistAndBeAFolder() throws Exception {
        put("file.txt", "x");
        assertThat(lookFails("files_write", "path", "nope/a.txt", "text", "t", "replace", false).reason()).isEqualTo("not_found");
        assertThat(runFails("files_write", "path", "nope/a.txt", "text", "t", "replace", false).reason()).isEqualTo("not_found");
        assertThat(runFails("files_write", "path", "file.txt/a.txt", "text", "t", "replace", false).reason()).isIn("not_found", "not_folder");
        Files.createDirectories(root.resolve("folder"));
        assertThat(lookFails("files_write", "path", "folder", "text", "t", "replace", true).reason()).isEqualTo("is_folder");
        assertThat(root.resolve("nope")).doesNotExist();
    }

    @Test
    void textOverTheLimitIsTooLarge() throws Exception {
        String big = "a".repeat(256 * 1024 + 1);
        assertThat(lookFails("files_write", "path", "big.txt", "text", big, "replace", false).reason()).isEqualTo("too_large");
        assertThat(runFails("files_write", "path", "big.txt", "text", big, "replace", false).reason()).isEqualTo("too_large");
        run("files_write", "path", "ok.txt", "text", "a".repeat(256 * 1024), "replace", false);
        assertThat(Files.size(root.resolve("ok.txt"))).isEqualTo(256 * 1024);
        assertThat(root.resolve("big.txt")).doesNotExist();
    }

    @Test
    void badArgumentsAreRefusedByName() throws Exception {
        assertThat(lookFails("files_write", "path", "a.txt", "replace", false).reason()).isEqualTo("text");
        assertThat(lookFails("files_write", "path", "a.txt", "text", "t", "replace", "yes").reason()).isEqualTo("replace");
        assertThat(lookFails("files_write", "text", "t").reason()).isEqualTo("path");
        assertThat(lookFails("files_read", "path", "a.txt", "offset", -1).reason()).isEqualTo("offset");
    }

    // ---- the cap and the floor

    @Test
    void aWritePastTheFreeTiersCapIsNoSpaceWithTheCap() throws Exception {
        put("big.bin", new byte[900]);
        rig.cap(1000);
        ToolFailure f = lookFails("files_write", "path", "a.txt", "text", "x".repeat(200), "replace", false);
        assertThat(f.reason()).isEqualTo("no_space");
        assertThat(f.details()).containsEntry("cap", true);
        assertThat(runFails("files_write", "path", "a.txt", "text", "x".repeat(200), "replace", false).details())
                .containsEntry("cap", true);
        assertThat(root.resolve("a.txt")).doesNotExist();
        run("files_write", "path", "a.txt", "text", "x".repeat(90), "replace", false);
        assertThat(root.resolve("a.txt")).exists();
    }

    @Test
    void aWriteIntoTheFloorIsNoSpace() throws Exception {
        rig.free(AgentFilesRig.floor() + 10);
        ToolFailure f = runFails("files_write", "path", "a.txt", "text", "x".repeat(100), "replace", false);
        assertThat(f.reason()).isEqualTo("no_space");
        assertThat(f.details()).containsEntry("floor", true).doesNotContainKey("cap");
        run("files_write", "path", "b.txt", "text", "x".repeat(5), "replace", false);
    }

    // ---- mkdir, move, trash

    @Test
    void mkdirMakesOneFolderAndNeverMore() throws Exception {
        run("files_mkdir", "path", "a");
        run("files_mkdir", "path", "a/b");
        assertThat(root.resolve("a/b")).isDirectory();
        assertThat(runFails("files_mkdir", "path", "a").reason()).isEqualTo("exists");
        assertThat(lookFails("files_mkdir", "path", "a/b").reason()).isEqualTo("exists");
        assertThat(runFails("files_mkdir", "path", "x/y").reason()).isEqualTo("not_found");
        assertThat(root.resolve("x")).doesNotExist();
        put("f.txt", "f");
        assertThat(runFails("files_mkdir", "path", "f.txt").reason()).isEqualTo("exists");
    }

    @Test
    void aMoveNeverReplaces() throws Exception {
        put("a.txt", "A");
        put("b.txt", "B");
        Files.createDirectories(root.resolve("dir"));
        Files.createDirectories(root.resolve("dir2"));
        assertThat(runFails("files_move", "from", "a.txt", "to", "b.txt").reason()).isEqualTo("exists");
        assertThat(lookFails("files_move", "from", "a.txt", "to", "b.txt").reason()).isEqualTo("exists");
        assertThat(runFails("files_move", "from", "a.txt", "to", "dir").reason()).isEqualTo("exists");
        assertThat(runFails("files_move", "from", "dir", "to", "dir2").reason()).isEqualTo("exists");
        assertThat(runFails("files_move", "from", "dir", "to", "dir/inner").reason()).isEqualTo("path");
        assertThat(runFails("files_move", "from", "nope", "to", "c.txt").reason()).isEqualTo("not_found");
        assertThat(runFails("files_move", "from", "a.txt", "to", "nodir/c.txt").reason()).isEqualTo("not_found");
        assertThat(root.resolve("a.txt")).hasContent("A");
        assertThat(root.resolve("b.txt")).hasContent("B");

        HostedTool.Look found = look("files_move", "from", "a.txt", "to", "dir/c.txt");
        assertThat(found.target()).containsEntry("kind", "file").containsEntry("path", "a.txt").containsEntry("to", "dir/c.txt");
        assertThat(found.payload()).containsOnlyKeys("from", "to");
        run("files_move", "from", "a.txt", "to", "dir/c.txt");
        assertThat(root.resolve("a.txt")).doesNotExist();
        assertThat(root.resolve("dir/c.txt")).hasContent("A");
    }

    @Test
    void trashGoesToFilesTrashAndNothingIsPermanent() throws Exception {
        put("a.txt", "twelve bytes");
        put("d/x.txt", "123");
        put("d/sub/y.txt", "4567");
        HostedTool.Look file = look("files_trash", "path", "a.txt");
        assertThat(file.risk()).isEqualTo(ToolRisk.DELETE);
        assertThat(file.before()).containsEntry("bytes", 12L).containsEntry("dir", false);
        assertThat(look("files_trash", "path", "d").before()).containsEntry("bytes", 7L).containsEntry("dir", true);
        run("files_trash", "path", "a.txt");
        run("files_trash", "path", "d");
        assertThat(root.resolve("a.txt")).doesNotExist();
        assertThat(root.resolve("d")).doesNotExist();
        assertThat(trashItems()).hasSize(2);
        assertThat(trashItems().stream().filter(Files::isRegularFile).toList()).singleElement()
                .satisfies(p -> assertThat(p).hasContent("twelve bytes"));
        assertThat(trashItems()).anySatisfy(p -> assertThat(p.resolve("sub/y.txt")).hasContent("4567"));
        assertThat(runFails("files_trash", "path", "a.txt").reason()).isEqualTo("not_found");
        assertThat(lookFails("files_trash", "path", "gone").reason()).isEqualTo("not_found");
    }

    @Test
    void thereIsNoToolThatDeletesForGood() {
        assertThat(HostedDecls.ALL.keySet()).filteredOn(n -> n.startsWith("files_"))
                .containsExactlyInAnyOrder("files_list", "files_search", "files_read", "files_write", "files_mkdir",
                        "files_move", "files_trash");
        assertThatThrownBy(() -> tools.run(call("files_delete", args("path", "a"), false), run)).isInstanceOf(ToolFailure.class);
    }

    // ---- list and search

    @Test
    void listGivesNamesOnlyAndHidesWhatFilesHides() throws Exception {
        put("a.txt", "abc");
        put("folder/inner.txt", "i");
        put(".uploads/partial", "p");
        put(".trash/x/item", "t");
        Map<String, Object> out = run("files_list", "path", "");
        List<Map<String, Object>> entries = list(out, "entries");
        assertThat(entries).extracting(e -> e.get("name")).containsExactlyInAnyOrder("a.txt", "folder");
        assertThat(entries).allSatisfy(e -> assertThat(e).containsOnlyKeys(e.get("kind").equals("file")
                ? List.of("name", "kind", "bytes", "mtimeMs").toArray(new String[0])
                : List.of("name", "kind", "mtimeMs").toArray(new String[0])));
        assertThat(entries).filteredOn(e -> e.get("name").equals("a.txt")).first().satisfies(e -> {
            assertThat(e).containsEntry("kind", "file").containsEntry("bytes", 3L);
        });
        assertThat(entries).filteredOn(e -> e.get("name").equals("folder")).first().satisfies(e ->
                assertThat(e).containsEntry("kind", "folder"));
        assertThat(out).doesNotContainKey("more");
        assertThat(run("files_list", "path", "/")).isEqualTo(out);
        assertThat(list(run("files_list", "path", "folder"), "entries")).extracting(e -> e.get("name")).containsExactly("inner.txt");
        assertThat(runFails("files_list", "path", "a.txt").reason()).isEqualTo("not_folder");
        assertThat(runFails("files_list", "path", "nope").reason()).isEqualTo("not_found");
    }

    @Test
    void listStopsAt500WithANote() throws Exception {
        for (int i = 0; i < 520; i++) {
            put("many/f" + String.format("%04d", i) + ".txt", "x");
        }
        Map<String, Object> out = run("files_list", "path", "many");
        assertThat(list(out, "entries")).hasSize(500);
        assertThat(out).containsEntry("more", true).containsKey("note");
    }

    @Test
    void searchGivesPathsAndKindsOnly() throws Exception {
        put("notes/needle.txt", "the needle's content must never come back");
        put("notes/deep/Needle2.md", "z");
        put("other/hay.txt", "z");
        put("trashme/needle3.txt", "t");
        run("files_trash", "path", "trashme/needle3.txt");
        Map<String, Object> out = run("files_search", "q", "needle");
        List<Map<String, Object>> hits = list(out, "hits");
        assertThat(hits).extracting(h -> h.get("path")).containsExactlyInAnyOrder("notes/needle.txt", "notes/deep/Needle2.md");
        assertThat(hits).allSatisfy(h -> assertThat(h).containsOnlyKeys("path", "kind"));
        assertThat(list(run("files_search", "q", "needle", "under", "notes/deep"), "hits")).hasSize(1);
        assertThat(list(run("files_search", "q", "needle", "under", "/"), "hits")).hasSize(2);
        assertThat(runFails("files_search", "q", "needle", "under", "nope").reason()).isEqualTo("not_found");
        assertThat(runFails("files_search", "q", "").reason()).isEqualTo("path");
    }

    @Test
    void searchNeverShowsAReservedNameDeeper() throws Exception {
        put("a/.trash/needle.txt", "x");
        put("a/needle.txt", "y");
        assertThat(list(run("files_search", "q", "needle"), "hits")).extracting(h -> h.get("path")).containsExactly("a/needle.txt");
    }

    // ---- read

    @Test
    void textIsReadInPagesThatAddUpToTheFile() throws Exception {
        String text = ("é".repeat(100_000) + "😀".repeat(40_000) + "end\n");
        put("long.txt", text);
        StringBuilder all = new StringBuilder();
        Object next = 0L;
        int pages = 0;
        while (next != null) {
            Map<String, Object> page = run("files_read", "path", "long.txt", "offset", next);
            assertThat(page).containsEntry("path", "long.txt").containsEntry("offset", next);
            String t = (String) page.get("text");
            assertThat(t.length()).isLessThanOrEqualTo(128 * 1024);
            all.append(t);
            next = page.get("next");
            pages++;
        }
        assertThat(pages).isGreaterThan(1);
        assertThat(all.toString()).isEqualTo(text);
        Map<String, Object> first = run("files_read", "path", "long.txt");
        assertThat(((String) first.get("text")).length()).isEqualTo(128 * 1024);
        assertThat(first.get("next")).isNotNull();
    }

    @Test
    void aSmallTextFileIsOnePageWithNoNext() throws Exception {
        put("s.txt", "short");
        Map<String, Object> page = run("files_read", "path", "s.txt");
        assertThat(page).containsEntry("text", "short").containsEntry("offset", 0L).containsEntry("next", null);
        put("empty.txt", "");
        assertThat(run("files_read", "path", "empty.txt")).containsEntry("text", "").containsEntry("next", null);
        assertThat(runFails("files_read", "path", "s.txt", "offset", 6).reason()).isEqualTo("path");
        put("two.txt", "aé");
        assertThat(runFails("files_read", "path", "two.txt", "offset", 2).reason()).isEqualTo("path");
        assertThat(runFails("files_read", "path", "nope.txt").reason()).isEqualTo("not_found");
        Files.createDirectories(root.resolve("dir"));
        assertThat(runFails("files_read", "path", "dir").reason()).isEqualTo("is_folder");
    }

    @Test
    void documentsPassThroughByTheirBytesNotTheirName() throws Exception {
        byte[] pdf = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n".getBytes(StandardCharsets.UTF_8);
        put("a-notes.txt", pdf);
        Map<String, Object> out = run("files_read", "path", "a-notes.txt");
        assertThat(out).containsEntry("kind", "document").containsEntry("type", "pdf").containsEntry("path", "a-notes.txt")
                .doesNotContainKey("text");
        assertThat(Base64.getDecoder().decode((String) out.get("data"))).isEqualTo(pdf);
        for (String type : List.of("docx", "xlsx", "pptx")) {
            String prefix = switch (type) {
                case "docx" -> "word/";
                case "xlsx" -> "xl/";
                default -> "ppt/";
            };
            byte[] zip = zip("[Content_Types].xml", prefix + "main.xml");
            put("doc-" + type + ".dat", zip);
            Map<String, Object> doc = run("files_read", "path", "doc-" + type + ".dat");
            assertThat(doc).containsEntry("kind", "document").containsEntry("type", type);
            assertThat(Base64.getDecoder().decode((String) doc.get("data"))).isEqualTo(zip);
        }
        put("report.pdf", "just text in a pdf's name");
        assertThat(run("files_read", "path", "report.pdf")).containsEntry("text", "just text in a pdf's name");
    }

    @Test
    void whatIsNeitherTextNorADocumentIsRefused() throws Exception {
        put("bin.dat", new byte[] {1, 2, 0, 3, 4});
        assertThat(runFails("files_read", "path", "bin.dat").reason()).isEqualTo("not_text");
        put("bad.txt", new byte[] {'a', (byte) 0xFF, (byte) 0xFE, 'b'});
        assertThat(runFails("files_read", "path", "bad.txt").reason()).isEqualTo("not_text");
        put("cut.txt", new byte[] {'a', (byte) 0xC3});
        assertThat(runFails("files_read", "path", "cut.txt").reason()).isEqualTo("not_text");
        put("pic.png", new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 'I', 'H', 'D', 'R'});
        assertThat(runFails("files_read", "path", "pic.png").reason()).isEqualTo("not_text");
        put("other.zip", zip("a.txt"));
        assertThat(runFails("files_read", "path", "other.zip").reason()).isEqualTo("not_text");
        byte[] bigPdf = new byte[3 * 1024 * 1024 + 1];
        System.arraycopy("%PDF-1.7\n".getBytes(StandardCharsets.UTF_8), 0, bigPdf, 0, 9);
        put("big.pdf", bigPdf);
        assertThat(runFails("files_read", "path", "big.pdf").reason()).isEqualTo("too_large");
        byte[] okPdf = new byte[3 * 1024 * 1024];
        System.arraycopy("%PDF-1.7\n".getBytes(StandardCharsets.UTF_8), 0, okPdf, 0, 9);
        put("ok.pdf", okPdf);
        assertThat(run("files_read", "path", "ok.pdf")).containsEntry("kind", "document");
    }

    private static byte[] zip(String... names) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(out)) {
            for (String name : names) {
                z.putNextEntry(new ZipEntry(name));
                z.write("<x/>".getBytes(StandardCharsets.UTF_8));
                z.closeEntry();
            }
        }
        return out.toByteArray();
    }

    @Test
    void theAreaIsAvailableWhileFilesIs() {
        assertThat(tools.available()).isTrue();
    }
}
