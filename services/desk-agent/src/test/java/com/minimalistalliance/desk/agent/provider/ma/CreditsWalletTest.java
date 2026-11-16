package com.minimalistalliance.desk.agent.provider.ma;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.tool.DeskLink;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/**
 * The member's one credits wallet (contract 0.4.10, the coordinator's decision of Nov 15): Desk Maia's answers and her agents'
 * on MA's credits both report it, the newest wins, older answers (no {@code left}, or helpers' with no renewal) aren't wallet
 * views, and a view whose month has renewed isn't returned. Whole credits, never money.
 */
class CreditsWalletTest {

    private static final Instant NOW = Instant.parse("2026-11-15T20:00:00Z");
    private static final String RENEWS = "2026-12-01T07:00:00Z";

    private final MutableClock clock = new MutableClock(NOW);
    private final KeyLease lease = new KeyRing((a, t, d) -> {}).lend(KeyRing.COMPANY);

    /** deskd as a script answering both of MA's services. */
    static final class Link implements DeskLink {
        volatile Function<Map<String, Object>, Reply> answer;

        @Override
        public Set<String> offered() {
            return Set.of();
        }

        @Override
        public boolean maiaModel() {
            return true;
        }

        @Override
        public boolean helpersModel() {
            return true;
        }

        @Override
        public Reply call(Map<String, Object> call, Duration wait) {
            return answer.apply(call);
        }
    }

    private static Map<String, Object> wallet(long left, long monthLeft, long starting, long topUp, String from) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("left", left);
        c.put("month", 2500);
        c.put("monthLeft", monthLeft);
        c.put("week", 800);
        c.put("weekUsed", 120);
        c.put("day", 200);
        c.put("dayUsed", 90);
        c.put("starting", starting);
        c.put("drawingFrom", from);
        return c;
    }

    @Test
    void readsBothServicesShapes() {
        Map<String, Object> maia = wallet(2060, 1550, 210, 0, "week");
        maia.put("topUpLeft", 300);
        CreditsWallet.View m = CreditsWallet.parse(maia, Instant.parse(RENEWS), false, null, "maia", NOW);
        assertThat(m).isNotNull();
        assertThat(m.left()).isEqualTo(2060);
        assertThat(m.monthLeft()).isEqualTo(1550);
        assertThat(m.starting()).isEqualTo(210);
        assertThat(m.topUp()).isEqualTo(300);
        assertThat(m.drawingFrom()).isEqualTo("week");
        assertThat(m.renewsAt()).isEqualTo(Instant.parse(RENEWS));
        // Helpers' shape: top-ups as topUp, the renewal in the object, and the lighter model with today's share.
        Map<String, Object> helpers = wallet(0, 0, 0, 0, "lighter");
        helpers.put("topUp", 0);
        helpers.put("lighter", true);
        helpers.put("lighterLeft", 12);
        helpers.put("renewsAt", RENEWS);
        CreditsWallet.View h = CreditsWallet.parse(helpers, null, false, null, "helpers", NOW);
        assertThat(h.lighter()).isTrue();
        assertThat(h.lighterLeft()).isEqualTo(12L);
        assertThat(h.source()).isEqualTo("helpers");
        // "starting" is a place it can draw from.
        assertThat(CreditsWallet.parse(wallet(210, 0, 210, 0, "starting"), Instant.parse(RENEWS), false, null, "maia",
                NOW).drawingFrom()).isEqualTo("starting");
        // Older answers aren't the one wallet: Desk Maia's 0.4.8 (no left), helpers' 0.4.9 (no renewal).
        assertThat(CreditsWallet.parse(Map.of("month", 2500, "monthLeft", 1550), Instant.parse(RENEWS), false, null,
                "maia", NOW)).isNull();
        assertThat(CreditsWallet.parse(Map.of("left", 209, "starting", 209, "topUp", 0, "lighter", false), null, false,
                null, "helpers", NOW)).isNull();
        // Out of shape: none.
        assertThat(CreditsWallet.parse(Map.of("left", -5), Instant.parse(RENEWS), false, null, "maia", NOW)).isNull();
        assertThat(CreditsWallet.parse("lots", Instant.parse(RENEWS), false, null, "maia", NOW)).isNull();
        // Its view is credits only.
        assertThat(String.valueOf(m.view())).doesNotContain("$").doesNotContainPattern("(?i)usd");
    }

    @Test
    void bothServicesReportToOneWalletAndTheNewestWins() throws Exception {
        CreditsWallet one = new CreditsWallet(clock);
        Link link = new Link();
        MaiaServiceProvider maia = new MaiaServiceProvider(clock);
        HelperServiceProvider helpers = new HelperServiceProvider(clock);
        maia.link(link);
        helpers.link(link);
        maia.wallet(one);
        helpers.wallet(one);

        // Desk Maia's answer: 2,060 left.
        link.answer = call -> new DeskLink.Reply(true, Map.of("v", 1, "text", "ok", "costCredits", 1.84, "allowance",
                Map.of("fraction", 0.62, "resetsAt", RENEWS, "credits", wallet(2060, 1550, 210, 0, "week"), "lighter",
                        false)), null, null, List.of());
        ChatResult hers = maia.chat(new ChatRequest("turn", "ctx", List.of(ChatMessage.user("hi")), 4_000), lease,
                t -> {});
        assertThat(hers.centiCredits()).isEqualTo(184L);
        assertThat(one.latest().left()).isEqualTo(2060);
        assertThat(one.latest().source()).isEqualTo("maia");
        assertThat(maia.walletView()).isSameAs(one.latest());

        // A minute later an agent's answer on the same wallet: 2,059 left. Its view is the wallet now, for Maia too.
        clock.advance(Duration.ofMinutes(1));
        Map<String, Object> after = wallet(2059, 1549, 210, 0, "week");
        after.put("topUp", 0);
        after.put("renewsAt", RENEWS);
        link.answer = call -> new DeskLink.Reply(true, Map.of("v", 1, "text", "Three flights.", "stopReason", "end_turn",
                "costCredits", 0.36, "credits", after), null, null, List.of());
        ChatResult theirs = helpers.chat(new ChatRequest("auto", "ctx", List.of(ChatMessage.user("flights")), 4_000),
                lease, t -> {});
        assertThat(theirs.centiCredits()).isEqualTo(36L);
        assertThat(theirs.providerMicroUsd()).isNull();
        assertThat(one.latest().left()).isEqualTo(2059);
        assertThat(one.latest().source()).isEqualTo("helpers");
        assertThat(maia.walletView().left()).isEqualTo(2059);

        // An older view never replaces a newer one.
        one.report(CreditsWallet.parse(wallet(9999, 2500, 210, 0, "day"), Instant.parse(RENEWS), false, null, "maia",
                NOW));
        assertThat(one.latest().left()).isEqualTo(2059);

        // Once the month renews, what's left is unknown until the next answer.
        clock.set(Instant.parse(RENEWS).plusSeconds(1));
        assertThat(one.latest()).isNull();
    }
}
