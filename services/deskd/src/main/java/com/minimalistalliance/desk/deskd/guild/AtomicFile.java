package com.minimalistalliance.desk.deskd.guild;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;

/** A small file on /data/desk written whole or not at all: a temporary file, an fsync, a rename and the directory's fsync. */
final class AtomicFile {

    /** What deskd reads of its own files, at most: none of these come near it. */
    static final int MAX_BYTES = 1 << 20;

    private AtomicFile() {}

    static void write(Path file, byte[] bytes) throws IOException {
        Path temporary = file.resolveSibling(file.getFileName() + ".tmp");
        Files.deleteIfExists(temporary);
        try {
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            try {
                Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------"));
            } catch (UnsupportedOperationException e) {
                // Not a POSIX file system: only in a test.
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE);
            try (FileChannel directory = FileChannel.open(file.getParent(), StandardOpenOption.READ)) {
                directory.force(true);
            } catch (IOException e) {
                // Some file systems can't open a directory to sync it; the rename is still atomic.
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    /** @return the bytes, or null if there's no regular file there (a link isn't followed) or it's too large */
    static byte[] read(Path file) throws IOException {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_BYTES) {
            return null;
        }
        return Files.readAllBytes(file);
    }
}
