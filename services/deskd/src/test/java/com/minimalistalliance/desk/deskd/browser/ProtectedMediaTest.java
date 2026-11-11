package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
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
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * A page refused protected playback marks its tab (TD-225), through the Browser module as it's wired, against a fake
 * debugging port. What the page's world really does with the scripts is {@code ChromiumIT}'s to show.
 */
@ExtendWith(OutputCaptureExtension.class)
class ProtectedMediaTest {

    private static final Duration QUIET = Duration.ofMillis(400);
    private static final String LOG_LINE = "a protected video couldn't play in tab ";

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private BrowserRig rig;
    private TestClient client;

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
        start(() -> true, pages);
    }

    private void start(java.util.function.BooleanSupplier on, String... pages) throws Exception {
        cdp = new FakeCdp();
        for (String page : pages) {
            cdp.addPage(page, "https://films.example/" + page, "Title " + page);
        }
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        rig.module.followProtectedMediaSwitch(on);
        client = rig.connect("cs-a");
        // A call keeps the connection wanted, and the tabs attached, for the rest of the test.
        tabs();
        for (String page : pages) {
            await().until(() -> bindings(page) == 1);
        }
    }

    /** Starts with the switch off: a tab is attached and listed, and nothing of ours is in it. */
    private void startOff(java.util.concurrent.atomic.AtomicBoolean on, String... pages) throws Exception {
        cdp = new FakeCdp();
        for (String page : pages) {
            cdp.addPage(page, "https://films.example/" + page, "Title " + page);
        }
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        rig.module.followProtectedMediaSwitch(on::get);
        client = rig.connect("cs-a");
        tabs();
        for (String page : pages) {
            await().until(() -> cdp.commands("Page.enable").stream().anyMatch(c -> FakeCdp.sessionOf(page).equals(c.sessionId())));
        }
    }

    private long onSession(String page, String method) {
        return cdp.commands(method).stream().filter(c -> FakeCdp.sessionOf(page).equals(c.sessionId())).count();
    }

    private long bindings(String page) {
        return cdp.commands("Runtime.addBinding").stream().filter(c -> FakeCdp.sessionOf(page).equals(c.sessionId())).count();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> tabs() throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.list", Map.of(), null);
        assertThat(reply).containsEntry("_kind", "RES");
        return (List<Map<String, Object>>) reply.get("tabs");
    }

    private Map<String, Object> tab(String id) throws Exception {
        return tabs().stream().filter(tab -> id.equals(tab.get("tabId"))).findFirst().orElseThrow();
    }

    private Map<String, Object> seen(String id) throws Exception {
        return Json.object(tab(id), "protectedMedia");
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> nextSnapshot() throws Exception {
        Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(event).containsEntry("type", "snapshot");
        return (List<Map<String, Object>>) Json.object(event, "data").get("tabs");
    }

    private void assertQuiet() throws Exception {
        assertThat(rig.fake.pollFrame(client.handle(), Channels.EVENTS, QUIET.toMillis())).isNull();
    }

    @Test
    void aWidevineRefusalMarksItsTabAndNoOther(CapturedOutput output) throws Exception {
        Instant before = Instant.now().minusSeconds(1);
        start("a", "b");
        client.subscribe("browser.tabs", null);
        assertThat(nextSnapshot()).allSatisfy(tab -> assertThat(tab).doesNotContainKey("protectedMedia"));

        cdp.bindingCalled("a", "wv");

        List<Map<String, Object>> snapshot = nextSnapshot();
        Map<String, Object> a = snapshot.stream().filter(tab -> "a".equals(tab.get("tabId"))).findFirst().orElseThrow();
        Map<String, Object> b = snapshot.stream().filter(tab -> "b".equals(tab.get("tabId"))).findFirst().orElseThrow();
        Map<String, Object> media = Json.object(a, "protectedMedia");
        assertThat(media).containsOnlyKeys("at", "keySystem").containsEntry("keySystem", "com.widevine.alpha");
        Instant at = Instant.parse((String) media.get("at"));
        assertThat(at).isBetween(before, Instant.now().plusSeconds(1));
        assertThat((String) media.get("at")).matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z");
        assertThat(b).doesNotContainKey("protectedMedia");
        // The list says the same, and the page's address is only where tabs already have it.
        assertThat(seen("a")).isEqualTo(media);
        assertThat(output).contains(LOG_LINE + "a").doesNotContain("films.example").doesNotContain("widevine");
    }

    @Test
    void playReadyAndFairPlayAreTheirOwnKeySystems() throws Exception {
        start("a", "b");
        cdp.bindingCalled("a", "pr");
        cdp.bindingCalled("b", "fps");
        await().until(() -> seen("a") != null && seen("b") != null);
        assertThat(seen("a")).containsEntry("keySystem", "com.microsoft.playready");
        assertThat(seen("b")).containsEntry("keySystem", "com.apple.fps");
    }

    @Test
    void aMediaErrorThatIsntProtectedPlaybackSaysNothing(CapturedOutput output) throws Exception {
        start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot();
        // A player's own error, as the Media domain would tell of it if anything had enabled it: nothing does.
        cdp.event("Media.playerErrorsRaised", Map.of("playerId", "p1", "errors", List.of(Map.of(
                "errorType", "PipelineStatus", "code", 4, "stack", List.of(), "cause", List.of(), "data", Map.of()))), FakeCdp.sessionOf("a"));
        // ClearKey, which Chromium has, never comes as a word, and nor does anything else; nor another binding's call.
        cdp.bindingCalled("a", "ck");
        cdp.bindingCalled("a", "org.w3.clearkey");
        cdp.bindingCalled("a", "");
        cdp.bindingCalled("a", "somebodyElse", "wv");
        cdp.event("Runtime.bindingCalled", Map.of("name", "x"), FakeCdp.sessionOf("a"));

        assertQuiet();
        assertThat(tab("a")).doesNotContainKey("protectedMedia");
        assertThat(output).doesNotContain(LOG_LINE);
        assertThat(cdp.commands().stream().map(FakeCdp.Command::method))
                .doesNotContain("Media.enable", "Runtime.enable", "Log.enable", "Debugger.enable", "Network.enable");
    }

    @Test
    void repeatedRefusalsOnOnePageAreOneEvent(CapturedOutput output) throws Exception {
        start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot();
        cdp.bindingCalled("a", "wv");
        Map<String, Object> first = Json.object(nextSnapshot().get(0), "protectedMedia");
        assertThat(first).containsEntry("keySystem", "com.widevine.alpha");

        for (String word : List.of("wv", "wv", "pr", "fps", "wv")) {
            cdp.bindingCalled("a", word);
        }
        // A same-document navigation, as a single-page site makes between its own pages, is the same page load.
        cdp.event("Page.navigatedWithinDocument", Map.of("frameId", "a", "url", "https://films.example/a#next"), FakeCdp.sessionOf("a"));
        cdp.bindingCalled("a", "wv");

        assertQuiet();
        assertThat(seen("a")).isEqualTo(first);
        assertThat(output.getAll().split(LOG_LINE, -1)).hasSize(2);
    }

    @Test
    void aNavigationClearsItAndTheNextPageIsWatchedAfresh(CapturedOutput output) throws Exception {
        start("a");
        client.subscribe("browser.tabs", null);
        nextSnapshot();
        cdp.bindingCalled("a", "wv");
        assertThat(Json.object(nextSnapshot().get(0), "protectedMedia")).containsEntry("keySystem", "com.widevine.alpha");

        cdp.navigateInPage("a", "https://films.example/next", "Next");
        await().atMost(Duration.ofSeconds(5)).until(() -> {
            Map<String, Object> tab = nextSnapshot().get(0);
            return "https://films.example/next".equals(tab.get("url")) && !tab.containsKey("protectedMedia");
        });
        // The new document gets deskd's listener of its own.
        await().until(() -> bindings("a") == 2);

        cdp.bindingCalled("a", "fps");
        await().atMost(Duration.ofSeconds(5)).until(() -> nextSnapshot().get(0).containsKey("protectedMedia"));
        assertThat(seen("a")).containsEntry("keySystem", "com.apple.fps");
        assertThat(output.getAll().split(LOG_LINE, -1)).hasSize(3);
    }

    @Test
    void aTabThatsGoneOrNotAMembersSaysNothing() throws Exception {
        start("a");
        String name = (String) cdp.commands("Runtime.addBinding").get(0).params().get("name");
        cdp.addTarget("settings", "page", null, "chrome://settings/", "Settings");
        cdp.destroy("a");
        await().until(() -> tabs().isEmpty());
        cdp.bindingCalled("a", name, "wv");
        cdp.bindingCalled("settings", name, "wv");
        Thread.sleep(QUIET.toMillis());
        assertThat(tabs()).isEmpty();
        // No session was ever opened on an internal page, so nothing was put in it.
        assertThat(cdp.commands("Page.addScriptToEvaluateOnNewDocument")).noneSatisfy(c ->
                assertThat(c.sessionId()).isEqualTo(FakeCdp.sessionOf("settings")));
    }

    /**
     * What deskd puts in a tab, and where: the page's half in the page's own world with no binding there, and deskd's
     * half in its isolated world, with the binding in that one context alone. Runtime is never enabled, so a page's
     * console costs nothing and can't tell.
     */
    @Test
    void thePageGetsAScriptAndNoBindingAndDeskdsWorldGetsTheBinding() throws Exception {
        start("a");
        List<String> onA = cdp.commands().stream().filter(c -> FakeCdp.sessionOf("a").equals(c.sessionId())).map(FakeCdp.Command::method).toList();
        assertThat(onA).containsSubsequence("Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Page.createIsolatedWorld",
                "Runtime.addBinding", "Runtime.evaluate", "Page.getNavigationHistory");
        assertThat(onA).doesNotContain("Runtime.enable");

        FakeCdp.Command script = cdp.commands("Page.addScriptToEvaluateOnNewDocument").get(0);
        assertThat(script.params()).containsEntry("runImmediately", true).doesNotContainKey("worldName");
        String source = (String) script.params().get("source");
        assertThat(source).contains("requestMediaKeySystemAccess");

        FakeCdp.Command binding = cdp.commands("Runtime.addBinding").get(0);
        String name = (String) binding.params().get("name");
        assertThat(binding.params()).containsOnlyKeys("name", "executionContextId");
        assertThat(source).doesNotContain(name);

        FakeCdp.Command world = cdp.commands("Page.createIsolatedWorld").stream()
                .filter(c -> FakeCdp.sessionOf("a").equals(c.sessionId())).findFirst().orElseThrow();
        assertThat(world.params()).containsEntry("frameId", "a").containsEntry("worldName", "ma-deskd");
        FakeCdp.Command armed = cdp.commands("Runtime.evaluate").stream()
                .filter(c -> String.valueOf(c.params().get("expression")).contains(name)).findFirst().orElseThrow();
        assertThat(armed.params().get("contextId")).isEqualTo(binding.params().get("executionContextId"));
    }

    @Test
    void anErrorPageIsntWatched() throws Exception {
        start("a");
        cdp.failNavigation("a", "https://down.example/", "ERR_CONNECTION_REFUSED");
        await().until(() -> "https://down.example/".equals(tab("a").get("url")));
        Thread.sleep(QUIET.toMillis());
        assertThat(bindings("a")).isEqualTo(1);
    }

    @Test
    void theNamesAreNewWithEachDeskdAndTheTwoScriptsAgree() {
        ProtectedMedia one = new ProtectedMedia();
        ProtectedMedia two = new ProtectedMedia();
        assertThat(one.binding()).isNotEqualTo(two.binding());
        ProtectedMedia fixed = new ProtectedMedia("0123456789abcdef");
        assertThat(fixed.binding()).isEqualTo("ma0123456789abcdefb");
        for (String name : List.of("ma0123456789abcdeff", "ma0123456789abcdefh")) {
            assertThat(fixed.pageScript()).contains("'" + name);
            assertThat(fixed.worldScript()).contains("'" + name);
        }
        assertThat(fixed.pageScript()).contains("'ma0123456789abcdefa'").doesNotContain("ma0123456789abcdefb").doesNotContain("@");
        assertThat(fixed.worldScript()).contains("'ma0123456789abcdefb'").doesNotContain("@");
    }

    @Test
    void onlyThisDesksBindingAndTheThreeWordsCount() {
        ProtectedMedia media = new ProtectedMedia("0123456789abcdef");
        String name = media.binding();
        assertThat(media.keySystem(Map.of("name", name, "payload", "wv"))).isEqualTo("com.widevine.alpha");
        assertThat(media.keySystem(Map.of("name", name, "payload", "pr"))).isEqualTo("com.microsoft.playready");
        assertThat(media.keySystem(Map.of("name", name, "payload", "fps"))).isEqualTo("com.apple.fps");
        assertThat(media.keySystem(Map.of("name", name, "payload", "com.widevine.alpha"))).isNull();
        assertThat(media.keySystem(Map.of("name", name, "payload", "ck"))).isNull();
        assertThat(media.keySystem(Map.of("name", name))).isNull();
        assertThat(media.keySystem(Map.of("name", name, "payload", 1))).isNull();
        assertThat(media.keySystem(Map.of("name", "ma0123456789abcdefa", "payload", "wv"))).isNull();
        assertThat(media.keySystem(Map.of("payload", "wv"))).isNull();
    }

    @Test
    void withTheSwitchOffNothingIsInjectedAndNoTabCarriesIt() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean on = new java.util.concurrent.atomic.AtomicBoolean(false);
        startOff(on, "a", "b");
        client.subscribe("browser.tabs", null);
        nextSnapshot();
        cdp.navigateInPage("a", "https://films.example/next", "Next");
        await().atMost(Duration.ofSeconds(5)).until(() -> "https://films.example/next".equals(tab("a").get("url")));
        Thread.sleep(QUIET.toMillis());

        assertThat(cdp.commands("Page.addScriptToEvaluateOnNewDocument")).isEmpty();
        assertThat(cdp.commands("Runtime.addBinding")).isEmpty();
        assertThat(cdp.commands("Page.removeScriptToEvaluateOnNewDocument")).isEmpty();
        assertThat(tabs()).allSatisfy(tab -> assertThat(tab).doesNotContainKey("protectedMedia"));
    }

    @Test
    void aBindingCallWithTheSwitchOffIsIgnored() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean on = new java.util.concurrent.atomic.AtomicBoolean(true);
        start(on::get, "a");
        on.set(false);
        cdp.bindingCalled("a", "wv");
        assertQuiet();
        assertThat(tab("a")).doesNotContainKey("protectedMedia");
    }

    @Test
    void turningItOffWithTabsOpenTakesTheScriptOutAndClearsTheMark() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean on = new java.util.concurrent.atomic.AtomicBoolean(true);
        start(on::get, "a", "b");
        client.subscribe("browser.tabs", null);
        nextSnapshot();
        cdp.bindingCalled("a", "wv");
        assertThat(Json.object(nextSnapshot().get(0), "protectedMedia")).containsEntry("keySystem", "com.widevine.alpha");
        List<String> registered = List.of("script-1", "script-2");
        assertThat(cdp.commands("Page.addScriptToEvaluateOnNewDocument")).hasSize(2);

        on.set(false);
        // The next tick sees it, as anyone watching the tabs would: a tick is what a change in a tab starts.
        cdp.navigateInPage("b", "https://films.example/b2", "B2");
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Page.removeScriptToEvaluateOnNewDocument").size() == 2);
        assertThat(cdp.commands("Page.removeScriptToEvaluateOnNewDocument").stream().map(c -> c.params().get("identifier")))
                .containsExactlyInAnyOrderElementsOf(registered);
        await().atMost(Duration.ofSeconds(5)).until(() -> tabs().stream().noneMatch(tab -> tab.containsKey("protectedMedia")));

        // The document b2 was not armed, as the switch said off by its commit.
        assertThat(onSession("b", "Runtime.addBinding")).isEqualTo(1);
    }

    @Test
    void turningItBackOnWatchesTheTabsAgain() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean on = new java.util.concurrent.atomic.AtomicBoolean(false);
        startOff(on, "a");
        assertThat(cdp.commands("Page.addScriptToEvaluateOnNewDocument")).isEmpty();
        client.subscribe("browser.tabs", null);
        nextSnapshot();

        on.set(true);
        cdp.navigateInPage("a", "https://films.example/next", "Next");
        await().atMost(Duration.ofSeconds(5)).until(() -> onSession("a", "Page.addScriptToEvaluateOnNewDocument") == 1);
        await().atMost(Duration.ofSeconds(5)).until(() -> onSession("a", "Runtime.addBinding") >= 1);
        cdp.bindingCalled("a", "fps");
        await().atMost(Duration.ofSeconds(5)).until(() -> seen("a") != null);
        assertThat(seen("a")).containsEntry("keySystem", "com.apple.fps");
    }

    @Test
    void theSwitchFileIsReadWhileDeskdRuns() throws Exception {
        Path volume = Files.createDirectories(dir.resolve("volume"));
        java.util.function.BooleanSupplier file = ProtectedMedia.switchIn(volume);
        assertThat(file.getAsBoolean()).isTrue();
        Files.writeString(volume.resolve(ProtectedMedia.SWITCH_FILE), "off\n");
        await().atMost(Duration.ofSeconds(5)).until(() -> !file.getAsBoolean());
        // Only that word counts: an empty file, or any other word, changes nothing.
        Files.writeString(volume.resolve(ProtectedMedia.SWITCH_FILE), "media-actions-off\n");
        await().atMost(Duration.ofSeconds(5)).until(file::getAsBoolean);
        Files.delete(volume.resolve(ProtectedMedia.SWITCH_FILE));
        await().atMost(Duration.ofSeconds(5)).until(file::getAsBoolean);
    }
}
