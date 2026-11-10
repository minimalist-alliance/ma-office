package com.minimalistalliance.desk.agent.training;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The training as the Dockerfile runs it, in a JVM of its own, from the jar, with SQLite's library pre-extracted
 * as the image has it. So a change on the answer path the training doesn't follow fails here, not on the arm64 box.
 */
class CdsTrainingIT {

    @TempDir
    Path tmp;

    @Test
    void itGoesFromBootThroughAnAnswerAndLeavesNothingBehind() throws Exception {
        Path lib = Files.createDirectory(tmp.resolve("native"));
        Path work = Files.createDirectory(tmp.resolve("work"));
        String arch = System.getProperty("os.arch").equals("amd64") ? "x86_64" : System.getProperty("os.arch");
        try (var sqlite = new java.util.jar.JarFile(sqliteJar().toFile())) {
            var entry = sqlite.getJarEntry("org/sqlite/native/Linux/" + arch + "/libsqlitejdbc.so");
            assertThat(entry).as("sqlite-jdbc has a library for " + arch).isNotNull();
            Files.copy(sqlite.getInputStream(entry), lib.resolve("libsqlitejdbc.so"));
        }
        Process process = new ProcessBuilder(
                        Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                        "-XX:+UseSerialGC",
                        "-XX:TieredStopAtLevel=1",
                        "-Dspring.aot.enabled=true",
                        "-Dma.cds.train=true",
                        "-Djava.io.tmpdir=" + work,
                        "-Dorg.sqlite.lib.path=" + lib,
                        "-Dorg.sqlite.lib.name=libsqlitejdbc.so",
                        "-jar",
                        "target/desk-agent.jar")
                .redirectErrorStream(true)
                .start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(2, TimeUnit.MINUTES)).as(output).isTrue();

        assertThat(process.exitValue()).as(output).isZero();
        assertThat(output)
                .contains("desk-agent ready in")
                .contains("desk-agent CDS training: socket, key, answer, limit and 6 audit rows")
                .contains("desk-agent CDS training: a restart, and the key back from the vault")
                .contains("desk-agent CDS training finished");
        assertThat(work).isEmptyDirectory();
    }

    private static Path sqliteJar() throws Exception {
        return Path.of(org.sqlite.JDBC.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    }
}
