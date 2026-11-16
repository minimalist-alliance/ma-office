package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.store.MessageRow;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.tool.RunContext;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Her to-dos from what a desk reported (the staging proof, Nov 15: "the tip never reached the To-do"). In the runs the
 * member didn't start (a report batch, a check-in) her {@code todo_add} was refused {@code source_unknown}: no member's
 * message started the run, and deskd hadn't given it the report, which came after her wait. The concept lets her file
 * to-dos in "From Maia" without a tap, while away too; so her runs now name the answers in her thread to deskd
 * ({@code origin: {kind: "maia", answers}}), deskd gives the ones it opened for her (its own record: {@code DeskSourcesTest},
 * {@code TodoToolsDeskdIntegrationTest}), and {@code desk {}} is a source the run was given: in the {@code todos} group,
 * done without asking under her switch, the item marked untrusted. Nothing else of hers changes.
 */
class MaiaAwayToDoTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);
    private static final String REPORT = "env-" + "q".repeat(26);
    private static final String OLDER = "env-" + "p".repeat(26);

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

    /** A report on her brief, put in her thread as deskd delivered it after her wait (origin {@code desk}, an answer). */
    private void reportCame(String id, String envelopeId, String text) throws Exception {
        String origin = "{\"kind\":\"desk\",\"deskId\":\"" + MaiaDesk.WORK + "\",\"agentId\":\"manager\",\"agentName\":"
                + "\"Lead\",\"role\":\"answer\",\"envelopeId\":\"" + envelopeId + "\",\"replyTo\":\"env-"
                + "r".repeat(26) + "\"}";
        clock.advance(Duration.ofSeconds(1));
        maia.desk.store.addMessages(List.of(MessageRow.from(id, MaiaAgent.ID, text, clock.millis(), origin)));
    }

    private void takerLast() {
        maia.desk.provider.onChat = request -> {
            if (request.system().startsWith("You take notes")) {
                await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.pending() <= 1);
            }
        };
    }

    @Test
    void aToDoFromAReportNamesItAndIsDoneWithoutATap() throws Exception {
        maia.on();
        takerLast();
        reportCame("rp-older", OLDER, "[report] status=done urgency=later importance=low");
        reportCame("rp-1", REPORT, "[report] status=done urgency=later importance=low writeup=wu-x\nfields: "
                + "{\"tip1\":\"Lead with the headline\"}");
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("toolu_01", "todo_add", "title",
                        "Lead with the headline in the weekly update", "source", Map.of("kind", "desk", "ref", Map.of())))))
                .then(Step.answer(USAGE, "It's on your to-do for tomorrow."))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Carry on with the tips");
        assertThat(reply).containsEntry("state", "done").containsEntry("text", "It's on your to-do for tomorrow.");

        // deskd heard which answers her run holds, oldest first, on the look and on the call; the run holds U.
        Map<String, Object> look = maia.deskd.looksOf("todo_add").get(0);
        assertThat(look.get("origin")).isEqualTo(Map.of("kind", "maia", "answers", List.of(OLDER, REPORT)));
        assertThat(String.valueOf(look.get("taint"))).contains("U");
        Map<String, Object> ran = maia.deskd.runsOf("todo_add").get(0);
        assertThat(ran.get("origin")).isEqualTo(Map.of("kind", "maia", "answers", List.of(OLDER, REPORT)));
        // Done without asking under her To-do switch: no card, the call carries its group and its own approval id.
        assertThat(ran).containsEntry("auto", "todos").containsKey("autoApprovalId");
        assertThat(list(maia.desk.call("agent.approvals.list", "agentId", MaiaAgent.ID).get("approvals"))).isEmpty();
        assertThat(list(maia.desk.call("agent.approvals.list", "agentId", MaiaAgent.ID, "state", "all")
                .get("approvals"))).singleElement().satisfies(a -> assertThat(a).containsEntry("decidedBy", "auto"));
    }

    @Test
    void herRunsNameOnlyAnswersAndNoOtherAgentsRunNamesAny() throws Exception {
        maia.on();
        // A message another desk sent her (not an answer), and her code's own batch line: neither is an answer.
        clock.advance(Duration.ofSeconds(1));
        maia.desk.store.addMessages(List.of(MessageRow.from("m-1", MaiaAgent.ID, "Hello", clock.millis(),
                "{\"kind\":\"desk\",\"role\":\"message\",\"envelopeId\":\"env-" + "m".repeat(26) + "\"}"),
                MessageRow.from("m-2", MaiaAgent.ID, "1 report came back", clock.millis() + 1,
                        "{\"kind\":\"maia\",\"role\":\"reports\",\"batch\":\"bt-1\"}"),
                MessageRow.from("m-3", MaiaAgent.ID, "Odd", clock.millis() + 2,
                        "{\"kind\":\"desk\",\"role\":\"answer\",\"envelopeId\":\"not-an-envelope\"}")));
        MaiaProfile profile = new MaiaProfile(null, n -> {
            try {
                return maia.desk.store.messages(MaiaAgent.ID, n);
            } catch (java.sql.SQLException e) {
                throw new IllegalStateException(e);
            }
        });
        RunContext hers = RunContext.of("run-1", MaiaAgent.ID, com.minimalistalliance.desk.agent.service.Caller.OWNER,
                Map.of("kind", "maia", "role", "reports"), "msg-1");
        assertThat(profile.origin(hers)).isNull();
        reportCame("rp-1", REPORT, "[report] status=done");
        reportCame("rp-again", REPORT, "[report] status=done");
        assertThat(profile.origin(hers)).isEqualTo(Map.of("kind", "maia", "answers", List.of(REPORT)));
        RunContext lead = RunContext.of("run-2", "manager", com.minimalistalliance.desk.agent.service.Caller.OWNER,
                Map.of("kind", "member"), "msg-2");
        assertThat(profile.origin(lead)).isNull();
        // At most the newest 32.
        List<MessageRow> many = new ArrayList<>();
        for (int i = 0; i < 40; i++) {
            String id = "env-" + "a".repeat(24) + (char) ('a' + i / 26) + (char) ('a' + i % 26);
            many.add(MessageRow.from("x-" + i, MaiaAgent.ID, "[report]", clock.millis() + 10 + i, "{\"kind\":\"desk\","
                    + "\"role\":\"answer\",\"envelopeId\":\"" + id + "\"}"));
        }
        maia.desk.store.addMessages(many);
        assertThat((List<?>) profile.origin(hers).get("answers")).hasSize(MaiaProfile.ANSWERS_NAMED);
    }

    @Test
    void theAwayRunsSayWhereATodoFromAReportComesFrom() {
        assertThat(Away.TODO_SOURCE).contains("desk {}");
    }
}
