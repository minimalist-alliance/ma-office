package com.minimalistalliance.desk.deskd.apps;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.DirectoryStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The first-party apps bundled in deskd's own image (API.md section 19, "Bundled apps"), which deskd hosts itself until the
 * System Engineer's helper exists. Each is a directory {@code <root>/<id>/} holding exactly what a package unpacks to:
 * {@code ma-app.json}, with every file's SHA-256, size and mode, and {@code files/}. The image's build makes them
 * ({@code deskd/docker/bundle-app.go}); they're root's and read-only.
 *
 * <p><b>Checked once, at deskd's start, off its start path:</b> the manifest strictly, as a first-party package's, plus the
 * bundled ceiling (it shares deskd's container); the directory's name is its id; every file the manifest names is a regular
 * file of that size and hash, an executable one where it says {@code 0755}; and there's nothing else under {@code files/},
 * no link above all; the id is Minimalist Alliance's ({@value #FIRST_PARTY_IDS}); and the directory and everything in it
 * are root's with no group or other write (Security's L3), so nothing deskd's uid could have written passes, wherever
 * {@code DESKD_APPS_BUNDLED} points. One that fails any of it isn't offered, and the journal says which rule, never a value.
 * There's no signature: the files come from deskd's own image, which is what deskd itself is trusted as.
 */
final class BundledApps {

    private static final Logger log = LoggerFactory.getLogger(BundledApps.class);

    static final String MANIFEST = "ma-app.json";
    static final String FILES = "files";
    /**
     * At most what a bundled app may ask for. It runs in deskd's container, whose 512 MiB and CPU share it takes from deskd,
     * and nothing but its own runtime holds it to these (BundledAppHost), so they're small.
     */
    static final AppManifest.Resources CEILING = new AppManifest.Resources(64, 0.25, 32, 1024);
    private static final int MAX_APPS = 16;
    /** Bundled apps are Minimalist Alliance's own. */
    static final String FIRST_PARTY_IDS = "com.minimalistalliance.";
    /** Who must own every bundled file: root, as the image's build leaves them. */
    static final int ROOT = 0;
    private static final Duration WAIT = Duration.ofSeconds(60);

    /** One bundled app that passed every check. */
    record Bundled(String id, Path dir, AppManifest manifest, byte[] manifestBytes, String manifestSha256, long bytes) {
        Path files() {
            return dir.resolve(FILES);
        }

        String version() {
            return manifest.version();
        }
    }

    private final Path root;
    private final String arch;
    private final int owner;
    private final CompletableFuture<Map<String, Bundled>> checked = new CompletableFuture<>();
    private final AtomicBoolean begun = new AtomicBoolean();

    BundledApps(Path root, String arch) {
        this(root, arch, ROOT);
    }

    /** For tests, whose files are their own uid's. */
    BundledApps(Path root, String arch, int owner) {
        this.root = root;
        this.arch = arch;
        this.owner = owner;
    }

    /** None: for a deskd built without any, and for tests of the catalog's apps. */
    static BundledApps none() {
        BundledApps none = new BundledApps(null, "");
        none.begun.set(true);
        none.checked.complete(Map.of());
        return none;
    }

    /** Starts the check on a thread of its own, once. */
    void begin() {
        if (begun.compareAndSet(false, true)) {
            Thread.ofVirtual().name("apps-bundled-check").start(() -> checked.complete(scan()));
        }
    }

    /** The apps that passed, by id, once the check is done; none if it takes over a minute. Starts it if nothing has. */
    Map<String, Bundled> all() {
        begin();
        try {
            return checked.get(WAIT.toNanos(), TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Map.of();
        } catch (ExecutionException | TimeoutException e) {
            return Map.of();
        }
    }

    Bundled find(String id) {
        return all().get(id);
    }

    /** How many passed, without waiting: 0 until the check is done. */
    int offered() {
        return checked.getNow(Map.of()).size();
    }

    // ---- the check

    private Map<String, Bundled> scan() {
        if (root == null || !Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) {
            return Map.of();
        }
        try {
            owned(root, owner);
        } catch (Refused e) {
            log.warn("apps: the bundled apps' directory isn't root's alone, so none is offered");
            return Map.of();
        }
        long started = System.nanoTime();
        Map<String, Bundled> out = new TreeMap<>();
        List<Path> dirs = new ArrayList<>();
        try (DirectoryStream<Path> children = Files.newDirectoryStream(root)) {
            for (Path child : children) {
                dirs.add(child);
            }
        } catch (IOException e) {
            log.warn("apps: the bundled apps couldn't be listed, so none is offered");
            return Map.of();
        }
        Collections.sort(dirs);
        if (dirs.size() > MAX_APPS) {
            log.warn("apps: more than {} bundled apps, so none is offered", MAX_APPS);
            return Map.of();
        }
        for (Path dir : dirs) {
            try {
                Bundled b = check(dir, arch, owner);
                out.put(b.id(), b);
            } catch (Refused e) {
                log.warn("apps: a bundled app isn't offered: {}", e.getMessage());
            }
        }
        log.info("apps: {} bundled app(s) checked in {} ms", out.size(), (System.nanoTime() - started) / 1_000_000);
        return Collections.unmodifiableMap(out);
    }

    /** Every rule above, for one app's directory, its files root's. @throws Refused naming the rule, never a value */
    static Bundled check(Path dir, String arch) throws Refused {
        return check(dir, arch, ROOT);
    }

    static Bundled check(Path dir, String arch, int owner) throws Refused {
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
            throw new Refused("not a directory");
        }
        owned(dir, owner);
        owned(dir.resolve(MANIFEST), owner);
        byte[] raw;
        try {
            raw = AppStore.readSmall(dir.resolve(MANIFEST), AppManifest.MAX_BYTES);
        } catch (IOException e) {
            throw new Refused("ma-app.json: missing or too large");
        }
        AppManifest manifest;
        try {
            manifest = AppManifest.parse(raw);
        } catch (AppManifest.ManifestException e) {
            throw new Refused("ma-app.json: " + e.getMessage());
        }
        if (!manifest.id().equals(dir.getFileName().toString())) {
            throw new Refused("id: not its directory's name");
        }
        if (!manifest.id().startsWith(FIRST_PARTY_IDS)) {
            throw new Refused("id: not a first-party id");
        }
        List<String> problems = manifest.problems(AppManifest.FIRST_PARTY, arch, AppsModule.APP_API);
        if (!problems.isEmpty()) {
            throw new Refused(problems.get(0));
        }
        if (!manifest.resources().within(CEILING)) {
            throw new Refused("resources: over the bundled ceiling");
        }
        for (String permission : manifest.permissions()) {
            if (!AppsModule.SUPPORTED_PERMISSIONS.contains(permission)) {
                throw new Refused("permissions: not supported");
            }
        }
        Path files = dir.resolve(FILES);
        if (!Files.isDirectory(files, LinkOption.NOFOLLOW_LINKS)) {
            throw new Refused("files: missing");
        }
        Set<String> present = present(files, owner);
        if (!present.equals(new HashSet<>(manifest.files().keySet()))) {
            throw new Refused("files: not exactly the manifest's");
        }
        for (Map.Entry<String, AppManifest.FileEntry> e : manifest.files().entrySet()) {
            Path file = files.resolve(e.getKey());
            AppManifest.FileEntry want = e.getValue();
            try {
                if (Files.size(file) != want.size() || !sha256(file).equals(want.sha256())) {
                    throw new Refused("files: a hash or size doesn't match");
                }
            } catch (IOException ex) {
                throw new Refused("files: unreadable");
            }
            if (want.executable() && !Files.isExecutable(file)) {
                throw new Refused("files: a 0755 file isn't executable");
            }
        }
        return new Bundled(manifest.id(), dir, manifest, raw, AppManifest.sha256Hex(raw), manifest.filesBytes() + raw.length);
    }

    /**
     * Every regular file under {@code files/}, by its path there. A link, anything but a file or directory, or anything not
     * the owner's alone, refuses.
     */
    private static Set<String> present(Path files, int owner) throws Refused {
        Set<String> found = new HashSet<>();
        String[] refused = new String[1];
        try {
            Files.walkFileTree(files, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    try {
                        owned(dir, owner);
                        return FileVisitResult.CONTINUE;
                    } catch (Refused e) {
                        refused[0] = e.getMessage();
                        return FileVisitResult.TERMINATE;
                    }
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    if (!attrs.isRegularFile() || found.size() >= AppManifest.MAX_FILES) {
                        refused[0] = attrs.isRegularFile() ? "files: too many" : "files: a link or special file";
                        return FileVisitResult.TERMINATE;
                    }
                    try {
                        owned(file, owner);
                    } catch (Refused e) {
                        refused[0] = e.getMessage();
                        return FileVisitResult.TERMINATE;
                    }
                    found.add(files.relativize(file).toString().replace('\\', '/'));
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException e) {
                    refused[0] = "files: unreadable";
                    return FileVisitResult.TERMINATE;
                }
            });
        } catch (IOException e) {
            throw new Refused("files: unreadable");
        }
        if (refused[0] != null) {
            throw new Refused(refused[0]);
        }
        return found;
    }

    /** The owner's, with no group or other write, and not a link. */
    static void owned(Path path, int owner) throws Refused {
        try {
            Map<String, Object> attrs = Files.readAttributes(path, "unix:uid,mode", LinkOption.NOFOLLOW_LINKS);
            int mode = (Integer) attrs.get("mode");
            if ((Integer) attrs.get("uid") != owner || (mode & 0022) != 0 || (mode & 0170000) == 0120000) {
                throw new Refused("ownership: not root's alone");
            }
        } catch (IOException | RuntimeException e) {
            throw new Refused("ownership: unreadable");
        }
    }

    private static String sha256(Path file) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        byte[] buffer = new byte[64 << 10];
        try (InputStream in = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            for (int n; (n = in.read(buffer)) > 0; ) {
                digest.update(buffer, 0, n);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    /**
     * The image build's own check (the Dockerfile's last stage): every app under the directory passes exactly what deskd
     * checks at start, on the image's own arch, or the build fails. So an image never carries an app its deskd wouldn't offer.
     *
     * <pre>java -cp /app/deskd.jar com.minimalistalliance.desk.deskd.apps.BundledApps /app/bundled-apps</pre>
     */
    public static void main(String[] args) throws IOException {
        if (args.length != 1) {
            System.err.println("usage: BundledApps <dir>");
            System.exit(2);
        }
        Path root = Path.of(args[0]);
        List<Path> dirs = new ArrayList<>();
        if (Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) {
            try (DirectoryStream<Path> children = Files.newDirectoryStream(root)) {
                children.forEach(dirs::add);
            }
        }
        Collections.sort(dirs);
        int failed = dirs.size() > MAX_APPS ? 1 : 0;
        for (Path dir : dirs) {
            try {
                Bundled b = check(dir, AppsModule.deskArch());
                System.out.println("bundled: " + b.id() + " " + b.version() + ": offered, " + b.manifest().files().size() + " files");
            } catch (Refused e) {
                System.out.println("bundled: " + dir.getFileName() + ": not offered: " + e.getMessage());
                failed++;
            }
        }
        System.exit(failed == 0 ? 0 : 1);
    }

    /** What the catalog says of a bundled app (API.md section 19): one version, marked {@code bundled}, always installable. */
    static Map<String, Object> catalogJson(Bundled b, String installedVersion) {
        AppManifest m = b.manifest();
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("version", m.version());
        // There's no package: the manifest names every file's hash, so its own hash stands for the whole app.
        v.put("packageSha256", b.manifestSha256());
        v.put("bytes", b.bytes());
        v.put("appApi", m.appApi());
        v.put("permissions", m.permissions());
        List<Map<String, Object>> net = new ArrayList<>();
        for (AppManifest.NetHost host : m.net()) {
            net.add(Map.of("host", host.host(), "port", host.port(), "why", host.why()));
        }
        v.put("net", net);
        v.put("resources", m.resources().toJson());
        v.put("notes", null);
        v.put("installable", true);
        v.put("reason", null);
        v.put("bundled", true);
        Map<String, Object> app = new LinkedHashMap<>();
        app.put("id", b.id());
        app.put("name", m.name());
        app.put("publisher", m.publisher());
        app.put("description", m.description());
        app.put("installed", installedVersion);
        app.put("bundled", true);
        app.put("versions", List.of(v));
        return app;
    }

    /** A bundled app that fails a check. The message names the rule, never a value. */
    static final class Refused extends Exception {
        private static final long serialVersionUID = 1L;

        Refused(String rule) {
            super(rule, null, false, false);
        }
    }
}
