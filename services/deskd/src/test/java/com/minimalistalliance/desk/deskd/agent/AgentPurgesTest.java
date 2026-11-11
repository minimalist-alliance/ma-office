package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.guild.GuildRoster;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.FakeAgentSocket;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A guild desk tells desk-agent whose agent conversations to delete (ADR 0080's addendum of 2026-11-10), on real Unix
 * sockets: {@code desk.member.purge} with no caller, from a list that waits for desk-agent, and that no client can send.
 */
class AgentPurgesTest {

    private static final String GUILD = "gu-testguild01";
    private static final String LEAD = "gm-lead0001";
    private static final String A = "gm-aaaa0001";
    private static final String B = "gm-bbbb0001";
    /** No grace, so a purge is due as soon as it's owed. */
    private static final GuildRoster.Timing NOW =
            new GuildRoster.Timing(Duration.ofMillis(20), Duration.ofMillis(100), Duration.ZERO);

    @TempDir
    Path dir;

    private AgentRig rig;
    private GuildRoster roster;
    private final AtomicReference<Map<String, Object>> served = new AtomicReference<>();

    @AfterEach
    void tearDown() throws Exception {
        if (roster != null) {
            roster.stop();
        }
        if (rig != null) {
            rig.close();
        }
    }

    private GuildRoster roster(String guild) {
        roster = new GuildRoster(dir, () -> {
            Map<String, Object> body = served.get();
            if (body == null) {
                throw new IOException("503");
            }
            return body;
        }, () -> guild, new GuildRoster.Sessions() {
            @Override
            public Collection<Caller> callers() {
                return List.of();
            }

            @Override
            public void closeMember(String memberId) {}
        }, NOW, rig.clock);
        rig.module.memberPurges(roster.purges());
        return roster;
    }

    private static Map<String, Object> body(long version, String... ids) {
        List<Map<String, Object>> members = new ArrayList<>();
        for (int i = 0; i < ids.length; i++) {
            Map<String, Object> member = new LinkedHashMap<>();
            member.put("memberId", ids[i]);
            member.put("role", i == 0 ? "lead" : "member");
            member.put("grants", List.of());
            member.put("name", "Name");
            member.put("badge", null);
            member.put("teen", false);
            members.add(member);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("guildId", GUILD);
        body.put("version", version);
        body.put("closed", false);
        body.put("members", members);
        return body;
    }

    private void serve(Map<String, Object> body) {
        served.set(body);
        long version = ((Number) body.get("version")).longValue();
        roster.versionIs(version);
        await().until(() -> roster.version() >= version);
    }

    private Map<String, Object> nextPurge(FakeAgentSocket agent) throws InterruptedException {
        while (true) {
            Map<String, Object> req = agent.requests.poll(10, TimeUnit.SECONDS);
            assertThat(req).as("a purge").isNotNull();
            if (AgentPurges.METHOD.equals(req.get("m"))) {
                return req;
            }
        }
    }

    /** No purge comes in this long, whatever else does. */
    private static void noPurge(FakeAgentSocket agent) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(300);
        while (System.nanoTime() < until) {
            Map<String, Object> req = agent.requests.poll(50, TimeUnit.MILLISECONDS);
            assertThat(req == null ? null : req.get("m")).isNotEqualTo(AgentPurges.METHOD);
        }
        assertThat(agent.received).noneMatch(m -> AgentPurges.METHOD.equals(m.get("m")));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> counts() {
        return (Map<String, Object>) rig.module.health().get("guildPurges");
    }

    @Test
    void aPurgeOwedWhileDeskAgentIsDownGoesWhenItsBackAndLeavesTheList() throws Exception {
        rig = new AgentRig(dir, false);
        roster(GUILD);
        serve(body(1, LEAD, A, B));
        serve(body(2, LEAD, A));
        assertThat(counts()).containsEntry("owed", 1).containsEntry("done", 0L);
        assertThat(Files.readString(dir.resolve("guild-purges.json"))).contains(B);

        try (FakeAgentSocket agent = new FakeAgentSocket(rig.agentSocket)) {
            Map<String, Object> req = nextPurge(agent);
            // deskd's own: the member to purge in p, and no caller, as no client's relayed request ever lacks one.
            assertThat(req).doesNotContainKey("caller");
            assertThat(req.get("p")).isEqualTo(Map.of("memberId", B));
            agent.reply(((Number) req.get("id")).longValue(), Map.of("purged", true, "messages", 3, "files", 0, "usage", 1));
            await().until(() -> Long.valueOf(1).equals(counts().get("done")));
            assertThat(counts()).containsEntry("owed", 0);
            assertThat(Files.readString(dir.resolve("guild-purges.json"))).doesNotContain(B);
            assertThat(agent.requests.poll(200, TimeUnit.MILLISECONDS)).as("sent once").isNull();
            assertThat(agent.received).filteredOn(m -> AgentPurges.METHOD.equals(m.get("m"))).hasSize(1);
        }
    }

    @Test
    void aLinkLostBeforeTheAnswerSendsItAgainAndAnOlderDeskAgentIsAskedAgainOnlyOnTheNextConnection() throws Exception {
        rig = new AgentRig(dir);
        roster(GUILD);
        serve(body(1, LEAD, A, B));
        serve(body(2, LEAD, A));
        Map<String, Object> first = nextPurge(rig.agent);
        // The answer never comes: the link goes. On the next connection it's sent again (it's idempotent there).
        rig.agent.drop();
        Map<String, Object> again = nextPurge(rig.agent);
        assertThat(again.get("p")).isEqualTo(first.get("p"));
        // A desk-agent from before this answers not_found: nothing more on this connection.
        rig.agent.error(((Number) again.get("id")).longValue(), "not_found", Map.of());
        assertThat(rig.agent.requests.poll(300, TimeUnit.MILLISECONDS)).isNull();
        assertThat(counts()).containsEntry("owed", 1);
        rig.agent.drop();
        Map<String, Object> third = nextPurge(rig.agent);
        rig.agent.reply(((Number) third.get("id")).longValue(), Map.of("purged", true));
        await().until(() -> Integer.valueOf(0).equals(counts().get("owed")));
    }

    @Test
    void noClientSessionCanSendIt() throws Exception {
        rig = new AgentRig(dir);
        TestClient owner = rig.connect("cs-1");
        Map<String, Object> asOwner = rig.call(owner, AgentPurges.METHOD, Map.of("memberId", A), "idem-1");
        assertThat(asOwner).containsEntry("_kind", "ERR");
        TestClient member = rig.connect("cs-2", rig.member(LEAD, "lead", List.of(), false));
        Map<String, Object> asMember = rig.call(member, AgentPurges.METHOD, Map.of("memberId", A), "idem-2");
        assertThat(asMember).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
        assertThat(AgentMethods.READS).doesNotContain(AgentPurges.METHOD);
        assertThat(AgentMethods.MUTATIONS).doesNotContain(AgentPurges.METHOD);
        noPurge(rig.agent);
    }

    @Test
    void anOwnersDeskSendsNoPurgeAndShowsNone() throws Exception {
        rig = new AgentRig(dir);
        assertThat(rig.module.health()).containsOnlyKeys("agent");
        // Wired as on any desk, with no guild: nothing is read, owed or sent.
        roster(null);
        roster.loadKept();
        assertThat(rig.module.health()).containsOnlyKeys("agent");
        noPurge(rig.agent);
        assertThat(Files.exists(dir.resolve("guild-purges.json"))).isFalse();
    }

    @Test
    void aMemberBackOnTheRosterBeforeDeskAgentIsIsNotSent() throws Exception {
        rig = new AgentRig(dir, false);
        roster(GUILD);
        serve(body(1, LEAD, A, B));
        serve(body(2, LEAD, A));
        serve(body(3, LEAD, A, B));
        assertThat(roster.purges().due()).isEmpty();
        try (FakeAgentSocket agent = new FakeAgentSocket(rig.agentSocket)) {
            await().until(() -> rig.module.link().isConnected());
            noPurge(agent);
        }
        assertThat(counts()).containsEntry("owed", 0).containsEntry("done", 0L);
    }
}
