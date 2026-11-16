package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKey;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.SafetyNumber;
import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.store.Accounts;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.RelayState;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcHandler;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The desk's transports through Platform's relay (the launch plan's Wave 2.5; draft ADR "Courier's transports"): mail to
 * the desk's own address, sealed by the mail door, and sealed messages between members' desks ({@code ma}), both
 * collected from the relay; sending from the desk's address through {@code courier-send}, and to members sealed.
 *
 * <ul>
 *   <li><b>When it collects:</b> when deskd starts (a desk waking), on the gateway's {@code notify relay} push, and every
 *       10 minutes while it runs, as a fallback for a lost push (contract §3.4). <b>Nothing here ever wakes a desk</b>:
 *       a sleeping desk's mail waits sealed in the relay, and the platform shows the count.
 *   <li><b>Its accounts</b> in the store: {@value #DESK_ACCOUNT} (kind {@code desk}, the desk's address as email) and
 *       {@value #MA_ACCOUNT} (kind {@code ma}), from {@code GET /v1/agent/courier-addresses} at start and on
 *       {@code notify relay {reason: address}}; the desk's closed addresses stay its own.
 *   <li><b>Kill switches</b> in Courier's switch file: {@code ma-off} (members' messages both ways; their envelopes wait in
 *       the relay), {@code ma-send-off}; {@code door-off} (the desk's address both ways), {@code door-send-off},
 *       {@code email-off} (all email, this included); {@code send-off} and {@code off}, as for every transport.
 *   <li><b>Methods</b> (API.md §21, "The desk's address and members' messages"): {@code courier.address},
 *       {@code courier.invite.open}, {@code courier.contact.keys}, {@code courier.contact.verify},
 *       {@code courier.compose.pick}.
 * </ul>
 */
public final class RelayTransport implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(RelayTransport.class);

    /** The store's account for the desk's own address (email through the mail door and {@code courier-send}). */
    public static final String DESK_ACCOUNT = "desk";
    /** The store's account for sealed messages between members' desks. */
    public static final String MA_ACCOUNT = "ma";
    static final String MA_CHANNEL = "ma";
    static final String DOOR_CHANNEL = "door";
    private static final Pattern ID = Pattern.compile("[0-9A-HJKMNP-TV-Z]{26}");
    private static final Pattern SAFETY = Pattern.compile("\\d{5}(?: \\d{5}){11}");

    /** Timings: the poll (contract §3.4: every 10 minutes), and the longest wait after a failed drain. */
    public record Settings(Duration poll, Duration retryMin, Duration retryMax) {
        public static final Settings DEFAULT = new Settings(Duration.ofMinutes(10), Duration.ofSeconds(15), Duration.ofMinutes(10));
    }

    private final CourierModule module;
    private final CourierStore store;
    private final DeskKeys keys;
    private final RelayApi api;
    private final CourierSend courierSend;
    private final Clock clock;
    private final Settings settings;
    private final Pins pins;
    private final Drain drain;
    private final Drain.Counts counts = new Drain.Counts();
    private final Senders senders;
    private final ScheduledExecutorService worker;
    private final AtomicBoolean drainQueued = new AtomicBoolean();
    private final java.util.concurrent.locks.ReentrantLock drainLock = new java.util.concurrent.locks.ReentrantLock();
    private final AtomicBoolean addressesStale = new AtomicBoolean(true);
    private volatile boolean closed;
    private volatile boolean started;

    // What the platform said about this desk's addresses (and, proposed for 0.4.1, the door's keys and sending).
    private volatile String domain;
    private volatile String address;
    private volatile List<String> closedAddresses = List.of();
    private volatile List<IdentityKey> doorKeys = List.of();
    private volatile boolean sendingAvailable;
    private volatile long lastAddressRead = Long.MIN_VALUE / 2;
    /** How often a door-key miss may make the desk read its addresses again. */
    static final Duration DOOR_KEY_REREAD = Duration.ofMinutes(5);
    private volatile boolean maRegistered;
    private volatile boolean deskRegistered;

    // The relay as last seen.
    private volatile long lastDrainAt = -1;
    private volatile Integer pending;
    private volatile String problem;
    private volatile int failures;
    private volatile ScheduledFuture<?> retry;

    public RelayTransport(CourierModule module, RelayApi api, CourierSend courierSend, Clock clock, Settings settings) {
        this.module = module;
        this.store = module.store();
        this.keys = module.keys();
        this.api = api;
        this.courierSend = courierSend == null ? CourierSend.NONE : courierSend;
        this.clock = clock;
        this.settings = settings;
        this.pins = store == null ? null : new Pins(store.relay(), api, clock);
        this.drain = store == null ? null : new Drain(drainContext(), counts);
        this.senders = new Senders(senderContext());
        this.worker = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "courier-relay");
            t.setDaemon(true);
            return t;
        });
    }

    /**
     * Registers the methods, reads what this desk last knew of its addresses, and starts collecting. Inert without a store
     * or keys (an image without {@code /data/courier} or {@code /data/keys}): the methods answer {@code unavailable}.
     *
     * @return this
     */
    public RelayTransport start(RpcDispatcher dispatcher) {
        registerMethods(dispatcher);
        if (store == null || keys == null || !keys.available()) {
            problem = "keys";
            return this;
        }
        loadAddresses();
        module.attachRelay(this);
        started = true;
        worker.execute(() -> runDrain(Courier.Origin.CATCHUP));
        long poll = Math.max(1000, settings.poll().toMillis());
        worker.scheduleWithFixedDelay(() -> requestDrain(Courier.Origin.LIVE), poll, poll, TimeUnit.MILLISECONDS);
        return this;
    }

    /**
     * {@code notify relay} from the gateway: {@code envelopes} collects now; {@code address} reads the addresses first;
     * {@code devices} (relay.md 0.4.3) tells the device paths a device was removed elsewhere.
     */
    public void notify(String reason) {
        if (!started || closed) {
            return;
        }
        if ("address".equals(reason)) {
            addressesStale.set(true);
        }
        DeviceInbox d = devices;
        if ("devices".equals(reason) && d != null) {
            d.devicesChanged();
        }
        requestDrain(Courier.Origin.LIVE);
    }

    private volatile DeviceInbox devices;

    /** Paired devices' envelopes (MA Connector for Mac) go here; collected in the same drain as the rest. */
    public RelayTransport devicesThrough(DeviceInbox inbox) {
        this.devices = inbox;
        return this;
    }

    /** A drain soon, for a device path waiting on its device's answer (coalesced with any already asked for). */
    public void drainSoon() {
        if (started && !closed) {
            requestDrain(Courier.Origin.LIVE);
        }
    }

    /** Asks for a drain soon, coalescing: one queued at a time. */
    void requestDrain(Courier.Origin origin) {
        if (closed || !drainQueued.compareAndSet(false, true)) {
            return;
        }
        try {
            worker.execute(() -> runDrain(origin));
        } catch (java.util.concurrent.RejectedExecutionException e) {
            drainQueued.set(false);
        }
    }

    /**
     * Drains now on the caller's thread (tests, and the staging proof): the addresses if stale, then everything waiting.
     *
     * @return {@code {fetched, acked, waiting, pending, problem}}
     */
    public Map<String, Object> drainNow() throws IOException, InterruptedException, SQLException {
        if (addressesStale.get()) {
            refreshAddresses();
        }
        Drain.Result r = drainOnce(Courier.Origin.LIVE);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("fetched", r.fetched());
        m.put("acked", r.acked());
        m.put("waiting", r.waiting());
        m.put("pending", r.pending());
        m.put("problem", r.problem());
        return m;
    }

    private void runDrain(Courier.Origin origin) {
        drainQueued.set(false);
        if (closed) {
            return;
        }
        try {
            if (addressesStale.get()) {
                refreshAddresses();
            }
            drainOnce(origin);
            failures = 0;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RelayApi.Refused e) {
            problem = e.code() == null ? "http_" + e.status() : e.code();
            scheduleRetry(e.retryAfter());
        } catch (IOException e) {
            problem = "unreachable";
            scheduleRetry(null);
        } catch (SQLException | RuntimeException e) {
            problem = "storage";
            log.warn("courier relay: a drain failed ({})", e.getClass().getSimpleName());
            scheduleRetry(null);
        }
    }

    private Drain.Result drainOnce(Courier.Origin origin) throws IOException, InterruptedException, SQLException {
        DeviceInbox d = devices;
        if (!module.usable() || (!maOn() && !doorOn() && (d == null || !d.any()))) {
            problem = module.usable() ? "switched_off" : "courier";
            return new Drain.Result(0, 0, 0, null, problem);
        }
        // One drain at a time (the push, the poll and a wake can meet): a second waits for the first, then collects what's left.
        Drain.Result r;
        drainLock.lockInterruptibly();
        try {
            r = drain.run(origin);
        } finally {
            drainLock.unlock();
        }
        lastDrainAt = clock.millis();
        if (r.pending() != null) {
            pending = r.pending();
        }
        problem = r.problem() != null ? r.problem() : r.waiting() > 0 ? "waiting" : null;
        if (addressesStale.get()) {
            // The door's key changed under a drain: read the addresses and collect again soon.
            scheduleRetry(Duration.ofSeconds(1));
        }
        return r;
    }

    private void scheduleRetry(Duration after) {
        if (closed) {
            return;
        }
        int n = Math.min(failures++, 10);
        long base = settings.retryMin().toMillis() << Math.min(n, 6);
        long wait = Math.min(settings.retryMax().toMillis(), base);
        if (after != null) {
            wait = Math.max(Math.min(after.toMillis(), settings.retryMax().toMillis()), 500);
        }
        ScheduledFuture<?> old = retry;
        if (old != null) {
            old.cancel(false);
        }
        try {
            retry = worker.schedule(() -> requestDrain(Courier.Origin.LIVE), wait, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.RejectedExecutionException e) {
            // Closing.
        }
    }

    // ---- addresses

    /** Reads {@code GET /v1/agent/courier-addresses} and applies it: keys, accounts, senders, and what's kept for a restart. */
    void refreshAddresses() throws IOException, InterruptedException, SQLException {
        Map<String, Object> answer = api.addresses();
        lastAddressRead = clock.millis();
        apply(answer);
        addressesStale.set(false);
        try {
            store.accept(List.of(), new Courier.CursorUpdate(MA_ACCOUNT, "addresses", new String(Json.bytes(answer), StandardCharsets.UTF_8)));
        } catch (IOException | SQLException e) {
            log.warn("courier relay: the addresses couldn't be kept ({})", e.getClass().getSimpleName());
        }
    }

    private void loadAddresses() {
        try {
            String kept = store.cursor(MA_ACCOUNT, "addresses");
            if (kept != null) {
                apply(Json.parseObject(kept.getBytes(StandardCharsets.UTF_8)));
            }
        } catch (SQLException | JsonFormatException | RuntimeException e) {
            log.warn("courier relay: the kept addresses couldn't be read ({})", e.getClass().getSimpleName());
        }
    }

    private void apply(Map<String, Object> answer) throws SQLException {
        String d = answer.get("domain") instanceof String s && s.length() <= 253 ? s.toLowerCase(java.util.Locale.ROOT) : null;
        String open = null;
        if (answer.get("address") instanceof Map<?, ?> a && a.get("address") instanceof String s) {
            open = Invite.canonical(s);
        }
        List<String> closedList = new ArrayList<>();
        if (answer.get("closed") instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof Map<?, ?> c && c.get("address") instanceof String s && Invite.canonical(s) != null) {
                    closedList.add(Invite.canonical(s));
                }
            }
        }
        List<IdentityKey> door = new ArrayList<>();
        if (answer.get("doorKeys") instanceof List<?> l) {
            for (Object o : l) {
                Object k = o instanceof Map<?, ?> m ? m.get("key") : o;
                try {
                    door.add(IdentityKey.parse(k));
                } catch (EnvelopeException | RuntimeException e) {
                    // A door key that doesn't read is left out: mail signed by it waits.
                }
            }
        }
        Object sending = answer.get("sending");
        boolean canSend = sending instanceof Boolean b ? b : sending instanceof Map<?, ?> m && Boolean.TRUE.equals(m.get("available"));
        // An address on another domain than the platform's own isn't this desk's.
        if (open != null && d != null && !open.endsWith("@" + d)) {
            open = null;
        }
        this.domain = d;
        this.address = open;
        this.closedAddresses = List.copyOf(closedList);
        this.doorKeys = List.copyOf(door);
        this.sendingAvailable = canSend;
        keys.addresses(open, closedList);
        List<String> all = new ArrayList<>();
        if (open != null) {
            all.add(open);
        }
        all.addAll(closedList);
        if (!all.isEmpty()) {
            List<String[]> ownEmail = new ArrayList<>();
            List<String[]> ownMa = new ArrayList<>();
            for (String a : all) {
                ownEmail.add(new String[] {"email", a});
                ownMa.add(new String[] {"ma", a});
            }
            String state = open == null ? "no_address" : "ok";
            store.putAccount(new Courier.Account(DESK_ACCOUNT, Accounts.DESK, "This desk's address", open, state), ownEmail);
            store.putAccount(new Courier.Account(MA_ACCOUNT, Accounts.MA, "Messages between desks", open, state), ownMa);
        }
        registerSenders();
    }

    /** The queue's senders exist only while they can send: an address, keys, and (for email) a provider. */
    private void registerSenders() {
        boolean ma = address != null && keys.available();
        if (ma && !maRegistered) {
            store.outbox().register("ma", MA_ACCOUNT, senders::sendMa);
        } else if (!ma && maRegistered) {
            store.outbox().unregister("ma", MA_ACCOUNT);
        }
        maRegistered = ma;
        boolean desk = ma && sendingAvailable && courierSend.available();
        if (desk && !deskRegistered) {
            store.outbox().register("email", DESK_ACCOUNT, senders::sendEmail);
        } else if (!desk && deskRegistered) {
            store.outbox().unregister("email", DESK_ACCOUNT);
        }
        deskRegistered = desk;
    }

    // ---- switches

    boolean maOn() {
        return module.usable() && module.courierSwitch().channelOn(MA_CHANNEL);
    }

    boolean doorOn() {
        return module.usable() && module.courierSwitch().channelOn(DOOR_CHANNEL) && module.courierSwitch().channelOn("email");
    }

    boolean maSending() {
        return maOn() && module.courierSwitch().sending() && module.courierSwitch().channelOn("ma-send");
    }

    boolean doorSending() {
        return doorOn() && module.courierSwitch().sending() && module.courierSwitch().channelOn("door-send");
    }

    // ---- contexts

    private Drain.Context drainContext() {
        return new Drain.Context() {
            @Override
            public RelayApi api() {
                return api;
            }

            @Override
            public RelayState state() {
                return store.relay();
            }

            @Override
            public Pins pins() {
                return pins;
            }

            @Override
            public Envelope.Recipient recipient() {
                return keys.recipient();
            }

            @Override
            public List<String> addresses() {
                List<String> all = new ArrayList<>();
                if (address != null) {
                    all.add(address);
                }
                all.addAll(closedAddresses);
                return all;
            }

            @Override
            public List<IdentityKey> doorKeys() {
                return doorKeys;
            }

            @Override
            public String domain() {
                return domain;
            }

            @Override
            public IdentityKey ownIdentity() {
                IdentityKeyPair me = keys.identity();
                return me == null ? null : me.publicKey();
            }

            @Override
            public boolean maOn() {
                return RelayTransport.this.maOn();
            }

            @Override
            public boolean doorOn() {
                return RelayTransport.this.doorOn();
            }

            @Override
            public long now() {
                return clock.millis();
            }

            @Override
            public DeviceInbox devices() {
                return devices;
            }

            @Override
            public void doorKeyStale() {
                // At most every 5 minutes for a door-key miss: a failing signature mustn't spin the drain (Security CT-L3).
                if (clock.millis() - lastAddressRead >= DOOR_KEY_REREAD.toMillis()) {
                    addressesStale.set(true);
                }
            }
        };
    }

    private Senders.Context senderContext() {
        return new Senders.Context() {
            @Override
            public RelayApi api() {
                return api;
            }

            @Override
            public Pins pins() {
                return pins;
            }

            @Override
            public CourierSend courierSend() {
                return courierSend;
            }

            @Override
            public IdentityKeyPair identity() {
                return keys == null ? null : keys.identity();
            }

            @Override
            public String address() {
                return address;
            }

            @Override
            public String domain() {
                return domain;
            }

            @Override
            public boolean maSending() {
                return RelayTransport.this.maSending();
            }

            @Override
            public boolean doorSending() {
                return RelayTransport.this.doorSending();
            }

            @Override
            public long now() {
                return clock.millis();
            }
        };
    }

    // ---- methods

    private void registerMethods(RpcDispatcher d) {
        d.register("courier.address", guarded(this::addressMethod));
        d.register("courier.contact.keys", guarded(this::contactKeys));
        d.register("courier.compose.pick", guarded(this::composePick));
        d.registerMutation("courier.invite.open", guarded(this::inviteOpen));
        d.registerMutation("courier.contacts.add", guarded(this::contactsAdd));
        d.registerMutation("courier.contact.verify", guarded(this::contactVerify));
    }

    private RpcHandler guarded(RpcHandler h) {
        return (context, params) -> {
            RpcException no = module.refusal();
            if (no != null) {
                throw no;
            }
            if (store == null) {
                throw new RpcException(RpcException.UNAVAILABLE, "Courier's store can't be used", Map.of("reason", "store"));
            }
            return h.handle(context, params);
        };
    }

    private RpcException keysUnavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "This desk's keys can't be used", Map.of("reason", "keys"));
    }

    private static RpcException bad(String reason) {
        return new RpcException(RpcException.BAD_REQUEST, "Not a valid request", Map.of("reason", reason));
    }

    /** {@code courier.address}: the desk's address, its invite link, and the relay's state. */
    private Object addressMethod(com.minimalistalliance.desk.deskd.rpc.RpcContext context, Map<String, Object> params) {
        Map<String, Object> out = new LinkedHashMap<>();
        PublishedKeys mine = keys == null ? null : keys.publicKeys();
        out.put("address", address);
        out.put("domain", domain);
        out.put("closed", closedAddresses);
        out.put("fingerprint", mine == null ? null : mine.fingerprint());
        out.put("invite", address == null || mine == null ? null : Invite.link(address, mine.fingerprint()));
        Map<String, Object> sending = new LinkedHashMap<>();
        sending.put("ma", maRegistered && maSending());
        sending.put("email", deskRegistered && doorSending());
        sending.put("provider", sendingAvailable && courierSend.available());
        out.put("sending", sending);
        out.put("doorKey", !doorKeys.isEmpty());
        Map<String, Object> relay = new LinkedHashMap<>();
        relay.put("state", relayState());
        relay.put("problem", problem);
        relay.put("lastDrainAt", lastDrainAt < 0 ? null : lastDrainAt);
        relay.put("pending", pending);
        relay.putAll(counts.toMap());
        relay.put("waiting", counts.waiting.get());
        out.put("relay", relay);
        return out;
    }

    private String relayState() {
        if (keys == null || !keys.available()) {
            return "keys";
        }
        if (address == null) {
            return closedAddresses.isEmpty() ? "no_address" : "closed";
        }
        if (!maOn() && !doorOn()) {
            return "off";
        }
        if ("courier_paused".equals(problem)) {
            return "paused";
        }
        if ("unreachable".equals(problem) || (problem != null && problem.startsWith("http_"))) {
            return "unreachable";
        }
        return lastDrainAt < 0 ? "starting" : "ok";
    }

    /** {@code courier.contact.keys {contactId} | {address}}: each member address's pin, and its safety number. */
    private Object contactKeys(com.minimalistalliance.desk.deskd.rpc.RpcContext context, Map<String, Object> params) throws Exception {
        List<String> addresses = addressesParam(params);
        List<Object> out = new ArrayList<>();
        for (String a : addresses) {
            out.add(pinView(a));
        }
        return Map.of("keys", out);
    }

    private List<String> addressesParam(Map<String, Object> params) throws Exception {
        Object contact = params.get("contactId");
        Object addr = params.get("address");
        if ((contact == null) == (addr == null)) {
            throw bad("contactId");
        }
        if (contact != null) {
            if (!(contact instanceof String c) || !ID.matcher(c).matches()) {
                throw bad("contactId");
            }
            return store.relay().addressesOf(c);
        }
        String a = addr instanceof String s ? Invite.canonical(s) : null;
        if (a == null) {
            throw bad("address");
        }
        return List.of(a);
    }

    private Map<String, Object> pinView(String address) throws SQLException {
        RelayState.Pin pin = store.relay().pin(address);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("address", address);
        IdentityKeyPair me = keys == null ? null : keys.identity();
        if (pin == null) {
            m.put("state", "none");
            return m;
        }
        m.put("state", pin.state());
        m.put("source", pin.source());
        m.put("identityKey", pin.identityKey());
        IdentityKey pinned = Pins.identity(pin.identityKey());
        m.put("safetyNumber", me == null || pinned == null ? null : SafetyNumber.between(me.publicKey(), pinned));
        m.put("pinnedAt", pin.pinnedAt());
        m.put("verifiedAt", pin.verifiedAt());
        if (RelayState.CHANGED.equals(pin.state())) {
            IdentityKey next = Pins.identity(pin.newIdentityKey());
            m.put("changedAt", pin.changedAt());
            m.put("newIdentityKey", pin.newIdentityKey());
            m.put("newSafetyNumber", me == null || next == null ? null : SafetyNumber.between(me.publicKey(), next));
        }
        m.put("held", store.relay().heldCount(address));
        return m;
    }

    /**
     * {@code courier.contact.verify {address, safetyNumber}}: the member compared the number with their contact. It must be
     * the number for the pinned identity (marked verified), or for a changed pin's new one (the new key is pinned, verified,
     * its held messages go in, and what waited to be sent to them goes). Anything else is {@code conflict}.
     */
    private Object contactVerify(com.minimalistalliance.desk.deskd.rpc.RpcContext context, Map<String, Object> params) throws Exception {
        String a = params.get("address") instanceof String s ? Invite.canonical(s) : null;
        if (a == null) {
            throw bad("address");
        }
        String number = params.get("safetyNumber") instanceof String s ? s.strip() : null;
        if (number == null || !SAFETY.matcher(number).matches()) {
            throw bad("safetyNumber");
        }
        IdentityKeyPair me = keys == null ? null : keys.identity();
        if (me == null) {
            throw keysUnavailable();
        }
        if (a.equals(address) || closedAddresses.contains(a)) {
            throw bad("own");
        }
        RelayState state = store.relay();
        RelayState.Pin pin = state.pin(a);
        long now = clock.millis();
        if (pin == null) {
            // Never in touch yet: the directory's keys, checked by the number before anything is pinned.
            PublishedKeys k = lookup(a);
            if (!SafetyNumber.between(me.publicKey(), k.identityKey()).equals(number)) {
                throw new RpcException(RpcException.CONFLICT, "That safety number doesn't match", Map.of("reason", "safety_number"));
            }
            state.putPin(Pins.newPin(a, k, RelayState.VERIFIED, "safety_number", now));
            return Map.of("state", RelayState.VERIFIED, "released", 0);
        }
        IdentityKey pinned = Pins.identity(pin.identityKey());
        IdentityKey next = Pins.identity(pin.newIdentityKey());
        if (RelayState.CHANGED.equals(pin.state()) && next != null && SafetyNumber.between(me.publicKey(), next).equals(number)) {
            PublishedKeys nk = Pins.newKeysOf(pin);
            if (nk == null) {
                throw new RpcException(RpcException.CONFLICT, "That safety number doesn't match", Map.of("reason", "safety_number"));
            }
            state.putPin(new RelayState.Pin(a, nk.identityKey().text(), nk.boxKey().text(), Pins.b64(nk.binding()), nk.keysVersion(), null,
                    RelayState.VERIFIED, "safety_number", null, null, null, null, pin.pinnedAt(), now, null, now));
            int released = release(a, nk.identityKey().text());
            state.keyChecked();
            store.outbox().poke();
            return Map.of("state", RelayState.VERIFIED, "released", released);
        }
        if (pinned != null && SafetyNumber.between(me.publicKey(), pinned).equals(number)) {
            // The pinned identity, checked. A change shown meanwhile isn't the contact's: its held messages go.
            if (RelayState.CHANGED.equals(pin.state())) {
                state.dropHeld(a, pin.identityKey());
            }
            state.putPin(new RelayState.Pin(a, pin.identityKey(), pin.boxKey(), pin.binding(), pin.keysVersion(), pin.oldBoxKeys(),
                    RelayState.VERIFIED, pin.source(), null, null, null, null, pin.pinnedAt(), now, null, pin.lookedUpAt()));
            int released = release(a, pin.identityKey());
            state.keyChecked();
            store.outbox().poke();
            return Map.of("state", RelayState.VERIFIED, "released", released);
        }
        throw new RpcException(RpcException.CONFLICT, "That safety number doesn't match", Map.of("reason", "safety_number"));
    }

    /** Puts the held messages signed by {@code identityKey} in the store, as they came; the rest of that address's go. */
    int release(String address, String identityKey) throws SQLException, IOException, InterruptedException {
        RelayState state = store.relay();
        List<RelayState.Held> held = state.held(address);
        List<Courier.Inbound> batch = new ArrayList<>();
        List<Long> until = new ArrayList<>();
        List<Long> seqs = new ArrayList<>();
        long now = clock.millis();
        for (RelayState.Held h : held) {
            if (!h.identityKey().equals(identityKey)) {
                continue;
            }
            try {
                Map<String, Object> p = Json.parseObject(h.payload().getBytes(StandardCharsets.UTF_8));
                Payloads.Message m = Payloads.readMessage(p);
                batch.add(Drain.inbound(p, m, h.body(), h.externalId(), Courier.Origin.LIVE, false));
                until.add(Math.max(Payloads.millis((String) p.get("at")), now) + Drain.MA_WAIT + Drain.SKEW);
                seqs.add(h.seq());
            } catch (JsonFormatException | Payloads.Bad | RuntimeException e) {
                seqs.add(h.seq());
                until.add(now);
                batch.add(null);
            }
        }
        List<Courier.Inbound> kept = new ArrayList<>();
        List<Long> keptUntil = new ArrayList<>();
        for (int i = 0; i < batch.size(); i++) {
            if (batch.get(i) != null) {
                kept.add(batch.get(i));
                keptUntil.add(until.get(i));
            }
        }
        state.accept(kept, keptUntil, seqs);
        state.dropHeld(address, identityKey);
        return kept.size();
    }

    /**
     * {@code courier.invite.open {link}}: someone's invite link. The directory's keys for its address must have the link's
     * fingerprint: then they're pinned as checked (or a changed pin takes them, since the link vouches for them), the
     * contact is made and let in. A fingerprint that doesn't match pins nothing ({@code conflict}, {@code invite_mismatch},
     * {@code pinned}), unless it's the pinned identity with a box key this desk recorded for it ({@code rotated}). A pin the
     * member checked under another identity isn't replaced: it's marked changed ({@code conflict}, {@code key_changed}).
     */
    private Object inviteOpen(com.minimalistalliance.desk.deskd.rpc.RpcContext context, Map<String, Object> params) throws Exception {
        Invite invite = params.get("link") instanceof String s ? Invite.parse(s) : null;
        if (invite == null) {
            throw bad("link");
        }
        Added a = add(invite.address(), invite.fingerprint(), null, "invite_mismatch", false);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("contactId", a.contactId());
        out.put("address", invite.address());
        out.put("outcome", a.outcome());
        out.put("safetyNumber", a.safetyNumber());
        out.put("released", a.released());
        return out;
    }

    private static final Pattern NAME = Pattern.compile("[a-z0-9](?:[a-z0-9]|[.-](?=[a-z0-9])){1,30}[a-z0-9]");
    private static final Pattern FINGERPRINT = Pattern.compile("[0-9a-f]{4}(?:-[0-9a-f]{4}){7}");

    /**
     * {@code courier.contacts.add {name, fingerprint?, displayName?}}: the office's Add for an invite it read (the shape
     * {@code sub/mm-courier-ui} proposed, API.md §21): the member address {@code <name>@<Courier domain>}, pinned as checked
     * when its keys match {@code fingerprint} ({@code checked: invite}), or on first use without one ({@code checked: null}).
     */
    private Object contactsAdd(com.minimalistalliance.desk.deskd.rpc.RpcContext context, Map<String, Object> params) throws Exception {
        String name = params.get("name") instanceof String s ? s.strip().toLowerCase(java.util.Locale.ROOT) : null;
        if (name == null || !NAME.matcher(name).matches()) {
            throw bad("name");
        }
        String fingerprint = null;
        if (params.get("fingerprint") != null) {
            fingerprint = params.get("fingerprint") instanceof String s ? s.strip().toLowerCase(java.util.Locale.ROOT) : null;
            if (fingerprint == null || !FINGERPRINT.matcher(fingerprint).matches()) {
                throw bad("fingerprint");
            }
        }
        String display = null;
        if (params.get("displayName") != null) {
            if (!(params.get("displayName") instanceof String s) || s.length() > 80) {
                throw bad("displayName");
            }
            display = s;
        }
        String d = domain;
        if (d == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "This desk's Courier domain isn't known yet", Map.of("reason", "unreachable"));
        }
        String address = Invite.canonical(name + "@" + d);
        if (address == null) {
            throw bad("name");
        }
        Added a = add(address, fingerprint, display, "fingerprint", true);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("contactId", a.contactId());
        out.put("channelId", a.channelId());
        out.put("checked", "verified".equals(a.outcome()) || "changed_verified".equals(a.outcome()) ? "invite" : null);
        out.put("address", address);
        out.put("safetyNumber", a.safetyNumber());
        out.put("released", a.released());
        return out;
    }

    private record Added(String contactId, String channelId, String outcome, String safetyNumber, int released) {}

    /**
     * Adds a member address from an invite: its keys looked up and, with a fingerprint, pinned as checked only if they match
     * it; without one, pinned on first use (an existing pin stays as it is). Then the contact is made and let in.
     *
     * @param mismatch the refusal's reason when the fingerprint doesn't match
     * @param keysNotSetIsNotFound the office's shape: {@code keys_not_set} as {@code not_found}
     */
    private Added add(String address, String fingerprint, String display, String mismatch, boolean keysNotSetIsNotFound) throws Exception {
        if (address.equals(this.address) || closedAddresses.contains(address)) {
            throw bad("own");
        }
        IdentityKeyPair me = keys == null ? null : keys.identity();
        if (me == null) {
            throw keysUnavailable();
        }
        PublishedKeys k;
        try {
            k = lookup(address);
        } catch (RpcException e) {
            if (keysNotSetIsNotFound && "keys_not_set".equals(e.details().get("reason"))) {
                throw new RpcException(RpcException.NOT_FOUND, "That desk hasn't started since it got its address", Map.of("reason", "keys_not_set"));
            }
            throw e;
        }
        RelayState state = store.relay();
        RelayState.Pin pin = state.pin(address);
        long now = clock.millis();
        String outcome;
        int released = 0;
        if (fingerprint == null) {
            // No fingerprint: the directory's keys are trusted on first use (the link said what it trusts); a pin stays.
            if (pin == null) {
                state.putPin(Pins.newPin(address, k, RelayState.UNVERIFIED, "link", now));
            }
            outcome = pin == null ? "unverified" : pin.state();
        } else if (!k.matches(fingerprint)) {
            // Only a link made for this identity with a box key this desk itself recorded for it is an old link; anything else
            // is a mismatch the member settles with the safety number (Security CT-M2).
            if (pin != null && pin.identityKey().equals(k.identityKey().text()) && knownLink(pin, fingerprint)) {
                outcome = "rotated";
            } else {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("reason", mismatch);
                details.put("pinned", pin != null);
                throw new RpcException(RpcException.CONFLICT, "This invite doesn't match the desk's keys", details);
            }
        } else if (pin == null) {
            state.putPin(Pins.newPin(address, k, RelayState.VERIFIED, "invite", now));
            outcome = "verified";
        } else if (pin.identityKey().equals(k.identityKey().text())) {
            // The pinned identity, now checked by the link (a changed pin's other identity, and what it held, goes).
            if (RelayState.CHANGED.equals(pin.state())) {
                state.dropHeld(address, pin.identityKey());
            }
            state.putPin(new RelayState.Pin(address, pin.identityKey(), k.boxKey().text(), Pins.b64(k.binding()), k.keysVersion(),
                    pin.withKeys(k.boxKey().text(), Pins.b64(k.binding()), k.keysVersion()).oldBoxKeys(), RelayState.VERIFIED, "invite", null,
                    null, null, null, pin.pinnedAt(), now, null, now));
            released = release(address, pin.identityKey());
            state.keyChecked();
            store.outbox().poke();
            outcome = "verified";
        } else if (RelayState.VERIFIED.equals(pin.state())) {
            // A link can't silently replace an identity the member checked: the change shows, and the member confirms it with
            // the safety number (Security CT-M2).
            state.putPin(pin.changedTo(k.identityKey().text(), k.boxKey().text(), Pins.b64(k.binding()), k.keysVersion(), now));
            Map<String, Object> details = new LinkedHashMap<>();
            details.put("reason", "key_changed");
            details.put("newSafetyNumber", SafetyNumber.between(me.publicKey(), k.identityKey()));
            throw new RpcException(RpcException.CONFLICT, "This desk's key changed since you checked it", details);
        } else {
            // An unchecked (or already changed) pin takes the keys the link vouches for.
            state.dropHeld(address, k.identityKey().text());
            state.putPin(new RelayState.Pin(address, k.identityKey().text(), k.boxKey().text(), Pins.b64(k.binding()), k.keysVersion(), null,
                    RelayState.VERIFIED, "invite", null, null, null, null, pin.pinnedAt(), now, null, now));
            released = release(address, k.identityKey().text());
            state.keyChecked();
            store.outbox().poke();
            outcome = "changed_verified";
        }
        String[] contact = state.contact(address, display);
        if (contact == null) {
            throw new RpcException(RpcException.FORBIDDEN, "That address is blocked", Map.of("reason", "blocked"));
        }
        return new Added(contact[0], contact[1], outcome, SafetyNumber.between(me.publicKey(), k.identityKey()), released);
    }

    /** Whether a link's fingerprint is the pinned identity's with one of the box keys this desk recorded for it. */
    private static boolean knownLink(RelayState.Pin pin, String fingerprint) {
        IdentityKey id = Pins.identity(pin.identityKey());
        if (id == null) {
            return false;
        }
        for (String box : pin.boxKeys()) {
            try {
                PublishedKeys k = new PublishedKeys(id, com.minimalistalliance.desk.courier.envelope.BoxKey.parse(box), new byte[64], -1);
                if (k.matches(fingerprint)) {
                    return true;
                }
            } catch (EnvelopeException e) {
                // A box key that doesn't read names no link.
            }
        }
        return false;
    }

    /** The directory's keys for an address, checked, or the refusal as the office should show it. */
    private PublishedKeys lookup(String address) throws Exception {
        Map<String, Object> answer;
        try {
            answer = api.lookup(address);
        } catch (RelayApi.Refused r) {
            String code = r.code() == null ? "http_" + r.status() : r.code();
            throw switch (code) {
                case "address_unknown", "address_closed" -> new RpcException(RpcException.NOT_FOUND, "No such address", Map.of("reason", code));
                case "keys_not_set" -> new RpcException(RpcException.UNAVAILABLE, "That desk hasn't started since it got its address",
                        Map.of("reason", code));
                case "courier_paused" -> new RpcException(RpcException.UNAVAILABLE, "Courier is paused", Map.of("reason", "paused"));
                case "rate_limited" -> new RpcException(RpcException.RATE_LIMITED, "Too many lookups", Map.of("reason", code));
                default -> new RpcException(RpcException.UNAVAILABLE, "The platform can't be reached", Map.of("reason", "unreachable"));
            };
        } catch (IOException e) {
            throw new RpcException(RpcException.UNAVAILABLE, "The platform can't be reached", Map.of("reason", "unreachable"));
        }
        try {
            PublishedKeys k = PublishedKeys.fromJson(answer);
            if (!k.bindingValid() || !address.equals(answer.get("address"))) {
                throw new EnvelopeException(EnvelopeException.FORMAT, "binding");
            }
            return k;
        } catch (EnvelopeException e) {
            throw new RpcException(RpcException.UNAVAILABLE, "That desk's keys don't check out", Map.of("reason", "keys_invalid"));
        }
    }

    /**
     * {@code courier.compose.pick {channelId} | {to: [address...]}}: the medium and account a message goes by, and why
     * (design §8.3).
     */
    private Object composePick(com.minimalistalliance.desk.deskd.rpc.RpcContext context, Map<String, Object> params) throws Exception {
        RelayState state = store.relay();
        List<RelayState.Person> people;
        RelayState.PickFacts facts = null;
        if (params.get("channelId") instanceof String c) {
            if (!ID.matcher(c).matches()) {
                throw bad("channelId");
            }
            facts = state.pickFacts(c);
            if (facts == null) {
                throw new RpcException(RpcException.NOT_FOUND, "No such item", Map.of());
            }
            people = facts.people();
        } else if (params.get("to") instanceof List<?> to && !to.isEmpty() && to.size() <= 50) {
            List<String[]> kv = new ArrayList<>();
            for (Object o : to) {
                if (!(o instanceof String s) || s.length() > 320) {
                    throw bad("to");
                }
                String v = s.strip().toLowerCase(java.util.Locale.ROOT);
                if (v.contains("@")) {
                    kv.add(new String[] {"email", v});
                } else {
                    kv.add(new String[] {"phone", v});
                }
            }
            people = state.people(kv);
        } else {
            throw bad("channelId");
        }
        Set<String> changed = state.changed();
        return Picker.pick(people, facts, store.accounts(), (m, a) -> store.outbox().canSend(m, a), domain, changed).toMap();
    }

    // ---- lifecycle

    @Override
    public void close() {
        closed = true;
        worker.shutdownNow();
        try {
            worker.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (store != null) {
            store.outbox().unregister("ma", MA_ACCOUNT);
            store.outbox().unregister("email", DESK_ACCOUNT);
        }
    }

    /** For tests and the status: what the platform said about this desk. */
    String address() {
        return address;
    }

    Drain.Counts counts() {
        return counts;
    }

    @Override
    public String toString() {
        return "RelayTransport";
    }
}
