package com.minimalistalliance.desk.courier.testkit;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.java_websocket.WebSocket;
import org.java_websocket.drafts.Draft;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.framing.CloseFrame;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshakeBuilder;
import org.java_websocket.server.WebSocketServer;
import tools.jackson.jr.ob.JSON;

/**
 * A fake BlueBubbles Server in the test's own JVM, for the iMessage adapter's tests. It is the REST API under
 * {@code /api/v1}, a Socket.IO v4 socket (Engine.IO 4, websocket transport only) and webhooks, all on 127.0.0.1 and on
 * ports the system picks. The REST API and the socket sit on two ports: {@link #baseUrl()} and {@link #socketUrl()}.
 *
 * <p>The test plays the Mac. It adds chats, makes messages arrive ({@link #receive}), and breaks things ({@link #setDown},
 * {@link #dropSockets}, {@link #failNextSends}). The adapter under test connects out to it, as it will to a member's real
 * server, and catches up by time after a "sleep". Names, envelopes and field names follow the real server's.
 *
 * <p>State is guarded by one lock. Events go to sockets and webhooks after the lock is released, and webhooks are posted
 * before the call that caused them returns, so a test can look at its webhook receiver right away. While the server is
 * {@linkplain #setDown down} nothing is emitted.
 */
public final class FakeBlueBubbles implements AutoCloseable {

    /** The version {@code /server/info} reports. */
    public static final String SERVER_VERSION = "1.9.9";

    private static final JSON J = JSON.std.with(JSON.Feature.WRITE_NULL_PROPERTIES);
    private static final InetAddress LOOPBACK = loopback();

    /** What to start with. Use {@link #defaults}, then the {@code with} methods. */
    public record Options(String password, boolean privateApi, Duration pingInterval, Duration pingTimeout, Clock clock,
            javax.net.ssl.SSLContext tls) {
        public Options {
            Objects.requireNonNull(password, "password");
            Objects.requireNonNull(pingInterval, "pingInterval");
            Objects.requireNonNull(pingTimeout, "pingTimeout");
            Objects.requireNonNull(clock, "clock");
        }

        public Options(String password, boolean privateApi, Duration pingInterval, Duration pingTimeout, Clock clock) {
            this(password, privateApi, pingInterval, pingTimeout, clock, null);
        }

        /** Private API off, ping every 25 s with 20 s to answer (the real server's), the system clock, plain HTTP. */
        public static Options defaults(String password) {
            return new Options(password, false, Duration.ofSeconds(25), Duration.ofSeconds(20), Clock.systemUTC(), null);
        }

        public Options withPrivateApi(boolean on) {
            return new Options(password, on, pingInterval, pingTimeout, clock, tls);
        }

        public Options withPing(Duration interval, Duration timeout) {
            return new Options(password, privateApi, interval, timeout, clock, tls);
        }

        public Options withClock(Clock c) {
            return new Options(password, privateApi, pingInterval, pingTimeout, c, tls);
        }

        /** HTTPS and WSS with this server context ({@link FakeTls#serverContext()}: a self-signed certificate), as a Mac behind a port forward with its own certificate. */
        public Options withTls(javax.net.ssl.SSLContext ctx) {
            return new Options(password, privateApi, pingInterval, pingTimeout, clock, ctx);
        }
    }

    /** A contact card on the Mac, as {@code GET /api/v1/contact} lists it. */
    public record Contact(String firstName, String lastName, String displayName, List<String> phones, List<String> emails) {}

    /** A file on a message. */
    public record Attachment(String name, String mime, byte[] bytes) {}

    /** A webhook post that failed: a connection error (status 0) or a reply that wasn't 2xx. */
    public record WebhookFailure(URI url, String event, int status, String error) {}

    // ---- state ----

    private static final class Handle {
        long row;
        String address;
        String service;
    }

    private static final class Chat {
        long row;
        String guid;
        int style;
        String identifier;
        String displayName;
        String service;
        final List<String> participants = new ArrayList<>();
    }

    private static final class Att {
        long row;
        String guid;
        String name;
        String mime;
        byte[] bytes;
        boolean outgoing;
    }

    private static final class Msg {
        long row;
        String guid;
        String tempGuid;
        String chatGuid;
        String text;
        String subject;
        String fromAddress;
        boolean fromMe;
        long otherHandle;
        final List<Att> attachments = new ArrayList<>();
        long created;
        Long read;
        Long delivered;
        Long edited;
        Long retracted;
        String assocGuid;
        String assocType;
        String effect;
        String thread;
        int itemType;
        String groupTitle;
        int groupActionType;
    }

    /** Which parts of a message to include, as the request's {@code with} asks. */
    private record With(boolean chats, boolean participants, boolean attachments, boolean handle) {
        static final With ALL = new With(true, true, true, true);
        static final With NONE = new With(false, false, false, false);

        static With of(Collection<String> tokens) {
            boolean chats = false;
            boolean participants = false;
            boolean attachments = false;
            boolean handle = false;
            for (String raw : tokens) {
                switch (raw.trim().toLowerCase(Locale.ROOT)) {
                    case "chat", "chats" -> chats = true;
                    case "chat.participants", "chats.participants" -> {
                        chats = true;
                        participants = true;
                    }
                    case "attachment", "attachments" -> attachments = true;
                    case "handle" -> handle = true;
                    default -> { }
                }
            }
            return new With(chats, participants, attachments, handle);
        }
    }

    private static final class Bad extends RuntimeException {
        final int status;
        final String type;

        Bad(int status, String type, String message) {
            super(message);
            this.status = status;
            this.type = type;
        }
    }

    private static final class Sock {
        volatile boolean connected;
        volatile long pingSeq;
        volatile long ackedSeq;
        ScheduledFuture<?> task;
    }

    private final Object lock = new Object();
    private final Map<String, Chat> chats = new LinkedHashMap<>();
    private final Map<String, Handle> handles = new LinkedHashMap<>();
    private final Map<String, Att> attachmentsByGuid = new LinkedHashMap<>();
    private final List<Msg> msgs = new ArrayList<>();
    private final List<Msg> sentMsgs = new ArrayList<>();
    private final List<Contact> contacts = new ArrayList<>();
    private volatile boolean contactsDenied;
    private long nextMessageRow = 1;
    private long nextChatRow = 1;
    private long nextHandleRow = 1;
    private long nextAttachmentRow = 1;

    private final String password;
    private final Duration pingInterval;
    private final Duration pingTimeout;
    private volatile Clock clock;
    private volatile boolean privateApi;
    private volatile boolean down;
    private volatile Duration latency = Duration.ZERO;
    private int failSends;
    private int restarts;

    private final List<URI> webhooks = new CopyOnWriteArrayList<>();
    private final List<WebhookFailure> failures = new CopyOnWriteArrayList<>();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

    private final HttpServer httpServer;
    private final boolean tls;
    private final ExecutorService httpPool;
    private final ScheduledExecutorService pings = Executors.newSingleThreadScheduledExecutor(daemon("fake-bb-ping"));
    private final SocketServer socketServer;

    private FakeBlueBubbles(Options o) throws IOException {
        this.password = o.password();
        this.pingInterval = o.pingInterval();
        this.pingTimeout = o.pingTimeout();
        this.clock = o.clock();
        this.privateApi = o.privateApi();
        this.httpPool = Executors.newCachedThreadPool(daemon("fake-bb-http"));
        this.tls = o.tls() != null;
        if (tls) {
            com.sun.net.httpserver.HttpsServer https = com.sun.net.httpserver.HttpsServer.create(new InetSocketAddress(LOOPBACK, 0), 0);
            https.setHttpsConfigurator(new com.sun.net.httpserver.HttpsConfigurator(o.tls()));
            this.httpServer = https;
        } else {
            this.httpServer = HttpServer.create(new InetSocketAddress(LOOPBACK, 0), 0);
        }
        this.httpServer.setExecutor(httpPool);
        this.httpServer.createContext("/", this::handle);
        this.socketServer = new SocketServer();
        if (tls) {
            this.socketServer.setWebSocketFactory(new org.java_websocket.server.DefaultSSLWebSocketServerFactory(o.tls()));
        }
    }

    /** Starts with the Private API off and the real server's ping settings. */
    public static FakeBlueBubbles start(String password) {
        return start(Options.defaults(password));
    }

    public static FakeBlueBubbles start(Options options) {
        try {
            FakeBlueBubbles s = new FakeBlueBubbles(options);
            s.httpServer.start();
            s.socketServer.startAndWait();
            return s;
        } catch (IOException | InterruptedException e) {
            throw new IllegalStateException("fake BlueBubbles did not start: " + e, e);
        }
    }

    // ---- addresses ----

    /** The REST base, for example {@code http://127.0.0.1:41234}. The routes are under {@code /api/v1}. */
    public String baseUrl() {
        return (tls ? "https" : "http") + "://127.0.0.1:" + port();
    }

    public int port() {
        return httpServer.getAddress().getPort();
    }

    public int socketPort() {
        return socketServer.getPort();
    }

    /** The socket URL a client connects to, with the password as {@code guid}. */
    public String socketUrl() {
        return (tls ? "wss" : "ws") + "://127.0.0.1:" + socketPort() + "/socket.io/?EIO=4&transport=websocket&guid="
                + URLEncoder.encode(password, StandardCharsets.UTF_8);
    }

    public String password() {
        return password;
    }

    // ---- chats ----

    /** A one-to-one iMessage chat with {@code address}; returns its guid, {@code iMessage;-;<address>}. */
    public String directChat(String address) {
        return directChat(address, "iMessage");
    }

    /** A one-to-one chat on {@code service} ({@code iMessage} or {@code SMS}); returns its guid, {@code <service>;-;<address>}. */
    public String directChat(String address, String service) {
        return addChat(service + ";-;" + address, null, service, List.of(address));
    }

    /** A group chat; returns its guid, {@code iMessage;+;chat<digits>}. */
    public String groupChat(String name, String... addresses) {
        StringBuilder digits = new StringBuilder();
        java.util.concurrent.ThreadLocalRandom rnd = java.util.concurrent.ThreadLocalRandom.current();
        for (int i = 0; i < 18; i++) {
            digits.append(rnd.nextInt(10));
        }
        return addChat("iMessage;+;chat" + digits, name, "iMessage", List.of(addresses));
    }

    /** A chat with a guid you choose. A guid with {@code ;+;} is a group (style 43), any other a one-to-one (style 45). Returns the guid. */
    public String addChat(String guid, String displayName, String service, List<String> addresses) {
        synchronized (lock) {
            if (chats.containsKey(guid)) {
                throw new IllegalArgumentException("chat exists: " + guid);
            }
            Chat c = new Chat();
            c.row = nextChatRow++;
            c.guid = guid;
            c.style = guid.contains(";+;") ? 43 : 45;
            c.identifier = guid.substring(guid.lastIndexOf(';') + 1);
            c.displayName = displayName == null ? "" : displayName;
            c.service = service;
            for (String a : addresses) {
                handle(a, service);
                c.participants.add(a);
            }
            chats.put(guid, c);
            return guid;
        }
    }

    // ---- things that happen on the Mac ----

    /** A message from {@code fromAddress} in the chat, dated now. Emits {@code new-message}. Returns the message guid. */
    public String receive(String chatGuid, String fromAddress, String text) {
        return receive(chatGuid, fromAddress, text, null);
    }

    /** As above, dated {@code date} (null is now), with files. A date in the past is how a test fills the time the desk was asleep. */
    public String receive(String chatGuid, String fromAddress, String text, Instant date, Attachment... files) {
        Msg m;
        Map<String, Object> data;
        synchronized (lock) {
            Chat c = chat(chatGuid);
            if (!c.participants.contains(fromAddress)) {
                throw new IllegalArgumentException(fromAddress + " is not in " + chatGuid);
            }
            m = newMsg(c, "p:0/" + UUID.randomUUID(), date == null ? now() : date.toEpochMilli());
            m.fromAddress = fromAddress;
            m.text = text;
            m.delivered = m.created;
            for (Attachment f : files) {
                m.attachments.add(attachment(f, false));
            }
            data = json(m, With.ALL, false);
        }
        emit("new-message", data);
        return m.guid;
    }

    /** A tapback on {@code targetGuid}: {@code love, like, dislike, laugh, emphasize, question}, or the same with a leading {@code -} to remove it. Emits {@code new-message}. */
    public String tapback(String chatGuid, String fromAddress, String targetGuid, String type) {
        Msg m;
        Map<String, Object> data;
        synchronized (lock) {
            Chat c = chat(chatGuid);
            if (find(targetGuid) == null) {
                throw new IllegalArgumentException("no message " + targetGuid);
            }
            m = newMsg(c, "p:0/" + UUID.randomUUID(), now());
            m.fromAddress = fromAddress;
            m.delivered = m.created;
            m.assocGuid = "p:0/" + targetGuid;
            m.assocType = type;
            data = json(m, With.ALL, false);
        }
        emit("new-message", data);
        return m.guid;
    }

    /** Changes the text, sets {@code dateEdited} to now, and emits {@code updated-message}. */
    public void edit(String messageGuid, String newText) {
        Map<String, Object> data;
        synchronized (lock) {
            Msg m = find(messageGuid);
            if (m == null) {
                throw new IllegalArgumentException("no message " + messageGuid);
            }
            m.text = newText;
            m.edited = now();
            data = json(m, With.ALL, false);
        }
        emit("updated-message", data);
    }

    /** Unsends a message: sets {@code dateRetracted} to now, clears its text, and emits {@code updated-message}. */
    public void retract(String messageGuid) {
        Map<String, Object> data;
        synchronized (lock) {
            Msg m = find(messageGuid);
            if (m == null) {
                throw new IllegalArgumentException("no message " + messageGuid);
            }
            m.text = null;
            m.retracted = now();
            data = json(m, With.ALL, false);
        }
        emit("updated-message", data);
    }

    /** A contact card on the Mac, for {@code GET /api/v1/contact}. */
    public void addContact(Contact c) {
        synchronized (lock) {
            contacts.add(c);
        }
    }

    /** True: the server has no Contacts access, and {@code GET /api/v1/contact} answers 500. */
    public void denyContacts(boolean denied) {
        this.contactsDenied = denied;
    }

    /** A message the Mac's member sent from their own iPhone or Mac (not through the client): {@code isFromMe}, emits {@code new-message}. */
    public String sendFromPhone(String chatGuid, String text, Instant date) {
        Msg m;
        Map<String, Object> data;
        synchronized (lock) {
            Chat c = chat(chatGuid);
            m = newMsg(c, UUID.randomUUID().toString().toUpperCase(Locale.ROOT), date == null ? now() : date.toEpochMilli());
            m.fromMe = true;
            m.text = text;
            data = json(m, With.ALL, false);
        }
        emit("new-message", data);
        return m.guid;
    }

    /** Marks every incoming message in the chat read now and emits {@code chat-read-status-changed}; nothing happens if all were read. */
    public void markRead(String chatGuid) {
        synchronized (lock) {
            chat(chatGuid);
            boolean changed = false;
            for (Msg m : msgs) {
                if (m.chatGuid.equals(chatGuid) && !m.fromMe && m.read == null) {
                    m.read = now();
                    changed = true;
                }
            }
            if (!changed) {
                return;
            }
        }
        emit("chat-read-status-changed", Map.of("chatGuid", chatGuid, "read", true));
    }

    /** Emits {@code typing-indicator}. */
    public void typing(String chatGuid, boolean display) {
        emit("typing-indicator", Map.of("display", display, "guid", chatGuid));
    }

    /** A new group name: a system message, and {@code group-name-change}. */
    public void renameGroup(String chatGuid, String newName) {
        Map<String, Object> data;
        synchronized (lock) {
            Chat c = chat(chatGuid);
            c.displayName = newName;
            Msg m = system(c, 2, 0, null);
            m.groupTitle = newName;
            data = json(m, With.ALL, false);
        }
        emit("group-name-change", data);
    }

    /** Adds a member: a system message, and {@code participant-added}. */
    public void addParticipant(String chatGuid, String address) {
        Map<String, Object> data;
        synchronized (lock) {
            Chat c = chat(chatGuid);
            Handle h = handle(address, c.service);
            c.participants.add(address);
            Msg m = system(c, 1, 0, null);
            m.otherHandle = h.row;
            data = json(m, With.ALL, false);
        }
        emit("participant-added", data);
    }

    /** Removes a member: a system message, and {@code participant-removed}. */
    public void removeParticipant(String chatGuid, String address) {
        Map<String, Object> data;
        synchronized (lock) {
            Chat c = chat(chatGuid);
            Handle h = handle(address, c.service);
            c.participants.remove(address);
            Msg m = system(c, 1, 1, null);
            m.otherHandle = h.row;
            data = json(m, With.ALL, false);
        }
        emit("participant-removed", data);
    }

    /** A member leaves: a system message from them, and {@code participant-left}. */
    public void leave(String chatGuid, String address) {
        Map<String, Object> data;
        synchronized (lock) {
            Chat c = chat(chatGuid);
            c.participants.remove(address);
            Msg m = system(c, 3, 0, address);
            data = json(m, With.ALL, false);
        }
        emit("participant-left", data);
    }

    /** Sends any event to every socket and webhook, with any JSON-able data ({@code hello-world} for one). */
    public void emit(String event, Object data) {
        if (down) {
            return;
        }
        String frame = "42" + J.asString(List.of(event, data));
        for (WebSocket ws : socketServer.getConnections()) {
            Sock s = ws.getAttachment();
            if (s != null && s.connected && ws.isOpen()) {
                try {
                    ws.send(frame);
                } catch (RuntimeException ignored) {
                    // closed under us
                }
            }
        }
        if (!webhooks.isEmpty()) {
            String body = J.asString(Map.of("type", event, "data", data));
            for (URI url : webhooks) {
                post(url, event, body);
            }
        }
    }

    private void post(URI url, String event, String body) {
        try {
            HttpRequest req = HttpRequest.newBuilder(url).timeout(Duration.ofSeconds(5)).header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build();
            HttpResponse<Void> r = http.send(req, HttpResponse.BodyHandlers.discarding());
            if (r.statusCode() / 100 != 2) {
                failures.add(new WebhookFailure(url, event, r.statusCode(), "HTTP " + r.statusCode()));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            failures.add(new WebhookFailure(url, event, 0, "interrupted"));
        } catch (IOException | RuntimeException e) {
            failures.add(new WebhookFailure(url, event, 0, e.toString()));
        }
    }

    // ---- inspecting ----

    /** Every message, oldest row first, as JSON maps with everything included (chats, participants, attachments, handle). */
    public List<Map<String, Object>> messages() {
        synchronized (lock) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Msg m : msgs) {
                out.add(json(m, With.ALL, false));
            }
            return out;
        }
    }

    /** The messages the client sent through {@code POST /message/text}, in order, as {@link #messages()} shows them. */
    public List<Map<String, Object>> sent() {
        synchronized (lock) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Msg m : sentMsgs) {
                out.add(json(m, With.ALL, false));
            }
            return out;
        }
    }

    /** Registers a URL the server posts every event to, as {@code {"type":..,"data":..}}. */
    public void addWebhook(URI url) {
        webhooks.add(url);
    }

    /** Webhook posts that failed, oldest first. A failure is recorded, never thrown. */
    public List<WebhookFailure> webhookFailures() {
        return List.copyOf(failures);
    }

    /** How many times {@link #restart()} has run. */
    public int restarts() {
        return restarts;
    }

    // ---- faults ----

    /** True: the Mac is asleep or the server is gone. REST answers 503, new sockets are refused, open ones are closed, nothing is emitted. False: back, with all data. */
    public void setDown(boolean down) {
        this.down = down;
        if (down) {
            dropSockets();
        }
    }

    /** Turns the Private API on or off: {@code private_api} and {@code helper_connected} in server info, and what {@code POST /message/text} accepts. */
    public void setPrivateApi(boolean on) {
        this.privateApi = on;
    }

    /** Closes every socket without a closing handshake. The server stays up. */
    public void dropSockets() {
        for (WebSocket ws : socketServer.getConnections()) {
            socketServer.abort(ws, "dropped");
        }
    }

    /** Every REST call waits this long before it is answered. */
    public void setLatency(Duration latency) {
        this.latency = Objects.requireNonNull(latency);
    }

    /** The next {@code n} valid {@code POST /message/text} calls answer 500 and emit {@code message-send-error}; nothing is stored. */
    public void failNextSends(int n) {
        synchronized (lock) {
            failSends = n;
        }
    }

    /** A server restart: every socket closed, all data and row numbers kept, same ports. */
    public void restart() {
        restarts++;
        dropSockets();
    }

    /** The clock that dates new messages. */
    public void setClock(Clock clock) {
        this.clock = Objects.requireNonNull(clock);
    }

    @Override
    public void close() {
        down = true;
        try {
            httpServer.stop(0);
            socketServer.stop(0);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        pings.shutdownNow();
        httpPool.shutdownNow();
        http.close();
    }

    // ---- model helpers (call with the lock held) ----

    private long now() {
        return clock.millis();
    }

    private Chat chat(String guid) {
        Chat c = chats.get(guid);
        if (c == null) {
            throw new IllegalArgumentException("no chat " + guid);
        }
        return c;
    }

    private Handle handle(String address, String service) {
        return handles.computeIfAbsent(address, a -> {
            Handle h = new Handle();
            h.row = nextHandleRow++;
            h.address = a;
            h.service = service;
            return h;
        });
    }

    private Msg find(String guid) {
        for (Msg m : msgs) {
            if (m.guid.equals(guid)) {
                return m;
            }
        }
        return null;
    }

    private Msg newMsg(Chat c, String guid, long created) {
        Msg m = new Msg();
        m.row = nextMessageRow++;
        m.guid = guid;
        m.chatGuid = c.guid;
        m.created = created;
        msgs.add(m);
        return m;
    }

    private Msg system(Chat c, int itemType, int action, String fromAddress) {
        Msg m = newMsg(c, UUID.randomUUID().toString().toUpperCase(Locale.ROOT), now());
        m.itemType = itemType;
        m.groupActionType = action;
        if (fromAddress == null) {
            m.fromMe = true;
        } else {
            m.fromAddress = fromAddress;
        }
        return m;
    }

    private Att attachment(Attachment f, boolean outgoing) {
        Att a = new Att();
        a.row = nextAttachmentRow++;
        a.guid = "at_0_" + UUID.randomUUID().toString().toUpperCase(Locale.ROOT);
        a.name = f.name();
        a.mime = f.mime();
        a.bytes = f.bytes().clone();
        a.outgoing = outgoing;
        attachmentsByGuid.put(a.guid, a);
        return a;
    }

    private Map<String, Object> handleJson(String address) {
        Handle h = handles.get(address);
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("originalROWID", h.row);
        o.put("address", h.address);
        o.put("service", h.service);
        o.put("country", "us");
        o.put("uncanonicalizedId", h.address);
        return o;
    }

    private static String uti(String mime) {
        return switch (mime == null ? "" : mime) {
            case "image/png" -> "public.png";
            case "image/jpeg" -> "public.jpeg";
            case "image/gif" -> "com.compuserve.gif";
            case "application/pdf" -> "com.adobe.pdf";
            case "text/plain" -> "public.plain-text";
            default -> "public.data";
        };
    }

    private Map<String, Object> json(Msg m, With with, boolean withTemp) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("originalROWID", m.row);
        o.put("guid", m.guid);
        if (withTemp) {
            o.put("tempGuid", m.tempGuid);
        }
        o.put("text", m.text);
        o.put("attributedBody", null);
        o.put("handle", with.handle() && m.fromAddress != null ? handleJson(m.fromAddress) : null);
        o.put("handleId", m.fromAddress == null ? 0L : handles.get(m.fromAddress).row);
        o.put("otherHandle", m.otherHandle);
        List<Object> atts = new ArrayList<>();
        if (with.attachments()) {
            for (Att a : m.attachments) {
                Map<String, Object> ao = new LinkedHashMap<>();
                ao.put("originalROWID", a.row);
                ao.put("guid", a.guid);
                ao.put("uti", uti(a.mime));
                ao.put("mimeType", a.mime);
                ao.put("transferName", a.name);
                ao.put("totalBytes", (long) a.bytes.length);
                ao.put("isOutgoing", a.outgoing);
                ao.put("hideAttachment", false);
                ao.put("height", null);
                ao.put("width", null);
                atts.add(ao);
            }
        }
        o.put("attachments", atts);
        o.put("subject", m.subject);
        o.put("error", 0);
        o.put("dateCreated", m.created);
        o.put("dateRead", m.read);
        o.put("dateDelivered", m.delivered);
        o.put("isDelivered", m.delivered != null);
        o.put("isFromMe", m.fromMe);
        o.put("hasDdResults", false);
        o.put("isArchived", false);
        o.put("itemType", m.itemType);
        o.put("groupTitle", m.groupTitle);
        o.put("groupActionType", m.groupActionType);
        o.put("balloonBundleId", null);
        o.put("associatedMessageGuid", m.assocGuid);
        o.put("associatedMessageType", m.assocType);
        o.put("expressiveSendStyleId", m.effect);
        o.put("threadOriginatorGuid", m.thread);
        o.put("hasPayloadData", false);
        o.put("dateEdited", m.edited);
        o.put("dateRetracted", m.retracted);
        o.put("partCount", 1);
        if (with.chats()) {
            o.put("chats", List.of(chatJson(chat(m.chatGuid), with.participants(), false)));
        }
        return o;
    }

    private Map<String, Object> chatJson(Chat c, boolean participants, boolean lastMessage) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("originalROWID", c.row);
        o.put("guid", c.guid);
        o.put("style", c.style);
        o.put("chatIdentifier", c.identifier);
        o.put("isArchived", false);
        o.put("displayName", c.displayName);
        if (participants) {
            List<Object> ps = new ArrayList<>();
            for (String a : c.participants) {
                ps.add(handleJson(a));
            }
            o.put("participants", ps);
        }
        if (lastMessage) {
            Msg last = null;
            for (Msg m : msgs) {
                if (m.chatGuid.equals(c.guid) && (last == null || order(m, last) > 0)) {
                    last = m;
                }
            }
            o.put("lastMessage", last == null ? null : json(last, With.NONE, false));
        }
        return o;
    }

    private static int order(Msg a, Msg b) {
        int c = Long.compare(a.created, b.created);
        return c != 0 ? c : Long.compare(a.row, b.row);
    }

    // ---- REST ----

    private void handle(HttpExchange ex) throws IOException {
        try {
            Duration wait = latency;
            if (!wait.isZero()) {
                try {
                    Thread.sleep(wait.toMillis());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            dispatch(ex);
        } catch (Bad b) {
            send(ex, b.status, errorBody(b.status, b.type, b.getMessage()));
        } catch (RuntimeException e) {
            send(ex, 500, errorBody(500, "Server Error", String.valueOf(e)));
        } finally {
            ex.close();
        }
    }

    private void dispatch(HttpExchange ex) throws IOException {
        if (down) {
            throw new Bad(503, "Service Unavailable", "The server is down");
        }
        Map<String, List<String>> query = query(ex.getRequestURI().getRawQuery());
        if (!authorized(query)) {
            throw new Bad(401, "Authentication Error", "Server password is incorrect or missing");
        }
        String path = ex.getRequestURI().getPath();
        String method = ex.getRequestMethod();
        if (!path.startsWith("/api/v1/")) {
            throw new Bad(404, "Not Found", "No such route: " + path);
        }
        String[] seg = path.substring("/api/v1/".length()).split("/");
        boolean get = method.equals("GET");
        boolean post = method.equals("POST");
        if (get && is(seg, "ping")) {
            send(ex, 200, envelope("Ping received!", "pong", null));
        } else if (get && is(seg, "server", "info")) {
            send(ex, 200, envelope("Successfully got server metadata!", serverInfo(), null));
        } else if (post && is(seg, "message", "query")) {
            messageQuery(ex, body(ex));
        } else if (get && is(seg, "message", "count")) {
            messageCount(ex, query);
        } else if (post && is(seg, "message", "text")) {
            sendText(ex, body(ex));
        } else if (post && is(seg, "chat", "query")) {
            chatQuery(ex, body(ex));
        } else if (get && seg.length == 3 && seg[0].equals("chat") && seg[2].equals("message")) {
            chatMessages(ex, seg[1], query);
        } else if (get && seg.length == 3 && seg[0].equals("attachment") && seg[2].equals("download")) {
            download(ex, seg[1]);
        } else if (get && seg.length == 2 && seg[0].equals("message") && !seg[1].equals("count") && !seg[1].equals("query")) {
            oneMessage(ex, seg[1], query);
        } else if (get && is(seg, "contact")) {
            contactList(ex);
        } else {
            throw new Bad(404, "Not Found", "No such route: " + method + " " + path);
        }
    }

    private static boolean is(String[] seg, String... want) {
        return java.util.Arrays.equals(seg, want);
    }

    private boolean authorized(Map<String, List<String>> query) {
        for (String key : List.of("guid", "password", "token")) {
            List<String> v = query.get(key);
            if (v != null && v.contains(password)) {
                return true;
            }
        }
        return false;
    }

    private Map<String, Object> serverInfo() {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("os_version", "14.5");
        o.put("server_version", SERVER_VERSION);
        o.put("private_api", privateApi);
        o.put("proxy_service", "Dynamic DNS");
        o.put("helper_connected", privateApi);
        o.put("detected_icloud", "member@icloud.example");
        return o;
    }

    private void messageQuery(HttpExchange ex, Map<String, Object> b) throws IOException {
        With with = With.of(strings(b.get("with")));
        Object chatGuid = b.get("chatGuid");
        page(ex, "Successfully fetched messages!", chatGuid == null ? null : chatGuid.toString(), lng(b.get("after"), "after"), lng(b.get("before"), "before"),
                num(b.get("offset"), 0, "offset"), num(b.get("limit"), 100, "limit"), b.get("sort"), with);
    }

    private void chatMessages(HttpExchange ex, String guid, Map<String, List<String>> q) throws IOException {
        synchronized (lock) {
            if (!chats.containsKey(guid)) {
                throw new Bad(404, "Not Found", "Chat does not exist");
            }
        }
        page(ex, "Successfully fetched chat messages!", guid, lng(first(q, "after"), "after"), lng(first(q, "before"), "before"),
                num(first(q, "offset"), 0, "offset"), num(first(q, "limit"), 100, "limit"), first(q, "sort"), With.of(allValues(q, "with")));
    }

    private void page(HttpExchange ex, String message, String chatGuid, Long after, Long before, int offset, int limit, Object sort, With with) throws IOException {
        boolean asc = sort != null && sort.toString().equalsIgnoreCase("ASC");
        List<Object> data = new ArrayList<>();
        int total;
        synchronized (lock) {
            List<Msg> hits = select(chatGuid, after, before);
            hits.sort(asc ? FakeBlueBubbles::order : (a, b) -> order(b, a));
            total = hits.size();
            for (int i = offset; i < Math.min(total, (long) offset + limit); i++) {
                data.add(json(hits.get(i), with, false));
            }
        }
        send(ex, 200, envelope(message, data, metadata(offset, limit, total, data.size())));
    }

    private List<Msg> select(String chatGuid, Long after, Long before) {
        List<Msg> hits = new ArrayList<>();
        for (Msg m : msgs) {
            if ((chatGuid == null || m.chatGuid.equals(chatGuid)) && (after == null || m.created > after) && (before == null || m.created < before)) {
                hits.add(m);
            }
        }
        return hits;
    }

    private void messageCount(HttpExchange ex, Map<String, List<String>> q) throws IOException {
        int total;
        synchronized (lock) {
            total = select(first(q, "chatGuid"), lng(first(q, "after"), "after"), lng(first(q, "before"), "before")).size();
        }
        send(ex, 200, envelope("Successfully fetched message count!", Map.of("total", total), null));
    }

    private void chatQuery(HttpExchange ex, Map<String, Object> b) throws IOException {
        boolean participants = false;
        boolean last = false;
        for (String t : strings(b.get("with"))) {
            switch (t.trim().toLowerCase(Locale.ROOT)) {
                case "participants" -> participants = true;
                case "lastmessage" -> last = true;
                default -> { }
            }
        }
        int offset = num(b.get("offset"), 0, "offset");
        int limit = num(b.get("limit"), 1000, "limit");
        boolean asc = b.get("sort") != null && b.get("sort").toString().equalsIgnoreCase("ASC");
        List<Object> data = new ArrayList<>();
        int total;
        synchronized (lock) {
            List<Chat> all = new ArrayList<>(chats.values());
            java.util.Map<String, Long> latest = new java.util.HashMap<>();
            for (Msg m : msgs) {
                latest.merge(m.chatGuid, m.created, Math::max);
            }
            all.sort((x, y) -> {
                int c = Long.compare(latest.getOrDefault(x.guid, 0L), latest.getOrDefault(y.guid, 0L));
                return asc ? c : -c;
            });
            total = all.size();
            for (int i = offset; i < Math.min(total, (long) offset + limit); i++) {
                data.add(chatJson(all.get(i), participants, last));
            }
        }
        send(ex, 200, envelope("Successfully fetched chats!", data, metadata(offset, limit, total, data.size())));
    }

    private void sendText(HttpExchange ex, Map<String, Object> b) throws IOException {
        String chatGuid = text(b.get("chatGuid"));
        String message = text(b.get("message"));
        if (chatGuid == null || chatGuid.isEmpty()) {
            throw new Bad(400, "Bad Request", "chatGuid is required");
        }
        if (message == null || message.isEmpty()) {
            throw new Bad(400, "Bad Request", "message is required");
        }
        String method = text(b.get("method"));
        if (method != null && !method.equals("apple-script") && !method.equals("private-api")) {
            throw new Bad(400, "Bad Request", "method must be apple-script or private-api");
        }
        String selected = text(b.get("selectedMessageGuid"));
        if ((("private-api".equals(method)) || selected != null) && !privateApi) {
            throw new Bad(400, "Bad Request", "Private API is not enabled");
        }
        Msg m;
        Map<String, Object> data;
        Map<String, Object> failed = null;
        synchronized (lock) {
            Chat c = chats.get(chatGuid);
            if (c == null) {
                throw new Bad(400, "Bad Request", "Chat does not exist");
            }
            if (selected != null && find(selected) == null) {
                throw new Bad(400, "Bad Request", "selectedMessageGuid does not exist");
            }
            m = newMsg(c, UUID.randomUUID().toString().toUpperCase(Locale.ROOT), now());
            m.fromMe = true;
            m.text = message;
            m.tempGuid = text(b.get("tempGuid"));
            m.subject = text(b.get("subject"));
            m.effect = text(b.get("effectId"));
            m.thread = selected;
            if (failSends > 0) {
                failSends--;
                msgs.remove(m);
                nextMessageRow--;
                Map<String, Object> f = json(m, With.ALL, true);
                f.put("error", 4);
                failed = f;
            } else {
                sentMsgs.add(m);
            }
            data = failed != null ? null : json(m, With.ALL, true);
        }
        if (failed != null) {
            emit("message-send-error", failed);
            throw new Bad(500, "iMessage Error", "Failed to send message!");
        }
        emit("new-message", data);
        send(ex, 200, envelope("Message sent!", data, null));
    }

    private void oneMessage(HttpExchange ex, String guid, Map<String, List<String>> q) throws IOException {
        Map<String, Object> data;
        synchronized (lock) {
            Msg m = find(guid);
            if (m == null) {
                throw new Bad(404, "Not Found", "Message does not exist");
            }
            data = json(m, With.of(allValues(q, "with")), false);
        }
        send(ex, 200, envelope("Successfully fetched message!", data, null));
    }

    private void contactList(HttpExchange ex) throws IOException {
        if (contactsDenied) {
            throw new Bad(500, "Server Error", "No access to Contacts");
        }
        List<Object> data = new ArrayList<>();
        synchronized (lock) {
            int id = 1;
            for (Contact c : contacts) {
                Map<String, Object> o = new LinkedHashMap<>();
                o.put("id", Integer.toString(id++));
                o.put("firstName", c.firstName());
                o.put("lastName", c.lastName());
                o.put("displayName", c.displayName());
                o.put("nickname", "");
                List<Object> phones = new ArrayList<>();
                for (String p : c.phones()) {
                    phones.add(Map.of("address", p, "id", ""));
                }
                List<Object> emails = new ArrayList<>();
                for (String e : c.emails()) {
                    emails.add(Map.of("address", e, "id", ""));
                }
                o.put("phoneNumbers", phones);
                o.put("emails", emails);
                o.put("sourceType", "db");
                data.add(o);
            }
        }
        send(ex, 200, envelope("Successfully fetched contacts!", data, null));
    }

    private void download(HttpExchange ex, String guid) throws IOException {
        Att a;
        synchronized (lock) {
            a = attachmentsByGuid.get(guid);
        }
        if (a == null) {
            throw new Bad(404, "Not Found", "Attachment does not exist");
        }
        ex.getResponseHeaders().set("Content-Type", a.mime == null ? "application/octet-stream" : a.mime);
        ex.getResponseHeaders().set("Content-Disposition", "attachment; filename=\"" + a.name + "\"");
        ex.sendResponseHeaders(200, a.bytes.length == 0 ? -1 : a.bytes.length);
        if (a.bytes.length > 0) {
            ex.getResponseBody().write(a.bytes);
        }
    }

    // ---- REST plumbing ----

    private static Map<String, Object> metadata(int offset, int limit, int total, int count) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("offset", offset);
        m.put("limit", limit);
        m.put("total", total);
        m.put("count", count);
        return m;
    }

    private static String envelope(String message, Object data, Map<String, Object> metadata) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("status", 200);
        o.put("message", message);
        o.put("data", data);
        if (metadata != null) {
            o.put("metadata", metadata);
        }
        return J.asString(o);
    }

    private static String errorBody(int status, String type, String message) {
        String reason = switch (status) {
            case 401 -> "Unauthorized";
            case 400 -> "Bad Request";
            case 404 -> "Not Found";
            case 503 -> "Service Unavailable";
            default -> "Server Error";
        };
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("status", status);
        o.put("message", status == 500 ? message : reason);
        o.put("error", Map.of("type", type, "error", message));
        return J.asString(o);
    }

    private static void send(HttpExchange ex, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, bytes.length);
        ex.getResponseBody().write(bytes);
    }

    private static Map<String, Object> body(HttpExchange ex) throws IOException {
        byte[] raw = ex.getRequestBody().readAllBytes();
        if (raw.length == 0) {
            return new LinkedHashMap<>();
        }
        try {
            return J.mapFrom(new String(raw, StandardCharsets.UTF_8));
        } catch (RuntimeException e) {
            throw new Bad(400, "Bad Request", "The body is not a JSON object");
        }
    }

    private static Map<String, List<String>> query(String raw) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        if (raw == null || raw.isEmpty()) {
            return out;
        }
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            String k = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), StandardCharsets.UTF_8);
            String v = eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            out.computeIfAbsent(k, x -> new ArrayList<>()).add(v);
        }
        return out;
    }

    private static String first(Map<String, List<String>> q, String key) {
        List<String> v = q.get(key);
        return v == null || v.isEmpty() ? null : v.get(0);
    }

    private static List<String> allValues(Map<String, List<String>> q, String key) {
        List<String> out = new ArrayList<>();
        for (String v : q.getOrDefault(key, List.of())) {
            out.addAll(List.of(v.split(",")));
        }
        return out;
    }

    private static List<String> strings(Object o) {
        List<String> out = new ArrayList<>();
        if (o instanceof List<?> l) {
            for (Object x : l) {
                out.add(String.valueOf(x));
            }
        } else if (o instanceof String s) {
            out.addAll(List.of(s.split(",")));
        }
        return out;
    }

    private static String text(Object o) {
        return o == null ? null : o.toString();
    }

    private static Long lng(Object o, String name) {
        if (o == null || o.toString().isEmpty()) {
            return null;
        }
        if (o instanceof Number n) {
            return n.longValue();
        }
        try {
            return Long.parseLong(o.toString());
        } catch (NumberFormatException e) {
            throw new Bad(400, "Bad Request", name + " must be a number");
        }
    }

    private static int num(Object o, int dflt, String name) {
        Long v = lng(o, name);
        if (v == null) {
            return dflt;
        }
        if (v < 0) {
            throw new Bad(400, "Bad Request", name + " must not be negative");
        }
        return (int) Math.min(v, name.equals("limit") ? 1000 : Integer.MAX_VALUE);
    }

    // ---- the socket ----

    private final class SocketServer extends WebSocketServer {
        private final CountDownLatch started = new CountDownLatch(1);

        SocketServer() {
            super(new InetSocketAddress(LOOPBACK, 0));
            setReuseAddr(true);
            setConnectionLostTimeout(0);
        }

        /** Closes without a closing handshake, and wakes the selector so the channel is really closed now. */
        void abort(WebSocket ws, String reason) {
            ws.closeConnection(1006, reason);
            onWriteDemand(ws);
        }

        void startAndWait() throws InterruptedException {
            start();
            if (!started.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("socket server did not start");
            }
        }

        @Override
        public ServerHandshakeBuilder onWebsocketHandshakeReceivedAsServer(WebSocket conn, Draft draft, ClientHandshake request) throws InvalidDataException {
            if (down || !request.getResourceDescriptor().startsWith("/socket.io/")) {
                throw new InvalidDataException(CloseFrame.POLICY_VALIDATION, "refused");
            }
            return super.onWebsocketHandshakeReceivedAsServer(conn, draft, request);
        }

        @Override
        public void onStart() {
            started.countDown();
        }

        @Override
        public void onOpen(WebSocket conn, ClientHandshake hs) {
            String desc = hs.getResourceDescriptor();
            int q = desc.indexOf('?');
            Map<String, List<String>> params = query(q < 0 ? null : desc.substring(q + 1));
            Sock s = new Sock();
            conn.setAttachment(s);
            Map<String, Object> open = new LinkedHashMap<>();
            open.put("sid", UUID.randomUUID().toString());
            open.put("upgrades", List.of());
            open.put("pingInterval", pingInterval.toMillis());
            open.put("pingTimeout", pingTimeout.toMillis());
            open.put("maxPayload", 1_000_000);
            conn.send("0" + J.asString(open));
            if (!authorized(params)) {
                conn.send("44{\"message\":\"Unauthorized\"}");
                conn.close(CloseFrame.NORMAL, "Unauthorized");
                return;
            }
            long ms = Math.max(1, pingInterval.toMillis());
            s.task = pings.scheduleAtFixedRate(() -> ping(conn, s), ms, ms, TimeUnit.MILLISECONDS);
        }

        private void ping(WebSocket conn, Sock s) {
            if (!conn.isOpen() || s.ackedSeq < s.pingSeq) {
                return;
            }
            long seq = ++s.pingSeq;
            conn.send("2");
            pings.schedule(() -> {
                if (s.ackedSeq < seq && conn.isOpen()) {
                    socketServer.abort(conn, "ping timeout");
                }
            }, Math.max(1, pingTimeout.toMillis()), TimeUnit.MILLISECONDS);
        }

        @Override
        public void onMessage(WebSocket conn, String message) {
            Sock s = conn.getAttachment();
            if (s == null) {
                return;
            }
            if (message.equals("3")) {
                s.ackedSeq = s.pingSeq;
            } else if (message.startsWith("40")) {
                if (!s.connected) {
                    s.connected = true;
                    conn.send("40{\"sid\":\"" + UUID.randomUUID() + "\"}");
                }
            } else if (message.startsWith("41")) {
                conn.close(CloseFrame.NORMAL, "disconnect");
            }
        }

        @Override
        public void onClose(WebSocket conn, int code, String reason, boolean remote) {
            Sock s = conn.getAttachment();
            if (s != null && s.task != null) {
                s.task.cancel(false);
            }
        }

        @Override
        public void onError(WebSocket conn, Exception ex) {
            // a client that went away: nothing to do
        }
    }

    private static InetAddress loopback() {
        try {
            return InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
        } catch (java.net.UnknownHostException e) {
            throw new IllegalStateException(e);
        }
    }

    private static java.util.concurrent.ThreadFactory daemon(String name) {
        return r -> {
            Thread t = new Thread(r, name);
            t.setDaemon(true);
            return t;
        };
    }
}
