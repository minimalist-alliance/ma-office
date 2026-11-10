package com.minimalistalliance.desk.deskd.files;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.FileStore;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.NotDirectoryException;
import java.nio.file.Path;
import java.nio.file.SecureDirectoryStream;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributeView;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;

/**
 * The drive's Files tree, and the only code that touches it (files.md section 0, the ADR's decision 2). Every path is
 * walked from one open directory, a component at a time, with {@link SecureDirectoryStream} ({@code openat},
 * {@code renameat}, {@code unlinkat}) and {@code NOFOLLOW_LINKS} on every step, so a component swapped for a symlink
 * between a check and its use fails instead of escaping. Symlinks, devices, FIFOs, sockets, files with more than one
 * link and names that aren't valid NFC are not there as far as this class goes.
 *
 * <p>Components are plain strings and the class doesn't know the client's grammar: {@code .uploads} and {@code .trash} are
 * reachable here, for the module itself. {@link PathRules} is the client's door. One lock, {@link #lock}, orders every
 * change of the namespace, which is what makes "does it exist" and "rename" one step across a member's two tabs.
 *
 * <p>The one place the JDK has no {@code openat}-style call is {@code mkdir}. It goes by path, with the parent checked to
 * be under the real root first and the result checked to be the directory the stream sees.
 */
final class SafeTree implements AutoCloseable {

    /** @param size bytes for a file, -1 for a folder */
    record Entry(String name, boolean dir, long size, long mtimeMs) {}

    enum Kind {
        NOT_FOUND,
        NOT_A_DIR,
        EXISTS,
        NOT_EMPTY,
        IO
    }

    static final class TreeException extends Exception {
        private static final long serialVersionUID = 1L;
        private final Kind kind;

        TreeException(Kind kind) {
            super(kind.name(), null, false, false);
            this.kind = kind;
        }

        Kind kind() {
            return kind;
        }
    }

    /** The tree can't be used: wrong mode or owner, or no safe-open support on this filesystem. */
    static final class Unusable extends Exception {
        private static final long serialVersionUID = 1L;

        Unusable(String why) {
            super(why, null, false, false);
        }
    }

    /** A page of a listing. */
    record Page(List<Entry> entries, String next, int skipped) {}

    /** An open file for reading. */
    record Opened(FileChannel channel, long size, long mtimeMs) {}

    /** What a walk over a folder found. */
    record Tally(long bytes, long entries, boolean capped) {}

    private static final Set<PosixFilePermission> DIR_MODE = PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> FILE_MODE = PosixFilePermissions.fromString("rw-------");
    private static final LinkOption[] NOFOLLOW = {LinkOption.NOFOLLOW_LINKS};

    /** Held for every change of the namespace. */
    final ReentrantLock lock = new ReentrantLock();
    private final Path root;
    private final SecureDirectoryStream<Path> rootStream;

    private SafeTree(Path root, SecureDirectoryStream<Path> rootStream) {
        this.root = root;
        this.rootStream = rootStream;
    }

    /**
     * Opens the tree, making the directory (and {@code .uploads} and {@code .trash}) if it is missing.
     *
     * @param uid who must own it: -1 for whoever runs this process
     * @throws Unusable if it is not owned by that uid, not {@code 0700}, a symlink, or the filesystem has no safe open
     */
    static SafeTree open(Path root, int uid) throws Unusable {
        try {
            if (!Files.exists(root, NOFOLLOW)) {
                Files.createDirectories(root, PosixFilePermissions.asFileAttribute(DIR_MODE));
            }
            BasicFileAttributes attrs = Files.readAttributes(root, BasicFileAttributes.class, NOFOLLOW);
            if (!attrs.isDirectory() || attrs.isSymbolicLink()) {
                throw new Unusable("not a directory");
            }
            int want = uid >= 0 ? uid : (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
            int owner = (Integer) Files.getAttribute(root, "unix:uid", NOFOLLOW);
            if (owner != want) {
                throw new Unusable("owner");
            }
            int mode = (Integer) Files.getAttribute(root, "unix:mode", NOFOLLOW) & 07777;
            if (mode != 0700) {
                throw new Unusable("mode");
            }
            Path real = root.toRealPath();
            var stream = Files.newDirectoryStream(real);
            if (!(stream instanceof SecureDirectoryStream<Path> secure)) {
                stream.close();
                throw new Unusable("no safe open");
            }
            SafeTree tree = new SafeTree(real, secure);
            tree.ensureDir(new String[] {PathRules.UPLOADS});
            tree.ensureDir(new String[] {PathRules.TRASH});
            tree.probeNames();
            return tree;
        } catch (IOException | RuntimeException e) {
            throw new Unusable(e.getClass().getSimpleName());
        }
    }

    /**
     * Names are Unicode, and the JVM turns them into bytes by the locale. In a POSIX locale a name like {@code é} can't be
     * made, and every member's files would fail one by one; so check once, now, and say so instead.
     */
    private void probeNames() throws Unusable {
        String[] probe = {PathRules.UPLOADS, ".probe-\u00e9\u65e5\u672c.tmp"};
        try {
            deleteTree(probe);
            createNew(probe).close();
            Entry e;
            try (Dir uploads = openDir(new String[] {PathRules.UPLOADS})) {
                e = entryOf(uploads, probe[1], false);
            }
            deleteTree(probe);
            if (e == null) {
                throw new Unusable("encoding");
            }
        } catch (TreeException | IOException | RuntimeException ex) {
            throw new Unusable("encoding");
        }
    }

    private void ensureDir(String[] comps) throws IOException {
        try {
            mkdir(comps);
        } catch (TreeException e) {
            if (e.kind() != Kind.EXISTS) {
                throw new IOException(e.kind().name());
            }
        }
    }

    @Override
    public void close() {
        try {
            rootStream.close();
        } catch (IOException e) {
            // Going away.
        }
    }

    Path root() {
        return root;
    }

    /** The drive the tree is on. */
    FileStore store() throws IOException {
        return Files.getFileStore(root);
    }

    // ---- walking

    /** An open directory and the real path it stands for. Close it when done; the root's close does nothing. */
    final class Dir implements AutoCloseable {
        final SecureDirectoryStream<Path> stream;
        final Path real;
        private final boolean owned;

        Dir(SecureDirectoryStream<Path> stream, Path real, boolean owned) {
            this.stream = stream;
            this.real = real;
            this.owned = owned;
        }

        Dir sub(String name) throws TreeException {
            try {
                SecureDirectoryStream<Path> child = stream.newDirectoryStream(Path.of(name), NOFOLLOW);
                return new Dir(child, real.resolve(name), true);
            } catch (IOException | RuntimeException e) {
                throw new TreeException(classify(this, name, e));
            }
        }

        /**
         * Names one at a time, so a folder of a million files costs no memory. A stream's iterator can be had once, so each
         * visit opens the folder again by ".". The visitor returns false to stop.
         */
        void forEachName(java.util.function.Predicate<String> visitor) {
            try (SecureDirectoryStream<Path> again = stream.newDirectoryStream(Path.of("."), NOFOLLOW)) {
                for (Path p : again) {
                    if (!visitor.test(p.getFileName().toString())) {
                        return;
                    }
                }
            } catch (IOException | RuntimeException e) {
                // A folder that went away is empty now.
            }
        }

        /** Every name. Only for folders deskd keeps small itself (.uploads, .trash); never for the member's. */
        List<String> names() {
            List<String> out = new ArrayList<>();
            forEachName(out::add);
            return out;
        }

        BasicFileAttributes attrs(String name) throws IOException {
            return stream.getFileAttributeView(Path.of(name), BasicFileAttributeView.class, NOFOLLOW).readAttributes();
        }

        @Override
        public void close() {
            if (owned) {
                try {
                    stream.close();
                } catch (IOException e) {
                    // Abandoned.
                }
            }
        }
    }

    private Kind classify(Dir parent, String name, Exception failure) {
        if (failure instanceof NoSuchFileException) {
            return Kind.NOT_FOUND;
        }
        try {
            BasicFileAttributes attrs = parent.attrs(name);
            if (attrs.isRegularFile()) {
                return Kind.NOT_A_DIR;
            }
            if (attrs.isDirectory()) {
                return Kind.IO;
            }
            return Kind.NOT_FOUND;
        } catch (NoSuchFileException e) {
            return Kind.NOT_FOUND;
        } catch (IOException | RuntimeException e) {
            return Kind.IO;
        }
    }

    /** The root, or a directory under it. */
    Dir openDir(String[] comps) throws TreeException {
        return openDir(comps, comps.length);
    }

    /** The directory the first {@code count} components name. */
    Dir openDir(String[] comps, int count) throws TreeException {
        Dir current = new Dir(rootStream, root, false);
        for (int i = 0; i < count; i++) {
            Dir next;
            try {
                next = current.sub(comps[i]);
            } catch (TreeException e) {
                current.close();
                // A file in the middle of a path is not there for anything below it.
                throw e;
            }
            current.close();
            current = next;
        }
        return current;
    }

    private static String[] parentOf(String[] comps) {
        String[] parent = new String[comps.length - 1];
        System.arraycopy(comps, 0, parent, 0, parent.length);
        return parent;
    }

    private static String leaf(String[] comps) {
        return comps[comps.length - 1];
    }

    // ---- reading

    /** A regular file or folder that the grammar allows, with one link; else null. */
    private Entry entryOf(Dir dir, String name, boolean checkLinks) {
        try {
            BasicFileAttributes a = dir.attrs(name);
            if (a.isSymbolicLink() || (!a.isRegularFile() && !a.isDirectory()) || !PathRules.validName(name)) {
                return null;
            }
            if (a.isRegularFile() && checkLinks && linksOf(dir, name) != 1) {
                return null;
            }
            return new Entry(name, a.isDirectory(), a.isDirectory() ? -1 : a.size(), a.lastModifiedTime().toMillis());
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    private static int linksOf(Dir dir, String name) {
        try {
            return (Integer) Files.getAttribute(dir.real.resolve(name), "unix:nlink", NOFOLLOW);
        } catch (IOException | RuntimeException e) {
            return 0;
        }
    }

    /** @return null if there's no such file or folder, or it is not one deskd shows */
    Entry stat(String[] comps) throws TreeException {
        if (comps.length == 0) {
            try (Dir d = openDir(comps)) {
                BasicFileAttributes a = Files.readAttributes(root, BasicFileAttributes.class);
                return new Entry("", true, -1, a.lastModifiedTime().toMillis());
            } catch (IOException e) {
                throw new TreeException(Kind.IO);
            }
        }
        try (Dir parent = openDir(comps, comps.length - 1)) {
            return entryOf(parent, leaf(comps), true);
        } catch (TreeException e) {
            if (e.kind() == Kind.NOT_FOUND || e.kind() == Kind.NOT_A_DIR) {
                return null;
            }
            throw e;
        }
    }

    /** The sort of a listing: folders first, then by the case-folded name, then by its UTF-8 bytes. */
    static int compare(Entry a, Entry b) {
        if (a.dir() != b.dir()) {
            return a.dir() ? -1 : 1;
        }
        int c = compareBytes(PathRules.fold(a.name()), PathRules.fold(b.name()));
        return c != 0 ? c : compareBytes(a.name(), b.name());
    }

    static int compareBytes(String a, String b) {
        return java.util.Arrays.compareUnsigned(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    static String cursorOf(Entry e) {
        String raw = (e.dir() ? "D" : "F") + e.name();
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    /** @return the entry a cursor names, as far as the sort goes, or null if it isn't one */
    static Entry parseCursor(String cursor) {
        try {
            String raw = new String(java.util.Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
            if (raw.length() < 2 || (raw.charAt(0) != 'D' && raw.charAt(0) != 'F')) {
                return null;
            }
            return new Entry(raw.substring(1), raw.charAt(0) == 'D', 0, 0);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /**
     * One page of a folder: after {@code after} (a cursor's entry, or null), at most {@code limit} entries. The folder is
     * read whole each time and the page picked from it, so a cursor never repeats or skips an entry that didn't change.
     *
     * @param hideReserved true at the root for the client's listing: {@code .uploads} and {@code .trash} aren't there
     */
    Page list(String[] comps, Entry after, int limit, boolean hideReserved) throws TreeException {
        try (Dir dir = openDir(comps)) {
            boolean atRoot = comps.length == 0;
            // The page is picked in one pass with room for `limit` entries, however big the folder is.
            java.util.PriorityQueue<Entry> best = new java.util.PriorityQueue<>(Math.min(limit, 256) + 1, (a, b) -> compare(b, a));
            int[] skipped = {0};
            long[] beyond = {0};
            dir.forEachName(name -> {
                if (hideReserved && atRoot && PathRules.isReserved(name)) {
                    return true;
                }
                Entry e = entryOf(dir, name, false);
                if (e == null) {
                    skipped[0]++;
                    return true;
                }
                if (after != null && compare(e, after) <= 0) {
                    return true;
                }
                beyond[0]++;
                if (best.size() < limit) {
                    best.add(e);
                } else if (compare(e, best.peek()) < 0) {
                    best.poll();
                    best.add(e);
                }
                return true;
            });
            List<Entry> page = new ArrayList<>(best);
            page.sort(SafeTree::compare);
            List<Entry> out = new ArrayList<>(page.size());
            for (Entry e : page) {
                if (!e.dir() && linksOf(dir, e.name()) != 1) {
                    skipped[0]++;
                    continue;
                }
                out.add(e);
            }
            String next = beyond[0] > page.size() && !page.isEmpty() ? cursorOf(page.get(page.size() - 1)) : null;
            return new Page(out, next, skipped[0]);
        } catch (RuntimeException e) {
            throw new TreeException(Kind.IO);
        }
    }

    /** The shown entries of a folder, one at a time and in no particular order. The visitor returns false to stop. */
    void eachChild(Dir dir, java.util.function.Predicate<Entry> visitor) {
        dir.forEachName(name -> {
            Entry e = entryOf(dir, name, false);
            return e == null || visitor.test(e);
        });
    }

    /** Opens a regular file for reading, once, with no-follow; reads of it go through this handle. */
    Opened openRead(String[] comps) throws TreeException {
        if (comps.length == 0) {
            throw new TreeException(Kind.NOT_FOUND);
        }
        try (Dir parent = openDir(comps, comps.length - 1)) {
            String name = leaf(comps);
            BasicFileAttributes a;
            try {
                a = parent.attrs(name);
            } catch (NoSuchFileException e) {
                throw new TreeException(Kind.NOT_FOUND);
            }
            if (!a.isRegularFile() || linksOf(parent, name) != 1 || !PathRules.validName(name)) {
                throw new TreeException(a.isDirectory() ? Kind.NOT_A_DIR : Kind.NOT_FOUND);
            }
            SeekableByteChannel ch = parent.stream.newByteChannel(Path.of(name), Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS));
            FileChannel file = (FileChannel) ch;
            return new Opened(file, file.size(), a.lastModifiedTime().toMillis());
        } catch (IOException | RuntimeException e) {
            if (e instanceof TreeException te) {
                throw te;
            }
            throw new TreeException(e instanceof NoSuchFileException ? Kind.NOT_FOUND : Kind.IO);
        }
    }

    /** Walks a folder and adds up its files, stopping at {@code cap} entries or when {@code stop} says so. */
    Tally tally(String[] comps, long cap, BooleanSupplier stop, boolean skipReserved) {
        long[] acc = new long[2];
        boolean[] capped = new boolean[1];
        try (Dir dir = openDir(comps)) {
            tallyInto(dir, acc, cap, stop, capped, skipReserved && comps.length == 0);
        } catch (TreeException e) {
            // Nothing there to count.
        }
        return new Tally(acc[0], acc[1], capped[0]);
    }

    private void tallyInto(Dir dir, long[] acc, long cap, BooleanSupplier stop, boolean[] capped, boolean skipReserved) {
        eachChild(dir, e -> {
            if (capped[0]) {
                return false;
            }
            if (skipReserved && PathRules.isReserved(e.name())) {
                return true;
            }
            if (acc[1] >= cap || stop.getAsBoolean()) {
                capped[0] = true;
                return false;
            }
            acc[1]++;
            if (e.dir()) {
                try (Dir sub = dir.sub(e.name())) {
                    tallyInto(sub, acc, cap, stop, capped, false);
                } catch (TreeException ex) {
                    // Gone since it was listed.
                }
            } else {
                acc[0] += e.size();
            }
            return !capped[0];
        });
    }

    // ---- changing (hold #lock)

    /**
     * Makes one folder; the parent must exist.
     *
     * @throws TreeException EXISTS if there is already something of that name, NOT_FOUND or NOT_A_DIR for the parent
     */
    void mkdir(String[] comps) throws TreeException {
        try (Dir parent = openDir(comps, comps.length - 1)) {
            String name = leaf(comps);
            try {
                parent.attrs(name);
                throw new TreeException(Kind.EXISTS);
            } catch (NoSuchFileException e) {
                // Free.
            }
            // Defence in depth: by path, so the parent must still be where the stream says it is.
            if (!parent.real.toRealPath().equals(parent.real) || !parent.real.startsWith(root)) {
                throw new TreeException(Kind.IO);
            }
            Path made = parent.real.resolve(name);
            Files.createDirectory(made, PosixFilePermissions.asFileAttribute(DIR_MODE));
            BasicFileAttributes seen = parent.attrs(name);
            BasicFileAttributes byPath = Files.readAttributes(made, BasicFileAttributes.class, NOFOLLOW);
            if (!seen.isDirectory() || !java.util.Objects.equals(seen.fileKey(), byPath.fileKey())) {
                throw new TreeException(Kind.IO);
            }
        } catch (IOException e) {
            throw new TreeException(e instanceof java.nio.file.FileAlreadyExistsException ? Kind.EXISTS : Kind.IO);
        }
    }

    /** Makes every missing folder on the way, and the last. @return true if the last one was made here */
    boolean mkdirs(String[] comps) throws TreeException {
        boolean made = false;
        for (int i = 1; i <= comps.length; i++) {
            String[] prefix = java.util.Arrays.copyOf(comps, i);
            Entry e = stat(prefix);
            if (e == null) {
                try {
                    mkdir(prefix);
                    made = i == comps.length;
                } catch (TreeException ex) {
                    if (ex.kind() != Kind.EXISTS) {
                        throw ex;
                    }
                    // Something unlisted is in the way: a link, a device.
                    throw new TreeException(Kind.NOT_A_DIR);
                }
            } else if (!e.dir()) {
                throw new TreeException(Kind.NOT_A_DIR);
            }
        }
        return made;
    }

    /** One {@code renameat}. The target's parent must exist; a file is replaced, a folder must be empty. */
    void move(String[] from, String[] to) throws TreeException {
        try (Dir fromParent = openDir(from, from.length - 1); Dir toParent = openDir(to, to.length - 1)) {
            fromParent.stream.move(Path.of(leaf(from)), toParent.stream, Path.of(leaf(to)));
        } catch (NoSuchFileException e) {
            throw new TreeException(Kind.NOT_FOUND);
        } catch (DirectoryNotEmptyException e) {
            throw new TreeException(Kind.NOT_EMPTY);
        } catch (IOException e) {
            throw new TreeException(Kind.IO);
        }
    }

    /** Removes a file, a link or a folder with everything in it. Missing is fine. */
    void deleteTree(String[] comps) throws TreeException {
        try (Dir parent = openDir(comps, comps.length - 1)) {
            deleteIn(parent, leaf(comps));
        } catch (TreeException e) {
            if (e.kind() != Kind.NOT_FOUND) {
                throw e;
            }
        }
    }

    private void deleteIn(Dir parent, String name) throws TreeException {
        try {
            BasicFileAttributes a;
            try {
                a = parent.attrs(name);
            } catch (NoSuchFileException e) {
                return;
            }
            if (a.isDirectory() && !a.isSymbolicLink()) {
                try (Dir sub = parent.sub(name)) {
                    // A batch at a time: what is deleted is gone from the next look, and no folder is held whole in memory.
                    while (true) {
                        List<String> batch = new ArrayList<>(512);
                        sub.forEachName(child -> {
                            batch.add(child);
                            return batch.size() < 512;
                        });
                        if (batch.isEmpty()) {
                            break;
                        }
                        for (String child : batch) {
                            deleteIn(sub, child);
                        }
                    }
                }
                parent.stream.deleteDirectory(Path.of(name));
            } else {
                parent.stream.deleteFile(Path.of(name));
            }
        } catch (NoSuchFileException e) {
            // Gone already.
        } catch (IOException e) {
            throw new TreeException(Kind.IO);
        }
    }

    /** A new empty file, mode 0600, for writing; fails if the name is taken. */
    FileChannel createNew(String[] comps) throws TreeException {
        try (Dir parent = openDir(comps, comps.length - 1)) {
            return (FileChannel) parent.stream.newByteChannel(
                    Path.of(leaf(comps)),
                    Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                    PosixFilePermissions.asFileAttribute(FILE_MODE));
        } catch (java.nio.file.FileAlreadyExistsException e) {
            throw new TreeException(Kind.EXISTS);
        } catch (NoSuchFileException e) {
            throw new TreeException(Kind.NOT_FOUND);
        } catch (IOException | RuntimeException e) {
            if (e instanceof TreeException te) {
                throw te;
            }
            throw new TreeException(Kind.IO);
        }
    }

    /** An existing regular file, for {@code options} (READ, WRITE), never through a link. */
    FileChannel openFile(String[] comps, boolean write) throws TreeException {
        try (Dir parent = openDir(comps, comps.length - 1)) {
            Set<java.nio.file.OpenOption> options = write
                    ? Set.of(StandardOpenOption.READ, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)
                    : Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
            return (FileChannel) parent.stream.newByteChannel(Path.of(leaf(comps)), options);
        } catch (NoSuchFileException e) {
            throw new TreeException(Kind.NOT_FOUND);
        } catch (IOException | RuntimeException e) {
            if (e instanceof TreeException te) {
                throw te;
            }
            throw new TreeException(Kind.IO);
        }
    }

    /** Sets the modified time of a file or folder. */
    void setMtime(String[] comps, long mtimeMs) throws TreeException {
        try (Dir parent = openDir(comps, comps.length - 1)) {
            parent.stream.getFileAttributeView(Path.of(leaf(comps)), BasicFileAttributeView.class, NOFOLLOW)
                    .setTimes(FileTime.fromMillis(mtimeMs), null, null);
        } catch (IOException e) {
            throw new TreeException(e instanceof NoSuchFileException ? Kind.NOT_FOUND : Kind.IO);
        }
    }

    /** {@code fsync} of a folder, so a rename in it survives a power cut. */
    void syncDir(String[] comps) {
        try (Dir dir = openDir(comps); FileChannel ch = FileChannel.open(dir.real, StandardOpenOption.READ)) {
            ch.force(true);
        } catch (IOException | TreeException e) {
            // Best effort: some filesystems refuse it.
        }
    }

    /** Writes a small file whole, and renames it over {@code name}, so a reader sees all of it or the old one. */
    void replaceSmall(String[] dir, String name, byte[] data) throws TreeException {
        String[] tmp = append(dir, name + ".tmp");
        String[] dest = append(dir, name);
        try {
            try {
                deleteTree(tmp);
            } catch (TreeException e) {
                // Not there.
            }
            try (FileChannel ch = createNew(tmp)) {
                ByteBuffer buf = ByteBuffer.wrap(data);
                while (buf.hasRemaining()) {
                    ch.write(buf);
                }
                ch.force(true);
            }
            move(tmp, dest);
        } catch (IOException e) {
            throw new TreeException(Kind.IO);
        }
    }

    /** A small file whole; null if it isn't there or is over {@code max} bytes. */
    byte[] readSmall(String[] comps, int max) {
        try (FileChannel ch = openFile(comps, false)) {
            if (ch.size() > max) {
                return null;
            }
            ByteBuffer buf = ByteBuffer.allocate((int) ch.size());
            while (buf.hasRemaining() && ch.read(buf) >= 0) {
                // Filling.
            }
            return buf.array();
        } catch (IOException | TreeException e) {
            return null;
        }
    }

    static String[] append(String[] base, String... more) {
        String[] out = java.util.Arrays.copyOf(base, base.length + more.length);
        System.arraycopy(more, 0, out, base.length, more.length);
        return out;
    }

    /** Names in a folder, for the module's own housekeeping (partials, trash items). */
    List<String> names(String[] comps) {
        List<String> out = new ArrayList<>();
        try (Dir dir = openDir(comps)) {
            out.addAll(dir.names());
        } catch (TreeException | RuntimeException e) {
            // Nothing there.
        }
        return out;
    }

    /** Raw attributes of a name, for the housekeeping; null if it isn't there. */
    BasicFileAttributes rawAttrs(String[] comps) {
        try (Dir parent = openDir(comps, comps.length - 1)) {
            return parent.attrs(leaf(comps));
        } catch (TreeException | IOException e) {
            return null;
        }
    }

    static boolean isFileSystemProblem(Exception e) {
        return e instanceof FileSystemException || e instanceof NotDirectoryException;
    }
}
