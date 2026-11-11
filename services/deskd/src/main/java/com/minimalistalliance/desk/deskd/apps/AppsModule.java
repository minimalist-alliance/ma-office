package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's half of the desk app contract (task 18, launch row S-97; the draft ADR's Desk Engineer review): verified signed
 * packages installed under {@code /data/apps} with rollback, the catalog the Desk app reads, and {@code appApi} relayed from
 * the Desk app to each app's own socket with the caller's identity. Wires {@link AppStore}, {@link CatalogKeeper},
 * {@link AppInstaller}, {@link AppRuntime}, {@link AppTopics} and {@link AppsMethods}.
 *
 * <p><b>Inert until an app is installed.</b> Nothing runs or is fetched on a desk with no apps until someone opens the
 * picker. And on a desk today nothing can be installed: no image has the System Engineer's helper ({@code no_sandbox}),
 * {@code /data/apps} ({@code no_storage}) or a review key, so every install is refused before it touches anything.
 *
 * <p><b>On, with a kill switch:</b> {@code /data/desk/apps-switch} ({@link AppsSwitch}).
 */
public final class AppsModule {

    private static final Logger log = LoggerFactory.getLogger(AppsModule.class);

    /** The {@code appApi} this deskd speaks (section 5.4). */
    public static final String APP_API = "1.0";
    /**
     * The permissions this deskd can honour today. The rest need parts no desk has yet (the egress proxy's per-app ports for
     * {@code net}, the picker for {@code files.pick}, the click rule for {@code browser.open}, a second display for
     * {@code display}), so a version asking for one is {@code not_supported}, never installed half-working.
     */
    public static final Set<String> SUPPORTED_PERMISSIONS = Set.of(AppManifest.BACKGROUND);
    public static final String DEFAULT_ROOT = "/data/apps";
    public static final List<String> DEFAULT_KEY_DIRS = List.of("/opt/ma/etc/app-keys", "/etc/ma/app-keys.d");
    private static final Duration DAILY = Duration.ofHours(24);
    private static final SecureRandom RANDOM = new SecureRandom();

    /** Where things are on a desk; each is a setting in {@code deskd.env}. */
    public record Settings(Path root, Path switchDirectory, List<Path> keyDirectories, Path helperSocket, Path runRoot) {}

    final AppStore store;
    final AppsSwitch toggle;
    final AppHost host;
    final CatalogKeeper catalogs;
    final AppRuntime runtime;
    final AppInstaller installer;
    final AppTopics topics;
    final String arch;
    private final BooleanSupplier guildDesk;
    private final Supplier<String> timeZone;
    private final Supplier<List<AppKeys.TrustedKey>> reviewKeys;
    /** Keys the {@code session} pseudonyms are made with: per deskd run, never written anywhere. */
    private final byte[] sessionKey = new byte[32];
    private volatile Thread daily;
    private final java.util.concurrent.atomic.AtomicBoolean dailyStarted = new java.util.concurrent.atomic.AtomicBoolean();
    private volatile boolean closed;

    /** As a desk has it. */
    public static AppsModule forDesk(Settings settings, RpcDispatcher dispatcher, EventHub hub, BooleanSupplier guildDesk,
            Supplier<String> timeZone, PlatformHttp http, Supplier<String> apiBase, Clock clock) {
        List<AppKeys.TrustedKey> keys = AppKeys.loadReviewKeys(settings.keyDirectories());
        AppStore store = new AppStore(settings.root());
        return new AppsModule(store, new AppsSwitch(settings.switchDirectory()),
                new HelperAppHost(settings.helperSocket(), settings.runRoot()), new PlatformAppSource(http, apiBase), () -> keys,
                deskArch(), () -> usable(settings.root()), dispatcher, hub, guildDesk, timeZone, clock);
    }

    AppsModule(AppStore store, AppsSwitch toggle, AppHost host, CatalogKeeper.Source source,
            Supplier<List<AppKeys.TrustedKey>> reviewKeys, String arch, LongSupplier freeBytes, RpcDispatcher dispatcher,
            EventHub hub, BooleanSupplier guildDesk, Supplier<String> timeZone, Clock clock) {
        this.store = store;
        this.toggle = toggle;
        this.host = host;
        this.reviewKeys = reviewKeys;
        this.arch = arch;
        this.guildDesk = guildDesk;
        this.timeZone = timeZone;
        RANDOM.nextBytes(sessionKey);
        this.catalogs = new CatalogKeeper(store, reviewKeys, source, clock);
        this.runtime = new AppRuntime(host, store, toggle);
        this.installer = new AppInstaller(store, host, runtime, catalogs, toggle, reviewKeys, arch, freeBytes, clock);
        this.topics = new AppTopics(hub, new TopicAccess());
        runtime.hooks(new RuntimeHooks());
        topics.register();
        new AppsMethods(this).register(dispatcher);
    }

    // ---- lifecycle

    /** Reads what's installed, puts the disk right, reconnects to apps that run on, and starts the daily check. */
    public void start() {
        if (store.unavailable() == null) {
            try {
                for (AppStore.Entry dropped : store.rollBackTrials()) {
                    log.info("apps: a first install deskd stopped in the middle of was rolled back");
                    removeQuietly(dropped);
                }
                store.reconcile();
                for (AppStore.Entry entry : store.entries().values()) {
                    if (entry.installed()) {
                        load(entry);
                    }
                }
            } catch (IOException | RuntimeException e) {
                // Never a reason for deskd not to start: apps stay off, and everything else runs.
                log.warn("apps: the registry couldn't be read; apps stay off until deskd restarts");
            }
        }
        runtime.start();
        runtime.resume();
        ensureDaily();
    }

    /** The daily check runs only on a desk with an app installed: started at deskd's start if there is one, else at the first install. */
    void ensureDaily() {
        if (!closed && !runtime.all().isEmpty() && dailyStarted.compareAndSet(false, true)) {
            daily = Thread.ofVirtual().name("apps-daily").start(this::dailyLoop);
        }
    }

    /** Closes deskd's links. Apps run on, and the next deskd connects to them again. */
    public void close() {
        closed = true;
        Thread d = daily;
        if (d != null) {
            d.interrupt();
        }
        runtime.close();
        runtime.detachAll();
    }

    private void removeQuietly(AppStore.Entry entry) {
        Thread.ofVirtual().name("apps-rollback").start(() -> {
            try {
                host.remove(entry.id(), entry.uid(), true);
            } catch (AppHost.AppHostException e) {
                log.info("apps: the helper couldn't clear a rolled-back first install: {}", e.code());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
    }

    private void load(AppStore.Entry entry) {
        try {
            AppManifest manifest = AppManifest.parse(store.manifestBytes(entry.id(), entry.version()));
            runtime.put(entry, manifest);
        } catch (IOException | AppManifest.ManifestException | RuntimeException e) {
            log.warn("apps: an installed app's release is unreadable, so it's left out");
        }
    }

    /** Once a day while any app is installed: a fresh catalog, and any app it revokes stopped and disabled. */
    private void dailyLoop() {
        try {
            Thread.sleep(Duration.ofMinutes(5 + ThreadLocalRandom.current().nextInt(55)));
            while (!closed && !runtime.all().isEmpty()) {
                if (toggle.on()) {
                    AppCatalog catalog = catalogs.fresh(Duration.ZERO);
                    if (catalog != null) {
                        applyRevocations(catalog);
                    }
                }
                Thread.sleep(DAILY.plusMinutes(ThreadLocalRandom.current().nextInt(60)));
            }
        } catch (InterruptedException e) {
            // Stopping.
        } finally {
            dailyStarted.set(false);
        }
    }

    /** Stops and disables every installed app the catalog revokes, by its manifest's hash or a key that signed it. */
    void applyRevocations(AppCatalog catalog) throws InterruptedException {
        for (AppRuntime.Process p : runtime.all()) {
            AppStore.Entry entry = p.entry;
            if (entry.disabled() != null || !revoked(catalog, entry)) {
                continue;
            }
            AppStore.Entry disabled = entry.withDisabled("revoked");
            try {
                store.put(disabled);
            } catch (IOException e) {
                log.warn("apps: a revocation couldn't be written; the app is stopped anyway");
            }
            runtime.stop(entry.id());
            runtime.put(disabled, p.manifest);
            topics.endApp(entry.id(), RpcException.FORBIDDEN);
            topics.changed();
            log.warn("apps: an installed app was revoked by the catalog and is disabled");
        }
    }

    private boolean revoked(AppCatalog catalog, AppStore.Entry entry) {
        if (entry.manifestSha256() != null && catalog.packageRevoked(entry.manifestSha256())) {
            return true;
        }
        try {
            for (AppKeys.Sig sig : AppKeys.parseSignatures(store.signatureBytes(entry.id(), entry.version()))) {
                if (catalog.revokedKeys().contains(sig.keyId())) {
                    return true;
                }
            }
        } catch (IOException | IllegalArgumentException e) {
            return false;
        }
        return false;
    }

    // ---- what the methods and topics read

    /** Null if apps can be used here; else why not: {@code switched_off}, {@code no_storage}, {@code no_sandbox}. */
    String unavailable() {
        if (!toggle.on()) {
            return "switched_off";
        }
        String why = store.unavailable();
        return why != null ? why : host.unavailable();
    }

    Map<String, Object> list() {
        Map<String, Object> json = new LinkedHashMap<>();
        String why = unavailable();
        json.put("available", why == null);
        json.put("reason", why);
        json.put("appApi", APP_API);
        List<Map<String, Object>> apps = new ArrayList<>();
        List<AppRuntime.Process> all = runtime.all();
        all.sort((a, b) -> a.id.compareTo(b.id));
        for (AppRuntime.Process p : all) {
            apps.add(runtime.describe(p));
        }
        json.put("apps", apps);
        return json;
    }

    Map<String, Object> catalogJson() throws InterruptedException {
        Map<String, Object> json = new LinkedHashMap<>();
        String why = unavailable();
        json.put("available", why == null);
        json.put("reason", why);
        // Only where an app could be installed: a desk without the helper or the volume's directory never asks the Platform.
        AppCatalog catalog = why == null ? catalogs.fresh(AppInstaller.CATALOG_AGE) : null;
        if (catalog != null) {
            applyRevocations(catalog);
        }
        Map<String, String> installed = new LinkedHashMap<>();
        for (AppRuntime.Process p : runtime.all()) {
            installed.put(p.id, p.entry.version());
        }
        json.put("catalog", catalog == null ? null : catalog.toJson(arch, APP_API, SUPPORTED_PERMISSIONS, installed));
        return json;
    }

    /** Owner sessions, and guild members on a guild desk; and the switch. */
    void authorize(RpcPrincipal principal) throws RpcException {
        if (!RpcPrincipal.OWNER.equals(principal.scope()) && !(principal.isGuildMember() && guildDesk.getAsBoolean())) {
            throw new RpcException(RpcException.FORBIDDEN, "The token doesn't allow this", Map.of("reason", "scope"));
        }
        if (!toggle.on()) {
            throw AppRuntime.unavailable("switched_off");
        }
    }

    /** What only the desk's owner, or a guild's Founder, may do: install, upgrade, remove, stop. */
    void authorizeManage(RpcPrincipal principal) throws RpcException {
        authorize(principal);
        if (principal.isGuildMember() && !Caller.LEAD.equals(principal.caller().role())) {
            throw new RpcException(RpcException.FORBIDDEN, "Only the guild's Founder manages its apps", Map.of("reason", "grant"));
        }
    }

    /**
     * Who's calling, as the app gets it (the review's change to section 5.3): never the member's name, account or a guild
     * member's id. {@code session} is a pseudonym for the desk session, under a key that lives only in this deskd's memory and
     * differs by app; a guild member's {@code member} is a pseudonym under the app's own key in the registry, stable for that
     * app on this desk and unlinkable across apps.
     */
    Map<String, Object> from(RpcPrincipal principal, AppRuntime.Process p) {
        Map<String, Object> from = new LinkedHashMap<>();
        from.put("kind", "view");
        from.put("session", pseudonym(sessionKey, p.id + '\0' + principal.sessionId()));
        from.put("caller", caller(principal.isGuildMember() ? principal.caller() : null, p));
        return from;
    }

    private Map<String, Object> caller(Caller caller, AppRuntime.Process p) {
        Map<String, Object> json = new LinkedHashMap<>();
        if (caller == null) {
            json.put("kind", Caller.OWNER);
            return json;
        }
        json.put("kind", Caller.GUILD_MEMBER);
        json.put("member", memberPseudonym(p, caller.memberId()));
        json.put("role", caller.role());
        json.put("grants", caller.grants());
        json.put("teen", caller.teen());
        return json;
    }

    private String memberPseudonym(AppRuntime.Process p, String memberId) {
        String key = p.entry.memberKey();
        byte[] secret = key == null ? sessionKey : Base64.getDecoder().decode(key);
        return pseudonym(secret, memberId);
    }

    static String pseudonym(byte[] key, String value) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            byte[] digest = mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
            return "p-" + Base64.getUrlEncoder().withoutPadding().encodeToString(digest).substring(0, 22);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** {@code desk.info.get}, the one thing an app may ask deskd in 1.0 that needs no permission (section 5.3). */
    Map<String, Object> deskInfo() {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("appApi", APP_API);
        json.put("deskApi", SessionManager.DESK_API);
        json.put("timeZone", timeZone.get());
        json.put("guildDesk", guildDesk.getAsBoolean());
        return json;
    }

    /** For {@code GET /health}: counts only, never an app's id. */
    public Map<String, Object> health() {
        Map<String, Object> apps = new LinkedHashMap<>();
        String why = unavailable();
        apps.put("state", why == null ? "on" : "switched_off".equals(why) ? "off" : "unavailable");
        apps.put("reason", why);
        apps.putAll(runtime.counts());
        apps.put("reviewKeys", reviewKeys.get().size());
        return Map.of("apps", apps);
    }

    static String deskArch() {
        String arch = System.getProperty("os.arch", "");
        return switch (arch) {
            case "aarch64", "arm64" -> "arm64";
            case "amd64", "x86_64" -> "amd64";
            default -> arch;
        };
    }

    private static long usable(Path root) {
        try {
            return Files.getFileStore(root).getUsableSpace();
        } catch (IOException e) {
            return 0;
        }
    }

    // ---- the parts' hooks

    private final class RuntimeHooks implements AppRuntime.Hooks {
        @Override
        public void changed() {
            topics.changed();
        }

        @Override
        public boolean inUse(String id) {
            return topics.inUse(id);
        }

        @Override
        public void linkUp(String id) {
            topics.linkUp(id);
        }

        @Override
        public void linkDown(String id) {
            topics.linkDown(id);
        }

        @Override
        public Object request(AppRuntime.Process process, String method, Map<String, Object> params) throws RpcException {
            switch (method) {
                case "desk.info.get":
                    return deskInfo();
                case "browser.open":
                case "files.pick":
                case "files.read":
                case "files.write":
                    // No app can hold these yet (SUPPORTED_PERMISSIONS), so it's never granted here.
                    throw new RpcException(RpcException.FORBIDDEN, "The app doesn't have this permission", Map.of("reason", "permission"));
                default:
                    throw new RpcException(RpcException.NOT_FOUND, "No such method");
            }
        }

        @Override
        public Map<String, Object> hello(AppRuntime.Process p) {
            AppManifest.Resources r = p.manifest.resources();
            Map<String, Object> limits = new LinkedHashMap<>();
            limits.put("memoryMaxBytes", r.memoryMaxBytes());
            limits.put("cpuMax", r.cpuMax());
            limits.put("diskMaxBytes", r.diskMaxBytes());
            limits.put("maxRequestBytes", 1 << 20);
            limits.put("maxEventBytes", 64 << 10);
            limits.put("requestsPerSecond", AppLink.APP_REQUESTS_PER_SECOND);
            Map<String, Object> hello = new LinkedHashMap<>();
            hello.put("appApi", APP_API);
            hello.put("deskApi", SessionManager.DESK_API);
            hello.put("app", Map.of("id", p.id, "version", p.entry.version()));
            hello.put("grants", p.entry.grants());
            hello.put("limits", limits);
            return hello;
        }
    }

    private final class TopicAccess implements AppTopics.Access {
        @Override
        public void authorize(RpcPrincipal principal) throws RpcException {
            AppsModule.this.authorize(principal);
        }

        @Override
        public Map<String, Object> list() {
            return AppsModule.this.list();
        }

        @Override
        public void requireTopic(String id, String topic) throws RpcException {
            AppRuntime.Process p = runtime.process(id);
            if (p == null || !p.manifest.topics().contains(topic)) {
                throw new RpcException(RpcException.NOT_FOUND, "No such topic");
            }
            if (AppRuntime.DISABLED.equals(p.state)) {
                throw new RpcException(RpcException.FORBIDDEN, "This app has been withdrawn", Map.of("reason", "revoked"));
            }
        }

        @Override
        public AppLink ensureRunning(String id) throws RpcException, InterruptedException {
            return runtime.ensureRunning(id, false);
        }

        @Override
        public AppLink ensureRunningIfAlive(String id) {
            AppRuntime.Process p = runtime.process(id);
            AppLink link = p == null ? null : p.link;
            return link != null && link.alive() ? link : null;
        }

        @Override
        public Map<String, Object> from(String id, String memberId) {
            AppRuntime.Process p = runtime.process(id);
            Map<String, Object> from = new LinkedHashMap<>();
            from.put("kind", "view");
            Map<String, Object> caller = new LinkedHashMap<>();
            if (memberId == null || p == null) {
                caller.put("kind", Caller.OWNER);
            } else {
                caller.put("kind", Caller.GUILD_MEMBER);
                caller.put("member", memberPseudonym(p, memberId));
            }
            from.put("caller", caller);
            return from;
        }
    }
}
