package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.courier.store.Lanes;
import com.minimalistalliance.desk.deskd.courier.store.SearchQuery;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The MIME samples ({@code src/test/resources/courier/mime/}): each shape real mail comes in, the malformed and hostile
 * ones too, goes through the sink as a transport hands it (raw, then the stand-in for {@code desk-parse}), and is stored
 * readable or as cleanly refused, with its raw bytes exactly, its words searchable, and its sender from the address. Then
 * the seam's own check: whatever the sandbox's answer holds, {@link ParsedMessage#fromWire} caps and cleans it.
 */
class MimeCorpusTest {

    @Test
    void everySampleIsReadOrCleanlyRefused(@TempDir Path dir) throws Exception {
        Path root = Path.of(getClass().getResource("/courier/mime").toURI());
        List<String> lines = Files.readAllLines(root.resolve("expect.tsv"));
        assertThat(lines).hasSizeGreaterThanOrEqualTo(27);
        try (StoreRig rig = new StoreRig(dir)) {
            for (String line : lines) {
                if (line.isBlank()) {
                    continue;
                }
                String[] f = line.split("\t", -1);
                String name = f[0];
                byte[] raw = Files.readAllBytes(root.resolve(name + ".eml"));
                Courier.Accepted a = rig.store.accept(Courier.Inbound.email(StoreRig.DESK,
                        ExternalIds.email(StoreRig.DESK, ThreadingCorpusTest.header(raw, "Message-ID"), raw), raw, Courier.Origin.LIVE));
                assertThat(a.kind()).as(name).isEqualTo(Courier.Accepted.Kind.STORED);
                Map<String, Object> m = rig.store.queries().message(a.messageId(), 0);
                assertThat(rig.store.raw(a.messageId())).as(name + " raw").isEqualTo(raw);
                if (f[1].startsWith("refused:")) {
                    assertThat(m.get("parse")).as(name).isEqualTo(Map.of("state", "refused", "reason", f[1].substring(8)));
                    continue;
                }
                assertThat(m.get("parse")).as(name + " parse").isNull();
                assertThat(m.get("subject")).as(name + " subject").isEqualTo(f[2].isEmpty() ? null : f[2]);
                Map<?, ?> from = (Map<?, ?>) m.get("from");
                assertThat(((Map<?, ?>) from.get("endpoint")).get("value")).as(name + " from").isEqualTo(f[3]);
                assertThat(m.get("attachmentCount")).as(name + " attachments").isEqualTo(Integer.parseInt(f[4]));
                if (!f[5].equals("-")) {
                    @SuppressWarnings("unchecked")
                    List<Map<String, Object>> hits = (List<Map<String, Object>>) rig.store.queries()
                            .search(SearchQuery.parse(f[5]), Lanes.DEFAULT_VISIBLE, null, null, 100, ZoneOffset.UTC).get("hits");
                    assertThat(hits).as(name + " finds " + f[5]).extracting(h -> h.get("messageId")).contains(a.messageId());
                }
                String subject = (String) m.get("subject");
                if (subject != null) {
                    assertThat(subject.chars().noneMatch(ch -> ch < 0x20 || (ch >= 0x202A && ch <= 0x202E))).as(name + " clean").isTrue();
                }
            }
            Invariants.check(rig.store);
        }
    }

    @Test
    void samplesWithParticularsKeepThem(@TempDir Path dir) throws Exception {
        Path root = Path.of(getClass().getResource("/courier/mime").toURI());
        try (StoreRig rig = new StoreRig(dir)) {
            Map<String, Map<String, Object>> byName = new HashMap<>();
            for (String name : List.of("rfc2231-name", "dangerous-attachments", "latin1-qp", "folded-headers", "inline-image", "display-name-address")) {
                byte[] raw = Files.readAllBytes(root.resolve(name + ".eml"));
                String id = rig.store.accept(Courier.Inbound.email(StoreRig.DESK, "e:" + name, raw, null)).messageId();
                byName.put(name, rig.store.queries().message(id, 0));
            }
            assertThat(((Map<?, ?>) ((List<?>) byName.get("rfc2231-name").get("attachments")).get(0)).get("name")).isEqualTo("Reçu €12.pdf");
            List<?> dangerous = (List<?>) byName.get("dangerous-attachments").get("attachments");
            assertThat(dangerous).hasSize(2);
            for (Object o : dangerous) {
                assertThat(((Map<?, ?>) o).get("danger")).isEqualTo("program");
            }
            assertThat(((Map<?, ?>) byName.get("latin1-qp").get("from")).get("name")).isEqualTo("François");
            assertThat((String) byName.get("latin1-qp").get("text")).contains("La réunion est déplacée à midi.");
            assertThat(((Map<?, ?>) byName.get("folded-headers").get("from")).get("name")).isEqualTo("Smith, Dana");
            List<?> inline = (List<?>) byName.get("inline-image").get("attachments");
            assertThat(inline).singleElement().satisfies(o -> {
                assertThat(((Map<?, ?>) o).get("inline")).isEqualTo(true);
                assertThat(((Map<?, ?>) o).get("contentId")).isEqualTo("img1@x");
            });
            assertThat(byName.get("inline-image").get("hasHtml")).isEqualTo(true);
            assertThat(((Map<?, ?>) byName.get("display-name-address").get("from")).get("name")).isNull();
        }
    }

    @Test
    void theSandboxsAnswerIsCappedAndCleanedWhateverItHolds() {
        assertThatThrownBy(() -> ParsedMessage.fromWire(Map.of("v", 2))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ParsedMessage.fromWire(null)).isInstanceOf(IllegalArgumentException.class);
        Map<String, Object> w = new HashMap<>();
        w.put("v", 1);
        w.put("from", Map.of("name", "A‮\u0000B", "address", "<A@B.Example>"));
        List<Object> many = new ArrayList<>();
        for (int i = 0; i < 10_000; i++) {
            many.add(Map.of("address", "u" + i + "@x.example"));
        }
        many.add("not an object");
        many.add(Map.of("address", "not an address"));
        w.put("to", many);
        w.put("cc", "not a list");
        w.put("subject", "S\u0007ub\r\nject" + "x".repeat(5000));
        w.put("date", 99_999_999_999_999L);
        w.put("messageId", "no brackets here");
        w.put("inReplyTo", "<ok@x> <bad id@x>");
        w.put("references", 42);
        w.put("text", "t".repeat(3 * 1024 * 1024));
        w.put("html", "h".repeat(5 * 1024 * 1024));
        List<Object> parts = new ArrayList<>();
        for (int i = 0; i < 3000; i++) {
            parts.add(Map.of("part", "p" + i, "name", "n" + i, "bytes", -5));
        }
        w.put("attachments", parts);
        w.put("listUnsubscribe", "yes");
        ParsedMessage m = ParsedMessage.fromWire(w);
        assertThat(m.from()).isEqualTo(new ParsedMessage.Address("AB", "a@b.example"));
        assertThat(m.to()).hasSize(ParsedMessage.MAX_ADDRESSES);
        assertThat(m.cc()).isEmpty();
        assertThat(m.subject()).startsWith("Sub ject").hasSizeLessThanOrEqualTo(998);
        assertThat(m.date()).isNull();
        assertThat(m.messageId()).isNull();
        assertThat(m.inReplyTo()).containsExactly("ok@x");
        assertThat(m.references()).isEmpty();
        assertThat(m.text()).hasSize(ParsedMessage.MAX_TEXT);
        assertThat(m.textTruncated()).isTrue();
        assertThat(m.html()).isNull();
        assertThat(m.attachments()).hasSize(ParsedMessage.MAX_PARTS);
        assertThat(m.attachments().get(0).bytes()).isZero();
        assertThat(m.listUnsubscribe()).isFalse();
        assertThat(m.toString()).doesNotContain("tttt");
    }

    @Test
    void aHostileAnswerStillStoresAsAMessage(@TempDir Path dir) throws Exception {
        Map<String, Object> w = new HashMap<>();
        w.put("v", 1);
        w.put("from", Map.of("address", "x@y.example"));
        List<Object> parts = new ArrayList<>();
        for (int i = 0; i < 2500; i++) {
            parts.add(Map.of("part", "same", "name", "dup.bin", "bytes", 1));
        }
        w.put("attachments", parts);
        w.put("text", "body");
        com.minimalistalliance.desk.deskd.courier.parse.CourierParser hostile = raw -> new com.minimalistalliance.desk.deskd.courier.parse.CourierParser.Parsed(
                ParsedMessage.fromWire(w));
        try (StoreRig rig = new StoreRig(dir, hostile)) {
            Courier.Accepted a = rig.store.accept(Courier.Inbound.email(StoreRig.DESK, "e:h", "x".getBytes(), null));
            Map<String, Object> m = rig.store.queries().message(a.messageId(), 0);
            // One part id 2,500 times is one part.
            assertThat(m.get("attachmentCount")).isEqualTo(1);
            assertThat((List<?>) m.get("attachments")).hasSize(1);
            Invariants.check(rig.store);
        }
    }
}
