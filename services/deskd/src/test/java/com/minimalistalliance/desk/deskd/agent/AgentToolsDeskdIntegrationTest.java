package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.tools.FilesTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
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
 * deskd's half of an approved Files call, end to end inside deskd (draft ADR "the Agent's tools and approvals", section 3,
 * "deskd checks again"; API.md section 18): the member's yes relayed from their own session through {@link AgentMethods}
 * to a fake desk-agent on a real socket, which makes deskd's own ticket; then desk-agent's {@code tcall} through the real
 * {@link ToolHost}, wired as {@code DataPlaneConfiguration} wires it, to the real Files tools on a real tree. What runs,
 * what's refused and why: a replay, a changed payload, a ticket lost with a deskd restart, one past its 10 minutes, a file
 * that changed since the card was shown, and many copies of one approved call at once.
 */
@SuppressWarnings("unchecked")
class AgentToolsDeskdIntegrationTest {

    private static final String AGENT = "ag-3k9x0d2m4q1z";
    private static final String RUN = "run-7";

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
        // desk-agent says yes to every decision, as it does for a pending card whose hash matches.
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

    /** As {@code DataPlaneConfiguration.toolHost} wires it, on a personal desk, over these tickets. */
    private ToolHost wiredHost(ApprovalTickets tickets) {
        ToolHost h = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
        h.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
            var redeemed = tickets.redeem(approvalId, sha256, agentId, runId, tool, context, args);
            return redeemed.ok() ? null : redeemed.refusal().code();
        });
        h.area(HostedDecls.FILES, new FilesTools(files.files().agentAccess()));
        return h;
    }

    // ---------------------------------------------------------------- helpers

    private Map<String, Object> tcall(ToolHost on, String tool, Map<String, Object> args, boolean look,
            Map<String, Object> approval) throws InterruptedException {
        Map<String, Object> m = message(tool, args, look, approval);
        on.onCall(m, replies::add);
        Map<String, Object> reply = replies.poll(10, TimeUnit.SECONDS);
        assertThat(reply).as("a reply to %s", tool).isNotNull();
        return reply;
    }

    private Map<String, Object> message(String tool, Map<String, Object> args, boolean look,
            Map<String, Object> approval) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", nextCall++);
        m.put("tool", tool);
        m.put("runId", RUN);
        m.put("agentId", AGENT);
        m.put("args", args);
        m.put("taint", List.of());
        if (look) {
            m.put("phase", "look");
        }
        if (approval != null) {
            m.put("approval", approval);
            m.put("context", "agent");
        }
        return m;
    }

    /** deskd's look: the payload the card would show and hash. */
    private Map<String, Object> look(String tool, Map<String, Object> args) throws InterruptedException {
        Map<String, Object> reply = tcall(host, tool, args, true, null);
        assertThat(reply).containsEntry("t", "tres");
        return (Map<String, Object>) reply.get("r");
    }

    /** The member's yes from their own session, for the payload the card showed: deskd's ticket, and desk-agent hears it. */
    private Map<String, Object> approve(String tool, Map<String, Object> payload) throws Exception {
        String id = "ap-" + base32(nextApproval++);
        String sha = ToolHost.hash(AGENT, RUN, tool, "agent", payload);
        Map<String, Object> res = rig.call(owner, "agent.approval.decide", Map.of("approvalId", id, "approve", true,
                "sha256", sha));
        assertThat(res).containsEntry("_kind", "RES");
        return Map.of("approvalId", id, "sha256", sha);
    }

    private static String base32(int n) {
        String alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        StringBuilder out = new StringBuilder();
        long v = n;
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

    private Path root() {
        return files.root();
    }

    private long trashed() throws Exception {
        try (Stream<Path> s = Files.list(root().resolve(".trash"))) {
            return s.count();
        }
    }

    // ---------------------------------------------------------------- the flows

    @Test
    void aMembersYesRunsExactlyTheCallTheCardShowedOnceAndNeverAgain() throws Exception {
        Map<String, Object> payload = (Map<String, Object>) look("files_write",
                args("path", "trip.md", "text", "Pack the tent")).get("payload");
        assertThat(payload).containsEntry("replace", false);
        // Before the yes, nothing runs.
        assertThat(reason(tcall(host, "files_write", payload, false, null))).isEqualTo("approval_required");
        Map<String, Object> approval = approve("files_write", payload);

        Map<String, Object> ran = tcall(host, "files_write", payload, false, approval);
        assertThat(ran).containsEntry("t", "tres");
        assertThat(root().resolve("trip.md")).hasContent("Pack the tent");
        // A replay of the same call, the same yes: used.
        Files.delete(root().resolve("trip.md"));
        assertThat(reason(tcall(host, "files_write", payload, false, approval))).isEqualTo("approval_used");
        assertThat(root().resolve("trip.md")).doesNotExist();
    }

    @Test
    void aPayloadChangedAfterTheYesRunsNothingAndLeavesTheYesForTheRealCall() throws Exception {
        Map<String, Object> payload = args("path", "trip.md", "text", "Pack the tent", "replace", false);
        Map<String, Object> approval = approve("files_write", payload);
        for (Map<String, Object> tampered : List.of(
                args("path", "trip.md", "text", "Pack the tent and send the keys", "replace", false),
                args("path", "other.md", "text", "Pack the tent", "replace", false),
                args("path", "trip.md", "text", "Pack the tent", "replace", true))) {
            assertThat(reason(tcall(host, "files_write", tampered, false, approval))).as(tampered.toString())
                    .isEqualTo("approval_mismatch");
        }
        // The same hash under another tool, and a hash the call claims but deskd doesn't compute.
        assertThat(reason(tcall(host, "files_mkdir", args("path", "trip.md"), false, approval)))
                .isEqualTo("approval_mismatch");
        Map<String, Object> wrongClaim = new LinkedHashMap<>(approval);
        wrongClaim.put("sha256", "0".repeat(64));
        assertThat(reason(tcall(host, "files_write", payload, false, wrongClaim))).isEqualTo("approval_mismatch");
        try (Stream<Path> s = Files.list(root())) {
            assertThat(s.map(p -> p.getFileName().toString()).filter(n -> !n.startsWith(".")).toList()).isEmpty();
        }
        // None of that burnt the member's yes for what they saw.
        assertThat(tcall(host, "files_write", payload, false, approval)).containsEntry("t", "tres");
        assertThat(root().resolve("trip.md")).hasContent("Pack the tent");
    }

    @Test
    void aDeskdRestartBetweenTheYesAndTheCallLosesTheTicketAndNothingRuns() throws Exception {
        Map<String, Object> payload = args("path", "trip.md", "text", "x", "replace", false);
        Map<String, Object> approval = approve("files_write", payload);
        // A deskd restart: a new ToolHost over a new ledger, which holds nothing of the yes before it.
        host.close();
        host = wiredHost(new ApprovalTickets(rig.clock));
        assertThat(reason(tcall(host, "files_write", payload, false, approval))).isEqualTo("approval_unknown");
        assertThat(root().resolve("trip.md")).doesNotExist();
    }

    @Test
    void aYesLastsTenMinutes() throws Exception {
        Map<String, Object> payload = args("path", "late.md", "text", "x", "replace", false);
        Map<String, Object> approval = approve("files_write", payload);
        rig.clock.advance(ApprovalTickets.LIFE.minus(Duration.ofSeconds(1)));
        Map<String, Object> second = approve("files_write", args("path", "late2.md", "text", "x", "replace", false));
        rig.clock.advance(Duration.ofSeconds(1));
        assertThat(reason(tcall(host, "files_write", payload, false, approval))).isEqualTo("approval_unknown");
        assertThat(tcall(host, "files_write", args("path", "late2.md", "text", "x", "replace", false), false, second))
                .containsEntry("t", "tres");
        assertThat(root().resolve("late.md")).doesNotExist();
    }

    @Test
    void aReplaceIsBoundToTheFileTheCardShowedAndTheOldOneGoesToTheTrash() throws Exception {
        Files.writeString(root().resolve("plan.md"), "v1");
        Map<String, Object> r = look("files_write", args("path", "plan.md", "text", "v2", "replace", true));
        assertThat((Map<String, Object>) r.get("before")).containsEntry("bytes", 2L);
        Map<String, Object> payload = (Map<String, Object>) r.get("payload");
        Map<String, Object> approval = approve("files_write", payload);
        // The member edits the file after the card was shown: the yes was for the old one.
        Files.writeString(root().resolve("plan.md"), "v1, edited");
        assertThat(reason(tcall(host, "files_write", payload, false, approval))).isEqualTo("changed");
        assertThat(root().resolve("plan.md")).hasContent("v1, edited");
        assertThat(trashed()).isZero();

        // A fresh card for the file as it is now replaces it, and the old one is in the trash.
        look("files_write", args("path", "plan.md", "text", "v2", "replace", true));
        Map<String, Object> again = approve("files_write", payload);
        assertThat(tcall(host, "files_write", payload, false, again)).containsEntry("t", "tres");
        assertThat(root().resolve("plan.md")).hasContent("v2");
        assertThat(trashed()).isEqualTo(1);
    }

    @Test
    void manyCopiesOfOneApprovedCallAtOnceRunItOnce() throws Exception {
        Map<String, Object> payload = args("path", "once.md", "text", "once", "replace", false);
        Map<String, Object> approval = approve("files_write", payload);
        int copies = 12;
        for (int i = 0; i < copies; i++) {
            host.onCall(message("files_write", payload, false, approval), replies::add);
        }
        List<Map<String, Object>> all = new ArrayList<>();
        for (int i = 0; i < copies; i++) {
            Map<String, Object> reply = replies.poll(10, TimeUnit.SECONDS);
            assertThat(reply).isNotNull();
            all.add(reply);
        }
        assertThat(all.stream().filter(m -> "tres".equals(m.get("t"))).count()).isEqualTo(1);
        // Each other copy is refused: the yes used, or (deskd looks at a call again before it redeems) the file there.
        assertThat(all.stream().filter(m -> "terr".equals(m.get("t"))).map(AgentToolsDeskdIntegrationTest::reason)
                .toList()).hasSize(copies - 1).allMatch(word -> word.equals("approval_used") || word.equals("exists"));
        assertThat(root().resolve("once.md")).hasContent("once");
    }

    @Test
    void aNoMakesNoTicketAndADeleteNeedsItsOwnYes() throws Exception {
        Files.writeString(root().resolve("keep.md"), "k");
        Map<String, Object> payload = (Map<String, Object>) look("files_trash", args("path", "keep.md")).get("payload");
        String id = "ap-" + base32(900);
        String sha = ToolHost.hash(AGENT, RUN, "files_trash", "agent", payload);
        assertThat(rig.call(owner, "agent.approval.decide", Map.of("approvalId", id, "approve", false, "sha256", sha)))
                .containsEntry("_kind", "RES");
        assertThat(reason(tcall(host, "files_trash", payload, false, Map.of("approvalId", id, "sha256", sha))))
                .isEqualTo("approval_unknown");
        // A yes for a write never covers a trash of the same path.
        Map<String, Object> writeYes = approve("files_write", args("path", "keep.md", "text", "x", "replace", true));
        assertThat(reason(tcall(host, "files_trash", payload, false, writeYes))).isEqualTo("approval_mismatch");
        assertThat(root().resolve("keep.md")).hasContent("k");
        Map<String, Object> trashYes = approve("files_trash", payload);
        assertThat(tcall(host, "files_trash", payload, false, trashYes)).containsEntry("t", "tres");
        assertThat(root().resolve("keep.md")).doesNotExist();
        assertThat(trashed()).isEqualTo(1);
    }

    @Test
    void aCallDeskAgentSaysWasDoneWithoutAskingRunsNothingWhileDeskdHasNoRecordOfTheSwitch() throws Exception {
        Map<String, Object> m = message("files_write", args("path", "auto.md", "text", "x", "replace", false), false,
                null);
        m.put("auto", "files");
        m.put("autoApprovalId", "ap-abcdefghijklmnopqrst");
        host.onCall(m, replies::add);
        assertThat(reason(replies.poll(10, TimeUnit.SECONDS))).isEqualTo("approval_unknown");
        assertThat(root().resolve("auto.md")).doesNotExist();
    }
}
