package com.minimalistalliance.desk.deskd.browser.minified;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The builder against the distiller's output, friendly and hostile (Security T47-6, point 6): every document it makes
 * keeps to the schema, holds nothing it wasn't told to, and keeps sensitive fields out (T47-1) and images' URLs on the
 * desk (T47-5).
 */
class MDocBuilderTest {

    private static final String URL = "https://example.com/page";

    private final MDocSchema schema = new MDocSchema();
    private final Map<String, Map<String, Object>> nodes = new HashMap<>();
    private final Map<String, String> sens = new HashMap<>();
    private final List<Map<String, Object>> media = new ArrayList<>();
    private final List<Map<String, Object>> signals = new ArrayList<>();
    private final Map<String, Object> stats = new HashMap<>(Map.of("ready", "complete"));
    private final Map<String, Object> extras = new HashMap<>();
    private final Map<String, Object> meta = new LinkedHashMap<>(Map.of("mode", "page"));
    private final List<Map<String, Object>> raw = new ArrayList<>();
    private final Context context = new Context();

    MDocBuilderTest() throws Exception {}

    /** What a document's builds share, as the module keeps it. */
    private static final class Context implements MDocBuilder.Context {
        final Map<String, String> images = new LinkedHashMap<>();
        final Set<String> sensitive = new HashSet<>();

        @Override
        public String imageId(String url) {
            return images.computeIfAbsent(url, u -> "i1." + (images.size() + 1));
        }

        @Override
        public boolean wasSensitive(String ref) {
            return sensitive.contains(ref);
        }

        @Override
        public void markSensitive(String ref) {
            sensitive.add(ref);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> m(Object run) {
        return (Map<String, Object>) run;
    }

    private static Map<String, Object> map(Object... pairs) {
        Map<String, Object> map = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private void seen(String ref, String fp) {
        nodes.put(ref, new HashMap<>(Map.of("fp", fp)));
    }

    private void block(Object... pairs) {
        Map<String, Object> block = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            block.put((String) pairs[i], pairs[i + 1]);
        }
        raw.add(block);
    }

    private MDocBuilder.Built build() {
        return build(URL, "Example");
    }

    private MDocBuilder.Built build(String url, String title) {
        StringBuilder text = new StringBuilder(new String(Json.bytes(meta), StandardCharsets.UTF_8));
        for (Map<String, Object> block : raw) {
            text.append("\nhash\t").append(new String(Json.bytes(block), StandardCharsets.UTF_8));
        }
        MDocBuilder.Raw input = new MDocBuilder.Raw(text.toString(), nodes, sens, media, signals, stats, extras, 7);
        MDocBuilder.Built built = MDocBuilder.build("T1", url, title, input, context);
        assertThat(schema.check(built.doc().withRev(1).wire())).isEmpty();
        return built;
    }

    private static String json(MDoc doc) {
        return new String(Json.bytes(doc.wire()), StandardCharsets.UTF_8);
    }

    @SuppressWarnings("unchecked")
    private static List<Object> runs(MDoc doc, int block) {
        return (List<Object>) doc.blocks.get(block).get("runs");
    }

    @Test
    void theProtoypesBlocksAllKeepToTheSchema() {
        seen("e.1", "fp1");
        seen("e.2", "fp2");
        seen("e.3", "fp3");
        seen("e.4", "fp4");
        nodes.get("e.4").put("si", 1);
        block("k", "h", "l", 1, "c", List.of("Lamps"));
        block("k", "p", "q", 1, "c", List.of("Read ", List.of("a", "e.1", "https://example.com/next", "the next ", List.of("b", "page")), " now."));
        block("k", "li", "d", 2, "o", 3, "cont", 1, "c", List.of("Third"));
        block("k", "pre", "t", "line one\nline two\ttabbed");
        block("k", "hr");
        block("k", "img", "s", "https://cdn.example.com/lamp.png", "a", "A lamp", "w", 300, "h", 200);
        block("k", "tbl", "rows", List.of(List.of(Map.of("h", 1, "c", List.of("Size")), Map.of("c", List.of("Big"), "cs", 2))));
        block("k", "meta", "c", List.of("By Ann · 2026-11-07"));
        block("k", "chrome", "c", List.of(List.of("btn", "e.2", "Menu", Map.of("e", 0)),
                List.of("in", "e.3", Map.of("t", "search", "v", "lamps", "p", "Search", "l", "Search")),
                List.of("sel", "e.4", Map.of("v", "b", "o", List.of(List.of("a", "Small"), List.of("b", "Large")), "l", "Size"))));
        MDoc doc = build().doc();

        assertThat(doc.blocks).extracting(b -> b.get("t"))
                .containsExactly("heading", "para", "item", "code", "rule", "image", "table", "meta", "controls");
        assertThat(doc.blocks.get(3)).containsEntry("text", "line one\nline two\ttabbed");
        assertThat(doc.keys).doesNotHaveDuplicates();
        assertThat(doc.nodes).containsOnlyKeys("e.1", "e.2", "e.3", "e.4");
        assertThat(doc.nodes.get("e.1").block()).isEqualTo(doc.keys.get(1));
        assertThat(doc.nodes.get("e.1").kind()).isEqualTo(MDoc.NodeKind.LINK);
        assertThat(doc.nodes.get("e.4").options()).containsExactly("Small", "Large");
        // T47-5: the image's URL stays on the desk.
        assertThat(json(doc)).doesNotContain("cdn.example.com").contains("https://example.com/next");
        assertThat(context.images).containsKey("https://cdn.example.com/lamp.png");
        // T47-2: by index, and the page's own values never leave.
        Map<?, ?> select = (Map<?, ?>) runs(doc, 8).stream().filter(r -> r instanceof Map<?, ?> m && "select".equals(m.get("r"))).findFirst().orElseThrow();
        assertThat(select.get("selected")).isEqualTo(1);
        assertThat(json(doc)).doesNotContain("\"b\",\"Large\"");
    }

    @Test
    void nothingTheSchemaDoesntNamePassesWhateverThePageWrites() {
        seen("e.1", "fp1");
        block("k", "p", "style", "color:red", "class", "x", "dangerouslySetInnerHTML", Map.of("__html", "<script>"),
                "c", List.of("Hello ‮evil\u0000‏", List.of("script", "alert(1)"),
                        List.of("a", "e.1", "javascript:alert(1)", "click"), List.of("a", "nope", "data:text/html,x", "data link"),
                        Map.of("r", "button", "node", "e.9")));
        block("k", "iframe", "src", "https://evil.example/");
        block("k", "img", "s", "data:image/svg+xml;base64,PHN2Zz4=", "a", "svg");
        block("k", "img", "s", "javascript:alert(1)");
        block("k", "img", "s", "data:image/png;base64,iVBORw0KGgo=", "w", 1e12, "h", -5);
        MDoc doc = build().doc();

        String json = json(doc);
        assertThat(json).doesNotContain("style", "class", "dangerously", "script", "alert", "javascript", "evil.example", "‮", "svg");
        assertThat(doc.blocks).extracting(b -> b.get("t")).containsExactly("para", "image");
        assertThat(doc.blocks.get(1)).containsEntry("width", 20_000).containsEntry("height", 0);
        // A link with a URL that isn't http(s) keeps its node, and loses the URL.
        assertThat(doc.nodes).containsOnlyKeys("e.1");
        assertThat(runs(doc, 0)).anySatisfy(r -> assertThat(r).isInstanceOf(Map.class).asInstanceOf(
                org.assertj.core.api.InstanceOfAssertFactories.MAP).containsEntry("r", "link").doesNotContainKey("url"));
    }

    @Test
    void aControlBecomesANodeOnlyIfDeskdsHalfSawItAndOnlyOnce() {
        seen("e.1", "fp1");
        block("k", "p", "c", List.of(List.of("btn", "e.1", "One", 0), List.of("btn", "e.1", "Again", 0), List.of("btn", "e.2", "Unseen", 0),
                List.of("btn", "bad ref!", "Bad", 0)));
        MDoc doc = build().doc();
        assertThat(doc.nodes).containsOnlyKeys("e.1");
        assertThat(json(doc)).contains("Again", "Unseen", "Bad");
    }

    @Test
    void sensitiveFieldsAreNeverFieldsAndStaySo() {
        seen("e.1", "fp1");
        seen("e.2", "fp2");
        nodes.get("e.2").put("s", "one_time_code");
        seen("e.3", "fp3");
        seen("e.4", "fp4");
        context.sensitive.add("e.4");
        block("k", "p", "c", List.of(
                List.of("in", "e.1", Map.of("t", "password", "v", "", "n", 7, "l", "Password")),
                List.of("in", "e.2", Map.of("t", "text", "v", "123456", "l", "Code")),
                List.of("in", "e.3", Map.of("t", "text", "v", "ok", "l", "Name")),
                List.of("in", "e.4", Map.of("t", "text", "v", "secret", "l", "Was masked"))));
        signals.add(Map.of("kind", "card", "origin", "https://example.com"));
        MDoc doc = build().doc();

        assertThat(doc.sensitive).isTrue();
        assertThat(doc.nodes).containsOnlyKeys("e.3");
        assertThat(json(doc)).doesNotContain("123456", "secret");
        assertThat(context.sensitive).contains("e.1", "e.2", "e.4");
        // A signal not shown in its place goes first: "Sign in on (site)".
        assertThat(doc.blocks.get(0)).containsEntry("t", "sensitive").containsEntry("kind", "card").containsEntry("origin", "https://example.com");
    }

    @Test
    void aPaymentFrameIsSensitiveAndAVideoAnIslandWithItsFacts() {
        media.add(new HashMap<>(Map.of("island", "vabc.1", "fp", "f1", "m", "iframe", "w", 400, "h", 100, "x", 0, "y", 0, "pay", 1,
                "origin", "https://js.stripe.com")));
        media.add(map("island", "vabc.2", "fp", "f2", "m", "video", "w", 640, "h", 360, "x", 10, "y", 900,
                "paused", true, "dur", 61.5, "drm", 1, "poster", "https://example.com/p.jpg",
                "tracks", List.of(Map.of("kind", "captions", "label", "English", "lang", "en", "on", 0))));
        block("k", "media", "m", "iframe", "s", "https://js.stripe.com/x", "w", 400, "h", 100);
        block("k", "media", "m", "video", "s", "blob:", "w", 640, "h", 360, "n", "Trailer");
        MDoc doc = build().doc();

        assertThat(doc.blocks.get(0)).containsEntry("t", "sensitive").containsEntry("kind", "payment").containsEntry("origin", "https://js.stripe.com");
        Map<String, Object> island = doc.blocks.get(1);
        assertThat(island).containsEntry("t", "island").containsEntry("island", "vabc.2").containsEntry("kind", "video").containsEntry("fp", "f2");
        assertThat(Json.object(island, "media")).containsEntry("drm", true).containsEntry("duration", 61.5).containsEntry("frame", false);
        assertThat(doc.islands).containsOnlyKeys("vabc.2");
        assertThat(doc.islands.get("vabc.2").block()).isEqualTo(doc.keys.get(1));
        assertThat(json(doc)).doesNotContain("p.jpg", "blob:");
    }

    @Test
    void aDocumentPastTheCapIsCutWithItsNodes() {
        for (int i = 0; i < 400; i++) {
            seen("e." + i, "fp");
            block("k", "p", "c", List.of("x".repeat(2000), List.of("btn", "e." + i, "B" + i, 0)));
        }
        MDoc doc = build().doc();
        assertThat(doc.truncated).isTrue();
        assertThat(Json.bytes(doc.wire()).length).isLessThanOrEqualTo(MDoc.MAX_BYTES + 1024);
        assertThat(doc.nodes).hasSize(doc.blocks.size());
        doc.nodes.values().forEach(node -> assertThat(doc.keys).contains(node.block()));
    }

    @Test
    void theConfidenceCheckSaysWhyTheStreamIsBetter() {
        block("k", "p", "c", List.of("Short."));
        assertThat(build().fallback()).isEqualTo(Fallback.LOW_CONFIDENCE);
        stats.put("ready", "loading");
        assertThat(build().fallback()).isNull();
        stats.put("ready", "complete");
        block("k", "p", "c", List.of("x".repeat(500)));
        stats.put("textFields", 10);
        assertThat(build().fallback()).isEqualTo(Fallback.LOW_CONFIDENCE);
        meta.put("mode", "article");
        assertThat(build().fallback()).isNull();
        stats.put("canvasCover", 0.8);
        assertThat(build().fallback()).isEqualTo(Fallback.CANVAS_APP);
        stats.put("canvasCover", 0);
        stats.put("frameCover", 0.5);
        assertThat(build().fallback()).isEqualTo(Fallback.CROSS_ORIGIN_FRAMES);
        stats.put("status", 401);
        assertThat(build().fallback()).isEqualTo(Fallback.HTTP_AUTH);
    }

    @Test
    void distillerV2sBlocksAndTheSpecsHeadFields() {
        seen("e.1", "fp1");
        seen("e.2", "fp2");
        seen("e.3", "fp3");
        nodes.put("e.9", new HashMap<>(Map.of("fp", "fp9", "cb", 1)));
        meta.put("mode", "article");
        meta.put("dropped", Map.of("ad", 3, "consent", 1, "recirc", 2, "weird", 1));
        meta.put("consent", List.of(Map.of("ref", "e.8", "reject", Map.of("ref", "e.9", "label", "Reject all"))));
        meta.put("challenge", "cloudflare");
        meta.put("site", Map.of("name", "Example News", "acts", List.of(List.of("cart", "e.3", "Cart", 2), List.of("bogus", "e.1", "x"))));
        extras.put("icon", "https://example.com/favicon.png");
        extras.put("ld", List.of(Map.of("@type", "Recipe", "name", "Soup", "recipeIngredient", List.of("2 cups of water", "salt"),
                "recipeInstructions", List.of(Map.of("@type", "HowToStep", "text", "Boil."), "Salt it."),
                "aggregateRating", Map.of("ratingValue", 4.5, "ratingCount", 12)),
                Map.of("@type", "NewsArticle", "author", List.of(Map.of("name", "Ann Lee")), "datePublished", "2026-11-07", "articleSection", "Food")));
        block("k", "bar", "f", List.of(List.of("in", "e.2", Map.of("t", "search", "l", "Search"))), "g",
                List.of(Map.of("n", "Site menu", "c", List.of(List.of("a", "e.1", "https://example.com/a", "Home")))));
        block("k", "p", "c", List.of("A story about soup and the people who make it, told at some length here."));
        block("k", "h", "l", 2, "c", List.of("Ingredients"));
        block("k", "cards", "lay", "grid", "items", List.of(Map.of("t", "Red lamp", "u", "https://example.com/red", "p", "$20",
                "s", "4.5", "i", List.of("https://example.com/red.jpg", 200, 200), "m", List.of("Free delivery"), "style", "x")));
        block("k", "group", "n", "More from this site", "c", List.of(Map.of("k", "p", "c", List.of("Another story"))));
        MDoc doc = build().doc();

        Map<String, Object> wire = doc.wire();
        assertThat(Json.object(wire, "site")).containsEntry("name", "Example News").containsKey("icon");
        assertThat((List<?>) Json.object(wire, "site").get("actions")).hasSize(1);
        assertThat(doc.nodes.get("e.3").block()).isEqualTo("site");
        assertThat(Json.object(Json.object(wire, "hidden"), "counts"))
                .containsEntry("ads", 3).containsEntry("cookie", 1).containsEntry("recommended", 2).containsEntry("other", 1);
        assertThat(Json.object(Json.object(wire, "hidden"), "done")).containsEntry("cookie", "hidden");
        assertThat(Json.object(wire, "challenge")).containsEntry("reason", "person_check");
        assertThat(Json.object(wire, "article")).containsEntry("kicker", "Food").containsEntry("date", "2026-11-07")
                .containsEntry("byline", List.of("Ann Lee"));
        assertThat(doc.blocks).extracting(b -> b.get("t")).containsExactly("structured", "bar", "para", "heading", "cards", "group", "para");
        Map<String, Object> structured = doc.blocks.get(0);
        assertThat(structured).containsEntry("type", "recipe").containsEntry("fold", 3);
        assertThat(Json.object(structured, "data")).containsEntry("steps", List.of("Boil.", "Salt it.")).containsEntry("rating", "4.5");
        assertThat(doc.blocks.get(4)).containsEntry("repeat", 1).containsEntry("layout", "grid");
        assertThat(doc.blocks.get(5)).containsEntry("size", 1);
        assertThat(doc.blocks.get(6)).containsEntry("grouped", true);
        assertThat(doc.consent).isEqualTo(new MDoc.Consent("e.9", "fp9", "Reject all"));
        assertThat(json(doc)).doesNotContain("red.jpg", "favicon", "e.9");
    }

    /** Distiller v2 writes a card per line as {@code {k: card, g, lay, title, c, price, stars, meta}}: every one is kept. */
    @Test
    @SuppressWarnings("unchecked")
    void distillerV2sCardsAsItWritesThemAreKeptAsOneListEach() {
        seen("c.1", "fp1");
        seen("c.2", "fp2");
        seen("c.3", "fp3");
        String snippet = "2700K-6500K, 100 LEDs, 360 degree gooseneck, fits up to 30 inch monitors, flicker-free";
        // As v2's cardsBlock writes them (P03): thumbnail link, title link, price, stars, meta; a break; the snippet; a
        // break; a chip; a break; the actions.
        block("k", "card", "g", "x.1d", "lay", "grid", "title", "LED Desk Lamp with Clamp", "c", List.of(
                List.of("a", "c.1", "https://example.com/lamp1", List.of("img", "https://example.com/lamp1.jpg", "", 242, 242)),
                List.of("a", "c.1", "https://example.com/lamp1", "LED Desk Lamp with Clamp"),
                " $19.92", " \u2605 4.5", " \u00b7 List: $25.99 \u00b7 Tomorrow, Nov 8",
                List.of("br"), snippet, List.of("br"), " Best Seller ", List.of("br"), List.of("btn", "c.3", "Add to cart", 0)),
                "price", "$19.92", "stars", "4.5", "meta", "List: $25.99 \u00b7 Tomorrow, Nov 8", "rep", 2);
        block("k", "card", "g", "x.1d", "lay", "grid", "title", "Clip on Light", "c", List.of(
                List.of("a", "c.2", "https://example.com/lamp2", "Clip on Light"), " $16.98"), "price", "$16.98", "rep", 2);
        block("k", "card", "g", "x.2a", "lay", "list", "title", "Best desk lamps of the year, tested", "c", List.of(
                List.of("a", "c.4", "https://example.com/review", "Best desk lamps of the year, tested"),
                " \u00b7 Sep 10, 2026", List.of("br"), "We found more than a dozen lamps in various styles to brighten any desk."),
                "meta", "Sep 10, 2026", "rep", 1);
        MDoc doc = build().doc();

        assertThat(doc.blocks).extracting(b -> b.get("t")).containsExactly("cards", "cards");
        Map<String, Object> grid = doc.blocks.get(0);
        assertThat(grid).containsEntry("layout", "grid").containsEntry("repeat", 2);
        List<Map<String, Object>> items = (List<Map<String, Object>>) grid.get("items");
        Map<String, Object> first = items.get(0);
        assertThat(Json.object(first, "title")).containsEntry("text", "LED Desk Lamp with Clamp")
                .containsEntry("url", "https://example.com/lamp1").containsEntry("node", "c.1");
        assertThat(Json.object(first, "image")).containsEntry("width", 242).containsEntry("height", 242);
        assertThat(first).containsEntry("price", "$19.92").containsEntry("rating", "4.5").containsEntry("snippet", snippet)
                .containsEntry("meta", List.of("List: $25.99", "Tomorrow, Nov 8")).containsEntry("chips", List.of("Best Seller"));
        assertThat((List<Map<String, Object>>) first.get("actions")).extracting(a -> a.get("label")).containsExactly("Add to cart");
        assertThat(Json.object(items.get(1), "title")).containsEntry("text", "Clip on Light").containsEntry("node", "c.2");
        assertThat(items.get(1)).containsEntry("price", "$16.98").doesNotContainKey("image");
        Map<String, Object> list = doc.blocks.get(1);
        assertThat(list).containsEntry("layout", "list").containsEntry("repeat", 1);
        assertThat(((List<Map<String, Object>>) list.get("items")).get(0))
                .containsEntry("snippet", "We found more than a dozen lamps in various styles to brighten any desk.");
        assertThat(doc.nodes).containsKeys("c.1", "c.2", "c.3");
        assertThat(json(doc)).doesNotContain("lamp1.jpg");
    }

    private static final String PROSE = "A long enough paragraph of the page's own text, which the view keeps as it is, here.";

    /** The real-page run's retune: the fallbacks that were wrong (P03, P16, P14) and the ones that were missed. */
    @Test
    void theFallbacksAsTheRealPageRunTunedThem() {
        seen("e.1", "fp1");
        seen("e.2", "fp2");
        seen("e.3", "fp3");
        // A listing whose filter rail the distiller folded: hundreds of boxes and buttons, two fields, both kept.
        stats.put("formControls", 296);
        stats.put("textFields", 2);
        block("k", "h", "l", 1, "c", List.of("Results for desk lamp"));
        block("k", "p", "c", List.of(PROSE.repeat(4), List.of("in", "e.1", Map.of("t", "search", "l", "Search")), List.of("in", "e.2", Map.of("t", "text", "l", "Min price"))));
        assertThat(build().fallback()).isNull();
        // A form whose fields the view lost still goes to the stream.
        stats.put("textFields", 8);
        assertThat(build().fallback()).isEqualTo(Fallback.LOW_CONFIDENCE);

        // An app: little to read and somewhere to type that isn't a search (TodoMVC).
        raw.clear();
        stats.put("textFields", 1);
        stats.put("formControls", 1);
        block("k", "h", "l", 1, "c", List.of("todos"));
        block("k", "p", "c", List.of(List.of("in", "e.3", Map.of("t", "text", "p", "What needs to be done?"))));
        block("k", "p", "c", List.of("Double-click to edit a todo"));
        assertThat(build().fallback()).isEqualTo(Fallback.APP);
        // Not a page with a select (the-internet's dropdown), nor a search page.
        raw.clear();
        block("k", "h", "l", 3, "c", List.of("Dropdown List"));
        block("k", "p", "c", List.of("Powered by ", List.of("a", "e.2", "https://example.com/es", "Elemental Selenium")));
        block("k", "p", "c", List.of(List.of("sel", "e.3", Map.of("v", "1", "o", List.of(List.of("1", "Option 1"), List.of("2", "Option 2")), "l", "Dropdown"))));
        assertThat(build().fallback()).isNull();
        raw.clear();
        block("k", "p", "c", List.of(List.of("in", "e.1", Map.of("t", "search", "l", "Search the web"))));
        block("k", "p", "c", List.of("Privacy, simplified. ", List.of("a", "e.2", "https://example.com/about", "About")));
        assertThat(build().fallback()).isNull();

        // A bot check, a 403 and a 429: only the member gets through, or it's an error page as it is.
        raw.clear();
        block("k", "p", "c", List.of(PROSE));
        meta.put("challenge", "person-check");
        stats.put("status", 403);
        MDocBuilder.Built check = build();
        assertThat(check.fallback()).isEqualTo(Fallback.CHALLENGE);
        assertThat(check.cause()).isEqualTo(Fallback.PERSON_CHECK);
        meta.remove("challenge");
        assertThat(build().fallback()).isEqualTo(Fallback.HTTP_ERROR);
        stats.put("status", 200);
        meta.put("challenge", "signin");
        assertThat(build().cause()).isEqualTo(Fallback.SIGN_IN);
        meta.put("challenge", "payment");
        assertThat(build().cause()).isEqualTo(Fallback.PAYMENT);

        // T47X-3: a scan the page made throw is a distiller error, whatever else it says.
        meta.put("scan_err", "TypeError");
        assertThat(build().fallback()).isEqualTo(Fallback.DISTILLER_ERROR);
        meta.remove("scan_err");

        // The distiller's own words (v4): a terms wall, a small app, and its paywall's closing block.
        meta.put("challenge", "terms");
        assertThat(build().fallback()).isEqualTo(Fallback.TERMS_WALL);
        meta.remove("challenge");
        meta.put("app", 1);
        assertThat(build().fallback()).isEqualTo(Fallback.APP);
        meta.remove("app");
        block("k", "wall", "kind", "paywall", "t", "The rest is for subscribers");
        block("k", "p", "c", List.of("Nothing after the wall reaches the view, whatever the distiller sends."));
        MDoc walled = build().doc();
        assertThat(walled.blocks).extracting(b -> b.get("t")).containsExactly("para", "paywall");
    }

    /**
     * A person check the distiller let through (Stack Overflow's on a desk's network, simplified into one block):
     * deskd's own look finds it by Cloudflare's script, by the title, a heading, a check's form or widget or address on a
     * page that holds little, or by a view whose only words are the prompt. A real page about checks still simplifies.
     */
    @Test
    void aPersonCheckTheDistillerMissesStillFallsBack() {
        String so = "https://stackoverflow.com/questions/1/lamps";
        block("k", "p", "c", List.of("Stack Overflow needs to look at your connection before you go on."));
        assertThat(build(so, "Stack Overflow").fallback()).as("no word of a check: not one").isNotEqualTo(Fallback.CHALLENGE);

        MDocBuilder.Built titled = build(so, "Human verification - Stack Overflow");
        assertThat(titled.fallback()).isEqualTo(Fallback.CHALLENGE);
        assertThat(titled.cause()).isEqualTo(Fallback.PERSON_CHECK);
        assertThat(build("https://stackoverflow.com/nocaptcha?s=7f3", "Stack Overflow").cause()).isEqualTo(Fallback.PERSON_CHECK);

        stats.put("challenge", Map.of("heads", List.of("stackoverflow.com", "Performing security verification")));
        assertThat(build(so, "stackoverflow.com").cause()).isEqualTo(Fallback.PERSON_CHECK);
        stats.put("challenge", Map.of("cf", 1));
        assertThat(build(so, "stackoverflow.com").cause()).isEqualTo(Fallback.PERSON_CHECK);
        stats.put("challenge", Map.of("form", 1));
        assertThat(build(so, "stackoverflow.com").cause()).isEqualTo(Fallback.PERSON_CHECK);
        stats.put("challenge", Map.of("widget", 1));
        assertThat(build(so, "stackoverflow.com").cause()).isEqualTo(Fallback.PERSON_CHECK);
        stats.remove("challenge");

        // A view whose only words are the prompt, whatever the page's title and markup.
        for (String prompt : List.of("Verifying you are human. This may take a few seconds.",
                "stackoverflow.com needs to review the security of your connection before proceeding.",
                "Please complete the security check to access the site.", "We've seen unusual activity from your network.",
                "Are you a robot? Tick the box below.", "Prove you\u2019re human to carry on.")) {
            raw.clear();
            block("k", "p", "c", List.of(prompt));
            MDocBuilder.Built only = build(so, "Stack Overflow");
            assertThat(only.fallback()).as(prompt).isEqualTo(Fallback.CHALLENGE);
            assertThat(only.cause()).as(prompt).isEqualTo(Fallback.PERSON_CHECK);
        }

        // The distiller's own word wins: a sign-in page with a check on it is a sign-in.
        meta.put("challenge", "signin");
        stats.put("challenge", Map.of("widget", 1));
        assertThat(build(so, "Human verification").cause()).isEqualTo(Fallback.SIGN_IN);
        meta.remove("challenge");

        // A page with something to read is no check, whatever its title, headings and widgets say.
        raw.clear();
        block("k", "h", "l", 1, "c", List.of("Human verification, and why CAPTCHA checks are getting harder"));
        for (int i = 0; i < 40; i++) {
            block("k", "p", "c", List.of(PROSE + " " + i));
        }
        stats.put("challenge", Map.of("form", 1, "widget", 1, "heads", List.of("Human verification"), "cf", 1));
        assertThat(build("https://example.com/captcha", "Are you a robot? How CAPTCHA works").fallback()).isNull();
        stats.remove("challenge");

        // A short sign-up page that mentions reCAPTCHA's terms isn't a check either.
        raw.clear();
        block("k", "h", "l", 1, "c", List.of("Join the lamp club"));
        block("k", "p", "c", List.of("This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply."));
        block("k", "p", "c", List.of(List.of("in", "e.1", Map.of("t", "email", "l", "Email")), List.of("btn", "e.2", "Join")));
        assertThat(build().cause()).isNull();
    }

    /** The round-two policy: whatever the distiller sends, nothing the member can't see on the real page gets through. */
    @Test
    void whatTheMemberCantSeeOnTheRealPageNeverGetsThrough() {
        String hidden = "A hidden paragraph that the member never sees on the page itself.";
        String covered = "The paragraph under the subscription wall, for subscribers only.";
        stats.put("wall", Map.of("kind", "paywall", "covered", List.of(MDocBuilder.textKey(covered)),
                "hidden", List.of(MDocBuilder.textKey(hidden), "short")));
        block("k", "h", "l", 1, "c", List.of("Lamps behind a wall"));
        block("k", "p", "c", List.of("The part the member reads, before the wall comes, long enough here."));
        block("k", "p", "c", List.of(hidden));
        block("k", "group", "n", "More", "c", List.of(Map.of("k", "p", "c", List.of(hidden))));
        block("k", "p", "c", List.of(List.of("b", "The paragraph"), " under the subscription wall, for subscribers only."));
        block("k", "p", "c", List.of("And everything after it, which the distiller sent anyway."));
        MDoc doc = build().doc();
        assertThat(doc.blocks).extracting(b -> b.get("t")).containsExactly("heading", "para", "paywall");
        assertThat(json(doc)).doesNotContain("hidden paragraph", "subscribers only", "everything after");

        // The distiller's own mark ends it too, and a terms wall sends the page to the stream.
        raw.clear();
        stats.put("wall", Map.of("kind", "terms", "covered", List.of(), "hidden", List.of()));
        block("k", "p", "c", List.of("Before the mark, a paragraph long enough to be read as content."));
        block("k", "paywall");
        block("k", "p", "c", List.of("After the mark."));
        MDocBuilder.Built built = build();
        assertThat(built.doc().blocks).extracting(b -> b.get("t")).containsExactly("para");
        assertThat(built.fallback()).isEqualTo(Fallback.TERMS_WALL);
    }

    /** UI/UX's proposals, adopted: a fold (R17, R32), a filter rail (R10) and a vote control (R26). */
    @Test
    @SuppressWarnings("unchecked")
    void foldsFilterRailsAndVotesAsTheRendererAskedForThem() {
        seen("v.up", "fpu");
        seen("v.down", "fpd");
        seen("f.1", "fpf1");
        seen("f.2", "fpf2");
        seen("s.1", "fps");
        block("k", "filters", "all", 14, "c", List.of(List.of("btn", "f.1", "Under $25", 0), " ", List.of("btn", "f.2", "4 stars & up", 0)),
                "sort", List.of("sel", "s.1", Map.of("v", "a", "o", List.of(List.of("a", "Featured"), List.of("b", "Newest")), "l", "Sort by")),
                "g", List.of(Map.of("n", "Price", "c", List.of(List.of("btn", "f.9", "$25 to $50", 0)))));
        block("k", "p", "c", List.of("A question about lamps, and a long enough body to read as the page's content here.",
                List.of("vote", "v.up", "42", "v.down", "up")));
        block("k", "fold", "n", "Comments", "m", "119 comments", "kind", "comments", "lead", 1, "c", List.of(
                Map.of("k", "p", "c", List.of("First comment")), Map.of("k", "p", "c", List.of("Second comment"))));
        block("k", "fold", "n", "", "kind", "comments", "m", "3 comments", "c", List.of());
        block("k", "fold", "n", "Description", "kind", "description", "c", List.of());
        MDoc doc = build().doc();

        assertThat(doc.blocks).extracting(b -> b.get("t")).containsExactly("filters", "para", "fold", "para", "para", "fold");
        Map<String, Object> filters = doc.blocks.get(0);
        assertThat(filters).containsEntry("count", 14);
        assertThat((List<Map<String, Object>>) filters.get("runs")).extracting(r -> r.get("label")).containsExactly("Under $25", "4 stars & up");
        assertThat(Json.object(filters, "sort")).containsEntry("r", "select").containsEntry("node", "s.1");
        assertThat((List<Map<String, Object>>) filters.get("menus")).singleElement().satisfies(m ->
                assertThat(m).containsEntry("label", "Price").containsEntry("kind", "filters"));
        Map<String, Object> vote = m(runs(doc, 1).get(1));
        assertThat(vote).containsEntry("r", "vote").containsEntry("score", "42").containsEntry("state", "up");
        assertThat(Json.object(vote, "up")).containsEntry("node", "v.up").containsEntry("fp", "fpu");
        assertThat(Json.object(vote, "down")).containsEntry("node", "v.down");
        assertThat(doc.nodes).containsKeys("v.up", "v.down", "f.1", "f.2", "s.1");
        assertThat(doc.blocks.get(2)).containsEntry("label", "Comments").containsEntry("kind", "comments").containsEntry("lead", 1)
                .containsEntry("size", 2).containsEntry("meta", "119 comments");
        assertThat(doc.blocks.get(3)).containsEntry("grouped", true);
        // A comments fold may hold none and name itself; any other needs something in it.
        assertThat(doc.blocks.get(5)).containsEntry("label", "Comments").containsEntry("size", 0).containsEntry("meta", "3 comments");
    }

    @Test
    void onlyAnExactlyLabeledRejectIsOneDeskdMayPress() {
        nodes.put("e.9", new HashMap<>(Map.of("fp", "fp9", "cb", 1)));
        meta.put("consent", List.of(Map.of("reject", Map.of("ref", "e.9", "label", "Manage options"))));
        block("k", "p", "c", List.of("x".repeat(200)));
        assertThat(build().doc().consent).isNull();
        meta.put("consent", List.of(Map.of("reject", Map.of("ref", "e.9", "label", "Only necessary cookies"))));
        assertThat(build().doc().consent).isNotNull();
        // T47X-1: whatever the distiller calls a banner, deskd's half has to have found one there (cb), or it's no press.
        nodes.put("e.9", new HashMap<>(Map.of("fp", "fp9", "cb", 0)));
        assertThat(build().doc().consent).isNull();
        nodes.put("e.9", new HashMap<>(Map.of("fp", "fp9")));
        meta.put("consent", List.of(Map.of("reject", Map.of("ref", "e.9", "label", "Deny"))));
        assertThat(build().doc().consent).isNull();
    }

    @Test
    void aPatchIsOneSpliceAndTooBigOnesArentPatches() {
        block("k", "p", "c", List.of("one"));
        block("k", "p", "c", List.of("two"));
        block("k", "p", "c", List.of("three"));
        MDoc before = build().doc().withRev(1);
        raw.set(1, Map.of("k", "p", "c", List.of("TWO")));
        raw.add(Map.of("k", "p", "c", List.of("four")));
        MDoc after = build().doc().withRev(2);
        Map<String, Object> patch = after.patchFrom(before);
        assertThat(patch).containsEntry("base", 1L).containsEntry("rev", 2L).containsEntry("at", 1).containsEntry("remove", 2);
        assertThat((List<?>) patch.get("insert")).hasSize(3);

        for (int i = 0; i < 100; i++) {
            raw.add(Map.of("k", "p", "c", List.of("y".repeat(1000) + i)));
        }
        assertThat(build().doc().withRev(3).patchFrom(after)).isNull();
    }

    // ---- the review's findings, and section 11's fields

    /** Review 5: a field's kind is deskd's own word, never an HTML input type a renderer could put in type=. */
    @Test
    void fieldKindsAreNeverHtmlInputTypes() {
        for (String type : List.of("email", "tel", "url", "search", "text", "number", "date", "file")) {
            seen("e." + type, "fp");
        }
        block("k", "p", "c", List.of(List.of("in", "e.email", Map.of("t", "email", "v", "a@b.c", "l", "Email")),
                List.of("in", "e.tel", Map.of("t", "tel", "l", "Phone")), List.of("in", "e.url", Map.of("t", "url", "l", "Site")),
                List.of("in", "e.search", Map.of("t", "search", "l", "Search")), List.of("in", "e.text", Map.of("t", "weird", "l", "Other")),
                List.of("in", "e.number", Map.of("t", "number", "l", "N")), List.of("in", "e.date", Map.of("t", "date", "l", "D")),
                List.of("in", "e.file", Map.of("t", "file", "l", "F"))));
        MDoc doc = build().doc();
        assertThat(runs(doc, 0)).extracting(r -> (Object) m(r).get("kind")).containsExactly(
                "email_address", "phone_number", "web_address", "query", "plain", "numeric", "date_choice", "file_choice");
    }

    /** Review 4: a field deskd's half didn't judge shows no value; one it judged past the node cap is judged all the same. */
    @Test
    void aFieldNotJudgedShowsNoValueAndOnePastTheCapIsStillJudged() {
        sens.put("e.2", "card");
        sens.put("e.3", "");
        block("k", "p", "c", List.of(List.of("in", "e.1", Map.of("t", "text", "v", "unjudged secret", "l", "A")),
                List.of("in", "e.2", Map.of("t", "text", "v", "4111111111111111", "l", "B")),
                List.of("in", "e.3", Map.of("t", "text", "v", "fine", "l", "C"))));
        MDoc doc = build().doc();
        assertThat(json(doc)).doesNotContain("unjudged secret", "4111").contains("fine");
        assertThat(runs(doc, 0)).anySatisfy(r -> assertThat(m(r)).containsEntry("r", "sensitive").containsEntry("kind", "card"));
        assertThat(doc.nodes).isEmpty();
    }

    /** Review 4: a select can be a card's, as an expiry or a type is. */
    @Test
    void aCardsSelectIsSensitive() {
        seen("e.1", "fp1");
        nodes.get("e.1").put("s", "card");
        block("k", "p", "c", List.of(List.of("sel", "e.1", Map.of("v", "07", "o", List.of(List.of("07", "07")), "l", "Expiry month"))));
        MDoc doc = build().doc();
        assertThat(runs(doc, 0)).containsExactly(Map.of("r", "sensitive", "kind", "card", "origin", "https://example.com"));
        assertThat(doc.nodes).isEmpty();
    }

    /** Review 6: a URL's userinfo never reaches a screen: https://bank.example@evil.example/ is evil.example. */
    @Test
    void aLinksUserinfoIsDropped() {
        assertThat(MDocBuilder.httpUrl("https://bank.example@evil.example/login")).isEqualTo("https://evil.example/login");
        assertThat(MDocBuilder.httpUrl("https://user:pw@evil.example:8443/x?y")).isEqualTo("https://evil.example:8443/x?y");
        assertThat(MDocBuilder.httpUrl("https://example.com/a@b")).isEqualTo("https://example.com/a@b");
    }

    /** Review 7: the site a host is part of, close to its registrable domain. */
    @Test
    void sitesAreRegistrableDomains() {
        assertThat(SiteMemory.registrable("login.example.co.uk")).isEqualTo("example.co.uk");
        assertThat(SiteMemory.registrable("a.b.example.com")).isEqualTo("example.com");
        assertThat(SiteMemory.registrable("example.com")).isEqualTo("example.com");
        assertThat(SiteMemory.registrable("10.0.0.1")).isEqualTo("10.0.0.1");
    }

    /** Section 11, R1: a control shows its visible text, and keeps its label as its name. */
    @Test
    void aControlShowsWhatItShows() {
        seen("e.1", "fp1");
        nodes.get("e.1").put("t", "Get It Today");
        seen("e.2", "fp2");
        nodes.get("e.2").put("t", "Next");
        block("k", "p", "c", List.of(List.of("btn", "e.1", "Apply Get It Today filter to narrow results", 0),
                List.of("a", "e.2", "https://example.com/2", "Go to the next page of results")));
        MDoc doc = build().doc();
        assertThat(m(runs(doc, 0).get(0))).containsEntry("label", "Get It Today")
                .containsEntry("name", "Apply Get It Today filter to narrow results");
        assertThat(m(runs(doc, 0).get(1))).containsEntry("runs", List.of("Next")).containsEntry("name", "Go to the next page of results");
    }

    /** Section 11, R23: a search engine's redirect shows as where it goes, read from the link, never fetched. */
    @Test
    void redirectsShowWhereTheyGo() {
        String target = "https://example.org/page?a=1";
        String bing = "https://www.bing.com/ck/a?!&&p=abc&u=a1" + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(target.getBytes(StandardCharsets.UTF_8)) + "&ntb=1";
        assertThat(MDocBuilder.destination(bing)).isEqualTo(target);
        assertThat(MDocBuilder.destination("https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fpage%3Fa%3D1&sa=U")).isEqualTo(target);
        assertThat(MDocBuilder.destination("https://www.google.com/url?q=javascript%3Aalert(1)")).isNull();
        assertThat(MDocBuilder.destination("https://example.com/url?q=https://x.example/")).isNull();
        seen("e.1", "fp1");
        block("k", "p", "c", List.of(List.of("a", "e.1", bing, "Result")));
        Map<String, Object> link = m(runs(build().doc(), 0).get(0));
        assertThat(link).containsEntry("url", target).containsEntry("redirect", true);
    }

    /** Section 11, R26 to R30: comments keep their place, author, score and votes; the accepted answer is marked. */
    @Test
    void commentsAndAnswersKeepTheirShape() {
        seen("e.1", "fp1");
        seen("e.2", "fp2");
        block("k", "cm", "kind", "answer", "d", 1, "au", "Ann", "role", "OP", "sc", 60, "acc", 1,
                "up", List.of("btn", "e.1", "Upvote", 0), "dn", List.of("btn", "e.2", "Downvote", 0), "c", List.of("Use a lamp."));
        block("k", "cm", "d", 4, "more", 12, "col", 1);
        block("k", "answer", "n", "Copilot", "c", List.of("Lamps are good."), "src", List.of(List.of("a", "x", "https://example.org/", "Source")));
        MDoc doc = build().doc();
        assertThat(doc.blocks.get(0)).containsEntry("t", "comment").containsEntry("kind", "answer").containsEntry("depth", 1)
                .containsEntry("score", "60").containsEntry("accepted", true);
        assertThat(Json.object(doc.blocks.get(0), "author")).containsEntry("name", "Ann").containsEntry("role", "OP");
        assertThat(Json.object(doc.blocks.get(0), "up")).containsEntry("node", "e.1");
        assertThat(doc.blocks.get(1)).containsEntry("more", 12).containsEntry("collapsed", true);
        assertThat(doc.blocks.get(2)).containsEntry("t", "answer").containsEntry("label", "Copilot");
        assertThat(doc.nodes).containsOnlyKeys("e.1", "e.2");
    }

    /** A kicker set apart from its headline in one link reads apart: the distiller's spacing over deskd's half's run-together text. */
    @Test
    void aLinksTextKeepsTheLayoutsGapsWhenOnlyTheSpacingDiffers() {
        seen("k.1", "fpk1");
        nodes.get("k.1").put("t", "Politics sketchThe lamp makers win");
        seen("k.2", "fpk2");
        nodes.get("k.2").put("t", "Read more");
        block("k", "p", "c", List.of(List.of("a", "k.1", "https://example.com/story", "Politics sketch The lamp makers win"), " ",
                List.of("a", "k.2", "https://example.com/more", "Read more about the lamp makers")));
        List<Object> runs = runs(build().doc(), 0);
        assertThat(m(runs.get(0))).containsEntry("runs", List.of("Politics sketch The lamp makers win")).doesNotContainKey("name");
        assertThat(m(runs.get(2))).containsEntry("runs", List.of("Read more")).containsEntry("name", "Read more about the lamp makers");
    }

    /** An issue list's own filters on an item (GitHub's "Filter by author ann") are its author, never its actions (P34). */
    @Test
    void aListingsFilterOnAnItemIsItsMetaNotItsAction() {
        seen("t.1", "fpt1");
        seen("b.1", "fpb1");
        seen("b.2", "fpb2");
        seen("b.3", "fpb3");
        seen("b.4", "fpb4");
        nodes.get("b.4").put("t", "Filter by author bob");
        block("k", "card", "g", "i", "title", "Lamp flickers", "c", List.of(List.of("a", "t.1", "https://example.org/issues/1", "Lamp flickers"),
                List.of("br"), "bug", List.of("btn", "b.1", "bug", Map.of()), List.of("btn", "b.2", "Filter by author ann", Map.of()),
                List.of("btn", "b.4", "bob", Map.of()), List.of("btn", "b.3", "Subscribe", Map.of())), "meta", "#1 · opened today");
        Map<String, Object> card = m(((List<?>) build().doc().blocks.get(0).get("items")).get(0));
        assertThat(card.get("meta")).isEqualTo(List.of("#1", "opened today", "ann", "bob"));
        assertThat(card.get("chips")).isEqualTo(List.of("bug"));
        assertThat((List<?>) card.get("actions")).extracting(a -> m(a).get("label")).containsExactly("Subscribe");
    }

    /** A paused video deskd found plays in the view (TED, Commons): only a poster with nothing behind it, or a frame, waits for a click. */
    @Test
    void aPausedVideoDeskdFoundIsLiveAndAPosterOrAFrameIsAClick() {
        media.add(map("island", "vabc.1", "fp", "f1", "m", "video", "w", 640, "h", 360, "x", 10, "y", 100, "paused", true));
        media.add(map("island", "vabc.2", "fp", "f2", "m", "video", "w", 640, "h", 360, "x", 10, "y", 600, "paused", true, "drm", 1));
        media.add(map("island", "vabc.3", "fp", "f3", "m", "iframe", "w", 640, "h", 360, "x", 10, "y", 1100, "video", 1));
        block("k", "media", "m", "video", "w", 640, "h", 360, "island", "click", "main", 1);
        block("k", "media", "m", "video", "w", 640, "h", 360, "island", "click");
        block("k", "media", "m", "iframe", "w", 640, "h", 360, "island", "click");
        block("k", "island", "x", 0, "y", 2000, "w", 640, "h", 360, "island", "click", "why", "click-to-play");
        MDoc doc = build().doc();
        assertThat(doc.blocks).extracting(b -> b.get("state")).containsExactly("live", "click", "click", "click");
        assertThat(doc.blocks.get(0)).containsEntry("island", "vabc.1");
        assertThat(doc.blocks.get(3)).doesNotContainKey("island");
    }

    /** An article has its head and read time; a thread (votes on its posts, or a QAPage) and a listing of results don't. */
    @Test
    void aReadTimeIsAnArticlesNeverAThreadsOrAListings() {
        meta.put("mode", "article");
        String words = "word ".repeat(400);
        block("k", "h", "l", 1, "c", List.of("A question"));
        block("k", "p", "c", List.of(words));
        assertThat(Json.object(build().doc().facts, "article")).containsKey("readMinutes");

        for (int i = 1; i <= 2; i++) {
            seen("u." + i, "fpu" + i);
            seen("d." + i, "fpd" + i);
            block("k", "p", "c", List.of(List.of("btn", "u." + i, "\u25b2", Map.of()), " 12 ", List.of("btn", "d." + i, "\u25bc", Map.of())));
            block("k", "p", "c", List.of("An answer " + i + ". " + words));
        }
        assertThat(build().doc().facts).doesNotContainKey("article");

        raw.clear();
        block("k", "h", "l", 1, "c", List.of("A question"));
        block("k", "p", "c", List.of(words));
        extras.put("ld", List.of(Map.of("@type", "QAPage")));
        assertThat(build().doc().facts).doesNotContainKey("article");

        extras.clear();
        raw.clear();
        block("k", "h", "l", 1, "c", List.of("lamps - Search"));
        for (int i = 1; i <= 6; i++) {
            seen("r." + i, "fpr" + i);
            block("k", "card", "g", "r", "title", "Result " + i, "c", List.of(List.of("a", "r." + i, "https://example.org/" + i, "Result " + i)));
        }
        assertThat(build().doc().facts).doesNotContainKey("article");
    }

    /** Round 4: a card whose own link is an ad's click is an ad wherever it sits, and counts as sponsored. */
    @Test
    void aCardWhoseOwnLinkIsAnAdsClickIsSponsored() {
        block("k", "h", "l", 1, "c", List.of("desk lamp reviews"));
        String[] urls = {"https://shop.example.com/lamp?tag=x&hvadid=8012", "https://r.example.com/RU=https%3a%2f%2fshop.example.com%2f%3fmsclkid%3d1",
            "https://example.org/review-1", "https://example.org/review-2", "https://example.org/review-3"};
        for (int i = 0; i < urls.length; i++) {
            seen("c." + i, "fpc" + i);
            block("k", "card", "g", "r", "title", "Lamp " + i, "c", List.of(List.of("a", "c." + i, urls[i], "Lamp " + i)));
        }
        MDoc doc = build().doc();
        Map<String, Object> cards = doc.blocks.stream().filter(b -> "cards".equals(b.get("t"))).findFirst().orElseThrow();
        assertThat((List<?>) cards.get("items")).hasSize(3);
        assertThat(json(doc)).doesNotContain("hvadid", "msclkid", "Lamp 0", "Lamp 1");
        assertThat(Json.object(Json.object(doc.wire(), "hidden"), "counts")).containsEntry("sponsored", 2);
        assertThat(MDocBuilder.AD_CLICK.matcher("https://example.org/?q=gclidx").find()).isFalse();
    }

    /** Round 4: a long page of which the view kept almost nothing (a store's grid still drawing placeholders) falls back. */
    @Test
    void aLongPageWhoseViewKeptAlmostNothingFallsBack() {
        meta.put("doc_h", 8000);
        block("k", "h", "l", 1, "c", List.of("desk lamp in Home, Furniture & Office (1452)"));
        block("k", "p", "c", List.of("Deals for every list. Start early, save early."));
        block("k", "meta", "c", List.of("18 of 1452 products"));
        assertThat(build().fallback()).isEqualTo(Fallback.LOW_CONFIDENCE);
        meta.put("doc_h", 1200);
        assertThat(build().fallback()).isNull();
        meta.put("doc_h", 8000);
        block("k", "img", "s", "https://cdn.example.com/lamp.png", "a", "A lamp", "w", 300, "h", 200);
        assertThat(build().fallback()).isNull();
    }

    /** Round 5 (R40): a lone vote arrow the distiller kept as a button (Hacker News' ▲, no score) is the vote control. */
    @Test
    void aLoneVoteArrowIsTheVoteControl() {
        seen("a.1", "fpa1");
        seen("v.1", "fpv1");
        block("k", "p", "depth", 1, "c", List.of(List.of("a", "a.1", "https://example.com/user?id=ann", "ann"), " \u00b7 ",
                List.of("btn", "v.1", "\u25b2", Map.of("aria", "Upvote", "v", 1))));
        List<Object> runs = runs(build().doc(), 0);
        Map<String, Object> vote = runs.stream().filter(r -> r instanceof Map<?, ?>).map(MDocBuilderTest::m).filter(r -> "vote".equals(r.get("r")))
                .findFirst().orElseThrow();
        assertThat(vote).containsEntry("score", "").containsKey("up").doesNotContainKey("down");
        assertThat(runs).noneMatch(r -> r instanceof Map<?, ?> && "button".equals(m(r).get("r")));
        // a Q&A's ▲ 27 ▼, both arrows and a score, stays as written, for the view to draw as one control
        raw.clear();
        seen("u.2", "fpu2");
        seen("d.2", "fpd2");
        block("k", "p", "vote", 1, "c", List.of(List.of("btn", "u.2", "\u25b2", Map.of("v", 1)), " 27 ", List.of("btn", "d.2", "\u25bc", Map.of("v", 1))));
        assertThat(runs(build().doc(), 0)).filteredOn(r -> r instanceof Map<?, ?>).extracting(r -> m(r).get("r")).containsExactly("button", "button");
    }

    /** Round 5: a tile's own picture outside any link is its picture, and a line too long for a chip is its meta (a forecast's day). */
    @Test
    void aTilesPictureAndItsLineStay() {
        block("k", "h", "l", 1, "c", List.of("Forecast"));
        block("k", "card", "g", "t", "lay", "list", "title", "Thursday", "tile", 1, "c", List.of(List.of("img", "https://example.com/ra50.png", "", 86, 86),
                List.of("b", "Thursday"), List.of("br"), "High: 66 \u00b0F \u00b7 Chance Rain"));
        block("k", "card", "g", "t", "lay", "list", "title", "Friday", "tile", 1, "meta", "High: 52 \u00b0F \u00b7 Sunny", "c",
                List.of(List.of("img", "https://example.com/sct.png", "", 86, 86), List.of("b", "Friday"), List.of("br"), "High: 52 \u00b0F \u00b7 Sunny"));
        List<?> items = (List<?>) build().doc().blocks.stream().filter(b -> "cards".equals(b.get("t"))).findFirst().orElseThrow().get("items");
        assertThat(m(items.get(0))).containsKey("image").containsEntry("meta", List.of("High: 66 \u00b0F \u00b7 Chance Rain")).doesNotContainKey("chips");
        assertThat(m(items.get(1))).containsKey("image").containsEntry("meta", List.of("High: 52 \u00b0F", "Sunny")).doesNotContainKey("chips");
    }

    /**
     * Round 6: a result's snippet whose query words the page set in bold is one snippet, as the distiller read it whole
     * ({@code snip}), never its plain pieces: a snippet starting mid-sentence and the bold words' neighbours as chips.
     */
    @Test
    void aSnippetWithBoldWordsIsOneSnippet() {
        block("k", "h", "l", 1, "c", List.of("desk lamp reviews"));
        for (int i = 1; i <= 3; i++) {
            block("k", "card", "g", "r", "lay", "list", "title", "The best desk lamps, review " + i, "meta", "Lamp Review",
                    "snip", "The best desk lamps come in various styles to brighten up any workspace, review " + i,
                    "c", List.of(List.of("a", "c." + i, "https://example.com/r" + i, "The best desk lamps, review " + i), " · Lamp Review", List.of("br"),
                            "The best ", List.of("b", "desk lamps"), " come in various styles to brighten up any workspace, review " + i,
                            List.of("br"), " Editor's pick "));
        }
        List<?> items = (List<?>) build().doc().blocks.stream().filter(b -> "cards".equals(b.get("t"))).findFirst().orElseThrow().get("items");
        assertThat(m(items.get(0))).containsEntry("snippet", "The best desk lamps come in various styles to brighten up any workspace, review 1")
                .containsEntry("chips", List.of("Editor's pick")).containsEntry("meta", List.of("Lamp Review"));
    }

    /** Round 5: a link whose page text only repeats its name with a screen reader's copy ("Open 20 (20)") shows its name once. */
    @Test
    void aLinksScreenReaderCopyIsNotShownTwice() {
        seen("l.1", "fpl1");
        nodes.get("l.1").put("t", "Open 20 (20)");
        block("k", "p", "c", List.of(List.of("a", "l.1", "https://example.com/issues?state=open", "Open 20")));
        assertThat(m(runs(build().doc(), 0).get(0))).containsEntry("runs", List.of("Open 20")).doesNotContainKey("name");
        assertThat(MDocBuilder.onlyRepeats("Close dialog", "\u00d7")).isFalse();
        assertThat(MDocBuilder.onlyRepeats("Open 20", "Open 20 (20)")).isTrue();
    }

    /**
     * Round 5: a product page has no read time; a swatch's drawn badge stays on its name ("Jet Black · SALE"); a rating's
     * button shows its stars and count; and a picture's alt that is only a file's name ("ex-main-demo") is no label.
     */
    @Test
    void aProductPagesControlsAndPicturesReadAsTheyShow() {
        meta.put("mode", "article");
        extras.put("ld", List.of(Map.of("@type", "Product")));
        block("k", "h", "l", 1, "c", List.of("Tree Runner"));
        block("k", "p", "c", List.of("word ".repeat(400)));
        seen("s.1", "fps1");
        nodes.get("s.1").put("t", "SALE");
        seen("r.1", "fpr1");
        nodes.get("r.1").put("t", "Review: 4.6 out of 5 stars. Total reviews: 2191 (2191)");
        block("k", "p", "c", List.of(List.of("btn", "s.1", "Jet Black (Black Sole)", 0), " ", List.of("btn", "r.1", "(2191)", 0)));
        block("k", "img", "s", "https://cdn.example.com/a.gif", "a", "ex-main-demo", "w", 600, "h", 300);
        block("k", "img", "s", "https://cdn.example.com/b.png", "a", "A brass lamp on a desk", "w", 600, "h", 300);
        MDoc doc = build().doc();
        assertThat(doc.facts).doesNotContainKey("article");
        @SuppressWarnings("unchecked")
        List<Object> runs = (List<Object>) doc.blocks.stream().filter(b -> b.get("runs") instanceof List<?> r && r.size() == 3).findFirst().orElseThrow().get("runs");
        assertThat(m(runs.get(0))).containsEntry("label", "Jet Black (Black Sole) \u00b7 SALE");
        assertThat(m(runs.get(2))).containsEntry("label", "\u2605 4.6 (2191)");
        List<Map<String, Object>> images = doc.blocks.stream().filter(b -> "image".equals(b.get("t"))).toList();
        assertThat(images).extracting(b -> b.get("alt")).containsExactly("", "A brass lamp on a desk");
    }

    /** Review 8: the distiller ships without the prototype's own click path or its rewrite of links' targets. */
    @Test
    void theShippedDistillerHasNoClickPathOfItsOwn() {
        String top = Scripts.load().top;
        assertThat(top).doesNotContain("function guardHandler", "function hit(", "function focusSelect", "a.target = '_self'",
                "/*__READABILITY__*/");
        assertThat(top).contains("function Readability(", "__maProxy", "extractText");
    }
}
