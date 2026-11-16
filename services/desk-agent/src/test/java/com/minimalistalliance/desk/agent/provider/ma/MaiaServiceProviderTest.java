package com.minimalistalliance.desk.agent.provider.ma;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.provider.Attachment;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.Role;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.tool.DeskLink;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/**
 * Desk Maia's provider on Minimalist Alliance's service (ma-platform desk-maia.md; deskd API.md §23, "Her model"): the
 * request as the contract's fields (the task, never a model; the context; messages joined and starting with the member;
 * files as lines; tools; the output cap; a UUIDv7 call id), the 200 back as a result streamed once, each refusal as the
 * kind a run ends with and whether it was billed, nothing tried again before a limit resets, and no call at all without
 * deskd's offer.
 */
@SuppressWarnings("unchecked")
class MaiaServiceProviderTest {

    private static final Instant NOW = Instant.parse("2026-11-14T20:00:00Z");

    /** deskd as a script: offers her model, records each call and answers it. */
    static final class Link implements DeskLink {
        final List<Map<String, Object>> calls = new CopyOnWriteArrayList<>();
        volatile boolean offers = true;
        volatile Function<Map<String, Object>, Reply> answer = call -> ok(Map.of("v", 1, "text", "On it."));

        @Override
        public Set<String> offered() {
            return Set.of();
        }

        @Override
        public boolean maiaModel() {
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
    private final MaiaServiceProvider provider = provider();
    private final KeyLease lease = new KeyRing((a, t, d) -> {}).lend(KeyRing.COMPANY);

    private MaiaServiceProvider provider() {
        MaiaServiceProvider p = new MaiaServiceProvider(clock);
        p.link(link);
        return p;
    }

    private static ChatRequest turn(String text) {
        return new ChatRequest("turn", "The member's home desk adds: Now: Saturday.", List.of(ChatMessage.user(text)),
                MaiaServiceProvider.OUTPUT_TOKENS);
    }

    private Map<String, Object> lastArgs() {
        return (Map<String, Object>) link.calls.getLast().get("args");
    }

    @Test
    void itIsMinimalistAlliancesOwnAndNeedsNoKey() {
        assertThat(provider.id()).isEqualTo(ProviderId.MA);
        assertThat(provider.info().keyPrefix()).isEmpty();
        assertThat(lease.provider()).isEqualTo(ProviderId.MA);
        assertThat(lease.bytes()).isEmpty();
    }

    @Test
    void aTurnSendsTheTaskTheContextAndTheThreadNeverAModel() throws Exception {
        List<String> streamed = new ArrayList<>();
        ChatResult result = provider.chat(turn("Compare three laptops"), lease, streamed::add);
        Map<String, Object> call = link.calls.getFirst();
        assertThat(call).containsEntry("tool", "maia_model").containsEntry("agentId", "maia");
        Map<String, Object> args = lastArgs();
        assertThat(args.keySet()).containsExactly("task", "callId", "context", "messages", "tools", "maxOutputTokens",
                "units");
        // Contract 0.4.8: every request asks for credits, so the answer carries no dollars (MC-M1).
        assertThat(args).containsEntry("units", "credits");
        assertThat(args).containsEntry("task", "turn")
                .containsEntry("context", "The member's home desk adds: Now: Saturday.")
                .containsEntry("maxOutputTokens", 4_000).containsEntry("tools", List.of());
        assertThat((String) args.get("callId")).matches("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
        assertThat((List<Object>) args.get("messages")).containsExactly(Map.of("role", "user", "text",
                "Compare three laptops"));
        assertThat(String.valueOf(args)).doesNotContain("claude").doesNotContain("model");
        assertThat(result.text()).isEqualTo("On it.");
        assertThat(streamed).containsExactly("On it.");
        assertThat(result.model()).isEqualTo("maia");
    }

    @Test
    void afterToolResultsItIsAStepAndTheThreadIsJoinedAsTheContractAsks() throws Exception {
        ToolSpec spec = new ToolSpec("desk_message", "Brief an agent", Map.of("type", "object", "properties", Map.of()));
        // What a Chat Completions provider kept for itself never goes to her service.
        ToolCall asked = new ToolCall("toolu_01", "desk_message", Map.of("desk", "d-work1", "text", "Compare"), false,
                List.of(Map.of("type", "reasoning", "encrypted_content", "opaque"), Map.of("type", "chat_extra",
                        "provider", "google", "extra_content", Map.of("google", Map.of("thought_signature", "s")))));
        List<ChatMessage> thread = List.of(
                ChatMessage.assistant("An old reply the window kept first."),
                ChatMessage.user("First"),
                ChatMessage.user("Second, in a row"),
                ChatMessage.toolCalls("Asking.", List.of(asked)),
                ChatMessage.toolResults(List.of(new ToolResult("toolu_01", "{\"answer\":\"three\"}", false))));
        provider.chat(new ChatRequest("turn", "ctx", thread, 4_000, List.of(spec)), lease, t -> {});
        Map<String, Object> args = lastArgs();
        assertThat(args).containsEntry("task", "step");
        List<Map<String, Object>> messages = (List<Map<String, Object>>) args.get("messages");
        assertThat(messages).extracting(m -> m.get("role")).containsExactly("user", "assistant", "user", "assistant",
                "user");
        assertThat(messages.get(0)).containsEntry("text", MaiaServiceProvider.NOT_SHOWN);
        assertThat(messages.get(2)).containsEntry("text", "First\n\nSecond, in a row");
        assertThat(messages.get(3)).containsEntry("text", "Asking.");
        assertThat((List<Map<String, Object>>) messages.get(3).get("toolCalls")).containsExactly(Map.of("id", "toolu_01",
                "name", "desk_message", "input", Map.of("desk", "d-work1", "text", "Compare"), "reasoning",
                List.of(Map.of("type", "reasoning", "encrypted_content", "opaque"))));
        assertThat((List<Map<String, Object>>) messages.get(4).get("toolResults")).containsExactly(Map.of("callId",
                "toolu_01", "content", "{\"answer\":\"three\"}", "error", false));
        assertThat((List<Map<String, Object>>) args.get("tools")).containsExactly(Map.of("name", "desk_message",
                "description", "Brief an agent", "inputSchema", Map.of("type", "object", "properties", Map.of())));
    }

    /**
     * The staging proof (Nov 15): a thinking block sent back after her service moved the note off the turn before it is
     * a 400 under Opus 5.5's preserved thinking, so no thinking block of any kind goes back; the Responses wire's
     * encrypted reasoning still does.
     */
    @Test
    void noThinkingBlockIsEverSentBackOnlyTheResponsesReasoning() throws Exception {
        Map<String, Object> thinking = Map.of("type", "thinking", "thinking", "", "signature", "sig", "m", "0123456789abcdef");
        Map<String, Object> redacted = Map.of("type", "redacted_thinking", "data", "opaque", "m", "0123456789abcdef");
        Map<String, Object> responses = Map.of("type", "reasoning", "encrypted_content", "opaque", "m", "fedcba9876543210");
        ToolCall first = new ToolCall("toolu_01", "todo_add", Map.of("title", "Tip"), false, List.of(thinking, redacted));
        ToolCall second = new ToolCall("toolu_02", "office_desks", Map.of(), false, List.of(responses, thinking,
                Map.of("type", "something_new")));
        List<ChatMessage> thread = List.of(ChatMessage.user("Put it on my to-do"),
                ChatMessage.toolCalls("", List.of(first, second)),
                ChatMessage.toolResults(List.of(new ToolResult("toolu_01", "Not allowed: source_unknown.", true),
                        new ToolResult("toolu_02", "[]", false))));
        provider.chat(new ChatRequest("turn", "ctx", thread, 4_000, List.of(), "Now: Sunday."), lease, t -> {});
        Map<String, Object> args = lastArgs();
        assertThat(args).containsEntry("task", "step");
        List<Map<String, Object>> calls = (List<Map<String, Object>>) ((List<Map<String, Object>>) args.get("messages"))
                .get(1).get("toolCalls");
        assertThat(calls.get(0)).doesNotContainKey("reasoning");
        assertThat(calls.get(1).get("reasoning")).isEqualTo(List.of(responses));
        assertThat(String.valueOf(args)).doesNotContain("thinking").doesNotContain("sig");
    }

    @Test
    void notesIsItsOwnTaskWithNoToolsAndFilesAreNeverSent() throws Exception {
        ToolSpec spec = new ToolSpec("office_desks", "Desks", Map.of("type", "object"));
        provider.chat(new ChatRequest("notes", "You take notes.", List.of(ChatMessage.user("Remember Friday")), 600,
                List.of(spec)), lease, t -> {});
        assertThat(lastArgs()).containsEntry("task", "notes").containsEntry("tools", List.of())
                .containsEntry("context", "You take notes.").containsEntry("maxOutputTokens", 600);

        Attachment file = Attachment.text("q4 report.pdf", "pdf", 1200, "SECRET FILE CONTENT", null);
        provider.chat(new ChatRequest("turn", "ctx", List.of(ChatMessage.user("Read this", List.of(file))), 99_999),
                lease, t -> {});
        Map<String, Object> args = lastArgs();
        assertThat(String.valueOf(args)).doesNotContain("SECRET FILE CONTENT").doesNotContain("<<<file");
        assertThat(args.get("context")).isEqualTo("ctx");
        assertThat((List<Map<String, Object>>) args.get("messages")).containsExactly(Map.of("role", "user", "text",
                "Read this\n[Attached: q4 report.pdf]"));
        // The output cap is the contract's at most.
        assertThat(args).containsEntry("maxOutputTokens", 16_000);
    }

    @Test
    void theAnswerIsHerResultWithItsToolCallsAndNeverADollarCost() throws Exception {
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "", "toolCalls", List.of(
                Map.of("id", "toolu_02", "name", "ask_member", "input", Map.of("choices", List.of("Yes", "No")),
                        "malformed", false, "reasoning", List.of()),
                Map.of("id", "toolu_03", "name", "office_desks", "input", Map.of(), "malformed", true),
                Map.of("id", "toolu_04", "name", "agent.approval.decide", "input", Map.of())),
                "stopReason", "tool_use", "usage", Map.of("inputTokens", 1520, "cachedInputTokens", 5100,
                        "cacheWriteTokens", 0, "outputTokens", 410, "reasoningTokens", 20),
                "costMicroUsd", 21384, "allowance", Map.of("fraction", 0.62, "resetsAt", "2026-11-15T07:00:00.000Z")));
        List<String> streamed = new ArrayList<>();
        ChatResult result = provider.chat(turn("hi"), lease, streamed::add);
        assertThat(streamed).isEmpty();
        assertThat(result.stopReason()).isEqualTo("tool_use");
        // costMicroUsd stays in the answer for older desks; this desk keeps no dollar figure of hers (contract 0.4.8).
        assertThat(result.providerMicroUsd()).isNull();
        assertThat(result.usage().inputTokens()).isEqualTo(1520);
        assertThat(result.usage().cachedInputTokens()).isEqualTo(5100);
        assertThat(result.usage().outputTokens()).isEqualTo(410);
        assertThat(result.usage().reasoningTokens()).isEqualTo(20);
        assertThat(result.toolCalls()).hasSize(3);
        assertThat(result.toolCalls().get(0).input()).containsEntry("choices", List.of("Yes", "No"));
        assertThat(result.toolCalls().get(1).malformed()).isTrue();
        // A made-up tool's call is kept for the run to refuse, and goes back as a stand-in name.
        assertThat(result.toolCalls().get(2).name()).isEqualTo("agent.approval.decide");
        List<ChatMessage> next = List.of(ChatMessage.user("hi"), ChatMessage.toolCalls("", result.toolCalls()),
                ChatMessage.toolResults(List.of(new ToolResult("toolu_02", "ok", false),
                        new ToolResult("toolu_03", "bad", true), new ToolResult("toolu_04", "no such tool", true))));
        provider.chat(new ChatRequest("turn", "ctx", next, 4_000), lease, t -> {});
        List<Map<String, Object>> sent = (List<Map<String, Object>>) ((List<Map<String, Object>>) lastArgs()
                .get("messages")).get(1).get("toolCalls");
        assertThat(sent).extracting(c -> c.get("name")).containsExactly("ask_member", "office_desks", "unknown_tool");
        // Odd numbers from the service never break the result.
        link.answer = call -> Link.ok(Map.of("text", "x", "usage", Map.of("inputTokens", -5, "outputTokens", 3,
                "reasoningTokens", 9), "costMicroUsd", -1));
        ChatResult odd = provider.chat(turn("hi"), lease, t -> {});
        assertThat(odd.usage().inputTokens()).isZero();
        assertThat(odd.usage().reasoningTokens()).isEqualTo(3);
        assertThat(odd.providerMicroUsd()).isNull();
        link.answer = call -> Link.ok(Map.of("text", 42));
        assertThatThrownBy(() -> provider.chat(turn("hi"), lease, t -> {})).isInstanceOf(ProviderException.class);
    }

    private ProviderException refusedWith(String code, Map<String, Object> details) {
        link.answer = call -> Link.refused(code, details);
        try {
            provider.chat(turn("hi"), lease, t -> {});
        } catch (ProviderException e) {
            return e;
        }
        throw new AssertionError(code + " wasn't refused");
    }

    @Test
    void eachRefusalEndsTheRunCleanlyAndSaysWhetherItWasBilled() {
        record Case(String code, Map<String, Object> details, ProviderException.Kind kind, boolean billed) {}
        for (Case c : List.of(
                new Case("rate_limited", Map.of("retryAfterSec", 12L), ProviderException.Kind.RATE_LIMITED, false),
                new Case("forbidden", Map.of("reason", "not_listed"), ProviderException.Kind.FORBIDDEN, false),
                new Case("bad_request", Map.of("reason", "task"), ProviderException.Kind.BAD_REQUEST, false),
                new Case("too_large", Map.of("reason", "input"), ProviderException.Kind.TOO_LARGE, false),
                new Case("unavailable", Map.of("reason", "provider"), ProviderException.Kind.UNAVAILABLE, false),
                new Case("unavailable", Map.of("reason", "timeout"), ProviderException.Kind.UNAVAILABLE, true),
                new Case("unauthenticated", Map.of("reason", "desk_auth"), ProviderException.Kind.UNAVAILABLE, false),
                new Case("desk_destroyed", Map.of(), ProviderException.Kind.UNAVAILABLE, false),
                new Case("something_new", Map.of(), ProviderException.Kind.UNAVAILABLE, false))) {
            ProviderException e = refusedWith(c.code(), c.details());
            assertThat(e.kind()).as(c.code()).isEqualTo(c.kind());
            assertThat(e.mayHaveBilled()).as(c.code() + " billed").isEqualTo(c.billed());
        }
        assertThat(refusedWith("forbidden", Map.of("reason", "not_listed")).details().reason()).isEqualTo("not_listed");
        assertThat(refusedWith("rate_limited", Map.of("retryAfterSec", 12L)).details().retryAfterSec()).isEqualTo(12L);
        // Sent and no answer: it may have been made.
        link.answer = call -> DeskLink.Reply.noAnswer();
        assertThatThrownBy(() -> provider.chat(turn("hi"), lease, t -> {})).isInstanceOfSatisfying(
                ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
                    assertThat(e.mayHaveBilled()).isTrue();
                });
        // Not sent: nothing happened.
        link.answer = call -> DeskLink.Reply.unavailable();
        assertThatThrownBy(() -> provider.chat(turn("hi"), lease, t -> {})).isInstanceOfSatisfying(
                ProviderException.class, e -> assertThat(e.mayHaveBilled()).isFalse());
    }

    @Test
    void aLimitSaysWhenItResetsAndNothingIsTriedUntilThen() throws Exception {
        ProviderException e = refusedWith("limit", Map.of("reason", "limit_personal", "window", "day", "resetsAt",
                "2026-11-15T07:00:00.000Z"));
        assertThat(e.kind()).isEqualTo(ProviderException.Kind.LIMIT);
        assertThat(e.mayHaveBilled()).isFalse();
        assertThat(e.details()).isEqualTo(new ProviderException.Details("limit_personal", "day",
                "2026-11-15T07:00:00.000Z", null));
        assertThat(provider.limit().resetsAt()).isEqualTo(Instant.parse("2026-11-15T07:00:00Z"));
        int sent = link.calls.size();
        link.answer = call -> Link.ok(Map.of("text", "should not be asked"));
        for (int i = 0; i < 3; i++) {
            assertThatThrownBy(() -> provider.chat(turn("again"), lease, t -> {})).isInstanceOfSatisfying(
                    ProviderException.class, again -> {
                        assertThat(again.kind()).isEqualTo(ProviderException.Kind.LIMIT);
                        assertThat(again.details().window()).isEqualTo("day");
                        assertThat(again.mayHaveBilled()).isFalse();
                    });
        }
        assertThat(link.calls).hasSize(sent);
        // Once it resets, calls go again.
        clock.set(Instant.parse("2026-11-15T07:00:01Z"));
        assertThat(provider.limit()).isNull();
        assertThat(provider.chat(turn("now"), lease, t -> {}).text()).isEqualTo("should not be asked");
        // A pool limit, and one with no reset, still refuse; the latter isn't held.
        assertThat(refusedWith("limit", Map.of("reason", "limit_pool", "resetsAt", "2026-11-16T00:00:00Z")).details()
                .reason()).isEqualTo("limit_pool");
        clock.set(Instant.parse("2026-11-16T00:00:01Z"));
        refusedWith("limit", Map.of("reason", "limit_trial"));
        assertThat(provider.limit()).isNull();
    }

    @Test
    void withoutDeskdsOfferOrWithTheGateClosedNothingGoes() {
        link.offers = false;
        assertThatThrownBy(() -> provider.chat(turn("hi"), lease, t -> {})).isInstanceOfSatisfying(
                ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.UNAVAILABLE);
                    assertThat(e.details().reason()).isEqualTo("no_service");
                    assertThat(e.mayHaveBilled()).isFalse();
                });
        link.offers = true;
        provider.gate(() -> "disclosure");
        assertThatThrownBy(() -> provider.chat(turn("hi"), lease, t -> {})).isInstanceOfSatisfying(
                ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.FORBIDDEN);
                    assertThat(e.details().reason()).isEqualTo("disclosure");
                });
        assertThat(link.calls).isEmpty();
        MaiaServiceProvider unlinked = new MaiaServiceProvider(clock);
        assertThat(unlinked.offered()).isFalse();
        assertThatThrownBy(() -> unlinked.chat(turn("hi"), lease, t -> {})).isInstanceOf(ProviderException.class);
    }

    @Test
    void tooMuchToSendIsRefusedHereAndTheContractsCapsHold() throws Exception {
        String big = "x".repeat(150_000);
        List<ChatMessage> thread = new ArrayList<>();
        for (int i = 0; i < 25; i++) {
            thread.add(ChatMessage.user(big));
            thread.add(ChatMessage.assistant(big));
        }
        thread.add(ChatMessage.user("last"));
        assertThatThrownBy(() -> provider.chat(new ChatRequest("turn", "ctx", thread, 4_000), lease, t -> {}))
                .isInstanceOfSatisfying(ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.TOO_LARGE);
                    assertThat(e.mayHaveBilled()).isFalse();
                });
        assertThat(link.calls).isEmpty();

        // At most 400 messages, the newest, starting with the member; text and context cut to the contract's sizes.
        List<ChatMessage> many = new ArrayList<>();
        for (int i = 0; i < 300; i++) {
            many.add(ChatMessage.user("u" + i));
            many.add(ChatMessage.assistant("a" + i));
        }
        many.add(ChatMessage.user("x".repeat(250_000)));
        String context = ("line\n").repeat(10_000);
        provider.chat(new ChatRequest("turn", context, many, 4_000), lease, t -> {});
        Map<String, Object> args = lastArgs();
        List<Map<String, Object>> messages = (List<Map<String, Object>>) args.get("messages");
        assertThat(messages).hasSizeLessThanOrEqualTo(400);
        assertThat(messages.getFirst()).containsEntry("role", "user");
        assertThat(((String) messages.getLast().get("text")).length()).isEqualTo(200_000);
        assertThat(((String) args.get("context")).length()).isLessThanOrEqualTo(32_000);
        assertThat(Json.bytes(args).length).isLessThan(3 << 20);
    }

    /**
     * Contract 0.4.6: the desk's lines that change on every call go as {@code note}, which the Platform sends after the
     * thread, outside every cached prefix. Sent as given, line breaks kept and other control characters spaced, cut to
     * 2,000 characters at a line, and left out when empty.
     */
    @Test
    void theNoteIsSentAsItIsCutToTheContractAndLeftOutWhenEmpty() throws Exception {
        String note = "Now: Saturday 14 November 2026, 1:00 PM in the member's time zone.\nBriefs left today: 58.";
        provider.chat(new ChatRequest("turn", "ctx", List.of(ChatMessage.user("hi")), 4_000, List.of(), note), lease,
                t -> {});
        Map<String, Object> args = lastArgs();
        assertThat(args.keySet()).containsExactly("task", "callId", "context", "messages", "tools", "maxOutputTokens",
                "units", "note");
        assertThat(args).containsEntry("note", note).containsEntry("context", "ctx");
        // Never folded into the thread or the context: the cached part stays as it was.
        assertThat(String.valueOf(args.get("messages"))).doesNotContain("Briefs left");
        // Line breaks kept; any other control character a space.
        assertThat(MaiaServiceProvider.note(new ChatRequest("turn", "", List.of(ChatMessage.user("x")), 1, List.of(),
                "a\tb\r\nc\u0007d\n"))).isEqualTo("a b\nc d");
        // At most 2,000 characters, cut at a line.
        String line = "x".repeat(99) + "\n";
        String cut = MaiaServiceProvider.note(new ChatRequest("turn", "", List.of(ChatMessage.user("x")), 1, List.of(),
                line.repeat(30)));
        assertThat(cut.length()).isLessThanOrEqualTo(2_000).isGreaterThan(1_800);
        assertThat(cut).doesNotEndWith("\n").endsWith("x".repeat(99));
        provider.chat(new ChatRequest("turn", "ctx", List.of(ChatMessage.user("hi")), 4_000, List.of(), line.repeat(30)),
                lease, t -> {});
        assertThat(((String) lastArgs().get("note")).length()).isLessThanOrEqualTo(2_000);
        // Empty or blank: no note field at all, as 0.4.4 sent it.
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(lastArgs()).doesNotContainKey("note");
        provider.chat(new ChatRequest("turn", "ctx", List.of(ChatMessage.user("hi")), 4_000, List.of(), " \n "), lease,
                t -> {});
        assertThat(lastArgs()).doesNotContainKey("note");
    }

    /** The answer's {@code allowance} is kept for her note until that window resets; an answer without one keeps it. */
    @Test
    void theAllowanceTheServiceReportedIsKeptUntilItResets() throws Exception {
        assertThat(provider.allowance()).isNull();
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "allowance", Map.of("fraction", 0.62, "resetsAt",
                "2026-11-15T00:00:00.000Z")));
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(provider.allowance()).isEqualTo(new MaiaServiceProvider.Allowance(0.62,
                Instant.parse("2026-11-15T00:00:00Z")));
        // Out of its shape or absent: the last one stands.
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "allowance", Map.of("fraction", 7, "resetsAt",
                "soon")));
        provider.chat(turn("hi"), lease, t -> {});
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok"));
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(provider.allowance().fraction()).isEqualTo(0.62);
        // Once that window resets, what's left is unknown until the next answer.
        clock.advance(Duration.ofHours(4));
        assertThat(provider.allowance()).isNull();
    }

    /**
     * Contract 0.4.8: the answer's {@code allowance.credits}, {@code drawingFrom} and {@code lighter} are kept for her note
     * and the room, with or without the credits; an older Platform's answer (none of them) is today's allowance.
     */
    @Test
    void theCreditsTheServiceReportedAreKeptAndTheirAbsenceIsTodaysAllowance() throws Exception {
        Map<String, Object> credits = new java.util.LinkedHashMap<>(Map.of("month", 2500, "monthLeft", 1550, "week",
                800, "weekUsed", 120, "day", 200, "dayUsed", 90, "topUpLeft", 0));
        credits.put("drawingFrom", "month");
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "costMicroUsd", 21384, "costCredits", 1.84,
                "allowance", Map.of("fraction", 0.62, "resetsAt", "2026-12-01T07:00:00Z", "credits", credits,
                        "lighter", false)));
        provider.chat(turn("hi"), lease, t -> {});
        MaiaServiceProvider.Allowance a = provider.allowance();
        assertThat(a.fraction()).isEqualTo(0.62);
        assertThat(a.resetsAt()).isEqualTo(Instant.parse("2026-12-01T07:00:00Z"));
        assertThat(a.lighter()).isFalse();
        assertThat(a.credits()).isEqualTo(new MaiaServiceProvider.Credits(2500, 1550, 800, 120, 200, 90, 0, "month"));
        // Each place it can draw from; a word this desk doesn't know is kept as none.
        for (String from : List.of("day", "week", "topUp")) {
            credits.put("drawingFrom", from);
            provider.chat(turn("hi"), lease, t -> {});
            assertThat(provider.allowance().credits().drawingFrom()).isEqualTo(from);
            assertThat(provider.allowance().lighter()).isFalse();
        }
        credits.put("drawingFrom", "somewhere");
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(provider.allowance().credits().drawingFrom()).isNull();
        // The lighter model: by the flag, or by drawingFrom alone.
        credits.put("drawingFrom", "lighter");
        credits.put("monthLeft", 0);
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(provider.allowance().lighter()).isTrue();
        assertThat(provider.allowance().credits().monthLeft()).isZero();
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "allowance", Map.of("fraction", 0, "resetsAt",
                "2026-12-01T07:00:00Z", "lighter", true)));
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(provider.allowance().lighter()).isTrue();
        assertThat(provider.allowance().credits()).isNull();
        // Credits out of their shape: none, and the share and reset still count.
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "allowance", Map.of("fraction", 0.4, "resetsAt",
                "2026-12-01T07:00:00Z", "credits", Map.of("month", "lots", "monthLeft", -3))));
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(provider.allowance().credits()).isNull();
        assertThat(provider.allowance().fraction()).isEqualTo(0.4);
        // An older Platform (before 0.4.8): none of the new fields, so today's allowance, no credits, not lighter.
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "costMicroUsd", 900, "allowance",
                Map.of("fraction", 0.9, "resetsAt", "2026-11-15T07:00:00Z")));
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(provider.allowance()).isEqualTo(new MaiaServiceProvider.Allowance(0.9,
                Instant.parse("2026-11-15T07:00:00Z")));
        assertThat(provider.allowance().credits()).isNull();
        assertThat(provider.allowance().lighter()).isFalse();
    }

    /** What each call drew in credits goes to the desk's count (hundredths); an older Platform's answer draws nothing. */
    @Test
    void eachAnswersCreditsAreCountedAndNeverItsDollars() throws Exception {
        // Every task asks for credits: her turns, her steps and the note-taker's notes.
        provider.chat(turn("hi"), lease, t -> {});
        provider.chat(new ChatRequest(MaiaServiceProvider.NOTES, "rules", List.of(ChatMessage.user("note")), 500), lease,
                t -> {});
        provider.chat(new ChatRequest("turn", "ctx", List.of(ChatMessage.user("hi"),
                ChatMessage.toolCalls("", List.of(new com.minimalistalliance.desk.agent.provider.ToolCall("t1",
                        "office_desks", Map.of()))), ChatMessage.toolResults(List.of(new ToolResult("t1", "{}",
                                false)))), 4_000), lease, t -> {});
        provider.chat(new ChatRequest(MaiaServiceProvider.READ, "rules", List.of(ChatMessage.user("read")), 500), lease,
                t -> {});
        assertThat(link.calls).extracting(c -> ((Map<String, Object>) c.get("args")).get("task"))
                .containsExactly("turn", "notes", "step", "read");
        assertThat(link.calls).allSatisfy(c -> assertThat((Map<String, Object>) c.get("args"))
                .containsEntry("units", "credits"));
        // An answer in credits has no costMicroUsd: nothing on the desk needs it.
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "no dollars", "costCredits", 2.5));
        ChatResult inCredits = provider.chat(turn("hi"), lease, t -> {});
        assertThat(inCredits.text()).isEqualTo("no dollars");
        assertThat(inCredits.providerMicroUsd()).isNull();
        List<Long> drew = new CopyOnWriteArrayList<>();
        provider.spent(drew::add);
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "costMicroUsd", 21384, "costCredits", 1.84));
        provider.chat(turn("hi"), lease, t -> {});
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "costCredits", 0.005));
        provider.chat(turn("hi"), lease, t -> {});
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "costCredits", 12));
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(drew).containsExactly(184L, 1L, 1200L);
        // Absent (an older Platform) or out of its shape: nothing counted.
        for (Object odd : List.of(-1, "1.84", Double.NaN, 5e12)) {
            link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "costMicroUsd", 900, "costCredits", odd));
            provider.chat(turn("hi"), lease, t -> {});
        }
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "ok", "costMicroUsd", 900));
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(drew).hasSize(3);
        // A refusal draws nothing.
        refusedWith("rate_limited", Map.of());
        assertThat(drew).hasSize(3);
        // A listener that throws never breaks the answer.
        provider.spent(c -> {
            throw new IllegalStateException("x");
        });
        link.answer = call -> Link.ok(Map.of("v", 1, "text", "still ok", "costCredits", 1));
        assertThat(provider.chat(turn("hi"), lease, t -> {}).text()).isEqualTo("still ok");
    }

    /**
     * The member's own day cap in credits: once reached, her turns and steps are refused {@code limit} with its details and
     * nothing is sent; the note-taker's small job isn't hers to cap. It's the desk's, never the service's limit.
     */
    @Test
    void theMembersOwnCapRefusesHerTurnsWithNothingSent() throws Exception {
        ProviderException.Details capped = new ProviderException.Details(MaiaServiceProvider.CAP, "day",
                "2026-11-15T00:00:00Z", null);
        java.util.concurrent.atomic.AtomicReference<ProviderException.Details> cap =
                new java.util.concurrent.atomic.AtomicReference<>(capped);
        provider.cap(cap::get);
        assertThatThrownBy(() -> provider.chat(turn("hi"), lease, t -> {}))
                .isInstanceOfSatisfying(ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.LIMIT);
                    assertThat(e.mayHaveBilled()).isFalse();
                    assertThat(e.details().reason()).isEqualTo("limit_cap");
                    assertThat(e.details().window()).isEqualTo("day");
                    assertThat(e.details().resetsAt()).isEqualTo("2026-11-15T00:00:00Z");
                });
        assertThat(link.calls).isEmpty();
        // It isn't the service's limit: nothing is held against the next call once the cap is lifted.
        assertThat(provider.limit()).isNull();
        // The small jobs go: the note-taker's and the reader's.
        provider.chat(new ChatRequest(MaiaServiceProvider.NOTES, "rules", List.of(ChatMessage.user("note")), 500),
                lease, t -> {});
        provider.chat(new ChatRequest(MaiaServiceProvider.READ, "rules", List.of(ChatMessage.user("read")), 500),
                lease, t -> {});
        assertThat(link.calls).hasSize(2);
        assertThat(link.calls).allSatisfy(c -> assertThat((Map<String, Object>) c.get("args"))
                .containsEntry("units", "credits"));
        cap.set(null);
        provider.chat(turn("hi"), lease, t -> {});
        assertThat(link.calls).hasSize(3);
    }

    @Test
    void theRequestTextNeverHoldsTheFilesNotice() {
        Attachment file = Attachment.text("a.txt", "txt", 3, "abc", null);
        ChatRequest request = new ChatRequest("turn", "ctx", List.of(ChatMessage.user("look", List.of(file))), 100);
        assertThat(request.system()).contains(ChatRequest.FILES_NOTICE);
        Map<String, Object> args = MaiaServiceProvider.args(request, "c");
        assertThat(args.get("context")).isEqualTo("ctx");
        assertThat(MaiaServiceProvider.task(new ChatRequest("anything", "", List.of(new ChatMessage(Role.USER, "x")),
                1))).isEqualTo("turn");
        Map<String, Object> copy = new LinkedHashMap<>(args);
        assertThat(copy).containsKey("callId");
    }
}
