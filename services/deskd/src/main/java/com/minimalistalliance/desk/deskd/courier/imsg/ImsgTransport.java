package com.minimalistalliance.desk.deskd.courier.imsg;

import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.store.Accounts;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Outbox;
import com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * iMessage and iPhone texts through the member's own Mac (the launch plan's Wave 2.6, {@code courier.imsg}): the one
 * transport every path to a Mac sits behind (the {@code imsg} seam, ma-desk {@code docs/sub-status/imsg-seam.md}). It owns
 * the account side, the same for every path: one {@link ImsgPath} per iMessage account, picked by the {@code path} its
 * sealed sign-in names ({@code bluebubbles}, {@code connector}); each account's sending half in the outbound queue for
 * {@code imessage} and {@code sms}, with the chat a reply goes to; the switches; and the frame of each account's status.
 *
 * <p>On by default, as every prelaunch feature, with kill switches in Courier's switch file: {@code imessage-off} (this
 * transport, both ways), {@code imessage-send-off} and {@code send-off} (sending only), and {@code off}. The desk connects
 * out to the member's own Mac; the platform is never in the path.
 */
public final class ImsgTransport implements CourierModule.ImessageTransport {

    private static final Logger log = LoggerFactory.getLogger(ImsgTransport.class);
    static final String CHANNEL = Accounts.IMESSAGE;
    static final String SEND_CHANNEL = "imessage-send";

    /** How a path checks a sign-in before it's kept (the setup's Connect). */
    @FunctionalInterface
    public interface Prober {
        Probe probe(String address, byte[] password, String prior, String accept) throws LinkedAccounts.Rejected, IOException, InterruptedException;
    }

    private record Kind(ImsgPath.Factory factory, Prober prober) {}

    private final CourierModule module;
    private final CourierStore store;
    private final LinkedAccounts accounts;
    private final Clock clock;
    private final ImsgSink sink;
    private final Duration switchCheck;
    private final Map<String, Kind> kinds = new ConcurrentHashMap<>();
    private final Map<String, ImsgPath> paths = new ConcurrentHashMap<>();
    private volatile boolean closed;
    private Thread watcher;

    public ImsgTransport(CourierModule module, Clock clock, ImsgSink.Settings files, Duration switchCheck) {
        this.module = module;
        this.store = module.store();
        this.accounts = module.linkedAccounts();
        this.clock = clock;
        this.sink = store == null ? null : new ImsgSink(store, module.parser(), files);
        this.switchCheck = switchCheck;
    }

    /** A path to a Mac: {@code bluebubbles}, {@code connector}. Register every path before {@link #start}. */
    public ImsgTransport register(String path, ImsgPath.Factory factory, Prober prober) {
        kinds.put(path, new Kind(factory, prober));
        return this;
    }

    /** Starts every iMessage account's path and sender. Inert without a store. */
    public ImsgTransport start() {
        if (store == null || accounts == null) {
            return this;
        }
        try {
            for (Courier.Account a : store.accounts()) {
                if (Accounts.IMESSAGE.equals(a.kind())) {
                    added(a.id());
                }
            }
        } catch (SQLException e) {
            log.warn("courier imsg: accounts couldn't be read ({})", e.getClass().getSimpleName());
        }
        module.attachImessage(this);
        watcher = Thread.ofVirtual().name("courier-imsg-switch").start(this::watch);
        return this;
    }

    boolean receiving() {
        return !closed && module.usable() && module.courierSwitch().channelOn(CHANNEL);
    }

    boolean sending() {
        return receiving() && module.courierSwitch().sending() && module.courierSwitch().channelOn(SEND_CHANNEL);
    }

    private void watch() {
        boolean was = receiving();
        while (!closed) {
            try {
                Thread.sleep(switchCheck.toMillis());
            } catch (InterruptedException e) {
                return;
            }
            boolean now = receiving();
            if (now != was) {
                for (ImsgPath p : paths.values()) {
                    p.poke();
                }
                if (now) {
                    store.outbox().poke();
                }
            }
            was = now;
        }
    }

    /** The path an account's sealed sign-in names; {@code bluebubbles} when it names none. */
    private String pathOf(String accountId) {
        try (SignIn s = accounts.open(accountId)) {
            Object p = s.server() == null ? null : Json.parseObject(s.server().getBytes(StandardCharsets.UTF_8)).get("path");
            return p instanceof String w ? w : "bluebubbles";
        } catch (Exception e) {
            return null;
        }
    }

    // ---- the seam courier.accounts.* uses

    @Override
    public void added(String accountId) {
        if (closed || store == null) {
            return;
        }
        paths.computeIfAbsent(accountId, id -> {
            String path = pathOf(id);
            Kind k = path == null ? null : kinds.get(path);
            ImsgPath p = k == null ? new Unusable(path == null ? "signed_out" : "path") : k.factory().open(context(id));
            p.start();
            return p;
        });
        Outbox.Sender sender = item -> send(accountId, item);
        store.outbox().register("imessage", accountId, sender);
        store.outbox().register("sms", accountId, sender);
    }

    @Override
    public void removing(String accountId) {
        store.outbox().unregister("imessage", accountId);
        store.outbox().unregister("sms", accountId);
        ImsgPath p = paths.remove(accountId);
        if (p != null) {
            p.removed();
        }
    }

    @Override
    public void signedIn(String accountId) {
        // A new sign-in may name a new address or path: the account's path starts again on it.
        ImsgPath p = paths.remove(accountId);
        if (p != null) {
            p.stop();
        }
        added(accountId);
        store.outbox().poke();
    }

    @Override
    public void poke(String accountId) {
        ImsgPath p = paths.get(accountId);
        if (p != null) {
            p.poke();
        }
    }

    @Override
    public Map<String, Object> status(String accountId) {
        ImsgPath p = paths.get(accountId);
        if (p == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>(p.status());
        if (!receiving()) {
            m.put("state", "off");
            m.put("reason", "switched_off");
        }
        return m;
    }

    @Override
    public Probe probe(String path, String address, byte[] password, String prior, String accept)
            throws LinkedAccounts.Rejected, IOException, InterruptedException {
        Kind k = kinds.get(path);
        if (k == null || k.prober() == null) {
            throw new LinkedAccounts.Rejected("path");
        }
        return k.prober().probe(address, password, prior, accept);
    }

    @Override
    public void close() {
        closed = true;
        if (watcher != null) {
            watcher.interrupt();
        }
        for (String id : List.copyOf(paths.keySet())) {
            ImsgPath p = paths.remove(id);
            if (p != null) {
                p.stop();
            }
        }
    }

    // ---- sending

    /**
     * The queue's message to one Mac chat: a group's own chat (the one its messages came from), or the person's
     * ({@code iMessage;-;<handle>}, {@code SMS;-;<number>} for a text). A new group, or a group no message came from, can't
     * be started from Courier at launch ({@code chat}).
     */
    Outbox.Result send(String accountId, Outbox.Outgoing item) throws InterruptedException {
        if (!sending()) {
            return new Outbox.Retry("switched_off");
        }
        ImsgPath p = paths.get(accountId);
        if (p == null) {
            return new Outbox.Retry("no_transport");
        }
        String text = item.text() == null || item.text().isBlank() ? item.subject() : item.text();
        if (text == null || text.isBlank()) {
            return new Outbox.Failed("empty");
        }
        if (text.length() > ImsgSend.MAX_TEXT) {
            return new Outbox.Failed("too_long");
        }
        List<String> handles = new ArrayList<>();
        for (Outbox.Recipient r : item.to()) {
            String h = ImsgSink.endpoint(r.value());
            if (h != null) {
                handles.add(h);
            }
        }
        String chat;
        try {
            String channel = store.imessage().channelOf(item.messageId());
            chat = channel == null ? null : store.imessage().chatFor(accountId, channel);
        } catch (SQLException e) {
            return new Outbox.Retry("storage");
        }
        if (chat == null) {
            if (handles.size() != 1) {
                return new Outbox.Failed("chat");
            }
            chat = ("sms".equals(item.medium()) ? "SMS" : "iMessage") + ";-;" + handles.get(0);
        }
        ImsgSend.Result r = p.send(new ImsgSend(item.outboundId(), item.messageId(), item.medium(), chat, handles, text, item.attempt(),
                item.maybeSentBefore()));
        if (r instanceof ImsgSend.Sent) {
            Map<String, String> sent = new LinkedHashMap<>();
            for (Outbox.Recipient rc : item.to()) {
                sent.put(rc.endpointId(), "sent");
            }
            p.poke();
            return new Outbox.Sent(sent);
        }
        if (r instanceof ImsgSend.Retry retry) {
            return new Outbox.Retry(retry.error(), retry.unclear());
        }
        return new Outbox.Failed(((ImsgSend.Failed) r).error());
    }

    // ---- what a path is given

    private ImsgPath.Context context(String accountId) {
        return new ImsgPath.Context() {
            @Override
            public String accountId() {
                return accountId;
            }

            @Override
            public CourierStore store() {
                return store;
            }

            @Override
            public ImsgSink sink() {
                return sink;
            }

            @Override
            public SignIn signIn() throws IOException {
                return accounts.open(accountId);
            }

            @Override
            public Clock clock() {
                return clock;
            }

            @Override
            public boolean receiving() {
                return ImsgTransport.this.receiving();
            }

            @Override
            public boolean sending() {
                return ImsgTransport.this.sending();
            }

            @Override
            public void recordSent(String guid, String messageId) throws SQLException {
                store.imessage().recordSent(accountId, guid, messageId);
            }

            @Override
            public void changed() {
                store.linked().announce();
            }
        };
    }

    /** An account whose path isn't here (signed out, or a path this deskd doesn't have): says so, sends nothing. */
    private static final class Unusable implements ImsgPath {
        private final String reason;

        Unusable(String reason) {
            this.reason = reason;
        }

        @Override
        public void start() {}

        @Override
        public void stop() {}

        @Override
        public void poke() {}

        @Override
        public Map<String, Object> status() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("state", "needs_you");
            m.put("reason", reason);
            m.put("path", null);
            return m;
        }

        @Override
        public ImsgSend.Result send(ImsgSend send) {
            return new ImsgSend.Retry(reason, false);
        }
    }
}
