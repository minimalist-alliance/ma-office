package com.minimalistalliance.desk.agent.tool;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.tool.ResumeRig.Decision;
import com.minimalistalliance.desk.agent.tool.ResumeRig.Fault;
import com.minimalistalliance.desk.agent.tool.ResumeRig.Kind;
import com.minimalistalliance.desk.agent.tool.ResumeRig.Point;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.SplittableRandom;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Durable runs' property test (the sizing's §4): {@value #DEFAULT_RUNS} seeded runs, each with random steps of random
 * calls, the member's random decisions (yes, no, or no answer until the card expires) and a random fault (a kill, deskd
 * restarted, a pause, a desk stop) at a random point, or two, or none. It holds when, in every run:
 * <ul>
 *   <li>no gated tool runs without a relayed decision (deskd's tickets, used once, and the member's switch);
 *   <li>no key takes effect twice, and no call runs twice under any key;
 *   <li>taint and caps never shrink across a fault;
 *   <li>every approval and run ends (the reply {@code done}, every card and call record final, the model answered
 *       for every call it made), having resumed after each fault.
 * </ul>
 * {@code -Dresume.runs=N} and {@code -Dresume.seed=S} run more, or one seed again.
 */
class ResumePropertyTest {

    static final int DEFAULT_RUNS = 1000;

    @TempDir
    Path root;

    @Test
    void aThousandSeededRunsWithRandomDecisionsAndFaultsHoldEveryProperty() throws Exception {
        int runs = Integer.getInteger("resume.runs", DEFAULT_RUNS);
        long first = Long.getLong("resume.seed", 1L);
        List<String> broken = new ArrayList<>();
        int faulted = 0;
        int resumed = 0;
        for (long seed = first; seed < first + runs; seed++) {
            Path data = Files.createDirectories(root.resolve("s" + seed));
            String plan = "";
            try (ResumeRig rig = new ResumeRig(data, new MutableClock(Rig.START))) {
                plan = draw(rig, new SplittableRandom(seed));
                rig.send("Seed " + seed + ".");
                Map<String, Object> reply = rig.drive();
                List<String> violations = rig.check(reply);
                if (!"done".equals(reply.get("state"))) {
                    violations = new ArrayList<>(violations);
                    violations.add("ended " + reply.get("state") + " " + reply.get("error") + " "
                            + reply.get("errorDetail"));
                }
                if (!violations.isEmpty()) {
                    broken.add("seed " + seed + " (" + plan + "): " + violations);
                }
                faulted += rig.faults > 0 ? 1 : 0;
                resumed += reply.get("resumed") instanceof Number n && n.intValue() > 0 ? 1 : 0;
            } catch (AssertionError | Exception e) {
                broken.add("seed " + seed + " (" + plan + "): " + e);
            }
            if (broken.size() >= 10) {
                break;
            }
        }
        assertThat(broken).isEmpty();
        // The faults did strike: most runs were cut off somewhere and picked up.
        assertThat(faulted).isGreaterThan(runs / 2);
        assertThat(resumed).isGreaterThan(runs / 2);
    }

    /** A random run: its steps, the member's decisions and its fault(s). @return what was drawn, for a failure */
    private static String draw(ResumeRig rig, SplittableRandom random) {
        StringBuilder plan = new StringBuilder();
        int steps = 1 + random.nextInt(3);
        for (int s = 1; s <= steps; s++) {
            int n = 1 + random.nextInt(3);
            Kind[] kinds = new Kind[n];
            for (int i = 0; i < n; i++) {
                kinds[i] = ResumeRig.KINDS.get(random.nextInt(ResumeRig.KINDS.size()));
            }
            rig.step(kinds);
            for (int i = 0; i < n; i++) {
                int d = random.nextInt(100);
                Decision decision = d < 70 ? Decision.APPROVE : d < 85 ? Decision.DECLINE : Decision.EXPIRE;
                rig.decide(s, i, decision);
                plan.append(kinds[i]).append(kinds[i] == Kind.WRITE || kinds[i] == Kind.SEND || kinds[i] == Kind.SPEND
                        ? "/" + decision : "").append(i + 1 < n ? "," : "");
            }
            plan.append(s < steps ? "; " : "");
        }
        if (random.nextInt(100) >= 10) {
            Point point;
            Fault fault;
            do {
                point = Point.values()[random.nextInt(Point.values().length)];
                fault = Fault.values()[random.nextInt(Fault.values().length)];
            } while (!fault.at(point));
            int nth = 1 + random.nextInt(point == Point.MODEL ? steps + 1 : 2);
            rig.fault(point, nth, fault);
            plan.append(" | ").append(point).append('#').append(nth).append(' ').append(fault);
            if (random.nextInt(100) < 25) {
                // A second fault, in the desk that resumed after the first.
                do {
                    point = Point.values()[random.nextInt(Point.values().length)];
                    fault = Fault.values()[random.nextInt(Fault.values().length)];
                } while (!fault.at(point));
                nth = 1 + random.nextInt(2);
                rig.fault(point, nth, fault);
                plan.append(" then ").append(point).append('#').append(nth).append(' ').append(fault);
            }
        }
        return plan.toString();
    }
}
