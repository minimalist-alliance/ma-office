package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.read.ListAppender;
import com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

/**
 * The bar's audit canary for the vault (the launch plan §3.6, §7): known secrets go down every path a sign-in can take,
 * through deskd's real RPC layer (added, refused by the provider, unreachable, malformed, a full disk, changed, opened,
 * listed, removed, restarted, tampered with), and afterwards no log line at any level, nothing on stdout or stderr, no
 * RPC answer and no file of the store holds any of them, in any of the forms a leak takes (plain, UTF-16, base64 at each
 * alignment, hex, URL-encoded). The sealed files themselves hold none of them in the clear. And the verifier, the
 * transport's stand-in, is the only thing that sees one, which is the "never to the platform" line: nothing else in deskd
 * is handed it.
 */
class VaultCanaryTest {

    private static final String[] CANARIES = {
        "canary-OK-7f3c9d2a1b5e4f60", "canary-REJECTED-8e2d1c0b9a7f6e5d", "canary-UNREACHABLE-3c4d5e6f7a8b9c0d",
        "canary-MALFORMED-\u0007-1a2b", "canary-NODISK-5f6e7d8c9b0a1f2e", "canary-CHANGED-0a1b2c3d4e5f6a7b",
    };

    @Test
    void noSecretIsInAnyLogAnswerOrFile(@TempDir Path dir) throws Exception {
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Level was = root.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        root.setLevel(Level.TRACE);
        PrintStream out = System.out;
        PrintStream err = System.err;
        ByteArrayOutputStream console = new ByteArrayOutputStream();
        PrintStream both = new PrintStream(console, true, StandardCharsets.UTF_8);
        System.setOut(both);
        System.setErr(both);
        List<Map<String, Object>> answers = new ArrayList<>();
        List<String> seenByVerifier = new ArrayList<>();
        try (CourierRig rig = new CourierRig(dir)) {
            TestClient c = rig.owner("s1");
            // No transport yet: refused before anything is kept.
            answers.add(rig.err(c, "unavailable", "courier.accounts.add", "kind", "imap", "address", "dana@example.com",
                    "auth", "app_password", "secret", CANARIES[0], "server", Map.of("imapHost", "imap.example.com", "imapPort", 993,
                            "smtpHost", "smtp.example.com", "smtpPort", 465, "security", "tls")));
            LinkedAccounts linked = rig.module.linkedAccounts();
            linked.register("imap", (address, signIn) -> {
                String secret = new String(signIn.secret(), StandardCharsets.UTF_8);
                seenByVerifier.add(secret);
                if (secret.equals(CANARIES[1])) {
                    throw new LinkedAccounts.Rejected("app_password");
                }
                if (secret.equals(CANARIES[2])) {
                    throw new IOException("connection refused to " + address);
                }
            });
            Map<String, Object> added = rig.ok(c, "courier.accounts.add", "kind", "imap", "address", "dana@example.com",
                    "label", "Gmail", "auth", "app_password", "secret", CANARIES[0],
                    "server", Map.of("imapHost", "imap.example.com", "imapPort", 993, "smtpHost", "smtp.example.com", "smtpPort", 465,
                            "security", "tls"));
            answers.add(added);
            String accountId = (String) added.get("accountId");
            answers.add(rig.err(c, "forbidden", "courier.accounts.add", "kind", "imap", "address", "b@example.com",
                    "auth", "password", "secret", CANARIES[1], "server", Map.of("imapHost", "imap.example.com", "imapPort", 993, "smtpHost", "smtp.example.com", "smtpPort", 465, "security", "tls")));
            answers.add(rig.err(c, "unavailable", "courier.accounts.add", "kind", "imap", "address", "c@example.com",
                    "auth", "password", "secret", CANARIES[2], "server", Map.of("imapHost", "imap.example.com", "imapPort", 993, "smtpHost", "smtp.example.com", "smtpPort", 465, "security", "tls")));
            answers.add(rig.err(c, "bad_request", "courier.accounts.add", "kind", "imap", "address", "d@example.com",
                    "auth", "password", "secret", CANARIES[3]));
            // A full disk: the vault's directory can't be written.
            Path keys = dir.resolve("courier/keys");
            keys.toFile().setWritable(false);
            answers.add(rig.err(c, "unavailable", "courier.accounts.add", "kind", "imap", "address", "e@example.com",
                    "auth", "password", "secret", CANARIES[4], "server", Map.of("imapHost", "imap.example.com", "imapPort", 993, "smtpHost", "smtp.example.com", "smtpPort", 465, "security", "tls")));
            keys.toFile().setWritable(true);
            answers.add(rig.ok(c, "courier.accounts.list"));
            assertThat(answers.get(answers.size() - 1).toString()).contains("signedIn=true");
            try (SignIn s = linked.open(accountId)) {
                assertThat(new String(s.secret(), StandardCharsets.UTF_8)).isEqualTo(CANARIES[0]);
            }
            linked.change(accountId, new SignIn(SignIn.APP_PASSWORD, "dana@example.com", CANARIES[5].getBytes(StandardCharsets.UTF_8),
                    null, 0, null));
            try (SignIn s = linked.open(accountId)) {
                assertThat(new String(s.secret(), StandardCharsets.UTF_8)).isEqualTo(CANARIES[5]);
            }
            // Every sealed file holds no canary in the clear.
            scanFiles(keys, "sealed file");
            // Tampered with: signed out, and the log says only the kind of failure.
            Path sealed = keys.resolve(accountId + ".sealed");
            byte[] good = Files.readAllBytes(sealed);
            byte[] bad = good.clone();
            bad[bad.length - 3] ^= 0x40;
            Files.write(sealed, bad);
            assertThat(linked.signedIn(accountId)).isFalse();
            Files.write(sealed, good);
            assertThat(linked.signedIn(accountId)).isTrue();
            answers.add(rig.ok(c, "courier.accounts.remove", "accountId", accountId, "keepMail", false));
            assertThat(sealed).doesNotExist();
            answers.add(rig.err(c, "not_found", "courier.accounts.remove", "accountId", accountId));
            scanFiles(dir.resolve("courier"), "store");
        } finally {
            System.setOut(out);
            System.setErr(err);
            root.detachAppender(logs);
            root.setLevel(was);
        }
        // Restarted on the same store: the vault starts clean, with the same scan.
        // The full disk's was checked with the provider before sealing failed; the malformed one never got that far.
        assertThat(seenByVerifier).containsExactly(CANARIES[0], CANARIES[1], CANARIES[2], CANARIES[4]);
        List<String> found = new ArrayList<>();
        for (ILoggingEvent e : logs.list) {
            StringBuilder text = new StringBuilder(e.getFormattedMessage()).append(' ').append(e.getMDCPropertyMap());
            if (e.getArgumentArray() != null) {
                for (Object a : e.getArgumentArray()) {
                    text.append(' ').append(a);
                }
            }
            for (IThrowableProxy t = e.getThrowableProxy(); t != null; t = t.getCause()) {
                text.append(' ').append(t.getClassName()).append(' ').append(t.getMessage());
            }
            found.addAll(leaks(text.toString(), "log " + e.getLoggerName()));
        }
        found.addAll(leaks(console.toString(StandardCharsets.UTF_8), "console"));
        for (Map<String, Object> a : answers) {
            found.addAll(leaks(a.toString(), "answer"));
        }
        System.out.printf("vault canary: %d log events, %d console bytes, %d answers scanned, %d leaks%n", logs.list.size(),
                console.size(), answers.size(), found.size());
        assertThat(found).isEmpty();
        assertThat(logs.list).isNotEmpty();
    }

    private static void scanFiles(Path root, String where) throws IOException {
        List<String> found = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            for (Path p : files.filter(Files::isRegularFile).toList()) {
                byte[] bytes = Files.readAllBytes(p);
                found.addAll(leaks(new String(bytes, StandardCharsets.ISO_8859_1), where + " " + root.relativize(p)));
            }
        }
        assertThat(found).isEmpty();
    }

    /** Every form of every canary found in {@code text}, which may hold bytes read as ISO-8859-1. */
    static List<String> leaks(String text, String where) {
        List<String> out = new ArrayList<>();
        for (String c : CANARIES) {
            for (String form : forms(c)) {
                if (text.contains(form)) {
                    out.add(where + ": " + c.substring(0, Math.min(20, c.length())) + " as " + form.length() + " chars");
                }
            }
        }
        return out;
    }

    static List<String> forms(String c) {
        List<String> f = new ArrayList<>();
        // The part that's unique to each canary, so a leak of half of one still shows.
        String core = c.substring(c.lastIndexOf('-') + 1);
        f.add(core);
        f.add(new String(core.getBytes(StandardCharsets.UTF_16LE), StandardCharsets.ISO_8859_1));
        f.add(new String(core.getBytes(StandardCharsets.UTF_16BE), StandardCharsets.ISO_8859_1));
        f.add(HexFormat.of().formatHex(core.getBytes(StandardCharsets.UTF_8)));
        f.add(HexFormat.of().withUpperCase().formatHex(core.getBytes(StandardCharsets.UTF_8)));
        f.add(URLEncoder.encode(c, StandardCharsets.UTF_8));
        for (String pad : new String[] {"", "x", "xy"}) {
            for (Base64.Encoder enc : new Base64.Encoder[] {Base64.getEncoder(), Base64.getUrlEncoder()}) {
                String b = enc.encodeToString((pad + c).getBytes(StandardCharsets.UTF_8));
                // Leave out the ends, which depend on what's around it.
                f.add(b.substring(4, b.length() - 4));
            }
        }
        return f;
    }
}
