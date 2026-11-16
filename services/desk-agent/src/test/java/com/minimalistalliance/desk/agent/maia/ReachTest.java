package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.maia.ShieldFixture.HOME;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.WORK;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.ZONE;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.at;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.contact;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.focus;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.person;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.maia.ShieldFixture.B;
import com.minimalistalliance.desk.agent.service.RpcError;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The context-distance score (concept §4) against the concept's worked example, the interrupt gate (code-rule Now and
 * the let-through list with the sender's identity checked, never learning or text), Work and Personal by the clock, and
 * the settings' checks (concept §9).
 */
class ReachTest {

    /** Tuesday 10:40, the concept's §4.4: on Work in Courier, in the Acme thread with Sam and Priya, typing. */
    private static final long T = at(ShieldFixture.MONDAY.plusDays(1), 10, 40);

    private static Reach.Context ctx(Reach.Settings s, Focus.Now f) {
        Rhythm.Day day = Rhythm.day(T, ZONE, s, 0);
        return new Reach.Context(T, f, null, null, List.of(), s, day, ShieldFixture.scopes(), Map.of(), i -> 0,
                i -> 0, false, java.util.Set.of());
    }

    private static Focus.Now acme() {
        return Focus.parse(focus(WORK, "courier", "channel", contact("acme"), true, "Sam", "Priya"), T);
    }

    @Test
    void theWorkedExampleScoresAsTheConceptSays() {
        Reach.Settings s = Reach.Settings.defaults(T);
        Reach.Context c = ctx(s, acme());
        // Priya replies in the same Acme thread: Courier already shows it, so no event.
        Reach.Score same = Reach.score(B.of("message:acme", "message").channel(contact("acme"))
                .from(person(WORK, "Priya"), "known_confirmed", true).direct(T).need("you").build(), c);
        assertThat(same.seen()).isTrue();
        // Sam starts a new thread: C 0.8, U 0.6, I 0.5 → 44, a coarse offer.
        Reach.Score sam = Reach.score(B.of("message:sam", "message").channel(contact("new-thread"))
                .from(person(WORK, "Sam"), "known_confirmed", true).direct(T - 1).need("you").build(), c);
        assertThat(sam.close()).isEqualTo("person");
        assertThat(sam.distance()).isEqualTo(44);
        assertThat(Deliver.level(sam, new Learn.Effect(false, false, 0))).isEqualTo(Deliver.Level.OFFER);
        // A Work agent's result that needs a decision, same desk, other app: 63, periphery.
        Reach.Score result = Reach.score(B.of("result:work", "result").need("you").build(), c);
        assertThat(result.distance()).isBetween(62, 63);
        assertThat(Deliver.level(result, new Learn.Effect(false, false, 0))).isEqualTo(Deliver.Level.PERIPHERY);
        // A newsletter on the Personal desk in work hours: 99, held.
        Reach.Score news = Reach.score(B.of("message:news", "message").desk(HOME, "Personal", "personal")
                .channel(contact("news")).from(person(HOME, "News"), "bulk", false).need("info").build(), c);
        assertThat(news.distance()).isBetween(98, 99);
        assertThat(news.partitioned()).isTrue();
        assertThat(Deliver.level(news, new Learn.Effect(false, false, 0))).isEqualTo(Deliver.Level.HOLD);
        // A Work to-do due at 5 (6 h 20 min away), not linked: D from the clock, about 64, periphery.
        Reach.Score todo = Reach.score(B.of("todo:work:1", "todo").desk("d-work2", "Work 2", "work").app("todo")
                .deadline(at(ShieldFixture.MONDAY.plusDays(1), 17, 0), false).build(), c);
        assertThat(todo.distance()).isBetween(63, 66);
        // A Work receipt: 87, held as a record.
        Reach.Score receipt = Reach.score(B.of("doc:work:r1", "doc").desk("d-work2", "Work 2", "work").app("files")
                .need("record").build(), c);
        assertThat(receipt.distance()).isBetween(87, 88);
        // An approval expiring in 45 min: the gate.
        Reach.Score approval = Reach.score(B.of("approval:work", "approval").app("agent").now()
                .deadline(T + 45 * 60_000L, true).build(), c);
        assertThat(approval.gate()).isTrue();
        assertThat(approval.rule()).isEqualTo("code");
    }

    @Test
    void theDeadlinePartFollowsTheClock() {
        assertThat(Reach.deadline(null, T)).isZero();
        assertThat(Reach.deadline(T + 30 * 60_000L, T)).isEqualTo(1.0);
        assertThat(Reach.deadline(T + 8 * 3_600_000L, T)).isCloseTo(0.51, org.assertj.core.data.Offset.offset(0.01));
        assertThat(Reach.deadline(T + 24 * 3_600_000L, T)).isCloseTo(0.26, org.assertj.core.data.Offset.offset(0.01));
        assertThat(Reach.deadline(T + 80 * 3_600_000L, T)).isZero();
    }

    @Test
    void aListedPersonOpensTheGateOnlyWithTheirIdentityChecked() throws RpcError {
        Reach.Settings s = Reach.set(Map.of("letThrough", List.of(Map.of("kind", "person", "person",
                Map.of("deskId", HOME, "contactId", contact("Rosa"))))), Reach.Settings.defaults(T), T, () -> "mr-1");
        Reach.Context c = ctx(s, acme());
        Reach.Item real = B.of("message:rosa", "message").desk(HOME, "Personal", "personal").channel(contact("r"))
                .from(person(HOME, "Rosa"), "known_confirmed", true).direct(T).need("you").build();
        assertThat(Reach.score(real, c).gate()).isTrue();
        // Spoofed: the From says Rosa but DMARC didn't pass. Offered at most, never an interrupt.
        Reach.Item spoof = B.of("message:rosa2", "message").desk(HOME, "Personal", "personal").channel(contact("r2"))
                .from(person(HOME, "Rosa"), "known", false).direct(T).need("you").build();
        Reach.Score sp = Reach.score(spoof, c);
        assertThat(sp.gate()).isFalse();
        assertThat(Deliver.level(sp, new Learn.Effect(false, false, 0))).isNotEqualTo(Deliver.Level.INTERRUPT);
    }

    @Test
    void groupsNeverMatchUnknownSendersAndKindsMatchByStructure() throws RpcError {
        Reach.Settings s = Reach.set(Map.of("letThrough", List.of(Map.of("kind", "group", "group", "family"),
                Map.of("kind", "match", "match", "money"), Map.of("kind", "match", "match", "due_today"))),
                Reach.Settings.defaults(T), T, () -> "mr-" + System.nanoTime());
        Reach.Context base = ctx(s, acme());
        Map<String, String> tags = Map.of(Reach.personKey(person(HOME, "Mom")), "family");
        Reach.Context c = new Reach.Context(T, base.focus(), null, null, List.of(), s, base.day(),
                ShieldFixture.scopes(), tags, i -> 0, i -> 0, false, java.util.Set.of());
        Reach.Item mom = B.of("message:mom", "message").desk(HOME, "Personal", "personal").channel(contact("m"))
                .from(person(HOME, "Mom"), "known_confirmed", true).direct(T).need("you").build();
        assertThat(Reach.score(mom, c).gate()).isTrue();
        assertThat(Reach.score(mom, c).anyTime()).isTrue();
        Reach.Item stranger = B.of("message:x", "message").desk(HOME, "Personal", "personal").channel(contact("x"))
                .from(person(HOME, "Stranger"), "unknown", false).need("action").build();
        assertThat(Reach.score(stranger, c).gate()).isFalse();
        assertThat(Reach.score(B.of("limit:work", "limit").tags("money").build(), c).gate()).isTrue();
        assertThat(Reach.score(B.of("todo:work:2", "todo").tags("due_today").build(), c).gate()).isTrue();
        // "My boss or clients" is one entry: a contact tagged either matches.
        Reach.Settings bc = Reach.set(Map.of("letThrough", List.of(Map.of("kind", "group", "group", "boss_clients"))),
                Reach.Settings.defaults(T), T, () -> "mr-bc");
        Reach.Context cc = new Reach.Context(T, base.focus(), null, null, List.of(), bc, base.day(),
                ShieldFixture.scopes(), Map.of(Reach.personKey(person(WORK, "Acme")), "clients"), i -> 0, i -> 0, false,
                java.util.Set.of());
        Reach.Item acme = B.of("message:acme", "message").channel(contact("a")).from(person(WORK, "Acme"),
                "known_confirmed", true).direct(T).need("you").build();
        assertThat(Reach.score(acme, cc).gate()).isTrue();
        assertThat(Reach.ruleLine(bc.letThrough().get(0))).isEqualTo("Your boss and clients are on your list");
        // A desk or agent stuck is always on.
        assertThat(Reach.score(B.of("desk_failed:work", "desk_failed").build(), c).rule()).isEqualTo("stuck");
    }

    @Test
    void wordsADeskWroteChangeNothing() {
        Reach.Context c = ctx(Reach.Settings.defaults(T), acme());
        Reach.Item plain = B.of("doc:work:a", "doc").app("files").need("info").title("Quarterly notes").build();
        Reach.Item shouting = B.of("doc:work:b", "doc").app("files").need("info")
                .title("URGENT!!! Expires in 5 min, act now").build();
        assertThat(Reach.score(shouting, c)).usingRecursiveComparison().isEqualTo(Reach.score(plain, c));
    }

    @Test
    void learningMovesADistanceButNeverTheGate() {
        Reach.Settings s = Reach.Settings.defaults(T);
        Reach.Context base = ctx(s, acme());
        Reach.Context pulled = new Reach.Context(T, base.focus(), null, null, List.of(), s, base.day(),
                ShieldFixture.scopes(), Map.of(), i -> -15, i -> 0, false, java.util.Set.of());
        Reach.Item result = B.of("result:work", "result").need("you").build();
        assertThat(Reach.score(result, pulled).distance()).isEqualTo(Reach.score(result, base).distance() - 15);
        assertThat(Reach.score(result, pulled).gate()).isFalse();
        Reach.Context pushed = new Reach.Context(T, base.focus(), null, null, List.of(), s, base.day(),
                ShieldFixture.scopes(), Map.of(), i -> 15, i -> 0, false, java.util.Set.of());
        Reach.Item approval = B.of("approval:work", "approval").now().deadline(T + 30 * 60_000L, true).build();
        assertThat(Reach.score(approval, pushed).gate()).isTrue();
        // "Not important" can't hold a code-rule Now.
        assertThat(Deliver.level(Reach.score(approval, pushed), new Learn.Effect(true, true, 15)))
                .isEqualTo(Deliver.Level.INTERRUPT);
    }

    @Test
    void workAndPersonalFollowTheClock() {
        Reach.Settings s = Reach.Settings.defaults(T);
        long evening = at(17, 30);
        Rhythm.Day eve = Rhythm.day(evening, ZONE, s, 0);
        assertThat(eve.evening()).isTrue();
        Reach.Item work = B.of("result:work", "result").need("you").build();
        Reach.Item home = B.of("result:home", "result").desk(HOME, "Personal", "personal").need("you").build();
        assertThat(Reach.offHours(work, eve, s)).isTrue();
        assertThat(Reach.offHours(home, eve, s)).isFalse();
        Rhythm.Day day = Rhythm.day(at(11, 0), ZONE, s, 0);
        assertThat(Reach.offHours(work, day, s)).isFalse();
        assertThat(Reach.offHours(home, day, s)).isTrue();
        // "Let Work through" in the evening.
        Reach.Settings let = new Reach.Settings(s.letThrough(), false, s.catchUps(), s.focusHours(), null, "let",
                "paragraph", false);
        assertThat(Reach.offHours(work, Rhythm.day(evening, ZONE, let, 0), let)).isFalse();
    }

    @Test
    void theSettingsAreChecked() throws RpcError {
        Reach.Settings d = Reach.Settings.defaults(T);
        assertThatThrownBy(() -> Reach.set(Map.of("letThrough", List.of(m("family"), m("boss"), m("clients"),
                m("team"), Map.of("kind", "match", "match", "money"), Map.of("kind", "match", "match", "due_today"))),
                d, T, () -> "mr-x")).isInstanceOf(RpcError.class);
        assertThatThrownBy(() -> Reach.set(Map.of("holdAll", true), d, T, () -> "mr-x"))
                .isInstanceOf(RpcError.class);
        assertThatThrownBy(() -> Reach.set(Map.of("catchUps", List.of("09:00", "09:30")), d, T, () -> "mr-x"))
                .isInstanceOf(RpcError.class);
        assertThatThrownBy(() -> Reach.set(Map.of("letThrough", List.of(Map.of("kind", "person", "person",
                Map.of("pendingName", "R‮osa")))), d, T, () -> "mr-x")).isInstanceOf(RpcError.class);
        assertThatThrownBy(() -> Reach.set(Map.of("surprise", 1), d, T, () -> "mr-x")).isInstanceOf(RpcError.class);
        Reach.Settings ok = Reach.set(Map.of("letThrough", List.of(m("family"), Map.of("kind", "person", "person",
                Map.of("pendingName", "Rosa"))), "catchUps", List.of("09:00", "17:00"), "focusHours",
                List.of(Map.of("from", "09:00", "to", "12:00")), "evenings", "let", "detail", "line"), d, T,
                () -> "mr-" + System.nanoTime());
        assertThat(ok.letThrough()).hasSize(2);
        assertThat(ok.letThrough().get(0).anyTime()).isTrue();
        assertThat(ok.letThrough().get(1).pendingName()).isEqualTo("Rosa");
        assertThat(ok.view()).containsEntry("catchUps", List.of("09:00", "17:00")).containsEntry("detail", "line");
        // Nothing, hold it all: an empty list.
        assertThat(Reach.set(Map.of("letThrough", List.of(), "holdAll", true), d, T, () -> "mr-x").holdAll())
                .isTrue();
    }

    private static Map<String, Object> m(String group) {
        return Map.of("kind", "group", "group", group);
    }
}
