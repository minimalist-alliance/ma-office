package com.minimalistalliance.desk.deskd.courier.linked;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.LinkedState;
import com.minimalistalliance.desk.deskd.courier.store.Outbox;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import java.io.IOException;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A linked mailbox's sending half in the outbound queue (the launch plan §2.10): the member's message, built by
 * {@link MimeWriter}, submitted over SMTP to their own provider with their own sign-in, from the account's own address
 * (the From is pinned to it, never taken from a draft), then a copy filed in Sent where the provider doesn't keep one
 * itself. Only the queue calls it, and the queue only holds what the member sent: Courier never sends by itself.
 *
 * <p><b>A try that may have gone</b> (the connection lost after the message's end): the queue marks it, and the next try
 * first looks for its Message-ID in Sent and calls it sent if it's there. A provider that doesn't file sent mail itself
 * may then get it twice in that one window, which draft ADR §8 accepts; it's never lost.
 */
final class LinkedSender implements Outbox.Sender {

    private static final Logger log = LoggerFactory.getLogger(LinkedSender.class);

    private final LinkedMailboxes transport;
    private final String accountId;

    LinkedSender(LinkedMailboxes transport, String accountId) {
        this.transport = transport;
        this.accountId = accountId;
    }

    /**
     * One message's whole exchange with the provider (the Sent look, SMTP with a 25 MB upload and its 10-minute final reply,
     * the Sent copy) ends within this, so one slow server can't hold every account's queue (Security's CI-L2).
     */
    static final java.time.Duration SEND_DEADLINE = java.time.Duration.ofMinutes(15);

    @Override
    public Outbox.Result send(Outbox.Outgoing item) throws InterruptedException {
        try (Net.Deadline d = Net.Deadline.start(SEND_DEADLINE)) {
            return sendWithin(item);
        }
    }

    private Outbox.Result sendWithin(Outbox.Outgoing item) throws InterruptedException {
        if (!transport.sending()) {
            return new Outbox.Retry("switched_off");
        }
        if (!"email".equals(item.medium()) || !accountId.equals(item.accountId())) {
            return new Outbox.Failed("medium");
        }
        String from;
        try {
            Courier.Account a = transport.store().accounts().stream().filter(x -> x.id().equals(accountId)).findFirst().orElse(null);
            from = a == null ? null : MimeWriter.address(a.address());
        } catch (SQLException e) {
            return new Outbox.Retry("storage");
        }
        if (from == null) {
            return new Outbox.Failed("account");
        }
        SignIn signIn;
        try {
            signIn = transport.accounts().open(accountId);
        } catch (IOException e) {
            return new Outbox.Retry("sign_in");
        }
        try (signIn) {
            MailboxSync.Server srv = MailboxSync.Server.of(signIn.server());
            Providers.Provider p = Providers.byHost(srv.imapHost());
            if (srv.smtpHost() == null || p.oauth()) {
                return new Outbox.Failed("server");
            }
            if (item.maybeSentBefore() && item.rfcMessageId() != null) {
                Boolean there = inSent(srv, signIn, item.rfcMessageId());
                if (there == null) {
                    return new Outbox.Retry("sent_check");
                }
                if (there) {
                    return new Outbox.Sent(sentAll(item));
                }
            }
            Map<String, String> byAddress = new LinkedHashMap<>();
            Map<String, String> endpoints = new LinkedHashMap<>();
            Map<String, String> status = new LinkedHashMap<>();
            List<String> to = new ArrayList<>();
            for (Outbox.Recipient r : item.to()) {
                String a = MimeWriter.address(r.value());
                if (a == null) {
                    status.put(r.endpointId(), "refused");
                    continue;
                }
                if (byAddress.putIfAbsent(a, r.endpointId()) == null) {
                    to.add(a);
                }
                endpoints.put(r.endpointId(), a);
            }
            if (to.isEmpty()) {
                return new Outbox.Failed("recipients");
            }
            byte[] message = MimeWriter.write(from, item, transport.clock().instant());
            SmtpClient.Outcome outcome;
            SmtpClient smtp = SmtpClient.open(transport.net(), srv.smtpHost(), srv.smtpPort(), srv.smtpTls(), transport.settings().smtpTimeout());
            try {
                smtp.auth(signIn.username(), signIn.secret());
                outcome = smtp.send(from, to, message);
                if (outcome.kind() != SmtpClient.Outcome.Kind.UNCLEAR) {
                    smtp.quit();
                }
            } finally {
                smtp.close();
            }
            for (Map.Entry<String, String> e : endpoints.entrySet()) {
                String word = outcome.recipients().get(e.getValue());
                if (word != null) {
                    status.put(e.getKey(), word);
                }
            }
            switch (outcome.kind()) {
                case SENT -> {
                    if (!p.savesSent()) {
                        fileInSent(srv, signIn, message);
                    }
                    return new Outbox.Sent(status);
                }
                case UNCLEAR -> {
                    return new Outbox.Retry(outcome.error(), true);
                }
                case RETRY -> {
                    return new Outbox.Retry(outcome.error());
                }
                default -> {
                    return new Outbox.Failed(outcome.error());
                }
            }
        } catch (SmtpClient.SmtpException e) {
            if (e.getMessage().equals("sign_in") || e.getMessage().equals("app_password")) {
                transport.signInFailed(accountId);
            }
            return new Outbox.Retry(e.getMessage());
        } catch (Net.Refused e) {
            return new Outbox.Failed(e.reason());
        } catch (Net.TlsFailed e) {
            return new Outbox.Retry("tls");
        } catch (IOException e) {
            return new Outbox.Retry("unreachable");
        }
    }

    private static Map<String, String> sentAll(Outbox.Outgoing item) {
        Map<String, String> m = new LinkedHashMap<>();
        for (Outbox.Recipient r : item.to()) {
            m.put(r.endpointId(), "sent");
        }
        return m;
    }

    /** Whether the provider's Sent holds a message with this Message-ID; null if it couldn't be looked at. */
    private Boolean inSent(MailboxSync.Server srv, SignIn signIn, String rfcMessageId) {
        String id = rfcMessageId.strip();
        if (id.startsWith("<")) {
            id = id.substring(1, id.length() - 1);
        }
        if (!id.matches("[\\x21-\\x7E&&[^\"\\\\<>]]{1,250}")) {
            return null;
        }
        try (Session s = session(srv, signIn)) {
            String sent = s.sent;
            if (sent == null) {
                return false;
            }
            s.client.select(sent, 0, 0, null);
            return s.client.search("HEADER Message-ID \"<" + id + ">\"").length > 0;
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /** A copy in Sent, read, for a provider that doesn't file it itself. Best effort: the desk has the message either way. */
    private void fileInSent(MailboxSync.Server srv, SignIn signIn, byte[] message) {
        try (Session s = session(srv, signIn)) {
            if (s.sent != null) {
                s.client.append(s.sent, "\\Seen", message);
            }
        } catch (IOException | RuntimeException e) {
            // Never past here: the message went, so nothing may make the queue send it again (Security's CI-L1).
            log.info("courier imap {}: the Sent copy couldn't be filed ({})", accountId, e.getClass().getSimpleName());
        }
    }

    /** A short IMAP connection beside the sync's, for Sent. */
    private Session session(MailboxSync.Server srv, SignIn signIn) throws IOException {
        ImapClient c = ImapClient.open(transport.net(), srv.imapHost(), srv.imapPort(), transport.settings().sync().imap());
        try {
            c.login(signIn.username(), signIn.secret());
            String sent = null;
            for (ImapClient.Listed l : c.list()) {
                // A name this client can't send back (a server's raw UTF-8) is no Sent folder for it.
                if ((!Providers.skipped(l, false) || l.attributes().contains("\\sent")) && l.name().chars().allMatch(ch -> ch >= 0x20 && ch < 0x7F)) {
                    if (LinkedState.SENT.equals(Providers.role(l))) {
                        sent = l.name();
                        break;
                    }
                }
            }
            return new Session(c, sent);
        } catch (IOException | RuntimeException e) {
            c.close();
            throw e;
        }
    }

    private record Session(ImapClient client, String sent) implements AutoCloseable {
        @Override
        public void close() {
            client.logout();
        }
    }
}
