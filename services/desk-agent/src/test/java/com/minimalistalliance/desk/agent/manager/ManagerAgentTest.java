package com.minimalistalliance.desk.agent.manager;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.limits.Limit;
import com.minimalistalliance.desk.agent.limits.LimitPolicy;
import com.minimalistalliance.desk.agent.limits.LimitSettings;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.Role;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ManagerAgentTest {

    private static final ManagerAgent.Binding BINDING =
            new ManagerAgent.Binding(Rig.KEY_ID, FakeProvider.ID, Rig.MODEL, 100);
    private static final List<ChatMessage> THREAD = List.of(
            ChatMessage.user("What's on my desk?"), ChatMessage.assistant("A notebook."), ChatMessage.user("Thanks."));

    @TempDir
    Path dir;

    private Rig rig;
    private LimitSettings limits;
    private ManagerAgent manager;

    @BeforeEach
    void setUp() throws Exception {
        rig = new Rig(dir);
        limits = new LimitSettings();
        manager = new ManagerAgent(rig.gateway, rig.keys, limits, rig.clock);
    }

    @AfterEach
    void tearDown() {
        rig.close();
    }

    @Test
    void itStartsDormantWithNoKey() {
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.NO_KEY);
        assertThat(manager.badge()).isNull();
        assertThatThrownBy(() -> manager.start(THREAD, text -> {}))
                .isInstanceOfSatisfying(AgentException.class,
                        e -> assertThat(e.code()).isEqualTo(AgentException.Code.NO_KEY));
        assertThat(rig.provider.seen).isEmpty();
    }

    /** A binding whose key isn't held, as after a restart before deskd hands keys over again, is no_key too. */
    @Test
    void aBindingWithoutItsKeyIsNoKey() {
        manager.bind(new ManagerAgent.Binding("not-held", FakeProvider.ID, Rig.MODEL, 100));
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.NO_KEY);
        assertThatThrownBy(() -> manager.start(THREAD, text -> {}))
                .isInstanceOfSatisfying(AgentException.class,
                        e -> assertThat(e.code()).isEqualTo(AgentException.Code.NO_KEY));
    }

    @Test
    void itAnswersTheThreadWithItsInstructionsAndABadge() throws Exception {
        manager.bind(BINDING);
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.ONLINE);
        assertThat(manager.badge()).isEqualTo(new ManagerAgent.Badge("fake", "Fake", Rig.MODEL));
        rig.provider.then(FakeProvider.Step.answer(new Usage(50, 0, 0, 10, 0), "You're ", "welcome.")
                .answeredBy("fake-model-2026-11-01"));

        List<String> deltas = new ArrayList<>();
        ManagerAgent.RunResult answer = manager.answer(THREAD, deltas::add);

        assertThat(answer.state()).isEqualTo(ManagerAgent.RunState.DONE);
        assertThat(answer.text()).isEqualTo("You're welcome.");
        assertThat(deltas).containsExactly("You're ", "welcome.");
        // The badge names the model that answered, which can be a dated version of the one asked for.
        assertThat(answer.badge()).isEqualTo(new ManagerAgent.Badge("fake", "Fake", "fake-model-2026-11-01"));
        assertThat(answer.costMicroUsd()).isEqualTo(70);
        assertThat(answer.stopReason()).isEqualTo("end_turn");
        assertThat(answer.error()).isNull();
        assertThat(UUID.fromString(answer.runId()).version()).isEqualTo(7);
        assertThat(rig.provider.seen).singleElement().satisfies(seen -> {
            assertThat(seen.request().system()).isEqualTo(ManagerAgent.DEFAULT_INSTRUCTIONS);
            assertThat(seen.request().messages()).extracting(ChatMessage::role)
                    .containsExactly(Role.USER, Role.ASSISTANT, Role.USER);
            assertThat(seen.request().maxOutputTokens()).isEqualTo(100);
        });
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.ONLINE);
        assertThat(answer.toString()).doesNotContain("welcome");
    }

    @Test
    void startReturnsAtOnceAndTheRunEndsOnItsOwnThread() throws Exception {
        manager.bind(BINDING);
        CountDownLatch release = new CountDownLatch(1);
        rig.provider.then(FakeProvider.Step.answer(new Usage(1, 0, 0, 1, 0), "done").heldBy(release));
        ManagerAgent.Run run = manager.start(THREAD, text -> {});
        assertThat(rig.provider.started.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(run.result()).isNotDone();
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.WORKING);
        // One run at a time.
        assertThatThrownBy(() -> manager.start(THREAD, text -> {}))
                .isInstanceOfSatisfying(AgentException.class,
                        e -> assertThat(e.code()).isEqualTo(AgentException.Code.BUSY));
        release.countDown();
        assertThat(run.await().state()).isEqualTo(ManagerAgent.RunState.DONE);
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.ONLINE);
    }

    @Test
    void aStoppedRunEndsStoppedWithWhatItHadStreamed() throws Exception {
        manager.bind(BINDING);
        CountDownLatch never = new CountDownLatch(1);
        rig.provider.then(FakeProvider.Step.answer(new Usage(1, 0, 0, 1, 0), "x").heldBy(never));
        ManagerAgent.Run run = manager.start(THREAD, text -> {});
        assertThat(rig.provider.started.await(5, TimeUnit.SECONDS)).isTrue();
        run.stop();
        ManagerAgent.RunResult result = run.await();
        assertThat(result.state()).isEqualTo(ManagerAgent.RunState.STOPPED);
        assertThat(result.error()).isNull();
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.ONLINE);
    }

    /** Task 07's ask 3: a limit refuses send itself, before anything is added or sent. */
    @Test
    void aLimitRefusesTheSendAndShowsUntilACallFitsAgain() throws Exception {
        manager.bind(BINDING);
        limits.set(ManagerAgent.ID, new LimitPolicy(Limit.tokens(100), Limit.NONE, Limit.NONE, Limit.NONE, Limit.NONE,
                Limit.NONE, 50));
        assertThatThrownBy(() -> manager.start(THREAD, text -> {}))
                .isInstanceOfSatisfying(AgentException.class, e -> {
                    assertThat(e.code()).isEqualTo(AgentException.Code.LIMIT_REACHED);
                    assertThat(e.detail()).isEqualTo("agent_day");
                });
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.LIMIT_REACHED);
        assertThat(manager.statusDetail()).isEqualTo("agent_day");
        assertThat(rig.provider.seen).isEmpty();

        limits.set(ManagerAgent.ID, LimitPolicy.DEFAULTS);
        assertThat(manager.answer(THREAD, text -> {}).state()).isEqualTo(ManagerAgent.RunState.DONE);
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.ONLINE);
        assertThat(manager.statusDetail()).isNull();
    }

    /** Task 07's ask 3: a provider's failure ends the run failed, with provider_error and its kind; send succeeded. */
    @Test
    void aProviderFailureEndsTheRunFailed() throws Exception {
        manager.bind(BINDING);
        rig.provider.then(FakeProvider.Step.fail(ProviderException.Kind.RATE_LIMITED, false));
        ManagerAgent.RunResult limited = manager.answer(THREAD, text -> {});
        assertThat(limited.state()).isEqualTo(ManagerAgent.RunState.FAILED);
        assertThat(limited.error()).isEqualTo("provider_error");
        assertThat(limited.errorDetail()).isEqualTo("rate_limited");
        assertThat(limited.badge()).isEqualTo(new ManagerAgent.Badge("fake", "Fake", Rig.MODEL));
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.ONLINE);

        rig.provider.then(FakeProvider.Step.fail(ProviderException.Kind.AUTH, false));
        ManagerAgent.RunResult refused = manager.answer(THREAD, text -> {});
        assertThat(refused.errorDetail()).isEqualTo("auth");
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.ERROR);
        assertThat(manager.statusDetail()).isEqualTo("auth");
    }

    /** What isn't the member's to fix ends the run failed with unavailable; send itself still succeeded. */
    @Test
    void noAdapterForTheProviderEndsTheRunUnavailable() throws Exception {
        rig.keys.put("openai-key", ProviderId.OPENAI, "sk-proj-0123456789".getBytes(StandardCharsets.US_ASCII));
        manager.bind(new ManagerAgent.Binding("openai-key", ProviderId.OPENAI, "gpt-x", 100));
        ManagerAgent.RunResult result = manager.answer(THREAD, text -> {});
        assertThat(result.state()).isEqualTo(ManagerAgent.RunState.FAILED);
        assertThat(result.error()).isEqualTo("unavailable");
        assertThat(result.errorDetail()).isEqualTo("no_provider");
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.ERROR);
        // And it isn't left busy.
        rig.keys.drop("openai-key");
        manager.bind(BINDING);
        assertThat(manager.answer(THREAD, text -> {}).state()).isEqualTo(ManagerAgent.RunState.DONE);
    }

    @Test
    void unbindingMakesItDormantAgain() {
        manager.bind(BINDING);
        manager.unbind();
        assertThat(manager.status()).isEqualTo(ManagerAgent.Status.NO_KEY);
        assertThat(manager.badge()).isNull();
    }
}
