package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * Tells deskd when a page asked for protected (DRM) playback and was refused (TD-225). The image's Chromium has no
 * Widevine, and no Linux Chromium has PlayReady or FairPlay, so a site such as a film service fails, often with an error
 * of its own that doesn't say why. The Desk app shows a small note instead; this is how deskd knows to.
 *
 * <p><b>The signal.</b> Every player that uses DRM first calls {@code navigator.requestMediaKeySystemAccess}, and here a
 * protected key system's request is always refused, so the refusal is the one sure sign. CDP has no event for it: the
 * Media domain sees players, not key requests, and Chromium logs nothing for an unknown key system. So {@link #PAGE}, in
 * the top frame's own world, wraps that one method, and on the first refusal of a protected key system it fires a DOM
 * event whose type is a random name per deskd. deskd's isolated world {@code ma-deskd} in that document hears it, as
 * worlds share the DOM, and calls a binding there, which comes to deskd as {@code Runtime.bindingCalled}. A binding in
 * the page's own world would need {@code Runtime.enable} to reach each new document, which costs every page's console
 * and is a well-known way for a site to tell automation, so it's never used.
 *
 * <p><b>What a page sees.</b> The same promise result: the refusal is the same error object, a microtask later, and a
 * grant passes through unchanged. A request for anything else (ClearKey, which Chromium has, or a key system it doesn't
 * know) and every request after the first refusal get the original promise untouched. The method keeps its name, length,
 * property descriptor and behaviour with {@code new}. What's left to see is {@code Function.prototype.toString}, which
 * now prints no name inside {@code [native code]}, and a frame of ours in the stack of an error thrown synchronously by
 * a call with bad arguments. Nothing in the page's world carries a name a page could find, and nothing is added to the
 * DOM. Frames other than the top one are left alone.
 *
 * <p><b>What deskd learns.</b> One of three words, {@code wv}, {@code pr} or {@code fps}: when the page is first refused,
 * and again each time deskd sets its listener up in that document (an attach, a commit), which BrowserTabs keeps once
 * per document. No URL, no page content, no arguments. A page that wanted to could fake it only by guessing the random
 * names, and then only for its own tab, with a note it could as well draw itself.
 *
 * <p><b>Cost.</b> One script per top-level document while deskd is connected, which wraps one method, and three calls
 * per main-frame commit to set up the listener in the world deskd already makes for other reasons. Nothing runs while a
 * page plays nothing protected.
 *
 * <p><b>The kill switch.</b> {@value #SWITCH_FILE} on the data volume, with the rules of every deskd switch (the owner's
 * rule: finished features ship on, and a switch only turns them off; see {@link MinifiedSwitch}). With the word
 * {@code off}, deskd injects nothing into new documents, removes its registrations from tabs that have one
 * ({@code Page.removeScriptToEvaluateOnNewDocument}), ignores its binding and reports no {@code protectedMedia}.
 */
final class ProtectedMedia {

    /** On the data volume, beside the other switches. */
    static final String SWITCH_FILE = "protected-media-switch";

    /** Whether the feature is on, read from {@value #SWITCH_FILE} in this directory while deskd runs. */
    static BooleanSupplier switchIn(Path directory) {
        return MinifiedSwitch.file(directory, SWITCH_FILE)::on;
    }

    /** Key systems as deskd tells of them, by the word the binding sends. ClearKey isn't here: Chromium has it. */
    private static final Map<String, String> KEY_SYSTEMS = Map.of(
            "wv", "com.widevine.alpha",
            "pr", "com.microsoft.playready",
            "fps", "com.apple.fps");

    /**
     * The top frame's own world, at the start of each document and once at once (runImmediately). A second copy from a
     * later connection of the same deskd finds the first through {@code ALIVE} and leaves. Only what was taken from the
     * page's globals before any page script ran is used once it's installed, so a page that patches Array, Promise or
     * Event later can't reach in, and the Proxy's handler has no prototype for a page to add traps to.
     */
    private static final String PAGE = """
            (() => {
              const g = globalThis;
              if (g.top !== g) return;
              const N = g.Navigator, E = g.Event, T = g.EventTarget;
              const proto = N && N.prototype;
              const d = proto && Object.getOwnPropertyDescriptor(proto, 'requestMediaKeySystemAccess');
              if (!d || typeof d.value !== 'function' || typeof E !== 'function' || !T) return;
              const apply = Reflect.apply, then = Promise.prototype.then, prevent = E.prototype.preventDefault;
              const dispatch = T.prototype.dispatchEvent, listen = T.prototype.addEventListener;
              if (!apply(dispatch, g, [new E('@ALIVE@', {cancelable: true})])) return;
              const prefixes = ['com.widevine.', 'wv', 'com.microsoft.playready', 'pr', 'com.youtube.playready', 'pr',
                'com.chromecast.playready', 'pr', 'com.apple.fps', 'fps'];
              const family = (s) => {
                for (let i = 0; i < prefixes.length; i += 2) {
                  const p = prefixes[i];
                  let j = 0;
                  while (j < p.length && j < s.length && s[j] === p[j]) j++;
                  if (j === p.length) return prefixes[i + 1];
                }
                return '';
              };
              let failed = '';
              const tell = () => { try { apply(dispatch, g, [new E('@FAIL@' + failed)]); } catch (e) {} };
              apply(listen, g, ['@ALIVE@', (e) => { apply(prevent, e, []); }]);
              apply(listen, g, ['@HELLO@', () => { if (failed) tell(); }]);
              d.value = new Proxy(d.value, {__proto__: null, apply(t, self, args) {
                const r = apply(t, self, args);
                const f = failed || args.length === 0 || typeof args[0] !== 'string' ? '' : family(args[0]);
                return f ? apply(then, r, [undefined, (e) => { if (!failed) { failed = f; tell(); } throw e; }]) : r;
              }});
              Object.defineProperty(proto, 'requestMediaKeySystemAccess', d);
            })();
            """;

    /**
     * deskd's isolated world in one document: listens for {@link #PAGE}'s event, once per world, and asks each time
     * whether the page was refused already. Chromium hands a later CDP session the same world in the same document
     * (checked on Chrome 158), so after a reconnect this is how deskd hears again of a page refused before, or while
     * nothing was connected: the page's script remembers, and tells again when asked. The binding is looked up at each
     * call, as each session adds its own.
     */
    private static final String WORLD = """
            (() => {
              const g = globalThis;
              if (!g['@MARK@']) {
                g['@MARK@'] = true;
                for (const f of ['wv', 'pr', 'fps']) {
                  g.addEventListener('@FAIL@' + f, () => { const send = g['@BINDING@']; if (typeof send === 'function') send(f); });
                }
              }
              g.dispatchEvent(new Event('@HELLO@'));
            })()
            """;

    /** What deskd heard of one document: when, and which key system, as the Browser's tabs say. */
    record Seen(String at, String keySystem) {
        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("at", at);
            map.put("keySystem", keySystem);
            return map;
        }
    }

    private final String binding;
    private final String page;
    private final String world;

    ProtectedMedia() {
        this(randomToken());
    }

    /** @param token what every name is made from: letters and digits only */
    ProtectedMedia(String token) {
        if (!token.matches("[A-Za-z0-9]{8,64}")) {
            throw new IllegalArgumentException("token");
        }
        this.binding = "ma" + token + "b";
        String alive = "ma" + token + "a";
        String fail = "ma" + token + "f";
        String hello = "ma" + token + "h";
        String mark = "ma" + token + "m";
        this.page = PAGE.replace("@ALIVE@", alive).replace("@FAIL@", fail).replace("@HELLO@", hello);
        this.world = WORLD.replace("@BINDING@", binding).replace("@FAIL@", fail).replace("@HELLO@", hello).replace("@MARK@", mark);
    }

    private static String randomToken() {
        byte[] bytes = new byte[8];
        new SecureRandom().nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    String binding() {
        return binding;
    }

    /** For tests: the two scripts, so a test can tell them from deskd's other ones. */
    String pageScript() {
        return page;
    }

    String worldScript() {
        return world;
    }

    /**
     * The key system a binding's call names, if it's this deskd's binding and one of the three words. Anything else is
     * nobody's business and says nothing.
     */
    String keySystem(Map<String, Object> params) {
        if (!binding.equals(Json.string(params, "name"))) {
            return null;
        }
        String word = Json.string(params, "payload");
        return word == null ? null : KEY_SYSTEMS.get(word);
    }

    /**
     * The page's half, in every top-level document of the tab from now on, and in the one it holds now.
     *
     * @return the registration's identifier, to remove it with, or null if Chromium gave none
     */
    String install(CdpClient cdp, String sessionId, Duration timeout) throws CdpException, InterruptedException {
        Map<String, Object> result =
                cdp.call(sessionId, "Page.addScriptToEvaluateOnNewDocument", Map.of("source", page, "runImmediately", true), timeout);
        return Json.string(result, "identifier");
    }

    /**
     * Stops {@link #PAGE} being put in the tab's next documents. The copy already running in the page stays until the page
     * goes, and does nothing deskd listens to.
     */
    void remove(CdpClient cdp, String sessionId, String identifier, Duration timeout) throws CdpException, InterruptedException {
        cdp.call(sessionId, "Page.removeScriptToEvaluateOnNewDocument", Map.of("identifier", identifier), timeout);
    }

    /**
     * deskd's half, in the document the main frame holds when Chromium gets the call: the world, the binding in it alone,
     * and the listener. A document that has gone by then fails the later calls, and the next commit's arm does its own.
     *
     * @param worldName the isolated world deskd already makes for its other constants
     */
    void arm(CdpClient cdp, String sessionId, String frameId, String worldName, Duration timeout) throws CdpException, InterruptedException {
        Map<String, Object> made = cdp.call(sessionId, "Page.createIsolatedWorld", Map.of("frameId", frameId, "worldName", worldName), timeout);
        if (!(made.get("executionContextId") instanceof Number context)) {
            return;
        }
        cdp.call(sessionId, "Runtime.addBinding", Map.of("name", binding, "executionContextId", context), timeout);
        cdp.call(sessionId, "Runtime.evaluate", Map.of("expression", world, "contextId", context), timeout);
    }
}
