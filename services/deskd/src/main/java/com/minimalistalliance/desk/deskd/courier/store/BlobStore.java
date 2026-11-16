package com.minimalistalliance.desk.deskd.courier.store;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.channels.FileChannel;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.function.Predicate;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * Each raw message exactly as it came, compressed, under its SHA-256 (draft ADR "Courier's store", section 3). Most are
 * small, and go in {@code courier.db}'s {@code blob_data}, in the same transaction as their row: a file each cost a whole
 * filesystem block and more (measured at 100,000 messages: 4.5 times their compressed size on ext4). One over
 * {@link #INLINE_MAX} compressed is a file, {@code blobs/ab/cd/<sha256>.eml.gz}. The same bytes twice are one blob. gzip
 * rather than the plan's zstd: the JDK has it, and zstd would be a second JNI library in deskd.
 *
 * <p><b>Crash safety.</b> A blob in the database commits with its row or not at all. A file is written whole to
 * {@code .staged/}, synced, and renamed there before the row naming it commits; the writer's thread then moves it into
 * place, or drops it if nothing names it. So a crash leaves at most a staged file, which {@link #recover} places or
 * removes at the next open, and never a row whose blob is missing or a torn blob. A purge records the blob in
 * {@code blob_gc} in the transaction that drops its last row, and its row or file goes after the commit, again on the
 * writer's thread, so no placement can race it.
 */
public final class BlobStore {

    /** Over this, a message's raw bytes aren't kept (the plan's 40 MB parse limit, and some room). */
    public static final long MAX_RAW = 48L * 1024 * 1024;
    /** Compressed, up to this goes in the database; over it, a file. */
    public static final int INLINE_MAX = 64 * 1024;

    private static final String SUFFIX = ".eml.gz";
    private static final HexFormat HEX = HexFormat.of();

    private final Path root;
    private final Path staged;
    private final SecureRandom random = new SecureRandom();
    /** Blobs a write has staged or found in place and not yet committed: a purge leaves them alone. */
    private final java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger> inflight =
            new java.util.concurrent.ConcurrentHashMap<>();

    public BlobStore(Path root) throws IOException {
        this.root = root;
        this.staged = root.resolve(".staged");
        createDir(root);
        createDir(staged);
    }

    public static String sha256(byte[] bytes) {
        try {
            return HEX.formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The bytes gzipped, if that comes to at most {@code max}; null if it doesn't. In memory: for small messages. */
    public static byte[] compressSmall(byte[] raw, int max) {
        if (raw.length > max * 16L) {
            return null;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(max, raw.length / 3 + 64)) {
            @Override
            public synchronized void write(byte[] b, int off, int len) {
                if (count + len > max) {
                    throw new IllegalStateException("over");
                }
                super.write(b, off, len);
            }

            @Override
            public synchronized void write(int b) {
                if (count + 1 > max) {
                    throw new IllegalStateException("over");
                }
                super.write(b);
            }
        };
        try (GZIPOutputStream gz = new GZIPOutputStream(out, 8 * 1024)) {
            gz.write(raw);
        } catch (IllegalStateException e) {
            return null;
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        return out.toByteArray();
    }

    /** gzip bytes back to the raw message, checked against its hash; null if they don't match or aren't gzip. */
    public static byte[] decompress(byte[] gz, String sha) {
        try (InputStream in = new GZIPInputStream(new java.io.ByteArrayInputStream(gz), 8 * 1024)) {
            byte[] raw = in.readNBytes((int) MAX_RAW + 1);
            if (raw.length > MAX_RAW) {
                return null;
            }
            return sha256(raw).equals(sha) ? raw : null;
        } catch (IOException e) {
            return null;
        }
    }

    static boolean validSha(String sha) {
        if (sha == null || sha.length() != 64) {
            return false;
        }
        for (int i = 0; i < 64; i++) {
            char c = sha.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
                return false;
            }
        }
        return true;
    }

    Path finalPath(String sha) {
        return root.resolve(sha.substring(0, 2)).resolve(sha.substring(2, 4)).resolve(sha + SUFFIX);
    }

    Path stagedPath(String sha) {
        return staged.resolve(sha + SUFFIX);
    }

    /**
     * Writes the bytes to {@code .staged/}, synced, unless the blob is already in place. Off the writer's thread: this is
     * the slow part. {@link #place} finishes it.
     *
     * @return the SHA-256
     */
    public String stage(byte[] raw) throws IOException {
        String sha = sha256(raw);
        inflight.computeIfAbsent(sha, k -> new java.util.concurrent.atomic.AtomicInteger()).incrementAndGet();
        try {
            if (Files.exists(finalPath(sha), LinkOption.NOFOLLOW_LINKS)) {
                return sha;
            }
            writeStaged(sha, raw);
            return sha;
        } catch (IOException | RuntimeException e) {
            release(sha);
            throw e;
        }
    }

    /** The write that staged or found it has committed, or failed: a purge may consider it again. */
    public void release(String sha) {
        inflight.computeIfPresent(sha, (k, n) -> n.decrementAndGet() <= 0 ? null : n);
    }

    /** True while a write that may name it hasn't finished. */
    public boolean inFlight(String sha) {
        return inflight.containsKey(sha);
    }

    private void writeStaged(String sha, byte[] raw) throws IOException {
        Path temp = staged.resolve("." + HEX.formatHex(randomBytes()) + ".part");
        try {
            // Created 0600, not with the umask's mode (Security CS-I4): the 0700 directory isn't the only guard.
            try (FileChannel ch = FileChannel.open(temp, java.util.EnumSet.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))) {
                OutputStream out = java.nio.channels.Channels.newOutputStream(ch);
                GZIPOutputStream gz = new GZIPOutputStream(out, 64 * 1024);
                try {
                    gz.write(raw);
                    gz.finish();
                    gz.flush();
                    ch.force(true);
                } finally {
                    gz.close();
                }
            }
            move(temp, stagedPath(sha));
            syncDir(staged);
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    private byte[] randomBytes() {
        byte[] b = new byte[12];
        random.nextBytes(b);
        return b;
    }

    /**
     * On the writer's thread, after the commit that may name it: moves a staged blob into place if a row names it, and
     * drops it otherwise (or if it's already there).
     */
    public void place(String sha, boolean referenced) throws IOException {
        if (!validSha(sha)) {
            return;
        }
        Path from = stagedPath(sha);
        if (!Files.exists(from, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        Path to = finalPath(sha);
        if (!referenced || Files.exists(to, LinkOption.NOFOLLOW_LINKS)) {
            Files.deleteIfExists(from);
            return;
        }
        Path dir = to.getParent();
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
            createDir(dir.getParent());
            createDir(dir);
            syncDir(dir.getParent());
            syncDir(root);
        }
        move(from, to);
        syncDir(dir);
        syncDir(staged);
    }

    /** Removes a blob nothing names any more. On the writer's thread. */
    public void delete(String sha) throws IOException {
        if (!validSha(sha)) {
            return;
        }
        boolean gone = Files.deleteIfExists(finalPath(sha));
        gone |= Files.deleteIfExists(stagedPath(sha));
        if (gone) {
            syncDir(finalPath(sha).getParent());
        }
    }

    /** The raw bytes, checked against their hash; null if there's no such blob or it doesn't match. */
    public byte[] read(String sha) throws IOException {
        if (!validSha(sha)) {
            return null;
        }
        for (int attempt = 0; attempt < 3; attempt++) {
            for (Path p : new Path[] {finalPath(sha), stagedPath(sha)}) {
                try (InputStream in = new GZIPInputStream(Files.newInputStream(p, LinkOption.NOFOLLOW_LINKS), 64 * 1024)) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[64 * 1024];
                    long total = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        total += n;
                        if (total > MAX_RAW) {
                            return null;
                        }
                        out.write(buf, 0, n);
                    }
                    byte[] raw = out.toByteArray();
                    return sha256(raw).equals(sha) ? raw : null;
                } catch (NoSuchFileException e) {
                    // The other place, or it moved between the two looks.
                } catch (java.util.zip.ZipException | java.io.EOFException e) {
                    // Damaged on disk: never other bytes.
                    return null;
                }
            }
        }
        return null;
    }

    public boolean exists(String sha) {
        return validSha(sha) && (Files.exists(finalPath(sha), LinkOption.NOFOLLOW_LINKS)
                || Files.exists(stagedPath(sha), LinkOption.NOFOLLOW_LINKS));
    }

    /**
     * At open, before anything is accepted: unfinished writes are removed, and each staged blob is placed if a row names it
     * or removed if none does.
     *
     * @return how many staged blobs were removed
     */
    public int recover(Predicate<String> referenced) throws IOException {
        int removed = 0;
        List<Path> entries = new ArrayList<>();
        try (DirectoryStream<Path> dir = Files.newDirectoryStream(staged)) {
            for (Path p : dir) {
                entries.add(p);
            }
        }
        for (Path p : entries) {
            String name = p.getFileName().toString();
            if (name.endsWith(".part") || !name.endsWith(SUFFIX)) {
                Files.deleteIfExists(p);
                continue;
            }
            String sha = name.substring(0, name.length() - SUFFIX.length());
            if (!validSha(sha)) {
                Files.deleteIfExists(p);
                continue;
            }
            boolean named = referenced.test(sha);
            place(sha, named);
            if (!named) {
                removed++;
            }
        }
        syncDir(staged);
        return removed;
    }

    /** Every blob in place, for checks. */
    List<String> listAll() throws IOException {
        List<String> out = new ArrayList<>();
        try (var walk = Files.walk(root)) {
            walk.filter(p -> !p.startsWith(staged) && p.getFileName().toString().endsWith(SUFFIX))
                    .forEach(p -> {
                        String n = p.getFileName().toString();
                        out.add(n.substring(0, n.length() - SUFFIX.length()));
                    });
        }
        return out;
    }

    /** Bytes on disk, compressed. */
    long bytesOnDisk() throws IOException {
        long[] total = {0};
        try (var walk = Files.walk(root)) {
            walk.filter(p -> Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)).forEach(p -> {
                try {
                    total[0] += Files.size(p);
                } catch (IOException e) {
                    // gone meanwhile
                }
            });
        }
        return total[0];
    }

    private static void move(Path from, Path to) throws IOException {
        try {
            Files.move(from, to, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            throw new IOException("the blob store needs atomic renames", e);
        }
    }

    static void createDir(Path dir) throws IOException {
        try {
            Files.createDirectory(dir, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        } catch (FileAlreadyExistsException e) {
            if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
                throw e;
            }
        }
    }

    static void syncDir(Path dir) throws IOException {
        try (FileChannel ch = FileChannel.open(dir, StandardOpenOption.READ)) {
            ch.force(true);
        } catch (IOException e) {
            // Some filesystems refuse to open a directory for sync; ext4 and xfs, which desks use, don't.
            if (!(e instanceof NoSuchFileException)) {
                throw e;
            }
        }
    }
}
