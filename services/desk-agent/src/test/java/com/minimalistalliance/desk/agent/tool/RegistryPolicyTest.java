package com.minimalistalliance.desk.agent.tool;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The policy over the registry (draft ADR sections 1, 3, 5 and 6): a call's class rises with deskd's look and the Rule
 * of Two and never falls; refusals decided before asking come back on the call, so nobody is asked; input the schema
 * doesn't take never reaches deskd.
 */
class RegistryPolicyTest {

    private final MutableClock clock = new MutableClock(Rig.START);
    private final FakeDeskLink desk = new FakeDeskLink();
    private final ToolRegistry registry = new ToolRegistry();
    private final RegistryPolicy policy = new RegistryPolicy(registry, desk, clock);

    private static RunContext run(Taint... flags) {
        RunContext run = RunContext.of("run-1", "ag-1", Caller.OWNER, null, "m-1");
        run.add(Set.of(flags));
        return run;
    }

    private static ToolCall call(String name, Object... pairs) {
        Map<String, Object> input = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            input.put((String) pairs[i], pairs[i + 1]);
        }
        return new ToolCall("c1", name, input);
    }

    @Test
    void aClassRisesWithDesksLookAndNeverFalls() {
        desk.looks.put("browser_click", c -> FakeDeskLink.look("send", "agent", Map.of("tabId", "at-1", "ref", "n2",
                "label", "Submit", "role", "button", "origin", "https://example.test"), null));
        Classified click = policy.classify(call("browser_click", "tabId", "at-1", "ref", "n2"), run());
        assertThat(click.risk()).isEqualTo(Risk.SEND);
        assertThat(click.payload()).containsEntry("label", "Submit");
        assertThat(click.refusal()).isNull();

        desk.looks.put("browser_click", c -> FakeDeskLink.look("spend", "agent", Map.of("tabId", "at-1"), null));
        assertThat(policy.classify(call("browser_click", "tabId", "at-1", "ref", "n3"), run()).risk())
                .isEqualTo(Risk.SPEND);

        // deskd saying less than the declaration changes nothing: files_write is write whatever the look says.
        desk.looks.put("files_write", c -> FakeDeskLink.look("read", "agent", Map.of("path", "a.md", "text", "x",
                "replace", false), null));
        assertThat(policy.classify(call("files_write", "path", "a.md", "text", "x"), run()).risk())
                .isEqualTo(Risk.WRITE);

        // A class desk-agent doesn't know counts as the highest, never a reason to ask less.
        desk.looks.put("browser_open", c -> FakeDeskLink.look("teleport", "agent", Map.of("url", "x"), null));
        assertThat(policy.classify(call("browser_open", "url", "https://example.test"), run()).risk())
                .isEqualTo(Risk.EGRESS);
    }

    @Test
    void theMembersSessionMakesEveryNavigationEgressWhateverTheTaint() {
        // deskd's look of a navigation in a granted session tab says egress; it holds with no taint at all.
        desk.looks.put("browser_back", c -> FakeDeskLink.look("egress", "member:example.test", Map.of("tabId", "ms-1"),
                null));
        Classified back = policy.classify(call("browser_back", "tabId", "ms-1"), run());
        assertThat(back.risk()).isEqualTo(Risk.EGRESS);
        assertThat(back.context()).isEqualTo("member:example.test");
        assertThat(back.backstopped(false, false, false).risk()).isEqualTo(Risk.EGRESS);
    }

    @Test
    void theRuleOfTwoMakesABrowseActionEgress() {
        assertThat(policy.classify(call("browser_open", "url", "https://example.test"), run(Taint.U)).risk())
                .isEqualTo(Risk.READ);
        assertThat(policy.classify(call("browser_open", "url", "https://example.test"), run(Taint.S)).risk())
                .isEqualTo(Risk.READ);
        for (ToolCall c : List.of(call("browser_open", "url", "https://example.test"),
                call("browser_click", "tabId", "at-1", "ref", "n1"),
                call("browser_type", "tabId", "at-1", "ref", "n1", "text", "x"),
                call("browser_press", "tabId", "at-1", "ref", "n1", "key", "Enter"),
                call("browser_back", "tabId", "at-1"))) {
            Classified classified = policy.classify(c, run(Taint.U, Taint.S));
            assertThat(classified.refusal()).as(c.name()).isNull();
            assertThat(classified.risk()).as(c.name()).isEqualTo(Risk.EGRESS);
        }
        // Reading, the tab list and a close aren't browse actions, here or in the loop's backstop.
        for (ToolCall c : List.of(call("browser_read", "tabId", "at-1"), call("browser_tabs"), call("browser_close", "tabId", "at-1"))) {
            Classified classified = policy.classify(c, run(Taint.U, Taint.S));
            assertThat(classified.risk()).as(c.name()).isEqualTo(Risk.READ);
            assertThat(classified.backstopped(true, true, false).risk()).as(c.name()).isEqualTo(Risk.READ);
        }
        // A spend stays a spend.
        desk.looks.put("browser_click", c -> FakeDeskLink.look("spend", "agent", Map.of("tabId", "at-1", "spend", true), null));
        Classified buy = policy.classify(call("browser_click", "tabId", "at-1", "ref", "n3"), run(Taint.U, Taint.S));
        assertThat(buy.risk()).isEqualTo(Risk.SPEND);
        assertThat(buy.backstopped(true, true, false).risk()).isEqualTo(Risk.SPEND);
        // The look carried the run's flags to deskd, which keeps its own copy.
        assertThat(desk.calls.get(desk.calls.size() - 1).get("taint")).isEqualTo(List.of("S", "U"));
    }

    @Test
    void aRefusalDecidedBeforeAskingComesBackOnTheCall() {
        desk.looks.put("browser_type", c -> FakeDeskLink.look("read", "agent", Map.of("tabId", "at-1"), "sensitive"));
        Classified typing = policy.classify(call("browser_type", "tabId", "at-1", "ref", "n4", "text", "hunter2"), run());
        assertThat(typing.refusal()).isEqualTo("sensitive");

        desk.looks.put("browser_open", c -> FakeDeskLink.look("egress", "member:example.test", Map.of("url", "x"),
                "off_site"));
        assertThat(policy.classify(call("browser_open", "url", "https://elsewhere.test", "tabId", "ms-1"), run())
                .refusal()).isEqualTo("off_site");

        // deskd's look refusing outright (a file already there) is a refusal too: no card for it.
        desk.looks.put("files_write", c -> FakeDeskLink.refused("conflict", "exists"));
        assertThat(policy.classify(call("files_write", "path", "a.md", "text", "x"), run()).refusal())
                .isEqualTo("exists");

        // A tool deskd doesn't offer now.
        desk.offered = Set.of();
        assertThat(policy.classify(call("files_list", "path", ""), run()).refusal()).isEqualTo("unavailable");
    }

    @Test
    void securityFiveTheSessionGrantIsRefusedOriginInARunATimerOrAnotherAgentStarted() {
        int before = desk.calls.size();
        for (Map<String, Object> origin : List.<Map<String, Object>>of(Map.of("kind", "timer", "agentId", "ag-1", "timerId", "t1"),
                Map.of("kind", "agent", "agentId", "ag-2", "name", "Bee"))) {
            RunContext unattended = RunContext.of("run-2", "ag-1", Caller.OWNER, origin, "m-2");
            Classified grant = policy.classify(call("browser_use_my_session", "site", "example.test"), unattended);
            assertThat(grant.refusal()).as(origin.get("kind").toString()).isEqualTo("origin");
        }
        // Refused before deskd hears of it.
        assertThat(desk.calls).hasSize(before);
        // A run the member started asks, as egress.
        desk.looks.put("browser_use_my_session", c -> FakeDeskLink.look("egress", "member:example.test",
                Map.of("site", "example.test"), null));
        Classified asked = policy.classify(call("browser_use_my_session", "site", "example.test"), run());
        assertThat(asked.refusal()).isNull();
        assertThat(asked.risk()).isEqualTo(Risk.EGRESS);
    }

    @Test
    void inputTheSchemaDoesntTakeNeverReachesDeskd() {
        int before = desk.calls.size();
        assertThat(policy.classify(call("files_write", "path", "a.md"), run()).refusal()).isEqualTo("input");
        assertThat(policy.classify(call("files_write", "path", "a.md", "text", "x", "permanent", true), run())
                .refusal()).isEqualTo("input");
        assertThat(policy.classify(call("browser_press", "tabId", "t", "ref", "n1", "key", "F12"), run()).refusal())
                .isEqualTo("input");
        assertThat(policy.classify(call("files_read", "path", 7), run()).refusal()).isEqualTo("input");
        assertThat(desk.calls).hasSize(before);
    }

    @Test
    void aFollowUpIsWithinSevenDaysWithAnAbsoluteTime() {
        Classified ok = policy.classify(call("follow_up", "inMinutes", 90, "prompt", " Check the train times. "),
                run());
        long at = clock.millis() + Duration.ofMinutes(90).toMillis();
        assertThat(ok.refusal()).isNull();
        assertThat(ok.risk()).isEqualTo(Risk.WRITE);
        assertThat(ok.payload()).isEqualTo(Map.of("at", at, "prompt", "Check the train times."));
        assertThat(ok.target()).containsEntry("kind", "timer").containsEntry("at", at);

        assertThat(policy.classify(call("follow_up", "inMinutes", 8 * 24 * 60, "prompt", "x"), run()).refusal())
                .isEqualTo("input");
        String tooLate = clock.instant().plus(Duration.ofDays(8)).toString();
        assertThat(policy.classify(call("follow_up", "at", tooLate, "prompt", "x"), run()).refusal()).isEqualTo("when");
        assertThat(policy.classify(call("follow_up", "prompt", "x"), run()).refusal()).isEqualTo("when");
    }

    @Test
    void theContextAnApprovalWasAskedInIsKeptForItsCall() {
        desk.looks.put("browser_click", c -> FakeDeskLink.look("write", "member:example.test", Map.of("tabId", "ms-1"),
                null));
        policy.classify(call("browser_click", "tabId", "ms-1", "ref", "n1"), run());
        assertThat(policy.contextOf("run-1", "c1")).isEqualTo("member:example.test");
        assertThat(policy.contextOf("run-1", "c1")).isNull();
    }

    @Test
    void anUnknownNameIsTheAgentsOwnAndDoesNothing() {
        Classified c = policy.classify(call("no_such_tool"), run());
        assertThat(c.risk()).isEqualTo(Risk.OWN);
        assertThat(c.decl().host()).isEqualTo(ToolDecl.Host.DESK_AGENT);
        assertThat(desk.calls).isEmpty();
    }
}
