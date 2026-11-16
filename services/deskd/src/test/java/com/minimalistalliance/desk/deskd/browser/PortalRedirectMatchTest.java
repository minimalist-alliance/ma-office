package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

/** Which URLs are the office's, as a browser reads their host, and where the setting says the portal is. */
class PortalRedirectMatchTest {

    @Test
    void theFourOfficeHostsAndEveryNameUnderThemMatch() {
        for (String url : List.of(
                "https://office.minimalistalliance.com/",
                "https://desk.minimalistalliance.com/",
                "https://office.staging.minimalistalliance.com/",
                "https://desk.staging.minimalistalliance.com/",
                "https://a.office.minimalistalliance.com/",
                "https://x.y.desk.staging.minimalistalliance.com/path?q=1#f",
                "http://office.minimalistalliance.com/")) {
            assertThat(PortalRedirect.isOffice(url)).as(url).isTrue();
        }
    }

    @Test
    void theHostIsReadAsABrowserReadsIt() {
        for (String url : List.of(
                "HTTPS://OFFICE.MinimalistAlliance.COM/",
                "https://office.minimalistalliance.com./",
                "https://office.minimalistalliance.com:8443/x",
                "https://office.minimalistalliance.com.:443/x",
                "https://someone@office.minimalistalliance.com/",
                "https://someone:secret@desk.minimalistalliance.com/",
                // The last @ ends the userinfo.
                "https://example.com@x@office.minimalistalliance.com/",
                "https://%6Fffice.minimalistalliance.com/",
                "https://office%2Eminimalistalliance.com/",
                // Fullwidth letters, which IDNA maps to ASCII, as Chromium's UTS 46 does.
                "https://\uff4f\uff46\uff46\uff49\uff43\uff45.minimalistalliance.com/",
                "https://office.minimalistalliance.com?x",
                "https://office.minimalistalliance.com#x",
                "https://office.minimalistalliance.com\\path")) {
            assertThat(PortalRedirect.isOffice(url)).as(url).isTrue();
        }
        assertThat(PortalRedirect.hostOf("https://u@Office.MinimalistAlliance.com.:1/p")).isEqualTo("office.minimalistalliance.com");
    }

    @Test
    void lookalikesNeverMatch() {
        for (String url : List.of(
                "https://office.minimalistalliance.com.example.com/",
                "https://officeminimalistalliance.com/",
                "https://xoffice.minimalistalliance.com/",
                "https://office.minimalistalliance.co/",
                "https://office.minimalistalliance.com@example.com/",
                "https://office.minimalistalliance.com:443@example.com/",
                "https://office.minimalistalliance.com%40example.com/",
                "https://office-minimalistalliance.com/",
                "https://desk.minimalistalliance.community/",
                "https://staging.minimalistalliance.com/",
                "https://minimalistalliance.com/",
                "https://example.com/office.minimalistalliance.com",
                "https://example.com/?u=https://office.minimalistalliance.com/",
                "https://example.com#@office.minimalistalliance.com",
                "https://example.com\\@office.minimalistalliance.com",
                // A Cyrillic o is another name altogether.
                "https://\u043effice.minimalistalliance.com/")) {
            assertThat(PortalRedirect.isOffice(url)).as(url).isFalse();
        }
    }

    @Test
    void theOtherBlockedHostsAndTheRestOfTheAllianceNeverMatch() {
        for (String url : List.of(
                "https://api.minimalistalliance.com/",
                "https://auth.minimalistalliance.com/",
                "https://gw.minimalistalliance.com/",
                "https://api.staging.minimalistalliance.com/",
                "https://auth.staging.minimalistalliance.com/",
                "https://gw.staging.minimalistalliance.com/",
                "https://portal.minimalistalliance.com/",
                "https://forums.minimalistalliance.com/",
                "https://platform.minimalistalliance.com/",
                "https://minimalistalliance.com/")) {
            assertThat(PortalRedirect.isOffice(url)).as(url).isFalse();
        }
    }

    @Test
    void onlyHttpAndHttpsCount() {
        for (String url : java.util.Arrays.asList(
                null,
                "",
                "office.minimalistalliance.com",
                "//office.minimalistalliance.com/",
                "ftp://office.minimalistalliance.com/",
                "wss://office.minimalistalliance.com/",
                "javascript:location='https://office.minimalistalliance.com/'",
                "chrome-error://chromewebdata/",
                // A long s isn't an s.
                "http\u017f://office.minimalistalliance.com/",
                "https://[::1]/",
                "https:///")) {
            assertThat(PortalRedirect.isOffice(url)).as(String.valueOf(url)).isFalse();
        }
    }

    @Test
    void unsetFollowsTheEnvTag() {
        java.util.concurrent.atomic.AtomicReference<String> env = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.function.Supplier<String> portal = PortalRedirect.portalFor(null, env::get);
        assertThat(portal.get()).as("before IMDS has said").isNull();
        env.set("prod");
        assertThat(portal.get()).isEqualTo("https://portal.minimalistalliance.com/");
        env.set("staging");
        assertThat(portal.get()).isEqualTo("https://portal.staging.minimalistalliance.com/");
        env.set("dev");
        assertThat(portal.get()).isNull();
        assertThat(PortalRedirect.portalFor("  ", () -> "prod").get()).isEqualTo("https://portal.minimalistalliance.com/");
    }

    @Test
    void offIsOffWhateverTheEnv() {
        for (String off : List.of("off", "OFF", " off ")) {
            assertThat(PortalRedirect.portalFor(off, () -> "prod").get()).as(off).isNull();
        }
    }

    @Test
    void aUrlSendsItThereAndAnythingElseIsOff() {
        assertThat(PortalRedirect.portalFor("http://127.0.0.1:8080/portal/", () -> "prod").get()).isEqualTo("http://127.0.0.1:8080/portal/");
        assertThat(PortalRedirect.portalFor("https://portal.example/", () -> null).get()).isEqualTo("https://portal.example/");
        for (String bad : List.of(
                "on",
                "true",
                "portal.minimalistalliance.com",
                "javascript:alert(1)",
                "file:///etc/passwd",
                // Never the office itself, which would be a loop.
                "https://office.minimalistalliance.com/",
                "https://x.desk.staging.minimalistalliance.com/")) {
            assertThat(PortalRedirect.portalFor(bad, () -> "prod").get()).as(bad).isNull();
        }
    }

    @Test
    void aPortalPageIsOneUnderThePortalsUrl() {
        PortalRedirect portal = new PortalRedirect();
        assertThat(portal.isPortalPage("https://portal.minimalistalliance.com/")).as("off").isFalse();
        portal.portalFrom(() -> "https://portal.minimalistalliance.com/");
        assertThat(portal.isPortalPage("https://portal.minimalistalliance.com/")).isTrue();
        assertThat(portal.isPortalPage("https://portal.minimalistalliance.com/loop?x=1")).isTrue();
        assertThat(portal.isPortalPage("https://portal.minimalistalliance.com.example.com/")).isFalse();
        assertThat(portal.isPortalPage("https://forums.minimalistalliance.com/")).isFalse();
        assertThat(portal.isPortalPage(null)).isFalse();
    }

    @Test
    void deskdsOwnNavigationGoesStraightThereOnlyWhileOn() {
        PortalRedirect portal = new PortalRedirect();
        assertThat(portal.direct("https://office.minimalistalliance.com/x")).isEqualTo("https://office.minimalistalliance.com/x");
        portal.portalFrom(() -> "https://portal.minimalistalliance.com/");
        assertThat(portal.direct("https://office.minimalistalliance.com/x")).isEqualTo("https://portal.minimalistalliance.com/");
        assertThat(portal.direct("https://api.minimalistalliance.com/x")).isEqualTo("https://api.minimalistalliance.com/x");
        assertThat(portal.direct("https://office.minimalistalliance.com@example.com/"))
                .isEqualTo("https://office.minimalistalliance.com@example.com/");
        assertThat(portal.counts().direct()).isEqualTo(1);
    }
}
