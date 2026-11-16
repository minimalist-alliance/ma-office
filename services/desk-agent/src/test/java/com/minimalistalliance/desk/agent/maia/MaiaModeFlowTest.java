package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Maia Mode on the real agent service (deskd {@code API.md} §23): dark by default, the kill switch, turning it on, her
 * thread and its choices, her notes filed by code, the list over a real topic, and what she is never offered.
 */
class MaiaModeFlowTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private MaiaDesk maia;

    @BeforeEach
    void open() throws Exception {
        maia = new MaiaDesk(data, clock);
    }

    @AfterEach
    void close() {
        maia.close();
    }

    private List<AuditLog.Row> audit(String action) throws Exception {
        return maia.desk.audit.readBefore(null, 5000).stream().filter(r -> r.entry().action().equals(action))
                .toList();
    }

    // ---------------------------------------------------------------- dark by default, the switch

    @Test
    void maiaModeIsDarkByDefaultAndNothingOfHersRuns() throws Exception {
        Map<String, Object> got = map(maia.call("agent.maia.get").get("maia"));
        assertThat(got).containsEntry("on", false).containsEntry("killed", false).containsEntry("agentId", "maia");
        // Not listed (no switch): refused not_listed; listed but not turned on: maia_off.
        assertThat(maia.refused("agent.maia.observe", "desks", List.of()).details())
                .containsEntry("reason", "not_listed");
        assertThat(maia.refused("agent.maia.set", "on", true, "disclosure", MaiaMode.DISCLOSURE).details())
                .containsEntry("reason", "not_listed");
        maia.list();
        assertThat(maia.refused("agent.maia.typing", "typing", true).details()).containsEntry("reason", "maia_off");
        // No agent of hers exists until the member turns it on.
        assertThat(maia.desk.store.agent(MaiaAgent.ID)).isNull();
        assertThat(maia.refused("agent.message.send", "agentId", "maia", "text", "hi").code())
                .isIn("not_found", "forbidden");
    }

    @Test
    void turningItOnNeedsTheDisclosure() throws Exception {
        maia.list();
        RpcError e = maia.refused("agent.maia.set", "on", true);
        assertThat(e.code()).isEqualTo("precondition_failed");
        assertThat(e.details()).containsEntry("reason", "disclosure");
        maia.on();
        assertThat(map(maia.call("agent.maia.get").get("maia"))).containsEntry("on", true)
                .containsEntry("disclosure", MaiaMode.DISCLOSURE);
        assertThat(maia.desk.store.agent(MaiaAgent.ID)).isNotNull();
        assertThat(audit("maia.on")).hasSize(1);
    }

    @Test
    void theKillSwitchTurnsItOffAtOnceWhateverTheMemberChose() throws Exception {
        maia.on();
        Files.writeString(data.resolve(MaiaMode.SWITCH_FILE), "off\n");
        assertThat(map(maia.call("agent.maia.get").get("maia"))).containsEntry("killed", true);
        assertThat(maia.refused("agent.maia.observe", "desks", List.of()).details())
                .containsEntry("reason", "maia_off");
        assertThat(maia.refused("agent.message.send", "agentId", "maia", "text", "hi").details())
                .containsEntry("reason", "maia_off");
        assertThat(maia.refused("agent.maia.set", "attention", Map.of("visible", 2)).details())
                .containsEntry("reason", "maia_off");
        // Listed again, the member's choice is back.
        Files.writeString(data.resolve(MaiaMode.SWITCH_FILE), "on\n");
        maia.call("agent.maia.observe", "desks", List.of());
        // No switch: not listed. Anything that isn't a plain file saying on or off is off.
        Files.delete(data.resolve(MaiaMode.SWITCH_FILE));
        assertThat(maia.refused("agent.maia.observe", "desks", List.of()).details())
                .containsEntry("reason", "not_listed");
        Files.writeString(data.resolve(MaiaMode.SWITCH_FILE), "yes please\n");
        assertThat(map(maia.call("agent.maia.get").get("maia"))).containsEntry("killed", true);
        Files.delete(data.resolve(MaiaMode.SWITCH_FILE));
        Files.createDirectory(data.resolve(MaiaMode.SWITCH_FILE));
        assertThat(map(maia.call("agent.maia.get").get("maia"))).containsEntry("killed", true)
                .containsEntry("listed", false);
    }

    @Test
    void turningItOffRevokesEveryGrantAndKeepsTheThread() throws Exception {
        maia.on();
        maia.grant(MaiaDesk.WORK, "Work", false, "brief", "show");
        assertThat(list(maia.call("agent.maia.grants.list").get("grants"))).hasSize(1);
        maia.call("agent.maia.set", "on", false);
        assertThat(list(maia.call("agent.maia.grants.list").get("grants"))).isEmpty();
        assertThat(audit("maia.off")).hasSize(1);
        assertThat(maia.desk.store.agent(MaiaAgent.ID)).isNotNull();
    }

    // ---------------------------------------------------------------- she isn't a team agent

    @Test
    void sheIsNoTeamAgent() throws Exception {
        maia.on();
        List<Map<String, Object>> agents = list(maia.call("agent.list").get("agents"));
        assertThat(agents).extracting(a -> a.get("id")).doesNotContain("maia");
        assertThat(maia.refused("agent.update", "agentId", "maia", "name", "X").code()).isEqualTo("not_found");
        assertThat(maia.refused("agent.delete", "agentId", "maia").code()).isEqualTo("not_found");
        assertThat(maia.refused("agent.links.set", "agentId", "maia", "solo", false, "links", List.of()).code())
                .isEqualTo("not_found");
        maia.desk.bindLead();
        RpcError link = maia.refused("agent.links.set", "agentId", AgentStore.MANAGER, "solo", false, "links",
                List.of(Map.of("to", "maia", "rules", "anything")));
        assertThat(link.code()).isIn("bad_request", "not_found");
        // Another desk's offer can't name her as its answering agent.
        assertThat(maia.refused("agent.desks.answer", "grantId", "dg-x", "allow", true, "agentId", "maia").details())
                .containsEntry("reason", "maia");
        // deskd's own view (the heartbeat) does see her runs.
        assertThat(list(maia.desk.service.stateSnapshot(com.minimalistalliance.desk.agent.service.Caller.SYSTEM)
                .get("agents"))).extracting(a -> a.get("id")).contains("maia");
    }

    // ---------------------------------------------------------------- her run

    @Test
    void herRunHasHerPromptAndOnlyHerTools() throws Exception {
        maia.on();
        maia.desk.provider.then(Step.answer(USAGE, "Hello."));
        maia.desk.ask("maia", "Hi Maia");
        ChatRequest request = maia.desk.provider.requests().get(0);
        // Her service's task and the desk's context: her Maia Mode instructions are the Platform's (Nov 14).
        assertThat(request.model()).isEqualTo("turn");
        assertThat(request.system()).startsWith("The member's home desk adds").contains(Choices.RULE)
                .doesNotContain("You are Maia").doesNotContain("0.8");
        // The weight, the time and briefs left change from call to call: they're in her note, outside the cached prefix.
        assertThat(request.note()).contains("Your choice weight for this member is 0.8 (0 to 1).").contains("Now: ")
                .contains("Briefs left today: ");
        List<String> tools = TeamDesk.toolNames(request);
        assertThat(tools).contains("office_desks", "office_desk_status", "office_show", "ask_member",
                "plan_update", "todo_add");
        // Never offered: anything of Files, the Browser, the Notebook (her notes are her code's), Courier, approvals,
        // keys, grants, limits, a timer of her own, workspace, proposals, messages to agents on this desk.
        assertThat(tools).noneMatch(t -> t.startsWith("files_") || t.startsWith("browser_")
                || t.startsWith("notebook_") || t.startsWith("courier_") || t.startsWith("propose_")
                || t.startsWith("workspace_") || t.equals("follow_up") || t.equals("message_agent")
                || t.contains("approv") || t.contains("key") || t.contains("grant") || t.contains("limit"));
    }

    @Test
    void askMemberPutsChoicesOnHerReplyAndATapIsTheMembersMessage() throws Exception {
        maia.on();
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "ask_member", "question",
                        "Which laptops?", "choices", List.of("Three under $1,000", "Only ultralights"))),
                "Which laptops should I compare?"));
        Map<String, Object> reply = maia.desk.ask("maia", "Compare some laptops");
        Map<String, Object> choices = map(reply.get("choices"));
        assertThat(choices).containsEntry("state", "open").containsEntry("recommended", "c1")
                .containsEntry("other", true);
        assertThat(list(choices.get("options"))).extracting(o -> o.get("label"))
                .containsExactly("Three under $1,000", "Only ultralights");
        assertThat(map(maia.call("agent.maia.choices.get").get("choices"))).containsEntry("offered", 1L);

        maia.desk.provider.then(Step.answer(USAGE, "On it."));
        int before = maia.desk.thread("maia").size();
        maia.call("agent.maia.choose", "messageId", reply.get("id"), "choiceId", "c1");
        Map<String, Object> next = maia.desk.reply("maia", before + 2);
        assertThat(next.get("text")).isEqualTo("On it.");
        List<Map<String, Object>> thread = maia.desk.thread("maia");
        assertThat(thread.get(thread.size() - 2).get("text")).isEqualTo("Three under $1,000");
        Map<String, Object> counts = map(maia.call("agent.maia.choices.get").get("choices"));
        assertThat(counts).containsEntry("tapped", 1L);
        assertThat((Double) counts.get("weight")).isGreaterThan(0.8);
        // Answered once.
        assertThat(maia.refused("agent.maia.choose", "messageId", reply.get("id"), "choiceId", "c2").details())
                .containsEntry("reason", "answered");
        // The kept counts hold numbers only, never a word of the thread.
        String kept = maia.desk.store.setting("maia.choices");
        assertThat(kept).doesNotContain("laptop").doesNotContain("ultralight").doesNotContain("Three");
    }

    /** Her note-taker's request takes the last scripted step only once her run's steps are taken (EvalDesk's rule). */
    private void takerLast() {
        maia.desk.provider.onChat = request -> {
            if (request.system().startsWith("You take notes")) {
                await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.pending() <= 1);
            }
        };
    }

    /** Her own runs' model requests (her note-taker's start differently). */
    private List<ChatRequest> herRequests() {
        return maia.desk.provider.requests().stream()
                .filter(r -> r.system().startsWith("The member's home desk adds")).toList();
    }

    /**
     * The owner's first real use (Nov 15): her turn wrote the welcome and offered choices, and the step the loop then ran
     * after her choices wrote the welcome again, so both showed in one reply. Her choices now end the run: one model call,
     * the reply said once.
     */
    @Test
    void herChoicesEndHerReplySoTheModelIsntCalledAgainAndNothingIsSaidTwice() throws Exception {
        maia.on();
        takerLast();
        String welcome = "Welcome. I'm glad you're here. Where would you like to start?";
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "ask_member", "question",
                        "Where would you like to start?", "choices", List.of("Set things up together",
                                "Just look around"))), welcome))
                // Before the fix the loop called her model again here, and this answer became a second part of her reply.
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask("maia", "Hi Maia. I'm new around here");
        assertThat(reply.get("text")).isEqualTo(welcome);
        assertThat(map(reply.get("choices"))).containsEntry("state", "open");
        await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.requests().size() >= 2);
        assertThat(herRequests()).hasSize(1);
        assertThat(maia.desk.lastReply("maia").get("text")).isEqualTo(welcome);
    }

    /** Choices with no words before them: her question is the reply's text, still one call. */
    @Test
    void choicesWithNoWordsShowHerQuestionAsTheReply() throws Exception {
        maia.on();
        takerLast();
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "ask_member", "question",
                        "Where would you like to start?", "choices", List.of("Set things up together",
                                "Just look around")))))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask("maia", "Hello");
        assertThat(reply.get("text")).isEqualTo("Where would you like to start?");
        assertThat(map(reply.get("choices"))).containsEntry("state", "open");
        await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.requests().size() >= 2);
        assertThat(herRequests()).hasSize(1);
    }

    /** Refused choices don't end the run: she gets the refusal and can put them right. */
    @Test
    void refusedChoicesLetHerTryAgain() throws Exception {
        maia.on();
        takerLast();
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "ask_member", "question", "Which?",
                        "choices", List.of("Only one")))))
                .then(Step.calls(USAGE, List.of(Step.call("c2", "ask_member", "question", "Which one?",
                        "choices", List.of("This", "That"))), "Which one?"))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask("maia", "Pick for me");
        assertThat(reply.get("text")).isEqualTo("Which one?");
        assertThat(list(map(reply.get("choices")).get("options"))).hasSize(2);
        await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.requests().size() >= 3);
        assertThat(herRequests()).hasSize(2);
    }

    /**
     * Any other tool: the step after it that writes her reply again is cut to what's new before it's shown (the
     * restatement guard), so the doubled welcome can't come back by another tool.
     */
    @Test
    void aStepAfterAnotherToolThatSaysItAllAgainAddsNothing() throws Exception {
        maia.on();
        takerLast();
        String turn = "Welcome. I'm glad you're here. I can keep your to-do list and talk things through.";
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "office_desks")), turn))
                .then(Step.answer(USAGE, "Welcome! I'm glad you're here. I can talk things through and keep your"
                        + " to-do list."))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask("maia", "Hi Maia");
        assertThat(reply.get("text")).isEqualTo(turn);
        await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.requests().size() >= 3);
        assertThat(herRequests()).hasSize(2);
    }

    /** A step after a tool with something new keeps it, on its own paragraph. */
    @Test
    void aStepAfterAToolWithSomethingNewKeepsIt() throws Exception {
        maia.on();
        takerLast();
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "office_desks")), "Let me look."))
                .then(Step.answer(USAGE, "Your home desk is the only one I can see."))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask("maia", "What desks do I have?");
        assertThat(reply.get("text")).isEqualTo("Let me look.\n\nYour home desk is the only one I can see.");
    }

    @Test
    void typingSomethingElsePassesTheChoicesByAndAskingForOptionsRaisesTheWeight() throws Exception {
        maia.on();
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "ask_member", "question", "Which?",
                        "choices", List.of("A", "B"))), "Which?"))
                .then(Step.answer(USAGE, "Fine."))
                .then(Step.answer(USAGE, "Sure."));
        Map<String, Object> reply = maia.desk.ask("maia", "Help");
        maia.desk.ask("maia", "Never mind, do the other thing");
        Map<String, Object> passed = maia.desk.thread("maia").stream().filter(m -> reply.get("id").equals(m.get("id")))
                .findFirst().orElseThrow();
        assertThat(map(passed.get("choices"))).containsEntry("state", "passed");
        double low = (Double) map(maia.call("agent.maia.choices.get").get("choices")).get("weight");
        assertThat(low).isLessThan(0.8);
        maia.desk.ask("maia", "Give me options please");
        Map<String, Object> counts = map(maia.call("agent.maia.choices.get").get("choices"));
        assertThat((Double) counts.get("weight")).isGreaterThanOrEqualTo(0.8);
        assertThat(counts).containsEntry("askedMore", 1L).containsEntry("ignored", 1L);
        maia.call("agent.maia.choices.reset");
        assertThat(map(maia.call("agent.maia.choices.get").get("choices"))).containsEntry("offered", 0L);
    }

    // ---------------------------------------------------------------- notes

    @Test
    void notesAreTakenFromTheMembersOwnWordsAndFiledByCodeWithAChipAndUndo() throws Exception {
        maia.on();
        // Her reply, then the note-taker's answer (a side call on her key).
        maia.desk.provider.then(Step.answer(USAGE, "Noted."))
                .then(Step.answer(USAGE, "{\"notes\": [{\"text\": \"The Acme renewal is due Friday\", \"area\":"
                        + " \"work\", \"kind\": \"reminder\", \"due\": null}]}"));
        Map<String, Object> reply = maia.desk.ask("maia", "Remember the Acme renewal is due Friday");
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            Map<String, Object> last = maia.desk.lastReply("maia");
            return last.get("notes") instanceof List<?> l && !l.isEmpty()
                    && "filed".equals(((Map<?, ?>) l.get(0)).get("state"));
        });
        Map<String, Object> chip = list(maia.desk.lastReply("maia").get("notes")).get(0);
        assertThat(chip).containsEntry("area", "work").containsEntry("line", "Noted for Work");
        String approvalId = (String) chip.get("approvalId");
        assertThat(approvalId).startsWith("ap-");
        // The taker read only the member's words: its request has no reply of hers.
        ChatRequest taker = maia.desk.provider.requests().get(1);
        assertThat(taker.system()).contains("You take notes");
        assertThat(taker.tools()).isEmpty();
        assertThat(TeamDesk.allText(taker)).contains("Acme renewal").doesNotContain("Noted.");
        // Code filed it: a new page in the From Maia tab, done without asking under her switch.
        Map<String, Object> write = maia.deskd.runsOf("notebook_write").get(0);
        assertThat(write).containsEntry("auto", "notebook").containsEntry("autoApprovalId", approvalId);
        assertThat(map(map(write.get("args")).get("new"))).containsEntry("tabId", MaiaDesk.TAB);
        assertThat((String) map(write.get("args")).get("markdown")).contains("Acme renewal");
        assertThat(audit("maia.note")).hasSize(1);
        assertThat(audit("maia.note").get(0).entry().target()).doesNotContain("Acme");
        List<Map<String, Object>> notes = list(maia.call("agent.maia.notes.list").get("notes"));
        assertThat(notes).hasSize(1);
        assertThat(notes.get(0)).containsEntry("state", "filed").doesNotContainKey("text");
    }

    @Test
    void anUnsureNoteIsHeldAndAskedAboutOnceWhenTheConversationGoesQuiet() throws Exception {
        maia.on();
        maia.desk.provider.then(Step.answer(USAGE, "OK."))
                .then(Step.answer(USAGE, "{\"notes\": [{\"text\": \"Call the plumber next week\", \"area\":"
                        + " \"unsure\", \"kind\": \"reminder\"}]}"));
        maia.desk.ask("maia", "I need to call the plumber next week");
        maia.desk.service.getClass();
        await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.store.setting("maia.mode") != null
                && list(maia.call("agent.maia.notes.list").get("notes")).size() == 1);
        assertThat(list(maia.call("agent.maia.notes.list").get("notes")).get(0)).containsEntry("state", "held");
        assertThat(maia.deskd.runsOf("notebook_write")).isEmpty();
    }

    // ---------------------------------------------------------------- the list

    @Test
    void theListIsCodesAtMostThreeAndOneNow() throws Exception {
        maia.on();
        long now = clock.millis();
        maia.observe(MaiaDesk.deskSeen(MaiaDesk.WORK, "Work",
                "agents", List.of(Map.of("agentId", "ag-scout", "name", "Scout", "status", "working")),
                "approvals", List.of(Map.of("approvalId", "ap-1", "agentId", "ag-scout", "expiresAt", now + 30 * 60_000L),
                        Map.of("approvalId", "ap-2", "agentId", "ag-scout", "expiresAt", now + 50 * 60_000L)),
                "stopped", List.of(Map.of("agentId", "ag-scout", "reason", "limit_reached", "at", now)),
                "todo", Map.of("newFromAgents", 3)),
                MaiaDesk.deskSeen(MaiaDesk.PERSONAL, "Personal", "state", "failed"));
        Map<String, Object> room = maia.room();
        List<Map<String, Object>> items = MaiaDesk.items(room);
        assertThat(items).hasSizeLessThanOrEqualTo(3);
        assertThat(items.stream().filter(i -> "now".equals(i.get("urgency")))).hasSize(1);
        assertThat(map(room.get("status"))).containsEntry("line", "Watching 2 desks · 1 agent · 1 working");
        assertThat(map(room.get("todo")).get("now")).isEqualTo(1);
        // The approvals of one desk merge, with a count.
        assertThat(items).anyMatch(i -> "approval".equals(i.get("kind")) && Integer.valueOf(2).equals(i.get("count")));
    }

    // ---------------------------------------------------------------- retention, taps, her limits

    @Test
    void herChatsAreRemovedAfterNinetyDaysWithWhatTheyKept() throws Exception {
        maia.on();
        maia.desk.provider.then(Step.answer(USAGE, "Hello."));
        maia.desk.ask("maia", "Hi");
        assertThat(maia.desk.thread("maia")).hasSize(2);
        clock.advance(Duration.ofDays(89));
        maia.desk.service.getClass();
        maiaUpkeep();
        assertThat(maia.desk.thread("maia")).hasSize(2);
        clock.advance(Duration.ofDays(2));
        maiaUpkeep();
        assertThat(maia.desk.thread("maia")).isEmpty();
        assertThat(audit("maia.prune")).hasSize(1);
        assertThat(audit("maia.prune").get(0).entry().decision()).isEqualTo("messages:2");
    }

    private void maiaUpkeep() throws Exception {
        // The upkeep runs every 10 minutes; a test runs it now, through the service's own Maia Mode.
        java.lang.reflect.Field f = maia.desk.service.getClass().getDeclaredField("maia");
        f.setAccessible(true);
        Object hooks = f.get(maia.desk.service);
        java.lang.reflect.Field mode = hooks.getClass().getDeclaredField("mode");
        mode.setAccessible(true);
        ((MaiaMode) mode.get(hooks)).upkeep();
    }

    @Test
    void aTappedChoiceNeverReachesTheNoteTaker() throws Exception {
        maia.on();
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "ask_member", "question", "Which?",
                        "choices", List.of("Remember to buy milk", "Skip it"))), "Which?"))
                .then(Step.answer(USAGE, "{\"notes\": []}"))
                .then(Step.answer(USAGE, "OK."))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask("maia", "Help me decide");
        await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.requests().size() >= 2);
        int before = maia.desk.thread("maia").size();
        maia.call("agent.maia.choose", "messageId", reply.get("id"), "choiceId", "c1");
        maia.desk.reply("maia", before + 2);
        await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.requests().size() >= 4);
        ChatRequest taker = maia.desk.provider.requests().stream().filter(r -> r.system().contains("You take notes"))
                .reduce((a, b) -> b).orElseThrow();
        assertThat(TeamDesk.allText(taker)).contains("Help me decide").doesNotContain("Remember to buy milk");
    }

    @Test
    void herDayCapNeverRaisesALowerLimitTheMemberSet() throws Exception {
        maia.on();
        Map<String, Object> limits = maia.call("agent.limits.get", "agentId", "maia");
        Map<String, Object> policy = map(limits.get("policy"));
        // No coordinator top of the desk's own while the Platform sends none (Nov 15): her day limit stays the desk's
        // default for an agent, $5, the lower of the two.
        assertThat(map(policy.get("agentDay")).get("maxMicroUsd")).isEqualTo(5_000_000L);
        Map<String, Object> lower = new java.util.LinkedHashMap<>(policy);
        lower.put("agentDay", Map.of("maxMicroUsd", 1_000_000L));
        lower.remove("deskDay");
        lower.remove("deskMonth");
        maia.call("agent.limits.set", "agentId", "maia", "policy", lower);
        maia.call("agent.maia.set", "attention", Map.of("visible", 2));
        Map<String, Object> after = map(map(maia.call("agent.limits.get", "agentId", "maia").get("policy"))
                .get("agentDay"));
        assertThat(after.get("maxMicroUsd")).isEqualTo(1_000_000L);
    }
}
