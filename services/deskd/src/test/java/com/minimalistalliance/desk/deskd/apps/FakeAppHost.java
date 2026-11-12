package com.minimalistalliance.desk.deskd.apps;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * The System Engineer's helper as a test double: {@code prepare} makes the app's directories (no uid or quota, which need
 * root), {@code start} runs a {@link FakeApp} for the current release in this JVM, {@code stop} closes it. Each version can be
 * told how its HELLO goes, and the next status can say the kernel killed it at its memory limit.
 *
 * <p>As a bundled host ({@code bundled}), it stands in for {@link BundledAppHost}: the same, with no release to look for, and
 * {@link #BUNDLED} as the version whose HELLO it's told.
 */
final class FakeAppHost implements AppHost {

    static final String BUNDLED = "bundled";

    final Path root;
    final Path runRoot;
    final boolean bundled;
    final List<String> calls = new CopyOnWriteArrayList<>();
    final Map<String, FakeApp.Hello> byVersion = new ConcurrentHashMap<>();
    final Map<String, FakeApp> running = new ConcurrentHashMap<>();
    private final Map<String, String> runningVersion = new ConcurrentHashMap<>();
    volatile String unavailable;
    volatile String failPrepare;
    volatile boolean oomNext;

    FakeAppHost(Path root, Path runRoot) {
        this(root, runRoot, false);
    }

    FakeAppHost(Path root, Path runRoot, boolean bundled) {
        this.root = root;
        this.runRoot = runRoot;
        this.bundled = bundled;
    }

    @Override
    public String unavailable() {
        return unavailable;
    }

    @Override
    public void prepare(String id, int uid, long diskMaxBytes) throws AppHostException {
        calls.add("prepare " + id + " " + uid + " " + diskMaxBytes);
        if (failPrepare != null) {
            throw new AppHostException(failPrepare);
        }
        try {
            Files.createDirectories(root.resolve(id).resolve("data"));
            Files.createDirectories(root.resolve(id).resolve("cache"));
        } catch (IOException e) {
            throw new AppHostException("failed");
        }
    }

    @Override
    public synchronized void start(String id, int uid) throws AppHostException {
        calls.add("start " + id);
        String version;
        if (bundled) {
            version = BUNDLED;
        } else {
            Path current = root.resolve(id).resolve("current");
            if (!Files.isRegularFile(current.resolve("ma-app.json"))) {
                throw new AppHostException("not_found");
            }
            try {
                version = Files.readSymbolicLink(current).getFileName().toString();
            } catch (IOException e) {
                throw new AppHostException("failed");
            }
        }
        // A unit that runs already is left as it is, as systemd's start of an active unit is.
        FakeApp old = running.get(id);
        if (old != null && version.equals(runningVersion.get(id)) && Files.exists(old.socket)) {
            return;
        }
        closeQuietly(running.remove(id));
        try {
            running.put(id, new FakeApp(socket(id), byVersion.getOrDefault(version, FakeApp.Hello.ANSWER)));
            runningVersion.put(id, version);
        } catch (IOException e) {
            throw new AppHostException("failed");
        }
    }

    @Override
    public synchronized void stop(String id) {
        calls.add("stop " + id);
        runningVersion.remove(id);
        closeQuietly(running.remove(id));
    }

    @Override
    public Status status(String id) {
        if (oomNext) {
            oomNext = false;
            return new Status(Status.FAILED, Status.OOM);
        }
        FakeApp app = running.get(id);
        return new Status(app != null ? Status.RUNNING : Status.STOPPED, null);
    }

    @Override
    public void remove(String id, int uid, boolean deleteData) {
        calls.add("remove " + id + " " + deleteData);
        stop(id);
        try {
            if (deleteData) {
                AppStore.deleteTree(root.resolve(id).resolve("data"));
                AppStore.deleteTree(root.resolve(id).resolve("cache"));
            }
            Path dir = root.resolve(id);
            if (Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
                try (var children = Files.list(dir)) {
                    if (children.findAny().isEmpty()) {
                        Files.delete(dir);
                    }
                }
            }
        } catch (IOException e) {
            // As the helper would report: nothing the test needs.
        }
    }

    @Override
    public Path socket(String id) {
        return runRoot.resolve(id).resolve("app.sock");
    }

    @Override
    public int peerUid(int appUid) {
        return ownUid();
    }

    FakeApp app(String id) {
        return running.get(id);
    }

    static int ownUid() {
        try {
            return (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void closeQuietly(FakeApp app) {
        if (app != null) {
            try {
                app.close();
            } catch (IOException e) {
                // Gone either way.
            }
        }
    }

    /** As the real bundled host: deskd's own children stop with it. The helper's units run on. */
    @Override
    public void close() {
        if (bundled) {
            closeAll();
        }
    }

    void closeAll() {
        for (String id : running.keySet()) {
            closeQuietly(running.remove(id));
        }
    }
}
