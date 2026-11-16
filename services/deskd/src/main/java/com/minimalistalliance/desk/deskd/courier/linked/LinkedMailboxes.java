package com.minimalistalliance.desk.deskd.courier.linked;

import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.store.Accounts;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import java.io.IOException;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Linked mailboxes over IMAP and SMTP (the launch plan's Wave 2.1): one {@link MailboxSync} per linked account, the
 * sign-in check {@code courier.accounts.add} needs ({@link LinkedAccounts.Verifier}), and each account's sending half in
 * the outbound queue ({@link LinkedSender}). On by default, as every prelaunch feature, with kill switches in Courier's
 * switch file: {@code imap-off} (this transport, both ways) and {@code email-off} (all email), {@code send-off} and
 * {@code imap-send-off} (sending only); and {@code off} for Courier as a whole. A switch that turns on starts it again.
 *
 * <p>The desk connects out to the member's provider itself (desk egress allows 993, 465 and 587; ADR 0014); the platform
 * is never in the path. Microsoft and Google sign-in (OAuth) is Wave 2.2's.
 */
public final class LinkedMailboxes implements CourierModule.LinkedTransport {

    private static final Logger log = LoggerFactory.getLogger(LinkedMailboxes.class);
    /** The switch's words for this transport. */
    static final String CHANNEL = Accounts.IMAP;
    static final String SEND_CHANNEL = "imap-send";

    /** Bounds and timings. {@code fetchBudget}: bytes fetched and not yet stored, across every account. */
    public record Settings(MailboxSync.Settings sync, long fetchBudget, Duration smtpTimeout, Duration switchCheck) {
        public static final Settings DEFAULT = new Settings(MailboxSync.Settings.DEFAULT, 16L * 1024 * 1024, Duration.ofMinutes(2),
                Duration.ofSeconds(30));
    }

    private final CourierModule module;
    private final CourierStore store;
    private final LinkedAccounts accounts;
    private final Net net;
    private final Clock clock;
    private final Settings settings;
    private final FetchBudget budget;
    private final Map<String, MailboxSync> syncs = new ConcurrentHashMap<>();
    private final MailboxSync.Context ctx;
    private volatile boolean closed;
    private Thread watcher;

    public LinkedMailboxes(CourierModule module, Net net, Clock clock, Settings settings) {
        this.module = module;
        this.store = module.store();
        this.accounts = module.linkedAccounts();
        this.net = net;
        this.clock = clock;
        this.settings = settings;
        this.budget = new FetchBudget(settings.fetchBudget());
        this.ctx = new MailboxSync.Context() {
            @Override
            public CourierStore store() {
                return store;
            }

            @Override
            public SignIn signIn(String accountId) throws IOException {
                try {
                    return accounts.open(accountId);
                } catch (IOException e) {
                    throw new MailboxSync.NeedsYou("signed_out");
                }
            }

            @Override
            public Net net() {
                return net;
            }

            @Override
            public Clock clock() {
                return clock;
            }

            @Override
            public boolean on() {
                return receiving();
            }

            @Override
            public FetchBudget budget() {
                return budget;
            }

            @Override
            public void changed(String accountId) {
                // courier.changed's accounts flag: the office reads the new state with courier.accounts.list.
                store.linked().announce();
            }
        };
    }

    /**
     * Registers the sign-in check and starts every linked IMAP account's sync and sender. Inert without a store.
     *
     * @return this
     */
    public LinkedMailboxes start() {
        if (store == null || accounts == null) {
            return this;
        }
        accounts.register(Accounts.IMAP, this::verify);
        store.linked().onOps(this::pokeAll);
        try {
            for (Courier.Account a : store.accounts()) {
                if (Accounts.IMAP.equals(a.kind())) {
                    added(a.id());
                }
            }
        } catch (SQLException e) {
            log.warn("courier imap: accounts couldn't be read ({})", e.getClass().getSimpleName());
        }
        module.attach(this);
        watcher = Thread.ofVirtual().name("courier-imap-switch").start(this::watch);
        return this;
    }

    /** The transport may receive: Courier usable, and neither {@code imap-off} nor {@code email-off}. */
    boolean receiving() {
        return !closed && module.usable() && module.courierSwitch().channelOn(CHANNEL) && module.courierSwitch().channelOn("email");
    }

    /** It may send: receiving, and neither {@code send-off} nor {@code imap-send-off}. */
    boolean sending() {
        return receiving() && module.courierSwitch().sending() && module.courierSwitch().channelOn(SEND_CHANNEL);
    }

    /** A switch turned back on wakes the syncs that were waiting on it; one turned off is seen within a check. */
    private void watch() {
        boolean was = receiving();
        while (!closed) {
            try {
                Thread.sleep(settings.switchCheck().toMillis());
            } catch (InterruptedException e) {
                return;
            }
            boolean now = receiving();
            if (now != was) {
                pokeAll();
                if (now) {
                    store.outbox().poke();
                }
            }
            was = now;
        }
    }

    private void pokeAll() {
        for (MailboxSync s : syncs.values()) {
            s.poke();
        }
    }

    // ---- the seam courier.accounts.* uses

    @Override
    public void added(String accountId) {
        if (closed || store == null) {
            return;
        }
        syncs.computeIfAbsent(accountId, id -> {
            MailboxSync s = new MailboxSync(id, ctx, settings.sync());
            s.start();
            return s;
        });
        store.outbox().register("email", accountId, new LinkedSender(this, accountId));
    }

    @Override
    public void removing(String accountId) {
        store.outbox().unregister("email", accountId);
        MailboxSync s = syncs.remove(accountId);
        if (s != null) {
            s.stop();
        }
    }

    @Override
    public void signedIn(String accountId) {
        MailboxSync s = syncs.get(accountId);
        if (s != null) {
            s.poke();
        } else {
            added(accountId);
        }
        store.outbox().poke();
    }

    @Override
    public Map<String, Object> status(String accountId) {
        MailboxSync s = syncs.get(accountId);
        if (s == null) {
            return null;
        }
        MailboxSync.Status st = s.status();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("state", st.state());
        m.put("reason", st.reason());
        // The tile "Sign in again" opens: a Workspace or own-domain mailbox at a named provider isn't "Other" by its address.
        m.put("provider", s.providerId());
        m.put("checkedAt", st.checkedAt() == 0 ? null : st.checkedAt());
        m.put("nextTryAt", st.nextTryAt() == 0 ? null : st.nextTryAt());
        Map<String, Object> first = new LinkedHashMap<>();
        first.put("done", st.firstSyncDone());
        first.put("messages", st.messages());
        first.put("oldestAt", st.oldestAt());
        m.put("firstSync", first);
        m.put("changesOwed", st.opsOwed());
        return m;
    }

    @Override
    public List<Map<String, Object>> providers() {
        return Providers.wire();
    }

    @Override
    public String providerFor(String address) {
        return Providers.forAddress(address, Providers::mx);
    }

    @Override
    public void close() {
        closed = true;
        if (watcher != null) {
            watcher.interrupt();
        }
        for (String id : List.copyOf(syncs.keySet())) {
            MailboxSync s = syncs.remove(id);
            if (s != null) {
                s.stop();
            }
        }
    }

    Net net() {
        return net;
    }

    Clock clock() {
        return clock;
    }

    CourierStore store() {
        return store;
    }

    LinkedAccounts accounts() {
        return accounts;
    }

    Settings settings() {
        return settings;
    }

    /** The provider said the sign-in no longer works while sending: the sync shows it too, at its next look. */
    void signInFailed(String accountId) {
        MailboxSync s = syncs.get(accountId);
        if (s != null) {
            s.poke();
        }
    }

    // ---- checking a sign-in (courier.accounts.add, courier.accounts.signin)

    /**
     * Signs in to the provider's IMAP and SMTP with what the member gave, and keeps nothing: the account's address must be
     * one the provider signs in, its folders listable, and its SMTP must take the same sign-in (sending is part of a linked
     * mailbox at launch). A refusal is a word for the office.
     */
    void verify(String address, SignIn signIn) throws LinkedAccounts.Rejected, IOException, InterruptedException {
        // The office waits 60 s for its answer: the whole check, IMAP and SMTP, ends well inside that (Security's CI-L2).
        try (Net.Deadline d = Net.Deadline.start(VERIFY_DEADLINE)) {
            check(signIn);
        }
    }

    /** The sign-in check's own bound on both servers together. */
    static final Duration VERIFY_DEADLINE = Duration.ofSeconds(50);

    private void check(SignIn signIn) throws LinkedAccounts.Rejected, IOException, InterruptedException {
        MailboxSync.Server srv;
        try {
            srv = MailboxSync.Server.of(signIn.server());
        } catch (IOException e) {
            throw new LinkedAccounts.Rejected("server");
        }
        Providers.Provider p = Providers.byHost(srv.imapHost());
        if (p.oauth()) {
            throw new LinkedAccounts.Rejected("oauth");
        }
        if (srv.smtpHost() == null) {
            throw new LinkedAccounts.Rejected("server");
        }
        ImapClient c = null;
        try {
            c = ImapClient.open(net, srv.imapHost(), srv.imapPort(), settings.sync().imap());
            try {
                c.login(signIn.username(), signIn.secret());
            } catch (ImapException.Refused e) {
                boolean alert = c.alerted();
                if (alert && e.says("application-specific", "app password", "apppassword")) {
                    throw new LinkedAccounts.Rejected("app_password");
                }
                if (e.says("not enabled for imap", "imap access", "imap is disabled")) {
                    throw new LinkedAccounts.Rejected("imap_off");
                }
                if (e.says("web login", "webloginrequired")) {
                    throw new LinkedAccounts.Rejected("web_login");
                }
                throw new LinkedAccounts.Rejected("auth");
            }
            c.list();
            c.logout();
        } catch (Net.Refused e) {
            throw new LinkedAccounts.Rejected(e.reason());
        } catch (Net.TlsFailed e) {
            throw new LinkedAccounts.Rejected("tls");
        } catch (ImapException.Refused | ImapException.Protocol e) {
            throw new LinkedAccounts.Rejected("imap");
        } finally {
            if (c != null) {
                c.close();
            }
        }
        SmtpClient s = null;
        try {
            s = SmtpClient.open(net, srv.smtpHost(), srv.smtpPort(), srv.smtpTls(), settings.smtpTimeout());
            s.auth(signIn.username(), signIn.secret());
            s.quit();
        } catch (Net.Refused e) {
            throw new LinkedAccounts.Rejected(e.reason());
        } catch (Net.TlsFailed e) {
            throw new LinkedAccounts.Rejected("tls");
        } catch (SmtpClient.SmtpException e) {
            if (e.getMessage().equals("app_password")) {
                throw new LinkedAccounts.Rejected("app_password");
            }
            if (e.getMessage().equals("sign_in")) {
                throw new LinkedAccounts.Rejected("smtp_auth");
            }
            throw new LinkedAccounts.Rejected("smtp");
        } finally {
            if (s != null) {
                s.close();
            }
        }
    }
}
