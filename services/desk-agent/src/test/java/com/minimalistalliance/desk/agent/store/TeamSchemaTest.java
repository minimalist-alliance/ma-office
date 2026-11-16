package com.minimalistalliance.desk.agent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.testing.MutableClock;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Task 49's additions to {@code agent.db} are additive: {@code user_version} stays 1, so a desk-agent from before still
 * opens the file (README, "Keys": a rollback must never fail to open it).
 */
class TeamSchemaTest {

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-06T10:00:00Z"));

    private void open() throws SQLException {
        try (AgentStore store = new AgentStore(dir.resolve("agent.db"), clock)) {
            store.open();
        }
    }

    private <T> T sql(Work<T> work) throws SQLException {
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("agent.db"))) {
            return work.run(connection);
        }
    }

    private interface Work<T> {
        T run(Connection connection) throws SQLException;
    }

    private int userVersion() throws SQLException {
        return sql(c -> {
            try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("PRAGMA user_version")) {
                return r.getInt(1);
            }
        });
    }

    private List<String> names(String query) throws SQLException {
        return sql(c -> {
            List<String> out = new ArrayList<>();
            try (Statement s = c.createStatement(); ResultSet r = s.executeQuery(query)) {
                while (r.next()) {
                    out.add(r.getString(1));
                }
            }
            return out;
        });
    }

    private String lead() throws SQLException {
        return names("SELECT name FROM agents WHERE id = 'manager'").getFirst();
    }

    private void exec(String... statements) throws SQLException {
        sql(c -> {
            try (Statement s = c.createStatement()) {
                for (String statement : statements) {
                    s.execute(statement);
                }
            }
            return null;
        });
    }

    @Test
    void theVersionStaysOneAndTheNewTablesAreThere() throws Exception {
        open();

        assertThat(userVersion()).isEqualTo(1);
        assertThat(names("SELECT name FROM sqlite_master WHERE type = 'table'"))
                .contains("agents", "messages", "keys", "settings", "links", "proposals", "a2a", "timers", "memories",
                        "thread_summaries");
        assertThat(names("SELECT name FROM pragma_table_info('agents')"))
                .contains("purpose", "icon", "tone", "png_version", "solo", "workspace_mb", "shared_with", "color");
        assertThat(names("SELECT name FROM pragma_table_info('messages')")).contains("origin", "tools");
        assertThat(names("SELECT name FROM pragma_table_info('proposals')")).contains("run_id", "origin",
                "before_json");
    }

    @Test
    void openingAgainChangesNothing() throws Exception {
        open();
        exec("UPDATE agents SET purpose = 'kept', icon = 'leaf' WHERE id = 'manager'");
        List<String> tables = names("SELECT name FROM sqlite_master ORDER BY name");
        List<String> columns = names("SELECT name FROM pragma_table_info('agents')");

        open();
        open();

        assertThat(userVersion()).isEqualTo(1);
        assertThat(names("SELECT name FROM sqlite_master ORDER BY name")).isEqualTo(tables);
        assertThat(names("SELECT name FROM pragma_table_info('agents')")).isEqualTo(columns);
        assertThat(names("SELECT purpose || icon FROM agents WHERE id = 'manager'")).containsExactly("keptleaf");
    }

    /** The tables as the first desk-agent made them, with a manager still named Manager and a message in its thread. */
    private void aFileFromBefore() throws SQLException {
        exec("""
                CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                  role TEXT NOT NULL CHECK (role IN ('manager', 'staff')), created_at INTEGER NOT NULL, key_id TEXT,
                  provider TEXT, model TEXT, badge_hidden INTEGER NOT NULL DEFAULT 0,
                  badge_notice INTEGER NOT NULL DEFAULT 0, unseen INTEGER NOT NULL DEFAULT 0, limits TEXT) STRICT""",
                """
                CREATE TABLE messages (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents (id),
                  ord INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), text TEXT NOT NULL,
                  at_ms INTEGER NOT NULL, run_id TEXT, badge TEXT, usage TEXT, cost_microusd INTEGER, stop_reason TEXT,
                  state TEXT, error TEXT, error_detail TEXT) STRICT""",
                "CREATE INDEX messages_agent ON messages (agent_id, ord)",
                """
                CREATE TABLE keys (key_id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL,
                  last4 TEXT NOT NULL, created_at INTEGER NOT NULL, created_by_desk TEXT NOT NULL) STRICT""",
                "CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
                "INSERT INTO agents (id, name, role, created_at, unseen) VALUES ('manager', 'Manager', 'manager', 5, 2)",
                "INSERT INTO messages (id, agent_id, ord, role, text, at_ms) VALUES ('m1', 'manager', 1, 'user', 'Hi', 6)",
                "PRAGMA user_version = 1");
    }

    @Test
    void aFileFromBeforeGainsTheColumnsKeepsItsRowsAndTakesTheDefaults() throws Exception {
        aFileFromBefore();

        open();

        assertThat(userVersion()).isEqualTo(1);
        assertThat(names("SELECT text FROM messages")).containsExactly("Hi");
        assertThat(names("SELECT purpose || '|' || icon || '|' || tone || '|' || solo || '|' || shared_with || '|'"
                + " || color FROM agents")).as("the column's default is still nodes; it's retired to the hat at once")
                .containsExactly("|hat|graphite|1|[]|indigo");
        assertThat(names("SELECT unseen FROM agents")).containsExactly("2");
    }

    /** What an older desk-agent still does to the file: it names its columns, so the new ones take their defaults. */
    @Test
    void anOlderDeskAgentsWritesStillWorkOnTheUpgradedFile() throws Exception {
        aFileFromBefore();
        open();

        exec("INSERT INTO agents (id, name, role, created_at) VALUES ('old', 'Old', 'staff', 9)",
                "INSERT INTO messages (id, agent_id, ord, role, text, at_ms, state) VALUES"
                        + " ('m2', 'old', 1, 'assistant', 'Yes', 10, 'done')",
                "UPDATE agents SET name = 'Older', unseen = 1, limits = '{}' WHERE id = 'old'");

        assertThat(names("SELECT name FROM agents WHERE id = 'old'")).containsExactly("Older");
        assertThat(names("SELECT solo FROM agents WHERE id = 'old'")).containsExactly("1");
        open();
        assertThat(names("SELECT id FROM agents ORDER BY id")).containsExactly("manager", "old");
    }

    @Test
    void aNewDesksLeadIsNamedLead() throws Exception {
        open();

        assertThat(lead()).isEqualTo("Lead");
    }

    @Test
    void aManagerStillNamedManagerIsRenamedLeadOnce() throws Exception {
        aFileFromBefore();

        open();
        assertThat(lead()).isEqualTo("Lead");

        exec("UPDATE agents SET name = 'Manager' WHERE id = 'manager'");
        open();
        assertThat(lead()).as("the member chose Manager again: it stays").isEqualTo("Manager");
        open();
        assertThat(lead()).isEqualTo("Manager");
    }

    @Test
    void aMemberWhoNamedTheirManagerSomethingElseKeepsThatName() throws Exception {
        aFileFromBefore();
        exec("UPDATE agents SET name = 'Max' WHERE id = 'manager'");

        open();

        assertThat(lead()).isEqualTo("Max");
    }

    @Test
    void retiredIconsAndTonesBecomeTheOnesThatTookTheirPlaceAtOpen() throws Exception {
        open();
        exec("INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('a', 'A', 'staff', 1, 'globe', 'moss')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('b', 'B', 'staff', 2, 'chat', 'sky')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('c', 'C', 'staff', 3, 'heart', 'teal')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('d', 'D', 'staff', 4, 'star', 'rose')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('e', 'E', 'staff', 5, 'puzzle', 'plum')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('f', 'F', 'staff', 6, 'briefcase',"
                        + " 'graphite')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('g', 'G', 'staff', 7, 'png', 'clay')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('h', 'H', 'staff', 8, 'spark', 'blue')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('i', 'I', 'staff', 9, 'pen', 'amber')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('j', 'J', 'staff', 10, 'pen', 'cyan')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('k', 'K', 'staff', 11, 'pen', 'violet')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('l', 'L', 'staff', 12, 'pen', 'olive')",
                "INSERT INTO agents (id, name, role, created_at, icon, tone) VALUES ('m', 'M', 'staff', 13, 'pen', 'green')");

        open();
        open();

        assertThat(names("SELECT id || ':' || icon || ':' || tone FROM agents WHERE role = 'staff' ORDER BY id"))
                .as("the warm and green tones went on Nov 14: each is the nearest of the seven")
                .containsExactly("a:plane:harbor", "b:person:blue", "c:wallet:harbor", "d:bulb:iris", "e:terminal:iris",
                        "f:document:graphite", "g:png:navy", "h:hat:blue", "i:pen:steel", "j:pen:steel", "k:pen:iris",
                        "l:pen:harbor", "m:pen:harbor");
        assertThat(names("SELECT icon || ':' || tone FROM agents WHERE id = 'manager'"))
                .containsExactly("hat:graphite");
    }

    /**
     * Colours (the owner, Nov 15): at open the lead takes the Agent app's own and each staff agent with none, oldest
     * first, the next free one against those already stored, so the owner's two helpers become sage then amber. A guild
     * member's own agent and Desk Maia get none. Opening again changes nothing; a row a rolled-back desk-agent adds
     * gets one next.
     */
    @Test
    void eachAgentWithNoColourTakesTheNextFreeOneOldestFirstOnce() throws Exception {
        aFileFromBefore();
        exec("INSERT INTO agents (id, name, role, created_at) VALUES ('ag-second', 'Second', 'staff', 20)",
                "INSERT INTO agents (id, name, role, created_at) VALUES ('ag-first', 'First', 'staff', 10)",
                "INSERT INTO agents (id, name, role, created_at) VALUES ('gm-member01', 'Theirs', 'manager', 5)",
                "INSERT INTO agents (id, name, role, created_at) VALUES ('maia', 'Maia', 'staff', 1)");

        open();

        String colors = "SELECT id || ':' || COALESCE(color, '-') FROM agents ORDER BY created_at, id";
        assertThat(names(colors)).containsExactly("maia:-", "gm-member01:-", "manager:indigo", "ag-first:sage",
                "ag-second:amber");

        open();
        assertThat(names(colors)).as("opening again changes nothing").containsExactly("maia:-", "gm-member01:-",
                "manager:indigo", "ag-first:sage", "ag-second:amber");

        exec("UPDATE agents SET color = 'amber' WHERE id = 'ag-first'",
                "INSERT INTO agents (id, name, role, created_at) VALUES ('ag-old', 'Old', 'staff', 30)",
                "INSERT INTO agents (id, name, role, created_at) VALUES ('ag-older', 'Older', 'staff', 25)");
        open();
        assertThat(names("SELECT id || ':' || color FROM agents WHERE role = 'staff' AND id <> 'maia'"
                + " ORDER BY created_at")).as("the first free ones against what's stored, oldest first")
                .containsExactly("ag-first:amber", "ag-second:amber", "ag-older:sage", "ag-old:rose");
    }
}
