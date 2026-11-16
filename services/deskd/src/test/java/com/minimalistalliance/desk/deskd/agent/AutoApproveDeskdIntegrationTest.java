package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.tools.FilesTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
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
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Auto-approve inside deskd, end to end (the draft ADR's §15 "Checked twice" and §17's Auto-approve row; API.md §18 "Done
 * without asking"): the member's switch saved from their own session through {@link AgentMethods} to a fake desk-agent on a
 * real socket, recorded in deskd's own {@link AccessRecord} on its own file; desk-agent's ticketless {@code tcall} through
 * the real {@link ToolHost}, wired as {@code DataPlaneConfiguration} wires it, to the real Files tools on a real tree; and
 * the member's {@code agent.approval.undo}, which deskd does itself from its own ledger and then relays to desk-agent with
 * its own params. desk-agent claiming {@code auto} without deskd's record gets {@code approval_unknown}.
 */
@SuppressWarnings("unchecked")
class AutoApproveDeskdIntegrationTest {

    private static final String AGENT = "ag-3k9x0d2m4q1z";

    @TempDir
    Path dir;

    private AgentRig rig;
    private AgentFilesRig files;
    private ToolHost host;
    private TestClient owner;
    private final BlockingQueue<Map<String, Object>> replies = new LinkedBlockingQueue<>();
    private long nextCall = 1;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentRig(Files.createDirectories(dir.resolve("agent")));
        rig.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of()));
        rig.module.keepAccessIn(dir);
        // desk-agent applies what it's sent, and answers an undo with the row as it stamps it.
        rig.agent.handlers.put("agent.access.set", p -> m("access", m("chosen", true, "setup", null,
                "apps", m("notebook", true, "files", true, "browser", true, "courier", false, "todos", true),
                "auto", p.get("auto"), "desks", List.of(), "incoming", List.of())));
        rig.agent.handlers.put("agent.approval.undo", p -> m("approval", m("id", p.get("approvalId"), "undoneAt",
                "ok".equals(p.get("outcome")) ? 1L : null)));
        files = new AgentFilesRig(dir.resolve("files"));
        Files.createDirectories(files.root().resolve("Research"));
        host = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
        host.agentApps(rig.module.accessRecord());
        host.access(rig.module.accessRecord());
        host.area(HostedDecls.FILES, new FilesTools(files.files().agentAccess()));
        host.autoLedger().keepIn(dir);
        rig.module.hostTools(host);
        owner = rig.connect("cs-1");
    }

    @AfterEach
    void tearDown() throws Exception {
        host.close();
        files.close();
        rig.close();
    }

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private Map<String, Object> save(Object filesSwitch) throws Exception {
        return rig.call(owner, "agent.access.set", m("agentId", AGENT, "apps", m("notebook", true, "files", true,
                "browser", true, "courier", false, "todos", true), "auto", m("notebook", null, "files", filesSwitch,
                "todos", false)));
    }

    private Map<String, Object> unasked(String tool, Map<String, Object> args, String id) throws InterruptedException {
        Map<String, Object> msg = m("t", "tcall", "id", nextCall++, "tool", tool, "runId", "run-1", "agentId", AGENT,
                "args", args, "taint", List.of(), "auto", "files", "autoApprovalId", id);
        host.onCall(msg, replies::add);
        Map<String, Object> reply = replies.poll(10, TimeUnit.SECONDS);
        assertThat(reply).isNotNull();
        return reply;
    }

    private static String reason(Map<String, Object> reply) {
        assertThat(reply).containsEntry("t", "terr");
        return (String) ((Map<String, Object>) reply.get("details")).get("reason");
    }

    private Map<String, Object> nextRequest(String method) throws InterruptedException {
        while (true) {
            Map<String, Object> req = rig.agent.next("req");
            if (method.equals(req.get("m"))) {
                return req;
            }
        }
    }

    @Test
    void theSwitchSavedFromTheMembersSessionLetsANewFileThroughAndNothingElse() throws Exception {
        // Before the member saves it: desk-agent's word alone is approval_unknown (it isn't set up at all: setup).
        assertThat(reason(unasked("files_write", m("path", "Research/a.md", "text", "x", "replace", false),
                "ap-aaaaaaaaaaaaaaaaaaab"))).isIn("setup", "approval_unknown");
        assertThat(save(null)).containsEntry("_kind", "RES");
        assertThat(reason(unasked("files_write", m("path", "Research/a.md", "text", "x", "replace", false),
                "ap-aaaaaaaaaaaaaaaaaaac"))).isEqualTo("approval_unknown");
        assertThat(save(m("folder", "Research"))).containsEntry("_kind", "RES");
        assertThat(rig.module.accessRecord().place(AGENT, "files")).isEqualTo("Research");
        assertThat(unasked("files_write", m("path", "Research/a.md", "text", "x", "replace", false),
                "ap-aaaaaaaaaaaaaaaaaaad")).containsEntry("t", "tres");
        assertThat(files.root().resolve("Research/a.md")).hasContent("x");
        // Outside the folder, and a replace: refused, nothing written.
        assertThat(reason(unasked("files_write", m("path", "Research2/a.md", "text", "x", "replace", false),
                "ap-aaaaaaaaaaaaaaaaaaae"))).isIn("approval_unknown", "not_found");
        assertThat(reason(unasked("files_write", m("path", "Research/a.md", "text", "y", "replace", true),
                "ap-aaaaaaaaaaaaaaaaaaaf"))).isEqualTo("approval_unknown");
        assertThat(files.root().resolve("Research/a.md")).hasContent("x");
        // The member switches it off: the very next call asks.
        assertThat(save(null)).containsEntry("_kind", "RES");
        assertThat(reason(unasked("files_write", m("path", "Research/b.md", "text", "x", "replace", false),
                "ap-aaaaaaaaaaaaaaaaaaag"))).isEqualTo("approval_unknown");
        assertThat(files.root().resolve("Research/b.md")).doesNotExist();
    }

    @Test
    void theMembersUndoIsDeskdsOwnFromItsLedgerAndDeskAgentHearsOnlyDeskdsParams() throws Exception {
        save(m("folder", "Research"));
        String id = "ap-aaaaaaaaaaaaaaaaaaah";
        assertThat(unasked("files_write", m("path", "Research/a.md", "text", "x", "replace", false), id))
                .containsEntry("t", "tres");
        // A session with no input can't: nothing taken back, desk-agent never hears.
        SessionGrant viewer = new SessionGrant("user-1", "sid-v", "owner", String.format("%02x", 40).repeat(32), true,
                false, Instant.now(), Instant.now().plus(Duration.ofHours(1)));
        TestClient view = rig.connect("cs-v", viewer);
        Map<String, Object> refused = rig.call(view, "agent.approval.undo", m("approvalId", id));
        assertThat(refused).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
        assertThat(files.root().resolve("Research/a.md")).exists();
        // The owner's, with an outcome of their own made up: deskd does the undo and sends desk-agent its own outcome.
        Map<String, Object> done = rig.call(owner, "agent.approval.undo", m("approvalId", id, "outcome", "made-up"));
        assertThat(done).containsEntry("_kind", "RES");
        assertThat(files.root().resolve("Research/a.md")).doesNotExist();
        Map<String, Object> relayed = Json.object(nextRequest("agent.approval.undo"), "p");
        assertThat(relayed).isEqualTo(Map.of("approvalId", id, "outcome", "ok"));
        // A file the member changed since stays, and desk-agent hears the refusal for its audit.
        String second = "ap-aaaaaaaaaaaaaaaaaaai";
        unasked("files_write", m("path", "Research/b.md", "text", "x", "replace", false), second);
        Files.writeString(files.root().resolve("Research/b.md"), "the member's now");
        Map<String, Object> changed = rig.call(owner, "agent.approval.undo", m("approvalId", second));
        assertThat(changed).containsEntry("_kind", "ERR").containsEntry("code", "conflict");
        assertThat(files.root().resolve("Research/b.md")).hasContent("the member's now");
        assertThat(Json.object(nextRequest("agent.approval.undo"), "p")).containsEntry("outcome", "changed");
        // An id deskd never ran unasked: not_found, and nothing relayed for it.
        Map<String, Object> unknown = rig.call(owner, "agent.approval.undo", m("approvalId", "ap-zzzzzzzzzzzzzzzzzzzz"));
        assertThat(unknown).containsEntry("_kind", "ERR").containsEntry("code", "not_found");
    }
}
