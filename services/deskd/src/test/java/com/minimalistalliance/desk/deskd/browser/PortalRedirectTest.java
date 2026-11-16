package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import ch.qos.logback.classic.Level;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.FakeDoh;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
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
 * The office in the Browser lands on the portal, through the Browser module as it's wired: a fake debugging port that commits
 * Chromium's error page as Chrome 156 does, the policy's blocked page included, and a page's {@code location.replace} in place of
 * the current entry. What real Chromium does is {@link PortalRedirectChromiumIT}'s.
 */
@ExtendWith(OutputCaptureExtension.class)
class PortalRedirectTest {

    private static final String OFFICE = "https://office.minimalistalliance.com/some/path?q=1";
    private static final String PORTAL = "https://portal.minimalistalliance.com/";
    private static final String STAGING_PORTAL = "https://portal.staging.minimalistalliance.com/";
    private static final String BLOCKED = "ERR_BLOCKED_BY_ADMINISTRATOR";
    /** A rig whose module was never told where the portal is. */
    private static final String NEVER = "never told";
    /** How long "nothing happens" is watched for. The fake answers in a few ms. */
    private static final Duration QUIET = Duration.ofMillis(400);

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private BrowserRig rig;
    private TestClient client;
    private FakeDoh doh;
    private PlatformHttp dohHttp;

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

    /** @param setting DESKD_PORTAL_URL, or {@link #NEVER} for a module never told */
    private void start(String setting, String env, String... pages) throws Exception {
        cdp = new FakeCdp();
        for (String page : pages) {
            cdp.addPage(page, "https://example.com/" + page, "Title " + page);
        }
        startRig(setting, env);
    }

    private void startRig(String setting, String env) throws Exception {
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        if (!NEVER.equals(setting)) {
            rig.module.redirectOfficeTo(setting, () -> env);
        }
        connect();
    }

    private void connect() throws Exception {
        client = rig.connect("cs-a");
        // A call keeps the connection wanted, and the tabs attached, for the rest of the test.
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null)).containsEntry("_kind", "RES");
        for (String id : cdp.commands("Target.attachToTarget").stream().map(c -> (String) c.params().get("targetId")).toList()) {
            await().until(() -> cdp.commands("Page.getNavigationHistory").stream().anyMatch(c -> FakeCdp.sessionOf(id).equals(c.sessionId())));
        }
    }

    private PortalRedirect.Counts counts() {
        return rig.module.portalCounts();
    }

    /** The replaces deskd sent. */
    private List<FakeCdp.Command> leaves() {
        return cdp.commands("Runtime.evaluate").stream()
                .filter(c -> String.valueOf(c.params().get("expression")).contains("location.replace("))
                .toList();
    }

    /** Every script deskd ran on an error page. */
    private List<FakeCdp.Command> errorPageScripts() {
        return cdp.commands("Runtime.evaluate").stream()
                .filter(c -> {
                    String expression = String.valueOf(c.params().get("expression"));
                    return expression.contains(".error-code") || expression.contains("location.replace(") || expression.contains("document.write(");
                })
                .toList();
    }

    private void awaitFinished(long checks) {
        await().atMost(Duration.ofSeconds(10)).until(() -> counts().finished() >= checks);
    }

    private void assertQuiet() {
        await().during(QUIET).atMost(QUIET.plusSeconds(5)).until(() -> errorPageScripts().isEmpty());
    }

    @SuppressWarnings("unchecked")
    private String urlOf(String tabId) throws Exception {
        List<Map<String, Object>> tabs = (List<Map<String, Object>>) rig.call(client, "browser.tab.list", Map.of(), null).get("tabs");
        return tabs.stream().filter(t -> tabId.equals(t.get("tabId"))).map(t -> (String) t.get("url")).findFirst().orElseThrow();
    }

    @Test
    void aLinkToTheOfficeLandsOnThePortalInPlaceOfTheBlockedPage() throws Exception {
        start(null, "prod", "a");

        cdp.failNavigation("a", OFFICE, BLOCKED);

        await().atMost(Duration.ofSeconds(10)).until(() -> PORTAL.equals(urlOf("a")));
        // In place of the office's entry: Back goes to the page before.
        assertThat(cdp.history("a")).containsExactly("https://example.com/a", PORTAL);
        assertThat(leaves()).singleElement().satisfies(leave -> {
            String expression = String.valueOf(leave.params().get("expression"));
            assertThat(expression).contains("location.replace(\"" + PORTAL + "\")").contains("chrome-error://chromewebdata/")
                    .contains(".icon-info");
            // In deskd's isolated world, made in that very document.
            assertThat(leave.params().get("contextId")).isNotNull();
        });
        awaitFinished(1);
        assertThat(counts()).isEqualTo(new PortalRedirect.Counts(1, 0, 0, 0, 1));
    }

    @Test
    void everyOfficeHostAndNameUnderItGoes() throws Exception {
        List<String> urls = List.of(
                "https://office.minimalistalliance.com/",
                "https://desk.minimalistalliance.com/x",
                "https://office.staging.minimalistalliance.com/",
                "https://desk.staging.minimalistalliance.com/y?z",
                "https://a.b.office.minimalistalliance.com/",
                "http://office.minimalistalliance.com:8443/x");
        String[] pages = {"p0", "p1", "p2", "p3", "p4", "p5"};
        start(null, "prod", pages);

        for (int i = 0; i < urls.size(); i++) {
            // One at a time: more than MAX_REDIRECTS at once would leave some as they are.
            cdp.failNavigation(pages[i], urls.get(i), BLOCKED);
            long sent = i + 1;
            await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == sent);
        }

        for (String page : pages) {
            assertThat(cdp.history(page)).as(page).containsExactly("https://example.com/" + page, PORTAL);
        }
    }

    @Test
    void apiAuthGwAndLookalikesStayBlocked() throws Exception {
        List<String> urls = List.of(
                "https://api.minimalistalliance.com/v1/x",
                "https://auth.minimalistalliance.com/",
                "https://gw.minimalistalliance.com/",
                "https://office.minimalistalliance.com.example.com/",
                "https://xoffice.minimalistalliance.com/",
                "https://office.minimalistalliance.co/",
                "https://office.minimalistalliance.com@example.com/");
        start(null, "prod", "a");
        cdp.clearCommands();

        for (String url : urls) {
            cdp.failNavigation("a", url, BLOCKED);
        }

        assertQuiet();
        assertThat(cdp.history("a")).doesNotContain(PORTAL);
        assertThat(counts()).isEqualTo(new PortalRedirect.Counts(0, 0, 0, 0, 0));
    }

    @Test
    void onlyThePolicysBlockGoes() throws Exception {
        start(null, "prod", "a");
        List<String> others = List.of("ERR_CONNECTION_REFUSED", "ERR_NAME_NOT_RESOLVED", "ERR_BLOCKED_BY_CLIENT", "");

        for (int i = 0; i < others.size(); i++) {
            cdp.failNavigation("a", OFFICE, others.get(i));
            awaitFinished(i + 1);
        }

        assertThat(leaves()).isEmpty();
        assertThat(cdp.history("a")).doesNotContain(PORTAL);
        assertThat(counts().redirected()).isZero();
    }

    @Test
    void aSubframeNeverGoes() throws Exception {
        start(null, "prod", "a");
        cdp.clearCommands();

        cdp.failSubframe("a", OFFICE, BLOCKED);

        assertQuiet();
        assertThat(counts().finished()).isZero();
    }

    /** The reads of an error page's code deskd made. */
    private List<FakeCdp.Command> codeReads() {
        return cdp.commands("Runtime.evaluate").stream()
                .filter(c -> {
                    String expression = String.valueOf(c.params().get("expression"));
                    return expression.contains(".error-code") && !expression.contains("location.replace(");
                })
                .toList();
    }

    @Test
    void eachCommitIsLookedAtOnce() throws Exception {
        start(null, "prod", "a");
        cdp.clearCommands();
        cdp.hold("Page.createIsolatedWorld");

        cdp.failNavigation("a", OFFICE, BLOCKED);
        // The same commit told of again, while the first look is still out.
        cdp.repeatCommit("a");
        cdp.repeatCommit("a");
        await().atMost(Duration.ofSeconds(5)).until(() -> !cdp.commands("Page.createIsolatedWorld").isEmpty());
        Thread.sleep(QUIET.toMillis());
        cdp.answerHeld("Page.createIsolatedWorld");

        await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == 1);
        await().during(QUIET).atMost(QUIET.plusSeconds(5)).until(() -> codeReads().size() == 1);
        assertThat(leaves()).hasSize(1);
        assertThat(counts().finished()).isEqualTo(1);
    }

    @Test
    void backFromThePortalGoesToThePageBeforeAndNothingSendsItForwardAgain() throws Exception {
        start(null, "prod", "a");
        cdp.failNavigation("a", OFFICE, BLOCKED);
        await().atMost(Duration.ofSeconds(10)).until(() -> PORTAL.equals(urlOf("a")));

        assertThat(rig.call(client, "browser.tab.back", Map.of("tabId", "a"))).containsEntry("_kind", "RES");

        await().atMost(Duration.ofSeconds(10)).until(() -> "https://example.com/a".equals(urlOf("a")));
        await().during(QUIET).atMost(QUIET.plusSeconds(5)).until(() -> leaves().size() == 1);
        assertThat(cdp.history("a")).doesNotContain(OFFICE);
        // And forward again is the portal, never the office.
        assertThat(rig.call(client, "browser.tab.forward", Map.of("tabId", "a"))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).until(() -> PORTAL.equals(urlOf("a")));
        assertThat(leaves()).hasSize(1);
    }

    @Test
    void aPortalThatSendsTheTabBackToTheOfficeIsNeverALoop() throws Exception {
        start(null, "prod", "a");
        // As a portal that answered with a redirect to the office would: the replace ends on the blocked page again.
        cdp.replaceLandsOn(PORTAL, OFFICE, BLOCKED);

        cdp.failNavigation("a", OFFICE, BLOCKED);

        await().atMost(Duration.ofSeconds(10)).until(() -> counts().held() == 1);
        await().during(QUIET).atMost(QUIET.plusSeconds(5)).until(() -> leaves().size() == 1);
        assertThat(counts()).isEqualTo(new PortalRedirect.Counts(1, 0, 1, 0, 1));
    }

    @Test
    void aBlockedPageRightAfterThePortalsOwnPageStaysAndAnyOtherPageInBetweenClearsThat() throws Exception {
        start(null, "prod", "a");
        cdp.failNavigation("a", OFFICE, BLOCKED);
        await().atMost(Duration.ofSeconds(10)).until(() -> PORTAL.equals(urlOf("a")));

        // As the portal's own page navigating to the office would.
        cdp.failNavigation("a", "https://desk.minimalistalliance.com/", BLOCKED);
        await().atMost(Duration.ofSeconds(10)).until(() -> counts().held() == 1);
        assertThat(leaves()).hasSize(1);

        cdp.navigateInPage("a", "https://example.com/b", "b");
        cdp.failNavigation("a", OFFICE, BLOCKED);
        await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == 2);
    }

    @Test
    void switchedOffItsChromiumsPageAndDeskdsOwnNavigationIsBlockedAsBefore() throws Exception {
        start("off", "prod", "a");
        cdp.clearCommands();

        cdp.failNavigation("a", OFFICE, BLOCKED);
        assertQuiet();
        cdp.navigateFails(OFFICE, BLOCKED);
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", OFFICE, "tabId", "a")))
                .containsEntry("_kind", "ERR").containsEntry("code", "forbidden").containsEntry("details", Map.of("reason", "blocked"));
        assertThat(cdp.commands("Page.navigate")).singleElement().satisfies(c -> assertThat(c.params()).containsEntry("url", OFFICE));
        assertThat(rig.call(client, "browser.tab.open", Map.of("url", OFFICE))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Target.createTarget")).singleElement().satisfies(c -> assertThat(c.params()).containsEntry("url", OFFICE));

        assertThat(errorPageScripts()).isEmpty();
        assertThat(cdp.commands("Page.getFrameTree")).as("nothing looks at a tab as it's attached").isEmpty();
        assertThat(counts()).isEqualTo(new PortalRedirect.Counts(0, 0, 0, 0, 0));
    }

    @Test
    void aModuleNeverToldIsOff() throws Exception {
        assertOff(NEVER, "prod");
    }

    @Test
    void aDeskBeforeImdsHasSaidIsOff() throws Exception {
        assertOff(null, null);
    }

    @Test
    void aDeskWithAnotherEnvIsOff() throws Exception {
        assertOff(null, "dev");
    }

    private void assertOff(String setting, String env) throws Exception {
        start(setting, env, "a");
        cdp.clearCommands();

        cdp.failNavigation("a", OFFICE, BLOCKED);

        assertQuiet();
        assertThat(counts()).isEqualTo(new PortalRedirect.Counts(0, 0, 0, 0, 0));
        assertThat(rig.call(client, "browser.tab.open", Map.of("url", OFFICE))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Target.createTarget")).singleElement().satisfies(c -> assertThat(c.params()).containsEntry("url", OFFICE));
    }

    @Test
    void aStagingDeskGoesToStagingsPortalWhicheverOfficeItWas() throws Exception {
        start(null, "staging", "a", "b");

        cdp.failNavigation("a", "https://office.staging.minimalistalliance.com/", BLOCKED);
        cdp.failNavigation("b", "https://desk.minimalistalliance.com/", BLOCKED);

        await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == 2);
        assertThat(cdp.history("a")).last().isEqualTo(STAGING_PORTAL);
        assertThat(cdp.history("b")).last().isEqualTo(STAGING_PORTAL);
    }

    @Test
    void aSettingsUrlIsWhereItGoes() throws Exception {
        start("http://127.0.0.1:9/stand-in/", "prod", "a");

        cdp.failNavigation("a", OFFICE, BLOCKED);

        await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == 1);
        assertThat(cdp.history("a")).last().isEqualTo("http://127.0.0.1:9/stand-in/");
    }

    @Test
    void deskdsOwnNavigationAndNewTabsGoStraightThere() throws Exception {
        start(null, "prod", "a");

        Map<String, Object> typed = rig.call(client, "browser.tab.navigate", Map.of("url", OFFICE, "tabId", "a"));
        assertThat(typed).containsEntry("_kind", "RES").containsEntry("tabId", "a").doesNotContainKey("netError");
        assertThat(cdp.commands("Page.navigate")).last().satisfies(c -> assertThat(c.params()).containsEntry("url", PORTAL));
        // No blocked page, and no entry for the office.
        assertThat(cdp.history("a")).containsExactly("https://example.com/a", PORTAL);

        // As a member might type it.
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "HTTPS://Desk.MinimalistAlliance.com.:443/x", "tabId", "a")))
                .containsEntry("_kind", "RES");
        assertThat(cdp.commands("Page.navigate")).last().satisfies(c -> assertThat(c.params()).containsEntry("url", PORTAL));

        assertThat(rig.call(client, "browser.tab.open", Map.of("url", "https://desk.staging.minimalistalliance.com/"))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Target.createTarget")).last().satisfies(c -> assertThat(c.params()).containsEntry("url", PORTAL));

        // api. is still the policy's, and a lookalike goes where it says.
        String api = "https://api.minimalistalliance.com/v1/";
        cdp.navigateFails(api, BLOCKED);
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", api, "tabId", "a")))
                .containsEntry("code", "forbidden").containsEntry("details", Map.of("reason", "blocked"));
        assertThat(cdp.commands("Page.navigate")).last().satisfies(c -> assertThat(c.params()).containsEntry("url", api));
        String lookalike = "https://office.minimalistalliance.com.example.com/";
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", lookalike, "tabId", "a"))).containsEntry("_kind", "RES");
        assertThat(cdp.commands("Page.navigate")).last().satisfies(c -> assertThat(c.params()).containsEntry("url", lookalike));

        assertThat(counts().direct()).isEqualTo(3);
        assertThat(leaves()).isEmpty();
    }

    @Test
    void aTypedUrlThatARedirectEndsOnTheOfficeAnswersAsOnItsWayThere() throws Exception {
        start(null, "prod", "a");
        cdp.navigateLandsOn("https://example.com/to-office", OFFICE, BLOCKED);

        Map<String, Object> reply = rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/to-office", "tabId", "a"));

        assertThat(reply).containsEntry("_kind", "RES").containsEntry("tabId", "a").doesNotContainKey("netError");
        await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == 1);
        assertThat(cdp.history("a")).containsExactly("https://example.com/a", PORTAL);
        assertThat(counts().direct()).isZero();

        // From the portal's own page too: a member's own navigation is never the portal's loop.
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/to-office", "tabId", "a")))
                .containsEntry("_kind", "RES").doesNotContainKey("netError");
        await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == 2);
        assertThat(counts().held()).isZero();

        // Switched off, the same is the policy's, as ever.
        rig.module.redirectOfficeTo("off", () -> "prod");
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://example.com/to-office", "tabId", "a")))
                .containsEntry("code", "forbidden").containsEntry("details", Map.of("reason", "blocked"));
    }

    @Test
    void aTabAlreadyOnTheBlockedOfficeWhenDeskdAttachesGoes() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "Title a");
        // Before any connection, so no event tells of it: as a tab a page opened straight onto the office.
        cdp.failNavigation("a", OFFICE, BLOCKED);

        startRig(null, "prod");

        await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == 1);
        assertThat(cdp.history("a")).containsExactly("https://example.com/a", PORTAL);
    }

    @Test
    void onATeensDeskTheOfficeGoesToThePortalAndTheFilterNeverSeesIt() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "Title a");
        cdp.addPage("b", "https://example.com/b", "Title b");
        doh = new FakeDoh();
        dohHttp = new PlatformHttp();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST, new FamilyDns(dohHttp, doh.endpoint(), Duration.ofSeconds(5)));
        Path band = dir.resolve(AgeBand.FILE);
        Files.writeString(band, "teen\n");
        rig.module.followAgeBand(new AgeBand(band), "boot-1");
        rig.module.redirectOfficeTo(null, () -> "prod");
        connect();

        cdp.failNavigation("a", OFFICE, BLOCKED);
        await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == 1);
        assertThat(rig.module.filteredCounts()).isEqualTo(new FilteredSites.Counts(0, 0, 0, 0, 0));

        // api. is the filter's to look at, which leaves the policy's page as it is.
        cdp.failNavigation("b", "https://api.minimalistalliance.com/", BLOCKED);
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.module.filteredCounts().finished() == 1);
        assertThat(rig.module.filteredCounts().lookups()).isZero();
        assertThat(doh.questions()).isEmpty();
        assertThat(cdp.written("b")).isNull();
        assertThat(leaves()).hasSize(1);
        assertThat(counts().finished()).isEqualTo(1);
    }

    @Test
    void theAgentsTabIsNeverSentAndItsToolStillSaysBlocked() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "Title a");
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        rig.module.redirectOfficeTo(null, () -> "prod");
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(2), Duration.ofMillis(800), Duration.ofSeconds(2), Duration.ofMillis(10), Duration.ofMillis(50),
                Duration.ofSeconds(3)), MinifiedSwitch.fixed(true, false, false));
        AgentBrowser agent = rig.module.enableAgentBrowsing(() -> false);
        connect();
        cdp.navigateFails(OFFICE, BLOCKED);

        assertThatThrownBy(() -> agent.open("run-1", OFFICE)).isInstanceOfSatisfying(RpcException.class, e -> {
            assertThat(e.code()).isEqualTo(RpcException.FORBIDDEN);
            assertThat(e.details()).containsEntry("reason", "blocked");
        });

        assertQuiet();
        assertThat(cdp.commands("Page.navigate")).last().satisfies(c -> assertThat(c.params()).containsEntry("url", OFFICE));
        assertThat(counts()).isEqualTo(new PortalRedirect.Counts(0, 0, 0, 0, 0));
    }

    @Test
    void redirectsAtOnceAreBounded() throws Exception {
        String[] pages = {"a", "b", "c", "d", "e", "f"};
        start(null, "prod", pages);
        cdp.hold("Page.createIsolatedWorld");
        cdp.clearCommands();

        for (int i = 0; i < PortalRedirect.MAX_REDIRECTS; i++) {
            cdp.failNavigation(pages[i], OFFICE, BLOCKED);
        }
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Page.createIsolatedWorld").size() >= PortalRedirect.MAX_REDIRECTS);
        cdp.failNavigation(pages[PortalRedirect.MAX_REDIRECTS], OFFICE, BLOCKED);
        await().atMost(Duration.ofSeconds(5)).until(() -> counts().busy() == 1);
        cdp.answerHeld("Page.createIsolatedWorld");

        await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == PortalRedirect.MAX_REDIRECTS);
        assertThat(cdp.history(pages[PortalRedirect.MAX_REDIRECTS])).doesNotContain(PORTAL);

        // Room again once they're done.
        cdp.failNavigation(pages[PortalRedirect.MAX_REDIRECTS + 1], OFFICE, BLOCKED);
        await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == PortalRedirect.MAX_REDIRECTS + 1);
    }

    @Test
    void aTabThatMovesOnBeforeTheReplaceIsNeverSent() throws Exception {
        start(null, "prod", "a");
        cdp.clearCommands();
        cdp.hold("Page.createIsolatedWorld");

        cdp.failNavigation("a", OFFICE, BLOCKED);
        await().atMost(Duration.ofSeconds(5)).until(() -> !cdp.commands("Page.createIsolatedWorld").isEmpty());
        cdp.navigateInPage("a", "https://example.com/next", "next");
        cdp.answerHeld("Page.createIsolatedWorld");

        awaitFinished(1);
        assertThat(leaves()).isEmpty();
        assertThat(cdp.history("a")).last().isEqualTo("https://example.com/next");
        assertThat(counts().redirected()).isZero();
    }

    @Test
    void noHostOrUrlReachesTheLogAtAnyLevel(CapturedOutput output) throws Exception {
        ch.qos.logback.classic.Logger deskd = (ch.qos.logback.classic.Logger) LoggerFactory.getLogger("com.minimalistalliance.desk.deskd");
        Level before = deskd.getLevel();
        deskd.setLevel(Level.DEBUG);
        try {
            start(null, "prod", "a", "b", "c");
            cdp.failNavigation("a", OFFICE, BLOCKED);
            await().atMost(Duration.ofSeconds(10)).until(() -> counts().redirected() == 1);
            cdp.failNavigation("b", "https://desk.minimalistalliance.com/secret-path", "ERR_CONNECTION_REFUSED");
            awaitFinished(2);
            assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://office.minimalistalliance.com/typed-path", "tabId", "c")))
                    .containsEntry("_kind", "RES");
        } finally {
            deskd.setLevel(before);
        }
        assertThat(output.getAll()).contains("portal").doesNotContain("minimalistalliance.com").doesNotContain("some/path")
                .doesNotContain("secret-path").doesNotContain("typed-path");
    }
}
