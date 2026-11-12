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
 * picker. And on a desk today no catalog app can be installed: no image has the System Engineer's helper
 * ({@code no_sandbox}), {@code /data/apps} ({@code no_storage}) or a review key, so every such install is refused before it
 * touches anything.
 *
 * <p><b>Bundled apps</b> ({@link BundledApps}, API.md section 19): first-party apps in deskd's own image, which install and
 * run without the helper, the catalog or a review key, kept in {@code /data/desk/apps} and run by {@link BundledAppHost}.
 * Their files are checked at start, on a thread of their own; every {@code apps.*} waits for that, which is quick.
 *
 * <p><b>On, with a kill switch:</b> {@code /data/desk/apps-switch} ({@link AppsSwitch}).
 *
 * <p><b>Members leaving</b> (a guild desk, API.md section 19): each running app is told which members' data it keeps,
 * {@code app.members.retain}, after each HELLO and whenever the roster or a purge changes, only when the roster passes the
 * guard of the agent purges ({@link AppMembers}). An app that isn't running hears at its next start, and none is started
 * to be told.
 */
public final class AppsModule {

    private static final Logger log = LoggerFactory.getLogger(AppsModule.class);

    /** deskd's call to an app on a guild desk: the members whose data it keeps (API.md section 19, "Members leaving"). */
    public static final String RETAIN = "app.members.retain";
    /** The {@code appApi} this deskd speaks (section 5.4). */
    public static final String APP_API = "1.0";
    /**
     * The permissions this deskd can honour today. The rest need parts no desk has yet (the egress proxy's per-app ports for
     * {@code net}, the picker for {@code files.pick}, the click rule for {@code browser.open}, a second display for
     * {@code display}), so a version asking for one is {@code not_supported}, never installed half-working.
     */
    public static final Set<String> SUPPORTED_PERMISSIONS = Set.of(AppManifest.BACKGROUND);
    public static final String DEFAULT_ROOT = "/data/apps";
    /** Where the image keeps the apps it bundles: one directory each, as a package unpacks. */
    public static final String DEFAULT_BUNDLED = "/app/bundled-apps";
    /** Where a bundled app's socket directory goes: the container's own {@code /tmp}, short enough for 108 bytes. */
    public static final String DEFAULT_BUNDLED_RUN = "/tmp/ma-apps";
    /** Under deskd's directory on the volume: the bundled apps' registry, and each one's data, cache and summary. */
    public static final String BUNDLED_DATA = "apps";
    public static final List<String> DEFAULT_KEY_DIRS = List.of("/opt/ma/etc/app-keys", "/etc/ma/app-keys.d");
    private static final Duration DAILY = Duration.ofHours(24);
    private static final SecureRandom RANDOM = new SecureRandom();

    /**
     * Where things are on a desk; each is a setting in {@code deskd.env}. {@code switchDirectory} is deskd's own directory on
     * the volume, which holds the switch and the bundled apps' {@value #BUNDLED_DATA}.
     */
    public record Settings(Path root, Path switchDirectory, List<Path> keyDirectories, Path helperSocket, Path runRoot,
            Path bundledRoot, Path bundledRun) {}

    /** The apps bundled in the image, where their records are kept, and what runs them. */
    record Bundled(BundledApps apps, AppStore store, AppHost host) {
        static Bundled none() {
            return new Bundled(BundledApps.none(), null, null);
        }
    }

    final AppStore store;
    final AppsSwitch toggle;
    final AppHost host;
    final CatalogKeeper catalogs;
    final AppRuntime runtime;
    final AppInstaller installer;
    final AppTopics topics;
    final String arch;
    final BundledApps bundled;
    /** Null when this deskd bundles nothing (tests of the catalog's apps). */
    final AppRuntime.Home bundledHome;
    private final java.util.concurrent.CompletableFuture<Void> bundledLoaded = new java.util.concurrent.CompletableFuture<>();
    private final BooleanSupplier guildDesk;
    private final Supplier<String> timeZone;
    private final Clock clock;
    private final Supplier<List<AppKeys.TrustedKey>> reviewKeys;
    /** Keys the {@code session} pseudonyms are made with: per deskd run, never written anywhere. */
    private final byte[] sessionKey = new byte[32];
    private volatile Thread daily;
    private volatile AppMembers members;
    private final java.util.concurrent.atomic.AtomicLong retainTimerAt = new java.util.concurrent.atomic.AtomicLong(Long.MAX_VALUE);
    private final java.util.concurrent.atomic.AtomicBoolean dailyStarted = new java.util.concurrent.atomic.AtomicBoolean();
    private volatile boolean closed;

    /** As a desk has it. */
    public static AppsModule forDesk(Settings settings, RpcDispatcher dispatcher, EventHub hub, BooleanSupplier guildDesk,
            Supplier<String> timeZone, PlatformHttp http, Supplier<String> apiBase, Clock clock) {
        List<AppKeys.TrustedKey> keys = AppKeys.loadReviewKeys(settings.keyDirectories());
        AppStore store = new AppStore(settings.root());
        String arch = deskArch();
        BundledApps apps = new BundledApps(settings.bundledRoot(), arch);
        Path bundledData = settings.switchDirectory().resolve(BUNDLED_DATA);
        Bundled bundled = new Bundled(apps, new AppStore(bundledData, true),
                new BundledAppHost(bundledData, settings.bundledRun(), apps::find));
        // /data/apps and /data/desk are on the one data volume: whichever is there says how much is free.
        return new AppsModule(store, new AppsSwitch(settings.switchDirectory()),
                new HelperAppHost(settings.helperSocket(), settings.runRoot()), new PlatformAppSource(http, apiBase), () -> keys,
                arch, () -> Math.max(usable(settings.root()), usable(settings.switchDirectory())), dispatcher, hub, guildDesk,
                timeZone, clock, bundled);
    }

    AppsModule(AppStore store, AppsSwitch toggle, AppHost host, CatalogKeeper.Source source,
            Supplier<List<AppKeys.TrustedKey>> reviewKeys, String arch, LongSupplier freeBytes, RpcDispatcher dispatcher,
            EventHub hub, BooleanSupplier guildDesk, Supplier<String> timeZone, Clock clock) {
        this(store, toggle, host, source, reviewKeys, arch, freeBytes, dispatcher, hub, guildDesk, timeZone, clock, Bundled.none());
    }

    AppsModule(AppStore store, AppsSwitch toggle, AppHost host, CatalogKeeper.Source source,
            Supplier<List<AppKeys.TrustedKey>> reviewKeys, String arch, LongSupplier freeBytes, RpcDispatcher dispatcher,
            EventHub hub, BooleanSupplier guildDesk, Supplier<String> timeZone, Clock clock, Bundled bundled) {
        this.bundled = bundled.apps();
        this.bundledHome = bundled.store() == null ? null : new AppRuntime.Home(bundled.store(), bundled.host(), true);
        if (bundledHome == null) {
            bundledLoaded.complete(null);
        }
        this.store = store;
        this.toggle = toggle;
        this.host = host;
        this.reviewKeys = reviewKeys;
        this.arch = arch;
        this.guildDesk = guildDesk;
        this.timeZone = timeZone;
        this.clock = clock;
        RANDOM.nextBytes(sessionKey);
        this.catalogs = new CatalogKeeper(store, reviewKeys, source, clock);
        this.runtime = new AppRuntime(host, store, toggle);
        this.installer = new AppInstaller(store, host, runtime, catalogs, toggle, reviewKeys, arch, freeBytes, clock, this.bundled,
                bundledHome);
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
        if (bundledHome != null) {
            Thread.ofVirtual().name("apps-bundled").start(this::loadBundled);
        }
    }

    /**
     * Off deskd's start path: checks the image's bundled apps' files, then takes the bundled apps the member has installed
     * from {@code /data/desk/apps}, each at this image's version, and starts any {@code background} one. A trial deskd
     * stopped in the middle of is rolled back, and its data left (a re-add finds it). An installed app this image no
     * longer bundles is left out and kept, data and all.
     */
    private void loadBundled() {
        List<AppRuntime.Process> loaded = new ArrayList<>();
        try {
            Map<String, BundledApps.Bundled> offered = bundled.all();
            AppStore bundledStore = bundledHome.store();
            if (bundledStore.unavailable() == null) {
                if (!bundledStore.rollBackTrials().isEmpty()) {
                    log.info("apps: a bundled app's first install deskd stopped in the middle of was rolled back");
                }
                for (AppStore.Entry entry : bundledStore.entries().values()) {
                    if (!entry.installed()) {
                        continue;
                    }
                    BundledApps.Bundled b = offered.get(entry.id());
                    if (b == null) {
                        log.info("apps: an installed bundled app isn't in this image, so it's left out until one is");
                        continue;
                    }
                    loaded.add(runtime.put(keptKey(bundledStore, followImage(bundledStore, entry, b)), b.manifest(), bundledHome));
                }
            }
        } catch (IOException | RuntimeException e) {
            log.warn("apps: the bundled apps' registry couldn't be read; they stay off until deskd restarts");
        } finally {
            bundledLoaded.complete(null);
        }
        if (!loaded.isEmpty()) {
            topics.changed();
            runtime.resume(loaded);
        }
    }

    /**
     * A bundled app goes with deskd's image: its record takes the image's version and manifest. A revocation stands only
     * while the manifest is the one revoked. Grants stay as they were, and a permission they don't hold isn't honoured.
     */
    private AppStore.Entry followImage(AppStore bundledStore, AppStore.Entry e, BundledApps.Bundled b) throws IOException {
        if (b.version().equals(e.version()) && b.manifestSha256().equals(e.manifestSha256())) {
            return e;
        }
        boolean same = b.manifestSha256().equals(e.manifestSha256());
        AppStore.Entry next = new AppStore.Entry(e.id(), e.uid(), b.version(), null, e.tier(), e.grants(), e.state(),
                same ? e.disabled() : null, e.installedAt(), clock.instant().toString(), b.manifestSha256(), b.manifestSha256(),
                e.memberKey(), e.keyOverData(), false, null);
        bundledStore.put(next);
        log.info("apps: a bundled app follows this image's version");
        return next;
    }

    // ---- members leaving (a guild desk)

    /** The guild's roster, as apps may keep data for its members. Set once, by the guild module. */
    public void guildMembers(AppMembers value) {
        members = value;
        value.onChange(this::retainAll);
    }

    /** Every running app is told again who stays. None is started for it. */
    void retainAll() {
        for (AppRuntime.Process p : runtime.all()) {
            AppLink link = p.link;
            if (link != null && link.alive()) {
                retain(p);
            }
        }
    }

    /** {@code app.members.retain} to one app, on a thread of its own, one at a time per app; a wish meanwhile runs after. */
    void retain(AppRuntime.Process p) {
        if (members == null || !guildDesk.getAsBoolean() || closed) {
            return;
        }
        if (!p.retaining.compareAndSet(false, true)) {
            p.retainAgain.set(true);
            return;
        }
        Thread.ofVirtual().name("app-members").start(() -> {
            try {
                do {
                    p.retainAgain.set(false);
                    retainOnce(p);
                } while (p.retainAgain.get());
            } finally {
                p.retaining.set(false);
                if (p.retainAgain.get()) {
                    retain(p);
                }
            }
        });
    }

    private void retainOnce(AppRuntime.Process p) {
        AppMembers source = members;
        AppLink link = p.link;
        if (source == null || link == null || !link.alive()) {
            return;
        }
        String key = p.entry.memberKey();
        if (key == null || p.entry.keyOverData()) {
            // Its members' data is under pseudonyms of a key deskd no longer has: listing today's would delete it all.
            log.info("apps: an app's member key is new over data it already had, so it isn't told which members stay");
            return;
        }
        java.util.Set<String> ids = source.retained();
        if (ids == null || ids.isEmpty()) {
            log.info("apps: the guild's roster isn't one to delete by now, so no app is told which members stay");
            return;
        }
        byte[] secret = Base64.getDecoder().decode(key);
        List<String> pseudonyms = new ArrayList<>();
        for (String id : ids) {
            pseudonyms.add(pseudonym(secret, id));
        }
        java.util.Collections.sort(pseudonyms);
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("m", RETAIN);
        request.put("p", Map.of("members", pseudonyms));
        request.put("idem", uuid7());
        request.put("from", Map.of("kind", "desk"));
        try {
            Map<String, Object> reply = link.call(request, AppsMethods.CALL_TIMEOUT, null);
            Object removed = reply.get("removed");
            log.info("apps: an app keeps {} members' data and removed {}", pseudonyms.size(),
                    removed instanceof Number n ? n.longValue() : "an unknown number of others");
        } catch (RpcException e) {
            if (RpcException.NOT_FOUND.equals(e.code())) {
                log.info("apps: an app doesn't take {}", RETAIN);
            } else {
                log.info("apps: {} to an app failed: {}; it goes again at the next change or start", RETAIN, e.code());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        scheduleRetain(source.nextChangeAtMillis());
    }

    /** When an owed purge's grace ends, the apps are told again, as nothing else would tell them then. */
    private void scheduleRetain(long atMillis) {
        if (atMillis == Long.MAX_VALUE) {
            return;
        }
        long current = retainTimerAt.get();
        if (current <= atMillis || !retainTimerAt.compareAndSet(current, atMillis)) {
            return;
        }
        Thread.ofVirtual().name("app-members-timer").start(() -> {
            try {
                Thread.sleep(Math.max(0, atMillis - clock.millis()) + 1000);
            } catch (InterruptedException e) {
                return;
            }
            retainTimerAt.compareAndSet(atMillis, Long.MAX_VALUE);
            if (!closed) {
                retainAll();
            }
        });
    }

    /** A UUIDv7: 48 bits of Unix millis, then random, as an idem key is everywhere else. */
    static String uuid7() {
        long millis = System.currentTimeMillis();
        long high = (millis << 16) | 0x7000L | (RANDOM.nextInt() & 0x0fffL);
        long low = (RANDOM.nextLong() & 0x3fffffffffffffffL) | 0x8000000000000000L;
        return new java.util.UUID(high, low).toString();
    }

    /**
     * The member key beside the app's data is the one that counts: a registry restored from elsewhere takes it, and an entry
     * from before the file existed writes it. Best effort: a failure leaves the entry as it was.
     */
    private static AppStore.Entry keptKey(AppStore home, AppStore.Entry e) {
        if (!Files.isDirectory(home.appDir(e.id()))) {
            return e;
        }
        try {
            AppStore.MemberKey kept = home.readMemberKey(e.id());
            if (kept == null) {
                if (e.memberKey() != null) {
                    home.keepMemberKey(e.id(), new AppStore.MemberKey(e.memberKey(), e.keyOverData()));
                }
                return e;
            }
            if (kept.key().equals(e.memberKey()) && kept.overData() == e.keyOverData()) {
                return e;
            }
            AppStore.Entry next = new AppStore.Entry(e.id(), e.uid(), e.version(), e.previous(), e.tier(), e.grants(), e.state(),
                    e.disabled(), e.installedAt(), e.updatedAt(), e.packageSha256(), e.manifestSha256(), kept.key(),
                    kept.overData(), e.trial(), e.before());
            home.put(next);
            log.info("apps: an app's member key was taken from beside its data");
            return next;
        } catch (IOException | RuntimeException ex) {
            log.info("apps: an app's member key couldn't be kept beside its data");
            return e;
        }
    }

    /** Waits for the bundled apps to be checked and taken (a moment after deskd starts). */
    private void awaitBundled() {
        try {
            bundledLoaded.get(70, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (java.util.concurrent.ExecutionException | java.util.concurrent.TimeoutException e) {
            // Without them, then.
        }
    }

    /**
     * The daily check runs only on a desk with a catalog app installed: started at deskd's start if there is one, else at the
     * first install. Bundled apps come with deskd's image and never need it, so a desk with only those never asks the Platform.
     */
    void ensureDaily() {
        if (!closed && catalogAppsInstalled() && dailyStarted.compareAndSet(false, true)) {
            daily = Thread.ofVirtual().name("apps-daily").start(this::dailyLoop);
        }
    }

    private boolean catalogAppsInstalled() {
        return runtime.all().stream().anyMatch(p -> !p.home.bundled());
    }

    /** Closes deskd's links. Catalog apps run on, and the next deskd connects to them again; bundled apps, deskd's children, stop. */
    public void close() {
        closed = true;
        Thread d = daily;
        if (d != null) {
            d.interrupt();
        }
        runtime.close();
        runtime.detachAll();
        if (bundledHome != null) {
            bundledHome.host().close();
        }
    }

    private void removeQuietly(AppStore.Entry entry) {
        Thread.ofVirtual().name("apps-rollback").start(() -> {
            try {
                store.forgetMemberKey(entry.id());
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
            runtime.put(keptKey(store, entry), manifest);
        } catch (IOException | AppManifest.ManifestException | RuntimeException e) {
            log.warn("apps: an installed app's release is unreadable, so it's left out");
        }
    }

    /** Once a day while any app is installed: a fresh catalog, and any app it revokes stopped and disabled. */
    private void dailyLoop() {
        try {
            Thread.sleep(Duration.ofMinutes(5 + ThreadLocalRandom.current().nextInt(55)));
            while (!closed && catalogAppsInstalled()) {
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
                p.home.store().put(disabled);
            } catch (IOException e) {
                log.warn("apps: a revocation couldn't be written; the app is stopped anyway");
            }
            runtime.stop(entry.id());
            runtime.put(disabled, p.manifest, p.home);
            topics.endApp(entry.id(), RpcException.FORBIDDEN);
            topics.changed();
            log.warn("apps: an installed app was revoked by the catalog and is disabled");
        }
    }

    private boolean revoked(AppCatalog catalog, AppStore.Entry entry) {
        if (entry.manifestSha256() != null && catalog.packageRevoked(entry.manifestSha256())) {
            return true;
        }
        if (entry.uid() == AppStore.NO_UID) {
            // A bundled app has no signatures: only its manifest's hash can be revoked.
            return false;
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

    /**
     * Null if apps can be used here: catalog apps can, or this image bundles one that can. Else why not, as for catalog
     * apps: {@code switched_off}, {@code no_storage}, {@code no_sandbox}.
     */
    String unavailable() {
        String why = catalogUnavailable();
        return why == null || (!"switched_off".equals(why) && bundledUsable(true)) ? null : why;
    }

    /** Null if apps from the catalog can be installed and run here; else why not. */
    String catalogUnavailable() {
        if (!toggle.on()) {
            return "switched_off";
        }
        String why = store.unavailable();
        return why != null ? why : host.unavailable();
    }

    /** Whether this image bundles an app that passed its check, and deskd can keep and run it. */
    private boolean bundledUsable(boolean wait) {
        return bundledHome != null && (wait ? !bundled.all().isEmpty() : bundled.offered() > 0)
                && bundledHome.store().unavailable() == null && bundledHome.host().unavailable() == null;
    }

    Map<String, Object> list() {
        awaitBundled();
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

    /**
     * The catalog as the Desk app reads it: this image's bundled apps first, each marked {@code bundled}, then the Platform's,
     * less any id this deskd bundles. The Platform's is fetched only where a catalog app could be installed, so a desk without
     * the helper or the volume's directory never asks for it, and lists only its bundled apps, with {@code seq} and
     * {@code issuedAt} null.
     */
    @SuppressWarnings("unchecked")
    Map<String, Object> catalogJson() throws InterruptedException {
        awaitBundled();
        Map<String, Object> json = new LinkedHashMap<>();
        String why = unavailable();
        json.put("available", why == null);
        json.put("reason", why);
        AppCatalog catalog = catalogUnavailable() == null ? catalogs.fresh(AppInstaller.CATALOG_AGE) : null;
        if (catalog != null) {
            applyRevocations(catalog);
        }
        Map<String, String> installed = new LinkedHashMap<>();
        for (AppRuntime.Process p : runtime.all()) {
            installed.put(p.id, p.entry.version());
        }
        Map<String, BundledApps.Bundled> offered = bundledUsable(false) ? bundled.all() : Map.of();
        Map<String, Object> out = null;
        if (catalog != null) {
            out = catalog.toJson(arch, APP_API, SUPPORTED_PERMISSIONS, installed);
        } else if (why == null && !offered.isEmpty()) {
            out = new LinkedHashMap<>();
            out.put("seq", null);
            out.put("issuedAt", null);
            out.put("apps", List.of());
        }
        if (out != null) {
            List<Map<String, Object>> apps = new ArrayList<>();
            for (BundledApps.Bundled b : offered.values()) {
                AppRuntime.Process p = runtime.process(b.id());
                apps.add(BundledApps.catalogJson(b, p != null && p.home.bundled() ? p.entry.version() : null));
            }
            for (Map<String, Object> app : (List<Map<String, Object>>) out.get("apps")) {
                if (!offered.containsKey((String) app.get("id"))) {
                    apps.add(app);
                }
            }
            out.put("apps", apps);
        }
        json.put("catalog", out);
        return json;
    }

    /** Owner sessions, and guild members on a guild desk; and the switch. */
    void authorize(RpcPrincipal principal) throws RpcException {
        awaitBundled();
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

    /** For {@code GET /health}: counts only, never an app's id. Never waits for the bundled apps' check. */
    public Map<String, Object> health() {
        Map<String, Object> apps = new LinkedHashMap<>();
        String catalogWhy = catalogUnavailable();
        String why = catalogWhy == null || (!"switched_off".equals(catalogWhy) && bundledUsable(false)) ? null : catalogWhy;
        apps.put("state", why == null ? "on" : "switched_off".equals(why) ? "off" : "unavailable");
        apps.put("reason", why);
        apps.putAll(runtime.counts());
        apps.put("bundled", bundled.offered());
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
            AppRuntime.Process p = runtime.process(id);
            if (p != null) {
                retain(p);
            }
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
