package com.minimalistalliance.desk.deskd.courier.imsg.bluebubbles;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The parts of BlueBubbles Server's REST API (under {@code /api/v1}) the iMessage transport uses, over {@link MacLink}.
 * Every answer is the server's envelope {@code {status, message, data, metadata}}, parsed with deskd's JSON limits (64
 * deep, no repeated key) and then read as untrusted: a field of the wrong type is a missing field, and nothing a server
 * says is ever a reason to connect anywhere else.
 *
 * <p>Routes: {@code GET server/info}, {@code POST message/query}, {@code GET message/<guid>}, {@code GET
 * attachment/<guid>/download}, {@code POST message/text}, {@code GET contact}.
 */
final class BlueBubbles {

    /** A guid as BlueBubbles names a message, chat or attachment: the seam's own pattern, one encoded path segment on a route. */
    static final Pattern GUID = com.minimalistalliance.desk.deskd.courier.imsg.ImsgSink.GUID;

    /** The most the Mac's contacts answer may be: it lists every card. */
    static final long MAX_CONTACTS_JSON = 4L * 1024 * 1024;

    /** The server refused the password. */
    static final class Unauthorized extends IOException {
        private static final long serialVersionUID = 1L;

        Unauthorized() {
            super("unauthorized", null);
        }
    }

    /** An answer that isn't 2xx: {@code status}, and the server's own words, which go to no member and no log. */
    static final class Failed extends IOException {
        private static final long serialVersionUID = 1L;
        private final int status;
        private final String said;

        Failed(int status, String said) {
            super("status " + status, null);
            this.status = status;
            this.said = said;
        }

        int status() {
            return status;
        }

        /** Whether the server's words say this (lowercased): for telling "chat does not exist" from other refusals. */
        boolean says(String words) {
            return said != null && said.toLowerCase(java.util.Locale.ROOT).contains(words);
        }
    }

    /** What {@code server/info} says. */
    record Info(String serverVersion, String osVersion, boolean privateApi, boolean helperConnected, String proxyService,
            String detectedImessage, String detectedIcloud) {}

    /** A page of messages: the messages, and the total the server says matched. */
    record Page(List<Map<String, Object>> messages, long total) {}

    private final MacLink link;
    private final MacAddress address;
    private final String pin;

    BlueBubbles(MacLink link, MacAddress address, String pin) {
        this.link = link;
        this.address = address;
        this.pin = pin;
    }

    MacAddress address() {
        return address;
    }

    String pin() {
        return pin;
    }

    Info info(byte[] password) throws IOException {
        Object data = call(password, "GET", "server/info", null, null).get("data");
        if (!(data instanceof Map<?, ?> d)) {
            throw new MacLink.Protocol("info");
        }
        return new Info(str(d.get("server_version")), str(d.get("os_version")), Boolean.TRUE.equals(d.get("private_api")),
                Boolean.TRUE.equals(d.get("helper_connected")), str(d.get("proxy_service")), str(d.get("detected_imessage")),
                str(d.get("detected_icloud")));
    }

    /** Messages dated after {@code after} (epoch ms, exclusive), oldest first, with their chats, people and files. */
    Page after(byte[] password, long after, int offset, int limit) throws IOException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("after", after);
        body.put("offset", offset);
        body.put("limit", limit);
        body.put("sort", "ASC");
        body.put("with", List.of("chat", "chat.participants", "attachment", "handle"));
        Map<String, Object> answer = call(password, "POST", "message/query", null, Json.bytes(body));
        List<Map<String, Object>> out = new ArrayList<>();
        if (answer.get("data") instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof Map<?, ?> m) {
                    out.add(cast(m));
                }
                if (out.size() >= limit) {
                    break;
                }
            }
        } else {
            throw new MacLink.Protocol("query");
        }
        long total = answer.get("metadata") instanceof Map<?, ?> md && md.get("total") instanceof Number n ? n.longValue() : -1;
        return new Page(out, total);
    }

    /** One message by its guid, with its chats, people and files; null if the server has none. */
    Map<String, Object> message(byte[] password, String guid) throws IOException {
        if (!GUID.matcher(guid).matches()) {
            return null;
        }
        try {
            Object data = call(password, "GET", "message/" + seg(guid), "with=chat,chat.participants,attachment,handle", null).get("data");
            return data instanceof Map<?, ?> m ? cast(m) : null;
        } catch (Failed f) {
            if (f.status() == 404 || f.status() == 400) {
                return null;
            }
            throw f;
        }
    }

    /**
     * An attachment's bytes, at most {@code max}: more is {@link MacLink.TooLarge}, never a part of the file. The exchange's
     * bound grows with the file: its usual 90 seconds, and a second for every 128 KiB it may be (a slow uplink, IM-L2).
     */
    byte[] download(byte[] password, String guid, long max, long sizeHint) throws IOException {
        if (!GUID.matcher(guid).matches()) {
            throw new MacLink.Protocol("guid");
        }
        java.time.Duration bound = link.settings().exchange().plusSeconds(Math.max(0, max) / (128 * 1024));
        MacLink.Response r = link.exchange(address, pin, password, "GET", "attachment/" + seg(guid) + "/download", null, null, max, bound,
                Math.min(Math.max(0, sizeHint), max));
        check(r);
        return r.body();
    }

    /** Sends text to a chat, by AppleScript (no Private API needed); the message as the server stored it. */
    Map<String, Object> sendText(byte[] password, String chatGuid, String text, String tempGuid) throws IOException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("chatGuid", chatGuid);
        body.put("message", text);
        body.put("tempGuid", tempGuid);
        body.put("method", "apple-script");
        Object data = call(password, "POST", "message/text", null, Json.bytes(body)).get("data");
        return data instanceof Map<?, ?> m ? cast(m) : Map.of();
    }

    /** The Mac's contact cards. */
    List<Map<String, Object>> contacts(byte[] password) throws IOException {
        Object data = call(password, "GET", "contact", null, null, MAX_CONTACTS_JSON).get("data");
        List<Map<String, Object>> out = new ArrayList<>();
        if (data instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof Map<?, ?> m) {
                    out.add(cast(m));
                }
            }
        }
        return out;
    }

    // ---- plumbing

    private Map<String, Object> call(byte[] password, String method, String route, String query, byte[] body) throws IOException {
        return call(password, method, route, query, body, link.settings().maxJson());
    }

    private Map<String, Object> call(byte[] password, String method, String route, String query, byte[] body, long max) throws IOException {
        MacLink.Response r = link.exchange(address, pin, password, method, route, query, body, max);
        check(r);
        try {
            return Json.parseObject(r.body());
        } catch (Exception e) {
            throw new MacLink.Protocol("json");
        }
    }

    private static void check(MacLink.Response r) throws IOException {
        int s = r.status();
        if (s / 100 == 2) {
            return;
        }
        if (s == 401 || s == 403) {
            throw new Unauthorized();
        }
        String said = null;
        try {
            Map<String, Object> m = Json.parseObject(r.body());
            Object err = m.get("error");
            said = (m.get("message") instanceof String w ? w : "") + " " + (err instanceof Map<?, ?> e && e.get("error") instanceof String x ? x : "");
            if (said.length() > 300) {
                said = said.substring(0, 300);
            }
        } catch (Exception ignored) {
            // no words
        }
        throw new Failed(s, said);
    }

    /** A guid as one path segment: encoded, so {@code /} and the rest can't make another route. */
    static String seg(String guid) {
        return URLEncoder.encode(guid, StandardCharsets.UTF_8).replace("+", "%20");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Map<?, ?> m) {
        return (Map<String, Object>) m;
    }

    static String str(Object o) {
        return o instanceof String s ? s : null;
    }
}
