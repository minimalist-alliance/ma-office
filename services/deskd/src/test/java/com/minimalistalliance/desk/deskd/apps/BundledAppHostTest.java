package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The real {@link BundledAppHost}, through {@code apps.*}: a bundled app whose executable starts {@link FakeAppMain} in a JVM
 * of its own, so deskd starts, links to, stops and loses a real process, as it will the Bible's.
 */
class BundledAppHostTest {

    private static final String ID = TestApps.BUNDLED_ID;

    @TempDir
    Path dir;

    private AppsRig rig;

    @BeforeEach
    void setUp() throws Exception {
        Map<String, byte[]> files = new LinkedHashMap<>(TestApps.files());
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        String classpath = System.getProperty("java.class.path");
        files.put("bin/tally", ("#!/bin/sh\nexec '" + java + "' -Xmx24m -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Xshare:auto -cp '"
                + classpath + "' " + FakeAppMain.class.getName() + "\n").getBytes(StandardCharsets.UTF_8));
        // A JVM is slower to answer than the Go it stands in for.
        new TestApps().bundle(dir.resolve("bundled-apps"), "1.0.0", files, m -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> run = (Map<String, Object>) m.get("run");
            run.put("startTimeoutSec", 10);
        });
        rig = new AppsRig(dir, true, true);
        rig.host.unavailable = "no_sandbox";
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private BundledAppHost host() {
        return (BundledAppHost) rig.bundledHost;
    }

    private Map<String, Object> install(TestClient owner) throws Exception {
        String sha = TestApps.sha(Files.readAllBytes(dir.resolve("bundled-apps").resolve(ID).resolve(BundledApps.MANIFEST)));
        return rig.call(owner, "apps.install", "id", ID, "version", "1.0.0", "packageSha256", sha, "grants", List.of());
    }

    @Test
    @SuppressWarnings("unchecked")
    void itRunsAsDeskdsChildWithExactlyTheContractsEnvironment() throws Exception {
        TestClient owner = rig.owner("s1");
        assertThat(install(owner)).as("install").containsEntry("state", "running");
        assertThat(rig.ok(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);

        Path data = rig.bundledData.resolve(ID).resolve("data");
        Map<String, Object> told = Json.parseObject(Files.readAllBytes(data.resolve("told.json")));
        Map<String, Object> env = new LinkedHashMap<>((Map<String, Object>) told.get("env"));
        // The test's sh wrapper sets its own PWD; the Go app it stands in for has no shell in between.
        env.remove("PWD");
        Path socket = rig.bundledRun.resolve(ID).resolve("app.sock");
        Map<String, Object> want = new LinkedHashMap<>();
        want.put("MA_APP_ID", ID);
        want.put("MA_APP_VERSION", "1.0.0");
        want.put("MA_APP_API", "1.0");
        want.put("MA_APP_SOCKET", socket.toString());
        want.put("MA_APP_DATA", data.toString());
        want.put("MA_APP_CACHE", rig.bundledData.resolve(ID).resolve("cache").toString());
        want.put("MA_APP_MEMORY_MAX", String.valueOf(32L << 20));
        want.put("MA_APP_CPU_MAX", "0.25");
        want.put("MA_DESKD_UID", String.valueOf(FakeAppHost.ownUid()));
        want.put("HOME", data.toString());
        assertThat(env).as("nothing else: no PATH, no name, no desk").isEqualTo(want);
        assertThat(told).containsEntry("cwd", data.toString());

        for (Path d : List.of(rig.bundledData, rig.bundledData.resolve(ID), data, rig.bundledData.resolve(ID).resolve("cache"),
                rig.bundledRun, socket.getParent())) {
            assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(d))).as(d.toString()).isEqualTo("rwx------");
        }
        long pid = host().pid(ID);
        assertThat(Files.readString(Path.of("/proc", String.valueOf(pid), "oom_score_adj")).strip()).isEqualTo("1000");
        assertThat(socket.toString().getBytes(StandardCharsets.UTF_8).length).isLessThan(108);
    }

    @Test
    void stoppingItEndsTheProcess() throws Exception {
        TestClient owner = rig.owner("s1");
        install(owner);
        ProcessHandle process = ProcessHandle.of(host().pid(ID)).orElseThrow();
        assertThat(rig.ok(owner, "apps.stop", "id", ID)).containsEntry("state", "stopped");
        await().atMost(Duration.ofSeconds(10)).until(() -> !process.isAlive());
        assertThat(host().status(ID)).isEqualTo(new AppHost.Status(AppHost.Status.STOPPED, null));
        assertThat(rig.ok(owner, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).as("started again on use")
                .containsEntry("count", 0);
    }

    @Test
    void aKillNobodyAskedForIsTakenAsTheKernels() throws Exception {
        TestClient owner = rig.owner("s1");
        install(owner);
        ProcessHandle.of(host().pid(ID)).orElseThrow().destroyForcibly();
        await().atMost(Duration.ofSeconds(10)).until(() -> "memory".equals(AppsRig.app(rig.module.list(), ID).get("problem")));
        assertThat(AppsRig.app(rig.module.list(), ID)).containsEntry("state", "stopped");
        assertThat(host().running(ID)).as("nobody subscribed, so it waits for the next use").isFalse();
    }

    @Test
    void aCrashRestartsItForASubscriber() throws Exception {
        TestClient owner = rig.owner("s1");
        install(owner);
        assertThat(rig.subscribe(owner, "app:" + ID + ":tally")).containsEntry("_kind", "RES");
        AppsRig.event(owner);
        long first = host().pid(ID);
        ProcessHandle.of(first).orElseThrow().destroyForcibly();
        await().atMost(Duration.ofSeconds(30)).until(() -> host().pid(ID) != first && host().running(ID)
                && "running".equals(AppsRig.app(rig.module.list(), ID).get("state")));
        assertThat(rig.module.runtime.process(ID).failures).hasSize(1);
        Map<String, Object> snapshot = AppsRig.event(owner);
        assertThat(snapshot).as("a subscriber hears it again").containsEntry("type", "snapshot");
    }

    @Test
    void closingDeskdStopsItsChildren() throws Exception {
        TestClient owner = rig.owner("s1");
        install(owner);
        ProcessHandle process = ProcessHandle.of(host().pid(ID)).orElseThrow();
        rig.module.close();
        assertThat(process.isAlive()).isFalse();
    }
}
