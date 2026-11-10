package com.minimalistalliance.desk.agent.training;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.socket.PeerCheck;
import java.io.IOException;
import java.io.InputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * The AppCDS training run, in deskd's pattern (services/CLAUDE.md, Release rules): the real desk-agent, wired as on
 * a desk, driven through its agent socket as deskd will drive it: health, a key in a KEY frame checked against the
 * provider, a binding, one streamed answer through the real Anthropic adapter and the JDK's HTTP client, a refusal by
 * a limit, the audit page and a check of the chain, then a restart that brings the key back from the vault and lists
 * the models with it. Anthropic is a stand-in on a loopback port, in clear HTTP, so TLS's classes aren't in the
 * archive. Everything else of that path is, SQLite's JDBC driver and the vault's cipher among it, instead of being
 * loaded cold by the first answer.
 *
 * <p>Only the Dockerfile's training RUN gets here, through the JVM system property {@code DeskAgentApplication}
 * checks, and never where {@code /run/desk-agent} exists. Its settings are system properties, which outrank the
 * environment, and allow only this process's uid on the socket. It uses no {@code /data}, network or secret: the
 * key is random letters made here. It writes in one temporary directory and deletes it. A dynamic archive holds
 * class metadata only, so no value from this run is kept.
 *
 * <p>With {@code org.sqlite.lib.path} set, as {@code jvm.options} sets it, it also fails if sqlite-jdbc fell back
 * to extracting its native library into the temporary directory: in the container {@code /tmp} is a tmpfs that
 * Docker mounts {@code noexec}, where that library couldn't load. Any step that doesn't go as on a desk exits
 * non-zero and fails the build.
 */
public final class CdsTraining {

    private static final Duration WHOLE_RUN = Duration.ofMinutes(2);

    private CdsTraining() {}

    /** Trains, then ends the JVM, which is what writes the archive. Exits non-zero if anything went wrong. */
    public static void run(Supplier<ConfigurableApplicationContext> application) {
        Thread.ofPlatform().daemon().name("training-limit").start(() -> {
            try {
                Thread.sleep(WHOLE_RUN);
                System.err.println("desk-agent CDS training ran out of time");
                Runtime.getRuntime().halt(1);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        try {
            train(application);
            System.out.println("desk-agent CDS training finished");
        } catch (Exception | Error e) {
            System.err.println("desk-agent CDS training failed: " + e);
            Runtime.getRuntime().halt(1);
        }
        System.exit(0);
    }

    private static void train(Supplier<ConfigurableApplicationContext> application) throws Exception {
        Path sqliteTmp = Path.of(System.getProperty("org.sqlite.tmpdir", System.getProperty("java.io.tmpdir")));
        Set<Path> sqliteBefore = sqliteFiles(sqliteTmp);
        Path dir = Files.createTempDirectory("desk-agent-train");
        SecureRandom random = new SecureRandom();
        StringBuilder made = new StringBuilder("sk-ant-training-");
        for (int i = 0; i < 32; i++) {
            made.append((char) ('a' + random.nextInt(26)));
        }
        String key = made.toString();
        try (TrainingAnthropic anthropic = new TrainingAnthropic(key)) {
            Path data = Files.createDirectory(dir.resolve("data"));
            Path admin = dir.resolve("admin.sock");
            Path socket = dir.resolve("agent.sock");
            System.setProperty("desk.agent.data.dir", data.toString());
            System.setProperty("desk.agent.admin.socket", admin.toString());
            System.setProperty("desk.agent.socket", socket.toString());
            System.setProperty("desk.agent.peer.uid", Integer.toString(PeerCheck.ownUid()));
            System.setProperty("desk.agent.anthropic.url", anthropic.url());
            String keyId;
            try (ConfigurableApplicationContext context = application.get();
                    TrainingClient desk = new TrainingClient(socket)) {
                expect(health(admin).startsWith("HTTP/1.1 200 "), "health isn't 200 after boot");
                result(desk.call("agent.providers", Map.of()));
                result(desk.call("agent.list", Map.of()));
                desk.subscribe(1, "agent.state");
                desk.await(m -> "evt".equals(m.get("t")) && "snapshot".equals(m.get("type")));

                Map<String, Object> added = result(desk.addKey("anthropic", key.getBytes(StandardCharsets.US_ASCII)));
                keyId = (String) Json.object(added, "key").get("keyId");
                result(desk.call("agent.key.models", Map.of("keyId", keyId)));
                result(desk.call("agent.bind",
                        Map.of("agentId", "manager", "keyId", keyId, "model", TrainingAnthropic.MODEL)));
                // What deskd pushes on connecting, and a member's zone: a desk's every period then runs through tzdb.
                try (InputStream table = CdsTraining.class.getResourceAsStream("/pricing.json")) {
                    Map<String, Object> pushed = result(desk.call("desk.prices.set",
                            Map.of("table", new String(table.readAllBytes(), StandardCharsets.UTF_8))));
                    expect(Boolean.TRUE.equals(pushed.get("applied")), "the bundled table wasn't taken");
                }
                result(desk.call("desk.account.set", Map.of("timeZone", "Pacific/Auckland")));
                result(desk.call("agent.limits.set", Map.of("agentId", "manager", "timeZone", "America/Denver")));
                desk.subscribe(2, "agent.conversation:manager");
                result(desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Are you there?")));
                Map<String, Object> reply;
                do {
                    Map<String, Object> event = desk.await(m -> "evt".equals(m.get("t"))
                            && m.get("sid") instanceof Number n && n.longValue() == 2
                            && "message".equals(m.get("type")));
                    reply = Json.object(Json.object(event, "data"), "message");
                } while (!"assistant".equals(reply.get("role")) || "streaming".equals(reply.get("state")));
                expect("done".equals(reply.get("state")), "the reply ended " + reply.get("state"));
                expect("Ready when you are.".equals(reply.get("text")), "the reply's text is wrong");
                result(desk.call("agent.thread.get", Map.of("agentId", "manager")));

                Map<String, Object> view = result(desk.call("agent.limits.get", Map.of("agentId", "manager")));
                Map<String, Object> policy = new LinkedHashMap<>(Json.object(view, "policy"));
                Map<String, Object> oneToken = new LinkedHashMap<>();
                oneToken.put("maxMicroUsd", null);
                oneToken.put("maxTokens", 1);
                policy.put("agentDay", oneToken);
                result(desk.call("agent.limits.set", Map.of("agentId", "manager", "policy", policy)));
                Map<String, Object> refused = desk.call("agent.message.send",
                        Map.of("agentId", "manager", "text", "And now?"));
                expect("err".equals(refused.get("t")), "the limit didn't refuse");
                expect("limit_reached".equals(Json.object(refused, "details").get("reason")),
                        "refused for another reason");
                result(desk.call("agent.audit.list", Map.of("limit", 10)));

                AuditLog.Verification chain = context.getBean(AuditLog.class).verify();
                expect(chain.intact() && chain.rows() >= 5, "the audit chain doesn't check");
                expect(health(admin).contains("\"manager\":\"limit_reached\""), "health doesn't show the limit");
                System.out.println("desk-agent CDS training: socket, key, answer, limit and " + chain.rows()
                        + " audit rows");
            }
            // As an update restarts it. The stand-in answers only the key it was made with, so this checks the bytes.
            try (ConfigurableApplicationContext context = application.get();
                    TrainingClient desk = new TrainingClient(socket)) {
                expect(health(admin).contains("\"keys\":1"), "the key didn't come back after a restart");
                result(desk.call("agent.key.list", Map.of()));
                result(desk.call("agent.key.models", Map.of("keyId", keyId)));
                System.out.println("desk-agent CDS training: a restart, and the key back from the vault");
            }
        } finally {
            try (Stream<Path> files = Files.walk(dir)) {
                for (Path file : files.sorted(Comparator.reverseOrder()).toList()) {
                    Files.deleteIfExists(file);
                }
            }
        }
        if (System.getProperty("org.sqlite.lib.path") != null) {
            Set<Path> extracted = sqliteFiles(sqliteTmp);
            extracted.removeAll(sqliteBefore);
            expect(extracted.isEmpty(), "sqlite-jdbc extracted its library instead of loading org.sqlite.lib.path");
        }
    }

    private static Map<String, Object> result(Map<String, Object> reply) {
        expect("res".equals(reply.get("t")), "a call failed: " + reply.get("code") + " " + reply.get("details"));
        return Json.object(reply, "r");
    }

    private static Set<Path> sqliteFiles(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) {
            return new java.util.HashSet<>();
        }
        try (Stream<Path> files = Files.list(dir)) {
            return files.filter(file -> file.getFileName().toString().startsWith("sqlite-"))
                    .collect(Collectors.toCollection(java.util.HashSet::new));
        }
    }

    private static String health(Path socket) throws IOException {
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            channel.connect(UnixDomainSocketAddress.of(socket));
            channel.write(ByteBuffer.wrap("GET /health HTTP/1.1\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1)));
            ByteBuffer buffer = ByteBuffer.allocate(4096);
            while (buffer.hasRemaining() && channel.read(buffer) >= 0) {
                // Until the server closes.
            }
            return new String(buffer.array(), 0, buffer.position(), StandardCharsets.ISO_8859_1);
        }
    }

    private static void expect(boolean ok, String failure) {
        if (!ok) {
            throw new IllegalStateException(failure);
        }
    }
}
