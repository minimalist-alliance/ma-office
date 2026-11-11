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
        this.topics = new AgentTopics(link, hub, waits.call(), band);
        topics.register();
        this.tickets = new ApprovalTickets(clock);
        this.methods = new AgentMethods(link, deskId, waits, band, tickets);
        methods.register(dispatcher);
        this.pushes = new AgentPushes(link, waits.call(), PUSH_RETRY);
        this.purges = new AgentPurges(link, waits.call(), PUSH_RETRY, clock);
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
     * The tools deskd runs for desk-agent: on each connection deskd says which ({@link ToolHost#HELLO}), and answers
     * desk-agent's {@code tcall}s. Before {@link #start}.
     */
    public void hostTools(ToolHost host) {
        this.tools = host;
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
        ToolHost host = tools;
        if (host != null) {
            // A plain req: an older desk-agent answers not_found, the link stays, and it sends no tcall.
            Thread.ofVirtual().name("agent-tools-hello").start(() -> {
                try {
                    link.call(ToolHost.HELLO, host.hello(), HELLO_WAIT);
                } catch (Exception e) {
                    // An older desk-agent, or a link that went: the next connection says it again.
                }
            });
        }
    }

    @Override
    public void toolCall(Map<String, Object> message) {
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

    private void observe(Map<String, Object> data) {
        List<String> next = new ArrayList<>();
        if (data.get("agents") instanceof List<?> agents) {
            for (Object agent : agents) {
                if (agent instanceof Map<?, ?> map && map.get("status") instanceof String status) {
                    // A run waiting for the member's answer isn't work: it doesn't keep the desk awake (design 9.10).
                    next.add("working".equals(status) && "awaiting_approval".equals(map.get("statusDetail"))
                            ? "waiting" : status);
                }
            }
        }
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

    /** For tests. */
    AgentLink link() {
        return link;
    }

    /** For tests. */
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
