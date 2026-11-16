package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.tools.CourierTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import com.minimalistalliance.desk.deskd.tools.ToolHostCalls;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * §17's Courier row, the MIME corpus through the agent's tools: every sample of Courier's corpus (multipart, every
 * encoding, malformed and hostile), plus very large ones (a text past the parser's 2 MiB, an attachment of megabytes, a raw
 * message past the store's 48 MiB), goes in as a transport hands it and comes out of {@code courier_read} and
 * {@code courier_new} read or cleanly refused: a whole result that fits, {@code U} and {@code S}, or {@code not_found},
 * never an internal error; no MIME, no HTML and no attachment's bytes in anything an agent gets.
 */
@SuppressWarnings("unchecked")
class CourierToolsMimeTest {

    private static final String AGENT = "ag-mime00000001";

    private long nextId = 1;

    private Map<String, Object> call(ToolHost host, String tool, Map<String, Object> args, boolean keyed) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", nextId++);
        m.put("runId", "run-mime");
        m.put("agentId", AGENT);
        m.put("tool", tool);
        m.put("args", args);
        m.put("taint", List.of());
        return keyed ? ToolHostCalls.keyed(host, m) : ToolHostCalls.handle(host, m);
    }

    private static String json(Object o) {
        return new String(Json.bytes(o), StandardCharsets.UTF_8);
    }

    private static void wholeAndClean(Map<String, Object> reply, String what) {
        assertThat(reply.get("t")).as(what + ": %s", reply).isEqualTo("tres");
        Map<String, Object> r = (Map<String, Object>) reply.get("r");
        assertThat((List<String>) r.get("taints")).as(what).containsExactlyInAnyOrder("U", "S");
        String inner = json(r.get("content"));
        assertThat(json(Map.of("c", inner)).length() - 8).as(what + " fits").isLessThanOrEqualTo(CourierTools.BUDGET);
        assertThat(inner).as(what + " has no MIME").doesNotContain("Content-Transfer-Encoding").doesNotContain("Content-Type:")
                .doesNotContain("boundary=");
        assertThat(inner).as(what + " has no HTML").doesNotContain("<html").doesNotContain("<body").doesNotContain("<script")
                .doesNotContain("<img");
    }

    @Test
    void everySampleIsReadOrCleanlyRefusedThroughTheTools(@TempDir Path dir) throws Exception {
        Path root = Path.of(getClass().getResource("/courier/mime").toURI());
        List<String> lines = Files.readAllLines(root.resolve("expect.tsv"));
        try (CourierFixture fx = new CourierFixture(dir.resolve("courier"))) {
            ToolHost host = new ToolHost(fx.clock(), ToolHost.ownerOnly(), () -> false, () -> true);
            host.area(HostedDecls.COURIER, new CourierTools(fx.reads(), () -> ZoneId.of("UTC"), fx.clock()));
            Set<String> senders = new LinkedHashSet<>();
            for (String line : lines) {
                String[] f = line.split("\t", -1);
                if (f.length > 3 && f[3].contains("@") && !f[3].endsWith("@invalid")) {
                    senders.add(f[3]);
                }
            }
            for (String s : senders) {
                fx.known(s);
            }
            fx.known("bulk@example.com");
            int read = 0;
            int refused = 0;
            List<String> stored = new ArrayList<>();
            for (String line : lines) {
                if (line.isBlank()) {
                    continue;
                }
                String[] f = line.split("\t", -1);
                byte[] raw = Files.readAllBytes(root.resolve(f[0] + ".eml"));
                Courier.Accepted a = fx.store().accept(Courier.Inbound.email(CourierFixture.DESK,
                        ExternalIds.email(CourierFixture.DESK, ThreadingCorpusTest.header(raw, "Message-ID"), raw), raw,
                        Courier.Origin.LIVE));
                assertThat(a.kind()).as(f[0]).isEqualTo(Courier.Accepted.Kind.STORED);
                stored.add(a.messageId());
                Map<String, Object> reply = call(host, "courier_read", Map.of("messageId", a.messageId()), false);
                if ("tres".equals(reply.get("t"))) {
                    wholeAndClean(reply, f[0]);
                    Map<String, Object> m = (Map<String, Object>) ((Map<String, Object>) reply.get("r")).get("content");
                    if (f[1].equals("ok") && !f[2].isEmpty()) {
                        assertThat((String) m.get("subject")).as(f[0] + " subject").isNotBlank();
                    }
                    read++;
                } else {
                    // Not one an agent may see (a Request, a message with no sender): the same not_found as no message.
                    assertThat(reply.get("t")).isEqualTo("terr");
                    assertThat(((Map<String, Object>) reply.get("details")).get("reason")).as(f[0]).isEqualTo("message");
                    refused++;
                }
            }

            // Very large: a text past the parser's 2 MiB, read a fitted page at a time to its end.
            StringBuilder huge = new StringBuilder();
            while (huge.length() < 3 * 1024 * 1024) {
                huge.append("Line ").append(huge.length()).append(" of a very long message, with \"quotes\" and a\ttab.\n");
            }
            String big = fx.email("Big <bulk@example.com>").id("huge@x").subject("Huge").text(huge.toString()).deliver();
            Integer from = 0;
            int pages = 0;
            long chars = 0;
            while (from != null && pages < 2_000) {
                Map<String, Object> page = call(host, "courier_read", Map.of("messageId", big, "from", from), false);
                wholeAndClean(page, "huge page " + pages);
                Map<String, Object> c = (Map<String, Object>) ((Map<String, Object>) page.get("r")).get("content");
                chars += ((String) c.get("text")).length();
                from = (Integer) c.get("textNext");
                pages++;
            }
            assertThat(from).isNull();
            assertThat(chars).isGreaterThan(2L * 1024 * 1024 - 100_000);
            // An attachment of megabytes: named, typed and sized, never opened.
            String payload = "PK-ARCHIVE-" + "A".repeat(6 * 1024 * 1024);
            String att = fx.email("Big <bulk@example.com>").id("att@x").subject("Archive").text("See attached")
                    .attach("photos.zip", "application/zip", payload).deliver();
            Map<String, Object> withAtt = call(host, "courier_read", Map.of("messageId", att), false);
            wholeAndClean(withAtt, "attachment");
            String attJson = json(withAtt);
            assertThat(attJson).contains("photos.zip").doesNotContain("PK-ARCHIVE").doesNotContain("QUFBQUFB");
            // Past the store's 48 MiB: refused at the sink, cleanly, and the tools answer for it as for any other.
            byte[] tooBig = ("From: Big <bulk@example.com>\r\nTo: me@desk.example\r\nSubject: Too big\r\nMessage-ID: <toobig@x>\r\n\r\n"
                    + "x".repeat(49 * 1024 * 1024)).getBytes(StandardCharsets.US_ASCII);
            Courier.Accepted tb = fx.store().accept(Courier.Inbound.email(CourierFixture.DESK, "e:toobig", tooBig, Courier.Origin.LIVE));
            tooBig = null;
            if (tb.messageId() != null) {
                Map<String, Object> r = call(host, "courier_read", Map.of("messageId", tb.messageId()), false);
                if ("tres".equals(r.get("t"))) {
                    wholeAndClean(r, "too big");
                    assertThat(json(r)).doesNotContain("xxxxxxxxxx");
                } else {
                    assertThat(((Map<String, Object>) r.get("details")).get("reason")).isEqualTo("message");
                }
            }

            // courier_new over all of it: whole results, each message once.
            List<String> given = new ArrayList<>();
            Map<String, Object> got;
            int calls = 0;
            do {
                Map<String, Object> reply = call(host, "courier_new", Map.of(), true);
                wholeAndClean(reply, "courier_new " + calls);
                got = (Map<String, Object>) ((Map<String, Object>) reply.get("r")).get("content");
                for (Map<String, Object> m : (List<Map<String, Object>>) got.get("messages")) {
                    given.add((String) m.get("messageId"));
                }
                calls++;
            } while (Boolean.TRUE.equals(got.get("more")) && calls < 500);
            assertThat(given).doesNotHaveDuplicates().contains(big, att);
            assertThat(read).isGreaterThanOrEqualTo(20);
            assertThat(read + refused).isEqualTo(stored.size());
            System.out.println("COURIER-MIME read=" + read + " notVisible=" + refused + " samples=" + stored.size()
                    + " hugePages=" + pages + " newCalls=" + calls + " given=" + given.size());
            host.close();
        }
    }
}
