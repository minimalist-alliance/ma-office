package com.minimalistalliance.desk.agent.maia.eval;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.maia.Shield;
import com.minimalistalliance.desk.agent.maia.eval.ShieldReplay.Arm;
import com.minimalistalliance.desk.agent.maia.eval.ShieldReplay.Log;
import com.minimalistalliance.desk.agent.maia.eval.ShieldRubric.Score;
import com.minimalistalliance.desk.agent.maia.eval.ShieldScenarios.Day;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The focus shield's scenario-day evals (the shield concept §13): 9 personas × 3 days, replayed against the real code
 * under four arms, scored with the EA rubric by code. Deterministic and free: no model is called. The pass bar for the
 * default (arm D): G1 and G2 on all 27 days, every criterion averaging 3 or more on every persona, the overall mean
 * 3.4 or more; and arm A (everything at once) far below on criteria 1 and 2, or the scenarios aren't realistic enough.
 * The report goes to {@code target/shield-evals.md}.
 */
class ShieldScenarioEvalTest {

    static final String[] NAMES = {"Protected focus", "Right moment", "Close first", "Packaging", "Cheap switch",
        "Calm rhythm", "Learned", "Documents"};

    @Test
    void theShieldPassesTheExecutiveAssistantRubricOnEveryScenarioDay() throws IOException {
        List<Day> days = ShieldScenarios.all();
        assertThat(days).hasSize(27);
        Map<Arm, List<Score>> byArm = new LinkedHashMap<>();
        Map<Arm, List<Log>> logs = new LinkedHashMap<>();
        for (Arm arm : Arm.values()) {
            List<Score> scores = new ArrayList<>();
            List<Log> ls = new ArrayList<>();
            for (int p = 0; p < 9; p++) {
                for (Log l : ShieldReplay.runPersona(days.subList(p * 3, p * 3 + 3), arm)) {
                    ls.add(l);
                    scores.add(ShieldRubric.score(l));
                }
            }
            byArm.put(arm, scores);
            logs.put(arm, ls);
        }
        StringBuilder md = new StringBuilder("# Focus shield scenario-day evals\n\n");
        md.append("27 days (9 personas × Mon/Tue/Wed), replayed against the real code, 15 s ticks, no model.\n\n");
        md.append("| Arm | G1 days | G2 days | ");
        for (String n : NAMES) {
            md.append(n).append(" | ");
        }
        md.append("Mean |\n|---|---|---|");
        md.append("---|".repeat(NAMES.length + 1)).append('\n');
        for (Arm arm : Arm.values()) {
            List<Score> s = byArm.get(arm);
            md.append("| ").append(arm).append(" | ").append(s.stream().filter(Score::g1).count()).append(" | ")
                    .append(s.stream().filter(Score::g2).count()).append(" | ");
            for (int c = 0; c < NAMES.length; c++) {
                md.append(String.format(Locale.ROOT, "%.2f | ", avg(s, c)));
            }
            md.append(String.format(Locale.ROOT, "%.2f |\n", s.stream().mapToDouble(Score::mean).average()
                    .orElse(0)));
        }
        md.append("\n## Arm D by persona\n\n| Persona | G1 | G2 | ");
        for (String n : NAMES) {
            md.append(n).append(" | ");
        }
        md.append("\n|---|---|---|").append("---|".repeat(NAMES.length)).append('\n');
        List<Score> d = byArm.get(Arm.D);
        for (int p = 0; p < 9; p++) {
            List<Score> ps = d.subList(p * 3, p * 3 + 3);
            md.append("| ").append(days.get(p * 3).persona()).append(" | ")
                    .append(ps.stream().allMatch(Score::g1) ? "yes" : "NO").append(" | ")
                    .append(ps.stream().allMatch(Score::g2) ? "yes" : "NO").append(" | ");
            for (int c = 0; c < NAMES.length; c++) {
                md.append(String.format(Locale.ROOT, "%.2f | ", avg(ps, c)));
            }
            md.append('\n');
        }
        md.append("\n## Arm D notes (first lines per day)\n\n");
        for (int i = 0; i < d.size(); i++) {
            Log l = logs.get(Arm.D).get(i);
            md.append("- **").append(l.day.name()).append("**: interrupts ")
                    .append(l.visuals.stream().filter(v -> v.what().equals("interrupt")).count()).append(", offers ")
                    .append(l.visuals.stream().filter(v -> v.what().equals("offer")).count()).append(", catch-ups ")
                    .append(l.catchupAt.size()).append(", present ")
                    .append(String.format(Locale.ROOT, "%.1f h", l.presentMs / 3_600_000.0)).append("; ")
                    .append(String.join("; ", d.get(i).notes().subList(0, Math.min(6, d.get(i).notes().size()))))
                    .append('\n');
        }
        // Staleness (S17): the median wait of what came at a catch-up, D against C.
        md.append(String.format(Locale.ROOT, "%nStaleness (median wait of items that weren't interrupts): D %.0f min,"
                + " C %.0f min.%n", stale(logs.get(Arm.D)), stale(logs.get(Arm.C))));
        // The bell, wired to Phase 2's (API.md §23): the shield's own at most 6 a day; an approval is rung by its desk.
        long bellsAll = logs.get(Arm.D).stream().mapToLong(l -> l.bells.size()).sum();
        long bellsOwn = logs.get(Arm.D).stream().mapToLong(l -> l.bells.stream().filter(b -> b[1] == 0).count()).sum();
        long bellsMax = logs.get(Arm.D).stream().mapToLong(l -> l.bells.stream().filter(b -> b[1] == 0).count()).max()
                .orElse(0);
        md.append(String.format(Locale.ROOT, "%nBells (D, 27 days): %d in all, %d the shield's own (most in a day %d,"
                + " cap %d), %d approvals rung by their desk. Courier and documents reach the shield through the wire"
                + " shapes (`courier.attention`, `desks[].docs`) and the desk's own parser; Tuesday's calls are"
                + " screen shares.%n", bellsAll, bellsOwn, bellsMax, Shield.BELLS_PER_DAY, bellsAll - bellsOwn));
        Path out = Path.of("target", "shield-evals.md");
        Files.createDirectories(out.getParent());
        Files.writeString(out, md.toString());
        System.out.println(md);

        // The pass bar.
        assertThat(d).as("G1 on every day").allMatch(Score::g1);
        assertThat(d).as("G2 on every day").allMatch(Score::g2);
        for (int p = 0; p < 9; p++) {
            List<Score> ps = d.subList(p * 3, p * 3 + 3);
            for (int c = 0; c < NAMES.length; c++) {
                assertThat(avg(ps, c)).as(days.get(p * 3).persona() + " " + NAMES[c]).isGreaterThanOrEqualTo(3.0);
            }
        }
        assertThat(d.stream().mapToDouble(Score::mean).average().orElse(0)).as("overall").isGreaterThanOrEqualTo(3.4);
        for (Log l : logs.get(Arm.D)) {
            assertThat(l.bells.stream().filter(b -> b[1] == 0).count()).as(l.day.name() + " bells")
                    .isLessThanOrEqualTo(Shield.BELLS_PER_DAY);
        }
        List<Score> a = byArm.get(Arm.A);
        assertThat(avg(a, 0) + avg(a, 1)).as("everything at once is far below on focus and moment")
                .isLessThanOrEqualTo(avg(d, 0) + avg(d, 1) - 3);
    }

    static double avg(List<Score> s, int c) {
        return s.stream().mapToInt(x -> x.c()[c]).average().orElse(0);
    }

    static double stale(List<Log> logs) {
        List<Long> waits = new ArrayList<>();
        for (Log l : logs) {
            for (ShieldScenarios.In i : l.day.incoming()) {
                Long r = l.reached.get(i.id());
                if (r != null && !"interrupt".equals(l.how.get(i.id())) && !"bell".equals(l.how.get(i.id()))) {
                    waits.add((r - i.at()) / 60_000L);
                }
            }
        }
        if (waits.isEmpty()) {
            return 0;
        }
        waits.sort(Long::compare);
        return waits.get(waits.size() / 2);
    }
}
