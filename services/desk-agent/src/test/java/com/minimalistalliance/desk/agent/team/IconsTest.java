package com.minimalistalliance.desk.agent.team;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** An agent's own icon: uploaded as a PNG, kept as a mask, and replaced by a library icon ({@code multi-agent.md} 7). */
class IconsTest {

    @TempDir
    Path data;

    private TeamDesk desk;
    private String id;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data);
        id = desk.agent("Painter");
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    /** A small PNG made by ImageIO: a quarter left transparent when {@code alpha}, else a disk on white. */
    static byte[] png(int width, int height, boolean alpha) {
        BufferedImage image = new BufferedImage(width, height,
                alpha ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                boolean corner = x < width / 2 && y < height / 2;
                boolean disk = Math.hypot(x - width / 2.0, y - height / 2.0) <= width * 0.4;
                int argb = alpha ? (corner ? 0x00000000 : 0xFF3366CC) : (disk ? 0xFF3366CC : 0xFFFFFFFF);
                image.setRGB(x, y, argb);
            }
        }
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            ImageIO.write(image, "png", out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A whole policy for {@code agent.limits.set}: no caps, this many steps a run. */
    static Map<String, Object> policy(int runMaxSteps) {
        Map<String, Object> none = new LinkedHashMap<>();
        none.put("maxMicroUsd", null);
        none.put("maxTokens", null);
        Map<String, Object> p = new LinkedHashMap<>();
        for (String scope : List.of("agentDay", "agentWeek", "agentMonth", "keyMonth", "run")) {
            p.put(scope, new LinkedHashMap<>(none));
        }
        p.put("runMaxSteps", runMaxSteps);
        return p;
    }

    private static String base64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    /** The chunk types of a PNG, in order. */
    private static List<String> chunks(byte[] png) {
        ByteBuffer buffer = ByteBuffer.wrap(png);
        buffer.position(8);
        List<String> types = new ArrayList<>();
        while (buffer.remaining() >= 12) {
            int length = buffer.getInt();
            byte[] type = new byte[4];
            buffer.get(type);
            types.add(new String(type, StandardCharsets.US_ASCII));
            buffer.position(buffer.position() + length + 4);
        }
        return types;
    }

    private RpcError badPng(String png) {
        RpcError e = desk.refused("agent.icon.upload", "agentId", id, "png", png);
        assertThat(e.code()).isEqualTo("bad_request");
        assertThat(e.details()).containsEntry("detail", "png");
        return e;
    }

    @Test
    void anUploadedPngBecomesTheLook() throws Exception {
        Map<String, Object> agent = map(desk.call("agent.icon.upload", "agentId", id, "png",
                base64(png(16, 16, true))).get("agent"));

        assertThat(map(agent.get("look"))).containsEntry("icon", "png").containsEntry("png", 1);
        assertThat(map(desk.agentView(id).get("look"))).containsEntry("icon", "png").containsEntry("png", 1);
        assertThat(data.resolve("icons").resolve(id + ".png")).isRegularFile();

        Map<String, Object> second = map(desk.call("agent.icon.upload", "agentId", id, "png",
                base64(png(24, 24, false))).get("agent"));
        assertThat(map(second.get("look"))).as("a counter, so a client refetches").containsEntry("png", 2);
    }

    @Test
    void whatIsKeptIsAMaskWithOnlyTheThreeChunks() throws Exception {
        desk.call("agent.icon.upload", "agentId", id, "png", base64(png(16, 16, true)));

        Map<String, Object> got = desk.call("agent.icon.get", "agentId", id);

        assertThat(got).containsEntry("version", 1);
        byte[] png = Base64.getDecoder().decode((String) got.get("png"));
        assertThat(png).startsWith((byte) 0x89, (byte) 'P', (byte) 'N', (byte) 'G');
        assertThat(chunks(png)).first().isEqualTo("IHDR");
        assertThat(chunks(png)).last().isEqualTo("IEND");
        assertThat(chunks(png)).allMatch(type -> type.equals("IHDR") || type.equals("IDAT") || type.equals("IEND"));
        BufferedImage mask = ImageIO.read(new java.io.ByteArrayInputStream(png));
        // Trimmed to the shape and centred in a square with an 8% margin: 16 px of shape in 20.
        assertThat(mask.getWidth()).isEqualTo(20);
        assertThat(mask.getHeight()).isEqualTo(20);
        assertThat(mask.getRGB(0, 0) >>> 24).as("the margin is clear").isZero();
        assertThat(mask.getRGB(2, 2) >>> 24).as("the transparent corner stays transparent").isZero();
        assertThat(mask.getRGB(17, 17) >>> 24).as("the rest is opaque").isEqualTo(255);
        assertThat(mask.getRGB(17, 17) & 0xFFFFFF).as("white: only the shape is kept").isEqualTo(0xFFFFFF);
    }

    @Test
    void aPictureWithMetadataKeepsNoneOfIt() throws Exception {
        byte[] plain = png(8, 8, true);
        byte[] withText = withTextChunk(plain);
        assertThat(chunks(withText)).contains("tEXt");

        desk.call("agent.icon.upload", "agentId", id, "png", base64(withText));

        byte[] kept = Base64.getDecoder().decode((String) desk.call("agent.icon.get", "agentId", id).get("png"));
        assertThat(chunks(kept)).doesNotContain("tEXt");
        assertThat(new String(kept, StandardCharsets.ISO_8859_1)).doesNotContain("secret-comment");
    }

    /** Puts a tEXt chunk after IHDR. */
    private static byte[] withTextChunk(byte[] png) {
        byte[] data = "Comment\0secret-comment".getBytes(StandardCharsets.ISO_8859_1);
        byte[] type = "tEXt".getBytes(StandardCharsets.US_ASCII);
        java.util.zip.CRC32 crc = new java.util.zip.CRC32();
        crc.update(type);
        crc.update(data);
        ByteBuffer chunk = ByteBuffer.allocate(12 + data.length);
        chunk.putInt(data.length).put(type).put(data).putInt((int) crc.getValue());
        int afterIhdr = 8 + 12 + 13;
        ByteBuffer out = ByteBuffer.allocate(png.length + chunk.capacity());
        out.put(png, 0, afterIhdr).put(chunk.array()).put(png, afterIhdr, png.length - afterIhdr);
        return out.array();
    }

    @Test
    void notAPngIsRefusedWithItsReason() throws Exception {
        assertThat(badPng(base64("hello, I am not a picture".getBytes(StandardCharsets.UTF_8))).details())
                .containsEntry("reason", "not_png");
        assertThat(badPng("***not base64***").details()).containsEntry("reason", "not_png");
        assertThat(badPng("").details()).containsEntry("reason", "not_png");
        assertThat(desk.refused("agent.get", "agentId", "ag-nope").code()).isEqualTo("not_found");
        assertThat(map(desk.agentView(id).get("look"))).containsEntry("png", null);
    }

    @Test
    void aCorruptOrOversizedPngIsRefused() throws Exception {
        byte[] good = png(8, 8, true);
        byte[] corrupt = good.clone();
        corrupt[corrupt.length - 20] ^= 0x55;
        assertThat(badPng(base64(corrupt)).details()).containsEntry("reason", "corrupt");

        assertThat(badPng(base64(png(513, 8, true))).details()).containsEntry("reason", "too_many_pixels");

        assertThat(badPng("A".repeat(400_000)).details()).containsEntry("reason", "too_large");
    }

    @Test
    void aPictureWithNoShapeOrOnlyHairlinesIsRefusedWithItsReason() throws Exception {
        BufferedImage blank = new BufferedImage(32, 32, BufferedImage.TYPE_INT_ARGB); // all clear
        assertThat(badPng(base64(write(blank))).details()).containsEntry("reason", "no_shape");
        BufferedImage hair = new BufferedImage(200, 200, BufferedImage.TYPE_INT_ARGB);
        for (int i = 20; i < 180; i++) {
            hair.setRGB(i, 100, 0xFF000000);
            hair.setRGB(100, i, 0xFF000000);
        }
        assertThat(badPng(base64(write(hair))).details()).containsEntry("reason", "too_thin");
        assertThat(map(desk.agentView(id).get("look"))).containsEntry("png", null);
        assertThat(desk.audit.readBefore(null, 100)).anyMatch(r -> r.entry().action().equals("icon.upload")
                && r.entry().decision().contains("no_shape"));
    }

    private static byte[] write(BufferedImage image) throws IOException {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            ImageIO.write(image, "png", out);
            return out.toByteArray();
        }
    }

    @Test
    void aLibraryIconPutsTheUploadAway() throws Exception {
        desk.call("agent.icon.upload", "agentId", id, "png", base64(png(8, 8, true)));
        assertThat(data.resolve("icons").resolve(id + ".png")).exists();

        Map<String, Object> agent = map(desk.call("agent.update", "agentId", id, "icon", "leaf").get("agent"));

        assertThat(map(agent.get("look"))).containsEntry("icon", "leaf").containsEntry("png", null);
        RpcError gone = desk.refused("agent.icon.get", "agentId", id);
        assertThat(gone.code()).isEqualTo("not_found");
        assertThat(gone.details()).containsEntry("detail", "icon");
        assertThat(data.resolve("icons").resolve(id + ".png")).doesNotExist();
    }

    @Test
    void deletingTheAgentRemovesItsIconFileAndAnAgentWithoutOneHasNone() throws Exception {
        assertThat(desk.refused("agent.icon.get", "agentId", id).code()).isEqualTo("not_found");
        desk.call("agent.icon.upload", "agentId", id, "png", base64(png(8, 8, true)));

        desk.call("agent.delete", "agentId", id);

        assertThat(data.resolve("icons").resolve(id + ".png")).doesNotExist();
        assertThat(desk.refused("agent.icon.upload", "agentId", id, "png", base64(png(8, 8, true))).code())
                .isEqualTo("not_found");
    }
}
