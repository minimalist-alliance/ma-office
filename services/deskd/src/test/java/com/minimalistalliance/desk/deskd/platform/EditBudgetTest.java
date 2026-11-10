package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The Notebook edit budget: its bounds, where the Platform's value is read from, and which level wins. */
class EditBudgetTest {

    private static Map<String, Object> budget(Object chars, Object minutes) {
        Map<String, Object> map = new HashMap<>();
        map.put("chars", chars);
        map.put("windowMinutes", minutes);
        return map;
    }

    @Test
    void charsRunFromZeroTo100000AndTheWindowFromOneTo1440Minutes() {
        assertThat(EditBudget.parse(budget(500, 10))).isEqualTo(new EditBudget(500, 10));
        assertThat(EditBudget.parse(budget(0, 1))).isEqualTo(new EditBudget(0, 1));
        assertThat(EditBudget.parse(budget(100_000, 1_440))).isEqualTo(new EditBudget(100_000, 1_440));
        assertThat(EditBudget.parse(budget(7L, 3L))).isEqualTo(new EditBudget(7, 3));
        for (Object[] bad : new Object[][] {{-1, 10}, {100_001, 10}, {5, 0}, {5, 1_441}, {1.5, 10}, {5, 2.0}, {"5", 10},
                {null, 10}, {5, null}, {Long.MAX_VALUE, 10}, {true, 10}}) {
            assertThat(EditBudget.parse(budget(bad[0], bad[1]))).as(bad[0] + " " + bad[1]).isNull();
        }
        assertThat(EditBudget.parse(Map.of("chars", 5))).isNull();
        assertThat(EditBudget.parse(null)).isNull();
        assertThat(EditBudget.parse("500")).isNull();
        assertThat(EditBudget.parse(List.of(500, 10))).isNull();
        assertThat(EditBudget.DEFAULT).isEqualTo(new EditBudget(500, 10));
        assertThat(new EditBudget(5, 3).toJson()).containsExactly(Map.entry("chars", 5), Map.entry("windowMinutes", 3));
    }

    @Test
    void theGuildsValueBeatsThePlatformsWhichBeatsTheDefault() {
        EditBudget guild = new EditBudget(50, 5);
        EditBudget platform = new EditBudget(2_000, 60);
        assertThat(EditBudget.effective(guild, platform)).isEqualTo(guild);
        assertThat(EditBudget.effective(guild, null)).isEqualTo(guild);
        assertThat(EditBudget.effective(null, platform)).isEqualTo(platform);
        assertThat(EditBudget.effective(null, null)).isEqualTo(new EditBudget(500, 10));
        // A guild's 0 is a value, not an absence.
        assertThat(EditBudget.effective(new EditBudget(0, 10), platform)).isEqualTo(new EditBudget(0, 10));
    }

    private static Map<String, Object> config(Object guild) {
        Map<String, Object> config = new HashMap<>();
        config.put("configVersion", 3);
        config.put("endpoints", Map.of("issuer", "https://issuer.example", "gateway", "wss://gateway.example/ws"));
        if (guild != null) {
            config.put("guild", guild);
        }
        return config;
    }

    @Test
    void theConfigsPlatformWideValueIsReadFromGuildNotebookEditBudgetAndAnythingElseIsAbsent() {
        Map<String, Object> guild = new HashMap<>();
        guild.put("guildId", "gu-testguild01");
        guild.put("rosterVersion", 4);
        assertThat(PlatformConfig.parse(config(guild)).notebookEditBudget()).isNull();
        assertThat(PlatformConfig.parse(config(null)).notebookEditBudget()).isNull();
        guild.put("notebookEditBudget", budget(800, 30));
        PlatformConfig parsed = PlatformConfig.parse(config(guild));
        assertThat(parsed.notebookEditBudget()).isEqualTo(new EditBudget(800, 30));
        assertThat(parsed.guildId()).isEqualTo("gu-testguild01");
        assertThat(parsed.rosterVersion()).isEqualTo(4);
        // Out of bounds or malformed is ignored, and the config is otherwise read as before.
        for (Object bad : List.of(budget(-1, 30), budget(800, 0), budget(800, 1_441), budget("800", 30), "lots", 5, List.of())) {
            guild.put("notebookEditBudget", bad);
            PlatformConfig ignored = PlatformConfig.parse(config(guild));
            assertThat(ignored.notebookEditBudget()).as(String.valueOf(bad)).isNull();
            assertThat(ignored.guildId()).isEqualTo("gu-testguild01");
        }
    }

    @Test
    void theIdleStopTimeIsAutoStopMinutesAndNullWhenAbsentNullOrOutOfRange() {
        Map<String, Object> config = config(null);
        assertThat(PlatformConfig.parse(config).autoStopMinutes()).isNull();
        for (Object[] good : new Object[][] {{1440, 1440}, {60, 60}, {20L, 20}, {1, 1}}) {
            config.put("autoStop", Map.of("autoStopMinutes", good[0], "sweepMinutes", 15));
            assertThat(PlatformConfig.parse(config).autoStopMinutes()).as(String.valueOf(good[0])).isEqualTo(good[1]);
        }
        Map<String, Object> never = new HashMap<>();
        never.put("autoStopMinutes", null);
        for (Object bad : new Object[] {never, Map.of("autoStopMinutes", 0), Map.of("autoStopMinutes", -5),
                Map.of("autoStopMinutes", 20.5), Map.of("autoStopMinutes", "60"), Map.of("autoStopMinutes", 99_999_999), "soon", List.of()}) {
            config.put("autoStop", bad);
            assertThat(PlatformConfig.parse(config).autoStopMinutes()).as(String.valueOf(bad)).isNull();
        }
    }
}
