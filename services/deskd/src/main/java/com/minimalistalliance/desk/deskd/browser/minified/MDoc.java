package com.minimalistalliance.desk.deskd.browser.minified;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One simplified page, as clients get it (API.md section 14): a typed tree that's only ever built by
 * {@link MDocBuilder}, field by field, from the distiller's untrusted output. It never holds site HTML, script, style,
 * class or id, and never an image's URL. Immutable.
 */
final class MDoc {

    static final int VERSION = 1;
    /** The whole document as JSON, under a RES's 1 MiB with room for the rest of the reply. */
    static final int MAX_BYTES = 512 * 1024;
    /** A patch event, under an EVT's 64 KiB with room for its envelope. */
    static final int MAX_PATCH_BYTES = 60 * 1024;

    enum NodeKind {
        LINK,
        BUTTON,
        FIELD,
        CHECK,
        SELECT
    }

    /**
     * A control the member may act on, as they saw it.
     *
     * @param block the key of the block it's in
     * @param fp the fingerprint of what the page showed of it ({@code proxy.js}'s {@code see})
     * @param fieldKind for a field, its kind on the wire
     * @param options for a select, its options' labels as sent
     * @param multiple a select of several
     */
    record Node(String id, String block, String fp, NodeKind kind, String fieldKind, List<String> options, boolean multiple) {}

    /** A live view of part of the real page, by deskd's own id, with the fingerprint of what it showed. */
    record Island(String id, String block, String kind, String fp) {}

    /** A consent banner's reject button, exactly labeled, that deskd may press for the member behind its flag. */
    record Consent(String node, String fp, String label) {}

    final String tabId;
    final long rev;
    final String url;
    final String origin;
    final String title;
    final String kind;
    final boolean sensitive;
    final boolean truncated;
    final boolean loading;
    final List<Map<String, Object>> blocks;
    final List<String> keys;
    final Map<String, Node> nodes;
    final Map<String, Island> islands;
    /** The head's page-level facts: site, hidden, challenge, article. */
    final Map<String, Object> facts;
    /** Never sent: what deskd may press, behind its flag. */
    final Consent consent;
    /** For the confidence check: characters of text, controls, and those of them that are form controls. */
    final int textChars;
    final int controls;
    final int formControls;
    final int bytes;

    MDoc(
            String tabId,
            long rev,
            String url,
            String origin,
            String title,
            String kind,
            boolean sensitive,
            boolean truncated,
            boolean loading,
            List<Map<String, Object>> blocks,
            Map<String, Node> nodes,
            Map<String, Island> islands,
            Map<String, Object> facts,
            Consent consent,
            int textChars,
            int controls,
            int formControls,
            int bytes) {
        this.tabId = tabId;
        this.rev = rev;
        this.url = url;
        this.origin = origin;
        this.title = title;
        this.kind = kind;
        this.sensitive = sensitive;
        this.truncated = truncated;
        this.loading = loading;
        this.blocks = List.copyOf(blocks);
        List<String> keyList = new ArrayList<>(blocks.size());
        for (Map<String, Object> block : blocks) {
            keyList.add((String) block.get("key"));
        }
        this.keys = List.copyOf(keyList);
        this.nodes = Map.copyOf(nodes);
        this.islands = Map.copyOf(islands);
        this.facts = Map.copyOf(facts);
        this.consent = consent;
        this.textChars = textChars;
        this.controls = controls;
        this.formControls = formControls;
        this.bytes = bytes;
    }

    MDoc withRev(long newRev) {
        return new MDoc(tabId, newRev, url, origin, title, kind, sensitive, truncated, loading, blocks, nodes, islands,
                facts, consent, textChars, controls, formControls, bytes);
    }

    /** As sensitive, which only ever goes one way. */
    MDoc asSensitive() {
        return sensitive ? this : new MDoc(tabId, rev, url, origin, title, kind, true, truncated, loading, blocks, nodes, islands,
                facts, consent, textChars, controls, formControls, bytes);
    }

    /** With one page-level fact changed, as deskd's own press of a banner's reject does to {@code hidden}. */
    MDoc withFact(String name, Object value) {
        Map<String, Object> changed = new LinkedHashMap<>(facts);
        changed.put(name, value);
        return new MDoc(tabId, rev, url, origin, title, kind, sensitive, truncated, loading, blocks, nodes, islands,
                changed, consent, textChars, controls, formControls, bytes);
    }

    /** Whether a client would see any difference, rev aside. */
    boolean sameAs(MDoc other) {
        return other != null
                && keys.equals(other.keys)
                && url.equals(other.url)
                && title.equals(other.title)
                && kind.equals(other.kind)
                && sensitive == other.sensitive
                && truncated == other.truncated
                && loading == other.loading
                && facts.equals(other.facts);
    }

    Map<String, Object> head() {
        Map<String, Object> head = new LinkedHashMap<>();
        head.put("v", VERSION);
        head.put("tabId", tabId);
        head.put("rev", rev);
        head.put("url", url);
        if (origin != null) {
            head.put("origin", origin);
        }
        head.put("title", title);
        head.put("kind", kind);
        head.put("sensitive", sensitive);
        head.put("truncated", truncated);
        head.put("loading", loading);
        for (String name : List.of("site", "hidden", "challenge", "article", "pageHeight")) {
            if (facts.containsKey(name)) {
                head.put(name, facts.get(name));
            }
        }
        return head;
    }

    Map<String, Object> wire() {
        Map<String, Object> wire = head();
        wire.put("blocks", blocks);
        return wire;
    }

    /**
     * What takes a client from {@code base} to this: one splice of blocks, between what they still share at either end.
     *
     * @return the patch, or null if it wouldn't fit one event
     */
    Map<String, Object> patchFrom(MDoc base) {
        int prefix = 0;
        int max = Math.min(base.keys.size(), keys.size());
        while (prefix < max && base.keys.get(prefix).equals(keys.get(prefix))) {
            prefix++;
        }
        int suffix = 0;
        while (suffix < max - prefix
                && base.keys.get(base.keys.size() - 1 - suffix).equals(keys.get(keys.size() - 1 - suffix))) {
            suffix++;
        }
        List<Map<String, Object>> insert = blocks.subList(prefix, blocks.size() - suffix);
        Map<String, Object> patch = new LinkedHashMap<>();
        patch.put("tabId", tabId);
        patch.put("base", base.rev);
        patch.put("rev", rev);
        patch.put("at", prefix);
        patch.put("remove", base.keys.size() - prefix - suffix);
        patch.put("insert", insert);
        patch.put("head", head());
        return Json.bytes(patch).length <= MAX_PATCH_BYTES ? patch : null;
    }
}
