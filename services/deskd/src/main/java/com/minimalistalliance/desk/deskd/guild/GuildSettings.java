package com.minimalistalliance.desk.deskd.guild;

import com.minimalistalliance.desk.deskd.platform.EditBudget;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A guild desk's agent settings (API.md section 14, draft section 7): the limits the Founder sets on members' agents,
 * kept on the desk in {@code /data/desk/guild-settings.json} and never sent to the Platform. desk-agent gets them as
 * {@code desk.guild.set} ({@code AgentPushes}) on every connection and every change.
 *
 * <p>Exactly this shape, every field present, and a set replaces the whole of each block it carries:
 * <pre>{agents: {perMember: {runsPerDay, usdPerDay, usdPerMonth}, perGuild: {usdPerMonth, runsAtOnce},
 *          tools: {read, search, edit, post, boards}, ownKeys},
 *  notebook: {editBudget: {chars, windowMinutes} | null}}</pre>
 * A set carries {@code agents}, {@code notebook} or both; a block it leaves out stays as it was. {@code editBudget} is the
 * guild's own Notebook edit budget (chars 0 to 100,000, windowMinutes 1 to 1,440), or null to go by the Platform's.
 * Dollars are a number from 0 to 100,000 with at most 6 decimals, or null for no cap; {@code runsPerDay} a whole number
 * up to 10,000, or null; {@code runsAtOnce} 1 to 8. Commons keeps its own settings.
 *
 * <p>Each set is written whole (temporary file, fsync, rename) and then audited, one JSON line in
 * {@code guild-audit.jsonl} beside it: when, who (the member id and role), and the settings it set. Neither holds a
 * secret.
 */
public final class GuildSettings {

    private static final Logger log = LoggerFactory.getLogger(GuildSettings.class);

    public static final String FILE = "guild-settings.json";
    public static final String AUDIT_FILE = "guild-audit.jsonl";
    /** Past this the audit file starts over, keeping one older file. */
    static final long MAX_AUDIT_BYTES = 512 << 10;
    private static final BigDecimal MAX_USD = BigDecimal.valueOf(100_000);
    private static final int MAX_RUNS_PER_DAY = 10_000;
    private static final int MAX_RUNS_AT_ONCE = 8;
    private static final List<String> TOOLS = List.of("read", "search", "edit", "post", "boards");

    private final Path file;
    private final Path audit;
    private final Clock clock;
    private final ReentrantLock lock = new ReentrantLock();
    private final List<Runnable> listeners = new CopyOnWriteArrayList<>();
    private final List<Runnable> budgetListeners = new CopyOnWriteArrayList<>();
    private volatile Map<String, Object> agents;
    private volatile EditBudget editBudget;
    private volatile String updatedAt;
    private volatile String updatedBy;

    /** Reads what's kept: a missing or unreadable file means the draft's defaults, with one log line for the latter. */
    public GuildSettings(Path directory, Clock clock) {
        this.file = directory.resolve(FILE);
        this.audit = directory.resolve(AUDIT_FILE);
        this.clock = clock;
        this.agents = defaults();
        load();
    }

    /** Draft section 7's defaults: 20 runs, $1 a day and $10 a month a member; $50 a month and 2 runs at once a guild. */
    public static Map<String, Object> defaults() {
        Map<String, Object> perMember = new LinkedHashMap<>();
        perMember.put("runsPerDay", 20);
        perMember.put("usdPerDay", 1);
        perMember.put("usdPerMonth", 10);
        Map<String, Object> perGuild = new LinkedHashMap<>();
        perGuild.put("usdPerMonth", 50);
        perGuild.put("runsAtOnce", 2);
        Map<String, Object> tools = new LinkedHashMap<>();
        for (String tool : TOOLS) {
            tools.put(tool, true);
        }
        Map<String, Object> agents = new LinkedHashMap<>();
        agents.put("perMember", perMember);
        agents.put("perGuild", perGuild);
        agents.put("tools", tools);
        agents.put("ownKeys", false);
        return agents;
    }

    /** Runs after each change. Must not block. */
    public void onChange(Runnable listener) {
        listeners.add(listener);
    }

    /** Runs after each set that carried the {@code notebook} block. Must not block. */
    public void onEditBudgetChange(Runnable listener) {
        budgetListeners.add(listener);
    }

    /** The guild's own Notebook edit budget, or null when it hasn't set one. */
    public EditBudget editBudget() {
        return editBudget;
    }

    /** {@code {agents}}, as desk-agent and {@code guild.settings.get} have them. */
    public Map<String, Object> current() {
        return Map.of("agents", agents);
    }

    /** {@code guild.settings.get}'s and {@code set}'s answer: the settings, and who last set them and when. */
    public Map<String, Object> view() {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("agents", agents);
        view.put("notebook", notebookBlock(editBudget));
        view.put("updatedAt", updatedAt);
        view.put("updatedBy", updatedBy);
        return view;
    }

    /**
     * {@code guild.settings.set}: checked whole before anything changes, then written, then audited, then pushed.
     *
     * @param effect run right before the write, the call's point of no return
     * @throws RpcException {@code bad_request} with {@code reason: settings} and {@code detail} naming the field, or
     *     {@code unavailable} with {@code reason: storage} if it couldn't be written, when nothing changed
     */
    public Map<String, Object> set(Map<String, Object> params, Caller by, Effect effect) throws RpcException {
        boolean hasAgents = params.containsKey("agents");
        boolean hasNotebook = params.containsKey("notebook");
        if (!hasAgents && !hasNotebook) {
            throw invalid("agents");
        }
        Map<String, Object> nextAgents = hasAgents ? parse(params.get("agents")) : null;
        EditBudget nextBudget = hasNotebook ? parseNotebook(params.get("notebook")) : null;
        lock.lock();
        try {
            effect.begin();
            String at = clock.instant().toString();
            Map<String, Object> keptAgents = hasAgents ? nextAgents : agents;
            EditBudget keptBudget = hasNotebook ? nextBudget : editBudget;
            Map<String, Object> saved = new LinkedHashMap<>();
            saved.put("version", 1);
            saved.put("agents", keptAgents);
            saved.put("notebook", notebookBlock(keptBudget));
            saved.put("updatedAt", at);
            saved.put("updatedBy", by.memberId());
            try {
                AtomicFile.write(file, Json.bytes(saved));
            } catch (IOException e) {
                log.error("guild settings: couldn't write them: {}", e.getClass().getSimpleName());
                throw new RpcException(RpcException.UNAVAILABLE, "The settings couldn't be stored", Map.of("reason", "storage"));
            }
            agents = keptAgents;
            editBudget = keptBudget;
            updatedAt = at;
            updatedBy = by.memberId();
            appendAudit(at, by, hasAgents ? nextAgents : null, hasNotebook ? notebookBlock(nextBudget) : null);
        } finally {
            lock.unlock();
        }
        for (Runnable listener : listeners) {
            listener.run();
        }
        if (hasNotebook) {
            for (Runnable listener : budgetListeners) {
                listener.run();
            }
        }
        return view();
    }

    /** The mutation's point of no return. */
    @FunctionalInterface
    public interface Effect {
        void begin() throws RpcException;
    }

    private void appendAudit(String at, Caller by, Map<String, Object> nextAgents, Map<String, Object> nextNotebook) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("at", at);
        row.put("action", "guild.settings.set");
        row.put("by", by.memberId());
        row.put("role", by.role());
        if (nextAgents != null) {
            row.put("agents", nextAgents);
        }
        if (nextNotebook != null) {
            row.put("notebook", nextNotebook);
        }
        byte[] line = (new String(Json.bytes(row), StandardCharsets.UTF_8) + "\n").getBytes(StandardCharsets.UTF_8);
        try {
            if (Files.isRegularFile(audit) && Files.size(audit) + line.length > MAX_AUDIT_BYTES) {
                Files.move(audit, audit.resolveSibling(AUDIT_FILE + ".1"), StandardCopyOption.REPLACE_EXISTING);
            }
            try (var channel = java.nio.channels.FileChannel.open(audit, StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                    StandardOpenOption.APPEND)) {
                java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(line);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
        } catch (IOException e) {
            // The setting stands: it's written, and the push carries it. The log says the trail has a gap.
            log.error("guild settings: the audit line wasn't written: {}", e.getClass().getSimpleName());
        }
    }

    private void load() {
        try {
            byte[] bytes = AtomicFile.read(file);
            if (bytes == null) {
                return;
            }
            Map<String, Object> saved = Json.parseObject(bytes);
            agents = parse(saved.get("agents"));
            // What's kept for the Notebook is read leniently: a block that doesn't parse means no budget of the guild's own.
            editBudget = saved.get("notebook") instanceof Map<?, ?> block ? EditBudget.parse(block.get("editBudget")) : null;
            updatedAt = Json.string(saved, "updatedAt");
            updatedBy = Json.string(saved, "updatedBy");
        } catch (IOException | JsonFormatException | RpcException | RuntimeException e) {
            log.warn("guild settings: what's kept couldn't be read, so the defaults stand: {}", e.getClass().getSimpleName());
        }
    }

    // ---- the shape

    private static Map<String, Object> notebookBlock(EditBudget budget) {
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("editBudget", budget == null ? null : budget.toJson());
        return block;
    }

    /** {@code {editBudget: {chars, windowMinutes} | null}}; the key must be there, and a budget must be in bounds. */
    private static EditBudget parseNotebook(Object value) throws RpcException {
        Map<String, Object> notebook = object(value, "notebook");
        if (!notebook.containsKey("editBudget")) {
            throw invalid("notebook.editBudget");
        }
        Object budget = notebook.get("editBudget");
        if (budget == null) {
            return null;
        }
        EditBudget parsed = EditBudget.parse(budget);
        if (parsed == null) {
            // Name the field that is wrong where it can be told.
            Map<?, ?> map = budget instanceof Map<?, ?> m ? m : Map.of();
            boolean charsOk = EditBudget.parse(Map.of("chars", map.get("chars") == null ? "x" : map.get("chars"), "windowMinutes", 1)) != null;
            throw invalid(charsOk ? "notebook.editBudget.windowMinutes" : "notebook.editBudget.chars");
        }
        return parsed;
    }

    static Map<String, Object> parse(Object value) throws RpcException {
        Map<String, Object> agents = object(value, "agents");
        Map<String, Object> perMember = object(agents.get("perMember"), "agents.perMember");
        Map<String, Object> perGuild = object(agents.get("perGuild"), "agents.perGuild");
        Map<String, Object> tools = object(agents.get("tools"), "agents.tools");

        Map<String, Object> member = new LinkedHashMap<>();
        member.put("runsPerDay", count(perMember, "runsPerDay", "agents.perMember.runsPerDay", 0, MAX_RUNS_PER_DAY, true));
        member.put("usdPerDay", usd(perMember, "usdPerDay", "agents.perMember.usdPerDay"));
        member.put("usdPerMonth", usd(perMember, "usdPerMonth", "agents.perMember.usdPerMonth"));
        Map<String, Object> guild = new LinkedHashMap<>();
        guild.put("usdPerMonth", usd(perGuild, "usdPerMonth", "agents.perGuild.usdPerMonth"));
        guild.put("runsAtOnce", count(perGuild, "runsAtOnce", "agents.perGuild.runsAtOnce", 1, MAX_RUNS_AT_ONCE, false));
        Map<String, Object> toolSet = new LinkedHashMap<>();
        for (String tool : TOOLS) {
            toolSet.put(tool, bool(tools, tool, "agents.tools." + tool));
        }
        Map<String, Object> next = new LinkedHashMap<>();
        next.put("perMember", member);
        next.put("perGuild", guild);
        next.put("tools", toolSet);
        next.put("ownKeys", bool(agents, "ownKeys", "agents.ownKeys"));
        return next;
    }

    /** Dollars as micro-dollars: what desk-agent's {@code Limit} counts in. Null for no cap. */
    public static Long microUsd(Object dollars) {
        return dollars == null ? null : decimal(dollars).movePointRight(6).longValueExact();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String field) throws RpcException {
        if (!(value instanceof Map<?, ?> map)) {
            throw invalid(field);
        }
        return (Map<String, Object>) map;
    }

    private static Object usd(Map<String, Object> map, String key, String field) throws RpcException {
        if (!map.containsKey(key)) {
            throw invalid(field);
        }
        Object value = map.get(key);
        if (value == null) {
            return null;
        }
        if (!(value instanceof Number) || value instanceof Double d && (d.isNaN() || d.isInfinite())) {
            throw invalid(field);
        }
        BigDecimal amount = decimal(value);
        if (amount.signum() < 0 || amount.compareTo(MAX_USD) > 0 || amount.stripTrailingZeros().scale() > 6) {
            throw invalid(field);
        }
        // Kept as a plain number: whole dollars as a whole number, else the decimal as given.
        BigDecimal plain = amount.stripTrailingZeros();
        return plain.scale() <= 0 ? (Object) plain.longValueExact() : (Object) plain.doubleValue();
    }

    private static BigDecimal decimal(Object value) {
        if (value instanceof BigDecimal big) {
            return big;
        }
        if (value instanceof Double || value instanceof Float) {
            return BigDecimal.valueOf(((Number) value).doubleValue());
        }
        return BigDecimal.valueOf(((Number) value).longValue());
    }

    private static Object count(Map<String, Object> map, String key, String field, int min, int max, boolean nullable)
            throws RpcException {
        if (!map.containsKey(key)) {
            throw invalid(field);
        }
        Object value = map.get(key);
        if (value == null && nullable) {
            return null;
        }
        if (!(value instanceof Integer || value instanceof Long)) {
            throw invalid(field);
        }
        long n = ((Number) value).longValue();
        if (n < min || n > max) {
            throw invalid(field);
        }
        return (int) n;
    }

    private static boolean bool(Map<String, Object> map, String key, String field) throws RpcException {
        if (!(map.get(key) instanceof Boolean b)) {
            throw invalid(field);
        }
        return b;
    }

    private static RpcException invalid(String field) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", "settings");
        details.put("detail", field);
        return new RpcException(RpcException.BAD_REQUEST, "The settings aren't in the expected shape", details);
    }
}
