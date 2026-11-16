package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Agent's Browser and a desk nobody looks at (ADR 0045; the draft ADR "the Agent's tools and approvals" §5, "A frozen
 * Chromium"; the Browser bar's gap 6). A freeze closes deskd's connection to Chromium, and every Agent tab with it, so a
 * run's open tabs hold the freeze off for a while after its last Browser call: a card the member answers a few minutes
 * later still finds its page. Past the hold, or once the run ends, the freeze comes as before, and an Agent call thaws a
 * frozen Chromium first. The whole Browser module, with FakeCdp, a fake desk-rtc and the stub units.sock.
 */
class AgentBrowsingFreezeTest {

    private static final String FREEZE = "freeze desk-browser";
    private static final String THAW = "thaw desk-browser";
    private static final String BROWSER = "desk-browser";
    private static final DeskAttention.Timing ATTENTION = new DeskAttention.Timing(Duration.ofMillis(100));
    /** Nobody looking for 300 ms, and no work for 800 ms, as BrowserFreezeTest has them. */
    private static final BrowserFreeze.Timing TIMING = new BrowserFreeze.Timing(
            Duration.ofMillis(300),
            Duration.ofMillis(800),
            Duration.ofMillis(200),
            Duration.ofSeconds(3),
            Duration.ofMillis(50),
            Duration.ofSeconds(3),
            Duration.ofSeconds(2));
    private static final Duration A_WHILE = Duration.ofSeconds(10);

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private BrowserRig rig;
    private AgentBrowsing agent;

    @BeforeEach
    void setUp() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("M1", "https://member.example/", "Member's page");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, ATTENTION, TIMING);
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(2), Duration.ofMillis(800), Duration.ofSeconds(2), Duration.ofMillis(10), Duration.ofMillis(50),
                Duration.ofSeconds(3)), MinifiedSwitch.fixed(true, false, false));
        agent = (AgentBrowsing) rig.module.enableAgentBrowsing(() -> false);
        // Chromium up, as a member's look at the Browser leaves it, and then nobody looking: the freeze is armed.
        TestClient client = rig.connect("cs-a");
        assertThat(rig.call(client, "desk.attention.set", Map.of("seen", true), null)).containsEntry("_kind", "RES");
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "live"), null)).containsEntry("_kind", "RES");
        awaitVideo("cs-a true");
        assertThat(rig.call(client, "desk.attention.set", Map.of("seen", false), null)).containsEntry("_kind", "RES");
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "off"), null)).containsEntry("_kind", "RES");
    }

    private void awaitVideo(String expected) throws Exception {
        long deadline = System.nanoTime() + A_WHILE.toNanos();
        while (System.nanoTime() < deadline) {
            Map<String, Object> message = rig.fake.pollJson(100);
            if (message != null && "session.video".equals(message.get("t"))
                    && expected.equals(message.get("sessionId") + " " + message.get("view"))) {
                return;
            }
        }
        throw new AssertionError("no session.video " + expected);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (cdp != null) {
            cdp.close();
        }
    }

    private long count(String request) {
        return rig.units.requests().stream().filter(request::equals).count();
    }

    private void awaitFrozen() {
        await().atMost(A_WHILE).until(() -> rig.units.isFrozen(BROWSER) && rig.module.browserFrozen());
    }

    @Test
    void aRunsOpenTabHoldsOffTheFreezeForTheHoldThenTheFreezeComesAndAnAgentCallThawsIt() throws Exception {
        agent.holdFor(Duration.ofSeconds(4));
        String id = agent.open("run-1", "https://news.example/").tabId();
        long freezesBefore = count(FREEZE);
        // Well past nobody looking (300 ms) and no work (800 ms): no freeze while the run holds its tab, and the tab is there.
        await().during(Duration.ofMillis(2500)).atMost(Duration.ofSeconds(4)).until(() -> !rig.units.isFrozen(BROWSER));
        assertThat(count(FREEZE)).isEqualTo(freezesBefore);
        assertThat(agent.holdsChromium()).isTrue();
        assertThat(agent.tab("run-1", id)).isNotNull();
        assertThat(cdp.has(id)).isTrue();

        // Past the hold: the freeze comes, the connection and the tab with it.
        awaitFrozen();
        assertThat(agent.holdsChromium()).isFalse();
        await().atMost(A_WHILE).until(() -> agent.tab("run-1", id) == null);

        // An Agent call is work: it thaws Chromium first and works.
        long thawsBefore = count(THAW);
        String again = agent.open("run-1", "https://news.example/").tabId();
        assertThat(count(THAW)).isGreaterThan(thawsBefore);
        assertThat(rig.units.isFrozen(BROWSER)).isFalse();
        assertThat(agent.tab("run-1", again)).isNotNull();
    }

    @Test
    void eachCallStartsTheHoldAgain() throws Exception {
        agent.holdFor(Duration.ofSeconds(2));
        String id = agent.open("run-1", "https://news.example/").tabId();
        for (int i = 0; i < 4; i++) {
            Thread.sleep(1000);
            agent.tabs("run-1");
            // A real call: it reaches the tab, and starts the hold again.
            agent.backUrl("run-1", id);
        }
        assertThat(rig.units.isFrozen(BROWSER)).isFalse();
        assertThat(agent.tab("run-1", id)).isNotNull();
        awaitFrozen();
    }

    @Test
    void aRunsEndLetsTheFreezeComeWithoutWaitingForTheHold() throws Exception {
        agent.holdFor(Duration.ofMinutes(10));
        String id = agent.open("run-1", "https://news.example/").tabId();
        assertThat(agent.holdsChromium()).isTrue();
        agent.runEnded("run-1");
        await().atMost(A_WHILE).until(() -> !cdp.has(id));
        assertThat(agent.holdsChromium()).isFalse();
        awaitFrozen();
    }
}
