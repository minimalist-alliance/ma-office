package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/** The real-Chromium ITs' recorder finds what it's there to find, so an empty finding there means something. */
class CdpRecorderTest {

    @Test
    void aStorageOrCookieOrHistoryWriterOnAnyPathIsFoundAndAReadIsNot() {
        try (CdpRecorder recorder = CdpRecorder.start()) {
            recorder.sent(null, "Storage.getCookies", Map.of(), false);
            recorder.sent(null, "Emulation.clearDeviceMetricsOverride", Map.of(), false);
            recorder.sent("s-1", "Page.removeScriptToEvaluateOnNewDocument", Map.of(), false);
            assertThat(recorder.broken()).isEmpty();
            for (String writer : new String[] {"Network.clearBrowserCookies", "Storage.clearDataForOrigin", "Network.setCookie",
                    "DOMStorage.removeDOMStorageItem", "IndexedDB.deleteDatabase", "CacheStorage.deleteCache",
                    "Page.resetNavigationHistory", "Browser.resetPermissions", "Network.enable", "Storage.setCookies"}) {
                recorder.sent(null, writer, Map.of(), false);
                assertThat(String.join("\n", recorder.broken())).as(writer).contains(writer);
            }
        }
    }

    @Test
    void anAgentCommandOffTheListAndAnyOtherNamingTheAgentsIdsAreFound() {
        try (CdpRecorder recorder = CdpRecorder.start()) {
            recorder.sent(null, "Target.createTarget", Map.of("browserContextId", "ctx-a", "hidden", true), true);
            recorder.sent(null, "Target.attachToTarget", Map.of("targetId", "t-a"), true);
            recorder.sent("s-a", "Page.enable", Map.of(), true);
            recorder.sent("s-m", "Page.navigate", Map.of("url", "about:blank"), false);
            recorder.sent(null, "Target.getTargets", Map.of(), false);
            assertThat(recorder.broken()).isEmpty();

            recorder.sent("s-a", "Input.dispatchMouseEvent", Map.of(), true);
            recorder.sent("s-a", "Runtime.evaluate", Map.of(), false);
            recorder.sent(null, "Target.closeTarget", Map.of("targetId", "t-a"), false);
            recorder.sent(null, "Target.disposeBrowserContext", Map.of("browserContextId", "ctx-a"), false);
            recorder.sent(null, "Target.detachFromTarget", Map.of("sessionId", "s-a"), false);
            assertThat(recorder.broken()).containsExactlyInAnyOrder(
                    "an agent command off the list: Input.dispatchMouseEvent",
                    "past the allow-list, to an agent session: Runtime.evaluate",
                    "past the allow-list, naming an agent target: Target.closeTarget",
                    "past the allow-list, naming an agent context: Target.disposeBrowserContext",
                    "past the allow-list, to an agent session: Target.detachFromTarget");
        }
    }

    @Test
    void anAddressInTheAgentsLogIsFoundAndASiteAloneIsNot() {
        try (CdpRecorder recorder = CdpRecorder.start()) {
            LoggerFactory.getLogger(AgentBrowsing.class).info("agent browser: a site of the member's session granted for a run");
            assertThat(recorder.broken()).isEmpty();
            LoggerFactory.getLogger(AgentBrowsing.class).debug("agent browser: went to {}", "https://shop.example/cart?id=4");
            assertThat(recorder.broken()).singleElement().asString().contains("an address in the log");
        }
    }

    @Test
    void theTapIsOffOnceItsClosed() {
        CdpRecorder recorder = CdpRecorder.start();
        assertThat(CdpClient.tap).isSameAs(recorder);
        recorder.close();
        assertThat(CdpClient.tap).isNull();
    }
}
