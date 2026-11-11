package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.DirectoryStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

/**
 * {@code /data/apps} as deskd keeps it (the desk app contract, section 1.4, as the Desk Engineer's review changes it):
 *
 * <pre>
 * /data/apps/                         desk 0700, made by the image; deskd's container mounts it
 * /data/apps/registry.json            deskd's record of every app, and the newest catalog seq taken, written whole
 * /data/apps/&lt;id&gt;/                    made by the helper's prepare: desk 0700, the app's project quota
 * /data/apps/&lt;id&gt;/releases/&lt;version&gt;/   deskd's: ma-app.json, ma-app.sig, files/ (dirs 0755, files 0644 or 0755)
 * /data/apps/&lt;id&gt;/releases/.staging-*  a release being unpacked, renamed into place when whole
 * /data/apps/&lt;id&gt;/current, previous    symlinks to releases/&lt;version&gt;, each swapped by one rename
 * /data/apps/&lt;id&gt;/summary.json        deskd's: the widget's last summary
 * /data/apps/&lt;id&gt;/data, cache          the app's uid, 0700, made by the helper
 * </pre>
 *
 * The registry is the truth; the links follow it. Every change writes the release first, then the registry, then the links,
 * so a crash between any two leaves something {@link #reconcile} puts right at the next start. The export (S-86) already
 * leaves out {@code registry.json} and every {@code <dir>/releases}, {@code current}, {@code previous} and {@code cache}
 * ({@code tools/desk-data}'s {@code APP_PACKAGES}), so what goes is each app's {@code data} and its widget's summary. The
 * catalog isn't kept on the volume, only its {@code seq} (in the registry), as the floor a fetched one must reach.
 */
final class AppStore {

    static final String REGISTRY = "registry.json";
    static final String SUMMARY = "summary.json";
    static final String RELEASES = "releases";
    static final String CURRENT = "current";
    static final String PREVIOUS = "previous";
    static final String STAGING = ".staging-";
    /** The uids kept for apps (section 1.4), one per app, never reused while its data is kept. */
    static final int UID_FIRST = 2000;
    static final int UID_LAST = 2999;
    private static final int MAX_REGISTRY_BYTES = 4 << 20;
    private static final Pattern VERSION = Pattern.compile("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})");
    private static final SecureRandom RANDOM = new SecureRandom();

    /**
     * {@link #installed} while a release is there to run; {@link #kept} after a removal that kept the app's data.
     * {@code trial} while a new version hasn't answered its trial start yet, with {@code before} the entry it replaced (null
     * for a first install): a deskd that stops mid-trial leaves this, and the next start rolls it back ({@link #rollBackTrials}).
     */
    record Entry(
            String id,
            int uid,
            String version,
            String previous,
            String tier,
            List<String> grants,
            String state,
            String disabled,
            String installedAt,
            String updatedAt,
            String packageSha256,
            String manifestSha256,
            String memberKey,
            boolean trial,
            Entry before) {
        static final String INSTALLED = "installed";
        static final String KEPT = "kept";

        boolean installed() {
            return INSTALLED.equals(state);
        }

        Entry withState(String state, String version, String previous) {
            return new Entry(id, uid, version, previous, tier, grants, state, disabled, installedAt, updatedAt, packageSha256,
                    manifestSha256, memberKey, false, null);
        }

        Entry withDisabled(String why) {
            return new Entry(id, uid, version, previous, tier, grants, state, why, installedAt, updatedAt, packageSha256,
                    manifestSha256, memberKey, trial, before);
        }

        /** The trial passed: nothing to go back to any more. */
        Entry passed() {
            return new Entry(id, uid, version, previous, tier, grants, state, disabled, installedAt, updatedAt, packageSha256,
                    manifestSha256, memberKey, false, null);
        }

        Map<String, Object> toJson() {
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("id", id);
            json.put("uid", uid);
            json.put("version", version);
            json.put("previous", previous);
            json.put("tier", tier);
            json.put("grants", grants);
            json.put("state", state);
            json.put("disabled", disabled);
            json.put("installedAt", installedAt);
            json.put("updatedAt", updatedAt);
            json.put("packageSha256", packageSha256);
            json.put("manifestSha256", manifestSha256);
            json.put("memberKey", memberKey);
            json.put("trial", trial);
            json.put("before", before == null ? null : before.toJson());
            return json;
        }
    }

    private final Path root;
    private final ReentrantLock lock = new ReentrantLock();
    private Map<String, Entry> entries;
    private long catalogSeq;

    AppStore(Path root) {
        this.root = root;
    }

    Path root() {
        return root;
    }

    /** Null if deskd can keep apps here: the directory is there and is deskd's to write. Otherwise {@code no_storage}. */
    String unavailable() {
        return Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS) && Files.isWritable(root) ? null : "no_storage";
    }

    // ---- the registry

    /** Every app, by id, as last saved. Read from disk the first time. */
    Map<String, Entry> entries() throws IOException {
        lock.lock();
        try {
            if (entries == null) {
                entries = load();
            }
            return Map.copyOf(entries);
        } finally {
            lock.unlock();
        }
    }

    Entry entry(String id) throws IOException {
        return entries().get(id);
    }

    void put(Entry entry) throws IOException {
        lock.lock();
        try {
            entries();
            Map<String, Entry> next = new TreeMap<>(entries);
            next.put(entry.id(), entry);
            save(next, catalogSeq);
            entries = next;
        } finally {
            lock.unlock();
        }
    }

    void forget(String id) throws IOException {
        lock.lock();
        try {
            entries();
            Map<String, Entry> next = new TreeMap<>(entries);
            if (next.remove(id) != null) {
                save(next, catalogSeq);
            }
            entries = next;
        } finally {
            lock.unlock();
        }
    }

    /** The app's uid if it has one, else the lowest no other app holds. */
    int uidFor(String id) throws IOException, InstallException {
        Map<String, Entry> all = entries();
        Entry existing = all.get(id);
        if (existing != null) {
            return existing.uid();
        }
        Set<Integer> taken = new java.util.HashSet<>();
        for (Entry e : all.values()) {
            taken.add(e.uid());
        }
        for (int uid = UID_FIRST; uid <= UID_LAST; uid++) {
            if (!taken.contains(uid)) {
                return uid;
            }
        }
        throw new InstallException("too_many");
    }

    static String newMemberKey() {
        byte[] key = new byte[32];
        RANDOM.nextBytes(key);
        return Base64.getEncoder().encodeToString(key);
    }

    private Map<String, Entry> load() throws IOException {
        Path file = root.resolve(REGISTRY);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            return new TreeMap<>();
        }
        if (Files.size(file) > MAX_REGISTRY_BYTES) {
            throw new IOException("registry too large");
        }
        Map<String, Object> json;
        try {
            json = Json.parseObject(Files.readAllBytes(file));
        } catch (JsonFormatException e) {
            throw new IOException("registry unreadable");
        }
        catalogSeq = json.get("catalogSeq") instanceof Number n && n.longValue() > 0 ? n.longValue() : 0;
        Map<String, Entry> out = new TreeMap<>();
        if (json.get("apps") instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?>) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> e = (Map<String, Object>) item;
                    Entry entry = entry(e);
                    if (entry != null) {
                        out.put(entry.id(), entry);
                    }
                }
            }
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Entry entry(Map<String, Object> e) {
        Entry entry = entryAlone(e);
        if (entry == null || !Boolean.TRUE.equals(e.get("trial"))) {
            return entry;
        }
        Entry before = e.get("before") instanceof Map<?, ?> b ? entryAlone((Map<String, Object>) b) : null;
        return new Entry(entry.id(), entry.uid(), entry.version(), entry.previous(), entry.tier(), entry.grants(), entry.state(),
                entry.disabled(), entry.installedAt(), entry.updatedAt(), entry.packageSha256(), entry.manifestSha256(),
                entry.memberKey(), true, before != null && before.id().equals(entry.id()) && before.uid() == entry.uid() ? before : null);
    }

    private static Entry entryAlone(Map<String, Object> e) {
        String id = Json.string(e, "id");
        if (id == null || !(e.get("uid") instanceof Integer uid) || uid < UID_FIRST || uid > UID_LAST) {
            return null;
        }
        List<String> grants = new ArrayList<>();
        if (e.get("grants") instanceof List<?> list) {
            for (Object g : list) {
                if (g instanceof String s) {
                    grants.add(s);
                }
            }
        }
        String state = Json.string(e, "state");
        return new Entry(id, uid, Json.string(e, "version"), Json.string(e, "previous"), Json.string(e, "tier"), List.copyOf(grants),
                Entry.KEPT.equals(state) ? Entry.KEPT : Entry.INSTALLED, Json.string(e, "disabled"), Json.string(e, "installedAt"),
                Json.string(e, "updatedAt"), Json.string(e, "packageSha256"), Json.string(e, "manifestSha256"),
                Json.string(e, "memberKey"), false, null);
    }

    /** The newest catalog seq this desk has taken: a fetched catalog below it is a replay, and refused. */
    long catalogSeq() throws IOException {
        lock.lock();
        try {
            entries();
            return catalogSeq;
        } finally {
            lock.unlock();
        }
    }

    void catalogSeq(long seq) throws IOException {
        lock.lock();
        try {
            entries();
            if (seq > catalogSeq) {
                save(entries, seq);
                catalogSeq = seq;
            }
        } finally {
            lock.unlock();
        }
    }

    private void save(Map<String, Entry> all, long seq) throws IOException {
        List<Map<String, Object>> list = new ArrayList<>();
        for (Entry e : all.values()) {
            list.add(e.toJson());
        }
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("registry", 1);
        json.put("catalogSeq", seq);
        json.put("apps", list);
        writeAtomically(root.resolve(REGISTRY), Json.bytes(json));
    }

    // ---- releases

    Path appDir(String id) {
        return root.resolve(id);
    }

    Path release(String id, String version) {
        if (!VERSION.matcher(version).matches()) {
            throw new IllegalArgumentException("not a version");
        }
        return appDir(id).resolve(RELEASES).resolve(version);
    }

    /** A new, empty directory inside the app's releases, so it shares the app's quota project and renames into place. */
    Path newStaging(String id) throws IOException {
        Path releases = appDir(id).resolve(RELEASES);
        Files.createDirectories(releases);
        Path staging = releases.resolve(STAGING + HexFormat.of().formatHex(randomBytes(8)));
        Files.createDirectory(staging, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwxr-xr-x")));
        return staging;
    }

    /** Puts a whole staged release in place. One already there under that version (left by a crash) goes first. */
    void place(String id, String version, Path staging) throws IOException {
        Path target = release(id, version);
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            deleteTree(target);
        }
        syncDirectory(staging);
        Files.move(staging, target, StandardCopyOption.ATOMIC_MOVE);
        syncDirectory(target.getParent());
    }

    /** Points {@code current} or {@code previous} at a release, or removes it for null, by one rename. */
    void point(String id, String link, String version) throws IOException {
        Path path = appDir(id).resolve(link);
        if (version == null) {
            Files.deleteIfExists(path);
            syncDirectory(appDir(id));
            return;
        }
        Path temporary = appDir(id).resolve("." + link + "-" + HexFormat.of().formatHex(randomBytes(4)));
        Files.createSymbolicLink(temporary, Path.of(RELEASES, version));
        try {
            Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
        syncDirectory(appDir(id));
    }

    /** The version a link points at, or null. */
    String pointed(String id, String link) {
        try {
            Path target = Files.readSymbolicLink(appDir(id).resolve(link));
            return target.getNameCount() == 2 && target.getName(0).toString().equals(RELEASES) ? target.getName(1).toString() : null;
        } catch (IOException | UnsupportedOperationException e) {
            return null;
        }
    }

    void deleteRelease(String id, String version) throws IOException {
        deleteTree(release(id, version));
    }

    /** Everything of deskd's in the app's directory: links, releases, staging and the summary. The helper's parts stay. */
    void clearReleases(String id) throws IOException {
        if (!Files.isDirectory(appDir(id), LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        point(id, CURRENT, null);
        point(id, PREVIOUS, null);
        deleteTree(appDir(id).resolve(RELEASES));
        deleteSummary(id);
    }

    /** The manifest's bytes in a placed release: {@code ma-app.json}, exactly as signed. */
    byte[] manifestBytes(String id, String version) throws IOException {
        return readSmall(release(id, version).resolve(PackageReader.MANIFEST), AppManifest.MAX_BYTES);
    }

    byte[] signatureBytes(String id, String version) throws IOException {
        return readSmall(release(id, version).resolve(PackageReader.SIGNATURES), AppKeys.MAX_SIG_FILE_BYTES);
    }

    /** A file of a placed release, under {@code files/}, at most {@code max} bytes. */
    byte[] releaseFile(String id, String version, String path, long max) throws IOException {
        if (!AppManifest.cleanPath(path)) {
            throw new IOException("not a clean path");
        }
        return readSmall(release(id, version).resolve(PackageReader.FILES).resolve(path), max);
    }

    /**
     * Rolls back every trial a stopped deskd left: the entry it replaced comes back, or for a first install the entry goes.
     * {@link #reconcile} then deletes the untried release.
     *
     * @return the first installs whose directories the helper should now remove
     */
    List<Entry> rollBackTrials() throws IOException {
        List<Entry> dropped = new ArrayList<>();
        for (Entry entry : entries().values()) {
            if (!entry.trial()) {
                continue;
            }
            if (entry.before() != null) {
                put(entry.before());
            } else {
                forget(entry.id());
                clearReleases(entry.id());
                dropped.add(entry);
            }
        }
        return dropped;
    }

    /**
     * Puts the disk back as the registry says: each installed app's links on its version and previous, kept apps with no
     * links, and every staging directory and release nobody points at deleted. An app directory the registry doesn't know
     * is left as it is: it may hold data the helper made, and only a removal deletes data.
     */
    void reconcile() throws IOException {
        for (Entry entry : entries().values()) {
            Path dir = appDir(entry.id());
            if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
                continue;
            }
            boolean installed = entry.installed();
            String version = installed ? entry.version() : null;
            String previous = installed ? entry.previous() : null;
            if (version != null && Files.isDirectory(release(entry.id(), version), LinkOption.NOFOLLOW_LINKS)) {
                if (!version.equals(pointed(entry.id(), CURRENT))) {
                    point(entry.id(), CURRENT, version);
                }
            } else if (Files.exists(dir.resolve(CURRENT), LinkOption.NOFOLLOW_LINKS)) {
                point(entry.id(), CURRENT, null);
            }
            if (previous != null && Files.isDirectory(release(entry.id(), previous), LinkOption.NOFOLLOW_LINKS)) {
                if (!previous.equals(pointed(entry.id(), PREVIOUS))) {
                    point(entry.id(), PREVIOUS, previous);
                }
            } else if (Files.exists(dir.resolve(PREVIOUS), LinkOption.NOFOLLOW_LINKS)) {
                point(entry.id(), PREVIOUS, null);
            }
            Path releases = dir.resolve(RELEASES);
            if (!Files.isDirectory(releases, LinkOption.NOFOLLOW_LINKS)) {
                continue;
            }
            try (DirectoryStream<Path> children = Files.newDirectoryStream(releases)) {
                for (Path child : children) {
                    String name = child.getFileName().toString();
                    if (!name.equals(version) && !name.equals(previous)) {
                        deleteTree(child);
                    }
                }
            }
        }
    }

    // ---- the widget's summary

    void saveSummary(String id, byte[] bytes) throws IOException {
        if (Files.isDirectory(appDir(id), LinkOption.NOFOLLOW_LINKS)) {
            writeAtomically(appDir(id).resolve(SUMMARY), bytes);
        }
    }

    byte[] loadSummary(String id) {
        try {
            return readSmall(appDir(id).resolve(SUMMARY), AppSummary.MAX_BYTES + 1024);
        } catch (IOException e) {
            return null;
        }
    }

    void deleteSummary(String id) throws IOException {
        Files.deleteIfExists(appDir(id).resolve(SUMMARY));
    }

    // ---- files

    /** Deletes a tree deskd made, never following a link out of it. A tree that isn't there is fine. */
    static void deleteTree(Path top) throws IOException {
        if (!Files.exists(top, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        if (!Files.isDirectory(top, LinkOption.NOFOLLOW_LINKS)) {
            Files.delete(top);
            return;
        }
        Files.walkFileTree(top, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path dir, IOException e) throws IOException {
                if (e != null) {
                    throw e;
                }
                // A directory deskd made read-only for the app is still its own to empty.
                Files.delete(dir);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    static byte[] readSmall(Path file, long max) throws IOException {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            throw new NoSuchFileException("not a regular file");
        }
        if (Files.size(file) > max) {
            throw new IOException("too large");
        }
        return Files.readAllBytes(file);
    }

    static void writeAtomically(Path file, byte[] bytes) throws IOException {
        Path temporary = file.resolveSibling("." + file.getFileName() + ".tmp");
        Files.deleteIfExists(temporary);
        try {
            try (FileChannel channel = FileChannel.open(temporary, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))) {
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            syncDirectory(file.getParent());
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    static void syncDirectory(Path directory) {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        } catch (IOException e) {
            // Some file systems can't open a directory to sync it; the rename is still atomic.
        }
    }

    private static byte[] randomBytes(int n) {
        byte[] bytes = new byte[n];
        RANDOM.nextBytes(bytes);
        return bytes;
    }
}
