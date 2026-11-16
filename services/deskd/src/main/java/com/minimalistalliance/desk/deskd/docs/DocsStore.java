package com.minimalistalliance.desk.deskd.docs;

import com.minimalistalliance.desk.deskd.sqlite.SqliteDatabase;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * Documents' store, {@code /data/desk/docs.db} (deskd {@code API.md} §25): documents, their copies and versions, each
 * version's text from the sandbox, the reader's summaries, the member's rules, questions, links and undo tokens, and a
 * full-text index. WAL, {@code synchronous=FULL}, 0600, through deskd's {@link SqliteDatabase}: one writer thread, two
 * readers. Every change bumps one desk-wide {@code rev} and is heard by {@link #onChange} (ids only).
 */
final class DocsStore implements AutoCloseable {

    static final String FILE = "docs.db";
    static final int BODY_CHARS = 100_000;

    private final SqliteDatabase db;
    private final List<Consumer<List<String>>> listeners = new CopyOnWriteArrayList<>();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();

    private DocsStore(SqliteDatabase db) {
        this.db = db;
    }

    static DocsStore open(Path file) throws SQLException {
        DocsStore store = new DocsStore(SqliteDatabase.open("docs", file, List.of(DocsStore::schemaV1), new SqliteDatabase.Options(2, 2048, 1024)));
        try {
            store.db.transaction(c -> {
                added(c);
                return null;
            });
        } catch (SQLException | RuntimeException e) {
            store.close();
            throw e;
        }
        return store;
    }

    /**
     * Added without a schema bump, created if missing at every open, so a rollback still opens the file (an older deskd
     * names its columns and never these): Courier's contact and channel ids, the agent's id, and the reader's refusal.
     */
    private static void added(Connection c) throws SQLException {
        Set<String> have = new HashSet<>(Sql.list(c, "SELECT name FROM pragma_table_info('docs')", r -> r.getString(1)));
        try (Statement s = c.createStatement()) {
            for (String col : List.of("contact_id TEXT", "channel_id TEXT", "agent_id TEXT", "no_reader INTEGER NOT NULL DEFAULT 0")) {
                if (!have.contains(col.substring(0, col.indexOf(' ')))) {
                    s.execute("ALTER TABLE docs ADD COLUMN " + col);
                }
            }
        }
    }

    SqliteDatabase db() {
        return db;
    }

    @Override
    public void close() {
        db.close();
    }

    void onChange(Consumer<List<String>> listener) {
        listeners.add(listener);
    }

    void changed(List<String> ids) {
        if (ids.isEmpty()) {
            return;
        }
        for (Consumer<List<String>> l : listeners) {
            try {
                l.accept(ids);
            } catch (RuntimeException e) {
                // A listener's trouble is its own.
            }
        }
    }

    /** A ULID-shaped id: {@code prefix} then 26 Crockford base32 characters, time first. */
    static String newId(String prefix, long now) {
        char[] out = new char[26];
        long t = now;
        for (int i = 9; i >= 0; i--) {
            out[i] = B32[(int) (t & 31)];
            t >>>= 5;
        }
        for (int i = 10; i < 26; i++) {
            out[i] = B32[RANDOM.nextInt(32)];
        }
        return prefix + new String(out);
    }

    static boolean validId(String id, String prefix) {
        return id != null && id.length() == prefix.length() + 26 && id.startsWith(prefix)
                && id.substring(prefix.length()).chars().allMatch(c -> new String(B32).indexOf(c) >= 0);
    }

    private static void schemaV1(Connection c) throws SQLException {
        try (Statement s = c.createStatement()) {
            s.execute("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
            s.execute("""
                    CREATE TABLE docs (
                      id TEXT PRIMARY KEY, rev INTEGER NOT NULL,
                      kind TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, orig_name TEXT NOT NULL, what TEXT,
                      size INTEGER NOT NULL, sha256 TEXT NOT NULL, simhash INTEGER,
                      arrived_at INTEGER NOT NULL, changed_at INTEGER NOT NULL, changed_by TEXT NOT NULL, changed_by_name TEXT,
                      place TEXT NOT NULL CHECK (place IN ('needs', 'read', 'records', 'working')), maybe INTEGER NOT NULL,
                      reason TEXT NOT NULL, reason_arg TEXT, basis INTEGER NOT NULL, due_at INTEGER,
                      danger TEXT, untrusted INTEGER NOT NULL, sensitive INTEGER NOT NULL,
                      state TEXT NOT NULL CHECK (state IN ('new', 'seen', 'handled')), held_until INTEGER,
                      last_seen_at INTEGER, last_seen_sha TEXT, last_page INTEGER, seen_ms INTEGER NOT NULL,
                      from_key TEXT, from_name TEXT, from_domain TEXT, thread_ref TEXT, lane TEXT, bulk INTEGER NOT NULL,
                      sender_known INTEGER NOT NULL, page_count INTEGER, sign_empty INTEGER NOT NULL, form_empty INTEGER NOT NULL,
                      parse_state TEXT NOT NULL, renamed INTEGER NOT NULL, gone INTEGER NOT NULL, agent_name TEXT,
                      source_kind TEXT, source_label TEXT)""");
            s.execute("CREATE INDEX docs_place ON docs(gone, place, maybe, changed_at)");
            s.execute("CREATE INDEX docs_sha ON docs(sha256)");
            s.execute("CREATE INDEX docs_from ON docs(from_key)");
            s.execute("CREATE INDEX docs_rev ON docs(rev)");
            s.execute("""
                    CREATE TABLE copies (
                      id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
                      source_kind TEXT NOT NULL, source_ref TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
                      arrived_at INTEGER NOT NULL, size INTEGER, mtime INTEGER, sha256 TEXT, gone INTEGER NOT NULL)""");
            s.execute("CREATE INDEX copies_doc ON copies(doc_id)");
            s.execute("""
                    CREATE TABLE versions (
                      id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
                      sha256 TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, by_name TEXT, milestone TEXT,
                      milestone_arg TEXT, pages_changed TEXT, kept INTEGER NOT NULL, size INTEGER)""");
            s.execute("CREATE INDEX versions_doc ON versions(doc_id, at)");
            s.execute("CREATE TABLE texts (sha256 TEXT PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL)");
            s.execute("CREATE TABLE summaries (sha256 TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL)");
            s.execute("""
                    CREATE TABLE rules (
                      id TEXT PRIMARY KEY, person TEXT, person_name TEXT, domain TEXT, kind TEXT, source TEXT,
                      effect TEXT NOT NULL, made_by TEXT NOT NULL, at INTEGER NOT NULL)""");
            s.execute("""
                    CREATE TABLE questions (
                      id TEXT PRIMARY KEY, kind TEXT NOT NULL, doc_ids TEXT NOT NULL, key TEXT NOT NULL UNIQUE,
                      args TEXT, at INTEGER NOT NULL, answered TEXT)""");
            s.execute("""
                    CREATE TABLE links (
                      doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, kind TEXT NOT NULL, ref TEXT NOT NULL,
                      label TEXT, basis TEXT NOT NULL, PRIMARY KEY (doc_id, kind, ref))""");
            s.execute("CREATE TABLE undo (token TEXT PRIMARY KEY, json TEXT NOT NULL, expires_at INTEGER NOT NULL)");
            s.execute("CREATE TABLE seen (doc_id TEXT NOT NULL, at INTEGER NOT NULL, ms INTEGER NOT NULL, page INTEGER)");
            s.execute("CREATE INDEX seen_doc ON seen(doc_id, at)");
            s.execute("CREATE TABLE welcome (kind TEXT PRIMARY KEY, effect TEXT NOT NULL, at INTEGER NOT NULL)");
            s.execute("CREATE TABLE let_through (person TEXT PRIMARY KEY, at INTEGER NOT NULL)");
            s.execute("CREATE TABLE reads (day TEXT PRIMARY KEY, n INTEGER NOT NULL)");
            s.execute("CREATE VIRTUAL TABLE fts USING fts5(doc_id UNINDEXED, title, name, body, tokenize = 'unicode61 remove_diacritics 2')");
        }
    }

    // ---------------------------------------------------------------- rev

    static long nextRev(Connection c) throws SQLException {
        Long rev = Sql.longOne(c, "SELECT CAST(v AS INTEGER) FROM meta WHERE k = 'rev'");
        long next = (rev == null ? 0 : rev) + 1;
        Sql.update(c, "INSERT INTO meta(k, v) VALUES ('rev', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", Long.toString(next));
        return next;
    }

    long rev() throws SQLException {
        Long r = db.read(c -> Sql.longOne(c, "SELECT CAST(v AS INTEGER) FROM meta WHERE k = 'rev'"));
        return r == null ? 0 : r;
    }

    String meta(String key) throws SQLException {
        return db.read(c -> Sql.stringOne(c, "SELECT v FROM meta WHERE k = ?", key));
    }

    void meta(String key, String value) throws SQLException {
        db.transaction(c -> Sql.update(c, value == null ? "DELETE FROM meta WHERE k = ?" : "INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                value == null ? new Object[] {key} : new Object[] {key, value}));
    }

    // ---------------------------------------------------------------- docs

    static void insert(Connection c, Doc d) throws SQLException {
        d.rev = nextRev(c);
        Object[] v = d.values();
        StringBuilder marks = new StringBuilder();
        for (int i = 0; i < v.length; i++) {
            marks.append(i == 0 ? "?" : ", ?");
        }
        Sql.update(c, "INSERT INTO docs (" + Doc.COLUMNS + ") VALUES (" + marks + ")", v);
    }

    static void save(Connection c, Doc d) throws SQLException {
        d.rev = nextRev(c);
        String[] cols = Doc.COLUMNS.split(",\\s*");
        Object[] v = d.values();
        StringBuilder set = new StringBuilder();
        for (int i = 1; i < cols.length; i++) {
            set.append(i == 1 ? "" : ", ").append(cols[i]).append(" = ?");
        }
        Object[] args = new Object[v.length];
        System.arraycopy(v, 1, args, 0, v.length - 1);
        args[v.length - 1] = d.id;
        Sql.update(c, "UPDATE docs SET " + set + " WHERE id = ?", args);
    }

    static Doc doc(Connection c, String id) throws SQLException {
        return Sql.one(c, "SELECT * FROM docs WHERE id = ?", Doc::of, id);
    }

    Doc doc(String id) throws SQLException {
        return db.read(c -> doc(c, id));
    }

    static Doc bySha(Connection c, String sha) throws SQLException {
        return Sql.one(c, "SELECT * FROM docs WHERE sha256 = ? AND gone = 0 ORDER BY arrived_at LIMIT 1", Doc::of, sha);
    }

    static List<Doc> all(Connection c, String where, Object... args) throws SQLException {
        return Sql.list(c, "SELECT * FROM docs WHERE " + where, Doc::of, args);
    }

    // ---------------------------------------------------------------- copies

    record Copy(String id, String docId, String sourceKind, String sourceRef, String label, long arrivedAt, Long size, Long mtime,
            String sha256, boolean gone) {}

    static Copy copyOf(java.sql.ResultSet r) throws SQLException {
        return new Copy(r.getString("id"), r.getString("doc_id"), r.getString("source_kind"), r.getString("source_ref"),
                r.getString("label"), r.getLong("arrived_at"), Sql.nullableLong(r, "size"), Sql.nullableLong(r, "mtime"),
                r.getString("sha256"), r.getInt("gone") == 1);
    }

    static Copy copyByRef(Connection c, String ref) throws SQLException {
        return Sql.one(c, "SELECT * FROM copies WHERE source_ref = ?", DocsStore::copyOf, ref);
    }

    static List<Copy> copies(Connection c, String docId) throws SQLException {
        return Sql.list(c, "SELECT * FROM copies WHERE doc_id = ? ORDER BY gone, arrived_at DESC", DocsStore::copyOf, docId);
    }

    List<Copy> copies(String docId) throws SQLException {
        return db.read(c -> copies(c, docId));
    }

    static void putCopy(Connection c, Copy k) throws SQLException {
        Sql.update(c, """
                INSERT INTO copies (id, doc_id, source_kind, source_ref, label, arrived_at, size, mtime, sha256, gone)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_ref) DO UPDATE SET doc_id = excluded.doc_id, label = excluded.label, size = excluded.size,
                  mtime = excluded.mtime, sha256 = excluded.sha256, gone = excluded.gone""",
                k.id(), k.docId(), k.sourceKind(), k.sourceRef(), k.label(), k.arrivedAt(), k.size(), k.mtime(), k.sha256(), k.gone());
    }

    // ---------------------------------------------------------------- versions

    record Version(String id, String docId, String sha256, long at, String by, String byName, String milestone,
            String milestoneArg, String pagesChanged, boolean kept, Long size) {}

    static Version versionOf(java.sql.ResultSet r) throws SQLException {
        return new Version(r.getString("id"), r.getString("doc_id"), r.getString("sha256"), r.getLong("at"), r.getString("by"),
                r.getString("by_name"), r.getString("milestone"), r.getString("milestone_arg"), r.getString("pages_changed"),
                r.getInt("kept") == 1, Sql.nullableLong(r, "size"));
    }

    static List<Version> versions(Connection c, String docId) throws SQLException {
        return Sql.list(c, "SELECT * FROM versions WHERE doc_id = ? ORDER BY at DESC, rowid DESC", DocsStore::versionOf, docId);
    }

    List<Version> versions(String docId) throws SQLException {
        return db.read(c -> versions(c, docId));
    }

    static void putVersion(Connection c, Version v) throws SQLException {
        Sql.update(c, """
                INSERT INTO versions (id, doc_id, sha256, at, by, by_name, milestone, milestone_arg, pages_changed, kept, size)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", v.id(), v.docId(), v.sha256(), v.at(), v.by(), v.byName(), v.milestone(),
                v.milestoneArg(), v.pagesChanged(), v.kept(), v.size());
    }

    // ---------------------------------------------------------------- texts and summaries

    static void putText(Connection c, String sha, DocText text, long now) throws SQLException {
        Sql.update(c, "INSERT OR REPLACE INTO texts (sha256, kind, json, at) VALUES (?, ?, ?, ?)", sha, text.kind(),
                DocsSandbox.Answers.write(text.wire(true)), now);
    }

    static DocText text(Connection c, String sha) throws SQLException {
        String json = Sql.stringOne(c, "SELECT json FROM texts WHERE sha256 = ?", sha);
        if (json == null) {
            return null;
        }
        try {
            return DocText.from(DocsSandbox.Answers.object(json));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    DocText text(String sha) throws SQLException {
        return db.read(c -> text(c, sha));
    }

    static void putFts(Connection c, String docId, String title, String name, String body) throws SQLException {
        Sql.update(c, "DELETE FROM fts WHERE doc_id = ?", docId);
        Sql.update(c, "INSERT INTO fts (doc_id, title, name, body) VALUES (?, ?, ?, ?)", docId, title, name,
                body == null ? "" : body.length() > BODY_CHARS ? body.substring(0, BODY_CHARS) : body);
    }

    static Map<String, Object> summary(Connection c, String sha) throws SQLException {
        String json = Sql.stringOne(c, "SELECT json FROM summaries WHERE sha256 = ?", sha);
        try {
            return json == null ? null : DocsSandbox.Answers.object(json);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- rules, welcome rules, let-through

    static List<Places.Rule> rules(Connection c) throws SQLException {
        return Sql.list(c, "SELECT * FROM rules ORDER BY at", r -> new Places.Rule(r.getString("id"), r.getString("person"),
                r.getString("domain"), r.getString("kind"), r.getString("source"), r.getString("effect"), r.getString("made_by")));
    }

    static List<Places.Rule> welcome(Connection c) throws SQLException {
        List<Places.Rule> out = new ArrayList<>();
        for (String[] w : Sql.list(c, "SELECT kind, effect FROM welcome", r -> new String[] {r.getString(1), r.getString(2)})) {
            if (w[0].equals("bills")) {
                for (String k : List.of("invoice", "contract", "form")) {
                    out.add(new Places.Rule("welcome:" + k, null, null, k, null, w[1], "welcome"));
                }
            }
        }
        return out;
    }

    static boolean letThrough(Connection c, String personKey) throws SQLException {
        return personKey != null && Sql.longOne(c, "SELECT 1 FROM let_through WHERE person = ?", personKey) != null;
    }

    /**
     * One person's key under the member's shared secret ({@code docs.key.set}): their rules, let-through row, questions and
     * documents follow it, so a tap made before the desks agreed still holds. Both are {@code pk_} and 16 hex characters.
     */
    static void rekey(Connection c, String old, String now) throws SQLException {
        if (old == null || now == null || old.equals(now) || !old.matches("pk_[0-9a-f]{16}") || !now.matches("pk_[0-9a-f]{16}")) {
            return;
        }
        Sql.update(c, "UPDATE rules SET person = ? WHERE person = ?", now, old);
        Sql.update(c, "UPDATE OR IGNORE let_through SET person = ? WHERE person = ?", now, old);
        Sql.update(c, "DELETE FROM let_through WHERE person = ?", old);
        Sql.update(c, "UPDATE OR IGNORE questions SET key = replace(key, ?, ?), args = replace(args, ?, ?) WHERE instr(key, ?) > 0",
                old, now, old, now, old);
        Sql.update(c, "DELETE FROM questions WHERE instr(key, ?) > 0", old);
        Sql.update(c, "UPDATE OR IGNORE links SET ref = ? WHERE kind = 'person' AND ref = ?", now, old);
        Sql.update(c, "DELETE FROM links WHERE kind = 'person' AND ref = ?", old);
        for (Doc d : all(c, "from_key = ?", old)) {
            d.fromKey = now;
            save(c, d);
        }
    }

    // ---------------------------------------------------------------- undo tokens

    static String putUndo(Connection c, Map<String, Object> state, long now) throws SQLException {
        String token = newId("u_", now);
        Sql.update(c, "DELETE FROM undo WHERE expires_at < ?", now);
        Sql.update(c, "INSERT INTO undo (token, json, expires_at) VALUES (?, ?, ?)", token, DocsSandbox.Answers.write(state), now + 600_000L);
        return token;
    }

    static Map<String, Object> takeUndo(Connection c, String token, long now) throws SQLException {
        String json = Sql.stringOne(c, "SELECT json FROM undo WHERE token = ? AND expires_at >= ?", token, now);
        Sql.update(c, "DELETE FROM undo WHERE token = ?", token);
        return json == null ? null : DocsSandbox.Answers.object(json);
    }

    // ---------------------------------------------------------------- questions

    record Question(String id, String kind, List<String> docIds, String key, Map<String, Object> args, long at, String answered) {}

    static Question questionOf(java.sql.ResultSet r) throws SQLException {
        String args = r.getString("args");
        return new Question(r.getString("id"), r.getString("kind"), List.of(r.getString("doc_ids").split(",")), r.getString("key"),
                args == null ? Map.of() : DocsSandbox.Answers.object(args), r.getLong("at"), r.getString("answered"));
    }

    /** Asks once: a question with the same key is never asked again, answered or not. */
    static boolean ask(Connection c, String kind, List<String> docIds, String key, Map<String, Object> args, long now) throws SQLException {
        if (Sql.longOne(c, "SELECT 1 FROM questions WHERE key = ?", key) != null) {
            return false;
        }
        Sql.update(c, "INSERT INTO questions (id, kind, doc_ids, key, args, at) VALUES (?, ?, ?, ?, ?, ?)", newId("q_", now), kind,
                String.join(",", docIds), key, args == null ? null : DocsSandbox.Answers.write(args), now);
        return true;
    }

    static List<Question> openQuestions(Connection c) throws SQLException {
        return Sql.list(c, "SELECT * FROM questions WHERE answered IS NULL ORDER BY at LIMIT 20", DocsStore::questionOf);
    }

    // ---------------------------------------------------------------- links

    static void link(Connection c, String docId, String kind, String ref, String label, String basis) throws SQLException {
        Sql.update(c, "INSERT OR REPLACE INTO links (doc_id, kind, ref, label, basis) VALUES (?, ?, ?, ?, ?)", docId, kind, ref, label, basis);
    }

    static List<Map<String, Object>> links(Connection c, String docId) throws SQLException {
        return Sql.list(c, "SELECT kind, ref, label FROM links WHERE doc_id = ? ORDER BY kind, ref", r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("kind", r.getString(1));
            m.put("ref", r.getString(2));
            m.put("label", r.getString(3));
            return m;
        }, docId);
    }

    // ---------------------------------------------------------------- reads per day

    static int readsToday(Connection c, String day) throws SQLException {
        Long n = Sql.longOne(c, "SELECT n FROM reads WHERE day = ?", day);
        return n == null ? 0 : n.intValue();
    }

    static void countRead(Connection c, String day) throws SQLException {
        Sql.update(c, "INSERT INTO reads (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1", day);
        Sql.update(c, "DELETE FROM reads WHERE day < ?", java.time.LocalDate.parse(day).minusDays(7).toString());
    }
}
