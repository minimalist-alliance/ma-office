package com.minimalistalliance.desk.courier.testkit;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Hostile HTML for Courier's sanitizer and for a real browser's check of what gets through: XSS and remote-load vectors
 * from the categories of the OWASP XSS Filter Evasion Cheat Sheet and html5sec, written fresh for this kit. Every vector
 * calls {@code alert(} when it runs, or fetches its own URL on the counting host when it loads, or both.
 *
 * <p>The resource is {@code courier-testkit/html/vectors.txt}; its header comment has the format. In short: a vector
 * starts with {@code == <name>} and runs to the next such line; {@code {{HIT}}} is the counting URL,
 * {@code {{HIT//}}} the same without its scheme, and {@code {{U+hhhh}}} one code point (NUL, CR, tab and the like, so the
 * file holds no control bytes).
 */
public final class HostileHtml {

    /** The host the corpus's generated HTML points at: it never resolves, so nothing fetched from it can answer. */
    public static final String CORPUS_HIT_BASE = "http://hit.invalid/hit";

    private static final String RESOURCE = "/courier-testkit/html/vectors.txt";
    private static final Pattern CODE_POINT = Pattern.compile("\\{\\{U\\+([0-9A-Fa-f]{4,6})}}");
    private static final Pattern NAME = Pattern.compile("[a-z0-9-]+");

    private HostileHtml() {
    }

    /** One vector: a unique name and its HTML. */
    public record Vector(String name, String html) {
        public Vector {
            Objects.requireNonNull(name, "name");
            Objects.requireNonNull(html, "html");
        }
    }

    /** Every vector as written, with {@code {{HIT}}} and {@code {{HIT//}}} still in it (code points filled). */
    public static List<Vector> vectors() {
        List<Vector> out = new ArrayList<>();
        String name = null;
        List<String> lines = new ArrayList<>();
        for (String line : MimeCorpus.lines(RESOURCE)) {
            if (line.startsWith("== ")) {
                if (name != null) {
                    out.add(vector(name, lines));
                }
                name = line.substring(3).strip();
                if (!NAME.matcher(name).matches()) {
                    throw new IllegalStateException("vectors.txt: bad name " + name);
                }
                lines.clear();
            } else if (name != null) {
                lines.add(line);
            }
        }
        if (name != null) {
            out.add(vector(name, lines));
        }
        return List.copyOf(out);
    }

    /**
     * Every vector with its URLs filled: {@code {{HIT}}} becomes {@code hitBase + "/" + name}, and {@code {{HIT//}}} the same
     * without the scheme. So with {@code http://127.0.0.1:PORT/hit}, each loading vector fetches
     * {@code http://127.0.0.1:PORT/hit/<name>} (or a path under it, for a {@code base href}), and a browser check can count
     * hits per vector.
     */
    public static List<Vector> vectors(String hitBase) {
        Objects.requireNonNull(hitBase, "hitBase");
        String base = hitBase.endsWith("/") ? hitBase.substring(0, hitBase.length() - 1) : hitBase;
        int colon = base.indexOf("//");
        String schemeless = colon < 0 ? base : base.substring(colon);
        List<Vector> out = new ArrayList<>();
        for (Vector v : vectors()) {
            out.add(new Vector(v.name(), v.html().replace("{{HIT//}}", schemeless + "/" + v.name()).replace("{{HIT}}", base + "/" + v.name())));
        }
        return List.copyOf(out);
    }

    private static Vector vector(String name, List<String> lines) {
        int end = lines.size();
        while (end > 0 && lines.get(end - 1).isBlank()) {
            end--;
        }
        String html = String.join("\n", lines.subList(0, end));
        Matcher m = CODE_POINT.matcher(html);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            m.appendReplacement(out, Matcher.quoteReplacement(Character.toString(Integer.parseInt(m.group(1), 16))));
        }
        m.appendTail(out);
        return new Vector(name, out.toString());
    }
}
