package com.minimalistalliance.desk.deskd.browser.minified;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Not a test: distiller v2's saved output (the prototype's run, {@code PNN.mdoc.json} in the prototype's raw shape) run
 * through deskd's own {@link MDocBuilder}, with a stand-in for deskd's in-page half that saw every control and media
 * element and no sensitive field. It isolates the builder: what deskd keeps and drops of v2's blocks. Each page's bare
 * MDoc goes to {@code MINIFIED_RUN_OUT}, with v2's own sidecar ({@code PNN.detail.json}: the fallback, island and heights
 * the bare document doesn't carry) copied beside it. Runs only when asked for by name
 * ({@code services/deskd/real-sites/README.md}).
 */
@EnabledIfEnvironmentVariable(named = "MINIFIED_V2_IN", matches = ".+")
@EnabledIfEnvironmentVariable(named = "MINIFIED_RUN_OUT", matches = ".+")
class MinifiedV2Replay {

    /** What a document's builds share, as the module keeps it. */
    private static final class Context implements MDocBuilder.Context {
        private final Map<String, String> images = new LinkedHashMap<>();

        @Override
        public String imageId(String url) {
            return images.computeIfAbsent(url, u -> "i1." + Integer.toString(images.size() + 1, 36));
        }

        @Override
        public boolean wasSensitive(String ref) {
            return false;
        }

        @Override
        public void markSensitive(String ref) {}
    }

    @Test
    @SuppressWarnings("unchecked")
    void replay() throws Exception {
        Path in = Path.of(System.getenv("MINIFIED_V2_IN"));
        Path out = Path.of(System.getenv("MINIFIED_RUN_OUT"));
        Files.createDirectories(out);
        try (var files = Files.list(in)) {
            for (Path file : files.filter(p -> p.getFileName().toString().matches("P\\d+\\.mdoc\\.json")).sorted().toList()) {
                String id = file.getFileName().toString().substring(0, file.getFileName().toString().indexOf('.'));
                Map<String, Object> v2 = Json.parseObject(Files.readAllBytes(file));
                Map<String, Object> meta = v2.get("meta") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
                List<Object> blocks = v2.get("blocks") instanceof List<?> b ? (List<Object>) b : List.of();
                Map<String, Map<String, Object>> nodes = new HashMap<>();
                List<Map<String, Object>> media = new ArrayList<>();
                StringBuilder text = new StringBuilder(new String(Json.bytes(meta), StandardCharsets.UTF_8));
                for (Object block : blocks) {
                    seeAll(block, nodes, media);
                    text.append("\nh\t").append(new String(Json.bytes(block), StandardCharsets.UTF_8));
                }
                MDocBuilder.Raw raw = new MDocBuilder.Raw(text.toString(), nodes, Map.of(), media, List.of(),
                        Map.of("ready", String.valueOf(meta.getOrDefault("ready", "complete"))), Map.of(), 1);
                String url = String.valueOf(meta.getOrDefault("url", "https://example.com/"));
                MDocBuilder.Built built = MDocBuilder.build("T" + id, url, String.valueOf(meta.getOrDefault("title", "")), raw, new Context());
                Files.write(out.resolve(id + ".mdoc.json"), LocationBlank.blank(Json.bytes(built.doc().withRev(1).wire())));
                Path side = in.resolve(id + ".detail.json");
                if (Files.exists(side)) {
                    Files.copy(side, out.resolve(id + ".detail.json"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                System.out.println(id + " " + built.doc().blocks.size() + " blocks"
                        + (built.fallback() == null ? "" : ", deskd's own check: " + built.fallback().wire()));
            }
        }
    }

    /** The stand-in for deskd's half: every ref a control, every media block found, nothing sensitive. */
    @SuppressWarnings("unchecked")
    private static void seeAll(Object tree, Map<String, Map<String, Object>> nodes, List<Map<String, Object>> media) {
        if (tree instanceof List<?> list) {
            if (!list.isEmpty() && list.get(0) instanceof String kind && List.of("a", "btn", "in", "ta", "sel").contains(kind)
                    && list.size() > 1 && list.get(1) instanceof String ref && !ref.isEmpty()) {
                nodes.putIfAbsent(ref, new HashMap<>(Map.of("fp", fp(ref))));
            }
            list.forEach(x -> seeAll(x, nodes, media));
        } else if (tree instanceof Map<?, ?> map) {
            Map<String, Object> block = (Map<String, Object>) map;
            if ("media".equals(block.get("k"))) {
                Map<String, Object> seen = new HashMap<>();
                seen.put("m", block.get("m"));
                seen.put("w", block.get("w"));
                seen.put("h", block.get("h"));
                seen.put("island", "v" + Integer.toString(media.size() + 1, 36) + ".1");
                seen.put("fp", fp("media" + media.size()));
                seen.put("video", Boolean.TRUE.equals(block.get("island")));
                seen.put("paused", true);
                media.add(seen);
            }
            for (Map.Entry<String, Object> entry : block.entrySet()) {
                if (entry.getKey().equals("r") && entry.getValue() instanceof String ref && !ref.isEmpty()) {
                    nodes.putIfAbsent(ref, new HashMap<>(Map.of("fp", fp(ref))));
                }
                seeAll(entry.getValue(), nodes, media);
            }
        }
    }

    private static String fp(String ref) {
        return Long.toString(Integer.toUnsignedLong(ref.hashCode()), 36);
    }
}
