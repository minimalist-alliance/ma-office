package com.minimalistalliance.desk.agent.team;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step.call;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The run as a loop of model calls and tool calls: its step limit, its chips, stopping, and bad calls. */
class ToolLoopTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private TeamDesk desk;
    private String a;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data);
        a = desk.agent("Alice");
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    private void steps(int limit) throws Exception {
        desk.call("agent.limits.set", "agentId", a, "policy", IconsTest.policy(limit));
    }

    @Test
    void aModelThatKeepsCallingToolsStopsAtTheRunsStepLimit() throws Exception {
        steps(3);
        for (int i = 0; i < 10; i++) {
            desk.provider.then(Step.calls(USAGE, List.of(call("c" + i, "workspace_list")), i == 0 ? "Looking. " : ""));
        }

        Map<String, Object> reply = desk.ask(a, "Keep looking.");

        assertThat(reply).containsEntry("state", "failed").containsEntry("error", "limit_reached");
        assertThat((String) reply.get("errorDetail")).startsWith("run");
        assertThat(reply).containsEntry("text", "Looking. ");
        assertThat(desk.requests()).as("one model call per step, three steps").hasSize(3);
        assertThat(desk.provider.pending()).isEqualTo(7);
        assertThat(list(reply.get("tools"))).hasSize(3).allSatisfy(chip -> assertThat(chip)
                .containsEntry("name", "workspace_list").containsEntry("summary", "Listed the workspace")
                .containsEntry("ok", true));
        assertThat(map(reply.get("usage")).get("inputTokens")).as("all three steps are counted").isEqualTo(300);
        assertThat(((Number) reply.get("costMicroUsd")).longValue()).isEqualTo(3 * 140L);
        assertThat(desk.agentView(a)).as("a run's own limit doesn't leave the agent at a limit")
                .containsEntry("status", "online");
    }

    @Test
    void theDefaultStepLimitIsFifty() throws Exception {
        for (int i = 0; i < 60; i++) {
            desk.provider.then(Step.calls(USAGE, List.of(call("c" + i, "workspace_list"))));
        }

        Map<String, Object> reply = desk.ask(a, "Never stop.");

        assertThat(reply).containsEntry("state", "failed").containsEntry("error", "limit_reached");
        assertThat(desk.requests()).hasSize(50);
    }

    @Test
    void textBeforeAndAfterToolsIsOneAnswerInParagraphs() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "workspace_list")), "First, a look."))
                .then(Step.answer(USAGE, "Then the answer."));

        Map<String, Object> reply = desk.ask(a, "Look, then say.");

        assertThat(reply).containsEntry("state", "done").containsEntry("text", "First, a look.\n\nThen the answer.");
        assertThat(desk.requests()).hasSize(2);
        assertThat(desk.requests().get(1).messages()).hasSize(3);
        assertThat(desk.requests().get(1).messages().get(1).toolCalls()).singleElement()
                .satisfies(c -> assertThat(c.name()).isEqualTo("workspace_list"));
    }

    @Test
    void malformedAndUnknownCallsAndTooManyAtOnceAreErrorResultsTheModelReads() throws Exception {
        List<ToolCall> calls = new ArrayList<>();
        calls.add(new ToolCall("bad", "workspace_list", Map.of(), true));
        calls.add(call("nope", "no_such_tool"));
        for (int i = 0; i < 16; i++) {
            calls.add(call("c" + i, "workspace_list"));
        }
        desk.provider.then(Step.calls(USAGE, calls)).then(Step.answer(USAGE, "Done."));

        Map<String, Object> reply = desk.ask(a, "Do too much.");

        assertThat(reply).containsEntry("state", "done");
        List<ToolResult> results = TeamDesk.toolResults(desk.lastRequest());
        assertThat(results).hasSize(18);
        assertThat(results.get(0)).satisfies(r -> {
            assertThat(r.error()).isTrue();
            assertThat(r.callId()).isEqualTo("bad");
            assertThat(r.content()).contains("wasn't a JSON object");
        });
        assertThat(results.get(1).error()).isTrue();
        assertThat(results.get(1).content()).contains("no tool named no_such_tool");
        assertThat(results.subList(2, 16)).noneMatch(ToolResult::error);
        assertThat(results.get(16).error()).as("the 17th that ran").isTrue();
        assertThat(results.get(17).content()).contains("Too many tool calls");
        assertThat(results).extracting(ToolResult::callId).startsWith("bad", "nope", "c0");
    }

    @Test
    void aStopWhileAToolWaitsForAnotherAgentEndsStoppedAndStopsTheOther() throws Exception {
        String b = desk.agent("Bob");
        desk.link(a, b, "Alice may ask Bob.");
        desk.open(b);
        CountDownLatch hold = new CountDownLatch(1);
        desk.provider.then(Step.calls(USAGE, List.of(call("m1", "message_agent", "to", b, "text", "Slow question"))))
                .then(Step.answer(USAGE, "Bob's late answer.").heldBy(hold));

        Map<String, Object> sent = desk.call("agent.message.send", "agentId", a, "text", "Ask Bob.");
        await().atMost(Duration.ofSeconds(10)).until(() -> desk.requests().size() >= 2);
        desk.call("agent.run.stop", "runId", sent.get("runId"));

        Map<String, Object> reply = desk.reply(a, 2);
        assertThat(reply).containsEntry("state", "stopped").containsEntry("error", null);
        Map<String, Object> theirs = desk.lastReply(b);
        assertThat(theirs).containsEntry("role", "assistant").containsEntry("state", "stopped");
        List<Map<String, Object>> log = list(desk.call("agent.a2a.list", "agentId", a).get("messages"));
        assertThat(log).singleElement().satisfies(row -> assertThat(row).containsEntry("state", "failed")
                .containsEntry("reason", "stopped"));
        assertThat(desk.agentView(a)).containsEntry("status", "online");
        assertThat(desk.agentView(b)).containsEntry("status", "online");
        hold.countDown();
    }

    @Test
    void aStopBetweenModelCallsEndsStoppedAndKeepsWhatWasSaid() throws Exception {
        CountDownLatch hold = new CountDownLatch(1);
        desk.provider.then(Step.calls(USAGE, List.of(call("c1", "workspace_list")), "Looking now.").heldBy(hold))
                .then(Step.answer(USAGE, "Never said."));

        Map<String, Object> sent = desk.call("agent.message.send", "agentId", a, "text", "Look.");
        await().atMost(Duration.ofSeconds(10)).until(() -> desk.provider.started.getCount() == 0);
        desk.call("agent.run.stop", "runId", sent.get("runId"));

        Map<String, Object> reply = desk.reply(a, 2);
        assertThat(reply).containsEntry("state", "stopped");
        assertThat(desk.requests()).hasSize(1);
        hold.countDown();
    }

    @Test
    void aStepCutOffOnItsCapEndsTheRunWithoutRunningItsCallsAndKeepsWhatWasSaid() throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(new ToolCall("c1", "workspace_list", Map.of(), true)),
                        "Writing a long one.").stoppedBy("max_tokens"))
                .then(Step.answer(USAGE, "Never asked."));

        Map<String, Object> reply = desk.ask(a, "Write.");

        assertThat(reply).containsEntry("state", "failed").containsEntry("error", "cut_off")
                .containsEntry("text", "Writing a long one.").containsEntry("stopReason", "max_tokens");
        assertThat(desk.requests()).as("no retry of the cut call").hasSize(1);
        assertThat(reply.get("tools")).as("the cut call didn't run").isNull();
        assertThat(desk.agentView(a)).containsEntry("status", "online");
    }

    @Test
    void aRefusalEndsTheRunRefusedAndAnIncompleteReplyIsCutOff() throws Exception {
        desk.provider.then(Step.answer(USAGE).stoppedBy("refusal"));
        assertThat(desk.ask(a, "Do the thing.")).containsEntry("state", "failed").containsEntry("error", "refused");
        desk.provider.then(Step.answer(USAGE, "Half a").stoppedBy("max_output_tokens"));
        assertThat(desk.ask(a, "Again.")).containsEntry("state", "failed").containsEntry("error", "cut_off")
                .containsEntry("text", "Half a");
    }
}
