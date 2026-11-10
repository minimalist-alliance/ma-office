package com.minimalistalliance.desk.deskd.training;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.HexFormat;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;

/**
 * A throwaway certificate authority and a server certificate for "localhost", made on the spot, so the
 * training's TLS runs the code a real handshake does: RSA, as Platform's certificates are, checked up a chain
 * to a trust anchor. The JDK has no public API that writes a certificate, so this writes the DER itself.
 * Nothing here outlives the training. One RSA key signs both, as generating two takes a while on C1.
 */
final class TrainingPki {

    /** Made fresh for each run: the store it locks lives only as long as the training. */
    private static final char[] PASSWORD = randomPassword();
    private static final String SHA256_WITH_RSA = "SHA256withRSA";
    private static final byte[] ALGORITHM = der(0x30, hex("06092A864886F70D01010B"), hex("0500"));
    private static final byte[] COMMON_NAME_OID = hex("0603550403");
    private static final byte[] CRITICAL = hex("0101FF");
    private static final DateTimeFormatter UTC_TIME = DateTimeFormatter.ofPattern("yyMMddHHmmss'Z'").withZone(ZoneOffset.UTC);

    private final KeyPair keys;
    private final Certificate authority;
    private final Certificate server;

    private TrainingPki(KeyPair keys, Certificate authority, Certificate server) {
        this.keys = keys;
        this.authority = authority;
        this.server = server;
    }

    private static char[] randomPassword() {
        byte[] bytes = new byte[18];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).toCharArray();
    }

    static TrainingPki create() throws GeneralSecurityException, IOException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        KeyPair keys = generator.generateKeyPair();
        byte[] authorityExtensions = der(
                0x30,
                der(0x30, hex("0603551D13"), CRITICAL, der(0x04, hex("30030101FF"))),
                der(0x30, hex("0603551D0F"), CRITICAL, der(0x04, hex("03020106"))));
        byte[] serverExtensions = der(
                0x30,
                der(0x30, hex("0603551D0F"), CRITICAL, der(0x04, hex("030205A0"))),
                der(0x30, hex("0603551D25"), der(0x04, der(0x30, hex("06082B06010505070301")))),
                der(0x30, hex("0603551D11"), der(0x04, der(0x30, der(0x82, "localhost".getBytes(StandardCharsets.US_ASCII))))));
        Certificate authority = certificate(keys, BigInteger.ONE, "deskd training", "deskd training", authorityExtensions);
        Certificate server = certificate(keys, BigInteger.TWO, "deskd training", "localhost", serverExtensions);
        return new TrainingPki(keys, authority, server);
    }

    /** What the training's servers present. */
    SSLContext serverContext() throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, null);
        store.setKeyEntry("server", keys.getPrivate(), PASSWORD, new Certificate[] {server, authority});
        KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        managers.init(store, PASSWORD);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(managers.getKeyManagers(), null, null);
        return context;
    }

    /** deskd's one HTTP client takes the JDK's default trust, so this JVM's default has to be this authority. */
    void trustInThisJvm(Path file) throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, null);
        store.setCertificateEntry("authority", authority);
        try (OutputStream out = Files.newOutputStream(file)) {
            store.store(out, PASSWORD);
        }
        System.setProperty("javax.net.ssl.trustStore", file.toString());
        System.setProperty("javax.net.ssl.trustStoreType", "PKCS12");
        System.setProperty("javax.net.ssl.trustStorePassword", new String(PASSWORD));
    }

    private static Certificate certificate(KeyPair keys, BigInteger serial, String issuer, String subject, byte[] extensions)
            throws GeneralSecurityException {
        Instant now = Instant.now();
        byte[] body = der(
                0x30,
                hex("A003020102"),
                der(0x02, serial.toByteArray()),
                ALGORITHM,
                name(issuer),
                der(0x30, time(now.minus(Duration.ofHours(1))), time(now.plus(Duration.ofDays(1)))),
                name(subject),
                keys.getPublic().getEncoded(),
                der(0xA3, extensions));
        Signature signature = Signature.getInstance(SHA256_WITH_RSA);
        signature.initSign(keys.getPrivate());
        signature.update(body);
        byte[] whole = der(0x30, body, ALGORITHM, der(0x03, new byte[] {0}, signature.sign()));
        return CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(whole));
    }

    private static byte[] name(String commonName) {
        byte[] value = der(0x0C, commonName.getBytes(StandardCharsets.UTF_8));
        return der(0x30, der(0x31, der(0x30, COMMON_NAME_OID, value)));
    }

    private static byte[] time(Instant instant) {
        return der(0x17, UTC_TIME.format(instant).getBytes(StandardCharsets.US_ASCII));
    }

    private static byte[] hex(String value) {
        return HexFormat.of().parseHex(value);
    }

    /** One DER value: its tag, its length, and these parts one after the other. */
    private static byte[] der(int tag, byte[]... parts) {
        int length = 0;
        for (byte[] part : parts) {
            length += part.length;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(length + 4);
        out.write(tag);
        if (length < 0x80) {
            out.write(length);
        } else if (length < 0x100) {
            out.write(0x81);
            out.write(length);
        } else {
            out.write(0x82);
            out.write(length >> 8);
            out.write(length);
        }
        for (byte[] part : parts) {
            out.writeBytes(part);
        }
        return out.toByteArray();
    }
}
