package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * deskd's own copy of each agent's access (draft ADR "the Agent's tools and approvals", sections 15 and 16; Security
 * question 5): recorded only as the member asked and desk-agent holds, kept under deskd's own MAC, and read back as
 * nothing at all when it doesn't verify.
 */
class AccessRecordTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-12T20:00:00Z"), ZoneOffset.UTC);
    private static final Caller MEMBER = new Caller(Caller.GUILD_MEMBER, "gm-abcd1234", Caller.MEMBER, List.of(), "M",
            null, false);

    @TempDir
    Path dir;

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private static Map<String, Object> apps(boolean notebook, boolean files, boolean browser, boolean courier,
            boolean todos) {
        return m("notebook", notebook, "files", files, "browser", browser, "courier", courier, "todos", todos);
    }

    private static Map<String, Object> autoOff() {
        return m("notebook", null, "files", null, "todos", false);
    }

    /** desk-agent's answer: {@code {access}} with these apps, switches and send halves. */
    private static Map<String, Object> held(Map<String, Object> apps, Map<String, Object> auto,
            List<Map<String, Object>> desks) {
        return m("access", m("chosen", true, "setup", null, "apps", apps, "auto", auto, "desks", desks, "incoming",
                List.of()));
    }

    private static Map<String, Object> half(String agentId, String deskId, String state) {
        return m("grantId", "dg-aaaaaaaaaaaaaaaaaaaa", "agentId", agentId, "toDeskId", deskId, "toDeskName", "Work",
                "state", state);
    }

    private AccessRecord kept() {
        AccessRecord record = new AccessRecord(CLOCK);
        record.keepIn(dir);
        return record;
    }

    private void setUp(AccessRecord record, String agentId, Map<String, Object> apps) {
        record.recordSet(agentId, m("agentId", agentId, "apps", apps, "auto", autoOff()), held(apps, autoOff(),
                List.of()), Caller.THE_OWNER);
    }

    @Test
    void anAgentNotRecordedGetsNothingInAnyArea() {
        AccessRecord record = kept();
        for (String area : List.of(HostedDecls.FILES, HostedDecls.BROWSER, HostedDecls.NOTEBOOK, "courier", "todo")) {
            assertThat(record.refusal("ag-1", area)).isEqualTo("setup");
        }
        assertThat(record.recorded()).isEmpty();
        assertThat(record.entry("ag-1")).isNull();
    }

    @Test
    void aSetIsRecordedAsTheMemberAskedAndAppsOffAreOutOfScope() {
        AccessRecord record = kept();
        setUp(record, "ag-1", apps(true, false, true, false, true));
        assertThat(record.refusal("ag-1", HostedDecls.NOTEBOOK)).isNull();
        assertThat(record.refusal("ag-1", HostedDecls.BROWSER)).isNull();
        assertThat(record.refusal("ag-1", HostedDecls.FILES)).isEqualTo("scope");
        assertThat(record.refusal("ag-1", "courier")).isEqualTo("scope");
        assertThat(record.refusal("ag-1", "todo")).isNull();
        // An area no app covers is never let through.
        assertThat(record.refusal("ag-1", "shell")).isEqualTo("scope");
        assertThat(record.recorded()).containsExactly("ag-1");
        assertThat(record.entry("ag-1").at()).isEqualTo(CLOCK.millis());
    }

    @Test
    void deskdNeverHoldsMoreThanDeskAgentSaysItApplied() {
        AccessRecord record = kept();
        // The member asked for Files; desk-agent's answer says it holds Files off (a wrong desk-agent's, or a race).
        record.recordSet("ag-1", m("agentId", "ag-1", "apps", apps(true, true, true, false, true), "auto",
                m("notebook", m("tabId", "tab-1"), "files", m("folder", "A"), "todos", true)),
                held(apps(true, false, true, false, true), m("notebook", m("tabId", "tab-OTHER"), "files",
                        m("folder", "A"), "todos", true), List.of()), Caller.THE_OWNER);
        AccessRecord.Entry entry = record.entry("ag-1");
        assertThat(entry.apps()).containsExactlyInAnyOrder("notebook", "browser", "todos");
        assertThat(entry.notebookTab()).as("the tabs differ").isNull();
        assertThat(entry.filesFolder()).as("Files is off in desk-agent's").isNull();
        assertThat(entry.todos()).isTrue();
        // And desk-agent saying more than the member asked never adds it either.
        record.recordSet("ag-2", m("agentId", "ag-2", "apps", apps(true, false, false, false, false), "auto",
                autoOff()), held(apps(true, true, true, true, true), m("notebook", m("tabId", "t"), "files",
                        m("folder", "F"), "todos", true), List.of()), Caller.THE_OWNER);
        assertThat(record.entry("ag-2").apps()).containsExactly("notebook");
        assertThat(record.entry("ag-2").anyAuto()).isFalse();
    }

    @Test
    void aLaterChangeMergesOntoDeskdsOwnCopy() {
        AccessRecord record = kept();
        setUp(record, "ag-1", apps(true, true, true, false, true));
        record.recordSet("ag-1", m("agentId", "ag-1", "apps", m("files", false)), held(apps(true, false, true, false,
                true), autoOff(), List.of()), Caller.THE_OWNER);
        assertThat(record.entry("ag-1").apps()).containsExactlyInAnyOrder("notebook", "browser", "todos");
        // Revoking mid-run: the very next call of that app is refused.
        assertThat(record.refusal("ag-1", HostedDecls.FILES)).isEqualTo("scope");
    }

    @Test
    void aWriteThatFailsSetsTheLastFileAsideSoARestartFailsClosed() throws Exception {
        AccessRecord record = kept();
        setUp(record, "ag-1", apps(true, true, true, false, true));
        record.recordSet("ag-1", m("agentId", "ag-1", "desks", List.of(m("deskId", "d-work", "deskName", "Work",
                "on", true))), held(apps(true, true, true, false, true), autoOff(), List.of(half("ag-1", "d-work",
                "offered"))), Caller.THE_OWNER);
        assertThat(kept().entry("ag-1").desks()).containsExactly("d-work");

        // /data full, say: from here every write fails. A revoke and an app switched off still hold in this deskd at once.
        List<String> tried = new java.util.ArrayList<>();
        record.writerForTest((file, bytes) -> {
            tried.add(file.getFileName().toString());
            throw new java.io.IOException("No space left on device");
        });
        record.recordRevoke(m("agentId", "ag-1", "access", m("chosen", true, "desks", List.of())));
        record.recordSet("ag-1", m("agentId", "ag-1", "apps", m("files", false)), held(apps(true, false, true, false,
                true), autoOff(), List.of()), Caller.THE_OWNER);
        assertThat(tried).containsExactly(AccessRecord.FILE, AccessRecord.FILE);
        assertThat(record.entry("ag-1").desks()).isEmpty();
        assertThat(record.refusal("ag-1", HostedDecls.FILES)).isEqualTo("scope");

        // The older, wider file is where no restart reads it: a restart now holds nothing, and every agent waits.
        assertThat(dir.resolve(AccessRecord.FILE)).doesNotExist();
        assertThat(dir.resolve(AccessRecord.FILE + ".unsaved")).exists();
        AccessRecord restarted = kept();
        assertThat(restarted.recorded()).isEmpty();
        for (String area : List.of(HostedDecls.FILES, HostedDecls.BROWSER, HostedDecls.NOTEBOOK)) {
            assertThat(restarted.refusal("ag-1", area)).isEqualTo("setup");
        }

        // The next good write puts back the whole of what the member chose, and only that.
        record.writerForTest(AccessRecord::write);
        setUp(record, "ag-2", apps(true, false, false, false, false));
        AccessRecord again = kept();
        assertThat(again.recorded()).containsExactly("ag-1", "ag-2");
        assertThat(again.refusal("ag-1", HostedDecls.FILES)).isEqualTo("scope");
        assertThat(again.entry("ag-1").desks()).isEmpty();
    }

    @Test
    void aFolderIsKeptAsDeskAgentKeepsItSoTheTwoCopiesAgree() {
        AccessRecord record = kept();
        Map<String, Object> asked = m("notebook", null, "files", m("folder", " /Scout/notes/ "), "todos", false);
        record.recordSet("ag-1", m("agentId", "ag-1", "apps", apps(true, true, true, false, true), "auto", asked),
                held(apps(true, true, true, false, true), m("notebook", null, "files", m("folder", "Scout/notes"),
                        "todos", false), List.of()), Caller.THE_OWNER);
        assertThat(record.entry("ag-1").filesFolder()).isEqualTo("Scout/notes");
        assertThat(record.autoOn(Caller.THE_OWNER, "ag-1", "files")).isTrue();
        assertThat(AccessRecord.folderOf("///")).isEmpty();
    }

    @Test
    void anAnswerThatSaysNotSetUpOrDoesntParseLeavesNothingForTheAgent() {
        AccessRecord record = kept();
        setUp(record, "ag-1", apps(true, true, true, false, true));
        record.recordSet("ag-1", m("agentId", "ag-1", "apps", m("files", true)), m("access", m("chosen", false)),
                Caller.THE_OWNER);
        assertThat(record.entry("ag-1")).isNull();
        setUp(record, "ag-1", apps(true, true, true, false, true));
        record.recordSet("ag-1", m("agentId", "ag-1", "apps", "all"), held(apps(true, true, true, true, true),
                autoOff(), List.of()), Caller.THE_OWNER);
        assertThat(record.entry("ag-1")).isNull();
        setUp(record, "ag-1", apps(true, true, true, false, true));
        record.recordSet("ag-1", m("agentId", "ag-1"), "not an answer", Caller.THE_OWNER);
        assertThat(record.entry("ag-1")).isNull();
    }

    @Test
    void onlyTheAgentsOwnerRecordsAndTheLowRiskSeamGoesByIt() {
        AccessRecord record = kept();
        record.recordSet("gm-abcd1234", m("agentId", "gm-abcd1234", "apps", apps(true, false, false, false, false),
                "auto", autoOff()), held(apps(true, false, false, false, false), autoOff(), List.of()), MEMBER);
        assertThat(record.entry("gm-abcd1234")).isNotNull();
        // A member never records another's agent or the owner's, and the owner never a member's.
        record.recordSet("gm-wxyz0000", m("agentId", "gm-wxyz0000", "apps", apps(true, false, false, false, false),
                "auto", autoOff()), held(apps(true, false, false, false, false), autoOff(), List.of()), MEMBER);
        record.recordSet("ag-1", m("agentId", "ag-1", "apps", apps(true, true, true, false, false), "auto", autoOff()),
                held(apps(true, true, true, false, false), autoOff(), List.of()), MEMBER);
        record.recordSet("gm-wxyz0000", m("agentId", "gm-wxyz0000", "apps", apps(true, false, false, false, false),
                "auto", autoOff()), held(apps(true, false, false, false, false), autoOff(), List.of()),
                Caller.THE_OWNER);
        record.recordSet("bad id", m("apps", apps(true, true, true, false, false), "auto", autoOff()),
                held(apps(true, true, true, false, false), autoOff(), List.of()), Caller.THE_OWNER);
        assertThat(record.recorded()).containsExactly("gm-abcd1234");

        record.recordSet("ag-2", m("agentId", "ag-2", "apps", apps(true, true, true, false, true), "auto",
                m("notebook", null, "files", null, "todos", true)), held(apps(true, true, true, false, true),
                m("notebook", null, "files", null, "todos", true), List.of()), Caller.THE_OWNER);
        assertThat(record.autoOn(Caller.THE_OWNER, "ag-2", "todos")).isTrue();
        assertThat(record.autoOn(Caller.THE_OWNER, "ag-2", "files")).isFalse();
        assertThat(record.autoOn(Caller.THE_OWNER, "ag-2", "notebook")).isFalse();
        assertThat(record.autoOn(Caller.THE_OWNER, "ag-2", "courier")).isFalse();
        assertThat(record.autoOn(Caller.THE_OWNER, "ag-2", null)).isFalse();
        assertThat(record.autoOn(MEMBER, "ag-2", "todos")).isFalse();
        assertThat(record.autoOn(Caller.THE_OWNER, "gm-abcd1234", "todos")).isFalse();
        assertThat(record.autoOn(null, "ag-2", "todos")).isFalse();
        assertThat(record.autoOn(Caller.THE_OWNER, "ag-9", "todos")).isFalse();
        Map<String, Object> places = m("notebook", m("tabId", "tab-1"), "files", m("folder", "Scout"), "todos", false);
        record.recordSet("ag-3", m("agentId", "ag-3", "apps", apps(true, true, true, false, false), "auto", places),
                held(apps(true, true, true, false, false), places, List.of()), Caller.THE_OWNER);
        assertThat(record.autoOn(Caller.THE_OWNER, "ag-3", "notebook")).isTrue();
        assertThat(record.autoOn(Caller.THE_OWNER, "ag-3", "files")).isTrue();
        assertThat(record.autoOn(Caller.THE_OWNER, "ag-3", "todos")).isFalse();
    }

    @Test
    void aDeskIsHeldOnlyWhileDeskAgentHasItsHalfAndARevokeCutsIt() {
        AccessRecord record = kept();
        setUp(record, "ag-1", apps(true, true, true, false, true));
        record.recordSet("ag-1", m("agentId", "ag-1", "desks", List.of(m("deskId", "d-work", "deskName", "Work",
                "on", true), m("deskId", "d-home", "deskName", "Home", "on", true))), held(apps(true, true, true,
                false, true), autoOff(), List.of(half("ag-1", "d-work", "offered"), half("ag-1", "d-home",
                "revoked"))), Caller.THE_OWNER);
        assertThat(record.entry("ag-1").desks()).containsExactly("d-work");
        record.recordRevoke(m("agentId", "ag-1", "access", m("chosen", true, "desks", List.of())));
        assertThat(record.entry("ag-1").desks()).isEmpty();
        // A revoke's answer never adds.
        record.recordRevoke(m("agentId", "ag-1", "access", m("chosen", true, "desks", List.of(half("ag-1", "d-new",
                "active")))));
        assertThat(record.entry("ag-1").desks()).isEmpty();
    }

    @Test
    void itLastsAcrossARestartOnDeskdsOwnFilesOnly() throws Exception {
        AccessRecord record = kept();
        setUp(record, "ag-1", apps(true, false, true, false, true));
        setUp(record, "manager", apps(true, true, true, false, false));
        assertThat(Files.getPosixFilePermissions(dir.resolve(AccessRecord.FILE)))
                .isEqualTo(PosixFilePermissions.fromString("rw-------"));
        assertThat(Files.getPosixFilePermissions(dir.resolve(AccessRecord.KEY)))
                .isEqualTo(PosixFilePermissions.fromString("rw-------"));
        assertThat(Files.size(dir.resolve(AccessRecord.KEY))).isEqualTo(32);
        String text = Files.readString(dir.resolve(AccessRecord.FILE));
        assertThat(text).contains("\"mac\"");

        AccessRecord again = kept();
        assertThat(again.recorded()).containsExactly("ag-1", "manager");
        assertThat(again.entry("ag-1").apps()).containsExactlyInAnyOrder("notebook", "browser", "todos");
        assertThat(again.refusal("manager", HostedDecls.FILES)).isNull();

        again.forget("ag-1");
        assertThat(kept().recorded()).containsExactly("manager");
    }

    @Test
    void aFileEditedByHandReadsAsNothingRecordedAndIsSetAside() throws Exception {
        AccessRecord record = kept();
        setUp(record, "ag-1", apps(true, false, false, false, false));
        Path file = dir.resolve(AccessRecord.FILE);
        // Files and the Browser switched on by hand, the MAC left as it was.
        Map<String, Object> read = new LinkedHashMap<>(Json.parseObject(Files.readAllBytes(file)));
        @SuppressWarnings("unchecked")
        Map<String, Object> agents = new LinkedHashMap<>((Map<String, Object>) read.get("agents"));
        @SuppressWarnings("unchecked")
        Map<String, Object> entry = new LinkedHashMap<>((Map<String, Object>) agents.get("ag-1"));
        entry.put("apps", List.of("browser", "files", "notebook"));
        agents.put("ag-1", entry);
        read.put("agents", agents);
        Files.write(file, Json.bytes(read));

        AccessRecord after = kept();
        assertThat(after.recorded()).isEmpty();
        assertThat(after.refusal("ag-1", HostedDecls.NOTEBOOK)).isEqualTo("setup");
        assertThat(after.refusal("ag-1", HostedDecls.FILES)).isEqualTo("setup");
        assertThat(dir.resolve(AccessRecord.FILE + ".bad")).exists();
        assertThat(file).doesNotExist();
        // The member's next save writes a good one again.
        setUp(after, "ag-1", apps(true, false, false, false, false));
        assertThat(kept().recorded()).containsExactly("ag-1");
    }

    @Test
    void anotherKeyNoKeyATornFileALinkOrAnExtraFieldAllReadAsNothing() throws Exception {
        Path file = dir.resolve(AccessRecord.FILE);
        Path key = dir.resolve(AccessRecord.KEY);

        setUp(kept(), "ag-1", apps(true, true, true, false, true));
        Files.write(key, new byte[32]);
        assertThat(kept().recorded()).as("another key").isEmpty();

        setUp(kept(), "ag-1", apps(true, true, true, false, true));
        Files.delete(key);
        assertThat(kept().recorded()).as("no key").isEmpty();

        setUp(kept(), "ag-1", apps(true, true, true, false, true));
        byte[] whole = Files.readAllBytes(file);
        Files.write(file, java.util.Arrays.copyOf(whole, whole.length / 2));
        assertThat(kept().recorded()).as("torn").isEmpty();

        setUp(kept(), "ag-1", apps(true, true, true, false, true));
        Map<String, Object> read = new LinkedHashMap<>(Json.parseObject(Files.readAllBytes(file)));
        read.put("extra", true);
        Files.write(file, Json.bytes(read));
        assertThat(kept().recorded()).as("an extra field").isEmpty();

        setUp(kept(), "ag-1", apps(true, true, true, false, true));
        Path elsewhere = dir.resolve("elsewhere.json");
        Files.move(file, elsewhere);
        Files.createSymbolicLink(file, elsewhere);
        assertThat(kept().recorded()).as("a link").isEmpty();
        assertThat(Files.readString(elsewhere, StandardCharsets.UTF_8)).as("never followed or changed").contains("ag-1");
    }

    @Test
    void beforeItsDirectoryIsKnownItRecordsInMemoryOnly() {
        AccessRecord record = new AccessRecord(CLOCK);
        setUp(record, "ag-1", apps(true, true, true, false, true));
        assertThat(record.refusal("ag-1", HostedDecls.FILES)).isNull();
        assertThat(dir.resolve(AccessRecord.FILE)).doesNotExist();
    }
}
