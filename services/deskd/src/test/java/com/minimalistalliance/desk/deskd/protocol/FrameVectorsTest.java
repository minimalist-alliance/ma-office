package com.minimalistalliance.desk.deskd.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Checks the codec against frames/vectors.json, the bytes the TypeScript client tests against too.
 * The vectors were written from the design's layout by a separate script, not by this codec.
 */
class FrameVectorsTest {

    private static Map<String, Object> vectors;

    @BeforeAll
    static void load() throws IOException, JsonFormatException {
        try (InputStream in = FrameVectorsTest.class.getResourceAsStream("/frames/vectors.json")) {
            vectors = Json.parseObject(in.readAllBytes());
        }
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(String key) {
        return (List<Map<String, Object>>) vectors.get(key);
    }

    private static int flagBits(Map<String, Object> vector) {
        Map<String, Object> flags = Json.object(vector, "flags");
        int bits = 0;
        bits |= Boolean.TRUE.equals(flags.get("more")) ? Frame.MORE : 0;
        bits |= Boolean.TRUE.equals(flags.get("bin")) ? Frame.BIN : 0;
        bits |= Boolean.TRUE.equals(flags.get("end")) ? Frame.END : 0;
        return bits;
    }

    private static byte[] payloadOf(Map<String, Object> vector) {
        String text = Json.string(vector, "payloadText");
        return text != null
                ? text.getBytes(StandardCharsets.UTF_8)
                : HexFormat.of().parseHex(Json.string(vector, "payloadHex"));
    }

    private static long number(Map<String, Object> vector, String key) {
        return ((Number) vector.get(key)).longValue();
    }

    @Test
    void kindCodesMatchTheVectors() {
        Map<String, Object> kinds = Json.object(vectors, "kinds");
        assertThat(kinds).hasSize(FrameKind.values().length - 1);
        kinds.forEach((name, code) -> assertThat(FrameKind.valueOf(name).code()).isEqualTo(((Number) code).intValue()));
    }

    @Test
    void channelIdsMatchTheVectors() {
        Map<String, Object> channels = Json.object(vectors, "channels");
        assertThat(channels).containsEntry("ctl", Channels.CTL)
                .containsEntry("rpc", Channels.RPC)
                .containsEntry("events", Channels.EVENTS)
                .containsEntry("collab", Channels.COLLAB)
                .containsEntry("mdoc", Channels.MDOC)
                .containsEntry("bulk", Channels.BULK)
                .hasSize(Channels.COUNT);
    }

    @Test
    void everyValidVectorEncodesAndDecodesByteExactly() throws FrameException {
        List<Map<String, Object>> valid = list("valid");
        assertThat(valid).isNotEmpty();
        for (Map<String, Object> vector : valid) {
            byte[] bytes = HexFormat.of().parseHex(Json.string(vector, "hex"));
            Frame decoded = Frame.decode(bytes);
            String name = Json.string(vector, "name");
            assertThat(decoded.kind().name()).as(name).isEqualTo(Json.string(vector, "kind"));
            assertThat(decoded.kind().code()).as(name).isEqualTo(number(vector, "kindCode"));
            assertThat(decoded.flags()).as(name).isEqualTo(flagBits(vector));
            assertThat(decoded.id()).as(name).isEqualTo(number(vector, "id"));
            assertThat(decoded.seq()).as(name).isEqualTo(number(vector, "seq"));
            assertThat(decoded.payload()).as(name).isEqualTo(payloadOf(vector));

            Frame rebuilt = new Frame(
                    FrameKind.valueOf(Json.string(vector, "kind")),
                    flagBits(vector),
                    number(vector, "id"),
                    number(vector, "seq"),
                    payloadOf(vector));
            assertThat(rebuilt.encode()).as(name).isEqualTo(bytes);
        }
    }

    @Test
    void everyInvalidVectorIsRefused() {
        List<Map<String, Object>> invalid = list("invalid");
        assertThat(invalid).isNotEmpty();
        for (Map<String, Object> vector : invalid) {
            byte[] bytes = HexFormat.of().parseHex(Json.string(vector, "hex"));
            assertThatThrownBy(() -> Frame.decode(bytes))
                    .as(Json.string(vector, "name"))
                    .isInstanceOf(FrameException.class);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void everyMessageVectorFragmentsAndReassemblesByteExactly() throws Exception {
        for (Map<String, Object> vector : list("messages")) {
            String name = Json.string(vector, "name");
            List<String> expectedFrames = (List<String>) vector.get("frames");

            // Reassemble the published frames.
            Reassembler reassembler = new Reassembler(new ReassemblyBudget(ReassemblyBudget.DEFAULT_BYTES));
            Message message = null;
            for (String hex : expectedFrames) {
                assertThat(message).as(name).isNull();
                message = reassembler.accept(Frame.decode(HexFormat.of().parseHex(hex)));
            }
            assertThat(message).as(name).isNotNull();
            assertThat(message.payload()).as(name).hasSize((int) number(vector, "payloadLength"));
            assertThat(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(message.payload())))
                    .as(name)
                    .isEqualTo(Json.string(vector, "payloadSha256"));

            // Fragment the payload again, and get the same bytes.
            List<byte[]> frames = Frame.fragment(
                    FrameKind.valueOf(Json.string(vector, "kind")),
                    flagBits(vector),
                    number(vector, "id"),
                    number(vector, "seq"),
                    message.payload());
            List<String> actual = new ArrayList<>();
            frames.forEach(frame -> actual.add(HexFormat.of().formatHex(frame)));
            assertThat(actual).as(name).isEqualTo(expectedFrames);
        }
    }

    @Test
    void anUnknownKindDecodesSoReceiversCanIgnoreIt() throws FrameException {
        Frame frame = Frame.decode(HexFormat.of().parseHex("01ff00000000000000000000"));
        assertThat(frame.kind()).isEqualTo(FrameKind.UNKNOWN);
        assertThatThrownBy(frame::encode).isInstanceOf(IllegalArgumentException.class);
    }
}
