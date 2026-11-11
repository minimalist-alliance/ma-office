package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

class AppManifestTest {

    private final TestApps apps = new TestApps();

    private AppManifest parse(Map<String, Object> m) throws Exception {
        return AppManifest.parse(Json.bytes(m));
    }

    private List<String> problems(Consumer<Map<String, Object>> change, String tier) throws Exception {
        Map<String, Object> m = apps.manifest("1.0.0", TestApps.files());
        change.accept(m);
        return parse(m).problems(tier, apps.arch, AppsModule.APP_API);
    }

    @Test
    void theSampleShapedManifestPassesAndKeepsItsBytes() throws Exception {
        Map<String, Object> m = apps.manifest("1.2.3", TestApps.files());
        byte[] raw = Json.bytes(m);
        AppManifest manifest = AppManifest.parse(raw);
        assertThat(manifest.problems(AppManifest.COMMUNITY, apps.arch, "1.0")).isEmpty();
        assertThat(manifest.raw()).isEqualTo(raw);
        assertThat(manifest.methods()).containsEntry("tally.add", true).containsEntry("tally.get", false);
        assertThat(manifest.resources().memoryMaxMiB()).isEqualTo(32);
        assertThat(manifest.window().minWidth()).isEqualTo(280);
        assertThat(manifest.widget()).isTrue();
    }

    @Test
    void anUnknownFieldAnywhereIsRefusedNotIgnored() throws Exception {
        Map<String, Object> top = apps.manifest("1.0.0", TestApps.files());
        top.put("clearBrowser", true);
        assertThatThrownBy(() -> parse(top)).isInstanceOf(AppManifest.ManifestException.class).hasMessage("unknown field");

        Map<String, Object> nested = apps.manifest("1.0.0", TestApps.files());
        @SuppressWarnings("unchecked")
        Map<String, Object> run = (Map<String, Object>) nested.get("run");
        run.put("user", "root");
        assertThatThrownBy(() -> parse(nested)).hasMessage("run.unknown field");
    }

    @Test
    void wrongShapesNameTheField() {
        assertThatThrownBy(() -> AppManifest.parse("[]".getBytes())).hasMessage("json");
        assertThatThrownBy(() -> AppManifest.parse(new byte[0])).hasMessage("size");
        Map<String, Object> m = apps.manifest("1.0.0", TestApps.files());
        m.put("manifest", 2);
        assertThatThrownBy(() -> parse(m)).hasMessage("manifest");
    }

    @Test
    void zeroResourcesTakeTheDefaults() throws Exception {
        Map<String, Object> m = apps.manifest("1.0.0", TestApps.files());
        m.remove("resources");
        AppManifest manifest = parse(m);
        assertThat(manifest.resources()).isEqualTo(AppManifest.DEFAULTS);
    }

    @Test
    void theRulesOfSection12() throws Exception {
        assertThat(problems(m -> m.put("id", "Tally"), AppManifest.COMMUNITY)).anyMatch(p -> p.startsWith("id:"));
        assertThat(problems(m -> m.put("version", "1.0"), AppManifest.COMMUNITY)).anyMatch(p -> p.startsWith("version:"));
        assertThat(problems(m -> m.remove("source"), AppManifest.COMMUNITY)).anyMatch(p -> p.startsWith("source and license"));
        assertThat(problems(m -> m.remove("source"), AppManifest.FIRST_PARTY)).noneMatch(p -> p.startsWith("source and license"));
        assertThat(problems(m -> m.put("appApi", ">=2.0 <3"), AppManifest.COMMUNITY)).anyMatch(p -> p.startsWith("appApi:"));
        assertThat(problems(m -> m.put("arch", "riscv64"), AppManifest.COMMUNITY)).anyMatch(p -> p.startsWith("arch:"));
    }

    @Test
    void resourcesAreHeldToTheTiersCeilings() throws Exception {
        Consumer<Map<String, Object>> big = m -> m.put("resources", new LinkedHashMap<>(Map.of("memoryMaxMiB", 512, "diskMaxMiB", 16)));
        assertThat(problems(big, AppManifest.COMMUNITY)).anyMatch(p -> p.startsWith("resources.memoryMaxMiB"));
        assertThat(problems(big, AppManifest.FIRST_PARTY)).noneMatch(p -> p.startsWith("resources.memoryMaxMiB"));
        assertThat(problems(m -> m.put("resources", new LinkedHashMap<>(Map.of("cpuMax", 0.75))), AppManifest.COMMUNITY))
                .anyMatch(p -> p.startsWith("resources.cpuMax"));
        assertThat(problems(m -> m.put("resources", new LinkedHashMap<>(Map.of("diskMaxMiB", 1))), AppManifest.COMMUNITY))
                .noneMatch(p -> p.startsWith("files:"));
    }

    @Test
    void theFilesCountAgainstTheAppsOwnDisk() throws Exception {
        Map<String, byte[]> files = TestApps.files();
        files.put("data/big.bin", new byte[(1 << 20) + 1]);
        Map<String, Object> m = apps.manifest("1.0.0", files);
        m.put("resources", new LinkedHashMap<>(Map.of("diskMaxMiB", 1)));
        assertThat(parse(m).problems(AppManifest.COMMUNITY, apps.arch, "1.0")).anyMatch(p -> p.startsWith("files: more bytes"));
    }

    @Test
    void permissionsAreAClosedListAndBackgroundAndNetGoWithTheirParts() throws Exception {
        assertThat(problems(m -> m.put("permissions", List.of("browser.session")), AppManifest.FIRST_PARTY))
                .anyMatch(p -> p.startsWith("permissions: unknown"));
        assertThat(problems(m -> m.put("permissions", List.of("background", "background")), AppManifest.FIRST_PARTY))
                .anyMatch(p -> p.startsWith("permissions: unknown or repeated"));
        assertThat(problems(m -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> run = (Map<String, Object>) m.get("run");
            run.put("start", "background");
        }, AppManifest.COMMUNITY)).anyMatch(p -> p.startsWith("run.start: background needs"));
        assertThat(problems(m -> m.put("permissions", List.of("net")), AppManifest.COMMUNITY))
                .anyMatch(p -> p.startsWith("net: the net permission"));
        assertThat(problems(m -> {
            m.put("permissions", List.of("net"));
            m.put("net", List.of(Map.of("host", "1.2.3.4", "port", 443, "why", "x")));
        }, AppManifest.COMMUNITY)).anyMatch(p -> p.startsWith("net: each host"));
        assertThat(problems(m -> m.put("permissions", List.of("display")), AppManifest.COMMUNITY))
                .anyMatch(p -> p.startsWith("permissions: display"));
    }

    @Test
    void reservedNamespacesCantBeTaken() throws Exception {
        for (String name : List.of("desk.clear", "browser.cookies", "apps.install", "agent.run", "notebook.read", "files.list")) {
            assertThat(problems(m -> m.put("methods", List.of(Map.of("name", name, "mutation", false))), AppManifest.COMMUNITY))
                    .as(name).anyMatch(p -> p.startsWith("methods:"));
        }
        assertThat(problems(m -> m.put("topics", List.of("app.summary")), AppManifest.COMMUNITY)).anyMatch(p -> p.startsWith("topics:"));
    }

    @Test
    void theExecutableMustBeAnExecutableFileInThePackage() throws Exception {
        assertThat(problems(m -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> run = (Map<String, Object>) m.get("run");
            run.put("exec", List.of("view/view.js"));
        }, AppManifest.COMMUNITY)).anyMatch(p -> p.startsWith("run.exec"));
    }

    @Test
    void theViewIsAtMost512KibAndAtLeastItsMinimumSize() throws Exception {
        Map<String, byte[]> files = TestApps.files();
        files.put("view/view.js", new byte[600 << 10]);
        Map<String, Object> m = apps.manifest("1.0.0", files);
        assertThat(parse(m).problems(AppManifest.COMMUNITY, apps.arch, "1.0")).anyMatch(p -> p.startsWith("views.window: its files at most"));
    }

    @Test
    void pathsMustBeCleanAndRelative() {
        assertThat(AppManifest.cleanPath("bin/tally")).isTrue();
        for (String bad : List.of("", "/etc/passwd", "../x", "a/../b", "a//b", "a/./b", "a\\b", "a/", "x\u0001")) {
            assertThat(AppManifest.cleanPath(bad)).as(bad).isFalse();
        }
    }

    @Test
    void theAppApiRangeIsReadAsWritten() throws Exception {
        AppManifest m = parse(apps.manifest("1.0.0", TestApps.files()));
        assertThat(m.acceptsAppApi("1.0")).isTrue();
        assertThat(m.acceptsAppApi("1.9")).isTrue();
        assertThat(m.acceptsAppApi("2.0")).isFalse();
        assertThat(m.acceptsAppApi("0.9")).isFalse();
        assertThat(m.acceptsAppApi("junk")).isFalse();
    }

    @Test
    void problemsNeverQuoteTheManifestsValues() throws Exception {
        String marker = "MARKER-VALUE";
        List<String> found = new ArrayList<>(problems(m -> {
            m.put("id", marker);
            m.put("arch", marker);
        }, AppManifest.COMMUNITY));
        assertThat(found).isNotEmpty().noneMatch(p -> p.contains(marker));
    }
}
