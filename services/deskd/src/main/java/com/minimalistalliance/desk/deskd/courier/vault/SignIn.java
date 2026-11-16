package com.minimalistalliance.desk.deskd.courier.vault;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Set;

/**
 * A linked mailbox's sign-in (the launch plan §3.6): what a transport needs to reach the member's own provider, and
 * nothing deskd shows. Held as bytes, so it can be zeroed: {@link #close} does, and every holder closes it as soon as it's
 * done. {@link #toString} names only its kind.
 * <ul>
 * <li>{@code password} and {@code app_password}: the user name and the password the provider gave (an app-specific one
 *     for Gmail, iCloud and Yahoo).</li>
 * <li>{@code oauth}: the access token, the refresh token and when the access token expires (Microsoft's sign-in, and
 *     Google's later).</li>
 * </ul>
 * {@code server} is the account's connection settings as the transport keeps them (a short JSON object: hosts, ports,
 * security), not secret, sealed beside the rest so one file has everything a transport needs. It's the transport's
 * (Wave 2.1) to define; this only carries it.
 *
 * <p>Its sealed form ({@link #encode}): a version byte (1), the kind, then the user name, the secret, the refresh token
 * and the server settings, each after its length, and the expiry in milliseconds.
 */
public final class SignIn implements AutoCloseable {

    public static final String PASSWORD = "password";
    public static final String APP_PASSWORD = "app_password";
    public static final String OAUTH = "oauth";
    public static final Set<String> KINDS = Set.of(PASSWORD, APP_PASSWORD, OAUTH);

    static final int MAX_USERNAME = 320;
    static final int MAX_SECRET = 8192;
    static final int MAX_SERVER = 4096;
    /** The most an encoded sign-in can be. */
    static final int MAX_ENCODED = 1 + 1 + 2 + MAX_USERNAME * 4 + 4 + MAX_SECRET + 4 + MAX_SECRET + 2 + MAX_SERVER * 4 + 8;
    private static final byte VERSION = 1;

    private final String kind;
    private final String username;
    private final byte[] secret;
    private final byte[] refresh;
    private final long expiresAt;
    private final String server;

    /**
     * Takes the arrays as they are, without copying: the caller passes ownership, and {@link #close} zeroes them.
     *
     * @throws IllegalArgumentException with a word ({@code kind}, {@code username}, {@code secret}, {@code server}) for what's
     *     out of bounds, after zeroing what it was given
     */
    public SignIn(String kind, String username, byte[] secret, byte[] refresh, long expiresAt, String server) {
        this.kind = kind;
        this.username = username;
        this.secret = secret == null ? new byte[0] : secret;
        this.refresh = refresh == null ? new byte[0] : refresh;
        this.expiresAt = expiresAt;
        this.server = server;
        String bad = null;
        if (!KINDS.contains(kind)) {
            bad = "kind";
        } else if (username == null || username.isBlank() || username.length() > MAX_USERNAME || hasControls(username)) {
            bad = "username";
        } else if (this.secret.length == 0 || this.secret.length > MAX_SECRET || this.refresh.length > MAX_SECRET
                || !OAUTH.equals(kind) && this.refresh.length > 0) {
            bad = "secret";
        } else if (server != null && (server.length() > MAX_SERVER || hasControls(server))) {
            bad = "server";
        }
        if (bad != null) {
            close();
            throw new IllegalArgumentException(bad);
        }
    }

    private static boolean hasControls(String s) {
        return s.chars().anyMatch(c -> c < 0x20 || c == 0x7F);
    }

    public String kind() {
        return kind;
    }

    public String username() {
        return username;
    }

    /** The password or access token itself, not a copy: read it, don't keep it. Zeroed by {@link #close}. */
    public byte[] secret() {
        return secret;
    }

    /** The refresh token (OAuth only), not a copy; empty otherwise. */
    public byte[] refresh() {
        return refresh;
    }

    /** When an OAuth access token expires, in epoch milliseconds; 0 when it doesn't say. */
    public long expiresAt() {
        return expiresAt;
    }

    public String server() {
        return server;
    }

    /** The sealed form, which the caller zeroes once sealed. */
    byte[] encode() {
        byte[] user = username.getBytes(StandardCharsets.UTF_8);
        byte[] srv = server == null ? new byte[0] : server.getBytes(StandardCharsets.UTF_8);
        ByteBuffer b = ByteBuffer.allocate(1 + 1 + 2 + user.length + 4 + secret.length + 4 + refresh.length + 2 + srv.length + 8);
        b.put(VERSION).put(kindByte(kind)).putShort((short) user.length).put(user).putInt(secret.length).put(secret)
                .putInt(refresh.length).put(refresh).putShort((short) srv.length).put(srv).putLong(expiresAt);
        return b.array();
    }

    /**
     * A sign-in from its sealed form, which the caller zeroes after.
     *
     * @throws IllegalArgumentException if it isn't one this deskd knows, saying no more than that
     */
    static SignIn decode(byte[] bytes) {
        try {
            ByteBuffer b = ByteBuffer.wrap(bytes);
            if (b.get() != VERSION) {
                throw new IllegalArgumentException("version");
            }
            String kind = kindOf(b.get());
            String user = new String(take(b, b.getShort() & 0xFFFF), StandardCharsets.UTF_8);
            byte[] secret = take(b, b.getInt());
            byte[] refresh = take(b, b.getInt());
            byte[] srv = take(b, b.getShort() & 0xFFFF);
            long expires = b.getLong();
            if (b.hasRemaining()) {
                Arrays.fill(secret, (byte) 0);
                Arrays.fill(refresh, (byte) 0);
                throw new IllegalArgumentException("length");
            }
            return new SignIn(kind, user, secret, refresh, expires, srv.length == 0 ? null : new String(srv, StandardCharsets.UTF_8));
        } catch (java.nio.BufferUnderflowException | NegativeArraySizeException e) {
            throw new IllegalArgumentException("length");
        }
    }

    private static byte[] take(ByteBuffer b, int n) {
        if (n < 0 || n > b.remaining() || n > MAX_SECRET * 4) {
            throw new IllegalArgumentException("length");
        }
        byte[] out = new byte[n];
        b.get(out);
        return out;
    }

    private static byte kindByte(String kind) {
        return switch (kind) {
            case PASSWORD -> 1;
            case APP_PASSWORD -> 2;
            default -> 3;
        };
    }

    private static String kindOf(byte b) {
        return switch (b) {
            case 1 -> PASSWORD;
            case 2 -> APP_PASSWORD;
            case 3 -> OAUTH;
            default -> throw new IllegalArgumentException("kind");
        };
    }

    /** Zeroes the secret and the refresh token. Safe to call twice. */
    @Override
    public void close() {
        Arrays.fill(secret, (byte) 0);
        Arrays.fill(refresh, (byte) 0);
    }

    @Override
    public String toString() {
        return "SignIn[" + kind + "]";
    }
}
