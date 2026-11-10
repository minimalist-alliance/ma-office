package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class BrowserUrlTest {

    private static void assertRefused(String url, String reason) {
        assertThatThrownBy(() -> BrowserUrl.parse(url))
                .as("%s", url.replace("\n", "\\n").replace("\t", "\\t"))
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo(RpcException.BAD_REQUEST);
                    assertThat(e.details()).isEqualTo(Map.of("reason", reason));
                    assertThat(e.getMessage()).isIn("Only http and https URLs can be opened", "Not a URL with a host");
                });
    }

    @Test
    void anythingThatIsntExactlyHttpOrHttpsIsRefusedAsAScheme() {
        for (String url : List.of(
                "javascript:alert(1)",
                "JaVaScRiPt:alert(1)",
                " javascript:alert(1)",
                "\tjavascript:alert(1)",
                "\njavascript:alert(1)",
                "java\tscript:alert(1)",
                "java\nscript:alert(1)",
                "java\rscript:alert(1)",
                "\u0001javascript:alert(1)",
                "\u0000javascript:alert(1)",
                "\u00a0javascript:alert(1)",
                "\u2003javascript:alert(1)",
                "file:///etc/passwd",
                "FILE:///etc/passwd",
                "fIlE://localhost/etc/passwd",
                "chrome://settings",
                "CHROME://settings",
                "chrome-extension://abc/x",
                "devtools://devtools/bundled/inspector.html",
                "data:text/html,<script>alert(1)</script>",
                "DATA:text/html,x",
                "about:blank",
                "ABOUT:BLANK",
                "blob:https://example.com/uuid",
                "filesystem:https://example.com/temporary/x",
                "view-source:https://example.com",
                "ws://example.com",
                "wss://example.com",
                "ftp://example.com",
                "//example.com",
                "example.com",
                "example.com:443",
                "",
                " ",
                ":",
                "://example.com",
                " https://example.com",
                "\thttps://example.com",
                "\nhttps://example.com",
                "ht\ntps://example.com",
                "ht\ttps://example.com",
                "https\t://example.com",
                "https ://example.com",
                "\u0001https://example.com",
                "\ufeffhttps://example.com",
                "\u200bhttps://example.com",
                "http\u017f://example.com",
                "\uff48\uff54\uff54\uff50\uff53://example.com",
                "https\u0000://example.com",
                "httpss://example.com",
                "htp://example.com")) {
            assertRefused(url, "scheme");
        }
    }

    @Test
    void theRightSchemeWithNoProperHostIsRefusedAsAUrl() {
        for (String url : List.of(
                "https:javascript:alert(1)",
                "https:/example.com",
                "https:example.com",
                "https:\\\\example.com",
                "https:/\\example.com",
                "https://",
                "https:///path",
                "https://:443/",
                "https://user@/",
                "https://example.com\\@evil.example/",
                "https://exa mple.com/",
                "https://exa\tmple.com/",
                "https://example.com/\n",
                "https://example.com\n.evil.example/",
                "https://example.com/\u0000",
                "https://example.com/\u007f",
                "https://exa%00mple.com/",
                "https://example.com:99999/",
                "https://example.com:notaport/",
                "https://[::1/")) {
            assertRefused(url, "url");
        }
    }

    @Test
    void ordinaryUrlsPassEncoded() throws Exception {
        assertThat(BrowserUrl.parse("http://example.com")).isEqualTo("http://example.com");
        assertThat(BrowserUrl.parse("https://example.com/a?b=c#d")).isEqualTo("https://example.com/a?b=c#d");
        assertThat(BrowserUrl.parse("HTTPS://EXAMPLE.COM/A")).isEqualTo("HTTPS://EXAMPLE.COM/A");
        assertThat(BrowserUrl.parse("https://example.com/a b?q={x}|y")).isEqualTo("https://example.com/a%20b?q=%7Bx%7D%7Cy");
        assertThat(BrowserUrl.parse("https://example.com/caf\u00e9")).isEqualTo("https://example.com/caf%C3%A9");
        assertThat(BrowserUrl.parse("http://127.0.0.1:3000/")).isEqualTo("http://127.0.0.1:3000/");
        assertThat(BrowserUrl.parse("http://[::1]:8080/x")).isEqualTo("http://[::1]:8080/x");
        assertThat(BrowserUrl.parse("https://user:pw@example.com/")).isEqualTo("https://user:pw@example.com/");
        assertThat(BrowserUrl.parse("https://m\u00fcller.de/pfad?a=1#z")).isEqualTo("https://xn--mller-kva.de/pfad?a=1#z");
        assertThat(BrowserUrl.parse("https://m\u00fcller.de:8443/")).isEqualTo("https://xn--mller-kva.de:8443/");
    }

    /**
     * Regression: IDNA's compatibility mapping turned these into real delimiters, so a link that reads as
     * bank.example went to evil.example. Chromium calls every one of them invalid.
     */
    @Test
    void aCharacterThatMapsToADelimiterCantMoveTheHost() {
        for (String url : List.of(
                "http://bank.example\uff20evil.example/",
                "http://bank.example\ufe6bevil.example/",
                "http://a\uff0fb.com/",
                "http://a\uff1a80.com/",
                "http://a\uff1fb.com/",
                "http://a\uff03b.com/",
                "http://a\uff3cb.com/",
                "http://\u2100.com/",
                "http://m\u00fcller.de\uff20evil.example/",
                "http://m\u00fcller_x.de/")) {
            assertRefused(url, "url");
        }
        // A dot in another script is a dot to Chromium too.
        assertThat(sendsTo("http://example\u3002com/")).isEqualTo("http://example.com/");
    }

    /** Java's IDNA is the 2003 one, and maps these where Chromium keeps them: a different host. */
    @Test
    void aHostChromiumWouldReadDifferentlyIsRefused() {
        for (String url : List.of(
                "http://fa\u00df.de/", "http://\u03c2.gr/", "http://pay\u200dpal.com/", "http://pay\u200cpal.com/")) {
            assertRefused(url, "url");
        }
    }

    /** Regression: this threw NullPointerException in URI.toASCIIString, so the client got internal. */
    @Test
    void aLoneSurrogateIsRefusedAndAPairIsEncoded() throws Exception {
        for (String url : List.of(
                "http://a.com/\ud800", "http://a.com/\udc00", "http://a.com/?q=\ud800", "http://a.com/#\ud800", "http://\ud800.com/")) {
            assertRefused(url, "url");
        }
        assertThat(BrowserUrl.parse("https://example.com/\ud83d\ude00")).isEqualTo("https://example.com/%F0%9F%98%80");
    }

    /** Regression: java.net.URI's grammar refused these, and Chromium opens them. */
    @Test
    void urlsThatOnlyJavaThoughtWrongPass() throws Exception {
        assertThat(BrowserUrl.parse("http://foo_bar.example/")).isEqualTo("http://foo_bar.example/");
        assertThat(BrowserUrl.parse("https://u:p@foo_bar.example:8443/x")).isEqualTo("https://u:p@foo_bar.example:8443/x");
        assertThat(BrowserUrl.parse("https://_dmarc.example")).isEqualTo("https://_dmarc.example");
        assertThat(BrowserUrl.parse("https://foo_bar.example./")).isEqualTo("https://foo_bar.example./");
        assertThat(BrowserUrl.parse("https://a.com/x[1].html")).isEqualTo("https://a.com/x%5B1%5D.html");
        assertThat(BrowserUrl.parse("https://a.com/?filter[a]=1")).isEqualTo("https://a.com/?filter%5Ba%5D=1");
        assertThat(BrowserUrl.parse("https://a.com/100%")).isEqualTo("https://a.com/100%25");
        assertThat(BrowserUrl.parse("https://a.com/100%zz?x=%")).isEqualTo("https://a.com/100%25zz?x=%25");
        assertThat(BrowserUrl.parse("https://a.com/%41%zA")).isEqualTo("https://a.com/%41%25zA");
        assertThat(BrowserUrl.parse("https://a.com/#a#b")).isEqualTo("https://a.com/#a%23b");
        assertThat(BrowserUrl.parse("http://[::1]:8080/[x]")).isEqualTo("http://[::1]:8080/%5Bx%5D");
    }

    /** What the fix for those mustn't let through. */
    @Test
    void aHostOutsideJavasGrammarStillHasToBeAHost() {
        for (String url : List.of(
                "https://foo_bar.example:99999/",
                "https://foo_bar.example:notaport/",
                "https://foo_bar.example:-1/",
                "https://fo%6f_bar.example/",
                "https://foo bar_baz.example/",
                "https://a@b@c_d.example/",
                "https://u@/",
                "https://./",
                "https://.../",
                "https://foo_bar.123/",
                "https://foo_bar.123./",
                "https://a_b.0x1f/",
                "https://a_b.0X/",
                "https://[a_b]/",
                "https://a%/",
                "https://foo_bar.example\\@evil.example/")) {
            assertRefused(url, "url");
        }
    }

    private static String sendsTo(String url) {
        try {
            return BrowserUrl.parse(url);
        } catch (RpcException e) {
            throw new AssertionError(e.getMessage());
        }
    }

    @Test
    void aVeryLongUrlIsTooLarge() throws Exception {
        String base = "https://example.com/";
        assertThat(BrowserUrl.parse(base + "x".repeat(BrowserUrl.MAX_CHARS - base.length()))).hasSize(BrowserUrl.MAX_CHARS);
        assertThatThrownBy(() -> BrowserUrl.parse(base + "x".repeat(BrowserUrl.MAX_CHARS)))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(e.code()).isEqualTo(RpcException.TOO_LARGE));
    }
}
