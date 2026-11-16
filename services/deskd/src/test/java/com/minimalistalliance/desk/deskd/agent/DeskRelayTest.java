package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.desks.DeskGrants;
import com.minimalistalliance.desk.deskd.desks.DeskMessaging;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The client's {@code agent.desks.*} through deskd's relay (API.md §18, "Messages between the member's desks"), on a real
 * session and a fake desk-agent on a real socket: deskd opens and checks every envelope itself and hands desk-agent only
 * what it found ({@code desk.desks.deliver}, no caller), the client's params never reach desk-agent, only a session that
 * may act delivers or answers, never on a Guild Desk, and the member's choices become deskd's offers, accepts and
 * revokes, handed to desk-agent's outbox ({@code desk.desks.queue}).
 */
class DeskRelayTest {

    private static final String GRANT = "dg-abcdefghijklmnopqrst";

    @TempDir
    Path dir;

    private AgentRig rig;
    private DeskMessaging here;
    private DeskMessaging other;
    private final AtomicBoolean guild = new AtomicBoolean();
    private TestClient owner;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentRig(dir);
        rig.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of(Map.of("id", "manager", "name", "Lead",
                "status", "online"))));
        Files.createDirectories(dir.resolve("desk-data"));
        here = new DeskMessaging(rig.clock, () -> "d-test", () -> "user-1", guild::get);
        here.keepIn(dir.resolve("desk-data"));
        rig.module.desks(here, guild::get);
        other = new DeskMessaging(rig.clock, () -> "d-aaaa", () -> "user-1", () -> false);
        owner = rig.connect("a");
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private Map<String, Object> call(TestClient client, String method, Map<String, Object> params) throws Exception {
        boolean mutation = List.of(DeskMethods.DELIVER, DeskMethods.DONE, DeskMethods.ANSWER).contains(method)
                || AgentMethods.MUTATIONS.contains(method);
        return rig.call(client, method, params, mutation ? UUID.randomUUID().toString() : null);
    }

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    private static Map<String, Object> carried(DeskMessaging.Made made) throws Exception {
        return Json.parseObject(Json.bytes(made.envelope()));
    }

    /** The other desk's offer, delivered here: deskd opens it, records it pending, and hands desk-agent what it said. */
    private void offerArrives() throws Exception {
        rig.agent.handlers.put(DeskMethods.DELIVERED, p -> m("id", ((Map<?, ?>) p.get("opened")).get("id"),
                "outcome", "delivered"));
        Map<String, Object> answer = call(owner, DeskMethods.DELIVER, m("envelope",
                carried(other.offer(GRANT, "ag-x", "Researcher", "d-test"))));
        assertThat(answer).containsEntry("_kind", "RES").containsEntry("outcome", "delivered");
    }

    @Test
    void deskdOpensTheEnvelopeItselfAndDeskAgentGetsOnlyWhatItFound() throws Exception {
        offerArrives();
        Map<String, Object> req = rig.agent.next("req");
        while (!DeskMethods.DELIVERED.equals(req.get("m"))) {
            req = rig.agent.next("req");
        }
        // deskd's own call: no caller, and only deskd's view of the envelope, never the client's params.
        assertThat(req).doesNotContainKey("caller");
        Map<String, Object> p = map(req.get("p"));
        assertThat(p.keySet()).containsExactly("opened");
        assertThat(map(p.get("opened"))).containsEntry("kind", "offer").containsEntry("fromDeskId", "d-aaaa")
                .containsEntry("fromAgentId", "ag-x").doesNotContainKey("keys").doesNotContainKey("envelope");
        assertThat(here.grants().half(GRANT).state()).isEqualTo("pending");
    }

    @Test
    void anEnvelopeDeskdRefusesNeverReachesDeskAgent() throws Exception {
        rig.agent.handlers.put(DeskMethods.DELIVERED, p -> {
            throw new AssertionError("desk-agent heard of a refused envelope");
        });
        Map<String, Object> notOne = call(owner, DeskMethods.DELIVER, m("envelope", m("v", 1, "id", "x")));
        assertThat(notOne).containsEntry("code", "bad_request");
        assertThat(map(notOne.get("details"))).containsEntry("reason", "envelope");
        // A message on a grant this desk never allowed.
        DeskMessaging.Made offer = other.offer(GRANT, "ag-x", "R", "d-test");
        here.open(carried(offer));
        // The other desk behaves as if this one had allowed it: this desk's own record says it hasn't.
        other.grants().accepted(GRANT, "manager", here.keys().pub());
        DeskMessaging.Made msg = other.message("ag-x", "R", "d-test", "hello");
        Map<String, Object> early = call(owner, DeskMethods.DELIVER, m("envelope", carried(msg)));
        assertThat(early).containsEntry("code", "forbidden");
        assertThat(map(early.get("details"))).containsEntry("reason", "no_grant");
        // Extra params: refused as not an envelope, and nothing goes on.
        Map<String, Object> extra = call(owner, DeskMethods.DELIVER, m("envelope", carried(msg), "opened", m("kind",
                "msg")));
        assertThat(extra).containsEntry("code", "bad_request");
    }

    @Test
    void onlyASessionThatMayActDeliversOrAnswersAndNeverOnAGuildDesk() throws Exception {
        String fingerprint = String.format("%02x", 9 + 16).repeat(32);
        TestClient viewer = rig.connect("v", new SessionGrant("user-1", "sid-v", "owner", fingerprint, true, false,
                Instant.now(), Instant.now().plus(Duration.ofHours(1))));
        DeskMessaging.Made offer = other.offer(GRANT, "ag-x", "R", "d-test");
        assertThat(call(viewer, DeskMethods.DELIVER, m("envelope", carried(offer)))).containsEntry("code", "forbidden");
        assertThat(call(viewer, DeskMethods.ANSWER, m("grantId", GRANT, "allow", true, "agentId", "manager")))
                .containsEntry("code", "forbidden");
        // A viewer can still read what waits; the carrier is the owner's.
        rig.agent.handlers.put(DeskMethods.TAKE, p -> m("envelopes", List.of(), "more", false));
        assertThat(call(viewer, DeskMethods.TAKE, m("toDeskId", "d-aaaa"))).containsEntry("_kind", "RES");

        guild.set(true);
        for (String method : List.of(DeskMethods.TAKE, DeskMethods.LIST, DeskMethods.DELIVER, DeskMethods.DONE)) {
            Map<String, Object> refused = call(owner, method, m("toDeskId", "d-aaaa"));
            assertThat(refused).as(method).containsEntry("code", "forbidden");
            assertThat(map(refused.get("details"))).as(method).containsEntry("reason", "guild");
        }
    }

    @Test
    void theMembersAllowMakesTheAcceptAndDeskAgentsOutboxGetsIt() throws Exception {
        offerArrives();
        rig.agent.handlers.put(DeskMethods.ANSWER, p -> m("half", m("grantId", GRANT, "state", "active")));
        rig.agent.handlers.put(DeskMethods.QUEUE, p -> {
            List<String> ids = new java.util.ArrayList<>();
            for (Object e : (List<?>) p.get("envelopes")) {
                ids.add((String) ((Map<?, ?>) e).get("id"));
            }
            return m("ids", ids);
        });
        // A grant this desk holds no offer for is not_found, before desk-agent hears.
        assertThat(call(owner, DeskMethods.ANSWER, m("grantId", "dg-zzzzzzzzzzzzzzzzzzzz", "allow", true, "agentId",
                "manager"))).containsEntry("code", "not_found");
        assertThat(call(owner, DeskMethods.ANSWER, m("grantId", GRANT, "allow", true, "agentId", "manager")))
                .containsEntry("_kind", "RES");
        assertThat(here.grants().half(GRANT).active()).isTrue();
        await().atMost(Duration.ofSeconds(5)).until(() -> here.grants().owed().isEmpty());
        Map<String, Object> queued = null;
        for (Map<String, Object> req : rig.agent.received) {
            if (DeskMethods.QUEUE.equals(req.get("m"))) {
                queued = req;
            }
        }
        assertThat(queued).isNotNull().doesNotContainKey("caller");
        Map<?, ?> envelope = (Map<?, ?>) ((List<?>) ((Map<?, ?>) queued.get("p")).get("envelopes")).get(0);
        assertThat(envelope.get("kind")).isEqualTo("accept");
        // The other desk takes it, with this desk's keys pinned: its send half is active.
        other.open(Json.parseObject(Json.bytes(envelope.get("envelope"))));
        assertThat(other.grants().half(GRANT).active()).isTrue();
    }

    @Test
    void aDeskSwitchedOnBecomesAnOfferAndSwitchedOffARevoke() throws Exception {
        rig.agent.handlers.put("agent.access.set", p -> m("access", m("chosen", true, "apps", m(), "auto", m(),
                "desks", List.of(m("grantId", GRANT, "agentId", "manager", "toDeskId", "d-aaaa", "state", "offered")))));
        rig.agent.handlers.put(DeskMethods.QUEUE, p -> m("ids", ((List<?>) p.get("envelopes")).stream()
                .map(e -> ((Map<?, ?>) e).get("id")).toList()));
        assertThat(call(owner, "agent.access.set", m("agentId", "manager", "desks", List.of(m("deskId", "d-aaaa",
                "deskName", "Home", "on", true))))).containsEntry("_kind", "RES");
        DeskGrants.Half half = here.grants().half(GRANT);
        assertThat(half.state()).isEqualTo("offered");
        assertThat(half.agentId()).isEqualTo("manager");
        await().atMost(Duration.ofSeconds(5)).until(() -> here.grants().owed().isEmpty());

        // Switched off: desk-agent's answer no longer lists it, and deskd revokes its half.
        rig.agent.handlers.put("agent.access.set", p -> m("access", m("chosen", true, "apps", m(), "auto", m(),
                "desks", List.of())));
        call(owner, "agent.access.set", m("agentId", "manager", "desks", List.of(m("deskId", "d-aaaa", "on", false))));
        assertThat(here.grants().half(GRANT).revoked()).isTrue();
    }

    @Test
    void deskAgentsWordAloneMakesNoOfferOnlyTheMembersSwitchDoes() throws Exception {
        // desk-agent's answer lists a half for a desk the member didn't switch on in this call, and one with an id that
        // isn't a desk's: deskd records neither and signs no offer (Security's DM-L1).
        rig.agent.handlers.put("agent.access.set", p -> m("access", m("chosen", true, "apps", m(), "auto", m(),
                "desks", List.of(m("grantId", GRANT, "agentId", "manager", "toDeskId", "d-aaaa", "state", "offered"),
                        m("grantId", "dg-bbbbbbbbbbbbbbbbbbbb", "agentId", "manager", "toDeskId", "D A\n", "state",
                                "offered")))));
        rig.agent.handlers.put(DeskMethods.QUEUE, p -> m("ids", ((List<?>) p.get("envelopes")).stream()
                .map(e -> ((Map<?, ?>) e).get("id")).toList()));
        assertThat(call(owner, "agent.access.set", m("agentId", "manager", "apps", m("notebook", true))))
                .containsEntry("_kind", "RES");
        assertThat(here.grants().half(GRANT)).isNull();
        assertThat(here.grants().owed()).isEmpty();
        // The member switches on an id that isn't a desk's: still nothing recorded, so the record stays readable.
        call(owner, "agent.access.set", m("agentId", "manager", "desks", List.of(m("deskId", "D A\n", "on", true))));
        assertThat(here.grants().half("dg-bbbbbbbbbbbbbbbbbbbb")).isNull();
        // The member's own switch: the offer.
        call(owner, "agent.access.set", m("agentId", "manager", "desks", List.of(m("deskId", "d-aaaa", "on", true))));
        assertThat(here.grants().half(GRANT).state()).isEqualTo("offered");
    }

    @Test
    void whatTheMemberTakesAwayDeskdTakesAwayBeforeDeskAgentHears() throws Exception {
        here.grants().sendOffered(GRANT, "manager", "d-aaaa");
        rig.agent.handlers.put(DeskMethods.QUEUE, p -> m("ids", ((List<?>) p.get("envelopes")).stream()
                .map(e -> ((Map<?, ?>) e).get("id")).toList()));
        // desk-agent refuses the change: deskd's half is gone all the same (Security's DM-I4).
        AtomicBoolean before = new AtomicBoolean();
        rig.agent.handlers.put("agent.access.set", p -> {
            before.set(here.grants().half(GRANT).revoked());
            return null;
        });
        call(owner, "agent.access.set", m("agentId", "manager", "desks", List.of(m("deskId", "d-aaaa", "on", false))));
        assertThat(before).as("revoked before desk-agent heard").isTrue();
        assertThat(here.grants().half(GRANT).revoked()).isTrue();

        String second = "dg-cccccccccccccccccccc";
        here.grants().sendOffered(second, "manager", "d-bbbb");
        before.set(false);
        rig.agent.handlers.put("agent.desks.revoke", p -> {
            before.set(here.grants().half(second).revoked());
            return m("revoked", true);
        });
        call(owner, "agent.desks.revoke", m("grantId", second));
        assertThat(before).as("revoked before desk-agent heard").isTrue();
        assertThat(here.grants().half(second).revoked()).isTrue();
    }

    @Test
    void deskAgentsRefusalAsRevokedTakesDeskdsHalfToo() throws Exception {
        // Paired both ways, then desk-agent's own rows say this desk's answer half is revoked.
        DeskMessaging.Made offer = other.offer(GRANT, "ag-x", "R", "d-test");
        here.open(carried(offer));
        DeskMessaging.Made accept = here.accept(GRANT, "manager", "Lead");
        other.open(carried(accept));
        DeskMessaging.Made msg = other.message("ag-x", "R", "d-test", "hello");
        java.util.concurrent.CompletableFuture<Map<String, Object>> delivering =
                java.util.concurrent.CompletableFuture.supplyAsync(() -> {
                    try {
                        return call(owner, DeskMethods.DELIVER, m("envelope", carried(msg)));
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                });
        Map<String, Object> req = rig.agent.requests.poll(10, java.util.concurrent.TimeUnit.SECONDS);
        while (req != null && !DeskMethods.DELIVERED.equals(req.get("m"))) {
            req = rig.agent.requests.poll(10, java.util.concurrent.TimeUnit.SECONDS);
        }
        assertThat(req).isNotNull();
        rig.agent.error(((Number) req.get("id")).longValue(), "forbidden", m("reason", "revoked"));
        Map<String, Object> answer = delivering.get(10, java.util.concurrent.TimeUnit.SECONDS);
        assertThat(answer).containsEntry("code", "forbidden");
        assertThat(here.grants().half(GRANT).revoked()).isTrue();
    }

    @Test
    void theOtherDesksRefusalAsRevokedTakesThisDesksHalfToo() throws Exception {
        here.grants().sendOffered(GRANT, "manager", "d-aaaa");
        rig.agent.handlers.put(DeskMethods.DONE, p -> m("done", 1, "revoked", List.of(GRANT)));
        rig.agent.handlers.put(DeskMethods.QUEUE, p -> m("ids", List.of()));
        assertThat(call(owner, DeskMethods.DONE, m("results", List.of(m("id", "env-aaaaaaaaaaaaaaaaaaaaaaaaaa",
                "outcome", "refused", "reason", "revoked"))))).containsEntry("_kind", "RES");
        assertThat(here.grants().half(GRANT).revoked()).isTrue();
    }
}
