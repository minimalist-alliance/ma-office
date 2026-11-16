package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Maia Mode's relay (API.md §23) on a real session and a fake desk-agent on a real socket: every {@code agent.maia.*}
 * method and {@code agent.usage.summary} reaches desk-agent with the caller; those that change what she may do need a
 * session that may act; a guild member gets none of it; the room's topic {@code agent.maia} is the owner's alone; and
 * deskd's own record of her grants is the member's call cut to desk-agent's answer.
 */
class MaiaRelayTest {

    @TempDir
    Path dir;

    private AgentRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentRig(dir);
        rig.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of()));
        rig.module.keepAccessIn(dir);
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private Map<String, Object> nextRequest(String method) throws InterruptedException {
        while (true) {
            Map<String, Object> got = rig.agent.next("req");
            if (method.equals(got.get("m"))) {
                return got;
            }
        }
    }

    private SessionGrant viewer() {
        String fingerprint = String.format("%02x", 1 + 16).repeat(32);
        return new SessionGrant("user-1", "sid-v", "owner", fingerprint, true, false, Instant.now(),
                Instant.now().plus(Duration.ofHours(1)));
    }

    private MaiaRecord record() {
        return rig.module.maiaRecord();
    }

    private static final List<String> READS = List.of("agent.maia.get", "agent.maia.grants.list",
            "agent.maia.choices.get", "agent.maia.notes.list", "agent.maia.observe", "agent.maia.typing",
            "agent.maia.seen", "agent.usage.summary", "agent.maia.reach.get", "agent.maia.reach.held",
            "agent.maia.tray.get");
    private static final List<String> INPUT = List.of("agent.maia.set", "agent.maia.forget", "agent.maia.choose",
            "agent.maia.choices.reset", "agent.maia.grant.set", "agent.maia.grant.revoke", "agent.maia.note.file",
            "agent.maia.todos.set", "agent.maia.reach.set", "agent.maia.reach.answer", "agent.maia.reach.hold",
            "agent.maia.reach.working.clear", "agent.maia.reach.learned.undo", "agent.maia.reach.learned.reset",
            "agent.maia.tray.answer", "agent.maia.tray.later");
    private static final List<String> OTHER = List.of("agent.maia.item.snooze", "agent.maia.item.dismiss",
            "agent.maia.reach.back");

    @Test
    void everyMethodIsListedAndReachesDeskAgentWithTheOwnerAsCaller() throws Exception {
        assertThat(AgentMethods.READS).containsAll(READS);
        assertThat(AgentMethods.MUTATIONS).containsAll(INPUT).containsAll(OTHER);
        assertThat(AgentMethods.MAIA_INPUT).containsExactlyInAnyOrderElementsOf(INPUT);
        for (String method : READS) {
            rig.agent.handlers.put(method, p -> m("ok", true));
        }
        for (String method : INPUT) {
            rig.agent.handlers.put(method, p -> m("ok", true));
        }
        for (String method : OTHER) {
            rig.agent.handlers.put(method, p -> m("ok", true));
        }
        TestClient owner = rig.connect("cs-1");
        for (String method : READS) {
            assertThat(rig.call(owner, method, m("desks", List.of()))).as(method).containsEntry("_kind", "RES");
        }
        for (String method : INPUT) {
            assertThat(rig.call(owner, method, m("x", 1))).as(method).containsEntry("_kind", "RES");
        }
        for (String method : OTHER) {
            assertThat(rig.call(owner, method, m("itemId", "mi-a"))).as(method).containsEntry("_kind", "RES");
        }
        Map<String, Object> observed = rig.agent.received.stream()
                .filter(f -> "agent.maia.observe".equals(f.get("m"))).findFirst().orElseThrow();
        assertThat(Json.object(observed, "caller")).containsEntry("kind", "owner");
        // A read without idem; a mutation without it is refused before desk-agent hears.
        assertThat(rig.call(owner, "agent.maia.set", m("on", true), null)).containsEntry("code", "bad_request");
    }

    @Test
    void aSessionThatMayNotActChangesNothingOfHersAndDeskAgentNeverHears() throws Exception {
        TestClient client = rig.connect("cs-v", viewer());
        for (String method : INPUT) {
            Map<String, Object> refused = rig.call(client, method, m("on", true));
            assertThat(refused).as(method).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat(Json.object(refused, "details")).as(method).containsEntry("reason", "permission");
        }
        assertThat(rig.agent.received).noneMatch(f -> "req".equals(f.get("t"))
                && INPUT.contains(String.valueOf(f.get("m"))));
        // Reading, and putting an item off, need no input: a viewer may.
        rig.agent.handlers.put("agent.maia.get", p -> m("maia", m("on", false)));
        rig.agent.handlers.put("agent.maia.item.snooze", p -> m("item", m("id", "mi-a")));
        assertThat(rig.call(client, "agent.maia.get", m())).containsEntry("_kind", "RES");
        assertThat(rig.call(client, "agent.maia.item.snooze", m("itemId", "mi-a"))).containsEntry("_kind", "RES");
        assertThat(record().on()).isFalse();
    }

    @Test
    void aGuildMemberGetsNoneOfMaiaModeOrTheTeamView() throws Exception {
        TestClient member = rig.connect("gm-1", rig.member("gm-aaaa0001", "member", List.of(), false));
        List<String> all = new java.util.ArrayList<>(READS);
        all.addAll(INPUT);
        all.addAll(OTHER);
        for (String method : all) {
            Map<String, Object> refused = rig.call(member, method, m());
            assertThat(refused).as(method).containsEntry("code", "forbidden");
            assertThat(Json.object(refused, "details")).as(method).containsEntry("reason", "permission");
        }
        assertThat(rig.agent.received).noneMatch(f -> "req".equals(f.get("t"))
                && all.contains(String.valueOf(f.get("m"))));
        assertThat(member.subscribe("agent.maia", null)).containsEntry("code", "forbidden");
    }

    @Test
    void theRoomsTopicIsRelayedToTheOwnerAndNoOneElse() throws Exception {
        rig.agent.snapshots.put("agent.maia", () -> m("on", true, "status", m("line", "Watching 2 desks")));
        TestClient owner = rig.connect("cs-1");
        assertThat(owner.subscribe("agent.maia", null)).containsEntry("_kind", "RES");
        Map<String, Object> first = owner.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(first).containsEntry("type", "snapshot");
        assertThat(Json.object(Json.object(first, "data"), "status")).containsEntry("line", "Watching 2 desks");
        await().until(() -> rig.agent.subscribers("agent.maia") == 1);
        rig.agent.publish("agent.maia", "snapshot", m("on", true, "status", m("line", "Watching 3 desks")));
        Map<String, Object> next = owner.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(Json.object(Json.object(next, "data"), "status")).containsEntry("line", "Watching 3 desks");
        TestClient export = rig.connect("e", "export");
        Map<String, Object> scoped = export.subscribe("agent.maia", null);
        assertThat(scoped).containsEntry("code", "forbidden");
        assertThat(Json.object(scoped, "details")).containsEntry("reason", "scope");
        assertThat(owner.subscribe("agent.maia:x", null)).containsEntry("code", "not_found");
    }

    @Test
    void deskdRecordsHerGrantsAsTheMemberAskedAndDeskAgentHolds() throws Exception {
        long expires = Instant.parse("2026-11-06T10:00:00Z").plus(Duration.ofDays(7)).toEpochMilli();
        rig.agent.handlers.put("agent.maia.set", p -> m("maia", m("on", p.get("on"))));
        rig.agent.handlers.put("agent.maia.grant.set", p -> m("grant", m("deskId", p.get("deskId"), "scopes",
                p.get("scopes"), "keepsToItself", false, "expiresAt", expires)));
        rig.agent.handlers.put("agent.maia.grant.revoke", p -> m("grants", List.of()));
        TestClient owner = rig.connect("cs-1");
        rig.call(owner, "agent.maia.set", m("on", true, "disclosure", "maia-mode-v2"));
        assertThat(record().on()).isTrue();
        rig.call(owner, "agent.maia.grant.set", m("deskId", "d-work", "deskName", "Work", "scopes",
                List.of("brief", "show")));
        assertThat(record().mayBrief("d-work")).isTrue();
        assertThat(record().grant("d-work").expiresAt()).isEqualTo(expires);
        assertThat(dir.resolve(MaiaRecord.FILE)).exists();
        rig.call(owner, "agent.maia.grant.revoke", m("deskId", "d-work"));
        assertThat(record().mayBrief("d-work")).isFalse();
    }

    @Test
    void aRefusalRecordsNothingButWhatTheMemberTookAwayStaysTaken() throws Exception {
        long expires = Instant.parse("2026-11-06T10:00:00Z").plus(Duration.ofDays(7)).toEpochMilli();
        rig.agent.handlers.put("agent.maia.set", p -> m("maia", m("on", true)));
        rig.agent.handlers.put("agent.maia.grant.set", p -> m("grant", m("deskId", p.get("deskId"), "scopes",
                p.get("scopes"), "keepsToItself", false, "expiresAt", expires)));
        TestClient owner = rig.connect("cs-1");
        rig.call(owner, "agent.maia.set", m("on", true, "disclosure", "maia-mode-v2"));
        rig.call(owner, "agent.maia.grant.set", m("deskId", "d-work", "deskName", "Work", "scopes", List.of("brief")));
        assertThat(record().mayBrief("d-work")).isTrue();
        // desk-agent refuses a new grant: nothing recorded.
        rig.agent.handlers.remove("agent.maia.grant.set");
        long id = rig.send(owner, "agent.maia.grant.set", m("deskId", "d-home", "deskName", "Home", "scopes",
                List.of("brief")), java.util.UUID.randomUUID().toString());
        // Unhandled requests wait in the fake's queue: this is the one just sent.
        Map<String, Object> asked = rig.agent.requests.poll(10, java.util.concurrent.TimeUnit.SECONDS);
        assertThat(asked).containsEntry("m", "agent.maia.grant.set");
        rig.agent.error(((Number) asked.get("id")).longValue(), "forbidden", Map.of("reason", "maia_off"));
        Map<String, Object> reply = owner.nextReply();
        assertThat(reply).containsEntry("_id", id).containsEntry("code", "forbidden");
        assertThat(record().grant("d-home")).isNull();
        // Turning it off: desk-agent refuses (it's down to a bug), and deskd's record is off anyway.
        rig.agent.handlers.remove("agent.maia.set");
        rig.send(owner, "agent.maia.set", m("on", false), java.util.UUID.randomUUID().toString());
        Map<String, Object> off = rig.agent.requests.poll(10, java.util.concurrent.TimeUnit.SECONDS);
        assertThat(off).containsEntry("m", "agent.maia.set");
        rig.agent.error(((Number) off.get("id")).longValue(), "internal", Map.of());
        owner.nextReply();
        assertThat(record().on()).isFalse();
        assertThat(record().mayBrief("d-work")).isFalse();
    }

    /** Not on Free (the concept's §8.4; Security's DMA-L3): deskd refuses turning it on, by its own tier limits. */
    @Test
    void aFreeDeskNeverTurnsItOn() throws Exception {
        rig.agent.handlers.put("agent.maia.set", p -> m("maia", m("on", p.get("on"))));
        rig.module.freeDesk(() -> true);
        TestClient owner = rig.connect("cs-1");
        Map<String, Object> refused = rig.call(owner, "agent.maia.set", m("on", true, "disclosure", "maia-mode-v2"),
                java.util.UUID.randomUUID().toString());
        assertThat(refused).containsEntry("code", "forbidden");
        assertThat(record().on()).isFalse();
        // Turning it off and the rest still reach desk-agent.
        rig.call(owner, "agent.maia.set", m("on", false));
        rig.module.freeDesk(() -> false);
        rig.call(owner, "agent.maia.set", m("on", true, "disclosure", "maia-mode-v2"));
        assertThat(record().on()).isTrue();
    }
}
