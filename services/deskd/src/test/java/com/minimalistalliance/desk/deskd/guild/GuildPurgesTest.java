package com.minimalistalliance.desk.deskd.guild;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
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

/**
 * Whose agent conversations a roster owes a purge, and when (ADR 0080 decision 12 and its addendum of 2026-11-10).
 * Deletion can't be undone, so most of these are about what must never cause one.
 */
class GuildPurgesTest {

    private static final String GUILD = "gu-testguild01";
    private static final String LEAD = "gm-lead0001";
    private static final String A = "gm-aaaa0001";
    private static final String B = "gm-bbbb0001";
    private static final String C = "gm-cccc0001";
    private static final String D = "gm-dddd0001";
    private static final String E = "gm-eeee0001";
    private static final Duration GRACE = GuildRoster.Timing.PURGE_GRACE;
    private static final GuildRoster.Timing FAST = new GuildRoster.Timing(Duration.ofMillis(20), Duration.ofMillis(100));

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-10T12:00:00Z"));
    private final AtomicReference<Map<String, Object>> served = new AtomicReference<>();
    private final AtomicInteger reads = new AtomicInteger();
    private final List<Caller> live = new CopyOnWriteArrayList<>();
    private final List<GuildRoster> rosters = new ArrayList<>();
    private String guild = GUILD;

    @AfterEach
    void tearDown() {
        rosters.forEach(GuildRoster::stop);
    }

    private GuildRoster roster() {
        GuildRoster roster = new GuildRoster(dir, () -> {
            reads.incrementAndGet();
            Map<String, Object> body = served.get();
            if (body == null) {
                throw new IOException("503");
            }
            return body;
        }, () -> guild, new GuildRoster.Sessions() {
            @Override
            public Collection<Caller> callers() {
                return List.copyOf(live);
            }

            @Override
            public void closeMember(String memberId) {
                live.removeIf(caller -> caller.memberId().equals(memberId));
            }
        }, FAST, clock);
        rosters.add(roster);
        return roster;
    }

    private static Map<String, Object> entry(String memberId, String role) {
        Map<String, Object> member = new LinkedHashMap<>();
        member.put("memberId", memberId);
        member.put("role", role);
        member.put("grants", List.of());
        member.put("name", "Name");
        member.put("badge", null);
        member.put("teen", false);
        return member;
    }

    /** A roster of this version: the first id is the Founder, the rest members. */
    private static Map<String, Object> body(long version, String... ids) {
        List<Map<String, Object>> members = new ArrayList<>();
        for (int i = 0; i < ids.length; i++) {
            members.add(entry(ids[i], i == 0 ? "lead" : "member"));
        }
        return body(version, members);
    }

    private static Map<String, Object> body(long version, List<Map<String, Object>> members) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("guildId", GUILD);
        body.put("version", version);
        body.put("closed", false);
        body.put("members", members);
        return body;
    }

    /**
     * The Platform serves this roster and says its version; it's applied, and kept on disk (after the purge list), before
     * this returns.
     */
    private void serve(GuildRoster roster, Map<String, Object> body) {
        served.set(body);
        long version = ((Number) body.get("version")).longValue();
        roster.versionIs(version);
        await().until(() -> roster.version() >= version && keptVersion() >= version);
    }

    private long keptVersion() {
        try {
            byte[] bytes = Files.readAllBytes(dir.resolve(GuildRoster.FILE));
            return ((Number) com.minimalistalliance.desk.deskd.protocol.Json.parseObject(bytes).get("version")).longValue();
        } catch (Exception e) {
            return -1;
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> counts(GuildRoster roster) {
        return (Map<String, Object>) roster.purges().health().get("guildPurges");
    }

    @Test
    void aNewerRosterThatLeavesAMemberOutOwesTheirPurgeOnceTheGraceIsOver() throws Exception {
        GuildRoster roster = roster();
        serve(roster, body(1, LEAD, A, B, C));
        serve(roster, body(2, LEAD, A, B));
        assertThat(roster.purges().stateOf(C)).isEqualTo(GuildPurges.State.OWED);
        assertThat(roster.purges().due()).isEmpty();
        assertThat(roster.purges().nextDueAtMillis()).isEqualTo(clock.millis() + GRACE.toMillis());
        assertThat(Files.readString(dir.resolve(GuildPurges.FILE))).contains(C).doesNotContain(A);
        clock.advance(GRACE);
        assertThat(roster.purges().due()).containsExactly(C);
        assertThat(counts(roster)).containsEntry("owed", 1).containsEntry("held", 0).containsEntry("done", 0L);

        roster.purges().done(C, Map.of("purged", true, "messages", 4));
        assertThat(roster.purges().due()).isEmpty();
        assertThat(counts(roster)).containsEntry("owed", 0).containsEntry("done", 1L);
        assertThat(Files.readString(dir.resolve(GuildPurges.FILE))).doesNotContain(C);
    }

    @Test
    void aFirstRosterAFailedReadAnotherGuildsOrAnOlderOneOwesNothing() throws Exception {
        GuildRoster roster = roster();
        // None read and none kept: whoever isn't on the first roster is unknown, never gone.
        serve(roster, body(5, LEAD, A));
        // A read that fails, another guild's, and one with no members: nothing applied.
        served.set(null);
        roster.versionIs(6);
        await().until(() -> reads.get() >= 3);
        Map<String, Object> other = body(7, LEAD);
        other.put("guildId", "gu-someother01");
        served.set(other);
        await().until(() -> reads.get() >= 5);
        Map<String, Object> broken = body(7, LEAD);
        broken.remove("members");
        served.set(broken);
        await().until(() -> reads.get() >= 7);
        assertThat(roster.version()).isEqualTo(5);
        // An older or the same version is ignored.
        served.set(body(4, LEAD));
        roster.read();
        await().until(() -> reads.get() >= 8);
        assertThat(roster.version()).isEqualTo(5);
        clock.advance(GRACE.multipliedBy(2));
        assertThat(roster.purges().due()).isEmpty();
        assertThat(counts(roster)).containsEntry("owed", 0).containsEntry("held", 0);
        assertThat(roster.purges().stateOf(A)).isNull();
    }

    @Test
    void aMemberWithNoSessionOrAMalformedEntryIsNeverTakenAsGone() throws Exception {
        GuildRoster roster = roster();
        serve(roster, body(1, LEAD, A, B));
        // Nobody has a session; a newer version with the same members owes nothing.
        serve(roster, body(2, LEAD, A, B));
        // A's entry is malformed: A is refused, but A is listed, so not gone.
        Map<String, Object> malformedA = entry(A, "emperor");
        serve(roster, body(3, List.of(entry(LEAD, "lead"), malformedA, entry(B, "member"))));
        assertThat(roster.member(A)).isNull();
        assertThat(roster.purges().stateOf(A)).isNull();
        // And after a restart, from the kept roster: A was listed there too, so a roster that drops A owes A's purge.
        roster.stop();
        GuildRoster again = roster();
        again.loadKept();
        assertThat(again.version()).isEqualTo(3);
        serve(again, body(4, LEAD, B));
        assertThat(again.purges().stateOf(A)).isEqualTo(GuildPurges.State.OWED);
    }

    @Test
    void mostMembersGoneAtOnceIsHeldUntilALaterSoundRosterConfirms() throws Exception {
        GuildRoster roster = roster();
        serve(roster, body(1, LEAD, A, B, C, D));
        // Three of five gone at once: held, however long it waits.
        serve(roster, body(2, LEAD, A));
        assertThat(List.of(B, C, D)).allSatisfy(id -> assertThat(roster.purges().stateOf(id)).isEqualTo(GuildPurges.State.HELD));
        clock.advance(GRACE.multipliedBy(100));
        assertThat(roster.purges().due()).isEmpty();
        assertThat(roster.purges().nextDueAtMillis()).isEqualTo(Long.MAX_VALUE);
        assertThat(counts(roster)).containsEntry("held", 3).containsEntry("owed", 0);
        // A later roster that still leaves them out, and is sound, confirms: then the grace, then due.
        serve(roster, body(3, LEAD, A, E));
        assertThat(roster.purges().due()).isEmpty();
        clock.advance(GRACE);
        assertThat(roster.purges().due()).containsExactlyInAnyOrder(B, C, D);
    }

    @Test
    void aRosterWithNoFounderOrAnEntryThatCantBeReadIsHeld() throws Exception {
        GuildRoster roster = roster();
        serve(roster, body(1, LEAD, A, B, C, D));
        // No Founder: the lead's drop is held, and so would any other's be.
        Map<String, Object> noLead = body(2, List.of(entry(A, "member"), entry(B, "member"), entry(C, "member"),
                entry(D, "member")));
        serve(roster, noLead);
        assertThat(roster.purges().stateOf(LEAD)).isEqualTo(GuildPurges.State.HELD);
        // An entry whose id can't be read: who is missing isn't known, so D's drop is held, and nothing is confirmed.
        Map<String, Object> unreadable = new LinkedHashMap<>(entry(A, "lead"));
        Map<String, Object> noId = entry(C, "member");
        noId.put("memberId", "not-an-id");
        serve(roster, body(3, List.of(unreadable, entry(B, "member"), noId)));
        assertThat(roster.purges().stateOf(D)).isEqualTo(GuildPurges.State.HELD);
        assertThat(roster.purges().stateOf(LEAD)).isEqualTo(GuildPurges.State.HELD);
        assertThat(roster.purges().stateOf(C)).isEqualTo(GuildPurges.State.HELD);
        clock.advance(GRACE.multipliedBy(10));
        assertThat(roster.purges().due()).isEmpty();
        // A sound roster with a new Founder confirms them all.
        serve(roster, body(4, A, B));
        clock.advance(GRACE);
        assertThat(roster.purges().due()).containsExactlyInAnyOrder(LEAD, C, D);
    }

    @Test
    void aMemberBackBeforeThePurgeRunsKeepsTheirData() throws Exception {
        GuildRoster roster = roster();
        serve(roster, body(1, LEAD, A, B, C, D));
        serve(roster, body(2, LEAD, A, B, C));
        assertThat(roster.purges().stateOf(D)).isEqualTo(GuildPurges.State.OWED);
        serve(roster, body(3, LEAD, A, B, C, D));
        assertThat(roster.purges().stateOf(D)).isNull();
        // Held ones too.
        serve(roster, body(4, LEAD));
        assertThat(roster.purges().stateOf(A)).isEqualTo(GuildPurges.State.HELD);
        serve(roster, body(5, LEAD, A, B, C, D));
        clock.advance(GRACE.multipliedBy(2));
        assertThat(roster.purges().due()).isEmpty();
        assertThat(counts(roster)).containsEntry("owed", 0).containsEntry("held", 0);
        assertThat(Files.readString(dir.resolve(GuildPurges.FILE))).doesNotContain(D).doesNotContain(A);
        // done for one who came back changes nothing.
        roster.purges().done(D, Map.of());
        assertThat(counts(roster)).containsEntry("done", 0L);
    }

    @Test
    void aClosedGuildOwesNothingHere() throws Exception {
        GuildRoster roster = roster();
        serve(roster, body(1, LEAD, A));
        Map<String, Object> closed = body(2);
        closed.put("closed", true);
        serve(roster, closed);
        clock.advance(GRACE.multipliedBy(2));
        assertThat(roster.purges().due()).isEmpty();
        assertThat(roster.purges().stateOf(A)).isNull();
    }

    @Test
    void theListSurvivesARestartAndAnotherGuildsIsIgnored() throws Exception {
        GuildRoster roster = roster();
        serve(roster, body(1, LEAD, A, B));
        serve(roster, body(2, LEAD, A));
        roster.stop();
        GuildRoster again = roster();
        again.loadKept();
        clock.advance(GRACE);
        assertThat(again.purges().due()).containsExactly(B);
        again.stop();
        // The same desk handed to another guild: neither its roster nor its list applies.
        guild = "gu-someother01";
        GuildRoster other = roster();
        other.loadKept();
        assertThat(other.known()).isFalse();
        assertThat(other.purges().due()).isEmpty();
    }

    @Test
    void offAGuildDeskThereIsNothingToShow() {
        guild = null;
        GuildRoster roster = roster();
        roster.loadKept();
        assertThat(roster.purges().health()).isEmpty();
        assertThat(roster.purges().due()).isEmpty();
        assertThat(Files.exists(dir.resolve(GuildPurges.FILE))).isFalse();
    }
}
