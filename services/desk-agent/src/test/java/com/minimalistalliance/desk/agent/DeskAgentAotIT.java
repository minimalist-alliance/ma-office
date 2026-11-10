package com.minimalistalliance.desk.agent;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.aot.AotDetector;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * Boots from the classes process-aot generated, which is how desk-agent runs in its image. Failsafe sets
 * spring.aot.enabled=true (see pom.xml).
 */
@ExtendWith(OutputCaptureExtension.class)
class DeskAgentAotIT {

    @TempDir
    Path dir;

    @Test
    void bootsFromGeneratedInitializer(CapturedOutput output) throws Exception {
        assertThat(AotDetector.useGeneratedArtifacts()).isTrue();
        DeskAgentApplicationTests.assertBootsAndReportsReady(output, dir);
    }

    @Test
    void theManagerAnswersFromGeneratedInitializer(CapturedOutput output) throws Exception {
        assertThat(AotDetector.useGeneratedArtifacts()).isTrue();
        DeskAgentApplicationTests.assertManagerAnswers(output, dir);
    }
}
