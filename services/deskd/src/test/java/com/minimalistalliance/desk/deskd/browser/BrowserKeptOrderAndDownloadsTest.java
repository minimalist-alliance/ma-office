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
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Through a client's frames against a fake debugging port: the tab order kept on the data volume across a restart of
 * Chromium (LS-36), and the topic browser.downloads (LS-31).
 */
class BrowserKeptOrderAndDownloadsTest {

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private BrowserRig rig;
    private String dataDirBefore;

    private static final String GUID = "0f6c3b7e-8a2d-4c1e-9b5a-2d7e8f9a0b1c";

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (cdp != null) {
            cdp.close();
        }
        if (dataDirBefore == null) {
            System.clearProperty("deskd.data.dir");
        } else {
            System.setProperty("deskd.data.dir", dataDirBefore);
        }
    }

    /** deskd's data volume, as TabOrder finds it on a desk. Set before a rig, as BrowserTabs reads it once. */
    private Path dataVolume() throws Exception {
        Path data = Files.createDirectories(dir.resolve("data"));
        dataDirBefore = System.getProperty("deskd.data.dir");
        System.setProperty("deskd.data.dir", data.toString());
        return data;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> tabs(TestClient client) throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.list", Map.of(), null);
        assertThat(reply).containsEntry("_kind", "RES");
        return (List<Map<String, Object>>) reply.get("tabs");
    }

    private static List<String> urls(List<Map<String, Object>> tabs) {
        return tabs.stream().map(tab -> (String) tab.get("url")).toList();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> nextDownloads(TestClient client) throws Exception {
        Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(event).containsEntry("type", "snapshot");
        Map<String, Object> data = Json.object(event, "data");
        assertThat(data).containsOnlyKeys("downloads");
        return (List<Map<String, Object>>) data.get("downloads");
    }

    // ---- the kept order (LS-36)

    @Test
    void aRestartedChromiumsTabsComeBackInTheOrderTheyHad() throws Exception {
        Path data = dataVolume();
        cdp = new FakeCdp();
        cdp.addPage("A1", "https://example.com/a", "A");
        cdp.addPage("B1", "https://example.com/b", "B");
        cdp.addPage("C1", "https://example.com/c", "C");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        assertThat(urls(tabs(client))).containsExactly("https://example.com/a", "https://example.com/b", "https://example.com/c");
        await().atMost(Duration.ofSeconds(5)).until(() -> Files.exists(data.resolve(TabOrder.FILE)));
        rig.close();
        rig = null;

        // A stop and a wake: Chromium restores the same pages with new ids, and lists them most recently used first.
        for (String id : List.of("A1", "B1", "C1")) {
            cdp.removeQuietly(id);
        }
        cdp.addPage("C2", "https://example.com/c", "C");
        cdp.addPage("A2", "https://example.com/a", "A");
        cdp.addPage("B2", "https://example.com/b", "B");
        rig = new BrowserRig(Files.createDirectories(dir.resolve("second")), cdp.port(), BrowserRig.FAST);
        client = rig.connect("cs-b");
        List<Map<String, Object>> after = tabs(client);
        assertThat(after).extracting(tab -> tab.get("tabId")).containsExactly("A2", "B2", "C2");
        assertThat(Files.readString(data.resolve(TabOrder.FILE))).doesNotContain("example.com");
    }

    @Test
    void theHomePageKeepsItsPlaceAcrossAStopAndWakeAndStaysWithoutAnAddress() throws Exception {
        Path data = dataVolume();
        String home = "file:///usr/local/share/ma/home.html";
        cdp = new FakeCdp();
        cdp.addPage("A1", "https://example.com/a", "A");
        cdp.addPage("H1", home, "Desk Browser");
        cdp.addPage("B1", "https://example.com/b", "B");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        assertThat(urls(tabs(client))).containsExactly("https://example.com/a", "", "https://example.com/b");
        await().atMost(Duration.ofSeconds(5)).until(() -> Files.exists(data.resolve(TabOrder.FILE)));
        rig.close();
        rig = null;
        for (String id : List.of("A1", "H1", "B1")) {
            cdp.removeQuietly(id);
        }
        cdp.addPage("B2", "https://example.com/b", "B");
        cdp.addPage("H2", home, "Desk Browser");
        cdp.addPage("A2", "https://example.com/a", "A");
        rig = new BrowserRig(Files.createDirectories(dir.resolve("second")), cdp.port(), BrowserRig.FAST);
        client = rig.connect("cs-b");
        List<Map<String, Object>> after = tabs(client);
        assertThat(after).extracting(tab -> tab.get("tabId")).containsExactly("A2", "H2", "B2");
        assertThat(urls(after)).containsExactly("https://example.com/a", "", "https://example.com/b");
        assertThat(after.get(1)).containsEntry("title", "New tab");
    }

    @Test
    void withNoOrderKeptTabsAreInTheOrderChromiumListsThem() throws Exception {
        dataVolume();
        cdp = new FakeCdp();
        cdp.addPage("C2", "https://example.com/c", "C");
        cdp.addPage("A2", "https://example.com/a", "A");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        assertThat(tabs(client)).extracting(tab -> tab.get("tabId")).containsExactly("C2", "A2");
    }

    @Test
    void aTabOpenedLaterGoesAtTheEndAndKeepsThatPlace() throws Exception {
        Path data = dataVolume();
        cdp = new FakeCdp();
        cdp.addPage("A1", "https://example.com/a", "A");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        tabs(client);
        Map<String, Object> opened = rig.call(client, "browser.tab.open", Map.of("url", "https://example.com/new"));
        assertThat(opened).containsEntry("_kind", "RES");
        assertThat(urls(tabs(client))).containsExactly("https://example.com/a", "https://example.com/new");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(Files.readString(data.resolve(TabOrder.FILE))).contains("A1").contains("\"key\":\"" + TabOrder.key("https://example.com/new") + "\""));
    }

    // ---- downloads (LS-31)

    @Test
    void eachConnectionAsksForDownloadEventsAndLeavesWhereFilesGoToTheDesk() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        tabs(client);
        assertThat(cdp.commands("Browser.setDownloadBehavior")).singleElement().satisfies(command -> {
            assertThat(command.sessionId()).isNull();
            assertThat(command.params()).containsOnly(Map.entry("behavior", "default"), Map.entry("eventsEnabled", true));
        });
    }

    @Test
    void aDownloadReachesSubscribersFromStartToEnd() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "A");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a");
        tabs(client);
        assertThat(client.subscribe(BrowserDownloads.TOPIC, null)).containsEntry("_kind", "RES");
        assertThat(nextDownloads(client)).isEmpty();

        cdp.event("Browser.downloadWillBegin",
                Map.of("frameId", "a", "guid", GUID, "url", "https://example.com/report", "suggestedFilename", "report.pdf"), null);
        assertThat(nextDownloads(client)).singleElement().satisfies(d ->
                assertThat(d).containsEntry("name", "report.pdf").containsEntry("state", "inProgress"));
        cdp.event("Browser.downloadProgress",
                Map.of("guid", GUID, "state", "completed", "receivedBytes", 4096, "totalBytes", 4096,
                        "filePath", "/data/browser/downloads/report.pdf"), null);
        assertThat(nextDownloads(client)).singleElement().satisfies(d -> assertThat(d)
                .containsEntry("state", "completed")
                .containsEntry("receivedBytes", 4096)
                .doesNotContainKey("filesPath"));
    }

    @Test
    void aTokenWithoutVideoCantHearOfDownloads() throws Exception {
        cdp = new FakeCdp();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        TestClient client = rig.connect("cs-a", false, true);
        Map<String, Object> reply = client.subscribe(BrowserDownloads.TOPIC, null);
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
    }
}
