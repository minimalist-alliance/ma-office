package com.minimalistalliance.desk.deskd;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The training is reached only through a JVM system property, and never where a desk's runtime directory exists. */
class TrainingGateTest {

    private static final String PROPERTY = "ma.cds.train";

    @Test
    void withoutThePropertyThereIsNoTraining(@TempDir Path dir) {
        assertThat(DeskdApplication.trainingRequested(dir.resolve("absent"))).isFalse();
    }

    @Test
    void thePropertyMeansNothingOnADesk(@TempDir Path dir) {
        System.setProperty(PROPERTY, "true");
        try {
            assertThat(DeskdApplication.trainingRequested(dir.resolve("absent"))).isTrue();
            assertThat(DeskdApplication.trainingRequested(dir)).isFalse();
        } finally {
            System.clearProperty(PROPERTY);
        }
    }
}
