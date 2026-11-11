package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

/** Which links may go to the member's device, and what they become (API.md section 10, "Links out"). */
class LinkOutTest {

    private static LinkOut.Link passes(String raw) {
        LinkOut.Verdict verdict = LinkOut.check(raw);
        assertThat(verdict.drop()).as(raw).isNull();
        return verdict.link();
    }

    private static void dropped(String raw, String reason) {
        LinkOut.Verdict verdict = LinkOut.check(raw);
        assertThat(verdict.link()).as(raw).isNull();
        assertThat(verdict.drop()).as(raw).isEqualTo(reason);
    }

    @Test
    void theListedSchemesPassAsChromiumGivesThem() {
        assertThat(passes("mailto:a@example.com?subject=Hi%20there"))
                .isEqualTo(new LinkOut.Link("mailto", "mailto:a@example.com?subject=Hi%20there", "mailto:a@example.com?subject=Hi there"));
        assertThat(passes("tel:+15551234567").url()).isEqualTo("tel:+15551234567");
        assertThat(passes("sms:+15551234567?body=on%20my%20way").displayText()).isEqualTo("sms:+15551234567?body=on my way");
        assertThat(passes("zoommtg://zoom.us/join?action=join&confno=123&pwd=abc").url())
                .isEqualTo("zoommtg://zoom.us/join?action=join&confno=123&pwd=abc");
        assertThat(passes("msteams:/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%7d").url())
                .isEqualTo("msteams:/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%7d");
        assertThat(passes("facetime:someone@example.com").scheme()).isEqualTo("facetime");
        assertThat(passes("webcal://calendar.example.com/team.ics").scheme()).isEqualTo("webcal");
        assertThat(passes("https://example.com/a").url()).isEqualTo("https://example.com/a");
        assertThat(passes("http://example.com/").scheme()).isEqualTo("http");
    }

    @Test
    void theSchemeIsLowercasedAsciiOnly() {
        assertThat(passes("MAILTO:A@Example.com").url()).isEqualTo("mailto:A@Example.com");
        assertThat(passes("HTTPS://Example.com/").url()).startsWith("https://");
        // U+017F, long s, which a case-insensitive match would take for an s.
        dropped("ſms:+1555", LinkOut.DROP_SCHEME);
        dropped("telK:1", LinkOut.DROP_SCHEME);
    }

    @Test
    void anythingElseIsDropped() {
        for (String raw : List.of(
                "javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "blob:https://example.com/x",
                "vbscript:x", "ms-msdt:/id PCWDiagnostic", "search-ms:query=x", "ms-officecmd:x", "slack://open",
                "spotify:track:1", "zoomus://zoom.us/join", "facetime-audio:x", "intent://x#Intent;end", "chrome://settings",
                "view-source:https://example.com/", "about:blank", "weird-scheme:foo")) {
            dropped(raw, LinkOut.DROP_SCHEME);
        }
    }

    /** Chromium's download bubble hands xdg-open a path, for Open and Show in folder: never a link, and never shown. */
    @Test
    void aPathOrNoSchemeIsDropped() {
        dropped("/data/browser/downloads/report.pdf", LinkOut.DROP_SCHEME);
        dropped("/data/browser/downloads", LinkOut.DROP_SCHEME);
        dropped("example.com", LinkOut.DROP_SCHEME);
        dropped(":x", LinkOut.DROP_SCHEME);
        dropped("", LinkOut.DROP_SCHEME);
        dropped(null, LinkOut.DROP_SCHEME);
    }

    @Test
    void aSchemeIsWhatComesBeforeTheFirstColonExactly() {
        dropped(" mailto:a@example.com", LinkOut.DROP_SCHEME);
        dropped("java\tscript:x", LinkOut.DROP_SCHEME);
        dropped("mail to:a@example.com", LinkOut.DROP_SCHEME);
        dropped("1tel:5", LinkOut.DROP_SCHEME);
        dropped("t".repeat(40) + ":x", LinkOut.DROP_SCHEME);
    }

    @Test
    void controlsAndHalfPairsDropTheLink() {
        dropped("mailto:a@example.com\nbcc:b@example.com", LinkOut.DROP_URL);
        dropped("tel:1\u0000", LinkOut.DROP_URL);
        dropped("tel:1\u007f", LinkOut.DROP_URL);
        dropped("sms:1?body=\ud83d", LinkOut.DROP_URL);
        dropped("sms:1?body=\ude00x", LinkOut.DROP_URL);
        dropped("https://example.com/\tx", LinkOut.DROP_URL);
    }

    @Test
    void whatsLeftIsEncodedToPrintableAscii() {
        assertThat(passes("mailto:a@example.com?subject=two words").url()).isEqualTo("mailto:a@example.com?subject=two%20words");
        assertThat(passes("mailto:a@example.com?subject=\"<x>\"|{}^`\\").url())
                .isEqualTo("mailto:a@example.com?subject=%22%3Cx%3E%22%7C%7B%7D%5E%60%5C");
        assertThat(passes("mailto:müller@example.com").url()).isEqualTo("mailto:m%C3%BCller@example.com");
        assertThat(passes("sms:1?body=😀").url()).isEqualTo("sms:1?body=%F0%9F%98%80");
        assertThat(passes("mailto:a@example.com?subject=100%").url()).isEqualTo("mailto:a@example.com?subject=100%25");
        assertThat(passes("mailto:a@example.com?subject=%zz%2").url()).isEqualTo("mailto:a@example.com?subject=%25zz%252");
        assertThat(passes("mailto:a@example.com?subject=%E2%82%AC").url()).isEqualTo("mailto:a@example.com?subject=%E2%82%AC");
        // C1 controls are non-ASCII, so they're encoded, never sent as they are.
        assertThat(passes("tel:1\u0085").url()).isEqualTo("tel:1%C2%85");
        assertThat(passes("tel:+1 555 123").url().chars().allMatch(c -> c > 0x20 && c < 0x7F)).isTrue();
    }

    @Test
    void webUrlsGoThroughTheBrowsersOwnPolicy() {
        assertThat(passes("https://example.com/a b").url()).isEqualTo("https://example.com/a%20b");
        assertThat(passes("https://müller.de/").url()).isEqualTo("https://xn--mller-kva.de/");
        dropped("https:example.com", LinkOut.DROP_URL);
        dropped("http://", LinkOut.DROP_URL);
        dropped("https://example.com\\@evil.example/", LinkOut.DROP_URL);
    }

    @Test
    void nothingIsLeftAfterTheColon() {
        dropped("mailto:", LinkOut.DROP_URL);
        dropped("tel:", LinkOut.DROP_URL);
    }

    @Test
    void aLinkPastTheCapIsDroppedNeverCut() {
        String body = "x".repeat(LinkOut.MAX_CHARS - "mailto:a@example.com?body=".length());
        assertThat(passes("mailto:a@example.com?body=" + body).url()).hasSize(LinkOut.MAX_CHARS);
        dropped("mailto:a@example.com?body=" + body + "x", LinkOut.DROP_URL);
        // Encoding can take it past the cap too.
        dropped("mailto:a@example.com?body=" + " ".repeat(LinkOut.MAX_CHARS / 2), LinkOut.DROP_URL);
    }

    @Test
    void theTextShowsPrintableAsciiAndNothingThatCouldReadAsSomethingElse() {
        assertThat(passes("mailto:a%40example.com?subject=Lunch%3F%20%F0%9F%8D%95").displayText())
                .isEqualTo("mailto:a@example.com?subject=Lunch? %F0%9F%8D%95");
        // A newline, a bidi override and a Cyrillic letter stay escapes, so the text reads as the URL is.
        assertThat(passes("mailto:a@example.com?subject=a%0Ab%E2%80%AEc").displayText())
                .isEqualTo("mailto:a@example.com?subject=a%0Ab%E2%80%AEc");
        assertThat(passes("mailto:support@paypa%D0%B0.com").displayText()).isEqualTo("mailto:support@paypa%D0%B0.com");
        assertThat(passes("tel:%2B1%20555").displayText()).isEqualTo("tel:+1 555");
    }

    @Test
    void theTextIsCutWithAnEllipsis() {
        String text = passes("mailto:a@example.com?body=" + "y".repeat(500)).displayText();
        assertThat(text).hasSize(LinkOut.DISPLAY_CHARS).endsWith("y…").startsWith("mailto:a@example.com?body=y");
        String exact = "tel:" + "1".repeat(LinkOut.DISPLAY_CHARS - 4);
        assertThat(passes(exact).displayText()).isEqualTo(exact);
    }
}
