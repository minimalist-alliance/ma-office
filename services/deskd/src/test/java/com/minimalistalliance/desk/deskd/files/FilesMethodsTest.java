package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FilesMethodsTest {

    @TempDir
    Path dir;

    FilesRig rig;
    TestClient owner;

    @BeforeEach
    void setUp() throws Exception {
        rig = new FilesRig(dir);
        owner = rig.owner("s-1");
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> entries(Map<String, Object> reply) {
        return (List<Map<String, Object>>) reply.get("entries");
    }

    private static List<String> names(Map<String, Object> reply) {
        return entries(reply).stream().map(e -> (String) e.get("name")).toList();
    }

    private static byte[] text(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    // ---- who may

    @Test
    void anExportSessionGetsForbiddenOnEveryFilesMethod() throws Exception {
        TestClient export = rig.export("s-export");
        for (String m : List.of("files.list", "files.stat", "files.usage", "files.mkdir", "files.delete", "files.upload.begin", "files.read", "files.nothing")) {
            Map<String, Object> reply = rig.call(export, m, "path", "a");
            assertThat(reply).as(m).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat((Map<String, Object>) reply.get("details")).containsEntry("reason", "scope");
        }
    }

    @Test
    void aGuildMemberSessionGetsForbiddenOnEveryFilesMethodAndTheTopic() throws Exception {
        rig.guild.set(true);
        TestClient member = rig.member("s-member");
        for (String m : List.of("files.list", "files.stat", "files.usage", "files.mkdir", "files.upload.begin", "files.read")) {
            Map<String, Object> reply = rig.call(member, m, "path", "a");
            assertThat(reply).as(m).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat((Map<String, Object>) reply.get("details")).containsEntry("reason", "scope");
        }
        member.sendJson(Channels.RPC, FrameKind.SUB, 5, Map.of("topic", "files.changes", "params", Map.of()));
        assertThat(member.nextReply()).containsEntry("code", "forbidden");
    }

    @Test
    void aGuildDeskAnswersForbiddenToTheOwner() throws Exception {
        rig.guild.set(true);
        Map<String, Object> reply = rig.err(owner, "forbidden", "files.list", "path", "");
        assertThat((Map<String, Object>) reply.get("details")).containsEntry("reason", "scope");
        rig.err(owner, "forbidden", "files.upload.begin", "path", "a", "size", 1L);
    }

    // ---- list and stat

    @Test
    void listPagesAndSortsAndCountsWhatItSkips() throws Exception {
        rig.file("Zed/x", text("1"));
        rig.file("alpha/x", text("1"));
        rig.file("b.txt", text("bb"));
        rig.file("A.txt", text("a"));
        Files.createSymbolicLink(rig.root.resolve("link"), Path.of("b.txt"));
        Map<String, Object> all = rig.ok(owner, "files.list", "path", "");
        assertThat(names(all)).containsExactly("alpha", "Zed", "A.txt", "b.txt");
        assertThat(all).containsEntry("next", null).containsEntry("skipped", 1);
        Map<String, Object> entry = entries(all).get(2);
        assertThat(entry).containsEntry("type", "file").containsEntry("size", 1);
        assertThat(entries(all).get(0)).containsEntry("type", "dir").containsEntry("size", null);
        assertThat(entry.get("mtimeMs")).isInstanceOf(Number.class);

        Map<String, Object> first = rig.ok(owner, "files.list", "path", "", "limit", 3L);
        assertThat(names(first)).containsExactly("alpha", "Zed", "A.txt");
        Map<String, Object> second = rig.ok(owner, "files.list", "path", "", "limit", 3L, "cursor", first.get("next"));
        assertThat(names(second)).containsExactly("b.txt");
        assertThat(second).containsEntry("next", null);
    }

    @Test
    void listRefusesWhatItShould() throws Exception {
        rig.file("f.txt", text("x"));
        rig.err(owner, "not_found", "files.list", "path", "nope");
        Map<String, Object> notDir = rig.err(owner, "invalid", "files.list", "path", "f.txt");
        assertThat((Map<String, Object>) notDir.get("details")).containsEntry("reason", "not_a_folder");
        Map<String, Object> bad = rig.err(owner, "invalid", "files.list", "path", "../x");
        assertThat((Map<String, Object>) bad.get("details")).containsEntry("reason", "dots");
        Map<String, Object> reserved = rig.err(owner, "invalid", "files.list", "path", ".trash");
        assertThat((Map<String, Object>) reserved.get("details")).containsEntry("reason", "reserved");
        rig.err(owner, "invalid", "files.list", "path", "", "cursor", "!!!");
        rig.err(owner, "bad_request", "files.list", "path", "", "limit", 0L);
        rig.err(owner, "bad_request", "files.list", "path", "", "limit", 5000L);
    }

    @Test
    void theRootNeverShowsTheTwoReservedFolders() throws Exception {
        rig.ok(owner, "files.mkdir", "path", "a");
        assertThat(names(rig.ok(owner, "files.list", "path", ""))).containsExactly("a");
        rig.err(owner, "invalid", "files.mkdir", "path", ".uploads");
        rig.err(owner, "invalid", "files.rename", "from", "a", "to", ".trash");
        rig.err(owner, "invalid", "files.stat", "path", ".uploads");
    }

    @Test
    void statSaysWhatAFileIsByItsBytesNotItsName() throws Exception {
        rig.file("photo.dat", new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 16});
        rig.file("notes.jpg", text("just words"));
        rig.file("pic.svg.txt", text("<svg xmlns='http://www.w3.org/2000/svg'/>"));
        rig.file("empty", new byte[0]);
        Map<String, Object> dat = rig.ok(owner, "files.stat", "path", "photo.dat");
        assertThat((Map<String, Object>) dat.get("sniff")).isEqualTo(Map.of("kind", "image", "format", "jpeg"));
        assertThat((Map<String, Object>) rig.ok(owner, "files.stat", "path", "notes.jpg").get("sniff")).isEqualTo(Map.of("kind", "other"));
        assertThat((Map<String, Object>) rig.ok(owner, "files.stat", "path", "pic.svg.txt").get("sniff")).isEqualTo(Map.of("kind", "image", "format", "svg"));
        assertThat((Map<String, Object>) rig.ok(owner, "files.stat", "path", "empty").get("sniff")).isEqualTo(Map.of("kind", "other"));
        Map<String, Object> root = rig.ok(owner, "files.stat", "path", "");
        assertThat((Map<String, Object>) root.get("entry")).containsEntry("name", "").containsEntry("type", "dir").containsEntry("size", null);
        assertThat(root.get("sniff")).isNull();
        rig.err(owner, "not_found", "files.stat", "path", "missing");
    }

    // ---- mkdir and rename

    @Test
    void mkdirMakesOneFolderOrTheWholeWay() throws Exception {
        assertThat(rig.ok(owner, "files.mkdir", "path", "a")).containsEntry("created", true);
        Map<String, Object> taken = rig.err(owner, "exists", "files.mkdir", "path", "a");
        assertThat((Map<String, Object>) taken.get("details")).containsEntry("kind", "dir");
        rig.err(owner, "not_found", "files.mkdir", "path", "x/y");
        assertThat(rig.ok(owner, "files.mkdir", "path", "x/y/z", "parents", true)).containsEntry("created", true);
        assertThat(rig.ok(owner, "files.mkdir", "path", "x/y/z", "parents", true)).containsEntry("created", false);
        rig.file("f", text("x"));
        Map<String, Object> onFile = rig.err(owner, "invalid", "files.mkdir", "path", "f/inside", "parents", true);
        assertThat((Map<String, Object>) onFile.get("details")).containsEntry("reason", "not_a_folder");
        Map<String, Object> over = rig.err(owner, "exists", "files.mkdir", "path", "f", "parents", true);
        assertThat((Map<String, Object>) over.get("details")).containsEntry("kind", "file");
        assertThat(Files.isDirectory(rig.root.resolve("x/y/z"))).isTrue();
    }

    @Test
    void renameMovesAndRefusesToOverwriteUnlessToldTo() throws Exception {
        rig.file("a.txt", text("first"));
        rig.file("b.txt", text("second"));
        rig.ok(owner, "files.mkdir", "path", "dir");
        Map<String, Object> moved = rig.ok(owner, "files.rename", "from", "a.txt", "to", "dir/a.txt");
        assertThat(moved).containsEntry("path", "dir/a.txt").containsEntry("replaced", null);
        assertThat(Files.readString(rig.root.resolve("dir/a.txt"))).isEqualTo("first");
        Map<String, Object> taken = rig.err(owner, "exists", "files.rename", "from", "dir/a.txt", "to", "b.txt");
        assertThat((Map<String, Object>) taken.get("details")).containsEntry("kind", "file");
        Map<String, Object> replaced = rig.ok(owner, "files.rename", "from", "dir/a.txt", "to", "b.txt", "replace", true);
        assertThat(replaced.get("replaced")).isInstanceOf(String.class);
        assertThat(Files.readString(rig.root.resolve("b.txt"))).isEqualTo("first");
        // The old b.txt is in the trash, not gone.
        Map<String, Object> bin = rig.ok(owner, "files.trash.list");
        List<?> items = (List<?>) bin.get("items");
        assertThat(items).hasSize(1);
        assertThat((Map<String, Object>) items.get(0)).containsEntry("originalPath", "b.txt").containsEntry("bytes", 6);
        // Same path: nothing happens.
        assertThat(rig.ok(owner, "files.rename", "from", "b.txt", "to", "b.txt")).containsEntry("replaced", null);
    }

    @Test
    void renameKeepsFoldersAndFilesApart() throws Exception {
        rig.file("d/x", text("1"));
        rig.file("e/y", text("1"));
        rig.file("f.txt", text("1"));
        Map<String, Object> intoSelf = rig.err(owner, "invalid", "files.rename", "from", "d", "to", "d/sub");
        assertThat((Map<String, Object>) intoSelf.get("details")).containsEntry("reason", "into_self");
        rig.err(owner, "exists", "files.rename", "from", "d", "to", "e", "replace", true);
        rig.err(owner, "exists", "files.rename", "from", "f.txt", "to", "e", "replace", true);
        rig.err(owner, "exists", "files.rename", "from", "d", "to", "f.txt", "replace", true);
        rig.err(owner, "not_found", "files.rename", "from", "ghost", "to", "g");
        rig.err(owner, "not_found", "files.rename", "from", "f.txt", "to", "nodir/f.txt");
        Map<String, Object> viaFile = rig.err(owner, "invalid", "files.rename", "from", "d", "to", "f.txt/inner");
        assertThat((Map<String, Object>) viaFile.get("details")).containsEntry("reason", "not_a_folder");
        assertThat(rig.ok(owner, "files.rename", "from", "d", "to", "renamed")).containsEntry("path", "renamed");
        assertThat(Files.exists(rig.root.resolve("renamed/x"))).isTrue();
    }

    // ---- delete and the trash

    @Test
    void deleteGoesToTheTrashAndRestoreBringsItBack() throws Exception {
        rig.file("docs/a.txt", text("12345"));
        rig.file("docs/b.txt", text("67"));
        Map<String, Object> deleted = rig.ok(owner, "files.delete", "paths", List.of("docs", "ghost", "docs/a.txt"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> results = (List<Map<String, Object>>) deleted.get("results");
        assertThat(results.get(0)).containsEntry("ok", true).containsKey("trashId");
        assertThat(results.get(1)).containsEntry("ok", false).containsEntry("code", "not_found");
        assertThat(results.get(2)).containsEntry("ok", false).containsEntry("code", "not_found");
        assertThat(((String) results.get(0).get("trashId"))).hasSize(26).matches("[0-9A-Za-z]{26}");
        assertThat(Files.exists(rig.root.resolve("docs"))).isFalse();

        Map<String, Object> bin = rig.ok(owner, "files.trash.list");
        @SuppressWarnings("unchecked")
        Map<String, Object> item = ((List<Map<String, Object>>) bin.get("items")).get(0);
        assertThat(item).containsEntry("originalPath", "docs").containsEntry("name", "docs").containsEntry("type", "dir").containsEntry("bytes", 7);
        assertThat(java.time.Instant.parse((String) item.get("purgeAt"))).isEqualTo(java.time.Instant.parse((String) item.get("deletedAt")).plus(Duration.ofDays(30)));

        Map<String, Object> usage = rig.ok(owner, "files.usage");
        assertThat((Map<String, Object>) usage.get("trash")).containsEntry("bytes", 7).containsEntry("items", 1);

        assertThat(rig.ok(owner, "files.trash.restore", "id", item.get("id"))).containsEntry("path", "docs");
        assertThat(Files.readString(rig.root.resolve("docs/a.txt"))).isEqualTo("12345");
        assertThat((List<?>) rig.ok(owner, "files.trash.list").get("items")).isEmpty();
    }

    @Test
    void restoreIntoATakenNameSuggestsAFreeOne() throws Exception {
        rig.file("a.txt", text("old"));
        String id = (String) ((Map<String, Object>) ((List<?>) rig.ok(owner, "files.delete", "paths", List.of("a.txt")).get("results")).get(0)).get("trashId");
        rig.file("a.txt", text("new"));
        Map<String, Object> taken = rig.err(owner, "exists", "files.trash.restore", "id", id);
        assertThat((Map<String, Object>) taken.get("details")).containsEntry("kind", "file").containsEntry("suggest", "a (restored).txt");
        assertThat(rig.ok(owner, "files.trash.restore", "id", id, "to", "a (restored).txt")).containsEntry("path", "a (restored).txt");
        rig.err(owner, "not_found", "files.trash.restore", "id", id);
        rig.err(owner, "bad_request", "files.trash.restore", "id", "short");
    }

    @Test
    void restoreMakesTheMissingFoldersOnTheWay() throws Exception {
        rig.file("p/q/r.txt", text("x"));
        String id = (String) ((Map<String, Object>) ((List<?>) rig.ok(owner, "files.delete", "paths", List.of("p/q/r.txt")).get("results")).get(0)).get("trashId");
        rig.ok(owner, "files.delete", "paths", List.of("p"));
        assertThat(rig.ok(owner, "files.trash.restore", "id", id)).containsEntry("path", "p/q/r.txt");
        assertThat(Files.readString(rig.root.resolve("p/q/r.txt"))).isEqualTo("x");
    }

    @Test
    void permanentDeleteIsOnlyForTrashIds() throws Exception {
        rig.file("a.txt", text("x"));
        rig.file("b.txt", text("y"));
        String id = (String) ((Map<String, Object>) ((List<?>) rig.ok(owner, "files.delete", "paths", List.of("a.txt")).get("results")).get(0)).get("trashId");
        Map<String, Object> real = rig.err(owner, "invalid", "files.delete", "paths", List.of("b.txt"), "permanent", true);
        assertThat((Map<String, Object>) real.get("details")).containsEntry("reason", "permanent");
        rig.err(owner, "invalid", "files.delete", "paths", List.of("trash:" + id));
        Map<String, Object> done = rig.ok(owner, "files.delete", "paths", List.of("trash:" + id, "trash:" + "0".repeat(26)), "permanent", true);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> results = (List<Map<String, Object>>) done.get("results");
        assertThat(results.get(0)).containsEntry("ok", true);
        assertThat(results.get(1)).containsEntry("ok", false).containsEntry("code", "not_found");
        assertThat((List<?>) rig.ok(owner, "files.trash.list").get("items")).isEmpty();
        assertThat(Files.exists(rig.root.resolve("b.txt"))).isTrue();
        rig.err(owner, "invalid", "files.delete", "paths", List.of(""));
        rig.err(owner, "bad_request", "files.delete", "paths", List.of());
    }

    @Test
    void emptyTheTrashDeletesEverythingAndSaysHowMuch() throws Exception {
        rig.file("a", text("12345"));
        rig.file("b/c", text("123"));
        rig.ok(owner, "files.delete", "paths", List.of("a", "b"));
        Map<String, Object> done = rig.ok(owner, "files.trash.empty");
        assertThat(done).containsEntry("deleted", 2).containsEntry("freedBytes", 8);
        assertThat(rig.partials()).isEmpty();
        assertThat(Files.list(rig.root.resolve(".trash")).count()).isZero();
    }

    @Test
    void theTrashPagesNewestFirst() throws Exception {
        for (int i = 0; i < 5; i++) {
            rig.file("f" + i, text("x"));
            rig.ok(owner, "files.delete", "paths", List.of("f" + i));
            rig.clock.advance(Duration.ofSeconds(1));
            Thread.sleep(2);
        }
        Map<String, Object> first = rig.ok(owner, "files.trash.list", "limit", 2L);
        assertThat((List<?>) first.get("items")).hasSize(2);
        assertThat(first.get("next")).isNotNull();
        Map<String, Object> second = rig.ok(owner, "files.trash.list", "limit", 5L, "cursor", first.get("next"));
        assertThat((List<?>) second.get("items")).hasSize(3);
        assertThat(second.get("next")).isNull();
    }

    @Test
    void trashOlderThanThirtyDaysIsSweptAndTheRestStays() throws Exception {
        rig.file("old", text("x"));
        rig.ok(owner, "files.delete", "paths", List.of("old"));
        rig.clock.advance(Duration.ofDays(29));
        rig.file("young", text("y"));
        rig.ok(owner, "files.delete", "paths", List.of("young"));
        rig.clock.advance(Duration.ofDays(2));
        rig.files.sweep();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) rig.ok(owner, "files.trash.list").get("items");
        assertThat(items).hasSize(1);
        assertThat(items.get(0)).containsEntry("originalPath", "young");
    }

    // ---- search

    @Test
    void searchFindsByNameCaseInsensitivelyFoldersFirstThenShallow() throws Exception {
        rig.file("Report.txt", text("1"));
        rig.file("deep/er/report-final.txt", text("1"));
        rig.file("a/REPORTS/x", text("1"));
        rig.file("other.txt", text("1"));
        rig.file(".trash/zz/report", text("1"));
        Map<String, Object> hits = rig.ok(owner, "files.search", "q", "report");
        assertThat(entries(hits).stream().map(e -> e.get("path")).toList())
                .containsExactly("a/REPORTS", "Report.txt", "deep/er/report-final.txt");
        assertThat(hits).containsEntry("truncated", false);
        assertThat(entries(hits).get(0)).containsEntry("type", "dir").containsEntry("name", "REPORTS");
        Map<String, Object> under = rig.ok(owner, "files.search", "q", "report", "under", "deep");
        assertThat(names(under)).containsExactly("report-final.txt");
        assertThat(entries(rig.ok(owner, "files.search", "q", "report", "limit", 1L))).hasSize(1);
        rig.err(owner, "bad_request", "files.search", "q", "");
        rig.err(owner, "bad_request", "files.search", "q", "x", "limit", 201L);
        rig.err(owner, "not_found", "files.search", "q", "x", "under", "nowhere");
    }

    // ---- usage

    @Test
    void usageSeparatesFilesTrashAndTheDrive() throws Exception {
        rig.file("a", text("12345"));
        rig.file("b", text("678"));
        rig.ok(owner, "files.delete", "paths", List.of("b"));
        rig.freeBytes.set(10L * 1024 * 1024 * 1024);
        Map<String, Object> u = rig.ok(owner, "files.usage");
        assertThat((Map<String, Object>) u.get("files")).containsEntry("bytes", 5).containsEntry("approx", false);
        assertThat((Map<String, Object>) u.get("trash")).containsEntry("bytes", 3).containsEntry("items", 1);
        assertThat((Map<String, Object>) u.get("drive")).containsEntry("freeBytes", 10L * 1024 * 1024 * 1024);
        assertThat(u).containsEntry("floorBytes", 2147483648L).containsEntry("uploadableBytes", 8L * 1024 * 1024 * 1024);
        assertThat(u.get("computedAt")).isInstanceOf(String.class);
        // A second answer inside a minute is the first, marked approximate.
        rig.file("c", text("123456789"));
        assertThat((Map<String, Object>) rig.ok(owner, "files.usage").get("files")).containsEntry("bytes", 5).containsEntry("approx", true);
        rig.clock.advance(Duration.ofSeconds(61));
        assertThat((Map<String, Object>) rig.ok(owner, "files.usage").get("files")).containsEntry("bytes", 14).containsEntry("approx", false);
    }

    // ---- idempotence, tabs, topic

    @Test
    void aRetryWithTheSameKeyGetsTheSameReplyAndDoesNothingTwice() throws Exception {
        rig.file("a.txt", text("x"));
        String key = UUID.randomUUID().toString();
        Map<String, Object> first = rig.callWith(owner, "files.delete", key, FilesRig.params("paths", List.of("a.txt")));
        rig.file("a.txt", text("again"));
        Map<String, Object> second = rig.callWith(owner, "files.delete", key, FilesRig.params("paths", List.of("a.txt")));
        assertThat(second.get("results")).isEqualTo(first.get("results"));
        assertThat(Files.readString(rig.root.resolve("a.txt"))).isEqualTo("again");
        Map<String, Object> noKey = rig.callWith(owner, "files.mkdir", null, FilesRig.params("path", "z"));
        assertThat(noKey).containsEntry("_kind", "ERR");
    }

    @Test
    void twoTabsCantInterleaveARenameAndAnExistsCheck() throws Exception {
        TestClient second = rig.owner("s-2");
        rig.file("a", text("1"));
        rig.file("b", text("2"));
        long one = rig.send(owner, "files.rename", FilesRig.params("from", "a", "to", "c"), UUID.randomUUID().toString());
        long two = rig.send(second, "files.rename", FilesRig.params("from", "b", "to", "c"), UUID.randomUUID().toString());
        Map<String, Object> r1 = owner.nextReply();
        Map<String, Object> r2 = second.nextReply();
        assertThat(r1.get("_id")).isEqualTo(one);
        assertThat(r2.get("_id")).isEqualTo(two);
        assertThat(List.of((String) r1.get("_kind"), (String) r2.get("_kind"))).containsExactlyInAnyOrder("RES", "ERR");
        assertThat(Files.exists(rig.root.resolve("c"))).isTrue();
        assertThat(Files.exists(rig.root.resolve("a")) ^ Files.exists(rig.root.resolve("b"))).isTrue();
    }

    @Test
    void theChangesTopicSnapshotsEmptyThenTellsWhichFoldersChanged() throws Exception {
        long id = 77;
        owner.sendJson(Channels.RPC, FrameKind.SUB, id, Map.of("topic", "files.changes", "params", Map.of()));
        Map<String, Object> reply = owner.nextReply();
        assertThat(reply).containsEntry("_kind", "RES");
        rig.ok(owner, "files.mkdir", "path", "x");
        rig.ok(owner, "files.mkdir", "path", "x/y");
        await().atMost(Duration.ofSeconds(5)).until(() -> {
            var frame = owner.next(Channels.EVENTS);
            return frame.kind() == FrameKind.EVT && new String(frame.payload(), StandardCharsets.UTF_8).contains("\"dirs\"");
        });
    }
}
