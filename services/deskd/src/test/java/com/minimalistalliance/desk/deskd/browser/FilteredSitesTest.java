package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import ch.qos.logback.classic.Level;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.FakeDoh;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * A teen's filtered site gets our page in place of Chromium's, through the Browser module as it's wired: a fake debugging
 * port that commits Chromium's error page as Chrome 156 does, and a fake of the family resolver behind the real
 * {@link FamilyDns}.
 */
@ExtendWith(OutputCaptureExtension.class)
class FilteredSitesTest {

    private static final String FILTERED = "https://filtered-site.example/page?q=1";
    private static final String FILTERED_HOST = "filtered-site.example";
    private static final String OPEN = "https://down-site.example/";
    private static final String OPEN_HOST = "down-site.example";
    private static final String REFUSED = "ERR_CONNECTION_REFUSED";
    /** How long "nothing happens" is watched for. The fakes answer in a few ms. */
    private static final Duration QUIET = Duration.ofMillis(400);

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private FakeDoh doh;
    private PlatformHttp dohHttp;
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
        if (doh != null) {
            doh.close();
        }
        if (dohHttp != null) {
            dohHttp.close();
        }
    }

    /** @param band the line in the band's file, or null for a module that was never told one */
    private void start(String band, Duration dohTimeout, String... pages) throws Exception {
        cdp = new FakeCdp();
        for (String page : pages) {
            cdp.addPage(page, "https://example.com/" + page, "Title " + page);
        }
        startRig(band, dohTimeout);
    }

    private void startRig(String band, Duration dohTimeout) throws Exception {
        doh = new FakeDoh();
        doh.filter(FILTERED_HOST);
        doh.allow(OPEN_HOST);
        dohHttp = new PlatformHttp();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, new FamilyDns(dohHttp, doh.endpoint(), dohTimeout));
        if (band != null) {
            Path file = dir.resolve(AgeBand.FILE);
            Files.writeString(file, band);
            rig.module.followAgeBand(new AgeBand(file));
        }
        client = rig.connect("cs-a");
        // A call keeps the connection wanted, and the tabs attached, for the rest of the test.
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");
        for (String id : cdp.commands("Target.attachToTarget").stream().map(c -> (String) c.params().get("targetId")).toList()) {
            await().until(() -> cdp.commands("Page.getNavigationHistory").stream().anyMatch(c -> FakeCdp.sessionOf(id).equals(c.sessionId())));
        }
    }

    private FilteredSites.Counts counts() {
        return rig.module.filteredCounts();
    }

    /** The two scripts deskd runs on an error page, and never on any other. */
    private List<FakeCdp.Command> errorPageScripts() {
        return cdp.commands("Runtime.evaluate").stream()
                .filter(c -> {
                    String expression = String.valueOf(c.params().get("expression"));
                    return expression.contains(".error-code") || expression.contains("document.write(");
                })
                .toList();
    }

    private void awaitFinished(long checks) {
        await().atMost(Duration.ofSeconds(10)).until(() -> counts().finished() >= checks);
    }

    private static void assertOurPage(String written) {
        assertThat(written)
                .contains(FilteredPage.TITLE)
                .contains("Your Browser uses a family filter until you're 18.")
                .contains("onclick=\\\"history.back()\\\"")
                .doesNotContain("Minimalist")
                .doesNotContain("Alliance");
    }

    @Test
    void aTeensRefusedFilteredSiteGetsOurPage() throws Exception {
        start("teen\n", Duration.ofSeconds(5), "a");
        cdp.navigateFails(FILTERED, REFUSED);

        Map<String, Object> reply = rig.call(client, "browser.tab.navigate", Map.of("url", FILTERED, "tabId", "a"));

        assertThat(reply).containsEntry("_kind", "RES").containsEntry("netError", "net::" + REFUSED);
        await().atMost(Duration.ofSeconds(10)).until(() -> cdp.written("a") != null);
        assertOurPage(cdp.written("a"));
        assertThat(doh.questions()).singleElement().satisfies(question -> {
            assertThat(question.name()).isEqualTo(FILTERED_HOST);
            assertThat(question.type()).isEqualTo(FakeDoh.A);
        });
        // The fake writes the page before deskd has read its answer.
        awaitFinished(1);
        assertThat(counts()).isEqualTo(new FilteredSites.Counts(1, 1, 0, 0, 1));
    }

    @Test
    void aLinkToAFilteredSiteInATeensTabGetsOurPageToo() throws Exception {
        start("teen\n", Duration.ofSeconds(5), "a", "b");

        cdp.failNavigation("b", FILTERED, REFUSED);

        await().atMost(Duration.ofSeconds(10)).until(() -> cdp.written("b") != null);
        assertOurPage(cdp.written("b"));
        assertThat(cdp.written("a")).isNull();
    }

    @Test
    void aTeensRefusedSiteThatIsntFilteredKeepsChromiumsPage() throws Exception {
        start("teen\n", Duration.ofSeconds(5), "a");

        cdp.failNavigation("a", OPEN, REFUSED);

        awaitFinished(1);
        assertThat(doh.questions()).extracting(FakeDoh.Question::name).containsExactly(OPEN_HOST);
        assertThat(cdp.written("a")).isNull();
        assertThat(counts()).isEqualTo(new FilteredSites.Counts(1, 0, 0, 0, 1));
    }

    @Test
    void anAdultsDeskNeverLooks() throws Exception {
        start("adult\n", Duration.ofSeconds(5), "a");
        cdp.clearCommands();

        cdp.failNavigation("a", FILTERED, REFUSED);
        cdp.navigateFails(OPEN, REFUSED);
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", OPEN, "tabId", "a"))).containsEntry("_kind", "RES");

        await().during(QUIET).atMost(QUIET.plusSeconds(5)).until(() -> doh.questions().isEmpty());
        assertThat(errorPageScripts()).isEmpty();
        assertThat(cdp.commands("Page.getFrameTree")).isEmpty();
        assertThat(cdp.written("a")).isNull();
        assertThat(counts()).isEqualTo(new FilteredSites.Counts(0, 0, 0, 0, 0));
    }

    @Test
    void aDeskThatHasNoBandYetNeverLooks() throws Exception {
        start(null, Duration.ofSeconds(5), "a");

        cdp.failNavigation("a", FILTERED, REFUSED);

        await().during(QUIET).atMost(QUIET.plusSeconds(5)).until(() -> doh.questions().isEmpty());
        assertThat(errorPageScripts()).isEmpty();
        assertThat(cdp.commands("Page.getFrameTree")).isEmpty();
        assertThat(cdp.written("a")).isNull();
    }

    @Test
    void aLookupThatTimesOutKeepsChromiumsPageAndHoldsNothingUp(CapturedOutput output) throws Exception {
        start("teen\n", Duration.ofSeconds(3), "a", "b");
        doh.hold();

        cdp.failNavigation("a", FILTERED, REFUSED);
        await().atMost(Duration.ofSeconds(5)).until(() -> doh.questions().size() == 1);

        // While it waits, everything else goes on as ever: a navigation in another tab, and in this one.
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/next", "tabId", "b")))
                .containsEntry("_kind", "RES")
                .doesNotContainKey("netError");
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");
        assertThat(counts().finished()).as("the lookup was still out").isZero();

        awaitFinished(1);
        assertThat(cdp.written("a")).isNull();
        assertThat(counts()).isEqualTo(new FilteredSites.Counts(1, 0, 1, 0, 1));
        assertThat(output.getAll()).contains("teen filter can't reach the family resolver, so Chromium's own pages stay: HttpTimeoutException");
    }

    @Test
    void aResolverThatFailsKeepsChromiumsPage() throws Exception {
        start("teen\n", Duration.ofSeconds(5), "a");
        doh.status(502);

        cdp.failNavigation("a", FILTERED, REFUSED);

        awaitFinished(1);
        assertThat(cdp.written("a")).isNull();
        assertThat(counts().failed()).isEqualTo(1);
    }

    @Test
    void aSubframeNeverLooks() throws Exception {
        start("teen\n", Duration.ofSeconds(5), "a");
        cdp.clearCommands();

        cdp.failSubframe("a", FILTERED, REFUSED);

        await().during(QUIET).atMost(QUIET.plusSeconds(5)).until(() -> doh.questions().isEmpty());
        assertThat(errorPageScripts()).isEmpty();
        assertThat(cdp.written("a")).isNull();
    }

    @Test
    void otherErrorsNeverAskTheResolver() throws Exception {
        start("teen\n", Duration.ofSeconds(5), "a");
        List<String> others = List.of(
                "ERR_NAME_NOT_RESOLVED", "ERR_BLOCKED_BY_ADMINISTRATOR", "ERR_BLOCKED_BY_CLIENT", "ERR_CERT_AUTHORITY_INVALID", "");
        for (int i = 0; i < others.size(); i++) {
            cdp.failNavigation("a", FILTERED, others.get(i));
            awaitFinished(i + 1);
        }

        assertThat(doh.questions()).isEmpty();
        assertThat(cdp.written("a")).isNull();
        assertThat(counts().lookups()).isZero();
    }

    @Test
    void namesChromiumDoesntAskTheResolverAboutAreNeverAsked() throws Exception {
        start("teen\n", Duration.ofSeconds(5), "a");
        cdp.clearCommands();

        for (String url : List.of("https://127.0.0.1/", "http://localhost:8080/", "http://printer.local/", "https://intranet/")) {
            cdp.failNavigation("a", url, REFUSED);
        }

        await().during(QUIET).atMost(QUIET.plusSeconds(5)).until(() -> doh.questions().isEmpty());
        assertThat(errorPageScripts()).isEmpty();
    }

    @Test
    void aTabThatMovesOnDuringTheLookupIsNeverWrittenOver() throws Exception {
        start("teen\n", Duration.ofSeconds(5), "a");
        doh.hold();

        cdp.failNavigation("a", FILTERED, REFUSED);
        await().atMost(Duration.ofSeconds(5)).until(() -> doh.questions().size() == 1);
        // A second failed page, which Chromium's own page is right for, and then the answer about the first.
        cdp.failNavigation("a", OPEN, "ERR_NAME_NOT_RESOLVED");
        doh.release();

        awaitFinished(2);
        assertThat(cdp.written("a")).isNull();
        assertThat(counts().shown()).isZero();
    }

    @Test
    void ourPageIsntLookedAtAgainOnANewConnection() throws Exception {
        start("teen\n", Duration.ofSeconds(5), "a");
        cdp.failNavigation("a", FILTERED, REFUSED);
        awaitFinished(1);
        assertThat(cdp.written("a")).isNotNull();
        long checks = counts().finished();

        // The frame still says it failed, as Chromium's does once written over, and our page has no error code.
        cdp.dropConnections();
        await().atMost(Duration.ofSeconds(10)).until(() -> "RES".equals(rig.call(client, "browser.tab.list", Map.of(), null).get("_kind")));
        awaitFinished(checks + 1);

        await().during(QUIET).atMost(QUIET.plusSeconds(5)).until(() -> doh.questions().size() == 1);
        assertThat(counts().shown()).isEqualTo(1);
    }

    @Test
    void aTabAlreadyOnAFilteredSiteWhenDeskdAttachesGetsOurPage() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "Title a");
        // Before any connection, so no event tells of it: as a restored tab, or one opened straight onto the site.
        cdp.failNavigation("a", FILTERED, REFUSED);

        startRig("teen\n", Duration.ofSeconds(5));

        await().atMost(Duration.ofSeconds(10)).until(() -> cdp.written("a") != null);
        assertOurPage(cdp.written("a"));
    }

    @Test
    void lookupsAtOnceAreBounded() throws Exception {
        String[] pages = {"a", "b", "c", "d", "e", "f"};
        start("teen\n", Duration.ofSeconds(10), pages);
        doh.hold();

        for (int i = 0; i < FilteredSites.MAX_LOOKUPS; i++) {
            cdp.failNavigation(pages[i], FILTERED, REFUSED);
        }
        await().atMost(Duration.ofSeconds(5)).until(() -> doh.questions().size() == FilteredSites.MAX_LOOKUPS);
        cdp.failNavigation(pages[FilteredSites.MAX_LOOKUPS], FILTERED, REFUSED);
        await().atMost(Duration.ofSeconds(5)).until(() -> counts().busy() == 1);
        doh.release();

        awaitFinished(FilteredSites.MAX_LOOKUPS);
        assertThat(doh.questions()).hasSize(FilteredSites.MAX_LOOKUPS);
        for (int i = 0; i < FilteredSites.MAX_LOOKUPS; i++) {
            assertThat(cdp.written(pages[i])).as(pages[i]).isNotNull();
        }
        assertThat(cdp.written(pages[FilteredSites.MAX_LOOKUPS])).isNull();

        // Room again once they're done.
        cdp.failNavigation(pages[FilteredSites.MAX_LOOKUPS + 1], FILTERED, REFUSED);
        await().atMost(Duration.ofSeconds(10)).until(() -> cdp.written(pages[FilteredSites.MAX_LOOKUPS + 1]) != null);
    }

    @Test
    void noHostOrUrlReachesTheLogAtAnyLevel(CapturedOutput output) throws Exception {
        ch.qos.logback.classic.Logger deskd = (ch.qos.logback.classic.Logger) LoggerFactory.getLogger("com.minimalistalliance.desk.deskd");
        Level before = deskd.getLevel();
        deskd.setLevel(Level.DEBUG);
        try {
            start("teen\n", Duration.ofMillis(300), "a", "b", "c", "d");
            cdp.navigateFails(FILTERED, REFUSED);
            assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", FILTERED, "tabId", "a"))).containsEntry("_kind", "RES");
            await().atMost(Duration.ofSeconds(10)).until(() -> cdp.written("a") != null);
            cdp.failNavigation("b", OPEN, REFUSED);
            awaitFinished(2);
            doh.status(500);
            cdp.failNavigation("c", "https://failing-site.example/x", REFUSED);
            awaitFinished(3);
            doh.status(200);
            doh.hold();
            cdp.failNavigation("d", "https://slow-site.example/y", REFUSED);
            awaitFinished(4);
        } finally {
            deskd.setLevel(before);
        }
        assertThat(output.getAll()).contains("teen filter").doesNotContain("filtered-site").doesNotContain("down-site")
                .doesNotContain("failing-site").doesNotContain("slow-site").doesNotContain("page?q");
    }
}
