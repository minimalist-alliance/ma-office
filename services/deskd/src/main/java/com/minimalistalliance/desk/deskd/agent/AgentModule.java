package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.platform.AccountDefaults;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.ModelPrices;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * deskd's relay of {@code agent.*} to desk-agent (services/desk-agent/docs/proposals.md sections 5 and 8): the link to
 * desk-agent's socket, the methods and the two topics, and what the heartbeat and {@code /health} say of the agents.
 * desk-agent holds the agents, threads, keys and limits, and deskd holds none of it: it checks the session and relays.
 * It also hands desk-agent what only deskd can learn from the Platform ({@link AgentPushes}).
 *
 * <p>A problem here never fails {@code /health} and never touches anything else: with desk-agent away, its calls get
 * {@code unavailable} and its topics stay quiet until it's back.
 */
public final class AgentModule implements AgentLink.Listener {

    public static final String STATE_TOPIC = AgentTopics.STATE;
    public static final String CONVERSATION_TOPIC = AgentTopics.CONVERSATION;

    /** A run's waits that aren't work: for the member's answer, and for another desk's (draft ADR §14). */
    private static final java.util.Set<Object> WAITS = java.util.Set.of("awaiting_approval", "waiting_desk");
    /** agent.md: while busy, a time at most 10 min ahead, extended on every heartbeat. */
    private static final Duration BUSY_AHEAD = Duration.ofMinutes(10);
    /** How long the tools' hello waits for desk-agent's answer. */
    private static final Duration HELLO_WAIT = Duration.ofSeconds(10);
    /** After a push got no answer on a link that stayed up. */
    private static final Duration PUSH_RETRY = Duration.ofSeconds(5);

    private final AgentLink link;
    private final AgentTopics topics;
    private final AgentMethods methods;
    private final AgentPushes pushes;
    private final AgentPurges purges;
    /** deskd's own record of the member's yeses, which the tools deskd runs for desk-agent redeem (API.md section 18). */
    private final ApprovalTickets tickets;
    /** deskd's own record of each agent's access (draft ADR section 16), which the tools deskd runs check first. */
    private final AccessRecord access;
    /** deskd's own record of Maia Mode and Desk Maia's grants (API.md §23). */
    private final MaiaRecord maia;
    private final Clock clock;
    /** deskd's own subscription to {@code agent.state}, for the heartbeat. -1 while the link is down. */
    private volatile long statusSid = -1;
    /** Each agent's status from the latest {@code agent.state}, or null before one has come on this link. */
    private volatile List<String> statuses;
    private volatile Instant lastActivity;
    private volatile Instant lastLlmCall;
    private volatile String reported = "offline";
    private volatile Runnable onChange = () -> {};
    /** The tools deskd runs for desk-agent (draft ADR "the Agent's tools and approvals"), or null for none. */
    private volatile ToolHost tools;
    private final RpcDispatcher dispatcher;
    private final AgentMethods.Waits waits;
    private final Supplier<AgeBand.Band> band;
    /** Messages between the member's desks (draft ADR §14), or null until {@link #desks}. */
    private volatile DeskMethods desks;
    private volatile com.minimalistalliance.desk.deskd.desks.DeskMessaging deskMessaging;
    /** Each agent's name from the latest {@code agent.state}, for the other desk's words. */
    private volatile Map<String, String> names = Map.of();
    /** Desk Maia's model through deskd (API.md §23, "Her model"), or null where deskd wasn't given one. */
    private volatile MaiaModel maiaModel;
    /** Helpers on MA's credits (API.md §24): their model calls and the member's credits, relayed like Desk Maia's. */
    private volatile HelperModel helperModel;
    /** Whether the tools' hello on the connection now offered her model. */
    private volatile boolean helloOfferedMaia;

    /** @param band the owner's age band: the Agent app is off for a teen, and waits while it's unknown */
    public AgentModule(Path socket, RpcDispatcher dispatcher, EventHub hub, Supplier<String> deskId, Clock clock, AgeBand band) {
        this(socket, dispatcher, hub, deskId, clock, AgentLink.Timing.DEFAULT, AgentMethods.Waits.DEFAULT, band::band);
        band.onLockBegins(topics::endForTeen);
        // desk-agent fires no timer and starts no message's run unless the band is adult (task 49, Security T49K-2).
        band.onLockBegins(() -> pushes.band(AgeBand.Band.TEEN.wire()));
        band.onSettled(() -> pushes.band(wire(band.band())));
        pushes.band(wire(band.band()));
    }

    AgentModule(
            Path socket,
            RpcDispatcher dispatcher,
            EventHub hub,
            Supplier<String> deskId,
            Clock clock,
            AgentLink.Timing timing,
            AgentMethods.Waits waits,
            Supplier<AgeBand.Band> band) {
        this.link = new AgentLink(socket, timing);
        this.clock = clock;
        this.dispatcher = dispatcher;
        this.waits = waits;
        this.band = band;
        this.topics = new AgentTopics(link, hub, waits.call(), band);
        topics.register();
        this.tickets = new ApprovalTickets(clock);
        this.access = new AccessRecord(clock);
        this.maia = new MaiaRecord(clock);
        this.methods = new AgentMethods(link, deskId, waits, band, tickets, access);
        methods.maia(maia);
        methods.register(dispatcher);
        this.pushes = new AgentPushes(link, waits.call(), PUSH_RETRY);
        this.purges = new AgentPurges(link, waits.call(), PUSH_RETRY, clock);
        purges.onPurged(access::forget);
    }

    private static String wire(AgeBand.Band band) {
        return band == null ? "unknown" : band.wire();
    }

    /** Hands desk-agent what the Platform says of prices and the account's limits (ADR 0043). Before {@link #start}. */
    public void followPlatform(ModelPrices prices, AccountDefaults account) {
        prices.onChange(() -> pushes.prices(prices.current()));
        account.onChange(() -> pushes.account(account.current()));
        if (account.current() != null) {
            pushes.account(account.current()); // the last values kept, until a fresh config says
        }
    }

    /** A guild desk's agent settings (API.md section 14): desk-agent has them on every connection from now on. */
    public void guildSettings(Map<String, Object> settings) {
        pushes.guild(settings);
    }

    /**
     * A guild desk's owed member purges (ADR 0080's addendum of 2026-11-10): each goes to desk-agent as
     * {@code desk.member.purge} once it's due and desk-agent is connected, and on every connection after until it's done.
     */
    public void memberPurges(MemberPurges list) {
        purges.queue(list);
    }

    /** Where {@code guild.usage.get} finds a member's name: the roster's, else a live session's. */
    public void memberNames(java.util.function.Function<String, String> names) {
        methods.memberNames(names);
    }

    /**
     * The member's yeses as deskd relayed them: a tool deskd runs for desk-agent (Browser, Files, Notebook) calls
     * {@link ApprovalTickets#redeem} before it runs, and runs only on a success.
     */
    public ApprovalTickets approvalTickets() {
        return tickets;
    }

    /**
     * deskd's own record of what the member chose for each agent on its setup screen, recorded only from the member's
     * relayed {@code agent.access.set} and {@code agent.desks.revoke}: a tool deskd runs for desk-agent checks it first
     * ({@link ToolHost#access}).
     */
    public AccessRecord accessRecord() {
        return access;
    }

    /**
     * Told of each run the member started with their own message: deskd relayed their {@code agent.message.send} from a
     * session of theirs, and desk-agent answered with the run (To-do's attended runs and {@code agent_chat} source).
     */
    public void onMemberRun(AgentMethods.MemberRuns listener) {
        methods.memberRuns(listener);
    }

    /**
     * Reads the access record, and Maia Mode's record, from deskd's data directory and keeps them there. Before
     * {@link #start}.
     */
    public void keepAccessIn(Path directory) {
        access.keepIn(directory);
        maia.keepIn(directory);
    }

    /**
     * deskd's own record of Maia Mode and Desk Maia's grants (API.md §23), recorded only from the member's relayed
     * {@code agent.maia.set}, {@code grant.set} and {@code grant.revoke}: her briefs ({@code desk_message}) go by it.
     */
    public MaiaRecord maiaRecord() {
        return maia;
    }

    /**
     * The tools deskd runs for desk-agent: on each connection deskd says which ({@link ToolHost#HELLO}), and answers
     * desk-agent's {@code tcall}s. Before {@link #start}.
     */
    public void hostTools(ToolHost host) {
        this.tools = host;
        // The member's undo of a call done without asking goes by the tool host's own ledger (draft ADR section 15).
        methods.undoer((approvalId, caller, effect) -> host.undoAuto(approvalId, caller, AccessRecord::mayDecideFor,
                effect));
    }

    /**
     * Messages between the member's desks (draft ADR §14): the client's {@code agent.desks.*}, and deskd's part around
     * the member's grants, over this desk's keys and record. Before {@link #start}.
     */
    public void desks(com.minimalistalliance.desk.deskd.desks.DeskMessaging messaging,
            java.util.function.BooleanSupplier guildDesk) {
        DeskMethods methods = new DeskMethods(link, messaging, waits.call(), band, guildDesk, this::agentName);
        methods.register(dispatcher);
        methods().desks(methods);
        this.desks = methods;
        this.deskMessaging = messaging;
    }

    /** This desk's keys and record of the grants between the member's desks, once {@link #desks} has wired them. */
    public com.minimalistalliance.desk.deskd.desks.DeskMessaging deskMessaging() {
        return deskMessaging;
    }

    /** An agent's name as the latest {@code agent.state} has it, or null. */
    public String agentName(String agentId) {
        return agentId == null ? null : names.get(agentId);
    }

    /**
     * Desk Maia's model (API.md §23, "Her model"): a {@code tcall} with {@code tool: "maia_model"} goes to it, never to the
     * tool host, and the tools' hello offers it while the service is configured. Before {@link #start}.
     */
    public void maiaModel(MaiaModel model) {
        this.maiaModel = model;
    }

    /**
     * Helpers on MA's credits (API.md §24): {@code tcall}s with {@code tool: "helpers_model"} or {@code "helpers_credits"} go to
     * it, never to the tool host, and the tools' hello says {@code helpers: {model: true}} while the service is configured.
     * Before {@link #start}.
     */
    public void helperModel(HelperModel model) {
        this.helperModel = model;
    }

    /**
     * The config changed: when whether her model is offered changed since the connection's hello (the service's endpoint
     * first appeared, or went), the hello goes again, so desk-agent knows now rather than at its next connection.
     */
    public void maiaServiceChanged() {
        MaiaModel model = maiaModel;
        ToolHost host = tools;
        if (model == null || host == null || !link.isConnected() || model.offered() == helloOfferedMaia) {
            return;
        }
        sayHello(host);
    }

    /** Starts connecting to desk-agent. */
    public void start() {
        pushes.start();
        purges.start();
        link.start(this);
    }

    public void close() {
        ToolHost host = tools;
        if (host != null) {
            host.close();
        }
        pushes.close();
        purges.close();
        link.close();
    }

    /** Runs when what the heartbeat says of the agents changes, such as from online to busy. Must not block. */
    public void onStatusChange(Runnable action) {
        onChange = action;
    }

    @Override
    public void connected() {
        long sid = link.newSid();
        statusSid = sid;
        // deskd's own, for the heartbeat: on a guild desk every member's agents, which no client sees this way.
        link.subscribe(sid, AgentTopics.STATE, Map.of("kind", "system"));
        topics.connected();
        pushes.connected();
        purges.connected();
        DeskMethods grants = desks;
        if (grants != null) {
            grants.connected();
        }
        ToolHost host = tools;
        if (host != null) {
            sayHello(host);
        }
    }

    /** The tools' hello, with {@code maia: {model: true}} while her model is offered (an older desk-agent ignores it). */
    private void sayHello(ToolHost host) {
        MaiaModel model = maiaModel;
        boolean maia = model != null && model.offered();
        helloOfferedMaia = maia;
        HelperModel helpers = helperModel;
        boolean helping = helpers != null && helpers.offered();
        // A plain req: an older desk-agent answers not_found, the link stays, and it sends no tcall.
        Thread.ofVirtual().name("agent-tools-hello").start(() -> {
            try {
                Map<String, Object> hello = new LinkedHashMap<>(host.hello());
                if (maia) {
                    hello.put("maia", Map.of("model", true));
                }
                if (helping) {
                    // An older desk-agent ignores it, and its helpers stay on members' own keys.
                    hello.put("helpers", Map.of("model", true));
                }
                link.call(ToolHost.HELLO, hello, HELLO_WAIT);
            } catch (Exception e) {
                // An older desk-agent, or a link that went: the next connection says it again.
            }
        });
    }

    @Override
    public void toolCall(Map<String, Object> message) {
        if (HelperModel.handles(message.get("tool"))) {
            // A helper on MA's credits goes to the service, never to the tool host (API.md §24).
            HelperModel model = helperModel;
            if (model == null) {
                Map<String, Object> refused = new LinkedHashMap<>();
                refused.put("t", "terr");
                refused.put("id", message.get("id"));
                refused.put("code", "unavailable");
                refused.put("details", Map.of("reason", "no_service"));
                link.reply(refused);
                return;
            }
            model.onCall(message, link::reply);
            return;
        }
        if (MaiaModel.TOOL.equals(message.get("tool"))) {
            // Her model goes to Desk Maia's service, never to the tool host (API.md §23, "Her model").
            MaiaModel model = maiaModel;
            if (model == null) {
                Map<String, Object> refused = new LinkedHashMap<>();
                refused.put("t", "terr");
                refused.put("id", message.get("id"));
                refused.put("code", "unavailable");
                refused.put("details", Map.of("reason", "no_service"));
                link.reply(refused);
                return;
            }
            model.onCall(message, link::reply);
            return;
        }
        ToolHost host = tools;
        if (host == null) {
            Map<String, Object> refused = new LinkedHashMap<>();
            refused.put("t", "terr");
            refused.put("id", message.get("id"));
            refused.put("code", "unavailable");
            refused.put("details", Map.of("reason", "tools"));
            link.reply(refused);
            return;
        }
        host.onCall(message, link::reply);
    }

    @Override
    public void disconnected() {
        statusSid = -1;
        statuses = null;
        pushes.disconnected();
        purges.disconnected();
        topics.disconnected();
        changed();
    }

    @Override
    public void event(long sid, String topic, String type, Map<String, Object> data) {
        if (sid == statusSid) {
            if ("snapshot".equals(type)) {
                observe(data);
            }
            return;
        }
        topics.event(sid, type, data);
    }

    /**
     * What {@code /health} adds: informational only, as desk-agent's own health is its own. On a guild desk also
     * {@code guildPurges: {owed, held, done}}, counts with no member named.
     */
    public Map<String, Object> health() {
        Map<String, Object> health = new LinkedHashMap<>();
        health.put("agent", link.isConnected() ? "connected" : "waiting");
        health.putAll(purges.health());
        return health;
    }

    /** How many agents are working now, the heartbeat's {@code activeTasks}, without marking anything reported. */
    public int activeTasks() {
        List<String> now = statuses;
        return now == null ? 0 : (int) now.stream().filter("working"::equals).count();
    }

    /** The heartbeat's {@code agent} (agent.md): status {@code online}, {@code busy}, {@code error} or {@code offline}. */
    public Map<String, Object> heartbeatFields() {
        List<String> now = statuses;
        String status = status(now);
        int working = now == null ? 0 : (int) now.stream().filter("working"::equals).count();
        Instant at = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        Map<String, Object> agent = new LinkedHashMap<>();
        agent.put("status", status);
        agent.put("busyUntil", working > 0 ? at.plus(BUSY_AHEAD).toString() : null);
        agent.put("activeTasks", working);
        agent.put("lastActivityAt", text(lastActivity));
        agent.put("lastLlmCallAt", text(lastLlmCall));
        reported = status;
        return agent;
    }

    /** {@code awaiting_approval}, or a durable wait's {@code waiting_<kind>}. */
    static boolean waits(Object statusDetail) {
        return statusDetail instanceof String d && (WAITS.contains(d) || d.startsWith("waiting_"));
    }

    /** Who else hears deskd's own agent.state (Maia while the member is away). Must not block. */
    private volatile java.util.function.Consumer<Map<String, Object>> stateListener = d -> {};

    public void onAgentState(java.util.function.Consumer<Map<String, Object>> listener) {
        this.stateListener = listener == null ? d -> {} : listener;
    }

    /** deskd's own calls to desk-agent (deskd-only methods), for Maia while the member is away. */
    public Object callAgent(String method, Map<String, Object> params, Duration wait) throws Exception {
        return link.call(method, params, wait);
    }

    public boolean agentConnected() {
        return link.isConnected();
    }

    /** deskd's envelopes owed to desk-agent go now (after a revoke). */
    public void pushOwedDesks() {
        DeskMethods d = desks;
        if (d != null) {
            d.pushOwed();
        }
    }

    private void observe(Map<String, Object> data) {
        try {
            stateListener.accept(data);
        } catch (RuntimeException e) {
            // A listener's trouble is its own.
        }
        List<String> next = new ArrayList<>();
        Map<String, String> named = new java.util.HashMap<>();
        if (data.get("agents") instanceof List<?> agents) {
            for (Object agent : agents) {
                if (agent instanceof Map<?, ?> map && map.get("status") instanceof String status) {
                    // A run waiting for the member's answer, or on something outside it (another desk's answer:
                    // statusDetail waiting_<kind>, durable runs), isn't work: it doesn't keep the desk awake (design 9.10;
                    // draft ADR §14).
                    next.add("working".equals(status) && waits(map.get("statusDetail")) ? "waiting" : status);
                }
                if (agent instanceof Map<?, ?> map && map.get("id") instanceof String id
                        && map.get("name") instanceof String name) {
                    named.put(id, name);
                }
            }
        }
        names = Map.copyOf(named);
        List<String> before = statuses;
        boolean wasWorking = before != null && before.contains("working");
        boolean working = next.contains("working");
        Instant now = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        if (working) {
            lastActivity = now;
        } else if (wasWorking) {
            // A run ended, which is an LLM call's end in Phase 1: a run is one call.
            lastActivity = now;
            lastLlmCall = now;
        }
        statuses = next;
        changed();
    }

    private void changed() {
        if (!status(statuses).equals(reported)) {
            onChange.run();
        }
    }

    private static String status(List<String> statuses) {
        if (statuses == null) {
            return "offline";
        }
        if (statuses.contains("working")) {
            return "busy";
        }
        return statuses.contains("error") ? "error" : "online";
    }

    private static String text(Instant instant) {
        return instant == null ? null : instant.toString();
    }

    /** For tests. */
    AgentPurges purges() {
        return purges;
    }

    /** For tests: as a price table's or a config's change does it. */
    AgentPushes pushes() {
        return pushes;
    }

    /**
     * Documents' reader (API.md §25): one {@code desk.docs.read} to desk-agent, deskd's own request (no caller), its facts
     * or {@code {skipped}}. At most 90 seconds: her service's own wait and the socket's.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> docsRead(Map<String, Object> params)
            throws com.minimalistalliance.desk.deskd.rpc.RpcException, InterruptedException {
        Object answer = link.call("desk.docs.read", params, java.time.Duration.ofSeconds(90));
        return answer instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of("skipped", "answer");
    }

    /**
     * Documents' write-ups (API.md §25 "Intake"): one {@code desk.docs.writeups} to desk-agent, deskd's own request (no
     * caller): Desk Maia's write-ups kept on this desk after a cursor, one by its id, or the ids still kept. At most 15 s.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> docsWriteups(Map<String, Object> params)
            throws com.minimalistalliance.desk.deskd.rpc.RpcException, InterruptedException {
        Object answer = link.call("desk.docs.writeups", params, java.time.Duration.ofSeconds(15));
        return answer instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
    }

    /** For tests. */
    AgentLink link() {
        return link;
    }

    /** For tests. */
    /** Maia Mode is never turned on on a free member's desk: deskd's own tier limits say which (API.md §23). */
    public void freeDesk(java.util.function.BooleanSupplier free) {
        methods.freeDesk(free);
    }

    AgentMethods methods() {
        return methods;
    }

    /** For tests. */
    AgentTopics topics() {
        return topics;
    }

    List<String> relayedForTest() {
        return topics.relayedForTest();
    }
}
