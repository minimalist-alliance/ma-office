package com.minimalistalliance.desk.deskd.courier.imsg.connector;

import com.minimalistalliance.desk.courier.envelope.BoxKeyPair;
import com.minimalistalliance.desk.courier.envelope.Drop;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgPath;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgTransport;
import com.minimalistalliance.desk.deskd.courier.relay.DeviceInbox;
import com.minimalistalliance.desk.deskd.courier.relay.RelayApi;
import com.minimalistalliance.desk.deskd.courier.store.Accounts;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.RelayState;
import com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.SecureRandom;
import java.sql.SQLException;
import java.time.Clock;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * MA Connector for Mac on the desk (the draft ADR "Courier's Mac connector"): pairing with the code the member types into
 * Courier ({@code courier.imsg.pair}), the paired devices' envelopes from the relay's drain ({@link DeviceInbox}), and the
 * {@code connector} path the {@code imsg} seam opens for each paired Mac's account.
 *
 * <p>The member confirms on their office: the code shows on the Mac, the member types it into Courier on the desk that
 * should get their texts, and this desk claims it (relay.md 0.4.3), which binds the device to this desk and its member. The
 * device's public keys are pinned in the account's sealed sign-in, and the Mac learns this desk's from the platform; the
 * platform carries only sealed envelopes between them.
 */
public final class ConnectorLinks implements DeviceInbox {

    private static final Logger log = LoggerFactory.getLogger(ConnectorLinks.class);
    static final String ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
    /** How often an envelope from a device with no account here may make the desk forget that device on the platform. */
    static final long FORGET_EVERY = 3600_000L;

    private final CourierModule module;
    private final RelayApi api;
    private final Clock clock;
    private final ConnectorPath.Settings settings;
    private final Map<String, ConnectorPath> byDevice = new ConcurrentHashMap<>();
    private final Map<String, Long> forgotten = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private volatile Supplier<Runnable> drainer = () -> () -> {};
    private volatile ImsgTransport transport;

    public ConnectorLinks(CourierModule module, RelayApi api, Clock clock, ConnectorPath.Settings settings) {
        this.module = module;
        this.api = api;
        this.clock = clock;
        this.settings = settings;
    }

    /** The {@code connector} path's factory, for {@link ImsgTransport#register}. */
    public ImsgPath.Factory factory() {
        return ctx -> new ConnectorPath(ctx, this, settings);
    }

    /** The seam's transport, for a new account's start ({@code added}). */
    public ConnectorLinks transport(ImsgTransport t) {
        this.transport = t;
        return this;
    }

    /** How to ask the relay's transport for a drain soon (a send waiting on its answer). */
    public ConnectorLinks drainWith(Runnable drainSoon) {
        this.drainer = () -> drainSoon;
        return this;
    }

    public void registerMethods(RpcDispatcher d) {
        d.registerMutation("courier.imsg.pair", this::pair);
    }

    // ---- for the paths

    RelayApi api() {
        return api;
    }

    RelayState state() {
        return module.store().relay();
    }

    IdentityKeyPair identity() {
        return module.keys() == null ? null : module.keys().identity();
    }

    List<BoxKeyPair> boxKeys() {
        return module.keys() == null ? List.of() : module.keys().recipient().boxKeys();
    }

    void drainSoon() {
        drainer.get().run();
    }

    void attach(ConnectorPath p) {
        ConnectorPath.Device d = p.device();
        if (d != null) {
            byDevice.put(d.deviceId(), p);
        }
    }

    void detach(ConnectorPath p) {
        ConnectorPath.Device d = p.device();
        if (d != null) {
            byDevice.remove(d.deviceId(), p);
        }
    }

    /** The platform forgets a device: its row, its key and its inbox (relay.md 0.4.3 A.6). */
    void forget(String deviceId) {
        try {
            api.deleteDevice(deviceId);
        } catch (IOException e) {
            log.warn("courier mac: the platform didn't forget a device ({})", e.getClass().getSimpleName());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Whether the platform still lists the device for this desk; true when it can't be asked. */
    boolean stillPaired(String deviceId) {
        try {
            Map<String, Object> k = api.ownKeys();
            if (k.get("devices") instanceof List<?> l) {
                for (Object o : l) {
                    if (o instanceof Map<?, ?> m && deviceId.equals(m.get("deviceId"))) {
                        return true;
                    }
                }
                return false;
            }
            return true;
        } catch (IOException e) {
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return true;
        }
    }

    Outcome refuse(String relayId, String reason) {
        try {
            state().tombstone("relay", relayId, clock.millis() + ConnectorPath.UP_WAIT + ConnectorPath.SKEW);
        } catch (SQLException e) {
            // Refused anyway: a copy is opened and refused again.
        }
        log.debug("courier mac: an envelope refused ({})", reason);
        return Outcome.ACK;
    }

    /**
     * A drop named in a verified payload, read from the envelope's own link and checked against the reference (its size, its
     * key, its digest) before any byte is used; at most {@code max} bytes of body.
     */
    byte[] download(Map<String, Object> ref, Map<String, Object> envelope, long max) throws IOException, InterruptedException {
        Object id = ref.get("id");
        Object len = ref.get("len");
        if (!(len instanceof Number n) || n.longValue() <= 0 || n.longValue() > max) {
            throw new com.minimalistalliance.desk.deskd.courier.imsg.ImsgSink.TooLarge();
        }
        if (envelope.get("drops") instanceof List<?> drops) {
            for (Object o : drops) {
                if (o instanceof Map<?, ?> d && id != null && id.equals(d.get("dropId"))) {
                    if (!(d.get("url") instanceof String url) || !(d.get("bytes") instanceof Number bytes)) {
                        // Not issued today (the relay's daily cap): the envelope waits for tomorrow's.
                        throw new IOException("no link today");
                    }
                    ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(n.longValue(), 1 << 20));
                    try (InputStream in = api.download(url, bytes.longValue())) {
                        Drop.open(ref, bytes.longValue(), in, out);
                    } catch (EnvelopeException e) {
                        throw new IOException("the drop didn't check out");
                    }
                    return out.toByteArray();
                }
            }
        }
        throw new IOException("the drop isn't this envelope's");
    }

    // ---- the drain

    @Override
    public boolean any() {
        return !byDevice.isEmpty();
    }

    @Override
    public Outcome take(String relayId, Map<String, Object> envelope, Courier.Origin origin) throws InterruptedException {
        String to = envelope.get("to") instanceof String t ? t : "";
        ConnectorPath p = byDevice.get(to);
        if (p != null) {
            return p.take(relayId, envelope);
        }
        if (!com.minimalistalliance.desk.courier.envelope.DeviceEnvelope.DEVICE_ID.matcher(to).matches()) {
            return refuse(relayId, "device");
        }
        // No path for this device. If an account here still names it, its path is starting: wait. Otherwise it's a device
        // whose account was removed (or never kept): the platform forgets it, so the Mac stops and forgets too.
        if (namedByAnAccount(to)) {
            return Outcome.WAIT;
        }
        long now = clock.millis();
        Long last = forgotten.get(to);
        if (last == null || now - last > FORGET_EVERY) {
            forgotten.put(to, now);
            if (forgotten.size() > 100) {
                forgotten.clear();
            }
            Thread.ofVirtual().name("courier-mac-forget").start(() -> forget(to));
        }
        return refuse(relayId, "unknown_device");
    }

    @Override
    public void devicesChanged() {
        for (ConnectorPath p : byDevice.values()) {
            p.poke();
        }
    }

    private boolean namedByAnAccount(String deviceId) {
        LinkedAccounts linked = module.linkedAccounts();
        if (linked == null || module.store() == null) {
            return false;
        }
        try {
            for (Courier.Account a : module.store().accounts()) {
                if (Accounts.IMESSAGE.equals(a.kind())) {
                    try (SignIn s = linked.open(a.id())) {
                        if (s.server() != null && s.server().contains("\"" + deviceId + "\"")) {
                            return true;
                        }
                    } catch (IOException e) {
                        // Unreadable: not this one.
                    }
                }
            }
        } catch (SQLException e) {
            return true;
        }
        return false;
    }

    // ---- pairing: courier.imsg.pair {code}

    /** The code as the member typed it: upper case, spaces and dashes gone; 8 of the platform's alphabet, or null. */
    static String normalCode(String code) {
        if (code == null || code.length() > 24) {
            return null;
        }
        String c = code.toUpperCase(Locale.ROOT).replace("-", "").replace(" ", "");
        if (c.length() != 8) {
            return null;
        }
        for (int i = 0; i < c.length(); i++) {
            if (ALPHABET.indexOf(c.charAt(i)) < 0) {
                return null;
            }
        }
        return c;
    }

    /**
     * {@code courier.imsg.pair {code}}: claims the code the Mac shows (relay.md 0.4.3), pins the Mac's keys in a new iMessage
     * account's sealed sign-in ({@code path: connector}), and starts its path, which says hello to the Mac. One Mac a desk.
     *
     * @return {@code {accountId, fingerprint}}: the Mac's key's first two groups, which the Mac shows too
     */
    Object pair(RpcContext context, Map<String, Object> params) throws Exception {
        RpcException no = module.refusal();
        if (no != null) {
            throw no;
        }
        LinkedAccounts linked = module.linkedAccounts();
        ImsgTransport t = transport;
        if (module.store() == null || linked == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "Courier's store can't be used", Map.of("reason", "store"));
        }
        if (t == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "iMessage isn't here yet", Map.of("reason", "medium"));
        }
        if (!module.courierSwitch().channelOn(Accounts.IMESSAGE)) {
            throw new RpcException(RpcException.UNAVAILABLE, "iMessage is switched off on this desk", Map.of("reason", "switched_off"));
        }
        if (identity() == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "This desk's keys can't be used", Map.of("reason", "keys"));
        }
        String code = normalCode(params.get("code") instanceof String c ? c : null);
        if (code == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "That isn't a code from MA Connector", Map.of("reason", "code"));
        }
        try {
            linked.room(Accounts.IMESSAGE);
        } catch (LinkedAccounts.Refused r) {
            throw new RpcException(RpcException.CONFLICT, "This desk has a Mac already", Map.of("reason", "too_many"));
        }
        Map<String, Object> claim;
        try {
            claim = api.claimDevice(code);
        } catch (RelayApi.Refused r) {
            String c = r.code() == null ? "" : r.code();
            throw switch (c) {
                case "pairing_unknown", "not_found" -> new RpcException(RpcException.NOT_FOUND, "That code isn't waiting", Map.of("reason", "code"));
                case "invalid_request" -> new RpcException(RpcException.BAD_REQUEST, "That isn't a code from MA Connector", Map.of("reason", "code"));
                case "device_limit" -> new RpcException(RpcException.CONFLICT, "This desk has as many devices as it can", Map.of("reason", "too_many"));
                case "rate_limited" -> new RpcException(RpcException.RATE_LIMITED, "Too many codes for now", Map.of("reason", "rate_limited"));
                case "courier_teen" -> new RpcException(RpcException.FORBIDDEN, "Courier isn't available on this account", Map.of("reason", "teen"));
                case "courier_paused" -> new RpcException(RpcException.UNAVAILABLE, "Courier is paused", Map.of("reason", "paused"));
                default -> new RpcException(RpcException.UNAVAILABLE, "The platform can't be reached", Map.of("reason", "unreachable"));
            };
        } catch (IOException e) {
            throw new RpcException(RpcException.UNAVAILABLE, "The platform can't be reached", Map.of("reason", "unreachable"));
        }
        String deviceId = claim.get("deviceId") instanceof String d ? d : "";
        PublishedKeys keys;
        try {
            if (!com.minimalistalliance.desk.courier.envelope.DeviceEnvelope.DEVICE_ID.matcher(deviceId).matches()
                    || !"mac".equals(claim.get("kind"))) {
                throw new EnvelopeException(EnvelopeException.FORMAT, "not a Mac");
            }
            keys = PublishedKeys.fromJson(Map.of("identityKey", claim.get("identityKey"), "boxKey", claim.get("boxKey"), "binding",
                    claim.get("binding")));
            if (!keys.bindingValid()) {
                throw new EnvelopeException(EnvelopeException.FORMAT, "binding");
            }
        } catch (EnvelopeException | NullPointerException e) {
            // A claim whose keys don't check out isn't kept anywhere, and the platform forgets the device.
            if (com.minimalistalliance.desk.courier.envelope.DeviceEnvelope.DEVICE_ID.matcher(deviceId).matches()) {
                forget(deviceId);
            }
            throw new RpcException(RpcException.UNAVAILABLE, "The Mac's keys don't check out", Map.of("reason", "keys_invalid"));
        }
        Map<String, Object> server = new LinkedHashMap<>();
        server.put("path", ConnectorPath.PATH);
        server.put("deviceId", deviceId);
        server.put("identityKey", keys.identityKey().text());
        server.put("boxKey", keys.boxKey().text());
        server.put("fingerprint", keys.fingerprint());
        server.put("pairedAt", clock.millis());
        String accountId = "imessage-" + HexFormat.of().formatHex(bytes(10));
        Courier.Account account = new Courier.Account(accountId, Accounts.IMESSAGE, "Mac", null, "ok");
        // No password exists for a paired Mac: the sealed sign-in carries the pinned keys, and a random filler as its secret.
        try (SignIn signIn = new SignIn(SignIn.PASSWORD, deviceId, bytes(32), null, 0,
                new String(Json.bytes(server), java.nio.charset.StandardCharsets.UTF_8))) {
            context.beginEffect();
            linked.keep(account, List.of(), signIn);
        } catch (LinkedAccounts.Refused r) {
            forget(deviceId);
            throw switch (r.reason()) {
                case "too_many", "exists" -> new RpcException(RpcException.CONFLICT, "This desk has a Mac already", Map.of("reason", r.reason()));
                default -> new RpcException(RpcException.UNAVAILABLE, "The pairing couldn't be kept", Map.of("reason", "storage"));
            };
        }
        t.added(accountId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("accountId", accountId);
        out.put("fingerprint", shortFingerprint(keys.fingerprint()));
        String check = check(keys.identityKey());
        if (check != null) {
            out.put("check", check);
        }
        return out;
    }

    /**
     * The number the office and the Mac both show for a pairing (Security MC-L1, MC-I1): SHA-256 over
     * {@code "ma-device-pair/v1\n" || this desk's identity || the device's identity}, its first 5 bytes as a number below
     * 10^12, in three groups of four digits. If the platform handed either side a key of its own, the two differ. The Mac's
     * {@code PairCheck} computes the same.
     */
    String check(com.minimalistalliance.desk.courier.envelope.IdentityKey device) {
        IdentityKeyPair me = identity();
        return me == null || device == null ? null : checkNumber(me.publicKey().bytes(), device.bytes());
    }

    static String checkNumber(byte[] desk, byte[] device) {
        try {
            java.security.MessageDigest h = java.security.MessageDigest.getInstance("SHA-256");
            h.update("ma-device-pair/v1\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            h.update(desk);
            h.update(device);
            byte[] d = h.digest();
            long n = 0;
            for (int i = 0; i < 5; i++) {
                n = (n << 8) | (d[i] & 0xff);
            }
            String s = String.format("%012d", n % 1_000_000_000_000L);
            return s.substring(0, 4) + " " + s.substring(4, 8) + " " + s.substring(8);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static String shortFingerprint(String fp) {
        String[] g = fp == null ? new String[0] : fp.split("-");
        return g.length >= 2 ? g[0] + "-" + g[1] : fp;
    }

    private byte[] bytes(int n) {
        byte[] b = new byte[n];
        random.nextBytes(b);
        return b;
    }

    /** Strict base64url without padding, at most {@code max} bytes; null for anything else. */
    static byte[] b64(Object o, int max) {
        if (!(o instanceof String s) || s.isEmpty() || s.length() > (max * 4 + 2) / 3 + 1 || !s.matches("[A-Za-z0-9_-]+")) {
            return null;
        }
        try {
            byte[] b = Base64.getUrlDecoder().decode(s);
            return b.length <= max && Base64.getUrlEncoder().withoutPadding().encodeToString(b).equals(s) ? b : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
