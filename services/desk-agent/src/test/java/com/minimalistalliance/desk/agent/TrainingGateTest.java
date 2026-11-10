package com.minimalistalliance.desk.agent;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The training is reached only through a JVM system property, and never where desk-agent's runtime dir exists. */
class TrainingGateTest {

    private static final String PROPERTY = "ma.cds.train";

    @Test
    void withoutThePropertyThereIsNoTraining(@TempDir Path dir) {
        assertThat(DeskAgentApplication.trainingRequested(dir.resolve("absent"))).isFalse();
    }

    @Test
    void thePropertyMeansNothingOnADesk(@TempDir Path dir) {
        System.setProperty(PROPERTY, "true");
        try {
            assertThat(DeskAgentApplication.trainingRequested(dir.resolve("absent"))).isTrue();
            assertThat(DeskAgentApplication.trainingRequested(dir)).isFalse();
        } finally {
            System.clearProperty(PROPERTY);
        }
    }
}
