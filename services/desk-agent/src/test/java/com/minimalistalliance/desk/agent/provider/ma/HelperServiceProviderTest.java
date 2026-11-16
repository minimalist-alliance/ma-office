package com.minimalistalliance.desk.agent.provider.ma;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.tool.DeskLink;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/**
 * Helpers on the member's MA credits (ma-platform desk-helpers.md; deskd API.md §24): the request as the contract's fields
 * (the task, never a model; the helper's own instructions; files' text fenced, pictures as a line; tools; the output cap), the
 * answer with its credits and never money or a model's name, the credits read, each refusal as the kind a run ends with, and
 * no call without deskd's offer.
 */
@SuppressWarnings("unchecked")
class HelperServiceProviderTest {

    private static final Instant NOW = Instant.parse("2026-11-15T20:00:00Z");

    static final class Link implements DeskLink {
        final List<Map<String, Object>> calls = new CopyOnWriteArrayList<>();
        volatile boolean offers = true;
        volatile Function<Map<String, Object>, Reply> answer = call -> ok(Map.of("v", 1, "text", "Opening it.",
                "stopReason", "end_turn", "usage", Map.of("inputTokens", 1500, "outputTokens", 120), "costCredits", 0.45,
                "credits", Map.of("left", 261, "starting", 261, "topUp", 0, "lighter", false)));

        @Override
        public Set<String> offered() {
            return Set.of();
        }

        @Override
        public boolean helpersModel() {
            return offers;
        }

        @Override
        public Reply call(Map<String, Object> call, Duration wait) {
            calls.add(call);
            return answer.apply(call);
        }

        static Reply ok(Map<String, Object> r) {
            return new Reply(true, r, null, null, List.of());
        }

        static Reply refused(String code, Map<String, Object> details) {
            return new Reply(false, null, code, details.get("reason") instanceof String r ? r : code, List.of(), false,
                    details);
        }
    }

    private final MutableClock clock = new MutableClock(NOW);
    private final Link link = new Link();
    private final HelperServiceProvider provider = provider();
    private final KeyLease lease = new KeyRing((a, t, d) -> {}).lend(KeyRing.CREDITS);

    private HelperServiceProvider provider() {
        HelperServiceProvider p = new HelperServiceProvider(clock);
        p.link(link);
        return p;
    }

    private static ChatRequest call(String model, String text) {
        return new ChatRequest(model, "You are Research, a helper on the Work desk.", List.of(ChatMessage.user(text)), 8_000,
                List.of(new ToolSpec("browser_open", "Open a page.", Map.of("type", "object"))));
    }

    @Test
    void aCallSendsTheTaskAndTheHelpersInstructionsNeverAModel() throws Exception {
        ChatResult result = provider.chat(call(HelperServiceProvider.AUTO, "Find three flights"), lease, d -> {});
        Map<String, Object> sent = link.calls.getFirst();
        assertThat(sent).containsEntry("tool", HelperServiceProvider.TOOL).containsEntry("agentId", "helper");
        Map<String, Object> args = (Map<String, Object>) sent.get("args");
        assertThat(args.keySet()).containsExactly("task", "callId", "context", "messages", "tools", "maxOutputTokens");
        assertThat(args).containsEntry("task", "agent").containsEntry("context",
                "You are Research, a helper on the Work desk.").containsEntry("maxOutputTokens", 8000);
        assertThat((List<Object>) args.get("tools")).hasSize(1);
        // Never money and never a model's name: the cost is in credits on the Platform.
        assertThat(result.providerMicroUsd()).isNull();
        assertThat(result.model()).isEqualTo(ProviderId.MA_CREDITS.id());
        assertThat(result.text()).isEqualTo("Opening it.");
        assertThat(provider.lastCredits()).isEqualTo(new HelperServiceProvider.Credits(261, 261, 0, false, null));
        // The small jobs are their own task.
        provider.chat(call(HelperServiceProvider.SMALL, "Summarise"), lease, d -> {});
        assertThat((Map<String, Object>) link.calls.get(1).get("args")).containsEntry("task", "small");
    }

    @Test
    void noOfferNoCall() {
        link.offers = false;
        assertThatThrownBy(() -> provider.chat(call(HelperServiceProvider.AUTO, "hi"), lease, d -> {}))
                .isInstanceOfSatisfying(ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
                    assertThat(e.mayHaveBilled()).isFalse();
                });
        assertThat(link.calls).isEmpty();
    }

    @Test
    void theCreditsReadAsksDeskdOnceAMinuteAndMakesTheGrantTheFirstTime() throws Exception {
        link.answer = c -> Link.ok(Map.of("v", 1, "enabled", true, "credits", Map.of("left", 262, "starting", 262, "topUp",
                0, "lighter", false)));
        HelperServiceProvider.Credits first = provider.credits();
        assertThat(first.usable()).isTrue();
        assertThat(first.left()).isEqualTo(262);
        assertThat(link.calls.getFirst()).containsEntry("tool", HelperServiceProvider.CREDITS_TOOL);
        assertThat(((Map<String, Object>) link.calls.getFirst().get("args")).keySet()).containsExactly("callId");
        provider.credits();
        assertThat(link.calls).hasSize(1);
        clock.advance(Duration.ofSeconds(61));
        provider.credits();
        assertThat(link.calls).hasSize(2);
        // Off on the Platform, or no answer: none offered.
        link.answer = c -> Link.ok(Map.of("v", 1, "enabled", false));
        clock.advance(Duration.ofSeconds(61));
        assertThat(provider.credits()).isNull();
        // Used up with the lighter model's share left is still usable; with none, not.
        assertThat(new HelperServiceProvider.Credits(0, 0, 0, true, 5L).usable()).isTrue();
        assertThat(new HelperServiceProvider.Credits(0, 0, 0, true, 0L).usable()).isFalse();
        assertThat(new HelperServiceProvider.Credits(0, 0, 0, false, null).usable()).isFalse();
    }

    @Test
    void aLimitWithAResetHoldsUntilThenAndOneWithoutIsTriedAgainAMinuteLater() throws Exception {
        link.answer = c -> Link.refused("limit", Map.of("reason", "limit_lighter", "window", "day", "resetsAt",
                "2026-11-16T00:00:00.000Z"));
        assertThatThrownBy(() -> provider.chat(call(HelperServiceProvider.AUTO, "hi"), lease, d -> {}))
                .isInstanceOfSatisfying(ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.LIMIT);
                    assertThat(e.details().reason()).isEqualTo("limit_lighter");
                });
        assertThatThrownBy(() -> provider.chat(call(HelperServiceProvider.AUTO, "hi"), lease, d -> {}))
                .isInstanceOf(ProviderException.class);
        assertThat(link.calls).hasSize(1);
        clock.advance(Duration.ofHours(5));
        link.answer = c -> Link.refused("limit", Map.of("reason", "credits_used"));
        assertThatThrownBy(() -> provider.chat(call(HelperServiceProvider.AUTO, "hi"), lease, d -> {}))
                .isInstanceOf(ProviderException.class);
        assertThat(link.calls).hasSize(2);
        clock.advance(Duration.ofSeconds(30));
        assertThatThrownBy(() -> provider.chat(call(HelperServiceProvider.AUTO, "hi"), lease, d -> {}))
                .isInstanceOf(ProviderException.class);
        assertThat(link.calls).as("held for a minute").hasSize(2);
        clock.advance(Duration.ofSeconds(31));
        link.answer = c -> Link.ok(Map.of("v", 1, "text", "Topped up."));
        assertThat(provider.chat(call(HelperServiceProvider.AUTO, "hi"), lease, d -> {}).text()).isEqualTo("Topped up.");
    }

    @Test
    void refusalsAreTheKindARunEndsWithAndOnlyALostAnswerMayHaveBilled() {
        for (Object[] c : new Object[][] {{"forbidden", "self_hosted", ProviderException.Kind.FORBIDDEN, false},
                {"rate_limited", "in_flight", ProviderException.Kind.RATE_LIMITED, false},
                {"too_large", "input", ProviderException.Kind.TOO_LARGE, false},
                {"unavailable", "off", ProviderException.Kind.UNAVAILABLE, false},
                {"unavailable", "timeout", ProviderException.Kind.UNAVAILABLE, true}}) {
            link.answer = call -> Link.refused((String) c[0], Map.of("reason", c[1]));
            assertThatThrownBy(() -> provider.chat(call(HelperServiceProvider.AUTO, "hi"), lease, d -> {}))
                    .isInstanceOfSatisfying(ProviderException.class, e -> {
                        assertThat(e.kind()).isEqualTo(c[2]);
                        assertThat(e.mayHaveBilled()).isEqualTo(c[3]);
                    });
        }
        link.answer = call -> new DeskLink.Reply(false, null, null, null, List.of(), true);
        assertThatThrownBy(() -> provider.chat(call(HelperServiceProvider.AUTO, "hi"), lease, d -> {}))
                .isInstanceOfSatisfying(ProviderException.class, e -> assertThat(e.mayHaveBilled()).isTrue());
    }

    @Test
    void theContextIsCutAtALineAndTheOneModelIsMinimalistAlliancesPick() {
        String longContext = ("line of rules\n").repeat(10_000);
        ChatRequest req = new ChatRequest(HelperServiceProvider.AUTO, longContext, List.of(ChatMessage.user("hi")), 100);
        String context = (String) HelperServiceProvider.args(req, "id").get("context");
        assertThat(context.length()).isLessThanOrEqualTo(HelperServiceProvider.MAX_CONTEXT_CHARS);
        assertThat(context).endsWith("line of rules");
        assertThat(provider.models(lease)).extracting(m -> m.id()).containsExactly(HelperServiceProvider.AUTO);
        assertThat(provider.info().id()).isEqualTo(ProviderId.MA_CREDITS);
    }
}
