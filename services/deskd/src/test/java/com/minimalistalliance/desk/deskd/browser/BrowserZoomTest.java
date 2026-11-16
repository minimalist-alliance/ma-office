package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Browser's zoom (API.md section 10, "Zoom") through a client's frames, against a fake debugging port that plays
 * Chromium's default zoom as {@code chrome.settingsPrivate} has it in its hidden Password Manager page, and each tab's page
 * zoom as {@code Page.getLayoutMetrics} reads it: a site's own level beats the default, and setting the default to a site's
 * level erases the site's, as Chrome for Testing 156 and 158 do (docs/sub-status/browser-zoom.md).
 */
class BrowserZoomTest {

    private static final Duration A_WHILE = Duration.ofSeconds(10);
    private static final BrowserZoom.Timing QUICK = new BrowserZoom.Timing(
            Duration.ofMillis(50), Duration.ofMillis(100), Duration.ofMillis(1500), Duration.ofMillis(400), Duration.ofMillis(300),
            Duration.ofSeconds(2));
    private static final String CALL = "Runtime.callFunctionOn";

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private BrowserRig rig;
    private BrowserZoom zoom;
    /** Chromium's default zoom. */
    private volatile double defaultZoom = 1;
    /** A site's own zoom, by the tab's session. */
    private final Map<String, Double> siteZoom = new ConcurrentHashMap<>();
    /** Every default deskd set, in order. */
    private final List<Double> defaultsSet = new CopyOnWriteArrayList<>();
    private volatile boolean pageLoads = true;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (cdp != null) {
            cdp.close();
        }
    }

    private void start(String... pages) throws Exception {
        cdp = new FakeCdp();
        for (String page : pages) {
            cdp.addPage(page, "https://example.com/" + page, "Title " + page);
        }
        playChromium();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        zoom = rig.module.enableZoom(dir, QUICK);
    }

    /** Restarts deskd only: a new module on the same directory and the same Chromium. */
    private void restartDeskd() throws Exception {
        rig.close();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        zoom = rig.module.enableZoom(dir, QUICK);
    }

    private void playChromium() {
        cdp.answerExpression("chrome.settingsPrivate", command -> Map.of("result", pageLoads
                ? Map.of("type", "object", "objectId", "global-of-" + command.sessionId())
                : Map.of("type", "undefined")));
        cdp.answer(CALL, command -> {
            String function = Json.string(command.params(), "functionDeclaration");
            List<Object> args = new ArrayList<>();
            Object raw = command.params().get("arguments");
            if (raw instanceof List<?> list) {
                for (Object arg : list) {
                    args.add(((Map<?, ?>) arg).get("value"));
                }
            }
            Map<String, Object> result = new HashMap<>();
            if (BrowserZoom.GET_DEFAULT.equals(function)) {
                result.put("type", "number");
                result.put("value", defaultZoom);
            } else if (BrowserZoom.SET_DEFAULT.equals(function)) {
                double set = ((Number) args.get(0)).doubleValue();
                defaultZoom = set;
                defaultsSet.add(set);
                siteZoom.values().removeIf(level -> Math.abs(level - set) < 0.001);
                result.put("type", "boolean");
                result.put("value", true);
            } else {
                result.put("type", "undefined");
            }
            return Map.of("result", result);
        });
        cdp.answer("Page.getLayoutMetrics", command -> Map.of(
                "cssVisualViewport", Map.of("zoom", siteZoom.getOrDefault(command.sessionId(), defaultZoom), "scale", 1)));
    }

    private Map<String, Object> call(TestClient client, String method, Map<String, Object> params) throws Exception {
        return rig.call(client, method, params);
    }

    /** A session that has brought the connection up, and the sweep and the first check done. */
    private TestClient connected() throws Exception {
        TestClient client = rig.connect("cs-a");
        assertThat(call(client, "browser.tab.list", Map.of())).containsEntry("_kind", "RES");
        await().atMost(A_WHILE).until(() -> saved().get("swept") == Boolean.TRUE);
        await().atMost(A_WHILE).until(() -> !zoomPageOpen());
        return client;
    }

    private Map<String, Object> saved() {
        try {
            Path file = dir.resolve(BrowserZoom.FILE);
            return Files.exists(file) ? Json.parseObject(Files.readAllBytes(file)) : Map.of();
        } catch (Exception e) {
            return Map.of();
        }
    }

    private boolean zoomPageOpen() {
        return Boolean.TRUE.equals(zoom.health().get("page"));
    }

    private List<String> hiddenPagesOpened() {
        List<String> urls = new ArrayList<>();
        for (FakeCdp.Command command : cdp.commands("Target.createTarget")) {
            if (Boolean.TRUE.equals(command.params().get("hidden"))) {
                urls.add(Json.string(command.params(), "url"));
            }
        }
        return urls;
    }

    private Map<String, Object> awaitView(TestClient client, Predicate<Map<String, Object>> wanted) throws Exception {
        long deadline = System.nanoTime() + A_WHILE.toNanos();
        while (System.nanoTime() < deadline) {
            Frame frame = rig.fake.pollFrame(client.handle(), Channels.EVENTS, 100);
            if (frame == null) {
                continue;
            }
            Map<String, Object> data = Json.object(TestClient.parse(frame.payload()), "data");
            if (data != null && data.containsKey("mode") && wanted.test(data)) {
                return data;
            }
        }
        throw new AssertionError("no such browser.view");
    }

    private static Predicate<Map<String, Object>> zoomIs(int level) {
        return view -> Integer.valueOf(level).equals(view.get("zoom") instanceof Number n ? n.intValue() : null);
    }

    private void resized(String tab) {
        cdp.event("Page.frameResized", Map.of(), FakeCdp.sessionOf(tab));
    }

    private static void assertError(Map<String, Object> reply, String code) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", code);
    }

    // ---- a client's calls

    @Test
    void itsOneHundredAtFirstAndASetZoomsEveryTabThroughChromiumsDefaultAndIsKept() throws Exception {
        start("a", "b");
        TestClient client = connected();
        assertThat(client.subscribe("browser.view", null)).containsEntry("_kind", "RES");
        assertThat(awaitView(client, view -> true)).containsEntry("mode", "desktop").containsEntry("zoom", 100);
        assertThat(call(client, "browser.zoom.get", Map.of())).containsEntry("level", 100);

        Map<String, Object> reply = call(client, "browser.zoom.set", Map.of("level", 150));

        assertThat(reply).containsEntry("_kind", "RES").containsEntry("level", 150);
        assertThat(defaultZoom).isEqualTo(1.5);
        assertThat(saved()).containsEntry("level", 150).containsEntry("swept", true);
        awaitView(client, zoomIs(150));
        assertThat(call(client, "browser.zoom.get", Map.of())).containsEntry("level", 150);
        assertThat(rig.module.zoom().health()).containsEntry("level", 150);
        // Only Chromium's own Password Manager page, hidden, never a tab of the member's.
        assertThat(hiddenPagesOpened()).isNotEmpty().allMatch("chrome://password-manager/settings"::equals);
        assertThat(cdp.commands("Target.createTarget")).allMatch(command -> Boolean.TRUE.equals(command.params().get("hidden")));
    }

    @Test
    void twoThirdsIsChromiumsOwnStepAndOneTwoFiveIsAHundredthEach() throws Exception {
        start("a");
        TestClient client = connected();
        assertThat(call(client, "browser.zoom.set", Map.of("level", 67))).containsEntry("level", 67);
        assertThat(defaultZoom).isEqualTo(2.0 / 3);
        assertThat(call(client, "browser.zoom.set", Map.of("level", 125))).containsEntry("level", 125);
        assertThat(defaultZoom).isEqualTo(1.25);
        assertThat(call(client, "browser.zoom.set", Map.of("level", 50))).containsEntry("level", 50);
        assertThat(call(client, "browser.zoom.set", Map.of("level", 200.0))).containsEntry("level", 200);
        assertThat(defaultZoom).isEqualTo(2.0);
    }

    @Test
    void aLevelIsAWholePercentFrom50To200AndAnythingElseChangesNothing() throws Exception {
        start("a");
        TestClient client = connected();
        assertThat(call(client, "browser.zoom.set", Map.of("level", 120))).containsEntry("level", 120);
        int before = defaultsSet.size();
        List<Object> bad = new ArrayList<>(List.of(49, 201, 125.5, -100, 1e300, "150", true, List.of(150), Map.of("level", 150)));
        for (Object level : bad) {
            Map<String, Object> reply = call(client, "browser.zoom.set", Map.of("level", level));
            assertError(reply, "bad_request");
            assertThat(Json.object(reply, "details")).containsEntry("reason", "level");
        }
        Map<String, Object> nothing = new LinkedHashMap<>();
        nothing.put("level", null);
        assertError(call(client, "browser.zoom.set", nothing), "bad_request");
        assertError(call(client, "browser.zoom.set", Map.of()), "bad_request");
        assertThat(defaultsSet).hasSize(before);
        assertThat(saved()).containsEntry("level", 120);
        assertThat(call(client, "browser.zoom.get", Map.of())).containsEntry("level", 120);
    }

    @Test
    void getNeedsVideoAndSetNeedsInput() throws Exception {
        start("a");
        connected();
        TestClient watcher = rig.connect("cs-watch", true, false);
        TestClient blind = rig.connect("cs-blind", false, true);

        assertThat(call(watcher, "browser.zoom.get", Map.of())).containsEntry("level", 100);
        assertError(call(watcher, "browser.zoom.set", Map.of("level", 150)), "forbidden");
        assertError(call(blind, "browser.zoom.get", Map.of()), "forbidden");
        assertThat(saved()).containsEntry("level", 100);
        assertThat(defaultZoom).isEqualTo(1.0);
    }

    @Test
    void aSetWithNoChromiumIsKeptAndChromiumGetsItAsItsReached() throws Exception {
        start("a");
        TestClient client = rig.connect("cs-a");
        // No call has brought Chromium yet: the level is kept, and nothing went to Chromium.
        assertThat(call(client, "browser.zoom.set", Map.of("level", 175))).containsEntry("level", 175);
        assertThat(saved()).containsEntry("level", 175);

        assertThat(call(client, "browser.tab.list", Map.of())).containsEntry("_kind", "RES");

        await().atMost(A_WHILE).until(() -> defaultZoom == 1.75 && saved().get("swept") == Boolean.TRUE);
    }

    // ---- kept on the desk

    @Test
    void theLevelSurvivesDeskdAndIsSetAgainWhenChromiumLostItsOwnCopy() throws Exception {
        start("a");
        TestClient client = connected();
        assertThat(call(client, "browser.zoom.set", Map.of("level", 175))).containsEntry("level", 175);
        // Chromium lost its prefs (a new profile, a crash before they were written): its default is 100 again.
        defaultZoom = 1;
        defaultsSet.clear();

        restartDeskd();
        TestClient again = rig.connect("cs-b");
        assertThat(call(again, "browser.zoom.get", Map.of())).containsEntry("level", 175);
        assertThat(call(again, "browser.tab.list", Map.of())).containsEntry("_kind", "RES");

        await().atMost(A_WHILE).until(() -> defaultZoom == 1.75);
        // Once swept is once: only the level, no pass over Chromium's steps.
        assertThat(defaultsSet).containsExactly(1.75);
    }

    @Test
    void tabsThatNeverAnswerDontHoldASetBehindTheConnectsCheck() throws Exception {
        // Release 5 on the TEST desk: 52 tabs, most restored and not loaded, so no renderer answers a read of the zoom. At
        // the request timeout each, the check on connect held every set behind it for minutes.
        String[] pages = new String[16];
        pages[0] = "a";
        for (int i = 1; i < pages.length; i++) {
            pages[i] = "r" + i;
        }
        start(pages);
        TestClient client = connected();
        assertThat(call(client, "browser.zoom.set", Map.of("level", 150))).containsEntry("level", 150);
        int readsBefore = cdp.commands("Page.getLayoutMetrics").size();
        // No tab answers a read of its zoom (the rest of each tab's calls are answered, as Chromium does for a tab it
        // restored and hasn't loaded).
        cdp.hold("Page.getLayoutMetrics");

        restartDeskd();
        TestClient again = rig.connect("cs-b");
        assertThat(call(again, "browser.tab.list", Map.of())).containsEntry("_kind", "RES");
        // The connect's check is reading the tabs.
        await().atMost(A_WHILE).until(() -> cdp.commands("Page.getLayoutMetrics").size() >= readsBefore + 2);
        long started = System.nanoTime();
        Map<String, Object> reply = call(again, "browser.zoom.set", Map.of("level", 120));
        long tookMs = (System.nanoTime() - started) / 1_000_000;

        assertThat(reply).containsEntry("_kind", "RES").containsEntry("level", 120);
        // At most the check's budget for the tabs and one tab's read, not 15 tabs at the request timeout each.
        assertThat(tookMs).isLessThan(BrowserZoom.TABS_READ.toMillis() + 2_000);
        await().atMost(A_WHILE).until(() -> defaultZoom == 1.2);
        assertThat(saved()).containsEntry("level", 120);
        cdp.release("Page.getLayoutMetrics");
    }

    @Test
    void whenEveryTabShowsTheLevelAlreadyNoPageIsOpenedOnConnect() throws Exception {
        start("a", "b");
        TestClient client = connected();
        assertThat(call(client, "browser.zoom.set", Map.of("level", 150))).containsEntry("level", 150);
        await().atMost(A_WHILE).until(() -> !zoomPageOpen());
        int opened = hiddenPagesOpened().size();

        restartDeskd();
        TestClient again = rig.connect("cs-b");
        assertThat(call(again, "browser.tab.list", Map.of())).containsEntry("_kind", "RES");
        await().atMost(A_WHILE).until(() -> cdp.commands("Page.getLayoutMetrics").size() >= 2);
        Thread.sleep(500);

        assertThat(hiddenPagesOpened()).hasSize(opened);
        assertThat(defaultZoom).isEqualTo(1.5);
    }

    @Test
    void anUnreadableFileIsOneHundredAndNotSwept() throws Exception {
        Files.write(dir.resolve(BrowserZoom.FILE), "{\"level\": 999, \"swept\": true}".getBytes(StandardCharsets.UTF_8));
        start("a");
        TestClient client = rig.connect("cs-a");
        assertThat(call(client, "browser.zoom.get", Map.of())).containsEntry("level", 100);
    }

    @Test
    void aLinkInPlaceOfTheFileIsNotFollowed() throws Exception {
        Path elsewhere = dir.resolve("elsewhere.json");
        Files.write(elsewhere, "{\"level\": 150, \"swept\": true}".getBytes(StandardCharsets.UTF_8));
        Files.createSymbolicLink(dir.resolve(BrowserZoom.FILE), elsewhere);
        start("a");
        TestClient client = rig.connect("cs-a");
        assertThat(call(client, "browser.zoom.get", Map.of())).containsEntry("level", 100);

        assertThat(call(client, "browser.zoom.set", Map.of("level", 120))).containsEntry("level", 120);

        // Written as a file of its own in its place; what the link pointed at is untouched.
        assertThat(Files.isSymbolicLink(dir.resolve(BrowserZoom.FILE))).isFalse();
        assertThat(Json.parseObject(Files.readAllBytes(elsewhere))).containsEntry("level", 150);
        assertThat(saved()).containsEntry("level", 120);
    }

    // ---- a site's own zoom

    @Test
    void theFirstConnectionErasesEveryLevelChromiumsKeysCouldHaveLeftOnASiteOnce() throws Exception {
        start("a", "b");
        // From before: Ctrl+= in the stream left "a" at 125%.
        siteZoom.put(FakeCdp.sessionOf("a"), 1.25);
        connected();

        // Chromium's steps from 50 to 200% (never past: a page's images could be fetched again larger), then the level.
        assertThat(defaultsSet).containsExactly(0.5, 2.0 / 3, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 1.0);
        assertThat(defaultZoom).isEqualTo(1.0);
        assertThat(siteZoom).isEmpty();

        defaultsSet.clear();
        restartDeskd();
        TestClient again = rig.connect("cs-b");
        assertThat(call(again, "browser.tab.list", Map.of())).containsEntry("_kind", "RES");
        Thread.sleep(800);
        assertThat(defaultsSet).isEmpty();
    }

    @Test
    void aMembersOwnZoomFromChromiumsKeysFoldsInAndTheTopicSaysIt() throws Exception {
        start("a", "b");
        TestClient client = connected();
        assertThat(client.subscribe("browser.view", null)).containsEntry("_kind", "RES");
        awaitView(client, zoomIs(100));

        // Ctrl+= in the stream: Chromium gives that site 110%, and the tab says its frame resized.
        siteZoom.put(FakeCdp.sessionOf("a"), 1.1);
        resized("a");

        awaitView(client, zoomIs(110));
        assertThat(defaultZoom).isEqualTo(1.1);
        assertThat(siteZoom).isEmpty();
        assertThat(saved()).containsEntry("level", 110);
        assertThat(call(client, "browser.zoom.get", Map.of())).containsEntry("level", 110);
    }

    @Test
    void aKeyZoomPastTheRangeFoldsInAtItsEdge() throws Exception {
        start("a");
        TestClient client = connected();
        defaultsSet.clear();

        siteZoom.put(FakeCdp.sessionOf("a"), 2.5);
        resized("a");

        await().atMost(A_WHILE).until(() -> zoom.level() == 200);
        // To its level first, which erases the site's, then into the range.
        assertThat(defaultsSet).containsExactly(2.5, 2.0);
        assertThat(siteZoom).isEmpty();

        defaultsSet.clear();
        siteZoom.put(FakeCdp.sessionOf("a"), 1.0 / 3);
        resized("a");
        await().atMost(A_WHILE).until(() -> zoom.level() == 50);
        assertThat(defaultsSet).containsExactly(1.0 / 3, 0.5);
        assertThat(call(client, "browser.zoom.get", Map.of())).containsEntry("level", 50);
    }

    @Test
    void onlyChromiumsOwnStepsFoldInAndAZoomNoKeyMakesIsLeftOrErased() throws Exception {
        start("a");
        TestClient client = connected();
        defaultsSet.clear();

        // A level no key of Chromium's makes (a pinch reads as scale, never as this): erased, the level stays.
        siteZoom.put(FakeCdp.sessionOf("a"), 1.3);
        resized("a");
        await().atMost(A_WHILE).until(() -> defaultsSet.size() >= 2);
        assertThat(defaultsSet).containsExactly(1.3, 1.0);
        assertThat(zoom.level()).isEqualTo(100);

        // Past anything Chromium makes: nothing at all.
        defaultsSet.clear();
        siteZoom.put(FakeCdp.sessionOf("a"), 9.0);
        resized("a");
        Thread.sleep(500);
        assertThat(defaultsSet).isEmpty();
        assertThat(call(client, "browser.zoom.get", Map.of())).containsEntry("level", 100);
    }

    @Test
    void aSetToTheLevelItIsDoesNothing() throws Exception {
        start("a");
        TestClient client = connected();
        assertThat(call(client, "browser.zoom.set", Map.of("level", 140))).containsEntry("level", 140);
        int calls = cdp.commands(CALL).size();
        long written = Files.getLastModifiedTime(dir.resolve(BrowserZoom.FILE)).toMillis();
        Thread.sleep(20);

        for (int i = 0; i < 20; i++) {
            assertThat(call(client, "browser.zoom.set", Map.of("level", 140))).containsEntry("level", 140);
        }

        assertThat(cdp.commands(CALL)).hasSize(calls);
        assertThat(Files.getLastModifiedTime(dir.resolve(BrowserZoom.FILE)).toMillis()).isEqualTo(written);
    }

    @Test
    void aSitesRememberedZoomFoundAsItsPageCommitsIsErasedAndTheLevelStays() throws Exception {
        start("a");
        TestClient client = connected();
        assertThat(call(client, "browser.zoom.set", Map.of("level", 120))).containsEntry("level", 120);
        defaultsSet.clear();

        // The next page is on a site Chromium remembers at 90%.
        siteZoom.put(FakeCdp.sessionOf("a"), 0.9);
        assertThat(call(client, "browser.tab.navigate", Map.of("tabId", "a", "url", "https://remembered.example/"))).containsEntry("_kind", "RES");
        resized("a");

        await().atMost(A_WHILE).until(() -> defaultsSet.size() >= 2);
        assertThat(siteZoom).isEmpty();
        assertThat(defaultsSet).containsExactly(0.9, 1.2);
        assertThat(zoom.level()).isEqualTo(120);
        assertThat(saved()).containsEntry("level", 120);
    }

    @Test
    void nothingIsReadWhileAPhonesViewIsInPlay() throws Exception {
        start("a");
        TestClient client = connected();
        zoom.phoneFrom(() -> true);
        int reads = cdp.commands("Page.getLayoutMetrics").size();

        siteZoom.put(FakeCdp.sessionOf("a"), 1.0 / 3);
        resized("a");
        Thread.sleep(600);

        assertThat(cdp.commands("Page.getLayoutMetrics")).hasSize(reads);
        assertThat(call(client, "browser.zoom.get", Map.of())).containsEntry("level", 100);
    }

    // ---- the page

    @Test
    void thePageGoesAfterItsLingerAndComesBackForTheNextChange() throws Exception {
        start("a");
        TestClient client = connected();
        assertThat(call(client, "browser.zoom.set", Map.of("level", 130))).containsEntry("level", 130);
        assertThat(zoomPageOpen()).isTrue();
        int closes = cdp.commands("Target.closeTarget").size();

        await().atMost(A_WHILE).until(() -> !zoomPageOpen());
        assertThat(cdp.commands("Target.closeTarget")).hasSize(closes + 1);

        assertThat(call(client, "browser.zoom.set", Map.of("level", 140))).containsEntry("level", 140);
        assertThat(defaultZoom).isEqualTo(1.4);
    }

    @Test
    void aPageThatNeverLoadsKeepsTheLevelAndItsTriedAgain() throws Exception {
        start("a");
        TestClient client = connected();
        pageLoads = false;

        assertThat(call(client, "browser.zoom.set", Map.of("level", 160))).containsEntry("level", 160);
        assertThat(saved()).containsEntry("level", 160);
        assertThat(defaultZoom).isEqualTo(1.0);

        pageLoads = true;
        await().atMost(A_WHILE).until(() -> defaultZoom == 1.6);
    }

    // ---- the Agent's tabs

    @Test
    void anAgentTabIsSizedSoItsPageIsStill1280By800AtARatioOfOne() {
        assertThat(AgentBrowsing.viewport(1.0)).containsEntry("width", 1280).containsEntry("height", 800)
                .containsEntry("deviceScaleFactor", 1).containsEntry("mobile", false);
        Map<String, Object> at125 = AgentBrowsing.viewport(1.25);
        assertThat(at125).containsEntry("width", 1600).containsEntry("height", 1000).containsEntry("mobile", false);
        assertThat(((Number) at125.get("deviceScaleFactor")).doubleValue()).isEqualTo(0.8);
        Map<String, Object> at50 = AgentBrowsing.viewport(0.5);
        assertThat(at50).containsEntry("width", 640).containsEntry("height", 400);
        assertThat(((Number) at50.get("deviceScaleFactor")).doubleValue()).isEqualTo(2.0);
        assertThat(AgentBrowsing.viewport(Double.NaN)).containsEntry("width", 1280).containsEntry("deviceScaleFactor", 1);
    }

    @Test
    void theAgentIsToldEveryNewDefault() throws Exception {
        start("a");
        List<Double> told = new CopyOnWriteArrayList<>();
        zoom.agentFrom(told::add);
        TestClient client = connected();
        told.clear();

        assertThat(call(client, "browser.zoom.set", Map.of("level", 125))).containsEntry("level", 125);

        assertThat(told).last().isEqualTo(1.25);
    }
}
