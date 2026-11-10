package com.minimalistalliance.desk.agent;

import java.nio.file.Files;
import java.nio.file.Path;

/** {@code /data/agent}: the agents, the ledger, the audit log, and in {@code keys/} the sealed keys (ADR 0042). */
final class DataDirectory {

    private final Path path;

    DataDirectory(Path path) {
        this.path = path;
    }

    Path path() {
        return path;
    }

    Path resolve(String name) {
        return path.resolve(name);
    }

    boolean isWritable() {
        return Files.isDirectory(path) && Files.isWritable(path);
    }
}
