package com.minimalistalliance.desk.courier.parse;

import java.util.ArrayDeque;
import java.util.Base64;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import org.jsoup.nodes.Attribute;
import org.jsoup.nodes.Comment;
import org.jsoup.nodes.DataNode;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.nodes.Entities;
import org.jsoup.nodes.Node;
import org.jsoup.nodes.TextNode;
import org.jsoup.parser.Parser;

/**
 * A message's HTML made safe to show (the launch plan §3.1, C2), in two passes.
 *
 * <p><b>Pass 1</b> builds a new tree from the hostile one, keeping only what an allow-list names: text, tables, basic
 * blocks and phrases, and inline styles cut to basic ones ({@link Css}). Scripts, styles, frames, objects, forms' controls,
 * SVG, MathML, templates, {@code meta}, {@code link} and {@code base} go with everything inside them; any other element is
 * unwrapped (its children kept). No attribute that loads anything is written:
 * <ul>
 * <li>a link has no {@code href}: its destination is in {@code data-ma-href} (made plain by {@link Links}), its host in
 *     {@code data-ma-host}, its warnings in {@code data-ma-warn}, and the full destination in {@code title}, which a
 *     pointer shows without any script;</li>
 * <li>a remote image has no {@code src}: it's {@code data-ma-src} (without tracking parameters), shown only after the
 *     member says so, and fetched by the desk; a tracker (ADR 0076's lists, a size of 2 px or less, a hidden one, an
 *     open-tracking path) is removed outright;</li>
 * <li>a {@code cid:} image is {@code data-ma-cid}, the message's own part;</li>
 * <li>a {@code data:} image is decoded and drawn again ({@link Images}) as {@code data:image/png} or {@code jpeg}, or
 *     goes.</li>
 * </ul>
 *
 * <p><b>Pass 2</b> reads pass 1's output again with an HTML5 parser, as a browser would, and checks it: it must
 * serialize to exactly the same string (so no parser can read it as a different tree: mutation XSS), and every element,
 * attribute and value must be one pass 1 writes, each value checked again by its own rule. If either check fails, the HTML
 * is left out and only the text is kept: it fails closed. The office then shows it in a frame with no scripts and its own
 * CSP, the third wall.
 *
 * <p>The text (for a message with no plain part, for search and for agents) is rendered from pass 1's tree, leaving out
 * what a style hides, with each link as {@code words <destination>}.
 */
final class Html {

    private Html() {}

    /** What came of it: the safe HTML or null, the text, and counts for the tests. */
    record Result(String html, String text, boolean textTruncated, int trackers, int remoteImages, int links) {}

    /** The inline images a message may re-encode, across all its HTML. */
    static final class Budget {
        int bytes = Limits.MAX_INLINE_IMAGES_BYTES;
    }

    private static final Set<String> KEEP = Set.of("a", "abbr", "address", "article", "aside", "b", "big", "blockquote", "br",
            "caption", "cite", "code", "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure",
            "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav",
            "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strong", "sub", "sup", "table", "tbody", "td",
            "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr");
    private static final Map<String, String> MAP = Map.of("center", "div", "font", "span", "strike", "s", "tt", "code",
            "acronym", "abbr", "listing", "pre");
    /** Gone with everything inside them. */
    private static final Set<String> DROP = Set.of("script", "style", "template", "iframe", "frame", "frameset", "object",
            "embed", "applet", "param", "title", "head", "meta", "link", "base", "basefont", "bgsound", "svg", "math", "audio",
            "video", "source", "track", "canvas", "map", "area", "input", "button", "select", "option", "optgroup",
            "textarea", "datalist", "output", "progress", "meter", "noscript", "noembed", "noframes", "xmp", "plaintext",
            "dialog", "portal", "slot", "keygen", "isindex", "command", "menuitem", "search", "fencedframe", "selectedcontent");
    /** The elements pass 1 can write, which pass 2 allows. */
    private static final Set<String> OUT = new TreeSet<>(KEEP);

    private static final Set<String> TABLE_PARTS = Set.of("table", "tbody", "thead", "tfoot", "tr", "td", "th", "col", "colgroup",
            "caption");
    private static final Set<String> BLOCKS = Set.of("address", "article", "aside", "blockquote", "caption", "dd", "div", "dl",
            "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol",
            "p", "pre", "section", "table", "tbody", "tfoot", "thead", "tr", "ul");
    private static final Set<String> PARAGRAPHS = Set.of("p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table", "ul",
            "ol", "dl", "pre", "hr", "figure");

    private static final Pattern NUMBER = Pattern.compile("[0-9]{1,5}");
    private static final Pattern LENGTH = Pattern.compile("[0-9]{1,5}%?");
    private static final Pattern COLOR = Pattern.compile("#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}");
    private static final Pattern LANG = Pattern.compile("[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8}){0,4}");
    private static final Pattern DATETIME = Pattern.compile("[0-9TZtz:+\\-. ]{1,64}");
    private static final Pattern CID = Pattern.compile("[\\x21-\\x7E&&[^\"'<>\\\\`]]{1,255}");
    private static final Pattern DATA_IMAGE = Pattern.compile("data:image/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}");
    private static final Set<String> WARNINGS = Set.of("mismatch", "ip", "punycode", "userinfo", "tracker");
    private static final String[] FONT_SIZES = {"10px", "13px", "16px", "18px", "24px", "32px", "48px"};

    /**
     * Sanitizes {@code input} (at most {@link Limits#MAX_HTML_IN_CHARS}; the caller cuts it).
     */
    static Result sanitize(String input, Budget budget) {
        Parser parser = Parser.htmlParser().setMaxDepth(512);
        Document source = parser.parseInput(input, "");
        Pass1 pass = new Pass1(budget);
        Element clean = pass.run(source.body());
        TextOut text = new TextOut(Limits.MAX_TEXT_CHARS);
        text.render(clean);
        String html = null;
        if (!pass.overflow) {
            String once = serialize(clean);
            if (once.length() <= Limits.MAX_HTML_OUT_CHARS && verify(once)) {
                html = once;
            }
        }
        return new Result(html, text.toString(), text.truncated(), pass.trackers, pass.remote, pass.links);
    }

    private static Document.OutputSettings settings() {
        return new Document.OutputSettings().prettyPrint(false).outline(false).indentAmount(0)
                .escapeMode(Entities.EscapeMode.xhtml).charset("UTF-8").syntax(Document.OutputSettings.Syntax.html);
    }

    static String serialize(Element body) {
        Document shell = Document.createShell("");
        shell.outputSettings(settings());
        for (Node child : List.copyOf(body.childNodes())) {
            shell.body().appendChild(child);
        }
        return shell.body().html();
    }

    // ---- pass 1

    private static final class Pass1 {
        final Budget budget;
        int elements;
        int trackers;
        int remote;
        int links;
        int chars;
        boolean overflow;

        Pass1(Budget budget) {
            this.budget = budget;
        }

        /** One step of the walk: a source node, where its copy goes, how deep that is, and whether only text is kept. */
        private record Step(Node node, Element parent, int depth, boolean textOnly) {}

        Element run(Element body) {
            Document out = Document.createShell("");
            Element root = out.body();
            Deque<Step> stack = new ArrayDeque<>();
            if (body != null) {
                pushChildren(stack, body, root, 0, false);
            }
            while (!stack.isEmpty()) {
                Step s = stack.pop();
                visit(s, stack);
            }
            return root;
        }

        private static void pushChildren(Deque<Step> stack, Node from, Element parent, int depth, boolean textOnly) {
            List<Node> kids = from.childNodes();
            for (int i = kids.size() - 1; i >= 0; i--) {
                stack.push(new Step(kids.get(i), parent, depth, textOnly));
            }
        }

        private void visit(Step s, Deque<Step> stack) {
            Node node = s.node();
            if (node instanceof TextNode t) {
                text(s.parent(), t.getWholeText());
                return;
            }
            if (node instanceof Comment || node instanceof DataNode || !(node instanceof Element e)) {
                return;
            }
            String tag = e.normalName();
            if (DROP.contains(tag) || tag.indexOf(':') > 0 && (tag.startsWith("svg") || tag.startsWith("math"))) {
                return;
            }
            String out = KEEP.contains(tag) ? tag : MAP.get(tag);
            boolean textOnly = s.textOnly() || s.depth() >= Limits.MAX_HTML_DEPTH || overflow;
            if (out == null || textOnly) {
                // Unwrapped: its children join the parent. Past the depth limit, or the element cap, only text is kept.
                pushChildren(stack, e, s.parent(), s.depth(), textOnly);
                if (textOnly && BLOCKS.contains(tag)) {
                    text(s.parent(), " ");
                }
                return;
            }
            if (++elements > Limits.MAX_ELEMENTS) {
                overflow = true;
                pushChildren(stack, e, s.parent(), s.depth(), true);
                return;
            }
            Element copy;
            switch (out) {
                case "img" -> {
                    image(e, s.parent());
                    return;
                }
                case "a" -> {
                    copy = anchor(e);
                    if (copy == null) {
                        pushChildren(stack, e, s.parent(), s.depth(), false);
                        return;
                    }
                }
                default -> copy = new Element(out);
            }
            attributes(e, copy, tag, out);
            s.parent().appendChild(copy);
            pushChildren(stack, e, copy, s.depth() + 1, false);
        }

        private void text(Element parent, String raw) {
            String t = TextClean.clean(raw, true);
            if (t.isEmpty() || chars > Limits.MAX_HTML_OUT_CHARS) {
                return;
            }
            chars += t.length();
            if (chars > Limits.MAX_HTML_OUT_CHARS) {
                overflow = true;
            }
            parent.appendChild(new TextNode(t));
        }

        private Element anchor(Element e) {
            Links.Link link = Links.inspect(e.attr("href"), boundedText(e));
            if (link == null) {
                return null;
            }
            links++;
            Element a = new Element("a");
            a.attr("data-ma-href", link.url());
            if (link.host() != null) {
                a.attr("data-ma-host", link.host());
            }
            if (!link.warnings().isEmpty()) {
                a.attr("data-ma-warn", String.join(" ", new TreeSet<>(link.warnings())));
            }
            a.attr("title", link.url());
            return a;
        }

        /**
         * A link's words as a reader sees them: all the text inside it, its whitespace collapsed, or null past
         * {@link Links#MAX_URL} (Security CP-L5: the words of most mail sit in a child element between whitespace).
         * Inline elements join with nothing between, as on screen, so a host split across them is still one host
         * (CP-I8); a block, a cell or a line break is a space.
         */
        private static String boundedText(Element e) {
            StringBuilder b = new StringBuilder();
            Deque<Object> stack = new ArrayDeque<>();
            stack.push(e);
            while (!stack.isEmpty()) {
                Object o = stack.pop();
                if (o instanceof TextNode t) {
                    b.append(t.getWholeText());
                    if (b.length() > Links.MAX_URL * 2) {
                        return null;
                    }
                } else if (o instanceof Element el && !DROP.contains(el.normalName())) {
                    String tag = el.normalName();
                    boolean apart = el != e && (BLOCKS.contains(tag) || tag.equals("br") || tag.equals("td") || tag.equals("th"));
                    if (apart) {
                        b.append(' ');
                        stack.push(" ");
                    }
                    List<Node> kids = el.childNodes();
                    for (int i = kids.size() - 1; i >= 0; i--) {
                        stack.push(kids.get(i));
                    }
                } else if (o instanceof String space) {
                    b.append(space);
                }
            }
            String words = b.toString().replaceAll("\\s+", " ").strip();
            return words.isEmpty() || words.length() > Links.MAX_URL ? null : words;
        }

        private void image(Element e, Element parent) {
            String src = Links.strip(e.attr("src"));
            String width = e.attr("width").strip();
            String height = e.attr("height").strip();
            String style = Css.clean(e.attr("style"));
            String alt = TextClean.clean(e.attr("alt"), false);
            String lower = src.toLowerCase(Locale.ROOT);
            Element img = new Element("img");
            if (lower.startsWith("cid:")) {
                String cid = Links.percentDecode(src.substring(4)).strip();
                if (cid.startsWith("<") && cid.endsWith(">")) {
                    cid = cid.substring(1, cid.length() - 1);
                }
                if (!CID.matcher(cid).matches()) {
                    altText(parent, alt);
                    return;
                }
                img.attr("data-ma-cid", cid);
            } else if (lower.startsWith("data:")) {
                String data = inline(src);
                if (data == null) {
                    altText(parent, alt);
                    return;
                }
                img.attr("src", data);
            } else {
                Links.Link link = Links.inspect(src, null);
                if (link == null || link.kind() != Links.Kind.WEB) {
                    altText(parent, alt);
                    return;
                }
                if (tracker(link, width, height, style)) {
                    trackers++;
                    return;
                }
                remote++;
                img.attr("data-ma-src", link.url());
            }
            if (alt != null && !alt.isBlank()) {
                img.attr("alt", cut(alt, 500));
            }
            if (LENGTH.matcher(width).matches()) {
                img.attr("width", width);
            }
            if (LENGTH.matcher(height).matches()) {
                img.attr("height", height);
            }
            if (style != null) {
                img.attr("style", style);
            }
            parent.appendChild(img);
        }

        private void altText(Element parent, String alt) {
            if (alt != null && !alt.isBlank()) {
                text(parent, cut(alt, 500));
            }
        }

        private static boolean tracker(Links.Link link, String width, String height, String style) {
            String url0 = link.url();
            int at = url0.indexOf('/', url0.indexOf("://") + 3);
            if (link.warnings().contains("tracker") || Trackers.current().listed(link.host(), at < 0 ? "/" : url0.substring(at))) {
                return true;
            }
            int w = small(width);
            int h = small(height);
            if (w >= 0 && w <= 2 && (h < 0 || h <= 2) || h >= 0 && h <= 2 && w < 0 || w == 0 || h == 0) {
                return true;
            }
            if (Css.hides(style) || Css.tiny(style)) {
                return true;
            }
            String url = link.url();
            int path = url.indexOf('/', url.indexOf("://") + 3);
            String p = path < 0 ? "/" : url.substring(path);
            int q = p.indexOf('?');
            return Trackers.pixelPath(q >= 0 ? p.substring(0, q) : p);
        }

        /** A size attribute as a number of pixels (px or none), or -1. */
        private static int small(String v) {
            String s = v.toLowerCase(Locale.ROOT).replace("px", "").strip();
            return NUMBER.matcher(s).matches() ? Integer.parseInt(s) : -1;
        }

        /** A data: image decoded and drawn again, or null. */
        private String inline(String src) {
            int comma = src.indexOf(',');
            if (comma < 0) {
                return null;
            }
            String meta = src.substring(5, comma).toLowerCase(Locale.ROOT);
            if (!meta.startsWith("image/") || !meta.endsWith(";base64") || meta.startsWith("image/svg")) {
                return null;
            }
            String b64 = src.substring(comma + 1).replaceAll("[\\s]", "");
            if (b64.length() > (long) Limits.MAX_INLINE_IMAGE_BYTES * 4 / 3 + 4 || b64.length() * 3L / 4 > budget.bytes) {
                return null;
            }
            byte[] bytes;
            try {
                bytes = Base64.getMimeDecoder().decode(b64);
            } catch (IllegalArgumentException ex) {
                return null;
            }
            budget.bytes -= bytes.length;
            try {
                Images.Encoded enc = Images.reencode(bytes, new java.io.ByteArrayInputStream(bytes), Limits.INLINE_IMAGE_SIDE);
                return "data:image/" + enc.type() + ";base64," + Base64.getEncoder().encodeToString(enc.bytes());
            } catch (Refusal r) {
                return null;
            }
        }

        private static void attributes(Element from, Element to, String tag, String out) {
            String style = Css.clean(from.attr("style"));
            if (tag.equals("font")) {
                StringBuilder extra = new StringBuilder();
                String color = from.attr("color").strip();
                if (COLOR.matcher(color).matches()) {
                    extra.append("color: ").append(color).append("; ");
                }
                String face = from.attr("face").strip();
                if (!face.isEmpty()) {
                    String f = Css.clean("font-family: " + face);
                    if (f != null) {
                        extra.append(f).append(' ');
                    }
                }
                String size = from.attr("size").strip();
                if (size.matches("[1-7]")) {
                    extra.append("font-size: ").append(FONT_SIZES[size.charAt(0) - '1']).append("; ");
                }
                style = Css.clean(extra + (style == null ? "" : style));
            } else if (tag.equals("center")) {
                style = Css.clean("text-align: center; " + (style == null ? "" : style));
            }
            if (style != null) {
                to.attr("style", style);
            }
            for (Attribute a : from.attributes()) {
                String name = a.getKey().toLowerCase(Locale.ROOT);
                String v = a.getValue() == null ? "" : a.getValue().strip();
                String kept = keep(out, name, v);
                if (kept != null && !to.hasAttr(name)) {
                    to.attr(name, kept);
                }
            }
        }
    }

    /** An attribute pass 1 keeps on an element it writes, with its value made safe, or null. Pass 2 checks with it too. */
    static String keep(String tag, String name, String v) {
        switch (name) {
            case "dir" -> {
                String d = v.toLowerCase(Locale.ROOT);
                return d.equals("ltr") || d.equals("rtl") || d.equals("auto") ? d : null;
            }
            case "lang" -> {
                return LANG.matcher(v).matches() ? v : null;
            }
            case "title" -> {
                return tag.equals("a") ? null : v.isEmpty() ? null : cut(TextClean.clean(v, false), 300);
            }
            case "align" -> {
                String a = v.toLowerCase(Locale.ROOT);
                return Set.of("left", "right", "center", "justify").contains(a) ? a : null;
            }
            case "valign" -> {
                String a = v.toLowerCase(Locale.ROOT);
                return Set.of("top", "middle", "bottom", "baseline").contains(a) ? a : null;
            }
            case "width", "height" -> {
                String s = v.toLowerCase(Locale.ROOT).replace("px", "").strip();
                return (TABLE_PARTS.contains(tag) || tag.equals("hr")) && LENGTH.matcher(s).matches() ? s : null;
            }
            case "bgcolor" -> {
                return TABLE_PARTS.contains(tag) && COLOR.matcher(v).matches() ? v : null;
            }
            case "border" -> {
                return (tag.equals("table") || tag.equals("img")) && NUMBER.matcher(v).matches() && Integer.parseInt(v) <= 20 ? v : null;
            }
            case "cellpadding", "cellspacing" -> {
                return tag.equals("table") && NUMBER.matcher(v).matches() && Integer.parseInt(v) <= 100 ? v : null;
            }
            case "colspan", "rowspan" -> {
                return (tag.equals("td") || tag.equals("th")) && NUMBER.matcher(v).matches() && Integer.parseInt(v) >= 1
                        && Integer.parseInt(v) <= 1000 ? v : null;
            }
            case "span" -> {
                return (tag.equals("col") || tag.equals("colgroup")) && NUMBER.matcher(v).matches() && Integer.parseInt(v) >= 1
                        && Integer.parseInt(v) <= 1000 ? v : null;
            }
            case "nowrap", "reversed" -> {
                return name.equals("nowrap") && (tag.equals("td") || tag.equals("th")) || name.equals("reversed") && tag.equals("ol")
                        ? "" : null;
            }
            case "scope" -> {
                String a = v.toLowerCase(Locale.ROOT);
                return tag.equals("th") && Set.of("row", "col", "rowgroup", "colgroup").contains(a) ? a : null;
            }
            case "start", "value" -> {
                return (name.equals("start") ? tag.equals("ol") : tag.equals("li")) && NUMBER.matcher(v).matches() ? v : null;
            }
            case "type" -> {
                return (tag.equals("ol") || tag.equals("li")) && Set.of("1", "a", "A", "i", "I").contains(v)
                        || tag.equals("ul") && Set.of("disc", "circle", "square").contains(v.toLowerCase(Locale.ROOT)) ? v : null;
            }
            case "datetime" -> {
                return (tag.equals("time") || tag.equals("del") || tag.equals("ins")) && DATETIME.matcher(v).matches() ? v : null;
            }
            default -> {
                return null;
            }
        }
    }

    private static String cut(String s, int max) {
        return s == null || s.length() <= max ? s : s.substring(0, max);
    }

    // ---- pass 2

    /**
     * Pass 2: {@code html} read again as a browser would, which must serialize to the same string, holding only what pass 1
     * writes, every value checked by its own rule.
     */
    static boolean verify(String html) {
        Document again = Parser.htmlParser().setMaxDepth(512).parseInput("<body>" + html, "");
        again.outputSettings(settings());
        Element body = again.body();
        if (!body.html().equals(html) || again.head().childNodeSize() != 0) {
            return false;
        }
        for (Element e : body.getAllElements()) {
            if (e == body) {
                continue;
            }
            if (!OUT.contains(e.normalName()) || !e.tagName().equals(e.normalName())) {
                return false;
            }
            for (Attribute a : e.attributes()) {
                if (!allowedOut(e, a.getKey(), a.getValue())) {
                    return false;
                }
            }
            for (Node n : e.childNodes()) {
                if (!(n instanceof TextNode) && !(n instanceof Element)) {
                    return false;
                }
            }
        }
        for (Node n : body.childNodes()) {
            if (!(n instanceof TextNode) && !(n instanceof Element)) {
                return false;
            }
        }
        return true;
    }

    private static boolean allowedOut(Element e, String name, String v) {
        String tag = e.normalName();
        switch (name) {
            case "style" -> {
                return v.equals(Css.clean(v));
            }
            case "data-ma-href" -> {
                if (!tag.equals("a")) {
                    return false;
                }
                Links.Link link = Links.inspect(v, null);
                return link != null && link.url().equals(v) && e.attr("title").equals(v);
            }
            case "data-ma-host" -> {
                return tag.equals("a") && v.equals(Links.asciiHost(v));
            }
            case "data-ma-warn" -> {
                if (!tag.equals("a") || v.isEmpty()) {
                    return false;
                }
                for (String w : v.split(" ", -1)) {
                    if (!WARNINGS.contains(w)) {
                        return false;
                    }
                }
                return true;
            }
            case "title" -> {
                return tag.equals("a") ? v.equals(e.attr("data-ma-href")) : v.equals(keep(tag, name, v));
            }
            case "data-ma-src" -> {
                if (!tag.equals("img")) {
                    return false;
                }
                Links.Link link = Links.inspect(v, null);
                return link != null && link.kind() == Links.Kind.WEB && link.url().equals(v);
            }
            case "data-ma-cid" -> {
                return tag.equals("img") && CID.matcher(v).matches();
            }
            case "src" -> {
                return tag.equals("img") && DATA_IMAGE.matcher(v).matches();
            }
            case "alt" -> {
                return tag.equals("img") && v.length() <= 500 && v.equals(TextClean.clean(v, false));
            }
            case "width", "height" -> {
                return tag.equals("img") ? LENGTH.matcher(v).matches() : v.equals(keep(tag, name, v));
            }
            default -> {
                return v.equals(keep(tag, name, v));
            }
        }
    }

    // ---- text

    /** Plain text from a clean tree, as it would read on screen. */
    static final class TextOut {
        private final StringBuilder out = new StringBuilder();
        private final int max;
        private boolean truncated;
        /** Newlines owed before the next words: 1 for a line, 2 for a paragraph. */
        private int owed;
        private boolean space;

        TextOut(int max) {
            this.max = max;
        }

        boolean truncated() {
            return truncated;
        }

        /** {@code px}: the font size the node's text has, so text too small to read is left out (Security CP-I2, CP-I9). */
        private record Frame(Node node, boolean exit, boolean pre, double px, int mark) {}

        void render(Element root) {
            Deque<Frame> stack = new ArrayDeque<>();
            stack.push(new Frame(root, false, false, Css.DEFAULT_PX, 0));
            while (!stack.isEmpty() && !truncated) {
                Frame f = stack.pop();
                if (f.node() instanceof TextNode t) {
                    if (f.px() > Css.UNREADABLE_PX) {
                        words(t.getWholeText(), f.pre());
                    }
                    continue;
                }
                if (!(f.node() instanceof Element e)) {
                    continue;
                }
                String tag = e.normalName();
                if (f.exit()) {
                    close(e, tag, out.length() > f.mark());
                    continue;
                }
                if (e != root && Css.hides(e.attr("style"))) {
                    continue;
                }
                open(e, tag);
                double px = Css.fontPx(e.attr("style"), f.px());
                stack.push(new Frame(e, true, f.pre(), px, out.length()));
                boolean pre = f.pre() || tag.equals("pre");
                List<Node> kids = e.childNodes();
                for (int i = kids.size() - 1; i >= 0; i--) {
                    stack.push(new Frame(kids.get(i), false, pre, px, 0));
                }
            }
        }

        private void open(Element e, String tag) {
            if (tag.equals("br")) {
                line(1);
                owed = Math.max(owed, 1);
                return;
            }
            if (BLOCKS.contains(tag)) {
                owed = Math.max(owed, PARAGRAPHS.contains(tag) ? 2 : 1);
            }
            if (tag.equals("li")) {
                Element parent = e.parent();
                String marker = parent != null && parent.normalName().equals("ol") ? (e.elementSiblingIndex() + 1) + ". " : "- ";
                flushOwed();
                append(marker);
            } else if ((tag.equals("td") || tag.equals("th")) && e.elementSiblingIndex() > 0) {
                space = true;
            }
        }

        /**
         * {@code wrote}: whether anything of the element reached the text. A link's destination goes with what of it
         * was shown, or with an image in it, which no font size hides; an image's alt stands for the image.
         */
        private void close(Element e, String tag, boolean wrote) {
            if (tag.equals("a") && (wrote || !e.getElementsByTag("img").isEmpty())) {
                String href = e.attr("data-ma-href");
                if (!href.isEmpty() && !href.startsWith("tel:")) {
                    String words = e.text().strip();
                    String shown = href.startsWith("mailto:") ? href.substring(7) : href;
                    if (!words.equalsIgnoreCase(shown) && !words.equalsIgnoreCase(href)) {
                        // Apart from the words, or from an image's alt, which isn't in them.
                        space = true;
                        word("<" + shown + ">");
                    }
                }
            } else if (tag.equals("img") && e.parent() != null && e.parent().normalName().equals("a")) {
                String alt = e.attr("alt").strip();
                if (!alt.isEmpty()) {
                    word(alt);
                }
            }
            if (BLOCKS.contains(tag)) {
                owed = Math.max(owed, PARAGRAPHS.contains(tag) ? 2 : 1);
            }
        }

        private void words(String text, boolean pre) {
            if (pre) {
                flushOwed();
                append(text);
                return;
            }
            int i = 0;
            int n = text.length();
            while (i < n) {
                char c = text.charAt(i);
                if (Character.isWhitespace(c) || c == ' ') {
                    space = true;
                    i++;
                    continue;
                }
                int j = i;
                while (j < n && !Character.isWhitespace(text.charAt(j)) && text.charAt(j) != ' ') {
                    j++;
                }
                word(text.substring(i, j));
                i = j;
            }
        }

        private void word(String w) {
            if (owed > 0) {
                flushOwed();
            } else if (space && out.length() > 0 && out.charAt(out.length() - 1) != '\n') {
                append(" ");
            }
            space = false;
            append(w);
        }

        private void flushOwed() {
            if (out.length() > 0 && owed > 0) {
                line(owed);
            }
            owed = 0;
            space = false;
        }

        /** Ends the line, then adds blank lines until {@code n} newlines end the text. */
        private void line(int n) {
            int have = 0;
            for (int i = out.length() - 1; i >= 0 && out.charAt(i) == '\n'; i--) {
                have++;
            }
            while (out.length() > 0 && have < n) {
                append("\n");
                have++;
            }
        }

        private void append(String s) {
            if (truncated) {
                return;
            }
            if (out.length() + s.length() > max) {
                out.append(s, 0, max - out.length());
                truncated = true;
                return;
            }
            out.append(s);
        }

        @Override
        public String toString() {
            int end = out.length();
            while (end > 0 && (out.charAt(end - 1) == '\n' || out.charAt(end - 1) == ' ')) {
                end--;
            }
            return out.substring(0, end);
        }
    }
}
