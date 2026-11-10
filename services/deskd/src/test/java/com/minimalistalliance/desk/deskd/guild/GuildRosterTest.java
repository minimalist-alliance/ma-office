package com.minimalistalliance.desk.deskd.guild;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.session.SessionAuthorizer;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The roster wins over the token (auth.md 4.5 on sub/guild-desk): reading it, holding sessions to it, keeping it. */
class GuildRosterTest {

    private static final String GUILD = "gu-testguild01";
    private static final GuildRoster.Timing FAST = new GuildRoster.Timing(Duration.ofMillis(20), Duration.ofMillis(100));

    @TempDir
    Path dir;

    private final AtomicReference<Map<String, Object>> served = new AtomicReference<>();
    private final AtomicInteger reads = new AtomicInteger();
    private final List<Caller> live = new CopyOnWriteArrayList<>();
    private final List<String> closed = new CopyOnWriteArrayList<>();
    private GuildRoster roster;

    @AfterEach
    void tearDown() {
        if (roster != null) {
            roster.stop();
        }
    }

    private GuildRoster roster() {
        roster = new GuildRoster(dir, () -> {
            reads.incrementAndGet();
            Map<String, Object> body = served.get();
            if (body == null) {
                throw new IOException("503");
            }
            return body;
        }, () -> GUILD, new GuildRoster.Sessions() {
            @Override
            public Collection<Caller> callers() {
                return List.copyOf(live);
            }

            @Override
            public void closeMember(String memberId) {
                closed.add(memberId);
                live.removeIf(caller -> caller.memberId().equals(memberId));
            }
        }, FAST);
        return roster;
    }

    private static Map<String, Object> entry(String memberId, String role, List<String> grants, boolean teen) {
        Map<String, Object> member = new LinkedHashMap<>();
        member.put("memberId", memberId);
        member.put("role", role);
        member.put("grants", grants);
        member.put("name", "Name");
        member.put("badge", null);
        member.put("teen", teen);
        return member;
    }

    private static Map<String, Object> body(long version, List<Map<String, Object>> members) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("guildId", GUILD);
        body.put("version", version);
        body.put("closed", false);
        body.put("members", members);
        body.put("settings", Map.of("maxCommonsChannels", 10));
        return body;
    }

    private static Caller caller(String memberId, String role, List<String> grants, boolean teen) {
        return new Caller(Caller.GUILD_MEMBER, memberId, role, Caller.effectiveGrants(role, grants), "Name", null, teen);
    }

    private void refused(Caller caller) {
        assertThatThrownBy(() -> roster.check(caller))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("invalid_token"));
    }

    @Test
    void beforeAnyRosterTheTokenStandsAlone() throws Exception {
        roster();
        roster.check(caller("gm-aaaa0001", "member", List.of(), false));
        assertThat(roster.known()).isFalse();
    }

    @Test
    void aMemberMustBeOnItWithTheSameRightsAsTheToken() throws Exception {
        roster();
        served.set(body(3, List.of(entry("gm-aaaa0001", "officer", List.of("moderate"), false))));
        roster.versionIs(3);
        await().until(() -> roster.version() == 3);
        roster.check(caller("gm-aaaa0001", "officer", List.of("moderate"), false));
        refused(caller("gm-bbbb0001", "member", List.of(), false));
        refused(caller("gm-aaaa0001", "lead", List.of(), false));
        refused(caller("gm-aaaa0001", "officer", List.of("moderate", "invite"), false));
        refused(caller("gm-aaaa0001", "officer", List.of("moderate"), true));
    }

    @Test
    void aRosterThatDropsOrChangesAMemberClosesTheirSessionsAndNobodyElses() {
        roster();
        live.add(caller("gm-aaaa0001", "officer", List.of("moderate"), false));
        live.add(caller("gm-aaaa0001", "officer", List.of("moderate"), false));
        live.add(caller("gm-bbbb0001", "member", List.of(), false));
        live.add(caller("gm-cccc0001", "member", List.of(), false));
        served.set(body(5, List.of(
                entry("gm-aaaa0001", "member", List.of(), false),
                entry("gm-cccc0001", "member", List.of(), false))));
        roster.versionIs(5);
        await().until(() -> closed.size() == 2);
        assertThat(closed).containsExactlyInAnyOrder("gm-aaaa0001", "gm-bbbb0001");
        assertThat(live).extracting(Caller::memberId).containsExactly("gm-cccc0001");
    }

    @Test
    void anOlderOrSameVersionIsIgnoredAndAClosedGuildClosesEveryone() {
        roster();
        served.set(body(5, List.of(entry("gm-aaaa0001", "member", List.of(), false))));
        roster.versionIs(5);
        await().until(() -> roster.version() == 5);
        int before = reads.get();
        roster.versionIs(4);
        roster.versionIs(5);
        assertThat(reads.get()).isEqualTo(before);
        live.add(caller("gm-aaaa0001", "member", List.of(), false));
        Map<String, Object> closedGuild = body(6, List.of());
        closedGuild.put("closed", true);
        served.set(closedGuild);
        roster.versionIs(6);
        await().until(() -> closed.contains("gm-aaaa0001"));
        refused(caller("gm-aaaa0001", "member", List.of(), false));
    }

    @Test
    void anotherGuildsRosterIsIgnoredAndAFailedReadIsTriedAgain() {
        roster();
        Map<String, Object> other = body(9, List.of());
        other.put("guildId", "gu-someother01");
        served.set(other);
        roster.versionIs(9);
        await().until(() -> reads.get() >= 2);
        assertThat(roster.known()).isFalse();
        served.set(null);
        int now = reads.get();
        await().until(() -> reads.get() >= now + 2);
        served.set(body(9, List.of(entry("gm-aaaa0001", "member", List.of(), false))));
        await().until(() -> roster.version() == 9);
    }

    @Test
    void theLastRosterIsKeptAndReadBackAfterARestart() throws Exception {
        roster();
        served.set(body(7, List.of(entry("gm-aaaa0001", "lead", List.of(), false), Map.of("memberId", "bad"))));
        roster.versionIs(7);
        await().until(() -> Files.exists(dir.resolve(GuildRoster.FILE)));
        roster.stop();
        GuildRoster again = roster();
        again.loadKept();
        assertThat(again.version()).isEqualTo(7);
        assertThat(again.member("gm-aaaa0001").grants()).isEqualTo(Caller.GRANTS);
        // A malformed member was left out, so they're refused.
        assertThat(again.member("bad")).isNull();
        assertThat(Files.readString(dir.resolve(GuildRoster.FILE))).doesNotContain("\"bad\"");
    }

    @Test
    void aTokenThatDisagreesAsksForAFreshRead() {
        roster();
        served.set(body(1, List.of(entry("gm-aaaa0001", "member", List.of(), false))));
        roster.read();
        await().until(() -> roster.version() == 1);
        served.set(body(2, List.of(entry("gm-aaaa0001", "officer", List.of("invite"), false))));
        refused(caller("gm-aaaa0001", "officer", List.of("invite"), false));
        await().until(() -> roster.version() == 2);
        assertThatNoException(caller("gm-aaaa0001", "officer", List.of("invite"), false));
        assertThat(new ArrayList<>(closed)).isEmpty();
    }

    private void assertThatNoException(Caller caller) {
        try {
            roster.check(caller);
        } catch (SessionAuthorizer.RefusedException e) {
            throw new AssertionError("refused", e);
        }
    }
}
