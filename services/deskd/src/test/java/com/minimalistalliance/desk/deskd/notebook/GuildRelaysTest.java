package com.minimalistalliance.desk.deskd.notebook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.EditBudget;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The verified caller on desk-notebook's connection (hello, then {@code caller} after a refresh), a guild member's
 * Notebook, and the commons relay with the member's identity (docs/sub-status/deskd-guild-sessions.md).
 */
class GuildRelaysTest {

    @TempDir
    Path dir;

    private FakeNotebookSocket notebook;
    private FakeNotebookSocket commons;
    private NotebookRig rig;

    @BeforeEach
    void setUp() throws Exception {
        notebook = new FakeNotebookSocket(dir.resolve("notebook.sock"));
        notebook.likeTheService();
        // Commons speaks the same framing, so the same fake stands in for it on its own socket.
        commons = new FakeNotebookSocket(dir.resolve("commons.sock"));
        rig = new NotebookRig(dir, dir.resolve("notebook.sock"));
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
        notebook.close();
        commons.close();
    }

    @Test
    void desksNotebookHearsTheMemberInTheHelloAndAgainAfterARefresh() throws Exception {
        TestClient client = rig.connect("cs-1", rig.member("gm-aaaa0001", "officer", List.of("moderate", "invite"), false));
        assertThat(rig.call(client, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        FakeNotebookSocket.Connection connection = notebook.last();
        Map<String, Object> hello = connection.next("hello");
        assertThat(hello).containsEntry("sub", "gm-aaaa0001").containsEntry("sessionId", "cs-1");
        assertThat(Json.object(hello, "caller"))
                .containsEntry("kind", "guild_member").containsEntry("memberId", "gm-aaaa0001")
                .containsEntry("role", "officer").containsEntry("grants", List.of("moderate", "invite"))
                .containsEntry("name", "Name").containsEntry("teen", false);

        rig.refresh("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false,
                rig.sessions.session("cs-1").grant().expectedFingerprint()));
        Map<String, Object> caller = connection.next("caller");
        assertThat(Json.object(caller, "caller")).containsEntry("role", "member").containsEntry("grants", List.of());
        // And it comes before anything the session sends after it.
        assertThat(rig.call(client, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
    }

    @Test
    void helloCarriesTheEditBudgetInForceAndAFrameFollowsEachChangeOnEveryOpenConnection() throws Exception {
        AtomicReference<EditBudget> budget = new AtomicReference<>(new EditBudget(500, 10));
        rig.module.editBudget(budget::get);
        TestClient ana = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        TestClient bo = rig.connect("cs-2", rig.member("gm-bbbb0001", "member", List.of(), false));
        rig.call(ana, "notebook.tree", Map.of());
        rig.call(bo, "notebook.tree", Map.of());
        FakeNotebookSocket.Connection anas = notebook.connections.get(0);
        FakeNotebookSocket.Connection bos = notebook.connections.get(1);
        // Next to the caller in the hello, exactly this shape.
        Map<String, Object> hello = anas.next("hello");
        assertThat(hello).containsKeys("t", "sessionId", "sub", "caller", "settings");
        assertThat(hello.get("settings")).isEqualTo(Map.of("editBudget", Map.of("chars", 500, "windowMinutes", 10)));
        assertThat(bos.next("hello").get("settings")).isEqualTo(Map.of("editBudget", Map.of("chars", 500, "windowMinutes", 10)));

        budget.set(new EditBudget(0, 1_440));
        rig.module.editBudgetChanged();
        for (FakeNotebookSocket.Connection connection : List.of(anas, bos)) {
            Map<String, Object> frame = connection.next("settings");
            assertThat(frame).containsOnlyKeys("t", "settings");
            assertThat(frame.get("settings")).isEqualTo(Map.of("editBudget", Map.of("chars", 0, "windowMinutes", 1_440)));
        }
        // Told again with nothing changed, it says nothing.
        rig.module.editBudgetChanged();
        // A connection that comes up later has it in its hello.
        TestClient lee = rig.connect("cs-3", rig.member("gm-cccc0001", "member", List.of(), false));
        rig.call(lee, "notebook.tree", Map.of());
        assertThat(notebook.connections.get(2).next("hello").get("settings"))
                .isEqualTo(Map.of("editBudget", Map.of("chars", 0, "windowMinutes", 1_440)));
        budget.set(new EditBudget(100_000, 1));
        rig.module.editBudgetChanged();
        assertThat(anas.next("settings").get("settings")).isEqualTo(Map.of("editBudget", Map.of("chars", 100_000, "windowMinutes", 1)));
        // Each change came once: a repeat of 0/1440 would have been this one.
        assertThat(bos.next("settings").get("settings")).isEqualTo(Map.of("editBudget", Map.of("chars", 100_000, "windowMinutes", 1)));
        // And it never gets in the way of the caller or the calls.
        assertThat(rig.call(ana, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
    }

    @Test
    void aDeskWithNoBudgetSourceSendsNoSettingsAtAll() throws Exception {
        // An owner's desk, a desk whose source says null, and the Commons relay: hello as it always was, and no frames.
        TestClient owner = rig.connect("cs-1");
        rig.call(owner, "notebook.tree", Map.of());
        Map<String, Object> hello = notebook.last().next("hello");
        assertThat(hello).doesNotContainKey("settings");
        rig.module.editBudget(() -> null);
        rig.module.editBudgetChanged();
        TestClient member = rig.connect("cs-2", rig.member("gm-aaaa0001", "member", List.of(), false));
        rig.call(member, "notebook.tree", Map.of());
        assertThat(notebook.last().next("hello")).doesNotContainKey("settings");
        rig.module.editBudgetChanged();
        assertThat(rig.call(member, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        Thread.sleep(300);
        assertThat(notebook.last().received.stream().map(m -> m.get("t"))).doesNotContain("settings");
        TestClient commonsMember = rig.connect("cs-3", rig.member("gm-bbbb0001", "member", List.of(), false));
        rig.sendCommons(commonsMember, new byte[] {1});
        await().until(() -> !commons.connections.isEmpty());
        assertThat(commons.last().next("hello")).doesNotContainKey("settings");
    }

    @Test
    void anOwnersHelloSaysOwner() throws Exception {
        TestClient client = rig.connect("cs-1");
        rig.call(client, "notebook.tree", Map.of());
        Map<String, Object> hello = notebook.last().next("hello");
        assertThat(Json.object(hello, "caller")).containsEntry("kind", "owner").containsEntry("memberId", null);
    }

    @Test
    void aMemberMayUseTheNotebookButTheDesksZoneNeedsManageSpaces() throws Exception {
        TestClient member = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        assertThat(rig.call(member, "notebook.notebook.create", Map.of("title", "Ours"))).containsEntry("_kind", "RES");
        Map<String, Object> refused = rig.call(member, "notebook.settings.set", Map.of("timeZone", "UTC"));
        assertThat(refused).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
        assertThat(Json.object(refused, "details")).containsEntry("reason", "grant");
        // collab from a member reaches desk-notebook, on the member's own connection.
        rig.sendCollab(member, new byte[] {1, 2, 3});
        assertThat(notebook.collabReceived.poll(5, TimeUnit.SECONDS)).containsExactly(1, 2, 3);
    }

    @Test
    void commonsGetsTheMembersIdentityAndTheRoomLinkBothWays() throws Exception {
        TestClient client = rig.connect("cs-1", rig.member("gm-aaaa0001", "lead", List.of(), false));
        rig.sendCommons(client, "hi".getBytes(StandardCharsets.UTF_8));
        await().until(() -> !commons.connections.isEmpty());
        FakeNotebookSocket.Connection connection = commons.last();
        Map<String, Object> hello = connection.next("hello");
        assertThat(Json.object(hello, "caller")).containsEntry("memberId", "gm-aaaa0001").containsEntry("role", "lead")
                .containsEntry("grants", com.minimalistalliance.desk.deskd.rpc.Caller.GRANTS);
        assertThat(connection.collab.poll(5, TimeUnit.SECONDS)).isEqualTo("hi".getBytes(StandardCharsets.UTF_8));
        connection.sendCollab("back".getBytes(StandardCharsets.UTF_8));
        Frame frame = client.next(Channels.MDOC);
        assertThat(frame.kind()).isEqualTo(FrameKind.DATA);
        assertThat(frame.flags() & Frame.BIN).isNotZero();
        assertThat(new String(frame.payload(), StandardCharsets.UTF_8)).isEqualTo("back");
        // Commons going drops the room link, and the client hears reset on channel 4.
        connection.drop();
        Frame reset = client.next(Channels.MDOC);
        assertThat(new String(reset.payload(), StandardCharsets.UTF_8)).isEqualTo("{\"t\":\"reset\"}");
        // Nothing of this went to desk-notebook.
        assertThat(notebook.connections).isEmpty();
    }

    @Test
    void channelFourIsDroppedForAnOwnerAndOnADeskThatIsntAGuilds() throws Exception {
        TestClient owner = rig.connect("cs-1");
        rig.sendCommons(owner, new byte[] {1});
        rig.guildDesk = false;
        TestClient member = rig.connect("cs-2", rig.member("gm-aaaa0001", "member", List.of(), false));
        rig.sendCommons(member, new byte[] {2});
        // Each channel has its own lane, so give both a moment before the desk becomes a guild's.
        Thread.sleep(300);
        assertThat(commons.connections).isEmpty();
        rig.guildDesk = true;
        rig.sendCommons(member, new byte[] {3});
        await().until(() -> !commons.connections.isEmpty());
        assertThat(commons.last().collab.poll(5, TimeUnit.SECONDS)).containsExactly(3);
        assertThat(commons.connections).hasSize(1);
        assertThat(commons.last().collab.poll(200, TimeUnit.MILLISECONDS)).isNull();
    }

    @Test
    void anExportSessionReachesNeitherRelay() throws Exception {
        TestClient export = rig.connect("cs-1", "export");
        rig.sendCommons(export, new byte[] {1});
        rig.sendCollab(export, new byte[] {1});
        Thread.sleep(200);
        assertThat(commons.connections).isEmpty();
        assertThat(notebook.connections).isEmpty();
    }

    @Test
    void theHeartbeatsCommonsSecondsAreTheRoomLinksTimeUpAndOutliveTheSession() throws Exception {
        TestClient client = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        assertThat(rig.commons.commonsSeconds("cs-1")).isZero();
        rig.sendCommons(client, new byte[] {1});
        await().until(() -> !commons.connections.isEmpty());
        await().atMost(java.time.Duration.ofSeconds(5)).until(() -> rig.commons.commonsSeconds("cs-1") >= 1);
        rig.sessions.close("cs-1", 1000, "closed_by_client");
        await().until(() -> !rig.sessions.isLive("cs-1"));
        long last = rig.commons.commonsSeconds("cs-1");
        assertThat(last).isGreaterThanOrEqualTo(1);
        Thread.sleep(1100);
        assertThat(rig.commons.commonsSeconds("cs-1")).isEqualTo(last);
        rig.commons.forget("cs-1");
        assertThat(rig.commons.commonsSeconds("cs-1")).isZero();
    }

    private void usage(FakeNotebookSocket.Connection connection, Object bytes) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("t", "usage");
        m.put("voiceBytesSent", bytes);
        connection.sendJson(m);
    }

    private void final_(FakeNotebookSocket.Connection connection, long bytes) {
        connection.sendJson(Map.of("t", "usage", "voiceBytesSent", bytes, "final", true));
    }

    @Test
    void commonsVoiceBytesAreSummedOverARestartAndKeptAfterTheSessionEnds() throws Exception {
        TestClient client = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        assertThat(rig.commons.voiceBytesSent("cs-1")).isZero();
        rig.sendCommons(client, new byte[] {1});
        await().until(() -> !commons.connections.isEmpty());
        FakeNotebookSocket.Connection connection = commons.last();
        usage(connection, 1000);
        await().until(() -> rig.commons.voiceBytesSent("cs-1") == 1000);
        usage(connection, 4000);
        await().until(() -> rig.commons.voiceBytesSent("cs-1") == 4000);
        // The voice connection closes with a final frame; a new one starts again at 0.
        final_(connection, 4500);
        await().until(() -> rig.commons.voiceBytesSent("cs-1") == 4500);
        usage(connection, 300);
        await().until(() -> rig.commons.voiceBytesSent("cs-1") == 4800);
        // A garbage final adds nothing.
        Map<String, Object> bad = new java.util.LinkedHashMap<>();
        bad.put("t", "usage");
        bad.put("voiceBytesSent", -3);
        bad.put("final", true);
        connection.sendJson(bad);
        // Fallback: a drop with no final frame is a new connection too.
        usage(connection, 100);
        await().until(() -> rig.commons.voiceBytesSent("cs-1") == 4900);
        usage(connection, 150);
        await().until(() -> rig.commons.voiceBytesSent("cs-1") == 4950);
        final_(connection, 200);
        await().until(() -> rig.commons.voiceBytesSent("cs-1") == 5000);
        rig.sessions.close("cs-1", 1000, "closed_by_client");
        await().until(() -> !rig.sessions.isLive("cs-1"));
        assertThat(rig.commons.voiceBytesSent("cs-1")).isEqualTo(5000);
        rig.commons.forget("cs-1");
        assertThat(rig.commons.voiceBytesSent("cs-1")).isZero();
    }

    @Test
    void commonsUsageFramesThatAreMalformedOrOfAnotherKindCountForNothing() throws Exception {
        TestClient client = rig.connect("cs-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        rig.sendCommons(client, new byte[] {1});
        await().until(() -> !commons.connections.isEmpty());
        FakeNotebookSocket.Connection connection = commons.last();
        usage(connection, -5);
        usage(connection, "lots");
        usage(connection, null);
        usage(connection, Double.NaN);
        usage(connection, List.of(1));
        connection.sendJson(Map.of("t", "future", "voiceBytesSent", 99));
        connection.sendJson(Map.of("t", "usage"));
        usage(connection, 700);
        await().until(() -> rig.commons.voiceBytesSent("cs-1") == 700);
        usage(connection, -1);
        assertThat(rig.commons.voiceBytesSent("cs-1")).isEqualTo(700);
        assertThat(connection.isOpen()).isTrue();
    }
}
