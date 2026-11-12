package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.GZIPOutputStream;

/**
 * Keys, manifests, signatures, packages and catalogs made in the test, with keys generated fresh for each run: no key is
 * committed anywhere. A test review key stands in for MA's, a test developer key for a publisher's.
 */
final class TestApps {

    static final String ID = "org.example.tally";
    static final String PUBLISHER = "Example Publisher";

    final KeyPair review = ed25519();
    final KeyPair developer = ed25519();
    final String arch = AppsModule.deskArch();

    static KeyPair ed25519() {
        try {
            return KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static KeyPair p256() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"));
            return generator.generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] sign(PrivateKey key, byte[] data) {
        try {
            Signature s = Signature.getInstance(key.getAlgorithm().equals("EC") ? "SHA256withECDSA" : "Ed25519");
            s.initSign(key);
            s.update(data);
            return s.sign();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    AppKeys.TrustedKey reviewKey(String tier) {
        return new AppKeys.TrustedKey(AppKeys.keyId(review.getPublic()), review.getPublic(), AppKeys.REVIEW, tier, null);
    }

    static String pem(java.security.PublicKey key) {
        return "-----BEGIN PUBLIC KEY-----\n" + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(key.getEncoded())
                + "\n-----END PUBLIC KEY-----\n";
    }

    static String sha(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- an app

    /** A small app's files: an executable (never run: the fake host stands in), and a window's three files. */
    static Map<String, byte[]> files() {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("bin/tally", "#!/bin/sh\nexit 0\n".getBytes(StandardCharsets.UTF_8));
        files.put("view/index.html", "<main id=\"n\">0</main>".getBytes(StandardCharsets.UTF_8));
        files.put("view/view.js", "// the bridge\n".getBytes(StandardCharsets.UTF_8));
        files.put("view/view.css", "main{font:16px Nunito}".getBytes(StandardCharsets.UTF_8));
        return files;
    }

    /** Tally's manifest, as the sample has it, with the files' hashes filled in. */
    Map<String, Object> manifest(String version, Map<String, byte[]> files) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("manifest", 1);
        m.put("id", ID);
        m.put("name", "Tally");
        m.put("version", version);
        m.put("publisher", PUBLISHER);
        m.put("description", "Counts things.");
        m.put("source", "https://example.org/tally");
        m.put("license", "Apache-2.0");
        m.put("appApi", ">=1.0 <2");
        m.put("arch", arch);
        m.put("run", new LinkedHashMap<>(Map.of("exec", List.of("bin/tally"), "start", "on-demand", "startTimeoutSec", 3, "stopTimeoutSec", 2)));
        m.put("resources", new LinkedHashMap<>(Map.of("memoryMaxMiB", 32, "cpuMax", 0.25, "tasksMax", 16, "diskMaxMiB", 16)));
        m.put("permissions", new ArrayList<>());
        m.put("views", new LinkedHashMap<>(Map.of("window", new LinkedHashMap<>(Map.of(
                "html", "view/index.html", "script", "view/view.js", "style", "view/view.css",
                "width", 360, "height", 280, "minWidth", 280, "minHeight", 200)), "widget", true)));
        m.put("methods", List.of(Map.of("name", "tally.get", "mutation", false), Map.of("name", "tally.add", "mutation", true),
                Map.of("name", "tally.reset", "mutation", true)));
        m.put("topics", List.of("tally"));
        Map<String, Object> list = new LinkedHashMap<>();
        for (Map.Entry<String, byte[]> f : files.entrySet()) {
            list.put(f.getKey(), Map.of("sha256", sha(f.getValue()), "size", f.getValue().length,
                    "mode", f.getKey().startsWith("bin/") ? "0755" : "0644"));
        }
        m.put("files", list);
        return m;
    }

    // ---- a bundled app

    /** The id of the app tests bundle: Tally again, as a first-party app in deskd's image. */
    static final String BUNDLED_ID = "com.minimalistalliance.sample.tally";

    /** Lays out a bundled app as the image's build does: {@code <root>/<id>/ma-app.json}, with every file's hash, and {@code files/}. */
    Path bundle(Path root, String version) throws IOException {
        return bundle(root, version, files(), m -> {});
    }

    /** A bundled Tally that also keeps notes per member, for a guild desk ({@link FakeApp}'s {@code notes.*}). */
    Path bundleWithNotes(Path root, String version) throws IOException {
        return bundle(root, version, files(), m -> {
            List<Object> methods = new ArrayList<>((List<?>) m.get("methods"));
            methods.add(Map.of("name", "notes.put", "mutation", true));
            methods.add(Map.of("name", "notes.list", "mutation", false));
            m.put("methods", methods);
            m.put("topics", List.of("tally", "notes"));
        });
    }

    Path bundle(Path root, String version, Map<String, byte[]> files, java.util.function.Consumer<Map<String, Object>> edit)
            throws IOException {
        Map<String, Object> m = manifest(version, files);
        m.put("id", BUNDLED_ID);
        m.put("publisher", "Minimalist Alliance");
        edit.accept(m);
        Path dir = root.resolve((String) m.get("id"));
        Path filesDir = dir.resolve(BundledApps.FILES);
        java.nio.file.Files.createDirectories(filesDir);
        for (Map.Entry<String, byte[]> f : files.entrySet()) {
            Path file = filesDir.resolve(f.getKey());
            java.nio.file.Files.createDirectories(file.getParent());
            java.nio.file.Files.write(file, f.getValue());
            java.nio.file.Files.setPosixFilePermissions(file, java.nio.file.attribute.PosixFilePermissions.fromString(
                    f.getKey().startsWith("bin/") ? "rwxr-xr-x" : "rw-r--r--"));
        }
        java.nio.file.Files.write(dir.resolve(BundledApps.MANIFEST), Json.bytes(m));
        // As the image's build leaves them, whatever this machine's umask: no group or other write.
        java.nio.file.Files.setPosixFilePermissions(root, java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"));
        try (java.util.stream.Stream<Path> all = java.nio.file.Files.walk(dir)) {
            for (Path p : all.toList()) {
                if (java.nio.file.Files.isDirectory(p)) {
                    java.nio.file.Files.setPosixFilePermissions(p, java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"));
                } else if (p.getFileName().toString().equals(BundledApps.MANIFEST)) {
                    java.nio.file.Files.setPosixFilePermissions(p, java.nio.file.attribute.PosixFilePermissions.fromString("rw-r--r--"));
                }
            }
        }
        return dir;
    }

    byte[] signatures(byte[] manifest, KeyPair developerKey, KeyPair reviewKey) {
        List<Map<String, Object>> sigs = new ArrayList<>();
        if (developerKey != null) {
            sigs.add(Map.of("role", "developer", "keyId", AppKeys.keyId(developerKey.getPublic()),
                    "sig", Base64.getEncoder().encodeToString(sign(developerKey.getPrivate(), manifest))));
        }
        if (reviewKey != null) {
            sigs.add(Map.of("role", "review", "keyId", AppKeys.keyId(reviewKey.getPublic()),
                    "sig", Base64.getEncoder().encodeToString(sign(reviewKey.getPrivate(), manifest))));
        }
        return Json.bytes(Map.of("signatures", sigs));
    }

    /** One built package: its bytes, and what the catalog says of it. */
    record Built(byte[] bytes, byte[] manifest, String version, List<String> permissions, int diskMaxMiB) {
        String sha256() {
            return sha(bytes);
        }

        String manifestSha256() {
            return sha(manifest);
        }
    }

    Built build(String version) {
        return build(manifest(version, files()), files());
    }

    Built build(Map<String, Object> manifest, Map<String, byte[]> files) {
        byte[] m = Json.bytes(manifest);
        List<Entry> entries = new ArrayList<>();
        entries.add(Entry.file(PackageReader.MANIFEST, m));
        entries.add(Entry.file(PackageReader.SIGNATURES, signatures(m, developer, review)));
        for (Map.Entry<String, byte[]> f : files.entrySet()) {
            entries.add(Entry.file("files/" + f.getKey(), f.getValue()));
        }
        @SuppressWarnings("unchecked")
        List<String> permissions = (List<String>) manifest.get("permissions");
        @SuppressWarnings("unchecked")
        Map<String, Object> resources = (Map<String, Object>) manifest.get("resources");
        return new Built(tarGz(entries), m, (String) manifest.get("version"), permissions, (Integer) resources.get("diskMaxMiB"));
    }

    // ---- the catalog

    byte[] catalog(long seq, List<Built> versions, List<String> revokedKeys, List<String> revokedPackages) {
        List<Map<String, Object>> list = new ArrayList<>();
        for (Built b : versions) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("version", b.version());
            v.put("arch", arch);
            v.put("packageSha256", b.sha256());
            v.put("manifestSha256", b.manifestSha256());
            v.put("bytes", b.bytes().length);
            v.put("appApi", ">=1.0 <2");
            v.put("permissions", b.permissions());
            v.put("net", List.of());
            v.put("resources", Map.of("diskMaxMiB", b.diskMaxMiB()));
            v.put("notes", "Reviewed.");
            list.add(v);
        }
        Map<String, Object> index = new LinkedHashMap<>();
        index.put("catalog", 1);
        index.put("seq", seq);
        index.put("issuedAt", "2026-11-11T00:00:00Z");
        index.put("developers", List.of(Map.of("keyId", AppKeys.keyId(developer.getPublic()), "publisher", PUBLISHER,
                "publicKey", Base64.getEncoder().encodeToString(developer.getPublic().getEncoded()))));
        index.put("revoked", Map.of("keys", revokedKeys, "packages", revokedPackages));
        index.put("apps", List.of(Map.of("id", ID, "name", "Tally", "publisher", PUBLISHER, "description", "Counts things.",
                "versions", list)));
        return envelope(Json.bytes(index), review);
    }

    static byte[] envelope(byte[] index, KeyPair key) {
        return Json.bytes(Map.of("index", Base64.getEncoder().encodeToString(index), "signatures",
                List.of(Map.of("keyId", AppKeys.keyId(key.getPublic()), "sig", Base64.getEncoder().encodeToString(sign(key.getPrivate(), index))))));
    }

    /** Serves a catalog and packages from memory, as the Platform's routes would. */
    static final class Source implements CatalogKeeper.Source {
        volatile byte[] catalog;
        final Map<String, byte[]> packages = new ConcurrentHashMap<>();
        volatile int catalogFetches;

        @Override
        public byte[] fetchCatalog() {
            catalogFetches++;
            return catalog;
        }

        @Override
        public InputStream openPackage(String sha) throws IOException {
            byte[] bytes = packages.get(sha);
            if (bytes == null) {
                throw new IOException("HTTP 404");
            }
            return new java.io.ByteArrayInputStream(bytes);
        }

        void serve(Built b) {
            packages.put(b.sha256(), b.bytes());
        }
    }

    // ---- tar

    record Entry(String name, byte type, byte[] data, int mode, String linkName) {
        static Entry file(String name, byte[] data) {
            return new Entry(name, (byte) '0', data, name.startsWith("files/bin/") ? 0755 : 0644, "");
        }

        static Entry directory(String name) {
            return new Entry(name, (byte) '5', new byte[0], 0755, "");
        }

        static Entry symlink(String name, String target) {
            return new Entry(name, (byte) '2', new byte[0], 0777, target);
        }
    }

    static byte[] tarGz(List<Entry> entries) {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (GZIPOutputStream gz = new GZIPOutputStream(bytes)) {
                gz.write(tar(entries));
            }
            return bytes.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] tar(List<Entry> entries) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (Entry e : entries) {
            byte[] name = e.name().getBytes(StandardCharsets.UTF_8);
            if (name.length > 100) {
                String body = " path=" + e.name() + "\n";
                int base = body.getBytes(StandardCharsets.UTF_8).length;
                int total = base + String.valueOf(base).length();
                if (String.valueOf(total).length() != String.valueOf(base).length()) {
                    total = base + String.valueOf(total).length();
                }
                byte[] pax = (total + body).getBytes(StandardCharsets.UTF_8);
                out.write(header("PaxHeaders/x", (byte) 'x', pax.length, 0644, ""));
                out.write(pax);
                out.write(new byte[pad(pax.length)]);
                out.write(header("long-name-placeholder", e.type(), e.data().length, e.mode(), e.linkName()));
            } else {
                out.write(header(e.name(), e.type(), e.data().length, e.mode(), e.linkName()));
            }
            out.write(e.data());
            out.write(new byte[pad(e.data().length)]);
        }
        out.write(new byte[1024]);
        return out.toByteArray();
    }

    static int pad(int length) {
        return (512 - (length % 512)) % 512;
    }

    static byte[] header(String name, byte type, long size, int mode, String linkName) {
        byte[] h = new byte[512];
        put(h, 0, name.getBytes(StandardCharsets.UTF_8), 100);
        put(h, 100, String.format("%07o\0", mode).getBytes(StandardCharsets.US_ASCII), 8);
        put(h, 108, "0001750\0".getBytes(StandardCharsets.US_ASCII), 8);
        put(h, 116, "0001750\0".getBytes(StandardCharsets.US_ASCII), 8);
        put(h, 124, String.format("%011o\0", size).getBytes(StandardCharsets.US_ASCII), 12);
        put(h, 136, String.format("%011o\0", 0).getBytes(StandardCharsets.US_ASCII), 12);
        h[156] = type;
        put(h, 157, linkName.getBytes(StandardCharsets.UTF_8), 100);
        put(h, 257, "ustar\0".getBytes(StandardCharsets.US_ASCII), 6);
        put(h, 263, "00".getBytes(StandardCharsets.US_ASCII), 2);
        for (int i = 148; i < 156; i++) {
            h[i] = ' ';
        }
        long sum = 0;
        for (byte b : h) {
            sum += b & 0xff;
        }
        put(h, 148, String.format("%06o\0 ", sum).getBytes(StandardCharsets.US_ASCII), 8);
        return h;
    }

    private static void put(byte[] h, int offset, byte[] value, int max) {
        System.arraycopy(value, 0, h, offset, Math.min(value.length, max));
    }
}
