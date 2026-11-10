package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.events.SessionEvents;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** The tab RPCs and the browser.tabs topic, through a client's frames, against a fake debugging port. */
@ExtendWith(OutputCaptureExtension.class)
class BrowserTabsTest {

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

    private TestClient start(String... pages) throws Exception {
        return start(BrowserRig.FAST, pages);
    }

    private TestClient start(BrowserTabs.Timing timing, String... pages) throws Exception {
        cdp = new FakeCdp();
        for (String page : pages) {
            cdp.addPage(page, "https://example.com/" + page, "Title " + page);
        }
        rig = new BrowserRig(dir, cdp.port(), timing);
        return rig.connect("cs-a");
    }

    /**
     * A read that's still waiting when a connection cut during it is known to be gone, however that's found out. The
     * cut in these tests comes just after the read's reply, and JDK 21 lost the end of input behind that in 36 of 40
     * tries, as CdpClient says. Then only the probe finds it, at up to 50 ms plus 500 ms in these timings.
     */
    private static final Duration READ_OUTLASTS_THE_PROBE = Duration.ofSeconds(2);

    /** Plenty of time, so a test decides when each part of a read finishes. */
    private static final Duration A_TEST_DECIDES = Duration.ofSeconds(20);

    private static BrowserTabs.Timing withHttp(Duration http) {
        return withCdp(BrowserRig.FAST.request(), http, BrowserRig.FAST.cdp().probe());
    }

    /**
     * A read of 6 MB of targets took 360 to 800 ms here at load 5 to 8, and everything else on that one socket waits
     * behind it, the probe included. That's for a test of a limit, not of how long Chromium gets to answer.
     */
    private static BrowserTabs.Timing withRoomForHostileSizes() {
        Duration room = Duration.ofSeconds(8);
        return withCdp(room, room, room);
    }

    private static BrowserTabs.Timing withCdp(Duration request, Duration http, Duration probe) {
        BrowserTabs.Timing fast = BrowserRig.FAST;
        CdpClient.Timing cdp = fast.cdp();
        return new BrowserTabs.Timing(
                fast.publishEvery(), fast.recentCall(), fast.callWait(), request, request, fast.navigate(), fast.settle(),
                fast.listEvery(), fast.visibility(), fast.restartEvery(),
                new CdpClient.Timing(http, cdp.open(), cdp.minBackoff(), cdp.maxBackoff(), cdp.wantCheck(), probe));
    }

    private static BrowserTabs.Timing withPublishAndList(Duration publishEvery, Duration listEvery) {
        BrowserTabs.Timing fast = BrowserRig.FAST;
        return new BrowserTabs.Timing(
                publishEvery, fast.recentCall(), fast.callWait(), fast.request(), fast.sessionWait(), fast.navigate(), fast.settle(),
                listEvery, fast.visibility(), fast.restartEvery(), fast.cdp());
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> tabs(TestClient client) throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.list", Map.of(), null);
        assertThat(reply).containsEntry("_kind", "RES");
        return (List<Map<String, Object>>) reply.get("tabs");
    }

    private Map<String, Object> tab(TestClient client, String id) throws Exception {
        return tabs(client).stream().filter(tab -> id.equals(tab.get("tabId"))).findFirst().orElseThrow();
    }

    private static List<String> ids(List<Map<String, Object>> tabs) {
        return tabs.stream().map(tab -> (String) tab.get("tabId")).toList();
    }

    private String activeOf(TestClient client) throws Exception {
        return tabs(client).stream().filter(tab -> Boolean.TRUE.equals(tab.get("active"))).map(tab -> (String) tab.get("tabId")).findFirst().orElse(null);
    }

    private static void assertErr(Map<String, Object> reply, String code) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", code);
    }

    private static void assertErr(Map<String, Object> reply, String code, Map<String, Object> details) {
        assertErr(reply, code);
        assertThat(reply).containsEntry("details", details);
    }

    // ---- browser.tab.list

    @Test
    void aTabHasExactlyTheAgreedFields() throws Exception {
        TestClient client = start("a");
        Map<String, Object> tab = tabs(client).get(0);
        assertThat(tab).containsOnlyKeys("tabId", "url", "title", "loading", "active", "canGoBack", "canGoForward");
        assertThat(tab)
                .containsEntry("tabId", "a")
                .containsEntry("url", "https://example.com/a")
                .containsEntry("title", "Title a")
                .containsEntry("loading", false)
                .containsEntry("active", true)
                .containsEntry("canGoBack", false)
                .containsEntry("canGoForward", false);
    }

    @Test
    void onlyOrdinaryMemberPagesCount() throws Exception {
        TestClient client = start("member");
        cdp.addTarget("worker", "service_worker", null, "https://example.com/sw.js", "Service Worker");
        cdp.addTarget("shared", "shared_worker", null, "https://example.com/w.js", "Worker");
        cdp.addTarget("iframe", "iframe", null, "https://example.com/f", "Frame");
        cdp.addTarget("ui", "browser_ui", null, "chrome://omnibox-popup.top-chrome/", "Omnibox");
        cdp.addTarget("bg", "background_page", null, "chrome-extension://abc/bg.html", "Extension");
        cdp.addTarget("other", "other", null, "https://example.com/o", "Other");
        cdp.addTarget("prerender", "page", "prerender", "https://example.com/next", "Next");
        cdp.addPage("devtools", "devtools://devtools/bundled/inspector.html", "DevTools");
        cdp.addPage("settings", "chrome://settings/", "Settings");
        cdp.addPage("ext", "chrome-extension://abc/popup.html", "Popup");
        cdp.addPage("untrusted", "chrome-untrusted://x/", "X");
        cdp.addPage("ntp-search", "chrome-search://local-ntp/", "X");
        cdp.addPage("upper", "CHROME://settings/", "Upper");
        // What a kiosk really shows: the home page, an empty tab, and Ctrl+T.
        cdp.addPage("home", "file:///usr/local/share/ma/home.html", "Home");
        cdp.addPage("blank", "about:blank", "about:blank");
        cdp.addPage("newtab", "chrome://newtab/", "New Tab");
        assertThat(ids(tabs(client))).containsExactly("member", "home", "blank", "newtab");
        assertThat(rig.call(client, "browser.tab.reload", Map.of("tabId", "settings"))).containsEntry("code", "not_found");
    }

    @Test
    void aTabThatMovesToAnInternalPageLeavesTheListAndComesBack() throws Exception {
        TestClient client = start("a", "b");
        assertThat(ids(tabs(client))).containsExactly("a", "b");
        cdp.navigateInPage("b", "chrome://settings/", "Settings");
        await().until(() -> ids(tabs(client)).equals(List.of("a")));
        cdp.navigateInPage("b", "https://example.com/back", "Back");
        await().until(() -> ids(tabs(client)).equals(List.of("a", "b")));
    }

    @Test
    void theActiveTabIsChromiumsMostRecentEvenWithNoEventForIt() throws Exception {
        TestClient client = start("a", "b");
        assertThat(activeOf(client)).isEqualTo("b");
        cdp.activateQuietly("a");
        assertThat(activeOf(client)).isEqualTo("a");
    }

    @Test
    void anInternalPageBeingMostRecentLeavesTheLastMemberTabActive() throws Exception {
        TestClient client = start("a", "b");
        cdp.addPage("settings", "chrome://settings/", "Settings");
        assertThat(activeOf(client)).isEqualTo("b");
    }

    @Test
    void historyFlagsFollowNavigation() throws Exception {
        TestClient client = start("a");
        cdp.navigateInPage("a", "https://example.com/2", "Two");
        await().until(() -> Boolean.TRUE.equals(tab(client, "a").get("canGoBack")));
        assertThat(tab(client, "a")).containsEntry("canGoForward", false).containsEntry("url", "https://example.com/2");

        assertThat(rig.call(client, "browser.tab.back", Map.of())).containsEntry("tabId", "a");
        await().until(() -> Boolean.TRUE.equals(tab(client, "a").get("canGoForward")));
        assertThat(tab(client, "a")).containsEntry("canGoBack", false).containsEntry("url", "https://example.com/a");

        assertThat(rig.call(client, "browser.tab.forward", Map.of("tabId", "a"))).containsEntry("tabId", "a");
        await().until(() -> Boolean.FALSE.equals(tab(client, "a").get("canGoForward")));
        assertThat(tab(client, "a")).containsEntry("canGoBack", true).containsEntry("url", "https://example.com/2");
    }

    @Test
    void backWithNowhereToGoIsANoOp() throws Exception {
        TestClient client = start("a");
        assertThat(rig.call(client, "browser.tab.back", Map.of())).containsEntry("tabId", "a");
        assertThat(rig.call(client, "browser.tab.forward", Map.of())).containsEntry("tabId", "a");
        assertThat(cdp.commands("Page.navigateToHistoryEntry")).isEmpty();
    }

    @Test
    void loadingFollowsTheMainFrameOnly() throws Exception {
        TestClient client = start("a");
        tabs(client);
        await().until(() -> !cdp.commands("Page.enable").isEmpty());
        String session = FakeCdp.sessionOf("a");
        cdp.event("Page.frameStartedLoading", Map.of("frameId", "some-iframe"), session);
        cdp.event("Page.frameStartedLoading", Map.of("frameId", "a"), session);
        await().until(() -> Boolean.TRUE.equals(tab(client, "a").get("loading")));
        cdp.event("Page.frameStoppedLoading", Map.of("frameId", "some-iframe"), session);
        assertThat(tab(client, "a")).containsEntry("loading", true);
        cdp.event("Page.frameStoppedLoading", Map.of("frameId", "a"), session);
        await().until(() -> Boolean.FALSE.equals(tab(client, "a").get("loading")));
    }

    // ---- which tab is the active one

    /**
     * Regression. /json/list's first isn't always the tab on screen: Chrome 156 puts a tab opened with a
     * middle click there while it's hidden. deskd took it as active, so text left without a tabId went to
     * a page the member wasn't looking at. ChromiumIT has this against a real one.
     */
    @Test
    void aTabOpenedInTheBackgroundIsntActive() throws Exception {
        TestClient client = start("a");
        assertThat(activeOf(client)).isEqualTo("a");
        cdp.addBackgroundPage("behind", "https://example.com/behind", "Behind");
        await().until(() -> ids(tabs(client)).contains("behind"));
        assertThat(cdp.firstInList()).isEqualTo("behind");
        assertThat(activeOf(client)).isEqualTo("a");
    }

    @Test
    void aLeftOutTabIdGoesToTheTabOnScreenAndNotOneOpenedBehindIt() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.addBackgroundPage("behind", "https://example.com/behind", "Behind");
        await().until(() -> ids(tabs(client)).contains("behind"));

        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "pasted secret"))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText").get(0).sessionId()).isEqualTo(FakeCdp.sessionOf("a"));
        assertThat(rig.call(client, "browser.tab.reload", Map.of())).containsEntry("tabId", "a");
        assertThat(rig.call(client, "browser.tab.back", Map.of())).containsEntry("tabId", "a");
        assertThat(rig.call(client, "browser.tab.forward", Map.of())).containsEntry("tabId", "a");
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/x"))).containsEntry("tabId", "a");
    }

    @Test
    void activatingTheTabOnScreenLastsThoughChromiumsOrderDoesntChange() throws Exception {
        TestClient client = start("a");
        cdp.addBackgroundPage("behind", "https://example.com/behind", "Behind");
        await().until(() -> ids(tabs(client)).contains("behind"));
        assertThat(rig.call(client, "browser.tab.activate", Map.of("tabId", "a"))).containsEntry("tabId", "a");
        assertThat(cdp.firstInList()).isEqualTo("behind");
        assertThat(activeOf(client)).isEqualTo("a");
    }

    @Test
    void aTabOpenedBehindBecomesActiveOnceItsOnScreenThoughItWasFirstAlready() throws Exception {
        TestClient client = start("a");
        cdp.addBackgroundPage("behind", "https://example.com/behind", "Behind");
        await().until(() -> ids(tabs(client)).contains("behind"));
        assertThat(activeOf(client)).isEqualTo("a");
        cdp.activateQuietly("behind");
        assertThat(cdp.firstInList()).isEqualTo("behind");
        assertThat(activeOf(client)).isEqualTo("behind");
        cdp.activateQuietly("a");
        assertThat(activeOf(client)).isEqualTo("a");
    }

    @Test
    void aNewConnectionFindsTheTabOnScreenBelowOnesOpenedBehindIt() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        cdp.addBackgroundPage("behind-1", "https://example.com/1", "1");
        cdp.addBackgroundPage("behind-2", "https://example.com/2", "2");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        assertThat(activeOf(rig.connect("cs-a"))).isEqualTo("a");
    }

    /** The fake says visible to anything but an isolated world, as a hostile page can in its own. */
    @Test
    void onlyAConstantInAnIsolatedWorldIsEverAsked() throws Exception {
        TestClient client = start("a");
        cdp.addBackgroundPage("behind", "https://example.com/behind", "Behind");
        await().until(() -> ids(tabs(client)).contains("behind"));
        assertThat(cdp.commands("Runtime.evaluate")).isNotEmpty().allSatisfy(command -> {
            assertThat(command.params()).containsEntry("expression", "document.visibilityState").containsKey("contextId");
        });
    }

    @Test
    void theTabAlreadyFirstAndActiveIsAskedNothing() throws Exception {
        TestClient client = start("a", "b");
        tabs(client);
        cdp.clearCommands();
        tabs(client);
        tabs(client);
        assertThat(cdp.commands("Runtime.evaluate")).isEmpty();
    }

    @Test
    void withNothingMovedOnlyTheFirstTabIsAskedAgain() throws Exception {
        TestClient client = start("a");
        for (String id : List.of("behind-1", "behind-2", "behind-3")) {
            cdp.addBackgroundPage(id, "https://example.com/" + id, id);
        }
        await().until(() -> ids(tabs(client)).contains("behind-3"));
        tabs(client);
        cdp.clearCommands();
        tabs(client);
        tabs(client);
        assertThat(activeOf(client)).isEqualTo("a");
        assertThat(cdp.commands("Runtime.evaluate")).isNotEmpty().allSatisfy(command -> {
            assertThat(command.sessionId()).isEqualTo(FakeCdp.sessionOf("behind-3"));
        });
    }

    @Test
    void aHungTabOpenedBehindDoesntHideTheTabOnScreen() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.hangTab("behind", true);
        cdp.addBackgroundPage("behind", "https://example.com/behind", "Behind");
        await().until(() -> ids(tabs(client)).contains("behind"));
        assertThat(activeOf(client)).isEqualTo("a");
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "x"))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText").get(0).sessionId()).isEqualTo(FakeCdp.sessionOf("a"));
    }

    @Test
    void ifNoTabCanBeShownToBeOnScreenALeftOutTabIdFailsClosed() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.hangTab("new", true);
        cdp.addPage("new", "https://example.com/new", "New");
        await().until(() -> ids(tabs(client)).contains("new"));
        assertErr(rig.call(client, "browser.text.insert", Map.of("text", "x")), "unavailable", Map.of("reason", "active_tab"));
        assertThat(cdp.commands("Input.insertText")).isEmpty();
        // Naming a tab is still the client's word, and the list still answers.
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "x", "tabId", "a"))).containsEntry("_kind", "RES");
        assertThat(tabs(client).stream().filter(tab -> Boolean.TRUE.equals(tab.get("active")))).hasSize(1);

        cdp.hangTab("new", false);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(rig.call(client, "browser.text.insert", Map.of("text", "y"))).containsEntry("_kind", "RES"));
        assertThat(cdp.commands("Input.insertText").stream().filter(c -> c.params().equals(Map.of("text", "y"))).findFirst().orElseThrow().sessionId())
                .isEqualTo(FakeCdp.sessionOf("new"));
    }

    /** Regression: the list's read failing was swallowed, and the call went on with the last tab it knew. */
    @Test
    void aLeftOutTabIdFailsClosedIfTheListCantBeRead() throws Exception {
        TestClient client = start("a", "b");
        tabs(client);
        cdp.hangHttp(true);
        for (Map.Entry<String, Map<String, Object>> call : Map.<String, Map<String, Object>>of(
                "browser.text.insert", Map.of("text", "x"),
                "browser.tab.navigate", Map.of("url", "https://example.com/x"),
                "browser.tab.reload", Map.of(),
                "browser.tab.back", Map.of()).entrySet()) {
            assertErr(rig.call(client, call.getKey(), call.getValue()), "unavailable", Map.of("reason", "active_tab"));
        }
        assertThat(cdp.commands("Input.insertText")).isEmpty();
        assertThat(cdp.commands("Page.navigate")).isEmpty();
        assertThat(cdp.commands("Page.reload")).isEmpty();
        // A named tab doesn't depend on the list.
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "y", "tabId", "a"))).containsEntry("_kind", "RES");
        cdp.hangHttp(false);
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "z"))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText").get(1).sessionId()).isEqualTo(FakeCdp.sessionOf("b"));
    }

    /** Regression: with the active tab gone and no list, the oldest tab got the text. */
    @Test
    void afterTheActiveTabClosesALeftOutTabIdDoesntFallBackToTheOldest() throws Exception {
        TestClient client = start("a", "b");
        tabs(client);
        assertThat(rig.call(client, "browser.tab.close", Map.of("tabId", "b"))).containsEntry("_kind", "RES");
        cdp.hangHttp(true);
        assertErr(rig.call(client, "browser.text.insert", Map.of("text", "x")), "unavailable", Map.of("reason", "active_tab"));
        assertThat(cdp.commands("Input.insertText")).isEmpty();
    }

    /** The member on a page deskd doesn't list: the last tab is what shows as active, and it's hidden. */
    @Test
    void withAPageThatIsntListedOnScreenALeftOutTabIdFailsClosed() throws Exception {
        TestClient client = start("a", "b");
        assertThat(activeOf(client)).isEqualTo("b");
        cdp.addPage("settings", "chrome://settings/", "Settings");
        assertThat(activeOf(client)).isEqualTo("b");
        assertErr(rig.call(client, "browser.text.insert", Map.of("text", "x")), "unavailable", Map.of("reason", "active_tab"));
        assertThat(cdp.commands("Input.insertText")).isEmpty();
        assertThat(cdp.commands("Target.attachToTarget").stream().map(command -> command.params().get("targetId"))).doesNotContain("settings");
        assertThat(cdp.commands("Runtime.evaluate").stream().map(FakeCdp.Command::sessionId)).doesNotContain(FakeCdp.sessionOf("settings"));

        // A named tab is still the client's word.
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "x", "tabId", "b"))).containsEntry("_kind", "RES");

        // Closing that page shows the tab under it, and all is as it was.
        cdp.removeQuietly("settings");
        cdp.event("Target.targetDestroyed", Map.of("targetId", "settings"), null);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(rig.call(client, "browser.text.insert", Map.of("text", "y"))).containsEntry("_kind", "RES"));
        assertThat(cdp.commands("Input.insertText").get(1).sessionId()).isEqualTo(FakeCdp.sessionOf("b"));
    }

    @Test
    void aPageThatIsntListedAboveATabStillOnScreenChangesNothing() throws Exception {
        TestClient client = start("a");
        tabs(client);
        // Made but never shown: it's above, and the tab that's still on screen says so.
        cdp.addBackgroundPage("hidden-ui", "chrome://something/", "UI");
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "x"))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText").get(0).sessionId()).isEqualTo(FakeCdp.sessionOf("a"));
    }

    // ---- browser.tab.navigate

    @Test
    void navigateGoesToTheActiveTabOrTheOneNamed() throws Exception {
        TestClient client = start("a", "b");
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/x")))
                .containsEntry("_kind", "RES")
                .containsEntry("tabId", "b")
                .doesNotContainKey("netError");
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/y", "tabId", "a")))
                .containsEntry("tabId", "a");
        List<FakeCdp.Command> navigations = cdp.commands("Page.navigate");
        assertThat(navigations).hasSize(2);
        assertThat(navigations.get(0).sessionId()).isEqualTo(FakeCdp.sessionOf("b"));
        assertThat(navigations.get(0).params()).isEqualTo(Map.of("url", "https://example.com/x"));
        assertThat(navigations.get(1).sessionId()).isEqualTo(FakeCdp.sessionOf("a"));
    }

    @Test
    void chromiumGetsTheEncodedUrl() throws Exception {
        TestClient client = start("a");
        rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/a b"));
        assertThat(cdp.commands("Page.navigate").get(0).params()).isEqualTo(Map.of("url", "https://example.com/a%20b"));
    }

    @Test
    void aNetworkErrorIsAnOrdinaryResult() throws Exception {
        TestClient client = start("a");
        cdp.navigateError("https://example.com/down", "net::ERR_NAME_NOT_RESOLVED");
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/down")))
                .containsEntry("_kind", "RES")
                .containsEntry("tabId", "a")
                .containsEntry("netError", "net::ERR_NAME_NOT_RESOLVED");
    }

    @Test
    void aPolicyBlockIsForbidden() throws Exception {
        TestClient client = start("a");
        cdp.navigateError("https://office.minimalistalliance.com/", "net::ERR_BLOCKED_BY_ADMINISTRATOR");
        assertErr(
                rig.call(client, "browser.tab.navigate", Map.of("url", "https://office.minimalistalliance.com/")),
                "forbidden",
                Map.of("reason", "blocked"));
    }

    @Test
    void hostileUrlsNeverReachChromiumWhetherNavigatedOrOpened() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.clearCommands();
        for (String url : List.of(
                "javascript:alert(document.cookie)",
                " JavaScript:alert(1)",
                "java\tscript:alert(1)",
                "\u0001javascript:alert(1)",
                "file:///etc/passwd",
                "chrome://settings",
                "data:text/html,x",
                "about:blank",
                "view-source:https://example.com")) {
            assertErr(rig.call(client, "browser.tab.navigate", Map.of("url", url)), "bad_request", Map.of("reason", "scheme"));
            assertErr(rig.call(client, "browser.tab.open", Map.of("url", url)), "bad_request", Map.of("reason", "scheme"));
        }
        assertThat(cdp.commands("Page.navigate")).isEmpty();
        assertThat(cdp.commands("Target.createTarget")).isEmpty();
    }

    @Test
    void urlsAreCheckedEvenWhileChromiumIsDown() throws Exception {
        rig = new BrowserRig(dir, unusedPort(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        assertErr(rig.call(client, "browser.tab.navigate", Map.of("url", "javascript:1")), "bad_request");
    }

    @Test
    void aUrlOfTheWrongTypeOrSizeIsRefused() throws Exception {
        TestClient client = start("a");
        assertErr(rig.call(client, "browser.tab.navigate", Map.of()), "bad_request", Map.of("reason", "url"));
        assertErr(rig.call(client, "browser.tab.navigate", Map.of("url", 7)), "bad_request", Map.of("reason", "url"));
        assertErr(rig.call(client, "browser.tab.open", Map.of("url", 7)), "bad_request", Map.of("reason", "url"));
        assertErr(rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/" + "x".repeat(BrowserUrl.MAX_CHARS))), "too_large");
        assertErr(rig.call(client, "browser.tab.open", Map.of("url", "https://example.com/" + "x".repeat(BrowserUrl.MAX_CHARS))), "too_large");
    }

    @Test
    void aNavigationStillGoingWhenTheWaitEndsIsNoError() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.hold("Page.navigate");
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/slow")))
                .containsEntry("_kind", "RES")
                .containsEntry("tabId", "a");
        cdp.release("Page.navigate");
    }

    // ---- reload, activate, open, close

    @Test
    void reloadReachesTheTab() throws Exception {
        TestClient client = start("a", "b");
        assertThat(rig.call(client, "browser.tab.reload", Map.of())).containsEntry("tabId", "b");
        assertThat(rig.call(client, "browser.tab.reload", Map.of("tabId", "a"))).containsEntry("tabId", "a");
        assertThat(cdp.commands("Page.reload").stream().map(FakeCdp.Command::sessionId))
                .containsExactly(FakeCdp.sessionOf("b"), FakeCdp.sessionOf("a"));
    }

    @Test
    void activateChangesTheActiveTab() throws Exception {
        TestClient client = start("a", "b");
        assertThat(rig.call(client, "browser.tab.activate", Map.of("tabId", "a"))).containsEntry("tabId", "a");
        assertThat(cdp.commands("Target.activateTarget").get(0).params()).isEqualTo(Map.of("targetId", "a"));
        assertThat(activeOf(client)).isEqualTo("a");
    }

    @Test
    void openMakesATab() throws Exception {
        TestClient client = start("a");
        Map<String, Object> opened = rig.call(client, "browser.tab.open", Map.of("url", "https://example.com/new"));
        String id = (String) opened.get("tabId");
        assertThat(cdp.commands("Target.createTarget").get(0).params()).isEqualTo(Map.of("url", "https://example.com/new"));
        assertThat(ids(tabs(client))).containsExactly("a", id);
        assertThat(activeOf(client)).isEqualTo(id);

        String blank = (String) rig.call(client, "browser.tab.open", Map.of()).get("tabId");
        assertThat(cdp.commands("Target.createTarget").get(1).params()).isEqualTo(Map.of("url", "about:blank"));
        assertThat(tab(client, blank)).containsEntry("url", "about:blank");
    }

    @Test
    void closeRemovesATabAndTheActiveOneMovesOn() throws Exception {
        TestClient client = start("a", "b");
        assertThat(activeOf(client)).isEqualTo("b");
        Map<String, Object> reply = rig.call(client, "browser.tab.close", Map.of("tabId", "b"));
        assertThat(reply).containsEntry("_kind", "RES").containsOnlyKeys("_kind", "_id");
        assertThat(ids(tabs(client))).containsExactly("a");
        assertThat(activeOf(client)).isEqualTo("a");
    }

    @Test
    void closingTheLastTabLeavesAnEmptyOneSoChromiumDoesntExit() throws Exception {
        TestClient client = start("a");
        assertThat(rig.call(client, "browser.tab.close", Map.of("tabId", "a"))).containsEntry("_kind", "RES");
        List<String> order = cdp.commands().stream().map(FakeCdp.Command::method)
                .filter(method -> method.equals("Target.createTarget") || method.equals("Target.closeTarget")).toList();
        assertThat(order).containsExactly("Target.createTarget", "Target.closeTarget");
        assertThat(tabs(client)).hasSize(1).first().satisfies(tab -> assertThat(tab).containsEntry("url", "about:blank"));
    }

    /** Regression: the check and the close weren't one step, so both could see two tabs and close them. */
    @Test
    void closingTheLastTwoTabsAtOnceStillLeavesOne() throws Exception {
        TestClient client = start("a", "b");
        tabs(client);
        cdp.hold("Target.closeTarget");
        long first = rig.send(client, "browser.tab.close", Map.of("tabId", "a"), "close-a");
        await().until(() -> cdp.commands("Target.closeTarget").size() == 1);
        long second = rig.send(client, "browser.tab.close", Map.of("tabId", "b"), "close-b");
        Thread.sleep(100);
        cdp.answerHeld("Target.closeTarget");
        List<Object> replied = new ArrayList<>();
        for (int i = 0; i < 2; i++) {
            Map<String, Object> reply = client.nextReply();
            assertThat(reply).containsEntry("_kind", "RES");
            replied.add(reply.get("_id"));
        }
        assertThat(replied).containsExactlyInAnyOrder(first, second);
        assertThat(cdp.commands().stream().map(FakeCdp.Command::method)
                .filter(method -> method.equals("Target.createTarget") || method.equals("Target.closeTarget")).toList())
                .containsExactly("Target.closeTarget", "Target.createTarget", "Target.closeTarget");
        assertThat(tabs(client)).hasSize(1).first().satisfies(tab -> assertThat(tab).containsEntry("url", "about:blank"));
    }

    @Test
    void aSecondCloseOfOneTabIsNotFoundAndOpensNothing() throws Exception {
        TestClient client = start("a", "b");
        tabs(client);
        cdp.hold("Target.closeTarget");
        rig.send(client, "browser.tab.close", Map.of("tabId", "a"), "close-1");
        await().until(() -> cdp.commands("Target.closeTarget").size() == 1);
        rig.send(client, "browser.tab.close", Map.of("tabId", "a"), "close-2");
        Thread.sleep(100);
        cdp.answerHeld("Target.closeTarget");
        assertThat(List.of(client.nextReply().get("_kind"), client.nextReply().get("_kind"))).containsExactlyInAnyOrder("RES", "ERR");
        assertThat(cdp.commands("Target.closeTarget")).hasSize(1);
        assertThat(cdp.commands("Target.createTarget")).isEmpty();
    }

    /**
     * Regression. The last tab went by itself just before its close, and the reply was not_found, which
     * says nothing was done, with the empty tab already open. The member has what a close leaves.
     */
    @Test
    void closingTheLastTabAsItGoesByItselfIsASuccessAndLeavesTheEmptyOne() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.removeQuietly("a");
        assertThat(rig.call(client, "browser.tab.close", Map.of("tabId", "a"))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Target.createTarget")).hasSize(1);
        assertThat(tabs(client)).hasSize(1).first().satisfies(tab -> assertThat(tab).containsEntry("url", "about:blank"));
    }

    /** With the tab still there, there's no telling how the close went, and the empty tab is open. */
    @Test
    void closingTheLastTabFailingAnyOtherWaySaysItMayHaveApplied() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.forceError("Target.closeTarget", -32000);
        assertErr(rig.call(client, "browser.tab.close", Map.of("tabId", "a")), "unavailable", MAY_HAVE_APPLIED);
        assertThat(cdp.commands("Target.createTarget")).hasSize(1);
    }

    // ---- calls that were on their way when something changed

    private static final Map<String, Map<String, Object>> DRIVING_CALLS = Map.of(
            "browser.text.insert", Map.of("text", "after the end", "tabId", "a"),
            "browser.tab.navigate", Map.of("url", "https://example.com/late", "tabId", "a"),
            "browser.tab.reload", Map.of("tabId", "a"),
            "browser.tab.activate", Map.of("tabId", "a"),
            "browser.tab.open", Map.of("url", "https://example.com/late"),
            "browser.tab.close", Map.of("tabId", "a"));

    private static final List<String> DRIVING_COMMANDS = List.of(
            "Input.insertText", "Page.navigate", "Page.reload", "Target.activateTarget", "Target.createTarget", "Target.closeTarget");

    private void assertNothingDriven() {
        assertThat(cdp.commands().stream().map(FakeCdp.Command::method).filter(DRIVING_COMMANDS::contains).toList()).isEmpty();
    }

    /** Parks every driving call on a connection whose attach hasn't been answered, with its session live. */
    private TestClient parkDrivingCalls() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        cdp.hold("Target.attachToTarget");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.timing(Duration.ofMillis(20), Duration.ofSeconds(30)));
        TestClient client = rig.connect("cs-a");
        DRIVING_CALLS.forEach((method, params) -> rig.send(client, method, params, "parked-" + method));
        await().until(() -> !cdp.commands("Target.attachToTarget").isEmpty());
        return client;
    }

    /**
     * Regression. A mutation runs on through a session's end, so a half-done one isn't left that way. But
     * one parked on the connection hadn't started, and still drove the member's browser afterwards.
     */
    @Test
    void aCallThatHasntReachedChromiumDoesNothingOnceItsSessionIsRevoked() throws Exception {
        parkDrivingCalls();
        rig.sessions.revoke(grant -> true);
        await().until(() -> !rig.sessions.isLive("cs-a"));
        cdp.answerHeld("Target.attachToTarget");
        await().until(() -> !cdp.commands("Page.enable").isEmpty());
        await().until(() -> !cdp.commands("Page.getNavigationHistory").isEmpty());
        // The connection is ready after its settling time, and the calls go on from there.
        Thread.sleep(600);
        assertNothingDriven();

        // Nothing happened, so a retry from a new session with a new token is what runs it.
        TestClient next = rig.connect("cs-b");
        assertThat(rig.call(next, "browser.text.insert", DRIVING_CALLS.get("browser.text.insert"), "parked-browser.text.insert"))
                .containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText")).hasSize(1);
    }

    @Test
    void aCallThatHasntReachedChromiumDoesNothingOnceItsSessionCloses() throws Exception {
        TestClient client = parkDrivingCalls();
        client.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        await().until(() -> !rig.sessions.isLive("cs-a"));
        cdp.answerHeld("Target.attachToTarget");
        await().until(() -> !cdp.commands("Page.getNavigationHistory").isEmpty());
        Thread.sleep(600);
        assertNothingDriven();
    }

    @Test
    void aCallThatHasntReachedChromiumIsForbiddenOnceARefreshTakesInputAway() throws Exception {
        TestClient client = parkDrivingCalls();
        rig.refresh("cs-a", true, false, BrowserRig.fingerprintOf(client));
        cdp.answerHeld("Target.attachToTarget");
        for (int i = 0; i < DRIVING_CALLS.size(); i++) {
            assertErr(client.nextReply(), "forbidden", Map.of("reason", "permission"));
        }
        assertNothingDriven();
    }

    /** One waiting a long time for the page, which is longer than these tests wait to answer it. */
    private TestClient startPatiently(String... pages) throws Exception {
        BrowserTabs.Timing fast = BrowserRig.FAST;
        TestClient client = start(new BrowserTabs.Timing(
                        fast.publishEvery(), fast.recentCall(), fast.callWait(), Duration.ofSeconds(8), Duration.ofSeconds(8),
                        fast.navigate(), fast.settle(), fast.listEvery(), fast.visibility(), fast.restartEvery(), fast.cdp()),
                pages);
        tabs(client);
        await().until(() -> !cdp.commands("Page.getNavigationHistory").isEmpty());
        return client;
    }

    /**
     * Regression: a deadline that came after the command went out gave up the idem's claim, though
     * Chromium was still going to apply it. So a retry typed the member's text twice.
     */
    @Test
    void aDeadlineAfterTheTextWentOutDoesntTypeItTwiceOnARetry() throws Exception {
        TestClient client = startPatiently("a");
        cdp.hold("Input.insertText");
        Map<String, Object> params = Map.of("text", "hello", "tabId", "a");
        rig.send(client, "browser.text.insert", params, "same-key", 150);
        assertErr(client.nextReply(), "deadline_exceeded");
        cdp.answerHeld("Input.insertText");
        assertThat(rig.call(client, "browser.text.insert", params, "same-key")).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText")).hasSize(1);
    }

    @Test
    void aCancelAfterTheTextWentOutDoesntTypeItTwiceOnARetry() throws Exception {
        TestClient client = startPatiently("a");
        cdp.hold("Input.insertText");
        Map<String, Object> params = Map.of("text", "hello", "tabId", "a");
        long id = rig.send(client, "browser.text.insert", params, "same-key");
        await().until(() -> cdp.commands("Input.insertText").size() == 1);
        client.send(Channels.RPC, FrameKind.CANCEL, id, 0, new byte[0]);
        assertErr(client.nextReply(), "cancelled");
        // A retry that comes while it's still going waits, and gets the one result.
        long retry = rig.send(client, "browser.text.insert", params, "same-key");
        cdp.answerHeld("Input.insertText");
        assertThat(client.nextReply()).containsEntry("_kind", "RES").containsEntry("_id", retry);
        assertThat(cdp.commands("Input.insertText")).hasSize(1);
    }

    @Test
    void aDeadlineAfterAnOpenWentOutDoesntOpenASecondTab() throws Exception {
        TestClient client = startPatiently("a");
        cdp.hold("Target.createTarget");
        Map<String, Object> params = Map.of("url", "https://example.com/new");
        rig.send(client, "browser.tab.open", params, "same-key", 100);
        assertErr(client.nextReply(), "deadline_exceeded");
        cdp.answerHeld("Target.createTarget");
        assertThat(rig.call(client, "browser.tab.open", params, "same-key")).containsEntry("_kind", "RES").containsKey("tabId");
        assertThat(cdp.commands("Target.createTarget")).hasSize(1);
        assertThat(tabs(client)).hasSize(2);
    }

    @Test
    void aDeadlineBeforeTheCommandWentOutLeavesARetryToRunIt() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        cdp.hold("Target.attachToTarget");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        Map<String, Object> params = Map.of("text", "hello", "tabId", "a");
        rig.send(client, "browser.text.insert", params, "same-key", 50);
        assertErr(client.nextReply(), "deadline_exceeded");
        cdp.answerHeld("Target.attachToTarget");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(rig.call(client, "browser.text.insert", params, "same-key")).containsEntry("_kind", "RES"));
        assertThat(cdp.commands("Input.insertText")).hasSize(1);
    }

    // ---- what unavailable says about a mutation

    private static final Map<String, Object> NOT_APPLIED = Map.of("reason", "chromium");
    private static final Map<String, Object> MAY_HAVE_APPLIED = Map.of("reason", "chromium", "mayHaveApplied", true);

    /** Regression: this was stored as plain unavailable, and API.md said to use a new key, which typed it twice. */
    @Test
    void aTextInsertThatTimesOutSaysItMayHaveAppliedAndTheSameKeyDoesntTypeItTwice() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.hold("Input.insertText");
        Map<String, Object> params = Map.of("text", "hello", "tabId", "a");
        assertErr(rig.call(client, "browser.text.insert", params, "same-key"), "unavailable", MAY_HAVE_APPLIED);
        assertThat(cdp.commands("Input.insertText")).hasSize(1);

        cdp.answerHeld("Input.insertText");
        assertErr(rig.call(client, "browser.text.insert", params, "same-key"), "unavailable", MAY_HAVE_APPLIED);
        assertThat(cdp.commands("Input.insertText")).hasSize(1);
    }

    @Test
    void aConnectionDroppedAfterTheTextWentOutSaysItMayHaveAppliedAndTheSameKeyDoesntTypeItTwice() throws Exception {
        TestClient client = startPatiently("a");
        cdp.hold("Input.insertText");
        Map<String, Object> params = Map.of("text", "hello", "tabId", "a");
        rig.send(client, "browser.text.insert", params, "same-key");
        await().until(() -> cdp.commands("Input.insertText").size() == 1);
        cdp.dropConnections();
        assertErr(client.nextReply(), "unavailable", MAY_HAVE_APPLIED);

        cdp.release("Input.insertText");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
        assertErr(rig.call(client, "browser.text.insert", params, "same-key"), "unavailable", MAY_HAVE_APPLIED);
        assertThat(cdp.commands("Input.insertText")).hasSize(1);
    }

    /** Page.navigate running long isn't a failure unless Chromium has gone too, and then it may yet have applied. */
    @Test
    void aNavigationThatTimesOutWithChromiumSilentSaysItMayHaveApplied() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.hold("Page.navigate");
        cdp.hold("Browser.getVersion");
        Map<String, Object> params = Map.of("url", "https://example.com/slow", "tabId", "a");
        assertErr(rig.call(client, "browser.tab.navigate", params, "same-key"), "unavailable", MAY_HAVE_APPLIED);
        assertErr(rig.call(client, "browser.tab.navigate", params, "same-key"), "unavailable", MAY_HAVE_APPLIED);
        assertThat(cdp.commands("Page.navigate")).hasSize(1);
    }

    /**
     * A call stops waiting for a session long before the attach's own timer would drop the connection. In
     * production the two are equal, and which ends first is a race that this makes certain.
     */
    private TestClient startWithAnAttachOutlastingItsWait(String... pages) throws Exception {
        BrowserTabs.Timing fast = BrowserRig.FAST;
        TestClient client = start(new BrowserTabs.Timing(
                        fast.publishEvery(), fast.recentCall(), fast.callWait(), Duration.ofSeconds(8), Duration.ofMillis(300),
                        fast.navigate(), fast.settle(), fast.listEvery(), fast.visibility(), fast.restartEvery(), fast.cdp()),
                pages);
        tabs(client);
        await().until(() -> !cdp.commands("Page.getNavigationHistory").isEmpty());
        return client;
    }

    /**
     * Regression. Any timeout counted as the navigation still going, so a call whose wait for a session
     * ran out asked if the browser was alive, and it was. The client heard the tab was loading, and a
     * retry replayed that, with Page.navigate never sent.
     */
    @Test
    void aNavigationWithNoSessionToGoOnIsNoSuccessAndTheSameKeyRunsItOnceThereIsOne() throws Exception {
        TestClient client = startWithAnAttachOutlastingItsWait("a");
        cdp.hold("Target.attachToTarget");
        cdp.event("Target.detachedFromTarget", Map.of("sessionId", FakeCdp.sessionOf("a"), "targetId", "a"), null);
        // Its reply comes after that event on the socket, so by then the tab has no session.
        rig.call(client, "browser.tab.activate", Map.of("tabId", "a"));
        Map<String, Object> params = Map.of("url", "https://example.com/slow", "tabId", "a");
        assertErr(rig.call(client, "browser.tab.navigate", params, "same-key"), "unavailable", NOT_APPLIED);
        assertThat(cdp.commands("Page.navigate")).isEmpty();

        cdp.answerHeld("Target.attachToTarget");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(rig.call(client, "browser.tab.navigate", params, "same-key")).containsEntry("_kind", "RES"));
        assertThat(cdp.commands("Page.navigate")).hasSize(1);
    }

    /** The same past the effect: Chromium refused the first send, and the session to replace it doesn't come. */
    @Test
    void aNavigationWhoseReplacementSessionDoesntComeIsNoSuccessAndKeepsItsKey() throws Exception {
        TestClient client = startWithAnAttachOutlastingItsWait("a");
        cdp.forceError("Page.navigate", CdpException.SESSION_NOT_FOUND);
        cdp.hold("Target.attachToTarget");
        Map<String, Object> params = Map.of("url", "https://example.com/slow", "tabId", "a");
        assertErr(rig.call(client, "browser.tab.navigate", params, "same-key"), "unavailable", MAY_HAVE_APPLIED);
        assertThat(cdp.commands("Page.navigate")).hasSize(1);

        cdp.clearForcedErrors();
        cdp.answerHeld("Target.attachToTarget");
        assertErr(rig.call(client, "browser.tab.navigate", params, "same-key"), "unavailable", MAY_HAVE_APPLIED);
        assertThat(cdp.commands("Page.navigate")).hasSize(1);
    }

    @Test
    void chromiumBeingDownSaysNothingWasDoneAndTheSameKeyRunsTheCallOnceItsUp() throws Exception {
        int port = unusedPort();
        rig = new BrowserRig(dir, port, BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        Map<String, Object> params = Map.of("text", "hello");
        assertErr(rig.call(client, "browser.text.insert", params, "same-key"), "unavailable", NOT_APPLIED);

        cdp = new FakeCdp(port);
        cdp.addPage("a", "https://example.com/a", "A");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
        assertThat(rig.call(client, "browser.text.insert", params, "same-key")).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText")).hasSize(1);
    }

    @Test
    void notKnowingTheTabOnScreenSaysNothingWasDoneAndTheSameKeyRunsTheCallOnceItIsKnown() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.hangHttp(true);
        Map<String, Object> params = Map.of("text", "hello");
        assertErr(rig.call(client, "browser.text.insert", params, "same-key"), "unavailable", Map.of("reason", "active_tab"));
        assertThat(cdp.commands("Input.insertText")).isEmpty();

        cdp.hangHttp(false);
        assertThat(rig.call(client, "browser.text.insert", params, "same-key")).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText")).hasSize(1);
    }

    /** Back asks for the history first. That only reads, so failing there has done nothing. */
    @Test
    void backFailingOnItsReadOfTheHistorySaysNothingWasDoneAndTheSameKeyRunsIt() throws Exception {
        TestClient client = start("a");
        cdp.navigateInPage("a", "https://example.com/2", "Two");
        await().until(() -> Boolean.TRUE.equals(tab(client, "a").get("canGoBack")));
        cdp.hold("Page.getNavigationHistory");
        Map<String, Object> params = Map.of("tabId", "a");
        assertErr(rig.call(client, "browser.tab.back", params, "same-key"), "unavailable", NOT_APPLIED);
        assertThat(cdp.commands("Page.navigateToHistoryEntry")).isEmpty();

        cdp.answerHeld("Page.getNavigationHistory");
        assertThat(rig.call(client, "browser.tab.back", params, "same-key")).containsEntry("tabId", "a");
        assertThat(cdp.commands("Page.navigateToHistoryEntry")).hasSize(1);
    }

    @Test
    void aBackThatTimesOutAfterItsReadSaysItMayHaveAppliedAndTheSameKeyDoesntGoBackTwice() throws Exception {
        TestClient client = start("a");
        cdp.navigateInPage("a", "https://example.com/2", "Two");
        cdp.navigateInPage("a", "https://example.com/3", "Three");
        await().until(() -> Boolean.TRUE.equals(tab(client, "a").get("canGoBack")));
        cdp.hold("Page.navigateToHistoryEntry");
        Map<String, Object> params = Map.of("tabId", "a");
        assertErr(rig.call(client, "browser.tab.back", params, "same-key"), "unavailable", MAY_HAVE_APPLIED);
        assertErr(rig.call(client, "browser.tab.back", params, "same-key"), "unavailable", MAY_HAVE_APPLIED);
        assertThat(cdp.commands("Page.navigateToHistoryEntry")).hasSize(1);
    }

    // ---- what's refused

    @Test
    void aDeadTabIdIsNotFoundEverywhere() throws Exception {
        TestClient client = start("a");
        Map<String, Object> dead = Map.of("tabId", "dead");
        assertErr(rig.call(client, "browser.tab.navigate", Map.of("tabId", "dead", "url", "https://example.com/")), "not_found");
        assertErr(rig.call(client, "browser.tab.back", dead), "not_found");
        assertErr(rig.call(client, "browser.tab.forward", dead), "not_found");
        assertErr(rig.call(client, "browser.tab.reload", dead), "not_found");
        assertErr(rig.call(client, "browser.tab.activate", dead), "not_found");
        assertErr(rig.call(client, "browser.tab.close", dead), "not_found");
        assertErr(rig.call(client, "browser.text.insert", Map.of("tabId", "dead", "text", "x")), "not_found");
    }

    @Test
    void aTabThatDiedWithNoEventYetIsNotFoundToo() throws Exception {
        TestClient client = start("a", "b");
        tabs(client);
        await().until(() -> cdp.commands("Page.getNavigationHistory").size() >= 2);
        cdp.removeQuietly("a");
        assertErr(rig.call(client, "browser.tab.close", Map.of("tabId", "a")), "not_found");
        assertErr(rig.call(client, "browser.tab.activate", Map.of("tabId", "a")), "not_found");
        // Its session has gone too. deskd tries a new one, and that's what can't be had.
        assertErr(rig.call(client, "browser.tab.reload", Map.of("tabId", "a")), "not_found");
    }

    @Test
    void aSessionChromiumDroppedIsReplacedOnce() throws Exception {
        TestClient client = start("a");
        tabs(client);
        await().until(() -> !cdp.commands("Page.enable").isEmpty());
        cdp.event("Target.detachedFromTarget", Map.of("sessionId", FakeCdp.sessionOf("a"), "targetId", "a"), null);
        int attaches = cdp.commands("Target.attachToTarget").size();
        await().untilAsserted(() -> {
            assertThat(rig.call(client, "browser.tab.reload", Map.of())).containsEntry("_kind", "RES");
            assertThat(cdp.commands("Target.attachToTarget").size()).isEqualTo(attaches + 1);
        });
    }

    @Test
    void withNoTabsTheActiveTabIsNotFound() throws Exception {
        TestClient client = start();
        assertErr(rig.call(client, "browser.tab.reload", Map.of()), "not_found");
        assertErr(rig.call(client, "browser.text.insert", Map.of("text", "x")), "not_found");
    }

    @Test
    void mutationsNeedIdemAndARepeatDoesntRunTwice() throws Exception {
        TestClient client = start("a");
        for (String method : List.of(
                "browser.tab.navigate", "browser.tab.back", "browser.tab.forward", "browser.tab.reload",
                "browser.tab.activate", "browser.tab.open", "browser.tab.close", "browser.text.insert")) {
            assertErr(rig.call(client, method, Map.of(), null), "bad_request");
        }
        Map<String, Object> first = rig.call(client, "browser.tab.reload", Map.of(), "same-idem");
        Map<String, Object> second = rig.call(client, "browser.tab.reload", Map.of(), "same-idem");
        assertThat(second).containsEntry("tabId", first.get("tabId"));
        assertThat(cdp.commands("Page.reload")).hasSize(1);
    }

    @Test
    void aTabIdOfTheWrongTypeIsABadRequest() throws Exception {
        TestClient client = start("a");
        assertErr(rig.call(client, "browser.tab.reload", Map.of("tabId", 7)), "bad_request", Map.of("reason", "tabId"));
        assertErr(rig.call(client, "browser.tab.activate", Map.of()), "bad_request", Map.of("reason", "tabId"));
        assertErr(rig.call(client, "browser.tab.close", Map.of()), "bad_request", Map.of("reason", "tabId"));
    }

    @Test
    void noMethodExposesCdpOrRunsScript() throws Exception {
        TestClient client = start("a");
        for (String method : List.of(
                "browser.cdp", "browser.cdp.send", "browser.tab.evaluate", "browser.tab.eval", "browser.script",
                "Runtime.evaluate", "Page.navigate", "Target.createTarget")) {
            assertErr(rig.call(client, method, Map.of("expression", "1")), "not_found");
        }
        rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/x", "method", "Runtime.evaluate", "expression", "1"));
        // deskd's own question, which no client can change, is the one script that ever runs.
        assertThat(cdp.commands("Runtime.evaluate")).allSatisfy(command ->
                assertThat(command.params()).containsEntry("expression", "document.visibilityState"));
        assertThat(cdp.commands().stream().map(FakeCdp.Command::method)).allMatch(method -> List.of(
                "Target.setDiscoverTargets", "Target.getTargets", "Target.attachToTarget", "Page.enable",
                "Page.getNavigationHistory", "Page.navigate", "Browser.getVersion",
                "Page.createIsolatedWorld", "Runtime.evaluate").contains(method));
    }

    @Test
    void aTokenWithoutInputCantDriveAndOneWithoutVideoCantLook() throws Exception {
        start("a");
        TestClient noInput = rig.connect("cs-noinput", true, false);
        for (String method : List.of(
                "browser.tab.navigate", "browser.tab.back", "browser.tab.forward", "browser.tab.reload",
                "browser.tab.activate", "browser.tab.open", "browser.tab.close", "browser.text.insert")) {
            assertErr(rig.call(noInput, method, Map.of("url", "https://example.com/", "tabId", "a", "text", "x")),
                    "forbidden", Map.of("reason", "permission"));
        }
        assertThat(rig.call(noInput, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");

        TestClient noVideo = rig.connect("cs-novideo", false, true);
        assertErr(rig.call(noVideo, "browser.tab.list", Map.of(), null), "forbidden", Map.of("reason", "permission"));
        assertThat(noVideo.subscribe("browser.tabs", null)).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
    }

    // ---- browser.text.insert

    @Test
    void textGoesThroughInsertTextOnTheRightTab() throws Exception {
        TestClient client = start("a", "b");
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "h\u00e9llo\n"))).containsEntry("_kind", "RES").containsOnlyKeys("_kind", "_id");
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "y", "tabId", "a"))).containsEntry("_kind", "RES");
        List<FakeCdp.Command> inserts = cdp.commands("Input.insertText");
        assertThat(inserts.get(0).sessionId()).isEqualTo(FakeCdp.sessionOf("b"));
        assertThat(inserts.get(0).params()).isEqualTo(Map.of("text", "h\u00e9llo\n"));
        assertThat(inserts.get(1).sessionId()).isEqualTo(FakeCdp.sessionOf("a"));
    }

    @Test
    void textOfTheWrongTypeOrSizeIsRefusedAndEmptyTextDoesNothing() throws Exception {
        TestClient client = start("a");
        assertErr(rig.call(client, "browser.text.insert", Map.of()), "bad_request", Map.of("reason", "text"));
        assertErr(rig.call(client, "browser.text.insert", Map.of("text", 7)), "bad_request", Map.of("reason", "text"));
        assertErr(rig.call(client, "browser.text.insert", Map.of("text", "x".repeat(BrowserTabs.MAX_INSERT_CHARS + 1))), "too_large");
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", ""))).containsEntry("_kind", "RES");
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "x".repeat(BrowserTabs.MAX_INSERT_CHARS)))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText")).hasSize(1);
    }

    @Test
    void aLoneSurrogateInTextCantBreakTheCall() throws Exception {
        TestClient client = start("a");
        // JSON can carry an escape for half a pair, and the Java string then holds it.
        long id = 77;
        String raw = "{\"m\":\"browser.text.insert\",\"idem\":\"lone\",\"p\":{\"text\":\"a\\ud83db\"}}";
        client.send(Channels.RPC, FrameKind.REQ, id, 0, raw.getBytes(StandardCharsets.UTF_8));
        assertThat(client.nextReply()).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText").get(0).params()).isEqualTo(Map.of("text", "a\ufffdb"));
    }

    // ---- Chromium isn't there

    @Test
    void withNoChromiumEveryCallIsUnavailableAtOnceWithOneCode() throws Exception {
        rig = new BrowserRig(dir, unusedPort(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        for (Map.Entry<String, Map<String, Object>> call : Map.of(
                "browser.tab.list", Map.<String, Object>of(),
                "browser.tab.navigate", Map.<String, Object>of("url", "https://example.com/"),
                "browser.tab.back", Map.<String, Object>of(),
                "browser.tab.forward", Map.<String, Object>of(),
                "browser.tab.reload", Map.<String, Object>of(),
                "browser.tab.activate", Map.<String, Object>of("tabId", "a"),
                "browser.tab.open", Map.<String, Object>of(),
                "browser.tab.close", Map.<String, Object>of("tabId", "a"),
                "browser.text.insert", Map.<String, Object>of("text", "x")).entrySet()) {
            long start = System.nanoTime();
            assertErr(rig.call(client, call.getKey(), call.getValue()), "unavailable", Map.of("reason", "chromium"));
            // A refused connection is the answer, so this is far below the 1.5 s a call may wait for one coming up.
            assertThat(Duration.ofNanos(System.nanoTime() - start)).as(call.getKey()).isLessThan(Duration.ofMillis(1400));
        }
    }

    @Test
    void aCallFindsChromiumThatHasComeUpSinceTheLastOne() throws Exception {
        int port = unusedPort();
        rig = new BrowserRig(dir, port, BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable");
        cdp = new FakeCdp(port);
        cdp.addPage("a", "https://example.com/a", "A");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
    }

    /**
     * Regression: nothing told the connector Chromium was being started, so what it had refused while it
     * was down kept it backing off, and a tab strip could wait up to 5 s for a browser that was there.
     */
    @Test
    void startingChromiumKeepsTheConnectorCloseSoItsFoundAsSoonAsItListens() throws Exception {
        int port = unusedPort();
        BrowserTabs.Timing fast = BrowserRig.FAST;
        Duration min = Duration.ofMillis(100);
        rig = new BrowserRig(dir, port, new BrowserTabs.Timing(
                fast.publishEvery(), fast.recentCall(), fast.callWait(), fast.request(), fast.sessionWait(), fast.navigate(), fast.settle(), fast.listEvery(), fast.visibility(), fast.restartEvery(),
                // Backing off as before, the attempts come at 0.1, 0.3, 0.7, 1.5, 3.1, 6.3 and 12.7 s.
                new CdpClient.Timing(Duration.ofMillis(500), Duration.ofMillis(800), min, Duration.ofSeconds(30), Duration.ofMillis(50), Duration.ofMillis(500))));
        TestClient client = rig.connect("cs-a");
        rig.call(client, "browser.stream.set", Map.of("state", "live"), null);
        Thread.sleep(3300);

        cdp = new FakeCdp(port);
        cdp.addPage("a", "https://example.com/a", "A");
        await().atMost(Duration.ofSeconds(2)).until(() -> cdp.upgrades() == 1);
    }

    @Test
    void goingLiveLogsWhenChromiumConnectedAsWell(CapturedOutput output) throws Exception {
        TestClient client = start("a");
        rig.call(client, "browser.stream.set", Map.of("state", "live"), null);
        await().atMost(Duration.ofSeconds(5)).until(() -> output.getOut().contains("to=live"));
        assertThat(output.getOut()).containsPattern(
                "browser\\.stream\\.set timing from=off to=live result=ok browserStartMs=\\d+ streamStartMs=\\d+ stopMs=- unitsMs=\\d+ cdpMs=\\d+ totalMs=\\d+");
        assertThat(output.getOut()).doesNotContain("cs-a");
    }

    // ---- who holds the port

    @SuppressWarnings("unchecked")
    private Map<String, Object> browserHealth() {
        return (Map<String, Object>) rig.module.health().get("browser");
    }

    @Test
    void aListenerWithAnotherUidIsNeverAskedAnythingAndCallsGetUnavailable(CapturedOutput output) throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        AtomicReference<CdpListener.Verdict> table = new AtomicReference<>(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, table::get);
        TestClient client = rig.connect("cs-a");

        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable", Map.of("reason", "chromium"));
        assertErr(rig.call(client, "browser.text.insert", Map.of("text", "secret text", "tabId", "a")), "unavailable", Map.of("reason", "chromium"));
        // It keeps trying while something wants it, and one line is all that says.
        Thread.sleep(200);
        assertThat(output.getOut().lines().filter(line -> line.contains("debugging port")).toList())
                .hasSize(1)
                .allMatch(line -> line.endsWith("listener has uid 1103"));

        assertThat(cdp.httpRequests("/json/version")).isZero();
        assertThat(cdp.httpRequests("/json/list")).isZero();
        assertThat(cdp.upgrades()).isZero();
        assertThat(browserHealth()).containsEntry("cdp", "refused").containsEntry("listenerUid", 1103);

        // Once Chromium has the port, all is as usual.
        table.set(new CdpListener.Verdict(CdpListener.Kind.TRUSTED, 1102));
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
        assertThat(browserHealth()).containsEntry("cdp", "connected").doesNotContainKey("listenerUid");
    }

    @Test
    void whenTheTableCantBeReadNobodyIsTrusted(CapturedOutput output) throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, new CdpListener(dir.resolve("no-such-table"), dir.resolve("no-such-table6"), cdp.port(), BrowserRig.ownUid()));
        TestClient client = rig.connect("cs-a");

        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable", Map.of("reason", "chromium"));
        assertThat(cdp.httpRequests("/json/version")).isZero();
        assertThat(browserHealth()).containsEntry("cdp", "refused").doesNotContainKey("listenerUid");
        assertThat(output.getOut()).contains("can't read who holds it");
    }

    @Test
    void aListenerThatLooksRightOnlyUntilTheConnectionIsOpenHearsNothing() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        // The race: all well as deskd looks, and someone else by the time its WebSocket is open.
        AtomicInteger looks = new AtomicInteger();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, () -> looks.incrementAndGet() == 1
                ? new CdpListener.Verdict(CdpListener.Kind.TRUSTED, 1102)
                : new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
        TestClient client = rig.connect("cs-a");

        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable", Map.of("reason", "chromium"));
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.upgrades() == 1);
        Thread.sleep(100);
        assertThat(cdp.commands()).isEmpty();
        assertThat(browserHealth()).containsEntry("cdp", "refused");
    }

    @Test
    void reconnectingLooksAgain() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        AtomicReference<CdpListener.Verdict> table = new AtomicReference<>(new CdpListener.Verdict(CdpListener.Kind.TRUSTED, 1102));
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, table::get);
        TestClient client = rig.connect("cs-a");
        assertThat(ids(tabs(client))).containsExactly("a");
        int upgrades = cdp.upgrades();
        int versions = cdp.httpRequests("/json/version");

        table.set(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
        cdp.dropConnections();
        await().atMost(Duration.ofSeconds(5)).until(() -> "refused".equals(browserHealth().get("cdp")));
        Thread.sleep(100);
        assertThat(cdp.upgrades()).isEqualTo(upgrades);
        assertThat(cdp.httpRequests("/json/version")).isEqualTo(versions);
    }

    /** What a list reads is what a call goes by, so with someone else on the port it's not read at all. */
    @Test
    void theListIsntReadFromSomeoneElse() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        AtomicReference<CdpListener.Verdict> table = new AtomicReference<>(new CdpListener.Verdict(CdpListener.Kind.TRUSTED, 1102));
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, table::get);
        TestClient client = rig.connect("cs-a");
        assertThat(ids(tabs(client))).containsExactly("a");
        int lists = cdp.httpRequests("/json/list");

        table.set(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
        tabs(client);
        assertThat(cdp.httpRequests("/json/list")).isEqualTo(lists);
    }

    private static final CdpListener.Verdict ON_IPV6_LOOPBACK = new CdpListener.Verdict(CdpListener.Kind.DISPLACED, 1102);
    private static final CdpListener.Verdict ON_THE_PORT = new CdpListener.Verdict(CdpListener.Kind.TRUSTED, 1102);
    private static final String STOP_BROWSER = "stop desk-browser";
    private static final String START_BROWSER = "start desk-browser";

    /**
     * Regression: something held 127.0.0.1 as Chromium started, so Chromium went to ::1, and it stayed there after that
     * something had gone. deskd saw nobody it could reach, and said connecting for ever, as nothing was lost and a start
     * of a running unit does nothing. And on ::1 nftables doesn't keep anyone else off it.
     */
    @Test
    void chromiumOffThePortIsRestartedOntoItAndThenUsed(CapturedOutput output) throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        AtomicReference<CdpListener.Verdict> table = new AtomicReference<>(ON_IPV6_LOOPBACK);
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, table::get);
        rig.units.onRequest(request -> {
            if (START_BROWSER.equals(request)) {
                table.set(ON_THE_PORT);
            }
        });
        TestClient client = rig.connect("cs-a");

        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable", Map.of("reason", "chromium"));
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(rig.units.requests()).containsExactly(STOP_BROWSER, START_BROWSER));
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
        assertThat(browserHealth()).containsEntry("cdp", "connected");
        assertThat(rig.units.isRunning("desk-browser")).isTrue();
        assertThat(output.getOut().lines().filter(line -> line.contains("debugging port")).toList())
                .hasSize(1)
                .allMatch(line -> line.contains("::1"));
    }

    /** A socket only bound to 127.0.0.1 is in no table and sends it back to ::1 each time, and a restart reloads every tab. */
    @Test
    void chromiumThatStaysOffThePortIsntRestartedOverAndOver() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, () -> ON_IPV6_LOOPBACK);
        TestClient client = rig.connect("cs-a");

        for (int i = 0; i < 5; i++) {
            assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable", Map.of("reason", "chromium"));
            Thread.sleep(50);
        }
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(rig.units.requests()).containsExactly(STOP_BROWSER, START_BROWSER));
        Thread.sleep(200);
        assertThat(rig.units.requests()).containsExactly(STOP_BROWSER, START_BROWSER);
        assertThat(browserHealth()).containsEntry("cdp", "displaced").doesNotContainKey("listenerUid");
        assertThat(cdp.httpRequests("/json/version")).isZero();
        assertThat(cdp.upgrades()).isZero();
    }

    /** Once it's been long enough it tries again, so what kept it off the port going away isn't the end of it. */
    @Test
    void chromiumThatStaysOffThePortGetsAnotherTryAfterAWhile() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.timing(Duration.ofMillis(20), Duration.ofSeconds(30), Duration.ofMillis(300)), () -> ON_IPV6_LOOPBACK);
        TestClient client = rig.connect("cs-a");

        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable", Map.of("reason", "chromium"));
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.units.requests().size() >= 4);
        assertThat(rig.units.requests().subList(0, 4)).containsExactly(STOP_BROWSER, START_BROWSER, STOP_BROWSER, START_BROWSER);
    }

    /** With the port held by someone, a restart would only send it back to ::1. Once they've gone, it can have it. */
    @Test
    void whileSomeoneHoldsThePortChromiumIsLeftAloneUntilTheyGo() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        AtomicReference<CdpListener.Verdict> table = new AtomicReference<>(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, table::get);
        TestClient client = rig.connect("cs-a");

        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable", Map.of("reason", "chromium"));
        Thread.sleep(200);
        assertThat(rig.units.requests()).isEmpty();
        assertThat(browserHealth()).containsEntry("cdp", "refused").containsEntry("listenerUid", 1103);

        table.set(ON_IPV6_LOOPBACK);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(rig.units.requests()).containsExactly(STOP_BROWSER, START_BROWSER));
    }

    /** The stop of a restart isn't the stream's stop, so an off that comes during one still stops the stream. */
    @Test
    void anOffDuringARestartStillStopsTheStreamAndLeavesTheBrowserRunning() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        AtomicReference<CdpListener.Verdict> table = new AtomicReference<>(CdpListener.Verdict.NONE);
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, table::get);
        TestClient client = rig.connect("cs-a");
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "live"), null)).containsEntry("state", "live");

        rig.units.hold(STOP_BROWSER);
        table.set(ON_IPV6_LOOPBACK);
        rig.units.awaitHeld(STOP_BROWSER);
        long off = rig.send(client, "browser.stream.set", Map.of("state", "off"), null);
        Thread.sleep(100);
        rig.units.release(STOP_BROWSER);

        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", off).containsEntry("state", "off");
        assertThat(rig.units.requests()).contains("stop desk-stream");
        assertThat(rig.units.isRunning("desk-stream")).isFalse();
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.units.isRunning("desk-browser"));
    }

    /** And with no stream to stop, an off has nothing to wait for, however long Chromium takes to save its session. */
    @Test
    void anOffWithNothingToStopDoesntWaitForARestart() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, () -> ON_IPV6_LOOPBACK);
        rig.units.hold(STOP_BROWSER);
        TestClient client = rig.connect("cs-a");
        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable", Map.of("reason", "chromium"));
        rig.units.awaitHeld(STOP_BROWSER);

        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "off"), null)).containsEntry("state", "off");
        assertThat(rig.units.requests()).containsExactly(STOP_BROWSER);
        rig.units.release(STOP_BROWSER);
    }

    /** It's the stop that failed. Chromium is still running, so there's nothing the start can make worse. */
    @Test
    void aRestartWhoseStopFailsDoesntBreakAnythingElse() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        AtomicReference<CdpListener.Verdict> table = new AtomicReference<>(ON_IPV6_LOOPBACK);
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, table::get);
        rig.units.reply(STOP_BROWSER, "err failed stop desk-browser: no");
        TestClient client = rig.connect("cs-a");

        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable", Map.of("reason", "chromium"));
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(rig.units.requests()).containsExactly(STOP_BROWSER, START_BROWSER));
        table.set(ON_THE_PORT);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
    }

    // ---- no timers, no loops

    @Test
    void anIdleDeskNeverTouchesChromium() throws Exception {
        start("a");
        Thread.sleep(200);
        assertThat(cdp.httpRequests("/json/version")).isZero();
        assertThat(cdp.upgrades()).isZero();
    }

    @Test
    void anIdleDeskWithNoChromiumHasNoReconnectLoop() throws Exception {
        cdp = new FakeCdp();
        int port = cdp.port();
        rig = new BrowserRig(dir, port, BrowserRig.timing(Duration.ofMillis(20), Duration.ofMillis(400)));
        TestClient client = rig.connect("cs-a");
        tabs(client);
        assertThat(cdp.upgrades()).isEqualTo(1);
        cdp.close();
        // A recent call wants it for a while, and then nothing does.
        await().atMost(Duration.ofSeconds(5)).until(() -> Boolean.FALSE.equals(idle()));
        cdp = new FakeCdp(port);
        Thread.sleep(300);
        assertThat(cdp.httpRequests("/json/version")).isZero();
        assertThat(cdp.upgrades()).isZero();
    }

    private Boolean idle() {
        return !"idle".equals(((Map<?, ?>) rig.module.health().get("browser")).get("cdp"));
    }

    @Test
    void theConnectionGoesOnceNothingWantsIt() throws Exception {
        TestClient client = start(BrowserRig.timing(Duration.ofMillis(20), Duration.ofMillis(400)), "a");
        tabs(client);
        assertThat(cdp.isConnected()).isTrue();
        await().atMost(Duration.ofSeconds(5)).until(() -> Boolean.FALSE.equals(idle()));
        int requests = cdp.httpRequests("/json/list");
        Thread.sleep(200);
        assertThat(cdp.httpRequests("/json/list")).isEqualTo(requests);
        assertThat(cdp.upgrades()).isEqualTo(1);
        // And it comes back for the next call.
        assertThat(ids(tabs(client))).containsExactly("a");
        assertThat(cdp.upgrades()).isEqualTo(2);
    }

    @Test
    void aViewerKeepsItAndReconnectsThrough() throws Exception {
        TestClient client = start(BrowserRig.timing(Duration.ofMillis(20), Duration.ofMillis(10)), "a");
        rig.call(client, "browser.stream.set", Map.of("state", "live"), null);
        await().until(() -> cdp.upgrades() == 1);
        Thread.sleep(150);
        assertThat(cdp.upgrades()).isEqualTo(1);

        cdp.dropConnections();
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.upgrades() == 2);

        rig.call(client, "browser.stream.set", Map.of("state", "off"), null);
        await().atMost(Duration.ofSeconds(5)).until(() -> Boolean.FALSE.equals(idle()));
    }

    @Test
    void chromiumGoingAwayUnderAViewerGetsItStartedAgain() throws Exception {
        TestClient client = start("a");
        rig.call(client, "browser.stream.set", Map.of("state", "live"), null);
        await().until(() -> "connected".equals(((Map<?, ?>) rig.module.health().get("browser")).get("cdp")));
        rig.units.clearRequests();
        cdp.dropConnections();
        await().until(() -> rig.units.requests().contains("start desk-browser"));
        assertThat(rig.units.requests()).doesNotContain("stop desk-stream");
    }

    /**
     * Regression: with the connection lost while a new one was settling, it was marked ready anyway, and
     * nothing cleared that. /health said connected, a call got an empty list, and a viewer's Chromium
     * wasn't started again.
     */
    @Test
    void chromiumGoingAwayWhileTheConnectionSettlesIsALostConnection() throws Exception {
        BrowserTabs.Timing fast = BrowserRig.FAST;
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        cdp.hold("Page.enable");
        rig = new BrowserRig(dir, cdp.port(), new BrowserTabs.Timing(
                fast.publishEvery(), fast.recentCall(), fast.callWait(), fast.request(), fast.sessionWait(), fast.navigate(),
                Duration.ofSeconds(5), fast.listEvery(), fast.visibility(), fast.restartEvery(), fast.cdp()));
        TestClient client = rig.connect("cs-a");
        rig.call(client, "browser.stream.set", Map.of("state", "live"), null);
        await().until(() -> !cdp.commands("Page.enable").isEmpty());
        rig.units.clearRequests();
        cdp.refuseUpgrade(true);
        cdp.dropConnections();

        await().until(() -> rig.units.requests().contains("start desk-browser"));
        assertThat(((Map<?, ?>) rig.module.health().get("browser")).get("cdp")).isNotEqualTo("connected");
        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable", Map.of("reason", "chromium"));
        assertErr(rig.call(client, "browser.tab.reload", Map.of()), "unavailable", Map.of("reason", "chromium"));

        cdp.release("Page.enable");
        cdp.refuseUpgrade(false);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
    }

    /** Regression: list checked once, before reading. A connection lost after that looked like no tabs. */
    @Test
    void aConnectionLostDuringAListIsUnavailableAndNotAnEmptyList() throws Exception {
        TestClient client = start(withHttp(READ_OUTLASTS_THE_PROBE), "a");
        tabs(client);
        int reads = cdp.httpRequests("/json/list");
        cdp.hangHttp(true);
        rig.send(client, "browser.tab.list", Map.of(), null);
        await().until(() -> cdp.httpRequests("/json/list") > reads);
        cdp.refuseUpgrade(true);
        cdp.dropConnections();
        assertErr(client.nextReply(), "unavailable", Map.of("reason", "chromium"));
    }

    @Test
    void aSubscriberDuringALostConnectionGetsTheRealListAfterwardsAndNoEmptyOne() throws Exception {
        TestClient client = start(withHttp(READ_OUTLASTS_THE_PROBE), "a");
        tabs(client);
        int reads = cdp.httpRequests("/json/list");
        cdp.hangHttp(true);
        client.subscribe("browser.tabs", null);
        await().until(() -> cdp.httpRequests("/json/list") > reads);
        cdp.refuseUpgrade(true);
        cdp.dropConnections();
        assertQuiet(client, READ_OUTLASTS_THE_PROBE.toMillis() + 300);
        cdp.hangHttp(false);
        cdp.refuseUpgrade(false);
        assertThat(ids(nextSnapshot(client))).containsExactly("a");
    }

    /**
     * Holds up the next look at who's subscribed, once it has passed every session made before this one, until the
     * result is closed. A session with a sink that doesn't return holds its own lock, which that look has to take.
     */
    private AutoCloseable stallLooksAtSubscribers() throws Exception {
        CountDownLatch holding = new CountDownLatch(1);
        CountDownLatch go = new CountDownLatch(1);
        SessionEvents stalling = rig.hub.newSession();
        stalling.attach(new SessionEvents.Sink() {
            @Override
            public void enqueue(long subId, long seq, byte[] payload) {}

            @Override
            public long queuedBytes() {
                holding.countDown();
                try {
                    go.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return 0;
            }
        });
        Thread.ofVirtual().start(stalling::onChannelDrained);
        holding.await();
        return go::countDown;
    }

    /** The events up to one that mentions this, which fails if none does in time. */
    private void assertAnEventMentions(TestClient client, String text) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (System.nanoTime() < deadline) {
            Frame frame = nextEvent(client, 200);
            if (frame != null && new String(frame.payload(), StandardCharsets.UTF_8).contains(text)) {
                return;
            }
        }
        throw new AssertionError("no event mentioned " + text);
    }

    /**
     * Regression: a tick that found nobody subscribed, and was held up before acting on it, wiped what a SUB's snapshot
     * had just left. Every later tick took that for a snapshot on its way, so that client never heard of another change.
     */
    @Test
    void aTickHeldUpWhileSomeoneSubscribesDoesntSilenceThem() throws Exception {
        TestClient client = start("a");
        tabs(client);
        try (AutoCloseable stall = stallLooksAtSubscribers()) {
            cdp.addPage("b", "https://example.com/b", "Title b");
            Thread.sleep(200);
            client.subscribe("browser.tabs", null);
            // Time for a snapshot to finish if nothing is keeping it waiting for that tick.
            Thread.sleep(500);
        }
        Thread.sleep(200);
        cdp.addPage("c", "https://example.com/c", "Title c");
        assertAnEventMentions(client, "Title c");
    }

    /** Regression: the same for a connection that went as someone subscribed: they didn't even get a first snapshot. */
    @Test
    void aLostConnectionHeldUpWhileSomeoneSubscribesDoesntSilenceThem() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.refuseUpgrade(true);
        try (AutoCloseable stall = stallLooksAtSubscribers()) {
            cdp.dropConnections();
            Thread.sleep(200);
            client.subscribe("browser.tabs", null);
            // Past what a snapshot waits for a connection, as nothing is trying one while the look is held up.
            Thread.sleep(1800);
        }
        Thread.sleep(200);
        cdp.refuseUpgrade(false);
        assertAnEventMentions(client, "Title a");
    }

    @Test
    void chromiumGoingAwayWithNoViewerIsLeftAlone() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.dropConnections();
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.upgrades() >= 2);
        assertThat(rig.units.requests()).isEmpty();
    }

    @Test
    void closingDeskdSendsChromiumNothingAndTheNextOneFindsTheSameTabs() throws Exception {
        TestClient client = start("a", "b");
        rig.call(client, "browser.tab.activate", Map.of("tabId", "a"));
        tabs(client);
        List<String> sent = cdp.commands().stream().map(FakeCdp.Command::method).toList();
        rig.module.close();
        await().until(() -> !cdp.isConnected() || "idle".equals(((Map<?, ?>) rig.module.health().get("browser")).get("cdp")));
        assertThat(cdp.commands().stream().map(FakeCdp.Command::method).toList()).isEqualTo(sent);
        assertThat(sent).doesNotContain("Browser.close", "Target.closeTarget", "Target.disposeBrowserContext");
    }

    @Test
    void theHandshakeSendsNoOriginAndGoesToTheConfiguredPort() throws Exception {
        TestClient client = start("a");
        tabs(client);
        assertThat(cdp.upgrades()).isEqualTo(1);
        assertThat(cdp.originHeaders()).isEmpty();
    }

    @Test
    void aRefusedHandshakeIsUnavailableAndRetried() throws Exception {
        TestClient client = start("a");
        cdp.refuseUpgrade(true);
        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable");
        cdp.refuseUpgrade(false);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
    }

    // ---- browser.tabs

    private Frame nextEvent(TestClient client, long millis) throws Exception {
        return rig.fake.pollFrame(client.handle(), Channels.EVENTS, millis);
    }

    /** The next event, joined if it was fragmented. */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> nextSnapshot(TestClient client) throws Exception {
        Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(event).containsEntry("type", "snapshot");
        Map<String, Object> data = Json.object(event, "data");
        assertThat(data).containsOnlyKeys("tabs");
        return (List<Map<String, Object>>) data.get("tabs");
    }

    private void assertQuiet(TestClient client, long millis) throws Exception {
        assertThat(nextEvent(client, millis)).isNull();
    }

    @Test
    void aSubscriberGetsOneSnapshotAndThenSilence() throws Exception {
        TestClient client = start("a", "b");
        assertThat(client.subscribe("browser.tabs", null)).containsEntry("_kind", "RES");
        assertThat(ids(nextSnapshot(client))).containsExactly("a", "b");
        assertQuiet(client, 300);
        cdp.clearCommands();
        int http = cdp.httpRequests("/json/list");
        assertQuiet(client, 200);
        // Only the small command that proves the connection is alive.
        assertThat(cdp.commands().stream().map(FakeCdp.Command::method)).allMatch("Browser.getVersion"::equals);
        assertThat(cdp.httpRequests("/json/list")).isEqualTo(http);
    }

    @Test
    void itsTheSameShapeAsTheList() throws Exception {
        TestClient client = start("a", "b");
        client.subscribe("browser.tabs", null);
        List<Map<String, Object>> snapshot = nextSnapshot(client);
        assertThat(snapshot).isEqualTo(tabs(client));
    }

    @Test
    void aLinkClickedInThePageReachesSubscribers() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        cdp.navigateInPage("a", "https://example.com/clicked", "Clicked");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            List<Map<String, Object>> tabs = nextSnapshot(client);
            assertThat(tabs.get(0)).containsEntry("url", "https://example.com/clicked").containsEntry("title", "Clicked").containsEntry("canGoBack", true);
        });
    }

    @Test
    void aNewAndAClosedTabReachSubscribers() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        cdp.addPage("b", "https://example.com/b", "B");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            List<Map<String, Object>> tabs = nextSnapshot(client);
            assertThat(ids(tabs)).containsExactly("a", "b");
            assertThat(tabs.get(1)).containsEntry("active", true);
        });
        cdp.removeQuietly("b");
        cdp.event("Target.targetDestroyed", Map.of("targetId", "b"), null);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(nextSnapshot(client))).containsExactly("a"));
    }

    @Test
    void anEventThatChangesNothingSendsNothing() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        assertQuiet(client, 100);
        cdp.setTitleWithEvent("a", "Title a");
        cdp.setTitleWithEvent("a", "Title a");
        cdp.event("Page.frameStartedLoading", Map.of("frameId", "some-iframe"), FakeCdp.sessionOf("a"));
        assertQuiet(client, 200);
    }

    @Test
    void aBurstIsCoalescedToAtMostAboutFourASecondAndTheLastWordWins() throws Exception {
        TestClient client = start(BrowserRig.timing(Duration.ofMillis(250), Duration.ofSeconds(30)), "a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        long end = System.nanoTime() + Duration.ofMillis(1000).toNanos();
        int n = 0;
        while (System.nanoTime() < end) {
            cdp.setTitleWithEvent("a", "Title " + n++);
            Thread.sleep(2);
        }
        cdp.setTitleWithEvent("a", "The last one");
        List<List<Map<String, Object>>> events = new ArrayList<>();
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (System.nanoTime() < deadline) {
            Frame frame = nextEvent(client, 500);
            if (frame == null) {
                break;
            }
            events.add(List.of(Json.parseObject(frame.payload())));
            if (frame.payload().length > 0 && new String(frame.payload(), StandardCharsets.UTF_8).contains("The last one")) {
                break;
            }
        }
        assertThat(n).isGreaterThan(50);
        // A second of changes, and the one from before: about 4 a second, with slack for the machine.
        assertThat(events.size()).isBetween(2, 7);
        assertThat(events.get(events.size() - 1).toString()).contains("The last one");
    }

    @Test
    void aTitleOrTabChangedWithNoEventReachesASubscriberWhoIsViewing() throws Exception {
        TestClient client = start("a", "b");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        rig.call(client, "browser.stream.set", Map.of("state", "warm"), null);
        cdp.setTitle("a", "(1) Inbox");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(nextSnapshot(client).get(0)).containsEntry("title", "(1) Inbox"));
        cdp.activateQuietly("a");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(nextSnapshot(client).get(0)).containsEntry("active", true));
    }

    @Test
    void theListIsOnlyReadOverAndOverWhileSomeoneIsSubscribedAndViewing() throws Exception {
        TestClient client = start("a");
        rig.call(client, "browser.stream.set", Map.of("state", "warm"), null);
        tabs(client);
        int viewingOnly = cdp.httpRequests("/json/list");
        Thread.sleep(200);
        assertThat(cdp.httpRequests("/json/list")).isEqualTo(viewingOnly);

        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        int before = cdp.httpRequests("/json/list");
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.httpRequests("/json/list") >= before + 3);

        rig.call(client, "browser.stream.set", Map.of("state", "off"), null);
        await().atMost(Duration.ofSeconds(5)).until(() -> {
            int stopped = cdp.httpRequests("/json/list");
            Thread.sleep(200);
            return cdp.httpRequests("/json/list") == stopped;
        });
    }

    /**
     * Regression: a read that found a change made the next tick due soon, and every tick while viewing was a read, so a
     * page changing its title got reads at the rate of events and not of listEvery, each with its Target.getTargets.
     * Load only spaces reads further apart, so a limit from above holds on a busy machine.
     */
    @Test
    void aTitleThatKeepsChangingDoesntGetTheTabsReadMoreOften() throws Exception {
        Duration listEvery = Duration.ofMillis(200);
        TestClient client = start(withPublishAndList(BrowserRig.FAST.publishEvery(), listEvery), "a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        rig.call(client, "browser.stream.set", Map.of("state", "warm"), null);
        int asked = cdp.commands("Target.getTargets").size();
        int lists = cdp.httpRequests("/json/list");
        long from = System.nanoTime();
        int changes = 0;
        while (System.nanoTime() - from < Duration.ofSeconds(1).toNanos()) {
            cdp.setTitle("a", "Title " + changes++);
            Thread.sleep(5);
        }
        int reads = cdp.commands("Target.getTargets").size() - asked;
        int allowed = (int) ((System.nanoTime() - from) / listEvery.toNanos()) + 1;
        assertThat(reads).isPositive().isLessThanOrEqualTo(allowed);
        assertThat(cdp.httpRequests("/json/list") - lists).isLessThanOrEqualTo(allowed);
        // And they still get there, each read's worth.
        String last = "Title " + (changes - 1);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(nextSnapshot(client).get(0)).containsEntry("title", last));
    }

    /** An event says what it says at once: it needs no read to go with it, viewing or not. */
    @Test
    void whatAnEventSaysIsPublishedWhileViewingWithNoReadOfItsOwn() throws Exception {
        TestClient client = start(withPublishAndList(BrowserRig.FAST.publishEvery(), A_TEST_DECIDES), "a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        rig.call(client, "browser.stream.set", Map.of("state", "warm"), null);
        int asked = cdp.commands("Target.getTargets").size();
        for (int i = 0; i < 3; i++) {
            String told = "Told " + i;
            cdp.setTitleWithEvent("a", told);
            assertThat(nextSnapshot(client).get(0)).containsEntry("title", told);
        }
        assertThat(cdp.commands("Target.getTargets")).hasSize(asked);
    }

    /** What a page can still ask for by itself, by navigating within the document: a read per tick, and no more than that. */
    @Test
    void aPageNavigatingWithinItselfGetsAtMostAReadPerTick() throws Exception {
        Duration publishEvery = Duration.ofMillis(100);
        TestClient client = start(withPublishAndList(publishEvery, A_TEST_DECIDES), "a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        await().until(() -> !cdp.commands("Page.enable").isEmpty());
        int asked = cdp.commands("Target.getTargets").size();
        long from = System.nanoTime();
        while (System.nanoTime() - from < Duration.ofSeconds(1).toNanos()) {
            cdp.event("Page.navigatedWithinDocument", Map.of("frameId", "a", "url", "https://example.com/a#x"), FakeCdp.sessionOf("a"));
            Thread.sleep(5);
        }
        int reads = cdp.commands("Target.getTargets").size() - asked;
        assertThat(reads).isGreaterThan(1).isLessThanOrEqualTo((int) ((System.nanoTime() - from) / publishEvery.toNanos()) + 1);
    }

    /**
     * Any tick can publish, so a read coming due waits out the smallest gap too. In production a read can come due just
     * after a tick for a change. Only a shorter listEvery shows that without a race: here every tick is a read.
     */
    @Test
    void aReadComingDueWaitsOutTheSmallestGapBetweenTicks() throws Exception {
        Duration publishEvery = Duration.ofMillis(300);
        TestClient client = start(withPublishAndList(publishEvery, Duration.ofMillis(20)), "a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        rig.call(client, "browser.stream.set", Map.of("state", "warm"), null);
        int asked = cdp.commands("Target.getTargets").size();
        long from = System.nanoTime();
        Thread.sleep(1200);
        int reads = cdp.commands("Target.getTargets").size() - asked;
        assertThat(reads).isPositive().isLessThanOrEqualTo((int) ((System.nanoTime() - from) / publishEvery.toNanos()) + 1);
    }

    @Test
    void whatACallLearnsReachesSubscribers() throws Exception {
        TestClient client = start("a", "b");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        cdp.setTitle("a", "Learned from a call");
        assertThat(tab(client, "a")).containsEntry("title", "Learned from a call");
        assertThat(nextSnapshot(client).get(0)).containsEntry("title", "Learned from a call");
    }

    @Test
    void aPageFinishingLoadingBringsItsTitleWithNoViewer() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        await().until(() -> !cdp.commands("Page.enable").isEmpty());
        cdp.setTitle("a", "Loaded");
        cdp.event("Page.loadEventFired", Map.of("timestamp", 1), FakeCdp.sessionOf("a"));
        assertThat(nextSnapshot(client).get(0)).containsEntry("title", "Loaded");
    }

    @Test
    void aSubscriberWaitsWhileChromiumIsDownAndGetsItsFirstSnapshotWhenItsUp() throws Exception {
        int port = unusedPort();
        rig = new BrowserRig(dir, port, BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        assertThat(client.subscribe("browser.tabs", null)).containsEntry("_kind", "RES");
        assertQuiet(client, 300);
        assertThat(rig.hub.hasSubscribers("browser.tabs")).isTrue();

        cdp = new FakeCdp(port);
        cdp.addPage("a", "https://example.com/a", "A");
        List<Map<String, Object>> tabs = nextSnapshot(client);
        assertThat(ids(tabs)).containsExactly("a");
        assertQuiet(client, 200);
    }

    @Test
    void theSubscriptionSurvivesChromiumRestartingWithNewTabIds() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        int port = cdp.port();
        cdp.close();
        assertQuiet(client, 200);
        assertThat(rig.hub.hasSubscribers("browser.tabs")).isTrue();
        cdp = new FakeCdp(port);
        cdp.addPage("restored", "https://example.com/a", "A");
        assertThat(ids(nextSnapshot(client))).containsExactly("restored");
    }

    /**
     * Regression: a SUB with the seq it had was served as a replay of nothing, though this topic only
     * publishes while someone is subscribed, so what changed in between was lost, and the connection and
     * the ticker never came back for it.
     */
    @Test
    void aResumedSubscriptionGetsAFreshListWhateverSinceItSends() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.timing(Duration.ofMillis(20), Duration.ofMillis(400)));
        TestClient first = rig.open("cs-a", true, true);
        Map<String, Object> hello = first.hello();
        long seq = ((Number) first.subscribe("browser.tabs", null).get("seq")).longValue();
        nextSnapshot(first);

        rig.fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-a", "reason", "consent_timeout"));
        await().until(() -> !rig.sessions.isLive("cs-a"));
        await().atMost(Duration.ofSeconds(5)).until(() -> Boolean.FALSE.equals(idle()));
        cdp.navigateInPage("a", "https://example.com/while-away", "Away");

        TestClient second = rig.open("cs-b", true, true);
        assertThat(second.hello(Map.of("sessionId", "cs-a", "resumeToken", hello.get("resumeToken")))).containsEntry("resumed", true);
        // The latest seq this session knows: the snapshot it saw.
        assertThat(second.subscribe("browser.tabs", seq + 1)).containsEntry("_kind", "RES");
        assertThat(nextSnapshot(second).get(0)).containsEntry("url", "https://example.com/while-away");
        assertThat(((Map<?, ?>) rig.module.health().get("browser")).get("cdp")).isEqualTo("connected");

        // And its events have started again, with nothing else to wake them.
        cdp.navigateInPage("a", "https://example.com/after", "After");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(nextSnapshot(second).get(0)).containsEntry("url", "https://example.com/after"));
    }

    /** The other way a since can land on stale state: the connection never went, and no tick is due. */
    @Test
    void aSubscriptionAskedForAgainWithItsSeqStillGetsAFreshList() throws Exception {
        TestClient client = start("a");
        long seq = ((Number) client.subscribe("browser.tabs", null).get("seq")).longValue();
        nextSnapshot(client);
        cdp.setTitle("a", "Changed with no event");
        assertThat(client.subscribe("browser.tabs", seq + 1)).containsEntry("_kind", "RES");
        assertThat(nextSnapshot(client).get(0)).containsEntry("title", "Changed with no event");
    }

    /** JDK 21 loses an end of input that arrives while the listener takes a message: see CdpClient. */
    @Test
    void aConnectionCutJustAfterABurstIsNoticedEvenIfTheEndOfInputIsLost() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        for (int cut = 1; cut <= 8; cut++) {
            assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/" + cut))).containsEntry("_kind", "RES");
            cdp.dropConnections();
            int upgrades = cut + 1;
            await().atMost(Duration.ofSeconds(5)).until(() -> cdp.upgrades() == upgrades);
            await().atMost(Duration.ofSeconds(5)).until(() -> cdp.isConnected());
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
        }
    }

    @Test
    void aReconnectWithNothingChangedSendsNothing() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        await().until(() -> !cdp.commands("Page.getNavigationHistory").isEmpty());
        cdp.dropConnections();
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.upgrades() == 2);
        assertQuiet(client, 300);
    }

    @Test
    void callsDuringACutAreUnavailableAndAfterItWork() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.refuseUpgrade(true);
        cdp.dropConnections();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable"));
        cdp.refuseUpgrade(false);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
    }

    @Test
    void aSlowConsumerGetsAFreshSnapshotWhenItCatchesUp() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        rig.fake.autoCredit(false);
        // Big enough for credit (256 KiB) to run out, with what's left going over the 1 MiB backlog.
        String padding = "p".repeat(200);
        for (int i = 0; i < 40; i++) {
            cdp.addPage("page" + i, "https://example.com/" + padding + i, "T" + i);
        }
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Page.enable").size() >= 40);
        for (int i = 0; i < 300; i++) {
            cdp.setTitleWithEvent("a", "Churn " + i);
            Thread.sleep(25);
            if (rig.fake.bytesFromDeskd(client.handle(), Channels.EVENTS) >= com.minimalistalliance.desk.deskd.rtc.RtcClient.INITIAL_CREDIT - 20_000) {
                break;
            }
        }
        cdp.setTitleWithEvent("a", "After the backlog");
        rig.fake.autoCredit(true);
        rig.fake.sendCredit(client.handle(), Channels.EVENTS, 8 * 1024 * 1024);
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            Frame frame = nextEvent(client, 200);
            assertThat(frame).isNotNull();
            assertThat(new String(frame.payload(), StandardCharsets.UTF_8)).contains("After the backlog");
        });
    }

    // ---- where titles come from

    private static final String NEEDS_ESCAPING = "Q&A: <b> \"quoted\" it's";

    /** Regression: titles came from /json/list, where Chromium escapes them for HTML, so a client showed Q&amp;A. */
    @Test
    void aTitleReachesTheListAndTheTopicAsThePageSetIt() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        cdp.setTitle("a", NEEDS_ESCAPING);
        assertThat(tab(client, "a")).containsEntry("title", NEEDS_ESCAPING);
        assertThat(nextSnapshot(client).get(0)).containsEntry("title", NEEDS_ESCAPING);
    }

    @Test
    void aTitleThatComesWithTheFirstListIsAsThePageSetItToo() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", NEEDS_ESCAPING);
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        client.subscribe("browser.tabs", null);
        assertThat(nextSnapshot(client).get(0)).containsEntry("title", NEEDS_ESCAPING);
        assertThat(tab(client, "a")).containsEntry("title", NEEDS_ESCAPING);
    }

    /** Regression: the cut fell on the escaped text, so a title of ampersands kept only 51 of them. */
    @Test
    void theCutIsOfWhatThePageSet() throws Exception {
        TestClient client = start("a");
        cdp.setTitle("a", "&".repeat(BrowserTabs.TITLE_CHARS + 50));
        assertThat(tab(client, "a")).containsEntry("title", "&".repeat(BrowserTabs.TITLE_CHARS));
    }

    @Test
    void aTitleThatNeedsNoEscapingChangingByItselfStillReachesSubscribers() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        rig.call(client, "browser.stream.set", Map.of("state", "warm"), null);
        cdp.setTitle("a", "(1) Inbox");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(nextSnapshot(client).get(0)).containsEntry("title", "(1) Inbox"));
        cdp.setTitle("a", NEEDS_ESCAPING);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(nextSnapshot(client).get(0)).containsEntry("title", NEEDS_ESCAPING));
    }

    /** Regression: an event said it one way and each read of the list the other, and either was a change to publish. */
    @Test
    void aTitleDoesntFlipBetweenFormsAndPublishForNothing() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        rig.call(client, "browser.stream.set", Map.of("state", "warm"), null);
        cdp.setTitleWithEvent("a", NEEDS_ESCAPING);
        assertThat(nextSnapshot(client).get(0)).containsEntry("title", NEEDS_ESCAPING);

        int reads = cdp.httpRequests("/json/list");
        assertQuiet(client, 300);
        // The list was read meanwhile, or that quiet says nothing.
        assertThat(cdp.httpRequests("/json/list")).isGreaterThan(reads);

        cdp.setTitleWithEvent("a", NEEDS_ESCAPING);
        assertQuiet(client, 200);
    }

    @Test
    void theTargetsAreAskedOnlyWithAReadOfTheList() throws Exception {
        TestClient client = start("a");
        rig.call(client, "browser.stream.set", Map.of("state", "warm"), null);
        tabs(client);
        int asked = cdp.commands("Target.getTargets").size();
        Thread.sleep(200);
        assertThat(cdp.commands("Target.getTargets")).hasSize(asked);

        tabs(client);
        assertThat(cdp.commands("Target.getTargets")).hasSize(asked + 1);

        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Target.getTargets").size() >= asked + 4);
        rig.call(client, "browser.stream.set", Map.of("state", "off"), null);
        await().atMost(Duration.ofSeconds(5)).until(() -> {
            int stopped = cdp.commands("Target.getTargets").size();
            Thread.sleep(200);
            return cdp.commands("Target.getTargets").size() == stopped;
        });
    }

    @Test
    void anErrorFromTheTargetsKeepsTheLastTitlesAndTheActiveTab() throws Exception {
        TestClient client = start("a", "b");
        cdp.setTitle("a", "Last known");
        assertThat(tab(client, "a")).containsEntry("title", "Last known");

        cdp.forceError("Target.getTargets", -32000);
        cdp.setTitle("a", "Not seen yet");
        assertThat(ids(tabs(client))).containsExactly("a", "b");
        assertThat(tab(client, "a")).containsEntry("title", "Last known");
        // The order could be read, so a call with no tabId can still tell which tab it's for.
        assertThat(activeOf(client)).isEqualTo("b");
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "x"))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Input.insertText").get(0).sessionId()).isEqualTo(FakeCdp.sessionOf("b"));
        assertThat(cdp.upgrades()).isEqualTo(1);

        cdp.clearForcedErrors();
        assertThat(tab(client, "a")).containsEntry("title", "Not seen yet");
    }

    /** A failed read of the list doesn't say Chromium has gone, so this can't either. The probe is what says that. */
    @Test
    void noAnswerFromTheTargetsKeepsTheLastTitlesAndDoesntLoseChromium() throws Exception {
        TestClient client = start("a");
        rig.call(client, "browser.stream.set", Map.of("state", "live"), null);
        await().until(() -> "connected".equals(((Map<?, ?>) rig.module.health().get("browser")).get("cdp")));
        cdp.setTitle("a", "Last known");
        assertThat(tab(client, "a")).containsEntry("title", "Last known");
        rig.units.clearRequests();

        cdp.hold("Target.getTargets");
        int asked = cdp.commands("Target.getTargets").size();
        cdp.setTitle("a", "Not seen yet");
        assertThat(tab(client, "a")).containsEntry("title", "Last known");
        assertThat(cdp.commands("Target.getTargets").size()).isGreaterThan(asked);

        // A connection dropped for this would have Chromium started again by now, under a viewer.
        Thread.sleep(150);
        assertThat(rig.units.requests()).doesNotContain("start desk-browser");
        assertThat(cdp.upgrades()).isEqualTo(1);
        assertThat(cdp.isConnected()).isTrue();
        assertThat(rig.module.health().get("browser")).isEqualTo(Map.of("cdp", "connected", "tabs", 1, "freeze", "running"));

        cdp.answerHeld("Target.getTargets");
        assertThat(tab(client, "a")).containsEntry("title", "Not seen yet");
    }

    @Test
    void aReplyPastItsReadsWaitSaysNothing() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        cdp.hold("Target.getTargets");
        cdp.setTitle("a", "Too late");
        assertThat(tab(client, "a")).containsEntry("title", "Title a");

        cdp.answerHeld("Target.getTargets");
        assertQuiet(client, 200);
        assertThat(cdp.upgrades()).isEqualTo(1);
        assertThat(tab(client, "a")).containsEntry("title", "Too late");
    }

    /** Side by side, so with both stuck a read waits for one bound and not the sum. */
    @Test
    void aReadOfTheListDoesntWaitForTheTargetsToAnswer() throws Exception {
        TestClient client = start(withHttp(A_TEST_DECIDES), "a");
        tabs(client);
        int lists = cdp.httpRequests("/json/list");
        cdp.hold("Target.getTargets");
        cdp.setTitle("a", "Asked for");
        long id = rig.send(client, "browser.tab.list", Map.of(), null);
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.httpRequests("/json/list") > lists);
        cdp.answerHeld("Target.getTargets");
        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", id);
        // And the call waited for it.
        assertThat(reply.get("tabs").toString()).contains("Asked for");
    }

    /** A refused list answers at once, as it always did, however stuck the targets are. */
    @Test
    void aListThatCantBeReadDoesntWaitForTheTargets() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        AtomicReference<CdpListener.Verdict> table = new AtomicReference<>(new CdpListener.Verdict(CdpListener.Kind.TRUSTED, 1102));
        rig = new BrowserRig(dir, cdp.port(), withHttp(A_TEST_DECIDES), table::get);
        TestClient client = rig.connect("cs-a");
        assertThat(ids(tabs(client))).containsExactly("a");

        cdp.hold("Target.getTargets");
        table.set(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
        long start = System.nanoTime();
        assertThat(ids(tabs(client))).containsExactly("a");
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(A_TEST_DECIDES.dividedBy(2));
    }

    @Test
    void aReadOfTheTargetsAnsweredAfterALaterOneSaysNothing() throws Exception {
        TestClient client = start(withHttp(A_TEST_DECIDES), "a");
        tabs(client);
        int asked = cdp.commands("Target.getTargets").size();
        cdp.hold("Target.getTargets");
        long first = rig.send(client, "browser.tab.list", Map.of(), null);
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Target.getTargets").size() == asked + 1);
        long second = rig.send(client, "browser.tab.list", Map.of(), null);
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Target.getTargets").size() == asked + 2);

        cdp.setTitle("a", "Newest");
        cdp.answerNewestHeld("Target.getTargets");
        Map<String, Object> later = client.nextReply();
        assertThat(later).containsEntry("_id", second);
        assertThat(later.get("tabs").toString()).contains("Newest");

        cdp.setTitle("a", "From before");
        cdp.answerHeld("Target.getTargets");
        Map<String, Object> earlier = client.nextReply();
        assertThat(earlier).containsEntry("_id", first);
        assertThat(earlier.get("tabs").toString()).contains("Newest").doesNotContain("From before");
    }

    /** Replies are taken where events are, in the order Chromium sent them. A thread waking late would undo the event. */
    @Test
    void aReadOfTheTargetsDoesntLandOnAnEventThatCameAfterIt() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        for (int i = 0; i < 5; i++) {
            String newer = "Newer " + i;
            int asked = cdp.commands("Target.getTargets").size();
            cdp.hold("Target.getTargets");
            rig.send(client, "browser.tab.list", Map.of(), null);
            await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Target.getTargets").size() > asked);
            cdp.setTitle("a", "Older " + i);
            cdp.answerHeld("Target.getTargets");
            cdp.setTitleWithEvent("a", newer);
            client.nextReply();
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(nextSnapshot(client).get(0)).containsEntry("title", newer));
        }
    }

    @Test
    void aTabMissingFromTheTargetsStaysWithItsTitle() throws Exception {
        TestClient client = start("a", "b");
        cdp.setTitle("a", "Last known");
        assertThat(tab(client, "a")).containsEntry("title", "Last known");
        cdp.rawTargets("[]");
        cdp.setTitle("a", "Not seen");
        assertThat(ids(tabs(client))).containsExactly("a", "b");
        assertThat(tab(client, "a")).containsEntry("title", "Last known");
    }

    @Test
    void aTabMissingFromTheListStaysAndStillGetsItsTitle() throws Exception {
        TestClient client = start("a", "b");
        tabs(client);
        cdp.rawList("[{\"id\":\"b\",\"type\":\"page\",\"url\":\"https://example.com/b\",\"title\":\"b\"}]");
        cdp.setTitle("a", NEEDS_ESCAPING);
        assertThat(ids(tabs(client))).containsExactly("a", "b");
        assertThat(tab(client, "a")).containsEntry("title", NEEDS_ESCAPING);
    }

    /** Tabs come and go by events: one could be gone from the model already, and the reply from just before. */
    @Test
    void aTabOnlyOneReadKnowsOfDoesntAppear() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.rawTargets("[{\"targetId\":\"a\",\"type\":\"page\",\"url\":\"https://example.com/a\",\"title\":\"A\"},"
                + "{\"targetId\":\"ghost\",\"type\":\"page\",\"url\":\"https://example.com/ghost\",\"title\":\"Ghost\"}]");
        assertThat(ids(tabs(client))).containsExactly("a");
        cdp.rawList("[{\"id\":\"ghost\",\"type\":\"page\",\"url\":\"https://example.com/ghost\",\"title\":\"Ghost\"}]");
        assertThat(ids(tabs(client))).containsExactly("a");
        assertThat(cdp.commands("Target.attachToTarget").stream().map(command -> command.params().get("targetId"))).doesNotContain("ghost");
    }

    /**
     * Regression: a new connection's first read was taken on the connector thread, which could wake after the tab's end
     * had been dealt with. So the tab came back and stayed as long as the connection did, and closing the real last tab
     * counted it, opened no empty one, and left a kiosk Chromium to exit. The real last tab is closed here to see that.
     */
    @Test
    void aTabGoneJustAfterAConnectionsFirstReadDoesntComeBack() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("kept", "https://example.com/kept", "Kept");
        cdp.addPage("doomed-0", "https://example.com/doomed", "Doomed");
        cdp.afterNextReply("Target.getTargets", () -> cdp.destroy("doomed-0"));
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("kept"));
        // Without the fix this comes down to a thread's wake-up, so a few tries, each on a connection of its own.
        for (int round = 1; round <= 5; round++) {
            String doomed = "doomed-" + round;
            int upgrades = cdp.upgrades();
            cdp.refuseUpgrade(true);
            cdp.dropConnections();
            cdp.addPage(doomed, "https://example.com/doomed", "Doomed");
            cdp.afterNextReply("Target.getTargets", () -> cdp.destroy(doomed));
            cdp.refuseUpgrade(false);
            await().atMost(Duration.ofSeconds(5)).until(() -> cdp.upgrades() > upgrades);
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("kept"));
        }
        assertThat(rig.call(client, "browser.tab.close", Map.of("tabId", "kept"))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Target.createTarget")).hasSize(1);
    }

    /** Regression, the same way: Target.createTarget's reply was taken on the thread of the call that sent it. */
    @Test
    void aTabGoneJustAfterItsOpenedDoesntComeBack() throws Exception {
        TestClient client = start("a");
        tabs(client);
        for (int round = 1; round <= 5; round++) {
            String opened = "T" + round;
            cdp.afterNextReply("Target.createTarget", () -> cdp.destroy(opened));
            assertThat(rig.call(client, "browser.tab.open", Map.of())).containsEntry("tabId", opened);
            await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
        }
    }

    @Test
    void aTargetWithNoTitleOrUrlLeavesTheLastOfThem() throws Exception {
        TestClient client = start("a", "b");
        tabs(client);
        cdp.rawTargets("[{\"targetId\":\"a\",\"type\":\"page\"},"
                + "{\"targetId\":\"b\",\"type\":\"page\",\"url\":\"https://example.com/new\",\"title\":7},"
                + "{\"targetId\":7,\"type\":\"page\",\"url\":\"https://example.com/new\",\"title\":\"seven\"},"
                + "7]");
        assertThat(tab(client, "a")).containsEntry("title", "Title a").containsEntry("url", "https://example.com/a");
        assertThat(tab(client, "b")).containsEntry("title", "Title b").containsEntry("url", "https://example.com/b");
        // A title that's really empty is what the page has.
        cdp.rawTargets("[{\"targetId\":\"a\",\"type\":\"page\",\"url\":\"https://example.com/a\",\"title\":\"\"}]");
        assertThat(tab(client, "a")).containsEntry("title", "");
    }

    @Test
    void whatIsntATabSaysNothingOfOne() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.rawTargets("[{\"targetId\":\"a\",\"type\":\"iframe\",\"url\":\"https://example.com/frame\",\"title\":\"Frame\"},"
                + "{\"targetId\":\"a\",\"type\":\"page\",\"subtype\":\"prerender\",\"url\":\"https://example.com/pre\",\"title\":\"Prerender\"}]");
        assertThat(tab(client, "a")).containsEntry("title", "Title a").containsEntry("url", "https://example.com/a");
    }

    @Test
    void whatTheTargetsSayIsCleanedAndCanMakeATabInternal() throws Exception {
        TestClient client = start("a", "b");
        tabs(client);
        cdp.rawTargets("[{\"targetId\":\"a\",\"type\":\"page\",\"url\":\"chrome://settings/\",\"title\":\"Settings\"},"
                + "{\"targetId\":\"b\",\"type\":\"page\",\"url\":\"https://example.com/b\",\"title\":\"evil\\u202Egnp\\u0000.exe\"}]");
        assertThat(ids(tabs(client))).containsExactly("b");
        assertThat(tab(client, "b")).containsEntry("title", "evilgnp.exe");
    }

    // ---- a refresh that takes something away

    /** Regression: authorize ran only at SUB, so a session that lost video kept getting every URL and title. */
    @Test
    void aRefreshThatTakesAwayVideoEndsTheTopicAndTheList() throws Exception {
        TestClient client = start("a");
        assertThat(client.subscribe("browser.tabs", null)).containsEntry("_kind", "RES");
        nextSnapshot(client);
        rig.refresh("cs-a", false, true, BrowserRig.fingerprintOf(client));

        Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(event).containsEntry("type", "error").containsEntry("data", Map.of("code", "forbidden"));
        assertThat(rig.hub.hasSubscribers("browser.tabs")).isFalse();
        cdp.navigateInPage("a", "https://example.com/after", "After");
        assertQuiet(client, 300);
        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "forbidden", Map.of("reason", "permission"));
        assertThat(client.subscribe("browser.tabs", null)).containsEntry("code", "forbidden");
    }

    @Test
    void aRefreshThatKeepsVideoLeavesTheTopicAlone() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        rig.refresh("cs-a", true, false, BrowserRig.fingerprintOf(client));
        cdp.navigateInPage("a", "https://example.com/after", "After");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(nextSnapshot(client).get(0)).containsEntry("url", "https://example.com/after"));
    }

    // ---- web content is untrusted

    @Test
    void titlesAndUrlsAreCutAndCleaned() throws Exception {
        TestClient client = start(withRoomForHostileSizes(), "a");
        tabs(client);
        cdp.navigateInPage("a", "https://example.com/" + "u".repeat(3_000_000), "t".repeat(3_000_000));
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            Map<String, Object> tab = tab(client, "a");
            assertThat((String) tab.get("title")).hasSize(BrowserTabs.TITLE_CHARS);
            assertThat((String) tab.get("url")).hasSize(BrowserTabs.URL_CHARS).startsWith("https://example.com/uuu");
        });
        cdp.setTitle("a", "evil\u202Egnp\u0000\n.exe");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(tab(client, "a")).containsEntry("title", "evilgnp.exe"));
    }

    @Test
    void aTitleWithHalfAPairCantBreakTheListOrTheTopic() throws Exception {
        TestClient client = start("a", "b");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        // JSON can carry half a pair as an escape, and then the Java string holds it.
        cdp.sendRaw("{\"method\":\"Target.targetInfoChanged\",\"params\":{\"targetInfo\":{\"targetId\":\"a\",\"type\":\"page\","
                + "\"title\":\"x\\ud83dy\",\"url\":\"https://example.com/\\ude00\"}}}");
        List<Map<String, Object>> tabs = nextSnapshot(client);
        assertThat(tabs.get(0)).containsEntry("title", "x\ufffdy").containsEntry("url", "https://example.com/\ufffd");
        assertThat(ids(tabs)).containsExactly("a", "b");

        cdp.activateQuietly("a");
        cdp.rawTargets("[{\"targetId\":\"a\",\"type\":\"page\",\"url\":\"https://example.com/\",\"title\":\"y\\ud83dz\"}]");
        assertThat(tab(client, "a")).containsEntry("title", "y\ufffdz").containsEntry("active", true);
    }

    @Test
    void aTitleReadKeepsItsNonAsciiEvenWhenItsCut() throws Exception {
        TestClient client = start("a");
        cdp.setTitle("a", "caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00");
        assertThat(tab(client, "a")).containsEntry("title", "caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00");
        // Past the limit on one string, wherever the cut falls among multi-byte characters.
        cdp.setTitle("a", "\u65e5".repeat(CdpClient.MAX_STRING_CHARS));
        Map<String, Object> tab = tab(client, "a");
        assertThat((String) tab.get("title")).hasSize(BrowserTabs.TITLE_CHARS).matches("\u65e5+");
    }

    @Test
    void aFloodOfHugeTitlesStaysBoundedAndBlocksNothing() throws Exception {
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);
        String huge = "T".repeat(1_500_000);
        Thread flood = Thread.ofVirtual().start(() -> {
            for (int i = 0; i < 40 && !Thread.currentThread().isInterrupted(); i++) {
                cdp.setTitleWithEvent("a", huge + i);
            }
            cdp.setTitleWithEvent("a", "Flood over");
        });
        // While the flood runs, the session answers.
        for (int i = 0; i < 5; i++) {
            client.sendJson(Channels.CTL, FrameKind.PING, i + 1, Map.of());
            assertThat(client.nextJson(Channels.CTL, FrameKind.PONG)).isNotNull();
            assertThat(client.call("no.such.method", Map.of())).containsEntry("code", "not_found");
        }
        flood.join(Duration.ofSeconds(60));
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(client, "a")).containsEntry("title", "Flood over"));
        // Every event that got out was small, whatever went into the socket.
        assertThat(rig.fake.bytesFromDeskd(client.handle(), Channels.EVENTS)).isLessThan(2 * 1024 * 1024);
    }

    @Test
    void aMessageTooBigEvenAfterCuttingIsDroppedAndTheConnectionLives() throws Exception {
        TestClient client = start("a");
        tabs(client);
        StringBuilder many = new StringBuilder("{\"method\":\"Page.windowOpen\",\"params\":{\"windowFeatures\":[");
        for (int i = 0; i < 600_000; i++) {
            many.append("\"xxxxx\",");
        }
        many.append("\"x\"]}}");
        cdp.sendRaw(many.toString());
        cdp.sendRaw("{not json at all");
        cdp.sendRaw("[1,2,3]");
        cdp.sendRaw("{\"id\":\"nonsense\"}");
        cdp.setTitleWithEvent("a", "Still here");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(tab(client, "a")).containsEntry("title", "Still here"));
        assertThat(cdp.upgrades()).isEqualTo(1);
    }

    @Test
    void aHostileNumberOfTabsStillFitsOneEventAndTheActiveTabStays() throws Exception {
        cdp = new FakeCdp();
        String url = "https://example.com/" + "u".repeat(2000);
        for (int i = 0; i < BrowserTabs.MAX_TABS + 50; i++) {
            cdp.addPage("t" + i, url + i, "T".repeat(200));
        }
        cdp.activateQuietly("t100");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        client.subscribe("browser.tabs", null);
        List<Map<String, Object>> tabs = nextSnapshot(client);
        assertThat(tabs).isNotEmpty();
        assertThat(ids(tabs)).contains("t100");
        assertThat(tabs.stream().filter(tab -> Boolean.TRUE.equals(tab.get("active"))).map(tab -> tab.get("tabId")))
                .containsExactly("t100");
        assertThat(Json.bytes(Map.of("type", "snapshot", "data", Map.of("tabs", tabs))).length)
                .isLessThanOrEqualTo(FrameKind.EVT.maxMessageBytes());
        assertThat(tabs.get(0)).containsOnlyKeys("tabId", "url", "title", "loading", "active", "canGoBack", "canGoForward");
    }

    @Test
    void aTargetWithAnOddIdIsIgnored() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.sendRaw("{\"method\":\"Target.targetCreated\",\"params\":{\"targetInfo\":{\"targetId\":\"x\\ud83d y\",\"type\":\"page\",\"title\":\"t\",\"url\":\"https://x/\"}}}");
        cdp.setTitle("a", "Marker");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(tab(client, "a")).containsEntry("title", "Marker"));
        assertThat(ids(tabs(client))).containsExactly("a");
    }

    // ---- hangs

    @Test
    void aHungChromiumBlocksNeitherPingNorAnotherRpcNorAnotherSession() throws Exception {
        TestClient client = start("a");
        TestClient other = rig.connect("cs-b");
        tabs(client);
        await().until(() -> !cdp.commands("Page.enable").isEmpty());
        cdp.hold("Input.insertText");
        long id = rig.send(client, "browser.text.insert", Map.of("text", "x"), "hung");

        client.sendJson(Channels.CTL, FrameKind.PING, 9, Map.of());
        assertThat(client.nextJson(Channels.CTL, FrameKind.PONG)).isNotNull();
        assertThat(ids(tabs(other))).containsExactly("a");
        assertThat(other.call("no.such.method", Map.of())).containsEntry("code", "not_found");
        assertThat(rig.call(client, "browser.tab.reload", Map.of())).containsEntry("_kind", "RES");

        // A hung page's command gets its time, then one stable answer, and the connection stays.
        assertErr(client.nextReply(), "unavailable", MAY_HAVE_APPLIED);
        assertThat(cdp.upgrades()).isEqualTo(1);
        assertThat(id).isPositive();
    }

    @Test
    void aBrowserThatStopsAnsweringLosesItsConnectionAndComesBack() throws Exception {
        TestClient client = start("a");
        tabs(client);
        cdp.hold("Target.activateTarget");
        assertErr(rig.call(client, "browser.tab.activate", Map.of("tabId", "a")), "unavailable");
        cdp.release("Target.activateTarget");
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.upgrades() == 2);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(ids(tabs(client))).containsExactly("a"));
    }

    @Test
    void aHungDebuggingPortHoldsACallOnlyForItsBoundedWait() throws Exception {
        TestClient client = start("a");
        cdp.hangHttp(true);
        long start = System.nanoTime();
        assertErr(rig.call(client, "browser.tab.list", Map.of(), null), "unavailable");
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(3));
        client.sendJson(Channels.CTL, FrameKind.PING, 9, Map.of());
        assertThat(client.nextJson(Channels.CTL, FrameKind.PONG)).isNotNull();
    }

    @Test
    void aHungTargetListLeavesTheLastActiveTabRatherThanFailingTheCall() throws Exception {
        TestClient client = start("a", "b");
        assertThat(activeOf(client)).isEqualTo("b");
        cdp.hangHttp(true);
        assertThat(ids(tabs(client))).containsExactly("a", "b");
        assertThat(activeOf(client)).isEqualTo("b");
    }

    @Test
    void healthStaysUpWhateverChromiumDoes() throws Exception {
        TestClient client = start("a");
        Map<String, Object> idle = rig.module.health();
        assertThat(idle.get("browser")).isEqualTo(Map.of("cdp", "idle", "tabs", 0, "freeze", "running"));
        tabs(client);
        rig.call(client, "browser.stream.set", Map.of("state", "warm"), null);
        Map<String, Object> up = rig.module.health();
        assertThat(((Map<?, ?>) up.get("browser")).get("cdp")).isEqualTo("connected");
        assertThat(((Map<?, ?>) up.get("browser")).get("tabs")).isEqualTo(1);
        assertThat(((Map<?, ?>) up.get("stream")).get("wanted")).isEqualTo("warm");
        // Counts and states only.
        assertThat(new String(Json.bytes(up), StandardCharsets.UTF_8)).doesNotContain("example.com");
    }

    // ---- the log

    @Test
    void nothingMemberTypedOrVisitedReachesTheLog(CapturedOutput output) throws Exception {
        String urlMarker = "url-marker-7f3a";
        String titleMarker = "title-marker-9c1b";
        String textMarker = "text-marker-2e8d";
        TestClient client = start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot(client);

        rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/" + urlMarker));
        rig.call(client, "browser.tab.open", Map.of("url", "https://example.com/" + urlMarker + "2"));
        rig.call(client, "browser.text.insert", Map.of("text", textMarker));
        cdp.setTitle("a", titleMarker);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(tab(client, "a")).containsEntry("title", titleMarker));

        // And on every way a call can go wrong.
        cdp.navigateError("https://example.com/" + urlMarker + "3", "net::ERR_" + urlMarker);
        rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/" + urlMarker + "3"));
        rig.call(client, "browser.tab.navigate", Map.of("url", "javascript:" + urlMarker));
        rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/" + urlMarker + "x".repeat(BrowserUrl.MAX_CHARS)));
        cdp.hold("Input.insertText");
        rig.call(client, "browser.text.insert", Map.of("text", textMarker));
        cdp.forceError("Page.navigate", -32000);
        rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/" + urlMarker + "4"));
        cdp.clearForcedErrors();
        cdp.sendRaw("{broken " + titleMarker);
        cdp.dropConnections();
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.upgrades() == 2);

        assertThat(output.getAll())
                .doesNotContain(urlMarker)
                .doesNotContain(titleMarker)
                .doesNotContain(textMarker);
    }

    private static int unusedPort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

}
