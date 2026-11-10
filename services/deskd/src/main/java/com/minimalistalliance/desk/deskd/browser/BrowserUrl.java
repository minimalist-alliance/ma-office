package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.net.IDN;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Map;

/**
 * The only URLs a client can send Chromium to: absolute http and https ones with a host.
 *
 * <p>The scheme has to be exactly that, from the first character. Browsers strip leading spaces and
 * control characters, and tabs and newlines anywhere, which is how {@code java\tscript:} works, so a URL
 * holding any of those is refused rather than cleaned up. A URL that gets past this is given to Chromium
 * in its encoded form, not as the client wrote it.
 *
 * <p>java.net.URI does the parsing, and its grammar is narrower than Chromium's. What it would wrongly
 * refuse in a path, query or fragment is encoded first, and a host with an underscore is checked here.
 */
final class BrowserUrl {

    /** Chromium's own limit is 2 MB. Nothing a member types or pastes on purpose comes near this. */
    static final int MAX_CHARS = 16 * 1024;

    private static final String ENCODED_ON_THE_WAY = " \"<>^`{|}";
    private static final int MAX_PORT = 65535;
    /** Sharp s, final sigma, ZWNJ and ZWJ. */
    private static final String IDNA_DEVIATIONS = "\u00df\u03c2\u200c\u200d";

    private BrowserUrl() {}

    /**
     * @return the URL to give Chromium
     * @throws RpcException bad_request with details.reason scheme or url, or too_large
     */
    static String parse(String raw) throws RpcException {
        if (raw.length() > MAX_CHARS) {
            throw new RpcException(RpcException.TOO_LARGE, "URL too long", Map.of("limit", MAX_CHARS));
        }
        int colon = raw.indexOf(':');
        if (colon < 0 || !isWebScheme(raw.substring(0, colon))) {
            throw refused("scheme", "Only http and https URLs can be opened");
        }
        if (!raw.startsWith("//", colon + 1)) {
            throw refused("url", "Not a URL with a host");
        }
        int authorityEnd = authorityEnd(raw, colon + 3);
        boolean inFragment = false;
        StringBuilder encoded = new StringBuilder(raw.length() + 16);
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c < 0x20 || c == 0x7F || c == '\\' || isLoneSurrogate(raw, i)) {
                throw refused("url", "Not a URL with a host");
            }
            boolean encode = ENCODED_ON_THE_WAY.indexOf(c) >= 0;
            if (i >= authorityEnd) {
                encode |= c == '[' || c == ']' || (c == '#' && inFragment) || (c == '%' && !isEscape(raw, i));
                inFragment |= c == '#';
            }
            if (encode) {
                encoded.append('%').append(String.format("%02X", (int) c));
            } else {
                encoded.append(c);
            }
        }
        try {
            URI uri = new URI(encoded.toString());
            if (uri.getHost() == null && !hasPlainAuthority(uri)) {
                uri = withAsciiHost(uri);
                if (uri == null || uri.getHost() == null) {
                    throw refused("url", "Not a URL with a host");
                }
            }
            if (uri.isOpaque() || uri.getPort() > MAX_PORT || !isWebScheme(uri.getScheme())) {
                throw refused("url", "Not a URL with a host");
            }
            return uri.toASCIIString();
        } catch (URISyntaxException | IllegalArgumentException e) {
            throw refused("url", "Not a URL with a host");
        }
    }

    private static int authorityEnd(String raw, int start) {
        for (int i = start; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                return i;
            }
        }
        return raw.length();
    }

    /** Half a pair can't be encoded: URI.toASCIIString throws NullPointerException on one. */
    private static boolean isLoneSurrogate(String raw, int i) {
        char c = raw.charAt(i);
        if (Character.isHighSurrogate(c)) {
            return i + 1 == raw.length() || !Character.isLowSurrogate(raw.charAt(i + 1));
        }
        return Character.isLowSurrogate(c) && (i == 0 || !Character.isHighSurrogate(raw.charAt(i - 1)));
    }

    private static boolean isEscape(String raw, int percent) {
        return percent + 2 < raw.length()
                && Character.digit(raw.charAt(percent + 1), 16) >= 0 && raw.charAt(percent + 1) < 0x80
                && Character.digit(raw.charAt(percent + 2), 16) >= 0 && raw.charAt(percent + 2) < 0x80;
    }

    /**
     * java.net.URI gives no host for a name like foo_bar.example, and Chromium opens one. So an ASCII
     * authority it couldn't read is taken if it's plainly a name and a port, one userinfo at most.
     */
    private static boolean hasPlainAuthority(URI uri) {
        String authority = uri.getRawAuthority();
        if (authority == null || authority.chars().anyMatch(c -> c >= 0x80)) {
            return false;
        }
        int at = authority.lastIndexOf('@');
        if (at != authority.indexOf('@')) {
            return false;
        }
        String hostPort = authority.substring(at + 1);
        int portColon = hostPort.lastIndexOf(':');
        String host = portColon < 0 ? hostPort : hostPort.substring(0, portColon);
        return isPlainHost(host) && (portColon < 0 || isPort(hostPort.substring(portColon + 1)));
    }

    /** Letters, digits, underscores, hyphens and dots. */
    private static boolean isPlainHost(String host) {
        boolean named = false;
        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            if (isAsciiLetter(c) || c == '_' || c == '-') {
                named = true;
            } else if (c != '.' && (c < '0' || c > '9')) {
                return false;
            }
        }
        return named && !endsInNumber(host);
    }

    /** By the URL standard: Chromium takes such a host for an IPv4 address, and calls it invalid if it isn't. */
    private static boolean endsInNumber(String host) {
        String name = host.endsWith(".") ? host.substring(0, host.length() - 1) : host;
        String last = name.substring(name.lastIndexOf('.') + 1);
        boolean hex = last.startsWith("0x") || last.startsWith("0X");
        int radix = hex ? 16 : 10;
        for (int i = hex ? 2 : 0; i < last.length(); i++) {
            if (Character.digit(last.charAt(i), radix) < 0) {
                return false;
            }
        }
        return true;
    }

    private static boolean isAsciiLetter(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }

    private static boolean isPort(String port) {
        if (port.length() > 5) {
            return false;
        }
        for (int i = 0; i < port.length(); i++) {
            if (port.charAt(i) < '0' || port.charAt(i) > '9') {
                return false;
            }
        }
        return port.isEmpty() || Integer.parseInt(port) <= MAX_PORT;
    }

    /** ASCII only, on purpose: equalsIgnoreCase would let U+017F pass as an s. */
    private static boolean isWebScheme(String scheme) {
        if (scheme == null || scheme.length() < 4 || scheme.length() > 5) {
            return false;
        }
        StringBuilder lower = new StringBuilder(5);
        for (int i = 0; i < scheme.length(); i++) {
            char c = scheme.charAt(i);
            lower.append(c >= 'A' && c <= 'Z' ? (char) (c + 32) : c);
        }
        String text = lower.toString();
        return text.equals("http") || text.equals("https");
    }

    /**
     * java.net.URI gives no host for a name like müller.de. With ASCII that means there's no host
     * anywhere. Otherwise the name goes through IDNA, as Chromium would do it, so a client can pass what
     * a member typed.
     *
     * <p>STD3 rules, so a compatibility mapping can't produce a delimiter: U+FF20 becomes @, which would
     * move the host. Where Java's IDNA 2003 and Chromium's UTS 46 read a character differently the name
     * is refused, as they'd go to different hosts. Characters newer than Java's table are refused anyway.
     *
     * @return the URI with its host in ASCII, or null if it hasn't one
     */
    private static URI withAsciiHost(URI uri) throws URISyntaxException {
        String authority = uri.getRawAuthority();
        if (authority == null || authority.chars().allMatch(c -> c < 0x80)) {
            return null;
        }
        int at = authority.lastIndexOf('@');
        String userInfo = at < 0 ? "" : authority.substring(0, at + 1);
        String hostPort = authority.substring(at + 1);
        int portColon = hostPort.lastIndexOf(':');
        String host = portColon < 0 ? hostPort : hostPort.substring(0, portColon);
        String port = portColon < 0 ? "" : hostPort.substring(portColon);
        if (host.chars().anyMatch(c -> IDNA_DEVIATIONS.indexOf(c) >= 0)) {
            return null;
        }
        StringBuilder rebuilt = new StringBuilder(uri.getScheme()).append("://").append(userInfo)
                .append(IDN.toASCII(host, IDN.USE_STD3_ASCII_RULES)).append(port);
        if (uri.getRawPath() != null) {
            rebuilt.append(uri.getRawPath());
        }
        if (uri.getRawQuery() != null) {
            rebuilt.append('?').append(uri.getRawQuery());
        }
        if (uri.getRawFragment() != null) {
            rebuilt.append('#').append(uri.getRawFragment());
        }
        return new URI(rebuilt.toString());
    }

    private static RpcException refused(String reason, String message) {
        return new RpcException(RpcException.BAD_REQUEST, message, Map.of("reason", reason));
    }
}
