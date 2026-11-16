package com.minimalistalliance.desk.deskd.docs;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Pages the sandbox drew, kept on the desk so a second look is instant: {@code /data/desk/docs-cache/}, named by the
 * version's SHA-256, the page and the width; 7 days, at most 1 GiB, least recently used first (deskd {@code API.md} §25).
 * Nothing else is ever written there, and nothing there is ever the original file.
 */
final class RenderCache {

    static final long MAX_BYTES = 1L << 30;
    static final long MAX_AGE_MS = 7L * 86_400_000L;
    private static final Pattern NAME = Pattern.compile("[0-9a-f]{64}-p[0-9]{1,3}-w[0-9]{3,4}\\.(jpeg|png)");

    private final Path dir;

    RenderCache(Path dir) {
        this.dir = dir;
    }

    private Path file(String sha, int page, int width, String format) {
        return dir.resolve(sha + "-p" + page + "-w" + width + "." + format);
    }

    /** The cached page and its format, touched as used; null when it isn't there. */
    DocsSandbox.Image get(String sha, int page, int width) {
        for (String format : List.of("jpeg", "png")) {
            Path f = file(sha, page, width, format);
            try {
                if (Files.isRegularFile(f, LinkOption.NOFOLLOW_LINKS)) {
                    byte[] bytes = Files.readAllBytes(f);
                    Files.setLastModifiedTime(f, FileTime.fromMillis(System.currentTimeMillis()));
                    int[] wh = size(bytes, format);
                    return new DocsSandbox.Image(format, wh[0], wh[1], body(bytes));
                }
            } catch (IOException e) {
                return null;
            }
        }
        return null;
    }

    void put(String sha, int page, int width, DocsSandbox.Image image) {
        try {
            ensure();
            Path tmp = dir.resolve(".tmp-" + sha.substring(0, 16) + "-" + page + "-" + width + "-" + System.nanoTime());
            Files.write(Files.createFile(tmp, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))),
                    header(image), java.nio.file.StandardOpenOption.WRITE);
            Files.move(tmp, file(sha, page, width, image.format()), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            // A page not cached is drawn again next time.
        }
    }

    /** The file holds the width and height first (8 bytes), then the image. */
    private static byte[] header(DocsSandbox.Image image) {
        byte[] out = new byte[8 + image.bytes().length];
        java.nio.ByteBuffer.wrap(out).putInt(image.width()).putInt(image.height()).put(image.bytes());
        return out;
    }

    private static int[] size(byte[] stored, String format) throws IOException {
        if (stored.length < 9) {
            throw new IOException("short");
        }
        java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(stored);
        return new int[] {b.getInt(), b.getInt()};
    }

    /** The image's bytes from a stored file (past the 8-byte size). */
    static byte[] body(byte[] stored) {
        return java.util.Arrays.copyOfRange(stored, 8, stored.length);
    }

    private void ensure() throws IOException {
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
            try {
                Files.createDirectory(dir, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            } catch (FileAlreadyExistsException e) {
                // Made meanwhile.
            }
        }
        if (Files.isSymbolicLink(dir)) {
            throw new IOException("cache is a link");
        }
    }

    /** Past 7 days, then oldest first past 1 GiB. Returns how many went. */
    int sweep(long now) {
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
            return 0;
        }
        record F(Path p, long size, long at) {}
        List<F> files = new ArrayList<>();
        int removed = 0;
        try (DirectoryStream<Path> s = Files.newDirectoryStream(dir)) {
            for (Path p : s) {
                String n = p.getFileName().toString();
                if (!NAME.matcher(n).matches() && !n.startsWith(".tmp-")) {
                    continue;
                }
                long at = Files.getLastModifiedTime(p, LinkOption.NOFOLLOW_LINKS).toMillis();
                if (now - at > MAX_AGE_MS || n.startsWith(".tmp-") && now - at > 600_000L) {
                    Files.deleteIfExists(p);
                    removed++;
                } else {
                    files.add(new F(p, Files.size(p), at));
                }
            }
        } catch (IOException e) {
            return removed;
        }
        long total = files.stream().mapToLong(F::size).sum();
        files.sort(Comparator.comparingLong(F::at));
        for (F f : files) {
            if (total <= MAX_BYTES) {
                break;
            }
            try {
                Files.deleteIfExists(f.p());
                total -= f.size();
                removed++;
            } catch (IOException e) {
                // Next sweep.
            }
        }
        return removed;
    }
}
