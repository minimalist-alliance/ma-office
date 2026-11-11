package com.minimalistalliance.desk.deskd.browser.minified;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's isolated world in a tab's frames, over CDP. Every call carries {@link Scripts#RUN}, a constant, with its
 * argument as a JSON value, so nothing a client sends is ever script. No Runtime.enable: a world's context comes from
 * Page.createIsolatedWorld, which hands back the same world for the same name in the same frame, as the Browser's own
 * visibility check does.
 */
final class PageWorld {

    private static final Logger log = LoggerFactory.getLogger(PageWorld.class);

    /** Frames' sessions only: no workers, no service workers. */
    private static final List<Map<String, Object>> FRAMES_ONLY = List.of(Map.of("type", "iframe"));
    /** Frames looked at in one tab for one action. Past this the action refuses, since it can't guard them all. */
    static final int MAX_FRAMES = 64;

    /**
     * A frame of a tab, on the session it's reached by, with the document it holds.
     *
     * @param foreign its document isn't a web page's ({@link #webDocument}), as a password manager's in-page menu isn't:
     *     nothing of deskd's is ever run in it
     */
    record Frame(String sessionId, String frameId, String loaderId, boolean onTab, boolean foreign) {
        Frame(String sessionId, String frameId, String loaderId, boolean onTab) {
            this(sessionId, frameId, loaderId, onTab, false);
        }
    }

    /**
     * Whether a frame's document, by its URL and origin as Chromium says them, is a web page's: http or https, or an
     * {@code about:}, {@code data:} or {@code blob:} document of a web origin or an opaque one (a sandboxed frame's).
     * A browser's or an extension's own page ({@code chrome-extension:}, its {@code about:blank} or {@code blob:} included)
     * never is, and neither is a frame with no URL yet, until it commits to one (the sign-ins work's finding, Nov 11).
     */
    static boolean webDocument(String url, String origin) {
        String u = url == null ? "" : url.strip().toLowerCase(java.util.Locale.ROOT);
        String o = origin == null ? "" : origin.strip().toLowerCase(java.util.Locale.ROOT);
        if (u.startsWith("blob:")) {
            String inner = u.substring(5);
            if (!(inner.startsWith("http://") || inner.startsWith("https://") || inner.startsWith("null"))) {
                return false;
            }
        } else if (!(u.startsWith("http://") || u.startsWith("https://") || u.startsWith("about:") || u.startsWith("data:"))) {
            return false;
        }
        return o.startsWith("http://") || o.startsWith("https://") || o.isEmpty() || o.equals("null") || o.equals("://");
    }

    /**
     * A tab's frames at one moment.
     *
     * @param others every frame but the top one, to arm
     * @param signature every frame, the top one too, with its document: if it differs later, something came, went or
     *     navigated in between
     */
    record Frames(List<Frame> others, java.util.Set<Frame> signature, List<String> topChildren) {
        Frames(List<Frame> others, java.util.Set<Frame> signature) {
            this(others, signature, List.of());
        }
    }

    private final TabAccess access;
    private final Scripts scripts;
    /**
     * Other frames' world contexts, by session, frame and document (B8): {@code Page.createIsolatedWorld} once per frame
     * document, not once per action. A context whose document went fails its call, and is made again.
     */
    private final java.util.concurrent.ConcurrentHashMap<String, CachedWorld> contexts = new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * A frame document's world: its context id, and the random id deskd's half in it answers with. Chromium can hand the
     * same context id to another process's world, so an answer is trusted only with the same world id (Security T47N-2).
     */
    private record CachedWorld(Number context, String wid) {}
    static final int MAX_CONTEXTS = 1024;

    PageWorld(TabAccess access, Scripts scripts) {
        this.access = access;
        this.scripts = scripts;
    }

    /**
     * Adds deskd's scripts to every document the tab's session loads from now on, and asks Chromium to attach to its
     * frames that run in other processes, holding each new one until deskd's guard is in it (Security T47-3). Once per
     * session: a new session has neither.
     */
    String inject(TabRef tab, Duration timeout) throws CdpFailure, InterruptedException {
        Map<String, Object> added = access.call(
                tab, "Page.addScriptToEvaluateOnNewDocument", Map.of("source", scripts.top, "worldName", Scripts.WORLD), timeout);
        access.call(tab, "Target.setAutoAttach", autoAttach(), timeout);
        return Json.string(added, "identifier");
    }

    /**
     * The tab has left the simplified view: its frames are no longer held for deskd's guard, and deskd's script comes off,
     * so the stream is as it was before. Frames already attached go with the attach.
     */
    void leave(TabRef tab, String scriptId, Duration timeout) throws CdpFailure, InterruptedException {
        if (!access.keepsFrameAttach()) {
            access.call(tab, "Target.setAutoAttach", Map.of("autoAttach", false, "waitForDebuggerOnStart", false, "flatten", true), timeout);
        }
        if (scriptId != null) {
            access.call(tab, "Page.removeScriptToEvaluateOnNewDocument", Map.of("identifier", scriptId), timeout);
        }
    }

    /**
     * A frame's session that Chromium attached under a tab: the guard alone in each of its documents, its own frames in
     * other processes the same way, and then it runs. It's let go whatever happens, or the frame would wait for ever.
     */
    void adoptFrame(String sessionId, boolean waiting, Duration timeout) throws InterruptedException {
        guardFrame(sessionId, timeout);
        if (waiting) {
            release(sessionId, timeout);
        }
    }

    /**
     * The guard in a frame's documents, and the hold on its own frames, without letting it run yet. Page is enabled on the
     * frame's session first, or the script never runs at the start of the frame's next document, and a frame sent to a new
     * page of its own site (no new target to hold) would start unarmed (Security T47N-1).
     */
    void guardFrame(String sessionId, Duration timeout) throws InterruptedException {
        try {
            access.callSession(sessionId, "Page.enable", Map.of(), timeout);
        } catch (CdpFailure e) {
            log.debug("couldn't enable Page in a frame: {}", e.kind());
        }
        try {
            access.callSession(sessionId, "Page.addScriptToEvaluateOnNewDocument",
                    Map.of("source", scripts.frame, "worldName", Scripts.WORLD), timeout);
            access.callSession(sessionId, "Target.setAutoAttach", autoAttach(), timeout);
        } catch (CdpFailure e) {
            log.debug("couldn't put the guard in a frame: {}", e.kind());
        }
    }

    /**
     * A frame whose document isn't known yet: Page only, so its commit is heard (MinifiedModule.frameCommitted). No script,
     * no world and no attach to its own frames until it's a web page's.
     */
    void watchFrame(String sessionId, Duration timeout) throws InterruptedException {
        try {
            access.callSession(sessionId, "Page.enable", Map.of(), timeout);
        } catch (CdpFailure e) {
            log.debug("couldn't enable Page in a frame: {}", e.kind());
        }
    }

    /** Lets a frame Chromium held at its start run. */
    void release(String sessionId, Duration timeout) throws InterruptedException {
        try {
            access.callSession(sessionId, "Runtime.runIfWaitingForDebugger", Map.of(), timeout);
        } catch (CdpFailure e) {
            log.debug("couldn't let a frame run: {}", e.kind());
        }
    }

    private static Map<String, Object> autoAttach() {
        return Map.of("autoAttach", true, "waitForDebuggerOnStart", true, "flatten", true, "filter", FRAMES_ONLY);
    }

    /**
     * The top frame's world as it is now, for an action to keep to: a call to it after the document has gone fails, where
     * a new {@link #run} would find the next document's world, which knows nothing of the action.
     */
    Number topContext(TabRef tab, Duration timeout) throws CdpFailure, InterruptedException {
        return context(tab, null, tab.mainFrameId(), timeout);
    }

    /** One op in that world, deskd's half put there first if the document hasn't got it. */
    Map<String, Object> runIn(TabRef tab, Number context, Map<String, Object> args, Duration timeout) throws CdpFailure, InterruptedException {
        Map<String, Object> value = call(tab, null, context, args, timeout);
        if (Boolean.TRUE.equals(value.get("missing"))) {
            evaluate(tab, null, context, scripts.top, timeout);
            value = call(tab, null, context, args, timeout);
        }
        return value;
    }

    /** One op in the top frame's world. A document without deskd's half, one loaded before it was added, gets it here. */
    Map<String, Object> run(TabRef tab, Map<String, Object> args, Duration timeout) throws CdpFailure, InterruptedException {
        Number context = context(tab, null, tab.mainFrameId(), timeout);
        Map<String, Object> value = call(tab, null, context, args, timeout);
        if (Boolean.TRUE.equals(value.get("missing"))) {
            evaluate(tab, null, context, scripts.top, timeout);
            value = call(tab, null, context, args, timeout);
        }
        return value;
    }

    /** Hands deskd an island's own element, by deskd's island id, as a remote object: nothing else is ever handed out. */
    static final String ELEMENT = "function(a){var p=globalThis.__maProxy;return p&&p.element?p.element(a):null}";

    /** Whether this is one of the scripts or functions this sends: {@link Scripts}' and {@link #ELEMENT}. */
    boolean ownScript(String source) {
        return source != null && (source.equals(Scripts.RUN) || source.equals(ELEMENT) || source.equals(scripts.top)
                || source.equals(scripts.frame));
    }

    /**
     * The frame an island's iframe holds, as Chromium says it (DOM.describeNode on the element), never from anything the
     * page wrote on it (Security's Ask 2, condition 2).
     *
     * @return null if the island isn't an iframe now
     */
    String islandFrameId(TabRef tab, String islandId, Duration timeout) throws CdpFailure, InterruptedException {
        Number context = context(tab, null, tab.mainFrameId(), timeout);
        Map<String, Object> made = command(tab, null, "Runtime.callFunctionOn", Map.of("functionDeclaration", ELEMENT,
                "executionContextId", context, "arguments", List.of(Map.of("value", Map.of("island", islandId))),
                "returnByValue", false), timeout);
        Map<String, Object> result = Json.object(made, "result");
        String objectId = result == null ? null : Json.string(result, "objectId");
        if (objectId == null) {
            return null;
        }
        try {
            Map<String, Object> node = Json.object(command(tab, null, "DOM.describeNode", Map.of("objectId", objectId), timeout), "node");
            return node != null && "IFRAME".equalsIgnoreCase(Json.string(node, "nodeName")) ? Json.string(node, "frameId") : null;
        } finally {
            try {
                command(tab, null, "Runtime.releaseObject", Map.of("objectId", objectId), timeout);
            } catch (CdpFailure e) {
                // It goes with the document anyway.
            }
        }
    }

    /** One op in a frame's world, the guard put there first if it isn't. */
    Map<String, Object> runIn(TabRef tab, Frame frame, Map<String, Object> args, Duration timeout) throws CdpFailure, InterruptedException {
        if (frame.foreign()) {
            // Never a world, a guard or a read in a frame that isn't a web page's: it can't be armed, so it refuses.
            throw new CdpFailure(CdpFailure.Kind.REMOTE, 0);
        }
        String session = frame.onTab() ? null : frame.sessionId();
        String key = frame.loaderId().isEmpty() ? null : (session == null ? tab.sessionId() : session) + "|" + frame.frameId() + "|" + frame.loaderId();
        CachedWorld cached = key == null ? null : contexts.get(key);
        if (cached != null) {
            try {
                Map<String, Object> value = runInContext(tab, frame, session, cached.context(), args, timeout);
                if (cached.wid().equals(value.get("wid"))) {
                    return value;
                }
                // Another world answered on that id (T47N-2): forget it, and ask the frame's own world.
                contexts.remove(key, cached);
            } catch (CdpFailure e) {
                // Only a context that's gone is made again: a call that reached deskd's script isn't run twice.
                if (e.kind() != CdpFailure.Kind.REMOTE || e.code() != CdpFailure.SERVER_ERROR) {
                    throw e;
                }
                contexts.remove(key, cached);
            }
        }
        Number context = context(tab, session, frame.frameId(), timeout);
        Map<String, Object> value = runInContext(tab, frame, session, context, args, timeout);
        if (key != null && value.get("wid") instanceof String wid) {
            if (contexts.size() >= MAX_CONTEXTS) {
                contexts.clear();
            }
            contexts.put(key, new CachedWorld(context, wid));
        }
        return value;
    }

    private Map<String, Object> runInContext(TabRef tab, Frame frame, String session, Number context, Map<String, Object> args, Duration timeout)
            throws CdpFailure, InterruptedException {
        Map<String, Object> value = call(tab, session, context, args, timeout);
        if (Boolean.TRUE.equals(value.get("missing"))) {
            evaluate(tab, session, context, frame.onTab() ? scripts.top : scripts.frame, timeout);
            value = call(tab, session, context, args, timeout);
        }
        return value;
    }

    /**
     * Every frame of the tab: those in its own process, from its frame tree, and those in their own, from each frame
     * session deskd holds for it ({@code frameTargets} names those). A frame in another process isn't in its parent's
     * tree at all (Blink's tree skips remote frames, as {@code MinifiedChromiumIT} shows, review 6), so Chromium's own list
     * of frame targets is read beside the trees: one whose parent is among the tab's frames and that deskd holds no
     * session for is a frame deskd can't arm, and the list is refused.
     *
     * @return null if there are more than {@link #MAX_FRAMES}, or a frame in another process that deskd holds no session for
     * @throws CdpFailure if any session didn't answer, a session that's going included: it can't be told what it holds
     */
    Frames frames(TabRef tab, List<String> frameSessions, java.util.Set<String> frameTargets, Duration timeout)
            throws CdpFailure, InterruptedException {
        List<Frame> all = new ArrayList<>();
        CompletableFuture<Map<String, Object>> targets = new CompletableFuture<>();
        Thread.ofVirtual().name("minified-frame-targets").start(() -> {
            try {
                targets.complete(access.callSession(null, "Target.getTargets", Map.of("filter", List.of(Map.of("type", "iframe"))), timeout));
            } catch (CdpFailure e) {
                targets.completeExceptionally(e);
            } catch (InterruptedException e) {
                targets.completeExceptionally(new CdpFailure(CdpFailure.Kind.NOT_SENT, 0));
            } catch (RuntimeException e) {
                targets.completeExceptionally(new CdpFailure(CdpFailure.Kind.REMOTE, 0));
            }
        });
        // Every frame session at once (T47D-1): one a page keeps busy delays the list by its own wait, never the rest's.
        List<CompletableFuture<Map<String, Object>>> trees = new ArrayList<>(frameSessions.size());
        for (String session : frameSessions) {
            CompletableFuture<Map<String, Object>> tree = new CompletableFuture<>();
            trees.add(tree);
            Thread.ofVirtual().name("minified-frame-tree").start(() -> {
                try {
                    tree.complete(access.callSession(session, "Page.getFrameTree", Map.of(), timeout));
                } catch (CdpFailure e) {
                    tree.completeExceptionally(e);
                } catch (InterruptedException e) {
                    tree.completeExceptionally(new CdpFailure(CdpFailure.Kind.NOT_SENT, 0));
                } catch (RuntimeException e) {
                    tree.completeExceptionally(new CdpFailure(CdpFailure.Kind.REMOTE, 0));
                }
            });
        }
        Map<String, Object> own = command(tab, null, "Page.getFrameTree", Map.of(), timeout);
        collect(all, tab.sessionId(), true, own, frameTargets);
        for (int i = 0; i < frameSessions.size(); i++) {
            Map<String, Object> tree;
            try {
                tree = trees.get(i).get();
            } catch (java.util.concurrent.ExecutionException e) {
                throw e.getCause() instanceof CdpFailure failure ? failure : new CdpFailure(CdpFailure.Kind.REMOTE, 0);
            }
            collect(all, frameSessions.get(i), false, tree, java.util.Set.of());
            if (all.size() > MAX_FRAMES) {
                return null;
            }
        }
        Map<String, Object> targetList;
        try {
            targetList = targets.get();
        } catch (java.util.concurrent.ExecutionException e) {
            throw e.getCause() instanceof CdpFailure failure ? failure : new CdpFailure(CdpFailure.Kind.REMOTE, 0);
        }
        if (all.size() > MAX_FRAMES || !covered(all, frameTargets, targetList)) {
            return null;
        }
        List<Frame> others = new ArrayList<>();
        for (Frame frame : all) {
            if (!(frame.onTab() && frame.frameId().equals(tab.mainFrameId()))) {
                others.add(frame);
            }
        }
        return new Frames(others, java.util.Set.copyOf(all), topChildren(tab, own, targetList));
    }

    /**
     * The top document's own frames, whatever process each is in: its tree's children, and the frame targets whose parent
     * is the top frame. Every other frame is inside one of these.
     */
    private static List<String> topChildren(TabRef tab, Map<String, Object> own, Map<String, Object> targetList) {
        java.util.Set<String> ids = new java.util.LinkedHashSet<>();
        Map<String, Object> tree = Json.object(own, "frameTree");
        if (tree != null && tree.get("childFrames") instanceof List<?> children) {
            for (Object child : children) {
                if (child instanceof Map<?, ?> node && node.get("frame") instanceof Map<?, ?> frame && frame.get("id") instanceof String id) {
                    ids.add(id);
                }
            }
        }
        if (targetList.get("targetInfos") instanceof List<?> infos) {
            for (Object item : infos) {
                if (item instanceof Map<?, ?> info && "iframe".equals(info.get("type")) && tab.mainFrameId().equals(info.get("parentFrameId"))
                        && info.get("targetId") instanceof String id) {
                    ids.add(id);
                }
            }
        }
        return List.copyOf(ids);
    }

    /**
     * Whether any of these frames' boxes on the top document comes within {@code margin} of the point, from Chromium's own
     * layout: each frame's owner element ({@code DOM.getFrameOwner}), then its border box ({@code DOM.getBoxModel}). A
     * frame in a closed shadow root or in another process counts, as no walk of the page's DOM could see it (T47D-2).
     * A frame with no box (not rendered, or gone since) can't be near.
     */
    boolean frameNear(TabRef tab, List<String> frameIds, double x, double y, double margin, Duration timeout)
            throws CdpFailure, InterruptedException {
        List<CompletableFuture<Boolean>> answers = new ArrayList<>(frameIds.size());
        for (String frameId : frameIds) {
            CompletableFuture<Boolean> answer = new CompletableFuture<>();
            answers.add(answer);
            Thread.ofVirtual().name("minified-frame-box").start(() -> {
                try {
                    answer.complete(near(tab, frameId, x, y, margin, timeout));
                } catch (CdpFailure e) {
                    answer.completeExceptionally(e);
                } catch (InterruptedException e) {
                    answer.completeExceptionally(new CdpFailure(CdpFailure.Kind.NOT_SENT, 0));
                } catch (RuntimeException e) {
                    answer.completeExceptionally(new CdpFailure(CdpFailure.Kind.REMOTE, 0));
                }
            });
        }
        boolean near = false;
        long deadline = System.nanoTime() + timeout.toNanos() * 3;
        for (CompletableFuture<Boolean> answer : answers) {
            try {
                near |= answer.get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
            } catch (ExecutionException e) {
                throw e.getCause() instanceof CdpFailure failure ? failure : new CdpFailure(CdpFailure.Kind.REMOTE, 0);
            } catch (TimeoutException e) {
                throw new CdpFailure(CdpFailure.Kind.TIMEOUT, 0);
            }
        }
        return near;
    }

    private boolean near(TabRef tab, String frameId, double x, double y, double margin, Duration timeout) throws CdpFailure, InterruptedException {
        Map<String, Object> owner;
        Map<String, Object> box;
        try {
            owner = command(tab, null, "DOM.getFrameOwner", Map.of("frameId", frameId), timeout);
            if (!(owner.get("backendNodeId") instanceof Number node)) {
                return false;
            }
            box = command(tab, null, "DOM.getBoxModel", Map.of("backendNodeId", node), timeout);
        } catch (CdpFailure e) {
            if (e.kind() == CdpFailure.Kind.REMOTE) {
                return false;
            }
            throw e;
        }
        Map<String, Object> model = Json.object(box, "model");
        if (model == null || !(model.get("border") instanceof List<?> quad) || quad.size() != 8) {
            return false;
        }
        double left = Double.MAX_VALUE;
        double right = -Double.MAX_VALUE;
        double top = Double.MAX_VALUE;
        double bottom = -Double.MAX_VALUE;
        for (int i = 0; i < 8; i++) {
            if (!(quad.get(i) instanceof Number n)) {
                return false;
            }
            if (i % 2 == 0) {
                left = Math.min(left, n.doubleValue());
                right = Math.max(right, n.doubleValue());
            } else {
                top = Math.min(top, n.doubleValue());
                bottom = Math.max(bottom, n.doubleValue());
            }
        }
        return right > left && bottom > top && right >= x - margin && left <= x + margin && bottom >= y - margin && top <= y + margin;
    }

    /** Whether deskd holds a session for every frame target whose parent is one of these frames. */
    private static boolean covered(List<Frame> all, java.util.Set<String> frameTargets, Map<String, Object> reply) {
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (Frame frame : all) {
            ids.add(frame.frameId());
        }
        if (!(reply.get("targetInfos") instanceof List<?> infos)) {
            return true;
        }
        for (Object item : infos) {
            if (item instanceof Map<?, ?> info && "iframe".equals(info.get("type")) && info.get("parentFrameId") instanceof String parent
                    && ids.contains(parent) && !frameTargets.contains(String.valueOf(info.get("targetId")))) {
                return false;
            }
        }
        return true;
    }

    private static void collect(List<Frame> frames, String session, boolean onTab, Map<String, Object> reply, java.util.Set<String> skip) {
        Map<String, Object> tree = Json.object(reply, "frameTree");
        List<Map<String, Object>> stack = new ArrayList<>();
        if (tree != null) {
            stack.add(tree);
        }
        while (!stack.isEmpty() && frames.size() <= MAX_FRAMES) {
            Map<String, Object> node = stack.remove(stack.size() - 1);
            Map<String, Object> frame = Json.object(node, "frame");
            String id = frame == null ? null : Json.string(frame, "id");
            if (id != null && !skip.contains(id)) {
                String loader = Json.string(frame, "loaderId");
                boolean foreign = !webDocument(Json.string(frame, "url"), Json.string(frame, "securityOrigin"));
                frames.add(new Frame(session, id, loader == null ? "" : loader, onTab, foreign));
            }
            if (node.get("childFrames") instanceof List<?> children) {
                for (Object child : children) {
                    if (child instanceof Map<?, ?>) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> typed = (Map<String, Object>) child;
                        stack.add(typed);
                    }
                }
            }
        }
    }

    /**
     * Runs one op in each frame at once.
     *
     * @return each frame's answer
     * @throws CdpFailure if any frame didn't answer, one that went meanwhile included: a hung frame can't be guarded, and
     *     one that went may have been replaced by one that isn't
     */
    List<Map<String, Object>> runInAll(TabRef tab, List<Frame> frames, Map<String, Object> args, Duration timeout)
            throws CdpFailure, InterruptedException {
        List<CompletableFuture<Map<String, Object>>> answers = new ArrayList<>(frames.size());
        for (Frame frame : frames) {
            CompletableFuture<Map<String, Object>> answer = new CompletableFuture<>();
            answers.add(answer);
            Thread.ofVirtual().name("minified-frame").start(() -> {
                try {
                    answer.complete(runIn(tab, frame, args, timeout));
                } catch (CdpFailure e) {
                    answer.completeExceptionally(e);
                } catch (InterruptedException e) {
                    answer.completeExceptionally(new CdpFailure(CdpFailure.Kind.NOT_SENT, 0));
                } catch (RuntimeException e) {
                    answer.completeExceptionally(new CdpFailure(CdpFailure.Kind.REMOTE, 0));
                }
            });
        }
        List<Map<String, Object>> results = new ArrayList<>(frames.size());
        long deadline = System.nanoTime() + timeout.toNanos() * 3;
        for (CompletableFuture<Map<String, Object>> answer : answers) {
            try {
                results.add(answer.get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS));
            } catch (ExecutionException e) {
                throw e.getCause() instanceof CdpFailure failure ? failure : new CdpFailure(CdpFailure.Kind.REMOTE, 0);
            } catch (TimeoutException e) {
                throw new CdpFailure(CdpFailure.Kind.TIMEOUT, 0);
            }
        }
        return results;
    }

    private Number context(TabRef tab, String session, String frameId, Duration timeout) throws CdpFailure, InterruptedException {
        Map<String, Object> made = command(tab, session, "Page.createIsolatedWorld", Map.of("frameId", frameId, "worldName", Scripts.WORLD), timeout);
        if (!(made.get("executionContextId") instanceof Number context)) {
            throw new CdpFailure(CdpFailure.Kind.REMOTE, 0);
        }
        return context;
    }

    private Map<String, Object> call(TabRef tab, String session, Number context, Map<String, Object> args, Duration timeout)
            throws CdpFailure, InterruptedException {
        Map<String, Object> reply = command(tab, session, "Runtime.callFunctionOn", Map.of(
                "functionDeclaration", Scripts.RUN,
                "executionContextId", context,
                "arguments", List.of(Map.of("value", args)),
                "returnByValue", true,
                "awaitPromise", true), timeout);
        if (reply.get("exceptionDetails") != null) {
            throw new CdpFailure(CdpFailure.Kind.REMOTE, CdpFailure.SCRIPT_THREW);
        }
        Map<String, Object> result = Json.object(reply, "result");
        Map<String, Object> value = result == null ? null : Json.object(result, "value");
        if (value == null) {
            throw new CdpFailure(CdpFailure.Kind.REMOTE, 0);
        }
        return value;
    }

    private void evaluate(TabRef tab, String session, Number context, String source, Duration timeout)
            throws CdpFailure, InterruptedException {
        Map<String, Object> reply = command(tab, session, "Runtime.evaluate",
                Map.of("expression", source, "contextId", context, "returnByValue", true), timeout);
        if (reply.get("exceptionDetails") != null) {
            throw new CdpFailure(CdpFailure.Kind.REMOTE, CdpFailure.SCRIPT_THREW);
        }
    }

    private Map<String, Object> command(TabRef tab, String session, String method, Map<String, Object> params, Duration timeout)
            throws CdpFailure, InterruptedException {
        return session == null ? access.call(tab, method, params, timeout) : access.callSession(session, method, params, timeout);
    }
}
