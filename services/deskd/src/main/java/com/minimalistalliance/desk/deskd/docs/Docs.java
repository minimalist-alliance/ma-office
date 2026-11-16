package com.minimalistalliance.desk.deskd.docs;

import java.io.IOException;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Documents' engine on one desk (deskd {@code API.md} §25): a version arriving at a copy becomes a document, a copy in an
 * existing stack, or a new version; the sandbox reads it once; code titles it and decides its place; and every read the
 * office, Desk Maia's tools and the methods make goes through here. Content (text, names, summaries) never leaves this
 * desk by any path in this class.
 */
public final class Docs {

    private static final Logger log = LoggerFactory.getLogger(Docs.class);

    /** The most of a file read into memory to index it: the sandbox's own limit. */
    static final long MAX_BYTES = 40L << 20;
    static final Set<String> READABLE = Set.of("pdf", "docx", "xlsx", "pptx", "text");
    static final long DAY = 86_400_000L;
    static final int[] CATCHUPS = {9, 13, 17};

    /** Where a copy's bytes come from again: Files, Courier's sandbox, a write-up. */
    public interface Sources {
        byte[] bytes(DocsStore.Copy copy) throws IOException, InterruptedException;
    }

    /** Asks desk-agent for one reading (the reader), when Desk Maia is on here; returns false when it can't. */
    public interface ReaderAsk {
        boolean ask(String docId, String sha256);
    }

    /** To-do's open item for a source, if one points at it: its due time (or the end of today for none), else null. */
    public interface TodoLinks {
        Long dueFor(String sourceKind, String ref);
    }

    final DocsStore store;
    private final DocsSandbox sandbox;
    private volatile Sources sources;
    final RenderCache cache;
    final VersionStore versions;
    final Clock clock;
    private final Supplier<ZoneId> zone;
    final PersonKeys keys;
    private volatile ReaderAsk reader = (d, s) -> false;
    private volatile TodoLinks todos = (k, r) -> null;

    Docs(DocsStore store, DocsSandbox sandbox, Sources sources, RenderCache cache, VersionStore versions, Clock clock,
            Supplier<ZoneId> zone, PersonKeys keys) {
        this.store = store;
        this.sandbox = sandbox;
        this.sources = sources;
        this.cache = cache;
        this.versions = versions;
        this.clock = clock;
        this.zone = zone;
        this.keys = keys;
    }

    void sources(Sources s) {
        this.sources = s;
    }

    void reader(ReaderAsk ask) {
        this.reader = ask == null ? (d, s) -> false : ask;
    }

    void todos(TodoLinks links) {
        this.todos = links == null ? (k, r) -> null : links;
    }

    ZoneId zone() {
        ZoneId z = zone.get();
        return z == null ? java.time.ZoneOffset.UTC : z;
    }

    DocsSandbox sandbox() {
        return sandbox;
    }

    // ================================================================ intake

    /** One version of a document arriving at one copy, with everything code knows of it (structure only). */
    record Arrival(
            String sourceKind, // files, downloads, courier, notebook, writeup
            String sourceRef, // a Files path, messageId#part, a page id, wu-…
            String label, // deskd's own words for the copy ("File · Contracts", "Email from Rosa Ortiz · Contract")
            String kind, // file, download, attachment, page, agent_output, writeup
            String origName,
            byte[] bytes, // null when over MAX_BYTES or not fetched
            String sha256,
            long size,
            Long mtime,
            long arrivedAt,
            String changedBy, // member, agent, maia, person
            String changedByName,
            String agentName,
            String fromAddress,
            String fromName,
            String lane,
            boolean bulk,
            boolean senderKnown,
            String threadRef,
            String danger,
            boolean untrusted,
            boolean backfill,
            Extra extra) {

        Arrival {
            extra = extra == null ? Extra.NONE : extra;
        }
    }

    /**
     * Ids code knows of an arrival (S0): Courier's contact and channel, the agent's id (for the focus shield's "goes with
     * this"), and whether the reader may ever read it (a write-up holding this desk's private data may not).
     */
    record Extra(String contactId, String channelId, String agentId, boolean noReader) {
        static final Extra NONE = new Extra(null, null, null, false);
    }

    /** What an arrival did. */
    record Result(String docId, String what) {} // what: new, copy, version, same, skipped

    Result arrive(Arrival a) throws SQLException, InterruptedException {
        long now = clock.millis();
        byte[] head = a.bytes() == null ? null : java.util.Arrays.copyOf(a.bytes(), Math.min(a.bytes().length, 8192));
        String type = a.bytes() == null ? typeByName(a.origName()) : Bytes.type(head, a.origName());
        String danger = a.danger() != null ? a.danger() : Bytes.danger(head, a.origName());
        if (danger != null) {
            type = "other";
        }
        // The sandbox reads it before any write, outside the store's writer, once per version (by its hash).
        DocText text = null;
        String parse = "none";
        if (danger == null && a.bytes() != null && READABLE.contains(type)) {
            DocText known = store.text(a.sha256());
            if (known != null) {
                text = known;
                parse = "ok";
            } else {
                try {
                    text = sandbox.read(type, a.bytes());
                    parse = "ok";
                } catch (DocsSandbox.Unavailable e) {
                    parse = "pending";
                } catch (DocsSandbox.Refused e) {
                    parse = "refused:" + e.reason();
                }
            }
        } else if (danger == null && "image".equals(type)) {
            parse = "ok";
        }
        final DocText read = text;
        final String parseState = parse;
        final String finalType = type;
        final String finalDanger = danger;
        List<String> changedIds = new ArrayList<>();
        Result result = store.db().transaction(c -> {
            DocsStore.Copy existing = DocsStore.copyByRef(c, a.sourceRef());
            if (existing != null && !existing.gone() && a.sha256().equals(existing.sha256())) {
                DocsStore.putCopy(c, new DocsStore.Copy(existing.id(), existing.docId(), existing.sourceKind(), existing.sourceRef(),
                        a.label(), existing.arrivedAt(), a.size(), a.mtime(), a.sha256(), false));
                // The person key again (the member's desks may have just agreed on one key).
                String key = keys.of(a.fromAddress());
                Doc same = key == null ? null : DocsStore.doc(c, existing.docId());
                if (same != null && !key.equals(same.fromKey)) {
                    DocsStore.rekey(c, same.fromKey, key);
                    same = DocsStore.doc(c, same.id);
                    same.fromKey = key;
                    DocsStore.save(c, same);
                    changedIds.add(same.id);
                }
                return new Result(existing.docId(), "same");
            }
            if (read != null) {
                DocsStore.putText(c, a.sha256(), read, now);
            }
            // A new version at the same place (a file replaced, an agent's write over it).
            Doc doc = existing == null ? null : DocsStore.doc(c, existing.docId());
            if (doc != null && !doc.sha256.equals(a.sha256()) && "notebook".equals(a.sourceKind())) {
                // A Notebook page changed: Notebook keeps its own history, so the document follows it in place.
                pageChanged(c, doc, a, read, parseState);
                DocsStore.putCopy(c, new DocsStore.Copy(existing.id(), doc.id, existing.sourceKind(), existing.sourceRef(), a.label(),
                        existing.arrivedAt(), a.size(), a.mtime(), a.sha256(), false));
                changedIds.add(doc.id);
                return new Result(doc.id, "version");
            }
            if (doc != null && !doc.sha256.equals(a.sha256())) {
                Doc twin = stackable(c, a);
                if (twin != null && !twin.id.equals(doc.id)) {
                    // The new bytes are another document's exactly: this copy joins that stack.
                    moveCopy(c, existing, twin, a);
                    changedIds.add(twin.id);
                    changedIds.add(doc.id);
                    retireIfEmpty(c, doc);
                    return new Result(twin.id, "copy");
                }
                newVersion(c, doc, a, finalType, finalDanger, read, parseState, now);
                DocsStore.putCopy(c, new DocsStore.Copy(existing.id(), doc.id, existing.sourceKind(), existing.sourceRef(), a.label(),
                        existing.arrivedAt(), a.size(), a.mtime(), a.sha256(), false));
                changedIds.add(doc.id);
                return new Result(doc.id, "version");
            }
            // An exact copy of a document already here: one more copy in its stack (never two Notebook pages or write-ups
            // that read the same: each is its own).
            Doc twin = stackable(c, a);
            if (twin != null) {
                String copyId = existing == null ? DocsStore.newId("c_", now) : existing.id();
                DocsStore.putCopy(c, new DocsStore.Copy(copyId, twin.id, a.sourceKind(), a.sourceRef(), a.label(), a.arrivedAt(),
                        a.size(), a.mtime(), a.sha256(), false));
                topCopy(c, twin);
                DocsStore.save(c, twin);
                changedIds.add(twin.id);
                return new Result(twin.id, "copy");
            }
            // A new attachment with the same name stem in the same thread: a newer version, stacked with Undo.
            if ("courier".equals(a.sourceKind()) && a.threadRef() != null) {
                Doc prior = sameThreadStem(c, a);
                if (prior != null) {
                    newVersion(c, prior, a, finalType, finalDanger, read, parseState, now);
                    DocsStore.putCopy(c, new DocsStore.Copy(DocsStore.newId("c_", now), prior.id, a.sourceKind(), a.sourceRef(), a.label(),
                            a.arrivedAt(), a.size(), a.mtime(), a.sha256(), false));
                    changedIds.add(prior.id);
                    return new Result(prior.id, "version");
                }
            }
            Doc d = newDoc(c, a, finalType, finalDanger, read, parseState, now);
            DocsStore.putCopy(c, new DocsStore.Copy(existing == null ? DocsStore.newId("c_", now) : existing.id(), d.id, a.sourceKind(),
                    a.sourceRef(), a.label(), a.arrivedAt(), a.size(), a.mtime(), a.sha256(), false));
            changedIds.add(d.id);
            return new Result(d.id, "new");
        });
        // Old bytes kept for Versions (Files' own documents only; mail never changes).
        if (("files".equals(a.sourceKind()) || "downloads".equals(a.sourceKind())) && a.bytes() != null && finalDanger == null
                && !"same".equals(result.what())) {
            versions.keep(a.sha256(), a.bytes());
        }
        store.changed(changedIds);
        return result;
    }

    private static String typeByName(String name) {
        String n = name == null ? "" : name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".pdf")) {
            return "pdf";
        }
        return "other";
    }

    private Doc newDoc(Connection c, Arrival a, String type, String danger, DocText text, String parse, long now) throws SQLException {
        Doc d = new Doc();
        d.id = DocsStore.newId("d_", now);
        d.kind = a.kind();
        d.type = type;
        d.origName = a.origName() == null ? "Document" : Titles.clean(a.origName(), 255);
        d.size = a.size();
        d.sha256 = a.sha256();
        d.arrivedAt = a.arrivedAt();
        d.changedAt = a.arrivedAt();
        d.changedBy = a.changedBy();
        d.changedByName = a.changedByName();
        d.agentName = a.agentName();
        d.danger = danger;
        d.untrusted = a.untrusted();
        d.fromKey = keys.of(a.fromAddress());
        d.fromName = a.fromName() == null ? null : Titles.clean(a.fromName(), 60);
        d.fromDomain = Titles.domain(a.fromAddress());
        d.threadRef = a.threadRef();
        d.lane = a.lane();
        d.bulk = a.bulk();
        d.senderKnown = a.senderKnown();
        d.sourceKind = a.sourceKind();
        d.sourceLabel = a.label();
        d.contactId = a.extra().contactId();
        d.channelId = a.extra().channelId();
        d.agentId = a.extra().agentId();
        d.noReader = a.extra().noReader();
        d.state = a.backfill() ? "seen" : "new";
        d.pendingSourceKind = a.sourceKind();
        d.pendingRef = a.sourceRef();
        applyText(d, text, parse);
        boolean first = d.fromKey != null && Places.kindOf(facts(c, d, false)) != null
                && Sql.longOne(c, "SELECT 1 FROM docs WHERE from_key = ? AND gone = 0 LIMIT 1", d.fromKey) == null;
        decide(c, d, false, first);
        d.title = title(c, d);
        DocsStore.insert(c, d);
        DocsStore.putVersion(c, new DocsStore.Version(DocsStore.newId("v_", now), d.id, d.sha256, a.arrivedAt(), versionBy(a),
                a.changedByName() != null ? a.changedByName() : a.agentName(), milestoneFor(a, null, text), milestoneArg(a),
                null, false, a.size()));
        DocsStore.putFts(c, d.id, d.title, d.origName, text == null ? null : text.all());
        afterPlace(c, d, first, now, a.backfill());
        return d;
    }

    /** Sources whose documents never join another's stack: two pages, or two write-ups, that read the same are still two. */
    static final Set<String> OWN_STACK = Set.of("notebook", "writeup");

    /**
     * The document these exact bytes already are, to stack with: never for a page or a write-up, and never one of theirs (a
     * file that reads like a page stays a file, so a page's edit can't move it: Security's DOC2-I2).
     */
    private static Doc stackable(Connection c, Arrival a) throws SQLException {
        if (OWN_STACK.contains(a.sourceKind())) {
            return null;
        }
        Doc twin = DocsStore.bySha(c, a.sha256());
        return twin == null || "page".equals(twin.kind) || "writeup".equals(twin.kind) ? null : twin;
    }

    /** A Notebook page's new text, in place: its one version row follows the page (Notebook's own history has the rest). */
    private void pageChanged(Connection c, Doc d, Arrival a, DocText text, String parse) throws SQLException {
        d.sha256 = a.sha256();
        d.size = a.size();
        d.changedAt = Math.max(d.changedAt, a.arrivedAt());
        d.changedBy = a.changedBy();
        d.changedByName = a.changedByName();
        d.origName = a.origName() == null ? d.origName : Titles.clean(a.origName(), 255);
        d.sourceLabel = a.label();
        d.untrusted = a.untrusted();
        applyText(d, text, parse);
        if (!"handled".equals(d.state)) {
            decide(c, d, false, false);
        }
        d.title = title(c, d);
        DocsStore.save(c, d);
        Sql.update(c, "UPDATE versions SET sha256 = ?, at = ?, size = ?, by = ?, by_name = ? WHERE doc_id = ?", a.sha256(),
                a.arrivedAt(), a.size(), versionBy(a), a.changedByName(), d.id);
        DocsStore.putFts(c, d.id, d.title, d.origName, text == null ? null : text.all());
    }

    private void newVersion(Connection c, Doc d, Arrival a, String type, String danger, DocText text, String parse, long now)
            throws SQLException {
        DocText before = DocsStore.text(c, d.sha256);
        List<Integer> pages = List.of();
        if (before != null && text != null) {
            pages = PageDiff.diff(before, text).pages();
        }
        String wasPlace = d.place;
        boolean wasNeeds = Places.NEEDS.equals(wasPlace);
        d.type = type;
        d.danger = danger;
        d.sha256 = a.sha256();
        d.size = a.size();
        d.changedAt = a.arrivedAt();
        d.changedBy = a.changedBy();
        d.changedByName = a.changedByName() != null ? a.changedByName() : a.agentName();
        if (a.agentName() != null) {
            d.agentName = a.agentName();
        }
        if (a.extra().agentId() != null) {
            d.agentId = a.extra().agentId();
        }
        if (a.extra().contactId() != null) {
            d.contactId = a.extra().contactId();
        }
        if (a.extra().channelId() != null) {
            d.channelId = a.extra().channelId();
        }
        d.sourceLabel = a.label();
        d.sensitive = false;
        applyText(d, text, parse);
        if ("handled".equals(d.state) && !"member".equals(a.changedBy())) {
            d.state = "seen";
        }
        boolean bySomeoneElse = !"member".equals(a.changedBy()) && !"maia".equals(a.changedBy());
        String milestone = milestoneFor(a, before, text);
        boolean signed = "signed".equals(milestone);
        Facts extra = new Facts(wasNeeds && bySomeoneElse, signed);
        decide(c, d, extra.newVersionOfNeeds(), false);
        if (signed && Places.NEEDS.equals(d.place)) {
            // A "Signed" milestone takes it out of Needs you: it left quietly.
            d.state = "handled";
        }
        if (Places.NEEDS.equals(d.place) && "newver".equals(d.reason) && !pages.isEmpty()) {
            d.reason = "changed";
            d.reasonArg = csv(pages);
        }
        d.title = title(c, d);
        DocsStore.save(c, d);
        DocsStore.putVersion(c, new DocsStore.Version(DocsStore.newId("v_", now), d.id, a.sha256(), a.arrivedAt(), versionBy(a),
                d.changedByName, milestone, milestoneArg(a), pages.isEmpty() ? null : csv(pages), false, a.size()));
        DocsStore.putFts(c, d.id, d.title, d.origName, text == null ? null : text.all());
        afterPlace(c, d, false, now, a.backfill());
    }

    /** What decide() needs beyond the row: whether this is a new version, by someone else, of one that needed the member. */
    private record Facts(boolean newVersionOfNeeds, boolean signed) {}

    private static String versionBy(Arrival a) {
        return switch (a.changedBy()) {
            case "agent" -> "agent:" + (a.agentName() == null ? "agent" : a.agentName());
            case "person" -> "person";
            case "maia" -> "maia";
            default -> "member";
        };
    }

    private static String milestoneFor(Arrival a, DocText before, DocText after) {
        if (after != null && after.signatures() > 0 && after.signaturesEmpty() == 0 && before != null && before.signaturesEmpty() > 0) {
            return "signed";
        }
        if ("courier".equals(a.sourceKind())) {
            return "received";
        }
        if ("agent".equals(a.changedBy())) {
            return "edited";
        }
        return null;
    }

    private static String milestoneArg(Arrival a) {
        return "courier".equals(a.sourceKind()) ? a.fromName() : "agent".equals(a.changedBy()) ? a.agentName() : null;
    }

    private static void applyText(Doc d, DocText text, String parse) {
        d.parseState = parse.length() > 40 ? parse.substring(0, 40) : parse;
        if (text != null) {
            d.pageCount = text.pageCount() > 0 ? text.pageCount() : null;
            d.signEmpty = text.signaturesEmpty();
            d.formEmpty = text.formEmpty();
            d.simhash = SimHash.of(text.all());
        } else if ("image".equals(d.type)) {
            d.pageCount = 1;
        }
    }

    private void moveCopy(Connection c, DocsStore.Copy copy, Doc to, Arrival a) throws SQLException {
        DocsStore.putCopy(c, new DocsStore.Copy(copy.id(), to.id, copy.sourceKind(), copy.sourceRef(), a.label(), copy.arrivedAt(),
                a.size(), a.mtime(), a.sha256(), false));
        topCopy(c, to);
        DocsStore.save(c, to);
    }

    /** A document whose every copy is gone is marked gone (its rows go when the tidy finds its last copy left the trash). */
    private static void retireIfEmpty(Connection c, Doc d) throws SQLException {
        if (Sql.longOne(c, "SELECT 1 FROM copies WHERE doc_id = ? AND gone = 0 LIMIT 1", d.id) == null) {
            d.gone = true;
            DocsStore.save(c, d);
        }
    }

    /** The top copy: the member's own placement (Files), else the newest. */
    private static void topCopy(Connection c, Doc d) throws SQLException {
        List<DocsStore.Copy> copies = DocsStore.copies(c, d.id);
        DocsStore.Copy top = null;
        for (DocsStore.Copy k : copies) {
            if (k.gone()) {
                continue;
            }
            if (top == null || "files".equals(k.sourceKind()) && !"files".equals(top.sourceKind())) {
                top = k;
            }
        }
        if (top != null) {
            d.sourceKind = top.sourceKind();
            d.sourceLabel = top.label();
            d.gone = false;
        }
    }

    private Doc sameThreadStem(Connection c, Arrival a) throws SQLException {
        String stem = Titles.stem(a.origName()).toLowerCase(Locale.ROOT);
        for (Doc d : DocsStore.all(c, "thread_ref = ? AND gone = 0 AND kind = 'attachment'", a.threadRef())) {
            if (Titles.stem(d.origName).toLowerCase(Locale.ROOT).equals(stem)) {
                return d;
            }
        }
        return null;
    }

    // ================================================================ deciding

    /** The facts Places takes, from the row and the store. */
    Places.Facts facts(Connection c, Doc d, boolean newVersionOfNeeds) throws SQLException {
        Map<String, Object> s = DocsStore.summary(c, d.sha256);
        Places.Reader reader = null;
        if (s != null) {
            @SuppressWarnings("unchecked")
            List<String> asks = s.get("asks") instanceof List<?> l ? (List<String>) l : List.of();
            Long due = s.get("dueAt") instanceof Number n ? n.longValue() : null;
            Integer signPage = null;
            if (s.get("pages") instanceof Map<?, ?> pm && pm.get("sign") instanceof Number sp) {
                signPage = sp.intValue();
            }
            reader = new Places.Reader((String) s.get("what"), asks, due, signPage);
        }
        String ref = null;
        String sourceKind = null;
        DocsStore.Copy top = topCopyOf(c, d);
        if (top != null) {
            ref = top.sourceRef();
            sourceKind = top.sourceKind();
        } else {
            ref = d.pendingRef;
            sourceKind = d.pendingSourceKind;
        }
        Long todoDue = ref == null ? null : todos.dueFor(sourceKind, ref);
        boolean ownUpload = "file".equals(d.kind) && "member".equals(d.changedBy) && !d.untrusted;
        return new Places.Facts(d.kind, d.danger, d.lane, d.bulk, d.senderKnown, d.fromKey, d.fromDomain, d.origName,
                DocsStore.letThrough(c, d.fromKey), todoDue, newVersionOfNeeds, ownUpload, d.signEmpty, d.formEmpty, false, null,
                reader, d.arrivedAt, clock.millis(), d.lastSeenAt != null, d.agentName);
    }

    private static DocsStore.Copy topCopyOf(Connection c, Doc d) throws SQLException {
        DocsStore.Copy top = null;
        for (DocsStore.Copy k : DocsStore.copies(c, d.id)) {
            if (!k.gone() && (top == null || "files".equals(k.sourceKind()) && !"files".equals(top.sourceKind()))) {
                top = k;
            }
        }
        return top;
    }

    /** Decides the place and the reason, from the facts, the member's rules and the welcome's. */
    void decide(Connection c, Doc d, boolean newVersionOfNeeds, boolean firstOfSenderKind) throws SQLException {
        Places.Facts f = facts(c, d, newVersionOfNeeds || "newver".equals(d.reason) || "changed".equals(d.reason) && Places.NEEDS.equals(d.place));
        if (firstOfSenderKind) {
            f = new Places.Facts(f.kind(), f.danger(), f.lane(), f.bulk(), f.senderKnown(), f.personKey(), f.domain(), f.origName(),
                    f.letThrough(), f.todoDueAt(), f.newVersionOfNeeds(), f.ownUpload(), f.signaturesEmpty(), f.formEmpty(), true,
                    f.senderEarlierPlace(), f.reader(), f.arrivedAt(), f.now(), f.openedEver(), f.agentName());
        }
        Places.Decision p = Places.decide(f, DocsStore.rules(c), DocsStore.welcome(c));
        d.place = p.place();
        d.maybe = p.maybe();
        d.reason = p.reason();
        d.reasonArg = p.reasonArg() != null ? p.reasonArg() : switch (p.reason()) {
            case "from", "newver", "thread" -> d.who();
            case "made" -> d.agentName != null ? d.agentName : "an agent";
            default -> null;
        };
        d.basis = p.basis();
        d.dueAt = p.dueAt();
        if (p.dueAt() != null && Places.NEEDS.equals(p.place()) && !"due".equals(p.reason()) && p.dueAt() - clock.millis() < 3 * DAY) {
            d.reason = "due";
        }
        Map<String, Object> s = DocsStore.summary(c, d.sha256);
        d.what = s != null && s.get("what") instanceof String w && !"other".equals(w) ? w : null;
        d.sensitive = s != null && Boolean.TRUE.equals(s.get("sensitive"));
    }

    /** After a place: questions asked once (a new sender and kind, a near copy), and the reader for what's about to show. */
    private void afterPlace(Connection c, Doc d, boolean firstOfSenderKind, long now, boolean backfill) throws SQLException {
        if (firstOfSenderKind && d.fromKey != null && !backfill) {
            String kind = Places.kindOf(facts(c, d, false));
            if (kind != null) {
                Map<String, Object> args = new LinkedHashMap<>();
                args.put("who", d.who());
                args.put("kind", kind);
                args.put("person", d.fromKey);
                DocsStore.ask(c, "file", List.of(d.id), "file:" + d.fromKey + ":" + kind, args, now);
            }
        }
        if (d.simhash != null && d.danger == null) {
            for (Doc other : DocsStore.all(c, "simhash IS NOT NULL AND gone = 0 AND id <> ? AND sha256 <> ?", d.id, d.sha256)) {
                if (SimHash.distance(other.simhash, d.simhash) <= SimHash.NEAR) {
                    Map<String, Object> args = new LinkedHashMap<>();
                    args.put("title", other.title);
                    String a = d.id.compareTo(other.id) < 0 ? d.id : other.id;
                    String b = a.equals(d.id) ? other.id : d.id;
                    DocsStore.ask(c, "near", List.of(d.id, other.id), "near:" + a + ":" + b, args, now);
                    break;
                }
            }
        }
    }

    String title(Connection c, Doc d) {
        String what = d.what != null ? capital(d.what) : "writeup".equals(d.kind) ? "Write-up"
                : "page".equals(d.kind) ? pageTitle(d.origName) : Titles.stem(d.origName);
        if (d.what != null) {
            String stem = Titles.stem(d.origName);
            String ref = stem.replaceAll("(?i).*?\\b((?:no\\.?|#)?\\s?[0-9][0-9A-Za-z-]{2,})\\b.*", "$1");
            if (!ref.equals(stem) && ref.length() <= 16) {
                what = what + " " + ref.strip();
            }
        }
        return Titles.title(d.arrivedAt, zone(), d.who(), what);
    }

    /** A Notebook page's own title, as the member wrote it (the index keeps it as {@code <title>.md}). */
    static String pageTitle(String origName) {
        String t = origName == null ? "" : origName.endsWith(".md") ? origName.substring(0, origName.length() - 3) : origName;
        t = Titles.clean(t, 60);
        return t.isBlank() ? "Untitled" : t;
    }

    private static String capital(String w) {
        return w.isEmpty() ? w : Character.toUpperCase(w.charAt(0)) + w.substring(1);
    }

    static String csv(List<Integer> pages) {
        StringBuilder b = new StringBuilder();
        for (int p : pages) {
            if (b.length() > 0) {
                b.append(',');
            }
            b.append(p);
        }
        return b.toString();
    }

    static List<Integer> pagesOf(String csv) {
        List<Integer> out = new ArrayList<>();
        if (csv != null && !csv.isEmpty()) {
            for (String p : csv.split(",")) {
                try {
                    out.add(Integer.parseInt(p));
                } catch (NumberFormatException e) {
                    // skipped
                }
            }
        }
        return out;
    }

    /** Re-decides documents after a rule or answer changed (not handled ones, not those the member placed by hand). */
    List<String> redecide(Connection c, String where, Object... args) throws SQLException {
        List<String> ids = new ArrayList<>();
        for (Doc d : DocsStore.all(c, "gone = 0 AND state <> 'handled' AND (" + where + ")", args)) {
            String before = d.place + d.maybe + d.reason;
            decide(c, d, false, false);
            if (!before.equals(d.place + d.maybe + d.reason)) {
                d.title = title(c, d);
                DocsStore.save(c, d);
                ids.add(d.id);
            }
        }
        return ids;
    }

    /** A copy left (the file moved to the trash or was removed, the mail deleted). */
    void gone(String sourceRef) throws SQLException {
        List<String> ids = new ArrayList<>();
        List<String> drop = new ArrayList<>();
        store.db().transaction(c -> {
            DocsStore.Copy k = DocsStore.copyByRef(c, sourceRef);
            if (k == null || k.gone()) {
                return null;
            }
            DocsStore.putCopy(c, new DocsStore.Copy(k.id(), k.docId(), k.sourceKind(), k.sourceRef(), k.label(), k.arrivedAt(), k.size(),
                    k.mtime(), k.sha256(), true));
            Doc d = DocsStore.doc(c, k.docId());
            if (d != null) {
                topCopy(c, d);
                if (Sql.longOne(c, "SELECT 1 FROM copies WHERE doc_id = ? AND gone = 0 LIMIT 1", d.id) == null) {
                    d.gone = true;
                    // Its kept bytes go with it (Security DOC-L5), unless another document still has the same bytes.
                    for (DocsStore.Version v : DocsStore.versions(c, d.id)) {
                        if (Sql.longOne(c, "SELECT 1 FROM versions v JOIN docs x ON x.id = v.doc_id WHERE v.sha256 = ? AND x.gone = 0"
                                + " AND x.id <> ? LIMIT 1", v.sha256(), d.id) == null) {
                            drop.add(v.sha256());
                        }
                    }
                }
                DocsStore.save(c, d);
                ids.add(d.id);
            }
            return null;
        });
        for (String sha : drop) {
            versions.drop(sha);
        }
        store.changed(ids);
    }

    /**
     * The version store's keeping (API.md §25): an unnamed version that isn't its document's current one goes after 30
     * days, a gone document's at once. Returns how many went.
     */
    int pruneVersions() throws SQLException {
        long cutoff = clock.millis() - 30 * DAY;
        List<String> old = store.db().read(c -> Sql.list(c, """
                SELECT DISTINCT v.sha256 FROM versions v JOIN docs d ON d.id = v.doc_id
                WHERE (d.gone = 1 OR (v.milestone IS NULL AND v.at < ? AND v.sha256 <> d.sha256))
                  AND NOT EXISTS (SELECT 1 FROM versions w JOIN docs e ON e.id = w.doc_id WHERE w.sha256 = v.sha256 AND e.gone = 0
                                  AND (w.milestone IS NOT NULL OR w.at >= ? OR w.sha256 = e.sha256))""", r -> r.getString(1), cutoff, cutoff));
        for (String sha : old) {
            versions.drop(sha);
        }
        return old.size();
    }

    // ================================================================ the reader's facts

    /** Stores the reader's checked facts for one version, and decides again. */
    void summarise(String docId, String sha, Map<String, Object> facts) throws SQLException {
        List<String> ids = new ArrayList<>();
        store.db().transaction(c -> {
            Sql.update(c, "INSERT OR REPLACE INTO summaries (sha256, json, at) VALUES (?, ?, ?)", sha, DocsSandbox.Answers.write(facts),
                    clock.millis());
            Doc d = DocsStore.doc(c, docId);
            if (d != null && d.sha256.equals(sha) && !d.gone) {
                if (!"handled".equals(d.state)) {
                    decide(c, d, false, false);
                }
                d.what = facts.get("what") instanceof String w && !"other".equals(w) ? w : null;
                d.sensitive = Boolean.TRUE.equals(facts.get("sensitive"));
                d.title = title(c, d);
                DocsStore.save(c, d);
                DocsStore.putFts(c, d.id, d.title, d.origName, null);
                DocText t = DocsStore.text(c, sha);
                if (t != null) {
                    DocsStore.putFts(c, d.id, d.title, d.origName, t.all());
                }
                ids.add(d.id);
            }
            return null;
        });
        store.changed(ids);
    }

    /** The member's tap: one reading of this document's current version, outside the day's 15. */
    boolean readNow(Doc d) throws SQLException {
        if (d.danger != null || d.noReader || !"ok".equals(d.parseState)) {
            return false;
        }
        String day = LocalDate.now(clock.withZone(zone())).toString();
        if (reader.ask(d.id, d.sha256)) {
            store.db().transaction(c -> {
                DocsStore.countRead(c, day);
                return null;
            });
            return true;
        }
        return false;
    }

    /** Asks for readings of what's about to be shown: Needs you and Maybe with no summary, within the day's 15. */
    void readAboutToShow(List<Doc> shown, boolean tap) {
        for (Doc d : shown) {
            if (d.danger != null || d.noReader || !READABLE.contains(d.type) && !"image".equals(d.type) || !"ok".equals(d.parseState)) {
                continue;
            }
            if (!tap && !Places.NEEDS.equals(d.place)) {
                continue;
            }
            try {
                boolean have = store.db().read(c -> Sql.longOne(c, "SELECT 1 FROM summaries WHERE sha256 = ?", d.sha256) != null);
                if (have) {
                    continue;
                }
                String day = LocalDate.now(clock.withZone(zone())).toString();
                int n = store.db().read(c -> DocsStore.readsToday(c, day));
                if (!tap && n >= 15) {
                    return;
                }
                if (reader.ask(d.id, d.sha256)) {
                    store.db().transaction(c -> {
                        DocsStore.countRead(c, day);
                        return null;
                    });
                }
            } catch (SQLException | RuntimeException e) {
                log.warn("docs: the reader's count can't be read: {}", e.getClass().getSimpleName());
                return;
            }
        }
    }

    // ================================================================ catch-ups and time

    /** The next catch-up (9:00, 13:00, 17:00 in the member's zone, the shield's defaults) after now. */
    long nextCatchUp(long now) {
        ZoneId z = zone();
        ZonedDateTime at = Instant.ofEpochMilli(now).atZone(z);
        for (int h : CATCHUPS) {
            ZonedDateTime t = at.toLocalDate().atTime(LocalTime.of(h, 0)).atZone(z);
            if (t.toInstant().toEpochMilli() > now) {
                return t.toInstant().toEpochMilli();
            }
        }
        return at.toLocalDate().plusDays(1).atTime(LocalTime.of(CATCHUPS[0], 0)).atZone(z).toInstant().toEpochMilli();
    }

    /** The nightly pass: Read later past 14 days unread to Records, downloads past 7 days unopened, place by time. */
    List<String> nightly() throws SQLException {
        long now = clock.millis();
        List<String> ids = new ArrayList<>();
        store.db().transaction(c -> {
            for (Doc d : DocsStore.all(c, "gone = 0 AND place = 'read' AND last_seen_at IS NULL AND arrived_at < ?", now - 14 * DAY)) {
                d.place = Places.RECORDS;
                d.reason = "default";
                d.reasonArg = null;
                DocsStore.save(c, d);
                ids.add(d.id);
            }
            ids.addAll(redecide(c, "kind = 'download' AND place = 'working'"));
            Sql.update(c, "DELETE FROM seen WHERE at < ?", now - 90 * DAY);
            Sql.update(c, "DELETE FROM undo WHERE expires_at < ?", now);
            return null;
        });
        if (!ids.isEmpty()) {
            store.meta("folded", Integer.toString(ids.size()));
        }
        store.changed(ids);
        return ids;
    }

    // ================================================================ bytes of a version

    /** The bytes of a document's version: the current one from its top copy, an older one from the version store. */
    byte[] bytesOf(Doc d, String sha) throws IOException, InterruptedException, SQLException {
        if (d.gone) {
            throw new IOException("gone");
        }
        if (sha == null || sha.equals(d.sha256)) {
            List<DocsStore.Copy> copies = store.copies(d.id);
            IOException last = null;
            for (DocsStore.Copy k : copies) {
                if (k.gone() || !d.sha256.equals(k.sha256())) {
                    continue;
                }
                try {
                    byte[] b = sources.bytes(k);
                    if (b != null && Bytes.sha256(b).equals(d.sha256)) {
                        return b;
                    }
                } catch (IOException e) {
                    last = e;
                }
            }
            if (versions.has(d.sha256)) {
                return versions.get(d.sha256);
            }
            throw last != null ? last : new IOException("gone");
        }
        return versions.get(sha);
    }

    // ================================================================ the wire

    /** One document as API §25 gives it. */
    Map<String, Object> wire(Connection c, Doc d) throws SQLException {
        long now = clock.millis();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", d.id);
        m.put("kind", d.kind);
        m.put("type", d.type);
        m.put("title", d.title);
        m.put("origName", d.origName);
        m.put("size", d.size);
        m.put("place", d.place);
        m.put("maybe", d.maybe);
        Map<String, Object> reason = new LinkedHashMap<>();
        reason.put("code", d.reason);
        reason.put("text", Words.reason(d.reason, d.reasonArg, d.dueAt, zone(), now));
        m.put("reason", reason);
        m.put("dueAt", d.dueAt);
        if (d.fromName != null || d.fromKey != null) {
            Map<String, Object> from = new LinkedHashMap<>();
            from.put("name", d.fromName);
            from.put("personKey", d.fromKey);
            m.put("from", from);
        } else {
            m.put("from", null);
        }
        m.put("arrivedAt", d.arrivedAt);
        m.put("changedAt", d.changedAt);
        Map<String, Object> by = new LinkedHashMap<>();
        by.put("kind", d.changedBy);
        by.put("name", d.changedByName);
        m.put("changedBy", by);
        m.put("state", d.state);
        m.put("heldUntil", d.heldUntil != null && d.heldUntil > now ? d.heldUntil : null);
        List<DocsStore.Copy> copies = DocsStore.copies(c, d.id);
        m.put("copies", (int) copies.stream().filter(k -> !k.gone()).count());
        m.put("versions", Sql.longOne(c, "SELECT COUNT(*) FROM versions WHERE doc_id = ?", d.id));
        m.put("changedPages", changedSinceSeen(c, d));
        m.put("lastPage", d.lastPage == null ? 1 : d.lastPage);
        m.put("pageCount", d.pageCount);
        m.put("viewable", d.viewable());
        m.put("danger", d.danger);
        m.put("untrusted", d.untrusted);
        m.put("sensitive", d.sensitive);
        Map<String, Object> s = DocsStore.summary(c, d.sha256);
        if (s != null) {
            Map<String, Object> sum = new LinkedHashMap<>();
            for (String k : List.of("line", "what", "asks", "due", "pages", "changeLine", "at")) {
                if (s.containsKey(k)) {
                    sum.put(k, s.get(k));
                }
            }
            m.put("summary", sum);
        } else {
            m.put("summary", null);
        }
        Map<String, Object> source = new LinkedHashMap<>();
        source.put("kind", d.sourceKind);
        source.put("label", d.sourceLabel);
        m.put("source", source);
        if (d.sensitive) {
            m.put("sensitiveText", Words.sensitive(d.fromName));
        }
        return m;
    }

    /** Pages changed in the versions after the one the member last saw. */
    static List<Integer> changedSinceSeen(Connection c, Doc d) throws SQLException {
        if (d.lastSeenSha == null || d.lastSeenSha.equals(d.sha256)) {
            return List.of();
        }
        List<DocsStore.Version> vs = DocsStore.versions(c, d.id);
        TreeSet<Integer> pages = new TreeSet<>();
        for (DocsStore.Version v : vs) {
            if (v.sha256().equals(d.lastSeenSha)) {
                break;
            }
            pages.addAll(pagesOf(v.pagesChanged()));
        }
        return List.copyOf(pages);
    }

    /** The version the member last saw, or the one before the current, for "what changed". */
    static String baseline(Connection c, Doc d) throws SQLException {
        if (d.lastSeenSha != null && !d.lastSeenSha.equals(d.sha256)) {
            return d.lastSeenSha;
        }
        List<DocsStore.Version> vs = DocsStore.versions(c, d.id);
        for (DocsStore.Version v : vs) {
            if (!v.sha256().equals(d.sha256)) {
                return v.sha256();
            }
        }
        return null;
    }

    // ================================================================ lists and search

    static final String VISIBLE = "gone = 0";

    record Page(List<Doc> docs, boolean more, int offset) {}

    Page list(String place, String view, String person, int offset, int limit) throws SQLException {
        long now = clock.millis();
        StringBuilder where = new StringBuilder(VISIBLE);
        List<Object> args = new ArrayList<>();
        if (place != null && !"all".equals(place)) {
            where.append(" AND place = ?");
            args.add(place);
            if (Places.NEEDS.equals(place) || Places.READ.equals(place) || Places.WORKING.equals(place)) {
                where.append(" AND state <> 'handled' AND (held_until IS NULL OR held_until <= ?)");
                args.add(now);
            }
        }
        if ("week".equals(view)) {
            where.append(" AND (arrived_at >= ? OR changed_at >= ?)");
            args.add(now - 7 * DAY);
            args.add(now - 7 * DAY);
        }
        if (person != null) {
            where.append(" AND from_key = ?");
            args.add(person);
        }
        String order = " ORDER BY maybe, (due_at IS NULL), due_at, (last_seen_sha IS NOT NULL AND last_seen_sha <> sha256) DESC,"
                + " changed_at DESC, id";
        if ("people".equals(view)) {
            order = " ORDER BY (from_name IS NULL), from_name, changed_at DESC, id";
        }
        args.add(limit + 1);
        args.add(offset);
        String sql = "SELECT * FROM docs WHERE " + where + order + " LIMIT ? OFFSET ?";
        List<Doc> rows = store.db().read(c -> Sql.list(c, sql, Doc::of, args.toArray()));
        boolean more = rows.size() > limit;
        return new Page(more ? rows.subList(0, limit) : rows, more, offset);
    }

    Map<String, Object> counts() throws SQLException {
        long now = clock.millis();
        return store.db().read(c -> {
            Map<String, Object> m = new LinkedHashMap<>();
            String live = " AND state <> 'handled' AND (held_until IS NULL OR held_until <= ?)";
            m.put("needs", Sql.longOne(c, "SELECT COUNT(*) FROM docs WHERE gone = 0 AND place = 'needs' AND maybe = 0" + live, now));
            m.put("maybe", Sql.longOne(c, "SELECT COUNT(*) FROM docs WHERE gone = 0 AND place = 'needs' AND maybe = 1" + live, now));
            m.put("read", Sql.longOne(c, "SELECT COUNT(*) FROM docs WHERE gone = 0 AND place = 'read'" + live, now));
            m.put("records", Sql.longOne(c, "SELECT COUNT(*) FROM docs WHERE gone = 0 AND place = 'records'"));
            m.put("working", Sql.longOne(c, "SELECT COUNT(*) FROM docs WHERE gone = 0 AND place = 'working'" + live, now));
            m.put("held", Sql.longOne(c, "SELECT COUNT(*) FROM docs WHERE gone = 0 AND state <> 'handled' AND held_until > ?", now));
            return m;
        });
    }

    /** A search's terms, structured (Desk Maia turns the member's words into this; the office sends it as typed). */
    record Query(String words, List<String> personKeys, String personName, Long from, Long to, String kind, String type,
            boolean inText) {}

    List<Map.Entry<Doc, Boolean>> search(Query q, int limit) throws SQLException {
        return store.db().read(c -> {
            Set<String> people = new HashSet<>(q.personKeys() == null ? List.of() : q.personKeys());
            if (q.personName() != null && !q.personName().isBlank()) {
                String like = "%" + q.personName().strip().replace("%", "").replace("_", "") + "%";
                people.addAll(Sql.list(c, "SELECT DISTINCT from_key FROM docs WHERE from_key IS NOT NULL AND from_name LIKE ?",
                        r -> r.getString(1), like));
                if (people.isEmpty()) {
                    return List.of();
                }
            }
            Map<String, Double> textScore = new HashMap<>();
            Set<String> bodyHits = new HashSet<>();
            String fts = ftsQuery(q.words());
            if (fts != null) {
                for (Object[] r : Sql.list(c, "SELECT doc_id, bm25(fts, 0.0, 4.0, 2.0, 0.0) FROM fts WHERE fts MATCH ? LIMIT 2000",
                        r -> new Object[] {r.getString(1), r.getDouble(2)}, "{title name} : (" + fts + ")")) {
                    textScore.put((String) r[0], -((Double) r[1]));
                }
                if (q.inText()) {
                    for (Object[] r : Sql.list(c, "SELECT doc_id, bm25(fts, 0.0, 0.0, 0.0, 1.0) FROM fts WHERE fts MATCH ? LIMIT 2000",
                            r -> new Object[] {r.getString(1), r.getDouble(2)}, "body : (" + fts + ")")) {
                        String id = (String) r[0];
                        if (!textScore.containsKey(id)) {
                            bodyHits.add(id);
                            textScore.put(id, -((Double) r[1]) * 0.5);
                        }
                    }
                }
                if (textScore.isEmpty()) {
                    return List.of();
                }
            }
            StringBuilder where = new StringBuilder(VISIBLE);
            List<Object> args = new ArrayList<>();
            if (!people.isEmpty()) {
                where.append(" AND from_key IN (").append(String.join(",", Collections.nCopies(people.size(), "?"))).append(")");
                args.addAll(people);
            }
            if (q.from() != null) {
                where.append(" AND (arrived_at >= ? OR changed_at >= ?)");
                args.add(q.from());
                args.add(q.from());
            }
            if (q.to() != null) {
                where.append(" AND arrived_at <= ?");
                args.add(q.to());
            }
            if (q.type() != null) {
                where.append(" AND type = ?");
                args.add(q.type());
            }
            if (q.kind() != null) {
                where.append(" AND (what = ? OR lower(orig_name) LIKE ?)");
                args.add(q.kind());
                args.add("%" + q.kind().toLowerCase(Locale.ROOT) + "%");
            }
            if (fts != null) {
                where.append(" AND id IN (").append(String.join(",", Collections.nCopies(textScore.size(), "?"))).append(")");
                args.addAll(textScore.keySet());
            }
            List<Doc> rows = Sql.list(c, "SELECT * FROM docs WHERE " + where + " LIMIT 5000", Doc::of, args.toArray());
            // Person, time fit, seen before, place, then the words: the same query, the same order.
            Map<String, Integer> placeRank = Map.of("needs", 0, "working", 1, "read", 2, "records", 3);
            rows.sort((a, b) -> {
                double sa = textScore.getOrDefault(a.id, 0.0) + (a.lastSeenAt != null ? 0.5 : 0) - placeRank.getOrDefault(a.place, 3) * 0.1;
                double sb = textScore.getOrDefault(b.id, 0.0) + (b.lastSeenAt != null ? 0.5 : 0) - placeRank.getOrDefault(b.place, 3) * 0.1;
                int byScore = Double.compare(sb, sa);
                if (byScore != 0) {
                    return byScore;
                }
                int byTime = Long.compare(b.arrivedAt, a.arrivedAt);
                return byTime != 0 ? byTime : a.id.compareTo(b.id);
            });
            List<Map.Entry<Doc, Boolean>> out = new ArrayList<>();
            for (Doc d : rows.subList(0, Math.min(limit, rows.size()))) {
                out.add(Map.entry(d, bodyHits.contains(d.id)));
            }
            return out;
        });
    }

    /** The member's words as an FTS5 query: each word a quoted prefix term, ANDed; null for none. */
    static String ftsQuery(String words) {
        if (words == null) {
            return null;
        }
        List<String> terms = new ArrayList<>();
        for (String w : SimHash.normal(words).split(" ")) {
            if (w.length() >= 2 && terms.size() < 8 && !STOP.contains(w)) {
                terms.add("\"" + w.replace("\"", "") + "\"*");
            }
        }
        return terms.isEmpty() ? null : String.join(" AND ", terms);
    }

    private static final Set<String> STOP = Set.of("the", "a", "an", "of", "to", "and", "or", "my", "me", "that", "this", "from",
            "for", "in", "on", "it", "is", "was", "sent", "thing", "file", "document", "doc");
}
