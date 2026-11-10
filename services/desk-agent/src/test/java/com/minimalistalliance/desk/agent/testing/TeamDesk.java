package com.minimalistalliance.desk.agent.testing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.attach.Parsers;
import com.minimalistalliance.desk.agent.attach.Preparer;
import com.minimalistalliance.desk.agent.attach.Staging;
import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.key.KeyVault;
import com.minimalistalliance.desk.agent.limits.LimitSettings;
import com.minimalistalliance.desk.agent.limits.PriceTable;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.llm.LlmGateway;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.service.AgentService;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.service.TopicHub;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.team.Team;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.Duration;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * One start of desk-agent for the many-agents tests (task 49): a real {@link AgentService} and {@link Team} on real
 * SQLite files, a real vault and the workspaces and icons under {@code data}, with a fake provider and a clock the
 * test moves. Close it and open another on the same {@code data} and clock and that is a restart.
 *
 * <p>The timers' own thread is stopped right after the start, so a test fires timers when it says
 * ({@code team.timers().runDue()}); {@link #withTimerThread} keeps it.
 */
public final class TeamDesk implements AutoCloseable {

    public static final String KEY = "sk-fake-teamdesk-0123456789abcdef";

    public final Path data;
    public final MutableClock clock;
    public final AuditLog audit;
    public final UsageLedger ledger;
    public final AgentStore store;
    public final KeyRing keys;
    public final KeyVault vault;
    public final FakeProvider provider = new FakeProvider();
    public final LimitSettings limits = new LimitSettings();
    public final AgentService service;
    public final Team team;
    public final TopicHub topics = new TopicHub();
    public final Staging staging;
    private final Parsers parsers = new Parsers(30);

    /** The size of the volume the workspaces count against, which a test may set (default: huge). */
    public final java.util.concurrent.atomic.AtomicLong volume = new java.util.concurrent.atomic.AtomicLong(Long.MAX_VALUE / 4);

    public TeamDesk(Path data) throws SQLException {
        this(data, new MutableClock(Rig.START), false);
    }

    public TeamDesk(Path data, MutableClock clock) throws SQLException {
        this(data, clock, false);
    }

    public static TeamDesk withTimerThread(Path data, MutableClock clock) throws SQLException {
        return new TeamDesk(data, clock, true);
    }

    private TeamDesk(Path data, MutableClock clock, boolean timerThread) throws SQLException {
        this.data = data;
        this.clock = clock;
        audit = new AuditLog(data.resolve("audit.db"), clock);
        ledger = new UsageLedger(data.resolve("usage.db"), clock, ZoneOffset.UTC);
        store = new AgentStore(data.resolve("agent.db"), clock);
        keys = new KeyRing((action, target, decision) -> audit.append(AuditLog.Entry.of(
                target.equals("keys:all") ? "system" : "user", action, target, decision)));
        vault = new KeyVault(data.resolve("keys"));
        audit.open();
        ledger.open();
        store.open();
        ProviderRegistry providers = new ProviderRegistry();
        providers.register(provider);
        PriceTable prices = new PriceTable(Pricing.of(Map.of(FakeProvider.ID.id() + "/" + Rig.MODEL,
                new Pricing.Price(1_000_000, 100_000, 1_250_000, 2_000_000))));
        ManagerAgent manager = new ManagerAgent(new LlmGateway(providers, keys, prices, ledger, audit), keys, limits,
                clock);
        team = Teams.team(store, limits, audit, data, clock, volume::get);
        staging = new Staging(clock, AgentService.STAGING_BYTES);
        service = new AgentService(store, manager, keys, vault, providers, prices, limits, ledger, audit,
                topics, clock, team, staging, new Preparer(parsers));
        service.restore();
        if (!timerThread) {
            team.timers().close();
        }
    }

    // ---------------------------------------------------------------- calls

    /** Params from pairs; unlike {@code Map.of} a value may be null. */
    public static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    public Map<String, Object> call(String method, Object... pairs) throws Exception {
        return service.call(method, m(pairs));
    }

    /** The refusal of a call that must be refused. */
    public RpcError refused(String method, Object... pairs) {
        try {
            service.call(method, m(pairs));
        } catch (RpcError e) {
            return e;
        } catch (Exception e) {
            throw new AssertionError("refused some other way: " + e);
        }
        throw new AssertionError(method + " wasn't refused");
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> list(Object value) {
        return (List<Map<String, Object>>) value;
    }

    /** {@code desk.account.set} with the tier's values and, if given, the account's time zone. */
    public void tier(Map<String, Object> tier) throws Exception {
        service.call("desk.account.set", m("tier", tier));
    }

    public void zone(String name) throws Exception {
        service.call("desk.account.set", m("timeZone", name));
    }

    // ---------------------------------------------------------------- keys and agents

    /** The desk's one key, added the first time. */
    public String key() throws Exception {
        List<Map<String, Object>> keys = list(call("agent.key.list").get("keys"));
        if (!keys.isEmpty()) {
            return (String) keys.get(0).get("keyId");
        }
        byte[] bytes = KEY.getBytes(StandardCharsets.US_ASCII);
        Map<String, Object> added = service.keyAdd(m("provider", FakeProvider.ID.id(), "label", "Main", "deskId", "d-test"),
                ByteBuffer.allocateDirect(bytes.length).put(bytes).flip());
        return (String) map(added.get("key")).get("keyId");
    }

    public void bind(String agentId) throws Exception {
        call("agent.bind", "agentId", agentId, "keyId", key(), "model", Rig.MODEL);
    }

    /** The lead, on the desk's key. */
    public void bindLead() throws Exception {
        bind(AgentStore.MANAGER);
    }

    /** A new staff agent on the desk's key, solo, with these extra {@code agent.create} fields. @return its id */
    public String agent(String name, Object... more) throws Exception {
        Map<String, Object> p = m("name", name, "keyId", key(), "model", Rig.MODEL);
        Map<String, Object> extra = m(more);
        p.putAll(extra);
        return (String) map(service.call("agent.create", p).get("agent")).get("id");
    }

    /** Lets {@code from} message these agents ({@code to} then {@code rules}, ...), and opens both ends. */
    public void link(String from, Object... toAndRules) throws Exception {
        List<Map<String, Object>> links = new ArrayList<>();
        for (int i = 0; i < toAndRules.length; i += 2) {
            links.add(m("to", toAndRules[i], "rules", toAndRules[i + 1]));
        }
        call("agent.links.set", "agentId", from, "solo", false, "links", links);
    }

    /** Opens an agent to messages without links of its own. */
    public void open(String agentId) throws Exception {
        call("agent.links.set", "agentId", agentId, "solo", false, "links", List.of());
    }

    public Map<String, Object> agentView(String agentId) throws Exception {
        return map(call("agent.get", "agentId", agentId).get("agent"));
    }

    // ---------------------------------------------------------------- threads

    public List<Map<String, Object>> thread(String agentId) throws Exception {
        return list(call("agent.thread.get", "agentId", agentId).get("messages"));
    }

    /** Waits until nothing in the thread is still streaming. */
    public List<Map<String, Object>> settled(String agentId) {
        AtomicReference<List<Map<String, Object>>> last = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            last.set(thread(agentId));
            return last.get().stream().noneMatch(message -> "streaming".equals(message.get("state")));
        });
        return last.get();
    }

    /** Sends the member's message and waits for the reply to end. @return the reply */
    public Map<String, Object> ask(String agentId, String text) throws Exception {
        int before = thread(agentId).size();
        Map<String, Object> sent = call("agent.message.send", "agentId", agentId, "text", text);
        assertThat(sent).containsKey("runId");
        return reply(agentId, before + 2);
    }

    /** The newest message of the thread once it has {@code size} messages and none streams. */
    public Map<String, Object> reply(String agentId, int size) {
        AtomicReference<List<Map<String, Object>>> last = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(15)).until(() -> {
            last.set(settled(agentId));
            return last.get().size() >= size;
        });
        return last.get().get(last.get().size() - 1);
    }

    public Map<String, Object> lastReply(String agentId) {
        List<Map<String, Object>> thread = settled(agentId);
        return thread.get(thread.size() - 1);
    }

    // ---------------------------------------------------------------- what the provider saw

    public List<ChatRequest> requests() {
        return provider.requests();
    }

    public ChatRequest lastRequest() {
        List<ChatRequest> requests = requests();
        return requests.get(requests.size() - 1);
    }

    public static List<String> toolNames(ChatRequest request) {
        return request.tools().stream().map(ToolSpec::name).toList();
    }

    /** The tool results the request carries, oldest first. */
    public static List<ToolResult> toolResults(ChatRequest request) {
        List<ToolResult> results = new ArrayList<>();
        for (ChatMessage message : request.messages()) {
            results.addAll(message.toolResults());
        }
        return results;
    }

    public static ToolResult lastToolResult(ChatRequest request) {
        List<ToolResult> results = toolResults(request);
        return results.get(results.size() - 1);
    }

    /** Every text the request carries, joined: for "does the model read this". */
    public static String allText(ChatRequest request) {
        StringBuilder text = new StringBuilder(request.system());
        for (ChatMessage message : request.messages()) {
            text.append('\n').append(message.text());
            for (ToolResult result : message.toolResults()) {
                text.append('\n').append(result.content());
            }
        }
        return text.toString();
    }

    // ---------------------------------------------------------------- restart

    @Override
    public void close() {
        service.stopAll();
        staging.close();
        parsers.close();
        keys.dropAll();
        store.close();
        ledger.close();
        audit.close();
    }
}
