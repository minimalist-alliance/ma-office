package com.minimalistalliance.desk.agent.testing;

import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.Role;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.tool.DeskLink;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Desk Maia's service for desk-agent's tests: deskd's {@code maia_model} relay and the Platform behind it in one, scripted
 * by a {@link FakeProvider}. Each call's {@code args} (the contract's request, 0.4.6) is read back into a {@link ChatRequest}
 * whose model is the task ({@code turn}, {@code step}, {@code notes}), whose system is the {@code context} and whose note is
 * the {@code note}, the scripted step answers it, and the answer goes back as the contract's 200 (0.4.8) with
 * {@code costMicroUsd} at a fixed rate, {@code costCredits} at {@link #MICRO_USD_PER_CREDIT} (the Platform's setting, which
 * no desk ever sees) and {@link #allowance} (by default a tier with Maia Mode credits); a scripted
 * failure goes back as the contract's refusal. The real relay is deskd's ({@code MaiaModelTest}) and the real socket path
 * is {@code RealDeskAgentMaiaIT}.
 */
public final class FakeMaiaService {

    /** µ$ a token, input and output, so a test can say what a call cost. */
    public static final long MICRO_PER_INPUT = 3;
    public static final long MICRO_PER_OUTPUT = 15;
    /** The credit's value in this stand-in: the Platform's setting, never sent to a desk. */
    public static final long MICRO_USD_PER_CREDIT = 100;

    /** The member's one wallet (contract 0.4.10): 2,250 of this month's 2,500 and 210 starting, within today's share. */
    public static final Map<String, Object> CREDITS = Map.of("fraction", 0.9, "resetsAt", "2026-12-01T07:00:00Z",
            "credits", Map.of("left", 2460, "month", 2500, "monthLeft", 2250, "week", 800, "weekUsed", 120, "day", 200,
                    "dayUsed", 90, "starting", 210, "topUpLeft", 0, "drawingFrom", "day"), "lighter", false);
    /** Desk Maia's own credits as contract 0.4.8 said them, before the one wallet: no {@code left}, no starting. */
    public static final Map<String, Object> CREDITS_048 = Map.of("fraction", 0.9, "resetsAt", "2026-12-01T07:00:00Z",
            "credits", Map.of("month", 2500, "monthLeft", 2250, "week", 800, "weekUsed", 120, "day", 200, "dayUsed",
                    90, "topUpLeft", 0, "drawingFrom", "day"), "lighter", false);
    /** A tier that shares its Maia allowance, or a Platform before 0.4.8: no credits. */
    public static final Map<String, Object> SHARED = Map.of("fraction", 0.9, "resetsAt", "2026-11-15T07:00:00.000Z");

    private final FakeProvider model;
    private final KeyLease lease = new KeyRing((action, target, decision) -> {}).lend(KeyRing.COMPANY);
    /** Every call's {@code args}, in order. */
    public final List<Map<String, Object>> calls = new CopyOnWriteArrayList<>();
    /** The next refusal to answer instead of calling the model ({@code {code, details}}), once. */
    public volatile Map<String, Object> refuseNext;
    /** Each answer's {@code allowance}. */
    public volatile Map<String, Object> allowance = CREDITS;
    /** Whether answers carry {@code costCredits} (false: a Platform before 0.4.8). */
    public volatile boolean credits = true;
    /**
     * The model binds its thinking to the conversation that made it (Opus 5.5's preserved thinking, enforced for the
     * company's account): a request that sends back a thinking block after anything before it changed (the context, the
     * tools, or an earlier message as her service builds it, the note included) is refused before any output with a 400,
     * which her service answers {@code unavailable} {@code provider}, as staging did on Nov 15. Each refusal's reason is
     * in {@link #bindingRefusals}.
     */
    public volatile boolean preservedThinking;
    /** Why each request was refused under {@link #preservedThinking}. */
    public final List<String> bindingRefusals = new CopyOnWriteArrayList<>();
    /** Each thinking block's signature, with the conversation that made it as her service sent it. */
    private final Map<String, String> bound = new java.util.concurrent.ConcurrentHashMap<>();

    public FakeMaiaService(FakeProvider model) {
        this.model = model;
    }

    /** One {@code maia_model} {@code tcall}. */
    @SuppressWarnings("unchecked")
    public DeskLink.Reply answer(Map<String, Object> call) {
        Map<String, Object> args = (Map<String, Object>) call.get("args");
        calls.add(args);
        Map<String, Object> refusal = refuseNext;
        if (refusal != null) {
            refuseNext = null;
            Map<String, Object> details = (Map<String, Object>) refusal.getOrDefault("details", Map.of());
            return new DeskLink.Reply(false, null, (String) refusal.get("code"),
                    details.get("reason") instanceof String r ? r : (String) refusal.get("code"), List.of(), false,
                    details);
        }
        if (preservedThinking) {
            String broken = brokenBinding(args);
            if (broken != null) {
                bindingRefusals.add(broken);
                return new DeskLink.Reply(false, null, "unavailable", "provider", List.of(), false,
                        Map.of("reason", "provider"));
            }
        }
        ChatRequest request = request(args);
        try {
            ChatResult result = model.chat(request, lease, text -> {});
            if (preservedThinking) {
                // The conversation this answer's thinking was made in: everything her service sent, the note included.
                String made = prefix(args, ((List<?>) args.get("messages")).size(), true);
                for (ToolCall c : result.toolCalls()) {
                    for (Map<String, Object> item : c.reasoning()) {
                        if (item.get("signature") instanceof String sig) {
                            bound.put(sig, made);
                        }
                    }
                }
            }
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("v", 1);
            r.put("text", result.text());
            List<Map<String, Object>> calls = new ArrayList<>();
            for (ToolCall c : result.toolCalls()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", c.id());
                m.put("name", c.name());
                m.put("input", c.input());
                m.put("malformed", c.malformed());
                m.put("reasoning", c.reasoning());
                calls.add(m);
            }
            r.put("toolCalls", calls);
            r.put("stopReason", result.stopReason());
            Map<String, Object> usage = new LinkedHashMap<>();
            usage.put("inputTokens", result.usage().inputTokens());
            usage.put("cachedInputTokens", result.usage().cachedInputTokens());
            usage.put("cacheWriteTokens", result.usage().cacheWriteTokens());
            usage.put("outputTokens", result.usage().outputTokens());
            usage.put("reasoningTokens", result.usage().reasoningTokens());
            r.put("usage", usage);
            long micro = result.usage().inputTokens() * MICRO_PER_INPUT + result.usage().outputTokens() * MICRO_PER_OUTPUT;
            // Asked in credits (0.4.8): no costMicroUsd, so the desk can't work out the credit's rate.
            if (!"credits".equals(args.get("units"))) {
                r.put("costMicroUsd", micro);
            }
            if (credits) {
                r.put("costCredits", costCredits(micro));
            }
            r.put("allowance", allowance);
            return new DeskLink.Reply(true, r, null, null, List.of());
        } catch (ProviderException e) {
            String code = switch (e.kind()) {
                case LIMIT -> "limit";
                case RATE_LIMITED -> "rate_limited";
                case BAD_REQUEST -> "bad_request";
                case TOO_LARGE -> "too_large";
                case FORBIDDEN -> "forbidden";
                default -> "unavailable";
            };
            return new DeskLink.Reply(false, null, code, code, List.of());
        }
    }

    /**
     * Under preserved thinking, why this request is refused, or null: a thinking block sent back whose conversation
     * before it isn't byte for byte the one it was made in, or one this service never made.
     */
    @SuppressWarnings("unchecked")
    private String brokenBinding(Map<String, Object> args) {
        List<Object> messages = (List<Object>) args.get("messages");
        for (int i = 0; i < messages.size(); i++) {
            Map<String, Object> m = (Map<String, Object>) messages.get(i);
            for (Object c : (List<Object>) m.getOrDefault("toolCalls", List.of())) {
                Object reasoning = ((Map<String, Object>) c).get("reasoning");
                if (!(reasoning instanceof List<?> items)) {
                    continue;
                }
                for (Object item : items) {
                    Map<String, Object> r = (Map<String, Object>) item;
                    if (!"thinking".equals(r.get("type")) && !"redacted_thinking".equals(r.get("type"))) {
                        continue;
                    }
                    String made = bound.get(String.valueOf(r.get("signature")));
                    if (made == null) {
                        return "messages." + i + ": a thinking block this service never made";
                    }
                    if (!made.equals(prefix(args, i, false))) {
                        return "messages." + i + ": a thinking block bound to a different conversation";
                    }
                }
            }
        }
        return null;
    }

    /**
     * The conversation before message {@code upTo} as her service sends it to the model (ma-platform {@code deskWire.ts}
     * and {@code model.ts}): the context, the tools, then each message's blocks (a user turn's tool results then its
     * text; an assistant turn's first call's thinking, its text, then each call), and with {@code withNote} the note as
     * the newest user turn's last block.
     */
    @SuppressWarnings("unchecked")
    private static String prefix(Map<String, Object> args, int upTo, boolean withNote) {
        List<Object> messages = (List<Object>) args.get("messages");
        List<Object> out = new ArrayList<>();
        out.add(Map.of("context", String.valueOf(args.get("context")), "tools", args.getOrDefault("tools", List.of())));
        for (int i = 0; i < upTo; i++) {
            Map<String, Object> m = (Map<String, Object>) messages.get(i);
            List<Object> blocks = new ArrayList<>();
            String text = m.get("text") instanceof String t ? t : "";
            if ("user".equals(m.get("role"))) {
                for (Object r : (List<Object>) m.getOrDefault("toolResults", List.of())) {
                    blocks.add(Map.of("tool_result", r));
                }
                if (!text.isEmpty()) {
                    blocks.add(Map.of("text", text));
                }
                if (withNote && i == upTo - 1 && args.get("note") instanceof String note && !note.isEmpty()) {
                    blocks.add(Map.of("text", "The home desk's note for this call:\n" + note));
                }
            } else {
                List<Object> calls = (List<Object>) m.getOrDefault("toolCalls", List.of());
                for (int k = 0; k < calls.size(); k++) {
                    Map<String, Object> c = (Map<String, Object>) calls.get(k);
                    if (k == 0 && c.get("reasoning") instanceof List<?> r) {
                        blocks.addAll(r);
                    }
                }
                if (!text.isEmpty()) {
                    blocks.add(Map.of("text", text));
                }
                for (int k = 0; k < calls.size(); k++) {
                    Map<String, Object> c = (Map<String, Object>) calls.get(k);
                    if (k > 0 && c.get("reasoning") instanceof List<?> r) {
                        blocks.addAll(r);
                    }
                    blocks.add(Map.of("tool_use", List.of(c.get("id"), c.get("name"), c.get("input"))));
                }
            }
            out.add(Map.of(String.valueOf(m.get("role")), blocks));
        }
        return new String(com.minimalistalliance.desk.agent.json.Json.bytes(out),
                java.nio.charset.StandardCharsets.UTF_8);
    }

    /** What a call that cost this many µ$ draws, in credits to 2 decimals, as the Platform rounds it. */
    public static double costCredits(long microUsd) {
        return Math.round(microUsd * 100.0 / MICRO_USD_PER_CREDIT) / 100.0;
    }

    /** The contract's request fields (desk-maia.md 0.4.8): anything else is the service's {@code 400 bad_request}. */
    public static final java.util.Set<String> FIELDS = java.util.Set.of("task", "callId", "context", "messages", "tools",
            "maxOutputTokens", "units", "note");

    /**
     * The contract's request read back as desk-agent's: model the task, system the context, note the note. A field out of
     * the contract, or a note out of its shape (a string of at most 2,000 characters, no control character but a line
     * break), fails the test, as the service would refuse it.
     */
    @SuppressWarnings("unchecked")
    public static ChatRequest request(Map<String, Object> args) {
        for (String field : args.keySet()) {
            if (!FIELDS.contains(field)) {
                throw new AssertionError("not a field of the contract: " + field);
            }
        }
        if (args.containsKey("units") && !"credits".equals(args.get("units"))) {
            throw new AssertionError("units: the service's 400 units");
        }
        Object note = args.get("note");
        if (note != null && (!(note instanceof String n) || n.length() > 2_000
                || n.chars().anyMatch(c -> c != '\n' && (c < 0x20 || c == 0x7f)))) {
            throw new AssertionError("a note out of its shape");
        }
        List<ChatMessage> messages = new ArrayList<>();
        for (Object o : (List<Object>) args.get("messages")) {
            Map<String, Object> m = (Map<String, Object>) o;
            Role role = "user".equals(m.get("role")) ? Role.USER : Role.ASSISTANT;
            List<ToolCall> calls = new ArrayList<>();
            for (Object c : (List<Object>) m.getOrDefault("toolCalls", List.of())) {
                Map<String, Object> call = (Map<String, Object>) c;
                calls.add(new ToolCall((String) call.get("id"), (String) call.get("name"),
                        (Map<String, Object>) call.get("input")));
            }
            List<ToolResult> results = new ArrayList<>();
            for (Object r : (List<Object>) m.getOrDefault("toolResults", List.of())) {
                Map<String, Object> result = (Map<String, Object>) r;
                results.add(new ToolResult((String) result.get("callId"), (String) result.get("content"),
                        Boolean.TRUE.equals(result.get("error"))));
            }
            messages.add(new ChatMessage(role, (String) m.get("text"), calls, results));
        }
        List<ToolSpec> tools = new ArrayList<>();
        for (Object o : (List<Object>) args.getOrDefault("tools", List.of())) {
            Map<String, Object> t = (Map<String, Object>) o;
            tools.add(new ToolSpec((String) t.get("name"), (String) t.get("description"),
                    (Map<String, Object>) t.get("inputSchema")));
        }
        return new ChatRequest((String) args.get("task"), (String) args.get("context"), messages,
                ((Number) args.get("maxOutputTokens")).intValue(), tools, (String) note);
    }
}
