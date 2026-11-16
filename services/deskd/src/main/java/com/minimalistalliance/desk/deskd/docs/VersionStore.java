package com.minimalistalliance.desk.deskd.docs;

import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.regex.Pattern;

/**
 * Old bytes of a document, so "Versions" can show and restore them (deskd {@code API.md} §25): content-addressed in
 * {@code /data/desk/versions/<sha256>}, 0600. Kept only for Files' documents up to 20 MiB (Courier's attachments never
 * change, and Notebook keeps its own history), at most 10% of the drive in all; unnamed versions go after 30 days or to
 * make room, oldest first; named milestones stay while their document does.
 */
final class VersionStore {

    static final long MAX_FILE = 20L << 20;
    static final double SHARE = 0.10;
    private static final Pattern SHA = Pattern.compile("[0-9a-f]{64}");

    private final Path dir;

    VersionStore(Path dir) {
        this.dir = dir;
    }

    boolean has(String sha) {
        return SHA.matcher(sha).matches() && Files.isRegularFile(dir.resolve(sha), LinkOption.NOFOLLOW_LINKS);
    }

    byte[] get(String sha) throws IOException {
        if (!SHA.matcher(sha).matches()) {
            throw new IOException("sha");
        }
        Path f = dir.resolve(sha);
        if (Files.isSymbolicLink(f)) {
            throw new IOException("link");
        }
        byte[] b = Files.readAllBytes(f);
        if (!Bytes.sha256(b).equals(sha)) {
            throw new IOException("changed");
        }
        return b;
    }

    /** Keeps {@code bytes} if they fit the caps. Returns whether they're kept. */
    boolean keep(String sha, byte[] bytes) {
        if (bytes == null || bytes.length > MAX_FILE || !SHA.matcher(sha).matches()) {
            return false;
        }
        try {
            if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
                try {
                    Files.createDirectory(dir, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
                } catch (FileAlreadyExistsException e) {
                    // Made meanwhile.
                }
            }
            if (has(sha)) {
                return true;
            }
            long cap = (long) (Files.getFileStore(dir).getTotalSpace() * SHARE);
            if (used() + bytes.length > cap) {
                return false;
            }
            Path tmp = dir.resolve(".tmp-" + sha.substring(0, 16) + "-" + System.nanoTime());
            Files.write(Files.createFile(tmp, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))), bytes,
                    java.nio.file.StandardOpenOption.WRITE);
            Files.move(tmp, dir.resolve(sha), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    void drop(String sha) {
        if (SHA.matcher(sha).matches()) {
            try {
                Files.deleteIfExists(dir.resolve(sha));
            } catch (IOException e) {
                // Next tidy.
            }
        }
    }

    long used() {
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
            return 0;
        }
        try (var s = Files.list(dir)) {
            return s.filter(p -> SHA.matcher(p.getFileName().toString()).matches()).mapToLong(p -> {
                try {
                    return Files.size(p);
                } catch (IOException e) {
                    return 0;
                }
            }).sum();
        } catch (IOException e) {
            return 0;
        }
    }
}
