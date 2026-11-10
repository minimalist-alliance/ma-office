package com.minimalistalliance.desk.deskd;

import com.minimalistalliance.desk.deskd.training.CdsTraining;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.context.annotation.Import;

/**
 * Entry point of deskd. Configuration classes are listed here by hand: no component scanning, and
 * no auto-configuration unless something really needs it (ADR 0040).
 */
@SpringBootConfiguration(proxyBeanMethods = false)
@Import({ReadinessConfiguration.class, DataPlaneConfiguration.class, ControlPlaneConfiguration.class})
public class DeskdApplication {

    /** Only ever on the java command line of the Dockerfile's training RUN. See {@link CdsTraining}. */
    private static final String TRAINING_PROPERTY = "ma.cds.train";
    private static final Path DESK_RUNTIME_DIR = Path.of("/run/desk");

    public static void main(String[] args) {
        if (trainingRequested(DESK_RUNTIME_DIR)) {
            CdsTraining.run(() -> application().run(args));
            return;
        }
        application().run(args);
    }

    /**
     * A JVM system property, not a setting: deskd.env and the Environment can't set it. And where a desk's
     * runtime directory exists it means nothing, so no mistake can stop a real desk from starting.
     */
    static boolean trainingRequested(Path deskRuntimeDir) {
        return Boolean.getBoolean(TRAINING_PROPERTY) && !Files.exists(deskRuntimeDir);
    }

    /** The application exactly as {@link #main} runs it, so tests boot the same thing. */
    static SpringApplication application() {
        SpringApplication application = new SpringApplication(DeskdApplication.class);
        // AOT finds its generated initializer through this class, so it can't be left to deduction
        // from the call stack: under a test runner that finds the runner's main method.
        application.setMainApplicationClass(DeskdApplication.class);
        return application;
    }
}
