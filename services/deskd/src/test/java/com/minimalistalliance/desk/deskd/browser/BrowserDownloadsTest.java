package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** What the list of downloads holds, from Chromium's events (LS-31). The topic's events are in BrowserTabsTest. */
class BrowserDownloadsTest {

    private final BrowserDownloads downloads = new BrowserDownloads(new EventHub(new TopicRegistry()), System::nanoTime);

    private static final String ID = "0f6c3b7e-8a2d-4c1e-9b5a-2d7e8f9a0b1c";

    private void begin(String id, String name) {
        Map<String, Object> params = new HashMap<>(Map.of("frameId", "F", "url", "https://example.com/r", "suggestedFilename", name));
        params.put("guid", id);
        downloads.onEvent("Browser.downloadWillBegin", params);
    }

    private void progress(String id, String state, long received, long total, String filePath) {
        Map<String, Object> params = new HashMap<>(Map.of("guid", id, "state", state, "receivedBytes", received, "totalBytes", total));
        if (filePath != null) {
            params.put("filePath", filePath);
        }
        downloads.onEvent("Browser.downloadProgress", params);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> list() {
        return (List<Map<String, Object>>) ((Map<String, Object>) downloads.snapshot(BrowserDownloads.TOPIC, Map.of())).get("downloads");
    }

    @Test
    void aDownloadStartsGoesOnAndFinishesWithNoAddressKept() {
        begin(ID, "report.pdf");
        assertThat(list()).containsExactly(Map.of("id", ID, "name", "report.pdf", "state", "inProgress", "receivedBytes", 0L, "totalBytes", 0L));
        progress(ID, "inProgress", 512, 2048, null);
        assertThat(list().get(0)).containsEntry("receivedBytes", 512L).containsEntry("totalBytes", 2048L);
        progress(ID, "completed", 2048, 2048, "/data/browser/downloads/report (1).pdf");
        assertThat(list()).containsExactly(Map.of("id", ID, "name", "report (1).pdf", "state", "completed", "receivedBytes", 2048L, "totalBytes", 2048L));
        assertThat(list().toString()).doesNotContain("example.com", "/data/");
    }

    @Test
    void onlyAFileInTheFilesTreeSaysWhereItIsThere() {
        begin(ID, "a.zip");
        progress(ID, "completed", 1, 1, "/data/files/Downloads/a.zip");
        assertThat(list().get(0)).containsEntry("filesPath", "Downloads/a.zip");
        String other = "1f6c3b7e-8a2d-4c1e-9b5a-2d7e8f9a0b1c";
        begin(other, "b.zip");
        progress(other, "completed", 1, 1, "/data/files/../browser/downloads/b.zip");
        assertThat(list().get(0)).containsEntry("name", "b.zip").doesNotContainKey("filesPath");
    }

    @Test
    void aCanceledDownloadSaysSoAndHearsNothingMore() {
        begin(ID, "big.iso");
        progress(ID, "canceled", 10, 100, null);
        progress(ID, "completed", 100, 100, null);
        assertThat(list().get(0)).containsEntry("state", "canceled").containsEntry("receivedBytes", 10L);
    }

    @Test
    void theNewestComeFirstAndOnlyFiveAreKept() {
        for (int i = 0; i < 7; i++) {
            begin("00000000-0000-0000-0000-00000000000" + i, "f" + i);
        }
        assertThat(list()).extracting(d -> d.get("name")).containsExactly("f6", "f5", "f4", "f3", "f2");
    }

    @Test
    void aNameIsCleanedAsATitleIsAndNeverEmpty() {
        begin(ID, "a‮txt.exe\n" + "x".repeat(300));
        String name = (String) list().get(0).get("name");
        assertThat(name).doesNotContain("‮", "\n").hasSizeLessThanOrEqualTo(BrowserDownloads.NAME_CHARS);
        begin("1f6c3b7e-8a2d-4c1e-9b5a-2d7e8f9a0b1c", "");
        assertThat(list().get(0)).containsEntry("name", "download");
    }

    @Test
    void whatIsntChromiumsIsDropped() {
        begin("not a guid", "x");
        begin(null, "x");
        progress("2f6c3b7e-8a2d-4c1e-9b5a-2d7e8f9a0b1c", "completed", 1, 1, null);
        downloads.onEvent("Browser.downloadProgress", Map.of("guid", ID, "receivedBytes", "lots"));
        assertThat(list()).isEmpty();
    }

    @Test
    void aLostConnectionDropsWhatsUnderWayAndKeepsWhatsDone() {
        begin(ID, "done.pdf");
        progress(ID, "completed", 1, 1, null);
        begin("1f6c3b7e-8a2d-4c1e-9b5a-2d7e8f9a0b1c", "going.pdf");
        downloads.connectionLost();
        assertThat(list()).extracting(d -> d.get("name")).containsExactly("done.pdf");
    }
}
