package com.minimalistalliance.desk.deskd.testing;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Stands in for Chromium's debugging port on real sockets: GET /json/version and /json/list, and the
 * browser-level WebSocket on the same port, framing included, with flat sessions. It behaves as Chrome
 * 156 did when probed for ADR 0041, and a test can make it hang, refuse, flood or lie.
 */
public final class FakeCdp implements AutoCloseable {

    /** One command deskd sent. */
    public record Command(String method, String sessionId, Map<String, Object> params) {}

    private record HeldCommand(String method, long id, String sessionId, Map<String, Object> params) {}

    /** An isolated world, made in one document of a tab. It goes when that document does. */
    private record World(String targetId, long loader) {}

    /** Chromium's own error page, as a frame's URL says while it's shown. */
    public static final String ERROR_PAGE_URL = "chrome-error://chromewebdata/";

    /** One target. Tests change these through the methods here. */
    public static final class Target {
        final String id;
        final String type;
        final String subtype;
        String url;
        String title;
        final List<String> history = new ArrayList<>();
        int index;
        /** Which document the main frame holds: each commit makes a new one. */
        long loader;
        /** The net error the main frame's error page shows, without {@code net::}, or null if it isn't one. */
        String errorCode;
        /** What a script wrote over the error page, or null. */
        String written;
        /** Made with {@code hidden}: in no window, not discovered or listed, as Chrome 156's hidden targets. */
        boolean hidden;
        String context = "ctx";
        /** The target that opened this one, as a pop-up's, or null. */
        String opener;

        Target(String id, String type, String subtype, String url, String title) {
            this.id = id;
            this.type = type;
            this.subtype = subtype;
            this.url = url;
            this.title = title;
            history.add(url);
        }

        Map<String, Object> info() {
            Map<String, Object> info = new LinkedHashMap<>();
            info.put("targetId", id);
            info.put("type", type);
            if (subtype != null) {
                info.put("subtype", subtype);
            }
            info.put("title", title);
            info.put("url", url);
            info.put("attached", false);
            info.put("browserContextId", context);
            if (opener != null) {
                info.put("openerId", opener);
            }
            return info;
        }
    }

    private final ServerSocket server;
    private final int port;
    private final ReentrantLock lock = new ReentrantLock();
    private final List<Target> targets = new ArrayList<>();
    private final List<String> activation = new ArrayList<>();
    private final List<Command> commands = new CopyOnWriteArrayList<>();
    private final List<String> originHeaders = new CopyOnWriteArrayList<>();
    private final List<Socket> sockets = new CopyOnWriteArrayList<>();
    private final Map<String, Integer> httpRequests = new ConcurrentHashMap<>();
    private final Set<String> heldMethods = ConcurrentHashMap.newKeySet();
    private final List<HeldCommand> heldCommands = new CopyOnWriteArrayList<>();
    private final Set<String> hungTabs = ConcurrentHashMap.newKeySet();
    private final Map<Long, World> isolatedWorlds = new ConcurrentHashMap<>();
    private final AtomicLong nextLoader = new AtomicLong(0xA000);
    private final Map<String, String> failingNavigations = new ConcurrentHashMap<>();
    private final AtomicLong nextWorld = new AtomicLong(1000);
    private final Map<String, String> navigateErrors = new ConcurrentHashMap<>();
    private final Map<String, Integer> forcedErrors = new ConcurrentHashMap<>();
    private final Map<String, Runnable> afterReply = new ConcurrentHashMap<>();
    private final Map<String, Integer> splitReplies = new ConcurrentHashMap<>();
    private final Map<String, java.util.function.Function<Command, Object>> answers = new ConcurrentHashMap<>();
    /** Runtime.evaluate's scripted answers, by a piece of the expression, ahead of the three scripts below. */
    private final Map<String, java.util.function.Function<Command, Object>> expressionAnswers = new ConcurrentHashMap<>();
    private final AtomicInteger upgrades = new AtomicInteger();
    private final AtomicInteger nextTarget = new AtomicInteger(1);
    private final ReentrantLock writeLock = new ReentrantLock();
    /** The one tab on screen. /json/list's first isn't always it: see {@link #addBackgroundPage}. */
    private String visible;
    private volatile Connection connection;
    private volatile boolean hangHttp;
    private volatile String rawList;
    private volatile String rawTargets;
    private volatile boolean refuseUpgrade;
    private volatile boolean closed;
    private volatile List<Map<String, Object>> cookies = List.of();
    private final Set<String> contexts = ConcurrentHashMap.newKeySet();
    /** As a Chromium that doesn't know {@code hidden}: every target is an ordinary one. */
    private volatile boolean ignoreHidden;
    /** As a Chromium whose getTargets lists hidden targets too. */
    private volatile boolean listHidden;

    public FakeCdp() throws IOException {
        this(0);
    }

    public FakeCdp(int port) throws IOException {
        server = new ServerSocket(port, 50, InetAddress.getLoopbackAddress());
        this.port = server.getLocalPort();
        Thread.ofVirtual().name("fake-cdp-accept").start(this::acceptLoop);
    }

    public int port() {
        return port;
    }

    public void addPage(String id, String url, String title) {
        add(new Target(id, "page", null, url, title));
    }

    public void addTarget(String id, String type, String subtype, String url, String title) {
        add(new Target(id, type, subtype, url, title));
    }

    /**
     * As a member's middle click on a link: Chromium sorts /json/list by when a tab was last shown or
     * made, so this comes first, and it's hidden, and what was on screen still is.
     */
    public void addBackgroundPage(String id, String url, String title) {
        add(new Target(id, "page", null, url, title), false);
    }

    private void add(Target target) {
        add(target, true);
    }

    private void add(Target target, boolean foreground) {
        lock.lock();
        try {
            targets.add(target);
            if (target.hidden) {
                // Chromium tells nobody of a hidden target, and it's never on screen.
                return;
            }
            if ("page".equals(target.type)) {
                activation.add(0, target.id);
                if (foreground) {
                    visible = target.id;
                }
            }
        } finally {
            lock.unlock();
        }
        Connection current = connection;
        if (current != null) {
            event("Target.targetCreated", Map.of("targetInfo", target.info()), null);
        }
    }

    /**
     * As a member changing tabs on the keyboard: no event says so. Activating the tab on screen changes
     * nothing, not even the order, as Chrome 156 did.
     */
    public void activateQuietly(String id) {
        lock.lock();
        try {
            if (!id.equals(visible)) {
                activation.remove(id);
                activation.add(0, id);
                visible = id;
            }
        } finally {
            lock.unlock();
        }
    }

    public String firstInList() {
        lock.lock();
        try {
            return activation.isEmpty() ? null : activation.get(0);
        } finally {
            lock.unlock();
        }
    }

    /** A hung renderer: the target's still listed and can be attached to, and commands on it get no reply. */
    /** A pop-up a page opened: a new page in that context, with that opener, as Chromium tells of one. */
    public void addPopup(String id, String url, String opener, String context) {
        Target target = new Target(id, "page", null, url, "");
        target.opener = opener;
        target.context = context;
        add(target, false);
    }

    /** The default context's id, as every ordinary target has it. */
    public static final String DEFAULT_CONTEXT = "ctx";

    /** As a Chromium that doesn't know {@code Target.createTarget}'s {@code hidden}: it makes ordinary tabs. */
    public void ignoreHidden(boolean on) {
        ignoreHidden = on;
    }

    /** As a Chromium whose Target.getTargets lists hidden targets. */
    public void listHidden(boolean on) {
        listHidden = on;
    }

    /** The browser contexts made and not disposed of. */
    public Set<String> contexts() {
        return Set.copyOf(contexts);
    }

    /** Whether a target is there now, hidden or not. */
    public boolean has(String id) {
        return find(id) != null;
    }

    /** The ids of the targets now, hidden ones too. */
    public List<String> targetIds() {
        List<String> ids = new ArrayList<>();
        for (Target target : snapshot()) {
            ids.add(target.id);
        }
        return ids;
    }

    /** The context a target is in, or null if it isn't there. */
    public String contextOf(String id) {
        Target target = find(id);
        return target == null ? null : target.context;
    }

    public boolean hidden(String id) {
        Target target = find(id);
        return target != null && target.hidden;
    }

    public void hangTab(String id, boolean on) {
        if (on) {
            hungTabs.add(id);
        } else {
            hungTabs.remove(id);
        }
    }

    /** As a link clicked in the page: only events say so. */
    public void navigateInPage(String id, String url, String title) {
        commit(id, url, title, null);
    }

    /**
     * As a navigation in the main frame that failed with this net error, given without {@code net::}: Chromium commits its
     * own error page, whose frame has the failed URL as {@code unreachableUrl} and its title the host, as Chrome 156 did.
     */
    public void failNavigation(String id, String url, String errorCode) {
        commit(id, url, java.net.URI.create(url).getHost(), errorCode);
    }

    /** As a subframe of this tab failing: its frame has a parent, and the tab's own page doesn't change. */
    public void failSubframe(String id, String url, String errorCode) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("id", "SUB" + id);
        frame.put("parentId", id);
        frame.put("loaderId", Long.toHexString(nextLoader.incrementAndGet()).toUpperCase(Locale.ROOT));
        frame.put("url", ERROR_PAGE_URL);
        frame.put("unreachableUrl", url);
        event("Page.frameNavigated", Map.of("frame", frame), sessionOf(id));
    }

    /** Page.navigate to this URL fails with this net error, given without {@code net::}, and commits the error page. */
    public void navigateFails(String url, String errorCode) {
        failingNavigations.put(url, errorCode);
    }

    /** What a script wrote over this tab's error page, or null if nothing has. */
    public String written(String id) {
        Target target = find(id);
        lock.lock();
        try {
            return target.written;
        } finally {
            lock.unlock();
        }
    }

    private void commit(String id, String url, String title, String errorCode) {
        Target target = find(id);
        long loader = nextLoader.incrementAndGet();
        lock.lock();
        try {
            target.history.subList(target.index + 1, target.history.size()).clear();
            target.history.add(url);
            target.index = target.history.size() - 1;
            target.url = url;
            target.title = title;
            target.loader = loader;
            target.errorCode = errorCode;
            target.written = null;
        } finally {
            lock.unlock();
        }
        String session = sessionOf(id);
        event("Page.frameStartedLoading", Map.of("frameId", id), session);
        event("Page.frameNavigated", Map.of("frame", frame(id, url, loader, errorCode != null)), session);
        if (!target.hidden) {
            event("Target.targetInfoChanged", Map.of("targetInfo", target.info()), null);
        }
        event("Page.frameStoppedLoading", Map.of("frameId", id), session);
    }

    private static Map<String, Object> frame(String id, String url, long loader, boolean error) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("id", id);
        frame.put("loaderId", Long.toHexString(loader).toUpperCase(Locale.ROOT));
        frame.put("url", error ? ERROR_PAGE_URL : url);
        if (error) {
            frame.put("unreachableUrl", url);
        }
        return frame;
    }

    /** As a page setting document.title: Chromium sends no event, and Target.getTargets and /json/list have it. */
    public void setTitle(String id, String title) {
        Target target = find(id);
        lock.lock();
        try {
            target.title = title;
        } finally {
            lock.unlock();
        }
    }

    /** A title Chromium does tell of, since something else changed at the same time, as a URL can. */
    public void setTitleWithEvent(String id, String title) {
        setTitle(id, title);
        event("Target.targetInfoChanged", Map.of("targetInfo", find(id).info()), null);
    }

    public static String sessionOf(String targetId) {
        return "S" + targetId;
    }

    public void removeQuietly(String id) {
        lock.lock();
        try {
            targets.removeIf(target -> target.id.equals(id));
            activation.remove(id);
            if (id.equals(visible)) {
                visible = activation.isEmpty() ? null : activation.get(0);
            }
        } finally {
            lock.unlock();
        }
    }

    /** A tab going, as Chromium tells of it. */
    public void destroy(String id) {
        removeQuietly(id);
        event("Target.targetDestroyed", Map.of("targetId", id), null);
    }

    /** The next reply to this method goes as two frames, the first only this many bytes, as a WebSocket may split it. */
    public void splitNextReply(String method, int firstBytes) {
        splitReplies.put(method, firstBytes);
    }

    /** Runs once, on the thread that wrote the next reply to this method, so whatever it sends comes straight after that. */
    public void afterNextReply(String method, Runnable action) {
        afterReply.put(method, action);
    }

    /** Commands with this method get no reply until {@link #release}. */
    public void hold(String method) {
        heldMethods.add(method);
    }

    public void release(String method) {
        heldMethods.remove(method);
    }

    /** Releases the method and answers what was held, as a page that was only slow would. */
    public void answerHeld(String method) {
        heldMethods.remove(method);
        Connection current = connection;
        for (HeldCommand held : heldCommands) {
            if (held.method().equals(method)) {
                heldCommands.remove(held);
                if (current != null) {
                    current.respond(held.id(), held.method(), held.sessionId(), held.params());
                }
            }
        }
    }

    /** Answers only the last of what's held for this method, so a later command gets its reply first. */
    public void answerNewestHeld(String method) {
        Connection current = connection;
        for (int i = heldCommands.size() - 1; i >= 0; i--) {
            HeldCommand held = heldCommands.get(i);
            if (held.method().equals(method)) {
                heldCommands.remove(i);
                if (current != null) {
                    current.respond(held.id(), held.method(), held.sessionId(), held.params());
                }
                return;
            }
        }
    }

    /** What /json/list answers from now on, as it is. */
    public void rawList(String json) {
        rawList = json;
    }

    /** The targetInfos Target.getTargets answers with from now on, as they are. */
    public void rawTargets(String json) {
        rawTargets = json;
    }

    /** What Storage.getCookies answers from now on, as Chromium lists them. */
    public void cookies(List<Map<String, Object>> list) {
        cookies = List.copyOf(list);
    }

    public void hangHttp(boolean on) {
        hangHttp = on;
    }

    public void refuseUpgrade(boolean on) {
        refuseUpgrade = on;
    }

    /** Page.navigate to this URL answers with this errorText. */
    public void navigateError(String url, String errorText) {
        navigateErrors.put(url, errorText);
    }

    /**
     * This method answers with whatever the function gives for each command: the reply's {@code result}, or, for a map
     * holding {@code _error}, a CDP error of that code. For what the simplified view asks of a page.
     */
    public void answer(String method, java.util.function.Function<Command, Object> result) {
        answers.put(method, result);
    }

    /**
     * Runtime.evaluate of an expression holding {@code piece} answers with what the function gives (the reply's
     * {@code result}), and every other expression as before: for Chromium's own pages, which the sign-ins wait on.
     */
    public void answerExpression(String piece, java.util.function.Function<Command, Object> result) {
        expressionAnswers.put(piece, result);
    }

    /** This method answers with a CDP error of this code. */
    public void forceError(String method, int code) {
        forcedErrors.put(method, code);
    }

    public void clearForcedErrors() {
        forcedErrors.clear();
    }

    public List<Command> commands() {
        return List.copyOf(commands);
    }

    public List<Command> commands(String method) {
        return commands.stream().filter(command -> command.method().equals(method)).toList();
    }

    public void clearCommands() {
        commands.clear();
    }

    public int upgrades() {
        return upgrades.get();
    }

    public List<String> originHeaders() {
        return List.copyOf(originHeaders);
    }

    public int httpRequests(String path) {
        return httpRequests.getOrDefault(path, 0);
    }

    public boolean isConnected() {
        Connection current = connection;
        return current != null && !current.socket.isClosed();
    }

    /** Whatever's in the JSON, sent raw. */
    public void sendRaw(String text) {
        Connection current = connection;
        if (current != null) {
            current.sendText(text);
        }
    }

    public void event(String method, Map<String, Object> params, String sessionId) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("method", method);
        message.put("params", params);
        if (sessionId != null) {
            message.put("sessionId", sessionId);
        }
        sendRaw(new String(Json.bytes(message), StandardCharsets.UTF_8));
    }

    /**
     * As deskd's isolated world in the tab calls the binding deskd last added on the tab's session, which is what its
     * protected-media listener does once the page is refused (deskd's {@code ProtectedMedia}).
     */
    public void bindingCalled(String targetId, String payload) {
        String session = sessionOf(targetId);
        Command added = null;
        for (Command command : commands("Runtime.addBinding")) {
            if (session.equals(command.sessionId())) {
                added = command;
            }
        }
        if (added == null) {
            throw new IllegalStateException("no binding on " + targetId);
        }
        bindingCalled(targetId, (String) added.params().get("name"), payload);
    }

    /** A binding of any name called on the tab's session. */
    public void bindingCalled(String targetId, String name, String payload) {
        event("Runtime.bindingCalled", Map.<String, Object>of("name", name, "payload", payload, "executionContextId", 1), sessionOf(targetId));
    }

    private final java.util.concurrent.atomic.AtomicInteger scriptIds = new java.util.concurrent.atomic.AtomicInteger();

    /** Cuts the WebSocket, as Chromium crashing would. */
    public void dropConnections() throws IOException {
        Connection current = connection;
        connection = null;
        if (current != null) {
            current.socket.close();
        }
    }

    @Override
    public void close() throws IOException {
        closed = true;
        server.close();
        dropConnections();
        for (Socket socket : sockets) {
            socket.close();
        }
    }

    private Target find(String id) {
        lock.lock();
        try {
            return targets.stream().filter(target -> target.id.equals(id)).findFirst().orElse(null);
        } finally {
            lock.unlock();
        }
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket socket = server.accept();
                sockets.add(socket);
                Thread.ofVirtual().name("fake-cdp-conn").start(() -> serve(socket));
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket socket) {
        try (socket) {
            InputStream in = socket.getInputStream();
            OutputStream out = socket.getOutputStream();
            String head = readHead(in);
            if (head == null) {
                return;
            }
            String[] lines = head.split("\r\n");
            String path = lines[0].split(" ")[1];
            Map<String, String> headers = new LinkedHashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) {
                    headers.put(lines[i].substring(0, colon).toLowerCase(Locale.ROOT), lines[i].substring(colon + 1).trim());
                }
            }
            if ("websocket".equalsIgnoreCase(headers.get("upgrade"))) {
                upgrade(socket, in, out, path, headers);
            } else {
                http(out, path);
            }
        } catch (IOException e) {
            // The other side went, as it may.
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int previous = 0;
        int run = 0;
        while (true) {
            int b = in.read();
            if (b < 0) {
                return null;
            }
            head.write(b);
            run = (b == '\n' && previous == '\r') ? run + 1 : (b == '\r' ? run : 0);
            previous = b;
            if (run == 2) {
                return head.toString(StandardCharsets.ISO_8859_1);
            }
        }
    }

    private void http(OutputStream out, String path) throws IOException, InterruptedException {
        httpRequests.merge(path, 1, Integer::sum);
        if (hangHttp) {
            Thread.sleep(60_000);
            return;
        }
        String body;
        switch (path) {
            case "/json/version" -> body = new String(Json.bytes(Map.of(
                    "Browser", "Fake/1",
                    // A host that isn't the one deskd should use, to prove it takes only the path.
                    "webSocketDebuggerUrl", "ws://evil.example:1/devtools/browser/fake-browser-1")), StandardCharsets.UTF_8);
            case "/json/list" -> body = rawList != null ? rawList : jsonList();
            default -> {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                return;
            }
        }
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + bytes.length
                + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.flush();
    }

    private String jsonList() {
        lock.lock();
        try {
            List<Map<String, Object>> list = new ArrayList<>();
            for (String id : activation) {
                Target target = find(id);
                if (target != null) {
                    list.add(Map.of("id", target.id, "type", target.type, "url", target.url, "title", escapedForHtml(target.title)));
                }
            }
            for (Target target : targets) {
                if (!"page".equals(target.type) || target.hidden) {
                    // A hidden target is listed here, as "other", and nowhere else (Chrome 156).
                    list.add(Map.of("id", target.id, "type", target.hidden ? "other" : target.type, "url", target.url,
                            "title", escapedForHtml(target.title)));
                }
            }
            String wrapped = new String(Json.bytes(Map.of("l", list)), StandardCharsets.UTF_8);
            return wrapped.substring(5, wrapped.length() - 1);
        } finally {
            lock.unlock();
        }
    }

    /** What Chromium does to a title in /json/list, and only there, as Chrome 156 did when probed. */
    private static String escapedForHtml(String title) {
        return title.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#39;");
    }

    private void upgrade(Socket socket, InputStream in, OutputStream out, String path, Map<String, String> headers)
            throws IOException, InterruptedException {
        if (headers.containsKey("origin")) {
            originHeaders.add(headers.get("origin"));
        }
        if (refuseUpgrade || !path.equals("/devtools/browser/fake-browser-1")) {
            out.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            return;
        }
        upgrades.incrementAndGet();
        String accept;
        try {
            accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest(
                    (headers.get("sec-websocket-key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
        Connection current = new Connection(socket, out);
        connection = current;
        current.readLoop(new DataInputStream(in));
    }

    private final class Connection {
        final Socket socket;
        final OutputStream out;

        Connection(Socket socket, OutputStream out) {
            this.socket = socket;
            this.out = out;
        }

        void sendText(String text) {
            byte[] payload = text.getBytes(StandardCharsets.UTF_8);
            writeLock.lock();
            try {
                byte[] head;
                if (payload.length < 126) {
                    head = new byte[] {(byte) 0x81, (byte) payload.length};
                } else if (payload.length < 65536) {
                    head = new byte[] {(byte) 0x81, 126, (byte) (payload.length >> 8), (byte) payload.length};
                } else {
                    head = new byte[] {(byte) 0x81, 127, 0, 0, 0, 0,
                            (byte) (payload.length >> 24), (byte) (payload.length >> 16), (byte) (payload.length >> 8), (byte) payload.length};
                }
                out.write(head);
                out.write(payload);
                out.flush();
            } catch (IOException e) {
                // A test may have cut it.
            } finally {
                writeLock.unlock();
            }
        }

        void readLoop(DataInputStream in) throws IOException {
            // The JDK's client sends a long text as several frames, as a real one may.
            ByteArrayOutputStream message = new ByteArrayOutputStream();
            while (true) {
                int first = in.read();
                if (first < 0) {
                    return;
                }
                int second = in.readUnsignedByte();
                long length = second & 0x7F;
                if (length == 126) {
                    length = in.readUnsignedShort();
                } else if (length == 127) {
                    length = in.readLong();
                }
                byte[] mask = new byte[4];
                if ((second & 0x80) != 0) {
                    in.readFully(mask);
                }
                byte[] payload = new byte[(int) length];
                in.readFully(payload);
                for (int i = 0; i < payload.length; i++) {
                    payload[i] ^= mask[i % 4];
                }
                switch (first & 0x0F) {
                    case 8 -> {
                        return;
                    }
                    case 0, 1 -> {
                        message.write(payload);
                        if ((first & 0x80) != 0) {
                            onCommand(message.toByteArray());
                            message.reset();
                        }
                    }
                    default -> {
                        // Pings and the like: nothing in these tests needs them answered.
                    }
                }
            }
        }

        private void onCommand(byte[] payload) {
            Map<String, Object> message;
            try {
                message = Json.parseObject(payload);
            } catch (JsonFormatException e) {
                throw new IllegalStateException("deskd sent bad JSON", e);
            }
            String method = Json.string(message, "method");
            String sessionId = Json.string(message, "sessionId");
            Map<String, Object> params = Json.object(message, "params");
            commands.add(new Command(method, sessionId, params));
            long id = ((Number) message.get("id")).longValue();
            if (sessionId != null && hungTabs.contains(sessionId.substring(1))) {
                return;
            }
            if (heldMethods.contains(method)) {
                heldCommands.add(new HeldCommand(method, id, sessionId, params));
                return;
            }
            respond(id, method, sessionId, params);
        }

        void respond(long id, String method, String sessionId, Map<String, Object> params) {
            sendReply(id, method, sessionId, params);
            Runnable after = afterReply.remove(method);
            if (after != null) {
                after.run();
            }
        }

        private void sendReply(long id, String method, String sessionId, Map<String, Object> params) {
            String rawInfos = rawTargets;
            if (rawInfos != null && "Target.getTargets".equals(method) && !forcedErrors.containsKey(method)) {
                sendText("{\"id\":" + id + ",\"result\":{\"targetInfos\":" + rawInfos + "}}");
                return;
            }
            Map<String, Object> reply = new LinkedHashMap<>();
            reply.put("id", id);
            if (sessionId != null) {
                reply.put("sessionId", sessionId);
            }
            Integer forced = forcedErrors.get(method);
            if (forced != null) {
                reply.put("error", Map.of("code", forced, "message", "forced"));
            } else if (sessionId != null && find(sessionId.substring(1)) == null) {
                reply.put("error", Map.of("code", -32001, "message", "Session with given id not found"));
            } else {
                answer(method, sessionId, params, reply);
            }
            Integer split = splitReplies.remove(method);
            if (split != null) {
                sendSplit(Json.bytes(reply), split);
                return;
            }
            sendText(new String(Json.bytes(reply), StandardCharsets.UTF_8));
        }

        /** A text message as a first frame of {@code first} bytes and a continuation frame of the rest. */
        private void sendSplit(byte[] payload, int first) {
            writeLock.lock();
            try {
                out.write(new byte[] {0x01, (byte) first});
                out.write(payload, 0, first);
                int rest = payload.length - first;
                if (rest < 126) {
                    out.write(new byte[] {(byte) 0x80, (byte) rest});
                } else if (rest < 65536) {
                    out.write(new byte[] {(byte) 0x80, 126, (byte) (rest >> 8), (byte) rest});
                } else {
                    out.write(new byte[] {(byte) 0x80, 127, 0, 0, 0, 0, (byte) (rest >> 24), (byte) (rest >> 16), (byte) (rest >> 8), (byte) rest});
                }
                out.write(payload, first, rest);
                out.flush();
            } catch (IOException e) {
                // A test may have cut it.
            } finally {
                writeLock.unlock();
            }
        }

        private void answer(String method, String sessionId, Map<String, Object> params, Map<String, Object> reply) {
            java.util.function.Function<Command, Object> scripted = answers.get(method);
            if (scripted != null) {
                Object result = scripted.apply(new Command(method, sessionId, params));
                if (result instanceof Map<?, ?> map && map.get("_error") instanceof Number code) {
                    reply.put("error", Map.of("code", code, "message", "scripted"));
                } else {
                    reply.put("result", result);
                }
                return;
            }
            Target onSession = sessionId == null ? null : find(sessionId.substring(1));
            String targetId = Json.string(params, "targetId");
            switch (method) {
                case "Target.setDiscoverTargets" -> {
                    reply.put("result", Map.of());
                    for (Target target : snapshot()) {
                        if (!target.hidden) {
                            event("Target.targetCreated", Map.of("targetInfo", target.info()), null);
                        }
                    }
                }
                case "Target.getTargets" -> {
                    List<Map<String, Object>> infos = new ArrayList<>();
                    for (Target target : snapshot()) {
                        if (!target.hidden || listHidden) {
                            infos.add(target.info());
                        }
                    }
                    reply.put("result", Map.of("targetInfos", infos));
                }
                case "Target.createBrowserContext" -> {
                    String context = "CTX" + nextTarget.getAndIncrement();
                    contexts.add(context);
                    reply.put("result", Map.of("browserContextId", context));
                }
                case "Target.disposeBrowserContext" -> {
                    String context = Json.string(params, "browserContextId");
                    if (context == null || !contexts.remove(context)) {
                        reply.put("error", Map.of("code", -32602, "message", "Failed to find context with id"));
                    } else {
                        lock.lock();
                        try {
                            targets.removeIf(target -> context.equals(target.context));
                        } finally {
                            lock.unlock();
                        }
                        reply.put("result", Map.of());
                    }
                }
                case "Target.getTargetInfo" -> {
                    Target target = find(targetId);
                    if (target == null) {
                        reply.put("error", Map.of("code", -32602, "message", "No target with given id found"));
                    } else {
                        lock.lock();
                        try {
                            reply.put("result", Map.of("targetInfo", target.info()));
                        } finally {
                            lock.unlock();
                        }
                    }
                }
                case "Browser.getWindowForTarget" -> {
                    Target target = find(targetId);
                    if (target == null || target.hidden) {
                        reply.put("error", Map.of("code", -32000, "message", "Browser window not found"));
                    } else {
                        reply.put("result", Map.of("windowId", 1, "bounds", Map.of("left", 0, "top", 0, "width", 1920, "height", 1080)));
                    }
                }
                case "Target.attachToTarget" -> {
                    if (find(targetId) == null) {
                        reply.put("error", Map.of("code", -32602, "message", "No target with given id found"));
                    } else {
                        reply.put("result", Map.of("sessionId", sessionOf(targetId)));
                    }
                }
                case "Target.activateTarget" -> {
                    if (find(targetId) == null) {
                        reply.put("error", Map.of("code", -32602, "message", "No target with given id found"));
                    } else {
                        activateQuietly(targetId);
                        reply.put("result", Map.of());
                    }
                }
                case "Target.createTarget" -> {
                    String id = "T" + nextTarget.getAndIncrement();
                    Target created = new Target(id, "page", null, Json.string(params, "url"), "");
                    created.hidden = Boolean.TRUE.equals(params.get("hidden")) && !ignoreHidden;
                    if (params.get("browserContextId") instanceof String context) {
                        created.context = context;
                    }
                    // A hidden one is never on screen and nobody is told of it (add); Chromium's own pages
                    // (ChromiumPages) and the Agent's (AgentBrowsing) both make them.
                    add(created, !created.hidden);
                    reply.put("result", Map.of("targetId", id));
                }
                case "Target.closeTarget" -> {
                    Target closing = find(targetId);
                    if (closing == null) {
                        reply.put("error", Map.of("code", -32602, "message", "No target with given id found"));
                    } else {
                        removeQuietly(targetId);
                        if (!closing.hidden) {
                            event("Target.targetDestroyed", Map.of("targetId", targetId), null);
                        }
                        reply.put("result", Map.of("success", true));
                    }
                }
                case "Page.createIsolatedWorld" -> {
                    long world = nextWorld.incrementAndGet();
                    lock.lock();
                    try {
                        isolatedWorlds.put(world, new World(onSession.id, onSession.loader));
                    } finally {
                        lock.unlock();
                    }
                    reply.put("result", Map.of("executionContextId", world));
                }
                case "Runtime.evaluate" -> evaluate(onSession, params, reply);
                case "Page.getFrameTree" -> {
                    lock.lock();
                    try {
                        reply.put("result", Map.of("frameTree", Map.of(
                                "frame", frame(onSession.id, onSession.url, onSession.loader, onSession.errorCode != null))));
                    } finally {
                        lock.unlock();
                    }
                }
                case "Page.navigate" -> {
                    String url = Json.string(params, "url");
                    String error = navigateErrors.get(url);
                    String failing = failingNavigations.get(url);
                    Map<String, Object> result = new LinkedHashMap<>();
                    result.put("frameId", onSession.id);
                    if (error != null) {
                        result.put("errorText", error);
                    } else if (failing != null) {
                        result.put("errorText", "net::" + failing);
                        failNavigation(onSession.id, url, failing);
                    } else {
                        navigateInPage(onSession.id, url, url);
                    }
                    reply.put("result", result);
                }
                case "Page.getNavigationHistory" -> {
                    List<Map<String, Object>> entries = new ArrayList<>();
                    lock.lock();
                    try {
                        for (int i = 0; i < onSession.history.size(); i++) {
                            entries.add(Map.of("id", 100 + i, "url", onSession.history.get(i)));
                        }
                        reply.put("result", Map.of("currentIndex", onSession.index, "entries", entries));
                    } finally {
                        lock.unlock();
                    }
                }
                case "Page.navigateToHistoryEntry" -> {
                    int index = ((Number) params.get("entryId")).intValue() - 100;
                    long loader = nextLoader.incrementAndGet();
                    lock.lock();
                    try {
                        onSession.index = index;
                        onSession.url = onSession.history.get(index);
                        onSession.loader = loader;
                        onSession.errorCode = null;
                        onSession.written = null;
                    } finally {
                        lock.unlock();
                    }
                    event("Page.frameNavigated", Map.of("frame", frame(onSession.id, onSession.url, loader, false)), sessionId);
                    event("Target.targetInfoChanged", Map.of("targetInfo", onSession.info()), null);
                    reply.put("result", Map.of());
                }
                case "Page.addScriptToEvaluateOnNewDocument" ->
                    reply.put("result", Map.of("identifier", "script-" + scriptIds.incrementAndGet()));
                case "Storage.getCookies" -> reply.put("result", Map.of("cookies", cookies));
                default -> reply.put("result", Map.of());
            }
        }
    }

    /**
     * The three scripts deskd runs, told apart by what they read. A world made in a document that has gone since answers
     * as Chromium does, with an error. In the page's own world a hostile page can say what it likes, so only an isolated
     * world's answer about visibility is true.
     */
    private void evaluate(Target onSession, Map<String, Object> params, Map<String, Object> reply) {
        String expression = Json.string(params, "expression");
        for (Map.Entry<String, java.util.function.Function<Command, Object>> scripted : expressionAnswers.entrySet()) {
            if (expression != null && expression.contains(scripted.getKey())) {
                reply.put("result", scripted.getValue().apply(new Command("Runtime.evaluate", onSession == null ? null : sessionOf(onSession.id), params)));
                return;
            }
        }
        World world = params.get("contextId") instanceof Number id ? isolatedWorlds.get(id.longValue()) : null;
        lock.lock();
        try {
            // Only the error page's two are held to their document, so the visibility tests run as they always have.
            boolean ofErrorPage = !expression.contains("visibilityState");
            if (ofErrorPage && world != null && (!world.targetId().equals(onSession.id) || world.loader() != onSession.loader)) {
                reply.put("error", Map.of("code", -32000, "message", "Cannot find context with specified id"));
                return;
            }
            String value;
            if (expression.contains("visibilityState")) {
                value = world == null || onSession.id.equals(visible) ? "visible" : "hidden";
            } else if (expression.contains(".error-code")) {
                value = onSession.errorCode != null && onSession.written == null ? onSession.errorCode : "";
            } else if (expression.contains("document.write(") && onSession.errorCode != null && onSession.written == null) {
                onSession.written = expression;
                onSession.title = expression.contains("This site is filtered") ? "This site is filtered" : onSession.title;
                value = "written";
            } else {
                value = "";
            }
            reply.put("result", Map.of("result", Map.of("type", "string", "value", value)));
        } finally {
            lock.unlock();
        }
    }

    private List<Target> snapshot() {
        lock.lock();
        try {
            return new ArrayList<>(targets);
        } finally {
            lock.unlock();
        }
    }
}
