package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * An app's {@code ma-app.json} (the desk app contract, section 1.2), read strictly: a key this deskd doesn't know is refused,
 * so a field it can't honour (a permission above all) can never be ignored in silence. {@link #parse} checks the shape;
 * {@link #problems} the rules that depend on the desk (tier, arch, {@code appApi}). Both say what's wrong in words that name
 * a field, never a value, so they can go to the client and the journal.
 */
public final class AppManifest {

    /** The only manifest format there is. */
    public static final int FORMAT = 1;
    public static final int MAX_BYTES = 256 << 10;
    public static final int MAX_FILES = 4096;
    public static final int MAX_PATH_BYTES = 255;
    /** A window's three files together (section 3.2): the Desk app holds them in memory and checks every hash. */
    public static final long MAX_VIEW_BYTES = 512 << 10;

    public static final String COMMUNITY = "community";
    public static final String FIRST_PARTY = "first-party";

    public static final String BACKGROUND = "background";
    public static final String NET = "net";
    public static final String FILES_PICK = "files.pick";
    public static final String BROWSER_OPEN = "browser.open";
    public static final String DISPLAY = "display";
    /** The closed list of appApi 1.0 (section 4). None reaches the Browser's session, and none ever will. */
    public static final Set<String> PERMISSIONS = Set.of(BACKGROUND, NET, FILES_PICK, BROWSER_OPEN, DISPLAY);

    /** Method and topic names an app may not take: deskd's own families and the contract's. */
    static final List<String> RESERVED = List.of(
            "app.", "desk.", "apps.", "browser.", "files.", "notebook.", "chat.", "agent.", "guild.", "data.", "commons.");

    public record Run(List<String> exec, String start, int startTimeoutSec, int stopTimeoutSec) {
        public boolean background() {
            return BACKGROUND.equals(start);
        }
    }

    public record Resources(int memoryMaxMiB, double cpuMax, int tasksMax, int diskMaxMiB) {
        public long memoryMaxBytes() {
            return (long) memoryMaxMiB << 20;
        }

        public long diskMaxBytes() {
            return (long) diskMaxMiB << 20;
        }

        /** True if every limit here is at most the other's: an update within it needs no new consent (section 1.3). */
        public boolean within(Resources other) {
            return memoryMaxMiB <= other.memoryMaxMiB && cpuMax <= other.cpuMax && tasksMax <= other.tasksMax
                    && diskMaxMiB <= other.diskMaxMiB;
        }

        Map<String, Object> toJson() {
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("memoryMaxMiB", memoryMaxMiB);
            json.put("cpuMax", cpuMax);
            json.put("tasksMax", tasksMax);
            json.put("diskMaxMiB", diskMaxMiB);
            return json;
        }
    }

    public record NetHost(String host, int port, String why) {}

    public record Window(String html, String script, String style, int width, int height, int minWidth, int minHeight) {}

    public record FileEntry(String sha256, long size, String mode) {
        public boolean executable() {
            return "0755".equals(mode);
        }
    }

    /** The defaults for a resource left at zero (section 2.2). */
    public static final Resources DEFAULTS = new Resources(64, 0.25, 32, 64);
    /** The per-app ceilings by tier, for a 4 GiB desk (section 2.2, decisions 3 and 4). */
    public static final Map<String, Resources> CEILINGS = Map.of(
            COMMUNITY, new Resources(256, 0.5, 128, 1024),
            FIRST_PARTY, new Resources(1400, 1.0, 512, 4096));

    private static final Pattern ID = Pattern.compile("[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*){2,}");
    private static final Pattern VERSION = Pattern.compile("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})");
    private static final Pattern METHOD = Pattern.compile("[a-z][a-zA-Z0-9]*(\\.[a-z][a-zA-Z0-9]*)+");
    private static final Pattern TOPIC = Pattern.compile("[a-z][a-zA-Z0-9]*(\\.[a-z][a-zA-Z0-9]*)*");
    private static final Pattern HOST = Pattern.compile("([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}");
    private static final Pattern RANGE = Pattern.compile(">=([0-9]{1,4})\\.([0-9]{1,4}) <([0-9]{1,4})");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern API = Pattern.compile("([0-9]{1,4})\\.([0-9]{1,4})");

    private static final Set<String> TOP = Set.of(
            "manifest", "id", "name", "version", "publisher", "description", "source", "license", "appApi", "arch", "run",
            "resources", "permissions", "net", "views", "methods", "topics", "files");

    private final byte[] raw;
    private final String id;
    private final String name;
    private final String version;
    private final String publisher;
    private final String description;
    private final String source;
    private final String license;
    private final String appApi;
    private final String arch;
    private final Run run;
    private final Resources declared;
    private final List<String> permissions;
    private final List<NetHost> net;
    private final Window window;
    private final boolean widget;
    private final Map<String, Boolean> methods;
    private final List<String> topics;
    private final Map<String, FileEntry> files;

    private AppManifest(byte[] raw, Map<String, Object> json) throws ManifestException {
        this.raw = raw.clone();
        onlyKeys(json, TOP, "");
        if (!Integer.valueOf(FORMAT).equals(json.get("manifest"))) {
            throw new ManifestException("manifest");
        }
        id = string(json, "id", 64, true);
        name = string(json, "name", 32, true);
        version = string(json, "version", 32, true);
        publisher = string(json, "publisher", 128, true);
        description = string(json, "description", 140, false);
        source = string(json, "source", 512, false);
        license = string(json, "license", 64, false);
        appApi = string(json, "appApi", 32, true);
        arch = string(json, "arch", 16, true);
        run = run(object(json, "run", true));
        declared = resources(object(json, "resources", false));
        permissions = strings(json, "permissions", 16, 32);
        net = net(json.get("net"));
        Map<String, Object> views = object(json, "views", false);
        if (views != null) {
            onlyKeys(views, Set.of("window", "widget"), "views.");
            window = window(object(views, "window", false));
            Object w = views.get("widget");
            if (w != null && !(w instanceof Boolean)) {
                throw new ManifestException("views.widget");
            }
            widget = Boolean.TRUE.equals(w);
        } else {
            window = null;
            widget = false;
        }
        methods = methods(json.get("methods"));
        topics = strings(json, "topics", 64, 128);
        files = files(object(json, "files", true));
    }

    /**
     * Reads the bytes as signed, which are kept exactly as given.
     *
     * @throws ManifestException naming the first field that has the wrong shape
     */
    public static AppManifest parse(byte[] raw) throws ManifestException {
        if (raw.length == 0 || raw.length > MAX_BYTES) {
            throw new ManifestException("size");
        }
        Map<String, Object> json;
        try {
            json = Json.parseObject(raw);
        } catch (JsonFormatException e) {
            throw new ManifestException("json");
        }
        return new AppManifest(raw, json);
    }

    // ---- what the desk checks

    /**
     * Every rule of section 1.2 that holds for a desk of this tier, arch and appApi, in a stable order. Empty means it passes.
     * Each entry names a field and the rule, never a value from the manifest.
     */
    public List<String> problems(String tier, String deskArch, String deskAppApi) {
        List<String> p = new ArrayList<>();
        if (!ID.matcher(id).matches()) {
            p.add("id: reverse-DNS, lower case, at most 64 characters");
        }
        if (name.isEmpty() || name.codePointCount(0, name.length()) > 32 || hasControl(name)) {
            p.add("name: 1 to 32 characters");
        }
        if (description != null && hasControl(description)) {
            p.add("description: no control characters");
        }
        if (!VERSION.matcher(version).matches()) {
            p.add("version: MAJOR.MINOR.PATCH");
        }
        if (publisher.isEmpty() || hasControl(publisher)) {
            p.add("publisher: required");
        }
        if (COMMUNITY.equals(tier) && (isBlank(source) || isBlank(license))) {
            p.add("source and license: required for a community app");
        }
        if (!acceptsAppApi(deskAppApi)) {
            p.add("appApi: the range doesn't include this desk's");
        }
        if (!arch.equals(deskArch)) {
            p.add("arch: not this desk's");
        }
        if (run.exec().isEmpty()) {
            p.add("run.exec: required");
        } else {
            FileEntry exec = files.get(run.exec().get(0));
            if (exec == null || !exec.executable()) {
                p.add("run.exec: the first must be a file in the package with mode 0755");
            }
        }
        if (!"on-demand".equals(run.start()) && !BACKGROUND.equals(run.start())) {
            p.add("run.start: on-demand or background");
        } else if (BACKGROUND.equals(run.start()) && !permissions.contains(BACKGROUND)) {
            p.add("run.start: background needs the background permission");
        }
        if (run.startTimeoutSec() < 1 || run.startTimeoutSec() > 10) {
            p.add("run.startTimeoutSec: 1 to 10");
        }
        if (run.stopTimeoutSec() < 1 || run.stopTimeoutSec() > 10) {
            p.add("run.stopTimeoutSec: 1 to 10");
        }
        Resources ceiling = CEILINGS.get(tier);
        Resources r = resources();
        if (ceiling == null) {
            p.add("tier: unknown");
        } else {
            if (r.memoryMaxMiB() < 16 || r.memoryMaxMiB() > ceiling.memoryMaxMiB()) {
                p.add("resources.memoryMaxMiB: 16 to " + ceiling.memoryMaxMiB() + " for " + tier);
            }
            if (r.cpuMax() < 0.05 || r.cpuMax() > ceiling.cpuMax()) {
                p.add("resources.cpuMax: 0.05 to " + ceiling.cpuMax() + " for " + tier);
            }
            if (r.tasksMax() < 4 || r.tasksMax() > ceiling.tasksMax()) {
                p.add("resources.tasksMax: 4 to " + ceiling.tasksMax() + " for " + tier);
            }
            if (r.diskMaxMiB() < 1 || r.diskMaxMiB() > ceiling.diskMaxMiB()) {
                p.add("resources.diskMaxMiB: 1 to " + ceiling.diskMaxMiB() + " for " + tier);
            }
            if (filesBytes() > r.diskMaxBytes()) {
                p.add("files: more bytes than the app's own disk limit");
            }
        }
        Set<String> seenPermissions = new LinkedHashSet<>();
        for (String permission : permissions) {
            if (!PERMISSIONS.contains(permission) || !seenPermissions.add(permission)) {
                p.add("permissions: unknown or repeated");
            }
        }
        if (permissions.contains(DISPLAY) && !FIRST_PARTY.equals(tier)) {
            p.add("permissions: display is for reviewed first-party apps");
        }
        if (permissions.contains(NET) != !net.isEmpty()) {
            p.add("net: the net permission and a host list go together");
        }
        for (NetHost host : net) {
            if (!HOST.matcher(host.host()).matches() || host.port() != 443 || isBlank(host.why())) {
                p.add("net: each host needs a host name, port 443 and a reason");
                break;
            }
        }
        if (window != null) {
            long viewBytes = 0;
            for (String file : List.of(window.html(), window.script(), window.style())) {
                FileEntry entry = files.get(file);
                if (entry == null) {
                    p.add("views.window: its files must be in the package");
                    viewBytes = -1;
                    break;
                }
                viewBytes += entry.size();
            }
            if (viewBytes > MAX_VIEW_BYTES) {
                p.add("views.window: its files at most 512 KiB together");
            }
            if (window.minWidth() < 280 || window.minHeight() < 200 || window.width() < window.minWidth()
                    || window.height() < window.minHeight() || window.width() > 8192 || window.height() > 8192) {
                p.add("views.window: sizes at least 280x200, and the default at least the minimum");
            }
        }
        for (String method : methods.keySet()) {
            if (!METHOD.matcher(method).matches() || reserved(method) || method.length() > 128) {
                p.add("methods: dotted names outside the reserved namespaces");
                break;
            }
        }
        Set<String> seenTopics = new LinkedHashSet<>();
        for (String topic : topics) {
            if (!TOPIC.matcher(topic).matches() || reserved(topic) || !seenTopics.add(topic)) {
                p.add("topics: unique names outside the reserved namespaces");
                break;
            }
        }
        if (files.size() > MAX_FILES) {
            p.add("files: at most " + MAX_FILES);
        }
        for (Map.Entry<String, FileEntry> e : files.entrySet()) {
            if (!cleanPath(e.getKey())) {
                p.add("files: clean relative paths only");
                break;
            }
        }
        for (FileEntry entry : files.values()) {
            if (!"0644".equals(entry.mode()) && !"0755".equals(entry.mode())) {
                p.add("files: mode 0644 or 0755");
                break;
            }
            if (!SHA256.matcher(entry.sha256()).matches() || entry.size() < 0) {
                p.add("files: each needs a SHA-256 and a size");
                break;
            }
        }
        return List.copyOf(p);
    }

    /** True if this manifest's {@code appApi} range takes a desk speaking {@code MAJOR.MINOR}. */
    public boolean acceptsAppApi(String deskAppApi) {
        Matcher range = RANGE.matcher(appApi);
        Matcher have = API.matcher(deskAppApi == null ? "" : deskAppApi);
        if (!range.matches() || !have.matches()) {
            return false;
        }
        int loMajor = Integer.parseInt(range.group(1));
        int loMinor = Integer.parseInt(range.group(2));
        int hiMajor = Integer.parseInt(range.group(3));
        int major = Integer.parseInt(have.group(1));
        int minor = Integer.parseInt(have.group(2));
        if (major < loMajor || (major == loMajor && minor < loMinor)) {
            return false;
        }
        return major < hiMajor;
    }

    /** A clean relative path, as section 1.1 asks: no {@code ..}, no absolute, no empty or dot component, no backslash. */
    static boolean cleanPath(String path) {
        if (path.isEmpty() || path.getBytes(StandardCharsets.UTF_8).length > MAX_PATH_BYTES || path.startsWith("/")
                || path.endsWith("/") || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) {
            return false;
        }
        for (String part : path.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..") || hasControl(part)) {
                return false;
            }
        }
        return true;
    }

    static boolean reserved(String name) {
        for (String prefix : RESERVED) {
            if (name.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    // ---- reading it

    public byte[] raw() {
        return raw.clone();
    }

    public String id() {
        return id;
    }

    public String name() {
        return name;
    }

    public String version() {
        return version;
    }

    public String publisher() {
        return publisher;
    }

    public String description() {
        return description;
    }

    public String appApi() {
        return appApi;
    }

    public String arch() {
        return arch;
    }

    public Run run() {
        return run;
    }

    /** With the defaults filled in for anything left at zero. */
    public Resources resources() {
        Resources r = declared;
        return new Resources(
                r.memoryMaxMiB() == 0 ? DEFAULTS.memoryMaxMiB() : r.memoryMaxMiB(),
                r.cpuMax() == 0 ? DEFAULTS.cpuMax() : r.cpuMax(),
                r.tasksMax() == 0 ? DEFAULTS.tasksMax() : r.tasksMax(),
                r.diskMaxMiB() == 0 ? DEFAULTS.diskMaxMiB() : r.diskMaxMiB());
    }

    public List<String> permissions() {
        return permissions;
    }

    public boolean has(String permission) {
        return permissions.contains(permission);
    }

    public List<NetHost> net() {
        return net;
    }

    public Window window() {
        return window;
    }

    public boolean widget() {
        return widget;
    }

    /** Declared methods, each with whether it's a mutation. */
    public Map<String, Boolean> methods() {
        return methods;
    }

    public List<String> topics() {
        return topics;
    }

    public Map<String, FileEntry> files() {
        return files;
    }

    public long filesBytes() {
        long total = 0;
        for (FileEntry entry : files.values()) {
            total += entry.size();
        }
        return total;
    }

    /** What the Desk app shows of it: never the file list, which it gets with the view. */
    Map<String, Object> summaryJson() {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("id", id);
        json.put("name", name);
        json.put("version", version);
        json.put("publisher", publisher);
        json.put("description", description);
        json.put("appApi", appApi);
        json.put("start", run.start());
        json.put("resources", resources().toJson());
        json.put("permissions", permissions);
        List<Map<String, Object>> hosts = new ArrayList<>();
        for (NetHost host : net) {
            hosts.add(Map.of("host", host.host(), "port", host.port(), "why", host.why()));
        }
        json.put("net", hosts);
        Map<String, Object> views = new LinkedHashMap<>();
        if (window != null) {
            views.put("window", Map.of("width", window.width(), "height", window.height(), "minWidth", window.minWidth(),
                    "minHeight", window.minHeight()));
        } else {
            views.put("window", null);
        }
        views.put("widget", widget);
        json.put("views", views);
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map.Entry<String, Boolean> m : methods.entrySet()) {
            list.add(Map.of("name", m.getKey(), "mutation", m.getValue()));
        }
        json.put("methods", list);
        json.put("topics", topics);
        return json;
    }

    // ---- shape

    private static Run run(Map<String, Object> json) throws ManifestException {
        onlyKeys(json, Set.of("exec", "start", "startTimeoutSec", "stopTimeoutSec"), "run.");
        List<String> exec = strings(json, "exec", 16, 256);
        for (String arg : exec) {
            if (arg.isEmpty() || hasControl(arg)) {
                throw new ManifestException("run.exec");
            }
        }
        return new Run(exec, string(json, "start", 16, true), integer(json, "startTimeoutSec", "run."), integer(json, "stopTimeoutSec", "run."));
    }

    private static Resources resources(Map<String, Object> json) throws ManifestException {
        if (json == null) {
            return new Resources(0, 0, 0, 0);
        }
        onlyKeys(json, Set.of("memoryMaxMiB", "cpuMax", "tasksMax", "diskMaxMiB"), "resources.");
        Object cpu = json.getOrDefault("cpuMax", 0);
        if (!(cpu instanceof Number n) || !Double.isFinite(n.doubleValue()) || n.doubleValue() < 0) {
            throw new ManifestException("resources.cpuMax");
        }
        return new Resources(
                optionalInteger(json, "memoryMaxMiB", "resources."),
                ((Number) cpu).doubleValue(),
                optionalInteger(json, "tasksMax", "resources."),
                optionalInteger(json, "diskMaxMiB", "resources."));
    }

    private static List<NetHost> net(Object value) throws ManifestException {
        if (value == null) {
            return List.of();
        }
        if (!(value instanceof List<?> list) || list.size() > 16) {
            throw new ManifestException("net");
        }
        List<NetHost> hosts = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?>)) {
                throw new ManifestException("net");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> host = (Map<String, Object>) item;
            onlyKeys(host, Set.of("host", "port", "why"), "net.");
            hosts.add(new NetHost(string(host, "host", 253, true), integer(host, "port", "net."), string(host, "why", 140, true)));
        }
        return List.copyOf(hosts);
    }

    private static Window window(Map<String, Object> json) throws ManifestException {
        if (json == null) {
            return null;
        }
        onlyKeys(json, Set.of("html", "script", "style", "width", "height", "minWidth", "minHeight"), "views.window.");
        return new Window(
                string(json, "html", MAX_PATH_BYTES, true),
                string(json, "script", MAX_PATH_BYTES, true),
                string(json, "style", MAX_PATH_BYTES, true),
                integer(json, "width", "views.window."),
                integer(json, "height", "views.window."),
                integer(json, "minWidth", "views.window."),
                integer(json, "minHeight", "views.window."));
    }

    private static Map<String, Boolean> methods(Object value) throws ManifestException {
        if (value == null) {
            return Map.of();
        }
        if (!(value instanceof List<?> list) || list.size() > 256) {
            throw new ManifestException("methods");
        }
        Map<String, Boolean> methods = new LinkedHashMap<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?>)) {
                throw new ManifestException("methods");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> method = (Map<String, Object>) item;
            onlyKeys(method, Set.of("name", "mutation"), "methods.");
            String name = string(method, "name", 128, true);
            Object mutation = method.get("mutation");
            if (!(mutation instanceof Boolean) || methods.put(name, (Boolean) mutation) != null) {
                throw new ManifestException("methods");
            }
        }
        return Collections.unmodifiableMap(methods);
    }

    private static Map<String, FileEntry> files(Map<String, Object> json) throws ManifestException {
        if (json.size() > MAX_FILES) {
            throw new ManifestException("files");
        }
        Map<String, FileEntry> files = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : json.entrySet()) {
            if (!(e.getValue() instanceof Map<?, ?>)) {
                throw new ManifestException("files");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> file = (Map<String, Object>) e.getValue();
            onlyKeys(file, Set.of("sha256", "size", "mode"), "files.");
            Object size = file.get("size");
            if (!(size instanceof Integer || size instanceof Long) || ((Number) size).longValue() < 0) {
                throw new ManifestException("files.size");
            }
            files.put(e.getKey(), new FileEntry(string(file, "sha256", 64, true), ((Number) size).longValue(), string(file, "mode", 4, true)));
        }
        return Collections.unmodifiableMap(files);
    }

    private static void onlyKeys(Map<String, Object> json, Set<String> known, String prefix) throws ManifestException {
        for (String key : json.keySet()) {
            if (!known.contains(key)) {
                throw new ManifestException(prefix + "unknown field");
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Map<String, Object> json, String key, boolean required) throws ManifestException {
        Object value = json.get(key);
        if (value == null && !required) {
            return null;
        }
        if (!(value instanceof Map<?, ?>)) {
            throw new ManifestException(key);
        }
        return (Map<String, Object>) value;
    }

    private static String string(Map<String, Object> json, String key, int max, boolean required) throws ManifestException {
        Object value = json.get(key);
        if (value == null && !required) {
            return null;
        }
        if (!(value instanceof String s) || s.length() > max) {
            throw new ManifestException(key);
        }
        return s;
    }

    private static List<String> strings(Map<String, Object> json, String key, int maxItems, int maxChars) throws ManifestException {
        Object value = json.get(key);
        if (value == null) {
            return List.of();
        }
        if (!(value instanceof List<?> list) || list.size() > maxItems) {
            throw new ManifestException(key);
        }
        List<String> out = new ArrayList<>(list.size());
        for (Object item : list) {
            if (!(item instanceof String s) || s.length() > maxChars) {
                throw new ManifestException(key);
            }
            out.add(s);
        }
        return List.copyOf(out);
    }

    private static int integer(Map<String, Object> json, String key, String prefix) throws ManifestException {
        Object value = json.get(key);
        if (!(value instanceof Integer i)) {
            throw new ManifestException(prefix + key);
        }
        return i;
    }

    private static int optionalInteger(Map<String, Object> json, String key, String prefix) throws ManifestException {
        Object value = json.get(key);
        if (value == null) {
            return 0;
        }
        if (!(value instanceof Integer i) || i < 0) {
            throw new ManifestException(prefix + key);
        }
        return i;
    }

    private static boolean hasControl(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A manifest whose shape is wrong. The message names a field. */
    public static final class ManifestException extends Exception {
        private static final long serialVersionUID = 1L;

        public ManifestException(String field) {
            super(field, null, false, false);
        }
    }
}
