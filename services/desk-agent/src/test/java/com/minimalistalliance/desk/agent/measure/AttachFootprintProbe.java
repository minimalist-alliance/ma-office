package com.minimalistalliance.desk.agent.measure;

import com.minimalistalliance.desk.agent.DeskAgentApplication;
import com.minimalistalliance.desk.agent.socket.PeerCheck;
import com.minimalistalliance.desk.agent.testing.AgentSocketClient;
import com.minimalistalliance.desk.agent.testing.FakeLlmServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Not a test: what attaching files costs desk-agent in memory (ADR 0049), in the worst cases the caps allow. Run by
 * scripts/measure-attach.sh with the image's flags. The real application boots as main does, the provider stand-in is
 * a JVM of its own ({@link StandIn}), and files go up as deskd sends them: chunks over the agent socket, then a send.
 * A sampler reads /proc every 20 ms from the first chunk to the end of the reply and keeps the peaks of this process,
 * of its parse children, and of both together, as RSS, anonymous memory (what a container's limit counts for sure)
 * and Java heap in use. Prints one line of key=value pairs.
 *
 * <p>Args: a temporary directory, the stand-in's URL, and a scenario: {@code docs} (five PDFs of 100 pages that fill
 * the 8 MiB file cap, text to the character cap), {@code images} (12 MiB of pictures) or {@code mixed}.
 */
public final class AttachFootprintProbe {

    private static final String MODEL = "claude-sonnet-5-5";
    private static final AtomicLong MAX_SELF_RSS = new AtomicLong();
    private static final AtomicLong MAX_SELF_ANON = new AtomicLong();
    private static final AtomicLong MAX_CHILD_RSS = new AtomicLong();
    private static final AtomicLong MAX_CHILD_ANON = new AtomicLong();
    private static final AtomicLong MAX_ALL_RSS = new AtomicLong();
    private static final AtomicLong MAX_ALL_ANON = new AtomicLong();
    private static final AtomicLong MAX_HEAP = new AtomicLong();
    private static final AtomicLong MAX_CHILDREN = new AtomicLong();

    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args[0]);
        String standIn = args[1];
        String scenario = args[2];
        Path data = Files.createDirectories(dir.resolve("data"));
        StringBuilder line = new StringBuilder(" scenario=" + scenario);
        try (ConfigurableApplicationContext context = DeskAgentApplication.application().run(
                "--desk.agent.data.dir=" + data,
                "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.peer.uid=" + PeerCheck.ownUid(),
                "--desk.agent.anthropic.url=" + standIn);
                AgentSocketClient desk = new AgentSocketClient(dir.resolve("agent.sock"))) {
            Map<String, Object> key = AgentSocketClient.map(
                    desk.addKey("anthropic", "Probe", AgentSocketClient.ascii(FakeLlmServer.KEY)).get("r"));
            String keyId = (String) AgentSocketClient.map(key.get("key")).get("keyId");
            desk.call("agent.bind", Map.of("agentId", "manager", "keyId", keyId, "model", MODEL));
            desk.subscribe(1, "agent.conversation:manager");
            desk.event(1, "snapshot");
            Thread.sleep(3000);
            line.append(sample("idle"));

            List<String> agents = new ArrayList<>(List.of("manager"));
            if (scenario.endsWith("2")) {
                Map<String, Object> account = new java.util.LinkedHashMap<>();
                account.put("deskDay", null);
                account.put("deskMonth", null);
                account.put("timeZone", null);
                account.put("tier", Map.of("agentCap", 5));
                ok(desk.call("desk.account.set", account));
                Map<String, Object> created = ok(desk.call("agent.create",
                        Map.of("name", "Probe helper", "purpose", "Measure two runs at once.")));
                String helper = (String) AgentSocketClient.map(AgentSocketClient.map(created.get("r")).get("agent")).get("id");
                ok(desk.call("agent.bind", Map.of("agentId", helper, "keyId", keyId, "model", MODEL)));
                desk.subscribe(2, "agent.conversation:" + helper);
                desk.event(2, "snapshot");
                agents.add(helper);
            }
            String base = scenario.replaceAll("2$", "");
            List<Object[]> files = files(base);
            AtomicBoolean running = new AtomicBoolean(true);
            Thread sampler = Thread.ofPlatform().daemon().start(() -> {
                while (running.get()) {
                    peak();
                    try {
                        Thread.sleep(20);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            });
            long started = System.nanoTime();
            long total = 0;
            List<List<String>> uploads = new ArrayList<>();
            for (String agent : agents) {
                List<String> ids = new ArrayList<>();
                for (Object[] file : files) {
                    byte[] bytes = (byte[]) file[1];
                    total += bytes.length;
                    String id = "probe-" + ids.size() + "-" + Long.toHexString(System.nanoTime());
                    int index = 0;
                    for (int at = 0; at < bytes.length; at += 512 * 1024, index++) {
                        byte[] part = Arrays.copyOfRange(bytes, at, Math.min(bytes.length, at + 512 * 1024));
                        ok(desk.call("agent.attach.put", Map.of("agentId", agent, "uploadId", id, "name", file[0], "size",
                                bytes.length, "index", index, "data", Base64.getEncoder().encodeToString(part))));
                    }
                    ids.add(id);
                }
                uploads.add(ids);
            }
            long uploaded = System.nanoTime();
            int refused = 0;
            for (int i = 0; i < agents.size(); i++) {
                Map<String, Object> reply = desk.call("agent.message.send", Map.of("agentId", agents.get(i), "text",
                        "Summarise these.", "attachments", uploads.get(i)));
                if ("err".equals(reply.get("t")) && "conflict".equals(reply.get("code"))) {
                    // The pictures budget is spoken for: wait for the first answer, then send again.
                    refused++;
                    waitDone(desk, 1);
                    reply = desk.call("agent.message.send", Map.of("agentId", agents.get(i), "text", "Summarise these.",
                            "attachments", uploads.get(i)));
                    waitDone(desk, i + 1);
                }
                ok(reply);
            }
            long sent = System.nanoTime();
            for (int i = 0; i < agents.size(); i++) {
                if (refused == 0 || i == 0 && refused == 0) {
                    waitDone(desk, i + 1);
                }
            }
            long answered = System.nanoTime();
            running.set(false);
            sampler.join();
            line.append(" agents=").append(agents.size()).append(" files=").append(files.size()).append(" totalMiB=").append(total >> 20);
            line.append(" uploadMs=").append((uploaded - started) / 1_000_000).append(" sendMs=")
                    .append((sent - uploaded) / 1_000_000).append(" answerMs=").append((answered - sent) / 1_000_000);
            line.append(" peakSelfRssMiB=").append(MAX_SELF_RSS.get() >> 10).append(" peakSelfAnonMiB=")
                    .append(MAX_SELF_ANON.get() >> 10).append(" peakChildRssMiB=").append(MAX_CHILD_RSS.get() >> 10)
                    .append(" peakChildAnonMiB=").append(MAX_CHILD_ANON.get() >> 10).append(" peakAllRssMiB=")
                    .append(MAX_ALL_RSS.get() >> 10).append(" peakAllAnonMiB=").append(MAX_ALL_ANON.get() >> 10)
                    .append(" peakHeapMiB=").append(MAX_HEAP.get() >> 20).append(" refusedBusy=").append(refused).append(" peakChildren=")
                    .append(MAX_CHILDREN.get());
            Thread.sleep(1000);
            line.append(sample("after"));
        }
        System.out.println("probe" + line);
    }

    /** Waits for an agent's reply to end. */
    private static void waitDone(AgentSocketClient desk, long sid) throws Exception {
        while (true) {
            Map<String, Object> event = desk.event(sid, "message");
            Map<String, Object> message = AgentSocketClient.map(AgentSocketClient.map(event.get("data")).get("message"));
            if ("assistant".equals(message.get("role")) && !"streaming".equals(message.get("state"))) {
                if (!"done".equals(message.get("state"))) {
                    throw new IllegalStateException("a reply ended " + message.get("state") + " "
                            + message.get("error") + " " + message.get("errorDetail"));
                }
                return;
            }
        }
    }

    private static Map<String, Object> ok(Map<String, Object> reply) {
        if (!"res".equals(reply.get("t"))) {
            throw new IllegalStateException("refused: " + reply);
        }
        return reply;
    }

    private static List<Object[]> files(String scenario) throws IOException {
        List<Object[]> files = new ArrayList<>();
        switch (scenario) {
            case "docs" -> {
                // 12 MiB in all, the total cap: one at the 8 MiB file cap, four of 1 MiB.
                files.add(new Object[] {"report-big.pdf", pdf(100, 8 << 20, 10)});
                for (int i = 0; i < 4; i++) {
                    files.add(new Object[] {"report-" + i + ".pdf", pdf(100, 1 << 20, 2)});
                }
            }
            case "images" -> {
                files.add(new Object[] {"a.png", image(5 << 20)});
                files.add(new Object[] {"b.png", image(5 << 20)});
                files.add(new Object[] {"c.png", image(2 << 20)});
            }
            case "mixed" -> {
                files.add(new Object[] {"a.png", image(4 << 20)});
                files.add(new Object[] {"b.png", image(4 << 20)});
                for (int i = 0; i < 3; i++) {
                    files.add(new Object[] {"report-" + i + ".pdf", pdf(100, 1 << 20, 2)});
                }
            }
            default -> throw new IllegalArgumentException(scenario);
        }
        return files;
    }

    /** A PNG header with the declared size, then noise to {@code size} bytes: all desk-agent looks at is the header. */
    private static byte[] image(int size) {
        byte[] bytes = new byte[size];
        new java.util.Random(7).nextBytes(bytes);
        byte[] header = com.minimalistalliance.desk.agent.attach.Fixtures.png(1600, 1200);
        System.arraycopy(header, 0, bytes, 0, header.length);
        return bytes;
    }

    /**
     * A PDF of {@code pages} pages, each with {@code lines} lines of 100 characters, padded
     * after its end to about {@code size} bytes with junk the reader must get past.
     */
    private static byte[] pdf(int pages, int size, int lines) throws IOException {
        try (PDDocument document = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            for (int i = 0; i < pages; i++) {
                PDPage page = new PDPage();
                document.addPage(page);
                try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                    content.beginText();
                    content.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 8);
                    content.setLeading(10);
                    content.newLineAtOffset(20, 760);
                    for (int line = 0; line < lines; line++) {
                        content.showText(("page " + i + " line " + line + " lorem ipsum dolor sit amet ").repeat(4).substring(0, 100));
                        content.newLine();
                    }
                    content.endText();
                }
            }
            document.save(out);
            byte[] pdf = out.toByteArray();
            if (pdf.length >= size) {
                return pdf;
            }
            byte[] padded = Arrays.copyOf(pdf, size);
            Arrays.fill(padded, pdf.length, size, (byte) '%');
            return padded;
        }
    }

    private static void peak() {
        long self = status(ProcessHandle.current().pid(), "VmRSS:");
        long selfAnon = status(ProcessHandle.current().pid(), "RssAnon:");
        long childRss = 0;
        long childAnon = 0;
        long children = 0;
        for (ProcessHandle child : ProcessHandle.current().children().toList()) {
            childRss += status(child.pid(), "VmRSS:");
            childAnon += status(child.pid(), "RssAnon:");
            children++;
        }
        max(MAX_SELF_RSS, self);
        max(MAX_SELF_ANON, selfAnon);
        max(MAX_CHILD_RSS, childRss);
        max(MAX_CHILD_ANON, childAnon);
        max(MAX_ALL_RSS, self + childRss);
        max(MAX_ALL_ANON, selfAnon + childAnon);
        max(MAX_CHILDREN, children);
        max(MAX_HEAP, ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed());
    }

    private static void max(AtomicLong holder, long value) {
        holder.accumulateAndGet(value, Math::max);
    }

    /** One /proc/pid/status field, in KiB; 0 for a process that has gone. */
    private static long status(long pid, String field) {
        try {
            for (String status : Files.readAllLines(Path.of("/proc/" + pid + "/status"))) {
                if (status.startsWith(field)) {
                    return Long.parseLong(status.replaceAll("[^0-9]", ""));
                }
            }
        } catch (IOException | RuntimeException e) {
            // The process ended.
        }
        return 0;
    }

    private static String sample(String label) {
        long pid = ProcessHandle.current().pid();
        return " " + label + "RssMiB=" + (status(pid, "VmRSS:") >> 10) + " " + label + "AnonMiB="
                + (status(pid, "RssAnon:") >> 10) + " " + label + "HeapMiB="
                + (ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed() >> 20);
    }
}
