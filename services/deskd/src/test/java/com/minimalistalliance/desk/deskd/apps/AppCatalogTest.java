package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AppCatalogTest {

    @TempDir
    Path dir;

    private final TestApps apps = new TestApps();

    @Test
    void aSignedIndexVerifiesAndSaysWhatEachVersionNeeds() throws Exception {
        TestApps.Built b = apps.build("1.0.0");
        AppCatalog catalog = AppCatalog.verify(apps.catalog(3, List.of(b), List.of(), List.of()), List.of(apps.reviewKey("community")));
        assertThat(catalog.seq()).isEqualTo(3);
        AppCatalog.Version v = catalog.find(TestApps.ID, "1.0.0", apps.arch);
        assertThat(v.packageSha256()).isEqualTo(b.sha256());
        assertThat(v.manifestSha256()).isEqualTo(b.manifestSha256());
        assertThat(catalog.developers()).singleElement().extracting(AppKeys.TrustedKey::publisher).isEqualTo(TestApps.PUBLISHER);
        assertThat(catalog.whyNot(v, "1.0", Set.of("background"))).isNull();
        assertThat(catalog.whyNot(v, "2.0", Set.of("background"))).isEqualTo("app_api");
        assertThat(catalog.find(TestApps.ID, "1.0.0", "riscv64")).isNull();
    }

    @Test
    void anIndexNoReviewKeySignedIsRefused() {
        TestApps.Built b = apps.build("1.0.0");
        byte[] envelope = apps.catalog(1, List.of(b), List.of(), List.of());
        TestApps other = new TestApps();
        assertThatThrownBy(() -> AppCatalog.verify(envelope, List.of(other.reviewKey("community")))).hasMessage("signature");
        assertThatThrownBy(() -> AppCatalog.verify(envelope, List.of())).hasMessage("signature");
        Map<String, Object> outer = Map.of("index", "e30=", "signatures", List.of());
        assertThatThrownBy(() -> AppCatalog.verify(Json.bytes(outer), List.of(apps.reviewKey("community")))).hasMessage("envelope");
    }

    @Test
    void aDeveloperKeyWhoseIdDoesntMatchItsKeyIsRefused() {
        String index = "{\"catalog\":1,\"seq\":1,\"developers\":[{\"keyId\":\"0000000000000000\",\"publisher\":\"P\",\"publicKey\":\""
                + java.util.Base64.getEncoder().encodeToString(apps.developer.getPublic().getEncoded()) + "\"}]}";
        byte[] envelope = TestApps.envelope(index.getBytes(), apps.review);
        assertThatThrownBy(() -> AppCatalog.verify(envelope, List.of(apps.reviewKey("community")))).hasMessage("developers.keyId");
    }

    @Test
    void revokedPackagesShowAsNotInstallable() throws Exception {
        TestApps.Built b = apps.build("1.0.0");
        AppCatalog catalog = AppCatalog.verify(apps.catalog(2, List.of(b), List.of(), List.of(b.manifestSha256())),
                List.of(apps.reviewKey("community")));
        assertThat(catalog.whyNot(catalog.find(TestApps.ID, "1.0.0", apps.arch), "1.0", Set.of())).isEqualTo("revoked");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> list = (List<Map<String, Object>>) catalog.toJson(apps.arch, "1.0", Set.of(), Map.of()).get("apps");
        @SuppressWarnings("unchecked")
        Map<String, Object> version = ((List<Map<String, Object>>) list.get(0).get("versions")).get(0);
        assertThat(version).containsEntry("installable", false).containsEntry("reason", "revoked");
    }

    @Test
    void theKeeperRefusesAnOlderIndexAndKeepsTheNewestSeqOnTheVolume() throws Exception {
        Path root = Files.createDirectories(dir.resolve("apps"));
        AppStore store = new AppStore(root);
        TestApps.Source source = new TestApps.Source();
        TestApps.Built b = apps.build("1.0.0");
        CatalogKeeper keeper = new CatalogKeeper(store, () -> List.of(apps.reviewKey("community")), source, Clock.systemUTC());
        source.catalog = apps.catalog(5, List.of(b), List.of(), List.of());
        assertThat(keeper.fresh(Duration.ZERO).seq()).isEqualTo(5);
        assertThat(Files.readString(root.resolve(AppStore.REGISTRY))).contains("\"catalogSeq\":5");

        source.catalog = apps.catalog(4, List.of(b), List.of(), List.of());
        assertThat(keeper.fresh(Duration.ZERO).seq()).as("a replayed older index").isEqualTo(5);

        source.catalog = apps.catalog(6, List.of(b), List.of(), List.of());
        assertThat(keeper.fresh(Duration.ofHours(1)).seq()).as("fresh enough: not fetched").isEqualTo(5);
        assertThat(keeper.fresh(Duration.ZERO).seq()).isEqualTo(6);

        // After a restart nothing is in memory, and the seq on the volume is still the floor.
        CatalogKeeper restarted = new CatalogKeeper(new AppStore(root), () -> List.of(apps.reviewKey("community")), source, Clock.systemUTC());
        assertThat(restarted.current()).isNull();
        source.catalog = apps.catalog(5, List.of(b), List.of(), List.of());
        assertThat(restarted.fresh(Duration.ZERO)).as("a replay after a restart").isNull();
        source.catalog = apps.catalog(6, List.of(b), List.of(), List.of());
        assertThat(restarted.fresh(Duration.ZERO).seq()).isEqualTo(6);
    }

    @Test
    void anUnsignedIndexFromThePlatformLeavesTheKeptOne() throws Exception {
        AppStore store = new AppStore(Files.createDirectories(dir.resolve("apps")));
        TestApps.Source source = new TestApps.Source();
        CatalogKeeper keeper = new CatalogKeeper(store, () -> List.of(apps.reviewKey("community")), source, Clock.systemUTC());
        source.catalog = apps.catalog(1, List.of(apps.build("1.0.0")), List.of(), List.of());
        keeper.fresh(Duration.ZERO);
        source.catalog = TestApps.envelope("{\"catalog\":1,\"seq\":9}".getBytes(), TestApps.ed25519());
        assertThat(keeper.fresh(Duration.ZERO).seq()).isEqualTo(1);
    }
}
