package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * An instance metadata service on 127.0.0.1 that hands deskd's {@code RoleCredentials} one fixed set of credentials: a
 * self-hosted desk's session on staging, for the staging proof. Never logs or prints them.
 */
final class StaticImds implements AutoCloseable {

    private static final String TOKEN = "proof-imds-token";

    private final HttpServer server;

    StaticImds(String accessKeyId, String secretAccessKey, String sessionToken, String expiration) throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 8);
        server.createContext("/", x -> answer(x, accessKeyId, secretAccessKey, sessionToken, expiration));
        server.start();
    }

    String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static void answer(HttpExchange x, String id, String secret, String token, String expiration) throws IOException {
        String path = x.getRequestURI().getPath();
        String body;
        int status = 200;
        if (path.equals("/latest/api/token")) {
            body = TOKEN;
        } else if (!TOKEN.equals(x.getRequestHeaders().getFirst("X-aws-ec2-metadata-token"))) {
            status = 401;
            body = "";
        } else if (path.equals("/latest/meta-data/iam/security-credentials/")) {
            body = "proof";
        } else if (path.equals("/latest/meta-data/iam/security-credentials/proof")) {
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("Code", "Success");
            c.put("AccessKeyId", id);
            c.put("SecretAccessKey", secret);
            c.put("Token", token);
            c.put("Expiration", expiration);
            body = new String(Json.bytes(c), StandardCharsets.UTF_8);
        } else {
            status = 404;
            body = "";
        }
        byte[] out = body.getBytes(StandardCharsets.UTF_8);
        x.sendResponseHeaders(status, out.length == 0 ? -1 : out.length);
        try (OutputStream o = x.getResponseBody()) {
            o.write(out);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
