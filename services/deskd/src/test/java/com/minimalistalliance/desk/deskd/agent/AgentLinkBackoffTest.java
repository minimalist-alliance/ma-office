package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.testing.AcceptAndDrop;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Audit D7: the backoff starts again only after a connection that lasted, not at every connect. */
class AgentLinkBackoffTest {

    @TempDir
    Path dir;

    private static final AgentLink.Listener QUIET = new AgentLink.Listener() {
        @Override
        public void connected() {}

        @Override
        public void disconnected() {}

        @Override
        public void event(long sid, String topic, String type, Map<String, Object> data) {}
    };

    @Test
    void aDeskAgentThatAcceptsAndDropsAtOnceIsTriedWithTheBackoffNotEveryFewMilliseconds() throws Exception {
        try (AcceptAndDrop peer = new AcceptAndDrop(dir.resolve("agent.sock"), 0)) {
            AgentLink link = new AgentLink(peer.socket(), new AgentLink.Timing(Duration.ofMillis(20), Duration.ofSeconds(2)));
            link.start(QUIET);
            Thread.sleep(1500);
            link.close();
            // 20, 40, 80, 160, 320, 640 ms between tries: about 7 in 1.5 s. Starting again at each connect made it one
            // every 20 ms, about 70 (with the real 250 ms, four a second for ever).
            assertThat(peer.accepts.size()).isBetween(3, 14);
        }
    }

    @Test
    void aConnectionThatLastedStartsTheBackoffAgain() throws Exception {
        try (AcceptAndDrop peer = new AcceptAndDrop(dir.resolve("agent.sock"), 300)) {
            AgentLink link = new AgentLink(peer.socket(),
                    new AgentLink.Timing(Duration.ofMillis(20), Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofMillis(200)));
            link.start(QUIET);
            Thread.sleep(2000);
            link.close();
            List<Long> at = peer.accepts;
            List<Long> waits = new ArrayList<>();
            for (int i = 1; i < at.size(); i++) {
                waits.add(TimeUnit.NANOSECONDS.toMillis(at.get(i) - at.get(i - 1)) - 300);
            }
            // Each lasted 300 ms, past the 200 ms that counts, so each retry is the shortest gap again, not a growing one.
            assertThat(waits).hasSizeGreaterThanOrEqualTo(4);
            assertThat(waits).allSatisfy(wait -> assertThat(wait).isLessThan(150L));
        }
    }
}
