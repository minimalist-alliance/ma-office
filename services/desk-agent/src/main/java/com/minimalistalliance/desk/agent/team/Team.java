package com.minimalistalliance.desk.agent.team;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.icon.IconException;
import com.minimalistalliance.desk.agent.icon.PngMark;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.limits.Limit;
import com.minimalistalliance.desk.agent.limits.LimitSettings;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentRow;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.store.KeyRow;
import com.minimalistalliance.desk.agent.store.MessageRow;
import com.minimalistalliance.desk.agent.store.TeamStore;
import com.minimalistalliance.desk.agent.store.TeamStore.Extras;
import com.minimalistalliance.desk.agent.store.TeamStore.Link;
import com.minimalistalliance.desk.agent.store.TeamStore.ProposalRow;
import com.minimalistalliance.desk.agent.store.TeamStore.TimerRow;
import com.minimalistalliance.desk.agent.workspace.WorkspaceException;
import com.minimalistalliance.desk.agent.workspace.Workspaces;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Many agents on a desk (task 49, ADR 0047): creating and removing them, their look, purpose, links, workspaces,
 * timers, icons, the agent-message log and the lead's proposals. {@code AgentService} keeps the threads, runs and keys
 * and hands this class every method of {@code docs/multi-agent.md}; this class calls back through {@link Host} to start
 * a run that the member didn't start (a timer's, another agent's message) and to publish what changed.
 *
 * <p>Every change here, by hand or from a proposal the member confirmed, goes through the same checks: a proposal's
 * yes runs exactly the code a member's own {@code agent.create} would.
 */
public final class Team {

    private static final Logger log = LoggerFactory.getLogger(Team.class);

    static final Pattern WORDS = Pattern.compile("[\\p{L}\\p{N} ._'-]{1,40}");
    static final Pattern LOOK_ID = Pattern.compile("[a-z][a-z0-9-]{0,31}");
    static final Pattern MODEL = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}");
    static final Pattern AGENT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    static final Pattern ITEM_ID = Pattern.compile("(tm|pr|am)-[a-z2-7]{12}");
    static final Duration PROPOSAL_LIFE = Duration.ofHours(24);
    /** Proposals waiting for the member at once, on the whole desk, and made by one run (AI M2, SET-L3). */
    static final int PENDING_MAX = 10;
    static final int RUN_PROPOSALS_MAX = 5;
    static final int A2A_PAGE = 100;
    static final int A2A_TEXT_MAX = 8000;
    static final int LABEL_MAX = 60;
    /** The agent-message log keeps 100 days, as the usage ledger does. */
    static final Duration A2A_KEEP = Duration.ofDays(100);
    /**
     * A workspace write must leave this much of the disk free. Chromium evicts a desk's browser data (IndexedDB, Cache
     * Storage) below about 800 MB free (ADR 0035), and that data is never cleared, so the floor sits well above it.
     */
    public static final long MIN_FREE_BYTES = 1536L << 20;
    /** The agents' quotas together may not pass this share of the volume (percent). */
    static final int WORKSPACE_BUDGET_PCT = 50;
    /** A create without a size is refused when less than this many MB of the budget is left. */
    static final int WORKSPACE_MIN_MB = 10;
    static final long MIB = 1L << 20;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] BASE32 = "abcdefghijklmnopqrstuvwxyz234567".toCharArray();

    /** A run's place in a chain of agent messages: who's in it, and how deep. */
    public record Chain(String id, int depth, List<String> agents) {
        public Chain {
            agents = List.copyOf(agents);
        }

        public static Chain start(String agentId) {
            return new Chain(newId("ch"), 0, List.of(agentId));
        }

        Chain then(String agentId) {
            List<String> next = new ArrayList<>(agents);
            next.add(agentId);
            return new Chain(id, depth + 1, next);
        }
    }

    /**
     * A run under way, as the tools see it. {@code origin} is what started it, as its user turn carries it: null for
     * the member's own message, else {@code kind} {@code agent} or {@code timer}.
     */
    public record RunInfo(String agentId, String replyId, Chain chain, Map<String, Object> origin) {
        public RunInfo(String agentId, String replyId, Chain chain) {
            this(agentId, replyId, chain, null);
        }
    }

    /** A run started for a timer or another agent's message. */
    public record Started(String runId, String replyId, CompletableFuture<ManagerAgent.RunResult> result,
            Runnable stop) {}

    /** {@code AgentService}'s side. */
    public interface Host {
        /**
         * Starts a run of {@code agentId} on a message the member didn't write, as {@code agent.message.send} does.
         *
         * @throws RpcError {@code busy}, {@code no_key}, {@code limit_reached} or {@code not_found}, before anything
         *     is added to the thread
         */
        Started start(String agentId, String text, Map<String, Object> origin, Chain chain)
                throws RpcError, SQLException;

        RunInfo run(String runId);

        boolean running(String agentId);

        void added(String agentId) throws SQLException;

        void removed(String agentId);

        void bind(String agentId, String keyId, String model) throws RpcError, SQLException;

        void republish(String agentId, String messageId);

        void publishState();

        /** The models the member's key may use, as last listed, or empty. */
        List<String> knownModels(String keyId);
    }

    private final AgentStore store;
    private final TeamStore team;
    private final LimitSettings limits;
    private final AuditLog audit;
    private final Workspaces workspaces;
    private final Path icons;
    private final Clock clock;
    private final TeamTools tools;
    private final Timers timers;
    /** Creating, deleting and linking agents one at a time, so the cap and the links' checks hold. */
    private final ReentrantLock agentsLock = new ReentrantLock();
    /**
     * Agents with a timer's or a message's run starting, and agents being deleted (ISO-L8): each side marks itself,
     * then looks for the other, so a delete never removes an agent whose run is about to write to its thread.
     */
    private final Map<String, Integer> starting = new ConcurrentHashMap<>();
    private final Set<String> deleting = ConcurrentHashMap.newKeySet();
    private volatile TierCaps caps = TierCaps.DEFAULTS;
    /** The owner's band is adult, as deskd last said; adult until it says otherwise (a desk with an older deskd). */
    private volatile boolean adult = true;
    /** {@link #pausedAgents}, until an agent is made or removed or the cap changes. */
    private volatile Set<String> pausedCache;
    private final java.util.concurrent.atomic.AtomicLong pausedGeneration = new java.util.concurrent.atomic.AtomicLong();
    private static final String SETTING_TIER = "account.tier";
    private static final String SETTING_BAND = "account.band";
    /** Whether any proposal was ever made: until one is, a thread's page reads no proposals. */
    private volatile boolean anyProposals = true;
    private volatile Host host;

    public Team(AgentStore store, TeamStore team, LimitSettings limits, AuditLog audit, Workspaces workspaces,
            Path icons, Clock clock) {
        this.store = store;
        this.team = team;
        this.limits = limits;
        this.audit = audit;
        this.workspaces = workspaces;
        this.icons = icons;
        this.clock = clock;
        this.tools = new TeamTools(this);
        this.timers = new Timers(this);
    }

    public void attach(Host host) {
        this.host = new Guarded(host);
    }

    Host host() {
        return host;
    }

    AgentStore store() {
        return store;
    }

    public TeamStore teamStore() {
        return team;
    }

    LimitSettings limits() {
        return limits;
    }

    Workspaces workspaces() {
        return workspaces;
    }

    Clock clock() {
        return clock;
    }

    public Timers timers() {
        return timers;
    }

    public TierCaps caps() {
        return caps;
    }

    /**
     * The tier's values from {@code desk.account.set}'s {@code tier}, kept in {@code agent.db} so a restart before
     * deskd speaks holds the last tier, not a default. Anything but an object (deskd had none to send) changes nothing.
     *
     * @return whether they changed
     */
    public boolean setTier(Object tier) {
        if (!(tier instanceof Map<?, ?>)) {
            return false;
        }
        TierCaps next = TierCaps.from(tier);
        boolean changed = !next.equals(caps);
        caps = next;
        pausedCache = null;
        pausedGeneration.incrementAndGet();
        if (changed) {
            keep(SETTING_TIER, new String(Json.bytes(tier), StandardCharsets.UTF_8));
        }
        return changed;
    }

    /**
     * The owner's age band from {@code desk.account.set}'s {@code band} ({@code adult}, {@code teen} or
     * {@code unknown}), kept like the tier. Timers and messages start no run while it isn't {@code adult}. Absent
     * changes nothing.
     *
     * @return whether it changed
     */
    public boolean setBand(Object band) {
        if (!(band instanceof String text)) {
            return false;
        }
        boolean next = "adult".equals(text);
        boolean changed = next != adult;
        adult = next;
        if (changed) {
            keep(SETTING_BAND, next ? "adult" : "other");
            timers.changed();
        }
        return changed;
    }

    /** Whether the owner's band is adult, as deskd last said; timers and messages start no run while it isn't. */
    public boolean adult() {
        return adult;
    }

    private void keep(String name, String value) {
        try {
            store.setSetting(name, value);
        } catch (SQLException e) {
            log.warn("the account's {} wasn't kept: {}", name, e.getClass().getSimpleName());
        }
    }

    /**
     * The agents over {@code agentCap} after the tier's cap fell (or a lower tier came): the newest, oldest kept, the
     * lead never counted out. They're paused, never deleted: {@code status: "paused"}, {@code statusDetail: "agent_cap"},
     * runs refused {@code agent_cap}.
     */
    public Set<String> pausedAgents() {
        Set<String> cached = pausedCache;
        if (cached != null) {
            return cached;
        }
        try {
            long seen = pausedGeneration.get();
            Set<String> computed = computePaused();
            if (pausedGeneration.get() == seen) {
                pausedCache = computed;
            }
            return computed;
        } catch (SQLException e) {
            log.warn("the paused agents couldn't be worked out: {}", e.getClass().getSimpleName());
            return Set.of();
        }
    }

    private Set<String> computePaused() throws SQLException {
        List<AgentRow> rows = new ArrayList<>(teamAgents());
        if (rows.size() <= caps.agentCap()) {
            return Set.of();
        }
        rows.removeIf(row -> row.id().equals(AgentStore.MANAGER));
        rows.sort(Comparator.comparingLong(AgentRow::createdAt).thenComparing(AgentRow::id));
        // The lead takes one place of the cap; the oldest of the rest take what's left.
        int room = Math.max(0, caps.agentCap() - 1);
        Set<String> paused = new HashSet<>();
        for (int i = room; i < rows.size(); i++) {
            paused.add(rows.get(i).id());
        }
        return paused;
    }

    public boolean paused(String agentId) {
        return !agentId.equals(AgentStore.MANAGER) && pausedAgents().contains(agentId);
    }

    /** At start, after the store opened: every agent's workspace, and the timers' missed fires. */
    public void restore() throws SQLException {
        String savedTier = store.setting(SETTING_TIER);
        if (savedTier != null) {
            try {
                caps = TierCaps.from(Json.parseObject(savedTier.getBytes(StandardCharsets.UTF_8)));
            } catch (JsonFormatException | RuntimeException e) {
                log.warn("the kept tier couldn't be read: {}", e.getClass().getSimpleName());
            }
        }
        adult = !"other".equals(store.setting(SETTING_BAND));
        for (AgentRow row : teamAgents()) {
            try {
                workspaces.create(row.id());
            } catch (WorkspaceException | RuntimeException e) {
                log.warn("a workspace couldn't be made: {}", e.getClass().getSimpleName());
            }
        }
        timers.restore();
        anyProposals = team.hasProposals();
        if (anyProposals) {
            // A yes that was applying when desk-agent stopped never settled: it's failed, as an error would be.
            for (String id : team.failApplying("internal")) {
                audit("system", "proposal.answer", "proposal:" + id, "failed:internal");
            }
        }
        try {
            team.pruneA2a(clock.millis() - A2A_KEEP.toMillis());
        } catch (SQLException e) {
            log.warn("the agent-message log wasn't pruned: {}", e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- RPCs

    public static boolean handles(String method) {
        return switch (method) {
            case "agent.get", "agent.create", "agent.delete", "agent.links.set", "agent.caps", "agent.workspace.get",
                    "agent.workspace.read", "agent.workspace.delete", "agent.workspace.share", "agent.timer.list",
                    "agent.timer.set", "agent.timer.delete", "agent.icon.upload", "agent.icon.get", "agent.a2a.list",
                    "agent.proposal.answer" -> true;
            default -> false;
        };
    }

    /** One of {@link #handles}' methods. {@code agent.get} and {@code agent.create} answer an agent's extras only. */
    public Map<String, Object> call(String method, Map<String, Object> p) throws RpcError, SQLException {
        return switch (method) {
            case "agent.create" -> Map.of("agentId", create(p, "user"));
            case "agent.delete" -> delete(agentId(p), "user");
            case "agent.links.set" -> {
                setLinks(agentId(p), p, "user");
                yield Map.of();
            }
            case "agent.caps" -> Map.of("caps", capsView());
            case "agent.workspace.get" -> workspaceGet(p);
            case "agent.workspace.read" -> workspaceRead(p);
            case "agent.workspace.delete" -> workspaceDelete(p);
            case "agent.workspace.share" -> {
                share(p);
                yield Map.of();
            }
            case "agent.timer.list" -> timers.list(agentId(p));
            case "agent.timer.set" -> Map.of("timer", timers.set(agentId(p), object(p, "timer"), "user"));
            case "agent.timer.delete" -> timers.delete(agentId(p), string(p, "timerId"), "user");
            case "agent.icon.upload" -> {
                iconUpload(p);
                yield Map.of();
            }
            case "agent.icon.get" -> iconGet(p);
            case "agent.a2a.list" -> a2aList(p);
            case "agent.proposal.answer" -> Map.of("proposal", answer(p));
            default -> throw RpcError.of("not_found", "detail", "method");
        };
    }

    public Map<String, Object> capsView() throws SQLException {
        Map<String, Object> view = caps.toMap(teamAgents().size());
        view.put("workspaceTotalMb", workspaceTotalBytes() / MIB);
        view.put("workspaceBudgetMb", workspaceBudgetBytes() / MIB);
        return view;
    }

    // ---------------------------------------------------------------- the agent view

    /** A view's task 49 fields: all of them, or {@code agent.state}'s smaller set. */
    public void decorate(Map<String, Object> view, Extras extras, List<Link> outgoing, int timerCount, boolean full) {
        boolean lead = AgentStore.MANAGER.equals(view.get("id"));
        view.put("lead", lead);
        Map<String, Object> look = new LinkedHashMap<>();
        look.put("icon", extras == null ? "spark" : extras.icon());
        look.put("tone", extras == null ? "graphite" : extras.tone());
        look.put("png", extras == null ? null : extras.pngVersion());
        view.put("look", look);
        view.put("solo", extras == null || extras.solo());
        List<Map<String, Object>> links = new ArrayList<>();
        for (Link link : outgoing) {
            Map<String, Object> l = new LinkedHashMap<>();
            l.put("to", link.to());
            if (full) {
                l.put("rules", link.rules());
            }
            links.add(l);
        }
        view.put("links", links);
        view.put("timers", timerCount);
        if (full) {
            view.put("purpose", extras == null ? "" : extras.purpose());
            Map<String, Object> workspace = new LinkedHashMap<>();
            String id = (String) view.get("id");
            workspace.put("quotaBytes", quotaBytes(extras));
            long used;
            try {
                used = workspaces.used(id);
            } catch (WorkspaceException | RuntimeException e) {
                used = 0;
            }
            workspace.put("usedBytes", used);
            workspace.put("sharedWith", extras == null ? List.of() : extras.sharedWith());
            view.put("workspace", workspace);
            view.put("incoming", incoming(id));
        }
    }

    /** The links into an agent, {@code [{from, rules}]}: who may message it, and the rules it answers under. */
    private List<Map<String, Object>> incoming(String agentId) {
        List<Map<String, Object>> incoming = new ArrayList<>();
        try {
            for (Link link : team.links()) {
                if (link.to().equals(agentId)) {
                    Map<String, Object> l = new LinkedHashMap<>();
                    l.put("from", link.from());
                    l.put("rules", link.rules());
                    incoming.add(l);
                }
            }
        } catch (SQLException e) {
            log.warn("an agent's incoming links weren't read: {}", e.getClass().getSimpleName());
        }
        return incoming;
    }

    /** Everything {@link #decorate} needs for every agent at once. */
    public record Snapshot(Map<String, Extras> extras, Map<String, List<Link>> links, Map<String, Integer> timers) {}

    public Snapshot snapshot() throws SQLException {
        Map<String, List<Link>> links = new HashMap<>();
        for (Link link : team.links()) {
            links.computeIfAbsent(link.from(), k -> new ArrayList<>()).add(link);
        }
        Map<String, Integer> counts = new HashMap<>();
        for (TimerRow timer : team.timers(null)) {
            counts.merge(timer.agentId(), 1, Integer::sum);
        }
        return new Snapshot(team.extras(), links, counts);
    }

    /** An agent's effective quota: what was stored at its create (else the tier's default), at most the tier's max. */
    long quotaBytes(Extras extras) {
        int mb = extras == null || extras.workspaceMb() == null ? caps.workspaceMb() : extras.workspaceMb();
        return Math.min(mb, caps.workspaceMaxMb()) * MIB;
    }

    /** The share of the volume that every agent's quota together may take. */
    long workspaceBudgetBytes() {
        return workspaces.volumeBytes() / 100 * WORKSPACE_BUDGET_PCT;
    }

    /** Every team agent's effective quota, summed. */
    long workspaceTotalBytes() throws SQLException {
        Map<String, Extras> all = team.extras();
        long sum = 0;
        for (AgentRow row : teamAgents()) {
            sum += quotaBytes(all.get(row.id()));
        }
        return sum;
    }

    /**
     * Refuses a quota (in bytes) for {@code agentId} (null for a new agent) that would take the agents' quotas past the
     * budget. Call with {@link #agentsLock} held.
     */
    private void checkBudget(String agentId, long newQuota) throws RpcError, SQLException {
        long others = workspaceTotalBytes();
        if (agentId != null) {
            others -= quotaBytes(team.extras(agentId));
        }
        if (others + newQuota > workspaceBudgetBytes()) {
            throw RpcError.of("precondition_failed", "reason", "disk_budget");
        }
    }

    // ---------------------------------------------------------------- create, change, delete

    /** {@code agent.create} by hand. @return the new agent's id */
    String create(Map<String, Object> p, String actor) throws RpcError, SQLException {
        return create(p, false, actor);
    }

    /**
     * {@code agent.create}, by hand or, with {@code withLinksAndTimers}, from the lead's confirmed proposal, which may
     * also carry links and timers. Everything is checked before anything is written (AI M1): the name, the look, the
     * key, the cap, every link and its target, and every timer, a one-shot whose time has passed included. The agent,
     * its links and its solo flag are one transaction. Its workspace, runtime, binding and timers follow, and if one of
     * those fails the agent is taken out again, so a create is whole or not there.
     *
     * @return the new agent's id
     */
    private String create(Map<String, Object> p, boolean withLinksAndTimers, String actor)
            throws RpcError, SQLException {
        String name = name(p, true);
        String purpose = purpose(p);
        String icon = look(p, "icon", "spark");
        String picked = p.get("tone") == null ? null : look(p, "tone", null);
        boolean solo = !p.containsKey("solo") || bool(p, "solo");
        Integer workspaceMb = workspaceMb(p);
        String keyId = p.get("keyId") == null ? null : string(p, "keyId");
        String model = p.get("model") == null ? null : string(p, "model");
        if ((keyId == null) != (model == null)) {
            throw RpcError.badRequest(keyId == null ? "keyId" : "model");
        }
        if (model != null && !MODEL.matcher(model).matches()) {
            throw RpcError.badRequest("model");
        }
        if (keyId != null && store.key(keyId) == null) {
            throw RpcError.notFound("key");
        }
        String id = newAgentId();
        List<Link> links = withLinksAndTimers && p.get("links") != null ? links(id, p.get("links")) : List.of();
        List<Map<String, Object>> newTimers = withLinksAndTimers ? newTimers(p.get("timers")) : List.of();
        agentsLock.lock();
        try {
            List<AgentRow> agents = teamAgents();
            if (agents.size() >= caps.agentCap()) {
                throw RpcError.of("precondition_failed", "reason", "agent_cap");
            }
            requireUniqueName(name, null, agents);
            for (Link link : links) {
                if (store.agent(link.to()) == null || Caller.isMemberAgent(link.to())) {
                    throw RpcError.badRequest("links");
                }
            }
            String tone = picked != null ? picked : defaultTone();
            if (workspaceMb == null) {
                // Stored now, so a later change of the tier's default never shrinks this agent.
                long left = (workspaceBudgetBytes() - workspaceTotalBytes()) / MIB;
                if (left < WORKSPACE_MIN_MB) {
                    throw RpcError.of("precondition_failed", "reason", "disk_budget");
                }
                workspaceMb = (int) Math.min(Math.min(caps.workspaceMb(), caps.workspaceMaxMb()), left);
            } else {
                checkBudget(null, workspaceMb * MIB);
            }
            team.createAgent(id, name, clock.millis(),
                    new Extras(id, purpose, icon, tone, null, solo, workspaceMb, List.of()), links);
            pausedCache = null;
            pausedGeneration.incrementAndGet();
        } finally {
            agentsLock.unlock();
        }
        try {
            try {
                workspaces.create(id);
            } catch (WorkspaceException | RuntimeException e) {
                log.warn("a new agent's workspace couldn't be made: {}", e.getClass().getSimpleName());
            }
            host.added(id);
            if (keyId != null) {
                host.bind(id, keyId, model);
            }
            for (Map<String, Object> timer : newTimers) {
                timers.set(id, timer, actor);
            }
        } catch (RpcError | SQLException | RuntimeException e) {
            undoCreate(id, e);
            throw e;
        }
        audit(actor, "agent.create", "agent:" + id, "ok");
        host.publishState();
        return id;
    }

    /**
     * A create's timers, checked as {@link Timers#set} will take them, before the agent exists: no timer's {@code id}
     * (a create's timers are all new), the agent's timer cap, and a one-shot's time still ahead. The lead's proposal
     * checks them the same way.
     */
    List<Map<String, Object>> newTimers(Object value) throws RpcError, SQLException {
        if (value == null) {
            return List.of();
        }
        if (!(value instanceof List<?> list)) {
            throw RpcError.badRequest("timers");
        }
        if (list.size() > caps.timersPerAgent()) {
            throw RpcError.of("precondition_failed", "reason", "timer_cap");
        }
        long now = clock.millis();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> m) || m.get("id") != null) {
                throw RpcError.badRequest("timers");
            }
            Map<String, Object> timer = timers.normalize(cast(m), null);
            if (timer.get("at") instanceof Number at
                    && (at.longValue() <= now || at.longValue() > now + Timers.MAX_AHEAD.toMillis())) {
                throw RpcError.badRequest("at");
            }
            out.add(timer);
        }
        return out;
    }

    /** Takes a create back after a later step failed. If that fails too, what exists is reported as such. */
    private void undoCreate(String id, Exception cause) {
        try {
            agentsLock.lock();
            try {
                team.deleteAgent(id);
            } finally {
                agentsLock.unlock();
            }
        } catch (SQLException | RuntimeException e) {
            log.warn("a create that failed partway stays: {}", e.getClass().getSimpleName());
            audit("system", "agent.create", "agent:" + id, "partly:" + failedDetail(cause));
            throw new PartlyApplied(failedDetail(cause), Map.of("agentId", id));
        }
        host.removed(id);
        try {
            workspaces.deleteAll(id);
        } catch (WorkspaceException | RuntimeException e) {
            log.warn("a workspace of a create taken back stays: {}", e.getClass().getSimpleName());
        }
        timers.changed();
        audit("system", "agent.create", "agent:" + id, "undone:" + failedDetail(cause));
        host.publishState();
    }

    /**
     * A change that could neither finish nor be taken back: the proposal answers {@code applied_partly}, with what
     * exists in its {@code result}.
     */
    static final class PartlyApplied extends RuntimeException {
        private final String detail;
        private final Map<String, Object> result;

        PartlyApplied(String detail, Map<String, Object> result) {
            super(detail, null, false, false);
            this.detail = detail;
            this.result = result;
        }
    }

    /** What an {@code agent.update} changes of task 49's fields, all checked, nothing written yet. */
    private record Change(String purpose, String icon, String tone, Boolean solo, Integer workspaceMb,
            boolean clearQuota) {
        boolean none() {
            return purpose == null && icon == null && tone == null && solo == null && workspaceMb == null
                    && !clearQuota;
        }
    }

    private Change change(String agentId, Map<String, Object> p) throws RpcError {
        String purpose = p.containsKey("purpose") ? purpose(p) : null;
        String icon = null;
        if (p.containsKey("icon")) {
            icon = look(p, "icon", null);
            if ("png".equals(icon)) {
                throw RpcError.badRequest("icon");
            }
        }
        String tone = p.containsKey("tone") ? look(p, "tone", null) : null;
        Boolean solo = p.containsKey("solo") ? bool(p, "solo") : null;
        boolean clearQuota = p.containsKey("workspaceMb") && p.get("workspaceMb") == null;
        Integer workspaceMb = p.get("workspaceMb") == null ? null : workspaceMb(p);
        if (workspaceMb != null) {
            long used;
            try {
                used = workspaces.used(agentId);
            } catch (WorkspaceException e) {
                used = 0;
            }
            if (used > workspaceMb * MIB) {
                throw RpcError.of("precondition_failed", "reason", "workspace_full");
            }
        }
        return new Change(purpose, icon, tone, solo, workspaceMb, clearQuota);
    }

    /** Writes a change, and a new name if one is given, in one transaction. */
    private void write(String agentId, Extras extras, Change change, String name) throws RpcError, SQLException {
        if (change.none() && name == null) {
            return;
        }
        agentsLock.lock();
        try {
            if (change.workspaceMb() != null || change.clearQuota()) {
                long next = (change.workspaceMb() != null ? Math.min(change.workspaceMb(), caps.workspaceMaxMb())
                        : Math.min(caps.workspaceMb(), caps.workspaceMaxMb())) * MIB;
                if (next > quotaBytes(extras)) {
                    checkBudget(agentId, next);
                }
            }
            team.changeAgent(agentId, name, change.purpose(), change.icon(), change.tone(), change.solo(),
                    change.workspaceMb(), change.clearQuota());
        } finally {
            agentsLock.unlock();
        }
        if (change.icon() != null && extras.pngVersion() != null) {
            deleteIcon(agentId);
        }
    }

    /**
     * {@code agent.update}'s task 49 fields, all checked before any is written, and a new name checked against the
     * desk's others ({@code AgentService} writes the name).
     */
    public void update(String agentId, Map<String, Object> p) throws RpcError, SQLException {
        Extras extras = Caller.isMemberAgent(agentId) ? null : team.extras(agentId);
        if (extras == null) {
            throw RpcError.notFound("agent");
        }
        if (p.containsKey("name")) {
            requireUniqueName(name(p, true), agentId, teamAgents());
        }
        write(agentId, extras, change(agentId, p), null);
    }

    /**
     * Applies a confirmed {@code agent.update} proposal: the same checks as {@link #update} and the key's, all before
     * anything changes (AI M1). The binding goes first, so a refused bind changes nothing; the name and the rest are
     * then one transaction, and if that fails the binding goes back.
     */
    void updateFromProposal(Map<String, Object> p, String actor) throws RpcError, SQLException {
        String agentId = agentId(p);
        AgentRow row = store.agent(agentId);
        Extras extras = team.extras(agentId);
        if (row == null || extras == null) {
            throw RpcError.notFound("agent");
        }
        String name = p.containsKey("name") ? name(p, true) : null;
        if (name != null) {
            requireUniqueName(name, agentId, teamAgents());
        }
        Change change = change(agentId, p);
        String keyId = p.get("keyId") == null ? null : string(p, "keyId");
        String model = p.get("model") == null ? null : string(p, "model");
        if (model != null && !MODEL.matcher(model).matches()) {
            throw RpcError.badRequest("model");
        }
        String key = keyId != null ? keyId : row.keyId();
        boolean rebind = model != null && !(key != null && key.equals(row.keyId()) && model.equals(row.model()));
        if (rebind) {
            if (key == null) {
                throw RpcError.of("precondition_failed", "reason", "no_key");
            }
            if (store.key(key) == null) {
                throw RpcError.notFound("key");
            }
            host.bind(agentId, key, model);
        }
        try {
            agentsLock.lock();
            try {
                if (name != null) {
                    requireUniqueName(name, agentId, teamAgents());
                }
                write(agentId, extras, change, name);
            } finally {
                agentsLock.unlock();
            }
        } catch (RpcError | SQLException | RuntimeException e) {
            if (rebind) {
                unbind(row, e);
            }
            throw e;
        }
        audit(actor, "agent.update", "agent:" + agentId, "ok");
        host.publishState();
    }

    /** The binding back as it was, after the rest of a change failed. */
    private void unbind(AgentRow before, Exception cause) {
        try {
            if (before.keyId() == null || before.model() == null || store.key(before.keyId()) == null) {
                throw new IllegalStateException("no binding to go back to");
            }
            host.bind(before.id(), before.keyId(), before.model());
        } catch (RpcError | SQLException | RuntimeException e) {
            audit("system", "agent.update", "agent:" + before.id(), "partly:" + failedDetail(cause));
            throw new PartlyApplied(failedDetail(cause), Map.of("agentId", before.id(), "changed", List.of("keyId",
                    "model")));
        }
    }

    Map<String, Object> delete(String agentId, String actor) throws RpcError, SQLException {
        AgentRow row = store.agent(agentId);
        if (row == null) {
            throw RpcError.notFound("agent");
        }
        if (!"staff".equals(row.role())) {
            throw RpcError.badRequest("lead");
        }
        deleting.add(agentId);
        try {
            if (host.running(agentId) || starting.containsKey(agentId)) {
                throw RpcError.of("conflict", "reason", "busy");
            }
            agentsLock.lock();
            try {
                team.deleteAgent(agentId);
                pausedCache = null;
                pausedGeneration.incrementAndGet();
            } finally {
                agentsLock.unlock();
            }
        } finally {
            deleting.remove(agentId);
        }
        host.removed(agentId);
        try {
            workspaces.deleteAll(agentId);
        } catch (WorkspaceException | RuntimeException e) {
            log.warn("a deleted agent's workspace stays: {}", e.getClass().getSimpleName());
        }
        deleteIcon(agentId);
        timers.changed();
        audit(actor, "agent.delete", "agent:" + agentId, "ok");
        host.publishState();
        return Map.of();
    }

    // ---------------------------------------------------------------- links

    /** {@code agent.links.set}: replaces the agent's outgoing links, and its solo flag. */
    void setLinks(String agentId, Map<String, Object> p, String actor) throws RpcError, SQLException {
        if (store.agent(agentId) == null) {
            throw RpcError.notFound("agent");
        }
        boolean solo = bool(p, "solo");
        List<Link> links = links(agentId, p.get("links"));
        agentsLock.lock();
        try {
            for (Link link : links) {
                if (store.agent(link.to()) == null || Caller.isMemberAgent(link.to())) {
                    throw RpcError.badRequest("links");
                }
            }
            team.setLinks(agentId, solo, links);
        } finally {
            agentsLock.unlock();
        }
        audit(actor, "links.set", "agent:" + agentId, (solo ? "solo:" : "open:") + links.size());
        host.publishState();
    }

    private List<Link> links(String from, Object value) throws RpcError {
        if (!(value instanceof List<?> list) || list.size() > 99) {
            throw RpcError.badRequest("links");
        }
        List<Link> links = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        long now = clock.millis();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> m) || !(m.get("to") instanceof String to) || !(m.get("rules") instanceof String rules)) {
                throw RpcError.badRequest("links");
            }
            String text = rules.strip();
            TextChecks.refuseHidden(text, "links");
            if (to.equals(from) || !AGENT_ID.matcher(to).matches() || !seen.add(to) || text.isEmpty()
                    || text.codePointCount(0, text.length()) > TierCaps.RULES_MAX) {
                throw RpcError.badRequest("links");
            }
            links.add(new Link(from, to, text, now));
        }
        return links;
    }

    // ---------------------------------------------------------------- workspaces

    private Map<String, Object> workspaceGet(Map<String, Object> p) throws RpcError, SQLException {
        String agentId = agentId(p);
        Extras extras = existing(agentId);
        String path = p.get("path") == null ? "" : string(p, "path");
        try {
            List<Map<String, Object>> entries = new ArrayList<>();
            Workspaces.Listing listing = workspaces.listing(agentId, path);
            for (Workspaces.Entry entry : listing.entries()) {
                entries.add(entryView(entry));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("quotaBytes", quotaBytes(extras));
            out.put("usedBytes", workspaces.used(agentId));
            out.put("sharedWith", extras.sharedWith());
            out.put("entries", entries);
            if (listing.more()) {
                out.put("more", true);
            }
            return out;
        } catch (WorkspaceException e) {
            throw workspaceError(e);
        }
    }

    static Map<String, Object> entryView(Workspaces.Entry entry) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("path", entry.path());
        e.put("dir", entry.dir());
        e.put("bytes", entry.bytes());
        e.put("modifiedAt", entry.modifiedAt().toEpochMilli());
        return e;
    }

    private Map<String, Object> workspaceRead(Map<String, Object> p) throws RpcError, SQLException {
        String agentId = agentId(p);
        existing(agentId);
        try {
            Workspaces.Page page = workspaces.page(agentId, string(p, "path"), wholeNumber(p, "offset", 0),
                    (int) Math.min(wholeNumber(p, "length", Workspaces.MAX_PAGE_CHARS), Workspaces.MAX_PAGE_CHARS));
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("path", page.path());
            out.put("text", page.text());
            out.put("bytes", page.bytes());
            out.put("truncated", page.truncated());
            out.put("offset", page.offset());
            out.put("remaining", page.remaining());
            return out;
        } catch (WorkspaceException e) {
            throw workspaceError(e);
        }
    }

    private Map<String, Object> workspaceDelete(Map<String, Object> p) throws RpcError, SQLException {
        String agentId = agentId(p);
        existing(agentId);
        try {
            long used = workspaces.remove(agentId, string(p, "path"));
            audit("user", "workspace.delete", "agent:" + agentId, "ok");
            host.publishState();
            return Map.of("usedBytes", used);
        } catch (WorkspaceException e) {
            throw workspaceError(e);
        }
    }

    private void share(Map<String, Object> p) throws RpcError, SQLException {
        String agentId = agentId(p);
        existing(agentId);
        if (!(p.get("with") instanceof List<?> list) || list.size() > 99) {
            throw RpcError.badRequest("with");
        }
        Set<String> with = new LinkedHashSet<>();
        for (Object item : list) {
            if (!(item instanceof String id) || id.equals(agentId) || store.agent(id) == null
                    || Caller.isMemberAgent(id)) {
                throw RpcError.badRequest("with");
            }
            with.add(id);
        }
        team.setSharedWith(agentId, List.copyOf(with));
        audit("user", "workspace.share", "agent:" + agentId, "shared:" + with.size());
        host.publishState();
    }

    static RpcError workspaceError(WorkspaceException e) {
        return switch (e.reason()) {
            case NOT_FOUND -> RpcError.notFound("path");
            case PATH -> RpcError.badRequest("path");
            case QUOTA -> RpcError.of("precondition_failed", "reason", "workspace_full");
            case DISK_FULL -> RpcError.of("precondition_failed", "reason", "disk_low");
            case TOO_MANY_FOLDERS -> RpcError.of("precondition_failed", "reason", "too_many_folders");
            default -> RpcError.of("bad_request", "detail", "path", "reason", e.reason().wireName());
        };
    }

    // ---------------------------------------------------------------- icons

    private void iconUpload(Map<String, Object> p) throws RpcError, SQLException {
        String agentId = agentId(p);
        Extras extras = existing(agentId);
        byte[] png;
        try {
            String text = string(p, "png");
            if (text.length() > (TierCaps.ICON_MAX_BYTES / 3 + 2) * 4) {
                throw RpcError.of("bad_request", "detail", "png", "reason", "too_large");
            }
            png = Base64.getDecoder().decode(text);
        } catch (IllegalArgumentException e) {
            throw RpcError.of("bad_request", "detail", "png", "reason", "not_png");
        }
        byte[] mask;
        try {
            mask = PngMark.mask(png);
        } catch (IconException e) {
            audit("user", "icon.upload", "agent:" + agentId, "refused:" + e.reason().wireName());
            throw RpcError.of("bad_request", "detail", "png", "reason", e.reason().wireName());
        }
        try {
            Files.createDirectories(icons);
            Path temporary = icons.resolve(agentId + ".png.tmp");
            Files.write(temporary, mask);
            try {
                Files.move(temporary, icons.resolve(agentId + ".png"), StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temporary, icons.resolve(agentId + ".png"), StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            throw RpcError.of("unavailable", "reason", "storage");
        }
        int version = extras.pngVersion() == null ? 1 : extras.pngVersion() + 1;
        team.setPng(agentId, version, "png");
        audit("user", "icon.upload", "agent:" + agentId, "ok");
        host.publishState();
    }

    private Map<String, Object> iconGet(Map<String, Object> p) throws RpcError, SQLException {
        String agentId = agentId(p);
        Extras extras = existing(agentId);
        if (extras.pngVersion() == null) {
            throw RpcError.notFound("icon");
        }
        try {
            byte[] png = Files.readAllBytes(icons.resolve(agentId + ".png"));
            return Map.of("png", Base64.getEncoder().encodeToString(png), "version", extras.pngVersion());
        } catch (NoSuchFileException e) {
            throw RpcError.notFound("icon");
        } catch (IOException e) {
            throw RpcError.of("unavailable", "reason", "storage");
        }
    }

    private void deleteIcon(String agentId) {
        try {
            Files.deleteIfExists(icons.resolve(agentId + ".png"));
        } catch (IOException | RuntimeException e) {
            log.warn("an icon file stays: {}", e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- the agent-message log

    /** When the log was last pruned by {@link #pruneA2aDaily}; start prunes it too ({@link #restore}). */
    private volatile long a2aPrunedAt;

    /** As the log is written to, its rows past {@link #A2A_KEEP} go, at most once a day, not only at start. */
    void pruneA2aDaily() {
        long now = clock.millis();
        if (now - a2aPrunedAt < Duration.ofDays(1).toMillis()) {
            return;
        }
        a2aPrunedAt = now;
        try {
            team.pruneA2a(now - A2A_KEEP.toMillis());
        } catch (SQLException e) {
            log.warn("the agent-message log wasn't pruned: {}", e.getClass().getSimpleName());
        }
    }

    private Map<String, Object> a2aList(Map<String, Object> p) throws RpcError, SQLException {
        String agentId = p.get("agentId") == null ? null : agentId(p);
        Long before = p.get("before") instanceof Number n ? n.longValue() : null;
        List<TeamStore.A2aRow> rows = team.a2a(agentId, before, A2A_PAGE + 1);
        boolean older = rows.size() > A2A_PAGE;
        List<Map<String, Object>> messages = new ArrayList<>();
        int bytes = 0;
        for (TeamStore.A2aRow row : rows.subList(0, Math.min(rows.size(), A2A_PAGE))) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", row.id());
            m.put("from", row.from());
            m.put("to", row.to());
            m.put("chainId", row.chainId());
            m.put("depth", row.depth());
            m.put("text", row.text());
            m.put("rules", row.rules());
            m.put("at", row.at());
            m.put("state", row.state());
            m.put("reason", row.reason());
            m.put("reply", row.reply());
            m.put("costMicroUsd", row.costMicroUsd());
            bytes += row.text().length() + row.rules().length() + (row.reply() == null ? 0 : row.reply().length());
            if (bytes > 900_000) {
                older = true;
                break;
            }
            messages.add(m);
        }
        return Map.of("messages", messages, "older", older);
    }

    // ---------------------------------------------------------------- proposals

    /**
     * Records a proposal the lead made in a run, with what started that run (AI M2, Security T49M-3): the lead keeps
     * its tools in a run another agent's message or a timer started, and its card says so. At most
     * {@link #PENDING_MAX} wait at once and {@link #RUN_PROPOSALS_MAX} come from one run ({@code precondition_failed},
     * {@code reason: "proposal_cap"}). @return the row
     */
    ProposalRow propose(String runId, String action, Map<String, Object> payload, String summary)
            throws RpcError, SQLException {
        RunInfo run = host.run(runId);
        if (run == null) {
            throw new SQLException("the run isn't recorded");
        }
        long now = clock.millis();
        if (team.proposalsOfRun(runId) >= RUN_PROPOSALS_MAX || team.pendingProposals(now) >= PENDING_MAX) {
            throw RpcError.of("precondition_failed", "reason", "proposal_cap");
        }
        String sha = Canonical.sha256(payload);
        ProposalRow row = new ProposalRow(newId("pr"), run.agentId(), run.replyId(), action, summary,
                Canonical.json(payload), sha, "pending", null, null, now, now + PROPOSAL_LIFE.toMillis(), null, runId,
                new String(Json.bytes(originOf(run)), StandardCharsets.UTF_8), beforeJson(action, payload));
        anyProposals = true;
        team.addProposal(row);
        audit("agent:" + run.agentId(), "proposal.make", "proposal:" + row.id() + " " + action, "pending");
        return row;
    }

    /**
     * The current state of what a proposal changes, read when it's made, for the card to show beside the change (AI
     * M17, Design M4). Not part of the hash. {@code agent.update}: the current value of each field the payload has, and
     * {@code usedBytes} with {@code workspaceMb}; {@code agent.links}: {@code {solo, links}}; {@code timer.set} with an
     * id and {@code timer.delete}: {@code {timer}}, the timer's full view; {@code agent.delete}:
     * {@code {name, look, usedBytes, timers, links, incoming}}; null for a create. @return it as JSON, or null
     */
    private String beforeJson(String action, Map<String, Object> payload) throws SQLException {
        Map<String, Object> before = before(action, payload);
        return before == null ? null : new String(Json.bytes(before), StandardCharsets.UTF_8);
    }

    private Map<String, Object> before(String action, Map<String, Object> payload) throws SQLException {
        if (!(payload.get("agentId") instanceof String agentId)) {
            return null;
        }
        AgentRow row = store.agent(agentId);
        Extras extras = team.extras(agentId);
        if (row == null || extras == null) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        switch (action) {
            case "agent.update" -> {
                for (String field : payload.keySet()) {
                    switch (field) {
                        case "name" -> out.put("name", row.name());
                        case "purpose" -> out.put("purpose", extras.purpose());
                        case "icon" -> out.put("icon", extras.icon());
                        case "tone" -> out.put("tone", extras.tone());
                        case "solo" -> out.put("solo", extras.solo());
                        case "keyId" -> out.put("keyId", row.keyId());
                        case "model" -> out.put("model", row.model());
                        case "workspaceMb" -> {
                            out.put("workspaceMb", quotaBytes(extras) / MIB);
                            out.put("usedBytes", usedBytes(agentId));
                        }
                        default -> {
                            // agentId names the agent; it's no change
                        }
                    }
                }
            }
            case "agent.links" -> {
                out.put("solo", extras.solo());
                out.put("links", linkViews(agentId, true));
            }
            case "timer.set", "timer.delete" -> {
                Object timerId = action.equals("timer.delete") ? payload.get("timerId")
                        : payload.get("timer") instanceof Map<?, ?> timer ? timer.get("id") : null;
                if (!(timerId instanceof String id)) {
                    return null;
                }
                TimerRow timer = team.timer(id);
                out.put("timer", timer == null || !timer.agentId().equals(agentId) ? null : timers.view(timer));
            }
            case "agent.delete" -> {
                out.put("name", row.name());
                Map<String, Object> look = new LinkedHashMap<>();
                look.put("icon", extras.icon());
                look.put("tone", extras.tone());
                look.put("png", extras.pngVersion());
                out.put("look", look);
                out.put("usedBytes", usedBytes(agentId));
                List<Map<String, Object>> timerViews = new ArrayList<>();
                for (TimerRow timer : team.timers(agentId)) {
                    timerViews.add(timers.view(timer));
                }
                out.put("timers", timerViews);
                out.put("links", linkViews(agentId, true));
                out.put("incoming", linkViews(agentId, false));
            }
            default -> {
                return null;
            }
        }
        return out;
    }

    /** An agent's links out, as {@code [{to, rules}]}, or into it, as {@code [{from, rules}]}. */
    private List<Map<String, Object>> linkViews(String agentId, boolean outgoing) throws SQLException {
        List<Map<String, Object>> views = new ArrayList<>();
        for (Link link : team.links()) {
            if ((outgoing ? link.from() : link.to()).equals(agentId)) {
                Map<String, Object> view = new LinkedHashMap<>();
                view.put(outgoing ? "to" : "from", outgoing ? link.to() : link.from());
                view.put("rules", link.rules());
                views.add(view);
            }
        }
        return views;
    }

    private long usedBytes(String agentId) {
        try {
            return workspaces.used(agentId);
        } catch (WorkspaceException | RuntimeException e) {
            return 0;
        }
    }

    /**
     * What started a run, as a proposal's {@code origin} shows it: {@code {"kind":"member"}},
     * {@code {"kind":"agent","agentId","name"}} (the sender, named as it was then) or
     * {@code {"kind":"timer","agentId","timerId","label"}}.
     */
    private Map<String, Object> originOf(RunInfo run) throws SQLException {
        Map<String, Object> origin = run.origin();
        Map<String, Object> out = new LinkedHashMap<>();
        String sender = origin != null && origin.get("agentId") instanceof String from ? from : null;
        if (origin == null && run.chain() != null && run.chain().depth() > 0 && run.chain().agents().size() > 1) {
            // A message's run that came without its origin is still an agent's.
            sender = run.chain().agents().get(run.chain().agents().size() - 2);
        }
        if (origin != null && "timer".equals(origin.get("kind"))) {
            out.put("kind", "timer");
            out.put("agentId", run.agentId());
            out.put("timerId", origin.get("timerId"));
            out.put("label", origin.get("label"));
        } else if (origin != null || sender != null) {
            out.put("kind", "agent");
            out.put("agentId", sender);
            AgentRow row = sender == null ? null : store.agent(sender);
            out.put("name", row == null ? null : row.name());
        } else {
            out.put("kind", "member");
        }
        return out;
    }

    /**
     * {@code agent.proposal.answer}: the member's yes or no, which must echo the card's hash. A yes settles the
     * proposal whatever happens while it applies (CC-L4): {@code applied}, {@code failed} with a {@code detail}, or
     * {@code applied_partly} when a change could neither finish nor be taken back, each with an audit row.
     */
    private Map<String, Object> answer(Map<String, Object> p) throws RpcError, SQLException {
        String id = string(p, "proposalId");
        boolean accept = bool(p, "accept");
        String sha = string(p, "sha256");
        ProposalRow row = team.proposal(id);
        if (row == null) {
            throw RpcError.notFound("proposal");
        }
        if (!row.sha256().equalsIgnoreCase(sha)) {
            throw RpcError.badRequest("sha256");
        }
        long now = clock.millis();
        if ("expired".equals(row.state())) {
            throw RpcError.of("conflict", "reason", "expired");
        }
        if (!"pending".equals(row.state())) {
            throw RpcError.of("conflict", "reason", "answered");
        }
        if (now > row.expiresAt()) {
            team.answerProposal(id, "expired", null, null, now);
            host.republish(row.agentId(), row.messageId());
            throw RpcError.of("conflict", "reason", "expired");
        }
        if (!accept) {
            if (!team.answerProposal(id, "declined", null, null, now)) {
                throw RpcError.of("conflict", "reason", "answered");
            }
            audit("user", "proposal.answer", "proposal:" + id, "declined");
        } else {
            if (!team.answerProposal(id, "applying", null, null, now)) {
                throw RpcError.of("conflict", "reason", "answered");
            }
            String state = "failed";
            String detail = "internal";
            Map<String, Object> result = null;
            try {
                Map<String, Object> payload = Json.parseObject(row.payload().getBytes(StandardCharsets.UTF_8));
                result = apply(row.action(), payload);
                state = "applied";
                detail = null;
            } catch (PartlyApplied e) {
                state = "applied_partly";
                detail = e.detail;
                result = e.result;
            } catch (RpcError | SQLException e) {
                detail = failedDetail(e);
            } catch (JsonFormatException e) {
                detail = "payload";
            } catch (RuntimeException e) {
                log.warn("a proposal failed as it applied: {}", e.getClass().getSimpleName());
            } finally {
                try {
                    team.settleProposal(id, state, detail, result == null ? null
                            : new String(Json.bytes(result), StandardCharsets.UTF_8));
                } catch (SQLException e) {
                    log.warn("a proposal's outcome wasn't written: {}", e.getClass().getSimpleName());
                }
                audit("user", "proposal.answer", "proposal:" + id, state.equals("applied") ? "applied"
                        : (state.equals("failed") ? "failed:" : "partly:") + word(detail));
            }
        }
        host.republish(row.agentId(), row.messageId());
        return proposalView(team.proposal(id));
    }

    /** A failed change's {@code detail}: an agent that's gone, else the refusal's reason or field, else the kind. */
    static String failedDetail(Exception e) {
        if (e instanceof RpcError r) {
            Object reason = r.details().get("reason");
            Object field = r.details().get("detail");
            if ("not_found".equals(r.code()) && "agent".equals(field)) {
                return "not_found";
            }
            return reason != null ? reason.toString() : field != null ? field.toString() : r.code();
        }
        return e instanceof SQLException ? "storage" : "internal";
    }

    /**
     * Applies a confirmed proposal, as the member's own change would, every check before any write. An agent the
     * proposal is for that's gone fails it with {@code detail: "not_found"} (Design M1). @return its result, or null
     */
    private Map<String, Object> apply(String action, Map<String, Object> payload) throws RpcError, SQLException {
        if (payload.containsKey("agentId") && store.agent(agentId(payload)) == null) {
            throw RpcError.notFound("agent");
        }
        switch (action) {
            case "agent.create" -> {
                return Map.of("agentId", create(payload, true, "user"));
            }
            case "agent.update" -> updateFromProposal(payload, "user");
            case "agent.delete" -> delete(agentId(payload), "user");
            case "agent.links" -> setLinks(agentId(payload), payload, "user");
            case "timer.set" -> {
                Map<String, Object> timer = timers.set(agentId(payload), object(payload, "timer"), "user");
                return Map.of("timerId", timer.get("id"));
            }
            case "timer.delete" -> timers.delete(agentId(payload), string(payload, "timerId"), "user");
            default -> throw RpcError.badRequest("action");
        }
        return null;
    }

    /** A proposal as a reply carries it. Expired ones say so, though the row is answered only when touched. */
    public Map<String, Object> proposalView(ProposalRow row) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("id", row.id());
        p.put("action", row.action());
        p.put("summary", row.summary());
        Object payload;
        try {
            payload = Json.parseObject(row.payload().getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            payload = Map.of();
        }
        p.put("payload", payload);
        p.put("sha256", row.sha256());
        Map<String, Object> origin = row.origin() == null ? null : parseOrigin(row.origin());
        p.put("origin", origin == null ? Map.of("kind", "member") : origin);
        Object before = null;
        if (row.before() != null) {
            try {
                before = Json.parseObject(row.before().getBytes(StandardCharsets.UTF_8));
            } catch (JsonFormatException e) {
                before = null;
            }
        }
        p.put("before", before);
        String state = row.state();
        if ("pending".equals(state) && clock.millis() > row.expiresAt()) {
            state = "expired";
        }
        if ("applying".equals(state)) {
            state = "pending";
        }
        p.put("state", state);
        p.put("detail", row.detail());
        p.put("answeredAt", row.answeredAt());
        p.put("expiresAt", row.expiresAt());
        Object result = null;
        if (row.result() != null) {
            try {
                result = Json.parseObject(row.result().getBytes(StandardCharsets.UTF_8));
            } catch (JsonFormatException e) {
                result = null;
            }
        }
        p.put("result", result);
        return p;
    }

    /** The proposals of these messages, as their views carry them, by message id; empty if they can't be read. */
    public Map<String, List<Map<String, Object>>> proposalViews(Collection<MessageRow> rows) {
        List<String> ids = new ArrayList<>();
        for (MessageRow row : rows) {
            if ("assistant".equals(row.role())) {
                ids.add(row.id());
            }
        }
        Map<String, List<Map<String, Object>>> views = new HashMap<>();
        if (ids.isEmpty() || !anyProposals) {
            return views;
        }
        try {
            for (Map.Entry<String, List<ProposalRow>> entry : team.proposalsFor(ids).entrySet()) {
                List<Map<String, Object>> list = new ArrayList<>();
                for (ProposalRow row : entry.getValue()) {
                    list.add(proposalView(row));
                }
                views.put(entry.getKey(), list);
            }
        } catch (SQLException e) {
            log.warn("proposals weren't read: {}", e.getClass().getSimpleName());
        }
        return views;
    }

    // ---------------------------------------------------------------- runs

    /** What a run of this agent is told and may do. */
    public ManagerAgent.RunSetup setupFor(String agentId) throws SQLException {
        return tools.setupFor(agentId, null);
    }

    /**
     * What a run of this agent, started with this {@code origin} (null: the member's), is told and may do. A run that
     * answers another agent's message gets the pairing's rules in its system part and only its own workspace.
     */
    public ManagerAgent.RunSetup setupFor(String agentId, Map<String, Object> origin) throws SQLException {
        return tools.setupFor(agentId, origin);
    }

    /**
     * A stored thread as the model reads it: a message from another agent or a timer says so, as JSON, and a lead's
     * reply carries what became of its proposals. When the newest turn is another agent's message, the run answering it
     * sees only that pairing's turns: that agent's messages and the replies to them, never the thread with the member.
     */
    public List<com.minimalistalliance.desk.agent.provider.ChatMessage> context(List<MessageRow> rows)
            throws SQLException {
        rows = pairingOnly(rows);
        List<String> ids = new ArrayList<>();
        for (MessageRow row : rows) {
            if (row.role().equals("assistant")) {
                ids.add(row.id());
            }
        }
        Map<String, List<ProposalRow>> proposals = team.proposalsFor(ids);
        Map<String, String> names = new HashMap<>();
        for (AgentRow agent : store.agents()) {
            names.put(agent.id(), agent.name());
        }
        List<com.minimalistalliance.desk.agent.provider.ChatMessage> thread = new ArrayList<>();
        for (MessageRow row : rows) {
            if (row.role().equals("user")) {
                String said = TeamTools.incoming(row.text(), parseOrigin(row.origin()), names);
                // Files from an earlier turn are gone (ADR 0049): the history says they were there, nothing more.
                for (com.minimalistalliance.desk.agent.store.FileNote file
                        : com.minimalistalliance.desk.agent.store.FileNote.parse(store.filesOf(row.id()))) {
                    said = (said.isEmpty() ? "" : said + "\n") + file.line();
                }
                thread.add(com.minimalistalliance.desk.agent.provider.ChatMessage.user(said));
            } else if (("done".equals(row.state()) || "stopped".equals(row.state()) || "failed".equals(row.state()))
                    && (!row.text().isEmpty() || proposals.containsKey(row.id()))) {
                StringBuilder text = new StringBuilder(row.text());
                String actions = ManagerAgent.RunResult.actionsLine(chipsOf(row.tools()));
                if (!actions.isEmpty()) {
                    // SET-L6: a later turn knows what this run did, by tool names and outcomes, never content.
                    text.append(text.isEmpty() ? "" : "\n\n").append(actions);
                }
                for (ProposalRow p : proposals.getOrDefault(row.id(), List.of())) {
                    Map<String, Object> view = proposalView(p);
                    text.append(text.isEmpty() ? "" : "\n\n").append("[Proposal ").append(p.id()).append(" (")
                            .append(p.action()).append("): ").append(view.get("state"));
                    if (view.get("detail") != null) {
                        text.append(", ").append(view.get("detail"));
                    }
                    if (p.result() != null) {
                        text.append(", ").append(p.result());
                    }
                    text.append(']');
                }
                if (!text.isEmpty()) {
                    thread.add(com.minimalistalliance.desk.agent.provider.ChatMessage.assistant(text.toString()));
                }
            }
        }
        return thread;
    }

    /**
     * The rows of the pairing when the newest row is a message from another agent: each of that agent's messages and
     * the agent's reply that follows it. Otherwise all of them.
     */
    static List<MessageRow> pairingOnly(List<MessageRow> rows) {
        if (rows.isEmpty()) {
            return rows;
        }
        String sender = senderOf(rows.getLast());
        if (sender == null) {
            return rows;
        }
        List<MessageRow> kept = new ArrayList<>();
        boolean inPairing = false;
        for (MessageRow row : rows) {
            if (row.role().equals("user")) {
                inPairing = sender.equals(senderOf(row));
            }
            if (inPairing) {
                kept.add(row);
            }
        }
        return kept;
    }

    /** The agent whose message a user row is, or null for the member's or a timer's. */
    private static String senderOf(MessageRow row) {
        if (!row.role().equals("user")) {
            return null;
        }
        Map<String, Object> origin = parseOrigin(row.origin());
        return origin != null && "agent".equals(origin.get("kind")) && origin.get("agentId") instanceof String id
                ? id : null;
    }

    /** A run ended: what a timer's or a message's run cost goes on its timer, or its log row. */
    public void ended(Map<String, Object> origin, ManagerAgent.RunResult result) {
        if (result != null && result.state() == ManagerAgent.RunState.STOPPED) {
            expireStopped(result.runId());
        }
        if (origin == null || result == null) {
            return;
        }
        try {
            if ("timer".equals(origin.get("kind")) && origin.get("timerId") instanceof String timerId) {
                timers.ended(timerId, result);
            }
        } catch (SQLException | RuntimeException e) {
            log.warn("a timer's run wasn't recorded: {}", e.getClass().getSimpleName());
        }
    }

    /** A stopped run's proposals can't be confirmed any more (CC-L5): they expire, {@code detail: "stopped"}. */
    private void expireStopped(String runId) {
        if (!anyProposals || runId == null) {
            return;
        }
        try {
            team.expireRun(runId, "stopped", clock.millis());
        } catch (SQLException | RuntimeException e) {
            log.warn("a stopped run's proposals weren't expired: {}", e.getClass().getSimpleName());
        }
    }

    /**
     * {@code AgentService}'s side, with a run's start through the team (a timer's, a message's) marked while it starts,
     * so {@link #delete} can't race it.
     */
    private final class Guarded implements Host {
        private final Host inner;

        Guarded(Host inner) {
            this.inner = inner;
        }

        @Override
        public Started start(String agentId, String text, Map<String, Object> origin, Chain chain)
                throws RpcError, SQLException {
            starting.merge(agentId, 1, Integer::sum);
            try {
                if (deleting.contains(agentId)) {
                    throw RpcError.notFound("agent");
                }
                return inner.start(agentId, text, origin, chain);
            } finally {
                starting.computeIfPresent(agentId, (id, count) -> count == 1 ? null : count - 1);
            }
        }

        @Override
        public RunInfo run(String runId) {
            return inner.run(runId);
        }

        @Override
        public boolean running(String agentId) {
            return inner.running(agentId);
        }

        @Override
        public void added(String agentId) throws SQLException {
            inner.added(agentId);
        }

        @Override
        public void removed(String agentId) {
            inner.removed(agentId);
        }

        @Override
        public void bind(String agentId, String keyId, String model) throws RpcError, SQLException {
            inner.bind(agentId, keyId, model);
        }

        @Override
        public void republish(String agentId, String messageId) {
            inner.republish(agentId, messageId);
        }

        @Override
        public void publishState() {
            inner.publishState();
        }

        @Override
        public List<String> knownModels(String keyId) {
            return inner.knownModels(keyId);
        }
    }

    // ---------------------------------------------------------------- helpers

    /** A stored reply's tool chips, or none when there are none or they can't be read. */
    static List<Map<String, Object>> chipsOf(String json) {
        if (json == null || json.isEmpty()) {
            return List.of();
        }
        try {
            Object list = Json.parseObject(("{\"v\":" + json + "}").getBytes(StandardCharsets.UTF_8)).get("v");
            List<Map<String, Object>> chips = new ArrayList<>();
            if (list instanceof List<?> l) {
                for (Object item : l) {
                    if (item instanceof Map<?, ?> m) {
                        chips.add(cast(m));
                    }
                }
            }
            return chips;
        } catch (JsonFormatException e) {
            return List.of();
        }
    }

    static Map<String, Object> parseOrigin(String json) {
        if (json == null) {
            return null;
        }
        try {
            return Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            return null;
        }
    }

    private Extras existing(String agentId) throws RpcError, SQLException {
        Extras extras = team.extras(agentId);
        if (extras == null) {
            throw RpcError.notFound("agent");
        }
        return extras;
    }

    void audit(String actor, String action, String target, String decision) {
        try {
            audit.append(AuditLog.Entry.of(actor, action, target, word(decision)));
        } catch (SQLException | RuntimeException e) {
            log.warn("an audit row wasn't written: {} {}", action, e.getClass().getSimpleName());
        }
    }

    /** A decision word the audit log takes. */
    static String word(String text) {
        String w = text == null ? "none" : text.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9_.:-]", "_");
        if (w.isEmpty() || !Character.isLetter(w.charAt(0))) {
            w = "x" + w;
        }
        return w.length() > 64 ? w.substring(0, 64) : w;
    }

    static String newId(String prefix) {
        char[] out = new char[12];
        for (int i = 0; i < out.length; i++) {
            out[i] = BASE32[RANDOM.nextInt(32)];
        }
        return prefix + "-" + new String(out);
    }

    private static String newAgentId() {
        return newId("ag");
    }

    /** An agent id a team method takes: never a guild member's own agent ({@code gm-*}, Security T49M-5). */
    static String agentId(Map<String, Object> p) throws RpcError {
        String id = string(p, "agentId");
        if (!AGENT_ID.matcher(id).matches() || Caller.isMemberAgent(id)) {
            throw RpcError.notFound("agent");
        }
        return id;
    }

    static String string(Map<String, Object> p, String key) throws RpcError {
        if (p.get(key) instanceof String value) {
            return value;
        }
        throw RpcError.badRequest(key);
    }

    static boolean bool(Map<String, Object> p, String key) throws RpcError {
        if (p.get(key) instanceof Boolean value) {
            return value;
        }
        throw RpcError.badRequest(key);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Map<String, Object> p, String key) throws RpcError {
        if (p.get(key) instanceof Map<?, ?> value) {
            return (Map<String, Object>) value;
        }
        throw RpcError.badRequest(key);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> cast(Map<?, ?> map) {
        return (Map<String, Object>) map;
    }

    /** An agent's name: 1 to 40 letters, digits, spaces and {@code . _ ' -}, with no hidden characters. */
    public static String name(Map<String, Object> p, boolean required) throws RpcError {
        if (!required && !p.containsKey("name")) {
            return null;
        }
        String name = string(p, "name").strip();
        TextChecks.refuseHidden(name, "name");
        if (!WORDS.matcher(name).matches()) {
            throw RpcError.badRequest("name");
        }
        return name;
    }

    static String purpose(Map<String, Object> p) throws RpcError {
        if (p.get("purpose") == null) {
            return "";
        }
        String purpose = string(p, "purpose").strip();
        TextChecks.refuseHidden(purpose, "purpose");
        if (purpose.codePointCount(0, purpose.length()) > TierCaps.PURPOSE_MAX || purpose.indexOf('\0') >= 0) {
            throw RpcError.badRequest("purpose");
        }
        return purpose;
    }

    /** An icon or tone id, or the fallback; a retired one comes in as the one that took its place (Design H4). */
    static String look(Map<String, Object> p, String key, String fallback) throws RpcError {
        if (p.get(key) == null) {
            if (fallback == null) {
                throw RpcError.badRequest(key);
            }
            return fallback;
        }
        String id = string(p, key);
        if (!LOOK_ID.matcher(id).matches()) {
            throw RpcError.badRequest(key);
        }
        return key.equals("icon") ? TeamTools.icon(id) : key.equals("tone") ? TeamTools.tone(id) : id;
    }

    /** An optional whole number, 0 or more. */
    private static long wholeNumber(Map<String, Object> p, String key, long fallback) throws RpcError {
        if (p.get(key) == null) {
            return fallback;
        }
        if (!(p.get(key) instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue()) || n.longValue() < 0) {
            throw RpcError.badRequest(key);
        }
        return n.longValue();
    }

    Integer workspaceMb(Map<String, Object> p) throws RpcError {
        if (p.get("workspaceMb") == null) {
            return null;
        }
        if (!(p.get("workspaceMb") instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())
                || n.longValue() < 1 || n.longValue() > caps.workspaceMaxMb()) {
            throw RpcError.badRequest("workspaceMb");
        }
        return n.intValue();
    }

    /** The member's zone, as the limits use it. */
    ZoneId zone() {
        return limits.zone();
    }

    /** "2026-11-09T08:00" in the member's zone, or epoch ms. */
    static Long instant(Object value, ZoneId zone) throws RpcError {
        if (value == null) {
            return null;
        }
        if (value instanceof Number n) {
            return n.longValue();
        }
        if (value instanceof String text) {
            try {
                return Schedule.instant(LocalDateTime.parse(text), zone);
            } catch (DateTimeParseException e) {
                try {
                    return Instant.parse(text).toEpochMilli();
                } catch (DateTimeParseException again) {
                    throw RpcError.badRequest("at");
                }
            }
        }
        throw RpcError.badRequest("at");
    }

    /**
     * An agent's id from its id or its name, or null: none has it, or more than one agent's name reads as it (names
     * made before they had to be unique). Names compare by {@link TextChecks#nameKey}.
     */
    String resolve(String idOrName) throws SQLException {
        try {
            return resolveOne(idOrName);
        } catch (RpcError e) {
            return null;
        }
    }

    /**
     * The same for the lead's tools, which take ids: a name is still taken when exactly one agent has it, and one that
     * more than one agent has is refused ({@code bad_request}, {@code detail: "agent"}, {@code reason: "ambiguous"}).
     */
    String resolveOne(String idOrName) throws RpcError, SQLException {
        if (idOrName == null) {
            return null;
        }
        String wanted = idOrName.strip();
        List<AgentRow> agents = teamAgents();
        for (AgentRow row : agents) {
            if (row.id().equals(wanted)) {
                return row.id();
            }
        }
        String key = TextChecks.nameKey(wanted);
        String found = null;
        for (AgentRow row : agents) {
            if (TextChecks.nameKey(row.name()).equals(key)) {
                if (found != null) {
                    throw RpcError.of("bad_request", "detail", "agent", "reason", "ambiguous");
                }
                found = row.id();
            }
        }
        return found;
    }

    /**
     * Refuses a name another agent here has, or reads as ({@link TextChecks#nameKey}), or another agent's id: names are
     * unique per desk ({@code bad_request}, {@code detail: "name"}, {@code reason: "name_taken"}).
     *
     * @param self the agent being renamed, or null for a new one
     */
    void requireUniqueName(String name, String self, List<AgentRow> agents) throws RpcError {
        String key = TextChecks.nameKey(name);
        for (AgentRow row : agents) {
            if (row.id().equals(self)) {
                continue;
            }
            if (TextChecks.nameKey(row.name()).equals(key) || TextChecks.nameKey(row.id()).equals(key)) {
                throw RpcError.of("bad_request", "detail", "name", "reason", "name_taken");
            }
        }
    }

    /**
     * The tone a new agent gets when none is picked: the first in the wheel's order, after graphite, that no agent here
     * has, and once every one is taken, the least used (the wheel's order breaks ties).
     */
    String defaultTone() throws SQLException {
        Map<String, Integer> used = new HashMap<>();
        for (Extras extras : team.extras().values()) {
            if (!Caller.isMemberAgent(extras.id())) {
                used.merge(TeamTools.tone(extras.tone()), 1, Integer::sum);
            }
        }
        String best = null;
        int least = Integer.MAX_VALUE;
        for (String tone : TeamTools.TONES) {
            int count = used.getOrDefault(tone, 0);
            if (!tone.equals("graphite") && count < least) {
                best = tone;
                least = count;
            }
        }
        return best;
    }

    /**
     * The desk's own agents: the lead and staff, not a guild member's own agent (a {@code manager} row whose id is a
     * member's id, deskd's API.md section 14), which the team never counts, lists, links or shares with.
     */
    List<AgentRow> teamAgents() throws SQLException {
        List<AgentRow> rows = new ArrayList<>();
        for (AgentRow row : store.agents()) {
            if (!Caller.isMemberAgent(row.id())) {
                rows.add(row);
            }
        }
        return rows;
    }

    List<KeyRow> keys() throws SQLException {
        return store.keys();
    }

    /** A dollar cap that a share of the spend on agent messages is taken of, and when its period began. */
    record Share(String scope, long capMicroUsd, long sinceMs) {
        long of(int pct) {
            return capMicroUsd * pct / 100;
        }
    }

    /**
     * What a receiver's share of spend on agent messages is taken of: its daily dollar cap, else the next dollar scope
     * that exists, its week, then month, then the desk's day, then month. A cap in tokens only isn't a dollar scope.
     * Null when none is in dollars: nothing bounds the share then, so a message to it is refused {@code spend}.
     */
    Share a2aShare(String agentId) {
        return firstShare(limits.policyFor(agentId), true);
    }

    /**
     * What the desk-wide share of spend on agent messages is taken of: the desk's daily dollar cap, else its monthly
     * one, each over its own period. Null when the desk has neither in dollars; each receiver's share still holds.
     */
    Share deskA2aShare() {
        return firstShare(limits.policyFor(AgentStore.MANAGER), false);
    }

    private Share firstShare(com.minimalistalliance.desk.agent.limits.LimitPolicy policy, boolean agentScopes) {
        java.time.LocalDate today = Instant.ofEpochMilli(clock.millis()).atZone(zone()).toLocalDate();
        java.time.LocalDate monday = today.with(java.time.temporal.TemporalAdjusters.previousOrSame(
                java.time.DayOfWeek.MONDAY));
        java.time.LocalDate first = today.withDayOfMonth(1);
        List<Share> shares = new ArrayList<>();
        if (agentScopes) {
            shares.add(share("agent_day", policy.agentDay(), today));
            shares.add(share("agent_week", policy.agentWeek(), monday));
            shares.add(share("agent_month", policy.agentMonth(), first));
        }
        shares.add(share("desk_day", policy.deskDay(), today));
        shares.add(share("desk_month", policy.deskMonth(), first));
        for (Share share : shares) {
            if (share != null) {
                return share;
            }
        }
        return null;
    }

    private Share share(String scope, Limit limit, java.time.LocalDate start) {
        if (limit == null || limit.maxMicroUsd() == null) {
            return null;
        }
        return new Share(scope, limit.maxMicroUsd(), start.atStartOfDay(zone()).toInstant().toEpochMilli());
    }

    static Collection<String> ids(Collection<AgentRow> rows) {
        List<String> ids = new ArrayList<>();
        for (AgentRow row : rows) {
            ids.add(row.id());
        }
        return ids;
    }
}
