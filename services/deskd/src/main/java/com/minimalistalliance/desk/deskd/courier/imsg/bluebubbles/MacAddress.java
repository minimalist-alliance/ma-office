package com.minimalistalliance.desk.deskd.courier.imsg.bluebubbles;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * The address of the member's BlueBubbles Server, as they paste it from BlueBubbles (the Designer's flow 8, step 2):
 * {@code https://} only, a DNS name or a public IP literal, a port, and nothing else (no user, no path past {@code /}, no
 * query, no fragment). It's the member's to give and never the platform's: the desk connects out to it, and it's sealed
 * with the password, so it's in no row, no answer and no log.
 *
 * <p>{@link #through} names who sits in the middle, for the setup screen and Accounts: a host under
 * {@code trycloudflare.com} or {@code cfargotunnel.com} is Cloudflare's tunnel, {@code ngrok-free.app}, {@code ngrok.app},
 * {@code ngrok.io}, {@code ngrok-free.dev} or {@code ngrok.dev} is ngrok's, {@code zrok.io} is zrok's, and anything else is
 * the member's own address. Each of the three unlocks the connection's TLS on its own servers, so it could read the
 * messages; the setup screen says so.
 */
public record MacAddress(String host, int port, boolean tls) {

    /** Through the member's own address: a port forward or their own domain, TLS end to end. */
    public static final String OWN = "own";
    public static final String CLOUDFLARE = "cloudflare";
    public static final String NGROK = "ngrok";
    public static final String ZROK = "zrok";

    /** The longest address the form takes. */
    public static final int MAX_LENGTH = 300;

    /** Why an address was refused: a word for the office ({@code https}, {@code address}). */
    public static final class Bad extends Exception {
        private static final long serialVersionUID = 1L;
        private final String reason;

        Bad(String reason) {
            super(reason, null, false, false);
            this.reason = reason;
        }

        public String reason() {
            return reason;
        }
    }

    /**
     * The address as the member gave it, checked. A missing scheme is taken as {@code https://}; {@code http://} is refused
     * ({@code https}) unless {@code plainForTests}, which only a test passes.
     *
     * @throws Bad {@code https} (not HTTPS) or {@code address} (anything else wrong with it)
     */
    public static MacAddress parse(String text, boolean plainForTests) throws Bad {
        if (text == null) {
            throw new Bad("address");
        }
        String t = text.strip();
        if (t.isEmpty() || t.length() > MAX_LENGTH || t.chars().anyMatch(c -> c <= 0x20 || c >= 0x7F)) {
            throw new Bad("address");
        }
        if (!t.contains("://")) {
            t = "https://" + t;
        }
        URI u;
        try {
            u = new URI(t);
        } catch (URISyntaxException e) {
            throw new Bad("address");
        }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        boolean tls;
        if (scheme.equals("https")) {
            tls = true;
        } else if (scheme.equals("http") && plainForTests) {
            tls = false;
        } else if (scheme.equals("http")) {
            throw new Bad("https");
        } else {
            throw new Bad("address");
        }
        if (u.getRawUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null || u.getHost() == null) {
            throw new Bad("address");
        }
        String path = u.getRawPath();
        if (path != null && !path.isEmpty() && !path.equals("/")) {
            throw new Bad("address");
        }
        String host = u.getHost().toLowerCase(Locale.ROOT);
        while (host.endsWith(".")) {
            host = host.substring(0, host.length() - 1);
        }
        if (host.isEmpty() || host.length() > 253) {
            throw new Bad("address");
        }
        int port = u.getPort() == -1 ? (tls ? 443 : 80) : u.getPort();
        if (port < 1 || port > 65535) {
            throw new Bad("address");
        }
        return new MacAddress(host, port, tls);
    }

    /**
     * The ports a desk may reach a Mac on: 443 and 8443, and 1024 to 65535 (BlueBubbles' own 1234 behind a port forward);
     * never another low port, so a member's address can't make the desk speak to a mail or other service's port.
     */
    public static boolean portAllowed(int port) {
        return port == 443 || port == 8443 || (port >= 1024 && port <= 65535);
    }

    /** Who's in the middle: {@link #OWN}, {@link #CLOUDFLARE}, {@link #NGROK} or {@link #ZROK}. */
    public String through() {
        if (under("trycloudflare.com") || under("cfargotunnel.com")) {
            return CLOUDFLARE;
        }
        if (under("ngrok-free.app") || under("ngrok.app") || under("ngrok.io") || under("ngrok-free.dev") || under("ngrok.dev")) {
            return NGROK;
        }
        if (under("zrok.io")) {
            return ZROK;
        }
        return OWN;
    }

    private boolean under(String domain) {
        return host.endsWith("." + domain);
    }

    /** The address as kept (sealed) and as the transport connects to it. */
    public String url() {
        boolean defaultPort = tls ? port == 443 : port == 80;
        return (tls ? "https://" : "http://") + host + (defaultPort ? "" : ":" + port);
    }

    /** The {@code Host} header's value. */
    String hostHeader() {
        boolean defaultPort = tls ? port == 443 : port == 80;
        return host + (defaultPort ? "" : ":" + port);
    }

    /** A host name for TLS's SNI and its certificate check; null for an IP literal, which has neither. */
    String sniName() {
        return host.startsWith("[") || host.matches("[0-9.]+") ? null : host;
    }

    /** No address in a log. */
    @Override
    public String toString() {
        return "MacAddress[" + through() + "]";
    }
}
