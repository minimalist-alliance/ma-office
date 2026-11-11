package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.function.Supplier;

/**
 * The Platform's two public routes for apps (the Desk Engineer's review, "For the Platform Engineer"): no auth, so a fetch
 * says nothing about whose desk it is beyond an address, and the CDN keeps no access log for them (section 6.5).
 * <ul>
 *   <li>{@code GET /v1/public/apps/catalog}: the signed envelope, at most 4 MiB, or 404 while there's none.
 *   <li>{@code GET /v1/public/apps/packages/<packageSha256>}: the package's bytes, or a 302, 303 or 307 to an {@code https}
 *       URL that has them (a presigned link to storage). One redirect is followed, no more.
 * </ul>
 * Nothing from either is trusted until it verifies: the catalog by a review key, the package by its hash and signatures.
 */
final class PlatformAppSource implements CatalogKeeper.Source {

    static final String CATALOG = "/v1/public/apps/catalog";
    static final String PACKAGES = "/v1/public/apps/packages/";
    private static final Duration TIMEOUT = Duration.ofSeconds(30);
    /** A package download that makes no progress this long is given up. */
    private static final Duration STALL = Duration.ofSeconds(30);

    private final PlatformHttp http;
    private final Supplier<String> apiBase;

    PlatformAppSource(PlatformHttp http, Supplier<String> apiBase) {
        this.http = http;
        this.apiBase = apiBase;
    }

    @Override
    public byte[] fetchCatalog() throws IOException, InterruptedException {
        String base = apiBase.get();
        if (base == null) {
            throw new IOException("no API base yet");
        }
        HttpRequest request = HttpRequest.newBuilder(URI.create(base + CATALOG)).timeout(TIMEOUT).header("accept", "application/json").GET().build();
        HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream(), TIMEOUT);
        try (InputStream body = response.body()) {
            if (response.statusCode() == 404) {
                return null;
            }
            if (response.statusCode() != 200) {
                throw new IOException("HTTP " + response.statusCode());
            }
            byte[] bytes = body.readNBytes(AppCatalog.MAX_BYTES + 1);
            if (bytes.length > AppCatalog.MAX_BYTES) {
                throw new IOException("catalog too large");
            }
            return bytes;
        }
    }

    @Override
    public InputStream openPackage(String packageSha256) throws IOException, InterruptedException {
        String base = apiBase.get();
        if (base == null) {
            throw new IOException("no API base yet");
        }
        URI uri = URI.create(base + PACKAGES + packageSha256);
        for (int hop = 0; hop < 2; hop++) {
            HttpRequest request = HttpRequest.newBuilder(uri).timeout(TIMEOUT).GET().build();
            HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream(), TIMEOUT);
            int status = response.statusCode();
            if (status == 200) {
                return new Watched(response.body());
            }
            response.body().close();
            if (hop == 0 && (status == 302 || status == 303 || status == 307)) {
                String location = response.headers().firstValue("location").orElse("");
                URI next = URI.create(location);
                if (!"https".equals(next.getScheme())) {
                    throw new IOException("redirect not to https");
                }
                uri = next;
                continue;
            }
            throw new IOException("HTTP " + status);
        }
        throw new IOException("too many redirects");
    }

    /** Closes itself when a read makes no progress for {@link #STALL}, so a stalled download fails instead of hanging. */
    private static final class Watched extends FilterInputStream {
        private volatile long lastProgress = System.nanoTime();
        private volatile boolean closed;
        private final Thread watchdog;

        Watched(InputStream in) {
            super(in);
            watchdog = Thread.ofVirtual().name("app-download-watch").start(() -> {
                try {
                    while (!closed) {
                        Thread.sleep(1000);
                        if (System.nanoTime() - lastProgress > STALL.toNanos()) {
                            close();
                            return;
                        }
                    }
                } catch (InterruptedException | IOException e) {
                    // Done either way.
                }
            });
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            lastProgress = System.nanoTime();
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, len);
            lastProgress = System.nanoTime();
            return n;
        }

        @Override
        public void close() throws IOException {
            closed = true;
            watchdog.interrupt();
            super.close();
        }
    }
}
