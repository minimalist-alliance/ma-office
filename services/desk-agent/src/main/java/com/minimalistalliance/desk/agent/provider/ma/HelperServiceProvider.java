package com.minimalistalliance.desk.agent.provider.ma;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.manager.RunIds;
import com.minimalistalliance.desk.agent.provider.Attachment;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatProvider;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.Cut;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ModelInfo;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ProviderInfo;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.http.Messages;
import com.minimalistalliance.desk.agent.tool.DeskLink;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Helpers on the member's MA credits: Minimalist Alliance as the provider of the member's own desk agents (the owner, Nov 15:
 * "we can continue to be a provider and just arbitrate with minimal overhead the best model that we find that can drive a
 * desk"; ma-platform {@code docs/contracts/desk-helpers.md}, ADR 0142). desk-agent can't reach the Platform, so each call is one
 * {@code helpers_model} {@code tcall} through deskd ({@link DeskLink}), which signs it as the desk role and relays it (deskd
 * {@code API.md} §24). The member's credits are read the same way ({@code helpers_credits}).
 *
 * <p><b>The desk sends the task and the helper's own instructions, never a model.</b> A helper bound to MA's credits has the
 * model {@link #AUTO}, sent as task {@code agent}; a small job ({@code SmallModels}: {@link #SMALL}) as task {@code small}. The
 * Platform picks the provider and model from its settings and meters the call in credits; its answer says what it cost in
 * credits and what's left, never money and never a model's name.
 *
 * <p><b>Not billed means not billed</b>, as {@link MaiaServiceProvider}: a refusal before the call is an exception that says so.
 * After a {@code 429 limit} with a reset, nothing more is tried until then; one with no reset (the credits are used up and the
 * tier has no lighter model) is tried again a minute later, since a top-up can come at any time.
 *
 * <p>Files: a file read to text goes fenced in the member's turn as every provider's does ({@link Messages#fenced}); a picture
 * becomes a line naming it (the contract takes no images yet). Nothing here logs the request or the answer.
 */
public final class HelperServiceProvider implements ChatProvider {

    /** The tools deskd answers. */
    public static final String TOOL = "helpers_model";
    public static final String CREDITS_TOOL = "helpers_credits";
    /** A helper's binding's model on MA's credits: the Platform picks. */
    public static final String AUTO = "auto";
    /** The small jobs' model on MA's credits (compaction summaries, Maia's note-taker on an agent's key). */
    public static final String SMALL = "small";

    static final Duration WAIT = Duration.ofSeconds(160);
    static final Duration CREDITS_WAIT = Duration.ofSeconds(20);
    /** A limit with no reset (credits used up, no lighter model) is tried again after this. */
    static final Duration RETRY_USED_UP = Duration.ofMinutes(1);
    /** How long a credits read is reused before asking again. */
    static final Duration CREDITS_FRESH = Duration.ofSeconds(60);
    static final int MAX_BODY_BYTES = 3 << 20;
    static final int MAX_CONTEXT_CHARS = 100_000;
    static final int MAX_TOOLS = 128;
    static final int MAX_DESCRIPTION_CHARS = 4_000;
    static final int MAX_OUTPUT = 16_000;

    private final Clock clock;
    private volatile DeskLink link = DeskLink.NONE;
    private volatile MaiaServiceProvider.Limit limit;
    private volatile Credits credits;
    private volatile Instant creditsAt;
    /** The member's one credits wallet, shared with Desk Maia (0.4.10): the newest answer's. */
    private volatile CreditsWallet wallet;

    /**
     * The member's MA credits as the service last said: whole credits, never money. {@code lighter}: they're used up and the
     * lighter model is answering, with {@code lighterLeft} of today's share left.
     */
    public record Credits(long left, long starting, long topUp, boolean lighter, Long lighterLeft) {

        /** Whether a helper on MA's credits can run now. */
        public boolean usable() {
            return left > 0 || (lighter && lighterLeft != null && lighterLeft > 0);
        }

        public Map<String, Object> view() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("left", left);
            m.put("starting", starting);
            m.put("topUp", topUp);
            m.put("lighter", lighter);
            if (lighterLeft != null) {
                m.put("lighterLeft", lighterLeft);
            }
            return m;
        }
    }

    public HelperServiceProvider(Clock clock) {
        this.clock = clock;
        this.wallet = new CreditsWallet(clock);
    }

    /** The member's one wallet, which Desk Maia's provider reports to as well. */
    public void wallet(CreditsWallet shared) {
        if (shared != null) {
            this.wallet = shared;
        }
    }

    /** deskd's link, once the agent socket is up. Until its hello offers helpers, every call is {@code no_service}. */
    public void link(DeskLink desk) {
        this.link = desk == null ? DeskLink.NONE : desk;
    }

    /** Whether deskd's hello on the connection now offered helpers on MA's credits. */
    public boolean offered() {
        return link.helpersModel();
    }

    @Override
    public ProviderInfo info() {
        // No console and no key prefix: no member ever makes a key for it, and agent.providers never lists it.
        return new ProviderInfo(ProviderId.MA_CREDITS, "minimalistalliance.com", "");
    }

    @Override
    public List<ModelInfo> models(KeyLease key) {
        return List.of(new ModelInfo(AUTO, "Picked by Minimalist Alliance"));
    }

    /** The credits the service said last (any answer, or a read), or null before any. */
    public Credits lastCredits() {
        return credits;
    }

    /**
     * The member's credits now: the last answer's while it's fresh, else a {@code helpers_credits} read through deskd, which
     * also makes the member's starting grant the first time any of their desks asks. Null when deskd doesn't offer helpers,
     * the service is off here, or the read failed: then MA's credits aren't offered.
     */
    public Credits credits() throws InterruptedException {
        Credits held = credits;
        Instant at = creditsAt;
        if (held != null && at != null && clock.instant().isBefore(at.plus(CREDITS_FRESH))) {
            return held;
        }
        DeskLink desk = link;
        if (!desk.helpersModel()) {
            return null;
        }
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("agentId", "helper");
        call.put("tool", CREDITS_TOOL);
        call.put("args", Map.of("callId", RunIds.next(clock).toString()));
        call.put("taint", List.of());
        DeskLink.Reply reply = desk.call(call, CREDITS_WAIT);
        if (!reply.ok() || reply.r() == null || !Boolean.TRUE.equals(reply.r().get("enabled"))) {
            return null;
        }
        Credits read = credits(reply.r().get("credits"));
        if (read != null) {
            remember(read);
            wallet.report(CreditsWallet.parse(reply.r().get("credits"), null, false, null, "helpers", clock.instant()));
        }
        return read;
    }

    private void remember(Credits c) {
        credits = c;
        creditsAt = clock.instant();
    }

    @Override
    public ChatResult chat(ChatRequest request, KeyLease key, DeltaSink sink) throws ProviderException {
        MaiaServiceProvider.Limit now = limit;
        if (now != null && clock.instant().isBefore(now.resetsAt())) {
            throw new ProviderException(ProviderException.Kind.LIMIT, false, now.details());
        }
        limit = null;
        DeskLink desk = link;
        if (!desk.helpersModel()) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false, details("no_service"));
        }
        Map<String, Object> args = args(request, RunIds.next(clock).toString());
        if (Json.bytes(args).length + 16 > MAX_BODY_BYTES) {
            throw new ProviderException(ProviderException.Kind.TOO_LARGE, false, details("body"));
        }
        Map<String, Object> call = new LinkedHashMap<>();
        // deskd can't tell desk-agent's agents apart: one word for any helper, never Desk Maia's.
        call.put("agentId", "helper");
        call.put("tool", TOOL);
        call.put("args", args);
        call.put("taint", List.of());
        DeskLink.Reply reply;
        try {
            reply = desk.call(call, WAIT);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ProviderException(ProviderException.Kind.CANCELLED, true);
        }
        if (!reply.ok()) {
            throw refusal(reply);
        }
        ChatResult answered = MaiaServiceProvider.result(reply.r());
        Credits left = credits(reply.r().get("credits"));
        if (left != null) {
            remember(left);
            // Contract 0.4.10: one wallet with Desk Maia's (an older answer, with no renewal, isn't a wallet view).
            wallet.report(CreditsWallet.parse(reply.r().get("credits"), null, false, null, "helpers", clock.instant()));
        }
        // Never a model's name (the service sends none) and never money: the cost is in credits on the Platform, and what
        // it drew goes to the agent's credits a day on this desk.
        ChatResult result = new ChatResult(answered.text(), answered.usage(), ProviderId.MA_CREDITS.id(),
                answered.stopReason(), answered.toolCalls(), null, answered.centiCredits());
        if (!result.text().isEmpty()) {
            sink.delta(result.text());
        }
        return result;
    }

    /** The task: {@code small} for the small jobs, else {@code agent}. */
    static String task(ChatRequest request) {
        return SMALL.equals(request.model()) ? "small" : "agent";
    }

    /** The contract's request fields, from desk-agent's request. */
    static Map<String, Object> args(ChatRequest request, String callId) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("task", task(request));
        args.put("callId", callId);
        args.put("context", context(request));
        args.put("messages", MaiaServiceProvider.messages(withFiles(request.messagesWithNote())));
        List<Map<String, Object>> tools = new ArrayList<>();
        for (ToolSpec tool : request.tools()) {
            if (tools.size() == MAX_TOOLS) {
                break;
            }
            Map<String, Object> t = new LinkedHashMap<>();
            t.put("name", tool.name());
            t.put("description", Cut.chars(tool.description(), MAX_DESCRIPTION_CHARS));
            t.put("inputSchema", tool.inputSchema());
            tools.add(t);
        }
        args.put("tools", tools);
        args.put("maxOutputTokens", Math.max(1, Math.min(MAX_OUTPUT, request.maxOutputTokens())));
        return args;
    }

    /** The helper's instructions, files notice included (its files' text goes in the thread), cut at a line to 100,000. */
    static String context(ChatRequest request) {
        String context = request.system().strip();
        if (context.length() <= MAX_CONTEXT_CHARS) {
            return context;
        }
        String cut = Cut.chars(context, MAX_CONTEXT_CHARS);
        int line = cut.lastIndexOf('\n');
        return line > MAX_CONTEXT_CHARS / 2 ? cut.substring(0, line) : cut;
    }

    /** The thread with each file as text in its turn: fenced when it was read to text, a line naming it when it's a picture. */
    static List<ChatMessage> withFiles(List<ChatMessage> thread) {
        List<ChatMessage> out = new ArrayList<>(thread.size());
        for (ChatMessage message : thread) {
            if (message.attachments().isEmpty()) {
                out.add(message);
                continue;
            }
            StringBuilder text = new StringBuilder(message.text());
            for (Attachment file : message.attachments()) {
                if (!text.isEmpty()) {
                    text.append("\n\n");
                }
                text.append(file.kind() == Attachment.Kind.TEXT ? Messages.fenced(file)
                        : "[Attached picture: " + MaiaServiceProvider.MaiaFileName.of(file.name())
                                + ". Pictures aren't read here; ask the member to describe it if it matters.]");
            }
            out.add(new ChatMessage(message.role(), text.toString(), message.toolCalls(), message.toolResults()));
        }
        return out;
    }

    /** The service's {@code credits}, or null when absent or out of its shape. */
    static Credits credits(Object raw) {
        if (!(raw instanceof Map<?, ?> c) || !(c.get("left") instanceof Number left)
                || !(c.get("starting") instanceof Number starting) || !(c.get("topUp") instanceof Number topUp)) {
            return null;
        }
        long l = Math.max(0, left.longValue());
        long s = Math.max(0, starting.longValue());
        long t = Math.max(0, topUp.longValue());
        boolean lighter = Boolean.TRUE.equals(c.get("lighter"));
        Long lighterLeft = c.get("lighterLeft") instanceof Number n ? Math.max(0, n.longValue()) : null;
        return new Credits(l, s, t, lighter, lighterLeft);
    }

    /** deskd's or the service's refusal as the kind a run ends with. */
    ProviderException refusal(DeskLink.Reply reply) {
        if (reply.lost()) {
            return new ProviderException(ProviderException.Kind.UNAVAILABLE, true, details("lost"));
        }
        Map<String, Object> d = reply.details();
        String reason = reply.reason() == null || reply.reason().equals(reply.code()) ? null : reply.reason();
        ProviderException.Details details = new ProviderException.Details(reason,
                d.get("window") instanceof String w ? w : null, d.get("resetsAt") instanceof String at ? at : null,
                d.get("retryAfterSec") instanceof Number n ? n.longValue() : null);
        String code = reply.code() == null ? "unavailable" : reply.code();
        return switch (code) {
            case "limit" -> {
                Instant resets = instant(details.resetsAt());
                // A reset to wait for, or a minute when there's none: a top-up can come at any time.
                Instant until = resets != null && resets.isAfter(clock.instant()) ? resets
                        : clock.instant().plus(RETRY_USED_UP);
                limit = new MaiaServiceProvider.Limit(details, until);
                // Used up: the next read of the credits asks again.
                creditsAt = null;
                yield new ProviderException(ProviderException.Kind.LIMIT, false, details);
            }
            case "rate_limited" -> new ProviderException(ProviderException.Kind.RATE_LIMITED, false, details);
            case "forbidden" -> new ProviderException(ProviderException.Kind.FORBIDDEN, false, details);
            case "bad_request" -> new ProviderException(ProviderException.Kind.BAD_REQUEST, false, details);
            case "too_large" -> new ProviderException(ProviderException.Kind.TOO_LARGE, false, details);
            case "unavailable" -> new ProviderException(ProviderException.Kind.UNAVAILABLE, "timeout".equals(reason),
                    details);
            default -> new ProviderException(ProviderException.Kind.UNAVAILABLE, false, details(code));
        };
    }

    private static Instant instant(String at) {
        if (at == null) {
            return null;
        }
        try {
            return Instant.parse(at);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static ProviderException.Details details(String reason) {
        return new ProviderException.Details(reason, null, null, null);
    }
}
