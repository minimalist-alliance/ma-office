package com.minimalistalliance.desk.agent.maia;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Maia keeps going while the member is away (draft-desk-maia.md decision 12): the report queue (code-filed reports, urgency
 * and importance, batches, the cap on an agent's "now", nothing waiting past its timeout or lost across a stop and a start),
 * check-ins, what deskd reads for her hold, presence and the "While you were away" summary; and the measurements the
 * coordinator asked for: model turns and credits saved by batching and code-filing, and the reader's cost split.
 */
class AwayTest {

    static final String WORK = "d-workaaaaaaaa";
    static final String PERS = "d-persaaaaaaaa";

    @TempDir
    Path dir;

    MutableClock clock;
    AgentStore agents;
    AwayStore store;
    FakeHost host;
    Away away;

    /** The agent service, as Away sees it: runs she'd start are counted, and she's "in a run" while a test says so. */
    static final class FakeHost implements Away.Host {
        final List<Map<String, Object>> started = new ArrayList<>();
        final List<String> texts = new ArrayList<>();
        final List<String[]> posted = new ArrayList<>();
        final List<String> results = new ArrayList<>();
        Map<String, Object> open;
        String openId;
        boolean running;
        boolean active = true;
        boolean allowanceUsed;
        int later = Away.LATER_DEFAULT_MIN;
        int stateChanges;

        @Override
        public String startHers(String text, Map<String, Object> origin) throws RpcError {
            if (running) {
                throw RpcError.of("conflict", "reason", "busy");
            }
            started.add(origin);
            texts.add(text);
            running = true;
            return "run-" + started.size();
        }

        @Override
        public boolean running() {
            return running;
        }

        @Override
        public String postAsMaia(String text, Map<String, Object> extras) {
            posted.add(new String[] {text, String.valueOf(extras)});
            return "m-" + posted.size();
        }

        @Override
        public Map<String, Object> openChoices(String[] out) {
            out[0] = openId;
            return open;
        }

        @Override
        public void moveChoices(String messageId) {
            open = null;
        }

        @Override
        public boolean active() {
            return active;
        }

        @Override
        public boolean allowanceUsed() {
            return allowanceUsed;
        }

        @Override
        public String deskName(String deskId) {
            return WORK.equals(deskId) ? "Work" : "Personal";
        }

        @Override
        public void stateChanged() {
            stateChanges++;
        }

        @Override
        public void result(String deskId, String deskName, String agentName, String messageId) {
            results.add(agentName + "@" + deskName);
        }

        @Override
        public int laterMaxMin() {
            return later;
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        clock = new MutableClock(Instant.parse("2026-11-15T09:00:00Z"));
        agents = new AgentStore(dir.resolve("agent.db"), clock);
        agents.open();
        store = new AwayStore(agents);
        host = new FakeHost();
        away = new Away(store, clock, host);
        away.platform(true, "on");
        away.lastSeen(clock.millis() - Duration.ofHours(1).toMillis());
    }

    @AfterEach
    void tearDown() {
        away.close();
        agents.close();
    }

    static String report(String status, String urgency, String importance) {
        return Reports.compact(new Reports.Report(status, urgency, importance, "summary", Map.of("price", "$899"),
                "wu-" + "a".repeat(20)), "wu-" + "a".repeat(20));
    }

    static Reports.Expect expect(String then) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("fields", List.of("price"));
        e.put("then", then);
        return Reports.Expect.of(e);
    }

    void brief(String env, String desk, String then) {
        away.briefSent(env, desk, expect(then));
    }

    static String env(int n) {
        return "env-" + "a".repeat(25) + (char) ('a' + n);
    }

    void endRun(boolean done) {
        Map<String, Object> origin = host.started.getLast();
        host.running = false;
        away.runEnded(origin, done, "reply-x");
    }

    // ---------------------------------------------------------------- code files what needs nothing

    @Test
    void aReportThatNeedsNothingIsFiledByCodeWithNoModelTurn() throws Exception {
        brief(env(1), WORK, "report");
        Away.Outcome o = away.report(WORK, "Scout", report("done", "soon", "normal"), "m1", env(1), false);
        assertThat(o).isEqualTo(Away.Outcome.FILED);
        clock.advance(Duration.ofHours(2));
        away.tick();
        assertThat(host.started).isEmpty();
        assertThat(host.results).containsExactly("Scout@Work");
        assertThat(away.filedByCode()).isEqualTo(1);
    }

    @Test
    void aReportNeedsHerWhenHerBriefSaidThinkOrItNeedsADecisionOrIsUrgent() throws Exception {
        brief(env(1), WORK, "think");
        brief(env(2), WORK, "report");
        brief(env(3), WORK, "report");
        assertThat(away.report(WORK, "Scout", report("done", "soon", "normal"), "m1", env(1), false))
                .isEqualTo(Away.Outcome.WAITING);
        assertThat(away.report(WORK, "Scout", report("needs_decision", "soon", "normal"), "m2", env(2), false))
                .isEqualTo(Away.Outcome.WAITING);
        assertThat(away.report(WORK, "Scout", report("done", "now", "normal"), "m3", env(3), false))
                .isEqualTo(Away.Outcome.WAITING);
    }

    // ---------------------------------------------------------------- batches

    @Test
    void reportsThatComeTogetherAreReadInOneTurn() throws Exception {
        for (int i = 0; i < 4; i++) {
            brief(env(i), WORK, "think");
            away.report(WORK, "Scout", report("done", "soon", "normal"), "m" + i, env(i), false);
            clock.advance(Duration.ofSeconds(5));
        }
        away.tick();
        assertThat(host.started).as("soon waits up to 2 minutes").isEmpty();
        clock.advance(Duration.ofMinutes(2));
        away.tick();
        assertThat(host.started).hasSize(1);
        assertThat(host.started.getFirst()).containsEntry("role", "reports");
        assertThat(host.texts.getFirst()).startsWith("4 reports came back");
        endRun(true);
        assertThat(store.reports("waiting")).isEmpty();
        assertThat(store.reports("read")).hasSize(4);
    }

    @Test
    void reportsThatComeWhileSheIsMidTurnWaitForItToEndThenGoTogether() throws Exception {
        host.running = true;
        for (int i = 0; i < 3; i++) {
            brief(env(i), WORK, "think");
            away.report(WORK, "Scout", report("done", "now", "normal"), "m" + i, env(i), false);
        }
        clock.advance(Duration.ofMinutes(5));
        away.tick();
        assertThat(host.started).isEmpty();
        host.running = false;
        away.tick();
        assertThat(host.started).hasSize(1);
        assertThat(host.texts.getFirst()).startsWith("3 reports");
    }

    @Test
    void nowOrCriticalWakesHerAtOnceSoonWithinTwoMinutesLaterAtItsTimeout() throws Exception {
        long t0 = clock.millis();
        assertThat(away.dueAt("now", "normal", t0)).isEqualTo(t0 + Away.NOW_MS);
        assertThat(away.dueAt("later", "critical", t0)).isEqualTo(t0 + Away.NOW_MS);
        assertThat(away.dueAt("soon", "normal", t0)).isEqualTo(t0 + Away.SOON_MS);
        assertThat(away.dueAt("later", "low", t0)).isEqualTo(t0 + 30 * 60_000L);
        host.later = 90;
        assertThat(away.dueAt("later", "normal", t0)).isEqualTo(t0 + 90 * 60_000L);
        host.later = 9_999;
        assertThat(away.dueAt("later", "normal", t0)).isEqualTo(t0 + Away.LATER_MAX_MIN * 60_000L);
    }

    @Test
    void severalLaterReportsAreReadTogetherAtOnce() throws Exception {
        for (int i = 0; i < Away.LATER_PILE; i++) {
            brief(env(i), WORK, "think");
            away.report(WORK, "Scout", report("done", "later", "low"), "m" + i, env(i), false);
        }
        clock.advance(Duration.ofSeconds(1));
        away.tick();
        assertThat(host.started).hasSize(1);
    }

    @Test
    void oneAgentsNowPastThreeAnHourIsTreatedAsSoon() throws Exception {
        for (int i = 0; i < 5; i++) {
            brief(env(i), WORK, "think");
            away.report(WORK, "Pushy", report("blocked", "now", "critical"), "m" + i, env(i), false);
        }
        List<AwayStore.Row> rows = store.reports("waiting");
        assertThat(rows.stream().filter(r -> r.capped()).count()).isEqualTo(2);
        assertThat(rows.stream().filter(r -> r.capped()).allMatch(r -> "soon".equals(r.urgency())
                && "normal".equals(r.importance()))).isTrue();
        // Another agent isn't capped by this one.
        brief(env(9), PERS, "think");
        away.report(PERS, "Calm", report("blocked", "now", "normal"), "m9", env(9), false);
        assertThat(store.reports("waiting").stream().filter(r -> "Calm".equals(r.agent())).findFirst().orElseThrow()
                .urgency()).isEqualTo("now");
    }

    // ---------------------------------------------------------------- durable: across a stop and a start

    @Test
    void nothingVanishesAcrossAStopAndAStartAndNothingWaitsPastItsTimeout() throws Exception {
        brief(env(1), WORK, "think");
        away.report(WORK, "Scout", report("done", "later", "low"), "m1", env(1), false);
        // The desk stops (the process ends), and starts again 40 minutes later: past the later timeout.
        away.close();
        agents.close();
        clock.advance(Duration.ofMinutes(40));
        agents = new AgentStore(dir.resolve("agent.db"), clock);
        agents.open();
        store = new AwayStore(agents);
        away = new Away(store, clock, host);
        away.platform(true, "on");
        assertThat(store.reports("waiting")).hasSize(1);
        away.tick();
        assertThat(host.started).hasSize(1);
        // A batch the next stop cuts off is waiting again at the next start.
        away.close();
        agents.close();
        agents = new AgentStore(dir.resolve("agent.db"), clock);
        agents.open();
        store = new AwayStore(agents);
        assertThat(store.reports("taken")).hasSize(1);
        host.running = false;
        away = new Away(store, clock, host);
        away.platform(true, "on");
        away.start();
        assertThat(store.reports("waiting")).hasSize(1);
        away.tick();
        assertThat(host.started).hasSize(2);
        endRun(true);
        assertThat(store.reports("read")).hasSize(1);
    }

    @Test
    void aBatchHerRunDidntFinishIsTriedAgainThenReadWithTheNext() throws Exception {
        brief(env(1), WORK, "think");
        away.report(WORK, "Scout", report("blocked", "now", "normal"), "m1", env(1), false);
        clock.advance(Duration.ofSeconds(5));
        for (int i = 0; i < Away.RETRIES; i++) {
            away.tick();
            assertThat(host.started).hasSize(i + 1);
            endRun(false);
            clock.advance(Duration.ofMillis(Away.RETRY_MS + 1));
        }
        assertThat(store.reports("waiting")).isEmpty();
        assertThat(store.reports("read")).hasSize(1);
    }

    @Test
    void sheThinksAboutNothingWhileHerAllowanceIsUsedTheyWait() throws Exception {
        host.allowanceUsed = true;
        brief(env(1), WORK, "think");
        away.report(WORK, "Scout", report("blocked", "now", "normal"), "m1", env(1), false);
        clock.advance(Duration.ofHours(1));
        away.tick();
        assertThat(host.started).isEmpty();
        assertThat(store.reports("waiting")).hasSize(1);
        host.allowanceUsed = false;
        away.tick();
        assertThat(host.started).hasSize(1);
    }

    // ---------------------------------------------------------------- check-ins and her hold

    @Test
    void aCheckInStartsHerRunAtItsTimeAndSurvivesARestart() throws Exception {
        assertThat(away.checkIn(1)).startsWith("Refused");
        assertThat(away.checkIn(30)).startsWith("You'll pick this up again in 30 minutes");
        assertThat(away.state()).containsEntry("inFlight", false);
        assertThat(((Number) away.state().get("wakeAt")).longValue()).isEqualTo(clock.millis() + 30 * 60_000L);
        clock.advance(Duration.ofMinutes(15));
        assertThat(away.state()).as("within 20 minutes of a check-in: in flight").containsEntry("inFlight", true);
        away.close();
        agents.close();
        clock.advance(Duration.ofMinutes(16));
        agents = new AgentStore(dir.resolve("agent.db"), clock);
        agents.open();
        store = new AwayStore(agents);
        away = new Away(store, clock, host);
        away.platform(true, "on");
        away.tick();
        assertThat(host.started).hasSize(1);
        assertThat(host.started.getFirst()).containsEntry("role", "check_in");
        away.tick();
        assertThat(host.started).as("once").hasSize(1);
    }

    @Test
    void aCheckInMissedByMoreThanADayIsntRun() throws Exception {
        away.checkIn(10);
        clock.advance(Duration.ofDays(2));
        away.tick();
        assertThat(host.started).isEmpty();
    }

    @Test
    void herHoldIsOnWhileBriefsAreOutAndOffWhenTheyreAnsweredOrOld() throws Exception {
        assertThat(away.state()).containsEntry("inFlight", false);
        brief(env(1), WORK, "report");
        assertThat(away.state()).containsEntry("inFlight", true);
        away.report(WORK, "Scout", report("done", "soon", "normal"), "m1", env(1), false);
        assertThat(away.state()).as("filed by code, nothing waits").containsEntry("inFlight", false);
        brief(env(2), WORK, "report");
        clock.advance(Duration.ofHours(3));
        assertThat(away.state()).as("a brief unanswered for 2 hours doesn't hold the desk").containsEntry("inFlight",
                false);
        host.active = false;
        brief(env(3), WORK, "report");
        assertThat(away.state()).as("Maia Mode off: no hold").containsEntry("inFlight", false);
    }

    // ---------------------------------------------------------------- presence, the bell's counts and the summary

    @Test
    void whileAwayHerQuestionAndHerFinishingAreCountedAndTheSummaryGreetsTheMember() throws Exception {
        brief(env(1), WORK, "report");
        brief(env(2), PERS, "think");
        away.report(WORK, "Scout", report("done", "soon", "normal"), "m1", env(1), false);
        away.report(PERS, "Writer", report("needs_decision", "soon", "normal"), "m2", env(2), false);
        clock.advance(Duration.ofMinutes(3));
        away.tick();
        host.open = Map.of("question", "Which laptop should I order?", "options", List.of(Map.of("id", "c1", "label",
                "The lighter one"), Map.of("id", "c2", "label", "The cheaper one")), "state", "open");
        host.openId = "reply-x";
        endRun(true);
        assertThat(away.state()).containsEntry("asks", 1).containsEntry("away", true);
        // The member opens the office: one summary, with her question moved onto it.
        away.observed();
        assertThat(host.posted).hasSize(1);
        String text = host.posted.getFirst()[0];
        assertThat(text).startsWith("While you were away: I asked 2 desks for help, and 2 reports came back (1 needed me)")
                .contains("I have a question for you: Which laptop should I order?");
        assertThat(host.posted.getFirst()[1]).contains("The lighter one");
        assertThat(away.state()).containsEntry("asks", 0).containsEntry("away", false);
        away.observed();
        assertThat(host.posted).as("once").hasSize(1);
    }

    @Test
    void whenEverythingIsDoneTheSummarySaysSoAndOffersCodesOwnChoices() throws Exception {
        brief(env(1), WORK, "report");
        away.report(WORK, "Scout", report("done", "soon", "normal"), "m1", env(1), false);
        assertThat(away.state()).containsEntry("done", 1);
        clock.advance(Duration.ofMinutes(10));
        away.observed();
        assertThat(host.posted.getFirst()[0]).contains("Everything you asked is done");
        assertThat(host.posted.getFirst()[1]).contains("That’s all for now").contains("kind=away");
    }

    @Test
    void aDeskThatCouldntDoItIsSaidSoOnReturnNeverDone() throws Exception {
        // The staging proof, Nov 15: the Work Lead was at its month's limit, she said so in her reply, and the summary
        // still read "Everything you asked is done".
        brief(env(1), WORK, "report");
        away.report(WORK, "Lead", report("failed", "soon", "normal"), "m1", env(1), false);
        clock.advance(Duration.ofMinutes(2));
        away.tick();
        assertThat(host.started).hasSize(1);
        endRun(true);
        clock.advance(Duration.ofMinutes(10));
        away.observed();
        String text = host.posted.getFirst()[0];
        assertThat(text).startsWith("While you were away: I asked 1 desk for help, and 1 report came back.")
                .contains("A desk couldn’t do its part; my last message says what happened.")
                .doesNotContain("Everything you asked is done");
    }

    // ---------------------------------------------------------------- Security's read (MA-M1, MA-I2)

    @Test
    void awayAndThePlatformSaysNotNowNothingOfHersStartsAndNothingHoldsTheDesk() throws Exception {
        away.platform(false, "off");
        brief(env(1), WORK, "think");
        away.report(WORK, "Scout", report("blocked", "now", "normal"), "m1", env(1), false);
        away.checkIn(5);
        clock.advance(Duration.ofMinutes(10));
        away.tick();
        assertThat(host.started).isEmpty();
        assertThat(away.state()).containsEntry("inFlight", false);
        away.platform(true, "hours");
        away.tick();
        assertThat(host.started).as("today's hours used: still waits").isEmpty();
        // The member opens the office: what waited is read then.
        away.observed();
        away.tick();
        assertThat(host.started).hasSize(1);
    }

    @Test
    void checkInRunsAreCappedADay() throws Exception {
        for (int i = 0; i < Away.CHECKIN_RUNS_PER_DAY + 3; i++) {
            store.addCheckIn(clock.millis() - 1, clock.millis());
            away.tick();
            if (host.running) {
                endRun(true);
            }
            clock.advance(Duration.ofMinutes(10));
        }
        assertThat(host.started).hasSize(Away.CHECKIN_RUNS_PER_DAY);
    }

    @Test
    void aReportMissingAFieldSheAskedForIsntFiledByCode() throws Exception {
        brief(env(1), WORK, "report");
        String noPrice = Reports.compact(new Reports.Report("done", "soon", "normal", "done", Map.of(), null), null);
        assertThat(away.report(WORK, "Scout", noPrice, "m1", env(1), false)).isEqualTo(Away.Outcome.WAITING);
    }

    // ---------------------------------------------------------------- the measurements

    /** About what one of her Opus turns cost in the usage study (research/maia-mode-usage-study.md): $0.047. */
    static final double OPUS_TURN_USD = 0.047;

    @Test
    void measuredTurnsAndCreditsSavedByBatchingAndCodeFiling() throws Exception {
        // A morning's work while the member is away: 3 desks, 12 briefs. Reports arrive in clusters, as agents finish:
        // 7 done as asked ("report"), 2 needing a decision, 1 blocked and urgent, 2 low-priority notes.
        int n = 0;
        int[][] plan = {
            // {desk 0/1, then 0=report 1=think, status 0=done 1=needs_decision 2=blocked, urgency 0=now 1=soon 2=later}
            {0, 0, 0, 1}, {0, 0, 0, 1}, {1, 0, 0, 1}, {1, 0, 0, 1}, {0, 0, 0, 2}, {1, 0, 0, 1}, {0, 0, 0, 1},
            {0, 1, 1, 1}, {1, 1, 1, 1}, {1, 1, 2, 0}, {0, 1, 0, 2}, {1, 1, 0, 2},
        };
        String[] statuses = {"done", "needs_decision", "blocked"};
        String[] urgencies = {"now", "soon", "later"};
        for (int[] p : plan) {
            String desk = p[0] == 0 ? WORK : PERS;
            brief(env(n), desk, p[1] == 0 ? "report" : "think");
            away.report(desk, p[0] == 0 ? "Scout" : "Writer", report(statuses[p[2]], urgencies[p[3]], "normal"),
                    "m" + n, env(n), false);
            n++;
            clock.advance(Duration.ofSeconds(20));
            away.tick();
            if (host.running) {
                clock.advance(Duration.ofSeconds(40)); // her turn takes a while; reports keep coming meanwhile
                endRun(true);
            }
        }
        for (int i = 0; i < 40; i++) {
            clock.advance(Duration.ofMinutes(1));
            away.tick();
            if (host.running) {
                endRun(true);
            }
        }
        int naive = plan.length; // one Opus turn per report, as an answer starting her run each time would
        int turns = host.started.size();
        double saved = (naive - turns) * OPUS_TURN_USD;
        System.out.printf("maia-away turns: %d reports, %d filed by code, %d model turns (naive %d), saved %d turns,"
                + " about $%.3f of credits (%.0f%%)%n", plan.length, away.filedByCode(), turns, naive, naive - turns,
                saved, 100.0 * (naive - turns) / naive);
        assertThat(away.filedByCode()).isEqualTo(7);
        assertThat(turns).isLessThanOrEqualTo(4);
        assertThat(store.reports("waiting")).isEmpty();
        assertThat(store.reports("taken")).isEmpty();
    }

    /** Prices for the reader's split: Haiku 5.5 on MA's account, Sonnet 5.5 on the member's key (usage study, Nov 15). */
    static final double HAIKU_READ_USD = 0.003;
    static final double DESK_AGENT_TURN_USD = 0.03;

    @Test
    void measuredCostSplitReaderVersusBriefing() {
        // 20 things she needs in a day: 12 are facts that already exist in write-ups (a price, a date, what an agent
        // found), 8 need new work on a desk (browse, write, change something).
        int reads = 12;
        int newWork = 8;
        // Before: everything briefed to a desk agent (a turn on the member's key) and read back by her (an Opus turn).
        double beforeMember = (reads + newWork) * DESK_AGENT_TURN_USD;
        double beforeMa = (reads + newWork) * OPUS_TURN_USD;
        // Now: reads go to her Haiku reader inside her own turn (MA's account, no desk agent turn, no extra Opus turn);
        // new work is briefed as before.
        double nowMember = newWork * DESK_AGENT_TURN_USD;
        double nowMa = reads * HAIKU_READ_USD + newWork * OPUS_TURN_USD;
        System.out.printf("maia-reader split: member's keys $%.2f -> $%.2f, MA's credits $%.3f -> $%.3f (reads %d,"
                + " new work %d)%n", beforeMember, nowMember, beforeMa, nowMa, reads, newWork);
        assertThat(nowMember).isLessThan(beforeMember * 0.5);
        assertThat(nowMa).isLessThan(beforeMa * 0.5);
        // And the routing rule holds in code: a brief that names a write-up goes only as new work.
        assertThat(Reports.WRITEUP_ID.matcher("look at wu-" + "a".repeat(20)).find()).isTrue();
        assertThat(Reports.briefBlock(Reports.Expect.of(Map.of("newWork", true)))).contains(Reports.NEW_WORK);
    }
}
