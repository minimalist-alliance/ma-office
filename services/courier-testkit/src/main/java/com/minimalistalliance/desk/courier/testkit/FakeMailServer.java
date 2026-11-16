package com.minimalistalliance.desk.courier.testkit;

import com.icegreen.greenmail.imap.ImapHostManager;
import com.icegreen.greenmail.store.FolderException;
import com.icegreen.greenmail.store.MailFolder;
import com.icegreen.greenmail.store.StoredMessage;
import com.icegreen.greenmail.user.GreenMailUser;
import com.icegreen.greenmail.util.GreenMail;
import com.icegreen.greenmail.util.ServerSetup;
import jakarta.mail.Flags;
import jakarta.mail.MessagingException;
import jakarta.mail.Session;
import jakarta.mail.internet.MimeMessage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Properties;

/**
 * A fake mail provider in the test's own JVM: GreenMail's IMAP and SMTP, plain and over TLS with GreenMail's own test
 * certificate, all on 127.0.0.1 and on ports the system picks. For the linked-mailbox transport's tests (wave 2.1).
 *
 * <p>Messages are kept as GreenMail keeps them, as {@link MimeMessage}s. So what IMAP serves for a message, and what
 * {@link #received} returns, is the raw bytes with the header section's line endings made CRLF, and a blank line added
 * where there was none; the body's bytes are untouched. {@link #stored} says exactly what that is for any input. SMTP adds
 * a {@code Received} header in front, as a real server does. The README has what GreenMail's IMAP doesn't do.
 */
public final class FakeMailServer implements AutoCloseable {

    private static final Session SESSION = Session.getInstance(new Properties());

    private final GreenMail greenMail;

    private FakeMailServer(GreenMail greenMail) {
        this.greenMail = greenMail;
    }

    /** Starts IMAP, SMTP, IMAPS and SMTPS on 127.0.0.1, each on a free port. */
    public static FakeMailServer start() {
        ServerSetup[] setups = {
            setup(ServerSetup.PROTOCOL_IMAP), setup(ServerSetup.PROTOCOL_SMTP), setup(ServerSetup.PROTOCOL_IMAPS), setup(ServerSetup.PROTOCOL_SMTPS),
        };
        GreenMail gm = new GreenMail(setups);
        gm.start();
        return new FakeMailServer(gm);
    }

    private static ServerSetup setup(String protocol) {
        ServerSetup s = new ServerSetup(0, "127.0.0.1", protocol).dynamicPort();
        s.setServerStartupTimeout(10_000);
        return s;
    }

    public int imapPort() {
        return greenMail.getImap().getPort();
    }

    public int smtpPort() {
        return greenMail.getSmtp().getPort();
    }

    /** IMAP over TLS, with GreenMail's self-signed test certificate: a client must trust it explicitly. */
    public int imapsPort() {
        return greenMail.getImaps().getPort();
    }

    /** SMTP over TLS, with the same certificate. */
    public int smtpsPort() {
        return greenMail.getSmtps().getPort();
    }

    /** A mailbox: mail to {@code address} reaches it, and IMAP and SMTP accept {@code login} and {@code password}. */
    public void addUser(String address, String login, String password) {
        greenMail.setUser(address, login, password);
    }

    /** {@code raw} into that user's INBOX, as IMAP will serve it ({@link #stored}). An unknown address gets a user whose login and password are the address. */
    public void deliver(String toAddress, byte[] raw) {
        deliver(toAddress, "INBOX", raw);
    }

    /** {@code raw} into that user's {@code folder}, which is made if it isn't there (a path in the server's own hierarchy, "." between names). */
    public void deliver(String toAddress, String folder, byte[] raw) {
        GreenMailUser user = user(toAddress);
        try {
            folder(user, folder).appendMessage(parse(raw), new Flags(), new Date());
        } catch (FolderException e) {
            throw new IllegalStateException("folder " + folder + ": " + e.getMessage(), e);
        }
    }

    /**
     * What reached that user through SMTP or {@link #deliver} and is still there: every folder's messages, folders in name
     * order with INBOX first, each folder in UID order, as IMAP would serve them. None for an unknown address.
     */
    public List<byte[]> received(String toAddress) {
        GreenMailUser user = greenMail.getUserManager().getUserByEmail(toAddress);
        if (user == null) {
            return List.of();
        }
        ImapHostManager imap = greenMail.getManagers().getImapHostManager();
        List<MailFolder> folders;
        try {
            folders = new ArrayList<>(imap.listMailboxes(user, "*"));
        } catch (FolderException e) {
            throw new IllegalStateException(e);
        }
        folders.sort(Comparator.comparing((MailFolder f) -> !f.getName().equalsIgnoreCase("INBOX")).thenComparing(MailFolder::getFullName));
        List<byte[]> out = new ArrayList<>();
        for (MailFolder f : folders) {
            List<StoredMessage> messages = new ArrayList<>(f.getMessages());
            messages.sort(Comparator.comparingLong(StoredMessage::getUid));
            for (StoredMessage m : messages) {
                out.add(bytes(m.getMimeMessage()));
            }
        }
        return out;
    }

    /** GreenMail itself: for flags, moves between folders, expunges and the like in an IMAP client's tests. */
    public GreenMail greenMail() {
        return greenMail;
    }

    /**
     * Gives {@code folder} a new UIDVALIDITY with the same messages, flags and dates, as a server does when it renumbers.
     * GreenMail's UIDVALIDITY is the second a folder was made, so this waits for the next second and makes it again. INBOX
     * can only be made again with the whole account, so for INBOX every folder of the user gets a new one. A folder with
     * folders inside isn't supported. Returns the new UIDVALIDITY.
     */
    public long resetUidValidity(String address, String folder) {
        GreenMailUser user = greenMail.getUserManager().getUserByEmail(address);
        if (user == null) {
            throw new IllegalArgumentException("no user " + address);
        }
        ImapHostManager imap = greenMail.getManagers().getImapHostManager();
        try {
            String prefix = imap.getInbox(user).getFullName();
            prefix = prefix.substring(0, prefix.length() - "INBOX".length());
            boolean inbox = folder.equalsIgnoreCase("INBOX");
            List<MailFolder> targets = new ArrayList<>();
            if (inbox) {
                targets.addAll(imap.listMailboxes(user, "*"));
            } else {
                MailFolder f = imap.getFolder(user, folder);
                if (f == null) {
                    throw new IllegalArgumentException("no folder " + folder);
                }
                targets.add(f);
            }
            record Kept(byte[] raw, Flags flags, Date received) {
            }
            List<String> names = new ArrayList<>();
            List<List<Kept>> kept = new ArrayList<>();
            long newest = 0;
            for (MailFolder f : targets) {
                names.add(f.getFullName().substring(prefix.length()));
                List<Kept> messages = new ArrayList<>();
                List<StoredMessage> stored = new ArrayList<>(f.getMessages());
                stored.sort(Comparator.comparingLong(StoredMessage::getUid));
                for (StoredMessage m : stored) {
                    messages.add(new Kept(bytes(m.getMimeMessage()), new Flags(m.getFlags()), m.getReceivedDate()));
                }
                kept.add(messages);
                newest = Math.max(newest, f.getUidValidity());
            }
            while (System.currentTimeMillis() / 1000 <= newest) {
                Thread.sleep(50);
            }
            if (inbox) {
                imap.deletePrivateMailAccount(user);
                imap.createPrivateMailAccount(user);
            } else {
                imap.deleteMailbox(user, names.get(0));
            }
            long validity = 0;
            for (int i = 0; i < names.size(); i++) {
                MailFolder f = folder(user, names.get(i));
                for (Kept k : kept.get(i)) {
                    f.appendMessage(parse(k.raw()), k.flags(), k.received());
                }
                if (names.get(i).equalsIgnoreCase(folder)) {
                    validity = f.getUidValidity();
                }
            }
            return validity;
        } catch (FolderException | com.icegreen.greenmail.imap.AuthorizationException e) {
            throw new IllegalStateException("folder " + folder + ": " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    /** What GreenMail keeps and serves for {@code raw}: the header section's line endings CRLF, the body as it was. */
    public static byte[] stored(byte[] raw) {
        return bytes(parse(raw));
    }

    @Override
    public void close() {
        greenMail.stop();
    }

    private GreenMailUser user(String address) {
        GreenMailUser user = greenMail.getUserManager().getUserByEmail(address);
        return user != null ? user : greenMail.setUser(address, address, address);
    }

    private MailFolder folder(GreenMailUser user, String name) throws FolderException {
        ImapHostManager imap = greenMail.getManagers().getImapHostManager();
        if (name.equalsIgnoreCase("INBOX")) {
            return imap.getInbox(user);
        }
        MailFolder f = imap.getFolder(user, name);
        if (f != null) {
            return f;
        }
        try {
            return imap.createMailbox(user, name);
        } catch (com.icegreen.greenmail.imap.AuthorizationException e) {
            throw new IllegalStateException(e);
        }
    }

    private static MimeMessage parse(byte[] raw) {
        try {
            return new MimeMessage(SESSION, new ByteArrayInputStream(raw));
        } catch (MessagingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] bytes(MimeMessage m) {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            m.writeTo(out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } catch (MessagingException e) {
            throw new IllegalStateException(e);
        }
    }
}
