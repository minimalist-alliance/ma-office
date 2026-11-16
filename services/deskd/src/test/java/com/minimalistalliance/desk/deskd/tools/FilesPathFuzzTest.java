package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.TreeMap;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Path safety of the Agent's Files tools, fuzz-style (draft ADR "the Agent's tools and approvals", section 2: inside
 * {@code /data/files} only, no escapes): a table of nasty paths, then thousands more made at random from nasty pieces,
 * through every tool's look and run, on a real tree with links out of it, a hard link, a FIFO and a folder that a link
 * takes the place of between a look and its run. Whatever each call answers, nothing outside the Files root changes,
 * nothing is created outside it, and every path that names something invisible, a lookalike or a step up is refused
 * {@code path}.
 */
class FilesPathFuzzTest {

    @TempDir
    Path dir;

    private AgentFilesRig rig;
    private Path root;
    private Path outside;
    private FilesTools tools;
    private RunLedger.Run run;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentFilesRig(dir.resolve("rig"));
        root = rig.root();
        tools = new FilesTools(rig.files().agentAccess());
        run = new RunLedger(Clock.systemUTC(), id -> { }).join("run-1", "ag-1", Caller.THE_OWNER, List.of());
        outside = Files.createDirectories(dir.resolve("outside"));
        Files.writeString(outside.resolve("secret.txt"), "secret");
        Files.createDirectories(outside.resolve("sub"));
        Files.writeString(outside.resolve("sub/deep.txt"), "deep");
        // The tree: a real folder and file, links out of the tree (to a folder, a file, the root's parent and a loop),
        // a hard link, and a FIFO.
        Files.createDirectories(root.resolve("docs"));
        Files.writeString(root.resolve("docs/a.txt"), "a");
        Files.createSymbolicLink(root.resolve("out"), outside);
        Files.createSymbolicLink(root.resolve("docs/secret.txt"), outside.resolve("secret.txt"));
        Files.createSymbolicLink(root.resolve("up"), root.getParent());
        Files.createSymbolicLink(root.resolve("loop"), root.resolve("loop"));
        Files.createSymbolicLink(root.resolve("rel"), Path.of("../outside"));
        Files.createLink(root.resolve("hard.txt"), outside.resolve("secret.txt"));
        mkfifo(root.resolve("pipe"));
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private static void mkfifo(Path path) throws Exception {
        Process p = new ProcessBuilder("mkfifo", path.toString()).inheritIO().start();
        assertThat(p.waitFor()).isZero();
    }

    // ---------------------------------------------------------------- the table

    /** Paths refused {@code path} by every tool, look and run alike. */
    static final List<String> REFUSED = List.of(
            // Steps up, absolute paths, empty parts, Windows forms
            "..", "../x", "../../etc/passwd", "docs/../..", "docs/../a.txt", "./docs", "docs/./a.txt", "/etc/passwd",
            "//x", "docs//a.txt", "docs/", "\\..\\x", "..\\x", "C:\\Windows", "\\\\server\\share", "docs\\a.txt",
            // Reserved names at any depth
            ".trash", ".trash/x", ".uploads", ".uploads/p.part", "docs/.trash", "docs/.uploads/x",
            // Controls and the NUL
            "a\u0000b", "docs/a.txt\u0000.png", "a\nb", "a\rb", "a\tb", "\u007f", "a\u0085b",
            // Bidi controls: a name drawn backwards
            "invoice\u202Etxt.exe", "\u2066x\u2069", "docs/\u202Dx",
            // Invisible characters: a name drawn the same as another
            "docs\u200B/a.txt", "a\u200C.txt", "a\u200D.txt", "\uFEFFa.txt", "a\u00AD.txt", "a\u2060.txt",
            "a\u180E.txt", "a\u034F.txt", "\u3164", "a\uFFA0.txt", "\uDB40\uDC61x", "a\u061C.txt",
            // Separators, private use, noncharacters, unassigned, a lone surrogate
            "a\u2028b", "a\u2029b", "a\uE000.txt", "a\uFDD0.txt", "a\uFFFE", "a\uFFFF", "a\uD83Dx", "\uDE00",
            "a\u0378.txt", "a\uFFFD.txt",
            // Drawn like a slash or a backslash: a card would show a folder that isn't one
            "docs\u2215a.txt", "docs\u2044a.txt", "docs\uFF0Fa.txt", "docs\u29F8a.txt", "docs\uFF3Ca.txt",
            "docs\u2216a.txt", "docs\uFE68a.txt",
            // Names of dots alone, drawn like a step up
            "...", "....", "\u2025", "\u2024\u2024", "\uFF0E\uFF0E", "docs/\u2026",
            // Spaces at either end, which a card's title drops
            " a.txt", "a.txt ", "docs/ a.txt", "\u00A0a.txt", "a.txt\u3000", " ",
            // Not NFC
            "e\u0301.txt", "docs/A\u030A.txt",
            // Too long: a name over 255 bytes, a path over 1024
            "x".repeat(256), ("d".repeat(200) + "/").repeat(6) + "x.txt");

    /** Paths that reach something that isn't there as far as the tools go: a link, a hard link, a FIFO. */
    static final List<String> NOT_THERE = List.of("out", "out/secret.txt", "out/sub/deep.txt", "docs/secret.txt",
            "up", "up/outside/secret.txt", "loop", "loop/x", "rel", "rel/secret.txt", "hard.txt", "pipe");

    @Test
    void everyNastyPathIsRefusedPathByEveryToolInLookAndRun() throws Exception {
        Snapshot before = Snapshot.of(outside);
        Snapshot tree = Snapshot.of(root);
        for (String bad : REFUSED) {
            for (Call c : callsWith(bad)) {
                assertThat(look(c)).as("look %s %s", c.tool, shown(bad)).isEqualTo("path");
                assertThat(run(c)).as("run %s %s", c.tool, shown(bad)).isEqualTo("path");
            }
        }
        assertThat(Snapshot.of(outside)).isEqualTo(before);
        assertThat(Snapshot.of(root)).isEqualTo(tree);
    }

    @Test
    void aLinkAHardLinkOrAFifoIsNeverFollowedReadWrittenOrMoved() throws Exception {
        Snapshot before = Snapshot.of(outside);
        for (String path : NOT_THERE) {
            for (Call c : callsWith(path)) {
                String look = look(c);
                String ran = run(c);
                // Each is refused, look and run: never read through, written through, replaced, moved or trashed.
                assertThat(ran).as("run %s %s", c.tool, path).isNotNull();
                if (c.tool.equals("files_list") || c.tool.equals("files_read")) {
                    assertThat(look).as("a look only checks the path's grammar: %s %s", c.tool, path)
                            .isIn(null, "not_found", "not_folder", "is_folder", "exists", "path");
                }
            }
        }
        assertThat(Snapshot.of(outside)).isEqualTo(before);
        // The links, the hard link and the FIFO are all still there, as they were.
        for (String name : List.of("out", "docs/secret.txt", "up", "loop", "rel")) {
            assertThat(Files.isSymbolicLink(root.resolve(name))).as(name).isTrue();
        }
        assertThat(Files.readString(outside.resolve("secret.txt"))).isEqualTo("secret");
        assertThat(Files.exists(root.resolve("pipe"), LinkOption.NOFOLLOW_LINKS)).isTrue();
    }

    @Test
    void aFolderSwappedForALinkBetweenTheLookAndTheRunIsNeverFollowed() throws Exception {
        Files.createDirectories(root.resolve("swap"));
        Files.writeString(root.resolve("swap/old.txt"), "old");
        Snapshot before = Snapshot.of(outside);
        List<Call> calls = List.of(
                new Call("files_write", args("path", "swap/new.txt", "text", "x", "replace", false)),
                new Call("files_write", args("path", "swap/old.txt", "text", "x", "replace", true)),
                new Call("files_mkdir", args("path", "swap/made")),
                new Call("files_trash", args("path", "swap/old.txt")),
                new Call("files_move", args("from", "swap/old.txt", "to", "moved.txt")),
                new Call("files_move", args("from", "docs/a.txt", "to", "swap/a.txt")),
                new Call("files_read", args("path", "swap/old.txt")),
                new Call("files_list", args("path", "swap")));
        for (Call c : calls) {
            // The look sees a real folder.
            assertThat(look(c)).as("look %s", c.tool).isNull();
        }
        // Then, before any runs, the folder becomes a link out of the tree, with a file of the same name beyond it.
        Files.move(root.resolve("swap"), dir.resolve("swap-was"));
        Files.writeString(outside.resolve("old.txt"), "outside old");
        Files.createSymbolicLink(root.resolve("swap"), outside);
        Snapshot linked = Snapshot.of(outside);
        for (Call c : calls) {
            assertThat(run(c)).as("run %s", c.tool).isNotNull();
        }
        assertThat(Snapshot.of(outside)).isEqualTo(linked);
        assertThat(Files.readString(outside.resolve("old.txt"))).isEqualTo("outside old");
        assertThat(before.files()).doesNotContainKey("old.txt");
        assertThat(Files.readString(root.resolve("docs/a.txt"))).isEqualTo("a");
    }

    @Test
    void namesThatAreOddButHonestStayInsideTheTree() throws Exception {
        // Not a step up, not hidden, not a lookalike: plain names the tools take, each landing inside the root.
        List<String> honest = List.of("%2e%2e", "..a", "a..", ".hidden", "~", "~root", "$HOME", "a b.txt", "日本語.txt",
                "emoji \u2764\uFE0F.txt", "Ünïcödé.txt", "a;rm -rf.txt", "'quoted'", "\"dq\"", "back`tick`", "*", "?",
                "con", "nul.txt", "x".repeat(255));
        for (String name : honest) {
            assertThat(run(new Call("files_write", args("path", "docs/" + name, "text", "t", "replace", false))))
                    .as(shown(name)).isNull();
            Path written = root.resolve("docs").resolve(name);
            assertThat(Files.isRegularFile(written, LinkOption.NOFOLLOW_LINKS)).as(shown(name)).isTrue();
            assertThat(written.toRealPath().startsWith(root.toRealPath())).as(shown(name)).isTrue();
        }
    }

    // ---------------------------------------------------------------- at random

    /** Pieces a path is made of at random: steps, separators, tricks and names, honest and not. */
    private static final List<String> PIECES = List.of("..", ".", "/", "//", "\\", "docs", "a.txt", "out", "up", "loop",
            "rel", "hard.txt", "pipe", ".trash", ".uploads", "secret.txt", "sub", "deep.txt", "\u0000", "\u202E",
            "\u200B", "\uFEFF", "\u2215", "\uFF0F", "\u2025", "\uFF0E", " ", "\u00A0", "\n", "e\u0301", "%2e", "~",
            "x", "new", "\uD800", "\uDC00", "\uFFFF", "\u3164", "日本", "C:", "\u2028", "\u0085");

    @Test
    void thousandsOfRandomPathsNeverReachOutsideTheTree() throws Exception {
        Snapshot before = Snapshot.of(outside);
        Random random = new Random(20261112L);
        int refusedPath = 0;
        int calls = 0;
        for (int n = 0; n < 2000; n++) {
            StringBuilder path = new StringBuilder();
            int parts = 1 + random.nextInt(6);
            for (int k = 0; k < parts; k++) {
                path.append(PIECES.get(random.nextInt(PIECES.size())));
            }
            String p = path.toString();
            for (Call c : callsWith(p)) {
                calls++;
                String look = look(c);
                String ran = run(c);
                if ("path".equals(ran)) {
                    refusedPath++;
                    assertThat(look).as("look %s %s", c.tool, shown(p)).isEqualTo("path");
                }
            }
        }
        assertThat(calls).isEqualTo(2000 * 9);
        assertThat(refusedPath).isGreaterThan(calls / 4);
        assertThat(Snapshot.of(outside)).isEqualTo(before);
        // Nothing the calls made is anywhere but under the root: every entry of the test's folder outside the rig is
        // the test's own.
        try (Stream<Path> s = Files.list(dir)) {
            assertThat(s.map(x -> x.getFileName().toString()).sorted().toList()).containsExactly("outside", "rig");
        }
        // No tool can make a link: the tree holds the five the test made (some perhaps in the trash), and no more.
        try (Stream<Path> s = Files.walk(root)) {
            assertThat(s.filter(Files::isSymbolicLink).count()).isEqualTo(5);
        }
    }

    // ---------------------------------------------------------------- helpers

    private record Call(String tool, Map<String, Object> args) {}

    /** Every tool with this path in each of its path arguments. */
    private static List<Call> callsWith(String path) {
        List<Call> calls = new ArrayList<>();
        calls.add(new Call("files_list", args("path", path)));
        calls.add(new Call("files_search", args("q", "a", "under", path)));
        calls.add(new Call("files_read", args("path", path)));
        calls.add(new Call("files_write", args("path", path, "text", "t", "replace", false)));
        calls.add(new Call("files_write", args("path", path, "text", "t", "replace", true)));
        calls.add(new Call("files_mkdir", args("path", path)));
        calls.add(new Call("files_trash", args("path", path)));
        calls.add(new Call("files_move", args("from", path, "to", "moved-" + Math.abs(path.hashCode()))));
        calls.add(new Call("files_move", args("from", "docs/a.txt", "to", path)));
        return calls;
    }

    private static Map<String, Object> args(Object... pairs) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            m.put((String) pairs[i], pairs[i + 1]);
        }
        return m;
    }

    private HostedCall hosted(Call c, boolean look) {
        return new HostedCall(1, "run-1", "ag-1", c.tool, c.args, null, look, Caller.THE_OWNER, null);
    }

    /** The look's refusal word, or null if the look passed. */
    private String look(Call c) {
        Throwable t = catchThrowable(() -> tools.look(hosted(c, true), run));
        return word(t);
    }

    /** The run's refusal word, or null if it ran. A move or write that ran is undone, so the tree stays as it was. */
    private String run(Call c) {
        Throwable t = catchThrowable(() -> tools.run(hosted(c, false), run));
        return word(t);
    }

    private static String word(Throwable t) {
        if (t == null) {
            return null;
        }
        assertThat(t).isInstanceOf(ToolFailure.class);
        ToolFailure f = (ToolFailure) t;
        // A refusal never carries a path, a name or content.
        assertThat(String.valueOf(f.getMessage())).doesNotContain("secret").doesNotContain("outside");
        return f.reason();
    }

    private static String shown(String s) {
        StringBuilder out = new StringBuilder();
        s.codePoints().forEach(cp -> out.append(cp < 0x20 || cp > 0x7e ? String.format("\\u{%x}", cp)
                : String.valueOf((char) cp)));
        return out.toString();
    }

    /** Every entry under a folder, links not followed, with each regular file's SHA-256 and each link's target. */
    private record Snapshot(Map<String, String> files) {
        static Snapshot of(Path top) throws IOException {
            Map<String, String> out = new TreeMap<>();
            try (Stream<Path> s = Files.walk(top)) {
                for (Path p : s.toList()) {
                    String key = top.relativize(p).toString();
                    if (Files.isSymbolicLink(p)) {
                        out.put(key, "link:" + Files.readSymbolicLink(p));
                    } else if (Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)) {
                        out.put(key, "file:" + sha(Files.readAllBytes(p)));
                    } else if (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) {
                        out.put(key, "dir");
                    } else {
                        out.put(key, "other");
                    }
                }
            }
            return new Snapshot(out);
        }

        private static String sha(byte[] bytes) {
            try {
                return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            } catch (java.security.NoSuchAlgorithmException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    @SuppressWarnings("unused")
    private static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
