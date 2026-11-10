package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.guild.GuildMethods;
import com.minimalistalliance.desk.deskd.guild.GuildSettings;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * What a guild member may call, through the real method table: every family that isn't a guild member's answers
 * {@code forbidden} with {@code reason: scope}, and the guild's own methods check roles and grants (API.md section 14).
 */
class GuildScopeTest {

    @TempDir
    Path dir;

    private DataRig rig;
    private GuildSettings settings;

    @BeforeEach
    void setUp() throws Exception {
        rig = new DataRig(dir);
        Path data = Files.createDirectories(dir.resolve("data"));
        settings = new GuildSettings(data, Clock.systemUTC());
        new GuildMethods(settings, () -> "gu-testguild01").register(rig.dispatcher);
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    @Test
    void everyFamilyButAGuildMembersIsRefusedByScope() throws Exception {
        TestClient member = rig.member("cs-1", "gm-aaaa0001", "lead", List.of());
        Map<String, Object> create = rig.fake.awaitJson("session.create");
        assertThat(Json.object(create, "permissions")).isEqualTo(Map.of("video", false, "input", false));
        for (String method : List.of(
                "desk.status.get", "desk.attention.set",
                "browser.stream.set", "browser.tab.list", "browser.tab.navigate", "browser.tab.open", "browser.text.insert",
                "browser.clipboard.read", "browser.clipboard.write",
                "data.parts.list", "data.manifest", "data.read", "data.read.stop", "data.browser.hold",
                "data.browser.release", "data.browser.cookies",
                "no.such.method")) {
            Map<String, Object> reply = rig.call(member, method, Map.of("state", "off", "seen", true, "url", "https://example.com/"));
            assertThat(reply).as(method).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat(Json.object(reply, "details")).as(method).containsEntry("reason", "scope");
        }
        for (String topic : List.of("browser.tabs", "browser.clipboard", "desk.attention", "summary")) {
            Map<String, Object> reply = rig.subscribe(member, topic);
            assertThat(reply).as(topic).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat(Json.object(reply, "details")).as(topic).containsEntry("reason", "scope");
        }
        assertThat(rig.units.requests()).isEmpty();
    }

    @Test
    void theGuildsMethodsAreMembersOnly() throws Exception {
        TestClient owner = rig.owner("cs-1");
        for (String method : List.of("guild.hello", "guild.settings.get", "guild.settings.set")) {
            Map<String, Object> reply = rig.call(owner, method, Map.of());
            assertThat(reply).as(method).containsEntry("code", "forbidden");
            assertThat(Json.object(reply, "details")).as(method).containsEntry("reason", "scope");
        }
    }

    @Test
    void helloSaysWhoTheMemberIsAndWhichApps() throws Exception {
        TestClient officer = rig.member("cs-1", "gm-aaaa0001", "officer", List.of("invite", "made-up"));
        Map<String, Object> hello = rig.call(officer, "guild.hello", Map.of());
        assertThat(hello).containsEntry("guildId", "gu-testguild01").containsEntry("memberId", "gm-aaaa0001")
                .containsEntry("role", "officer").containsEntry("grants", List.of("invite")).containsEntry("name", "Name")
                .containsEntry("apps", List.of("commons", "notebook", "agent"));
    }

    @Test
    void anyMemberReadsTheSettingsAndOnlyTheFounderOrManageAgentsSetsThem() throws Exception {
        TestClient member = rig.member("cs-1", "gm-aaaa0001", "member", List.of());
        TestClient officer = rig.member("cs-2", "gm-bbbb0001", "officer", List.of("moderate"));
        TestClient manager = rig.member("cs-3", "gm-cccc0001", "officer", List.of("manage_agents"));
        TestClient lead = rig.member("cs-4", "gm-dddd0001", "lead", List.of());
        assertThat(Json.object(rig.call(member, "guild.settings.get", Map.of()), "agents")).isEqualTo(GuildSettings.defaults());

        Map<String, Object> agents = GuildSettings.defaults();
        @SuppressWarnings("unchecked")
        Map<String, Object> perMember = (Map<String, Object>) agents.get("perMember");
        perMember.put("usdPerDay", 2.5);
        for (TestClient refused : List.of(member, officer)) {
            Map<String, Object> reply = rig.call(refused, "guild.settings.set", Map.of("agents", agents));
            assertThat(reply).containsEntry("code", "forbidden");
            assertThat(Json.object(reply, "details")).containsEntry("reason", "grant");
        }
        assertThat(settings.current().get("agents")).isEqualTo(GuildSettings.defaults());
        Map<String, Object> set = rig.call(manager, "guild.settings.set", Map.of("agents", agents));
        assertThat(set).containsEntry("_kind", "RES").containsEntry("updatedBy", "gm-cccc0001");
        assertThat(Json.object(Json.object(set, "agents"), "perMember")).containsEntry("usdPerDay", 2.5);
        assertThat(rig.call(lead, "guild.settings.set", Map.of("agents", agents))).containsEntry("_kind", "RES");
        // A bad shape names its field and changes nothing.
        perMember.remove("runsPerDay");
        Map<String, Object> bad = rig.call(lead, "guild.settings.set", Map.of("agents", agents));
        assertThat(bad).containsEntry("code", "bad_request");
        assertThat(Json.object(bad, "details")).containsEntry("detail", "agents.perMember.runsPerDay");
        assertThat(Json.object(rig.call(member, "guild.settings.get", Map.of()), "agents")).isNotEqualTo(agents);
    }

    @Test
    void theNotebookBlockNeedsTheFounderOrManageSpacesAndTheAgentsBlockStillNeedsManageAgents() throws Exception {
        TestClient member = rig.member("cs-1", "gm-aaaa0001", "member", List.of());
        TestClient officer = rig.member("cs-2", "gm-bbbb0001", "officer", List.of("moderate"));
        TestClient agentManager = rig.member("cs-3", "gm-cccc0001", "officer", List.of("manage_agents"));
        TestClient spaceManager = rig.member("cs-4", "gm-dddd0001", "officer", List.of("manage_spaces"));
        TestClient lead = rig.member("cs-5", "gm-eeee0001", "lead", List.of());
        Map<String, Object> block = Map.of("editBudget", Map.of("chars", 120, "windowMinutes", 15));

        for (TestClient refused : List.of(member, officer, agentManager)) {
            Map<String, Object> reply = rig.call(refused, "guild.settings.set", Map.of("notebook", block));
            assertThat(reply).containsEntry("code", "forbidden");
            assertThat(Json.object(reply, "details")).containsEntry("reason", "grant");
        }
        assertThat(settings.editBudget()).isNull();

        Map<String, Object> set = rig.call(spaceManager, "guild.settings.set", Map.of("notebook", block));
        assertThat(set).containsEntry("_kind", "RES").containsEntry("updatedBy", "gm-dddd0001");
        assertThat(Json.object(Json.object(set, "notebook"), "editBudget")).containsEntry("chars", 120).containsEntry("windowMinutes", 15);
        // Any member reads it back.
        assertThat(Json.object(Json.object(rig.call(member, "guild.settings.get", Map.of()), "notebook"), "editBudget"))
                .containsEntry("chars", 120);

        // manage_spaces alone doesn't set the agents' limits, and manage_agents alone doesn't set the budget; both blocks need both.
        Map<String, Object> agents = GuildSettings.defaults();
        assertThat(rig.call(spaceManager, "guild.settings.set", Map.of("agents", agents))).containsEntry("code", "forbidden");
        assertThat(rig.call(agentManager, "guild.settings.set", Map.of("agents", agents))).containsEntry("_kind", "RES");
        assertThat(rig.call(agentManager, "guild.settings.set", Map.of("agents", agents, "notebook", block)))
                .containsEntry("code", "forbidden");
        assertThat(rig.call(spaceManager, "guild.settings.set", Map.of("agents", agents, "notebook", block)))
                .containsEntry("code", "forbidden");
        assertThat(rig.call(lead, "guild.settings.set", Map.of("agents", agents, "notebook", block))).containsEntry("_kind", "RES");

        // null clears it; a bad one is bad_request naming its field, for a permitted caller.
        Map<String, Object> cleared = new java.util.HashMap<>();
        cleared.put("editBudget", null);
        assertThat(rig.call(lead, "guild.settings.set", Map.of("notebook", cleared))).containsEntry("_kind", "RES");
        assertThat(settings.editBudget()).isNull();
        Map<String, Object> bad = rig.call(lead, "guild.settings.set",
                Map.of("notebook", Map.of("editBudget", Map.of("chars", 100_001, "windowMinutes", 10))));
        assertThat(bad).containsEntry("code", "bad_request");
        assertThat(Json.object(bad, "details")).containsEntry("detail", "notebook.editBudget.chars");
        // Neither block is judged as an agents set, as before.
        assertThat(rig.call(member, "guild.settings.set", Map.of())).containsEntry("code", "forbidden");
        assertThat(rig.call(lead, "guild.settings.set", Map.of())).containsEntry("code", "bad_request");
    }
}
