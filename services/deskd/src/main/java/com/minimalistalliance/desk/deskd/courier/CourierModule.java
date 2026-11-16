package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.keys.KeyPublisher;
import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.store.AgentView;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.vault.CourierVault;
import com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Courier in deskd (draft ADR "Courier's store"; the launch plan's Wave 1.1): the store in {@code /data/courier}, the
 * {@code courier.*} methods and the topic {@code courier.changed} (API.md §21), the outbound queue's runner, retention's
 * hourly sweep, and the agent tools' view ({@link #read()}).
 *
 * <p><b>On by default, with a kill switch</b> ({@code /data/desk/courier-switch}, {@link CourierSwitch}), as every
 * prelaunch feature. A guild desk has no Courier ({@code forbidden}, {@code reason: scope}); a teen's desk has none either
 * (ADR 0098 decision 7: {@code forbidden}, {@code reason: teen}), and while the band isn't known calls get
 * {@code unavailable} with {@code reason: age_band}. A store that can't be opened (no {@code /data/courier} on this image,
 * a schema from a newer release) makes every call {@code unavailable} with {@code reason: store}; nothing else in deskd
 * changes.
 *
 * <p>Seams for the next pieces: transports hand messages to {@link CourierStore#accept} and register their sending half
 * with {@code store().outbox().register}; {@code desk-parse}'s Courier mode is the {@link CourierParser} given here
 * ({@code CourierSandbox}; while it can't be reached, emails wait as pending, raw bytes kept); linked mailboxes and their
 * sealed sign-ins are {@link #linkedAccounts()}, whose transport registers a verifier there; the desk's own keys, which
 * the {@code ma} and mail-door transports sign and open with, are {@link #keys()} (Wave 1.4, {@code /data/keys}).
 */
public final class CourierModule {

    private static final Logger log = LoggerFactory.getLogger(CourierModule.class);

    public static final String DEFAULT_ROOT = "/data/courier";

    /**
     * @param root the store's directory, {@link #DEFAULT_ROOT} on a desk
     * @param switchDirectory deskd's own directory on the volume, which holds {@value CourierSwitch#FILE}
     * @param agentsSeeOther the plan's §6 amendment 2 (agents see the Other lane), pending Security's read
     */
    public record Settings(Path root, Path switchDirectory, boolean agentsSeeOther, Duration sweepEvery, CourierStore.Settings store) {
        public static Settings defaults(Path root, Path switchDirectory) {
            return new Settings(root, switchDirectory, true, Duration.ofHours(1), CourierStore.Settings.DEFAULT);
        }
    }

    private final CourierStore store;
    private final CourierSwitch courierSwitch;
    private final BooleanSupplier guildDesk;
    private final Supplier<AgeBand.Band> band;
    private final CourierFeed feed;
    private final ScheduledExecutorService timer;
    private final AgentView agentView;
    private final LinkedAccounts linked;
    private final DeskKeys keys;
    private final CourierAttachments attachments;
    private final CourierParser parser;
    private volatile LinkedTransport transport;
    private volatile ImessageTransport imessage;
    private volatile AutoCloseable relay;

    /**
     * The linked mailboxes' transport (Wave 2.1, {@code courier.linked}), as {@code courier.accounts.*} needs it: told of an
     * account added, about to be removed, or signed in again, and asked for an account's sync state and the providers the
     * setup screen offers.
     */
    public interface LinkedTransport {
        void added(String accountId);

        void removing(String accountId);

        void signedIn(String accountId);

        Map<String, Object> status(String accountId);

        java.util.List<Map<String, Object>> providers();

        /** The named provider an address is at (its domain, or where its mail goes), or null: then its servers are needed. */
        default String providerFor(String address) {
            return null;
        }

        void close();
    }

    /**
     * iMessage through the member's Mac (Wave 2.6, {@code courier.imsg}), as {@code courier.accounts.*} needs it: one
     * transport for every path to a Mac (BlueBubbles Server, MA's Mac connector), told of an account added, about to be
     * removed, or signed in again, asked for its state, and asked to check a path's sign-in before anything is kept.
     */
    public interface ImessageTransport {
        void added(String accountId);

        void removing(String accountId);

        void signedIn(String accountId);

        /** "Check again": look at the Mac now. */
        void poke(String accountId);

        Map<String, Object> status(String accountId);

        /**
         * Checks a path's sign-in with the Mac before anything is kept (BlueBubbles: its address and password), and keeps
         * nothing: what to seal, the member's own handles, and the account's label. {@code prior} is the account's sealed
         * server settings for "Sign in again" (null for a new account): a certificate pinned there for the same address is
         * kept, and one the Mac no longer shows is refused ({@code certificate_changed}, with the new one's fingerprint as
         * the detail) before any password is sent, unless {@code accept} names that fingerprint, the member's word.
         *
         * @throws LinkedAccounts.Rejected the Mac's no, or an address the desk won't use, as a word for the office
         * @throws java.io.IOException the Mac couldn't be reached
         */
        Probe probe(String path, String address, byte[] password, String prior, String accept)
                throws LinkedAccounts.Rejected, java.io.IOException, InterruptedException;

        void close();

        /** What a checked sign-in gives: {@code server} is sealed with the password, never shown or logged. */
        record Probe(String server, String username, java.util.List<String[]> own, String label) {}
    }

    public CourierModule(RpcDispatcher dispatcher, EventHub hub, Settings settings, CourierParser parser, BooleanSupplier guildDesk,
            Supplier<AgeBand.Band> band, Clock clock) {
        this(dispatcher, hub, settings, parser, new CourierSwitch(settings.switchDirectory()), guildDesk, band, clock);
    }

    public CourierModule(RpcDispatcher dispatcher, EventHub hub, Settings settings, CourierParser parser, CourierSwitch courierSwitch,
            BooleanSupplier guildDesk, Supplier<AgeBand.Band> band, Clock clock) {
        this(dispatcher, hub, settings, parser, courierSwitch, guildDesk, band, clock, null, KeyPublisher.NONE);
    }

    /**
     * @param keys where the desk's keys live ({@code /data/keys}) and how often the box key rotates; null for none, as on a
     *     desk where member messages and the mail door can't be used
     * @param publisher where the public keys go (the platform's key directory)
     */
    public CourierModule(RpcDispatcher dispatcher, EventHub hub, Settings settings, CourierParser parser, CourierSwitch courierSwitch,
            BooleanSupplier guildDesk, Supplier<AgeBand.Band> band, Clock clock, DeskKeys.Settings keys, KeyPublisher publisher) {
        this.courierSwitch = courierSwitch;
        this.guildDesk = guildDesk;
        this.band = band;
        this.parser = parser;
        CourierStore opened = null;
        try {
            opened = CourierStore.open(settings.root(), parser, clock, settings.store());
        } catch (Exception | LinkageError e) {
            // LinkageError: SQLite's native library didn't load on this image.
            log.warn("Courier's store can't be opened: {}", e.getClass().getSimpleName());
        }
        this.store = opened;
        LinkedAccounts accounts = null;
        if (opened != null) {
            // The vault (the plan's section 3.6): /data/courier/keys, sealed in ADR 0042's format. A start never fails on it.
            accounts = new LinkedAccounts(opened, new CourierVault(settings.root().resolve("keys")));
            accounts.start();
        }
        this.linked = accounts;
        // The desk's keys (Wave 1.4): loaded now, rotated and published from the sweep, only while Courier may run here.
        this.keys = keys == null ? null : new DeskKeys(keys, clock, publisher, () -> refusal() == null);
        this.timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "courier-timer");
            t.setDaemon(true);
            return t;
        });
        this.feed = new CourierFeed(hub, timer, this::refusal);
        hub.topics().register(CourierFeed.TOPIC, feed);
        this.attachments = new CourierAttachments(() -> store,
                parser instanceof com.minimalistalliance.desk.deskd.courier.parse.CourierSandbox sb ? CourierAttachments.Parts.of(sb) : null, clock);
        new CourierMethods(this, () -> store, attachments).register(dispatcher);
        this.agentView = store == null ? null : new AgentView(store, () -> refusal() == null, () -> settings.agentsSeeOther());
        if (store != null) {
            // The learning filter's kill switch: filter-off (Wave 3.2). Off, it judges nothing; the member's actions still teach it.
            store.filterSwitch(() -> courierSwitch.channelOn("filter"));
            CourierAttachments.clearParts(store.partsDir());
            store.onChange(feed::changed);
            store.outbox().start(() -> refusal() == null && courierSwitch.sending());
            long every = Math.max(1, settings.sweepEvery().toMillis());
            timer.scheduleWithFixedDelay(this::sweep, 0, every, TimeUnit.MILLISECONDS);
        }
    }

    /** Why a call is refused now, or null: the desk's kind, the band, the store, then the switch. */
    public RpcException refusal() {
        if (guildDesk.getAsBoolean()) {
            return CourierMethods.scope();
        }
        AgeBand.Band b = band.get();
        if (b == AgeBand.Band.TEEN) {
            return new RpcException(RpcException.FORBIDDEN, "Courier is not available on this desk", Map.of("reason", "teen"));
        }
        if (b == null) {
            return new RpcException(RpcException.UNAVAILABLE, "Waiting for the desk's settings", Map.of("reason", "age_band"));
        }
        if (store == null) {
            return new RpcException(RpcException.UNAVAILABLE, "Courier's store can't be used", Map.of("reason", "store"));
        }
        if (!courierSwitch.on()) {
            return new RpcException(RpcException.UNAVAILABLE, "Courier is switched off", Map.of("reason", "switched_off"));
        }
        return null;
    }

    boolean guildDesk() {
        return guildDesk.getAsBoolean();
    }

    boolean sending() {
        return courierSwitch.sending();
    }

    /** True if the store opened. */
    public boolean available() {
        return store != null;
    }

    /** The store, for transports; null if it couldn't be opened. */
    public CourierStore store() {
        return store;
    }

    /** Linked mailboxes and their sealed sign-ins, for the transports; null if the store couldn't be opened. */
    public LinkedAccounts linkedAccounts() {
        return linked;
    }

    public CourierSwitch courierSwitch() {
        return courierSwitch;
    }

    /** The desk's Courier keys, for the {@code ma} and mail-door transports; null when none were configured. */
    public DeskKeys keys() {
        return keys;
    }

    /**
     * Attachments' ways out (Wave 3.1): Files' door for Save to Files, the session's {@code bulk} transfers for Download, a
     * preview and the raw message, and the Platform's bandwidth pause, which refuses a new download as it does
     * {@code files.read}. Called once, before anything can call; without it those methods answer {@code unavailable}.
     */
    public void attachmentsThrough(com.minimalistalliance.desk.deskd.files.AgentFiles files,
            com.minimalistalliance.desk.deskd.data.Transfers transfers, Supplier<java.time.Instant> pausedUntil) {
        attachments.through(files, transfers, pausedUntil);
    }

    /** For tests: attachments' own settings (the volume's free space). */
    CourierAttachments attachments() {
        return attachments;
    }

    /** For tests: where attachments' parts come from, when the parser given isn't the sandbox itself. */
    void attachmentParts(CourierAttachments.Parts parts) {
        attachments.parts(parts);
    }

    /** Attaches the linked mailboxes' transport; {@link #close} stops it before the store closes. */
    public void attach(LinkedTransport t) {
        this.transport = t;
    }

    /**
     * Attaches the relay's transports (Wave 2.5, {@code courier.relay}: the mail door and members' messages); {@link #close}
     * stops them before the store closes.
     */
    public void attachRelay(AutoCloseable t) {
        this.relay = t;
    }

    /** Attaches the iMessage transport (Wave 2.6); {@link #close} stops it before the store closes. */
    public void attachImessage(ImessageTransport t) {
        this.imessage = t;
    }

    /** The iMessage transport, or null with none attached. */
    ImessageTransport imessage() {
        return imessage;
    }

    /** {@code desk-parse}'s Courier mode, for a transport whose messages carry files (iMessage's, in a MIME container). */
    public CourierParser parser() {
        return parser;
    }

    /** The linked mailboxes' transport, or null with none attached (tests, a store that didn't open). */
    LinkedTransport transport() {
        return transport;
    }

    /** Whether Courier as a whole is usable now: the desk's kind, the band, the store and the switch. */
    public boolean usable() {
        return refusal() == null;
    }

    /** The agent tools' view: {@link CourierRead#available} is false while there's no store or Courier is refused. */
    public CourierRead read() {
        return agentView == null ? CourierRead.NONE : agentView;
    }

    /** Retention, the parser's backlog, the blobs owed, and the keys' rotation and publishing. Hourly, and at start. */
    public void sweep() {
        if (store == null) {
            return;
        }
        if (keys != null) {
            try {
                keys.maintain();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (RuntimeException e) {
                log.warn("courier keys' upkeep failed: {}", e.getClass().getSimpleName());
            }
        }
        try {
            store.sweep();
            store.reparsePending(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            log.warn("courier sweep failed: {}", e.getClass().getSimpleName());
        }
    }

    public void close() {
        LinkedTransport t = transport;
        if (t != null) {
            t.close();
        }
        ImessageTransport im = imessage;
        if (im != null) {
            im.close();
        }
        AutoCloseable r = relay;
        if (r != null) {
            try {
                r.close();
            } catch (Exception e) {
                log.warn("courier relay didn't close cleanly: {}", e.getClass().getSimpleName());
            }
        }
        timer.shutdownNow();
        feed.close();
        if (store != null) {
            store.close();
        }
    }
}
