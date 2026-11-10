package com.minimalistalliance.desk.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.manager.AgentException;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.Health;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ConfigurableApplicationContext;

/** Boots the real application, as main does, and drives it through its real socket and beans. */
@ExtendWith(OutputCaptureExtension.class)
class DeskAgentApplicationTests {

    private static final String KEY = "sk-fake-this-must-never-be-logged-0123";

    @TempDir
    Path dir;

    @Test
    void bootsAndReportsReady(CapturedOutput output) throws Exception {
        assertBootsAndReportsReady(output, dir);
    }

    @Test
    void theManagerAnswersEndToEnd(CapturedOutput output) throws Exception {
        assertManagerAnswers(output, dir);
    }

    @Test
    void healthIs503WhenTheDataDirectoryIsMissing() throws Exception {
        String[] args = {
            "--desk.agent.data.dir=" + dir.resolve("absent"),
            "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
            "--desk.agent.socket=" + dir.resolve("agent.sock"),
        };
        try (ConfigurableApplicationContext context = DeskAgentApplication.application().run(args)) {
            assertThat(Health.get(dir.resolve("admin.sock")))
                    .startsWith("HTTP/1.1 503 ")
                    .contains("\"status\":\"failing\"", "\"data\":\"unwritable\"", "\"audit\":\"closed\"");
            // It takes no key it couldn't record, so the manager stays dormant and nothing is sent.
            ManagerAgent manager = context.getBean(ManagerAgent.class);
            FakeProvider fake = new FakeProvider();
            context.getBean(ProviderRegistry.class).register(fake);
            byte[] secret = KEY.getBytes(StandardCharsets.US_ASCII);
            assertThatThrownBy(() -> context.getBean(KeyRing.class).put("k1", FakeProvider.ID, secret))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(secret).containsOnly(0);
            manager.bind(new ManagerAgent.Binding("k1", FakeProvider.ID, "fake-model", 64));
            assertThatThrownBy(() -> manager.answer(List.of(ChatMessage.user("hi")), text -> {}))
                    .isInstanceOfSatisfying(AgentException.class,
                            e -> assertThat(e.code()).isEqualTo(AgentException.Code.NO_KEY));
            assertThat(fake.seen).isEmpty();
        }
    }

    @Test
    void healthIs503WhenTheDatabaseIsFromANewerRelease() throws Exception {
        Path data = Files.createDirectory(dir.resolve("data"));
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + data.resolve("audit.db"));
                var statement = connection.createStatement()) {
            statement.execute("PRAGMA user_version = 99");
        }
        try (ConfigurableApplicationContext context = DeskAgentApplication.application().run(args(dir, data))) {
            assertThat(Health.get(dir.resolve("admin.sock"))).startsWith("HTTP/1.1 503 ").contains("\"audit\":\"closed\"");
        }
    }

    @Test
    void theVersionComesFromTheBuild() throws Exception {
        try (var in = DeskAgentApplicationTests.class.getResourceAsStream("/application.properties")) {
            String properties = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            assertThat(properties).containsPattern("desk\\.agent\\.version=\\d");
        }
    }

    static String[] args(Path dir, Path data) {
        return new String[] {
            "--desk.agent.data.dir=" + data,
            "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
            "--desk.agent.socket=" + dir.resolve("agent.sock"),
        };
    }

    static void assertBootsAndReportsReady(CapturedOutput output, Path dir) throws Exception {
        Path data = Files.createDirectory(dir.resolve("data"));
        try (ConfigurableApplicationContext context = DeskAgentApplication.application().run(args(dir, data))) {
            assertThat(context.getBean(ReadinessReporter.class).readyMillis()).isNotNegative();
            String health = Health.get(dir.resolve("admin.sock"));
            assertThat(health)
                    .startsWith("HTTP/1.1 200 ")
                    .contains("\"status\":\"ok\"", "\"data\":\"ok\"", "\"audit\":\"open\"", "\"usage\":\"open\"",
                            "\"manager\":\"no_key\"", "\"keys\":0");
            assertThat(health).doesNotContain("\"version\":\"unknown\"").doesNotContain("@");
            assertThat(Files.getPosixFilePermissions(dir.resolve("admin.sock")))
                    .containsExactlyInAnyOrder(java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                            java.nio.file.attribute.PosixFilePermission.OWNER_WRITE);
        }
        assertThat(output.getOut().lines().filter(line -> line.contains("desk-agent ready in")))
                .singleElement()
                .asString()
                .containsPattern("desk-agent ready in \\d+ ms$");
        assertThat(dir.resolve("admin.sock")).doesNotExist();
        assertThat(data.resolve("audit.db")).exists();
        assertThat(data.resolve("usage.db")).exists();
    }

    /**
     * A key arrives, the manager is bound, answers through the fake with its badge, and the stop zeroes the key.
     * The audit chain holds start, key add, the call and the stop, and the key is in no log line.
     */
    static void assertManagerAnswers(CapturedOutput output, Path dir) throws Exception {
        Path data = Files.createDirectory(dir.resolve("data"));
        FakeProvider fake = new FakeProvider();
        KeyRing keys;
        try (ConfigurableApplicationContext context = DeskAgentApplication.application().run(args(dir, data))) {
            context.getBean(ProviderRegistry.class).register(fake);
            keys = context.getBean(KeyRing.class);
            byte[] secret = KEY.getBytes(StandardCharsets.US_ASCII);
            keys.put("k1", FakeProvider.ID, secret);
            assertThat(secret).containsOnly(0);

            ManagerAgent manager = context.getBean(ManagerAgent.class);
            manager.bind(new ManagerAgent.Binding("k1", FakeProvider.ID, "fake-model", 64));
            StringBuilder streamed = new StringBuilder();
            ManagerAgent.RunResult answer = manager.answer(List.of(ChatMessage.user("Hello?")), streamed::append);
            assertThat(answer.state()).isEqualTo(ManagerAgent.RunState.DONE);

            assertThat(answer.text()).isEqualTo("Hello from the fake.").isEqualTo(streamed.toString());
            assertThat(answer.badge()).isEqualTo(new ManagerAgent.Badge("fake", "Fake", "fake-model"));
            // The bundled pricing.json lists neither this model nor this provider, so it counts at the table's highest.
            assertThat(answer.costMicroUsd()).isPositive();
            assertThat(fake.seen).singleElement().satisfies(seen -> {
                assertThat(seen.key()).isEqualTo(KEY);
                assertThat(seen.request().system()).isNotBlank();
            });
            assertThat(Health.get(dir.resolve("admin.sock"))).contains("\"manager\":\"online\"", "\"keys\":1");
        }
        assertThat(keys.size()).isZero();

        try (AuditLog audit = new AuditLog(data.resolve("audit.db"), java.time.Clock.systemUTC())) {
            audit.open();
            assertThat(audit.verify().intact()).isTrue();
            assertThat(audit.read(0, 100))
                    .extracting(row -> row.entry().action() + " " + row.entry().decision())
                    .containsExactly("service.start ok", "key.add provider:fake", "llm.call ok",
                            "key.drop zeroed:1", "service.stop ok");
        }
        assertThat(output.getAll()).doesNotContain(KEY, "Hello?", "Hello from the fake.");
    }
}
