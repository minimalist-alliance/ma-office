package com.minimalistalliance.desk.courier.testkit;

import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManagerFactory;

/**
 * TLS for {@link FakeImapServer} and {@link FakeSmtpServer}: GreenMail's bundled self-signed test certificate, read from
 * {@code greenmail.p12} on the classpath (in the GreenMail jar). Its subject is {@code CN=GreenMail selfsigned Test
 * Certificate}, with no subject alternative names, so a client must trust it explicitly ({@link #clientContext()}) and
 * must not check the host name against it. Test use only: the key is public.
 */
public final class FakeTls {

    /** The PKCS#12 keystore's resource name, in GreenMail's jar. */
    public static final String KEYSTORE_RESOURCE = "greenmail.p12";

    /** The keystore's password and its key's (GreenMail's {@code greenmail.tls.keystore.password} default). */
    public static final String KEYSTORE_PASSWORD = "changeit";

    /** The key's alias in the keystore. */
    public static final String KEY_ALIAS = "greenmail";

    private FakeTls() {
    }

    /** GreenMail's keystore, loaded fresh. */
    public static KeyStore keyStore() {
        try (InputStream in = FakeTls.class.getClassLoader().getResourceAsStream(KEYSTORE_RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException(KEYSTORE_RESOURCE + " isn't on the classpath (it comes in GreenMail's jar)");
            }
            KeyStore ks = KeyStore.getInstance("PKCS12");
            ks.load(in, KEYSTORE_PASSWORD.toCharArray());
            return ks;
        } catch (IOException | GeneralSecurityException e) {
            throw new IllegalStateException("can't load " + KEYSTORE_RESOURCE, e);
        }
    }

    /** The servers' certificate. */
    public static X509Certificate certificate() {
        try {
            return (X509Certificate) keyStore().getCertificate(KEY_ALIAS);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** What the fake servers serve TLS with. */
    public static SSLContext serverContext() {
        try {
            KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            kmf.init(keyStore(), KEYSTORE_PASSWORD.toCharArray());
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(kmf.getKeyManagers(), null, null);
            return ctx;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * A client context that trusts the servers' certificate and nothing else. The certificate names no host, so the
     * client must leave host name verification off (an {@link SSLSocket}'s default; Jakarta Mail's
     * {@code mail.imaps.ssl.checkserveridentity=false}).
     */
    public static SSLContext clientContext() {
        try {
            KeyStore trust = KeyStore.getInstance("PKCS12");
            trust.load(null, null);
            trust.setCertificateEntry(KEY_ALIAS, certificate());
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(trust);
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, tmf.getTrustManagers(), null);
            return ctx;
        } catch (IOException | GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Server-side TLS over an accepted socket, the handshake done. Closing the result closes {@code raw}. */
    static SSLSocket serverSide(SSLContext ctx, Socket raw) throws IOException {
        SSLSocket s = (SSLSocket) ctx.getSocketFactory().createSocket(raw, raw.getInetAddress().getHostAddress(), raw.getPort(), true);
        s.setUseClientMode(false);
        s.startHandshake();
        return s;
    }
}
