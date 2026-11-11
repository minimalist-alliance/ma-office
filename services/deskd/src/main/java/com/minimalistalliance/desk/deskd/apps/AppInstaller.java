package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Installs, upgrades and removes apps under {@code /data/apps}, one at a time (the desk app contract, section 1.3, as the
 * Desk Engineer's review changes it).
 *
 * <p><b>Install or upgrade,</b> for a version in the verified catalog, with exactly the permissions the member saw:
 * <ol>
 *   <li>Refused before anything is touched: the switch, no sandbox, no catalog, a version the catalog doesn't list or lists
 *       with another hash, one this desk can't run ({@code app_api}, {@code not_supported}, {@code revoked}), grants that
 *       aren't the version's permissions, a downgrade, or less than the Browser's 2 GiB floor left after it.
 *   <li>{@code beginEffect}. The helper's {@code prepare} (directories, uid, quota). The package streams from the Platform
 *       into {@code releases/.staging-*}: its manifest and both signatures are checked before any file is written, each
 *       file's hash as it's written, the whole package's size and hash at the end.
 *   <li>The release is renamed into place, the registry written, {@code current} and {@code previous} swapped. A running old
 *       version is stopped first.
 *   <li>A trial start: the new version must answer HELLO within its {@code startTimeoutSec}. If it doesn't, everything goes
 *       back: the old version's record and links (and its run, if it ran), the new release deleted, and for a first install
 *       the app's directories too. The reply says {@code rolledBack: true}.
 * </ol>
 * Only {@code current} and {@code previous} are kept. <b>Remove</b> stops the app, deletes its releases and links, and asks the
 * helper to drop the rest; its data stays unless the member asked, and with it the app's uid, so a reinstall finds it.
 */
final class AppInstaller {

    private static final Logger log = LoggerFactory.getLogger(AppInstaller.class);

    /** What /data keeps free for the Browser's site storage (section 2.4, ADR 0035). */
    static final long BROWSER_FLOOR = 2L << 30;
    static final Duration CATALOG_AGE = Duration.ofMinutes(10);

    private final AppStore store;
    private final AppHost host;
    private final AppRuntime runtime;
    private final CatalogKeeper catalogs;
    private final AppsSwitch toggle;
    private final Supplier<List<AppKeys.TrustedKey>> reviewKeys;
    private final String arch;
    private final LongSupplier freeBytes;
    private final Clock clock;
    private final ReentrantLock busy = new ReentrantLock();

    AppInstaller(AppStore store, AppHost host, AppRuntime runtime, CatalogKeeper catalogs, AppsSwitch toggle,
            Supplier<List<AppKeys.TrustedKey>> reviewKeys, String arch, LongSupplier freeBytes, Clock clock) {
        this.store = store;
        this.host = host;
        this.runtime = runtime;
        this.catalogs = catalogs;
        this.toggle = toggle;
        this.reviewKeys = reviewKeys;
        this.arch = arch;
        this.freeBytes = freeBytes;
        this.clock = clock;
    }

    Map<String, Object> install(RpcContext context, String id, String version, String packageSha256, List<String> grants)
            throws RpcException, InterruptedException {
        if (!toggle.installs()) {
            throw AppRuntime.unavailable("switched_off");
        }
        String why = store.unavailable() != null ? store.unavailable() : host.unavailable();
        if (why != null) {
            throw AppRuntime.unavailable(why);
        }
        if (!busy.tryLock()) {
            throw new RpcException(RpcException.CONFLICT, "Another install is under way", Map.of("reason", "busy"));
        }
        try {
            return installLocked(context, id, version, packageSha256, grants);
        } finally {
            busy.unlock();
        }
    }

    private Map<String, Object> installLocked(RpcContext context, String id, String version, String packageSha256, List<String> grants)
            throws RpcException, InterruptedException {
        AppCatalog catalog = catalogs.fresh(CATALOG_AGE);
        if (catalog == null) {
            throw AppRuntime.unavailable("catalog");
        }
        AppCatalog.Version v = catalog.find(id, version, arch);
        if (v == null) {
            throw new RpcException(RpcException.NOT_FOUND, "No such version in the catalog", Map.of("reason", "version"));
        }
        if (!v.packageSha256().equals(packageSha256)) {
            throw precondition("catalog_changed");
        }
        String not = catalog.whyNot(v, AppsModule.APP_API, AppsModule.SUPPORTED_PERMISSIONS);
        if (not != null) {
            throw precondition(not);
        }
        if (!new HashSet<>(grants).equals(new HashSet<>(v.permissions())) || grants.size() != new HashSet<>(grants).size()) {
            throw new RpcException(RpcException.BAD_REQUEST, "grants must be exactly the version's permissions", Map.of("reason", "grants"));
        }
        AppStore.Entry old;
        try {
            old = store.entry(id);
        } catch (IOException e) {
            throw AppRuntime.unavailable("storage");
        }
        AppStore.Entry oldInstalled = old != null && old.installed() ? old : null;
        if (oldInstalled != null && oldInstalled.disabled() == null && version.equals(oldInstalled.version())) {
            AppRuntime.Process p = runtime.process(id);
            return reply(id, version, p == null ? AppRuntime.STOPPED : p.state);
        }
        if (oldInstalled != null && compare(version, oldInstalled.version()) < 0) {
            throw precondition("downgrade");
        }
        long diskBytes = declaredDisk(v);
        if (freeBytes.getAsLong() - Math.max(diskBytes, v.bytes()) < BROWSER_FLOOR) {
            throw precondition("no_space");
        }

        context.beginEffect();
        int uid;
        try {
            uid = store.uidFor(id);
        } catch (InstallException e) {
            throw precondition(e.reason());
        } catch (IOException e) {
            throw AppRuntime.unavailable("storage");
        }
        String memberKey = old != null && old.memberKey() != null ? old.memberKey() : AppStore.newMemberKey();
        try {
            host.prepare(id, uid, diskBytes);
        } catch (AppHost.AppHostException e) {
            throw AppRuntime.unavailable(e.code());
        }
        Path staging = null;
        PackageReader.Result result;
        String tier;
        try {
            staging = store.newStaging(id);
            String[] tierOut = new String[1];
            try (InputStream in = catalogs.source().openPackage(v.packageSha256())) {
                result = PackageReader.read(in, v.bytes(), v.packageSha256(),
                        (manifest, sigs) -> verify(catalog, v, manifest, sigs, tierOut), staging);
            }
            tier = tierOut[0];
            store.place(id, version, staging);
            staging = null;
        } catch (InstallException e) {
            discard(staging, id, uid, old);
            log.info("apps: an install was refused: {}", e.reason());
            throw "download".equals(e.reason()) ? AppRuntime.unavailable("download") : precondition(e.reason());
        } catch (IOException e) {
            discard(staging, id, uid, old);
            log.info("apps: an install failed: download or storage");
            throw AppRuntime.unavailable("download");
        }

        // The switch: the old one stopped, the new one recorded and pointed at.
        boolean wasRunning = runtime.running(id);
        AppManifest oldManifest = runtime.process(id) == null ? null : runtime.process(id).manifest;
        if (wasRunning) {
            runtime.stop(id);
        }
        String now = clock.instant().toString();
        AppStore.Entry next = new AppStore.Entry(id, uid, version, oldInstalled == null ? null : oldInstalled.version(), tier,
                List.copyOf(grants), AppStore.Entry.INSTALLED, null, oldInstalled == null ? now : oldInstalled.installedAt(), now,
                v.packageSha256(), v.manifestSha256(), memberKey, true, old);
        try {
            store.put(next);
            store.point(id, AppStore.CURRENT, version);
            store.point(id, AppStore.PREVIOUS, next.previous());
        } catch (IOException e) {
            rollback(id, version, old, oldManifest, wasRunning, uid);
            throw AppRuntime.unavailable("storage");
        }
        runtime.put(next, result.manifest());

        // The trial start.
        try {
            runtime.ensureRunning(id, true);
        } catch (RpcException e) {
            String reason = e.details().get("reason") instanceof String r ? r : "no_hello";
            rollback(id, version, old, oldManifest, wasRunning, uid);
            log.info("apps: a new version didn't start and was rolled back: {}", reason);
            Map<String, Object> details = new LinkedHashMap<>();
            details.put("reason", reason);
            details.put("rolledBack", true);
            // Everything went back, so as for any refusal nothing was done, and the reply is kept for a retry of this key.
            throw new RpcException(RpcException.PRECONDITION_FAILED, "The app didn't start, so nothing changed", details);
        }
        try {
            store.put(next.passed());
            runtime.put(next.passed(), result.manifest());
            store.reconcile();
        } catch (IOException e) {
            log.info("apps: the trial's end or an old release's pruning couldn't be written; the next start reconciles it");
        }
        log.info("apps: an app was {}", oldInstalled == null ? "installed" : "upgraded");
        AppRuntime.Process p = runtime.process(id);
        return reply(id, version, p == null ? AppRuntime.STOPPED : p.state);
    }

    /** The manifest and signatures, as the reader hands them over before any file is written. */
    private AppManifest verify(AppCatalog catalog, AppCatalog.Version v, byte[] manifestBytes, byte[] sigBytes, String[] tierOut)
            throws InstallException {
        if (!AppManifest.sha256Hex(manifestBytes).equals(v.manifestSha256())) {
            throw new InstallException("catalog");
        }
        if (catalog.packageRevoked(v.manifestSha256())) {
            throw new InstallException("revoked");
        }
        AppManifest manifest;
        try {
            manifest = AppManifest.parse(manifestBytes);
        } catch (AppManifest.ManifestException e) {
            throw new InstallException("manifest");
        }
        String tier;
        try {
            tier = AppKeys.verifyPackage(manifestBytes, AppKeys.parseSignatures(sigBytes), manifest.publisher(), reviewKeys.get(),
                    catalog.developers(), catalog.revokedKeys());
        } catch (SecurityException | IllegalArgumentException e) {
            throw new InstallException("signature");
        }
        if (!manifest.id().equals(v.id()) || !manifest.version().equals(v.version())
                || !manifest.problems(tier, arch, AppsModule.APP_API).isEmpty()) {
            throw new InstallException("manifest");
        }
        if (!new HashSet<>(manifest.permissions()).equals(new HashSet<>(v.permissions()))) {
            throw new InstallException("catalog");
        }
        if (!v.resources().isEmpty() && declaredDisk(v) != manifest.resources().diskMaxBytes()) {
            throw new InstallException("catalog");
        }
        for (String permission : manifest.permissions()) {
            if (!AppsModule.SUPPORTED_PERMISSIONS.contains(permission)) {
                throw new InstallException("not_supported");
            }
        }
        tierOut[0] = tier;
        return manifest;
    }

    /** The disk the catalog says the app may use, which its manifest must say too: the quota the helper sets first. */
    private static long declaredDisk(AppCatalog.Version v) {
        Object disk = v.resources().get("diskMaxMiB");
        int mib = disk instanceof Integer i && i > 0 ? i : AppManifest.DEFAULTS.diskMaxMiB();
        return (long) mib << 20;
    }

    /** After a refusal mid-install: the staging gone, and for an app that had nothing here before, its directories too. */
    private void discard(Path staging, String id, int uid, AppStore.Entry old) throws InterruptedException {
        try {
            if (staging != null) {
                AppStore.deleteTree(staging);
            }
        } catch (IOException e) {
            log.info("apps: a staging directory is left for the next start to clear");
        }
        if (old == null) {
            try {
                store.clearReleases(id);
            } catch (IOException e) {
                log.info("apps: a refused install's releases are left for the next start to clear");
            }
            try {
                host.remove(id, uid, true);
            } catch (AppHost.AppHostException e) {
                log.info("apps: the helper couldn't clear a refused install: {}", e.code());
            }
        }
    }

    /** Back to exactly what was there: the old record and links, its run if it ran, and the new release gone. */
    private void rollback(String id, String version, AppStore.Entry old, AppManifest oldManifest, boolean wasRunning, int uid)
            throws InterruptedException {
        runtime.stop(id);
        try {
            if (old != null && old.installed()) {
                store.put(old);
                store.point(id, AppStore.CURRENT, old.version());
                store.point(id, AppStore.PREVIOUS, old.previous());
                if (oldManifest != null) {
                    runtime.put(old, oldManifest);
                    runtime.reset(id);
                }
            } else {
                if (old != null) {
                    store.put(old);
                } else {
                    store.forget(id);
                }
                runtime.forget(id);
                store.clearReleases(id);
            }
            store.deleteRelease(id, version);
        } catch (IOException e) {
            log.warn("apps: a rollback couldn't finish on the volume; the next start reconciles it");
        }
        if (old == null) {
            try {
                host.remove(id, uid, true);
            } catch (AppHost.AppHostException e) {
                log.info("apps: the helper couldn't clear a rolled-back install: {}", e.code());
            }
        } else if (wasRunning && old.installed()) {
            try {
                runtime.ensureRunning(id, true);
            } catch (RpcException e) {
                log.info("apps: the old version didn't start again after a rollback: {}", e.code());
            }
        }
    }

    Map<String, Object> remove(RpcContext context, String id, boolean deleteData) throws RpcException, InterruptedException {
        if (!toggle.on()) {
            throw AppRuntime.unavailable("switched_off");
        }
        String why = store.unavailable() != null ? store.unavailable() : host.unavailable();
        if (why != null) {
            throw AppRuntime.unavailable(why);
        }
        if (!busy.tryLock()) {
            throw new RpcException(RpcException.CONFLICT, "Another install is under way", Map.of("reason", "busy"));
        }
        try {
            AppStore.Entry entry;
            try {
                entry = store.entry(id);
            } catch (IOException e) {
                throw AppRuntime.unavailable("storage");
            }
            if (entry == null || (!entry.installed() && !deleteData)) {
                throw new RpcException(RpcException.NOT_FOUND, "No such app", Map.of("reason", "app"));
            }
            context.beginEffect();
            runtime.stop(id);
            runtime.forget(id);
            try {
                store.clearReleases(id);
            } catch (IOException e) {
                throw AppRuntime.unavailable("storage");
            }
            try {
                host.remove(id, entry.uid(), deleteData);
            } catch (AppHost.AppHostException e) {
                // The releases are gone; the record stays, so the uid stays the app's and its data with it.
                persistKept(entry);
                throw AppRuntime.unavailable(e.code());
            }
            try {
                if (deleteData) {
                    store.forget(id);
                } else {
                    persistKept(entry);
                }
            } catch (IOException e) {
                throw AppRuntime.unavailable("storage");
            }
            log.info("apps: an app was removed{}", deleteData ? " with its data" : "");
            return Map.of();
        } finally {
            busy.unlock();
        }
    }

    private void persistKept(AppStore.Entry entry) {
        try {
            store.put(entry.withState(AppStore.Entry.KEPT, null, null));
        } catch (IOException e) {
            log.warn("apps: a removed app's record couldn't be written");
        }
    }

    private static Map<String, Object> reply(String id, String version, String state) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("id", id);
        json.put("version", version);
        json.put("state", state);
        return json;
    }

    private static RpcException precondition(String reason) {
        return new RpcException(RpcException.PRECONDITION_FAILED, "This version can't be installed here", Map.of("reason", reason));
    }

    /** Semantic order of two MAJOR.MINOR.PATCH versions; anything unreadable sorts first. */
    static int compare(String a, String b) {
        long[] x = parts(a);
        long[] y = parts(b);
        for (int i = 0; i < 3; i++) {
            if (x[i] != y[i]) {
                return Long.compare(x[i], y[i]);
            }
        }
        return 0;
    }

    private static long[] parts(String version) {
        long[] out = {-1, -1, -1};
        if (version == null) {
            return out;
        }
        String[] p = version.split("\\.");
        for (int i = 0; i < Math.min(3, p.length); i++) {
            try {
                out[i] = Long.parseLong(p[i]);
            } catch (NumberFormatException e) {
                return new long[] {-1, -1, -1};
            }
        }
        return out;
    }

}
