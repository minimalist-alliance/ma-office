package com.minimalistalliance.desk.deskd.files;

import java.nio.file.Path;

/**
 * A real Files module on a temp directory for the Agent's Files tools' tests (in package {@code tools}): the drive's free
 * space and the free tier's cap under the test's control. The module's rig has no client; the tools go straight to the tree.
 */
public final class AgentFilesRig implements AutoCloseable {

    private final FilesRig rig;

    public AgentFilesRig(Path dir) throws Exception {
        this.rig = new FilesRig(java.nio.file.Files.createDirectories(dir));
    }

    public FilesModule files() {
        return rig.files;
    }

    public Path root() {
        return rig.root;
    }

    /** A free tier's cap, in bytes, from now on. */
    public void cap(long bytes) {
        rig.files.quota().capFrom(() -> bytes);
    }

    /** What the drive has free, in bytes. */
    public void free(long bytes) {
        rig.freeBytes.set(bytes);
    }

    /** ADR 0035's floor in bytes. */
    public static long floor() {
        return Quota.FLOOR_BYTES;
    }

    @Override
    public void close() throws Exception {
        rig.close();
    }
}
