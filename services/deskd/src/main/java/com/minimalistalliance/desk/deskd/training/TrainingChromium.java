package com.minimalistalliance.desk.deskd.training;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Stands in for Chromium's debugging port with two pages, the second on screen, so {@code BrowserTabs} runs what
 * it does on a real connection, the visibility question included. Answers as Chrome 156 did when probed for
 * ADR 0041. {@code FakeCdp} in the tests is the careful one of these.
 */
final class TrainingChromium implements LoopbackServer.Handler {

    private static final String BROWSER_PATH = "/devtools/browser/training";
    private static final String ON_SCREEN = "page-b";

    private volatile int port;

    void port(int value) {
        port = value;
    }

    private static Map<String, Object> page(String id) {
        return Map.of("id", id, "type", "page", "url", "https://example.invalid/" + id, "title", id);
    }

    private static Map<String, Object> info(String id) {
        return Map.of("targetId", id, "type", "page", "url", "https://example.invalid/" + id, "title", id, "attached", false);
    }

    @Override
    public LoopbackServer.Response http(LoopbackServer.Request request) {
        return switch (request.path()) {
            case "/json/version" -> new LoopbackServer.Response(200, text(Map.of(
                    "Browser", "Training/1", "webSocketDebuggerUrl", "ws://127.0.0.1:" + port + BROWSER_PATH)));
            case "/json/list" -> {
                // The tab opened behind comes first, as a middle click leaves it.
                String wrapped = text(Map.of("l", List.of(page("page-a"), page(ON_SCREEN))));
                yield new LoopbackServer.Response(200, wrapped.substring(5, wrapped.length() - 1));
            }
            default -> new LoopbackServer.Response(404, "");
        };
    }

    @Override
    public void webSocket(LoopbackServer.Request request, LoopbackServer.Peer peer) throws Exception {
        String text;
        while ((text = peer.read()) != null) {
            Map<String, Object> command = Json.parseObject(text.getBytes(StandardCharsets.UTF_8));
            String method = Json.string(command, "method");
            String sessionId = Json.string(command, "sessionId");
            Map<String, Object> params = Json.object(command, "params");
            Map<String, Object> reply = new LinkedHashMap<>();
            reply.put("id", command.get("id"));
            if (sessionId != null) {
                reply.put("sessionId", sessionId);
            }
            reply.put("result", result(method, sessionId, params));
            peer.send(text(reply));
            event(peer, method, sessionId);
        }
    }

    private static Map<String, Object> result(String method, String sessionId, Map<String, Object> params) {
        return switch (method == null ? "" : method) {
            case "Target.getTargets" -> Map.of("targetInfos", List.of(info("page-a"), info(ON_SCREEN)));
            case "Target.attachToTarget" -> Map.of("sessionId", "S" + Json.string(params, "targetId"));
            case "Target.createTarget" -> Map.of("targetId", "page-c");
            case "Target.closeTarget" -> Map.of("success", true);
            case "Page.getNavigationHistory" -> Map.of(
                    "currentIndex", 0,
                    "entries", List.of(Map.of("id", 1, "url", "https://example.invalid/")));
            case "Page.createIsolatedWorld" -> Map.of("executionContextId", 7);
            case "Runtime.evaluate" -> Map.of("result", Map.of(
                    "type", "string", "value", ("S" + ON_SCREEN).equals(sessionId) ? "visible" : "hidden"));
            case "Page.navigate" -> Map.of("frameId", "frame");
            default -> Map.of();
        };
    }

    /** What follows a command on a real connection, so the read path's cases get used. */
    private static void event(LoopbackServer.Peer peer, String method, String sessionId) throws Exception {
        if ("Target.setDiscoverTargets".equals(method)) {
            peer.send(text(Map.of("method", "Target.targetCreated", "params", Map.of("targetInfo", info("page-a")))));
            peer.send(text(Map.of("method", "Target.targetInfoChanged", "params", Map.of("targetInfo", info(ON_SCREEN)))));
        } else if ("Page.navigate".equals(method) && sessionId != null) {
            String frame = sessionId.substring(1);
            peer.send(text(Map.of("method", "Page.frameStartedLoading", "sessionId", sessionId, "params", Map.of("frameId", frame))));
            peer.send(text(Map.of("method", "Page.frameNavigated", "sessionId", sessionId, "params", Map.of("frame", Map.of("id", frame, "url", "https://example.invalid/")))));
            peer.send(text(Map.of("method", "Page.loadEventFired", "sessionId", sessionId, "params", Map.of("timestamp", 1))));
            peer.send(text(Map.of("method", "Page.frameStoppedLoading", "sessionId", sessionId, "params", Map.of("frameId", frame))));
        } else if ("Target.closeTarget".equals(method)) {
            peer.send(text(Map.of("method", "Target.targetDestroyed", "params", Map.of("targetId", "page-c"))));
        }
    }

    private static String text(Map<String, Object> value) {
        return new String(Json.bytes(value), StandardCharsets.UTF_8);
    }
}
