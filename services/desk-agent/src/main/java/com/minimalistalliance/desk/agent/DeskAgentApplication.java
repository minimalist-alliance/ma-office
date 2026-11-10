package com.minimalistalliance.desk.agent;

import com.minimalistalliance.desk.agent.training.CdsTraining;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.context.annotation.Import;

/**
 * Entry point of desk-agent. Configuration is listed by hand: no component scanning, and no auto-configuration
 * (ADR 0040).
 */
@SpringBootConfiguration(proxyBeanMethods = false)
@Import(AgentConfiguration.class)
public class DeskAgentApplication {

    /** Only ever on the java command line of the Dockerfile's training RUN. See {@link CdsTraining}. */
    private static final String TRAINING_PROPERTY = "ma.cds.train";
    private static final Path RUNTIME_DIR = Path.of("/run/desk-agent");

    public static void main(String[] args) {
        if (trainingRequested(RUNTIME_DIR)) {
            CdsTraining.run(() -> application().run(args));
            return;
        }
        application().run(args);
    }

    /**
     * A JVM system property, not a setting: desk-agent.env and the Environment can't set it. And where desk-agent's
     * runtime directory exists it means nothing, so no mistake can stop a real desk's desk-agent from starting.
     */
    static boolean trainingRequested(Path runtimeDir) {
        return Boolean.getBoolean(TRAINING_PROPERTY) && !Files.exists(runtimeDir);
    }

    /** The application exactly as {@link #main} runs it, so tests boot the same thing. */
    public static SpringApplication application() {
        SpringApplication application = new SpringApplication(DeskAgentApplication.class);
        // AOT finds its generated initializer through this class, so it can't be left to deduction from the call
        // stack: under a test runner that finds the runner's main method.
        application.setMainApplicationClass(DeskAgentApplication.class);
        return application;
    }
}
