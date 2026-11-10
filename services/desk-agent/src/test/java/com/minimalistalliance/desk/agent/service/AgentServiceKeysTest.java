package com.minimalistalliance.desk.agent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.key.KeyVault;
import com.minimalistalliance.desk.agent.limits.LimitSettings;
import com.minimalistalliance.desk.agent.limits.PriceTable;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.llm.LlmGateway;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.Duration;
import java.time.ZoneOffset;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * Keys across a restart (ADR 0042): {@link AgentService} on real SQLite files and a real vault in a temporary
 * directory, wired as AgentConfiguration wires it, with a new instance of everything for each start, as a restart
 * makes. A fake provider records the key each call was lent.
 */
@ExtendWith(OutputCaptureExtension.class)
class AgentServiceKeysTest {

    private static final String KEY = "sk-fake-service-0123456789abcdef";
    private static final String OTHER_KEY = "sk-fake-other-0123456789abcdef0";

    /** One start of desk-agent, as DeskAgentLifecycle opens it. */
    private final class Desk implements AutoCloseable {
        final MutableClock clock = new MutableClock(Rig.START);
        final AuditLog audit = new AuditLog(data.resolve("audit.db"), clock);
        final UsageLedger ledger = new UsageLedger(data.resolve("usage.db"), clock, ZoneOffset.UTC);
        final AgentStore store = new AgentStore(data.resolve("agent.db"), clock);
        final KeyRing keys = new KeyRing((action, target, decision) -> audit.append(AuditLog.Entry.of(
                target.equals("keys:all") ? "system" : "user", action, target, decision)));
        final KeyVault vault = new KeyVault(data.resolve("keys"));
        final FakeProvider provider = new FakeProvider();
        final AgentService service;

        Desk() throws SQLException {
            audit.open();
            ledger.open();
            store.open();
            ProviderRegistry providers = new ProviderRegistry();
            providers.register(provider);
            Pricing pricing = Pricing.of(Map.of(FakeProvider.ID.id() + "/" + Rig.MODEL,
                    new Pricing.Price(1_000_000, 100_000, 1_250_000, 2_000_000)));
            PriceTable prices = new PriceTable(pricing);
            LimitSettings limits = new LimitSettings();
            ManagerAgent manager =
                    new ManagerAgent(new LlmGateway(providers, keys, prices, ledger, audit), keys, limits, clock);
            service = new AgentService(store, manager, keys, vault, providers, prices, limits, ledger, audit,
                    new TopicHub(), clock, com.minimalistalliance.desk.agent.testing.Teams.team(store, limits, audit,
                            data, clock));
            service.restore();
        }

        String add(String key) throws Exception {
            Map<String, Object> added = service.keyAdd(
                    Map.of("provider", FakeProvider.ID.id(), "label", "Main", "deskId", "d-test"), direct(key));
            return (String) view(added.get("key")).get("keyId");
        }

        void bind(String keyId) throws Exception {
            service.call("agent.bind", Map.of("agentId", AgentStore.MANAGER, "keyId", keyId, "model", Rig.MODEL));
        }

        Map<String, Object> listedKey() throws Exception {
            List<?> list = (List<?>) service.call("agent.key.list", Map.of()).get("keys");
            assertThat(list).hasSize(1);
            return view(list.get(0));
        }

        List<?> listedKeys() throws Exception {
            return (List<?>) service.call("agent.key.list", Map.of()).get("keys");
        }

        String managerStatus() throws Exception {
            return (String) view(((List<?>) service.call("agent.list", Map.of()).get("agents")).get(0)).get("status");
        }

        List<AuditLog.Row> rows(String action) throws SQLException {
            return audit.readBefore(null, 200).stream()
                    .filter(row -> row.entry().action().equals(action))
                    .toList();
        }

        @Override
        public void close() {
            service.stopAll();
            keys.dropAll();
            store.close();
            ledger.close();
            audit.close();
        }
    }

    @TempDir
    Path data;

    private Desk desk;

    @BeforeEach
    void start() throws Exception {
        desk = new Desk();
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    private void restart() throws Exception {
        desk.close();
        desk = new Desk();
    }

    @Test
    void aKeyAddedIsBackAfterARestartAndTheProviderGetsExactlyThatKey(CapturedOutput output) throws Exception {
        String keyId = desk.add(KEY);
        desk.bind(keyId);
        assertThat(sealed(keyId)).exists();

        restart();

        assertThat(desk.listedKey()).containsEntry("keyId", keyId).containsEntry("available", true)
                .containsEntry("last4", "cdef");
        assertThat(desk.keys.size()).isEqualTo(1);
        assertThat(desk.managerStatus()).isEqualTo("online");
        assertThat(desk.provider.seen).as("nothing's called just to restore a key").isEmpty();

        desk.service.call("agent.message.send", Map.of("agentId", AgentStore.MANAGER, "text", "Hello?"));
        await().atMost(Duration.ofSeconds(10)).until(() -> !desk.provider.seen.isEmpty());
        assertThat(desk.provider.seen.peek().key()).isEqualTo(KEY);
        await().atMost(Duration.ofSeconds(10)).until(() -> desk.managerStatus().equals("online"));

        assertThat(fileContents()).doesNotContain(KEY);
        assertThat(output.getAll()).doesNotContain(KEY);
    }

    @Test
    void aDeletedKeyStaysGoneAfterARestart(CapturedOutput output) throws Exception {
        String keyId = desk.add(KEY);
        desk.bind(keyId);

        assertThat(desk.service.call("agent.key.delete", Map.of("keyId", keyId))).isEmpty();
        assertThat(sealed(keyId)).doesNotExist();
        assertThat(desk.keys.size()).isZero();
        assertThat(desk.managerStatus()).isEqualTo("no_key");

        restart();

        assertThat(desk.listedKeys()).isEmpty();
        assertThat(desk.keys.size()).isZero();
        assertThat(desk.managerStatus()).isEqualTo("no_key");
        assertThat(refusal(() -> desk.service.call("agent.key.delete", Map.of("keyId", keyId))).code())
                .isEqualTo("not_found");
        assertThat(output.getAll()).doesNotContain(KEY);
    }

    @Test
    void anOrphanFromACrashIsRemoved() throws Exception {
        String keyId = desk.add(KEY);
        new KeyVault(data.resolve("keys")).seal("k-orphan", FakeProvider.ID.id(), KEY.getBytes(StandardCharsets.US_ASCII));

        restart();

        assertThat(sealed("k-orphan")).doesNotExist();
        assertThat(sealed(keyId)).exists();
        assertThat(desk.listedKey()).containsEntry("keyId", keyId).containsEntry("available", true);
    }

    @Test
    void aRowWithNoFileIsUnavailableAndNoKey() throws Exception {
        String keyId = desk.add(KEY);
        desk.bind(keyId);
        Files.delete(sealed(keyId));

        restart();

        assertThat(desk.listedKey()).containsEntry("keyId", keyId).containsEntry("available", false);
        assertThat(desk.managerStatus()).isEqualTo("no_key");
        RpcError sent = refusal(
                () -> desk.service.call("agent.message.send", Map.of("agentId", AgentStore.MANAGER, "text", "Hello?")));
        assertThat(sent.code()).isEqualTo("precondition_failed");
        assertThat(sent.details()).containsEntry("reason", "no_key");
        RpcError models = refusal(() -> desk.service.call("agent.key.models", Map.of("keyId", keyId)));
        assertThat(models.details()).containsEntry("reason", "no_key");
    }

    /** Most of all a lost master: if the member's desk is ever repaired, the sealed file is still what holds the key. */
    @Test
    void aFileThatWontOpenIsKeptUntilTheMemberDeletesTheKey(CapturedOutput output) throws Exception {
        String keyId = desk.add(KEY);
        Files.delete(data.resolve("keys/master.key"));

        restart();

        assertThat(desk.listedKey()).containsEntry("available", false);
        assertThat(sealed(keyId)).exists();
        assertThat(output.getAll()).contains("key vault: no master key").doesNotContain(KEY);

        restart();
        assertThat(sealed(keyId)).as("a later start leaves it too").exists();

        desk.service.call("agent.key.delete", Map.of("keyId", keyId));
        assertThat(sealed(keyId)).doesNotExist();
        assertThat(desk.listedKeys()).isEmpty();
        assertThat(desk.rows("key.drop").getFirst().entry().decision()).isEqualTo("not_held");
    }

    /** Every new desk's first boot makes a master key, which isn't news. */
    @Test
    void aFirstStartMakesTheMasterWithoutAWarning(CapturedOutput output) {
        assertThat(data.resolve("keys/master.key")).exists();
        assertThat(output.getAll()).contains("made its master key").doesNotContain("WARN");
    }

    @Test
    void aKeyAddedAfterTheMasterWasLostWorks() throws Exception {
        String lost = desk.add(KEY);
        Files.delete(data.resolve("keys/master.key"));
        restart();

        String keyId = desk.add(OTHER_KEY);
        restart();

        assertThat(desk.listedKeys()).hasSize(2);
        assertThat(desk.keys.providerOf(keyId)).isNotNull();
        assertThat(desk.keys.providerOf(lost)).isNull();
    }

    @Test
    void aFailedSealAnswersUnavailableAndKeepsNothing(CapturedOutput output) throws Exception {
        breakTheVault();

        RpcError refused = refusal(() -> desk.add(KEY));

        assertThat(refused.code()).isEqualTo("unavailable");
        assertThat(refused.details()).containsEntry("reason", "storage");
        assertThat(desk.keys.size()).isZero();
        assertThat(desk.listedKeys()).isEmpty();
        assertThat(fileContents()).doesNotContain(KEY);
        assertThat(output.getAll()).doesNotContain(KEY);

        repairTheVault();
        assertThat(names()).doesNotContain("k-").noneMatch(name -> name.endsWith(".tmp") || name.endsWith(".sealed"));
    }

    @Test
    void aFailedInsertRemovesTheSealedFile() throws Exception {
        desk.store.close();

        assertThatThrownBy(() -> desk.add(KEY)).isInstanceOf(SQLException.class);

        assertThat(desk.keys.size()).isZero();
        assertThat(names()).containsExactly("master.key");
    }

    @Test
    void aRefusedKeyIsNeverSealed() throws Exception {
        desk.provider.modelsFailure = new ProviderException(ProviderException.Kind.AUTH, false);

        RpcError refused = refusal(() -> desk.add(KEY));

        assertThat(refused.details()).containsEntry("reason", "key_refused");
        assertThat(names()).containsExactly("master.key");
    }

    @Test
    void aFailedUnlinkAnswersUnavailableAndTheSameCallFinishesIt() throws Exception {
        String keyId = desk.add(KEY);
        breakTheVault();

        RpcError refused = refusal(() -> desk.service.call("agent.key.delete", Map.of("keyId", keyId)));

        assertThat(refused.code()).isEqualTo("unavailable");
        assertThat(refused.details()).containsEntry("reason", "storage");
        assertThat(desk.listedKeys()).as("the row is the commit point").isEmpty();
        assertThat(desk.keys.size()).isZero();

        repairTheVault();
        assertThat(sealed(keyId)).exists();
        assertThat(desk.service.call("agent.key.delete", Map.of("keyId", keyId))).isEmpty();
        assertThat(sealed(keyId)).doesNotExist();
        assertThat(refusal(() -> desk.service.call("agent.key.delete", Map.of("keyId", keyId))).code())
                .isEqualTo("not_found");
    }

    @Test
    void aFileAFailedUnlinkLeftIsGoneAfterTheNextStart() throws Exception {
        String keyId = desk.add(KEY);
        breakTheVault();
        refusal(() -> desk.service.call("agent.key.delete", Map.of("keyId", keyId)));
        repairTheVault();

        restart();

        assertThat(sealed(keyId)).doesNotExist();
    }

    @Test
    void aBadVaultDoesntStopAStart(CapturedOutput output) throws Exception {
        String keyId = desk.add(KEY);
        breakTheVault();

        restart();

        assertThat(desk.listedKey()).containsEntry("keyId", keyId).containsEntry("available", false);
        assertThat(desk.rows("key.restore").getFirst().entry().decision()).isEqualTo("restored:0:unreadable:1");
        assertThat(output.getAll()).contains("key vault isn't usable").doesNotContain(KEY);

        repairTheVault();
        restart();
        assertThat(desk.listedKey()).containsEntry("available", true);
    }

    @Test
    void oneRestoreRowPerStartWithItsCounts() throws Exception {
        assertThat(desk.rows("key.restore")).isEmpty();
        restart();
        assertThat(desk.rows("key.restore")).as("no keys, no row").isEmpty();

        desk.add(KEY);
        String broken = desk.add(OTHER_KEY);
        Files.delete(sealed(broken));
        int adds = desk.rows("key.add").size();

        restart();
        restart();

        List<AuditLog.Row> restores = desk.rows("key.restore");
        assertThat(restores).hasSize(2);
        assertThat(restores).allSatisfy(row -> {
            assertThat(row.entry().actor()).isEqualTo("system");
            assertThat(row.entry().target()).isEqualTo("keys:all");
            assertThat(row.entry().decision()).isEqualTo("restored:1:unreadable:1");
        });
        assertThat(desk.rows("key.add")).as("a restore isn't an add").hasSize(adds);
    }

    private Path sealed(String keyId) {
        return data.resolve("keys").resolve(keyId + ".sealed");
    }

    /** A regular file where the directory should be: it fails for root too, as a mode wouldn't. */
    private void breakTheVault() throws IOException {
        Files.move(data.resolve("keys"), data.resolve("keys-moved"));
        Files.writeString(data.resolve("keys"), "not a directory");
    }

    private void repairTheVault() throws IOException {
        Files.delete(data.resolve("keys"));
        Files.move(data.resolve("keys-moved"), data.resolve("keys"));
    }

    private List<String> names() throws IOException {
        try (Stream<Path> files = Files.list(data.resolve("keys"))) {
            return files.map(file -> file.getFileName().toString()).toList();
        }
    }

    /** Every byte of every file under the data directory, the databases' -wal files among them. */
    private String fileContents() throws IOException {
        StringBuilder all = new StringBuilder();
        try (Stream<Path> walk = Files.walk(data)) {
            for (Path file : walk.filter(Files::isRegularFile).sorted(Comparator.naturalOrder()).toList()) {
                all.append(new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1));
            }
        }
        return all.toString();
    }

    private static ByteBuffer direct(String key) {
        byte[] bytes = key.getBytes(StandardCharsets.US_ASCII);
        return ByteBuffer.allocateDirect(bytes.length).put(bytes).flip();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> view(Object value) {
        return (Map<String, Object>) value;
    }

    @FunctionalInterface
    private interface Call {
        void run() throws Exception;
    }

    private static RpcError refusal(Call call) {
        try {
            call.run();
        } catch (RpcError e) {
            return e;
        } catch (Exception e) {
            throw new AssertionError("refused some other way: " + e.getClass().getSimpleName());
        }
        throw new AssertionError("it wasn't refused");
    }
}
