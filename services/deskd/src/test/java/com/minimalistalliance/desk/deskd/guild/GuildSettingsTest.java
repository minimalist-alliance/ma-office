package com.minimalistalliance.desk.deskd.guild;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.platform.EditBudget;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The guild's agent settings: their shape, what's kept on the desk, the audit line and the push. */
class GuildSettingsTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-07T23:00:00Z"), ZoneOffset.UTC);
    private static final Caller LEAD = new Caller(Caller.GUILD_MEMBER, "gm-lead0001", "lead", Caller.GRANTS, "Ana", "lead", false);

    @TempDir
    Path dir;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> with(String group, String field, Object value) {
        Map<String, Object> agents = GuildSettings.defaults();
        if (group == null) {
            agents.put(field, value);
        } else {
            ((Map<String, Object>) agents.get(group)).put(field, value);
        }
        return agents;
    }

    @Test
    void theDefaultsAreTheDrafts() {
        GuildSettings settings = new GuildSettings(dir, CLOCK);
        Map<String, Object> agents = Json.object(settings.current(), "agents");
        assertThat(Json.object(agents, "perMember")).containsEntry("runsPerDay", 20).containsEntry("usdPerDay", 1)
                .containsEntry("usdPerMonth", 10);
        assertThat(Json.object(agents, "perGuild")).containsEntry("usdPerMonth", 50).containsEntry("runsAtOnce", 2);
        assertThat(Json.object(agents, "tools")).containsOnlyKeys("read", "search", "edit", "post", "boards");
        assertThat(agents).containsEntry("ownKeys", false);
    }

    @Test
    void aSetIsKeptWholeAuditedPushedAndReadBack() throws Exception {
        GuildSettings settings = new GuildSettings(dir, CLOCK);
        AtomicInteger pushes = new AtomicInteger();
        settings.onChange(pushes::incrementAndGet);
        AtomicInteger effects = new AtomicInteger();
        Map<String, Object> agents = with("perGuild", "usdPerMonth", 120.25);
        settings.set(Map.of("agents", agents), LEAD, effects::incrementAndGet);
        assertThat(effects).hasValue(1);
        assertThat(pushes).hasValue(1);
        assertThat(Files.list(dir).map(p -> p.getFileName().toString()))
                .containsExactlyInAnyOrder(GuildSettings.FILE, GuildSettings.AUDIT_FILE);
        String audit = Files.readString(dir.resolve(GuildSettings.AUDIT_FILE), StandardCharsets.UTF_8);
        Map<String, Object> line = Json.parseObject(audit.strip().getBytes(StandardCharsets.UTF_8));
        assertThat(line).containsEntry("action", "guild.settings.set").containsEntry("by", "gm-lead0001")
                .containsEntry("role", "lead").containsEntry("at", "2026-11-07T23:00:00Z");
        assertThat(audit).doesNotContain("Ana");
        GuildSettings reread = new GuildSettings(dir, CLOCK);
        assertThat(Json.object(Json.object(reread.current(), "agents"), "perGuild")).containsEntry("usdPerMonth", 120.25);
        assertThat(reread.view()).containsEntry("updatedBy", "gm-lead0001");
    }

    @Test
    void everyFieldIsCheckedAndABadOneChangesNothing() {
        GuildSettings settings = new GuildSettings(dir, CLOCK);
        List<Map<String, Object>> bad = List.of(
                with("perMember", "usdPerDay", -1),
                with("perMember", "usdPerDay", 100_001),
                with("perMember", "usdPerDay", 0.0000001),
                with("perMember", "usdPerDay", "1"),
                with("perMember", "runsPerDay", 1.5),
                with("perMember", "runsPerDay", 10_001),
                with("perGuild", "runsAtOnce", 0),
                with("perGuild", "runsAtOnce", 9),
                with("perGuild", "runsAtOnce", null),
                with("tools", "read", "yes"),
                with(null, "ownKeys", null));
        for (Map<String, Object> agents : bad) {
            assertThatThrownBy(() -> settings.set(Map.of("agents", agents), LEAD, () -> {}))
                    .isInstanceOfSatisfying(RpcException.class, e -> assertThat(e.code()).isEqualTo("bad_request"));
        }
        assertThatThrownBy(() -> settings.set(Map.of(), LEAD, () -> {})).isInstanceOf(RpcException.class);
        assertThat(Files.exists(dir.resolve(GuildSettings.FILE))).isFalse();
        // Nulls are "no cap" where a cap may be absent.
        Map<String, Object> uncapped = with("perMember", "usdPerDay", null);
        assertThat(GuildSettings.microUsd(null)).isNull();
        assertThat(GuildSettings.microUsd(2.5)).isEqualTo(2_500_000L);
        assertThat(uncapped).isNotNull();
    }

    @Test
    void aCorruptFileMeansTheDefaults() throws Exception {
        Files.writeString(dir.resolve(GuildSettings.FILE), "{not json");
        assertThat(new GuildSettings(dir, CLOCK).current().get("agents")).isEqualTo(GuildSettings.defaults());
    }

    // ---- the Notebook's edit budget: the notebook block

    private static Map<String, Object> notebook(Object chars, Object minutes) {
        Map<String, Object> budget = new java.util.LinkedHashMap<>();
        budget.put("chars", chars);
        budget.put("windowMinutes", minutes);
        Map<String, Object> block = new java.util.LinkedHashMap<>();
        block.put("editBudget", budget);
        return block;
    }

    private static Map<String, Object> cleared() {
        Map<String, Object> block = new java.util.LinkedHashMap<>();
        block.put("editBudget", null);
        return block;
    }

    @Test
    void theGuildHasNoBudgetOfItsOwnUntilItSetsOne() {
        GuildSettings settings = new GuildSettings(dir, CLOCK);
        assertThat(settings.editBudget()).isNull();
        assertThat(settings.view().get("notebook")).isEqualTo(cleared());
    }

    @Test
    void aNotebookSetIsKeptShownAuditedAndTold() throws Exception {
        GuildSettings settings = new GuildSettings(dir, CLOCK);
        AtomicInteger pushes = new AtomicInteger();
        AtomicInteger budgets = new AtomicInteger();
        settings.onChange(pushes::incrementAndGet);
        settings.onEditBudgetChange(budgets::incrementAndGet);
        Map<String, Object> view = settings.set(Map.of("notebook", notebook(0, 1_440)), LEAD, () -> {});
        assertThat(settings.editBudget()).isEqualTo(new EditBudget(0, 1_440));
        assertThat(Json.object(view, "notebook")).containsEntry("editBudget", Map.of("chars", 0, "windowMinutes", 1_440));
        assertThat(budgets).hasValue(1);
        // The agents stay as they were, and nothing else is claimed to have been set.
        assertThat(settings.current().get("agents")).isEqualTo(GuildSettings.defaults());
        String audit = Files.readString(dir.resolve(GuildSettings.AUDIT_FILE), StandardCharsets.UTF_8);
        Map<String, Object> line = Json.parseObject(audit.strip().getBytes(StandardCharsets.UTF_8));
        assertThat(line).containsEntry("by", "gm-lead0001").containsEntry("notebook", notebook(0, 1_440)).doesNotContainKey("agents");
        // Kept on the desk beside the others, and read again.
        GuildSettings reread = new GuildSettings(dir, CLOCK);
        assertThat(reread.editBudget()).isEqualTo(new EditBudget(0, 1_440));
        assertThat(reread.view()).containsEntry("updatedBy", "gm-lead0001");
        // null clears it back to the Platform's.
        settings.set(Map.of("notebook", cleared()), LEAD, () -> {});
        assertThat(settings.editBudget()).isNull();
        assertThat(budgets).hasValue(2);
        assertThat(new GuildSettings(dir, CLOCK).editBudget()).isNull();
        assertThat(Files.readAllLines(dir.resolve(GuildSettings.AUDIT_FILE))).hasSize(2);
    }

    @Test
    void anAgentsSetLeavesTheBudgetAloneAndTheOtherWayRound() throws Exception {
        GuildSettings settings = new GuildSettings(dir, CLOCK);
        AtomicInteger budgets = new AtomicInteger();
        settings.onEditBudgetChange(budgets::incrementAndGet);
        settings.set(Map.of("notebook", notebook(300, 20)), LEAD, () -> {});
        settings.set(Map.of("agents", with("perGuild", "usdPerMonth", 75)), LEAD, () -> {});
        assertThat(settings.editBudget()).isEqualTo(new EditBudget(300, 20));
        assertThat(budgets).hasValue(1);
        assertThat(Json.object(Json.object(settings.current(), "agents"), "perGuild")).containsEntry("usdPerMonth", 75L);
        // Both in one set.
        settings.set(Map.of("agents", with("perGuild", "usdPerMonth", 60), "notebook", notebook(10, 2)), LEAD, () -> {});
        assertThat(settings.editBudget()).isEqualTo(new EditBudget(10, 2));
        assertThat(Json.object(Json.object(settings.current(), "agents"), "perGuild")).containsEntry("usdPerMonth", 60L);
        GuildSettings reread = new GuildSettings(dir, CLOCK);
        assertThat(reread.editBudget()).isEqualTo(new EditBudget(10, 2));
        assertThat(Json.object(Json.object(reread.current(), "agents"), "perGuild")).containsEntry("usdPerMonth", 60L);
    }

    @Test
    void aBadBudgetNamesItsFieldAndChangesNothing() {
        GuildSettings settings = new GuildSettings(dir, CLOCK);
        AtomicInteger budgets = new AtomicInteger();
        settings.onEditBudgetChange(budgets::incrementAndGet);
        java.util.Map<Map<String, Object>, String> bad = new java.util.LinkedHashMap<>();
        bad.put(notebook(-1, 10), "notebook.editBudget.chars");
        bad.put(notebook(100_001, 10), "notebook.editBudget.chars");
        bad.put(notebook(1.5, 10), "notebook.editBudget.chars");
        bad.put(notebook("500", 10), "notebook.editBudget.chars");
        bad.put(notebook(null, 10), "notebook.editBudget.chars");
        bad.put(notebook(500, 0), "notebook.editBudget.windowMinutes");
        bad.put(notebook(500, 1_441), "notebook.editBudget.windowMinutes");
        bad.put(notebook(500, 2.5), "notebook.editBudget.windowMinutes");
        bad.put(Map.of(), "notebook.editBudget");
        bad.forEach((block, field) -> assertThatThrownBy(() -> settings.set(Map.of("notebook", block), LEAD, () -> {}))
                .as(field + " " + block)
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo("bad_request");
                    assertThat(e.details()).containsEntry("reason", "settings").containsEntry("detail", field);
                }));
        assertThatThrownBy(() -> settings.set(Map.of("notebook", "none"), LEAD, () -> {})).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> settings.set(Map.of("notebook", cleared(), "agents", "x"), LEAD, () -> {}))
                .isInstanceOf(RpcException.class);
        assertThat(settings.editBudget()).isNull();
        assertThat(budgets).hasValue(0);
        assertThat(Files.exists(dir.resolve(GuildSettings.FILE))).isFalse();
    }

    @Test
    void aKeptBudgetThatIsOutOfBoundsOrMalformedIsIgnoredAndTheAgentsStand() throws Exception {
        GuildSettings settings = new GuildSettings(dir, CLOCK);
        settings.set(Map.of("agents", with("perGuild", "usdPerMonth", 80), "notebook", notebook(5, 5)), LEAD, () -> {});
        Map<String, Object> file = Json.parseObject(Files.readAllBytes(dir.resolve(GuildSettings.FILE)));
        @SuppressWarnings("unchecked")
        Map<String, Object> block = new java.util.LinkedHashMap<>((Map<String, Object>) file.get("notebook"));
        block.put("editBudget", Map.of("chars", -5, "windowMinutes", 5));
        file.put("notebook", block);
        Files.write(dir.resolve(GuildSettings.FILE), Json.bytes(file));
        GuildSettings reread = new GuildSettings(dir, CLOCK);
        assertThat(reread.editBudget()).isNull();
        assertThat(Json.object(Json.object(reread.current(), "agents"), "perGuild")).containsEntry("usdPerMonth", 80L);
        // A file from before the block existed has none, and keeps its agents.
        file.remove("notebook");
        Files.write(dir.resolve(GuildSettings.FILE), Json.bytes(file));
        GuildSettings older = new GuildSettings(dir, CLOCK);
        assertThat(older.editBudget()).isNull();
        assertThat(Json.object(Json.object(older.current(), "agents"), "perGuild")).containsEntry("usdPerMonth", 80L);
    }
}
