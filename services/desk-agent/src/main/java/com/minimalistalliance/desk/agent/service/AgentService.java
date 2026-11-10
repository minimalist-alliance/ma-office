package com.minimalistalliance.desk.agent.service;

import com.minimalistalliance.desk.agent.attach.AttachException;
import com.minimalistalliance.desk.agent.attach.Caps;
import com.minimalistalliance.desk.agent.attach.ImageBudget;
import com.minimalistalliance.desk.agent.attach.Parsers;
import com.minimalistalliance.desk.agent.attach.Preparer;
import com.minimalistalliance.desk.agent.attach.Staging;
import com.minimalistalliance.desk.agent.attach.Vision;
import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.key.KeyVault;
import com.minimalistalliance.desk.agent.limits.Limit;
import com.minimalistalliance.desk.agent.limits.LimitPolicy;
import com.minimalistalliance.desk.agent.limits.LimitSettings;
import com.minimalistalliance.desk.agent.limits.PriceTable;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.manager.AgentException;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.manager.RunIds;
import com.minimalistalliance.desk.agent.provider.Attachment;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatProvider;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ModelInfo;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.store.AgentRow;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.store.FileNote;
import com.minimalistalliance.desk.agent.store.KeyRow;
import com.minimalistalliance.desk.agent.store.MessageRow;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import com.minimalistalliance.desk.agent.team.Team;
import com.minimalistalliance.desk.agent.team.TierCaps;
import com.minimalistalliance.desk.agent.store.TeamStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Task 07's {@code agent.*} interface, as desk-agent serves it through deskd's relay (docs/proposals.md sections 5
 * and 6): one method per RPC, taking the params map as the client sent it and answering with the result map, or an
 * {@link RpcError} in deskd's codes. It keeps the {@code agent.state} and {@code agent.conversation:<agentId>} topics
 * up to date. {@code desk.prices.set} and {@code desk.account.set} are deskd's own, not a client's: deskd's relay has
 * an allow-list of {@code agent.*}, so no client can reach them.
 *
 * <p>Phase 1 has the manager only (design 9.2), so {@code agent.create} answers {@code agent_cap}. Threads, agents
 * and key metadata live in {@link AgentStore}; keys in {@link KeyRing} in RAM and, sealed, in {@link KeyVault} on disk
 * (ADR 0042), with the key's row as the commit point between them.
 */
public final class AgentService {

    private static final Logger log = LoggerFactory.getLogger(AgentService.class);

    public static final String STATE_TOPIC = "agent.state";
    public static final String CONVERSATION_PREFIX = "agent.conversation:";

    /** design 9.2's staff cap; 0 in Phase 1. */
    static final int STAFF_CAP = 0;
    /** The output cap a binding reserves against: room for adaptive thinking and a long answer. */
    static final int MAX_OUTPUT_TOKENS = 8192;
    /** How much of the thread goes with each call. Older turns aren't sent; summaries come with memory (9.10). */
    static final int CONTEXT_MESSAGES = 100;
    static final int MAX_TEXT = 100_000;
    /** The most all members' half-attached files may hold at once (ADR 0049). */
    public static final long STAGING_BYTES = 24L << 20;
    /** How long the reader child may take on one file. */
    public static final long PARSE_SECONDS = 30;
    /** Most files a message names, whatever the caps say. */
    private static final int MAX_UPLOAD_IDS = 20;
    /** Base64 of the largest chunk, and a little more. */
    private static final int MAX_CHUNK_CHARS = Staging.CHUNK / 3 * 4 + 8;
    /**
     * The most JSON of messages one page of {@code agent.thread.get}, or a conversation's snapshot, carries: a page then
     * fits deskd's RES of 1 MiB with room for the rest of the result, and a snapshot a frame of 4 MiB.
     */
    static final int PAGE_BYTES = (1 << 20) - (64 << 10);
    /** The most messages a page carries, as before there were pages. */
    static final int PAGE_MESSAGES = 1000;
    /** Rows read at a time while a page fills. */
    private static final int PAGE_BATCH = 50;
    static final Duration MODELS_FRESH = Duration.ofMinutes(10);
    private static final Pattern MODEL = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}");
    private static final Pattern DESK_ID = Pattern.compile("[a-z0-9-]{1,64}");

    private record CachedModels(List<ModelInfo> models, long fetchedAt) {}

    private record ActiveRun(String agentId, String replyId, ManagerAgent.Run run, Deltas deltas,
            Map<String, Object> origin, Team.Chain chain) {}

    private final AgentStore store;
    private final ManagerAgent manager;
    private final KeyRing keys;
    private final KeyVault vault;
    private final ProviderRegistry providers;
    private final PriceTable prices;
    private final LimitSettings limits;
    /** One {@code agent.limits.set} at a time, as each reads the desk's layer, changes it and saves it. */
    private final ReentrantLock limitsLock = new ReentrantLock();
    private final UsageLedger ledger;
    private final AuditLog audit;
    private final TopicHub topics;
    private final Clock clock;
    private final Map<String, ActiveRun> runs = new ConcurrentHashMap<>();
    /** Each guild member's own agent, by its id, the member's id: made at first use, or restored with its binding. */
    private final Map<String, ManagerAgent> memberAgents = new ConcurrentHashMap<>();
    /** The guild's limits on members' agents, as deskd last said ({@code desk.guild.set}). */
    private volatile GuildLimits guild = GuildLimits.DEFAULTS;
    /** Members' runs started or starting, against the guild's runs at once. Under {@link #guildRunsLock}. */
    private final ReentrantLock guildRunsLock = new ReentrantLock();
    private int memberRunsStarting;
    private final Map<String, CachedModels> models = new ConcurrentHashMap<>();
    /** Each staff agent's runtime by id (ADR 0047); the lead's is {@link #manager}, members' {@link #memberAgents}. */
    private final Map<String, ManagerAgent> runtimes = new ConcurrentHashMap<>();
    /** Starting a run, so the desk's runs at once ({@link com.minimalistalliance.desk.agent.team.TierCaps#RUNS_AT_ONCE}) hold. */
    private final ReentrantLock startLock = new ReentrantLock();
    private final Team team;
    /** Files being attached, in memory only (ADR 0049). */
    private final Staging staging;
    private final Preparer preparer;
    /** Picture bytes with model calls now, across the desk. */
    private final ImageBudget pictures = new ImageBudget();

    /** With staging and readers of its own, as tests and the first wiring have them. */
    public AgentService(AgentStore store, ManagerAgent manager, KeyRing keys, KeyVault vault,
            ProviderRegistry providers, PriceTable prices, LimitSettings limits, UsageLedger ledger, AuditLog audit,
            TopicHub topics, Clock clock, Team team) {
        this(store, manager, keys, vault, providers, prices, limits, ledger, audit, topics, clock, team,
                new Staging(clock, STAGING_BYTES), new Preparer(new Parsers(PARSE_SECONDS)));
    }

    public AgentService(AgentStore store, ManagerAgent manager, KeyRing keys, KeyVault vault,
            ProviderRegistry providers, PriceTable prices, LimitSettings limits, UsageLedger ledger, AuditLog audit,
            TopicHub topics, Clock clock, Team team, Staging staging, Preparer preparer) {
        this.staging = staging;
        this.preparer = preparer;
        this.team = team;
        this.store = store;
        this.manager = manager;
        this.keys = keys;
        this.vault = vault;
        this.providers = providers;
        this.prices = prices;
        this.limits = limits;
        this.ledger = ledger;
        this.audit = audit;
        this.topics = topics;
        this.clock = clock;
        team.attach(new TeamHost());
    }

    /** After the store opens: the keys, the manager's binding and the desk's limits back from disk. */
    public void restore() throws SQLException {
        restoreKeys();
        for (AgentRow row : store.agents()) {
            if (row.limits() != null) {
                limits.setAgent(row.id(), LimitSettings.AgentLimits.fromJson(row.limits()));
            }
            ManagerAgent runner = runnerOf(row.id());
            if (row.keyId() != null) {
                runner.bind(binding(row));
            }
        }
        String desk = store.setting("limits.desk");
        if (desk != null) {
            limits.setDesk(LimitSettings.DeskLimits.fromJson(desk));
        }
        team.restore();
        team.timers().start();
    }

    public Team team() {
        return team;
    }

    /** One RPC by name, from the owner: deskd's own pushes, and a deskd from before guilds. */
    public Map<String, Object> call(String method, Map<String, Object> p) throws RpcError, SQLException {
        return call(method, p, Caller.OWNER);
    }

    /**
     * One RPC by name, for the caller deskd verified ({@link Caller}). A guild member sees and uses only their own agent:
     * any other agent id is {@code not_found}, as one that doesn't exist.
     */
    public Map<String, Object> call(String method, Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        allow(method, caller);
        return switch (method) {
            case "agent.providers" -> providers();
            case "agent.list" -> Map.of("agents", agents(caller));
            case "agent.get" -> Map.of("agent", agentView(row(agentId(p), caller)));
            case "agent.create" -> Map.of("agent", agentView(row((String) team.call(method, p).get("agentId"))));
            case "agent.links.set", "agent.workspace.share", "agent.icon.upload" -> {
                team.call(method, p);
                yield Map.of("agent", agentView(row(agentId(p))));
            }
            case "agent.update" -> update(p, caller);
            case "agent.bind" -> bind(p, caller);
            case "agent.thread.get" -> thread(p, caller);
            case "agent.message.send" -> send(p, caller);
            case "agent.attach.put" -> attachPut(p, caller);
            case "agent.attach.remove" -> attachRemove(p, caller);
            case "agent.attach.caps" -> attachCaps(p, caller);
            case "agent.attach.caps.set" -> attachCapsSet(p);
            case "agent.run.stop" -> stop(p, caller);
            case "agent.seen" -> seen(p, caller);
            case "agent.key.list" -> keyList();
            case "agent.key.delete" -> keyDelete(p);
            case "agent.key.models" -> keyModels(p);
            case "agent.limits.get" -> limitsView(row(agentId(p), caller).id(), caller);
            case "agent.limits.set" -> limitsSet(p, caller);
            case "agent.audit.list" -> auditList(p);
            case "agent.guild.usage" -> guildUsage();
            case "desk.prices.set" -> pricesSet(p);
            case "desk.account.set" -> accountSet(p);
            case "desk.guild.set" -> guildSet(p);
            case "agent.key.add" -> throw RpcError.badRequest("key_frame");
            default -> {
                if (Team.handles(method)) {
                    yield team.call(method, p);
                }
                throw RpcError.of("not_found", "detail", "method");
            }
        };
    }

    /** What only the Founder, or an Officer with manage_agents, may do on a guild desk: deskd checks it first too. */
    private static final Set<String> MANAGERS_ONLY =
            Set.of("agent.key.add", "agent.key.delete", "agent.limits.set", "agent.audit.list");

    /**
     * Who may call what, whatever deskd let through: the system nothing; {@code desk.*} the owner (deskd) only; a teen
     * member nothing ({@code age_band}); the guild's keys, limits and audit a manager; members' usage the Founder and
     * Officers.
     */
    private static void allow(String method, Caller caller) throws RpcError {
        if (caller.isSystem()) {
            throw Caller.refused();
        }
        if (caller.isOwner()) {
            return;
        }
        if (method.startsWith("desk.") || method.equals("agent.attach.caps.set")) {
            throw RpcError.of("forbidden", "reason", "permission");
        }
        if (caller.teen()) {
            throw RpcError.of("forbidden", "reason", "age_band");
        }
        // Task 49's team (ADR 0047) is the desk owner's: a guild member has only their own agent.
        if (Team.handles(method) && !method.equals("agent.get")) {
            throw RpcError.of("forbidden", "reason", "permission");
        }
        if (MANAGERS_ONLY.contains(method) && !caller.has(Caller.MANAGE_AGENTS)) {
            throw RpcError.of("forbidden", "reason", "grant");
        }
        if (method.equals("agent.guild.usage") && !"lead".equals(caller.role()) && !"officer".equals(caller.role())) {
            throw RpcError.of("forbidden", "reason", "grant");
        }
    }

    /**
     * Every key row's sealed file into {@link KeyRing}. A row whose file is missing or won't open stays in the list as
     * unavailable, with its file kept until the member deletes the key. A sealed file with no row is an orphan: a crash
     * between sealing and the row, which never answered the member, so it's deleted. Nothing about the vault stops a
     * start: a row that can't be read is the only thing that can, as for every other row here.
     */
    private void restoreKeys() throws SQLException {
        List<KeyRow> rows = store.keys();
        int restored = 0;
        int unreadable = 0;
        int orphans = 0;
        try {
            vault.prepare();
            Set<String> listed = new HashSet<>();
            for (KeyRow row : rows) {
                listed.add(row.keyId());
                try {
                    keys.restore(row.keyId(), providerId(row.provider()), vault.unseal(row.keyId(), row.provider()));
                    restored++;
                } catch (IOException | RuntimeException e) {
                    unreadable++;
                }
            }
            orphans = vault.removeOrphans(listed);
        } catch (RuntimeException e) {
            log.error("the keys weren't restored: {}", e.getClass().getSimpleName());
            unreadable = rows.size() - restored;
        }
        if (unreadable > 0 || orphans > 0) {
            log.warn("key vault: {} keys restored, {} unavailable, {} orphaned files removed", restored, unreadable,
                    orphans);
        }
        if (!rows.isEmpty()) {
            try {
                audit.append(AuditLog.Entry.of("system", "key.restore", "keys:all",
                        "restored:" + restored + ":unreadable:" + unreadable));
            } catch (SQLException | RuntimeException e) {
                log.warn("the keys' restore wasn't recorded: {}", e.getClass().getSimpleName());
            }
        }
    }

    // ---------------------------------------------------------------- agents

    private Map<String, Object> providers() {
        List<Map<String, Object>> list = new ArrayList<>();
        for (ChatProvider provider : providers.all()) {
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("id", provider.id().id());
            p.put("name", provider.id().displayName());
            p.put("console", provider.info().console());
            p.put("keyPrefix", provider.info().keyPrefix());
            list.add(p);
        }
        return Map.of("providers", list);
    }

    /** The owner's agents, as {@code agent.list} and {@code agent.state} show them. */
    public List<Map<String, Object>> agents() throws SQLException {
        return agents(Caller.OWNER);
    }

    /** The agents this caller sees: a member's is made the first time they look. */
    public List<Map<String, Object>> agents(Caller caller) throws SQLException {
        return agents(caller, true);
    }

    /** Whole, or as {@code agent.state} has them, without purposes, rules or workspaces, so it fits 64 KiB events. */
    private List<Map<String, Object>> agents(Caller caller, boolean full) throws SQLException {
        if (caller.isMember()) {
            ensureMemberAgent(caller.memberId());
        }
        Team.Snapshot snapshot = team.snapshot();
        List<Map<String, Object>> list = new ArrayList<>();
        for (AgentRow row : store.agents()) {
            if (caller.sees(row.id())) {
                list.add(decorated(baseView(row), snapshot, full));
            }
        }
        return list;
    }

    /** A member's own agent, its row and its runner, made once. */
    private void ensureMemberAgent(String memberId) throws SQLException {
        if (store.agent(memberId) == null) {
            store.ensureAgent(memberId, "Agent");
        }
        memberAgent(memberId);
    }

    /** The runner of a member's agent, bound to the guild's limits. */
    private ManagerAgent memberAgent(String agentId) {
        return memberAgents.computeIfAbsent(agentId, id -> manager.forAgent(id, this::memberPolicy));
    }

    /** What a member's agent's calls reserve against: their caps and the guild's, both (GuildLimits). */
    private LimitPolicy memberPolicy() {
        return guild.policy(limits.policyFor(AgentStore.MANAGER));
    }

    /** The runner of an agent: the lead's, a guild member's, or a staff agent's (ADR 0047), made the first time. */
    private ManagerAgent runnerOf(String agentId) {
        if (agentId.equals(AgentStore.MANAGER)) {
            return manager;
        }
        return Caller.isMemberAgent(agentId) ? memberAgent(agentId)
                : runtimes.computeIfAbsent(agentId, id -> manager.forAgent(id, null));
    }

    private Map<String, Object> agentView(AgentRow row) throws SQLException {
        return decorated(baseView(row), team.snapshot(), true);
    }

    private Map<String, Object> decorated(Map<String, Object> view, Team.Snapshot snapshot, boolean full) {
        String id = (String) view.get("id");
        team.decorate(view, snapshot.extras().get(id), snapshot.links().getOrDefault(id, List.of()),
                snapshot.timers().getOrDefault(id, 0), full);
        return view;
    }

    private Map<String, Object> baseView(AgentRow row) {
        Map<String, Object> agent = new LinkedHashMap<>();
        agent.put("id", row.id());
        agent.put("name", row.name());
        agent.put("role", row.role());
        ManagerAgent runner = runnerOf(row.id());
        boolean paused = team.paused(row.id());
        agent.put("status", paused ? "paused" : runner.status().wireName());
        agent.put("statusDetail", paused ? "agent_cap" : runner.statusDetail());
        if (row.keyId() == null) {
            agent.put("binding", null);
        } else {
            Map<String, Object> binding = new LinkedHashMap<>();
            binding.put("keyId", row.keyId());
            binding.put("provider", row.provider());
            binding.put("providerName", providerName(row.provider()));
            binding.put("model", row.model());
            agent.put("binding", binding);
        }
        agent.put("badgeHidden", row.badgeHidden());
        agent.put("badgeNotice", row.badgeNotice());
        agent.put("unseen", row.unseen());
        agent.put("createdAt", row.createdAt());
        return agent;
    }

    /*
     * Each change to an agent's row writes only its own columns (AgentStore), so two at once, say agent.seen and
     * agent.limits.set, can't put back an older copy of what the other wrote.
     */

    private Map<String, Object> update(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        String agentId = agentId(p);
        row(agentId, caller);
        String name = null;
        if (p.containsKey("name")) {
            name = Team.name(p, true);
        }
        Boolean badgeHidden = p.containsKey("badgeHidden") ? bool(p, "badgeHidden") : null;
        Boolean badgeNotice = Boolean.TRUE.equals(p.get("dismissBadgeNotice")) ? Boolean.FALSE : null;
        if (caller.isOwner()) {
            team.update(agentId, p);
        }
        store.setNameAndBadge(agentId, name, badgeHidden, badgeNotice);
        publishState(agentId);
        return Map.of("agent", agentView(row(agentId)));
    }

    private Map<String, Object> bind(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        String agentId = agentId(p);
        row(agentId, caller);
        KeyRow key = store.key(string(p, "keyId"));
        if (key == null) {
            throw RpcError.notFound("key");
        }
        String model = string(p, "model");
        if (!MODEL.matcher(model).matches()) {
            throw RpcError.badRequest("model");
        }
        // design 9.4: a hidden badge comes back after any provider change, until dismissed. The store judges that.
        store.setBinding(agentId, key.keyId(), key.provider(), model);
        AgentRow row = row(agentId);
        ManagerAgent runner = runnerOf(row.id());
        if (runner != null) {
            runner.bind(binding(row));
        }
        publishState(agentId);
        return Map.of("agent", agentView(row));
    }

    private Map<String, Object> seen(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        AgentRow row = row(agentId(p), caller);
        if (row.unseen() != 0) {
            store.clearUnseen(row.id());
            publishState(row.id());
        }
        return Map.of();
    }

    // ---------------------------------------------------------------- threads and runs

    /**
     * {@code agent.thread.get}: a page of the thread, the newest messages that fit, or with {@code before}, those older
     * than that message. {@code older} says whether there are more before the first; that one's id is the next
     * {@code before}. The page and its {@code seq} are read under the topic's lock, so they agree.
     */
    private Map<String, Object> thread(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        String agentId = agentId(p);
        row(agentId, caller);
        String before = p.get("before") == null ? null : string(p, "before");
        if (before != null && !store.hasMessage(agentId, before)) {
            throw RpcError.notFound("message");
        }
        String topic = CONVERSATION_PREFIX + agentId;
        return underLock(topic, () -> {
            Page page = page(agentId, before);
            Map<String, Object> thread = new LinkedHashMap<>();
            thread.put("agentId", agentId);
            thread.put("messages", page.messages());
            thread.put("older", page.older());
            thread.put("seq", topics.seq(topic));
            return thread;
        });
    }

    /** The thread for a new subscriber, with streaming replies' text so far: its newest page, as {@code agent.thread.get}'s. */
    public Map<String, Object> conversationSnapshot(String agentId) {
        try {
            Page page = page(agentId, null);
            return Map.of("messages", page.messages(), "older", page.older());
        } catch (SQLException e) {
            return Map.of("messages", List.of());
        }
    }

    /**
     * The newest messages before {@code before}, or the newest of all, that fit in {@link #PAGE_BYTES} of JSON, at most
     * {@link #PAGE_MESSAGES}, oldest first, read a few rows at a time so a long thread is never all in memory. The newest
     * always comes: if it alone is too long, the start of its text that fits, with {@code truncated: true}.
     */
    private Page page(String agentId, String before) throws SQLException {
        List<Map<String, Object>> newestFirst = new ArrayList<>();
        int used = 2;
        boolean full = false;
        String cursor = before;
        while (true) {
            List<MessageRow> rows = store.messagesNewestFirst(agentId, cursor, PAGE_BATCH);
            Map<String, List<Map<String, Object>>> proposals = team.proposalViews(rows);
            for (MessageRow row : rows) {
                if (full || newestFirst.size() == PAGE_MESSAGES) {
                    return Page.of(newestFirst, true);
                }
                Map<String, Object> view = view(row);
                if (proposals.containsKey(row.id())) {
                    view.put("proposals", proposals.get(row.id()));
                }
                int bytes = Json.bytes(view).length + 1;
                if (used + bytes > PAGE_BYTES) {
                    if (!newestFirst.isEmpty()) {
                        return Page.of(newestFirst, true);
                    }
                    view = cut(view, PAGE_BYTES - used);
                    full = true;
                }
                newestFirst.add(view);
                used += bytes;
            }
            if (rows.size() < PAGE_BATCH) {
                return Page.of(newestFirst, false);
            }
            cursor = rows.getLast().id();
        }
    }

    /** A page of a thread, oldest first. */
    private record Page(List<Map<String, Object>> messages, boolean older) {
        static Page of(List<Map<String, Object>> newestFirst, boolean older) {
            List<Map<String, Object>> inOrder = new ArrayList<>(newestFirst);
            Collections.reverse(inOrder);
            return new Page(inOrder, older);
        }
    }

    /** A message as clients see it, a streaming reply with its text so far. */
    private Map<String, Object> view(MessageRow row) {
        String text = row.text();
        if ("streaming".equals(row.state())) {
            ActiveRun active = runs.get(row.runId());
            text = active == null ? text : active.deltas().text();
        }
        Map<String, Object> view = messageView(row, text);
        if (row.role().equals("user")) {
            try {
                List<FileNote> files = FileNote.parse(store.filesOf(row.id()));
                if (!files.isEmpty()) {
                    view.put("attachments", FileNote.views(files));
                }
            } catch (SQLException e) {
                log.warn("a message's files weren't read: {}", e.getClass().getSimpleName());
            }
        }
        return view;
    }

    /** The message with as much of the start of its text as fits in {@code budget} bytes of JSON, and {@code truncated}. */
    static Map<String, Object> cut(Map<String, Object> message, int budget) {
        String text = (String) message.get("text");
        Map<String, Object> copy = new LinkedHashMap<>(message);
        copy.put("truncated", true);
        int low = 0;
        int high = text == null ? 0 : text.length();
        while (low < high) {
            int mid = (low + high + 1) >>> 1;
            copy.put("text", start(text, mid));
            if (Json.bytes(copy).length <= budget) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        copy.put("text", text == null ? null : start(text, low));
        return copy;
    }

    /** The first {@code chars} characters, one fewer if that would split a surrogate pair. */
    private static String start(String text, int chars) {
        if (chars >= text.length()) {
            return text;
        }
        int end = chars > 0 && Character.isHighSurrogate(text.charAt(chars - 1)) ? chars - 1 : chars;
        return text.substring(0, end);
    }

    @FunctionalInterface
    private interface StoreWork<T> {
        T run() throws SQLException;
    }

    /** {@link TopicHub#underLock} for work that reads the store. */
    private <T> T underLock(String topic, StoreWork<T> work) throws SQLException {
        SQLException[] failure = new SQLException[1];
        T result = topics.underLock(topic, () -> {
            try {
                return work.run();
            } catch (SQLException e) {
                failure[0] = e;
                return null;
            }
        });
        if (failure[0] != null) {
            throw failure[0];
        }
        return result;
    }

    private static Map<String, Object> messageView(MessageRow row, String text) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("id", row.id());
        message.put("role", row.role());
        message.put("text", text);
        message.put("at", row.at());
        if (row.origin() != null) {
            message.put("origin", parse(row.origin()));
        }
        if (row.role().equals("assistant")) {
            if (row.tools() != null) {
                List<Object> tools = parseList(row.tools());
                message.put("tools", tools);
                List<Map<String, Object>> refused = new ArrayList<>();
                for (Object tool : tools) {
                    if (tool instanceof Map<?, ?> chip && chip.get("path") instanceof String path
                            && chip.get("reason") instanceof String reason) {
                        refused.add(Map.of("path", path, "reason", reason));
                    }
                }
                if (!refused.isEmpty()) {
                    message.put("workspaceRefused", refused);
                }
            }
            message.put("runId", row.runId());
            message.put("badge", row.badge() == null ? null : parse(row.badge()));
            if (row.usage() != null) {
                message.put("usage", parse(row.usage()));
            }
            message.put("costMicroUsd", row.costMicroUsd());
            message.put("stopReason", row.stopReason());
            message.put("state", row.state());
            message.put("error", row.error());
            message.put("errorDetail", row.errorDetail());
        }
        return message;
    }

    private Map<String, Object> send(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        String agentId = agentId(p);
        AgentRow agent = row(agentId, caller);
        List<String> uploads = uploadIds(p);
        String text = p.get("text") == null && !uploads.isEmpty() ? "" : string(p, "text").strip();
        if (text.isEmpty() && uploads.isEmpty()) {
            throw RpcError.badRequest("text");
        }
        if (text.length() > MAX_TEXT) {
            throw RpcError.of("too_large", "detail", "text");
        }
        List<Attachment> attachments = List.of();
        String summary = null;
        if (!uploads.isEmpty()) {
            if (agent.keyId() == null) {
                throw RpcError.of("precondition_failed", "reason", "no_key");
            }
            // The agent still answering, or the desk's runs all taken, is the usual busy: refused here, before the files
            // leave staging, so they stay for the member's next send (they still expire with staging's TTL). startRun
            // checks again; if a run starts in between, that refusal wipes them as before.
            if (busyFor(agentId)) {
                throw RpcError.of("conflict", "reason", "busy");
            }
            // Pictures cost several times their size while a request is built: only so many at once, desk-wide. A
            // refusal here leaves the files staged, so the member can send again in a moment.
            long claimed = staging.pictureBytes(stager(caller), agentId, uploads);
            if (claimed > 0 && !pictures.tryClaim(claimed)) {
                throw RpcError.of("conflict", "reason", "busy");
            }
            try {
                attachments = prepare(agent, caller, uploads);
            } catch (RpcError | SQLException | RuntimeException e) {
                pictures.release(claimed);
                throw e;
            }
            summary = summary(agentId, attachments);
        }
        // From here the run owns the files, and wipes them wherever it ends, startRun's refusals included.
        Begun begun = startRun(agentId, text, null, Team.Chain.start(agentId), attachments);
        if (summary != null) {
            try {
                audit.append(AuditLog.Entry.of("user", "attach.send", summary, "ok"));
            } catch (SQLException | RuntimeException e) {
                log.warn("an attachment wasn't audited: {}", e.getClass().getSimpleName());
            }
        }
        return Map.of("messageId", begun.userId(), "runId", begun.run().runId());
    }

    // ---------------------------------------------------------------- attachments (ADR 0049)

    /** Whether a member's send to this agent would be refused as busy now: its own run, or the owner's runs at once. */
    private boolean busyFor(String agentId) {
        startLock.lock();
        try {
            if (runs.values().stream().anyMatch(active -> active.agentId().equals(agentId))) {
                return true;
            }
            if (Caller.isMemberAgent(agentId)) {
                return false;
            }
            long owners = runs.values().stream().filter(active -> !Caller.isMemberAgent(active.agentId())).count();
            return owners >= TierCaps.RUNS_AT_ONCE;
        } finally {
            startLock.unlock();
        }
    }

    /** The run is done with its files, or never began: wipes them and gives back the pictures' share of the budget. */
    private void discard(List<Attachment> attachments) {
        long held = 0;
        for (Attachment attachment : attachments) {
            if (!attachment.wiped() && attachment.kind() == Attachment.Kind.IMAGE) {
                held += attachment.size();
            }
            attachment.wipe();
        }
        pictures.release(held);
    }

    /** Who a staged file belongs to: the owner, or the member. */
    private static String stager(Caller caller) {
        return caller.isMember() ? caller.memberId() : "owner";
    }

    private Caps caps() throws SQLException {
        return Caps.parse(store.setting(Caps.SETTING));
    }

    /** {@code agent.attach.put}: one chunk of a file, in order, into memory. Nothing touches a disk. */
    private Map<String, Object> attachPut(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        String agentId = agentId(p);
        row(agentId, caller);
        String uploadId = string(p, "uploadId");
        String name = string(p, "name");
        long size = whole(p, "size");
        int index = (int) Math.min(whole(p, "index"), Integer.MAX_VALUE);
        if (!(p.get("data") instanceof String data) || data.isEmpty() || data.length() > MAX_CHUNK_CHARS) {
            throw RpcError.badRequest("data");
        }
        byte[] chunk;
        try {
            chunk = Base64.getDecoder().decode(data);
        } catch (IllegalArgumentException e) {
            throw RpcError.badRequest("data");
        }
        try {
            Staging.Receipt receipt = staging.put(stager(caller), agentId, uploadId, name, size, index, chunk, caps());
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("uploadId", receipt.uploadId());
            out.put("received", receipt.received());
            out.put("complete", receipt.complete());
            return out;
        } catch (AttachException e) {
            throw attachError(e);
        } finally {
            Arrays.fill(chunk, (byte) 0);
        }
    }

    /** {@code agent.attach.remove}: the member took a file off; its bytes are zeroed. */
    private Map<String, Object> attachRemove(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        row(agentId(p), caller);
        staging.remove(stager(caller), string(p, "uploadId"));
        return Map.of();
    }

    /**
     * {@code agent.attach.caps}: the limits, their ceilings and the chunk size; with {@code agentId}, whether that
     * agent's model takes pictures.
     */
    private Map<String, Object> attachCaps(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("caps", caps().toMap());
        out.put("ceiling", Caps.CEILING.toMap());
        out.put("chunkBytes", Staging.CHUNK);
        if (p.get("agentId") != null) {
            AgentRow agent = row(agentId(p), caller);
            out.put("vision", agent.keyId() != null && Vision.supports(providerId(agent.provider()), agent.model()));
        }
        return out;
    }

    /** {@code agent.attach.caps.set}: the owner's limits, each within its ceiling; fields left out stay. */
    private Map<String, Object> attachCapsSet(Map<String, Object> p) throws RpcError, SQLException {
        Caps next;
        try {
            next = Caps.from(p, caps());
        } catch (IllegalArgumentException e) {
            throw RpcError.badRequest("caps");
        }
        store.setSetting(Caps.SETTING, new String(Json.bytes(next.toMap()), StandardCharsets.UTF_8));
        audit.append(AuditLog.Entry.of("user", "attach.caps.set", "desk", "ok"));
        return Map.of("caps", next.toMap(), "ceiling", Caps.CEILING.toMap());
    }

    private List<String> uploadIds(Map<String, Object> p) throws RpcError {
        if (p.get("attachments") == null) {
            return List.of();
        }
        if (!(p.get("attachments") instanceof List<?> list) || list.size() > MAX_UPLOAD_IDS) {
            throw RpcError.badRequest("attachments");
        }
        List<String> ids = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof String id) || id.length() > 64) {
                throw RpcError.badRequest("attachments");
            }
            ids.add(id);
        }
        return ids;
    }

    /** The staged files read into what a model call carries, or the refusal. The staged buffers are zeroed either way. */
    private List<Attachment> prepare(AgentRow agent, Caller caller, List<String> uploads) throws RpcError, SQLException {
        Caps caps = caps();
        try {
            List<Staging.Staged> files = staging.take(stager(caller), agent.id(), uploads, caps);
            return preparer.prepare(files, caps, providerId(agent.provider()), agent.model());
        } catch (AttachException e) {
            throw attachError(e);
        }
    }

    /** The audit target for a send: how many files and of which types, never a name or a word of content. */
    private static String summary(String agentId, List<Attachment> attachments) {
        java.util.TreeSet<String> types = new java.util.TreeSet<>();
        for (Attachment attachment : attachments) {
            types.add(attachment.type().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", ""));
        }
        return "agent:" + agentId + " files=" + attachments.size() + " types=" + String.join(",", types);
    }

    private static RpcError attachError(AttachException e) {
        String code = switch (e.reason()) {
            case "too_large", "total_too_large", "too_long", "image_too_big", "too_many" -> "too_large";
            case "busy", "staging_full" -> "conflict";
            default -> "bad_request";
        };
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", e.reason());
        if (e.name() != null) {
            details.put("name", e.name());
        }
        if (e.limit() != null) {
            details.put("limit", e.limit());
        }
        return new RpcError(code, details);
    }

    private static long whole(Map<String, Object> p, String key) throws RpcError {
        if (p.get(key) instanceof Number n && n.doubleValue() == Math.rint(n.doubleValue()) && n.longValue() >= 0
                && n.longValue() < (1L << 40)) {
            return n.longValue();
        }
        throw RpcError.badRequest(key);
    }

    private record Begun(String userId, String replyId, ManagerAgent.Run run) {}

    /**
     * Starts a run of the agent on a new user turn: the member's, or (with {@code origin}) another agent's message or
     * a timer's prompt (ADR 0047). Refuses only {@code no_key}, {@code busy} (this agent's run, or the desk's runs at
     * once) and {@code limit_reached} (a guild member's also the guild's runs), before anything is added to the thread.
     * Then the user turn and a {@code streaming} reply go to the topic, deltas follow, and the reply's final message
     * replaces it.
     */
    private Begun startRun(String agentId, String text, Map<String, Object> origin, Team.Chain chain)
            throws RpcError, SQLException {
        return startRun(agentId, text, origin, chain, List.of());
    }

    /**
     * With the member's {@code attachments}, which this run owns from here: they're wiped when the run ends, whatever
     * the way, and at once if the run never starts (ADR 0049).
     */
    private Begun startRun(String agentId, String text, Map<String, Object> origin, Team.Chain chain,
            List<Attachment> attachments) throws RpcError, SQLException {
        boolean[] handed = new boolean[1];
        try {
            return begin(agentId, text, origin, chain, attachments, handed);
        } finally {
            if (!handed[0]) {
                discard(attachments);
            }
        }
    }

    private Begun begin(String agentId, String text, Map<String, Object> origin, Team.Chain chain,
            List<Attachment> attachments, boolean[] handed) throws RpcError, SQLException {
        ManagerAgent runner = runnerOf(agentId);
        boolean member = Caller.isMemberAgent(agentId);
        if (!member && team.paused(agentId)) {
            throw RpcError.of("precondition_failed", "reason", "agent_cap");
        }
        if (origin != null && !team.adult()) {
            throw RpcError.of("precondition_failed", "reason", "age_band");
        }
        long at = clock.millis();
        String userId = RunIds.next(clock).toString();
        String replyId = RunIds.next(clock).toString();
        MessageRow user = origin == null ? MessageRow.user(userId, agentId, text, at)
                : MessageRow.from(userId, agentId, text, at, new String(Json.bytes(origin),
                        java.nio.charset.StandardCharsets.UTF_8));
        List<MessageRow> rows = new ArrayList<>(store.messages(agentId, CONTEXT_MESSAGES));
        rows.add(user);
        List<ChatMessage> thread = team.context(rows);
        if (!attachments.isEmpty()) {
            // The files go with this call only. The thread keeps a line about them (below), never their content.
            thread.set(thread.size() - 1, ChatMessage.user(thread.getLast().text(), attachments));
        }
        // A guild member's own agent has no team tools: it answers as the manager did before task 49.
        ManagerAgent.RunSetup setup = member ? null : team.setupFor(agentId, origin);

        String topic = CONVERSATION_PREFIX + agentId;
        CountDownLatch published = new CountDownLatch(1);
        Deltas[] deltas = new Deltas[1];
        String[] runId = new String[1];
        ManagerAgent.Run run;
        MessageRow reply;
        if (member) {
            claimGuildRun(agentId);
        }
        startLock.lock();
        try {
            // The owner's desk has RUNS_AT_ONCE at once, one kept for runs the member started: timers and other
            // agents' messages (origin) stop at UNATTENDED_RUNS. A guild member's runs have the guild's pool and
            // never count here (claimGuildRun).
            // Again under the lock (Security T49K-2): a band change stops the owner's runs under it too, so no run
            // that started before the change is missed and none starts after it. deskd refuses the Agent app's own
            // calls while the band isn't adult; this closes the gap between its check and the call arriving here.
            if (!member && !team.adult()) {
                throw RpcError.of("precondition_failed", "reason", "age_band");
            }
            int owners = (int) runs.values().stream().filter(active -> !Caller.isMemberAgent(active.agentId())).count();
            int room = origin == null ? TierCaps.RUNS_AT_ONCE : TierCaps.UNATTENDED_RUNS;
            if (!member && owners >= room) {
                throw new AgentException(AgentException.Code.BUSY, "desk");
            }
            DeltaSink sink = piece -> {
                awaitQuietly(published);
                deltas[0].add(piece);
            };
            run = setup == null ? runner.start(thread, sink) : runner.start(thread, sink, gated(setup, published));
            runId[0] = run.runId();
            deltas[0] = new Deltas(piece -> topics.publish(topic, "delta",
                    Map.of("messageId", replyId, "runId", runId[0], "text", piece)));
            ManagerAgent.Badge badge = runner.badge();
            reply = new MessageRow(replyId, agentId, "assistant", "", at + 1, run.runId(),
                    badge == null ? null : badgeJson(badge), null, null, null, "streaming", null, null);
            try {
                store.addMessages(List.of(user, reply), attachments.isEmpty() ? Map.of()
                        : Map.of(userId, FileNote.toJson(attachments.stream().map(FileNote::of).toList())));
            } catch (SQLException e) {
                run.stop();
                published.countDown();
                throw e;
            }
            runs.put(run.runId(), new ActiveRun(agentId, replyId, run, deltas[0], origin, chain));
        } catch (AgentException e) {
            publishState(agentId);
            throw switch (e.code()) {
                case NO_KEY -> RpcError.of("precondition_failed", "reason", "no_key");
                case BUSY -> RpcError.of("conflict", "reason", "busy");
                case LIMIT_REACHED -> RpcError.of("precondition_failed", "reason", "limit_reached", "scope",
                        e.detail());
                default -> RpcError.of("unavailable", "reason", "unavailable");
            };
        } finally {
            startLock.unlock();
            if (member) {
                // Started, it counts as running until finish takes it out of runs; not started, it never ran.
                releaseGuildRun();
            }
        }
        topics.publish(topic, "message", Map.of("message", view(user)));
        topics.publish(topic, "message", Map.of("message", messageView(reply, "")));
        publishState(agentId);
        published.countDown();
        MessageRow streaming = reply;
        handed[0] = true;
        run.result().whenComplete((result, failure) -> {
            // Processed, failed or stopped: the files go first, before anything else is done with the result.
            discard(attachments);
            finish(run.runId(), streaming, result);
        });
        return new Begun(userId, replyId, run);
    }

    /**
     * The run's tools, each call waiting until the run is in {@link #runs} and its messages are out, as the deltas do: a
     * reply that is only a tool call has no delta to wait on, and its tools look the run up (its reply, its chain).
     */
    private static ManagerAgent.RunSetup gated(ManagerAgent.RunSetup setup, CountDownLatch published) {
        ManagerAgent.Tools tools = setup.tools();
        return setup.withTools(new ManagerAgent.Tools() {
            @Override
            public List<com.minimalistalliance.desk.agent.provider.ToolSpec> specs() {
                return tools.specs();
            }

            @Override
            public com.minimalistalliance.desk.agent.provider.ToolResult call(
                    com.minimalistalliance.desk.agent.provider.ToolCall call, String runId) throws InterruptedException {
                published.await();
                return tools.call(call, runId);
            }

            @Override
            public String chip(com.minimalistalliance.desk.agent.provider.ToolCall call,
                    com.minimalistalliance.desk.agent.provider.ToolResult result) {
                return tools.chip(call, result);
            }
        });
    }

    private void finish(String runId, MessageRow reply, ManagerAgent.RunResult result) {
        ActiveRun active = runs.get(runId);
        if (active != null) {
            active.deltas().close();
        }
        String topic = CONVERSATION_PREFIX + reply.agentId();
        MessageRow done;
        if (result == null) {
            String text = active == null ? "" : active.deltas().text();
            done = new MessageRow(reply.id(), reply.agentId(), "assistant", text, reply.at(), runId, reply.badge(),
                    null, null, null, "failed", "unavailable", "internal");
        } else {
            done = new MessageRow(reply.id(), reply.agentId(), "assistant", result.text(), reply.at(), runId,
                    result.badge() == null ? reply.badge() : badgeJson(result.badge()),
                    result.usage() == null ? null : usageJson(result.usage()), result.costMicroUsd(),
                    result.stopReason(), result.state().wireName(), result.error(), result.errorDetail());
            if (!result.tools().isEmpty()) {
                done = done.withTools(new String(Json.bytes(result.tools()), java.nio.charset.StandardCharsets.UTF_8));
            }
        }
        try {
            store.updateMessage(done);
            if (result != null && result.state() == ManagerAgent.RunState.DONE) {
                store.addUnseen(reply.agentId());
            }
        } catch (SQLException e) {
            log.error("a reply couldn't be saved: {}", e.getClass().getSimpleName());
        }
        runs.remove(runId);
        team.ended(active == null ? null : active.origin(), result);
        Map<String, Object> view = view(done);
        List<Map<String, Object>> proposals = team.proposalViews(List.of(done)).get(done.id());
        if (proposals != null) {
            view.put("proposals", proposals);
        }
        topics.publish(topic, "message", Map.of("message", view));
        publishState(reply.agentId());
    }

    /**
     * Before a member's run starts: the guild's runs at once, and the member's runs a day, as {@code limit_reached} with
     * {@code scope} {@code guild_runs} or {@code member_runs_day}. Holds a place until {@link #releaseGuildRun}.
     */
    private void claimGuildRun(String agentId) throws RpcError, SQLException {
        GuildLimits now = guild;
        if (now.runsPerDay() != null && ledger.runsToday(agentId) >= now.runsPerDay()) {
            throw RpcError.of("precondition_failed", "reason", "limit_reached", "scope", "member_runs_day");
        }
        guildRunsLock.lock();
        try {
            long running = runs.values().stream().filter(active -> Caller.isMemberAgent(active.agentId())).count();
            if (running + memberRunsStarting >= now.runsAtOnce()) {
                throw RpcError.of("precondition_failed", "reason", "limit_reached", "scope", "guild_runs");
            }
            memberRunsStarting++;
        } finally {
            guildRunsLock.unlock();
        }
    }

    private void releaseGuildRun() {
        guildRunsLock.lock();
        try {
            memberRunsStarting--;
        } finally {
            guildRunsLock.unlock();
        }
    }

    /** A run of another caller's agent is as one that doesn't exist: nothing happens. */
    private Map<String, Object> stop(Map<String, Object> p, Caller caller) throws RpcError {
        ActiveRun active = runs.get(string(p, "runId"));
        if (active != null && caller.sees(active.agentId())) {
            active.run().stop();
        }
        return Map.of();
    }

    /**
     * The owner's band is no longer adult (Security T49K-2): every run of the owner's agents already going stops, its
     * reply ending {@code stopped}, as deskd refuses the Agent app and timers and messages start none from here. Under
     * the start lock, so a run being started is either seen here or refused by {@link #begin}'s check. A guild member's
     * own agent goes by that member's flag, so its runs go on.
     */
    private void stopOwnersRuns() {
        startLock.lock();
        try {
            for (ActiveRun active : runs.values()) {
                if (!Caller.isMemberAgent(active.agentId())) {
                    active.run().stop();
                }
            }
        } finally {
            startLock.unlock();
        }
    }

    /** Stops every run: SIGTERM's path. Replies end {@code stopped}. */
    public void stopAll() {
        team.timers().close();
        staging.dropAll();
        runs.values().forEach(active -> active.run().stop());
        for (ActiveRun active : List.copyOf(runs.values())) {
            try {
                active.run().result().get(5, TimeUnit.SECONDS);
            } catch (Exception e) {
                // Best effort on the way out; the store marks it interrupted at the next start.
            }
        }
    }

    // ---------------------------------------------------------------- keys

    private Map<String, Object> keyList() throws SQLException {
        List<Map<String, Object>> list = new ArrayList<>();
        for (KeyRow row : store.keys()) {
            list.add(keyView(row));
        }
        return Map.of("keys", list);
    }

    private Map<String, Object> keyView(KeyRow row) {
        Map<String, Object> key = new LinkedHashMap<>();
        key.put("keyId", row.keyId());
        key.put("provider", row.provider());
        key.put("providerName", providerName(row.provider()));
        key.put("label", row.label());
        key.put("last4", row.last4());
        key.put("createdAt", row.createdAt());
        key.put("createdByDesk", row.createdByDesk());
        key.put("available", keys.providerOf(row.keyId()) != null);
        return key;
    }

    /**
     * {@code agent.key.add}, from deskd's KEY frame: the key's bytes are zeroed before this returns, whatever
     * happens. A key in another provider's shape is refused before anything leaves the desk. It's checked with the
     * provider's free model-list call, then sealed durably, and only then does its row
     * make it the member's (ADR 0042). If it can't be sealed, nothing is kept, in RAM or on disk: RAM only is never a
     * fallback.
     */
    public Map<String, Object> keyAdd(Map<String, Object> p, java.nio.ByteBuffer secret) throws RpcError, SQLException {
        return keyAdd(p, secret, Caller.OWNER);
    }

    /** {@code agent.key.add} for this caller: on a guild desk, the guild's key, which only a manager adds. */
    public Map<String, Object> keyAdd(Map<String, Object> p, java.nio.ByteBuffer secret, Caller caller)
            throws RpcError, SQLException {
        allow("agent.key.add", caller);
        String keyId = "k-" + RunIds.next(clock);
        try {
            ChatProvider provider = providers.get(stringOr(p, "provider", ""));
            if (provider == null) {
                throw RpcError.of("bad_request", "reason", "key_malformed", "detail", "provider");
            }
            // The shape first, as a key in none says nothing of whose it is.
            if (!KeyRing.wellFormed(secret)) {
                throw RpcError.of("bad_request", "reason", "key_malformed", "detail", "format");
            }
            if (belongsToAnother(provider, secret)) {
                throw RpcError.of("bad_request", "reason", "key_malformed", "detail", "provider_mismatch");
            }
            String label = stringOr(p, "label", "").strip();
            if (label.isEmpty()) {
                label = provider.id().displayName();
            }
            if (label.length() > 64 || label.chars().anyMatch(Character::isISOControl)) {
                throw RpcError.badRequest("label");
            }
            String desk = stringOr(p, "deskId", "");
            String createdBy = DESK_ID.matcher(desk).matches() ? desk : "";
            StringBuilder last4 = new StringBuilder();
            for (int i = Math.max(secret.position(), secret.limit() - 4); i < secret.limit(); i++) {
                last4.append((char) (secret.get(i) & 0x7f));
            }
            try {
                keys.put(keyId, provider.id(), secret);
            } catch (IllegalArgumentException e) {
                throw RpcError.of("bad_request", "reason", "key_malformed", "detail", "format");
            } catch (IllegalStateException e) {
                throw RpcError.of("unavailable", "reason", "unavailable");
            }
            List<ModelInfo> listed;
            try (KeyLease lease = keys.lend(keyId)) {
                listed = provider.models(lease);
            } catch (ProviderException e) {
                keys.drop(keyId);
                if (e.kind() == ProviderException.Kind.AUTH) {
                    throw RpcError.of("precondition_failed", "reason", "key_refused", "detail", "auth");
                }
                throw RpcError.of("unavailable", "reason", "unavailable", "detail",
                        e.kind().name().toLowerCase(Locale.ROOT));
            }
            try (KeyLease lease = keys.lend(keyId)) {
                vault.seal(keyId, provider.id().id(), lease.bytes());
            } catch (IOException | RuntimeException e) {
                keys.drop(keyId);
                log.error("a key couldn't be sealed: {}", e.getClass().getSimpleName());
                throw RpcError.of("unavailable", "reason", "storage");
            }
            KeyRow row = new KeyRow(keyId, provider.id().id(), label, last4.toString(), clock.millis(), createdBy);
            try {
                store.addKey(row);
            } catch (SQLException | RuntimeException e) {
                keys.drop(keyId);
                try {
                    vault.delete(keyId);
                } catch (IOException | RuntimeException again) {
                    // It has no row, so the next start removes it as an orphan.
                    log.error("a sealed key with no row wasn't removed: {}", again.getClass().getSimpleName());
                }
                throw e;
            }
            models.put(keyId, new CachedModels(listed, clock.millis()));
            publishState();
            return Map.of("key", keyView(row));
        } finally {
            for (int i = secret.position(); i < secret.limit(); i++) {
                secret.put(i, (byte) 0);
            }
        }
    }

    /**
     * Whether the key starts with another known provider's prefix rather than the chosen one's, so it would go to the
     * wrong provider's API in the check that follows. The longest prefix that matches says whose it is: {@code sk-ant-} is
     * Anthropic's, though it starts with OpenAI's {@code sk-}. A key with no known prefix is left to the provider's check.
     * Only the key's first bytes are read, in place.
     */
    private boolean belongsToAnother(ChatProvider chosen, java.nio.ByteBuffer secret) {
        int longest = 0;
        boolean chosenHasIt = false;
        for (ChatProvider provider : providers.all()) {
            String prefix = provider.info().keyPrefix();
            if (prefix == null || prefix.isEmpty() || !startsWith(secret, prefix)) {
                continue;
            }
            if (prefix.length() > longest) {
                longest = prefix.length();
                chosenHasIt = false;
            }
            if (prefix.length() == longest && provider.id().equals(chosen.id())) {
                chosenHasIt = true;
            }
        }
        return longest > 0 && !chosenHasIt;
    }

    private static boolean startsWith(java.nio.ByteBuffer secret, String prefix) {
        if (secret.remaining() < prefix.length()) {
            return false;
        }
        for (int i = 0; i < prefix.length(); i++) {
            if (secret.get(secret.position() + i) != (byte) prefix.charAt(i)) {
                return false;
            }
        }
        return true;
    }

    /**
     * The row first, which is the commit point and unbinds its agents, then the key in RAM, then its sealed file, and
     * only then the answer. If the file can't be unlinked the answer is {@code unavailable}, as it may still be on
     * disk: the same call finishes the job, or the next start does, as a file with no row is an orphan.
     */
    private Map<String, Object> keyDelete(Map<String, Object> p) throws RpcError, SQLException {
        String keyId = string(p, "keyId");
        if (store.key(keyId) != null) {
            List<String> unbound = store.deleteKey(keyId);
            for (String agentId : unbound) {
                ManagerAgent runner = runnerOf(agentId);
                if (runner != null) {
                    runner.unbind();
                }
            }
            if (!keys.drop(keyId)) {
                recordDeletedUnheld(keyId);
            }
            models.remove(keyId);
            publishState();
        } else if (!vault.holds(keyId)) {
            throw RpcError.notFound("key");
        }
        try {
            vault.delete(keyId);
        } catch (IOException | RuntimeException e) {
            log.error("a deleted key's file wasn't removed: {}", e.getClass().getSimpleName());
            throw RpcError.of("unavailable", "reason", "storage");
        }
        return Map.of();
    }

    /** An unavailable key isn't in the ring, so the ring records nothing. Its delete is the member's all the same. */
    private void recordDeletedUnheld(String keyId) {
        try {
            audit.append(AuditLog.Entry.of("user", "key.drop", "key:" + keyId, "not_held"));
        } catch (SQLException | RuntimeException e) {
            log.warn("a key drop wasn't recorded: {}", e.getClass().getSimpleName());
        }
    }

    private Map<String, Object> keyModels(Map<String, Object> p) throws RpcError, SQLException {
        String keyId = string(p, "keyId");
        KeyRow row = store.key(keyId);
        if (row == null) {
            throw RpcError.notFound("key");
        }
        ChatProvider provider = providers.get(row.provider());
        if (provider == null) {
            throw RpcError.of("unavailable", "reason", "unavailable", "detail", "no_provider");
        }
        CachedModels cached = models.get(keyId);
        if (cached == null || clock.millis() - cached.fetchedAt() > MODELS_FRESH.toMillis()) {
            try (KeyLease lease = keys.lend(keyId)) {
                if (lease == null) {
                    throw RpcError.of("precondition_failed", "reason", "no_key");
                }
                cached = new CachedModels(provider.models(lease), clock.millis());
            } catch (ProviderException e) {
                if (e.kind() == ProviderException.Kind.AUTH) {
                    throw RpcError.of("precondition_failed", "reason", "key_refused", "detail", "auth");
                }
                throw RpcError.of("unavailable", "reason", "unavailable", "detail",
                        e.kind().name().toLowerCase(Locale.ROOT));
            }
            models.put(keyId, cached);
        }
        List<Map<String, Object>> list = new ArrayList<>();
        for (ModelInfo model : cached.models()) {
            // Listed only, so a client can say a model has none, though its calls count at chargedPrice.
            Pricing.Price price = prices.current().price(provider.id(), model.id());
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", model.id());
            m.put("label", model.label());
            m.put("inputMicroUsdPerMTok", price == null ? null : price.input());
            m.put("outputMicroUsdPerMTok", price == null ? null : price.output());
            list.add(m);
        }
        return Map.of("models", list);
    }

    // ---------------------------------------------------------------- limits and audit

    private Map<String, Object> limitsView(String agentId) throws RpcError, SQLException {
        return limitsView(agentId, Caller.OWNER);
    }

    /** A member's agent shows the guild's limits on it, which are what bind it. */
    private Map<String, Object> limitsView(String agentId, Caller caller) throws RpcError, SQLException {
        AgentRow row = row(agentId);
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("agentId", agentId);
        view.put("policy", policyJson(Caller.isMemberAgent(agentId) ? memberPolicy() : limits.policyFor(agentId)));
        List<Map<String, Object>> usage = new ArrayList<>();
        for (UsageLedger.ScopeUsage scope : ledger.usage(agentId, row.keyId())) {
            Map<String, Object> u = new LinkedHashMap<>();
            u.put("scope", scope.scope().wireName());
            u.put("spentMicroUsd", scope.spent().microUsd());
            u.put("spentTokens", scope.spent().tokens());
            u.put("resetsAt", scope.resetsAt() == null ? null : scope.resetsAt().toEpochMilli());
            usage.add(u);
        }
        view.put("usage", usage);
        view.put("timeZone", limits.timeZone());
        view.put("pricesAsOf", prices.current().checked());
        view.put("desk", limits.desk().own().toMap());
        view.put("account", limits.account().toMap());
        return view;
    }

    /**
     * {@code {agentId, policy?, timeZone?}}. Absent changes nothing. In a policy, {@code deskDay} and {@code deskMonth}
     * can be absent (keep this desk's), null (clear it, to follow the account) or a {@link Limit}, where both caps null
     * is "no limit, set on this desk". {@code timeZone} is absent, null or a name. Every other field of a policy is
     * required, as it always was. Nothing changes unless all of it is good.
     */
    private Map<String, Object> limitsSet(Map<String, Object> p, Caller caller) throws RpcError, SQLException {
        String agentId = agentId(p);
        row(agentId, caller);
        Map<String, Object> policy = p.containsKey("policy") ? policyMap(p.get("policy")) : null;
        boolean zoneGiven = p.containsKey("timeZone");
        if (policy == null && !zoneGiven) {
            return limitsView(agentId);
        }
        LimitSettings.AgentLimits agent = policy == null ? null : agentLimits(policy);
        Limit keyMonth = policy == null ? null : limit(policy, "keyMonth");
        String zone = zoneGiven ? zone(p.get("timeZone")) : null;
        limitsLock.lock();
        try {
            LimitSettings.DeskLimits desk = limits.desk();
            LimitSettings.Layer own = desk.own();
            LimitSettings.DeskLimits next = new LimitSettings.DeskLimits(
                    new LimitSettings.Layer(
                            policy == null ? own.deskDay() : layered(policy, "deskDay", own.deskDay()),
                            policy == null ? own.deskMonth() : layered(policy, "deskMonth", own.deskMonth()),
                            zoneGiven ? zone : own.timeZone()),
                    policy == null ? desk.keyMonth() : keyMonth);
            store.setSetting("limits.desk", next.toJson(limits.deskMonthWith(next)));
            if (agent != null) {
                store.setLimits(agentId, agent.toJson());
                limits.setAgent(agentId, agent);
            }
            limits.setDesk(next);
        } finally {
            limitsLock.unlock();
        }
        // A zone alone is the app setting the browser's zone on its own, which Activity words apart from a member's change.
        String action = policy == null ? "limits.timezone" : "limits.set";
        audit.append(AuditLog.Entry.of(caller.isMember() ? "member" : "user", action, "agent:" + agentId, "ok"));
        return limitsView(agentId, caller);
    }

    /** {@code {table}}: the Platform's price table as text, so nothing in it can break this frame. A bad one is ignored. */
    private Map<String, Object> pricesSet(Map<String, Object> p) {
        boolean applied = p.get("table") instanceof String table && prices.apply(table.getBytes(StandardCharsets.UTF_8));
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("applied", applied);
        answer.put("pricesAsOf", prices.current().checked());
        return answer;
    }

    /**
     * {@code {deskDay, deskMonth, timeZone}}: what the account has set, as the config last said. A value that can't be
     * used counts as not set, with one log line and none of the value: a bad table or default never stops an agent.
     */
    private Map<String, Object> accountSet(Map<String, Object> p) {
        LimitSettings.Layer account = new LimitSettings.Layer(
                accountLimit(p, "deskDay"), accountLimit(p, "deskMonth"), accountZone(p.get("timeZone")));
        if (limits.setAccount(account)) {
            log.info("the account's default limits changed");
        }
        // Either one absent (or a tier that's null) is deskd having none to send: the last stands.
        boolean tier = team.setTier(p.get("tier"));
        boolean band = team.setBand(p.get("band"));
        if (tier) {
            log.info("the tier's agent settings changed");
        }
        if (band) {
            log.info("the owner's age band changed");
            if (!team.adult()) {
                stopOwnersRuns();
            }
        }
        if (tier || band) {
            publishState();
        }
        return Map.of();
    }

    /** deskd's {@code desk.guild.set}: the guild's limits on members' agents, from its settings. A bad one changes nothing. */
    private Map<String, Object> guildSet(Map<String, Object> p) throws RpcError {
        GuildLimits next = GuildLimits.parse(p);
        if (!next.equals(guild)) {
            guild = next;
            log.info("the guild's agent limits changed");
        }
        return Map.of();
    }

    /**
     * {@code agent.guild.usage}, which deskd serves as {@code guild.usage.get} to the Founder and Officers: each member's
     * runs and spend today and this month, in the desk's zone. Counts only, never a thread (draft decision 6).
     */
    private Map<String, Object> guildUsage() throws SQLException {
        List<Map<String, UsageLedger.AgentPeriod>> periods = ledger.byAgent();
        List<Map<String, Object>> members = new ArrayList<>();
        for (AgentRow row : store.agents()) {
            if (!Caller.isMemberAgent(row.id())) {
                continue;
            }
            Map<String, Object> member = new LinkedHashMap<>();
            member.put("memberId", row.id());
            member.put("today", periodJson(periods.get(0).get(row.id())));
            member.put("month", periodJson(periods.get(1).get(row.id())));
            members.add(member);
        }
        Map<String, Object> usage = new LinkedHashMap<>();
        usage.put("members", members);
        usage.put("timeZone", limits.timeZone());
        return usage;
    }

    private static Map<String, Object> periodJson(UsageLedger.AgentPeriod period) {
        long runs = period == null ? 0 : period.runs();
        long micro = period == null ? 0 : period.microUsd();
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("runs", runs);
        json.put("microUsd", micro);
        json.put("usd", micro / 1_000_000.0);
        return json;
    }

    private static Limit accountLimit(Map<String, Object> p, String name) {
        if (p.get(name) == null) {
            return null;
        }
        try {
            return limit(p, name);
        } catch (RpcError e) {
            log.warn("an account default was ignored: {} can't be used", name);
            return null;
        }
    }

    private static String accountZone(Object value) {
        try {
            return zone(value);
        } catch (RpcError e) {
            log.warn("an account default was ignored: timeZone can't be used");
            return null;
        }
    }

    private Map<String, Object> auditList(Map<String, Object> p) throws RpcError, SQLException {
        Long before = p.get("beforeSeq") instanceof Number n ? n.longValue() : null;
        int limit = p.get("limit") instanceof Number n ? (int) Math.max(1, Math.min(200, n.longValue())) : 50;
        List<AuditLog.Row> rows = audit.readBefore(before, limit + 1);
        boolean more = rows.size() > limit;
        List<Map<String, Object>> entries = new ArrayList<>();
        for (AuditLog.Row row : rows.subList(0, Math.min(limit, rows.size()))) {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("seq", row.seq());
            e.put("atMs", row.atMillis());
            e.put("actor", row.entry().actor());
            e.put("action", row.entry().action());
            e.put("target", row.entry().target());
            byte[] payload = row.entry().payloadSha256();
            e.put("payloadSha256", payload == null ? null : HexFormat.of().formatHex(payload));
            e.put("decision", row.entry().decision());
            e.put("costMicroUsd", row.entry().costMicroUsd());
            e.put("hash", row.hashHex());
            entries.add(e);
        }
        byte[] head = audit.head();
        Map<String, Object> page = new LinkedHashMap<>();
        page.put("entries", entries);
        page.put("headHash", head == null ? "" : HexFormat.of().formatHex(head));
        page.put("nextBeforeSeq", more ? entries.getLast().get("seq") : null);
        return page;
    }

    // ---------------------------------------------------------------- topics

    /** The {@code agent.state} snapshot: the owner's. */
    public Map<String, Object> stateSnapshot() {
        return stateSnapshot(Caller.OWNER);
    }

    /** The {@code agent.state} snapshot as this caller sees it. */
    public Map<String, Object> stateSnapshot(Caller caller) {
        try {
            return Map.of("agents", agents(caller, false), "caps", team.capsView());
        } catch (SQLException e) {
            return Map.of("agents", List.of());
        }
    }

    /** @return whether a topic name is one of ours, for an agent that exists */
    public boolean knows(String topic) {
        return knows(topic, Caller.OWNER);
    }

    /** The same, for this caller: a conversation of an agent they don't see is unknown; the system has only the state. */
    public boolean knows(String topic, Caller caller) {
        if (topic.equals(STATE_TOPIC)) {
            return true;
        }
        if (!topic.startsWith(CONVERSATION_PREFIX) || caller.isSystem() || (caller.isMember() && caller.teen())) {
            return false;
        }
        String agentId = topic.substring(CONVERSATION_PREFIX.length());
        try {
            return caller.sees(agentId) && store.agent(agentId) != null;
        } catch (SQLException e) {
            return false;
        }
    }

    /**
     * Where a subscription is kept in {@link TopicHub}: a conversation under its own name, as one agent has one viewer,
     * and the state once per view, the owner's under its own name, the system's and each member's apart.
     */
    public static String hubTopic(String topic, Caller caller) {
        if (!topic.equals(STATE_TOPIC) || caller.isOwner()) {
            return topic;
        }
        return STATE_TOPIC + VIEW + (caller.isSystem() ? ALL : caller.memberId());
    }

    private static final char VIEW = '\0';
    private static final String ALL = "*";

    public java.util.function.Supplier<Map<String, Object>> snapshotFor(String topic) {
        return snapshotFor(topic, Caller.OWNER);
    }

    public java.util.function.Supplier<Map<String, Object>> snapshotFor(String topic, Caller caller) {
        return topic.equals(STATE_TOPIC)
                ? () -> stateSnapshot(caller)
                : () -> conversationSnapshot(topic.substring(CONVERSATION_PREFIX.length()));
    }

    /** Publishes every view of the agents' snapshot that has a subscriber: after a change that may touch any agent. */
    public void publishState() {
        topics.publish(STATE_TOPIC, "snapshot", stateSnapshot());
        for (String name : topics.subscribed(STATE_TOPIC + VIEW)) {
            topics.publish(name, "snapshot", stateSnapshot(viewOf(name)));
        }
    }

    /** Publishes the views that show this agent: its owner's, or its member's, and the system's. */
    private void publishState(String agentId) {
        Caller owner = Caller.isMemberAgent(agentId)
                ? new Caller(Caller.MEMBER_KIND, agentId, null, List.of(), false)
                : Caller.OWNER;
        topics.publish(hubTopic(STATE_TOPIC, owner), "snapshot", stateSnapshot(owner));
        topics.publish(hubTopic(STATE_TOPIC, Caller.SYSTEM), "snapshot", stateSnapshot(Caller.SYSTEM));
    }

    private static Caller viewOf(String hubTopic) {
        String view = hubTopic.substring(STATE_TOPIC.length() + 1);
        return view.equals(ALL) ? Caller.SYSTEM : new Caller(Caller.MEMBER_KIND, view, null, List.of(), false);
    }

    // ---------------------------------------------------------------- the team's way back in

    /** What {@link Team} calls: runs it starts, and what it changed. */
    private final class TeamHost implements Team.Host {

        @Override
        public Team.Started start(String agentId, String text, Map<String, Object> origin, Team.Chain chain)
                throws RpcError, SQLException {
            if (store.agent(agentId) == null || Caller.isMemberAgent(agentId)) {
                throw RpcError.notFound("agent");
            }
            Begun begun = startRun(agentId, text, origin, chain);
            return new Team.Started(begun.run().runId(), begun.replyId(), begun.run().result(), begun.run()::stop);
        }

        @Override
        public Team.RunInfo run(String runId) {
            ActiveRun active = runs.get(runId);
            return active == null ? null
                    : new Team.RunInfo(active.agentId(), active.replyId(), active.chain(), active.origin());
        }

        @Override
        public boolean running(String agentId) {
            return runs.values().stream().anyMatch(active -> active.agentId().equals(agentId));
        }

        @Override
        public void added(String agentId) {
            runnerOf(agentId);
        }

        @Override
        public void removed(String agentId) {
            runtimes.remove(agentId);
            limits.removeAgent(agentId);
        }

        @Override
        public void bind(String agentId, String keyId, String model) throws RpcError, SQLException {
            AgentService.this.bind(Map.of("agentId", agentId, "keyId", keyId, "model", model), Caller.OWNER);
        }

        @Override
        public void republish(String agentId, String messageId) {
            try {
                MessageRow row = team.teamStore().message(messageId);
                if (row == null) {
                    return;
                }
                Map<String, Object> view = view(row);
                List<Map<String, Object>> proposals = team.proposalViews(List.of(row)).get(row.id());
                if (proposals != null) {
                    view.put("proposals", proposals);
                }
                topics.publish(CONVERSATION_PREFIX + agentId, "message", Map.of("message", view));
            } catch (SQLException e) {
                log.warn("a message wasn't republished: {}", e.getClass().getSimpleName());
            }
        }

        @Override
        public void publishState() {
            AgentService.this.publishState();
        }

        @Override
        public List<String> knownModels(String keyId) {
            CachedModels cached = models.get(keyId);
            if (cached == null || clock.millis() - cached.fetchedAt() > MODELS_FRESH.toMillis()) {
                // The lead's proposals check a model against these (task 49, AI M6), so they're listed when stale.
                try {
                    keyModels(Map.of("keyId", keyId));
                } catch (RpcError | SQLException | RuntimeException e) {
                    log.debug("a key's models couldn't be listed: {}", e.getClass().getSimpleName());
                }
                cached = models.get(keyId);
            }
            if (cached == null) {
                return List.of();
            }
            List<String> ids = new ArrayList<>();
            for (ModelInfo model : cached.models()) {
                ids.add(model.id());
            }
            return ids;
        }
    }

    // ---------------------------------------------------------------- helpers

    private AgentRow row(String agentId) throws RpcError, SQLException {
        AgentRow row = store.agent(agentId);
        if (row == null) {
            throw RpcError.notFound("agent");
        }
        return row;
    }

    /** The agent, if this caller sees it: another's is {@code not_found}, as one that doesn't exist. A member's own is made. */
    private AgentRow row(String agentId, Caller caller) throws RpcError, SQLException {
        if (!caller.sees(agentId)) {
            throw RpcError.notFound("agent");
        }
        if (caller.isMember()) {
            ensureMemberAgent(caller.memberId());
        }
        return row(agentId);
    }

    private ManagerAgent.Binding binding(AgentRow row) {
        return new ManagerAgent.Binding(row.keyId(), providerId(row.provider()), row.model(), MAX_OUTPUT_TOKENS);
    }

    private ProviderId providerId(String id) {
        ChatProvider provider = providers.get(id);
        return provider == null ? new ProviderId(id, id) : provider.id();
    }

    private String providerName(String id) {
        ChatProvider provider = id == null ? null : providers.get(id);
        return provider == null ? id : provider.id().displayName();
    }

    private static String badgeJson(ManagerAgent.Badge badge) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("provider", badge.provider());
        b.put("providerName", badge.providerName());
        b.put("model", badge.model());
        return new String(Json.bytes(b), StandardCharsets.UTF_8);
    }

    private static String usageJson(Usage usage) {
        Map<String, Object> u = new LinkedHashMap<>();
        u.put("inputTokens", usage.inputTokens());
        u.put("cachedInputTokens", usage.cachedInputTokens());
        u.put("cacheWriteTokens", usage.cacheWriteTokens());
        u.put("outputTokens", usage.outputTokens());
        u.put("reasoningTokens", usage.reasoningTokens());
        return new String(Json.bytes(u), StandardCharsets.UTF_8);
    }

    private static List<Object> parseList(String json) {
        Object list = parse("{\"v\":" + json + "}").get("v");
        return list instanceof List<?> l ? new ArrayList<>(l) : List.of();
    }

    private static Map<String, Object> parse(String json) {
        try {
            return Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            return null;
        }
    }

    static Map<String, Object> policyJson(LimitPolicy policy) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("agentDay", limitJson(policy.agentDay()));
        p.put("agentWeek", limitJson(policy.agentWeek()));
        p.put("agentMonth", limitJson(policy.agentMonth()));
        p.put("deskDay", limitJson(policy.deskDay()));
        p.put("deskMonth", limitJson(policy.deskMonth()));
        p.put("keyMonth", limitJson(policy.keyMonth()));
        p.put("run", limitJson(policy.run()));
        p.put("runMaxSteps", policy.runMaxSteps());
        return p;
    }

    private static Map<String, Object> limitJson(Limit limit) {
        Map<String, Object> l = new LinkedHashMap<>();
        l.put("maxMicroUsd", limit.maxMicroUsd());
        l.put("maxTokens", limit.maxTokens());
        return l;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> policyMap(Object value) throws RpcError {
        if (!(value instanceof Map<?, ?> raw)) {
            throw RpcError.badRequest("policy");
        }
        return (Map<String, Object>) raw;
    }

    private static LimitSettings.AgentLimits agentLimits(Map<String, Object> p) throws RpcError {
        if (!(p.get("runMaxSteps") instanceof Number steps) || steps.longValue() < 1 || steps.longValue() > 1000) {
            throw RpcError.badRequest("runMaxSteps");
        }
        return new LimitSettings.AgentLimits(limit(p, "agentDay"), limit(p, "agentWeek"), limit(p, "agentMonth"),
                limit(p, "run"), steps.intValue());
    }

    /** Absent keeps {@code current}, null clears it, and a {@link Limit} sets it. */
    private static Limit layered(Map<String, Object> p, String name, Limit current) throws RpcError {
        if (!p.containsKey(name)) {
            return current;
        }
        return p.get(name) == null ? null : limit(p, name);
    }

    /** Null, or a name {@link LimitSettings#knownZone} takes. */
    private static String zone(Object value) throws RpcError {
        if (value == null) {
            return null;
        }
        if (value instanceof String name && LimitSettings.knownZone(name)) {
            return name;
        }
        throw RpcError.of("bad_request", "reason", "time_zone");
    }

    private static Limit limit(Map<String, Object> p, String name) throws RpcError {
        if (!(p.get(name) instanceof Map<?, ?> l)) {
            throw RpcError.badRequest(name);
        }
        return new Limit(amount(l.get("maxMicroUsd"), name), amount(l.get("maxTokens"), name));
    }

    private static Long amount(Object value, String name) throws RpcError {
        if (value == null) {
            return null;
        }
        if (!(value instanceof Number n) || n.longValue() < 0 || n.doubleValue() != n.longValue()) {
            throw RpcError.badRequest(name);
        }
        return n.longValue();
    }

    private static String agentId(Map<String, Object> p) throws RpcError {
        return string(p, "agentId");
    }

    private static String string(Map<String, Object> p, String key) throws RpcError {
        if (!(p.get(key) instanceof String value) || value.length() > MAX_TEXT) {
            throw RpcError.badRequest(key);
        }
        return value;
    }

    private static String stringOr(Map<String, Object> p, String key, String fallback) {
        return p.get(key) instanceof String value ? value : fallback;
    }

    private static boolean bool(Map<String, Object> p, String key) throws RpcError {
        if (!(p.get(key) instanceof Boolean value)) {
            throw RpcError.badRequest(key);
        }
        return value;
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
