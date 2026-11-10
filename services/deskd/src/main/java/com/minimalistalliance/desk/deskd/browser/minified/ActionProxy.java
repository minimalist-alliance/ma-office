package com.minimalistalliance.desk.deskd.browser.minified;

import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * {@code browser.minified.act}: one thing the member did in the simplified view, done to the real page, or refused.
 * Zero wrong-target actions is the rule (design 7.3), so it refuses rather than guess (Security T47-2, T47-3):
 *
 * <ol>
 *   <li>The node has to be in the tab's current MDoc, in the block and with the fingerprint the client says it saw.
 *   <li>Every other frame of the tab, those in other processes included, is armed to cancel any trusted input.
 *   <li>In the same call into the page, deskd's half looks up the element, takes its fingerprint again, refuses a
 *       sensitive field, scrolls it into view, hit-tests it, refuses a frame near the point, and arms the guard on it.
 *   <li>Press and release go with no move before them. A click counts only if the element itself got pointerdown,
 *       pointerup and click; typing only if the element still has its text and focus.
 *   <li>Nothing is ever found again by guessing: a changed page is a refusal, and a fresh view goes to the client.
 * </ol>
 * One action at a time per tab, in the order they came, and at most {@value #QUEUE} waiting. A newer fill of the same
 * field supersedes one still waiting.
 */
final class ActionProxy {

    static final int TAB_PER_SECOND = 30;
    static final int DESK_PER_SECOND = 60;
    static final int QUEUE = 16;
    static final int MAX_TEXT_CHARS = 64 * 1024;
    /** How near a frame's box may be to the click point, in CSS pixels, before the click refuses (T47-3). */
    static final int FRAME_MARGIN = 24;
    private static final Set<String> ACTIONS = Set.of("click", "fill", "check", "select", "press", "scroll", "media");
    private static final Set<String> MEDIA_VERBS = Set.of("play", "pause", "seek", "volume", "track");
    /** Kinds of field that typing can't fill: those go to the stream. */
    private static final Set<String> UNTYPEABLE = Set.of(
            "file_choice", "colour_choice", "range_choice", "date_choice", "time_choice", "datetime_choice", "month_choice", "week_choice");
    private static final Map<String, Object[]> KEYS = Map.of(
            "Enter", new Object[] {"Enter", 13, "\r"},
            "Escape", new Object[] {"Escape", 27, null},
            "Tab", new Object[] {"Tab", 9, null},
            "ArrowUp", new Object[] {"ArrowUp", 38, null},
            "ArrowDown", new Object[] {"ArrowDown", 40, null},
            "Backspace", new Object[] {"Backspace", 8, null});
    private static final SecureRandom RANDOM = new SecureRandom();

    private final MinifiedModule module;

    ActionProxy(MinifiedModule module) {
        this.module = module;
    }

    /** What the client asked, its shape already checked. */
    /**
     * @param rev the rev of the MDoc the member acted in: one from before the tab's current document refuses
     */
    record Request(String tabId, String nodeId, String action, Object value, String fp, String block, long rev) {}

    /** Every other frame, armed at {@code at}, and what the tab's frames were then. */
    record Armed(PageWorld.Frames frames, long at) {
        static final Armed NONE = new Armed(new PageWorld.Frames(List.of(), Set.of()), 0);
    }

    Map<String, Object> act(RpcContext context, Request request) throws RpcException, InterruptedException {
        if (!ACTIONS.contains(request.action())) {
            throw new RpcException(RpcException.BAD_REQUEST, "No such action", Map.of("reason", "action"));
        }
        // An action is work: Chromium is thawed for it first, and isn't frozen under it (ADR 0045).
        try (AutoCloseable use = module.access.use()) {
            return admitted(context, request);
        } catch (RpcException | InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw MinifiedModule.unavailable();
        }
    }

    private Map<String, Object> admitted(RpcContext context, Request request) throws RpcException, InterruptedException {
        TabRef tab = module.access.resolve(request.tabId());
        MinifiedModule.TabState state = module.state(tab.tabId());
        if (state == null) {
            throw MinifiedModule.unavailable();
        }
        long ticket = admit(state, request);
        try {
            // Ahead of any look at the page that hasn't started (B8).
            module.actionWaiting(state, true);
            try {
                state.work.lockInterruptibly();
            } finally {
                module.actionWaiting(state, false);
            }
            try {
                // The last action's frames are disarmed before this one arms them (B8, T47D-1).
                module.awaitSettled(state);
                if ("fill".equals(request.action()) && superseded(state, request.nodeId(), ticket)) {
                    return outcome(false, "superseded");
                }
                // A replaced session has neither deskd's script nor its frames' attach: both again, first (T47-3).
                module.ensureInjected(tab, state);
                return actLocked(context, tab, state, request);
            } finally {
                state.work.unlock();
                module.markDirty(state);
            }
        } catch (RpcException | InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw MinifiedModule.unavailable();
        } finally {
            module.lock.lock();
            try {
                state.queued--;
                if (Long.valueOf(ticket).equals(state.latestFill.get(request.nodeId()))) {
                    state.latestFill.remove(request.nodeId());
                }
            } finally {
                module.lock.unlock();
            }
        }
    }

    /** Rate and queue, desk-wide and per tab. @return this action's ticket */
    private long admit(MinifiedModule.TabState state, Request request) throws RpcException {
        module.lock.lock();
        try {
            if (state.queued >= QUEUE || !state.actions.tryAcquire() || !module.deskActions.tryAcquire()) {
                throw new RpcException(RpcException.RATE_LIMITED, "Too many actions", Map.of("limit", "minified"));
            }
            state.queued++;
            long ticket = System.nanoTime();
            if ("fill".equals(request.action())) {
                state.latestFill.put(request.nodeId(), ticket);
            }
            return ticket;
        } finally {
            module.lock.unlock();
        }
    }

    private boolean superseded(MinifiedModule.TabState state, String nodeId, long ticket) {
        module.lock.lock();
        try {
            Long latest = state.latestFill.get(nodeId);
            return latest != null && latest != ticket;
        } finally {
            module.lock.unlock();
        }
    }

    private Map<String, Object> actLocked(RpcContext context, TabRef tab, MinifiedModule.TabState state, Request request)
            throws RpcException, InterruptedException {
        if (!module.sameDocument(state, request.rev())) {
            throw refused("changed");
        }
        MDoc doc = module.doc(state);
        MDoc.Node node = doc == null ? null : doc.nodes.get(request.nodeId());
        MDoc.Island island = doc == null ? null : doc.islands.get(request.nodeId());
        if ("media".equals(request.action())) {
            return media(context, tab, island, request);
        }
        if ("scroll".equals(request.action()) && island != null) {
            if (!island.block().equals(request.block())) {
                throw refused("changed");
            }
            return scroll(context, tab, request);
        }
        if (node == null || !node.fp().equals(request.fp()) || !node.block().equals(request.block())) {
            throw refused("changed");
        }
        module.lock.lock();
        try {
            if (state.sensitiveRefs.contains(node.id())) {
                throw sensitive(null);
            }
        } finally {
            module.lock.unlock();
        }
        return switch (request.action()) {
            case "click" -> {
                requireKind(node, MDoc.NodeKind.LINK, MDoc.NodeKind.BUTTON, MDoc.NodeKind.CHECK);
                yield pointer(context, tab, state, node, "click", null);
            }
            case "check" -> {
                requireKind(node, MDoc.NodeKind.CHECK);
                if (!(request.value() instanceof Boolean checked)) {
                    throw new RpcException(RpcException.BAD_REQUEST, "value must be true or false", Map.of("reason", "value"));
                }
                yield pointer(context, tab, state, node, "check", checked);
            }
            case "fill" -> {
                requireKind(node, MDoc.NodeKind.FIELD);
                if (UNTYPEABLE.contains(node.fieldKind())) {
                    throw refused("kind");
                }
                if (!(request.value() instanceof String text)) {
                    throw new RpcException(RpcException.BAD_REQUEST, "value must be a string", Map.of("reason", "value"));
                }
                if (text.length() > MAX_TEXT_CHARS) {
                    throw new RpcException(RpcException.TOO_LARGE, "Text too long", Map.of("limit", MAX_TEXT_CHARS));
                }
                yield keys(context, tab, state, node, "fill", Text.insertable(text));
            }
            case "press" -> {
                requireKind(node, MDoc.NodeKind.FIELD, MDoc.NodeKind.SELECT);
                if (!(request.value() instanceof String key) || !KEYS.containsKey(key)) {
                    throw new RpcException(RpcException.BAD_REQUEST, "value must be a key this knows", Map.of("reason", "value"));
                }
                yield keys(context, tab, state, node, "press", key);
            }
            case "select" -> select(context, tab, state, node, request.value());
            default -> scroll(context, tab, request);
        };
    }

    // ---- the two behind flags, until Security says yes

    /**
     * A verb on an island's own media element (spec section 6). The island has to be in the current MDoc, in the block
     * and with the fingerprint the client saw, and deskd's half checks the fingerprint again on the element. Nothing is
     * clicked: the element is called, so no frame can take it. An island in another site's frame refuses for now.
     */
    private Map<String, Object> media(RpcContext context, TabRef tab, MDoc.Island island, Request request)
            throws RpcException, InterruptedException {
        if (!module.flags.mediaActions()) {
            throw new RpcException(RpcException.FORBIDDEN, "Not turned on for this desk", Map.of("reason", "disabled"));
        }
        if (island == null || !island.block().equals(request.block()) || !island.fp().equals(request.fp())) {
            throw refused("changed");
        }
        if (!(request.value() instanceof Map<?, ?> value) || !(value.get("verb") instanceof String verb) || !MEDIA_VERBS.contains(verb)) {
            throw new RpcException(RpcException.BAD_REQUEST, "value must be {verb, ...}", Map.of("reason", "value"));
        }
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("op", "media");
        args.put("island", island.id());
        args.put("fp", island.fp());
        args.put("verb", verb);
        if (value.get("time") instanceof Number time && Double.isFinite(time.doubleValue())) {
            args.put("time", Math.max(0, time.doubleValue()));
        }
        if (value.get("volume") instanceof Number volume && Double.isFinite(volume.doubleValue())) {
            args.put("volume", Math.max(0, Math.min(1, volume.doubleValue())));
        }
        if (value.get("muted") instanceof Boolean muted) {
            args.put("muted", muted);
        }
        if (value.get("track") instanceof Number track) {
            args.put("track", Math.max(-1, Math.min(64, track.intValue())));
        }
        begin(context);
        Map<String, Object> done;
        try {
            done = module.world.run(tab, args, module.timing.request());
            if ("frame".equals(done.get("refused"))) {
                done = inFrame(tab, island, args);
            }
        } catch (CdpFailure e) {
            throw MinifiedModule.unavailable();
        }
        if ("play".equals(done.get("refused"))) {
            // The page, or its autoplay rule, refused play(): "Play on the real page" (Security's Ask 2, condition 3).
            return outcome(false, "play_refused");
        }
        if (!Boolean.TRUE.equals(done.get("ok"))) {
            return outcome(false, done.get("refused") instanceof String r && REFUSALS.contains(r) ? r : "changed");
        }
        // The element's state after the verb, as the island's controls show it.
        Map<String, Object> outcome = outcome(true, null);
        outcome.put("paused", Boolean.TRUE.equals(done.get("paused")));
        for (String[] fact : new String[][] {{"at", "time"}, {"dur", "duration"}, {"buf", "buffered"}, {"vol", "volume"}}) {
            if (done.get(fact[0]) instanceof Number n && Double.isFinite(n.doubleValue())) {
                outcome.put(fact[1], n.doubleValue());
            }
        }
        outcome.put("muted", on(done.get("muted")));
        outcome.put("captions", on(done.get("cc")));
        return outcome;
    }

    private static boolean on(Object fact) {
        return Boolean.TRUE.equals(fact) || fact instanceof Number n && n.intValue() == 1;
    }

    /**
     * A verb on a video in another site's frame (Security's Ask 2): the frame found from the island's iframe by Chromium,
     * and the op run in that frame's own world, on the video that frame's half picks itself. Still no input, no gesture.
     */
    private Map<String, Object> inFrame(TabRef tab, MDoc.Island island, Map<String, Object> args) throws CdpFailure, InterruptedException {
        String frameId = module.world.islandFrameId(tab, island.id(), module.timing.request());
        if (frameId == null) {
            return Map.of("refused", "frame");
        }
        String session = module.frameSessionFor(tab.tabId(), frameId);
        PageWorld.Frame frame = session != null
                ? new PageWorld.Frame(session, frameId, "", false)
                : new PageWorld.Frame(tab.sessionId(), frameId, "", true);
        Map<String, Object> inside = new LinkedHashMap<>(args);
        inside.put("op", "frameMedia");
        inside.remove("island");
        inside.remove("fp");
        return module.world.runIn(tab, frame, inside, module.timing.request());
    }

    /**
     * deskd's own press of a consent banner's reject, behind its flag, through every check a member's click goes through.
     * One try per document, and only as rate allows.
     *
     * @return whether the button itself got the click
     */
    boolean pressConsent(TabRef tab, MinifiedModule.TabState state, MDoc doc) throws RpcException, InterruptedException {
        MDoc.Consent consent = doc.consent;
        module.lock.lock();
        try {
            if (consent == null || !state.actions.tryAcquire() || !module.deskActions.tryAcquire()) {
                return false;
            }
        } finally {
            module.lock.unlock();
        }
        state.work.lockInterruptibly();
        try {
            module.ensureInjected(tab, state);
            // An untrusted el.click() from deskd's world, after deskd's half checks the banner again at press time: no
            // input is dispatched, so no frame can take it (Security's Ask 1, T47D-1, T47X-1).
            Map<String, Object> got = module.world.run(tab, Map.of("op", "consent", "node", consent.node(), "fp", consent.fp()),
                    module.timing.request());
            return Boolean.TRUE.equals(got.get("ok"));
        } catch (CdpFailure e) {
            return false;
        } finally {
            state.work.unlock();
        }
    }

    // ---- clicks

    /** A click, or a tick, through the guard. */
    private Map<String, Object> pointer(RpcContext context, TabRef tab, MinifiedModule.TabState state, MDoc.Node node, String action, Boolean checked)
            throws RpcException, InterruptedException {
        String id = newId();
        // T47D-1: frames born from here until the disarm wait for it, held at their start.
        module.beginActing(state);
        Armed frames;
        try {
            frames = armOthers(tab, state, id);
        } catch (RpcException | InterruptedException | RuntimeException e) {
            module.endActing(state);
            throw e;
        }
        try {
            Map<String, Object> prepare = new LinkedHashMap<>();
            prepare.put("op", "prepare");
            prepare.put("id", id);
            prepare.put("node", node.id());
            prepare.put("fp", node.fp());
            prepare.put("action", action);
            prepare.put("ms", module.timing.guard().toMillis());
            if (checked != null) {
                prepare.put("checked", checked);
            }
            // The prepare and the result go to one document's world: if the click navigates, the result's call fails.
            Number world = pinned(tab);
            Map<String, Object> ready = page(tab, world, prepare);
            refuseIf(state, node, ready);
            if (Boolean.TRUE.equals(ready.get("noop"))) {
                return outcome(true, null);
            }
            if (!(ready.get("x") instanceof Number x) || !(ready.get("y") instanceof Number y)) {
                throw refused("hidden");
            }
            nearFrame(tab, frames, x, y);
            stillArmed(tab, frames);
            begin(context);
            try {
                // Press then release, with no move before them: a move gives a page a turn to slide something under it.
                dispatch(tab, state, "Input.dispatchMouseEvent", mouse("mousePressed", x, y, 1));
                dispatch(tab, state, "Input.dispatchMouseEvent", mouse("mouseReleased", x, y, 0));
            } catch (CdpFailure e) {
                throw afterEffect(state);
            } catch (DialogOpened e) {
                // The page is held by its dialog, which only the stream shows, and which deskd never answers.
                frames = Armed.NONE;
                return outcome(false, "dialog");
            }
            Map<String, Object> got;
            try {
                got = module.world.runIn(tab, world, Map.of("op", "result", "id", id), module.timing.request());
            } catch (CdpFailure e) {
                // The page went before it could say: the click started a navigation, so it can't be counted.
                return outcome(false, e.kind() == CdpFailure.Kind.REMOTE ? "navigated" : "unknown");
            }
            boolean onTarget = got.get("tripped") == null
                    && seen(got, "pointerdown") && seen(got, "pointerup") && seen(got, "click");
            if ("changed".equals(got.get("tripped"))) {
                // It stopped showing what the member saw while being pressed, and the click was cancelled.
                return outcome(false, "changed");
            }
            if (!onTarget) {
                // A frame that came or went since the last look may have taken it: say so, not that it missed (T47D-1).
                return outcome(false, framesChanged(tab, frames) ? "unknown" : "missed");
            }
            if (checked != null && !checked.equals(got.get("checked"))) {
                return outcome(false, "value");
            }
            return outcome(true, null);
        } finally {
            settleLater(tab, state, frames, id);
        }
    }

    private static Map<String, Object> mouse(String type, Number x, Number y, int buttons) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", type);
        event.put("x", x);
        event.put("y", y);
        event.put("button", "left");
        event.put("buttons", buttons);
        event.put("clickCount", 1);
        return event;
    }

    // ---- typing

    private Map<String, Object> keys(RpcContext context, TabRef tab, MinifiedModule.TabState state, MDoc.Node node, String action, String text)
            throws RpcException, InterruptedException {
        String id = newId();
        // T47D-1: frames born from here until the disarm wait for it, held at their start.
        module.beginActing(state);
        Armed frames;
        try {
            frames = armOthers(tab, state, id);
        } catch (RpcException | InterruptedException | RuntimeException e) {
            module.endActing(state);
            throw e;
        }
        try {
            Map<String, Object> prepare = new LinkedHashMap<>();
            prepare.put("op", "prepare");
            prepare.put("id", id);
            prepare.put("node", node.id());
            prepare.put("fp", node.fp());
            prepare.put("action", action);
            prepare.put("ms", module.timing.guard().toMillis());
            // The prepare and the result go to one document's world: if the click navigates, the result's call fails.
            Number world = pinned(tab);
            Map<String, Object> ready = page(tab, world, prepare);
            refuseIf(state, node, ready);
            stillArmed(tab, frames);
            begin(context);
            try {
                if ("press".equals(action)) {
                    pressKey(tab, state, text);
                } else if (text.isEmpty()) {
                    // The field's text is selected, so Delete empties it.
                    pressKey(tab, state, "Delete");
                } else {
                    dispatch(tab, state, "Input.insertText", Map.of("text", text));
                }
            } catch (CdpFailure e) {
                throw afterEffect(state);
            } catch (DialogOpened e) {
                frames = Armed.NONE;
                return outcome(false, "dialog");
            }
            Map<String, Object> got;
            try {
                got = module.world.runIn(tab, world, Map.of("op", "result", "id", id), module.timing.request());
            } catch (CdpFailure e) {
                return outcome(false, e.kind() == CdpFailure.Kind.REMOTE ? "navigated" : "unknown");
            }
            if ("sensitive".equals(got.get("tripped"))) {
                // The field turned sensitive under the keys: the guard stopped them, and it stays refused (T47-1).
                module.lock.lock();
                try {
                    state.sensitiveRefs.add(node.id());
                } finally {
                    module.lock.unlock();
                }
                return outcome(false, "sensitive");
            }
            if (got.get("tripped") != null || Boolean.TRUE.equals(got.get("lost"))) {
                return outcome(false, framesChanged(tab, frames) ? "unknown" : "missed");
            }
            if ("press".equals(action)) {
                return seen(got, "keydown") ? outcome(true, null) : outcome(false, framesChanged(tab, frames) ? "unknown" : "missed");
            }
            // After insertText, the element itself holds the text: the page may have reformatted it, but not taken it.
            // By hash and length, as deskd's half sends them: the text itself would be cut at 4096 (review 3).
            String sent = textHash(text);
            if (sameText(got, "value", text.length(), sent)) {
                return outcome(true, null);
            }
            if (!text.isEmpty() && sameText(got, "data", text.length(), sent) && Boolean.TRUE.equals(got.get("focused"))) {
                Map<String, Object> reformatted = outcome(true, null);
                reformatted.put("reformatted", true);
                return reformatted;
            }
            return outcome(false, "value");
        } finally {
            settleLater(tab, state, frames, id);
        }
    }

    private static boolean sameText(Map<String, Object> got, String what, int length, String hash) {
        return got.get(what + "Len") instanceof Number n && n.intValue() == length && hash.equals(got.get(what + "Hash"));
    }

    /** deskd's half's hash (cyrb53, proxy.js), the same in Java, so text is compared without being sent back. */
    static String textHash(String str) {
        int h1 = 0xdeadbeef;
        int h2 = 0x41c6ce57;
        for (int i = 0; i < str.length(); i++) {
            int ch = str.charAt(i);
            h1 = (h1 ^ ch) * (int) 2654435761L;
            h2 = (h2 ^ ch) * 1597334677;
        }
        h1 = ((h1 ^ (h1 >>> 16)) * (int) 2246822507L) ^ ((h2 ^ (h2 >>> 13)) * (int) 3266489909L);
        h2 = ((h2 ^ (h2 >>> 16)) * (int) 2246822507L) ^ ((h1 ^ (h1 >>> 13)) * (int) 3266489909L);
        long v = 4294967296L * (2097151 & h2) + (h1 & 0xffffffffL);
        return Long.toString(v, 36);
    }

    private void pressKey(TabRef tab, MinifiedModule.TabState state, String key) throws CdpFailure, InterruptedException, DialogOpened {
        Object[] spec = "Delete".equals(key) ? new Object[] {"Delete", 46, null} : KEYS.get(key);
        Map<String, Object> down = new LinkedHashMap<>();
        down.put("type", spec[2] != null ? "keyDown" : "rawKeyDown");
        down.put("key", spec[0]);
        down.put("code", spec[0]);
        down.put("windowsVirtualKeyCode", spec[1]);
        if (spec[2] != null) {
            down.put("text", spec[2]);
        }
        dispatch(tab, state, "Input.dispatchKeyEvent", down);
        dispatch(tab, state, "Input.dispatchKeyEvent",
                Map.of("type", "keyUp", "key", spec[0], "code", spec[0], "windowsVirtualKeyCode", spec[1]));
    }

    /** A dialog the page opened, which holds it, and with it the reply to the input that opened it. */
    private static final class DialogOpened extends Exception {
        private static final long serialVersionUID = 1L;

        DialogOpened() {
            super("dialog", null, false, false);
        }
    }

    /**
     * Input for the page, waited for until it's taken, or a dialog opens: Chromium answers input only once the page has
     * dealt with it, and a dialog the click opened holds the page until someone answers it.
     */
    private void dispatch(TabRef tab, MinifiedModule.TabState state, String method, Map<String, Object> params)
            throws CdpFailure, InterruptedException, DialogOpened {
        CompletableFuture<Void> sent = new CompletableFuture<>();
        Thread.ofVirtual().name("minified-input").start(() -> {
            try {
                module.access.call(tab, method, params, module.timing.request());
                sent.complete(null);
            } catch (CdpFailure e) {
                sent.completeExceptionally(e);
            } catch (InterruptedException e) {
                sent.completeExceptionally(new CdpFailure(CdpFailure.Kind.NOT_SENT, 0));
            }
        });
        while (true) {
            try {
                sent.get(25, TimeUnit.MILLISECONDS);
                return;
            } catch (TimeoutException e) {
                if (module.dialogOpen(state)) {
                    throw new DialogOpened();
                }
            } catch (ExecutionException e) {
                throw e.getCause() instanceof CdpFailure failure ? failure : new CdpFailure(CdpFailure.Kind.REMOTE, 0);
            }
        }
    }

    // ---- selects and scrolling: no trusted input, so no frame can take them

    /** By index, and only if the option still reads as it did in the member's view (T47-2). */
    private Map<String, Object> select(RpcContext context, TabRef tab, MinifiedModule.TabState state, MDoc.Node node, Object value)
            throws RpcException, InterruptedException {
        requireKind(node, MDoc.NodeKind.SELECT);
        if (node.multiple()) {
            throw refused("kind");
        }
        if (!(value instanceof Map<?, ?> choice) || !(choice.get("index") instanceof Number index) || !(choice.get("label") instanceof String label)) {
            throw new RpcException(RpcException.BAD_REQUEST, "value must be {index, label}", Map.of("reason", "value"));
        }
        int i = index.intValue();
        if (i < 0 || i >= node.options().size() || !node.options().get(i).equals(label)) {
            throw refused("label");
        }
        Map<String, Object> check = new LinkedHashMap<>();
        check.put("op", "select");
        check.put("node", node.id());
        check.put("fp", node.fp());
        check.put("index", i);
        check.put("check", true);
        Map<String, Object> looked = page(tab, check);
        refuseIf(state, node, looked);
        Object pageLabel = looked.get("label");
        if (!(pageLabel instanceof String raw) || !Text.clean(raw, 80).equals(label)) {
            throw refused("label");
        }
        check.put("check", false);
        check.put("label", raw);
        begin(context);
        Map<String, Object> done;
        try {
            done = module.world.run(tab, check, module.timing.request());
        } catch (CdpFailure e) {
            throw afterEffect(state);
        }
        return Boolean.TRUE.equals(done.get("ok")) ? outcome(true, null) : outcome(false, String.valueOf(done.get("refused")));
    }

    private Map<String, Object> scroll(RpcContext context, TabRef tab, Request request) throws RpcException, InterruptedException {
        begin(context);
        Map<String, Object> done;
        try {
            done = module.world.run(tab, Map.of("op", "scroll", "node", request.nodeId(),
                    "block", "center".equals(request.value()) ? "center" : "start"), module.timing.request());
        } catch (CdpFailure e) {
            throw MinifiedModule.unavailable();
        }
        return Boolean.TRUE.equals(done.get("ok")) ? outcome(true, null) : outcome(false, "gone");
    }

    // ---- the guard in every other frame

    /**
     * Every frame but the top one cancels trusted input until disarmed, or until {@code guard} passes, which is longer
     * than a whole action may take. A frame that doesn't say it's armed, hung, going, sandboxed so its scripts can't run,
     * or one deskd couldn't keep track of, refuses the action: a frame that can't be guarded can't be clicked past (T47-3).
     */
    private Armed armOthers(TabRef tab, MinifiedModule.TabState state, String id) throws RpcException, InterruptedException {
        if (module.framesUnrecorded(state)) {
            throw refused("frames");
        }
        PageWorld.Frames frames = listFrames(tab);
        long at = System.nanoTime();
        try {
            List<Map<String, Object>> answers = module.world.runInAll(
                    tab, frames.others(), Map.of("op", "arm", "id", id, "ms", module.timing.guard().toMillis()), module.timing.request());
            for (Map<String, Object> answer : answers) {
                if (answer == null || !Boolean.TRUE.equals(answer.get("ok"))) {
                    disarm(tab, new Armed(frames, at), id);
                    throw refused("frames");
                }
            }
        } catch (CdpFailure e) {
            disarm(tab, new Armed(frames, at), id);
            throw refused("frames");
        }
        return new Armed(frames, at);
    }

    private PageWorld.Frames listFrames(TabRef tab) throws RpcException, InterruptedException {
        PageWorld.Frames frames;
        try {
            frames = module.world.frames(tab, module.frameSessionsOf(tab.tabId()), module.frameTargetsOf(tab.tabId()), module.timing.request());
        } catch (CdpFailure e) {
            throw e.kind() == CdpFailure.Kind.REMOTE ? refused("frames") : MinifiedModule.unavailable();
        }
        if (frames == null) {
            throw refused("frames");
        }
        return frames;
    }

    /**
     * Right before the press: the arm is young enough that no guard can have lapsed by the time Chromium has dealt with the
     * input, and no frame came, went or navigated since, as a lazy frame the scroll brought in would, or the top
     * document itself (T47-3).
     */
    private void stillArmed(TabRef tab, Armed armed) throws RpcException, InterruptedException {
        if (System.nanoTime() - armed.at() > pressWithin().toNanos()) {
            throw refused("frames");
        }
        long started = System.nanoTime();
        PageWorld.Frames now = listFrames(tab);
        // A re-read a page kept busy is time for it to send a frame elsewhere unseen: past REREAD_WITHIN, refuse (T47N-1).
        if (System.nanoTime() - started > REREAD_WITHIN.toNanos() || !now.signature().equals(armed.frames().signature())) {
            throw refused("frames");
        }
    }

    /** How long the frames' re-read before the press may take (Security T47N-1). */
    static final java.time.Duration REREAD_WITHIN = java.time.Duration.ofSeconds(1);

    /**
     * A frame of the top document within {@link #FRAME_MARGIN} of the point refuses, by Chromium's own boxes, so one in a
     * closed shadow root or in another process counts (T47D-2). After the scroll, as the point is.
     */
    private void nearFrame(TabRef tab, Armed armed, Number x, Number y) throws RpcException, InterruptedException {
        List<String> top = armed.frames().topChildren();
        if (top.isEmpty()) {
            return;
        }
        boolean near;
        try {
            near = module.world.frameNear(tab, top, x.doubleValue(), y.doubleValue(), FRAME_MARGIN, module.timing.request());
        } catch (CdpFailure e) {
            throw refused("frames");
        }
        if (near) {
            throw refused("frame_near");
        }
    }

    /** Whether the tab's frames are not the ones armed, read again after the input: unknown counts as changed. */
    private boolean framesChanged(TabRef tab, Armed armed) throws InterruptedException {
        try {
            return !listFrames(tab).signature().equals(armed.frames().signature());
        } catch (RpcException e) {
            return true;
        }
    }

    /** A third of the guard's life: the press, the release and the answer each get a request's time, within the rest. */
    private java.time.Duration pressWithin() {
        return module.timing.guard().dividedBy(3);
    }

    /**
     * The frames' disarm, after the reply (B8): the reply doesn't wait for it, the tab's next action does
     * ({@link MinifiedModule#awaitSettled}), and frames born meanwhile stay held at their start until it's done (T47D-1).
     */
    private void settleLater(TabRef tab, MinifiedModule.TabState state, Armed armed, String id) {
        if (armed.frames().others().isEmpty()) {
            module.endActing(state);
            return;
        }
        java.util.concurrent.CompletableFuture<Void> done = new java.util.concurrent.CompletableFuture<>();
        module.settling(state, done);
        Thread.ofVirtual().name("minified-disarm").start(() -> {
            try {
                disarm(tab, armed, id);
            } finally {
                module.endActing(state);
                done.complete(null);
            }
        });
    }

    /** Best effort: a guard also lets go by itself once {@code guard} has passed. */
    private void disarm(TabRef tab, Armed armed, String id) {
        List<PageWorld.Frame> frames = armed.frames().others();
        if (frames.isEmpty()) {
            return;
        }
        try {
            module.world.runInAll(tab, frames, Map.of("op", "disarm", "id", id), module.timing.request());
        } catch (CdpFailure e) {
            // Each lets go by itself.
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ---- small things

    private Map<String, Object> page(TabRef tab, Map<String, Object> args) throws RpcException, InterruptedException {
        try {
            return module.world.run(tab, args, module.timing.request());
        } catch (CdpFailure e) {
            throw e.kind() == CdpFailure.Kind.REMOTE ? refused("changed") : MinifiedModule.unavailable();
        }
    }

    private Number pinned(TabRef tab) throws RpcException, InterruptedException {
        try {
            return module.world.topContext(tab, module.timing.request());
        } catch (CdpFailure e) {
            throw e.kind() == CdpFailure.Kind.REMOTE ? refused("changed") : MinifiedModule.unavailable();
        }
    }

    private Map<String, Object> page(TabRef tab, Number context, Map<String, Object> args) throws RpcException, InterruptedException {
        try {
            return module.world.runIn(tab, context, args, module.timing.request());
        } catch (CdpFailure e) {
            throw e.kind() == CdpFailure.Kind.REMOTE ? refused("changed") : MinifiedModule.unavailable();
        }
    }

    /** A refusal from the page: a sensitive field is remembered as one for the rest of this document. */
    private void refuseIf(MinifiedModule.TabState state, MDoc.Node node, Map<String, Object> answer) throws RpcException {
        Object reason = answer.get("refused");
        if (reason == null) {
            if (answer.get("error") != null || Boolean.TRUE.equals(answer.get("missing"))) {
                throw refused("changed");
            }
            return;
        }
        if ("sensitive".equals(reason)) {
            module.lock.lock();
            try {
                state.sensitiveRefs.add(node.id());
            } finally {
                module.lock.unlock();
            }
            throw sensitive(answer.get("kind") instanceof String kind ? kind : null);
        }
        throw refused(reason instanceof String r && REFUSALS.contains(r) ? r : "changed");
    }

    private static final Set<String> REFUSALS =
            Set.of("changed", "gone", "covered", "frame_near", "hidden", "disabled", "focus", "label", "kind", "frames");

    private static void requireKind(MDoc.Node node, MDoc.NodeKind... kinds) throws RpcException {
        for (MDoc.NodeKind kind : kinds) {
            if (node.kind() == kind) {
                return;
            }
        }
        throw refused("kind");
    }

    /** Last chance for the call to be stopped, and the token checked as it is now. Null for deskd's own press. */
    private static void begin(RpcContext context) throws RpcException {
        if (context == null) {
            return;
        }
        if (!context.principal().input()) {
            throw MinifiedMethods.forbidden();
        }
        context.beginEffect();
    }

    private RpcException afterEffect(MinifiedModule.TabState state) {
        module.markDirty(state);
        return MinifiedModule.unavailable();
    }

    static RpcException refused(String reason) {
        return new RpcException(RpcException.CONFLICT, "The page changed, or can't take this safely", Map.of("reason", reason));
    }

    static RpcException sensitive(String kind) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", "sensitive");
        if (kind != null) {
            details.put("kind", kind);
        }
        return new RpcException(RpcException.FORBIDDEN, "Only the full view takes this field", details);
    }

    private static boolean seen(Map<String, Object> got, String type) {
        return got.get("seen") instanceof Map<?, ?> seen && seen.get(type) instanceof Number n && n.intValue() > 0;
    }

    private static Map<String, Object> outcome(boolean done, String reason) {
        Map<String, Object> outcome = new LinkedHashMap<>();
        outcome.put("done", done);
        if (reason != null) {
            outcome.put("reason", reason);
        }
        return outcome;
    }

    private static String newId() {
        byte[] bytes = new byte[8];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
