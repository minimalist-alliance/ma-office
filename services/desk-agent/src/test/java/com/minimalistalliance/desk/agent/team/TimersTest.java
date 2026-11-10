package com.minimalistalliance.desk.agent.team;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Timers ({@code multi-agent.md} section 6). The clock starts Wednesday 2026-11-04 10:00 UTC, which is 03:00 in
 * Denver (standard time), so "weekdays at 08:00" next fires at 15:00 UTC the same day.
 */
class TimersTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);
    private static final String DENVER = "America/Denver";

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private TeamDesk desk;
    private String agent;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data, clock);
        desk.zone(DENVER);
        agent = desk.agent("Clerk");
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    private static long ms(String instant) {
        return Instant.parse(instant).toEpochMilli();
    }

    private Map<String, Object> once(int inMinutes) {
        return m("label", "Later", "kind", "once", "inMinutes", inMinutes, "prompt", "Do the later thing.");
    }

    private Map<String, Object> weekdays() {
        return m("label", "Morning brief", "kind", "repeat", "days", List.of(1, 2, 3, 4, 5), "time", "08:00", "prompt",
                "Summarise yesterday's notes in the workspace.");
    }

    private Map<String, Object> set(Map<String, Object> timer) throws Exception {
        return map(desk.call("agent.timer.set", "agentId", agent, "timer", timer).get("timer"));
    }

    private RpcError refusedSet(Map<String, Object> timer) {
        return desk.refused("agent.timer.set", "agentId", agent, "timer", timer);
    }

    private List<Map<String, Object>> timers(TeamDesk d, String agentId) throws Exception {
        return list(d.call("agent.timer.list", "agentId", agentId).get("timers"));
    }

    private Map<String, Object> only(TeamDesk d) throws Exception {
        assertThat(timers(d, agent)).hasSize(1);
        return timers(d, agent).getFirst();
    }

    private void assertBad(Map<String, Object> timer, String field) {
        RpcError e = refusedSet(timer);
        assertThat(e.code()).isEqualTo("bad_request");
        assertThat(e.details()).as(timer.toString()).containsEntry("detail", field);
    }

    private static Number number(Object value) {
        return (Number) value;
    }

    // ---------------------------------------------------------------- set, list, edit, delete

    @Test
    void aOneShotTimerInSomeMinutes() throws Exception {
        Map<String, Object> timer = set(once(30));

        long at = clock.millis() + 30 * 60_000L;
        assertThat(timer).containsEntry("kind", "once").containsEntry("label", "Later").containsEntry("enabled", true)
                .containsEntry("prompt", "Do the later thing.").containsEntry("zone", DENVER)
                .containsEntry("lastAt", null).containsEntry("lastState", null).containsEntry("everyMinutes", null)
                .containsEntry("days", null);
        assertThat((String) timer.get("id")).matches("tm-[a-z2-7]{12}");
        assertThat(number(timer.get("nextAt")).longValue()).isEqualTo(at);
        assertThat(number(timer.get("at")).longValue()).isEqualTo(at);
        assertThat(number(timer.get("spentMicroUsd")).longValue()).isZero();
        assertThat(desk.agentView(agent)).containsEntry("timers", 1);
        Map<String, Object> listed = desk.call("agent.timer.list", "agentId", agent);
        assertThat(listed).containsEntry("zone", DENVER);
        assertThat(list(listed.get("timers"))).containsExactly(timer);
    }

    @Test
    void aOneShotTimerAtALocalTimeInTheMembersZone() throws Exception {
        Map<String, Object> timer = set(m("label", "Tomorrow", "kind", "once", "at", "2026-11-05T08:00", "prompt",
                "Go."));

        assertThat(number(timer.get("nextAt")).longValue()).isEqualTo(ms("2026-11-05T15:00:00Z"));

        Map<String, Object> epoch = set(m("label", "Exact", "kind", "once", "at", ms("2026-11-06T12:00:00Z"), "prompt",
                "Go."));
        assertThat(number(epoch.get("nextAt")).longValue()).isEqualTo(ms("2026-11-06T12:00:00Z"));
    }

    @Test
    void aRepeatOnWeekdaysAtEightInTheDeskZone() throws Exception {
        Map<String, Object> timer = set(weekdays());

        assertThat(timer).containsEntry("kind", "repeat").containsEntry("time", "08:00")
                .containsEntry("days", List.of(1, 2, 3, 4, 5)).containsEntry("zone", DENVER)
                .containsEntry("everyMinutes", null).containsEntry("at", null);
        assertThat(number(timer.get("nextAt")).longValue()).as("08:00 MST today").isEqualTo(ms("2026-11-04T15:00:00Z"));
    }

    @Test
    void aRepeatEveryFewMinutesNoSoonerThanTheTiersMinimum() throws Exception {
        assertBad(m("label", "Often", "kind", "repeat", "everyMinutes", 4, "prompt", "Again."), "everyMinutes");
        desk.tier(m("timerMinMinutes", 15));
        assertBad(m("label", "Often", "kind", "repeat", "everyMinutes", 14, "prompt", "Again."), "everyMinutes");

        Map<String, Object> timer = set(m("label", "Quarterly", "kind", "repeat", "everyMinutes", 15, "prompt", "Again."));

        assertThat(timer).containsEntry("everyMinutes", 15).containsEntry("days", null);
        assertThat(number(timer.get("nextAt")).longValue()).isEqualTo(clock.millis() + 15 * 60_000L);
    }

    @Test
    void theTimerCapPerAgentIsTheTiers() throws Exception {
        desk.tier(m("timersPerAgent", 2));
        Map<String, Object> first = set(once(10));
        set(once(20));

        RpcError full = refusedSet(once(30));

        assertThat(full.code()).isEqualTo("precondition_failed");
        assertThat(full.details()).containsEntry("reason", "timer_cap");
        Map<String, Object> change = once(40);
        change.put("id", first.get("id"));
        assertThat(set(change)).as("changing one at the cap is fine").containsEntry("id", first.get("id"));
        String other = desk.agent("Other");
        assertThat(map(desk.call("agent.timer.set", "agentId", other, "timer", once(10)).get("timer")))
                .as("the cap is per agent").containsKey("id");

        desk.tier(m("timersPerAgent", 0));
        assertThat(refusedSet(once(10)).details()).containsEntry("reason", "timer_cap");
    }

    @Test
    void aTimerIsEditedByIdAndKeepsItsCount() throws Exception {
        Map<String, Object> timer = set(once(30));
        String id = (String) timer.get("id");
        set(weekdays());

        Map<String, Object> edit = m("id", id, "label", "Renamed", "kind", "repeat", "everyMinutes", 15, "prompt",
                "New prompt.", "enabled", false);
        Map<String, Object> changed = set(edit);

        assertThat(changed).containsEntry("id", id).containsEntry("label", "Renamed").containsEntry("kind", "repeat")
                .containsEntry("everyMinutes", 15).containsEntry("prompt", "New prompt.")
                .containsEntry("enabled", false).containsEntry("nextAt", null).containsEntry("at", null);
        assertThat(timers(desk, agent)).hasSize(2);

        edit.put("enabled", true);
        assertThat(set(edit).get("nextAt")).as("switched back on").isNotNull();
    }

    @Test
    void anUnknownOrForeignTimerIdIsNotFound() throws Exception {
        String other = desk.agent("Other");
        Map<String, Object> theirs = map(desk.call("agent.timer.set", "agentId", other, "timer", once(10)).get("timer"));

        for (String id : new String[] {"tm-aaaaaaaaaaaa", (String) theirs.get("id")}) {
            Map<String, Object> edit = once(10);
            edit.put("id", id);
            RpcError e = refusedSet(edit);
            assertThat(e.code()).isEqualTo("not_found");
            assertThat(e.details()).containsEntry("detail", "timer");
        }
        assertBad(m("id", "nonsense", "label", "x", "kind", "once", "inMinutes", 5, "prompt", "x"), "id");
        assertThat(desk.refused("agent.timer.delete", "agentId", agent, "timerId", theirs.get("id")).code())
                .isEqualTo("not_found");
        assertThat(timers(desk, other)).hasSize(1);
        assertThat(desk.refused("agent.timer.list", "agentId", "ag-nope").code()).isEqualTo("not_found");
        assertThat(desk.refused("agent.timer.set", "agentId", "ag-nope", "timer", once(5)).code())
                .isEqualTo("not_found");
    }

    @Test
    void aTimerIsDeleted() throws Exception {
        String id = (String) set(once(30)).get("id");

        assertThat(desk.call("agent.timer.delete", "agentId", agent, "timerId", id)).isEmpty();

        assertThat(timers(desk, agent)).isEmpty();
        assertThat(desk.agentView(agent)).containsEntry("timers", 0);
        RpcError again = desk.refused("agent.timer.delete", "agentId", agent, "timerId", id);
        assertThat(again.code()).isEqualTo("not_found");
        assertThat(again.details()).containsEntry("detail", "timer");
    }

    @Test
    void badTimersAreRefusedByField() throws Exception {
        assertBad(m("kind", "once", "inMinutes", 5, "prompt", "x"), "label");
        assertBad(m("label", "  ", "kind", "once", "inMinutes", 5, "prompt", "x"), "label");
        assertBad(m("label", "L".repeat(61), "kind", "once", "inMinutes", 5, "prompt", "x"), "label");
        assertBad(m("label", "L", "kind", "weekly", "prompt", "x"), "kind");
        assertBad(m("label", "L", "kind", "once", "inMinutes", 0, "prompt", "x"), "inMinutes");
        assertBad(m("label", "L", "kind", "once", "inMinutes", 1.5, "prompt", "x"), "inMinutes");
        assertBad(m("label", "L", "kind", "once", "inMinutes", 600_000, "prompt", "x"), "inMinutes");
        assertBad(m("label", "L", "kind", "once", "at", "next tuesday", "prompt", "x"), "at");
        assertBad(m("label", "L", "kind", "once", "prompt", "x"), "at");
        assertBad(m("label", "L", "kind", "once", "at", clock.millis() - 1000, "prompt", "x"), "at");
        assertBad(m("label", "L", "kind", "once", "at", clock.millis() + 400L * 86_400_000L, "prompt", "x"), "at");
        assertBad(m("label", "L", "kind", "repeat", "days", List.of(), "time", "08:00", "prompt", "x"), "days");
        assertBad(m("label", "L", "kind", "repeat", "days", List.of(0), "time", "08:00", "prompt", "x"), "days");
        assertBad(m("label", "L", "kind", "repeat", "days", List.of(8), "time", "08:00", "prompt", "x"), "days");
        assertBad(m("label", "L", "kind", "repeat", "time", "08:00", "prompt", "x"), "days");
        assertBad(m("label", "L", "kind", "repeat", "days", List.of(1), "time", "24:00", "prompt", "x"), "time");
        assertBad(m("label", "L", "kind", "repeat", "days", List.of(1), "time", "8:00", "prompt", "x"), "time");
        assertBad(m("label", "L", "kind", "repeat", "days", List.of(1), "prompt", "x"), "time");
        assertBad(m("label", "L", "kind", "once", "inMinutes", 5), "prompt");
        assertBad(m("label", "L", "kind", "once", "inMinutes", 5, "prompt", ""), "prompt");
        assertBad(m("label", "L", "kind", "once", "inMinutes", 5, "prompt", "p".repeat(2001)), "prompt");
        assertBad(m("label", "L", "kind", "once", "inMinutes", 5, "prompt", "x", "enabled", "yes"), "enabled");
        assertThat(timers(desk, agent)).isEmpty();
    }

    @Test
    void aChangedZoneMovesTheNextFireOfADayAndTimeTimer() throws Exception {
        desk.zone(null);
        Map<String, Object> utc = set(weekdays());
        assertThat(number(utc.get("nextAt")).longValue()).isEqualTo(ms("2026-11-05T08:00:00Z"));
        Map<String, Object> everyHour = set(m("label", "Hourly", "kind", "repeat", "everyMinutes", 60, "prompt", "x"));
        Map<String, Object> sooner = set(once(5));

        desk.call("agent.limits.set", "agentId", agent, "timeZone", DENVER);

        Map<String, Object> moved = timers(desk, agent).stream().filter(t -> t.get("id").equals(utc.get("id")))
                .findFirst().orElseThrow();
        assertThat(number(moved.get("nextAt")).longValue()).as("08:00 in Denver").isEqualTo(ms("2026-11-04T15:00:00Z"));
        assertThat(moved).containsEntry("zone", DENVER);
        assertThat(timers(desk, agent).stream().filter(t -> t.get("id").equals(everyHour.get("id"))).findFirst()
                .orElseThrow().get("nextAt")).as("an interval timer has no zone").isEqualTo(everyHour.get("nextAt"));
        assertThat(timers(desk, agent).stream().filter(t -> t.get("id").equals(sooner.get("id"))).findFirst()
                .orElseThrow().get("nextAt")).isEqualTo(sooner.get("nextAt"));
    }

    // ---------------------------------------------------------------- across a restart

    @Test
    void timersSurviveARestartWithTheSameNextFire() throws Exception {
        Map<String, Object> one = set(once(30));
        Map<String, Object> repeat = set(weekdays());
        desk.close();

        desk = new TeamDesk(data, clock);
        desk.zone(DENVER);

        assertThat(timers(desk, agent)).containsExactlyInAnyOrder(one, repeat);
        assertThat(desk.agentView(agent)).containsEntry("timers", 2);
    }

    @Test
    void aDueTimerRunsItsAgentWithThePromptAndRecordsTheOutcome() throws Exception {
        Map<String, Object> timer = set(once(30));
        desk.close();
        desk = new TeamDesk(data, clock);
        desk.zone(DENVER);
        clock.advance(Duration.ofMinutes(31));
        desk.provider.then(Step.answer(USAGE, "Did the later thing."));

        assertThat(desk.team.timers().runDue()).isEqualTo(1);

        desk.reply(agent, 2);
        List<Map<String, Object>> thread = desk.settled(agent);
        assertThat(thread).hasSize(2);
        Map<String, Object> prompt = thread.get(0);
        assertThat(prompt).containsEntry("role", "user").containsEntry("text", "Do the later thing.");
        assertThat(map(prompt.get("origin"))).containsEntry("kind", "timer").containsEntry("timerId", timer.get("id"))
                .containsEntry("label", "Later");
        assertThat(thread.get(1)).containsEntry("role", "assistant").containsEntry("state", "done")
                .containsEntry("text", "Did the later thing.");
        assertThat(TeamDesk.allText(desk.lastRequest())).contains("One of your timers fired")
                .contains("{\"label\":\"Later\",\"prompt\":\"Do the later thing.\"}");

        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(only(desk)).containsEntry("lastState", "ok"));
        Map<String, Object> done = only(desk);
        assertThat(number(done.get("spentMicroUsd")).longValue()).isEqualTo(140L);
        assertThat(done).containsEntry("enabled", false).containsEntry("nextAt", null);
        assertThat(number(done.get("lastAt")).longValue()).isEqualTo(clock.millis());
        assertThat(desk.team.timers().runDue()).as("a one-shot timer fires once").isZero();
        assertThat(desk.audit.readBefore(null, 100)).anyMatch(r -> r.entry().action().equals("timer.fire"));
    }

    @Test
    void aRepeatingTimerGetsItsNextWeekdayAndItsSpendAdds() throws Exception {
        Map<String, Object> timer = set(weekdays());
        desk.provider.then(Step.answer(USAGE, "Wednesday's brief.")).then(Step.answer(USAGE, "Friday's brief."));

        clock.set(Instant.parse("2026-11-04T15:01:00Z"));
        assertThat(desk.team.timers().runDue()).isEqualTo(1);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(only(desk)).containsEntry("lastState", "ok"));
        Map<String, Object> afterWednesday = only(desk);
        assertThat(afterWednesday).containsEntry("enabled", true).containsEntry("id", timer.get("id"));
        assertThat(number(afterWednesday.get("nextAt")).longValue()).isEqualTo(ms("2026-11-05T15:00:00Z"));
        assertThat(number(afterWednesday.get("spentMicroUsd")).longValue()).isEqualTo(140L);

        clock.set(Instant.parse("2026-11-06T15:01:00Z"));
        assertThat(desk.team.timers().runDue()).isEqualTo(1);
        desk.reply(agent, 4);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(
                () -> assertThat(number(only(desk).get("spentMicroUsd")).longValue()).isEqualTo(280L));
        Map<String, Object> afterFriday = only(desk);
        assertThat(number(afterFriday.get("nextAt")).longValue()).as("Friday to Monday")
                .isEqualTo(ms("2026-11-09T15:00:00Z"));
        assertThat(afterFriday).containsEntry("lastState", "ok");
        assertThat(desk.settled(agent)).hasSize(4);
    }

    @Test
    void aOneShotTimerMissedByOverADayEndsMissedAtRestore() throws Exception {
        set(once(30));
        desk.close();
        clock.advance(Duration.ofHours(26));

        desk = new TeamDesk(data, clock);

        Map<String, Object> timer = only(desk);
        assertThat(timer).containsEntry("lastState", "missed").containsEntry("enabled", false)
                .containsEntry("nextAt", null);
        assertThat(desk.team.timers().runDue()).isZero();
        assertThat(desk.settled(agent)).isEmpty();
    }

    @Test
    void aOneShotTimerMissedByLessThanADayStillRunsAtStart() throws Exception {
        set(once(30));
        desk.close();
        clock.advance(Duration.ofHours(5));
        desk = new TeamDesk(data, clock);
        desk.provider.then(Step.answer(USAGE, "Late, but done."));

        assertThat(only(desk)).containsEntry("enabled", true).containsEntry("lastState", null);
        assertThat(desk.team.timers().runDue()).isEqualTo(1);

        assertThat(desk.reply(agent, 2)).containsEntry("text", "Late, but done.");
    }

    @Test
    void aRepeatingTimerMissedWhileDownSkipsToItsNextTime() throws Exception {
        set(weekdays());
        desk.close();
        clock.set(Instant.parse("2026-11-05T12:00:00Z"));
        desk = new TeamDesk(data, clock);
        desk.zone(DENVER);

        Map<String, Object> timer = only(desk);
        assertThat(timer).containsEntry("lastState", "missed").containsEntry("enabled", true);
        assertThat(number(timer.get("nextAt")).longValue()).as("08:00 Denver tomorrow, once the zone is back")
                .isEqualTo(ms("2026-11-05T15:00:00Z"));
        assertThat(desk.team.timers().runDue()).as("it doesn't run late").isZero();
        assertThat(desk.settled(agent)).isEmpty();
    }

    @Test
    void theTimersOwnThreadFiresADueTimerWithoutHelp() throws Exception {
        desk.close();
        desk = TeamDesk.withTimerThread(data, clock);
        desk.zone(DENVER);
        desk.provider.then(Step.answer(USAGE, "On my own."));
        set(once(1));

        clock.advance(Duration.ofMinutes(2));
        desk.team.timers().changed();

        assertThat(desk.reply(agent, 2)).containsEntry("text", "On my own.");
    }

    // ---------------------------------------------------------------- when it can't run

    @Test
    void aBusyAgentRetriesAMinuteLaterAndThenRuns() throws Exception {
        Map<String, Object> timer = set(once(30));
        CountDownLatch hold = new CountDownLatch(1);
        desk.provider.then(Step.answer(USAGE, "Busy with the member.").heldBy(hold))
                .then(Step.answer(USAGE, "Now the timer."));
        desk.call("agent.message.send", "agentId", agent, "text", "Long job.");
        await().atMost(Duration.ofSeconds(5)).until(() -> desk.provider.started.getCount() == 0);
        clock.advance(Duration.ofMinutes(31));

        assertThat(desk.team.timers().runDue()).isEqualTo(1);

        Map<String, Object> waiting = only(desk);
        assertThat(waiting).containsEntry("lastState", "busy").containsEntry("enabled", true);
        assertThat(number(waiting.get("nextAt")).longValue()).isEqualTo(clock.millis() + 60_000L);
        assertThat(desk.team.timers().runDue()).as("not yet").isZero();

        hold.countDown();
        desk.settled(agent);
        clock.advance(Duration.ofMinutes(1));
        assertThat(desk.team.timers().runDue()).isEqualTo(1);
        assertThat(desk.reply(agent, 4)).containsEntry("text", "Now the timer.");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(only(desk)).containsEntry("lastState", "ok")
                .containsEntry("enabled", false).containsEntry("id", timer.get("id")));
    }

    @Test
    void aTimerGivesUpAfterTenBusyRetries() throws Exception {
        set(once(30));
        CountDownLatch hold = new CountDownLatch(1);
        desk.provider.then(Step.answer(USAGE, "Busy for a long time.").heldBy(hold));
        desk.call("agent.message.send", "agentId", agent, "text", "Long job.");
        await().atMost(Duration.ofSeconds(5)).until(() -> desk.provider.started.getCount() == 0);
        clock.advance(Duration.ofMinutes(31));

        for (int i = 0; i < 10; i++) {
            assertThat(desk.team.timers().runDue()).isEqualTo(1);
            assertThat(only(desk)).containsEntry("lastState", "busy").containsEntry("enabled", true);
            clock.advance(Duration.ofMinutes(1));
        }
        assertThat(desk.team.timers().runDue()).isEqualTo(1);

        assertThat(only(desk)).as("the eleventh busy ends a one-shot timer").containsEntry("lastState", "busy")
                .containsEntry("enabled", false).containsEntry("nextAt", null);
        hold.countDown();
    }

    @Test
    void anAgentWithoutAKeyEndsTheOneShotWithNoKey() throws Exception {
        String keyless = (String) map(desk.call("agent.create", "name", "Keyless").get("agent")).get("id");
        desk.call("agent.timer.set", "agentId", keyless, "timer", once(5));
        clock.advance(Duration.ofMinutes(6));

        assertThat(desk.team.timers().runDue()).isEqualTo(1);

        Map<String, Object> timer = timers(desk, keyless).getFirst();
        assertThat(timer).containsEntry("lastState", "no_key").containsEntry("enabled", false);
        assertThat(desk.settled(keyless)).isEmpty();
    }

    @Test
    void aLimitAtTheAgentEndsTheRunsTimerLimitReached() throws Exception {
        Map<String, Object> policy = IconsTest.policy(50);
        policy.put("agentDay", m("maxMicroUsd", 1, "maxTokens", null));
        desk.call("agent.limits.set", "agentId", agent, "policy", policy);
        set(weekdays());
        clock.set(Instant.parse("2026-11-04T15:01:00Z"));

        assertThat(desk.team.timers().runDue()).isEqualTo(1);

        Map<String, Object> timer = only(desk);
        assertThat(timer).containsEntry("lastState", "limit_reached").containsEntry("enabled", true);
        assertThat(number(timer.get("nextAt")).longValue()).as("it tries again at its next time")
                .isEqualTo(ms("2026-11-05T15:00:00Z"));
    }

    @Test
    void aFailedRunIsRecordedFailedAndCosts() throws Exception {
        set(once(5));
        desk.provider.then(Step.fail(com.minimalistalliance.desk.agent.provider.ProviderException.Kind.UNAVAILABLE, false));
        clock.advance(Duration.ofMinutes(6));

        desk.team.timers().runDue();

        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(only(desk)).containsEntry("lastState", "failed"));
        assertThat(desk.lastReply(agent)).containsEntry("state", "failed").containsEntry("error", "provider_error");
    }

    @Test
    void deletingTheAgentWhileATimerIsDueLeavesNothingToFire() throws Exception {
        set(once(5));
        clock.advance(Duration.ofMinutes(6));
        desk.call("agent.delete", "agentId", agent);

        assertThat(desk.team.timers().runDue()).isZero();
        assertThat(desk.team.teamStore().timers(null)).isEmpty();
    }
}
