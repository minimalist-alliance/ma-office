package com.minimalistalliance.desk.deskd.docs;

import com.minimalistalliance.desk.deskd.files.DocsFiles;
import java.io.IOException;
import java.sql.SQLException;
import java.time.Clock;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Documents' intake (deskd {@code API.md} §25 "What deskd does on its own"): one thread, one file at a time through the
 * sandbox. Files' folder changes are heard as they happen and their folder looked at again; the first index of an
 * existing drive walks it at most 2 files a second, only while nobody is streaming the desk, and resumes where it stopped;
 * Courier's accepted attachments come in by their sequence; versions the sandbox couldn't read yet are tried again.
 * Nothing it logs names a file.
 */
public final class Intake implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(Intake.class);
    static final int FOLDER_MAX = 5_000;
    static final long FIRST_INDEX_GAP_MS = 500;
    /** A file an agent's tool just wrote: who, heard from the tools, for "Made for you by". */
    private final Map<String, String[]> agentWrites = new ConcurrentHashMap<>();

    /** Courier's attachments in the order they entered their lane, after a cursor, and a part's decoded bytes. */
    public interface CourierSource {
        record Item(long seq, long laneAt, String messageId, String part, String name, String type, long bytes, String danger,
                String lane, boolean bulk, boolean senderKnown, String origin, String threadRef, String subject, long receivedAt,
                String fromAddress, String fromName, String channelId, String contactId) {}

        /** Whole messages' attachments after {@code (laneAt, seq)}, at most {@code messages} messages. */
        List<Item> after(long laneAt, long seq, int messages) throws Exception;

        byte[] part(String messageId, String part) throws Exception;
    }

    /**
     * Notebook's pages, read through deskd's own calls to desk-notebook as the owner (API.md §25 "Intake"): the outline
     * with each page's last change, and one page as Markdown. Null answers mean Notebook can't be reached now.
     */
    public interface NotebookSource {
        record Page(String pageId, String title, String tab, long updatedAt) {}

        record Body(String title, String markdown, boolean untrusted) {}

        /** Every live page, or null when the outline can't be read whole (nothing is taken as gone then). */
        List<Page> pages() throws Exception;

        /** One page as Markdown, at most {@link Docs#MAX_BYTES}; null when it can't be read. */
        Body page(String pageId) throws Exception;

        /** Whether Notebook says the page is gone (not found, or in the Trash); false when it can't say now. */
        boolean gone(String pageId) throws Exception;
    }

    /** Desk Maia's write-ups kept on this desk (Phase 2's {@code desk_writeups}, desk-agent's), through deskd's link to it. */
    public interface WriteupSource {
        record Writeup(String id, String agentId, String agentName, long at, boolean readable, String text) {}

        /** Write-ups kept after {@code (at, id)}, oldest first, at most {@code n}; null when desk-agent can't be reached. */
        List<Writeup> after(long at, String id, int n) throws Exception;

        /** The ids of every write-up still kept, or null when that can't be read. */
        Set<String> kept() throws Exception;

        /** The ids of those whose answer went back without the desk's private data, or null when that can't be read. */
        Set<String> readable() throws Exception;

        /** One write-up, or null. */
        Writeup one(String id) throws Exception;
    }

    /** Notebook and write-ups are looked at again this often, and when Notebook says its tree changed. */
    static final long SWEEP_MS = 5 * 60_000L;
    static final int NOTEBOOK_MAX = 5_000;

    private final Docs docs;
    private final DocsFiles files;
    private volatile CourierSource courier;
    private volatile NotebookSource notebook;
    private volatile WriteupSource writeups;
    private boolean sweepDue;
    private boolean rekeyDue;
    private long lastSweep;
    private final BooleanSupplier streaming;
    /** Documents' kill switch, read before each unit of work (Security DOC-L4). */
    private volatile BooleanSupplier on = () -> true;
    private final Clock clock;
    private final Thread worker;
    private final Object lock = new Object();
    private final Deque<String> folders = new ArrayDeque<>();
    private final Set<String> queued = new LinkedHashSet<>();
    private boolean courierDue;
    private volatile boolean closed;
    private volatile boolean firstIndexDone;
    private long lastRetry;

    Intake(Docs docs, DocsFiles files, BooleanSupplier streaming, Clock clock) {
        this.docs = docs;
        this.files = files;
        this.streaming = streaming == null ? () -> false : streaming;
        this.clock = clock;
        this.worker = new Thread(this::run, "docs-intake");
        this.worker.setDaemon(true);
        this.worker.setPriority(Thread.MIN_PRIORITY);
        if (files != null) {
            files.listen(this::folderChanged);
        }
    }

    void start() {
        worker.start();
    }

    void switchedBy(BooleanSupplier switchOn) {
        this.on = switchOn == null ? () -> true : switchOn;
    }

    void courier(CourierSource source) {
        this.courier = source;
        courierChanged();
    }

    /** An agent's {@code files_write} just wrote {@code path}: its next version is that agent's. */
    void agentWrote(String path, String agentId, String agentName) {
        if (path != null) {
            agentWrites.put(path, new String[] {agentId, agentName, Long.toString(clock.millis())});
            folderChanged(parent(path));
        }
    }

    void folderChanged(String folder) {
        synchronized (lock) {
            String f = folder == null ? null : folder;
            if (f != null && (f.startsWith(".trash") || f.startsWith(".uploads"))) {
                return;
            }
            if (f == null) {
                // The trash changed: what left is found by looking at the folders its copies were in.
                return;
            }
            if (queued.add(f)) {
                folders.add(f);
            }
            lock.notifyAll();
        }
    }

    void courierChanged() {
        synchronized (lock) {
            courierDue = true;
            lock.notifyAll();
        }
    }

    void notebook(NotebookSource source) {
        this.notebook = source;
        sweepSoon();
    }

    void writeups(WriteupSource source) {
        this.writeups = source;
        sweepSoon();
    }

    /** Notebook's tree changed, or a write-up was kept: look at both again. */
    void sweepSoon() {
        synchronized (lock) {
            sweepDue = true;
            lock.notifyAll();
        }
    }

    /** The member's desks agreed on one person key: each attachment's sender is keyed again (no bytes read). */
    void rekeySoon() {
        synchronized (lock) {
            rekeyDue = true;
            lock.notifyAll();
        }
    }

    boolean firstIndexDone() {
        return firstIndexDone;
    }

    @Override
    public void close() {
        closed = true;
        synchronized (lock) {
            lock.notifyAll();
        }
        worker.interrupt();
    }

    private void run() {
        try {
            firstIndex();
            while (!closed) {
                String folder = null;
                boolean mail;
                boolean rekey;
                boolean sweep;
                synchronized (lock) {
                    while (!closed && folders.isEmpty() && !courierDue && !rekeyDue && !sweepDue
                            && clock.millis() - lastRetry < 600_000L && clock.millis() - lastSweep < SWEEP_MS) {
                        lock.wait(60_000L);
                    }
                    if (closed) {
                        return;
                    }
                    if (!folders.isEmpty()) {
                        folder = folders.poll();
                        queued.remove(folder);
                    }
                    rekey = rekeyDue && folder == null;
                    if (rekey) {
                        rekeyDue = false;
                    }
                    mail = courierDue && folder == null && !rekey;
                    if (mail) {
                        courierDue = false;
                    }
                    sweep = folder == null && !rekey && !mail && (sweepDue || clock.millis() - lastSweep >= SWEEP_MS);
                    if (sweep) {
                        sweepDue = false;
                    }
                }
                if (!on.getAsBoolean()) {
                    lastRetry = clock.millis();
                    lastSweep = clock.millis();
                    continue;
                }
                if (folder != null) {
                    scanFolder(folder, false);
                } else if (rekey) {
                    rekeyCourier();
                } else if (mail) {
                    pullCourier();
                } else if (sweep) {
                    lastSweep = clock.millis();
                    sweepNotebook();
                    sweepWriteups();
                } else {
                    lastRetry = clock.millis();
                    retryPending();
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            log.warn("docs: intake stopped: {}", e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- Files

    /** The first index: every folder, breadth first, resumable by the folder it reached (kept in the store's meta). */
    void firstIndex() throws InterruptedException {
        if (files == null) {
            firstIndexDone = true;
            return;
        }
        try {
            if ("done".equals(docs.store.meta("first.index"))) {
                firstIndexDone = true;
                return;
            }
            String resume = docs.store.meta("first.index.at");
            Deque<String> todo = new ArrayDeque<>();
            todo.add("");
            boolean skipping = resume != null;
            int seen = 0;
            while (!todo.isEmpty() && !closed) {
                if (!on.getAsBoolean()) {
                    // Switched off part way: the place it reached is kept, and the index carries on when it's back on.
                    return;
                }
                String folder = todo.poll();
                List<DocsFiles.Entry> entries;
                try {
                    entries = files.list(folder, FOLDER_MAX);
                } catch (IOException e) {
                    continue;
                }
                for (DocsFiles.Entry e : entries) {
                    if (e.dir()) {
                        todo.add(join(folder, e.name()));
                    }
                }
                if (skipping) {
                    if (folder.equals(resume)) {
                        skipping = false;
                    }
                    continue;
                }
                seen += scanFolder(folder, true);
                docs.store.meta("first.index.at", folder);
            }
            if (!closed && on.getAsBoolean()) {
                docs.store.meta("first.index", "done");
                docs.store.meta("first.sort", Integer.toString(seen));
                firstIndexDone = true;
            }
        } catch (SQLException e) {
            log.warn("docs: the first index can't keep its place: {}", e.getClass().getSimpleName());
        }
    }

    /** Looks at one folder: new and changed files in, files that left out. Returns how many files were indexed. */
    int scanFolder(String folder, boolean first) throws InterruptedException {
        List<DocsFiles.Entry> entries;
        try {
            entries = files.list(folder, FOLDER_MAX);
        } catch (IOException e) {
            entries = List.of();
        }
        int n = 0;
        Set<String> here = new HashSet<>();
        for (DocsFiles.Entry e : entries) {
            if (closed || !on.getAsBoolean()) {
                return n;
            }
            if (e.dir()) {
                continue;
            }
            String path = join(folder, e.name());
            here.add(ref(path));
            try {
                DocsStore.Copy known = docs.store.db().read(c -> DocsStore.copyByRef(c, ref(path)));
                if (known != null && !known.gone() && known.size() != null && known.size() == e.size() && known.mtime() != null
                        && known.mtime() == e.mtimeMs()) {
                    continue;
                }
                if (first) {
                    while (streaming.getAsBoolean() && !closed) {
                        synchronized (lock) {
                            lock.wait(5_000L);
                        }
                    }
                    Thread.sleep(FIRST_INDEX_GAP_MS);
                }
                indexFile(path, first);
                n++;
            } catch (SQLException | RuntimeException ex) {
                log.warn("docs: a file couldn't be indexed: {}", ex.getClass().getSimpleName());
            }
        }
        // Copies in this folder that aren't there any more left it.
        try {
            String prefix = ref(folder.isEmpty() ? "" : folder + "/");
            List<String> refs = docs.store.db().read(c -> Sql.list(c,
                    "SELECT source_ref FROM copies WHERE gone = 0 AND source_kind IN ('files', 'downloads') AND source_ref LIKE ? ESCAPE '\\'",
                    r -> r.getString(1), like(prefix) + "%"));
            for (String r : refs) {
                String rest = r.substring(prefix.length());
                if (!rest.contains("/") && !here.contains(r)) {
                    docs.gone(r);
                }
            }
        } catch (SQLException e) {
            log.warn("docs: a folder's leavers couldn't be read: {}", e.getClass().getSimpleName());
        }
        return n;
    }

    void indexFile(String path, boolean backfill) throws InterruptedException, SQLException {
        DocsFiles.Bytes b;
        try {
            b = files.read(path, Docs.MAX_BYTES);
        } catch (IOException e) {
            return;
        }
        String name = path.contains("/") ? path.substring(path.lastIndexOf('/') + 1) : path;
        String folder = parent(path);
        boolean download = path.startsWith("Downloads/");
        boolean courierSave = path.startsWith("Courier/");
        String[] agent = agentWrites.remove(path);
        if (agent != null && clock.millis() - Long.parseLong(agent[2]) > 600_000L) {
            agent = null;
        }
        String kind = agent != null ? "agent_output" : download ? "download" : "file";
        String label = download ? "Downloaded" : courierSave ? "Saved from Courier" : agent != null ? "Made by " + agent[1]
                : folder.isEmpty() ? "File" : "File · " + Titles.clean(folder.contains("/") ? folder.substring(folder.lastIndexOf('/') + 1) : folder, 40);
        docs.arrive(new Docs.Arrival(download ? "downloads" : "files", ref(path), label, kind, name, b.bytes(), b.sha256(), b.size(),
                b.mtimeMs(), b.mtimeMs() > 0 ? Math.min(b.mtimeMs(), clock.millis()) : clock.millis(), agent != null ? "agent" : "member",
                agent != null ? agent[1] : null, agent != null ? agent[1] : null, null, null, null, false, false, null, null,
                download || courierSave || agent != null, backfill,
                agent != null ? new Docs.Extra(null, null, agent[0], false) : Docs.Extra.NONE));
    }

    /** The copy's ref for a Files path. */
    static String ref(String path) {
        return "f:" + path;
    }

    static String path(String ref) {
        return ref.startsWith("f:") ? ref.substring(2) : null;
    }

    private static String like(String s) {
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    static String join(String folder, String name) {
        return folder.isEmpty() ? name : folder + "/" + name;
    }

    static String parent(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? "" : path.substring(0, slash);
    }

    // ---------------------------------------------------------------- Courier

    void pullCourier() throws InterruptedException {
        CourierSource source = courier;
        if (source == null) {
            return;
        }
        try {
            String at = docs.store.meta("courier.cursor");
            long laneAt = 0;
            long seq = 0;
            if (at != null && at.matches("\\d{1,19}\\.\\d{1,19}")) {
                laneAt = Long.parseLong(at.substring(0, at.indexOf('.')));
                seq = Long.parseLong(at.substring(at.indexOf('.') + 1));
            }
            while (!closed) {
                List<CourierSource.Item> items = source.after(laneAt, seq, 20);
                if (items.isEmpty()) {
                    break;
                }
                for (CourierSource.Item it : items) {
                    if (!on.getAsBoolean()) {
                        return;
                    }
                    laneAt = it.laneAt();
                    seq = it.seq();
                    byte[] bytes = null;
                    if (it.danger() == null && it.bytes() <= Docs.MAX_BYTES) {
                        try {
                            bytes = source.part(it.messageId(), it.part());
                        } catch (Exception e) {
                            bytes = null;
                        }
                    }
                    // Past each attachment before it's read, so one that ends deskd is passed by on the next start
                    // (DOC-L1, DOC-I7): it stays in Courier, outside the index.
                    docs.store.meta("courier.cursor", laneAt + "." + seq);
                    arriveAttachment(it, bytes);
                }
            }
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            log.warn("docs: Courier's attachments couldn't be read: {}", e.getClass().getSimpleName());
        }
    }

    private void arriveAttachment(CourierSource.Item it, byte[] bytes) throws SQLException, InterruptedException {
        String sha = bytes != null ? Bytes.sha256(bytes) : Bytes.sha256((it.messageId() + "#" + it.part()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String who = it.fromName() != null && !it.fromName().isBlank() ? it.fromName() : it.fromAddress();
        String subject = it.subject() == null || it.subject().isBlank() ? "" : " · " + Titles.clean(it.subject(), 40);
        docs.arrive(new Docs.Arrival("courier", "m:" + it.messageId() + "#" + it.part(), "Email from " + Titles.clean(who == null ? "someone" : who, 40) + subject,
                "attachment", it.name(), bytes, sha, bytes != null ? bytes.length : it.bytes(), null, it.receivedAt(), "person", who, null,
                it.fromAddress(), it.fromName(), it.lane(), it.bulk(), it.senderKnown(), it.threadRef(), it.danger(), true,
                "backfill".equals(it.origin()), new Docs.Extra(ulidOrNull(it.contactId()), ulidOrNull(it.channelId()), null, false)));
    }

    private static String ulidOrNull(String id) {
        return id != null && id.matches("[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}") ? id : null;
    }

    /**
     * Every indexed attachment's sender keyed again under the member's shared secret: Courier's list is walked from the start
     * with no part read, and each changed key carries its rules, let-through row and questions with it.
     */
    void rekeyCourier() throws InterruptedException {
        CourierSource source = courier;
        if (source == null) {
            return;
        }
        List<String> changed = new ArrayList<>();
        try {
            long laneAt = 0;
            long seq = 0;
            while (!closed) {
                List<CourierSource.Item> items = source.after(laneAt, seq, 50);
                if (items.isEmpty()) {
                    break;
                }
                for (CourierSource.Item it : items) {
                    laneAt = it.laneAt();
                    seq = it.seq();
                    String key = docs.keys.of(it.fromAddress());
                    if (key == null) {
                        continue;
                    }
                    String id = docs.store.db().transaction(c -> {
                        DocsStore.Copy k = DocsStore.copyByRef(c, "m:" + it.messageId() + "#" + it.part());
                        Doc d = k == null || k.gone() ? null : DocsStore.doc(c, k.docId());
                        if (d == null || key.equals(d.fromKey)) {
                            return null;
                        }
                        if (d.fromKey != null) {
                            DocsStore.rekey(c, d.fromKey, key);
                            d = DocsStore.doc(c, d.id);
                        }
                        d.fromKey = key;
                        DocsStore.save(c, d);
                        return d.id;
                    });
                    if (id != null) {
                        changed.add(id);
                    }
                }
                if (changed.size() >= 200) {
                    docs.store.changed(List.copyOf(changed));
                    changed.clear();
                }
            }
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            log.warn("docs: senders couldn't be keyed again: {}", e.getClass().getSimpleName());
        }
        docs.store.changed(changed);
    }

    // ---------------------------------------------------------------- Notebook

    /** The copy's ref for a Notebook page. */
    static String pageRef(String pageId) {
        return "n:" + pageId;
    }

    /** Notebook's pages in, by their last change; pages that left (trashed, purged) out, when the outline was read whole. */
    void sweepNotebook() throws InterruptedException {
        NotebookSource source = notebook;
        if (source == null) {
            return;
        }
        List<NotebookSource.Page> pages;
        try {
            pages = source.pages();
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            return;
        }
        if (pages == null) {
            return;
        }
        Set<String> here = new HashSet<>();
        for (NotebookSource.Page p : pages) {
            if (closed || !on.getAsBoolean()) {
                return;
            }
            if (p.pageId() == null || !p.pageId().matches("[A-Za-z0-9_-]{1,64}")) {
                continue;
            }
            String ref = pageRef(p.pageId());
            here.add(ref);
            try {
                DocsStore.Copy known = docs.store.db().read(c -> DocsStore.copyByRef(c, ref));
                if (known != null && !known.gone() && known.mtime() != null && known.mtime() == p.updatedAt()) {
                    continue;
                }
                NotebookSource.Body body = source.page(p.pageId());
                if (body == null) {
                    continue;
                }
                byte[] bytes = body.markdown() == null ? new byte[0] : body.markdown().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                if (bytes.length > Docs.MAX_BYTES) {
                    bytes = java.util.Arrays.copyOf(bytes, (int) Docs.MAX_BYTES);
                }
                String title = body.title() != null && !body.title().isBlank() ? body.title()
                        : p.title() != null && !p.title().isBlank() ? p.title() : "Untitled";
                String tab = p.tab() == null || p.tab().isBlank() ? "" : " · " + Titles.clean(p.tab(), 40);
                long at = p.updatedAt() > 0 ? Math.min(p.updatedAt(), clock.millis()) : clock.millis();
                docs.arrive(new Docs.Arrival("notebook", ref, "Notebook" + tab, "page", Titles.clean(title, 120) + ".md", bytes,
                        Bytes.sha256(bytes), bytes.length, p.updatedAt(), at, "member", null, null, null, null, null, false, false, null,
                        null, body.untrusted(), true, Docs.Extra.NONE));
            } catch (InterruptedException e) {
                throw e;
            } catch (Exception e) {
                log.warn("docs: a Notebook page couldn't be indexed: {}", e.getClass().getSimpleName());
            }
        }
        if (pages.size() < NOTEBOOK_MAX) {
            leftOf("notebook", here);
            return;
        }
        // The outline was cut: a page it didn't list may still be there, so each one is asked for itself, and only one that
        // can't be read (trashed, purged) leaves (Security's DOC2-L1).
        try {
            List<String> refs = docs.store.db().read(c -> Sql.list(c, "SELECT source_ref FROM copies WHERE gone = 0 AND source_kind = 'notebook'",
                    r -> r.getString(1)));
            for (String r : refs) {
                if (closed || here.contains(r)) {
                    continue;
                }
                // Only Notebook's own "not found" or "in the Trash" retires it; a Notebook away for a moment retires nothing
                // (Security's DOC2-I4).
                if (source.gone(r.substring(2))) {
                    docs.gone(r);
                }
            }
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            log.warn("docs: Notebook's leavers couldn't be read: {}", e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- write-ups

    /** The copy's ref for a write-up. */
    static String writeupRef(String id) {
        return "w:" + id;
    }

    /** New write-ups in, by their cursor; write-ups desk-agent no longer keeps (past 90 days) out. */
    void sweepWriteups() throws InterruptedException {
        WriteupSource source = writeups;
        if (source == null) {
            return;
        }
        try {
            String at = docs.store.meta("writeups.cursor");
            long after = 0;
            String afterId = "";
            if (at != null && at.matches("\\d{1,19}\\.wu-[a-z2-7]{1,40}")) {
                after = Long.parseLong(at.substring(0, at.indexOf('.')));
                afterId = at.substring(at.indexOf('.') + 1);
            }
            while (!closed) {
                List<WriteupSource.Writeup> items = source.after(after, afterId, 20);
                if (items == null || items.isEmpty()) {
                    break;
                }
                for (WriteupSource.Writeup w : items) {
                    if (!on.getAsBoolean()) {
                        return;
                    }
                    after = w.at();
                    afterId = w.id();
                    docs.store.meta("writeups.cursor", after + "." + afterId);
                    arriveWriteup(w);
                }
            }
            Set<String> kept = source.kept();
            if (kept != null) {
                Set<String> here = new HashSet<>();
                for (String id : kept) {
                    here.add(writeupRef(id));
                }
                leftOf("writeup", here);
            }
            // A write-up's mark can come after it was indexed (its answer's call says whether it held private data): the
            // reader follows desk-agent's mark, private until it says otherwise (Security's DOC2-I1).
            Set<String> readable = source.readable();
            if (readable != null) {
                List<String> changed = docs.store.db().transaction(c -> {
                    List<String> ids = new ArrayList<>();
                    for (Doc d : DocsStore.all(c, "kind = 'writeup' AND gone = 0")) {
                        boolean open = false;
                        for (DocsStore.Copy k : DocsStore.copies(c, d.id)) {
                            open |= !k.gone() && k.sourceRef().startsWith("w:") && readable.contains(k.sourceRef().substring(2));
                        }
                        if (d.noReader == open) {
                            d.noReader = !open;
                            DocsStore.save(c, d);
                            ids.add(d.id);
                        }
                    }
                    return ids;
                });
                docs.store.changed(changed);
            }
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            log.warn("docs: write-ups couldn't be read: {}", e.getClass().getSimpleName());
        }
    }

    void arriveWriteup(WriteupSource.Writeup w) throws SQLException, InterruptedException {
        if (w.id() == null || !w.id().matches("wu-[a-z2-7]{1,40}") || w.text() == null) {
            return;
        }
        byte[] bytes = w.text().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (bytes.length > Docs.MAX_BYTES) {
            bytes = java.util.Arrays.copyOf(bytes, (int) Docs.MAX_BYTES);
        }
        String named = w.agentName() == null || w.agentName().isBlank() ? null : Titles.clean(w.agentName(), 40);
        String agentId = w.agentId() != null && w.agentId().matches("[A-Za-z0-9_-]{1,64}") ? w.agentId() : null;
        // Agents' words, from runs that may have read anything: untrusted. Never read by the reader when the answer that
        // carried it held this desk's private data.
        docs.arrive(new Docs.Arrival("writeup", writeupRef(w.id()), "Write-up by " + (named == null ? "an agent" : named), "writeup",
                "Write-up.md", bytes, Bytes.sha256(bytes), bytes.length, w.at(), Math.min(w.at(), clock.millis()), "agent", named, named,
                null, null, null,
                false, false, null, null, true, true, new Docs.Extra(null, null, agentId, !w.readable())));
    }

    /** Copies of {@code sourceKind} whose refs aren't in {@code here} any more left their source. */
    private void leftOf(String sourceKind, Set<String> here) {
        try {
            List<String> refs = docs.store.db().read(c -> Sql.list(c, "SELECT source_ref FROM copies WHERE gone = 0 AND source_kind = ?",
                    r -> r.getString(1), sourceKind));
            for (String r : refs) {
                if (!here.contains(r)) {
                    docs.gone(r);
                }
            }
        } catch (SQLException e) {
            log.warn("docs: leavers couldn't be read: {}", e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- retries

    /** Versions the sandbox couldn't reach yet (an image without the documents mode, a busy sandbox): read them again. */
    void retryPending() throws InterruptedException {
        try {
            List<Doc> pending = docs.store.db().read(c -> DocsStore.all(c, "gone = 0 AND parse_state = 'pending' LIMIT 20"));
            for (Doc d : pending) {
                if (closed) {
                    return;
                }
                for (DocsStore.Copy k : docs.store.copies(d.id)) {
                    if (k.gone()) {
                        continue;
                    }
                    String p = path(k.sourceRef());
                    if (p != null && files != null) {
                        // Forgets the copy's size so the folder look reads it again, through the sandbox.
                        docs.store.db().transaction(c -> Sql.update(c, "UPDATE copies SET size = NULL WHERE id = ?", k.id()));
                        docs.store.db().transaction(c -> Sql.update(c, "DELETE FROM texts WHERE sha256 = ?", d.sha256));
                        indexAgain(d, p);
                    }
                    break;
                }
            }
        } catch (SQLException e) {
            log.warn("docs: retries couldn't be read: {}", e.getClass().getSimpleName());
        }
    }

    private void indexAgain(Doc d, String path) throws InterruptedException, SQLException {
        DocsFiles.Bytes b;
        try {
            b = files.read(path, Docs.MAX_BYTES);
        } catch (IOException e) {
            return;
        }
        if (b.bytes() == null || !b.sha256().equals(d.sha256)) {
            indexFile(path, false);
            return;
        }
        DocText text;
        try {
            text = docs.sandbox().read(d.type, b.bytes());
        } catch (DocsSandbox.Unavailable e) {
            return;
        } catch (DocsSandbox.Refused e) {
            docs.store.db().transaction(c -> Sql.update(c, "UPDATE docs SET parse_state = ? WHERE id = ?", "refused:" + e.reason(), d.id));
            return;
        }
        List<String> ids = new ArrayList<>();
        docs.store.db().transaction(c -> {
            DocsStore.putText(c, d.sha256, text, clock.millis());
            Doc row = DocsStore.doc(c, d.id);
            row.parseState = "ok";
            row.pageCount = text.pageCount() > 0 ? text.pageCount() : null;
            row.signEmpty = text.signaturesEmpty();
            row.formEmpty = text.formEmpty();
            row.simhash = SimHash.of(text.all());
            if (!"handled".equals(row.state)) {
                docs.decide(c, row, false, false);
            }
            row.title = docs.title(c, row);
            DocsStore.save(c, row);
            DocsStore.putFts(c, row.id, row.title, row.origName, text.all());
            ids.add(row.id);
            return null;
        });
        docs.store.changed(ids);
    }

    /** For tests: runs what's queued on this thread, until nothing is. */
    void drain() throws InterruptedException {
        while (true) {
            String folder;
            synchronized (lock) {
                folder = folders.poll();
                if (folder != null) {
                    queued.remove(folder);
                }
            }
            if (folder == null) {
                break;
            }
            scanFolder(folder, false);
        }
        boolean mail;
        boolean rekey;
        boolean sweep;
        synchronized (lock) {
            mail = courierDue;
            courierDue = false;
            rekey = rekeyDue;
            rekeyDue = false;
            sweep = sweepDue;
            sweepDue = false;
        }
        if (rekey) {
            rekeyCourier();
        }
        if (mail) {
            pullCourier();
        }
        if (sweep) {
            sweepNotebook();
            sweepWriteups();
        }
    }

    Map<String, Integer> stats() {
        Map<String, Integer> m = new HashMap<>();
        synchronized (lock) {
            m.put("queued", folders.size());
        }
        return m;
    }
}
