package com.minimalistalliance.desk.courier.testkit;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.FakeBlueBubbles.Attachment;
import com.sun.net.httpserver.HttpServer;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import tools.jackson.jr.ob.JSON;

/** The fake BlueBubbles Server over its own wire: REST with the JDK's client, the socket with the JDK's WebSocket, webhooks into a local receiver. */
class FakeBlueBubblesTest {

    private static final String PW = "s3cret pw";
    private static final long T0 = 1_700_000_000_000L;
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    private static final Set<String> MESSAGE_KEYS = Set.of("originalROWID", "guid", "text", "attributedBody", "handle", "handleId", "otherHandle", "attachments", "subject", "error",
            "dateCreated", "dateRead", "dateDelivered", "isDelivered", "isFromMe", "hasDdResults", "isArchived", "itemType", "groupTitle", "groupActionType", "balloonBundleId",
            "associatedMessageGuid", "associatedMessageType", "expressiveSendStyleId", "threadOriginatorGuid", "hasPayloadData", "dateEdited", "dateRetracted", "partCount");

    // ---- helpers ----

    private record Resp(int status, byte[] raw, String contentType) {
        Map<String, Object> json() throws Exception {
            return JSON.std.mapFrom(new String(raw, StandardCharsets.UTF_8));
        }

        List<Map<String, Object>> data() throws Exception {
            return list(json().get("data"));
        }
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Object o) {
        return (List<Map<String, Object>>) o;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    private static long n(Object o) {
        return ((Number) o).longValue();
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private static Resp get(FakeBlueBubbles s, String path) throws Exception {
        return send(HttpRequest.newBuilder(URI.create(s.baseUrl() + "/api/v1" + path + (path.contains("?") ? "&" : "?") + "guid=" + enc(PW))).GET().build());
    }

    private static Resp post(FakeBlueBubbles s, String path, Object body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(s.baseUrl() + "/api/v1" + path + "?guid=" + enc(PW)))
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(JSON.std.asString(body))).build();
        return send(req);
    }

    private static Resp send(HttpRequest req) throws Exception {
        HttpResponse<byte[]> r = HTTP.send(req, HttpResponse.BodyHandlers.ofByteArray());
        return new Resp(r.statusCode(), r.body(), r.headers().firstValue("Content-Type").orElse(""));
    }

    /** A socket client that counts Engine.IO pings and answers them unless told not to. */
    private static final class Sock implements WebSocket.Listener {
        final BlockingQueue<String> frames = new LinkedBlockingQueue<>();
        final CountDownLatch closed = new CountDownLatch(1);
        final AtomicInteger pings = new AtomicInteger();
        volatile boolean pong = true;
        private final StringBuilder buf = new StringBuilder();
        WebSocket ws;

        static Sock connect(String url) throws Exception {
            Sock s = new Sock();
            s.ws = HTTP.newWebSocketBuilder().buildAsync(URI.create(url), s).get(5, TimeUnit.SECONDS);
            return s;
        }

        /** Open packet, then connect to "/". */
        Sock handshake() throws Exception {
            assertThat(next()).startsWith("0{");
            ws.sendText("40", true);
            assertThat(next()).startsWith("40{\"sid\":\"");
            return this;
        }

        @Override
        public void onOpen(WebSocket w) {
            w.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket w, CharSequence data, boolean last) {
            buf.append(data);
            if (last) {
                String s = buf.toString();
                buf.setLength(0);
                if (s.equals("2")) {
                    pings.incrementAndGet();
                    if (pong) {
                        w.sendText("3", true);
                    }
                } else {
                    frames.add(s);
                }
            }
            w.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket w, int code, String reason) {
            closed.countDown();
            return null;
        }

        @Override
        public void onError(WebSocket w, Throwable e) {
            closed.countDown();
        }

        String next() throws Exception {
            String f = frames.poll(5, TimeUnit.SECONDS);
            assertThat(f).as("a frame within 5 s").isNotNull();
            return f;
        }

        /** The next {@code 42[...]} frame, as [name, data]. */
        List<Object> event() throws Exception {
            String f = next();
            assertThat(f).startsWith("42[");
            return JSON.std.listFrom(f.substring(2));
        }

        boolean closesWithin(long ms) throws Exception {
            return closed.await(ms, TimeUnit.MILLISECONDS);
        }
    }

    /** A webhook receiver. */
    private static final class Hook implements AutoCloseable {
        final HttpServer server;
        final BlockingQueue<String> bodies = new LinkedBlockingQueue<>();
        volatile int status = 200;

        Hook() throws Exception {
            server = HttpServer.create(new InetSocketAddress(InetAddress.getByAddress(new byte[] {127, 0, 0, 1}), 0), 0);
            server.createContext("/", ex -> {
                bodies.add(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                ex.sendResponseHeaders(status, -1);
                ex.close();
            });
            server.start();
        }

        URI uri() {
            return URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/hook");
        }

        Map<String, Object> next() throws Exception {
            String b = bodies.poll(5, TimeUnit.SECONDS);
            assertThat(b).isNotNull();
            return JSON.std.mapFrom(b);
        }

        @Override
        public void close() {
            server.stop(0);
        }
    }

    /** Five messages in one chat dated T0+1000..T0+5000, "m1".."m5", from the other side. */
    private static String seed(FakeBlueBubbles s) {
        String chat = s.directChat("+15551230001");
        for (int i = 1; i <= 5; i++) {
            s.receive(chat, "+15551230001", "m" + i, Instant.ofEpochMilli(T0 + i * 1000L));
        }
        return chat;
    }

    private static List<Object> texts(List<Map<String, Object>> msgs) {
        return msgs.stream().map(m -> m.get("text")).toList();
    }

    // ---- REST ----

    @Test
    void authAcceptsGuidPasswordAndTokenAndRefusesTheRest() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            for (String key : List.of("guid", "password", "token")) {
                Resp r = send(HttpRequest.newBuilder(URI.create(s.baseUrl() + "/api/v1/ping?" + key + "=" + enc(PW))).build());
                assertThat(r.status()).as(key).isEqualTo(200);
            }
            for (String bad : List.of("/api/v1/ping", "/api/v1/ping?guid=wrong", "/api/v1/ping?foo=" + enc(PW))) {
                Resp r = send(HttpRequest.newBuilder(URI.create(s.baseUrl() + bad)).build());
                assertThat(r.status()).isEqualTo(401);
                Map<String, Object> body = r.json();
                assertThat(n(body.get("status"))).isEqualTo(401);
                assertThat(body.get("message")).isEqualTo("Unauthorized");
                assertThat(map(body.get("error")).get("type")).isEqualTo("Authentication Error");
                assertThat((String) map(body.get("error")).get("error")).isNotBlank();
            }
        }
    }

    @Test
    void pingAndServerInfo() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            Map<String, Object> ping = get(s, "/ping").json();
            assertThat(ping.get("data")).isEqualTo("pong");
            assertThat(ping.get("message")).isEqualTo("Ping received!");
            assertThat(n(ping.get("status"))).isEqualTo(200);

            Map<String, Object> info = map(get(s, "/server/info").json().get("data"));
            assertThat(info).containsKeys("os_version", "server_version", "private_api", "proxy_service", "helper_connected", "detected_icloud");
            assertThat(info.get("server_version")).isEqualTo("1.9.9");
            assertThat(info.get("private_api")).isEqualTo(false);
            assertThat(info.get("helper_connected")).isEqualTo(false);
            s.setPrivateApi(true);
            info = map(get(s, "/server/info").json().get("data"));
            assertThat(info.get("private_api")).isEqualTo(true);
            assertThat(info.get("helper_connected")).isEqualTo(true);
        }
    }

    @Test
    void messageQueryAfterBeforeSortLimitOffsetAndMetadata() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String chat = seed(s);
            String other = s.directChat("+15551230002");
            s.receive(other, "+15551230002", "elsewhere", Instant.ofEpochMilli(T0 + 2500));

            Map<String, Object> all = post(s, "/message/query", Map.of()).json();
            assertThat(texts(list(all.get("data")))).containsExactly("m5", "m4", "m3", "elsewhere", "m2", "m1");   // DESC by default
            assertThat(all.get("message")).isEqualTo("Successfully fetched messages!");
            assertThat(map(all.get("metadata"))).containsEntry("offset", 0).containsEntry("limit", 100).containsEntry("total", 6).containsEntry("count", 6);

            Resp asc = post(s, "/message/query", Map.of("chatGuid", chat, "sort", "ASC"));
            assertThat(texts(asc.data())).containsExactly("m1", "m2", "m3", "m4", "m5");

            // bounds are exclusive
            Resp window = post(s, "/message/query", Map.of("chatGuid", chat, "sort", "ASC", "after", T0 + 1000, "before", T0 + 5000));
            assertThat(texts(window.data())).containsExactly("m2", "m3", "m4");

            Map<String, Object> paged = post(s, "/message/query", Map.of("chatGuid", chat, "sort", "ASC", "offset", 1, "limit", 2)).json();
            assertThat(texts(list(paged.get("data")))).containsExactly("m2", "m3");
            assertThat(map(paged.get("metadata"))).containsEntry("offset", 1).containsEntry("limit", 2).containsEntry("total", 5).containsEntry("count", 2);

            assertThat(map(post(s, "/message/query", Map.of("limit", 99999)).json().get("metadata"))).containsEntry("limit", 1000);
        }
    }

    @Test
    void messageJsonHasEveryFieldAndWithControlsTheRest() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String chat = s.directChat("+15551230001");
            s.receive(chat, "+15551230001", "with file", Instant.ofEpochMilli(T0), new Attachment("a.png", "image/png", new byte[] {1, 2, 3}));

            Map<String, Object> bare = post(s, "/message/query", Map.of()).data().get(0);
            assertThat(bare.keySet()).containsAll(MESSAGE_KEYS).doesNotContain("chats");
            assertThat(bare.get("handle")).isNull();
            assertThat(list(bare.get("attachments"))).isEmpty();
            assertThat(bare.get("attributedBody")).isNull();
            assertThat(bare.get("dateRead")).isNull();
            assertThat(bare.get("partCount")).isEqualTo(1);
            assertThat((String) bare.get("guid")).startsWith("p:0/");

            Map<String, Object> full = post(s, "/message/query", Map.of("with", List.of("chat", "chat.participants", "attachment", "handle"))).data().get(0);
            assertThat(map(full.get("handle"))).containsEntry("address", "+15551230001").containsEntry("service", "iMessage").containsKeys("originalROWID", "country", "uncanonicalizedId");
            assertThat(n(full.get("handleId"))).isEqualTo(n(map(full.get("handle")).get("originalROWID")));
            Map<String, Object> att = list(full.get("attachments")).get(0);
            assertThat(att).containsEntry("transferName", "a.png").containsEntry("mimeType", "image/png").containsEntry("totalBytes", 3).containsEntry("isOutgoing", false)
                    .containsKeys("originalROWID", "guid", "uti", "hideAttachment", "height", "width");
            Map<String, Object> c = list(full.get("chats")).get(0);
            assertThat(c).containsEntry("guid", chat).containsEntry("style", 45).containsEntry("chatIdentifier", "+15551230001").containsKeys("originalROWID", "isArchived", "displayName");
            assertThat(list(c.get("participants"))).hasSize(1);

            Map<String, Object> chatsOnly = post(s, "/message/query", Map.of("with", List.of("chats"))).data().get(0);
            assertThat(map(list(chatsOnly.get("chats")).get(0))).doesNotContainKey("participants");
        }
    }

    @Test
    void catchUpAfterSleepFetchesTheWindowByTime() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String chat = s.directChat("+15551230001");
            s.receive(chat, "+15551230001", "before sleep", Instant.ofEpochMilli(T0));
            long lastSeen = T0;
            s.setDown(true);                                              // the Mac sleeps
            s.receive(chat, "+15551230001", "slept 1", Instant.ofEpochMilli(T0 + 60_000));
            s.receive(chat, "+15551230001", "slept 2", Instant.ofEpochMilli(T0 + 120_000));
            s.setDown(false);
            Resp r = post(s, "/message/query", Map.of("after", lastSeen, "sort", "ASC", "with", List.of("chat", "handle")));
            assertThat(texts(r.data())).containsExactly("slept 1", "slept 2");
            assertThat(get(s, "/message/count?after=" + lastSeen).json().get("data")).isEqualTo(Map.of("total", 2));
        }
    }

    @Test
    void messageCount() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String chat = seed(s);
            String other = s.directChat("+15551230002");
            s.receive(other, "+15551230002", "x", Instant.ofEpochMilli(T0 + 3500));
            assertThat(map(get(s, "/message/count").json().get("data"))).containsEntry("total", 6);
            assertThat(map(get(s, "/message/count?chatGuid=" + enc(chat)).json().get("data"))).containsEntry("total", 5);
            assertThat(map(get(s, "/message/count?after=" + (T0 + 2000) + "&before=" + (T0 + 5000)).json().get("data"))).containsEntry("total", 3);
        }
    }

    @Test
    void sendTextAppleScriptPrivateApiAndErrors() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String chat = seed(s);
            Resp ok = post(s, "/message/text", Map.of("chatGuid", chat, "tempGuid", "temp-1", "message", "hello", "method", "apple-script", "subject", "subj"));
            assertThat(ok.status()).isEqualTo(200);
            Map<String, Object> body = ok.json();
            assertThat(body.get("message")).isEqualTo("Message sent!");
            Map<String, Object> m = map(body.get("data"));
            assertThat(m).containsEntry("tempGuid", "temp-1").containsEntry("isFromMe", true).containsEntry("text", "hello").containsEntry("subject", "subj").containsEntry("handleId", 0);
            assertThat(m.get("handle")).isNull();
            assertThat(s.sent()).hasSize(1);
            assertThat(s.sent().get(0)).containsEntry("guid", m.get("guid"));
            assertThat(texts(post(s, "/message/query", Map.of("chatGuid", chat, "limit", 1)).data())).containsExactly("hello");

            // the Private API is off
            assertThat(post(s, "/message/text", Map.of("chatGuid", chat, "message", "x", "method", "private-api")).status()).isEqualTo(400);
            String target = (String) s.messages().get(0).get("guid");
            Resp reply = post(s, "/message/text", Map.of("chatGuid", chat, "message", "re", "selectedMessageGuid", target));
            assertThat(reply.status()).isEqualTo(400);
            assertThat(map(reply.json().get("error")).get("type")).isEqualTo("Bad Request");

            s.setPrivateApi(true);
            Resp viaApi = post(s, "/message/text", Map.of("chatGuid", chat, "message", "re", "method", "private-api", "selectedMessageGuid", target, "effectId", "com.apple.messages.effect.CKHappyBirthdayEffect", "partIndex", 0));
            assertThat(viaApi.status()).isEqualTo(200);
            assertThat(map(viaApi.json().get("data"))).containsEntry("threadOriginatorGuid", target).containsEntry("expressiveSendStyleId", "com.apple.messages.effect.CKHappyBirthdayEffect");

            // bad requests
            assertThat(post(s, "/message/text", Map.of("chatGuid", "iMessage;-;+19999999999", "message", "x")).status()).isEqualTo(400);
            assertThat(post(s, "/message/text", Map.of("chatGuid", chat)).status()).isEqualTo(400);
            assertThat(post(s, "/message/text", Map.of("message", "x")).status()).isEqualTo(400);
            assertThat(post(s, "/message/text", Map.of("chatGuid", chat, "message", "x", "method", "carrier-pigeon")).status()).isEqualTo(400);
            assertThat(post(s, "/message/text", Map.of("chatGuid", chat, "message", "x", "selectedMessageGuid", "nope")).status()).isEqualTo(400);
            assertThat(s.sent()).hasSize(2);
        }
    }

    @Test
    void chatQueryAndChatMessages() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String direct = seed(s);
            String group = s.groupChat("Weekend", "+15551230001", "+15551230002");
            s.receive(group, "+15551230002", "group hello", Instant.ofEpochMilli(T0 + 9000));
            assertThat(direct).isEqualTo("iMessage;-;+15551230001");
            assertThat(group).matches("iMessage;\\+;chat\\d+");

            Map<String, Object> q = post(s, "/chat/query", Map.of("with", List.of("participants", "lastMessage"))).json();
            List<Map<String, Object>> chats = list(q.get("data"));
            assertThat(chats).extracting(c -> c.get("guid")).containsExactly(group, direct);        // newest last message first
            assertThat(chats.get(0)).containsEntry("style", 43).containsEntry("displayName", "Weekend");
            assertThat(list(chats.get(0).get("participants"))).hasSize(2);
            assertThat(map(chats.get(0).get("lastMessage"))).containsEntry("text", "group hello");
            assertThat(chats.get(1)).containsEntry("style", 45);
            assertThat(map(q.get("metadata"))).containsEntry("total", 2).containsEntry("count", 2);

            Map<String, Object> plain = post(s, "/chat/query", Map.of("sort", "ASC", "limit", 1)).json();
            assertThat(list(plain.get("data"))).hasSize(1).allSatisfy(c -> assertThat(c).doesNotContainKeys("participants", "lastMessage"));
            assertThat(list(plain.get("data")).get(0)).containsEntry("guid", direct);

            // the guid has ; and + in it
            Resp msgs = get(s, "/chat/" + enc(direct) + "/message?sort=ASC&after=" + (T0 + 1000) + "&limit=2&offset=1");
            assertThat(texts(msgs.data())).containsExactly("m3", "m4");
            assertThat(map(msgs.json().get("metadata"))).containsEntry("total", 4).containsEntry("count", 2).containsEntry("offset", 1);
            Resp withHandle = get(s, "/chat/" + enc(direct) + "/message?with=handle,attachment&limit=1");
            assertThat(map(withHandle.data().get(0).get("handle"))).containsEntry("address", "+15551230001");
            assertThat(get(s, "/chat/" + enc("iMessage;-;+1000") + "/message").status()).isEqualTo(404);
        }
    }

    @Test
    void attachmentDownloadGivesTheBytesAndUnknownIs404() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String chat = s.directChat("+15551230001");
            byte[] bytes = new byte[5000];
            new java.util.Random(7).nextBytes(bytes);
            s.receive(chat, "+15551230001", null, null, new Attachment("blob.bin", "application/x-test", bytes), new Attachment("empty.txt", "text/plain", new byte[0]));
            List<Map<String, Object>> atts = list(post(s, "/message/query", Map.of("with", List.of("attachments"))).data().get(0).get("attachments"));
            assertThat(atts).hasSize(2);
            Resp r = get(s, "/attachment/" + atts.get(0).get("guid") + "/download");
            assertThat(r.status()).isEqualTo(200);
            assertThat(r.contentType()).isEqualTo("application/x-test");
            assertThat(r.raw()).isEqualTo(bytes);
            assertThat(get(s, "/attachment/" + atts.get(1).get("guid") + "/download").raw()).isEmpty();
            assertThat(get(s, "/attachment/at_0_nope/download").status()).isEqualTo(404);
            assertThat(get(s, "/nothing/here").status()).isEqualTo(404);
        }
    }

    @Test
    void latencyDelaysEveryAnswer() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            s.setLatency(Duration.ofMillis(400));
            long t = System.nanoTime();
            assertThat(get(s, "/ping").status()).isEqualTo(200);
            assertThat(Duration.ofNanos(System.nanoTime() - t)).isGreaterThanOrEqualTo(Duration.ofMillis(380));
        }
    }

    // ---- the socket ----

    @Test
    void socketHandshakeAndEvents() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String chat = s.directChat("+15551230001");
            assertThat(s.socketUrl()).startsWith("ws://127.0.0.1:").contains("/socket.io/?EIO=4&transport=websocket&guid=");
            Sock c = Sock.connect(s.socketUrl());
            String open = c.next();
            assertThat(open).startsWith("0{");
            Map<String, Object> o = JSON.std.mapFrom(open.substring(1));
            assertThat(o).containsKeys("sid", "upgrades", "pingInterval", "pingTimeout", "maxPayload").containsEntry("pingInterval", 25000).containsEntry("pingTimeout", 20000);
            c.ws.sendText("40", true);
            assertThat(c.next()).startsWith("40{\"sid\":\"");

            String guid = s.receive(chat, "+15551230001", "hi");
            List<Object> ev = c.event();
            assertThat(ev.get(0)).isEqualTo("new-message");
            Map<String, Object> data = map(ev.get(1));
            assertThat(data).containsEntry("guid", guid).containsEntry("text", "hi");
            assertThat(map(data.get("handle"))).containsEntry("address", "+15551230001");
            assertThat(list(data.get("chats"))).hasSize(1);

            // a message sent through REST also arrives, with its tempGuid
            post(s, "/message/text", Map.of("chatGuid", chat, "tempGuid", "t-9", "message", "out"));
            ev = c.event();
            assertThat(ev.get(0)).isEqualTo("new-message");
            assertThat(map(ev.get(1))).containsEntry("tempGuid", "t-9").containsEntry("isFromMe", true);

            s.tapback(chat, "+15551230001", guid, "love");
            ev = c.event();
            assertThat(map(ev.get(1))).containsEntry("associatedMessageType", "love").containsEntry("associatedMessageGuid", "p:0/" + guid);

            s.edit(guid, "hi, edited");
            ev = c.event();
            assertThat(ev.get(0)).isEqualTo("updated-message");
            assertThat(map(ev.get(1))).containsEntry("text", "hi, edited").containsEntry("guid", guid);
            assertThat(map(ev.get(1)).get("dateEdited")).isNotNull();

            // a client that disconnects is closed
            c.ws.sendText("41", true);
            assertThat(c.closesWithin(3000)).isTrue();
        }
    }

    @Test
    void otherEventsGroupReadAndTyping() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String group = s.groupChat("Old", "+15551230001", "+15551230002");
            s.receive(group, "+15551230001", "unread");
            Sock c = Sock.connect(s.socketUrl()).handshake();
            s.markRead(group);
            List<Object> ev = c.event();
            assertThat(ev.get(0)).isEqualTo("chat-read-status-changed");
            assertThat(map(ev.get(1))).containsEntry("chatGuid", group).containsEntry("read", true);
            s.markRead(group);                                                // nothing changed: no event
            s.typing(group, true);
            ev = c.event();
            assertThat(ev.get(0)).isEqualTo("typing-indicator");
            assertThat(map(ev.get(1))).containsEntry("display", true).containsEntry("guid", group);
            s.renameGroup(group, "New");
            ev = c.event();
            assertThat(ev.get(0)).isEqualTo("group-name-change");
            assertThat(map(ev.get(1))).containsEntry("groupTitle", "New");
            s.addParticipant(group, "+15551230003");
            assertThat(c.event().get(0)).isEqualTo("participant-added");
            s.removeParticipant(group, "+15551230003");
            assertThat(c.event().get(0)).isEqualTo("participant-removed");
            s.leave(group, "+15551230002");
            assertThat(c.event().get(0)).isEqualTo("participant-left");
            s.emit("hello-world", "hi");
            assertThat(c.event()).containsExactly("hello-world", "hi");
            assertThat(s.messages().get(0)).containsEntry("dateRead", s.messages().get(0).get("dateRead"));
        }
    }

    @Test
    void pingAndPongKeepTheSocketOpenAndAMissingPongClosesIt() throws Exception {
        FakeBlueBubbles.Options o = FakeBlueBubbles.Options.defaults(PW).withPing(Duration.ofMillis(150), Duration.ofMillis(300));
        try (FakeBlueBubbles s = FakeBlueBubbles.start(o)) {
            Sock good = Sock.connect(s.socketUrl()).handshake();
            Thread.sleep(1200);
            assertThat(good.pings.get()).isGreaterThanOrEqualTo(4);
            assertThat(good.closed.getCount()).isEqualTo(1);
            s.receive(s.directChat("+15551230001"), "+15551230001", "still here");
            assertThat(good.event().get(0)).isEqualTo("new-message");

            Sock deaf = Sock.connect(s.socketUrl()).handshake();
            deaf.pong = false;
            assertThat(deaf.closesWithin(3000)).isTrue();
            assertThat(good.closed.getCount()).isEqualTo(1);
        }
    }

    @Test
    void badPasswordGets44AndIsClosedAndTheAliasWorks() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            Sock bad = Sock.connect("ws://127.0.0.1:" + s.socketPort() + "/socket.io/?EIO=4&transport=websocket&guid=wrong");
            assertThat(bad.next()).startsWith("0{");
            assertThat(bad.next()).isEqualTo("44{\"message\":\"Unauthorized\"}");
            assertThat(bad.closesWithin(3000)).isTrue();

            Sock none = Sock.connect("ws://127.0.0.1:" + s.socketPort() + "/socket.io/?EIO=4&transport=websocket");
            none.next();
            assertThat(none.next()).startsWith("44");

            Sock alias = Sock.connect("ws://127.0.0.1:" + s.socketPort() + "/socket.io/?EIO=4&transport=websocket&password=" + enc(PW)).handshake();
            assertThat(alias.closed.getCount()).isEqualTo(1);
        }
    }

    // ---- webhooks ----

    @Test
    void webhooksGetTypeAndDataAndFailuresAreRecorded() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW); Hook hook = new Hook(); Hook sick = new Hook()) {
            String chat = s.directChat("+15551230001");
            s.addWebhook(hook.uri());
            String guid = s.receive(chat, "+15551230001", "to hook");
            Map<String, Object> b = hook.next();
            assertThat(b).containsOnlyKeys("type", "data").containsEntry("type", "new-message");
            assertThat(map(b.get("data"))).containsEntry("guid", guid).containsEntry("text", "to hook");
            s.edit(guid, "edited");
            assertThat(hook.next()).containsEntry("type", "updated-message");
            assertThat(s.webhookFailures()).isEmpty();

            sick.status = 500;
            s.addWebhook(sick.uri());
            s.addWebhook(URI.create("http://127.0.0.1:1/dead"));                  // nothing listens
            s.receive(chat, "+15551230001", "again");
            assertThat(hook.next()).containsEntry("type", "new-message");
            assertThat(s.webhookFailures()).hasSize(2);
            assertThat(s.webhookFailures().get(0).status()).isEqualTo(500);
            assertThat(s.webhookFailures().get(0).event()).isEqualTo("new-message");
            assertThat(s.webhookFailures().get(1).status()).isEqualTo(0);
            assertThat(s.webhookFailures().get(1).url()).isEqualTo(URI.create("http://127.0.0.1:1/dead"));
        }
    }

    // ---- faults ----

    @Test
    void downAnswers503RefusesSocketsClosesOpenOnesAndLosesNothing() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW); Hook hook = new Hook()) {
            String chat = seed(s);
            s.addWebhook(hook.uri());
            Sock open = Sock.connect(s.socketUrl()).handshake();
            s.setDown(true);
            assertThat(open.closesWithin(3000)).isTrue();
            Resp r = get(s, "/ping");
            assertThat(r.status()).isEqualTo(503);
            assertThat(n(r.json().get("status"))).isEqualTo(503);
            assertThat(map(r.json().get("error"))).containsKey("type");
            assertThat(post(s, "/message/query", Map.of()).status()).isEqualTo(503);
            Throwable refused = null;
            try {
                Sock.connect(s.socketUrl());
            } catch (Exception e) {
                refused = e;
            }
            assertThat(refused).isNotNull();
            s.receive(chat, "+15551230001", "while down", Instant.ofEpochMilli(T0 + 6000));
            assertThat(hook.bodies).isEmpty();                                 // nothing is emitted while down

            s.setDown(false);
            assertThat(get(s, "/ping").status()).isEqualTo(200);
            assertThat(texts(post(s, "/message/query", Map.of("sort", "ASC")).data())).containsExactly("m1", "m2", "m3", "m4", "m5", "while down");
            Sock again = Sock.connect(s.socketUrl()).handshake();
            assertThat(again.closed.getCount()).isEqualTo(1);
        }
    }

    @Test
    void restartClosesSocketsButKeepsDataAndRowNumbers() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String chat = seed(s);
            long before = n(s.messages().get(4).get("originalROWID"));
            int port = s.port();
            Sock c = Sock.connect(s.socketUrl()).handshake();
            s.restart();
            assertThat(c.closesWithin(3000)).isTrue();
            assertThat(s.restarts()).isEqualTo(1);
            assertThat(s.port()).isEqualTo(port);
            s.receive(chat, "+15551230001", "after restart");
            long after = n(s.messages().get(5).get("originalROWID"));
            assertThat(after).isGreaterThan(before);
            assertThat(s.messages()).hasSize(6);
            List<Object> rows = s.messages().stream().map(m -> m.get("originalROWID")).toList();
            assertThat(rows).isSorted();
            assertThat(rows).doesNotHaveDuplicates();
            assertThat(get(s, "/ping").status()).isEqualTo(200);
            Sock back = Sock.connect(s.socketUrl()).handshake();
            assertThat(back.closed.getCount()).isEqualTo(1);
        }
    }

    @Test
    void dropSocketsClosesThemAndTheServerStaysUp() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            Sock c = Sock.connect(s.socketUrl()).handshake();
            s.dropSockets();
            assertThat(c.closesWithin(3000)).isTrue();
            assertThat(get(s, "/ping").status()).isEqualTo(200);
        }
    }

    @Test
    void failNextSendsAnswers500EmitsTheErrorAndStoresNothing() throws Exception {
        try (FakeBlueBubbles s = FakeBlueBubbles.start(PW)) {
            String chat = s.directChat("+15551230001");
            Sock c = Sock.connect(s.socketUrl()).handshake();
            s.failNextSends(2);
            assertThat(post(s, "/message/text", Map.of("chatGuid", "nope", "message", "x")).status()).isEqualTo(400);   // a bad request does not use one up
            Resp r = post(s, "/message/text", Map.of("chatGuid", chat, "tempGuid", "t1", "message", "x"));
            assertThat(r.status()).isEqualTo(500);
            assertThat(n(r.json().get("status"))).isEqualTo(500);
            List<Object> ev = c.event();
            assertThat(ev.get(0)).isEqualTo("message-send-error");
            assertThat(map(ev.get(1))).containsEntry("tempGuid", "t1").containsEntry("text", "x");
            assertThat(n(map(ev.get(1)).get("error"))).isNotZero();
            assertThat(post(s, "/message/text", Map.of("chatGuid", chat, "message", "x")).status()).isEqualTo(500);
            assertThat(s.sent()).isEmpty();
            assertThat(s.messages()).isEmpty();

            Resp ok = post(s, "/message/text", Map.of("chatGuid", chat, "message", "third time"));
            assertThat(ok.status()).isEqualTo(200);
            assertThat(s.sent()).hasSize(1);
            assertThat(n(s.messages().get(0).get("originalROWID"))).isEqualTo(1);
        }
    }

    @Test
    void aSettableClockDatesNewMessages() throws Exception {
        java.time.Clock fixed = java.time.Clock.fixed(Instant.ofEpochMilli(T0), java.time.ZoneOffset.UTC);
        try (FakeBlueBubbles s = FakeBlueBubbles.start(FakeBlueBubbles.Options.defaults(PW).withClock(fixed))) {
            String chat = s.directChat("+15551230001");
            s.receive(chat, "+15551230001", "a");
            assertThat(n(s.messages().get(0).get("dateCreated"))).isEqualTo(T0);
            s.setClock(java.time.Clock.fixed(Instant.ofEpochMilli(T0 + 5000), java.time.ZoneOffset.UTC));
            post(s, "/message/text", Map.of("chatGuid", chat, "message", "b"));
            assertThat(n(s.sent().get(0).get("dateCreated"))).isEqualTo(T0 + 5000);
        }
    }
}
