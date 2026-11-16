package com.minimalistalliance.desk.courier.testkit;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.FakeSmtpServer.Extension;
import com.minimalistalliance.desk.courier.testkit.FakeSmtpServer.Options;
import com.minimalistalliance.desk.courier.testkit.FakeSmtpServer.Received;
import com.minimalistalliance.desk.courier.testkit.FakeSmtpServer.Stage;
import jakarta.mail.Message;
import jakarta.mail.Session;
import jakarta.mail.Transport;
import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeMessage;
import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Properties;
import java.util.Set;
import javax.net.ssl.SSLSocket;
import org.junit.jupiter.api.Test;

/** {@link FakeSmtpServer} driven over raw sockets, and by Jakarta Mail as a second opinion. */
class FakeSmtpServerTest {

    static final String USER = "alice@example.com";
    static final String PW = "pw-alice";

    /** A raw SMTP conversation: a reply is every line up to the one with a space after its code. */
    static final class RawSmtp implements AutoCloseable {
        private final Socket raw;
        private Socket socket;
        private InputStream in;
        private OutputStream out;
        final String greeting;

        RawSmtp(int port, boolean tls) throws IOException {
            raw = new Socket(InetAddress.getLoopbackAddress(), port);
            raw.setSoTimeout(15_000);
            socket = raw;
            if (tls) {
                socket = handshake(raw);
            }
            streams();
            greeting = reply();
        }

        private static Socket handshake(Socket raw) throws IOException {
            SSLSocket s = (SSLSocket) FakeTls.clientContext().getSocketFactory().createSocket(raw, "127.0.0.1", raw.getPort(), true);
            s.setUseClientMode(true);
            s.startHandshake();
            return s;
        }

        private void streams() throws IOException {
            in = new BufferedInputStream(socket.getInputStream());
            out = socket.getOutputStream();
        }

        void startTls() throws IOException {
            assertThat(cmd("STARTTLS")).startsWith("220 ");
            socket = handshake(raw);
            streams();
        }

        String cmd(String line) throws IOException {
            send(line + "\r\n");
            return reply();
        }

        void send(String text) throws IOException {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
        }

        /** A whole reply, its lines joined with \n. */
        String reply() throws IOException {
            StringBuilder b = new StringBuilder();
            while (true) {
                String l = line();
                if (l == null) {
                    throw new IOException("closed; so far: " + b);
                }
                if (!b.isEmpty()) {
                    b.append('\n');
                }
                b.append(l);
                if (l.length() < 4 || l.charAt(3) == ' ') {
                    return b.toString();
                }
            }
        }

        String line() throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            int c;
            while ((c = in.read()) != -1) {
                if (c == '\n') {
                    String s = b.toString(StandardCharsets.UTF_8);
                    return s.endsWith("\r") ? s.substring(0, s.length() - 1) : s;
                }
                b.write(c);
            }
            return null;
        }

        boolean closedByServer() {
            try {
                return in.read() == -1;
            } catch (SocketTimeoutException e) {
                return false;
            } catch (IOException e) {
                return true;
            }
        }

        void login() throws IOException {
            assertThat(cmd("EHLO client.test")).startsWith("250-");
            assertThat(cmd("AUTH PLAIN " + plain(USER, PW))).startsWith("235 ");
        }

        @Override
        public void close() throws IOException {
            socket.close();
            raw.close();
        }
    }

    static String plain(String user, String pass) {
        return Base64.getEncoder().encodeToString(("\0" + user + "\0" + pass).getBytes(StandardCharsets.UTF_8));
    }

    static String b64(String s) {
        return Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }

    static FakeSmtpServer server(Options o) {
        FakeSmtpServer s = FakeSmtpServer.start(o);
        s.addUser(USER, PW);
        return s;
    }

    @Test
    void startTlsModeRefusesAuthBeforeTlsThenTakesAMessageExactly() throws Exception {
        try (FakeSmtpServer s = server(Options.startTls()); RawSmtp c = new RawSmtp(s.port(), false)) {
            assertThat(c.greeting).startsWith("220 smtp.fake.test ESMTP");
            assertThat(c.cmd("MAIL FROM:<" + USER + ">")).startsWith("503 5.5.1");
            String ehlo = c.cmd("EHLO client.test");
            assertThat(ehlo.split("\n")).containsExactly("250-smtp.fake.test at your service, [127.0.0.1]", "250-SIZE 35882577", "250-8BITMIME",
                "250-STARTTLS", "250-PIPELINING", "250 SMTPUTF8");
            assertThat(c.cmd("AUTH PLAIN " + plain(USER, PW))).isEqualTo("530 5.7.0 Must issue a STARTTLS command first");
            assertThat(c.cmd("MAIL FROM:<" + USER + ">")).isEqualTo("530 5.7.0 Must issue a STARTTLS command first");
            c.startTls();
            assertThat(c.cmd("AUTH PLAIN " + plain(USER, PW))).startsWith("503 5.5.1");
            String again = c.cmd("EHLO client.test");
            assertThat(again.split("\n")).containsExactly("250-smtp.fake.test at your service, [127.0.0.1]", "250-SIZE 35882577", "250-8BITMIME",
                "250-AUTH PLAIN LOGIN", "250-PIPELINING", "250 SMTPUTF8");
            assertThat(c.cmd("STARTTLS")).startsWith("503 ");
            assertThat(c.cmd("AUTH PLAIN " + plain(USER, "wrong"))).isEqualTo("535 5.7.8 Username and Password not accepted.");
            assertThat(c.cmd("AUTH PLAIN " + plain(USER, PW))).isEqualTo("235 2.7.0 Accepted");
            assertThat(c.cmd("MAIL FROM:<" + USER + "> SIZE=120 BODY=8BITMIME")).isEqualTo("250 2.1.0 OK");
            assertThat(c.cmd("RCPT TO:<bob@example.org>")).isEqualTo("250 2.1.5 OK");
            assertThat(c.cmd("RCPT TO:<carol@example.net>")).isEqualTo("250 2.1.5 OK");
            assertThat(c.cmd("DATA")).startsWith("354 ");
            c.send("Subject: dots\r\n\r\n..one\r\n...two\r\nplain\r\n.not stuffed by a careless client\r\n.\r\n");
            assertThat(c.reply()).startsWith("250 2.0.0 OK");
            assertThat(c.cmd("QUIT")).startsWith("221 ");
        }
    }

    @Test
    void capturesWhatWasAcceptedWithItsEnvelopeAndLogin() throws Exception {
        try (FakeSmtpServer s = server(Options.startTls())) {
            try (RawSmtp c = new RawSmtp(s.port(), false)) {
                c.cmd("EHLO client.test");
                c.startTls();
                c.login();
                c.cmd("MAIL FROM:<" + USER + "> SIZE=120 SMTPUTF8");
                c.cmd("RCPT TO:<bob@example.org>");
                c.cmd("RCPT TO:<carol@example.net>");
                c.cmd("DATA");
                c.send("Subject: dots\r\n\r\n..one\r\n...two\r\nplain\r\n.\r\n");
                assertThat(c.reply()).startsWith("250 ");
            }
            assertThat(s.received()).hasSize(1);
            Received r = s.received().get(0);
            assertThat(r.login()).isEqualTo(USER);
            assertThat(r.from()).isEqualTo(USER);
            assertThat(r.recipients()).containsExactly("bob@example.org", "carol@example.net");
            assertThat(r.mailParameters()).containsExactly("SIZE=120", "SMTPUTF8");
            assertThat(r.tls()).isTrue();
            assertThat(new String(r.data(), StandardCharsets.UTF_8)).isEqualTo("Subject: dots\r\n\r\n.one\r\n..two\r\nplain\r\n");
            assertThat(s.logins()).isEqualTo(1);
            assertThat(s.commandCount("STARTTLS")).isEqualTo(1);
        }
    }

    @Test
    void implicitTlsWithAuthLoginAndPlainWithoutAnInitialResponse() throws Exception {
        try (FakeSmtpServer s = server(Options.implicitTls())) {
            try (RawSmtp c = new RawSmtp(s.port(), true)) {
                String ehlo = c.cmd("EHLO client.test");
                assertThat(ehlo).contains("250-AUTH PLAIN LOGIN").doesNotContain("STARTTLS");
                assertThat(c.cmd("STARTTLS")).startsWith("503 ");
                assertThat(c.cmd("AUTH LOGIN")).isEqualTo("334 VXNlcm5hbWU6");
                assertThat(c.cmd(b64(USER))).isEqualTo("334 UGFzc3dvcmQ6");
                assertThat(c.cmd(b64("wrong"))).isEqualTo("535 5.7.8 Username and Password not accepted.");
                assertThat(c.cmd("AUTH LOGIN " + b64(USER))).isEqualTo("334 UGFzc3dvcmQ6");
                assertThat(c.cmd(b64(PW))).isEqualTo("235 2.7.0 Accepted");
                assertThat(c.cmd("AUTH LOGIN")).startsWith("503 ");
            }
            try (RawSmtp c = new RawSmtp(s.port(), true)) {
                c.cmd("EHLO client.test");
                assertThat(c.cmd("AUTH PLAIN")).isEqualTo("334 ");
                assertThat(c.cmd("*")).startsWith("501 ");
                assertThat(c.cmd("AUTH PLAIN")).isEqualTo("334 ");
                assertThat(c.cmd(plain(USER, PW))).isEqualTo("235 2.7.0 Accepted");
                assertThat(c.cmd("AUTH CRAM-MD5")).startsWith("503 ");
            }
            try (RawSmtp c = new RawSmtp(s.port(), true)) {
                c.cmd("EHLO client.test");
                assertThat(c.cmd("AUTH CRAM-MD5")).startsWith("504 ");
                assertThat(c.cmd("MAIL FROM:<" + USER + ">")).startsWith("530 5.7.0 Authentication Required");
            }
            assertThat(s.logins()).isEqualTo(2);
        }
    }

    @Test
    void pipelinedCommandsAreAnsweredInOrder() throws Exception {
        try (FakeSmtpServer s = server(Options.plain()); RawSmtp c = new RawSmtp(s.port(), false)) {
            assertThat(c.cmd("EHLO client.test")).contains("250-AUTH PLAIN LOGIN").contains("PIPELINING").doesNotContain("STARTTLS");
            c.send("AUTH PLAIN " + plain(USER, PW) + "\r\nMAIL FROM:<" + USER + ">\r\nRCPT TO:<b@example.org>\r\nRCPT TO:<c@example.org>\r\nDATA\r\n");
            assertThat(List.of(c.reply(), c.reply(), c.reply(), c.reply(), c.reply()))
                .containsExactly("235 2.7.0 Accepted", "250 2.1.0 OK", "250 2.1.5 OK", "250 2.1.5 OK", "354 Go ahead");
            c.send("Subject: p\r\n\r\nx\r\n.\r\nRSET\r\nNOOP\r\nQUIT\r\n");
            assertThat(List.of(c.reply(), c.reply(), c.reply(), c.reply())).extracting(r -> r.substring(0, 3)).containsExactly("250", "250", "250", "221");
            assertThat(s.received()).extracting(Received::recipients).containsExactly(List.of("b@example.org", "c@example.org"));
        }
    }

    @Test
    void jakartaMailSendsOverBothTlsModes() throws Exception {
        try (FakeSmtpServer implicit = server(Options.implicitTls()); FakeSmtpServer starttls = server(Options.startTls())) {
            Properties p = new Properties();
            p.put("mail.smtps.ssl.socketFactory", FakeTls.clientContext().getSocketFactory());
            p.put("mail.smtps.ssl.checkserveridentity", "false");
            p.put("mail.smtp.starttls.enable", "true");
            p.put("mail.smtp.starttls.required", "true");
            p.put("mail.smtp.ssl.socketFactory", FakeTls.clientContext().getSocketFactory());
            p.put("mail.smtp.ssl.checkserveridentity", "false");
            p.put("mail.smtp.auth", "true");
            p.put("mail.smtps.auth", "true");
            Session session = Session.getInstance(p);
            for (String proto : List.of("smtps", "smtp")) {
                FakeSmtpServer s = proto.equals("smtps") ? implicit : starttls;
                MimeMessage m = new MimeMessage(session);
                m.setFrom(new InternetAddress(USER));
                m.setRecipient(Message.RecipientType.TO, new InternetAddress("bob@example.org"));
                m.setSubject("Over " + proto, "UTF-8");
                m.setText(".a line with a leading dot\nand a second", "UTF-8");
                m.saveChanges();
                try (Transport t = session.getTransport(proto)) {
                    t.connect("127.0.0.1", s.port(), USER, PW);
                    t.sendMessage(m, m.getAllRecipients());
                }
                assertThat(s.received()).hasSize(1);
                Received r = s.received().get(0);
                assertThat(r.tls()).isTrue();
                assertThat(r.login()).isEqualTo(USER);
                MimeMessage back = new MimeMessage(session, new ByteArrayInputStream(r.data()));
                assertThat(back.getSubject()).isEqualTo("Over " + proto);
                assertThat(((String) back.getContent()).replace("\r\n", "\n")).isEqualTo(".a line with a leading dot\nand a second\n");
                assertThat(new String(r.data(), StandardCharsets.UTF_8)).contains("\r\n.a line with a leading dot\r\n").endsWith("and a second\r\n");
            }
        }
    }

    @Test
    void theHookPutsSentMailInAFakeImapSentFolder() throws Exception {
        try (FakeSmtpServer smtp = server(Options.implicitTls()); FakeImapServer imap = FakeImapServer.start(FakeImapServer.Options.gmail())) {
            imap.addUser(USER, PW);
            smtp.onMessage(r -> imap.deliver(r.login(), "[Gmail]/Sent Mail", r.data(), Set.of("\\Seen"), null));
            try (RawSmtp c = new RawSmtp(smtp.port(), true)) {
                c.login();
                c.cmd("MAIL FROM:<" + USER + ">");
                c.cmd("RCPT TO:<bob@example.org>");
                c.cmd("DATA");
                c.send("Message-ID: <sent1@example.com>\r\nSubject: sent\r\n\r\nhi\r\n.\r\n");
                assertThat(c.reply()).startsWith("250 ");
                assertThat(imap.messages(USER, "[Gmail]/Sent Mail")).hasSize(1);
                FakeImapServer.Message m = imap.messages(USER, "[Gmail]/All Mail").get(0);
                assertThat(m.labels()).containsExactly("\\Sent");
                assertThat(m.bytes()).isEqualTo("Message-ID: <sent1@example.com>\r\nSubject: sent\r\n\r\nhi\r\n".getBytes(StandardCharsets.UTF_8));
                smtp.onMessage(r -> {
                    throw new IllegalStateException("no");
                });
                c.cmd("MAIL FROM:<" + USER + ">");
                c.cmd("RCPT TO:<bob@example.org>");
                c.cmd("DATA");
                c.send("Subject: x\r\n\r\nx\r\n.\r\n");
                assertThat(c.reply()).startsWith("451 4.3.0");
                assertThat(smtp.received()).hasSize(1);
            }
        }
    }

    @Test
    void faultsAtEachStage() throws Exception {
        try (FakeSmtpServer s = server(Options.plain().maxSize(1_000))) {
            s.failAt(Stage.MAIL, 1, "451 4.7.0 Try again later");
            s.failRcpt("Nobody@Example.org", "550 5.1.1 No such user");
            s.failAt(Stage.DATA, 1, "554 5.7.0 Rejected");
            s.failAt(Stage.END_OF_DATA, 1, "552 5.2.3 Message too big for this test");
            try (RawSmtp c = new RawSmtp(s.port(), false)) {
                c.login();
                assertThat(c.cmd("MAIL FROM:<" + USER + ">")).isEqualTo("451 4.7.0 Try again later");
                assertThat(c.cmd("MAIL FROM:<" + USER + "> SIZE=2000")).isEqualTo("552 5.3.4 Message size exceeds fixed limit.");
                assertThat(c.cmd("MAIL FROM:<" + USER + "> X-FOO=1")).startsWith("555 ");
                assertThat(c.cmd("MAIL FROM:<" + USER + ">")).isEqualTo("250 2.1.0 OK");
                assertThat(c.cmd("RCPT TO:<nobody@example.org>")).isEqualTo("550 5.1.1 No such user");
                assertThat(c.cmd("RCPT TO:<bob@example.org>")).isEqualTo("250 2.1.5 OK");
                assertThat(c.cmd("DATA")).isEqualTo("554 5.7.0 Rejected");
                assertThat(c.cmd("DATA")).startsWith("354 ");
                c.send("Subject: one\r\n\r\nx\r\n.\r\n");
                assertThat(c.reply()).isEqualTo("552 5.2.3 Message too big for this test");
                c.cmd("MAIL FROM:<" + USER + ">");
                c.cmd("RCPT TO:<bob@example.org>");
                c.cmd("DATA");
                c.send("Subject: big\r\n\r\n" + "y".repeat(2_000) + "\r\n.\r\n");
                assertThat(c.reply()).isEqualTo("552 5.3.4 Message size exceeds fixed limit.");
                c.cmd("MAIL FROM:<" + USER + ">");
                c.cmd("RCPT TO:<nobody@example.org>");
                assertThat(c.cmd("DATA")).startsWith("503 ");
                c.cmd("RCPT TO:<bob@example.org>");
                c.cmd("DATA");
                c.send("Subject: two\r\n\r\nx\r\n.\r\n");
                assertThat(c.reply()).startsWith("250 ");
            }
            assertThat(s.received()).extracting(r -> new String(r.data(), StandardCharsets.UTF_8)).containsExactly("Subject: two\r\n\r\nx\r\n");
            assertThat(s.received().get(0).recipients()).containsExactly("bob@example.org");

            s.clearReceived();
            s.dropAfterData(1, false);
            try (RawSmtp c = new RawSmtp(s.port(), false)) {
                c.login();
                c.cmd("MAIL FROM:<" + USER + ">");
                c.cmd("RCPT TO:<bob@example.org>");
                c.cmd("DATA");
                c.send("Subject: lost\r\n\r\nx\r\n.\r\n");
                assertThat(c.closedByServer()).isTrue();
            }
            assertThat(s.received()).isEmpty();
            s.dropAfterData(1, true);
            try (RawSmtp c = new RawSmtp(s.port(), false)) {
                c.login();
                c.cmd("MAIL FROM:<" + USER + ">");
                c.cmd("RCPT TO:<bob@example.org>");
                c.cmd("DATA");
                c.send("Subject: went\r\n\r\nx\r\n.\r\n");
                assertThat(c.closedByServer()).isTrue();
            }
            assertThat(s.received()).extracting(r -> new String(r.data(), StandardCharsets.UTF_8)).containsExactly("Subject: went\r\n\r\nx\r\n");

            s.refuseAuth("454 4.7.0 Temporary authentication failure");
            s.delayReplies(Duration.ofMillis(300));
            long t0 = System.nanoTime();
            try (RawSmtp c = new RawSmtp(s.port(), false)) {
                c.cmd("EHLO client.test");
                assertThat(c.cmd("AUTH PLAIN " + plain(USER, PW))).isEqualTo("454 4.7.0 Temporary authentication failure");
            }
            assertThat(Duration.ofNanos(System.nanoTime() - t0)).isGreaterThanOrEqualTo(Duration.ofMillis(900));
            s.clearFaults();
            try (RawSmtp c = new RawSmtp(s.port(), false)) {
                c.login();
                s.dropConnections();
                assertThat(c.closedByServer()).isTrue();
            }
        }
    }

    @Test
    void extensionsCanBeTurnedOff() throws Exception {
        try (FakeSmtpServer s = server(Options.startTls().without(Extension.SMTPUTF8, Extension.PIPELINING, Extension.SIZE, Extension.EIGHTBITMIME,
            Extension.STARTTLS)); RawSmtp c = new RawSmtp(s.port(), false)) {
            assertThat(c.cmd("EHLO client.test")).isEqualTo("250 smtp.fake.test at your service, [127.0.0.1]");
            assertThat(c.cmd("STARTTLS")).startsWith("502 ");
            assertThat(c.cmd("HELO client.test")).startsWith("250 ");
        }
        try (FakeSmtpServer s = server(Options.plain().without(Extension.SMTPUTF8, Extension.AUTH).requireAuth(false));
             RawSmtp c = new RawSmtp(s.port(), false)) {
            assertThat(c.cmd("EHLO client.test")).doesNotContain("SMTPUTF8").doesNotContain("AUTH");
            assertThat(c.cmd("AUTH PLAIN " + plain(USER, PW))).startsWith("502 ");
            assertThat(c.cmd("MAIL FROM:<" + USER + "> SMTPUTF8")).isEqualTo("555 5.5.4 Unsupported option: SMTPUTF8");
            assertThat(c.cmd("MAIL FROM:<>")).isEqualTo("250 2.1.0 OK");
            assertThat(c.cmd("MAIL FROM:<x@y>")).startsWith("503 ");
            assertThat(c.cmd("RSET")).startsWith("250 ");
            assertThat(c.cmd("FROB")).startsWith("502 ");
        }
    }
}
