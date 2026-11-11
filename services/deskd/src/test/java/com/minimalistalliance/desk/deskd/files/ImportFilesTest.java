package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** What the Browser's import may do with a member's Files, against a real tree: read, and nothing else. The file's content is a fake one. */
class ImportFilesTest {

    private static final byte[] FAKE = "url,password\nhttps://a.example/,fake-password\n".getBytes(StandardCharsets.UTF_8);

    @TempDir
    Path dir;

    FilesRig rig;
    ImportFiles imports;

    @BeforeEach
    void setUp() throws Exception {
        rig = new FilesRig(dir);
        imports = rig.files.importFiles();
        Files.createDirectories(rig.root.resolve("Imports"));
        Files.write(rig.root.resolve("Imports/passwords.csv"), FAKE);
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private static void assertRefused(ThrowingRead read, String code, Map<String, Object> details) {
        assertThatThrownBy(read::run).isInstanceOfSatisfying(RpcException.class, e -> {
            assertThat(e.code()).isEqualTo(code);
            assertThat(e.details()).isEqualTo(details);
        });
    }

    @FunctionalInterface
    private interface ThrowingRead {
        void run() throws Exception;
    }

    @Test
    void aFileIsReadWholeAndLeftWhereItIs() throws Exception {
        ImportFiles.Read read = imports.read("Imports/passwords.csv", 1024);
        assertThat(read.bytes()).isEqualTo(FAKE);
        assertThat(read.size()).isEqualTo(FAKE.length);
        assertThat(rig.root.resolve("Imports/passwords.csv")).hasBinaryContent(FAKE);
    }

    @Test
    void aPasswordsFileAMemberPutInFilesIsLeftAloneBySweeps() throws Exception {
        TestClient owner = rig.owner("s-1");
        Files.write(rig.root.resolve("Chrome Passwords.csv"), FAKE);

        rig.files.sweep();

        // deskd neither reads, moves nor deletes it: what's in Files is the member's to keep or delete.
        assertThat(rig.root.resolve("Chrome Passwords.csv")).hasBinaryContent(FAKE);
        assertThat(rig.root.resolve("Imports/passwords.csv")).hasBinaryContent(FAKE);
        assertThat((List<?>) rig.call(owner, "files.trash.list").get("items")).isEmpty();
    }

    @Test
    void theTreesRulesAndLimitsHold() throws Exception {
        assertRefused(() -> imports.read("Imports/missing.csv", 1024), "not_found", Map.of());
        assertRefused(() -> imports.read("Imports", 1024), "invalid", Map.of("reason", "is_a_folder"));
        assertRefused(() -> imports.read("Imports/passwords.csv", 10), "too_large", Map.of("limit", 10L));
        assertRefused(() -> imports.read("../outside.csv", 1024), "invalid", Map.of("reason", "dots"));
        assertRefused(() -> imports.read(".trash/x", 1024), "invalid", Map.of("reason", "reserved"));
        assertRefused(() -> imports.read("", 1024), "invalid", Map.of("reason", "empty"));
        Files.createSymbolicLink(rig.root.resolve("Imports/link.csv"), rig.root.resolve("Imports/passwords.csv"));
        assertRefused(() -> imports.read("Imports/link.csv", 1024), "not_found", Map.of());
    }
}
