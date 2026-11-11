package com.minimalistalliance.desk.deskd.notebook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.NotebookTools;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import com.minimalistalliance.desk.deskd.tools.ToolFailure;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Agent's Notebook tools against the real desk-notebook ({@link RealNotebookService}): deskd's own calls
 * ({@link NotebookCalls}) and {@link NotebookTools}, as the owner and as guild members, on real Unix sockets with the
 * real service's Markdown, edits, versions and rules. The approval check is {@code tools/NotebookToolsHostTest}'s; this
 * calls the area itself. {@code verify} skips it unless {@code DESK_NOTEBOOK_CMD} is set, as for {@link RealDeskNotebookIT}:
 *
 * <pre>
 * (cd notebook && npm run build)
 * DESK_NOTEBOOK_CMD="exec node $PWD/notebook/dist/desk-notebook.mjs" ./mvnw -q -pl deskd verify \
 *     -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=RealDeskNotebookToolsIT
 * </pre>
 */
@EnabledIfEnvironmentVariable(named = RealNotebookService.CMD, matches = ".+")
@SuppressWarnings("unchecked")
class RealDeskNotebookToolsIT {

    private static final Caller ANA = new Caller(Caller.GUILD_MEMBER, "gm-ana1", Caller.MEMBER, List.of(), "Ana", null, false);
    private static final Caller CAL = new Caller(Caller.GUILD_MEMBER, "gm-cal5", Caller.MEMBER, List.of(), "Cal", null, false);

    @TempDir
    Path dir;

    private RealNotebookService service;
    private NotebookRig rig;
    private NotebookTools tools;

    @BeforeEach
    void setUp() throws Exception {
        service = new RealNotebookService(dir);
        rig = new NotebookRig(dir, service.socket());
        tools = new NotebookTools(new NotebookCalls(service.socket(), () -> null, Duration.ofSeconds(10)), () -> false);
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
        service.close();
    }

    private static Map<String, Object> args(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    private static HostedCall call(Caller caller, String tool, Map<String, Object> args, boolean look) {
        return new HostedCall(1, "run-1", caller.isGuildMember() ? caller.memberId() : "ag-1", tool, args, null, look, caller, null);
    }

    private static RunLedger.Run run(Caller caller) throws ToolFailure {
        return new RunLedger(Clock.systemUTC(), id -> { }).join("run-1", caller.isGuildMember() ? caller.memberId() : "ag-1", caller, List.of());
    }

    private Map<String, Object> runs(Caller caller, String tool, Map<String, Object> args) throws Exception {
        HostedTool.Result r = tools.run(call(caller, tool, args, false), run(caller));
        return (Map<String, Object>) r.content();
    }

    @Test
    void theOwnersAgentMakesReadsEditsFindsAndTrashesAPage() throws Exception {
        TestClient owner = rig.connect("a");
        Map<String, Object> created = rig.call(owner, "notebook.notebook.create", Map.of("title", "Home"));
        String tabId = (String) ((Map<String, Object>) created.get("tab")).get("id");

        // The card's look for a new page, from the service's own dry run, then the page.
        Map<String, Object> made = args("tabId", tabId, "title", "Trip");
        HostedTool.Look look = tools.look(call(Caller.THE_OWNER, "notebook_write", args("new", made, "op", "create", "markdown", "- [ ] book the train"), true), run(Caller.THE_OWNER));
        assertThat(look.target()).containsEntry("title", "Trip").containsEntry("pageId", null);
        Map<String, Object> page = runs(Caller.THE_OWNER, "notebook_write", look.payload());
        String pageId = (String) page.get("pageId");
        assertThat(page).containsEntry("title", "Trip").containsEntry("saved", true);

        Map<String, Object> read = runs(Caller.THE_OWNER, "notebook_read", args("pageId", pageId));
        assertThat(read).containsEntry("title", "Trip").containsEntry("markdown", "# Trip\n\n- [ ] book the train\n").containsEntry("next", null);

        // A replace's look reads the title as the before; a find that isn't there is refused at the look.
        Map<String, Object> replace = args("pageId", pageId, "op", "replace_text", "markdown", "the plane", "find", "the train");
        HostedTool.Look replaceLook = tools.look(call(Caller.THE_OWNER, "notebook_write", replace, true), run(Caller.THE_OWNER));
        assertThat(replaceLook.before()).isEqualTo(Map.of("title", "Trip"));
        assertThatThrownBy(() -> tools.look(call(Caller.THE_OWNER, "notebook_write", args("pageId", pageId, "op", "replace_text", "markdown", "x", "find", "the boat"), true), run(Caller.THE_OWNER)))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isEqualTo("not_found"));
        Map<String, Object> edited = runs(Caller.THE_OWNER, "notebook_write", replaceLook.payload());
        assertThat(edited.get("versionId")).isInstanceOf(String.class);
        assertThat(runs(Caller.THE_OWNER, "notebook_read", args("pageId", pageId))).containsEntry("markdown", "# Trip\n\n- [ ] book the plane\n");

        Map<String, Object> found = runs(Caller.THE_OWNER, "notebook_search", args("query", "plane"));
        assertThat((List<Object>) found.get("hits")).hasSize(1);

        HostedTool.Look trashLook = tools.look(call(Caller.THE_OWNER, "notebook_trash", args("pageId", pageId), true), run(Caller.THE_OWNER));
        assertThat(trashLook.before()).isEqualTo(Map.of("title", "Trip"));
        assertThat(runs(Caller.THE_OWNER, "notebook_trash", args("pageId", pageId))).containsEntry("trashed", pageId);
        assertThatThrownBy(() -> tools.look(call(Caller.THE_OWNER, "notebook_trash", args("pageId", pageId), true), run(Caller.THE_OWNER)))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isEqualTo("trashed"));
        assertThatThrownBy(() -> runs(Caller.THE_OWNER, "notebook_write", args("pageId", pageId, "op", "append", "markdown", "x")))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isEqualTo("trashed"));
        assertThatThrownBy(() -> runs(Caller.THE_OWNER, "notebook_read", args("pageId", "no-such-page")))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.code()).isEqualTo("not_found"));
    }

    @Test
    void aGuildMembersAgentIsHeldToThatMembersRules() throws Exception {
        TestClient lead = rig.connect("lead", rig.member("gm-lee4", Caller.LEAD, Caller.GRANTS, false));
        Map<String, Object> created = rig.call(lead, "notebook.notebook.create", Map.of("title", "Guild"));
        String tabId = (String) ((Map<String, Object>) created.get("tab")).get("id");
        Map<String, Object> anas = runs(ANA, "notebook_write", args("new", args("tabId", tabId, "title", "Ana's"), "op", "create", "markdown", "A".repeat(600)));
        String pageId = (String) anas.get("pageId");
        // Cal's agent may add to Ana's page, but not remove past Cal's edit budget, and not trash a page Cal didn't make.
        assertThat(runs(CAL, "notebook_write", args("pageId", pageId, "op", "append", "markdown", "Cal adds."))).containsEntry("saved", true);
        assertThatThrownBy(() -> runs(CAL, "notebook_write", args("pageId", pageId, "op", "replace_text", "markdown", "short", "find", "A".repeat(600))))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.details()).isEqualTo(Map.of("reason", "budget")));
        assertThatThrownBy(() -> runs(CAL, "notebook_trash", args("pageId", pageId)))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.details()).isEqualTo(Map.of("reason", "grant")));
        assertThat((String) runs(ANA, "notebook_read", args("pageId", pageId)).get("markdown")).endsWith("Cal adds.\n");
    }
}
