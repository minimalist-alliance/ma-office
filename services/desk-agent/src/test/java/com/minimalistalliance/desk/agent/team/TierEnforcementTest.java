package com.minimalistalliance.desk.agent.team;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The tier's caps at use, the kept tier, the age band and the run slots (contract section 8): a cap that falls is held
 * to where things already are, and nothing is deleted.
 */
class TierEnforcementTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private TeamDesk desk;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data, clock);
        desk.zone("America/Denver");
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    private String agent(String name) throws Exception {
        clock.advance(Duration.ofSeconds(1));
        return desk.agent(name);
    }

    private Map<String, Object> once(String agent, String label, int inMinutes) throws Exception {
        return map(desk.call("agent.timer.set", "agentId", agent, "timer",
                m("label", label, "kind", "once", "inMinutes", inMinutes, "prompt", "Do " + label + ".")).get("timer"));
    }

    private Map<String, Object> timer(String agent, String id) throws Exception {
        for (Object t : (List<?>) desk.call("agent.timer.list", "agentId", agent).get("timers")) {
            if (map(t).get("id").equals(id)) {
                return map(t);
            }
        }
        throw new AssertionError("no timer " + id);
    }

    /** {@code desk.account.set} as deskd sends it: the zone every time, so these don't reset it. */
    private void account(Object... pairs) throws Exception {
        Map<String, Object> p = m("timeZone", "America/Denver");
        p.putAll(m(pairs));
        desk.service.call("desk.account.set", p);
    }

    // ---------------------------------------------------------------- the kept tier (Security T49K-1, AI M12)

    @Test
    void theBuiltInDefaultsAreAlliances() {
        assertThat(desk.team.caps()).isEqualTo(new TierCaps(10, 50, 200, 5, 15, 20, 3, 25));
    }

    @Test
    void theLastTierIsKeptAcrossARestartAndAMissingTierChangesNothing() throws Exception {
        desk.tier(m("agentCap", 3, "timerMinMinutes", 30));
        assertThat(desk.team.caps().agentCap()).isEqualTo(3);

        account("tier", null);
        account("deskDay", 5);
        assertThat(desk.team.caps().agentCap()).as("deskd had none to send").isEqualTo(3);

        desk.close();
        desk = new TeamDesk(data, clock);
        assertThat(desk.team.caps().agentCap()).as("kept in agent.db").isEqualTo(3);
        assertThat(desk.team.caps().timerMinMinutes()).isEqualTo(30);
    }

    // ---------------------------------------------------------------- the age band (Security T49K-2)

    @Test
    void dueTimersWaitWhileTheBandIsNotAdultAndRunWhenItIs() throws Exception {
        String agent = agent("Clerk");
        String id = (String) once(agent, "Later", 30).get("id");
        account("band", "teen");
        clock.advance(Duration.ofMinutes(31));
        long due = ((Number) timer(agent, id).get("nextAt")).longValue();

        assertThat(desk.team.timers().runDue()).isZero();

        Map<String, Object> waiting = timer(agent, id);
        assertThat(waiting).containsEntry("lastState", "paused").containsEntry("enabled", true);
        assertThat(((Number) waiting.get("nextAt")).longValue()).isEqualTo(due);
        assertThat(desk.thread(agent)).isEmpty();

        desk.provider.then(Step.answer(USAGE, "Done."));
        account("band", "adult");
        assertThat(desk.team.timers().runDue()).isEqualTo(1);
        assertThat(desk.reply(agent, 2)).containsEntry("text", "Done.");
    }

    @Test
    void aRepeatThatWaitedForTheBandSkipsToItsNextTime() throws Exception {
        String agent = agent("Clerk");
        String id = (String) map(desk.call("agent.timer.set", "agentId", agent, "timer", m("label", "Daily", "kind",
                "repeat", "days", List.of(1, 2, 3, 4, 5, 6, 7), "time", "08:00", "prompt", "Brief.")).get("timer"))
                .get("id");
        account("band", "unknown");
        clock.set(Instant.parse("2026-11-06T09:00:00Z"));
        desk.team.timers().runDue();
        assertThat(timer(agent, id)).as("waiting").containsEntry("lastState", "paused");
        clock.set(Instant.parse("2026-11-08T20:00:00Z"));
        account("band", "adult");

        desk.team.timers().runDue();

        Map<String, Object> after = timer(agent, id);
        assertThat(after).containsEntry("lastState", "missed");
        assertThat(((Number) after.get("nextAt")).longValue()).isGreaterThan(clock.millis());
        assertThat(desk.thread(agent)).isEmpty();
    }

    @Test
    void aMessageStartedRunIsRefusedWhileTheBandIsNotAdult() throws Exception {
        String agent = agent("Clerk");
        account("band", "teen");

        assertThatThrownBy(() -> desk.team.host().start(agent, "Hello.", Map.of("kind", "agent"),
                Team.Chain.start(agent))).isInstanceOfSatisfying(RpcError.class, e -> {
                    assertThat(e.code()).isEqualTo("precondition_failed");
                    assertThat(e.details()).containsEntry("reason", "age_band");
                });
        assertThat(desk.thread(agent)).isEmpty();
    }

    /** Security T49K-2's rest: a run already going when the band stops being adult stops, its reply {@code stopped}. */
    @Test
    void aRunInFlightStopsWhenTheBandStopsBeingAdult() throws Exception {
        String agent = agent("Clerk");
        CountDownLatch hold = new CountDownLatch(1);
        desk.provider.started = new CountDownLatch(1);
        desk.provider.then(Step.answer(USAGE, "Still going.").heldBy(hold));
        desk.call("agent.message.send", "agentId", agent, "text", "Take your time.");
        await().atMost(Duration.ofSeconds(5)).until(() -> desk.provider.started.getCount() == 0);

        account("band", "teen");
        hold.countDown();

        Map<String, Object> reply = desk.reply(agent, 2);
        assertThat(reply).containsEntry("state", "stopped");
    }

    @Test
    void theOwnersOwnRunIsRefusedWhileTheBandIsNotAdult() throws Exception {
        String agent = agent("Clerk");
        account("band", "unknown");

        assertThat(desk.refused("agent.message.send", "agentId", agent, "text", "Hello.").details())
                .containsEntry("reason", "age_band");
        assertThat(desk.thread(agent)).isEmpty();
    }

    @Test
    void theBandIsKeptAcrossARestart() throws Exception {
        account("band", "teen");
        desk.close();
        desk = new TeamDesk(data, clock);
        assertThat(desk.team.adult()).isFalse();
        account("band", "adult");
        assertThat(desk.team.adult()).isTrue();
    }

    // ---------------------------------------------------------------- caps at use (AI M13)

    @Test
    void timersBeyondTheCapDoNotFireAndTheOldestAreKept() throws Exception {
        String agent = agent("Clerk");
        String a = (String) once(agent, "First", 10).get("id");
        clock.advance(Duration.ofSeconds(1));
        String b = (String) once(agent, "Second", 20).get("id");
        clock.advance(Duration.ofSeconds(1));
        String c = (String) once(agent, "Third", 21).get("id");
        desk.tier(m("timersPerAgent", 2));
        desk.provider.then(Step.answer(USAGE, "One.")).then(Step.answer(USAGE, "Two."));

        clock.advance(Duration.ofMinutes(25));
        desk.team.timers().runDue();
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(timer(agent, a)).containsEntry("lastState", "ok"));

        desk.team.timers().runDue();
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(timer(agent, b)).containsEntry("lastState", "ok"));
        assertThat(timer(agent, c)).containsEntry("lastState", "over_cap").containsEntry("enabled", false);
        assertThat(desk.thread(agent).stream().filter(x -> "user".equals(x.get("role")))).hasSize(2);
    }

    @Test
    void anIntervalUnderTheMinimumRunsAtTheMinimum() throws Exception {
        desk.tier(m("timerMinMinutes", 5));
        String agent = agent("Clerk");
        Map<String, Object> set = map(desk.call("agent.timer.set", "agentId", agent, "timer", m("label", "Often", "kind",
                "repeat", "everyMinutes", 5, "prompt", "Again.")).get("timer"));
        String id = (String) set.get("id");
        long anchor = ((Number) set.get("createdAt")).longValue();
        desk.tier(m("timerMinMinutes", 15));
        desk.provider.then(Step.answer(USAGE, "Once."));

        clock.advance(Duration.ofMinutes(6));
        desk.team.timers().runDue();
        desk.reply(agent, 2);

        assertThat(((Number) timer(agent, id).get("nextAt")).longValue()).isEqualTo(anchor + 15 * 60_000L);
    }

    @Test
    void agentsOverTheCapArePausedOldestKeptAndTheirRunsRefused() throws Exception {
        String first = agent("First");
        String second = agent("Second");
        String third = agent("Third");
        desk.tier(m("agentCap", 2));

        assertThat(desk.agentView(first)).containsEntry("status", "online");
        assertThat(desk.agentView(second)).containsEntry("status", "paused").containsEntry("statusDetail", "agent_cap");
        assertThat(desk.agentView(third)).containsEntry("status", "paused");
        assertThat(desk.agentView("manager").get("status")).isNotEqualTo("paused");
        RpcError e = desk.refused("agent.message.send", "agentId", second, "text", "Hi.");
        assertThat(e.code()).isEqualTo("precondition_failed");
        assertThat(e.details()).containsEntry("reason", "agent_cap");
        assertThat(desk.team.pausedAgents()).containsExactlyInAnyOrder(second, third);

        desk.tier(m("agentCap", 10));
        assertThat(desk.agentView(second).get("status")).isNotEqualTo("paused");
    }

    @Test
    void theDeskWideTimerCapHoldsWhenAgentsOutnumberTheCap() throws Exception {
        List<String> agents = List.of(agent("A"), agent("B"), agent("C"), agent("D"));
        for (String agent : agents) {
            once(agent, "One", 60);
        }
        desk.tier(m("agentCap", 2, "timersPerAgent", 2));

        RpcError e = desk.refused("agent.timer.set", "agentId", agents.get(0), "timer",
                m("label", "More", "kind", "once", "inMinutes", 90, "prompt", "More."));

        assertThat(e.details()).containsEntry("reason", "timer_cap");
    }

    @Test
    void aDayNumberThatWrapsAroundIsRefused() throws Exception {
        String agent = agent("Clerk");
        Map<String, Object> repeat = m("label", "Odd", "kind", "repeat", "days", List.of(4294967297L), "time", "08:00",
                "prompt", "Go.");
        assertThat(desk.refused("agent.timer.set", "agentId", agent, "timer", repeat).details())
                .containsEntry("detail", "days");
    }

    // ---------------------------------------------------------------- run slots (Security T49M-1)

    @Test
    void oneRunSlotIsKeptForTheMembersOwnRuns() throws Exception {
        List<String> agents = List.of(agent("A"), agent("B"), agent("C"), agent("D"));
        List<CountDownLatch> holds = new java.util.ArrayList<>();
        for (int i = 0; i < 4; i++) {
            CountDownLatch hold = new CountDownLatch(1);
            holds.add(hold);
            desk.provider.then(Step.answer(USAGE, "Held " + i).heldBy(hold));
        }
        try {
            for (int i = 0; i < 3; i++) {
                desk.team.host().start(agents.get(i), "Go.", Map.of("kind", "timer"), Team.Chain.start(agents.get(i)));
            }
            assertThatThrownBy(() -> desk.team.host().start(agents.get(3), "Go.", Map.of("kind", "timer"),
                    Team.Chain.start(agents.get(3)))).isInstanceOfSatisfying(RpcError.class,
                            e -> assertThat(e.details()).containsEntry("reason", "busy"));

            Map<String, Object> sent = desk.call("agent.message.send", "agentId", agents.get(3), "text", "Mine.");
            assertThat(sent).containsKey("runId");
        } finally {
            holds.forEach(CountDownLatch::countDown);
        }
    }

    @Test
    void aTierWithoutAnObjectIsIgnored() {
        Map<String, Object> bad = new HashMap<>();
        bad.put("tier", "oops");
        assertThat(desk.team.setTier(bad.get("tier"))).isFalse();
        assertThat(desk.team.caps()).isEqualTo(TierCaps.DEFAULTS);
    }
}
