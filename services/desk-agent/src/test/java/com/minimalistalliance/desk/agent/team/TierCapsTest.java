package com.minimalistalliance.desk.agent.team;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class TierCapsTest {

    @Test
    void nothingOrNotAnObjectIsTheDefaults() {
        assertThat(TierCaps.from(null)).isEqualTo(TierCaps.DEFAULTS);
        assertThat(TierCaps.from("tier")).isEqualTo(TierCaps.DEFAULTS);
        assertThat(TierCaps.from(List.of(1))).isEqualTo(TierCaps.DEFAULTS);
        assertThat(TierCaps.from(Map.of())).isEqualTo(TierCaps.DEFAULTS);
    }

    @Test
    void theBuiltInDefaultsAreTheDocumentedOnes() {
        assertThat(TierCaps.DEFAULTS).isEqualTo(new TierCaps(10, 50, 200, 5, 15, 20, 3, 25));
    }

    @Test
    void valuesInRangeAreTaken() {
        Map<String, Object> tier = new HashMap<>();
        tier.put("agentCap", 3);
        tier.put("workspaceMb", 50);
        tier.put("workspaceMaxMb", 100);
        tier.put("timersPerAgent", 0);
        tier.put("timerMinMinutes", 15);
        tier.put("a2aPerHour", 1);
        tier.put("a2aDepth", 1);
        tier.put("a2aSpendPct", 0);

        assertThat(TierCaps.from(tier)).isEqualTo(new TierCaps(3, 50, 100, 0, 15, 1, 1, 0));
    }

    @Test
    void aValueOutOfRangeTakesItsDefaultAlone() {
        Map<String, Object> tier = new HashMap<>();
        tier.put("agentCap", 0);
        tier.put("workspaceMaxMb", 99_999);
        tier.put("timersPerAgent", 101);
        tier.put("timerMinMinutes", 0);
        tier.put("a2aPerHour", -1);
        tier.put("a2aDepth", 11);
        tier.put("a2aSpendPct", 101);
        tier.put("workspaceMb", 77);

        assertThat(TierCaps.from(tier)).isEqualTo(new TierCaps(10, 77, 200, 5, 15, 20, 3, 25));
    }

    @Test
    void aValueOfTheWrongTypeOrNotWholeTakesItsDefault() {
        Map<String, Object> tier = new HashMap<>();
        tier.put("agentCap", "7");
        tier.put("a2aDepth", 2.5);
        tier.put("a2aPerHour", null);
        tier.put("timerMinMinutes", true);
        tier.put("timersPerAgent", 4.0);

        TierCaps caps = TierCaps.from(tier);
        assertThat(caps.agentCap()).isEqualTo(TierCaps.DEFAULTS.agentCap());
        assertThat(caps.a2aDepth()).isEqualTo(3);
        assertThat(caps.a2aPerHour()).isEqualTo(20);
        assertThat(caps.timerMinMinutes()).isEqualTo(15);
        assertThat(caps.timersPerAgent()).as("4.0 is a whole number").isEqualTo(4);
    }

    @Test
    void aDefaultWorkspaceNeverExceedsTheTiersMaximum() {
        TierCaps caps = TierCaps.from(Map.of("workspaceMb", 5000, "workspaceMaxMb", 300));
        assertThat(caps.workspaceMb()).isEqualTo(300);
        assertThat(caps.workspaceMaxMb()).isEqualTo(300);
    }

    @Test
    void theViewCarriesEveryCapAndTheAgentCount() {
        Map<String, Object> view = TierCaps.DEFAULTS.toMap(3);
        assertThat(view).containsEntry("agentCap", 10).containsEntry("agents", 3).containsEntry("runsAtOnce", 4)
                .containsEntry("rulesMax", 500).containsEntry("purposeMax", 4000).containsEntry("promptMax", 2000)
                .containsEntry("iconMaxBytes", 262_144).containsEntry("iconMaxPx", 512)
                .containsKeys("workspaceMb", "workspaceMaxMb", "timersPerAgent", "timerMinMinutes", "a2aPerHour",
                        "a2aDepth", "a2aSpendPct");
    }
}
