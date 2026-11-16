package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.maia.ShieldFixture.HOME;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.MIN;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.WORK;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.at;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.contact;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.event;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.focus;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.idle;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.with;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The shield's model of now (concept §2): the focus block read as ids and times only, the states, the breaks (fine
 * from the office's events, coarse from changes of focus), the settling time, the working sphere and two devices.
 */
class FocusTest {

    private static final long T = at(10, 0);

    @Test
    void theBlockIsReadAsIdsAndTimesOnlyAndAnythingElseIsDropped() {
        Map<String, Object> f = focus(WORK, "notebook", "page", "pg-q3", false, "Sam");
        Focus.Now n = Focus.parse(f, T);
        assertThat(n.deskId()).isEqualTo(WORK);
        assertThat(n.app()).isEqualTo("notebook");
        assertThat(n.item()).isEqualTo(new Focus.Ref("page", "pg-q3"));
        assertThat(n.people()).containsExactly(new Focus.Person(WORK, contact("Sam")));

        // A URL, a title, an unknown app, a bad desk id and a name never get in.
        Focus.Now bad = Focus.parse(with(with(with(f, "item", Map.of("kind", "page", "id", "https://x.test/a b")),
                "app", "evil"), "deskId", "Work desk"), T);
        assertThat(bad.item()).isNull();
        assertThat(bad.app()).isNull();
        assertThat(bad.deskId()).isNull();
        Focus.Now named = Focus.parse(with(f, "people", List.of(Map.of("deskId", WORK, "contactId", "Rosa Diaz"))),
                T);
        assertThat(named.people()).isEmpty();
        // The Browser sends no item, whatever the office passes.
        assertThat(Focus.parse(with(f, "app", "browser"), T).item()).isNull();
        // A Guild Desk in front: no desk, app, item or people (other people use it).
        Focus.Now guild = Focus.parse(with(f, "scope", "guild"), T);
        assertThat(guild.deskId()).isNull();
        assertThat(guild.item()).isNull();
        assertThat(guild.people()).isEmpty();
        assertThat(Focus.parse("nope", T)).isNull();
    }

    @Test
    void statesComeInOrderAndTypingHoldsEverything() {
        Focus.Tracker t = new Focus.Tracker();
        assertThat(Focus.state(t, T, false, false)).isEqualTo(Focus.State.AWAY);
        Focus.observe(t, Focus.parse(focus(WORK, "notebook", "page", "p1", true), T), T, false, false);
        assertThat(Focus.state(t, T + 1_000, false, false)).isEqualTo(Focus.State.TYPING);
        // Typing beats a hold and focus hours; a call beats typing.
        assertThat(Focus.state(t, T + 1_000, true, true)).isEqualTo(Focus.State.TYPING);
        Focus.observe(t, Focus.parse(with(focus(WORK, "notebook", "page", "p1", true), "call", true), T + 2_000),
                T + 2_000, false, false);
        assertThat(Focus.state(t, T + 3_000, false, false)).isEqualTo(Focus.State.CALL);
        // 20 s after the last key it isn't typing any more.
        Focus.observe(t, Focus.parse(focus(WORK, "notebook", "page", "p1", true), T + 4_000), T + 4_000, false, false);
        assertThat(Focus.state(t, T + 25_000, false, false)).isNotEqualTo(Focus.State.TYPING);
        // No observe for 2 minutes: away.
        assertThat(Focus.state(t, T + 4_000 + Focus.AWAY_MS, false, false)).isEqualTo(Focus.State.AWAY);
    }

    @Test
    void aCompletedActionIsAFineBreakAndAChangeOfFocusIsACoarseOne() {
        Focus.Tracker t = new Focus.Tracker();
        Map<String, Object> f = focus(WORK, "courier", "channel", contact("acme"), false);
        Focus.observe(t, Focus.parse(f, T), T, false, false);
        Focus.closeBreak(t);
        assertThat(Focus.state(t, T + 1_000, false, false)).isEqualTo(Focus.State.STEADY);

        Focus.Kind fine = Focus.observe(t, Focus.parse(event(f, "sent", T + 5_000), T + 10_000), T + 10_000, false,
                false);
        assertThat(fine).isEqualTo(Focus.Kind.FINE);
        assertThat(Focus.state(t, T + 11_000, false, false)).isEqualTo(Focus.State.FINE);
        // A break stays open 20 s.
        assertThat(Focus.state(t, T + 10_000 + Focus.BREAK_MS + 1, false, false)).isEqualTo(Focus.State.STEADY);

        // The desk in front changes: coarse.
        Focus.Kind coarse = Focus.observe(t, Focus.parse(focus(HOME, "todo", null, null, false), T + 60_000),
                T + 60_000, false, false);
        assertThat(coarse).isEqualTo(Focus.Kind.COARSE);
        // A window closed: coarse.
        Focus.closeBreak(t);
        assertThat(Focus.observe(t, Focus.parse(event(focus(HOME, "todo", null, null, false), "window_closed",
                T + 70_000), T + 70_000), T + 70_000, false, false)).isEqualTo(Focus.Kind.COARSE);
        // Back from 2 minutes idle: coarse.
        Focus.closeBreak(t);
        Focus.observe(t, Focus.parse(idle(focus(HOME, "todo", null, null, false), true), T + 80_000), T + 80_000,
                false, false);
        assertThat(Focus.observe(t, Focus.parse(focus(HOME, "todo", null, null, false), T + 90_000), T + 90_000,
                false, false)).isEqualTo(Focus.Kind.COARSE);
    }

    @Test
    void noBreakInTheFirstTenMinutesOfAFocusStretchAndItsEndIsCoarse() {
        Focus.Tracker t = new Focus.Tracker();
        Map<String, Object> f = focus(WORK, "notebook", "page", "p1", false);
        Focus.observe(t, Focus.parse(f, T), T, false, false);
        Focus.closeBreak(t);
        Focus.tick(t, T + 1_000, true, false);
        assertThat(Focus.observe(t, Focus.parse(event(f, "saved", T + 2 * MIN), T + 2 * MIN), T + 2 * MIN, true,
                false)).isNull();
        for (long m = 3; m <= 10; m++) {
            // The office's keep-alive.
            Focus.observe(t, Focus.parse(f, T + m * MIN), T + m * MIN, true, false);
        }
        assertThat(Focus.observe(t, Focus.parse(event(f, "saved", T + 11 * MIN), T + 11 * MIN), T + 11 * MIN, true,
                false)).isEqualTo(Focus.Kind.FINE);
        Focus.closeBreak(t);
        Focus.observe(t, Focus.parse(f, T + 59 * MIN), T + 59 * MIN, true, false);
        assertThat(Focus.tick(t, T + 60 * MIN, false, false)).isEqualTo(Focus.Kind.COARSE);
    }

    @Test
    void theWorkingSphereIsWhatTheMemberDweltOnThreeMinutes() {
        Focus.Tracker t = new Focus.Tracker();
        Focus.observe(t, Focus.parse(focus(WORK, "notebook", "page", "p1", false), T), T, false, false);
        assertThat(Focus.sphere(t, T + MIN)).isNull();
        assertThat(Focus.sphere(t, T + 4 * MIN)).isEqualTo(new Focus.Sphere(WORK, "notebook",
                new Focus.Ref("page", "p1")));
        // A glance elsewhere doesn't move it.
        Focus.observe(t, Focus.parse(focus(WORK, "todo", null, null, false), T + 4 * MIN), T + 4 * MIN, false, false);
        assertThat(Focus.sphere(t, T + 5 * MIN).item()).isEqualTo(new Focus.Ref("page", "p1"));
        // The refs working_on picks: what was dwelt on most.
        assertThat(Focus.recent(t, T + 5 * MIN, 2 * 60 * MIN, 3)).extracting(Focus.Sphere::item)
                .containsExactly(new Focus.Ref("page", "p1"));
    }

    @Test
    void withTwoDevicesTheLatestInputIsWhereTheMemberIsAndThePhoneWaits() {
        Focus.Tracker t = new Focus.Tracker();
        Map<String, Object> office = with(focus(WORK, "notebook", "page", "p1", false), "input",
                Map.of("typing", false, "idle", false, "lastAt", T));
        Focus.observe(t, Focus.parse(office, T), T, false, false);
        Map<String, Object> phone = with(with(with(focus(WORK, "maia", null, null, false), "surface", "phone"),
                "device", "dv-phone00001"), "input", Map.of("typing", false, "idle", false, "lastAt", T + MIN));
        Focus.observe(t, Focus.parse(phone, T + MIN), T + MIN, false, false);
        // The office had input under 10 minutes ago: the phone stays quiet.
        assertThat(t.device()).isEqualTo("dv-office0001");
        Map<String, Object> laterPhone = with(phone, "input", Map.of("typing", false, "idle", false, "lastAt",
                T + 12 * MIN));
        Focus.observe(t, Focus.parse(laterPhone, T + 12 * MIN), T + 12 * MIN, false, false);
        assertThat(t.device()).isEqualTo("dv-phone00001");
    }
}
