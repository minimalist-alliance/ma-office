package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's own copy of each agent's access (draft ADR "the Agent's tools and approvals", sections 11, 15 and 16; Security
 * question 5 of the work breakdown): which apps the member let the agent use, its "without asking" switches and the
 * desks it may message, recorded <b>only</b> from the member's relayed {@code agent.access.set} and
 * {@code agent.desks.revoke}, as {@link ApprovalTickets} records a relayed yes. desk-agent's word is never enough: the
 * tools deskd runs for an agent check this record first ({@link ToolHost.AgentApps}), so a wrong or compromised desk-agent
 * can't give an agent an app the member switched off, or run one the member never set up.
 *
 * <p><b>What's recorded.</b> The member's params merged onto deskd's own last copy, then cut down to what desk-agent
 * says it holds after the call (its answer's {@code access}): on only where both agree. So deskd never holds more than
 * the member asked for, nor more than desk-agent applied. A call desk-agent refused records nothing. A revoke, an
 * agent's delete and a member's purge only ever take away.
 *
 * <p><b>Where.</b> {@code /data/desk/agent-access.json}, deskd's own file (mode 0600, written whole: a temporary file,
 * an fsync, a rename), with an HMAC-SHA256 over its canonical JSON under {@code agent-access.key}, 32 random bytes made
 * once beside it (0600). desk-agent's user can't write {@code /data/desk}; the MAC makes a hand edit, a file from another
 * desk or a torn write read as nothing recorded. <b>It fails closed:</b> a file that doesn't verify, isn't one, or
 * follows a link is set aside as {@code agent-access.json.bad}, and every agent is unrecorded, so each gets
 * {@code setup} until the member saves its screen again. deskd's hello names the agents it holds
 * ({@link #recorded}), and desk-agent has any other wait for the member to confirm.
 *
 * <p>Nothing here logs an agent's choice, a place or a desk: an outcome word at most.
 */
public final class AccessRecord implements ToolHost.AgentApps, ToolHost.AccessRecord {

    private static final Logger log = LoggerFactory.getLogger(AccessRecord.class);

    public static final String FILE = "agent-access.json";
    public static final String KEY = "agent-access.key";
    static final int MAX_BYTES = 1 << 20;
    static final int MAX_AGENTS = 2_000;
    private static final int KEY_BYTES = 32;
    private static final Pattern AGENT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final Pattern TAB_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final Pattern DESK_ID = Pattern.compile("[a-z0-9-]{1,64}");
    /** The apps, as the screen and desk-agent name them. */
    static final List<String> APPS = List.of("notebook", "files", "browser", "courier", "todos");
    /**
     * The send halves deskd keeps a desk for: offered or active. Messages between desks (W6) must carry only on an
     * {@code active} half, the other desk's yes, never an {@code offered} one.
     */
    private static final Set<String> LIVE = Set.of("offered", "active");

    /**
     * One agent's access as deskd holds it.
     *
     * @param apps the apps on
     * @param notebookTab the Notebook switch's tab, or null for off
     * @param filesFolder the Files switch's folder, or null for off
     * @param todos the to-dos switch
     * @param desks the member's other desks it may message, by id
     * @param at when deskd recorded it, ms
     */
    public record Entry(Set<String> apps, String notebookTab, String filesFolder, boolean todos, Set<String> desks,
            long at) {
        public Entry {
            apps = Set.copyOf(apps);
            desks = Set.copyOf(desks);
        }

        public boolean anyAuto() {
            return notebookTab != null || filesFolder != null || todos;
        }

        Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("apps", new ArrayList<>(new TreeSet<>(apps)));
            out.put("notebookTab", notebookTab);
            out.put("filesFolder", filesFolder);
            out.put("todos", todos);
            out.put("desks", new ArrayList<>(new TreeSet<>(desks)));
            out.put("at", at);
            return out;
        }

        static Entry fromJson(Object value) {
            if (!(value instanceof Map<?, ?> m) || !(m.get("apps") instanceof List<?> apps)
                    || !(m.get("desks") instanceof List<?> desks) || !(m.get("todos") instanceof Boolean todos)
                    || !(m.get("at") instanceof Number at)) {
                return null;
            }
            Set<String> appSet = new TreeSet<>();
            for (Object app : apps) {
                if (!(app instanceof String a) || !APPS.contains(a)) {
                    return null;
                }
                appSet.add(a);
            }
            Set<String> deskSet = new TreeSet<>();
            for (Object desk : desks) {
                if (!(desk instanceof String d) || !DESK_ID.matcher(d).matches()) {
                    return null;
                }
                deskSet.add(d);
            }
            String tab = m.get("notebookTab") instanceof String t ? t : null;
            String folder = m.get("filesFolder") instanceof String f ? f : null;
            return new Entry(appSet, tab, folder, todos, deskSet, at.longValue());
        }

        /** No places or desks in logs. */
        @Override
        public String toString() {
            return "Entry[" + apps.size() + " apps]";
        }
    }

    private static final Entry NOTHING = new Entry(Set.of(), null, null, false, Set.of(), 0);

    private final Clock clock;
    private final SecureRandom random = new SecureRandom();
    private final ReentrantLock lock = new ReentrantLock();
    /** Under {@link #lock} for changes; read without it as a whole map. */
    private volatile Map<String, Entry> agents = Map.of();
    private volatile Path directory;

    public AccessRecord(Clock clock) {
        this.clock = Objects.requireNonNull(clock);
    }

    /**
     * Reads the record from {@code directory} ({@code /data/desk}), and keeps it there from now on. Until this is
     * called, nothing is recorded and nothing kept: every agent is {@code setup}.
     */
    public void keepIn(Path dir) {
        lock.lock();
        try {
            this.directory = dir;
            this.agents = load(dir);
        } finally {
            lock.unlock();
        }
    }

    // ---------------------------------------------------------------- ToolHost.AgentApps

    @Override
    public String refusal(String agentId, String area) {
        Entry entry = agents.get(agentId);
        if (entry == null) {
            return "setup";
        }
        if (HostedDecls.DESKS.equals(area)) {
            // No app: the area checks the grant itself, in deskd's own record of the halves (desks/DeskGrants).
            return null;
        }
        if (HostedDecls.DOCS.equals(area)) {
            // Desk Maia's alone: tools/DocsTools refuses any other caller, and her too while Maia Mode is off.
            return "maia".equals(agentId) ? null : "scope";
        }
        String app = appOf(area);
        return app != null && entry.apps().contains(app) ? null : "scope";
    }

    @Override
    public List<String> recorded() {
        return new ArrayList<>(new TreeSet<>(agents.keySet()));
    }

    /** A hosted area's app; null for one no app covers, which nothing is let through. */
    static String appOf(String area) {
        return switch (area) {
            case HostedDecls.FILES -> "files";
            case HostedDecls.BROWSER -> "browser";
            case HostedDecls.NOTEBOOK -> "notebook";
            case "courier" -> "courier";
            case "todo", "todos" -> "todos";
            default -> null;
        };
    }

    /**
     * The seam for the approvals core, exactly its {@code ToolHost.AccessRecord.autoOn}: whether the agent's owner, as
     * deskd stamped the caller, switched {@code group} ({@code notebook}, {@code files}, {@code todos}) on for it, by this
     * record alone, with the group's app on. False for an agent deskd holds no record of, a caller who doesn't own the
     * agent, or any other group. The switch's place is in {@link #entry}.
     */
    @Override
    public boolean autoOn(Caller caller, String agentId, String group) {
        Entry entry = agentId == null ? null : agents.get(agentId);
        // Nothing is done without asking on a Guild Desk, whatever was recorded (the draft ADR's §15 rule 8, AAW-L3).
        if (entry == null || group == null || !owns(caller, agentId) || guildDesk.getAsBoolean()) {
            return false;
        }
        return switch (group) {
            case "notebook" -> entry.notebookTab() != null && entry.apps().contains("notebook");
            case "files" -> entry.filesFolder() != null && entry.apps().contains("files");
            case "todos" -> entry.todos() && entry.apps().contains("todos");
            default -> false;
        };
    }

    /** What deskd holds for the agent, or null for an agent the member hasn't set up (or whose record deskd lost). */
    public Entry entry(String agentId) {
        return agents.get(agentId);
    }

    /** The switch's place by this record: the Notebook tab's id, the Files folder; null for none. */
    @Override
    public String place(String agentId, String group) {
        Entry entry = agentId == null ? null : agents.get(agentId);
        if (entry == null || group == null) {
            return null;
        }
        return switch (group) {
            case "notebook" -> entry.notebookTab();
            case "files" -> entry.filesFolder();
            default -> null;
        };
    }

    private volatile java.util.function.BooleanSupplier guildDesk = () -> false;

    /** Whether this desk is a Guild Desk, where no switch acts. */
    public void guildDesk(java.util.function.BooleanSupplier isGuild) {
        this.guildDesk = isGuild == null ? () -> false : isGuild;
    }

    /**
     * Whether {@code caller} may decide for the agent, as for its choices: the owner for the desk's agents, a guild member
     * for their own. deskd's undo of a call done without asking checks this from its own ledger's agent.
     */
    public static boolean mayDecideFor(Caller caller, String agentId) {
        return agentId != null && owns(caller, agentId);
    }

    private static boolean owns(Caller caller, String agentId) {
        if (caller == null) {
            return false;
        }
        // A guild member chooses for their own agent alone; the owner for the desk's agents, never a member's.
        return caller.isGuildMember() ? agentId.equals(caller.memberId())
                : Caller.OWNER.equals(caller.kind()) && !agentId.startsWith("gm-");
    }

    // ---------------------------------------------------------------- from the relay

    /**
     * After desk-agent answered the member's {@code agent.access.set}: the params merged onto deskd's own copy, cut to
     * what desk-agent's answer says it holds. A guild member records only their own agent. Anything that doesn't parse
     * records nothing for that agent, which deskd then refuses.
     *
     * @param caller the session's caller as deskd verified it
     */
    public void recordSet(String agentId, Map<String, Object> params, Object answer, Caller caller) {
        if (agentId == null || !AGENT_ID.matcher(agentId).matches() || !owns(caller, agentId)) {
            return;
        }
        Map<String, Object> held = heldAccess(answer);
        lock.lock();
        try {
            Map<String, Entry> next = new TreeMap<>(agents);
            if (held == null || !Boolean.TRUE.equals(held.get("chosen"))) {
                // desk-agent says the agent isn't set up after all: deskd holds nothing for it either.
                next.remove(agentId);
            } else {
                Entry merged = merge(next.getOrDefault(agentId, NOTHING), params);
                Entry cut = merged == null ? null : intersect(merged, held);
                if (cut == null) {
                    next.remove(agentId);
                } else if (next.containsKey(agentId) || next.size() < MAX_AGENTS) {
                    next.put(agentId, cut);
                }
            }
            save(next);
        } finally {
            lock.unlock();
        }
    }

    /**
     * Before the member's {@code agent.access.set} goes to desk-agent: whatever it takes away (an app off, a "without
     * asking" switch off or moved to another place, a desk off) holds in deskd's own record at once, whatever desk-agent
     * then answers (Security's AAB-L1: a wrong desk-agent refusing the save can't keep a switch on in deskd's record).
     * Only what it adds waits for desk-agent's answer ({@link #recordSet}). A change of a switch's place turns the switch
     * off here; the answer puts the new place on.
     */
    public void recordNarrowing(String agentId, Map<String, Object> params, Caller caller) {
        if (agentId == null || !AGENT_ID.matcher(agentId).matches() || !owns(caller, agentId) || params == null) {
            return;
        }
        lock.lock();
        try {
            Entry v = agents.get(agentId);
            if (v == null) {
                return;
            }
            Set<String> apps = new TreeSet<>(v.apps());
            String tab = v.notebookTab();
            String folder = v.filesFolder();
            boolean todos = v.todos();
            Set<String> desks = new TreeSet<>(v.desks());
            if (params.get("apps") instanceof Map<?, ?> map) {
                for (Map.Entry<?, ?> e : map.entrySet()) {
                    if (!Boolean.TRUE.equals(e.getValue())) {
                        apps.remove(String.valueOf(e.getKey()));
                    }
                }
            }
            if (params.get("auto") instanceof Map<?, ?> auto) {
                if (auto.containsKey("notebook") && !(auto.get("notebook") instanceof Map<?, ?> n
                        && tab != null && tab.equals(n.get("tabId")))) {
                    tab = null;
                }
                if (auto.containsKey("files") && !(auto.get("files") instanceof Map<?, ?> f
                        && f.get("folder") instanceof String raw && folder != null && folder.equals(folderOf(raw)))) {
                    folder = null;
                }
                if (auto.containsKey("todos") && !Boolean.TRUE.equals(auto.get("todos"))) {
                    todos = false;
                }
            }
            if (params.get("desks") instanceof List<?> list) {
                for (Object item : list) {
                    if (item instanceof Map<?, ?> m && m.get("deskId") instanceof String id
                            && !Boolean.TRUE.equals(m.get("on"))) {
                        desks.remove(id);
                    }
                }
            }
            // A switch only with its app.
            if (!apps.contains("notebook")) {
                tab = null;
            }
            if (!apps.contains("files")) {
                folder = null;
            }
            if (!apps.contains("todos")) {
                todos = false;
            }
            Entry next = new Entry(apps, tab, folder, todos, desks, clock.millis());
            if (!next.apps().equals(v.apps()) || !java.util.Objects.equals(tab, v.notebookTab())
                    || !java.util.Objects.equals(folder, v.filesFolder()) || todos != v.todos()
                    || !next.desks().equals(v.desks())) {
                Map<String, Entry> map = new TreeMap<>(agents);
                map.put(agentId, next);
                save(map);
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * After desk-agent answered {@code agent.desks.revoke}: the grant's agent (its answer's {@code agentId}) keeps only
     * the desks its answer still holds. Only ever takes away.
     */
    public void recordRevoke(Object answer) {
        Map<String, Object> held = heldAccess(answer);
        String agentId = answer instanceof Map<?, ?> a && a.get("agentId") instanceof String id ? id : null;
        if (agentId == null || held == null) {
            return;
        }
        lock.lock();
        try {
            Entry v = agents.get(agentId);
            if (v == null) {
                return;
            }
            Set<String> still = new TreeSet<>(v.desks());
            still.retainAll(liveDesks(held));
            if (!still.equals(v.desks())) {
                Map<String, Entry> next = new TreeMap<>(agents);
                next.put(agentId, new Entry(v.apps(), v.notebookTab(), v.filesFolder(), v.todos(), still,
                        clock.millis()));
                save(next);
            }
        } finally {
            lock.unlock();
        }
    }

    /** The agent was deleted, or its member purged: deskd holds nothing for it. */
    public void forget(String agentId) {
        lock.lock();
        try {
            if (agents.containsKey(agentId)) {
                Map<String, Entry> next = new TreeMap<>(agents);
                next.remove(agentId);
                save(next);
            }
        } finally {
            lock.unlock();
        }
        // What other areas keep for the agent (Courier's cursor), outside the lock.
        java.util.function.Consumer<String> listener = forgotten;
        if (listener != null && agentId != null) {
            try {
                listener.accept(agentId);
            } catch (RuntimeException e) {
                // Theirs to log.
            }
        }
    }

    private volatile java.util.function.Consumer<String> forgotten;

    /** Told of each agent {@link #forget} drops, after it's dropped: what other areas keep for it goes too. */
    public void onForget(java.util.function.Consumer<String> listener) {
        this.forgotten = listener;
    }

    // ---------------------------------------------------------------- merging

    @SuppressWarnings("unchecked")
    private static Map<String, Object> heldAccess(Object answer) {
        return answer instanceof Map<?, ?> a && a.get("access") instanceof Map<?, ?> access
                ? (Map<String, Object>) access : null;
    }

    /** The member's params onto deskd's copy; null for params that don't parse, which records nothing. */
    static Entry merge(Entry before, Map<String, Object> params) {
        Set<String> apps = new TreeSet<>(before.apps());
        String tab = before.notebookTab();
        String folder = before.filesFolder();
        boolean todos = before.todos();
        Set<String> desks = new TreeSet<>(before.desks());
        Object rawApps = params.get("apps");
        if (rawApps != null) {
            if (!(rawApps instanceof Map<?, ?> map)) {
                return null;
            }
            for (Map.Entry<?, ?> e : map.entrySet()) {
                if (!APPS.contains(String.valueOf(e.getKey())) || !(e.getValue() instanceof Boolean on)) {
                    return null;
                }
                if (on) {
                    apps.add(String.valueOf(e.getKey()));
                } else {
                    apps.remove(String.valueOf(e.getKey()));
                }
            }
        }
        Object rawAuto = params.get("auto");
        if (rawAuto != null) {
            if (!(rawAuto instanceof Map<?, ?> map)) {
                return null;
            }
            if (map.containsKey("notebook")) {
                Object v = map.get("notebook");
                if (v == null) {
                    tab = null;
                } else if (v instanceof Map<?, ?> p && p.get("tabId") instanceof String id
                        && TAB_ID.matcher(id).matches()) {
                    tab = id;
                } else {
                    return null;
                }
            }
            if (map.containsKey("files")) {
                Object v = map.get("files");
                if (v == null) {
                    folder = null;
                } else if (v instanceof Map<?, ?> p && p.get("folder") instanceof String f
                        && !folderOf(f).isEmpty() && f.length() <= 1024) {
                    folder = folderOf(f);
                } else {
                    return null;
                }
            }
            if (map.containsKey("todos")) {
                if (!(map.get("todos") instanceof Boolean on)) {
                    return null;
                }
                todos = on;
            }
        }
        Object rawDesks = params.get("desks");
        if (rawDesks != null) {
            if (!(rawDesks instanceof List<?> list)) {
                return null;
            }
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> m) || !(m.get("deskId") instanceof String id)
                        || !DESK_ID.matcher(id).matches() || !(m.get("on") instanceof Boolean on)) {
                    return null;
                }
                if (on) {
                    desks.add(id);
                } else {
                    desks.remove(id);
                }
            }
        }
        return new Entry(apps, tab, folder, todos, desks, 0);
    }

    /**
     * A Files switch's folder as desk-agent keeps it ({@code AccessBook.folder}): stripped, with no slash at either end, so
     * the two copies compare equal. desk-agent decides what's allowed; this only lines the two up.
     */
    static String folderOf(String raw) {
        String f = raw.strip();
        int start = 0;
        int end = f.length();
        while (start < end && f.charAt(start) == '/') {
            start++;
        }
        while (end > start && f.charAt(end - 1) == '/') {
            end--;
        }
        return f.substring(start, end);
    }

    /** On only where desk-agent's answer agrees, and a switch only with its app. */
    Entry intersect(Entry merged, Map<String, Object> held) {
        Set<String> apps = new TreeSet<>();
        if (held.get("apps") instanceof Map<?, ?> heldApps) {
            for (String app : merged.apps()) {
                if (Boolean.TRUE.equals(heldApps.get(app))) {
                    apps.add(app);
                }
            }
        }
        String tab = null;
        String folder = null;
        boolean todos = false;
        if (held.get("auto") instanceof Map<?, ?> auto) {
            if (merged.notebookTab() != null && auto.get("notebook") instanceof Map<?, ?> n
                    && merged.notebookTab().equals(n.get("tabId")) && apps.contains("notebook")) {
                tab = merged.notebookTab();
            }
            if (merged.filesFolder() != null && auto.get("files") instanceof Map<?, ?> f
                    && merged.filesFolder().equals(f.get("folder")) && apps.contains("files")) {
                folder = merged.filesFolder();
            }
            todos = merged.todos() && Boolean.TRUE.equals(auto.get("todos")) && apps.contains("todos");
        }
        Set<String> desks = new TreeSet<>(merged.desks());
        desks.retainAll(liveDesks(held));
        return new Entry(apps, tab, folder, todos, desks, clock.millis());
    }

    private static Set<String> liveDesks(Map<String, Object> held) {
        Set<String> out = new TreeSet<>();
        if (held.get("desks") instanceof List<?> halves) {
            for (Object half : halves) {
                if (half instanceof Map<?, ?> h && h.get("toDeskId") instanceof String id && LIVE.contains(h.get("state"))) {
                    out.add(id);
                }
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- the file

    /**
     * Under {@link #lock}. The new map holds at once. A failed write never leaves the last file to be read back: it
     * could hold more than the member now allows (an app switched off, a desk revoked), so it's set aside, and a restart
     * before the next good write reads nothing recorded and every agent waits for its setup (fails closed). The next
     * change writes the whole map again.
     */
    private void save(Map<String, Entry> next) {
        agents = Map.copyOf(next);
        Path dir = directory;
        if (dir == null) {
            return;
        }
        try {
            byte[] key = key(dir, true);
            Map<String, Object> body = body(next);
            Map<String, Object> file = new LinkedHashMap<>(body);
            file.put("mac", mac(key, body));
            java.util.Arrays.fill(key, (byte) 0);
            writer.write(dir.resolve(FILE), Json.bytes(file));
        } catch (IOException | GeneralSecurityException | RuntimeException e) {
            log.warn("the agents' access record wasn't written ({}), so the last one is set aside: after a restart every "
                    + "agent waits for the member's setup until the next change is written", e.getClass().getSimpleName());
            retire(dir.resolve(FILE));
        }
    }

    /** The last file, moved where nothing reads it, or deleted; nothing to do when there's none. */
    private static void retire(Path file) {
        try {
            Files.move(file, file.resolveSibling(FILE + ".unsaved"), StandardCopyOption.REPLACE_EXISTING);
        } catch (java.nio.file.NoSuchFileException e) {
            // None yet: a restart reads nothing recorded already.
        } catch (IOException e) {
            try {
                Files.deleteIfExists(file);
            } catch (IOException again) {
                log.error("the agents' last access record couldn't be set aside: {}", again.getClass().getSimpleName());
            }
        }
    }

    /** How the record's bytes reach the disk: {@link #write}, or a test's that fails. */
    @FunctionalInterface
    interface Writer {
        void write(Path file, byte[] bytes) throws IOException;
    }

    private volatile Writer writer = AccessRecord::write;

    /** A test's writer, in place of {@link #write}. */
    void writerForTest(Writer testWriter) {
        this.writer = testWriter;
    }

    private static Map<String, Object> body(Map<String, Entry> entries) {
        Map<String, Object> agentsJson = new TreeMap<>();
        for (Map.Entry<String, Entry> e : entries.entrySet()) {
            agentsJson.put(e.getKey(), e.getValue().toJson());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("v", 1);
        body.put("agents", agentsJson);
        return body;
    }

    private Map<String, Entry> load(Path dir) {
        Path file = dir.resolve(FILE);
        try {
            if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
                return Map.of();
            }
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_BYTES) {
                return setAside(file, "not a file");
            }
            byte[] key = key(dir, false);
            if (key == null) {
                return setAside(file, "no key");
            }
            Map<String, Object> read = new LinkedHashMap<>(Json.parseObject(Files.readAllBytes(file)));
            Object mac = read.remove("mac");
            if (!(mac instanceof String claimed) || !Integer.valueOf(1).equals(intOf(read.get("v")))
                    || !(read.get("agents") instanceof Map<?, ?> listed) || read.size() != 2) {
                java.util.Arrays.fill(key, (byte) 0);
                return setAside(file, "shape");
            }
            boolean ok = MessageDigest.isEqual(claimed.getBytes(StandardCharsets.US_ASCII),
                    mac(key, read).getBytes(StandardCharsets.US_ASCII));
            java.util.Arrays.fill(key, (byte) 0);
            if (!ok) {
                return setAside(file, "mac");
            }
            Map<String, Entry> out = new TreeMap<>();
            for (Map.Entry<?, ?> e : listed.entrySet()) {
                Entry entry = Entry.fromJson(e.getValue());
                if (!(e.getKey() instanceof String id) || !AGENT_ID.matcher(id).matches() || entry == null) {
                    return setAside(file, "entry");
                }
                out.put(id, entry);
            }
            return Map.copyOf(out);
        } catch (IOException | GeneralSecurityException | JsonFormatException | RuntimeException e) {
            return setAside(file, e.getClass().getSimpleName());
        }
    }

    /** A record that didn't verify: kept aside for a look, and nothing recorded, so every agent waits for its setup. */
    private static Map<String, Entry> setAside(Path file, String why) {
        log.warn("the agents' access record didn't verify ({}), so every agent waits for the member's setup again", why);
        try {
            Files.move(file, file.resolveSibling(FILE + ".bad"), StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            try {
                Files.deleteIfExists(file);
            } catch (IOException again) {
                // The next save writes over it.
            }
        }
        return Map.of();
    }

    private static Integer intOf(Object value) {
        return value instanceof Number n && n.doubleValue() == n.intValue() ? n.intValue() : null;
    }

    static String mac(byte[] key, Map<String, Object> body) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(Canonical.json(body).getBytes(StandardCharsets.UTF_8)));
    }

    /** The record's key, made with {@code make} if there's none; null for none, or one that isn't 32 bytes. */
    private byte[] key(Path dir, boolean make) throws IOException {
        Path path = dir.resolve(KEY);
        if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && Files.size(path) == KEY_BYTES) {
            return Files.readAllBytes(path);
        }
        if (!make) {
            return null;
        }
        byte[] key = new byte[KEY_BYTES];
        random.nextBytes(key);
        Files.deleteIfExists(path);
        write(path, key);
        return key;
    }

    /** A new file that's 0600 from its creation, whatever the umask or the directory's mode (a self-hosted desk's). */
    private static FileChannel openPrivate(Path temporary) throws IOException {
        Set<StandardOpenOption> options = Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
        try {
            return FileChannel.open(temporary, options,
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        } catch (UnsupportedOperationException e) {
            return FileChannel.open(temporary, options); // not a POSIX file system: only in a test
        }
    }

    /** Written whole or not at all: a temporary file, an fsync, a rename and the directory's fsync; mode 0600. */
    static void write(Path file, byte[] bytes) throws IOException {
        Path temporary = file.resolveSibling(file.getFileName() + ".tmp");
        Files.deleteIfExists(temporary);
        try {
            try (FileChannel channel = openPrivate(temporary)) {
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            try {
                Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------"));
            } catch (UnsupportedOperationException e) {
                // Not a POSIX file system: only in a test.
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE);
            try (FileChannel directory = FileChannel.open(file.getParent(), StandardOpenOption.READ)) {
                directory.force(true);
            } catch (IOException e) {
                // Some file systems can't open a directory to sync it; the rename is still atomic.
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }
}
