package com.minimalistalliance.desk.deskd.training;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The training as the Dockerfile runs it, in a JVM of its own, from the jar. So a change on the session path that
 * the stand-ins don't keep up with fails here, and not first on the arm64 box.
 */
class CdsTrainingIT {

    @TempDir
    Path tmp;

    @Test
    void itGoesThroughTheWholePathAndLeavesNothingBehind() throws Exception {
        Process process = new ProcessBuilder(
                        Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                        "-XX:+UseSerialGC",
                        "-XX:TieredStopAtLevel=1",
                        "-Dspring.aot.enabled=true",
                        "-Dma.cds.train=true",
                        "-Djava.io.tmpdir=" + tmp,
                        "-jar",
                        "target/deskd.jar")
                .redirectErrorStream(true)
                .start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(3, TimeUnit.MINUTES)).as(output).isTrue();

        assertThat(process.exitValue()).as(output).isZero();
        assertThat(output)
                .contains("hello accepted")
                .contains("gateway link up")
                .contains("heartbeat accepted")
                .contains("session timing first=true result=rejected")
                .contains("session timing first=true result=ok")
                .contains("chromium connected")
                .contains("from=warm to=live result=ok")
                .contains("deskd CDS training finished");
        assertThat(tmp).isEmptyDirectory();
    }
}
