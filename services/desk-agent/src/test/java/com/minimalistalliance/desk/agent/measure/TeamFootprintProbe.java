package com.minimalistalliance.desk.agent.measure;

import com.minimalistalliance.desk.agent.DeskAgentApplication;
import com.minimalistalliance.desk.agent.socket.PeerCheck;
import com.minimalistalliance.desk.agent.testing.AgentSocketClient;
import com.minimalistalliance.desk.agent.testing.FakeLlmServer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Not a test: {@code scripts/measure.sh team} runs this main with the image's flags and archive (task 49, README
 * "Footprint, many agents"). The real application boots as main does and is driven through its agent socket as deskd
 * drives it: the tier's cap raised to 100 by {@code desk.account.set}, a key, then agents made with {@code agent.create}
 * and bound to the key, each with its workspace folder. It reads /proc/self after each step (the fake provider and the
 * socket client share the process, as in {@link FootprintProbe}), and prints one {@code team stage=... key=value} line
 * per step:
 *
 * <ul>
 *   <li>{@code ready}, then {@code idle-1}, {@code idle-10}, {@code idle-50}, {@code idle-99}: RSS after the agents
 *       exist and a settle, and the CPU ticks over 10 s with all of them idle (timers thread included);
 *   <li>{@code run-1}, {@code run-2}, {@code run-4} ({@code small-run-N} in small mode): that many runs at once, each streaming about 4 KB from the fake
 *       provider over about a second, peak RSS (polled every 10 ms) and RSS after, CPU ticks per run;
 *   <li>{@code tools-3}: one run whose reply (paced the same way) is three {@code workspace_write} calls and then a final answer.
 * </ul>
 *
 * <p>Args: a temporary directory, and the mode: {@code full} (the idle stages up to 99 agents beside the lead, 100 in all, the cap, then the runs with the
 * 99 present) or {@code small} (4 agents only, for the runs against a small desk).
 */
public final class TeamFootprintProbe {

    private static final String MODEL = "claude-sonnet-5-5";
    private static final int PIECES = 50;
    private static final int PIECE_CHARS = 80;
    private static final long PIECE_PAUSE_MS = 20;
    private static final long SETTLE_MS = 4000;
    private static final long IDLE_WINDOW_MS = 10_000;

    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args[0]);
        boolean full = args.length < 2 || "full".equals(args[1]);
        Path data = Files.createDirectories(dir.resolve("data"));
        try (FakeLlmServer llm = new FakeLlmServer();
                ConfigurableApplicationContext context = DeskAgentApplication.application().run(
                        "--desk.agent.data.dir=" + data,
                        "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
                        "--desk.agent.socket=" + dir.resolve("agent.sock"),
                        "--desk.agent.peer.uid=" + PeerCheck.ownUid(),
                        "--desk.agent.anthropic.url=" + llm.url());
                AgentSocketClient desk = new AgentSocketClient(dir.resolve("agent.sock"))) {
            Thread.sleep(SETTLE_MS);
            print("ready", sample(), "agents", 1);
            Map<String, Object> account = new LinkedHashMap<>();
            account.put("deskDay", null);
            account.put("deskMonth", null);
            account.put("timeZone", null);
            account.put("tier", Map.of("agentCap", 100));
            ok(desk.call("desk.account.set", account));
            String keyId = (String) AgentSocketClient.map(AgentSocketClient.map(
                    desk.addKey("anthropic", "Probe", AgentSocketClient.ascii(FakeLlmServer.KEY)).get("r"))
                    .get("key")).get("keyId");
            List<String> ids = new ArrayList<>();
            int target = full ? 99 : 4;
            int[] stages = full ? new int[] {1, 10, 50, 99} : new int[] {4};
            for (int stage : stages) {
                while (ids.size() < stage) {
                    Map<String, Object> created = ok(desk.call("agent.create", Map.of("name", "Probe agent " + ids.size(),
                            "purpose", "Measure what an idle agent costs.")));
                    String id = (String) AgentSocketClient.map(AgentSocketClient.map(created.get("r")).get("agent"))
                            .get("id");
                    ok(desk.call("agent.bind", Map.of("agentId", id, "keyId", keyId, "model", MODEL)));
                    ids.add(id);
                }
                Thread.sleep(SETTLE_MS);
                long[] before = sample();
                Thread.sleep(IDLE_WINDOW_MS);
                long[] after = sample();
                print(full ? "idle-" + stage : "small-" + stage, after, "idleTicks10s", after[3] - before[3],
                        "agents", ids.size() + 1, "workspaces", countWorkspaces(data));
            }
            if (ids.size() != target) {
                throw new IllegalStateException("agents " + ids.size());
            }
            for (int i = 0; i < ids.size(); i++) {
                desk.subscribe(i + 1, "agent.conversation:" + ids.get(i));
                desk.event(i + 1, "snapshot");
            }
            for (int runs : new int[] {1, 2, 4}) {
                for (int i = 0; i < runs; i++) {
                    llm.then(FakeLlmServer.anthropic(MODEL, 100, 20, pieces()).paced(PIECE_PAUSE_MS));
                }
                run(desk, ids, runs, (full ? "run-" : "small-run-") + runs, null);
            }
            // One run in a tool loop: three workspace_write calls of about 2 KB each, then the answer.
            String body = "x".repeat(2000);
            llm.then(FakeLlmServer.anthropicTools(MODEL, 100, 20, "Writing notes.", 200,
                    new FakeLlmServer.Call("toolu_1", "workspace_write", "{\"path\":\"notes/a.md\",\"text\":\"" + body + "\"}"),
                    new FakeLlmServer.Call("toolu_2", "workspace_write", "{\"path\":\"notes/b.md\",\"text\":\"" + body + "\"}"),
                    new FakeLlmServer.Call("toolu_3", "workspace_write", "{\"path\":\"notes/c.md\",\"text\":\"" + body + "\"}"))
                    .paced(PIECE_PAUSE_MS));
            llm.then(FakeLlmServer.anthropic(MODEL, 400, 20, "Done: ", "TOOLSDONE").paced(PIECE_PAUSE_MS));
            run(desk, ids, 1, full ? "tools-3" : "small-tools-3", "TOOLSDONE");
        }
    }

    /** Sends one message to each of the first {@code runs} agents, waits for every reply, and prints the step. */
    private static void run(AgentSocketClient desk, List<String> ids, int runs, String stage, String marker)
            throws Exception {
        Thread.sleep(SETTLE_MS);
        long[] before = sample();
        AtomicLong peak = new AtomicLong(before[0]);
        AtomicBoolean stop = new AtomicBoolean();
        Thread poller = new Thread(() -> {
            try {
                while (!stop.get()) {
                    peak.accumulateAndGet(sample()[0], Math::max);
                    Thread.sleep(10);
                }
            } catch (Exception e) {
                // The step ends anyway.
            }
        });
        poller.start();
        long started = System.nanoTime();
        for (int i = 0; i < runs; i++) {
            ok(desk.call("agent.message.send", Map.of("agentId", ids.get(i), "text", "Write me a few notes.")));
        }
        for (int i = 0; i < runs; i++) {
            awaitDone(desk, i + 1, marker);
        }
        long ms = (System.nanoTime() - started) / 1_000_000;
        long[] done = sample();
        stop.set(true);
        poller.join();
        Thread.sleep(SETTLE_MS);
        long[] after = sample();
        print(stage, after, "peakRssMiB", peak.get() / 1024, "baseRssMiB", before[0] / 1024, "ms", ms,
                "ticksPerRun", Math.round(10.0 * (done[3] - before[3]) / runs) / 10.0, "agents", ids.size() + 1);
    }

    private static void awaitDone(AgentSocketClient desk, long sid, String marker) throws Exception {
        while (true) {
            Map<String, Object> event = desk.event(sid, "message");
            Map<String, Object> message = AgentSocketClient.map(AgentSocketClient.map(event.get("data")).get("message"));
            if (!"assistant".equals(message.get("role")) || "streaming".equals(message.get("state"))) {
                continue;
            }
            if (!"done".equals(message.get("state"))) {
                throw new IllegalStateException("a reply ended " + message.get("state"));
            }
            if (marker == null || String.valueOf(message.get("text")).contains(marker)) {
                return;
            }
        }
    }

    private static String[] pieces() {
        String[] pieces = new String[PIECES];
        for (int i = 0; i < PIECES; i++) {
            pieces[i] = ("Piece " + i + " of the reply. ").repeat(PIECE_CHARS / 20 + 1).substring(0, PIECE_CHARS);
        }
        return pieces;
    }

    private static Map<String, Object> ok(Map<String, Object> reply) {
        if (!"res".equals(reply.get("t"))) {
            throw new IllegalStateException("refused: " + reply);
        }
        return reply;
    }

    private static long countWorkspaces(Path data) throws Exception {
        Path root = data.resolve("workspaces");
        if (!Files.isDirectory(root)) {
            return 0;
        }
        try (Stream<Path> children = Files.list(root)) {
            return children.filter(Files::isDirectory).count();
        }
    }

    /** RSS, anon and file KiB, then CPU ticks (utime + stime) of this process. */
    private static long[] sample() throws Exception {
        long rss = 0;
        long anon = 0;
        long file = 0;
        for (String status : Files.readAllLines(Path.of("/proc/self/status"))) {
            if (status.startsWith("VmRSS:")) {
                rss = kib(status);
            } else if (status.startsWith("RssAnon:")) {
                anon = kib(status);
            } else if (status.startsWith("RssFile:")) {
                file = kib(status);
            }
        }
        String stat = Files.readString(Path.of("/proc/self/stat"));
        String[] fields = stat.substring(stat.lastIndexOf(')') + 2).split(" ");
        return new long[] {rss, anon, file, Long.parseLong(fields[11]) + Long.parseLong(fields[12])};
    }

    private static long kib(String status) {
        return Long.parseLong(status.replaceAll("[^0-9]", ""));
    }

    private static void print(String stage, long[] s, Object... extra) {
        StringBuilder line = new StringBuilder("team stage=").append(stage).append(" rssMiB=").append(s[0] / 1024)
                .append(" anonMiB=").append(s[1] / 1024).append(" fileMiB=").append(s[2] / 1024).append(" ticks=")
                .append(s[3]);
        for (int i = 0; i < extra.length; i += 2) {
            line.append(' ').append(extra[i]).append('=').append(extra[i + 1]);
        }
        System.out.println(line);
    }
}
