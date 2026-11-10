package com.minimalistalliance.desk.deskd;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.aot.AotDetector;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * Boots from the classes process-aot generated, which is how deskd runs in production. Failsafe
 * sets spring.aot.enabled=true (see pom.xml).
 */
@ExtendWith(OutputCaptureExtension.class)
class DeskdAotIT {

    @TempDir
    Path dir;

    @Test
    void bootsFromGeneratedInitializer(CapturedOutput output) throws Exception {
        assertThat(AotDetector.useGeneratedArtifacts()).isTrue();
        DeskdApplicationTests.assertBootsAndReportsReady(output, dir);
    }

    @Test
    void endToEndFromGeneratedInitializer(CapturedOutput output) throws Exception {
        assertThat(AotDetector.useGeneratedArtifacts()).isTrue();
        DeskdApplicationTests.assertEndToEnd(output, dir);
    }

    @Test
    void theAgeBandFromGeneratedInitializer() throws Exception {
        assertThat(AotDetector.useGeneratedArtifacts()).isTrue();
        DeskdApplicationTests.assertAgeBandWiring(dir);
    }

    @Test
    void aRefusedChromiumAndTheVolumeRecordFromGeneratedInitializer() throws Exception {
        assertThat(AotDetector.useGeneratedArtifacts()).isTrue();
        DeskdApplicationTests.assertRefusedChromiumAndVolumeRecord(dir);
    }

    @Test
    void thePauseAndTheFreeBudgetFromGeneratedInitializer() throws Exception {
        assertThat(AotDetector.useGeneratedArtifacts()).isTrue();
        DeskdApplicationTests.assertPauseAndFreeBudget(dir);
    }
}
