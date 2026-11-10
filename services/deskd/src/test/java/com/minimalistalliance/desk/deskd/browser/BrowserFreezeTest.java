package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * What a desk nobody looks at does (ADR 0045, API.md section 10): its media goes, its Chromium freezes once nothing works
 * it, and anything that wants Chromium thaws it first. The whole Browser module, with FakeCdp, a fake desk-rtc and the stub
 * units.sock, which freezes and thaws as the image's desk-units does.
 */
class BrowserFreezeTest {

    private static final String FREEZE = "freeze desk-browser";
    private static final String THAW = "thaw desk-browser";
    private static final String START_BROWSER = "start desk-browser";
    private static final String STOP_BROWSER = "stop desk-browser";
    private static final String STOP_STREAM = "stop desk-stream";
    private static final String BROWSER = "desk-browser";

    private static final DeskAttention.Timing ATTENTION = new DeskAttention.Timing(Duration.ofMillis(100));
    /** Nobody looking for 300 ms, and no work for 800 ms. */
    private static final BrowserFreeze.Timing TIMING = new BrowserFreeze.Timing(
            Duration.ofMillis(300),
            Duration.ofMillis(800),
            Duration.ofMillis(200),
            Duration.ofSeconds(3),
            Duration.ofMillis(50),
            Duration.ofSeconds(3),
            Duration.ofSeconds(2));
    /** Long enough that a freeze would have come, with room for a loaded machine's delays. */
    private static final Duration WELL_PAST_THE_GRACE = Duration.ofMillis(2000);
    private static final Duration A_WHILE = Duration.ofSeconds(10);

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private BrowserRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (cdp != null) {
            cdp.close();
        }
    }

    /** With the thaw every deskd starts with already answered and left out of the stub's requests. */
    private TestClient start(String... pages) throws Exception {
        addPages(pages);
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, ATTENTION, TIMING);
        return rig.connect("cs-a");
    }

    /** With the stub set up first, for what deskd does as it starts, and that thaw left in the stub's requests. */
    private TestClient start(java.util.function.Consumer<com.minimalistalliance.desk.deskd.testing.StubUnitsSocket> before, String... pages)
            throws Exception {
        addPages(pages);
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, ATTENTION, TIMING, before);
        return rig.connect("cs-a");
    }

    private void addPages(String... pages) throws Exception {
        cdp = new FakeCdp();
        for (String page : pages) {
            cdp.addPage(page, "https://example.com/" + page, "Title " + page);
        }
    }

    private Map<String, Object> look(TestClient client, boolean seen) throws Exception {
        Map<String, Object> reply = rig.call(client, "desk.attention.set", Map.of("seen", seen), null);
        assertThat(reply).containsEntry("_kind", "RES");
        return reply;
    }

    private void live(TestClient client) throws Exception {
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "live"), null))
                .containsEntry("_kind", "RES")
                .containsEntry("state", "live");
    }

    /** The desk looked at, live, and then nobody looking: the start of most of these. */
    private TestClient liveThenUnseen(String... pages) throws Exception {
        TestClient client = start(pages);
        look(client, true);
        live(client);
        awaitVideo("cs-a true");
        look(client, false);
        return client;
    }

    private long count(String request) {
        return rig.units.requests().stream().filter(request::equals).count();
    }

    private void awaitFrozen() {
        await().atMost(A_WHILE).until(() -> rig.units.isFrozen(BROWSER) && rig.module.browserFrozen());
    }

    private void assertNoFreezeFor(Duration time) {
        long before = count(FREEZE);
        await().during(time).atMost(time.plusSeconds(5)).until(() -> count(FREEZE) == before && !rig.units.isFrozen(BROWSER));
    }

    /** Waits for this session.video, passing over any other message from deskd. */
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

    /** Every session.video for the next while. */
    private List<String> videoFor(long millis) throws Exception {
        List<String> video = new java.util.ArrayList<>();
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(millis);
        while (System.nanoTime() < deadline) {
            Map<String, Object> message = rig.fake.pollJson(50);
            if (message != null && "session.video".equals(message.get("t"))) {
                video.add(message.get("sessionId") + " " + message.get("view"));
            }
        }
        return video;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> health(String part) {
        return (Map<String, Object>) rig.module.health().get(part);
    }

    /** The request's index among units.sock's requests, from the end. */
    private List<String> requestsAfter(String request) {
        List<String> requests = rig.units.requests();
        return requests.subList(requests.lastIndexOf(request) + 1, requests.size());
    }

    /** A call is parked waiting for the thaw: from here, nothing it does can have reached Chromium. */
    private void awaitParkedForTheThaw() {
        await().atMost(A_WHILE).until(() -> rig.module.freeze().waitingForThaw() >= 1);
        assertThat(rig.module.freeze().cdpAllowed()).isFalse();
    }

    private Map<String, Object> nextAttention(TestClient client) throws Exception {
        Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(event).containsEntry("type", "snapshot");
        return Json.object(event, "data");
    }

    // ---- nobody looking

    @Test
    void aDeskNobodyLooksAtLosesItsMediaThenFreezesAndALookThawsIt() throws Exception {
        TestClient client = liveThenUnseen("a");
        long unseen = System.nanoTime();

        // The media goes after the stream's grace, and desk-stream stays up, paused, so a look is warm to live.
        awaitVideo("cs-a false");
        assertThat(rig.units.requests()).doesNotContain(STOP_STREAM, FREEZE);

        awaitFrozen();
        assertThat(System.nanoTime() - unseen).isGreaterThanOrEqualTo(TIMING.freezeGrace().toNanos());
        await().until(() -> !cdp.isConnected());
        assertThat(health("browser")).containsEntry("freeze", "frozen");
        assertThat(health("stream")).containsEntry("seen", false).containsEntry("wanted", "live");

        // A look thaws at once, and the media comes back with no new live.
        assertThat(look(client, true)).containsEntry("seen", true);
        awaitVideo("cs-a true");
        await().atMost(A_WHILE).until(() -> !rig.units.isFrozen(BROWSER) && !rig.module.browserFrozen());
        assertThat(requestsAfter(FREEZE)).startsWith(THAW);
        live(client);
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER, STOP_STREAM);
        assertThat(health("browser")).containsEntry("freeze", "running");
    }

    @Test
    void aSessionThatNeverSaysCountsAsLookingWhileItWantsTheStream() throws Exception {
        TestClient client = start("a");
        live(client);
        awaitVideo("cs-a true");
        assertNoFreezeFor(WELL_PAST_THE_GRACE);
        assertThat(videoFor(200)).doesNotContain("cs-a false");
        assertThat(health("stream")).containsEntry("seen", true);

        // Off, nobody looks, and the desk freezes.
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "off"), null)).containsEntry("state", "off");
        awaitFrozen();
    }

    /** Design 6.1: with no Browser window open, Chromium freezes though the member looks at the desk, for its Notebook say. */
    @Test
    void aDeskLookedAtWithNoBrowserWindowOpenFreezesTooAndALookThawsItEarly() throws Exception {
        TestClient client = start("a");
        look(client, true);
        live(client);
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "off"), null)).containsEntry("state", "off");
        awaitFrozen();
        assertThat(health("stream")).containsEntry("seen", true);

        // Looking away and back thaws at once, before any live, and the next freeze waits out the work grace.
        look(client, false);
        look(client, true);
        await().atMost(A_WHILE).until(() -> !rig.units.isFrozen(BROWSER));
        long thawed = System.nanoTime();
        awaitFrozen();
        assertThat(System.nanoTime() - thawed).isGreaterThanOrEqualTo(TIMING.workGrace().toNanos() / 2);

        rig.units.clearRequests();
        live(client);
        assertThat(rig.units.requests()).startsWith(THAW, START_BROWSER);
        assertNoFreezeFor(WELL_PAST_THE_GRACE);
    }

    @Test
    void aSessionThatSaysNoWinsOverNothingButAnotherThatSaysYesWins() throws Exception {
        TestClient a = start("a");
        TestClient b = rig.connect("cs-b");
        look(a, true);
        live(a);
        assertThat(look(b, false)).containsEntry("seen", true);
        assertNoFreezeFor(WELL_PAST_THE_GRACE);
        assertThat(look(a, false)).containsEntry("seen", false);
        awaitFrozen();
        // A session that ends says nothing any more.
        assertThat(look(a, true)).containsEntry("seen", true);
        rig.sessions.close("cs-a", 1000, "closed_by_client");
        await().until(() -> Boolean.FALSE.equals(health("stream").get("seen")));
    }

    @Test
    void theTopicSaysWhetherTheDeskIsSeenAndFrozen() throws Exception {
        TestClient client = start("a");
        look(client, true);
        live(client);
        assertThat(client.subscribe(DeskAttention.TOPIC, null)).containsEntry("_kind", "RES");
        assertThat(nextAttention(client)).isEqualTo(Map.of("seen", true, "frozen", false));
        look(client, false);
        assertThat(nextAttention(client)).isEqualTo(Map.of("seen", false, "frozen", false));
        assertThat(nextAttention(client)).isEqualTo(Map.of("seen", false, "frozen", true));
        assertThat(look(client, true)).containsEntry("seen", true);
        Map<String, Object> next = nextAttention(client);
        if (Boolean.TRUE.equals(next.get("frozen"))) {
            // "Resuming": seen, and not yet thawed.
            assertThat(next).isEqualTo(Map.of("seen", true, "frozen", true));
            next = nextAttention(client);
        }
        assertThat(next).isEqualTo(Map.of("seen", true, "frozen", false));
    }

    @Test
    void onlyTheOwnersSessionsMaySayOrHear() throws Exception {
        start("a");
        TestClient export = rig.open("cs-x", "export", false, false);
        export.hello();
        assertThat(rig.call(export, "desk.attention.set", Map.of("seen", true), null))
                .containsEntry("_kind", "ERR")
                .containsEntry("code", "forbidden")
                .containsEntry("details", Map.of("reason", "scope"));
        assertThat(export.subscribe(DeskAttention.TOPIC, null)).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
        assertThat(health("stream")).containsEntry("seen", false);
    }

    @Test
    void seenHasToBeABoolean() throws Exception {
        TestClient client = start("a");
        assertThat(rig.call(client, "desk.attention.set", Map.of("seen", "yes"), null))
                .containsEntry("_kind", "ERR")
                .containsEntry("code", "bad_request")
                .containsEntry("details", Map.of("reason", "seen"));
    }

    /**
     * The office's order for the desk it now looks at, on a session of its own: {@code live} first, then {@code seen: true}.
     * The live thaws first, the media comes and never flaps, and nothing freezes it again.
     */
    @Test
    void aNewSessionThatSendsLiveThenSeenThawsFirstAndNeverFlaps() throws Exception {
        TestClient first = liveThenUnseen("a");
        awaitFrozen();
        TestClient office = rig.connect("cs-b");
        rig.units.clearRequests();
        live(office);
        assertThat(rig.units.requests()).startsWith(THAW, START_BROWSER);
        awaitVideo("cs-b true");
        assertThat(look(office, true)).containsEntry("seen", true).containsEntry("frozen", false);
        assertThat(videoFor(300)).doesNotContain("cs-b false");
        assertThat(rig.call(office, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");
        assertNoFreezeFor(WELL_PAST_THE_GRACE);
        assertThat(look(first, false)).containsEntry("seen", true);
    }

    /**
     * The export page looks at no desk, so a desk being exported is unseen and freezes. Its parts, manifest and reads go to
     * desk-data and never to Chromium, so they carry on frozen, and only data.browser.cookies thaws it first.
     */
    @Test
    void aDeskBeingExportedFreezesAndItsDataReadsOnWithoutAThaw() throws Exception {
        liveThenUnseen("a");
        byte[] note = "a note, exported while the Browser is frozen".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try (com.minimalistalliance.desk.deskd.testing.FakeDataHelper helper =
                new com.minimalistalliance.desk.deskd.testing.FakeDataHelper(dir.resolve("data.sock"))) {
            helper.part("files", "Files");
            helper.file("files", "note.txt", note);
            Path volume = Files.createDirectories(dir.resolve("volume"));
            com.minimalistalliance.desk.deskd.data.DataModule data = new com.minimalistalliance.desk.deskd.data.DataModule(
                    rig.sessions, rig.dispatcher, rig.module, dir.resolve("data.sock"), null, () -> "boot-1",
                    new com.minimalistalliance.desk.deskd.platform.DataVolume(volume), java.time.Clock.systemUTC(),
                    com.minimalistalliance.desk.deskd.data.DataModule.Timing.DEFAULT);
            try {
                awaitFrozen();
                rig.units.clearRequests();
                TestClient export = rig.open("cs-x", "export", false, false);
                export.hello();

                assertThat(rig.call(export, "data.parts.list", Map.of(), null)).containsEntry("_kind", "RES");
                assertThat(rig.call(export, "data.manifest", Map.of("part", "files"), null)).containsEntry("_kind", "RES");
                Map<String, Object> read = rig.call(export, "data.read", Map.of("part", "files", "path", "note.txt", "offset", 0), null);
                assertThat(read).containsEntry("_kind", "RES");
                long transfer = ((Number) read.get("transferId")).longValue();
                java.io.ByteArrayOutputStream got = new java.io.ByteArrayOutputStream();
                while (true) {
                    com.minimalistalliance.desk.deskd.protocol.Frame frame = export.next(Channels.BULK);
                    assertThat(frame.id()).isEqualTo(transfer);
                    if ((frame.flags() & com.minimalistalliance.desk.deskd.protocol.Frame.END) != 0) {
                        break;
                    }
                    got.write(frame.payload());
                }
                assertThat(got.toByteArray()).isEqualTo(note);
                assertThat(rig.units.requests()).isEmpty();
                assertThat(rig.units.isFrozen(BROWSER)).isTrue();
                assertThat(rig.module.browserFrozen()).isTrue();

                // The cookies' digests need Chromium: a thaw first.
                assertThat(rig.call(export, "data.browser.cookies", Map.of(), null)).containsEntry("_kind", "RES");
                assertThat(rig.units.requests()).startsWith(THAW);
                assertThat(rig.units.isFrozen(BROWSER)).isFalse();
                assertThat(cdp.commands("Storage.getCookies")).hasSize(1);
            } finally {
                data.close();
            }
        }
    }

    // ---- no freeze while it works

    @Test
    void noFreezeWhileCallsKeepComing() throws Exception {
        TestClient client = liveThenUnseen("a");
        long until = System.nanoTime() + WELL_PAST_THE_GRACE.toNanos();
        while (System.nanoTime() < until) {
            assertThat(rig.call(client, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");
            assertThat(rig.units.isFrozen(BROWSER)).isFalse();
            Thread.sleep(100);
        }
        assertThat(count(FREEZE)).isZero();
        awaitFrozen();
    }

    @Test
    void noFreezeWhileACallIsInFlight() throws Exception {
        liveThenUnseen("a");
        BrowserFreeze.Use use = rig.module.freeze().use();
        assertNoFreezeFor(WELL_PAST_THE_GRACE);
        use.close();
        long ended = System.nanoTime();
        awaitFrozen();
        assertThat(System.nanoTime() - ended).isGreaterThanOrEqualTo(TIMING.workGrace().toNanos());
    }

    @Test
    void noFreezeWhileInputComesAndInputThawsAFrozenDesk() throws Exception {
        liveThenUnseen("a");
        long until = System.nanoTime() + WELL_PAST_THE_GRACE.toNanos();
        while (System.nanoTime() < until) {
            rig.fake.sendJson(Map.of("t", "input.activity", "sessionId", "cs-a", "at", Instant.now().toString()));
            assertThat(rig.units.isFrozen(BROWSER)).isFalse();
            Thread.sleep(100);
        }
        awaitFrozen();
        rig.fake.sendJson(Map.of("t", "input.activity", "sessionId", "cs-a", "at", Instant.now().toString()));
        await().atMost(A_WHILE).until(() -> !rig.units.isFrozen(BROWSER));
        assertThat(requestsAfter(FREEZE)).containsExactly(THAW);
    }

    @Test
    void noFreezeWhileATabLoads() throws Exception {
        TestClient client = liveThenUnseen("a");
        // A subscriber keeps the connection, so deskd hears the page.
        assertThat(client.subscribe(BrowserTabs.TOPIC, null)).containsEntry("_kind", "RES");
        await().until(() -> !cdp.commands("Page.enable").isEmpty());
        String session = FakeCdp.sessionOf("a");
        cdp.event("Page.frameStartedLoading", Map.of("frameId", "a"), session);
        assertNoFreezeFor(WELL_PAST_THE_GRACE);
        cdp.event("Page.frameStoppedLoading", Map.of("frameId", "a"), session);
        awaitFrozen();
        await().until(() -> !cdp.isConnected());
    }

    @ParameterizedTest
    @ValueSource(strings = {"err busy sound", "err busy download", "err busy network", "err busy a reason from a later image"})
    void noFreezeWhileTheDeskSaysItsBusyForAnyReason(String busy) throws Exception {
        liveThenUnseen("a");
        rig.units.reply(FREEZE, busy);
        // Asked, told no, and asked again later, with nothing to thaw.
        await().atMost(A_WHILE).until(() -> count(FREEZE) >= 2);
        assertThat(rig.units.requests()).doesNotContain(THAW);
        assertThat(rig.module.browserFrozen()).isFalse();
        assertThat(health("browser")).containsEntry("freeze", "running");
        // The connection comes back for whatever wants it in between.
        TestClient other = rig.connect("cs-b");
        assertThat(rig.call(other, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");

        rig.units.replyOk(FREEZE);
        awaitFrozen();
    }

    // ---- a thaw before every call

    @Test
    void aThawComesBeforeAnyCallReachesChromium() throws Exception {
        TestClient client = liveThenUnseen("a");
        List<String> methods = List.of("browser.tab.list", "browser.tab.navigate", "browser.text.insert", "browser.tab.reload");
        for (String method : methods) {
            awaitFrozen();
            rig.units.hold(THAW);
            cdp.clearCommands();
            Map<String, Object> params = switch (method) {
                case "browser.tab.navigate" -> Map.of("url", "https://example.com/next", "tabId", "a");
                case "browser.text.insert" -> Map.of("text", "hi", "tabId", "a");
                case "browser.tab.reload" -> Map.of("tabId", "a");
                default -> Map.of();
            };
            long id = rig.send(client, method, params, UUID.randomUUID().toString());
            rig.units.awaitHeld(THAW);
            awaitParkedForTheThaw();
            assertThat(cdp.commands()).as(method).isEmpty();
            assertThat(cdp.isConnected()).as(method).isFalse();
            rig.units.release(THAW);
            Map<String, Object> reply = client.nextReply();
            assertThat(reply).as(method).containsEntry("_id", id).containsEntry("_kind", "RES");
        }
    }

    @Test
    void aSubscriptionACookieReadAndAClipboardReadThawFirst() throws Exception {
        TestClient client = liveThenUnseen("a");
        awaitFrozen();
        rig.units.hold(THAW);
        long sub = rig.sendSub(client, BrowserTabs.TOPIC);
        rig.units.awaitHeld(THAW);
        awaitParkedForTheThaw();
        assertThat(cdp.isConnected()).isFalse();
        rig.units.release(THAW);
        assertThat(client.nextReply()).containsEntry("_id", sub).containsEntry("_kind", "RES");

        rig.units.clearRequests();
        rig.call(client, "desk.attention.set", Map.of("seen", false), null);
        await().atMost(A_WHILE).until(() -> count(FREEZE) == 1 && rig.units.isFrozen(BROWSER));
        rig.units.hold(THAW);
        CompletableFuture<List<Map<String, Object>>> cookies = CompletableFuture.supplyAsync(() -> {
            try {
                return rig.module.cookies();
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        rig.units.awaitHeld(THAW);
        awaitParkedForTheThaw();
        assertThat(cdp.commands("Storage.getCookies")).isEmpty();
        rig.units.release(THAW);
        cookies.get(10, TimeUnit.SECONDS);
        assertThat(cdp.commands("Storage.getCookies")).hasSize(1);

        rig.units.clearRequests();
        await().atMost(A_WHILE).until(() -> count(FREEZE) == 1 && rig.units.isFrozen(BROWSER));
        rig.fake.autoClipboard(true);
        rig.units.hold(THAW);
        long read = rig.send(client, "browser.clipboard.read", Map.of(), null);
        rig.units.awaitHeld(THAW);
        awaitParkedForTheThaw();
        assertThat(rig.fake.pollFrame(client.handle(), Channels.RPC, 0)).isNull();
        rig.units.release(THAW);
        assertThat(client.nextReply()).containsEntry("_id", read).containsEntry("_kind", "RES");
    }

    @Test
    void aLiveThawsBeforeItsUnitsAreAsked() throws Exception {
        TestClient client = liveThenUnseen("a");
        awaitFrozen();
        rig.units.clearRequests();
        rig.units.hold(THAW);
        long id = rig.send(client, "browser.stream.set", Map.of("state", "live"), null);
        rig.units.awaitHeld(THAW);
        awaitParkedForTheThaw();
        assertThat(rig.units.requests()).containsExactly(THAW);
        rig.units.release(THAW);
        assertThat(client.nextReply()).containsEntry("_id", id).containsEntry("state", "live");
        assertThat(rig.units.requests()).startsWith(THAW, START_BROWSER);
    }

    // ---- never racing a hold, a restart or the age gate

    @Test
    void aHoldWaitsForAFreezeOnItsWayThenThawsBeforeItsStop() throws Exception {
        liveThenUnseen("a");
        rig.units.hold(FREEZE);
        rig.units.awaitHeld(FREEZE);
        CompletableFuture<Void> held = rig.module.holdBrowser();
        // The hold's stop is pinned, waiting on the freeze that's out.
        await().atMost(A_WHILE).until(() -> rig.module.freeze().pinned() == 1 && rig.module.freeze().waitingForThaw() == 1);
        assertThat(rig.units.requests()).doesNotContain(STOP_BROWSER);
        rig.units.release(FREEZE);
        held.get(10, TimeUnit.SECONDS);
        assertThat(requestsAfter(FREEZE)).containsExactly(THAW, STOP_BROWSER);
        assertThat(rig.units.isRunning(BROWSER)).isFalse();
        assertThat(rig.units.isFrozen(BROWSER)).isFalse();

        // Held, it's never frozen.
        assertNoFreezeFor(WELL_PAST_THE_GRACE);
        rig.module.releaseBrowser();
        await().atMost(A_WHILE).until(() -> rig.units.isRunning(BROWSER));
        long started = System.nanoTime();
        awaitFrozen();
        assertThat(System.nanoTime() - started).isGreaterThanOrEqualTo(TIMING.workGrace().toNanos() / 2);
    }

    @Test
    void aRestartForThePolicyThawsFirstAndAShutGateKeepsTheFreezeAway() throws Exception {
        liveThenUnseen("a");
        AtomicBoolean gate = new AtomicBoolean(true);
        rig.module.stream().ageGateFrom(gate::get, Duration.ofSeconds(10));
        awaitFrozen();

        rig.module.stream().restartForPolicy();
        await().atMost(A_WHILE).until(() -> requestsAfter(FREEZE).contains(START_BROWSER));
        assertThat(requestsAfter(FREEZE)).containsExactly(THAW, STOP_BROWSER, START_BROWSER);
        assertThat(rig.units.isFrozen(BROWSER)).isFalse();

        gate.set(false);
        assertNoFreezeFor(WELL_PAST_THE_GRACE);
        gate.set(true);
        awaitFrozen();
    }

    // ---- on any doubt, thaw

    @ParameterizedTest
    @ValueSource(strings = {"err timeout freeze desk-browser took over 5 s", "err failed freeze desk-browser: boom", "garbage"})
    void aFreezeThatFailsIsThawedAtOnceAndNotTriedAgainForAWhile(String reply) throws Exception {
        TestClient client = liveThenUnseen("a");
        rig.units.reply(FREEZE, reply);
        await().atMost(A_WHILE).until(() -> rig.units.requests().contains(THAW));
        assertThat(requestsAfter(FREEZE)).containsExactly(THAW);
        await().until(() -> !rig.module.browserFrozen());
        assertThat(health("browser")).containsEntry("freeze", "running");
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");
        // failRetry is 3 s.
        assertThat(count(FREEZE)).isEqualTo(1);
        assertNoFreezeFor(Duration.ofMillis(1500));
    }

    @Test
    void aThawThatFailsIsTriedAgainUntilItWorksAndCallsFindChromiumUnreachableMeanwhile() throws Exception {
        TestClient client = liveThenUnseen("a");
        awaitFrozen();
        rig.units.reply(THAW, "err failed thaw desk-browser: boom");
        look(client, true);
        await().atMost(A_WHILE).until(() -> count(THAW) >= 3);
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null))
                .containsEntry("_kind", "ERR")
                .containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("reason", "chromium"));
        assertThat(rig.module.browserFrozen()).isTrue();
        assertThat(cdp.isConnected()).isFalse();

        rig.units.replyOk(THAW);
        await().atMost(A_WHILE).until(() -> !rig.units.isFrozen(BROWSER) && !rig.module.browserFrozen());
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");
    }

    @Test
    void anImageThatCantFreezeIsAskedOnceAndNeverThawed() throws Exception {
        TestClient client = liveThenUnseen("a");
        rig.units.reply(FREEZE, "err bad_request expected: start|stop <unit>");
        await().atMost(A_WHILE).until(() -> count(FREEZE) == 1);
        await().until(() -> "unsupported".equals(health("browser").get("freeze")));
        assertNoFreezeFor(WELL_PAST_THE_GRACE);
        assertThat(rig.units.requests()).doesNotContain(THAW);
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");
        // The media still goes: that needs nothing of the image.
        assertThat(rig.module.health().get("stream").toString()).contains("seen=false");
    }

    /**
     * systemd 257 answers a start of a running frozen unit ok and leaves it frozen, so a start that works says nothing of
     * the freeze: Chromium stays frozen to deskd until a thaw answers ok, and the thaw is tried again meanwhile.
     */
    @Test
    void aLiveWhileTheThawFailsLeavesChromiumFrozenAndTheThawIsTriedAgain() throws Exception {
        TestClient client = liveThenUnseen("a");
        awaitFrozen();
        Path marker = dir.resolve(BrowserModule.FREEZE_MARKER);
        rig.units.reply(THAW, "err failed thaw desk-browser: boom");
        rig.units.clearRequests();
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "live"), null)).containsEntry("state", "live");
        assertThat(rig.units.requests()).contains(THAW, START_BROWSER);
        assertThat(rig.units.isFrozen(BROWSER)).isTrue();
        assertThat(rig.module.browserFrozen()).isTrue();
        assertThat(health("browser")).containsEntry("freeze", "frozen");
        assertThat(marker).exists();
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null))
                .containsEntry("_kind", "ERR")
                .containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("reason", "chromium"));
        long tries = count(THAW);
        await().atMost(A_WHILE).until(() -> count(THAW) >= tries + 2);

        rig.units.replyOk(THAW);
        await().atMost(A_WHILE).until(() -> !rig.units.isFrozen(BROWSER) && !rig.module.browserFrozen());
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");
        await().until(() -> !Files.exists(marker));
    }

    /** systemd 257 refuses to stop a frozen unit, so a hold whose thaw fails fails, and says so. */
    @Test
    void aHoldWhoseThawFailsFailsAndChromiumStaysAsItWas() throws Exception {
        liveThenUnseen("a");
        awaitFrozen();
        rig.units.reply(THAW, "err failed thaw desk-browser: boom");
        CompletableFuture<Void> held = rig.module.holdBrowser();
        assertThatThrownBy(() -> held.get(10, TimeUnit.SECONDS)).hasCauseInstanceOf(UnitException.class);
        assertThat(rig.units.requests()).contains(STOP_BROWSER);
        assertThat(rig.units.isRunning(BROWSER)).isTrue();
        assertThat(rig.units.isFrozen(BROWSER)).isTrue();
        assertThat(rig.module.browserFrozen()).isTrue();
    }

    /** deskd stops before desk-browser on the way down, and systemd won't stop a frozen unit. */
    @Test
    void closingDeskdThawsChromiumFirst() throws Exception {
        liveThenUnseen("a");
        awaitFrozen();
        rig.units.clearRequests();
        rig.module.close();
        assertThat(rig.units.requests()).containsExactly(THAW);
        assertThat(rig.units.isFrozen(BROWSER)).isFalse();
        assertThat(dir.resolve(BrowserModule.FREEZE_MARKER)).doesNotExist();
        assertNoFreezeFor(WELL_PAST_THE_GRACE);
    }

    @Test
    void closingGivesUpOnAThawThatKeepsFailingOnceItsWaitIsOver() throws Exception {
        liveThenUnseen("a");
        awaitFrozen();
        rig.units.reply(THAW, "err failed thaw desk-browser: boom");
        long began = System.nanoTime();
        assertThat(rig.module.freeze().close(Duration.ofMillis(500))).isFalse();
        assertThat(System.nanoTime() - began).isLessThan(TimeUnit.SECONDS.toNanos(3));
        assertThat(count(THAW)).isGreaterThanOrEqualTo(2);
    }

    /** deskd has 5 s from SIGTERM to its last heartbeat, so a thaw that never answered doesn't get waited for again. */
    @Test
    void closingDoesntWaitOnTheStartsThawIfThatNeverWorked() throws Exception {
        start(units -> units.reply(THAW, "err timeout thaw desk-browser took over 5 s"), "a");
        await().atMost(A_WHILE).until(() -> count(THAW) >= 1);
        long began = System.nanoTime();
        rig.module.close();
        assertThat(System.nanoTime() - began).isLessThan(TimeUnit.MILLISECONDS.toNanos(500));
    }

    /** A marker that couldn't be written, or a deskd from before it, leaves no sign: every start thaws anyway. */
    @Test
    void aDeskdThatFindsChromiumFrozenWithNoMarkerThawsFirst() throws Exception {
        TestClient client = start(units -> {
            units.leaveFrozen(BROWSER);
            units.hold(THAW);
        }, "a");
        rig.units.awaitHeld(THAW);
        assertThat(rig.units.requests()).containsExactly(THAW);
        // Not known to be frozen, so not said to be, but nothing reaches it until the thaw has answered.
        assertThat(rig.module.browserFrozen()).isFalse();
        assertThat(health("browser")).containsEntry("freeze", "thawing");
        long id = rig.send(client, "browser.tab.list", Map.of(), null);
        awaitParkedForTheThaw();
        assertThat(cdp.upgrades()).isZero();
        rig.units.release(THAW);
        assertThat(client.nextReply()).containsEntry("_id", id).containsEntry("_kind", "RES");
        assertThat(rig.units.isFrozen(BROWSER)).isFalse();
        assertThat(health("browser")).containsEntry("freeze", "running");
    }

    @Test
    void aDeskdThatFindsTheMarkerThawsBeforeAnythingTouchesChromium() throws Exception {
        Files.createFile(dir.resolve(BrowserModule.FREEZE_MARKER));
        TestClient client = start(units -> {
            units.leaveFrozen(BROWSER);
            units.hold(THAW);
        }, "a");
        rig.units.awaitHeld(THAW);
        assertThat(rig.units.requests()).containsExactly(THAW);
        assertThat(rig.module.browserFrozen()).isTrue();
        long id = rig.send(client, "browser.tab.list", Map.of(), null);
        awaitParkedForTheThaw();
        assertThat(cdp.upgrades()).isZero();
        rig.units.release(THAW);
        assertThat(client.nextReply()).containsEntry("_id", id).containsEntry("_kind", "RES");
        assertThat(rig.units.isFrozen(BROWSER)).isFalse();
        await().until(() -> !Files.exists(dir.resolve(BrowserModule.FREEZE_MARKER)));
    }

    @Test
    void theMarkerIsThereOnlyWhileChromiumMayBeFrozen() throws Exception {
        TestClient client = liveThenUnseen("a");
        Path marker = dir.resolve(BrowserModule.FREEZE_MARKER);
        assertThat(marker).doesNotExist();
        awaitFrozen();
        assertThat(marker).exists();
        look(client, true);
        await().atMost(A_WHILE).until(() -> !Files.exists(marker));
    }
}
