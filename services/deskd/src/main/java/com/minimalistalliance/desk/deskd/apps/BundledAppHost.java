package com.minimalistalliance.desk.deskd.apps;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Runs the first-party apps bundled in deskd's image (API.md section 19, "Bundled apps") as deskd's own children, in its
 * container and as its uid, until the System Engineer's helper exists. What the helper would do, as far as an unprivileged
 * process can:
 *
 * <ul>
 *   <li><b>prepare</b> makes {@code <data>/<id>/data} and {@code cache} ({@code 0700}, deskd's), under deskd's directory on
 *       the volume ({@code /data/desk/apps}). No quota: deskd can't set one, so a bundled app's disk is bounded by its own
 *       code alone, and install keeps the Browser's 2 GiB floor.
 *   <li><b>start</b> runs {@code files/<run.exec>} from the image with exactly the contract's environment (section 1.5, with
 *       {@code MA_DESKD_UID} deskd's own uid), working directory its data, stdin from {@code /dev/null}, its output
 *       dropped (an app's log could name what the member reads), through {@code nice -n 10} where the image has it, and its
 *       {@code oom_score_adj} raised to 1000, as the app raises its own: in a full container the kernel takes it before
 *       deskd. The socket goes in {@code <run>/<id>/}, {@code 0700}, deskd's, in the container's private {@code /tmp}.
 *   <li><b>stop</b> is SIGTERM, then SIGKILL after the manifest's {@code stopTimeoutSec}.
 *   <li><b>status</b> says {@code oom-kill} for a SIGKILL deskd didn't send, which in a container nobody else can send to
 *       deskd's uid but the kernel.
 * </ul>
 *
 * Its memory and CPU are only what the app sizes itself to ({@code MA_APP_MEMORY_MAX}, {@code MA_APP_CPU_MAX}): no cgroup of
 * its own, and the container's limits are deskd's. It sees what deskd sees. Never during the AppCDS training run.
 */
final class BundledAppHost implements AppHost {

    private static final Logger log = LoggerFactory.getLogger(BundledAppHost.class);

    private static final Set<PosixFilePermission> OWNER_ONLY = PosixFilePermissions.fromString("rwx------");
    private static final Path NICE = Path.of("/usr/bin/nice");
    /** A SIGKILL, as the JDK reports a process a signal ended: 128 and the signal. */
    private static final int KILLED = 128 + 9;
    /** How long status waits for an app whose link just went to be reaped, so its end is known. */
    private static final Duration REAP = Duration.ofMillis(300);

    private record Child(Process process, AtomicBoolean stopping) {}

    private final Path dataRoot;
    private final Path runRoot;
    private final Function<String, BundledApps.Bundled> bundled;
    private final int ownUid;
    private final Map<String, Child> children = new ConcurrentHashMap<>();

    BundledAppHost(Path dataRoot, Path runRoot, Function<String, BundledApps.Bundled> bundled) {
        this.dataRoot = dataRoot;
        this.runRoot = runRoot;
        this.bundled = bundled;
        this.ownUid = ownUid();
    }

    @Override
    public String unavailable() {
        // Only ever set on the Dockerfile's training command line (DeskdApplication): no app runs there.
        return Boolean.getBoolean("ma.cds.train") ? "training" : null;
    }

    Path dataDir(String id) {
        return dataRoot.resolve(id).resolve("data");
    }

    Path cacheDir(String id) {
        return dataRoot.resolve(id).resolve("cache");
    }

    @Override
    public void prepare(String id, int uid, long diskMaxBytes) throws AppHostException {
        try {
            for (Path dir : List.of(dataRoot, dataRoot.resolve(id), dataDir(id), cacheDir(id))) {
                privateDirectory(dir);
            }
        } catch (IOException e) {
            throw new AppHostException("failed");
        }
    }

    @Override
    public synchronized void start(String id, int uid) throws AppHostException {
        BundledApps.Bundled app = bundled.apply(id);
        if (app == null) {
            throw new AppHostException("not_found");
        }
        Child running = children.get(id);
        if (running != null && running.process().isAlive()) {
            // A running app is left as it is, as systemd's start of an active unit is.
            return;
        }
        Path socket = socket(id);
        try {
            privateDirectory(runRoot);
            privateDirectory(socket.getParent());
            Files.deleteIfExists(socket);
            if (!Files.isDirectory(dataDir(id), LinkOption.NOFOLLOW_LINKS)) {
                prepare(id, uid, 0);
            }
        } catch (IOException e) {
            throw new AppHostException("failed");
        }
        AppManifest m = app.manifest();
        List<String> command = new ArrayList<>();
        if (Files.isExecutable(NICE)) {
            command.addAll(List.of(NICE.toString(), "-n", "10", "--"));
        }
        command.add(app.files().resolve(m.run().exec().get(0)).toString());
        command.addAll(m.run().exec().subList(1, m.run().exec().size()));
        ProcessBuilder pb = new ProcessBuilder(command)
                .directory(dataDir(id).toFile())
                .redirectInput(ProcessBuilder.Redirect.from(new File("/dev/null")))
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD);
        Map<String, String> env = pb.environment();
        env.clear();
        env.put("MA_APP_ID", id);
        env.put("MA_APP_VERSION", m.version());
        env.put("MA_APP_API", AppsModule.APP_API);
        env.put("MA_APP_SOCKET", socket.toString());
        env.put("MA_APP_DATA", dataDir(id).toString());
        env.put("MA_APP_CACHE", cacheDir(id).toString());
        env.put("MA_APP_MEMORY_MAX", String.valueOf(m.resources().memoryMaxBytes()));
        env.put("MA_APP_CPU_MAX", String.valueOf(m.resources().cpuMax()));
        env.put("MA_DESKD_UID", String.valueOf(ownUid));
        env.put("HOME", dataDir(id).toString());
        Process process;
        try {
            process = pb.start();
        } catch (IOException e) {
            log.warn("apps: a bundled app couldn't be started");
            throw new AppHostException("failed");
        }
        raiseOomScore(process.pid());
        children.put(id, new Child(process, new AtomicBoolean()));
        log.info("apps: a bundled app started");
    }

    @Override
    public void stop(String id) throws InterruptedException {
        Child child = children.get(id);
        if (child == null || !child.process().isAlive()) {
            return;
        }
        child.stopping().set(true);
        BundledApps.Bundled app = bundled.apply(id);
        int grace = app == null ? 5 : app.manifest().run().stopTimeoutSec();
        Process process = child.process();
        process.destroy();
        if (!process.waitFor(grace, TimeUnit.SECONDS)) {
            log.info("apps: a bundled app didn't stop on SIGTERM, so it's killed");
            process.destroyForcibly();
            process.waitFor(5, TimeUnit.SECONDS);
        }
    }

    @Override
    public Status status(String id) throws InterruptedException {
        Child child = children.get(id);
        if (child == null) {
            return new Status(Status.STOPPED, null);
        }
        Process process = child.process();
        if (process.isAlive() && !process.waitFor(REAP.toMillis(), TimeUnit.MILLISECONDS)) {
            return new Status(Status.RUNNING, null);
        }
        int code = process.exitValue();
        if (child.stopping().get()) {
            return new Status(Status.STOPPED, null);
        }
        if (code == KILLED) {
            return new Status(Status.FAILED, Status.OOM);
        }
        return new Status(code == 0 ? Status.STOPPED : Status.FAILED, code == 0 ? null : "exit-code");
    }

    @Override
    public void remove(String id, int uid, boolean deleteData) throws InterruptedException, AppHostException {
        stop(id);
        children.remove(id);
        if (!deleteData) {
            return;
        }
        try {
            AppStore.deleteTree(dataDir(id));
            AppStore.deleteTree(cacheDir(id));
            Path dir = dataRoot.resolve(id);
            if (Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
                try (DirectoryStream<Path> left = Files.newDirectoryStream(dir)) {
                    if (!left.iterator().hasNext()) {
                        Files.delete(dir);
                    }
                }
            }
        } catch (IOException e) {
            throw new AppHostException("failed");
        }
    }

    @Override
    public Path socket(String id) {
        return runRoot.resolve(id).resolve("app.sock");
    }

    @Override
    public int peerUid(int appUid) {
        return ownUid;
    }

    /** deskd is stopping: its children stop too, each as {@link #stop} does. */
    @Override
    public void close() {
        for (String id : children.keySet()) {
            try {
                stop(id);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                for (Child child : children.values()) {
                    child.process().destroyForcibly();
                }
                return;
            }
        }
    }

    /** True while deskd has a child running for this app. */
    boolean running(String id) {
        Child child = children.get(id);
        return child != null && child.process().isAlive();
    }

    /** The pid of the app's process, for tests. */
    long pid(String id) {
        Child child = children.get(id);
        return child == null ? -1 : child.process().pid();
    }

    // ---- files

    /** A directory only deskd can enter: made {@code 0700}, or one that's there checked to be a directory and not a link. */
    private static void privateDirectory(Path dir) throws IOException {
        if (Files.exists(dir, LinkOption.NOFOLLOW_LINKS)) {
            if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("not a directory");
            }
            if (!Files.getPosixFilePermissions(dir, LinkOption.NOFOLLOW_LINKS).equals(OWNER_ONLY)) {
                Files.setPosixFilePermissions(dir, OWNER_ONLY);
            }
            return;
        }
        Files.createDirectory(dir, PosixFilePermissions.asFileAttribute(OWNER_ONLY));
        // The umask can take bits from what createDirectory asked for, never add them; this puts back exactly 0700.
        Files.setPosixFilePermissions(dir, OWNER_ONLY);
    }

    private static void raiseOomScore(long pid) {
        try {
            Files.writeString(Path.of("/proc", String.valueOf(pid), "oom_score_adj"), "1000", StandardCharsets.US_ASCII);
        } catch (IOException | RuntimeException e) {
            // The app raises its own too (contract section 1.5); this is the belt to its braces.
        }
    }

    static int ownUid() {
        try {
            return (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        } catch (IOException | RuntimeException e) {
            return -1;
        }
    }
}
