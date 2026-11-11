package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * What a link Chromium hands the desk's OS may become on its way to the member's own device (API.md section 10, "Links
 * out"): a scheme on {@link #SCHEMES}, a URL cleaned to plain ASCII, and the text to show for it. Everything else is
 * dropped. The link is a web page's, so nothing here trusts it.
 *
 * <p><b>Why these schemes.</b> Each opens something a desk can't, on the device the member holds: {@code mailto} (their
 * own mail), {@code tel} and {@code sms} (a phone), {@code zoommtg} and {@code msteams} (the meeting apps' join links, which
 * their web pages launch), {@code facetime}, and {@code webcal} (a calendar subscription). {@code http} and {@code https}
 * too, through {@link BrowserUrl}, for a page Chromium hands out itself. Nothing that runs a program or reads a file on the
 * member's device ({@code file}, {@code ms-msdt}, {@code search-ms}, {@code ms-officecmd} and their kind), and nothing a
 * browser runs itself ({@code javascript}, {@code data}, {@code blob}). Chromium never hands those last ones out, and they'd
 * be dropped here anyway.
 *
 * <p><b>Cleaning.</b> The scheme is lowercased. An {@code http} or {@code https} URL goes through {@link BrowserUrl}, as one
 * a client sends does. Any other keeps what follows its colon, with spaces, {@code "<>\^`{|}}, a {@code %} that starts no
 * escape and every non-ASCII character percent-encoded as UTF-8, so the URL is printable ASCII. A control character or half
 * a surrogate pair anywhere drops it: Chromium escapes those before it hands a URL out, so one that has them didn't come
 * from Chromium the usual way.
 *
 * <p><b>The text to show.</b> The cleaned URL with only escapes of printable ASCII decoded ({@code %20} is a space,
 * {@code %40} an {@code @}). Anything else stays as an escape, so no lookalike letter, control or bidi character can appear
 * that the URL doesn't plainly hold. Cut to {@value #DISPLAY_CHARS} characters, with an ellipsis.
 */
final class LinkOut {

    /** In the order the API lists them. Lowercase ASCII. */
    static final List<String> SCHEMES =
            List.of("http", "https", "mailto", "tel", "sms", "zoommtg", "msteams", "facetime", "webcal");
    /** Far past any mailto a share button makes. The event stays well under 64 KiB with its text. */
    static final int MAX_CHARS = 8192;
    static final int DISPLAY_CHARS = 200;
    static final String DROP_SCHEME = "scheme";
    static final String DROP_URL = "url";

    private static final int MAX_SCHEME_CHARS = 32;
    private static final String ENCODED = " \"<>\\^`{|}";
    private static final char[] HEX = "0123456789ABCDEF".toCharArray();

    /** A link that may go to the member's device. */
    record Link(String scheme, String url, String displayText) {}

    /** Exactly one of the two is set. */
    record Verdict(Link link, String drop) {
        static Verdict dropped(String reason) {
            return new Verdict(null, reason);
        }
    }

    private LinkOut() {}

    static Verdict check(String raw) {
        if (raw == null || raw.isEmpty()) {
            return Verdict.dropped(DROP_SCHEME);
        }
        if (raw.length() > MAX_CHARS) {
            return Verdict.dropped(DROP_URL);
        }
        int colon = raw.indexOf(':');
        String scheme = colon <= 0 ? null : lowerScheme(raw.substring(0, colon));
        if (scheme == null || !SCHEMES.contains(scheme)) {
            return Verdict.dropped(DROP_SCHEME);
        }
        String url;
        if (scheme.equals("http") || scheme.equals("https")) {
            try {
                String parsed = BrowserUrl.parse(raw);
                url = scheme + parsed.substring(parsed.indexOf(':'));
            } catch (RpcException e) {
                return Verdict.dropped(DROP_URL);
            }
        } else {
            String rest = encodeOpaque(raw.substring(colon + 1));
            if (rest == null || rest.isEmpty()) {
                return Verdict.dropped(DROP_URL);
            }
            url = scheme + ":" + rest;
        }
        if (url.length() > MAX_CHARS) {
            return Verdict.dropped(DROP_URL);
        }
        return new Verdict(new Link(scheme, url, displayText(url)), null);
    }

    /** A scheme by RFC 3986, in ASCII lowercase; null if it isn't one. */
    private static String lowerScheme(String scheme) {
        if (scheme.length() > MAX_SCHEME_CHARS || !isAsciiLetter(scheme.charAt(0))) {
            return null;
        }
        StringBuilder lower = new StringBuilder(scheme.length());
        for (int i = 0; i < scheme.length(); i++) {
            char c = scheme.charAt(i);
            if (!isAsciiLetter(c) && !(c >= '0' && c <= '9') && c != '+' && c != '-' && c != '.') {
                return null;
            }
            lower.append(c >= 'A' && c <= 'Z' ? (char) (c + 32) : c);
        }
        return lower.toString();
    }

    /** @return the part after the colon in printable ASCII, or null if it has a control character or half a surrogate pair */
    private static String encodeOpaque(String rest) {
        StringBuilder out = new StringBuilder(rest.length() + 16);
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c < 0x20 || c == 0x7F) {
                return null;
            }
            if (Character.isSurrogate(c)) {
                if (!Character.isHighSurrogate(c) || i + 1 == rest.length() || !Character.isLowSurrogate(rest.charAt(i + 1))) {
                    return null;
                }
                escape(out, rest.substring(i, i + 2));
                i++;
            } else if (c >= 0x80 || ENCODED.indexOf(c) >= 0 || (c == '%' && !isEscape(rest, i))) {
                escape(out, String.valueOf(c));
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    private static void escape(StringBuilder out, String text) {
        for (byte b : text.getBytes(StandardCharsets.UTF_8)) {
            out.append('%').append(HEX[(b >> 4) & 0xF]).append(HEX[b & 0xF]);
        }
    }

    private static boolean isEscape(String text, int percent) {
        return percent + 2 < text.length() && hexValue(text.charAt(percent + 1)) >= 0 && hexValue(text.charAt(percent + 2)) >= 0;
    }

    private static int hexValue(char c) {
        if (c >= '0' && c <= '9') {
            return c - '0';
        }
        if (c >= 'a' && c <= 'f') {
            return c - 'a' + 10;
        }
        if (c >= 'A' && c <= 'F') {
            return c - 'A' + 10;
        }
        return -1;
    }

    /** The cleaned URL, which is printable ASCII, with escapes of printable ASCII decoded and the rest as they are. */
    static String displayText(String url) {
        StringBuilder out = new StringBuilder(Math.min(url.length(), DISPLAY_CHARS + 1));
        for (int i = 0; i < url.length() && out.length() <= DISPLAY_CHARS; i++) {
            char c = url.charAt(i);
            if (c == '%' && isEscape(url, i)) {
                int value = hexValue(url.charAt(i + 1)) * 16 + hexValue(url.charAt(i + 2));
                if (value >= 0x20 && value < 0x7F) {
                    out.append((char) value);
                    i += 2;
                    continue;
                }
            }
            out.append(c);
        }
        if (out.length() > DISPLAY_CHARS) {
            out.setLength(DISPLAY_CHARS - 1);
            out.append('…');
        }
        return out.toString();
    }

    private static boolean isAsciiLetter(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }
}
