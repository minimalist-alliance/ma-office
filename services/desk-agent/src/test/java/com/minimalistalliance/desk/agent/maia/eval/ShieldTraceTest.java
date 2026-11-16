package com.minimalistalliance.desk.agent.maia.eval;

import com.minimalistalliance.desk.agent.maia.Shield;
import java.util.List;
import org.junit.jupiter.api.Test;

/** A debugging aid, skipped unless -Dshield.trace=persona,day,HH:MM,HH:MM is given: prints the shield's log for a window. */
class ShieldTraceTest {
    @Test
    void trace() {
        String spec = System.getProperty("shield.trace");
        if (spec == null) {
            return;
        }
        String[] p = spec.split(",");
        int dayIndex = Integer.parseInt(p[1]);
        List<ShieldScenarios.Day> days = ShieldScenarios.all();
        int start = 0;
        for (int i = 0; i < days.size(); i++) {
            if (days.get(i).persona().equals(p[0])) {
                start = i;
                break;
            }
        }
        List<ShieldScenarios.Day> three = days.subList(start, start + 3);
        ShieldReplay.TRACE = p.length > 3 ? p[2] + "-" + p[3] : "";
        ShieldReplay.TRACE_DAY = dayIndex;
        List<ShieldReplay.Log> logs = ShieldReplay.runPersona(three, ShieldReplay.Arm.D);
        ShieldRubric.Score s = ShieldRubric.score(logs.get(dayIndex));
        System.out.println("TRACE score " + java.util.Arrays.toString(s.c()) + " " + s.notes());
        for (ShieldScenarios.In i : three.get(dayIndex).incoming()) {
            System.out.println("TRACE in " + i.id() + " " + i.type() + " " + i.cls() + " at "
                    + ShieldReplay.clock(i.at()) + " ideal " + i.label().ideal() + " reached "
                    + (logs.get(dayIndex).reached.get(i.id()) == null ? "never"
                    : ShieldReplay.clock(logs.get(dayIndex).reached.get(i.id()))) + " " + logs.get(dayIndex).how
                    .get(i.id()));
        }
    }
}
