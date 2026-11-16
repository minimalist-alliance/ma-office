package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** {@code courier.links.*} and {@code courier.attachment.stop} through real frames: the shapes the office reads, and refusals. */
@SuppressWarnings("unchecked")
class LinksMethodsTest {

    @TempDir
    Path dir;
    CourierRig rig;
    TestClient owner;

    @BeforeEach
    void setUp() throws Exception {
        rig = new CourierRig(dir);
        owner = rig.owner("s1");
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private String deliver(Mail m) throws Exception {
        return rig.store().accept(m.inbound("desk").withVerdicts(new Courier.Verdicts(false, false, "pass", "pass", "pass", m.fromAddress()
                .substring(m.fromAddress().indexOf('@') + 1), null))).messageId();
    }

    @Test
    void theOfficesLinkUndoUnlinkAndNotThem() throws Exception {
        String dana = deliver(Mail.from("Dana Smith <dana@example.com>").id("d1@example.com").text("Hi.\n\nDana\ndana.smith@home.example"));
        Map<String, Object> m = rig.ok(owner, "courier.message", "messageId", dana);
        String danaId = (String) ((Map<?, ?>) m.get("from")).get("contactId");
        rig.ok(owner, "courier.request.decide", "channelId", m.get("channelId"), "decision", "let_in");
        String home = deliver(Mail.from("Dana <dana.smith@home.example>").id("h1@home.example").subject("From home"));
        String homeChannel = (String) rig.ok(owner, "courier.message", "messageId", home).get("channelId");

        Map<String, Object> s = rig.ok(owner, "courier.links.suggest");
        List<Map<String, Object>> list = (List<Map<String, Object>>) s.get("suggestions");
        assertThat(list).singleElement().satisfies(x -> {
            assertThat(x.get("endpoint")).isEqualTo(Map.of("kind", "email", "value", "dana.smith@home.example"));
            assertThat(x).containsEntry("source", "signature").containsEntry("strength", "hint").containsEntry("channelId", homeChannel);
        });
        Map<String, Object> ep = Map.of("kind", "email", "value", "Dana.Smith@HOME.example");
        assertThat(rig.ok(owner, "courier.links.lookup", "endpoint", ep)).containsEntry("messages", 1);

        Map<String, Object> linked = rig.ok(owner, "courier.links.link", "into", danaId, "endpoint", ep);
        assertThat(linked.get("channelId")).isEqualTo(m.get("channelId"));
        Map<String, Object> person = rig.ok(owner, "courier.contact.get", "contactId", danaId);
        assertThat((List<Map<String, Object>>) person.get("endpoints")).extracting(e -> e.get("value") + " " + e.get("source"))
                .containsExactly("dana@example.com message", "dana.smith@home.example message");
        assertThat((List<?>) rig.ok(owner, "courier.links.suggest").get("suggestions")).isEmpty();

        rig.ok(owner, "courier.links.undo", "linkId", linked.get("linkId"));
        assertThat(rig.ok(owner, "courier.message", "messageId", home).get("channelId")).isEqualTo(homeChannel);
        assertThat(rig.err(owner, "not_found", "courier.links.undo", "linkId", linked.get("linkId")).get("details")).isEqualTo(Map.of("reason", "link"));

        rig.ok(owner, "courier.links.dismiss", "endpoint", ep, "into", danaId);
        assertThat((List<?>) rig.ok(owner, "courier.links.suggest").get("suggestions")).isEmpty();

        rig.ok(owner, "courier.links.link", "into", danaId, "endpoint", ep);
        Map<String, Object> unlinked = rig.ok(owner, "courier.links.unlink", "endpoint", ep);
        assertThat(unlinked.get("contactId")).isNotEqualTo(danaId);
        assertThat(rig.ok(owner, "courier.message", "messageId", home).get("channelId")).isEqualTo(unlinked.get("channelId"));
        assertThat(rig.err(owner, "conflict", "courier.links.unlink", "endpoint", Map.of("kind", "email", "value", "dana@example.com"))
                .get("details")).isEqualTo(Map.of("reason", "only"));
    }

    @Test
    void badParamsAndStop() throws Exception {
        assertThat(rig.err(owner, "bad_request", "courier.links.lookup", "endpoint", Map.of("kind", "fax", "value", "1")).get("details"))
                .isEqualTo(Map.of("reason", "endpoint"));
        assertThat(rig.err(owner, "bad_request", "courier.links.lookup", "endpoint", Map.of("kind", "email", "value", "not an address"))
                .get("details")).isEqualTo(Map.of("reason", "endpoint"));
        assertThat(rig.err(owner, "bad_request", "courier.links.link", "into", "x").get("details")).isEqualTo(Map.of("reason", "into"));
        assertThat(rig.err(owner, "not_found", "courier.links.link", "into", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "endpoint",
                Map.of("kind", "phone", "value", "+15550102030")).get("details")).isEqualTo(Map.of("reason", "contact"));
        assertThat(rig.ok(owner, "courier.links.lookup", "endpoint", Map.of("kind", "phone", "value", "(555) 010-2030")))
                .containsEntry("contactId", null).containsEntry("messages", 0);
        // A transfer that isn't this session's, or has ended, is fine to stop: nothing else is touched.
        rig.ok(owner, "courier.attachment.stop", "transferId", 7);
        assertThat(rig.err(owner, "bad_request", "courier.attachment.stop", "transferId", -1).get("details")).isEqualTo(Map.of("reason", "transferId"));
    }

    @Test
    void aGuildOrTeenDeskHasNoLinks() throws Exception {
        rig.guild.set(true);
        assertThat(rig.err(owner, "forbidden", "courier.links.suggest").get("details")).isEqualTo(Map.of("reason", "scope"));
        rig.guild.set(false);
    }
}
