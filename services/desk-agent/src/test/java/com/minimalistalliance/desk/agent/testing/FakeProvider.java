package com.minimalistalliance.desk.agent.testing;

import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.provider.ChatProvider;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ModelInfo;
import com.minimalistalliance.desk.agent.provider.ProviderInfo;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.Usage;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * A scripted provider. Each call takes the next scripted step, or a default answer when none is queued. It records
 * every request and the key it was lent, so tests can check what reached a provider.
 */
public final class FakeProvider implements ChatProvider {

    public static final ProviderId ID = new ProviderId("fake", "Fake");

    /** One call's behaviour: stream {@code deltas}, then return {@code usage}, or fail with {@code failure}. */
    public record Step(List<String> deltas, Usage usage, String model, ProviderException failure, CountDownLatch hold,
            List<ToolCall> toolCalls, String stopReason) {

        public Step {
            toolCalls = toolCalls == null ? List.of() : List.copyOf(toolCalls);
        }

        public Step(List<String> deltas, Usage usage, String model, ProviderException failure, CountDownLatch hold,
                List<ToolCall> toolCalls) {
            this(deltas, usage, model, failure, hold, toolCalls, null);
        }

        public Step(List<String> deltas, Usage usage, String model, ProviderException failure, CountDownLatch hold) {
            this(deltas, usage, model, failure, hold, List.of(), null);
        }

        /** The same step, ending with the provider's {@code stopReason}, such as {@code max_tokens} or {@code refusal}. */
        public Step stoppedBy(String reason) {
            return new Step(deltas, usage, model, failure, hold, toolCalls, reason);
        }

        public static Step answer(Usage usage, String... deltas) {
            return new Step(List.of(deltas), usage, null, null, null);
        }

        /** A step that ends in tool calls (after streaming {@code deltas}, if any): the loop runs them and calls again. */
        public static Step calls(Usage usage, List<ToolCall> calls, String... deltas) {
            return new Step(List.of(deltas), usage, null, null, null, calls);
        }

        /** One tool call, as the model would make it. */
        public static ToolCall call(String id, String name, Object... pairs) {
            Map<String, Object> input = new LinkedHashMap<>();
            for (int i = 0; i < pairs.length; i += 2) {
                input.put((String) pairs[i], pairs[i + 1]);
            }
            return new ToolCall(id, name, input);
        }

        public static Step fail(ProviderException.Kind kind, boolean mayHaveBilled) {
            return new Step(List.of(), null, null, new ProviderException(kind, mayHaveBilled), null);
        }

        /** Answers only once the latch opens: for a run that's still going. */
        public Step heldBy(CountDownLatch latch) {
            return new Step(deltas, usage, model, failure, latch, toolCalls, stopReason);
        }

        public Step answeredBy(String reportedModel) {
            return new Step(deltas, usage, reportedModel, failure, hold, toolCalls, stopReason);
        }
    }

    public record Seen(ChatRequest request, String key) {}

    private final ProviderId id;
    private final LinkedBlockingQueue<Step> script = new LinkedBlockingQueue<>();
    public final ConcurrentLinkedQueue<Seen> seen = new ConcurrentLinkedQueue<>();
    public volatile CountDownLatch started = new CountDownLatch(1);
    /** Looks at each chat request as the call is made, before it answers: for what a request carries only until then. */
    public volatile java.util.function.Consumer<ChatRequest> onChat;

    public FakeProvider() {
        this(ID);
    }

    public FakeProvider(ProviderId id) {
        this.id = id;
    }

    public FakeProvider then(Step step) {
        script.add(step);
        return this;
    }

    /** What models() answers; a failure there stands for a refused key. */
    public volatile ProviderException modelsFailure;

    @Override
    public ProviderInfo info() {
        return new ProviderInfo(id, "fake.invalid", "sk-");
    }

    @Override
    public List<ModelInfo> models(KeyLease key) throws ProviderException {
        seen.add(new Seen(null, new String(key.bytes(), StandardCharsets.US_ASCII)));
        if (modelsFailure != null) {
            throw modelsFailure;
        }
        return List.of(new ModelInfo("fake-model", "Fake model"), new ModelInfo("fake-unpriced", "Unpriced"));
    }

    @Override
    public ChatResult chat(ChatRequest request, KeyLease key, DeltaSink sink) throws ProviderException {
        seen.add(new Seen(request, new String(key.bytes(), StandardCharsets.US_ASCII)));
        java.util.function.Consumer<ChatRequest> look = onChat;
        if (look != null) {
            look.accept(request);
        }
        started.countDown();
        Step step = script.poll();
        if (step == null) {
            step = Step.answer(new Usage(100, 0, 0, 20, 0), "Hello", " from", " the fake.");
        }
        if (step.hold() != null) {
            try {
                if (!step.hold().await(10, TimeUnit.SECONDS)) {
                    throw new ProviderException(ProviderException.Kind.TIMEOUT, true);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new ProviderException(ProviderException.Kind.CANCELLED, true);
            }
        }
        if (step.failure() != null) {
            throw step.failure();
        }
        StringBuilder text = new StringBuilder();
        for (String delta : step.deltas()) {
            sink.delta(delta);
            text.append(delta);
        }
        return new ChatResult(text.toString(), step.usage(), step.model() == null ? request.model() : step.model(),
                step.stopReason() != null ? step.stopReason()
                        : step.toolCalls().isEmpty() ? "end_turn" : "tool_use",
                step.toolCalls());
    }

    /** The chat requests so far, oldest first (the model-list calls aren't among them). */
    public List<ChatRequest> requests() {
        List<ChatRequest> out = new ArrayList<>();
        for (Seen s : seen) {
            if (s.request() != null) {
                out.add(s.request());
            }
        }
        return out;
    }

    /** How many scripted steps are still waiting. */
    public int pending() {
        return script.size();
    }
}
