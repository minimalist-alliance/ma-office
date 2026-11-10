package com.minimalistalliance.desk.agent.measure;

import com.minimalistalliance.desk.agent.DeskAgentApplication;
import com.minimalistalliance.desk.agent.socket.PeerCheck;
import com.minimalistalliance.desk.agent.testing.AgentSocketClient;
import com.minimalistalliance.desk.agent.testing.FakeLlmServer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Not a test: scripts/measure.sh runs this main with the image's flags and archive, to see what the answer path
 * costs in RSS and CPU on top of an idle desk-agent. The real application boots as main does and is driven through
 * its agent socket as deskd will drive it: a key, a binding, then answers through the real Anthropic adapter and the
 * JDK's HTTP client, against a loopback stand-in in clear HTTP (so no TLS). Prints one line of key=value pairs.
 *
 * <p>Args: a temporary directory, and how many answers to time after the first.
 */
public final class FootprintProbe {

    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args[0]);
        int more = Integer.parseInt(args[1]);
        Path data = Files.createDirectories(dir.resolve("data"));
        StringBuilder line = new StringBuilder();
        try (FakeLlmServer llm = new FakeLlmServer();
                ConfigurableApplicationContext context = DeskAgentApplication.application().run(
                        "--desk.agent.data.dir=" + data,
                        "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
                        "--desk.agent.socket=" + dir.resolve("agent.sock"),
                        "--desk.agent.peer.uid=" + PeerCheck.ownUid(),
                        "--desk.agent.anthropic.url=" + llm.url());
                AgentSocketClient desk = new AgentSocketClient(dir.resolve("agent.sock"))) {
            line.append(sample("ready"));
            Map<String, Object> key = AgentSocketClient.map(
                    desk.addKey("anthropic", "Probe", AgentSocketClient.ascii(FakeLlmServer.KEY)).get("r"));
            String keyId = (String) AgentSocketClient.map(key.get("key")).get("keyId");
            desk.call("agent.bind", Map.of("agentId", "manager", "keyId", keyId, "model", "claude-sonnet-5-5"));
            desk.subscribe(1, "agent.conversation:manager");
            desk.event(1, "snapshot");

            long first = System.nanoTime();
            answer(desk);
            line.append(" firstAnswerMs=").append((System.nanoTime() - first) / 1_000_000);
            line.append(sample("first"));

            long started = System.nanoTime();
            for (int i = 0; i < more; i++) {
                answer(desk);
            }
            long perAnswerUs = more == 0 ? 0 : (System.nanoTime() - started) / 1000 / more;
            line.append(" answers=").append(more).append(" perAnswerUs=").append(perAnswerUs);
            line.append(sample("after"));
        }
        System.out.println("probe" + line);
    }

    /** One message, then its reply's final message on the conversation topic. */
    private static void answer(AgentSocketClient desk) throws Exception {
        desk.call("agent.message.send", Map.of("agentId", "manager", "text", "What's on my desk today?"));
        while (true) {
            Map<String, Object> event = desk.event(1, "message");
            Map<String, Object> message = AgentSocketClient.map(AgentSocketClient.map(event.get("data")).get("message"));
            if ("assistant".equals(message.get("role")) && !"streaming".equals(message.get("state"))) {
                if (!"done".equals(message.get("state"))) {
                    throw new IllegalStateException("a reply ended " + message.get("state"));
                }
                return;
            }
        }
    }

    private static String sample(String label) throws Exception {
        long rss = 0;
        long anon = 0;
        for (String status : Files.readAllLines(Path.of("/proc/self/status"))) {
            if (status.startsWith("VmRSS:")) {
                rss = kib(status);
            } else if (status.startsWith("RssAnon:")) {
                anon = kib(status);
            }
        }
        String stat = Files.readString(Path.of("/proc/self/stat"));
        String[] fields = stat.substring(stat.lastIndexOf(')') + 2).split(" ");
        long ticks = Long.parseLong(fields[11]) + Long.parseLong(fields[12]);
        return " " + label + "RssMiB=" + rss / 1024 + " " + label + "AnonMiB=" + anon / 1024 + " " + label + "Ticks="
                + ticks;
    }

    private static long kib(String status) {
        return Long.parseLong(status.replaceAll("[^0-9]", ""));
    }
}
