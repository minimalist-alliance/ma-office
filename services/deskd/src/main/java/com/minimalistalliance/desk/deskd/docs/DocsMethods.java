package com.minimalistalliance.desk.deskd.docs;

import com.minimalistalliance.desk.deskd.data.Transfer;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** The member's {@code docs.*} methods (API.md §25), each checking its params strictly before it reads anything. */
final class DocsMethods {

    private static final Pattern WORDS = Pattern.compile("[\\s\\S]{0,200}");
    private static final Pattern PERSON = Pattern.compile("pk_[0-9a-f]{16}");
    private static final Set<String> PLACES = Set.of("needs", "read", "records", "working", "all");
    private static final Set<String> VIEWS = Set.of("week", "people");
    private static final Set<String> TYPES = Set.of("pdf", "image", "docx", "xlsx", "pptx", "text", "other");
    private static final Set<String> EFFECTS = Set.of("needs", "read", "records", "ask");

    private final DocsModule module;

    DocsMethods(DocsModule module) {
        this.module = module;
    }

    private Docs docs() {
        return module.engine();
    }

    private DocsStore store() {
        return module.store();
    }

    // ---------------------------------------------------------------- params

    /** An {@link RpcException} out of a store's lambda, which may throw only SQLException; unwrapped by the module. */
    static final class Wrapped extends RuntimeException {
        private static final long serialVersionUID = 1L;
        final transient RpcException rpc;

        Wrapped(RpcException rpc) {
            super(rpc.getMessage(), null, false, false);
            this.rpc = rpc;
        }
    }

    static void only(Map<String, Object> p, Set<String> keys) throws RpcException {
        for (String k : p.keySet()) {
            if (!keys.contains(k)) {
                throw bad(k.length() <= 32 && k.matches("[A-Za-z_]+") ? k : "params");
            }
        }
    }

    static RpcException bad(String reason) {
        return new RpcException(RpcException.BAD_REQUEST, "Bad params", Map.of("reason", reason));
    }

    static RpcException notFound() {
        return new RpcException(RpcException.NOT_FOUND, "No such document", Map.of("reason", "doc"));
    }

    static String id(Map<String, Object> p, String key, String prefix) throws RpcException {
        if (!(p.get(key) instanceof String s) || !DocsStore.validId(s, prefix)) {
            throw bad(key);
        }
        return s;
    }

    static int intIn(Map<String, Object> p, String key, int min, int max, int dflt) throws RpcException {
        Object o = p.get(key);
        if (o == null) {
            return dflt;
        }
        if (!(o instanceof Number n) || n.doubleValue() != n.intValue() || n.intValue() < min || n.intValue() > max) {
            throw bad(key);
        }
        return n.intValue();
    }

    static String oneOf(Map<String, Object> p, String key, Set<String> allowed, String dflt) throws RpcException {
        Object o = p.get(key);
        if (o == null) {
            return dflt;
        }
        if (!(o instanceof String s) || !allowed.contains(s)) {
            throw bad(key);
        }
        return s;
    }

    private Doc doc(String id) throws SQLException, RpcException {
        Doc d = store().doc(id);
        if (d == null) {
            throw notFound();
        }
        return d;
    }

    // ---------------------------------------------------------------- reads

    Object list(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("place", "view", "person", "cursor", "limit"));
        String place = oneOf(p, "place", PLACES, "needs");
        String view = oneOf(p, "view", VIEWS, null);
        String person = null;
        if (p.get("person") != null) {
            if (!(p.get("person") instanceof String s) || !PERSON.matcher(s).matches()) {
                throw bad("person");
            }
            person = s;
        }
        int offset = 0;
        if (p.get("cursor") != null) {
            if (!(p.get("cursor") instanceof String s) || !s.matches("\\d{1,6}")) {
                throw bad("cursor");
            }
            offset = Integer.parseInt(s);
        }
        int limit = intIn(p, "limit", 1, 100, 50);
        Docs.Page page = docs().list(place, view, person, offset, limit);
        List<Map<String, Object>> items = store().db().read(conn -> {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Doc d : page.docs()) {
                out.add(docs().wire(conn, d));
            }
            return out;
        });
        Map<String, Object> counts = docs().counts();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", items);
        out.put("counts", counts);
        out.put("cursor", page.more() ? Integer.toString(offset + limit) : null);
        out.put("more", page.more());
        out.put("end", !page.more() && ("needs".equals(place) || "read".equals(place)) ? Words.END : null);
        if ("needs".equals(place) && offset == 0) {
            // What's about to be shown: the reader may read the few without a summary (option A), off this call's path.
            List<Doc> shown = page.docs();
            Thread.ofVirtual().start(() -> docs().readAboutToShow(shown, false));
        }
        return out;
    }

    Object get(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id"));
        String id = id(p, "id", "d_");
        Map<String, Object> out = store().db().read(conn -> {
            Doc d = DocsStore.doc(conn, id);
            if (d == null) {
                return null;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("doc", docs().wire(conn, d));
            List<Map<String, Object>> copies = new ArrayList<>();
            List<String> places = new ArrayList<>();
            for (DocsStore.Copy k : DocsStore.copies(conn, id)) {
                Map<String, Object> km = new LinkedHashMap<>();
                km.put("id", k.id());
                km.put("sourceKind", k.sourceKind());
                km.put("label", k.label());
                km.put("arrivedAt", k.arrivedAt());
                km.put("gone", k.gone());
                String path = Intake.path(k.sourceRef());
                if (path != null) {
                    km.put("path", path);
                }
                copies.add(km);
                if (!k.gone()) {
                    places.add(switch (k.sourceKind()) {
                        case "courier" -> "Mail";
                        case "downloads" -> "Downloads";
                        case "notebook" -> "Notebook";
                        case "writeup" -> "Write-ups";
                        default -> "Files";
                    });
                }
            }
            m.put("copies", copies);
            m.put("copiesText", places.size() > 1 ? Words.copies(places) : null);
            List<Map<String, Object>> versions = new ArrayList<>();
            for (DocsStore.Version v : DocsStore.versions(conn, id)) {
                Map<String, Object> vm = new LinkedHashMap<>();
                vm.put("id", v.id());
                vm.put("sha256", v.sha256());
                vm.put("at", v.at());
                vm.put("by", v.by());
                vm.put("byName", v.byName());
                vm.put("milestone", v.milestone());
                vm.put("milestoneText", milestoneText(v));
                vm.put("pagesChanged", Docs.pagesOf(v.pagesChanged()));
                vm.put("current", v.sha256().equals(d.sha256));
                vm.put("restorable", !v.sha256().equals(d.sha256) && docs().versions.has(v.sha256()));
                versions.add(vm);
            }
            m.put("versions", versions);
            m.put("links", DocsStore.links(conn, id));
            m.put("alsoIn", DocsStore.links(conn, id));
            List<Map<String, Object>> qs = new ArrayList<>();
            for (DocsStore.Question q : DocsStore.openQuestions(conn)) {
                if (q.docIds().contains(id)) {
                    qs.add(questionWire(q));
                }
            }
            m.put("questions", qs);
            return m;
        });
        if (out == null) {
            throw notFound();
        }
        return out;
    }

    static String milestoneText(DocsStore.Version v) {
        if (v.milestone() == null) {
            return null;
        }
        String who = v.milestoneArg() == null ? "someone" : v.milestoneArg();
        return switch (v.milestone()) {
            case "received" -> "Received from " + who;
            case "edited" -> "Edited by " + who;
            case "before" -> "Before " + who + "'s edit";
            case "signed" -> "Signed";
            case "approved" -> "Approved";
            case "restored" -> "Restored";
            default -> null;
        };
    }

    Object search(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("q", "person", "personName", "from", "to", "kind", "type", "inText", "limit"));
        Docs.Query q = query(p);
        int limit = intIn(p, "limit", 1, 50, 20);
        List<Map.Entry<Doc, Boolean>> hits = docs().search(q, limit + 1);
        List<Map<String, Object>> items = store().db().read(conn -> {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Map.Entry<Doc, Boolean> h : hits.subList(0, Math.min(limit, hits.size()))) {
                Map<String, Object> w = docs().wire(conn, h.getKey());
                w.put("matchedText", h.getValue());
                out.add(w);
            }
            return out;
        });
        return Map.of("items", items, "more", hits.size() > limit);
    }

    static Docs.Query query(Map<String, Object> p) throws RpcException {
        String words = null;
        if (p.get("q") != null) {
            if (!(p.get("q") instanceof String s) || !WORDS.matcher(s).matches()) {
                throw bad("q");
            }
            words = s;
        }
        List<String> people = new ArrayList<>();
        if (p.get("person") != null) {
            if (!(p.get("person") instanceof String s) || !PERSON.matcher(s).matches()) {
                throw bad("person");
            }
            people.add(s);
        }
        String personName = null;
        if (p.get("personName") != null) {
            if (!(p.get("personName") instanceof String s) || s.length() > 60 || s.isBlank()) {
                throw bad("personName");
            }
            personName = s;
        }
        Long from = time(p, "from");
        Long to = time(p, "to");
        String kind = null;
        if (p.get("kind") != null) {
            if (!(p.get("kind") instanceof String s) || !s.matches("[a-z]{2,20}")) {
                throw bad("kind");
            }
            kind = s;
        }
        String type = oneOf(p, "type", TYPES, null);
        boolean inText = Boolean.TRUE.equals(p.get("inText"));
        if (p.get("inText") != null && !(p.get("inText") instanceof Boolean)) {
            throw bad("inText");
        }
        return new Docs.Query(words, people, personName, from, to, kind, type, inText);
    }

    private static Long time(Map<String, Object> p, String key) throws RpcException {
        Object o = p.get(key);
        if (o == null) {
            return null;
        }
        if (!(o instanceof Number n) || n.longValue() < 0 || n.longValue() > 4_102_444_800_000L || n.doubleValue() != n.longValue()) {
            throw bad(key);
        }
        return n.longValue();
    }

    Object byPath(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("path", "writeup"));
        if (p.get("writeup") != null) {
            // A write-up by its id (the decision tray's material): the document its copy `w:<id>` belongs to.
            if (p.containsKey("path") || !(p.get("writeup") instanceof String w) || !w.matches("wu-[a-z2-7]{20}")) {
                throw bad("writeup");
            }
            String found = store().db().read(conn -> {
                DocsStore.Copy k = DocsStore.copyByRef(conn, "w:" + w);
                return k == null || k.gone() ? null : k.docId();
            });
            if (found == null) {
                throw notFound();
            }
            return Map.of("id", found);
        }
        if (!(p.get("path") instanceof String path) || path.isEmpty() || path.length() > 4096) {
            throw bad("path");
        }
        String docId = store().db().read(conn -> {
            DocsStore.Copy k = DocsStore.copyByRef(conn, Intake.ref(path));
            return k == null || k.gone() ? null : k.docId();
        });
        if (docId == null) {
            // Not indexed yet: index it now, then answer.
            module.intake().indexFile(path, false);
            docId = store().db().read(conn -> {
                DocsStore.Copy k = DocsStore.copyByRef(conn, Intake.ref(path));
                return k == null || k.gone() ? null : k.docId();
            });
        }
        if (docId == null) {
            throw notFound();
        }
        return Map.of("id", docId);
    }

    Object text(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id", "version"));
        Doc d = doc(id(p, "id", "d_"));
        refuseDanger(d);
        String sha = version(p, d);
        DocText t = store().text(sha);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("type", d.type);
        if (t == null) {
            if ("pending".equals(d.parseState)) {
                throw new RpcException(RpcException.UNAVAILABLE, "The desk can't read it yet", Map.of("reason", "sandbox"));
            }
            out.put("pages", List.of());
            out.put("unread", d.parseState.startsWith("refused:") ? d.parseState.substring(8) : "no_text");
            return out;
        }
        Map<String, Object> w = t.wire(false);
        out.putAll(capChars(w, 200_000));
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> capChars(Map<String, Object> w, int max) {
        int[] left = {max};
        for (String key : List.of("pages", "sections")) {
            if (w.get(key) instanceof List<?> l) {
                for (Object o : l) {
                    Map<String, Object> m = (Map<String, Object>) o;
                    String text = (String) m.get("text");
                    if (text != null) {
                        if (text.length() > left[0]) {
                            m.put("text", text.substring(0, Math.max(0, left[0])));
                        }
                        left[0] -= Math.min(left[0], text.length());
                    }
                }
            }
        }
        return w;
    }

    private String version(Map<String, Object> p, Doc d) throws RpcException, SQLException {
        if (p.get("version") == null) {
            return d.sha256;
        }
        String vid = id(p, "version", "v_");
        String sha = store().db().read(conn -> Sql.stringOne(conn, "SELECT sha256 FROM versions WHERE id = ? AND doc_id = ?", vid, d.id));
        if (sha == null) {
            throw new RpcException(RpcException.NOT_FOUND, "No such version", Map.of("reason", "version"));
        }
        return sha;
    }

    private static void refuseDanger(Doc d) throws RpcException {
        if (d.gone) {
            // Its last copy left (the trash, a deleted mail): nothing of it is drawn or read any more (DOC-L5).
            throw notFound();
        }
        if (d.danger != null) {
            throw new RpcException(RpcException.FORBIDDEN, "Maia won\u2019t open this", Map.of("reason", "danger", "danger", d.danger));
        }
    }

    Object page(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id", "page", "width", "version"));
        Doc d = doc(id(p, "id", "d_"));
        refuseDanger(d);
        int page = intIn(p, "page", 1, 500, 1);
        int width = intIn(p, "width", 200, 1600, 800);
        if (!"pdf".equals(d.type) && !"image".equals(d.type)) {
            throw new RpcException(RpcException.BAD_REQUEST, "No pages to draw", Map.of("reason", "unsupported"));
        }
        String sha = version(p, d);
        module.refusePaused();
        DocsSandbox.Image image = docs().cache.get(sha, page, width);
        if (image == null) {
            byte[] bytes;
            try {
                bytes = docs().bytesOf(d, sha);
            } catch (IOException e) {
                throw new RpcException(RpcException.NOT_FOUND, "The document's bytes are gone", Map.of("reason", "gone"));
            }
            try {
                if ("image".equals(d.type)) {
                    if (page != 1) {
                        throw new RpcException(RpcException.NOT_FOUND, "No such page", Map.of("reason", "page"));
                    }
                    image = docs().sandbox().image(bytes);
                } else {
                    image = docs().sandbox().render(bytes, page, width);
                }
            } catch (DocsSandbox.Unavailable e) {
                throw new RpcException(RpcException.UNAVAILABLE, "The desk can't draw it now", Map.of("reason", "sandbox"));
            } catch (DocsSandbox.Refused e) {
                if ("not_found".equals(e.reason())) {
                    throw new RpcException(RpcException.NOT_FOUND, "No such page", Map.of("reason", "page"));
                }
                throw new RpcException(RpcException.BAD_REQUEST, "The desk won't draw it", Map.of("reason", e.reason()));
            }
            docs().cache.put(sha, page, width, image);
        }
        List<Map<String, Object>> lines = lines(d, sha, page);
        Transfer transfer = module.transfers().reserve(c.principal().sessionId());
        DocsModule.MemoryBody body = new DocsModule.MemoryBody(image.bytes(), d.changedAt);
        if (!transfer.attach(body)) {
            transfer.stop();
            throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
        }
        c.afterReply(transfer::start, transfer::stop);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("transferId", transfer.id());
        out.put("size", body.size());
        out.put("sha256", body.sha256());
        out.put("format", image.format());
        out.put("width", image.width());
        out.put("height", image.height());
        out.put("pageCount", d.pageCount == null ? 1 : d.pageCount);
        out.put("lines", lines);
        return out;
    }

    /** The page's line boxes, each marked if it changed since the version the member last saw (or the one before). */
    private List<Map<String, Object>> lines(Doc d, String sha, int page) throws SQLException {
        return store().db().read(conn -> {
            DocText now = DocsStore.text(conn, sha);
            if (now == null || page > now.pages().size()) {
                return List.<Map<String, Object>>of();
            }
            DocText.Page pg = now.pages().get(page - 1);
            Set<Integer> changed = Set.of();
            String base = sha.equals(d.sha256) ? Docs.baseline(conn, d) : null;
            if (base != null) {
                DocText before = DocsStore.text(conn, base);
                if (before != null) {
                    changed = PageDiff.diff(before, now).lines().getOrDefault(pg.n(), Set.of());
                }
            }
            List<Map<String, Object>> out = new ArrayList<>();
            for (int i = 0; i < pg.lines().size(); i++) {
                DocText.Line l = pg.lines().get(i);
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("b", List.of(l.x(), l.y(), l.w(), l.h()));
                m.put("changed", changed.contains(i));
                out.add(m);
            }
            return out;
        });
    }

    Object pageStop(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("transferId"));
        int id = intIn(p, "transferId", 1, Integer.MAX_VALUE, 1);
        module.transfers().stop(c.principal().sessionId(), id);
        return Map.of();
    }

    Object changes(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id", "from", "to"));
        Doc d = doc(id(p, "id", "d_"));
        refuseDanger(d);
        return store().db().read(conn -> {
            String to = d.sha256;
            String from = Docs.baseline(conn, d);
            if (p.get("from") != null || p.get("to") != null) {
                Map<String, String> byId = new LinkedHashMap<>();
                for (DocsStore.Version v : DocsStore.versions(conn, d.id)) {
                    byId.put(v.id(), v.sha256());
                }
                if (p.get("from") != null) {
                    from = byId.get(String.valueOf(p.get("from")));
                    if (from == null) {
                        throw new Wrapped(bad("from"));
                    }
                }
                if (p.get("to") != null) {
                    to = byId.get(String.valueOf(p.get("to")));
                    if (to == null) {
                        throw new Wrapped(bad("to"));
                    }
                }
            }
            Map<String, Object> out = new LinkedHashMap<>();
            if (from == null) {
                out.put("pages", List.of());
                out.put("line", "This is the first version.");
                return out;
            }
            DocText a = DocsStore.text(conn, from);
            DocText b = DocsStore.text(conn, to);
            if (a == null || b == null) {
                out.put("pages", List.of());
                out.put("line", "The desk can\u2019t compare these versions.");
                return out;
            }
            PageDiff.Result r = PageDiff.diff(a, b);
            out.put("pages", r.pages());
            out.put("line", b.pages().isEmpty() ? (r.sections().isEmpty() ? "Nothing changed" : r.sections().size() == 1
                    ? "1 paragraph changed" : r.sections().size() + " paragraphs changed") : Words.pages(r.pages()));
            if (!r.sections().isEmpty()) {
                out.put("paragraphs", r.sections());
            }
            Map<String, Object> s = DocsStore.summary(conn, to);
            if (s != null && s.get("changeLine") instanceof String cl) {
                out.put("changeLine", cl);
            }
            return out;
        });
    }

    Object questions(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of());
        List<Map<String, Object>> qs = store().db().read(conn -> {
            List<Map<String, Object>> out = new ArrayList<>();
            for (DocsStore.Question q : DocsStore.openQuestions(conn)) {
                out.add(questionWire(q));
            }
            return out;
        });
        // The first sort, once: "I sorted 312 documents. 4 might need you."
        String first = store().meta("first.sort");
        if (first != null && store().meta("first.sort.told") == null) {
            Map<String, Object> counts = docs().counts();
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("id", "q_firstsort");
            f.put("kind", "firstsort");
            long k = ((Number) counts.get("needs")).longValue() + ((Number) counts.get("maybe")).longValue();
            f.put("text", "I sorted " + first + " documents. " + (k == 0 ? "None of them need you." : k + (k == 1 ? " might need you." : " might need you.")));
            f.put("choices", List.of(Map.of("id", "show", "label", "Show me"), Map.of("id", "later", "label", "Later")));
            f.put("docIds", List.of());
            qs.add(0, f);
        }
        return Map.of("questions", qs);
    }

    static Map<String, Object> questionWire(DocsStore.Question q) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", q.id());
        m.put("kind", q.kind());
        String who = String.valueOf(q.args().getOrDefault("who", "someone"));
        String kind = String.valueOf(q.args().getOrDefault("kind", "document"));
        switch (q.kind()) {
            case "file" -> {
                m.put("text", "New from " + who + ": " + article(kind) + " " + kind + ". Where should these go?");
                m.put("choices", List.of(choice("needs", "Needs you"), choice("read", "Read later"), choice("records", "Records"),
                        choice("ask", "Ask me each time")));
            }
            case "near" -> {
                m.put("text", "This looks like " + q.args().getOrDefault("title", "another document") + ".");
                m.put("choices", List.of(choice("same", "Same document"), choice("newer", "Newer version"), choice("different", "Different")));
            }
            default -> {
                m.put("text", String.valueOf(q.args().getOrDefault("text", "")));
                m.put("choices", List.of(choice("yes", "Yes"), choice("no", "No")));
            }
        }
        m.put("docIds", q.docIds());
        return m;
    }

    private static String article(String w) {
        return w.matches("(?i)[aeiou].*") ? "an" : "a";
    }

    private static Map<String, Object> choice(String id, String label) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("label", label);
        return m;
    }

    Object rules(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of());
        return store().db().read(conn -> {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Object[] r : Sql.list(conn, "SELECT id, person, person_name, domain, kind, source, effect, made_by, at FROM rules ORDER BY at",
                    rs -> new Object[] {rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5),
                            rs.getString(6), rs.getString(7), rs.getString(8), rs.getLong(9)})) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", r[0]);
                Map<String, Object> match = new LinkedHashMap<>();
                if (r[1] != null) {
                    match.put("person", r[1]);
                    match.put("personName", r[2]);
                }
                if (r[3] != null) {
                    match.put("domain", r[3]);
                }
                if (r[4] != null) {
                    match.put("kind", r[4]);
                }
                if (r[5] != null) {
                    match.put("source", r[5]);
                }
                m.put("match", match);
                m.put("effect", r[6]);
                m.put("madeBy", r[7]);
                m.put("at", r[8]);
                m.put("text", ruleText((String) r[2], (String) r[3], (String) r[4], (String) r[6]));
                out.add(m);
            }
            return Map.of("rules", out);
        });
    }

    static String ruleText(String personName, String domain, String kind, String effect) {
        String what = kind == null ? "Documents" : plural(kind);
        String from = personName != null ? " from " + personName : domain != null ? " from " + domain : "";
        String place = "ask".equals(effect) ? "Ask me each time" : Words.PLACE.getOrDefault(effect, "Records");
        return capitalise(what) + from + " → " + place;
    }

    static String plural(String kind) {
        return kind.endsWith("s") ? kind : kind + "s";
    }

    static String capitalise(String s) {
        return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    Object summary(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of());
        Map<String, Object> counts = docs().counts();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("counts", counts);
        out.put("needsYou", counts.get("needs"));
        out.put("maybe", counts.get("maybe"));
        out.put("held", counts.get("held"));
        out.put("keyId", docs().keys.keyId());
        out.put("indexing", module.intake() != null && !module.intake().firstIndexDone());
        String folded = store().meta("folded");
        if (folded != null) {
            out.put("folded", Integer.parseInt(folded));
        }
        return out;
    }

    /** What the shield takes from one desk (API.md §25 {@code docs.feed} with {@code front}). */
    static final int FRONT = 50;

    Object feed(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("since", "front"));
        if (p.get("front") != null && !(p.get("front") instanceof Boolean)) {
            throw bad("front");
        }
        if (Boolean.TRUE.equals(p.get("front"))) {
            if (p.get("since") != null) {
                throw bad("since");
            }
            return front();
        }
        long since = 0;
        if (p.get("since") != null) {
            if (!(p.get("since") instanceof Number n) || n.longValue() < 0) {
                throw bad("since");
            }
            since = n.longValue();
        }
        long from = since;
        return store().db().read(conn -> {
            List<Doc> rows = DocsStore.all(conn, "rev > ? ORDER BY rev LIMIT 201", from);
            List<Map<String, Object>> items = new ArrayList<>();
            for (Doc d : rows.subList(0, Math.min(200, rows.size()))) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", d.id);
                m.put("kind", d.kind);
                m.put("type", d.type);
                m.put("place", d.place);
                m.put("maybe", d.maybe);
                m.put("reason", d.reason);
                m.put("dueAt", d.dueAt);
                m.put("changedAt", d.changedAt);
                m.put("personKeys", d.fromKey == null ? List.of() : List.of(d.fromKey));
                m.put("links", Sql.list(conn, "SELECT kind || ':' || ref FROM links WHERE doc_id = ?", r -> r.getString(1), d.id));
                m.put("copies", Sql.longOne(conn, "SELECT COUNT(*) FROM copies WHERE doc_id = ? AND gone = 0", d.id));
                m.put("state", d.gone ? "gone" : d.state);
                m.put("rev", d.rev);
                items.add(m);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("rev", rows.isEmpty() ? from : rows.get(Math.min(199, rows.size() - 1)).rev);
            out.put("items", items);
            out.put("more", rows.size() > 200);
            return out;
        });
    }

    /**
     * The documents in front of the member now, for the office's {@code agent.maia.observe} ({@code desks[].docs}, the focus
     * shield): open Needs you and Maybe, new in Read later, and anything changed since they last opened it; never held, handled
     * or gone. Ids, places and times only (S0): never a title, a name, a reason's words or text.
     */
    Map<String, Object> front() throws SQLException {
        long now = module.clock().millis();
        return store().db().read(conn -> {
            List<Doc> rows = DocsStore.all(conn, Docs.VISIBLE + " AND state <> 'handled' AND (held_until IS NULL OR held_until <= ?)"
                    + " AND (place = 'needs' OR (place = 'read' AND state = 'new')"
                    + " OR (last_seen_sha IS NOT NULL AND last_seen_sha <> sha256))"
                    + " ORDER BY (place <> 'needs'), maybe, changed_at DESC, id LIMIT ?", now, FRONT + 1);
            List<Map<String, Object>> items = new ArrayList<>();
            for (Doc d : rows.subList(0, Math.min(FRONT, rows.size()))) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("docId", d.id);
                m.put("place", Places.NEEDS.equals(d.place) ? d.maybe ? "maybe" : "needs_you"
                        : Places.READ.equals(d.place) ? "read_later" : Places.RECORDS.equals(d.place) ? "records" : "working");
                m.put("dueAt", d.dueAt);
                m.put("changed", d.lastSeenSha != null && !d.lastSeenSha.equals(d.sha256));
                m.put("at", d.changedAt);
                // What it goes with (the shield's "close to what's open"): Courier's contact and channel, the agent. Ids only.
                if (d.contactId != null) {
                    m.put("contactIds", List.of(d.contactId));
                }
                if (d.channelId != null) {
                    m.put("channelId", d.channelId);
                }
                if (d.agentId != null) {
                    m.put("agentId", d.agentId);
                }
                items.add(m);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("items", items);
            out.put("more", rows.size() > FRONT);
            return out;
        });
    }

    // ---------------------------------------------------------------- tidy

    record Tidy(List<Object[]> items, int copies, int downloads, int drafts, long bytes) {}

    Tidy tidyItems(Connection conn) throws SQLException {
        long now = module.clock().millis();
        List<Object[]> items = new ArrayList<>();
        int copies = 0;
        int downloads = 0;
        int drafts = 0;
        long bytes = 0;
        Set<String> linked = new HashSet<>(Sql.list(conn, "SELECT DISTINCT doc_id FROM links WHERE kind IN ('todo', 'project')", r -> r.getString(1)));
        for (Doc d : DocsStore.all(conn, "gone = 0 AND (last_seen_at IS NULL OR last_seen_at < ?)", now - 30 * Docs.DAY)) {
            if (linked.contains(d.id)) {
                continue;
            }
            List<DocsStore.Copy> ks = DocsStore.copies(conn, d.id);
            List<DocsStore.Copy> live = ks.stream().filter(k -> !k.gone()).toList();
            boolean ownPlace = live.stream().anyMatch(k -> "files".equals(k.sourceKind()) && !k.label().startsWith("Saved from"));
            boolean milestone = Sql.longOne(conn, "SELECT 1 FROM versions WHERE doc_id = ? AND milestone IS NOT NULL AND milestone <> 'received' LIMIT 1",
                    d.id) != null;
            if (milestone) {
                continue;
            }
            // Extra exact copies, where the stack keeps one in the member's own place.
            if (ownPlace && live.size() > 1) {
                boolean keptOne = false;
                for (DocsStore.Copy k : live) {
                    if (!keptOne && "files".equals(k.sourceKind()) && !k.label().startsWith("Saved from")) {
                        keptOne = true;
                        continue;
                    }
                    if (Intake.path(k.sourceRef()) != null) {
                        items.add(new Object[] {d.id, k.id(), k.label(), k.size() == null ? d.size : k.size()});
                        copies++;
                        bytes += k.size() == null ? d.size : k.size();
                    }
                }
            }
            // Downloads never opened after 30 days.
            if ("download".equals(d.kind) && d.lastSeenAt == null && now - d.arrivedAt > 30 * Docs.DAY && live.size() == 1) {
                DocsStore.Copy k = live.get(0);
                items.add(new Object[] {d.id, k.id(), k.label(), d.size});
                downloads++;
                bytes += d.size;
            }
        }
        return new Tidy(items, copies, downloads, drafts, bytes);
    }

    Object tidyPreview(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of());
        Tidy t = store().db().read(this::tidyItems);
        List<Map<String, Object>> items = new ArrayList<>();
        for (Object[] i : t.items()) {
            items.add(Map.of("id", i[0], "copyId", i[1], "label", i[2], "size", i[3]));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("copies", t.copies());
        out.put("downloads", t.downloads());
        out.put("drafts", t.drafts());
        out.put("bytes", t.bytes());
        out.put("items", items);
        if (!items.isEmpty()) {
            out.put("text", "Tidy up? " + t.copies() + " extra " + (t.copies() == 1 ? "copy" : "copies") + " and " + t.downloads()
                    + " downloads you haven't opened (" + size(t.bytes()) + "). They go to the trash for 30 days.");
        }
        return out;
    }

    static String size(long b) {
        if (b < 1024 * 1024) {
            return Math.max(1, b / 1024) + " KB";
        }
        return (b / (1024 * 1024)) + " MB";
    }

    Object tidyApply(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of());
        Tidy t = store().db().read(this::tidyItems);
        c.beginEffect();
        int moved = 0;
        List<String> trashed = new ArrayList<>();
        for (Object[] i : t.items()) {
            String copyId = (String) i[1];
            String ref = store().db().read(conn -> Sql.stringOne(conn, "SELECT source_ref FROM copies WHERE id = ?", copyId));
            String path = ref == null ? null : Intake.path(ref);
            if (path == null) {
                continue;
            }
            try {
                com.minimalistalliance.desk.deskd.files.DocsFiles f = filesOrNull();
                if (f == null) {
                    break;
                }
                f.files().trash(path);
                docs().gone(ref);
                trashed.add(path);
                moved++;
            } catch (com.minimalistalliance.desk.deskd.files.AgentFiles.Refusal e) {
                // Changed or gone meanwhile: left where it is.
            }
        }
        String token = store().db().transaction(conn -> DocsStore.putUndo(conn, Map.of("kind", "tidy", "paths", trashed),
                module.clock().millis()));
        module.audit("docs.tidy", "moved:" + moved);
        Map<String, Object> toast = new LinkedHashMap<>();
        toast.put("text", "Tidied. " + moved + (moved == 1 ? " item" : " items") + " in the trash for 30 days.");
        toast.put("undo", token);
        return Map.of("moved", moved, "toast", toast);
    }

    private com.minimalistalliance.desk.deskd.files.DocsFiles filesOrNull() {
        return module.filesAccess();
    }

    Object export(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of());
        return store().db().read(conn -> {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("rules", Sql.list(conn, "SELECT id, person, person_name, domain, kind, source, effect, made_by, at FROM rules", r -> {
                Map<String, Object> m = new LinkedHashMap<>();
                for (int i = 1; i <= 9; i++) {
                    m.put(r.getMetaData().getColumnLabel(i), r.getObject(i));
                }
                return m;
            }));
            out.put("links", Sql.list(conn, "SELECT doc_id, kind, ref, label, basis FROM links", r -> Map.of("docId", r.getString(1),
                    "kind", r.getString(2), "ref", r.getString(3), "basis", r.getString(5))));
            out.put("milestones", Sql.list(conn, "SELECT doc_id, sha256, at, milestone, milestone_arg FROM versions WHERE milestone IS NOT NULL",
                    r -> {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("docId", r.getString(1));
                        m.put("sha256", r.getString(2));
                        m.put("at", r.getLong(3));
                        m.put("milestone", r.getString(4));
                        m.put("by", r.getString(5));
                        return m;
                    }));
            out.put("summaries", Sql.list(conn, "SELECT sha256, json, at FROM summaries", r -> Map.of("sha256", r.getString(1),
                    "summary", DocsSandbox.Answers.object(r.getString(2)), "at", r.getLong(3))));
            out.put("projects", List.of());
            return out;
        });
    }

    // ---------------------------------------------------------------- mutations

    Object tap(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id", "chip"));
        String id = id(p, "id", "d_");
        String chip = oneOf(p, "chip", DocsModule.CHIPS, null);
        if (chip == null) {
            throw bad("chip");
        }
        Doc before = doc(id);
        c.beginEffect();
        long now = module.clock().millis();
        List<String> changed = new ArrayList<>();
        Map<String, Object> result = store().db().transaction(conn -> {
            Doc d = DocsStore.doc(conn, id);
            Map<String, Object> undo = new LinkedHashMap<>();
            undo.put("kind", "tap");
            undo.put("id", d.id);
            undo.put("place", d.place);
            undo.put("maybe", d.maybe);
            undo.put("reason", d.reason);
            undo.put("reasonArg", d.reasonArg);
            undo.put("state", d.state);
            undo.put("heldUntil", d.heldUntil);
            Map<String, Object> out = new LinkedHashMap<>();
            String kind = Places.kindOf(docs().facts(conn, d, false));
            String kindWord = kind == null ? "Documents" : capitalise(plural(kind));
            String who = d.fromName != null ? d.fromName : null;
            switch (chip) {
                case "not_now" -> {
                    d.heldUntil = docs().nextCatchUp(now);
                    out.put("text", "Held until " + clock(d.heldUntil));
                }
                case "done" -> {
                    d.state = "handled";
                    out.put("text", "Done");
                }
                default -> {
                    String effect = chip.equals("sooner") ? "needs" : "people".equals(d.lane) ? "read" : "records";
                    String ruleId = DocsStore.newId("r_", now);
                    String person = d.fromKey;
                    String domain = person == null ? d.fromDomain : null;
                    String source = person == null && domain == null && kind == null ? Places.sourceOf(d.kind) : null;
                    Sql.update(conn, "DELETE FROM rules WHERE coalesce(person, '') = coalesce(?, '') AND coalesce(domain, '') = coalesce(?, '')"
                            + " AND coalesce(kind, '') = coalesce(?, '') AND coalesce(source, '') = coalesce(?, '')", person, domain, kind, source);
                    Sql.update(conn, "INSERT INTO rules (id, person, person_name, domain, kind, source, effect, made_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, 'tap', ?)",
                            ruleId, person, who, domain, kind, source, effect, now);
                    undo.put("rule", ruleId);
                    String from = who != null ? " from " + who : d.fromDomain != null ? " from " + d.fromDomain : "";
                    out.put("text", chip.equals("sooner") ? kindWord + from + " go to Needs you now."
                            : "Not important: " + kindWord + from + " go to " + Words.PLACE.get(effect) + " now.");
                    Map<String, Object> rule = new LinkedHashMap<>();
                    rule.put("id", ruleId);
                    rule.put("effect", effect);
                    rule.put("text", ruleText(who, domain, kind, effect));
                    out.put("rule", rule);
                    module.audit("docs.rule", "rule:" + ruleId + " effect:" + effect);
                }
            }
            if (!chip.equals("not_now") && !chip.equals("done")) {
                DocsStore.save(conn, d);
                changed.addAll(docs().redecide(conn, d.fromKey != null ? "from_key = ?" : "id = ?", d.fromKey != null ? d.fromKey : d.id));
                d = DocsStore.doc(conn, id);
                if (!changed.contains(d.id)) {
                    docs().decide(conn, d, false, false);
                }
            }
            DocsStore.save(conn, d);
            changed.add(d.id);
            String token = DocsStore.putUndo(conn, undo, now);
            Map<String, Object> toast = new LinkedHashMap<>();
            toast.put("text", out.get("text"));
            toast.put("undo", token);
            Map<String, Object> res = new LinkedHashMap<>();
            res.put("doc", docs().wire(conn, d));
            if (out.get("rule") != null) {
                res.put("rule", out.get("rule"));
            }
            res.put("toast", toast);
            return res;
        });
        store().changed(changed);
        return result;
    }

    private String clock(long at) {
        return Instant.ofEpochMilli(at).atZone(docs().zone()).format(DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)).toLowerCase(Locale.ENGLISH);
    }

    Object undo(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("token"));
        if (!(p.get("token") instanceof String token) || !DocsStore.validId(token, "u_")) {
            throw bad("token");
        }
        c.beginEffect();
        long now = module.clock().millis();
        List<String> changed = new ArrayList<>();
        Object out = store().db().transaction(conn -> {
            Map<String, Object> u = DocsStore.takeUndo(conn, token, now);
            if (u == null) {
                throw new Wrapped(new RpcException(RpcException.NOT_FOUND, "Nothing to undo", Map.of("reason", "token")));
            }
            switch (String.valueOf(u.get("kind"))) {
                case "tap" -> {
                    if (u.get("rule") instanceof String rule) {
                        Sql.update(conn, "DELETE FROM rules WHERE id = ?", rule);
                    }
                    Doc d = DocsStore.doc(conn, (String) u.get("id"));
                    if (d == null) {
                        return Map.of();
                    }
                    if (d.fromKey != null) {
                        changed.addAll(docs().redecide(conn, "from_key = ?", d.fromKey));
                        d = DocsStore.doc(conn, d.id);
                    }
                    d.place = (String) u.get("place");
                    d.maybe = Boolean.TRUE.equals(u.get("maybe"));
                    d.reason = (String) u.get("reason");
                    d.reasonArg = (String) u.get("reasonArg");
                    d.state = (String) u.get("state");
                    d.heldUntil = u.get("heldUntil") instanceof Number n ? n.longValue() : null;
                    DocsStore.save(conn, d);
                    changed.add(d.id);
                    return Map.of("doc", docs().wire(conn, d));
                }
                case "restore", "rename", "tidy" -> {
                    return Map.of("pending", u);
                }
                default -> {
                    return Map.of();
                }
            }
        });
        // File moves are undone outside the store's transaction, through Files' own door.
        if (out instanceof Map<?, ?> m && m.get("pending") instanceof Map<?, ?> u) {
            out = undoFiles(u);
        }
        store().changed(changed);
        return out;
    }

    private Object undoFiles(Map<?, ?> u) throws Exception {
        com.minimalistalliance.desk.deskd.files.DocsFiles f = filesOrNull();
        if (f == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "Files can't be used", Map.of("reason", "files"));
        }
        switch (String.valueOf(u.get("kind"))) {
            case "rename" -> {
                try {
                    f.files().move((String) u.get("to"), (String) u.get("from"));
                } catch (com.minimalistalliance.desk.deskd.files.AgentFiles.Refusal e) {
                    throw new RpcException(RpcException.CONFLICT, "It changed meanwhile", Map.of("reason", e.word()));
                }
                module.intake().folderChanged(Intake.parent((String) u.get("from")));
                module.intake().folderChanged(Intake.parent((String) u.get("to")));
            }
            case "restore" -> {
                byte[] b = docs().versions.get((String) u.get("sha"));
                try {
                    f.files().write((String) u.get("path"), b, true,
                            new com.minimalistalliance.desk.deskd.files.AgentFiles.Expect((String) u.get("over")));
                } catch (com.minimalistalliance.desk.deskd.files.AgentFiles.Refusal e) {
                    throw new RpcException(RpcException.CONFLICT, "It changed meanwhile", Map.of("reason", e.word()));
                }
                module.intake().folderChanged(Intake.parent((String) u.get("path")));
            }
            default -> {
                return Map.of("undone", false, "note", "Restore them from Files' trash.");
            }
        }
        return Map.of("undone", true);
    }

    Object answer(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("questionId", "choice"));
        if (!(p.get("choice") instanceof String choice) || !choice.matches("[a-z]{2,12}")) {
            throw bad("choice");
        }
        if ("q_firstsort".equals(p.get("questionId"))) {
            c.beginEffect();
            store().meta("first.sort.told", choice);
            return Map.of();
        }
        String qid = id(p, "questionId", "q_");
        c.beginEffect();
        long now = module.clock().millis();
        List<String> changed = new ArrayList<>();
        Object out = store().db().transaction(conn -> {
            DocsStore.Question q = Sql.one(conn, "SELECT * FROM questions WHERE id = ?", DocsStore::questionOf, qid);
            if (q == null || q.answered() != null) {
                throw new Wrapped(new RpcException(RpcException.NOT_FOUND, "No such question", Map.of("reason", "question")));
            }
            Sql.update(conn, "UPDATE questions SET answered = ? WHERE id = ?", choice, qid);
            Map<String, Object> res = new LinkedHashMap<>();
            switch (q.kind()) {
                case "file" -> {
                    if (!EFFECTS.contains(choice)) {
                        throw new Wrapped(bad("choice"));
                    }
                    String person = (String) q.args().get("person");
                    String kind = (String) q.args().get("kind");
                    String ruleId = DocsStore.newId("r_", now);
                    Sql.update(conn, "INSERT INTO rules (id, person, person_name, domain, kind, source, effect, made_by, at) VALUES (?, ?, ?, NULL, ?, NULL, ?, 'answer', ?)",
                            ruleId, person, q.args().get("who"), kind, choice, now);
                    changed.addAll(docs().redecide(conn, "from_key = ?", person));
                    res.put("rule", Map.of("id", ruleId, "effect", choice, "text", ruleText((String) q.args().get("who"), null, kind, choice)));
                }
                case "near" -> {
                    if (q.docIds().size() == 2 && ("same".equals(choice) || "newer".equals(choice))) {
                        // The older one's copies join the newer one's stack; its versions stay its own record.
                        Doc a = DocsStore.doc(conn, q.docIds().get(0));
                        Doc b = DocsStore.doc(conn, q.docIds().get(1));
                        if (a != null && b != null) {
                            Doc keep = a.changedAt >= b.changedAt ? a : b;
                            Doc fold = keep == a ? b : a;
                            Sql.update(conn, "UPDATE copies SET doc_id = ? WHERE doc_id = ?", keep.id, fold.id);
                            if ("newer".equals(choice)) {
                                Sql.update(conn, "UPDATE versions SET doc_id = ? WHERE doc_id = ?", keep.id, fold.id);
                            }
                            fold.gone = true;
                            DocsStore.save(conn, fold);
                            DocsStore.save(conn, keep);
                            changed.add(keep.id);
                            changed.add(fold.id);
                        }
                    }
                }
                default -> { }
            }
            module.audit("docs.rule", "question:" + qid + " choice:" + choice);
            return res;
        });
        store().changed(changed);
        return out;
    }

    Object ruleAdd(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("match", "effect"));
        String effect = oneOf(p, "effect", EFFECTS, null);
        if (effect == null || !(p.get("match") instanceof Map<?, ?> match)) {
            throw bad(effect == null ? "effect" : "match");
        }
        String person = match.get("person") instanceof String s && PERSON.matcher(s).matches() ? s : null;
        String personName = match.get("personName") instanceof String s && s.length() <= 60 ? s : null;
        String domain = match.get("domain") instanceof String s && s.matches("[a-z0-9.-]{3,253}") ? s : null;
        String kind = match.get("kind") instanceof String s && s.matches("[a-z]{2,20}") ? s : null;
        String source = match.get("source") instanceof String s && Set.of("files", "downloads", "courier", "notebook", "writeup").contains(s) ? s : null;
        if (person == null && domain == null && kind == null && source == null) {
            throw bad("match");
        }
        c.beginEffect();
        long now = module.clock().millis();
        List<String> changed = new ArrayList<>();
        Object out = store().db().transaction(conn -> {
            String ruleId = DocsStore.newId("r_", now);
            Sql.update(conn, "INSERT INTO rules (id, person, person_name, domain, kind, source, effect, made_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, 'member', ?)",
                    ruleId, person, personName, domain, kind, source, effect, now);
            changed.addAll(docs().redecide(conn, "1 = 1"));
            module.audit("docs.rule", "rule:" + ruleId + " effect:" + effect);
            return Map.of("rule", Map.of("id", ruleId, "effect", effect, "text", ruleText(personName, domain, kind, effect)));
        });
        store().changed(changed);
        return out;
    }

    Object ruleRemove(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id"));
        String id = id(p, "id", "r_");
        c.beginEffect();
        List<String> changed = new ArrayList<>();
        store().db().transaction(conn -> {
            Sql.update(conn, "DELETE FROM rules WHERE id = ?", id);
            changed.addAll(docs().redecide(conn, "1 = 1"));
            return null;
        });
        module.audit("docs.rule", "rule:" + id + " effect:removed");
        store().changed(changed);
        return Map.of();
    }

    Object seen(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id", "page", "ms"));
        String id = id(p, "id", "d_");
        int page = intIn(p, "page", 1, 500, 0);
        int ms = intIn(p, "ms", 0, 86_400_000, 0);
        c.beginEffect();
        long now = module.clock().millis();
        List<String> changed = new ArrayList<>();
        store().db().transaction(conn -> {
            Doc d = DocsStore.doc(conn, id);
            if (d == null) {
                throw new Wrapped(notFound());
            }
            if ("new".equals(d.state)) {
                d.state = "seen";
            }
            d.lastSeenAt = now;
            d.lastSeenSha = d.sha256;
            if (page > 0) {
                d.lastPage = page;
            }
            d.seenMs += ms;
            if (Places.READ.equals(d.place) && d.seenMs >= 20_000) {
                d.place = Places.RECORDS;
                d.reason = "default";
                d.reasonArg = null;
            }
            if (Places.NEEDS.equals(d.place) && "changed".equals(d.reason)) {
                d.reason = d.fromName != null ? "from" : "default";
                d.reasonArg = d.fromName;
            }
            Sql.update(conn, "INSERT INTO seen (doc_id, at, ms, page) VALUES (?, ?, ?, ?)", id, now, ms, page > 0 ? page : null);
            DocsStore.save(conn, d);
            changed.add(d.id);
            return null;
        });
        store().changed(changed);
        return Map.of();
    }

    Object restore(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id", "version"));
        Doc d = doc(id(p, "id", "d_"));
        String vid = id(p, "version", "v_");
        String sha = store().db().read(conn -> Sql.stringOne(conn, "SELECT sha256 FROM versions WHERE id = ? AND doc_id = ?", vid, d.id));
        if (sha == null || !docs().versions.has(sha)) {
            throw new RpcException(RpcException.NOT_FOUND, "That version isn't kept", Map.of("reason", "version"));
        }
        String path = store().db().read(conn -> {
            for (DocsStore.Copy k : DocsStore.copies(conn, d.id)) {
                if (!k.gone() && Intake.path(k.sourceRef()) != null && "files".equals(k.sourceKind())) {
                    return Intake.path(k.sourceRef());
                }
            }
            return null;
        });
        if (path == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "Only a file in Files can be restored", Map.of("reason", "source"));
        }
        com.minimalistalliance.desk.deskd.files.DocsFiles f = filesOrNull();
        if (f == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "Files can't be used", Map.of("reason", "files"));
        }
        byte[] bytes = docs().versions.get(sha);
        String current = d.sha256;
        c.beginEffect();
        try {
            // Only over the version the index holds: a file changed since is never overwritten.
            f.files().write(path, bytes, true, new com.minimalistalliance.desk.deskd.files.AgentFiles.Expect(current));
        } catch (com.minimalistalliance.desk.deskd.files.AgentFiles.Refusal e) {
            throw new RpcException(RpcException.CONFLICT, "The file changed meanwhile", Map.of("reason", e.word()));
        }
        module.intake().indexFile(path, false);
        long now = module.clock().millis();
        Object out = store().db().transaction(conn -> {
            Sql.update(conn, "UPDATE versions SET milestone = 'restored' WHERE id = (SELECT id FROM versions WHERE doc_id = ? ORDER BY at DESC, rowid DESC LIMIT 1)", d.id);
            String token = DocsStore.putUndo(conn, Map.of("kind", "restore", "path", path, "sha", current, "over", sha), now);
            Doc after = DocsStore.doc(conn, d.id);
            return Map.of("doc", docs().wire(conn, after), "toast", Map.of("text", "Restored. The newer one is kept as a version.", "undo", token));
        });
        module.audit("docs.restore", "doc:" + d.id);
        return out;
    }

    Object rename(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id"));
        Doc d = doc(id(p, "id", "d_"));
        String path = store().db().read(conn -> {
            for (DocsStore.Copy k : DocsStore.copies(conn, d.id)) {
                if (!k.gone() && Intake.path(k.sourceRef()) != null) {
                    return Intake.path(k.sourceRef());
                }
            }
            return null;
        });
        if (path == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "Only a file in Files can be renamed", Map.of("reason", "source"));
        }
        String to = Intake.join(Intake.parent(path), Titles.fileName(d.title, d.origName));
        if (to.equals(path)) {
            return Map.of("doc", store().db().read(conn -> docs().wire(conn, d)), "from", path, "to", to);
        }
        com.minimalistalliance.desk.deskd.files.DocsFiles f = filesOrNull();
        if (f == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "Files can't be used", Map.of("reason", "files"));
        }
        c.beginEffect();
        try {
            f.files().move(path, to);
        } catch (com.minimalistalliance.desk.deskd.files.AgentFiles.Refusal e) {
            throw new RpcException(RpcException.CONFLICT, "It can't be renamed now", Map.of("reason", e.word()));
        }
        long now = module.clock().millis();
        String token = store().db().transaction(conn -> {
            Sql.update(conn, "UPDATE copies SET source_ref = ? WHERE source_ref = ?", Intake.ref(to), Intake.ref(path));
            Sql.update(conn, "UPDATE docs SET renamed = 1, orig_name = ? WHERE id = ?", to.substring(to.lastIndexOf('/') + 1), d.id);
            return DocsStore.putUndo(conn, Map.of("kind", "rename", "from", path, "to", to), now);
        });
        module.audit("docs.rename", "doc:" + d.id);
        store().changed(List.of(d.id));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("doc", store().db().read(conn -> docs().wire(conn, DocsStore.doc(conn, d.id))));
        out.put("from", path);
        out.put("to", to);
        out.put("toast", Map.of("text", "Renamed.", "undo", token));
        return out;
    }

    /**
     * "What's this?" or "What changed" on a document with no reading yet: asks the reader once for its current version (a
     * tap, so outside the day's 15). The facts arrive on the topic; {@code asked} false when the reader can't run here.
     */
    Object read(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id"));
        Doc d = doc(id(p, "id", "d_"));
        refuseDanger(d);
        boolean have = store().db().read(conn -> Sql.longOne(conn, "SELECT 1 FROM summaries WHERE sha256 = ?", d.sha256) != null);
        if (have) {
            return Map.of("asked", false, "have", true);
        }
        boolean asked = docs().readNow(d);
        return Map.of("asked", asked, "have", false);
    }

    Object askAllow(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("id"));
        Doc d = doc(id(p, "id", "d_"));
        refuseDanger(d);
        c.beginEffect();
        module.allowAsk(d.id);
        return Map.of("until", module.clock().millis() + 600_000L);
    }

    /**
     * The person-key secret the office gave this desk, so a desk opened later can be given the same one: only a key the
     * office set ({@code shared}), never one this desk made for itself; with when it was first made, which decides between
     * two the office may have made at once (the earliest wins).
     */
    Object keyGet(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("keyId", docs().keys.keyId());
        String at = store().meta(KEY_AT);
        boolean shared = at != null && at.matches("\\d{1,19}");
        out.put("shared", shared);
        if (shared) {
            out.put("key", docs().keys.hex());
            out.put("at", Long.parseLong(at));
        }
        return out;
    }

    static final String KEY_AT = "key.shared.at";

    Object keySet(RpcContext c, Map<String, Object> p) throws Exception {
        only(p, Set.of("key", "at"));
        if (!(p.get("key") instanceof String key) || !key.matches("[0-9a-f]{64}")) {
            throw bad("key");
        }
        long now = module.clock().millis();
        long at = now;
        if (p.get("at") != null) {
            if (!(p.get("at") instanceof Number n) || n.longValue() <= 0 || n.longValue() > now + 86_400_000L) {
                throw bad("at");
            }
            at = n.longValue();
        }
        c.beginEffect();
        boolean changed = docs().keys.set(key);
        store().meta(KEY_AT, Long.toString(at));
        if (changed) {
            // Each attachment's sender is keyed again from Courier's own record (no bytes read), and their rules, let-through
            // row and questions follow the new key.
            module.rekey();
        }
        return Map.of("keyId", docs().keys.keyId(), "changed", changed);
    }
}
