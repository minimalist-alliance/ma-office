package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The package's layout, its hashes and its signatures, as deskd checks them while it streams. */
class PackageReaderTest {

    @TempDir
    Path dir;

    private final TestApps apps = new TestApps();

    /** As the installer checks a manifest: both signatures, then the rules, for a community review key. */
    private PackageReader.Verifier verifier(KeyPair reviewKey, Set<String> revokedKeys) {
        AppKeys.TrustedKey review = new AppKeys.TrustedKey(AppKeys.keyId(reviewKey.getPublic()), reviewKey.getPublic(), AppKeys.REVIEW,
                AppManifest.COMMUNITY, null);
        AppKeys.TrustedKey developer = new AppKeys.TrustedKey(AppKeys.keyId(apps.developer.getPublic()), apps.developer.getPublic(),
                AppKeys.DEVELOPER, null, TestApps.PUBLISHER);
        return (manifest, sigs) -> {
            AppManifest m;
            try {
                m = AppManifest.parse(manifest);
            } catch (AppManifest.ManifestException e) {
                throw new InstallException("manifest");
            }
            String tier;
            try {
                tier = AppKeys.verifyPackage(manifest, AppKeys.parseSignatures(sigs), m.publisher(), List.of(review), List.of(developer), revokedKeys);
            } catch (SecurityException | IllegalArgumentException e) {
                throw new InstallException("signature");
            }
            if (!m.problems(tier, apps.arch, AppsModule.APP_API).isEmpty()) {
                throw new InstallException("manifest");
            }
            return m;
        };
    }

    private PackageReader.Result read(byte[] pkg) throws Exception {
        return read(pkg, verifier(apps.review, Set.of()));
    }

    private PackageReader.Result read(byte[] pkg, PackageReader.Verifier verifier) throws Exception {
        Path staging = Files.createTempDirectory(dir, "staging");
        return PackageReader.read(new ByteArrayInputStream(pkg), pkg.length, TestApps.sha(pkg), verifier, staging);
    }

    private Path lastStaging() throws Exception {
        try (Stream<Path> s = Files.list(dir)) {
            return s.filter(p -> p.getFileName().toString().startsWith("staging")).sorted().reduce((a, b) -> b).orElseThrow();
        }
    }

    private List<TestApps.Entry> entries(TestApps.Built b) {
        Map<String, byte[]> files = TestApps.files();
        List<TestApps.Entry> list = new ArrayList<>();
        list.add(TestApps.Entry.file(PackageReader.MANIFEST, b.manifest()));
        list.add(TestApps.Entry.file(PackageReader.SIGNATURES, apps.signatures(b.manifest(), apps.developer, apps.review)));
        for (Map.Entry<String, byte[]> f : files.entrySet()) {
            list.add(TestApps.Entry.file("files/" + f.getKey(), f.getValue()));
        }
        return list;
    }

    @Test
    void aGoodPackageUnpacksWithItsModesAndTheSignedBytes() throws Exception {
        TestApps.Built b = apps.build("1.0.0");
        PackageReader.Result r = read(b.bytes());
        Path staging = lastStaging();
        assertThat(r.manifestBytes()).isEqualTo(b.manifest());
        assertThat(Files.readAllBytes(staging.resolve("ma-app.json"))).isEqualTo(b.manifest());
        assertThat(Files.readString(staging.resolve("files/view/view.css"))).isEqualTo("main{font:16px Nunito}");
        assertThat(Files.getPosixFilePermissions(staging.resolve("files/bin/tally"))).contains(PosixFilePermission.OWNER_EXECUTE);
        assertThat(Files.getPosixFilePermissions(staging.resolve("files/view/index.html"))).doesNotContain(PosixFilePermission.OWNER_EXECUTE)
                .contains(PosixFilePermission.OTHERS_READ);
    }

    @Test
    void directoryEntriesAndPaxLongNamesAreFine() throws Exception {
        String longPath = "view/" + "a".repeat(120) + ".txt";
        Map<String, byte[]> files = TestApps.files();
        files.put(longPath, "long".getBytes());
        Map<String, Object> manifest = apps.manifest("1.0.0", files);
        byte[] m = Json.bytes(manifest);
        List<TestApps.Entry> list = new ArrayList<>();
        list.add(TestApps.Entry.file(PackageReader.MANIFEST, m));
        list.add(TestApps.Entry.file(PackageReader.SIGNATURES, apps.signatures(m, apps.developer, apps.review)));
        list.add(TestApps.Entry.directory("files/"));
        list.add(TestApps.Entry.directory("files/view/"));
        for (Map.Entry<String, byte[]> f : files.entrySet()) {
            list.add(TestApps.Entry.file("files/" + f.getKey(), f.getValue()));
        }
        read(TestApps.tarGz(list));
        assertThat(Files.readString(lastStaging().resolve("files").resolve(longPath))).isEqualTo("long");
    }

    @Test
    void nothingIsWrittenBeforeTheSignaturesPass() throws Exception {
        TestApps.Built b = apps.build("1.0.0");
        KeyPair stranger = TestApps.ed25519();
        assertThatThrownBy(() -> read(b.bytes(), verifier(stranger, Set.of())))
                .isInstanceOf(InstallException.class).hasMessage("signature");
        try (Stream<Path> s = Files.walk(lastStaging())) {
            assertThat(s.filter(Files::isRegularFile)).isEmpty();
        }
    }

    @Test
    void developerAndReviewSignaturesAreBothNeeded() throws Exception {
        TestApps.Built b = apps.build("1.0.0");
        List<TestApps.Entry> onlyDeveloper = entries(b);
        onlyDeveloper.set(1, TestApps.Entry.file(PackageReader.SIGNATURES, apps.signatures(b.manifest(), apps.developer, null)));
        assertThatThrownBy(() -> read(TestApps.tarGz(onlyDeveloper))).hasMessage("signature");

        List<TestApps.Entry> onlyReview = entries(b);
        onlyReview.set(1, TestApps.Entry.file(PackageReader.SIGNATURES, apps.signatures(b.manifest(), null, apps.review)));
        assertThatThrownBy(() -> read(TestApps.tarGz(onlyReview))).hasMessage("signature");

        // A developer key registered to another publisher doesn't count.
        KeyPair other = TestApps.ed25519();
        List<TestApps.Entry> wrongDeveloper = entries(b);
        wrongDeveloper.set(1, TestApps.Entry.file(PackageReader.SIGNATURES, apps.signatures(b.manifest(), other, apps.review)));
        assertThatThrownBy(() -> read(TestApps.tarGz(wrongDeveloper))).hasMessage("signature");
    }

    @Test
    void aRevokedKeyFails() throws Exception {
        TestApps.Built b = apps.build("1.0.0");
        assertThatThrownBy(() -> read(b.bytes(), verifier(apps.review, Set.of(AppKeys.keyId(apps.review.getPublic())))))
                .hasMessage("signature");
    }

    @Test
    void aManifestEditedAfterSigningFails() throws Exception {
        TestApps.Built b = apps.build("1.0.0");
        List<TestApps.Entry> list = entries(b);
        byte[] edited = new String(b.manifest()).replace("\"Tally\"", "\"Tallx\"").getBytes();
        list.set(0, TestApps.Entry.file(PackageReader.MANIFEST, edited));
        assertThatThrownBy(() -> read(TestApps.tarGz(list))).hasMessage("signature");
    }

    @Test
    void aTamperedFileFailsOnItsHash() throws Exception {
        TestApps.Built b = apps.build("1.0.0");
        List<TestApps.Entry> list = entries(b);
        list.set(3, TestApps.Entry.file("files/view/index.html", "<main id=\"n\">1</main>".getBytes()));
        assertThatThrownBy(() -> read(TestApps.tarGz(list))).hasMessage("hash");
    }

    @Test
    void layoutsThatBreakTheRulesAreRefused() throws Exception {
        TestApps.Built b = apps.build("1.0.0");
        Map<String, List<TestApps.Entry>> cases = new LinkedHashMap<>();
        List<TestApps.Entry> extra = entries(b);
        extra.add(TestApps.Entry.file("files/extra.txt", "x".getBytes()));
        cases.put("a file not in the manifest", extra);
        List<TestApps.Entry> missing = entries(b);
        missing.remove(missing.size() - 1);
        cases.put("a manifest file missing", missing);
        List<TestApps.Entry> link = entries(b);
        link.add(TestApps.Entry.symlink("files/view/x", "/data/browser"));
        cases.put("a symlink", link);
        List<TestApps.Entry> dotdot = entries(b);
        dotdot.add(TestApps.Entry.file("files/../escape", "x".getBytes()));
        cases.put("..", dotdot);
        List<TestApps.Entry> absolute = entries(b);
        absolute.add(TestApps.Entry.file("/etc/cron.d/x", "x".getBytes()));
        cases.put("an absolute path", absolute);
        List<TestApps.Entry> duplicate = entries(b);
        duplicate.add(duplicate.get(2));
        cases.put("a duplicate", duplicate);
        List<TestApps.Entry> late = entries(b);
        late.add(0, late.remove(2));
        cases.put("a file before the manifest", late);
        List<TestApps.Entry> outside = entries(b);
        outside.add(TestApps.Entry.file("other/x", "x".getBytes()));
        cases.put("outside files/", outside);
        List<TestApps.Entry> device = entries(b);
        device.add(new TestApps.Entry("files/dev", (byte) '3', new byte[0], 0644, ""));
        cases.put("a device", device);
        for (Map.Entry<String, List<TestApps.Entry>> c : cases.entrySet()) {
            assertThatThrownBy(() -> read(TestApps.tarGz(c.getValue()))).as(c.getKey()).isInstanceOf(InstallException.class)
                    .satisfies(e -> assertThat(((InstallException) e).reason()).isIn("package", "hash"));
        }
    }

    @Test
    void theWholePackageMustBeWhatTheCatalogSaid() throws Exception {
        TestApps.Built b = apps.build("1.0.0");
        Path staging = Files.createTempDirectory(dir, "staging");
        assertThatThrownBy(() -> PackageReader.read(new ByteArrayInputStream(b.bytes()), b.bytes().length, "0".repeat(64),
                verifier(apps.review, Set.of()), staging)).hasMessage("hash");
        byte[] longer = java.util.Arrays.copyOf(b.bytes(), b.bytes().length + 10);
        Path staging2 = Files.createTempDirectory(dir, "staging");
        assertThatThrownBy(() -> PackageReader.read(new ByteArrayInputStream(longer), b.bytes().length, b.sha256(),
                verifier(apps.review, Set.of()), staging2)).hasMessage("hash");
    }

    @Test
    void garbageIsAPackageError() {
        byte[] junk = "not a package".getBytes();
        assertThatThrownBy(() -> read(junk)).hasMessage("package");
    }

    @Test
    void p256KeysVerifyAsEd25519OnesDo() {
        KeyPair ec = TestApps.p256();
        byte[] data = "manifest".getBytes();
        assertThat(AppKeys.verify(ec.getPublic(), data, TestApps.sign(ec.getPrivate(), data))).isTrue();
        assertThat(AppKeys.verify(ec.getPublic(), "other".getBytes(), TestApps.sign(ec.getPrivate(), data))).isFalse();
        assertThat(AppKeys.keyId(ec.getPublic())).hasSize(16);
    }

    @Test
    void reviewKeysComeFromPemFilesNamedByTier() throws Exception {
        Path keys = Files.createDirectories(dir.resolve("app-keys"));
        Files.writeString(keys.resolve("community.ma-review-1.pem"), TestApps.pem(apps.review.getPublic()));
        Files.writeString(keys.resolve("first-party.ma-review-2.pem"), TestApps.pem(TestApps.p256().getPublic()));
        Files.writeString(keys.resolve("README"), "not a key");
        Files.writeString(keys.resolve("community.broken.pem"), "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n");
        Files.writeString(keys.resolve("root.ma-review-3.pem"), TestApps.pem(TestApps.ed25519().getPublic()));
        List<AppKeys.TrustedKey> loaded = AppKeys.loadReviewKeys(List.of(keys, dir.resolve("missing")));
        assertThat(loaded).extracting(AppKeys.TrustedKey::tier).containsExactly("community", "first-party");
        assertThat(loaded.get(0).keyId()).isEqualTo(AppKeys.keyId(apps.review.getPublic()));
    }
}
