package com.minimalistalliance.desk.agent.tool;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
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
import java.util.stream.Stream;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Durable runs' kill tests (the draft ADR's §17 "Faults"; the durable runs sizing's fault injection): one call of each
 * kind, the fault at every point on its run's path, each fault kind. Every case ends {@code done}, with the call run at
 * most once and only on the member's yes or switch, every card and record ended, the model answered for every call, and
 * taint and gate counts never lower after the fault ({@link ResumeRig#check}). Where it matters, what the call came to:
 * deskd's kept result after a kill (exactly once), {@code interrupted} after deskd lost it, never re-run.
 */
class ResumeKillTest {

    @TempDir
    Path root;

    /** A kind of call, and what the member does with its card. */
    record Case(Kind kind, Decision decision, Point point, int nth, Fault fault) {
        boolean asks() {
            return kind == Kind.WRITE || kind == Kind.SEND || kind == Kind.SPEND;
        }

        boolean hosted() {
            return kind != Kind.OWN;
        }

        @Override
        public String toString() {
            return kind + (asks() ? "/" + decision : "") + " " + point + "#" + nth + " " + fault;
        }
    }

    static Stream<Arguments> cases() {
        List<Arguments> out = new ArrayList<>();
        List<Object[]> kinds = List.of(new Object[] {Kind.READ, Decision.APPROVE},
                new Object[] {Kind.WRITE, Decision.APPROVE}, new Object[] {Kind.WRITE, Decision.DECLINE},
                new Object[] {Kind.WRITE, Decision.EXPIRE}, new Object[] {Kind.SEND, Decision.APPROVE},
                new Object[] {Kind.SPEND, Decision.APPROVE}, new Object[] {Kind.AUTO, Decision.APPROVE},
                new Object[] {Kind.OWN, Decision.APPROVE});
        for (Object[] k : kinds) {
            for (Point point : Point.values()) {
                for (Fault fault : Fault.values()) {
                    Case c = new Case((Kind) k[0], (Decision) k[1], point, 1, fault);
                    if (!fault.at(point) || (point == Point.CARD && !c.asks())
                            || (point == Point.DESKD && !c.hosted())) {
                        continue;
                    }
                    out.add(Arguments.of(c));
                }
                // And the second model call: the fault between the steps.
            }
            for (Fault fault : Fault.values()) {
                out.add(Arguments.of(new Case((Kind) k[0], (Decision) k[1], Point.MODEL, 2, fault)));
            }
        }
        return out.stream();
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("cases")
    void everyCaseEndsAndNothingRunsTwice(Case c) throws Exception {
        Path data = Files.createDirectories(root.resolve("d"));
        try (ResumeRig rig = new ResumeRig(data, new MutableClock(Rig.START))) {
            rig.step(c.kind()).decide(1, 0, c.decision()).fault(c.point(), c.nth(), c.fault());
            rig.send("Do it.");
            Map<String, Object> reply = rig.drive();

            assertThat(rig.check(reply)).as(c.toString()).isEmpty();
            assertThat(reply.get("state")).as(c.toString()).isEqualTo("done");
            String path = ResumeRig.pathOf(rig.script.get(0).get(0));
            List<Map<String, Object>> ran = rig.deskd.executed.stream().filter(e -> path.equals(e.get("path")))
                    .toList();
            String result = rig.resultFor(path);
            boolean struck = rig.faults > 0;
            if (struck) {
                assertThat(reply.get("resumed")).as(c.toString()).isEqualTo(1);
            }
            if (c.kind() == Kind.AUTO) {
                // Done without asking under the member's switch, before and after the fault: never a card.
                assertThat(list(rig.desk.call("agent.approvals.list", "agentId", rig.agent, "state", "all")
                        .get("approvals"))).as(c.toString()).allSatisfy(card -> assertThat(card.get("decidedBy"))
                                .isEqualTo("auto"));
            }
            if (!c.hosted()) {
                // The agent's own, in desk-agent: started and cut off, it may have happened, so it ends interrupted.
                if (struck && c.point() == Point.STARTED) {
                    assertThat(result).as(c.toString()).startsWith("Interrupted: restart.");
                }
                return;
            }
            if (c.asks() && c.decision() != Decision.APPROVE) {
                assertThat(ran).as(c.toString()).isEmpty();
                return;
            }
            assertThat(ran.size()).as(c.toString()).isLessThanOrEqualTo(1);
            if (!struck) {
                return;
            }
            switch (c.point()) {
                case STARTED -> {
                    // The record was down and nothing was sent: deskd holds no such key, so it never runs, and says so.
                    assertThat(ran).as(c.toString()).isEmpty();
                    assertThat(result).as(c.toString()).contains(c.kind() == Kind.READ ? "Failed: restart."
                            : "Interrupted: key_unknown.");
                }
                case DESKD -> {
                    assertThat(ran).as(c.toString()).hasSize(1);
                    if (c.kind() == Kind.READ) {
                        assertThat(result).as(c.toString()).contains("Failed: restart.");
                    } else if (c.fault().deskd) {
                        // deskd restarted: its kept reply is gone, so it may have happened. Interrupted, never re-run.
                        assertThat(result).as(c.toString()).contains("Interrupted: key_unknown.");
                        cardIs(rig, path, "interrupted", c);
                    } else {
                        // deskd kept it: asked again by its key, the real result, exactly once.
                        assertThat(result).as(c.toString()).contains("did " + path);
                        cardIs(rig, path, "done", c);
                    }
                }
                default -> {
                    if (c.point() == Point.ADMITTED && c.fault().deskd && c.asks()) {
                        // Approved, then deskd lost the member's ticket before it ran: it runs only on a relayed yes.
                        assertThat(ran).as(c.toString()).isEmpty();
                        assertThat(result).as(c.toString()).contains("approval_unknown");
                    } else {
                        assertThat(ran).as(c + " model read: " + result).hasSize(1);
                        assertThat(result).as(c.toString()).contains("did " + path);
                    }
                }
            }
        }
    }

    private static void cardIs(ResumeRig rig, String path, String state, Case c) throws Exception {
        if (!c.asks()) {
            return;
        }
        List<Map<String, Object>> cards = list(rig.desk.call("agent.approvals.list", "agentId", rig.agent, "state",
                "all").get("approvals"));
        assertThat(cards).as(c.toString()).filteredOn(card -> path.equals(map(card.get("payload")).get("path")))
                .singleElement().satisfies(card -> assertThat(card.get("state")).isEqualTo(state));
    }
}
