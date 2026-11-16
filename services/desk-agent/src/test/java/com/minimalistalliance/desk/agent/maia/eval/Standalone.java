package com.minimalistalliance.desk.agent.maia.eval;

import com.minimalistalliance.desk.agent.maia.CodeCalls;
import com.minimalistalliance.desk.agent.maia.MaiaMode;
import com.minimalistalliance.desk.agent.maia.MaiaProfile;
import com.minimalistalliance.desk.agent.maia.MaiaStore;
import com.minimalistalliance.desk.agent.maia.TodoFiler;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.store.MessageRow;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import com.minimalistalliance.desk.agent.tool.Taint;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Maia Mode's own classes on a real {@code agent.db}, with the agent service's side faked ({@link MaiaMode.Host},
 * {@link CodeCalls}): for the evals of what code decides on its own (the list, her guard, the to-do filer), with no
 * run in between. Her thread is whatever the test puts in {@link #thread}.
 */
final class Standalone implements AutoCloseable {

    final MutableClock clock = new MutableClock(Rig.START);
    final AgentStore store;
    final MaiaMode mode;
    final MaiaProfile profile;
    /** The tier deskd last sent, as JSON (its {@code maiaMode} values are the Platform's), or null. */
    final java.util.concurrent.atomic.AtomicReference<String> tier = new java.util.concurrent.atomic.AtomicReference<>();
    /** Her Maia allowance as her service last reported it, or null. */
    final java.util.concurrent.atomic.AtomicReference<MaiaMode.Allowance> allowance =
            new java.util.concurrent.atomic.AtomicReference<>();
    final List<MessageRow> thread = new CopyOnWriteArrayList<>();
    final List<String> audit = new CopyOnWriteArrayList<>();
    final List<Map<String, Object>> published = new CopyOnWriteArrayList<>();
    final FakeCalls calls = new FakeCalls();

    private final Path data;

    Standalone(Path data) throws SQLException {
        this.data = data;
        store = new AgentStore(data.resolve("agent.db"), clock);
        store.open();
        mode = new MaiaMode(new MaiaStore(store, clock), clock, data, new Host(),
                (actor, action, target, decision) -> audit.add(actor + " " + action + " " + target + " " + decision),
                published::add);
        profile = new MaiaProfile(mode, n -> {
            List<MessageRow> all = new ArrayList<>(thread);
            return all.size() > n ? all.subList(all.size() - n, all.size()) : all;
        });
    }

    /** This desk listed for Maia Mode: its switch says on (API.md §23). */
    void list() {
        try {
            java.nio.file.Files.writeString(data.resolve(MaiaMode.SWITCH_FILE), "on\n");
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    Map<String, Object> call(String method, Object... pairs) throws RpcError, SQLException {
        return mode.call(method, TeamDesk.m(pairs), Caller.OWNER, desk -> "active");
    }

    void on() throws RpcError, SQLException {
        list();
        call("agent.maia.set", "on", true, "disclosure", MaiaMode.DISCLOSURE, "homeDeskId", EvalDesk.HOME,
                "notesTabId", EvalDesk.TAB);
    }

    void grant(String deskId, String name, boolean keeps, String... scopes) throws RpcError, SQLException {
        call("agent.maia.grant.set", "deskId", deskId, "deskName", name, "scopes", List.of(scopes), "keepsToItself",
                keeps);
    }

    TodoFiler todos() {
        return new TodoFiler(mode, calls, (agent, tool) -> true, agent -> true);
    }

    /** An answer from another desk as it lands in her thread after the wait (role answer, origin kind desk). */
    void answerInThread(String deskId, String text, boolean isPrivate) {
        String origin = "{\"kind\":\"desk\",\"deskId\":\"" + deskId + "\",\"agentId\":\"ag-scout\",\"agentName\":"
                + "\"Scout\",\"grantId\":\"dg-1\",\"envelopeId\":\"env-" + thread.size() + "\",\"role\":\"answer\","
                + "\"private\":" + isPrivate + "}";
        thread.add(MessageRow.from("m-" + thread.size(), "maia", text, clock.millis(), origin));
    }

    private final class Host implements MaiaMode.Host {
        @Override
        public Map<String, Object> sendAsMember(String text) {
            return Map.of("messageId", "m-sent", "runId", "r-sent");
        }

        @Override
        public void stopRuns() {}

        @Override
        public ZoneId zone() {
            return ZoneOffset.UTC;
        }

        @Override
        public void clearMemory() {}

        @Override
        public void republish(String messageId) {}

        @Override
        public String tier() {
            return tier.get();
        }

        @Override
        public MaiaMode.Allowance allowance() {
            return allowance.get();
        }

        @Override
        public boolean guildDesk() {
            return false;
        }

        @Override
        public boolean adult() {
            return true;
        }
    }

    /** deskd's tools and the model as the to-do filer sees them: scripted, every call recorded. */
    static final class FakeCalls implements CodeCalls {
        final List<String> tools = new CopyOnWriteArrayList<>();
        final List<Map<String, Object>> inputs = new CopyOnWriteArrayList<>();
        final List<Boolean> ended = new CopyOnWriteArrayList<>();
        final List<String[]> asked = new CopyOnWriteArrayList<>();
        volatile List<Map<String, Object>> batch = List.of();
        volatile String answer = "{\"todos\": []}";

        @Override
        public Result call(String agentId, String runId, Map<String, Object> origin, String replyId, Set<Taint> taint,
                String tool, Map<String, Object> input) {
            tools.add(tool);
            inputs.add(input);
            return switch (tool) {
                case "courier_new" -> new Result(true, null, Map.of("messages", batch, "more", false), null);
                case "todo_add" -> new Result(true, "ap-" + inputs.size(), Map.of("id", "td-" + inputs.size(),
                        "created", true), null);
                default -> Result.refusedWith("unexpected");
            };
        }

        @Override
        public void ended(String agentId, String runId, boolean done) {
            ended.add(done);
        }

        @Override
        public String complete(String agentId, String purpose, String system, String user, int maxOutputTokens) {
            asked.add(new String[] {purpose, system, user});
            return answer;
        }

        List<Map<String, Object>> inputsOf(String tool) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (int i = 0; i < tools.size(); i++) {
                if (tools.get(i).equals(tool)) {
                    out.add(inputs.get(i));
                }
            }
            return out;
        }
    }

    @Override
    public void close() {
        mode.close();
        store.close();
    }
}
