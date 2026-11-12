package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.api.io.TempDir;

/**
 * The real Bible service, in Go, bundled and run as deskd's image does it: built static, laid out by
 * {@code docker/bundle-app.go} exactly as the Dockerfile's {@code bundled} stage does (its texts with each translation's
 * {@code STATEMENT.txt} and {@code SOURCE.md}, and its view where there is one), checked by {@link BundledApps}, installed
 * through {@code apps.install}, and run by the real {@link BundledAppHost}: HELLO, a call relayed, each declared topic's
 * snapshot, its widget's summary if it has one, and its exit on SIGTERM.
 *
 * <p>Skipped unless Go is found ({@code GO}, {@code ~/.local/go/bin/go}, or {@code go} on the {@code PATH}) and the app's
 * source is there: {@code apps/bible} in this tree, or the directory {@code DESKD_BUNDLED_APP_SRC} names (the same layout:
 * {@code ma-app.json}, {@code server/} with one main package, {@code texts/<code>/}, and {@code view/}). Where there's no
 * {@code view/} yet, this test, and only this test, takes the window's files from {@code view-dev/}; the image skips such an
 * app.
 *
 * <p>{@link #eachGuildMemberSeesOnlyTheirOwn} is the Bible on a Guild Desk: two members' marks kept apart, and a leaver's
 * gone after {@code app.members.retain}. It runs only with {@code DESKD_BUNDLED_GUILD=1}, for a service that keys its data
 * by {@code from.caller.member}.
 */
@EnabledIf("goAndSource")
class BundledBibleIT {

    @TempDir
    Path dir;

    static Path source() {
        String named = System.getenv("DESKD_BUNDLED_APP_SRC");
        // The module's directory is services/deskd, so the repo's root is two up.
        return named != null && !named.isBlank() ? Path.of(named) : Path.of("").toAbsolutePath().resolve("../../apps/bible").normalize();
    }

    static Path go() {
        String named = System.getenv("GO");
        List<Path> candidates = new ArrayList<>();
        if (named != null && !named.isBlank()) {
            candidates.add(Path.of(named));
        }
        candidates.add(Path.of(System.getProperty("user.home"), ".local/go/bin/go"));
        for (String p : System.getenv().getOrDefault("PATH", "").split(":")) {
            if (!p.isEmpty()) {
                candidates.add(Path.of(p, "go"));
            }
        }
        return candidates.stream().filter(Files::isExecutable).findFirst().orElse(null);
    }

    static boolean goAndSource() {
        Path src = source();
        return go() != null && Files.isRegularFile(src.resolve("ma-app.json")) && Files.isDirectory(src.resolve("server"));
    }

    private String run(Path cwd, String... command) throws IOException, InterruptedException {
        ProcessBuilder pb = new ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.put("CGO_ENABLED", "0");
        env.put("GOFLAGS", "-mod=readonly");
        env.put("GOTOOLCHAIN", "local");
        Process p = pb.start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(p.waitFor(10, TimeUnit.MINUTES)).isTrue();
        assertThat(p.exitValue()).as(String.join(" ", command) + "\n" + out).isZero();
        return out;
    }

    /** The Dockerfile's bundled stage, step by step. */
    private Path bundle() throws Exception {
        Path src = source();
        String go = go().toString();
        Path server = src.resolve("server");
        List<String> mains = run(server, go, "list", "-f", "{{if eq .Name \"main\"}}{{.ImportPath}}{{end}}", "./...").lines()
                .filter(l -> !l.isBlank()).toList();
        assertThat(mains).as("exactly one main package under server/").hasSize(1);
        Path exe = dir.resolve("bible-bin");
        run(server, go, "build", "-trimpath", "-ldflags", "-s -w", "-o", exe.toString(), mains.get(0));

        List<String> command = new ArrayList<>(List.of(go, "run", "bundle-app.go", "-manifest", src.resolve("ma-app.json").toString(),
                "-exec", exe.toString(), "-out", dir.resolve("bundled-apps").toString()));
        Path texts = src.resolve("texts");
        if (Files.isDirectory(texts)) {
            try (Stream<Path> translations = Files.list(texts)) {
                for (Path t : translations.filter(Files::isDirectory).sorted().toList()) {
                    String code = t.getFileName().toString();
                    if (code.equals("tools")) {
                        continue;
                    }
                    assertThat(t.resolve("STATEMENT.txt")).as("each translation's statement").isRegularFile();
                    assertThat(t.resolve("SOURCE.md")).as("each translation's source").isRegularFile();
                    command.addAll(List.of("-add", "texts/" + code + "=" + t));
                }
            }
        }
        Path view = Files.isDirectory(src.resolve("view")) ? src.resolve("view") : src.resolve("view-dev");
        if (m(src).window() != null) {
            for (String f : List.of("index.html", "view.js", "view.css")) {
                command.addAll(List.of("-add", "view/" + f + "=" + view.resolve(f)));
            }
        }
        run(Path.of("docker").toAbsolutePath(), command.toArray(String[]::new));
        // The tool makes <out> under this machine's umask; the image's is root's 0755, as deskd's check wants.
        Files.setPosixFilePermissions(dir.resolve("bundled-apps"), java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"));
        try (Stream<Path> made = Files.list(dir.resolve("bundled-apps"))) {
            return made.findFirst().orElseThrow();
        }
    }

    /**
     * The Bible's own wire (apps/bible/API.md) through deskd: a chapter of the default translation, a highlight through
     * {@code apps.mutate} with its key passed on (a retry gets the first reply), the {@code bible.marks} patch it causes, and
     * the mark in the app's data folder, which the export carries.
     */
    @SuppressWarnings("unchecked")
    private static void theBiblesOwnPath(AppsRig rig, TestClient owner, String id) throws Exception {
        Map<String, Object> chapter = rig.ok(owner, "apps.call", "id", id, "m", "bible.chapter", "p",
                Map.of("translation", "bsb", "book", "JHN", "chapter", 3));
        assertThat(chapter).containsEntry("book", "JHN").containsEntry("chapter", 3);
        assertThat((List<Object>) chapter.get("items")).isNotEmpty();

        // The SUB above was the first: this one's snapshot is a look of its own, and then patches follow the marks.
        Map<String, Object> put = Map.of("mark", Map.of("kind", "highlight", "book", "JHN", "chapter", 3, "verse", 16,
                "color", "amber", "translation", "bsb"));
        Map<String, Object> first = rig.callWith(owner, "apps.mutate", "019a0000-0000-7000-8000-000000000001",
                AppsRig.params("id", id, "m", "bible.mark.put", "p", put));
        assertThat(first).as(first.toString()).containsEntry("_kind", "RES");
        Map<String, Object> mark = (Map<String, Object>) first.get("mark");
        assertThat(mark).containsEntry("kind", "highlight").containsEntry("color", "amber");
        Map<String, Object> again = rig.callWith(owner, "apps.mutate", "019a0000-0000-7000-8000-000000000001",
                AppsRig.params("id", id, "m", "bible.mark.put", "p", put));
        assertThat(again.get("mark")).as("the same key, the same reply").isEqualTo(mark);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            Map<String, Object> event = AppsRig.event(owner);
            assertThat(event).containsEntry("type", "patch");
        });
        Path data = rig.bundledData.resolve(id).resolve("data");
        await().atMost(Duration.ofSeconds(5)).until(() -> {
            try (Stream<Path> files = Files.list(data)) {
                for (Path f : files.toList()) {
                    if (Files.readString(f).contains((String) mark.get("id"))) {
                        return true;
                    }
                }
            }
            return false;
        });
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable(named = "DESKD_BUNDLED_GUILD", matches = "1")
    @SuppressWarnings("unchecked")
    void eachGuildMemberSeesOnlyTheirOwn() throws Exception {
        Path app = bundle();
        String id = app.getFileName().toString();
        BundledApps.Bundled checked = BundledApps.check(app, AppsModule.deskArch(), FakeAppHost.ownUid());
        try (AppsRig rig = new AppsRig(dir, true, true)) {
            rig.host.unavailable = "no_sandbox";
            rig.guild.set(true);
            rig.members.set(Set.of("gm-ffff0001", "gm-aaaa0001", "gm-bbbb0001"));
            TestClient founder = rig.member("f1", "gm-ffff0001", com.minimalistalliance.desk.deskd.rpc.Caller.LEAD);
            TestClient one = rig.member("m1", "gm-aaaa0001", com.minimalistalliance.desk.deskd.rpc.Caller.MEMBER);
            TestClient two = rig.member("m2", "gm-bbbb0001", com.minimalistalliance.desk.deskd.rpc.Caller.MEMBER);
            assertThat(rig.call(founder, "apps.install", "id", id, "version", checked.version(), "packageSha256",
                    checked.manifestSha256(), "grants", checked.manifest().permissions())).containsEntry("state", "running");
            Map<String, Object> put = Map.of("mark", Map.of("kind", "note", "book", "JHN", "chapter", 3, "verse", 16,
                    "text", "one's own", "translation", "bsb"));
            Map<String, Object> mine = rig.callWith(one, "apps.mutate", "019a0000-0000-7000-8000-0000000000a1",
                    AppsRig.params("id", id, "m", "bible.mark.put", "p", put));
            assertThat(mine).as(mine.toString()).containsEntry("_kind", "RES");
            String markId = (String) ((Map<String, Object>) mine.get("mark")).get("id");
            Map<String, Object> theirs = rig.ok(two, "apps.call", "id", id, "m", "bible.marks.chapter", "p",
                    Map.of("book", "JHN", "chapter", 3));
            assertThat(theirs.toString()).as("the other member sees none of it").doesNotContain(markId).doesNotContain("one's own");
            assertThat(rig.ok(one, "apps.call", "id", id, "m", "bible.marks.chapter", "p", Map.of("book", "JHN", "chapter", 3))
                    .toString()).contains(markId);
            Map<String, Object> twoPut = Map.of("mark", Map.of("kind", "note", "book", "JHN", "chapter", 3, "verse", 17,
                    "text", "two's own", "translation", "bsb"));
            Map<String, Object> twos = rig.callWith(two, "apps.mutate", "019a0000-0000-7000-8000-0000000000b2",
                    AppsRig.params("id", id, "m", "bible.mark.put", "p", twoPut));
            assertThat(twos).as(twos.toString()).containsEntry("_kind", "RES");
            String twoMarkId = (String) ((Map<String, Object>) twos.get("mark")).get("id");
            assertThat(rig.ok(one, "apps.call", "id", id, "m", "bible.marks.chapter", "p", Map.of("book", "JHN", "chapter", 3))
                    .toString()).as("nor the first the second's").doesNotContain(twoMarkId);
            // A place, as reading sets one: on a Guild Desk the widget still shows no member's.
            rig.callWith(one, "apps.mutate", "019a0000-0000-7000-8000-0000000000c3", AppsRig.params("id", id, "m",
                    "bible.prefs.set", "p", Map.of("place", Map.of("translation", "bsb", "book", "JHN", "chapter", 3, "verse", 16))));
            await().atMost(Duration.ofSeconds(10)).until(() -> AppsRig.app(rig.ok(founder, "apps.list"), id).get("summary") != null);
            Thread.sleep(1500);
            Map<String, Object> summary = (Map<String, Object>) AppsRig.app(rig.ok(founder, "apps.list"), id).get("summary");
            assertThat((List<Object>) summary.get("rows")).as("no member's place or words on the shared tile").isEmpty();

            // One leaves: the app is told, their note goes, and the other's stays.
            rig.members.set(Set.of("gm-ffff0001", "gm-bbbb0001"));
            Path data = rig.bundledData.resolve(id).resolve("data");
            await().atMost(Duration.ofSeconds(10)).until(() -> !dataHolds(data, "one's own"));
            assertThat(dataHolds(data, "two's own")).as("the other member's note is kept").isTrue();
            assertThat(rig.ok(two, "apps.call", "id", id, "m", "bible.marks.chapter", "p", Map.of("book", "JHN", "chapter", 3))
                    .toString()).contains(twoMarkId).doesNotContain(markId);
        }
    }

    private static boolean dataHolds(Path data, String text) throws IOException {
        try (Stream<Path> files = Files.list(data)) {
            for (Path f : files.toList()) {
                if (Files.isRegularFile(f) && Files.readString(f).contains(text)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** The source's manifest, read as a template: it has no arch or files yet, so only its shape is used. */
    private static AppManifest m(Path src) throws Exception {
        return AppManifest.parse(Files.readAllBytes(src.resolve("ma-app.json")));
    }

    @Test
    @SuppressWarnings("unchecked")
    void theRealServiceRunsBundled() throws Exception {
        Path app = bundle();
        String id = app.getFileName().toString();
        BundledApps.Bundled checked = BundledApps.check(app, AppsModule.deskArch(), FakeAppHost.ownUid());
        AppManifest m = checked.manifest();

        try (AppsRig rig = new AppsRig(dir, true, true)) {
            rig.host.unavailable = "no_sandbox";
            TestClient owner = rig.owner("s1");
            Map<String, Object> catalog = (Map<String, Object>) rig.ok(owner, "apps.catalog.get").get("catalog");
            assertThat(Json.bytes(catalog)).asString().contains("\"id\":\"" + id + "\"").contains(checked.manifestSha256());

            Map<String, Object> installed = rig.call(owner, "apps.install", "id", id, "version", m.version(), "packageSha256",
                    checked.manifestSha256(), "grants", m.permissions());
            assertThat(installed).as("install, so a real HELLO: " + installed).containsEntry("_kind", "RES").containsEntry("state", "running");
            BundledAppHost host = (BundledAppHost) rig.bundledHost;
            long pid = host.pid(id);
            assertThat(Files.readString(Path.of("/proc", String.valueOf(pid), "oom_score_adj")).strip()).isEqualTo("1000");

            Set<String> relayed = Set.of(RpcException.BAD_REQUEST, RpcException.NOT_FOUND, RpcException.PRECONDITION_FAILED,
                    RpcException.FORBIDDEN, RpcException.CONFLICT);
            String read = m.methods().entrySet().stream().filter(e -> !e.getValue()).map(Map.Entry::getKey).findFirst().orElse(null);
            if (read != null) {
                Map<String, Object> reply = rig.call(owner, "apps.call", "id", id, "m", read, "p", Map.of());
                assertThat(reply).as(read + " " + reply).satisfiesAnyOf(
                        r -> assertThat(r).containsEntry("_kind", "RES"),
                        r -> assertThat(relayed).contains((String) r.get("code")));
            }
            for (String topic : m.topics()) {
                assertThat(rig.subscribe(owner, "app:" + id + ":" + topic)).as(topic).containsEntry("_kind", "RES");
                assertThat(AppsRig.event(owner)).as(topic).containsEntry("type", "snapshot");
            }
            if (id.equals("com.minimalistalliance.bible")) {
                theBiblesOwnPath(rig, owner, id);
            }
            if (m.widget()) {
                await().atMost(Duration.ofSeconds(10)).until(() -> AppsRig.app(rig.ok(owner, "apps.list"), id).get("summary") != null);
            }
            if (m.window() != null) {
                assertThat(rig.ok(owner, "apps.view.get", "id", id)).containsEntry("bundled", true);
            }

            ProcessHandle process = ProcessHandle.of(pid).orElseThrow();
            long stopping = System.nanoTime();
            assertThat(rig.ok(owner, "apps.stop", "id", id)).containsEntry("state", "stopped");
            assertThat(process.isAlive()).isFalse();
            assertThat(Duration.ofNanos(System.nanoTime() - stopping)).as("it exits on SIGTERM, before its stopTimeoutSec runs out")
                    .isLessThan(Duration.ofSeconds(m.run().stopTimeoutSec()));
            assertThat(host.status(id)).isEqualTo(new AppHost.Status(AppHost.Status.STOPPED, null));
        }
    }
}
