package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * deskd's link against the sample's real app, Tally, in Go with only its standard library
 * ({@code spikes/app-contract-sample/cmd/tally}): the contract is a socket, a frame format, JSON, a signal and a directory,
 * and this is two languages meeting on it. Skipped unless {@code TALLY_BIN} names a built Tally
 * ({@code go build ./cmd/tally} in the sample).
 */
@EnabledIfEnvironmentVariable(named = "TALLY_BIN", matches = ".+")
class RealTallyIT {

    @TempDir
    Path dir;

    private Process start(Path socket, Path data) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(System.getenv("TALLY_BIN"));
        Map<String, String> env = pb.environment();
        env.clear();
        env.put("MA_APP_ID", TestApps.ID);
        env.put("MA_APP_VERSION", "0.1.0");
        env.put("MA_APP_API", "1.0");
        env.put("MA_APP_SOCKET", socket.toString());
        env.put("MA_APP_DATA", data.toString());
        env.put("MA_APP_CACHE", data.toString());
        env.put("MA_APP_MEMORY_MAX", String.valueOf(32L << 20));
        env.put("MA_APP_CPU_MAX", "0.25");
        env.put("MA_DESKD_UID", String.valueOf(FakeAppHost.ownUid()));
        env.put("HOME", data.toString());
        pb.redirectErrorStream(true).redirectOutput(dir.resolve("tally.log").toFile());
        return pb.start();
    }

    private static final AppLink.Events EVENTS = new AppLink.Events() {
        @Override
        public Object request(String method, Map<String, Object> params) throws RpcException {
            throw new RpcException(RpcException.NOT_FOUND, "No such method");
        }

        @Override
        public void down(AppLink link, boolean planned, int code) {}
    };

    @Test
    void deskdAndTheGoSampleSpeakTheSameAppApi() throws Exception {
        Path socket = dir.resolve("run/app.sock");
        Files.createDirectories(socket.getParent());
        Path data = Files.createDirectories(dir.resolve("data"));
        Process tally = start(socket, data);
        try {
            Map<String, Object> hello = Map.of("appApi", "1.0", "deskApi", "1.0", "app", Map.of("id", TestApps.ID, "version", "0.1.0"),
                    "grants", List.of(), "limits", Map.of("memoryMaxBytes", 32L << 20));
            AppLink link = AppLink.open(socket, FakeAppHost.ownUid(), hello, Duration.ofSeconds(5), EVENTS);
            assertThat(link.hello()).containsEntry("appApi", "1.0");

            List<String> events = new CopyOnWriteArrayList<>();
            link.subscribe("tally", Map.of("kind", "view"), (type, d) -> events.add(type), Duration.ofSeconds(2));
            List<Map<String, Object>> summaries = new CopyOnWriteArrayList<>();
            link.subscribe("app.summary", Map.of("kind", "desk"), (type, d) -> {
                Map<String, Object> checked = AppSummary.check(d);
                if (checked != null) {
                    summaries.add(checked);
                }
            }, Duration.ofSeconds(2));
            await().until(() -> events.size() == 1 && summaries.size() == 1);

            Map<String, Object> add = link.call(Map.of("m", "tally.add", "p", Map.of("by", 3), "idem", "it-1",
                    "from", Map.of("kind", "view", "caller", Map.of("kind", "owner"))), Duration.ofSeconds(2), null);
            assertThat(add).containsEntry("count", 3);
            assertThat(link.call(Map.of("m", "tally.add", "p", Map.of("by", 3), "idem", "it-1"), Duration.ofSeconds(2), null))
                    .as("Tally dedupes by idem").containsEntry("count", 3);
            await().until(() -> events.size() == 2 && summaries.size() == 2);
            assertThat(events).containsExactly("snapshot", "patch");
            assertThat(summaries.get(1).toString()).contains("text=3");

            // An unknown field in deskd's request is ignored, as section 1.5 asks of every app.
            assertThat(link.call(Map.of("m", "tally.get", "p", Map.of(), "fromTheFuture", true), Duration.ofSeconds(2), null))
                    .containsEntry("count", 3);
            assertThat(Files.readString(data.resolve("tally.json"))).contains("\"count\":3");
            link.close();
        } finally {
            tally.destroy();
            assertThat(tally.waitFor(5, TimeUnit.SECONDS)).as("Tally stops on SIGTERM").isTrue();
        }
    }
}
