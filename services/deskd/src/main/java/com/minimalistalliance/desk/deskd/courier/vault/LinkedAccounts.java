package com.minimalistalliance.desk.deskd.courier.vault;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import java.io.IOException;
import java.sql.SQLException;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Linked mailboxes and their sealed sign-ins together (the launch plan §3.6; ADR 0042's rules for LLM keys, in Courier's
 * own place). {@code courier.db}'s {@code accounts} row is the commit point, as {@code agent.db}'s {@code keys} row is:
 * <ul>
 * <li><b>Add:</b> the transport checks the sign-in with the provider ({@link Verifier}), it's sealed durably, then the row
 *     is written. If sealing fails nothing is on disk; if the row fails the sealed file is removed. A sign-in is never kept
 *     in memory instead.</li>
 * <li><b>Change</b> (an OAuth refresh, a new app password): sealed over the old one, atomically.</li>
 * <li><b>Remove:</b> the row goes (with the account's mail unless kept), then the sealed file is unlinked and the
 *     directory synced; if the unlink fails, the next start removes it as an orphan.</li>
 * <li><b>Start:</b> the vault is tightened and a sealed file with no row is deleted (a crash between the two). A row with
 *     no file, or one that won't open, reads as signed out ({@link #signedIn} false) and its transport asks the member to
 *     sign in again.</li>
 * </ul>
 * The secret is in no row, no answer and no log: the office sends it once, and only "signed in as" ever goes back.
 * Nothing goes to the platform: a sign-in is used by the desk's own transport, to the member's own provider.
 */
public final class LinkedAccounts {

    private static final Logger log = LoggerFactory.getLogger(LinkedAccounts.class);

    /** The most linked mailboxes a desk has (the plan's team default: up to five). */
    public static final int MAX_LINKED = 5;

    /**
     * A transport's check of a sign-in with the provider, before anything is kept (Wave 2.1 registers IMAP's, 2.2 JMAP's).
     * It must not keep the sign-in, log it or send it anywhere but the provider.
     */
    @FunctionalInterface
    public interface Verifier {
        /** @throws Rejected if the provider refused it; {@link IOException} if the provider couldn't be reached */
        void verify(String address, SignIn signIn) throws Rejected, IOException, InterruptedException;
    }

    /** The provider said no: the reason is a short word for the office ({@code auth}, {@code app_password}, {@code tls}). */
    public static final class Rejected extends Exception {
        private static final long serialVersionUID = 1L;
        private final String reason;
        private final String detail;

        public Rejected(String reason) {
            this(reason, null);
        }

        /** With a public detail the office shows (a Mac's new certificate's fingerprint); never a secret. */
        public Rejected(String reason, String detail) {
            super(reason, null, false, false);
            this.reason = reason;
            this.detail = detail;
        }

        public String reason() {
            return reason;
        }

        public String detail() {
            return detail;
        }
    }

    /** Why an add or change was refused, as a word for the RPC ({@code no_transport}, {@code too_many}, {@code storage}). */
    public static final class Refused extends Exception {
        private static final long serialVersionUID = 1L;
        private final String reason;

        public Refused(String reason) {
            super(reason, null, false, false);
            this.reason = reason;
        }

        public String reason() {
            return reason;
        }
    }

    private final CourierStore store;
    private final CourierVault vault;
    private final Map<String, Verifier> verifiers = new ConcurrentHashMap<>();
    private final ReentrantLock lock = new ReentrantLock();

    public LinkedAccounts(CourierStore store, CourierVault vault) {
        this.store = store;
        this.vault = vault;
    }

    /** A transport says it can check sign-ins of this kind ({@code imap}, {@code jmap}); until one does, adding is refused. */
    public void register(String kind, Verifier verifier) {
        verifiers.put(kind, verifier);
    }

    /** At a start: the vault prepared, and every sealed file no linked account names removed. */
    public void start() {
        vault.prepare();
        try {
            Set<String> keep = new HashSet<>();
            for (Courier.Account a : store.accounts()) {
                if (com.minimalistalliance.desk.deskd.courier.store.Accounts.SEALED.contains(a.kind())) {
                    keep.add(a.id());
                }
            }
            int removed = vault.removeOrphans(keep);
            if (removed > 0) {
                log.info("courier vault: removed {} sign-ins no account names", removed);
            }
        } catch (SQLException | RuntimeException e) {
            log.warn("courier vault: orphans weren't checked ({})", e.getClass().getSimpleName());
        }
    }

    /**
     * Adds a linked mailbox: {@link #check}, then {@link #keep}. {@code signIn} is closed whatever happens.
     */
    public void add(Courier.Account account, List<String[]> ownAddresses, SignIn signIn)
            throws Refused, Rejected, IOException, InterruptedException {
        try (signIn) {
            check(account, signIn);
            keep(account, ownAddresses, signIn);
        }
    }

    /**
     * A new linked mailbox's sign-in checked with its provider, before anything is kept. Nothing here can't be taken back.
     * {@code signIn} is the caller's to close.
     *
     * @throws Refused {@code no_transport} (nothing can check this kind yet), {@code too_many}, {@code storage}
     * @throws Rejected the provider's no
     * @throws IOException the provider couldn't be reached
     */
    public void check(Courier.Account account, SignIn signIn) throws Refused, Rejected, IOException, InterruptedException {
        Verifier verifier = verifiers.get(account.kind());
        if (verifier == null) {
            throw new Refused("no_transport");
        }
        room(account.kind());
        verifier.verify(account.address(), signIn);
    }

    /** One iMessage account a desk: one Mac's server (Wave 2.6). */
    public static final int MAX_IMESSAGE = 1;

    /**
     * Whether one more account of this kind fits: up to {@link #MAX_LINKED} linked mailboxes, and {@link #MAX_IMESSAGE}
     * Mac. Nothing is checked with anyone, and nothing kept.
     *
     * @throws Refused {@code too_many}, {@code storage}
     */
    public void room(String kind) throws Refused {
        if (com.minimalistalliance.desk.deskd.courier.store.Accounts.IMESSAGE.equals(kind)) {
            if (count(kind) >= MAX_IMESSAGE) {
                throw new Refused("too_many");
            }
        } else if (linkedCount() >= MAX_LINKED) {
            throw new Refused("too_many");
        }
    }

    private long count(String kind) throws Refused {
        try {
            return store.accounts().stream().filter(a -> kind.equals(a.kind())).count();
        } catch (SQLException e) {
            throw new Refused("storage");
        }
    }

    /**
     * An existing account's new sign-in checked with its provider ("Sign in again"), before anything is kept: the same check
     * as {@link #check}, without counting the account as one more. {@code signIn} is the caller's to close.
     *
     * @throws Refused {@code no_transport}
     * @throws Rejected the provider's no
     * @throws IOException the provider couldn't be reached
     */
    public void recheck(Courier.Account account, SignIn signIn) throws Refused, Rejected, IOException, InterruptedException {
        Verifier verifier = verifiers.get(account.kind());
        if (verifier == null) {
            throw new Refused("no_transport");
        }
        verifier.verify(account.address(), signIn);
    }

    /**
     * Seals the sign-in durably, then writes the account's row, the commit point; if the row can't be written the sealed
     * file goes. {@code signIn} is the caller's to close.
     *
     * @throws Refused {@code too_many}, {@code exists}, {@code storage}
     */
    public void keep(Courier.Account account, List<String[]> ownAddresses, SignIn signIn) throws Refused {
        lock.lock();
        try {
            room(account.kind());
            if (account(account.id()) != null || vault.holds(account.id()) || sameMailbox(account) != null) {
                throw new Refused("exists");
            }
            try {
                vault.seal(account.id(), account.kind(), signIn);
            } catch (IOException e) {
                log.warn("courier vault: a sign-in couldn't be sealed ({})", e.getClass().getSimpleName());
                throw new Refused("storage");
            }
            try {
                store.putAccount(account, ownAddresses);
            } catch (SQLException | RuntimeException e) {
                try {
                    vault.delete(account.id());
                } catch (IOException ignored) {
                    // No row names it, so the next start removes it as an orphan.
                }
                log.warn("courier: a linked account's row couldn't be written ({})", e.getClass().getSimpleName());
                throw new Refused("storage");
            }
        } finally {
            lock.unlock();
        }
    }

    private long linkedCount() throws Refused {
        // Mailboxes only: the Mac's iMessage account has its own count (room).
        try {
            return store.accounts().stream()
                    .filter(a -> com.minimalistalliance.desk.deskd.courier.store.Accounts.LINKED.contains(a.kind())).count();
        } catch (SQLException e) {
            throw new Refused("storage");
        }
    }

    /**
     * Seals a changed sign-in over an account's own (an OAuth refresh, a new app password), atomically. Not checked again:
     * the transport that refreshed it just used it. {@code signIn} is closed whatever happens.
     */
    public void change(String accountId, SignIn signIn) throws Refused {
        try (signIn) {
            lock.lock();
            try {
                // Read under the lock, so a refresh racing the member's remove can't write the file back (Security CP-I4).
                Courier.Account a = account(accountId);
                if (a == null) {
                    throw new Refused("not_found");
                }
                vault.replace(accountId, a.kind(), signIn);
            } catch (IOException e) {
                log.warn("courier vault: a sign-in couldn't be resealed ({})", e.getClass().getSimpleName());
                throw new Refused("storage");
            } finally {
                lock.unlock();
            }
        }
    }

    /**
     * Removes a linked mailbox: its row (and its mail unless {@code keepMail}), then its sealed sign-in.
     *
     * @return whether there was such an account
     */
    public boolean remove(String accountId, boolean keepMail) throws SQLException {
        lock.lock();
        try {
            boolean had = store.removeAccount(accountId, keepMail);
            try {
                vault.delete(accountId);
            } catch (IOException e) {
                // The row is gone, so the next start removes the file as an orphan.
                log.warn("courier vault: a sign-in couldn't be unlinked yet ({}); the next start removes it", e.getClass().getSimpleName());
            }
            return had;
        } finally {
            lock.unlock();
        }
    }

    /**
     * An account's sign-in, for its transport, which closes it once used.
     *
     * @throws IOException if there's no such account, no sealed file, or it doesn't open (changed, cut, moved, another
     *     master key): the account reads as signed out
     */
    public SignIn open(String accountId) throws IOException {
        Courier.Account a = account(accountId);
        if (a == null || !com.minimalistalliance.desk.deskd.courier.store.Accounts.SEALED.contains(a.kind())) {
            throw new IOException("no such linked account");
        }
        return vault.open(accountId, a.kind());
    }

    /** Whether the account's sign-in is there and opens: what "Signed in as" shows, and what a transport needs. */
    public boolean signedIn(String accountId) {
        try (SignIn s = open(accountId)) {
            return s != null;
        } catch (IOException e) {
            return false;
        }
    }

    /** A linked mailbox already here with the same kind and address: one mailbox is linked once, or its mail comes twice. */
    public Courier.Account sameMailbox(Courier.Account account) {
        try {
            for (Courier.Account a : store.accounts()) {
                if (!a.id().equals(account.id()) && a.kind().equals(account.kind()) && a.address() != null
                        && a.address().equalsIgnoreCase(account.address())) {
                    return a;
                }
            }
            return null;
        } catch (SQLException e) {
            return null;
        }
    }

    private Courier.Account account(String accountId) {
        try {
            for (Courier.Account a : store.accounts()) {
                if (a.id().equals(accountId)) {
                    return a;
                }
            }
            return null;
        } catch (SQLException e) {
            return null;
        }
    }
}
