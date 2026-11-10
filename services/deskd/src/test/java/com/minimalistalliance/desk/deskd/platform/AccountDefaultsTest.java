package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** The last {@code agentDefaults} read, kept in {@code /data/desk/account-defaults.json} for a boot whose read fails. */
@ExtendWith(OutputCaptureExtension.class)
class AccountDefaultsTest {

    private static final Map<String, Object> CAPS = caps();

    private static Map<String, Object> caps() {
        Map<String, Object> caps = new LinkedHashMap<>();
        caps.put("deskDay", Map.of("maxMicroUsd", 2));
        caps.put("deskMonth", Map.of("maxMicroUsd", 9));
        caps.put("timeZone", "America/Denver");
        caps.put("tier", null);
        return caps;
    }

    @TempDir
    Path dir;

    private Path file() {
        return dir.resolve(AccountDefaults.FILE);
    }

    private static Map<String, Object> none() {
        Map<String, Object> none = new LinkedHashMap<>();
        none.put("deskDay", null);
        none.put("deskMonth", null);
        none.put("timeZone", null);
        none.put("tier", null);
        return none;
    }

    /** Task 49: the tier's settings for agents ride along to desk-agent, and are kept like the rest. */
    @Test
    void theTiersAgentSettingsPassThroughAndAreKept() {
        AccountDefaults defaults = new AccountDefaults();
        defaults.keepIn(file());
        Map<String, Object> tier = Map.of("agentCap", 8, "workspaceMb", 50, "a2aDepth", 2);
        Map<String, Object> config = new LinkedHashMap<>(CAPS);
        config.put("tier", tier);
        defaults.apply(config);
        assertThat(defaults.current()).containsEntry("tier", tier);

        AccountDefaults restarted = new AccountDefaults();
        restarted.keepIn(file());
        assertThat(restarted.current()).containsEntry("tier", tier);
    }

    /** Task 49 (Security T49K-1): a config without a tier keeps the last, never an absent one. */
    @Test
    void aConfigWithoutATierKeepsTheLastTier() {
        AccountDefaults defaults = new AccountDefaults();
        defaults.keepIn(file());
        Map<String, Object> tier = Map.of("agentCap", 8, "workspaceMb", 50);
        Map<String, Object> config = new LinkedHashMap<>(CAPS);
        config.put("tier", tier);
        defaults.apply(config);

        Map<String, Object> noTier = new LinkedHashMap<>(CAPS);
        noTier.remove("tier");
        defaults.apply(noTier);
        assertThat(defaults.current()).containsEntry("tier", tier);
        defaults.apply(CAPS); // tier: null
        assertThat(defaults.current()).containsEntry("tier", tier);

        AccountDefaults restarted = new AccountDefaults();
        restarted.keepIn(file());
        assertThat(restarted.current()).containsEntry("tier", tier);
    }

    @Test
    void aBootWithNoFieldKeepsTheLastValuesThatWereRead() {
        AccountDefaults first = new AccountDefaults();
        first.keepIn(file());
        first.apply(CAPS);
        assertThat(file()).exists();
        assertThat(dir.resolve(AccountDefaults.FILE + ".tmp")).doesNotExist();

        AccountDefaults second = new AccountDefaults();
        second.keepIn(file());
        assertThat(second.current()).as("loaded at startup").isEqualTo(CAPS);
        List<Object> changes = new ArrayList<>();
        second.onChange(() -> changes.add(second.current()));
        second.apply(null);
        assertThat(second.current()).as("the read failed, so they stand").isEqualTo(CAPS);
        assertThat(changes).isEmpty();
    }

    @Test
    void aFreshValueReplacesThemNullsIncluded() throws Exception {
        AccountDefaults defaults = new AccountDefaults();
        defaults.keepIn(file());
        defaults.apply(CAPS);
        defaults.apply(Map.of("timeZone", "Pacific/Auckland"));
        Map<String, Object> expected = none();
        expected.put("timeZone", "Pacific/Auckland");
        assertThat(defaults.current()).isEqualTo(expected);

        defaults.apply(Map.of());
        assertThat(defaults.current()).isEqualTo(none());

        AccountDefaults restarted = new AccountDefaults();
        restarted.keepIn(file());
        assertThat(restarted.current()).as("what was kept is the latest").isEqualTo(none());
    }

    @Test
    void withNothingKeptAnAbsentFieldIsNoAccountValues() {
        AccountDefaults defaults = new AccountDefaults();
        defaults.keepIn(file());
        defaults.apply(null);
        assertThat(defaults.current()).isEqualTo(none());
        assertThat(file()).as("nothing was read, so nothing is kept").doesNotExist();
    }

    @Test
    void aCorruptFileIsIgnoredWithOneLogLine(CapturedOutput output) throws Exception {
        Files.writeString(file(), "{not json", StandardCharsets.UTF_8);
        AccountDefaults defaults = new AccountDefaults();
        defaults.keepIn(file());
        assertThat(defaults.current()).isNull();
        assertThat(output.getAll().lines().filter(line -> line.contains("account defaults")).count()).isEqualTo(1);

        defaults.apply(CAPS);
        assertThat(defaults.current()).isEqualTo(CAPS);
        AccountDefaults again = new AccountDefaults();
        again.keepIn(file());
        assertThat(again.current()).as("the fresh value replaced the bad file").isEqualTo(CAPS);
    }
}
