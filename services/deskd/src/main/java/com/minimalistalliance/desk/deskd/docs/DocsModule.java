package com.minimalistalliance.desk.deskd.docs;

import com.minimalistalliance.desk.deskd.data.Transfer;
import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.files.DocsFiles;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcHandler;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Documents in deskd (API.md §25; the draft ADR "Documents"): the store {@code /data/desk/docs.db}, the index's intake, the
 * member's {@code docs.*} methods, the topic {@code docs}, the nightly tidy, and what Desk Maia's document tools read
 * ({@link #docs()}). On by default, with a kill switch ({@code /data/desk/docs-switch} saying {@code off}). A guild desk has
 * none. A store that can't open makes every call {@code unavailable} {@code store}, and nothing else in deskd changes.
 */
public final class DocsModule implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(DocsModule.class);

    public static final String SWITCH_FILE = "docs-switch";
    static final String TOPIC = "docs";
    static final int MAX_IDS = 50;

    private final DocsStore store;
    private final Docs docs;
    private final Intake intake;
    private final BooleanSupplier guildDesk;
    private final Path switchFile;
    private final EventHub hub;
    private final Clock clock;
    private final ScheduledExecutorService timer;
    private volatile Transfers transfers;
    private volatile Supplier<Instant> pausedUntil = () -> null;
    private final DocsFiles files;
    private volatile Intake.CourierSource courierSource;
    private volatile Intake.NotebookSource notebookSource;
    private volatile Intake.WriteupSource writeupSource;
    private final Map<String, Long> askAllowed = new java.util.concurrent.ConcurrentHashMap<>();
    /** The desk's record of what Documents did on the member's behalf: event and ids only, never a name or content. */
    private volatile java.util.function.BiConsumer<String, String> audit = (event, detail) -> log.info("audit {} {}", event, detail);

    /**
     * @param directory deskd's directory on the volume ({@code /data/desk}): the store, the caches and the switch
     * @param files Files' way in for documents, or null where Files can't be used
     * @param sandbox the parse sandbox's documents mode
     * @param streaming whether someone is streaming the desk now (the first index waits)
     */
    public DocsModule(RpcDispatcher dispatcher, EventHub hub, Path directory, DocsFiles files, DocsSandbox sandbox,
            BooleanSupplier guildDesk, BooleanSupplier streaming, Supplier<ZoneId> zone, Clock clock) {
        this.guildDesk = guildDesk;
        this.hub = hub;
        this.clock = clock;
        this.switchFile = directory == null ? null : directory.resolve(SWITCH_FILE);
        this.files = files;
        DocsStore opened = null;
        if (directory != null) {
            try {
                opened = DocsStore.open(directory.resolve(DocsStore.FILE));
            } catch (SQLException | RuntimeException | LinkageError e) {
                log.warn("Documents' store can't be opened: {}", e.getClass().getSimpleName());
            }
        }
        this.store = opened;
        if (store != null) {
            Docs.Sources sources = copy -> {
                String p = Intake.path(copy.sourceRef());
                if (p != null && files != null) {
                    DocsFiles.Bytes b = files.read(p, Docs.MAX_BYTES);
                    return b.bytes();
                }
                // A mail attachment: cut out of its message by the sandbox, as Save to Files does.
                Intake.CourierSource mail = courierSource;
                String ref = copy.sourceRef();
                if (mail != null && ref.startsWith("m:") && ref.indexOf('#') > 2) {
                    try {
                        return mail.part(ref.substring(2, ref.indexOf('#')), ref.substring(ref.indexOf('#') + 1));
                    } catch (InterruptedException e) {
                        throw e;
                    } catch (Exception e) {
                        throw new IOException("courier");
                    }
                }
                // A Notebook page as Markdown, or a write-up's text: the bytes the index read.
                Intake.NotebookSource notebook = notebookSource;
                if (notebook != null && ref.startsWith("n:")) {
                    try {
                        Intake.NotebookSource.Body body = notebook.page(ref.substring(2));
                        if (body != null) {
                            return body.markdown().getBytes(StandardCharsets.UTF_8);
                        }
                    } catch (InterruptedException e) {
                        throw e;
                    } catch (Exception e) {
                        throw new IOException("notebook");
                    }
                }
                Intake.WriteupSource writeups = writeupSource;
                if (writeups != null && ref.startsWith("w:")) {
                    try {
                        Intake.WriteupSource.Writeup w = writeups.one(ref.substring(2));
                        if (w != null) {
                            return w.text().getBytes(StandardCharsets.UTF_8);
                        }
                    } catch (InterruptedException e) {
                        throw e;
                    } catch (Exception e) {
                        throw new IOException("writeup");
                    }
                }
                throw new IOException("source");
            };
            this.docs = new Docs(store, sandbox, sources, new RenderCache(directory.resolve("docs-cache")),
                    new VersionStore(directory.resolve("versions")), clock, zone, new PersonKeys(directory.resolve("docs-person.key")));
            this.intake = new Intake(docs, files, streaming, clock);
            this.intake.switchedBy(() -> on() && !guildDesk.getAsBoolean());
            store.onChange(this::publish);
        } else {
            this.docs = null;
            this.intake = null;
        }
        this.timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "docs-tidy");
            t.setDaemon(true);
            return t;
        });
        hub.topics().register(TOPIC, new Feed());
        register(dispatcher);
    }

    /** The parse sandbox's documents mode over deskd's one sandbox client. */
    public static DocsSandbox sandbox(com.minimalistalliance.desk.deskd.courier.parse.CourierSandbox sandbox) {
        return DocsSandbox.over(sandbox);
    }

    /** Starts the intake and the nightly tidy (after the rest of deskd is up). */
    public void start() {
        if (intake != null && on() && !guildDesk.getAsBoolean()) {
            intake.start();
            timer.scheduleWithFixedDelay(this::tidy, 2, TimeUnit.DAYS.toMinutes(1), TimeUnit.MINUTES);
        }
    }

    /** The data module's transfer table and the bandwidth pause, for {@code docs.page} on {@code bulk}. */
    public void pagesThrough(Transfers table, Supplier<Instant> paused) {
        this.transfers = table;
        this.pausedUntil = paused == null ? () -> null : paused;
    }

    /** Courier's accepted attachments, for the index. */
    public void courier(Intake.CourierSource source) {
        this.courierSource = source;
        if (intake != null) {
            intake.courier(source);
        }
    }

    /** The person-key secret changed: every attachment's sender is keyed again, on the intake's thread. */
    void rekey() {
        if (intake != null) {
            intake.rekeySoon();
        }
    }

    /** Courier's store committed something: look for new attachments. */
    public void courierChanged() {
        if (intake != null) {
            intake.courierChanged();
        }
    }

    /** Notebook's pages, for the index (deskd's own calls to desk-notebook); null on a desk without it. */
    public void notebook(Intake.NotebookSource source) {
        this.notebookSource = source;
        if (intake != null && source != null) {
            intake.notebook(source);
        }
    }

    /** Desk Maia's write-ups kept on this desk (desk-agent's), for the index. */
    public void writeups(Intake.WriteupSource source) {
        this.writeupSource = source;
        if (intake != null && source != null) {
            intake.writeups(source);
        }
    }

    /** Notebook's tree changed, or desk-agent kept a write-up: look at them again. Never blocks. */
    public void sourcesChanged() {
        if (intake != null) {
            intake.sweepSoon();
        }
    }

    /** An agent's {@code files_write} wrote a file: its next version is that agent's ("Made for you by"). */
    public void agentWrote(String path, String agentId, String agentName) {
        if (intake != null) {
            intake.agentWrote(path, agentId, agentName);
        }
    }

    /** desk-agent's side of the reader: {@code desk.docs.read} with its params, its facts or {@code {skipped}}. */
    public interface ReaderLink {
        Map<String, Object> read(Map<String, Object> params) throws Exception;
    }

    /**
     * The reader (API.md §25 "The reader's facts"), through desk-agent while {@code allowed} (Desk Maia active here, an
     * adult's desk): one reading of one version, off the caller's thread; its facts checked again here before they're kept.
     */
    public void readerThrough(ReaderLink link, BooleanSupplier allowed) {
        if (docs == null) {
            return;
        }
        docs.reader((docId, sha) -> {
            if (link == null || !allowed.getAsBoolean()) {
                return false;
            }
            Thread.ofVirtual().name("docs-reader").start(() -> readNow(link, docId, sha));
            return true;
        });
    }

    void readNow(ReaderLink link, String docId, String sha) {
        try {
            Map<String, Object> params = store.db().read(c -> {
                Doc d = DocsStore.doc(c, docId);
                DocText t = DocsStore.text(c, sha);
                if (d == null || t == null || d.danger != null || d.noReader) {
                    return null;
                }
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("docId", docId);
                p.put("versionSha256", sha);
                p.put("title", d.title);
                p.put("pages", readerPages(t));
                String base = sha.equals(d.sha256) ? Docs.baseline(c, d) : null;
                DocText before = base == null ? null : DocsStore.text(c, base);
                if (before != null) {
                    p.put("before", readerPages(before));
                }
                return p;
            });
            if (params == null) {
                return;
            }
            Map<String, Object> facts = link.read(params);
            if (facts == null || facts.containsKey("skipped")) {
                return;
            }
            int pages = store.db().read(c -> {
                DocText t = DocsStore.text(c, sha);
                return t == null ? 1 : Math.max(1, Math.max(t.pageCount(), t.pages().size()));
            });
            Map<String, Object> checked = ReaderFacts.check(facts, docs.zone(), clock.millis(), pages, params.containsKey("before"));
            if (checked != null) {
                docs.summarise(docId, sha, checked);
                audit("docs.read", "doc:" + docId + " v:" + sha.substring(0, 8));
            }
        } catch (Exception e) {
            log.warn("docs: a reading didn't land: {}", e.getClass().getSimpleName());
        }
    }

    /** One version's text as the reader takes it: pages (or sections as pages), at most 30,000 characters. */
    static List<Map<String, Object>> readerPages(DocText t) {
        List<Map<String, Object>> out = new ArrayList<>();
        int left = 30_000;
        if (!t.pages().isEmpty()) {
            for (DocText.Page p : t.pages()) {
                if (left <= 0) {
                    break;
                }
                String text = p.text().length() > left ? p.text().substring(0, left) : p.text();
                left -= text.length();
                out.add(Map.of("n", p.n(), "text", text));
            }
        } else {
            StringBuilder b = new StringBuilder();
            for (String s : t.sectionTexts()) {
                if (b.length() + s.length() + 1 > 30_000) {
                    break;
                }
                b.append(s).append('\n');
            }
            out.add(Map.of("n", 1, "text", b.toString()));
        }
        return out;
    }

    /** To-do's open items that point at a document's copy. */
    public void todos(Docs.TodoLinks links) {
        if (docs != null) {
            docs.todos(links);
        }
    }

    /** The desk's audit log (ids only). */
    public void audit(java.util.function.BiConsumer<String, String> log) {
        this.audit = log == null ? (e, d) -> {} : log;
    }

    /** The engine for Desk Maia's tools, or null while Documents can't be used. */
    public Docs docs() {
        return refusal() == null ? docs : null;
    }

    /** Whether "Ask Maia about this" was tapped for this document in the last 10 minutes. */
    public boolean askAllowed(String docId) {
        Long until = askAllowed.get(docId);
        return until != null && until > clock.millis();
    }

    public boolean available() {
        return store != null;
    }

    private final java.util.concurrent.atomic.AtomicBoolean closed = new java.util.concurrent.atomic.AtomicBoolean();

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        timer.shutdownNow();
        if (intake != null) {
            intake.close();
        }
        if (store != null) {
            store.close();
        }
    }

    void tidy() {
        if (docs == null || !on() || guildDesk.getAsBoolean()) {
            return;
        }
        try {
            docs.nightly();
            docs.cache.sweep(clock.millis());
            docs.pruneVersions();
            // A document whose copies have all been gone 30 days goes, with its rows.
            store.db().transaction(c -> Sql.update(c, "DELETE FROM docs WHERE gone = 1 AND changed_at < ? AND NOT EXISTS"
                    + " (SELECT 1 FROM copies k WHERE k.doc_id = docs.id AND k.gone = 0)", clock.millis() - 30 * Docs.DAY));
            store.db().transaction(c -> Sql.update(c, "DELETE FROM fts WHERE doc_id NOT IN (SELECT id FROM docs)"));
            store.db().transaction(c -> Sql.update(c, "DELETE FROM texts WHERE sha256 NOT IN (SELECT sha256 FROM versions)"));
        } catch (SQLException | RuntimeException e) {
            log.warn("docs tidy failed: {}", e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- the switch and refusals

    private boolean on() {
        if (switchFile == null) {
            return true;
        }
        try {
            BasicFileAttributes a = Files.readAttributes(switchFile, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!a.isRegularFile() || a.size() > 1024) {
                return false;
            }
            return !Files.readString(switchFile, StandardCharsets.US_ASCII).strip().equals("off");
        } catch (java.nio.file.NoSuchFileException e) {
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    RpcException refusal() {
        if (guildDesk.getAsBoolean()) {
            return new RpcException(RpcException.FORBIDDEN, "No Documents on this desk", Map.of("reason", "scope"));
        }
        if (store == null) {
            return new RpcException(RpcException.UNAVAILABLE, "Documents' store can't be used", Map.of("reason", "store"));
        }
        if (!on()) {
            return new RpcException(RpcException.UNAVAILABLE, "Documents is switched off", Map.of("reason", "switched_off"));
        }
        return null;
    }

    private void publish(List<String> ids) {
        try {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("rev", store.rev());
            data.put("ids", ids.size() > MAX_IDS ? null : List.copyOf(new java.util.LinkedHashSet<>(ids)));
            data.put("counts", docs.counts());
            hub.publish(TOPIC, "changed", data);
        } catch (SQLException | RuntimeException e) {
            // The next change tells.
        }
    }

    private final class Feed implements Topic {
        @Override
        public boolean coalescible() {
            return true;
        }

        @Override
        public boolean publishesWithNoSubscriber() {
            return false;
        }

        @Override
        public Object snapshot(String topicKey, Map<String, Object> params) throws Exception {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("rev", store == null ? 0 : store.rev());
            m.put("counts", docs == null ? Map.of() : docs.counts());
            return m;
        }

        @Override
        public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
            if (!RpcPrincipal.OWNER.equals(principal.scope())) {
                throw new RpcException(RpcException.FORBIDDEN, "Not this session's", Map.of("reason", "scope"));
            }
            RpcException no = refusal();
            if (no != null) {
                throw no;
            }
        }
    }

    // ---------------------------------------------------------------- the methods

    private RpcHandler guarded(RpcHandler handler) {
        return (context, params) -> {
            RpcException no = refusal();
            if (no != null) {
                throw no;
            }
            try {
                return handler.handle(context, params);
            } catch (DocsMethods.Wrapped w) {
                throw w.rpc;
            } catch (IllegalArgumentException e) {
                throw new RpcException(RpcException.BAD_REQUEST, "Bad params", Map.of("reason", "params"));
            }
        };
    }

    private void register(RpcDispatcher d) {
        DocsMethods m = new DocsMethods(this);
        d.register("docs.list", guarded(m::list));
        d.register("docs.get", guarded(m::get));
        d.register("docs.search", guarded(m::search));
        d.register("docs.byPath", guarded(m::byPath));
        d.register("docs.text", guarded(m::text));
        d.register("docs.page", guarded(m::page));
        d.register("docs.page.stop", guarded(m::pageStop));
        d.register("docs.changes", guarded(m::changes));
        d.register("docs.questions", guarded(m::questions));
        d.register("docs.rules", guarded(m::rules));
        d.register("docs.summary", guarded(m::summary));
        d.register("docs.feed", guarded(m::feed));
        d.register("docs.tidy", guarded(m::tidyPreview));
        d.register("docs.export", RpcDispatcher.OWNER_OR_EXPORT, guarded(m::export));
        d.registerMutation("docs.tap", guarded(m::tap));
        d.registerMutation("docs.undo", guarded(m::undo));
        d.registerMutation("docs.answer", guarded(m::answer));
        d.registerMutation("docs.rule.add", guarded(m::ruleAdd));
        d.registerMutation("docs.rule.remove", guarded(m::ruleRemove));
        d.registerMutation("docs.seen", guarded(m::seen));
        d.registerMutation("docs.restore", guarded(m::restore));
        d.registerMutation("docs.rename", guarded(m::rename));
        d.registerMutation("docs.tidy.apply", guarded(m::tidyApply));
        d.registerMutation("docs.ask.allow", guarded(m::askAllow));
        // A tap that asks for a reading changes none of the member's data: a read, as the office calls it.
        d.register("docs.read", guarded(m::read));
        d.register("docs.key.get", guarded(m::keyGet));
        d.registerMutation("docs.key.set", guarded(m::keySet));
    }

    // ---------------------------------------------------------------- what DocsMethods needs

    Docs engine() {
        return docs;
    }

    DocsFiles filesAccess() {
        return files;
    }

    DocsStore store() {
        return store;
    }

    Intake intake() {
        return intake;
    }

    Clock clock() {
        return clock;
    }

    Transfers transfers() throws RpcException {
        Transfers t = transfers;
        if (t == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "Pages can't be sent yet", Map.of("reason", "transfers"));
        }
        return t;
    }

    void refusePaused() throws RpcException {
        Instant until = pausedUntil.get();
        if (until == null) {
            return;
        }
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", "bandwidth_limit");
        details.put("resumesAt", until.equals(Instant.MAX) ? null : until.toString());
        throw new RpcException(RpcException.UNAVAILABLE, "Paused at the bandwidth limit", details);
    }

    void allowAsk(String docId) {
        askAllowed.entrySet().removeIf(e -> e.getValue() < clock.millis());
        askAllowed.put(docId, clock.millis() + 600_000L);
    }

    void audit(String event, String detail) {
        try {
            audit.accept(event, detail);
        } catch (RuntimeException e) {
            // The log's own trouble.
        }
    }

    /** A page image held in memory for its transfer (at most 4 MiB): the trailer is its SHA-256 and size. */
    static final class MemoryBody implements Transfer.Body {
        private final byte[] bytes;
        private final long mtimeMs;
        private final byte[] trailer;
        private int position;

        MemoryBody(byte[] bytes, long mtimeMs) {
            this.bytes = bytes;
            this.mtimeMs = mtimeMs;
            java.nio.ByteBuffer t = java.nio.ByteBuffer.allocate(40);
            t.put(HexFormat.of().parseHex(Bytes.sha256(bytes)));
            t.putLong(bytes.length);
            this.trailer = t.array();
        }

        String sha256() {
            return HexFormat.of().formatHex(trailer, 0, 32);
        }

        @Override
        public long size() {
            return bytes.length;
        }

        @Override
        public long mtimeMs() {
            return mtimeMs;
        }

        @Override
        public boolean atEnd() {
            return position >= bytes.length;
        }

        @Override
        public int read(byte[] into, int length) {
            int n = Math.min(length, bytes.length - position);
            if (n <= 0) {
                return 0;
            }
            System.arraycopy(bytes, position, into, 0, n);
            position += n;
            return n;
        }

        @Override
        public byte[] trailer() {
            return trailer;
        }

        @Override
        public void close() {}
    }

    static List<String> ids(List<Doc> docs) {
        List<String> out = new ArrayList<>(docs.size());
        for (Doc d : docs) {
            out.add(d.id);
        }
        return out;
    }

    static final Set<String> CHIPS = Set.of("not_now", "not_important", "sooner", "done");
}
