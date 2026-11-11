package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One of Chromium's own pages, opened hidden for one call and closed after it: its Password Manager, its bookmarks or
 * its extensions page. Hidden means no tab, nothing in the Browser a member sees, nothing session restore brings back
 * and no history ({@code Target.createTarget}'s {@code hidden}, which Chromium 156 has and which {@code desk-adblock}
 * uses for {@code chrome://policy}), and Chromium closes it by itself if deskd's connection goes.
 *
 * <p><b>What runs in it.</b> Only the constant functions of {@link SignIns}, in the page's own world, where Chromium's
 * {@code chrome.passwordsPrivate}, {@code chrome.bookmarks} and {@code chrome.developerPrivate} are. What a member gave,
 * such as the rows of a passwords file, goes in as {@code Runtime.callFunctionOn}'s arguments, values and never source,
 * and only small results come back. These pages show no web content, so nothing in them is a page's. An exception's
 * words are never read or logged: one can quote an argument.
 */
final class ChromiumPages {

    /** The three pages, each with the API it waits for. */
    enum Kind {
        PASSWORDS("chrome://password-manager/passwords", "passwordsPrivate"),
        BOOKMARKS("chrome://bookmarks/", "bookmarks"),
        EXTENSIONS("chrome://extensions/", "developerPrivate");

        final String url;
        final String api;

        Kind(String url, String api) {
            this.url = url;
            this.api = api;
        }

        /** The page's global once its API is there, as a handle for callFunctionOn, and undefined until then. */
        String ready() {
            return "(typeof chrome === 'object' && typeof chrome." + api + " === 'object') ? globalThis : undefined";
        }
    }

    /** The function threw or its promise was rejected. Holds nothing from the page. */
    static final class Failed extends Exception {
        private static final long serialVersionUID = 1L;

        Failed() {
            super("failed", null, false, false);
        }
    }

    private static final Duration POLL = Duration.ofMillis(100);

    private final SignIns.Chromium chromium;
    private final Duration load;

    ChromiumPages(SignIns.Chromium chromium, Duration load) {
        this.chromium = chromium;
        this.load = load;
    }

    /** A page that's ready for calls, closed by {@link Page#close}, or an exception and no page. */
    Page open(Kind kind) throws CdpException, Failed, InterruptedException {
        Map<String, Object> created = chromium.call(null, "Target.createTarget", Map.of("url", kind.url, "hidden", true), chromium.request());
        String targetId = Json.string(created, "targetId");
        if (targetId == null || targetId.isEmpty() || targetId.length() > 128) {
            throw CdpException.remote(0);
        }
        Page page = new Page(targetId);
        try {
            Map<String, Object> attached =
                    chromium.call(null, "Target.attachToTarget", Map.of("targetId", targetId, "flatten", true), chromium.request());
            page.sessionId = Json.string(attached, "sessionId");
            if (page.sessionId == null || page.sessionId.isEmpty()) {
                throw CdpException.remote(0);
            }
            long deadline = System.nanoTime() + load.toNanos();
            while (true) {
                Map<String, Object> reply = chromium.call(
                        page.sessionId, "Runtime.evaluate", Map.of("expression", kind.ready(), "silent", true), chromium.request());
                Map<String, Object> result = Json.object(reply, "result");
                String objectId = result == null ? null : Json.string(result, "objectId");
                if (reply.get("exceptionDetails") == null && objectId != null && !objectId.isEmpty()) {
                    page.global = objectId;
                    return page;
                }
                if (System.nanoTime() >= deadline) {
                    throw new Failed();
                }
                Thread.sleep(POLL.toMillis());
            }
        } catch (CdpException | Failed | InterruptedException | RuntimeException e) {
            page.close();
            throw e;
        }
    }

    final class Page implements AutoCloseable {
        private final String targetId;
        private String sessionId;
        private String global;

        private Page(String targetId) {
            this.targetId = targetId;
        }

        /**
         * One of {@link SignIns}'s constant functions, awaited, with these arguments as values.
         *
         * @return the function's value, as JSON gives it
         * @throws Failed if it threw or its promise was rejected
         */
        Object call(String function, Duration timeout, Object... arguments) throws CdpException, Failed, InterruptedException {
            List<Map<String, Object>> args = new ArrayList<>();
            for (Object argument : arguments) {
                Map<String, Object> arg = new LinkedHashMap<>();
                arg.put("value", argument);
                args.add(arg);
            }
            Map<String, Object> params = new LinkedHashMap<>();
            params.put("functionDeclaration", function);
            params.put("objectId", global);
            params.put("arguments", args);
            params.put("awaitPromise", true);
            params.put("returnByValue", true);
            params.put("silent", true);
            Map<String, Object> reply = chromium.call(sessionId, "Runtime.callFunctionOn", params, timeout);
            Map<String, Object> result = Json.object(reply, "result");
            if (reply.get("exceptionDetails") != null || result == null) {
                throw new Failed();
            }
            return result.get("value");
        }

        /** Closes it. Never throws: a page that can't be closed now goes with deskd's connection. */
        @Override
        public void close() {
            boolean interrupted = Thread.interrupted();
            try {
                chromium.call(null, "Target.closeTarget", Map.of("targetId", targetId), chromium.request());
            } catch (CdpException e) {
                // Gone already, or Chromium has: either way it's not a page any more.
            } catch (InterruptedException e) {
                interrupted = true;
            } finally {
                if (interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }
}
