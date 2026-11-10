package com.minimalistalliance.desk.agent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.testing.MutableClock;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AgentStoreTest {

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-06T10:00:00Z"));

    @Test
    void theManagerIsThereFromTheStartAndThreadsKeepTheirOrder() throws Exception {
        try (AgentStore store = new AgentStore(dir.resolve("agent.db"), clock)) {
            store.open();
            assertThat(store.agents()).singleElement().satisfies(a -> {
                assertThat(a.id()).isEqualTo("manager");
                assertThat(a.role()).isEqualTo("manager");
                assertThat(a.keyId()).isNull();
            });
            for (int i = 0; i < 5; i++) {
                store.addMessages(List.of(MessageRow.user("u" + i, "manager", "m" + i, i)));
            }
            assertThat(store.messages("manager", 3)).extracting(MessageRow::text).containsExactly("m2", "m3", "m4");
        }
    }

    /** No run survives a restart yet, so a reply left streaming ends failed, and says why. */
    @Test
    void aReplyLeftStreamingEndsInterruptedAtTheNextOpen() throws Exception {
        try (AgentStore store = new AgentStore(dir.resolve("agent.db"), clock)) {
            store.open();
            store.addMessages(List.of(new MessageRow("r1", "manager", "assistant", "Half", 1, "run-1", null, null,
                    null, null, "streaming", null, null)));
        }
        try (AgentStore store = new AgentStore(dir.resolve("agent.db"), clock)) {
            store.open();
            assertThat(store.interruptedAtOpen()).isEqualTo(1);
            assertThat(store.messages("manager", 10)).singleElement().satisfies(m -> {
                assertThat(m.state()).isEqualTo("failed");
                assertThat(m.error()).isEqualTo("unavailable");
                assertThat(m.errorDetail()).isEqualTo("interrupted");
                assertThat(m.text()).isEqualTo("Half");
            });
        }
    }

    @Test
    void deletingAKeyUnbindsItsAgents() throws Exception {
        try (AgentStore store = new AgentStore(dir.resolve("agent.db"), clock)) {
            store.open();
            store.addKey(new KeyRow("k1", "anthropic", "Personal", "cdef", 1, "d-1"));
            store.setBinding("manager", "k1", "anthropic", "claude-sonnet-5-5");
            assertThat(store.deleteKey("k1")).containsExactly("manager");
            assertThat(store.agent("manager").keyId()).isNull();
            assertThat(store.keys()).isEmpty();
        }
    }

    /** Each write names only its own columns, so it leaves the others as they are, whoever wrote them. */
    @Test
    void eachWriteChangesOnlyItsOwnColumns() throws Exception {
        try (AgentStore store = new AgentStore(dir.resolve("agent.db"), clock)) {
            store.open();
            store.setLimits("manager", "{\"day\":1}");
            store.addUnseen("manager");
            store.addUnseen("manager");
            store.setBinding("manager", "k1", "anthropic", "m1");
            store.setNameAndBadge("manager", "Max", true, null);
            assertThat(store.agent("manager")).isEqualTo(new AgentRow("manager", "Max", "manager",
                    clock.millis(), "k1", "anthropic", "m1", true, false, 2, "{\"day\":1}"));

            store.clearUnseen("manager");
            store.setNameAndBadge("manager", null, null, null);
            assertThat(store.agent("manager")).isEqualTo(new AgentRow("manager", "Max", "manager",
                    clock.millis(), "k1", "anthropic", "m1", true, false, 0, "{\"day\":1}"));
            assertThatThrownBy(() -> store.addUnseen("nobody")).isInstanceOf(SQLException.class);
        }
    }

    /** design 9.4: a hidden badge comes back after a change of provider, until it's dismissed. */
    @Test
    void aHiddenBadgeGetsItsNoticeWhenTheProviderChanges() throws Exception {
        try (AgentStore store = new AgentStore(dir.resolve("agent.db"), clock)) {
            store.open();
            store.setNameAndBadge("manager", null, true, null);
            store.setBinding("manager", "k1", "anthropic", "m1");
            assertThat(store.agent("manager").badgeNotice()).as("a first binding").isFalse();
            store.setBinding("manager", "k2", "anthropic", "m2");
            assertThat(store.agent("manager").badgeNotice()).as("the same provider").isFalse();
            store.setBinding("manager", "k3", "openai", "m3");
            assertThat(store.agent("manager").badgeNotice()).as("another provider").isTrue();
            store.setBinding("manager", "k3", "openai", "m4");
            assertThat(store.agent("manager").badgeNotice()).as("until dismissed").isTrue();

            store.setNameAndBadge("manager", null, null, false);
            assertThat(store.agent("manager").badgeNotice()).isFalse();
            store.setNameAndBadge("manager", null, false, null);
            store.setBinding("manager", "k4", "xai", "m5");
            assertThat(store.agent("manager").badgeNotice()).as("a badge that isn't hidden").isFalse();
            assertThat(store.agent("manager").provider()).isEqualTo("xai");
        }
    }
}
