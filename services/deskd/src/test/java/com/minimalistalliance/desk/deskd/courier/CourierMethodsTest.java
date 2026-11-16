package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.Outbox;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** deskd integration: {@code courier.*} and {@code courier.changed} through real frames, sessions and the RPC layer. */
class CourierMethodsTest {

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
        return rig.store().accept(m.inbound("desk")).messageId();
    }

    @Test
    void statusSaysOnWithCounts() throws Exception {
        deliver(Mail.from("Dana <dana@example.com>").id("1@x"));
        Map<String, Object> s = rig.ok(owner, "courier.status");
        assertThat(s.get("state")).isEqualTo("on");
        assertThat(s.get("reason")).isNull();
        assertThat(((Map<?, ?>) ((Map<?, ?>) s.get("lanes")).get("requests")).get("count")).isEqualTo(1);
        assertThat(((Number) s.get("bytes")).longValue()).isPositive();
    }

    @Test
    void aMemberReadsListsThreadsMessagesAndSearches() throws Exception {
        String id = deliver(Mail.from("Dana <dana@example.com>").id("1@x").subject("Lunch").text("Noodles at noon?"));
        Map<String, Object> list = rig.ok(owner, "courier.list", "lane", "requests");
        List<?> rows = (List<?>) list.get("rows");
        assertThat(rows).hasSize(1);
        String channel = (String) ((Map<?, ?>) rows.get(0)).get("channelId");
        Map<String, Object> thread = rig.ok(owner, "courier.thread", "channelId", channel);
        assertThat((List<?>) thread.get("messages")).hasSize(1);
        Map<String, Object> m = rig.ok(owner, "courier.message", "messageId", id);
        assertThat(m.get("text")).isEqualTo("Noodles at noon?");
        Map<String, Object> hits = rig.ok(owner, "courier.search", "q", "noodle");
        assertThat((List<?>) hits.get("hits")).hasSize(1);
        assertThat(rig.ok(owner, "courier.search", "q", "   ").get("hits")).isEqualTo(List.of());
        assertThat(rig.err(owner, "bad_request", "courier.search", "q", "before:never").get("details")).isEqualTo(Map.of("reason", "date"));
        rig.err(owner, "not_found", "courier.message", "messageId", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assertThat(rig.err(owner, "bad_request", "courier.message", "messageId", "../x").get("details")).isEqualTo(Map.of("reason", "messageId"));
        assertThat(rig.err(owner, "bad_request", "courier.list", "lane", "inbox").get("details")).isEqualTo(Map.of("reason", "lane"));
        assertThat(rig.err(owner, "bad_request", "courier.list", "lane", "people", "before", "junk").get("details"))
                .isEqualTo(Map.of("reason", "before"));
    }

    @Test
    void mutationsNeedIdemAndAReplayIsTheStoredReply() throws Exception {
        String id = deliver(Mail.from("Dana <dana@example.com>").id("1@x"));
        Map<String, Object> noIdem = rig.callWith(owner, "courier.read.set", null, CourierRig.params("messageIds", List.of(id), "read", true));
        assertThat(noIdem).containsEntry("_kind", "ERR").containsEntry("code", "bad_request");
        String key = UUID.randomUUID().toString();
        Map<String, Object> first = rig.callWith(owner, "courier.read.set", key, CourierRig.params("messageIds", List.of(id), "read", true));
        assertThat(first.get("changed")).isEqualTo(1);
        Map<String, Object> again = rig.callWith(owner, "courier.read.set", key, CourierRig.params("messageIds", List.of(id), "read", true));
        assertThat(again.get("changed")).isEqualTo(1);
        assertThat(rig.ok(owner, "courier.read.set", "messageIds", List.of(id), "read", true).get("changed")).isEqualTo(0);
    }

    @Test
    void requestsLetInAndTheTopicTellsEveryOffice() throws Exception {
        TestClient second = rig.owner("s2");
        for (TestClient c : List.of(owner, second)) {
            c.sendJson(Channels.RPC, FrameKind.SUB, 99, Map.of("topic", "courier.changed", "params", Map.of()));
            assertThat(c.nextReply()).containsEntry("_kind", "RES");
            Frame snapshot = c.next(Channels.EVENTS);
            assertThat(new String(snapshot.payload(), StandardCharsets.UTF_8)).contains("snapshot");
        }
        String id = deliver(Mail.from("Dana <dana@example.com>").id("1@x"));
        String channel = rig.store().queries().message(id, 0).get("channelId").toString();
        rig.ok(owner, "courier.request.decide", "channelId", channel, "decision", "let_in");
        for (TestClient c : List.of(owner, second)) {
            await().atMost(Duration.ofSeconds(5)).until(() -> {
                Frame f = c.next(Channels.EVENTS);
                String body = new String(f.payload(), StandardCharsets.UTF_8);
                return f.kind() == FrameKind.EVT && body.contains("\"changed\"") && body.contains(channel) && body.contains("people");
            });
        }
        assertThat(rig.store().queries().message(id, 0).get("lane")).isEqualTo("people");
        // The event names ids and lanes, never a sender, subject or text.
        deliver(Mail.from("Secret Sender <secret@example.com>").id("2@x").subject("Very private subject"));
        await().atMost(Duration.ofSeconds(5)).until(() -> {
            Frame f = owner.next(Channels.EVENTS);
            String body = new String(f.payload(), StandardCharsets.UTF_8);
            assertThat(body).doesNotContain("Secret").doesNotContain("private").doesNotContain("secret@");
            return body.contains("requests");
        });
    }

    @Test
    void draftsSendAndUndoThroughTheMethods() throws Exception {
        rig.store().outbox().register("email", null, item -> new Outbox.Sent(Map.of()));
        Map<String, Object> d = rig.ok(owner, "courier.draft.save", "medium", "email", "accountId", "desk", "to", List.of("dana@example.com"),
                "subject", "Hi", "text", "Hello Dana");
        String draftId = (String) d.get("draftId");
        assertThat(d.get("version")).isEqualTo(1);
        Map<String, Object> d2 = rig.ok(owner, "courier.draft.save", "draftId", draftId, "medium", "email", "accountId", "desk",
                "to", List.of("dana@example.com"), "subject", "Hi", "text", "Hello Dana!", "baseVersion", 1);
        assertThat(d2.get("version")).isEqualTo(2);
        assertThat(rig.err(owner, "conflict", "courier.draft.save", "draftId", draftId, "text", "stale", "baseVersion", 1).get("details"))
                .isEqualTo(Map.of("reason", "version"));
        Map<String, Object> sent = rig.ok(owner, "courier.send", "draftId", draftId);
        assertThat(sent).containsKeys("messageId", "outboundId", "undoUntil");
        Map<String, Object> undone = rig.ok(owner, "courier.send.undo", "outboundId", sent.get("outboundId"));
        assertThat(undone.get("draftId")).isEqualTo(draftId);
        assertThat(((List<?>) rig.ok(owner, "courier.drafts.list").get("drafts"))).hasSize(1);
        rig.err(owner, "not_found", "courier.send", "draftId", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    }

    @Test
    void aSendWithNoTransportSaysSoAndChangesNothing() throws Exception {
        Map<String, Object> d = rig.ok(owner, "courier.draft.save", "medium", "email", "accountId", "desk", "to", List.of("dana@example.com"),
                "text", "x");
        assertThat(rig.err(owner, "unavailable", "courier.send", "draftId", d.get("draftId")).get("details"))
                .isEqualTo(Map.of("reason", "medium"));
        assertThat(((List<?>) rig.ok(owner, "courier.drafts.list").get("drafts"))).hasSize(1);
    }

    @Test
    void onlyTheOwnerOfAnAdultsPersonalDeskGetsCourier() throws Exception {
        TestClient export = rig.connect("e1", RpcPrincipal.EXPORT);
        assertThat(rig.err(export, "forbidden", "courier.list", "lane", "people").get("details")).isEqualTo(Map.of("reason", "scope"));
        export.sendJson(Channels.RPC, FrameKind.SUB, 5, Map.of("topic", "courier.changed", "params", Map.of()));
        assertThat(export.nextReply()).containsEntry("code", "forbidden");

        rig.band.set(AgeBand.Band.TEEN);
        assertThat(rig.err(owner, "forbidden", "courier.list", "lane", "people").get("details")).isEqualTo(Map.of("reason", "teen"));
        assertThat(rig.ok(owner, "courier.status").get("state")).isEqualTo("unavailable");
        rig.band.set(null);
        assertThat(rig.err(owner, "unavailable", "courier.list", "lane", "people").get("details")).isEqualTo(Map.of("reason", "age_band"));
        rig.band.set(AgeBand.Band.ADULT);
        rig.guild.set(true);
        assertThat(rig.err(owner, "forbidden", "courier.list", "lane", "people").get("details")).isEqualTo(Map.of("reason", "scope"));
        assertThat(rig.err(owner, "forbidden", "courier.status").get("details")).isEqualTo(Map.of("reason", "scope"));
        rig.guild.set(false);
        assertThat(rig.ok(owner, "courier.list", "lane", "people").get("rows")).isEqualTo(List.of());
        assertThat(rig.module.read().available()).isTrue();
    }

    @Test
    void theKillSwitchTurnsItOffAndBack() throws Exception {
        rig.switchTo("off");
        assertThat(rig.err(owner, "unavailable", "courier.list", "lane", "people").get("details")).isEqualTo(Map.of("reason", "switched_off"));
        assertThat(rig.ok(owner, "courier.status").get("state")).isEqualTo("off");
        assertThat(rig.module.read().available()).isFalse();
        owner.sendJson(Channels.RPC, FrameKind.SUB, 7, Map.of("topic", "courier.changed", "params", Map.of()));
        assertThat(owner.nextReply()).containsEntry("code", "unavailable");
        rig.switchTo("send-off");
        assertThat(rig.ok(owner, "courier.list", "lane", "people")).containsKey("rows");
        Map<String, Object> d = rig.ok(owner, "courier.draft.save", "medium", "email", "accountId", "desk", "to", List.of("a@b.example"), "text", "x");
        assertThat(rig.err(owner, "unavailable", "courier.send", "draftId", d.get("draftId")).get("details"))
                .isEqualTo(Map.of("reason", "switched_off"));
        rig.switchTo(null);
        assertThat(rig.ok(owner, "courier.status").get("state")).isEqualTo("on");
    }

    @Test
    void contactsBlocksAndAccountsAreListed() throws Exception {
        String id = deliver(Mail.from("Dana <dana@example.com>").id("1@x"));
        String contact = (String) ((Map<?, ?>) rig.store().queries().message(id, 0).get("from")).get("contactId");
        rig.ok(owner, "courier.contact.rename", "contactId", contact, "name", "Dana S.");
        assertThat(rig.ok(owner, "courier.contact.get", "contactId", contact).get("name")).isEqualTo("Dana S.");
        assertThat(((List<?>) rig.ok(owner, "courier.contacts.list", "q", "dana").get("contacts"))).hasSize(1);
        rig.ok(owner, "courier.block", "kind", "domain", "value", "spam.example");
        assertThat(((List<?>) rig.ok(owner, "courier.blocks.list").get("blocks"))).hasSize(1);
        rig.ok(owner, "courier.unblock", "kind", "domain", "value", "spam.example");
        rig.err(owner, "not_found", "courier.unblock", "kind", "domain", "value", "spam.example");
        Map<String, Object> accounts = rig.ok(owner, "courier.accounts.list");
        assertThat(((List<?>) accounts.get("accounts"))).singleElement().satisfies(a -> {
            assertThat(((Map<?, ?>) a).get("kind")).isEqualTo("desk");
            assertThat(((Map<?, ?>) a).get("sending")).isEqualTo(false);
        });
        rig.ok(owner, "courier.delete", "messageIds", List.of(id));
        assertThat(rig.ok(owner, "courier.trash.empty").get("deleted")).isEqualTo(1);
    }

    @Test
    void aDeskWithNoStoreSaysSo(@TempDir Path other) throws Exception {
        Path notADir = other.resolve("file");
        Files.writeString(notADir, "x");
        try (CourierRig broken = new CourierRig(other.resolve("rig"), notADir)) {
            TestClient c = broken.owner("b1");
            assertThat(broken.err(c, "unavailable", "courier.list", "lane", "people").get("details")).isEqualTo(Map.of("reason", "store"));
            assertThat(broken.ok(c, "courier.status").get("reason")).isEqualTo("store");
            assertThat(broken.module.read().available()).isFalse();
            assertThat(broken.module.available()).isFalse();
        }
    }

    @Test
    void aBigThreadPageStaysUnderOneReply() throws Exception {
        String channel = null;
        for (int i = 0; i < 100; i++) {
            String id = deliver(Mail.from("Dana <dana@example.com>").id("big" + i + "@x").text("é".repeat(50_000)));
            channel = (String) rig.store().queries().message(id, 0).get("channelId");
        }
        Map<String, Object> page = rig.ok(owner, "courier.thread", "channelId", channel, "limit", 100);
        assertThat((List<?>) page.get("messages")).hasSize(100);
        Map<?, ?> first = (Map<?, ?>) ((List<?>) page.get("messages")).get(0);
        assertThat(first.get("textMore")).isEqualTo(true);
        Map<String, Object> whole = rig.ok(owner, "courier.message", "messageId", first.get("messageId"));
        assertThat(((String) whole.get("text"))).hasSize(50_000);
        assertThat(Courier.class).isNotNull();
    }
}
