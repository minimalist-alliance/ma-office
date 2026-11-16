package com.minimalistalliance.desk.courier.parse;

import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * An inline {@code style} attribute, cut to basic styles (the launch plan §3.1): an allow-list of properties, and values
 * that can name no resource and run nothing. A declaration goes whole if its value holds anything that could load or
 * hide behind an escape: {@code url(}, {@code image-set}, {@code expression}, {@code @import}, a backslash, a comment,
 * angle brackets, or a function other than the colour ones. Position tricks go too: {@code position} other than
 * {@code static} or {@code relative}, {@code z-index}, {@code transform}, and negative margins.
 * <p>{@link #clean} is idempotent: cleaning its output gives the same string, which the sanitizer's second pass checks.
 */
final class Css {

    private Css() {}

    static final int MAX_STYLE = 4096;

    private static final Set<String> PROPERTIES = Set.of(
            "color", "background-color", "font", "font-family", "font-size", "font-style", "font-weight", "font-variant",
            "text-align", "text-decoration", "text-decoration-line", "text-decoration-color", "text-transform",
            "text-indent", "letter-spacing", "word-spacing", "line-height", "white-space", "word-break", "word-wrap",
            "overflow-wrap", "vertical-align", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
            "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "border", "border-top",
            "border-right", "border-bottom", "border-left", "border-color", "border-style", "border-width",
            "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-top-style",
            "border-right-style", "border-bottom-style", "border-left-style", "border-top-width", "border-right-width",
            "border-bottom-width", "border-left-width", "border-collapse", "border-spacing", "border-radius", "width",
            "height", "max-width", "min-width", "max-height", "min-height", "display", "list-style-type",
            "list-style-position", "table-layout", "float", "clear", "overflow", "visibility", "position", "box-sizing",
            "caption-side", "empty-cells", "text-overflow");

    /** Properties whose value is a fixed word from a short list. */
    private static final Map<String, Set<String>> WORDS = Map.of(
            "display", Set.of("block", "inline", "inline-block", "none", "table", "table-row", "table-cell", "table-row-group",
                    "table-header-group", "table-footer-group", "table-column", "table-column-group", "table-caption",
                    "list-item", "flex", "inline-flex", "inline-table"),
            "position", Set.of("static", "relative"),
            "visibility", Set.of("visible", "hidden", "collapse"),
            "float", Set.of("left", "right", "none"),
            "clear", Set.of("left", "right", "both", "none"),
            "overflow", Set.of("visible", "hidden", "auto", "scroll", "clip"));

    /** What a value may be made of: words, numbers with units, colours, quoted font names, commas and the colour functions. */
    private static final Pattern VALUE = Pattern.compile(
            "(?i)(?:[a-z][a-z0-9-]*|#[0-9a-f]{3,8}|[+-]?(?:[0-9]{1,6}(?:\\.[0-9]{1,4})?|\\.[0-9]{1,4})(?:%|[a-z]{1,4})?"
                    + "|\"[a-z0-9 _.-]{1,64}\"|'[a-z0-9 _.-]{1,64}'|,|/|(?:rgb|rgba|hsl|hsla)\\([0-9.,% /]{1,48}\\)|\\s+)+");
    private static final Set<String> FORBIDDEN = Set.of("url", "image", "expression", "import", "javascript", "vbscript",
            "behavior", "binding", "element", "attr", "var", "env", "cross-fade", "paint", "src", "content", "counter", "calc");
    private static final Pattern NEGATIVE = Pattern.compile("(^|[\\s,])-[0-9.]");

    /** The style kept, or null when nothing of it is. */
    static String clean(String style) {
        if (style == null || style.length() > MAX_STYLE * 4) {
            return null;
        }
        StringBuilder out = new StringBuilder();
        for (String declaration : style.split(";")) {
            int colon = declaration.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            String property = declaration.substring(0, colon).strip().toLowerCase(Locale.ROOT);
            String value = declaration.substring(colon + 1).strip();
            String kept = value(property, value);
            if (kept != null && out.length() + property.length() + kept.length() + 2 <= MAX_STYLE) {
                if (out.length() > 0) {
                    out.append(' ');
                }
                out.append(property).append(": ").append(kept).append(';');
            }
        }
        return out.length() == 0 ? null : out.toString();
    }

    private static String value(String property, String value) {
        if (!PROPERTIES.contains(property) || value.isEmpty() || value.length() > 512) {
            return null;
        }
        String v = value.replaceAll("(?i)\\s*!\\s*important\\s*$", "").strip();
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c < 0x20 || c > 0x7E || c == '\\' || c == '<' || c == '>' || c == '@' || c == '{' || c == '}' || c == ';'
                    || c == ':' || c == '&' || c == '`') {
                return null;
            }
        }
        if (v.contains("/*") || v.contains("*/")) {
            return null;
        }
        String lower = v.toLowerCase(Locale.ROOT);
        // VALUE below allows no function but the colour ones; these words go even as bare words, belt and braces.
        for (String word : FORBIDDEN) {
            if (lower.contains(word + "(") || lower.contains(word + " (")) {
                return null;
            }
        }
        if (lower.contains("url") || lower.contains("expression") || lower.contains("image-set") || lower.contains("javascript")) {
            return null;
        }
        Set<String> words = WORDS.get(property);
        if (words != null) {
            return words.contains(lower) ? lower : null;
        }
        if ((property.startsWith("margin") || property.endsWith("width") || property.endsWith("height") || property.equals("text-indent"))
                && NEGATIVE.matcher(v).find()) {
            return null;
        }
        if (!VALUE.matcher(v).matches()) {
            return null;
        }
        return v.replaceAll("\\s+", " ");
    }

    private static final Pattern ZERO_BOX = Pattern.compile("(?:^|\\s)(?:height|max-height|width|max-width): 0(?:px)?;");

    /**
     * Whether a style hides its element and everything in it from the eye: {@code display: none}, {@code visibility:
     * hidden}, or a box of no height or width that hides what overflows. Tiny text is {@link #fontPx}'s, as a child can
     * set its own size again (Security CP-I2, CP-I9).
     */
    static boolean hides(String cleanStyle) {
        if (cleanStyle == null) {
            return false;
        }
        String s = cleanStyle.toLowerCase(Locale.ROOT);
        return s.contains("display: none;") || s.contains("visibility: hidden;") || s.contains("visibility: collapse;")
                || s.contains("overflow: hidden;") && ZERO_BOX.matcher(s).find();
    }

    /** At or under this many pixels, text is too small to read, and a reader's text leaves it out (Security CP-I2). */
    static final double UNREADABLE_PX = 2;
    /** A browser's default size, which {@code rem} and the size keywords go by. */
    static final double DEFAULT_PX = 16;

    private static final Pattern FONT_DECLARATION = Pattern.compile("(?:^|\\s)(font-size|font): ([^;]+);");
    private static final Pattern SIZE = Pattern.compile("([0-9]*\\.?[0-9]+)(px|pt|pc|em|rem|ex|ch|%|vw|vh|vmin|vmax|in|cm|mm|q)?");
    private static final Map<String, Double> SIZE_WORDS = Map.of("xx-small", 9.0, "x-small", 10.0, "small", 13.0,
            "medium", 16.0, "large", 18.0, "x-large", 24.0, "xx-large", 32.0, "xxx-large", 48.0);

    /**
     * The font size, in CSS pixels, that an element with this clean style has inside a parent of {@code parentPx}: its own
     * {@code font-size}, or the size in its {@code font}, relative units against the parent's. With neither, the
     * parent's. So a wrapper of {@code font-size: 0} whose children set {@code 14px}, as column layouts do, leaves their
     * text readable, and a {@code 1em} inside it doesn't.
     */
    static double fontPx(String cleanStyle, double parentPx) {
        if (cleanStyle == null) {
            return parentPx;
        }
        String s = cleanStyle.toLowerCase(Locale.ROOT);
        double px = parentPx;
        // In order, so the later of font and font-size wins, as in CSS (Security CP-I10); clean keeps the order.
        var declarations = FONT_DECLARATION.matcher(s);
        while (declarations.find()) {
            if (declarations.group(1).equals("font-size")) {
                double size = size(declarations.group(2).strip(), parentPx);
                if (!Double.isNaN(size)) {
                    px = size;
                }
                continue;
            }
            for (String token : declarations.group(2).strip().split("\\s+")) {
                int slash = token.indexOf('/');
                double size = size(slash >= 0 ? token.substring(0, slash) : token, parentPx);
                if (!Double.isNaN(size)) {
                    px = size;
                    break;
                }
            }
        }
        return px;
    }

    /** One size value in pixels, or NaN when it isn't one (a weight, a style or a family in {@code font}). */
    private static double size(String v, double parentPx) {
        Double word = SIZE_WORDS.get(v);
        if (word != null) {
            return word;
        }
        if (v.equals("smaller")) {
            return parentPx / 1.2;
        }
        if (v.equals("larger")) {
            return parentPx * 1.2;
        }
        var m = SIZE.matcher(v);
        if (!m.matches()) {
            return Double.NaN;
        }
        double n = Double.parseDouble(m.group(1));
        String unit = m.group(2);
        if (unit == null) {
            // A bare number is a size only when it's 0; in font it's a weight (400, 700).
            return n == 0 ? 0 : Double.NaN;
        }
        return switch (unit) {
            case "px" -> n;
            case "pt" -> n * 4 / 3;
            case "pc" -> n * 16;
            case "in" -> n * 96;
            case "cm" -> n * 96 / 2.54;
            case "mm" -> n * 96 / 25.4;
            case "q" -> n * 96 / 101.6;
            case "em" -> n * parentPx;
            case "ex", "ch" -> n * parentPx / 2;
            case "%" -> n * parentPx / 100;
            case "rem" -> n * DEFAULT_PX;
            default -> n == 0 ? 0 : n * 8; // vw, vh and the like, against an 800-pixel view
        };
    }

    private static final Pattern TINY = Pattern.compile("(?:^|\\s)(width|height|max-width|max-height): (?:0|[0-2](?:\\.[0-9]+)?px|0(?:\\.[0-9]+)?(?:em|rem|%));");

    /** Whether a style makes its element at most 2 px wide or high, as an open-tracking pixel is. */
    static boolean tiny(String cleanStyle) {
        return cleanStyle != null && TINY.matcher(cleanStyle.toLowerCase(Locale.ROOT)).find();
    }
}
