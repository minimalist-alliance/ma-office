package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Bundled apps (API.md section 19, "Bundled apps") through a client's frames, on a desk without the helper: offered in the
 * catalog, installed from the image, run, relayed, viewed, removed with their data kept, followed across a new image, and
 * held to the switch and section 19's table. The host here is a {@link FakeAppHost} in bundled mode; {@link
 * BundledAppHostTest} has the real one, and the checks of the image's files are at the end.
 */
class BundledAppsTest {

    private static final String ID = TestApps.BUNDLED_ID;

    @TempDir
    Path dir;

    private AppsRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    /** A desk as every desk is today: no helper, no /data/apps, no catalog, and this image bundling Tally 1.0.0. */
    private AppsRig rig() throws Exception {
        new TestApps().bundle(dir.resolve("bundled-apps"), "1.0.0");
        rig = new AppsRig(dir, true, false);
        rig.host.unavailable = "no_sandbox";
        Files.delete(rig.root);
        return rig;
    }

    private Map<String, Object> install(TestClient client) throws Exception {
        return rig.call(client, "apps.install", "id", ID, "version", "1.0.0", "packageSha256", manifestSha(), "grants", List.of());
    }

    private String manifestSha() throws Exception {
        return TestApps.sha(Files.readAllBytes(dir.resolve("bundled-apps").resolve(ID).resolve(BundledApps.MANIFEST)));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> only(Object list) {
        assertThat((List<Object>) list).hasSize(1);
        return (Map<String, Object>) ((List<Object>) list).get(0);
    }

    @Test
    @SuppressWarnings("unchecked")
    void aDeskWithoutTheHelperOffersInstallsAndRunsItsBundledApp() throws Exception {
        rig();
        TestClient owner = rig.owner("s1");
        assertThat(rig.ok(owner, "apps.list")).containsEntry("available", true).containsEntry("reason", null);

        Map<String, Object> catalog = (Map<String, Object>) rig.ok(owner, "apps.catalog.get").get("catalog");
        assertThat(catalog).containsEntry("seq", null).containsEntry("issuedAt", null);
        Map<String, Object> app = only(catalog.get("apps"));
        assertThat(app).containsEntry("id", ID).containsEntry("bundled", true).containsEntry("installed", null);
        Map<String, Object> version = only(app.get("versions"));
        assertThat(version).containsEntry("version", "1.0.0").containsEntry("installable", true).containsEntry("bundled", true)
                .containsEntry("packageSha256", manifestSha()).containsEntry("permissions", List.of());
        assertThat(rig.source.catalogFetches).as("a desk without the helper never asks the Platform").isZero();

        Map<String, Object> installed = install(owner);
        assertThat(installed).as(installed.toString()).containsEntry("_kind", "RES").containsEntry("state", "running");
        assertThat(rig.host.calls).as("the helper is never asked").isEmpty();
        assertThat(rig.fakeBundledHost().calls).containsExactly("prepare " + ID + " -1 " + (16L << 20), "start " + ID);

        Map<String, Object> registry = Json.parseObject(Files.readAllBytes(rig.bundledData.resolve(AppStore.REGISTRY)));
        Map<String, Object> entry = only(registry.get("apps"));
        assertThat(entry).containsEntry("id", ID).containsEntry("uid", -1).containsEntry("bundled", true)
                .containsEntry("tier", AppManifest.FIRST_PARTY).containsEntry("trial", false).containsEntry("packageSha256", manifestSha());
        assertThat(Files.isDirectory(rig.bundledData.resolve(ID).resolve("data"))).isTrue();

        assertThat(rig.ok(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);
        Map<String, Object> add = rig.callWith(owner, "apps.mutate", "b-1", AppsRig.params("id", ID, "m", "tally.add", "p", Map.of("by", 3)));
        assertThat(add).containsEntry("count", 3);
        assertThat(rig.callWith(owner, "apps.mutate", "b-1", AppsRig.params("id", ID, "m", "tally.add", "p", Map.of("by", 3))))
                .as("deskd's own store answers a retry").containsEntry("count", 3);
        Map<String, Object> request = rig.fakeBundledHost().app(ID).lastRequest();
        assertThat(request).containsEntry("idem", "b-1");
        assertThat((Map<String, Object>) request.get("from")).containsEntry("caller", Map.of("kind", "owner"));

        Map<String, Object> listed = AppsRig.app(rig.ok(owner, "apps.list"), ID);
        assertThat(listed).containsEntry("bundled", true).containsEntry("state", "running").containsEntry("version", "1.0.0");

        Map<String, Object> view = rig.ok(owner, "apps.view.get", "id", ID);
        assertThat(view).containsEntry("bundled", true).containsEntry("signatures", null).containsEntry("version", "1.0.0")
                .containsEntry("manifest", Files.readString(dir.resolve("bundled-apps").resolve(ID).resolve(BundledApps.MANIFEST)));
        assertThat(view.get("files")).isEqualTo(Map.of("view/index.html", "<main id=\"n\">0</main>", "view/view.js",
                "// the bridge\n", "view/view.css", "main{font:16px Nunito}"));

        Map<String, Object> catalogAfter = (Map<String, Object>) rig.ok(owner, "apps.catalog.get").get("catalog");
        assertThat(only(catalogAfter.get("apps"))).containsEntry("installed", "1.0.0");

        Map<String, Object> health = (Map<String, Object>) rig.module.health().get("apps");
        assertThat(health).containsEntry("state", "on").containsEntry("installed", 1).containsEntry("running", 1)
                .containsEntry("bundled", 1);
    }

    @Test
    void itsTopicRelaysAsAnyAppsDoes() throws Exception {
        rig();
        TestClient owner = rig.owner("s1");
        install(owner);
        assertThat(rig.subscribe(owner, "app:" + ID + ":tally")).containsEntry("_kind", "RES");
        assertThat(AppsRig.event(owner)).containsEntry("type", "snapshot").containsEntry("data", Map.of("count", 0));
        rig.callWith(owner, "apps.mutate", "t-1", AppsRig.params("id", ID, "m", "tally.add", "p", Map.of("by", 2)));
        await().untilAsserted(() -> assertThat(AppsRig.event(owner)).containsEntry("data", Map.of("count", 2)));
    }

    @Test
    void removeKeepsItsDataAndAReAddFindsIt() throws Exception {
        rig();
        TestClient owner = rig.owner("s1");
        install(owner);
        Path data = rig.bundledData.resolve(ID).resolve("data");
        Files.writeString(data.resolve("marks.json"), "{\"marks\":[1]}");
        String memberKey = registryEntry().get("memberKey").toString();

        assertThat(rig.ok(owner, "apps.remove", "id", ID)).containsEntry("_kind", "RES");
        assertThat((List<?>) rig.ok(owner, "apps.list").get("apps")).isEmpty();
        assertThat(registryEntry()).containsEntry("state", "kept").containsEntry("uid", -1);
        assertThat(Files.readString(data.resolve("marks.json"))).isEqualTo("{\"marks\":[1]}");

        assertThat(install(owner)).containsEntry("state", "running");
        assertThat(registryEntry()).containsEntry("state", "installed").containsEntry("memberKey", memberKey);
        assertThat(Files.readString(data.resolve("marks.json"))).as("re-adding finds it").isEqualTo("{\"marks\":[1]}");

        assertThat(rig.ok(owner, "apps.remove", "id", ID, "deleteData", true)).containsEntry("_kind", "RES");
        assertThat(Files.exists(rig.bundledData.resolve(ID))).isFalse();
        assertThat(Json.parseObject(Files.readAllBytes(rig.bundledData.resolve(AppStore.REGISTRY))).get("apps")).isEqualTo(List.of());
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> registryEntry() throws Exception {
        return only(Json.parseObject(Files.readAllBytes(rig.bundledData.resolve(AppStore.REGISTRY))).get("apps"));
    }

    @Test
    void aWrongVersionHashOrGrantChangesNothing() throws Exception {
        rig();
        TestClient owner = rig.owner("s1");
        assertThat(rig.call(owner, "apps.install", "id", ID, "version", "1.0.0", "packageSha256", "0".repeat(64), "grants", List.of()))
                .containsEntry("code", "precondition_failed").containsEntry("details", Map.of("reason", "catalog_changed"));
        assertThat(rig.call(owner, "apps.install", "id", ID, "version", "2.0.0", "packageSha256", manifestSha(), "grants", List.of()))
                .containsEntry("code", "not_found").containsEntry("details", Map.of("reason", "version"));
        assertThat(rig.call(owner, "apps.install", "id", ID, "version", "1.0.0", "packageSha256", manifestSha(), "grants",
                List.of("background"))).containsEntry("code", "bad_request");
        rig.freeBytes.set(1L << 30);
        assertThat(install(owner)).containsEntry("code", "precondition_failed").containsEntry("details", Map.of("reason", "no_space"));
        assertThat(Files.exists(rig.bundledData)).isFalse();
        assertThat(rig.fakeBundledHost().calls).isEmpty();
    }

    @Test
    void aTrialThatNeverAnswersRollsBackAndTakesOnlyWhatItMade() throws Exception {
        rig();
        rig.fakeBundledHost().byVersion.put(FakeAppHost.BUNDLED, FakeApp.Hello.SILENT);
        TestClient owner = rig.owner("s1");
        Map<String, Object> err = install(owner);
        assertThat(err).containsEntry("code", "precondition_failed");
        assertThat(err.get("details")).isEqualTo(Map.of("reason", "no_hello", "rolledBack", true));
        assertThat((List<?>) rig.ok(owner, "apps.list").get("apps")).isEmpty();
        assertThat(Files.exists(rig.bundledData.resolve(ID))).as("its directory was this install's, so it went").isFalse();

        // Data a move brought, with no record of the app: a failed trial leaves it.
        Path data = Files.createDirectories(rig.bundledData.resolve(ID).resolve("data"));
        Files.writeString(data.resolve("marks.json"), "moved");
        assertThat(install(owner)).containsEntry("code", "precondition_failed");
        assertThat(Files.readString(data.resolve("marks.json"))).isEqualTo("moved");
    }

    @Test
    void aRestartTakesItBackAtTheNewImagesVersion() throws Exception {
        rig();
        TestClient owner = rig.owner("s1");
        install(owner);
        String memberKey = registryEntry().get("memberKey").toString();
        Path bundled = dir.resolve("bundled-apps");
        AppStore.deleteTree(bundled);
        new TestApps().bundle(bundled, "1.1.0");

        AppsModule next = rig.restart();
        try {
            Map<String, Object> app = AppsRig.app(next.list(), ID);
            assertThat(app).containsEntry("version", "1.1.0").containsEntry("bundled", true).containsEntry("state", "stopped");
            assertThat(registryEntry()).containsEntry("version", "1.1.0").containsEntry("memberKey", memberKey)
                    .containsEntry("packageSha256", TestApps.sha(Files.readAllBytes(bundled.resolve(ID).resolve(BundledApps.MANIFEST))));
            assertThat(next.list()).containsEntry("available", true);
        } finally {
            next.close();
        }
    }

    @Test
    void anInstalledAppTheImageNoLongerHasIsLeftOutAndKept() throws Exception {
        rig();
        TestClient owner = rig.owner("s1");
        install(owner);
        AppStore.deleteTree(dir.resolve("bundled-apps"));
        AppsModule next = rig.restart();
        try {
            assertThat((List<?>) next.list().get("apps")).isEmpty();
            assertThat(next.list()).containsEntry("available", false).containsEntry("reason", "no_storage");
            assertThat(registryEntry()).containsEntry("state", "installed");
        } finally {
            next.close();
        }
    }

    @Test
    void theSwitchStopsItAndRefusesIt() throws Exception {
        rig();
        TestClient owner = rig.owner("s1");
        install(owner);
        Files.writeString(rig.deskDir.resolve(AppsSwitch.FILE), "off\n");
        await().until(() -> rig.fakeBundledHost().app(ID) == null);
        assertThat(rig.call(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of()))
                .containsEntry("code", "unavailable").containsEntry("details", Map.of("reason", "switched_off"));
        assertThat(rig.ok(owner, "apps.list")).containsEntry("available", false).containsEntry("reason", "switched_off");
        @SuppressWarnings("unchecked")
        Map<String, Object> health = (Map<String, Object>) rig.module.health().get("apps");
        assertThat(health).containsEntry("state", "off");
        Files.writeString(rig.deskDir.resolve(AppsSwitch.FILE), "install-off\n");
        await().until(() -> !"switched_off".equals(rig.ok(owner, "apps.list").get("reason")));
        assertThat(rig.ok(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);
    }

    // ---- the image's files, checked

    private Path good() throws Exception {
        return new TestApps().bundle(dir.resolve("check"), "1.0.0");
    }

    private void refused(Path app, String rule) {
        assertThatThrownBy(() -> BundledApps.check(app, AppsModule.deskArch(), FakeAppHost.ownUid())).isInstanceOf(BundledApps.Refused.class)
                .hasMessage(rule);
    }

    @Test
    void aGoodOnePasses() throws Exception {
        BundledApps.Bundled b = BundledApps.check(good(), AppsModule.deskArch(), FakeAppHost.ownUid());
        assertThat(b.id()).isEqualTo(ID);
        assertThat(b.manifestSha256()).isEqualTo(TestApps.sha(b.manifestBytes()));
    }

    @Test
    void aChangedFileIsRefused() throws Exception {
        Path app = good();
        Files.writeString(app.resolve("files/view/view.js"), "// changed\n");
        refused(app, "files: a hash or size doesn't match");
    }

    @Test
    void aSameSizedChangeIsRefusedToo() throws Exception {
        Path app = good();
        Files.writeString(app.resolve("files/view/view.js"), "// the bridgE\n");
        refused(app, "files: a hash or size doesn't match");
    }

    @Test
    void aFileTheManifestDoesntNameIsRefused() throws Exception {
        Path app = good();
        Files.writeString(app.resolve("files/view/extra.js"), "x");
        Files.setPosixFilePermissions(app.resolve("files/view/extra.js"), PosixFilePermissions.fromString("rw-r--r--"));
        refused(app, "files: not exactly the manifest's");
    }

    @Test
    void aLinkIsRefused() throws Exception {
        Path app = good();
        Files.delete(app.resolve("files/view/view.css"));
        Files.createSymbolicLink(app.resolve("files/view/view.css"), Path.of("/etc/hostname"));
        refused(app, "files: a link or special file");
    }

    @Test
    void anExecutableThatIsntIsRefused() throws Exception {
        Path app = good();
        Files.setPosixFilePermissions(app.resolve("files/bin/tally"), PosixFilePermissions.fromString("rw-r--r--"));
        refused(app, "files: a 0755 file isn't executable");
    }

    @Test
    void aDirectoryNotNamedForItsIdIsRefused() throws Exception {
        Path app = good();
        Path moved = Files.move(app, app.resolveSibling("com.example.other"));
        refused(moved, "id: not its directory's name");
    }

    @Test
    void moreThanTheBundledCeilingIsRefused() throws Exception {
        Path app = new TestApps().bundle(dir.resolve("check"), "1.0.0", TestApps.files(), m -> {
            Map<String, Object> resources = new LinkedHashMap<>(Map.of("memoryMaxMiB", 128, "cpuMax", 0.25, "tasksMax", 16, "diskMaxMiB", 16));
            m.put("resources", resources);
        });
        refused(app, "resources: over the bundled ceiling");
    }

    @Test
    void aPermissionDeskdCantHonourIsRefused() throws Exception {
        Path app = new TestApps().bundle(dir.resolve("check"), "1.0.0", TestApps.files(), m -> {
            m.put("permissions", List.of("files.pick"));
        });
        refused(app, "permissions: not supported");
    }

    @Test
    void aFileAnyoneButItsOwnerCouldWriteIsRefused() throws Exception {
        Path app = good();
        Files.setPosixFilePermissions(app.resolve("files/view/view.js"), PosixFilePermissions.fromString("rw-rw-r--"));
        refused(app, "ownership: not root's alone");
    }

    @Test
    void onADeskEveryFileMustBeRoots() throws Exception {
        Path app = good();
        assertThatThrownBy(() -> BundledApps.check(app, AppsModule.deskArch())).isInstanceOf(BundledApps.Refused.class)
                .hasMessage("ownership: not root's alone");
        assertThat(new BundledApps(app.getParent(), AppsModule.deskArch()).all()).as("a directory deskd's uid owns").isEmpty();
    }

    @Test
    void anIdThatIsntMinimalistAlliancesIsRefused() throws Exception {
        Path app = new TestApps().bundle(dir.resolve("check"), "1.0.0", TestApps.files(), m -> m.put("id", "org.example.reader"));
        refused(app, "id: not a first-party id");
    }

    @Test
    void aBadOneBesideAGoodOneLeavesTheGoodOneOffered() throws Exception {
        TestApps apps = new TestApps();
        Path root = dir.resolve("bundled-apps");
        apps.bundle(root, "1.0.0");
        apps.bundle(root, "1.0.0", TestApps.files(), m -> m.put("id", "com.minimalistalliance.sample.broken"));
        Files.writeString(root.resolve("com.minimalistalliance.sample.broken/files/bin/tally"), "#!/bin/sh\nexit 1\n",
                StandardCharsets.UTF_8);
        BundledApps bundled = new BundledApps(root, AppsModule.deskArch(), FakeAppHost.ownUid());
        assertThat(bundled.all().keySet()).containsExactly(ID);
        assertThat(bundled.offered()).isEqualTo(1);
    }
}
