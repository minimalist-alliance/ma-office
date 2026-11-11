package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The apps module through a client's frames: install, the relay, rollback, removal, the guild rules, the switch. */
class AppsModuleTest {

    private static final String ID = TestApps.ID;

    @TempDir
    Path dir;

    private AppsRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AppsRig(dir);
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private List<String> releases() throws Exception {
        Path releases = rig.root.resolve(ID).resolve(AppStore.RELEASES);
        if (!Files.isDirectory(releases)) {
            return List.of();
        }
        try (Stream<Path> s = Files.list(releases)) {
            return s.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    private String current() throws Exception {
        return Files.readSymbolicLink(rig.root.resolve(ID).resolve(AppStore.CURRENT)).getFileName().toString();
    }

    private Map<String, Object> listed(TestClient client) throws Exception {
        return AppsRig.app(rig.ok(client, "apps.list"), ID);
    }

    @Test
    void nothingIsFetchedOrStartedUntilSomeoneAsks() throws Exception {
        TestClient owner = rig.owner("s1");
        Map<String, Object> list = rig.ok(owner, "apps.list");
        assertThat(list).containsEntry("available", true).containsEntry("appApi", "1.0");
        assertThat((List<?>) list.get("apps")).isEmpty();
        assertThat(rig.source.catalogFetches).isZero();
        assertThat(rig.host.calls).isEmpty();
        @SuppressWarnings("unchecked")
        Map<String, Object> health = (Map<String, Object>) rig.module.health().get("apps");
        assertThat(health).containsEntry("state", "on").containsEntry("installed", 0).containsEntry("reviewKeys", 1);
    }

    @Test
    void aDeskWithoutTheHelperInstallsNothingAndAsksTheCatalogForNothing() throws Exception {
        rig.host.unavailable = "no_sandbox";
        rig.publish(1, rig.apps.build("1.0.0"));
        TestClient owner = rig.owner("s1");
        assertThat(rig.ok(owner, "apps.list")).containsEntry("available", false).containsEntry("reason", "no_sandbox");
        assertThat(rig.ok(owner, "apps.catalog.get")).containsEntry("catalog", null);
        Map<String, Object> err = rig.install(owner, rig.apps.build("1.0.0"));
        assertThat(err).containsEntry("code", "unavailable").containsEntry("details", Map.of("reason", "no_sandbox"));
        assertThat(rig.source.catalogFetches).isZero();
        assertThat(rig.host.calls).isEmpty();
        @SuppressWarnings("unchecked")
        Map<String, Object> health = (Map<String, Object>) rig.module.health().get("apps");
        assertThat(health).containsEntry("state", "unavailable").containsEntry("reason", "no_sandbox");
    }

    @Test
    void installThenCallMutateAndOpenTheView() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        TestClient owner = rig.owner("s1");

        Map<String, Object> catalog = rig.ok(owner, "apps.catalog.get");
        assertThat(Json.bytes(catalog)).asString().contains("\"installable\":true").contains(v1.sha256());

        Map<String, Object> installed = rig.install(owner, v1);
        assertThat(installed).as(installed.toString()).containsEntry("_kind", "RES").containsEntry("version", "1.0.0")
                .containsEntry("state", "running");
        assertThat(rig.host.calls).containsExactly("prepare " + ID + " 2000 " + (16L << 20), "start " + ID);
        assertThat(current()).isEqualTo("1.0.0");
        assertThat(Files.readAllBytes(rig.root.resolve(ID).resolve("current/ma-app.json"))).isEqualTo(v1.manifest());
        assertThat(Files.exists(rig.root.resolve(AppStore.REGISTRY))).isTrue();

        assertThat(rig.ok(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);
        Map<String, Object> add = rig.callWith(owner, "apps.mutate", "act-1", AppsRig.params("id", ID, "m", "tally.add", "p", Map.of("by", 2)));
        assertThat(add).containsEntry("count", 2);
        Map<String, Object> retry = rig.callWith(owner, "apps.mutate", "act-1", AppsRig.params("id", ID, "m", "tally.add", "p", Map.of("by", 2)));
        assertThat(retry).as("deskd's own store answers a retry").containsEntry("count", 2);
        FakeApp app = rig.host.app(ID);
        assertThat(app.count.get()).isEqualTo(2);
        Map<String, Object> request = app.lastRequest();
        assertThat(request).containsEntry("m", "tally.add").containsEntry("idem", "act-1");
        @SuppressWarnings("unchecked")
        Map<String, Object> from = (Map<String, Object>) request.get("from");
        assertThat(from).containsEntry("kind", "view").containsEntry("caller", Map.of("kind", "owner"));
        assertThat((String) from.get("session")).startsWith("p-").hasSize(24).doesNotContain("s1");

        assertThat(rig.err(owner, "bad_request", "apps.call", "id", ID, "m", "tally.add", "p", Map.of()))
                .containsEntry("details", Map.of("reason", "mutation"));
        assertThat(rig.err(owner, "not_found", "apps.call", "id", ID, "m", "tally.secret", "p", Map.of()))
                .containsEntry("details", Map.of("reason", "method"));

        Map<String, Object> view = rig.ok(owner, "apps.view.get", "id", ID);
        assertThat(view).containsEntry("version", "1.0.0").containsEntry("manifest", new String(v1.manifest()));
        assertThat(view.get("files")).isEqualTo(Map.of("view/index.html", "<main id=\"n\">0</main>", "view/view.js", "// the bridge\n",
                "view/view.css", "main{font:16px Nunito}"));

        await().until(() -> listed(owner).get("summary") != null);
        assertThat(listed(owner)).containsEntry("state", "running").containsEntry("grants", List.of()).containsEntry("tier", "community");
    }

    @Test
    void anAppsTopicRelaysAndASubscriberHearsAgainAfterACrash() throws Exception {
        rig.publish(1, rig.apps.build("1.0.0"));
        TestClient owner = rig.owner("s1");
        rig.install(owner, rig.apps.build("1.0.0"));
        Map<String, Object> sub = rig.subscribe(owner, "app:" + ID + ":tally");
        assertThat(sub).containsEntry("_kind", "RES");
        Map<String, Object> first = AppsRig.event(owner);
        assertThat(first).containsEntry("type", "snapshot").containsEntry("data", Map.of("count", 0));

        rig.callWith(owner, "apps.mutate", "m-1", AppsRig.params("id", ID, "m", "tally.add", "p", Map.of("by", 1)));
        Map<String, Object> patch = AppsRig.event(owner);
        assertThat(patch).containsEntry("type", "patch").containsEntry("data", Map.of("count", 1));

        rig.host.app(ID).crash();
        // In use, so started again after a second; its first event goes out as a snapshot.
        Map<String, Object> again = AppsRig.event(owner);
        assertThat(again).containsEntry("type", "snapshot").containsEntry("data", Map.of("count", 0));
        assertThat(listed(owner)).containsEntry("state", "running");

        assertThat(rig.subscribe(owner, "app:" + ID + ":nope")).containsEntry("code", "not_found");
        assertThat(rig.subscribe(owner, "app:" + ID + ":app.summary")).containsEntry("code", "not_found");
    }

    @Test
    void aNewVersionThatDoesntStartIsRolledBackAndTheOldOneRunsAgain() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        TestApps.Built v2 = rig.apps.build("2.0.0");
        rig.publish(1, v1);
        TestClient owner = rig.owner("s1");
        rig.install(owner, v1);
        rig.publish(2, v1, v2);
        rig.host.byVersion.put("2.0.0", FakeApp.Hello.SILENT);
        rig.module.catalogs.fresh(Duration.ZERO);

        Map<String, Object> err = rig.install(owner, v2);
        assertThat(err).as(err.toString()).containsEntry("code", "precondition_failed")
                .containsEntry("details", Map.of("reason", "no_hello", "rolledBack", true));
        assertThat(current()).isEqualTo("1.0.0");
        assertThat(releases()).containsExactly("1.0.0");
        assertThat(listed(owner)).containsEntry("version", "1.0.0").containsEntry("previous", null);
        await().until(() -> "running".equals(listed(owner).get("state")));
        assertThat(rig.ok(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);
    }

    @Test
    void aFirstInstallThatDoesntStartLeavesNothingBehind() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        rig.host.byVersion.put("1.0.0", FakeApp.Hello.MISMATCH);
        TestClient owner = rig.owner("s1");
        Map<String, Object> err = rig.install(owner, v1);
        assertThat(err).containsEntry("code", "precondition_failed").containsEntry("details", Map.of("reason", "needs_update", "rolledBack", true));
        assertThat(rig.host.calls).contains("remove " + ID + " true");
        assertThat(Files.exists(rig.root.resolve(ID))).isFalse();
        assertThat((List<?>) rig.ok(owner, "apps.list").get("apps")).isEmpty();
    }

    @Test
    void upgradesKeepThePreviousReleaseAndPruneOlderOnes() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        TestApps.Built v2 = rig.apps.build("1.1.0");
        TestApps.Built v3 = rig.apps.build("1.2.0");
        rig.publish(1, v1, v2, v3);
        TestClient owner = rig.owner("s1");
        assertThat(rig.install(owner, v1)).containsEntry("_kind", "RES");
        assertThat(rig.install(owner, v2)).containsEntry("_kind", "RES");
        assertThat(rig.install(owner, v3)).containsEntry("_kind", "RES");
        assertThat(current()).isEqualTo("1.2.0");
        assertThat(Files.readSymbolicLink(rig.root.resolve(ID).resolve(AppStore.PREVIOUS)).getFileName().toString()).isEqualTo("1.1.0");
        assertThat(releases()).containsExactly("1.1.0", "1.2.0");
        assertThat(listed(owner)).containsEntry("version", "1.2.0").containsEntry("previous", "1.1.0");
        assertThat(rig.install(owner, v3)).as("the same version again is a no-op").containsEntry("_kind", "RES");
        assertThat(rig.install(owner, v2)).containsEntry("code", "precondition_failed").containsEntry("details", Map.of("reason", "downgrade"));
    }

    @Test
    void installsAreRefusedBeforeAnythingIsTouched() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        TestClient owner = rig.owner("s1");
        assertThat(rig.call(owner, "apps.install", "id", ID, "version", "1.0.0", "packageSha256", v1.sha256(), "grants", List.of("background")))
                .containsEntry("code", "bad_request").containsEntry("details", Map.of("reason", "grants"));
        assertThat(rig.call(owner, "apps.install", "id", ID, "version", "1.0.0", "packageSha256", "0".repeat(64), "grants", List.of()))
                .containsEntry("code", "precondition_failed").containsEntry("details", Map.of("reason", "catalog_changed"));
        assertThat(rig.call(owner, "apps.install", "id", ID, "version", "9.9.9", "packageSha256", v1.sha256(), "grants", List.of()))
                .containsEntry("code", "not_found");
        rig.freeBytes.set(2L << 30);
        assertThat(rig.install(owner, v1)).containsEntry("code", "precondition_failed").containsEntry("details", Map.of("reason", "no_space"));
        assertThat(rig.host.calls).isEmpty();
        assertThat(Files.exists(rig.root.resolve(ID))).isFalse();
    }

    @Test
    void aPermissionThisDeskCantHonourIsNotSupported() throws Exception {
        Map<String, Object> manifest = rig.apps.manifest("1.0.0", TestApps.files());
        manifest.put("permissions", List.of("net"));
        manifest.put("net", List.of(Map.of("host", "api.example.org", "port", 443, "why", "Syncs your tallies")));
        TestApps.Built netted = rig.apps.build(manifest, TestApps.files());
        rig.publish(1, netted);
        TestClient owner = rig.owner("s1");
        assertThat(Json.bytes(rig.ok(owner, "apps.catalog.get"))).asString().contains("\"reason\":\"not_supported\"");
        assertThat(rig.install(owner, netted)).containsEntry("code", "precondition_failed")
                .containsEntry("details", Map.of("reason", "not_supported"));
    }

    @Test
    void aPackageThatIsntWhatItsManifestSaysLeavesNoTrace() throws Exception {
        TestApps.Built good = rig.apps.build("1.0.0");
        Map<String, byte[]> files = TestApps.files();
        files.put("view/index.html", "<main>tampered</main>".getBytes());
        List<TestApps.Entry> entries = new java.util.ArrayList<>();
        entries.add(TestApps.Entry.file(PackageReader.MANIFEST, good.manifest()));
        entries.add(TestApps.Entry.file(PackageReader.SIGNATURES, rig.apps.signatures(good.manifest(), rig.apps.developer, rig.apps.review)));
        for (Map.Entry<String, byte[]> f : files.entrySet()) {
            entries.add(TestApps.Entry.file("files/" + f.getKey(), f.getValue()));
        }
        TestApps.Built bad = new TestApps.Built(TestApps.tarGz(entries), good.manifest(), "1.0.0", List.of(), 16);
        rig.publish(1, bad);
        TestClient owner = rig.owner("s1");
        assertThat(rig.install(owner, bad)).containsEntry("code", "precondition_failed").containsEntry("details", Map.of("reason", "hash"));
        assertThat(Files.exists(rig.root.resolve(ID))).isFalse();
        assertThat(rig.host.calls).contains("remove " + ID + " true").doesNotContain("start " + ID);
    }

    @Test
    void removalKeepsTheDataAndTheUidUnlessAsked() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        TestClient owner = rig.owner("s1");
        rig.install(owner, v1);
        Files.writeString(rig.root.resolve(ID).resolve("data/tally.json"), "{\"count\":7}");
        assertThat(rig.subscribe(owner, "app:" + ID + ":tally")).containsEntry("_kind", "RES");
        assertThat(AppsRig.event(owner)).containsEntry("type", "snapshot");

        assertThat(rig.call(owner, "apps.remove", "id", ID, "deleteData", false)).containsEntry("_kind", "RES");
        Map<String, Object> ended = AppsRig.event(owner);
        assertThat(ended).as("its subscribers are told").containsEntry("type", "error");
        assertThat(ended.get("data").toString()).contains("not_found");
        assertThat((List<?>) rig.ok(owner, "apps.list").get("apps")).isEmpty();
        assertThat(releases()).isEmpty();
        assertThat(Files.exists(rig.root.resolve(ID).resolve(AppStore.CURRENT))).isFalse();
        assertThat(Files.readString(rig.root.resolve(ID).resolve("data/tally.json"))).isEqualTo("{\"count\":7}");
        assertThat(Files.readString(rig.root.resolve(AppStore.REGISTRY))).contains("\"state\":\"kept\"");
        assertThat(rig.host.app(ID)).isNull();

        assertThat(rig.install(owner, v1)).containsEntry("_kind", "RES");
        assertThat(rig.host.calls.stream().filter(c -> c.startsWith("prepare")).toList())
                .as("the same uid, so the kept data is the app's again").allMatch(c -> c.contains(" 2000 "));
        assertThat(Files.readString(rig.root.resolve(ID).resolve("data/tally.json"))).isEqualTo("{\"count\":7}");

        assertThat(rig.call(owner, "apps.remove", "id", ID, "deleteData", true)).containsEntry("_kind", "RES");
        assertThat(Files.exists(rig.root.resolve(ID))).isFalse();
        assertThat(Files.readString(rig.root.resolve(AppStore.REGISTRY))).doesNotContain(ID);
        assertThat(rig.call(owner, "apps.remove", "id", ID, "deleteData", false)).containsEntry("code", "not_found");
    }

    @Test
    void onAGuildDeskMembersUseAppsAndOnlyTheFounderManagesThem() throws Exception {
        rig.guild.set(true);
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        TestClient member = rig.member("m1", "gm-alice", "member");
        TestClient officer = rig.member("o1", "gm-bob", "officer");
        TestClient founder = rig.member("f1", "gm-carol", "lead");

        assertThat(rig.install(member, v1)).containsEntry("code", "forbidden").containsEntry("details", Map.of("reason", "grant"));
        assertThat(rig.install(officer, v1)).containsEntry("code", "forbidden");
        assertThat(rig.install(founder, v1)).containsEntry("_kind", "RES");

        assertThat(rig.ok(member, "apps.list").get("apps")).asList().hasSize(1);
        assertThat(rig.callWith(member, "apps.mutate", "g-1", AppsRig.params("id", ID, "m", "tally.add", "p", Map.of("by", 1))))
                .containsEntry("count", 1);
        @SuppressWarnings("unchecked")
        Map<String, Object> caller = (Map<String, Object>) ((Map<String, Object>) rig.host.app(ID).lastRequest().get("from")).get("caller");
        assertThat(caller).containsEntry("kind", "guild_member").containsEntry("role", "member").containsEntry("grants", List.of())
                .containsEntry("teen", false).doesNotContainKey("name").doesNotContainKey("memberId");
        String pseudonym = (String) caller.get("member");
        assertThat(pseudonym).startsWith("p-").doesNotContain("alice");

        rig.callWith(founder, "apps.mutate", "g-2", AppsRig.params("id", ID, "m", "tally.add", "p", Map.of("by", 1)));
        @SuppressWarnings("unchecked")
        Map<String, Object> founderCaller = (Map<String, Object>) ((Map<String, Object>) rig.host.app(ID).lastRequest().get("from")).get("caller");
        assertThat(founderCaller.get("member")).isNotEqualTo(pseudonym);

        Map<String, Object> sub = rig.subscribe(member, "app:" + ID + ":tally");
        assertThat(sub).containsEntry("_kind", "RES");
        assertThat(AppsRig.event(member)).containsEntry("type", "snapshot");
        assertThat(rig.host.app(ID).subscribes.stream().filter(s -> "tally".equals(s.get("topic"))).toList().get(0).toString())
                .contains(pseudonym).doesNotContain("alice");

        assertThat(rig.call(member, "apps.stop", "id", ID)).containsEntry("code", "forbidden");
        assertThat(rig.call(member, "apps.remove", "id", ID, "deleteData", true)).containsEntry("code", "forbidden");
        assertThat(rig.call(founder, "apps.stop", "id", ID)).containsEntry("_kind", "RES").containsEntry("state", "stopped");
    }

    @Test
    void anExportSessionGetsNoneOfIt() throws Exception {
        TestClient export = rig.export("e1");
        assertThat(rig.call(export, "apps.list")).containsEntry("code", "forbidden").containsEntry("details", Map.of("reason", "scope"));
        assertThat(rig.subscribe(export, "apps")).containsEntry("code", "forbidden");
    }

    @Test
    void theAppsTopicSaysWhatChanged() throws Exception {
        rig.publish(1, rig.apps.build("1.0.0"));
        TestClient owner = rig.owner("s1");
        assertThat(rig.subscribe(owner, "apps")).containsEntry("_kind", "RES");
        Map<String, Object> snapshot = AppsRig.event(owner);
        assertThat(snapshot).containsEntry("type", "snapshot");
        rig.install(owner, rig.apps.build("1.0.0"));
        await().atMost(Duration.ofSeconds(10)).until(() -> {
            Map<String, Object> e = AppsRig.event(owner);
            return "patch".equals(e.get("type")) && Json.bytes(e.get("data")).length > 0
                    && new String(Json.bytes(e.get("data"))).contains("\"state\":\"running\"");
        });
    }

    @Test
    void theSwitchTurnsInstallsOffAndThenEverything() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        TestClient owner = rig.owner("s1");
        rig.install(owner, v1);

        Files.writeString(rig.deskDir.resolve(AppsSwitch.FILE), "install-off\n");
        Thread.sleep(1100);
        assertThat(rig.install(owner, rig.apps.build("1.0.1"))).containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("reason", "switched_off"));
        assertThat(rig.ok(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);

        Files.writeString(rig.deskDir.resolve(AppsSwitch.FILE), "off\n");
        Thread.sleep(1100);
        assertThat(rig.call(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("reason", "switched_off"));
        assertThat(rig.ok(owner, "apps.list")).containsEntry("available", false).containsEntry("reason", "switched_off");
        await().until(() -> rig.host.app(ID) == null);

        Files.delete(rig.deskDir.resolve(AppsSwitch.FILE));
        Thread.sleep(1100);
        assertThat(rig.ok(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);
    }

    @Test
    void anAppTheCatalogRevokesIsStoppedAndDisabled() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        TestClient owner = rig.owner("s1");
        rig.install(owner, v1);
        rig.source.catalog = rig.apps.catalog(2, List.of(v1), List.of(), List.of(v1.manifestSha256()));
        rig.module.applyRevocations(rig.module.catalogs.fresh(Duration.ZERO));
        assertThat(rig.host.app(ID)).isNull();
        assertThat(listed(owner)).containsEntry("state", "disabled").containsEntry("problem", "revoked");
        assertThat(rig.call(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("code", "forbidden")
                .containsEntry("details", Map.of("reason", "revoked"));
        assertThat(Files.readString(rig.root.resolve(AppStore.REGISTRY))).contains("\"disabled\":\"revoked\"");
    }

    @Test
    void repeatedCrashesStopTheAppUntilTheMemberStartsItAgain() throws Exception {
        rig.publish(1, rig.apps.build("1.0.0"));
        TestClient owner = rig.owner("s1");
        rig.install(owner, rig.apps.build("1.0.0"));
        rig.host.oomNext = true;
        rig.host.app(ID).crash();
        await().until(() -> "memory".equals(listed(owner).get("problem")));
        assertThat(listed(owner)).containsEntry("state", "stopped");
        for (int i = 0; i < 2; i++) {
            assertThat(rig.ok(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);
            rig.host.app(ID).crash();
            int round = i;
            await().until(() -> round == 1 ? "failed".equals(listed(owner).get("state")) : rig.host.app(ID) == null);
        }
        assertThat(listed(owner)).containsEntry("state", "failed").containsEntry("problem", "crashed");
        assertThat(rig.call(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("reason", "crashed"));
        assertThat(rig.ok(owner, "apps.start", "id", ID)).containsEntry("state", "running");
        assertThat(rig.ok(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);
    }

    @Test
    void aRestartedDeskdFindsWhatsInstalledAndTheAppStillRunning() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        TestClient owner = rig.owner("s1");
        rig.install(owner, v1);
        rig.callWith(owner, "apps.mutate", "r-1", AppsRig.params("id", ID, "m", "tally.add", "p", Map.of("by", 5)));
        // A staging directory a crash left, and a release nobody points at: the next start clears both.
        Files.createDirectories(rig.root.resolve(ID).resolve("releases/.staging-dead"));
        Files.createDirectories(rig.root.resolve(ID).resolve("releases/0.0.1"));

        AppsModule restarted = rig.restart();
        await().until(() -> restarted.runtime.running(ID));
        AppLink link = restarted.runtime.ensureRunning(ID, false);
        assertThat(link.call(Map.of("m", "tally.get", "p", Map.of()), Duration.ofSeconds(2), null))
                .as("the same process: its count survived deskd's restart").containsEntry("count", 5);
        assertThat(releases()).containsExactly("1.0.0");
        restarted.close();
    }

    @Test
    void aBrokenRegistryNeverStopsDeskdFromStarting(@TempDir Path other) throws Exception {
        Path apps = Files.createDirectories(other.resolve("apps"));
        Files.createDirectories(apps.resolve(ID).resolve("releases"));
        Files.writeString(apps.resolve(AppStore.REGISTRY),
                "{\"registry\":1,\"apps\":[{\"id\":\"" + ID + "\",\"uid\":2000,\"version\":\"../../etc\",\"state\":\"installed\"}]}");
        try (AppsRig broken = new AppsRig(other)) {
            TestClient owner = broken.owner("s1");
            assertThat(broken.ok(owner, "apps.list")).containsEntry("available", true);
            assertThat((List<?>) broken.ok(owner, "apps.list").get("apps")).isEmpty();
        }
        Files.writeString(apps.resolve(AppStore.REGISTRY), "not json");
        try (AppsRig broken = new AppsRig(other)) {
            assertThat(broken.module.health()).isNotNull();
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void aTrialThatDeskdStoppedInTheMiddleOfIsRolledBackAtTheNextStart() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        TestClient owner = rig.owner("s1");
        rig.install(owner, v1);
        // As the registry stands mid-trial of 2.0.0: the new entry, with the one it replaced kept beside it.
        Path registry = rig.root.resolve(AppStore.REGISTRY);
        Map<String, Object> json = new java.util.LinkedHashMap<>(Json.parseObject(Files.readAllBytes(registry)));
        Map<String, Object> was = (Map<String, Object>) ((List<Object>) json.get("apps")).get(0);
        Map<String, Object> trial = new java.util.LinkedHashMap<>(was);
        trial.put("version", "2.0.0");
        trial.put("previous", "1.0.0");
        trial.put("trial", true);
        trial.put("before", was);
        json.put("apps", List.of(trial));
        Files.write(registry, Json.bytes(json));
        Files.createDirectories(rig.root.resolve(ID).resolve("releases/2.0.0"));

        AppsModule restarted = rig.restart();
        assertThat(Files.readString(registry)).contains("\"version\":\"1.0.0\"").doesNotContain("2.0.0").contains("\"trial\":false");
        assertThat(current()).isEqualTo("1.0.0");
        assertThat(releases()).containsExactly("1.0.0");
        restarted.close();
    }

    @Test
    @SuppressWarnings("unchecked")
    void aFirstInstallDeskdStoppedInTheMiddleOfLeavesNothing() throws Exception {
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        TestClient owner = rig.owner("s1");
        rig.install(owner, v1);
        Path registry = rig.root.resolve(AppStore.REGISTRY);
        Map<String, Object> json = new java.util.LinkedHashMap<>(Json.parseObject(Files.readAllBytes(registry)));
        Map<String, Object> entry = new java.util.LinkedHashMap<>((Map<String, Object>) ((List<Object>) json.get("apps")).get(0));
        entry.put("trial", true);
        entry.put("before", null);
        json.put("apps", List.of(entry));
        Files.write(registry, Json.bytes(json));

        AppsModule restarted = rig.restart();
        assertThat(Files.readString(registry)).doesNotContain(ID);
        await().until(() -> rig.host.calls.contains("remove " + ID + " true"));
        assertThat(restarted.runtime.all()).isEmpty();
        restarted.close();
    }
}
