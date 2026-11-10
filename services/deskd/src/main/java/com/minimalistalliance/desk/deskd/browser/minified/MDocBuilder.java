package com.minimalistalliance.desk.deskd.browser.minified;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.net.IDN;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Turns what a page's isolated world answered into an {@link MDoc}, and judges it. Everything it reads was written by
 * the page, or by a distiller the page can steer, so it's treated as hostile (Security T47-6, point 6): only the fields
 * listed here are read, each is checked for type, bounded and cleaned, and nothing unknown passes. A control becomes a
 * node only if deskd's own half saw it and fingerprinted it; a sensitive field never becomes one (T47-1). Images go by
 * opaque ids (T47-5).
 */
final class MDocBuilder {

    /** Actionable controls in one document. Past this, controls show as text. */
    static final int MAX_NODES = 4000;
    static final int MAX_RUN_CHARS = 4000;
    static final int MAX_LABEL_CHARS = 160;
    static final int MAX_CODE_CHARS = 20_000;
    static final int MAX_URL_CHARS = 2048;
    static final int MAX_DEPTH = 8;
    static final int MAX_ROWS = 300;
    static final int MAX_CELLS = 20;
    static final int MAX_OPTIONS = 300;
    static final int MAX_ISLANDS = 50;

    private static final Pattern REF = Pattern.compile("[A-Za-z0-9._-]{1,40}");
    private static final Pattern FP = Pattern.compile("[0-9a-z]{1,16}");
    private static final Pattern ISLAND = Pattern.compile("v[0-9a-z]{1,12}\\.[0-9a-z]{1,12}");
    private static final Pattern ROLE = Pattern.compile("[a-z]{1,24}");
    private static final Set<String> FORMATS = Set.of("b", "i", "code", "sup", "sub", "s");
    /**
     * A field's kind on the wire, in deskd's own words, never an HTML input type, so a renderer has nothing to put in a
     * {@code type=} and a password manager nothing to match (Security T47-1).
     */
    static final Map<String, String> FIELD_KINDS = Map.ofEntries(
            Map.entry("text", "plain"), Map.entry("search", "query"), Map.entry("email", "email_address"),
            Map.entry("tel", "phone_number"), Map.entry("url", "web_address"), Map.entry("number", "numeric"),
            Map.entry("date", "date_choice"), Map.entry("time", "time_choice"), Map.entry("datetime-local", "datetime_choice"),
            Map.entry("month", "month_choice"), Map.entry("week", "week_choice"), Map.entry("color", "colour_choice"),
            Map.entry("range", "range_choice"), Map.entry("file", "file_choice"));
    private static final Set<String> SENSITIVE_KINDS = Set.of("password", "one_time_code", "card", "masked", "payment");
    private static final Pattern DATA_IMAGE = Pattern.compile("data:image/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]{1,1500}");

    /** What a document's builds share: its images' ids, and the fields once seen as sensitive, which stay so. */
    interface Context {
        /** @return an opaque id for the image at this URL, the same each time, or null past the limit */
        String imageId(String url);

        boolean wasSensitive(String ref);

        void markSensitive(String ref);
    }

    /** What deskd's half answered to {@code snapshot}, its shape checked. */
    record Raw(
            String text,
            Map<String, Map<String, Object>> nodes,
            Map<String, String> sens,
            List<Map<String, Object>> media,
            List<Map<String, Object>> signals,
            Map<String, Object> stats,
            Map<String, Object> extras,
            long count) {

        /** @return null if it's not that shape */
        @SuppressWarnings("unchecked")
        static Raw of(Map<String, Object> value, int maxChars) {
            if (!(value.get("chunks") instanceof List<?> chunks)) {
                return null;
            }
            StringBuilder text = new StringBuilder();
            for (Object chunk : chunks) {
                if (!(chunk instanceof String piece) || text.length() + piece.length() > maxChars) {
                    return null;
                }
                text.append(piece);
            }
            Map<String, Map<String, Object>> nodes = new HashMap<>();
            if (value.get("nodes") instanceof Map<?, ?> map) {
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (entry.getKey() instanceof String ref && entry.getValue() instanceof Map<?, ?> node && nodes.size() < MAX_NODES) {
                        nodes.put(ref, (Map<String, Object>) node);
                    }
                }
            }
            Map<String, String> sens = new HashMap<>();
            if (value.get("sens") instanceof Map<?, ?> map) {
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (entry.getKey() instanceof String ref && entry.getValue() instanceof String kind && sens.size() < 20_000) {
                        sens.put(ref, kind);
                    }
                }
            }
            return new Raw(
                    text.toString(),
                    nodes,
                    sens,
                    maps(value.get("media"), 500),
                    maps(value.get("signals"), 20),
                    value.get("stats") instanceof Map<?, ?> stats ? (Map<String, Object>) stats : Map.of(),
                    value.get("extras") instanceof Map<?, ?> extras ? (Map<String, Object>) extras : Map.of(),
                    value.get("count") instanceof Number count ? count.longValue() : 0);
        }

        @SuppressWarnings("unchecked")
        private static List<Map<String, Object>> maps(Object raw, int max) {
            List<Map<String, Object>> list = new ArrayList<>();
            if (raw instanceof List<?> items) {
                for (Object item : items) {
                    if (item instanceof Map<?, ?> map && list.size() < max) {
                        list.add((Map<String, Object>) map);
                    }
                }
            }
            return list;
        }

        boolean loading() {
            return "loading".equals(stats.get("ready"));
        }
    }

    /**
     * A build's outcome.
     *
     * @param doc the document, with rev 0
     * @param fallback why the stream is better, or null
     */
    /** @param cause what a {@link Fallback#CHALLENGE} is, or null */
    record Built(MDoc doc, Fallback fallback, Fallback cause) {}

    private final String tabId;
    private final String url;
    private final String origin;
    private final String title;
    private final Raw raw;
    private final Context context;
    private final List<Map<String, Object>> blocks = new ArrayList<>();
    private final Map<String, MDoc.Node> nodes = new LinkedHashMap<>();
    private final Map<String, MDoc.Island> islands = new LinkedHashMap<>();
    private final Set<String> usedRefs = new HashSet<>();
    private final Set<String> keysUsed = new HashSet<>();
    /** Sensitive kinds shown in the page's own place for them, so they need no block of their own at the top. */
    private final Set<String> shownInline = new HashSet<>();
    private final List<MDoc.Node> pending = new ArrayList<>();
    private final List<String> pendingIslands = new ArrayList<>();
    private final List<String> pendingIslandKinds = new ArrayList<>();
    private int mediaCursor;
    private Map<String, Object> meta = Map.of();
    private final Map<String, Integer> hiddenCounts = new LinkedHashMap<>();
    private int bytes;
    private boolean truncated;
    private boolean sensitive;
    private int textChars;
    /** The view's own words, the first of them: what the person-check rule reads when the view holds little else. */
    private final StringBuilder shown = new StringBuilder();
    private int controls;
    private int formControls;

    private MDocBuilder(String tabId, String url, String title, Raw raw, Context context) {
        this.tabId = tabId;
        this.url = Text.clean(url, MAX_URL_CHARS);
        this.origin = originOf(url);
        this.title = Text.clean(title, 256);
        this.raw = raw;
        this.context = context;
    }

    static Built build(String tabId, String url, String title, Raw raw, Context context) {
        return new MDocBuilder(tabId, url, title, raw, context).run();
    }

    /** {@code scheme://host[:port]}, the host in ASCII, or null if it isn't http or https. */
    static String originOf(String url) {
        try {
            URI uri = new URI(url);
            String scheme = uri.getScheme() == null ? null : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme) || uri.getHost() == null) {
                return null;
            }
            String host = IDN.toASCII(uri.getHost(), IDN.ALLOW_UNASSIGNED).toLowerCase(Locale.ROOT);
            return scheme + "://" + host + (uri.getPort() >= 0 ? ":" + uri.getPort() : "");
        } catch (URISyntaxException | IllegalArgumentException e) {
            return null;
        }
    }

    private Built run() {
        wall();
        String[] lines = raw.text().split("\n", -1);
        String mode = "page";
        try {
            meta = lines.length > 0 ? Json.parseObject(lines[0].getBytes(StandardCharsets.UTF_8)) : Map.of();
            mode = "article".equals(meta.get("mode")) ? "article" : "page";
        } catch (JsonFormatException e) {
            // The page's own heading line is optional to what follows.
        }
        bytes = 512;
        List<Map<String, Object>> top = signalBlocks();
        for (int i = 1; i < lines.length && !truncated && !walled; i++) {
            Map<String, Object> rawBlock = line(lines[i]);
            if (rawBlock == null) {
                continue;
            }
            if ("paywall".equals(rawBlock.get("k")) || "wall".equals(rawBlock.get("k")) && "paywall".equals(rawBlock.get("kind"))) {
                // The distiller saw where the page stops for this member.
                endAtWall();
                break;
            }
            if ("group".equals(rawBlock.get("k")) || "fold".equals(rawBlock.get("k"))) {
                group(rawBlock);
                continue;
            }
            Map<String, Object> block;
            if ("card".equals(rawBlock.get("k"))) {
                // Distiller v2 writes one line per card: the cards of one list, one after another, are one cards block.
                List<Object> items = new ArrayList<>(List.of(v2Card(rawBlock)));
                Object list = rawBlock.get("g");
                while (i + 1 < lines.length && list != null && items.size() < 200) {
                    Map<String, Object> next = line(lines[i + 1]);
                    if (next == null || !"card".equals(next.get("k")) || !list.equals(next.get("g"))) {
                        break;
                    }
                    items.add(v2Card(next));
                    i++;
                }
                block = cards(mapOf("items", items, "lay", rawBlock.get("lay")));
            } else {
                block = block(rawBlock);
            }
            if (block != null && unseen(block)) {
                block = null;
            }
            if (block != null) {
                add(block);
            } else {
                pending.clear();
                pendingIslands.clear();
                pendingIslandKinds.clear();
            }
        }
        notices();
        if (walled && !"terms".equals(wallKind) && !truncated) {
            // The view ends where the member's page does: one line, and nothing past it.
            add(mapOf("t", "paywall"));
        }
        // Signals not shown where they are in the page go first, so the member sees them before anything else.
        List<Map<String, Object>> first = new ArrayList<>();
        for (Map<String, Object> block : top) {
            if (!shownInline.contains(block.get("kind") + " " + block.get("origin"))) {
                block.put("key", key(block));
                first.add(block);
                bytes += Json.bytes(block).length + 1;
            }
        }
        blocks.addAll(0, first);
        sensitive |= !raw.signals().isEmpty();
        Map<String, Object> structured = structured(first.size());
        if (structured != null) {
            structured.put("key", key(structured));
            blocks.add(first.size(), structured);
        }
        Map<String, Object> facts = facts(mode);
        MDoc doc = new MDoc(tabId, 0, url, origin, title, mode, sensitive, truncated, raw.loading(), blocks, nodes, islands,
                facts, consent(), textChars, controls, formControls, bytes);
        Fallback fallback = judge(doc);
        return new Built(doc, fallback, fallback == Fallback.CHALLENGE ? challengeCause(doc) : null);
    }

    /** One sensitive block for each signal deskd's half found anywhere in the page, deduplicated. */
    private List<Map<String, Object>> signalBlocks() {
        List<Map<String, Object>> list = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Map<String, Object> signal : raw.signals()) {
            String kind = Json.string(signal, "kind");
            String where = originOf(Text.clean(signal.get("origin"), MAX_URL_CHARS));
            if (kind == null || !SENSITIVE_KINDS.contains(kind)) {
                continue;
            }
            String shownOrigin = where != null ? where : origin;
            if (seen.add(kind + " " + shownOrigin)) {
                Map<String, Object> block = new LinkedHashMap<>();
                block.put("t", "sensitive");
                block.put("kind", kind);
                if (shownOrigin != null) {
                    block.put("origin", shownOrigin);
                }
                list.add(block);
            }
        }
        return list;
    }

    /** Keys it, counts it against the size, and only then indexes its nodes, so a block that's cut takes its nodes with it. */
    private void add(Map<String, Object> block) {
        String key = key(block);
        block.put("key", key);
        int size = Json.bytes(block).length + 1;
        if (bytes + size > MDoc.MAX_BYTES) {
            truncated = true;
            pending.clear();
            pendingIslands.clear();
            pendingIslandKinds.clear();
            return;
        }
        bytes += size;
        blocks.add(block);
        for (MDoc.Node node : pending) {
            nodes.put(node.id(), new MDoc.Node(node.id(), key, node.fp(), node.kind(), node.fieldKind(), node.options(), node.multiple()));
        }
        for (int i = 0; i < pendingIslands.size(); i++) {
            String[] kindAndFp = pendingIslandKinds.get(i).split(" ", 2);
            islands.put(pendingIslands.get(i), new MDoc.Island(pendingIslands.get(i), key, kindAndFp[0], kindAndFp[1]));
        }
        pending.clear();
        pendingIslands.clear();
        pendingIslandKinds.clear();
    }

    /** A block's key: a hash of what it holds, made unique within the document. */
    private String key(Map<String, Object> block) {
        String base;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(Json.bytes(block));
            base = Base64.getUrlEncoder().withoutPadding().encodeToString(digest).substring(0, 12);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        String key = base;
        for (int n = 2; !keysUsed.add(key); n++) {
            key = base + "~" + n;
        }
        return key;
    }

    // ---- blocks

    private Map<String, Object> block(Map<String, Object> in) {
        String k = Json.string(in, "k");
        if (k == null) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        switch (k) {
            case "h" -> {
                out.put("t", "heading");
                out.put("level", integer(in.get("l"), 1, 6, 2));
                if (!putRuns(out, in.get("c"))) {
                    return null;
                }
            }
            case "p" -> {
                out.put("t", "para");
                if (!putRuns(out, in.get("c"))) {
                    return null;
                }
                if (in.get("q") instanceof Number) {
                    out.put("quote", integer(in.get("q"), 1, 8, 1));
                }
            }
            case "li" -> {
                out.put("t", "item");
                out.put("depth", integer(in.get("d"), 1, 8, 1));
                out.put("ordinal", integer(in.get("o"), 0, 1_000_000, 0));
                if (truthy(in.get("cont"))) {
                    out.put("cont", true);
                }
                if (!putRuns(out, in.get("c"))) {
                    return null;
                }
            }
            case "pre" -> {
                String code = Text.keepLines(in.get("t"), MAX_CODE_CHARS);
                if (code.isBlank()) {
                    return null;
                }
                out.put("t", "code");
                out.put("text", code);
                count(code);
            }
            case "hr" -> out.put("t", "rule");
            case "img" -> {
                String id = imageId(in.get("s"));
                if (id == null) {
                    return null;
                }
                out.put("t", "image");
                out.put("image", id);
                out.put("alt", Text.clean(in.get("a"), MAX_LABEL_CHARS));
                out.put("width", integer(in.get("w"), 0, 20_000, 0));
                out.put("height", integer(in.get("h"), 0, 20_000, 0));
                putRendered(out, in.get("rw"), in.get("rh"));
                Map<String, Object> opens = linkOf(in.get("r"), in.get("u"));
                if (opens != null) {
                    out.put("link", opens);
                }
            }
            case "tbl" -> {
                List<Object> rows = table(in.get("rows"));
                if (rows.isEmpty()) {
                    return null;
                }
                out.put("t", "table");
                out.put("rows", rows);
            }
            case "meta" -> {
                out.put("t", "meta");
                if (!putRuns(out, in.get("c"))) {
                    return null;
                }
            }
            case "chrome" -> {
                out.put("t", "controls");
                List<Object> menus = menus(in.get("menu") != null ? in.get("menu") : in.get("g"));
                List<Object> row = runs(in.get("c"), 0, false);
                if (row.isEmpty() && menus.isEmpty()) {
                    return null;
                }
                out.put("runs", row);
                if (!menus.isEmpty()) {
                    out.put("menus", menus);
                }
            }
            case "answer" -> {
                return answer(in);
            }
            case "cm" -> {
                return comment(in);
            }
            case "card" -> {
                return cards(mapOf("items", List.of(v2Card(in)), "lay", in.get("lay")));
            }
            case "media" -> {
                return media(in);
            }
            case "island" -> {
                return island(in);
            }
            case "bar" -> {
                out.put("t", "bar");
                List<Object> row = runs(in.get("f"), 0, false);
                List<Object> menus = menus(in.get("g"));
                if (row.isEmpty() && menus.isEmpty()) {
                    return null;
                }
                out.put("runs", row);
                out.put("menus", menus);
            }
            case "cards" -> {
                return cards(in);
            }
            case "filters" -> {
                return filters(in);
            }
            default -> {
                return null;
            }
        }
        Object depth = in.get("depth") != null ? in.get("depth") : in.get("n");
        if (depth instanceof Number && "para".equals(out.get("t"))) {
            // A comment's place in its thread (the acceptance check's comment depth).
            out.put("depth", integer(depth, 1, 8, 1));
        }
        if (truthy(in.get("dlg"))) {
            out.put("dialog", true);
        }
        return out;
    }

    // ---- what the member can't see on the real page (the policy: never more than the real page shows them)

    /** deskd's half's keys of text the member can't see: under a wall, or not drawn. */
    private final Set<String> coveredKeys = new HashSet<>();
    private final Set<String> hiddenKeys = new HashSet<>();
    private String wallKind;
    /** The view has ended at a wall: nothing more goes in. */
    private boolean walled;

    @SuppressWarnings("unchecked")
    private void wall() {
        if (!(raw.stats().get("wall") instanceof Map<?, ?> wall)) {
            return;
        }
        wallKind = wall.get("kind") instanceof String kind && Set.of("paywall", "terms").contains(kind) ? kind : null;
        for (String[] list : new String[][] {{"covered"}, {"hidden"}}) {
            if (wall.get(list[0]) instanceof List<?> keys) {
                Set<String> into = "covered".equals(list[0]) ? coveredKeys : hiddenKeys;
                for (Object key : keys) {
                    if (key instanceof String k && k.length() >= MIN_KEY && k.length() <= KEY_CHARS && into.size() < 4000) {
                        into.add(k);
                    }
                }
            }
        }
    }

    /** A block's text as deskd's half keys it: letters and digits, lower case, the first 48. */
    static String textKey(String text) {
        String key = text.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]+", "");
        return key.length() > KEY_CHARS ? key.substring(0, KEY_CHARS) : key;
    }

    private static final int KEY_CHARS = 48;
    private static final int MIN_KEY = 24;

    /**
     * Whether a block is text the member can't see on the real page, whatever the distiller sent. A hidden one is left
     * out; the first one under a wall ends the view there, with the paywall's line (a terms wall falls back anyway).
     */
    private boolean unseen(Map<String, Object> block) {
        if (coveredKeys.isEmpty() && hiddenKeys.isEmpty()) {
            return false;
        }
        StringBuilder text = new StringBuilder();
        textOf(block.get("t").equals("code") ? block.get("text") : block.get("t").equals("table") ? block.get("rows") : block.get("runs"), text);
        String key = textKey(text.toString());
        if (key.length() < MIN_KEY) {
            return false;
        }
        if (coveredKeys.contains(key)) {
            endAtWall();
            return true;
        }
        return hiddenKeys.contains(key);
    }

    private void endAtWall() {
        if (walled) {
            return;
        }
        walled = true;
        pending.clear();
        pendingIslands.clear();
        pendingIslandKinds.clear();
    }

    private static void textOf(Object tree, StringBuilder out) {
        if (out.length() > 400) {
            return;
        }
        if (tree instanceof String s) {
            out.append(s);
        } else if (tree instanceof List<?> list) {
            list.forEach(x -> textOf(x, out));
        } else if (tree instanceof Map<?, ?> map) {
            textOf(map.get("runs"), out);
        }
    }

    /**
     * T47X-2: the site's own alerts and security, session, expiry, verification and failed-payment notices that deskd's
     * half found, as one small block each, with their buttons, at the top: kept whatever the distiller did with them,
     * unless it kept them itself.
     */
    private void notices() {
        if (!(raw.stats().get("notices") instanceof List<?> found) || truncated) {
            return;
        }
        Set<String> shown = new HashSet<>();
        for (Map<String, Object> block : blocks) {
            StringBuilder text = new StringBuilder();
            textOf(block.get("runs"), text);
            String key = textKey(text.toString());
            if (key.length() >= 12) {
                shown.add(key);
            }
        }
        int at = 0;
        for (Object item : found) {
            if (!(item instanceof Map<?, ?> notice) || at >= 3) {
                continue;
            }
            String text = Text.clean(notice.get("text"), 300).strip();
            String key = textKey(text);
            if (text.isEmpty() || shown.stream().anyMatch(s -> s.startsWith(key.substring(0, Math.min(key.length(), 24))) && key.length() >= 12)) {
                continue;
            }
            List<Object> c = new ArrayList<>(List.of(text));
            if (notice.get("buttons") instanceof List<?> buttons) {
                for (Object b : buttons) {
                    if (b instanceof List<?> pair && pair.size() >= 2) {
                        c.add(" ");
                        c.add(List.of("btn", String.valueOf(pair.get(0)), String.valueOf(pair.get(1)), 0));
                    }
                }
            }
            Map<String, Object> block = block(mapOf("k", "p", "c", c, "dlg", 1));
            if (block == null) {
                continue;
            }
            int before = blocks.size();
            add(block);
            if (blocks.size() > before) {
                blocks.add(at++, blocks.remove(blocks.size() - 1));
            }
        }
    }

    /** One of the distiller's block lines, {@code hash<TAB>json}, or null. */
    private static Map<String, Object> line(String line) {
        int tab = line.indexOf('\t');
        if (tab < 0) {
            return null;
        }
        try {
            return Json.parseObject(line.substring(tab + 1).getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            return null;
        }
    }

    /**
     * Distiller v2's card as it writes it, {@code {k: card, g, lay, title, c, price?, stars?, meta?}} with the item's
     * parts laid out in {@code c} (thumbnail link, title link, price, stars, meta, then after a break the snippet, the chips
     * and the actions), back into the item {@link #cards} reads.
     */
    private static Map<String, Object> v2Card(Map<String, Object> in) {
        Map<String, Object> item = new LinkedHashMap<>();
        Object title = in.get("title");
        item.put("t", title);
        List<Object> chips = new ArrayList<>();
        List<Object> actions = new ArrayList<>();
        int part = 0;
        for (Object run : in.get("c") instanceof List<?> c ? c : List.of()) {
            if (run instanceof String text) {
                String shown = text.strip();
                if (part == 0 || shown.isEmpty()) {
                    continue;
                }
                if (!item.containsKey("d") && shown.length() >= 40) {
                    item.put("d", shown);
                } else if (shown.length() <= 24) {
                    chips.add(shown);
                }
                continue;
            }
            if (!(run instanceof List<?> l) || l.isEmpty()) {
                continue;
            }
            switch (String.valueOf(l.get(0))) {
                case "br" -> part++;
                case "btn" -> actions.add(l);
                case "a" -> {
                    if (at(l, 3) instanceof List<?> image && !image.isEmpty() && "img".equals(image.get(0))) {
                        item.put("i", List.of(String.valueOf(at(image, 1)), at(image, 3) == null ? 0 : at(image, 3), at(image, 4) == null ? 0 : at(image, 4)));
                    }
                    if (!item.containsKey("r") || title != null && title.equals(at(l, 3))) {
                        item.put("r", at(l, 1));
                        item.put("u", at(l, 2));
                    }
                }
                default -> {
                    // Formatting inside a card's line is the line's: its text is in the fields.
                }
            }
        }
        item.put("p", in.get("price"));
        item.put("s", in.get("stars"));
        if (in.get("meta") instanceof String meta) {
            item.put("m", List.of(meta.split(" · ")));
        }
        if (!chips.isEmpty()) {
            item.put("ch", chips);
        }
        if (!actions.isEmpty()) {
            item.put("x", actions);
        }
        return item;
    }

    private boolean putRuns(Map<String, Object> out, Object raw) {
        List<Object> runs = runs(raw, 0, false);
        if (runs.isEmpty()) {
            return false;
        }
        out.put("runs", runs);
        return true;
    }

    private List<Object> table(Object raw) {
        List<Object> rows = new ArrayList<>();
        if (!(raw instanceof List<?> list)) {
            return rows;
        }
        for (Object row : list) {
            if (rows.size() >= MAX_ROWS || !(row instanceof List<?> cells)) {
                continue;
            }
            List<Object> out = new ArrayList<>();
            for (Object cell : cells) {
                if (out.size() >= MAX_CELLS || !(cell instanceof Map<?, ?> map)) {
                    continue;
                }
                Map<String, Object> c = new LinkedHashMap<>();
                if (truthy(map.get("h"))) {
                    c.put("head", true);
                }
                if (map.get("cs") instanceof Number) {
                    c.put("span", integer(map.get("cs"), 1, MAX_CELLS, 1));
                }
                c.put("runs", runs(map.get("c"), 0, false));
                out.add(c);
            }
            if (!out.isEmpty()) {
                rows.add(out);
            }
        }
        return rows;
    }

    /**
     * Video, audio, canvas and frames. deskd's half found the same ones in the same order with their ids, so each is
     * matched to the next of its kind and size. One deskd can't match shows as an island that isn't live.
     */
    private Map<String, Object> media(Map<String, Object> in) {
        String m = Json.string(in, "m");
        int w = integer(in.get("w"), 0, 20_000, 0);
        int h = integer(in.get("h"), 0, 20_000, 0);
        if (m == null || !Set.of("video", "audio", "canvas", "iframe", "embed").contains(m)) {
            return null;
        }
        // Distiller v2 on: a player's box in w and h, and its <video>'s own rectangle in vr, which is what the island
        // crops (never the player's chrome). deskd's half found the <video>, or a player's frame, at that size.
        if (in.get("vr") instanceof List<?> vr && vr.size() >= 4 && at(vr, 2) instanceof Number && at(vr, 3) instanceof Number
                && integer(at(vr, 2), 0, 20_000, 0) > 0 && integer(at(vr, 3), 0, 20_000, 0) > 0) {
            w = integer(at(vr, 2), 0, 20_000, 0);
            h = integer(at(vr, 3), 0, 20_000, 0);
        }
        Map<String, Object> match = matchMedia(m, w, h);
        if (match == null && "video".equals(m)) {
            match = matchMedia("iframe", w, h);
            if (match != null) {
                m = "iframe";
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        if (match != null && truthy(match.get("pay"))) {
            String where = originOf(Text.clean(match.get("origin"), MAX_URL_CHARS));
            out.put("t", "sensitive");
            out.put("kind", "payment");
            if (where != null || origin != null) {
                out.put("origin", where != null ? where : origin);
            }
            shownInline.add("payment " + (where != null ? where : origin));
            sensitive = true;
            return out;
        }
        String kind = switch (m) {
            case "iframe" -> match != null && truthy(match.get("video")) ? "video" : "frame";
            default -> m;
        };
        out.put("t", "island");
        String id = match == null ? null : Json.string(match, "island");
        putIsland(out, match, kind);
        out.put("kind", kind);
        out.put("width", w);
        out.put("height", h);
        putState(out, in, match);
        putMediaFacts(out, match);
        if (match != null) {
            Map<String, Object> box = new LinkedHashMap<>();
            box.put("x", integer(match.get("x"), -1_000_000, 10_000_000, 0));
            box.put("y", integer(match.get("y"), -1_000_000, 10_000_000, 0));
            box.put("width", w);
            box.put("height", h);
            out.put("box", box);
        }
        String label = Text.clean(in.get("n"), 80);
        if (!label.isEmpty()) {
            out.put("label", label);
        }
        return out;
    }

    /** The next media element deskd's half found of this kind and size, give or take 2 px, in page order. */
    private Map<String, Object> matchMedia(String m, int w, int h) {
        for (int i = mediaCursor; i < raw.media().size(); i++) {
            Map<String, Object> candidate = raw.media().get(i);
            if (m.equals(candidate.get("m"))
                    && Math.abs(integer(candidate.get("w"), 0, 20_000, -9) - w) <= 2
                    && Math.abs(integer(candidate.get("h"), 0, 20_000, -9) - h) <= 2) {
                mediaCursor = i + 1;
                return candidate;
            }
        }
        return null;
    }

    /** deskd's id for an island, if this one is new, under the limit, and fingerprinted. */
    private void putIsland(Map<String, Object> out, Map<String, Object> match, String kind) {
        String id = match == null ? null : Json.string(match, "island");
        String fp = match == null ? null : Json.string(match, "fp");
        if (id != null && ISLAND.matcher(id).matches() && fp != null && FP.matcher(fp).matches()
                && islands.size() + pendingIslands.size() < MAX_ISLANDS && !islands.containsKey(id) && !pendingIslands.contains(id)) {
            out.put("island", id);
            out.put("fp", fp);
            pendingIslands.add(id);
            pendingIslandKinds.add(kind + " " + fp);
        }
    }

    /**
     * Whether an island plays in the view: {@code live} if deskd found its element and can stream it, {@code click} if
     * the page shows a poster that needs a click on the real page first, {@code none} otherwise; and {@code ad} for an
     * ad's media, which the view doesn't play (the acceptance check's island state and ad flag).
     */
    private static void putState(Map<String, Object> out, Map<String, Object> in, Map<String, Object> match) {
        String said = Json.string(in, "island");
        String state = "live".equals(said) || "click".equals(said) || "none".equals(said) ? said
                : "click-to-play".equals(in.get("why")) ? "click"
                : out.containsKey("island") ? "live"
                : "none";
        out.put("state", state);
        if (truthy(in.get("ad")) || match != null && truthy(match.get("ad"))) {
            out.put("ad", true);
        }
    }

    /** R17: a video's chapters, as times the island's own controls seek to. */
    private static void putChapters(Map<String, Object> out, Object raw) {
        if (!(raw instanceof List<?> list) || !(out.get("media") instanceof Map<?, ?>)) {
            return;
        }
        List<Object> chapters = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof List<?> pair && pair.size() >= 2 && pair.get(0) instanceof Number time && chapters.size() < 100) {
                chapters.add(mapOf("time", Math.max(0, Math.min(1e7, time.doubleValue())), "label", Text.clean(pair.get(1), 100)));
            }
        }
        if (!chapters.isEmpty()) {
            @SuppressWarnings("unchecked")
            Map<String, Object> media = (Map<String, Object>) out.get("media");
            media.put("chapters", chapters);
        }
    }

    /** R22: a search engine's own answer, as one card above the results, its sources as links. */
    private Map<String, Object> answer(Map<String, Object> in) {
        List<Object> runs = runs(in.get("c"), 0, false);
        if (runs.isEmpty()) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("t", "answer");
        out.put("label", Text.clean(in.get("n"), 60));
        out.put("runs", runs);
        List<Object> sources = new ArrayList<>();
        for (Object run : runs(in.get("src"), 0, false)) {
            if (run instanceof Map<?, ?> m && "link".equals(m.get("r")) && sources.size() < 10) {
                sources.add(run);
            }
        }
        out.put("sources", sources);
        return out;
    }

    /**
     * R26 to R30: one comment, answer or question, with its place in the thread, who wrote it and their role, its score
     * and its vote and reply controls as nodes, whether it's folded, and the accepted answer's mark. Its order is the
     * site's own: nothing is moved.
     */
    private Map<String, Object> comment(Map<String, Object> in) {
        List<Object> runs = runs(in.get("c"), 0, false);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("t", "comment");
        String kind = in.get("kind") instanceof String k && Set.of("comment", "answer", "question").contains(k) ? k : "comment";
        out.put("kind", kind);
        out.put("depth", integer(in.get("d"), 0, 8, 0));
        Map<String, Object> author = new LinkedHashMap<>();
        String name = Text.clean(in.get("au"), 80);
        if (!name.isEmpty()) {
            author.put("name", name);
            String role = Text.clean(in.get("role"), 24);
            if (!role.isEmpty()) {
                author.put("role", role);
            }
            out.put("author", author);
        }
        putText(out, "score", in.get("sc"), 16);
        for (String[] control : new String[][] {{"up", "up"}, {"dn", "down"}, {"re", "reply"}}) {
            List<Object> one = runs(in.get(control[0]) == null ? null : List.of(in.get(control[0])), 0, false);
            if (one.size() == 1 && one.get(0) instanceof Map<?, ?> m && "button".equals(m.get("r"))) {
                out.put(control[1], one.get(0));
            }
        }
        if (truthy(in.get("col"))) {
            out.put("collapsed", true);
        }
        if (in.get("more") instanceof Number) {
            out.put("more", integer(in.get("more"), 0, 1_000_000, 0));
        }
        if (truthy(in.get("acc"))) {
            out.put("accepted", true);
        }
        out.put("runs", runs);
        return runs.isEmpty() && !out.containsKey("more") ? null : out;
    }

    /**
     * Where a search engine's redirect link goes, read from the link itself, never fetched (R23): google.com/url's q or
     * url, bing.com/ck/a's u (a1 then base64url), duckduckgo.com/l's uddg and l.facebook.com's u. Null for anything else,
     * or a destination that isn't an http(s) URL.
     */
    static String destination(String url) {
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            return null;
        }
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        String path = uri.getRawPath() == null ? "" : uri.getRawPath();
        Map<String, String> query = query(uri.getRawQuery());
        String target = null;
        if ((host.equals("google.com") || host.startsWith("www.google.")) && path.equals("/url")) {
            target = query.getOrDefault("q", query.get("url"));
        } else if ((host.equals("www.bing.com") || host.equals("bing.com")) && path.startsWith("/ck/a")) {
            String u = query.get("u");
            if (u != null && u.startsWith("a1")) {
                try {
                    target = new String(Base64.getUrlDecoder().decode(u.substring(2).replace('+', '-').replace('/', '_')),
                            StandardCharsets.UTF_8);
                } catch (IllegalArgumentException e) {
                    return null;
                }
            }
        } else if (host.endsWith("duckduckgo.com") && path.startsWith("/l/")) {
            target = query.get("uddg");
        } else if (host.equals("l.facebook.com") && path.equals("/l.php")) {
            target = query.get("u");
        }
        return target == null ? null : httpUrl(target);
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> query = new HashMap<>();
        if (raw == null) {
            return query;
        }
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0) {
                try {
                    query.putIfAbsent(pair.substring(0, eq), java.net.URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
                } catch (IllegalArgumentException e) {
                    // A malformed escape: not one to follow.
                }
            }
        }
        return query;
    }

    /** Collapsed groups of the site's chrome: each a label and its runs, at most eight. */
    private List<Object> menus(Object raw) {
        List<Object> menus = new ArrayList<>();
        if (raw instanceof List<?> groups) {
            for (Object group : groups) {
                if (group instanceof Map<?, ?> g && menus.size() < 8) {
                    List<Object> inner = runs(g.get("c"), 0, false);
                    if (!inner.isEmpty()) {
                        String label = Text.clean(g.get("n"), 60);
                        String kind = g.get("kind") instanceof String k && Set.of("menu", "filters", "contents").contains(k) ? k
                                : label.equalsIgnoreCase("filters") ? "filters"
                                : label.equalsIgnoreCase("contents") ? "contents"
                                : "menu";
                        menus.add(mapOf("label", label, "kind", kind, "runs", inner));
                    }
                }
            }
        }
        return menus;
    }

    /** The size an image is shown at on the real page, which the view lays out by before its pixels come. */
    private static void putRendered(Map<String, Object> out, Object width, Object height) {
        if (width instanceof Number && height instanceof Number) {
            out.put("renderedWidth", integer(width, 0, 20_000, 0));
            out.put("renderedHeight", integer(height, 0, 20_000, 0));
        }
    }

    /** A content video's state, for the island's own controls (spec section 9: media). */
    private void putMediaFacts(Map<String, Object> out, Map<String, Object> match) {
        if (match == null) {
            return;
        }
        Map<String, Object> media = new LinkedHashMap<>();
        if (match.get("dur") instanceof Number d) {
            media.put("duration", Math.max(0, Math.min(1e7, d.doubleValue())));
        }
        if (match.get("at") instanceof Number t) {
            media.put("time", Math.max(0, Math.min(1e7, t.doubleValue())));
        }
        if (match.get("paused") instanceof Boolean paused) {
            media.put("paused", paused);
        }
        if (truthy(match.get("muted"))) {
            media.put("muted", true);
        }
        if (truthy(match.get("drm"))) {
            media.put("drm", true);
        }
        String poster = imageId(match.get("poster"));
        if (poster != null) {
            media.put("poster", poster);
        }
        if (match.get("tracks") instanceof List<?> tracks) {
            List<Object> list = new ArrayList<>();
            for (Object track : tracks) {
                if (track instanceof Map<?, ?> t && list.size() < 16) {
                    list.add(mapOf("kind", Text.clean(t.get("kind"), 16), "label", Text.clean(t.get("label"), 60),
                            "lang", Text.clean(t.get("lang"), 16), "on", truthy(t.get("on"))));
                }
            }
            if (!list.isEmpty()) {
                media.put("tracks", list);
            }
        }
        boolean frame = "iframe".equals(match.get("m")) || "embed".equals(match.get("m"));
        media.put("frame", frame);
        if (frame) {
            media.put("crossOrigin", truthy(match.get("cross")));
        }
        out.put("media", media);
    }

    /**
     * A player as distiller v2 marks it, with its box in page pixels: deskd's island is the media element inside that box,
     * or the frame, never the site's player chrome (spec section 6).
     */
    private Map<String, Object> island(Map<String, Object> in) {
        int x = integer(in.get("x"), -1_000_000, 10_000_000, 0);
        int y = integer(in.get("y"), -1_000_000, 10_000_000, 0);
        int w = integer(in.get("w"), 0, 20_000, 0);
        int h = integer(in.get("h"), 0, 20_000, 0);
        Map<String, Object> match = null;
        for (Map<String, Object> candidate : raw.media()) {
            String m = Json.string(candidate, "m");
            if (!"video".equals(m) && !"iframe".equals(m) && !"embed".equals(m) && !"audio".equals(m)) {
                continue;
            }
            double cx = integer(candidate.get("x"), -1_000_000, 10_000_000, 0) + integer(candidate.get("w"), 0, 20_000, 0) / 2.0;
            double cy = integer(candidate.get("y"), -1_000_000, 10_000_000, 0) + integer(candidate.get("h"), 0, 20_000, 0) / 2.0;
            if (cx >= x && cx <= x + w && cy >= y && cy <= y + h && !pendingIslands.contains(Json.string(candidate, "island"))
                    && !islands.containsKey(Json.string(candidate, "island"))) {
                match = candidate;
                break;
            }
        }
        if (match != null && truthy(match.get("pay"))) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("t", "island");
        String kind = "audio".equals(match == null ? null : match.get("m")) ? "audio" : "video";
        putIsland(out, match, kind);
        out.put("kind", kind);
        int mw = match == null ? w : integer(match.get("w"), 0, 20_000, w);
        int mh = match == null ? h : integer(match.get("h"), 0, 20_000, h);
        out.put("width", mw);
        out.put("height", mh);
        Map<String, Object> box = new LinkedHashMap<>();
        box.put("x", match == null ? x : integer(match.get("x"), -1_000_000, 10_000_000, x));
        box.put("y", match == null ? y : integer(match.get("y"), -1_000_000, 10_000_000, y));
        box.put("width", mw);
        box.put("height", mh);
        out.put("box", box);
        if (truthy(in.get("main"))) {
            out.put("main", true);
        }
        if (truthy(in.get("pre"))) {
            out.put("preRoll", true);
        }
        putState(out, in, match);
        putMediaFacts(out, match);
        putChapters(out, in.get("chapters"));
        if (match == null) {
            String poster = imageId(in.get("poster"));
            if (poster != null) {
                out.put("media", mapOf("poster", poster, "frame", false));
            }
        }
        String label = Text.clean(in.get("n"), 100);
        if (!label.isEmpty()) {
            out.put("label", label);
        }
        return out;
    }

    /** Repeated items as typed cards (spec section 9), from distiller v2's cards. */
    private Map<String, Object> cards(Map<String, Object> in) {
        if (!(in.get("items") instanceof List<?> items)) {
            return null;
        }
        List<Object> out = new ArrayList<>();
        for (Object item : items) {
            if (out.size() >= 200 || !(item instanceof Map<?, ?> it)) {
                continue;
            }
            String title = Text.clean(it.get("t"), 200);
            if (title.isEmpty()) {
                continue;
            }
            Map<String, Object> card = new LinkedHashMap<>();
            Map<String, Object> link = linkOf(it.get("r"), it.get("u"));
            Map<String, Object> head = link != null ? link : new LinkedHashMap<>();
            head.put("text", title);
            card.put("title", head);
            if (it.get("i") instanceof List<?> image && !image.isEmpty()) {
                String id = imageId(image.get(0));
                if (id != null) {
                    card.put("image", mapOf("image", id, "width", integer(at(image, 1), 0, 20_000, 0), "height", integer(at(image, 2), 0, 20_000, 0)));
                }
            }
            putText(card, "price", it.get("p"), 32);
            putText(card, "listPrice", it.get("lp"), 32);
            putText(card, "rating", it.get("s"), 8);
            putText(card, "ratingCount", it.get("rc"), 16);
            putText(card, "badge", it.get("b"), 32);
            putText(card, "deal", it.get("deal"), 80);
            putText(card, "delivery", it.get("dl"), 80);
            putText(card, "duration", it.get("du"), 16);
            putTexts(card, "meta", it.get("m"), 4, 80);
            putTexts(card, "chips", it.get("ch"), 4, 24);
            putText(card, "snippet", it.get("d"), 260);
            List<Object> actions = new ArrayList<>();
            for (Object run : runs(it.get("x"), 0, false)) {
                if (run instanceof Map<?, ?> m && "button".equals(m.get("r")) && actions.size() < 3) {
                    actions.add(run);
                }
            }
            if (!actions.isEmpty()) {
                card.put("actions", actions);
            }
            count(title);
            out.add(card);
        }
        if (out.isEmpty()) {
            return null;
        }
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("t", "cards");
        block.put("layout", "grid".equals(in.get("lay")) ? "grid" : "list");
        block.put("repeat", out.size());
        block.put("items", out);
        return block;
    }

    /**
     * A header block saying how many {@code grouped} blocks follow it, collapsed: a {@code group}, recirculation such as
     * "More from this site", or a {@code fold} (R17, R32), a video's Description or a thread's Comments, of which the
     * first {@code lead} show open. A comments fold may hold none and say how many in {@code meta}.
     */
    private void group(Map<String, Object> in) {
        boolean fold = "fold".equals(in.get("k"));
        List<?> inner = in.get("c") instanceof List<?> c ? c : List.of();
        if (!fold && inner.isEmpty()) {
            return;
        }
        List<Map<String, Object>> converted = new ArrayList<>();
        List<List<MDoc.Node>> nodesOf = new ArrayList<>();
        for (Object item : inner) {
            if (converted.size() >= 300 || !(item instanceof Map<?, ?> raw)) {
                continue;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> block = block((Map<String, Object>) raw);
            if (block != null && !walled && unseen(block)) {
                block = null;
            }
            if (block != null && !walled) {
                block.put("grouped", true);
                converted.add(block);
                nodesOf.add(new ArrayList<>(pending));
            }
            pending.clear();
            pendingIslands.clear();
            pendingIslandKinds.clear();
        }
        Map<String, Object> header;
        if (fold) {
            String kind = in.get("kind") instanceof String k && Set.of("description", "comments").contains(k) ? k : "other";
            String label = Text.clean(in.get("n"), 80).strip();
            if (label.isEmpty()) {
                label = "description".equals(kind) ? "Description" : "comments".equals(kind) ? "Comments" : "";
            }
            if (label.isEmpty() || converted.isEmpty() && !"comments".equals(kind)) {
                return;
            }
            header = mapOf("t", "fold", "label", label, "kind", kind, "lead", Math.min(integer(in.get("lead"), 0, 20, 0), converted.size()),
                    "size", converted.size());
            String meta = Text.clean(in.get("m"), 80).strip();
            if (!meta.isEmpty()) {
                header.put("meta", meta);
            }
        } else {
            if (converted.isEmpty()) {
                return;
            }
            header = mapOf("t", "group", "label", Text.clean(in.get("n"), 80), "size", converted.size());
        }
        add(header);
        for (int i = 0; i < converted.size() && !truncated; i++) {
            pending.addAll(nodesOf.get(i));
            add(converted.get(i));
        }
    }

    /** A link a block opens: its node if deskd's half saw it, and its URL. */
    private Map<String, Object> linkOf(Object ref, Object href) {
        Map<String, Object> link = new LinkedHashMap<>();
        Map<String, Object> seen = take(ref);
        if (seen != null) {
            pend(ref, seen, MDoc.NodeKind.LINK, null, null, false);
            putNode(link, ref, seen);
        }
        String url = linkUrl(href);
        if (url != null) {
            link.put("url", url);
        }
        return link.isEmpty() ? null : link;
    }

    private static void putText(Map<String, Object> out, String name, Object raw, int max) {
        String text = raw instanceof Number n ? n.toString() : Text.clean(raw, max);
        if (!text.isEmpty()) {
            out.put(name, text);
        }
    }

    private static void putTexts(Map<String, Object> out, String name, Object raw, int count, int max) {
        if (!(raw instanceof List<?> list)) {
            return;
        }
        List<Object> texts = new ArrayList<>();
        for (Object item : list) {
            String text = Text.clean(item, max);
            if (!text.isEmpty() && texts.size() < count) {
                texts.add(text);
            }
        }
        if (!texts.isEmpty()) {
            out.put(name, texts);
        }
    }

    // ---- runs

    private List<Object> runs(Object raw, int depth, boolean inLink) {
        List<Object> out = new ArrayList<>();
        if (!(raw instanceof List<?> items)) {
            return out;
        }
        for (Object item : items) {
            if (item instanceof String s) {
                String text = Text.clean(s, MAX_RUN_CHARS);
                if (!text.isEmpty()) {
                    count(text);
                    appendText(out, text);
                }
            } else if (item instanceof List<?> list && !list.isEmpty() && list.get(0) instanceof String tag) {
                run(out, tag, list, depth, inLink);
            }
        }
        trim(out);
        return out;
    }

    private void run(List<Object> out, String tag, List<?> l, int depth, boolean inLink) {
        if (FORMATS.contains(tag)) {
            List<Object> inner = runs(l.subList(1, l.size()), depth + 1, inLink);
            if (inner.isEmpty()) {
                return;
            }
            if (depth >= MAX_DEPTH) {
                inner.forEach(x -> append(out, x));
            } else {
                append(out, mapOf("r", tag, "runs", inner));
            }
            return;
        }
        switch (tag) {
            case "br" -> append(out, mapOf("r", "br"));
            case "img" -> {
                String id = imageId(at(l, 1));
                if (id != null) {
                    Map<String, Object> image = new LinkedHashMap<>();
                    image.put("r", "image");
                    image.put("image", id);
                    image.put("alt", Text.clean(at(l, 2), MAX_LABEL_CHARS));
                    image.put("width", integer(at(l, 3), 0, 20_000, 0));
                    image.put("height", integer(at(l, 4), 0, 20_000, 0));
                    putRendered(image, at(l, 5), at(l, 6));
                    append(out, image);
                }
            }
            case "a" -> link(out, l, depth, inLink);
            case "vote" -> {
                if (!inLink) {
                    vote(out, l);
                }
            }
            case "btn" -> {
                if (inLink) {
                    appendText(out, Text.clean(at(l, 2), MAX_LABEL_CHARS));
                } else {
                    button(out, l);
                }
            }
            case "in", "sel", "ta" -> {
                if (inLink) {
                    return;
                }
                switch (tag) {
                    case "in" -> input(out, l);
                    case "sel" -> select(out, l);
                    default -> textarea(out, l);
                }
            }
            default -> {
                // Nothing else is known, so nothing else passes.
            }
        }
    }

    private void link(List<Object> out, List<?> l, int depth, boolean inLink) {
        // ['a', ref, href, {pri}?, ...runs]: flags, when there are any, come before the runs.
        boolean flagged = at(l, 3) instanceof Map<?, ?>;
        Map<?, ?> flags = flagged ? (Map<?, ?>) at(l, 3) : Map.of();
        boolean primary = truthy(flags.get("pri"));
        int first = flagged ? 4 : 3;
        List<Object> inner = runs(l.size() > first ? l.subList(first, l.size()) : List.of(), depth + 1, true);
        String href = linkUrl(at(l, 2));
        if (inLink) {
            inner.forEach(x -> append(out, x));
            return;
        }
        Map<String, Object> link = new LinkedHashMap<>();
        link.put("r", "link");
        Map<String, Object> seen = take(at(l, 1));
        if (seen != null) {
            pend(at(l, 1), seen, MDoc.NodeKind.LINK, null, null, false);
            putNode(link, at(l, 1), seen);
            // R1: a link named by its label rather than its text shows its text, and keeps the name for screen readers.
            String shown = Text.clean(seen.get("t"), MAX_LABEL_CHARS).strip();
            if (!shown.isEmpty() && inner.size() == 1 && inner.get(0) instanceof String named && !named.equals(shown)) {
                link.put("name", named);
                inner.set(0, shown);
            }
        }
        if (href != null) {
            // R23: a search engine's redirect shows as where it goes. A click still goes through the page's own link.
            String destination = destination(href);
            link.put("url", destination != null ? destination : href);
            if (destination != null) {
                link.put("redirect", true);
            }
        }
        if (truthy(flags.get("auth"))) {
            link.put("signIn", true);
        }
        if (truthy(flags.get("next"))) {
            // R16: the page's next page.
            link.put("next", true);
        }
        if (seen == null && href == null) {
            inner.forEach(x -> append(out, x));
            return;
        }
        if (inner.isEmpty()) {
            inner.add(href != null ? href.substring(0, Math.min(href.length(), 80)) : "link");
        }
        if (primary) {
            link.put("primary", true);
        }
        link.put("runs", inner);
        controls++;
        append(out, link);
    }

    /**
     * A listing's filter rail as one row (R10): {@code {k: filters, all?, c, sort?, g}} from the distiller becomes
     * {@code {t: filters, count?, runs, sort?, menus}}, the first filters as chips, the sort control, and the whole rail.
     */
    private Map<String, Object> filters(Map<String, Object> in) {
        List<Object> chips = new ArrayList<>();
        for (Object run : runs(in.get("c"), 0, false)) {
            if (run instanceof Map<?, ?> && chips.size() < 12) {
                chips.add(run);
            }
        }
        Object sort = null;
        for (Object run : runs(in.get("sort") == null ? List.of() : List.of(in.get("sort")), 0, false)) {
            if (run instanceof Map<?, ?>) {
                sort = run;
                break;
            }
        }
        List<Object> menus = new ArrayList<>();
        for (Object menu : menus(in.get("g"))) {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) menu;
            m.put("kind", "filters");
            menus.add(m);
        }
        if (chips.isEmpty() && sort == null && menus.isEmpty()) {
            return null;
        }
        Map<String, Object> out = mapOf("t", "filters", "runs", chips, "menus", menus);
        if (in.get("all") instanceof Number) {
            out.put("count", integer(in.get("all"), 0, 999, 0));
        }
        if (sort != null) {
            out.put("sort", sort);
        }
        return out;
    }

    /**
     * A site's up and down votes and its score as one control (R26): {@code ['vote', upRef, score, downRef, state]}.
     * Each arrow is the real page's own control, a node like a button's, pressed with {@code act click} on its node.
     */
    private void vote(List<Object> out, List<?> l) {
        String score = Text.clean(at(l, 2), 16).strip();
        Map<String, Object> vote = new LinkedHashMap<>();
        vote.put("r", "vote");
        vote.put("score", score);
        for (String side : List.of("up", "down")) {
            Object ref = at(l, "up".equals(side) ? 1 : 3);
            Map<String, Object> seen = take(ref);
            if (seen != null) {
                pend(ref, seen, MDoc.NodeKind.BUTTON, null, null, false);
                Map<String, Object> arrow = new LinkedHashMap<>();
                putNode(arrow, ref, seen);
                vote.put(side, arrow);
                controls++;
            }
        }
        if (!vote.containsKey("up") && !vote.containsKey("down")) {
            appendText(out, score);
            return;
        }
        if ("up".equals(at(l, 4)) || "down".equals(at(l, 4))) {
            vote.put("state", at(l, 4));
        }
        append(out, vote);
    }

    private void button(List<Object> out, List<?> l) {
        String name = Text.clean(at(l, 2), MAX_LABEL_CHARS);
        String label = name;
        Map<String, Object> button = new LinkedHashMap<>();
        button.put("r", "button");
        Map<String, Object> seen = take(at(l, 1));
        if (seen != null) {
            pend(at(l, 1), seen, MDoc.NodeKind.BUTTON, null, null, false);
            putNode(button, at(l, 1), seen);
            // R1: a control is called what it shows; its accessible name only names one that shows nothing (T47-2 too).
            String shown = Text.clean(seen.get("t"), MAX_LABEL_CHARS).strip();
            if (!shown.isEmpty()) {
                label = shown;
            }
        }
        button.put("label", label);
        if (!name.isEmpty() && !name.equals(label)) {
            button.put("name", name);
        }
        if (at(l, 3) instanceof Map<?, ?> flags) {
            if (flags.get("r") instanceof String role && ROLE.matcher(role).matches()) {
                button.put("role", role);
            }
            flag(button, "pressed", flags.get("p"));
            flag(button, "expanded", flags.get("e"));
            flag(button, "selected", flags.get("s"));
            flag(button, "checked", flags.get("c"));
            if (truthy(flags.get("d"))) {
                button.put("disabled", true);
            }
            if (truthy(flags.get("pri"))) {
                button.put("primary", true);
            }
            if (truthy(flags.get("auth"))) {
                // R7: it only leads to signing in, which the real page does.
                button.put("signIn", true);
            }
        }
        controls++;
        formControls++;
        append(out, button);
    }

    private void input(List<Object> out, List<?> l) {
        if (!(at(l, 2) instanceof Map<?, ?> o)) {
            return;
        }
        Object ref = at(l, 1);
        String type = o.get("t") instanceof String t ? t.toLowerCase(Locale.ROOT) : "text";
        Map<String, Object> seen = nodeSeen(ref);
        String verdict = judged(ref, seen);
        if ("password".equals(type) || verdict != null && !verdict.isEmpty()) {
            sensitiveRun(out, ref, verdict != null && !verdict.isEmpty() ? verdict : "password");
            return;
        }
        String label = Text.clean(o.get("l"), MAX_LABEL_CHARS);
        if (type.equals("checkbox") || type.equals("radio")) {
            Map<String, Object> check = new LinkedHashMap<>();
            check.put("r", "check");
            Map<String, Object> taken = take(ref);
            if (taken != null) {
                pend(ref, taken, MDoc.NodeKind.CHECK, type, null, false);
                putNode(check, ref, taken);
            }
            check.put("kind", type);
            boolean checked = taken != null && taken.get("c") instanceof Number c ? c.intValue() == 1 : truthy(o.get("c"));
            check.put("checked", checked);
            check.put("label", label);
            if (truthy(o.get("d"))) {
                check.put("disabled", true);
            }
            if (o.get("g") instanceof String group && !group.isEmpty()) {
                // Groups radios together; the page's own name for it never reaches the office.
                check.put("group", Integer.toHexString(group.hashCode()));
            }
            controls++;
            formControls++;
            append(out, check);
            return;
        }
        String kind = FIELD_KINDS.getOrDefault(type, "plain");
        Map<String, Object> field = new LinkedHashMap<>();
        field.put("r", "field");
        Map<String, Object> taken = take(ref);
        if (taken != null) {
            pend(ref, taken, MDoc.NodeKind.FIELD, kind, null, false);
            putNode(field, ref, taken);
        }
        field.put("kind", kind);
        field.put("label", label);
        // A field deskd's half didn't judge shows no value: it may be one that's never to leave the desk (T47-1).
        field.put("value", verdict == null ? "" : Text.clean(o.get("v"), MAX_RUN_CHARS));
        String placeholder = Text.clean(o.get("p"), MAX_LABEL_CHARS);
        if (!placeholder.isEmpty()) {
            field.put("placeholder", placeholder);
        }
        if (truthy(o.get("d"))) {
            field.put("disabled", true);
        }
        controls++;
        formControls++;
        append(out, field);
    }

    private void textarea(List<Object> out, List<?> l) {
        if (!(at(l, 2) instanceof Map<?, ?> o)) {
            return;
        }
        Object ref = at(l, 1);
        Map<String, Object> seen = nodeSeen(ref);
        String verdict = judged(ref, seen);
        if (verdict != null && !verdict.isEmpty()) {
            sensitiveRun(out, ref, verdict);
            return;
        }
        boolean enter = truthy(o.get("enter"));
        String kind = enter ? "plain" : "multiline";
        Map<String, Object> field = new LinkedHashMap<>();
        field.put("r", "field");
        Map<String, Object> taken = take(ref);
        if (taken != null) {
            pend(ref, taken, MDoc.NodeKind.FIELD, kind, null, false);
            putNode(field, ref, taken);
        }
        field.put("kind", kind);
        field.put("label", Text.clean(o.get("l"), MAX_LABEL_CHARS));
        field.put("value", verdict == null ? "" : Text.keepLines(o.get("v"), MAX_RUN_CHARS));
        String placeholder = Text.clean(o.get("p"), MAX_LABEL_CHARS);
        if (!placeholder.isEmpty()) {
            field.put("placeholder", placeholder);
        }
        if (enter) {
            field.put("enter", true);
        }
        controls++;
        formControls++;
        append(out, field);
    }

    private void select(List<Object> out, List<?> l) {
        if (!(at(l, 2) instanceof Map<?, ?> o)) {
            return;
        }
        Object ref = at(l, 1);
        String verdict = judged(ref, nodeSeen(ref));
        if (verdict != null && !verdict.isEmpty()) {
            // A card's expiry or type, as a select: still the card's (T47-1).
            sensitiveRun(out, ref, verdict);
            return;
        }
        List<String> options = new ArrayList<>();
        if (o.get("o") instanceof List<?> raws) {
            for (Object option : raws) {
                if (options.size() >= MAX_OPTIONS) {
                    break;
                }
                // Each option is [value, text]: the value is the page's own, and never leaves the desk (T47-2: by index).
                options.add(option instanceof List<?> pair && pair.size() > 1 ? Text.clean(pair.get(1), 80) : "");
            }
        }
        Map<String, Object> select = new LinkedHashMap<>();
        select.put("r", "select");
        Map<String, Object> taken = take(ref);
        boolean multiple = taken != null && truthy(taken.get("m"));
        if (taken != null) {
            pend(ref, taken, MDoc.NodeKind.SELECT, null, List.copyOf(options), multiple);
            putNode(select, ref, taken);
        }
        select.put("label", Text.clean(o.get("l"), MAX_LABEL_CHARS));
        select.put("options", options);
        int index = taken != null && taken.get("si") instanceof Number si ? si.intValue() : -1;
        select.put("selected", index >= 0 && index < options.size() ? index : -1);
        if (multiple) {
            select.put("multiple", true);
        }
        if (truthy(o.get("d"))) {
            select.put("disabled", true);
        }
        controls++;
        formControls++;
        append(out, select);
    }

    /** In place of a sensitive field: a run that says where to sign in, and no node at all (T47-1). */
    private void sensitiveRun(List<Object> out, Object ref, String kind) {
        if (ref instanceof String r && REF.matcher(r).matches()) {
            context.markSensitive(r);
            usedRefs.add(r);
        }
        Map<String, Object> run = new LinkedHashMap<>();
        run.put("r", "sensitive");
        run.put("kind", kind);
        if (origin != null) {
            run.put("origin", origin);
        }
        shownInline.add(kind + " " + origin);
        sensitive = true;
        controls++;
        formControls++;
        append(out, run);
    }

    /**
     * What deskd's half made of a field: a sensitive kind, "" if it judged it not sensitive, or null if it didn't judge
     * it at all, as for one gone by the time it looked. Signals only add: one an earlier build saw as sensitive stays so.
     */
    private String judged(Object ref, Map<String, Object> seen) {
        String kind = sensitiveRef(ref, seen);
        if (kind != null) {
            return kind;
        }
        if (seen != null) {
            return "";
        }
        if (ref instanceof String r && raw.sens().get(r) instanceof String said) {
            return SENSITIVE_KINDS.contains(said) ? said : "";
        }
        return null;
    }

    /** What deskd's half saw of a ref, or null. */
    private Map<String, Object> nodeSeen(Object ref) {
        return ref instanceof String r && REF.matcher(r).matches() ? raw.nodes().get(r) : null;
    }

    /** The sensitive kind deskd's half or an earlier build found for this field, or null. Signals only ever add. */
    private String sensitiveRef(Object ref, Map<String, Object> seen) {
        if (seen != null && seen.get("s") instanceof String kind && SENSITIVE_KINDS.contains(kind)) {
            return kind;
        }
        return ref instanceof String r && context.wasSensitive(r) ? "masked" : null;
    }

    /** What deskd's half saw of a ref it may index: once, under the limit, and not sensitive. */
    private Map<String, Object> take(Object ref) {
        Map<String, Object> seen = nodeSeen(ref);
        if (seen == null || usedRefs.contains(ref) || nodes.size() + pending.size() >= MAX_NODES || sensitiveRef(ref, seen) != null) {
            return null;
        }
        if (!(seen.get("fp") instanceof String fp) || !FP.matcher(fp).matches()) {
            return null;
        }
        usedRefs.add((String) ref);
        return seen;
    }

    private void pend(Object ref, Map<String, Object> seen, MDoc.NodeKind kind, String fieldKind, List<String> options, boolean multiple) {
        pending.add(new MDoc.Node((String) ref, null, (String) seen.get("fp"), kind, fieldKind, options, multiple));
    }

    private static void putNode(Map<String, Object> run, Object ref, Map<String, Object> seen) {
        run.put("node", ref);
        run.put("fp", seen.get("fp"));
    }

    // ---- images and links

    private String imageId(Object src) {
        if (!(src instanceof String s) || s.length() > MAX_URL_CHARS) {
            return null;
        }
        if (s.startsWith("data:")) {
            return DATA_IMAGE.matcher(s).matches() ? context.imageId(s) : null;
        }
        String clean = httpUrl(s);
        return clean == null ? null : context.imageId(clean);
    }

    private static String linkUrl(Object href) {
        return href instanceof String s ? httpUrl(s) : null;
    }

    /** An absolute http or https URL with a host, as ASCII, or null. Clients check it again (T47-6, point 3). */
    static String httpUrl(String s) {
        if (s.isEmpty() || s.length() > MAX_URL_CHARS) {
            return null;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c <= ' ' || c == 0x7F || c == '\\') {
                return null;
            }
            if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                i++;
            } else if (Character.isSurrogate(c)) {
                return null;
            }
        }
        try {
            URI uri = new URI(s);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https") || uri.getHost() == null || uri.getHost().isEmpty()) {
                return null;
            }
            String clean = uri.toASCIIString();
            if (uri.getRawUserInfo() != null) {
                // https://bank.example@evil.example/ is evil.example: the part before the @ never reaches a screen.
                int at = clean.indexOf('@', clean.indexOf("//") + 2);
                clean = clean.substring(0, clean.indexOf("//") + 2) + clean.substring(at + 1);
            }
            return clean;
        } catch (URISyntaxException e) {
            return null;
        }
    }

    // ---- small things

    private static Object at(List<?> list, int index) {
        return index < list.size() ? list.get(index) : null;
    }

    private static int integer(Object raw, int min, int max, int fallback) {
        if (!(raw instanceof Number n)) {
            return fallback;
        }
        double d = n.doubleValue();
        if (Double.isNaN(d)) {
            return fallback;
        }
        return (int) Math.max(min, Math.min(max, Math.round(d)));
    }

    private static boolean truthy(Object raw) {
        return Boolean.TRUE.equals(raw) || raw instanceof Number n && n.intValue() != 0;
    }

    private static void flag(Map<String, Object> run, String name, Object raw) {
        if (raw instanceof Number n) {
            run.put(name, n.intValue() == 1);
        }
    }

    private static Map<String, Object> mapOf(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private static void append(List<Object> out, Object run) {
        if (run instanceof String s) {
            appendText(out, s);
        } else {
            out.add(run);
        }
    }

    private static void appendText(List<Object> out, String text) {
        if (text.isEmpty()) {
            return;
        }
        if (!out.isEmpty() && out.get(out.size() - 1) instanceof String last) {
            out.set(out.size() - 1, last + text);
        } else {
            out.add(text);
        }
    }

    /** Text only at either end, and none of it blank. */
    private static void trim(List<Object> out) {
        if (!out.isEmpty() && out.get(0) instanceof String first) {
            String t = first.stripLeading();
            if (t.isEmpty()) {
                out.remove(0);
            } else {
                out.set(0, t);
            }
        }
        if (!out.isEmpty() && out.get(out.size() - 1) instanceof String last) {
            String t = last.stripTrailing();
            if (t.isEmpty()) {
                out.remove(out.size() - 1);
            } else {
                out.set(out.size() - 1, t);
            }
        }
    }

    // ---- page-level facts (spec section 9): the head's site, hidden, challenge and article

    private static final Set<String> SITE_TAGS = Set.of("search", "sections", "signin", "cart");
    /** Distiller v2's kinds of what it dropped, to the wire's. */
    private static final Map<String, String> HIDDEN_KINDS = Map.ofEntries(
            Map.entry("ad", "ads"), Map.entry("ads", "ads"), Map.entry("consent", "cookie"), Map.entry("cookie", "cookie"),
            Map.entry("newsletter", "newsletter"), Map.entry("promo", "newsletter"), Map.entry("popup", "popup"),
            Map.entry("overlay", "popup"), Map.entry("signin", "popup"), Map.entry("recirc", "recommended"),
            Map.entry("recommended", "recommended"), Map.entry("sponsored", "sponsored"), Map.entry("sponsor", "sponsored"),
            Map.entry("shorts", "shorts"), Map.entry("shelf", "shelves"), Map.entry("shelves", "shelves"),
            Map.entry("rail", "signin"), Map.entry("upsell", "signin"));
    private static final Pattern REJECT = Pattern.compile(
            "(?i)(reject|decline|refuse|deny)( all| all cookies| cookies| optional cookies| non-essential( cookies)?)?|"
                    + "(use |allow )?(only )?(necessary|essential|required)( cookies)?( only)?|continue without accepting");

    private Map<String, Object> facts(String mode) {
        Map<String, Object> facts = new LinkedHashMap<>();
        Map<String, Object> site = site();
        if (site != null) {
            facts.put("site", site);
        }
        Map<String, Object> hidden = hidden();
        if (hidden != null) {
            facts.put("hidden", hidden);
        }
        Map<String, Object> challenge = challenge();
        if (challenge != null) {
            facts.put("challenge", challenge);
        }
        if ("article".equals(mode)) {
            facts.put("article", article());
        }
        Object height = meta.get("doc_h") != null ? meta.get("doc_h") : raw.stats().get("pageHeight");
        if (height instanceof Number) {
            facts.put("pageHeight", integer(height, 0, 10_000_000, 0));
        }
        return facts;
    }

    /** Name, icon, and up to three essential actions, each a node deskd saw, tagged by the distiller. */
    private Map<String, Object> site() {
        Map<String, Object> distilled = meta.get("site") instanceof Map<?, ?> m ? cast(m) : Map.of();
        String name = Text.clean(distilled.get("name"), 80);
        if (name.isEmpty()) {
            name = Text.clean(raw.extras().get("name"), 80);
        }
        Map<String, Object> site = new LinkedHashMap<>();
        if (!name.isEmpty()) {
            site.put("name", name);
        }
        String icon = imageId(raw.extras().get("icon"));
        if (icon != null) {
            site.put("icon", icon);
        }
        // R4: the site's own color, for a letter tile when there's no icon. Only a plain hex color passes.
        if (raw.extras().get("theme") instanceof String theme && theme.matches("#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})")) {
            site.put("themeColor", theme.toLowerCase(Locale.ROOT));
        }
        List<Object> actions = new ArrayList<>();
        if (distilled.get("acts") instanceof List<?> acts) {
            for (Object act : acts) {
                if (actions.size() >= 3 || !(act instanceof List<?> a) || !(at(a, 0) instanceof String tag) || !SITE_TAGS.contains(tag)) {
                    continue;
                }
                Map<String, Object> seen = take(at(a, 1));
                if (seen == null) {
                    continue;
                }
                Map<String, Object> action = new LinkedHashMap<>();
                action.put("tag", tag);
                putNode(action, at(a, 1), seen);
                action.put("label", Text.clean(at(a, 2), 60));
                if (at(a, 3) instanceof Number count) {
                    action.put("count", integer(count, 0, 1_000_000, 0));
                }
                // The site's actions sit in the head, which is their block as far as an act says.
                nodes.put((String) at(a, 1), new MDoc.Node((String) at(a, 1), "site", (String) seen.get("fp"), MDoc.NodeKind.BUTTON, null, null, false));
                actions.add(action);
            }
        }
        if (!actions.isEmpty()) {
            site.put("actions", actions);
        }
        return site.isEmpty() ? null : site;
    }

    /** What was hidden, by kind, and what was done about a consent banner. */
    private Map<String, Object> hidden() {
        Map<String, Object> counts = new LinkedHashMap<>();
        if (meta.get("dropped") instanceof Map<?, ?> dropped) {
            for (Map.Entry<?, ?> entry : dropped.entrySet()) {
                String kind = entry.getKey() instanceof String k ? HIDDEN_KINDS.getOrDefault(k, "other") : "other";
                int n = integer(entry.getValue(), 0, 1_000_000, 0);
                if (n > 0) {
                    counts.merge(kind, n, (a, b) -> (Integer) a + (Integer) b);
                }
            }
        }
        Map<String, Object> hidden = new LinkedHashMap<>();
        hidden.put("counts", counts);
        if (meta.get("trackers") instanceof Number trackers) {
            hidden.put("trackers", integer(trackers, 0, 1_000_000, 0));
        }
        if (counts.containsKey("cookie") || meta.get("consent") instanceof List<?> c && !c.isEmpty()) {
            hidden.put("done", mapOf("cookie", "hidden"));
        }
        return counts.isEmpty() && hidden.size() == 1 ? null : hidden;
    }

    /** A person check, a sign-in wall or a payment page: what the Browser says a line about. */
    private Map<String, Object> challenge() {
        Object said = meta.get("challenge");
        String reason = null;
        if ("cloudflare".equals(said) || "captcha".equals(said) || "person_check".equals(said) || "person-check".equals(said)) {
            reason = "person_check";
        } else if ("signin".equals(said) || "sign_in".equals(said)) {
            reason = "sign_in";
        } else if ("payment".equals(said)) {
            reason = "payment";
        }
        if (reason == null) {
            for (Map<String, Object> signal : raw.signals()) {
                if ("payment".equals(signal.get("kind"))) {
                    reason = "payment";
                    break;
                }
            }
        }
        if (reason == null && personCheck()) {
            reason = "person_check";
        }
        return reason == null ? null : mapOf("reason", reason);
    }

    private void count(String text) {
        textChars += text.length();
        if (shown.length() < ONLY_A_PROMPT * 2) {
            shown.append(' ').append(text);
        }
    }

    /** A view this short is a page that holds little but what's on its screen, so its title and headings say what it is. */
    static final int NEAR_EMPTY = 1500;
    /** A view this short holds nothing but its prompt, if its words are a person check's. */
    static final int ONLY_A_PROMPT = 600;
    /**
     * A person check's words: Cloudflare's interstitials old and new ("Just a moment", "Performing security
     * verification", "Verifying you are human", "needs to review the security of your connection"), Stack Overflow's
     * "Human verification", and the usual bot and CAPTCHA prompts.
     */
    static final Pattern PERSON_CHECK_WORDS = Pattern.compile("\\b(?:just a moment|attention required|one more step"
            + "|human verification|security (?:verification|check)|review the security of your connection"
            + "|verif(?:y|ying|ication)\\b.{0,40}\\b(?:human|person|robot|bot)\\b|(?:human|person|robot|bot)\\b.{0,40}\\bverif(?:y|ication)"
            + "|checking (?:your browser|if the site connection is secure)|are you (?:a )?(?:robot|human|bot)"
            + "|not a (?:ro)?bot|prove you(?:'|\u2019| a)re (?:a )?human|unusual (?:traffic|activity)|press (?:&|and) hold"
            + "|bot (?:check|protection|detection)|captcha)",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    /** A person check's own address on the page's site: Stack Overflow's {@code /nocaptcha}, a {@code /captcha} page. */
    private static final Pattern PERSON_CHECK_PATH = Pattern.compile("(?i)^[a-z]+://[^/]+/(?:[^?#]*/)?(?:no)?captcha(?:[/?#.]|$)");

    /**
     * deskd's own look for a person check, beside the distiller's, which a variant can slip past (Stack Overflow's on a
     * desk's network, simplified into one block). Cloudflare's own interstitial, by its script; then, on a page whose
     * view holds little, its title, a heading, a check's form or a visible check widget; and a view whose only words are
     * a person check's prompt.
     */
    private boolean personCheck() {
        Map<String, Object> seen = raw.stats().get("challenge") instanceof Map<?, ?> m ? cast(m) : Map.of();
        if (textChars > NEAR_EMPTY * 2) {
            return false;
        }
        if (truthy(seen.get("cf"))) {
            return true;
        }
        if (textChars > NEAR_EMPTY) {
            return false;
        }
        if (truthy(seen.get("form")) || truthy(seen.get("widget")) || PERSON_CHECK_PATH.matcher(url).find()
                || PERSON_CHECK_WORDS.matcher(title).find()) {
            return true;
        }
        if (seen.get("heads") instanceof List<?> heads) {
            for (Object head : heads) {
                if (head instanceof String text && PERSON_CHECK_WORDS.matcher(Text.clean(text, 120)).find()) {
                    return true;
                }
            }
        }
        return textChars <= ONLY_A_PROMPT && PERSON_CHECK_WORDS.matcher(shown).find();
    }

    /** Kicker, bylines, date, read time and lead image, from the distiller, then the page's JSON-LD, then its meta tags. */
    private Map<String, Object> article() {
        Map<String, Object> distilled = meta.get("article") instanceof Map<?, ?> m ? cast(m) : Map.of();
        Map<String, Object> tags = raw.extras().get("article") instanceof Map<?, ?> m ? cast(m) : Map.of();
        Map<String, Object> ld = firstLd("NewsArticle", "Article", "BlogPosting", "ReportageNewsArticle");
        Map<String, Object> article = new LinkedHashMap<>();
        String kicker = first(Text.clean(distilled.get("kicker"), 60), ld == null ? "" : Text.clean(ld.get("articleSection"), 60),
                Text.clean(tags.get("kicker"), 60));
        if (!kicker.isEmpty()) {
            article.put("kicker", kicker);
        }
        List<Object> byline = names(distilled.get("byline"));
        if (byline.isEmpty() && ld != null) {
            byline = names(ld.get("author"));
        }
        if (byline.isEmpty()) {
            byline = names(tags.get("byline"));
        }
        if (!byline.isEmpty()) {
            article.put("byline", byline);
        }
        String date = first(Text.clean(distilled.get("date"), 40), ld == null ? "" : Text.clean(ld.get("datePublished"), 40),
                Text.clean(tags.get("date"), 40));
        if (!date.isEmpty()) {
            article.put("date", date);
        }
        // 230 words a minute, at about six characters a word.
        article.put("readMinutes", Math.max(1, Math.round(textChars / 6.0 / 230)));
        if (distilled.get("lead") instanceof Map<?, ?> lead) {
            String id = imageId(lead.get("s"));
            if (id != null) {
                Map<String, Object> image = new LinkedHashMap<>();
                image.put("image", id);
                image.put("width", integer(lead.get("w"), 0, 20_000, 0));
                image.put("height", integer(lead.get("h"), 0, 20_000, 0));
                putText(image, "caption", lead.get("cap"), 300);
                putText(image, "credit", lead.get("credit"), 120);
                article.put("lead", image);
            }
        }
        return article;
    }

    private List<Object> names(Object raw) {
        List<Object> names = new ArrayList<>();
        List<?> list = raw instanceof List<?> l ? l : raw == null ? List.of() : List.of(raw);
        for (Object item : list) {
            Object name = item instanceof Map<?, ?> person ? person.get("name") : item;
            String text = Text.clean(name, 80);
            if (!text.isEmpty() && !text.startsWith("http") && names.size() < 5 && !names.contains(text)) {
                names.add(text);
            }
        }
        return names;
    }

    private static String first(String... texts) {
        for (String text : texts) {
            if (!text.isEmpty()) {
                return text;
            }
        }
        return "";
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Map<?, ?> map) {
        return (Map<String, Object>) map;
    }

    /** The first of the page's JSON-LD objects with one of these types. */
    private Map<String, Object> firstLd(String... types) {
        if (!(raw.extras().get("ld") instanceof List<?> list)) {
            return null;
        }
        for (Object item : list) {
            if (item instanceof Map<?, ?> object) {
                Object type = object.get("@type");
                List<?> typeList = type instanceof List<?> l ? l : List.of(String.valueOf(type));
                for (String wanted : types) {
                    if (typeList.contains(wanted)) {
                        return cast(object);
                    }
                }
            }
        }
        return null;
    }

    /**
     * The page's own structured data (spec section 9): a Recipe, Product, QAPage or VideoObject, each field by name and
     * bounded, with {@code fold}, the index of the first block after the story that comes before a recipe.
     *
     * @param at where this block will go
     */
    private Map<String, Object> structured(int at) {
        Map<String, Object> ld = firstLd("Recipe", "Product", "QAPage", "VideoObject");
        if (ld == null) {
            return null;
        }
        Object type = ld.get("@type");
        List<?> types = type instanceof List<?> l ? l : List.of(String.valueOf(type));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("t", "structured");
        Map<String, Object> data = new LinkedHashMap<>();
        if (types.contains("Recipe")) {
            out.put("type", "recipe");
            putText(data, "name", ld.get("name"), 200);
            putText(data, "description", ld.get("description"), 500);
            putText(data, "yield", ld.get("recipeYield") instanceof List<?> y && !y.isEmpty() ? y.get(0) : ld.get("recipeYield"), 60);
            putText(data, "totalTime", ld.get("totalTime"), 20);
            putText(data, "prepTime", ld.get("prepTime"), 20);
            putText(data, "cookTime", ld.get("cookTime"), 20);
            putTexts(data, "ingredients", ld.get("recipeIngredient"), 100, 200);
            data.put("steps", steps(ld.get("recipeInstructions")));
            putRating(data, ld.get("aggregateRating"));
            if (ld.get("nutrition") instanceof Map<?, ?> nutrition) {
                putText(data, "calories", nutrition.get("calories"), 40);
            }
            Integer fold = fold(data.get("ingredients"));
            if (fold != null) {
                out.put("fold", fold + at + 1);
            }
        } else if (types.contains("Product")) {
            out.put("type", "product");
            putText(data, "name", ld.get("name"), 200);
            putText(data, "description", ld.get("description"), 500);
            if (ld.get("brand") instanceof Map<?, ?> brand) {
                putText(data, "brand", brand.get("name"), 80);
            } else {
                putText(data, "brand", ld.get("brand"), 80);
            }
            Object offers = ld.get("offers") instanceof List<?> list && !list.isEmpty() ? list.get(0) : ld.get("offers");
            if (offers instanceof Map<?, ?> offer) {
                putText(data, "price", offer.get("price") != null ? offer.get("price") : offer.get("lowPrice"), 32);
                putText(data, "currency", offer.get("priceCurrency"), 8);
                String availability = Text.clean(offer.get("availability"), 80);
                if (!availability.isEmpty()) {
                    data.put("availability", availability.substring(availability.lastIndexOf('/') + 1));
                }
            }
            putRating(data, ld.get("aggregateRating"));
        } else if (types.contains("QAPage")) {
            out.put("type", "qa");
            if (ld.get("mainEntity") instanceof Map<?, ?> question) {
                putText(data, "question", question.get("name"), 300);
                putText(data, "text", question.get("text"), 2000);
                putText(data, "answerCount", question.get("answerCount"), 10);
                if (question.get("acceptedAnswer") instanceof Map<?, ?> accepted) {
                    putText(data, "accepted", accepted.get("text"), 4000);
                }
                List<Object> suggested = new ArrayList<>();
                List<?> answers = question.get("suggestedAnswer") instanceof List<?> l ? l : List.of();
                for (Object answer : answers) {
                    if (answer instanceof Map<?, ?> a && suggested.size() < 5) {
                        String text = Text.clean(a.get("text"), 4000);
                        if (!text.isEmpty()) {
                            suggested.add(mapOf("text", text, "votes", integer(a.get("upvoteCount"), -1_000_000, 1_000_000, 0)));
                        }
                    }
                }
                if (!suggested.isEmpty()) {
                    data.put("suggested", suggested);
                }
            }
        } else {
            out.put("type", "video");
            putText(data, "name", ld.get("name"), 200);
            putText(data, "description", ld.get("description"), 500);
            putText(data, "duration", ld.get("duration"), 20);
            putText(data, "uploaded", ld.get("uploadDate"), 40);
        }
        out.put("data", data);
        return out;
    }

    private List<Object> steps(Object raw) {
        List<Object> steps = new ArrayList<>();
        List<Object> stack = new ArrayList<>();
        if (raw instanceof List<?> list) {
            stack.addAll(list);
        } else if (raw != null) {
            stack.add(raw);
        }
        for (int i = 0; i < stack.size() && steps.size() < 100 && i < 500; i++) {
            Object item = stack.get(i);
            if (item instanceof String text) {
                String clean = Text.clean(text, 1000);
                if (!clean.isEmpty()) {
                    steps.add(clean);
                }
            } else if (item instanceof Map<?, ?> step) {
                if (step.get("itemListElement") instanceof List<?> inner) {
                    stack.addAll(i + 1, inner);
                } else {
                    String clean = Text.clean(step.get("text") != null ? step.get("text") : step.get("name"), 1000);
                    if (!clean.isEmpty()) {
                        steps.add(clean);
                    }
                }
            }
        }
        return steps;
    }

    private static void putRating(Map<String, Object> data, Object raw) {
        if (raw instanceof Map<?, ?> rating) {
            putText(data, "rating", rating.get("ratingValue"), 8);
            putText(data, "ratings", rating.get("ratingCount") != null ? rating.get("ratingCount") : rating.get("reviewCount"), 12);
        }
    }

    /** The first block that's the recipe itself: a heading for its ingredients or method, or a block naming its first ingredient. */
    private Integer fold(Object ingredients) {
        String firstIngredient = ingredients instanceof List<?> list && !list.isEmpty() ? String.valueOf(list.get(0)).toLowerCase(Locale.ROOT) : null;
        Pattern heading = Pattern.compile("(?i).*\\b(ingredients|directions|instructions|method|steps)\\b.*");
        for (int i = 0; i < blocks.size(); i++) {
            Map<String, Object> block = blocks.get(i);
            String text = plain(block.get("runs"));
            if ("heading".equals(block.get("t")) && heading.matcher(text).matches()) {
                return i;
            }
            if (firstIngredient != null && firstIngredient.length() >= 6 && text.toLowerCase(Locale.ROOT).contains(firstIngredient)) {
                return i;
            }
        }
        return null;
    }

    private static String plain(Object runs) {
        StringBuilder text = new StringBuilder();
        if (runs instanceof List<?> list) {
            for (Object run : list) {
                if (run instanceof String s) {
                    text.append(s);
                } else if (run instanceof Map<?, ?> m) {
                    text.append(plain(m.get("runs")));
                }
            }
        }
        return text.toString();
    }

    /** A consent banner's reject button, exactly labeled, that deskd saw: what deskd may press behind its flag. */
    private MDoc.Consent consent() {
        if (!(meta.get("consent") instanceof List<?> banners)) {
            return null;
        }
        for (Object banner : banners) {
            if (banner instanceof Map<?, ?> b && b.get("reject") instanceof Map<?, ?> reject) {
                Object ref = reject.get("ref");
                String label = Text.clean(reject.get("label"), 80);
                Map<String, Object> seen = nodeSeen(ref);
                // deskd's half confirmed the banner itself (cb), whatever the distiller called it (Security's Ask 1).
                if (seen != null && REJECT.matcher(label).matches() && seen.get("fp") instanceof String fp && FP.matcher(fp).matches()
                        && sensitiveRef(ref, seen) == null && integer(seen.get("cb"), 0, 1, 0) == 1) {
                    return new MDoc.Consent((String) ref, fp, label);
                }
            }
        }
        return null;
    }

    // ---- the confidence check (design 7.4)

    /**
     * Whether the stream would serve this page better. The thresholds are a first guess, to be set by the 7.8 real-site
     * test: content alone, never the site's name, decides. A page still loading is never judged to have too little.
     */
    Fallback judge(MDoc doc) {
        Map<String, Object> stats = raw.stats();
        int status = integer(stats.get("status"), 0, 999, 0);
        if (status == 401 || status == 407) {
            return Fallback.HTTP_AUTH;
        }
        // T47X-3: the distiller's own scan threw (a page can make it), so nothing it decided about the page holds.
        if (meta.get("scan_err") != null) {
            return Fallback.DISTILLER_ERROR;
        }
        // A bot check, a sign-in page or a checkout: only the member gets through it, on the real page.
        if (challengeCause(doc) != null) {
            return Fallback.CHALLENGE;
        }
        if (status >= 400) {
            return Fallback.HTTP_ERROR;
        }
        if (stats.get("wall") instanceof Map<?, ?> wall && "terms".equals(wall.get("kind"))
                || "terms".equals(meta.get("challenge")) || meta.get("wall") instanceof Map<?, ?> said && "terms".equals(said.get("kind"))) {
            return Fallback.TERMS_WALL;
        }
        if (fraction(stats.get("canvasCover")) >= 0.5) {
            return Fallback.CANVAS_APP;
        }
        if (fraction(stats.get("frameCover")) >= 0.4) {
            return Fallback.CROSS_ORIGIN_FRAMES;
        }
        if (raw.loading()) {
            return null;
        }
        Map<String, Integer> kept = runCounts(doc.blocks);
        // The distiller's own word that the page is a small app (a to-do list, a converter) wins.
        if (truthy(meta.get("app")) && doc.islands.isEmpty()) {
            return Fallback.APP;
        }
        // An app: a few controls the page draws itself, something to type in that isn't a search, and little to read.
        if ("page".equals(doc.kind) && doc.textChars < 300 && kept.getOrDefault("plainField", 0) > 0 && doc.islands.isEmpty()) {
            return Fallback.APP;
        }
        if (doc.textChars < 80 && doc.controls < 2 && doc.islands.isEmpty()) {
            return Fallback.LOW_CONFIDENCE;
        }
        // A form the view can't complete: the page's typing and picking fields, against those the view kept. Buttons and
        // boxes don't count: the distiller folds filter rails and drops a page's widgets on purpose (Amazon, IKEA).
        int pageFields = integer(stats.get("textFields"), 0, 1_000_000, 0);
        int docFields = kept.getOrDefault("field", 0) + kept.getOrDefault("select", 0) + kept.getOrDefault("sensitive", 0);
        if ("page".equals(doc.kind) && pageFields >= 4 && docFields * 2 < pageFields) {
            return Fallback.LOW_CONFIDENCE;
        }
        return null;
    }

    /** How many runs of each kind the document holds, and {@code plainField}: fields to type in that aren't a search. */
    private static Map<String, Integer> runCounts(List<Map<String, Object>> blocks) {
        Map<String, Integer> counts = new HashMap<>();
        java.util.ArrayDeque<Object> todo = new java.util.ArrayDeque<>(blocks);
        while (!todo.isEmpty()) {
            Object next = todo.pop();
            if (next instanceof Map<?, ?> map) {
                if (map.get("r") instanceof String r) {
                    counts.merge(r, 1, Integer::sum);
                    if ("field".equals(r) && ("plain".equals(map.get("kind")) || "multiline".equals(map.get("kind")))) {
                        counts.merge("plainField", 1, Integer::sum);
                    }
                }
                map.values().forEach(v -> {
                    if (v instanceof Map<?, ?> || v instanceof List<?>) {
                        todo.push(v);
                    }
                });
            } else if (next instanceof List<?> list) {
                list.forEach(v -> {
                    if (v instanceof Map<?, ?> || v instanceof List<?>) {
                        todo.push(v);
                    }
                });
            }
        }
        return counts;
    }

    /** The head's challenge as a challenge's cause, or null. */
    private static Fallback challengeCause(MDoc doc) {
        if (!(doc.facts.get("challenge") instanceof Map<?, ?> challenge)) {
            return null;
        }
        return switch (String.valueOf(challenge.get("reason"))) {
            case "person_check" -> Fallback.PERSON_CHECK;
            case "sign_in" -> Fallback.SIGN_IN;
            case "payment" -> Fallback.PAYMENT;
            default -> null;
        };
    }

    private static double fraction(Object raw) {
        return raw instanceof Number n && !Double.isNaN(n.doubleValue()) ? Math.max(0, Math.min(1, n.doubleValue())) : 0;
    }
}
