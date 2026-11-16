package com.minimalistalliance.desk.agent.provider.ma;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.maia.Restated;
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
import com.minimalistalliance.desk.agent.provider.Role;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.tool.DeskLink;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Desk Maia's only provider: Minimalist Alliance's own AI service (the owner, Nov 14: "Maia ALWAYS runs on the company
 * account"; ma-platform {@code docs/contracts/desk-maia.md}). desk-agent can't reach the Platform, so each call is one
 * {@code maia_model} {@code tcall} through deskd ({@link DeskLink}), which signs it as the desk role and relays it (deskd
 * {@code API.md} §23, "Her model").
 *
 * <p><b>The desk sends the task and the context, never a model.</b> The request's model is the task: her binding's
 * {@code turn} (sent as {@code step} when the thread's last turn carries tool results) or the small jobs' {@code notes}.
 * The system text goes as {@code context}; the Platform puts its own instructions for the task before it and picks the
 * provider, the model and every optimization. The request's note (the lines that change on every call: the time, briefs
 * left, her allowance) goes as {@code note}, which the Platform puts after the thread, outside every cached prefix, so the
 * context stays byte-stable across a session and the provider's cache holds it (contract 0.4.6). Files are never sent:
 * each becomes a line naming it.
 *
 * <p><b>Not billed means not billed.</b> A refusal before the call ({@code limit}, {@code rate_limited}, {@code forbidden},
 * {@code bad_request}, {@code too_large}, and {@code unavailable} but deskd's timeout) is an exception that says nothing
 * was billed, so the desk's ledger releases its reservation. After a {@code 429 limit} nothing more is tried until the
 * limit resets: each call until then is refused here, with the same details, with nothing sent.
 *
 * <p><b>Credits, never money (contract 0.4.8, the owner's decisions of Nov 15).</b> Her calls are Minimalist Alliance's:
 * every request asks for credits ({@code units: "credits"}), so the answer carries no {@code costMicroUsd} and the desk
 * can't work out the credit's rate (Security's MC-M1); one that still came would never be kept. Nothing of hers counts
 * on the member's own-key limits or shows as a dollar figure. Her spend is what each call drew in credits
 * ({@code costCredits}), handed to {@link #spent}; her allowance ({@link Allowance}) carries the member's credits, where
 * they're drawing from, and whether she's on the lighter model, when the Platform sends them. A member's own day cap in
 * credits ({@link #cap}) refuses her turns once reached, as a {@code limit} with reason {@link #CAP}.
 *
 * <p>No key: the gateway lends the company "key" ({@code KeyRing.COMPANY}) as an empty lease, which this never reads.
 * Nothing here logs the request or the answer.
 */
public final class MaiaServiceProvider implements ChatProvider {

    private static final Logger log = LoggerFactory.getLogger(MaiaServiceProvider.class);

    /** The tool deskd answers. */
    public static final String TOOL = "maia_model";
    /** Her first call of a run: the member's message, planning. Her binding's model. */
    public static final String TURN = "turn";
    /** A later call of the same run, after tool results. */
    public static final String STEP = "step";
    /** The note-taker's small job, with no tools. */
    public static final String NOTES = "notes";
    /** Her reader's small job (Maia Mode Phase 2): facts out of what exists, with no tools. */
    public static final String READ = "read";
    /** What every request asks its answer's cost in (contract 0.4.8 {@code units}): credits, never dollars. */
    public static final String UNITS = "credits";
    /** Her binding's output cap: the Platform caps it at the task's own setting anyway (4,000 by default). */
    public static final int OUTPUT_TOKENS = 4_000;

    /** The longest deskd may take: its own 150 s to the service, and the socket both ways. */
    static final Duration WAIT = Duration.ofSeconds(160);
    /** The contract's caps (desk-maia.md, the request's table). */
    static final int MAX_BODY_BYTES = 3 << 20;
    static final int MAX_CONTEXT_CHARS = 32_000;
    static final int MAX_NOTE_CHARS = 2_000;
    static final int MAX_MESSAGES = 400;
    static final int MAX_TEXT_CHARS = 200_000;
    static final int MAX_TOOLS = 32;
    static final int MAX_DESCRIPTION_CHARS = 4_000;
    static final int MAX_CALL_ID_CHARS = 128;
    static final int MAX_OUTPUT = 16_000;
    /** What a tool's name looks like, as every provider takes it. */
    private static final java.util.regex.Pattern TOOL_NAME = java.util.regex.Pattern.compile("[A-Za-z0-9_-]{1,64}");
    /** Where an answer's credits came from (contract 0.4.8 {@code allowance.credits.drawingFrom}). */
    public static final java.util.Set<String> DRAWING = java.util.Set.of("day", "week", "month", "starting", "topUp",
            "lighter", "none");
    /** The refusal's reason when the member's own day cap in credits is reached (the desk's, never the service's). */
    public static final String CAP = "limit_cap";
    /** The most credits one number may say: past it, the answer is out of its shape. */
    static final long MAX_CREDITS = 1_000_000_000L;
    /** The name sent for a call the model made to a tool that doesn't exist (its result already said so). */
    static final String UNKNOWN_TOOL = "unknown_tool";
    /** What stands in for the part of a thread that isn't sent, so it starts with the member's turn as the contract asks. */
    static final String NOT_SHOWN = "[The earlier part of this conversation isn't shown here.]";

    private final Clock clock;
    private volatile DeskLink link = DeskLink.NONE;
    /** Whether a call may go now: null, or a word for why not (the desk holds only an older disclosure). */
    private volatile Supplier<String> gate = () -> null;
    /** The last {@code 429 limit}, until it resets: nothing is sent before then. */
    private volatile Limit limit;
    /** The member's closest Maia window as the last answer said it, until it resets. */
    private volatile Allowance allowance;
    /** The member's one credits wallet, shared with their agents on MA's credits (0.4.10): the newest answer's. */
    private volatile CreditsWallet wallet;
    /** What each answered call drew, in hundredths of a credit. */
    private volatile java.util.function.LongConsumer spent = centi -> {};
    /** The member's own day cap in credits: details to refuse her turn with, or null. Never asked for {@code notes}. */
    private volatile Supplier<ProviderException.Details> cap = () -> null;

    /** The allowance used up, as the service said it, and when it resets. */
    public record Limit(ProviderException.Details details, Instant resetsAt) {}

    /**
     * The member's Maia credits after a call (contract 0.4.8 {@code allowance.credits}), whole credits: the month's amount
     * and what's left of it, the week's and the day's amounts and what's used of them (they pace, never lock), top-up
     * credits left, and where this answer drew from ({@link #DRAWING}, or null for a word this desk doesn't know).
     */
    public record Credits(long month, long monthLeft, long week, long weekUsed, long day, long dayUsed, long topUpLeft,
            String drawingFrom) {}

    /**
     * The member's Maia allowance after a call, as the service's answer said it: the share left (0 to 1, never money) and
     * when it resets (with credits: the month's share and its renewal); the credits, null for a tier that shares its Maia
     * allowance or an older Platform; and whether this answer came from the lighter model because the month's credits and
     * top-ups are used up.
     */
    public record Allowance(double fraction, Instant resetsAt, Credits credits, boolean lighter) {
        public Allowance(double fraction, Instant resetsAt) {
            this(fraction, resetsAt, null, false);
        }
    }

    public MaiaServiceProvider(Clock clock) {
        this.clock = clock;
        this.wallet = new CreditsWallet(clock);
    }

    /** The member's one wallet, which her agents' provider reports to as well. */
    public void wallet(CreditsWallet shared) {
        if (shared != null) {
            this.wallet = shared;
        }
    }

    /** The member's one wallet: the newest from her answers or her agents', or null before any and once it renewed. */
    public CreditsWallet.View walletView() {
        return wallet.latest();
    }

    /** deskd's link, once the agent socket is up. Until its hello offers her model, every call is {@code no_service}. */
    public void link(DeskLink desk) {
        this.link = desk == null ? DeskLink.NONE : desk;
    }

    /** Whether deskd's hello on the connection now offered her model. */
    public boolean offered() {
        return link.maiaModel();
    }

    /** Asked before each call: a word refuses it {@code forbidden} with that reason, and nothing is sent. */
    public void gate(Supplier<String> refusal) {
        this.gate = refusal == null ? () -> null : refusal;
    }

    /** Told what each answered call drew, in hundredths of a credit ({@code costCredits}); never with an older Platform. */
    public void spent(java.util.function.LongConsumer listener) {
        this.spent = listener == null ? centi -> {} : listener;
    }

    /**
     * Asked before each of her turns and steps (never the small jobs: the note-taker's {@code notes}, the reader's
     * {@code read}): details refuse it {@code limit}, with nothing sent. The member's own day cap in credits, reached.
     */
    public void cap(Supplier<ProviderException.Details> refusal) {
        this.cap = refusal == null ? () -> null : refusal;
    }

    /**
     * The allowance her service last reported ({@code allowance} in its 200), or null before any answer and once that
     * window has reset (what's left then is unknown until the next answer).
     */
    public Allowance allowance() {
        Allowance now = allowance;
        if (now != null && !clock.instant().isBefore(now.resetsAt())) {
            allowance = null;
            return null;
        }
        return now;
    }

    /** The allowance limit in force now, or null: what the room's line says, and why nothing is sent until it resets. */
    public Limit limit() {
        Limit now = limit;
        if (now != null && !clock.instant().isBefore(now.resetsAt())) {
            limit = null;
            return null;
        }
        return now;
    }

    @Override
    public ProviderInfo info() {
        // No console and no key prefix: no member ever makes a key for it, and agent.providers never lists it.
        return new ProviderInfo(ProviderId.MA, "minimalistalliance.com", "");
    }

    @Override
    public List<ModelInfo> models(KeyLease key) {
        return List.of(new ModelInfo(TURN, "Maia"));
    }

    @Override
    public ChatResult chat(ChatRequest request, KeyLease key, DeltaSink sink) throws ProviderException {
        String refused = gate.get();
        if (refused != null) {
            throw new ProviderException(ProviderException.Kind.FORBIDDEN, false, details(refused));
        }
        Limit now = limit();
        if (now != null) {
            // The service said no call until it resets: tried again here, nothing is sent and nothing is spent.
            throw new ProviderException(ProviderException.Kind.LIMIT, false, now.details());
        }
        if (!NOTES.equals(request.model()) && !READ.equals(request.model())) {
            // The member's own cap is on her turns and steps; her small jobs (the note-taker's, the reader's) go on.
            ProviderException.Details capped = cap.get();
            if (capped != null) {
                // The member's own day cap in credits: nothing is sent, and nothing is spent.
                throw new ProviderException(ProviderException.Kind.LIMIT, false, capped);
            }
        }
        DeskLink desk = link;
        if (!desk.maiaModel()) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, false, details("no_service"));
        }
        Map<String, Object> args = args(request, RunIds.next(clock).toString());
        if (Json.bytes(args).length + 16 > MAX_BODY_BYTES) {
            throw new ProviderException(ProviderException.Kind.TOO_LARGE, false, details("body"));
        }
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("agentId", "maia");
        call.put("tool", TOOL);
        call.put("args", args);
        call.put("taint", List.of());
        DeskLink.Reply reply;
        try {
            reply = desk.call(call, WAIT);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            // It may have gone out: what it cost stays counted.
            throw new ProviderException(ProviderException.Kind.CANCELLED, true);
        }
        if (!reply.ok()) {
            throw refusal(reply);
        }
        ChatResult result = result(reply.r());
        Allowance left = allowance(reply.r());
        if (left != null) {
            allowance = left;
            // Contract 0.4.10: her credits are the member's one wallet (left, starting, the month's), shared with their
            // agents on MA's credits. An older answer (no left) isn't a wallet view.
            if (reply.r().get("allowance") instanceof Map<?, ?> a) {
                wallet.report(CreditsWallet.parse(a.get("credits"), left.resetsAt(), left.lighter(),
                        a.get("lighterLeft") instanceof Number n ? CreditsWallet.whole(n) : null, "maia",
                        clock.instant()));
            }
        }
        Long drew = centiCredits(reply.r());
        if (drew != null) {
            try {
                spent.accept(drew);
            } catch (RuntimeException e) {
                // Counting it is the desk's; the answer stands.
            }
        }
        if (STEP.equals(args.get("task")) && !result.text().isEmpty()) {
            // Her restatement guard (the owner's doubled welcome, Nov 15): a call after a tool adds only what's new in
            // this run, before anything of it is shown, since this service answers a step whole.
            String fresh = Restated.fresh(saidThisRun(request.messages()), result.text());
            if (!fresh.equals(result.text())) {
                log.info("her step repeated what she'd said in this run: {} of {} characters kept", fresh.length(),
                        result.text().length());
                result = result.withText(fresh);
            }
        }
        boolean hers = TURN.equals(args.get("task")) || STEP.equals(args.get("task"));
        if (hers && !result.text().isEmpty() && result.text().contains(Restated.MORE)) {
            // Her longer part never says her short reply again (the owner, Nov 15); her own replies only, never a small
            // job's answer (the note-taker's, the reader's: Security's MV-L2).
            String kept = Restated.withMore(result.text());
            if (!kept.equals(result.text())) {
                result = result.withText(kept);
            }
        }
        if (!result.text().isEmpty()) {
            sink.delta(result.text());
        }
        return result;
    }

    /** Her words so far in this run: her turns' text after the member's last message (tool results aren't theirs). */
    static String saidThisRun(List<ChatMessage> messages) {
        StringBuilder out = new StringBuilder();
        for (int i = messages.size() - 1; i >= 0; i--) {
            ChatMessage m = messages.get(i);
            if (m.role() == Role.USER && m.toolResults().isEmpty()) {
                break;
            }
            if (m.role() == Role.ASSISTANT && !m.text().isBlank()) {
                out.insert(0, m.text() + "\n\n");
            }
        }
        return out.toString();
    }

    // ---------------------------------------------------------------- the request

    /** The task this request is: {@code notes} for the small jobs, else {@code turn}, or {@code step} after tool results. */
    static String task(ChatRequest request) {
        if (NOTES.equals(request.model())) {
            return NOTES;
        }
        if (READ.equals(request.model())) {
            return READ;
        }
        ChatMessage last = request.messages().getLast();
        return last.toolResults().isEmpty() ? TURN : STEP;
    }

    /** The contract's request fields, from desk-agent's request. */
    static Map<String, Object> args(ChatRequest request, String callId) {
        String task = task(request);
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("task", task);
        args.put("callId", callId);
        args.put("context", context(request));
        args.put("messages", messages(request.messages()));
        List<Map<String, Object>> tools = new ArrayList<>();
        if (!NOTES.equals(task) && !READ.equals(task)) {
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
        }
        args.put("tools", tools);
        args.put("maxOutputTokens", Math.max(1, Math.min(MAX_OUTPUT, request.maxOutputTokens())));
        // Every task alike (turn, step, notes, read): the answer's cost in credits, and no costMicroUsd (0.4.8, MC-M1).
        args.put("units", UNITS);
        String note = note(request);
        if (!note.isEmpty()) {
            args.put("note", note);
        }
        return args;
    }

    /**
     * The request's note, as the contract takes it: line breaks kept, any other control character a space, at most 2,000
     * characters (past that, cut at a line). Empty when there's none, and then it isn't sent.
     */
    static String note(ChatRequest request) {
        String note = request.note().replace("\r\n", "\n").replaceAll("[\\p{Cntrl}&&[^\n]]", " ").strip();
        if (note.length() <= MAX_NOTE_CHARS) {
            return note;
        }
        String cut = Cut.chars(note, MAX_NOTE_CHARS);
        int line = cut.lastIndexOf('\n');
        return line > MAX_NOTE_CHARS / 2 ? cut.substring(0, line) : cut;
    }

    /**
     * The system text, the desk's dynamic part. Files are never sent, so the files notice goes too. At most the contract's
     * 32,000 characters: past that, cut at a line.
     */
    static String context(ChatRequest request) {
        String context = request.system().replace("\n\n" + ChatRequest.FILES_NOTICE, "")
                .replace(ChatRequest.FILES_NOTICE, "").strip();
        if (context.length() <= MAX_CONTEXT_CHARS) {
            return context;
        }
        String cut = Cut.chars(context, MAX_CONTEXT_CHARS);
        int line = cut.lastIndexOf('\n');
        return line > MAX_CONTEXT_CHARS / 2 ? cut.substring(0, line) : cut;
    }

    /**
     * The thread as the contract's messages: same-role turns joined (text by a blank line, their calls and results in
     * order), starting and ending with the member's turn, at most 400. A file becomes a line naming it.
     */
    static List<Map<String, Object>> messages(List<ChatMessage> thread) {
        List<Map<String, Object>> turns = new ArrayList<>();
        Role last = null;
        for (ChatMessage message : thread) {
            Map<String, Object> turn;
            if (message.role() == last) {
                turn = turns.getLast();
            } else {
                turn = new LinkedHashMap<>();
                turn.put("role", message.role() == Role.USER ? "user" : "assistant");
                turn.put("text", "");
                turns.add(turn);
                last = message.role();
            }
            String text = message.text();
            for (Attachment file : message.attachments()) {
                text = text + (text.isEmpty() ? "" : "\n") + "[Attached: " + MaiaFileName.of(file.name()) + "]";
            }
            if (!text.isEmpty()) {
                String before = (String) turn.get("text");
                turn.put("text", before.isEmpty() ? text : before + "\n\n" + text);
            }
            if (!message.toolCalls().isEmpty()) {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> calls = (List<Map<String, Object>>) turn.computeIfAbsent("toolCalls",
                        k -> new ArrayList<Map<String, Object>>());
                for (ToolCall call : message.toolCalls()) {
                    Map<String, Object> c = new LinkedHashMap<>();
                    c.put("id", Cut.chars(call.id(), MAX_CALL_ID_CHARS));
                    // The contract takes a tool's name; one the model made up (and the run refused) goes as a stand-in.
                    c.put("name", TOOL_NAME.matcher(call.name()).matches() ? call.name() : UNKNOWN_TOOL);
                    c.put("input", call.input());
                    // Never what a Chat Completions provider kept for itself (Gemini's signature, Moonshot's reasoning),
                    // and never a thinking block (replayable).
                    List<Map<String, Object>> reasoning = replayable(call);
                    if (!reasoning.isEmpty()) {
                        c.put("reasoning", reasoning);
                    }
                    calls.add(c);
                }
            }
            if (!message.toolResults().isEmpty()) {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> results = (List<Map<String, Object>>) turn.computeIfAbsent("toolResults",
                        k -> new ArrayList<Map<String, Object>>());
                for (ToolResult result : message.toolResults()) {
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("callId", Cut.chars(result.callId(), MAX_CALL_ID_CHARS));
                    r.put("content", Cut.chars(result.content(), MAX_TEXT_CHARS));
                    r.put("error", result.error());
                    results.add(r);
                }
            }
        }
        for (Map<String, Object> turn : turns) {
            turn.put("text", Cut.chars((String) turn.get("text"), MAX_TEXT_CHARS));
        }
        // At most 400, the newest kept; and it starts with the member's turn.
        if (turns.size() > MAX_MESSAGES) {
            turns = new ArrayList<>(turns.subList(turns.size() - (MAX_MESSAGES - 1), turns.size()));
        }
        if (!turns.isEmpty() && !"user".equals(turns.getFirst().get("role"))) {
            if (turns.size() == MAX_MESSAGES) {
                turns.removeFirst();
            }
            if (!"user".equals(turns.getFirst().get("role"))) {
                Map<String, Object> lead = new LinkedHashMap<>();
                lead.put("role", "user");
                lead.put("text", NOT_SHOWN);
                turns.addFirst(lead);
            }
        }
        // A turn with nothing in it (a reply that streamed only spaces) still says something.
        for (Map<String, Object> turn : turns) {
            if (((String) turn.get("text")).isBlank() && !turn.containsKey("toolCalls") && !turn.containsKey("toolResults")) {
                turn.put("text", "user".equals(turn.get("role")) ? "(no text)" : "(no reply)");
            }
        }
        return turns;
    }

    /**
     * The reasoning items sent back ahead of a call: only the Responses wire's encrypted {@code reasoning}, never
     * Anthropic's {@code thinking} or {@code redacted_thinking} (the staging proof, Nov 15). Her service puts the request's
     * note after the newest turn on the member's side, and the next call's note moves to the next one, so every turn a
     * thinking block followed has changed by the time it's sent back. A model that binds its thinking to the conversation
     * that made it (Opus 5.5's preserved thinking, enforced for accounts made from Aug 31, 2026, as the company's is)
     * refuses that whole request with a 400, before any output, which her service answers {@code unavailable}
     * ({@code provider}): every step after one in which she thought failed (8 of 8 on staging; the 7 after a step without thinking all went through), so she couldn't finish
     * after a brief, a refusal or a report. With no thinking block there's nothing to check; the model thinks afresh
     * each step, the cache is unchanged, and desk-agent's own Anthropic adapter has never sent thinking back either.
     */
    static List<Map<String, Object>> replayable(ToolCall call) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> item : com.minimalistalliance.desk.agent.provider.http.Messages.responsesReasoning(call)) {
            if ("reasoning".equals(item.get("type"))) {
                out.add(item);
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- the answer

    /**
     * The 200's body as desk-agent's result: never a model's name (the service never sends one), and never her cost in
     * dollars: her calls are Minimalist Alliance's, so the desk keeps no {@code costMicroUsd} (contract 0.4.8; her spend is
     * {@link #centiCredits}).
     */
    static ChatResult result(Map<String, Object> r) throws ProviderException {
        Object rawText = r.get("text");
        String text = rawText == null ? "" : rawText instanceof String s ? s : null;
        if (text == null) {
            throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true, details("response"));
        }
        List<ToolCall> calls = new ArrayList<>();
        if (r.get("toolCalls") instanceof List<?> list) {
            for (Object o : list) {
                // A name that isn't one of hers is kept as the model wrote it: the run answers it "no such tool".
                if (!(o instanceof Map<?, ?> c) || !(c.get("id") instanceof String id) || id.isEmpty()
                        || id.length() > MAX_CALL_ID_CHARS || !(c.get("name") instanceof String name) || name.isEmpty()
                        || name.length() > 128) {
                    throw new ProviderException(ProviderException.Kind.UNAVAILABLE, true, details("response"));
                }
                boolean malformed = Boolean.TRUE.equals(c.get("malformed")) || !(c.get("input") instanceof Map<?, ?>);
                @SuppressWarnings("unchecked")
                Map<String, Object> input = malformed ? Map.of() : (Map<String, Object>) c.get("input");
                List<Map<String, Object>> reasoning = new ArrayList<>();
                if (c.get("reasoning") instanceof List<?> items) {
                    for (Object item : items) {
                        if (item instanceof Map<?, ?> m) {
                            @SuppressWarnings("unchecked")
                            Map<String, Object> kept = (Map<String, Object>) m;
                            reasoning.add(kept);
                        }
                    }
                }
                calls.add(new ToolCall(id, name, input, malformed, reasoning));
            }
        }
        String stop = r.get("stopReason") instanceof String s && s.matches("[a-z_]{1,40}") ? s : null;
        Map<?, ?> u = r.get("usage") instanceof Map<?, ?> m ? m : Map.of();
        long output = count(u.get("outputTokens"));
        Usage usage = new Usage(count(u.get("inputTokens")), count(u.get("cachedInputTokens")),
                count(u.get("cacheWriteTokens")), output, Math.min(output, count(u.get("reasoningTokens"))));
        return new ChatResult(text, usage, "maia", stop, calls, null, centiCredits(r));
    }

    /**
     * The 200's {@code costCredits}, what the call drew, in hundredths of a credit (the contract gives up to 2 decimals), or
     * null when it's absent (an older Platform) or out of its shape.
     */
    static Long centiCredits(Map<String, Object> r) {
        if (!(r.get("costCredits") instanceof Number n)) {
            return null;
        }
        double credits = n.doubleValue();
        if (!(credits >= 0 && credits <= MAX_CREDITS)) {
            return null;
        }
        return Math.round(credits * 100);
    }

    /**
     * The 200's {@code allowance}, or null when it's absent or out of its shape. Its {@code credits} are null when absent
     * or out of their shape, and the share and reset still count.
     */
    static Allowance allowance(Map<String, Object> r) {
        if (!(r.get("allowance") instanceof Map<?, ?> a) || !(a.get("fraction") instanceof Number n)
                || !(a.get("resetsAt") instanceof String at)) {
            return null;
        }
        double fraction = n.doubleValue();
        Instant resets = instant(at);
        if (!(fraction >= 0 && fraction <= 1) || resets == null) {
            return null;
        }
        Credits credits = credits(a.get("credits"));
        boolean lighter = Boolean.TRUE.equals(a.get("lighter"))
                || (credits != null && "lighter".equals(credits.drawingFrom()));
        return new Allowance(fraction, resets, credits, lighter);
    }

    /** {@code allowance.credits}: null when absent, or when the month's amount or what's left of it isn't a count. */
    static Credits credits(Object raw) {
        if (!(raw instanceof Map<?, ?> c)) {
            return null;
        }
        Long month = whole(c.get("month"));
        Long monthLeft = whole(c.get("monthLeft"));
        if (month == null || monthLeft == null) {
            return null;
        }
        String drawing = c.get("drawingFrom") instanceof String d && DRAWING.contains(d) ? d : null;
        return new Credits(month, Math.min(monthLeft, month), orZero(c.get("week")), orZero(c.get("weekUsed")),
                orZero(c.get("day")), orZero(c.get("dayUsed")), orZero(c.get("topUpLeft")), drawing);
    }

    /** A count of credits: a number from 0 to {@link #MAX_CREDITS}, rounded down; else null. */
    private static Long whole(Object raw) {
        if (!(raw instanceof Number n)) {
            return null;
        }
        double v = n.doubleValue();
        return v >= 0 && v <= MAX_CREDITS ? (long) Math.floor(v) : null;
    }

    private static long orZero(Object raw) {
        Long v = whole(raw);
        return v == null ? 0 : v;
    }

    private static long count(Object raw) {
        return raw instanceof Number n && n.doubleValue() > 0 ? Math.min((long) n.doubleValue(), Long.MAX_VALUE / 4) : 0;
    }

    /** deskd's or the service's refusal as the kind a run ends with: whether it may have been billed, and its details. */
    /** A code or reason as a log may carry it: lower-case words and underscores, at most 32, else "other". */
    static String logWord(String w) {
        return w == null ? "-" : w.matches("[a-z_]{1,32}") ? w : "other";
    }

    ProviderException refusal(DeskLink.Reply reply) {
        if (reply.lost()) {
            // Sent, and no answer came: the service may have made the call.
            return new ProviderException(ProviderException.Kind.UNAVAILABLE, true, details("lost"));
        }
        Map<String, Object> d = reply.details();
        String reason = reply.reason() == null || reply.reason().equals(reply.code()) ? null : reply.reason();
        // Words only (a code and a reason, never content): her service's no, so a failed run of hers can be told apart.
        log.warn("her model call wasn't answered: {} ({})", logWord(reply.code()), logWord(reason));
        ProviderException.Details details = new ProviderException.Details(reason,
                d.get("window") instanceof String w ? w : null, d.get("resetsAt") instanceof String at ? at : null,
                d.get("retryAfterSec") instanceof Number n ? n.longValue() : null);
        String code = reply.code() == null ? "unavailable" : reply.code();
        return switch (code) {
            case "limit" -> {
                Instant resets = instant(details.resetsAt());
                if (resets != null && resets.isAfter(clock.instant())) {
                    limit = new Limit(details, resets);
                } else if ("credits_used".equals(reason)) {
                    // The wallet is used up and the tier has no lighter share (0.4.10): no reset to wait for, and a top-up
                    // can come at any time, so tried again a minute later (as an agent's on the credits is).
                    limit = new Limit(details, clock.instant().plus(HelperServiceProvider.RETRY_USED_UP));
                }
                yield new ProviderException(ProviderException.Kind.LIMIT, false, details);
            }
            case "rate_limited" -> new ProviderException(ProviderException.Kind.RATE_LIMITED, false, details);
            case "forbidden" -> new ProviderException(ProviderException.Kind.FORBIDDEN, false, details);
            case "bad_request" -> new ProviderException(ProviderException.Kind.BAD_REQUEST, false, details);
            case "too_large" -> new ProviderException(ProviderException.Kind.TOO_LARGE, false, details);
            // deskd's own timeout: the service may have made the call before the answer was lost.
            case "unavailable" -> new ProviderException(ProviderException.Kind.UNAVAILABLE, "timeout".equals(reason),
                    details);
            // unauthenticated, desk_mismatch, desk_destroyed and anything new: not hers to fix, and nothing was made.
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

    /** A file's name as the line that stands for it: one line, plain, at most 120 characters. */
    static final class MaiaFileName {
        private MaiaFileName() {}

        static String of(String name) {
            if (name == null || name.isBlank()) {
                return "a file";
            }
            String one = name.replaceAll("[\\p{Cntrl}\\[\\]]", " ").replaceAll("\\s+", " ").strip();
            return one.isEmpty() ? "a file" : Cut.chars(one, 120);
        }
    }
}
