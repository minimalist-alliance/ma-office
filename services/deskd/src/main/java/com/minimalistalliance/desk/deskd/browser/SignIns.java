package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.files.ImportFiles;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcHandler;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Signing in that works on the desk (docs/sub-status/desk-sign-ins.md, API.md section 10, "Signing in"): bring a
 * browser's passwords in straight from the member's browser and its bookmarks from Files, see the bookmarks, and open an
 * allowed password manager's own page from the Browser bar's key button, since a kiosk has no toolbar to press it in.
 *
 * <p><b>ADR 0035.</b> Only Chromium writes the profile. Passwords go into Chromium's own Password Manager through its own
 * {@code chrome.passwordsPrivate.addPassword}, bookmarks through its own {@code chrome.bookmarks}, in hidden pages of its
 * own ({@link ChromiumPages}). Nothing already there is replaced or removed: a password Chromium has for that site and
 * username stays as it is, and a bookmark Chromium has for that address isn't added again. So an import that's run twice,
 * or retried after a failure part way, adds only what's missing.
 *
 * <p><b>The passwords file</b> holds plain passwords, so it never touches a disk: it comes over the desk session into
 * deskd's memory ({@link PasswordUploads}: {@code browser.import.begin}, the bytes on {@code bulk}, then
 * {@code browser.import.finish}), and its bytes are zeroed once parsed, whatever happens. A snapshot of the desk's volumes
 * can't hold what was never on one. {@code browser.import} refuses passwords ({@code bad_request}, {@code reason:
 * use_upload}) and never reads or deletes a file in Files that looks like one. Nothing here logs a field of it, and the
 * reply names rows only by site and username.
 *
 * <p><b>Extensions.</b> Only {@link PasswordManagers}. deskd opens an extension's page in a tab of its own and never
 * attaches to it, reads it or runs anything in it: a {@code chrome-extension:} page is no tab of the member's to
 * {@link BrowserTabs}, so neither the tab list, the simplified view nor the Agent can reach one.
 *
 * <p>A teen's desk gets none of this ({@code forbidden}, {@code reason: age_band}): their policy turns every extension
 * off, and passwords stay where they are.
 */
public final class SignIns {

    private static final Logger log = LoggerFactory.getLogger(SignIns.class);

    /** What deskd needs of the tabs and the connection: {@link BrowserTabs#signInAccess}. */
    interface Chromium {
        /** @throws RpcException unavailable, {@code reason: chromium}, if Chromium can't be reached now */
        void requireReady() throws RpcException, InterruptedException;

        /** One command, on the browser itself (session null) or on a hidden page this opened. */
        Map<String, Object> call(String sessionId, String method, Map<String, Object> params, Duration timeout)
                throws CdpException, InterruptedException;

        Duration request();

        /** The ids of the tabs showing a page under this {@code chrome-extension://id/}, which deskd never attaches to. */
        List<String> pagesOf(String origin);

        /** The member's tab known to be on screen, or null. */
        String activeTabId();

        boolean isMemberTab(String tabId);

        int memberTabs();

        /** {@link BrowserTabs#open}: a member's tab at an address already through {@link BrowserUrl}. */
        String open(RpcContext context, String url) throws RpcException, InterruptedException;

        /** An empty tab, so closing the last other one doesn't end Chromium. */
        void openBlank() throws CdpException, InterruptedException;
    }

    /**
     * @param load what one of Chromium's own pages gets to load
     * @param batch what one batch of rows gets in Chromium
     */
    record Timing(Duration load, Duration batch, int passwordBatch, int bookmarkBatch) {
        static final Timing DEFAULT = new Timing(Duration.ofSeconds(5), Duration.ofSeconds(30), 100, 200);
    }

    static final String PASSWORDS = "passwords";
    static final String BOOKMARKS = "bookmarks";
    /** The folder imported bookmarks go in, under Other bookmarks, as Chromium's own import names it. */
    static final String IMPORTED = "Imported";
    /** Rows not added that a reply names, by site and username. */
    static final int MAX_NOT_ADDED = 100;
    static final int MAX_LIST_ITEMS = 200;
    private static final int MAX_OFFSET = 100_000;
    private static final int URL_BATCH = 500;
    private static final String AGE_BAND = "age_band";
    private static final Pattern BOOKMARK_ID = Pattern.compile("[0-9]{1,20}");

    /** 0 added, 1 Chromium has one for that site and username already (or refused it), 2 Chromium refused the address. */
    static final String ADD_PASSWORDS = """
            async function (rows) {
              const out = [];
              for (const r of rows) {
                let site = null;
                try { site = await chrome.passwordsPrivate.getUrlCollection(r.url); } catch (e) { site = null; }
                if (!site) { out.push(2); continue; }
                try {
                  await chrome.passwordsPrivate.addPassword(
                      {url: r.url, username: r.username, password: r.password, note: r.note, useAccountStore: false});
                  out.push(0);
                } catch (e) { out.push(1); }
              }
              return out;
            }""";

    /** For each address, whether Chromium has a bookmark of it anywhere. */
    static final String HAS_URLS = """
            async function (urls) {
              const out = [];
              for (const u of urls) {
                try { out.push((await chrome.bookmarks.search({url: u})).length > 0); } catch (e) { out.push(false); }
              }
              return out;
            }""";

    /** The id of the folder of this title under Other bookmarks, made if it isn't there. */
    static final String IMPORTED_FOLDER = """
            async function (title) {
              const roots = await chrome.bookmarks.getChildren('0');
              const other = roots.find(n => n.folderType === 'other') || roots[roots.length - 1];
              const kids = await chrome.bookmarks.getChildren(other.id);
              const found = kids.find(n => n.url === undefined && n.title === title);
              return found ? found.id : (await chrome.bookmarks.create({parentId: other.id, title})).id;
            }""";

    /** Folders and links in order: each op's parent is {@code p}, an id, or {@code i}, an earlier op of this batch. */
    static final String CREATE_BOOKMARKS = """
            async function (ops) {
              const made = [];
              for (const op of ops) {
                const parentId = op.p !== undefined ? op.p : made[op.i];
                let id = null;
                if (typeof parentId === 'string') {
                  try {
                    const node = await chrome.bookmarks.create(
                        op.u === undefined ? {parentId, title: op.t} : {parentId, title: op.t, url: op.u});
                    id = node.id;
                  } catch (e) { id = null; }
                }
                made.push(id);
              }
              return made;
            }""";

    /** One folder's children, a page of them. */
    static final String LIST_BOOKMARKS = """
            async function (id, offset, max) {
              let node;
              if (id === '0') {
                node = {id: '0', title: ''};
              } else {
                try { [node] = await chrome.bookmarks.get(id); } catch (e) { return {missing: true}; }
              }
              if (!node) return {missing: true};
              if (node.url !== undefined) return {notFolder: true};
              const kids = await chrome.bookmarks.getChildren(id);
              return {id: node.id, title: node.title, parentId: node.parentId === undefined ? null : node.parentId,
                      items: kids.slice(offset, offset + max).map(n => n.url === undefined
                          ? {id: n.id, title: n.title} : {id: n.id, title: n.title, url: n.url}),
                      more: kids.length > offset + max};
            }""";

    /** Of these ids, the ones Chromium has installed, with Chromium's word for their state. Nothing else of them. */
    static final String EXTENSION_STATES = """
            async function (ids) {
              const all = await chrome.developerPrivate.getExtensionsInfo({includeDisabled: true, includeTerminated: true});
              return all.filter(e => ids.includes(e.id)).map(e => [e.id, e.state]);
            }""";

    private final Chromium chromium;
    private final ChromiumPages pages;
    private final BrowserFreeze freeze;
    private final ImportFiles files;
    private final PasswordUploads uploads;
    private final Supplier<AgeBand.Band> band;
    private final PasswordManagers managers;
    private final Timing timing;
    /** The tab the member was on when an extension's page opened, by extension id, to go back to when it's closed. */
    private final Map<String, String> openers = new ConcurrentHashMap<>();

    SignIns(
            Chromium chromium,
            BrowserFreeze freeze,
            ImportFiles files,
            PasswordUploads uploads,
            Supplier<AgeBand.Band> band,
            PasswordManagers managers,
            Timing timing) {
        this.chromium = chromium;
        this.pages = new ChromiumPages(chromium, timing.load());
        this.freeze = freeze;
        this.files = files;
        this.uploads = uploads;
        this.band = band;
        this.managers = managers;
        this.timing = timing;
    }

    void register(RpcDispatcher dispatcher) {
        dispatcher.registerMutation("browser.import", working(this::importFile));
        // begin's effect is a transfer of this session, as files.upload.begin's is: a retry from another session runs again.
        dispatcher.registerSessionMutation("browser.import.begin", RpcDispatcher.OWNER_ONLY, working(this::importBegin));
        dispatcher.registerMutation("browser.import.finish", working(this::importFinish));
        dispatcher.registerMutation("browser.import.abort", this::importAbort);
        dispatcher.register("browser.bookmarks.list", working(this::bookmarksList));
        dispatcher.register("browser.extensions.list", working(this::extensionsList));
        dispatcher.registerMutation("browser.extension.open", working(this::extensionOpen));
        dispatcher.registerMutation("browser.extension.close", working(this::extensionClose));
    }

    private RpcHandler working(RpcHandler handler) {
        return BrowserMethods.working(freeze, handler);
    }

    /** Zeroes a passwords file still on its way in. Once, as deskd stops. */
    void close() {
        uploads.close();
    }

    // ---- browser.import

    private Object importFile(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        requireAdult();
        String kind = Json.string(params, "kind");
        if (!PASSWORDS.equals(kind) && !BOOKMARKS.equals(kind)) {
            throw badRequest("kind");
        }
        if (PASSWORDS.equals(kind)) {
            // A passwords file is never read from a disk, nor deleted from one: it comes in by browser.import.begin.
            throw badRequest("use_upload");
        }
        String path = Json.string(params, "path");
        if (path == null) {
            throw badRequest("path");
        }
        ImportFiles.Read read = files.read(path, BookmarksHtml.MAX_BYTES);
        BookmarksHtml.Parsed parsed = BookmarksHtml.parse(read.bytes());
        Map<String, Object> result = importBookmarks(context, parsed);
        log.info("browser.import bookmarks: links={} added={} alreadySaved={} refused={}",
                result.get("found"), result.get("added"), result.get("alreadySaved"), result.get("refused"));
        return result;
    }

    // ---- browser.import.begin, finish and abort: a passwords file, in memory only

    private Object importBegin(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        requireAdult();
        if (!PASSWORDS.equals(Json.string(params, "kind"))) {
            throw badRequest("kind");
        }
        Object rawSize = params.get("size");
        if (!(rawSize instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue()) || n.doubleValue() < 1) {
            throw badRequest("size");
        }
        if (n.doubleValue() > PasswordCsv.MAX_BYTES) {
            throw new RpcException(RpcException.TOO_LARGE, "The file is too large to import", Map.of("limit", PasswordCsv.MAX_BYTES));
        }
        // Chromium first, so the member's passwords don't travel for an import that can't run.
        chromium.requireReady();
        context.beginEffect();
        return uploads.begin(context.principal().sessionId(), n.intValue()).reply();
    }

    private Object importFinish(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        String sessionId = context.principal().sessionId();
        try {
            requireAdult();
        } catch (RpcException e) {
            uploads.abort(sessionId, params.get("uploadId"));
            throw e;
        }
        byte[] bytes = uploads.take(sessionId, params.get("uploadId"));
        PasswordCsv.Parsed parsed;
        try {
            parsed = PasswordCsv.parse(bytes);
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
        Map<String, Object> result = importPasswords(context, parsed);
        log.info("browser.import passwords: rows={} added={} alreadySaved={} refused={}",
                result.get("found"), result.get("added"), result.get("alreadySaved"), result.get("refused"));
        return result;
    }

    private Object importAbort(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        context.beginEffect();
        uploads.abort(context.principal().sessionId(), params.get("uploadId"));
        return Map.of();
    }

    private Map<String, Object> importPasswords(RpcContext context, PasswordCsv.Parsed parsed) throws RpcException, InterruptedException {
        List<Map<String, Object>> notAdded = new ArrayList<>();
        int refused = parsed.refused().size();
        for (PasswordCsv.Refused row : parsed.refused()) {
            noteNotAdded(notAdded, row.site(), row.username(), row.reason());
        }
        int added = 0;
        int saved = 0;
        if (!parsed.rows().isEmpty()) {
            chromium.requireReady();
            try (ChromiumPages.Page page = pages.open(ChromiumPages.Kind.PASSWORDS)) {
                context.beginEffect();
                List<PasswordCsv.Row> rows = parsed.rows();
                for (int start = 0; start < rows.size(); start += timing.passwordBatch()) {
                    List<PasswordCsv.Row> batch = rows.subList(start, Math.min(rows.size(), start + timing.passwordBatch()));
                    List<Map<String, Object>> arg = new ArrayList<>(batch.size());
                    for (PasswordCsv.Row row : batch) {
                        Map<String, Object> entry = new HashMap<>();
                        entry.put("url", row.url());
                        entry.put("username", row.username());
                        entry.put("password", row.password());
                        entry.put("note", row.note());
                        arg.add(entry);
                    }
                    List<?> codes = list(page.call(ADD_PASSWORDS, timing.batch(), arg), batch.size());
                    for (int k = 0; k < batch.size(); k++) {
                        int code = codes.get(k) instanceof Number n ? n.intValue() : 1;
                        PasswordCsv.Row row = batch.get(k);
                        if (code == 0) {
                            added++;
                        } else if (code == 2) {
                            refused++;
                            noteNotAdded(notAdded, PasswordCsv.siteOf(row.url()), TabText.clean(row.username(), 64), PasswordCsv.REFUSED_URL);
                        } else {
                            saved++;
                            noteNotAdded(notAdded, PasswordCsv.siteOf(row.url()), TabText.clean(row.username(), 64), "exists");
                        }
                    }
                }
            } catch (CdpException | ChromiumPages.Failed e) {
                throw unavailable();
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("kind", PASSWORDS);
        result.put("found", parsed.total());
        result.put("added", added);
        result.put("alreadySaved", saved);
        result.put("refused", refused);
        result.put("notAdded", notAdded);
        return result;
    }

    private static void noteNotAdded(List<Map<String, Object>> notAdded, String site, String username, String reason) {
        if (notAdded.size() >= MAX_NOT_ADDED) {
            return;
        }
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("site", site);
        row.put("username", username);
        row.put("reason", reason);
        notAdded.add(row);
    }

    private Map<String, Object> importBookmarks(RpcContext context, BookmarksHtml.Parsed parsed) throws RpcException, InterruptedException {
        List<BookmarksHtml.Node> nodes = parsed.nodes();
        int added = 0;
        int saved = 0;
        int failed = 0;
        String folderId = null;
        if (parsed.links() > 0) {
            chromium.requireReady();
            try (ChromiumPages.Page page = pages.open(ChromiumPages.Kind.BOOKMARKS)) {
                // Which addresses Chromium has already, anywhere: those aren't added again.
                List<Integer> linkAt = new ArrayList<>();
                for (int k = 0; k < nodes.size(); k++) {
                    if (!nodes.get(k).folder()) {
                        linkAt.add(k);
                    }
                }
                boolean[] have = new boolean[nodes.size()];
                for (int start = 0; start < linkAt.size(); start += URL_BATCH) {
                    List<Integer> batch = linkAt.subList(start, Math.min(linkAt.size(), start + URL_BATCH));
                    List<String> urls = new ArrayList<>(batch.size());
                    for (int at : batch) {
                        urls.add(nodes.get(at).url());
                    }
                    List<?> found = list(page.call(HAS_URLS, timing.batch(), urls), batch.size());
                    for (int k = 0; k < batch.size(); k++) {
                        have[batch.get(k)] = Boolean.TRUE.equals(found.get(k));
                    }
                }
                // Only folders with something new in them are made.
                boolean[] wanted = new boolean[nodes.size()];
                for (int at : linkAt) {
                    if (have[at]) {
                        saved++;
                        continue;
                    }
                    wanted[at] = true;
                    for (int up = nodes.get(at).parent(); up >= 0 && !wanted[up]; up = nodes.get(up).parent()) {
                        wanted[up] = true;
                    }
                }
                if (saved < linkAt.size()) {
                    context.beginEffect();
                    folderId = string(page.call(IMPORTED_FOLDER, timing.batch(), IMPORTED));
                    if (folderId == null || !BOOKMARK_ID.matcher(folderId).matches()) {
                        throw unavailable();
                    }
                    String[] ids = new String[nodes.size()];
                    List<Map<String, Object>> ops = new ArrayList<>();
                    List<Integer> opNodes = new ArrayList<>();
                    for (int k = 0; k <= nodes.size(); k++) {
                        boolean flush = k == nodes.size() || ops.size() >= timing.bookmarkBatch();
                        if (flush && !ops.isEmpty()) {
                            List<?> made = list(page.call(CREATE_BOOKMARKS, timing.batch(), new ArrayList<>(ops)), ops.size());
                            for (int m = 0; m < ops.size(); m++) {
                                String id = string(made.get(m));
                                int node = opNodes.get(m);
                                ids[node] = id != null && BOOKMARK_ID.matcher(id).matches() ? id : null;
                                if (!nodes.get(node).folder()) {
                                    if (ids[node] != null) {
                                        added++;
                                    } else {
                                        failed++;
                                    }
                                }
                            }
                            ops.clear();
                            opNodes.clear();
                        }
                        if (k == nodes.size() || !wanted[k]) {
                            continue;
                        }
                        BookmarksHtml.Node node = nodes.get(k);
                        Map<String, Object> op = new LinkedHashMap<>();
                        int parent = node.parent();
                        int inBatch = parent < 0 ? -1 : opNodes.indexOf(parent);
                        if (parent < 0) {
                            op.put("p", folderId);
                        } else if (inBatch >= 0) {
                            op.put("i", inBatch);
                        } else if (ids[parent] != null) {
                            op.put("p", ids[parent]);
                        } else {
                            // Its folder couldn't be made, so neither can it.
                            if (!node.folder()) {
                                failed++;
                            }
                            continue;
                        }
                        op.put("t", node.title());
                        if (!node.folder()) {
                            op.put("u", node.url());
                        }
                        ops.add(op);
                        opNodes.add(k);
                    }
                }
            } catch (CdpException | ChromiumPages.Failed e) {
                throw unavailable();
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("kind", BOOKMARKS);
        result.put("found", parsed.links() + parsed.refused());
        result.put("added", added);
        result.put("alreadySaved", saved);
        result.put("refused", parsed.refused() + failed);
        result.put("folderId", folderId);
        return result;
    }

    // ---- browser.bookmarks.list

    private Object bookmarksList(RpcContext context, Map<String, Object> params) throws Exception {
        requireVideo(context);
        requireAdult();
        Object rawId = params.get("folderId");
        if (rawId != null && !(rawId instanceof String s && BOOKMARK_ID.matcher(s).matches())) {
            throw badRequest("folderId");
        }
        String folderId = rawId == null ? "0" : (String) rawId;
        Object rawOffset = params.get("offset");
        int offset = 0;
        if (rawOffset != null) {
            if (!(rawOffset instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue()) || n.longValue() < 0 || n.longValue() > MAX_OFFSET) {
                throw badRequest("offset");
            }
            offset = n.intValue();
        }
        chromium.requireReady();
        Object value;
        try (ChromiumPages.Page page = pages.open(ChromiumPages.Kind.BOOKMARKS)) {
            value = page.call(LIST_BOOKMARKS, chromium.request(), folderId, offset, MAX_LIST_ITEMS);
        } catch (CdpException | ChromiumPages.Failed e) {
            throw unavailable();
        }
        if (!(value instanceof Map<?, ?> got)) {
            throw unavailable();
        }
        if (Boolean.TRUE.equals(got.get("missing"))) {
            throw new RpcException(RpcException.NOT_FOUND, "No such folder", Map.of("reason", "folder"));
        }
        if (Boolean.TRUE.equals(got.get("notFolder"))) {
            throw badRequest("folderId");
        }
        List<Map<String, Object>> items = new ArrayList<>();
        if (got.get("items") instanceof List<?> raw) {
            for (Object item : raw) {
                if (!(item instanceof Map<?, ?> entry) || !(entry.get("id") instanceof String id) || !BOOKMARK_ID.matcher(id).matches()) {
                    continue;
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("id", id);
                out.put("title", TabText.clean(entry.get("title") instanceof String t ? t : "", BrowserTabs.TITLE_CHARS));
                if (entry.get("url") instanceof String url) {
                    out.put("url", TabText.clean(url, BrowserTabs.URL_CHARS));
                }
                items.add(out);
                if (items.size() >= MAX_LIST_ITEMS) {
                    break;
                }
            }
        }
        Map<String, Object> folder = new LinkedHashMap<>();
        folder.put("id", folderId);
        folder.put("title", TabText.clean(got.get("title") instanceof String t ? t : "", BrowserTabs.TITLE_CHARS));
        folder.put("parentId", got.get("parentId") instanceof String p && BOOKMARK_ID.matcher(p).matches() ? p : null);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("folder", folder);
        result.put("items", items);
        result.put("more", Boolean.TRUE.equals(got.get("more")));
        return result;
    }

    // ---- the key button

    private Object extensionsList(RpcContext context, Map<String, Object> params) throws Exception {
        requireVideo(context);
        requireAdult();
        chromium.requireReady();
        Map<String, String> states = states();
        List<Map<String, Object>> extensions = new ArrayList<>();
        for (PasswordManagers.Manager manager : managers.all()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("id", manager.id());
            entry.put("name", manager.name());
            entry.put("state", states.getOrDefault(manager.id(), "missing"));
            entry.put("open", !chromium.pagesOf(manager.origin()).isEmpty());
            extensions.add(entry);
        }
        return Map.of("extensions", extensions);
    }

    /** {@code installed} or {@code off} for each allowed id Chromium has; one it hasn't isn't in the map. */
    private Map<String, String> states() throws RpcException, InterruptedException {
        Object value;
        try (ChromiumPages.Page page = pages.open(ChromiumPages.Kind.EXTENSIONS)) {
            value = page.call(EXTENSION_STATES, chromium.request(), managers.ids());
        } catch (CdpException | ChromiumPages.Failed e) {
            throw unavailable();
        }
        Map<String, String> states = new HashMap<>();
        if (value instanceof List<?> rows) {
            for (Object row : rows) {
                if (row instanceof List<?> pair && pair.size() == 2 && pair.get(0) instanceof String id && managers.get(id) != null) {
                    states.put(id, "ENABLED".equals(pair.get(1)) ? "installed" : "off");
                }
            }
        }
        return states;
    }

    private Object extensionOpen(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        requireAdult();
        PasswordManagers.Manager manager = manager(params);
        chromium.requireReady();
        List<String> open = chromium.pagesOf(manager.origin());
        if (!open.isEmpty()) {
            String tabId = open.get(0);
            context.beginEffect();
            try {
                chromium.call(null, "Target.activateTarget", Map.of("targetId", tabId), chromium.request());
            } catch (CdpException e) {
                throw unavailable();
            }
            return opened(tabId, "extension");
        }
        String state = states().getOrDefault(manager.id(), "missing");
        if ("missing".equals(state)) {
            // Not added yet: its Web Store page, where Add to Chromium is the member's own click.
            return opened(chromium.open(context, BrowserUrl.parse(manager.storeUrl())), "store");
        }
        if (!"installed".equals(state)) {
            throw new RpcException(RpcException.UNAVAILABLE, "The extension is turned off", Map.of("reason", "extension_off"));
        }
        String opener = chromium.activeTabId();
        context.beginEffect();
        String tabId;
        try {
            Map<String, Object> created =
                    chromium.call(null, "Target.createTarget", Map.of("url", manager.pageUrl()), chromium.request());
            tabId = Json.string(created, "targetId");
        } catch (CdpException e) {
            throw unavailable();
        }
        if (tabId == null || tabId.isEmpty()) {
            throw unavailable();
        }
        if (opener != null) {
            openers.put(manager.id(), opener);
        } else {
            openers.remove(manager.id());
        }
        return opened(tabId, "extension");
    }

    private static Map<String, Object> opened(String tabId, String page) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("tabId", tabId);
        result.put("page", page);
        return result;
    }

    private Object extensionClose(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        requireAdult();
        PasswordManagers.Manager manager = manager(params);
        chromium.requireReady();
        List<String> open = chromium.pagesOf(manager.origin());
        if (open.isEmpty()) {
            return Map.of("closed", 0);
        }
        context.beginEffect();
        int closed = 0;
        try {
            // A kiosk Chromium exits with its last tab.
            if (chromium.memberTabs() == 0) {
                chromium.openBlank();
            }
            String opener = openers.remove(manager.id());
            if (opener != null && chromium.isMemberTab(opener)) {
                chromium.call(null, "Target.activateTarget", Map.of("targetId", opener), chromium.request());
            }
            for (String tabId : open) {
                try {
                    chromium.call(null, "Target.closeTarget", Map.of("targetId", tabId), chromium.request());
                    closed++;
                } catch (CdpException e) {
                    if (e.kind() != CdpException.Kind.REMOTE) {
                        throw e;
                    }
                }
            }
        } catch (CdpException e) {
            throw unavailable();
        }
        return Map.of("closed", closed);
    }

    private PasswordManagers.Manager manager(Map<String, Object> params) throws RpcException {
        Object id = params.get("id");
        if (!PasswordManagers.isId(id)) {
            throw badRequest("id");
        }
        PasswordManagers.Manager manager = managers.get((String) id);
        if (manager == null) {
            throw new RpcException(RpcException.FORBIDDEN, "Not an extension the desk allows", Map.of("reason", "extension"));
        }
        return manager;
    }

    // ---- checks

    private void requireAdult() throws RpcException {
        if (band.get() != AgeBand.Band.ADULT) {
            throw new RpcException(RpcException.FORBIDDEN, "Not available on this desk", Map.of("reason", AGE_BAND));
        }
    }

    private static void requireInput(RpcContext context) throws RpcException {
        if (!context.principal().input()) {
            throw BrowserMethods.forbidden();
        }
    }

    private static void requireVideo(RpcContext context) throws RpcException {
        if (!context.principal().video()) {
            throw BrowserMethods.forbidden();
        }
    }

    private static List<?> list(Object value, int size) throws ChromiumPages.Failed {
        if (value instanceof List<?> got && got.size() == size) {
            return got;
        }
        throw new ChromiumPages.Failed();
    }

    private static String string(Object value) {
        return value instanceof String s ? s : null;
    }

    private static RpcException badRequest(String reason) {
        return new RpcException(RpcException.BAD_REQUEST, reason + " is not valid", Map.of("reason", reason));
    }

    private static RpcException unavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "The browser isn't reachable", Map.of("reason", "chromium"));
    }
}
