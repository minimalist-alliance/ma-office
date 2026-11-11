package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The Files tools through {@link ToolHost}: its approval check, its looks, and the run's taint. */
@SuppressWarnings("unchecked")
class FilesToolsHostTest {

    @TempDir
    Path dir;

    private AgentFilesRig rig;
    private ToolHost host;
    private final AtomicReference<String> redeemed = new AtomicReference<>();

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentFilesRig(dir.resolve("rig"));
        host = new ToolHost(Clock.systemUTC(), ToolHost.ownerOnly(), () -> false, () -> true);
        host.area(HostedDecls.FILES, new FilesTools(rig.files().agentAccess()));
        host.tickets((approvalId, sha, agentId, runId, tool, context, args) -> {
            redeemed.set(approvalId + ":" + sha);
            return approvalId.startsWith("ap-ok") ? null : "approval_unknown";
        });
    }

    @AfterEach
    void tearDown() throws Exception {
        host.close();
        rig.close();
    }

    private static Map<String, Object> message(String tool, Map<String, Object> args, boolean look) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", 7);
        m.put("tool", tool);
        m.put("runId", "run-1");
        m.put("agentId", "ag-1");
        m.put("args", args);
        if (look) {
            m.put("phase", "look");
        }
        return m;
    }

    private static Map<String, Object> approved(Map<String, Object> message, String approvalId) {
        @SuppressWarnings("unchecked")
        Map<String, Object> args = (Map<String, Object>) message.get("args");
        String sha = ToolHost.hash("ag-1", "run-1", (String) message.get("tool"), "agent", args);
        Map<String, Object> approval = new LinkedHashMap<>();
        approval.put("approvalId", approvalId);
        approval.put("sha256", sha);
        Map<String, Object> m = new LinkedHashMap<>(message);
        m.put("approval", approval);
        return m;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    private static String sha(String text) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void aWriteWithoutAnApprovalIsForbidden() throws Exception {
        Map<String, Object> reply = host.handle(message("files_write", FilesToolsTest.args("path", "a.txt", "text", "t", "replace", false), false));
        assertThat(reply).containsEntry("t", "terr").containsEntry("code", "forbidden");
        assertThat(map(reply.get("details"))).containsEntry("reason", "approval_required");
        assertThat(rig.root().resolve("a.txt")).doesNotExist();
        for (Map<String, Object> m : List.of(
                message("files_mkdir", FilesToolsTest.args("path", "d"), false),
                message("files_trash", FilesToolsTest.args("path", "d"), false),
                message("files_move", FilesToolsTest.args("from", "a", "to", "b"), false))) {
            Map<String, Object> r = host.handle(m);
            assertThat(r.get("t")).isEqualTo("terr");
        }
        assertThat(rig.root().resolve("d")).doesNotExist();
    }

    @Test
    void aTrashWithoutAnApprovalIsForbidden() throws Exception {
        Files.writeString(rig.root().resolve("keep.txt"), "k");
        Map<String, Object> reply = host.handle(message("files_trash", FilesToolsTest.args("path", "keep.txt"), false));
        assertThat(reply).containsEntry("code", "forbidden");
        assertThat(map(reply.get("details"))).containsEntry("reason", "approval_required");
        assertThat(rig.root().resolve("keep.txt")).exists();
    }

    @Test
    void anApprovedWriteRunsOnce() throws Exception {
        Map<String, Object> m = message("files_write", FilesToolsTest.args("path", "a.txt", "text", "hello", "replace", false), false);
        Map<String, Object> reply = host.handle(approved(m, "ap-ok1"));
        assertThat(reply).containsEntry("t", "tres");
        assertThat(map(reply.get("r"))).containsEntry("risk", "write");
        assertThat(rig.root().resolve("a.txt")).hasContent("hello");
        assertThat(redeemed.get()).startsWith("ap-ok1:");
    }

    @Test
    void anApprovalTheLedgerDoesNotKnowOrOfAnotherPayloadRunsNothing() throws Exception {
        Map<String, Object> m = message("files_write", FilesToolsTest.args("path", "a.txt", "text", "hello", "replace", false), false);
        Map<String, Object> unknown = host.handle(approved(m, "ap-no1"));
        assertThat(unknown).containsEntry("code", "forbidden");
        assertThat(map(unknown.get("details"))).containsEntry("reason", "approval_unknown");
        Map<String, Object> other = message("files_write", FilesToolsTest.args("path", "a.txt", "text", "other", "replace", false), false);
        Map<String, Object> mismatched = new LinkedHashMap<>(other);
        mismatched.put("approval", approved(m, "ap-ok2").get("approval"));
        assertThat(map(host.handle(mismatched).get("details"))).containsEntry("reason", "approval_mismatch");
        assertThat(rig.root().resolve("a.txt")).doesNotExist();
    }

    @Test
    void aReplaceLookGivesTheBeforeAndTheApprovedRunReplacesIt() throws Exception {
        Files.writeString(rig.root().resolve("a.txt"), "old");
        Map<String, Object> args = FilesToolsTest.args("path", "a.txt", "text", "new", "replace", true);
        Map<String, Object> look = host.handle(message("files_write", args, true));
        assertThat(look).containsEntry("t", "tres");
        Map<String, Object> r = map(look.get("r"));
        assertThat(r).containsEntry("risk", "write").containsEntry("context", "agent");
        assertThat(map(r.get("before"))).containsEntry("sha256", sha("old")).containsEntry("bytes", 3L);
        assertThat(map(r.get("target"))).containsEntry("kind", "file").containsEntry("path", "a.txt");
        assertThat(map(r.get("payload"))).containsEntry("replace", true).containsEntry("text", "new");
        assertThat(rig.root().resolve("a.txt")).hasContent("old");

        Map<String, Object> done = host.handle(approved(message("files_write", map(r.get("payload")), false), "ap-ok3"));
        assertThat(done).containsEntry("t", "tres");
        assertThat(rig.root().resolve("a.txt")).hasContent("new");
        try (var s = Files.list(rig.root().resolve(".trash"))) {
            assertThat(s.count()).isEqualTo(1);
        }
    }

    @Test
    void aReplaceApprovedAfterTheFileChangedIsChanged() throws Exception {
        Files.writeString(rig.root().resolve("a.txt"), "old");
        Map<String, Object> args = FilesToolsTest.args("path", "a.txt", "text", "new", "replace", true);
        host.handle(message("files_write", args, true));
        Files.writeString(rig.root().resolve("a.txt"), "edited meanwhile");
        Map<String, Object> reply = host.handle(approved(message("files_write", args, false), "ap-ok4"));
        assertThat(reply).containsEntry("t", "terr").containsEntry("code", "conflict");
        assertThat(map(reply.get("details"))).containsEntry("reason", "changed");
        assertThat(rig.root().resolve("a.txt")).hasContent("edited meanwhile");
    }

    @Test
    void aWriteOfAFileThatIsThereIsRefusedAtTheLook() throws Exception {
        Files.writeString(rig.root().resolve("a.txt"), "old");
        Map<String, Object> reply = host.handle(message("files_write", FilesToolsTest.args("path", "a.txt", "text", "new", "replace", false), true));
        assertThat(reply).containsEntry("t", "terr");
        assertThat(map(reply.get("details"))).containsEntry("reason", "exists");
    }

    @Test
    void aTrashLookIsADeleteWithTheSizeBefore() throws Exception {
        Files.writeString(rig.root().resolve("a.txt"), "12345");
        Map<String, Object> reply = host.handle(message("files_trash", FilesToolsTest.args("path", "a.txt"), true));
        Map<String, Object> r = map(reply.get("r"));
        assertThat(r).containsEntry("risk", "delete");
        assertThat(map(r.get("before"))).containsEntry("bytes", 5L).containsEntry("dir", false);
        assertThat(rig.root().resolve("a.txt")).exists();
    }

    @Test
    void readingFilesAddsPrivateAndUntrustedToTheRun() throws Exception {
        Files.writeString(rig.root().resolve("a.txt"), "hello");
        Map<String, Object> reply = host.handle(message("files_read", FilesToolsTest.args("path", "a.txt"), false));
        assertThat(reply).containsEntry("t", "tres");
        Map<String, Object> r = map(reply.get("r"));
        assertThat(r).containsEntry("risk", "read");
        assertThat(map(r.get("content"))).containsEntry("text", "hello");
        assertThat((List<Object>) r.get("taints")).containsExactlyInAnyOrder("S", "U");
        assertThat((List<Object>) reply.get("taint")).contains("S", "U");
    }

    @Test
    void listingAddsPrivateButNotUntrusted() throws Exception {
        Map<String, Object> reply = host.handle(message("files_list", FilesToolsTest.args("path", ""), false));
        assertThat((List<Object>) reply.get("taint")).containsExactly("S");
    }

    @Test
    void theFilesToolsAreOfferedWhileTheTreeIsUsable() throws Exception {
        assertThat(host.offered()).contains("files_read", "files_write", "files_trash");
    }
}
