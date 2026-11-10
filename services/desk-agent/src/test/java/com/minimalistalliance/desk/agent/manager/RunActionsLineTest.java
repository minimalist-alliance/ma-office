package com.minimalistalliance.desk.agent.manager;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.Usage;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The line a later turn reads about what a run did. */
class RunActionsLineTest {

    private static ManagerAgent.RunResult run(List<Map<String, Object>> chips) {
        return new ManagerAgent.RunResult("r", ManagerAgent.RunState.DONE, "", null, Usage.NONE, null, null, null,
                null, chips);
    }

    @Test
    void aRunWithNoToolsHasNoLine() {
        assertThat(run(List.of()).actionsLine()).isEmpty();
    }

    @Test
    void eachActionIsNamedAndAFailedOneSaysSo() {
        assertThat(run(List.of(Map.of("name", "workspace_write", "summary", "Wrote notes/a.md", "ok", true),
                Map.of("name", "message_agent", "summary", "Messaged Writer", "ok", false))).actionsLine())
                .isEqualTo("[Done: Wrote notes/a.md; Messaged Writer (failed)]");
    }

    @Test
    void aLongRunIsSummarisedAfterTwelve() {
        List<Map<String, Object>> chips = new java.util.ArrayList<>();
        for (int i = 0; i < 15; i++) {
            chips.add(Map.of("name", "n", "summary", "Did " + i, "ok", true));
        }
        assertThat(run(chips).actionsLine()).endsWith("Did 11; and 3 more]");
    }
}
