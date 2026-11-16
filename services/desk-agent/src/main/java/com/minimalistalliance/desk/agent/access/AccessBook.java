package com.minimalistalliance.desk.agent.access;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.team.Canonical;
import com.minimalistalliance.desk.agent.team.TextChecks;
import com.minimalistalliance.desk.agent.tool.ToolAccess;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Each agent's access: what the member chose on its setup screen and in its settings (draft ADR "the Agent's tools and
 * approvals", sections 14 to 16), kept in {@code agent.db} ({@code store.AccessSchema}) and checked at every run's start,
 * every step and every call.
 *
 * <ul>
 *   <li><b>The setup gate.</b> No run of an agent starts until the member has saved its screen ({@link #requireChosen},
 *       {@code precondition_failed} with {@code reason: setup}): a new agent, one a lead's proposal made, and one made
 *       before the screen existed alike. A timer's or another agent's run is refused the same way.
 *   <li><b>Only the member.</b> {@code agent.access.set} and {@code agent.desks.revoke} come only from the member's own
 *       session (deskd relays them only from an owner token with input, or a guild member's for their own agent). No
 *       proposal, timer, message, tool or model can reach them: nothing else in desk-agent writes these rows.
 *   <li><b>Revocable at once.</b> An app switched off takes its tools away from the very next step of a run already
 *       going, and a call to one is refused {@code scope} ({@link #allows}). A desk switched off revokes its grant.
 *   <li><b>Audited.</b> {@code access.set} (which apps and switches changed; never a place or a desk's name),
 *       {@code desks.offer}, {@code desks.revoke}, {@code access.tampered} and {@code access.confirm}.
 *   <li><b>Fails closed.</b> A row whose hash doesn't match, or that doesn't parse, is nothing chosen: the agent waits
 *       for its screen again ({@code setup: "confirm"}), once audited. A grant row that doesn't match is no grant.
 *       deskd keeps its own copy of every choice and refuses what it doesn't hold, so desk-agent's word is never
 *       enough; when deskd says it holds none for an agent ({@link #deskdHasNoRecord}, its hello), the agent waits for
 *       the member to confirm again. That only ever takes access away.
 * </ul>
 *
 * <p>The row's hash is an integrity check against a partial or hand edit and a corrupt read, not a secret: anything that
 * can write {@code agent.db} as desk-agent can recompute it. The boundary is deskd's own record (draft ADR section 15,
 * "Checked twice"), which desk-agent's user can't write.
 */
public final class AccessBook implements ToolAccess {

    private static final Logger log = LoggerFactory.getLogger(AccessBook.class);

    /** A Notebook tab's id, as desk-notebook makes them. */
    static final Pattern TAB_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    /** A desk's id, as the Platform makes them. */
    static final Pattern DESK_ID = Pattern.compile("[a-z0-9-]{1,64}");
    static final int MAX_DESKS = 20;
    static final int MAX_DESK_NAME = 60;
    static final int MAX_FOLDER = 1024;
    private static final char[] BASE32 = "abcdefghijklmnopqrstuvwxyz234567".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Set<String> SET_KEYS = Set.of("agentId", "apps", "auto", "desks");
    private static final Set<String> AUTO_KEYS = Set.of("notebook", "files", "todos");
    /** The states of a send half the member hasn't revoked. */
    static final Set<String> LIVE = Set.of("offered", "active");

    /** One send half (section 14), as stored. */
    public record SendHalf(String grantId, String agentId, String toDeskId, String toDeskName, String toKey,
            String state, long createdAt, Long lastUsedAt, int count) {

        public Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("grantId", grantId);
            out.put("agentId", agentId);
            out.put("toDeskId", toDeskId);
            out.put("toDeskName", toDeskName);
            out.put("toKey", toKey);
            out.put("state", state);
            out.put("createdAt", createdAt);
            out.put("lastUsedAt", lastUsedAt);
            out.put("count", count);
            return out;
        }

        /** No ids or names in logs. */
        @Override
        public String toString() {
            return "SendHalf[" + state + "]";
        }
    }

    private final AgentStore store;
    private final AuditLog audit;
    private final Clock clock;
    /** One change at a time: each reads the row, changes it and writes it. */
    private final ReentrantLock writes = new ReentrantLock();
    /** Each agent's access as last read or written; a write replaces it, a delete drops it. */
    private final Map<String, AgentAccess> cache = new ConcurrentHashMap<>();
    /** Agents whose unreadable row has been audited in this process, so it's one row, not one per read. */
    private final Set<String> reported = ConcurrentHashMap.newKeySet();
    private volatile Consumer<String> changed = agentId -> {};
    /** Messages between the member's desks (section 14): the halves this agent answers and the offers waiting here. */
    private volatile java.util.function.Function<String, List<Map<String, Object>>> incoming = agentId -> List.of();
    /** A send half's answering agent on the other desk, once its accept came: {@code [agentId, name]} or null. */
    private volatile java.util.function.Function<String, String[]> peers = grantId -> null;

    public AccessBook(AgentStore store, AuditLog audit, Clock clock) {
        this.store = Objects.requireNonNull(store);
        this.audit = Objects.requireNonNull(audit);
        this.clock = Objects.requireNonNull(clock);
    }

    /**
     * Messages between the member's desks (section 14): where {@code incoming} and a send half's {@code toAgentName}
     * come from, the {@code desks} package's rows.
     */
    public void desks(java.util.function.Function<String, List<Map<String, Object>>> incomingOf,
            java.util.function.Function<String, String[]> peerOf) {
        this.incoming = incomingOf == null ? agentId -> List.of() : incomingOf;
        this.peers = peerOf == null ? grantId -> null : peerOf;
    }

    /** Called after an agent's access changed, to republish its state. Must not block. */
    public void onChange(Consumer<String> listener) {
        this.changed = listener == null ? agentId -> {} : listener;
    }

    // ---------------------------------------------------------------- reads

    /** The agent's access now. A row that doesn't read back whole is nothing chosen. */
    public AgentAccess of(String agentId) throws SQLException {
        AgentAccess known = cache.get(agentId);
        if (known != null) {
            return known;
        }
        AgentAccess read = read(agentId);
        cache.put(agentId, read);
        return read;
    }

    /** Whether the member has set the agent up. Any failure to read says no. */
    public boolean chosen(String agentId) {
        try {
            return of(agentId).chosen();
        } catch (SQLException | RuntimeException e) {
            log.warn("an agent's access couldn't be read, so it's not set up: {}", e.getClass().getSimpleName());
            return false;
        }
    }

    /** Before any run of the agent starts: {@code precondition_failed} with {@code reason: setup} until it's set up. */
    public void requireChosen(String agentId) throws RpcError {
        if (!chosen(agentId)) {
            throw RpcError.of("precondition_failed", "reason", "setup");
        }
    }

    @Override
    public boolean allows(String agentId, String tool) {
        String app = AgentAccess.appOf(tool);
        try {
            AgentAccess access = of(agentId);
            if ("desk_message".equals(tool)) {
                return access.chosen() && !activeGrants(agentId).isEmpty();
            }
            return app == null || access.allows(app);
        } catch (SQLException | RuntimeException e) {
            log.warn("an agent's access couldn't be read, so its tool is refused: {}", e.getClass().getSimpleName());
            return app == null && !"desk_message".equals(tool);
        }
    }

    /**
     * The seam for the approvals core's per-agent policy, exactly its {@code ApprovalPolicy.perAgent(switchedOn, lowRisk)}
     * argument: the groups ({@code notebook}, {@code files}, {@code todos}) the member switched on for the agent, read at
     * call time, so a switch turned off reaches a run already going. Empty for an agent not set up, one waiting for the
     * member to confirm, a record that doesn't verify, or anything that can't be read. The switch's place is in
     * {@link #auto}.
     */
    public Set<String> switchedOn(String agentId) {
        try {
            AgentAccess access = of(agentId);
            if (!access.chosen()) {
                return Set.of();
            }
            AgentAccess.Auto auto = access.auto();
            Set<String> on = new HashSet<>();
            if (auto.notebookTab() != null && access.allows("notebook")) {
                on.add("notebook");
            }
            if (auto.filesFolder() != null && access.allows("files")) {
                on.add("files");
            }
            if (auto.todos() && access.allows("todos")) {
                on.add("todos");
            }
            return Set.copyOf(on);
        } catch (SQLException | RuntimeException e) {
            return Set.of();
        }
    }

    /**
     * The approvals gate's per-agent policy and its rows ({@code ApprovalPolicy.perAgentWithPlaces}): the groups on, as
     * {@link #switchedOn}, with each one's place, the Notebook tab and the Files folder. All off on a Guild Desk, where
     * nothing is done without asking (the draft ADR's §15 rule 8, Security's AAW-L3), and for anything that can't be read.
     */
    public com.minimalistalliance.desk.agent.approval.LowRisk.Switches switches(String agentId) {
        if (guildDesk) {
            return com.minimalistalliance.desk.agent.approval.LowRisk.Switches.OFF;
        }
        Set<String> on = switchedOn(agentId);
        if (on.isEmpty()) {
            return com.minimalistalliance.desk.agent.approval.LowRisk.Switches.OFF;
        }
        try {
            AgentAccess.Auto auto = of(agentId).auto();
            return new com.minimalistalliance.desk.agent.approval.LowRisk.Switches(on,
                    on.contains("notebook") ? auto.notebookTab() : null, on.contains("files") ? auto.filesFolder() : null);
        } catch (SQLException | RuntimeException e) {
            return com.minimalistalliance.desk.agent.approval.LowRisk.Switches.OFF;
        }
    }

    /** Whether this desk is a Guild Desk, as deskd's hello or its guild settings say: no switch acts there. */
    private volatile boolean guildDesk;

    /** Whether deskd has said this is a Guild Desk. */
    public boolean isGuildDesk() {
        return guildDesk;
    }

    /** deskd says this is a Guild Desk (its hello, or its guild settings). Only ever turns switches off. */
    public void guildDesk(boolean guild) {
        if (guild) {
            this.guildDesk = true;
        }
    }

    /** The agent's "without asking" switches; all off for one not set up. */
    public AgentAccess.Auto auto(String agentId) throws SQLException {
        AgentAccess access = of(agentId);
        return access.chosen() ? access.auto() : AgentAccess.Auto.OFF;
    }

    /** The agent's send halves the member hasn't revoked, offered or active (section 14). */
    public List<SendHalf> liveGrants(String agentId) throws SQLException {
        AgentAccess access = of(agentId);
        List<SendHalf> out = new ArrayList<>();
        for (SendHalf half : halves(agentId)) {
            if (LIVE.contains(half.state()) && access.desks().contains(half.toDeskId())) {
                out.add(half);
            }
        }
        return out;
    }

    /** Those of them the other desk has allowed: what {@code desk_message} may use. */
    public List<SendHalf> activeGrants(String agentId) throws SQLException {
        if (!of(agentId).chosen()) {
            return List.of();
        }
        return liveGrants(agentId).stream().filter(half -> "active".equals(half.state())).toList();
    }

    /** {@code agent.access.get}: {@code {access}}. */
    public Map<String, Object> get(String agentId) throws SQLException {
        return Map.of("access", view(agentId));
    }

    private Map<String, Object> view(String agentId) throws SQLException {
        List<Map<String, Object>> halves = new ArrayList<>();
        for (SendHalf half : liveGrants(agentId)) {
            Map<String, Object> json = half.toJson();
            String[] peer = "active".equals(half.state()) ? peers.apply(half.grantId()) : null;
            json.put("toAgentName", peer == null ? null : peer[1]);
            halves.add(json);
        }
        // The answer halves this agent answers and the offers waiting here, from messages between desks (section 14).
        return of(agentId).toJson(halves, Caller.isMemberAgent(agentId) ? List.of() : incoming.apply(agentId));
    }

    // ---------------------------------------------------------------- the member's changes

    /**
     * {@code agent.access.set {agentId, apps?, auto?, desks?}} from the member's own session (deskd relays it only from
     * one that may act). The first save needs every app and every switch, as the screen sends them; later ones change
     * only what they name. An app switched off takes its switch with it; a switch can't be on for an app that's off.
     *
     * @param guildMember a guild member's own agent, which may have only what a Guild Desk gives it: Notebook
     * @return {@code {access}}, as it is now
     */
    public Map<String, Object> set(String agentId, Map<String, Object> p, Caller caller, boolean guildMember)
            throws RpcError, SQLException {
        for (String key : p.keySet()) {
            if (!SET_KEYS.contains(key)) {
                throw RpcError.badRequest(key);
            }
        }
        writes.lock();
        try {
            AgentAccess before = of(agentId);
            boolean first = !before.chosen();
            Object rawApps = p.get("apps");
            Object rawAuto = p.get("auto");
            if (first && rawApps == null) {
                throw RpcError.of("bad_request", "detail", "apps", "reason", "required");
            }
            if (first && rawAuto == null) {
                throw RpcError.of("bad_request", "detail", "auto", "reason", "required");
            }
            AgentAccess.Apps apps = apps(rawApps, before.apps(), first, guildMember);
            AgentAccess.Auto auto = auto(rawAuto, before.auto(), first, guildMember, apps);
            List<DeskChange> deskChanges = desks(p.get("desks"), guildMember);
            List<String> on = new ArrayList<>(before.chosen() ? before.desks() : List.of());
            List<SendHalf> live = liveGrants(agentId);
            List<SendHalf> revoke = new ArrayList<>();
            List<DeskChange> offer = new ArrayList<>();
            for (DeskChange change : deskChanges) {
                SendHalf existing = live.stream().filter(h -> h.toDeskId().equals(change.deskId())).findFirst()
                        .orElse(null);
                if (change.on()) {
                    if (existing == null) {
                        if (change.deskName() == null) {
                            throw RpcError.of("bad_request", "detail", "desks", "reason", "name");
                        }
                        offer.add(change);
                    }
                    if (!on.contains(change.deskId())) {
                        on.add(change.deskId());
                    }
                } else {
                    if (existing != null) {
                        revoke.add(existing);
                    }
                    on.remove(change.deskId());
                }
            }
            if (on.size() > MAX_DESKS) {
                throw RpcError.of("bad_request", "detail", "desks", "reason", "too_many");
            }
            long now = clock.millis();
            AgentAccess after = new AgentAccess(true, null, apps, auto, on, now);
            List<SendHalf> offered = new ArrayList<>();
            for (DeskChange change : offer) {
                offered.add(new SendHalf(newGrantId(), agentId, change.deskId(), change.deskName(), null, "offered",
                        now, null, 0));
            }
            write(agentId, after, offered, revoke, now);
            cache.put(agentId, after);
            String actor = caller.isMember() ? "member" : "user";
            // The first save lists what was switched on; a later one what changed. Never a place or a desk's name.
            Set<String> changes = AgentAccess.changes(first ? AgentAccess.NOTHING : before, after);
            audit(actor, "access.set", target(agentId, changes), first ? "setup" : "ok");
            for (SendHalf half : offered) {
                audit(actor, "desks.offer", "agent:" + agentId + " grant:" + half.grantId() + " desk:"
                        + half.toDeskId(), "ok");
            }
            for (SendHalf half : revoke) {
                audit(actor, "desks.revoke", "agent:" + agentId + " grant:" + half.grantId() + " desk:"
                        + half.toDeskId(), "ok");
            }
        } finally {
            writes.unlock();
        }
        changed.accept(agentId);
        return get(agentId);
    }

    /**
     * {@code agent.desks.revoke {grantId}}: the member stops one grant from this desk. Its very next message is refused
     * here, whatever the other desk does.
     *
     * @param sees whether the caller may see an agent
     * @return {@code {agentId, access}}: the grant's agent and its access now, from which deskd cuts its own copy
     */
    public Map<String, Object> revoke(Map<String, Object> p, Caller caller,
            java.util.function.Predicate<String> sees) throws RpcError, SQLException {
        if (!(p.get("grantId") instanceof String grantId) || grantId.length() > 64) {
            throw RpcError.badRequest("grantId");
        }
        for (String key : p.keySet()) {
            if (!key.equals("grantId")) {
                throw RpcError.badRequest(key);
            }
        }
        String agentId;
        writes.lock();
        try {
            SendHalf half = half(grantId);
            if (half == null || !sees.test(half.agentId()) || !LIVE.contains(half.state())) {
                throw RpcError.notFound("grant");
            }
            agentId = half.agentId();
            AgentAccess before = of(agentId);
            List<String> on = new ArrayList<>(before.desks());
            on.remove(half.toDeskId());
            long now = clock.millis();
            AgentAccess after = new AgentAccess(before.chosen(), before.setup(), before.apps(), before.auto(), on,
                    before.chosen() ? now : before.updatedAt());
            write(agentId, after, List.of(), List.of(half), now);
            cache.put(agentId, after);
            audit(caller.isMember() ? "member" : "user", "desks.revoke", "agent:" + agentId + " grant:" + grantId
                    + " desk:" + half.toDeskId(), "ok");
        } finally {
            writes.unlock();
        }
        changed.accept(agentId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("agentId", agentId);
        out.put("access", view(agentId));
        return out;
    }

    @Override
    public void deskdHasNoRecord(String agentId) {
        try {
            lowerToConfirm(agentId, "deskd");
        } catch (SQLException | RuntimeException e) {
            // The agent's tools are refused by deskd anyway; the next refusal tries again.
            log.warn("an agent's access couldn't be marked to confirm: {}", e.getClass().getSimpleName());
        }
    }

    /**
     * deskd's hello says which agents it holds a member's choice for. Any agent set up here that deskd doesn't hold waits
     * for the member to confirm it again. A hello that says nothing of access (an older deskd, which checks none) changes
     * nothing.
     */
    public void deskdHolds(Collection<String> agentIds) {
        Set<String> held = new HashSet<>(agentIds);
        try {
            for (var row : store.agents()) {
                if (!held.contains(row.id()) && chosen(row.id())) {
                    lowerToConfirm(row.id(), "hello");
                }
            }
        } catch (SQLException | RuntimeException e) {
            log.warn("deskd's record of access couldn't be compared: {}", e.getClass().getSimpleName());
        }
    }

    private void lowerToConfirm(String agentId, String why) throws SQLException {
        boolean lowered = false;
        writes.lock();
        try {
            AgentAccess before = of(agentId);
            if (before.chosen() && store.agent(agentId) != null) {
                AgentAccess after = before.toConfirm();
                write(agentId, after, List.of(), List.of(), clock.millis());
                cache.put(agentId, after);
                audit("system", "access.confirm", "agent:" + agentId, why);
                lowered = true;
            }
        } finally {
            writes.unlock();
        }
        if (lowered) {
            changed.accept(agentId);
        }
    }

    /**
     * The agent is gone (deleted, or a member's purge): its rows go, and each grant it had is revoked and audited, as
     * deleting an agent revokes its halves (section 14).
     */
    public void deleted(String agentId) {
        writes.lock();
        try {
            for (SendHalf half : halves(agentId)) {
                if (LIVE.contains(half.state())) {
                    audit("user", "desks.revoke", "agent:" + agentId + " grant:" + half.grantId() + " desk:"
                            + half.toDeskId(), "deleted");
                }
            }
            db().transaction(connection -> {
                for (String sql : List.of("DELETE FROM agent_access WHERE agent_id = ?",
                        "DELETE FROM desk_grants WHERE agent_id = ?")) {
                    try (PreparedStatement delete = connection.prepareStatement(sql)) {
                        delete.setString(1, agentId);
                        delete.executeUpdate();
                    }
                }
                return null;
            });
        } catch (SQLException | RuntimeException e) {
            // The next open drops rows whose agent is gone.
            log.warn("a deleted agent's access wasn't removed: {}", e.getClass().getSimpleName());
        } finally {
            cache.remove(agentId);
            reported.remove(agentId);
            writes.unlock();
        }
    }

    /** A member's purge, or anything else that changed the rows under the book: read them again. */
    public void forget(String agentId) {
        cache.remove(agentId);
    }

    // ---------------------------------------------------------------- parsing the member's params

    private record DeskChange(String deskId, String deskName, boolean on) {}

    private static AgentAccess.Apps apps(Object raw, AgentAccess.Apps before, boolean first, boolean guildMember)
            throws RpcError {
        if (raw == null) {
            return guildMember ? before.and(AgentAccess.Apps.GUILD) : before;
        }
        if (!(raw instanceof Map<?, ?> map)) {
            throw RpcError.badRequest("apps");
        }
        AgentAccess.Apps apps = first ? AgentAccess.Apps.NONE : before;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            String app = String.valueOf(entry.getKey());
            if (!AgentAccess.APP_NAMES.contains(app)) {
                throw RpcError.badRequest("apps." + app);
            }
            if (!(entry.getValue() instanceof Boolean on)) {
                throw RpcError.badRequest("apps." + app);
            }
            if (guildMember && on && !app.equals("notebook")) {
                throw RpcError.of("bad_request", "detail", "apps." + app, "reason", "guild");
            }
            apps = apps.with(app, on);
        }
        if (first) {
            for (String app : AgentAccess.APP_NAMES) {
                if (!map.containsKey(app)) {
                    throw RpcError.of("bad_request", "detail", "apps." + app, "reason", "required");
                }
            }
        }
        return apps;
    }

    private static AgentAccess.Auto auto(Object raw, AgentAccess.Auto before, boolean first, boolean guildMember,
            AgentAccess.Apps apps) throws RpcError {
        String tab = first ? null : before.notebookTab();
        String folder = first ? null : before.filesFolder();
        boolean todos = !first && before.todos();
        Set<String> named = Set.of();
        if (raw != null) {
            if (!(raw instanceof Map<?, ?> map)) {
                throw RpcError.badRequest("auto");
            }
            named = new HashSet<>();
            for (Object key : map.keySet()) {
                named.add(String.valueOf(key));
                if (!AUTO_KEYS.contains(String.valueOf(key))) {
                    throw RpcError.badRequest("auto." + key);
                }
            }
            if (first && !named.containsAll(AUTO_KEYS)) {
                for (String key : List.of("notebook", "files", "todos")) {
                    if (!named.contains(key)) {
                        throw RpcError.of("bad_request", "detail", "auto." + key, "reason", "required");
                    }
                }
            }
            if (map.containsKey("notebook")) {
                Object value = map.get("notebook");
                if (value == null) {
                    tab = null;
                } else if (value instanceof Map<?, ?> place && place.size() == 1
                        && place.get("tabId") instanceof String id && TAB_ID.matcher(id).matches()) {
                    tab = id;
                } else {
                    throw RpcError.badRequest("auto.notebook");
                }
            }
            if (map.containsKey("files")) {
                Object value = map.get("files");
                if (value == null) {
                    folder = null;
                } else if (value instanceof Map<?, ?> place && place.size() == 1
                        && place.get("folder") instanceof String path) {
                    folder = folder(path);
                } else {
                    throw RpcError.badRequest("auto.files");
                }
            }
            if (map.containsKey("todos")) {
                if (!(map.get("todos") instanceof Boolean on)) {
                    throw RpcError.badRequest("auto.todos");
                }
                todos = on;
            }
        }
        if (guildMember && (tab != null || folder != null || todos)) {
            throw RpcError.of("bad_request", "detail", tab != null ? "auto.notebook" : folder != null ? "auto.files"
                    : "auto.todos", "reason", "guild");
        }
        // A switch the member turned on for an app that's off is a mistake to say; an app turned off takes its switch.
        if (tab != null && !apps.notebook()) {
            if (named.contains("notebook")) {
                throw RpcError.of("bad_request", "detail", "auto.notebook", "reason", "app_off");
            }
            tab = null;
        }
        if (folder != null && !apps.files()) {
            if (named.contains("files")) {
                throw RpcError.of("bad_request", "detail", "auto.files", "reason", "app_off");
            }
            folder = null;
        }
        if (todos && !apps.todos()) {
            if (named.contains("todos")) {
                throw RpcError.of("bad_request", "detail", "auto.todos", "reason", "app_off");
            }
            todos = false;
        }
        return new AgentAccess.Auto(tab, folder, todos);
    }

    /**
     * A folder for the Files switch, relative to the Files' top: never the top itself (never all of Files), never the
     * trash or the uploads, no {@code .} or {@code ..} part, no control or hidden characters. deskd's own Files path
     * rules decide again when a call runs.
     */
    static String folder(String path) throws RpcError {
        String p = path.strip();
        while (p.startsWith("/")) {
            p = p.substring(1);
        }
        while (p.endsWith("/")) {
            p = p.substring(0, p.length() - 1);
        }
        if (p.isEmpty() || p.length() > MAX_FOLDER || p.chars().anyMatch(Character::isISOControl)
                || TextChecks.hidden(p) || p.contains("\\")) {
            throw RpcError.of("bad_request", "detail", "auto.files", "reason", "folder");
        }
        for (String part : p.split("/")) {
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.equals(".trash")
                    || part.equals(".uploads")) {
                throw RpcError.of("bad_request", "detail", "auto.files", "reason", "folder");
            }
        }
        return p;
    }

    private static List<DeskChange> desks(Object raw, boolean guildMember) throws RpcError {
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list) || list.size() > MAX_DESKS) {
            throw RpcError.badRequest("desks");
        }
        List<DeskChange> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> m) || !(m.get("deskId") instanceof String id)
                    || !DESK_ID.matcher(id).matches() || !(m.get("on") instanceof Boolean on) || !seen.add(id)) {
                throw RpcError.badRequest("desks");
            }
            for (Object key : m.keySet()) {
                if (!Set.of("deskId", "deskName", "on").contains(String.valueOf(key))) {
                    throw RpcError.badRequest("desks");
                }
            }
            if (guildMember && on) {
                throw RpcError.of("bad_request", "detail", "desks", "reason", "guild");
            }
            String name = null;
            if (m.get("deskName") != null) {
                if (!(m.get("deskName") instanceof String n) || n.strip().isEmpty()
                        || n.strip().length() > MAX_DESK_NAME || n.chars().anyMatch(Character::isISOControl)) {
                    throw RpcError.of("bad_request", "detail", "desks", "reason", "name");
                }
                TextChecks.refuseHidden(n, "desks");
                name = n.strip();
            }
            out.add(new DeskChange(id, name, on));
        }
        return out;
    }

    // ---------------------------------------------------------------- storage

    private SqliteDatabase db() throws SQLException {
        return store.database();
    }

    /** The hash a row carries: SHA-256 of the canonical JSON of {@code {v: 1, agentId, body}}. */
    static String rowHash(String agentId, Map<String, Object> body) {
        Map<String, Object> bound = new LinkedHashMap<>();
        bound.put("v", 1);
        bound.put("agentId", agentId);
        bound.put("body", body);
        return Canonical.sha256(bound);
    }

    /** A send half's hash: over what decides whether it's in force. */
    public static String halfHash(String grantId, String agentId, String toDeskId, String state) {
        Map<String, Object> bound = new LinkedHashMap<>();
        bound.put("v", 1);
        bound.put("grantId", grantId);
        bound.put("agentId", agentId);
        bound.put("toDeskId", toDeskId);
        bound.put("state", state);
        return Canonical.sha256(bound);
    }

    private AgentAccess read(String agentId) throws SQLException {
        boolean member = Caller.isMemberAgent(agentId);
        record Stored(String body, String sha256, boolean legacy) {}
        Stored stored = db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT body, sha256, legacy FROM agent_access WHERE agent_id = ?")) {
                select.setString(1, agentId);
                try (ResultSet result = select.executeQuery()) {
                    return result.next() ? new Stored(result.getString(1), result.getString(2), result.getInt(3) != 0)
                            : null;
                }
            }
        });
        if (stored == null) {
            return AgentAccess.fresh(member);
        }
        if (stored.body() == null) {
            return stored.legacy() ? AgentAccess.legacy(member) : unreadable(agentId);
        }
        Map<String, Object> body;
        try {
            body = Json.parseObject(stored.body().getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            return unreadable(agentId);
        }
        AgentAccess access = AgentAccess.fromBody(body);
        if (access == null || !rowHash(agentId, access.body()).equals(stored.sha256())
                || !Canonical.json(access.body()).equals(stored.body())) {
            return unreadable(agentId);
        }
        if (member) {
            // A guild member's agent never has more than a Guild Desk gives it, whatever a row says.
            access = new AgentAccess(access.chosen(), access.setup(), access.apps().and(AgentAccess.Apps.GUILD),
                    AgentAccess.Auto.OFF, List.of(), access.updatedAt());
        }
        return access;
    }

    private AgentAccess unreadable(String agentId) {
        if (reported.add(agentId)) {
            log.warn("an agent's access record didn't read back whole, so it waits for the member's setup again");
            audit("system", "access.tampered", "agent:" + agentId, "unreadable");
        }
        return AgentAccess.unreadable(Caller.isMemberAgent(agentId));
    }

    private List<SendHalf> halves(String agentId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT grant_id, agent_id, to_desk_id,"
                    + " to_desk_name, to_key, state, created_at, last_used_at, count, sha256 FROM desk_grants"
                    + " WHERE agent_id = ? ORDER BY created_at, grant_id")) {
                select.setString(1, agentId);
                try (ResultSet result = select.executeQuery()) {
                    List<SendHalf> out = new ArrayList<>();
                    while (result.next()) {
                        SendHalf half = half(result);
                        if (half != null) {
                            out.add(half);
                        }
                    }
                    return out;
                }
            }
        });
    }

    private SendHalf half(String grantId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT grant_id, agent_id, to_desk_id,"
                    + " to_desk_name, to_key, state, created_at, last_used_at, count, sha256 FROM desk_grants"
                    + " WHERE grant_id = ?")) {
                select.setString(1, grantId);
                try (ResultSet result = select.executeQuery()) {
                    return result.next() ? half(result) : null;
                }
            }
        });
    }

    /** A row, or null for one whose hash doesn't match: no grant. */
    private SendHalf half(ResultSet result) throws SQLException {
        String grantId = result.getString(1);
        String agentId = result.getString(2);
        String toDeskId = result.getString(3);
        String state = result.getString(6);
        if (!halfHash(grantId, agentId, toDeskId, state).equals(result.getString(10))) {
            if (reported.add("grant:" + grantId)) {
                log.warn("a desk grant's row didn't read back whole, so it's no grant");
                audit("system", "access.tampered", "agent:" + agentId + " grant:" + grantId, "unreadable");
            }
            return null;
        }
        long last = result.getLong(8);
        Long lastUsed = result.wasNull() ? null : last;
        return new SendHalf(grantId, agentId, toDeskId, result.getString(4), result.getString(5), state,
                result.getLong(7), lastUsed, result.getInt(9));
    }

    private void write(String agentId, AgentAccess access, List<SendHalf> offered, List<SendHalf> revoked, long now)
            throws SQLException {
        Map<String, Object> body = access.body();
        String json = Canonical.json(body);
        String sha = rowHash(agentId, body);
        db().transaction(connection -> {
            try (PreparedStatement upsert = connection.prepareStatement("INSERT INTO agent_access (agent_id, body,"
                    + " sha256, legacy, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT (agent_id) DO UPDATE SET"
                    + " body = excluded.body, sha256 = excluded.sha256, legacy = 0, updated_at = excluded.updated_at")) {
                upsert.setString(1, agentId);
                upsert.setString(2, json);
                upsert.setString(3, sha);
                upsert.setLong(4, now);
                upsert.executeUpdate();
            }
            for (SendHalf half : offered) {
                try (PreparedStatement insert = connection.prepareStatement("INSERT INTO desk_grants (grant_id,"
                        + " agent_id, to_desk_id, to_desk_name, to_key, state, created_at, updated_at, last_used_at,"
                        + " count, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")) {
                    insert.setString(1, half.grantId());
                    insert.setString(2, agentId);
                    insert.setString(3, half.toDeskId());
                    insert.setString(4, half.toDeskName());
                    insert.setNull(5, Types.VARCHAR);
                    insert.setString(6, half.state());
                    insert.setLong(7, now);
                    insert.setLong(8, now);
                    insert.setNull(9, Types.INTEGER);
                    insert.setString(10, halfHash(half.grantId(), agentId, half.toDeskId(), half.state()));
                    insert.executeUpdate();
                }
            }
            for (SendHalf half : revoked) {
                try (PreparedStatement update = connection.prepareStatement("UPDATE desk_grants SET state = 'revoked',"
                        + " updated_at = ?, sha256 = ? WHERE grant_id = ? AND agent_id = ?")) {
                    update.setLong(1, now);
                    update.setString(2, halfHash(half.grantId(), agentId, half.toDeskId(), "revoked"));
                    update.setString(3, half.grantId());
                    update.setString(4, agentId);
                    update.executeUpdate();
                }
            }
            return null;
        });
    }

    private static String newGrantId() {
        char[] id = new char[20];
        for (int i = 0; i < id.length; i++) {
            id[i] = BASE32[RANDOM.nextInt(32)];
        }
        return "dg-" + new String(id);
    }

    private static String target(String agentId, Set<String> changes) {
        String target = "agent:" + agentId + (changes.isEmpty() ? "" : " " + String.join(" ", changes));
        return target.length() <= 256 ? target : target.substring(0, 256);
    }

    private void audit(String actor, String action, String target, String decision) {
        try {
            audit.append(AuditLog.Entry.of(actor, action, target, decision));
        } catch (SQLException | RuntimeException e) {
            log.warn("an audit row wasn't written: {} {}", action, e.getClass().getSimpleName());
        }
    }
}
