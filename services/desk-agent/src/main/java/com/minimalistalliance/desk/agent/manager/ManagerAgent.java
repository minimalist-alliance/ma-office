package com.minimalistalliance.desk.agent.manager;

import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.limits.LimitReachedException;
import com.minimalistalliance.desk.agent.limits.LimitSettings;
import com.minimalistalliance.desk.agent.llm.GatewayException;
import com.minimalistalliance.desk.agent.llm.LlmGateway;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.Cut;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.limits.LimitPolicy;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.Usage;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;
import java.sql.SQLException;
import java.time.Clock;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One agent's runtime: the desk's lead (the manager of design 9.2, id {@code manager}) and, since task 49 (ADR 0047),
 * every staff agent, each its own instance from {@link #forAgent}. It starts dormant, {@code no_key}, until a binding
 * names a key it holds and a model, then answers a thread through {@link LlmGateway}. With tools ({@link RunSetup}) a
 * run is a loop: a model call, the tools it asked for, their results back, and again, each call reserved against every
 * limit before it goes, so the run's steps and dollars bound it. One run at a time, as the design allows one active
 * run per agent.
 *
 * <p>{@link #start} is what a client's {@code agent.message.send} does, and it fails only for {@code no_key},
 * {@code busy} and {@code limit_reached} (task 07's ask 3), all before anything is sent. Everything after that ends
 * the run itself: {@code done}, {@code stopped}, or {@code failed} with {@code provider_error} and the provider's
 * error kind, or {@code unavailable} when desk-agent couldn't make or record the call.
 *
 * <p>The thread comes from the caller. Every answer carries its provider badge (design 9.4), from the model the
 * provider says answered.
 */
public final class ManagerAgent {

    private static final Logger log = LoggerFactory.getLogger(ManagerAgent.class);

    public static final String ID = "manager";

    /** A placeholder until the member edits it; instructions are member-editable (design 9.2). */
    static final String DEFAULT_INSTRUCTIONS = "You are the manager agent on the member's private cloud desk. Answer"
            + " clearly and briefly. You have no tools yet, so say so if a request needs one.";

    /** What design 9.1 lists, as the client will show it. */
    public enum Status {
        NO_KEY,
        ONLINE,
        WORKING,
        LIMIT_REACHED,
        ERROR;

        public String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /**
     * The tools one run may call. {@link #call} runs on the run's own thread, so a tool that waits (another agent's
     * answer) holds only its run; it must answer every mistake of the model's with an error result, never throw.
     */
    public interface Tools {
        Tools NONE = new Tools() {
            @Override
            public List<ToolSpec> specs() {
                return List.of();
            }

            @Override
            public ToolResult call(ToolCall call, String runId) {
                return new ToolResult(call.id(), "There are no tools.", true);
            }
        };

        List<ToolSpec> specs();

        ToolResult call(ToolCall call, String runId) throws InterruptedException;

        /**
         * The call with the gate's verdict, which runs it: {@link com.minimalistalliance.desk.agent.approval.Verdict.Auto}
         * or {@link com.minimalistalliance.desk.agent.approval.Verdict.Approved}, whose {@code {approvalId, sha256}} a
         * deskd-hosted tool sends with the call. An approved call runs with exactly the approval's stored payload, which
         * is the call's input. Tools that never ask needn't override it.
         */
        default ToolResult call(ToolCall call, String runId,
                com.minimalistalliance.desk.agent.approval.Verdict verdict) throws InterruptedException {
            return call(call, runId);
        }

        /**
         * The call with its run and the gate's verdict: what a gated run calls. A tool that reads untrusted or private
         * content beyond its declaration's {@code taints} (a workspace file a {@code U} run wrote) adds it with
         * {@code run.add}, and a deskd-hosted tool sends {@code run.taint()} with the call. By default
         * {@link #call(ToolCall, String, com.minimalistalliance.desk.agent.approval.Verdict)}.
         */
        default ToolResult call(ToolCall call, com.minimalistalliance.desk.agent.tool.RunContext run,
                com.minimalistalliance.desk.agent.approval.Verdict verdict) throws InterruptedException {
            return call(call, run.runId(), verdict);
        }

        /** A few words for the reply's tool chip: what was done, never the content. */
        default String chip(ToolCall call, ToolResult result) {
            return call.name();
        }
    }

    /**
     * What one run is told and may do: its system prompt, its tools and, for a run another agent's message started, the
     * most it may spend in µ$ (what's left of the share of spend on agent messages; null for no cap of its own). That cap
     * tightens the run scope of every step's reservation, never loosens it. {@code gating}, when present, puts every
     * step's calls through the policy and the approval gate (draft ADR "the Agent's tools and approvals", section 11).
     */
    public record RunSetup(String instructions, Tools tools, Long maxMicroUsd,
            Set<com.minimalistalliance.desk.agent.tool.Taint> taint, Gating gating) {
        /**
         * {@code taint} is the run's flags from its start (the tools and approvals draft, section 6), live: the very set
         * a {@link com.minimalistalliance.desk.agent.tool.RunContext} keeps by reference, so a run context made with it
         * shares it, and what the loop adds is what a tool that reads it sees. What a run reads before its first step
         * goes in here: memory's {@code S} for pinned lines and {@code U} for a marked one ({@code Memories.seed}).
         */
        public RunSetup {
            Objects.requireNonNull(instructions, "instructions");
            tools = tools == null ? Tools.NONE : tools;
            if (maxMicroUsd != null && maxMicroUsd < 0) {
                throw new IllegalArgumentException("negative cap");
            }
            // A run context made with null makes the run's own grow-only set; one made with that set keeps it.
            taint = new com.minimalistalliance.desk.agent.tool.RunContext("setup", "setup",
                    com.minimalistalliance.desk.agent.service.Caller.OWNER, null, taint, null).taint();
        }

        public RunSetup(String instructions, Tools tools, Long maxMicroUsd,
                Set<com.minimalistalliance.desk.agent.tool.Taint> taint) {
            this(instructions, tools, maxMicroUsd, taint, null);
        }

        public RunSetup(String instructions, Tools tools, Long maxMicroUsd) {
            this(instructions, tools, maxMicroUsd, null, null);
        }

        public RunSetup(String instructions, Tools tools) {
            this(instructions, tools, null, null);
        }

        /** The same setup with other tools, keeping its cap, its taint and its gating. */
        public RunSetup withTools(Tools other) {
            return new RunSetup(instructions, other, maxMicroUsd, taint, gating);
        }

        /** The same setup with the policy and the gate, keeping its taint. */
        public RunSetup withGating(Gating other) {
            return new RunSetup(instructions, tools, maxMicroUsd, taint, other);
        }

        /** The policy a step reserves against: the agent's, with the run scope at most this setup's cap. */
        LimitPolicy bound(LimitPolicy policy) {
            if (maxMicroUsd == null) {
                return policy;
            }
            com.minimalistalliance.desk.agent.limits.Limit run = policy.run();
            long cap = run.maxMicroUsd() == null ? maxMicroUsd : Math.min(run.maxMicroUsd(), maxMicroUsd);
            return new LimitPolicy(policy.agentDay(), policy.agentWeek(), policy.agentMonth(), policy.deskDay(),
                    policy.deskMonth(), policy.keyMonth(),
                    new com.minimalistalliance.desk.agent.limits.Limit(cap, run.maxTokens()), policy.runMaxSteps());
        }
    }

    /**
     * How a run's calls are let through: {@code policy} classifies each call of a step, {@code gate} admits the step
     * (asking the member where the class says so) and settles each call, and {@code context} makes the run's
     * {@link com.minimalistalliance.desk.agent.tool.RunContext} from its id, once, as the run starts.
     */
    public record Gating(com.minimalistalliance.desk.agent.tool.ToolPolicy policy,
            com.minimalistalliance.desk.agent.approval.ApprovalGate gate,
            java.util.function.Function<String, com.minimalistalliance.desk.agent.tool.RunContext> context) {
        public Gating {
            Objects.requireNonNull(policy, "policy");
            Objects.requireNonNull(gate, "gate");
            Objects.requireNonNull(context, "context");
        }
    }

    /** How a run ended: a reply message's final {@code state}. */
    /**
     * A {@code workspace_write} the workspace refused for space (Design M9): the chip keeps the path and the reason, so
     * the member's thread can say "Couldn't save {file}: the workspace is full." The reason is read from the tool's
     * own refusal ({@code TeamTools.workspaceWrite}: "Refused: <reason>.").
     */
    static void savedRefused(ToolCall call, ToolResult answer, Map<String, Object> chip) {
        if (!answer.error() || !"workspace_write".equals(call.name())
                || !(call.input().get("path") instanceof String path) || answer.content() == null) {
            return;
        }
        String reason = switch (answer.content()) {
            case "Refused: quota." -> "workspace_full";
            case "Refused: disk_full." -> "disk_low";
            case "Refused: too_many_files." -> "too_many_files";
            case "Refused: too_many_folders." -> "too_many_folders";
            default -> null;
        };
        if (reason != null) {
            chip.put("path", path.length() > 200 ? path.substring(0, 200) : path);
            chip.put("reason", reason);
        }
    }

    public enum RunState {
        DONE,
        STOPPED,
        FAILED;

        public String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /** design 9.2's {@code chat_binding}: which key, which model, and the output cap the limits reserve against. */
    public record Binding(String keyId, ProviderId provider, String model, int maxOutputTokens) {

        public Binding {
            Objects.requireNonNull(keyId, "keyId");
            Objects.requireNonNull(provider, "provider");
            Objects.requireNonNull(model, "model");
            if (maxOutputTokens < 1) {
                throw new IllegalArgumentException("maxOutputTokens must be positive");
            }
        }
    }

    /** The provider badge: who produced an answer. */
    public record Badge(String provider, String providerName, String model) {}

    /**
     * How a run ended. For {@code done}: the text, badge, usage, cost in µ$ (null for a model with no price) and the
     * provider's stop reason. For {@code failed}: {@code error} is {@code provider_error} or {@code unavailable},
     * and {@code errorDetail} a word, never the provider's message. A stopped or failed run keeps the text that
     * streamed before it ended.
     */
    public record RunResult(
            String runId,
            RunState state,
            String text,
            Badge badge,
            Usage usage,
            Long costMicroUsd,
            String stopReason,
            String error,
            String errorDetail,
            List<Map<String, Object>> tools) {

        public RunResult {
            tools = tools == null ? List.of() : List.copyOf(tools);
        }

        public RunResult(String runId, RunState state, String text, Badge badge, Usage usage, Long costMicroUsd,
                String stopReason, String error, String errorDetail) {
            this(runId, state, text, badge, usage, costMicroUsd, stopReason, error, errorDetail, List.of());
        }

        /**
         * A short line for later turns to read, so an agent that is told "try again" knows what its last run did:
         * {@code [Done: write_file; message_agent (failed)]}. Empty when the run used no tools. Names only, never content.
         */
        public String actionsLine() {
            return actionsLine(tools);
        }

        /** {@link #actionsLine()} for a stored reply's chips, as {@code Team.context} reads them back. */
        public static String actionsLine(List<Map<String, Object>> tools) {
            if (tools.isEmpty()) {
                return "";
            }
            StringBuilder line = new StringBuilder("[Done: ");
            int shown = 0;
            for (Map<String, Object> chip : tools) {
                if (shown == 12) {
                    line.append("; and ").append(tools.size() - shown).append(" more");
                    break;
                }
                if (shown > 0) {
                    line.append("; ");
                }
                line.append(Cut.chars(String.valueOf(chip.get("summary")), 80));
                if (Boolean.FALSE.equals(chip.get("ok"))) {
                    line.append(" (failed)");
                }
                shown++;
            }
            return line.append("]").toString();
        }

        /** No content in logs or exceptions. */
        @Override
        public String toString() {
            return "RunResult[" + runId + ", " + state + ", " + badge + ", " + text.length() + " chars, "
                    + costMicroUsd + " µ$, " + error + " " + errorDetail + "]";
        }
    }

    /** A run under way. Its result comes once it ends; {@link #stop} ends it early. */
    public static final class Run {
        private final String runId;
        private final CompletableFuture<RunResult> result = new CompletableFuture<>();
        private final AtomicBoolean stopRequested = new AtomicBoolean();
        private volatile Thread thread;

        private Run(String runId) {
            this.runId = runId;
        }

        public String runId() {
            return runId;
        }

        /** Stops the provider call; the run ends {@code stopped}. Harmless once it has ended. */
        public void stop() {
            stopRequested.set(true);
            Thread running = thread;
            if (running != null) {
                running.interrupt();
            }
        }

        public CompletableFuture<RunResult> result() {
            return result;
        }

        /** Waits for the end of the run. */
        public RunResult await() {
            try {
                return result.get();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                stop();
                return result.join();
            } catch (ExecutionException e) {
                throw new IllegalStateException(e.getCause());
            }
        }
    }

    private final LlmGateway gateway;
    private final KeyRing keys;
    private final LimitSettings limits;
    private final Clock clock;
    private final AtomicBoolean running = new AtomicBoolean();
    /** Its agent's id: the desk's lead, {@code manager}, a staff agent's, or a guild member's own agent. */
    private final String id;
    private final Supplier<LimitPolicy> policy;
    private volatile String instructions = DEFAULT_INSTRUCTIONS;
    private volatile Binding binding;
    private volatile Status lastOutcome = Status.ONLINE;
    private volatile String statusDetail;

    public ManagerAgent(LlmGateway gateway, KeyRing keys, LimitSettings limits, Clock clock) {
        this(gateway, keys, limits, clock, ID, null);
    }

    private ManagerAgent(LlmGateway gateway, KeyRing keys, LimitSettings limits, Clock clock, String id,
            Supplier<LimitPolicy> policy) {
        this.gateway = gateway;
        this.keys = keys;
        this.limits = limits;
        this.clock = clock;
        this.id = id;
        this.policy = policy == null ? () -> limits.policyFor(id) : policy;
    }

    /**
     * Another agent like this one: a staff agent (ADR 0047) or a guild member's own (deskd's API.md section 14). Its
     * own id, binding and one run at a time, the same gateway, keys and ledger, and its own limits ({@code agentPolicy},
     * such as the guild's, or its scopes in {@link LimitSettings} when null).
     */
    public ManagerAgent forAgent(String agentId, Supplier<LimitPolicy> agentPolicy) {
        ManagerAgent agent = new ManagerAgent(gateway, keys, limits, clock, agentId, agentPolicy);
        agent.instructions = instructions;
        return agent;
    }

    public String id() {
        return id;
    }

    /** Binds a key and a model. */
    public void bind(Binding binding) {
        this.binding = Objects.requireNonNull(binding);
        lastOutcome = Status.ONLINE;
        statusDetail = null;
    }

    /** Back to dormant, as when its key is deleted. */
    public void unbind() {
        binding = null;
    }

    public void setInstructions(String instructions) {
        this.instructions = Objects.requireNonNull(instructions);
    }

    public Binding binding() {
        return binding;
    }

    /**
     * {@code no_key} while there's no binding or its key isn't held (its sealed file is missing or won't open, ADR
     * 0042), {@code working} during a run, and otherwise how the last run or refusal left it.
     */
    public Status status() {
        Binding current = binding;
        if (current == null || keys.providerOf(current.keyId()) == null) {
            return Status.NO_KEY;
        }
        if (running.get()) {
            return Status.WORKING;
        }
        return lastOutcome;
    }

    /** A word with the status, never content: the limit's scope, or the provider's error kind. */
    public String statusDetail() {
        return status() == Status.LIMIT_REACHED || status() == Status.ERROR ? statusDetail : null;
    }

    /** The badge of the bound provider, for the Agent tile, or null while dormant. */
    public Badge badge() {
        Binding current = binding;
        return current == null ? null : new Badge(current.provider().id(), current.provider().displayName(),
                current.model());
    }

    /**
     * Starts answering the thread, whose last message is the member's. Text streams into {@code sink} as it arrives,
     * on the run's own thread.
     *
     * @throws AgentException {@code no_key}, {@code busy} or {@code limit_reached}, before anything is sent
     */
    public Run start(List<ChatMessage> thread, DeltaSink sink) throws AgentException {
        return start(thread, sink, new RunSetup(instructions, Tools.NONE));
    }

    /**
     * {@link #start}, told {@code setup}'s instructions, with its tools: the run loops until the model answers without
     * a tool call, the member stops it, or a limit refuses the next step (then it ends {@code failed} with
     * {@code limit_reached} and the scope, keeping what it said).
     */
    public Run start(List<ChatMessage> thread, DeltaSink sink, RunSetup setup) throws AgentException {
        Binding current = binding;
        if (current == null || keys.providerOf(current.keyId()) == null) {
            throw new AgentException(AgentException.Code.NO_KEY, null);
        }
        if (!running.compareAndSet(false, true)) {
            throw new AgentException(AgentException.Code.BUSY, null);
        }
        Run run = new Run(RunIds.next(clock).toString());
        com.minimalistalliance.desk.agent.tool.RunContext context = setup.gating() == null ? null
                : setup.gating().context().apply(run.runId());
        LlmGateway.Reserved reserved;
        try {
            ChatRequest request = new ChatRequest(current.model(), setup.instructions(), thread,
                    current.maxOutputTokens(), setup.tools().specs());
            LlmGateway.Call call = new LlmGateway.Call(id, run.runId(), current.keyId(), current.provider());
            reserved = gateway.reserve(call, request, setup.bound(policy.get()));
        } catch (LimitReachedException e) {
            finish(Status.LIMIT_REACHED, e.scope().wireName());
            throw new AgentException(AgentException.Code.LIMIT_REACHED, e.scope().wireName());
        } catch (GatewayException e) {
            if (e.reason() == GatewayException.Reason.NO_KEY) {
                finish(Status.ONLINE, null);
                throw new AgentException(AgentException.Code.NO_KEY, null);
            }
            String detail = e.reason().name().toLowerCase(Locale.ROOT);
            finish(Status.ERROR, detail);
            run.result.complete(failed(run, "", current, "unavailable", detail));
            return run;
        } catch (SQLException e) {
            log.error("the ledger or audit log failed: {}", e.getClass().getSimpleName());
            finish(Status.ERROR, "storage");
            run.result.complete(failed(run, "", current, "unavailable", "storage"));
            return run;
        } catch (RuntimeException e) {
            finish(Status.ERROR, "internal");
            throw e;
        }
        StringBuilder streamed = new StringBuilder();
        DeltaSink tee = text -> {
            streamed.append(text);
            sink.delta(text);
        };
        run.thread = Thread.ofVirtual().name("run-" + run.runId()).unstarted(() -> complete(run, reserved, current,
                tee, streamed, thread, setup, context));
        run.thread.start();
        return run;
    }

    /**
     * One call on this agent's binding that isn't a run: no tools, nothing streamed, no thread, and the agent's status
     * and its one run at a time untouched (a thread's compaction, S-14). It goes through the gateway like any step, so
     * it's reserved against the agent's limits under {@code runId}, audited and settled. An interrupt of the caller's
     * thread stops it.
     *
     * @throws AgentException {@code no_key} with no binding or no key held, before anything is reserved
     */
    public LlmGateway.Outcome sideCall(String system, List<ChatMessage> messages, int maxOutputTokens, String runId)
            throws AgentException, LimitReachedException, GatewayException, ProviderException, SQLException {
        Binding current = binding;
        if (current == null || keys.providerOf(current.keyId()) == null) {
            throw new AgentException(AgentException.Code.NO_KEY, null);
        }
        return gateway.call(new LlmGateway.Call(id, runId, current.keyId(), current.provider()),
                new ChatRequest(current.model(), system, messages, maxOutputTokens), policy.get(), text -> {});
    }

    /** {@link #start}, then waits for the run's end. */
    public RunResult answer(List<ChatMessage> thread, DeltaSink sink) throws AgentException {
        return start(thread, sink).await();
    }

    /** Most tool calls one model call may ask for that the loop runs; past this, each gets an error result. */
    static final int MAX_CALLS_PER_STEP = 16;
    /** A tool result is cut to this many characters before it goes back to the model (design 9.7 caps tool output). */
    static final int MAX_RESULT_CHARS = 20_000;

    private void complete(Run run, LlmGateway.Reserved first, Binding current, DeltaSink sink,
            StringBuilder streamed, List<ChatMessage> thread, RunSetup setup,
            com.minimalistalliance.desk.agent.tool.RunContext context) {
        RunResult result;
        List<Map<String, Object>> chips = new ArrayList<>();
        Usage total = null;
        Long cost = null;
        LlmGateway.Reserved reserved = first;
        try {
            List<ChatMessage> conversation = new ArrayList<>(thread);
            // Steps after the first start their text on a new paragraph, if both said something.
            boolean[] needsBreak = {false};
            DeltaSink stepSink = text -> {
                if (needsBreak[0] && !text.isEmpty()) {
                    needsBreak[0] = false;
                    sink.delta("\n\n");
                }
                sink.delta(text);
            };
            while (true) {
                LlmGateway.Outcome outcome = gateway.complete(reserved, stepSink);
                total = add(total, outcome.result().usage());
                cost = outcome.costMicroUsd() == null ? cost : (cost == null ? 0 : cost) + outcome.costMicroUsd();
                List<ToolCall> calls = outcome.result().toolCalls();
                // A step cut off by its output cap or a refusal ends the run before any tool runs: a call cut short
                // would only come back as malformed, and the model would write the same oversized call again.
                if (!run.stopRequested.get() && (outcome.result().cutOff() || outcome.result().refused())) {
                    finish(Status.ONLINE, null);
                    result = new RunResult(run.runId(), RunState.FAILED, streamed.toString(),
                            new Badge(current.provider().id(), current.provider().displayName(),
                                    outcome.result().model()),
                            total, cost, outcome.result().stopReason(),
                            outcome.result().refused() ? "refused" : "cut_off", null, chips);
                    break;
                }
                if (calls.isEmpty() || run.stopRequested.get()) {
                    if (run.stopRequested.get() && !calls.isEmpty()) {
                        finish(Status.ONLINE, null);
                        result = new RunResult(run.runId(), RunState.STOPPED, streamed.toString(), badge(current),
                                total, cost, null, null, null, chips);
                        break;
                    }
                    finish(Status.ONLINE, null);
                    result = new RunResult(run.runId(), RunState.DONE, streamed.toString(),
                            new Badge(current.provider().id(), current.provider().displayName(),
                                    outcome.result().model()),
                            total, cost, outcome.result().stopReason(), null, null, chips);
                    break;
                }
                if (!streamed.isEmpty()) {
                    needsBreak[0] = true;
                }
                conversation.add(ChatMessage.toolCalls(outcome.result().text(), calls));
                List<ToolResult> results = new ArrayList<>();
                if (setup.gating() != null) {
                    results = gatedStep(setup, context, calls, chips);
                }
                for (int i = 0; setup.gating() == null && i < calls.size(); i++) {
                    ToolCall call = calls.get(i);
                    ToolResult answer = i < MAX_CALLS_PER_STEP
                            ? callTool(setup.tools(), call, run.runId())
                            : new ToolResult(call.id(), "Too many tool calls at once; this one didn't run.", true);
                    results.add(answer);
                    Map<String, Object> chip = new LinkedHashMap<>();
                    chip.put("name", call.name());
                    chip.put("summary", setup.tools().chip(call, answer));
                    chip.put("ok", !answer.error());
                    savedRefused(call, answer, chip);
                    chips.add(chip);
                }
                conversation.add(ChatMessage.toolResults(results));
                if (run.stopRequested.get()) {
                    finish(Status.ONLINE, null);
                    result = new RunResult(run.runId(), RunState.STOPPED, streamed.toString(), badge(current), total,
                            cost, null, null, null, chips);
                    break;
                }
                try {
                    reserved = gateway.reserve(new LlmGateway.Call(id, run.runId(), current.keyId(),
                            current.provider()), new ChatRequest(current.model(), setup.instructions(), conversation,
                            current.maxOutputTokens(), setup.tools().specs()), setup.bound(policy.get()));
                } catch (LimitReachedException e) {
                    boolean runScope = e.scope().wireName().startsWith("run");
                    finish(runScope ? Status.ONLINE : Status.LIMIT_REACHED, runScope ? null : e.scope().wireName());
                    result = new RunResult(run.runId(), RunState.FAILED, streamed.toString(), badge(current), total,
                            cost, null, "limit_reached", e.scope().wireName(), chips);
                    break;
                }
            }
        } catch (InterruptedException e) {
            // A stop while a tool waited, such as for another agent's answer.
            finish(Status.ONLINE, null);
            result = new RunResult(run.runId(), RunState.STOPPED, streamed.toString(), badge(current), total,
                    spent(cost, reserved), null, null, null, chips);
        } catch (ProviderException e) {
            if (run.stopRequested.get()) {
                finish(Status.ONLINE, null);
                result = new RunResult(run.runId(), RunState.STOPPED, streamed.toString(), badge(current), total,
                        spent(cost, reserved), null, null, null, chips);
            } else {
                String kind = e.kind().name().toLowerCase(Locale.ROOT);
                finish(e.kind() == ProviderException.Kind.AUTH ? Status.ERROR : Status.ONLINE, kind);
                result = withSpend(failed(run, streamed.toString(), current, "provider_error", kind), total,
                        spent(cost, reserved), chips);
            }
        } catch (GatewayException e) {
            finish(Status.ONLINE, null);
            result = withSpend(failed(run, streamed.toString(), current, "unavailable",
                    e.reason().name().toLowerCase(Locale.ROOT)), total, spent(cost, reserved), chips);
        } catch (SQLException e) {
            log.error("the ledger or audit log failed: {}", e.getClass().getSimpleName());
            finish(Status.ERROR, "storage");
            result = withSpend(failed(run, streamed.toString(), current, "unavailable", "storage"), total,
                    spent(cost, reserved), chips);
        } catch (RuntimeException e) {
            log.error("a run failed: {}", e.getClass().getName());
            finish(Status.ERROR, "internal");
            result = withSpend(failed(run, streamed.toString(), current, "unavailable", "internal"), total,
                    spent(cost, reserved), chips);
        }
        run.result.complete(result);
    }

    /** The run's cost so far, with what the step that just failed left spent in the ledger. */
    private static Long spent(Long cost, LlmGateway.Reserved failedStep) {
        long kept = failedStep == null ? 0 : failedStep.keptMicroUsd();
        if (kept == 0) {
            return cost;
        }
        return Long.valueOf((cost == null ? 0L : cost) + kept);
    }

    /**
     * One step's calls through the policy and the gate (draft ADR, section 3): every call classified first, the step
     * admitted at once (waiting for the member where it asks), then each call in its order, run or answered with the
     * verdict's words, settled, and its declared taints added to the run. A read never runs ahead of a write the model
     * put before it, and a call's class comes from what the run held when the step began, since the model wrote every
     * call of a step before it saw any result.
     *
     * @throws InterruptedException a stop while the step waited for the member; its approvals have expired
     */
    private static List<ToolResult> gatedStep(RunSetup setup, com.minimalistalliance.desk.agent.tool.RunContext context,
            List<ToolCall> calls, List<Map<String, Object>> chips) throws InterruptedException {
        Gating gating = setup.gating();
        Tools tools = setup.tools();
        ToolResult[] results = new ToolResult[calls.size()];
        List<com.minimalistalliance.desk.agent.tool.Classified> step = new ArrayList<>();
        List<Integer> at = new ArrayList<>();
        for (int i = 0; i < calls.size(); i++) {
            ToolCall call = calls.get(i);
            if (i >= MAX_CALLS_PER_STEP) {
                results[i] = new ToolResult(call.id(), "Too many tool calls at once; this one didn't run.", true);
            } else if (call.malformed()) {
                results[i] = new ToolResult(call.id(), "The tool's input wasn't a JSON object.", true);
            } else {
                com.minimalistalliance.desk.agent.tool.Classified classified;
                try {
                    classified = gating.policy().classify(call, context);
                } catch (RuntimeException e) {
                    log.warn("a call wasn't classified: {} {}", call.name(), e.getClass().getSimpleName());
                    classified = null;
                }
                if (classified == null) {
                    results[i] = new ToolResult(call.id(), "There's no such tool.", true);
                } else {
                    // Whatever the policy said: U and S make a browse action egress, the member's session at least write,
                    // a navigation there egress; the session grant only in a run the member started.
                    classified = classified.backstopped(context);
                    step.add(classified);
                    at.add(i);
                }
            }
        }
        List<com.minimalistalliance.desk.agent.approval.Verdict> verdicts = step.isEmpty() ? List.of()
                : gating.gate().admit(context, step);
        Map<Integer, Map<String, Object>> extra = new java.util.HashMap<>();
        for (int k = 0; k < step.size(); k++) {
            com.minimalistalliance.desk.agent.tool.Classified classified = step.get(k);
            com.minimalistalliance.desk.agent.approval.Verdict verdict = verdicts.get(k);
            ToolCall call = classified.call();
            ToolResult raw;
            ToolResult forModel;
            if (verdict.runs()) {
                // An approved call runs with exactly the payload the member saw and its hash covers.
                ToolCall running = verdict instanceof com.minimalistalliance.desk.agent.approval.Verdict.Approved
                        ? new ToolCall(call.id(), call.name(), classified.payload(), false, call.reasoning()) : call;
                gating.gate().starting(verdict);
                try {
                    raw = callTool(tools, running, context, verdict);
                } finally {
                    context.add(classified.decl().taints());
                }
                forModel = verdict instanceof com.minimalistalliance.desk.agent.approval.Verdict.Approved
                        ? new ToolResult(call.id(), raw.error()
                                ? "Approved by the member, but it failed: " + raw.content()
                                : "Approved by the member.\n" + raw.content(), raw.error())
                        : raw;
            } else {
                raw = new ToolResult(call.id(), verdict.modelText(), true);
                forModel = raw;
            }
            try {
                gating.gate().settle(context, classified, verdict, raw);
            } catch (RuntimeException e) {
                log.warn("a call wasn't settled: {} {}", call.name(), e.getClass().getSimpleName());
            }
            results[at.get(k)] = forModel;
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("risk", classified.risk().wireName());
            String decision = switch (verdict) {
                case com.minimalistalliance.desk.agent.approval.Verdict.Approved a -> "approved";
                case com.minimalistalliance.desk.agent.approval.Verdict.Declined d -> "declined";
                case com.minimalistalliance.desk.agent.approval.Verdict.Expired x -> "expired";
                default -> null;
            };
            String approvalId = switch (verdict) {
                case com.minimalistalliance.desk.agent.approval.Verdict.Approved a -> a.approvalId();
                case com.minimalistalliance.desk.agent.approval.Verdict.Declined d -> d.approvalId();
                case com.minimalistalliance.desk.agent.approval.Verdict.Expired x -> x.approvalId();
                default -> null;
            };
            if (decision != null && approvalId != null) {
                fields.put("approval", Map.of("id", approvalId, "decision", decision));
            }
            if (!classified.target().isEmpty()) {
                fields.put("target", classified.target());
            }
            if (verdict.runs() && classified.decl().taints().contains(com.minimalistalliance.desk.agent.tool.Taint.U)) {
                fields.put("untrusted", true);
            }
            if (classified.decl().scope().startsWith("browser:")) {
                fields.put("session", classified.context().startsWith("member:") ? "member" : "agent");
            }
            extra.put(at.get(k), fields);
        }
        List<ToolResult> out = new ArrayList<>();
        for (int i = 0; i < calls.size(); i++) {
            ToolCall call = calls.get(i);
            ToolResult answer = results[i];
            out.add(answer);
            Map<String, Object> chip = new LinkedHashMap<>();
            chip.put("name", call.name());
            chip.put("summary", tools.chip(call, answer));
            chip.put("ok", !answer.error());
            savedRefused(call, answer, chip);
            if (extra.containsKey(i)) {
                chip.putAll(extra.get(i));
            }
            chips.add(chip);
        }
        return out;
    }

    private static ToolResult callTool(Tools tools, ToolCall call, String runId) throws InterruptedException {
        return callTool(tools, call, null, null, runId);
    }

    private static ToolResult callTool(Tools tools, ToolCall call,
            com.minimalistalliance.desk.agent.tool.RunContext context,
            com.minimalistalliance.desk.agent.approval.Verdict verdict) throws InterruptedException {
        return callTool(tools, call, context, verdict, context.runId());
    }

    private static ToolResult callTool(Tools tools, ToolCall call,
            com.minimalistalliance.desk.agent.tool.RunContext context,
            com.minimalistalliance.desk.agent.approval.Verdict verdict, String runId) throws InterruptedException {
        ToolResult result;
        if (call.malformed()) {
            result = new ToolResult(call.id(), "The tool's input wasn't a JSON object.", true);
        } else {
            try {
                result = context == null ? tools.call(call, runId) : tools.call(call, context, verdict);
            } catch (InterruptedException e) {
                throw e;
            } catch (RuntimeException e) {
                log.warn("a tool failed: {} {}", call.name(), e.getClass().getSimpleName());
                result = new ToolResult(call.id(), "The tool failed on the desk.", true);
            }
        }
        String content = result.content();
        if (content.length() > MAX_RESULT_CHARS) {
            content = content.substring(0, MAX_RESULT_CHARS) + "\n[cut at " + MAX_RESULT_CHARS + " characters]";
        }
        return new ToolResult(call.id(), content, result.error());
    }

    private static Usage add(Usage a, Usage b) {
        if (a == null) {
            return b;
        }
        if (b == null) {
            return a;
        }
        return new Usage(a.inputTokens() + b.inputTokens(), a.cachedInputTokens() + b.cachedInputTokens(),
                a.cacheWriteTokens() + b.cacheWriteTokens(), a.outputTokens() + b.outputTokens(),
                a.reasoningTokens() + b.reasoningTokens());
    }

    private static RunResult withSpend(RunResult r, Usage usage, Long cost, List<Map<String, Object>> chips) {
        return new RunResult(r.runId(), r.state(), r.text(), r.badge(), usage, cost, r.stopReason(), r.error(),
                r.errorDetail(), chips);
    }

    private void finish(Status outcome, String detail) {
        lastOutcome = outcome;
        statusDetail = detail;
        running.set(false);
    }

    private static Badge badge(Binding binding) {
        return new Badge(binding.provider().id(), binding.provider().displayName(), binding.model());
    }

    private static RunResult failed(Run run, String text, Binding binding, String error, String detail) {
        return new RunResult(run.runId(), RunState.FAILED, text, badge(binding), null, null, null, error, detail);
    }
}
