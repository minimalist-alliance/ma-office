package com.minimalistalliance.desk.deskd.browser.minified;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The only scripts the simplified view runs in a page, all constants from the jar. {@code distiller.js} is the
 * prototype's {@code extract.js}, byte for byte, at the commit {@code distiller.pin} names
 * ({@code services/scripts/sync-distiller.sh}; {@code DistillerPinTest} holds the two together): one distiller, not two.
 * What deskd must do differently it does here, as it loads the file, never by editing it:
 * <ul>
 *   <li>Mozilla Readability goes in the file's one {@code /*__READABILITY__*}{@code /} slot, as the prototype's server did.</li>
 *   <li>The prototype's own click path and its writes to the page ({@link #LEFT_OUT}) are cut out, and the file's
 *       {@code __mdoc} export is replaced by deskd's, which names only what deskd calls (Security T47-11): deskd acts
 *       through its own half, {@code proxy.js}, and never changes the page.</li>
 *   <li>deskd's small built-in cosmetic rules ({@code cosmetic-rules.json}) go in where the prototype's server sent
 *       EasyList: the lists themselves stay out of the desk, and the network blocklist is the desk image's.</li>
 * </ul>
 * If the prototype changes in a way this can't follow, {@link #load} fails, and so do the tests, rather than ship it.
 */
final class Scripts {

    /** deskd's isolated world for the view, apart from the Browser's own. */
    static final String WORLD = "ma-minify";
    /** The one function deskd calls, with its arguments as JSON values. */
    static final String RUN = "function(a){var p=globalThis.__maProxy;return p?p.run(a):{missing:true}}";

    private static final String BASE = "/com/minimalistalliance/desk/deskd/browser/minified/";
    private static final String READABILITY_SLOT = "/*__READABILITY__*/";

    /** For a tab's own session, so for its top frame and the frames in its process: the distiller, then deskd's half. */
    final String top;
    /** For a frame in a process of its own: deskd's half alone, as only the guard runs there. */
    final String frame;

    private Scripts(String top, String frame) {
        this.top = top;
        this.frame = frame;
    }

    static Scripts load() {
        String distiller = adapt(read("distiller.js"), read("readability.js"), read("cosmetic-rules.json"));
        String proxy = read("proxy.js");
        return new Scripts(distiller + "\n;\n" + proxy, proxy);
    }

    /** The prototype's click path and its writes to the page: functions deskd never runs, so never ships. */
    static final List<String> LEFT_OUT = List.of(
            "prepare", "guardHandler", "hit", "guardResult", "focusSelect", "clearOver", "adoptPopup", "restoreHidden");

    private static final String EXPORT_START = "  Object.defineProperty(window, '__mdoc', {";
    /** What deskd calls of the distiller, and nothing more. */
    private static final String EXPORT = "  Object.defineProperty(window, '__mdoc', {\n"
            + "    value: Object.freeze({ extractText, lookup, quiet, epoch: EPOCH, setRules, hasRules: () => !!RULES }),\n"
            + "    enumerable: false, configurable: false, writable: false,\n"
            + "  });";

    /** The prototype's distiller as deskd runs it. */
    static String adapt(String source, String readability, String rules) {
        String s = source.replace("\r\n", "\n");
        for (String name : LEFT_OUT) {
            s = cut(s, name);
        }
        s = dropLines(s, "guardHandler");
        int export = s.indexOf(EXPORT_START);
        int end = export < 0 ? -1 : s.indexOf("\n  });", export);
        if (export < 0 || end < 0) {
            throw new IllegalStateException("distiller.js: no __mdoc export where deskd expects it");
        }
        s = s.substring(0, export) + EXPORT + s.substring(end + "\n  });".length());
        int at = 0;
        for (String line : s.split("\n", -1)) {
            String code = line.contains("//") ? line.substring(0, line.indexOf("//")) : line;
            Matcher left = LEFT_OUT_CALL.matcher(code);
            while (left.find()) {
                if (!ownedLocally(s, at + left.start(), left.group(1))) {
                    throw new IllegalStateException("distiller.js: " + left.group(1) + " is still there after the cut");
                }
            }
            at += line.length() + 1;
        }
        // The first slot only: the slot's words anywhere else, in a comment say, aren't a place for it.
        int slot = s.indexOf(READABILITY_SLOT);
        if (slot >= 0) {
            s = s.substring(0, slot) + readability + s.substring(slot + READABILITY_SLOT.length());
        }
        return s + "\n;try { const M = globalThis.__mdoc; if (M && !M.hasRules()) M.setRules(" + rules.strip() + "); } catch (e) { /* none */ }\n";
    }

    /**
     * Whether the call's own top-level function declares the name for itself, before the call: then the call is to that
     * local, not to the cut function. v9's {@code adVendorBox} has a {@code const hit = (p) => …} of its own. A call at
     * the top level, or in a function that doesn't declare the name, still fails the load.
     */
    private static boolean ownedLocally(String s, int call, String name) {
        Matcher top = TOP_LEVEL_LINE.matcher(s);
        int start = -1;
        while (top.find() && top.start() < call) {
            start = top.start();
        }
        if (start < 0) {
            return false;
        }
        Matcher local = Pattern.compile("\n {4,}(?:(?:const|let|var)\\s+" + Pattern.quote(name) + "\\s*=|function\\s+"
                + Pattern.quote(name) + "\\s*\\()").matcher(s.substring(start, call));
        return local.find();
    }

    /** A line of the distiller's own top level, inside its wrapper: two spaces in, and not a closing brace. */
    private static final Pattern TOP_LEVEL_LINE = Pattern.compile("(?m)^  [^ }\n]");

    private static final Pattern LEFT_OUT_CALL = Pattern.compile("(?<![\\w.$])(" + String.join("|", LEFT_OUT) + ")\\s*\\(");

    /** One top-level function of the distiller's, by name: a one-line one, or through its closing brace. */
    private static String cut(String s, String name) {
        String head = "\n  function " + name + "(";
        int start = s.indexOf(head);
        if (start < 0) {
            return s;
        }
        int lineEnd = s.indexOf('\n', start + 1);
        String line = s.substring(start + 1, lineEnd < 0 ? s.length() : lineEnd);
        int end;
        if (line.strip().endsWith("}") && count(line, '{') == count(line, '}')) {
            end = lineEnd;
        } else {
            int close = s.indexOf("\n  }\n", start);
            if (close < 0) {
                throw new IllegalStateException("distiller.js: no end to function " + name);
            }
            end = close + "\n  }".length();
        }
        return s.substring(0, start) + s.substring(end);
    }

    private static String dropLines(String s, String word) {
        StringBuilder out = new StringBuilder();
        for (String line : s.split("\n", -1)) {
            String code = line.contains("//") ? line.substring(0, line.indexOf("//")) : line;
            if (!code.contains(word)) {
                out.append(line).append('\n');
            }
        }
        return out.substring(0, Math.max(0, out.length() - 1));
    }

    private static long count(String s, char c) {
        return s.chars().filter(x -> x == c).count();
    }

    private static String read(String name) {
        try (InputStream in = Scripts.class.getResourceAsStream(BASE + name)) {
            if (in == null) {
                throw new IllegalStateException("missing resource " + name);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("unreadable resource " + name, e);
        }
    }
}
