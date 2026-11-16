package com.minimalistalliance.desk.agent.maia;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.FakeMaiaService;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.tool.DeskLink;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The staging proof's failed steps (Nov 15): about half of Desk Maia's model calls failed at the provider right after a
 * refused or untrusted tool result. Her service's audit had every one: each followed a call in which the model thought
 * before its tool call (8 of 8), and none of the 7 that followed a call without thinking failed. Her service puts the
 * request's note after the newest turn on the member's side and moves it to the next one on the next call, so every
 * thinking block sent back sat after a turn that had changed, and Opus 5.5's preserved thinking (enforced for the
 * company's account) refuses that request with a 400: {@code unavailable} {@code provider} on the desk.
 *
 * <p>These replay the exact sequence through the real agent service and her provider, with her service standing in as
 * the model does ({@link FakeMaiaService#preservedThinking}): her turn thinks, then calls a tool; the tool is refused (a
 * to-do with a source the run wasn't given, a brief with no grant) or comes back untrusted; her step goes through.
 */
class MaiaThinkingReplayTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 12);

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private MaiaDesk maia;

    @BeforeEach
    void open() throws Exception {
        maia = new MaiaDesk(data, clock);
        maia.deskd.service.preservedThinking = true;
    }

    @AfterEach
    void close() {
        maia.close();
    }

    /** A thinking block as her service hands it back: Opus 5.5's are empty unless asked, stamped for the model. */
    private static Map<String, Object> thinking(String signature) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("type", "thinking");
        item.put("thinking", "");
        item.put("signature", signature);
        item.put("m", "0123456789abcdef");
        return item;
    }

    private static ToolCall thought(String id, String name, String signature, Object... pairs) {
        ToolCall plain = Step.call(id, name, pairs);
        return plain.withReasoning(List.of(thinking(signature)));
    }

    /** Her note-taker's call answers last, whenever it comes. */
    private void takerLast() {
        maia.desk.provider.onChat = request -> {
            if (request.system().startsWith("You take notes")) {
                await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.pending() <= 1);
            }
        };
    }

    private List<Map<String, Object>> steps() {
        return maia.deskd.service.calls.stream().filter(a -> "step".equals(a.get("task"))).toList();
    }

    private void sheFinished(Map<String, Object> reply, String text) {
        assertThat(reply).as("her reply").containsEntry("state", "done").containsEntry("text", text);
        assertThat(maia.deskd.service.bindingRefusals).isEmpty();
        assertThat(steps()).hasSize(1);
        // Nothing of the model's thinking goes back to her service.
        assertThat(String.valueOf(steps().get(0).get("messages"))).doesNotContain("thinking").doesNotContain("sig-");
    }

    @Test
    void aStepAfterARefusedToDoGoesThroughWhenSheThought() throws Exception {
        maia.on();
        takerLast();
        // deskd's look: the source isn't one this run was given (the away runs' refusal on staging).
        maia.deskd.looks.put("todo_add", call -> new DeskLink.Reply(true, Map.of("risk", "write", "context", "agent",
                "refusal", "source_unknown", "target", Map.of("kind", "todo"), "payload", call.get("args")), null, null,
                List.of()));
        maia.desk.provider.then(Step.calls(USAGE, List.of(thought("toolu_01", "todo_add", "sig-1", "title",
                        "Lead with the headline", "source", Map.of("kind", "agent_chat", "ref", Map.of())))))
                .then(Step.answer(USAGE, "I couldn't add that one."))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Put the best tip on my to-do for tomorrow");
        sheFinished(reply, "I couldn't add that one.");
        // The step carried the refusal back as the model reads it.
        assertThat(String.valueOf(steps().get(0).get("messages"))).contains("Not allowed: source_unknown.");
    }

    @Test
    void aStepAfterARefusedBriefGoesThroughWhenSheThought() throws Exception {
        maia.on();
        takerLast();
        // No grant for Work: her brief is refused before deskd hears of it, as the budget's hold refused it on staging.
        maia.desk.provider.then(Step.calls(USAGE, List.of(thought("toolu_02", "desk_message", "sig-2", "desk", "Work",
                        "text", "Three short tips on writing a weekly status update, please."))))
                .then(Step.answer(USAGE, "I can't reach your Work desk from here yet."))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Ask the Lead on my Work desk for three tips");
        sheFinished(reply, "I can't reach your Work desk from here yet.");
        assertThat(maia.deskd.runsOf("desk_message")).isEmpty();
    }

    @Test
    void aStepAfterAnUntrustedResultGoesThroughWhenSheThought() throws Exception {
        maia.on();
        takerLast();
        maia.desk.provider.then(Step.calls(USAGE, List.of(thought("toolu_03", "office_desks", "sig-3"))))
                .then(Step.answer(USAGE, "Your home desk is the only one I can see."))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Which of my desks are awake?");
        sheFinished(reply, "Your home desk is the only one I can see.");
    }

    @Test
    void twoStepsInARowWhenSheThoughtBeforeEachGoThrough() throws Exception {
        maia.on();
        takerLast();
        maia.desk.provider.then(Step.calls(USAGE, List.of(thought("toolu_04", "office_desks", "sig-4"))))
                .then(Step.calls(USAGE, List.of(thought("toolu_05", "office_desk_status", "sig-5", "deskId",
                        MaiaDesk.HOME))))
                .then(Step.answer(USAGE, "Your home desk's Lead is free."))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Look at my desks, then my home desk in detail");
        assertThat(reply).containsEntry("state", "done").containsEntry("text", "Your home desk's Lead is free.");
        assertThat(maia.deskd.service.bindingRefusals).isEmpty();
        assertThat(steps()).hasSize(2);
        assertThat(String.valueOf(steps())).doesNotContain("thinking");
    }

    /**
     * The stand-in itself: what the desk sent before this fix. A thinking block sent back after the note moved off the
     * turn before it is refused as staging refused it; the same request without it goes through.
     */
    @Test
    void herServiceRefusesAThinkingBlockSentBackAfterTheNoteMoved() {
        FakeMaiaService service = maia.deskd.service;
        maia.desk.provider.then(Step.calls(USAGE, List.of(thought("toolu_06", "office_desks", "sig-6"))))
                .then(Step.answer(USAGE, "Done."))
                .then(Step.answer(USAGE, "Done."));
        Map<String, Object> turn = new LinkedHashMap<>();
        turn.put("task", "turn");
        turn.put("callId", "01a1df0a-6fff-7db7-b189-d50473f2761a");
        turn.put("context", "The member's home desk adds: ...");
        turn.put("messages", List.of(Map.of("role", "user", "text", "Which desks are awake?")));
        turn.put("tools", List.of());
        turn.put("maxOutputTokens", 4_000);
        turn.put("units", "credits");
        turn.put("note", "Now: Sunday 15 November, 5:08 am in the member's time zone.");
        assertThat(service.answer(Map.of("args", turn)).ok()).isTrue();

        Map<String, Object> call = new LinkedHashMap<>();
        call.put("id", "toolu_06");
        call.put("name", "office_desks");
        call.put("input", Map.of());
        Map<String, Object> result = Map.of("callId", "toolu_06", "content", "[...]", "error", false);
        Map<String, Object> replayed = new LinkedHashMap<>(call);
        replayed.put("reasoning", List.of(thinking("sig-6")));
        Map<String, Object> step = new LinkedHashMap<>(turn);
        step.put("task", "step");
        step.put("messages", List.of(Map.of("role", "user", "text", "Which desks are awake?"), Map.of("role",
                "assistant", "text", "", "toolCalls", List.of(replayed)), Map.of("role", "user", "text", "", "toolResults",
                List.of(result))));
        DeskLink.Reply refused = service.answer(Map.of("args", step));
        assertThat(refused.ok()).isFalse();
        assertThat(refused.code()).isEqualTo("unavailable");
        assertThat(refused.reason()).isEqualTo("provider");
        assertThat(service.bindingRefusals).containsExactly(
                "messages.1: a thinking block bound to a different conversation");

        step.put("messages", List.of(Map.of("role", "user", "text", "Which desks are awake?"), Map.of("role",
                "assistant", "text", "", "toolCalls", List.of(call)), Map.of("role", "user", "text", "", "toolResults",
                List.of(result))));
        assertThat(service.answer(Map.of("args", step)).ok()).isTrue();
    }
}
