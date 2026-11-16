package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.limits.LimitPolicy;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.store.MessageRow;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The team view's figures for Desk Maia's planning on another desk ({@code agent.usage.summary}, API.md §23): each
 * agent's headroom from its limits and the usage ledger, its usual task, and what her briefs cost on this desk. Counts and
 * dollars only.
 */
class TeamViewHeadroomTest {

    private static final Usage USAGE = new Usage(1000, 0, 0, 200, 0);

    @TempDir
    Path data;

    @Test
    void eachAgentsHeadroomAndHerBriefsCostComeFromThisDesksOwnLedger() throws Exception {
        try (TeamDesk desk = new TeamDesk(data)) {
            desk.bindLead();
            String lead = AgentStore.MANAGER;
            // An ordinary task of the Lead's, as the member asked it.
            desk.provider.then(FakeProvider.Step.answer(USAGE, "Done."));
            desk.ask(lead, "Check my calendar");
            long ordinary = desk.ledger.agentToday(lead).microUsd();
            assertThat(ordinary).isPositive();
            // A run that one of Desk Maia's briefs started here: its opening message's origin names her.
            long at = desk.clock.millis();
            String origin = "{\"kind\":\"desk\",\"deskId\":\"d-home1\",\"agentId\":\"maia\",\"agentName\":\"Maia\","
                    + "\"grantId\":\"dg-1\",\"envelopeId\":\"env-1\",\"role\":\"message\"}";
            desk.store.addMessages(List.of(MessageRow.from("u-brief", lead, "Compare three laptops", at, origin),
                    new MessageRow("a-brief", lead, "assistant", "Here they are.", at + 1, "r-brief", null, null,
                            300_000L, "end_turn", "done", null, null)));
            UsageLedger.Reservation res = desk.ledger.reserve(new UsageLedger.Call(lead, "r-brief", "k1",
                    FakeProvider.ID, "m"), new UsageLedger.Estimate(1000, 400_000L), LimitPolicy.DEFAULTS);
            desk.ledger.settle(res, USAGE, 300_000L);
            // Another agent's message with an origin that isn't hers doesn't count as her brief.
            String other = origin.replace("\"maia\"", "\"ag-scout\"");
            desk.store.addMessages(List.of(MessageRow.from("u-other", lead, "Hi", at + 5, other),
                    new MessageRow("a-other", lead, "assistant", "Hello.", at + 6, "r-other", null, null, 1L,
                            "end_turn", "done", null, null)));

            Map<String, Object> summary = desk.call("agent.usage.summary");
            Map<String, Object> agent = list(summary.get("agents")).stream()
                    .filter(a -> lead.equals(a.get("agentId"))).findFirst().orElseThrow();
            Map<String, Object> room = map(agent.get("headroom"));
            long spent = ordinary + 300_000L;
            // Design 9.9's defaults: $5 an agent's day, $20 the desk's month, $2 a run.
            assertThat(room).containsEntry("dayLeftMicroUsd", 5_000_000L - spent)
                    .containsEntry("monthLeftMicroUsd", 20_000_000L - spent)
                    .containsEntry("runMaxMicroUsd", 2_000_000L)
                    .containsEntry("perBriefMicroUsd", 300_000L).containsEntry("briefs", 1)
                    .containsKey("briefMaxMicroUsd");
            assertThat((Long) room.get("briefMaxMicroUsd")).isBetween(0L, 2_000_000L);
            assertThat((Long) room.get("tasks")).isEqualTo(3L);
            assertThat((Long) room.get("perTaskMicroUsd")).isEqualTo(spent / 3);
            // Her briefs here, today and this month.
            assertThat(map(summary.get("maiaBriefs"))).containsEntry("todayMicroUsd", 300_000L)
                    .containsEntry("monthMicroUsd", 300_000L).containsEntry("today", 1).containsEntry("month", 1);
            // Nothing of a thread in it: counts and dollars only.
            assertThat(summary.toString()).doesNotContain("Compare three laptops").doesNotContain("Here they are");
            // Maia Mode is off on this desk: no home block.
            assertThat(summary).doesNotContainKey("maia");
        }
    }

    @Test
    void theLedgerSumsEachRunsSpend() throws Exception {
        try (TeamDesk desk = new TeamDesk(data)) {
            for (String run : List.of("r1", "r1", "r2")) {
                UsageLedger.Reservation res = desk.ledger.reserve(new UsageLedger.Call("manager", run, "k1",
                        FakeProvider.ID, "m"), new UsageLedger.Estimate(10, 50_000L), LimitPolicy.DEFAULTS);
                desk.ledger.settle(res, USAGE, 40_000L);
            }
            // One still out counts at its reservation, as a limit reads it.
            desk.ledger.reserve(new UsageLedger.Call("manager", "r3", "k1", FakeProvider.ID, "m"),
                    new UsageLedger.Estimate(10, 70_000L), LimitPolicy.DEFAULTS);
            assertThat(desk.ledger.spendOfRuns(List.of("r1", "r2", "r3", "r-none")))
                    .containsExactlyInAnyOrderEntriesOf(Map.of("r1", 80_000L, "r2", 40_000L, "r3", 70_000L));
            assertThat(desk.ledger.spendOfRuns(List.of())).isEmpty();
        }
    }
}
