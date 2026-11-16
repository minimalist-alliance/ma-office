package com.minimalistalliance.desk.agent.harness;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A desk for the harness's tests: a real desk-agent ({@link TeamDesk}) on real SQLite, linked to a {@link CountingDeskd}
 * that answers every registered tool ({@link ToolCases}) the way deskd does, with the member's yes relayed to it.
 */
public final class HarnessDesk implements AutoCloseable {

    public static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    public final MutableClock clock = new MutableClock(Rig.START);
    public final CountingDeskd deskd = new CountingDeskd();
    public final TeamDesk desk;

    public HarnessDesk(Path data) throws Exception {
        deskd.clock = clock::millis;
        for (ToolCases.Case c : ToolCases.all().values()) {
            if (c.result() != null) {
                deskd.results.put(c.tool(), args -> c.result().apply("x"));
            }
            if (c.lookRisk() != null) {
                deskd.lookRisk.put(c.tool(), c.lookRisk());
            }
        }
        desk = new TeamDesk(data, clock);
        desk.service.deskLink(deskd.attach());
        desk.service.agentTools().confirmFor(Duration.ofSeconds(1));
    }

    public static ToolCall call(String id, String tool, Object... pairs) {
        return Step.call(id, tool, pairs);
    }

    /** The Files folder and Notebook tab the harness's switches name: an unasked write lands inside them only. */
    public static final String AUTO_FOLDER = "Harness";
    public static final String AUTO_TAB = "tab-1";

    /**
     * The member switched these groups on for every agent, with their places (the Harness folder and tab), over the
     * ADR's own low-risk class: W3 as a desk has it. deskd's record of the switches is {@code CountingDeskd.switchOn}.
     */
    public static void autoOn(com.minimalistalliance.desk.agent.service.AgentService service, java.util.Set<String> groups) {
        service.approvals().lowRiskForTest(null);
        service.approvals().policy(com.minimalistalliance.desk.agent.approval.ApprovalPolicy.perAgentWithPlaces(
                id -> new com.minimalistalliance.desk.agent.approval.LowRisk.Switches(groups, AUTO_TAB, AUTO_FOLDER),
                com.minimalistalliance.desk.agent.approval.LowRisk.ADR));
    }

    public static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    /** The model's next steps: each a list of calls, or a String for a final answer. */
    public HarnessDesk script(Object... steps) {
        for (Object s : steps) {
            if (s instanceof String text) {
                desk.provider.then(Step.answer(USAGE, text));
            } else if (s instanceof ToolCall one) {
                desk.provider.then(Step.calls(USAGE, List.of(one)));
            } else {
                @SuppressWarnings("unchecked")
                List<ToolCall> calls = (List<ToolCall>) s;
                desk.provider.then(Step.calls(USAGE, calls));
            }
        }
        return this;
    }

    public String send(String agentId, String text) throws Exception {
        return (String) desk.call("agent.message.send", "agentId", agentId, "text", text).get("runId");
    }

    public List<Map<String, Object>> pending(String agentId) throws Exception {
        return list(desk.call("agent.approvals.list", "agentId", agentId).get("approvals"));
    }

    public List<Map<String, Object>> cards(String agentId) throws Exception {
        return list(desk.call("agent.approvals.list", "agentId", agentId, "state", "all").get("approvals"));
    }

    /** Waits for {@code n} pending cards. */
    public List<Map<String, Object>> awaitCards(String agentId, int n) {
        List<Map<String, Object>> last = new ArrayList<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            last.clear();
            last.addAll(pending(agentId));
            return last.size() >= n;
        });
        return last;
    }

    public Map<String, Object> awaitCard(String agentId) {
        return awaitCards(agentId, 1).get(0);
    }

    public static String sha(Map<String, Object> card) {
        return Approvals.hash((String) card.get("agentId"), (String) card.get("runId"), (String) card.get("tool"),
                (String) card.get("context"), map(card.get("payload")));
    }

    /** The member's yes, relayed to deskd (its ticket) and heard by desk-agent. */
    public void approve(Map<String, Object> card) throws Exception {
        deskd.relay((String) card.get("id"), sha(card), (String) card.get("agentId"));
        desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", true, "sha256", sha(card));
    }

    public void decline(Map<String, Object> card, String note) throws Exception {
        if (note == null) {
            desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", false, "sha256", sha(card));
        } else {
            desk.call("agent.approval.decide", "approvalId", card.get("id"), "approve", false, "sha256", sha(card),
                    "note", note);
        }
    }

    /** The run's reply once it ends. */
    public Map<String, Object> ended(String agentId) {
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            List<Map<String, Object>> t = desk.thread(agentId);
            return !t.isEmpty() && "assistant".equals(t.get(t.size() - 1).get("role"))
                    && !"streaming".equals(t.get(t.size() - 1).get("state"));
        });
        return desk.lastReply(agentId);
    }

    /** What the model read as tool results in its last request, oldest first. */
    public List<String> results() {
        List<String> out = new ArrayList<>();
        for (ToolResult r : TeamDesk.toolResults(desk.lastRequest())) {
            out.add(r.content());
        }
        return out;
    }

    @Override
    public void close() {
        desk.close();
    }
}
