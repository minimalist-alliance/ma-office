package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.notebook.NotebookCalls;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.tools.FilesTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.NotebookTools;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * W7's harness, deskd's half (Maia Mode Phase 0): §10's threats that deskd itself checks (3 and 17; the Browser's 7,
 * 13 and 14 are {@code tools/ThreatsDeskdBrowserTest}), and the fault matrix's deskd faults against the real
 * {@link ToolHost}, the real tickets and the real Files tools on a real tree: deskd restarted between the yes and the
 * call, the Files tree away, its disk full, the Notebook service gone. Each must end as a clean refusal, with nothing
 * written, nothing run twice, and no hang.
 */
@SuppressWarnings("unchecked")
class HarnessDeskdTest {

    private static final String AGENT = "ag-3k9x0d2m4q1z";
    private static final String RUN = "run-h1";

    @TempDir
    Path dir;

    private AgentRig rig;
    private AgentFilesRig files;
    private ToolHost host;
    private TestClient owner;
    private final BlockingQueue<Map<String, Object>> replies = new LinkedBlockingQueue<>();
    private long nextCall = 1;
    private int nextApproval;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentRig(Files.createDirectories(dir.resolve("agent")));
        rig.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of()));
        rig.agent.handlers.put("agent.approval.decide", p -> Map.of("approval", Map.of("id", p.get("approvalId"),
                "state", Boolean.TRUE.equals(p.get("approve")) ? "approved" : "declined")));
        files = new AgentFilesRig(dir.resolve("files"));
        host = wiredHost(rig.module.approvalTickets());
        owner = rig.connect("cs-1");
    }

    @AfterEach
    void tearDown() throws Exception {
        host.close();
        files.close();
        rig.close();
    }

    private ToolHost wiredHost(ApprovalTickets tickets) {
        ToolHost h = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
        h.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
            var redeemed = tickets.redeem(approvalId, sha256, agentId, runId, tool, context, args);
            return redeemed.ok() ? null : redeemed.refusal().code();
        });
        h.area(HostedDecls.FILES, new FilesTools(files.files().agentAccess()));
        return h;
    }

    private Map<String, Object> tcall(String tool, Map<String, Object> args, Map<String, Object> approval)
            throws InterruptedException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", nextCall++);
        m.put("tool", tool);
        m.put("runId", RUN);
        m.put("agentId", AGENT);
        m.put("args", args);
        m.put("taint", List.of());
        if (approval != null) {
            m.put("approval", approval);
            m.put("context", "agent");
        }
        host.onCall(m, replies::add);
        Map<String, Object> reply = replies.poll(10, TimeUnit.SECONDS);
        assertThat(reply).as("an answer to %s within 10 s", tool).isNotNull();
        return reply;
    }

    private Map<String, Object> approve(TestClient session, String tool, Map<String, Object> payload) throws Exception {
        String id = "ap-" + base32(nextApproval++);
        String sha = ToolHost.hash(AGENT, RUN, tool, "agent", payload);
        rig.call(session, "agent.approval.decide", Map.of("approvalId", id, "approve", true, "sha256", sha));
        return Map.of("approvalId", id, "sha256", sha);
    }

    private static String base32(int n) {
        String alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        StringBuilder out = new StringBuilder();
        long v = n + 1000;
        for (int i = 0; i < 20; i++) {
            out.append(alphabet.charAt((int) (v & 31)));
            v >>= 5;
        }
        return out.toString();
    }

    private static Map<String, Object> args(Object... pairs) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            m.put((String) pairs[i], pairs[i + 1]);
        }
        return m;
    }

    private static String reason(Map<String, Object> reply) {
        assertThat(reply).containsEntry("t", "terr");
        return (String) ((Map<String, Object>) reply.get("details")).get("reason");
    }

    private long visible() throws Exception {
        try (Stream<Path> s = Files.walk(files.root())) {
            return s.filter(p -> !p.equals(files.root()) && !files.root().relativize(p).toString().startsWith("."))
                    .count();
        }
    }

    // ---------------------------------------------------------------- §10's threats deskd checks

    @Test
    void t03DeskAgentCantApproveItselfAYesDeskdNeverRelayedOrOneFromASessionWithoutInputRunsNothing()
            throws Exception {
        Map<String, Object> payload = args("path", "self.md", "text", "x", "replace", false);
        String sha = ToolHost.hash(AGENT, RUN, "files_write", "agent", payload);
        // desk-agent names an approval and the right hash, but no member's yes came through deskd.
        assertThat(reason(tcall("files_write", payload, Map.of("approvalId", "ap-" + base32(77), "sha256", sha))))
                .isEqualTo("approval_unknown");
        // A session without input can't decide; deskd refuses it, makes no ticket, and desk-agent never hears.
        String fingerprint = String.format("%02x", 1 + 16).repeat(32);
        TestClient viewer = rig.connect("cs-v", new SessionGrant("user-1", "sid-v", "owner", fingerprint, true, false,
                Instant.now(), Instant.now().plus(Duration.ofHours(1))));
        Map<String, Object> refused = rig.call(viewer, "agent.approval.decide", Map.of("approvalId", "ap-" + base32(78),
                "approve", true, "sha256", sha));
        assertThat(refused).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
        assertThat(reason(tcall("files_write", payload, Map.of("approvalId", "ap-" + base32(78), "sha256", sha))))
                .isEqualTo("approval_unknown");
        // Without any approval, a write is never run.
        assertThat(reason(tcall("files_write", payload, null))).isEqualTo("approval_required");
        assertThat(files.root().resolve("self.md")).doesNotExist();
    }

    @Test
    void t17DeskAgentClaimingAutoWithoutDeskdsOwnRecordRunsNothing() throws Exception {
        for (String tool : List.of("files_write", "files_mkdir")) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("t", "tcall");
            m.put("id", nextCall++);
            m.put("tool", tool);
            m.put("runId", RUN);
            m.put("agentId", AGENT);
            m.put("args", tool.equals("files_write") ? args("path", "auto.md", "text", "x", "replace", false)
                    : args("path", "autodir"));
            m.put("taint", List.of());
            m.put("auto", "files");
            m.put("autoApprovalId", "ap-" + base32(500 + (int) nextCall));
            host.onCall(m, replies::add);
            assertThat(reason(replies.poll(10, TimeUnit.SECONDS))).as(tool).isEqualTo("approval_unknown");
        }
        assertThat(visible()).isZero();
    }

    // ---------------------------------------------------------------- deskd's faults, on the real tools

    @Test
    void deskdRestartedBetweenTheYesAndTheCallRunsNoneOfTheFilesWritesAndAsksAgain() throws Exception {
        Files.writeString(files.root().resolve("a.md"), "a");
        List<Map.Entry<String, Map<String, Object>>> calls = List.of(
                Map.entry("files_write", args("path", "w.md", "text", "x", "replace", false)),
                Map.entry("files_mkdir", args("path", "d")),
                Map.entry("files_move", args("from", "a.md", "to", "b.md")),
                Map.entry("files_trash", args("path", "a.md")));
        Map<String, Map<String, Object>> yeses = new LinkedHashMap<>();
        for (var c : calls) {
            yeses.put(c.getKey(), approve(owner, c.getKey(), c.getValue()));
        }
        host.close();
        host = wiredHost(new ApprovalTickets(rig.clock));
        for (var c : calls) {
            assertThat(reason(tcall(c.getKey(), c.getValue(), yeses.get(c.getKey())))).as(c.getKey())
                    .isEqualTo("approval_unknown");
        }
        assertThat(files.root().resolve("a.md")).hasContent("a");
        assertThat(visible()).isEqualTo(1);
    }

    @Test
    void theFilesTreeMovedAwayUnderDeskdNeverLosesAWriteWhatTheReplySaysIsWhatHappened() throws Exception {
        Files.writeString(files.root().resolve("keep.md"), "k");
        Path away = dir.resolve("files-away");
        // The tree goes from under deskd (a lazy unmount looks the same): deskd keeps the tree it opened.
        Files.move(files.root(), away);
        Map<String, Object> reply;
        try {
            for (var c : List.of(Map.entry("files_list", args("path", "")), Map.entry("files_read",
                    args("path", "keep.md")), Map.entry("files_search", args("q", "keep")))) {
                assertThat(tcall(c.getKey(), c.getValue(), null).get("t")).as(c.getKey()).isIn("terr", "tres");
            }
            Map<String, Object> payload = args("path", "new.md", "text", "x", "replace", false);
            reply = tcall("files_write", payload, approve(owner, "files_write", payload));
        } finally {
            Files.move(away, files.root());
        }
        // 0 silent losses: a write deskd said it saved is in the tree it held, now back; one it refused isn't anywhere.
        if ("tres".equals(reply.get("t"))) {
            assertThat(files.root().resolve("new.md")).hasContent("x");
        } else {
            assertThat(files.root().resolve("new.md")).doesNotExist();
        }
        assertThat(files.root().resolve("keep.md")).hasContent("k");
        Map<String, Object> payload = args("path", "new2.md", "text", "y", "replace", false);
        assertThat(tcall("files_write", payload, approve(owner, "files_write", payload))).containsEntry("t", "tres");
    }

    @Test
    void aFullDiskRefusesAWriteNoSpaceWritesNothingAndATrashStillWorks() throws Exception {
        Files.writeString(files.root().resolve("old.md"), "o");
        files.free(0);
        Map<String, Object> payload = args("path", "big.md", "text", "x".repeat(4096), "replace", false);
        assertThat(reason(tcall("files_write", payload, approve(owner, "files_write", payload))))
                .isEqualTo("no_space");
        assertThat(files.root().resolve("big.md")).doesNotExist();
        // Moving to the trash frees space and must still work when the disk is full.
        Map<String, Object> trash = args("path", "old.md");
        assertThat(tcall("files_trash", trash, approve(owner, "files_trash", trash))).containsEntry("t", "tres");
        assertThat(files.root().resolve("old.md")).doesNotExist();
    }

    @Test
    void theNotebookServiceGoneIsAPromptRefusalForEveryNotebookToolNotAHang() throws Exception {
        host.area(HostedDecls.NOTEBOOK, new NotebookTools(new NotebookCalls(dir.resolve("no-notebook.sock"),
                () -> null, Duration.ofSeconds(2)), () -> false));
        long start = System.nanoTime();
        for (var c : List.of(Map.entry("notebook_list", args()), Map.entry("notebook_search", args("query", "x")),
                Map.entry("notebook_read", args("pageId", "p-1")))) {
            Map<String, Object> reply = tcall(c.getKey(), c.getValue(), null);
            assertThat(reply).as(c.getKey()).containsEntry("t", "terr");
        }
        Map<String, Object> payload = args("new", args("tabId", "tab-1", "title", "T"), "op", "create", "markdown",
                "x");
        Map<String, Object> reply = tcall("notebook_write", payload, null);
        assertThat(reply).containsEntry("t", "terr");
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(15));
    }
}
