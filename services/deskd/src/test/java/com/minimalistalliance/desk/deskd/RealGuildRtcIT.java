package com.minimalistalliance.desk.deskd;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.rtc.RtcListener;
import com.minimalistalliance.desk.deskd.rtc.RtcStats;
import java.net.ServerSocket;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * deskd's {@link RtcClient} as a Guild Desk against the real {@code desk-rtc} binary ({@code DESK_RTC_DIST}, built by
 * {@code services/scripts/test-against-desk-rtc.sh} from the tree's {@code desk-rtc/}). Only what needs no WebRTC peer:
 * configure, its echo, and stats with an ack. Sessions, final counts and the budget are the Go tests' and
 * {@code RtcClientGuildTest}'s, which also cover a 0.3.x desk-rtc; this tree's {@code desk-rtc} is 0.4.0 or later.
 */
@EnabledIfEnvironmentVariable(named = "DESK_RTC_DIST", matches = ".+")
class RealGuildRtcIT {

    @TempDir
    Path dir;

    private Process deskRtc;
    private RtcClient rtc;

    @BeforeEach
    void setUp() throws Exception {
        Path dist = Path.of(System.getenv("DESK_RTC_DIST"));
        int port;
        try (ServerSocket socket = new ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        deskRtc = new ProcessBuilder(
                        dist.resolve("desk-rtc").toString(),
                        "--socket", dir.resolve("rtc.sock").toString(),
                        "--data-dir", dir.resolve("rtc-data").toString(),
                        "--bind", "127.0.0.1",
                        "--port", Integer.toString(port))
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("desk-rtc.log").toFile()))
                .start();
        rtc = new RtcClient(new RtcClient.Config(dir.resolve("rtc.sock"), () -> 600, () -> "127.0.0.1", () -> true, 3));
        rtc.start(new RtcListener() {});
        await().atMost(Duration.ofSeconds(20)).until(rtc::isConfigured);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (rtc != null) {
            rtc.close();
        }
        if (deskRtc != null) {
            deskRtc.destroy();
            if (!deskRtc.waitFor(5, TimeUnit.SECONDS)) {
                deskRtc.destroyForcibly();
            }
        }
    }

    @Test
    void aGuildConfigureIsEchoedWithTheCreditDeskdAsked() {
        assertThat(rtc.deskRtcHasFinalCounts()).isTrue();
        assertThat(rtc.sessionCredit()).isEqualTo(RtcClient.GUILD_CREDIT).isEqualTo(64 * 1024);
    }

    @Test
    void aStatsGetWithAnAckIsAnsweredAndTheAckTaken() throws Exception {
        List<String> acked = new CopyOnWriteArrayList<>();
        rtc.closedRows(new RtcClient.ClosedRows() {
            @Override
            public Collection<String> toAck() {
                return new ArrayList<>(List.of("cs-never-existed"));
            }

            @Override
            public void acked(Collection<String> sessionIds) {
                acked.addAll(sessionIds);
            }
        });
        RtcStats stats = rtc.stats();
        assertThat(stats.sessions()).isEmpty();
        // desk-rtc forgets an id it does not have, and the reply comes either way.
        assertThat(acked).containsExactly("cs-never-existed");
    }
}
