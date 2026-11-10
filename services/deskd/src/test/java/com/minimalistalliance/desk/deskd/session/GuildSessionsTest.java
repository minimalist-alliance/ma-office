package com.minimalistalliance.desk.deskd.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.StubAuthorizer;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** A guild desk's sessions (API.md section 14): 3 a member, 200 members, the roster's close, and the caller from the token alone. */
class GuildSessionsTest {

    @TempDir
    Path dir;

    private FakeDeskRtc fake;
    private RtcClient rtc;
    private final StubAuthorizer authorizer = new StubAuthorizer();
    private final RpcDispatcher dispatcher = new RpcDispatcher();
    private final EventHub hub = new EventHub(new TopicRegistry());
    private final List<String> callerChanges = new CopyOnWriteArrayList<>();
    private SessionManager sessions;
    private long nextHandle = 1;

    private static final DeskFacts FACTS = new DeskFacts() {
        @Override
        public String deskId() {
            return "d-guild";
        }

        @Override
        public String bootId() {
            return "boot-1";
        }

        @Override
        public String instanceType() {
            return "c7g.xlarge";
        }

        @Override
        public String publicIpv4() {
            return "203.0.113.7";
        }

        @Override
        public boolean guildDesk() {
            return true;
        }
    };

    @BeforeEach
    void setUp() throws Exception {
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        rtc = new RtcClient(new RtcClient.Config(socket, () -> SessionManager.maxSessions(true), FACTS::publicIpv4,
                () -> true, SessionManager.MAX_MEMBER_SESSIONS));
        sessions = new SessionManager(rtc, authorizer, dispatcher, hub, FACTS, "1.2.3", Instant.now());
        sessions.addSessionListener(new SessionListener() {
            @Override
            public void onCallerChanged(String sessionId) {
                callerChanges.add(sessionId);
            }
        });
        // What a handler sees of who's calling.
        dispatcher.register("test.whoami", Set.of(RpcPrincipal.GUILD_MEMBER, RpcPrincipal.OWNER),
                (context, params) -> context.principal().caller().toJson());
        rtc.start(sessions);
        await().until(rtc::isConfigured);
    }

    @AfterEach
    void tearDown() throws Exception {
        rtc.close();
        fake.close();
    }

    static SessionGrant member(String memberId, String fingerprint, String role, List<String> grants, Duration validFor) {
        Caller caller = new Caller(Caller.GUILD_MEMBER, memberId, role, Caller.effectiveGrants(role, grants), "Name " + memberId,
                null, false);
        return new SessionGrant(memberId, "sid-" + memberId, RpcPrincipal.GUILD_MEMBER, fingerprint, false, false,
                Instant.now(), Instant.now().plus(validFor), caller, "gu-testguild01");
    }

    private static String tab(int n) {
        return String.format("%064x", n + 1);
    }

    private void open(String sessionId, SessionGrant grant) throws SessionAuthorizer.RefusedException {
        authorizer.allow("t-" + sessionId, grant);
        sessions.open(sessionId, "t-" + sessionId);
    }

    private TestClient connect(String sessionId, SessionGrant grant) throws Exception {
        open(sessionId, grant);
        sessions.offer(sessionId, TestClient.offerFor(grant.expectedFingerprint()));
        TestClient client = new TestClient(fake, nextHandle++);
        return client;
    }

    @Test
    void desksRtcIsToldItsAGuildDeskAndEachSessionsMember() throws Exception {
        assertThat(SessionManager.maxSessions(true)).isEqualTo(600);
        assertThat(SessionManager.maxSessions(false)).isEqualTo(4);
        // desk-rtc's guild mode (sub/guild-rtc): configure says so, session.create names the member, member.close follows.
        assertThat(fake.awaitJson("configure")).containsEntry("deskKind", "guild").containsEntry("maxSessions", 600)
                .containsEntry("maxSessionsPerMember", 3);
        connect("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(1)));
        assertThat(fake.awaitJson("session.create")).containsEntry("memberId", "gm-aaaa0001")
                .containsEntry("permissions", Map.of("video", false, "input", false));
        sessions.closeMember("gm-aaaa0001");
        assertThat(fake.awaitJson("member.close")).containsEntry("memberId", "gm-aaaa0001").containsEntry("reason", "member_changed");
    }

    @Test
    void threeSessionsAMemberAndAFourthFromAnotherTabIsRefused() throws Exception {
        for (int i = 0; i < 3; i++) {
            open("cs-a" + i, member("gm-aaaa0001", tab(i), "member", List.of(), Duration.ofHours(1)));
        }
        assertThatThrownBy(() -> open("cs-a3", member("gm-aaaa0001", tab(3), "member", List.of(), Duration.ofHours(1))))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("session_limit_reached"));
        // The same tab replaces its own, as the owner's does, and another member has their own 3.
        open("cs-a0b", member("gm-aaaa0001", tab(0), "member", List.of(), Duration.ofHours(1)));
        assertThat(sessions.isLive("cs-a0")).isFalse();
        assertThat(sessions.isLive("cs-a0b")).isTrue();
        for (int i = 0; i < 3; i++) {
            open("cs-b" + i, member("gm-bbbb0001", tab(10 + i), "member", List.of(), Duration.ofHours(1)));
        }
        assertThat(sessions.sessionIds()).hasSize(6);
    }

    @Test
    void twoHundredMembersAndThe201stIsRefusedOutsideTheOwnersFour() throws Exception {
        for (int i = 0; i < 200; i++) {
            open("cs-m" + i, member(String.format("gm-m%07d", i), tab(i), "member", List.of(), Duration.ofHours(1)));
        }
        assertThatThrownBy(() -> open("cs-m200", member("gm-m9999999", tab(500), "member", List.of(), Duration.ofHours(1))))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("session_limit_reached"));
        // A member already in still gets a second session.
        open("cs-m0b", member("gm-m0000000", tab(501), "member", List.of(), Duration.ofHours(1)));
        assertThat(sessions.sessionIds()).hasSize(201);
    }

    @Test
    void aRosterChangeClosesThatMembersSessionsAndNobodyElses() throws Exception {
        TestClient a1 = connect("cs-a1", member("gm-aaaa0001", tab(1), "officer", List.of("moderate"), Duration.ofHours(1)));
        connect("cs-a2", member("gm-aaaa0001", tab(2), "officer", List.of("moderate"), Duration.ofHours(1)));
        connect("cs-b1", member("gm-bbbb0001", tab(3), "member", List.of(), Duration.ofHours(1)));
        a1.hello();
        assertThat(sessions.memberCallers()).hasSize(3);
        assertThat(sessions.closeMember("gm-aaaa0001")).isEqualTo(2);
        Map<String, Object> close = a1.nextJson(Channels.CTL, FrameKind.CLOSE);
        assertThat(close).containsEntry("code", 4401).containsEntry("reason", "member_changed");
        assertThat(sessions.isLive("cs-a1")).isFalse();
        assertThat(sessions.isLive("cs-a2")).isFalse();
        assertThat(sessions.isLive("cs-b1")).isTrue();
    }

    @Test
    void theCallerComesFromTheTokenAndNothingAClientSendsChangesIt() throws Exception {
        TestClient client = connect("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(1)));
        Map<String, Object> hello = client.hello();
        assertThat(Json.object(hello, "limits")).containsEntry("maxSessions", 3);
        Map<String, Object> forged = Map.of("kind", "owner", "memberId", "gm-bbbb0001", "role", "lead",
                "grants", Caller.GRANTS, "teen", false);
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("m", "test.whoami");
        body.put("p", Map.of("caller", forged));
        body.put("caller", forged);
        client.sendJson(Channels.RPC, FrameKind.REQ, 7, body);
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("kind", "guild_member").containsEntry("memberId", "gm-aaaa0001")
                .containsEntry("role", "member").containsEntry("grants", List.of());
        // A client's AUTH with no valid token changes nothing either.
        client.sendJson(Channels.CTL, FrameKind.AUTH, 8, Map.of("deskToken", "forged"));
        assertThat(client.nextJson(Channels.CTL, FrameKind.AUTH)).containsEntry("ok", false);
        assertThat(client.call("test.whoami", Map.of())).containsEntry("role", "member");
        assertThat(callerChanges).isEmpty();
    }

    @Test
    void aRefreshThatChangesTheRoleReachesHandlersAndTheRelays() throws Exception {
        TestClient client = connect("cs-1", member("gm-aaaa0001", tab(1), "officer", List.of("manage_agents"), Duration.ofHours(1)));
        client.hello();
        assertThat(client.call("test.whoami", Map.of())).containsEntry("grants", List.of("manage_agents"));
        authorizer.allow("t-refresh", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(2)));
        sessions.refresh("cs-1", "t-refresh");
        assertThat(client.call("test.whoami", Map.of())).containsEntry("role", "member").containsEntry("grants", List.of());
        assertThat(callerChanges).containsExactly("cs-1");
    }

    @Test
    void aMembersSessionClosesAtItsExpiryUnlessRefreshed() throws Exception {
        TestClient client = connect("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofMillis(400)));
        client.hello();
        Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
        assertThat(close).containsEntry("code", 4401).containsEntry("reason", "token_expired");
        await().until(() -> !sessions.isLive("cs-1"));
    }

    @Test
    void guildActivityIsAMembersRequestNotAPing() throws Exception {
        TestClient client = connect("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(1)));
        client.hello();
        client.sendJson(Channels.CTL, FrameKind.PING, 3, Map.of());
        client.nextJson(Channels.CTL, FrameKind.PONG);
        assertThat(sessions.lastGuildActivityAt()).isNull();
        client.call("test.whoami", Map.of());
        assertThat(sessions.lastGuildActivityAt()).isNotNull();
        assertThat(sessions.connectedMembers()).isEqualTo(1);
    }

    @Test
    void theHeartbeatsGuildBlockHasEachMembersSessionAndAClosedOneOnce() throws Exception {
        com.minimalistalliance.desk.deskd.guild.GuildSessionLog log =
                new com.minimalistalliance.desk.deskd.guild.GuildSessionLog(sessions, () -> true);
        TestClient client = connect("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(1)));
        client.hello();
        com.minimalistalliance.desk.deskd.rtc.RtcStats stats = new com.minimalistalliance.desk.deskd.rtc.RtcStats(
                List.of(new com.minimalistalliance.desk.deskd.rtc.RtcStats.SessionStats("cs-1", "udp", 10.0, 4096, 100, false, 0)),
                4096, 100, 0, null);
        Map<String, Object> block = log.block(stats);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) block.get("sessions");
        assertThat(rows).singleElement().satisfies(row -> assertThat(row)
                .containsEntry("sessionId", "cs-1").containsEntry("memberId", "gm-aaaa0001").containsEntry("bytesSent", 4096L)
                .containsEntry("commonsBytesSent", 0L).containsEntry("commonsSeconds", 0L).containsEntry("closed", false));
        assertThat(block).containsOnlyKeys("sessions");
        sessions.closeMember("gm-aaaa0001");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> after = (List<Map<String, Object>>) log.block(null).get("sessions");
        assertThat(after).singleElement().satisfies(row -> assertThat(row).containsEntry("closed", true).containsEntry("bytesSent", 4096L));
        assertThat((List<?>) log.block(null).get("sessions")).isEmpty();
        // Any other desk sends no block.
        assertThat(new com.minimalistalliance.desk.deskd.guild.GuildSessionLog(sessions, () -> false).block(null)).isNull();
    }

    private static com.minimalistalliance.desk.deskd.rtc.RtcStats rows(
            com.minimalistalliance.desk.deskd.rtc.RtcStats.SessionStats... rows) {
        return new com.minimalistalliance.desk.deskd.rtc.RtcStats(List.of(rows), 0, 0, 0, null);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> sessionRows(Map<String, Object> block) {
        return (List<Map<String, Object>>) block.get("sessions");
    }

    @Test
    void aClosedSessionsLastRowUsesTheFinalCountsFromSessionClosedNotTheLastStats() throws Exception {
        com.minimalistalliance.desk.deskd.guild.GuildSessionLog log =
                new com.minimalistalliance.desk.deskd.guild.GuildSessionLog(sessions, () -> true);
        log.finalCountsFrom(() -> true);
        connect("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(1)));
        log.block(rows(new com.minimalistalliance.desk.deskd.rtc.RtcStats.SessionStats("cs-1", "udp", 1.0, 4096, 1, false, 0)));
        // Sent since that stats: only session.closed has it. It may come before the session ends, or after (deskd's own close).
        sessions.onSessionFinalBytes("cs-1", "gm-aaaa0001", 9000, 50);
        sessions.closeMember("gm-aaaa0001");
        assertThat(sessionRows(log.block(null))).singleElement()
                .satisfies(row -> assertThat(row).containsEntry("closed", true).containsEntry("bytesSent", 9000L));
        assertThat(sessionRows(log.block(null))).isEmpty();
    }

    @Test
    void aSessionDeskdClosedWaitsForTheFinalCountsThatComeAfterItsEnd() throws Exception {
        com.minimalistalliance.desk.deskd.guild.GuildSessionLog log =
                new com.minimalistalliance.desk.deskd.guild.GuildSessionLog(sessions, () -> true);
        log.finalCountsFrom(() -> true);
        connect("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(1)));
        log.block(rows(new com.minimalistalliance.desk.deskd.rtc.RtcStats.SessionStats("cs-1", "udp", 1.0, 4096, 1, false, 0)));
        sessions.closeMember("gm-aaaa0001");
        // Not yet: reported now it would carry 4096, and the rest would never be billed.
        assertThat(sessionRows(log.block(null))).isEmpty();
        sessions.onSessionFinalBytes("cs-1", "gm-aaaa0001", 9000, 50);
        assertThat(sessionRows(log.block(null))).singleElement()
                .satisfies(row -> assertThat(row).containsEntry("closed", true).containsEntry("bytesSent", 9000L));
    }

    @Test
    void aClosedRowInStatsIsTheFinalCountsWhenSessionClosedWasLostAndIsAckedUntilDeskRtcForgetsIt() throws Exception {
        com.minimalistalliance.desk.deskd.guild.GuildSessionLog log =
                new com.minimalistalliance.desk.deskd.guild.GuildSessionLog(sessions, () -> true);
        log.finalCountsFrom(() -> true);
        connect("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(1)));
        sessions.closeMember("gm-aaaa0001");
        assertThat(sessionRows(log.block(null))).isEmpty();
        com.minimalistalliance.desk.deskd.rtc.RtcStats stats = rows(
                new com.minimalistalliance.desk.deskd.rtc.RtcStats.SessionStats("cs-1", "udp", null, 7000, 3, false, 0, "gm-aaaa0001", true),
                // A session this log reported long ago, or never knew: still acked, since desk-rtc keeps it until then.
                new com.minimalistalliance.desk.deskd.rtc.RtcStats.SessionStats("cs-old", null, null, 5, 5, false, 0, "gm-bbbb0001", true),
                new com.minimalistalliance.desk.deskd.rtc.RtcStats.SessionStats("cs-live", "udp", null, 5, 5, false, 0, "gm-bbbb0001", false));
        assertThat(sessionRows(log.block(stats))).singleElement()
                .satisfies(row -> assertThat(row).containsEntry("sessionId", "cs-1").containsEntry("bytesSent", 7000L)
                        .containsEntry("closed", true));
        assertThat(log.toAck()).containsExactlyInAnyOrder("cs-1", "cs-old");
        log.acked(List.of("cs-1"));
        assertThat(log.toAck()).containsExactly("cs-old");
    }

    @Test
    void withDeskRtc03AClosedSessionGoesAtOnceWithTheLastStatsAsBefore() throws Exception {
        com.minimalistalliance.desk.deskd.guild.GuildSessionLog log =
                new com.minimalistalliance.desk.deskd.guild.GuildSessionLog(sessions, () -> true);
        // finalCountsFrom is never set: nothing says desk-rtc sends final counts.
        connect("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(1)));
        log.block(rows(new com.minimalistalliance.desk.deskd.rtc.RtcStats.SessionStats("cs-1", "udp", 1.0, 4096, 1, false, 0)));
        sessions.closeMember("gm-aaaa0001");
        assertThat(sessionRows(log.block(null))).singleElement()
                .satisfies(row -> assertThat(row).containsEntry("closed", true).containsEntry("bytesSent", 4096L));
        assertThat(log.toAck()).isEmpty();
    }

    @Test
    void protocolErrorAndOverBudgetEndTheSessionAndTheGatewayHearsClosedByDesk() throws Exception {
        List<String> events = new CopyOnWriteArrayList<>();
        sessions.setObserver(new SessionObserver() {
            @Override
            public void onSessionClosed(String sessionId, String reason) {
                events.add(sessionId + " " + reason);
            }
        });
        connect("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(1)));
        connect("cs-2", member("gm-aaaa0002", tab(2), "member", List.of(), Duration.ofHours(1)));
        connect("cs-3", member("gm-aaaa0003", tab(3), "member", List.of(), Duration.ofHours(1)));
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "protocol_error", "memberId", "gm-aaaa0001",
                "bytesSent", 1, "bytesReceived", 2));
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-2", "reason", "over_budget", "memberId", "gm-aaaa0002",
                "bytesSent", 1, "bytesReceived", 2));
        // One of desk-rtc's other reasons passes as it did.
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-3", "reason", "credit_violation"));
        await().until(() -> events.size() == 3);
        assertThat(events).containsExactlyInAnyOrder("cs-1 closed_by_desk", "cs-2 closed_by_desk", "cs-3 closed_by_desk");
        assertThat(sessions.isLive("cs-1")).isFalse();
        assertThat(sessions.isLive("cs-2")).isFalse();
    }

    @Test
    void anOfferFromAnotherCertificateThanTheTokensCnfIsRefused() throws Exception {
        open("cs-1", member("gm-aaaa0001", tab(1), "member", List.of(), Duration.ofHours(1)));
        assertThatThrownBy(() -> sessions.offer("cs-1", TestClient.offerFor(tab(2))))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("identity_mismatch"));
        assertThat(sessions.isLive("cs-1")).isFalse();
    }
}
