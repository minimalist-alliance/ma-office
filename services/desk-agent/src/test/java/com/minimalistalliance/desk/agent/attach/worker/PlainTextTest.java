package com.minimalistalliance.desk.agent.attach.worker;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.SplittableRandom;
import org.junit.jupiter.api.Test;

/**
 * Text decoded from the stream answers exactly as the whole-array reader before it did: the same text, note and reason
 * for the same bytes and cap, whatever the reads' sizes. {@link #reference} is that reader, kept here unchanged.
 */
class PlainTextTest {

    /** The reader before {@code sub/parse-memory}, which took the whole file as one array. */
    static ParseWorker.Result reference(byte[] bytes, int maxChars) {
        if (bytes.length == 0) {
            return ParseWorker.Result.error("empty");
        }
        java.nio.charset.Charset charset = StandardCharsets.UTF_8;
        int start = 0;
        if (bytes.length >= 3 && (bytes[0] & 0xFF) == 0xEF && (bytes[1] & 0xFF) == 0xBB && (bytes[2] & 0xFF) == 0xBF) {
            start = 3;
        } else if (bytes.length >= 2 && (bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xFF) == 0xFE) {
            charset = StandardCharsets.UTF_16LE;
            start = 2;
        } else if (bytes.length >= 2 && (bytes[0] & 0xFF) == 0xFE && (bytes[1] & 0xFF) == 0xFF) {
            charset = StandardCharsets.UTF_16BE;
            start = 2;
        } else {
            int look = Math.min(bytes.length, 8192);
            for (int i = 0; i < look; i++) {
                if (bytes[i] == 0) {
                    return ParseWorker.Result.error("binary");
                }
            }
        }
        int take = (int) Math.min((long) bytes.length - start, (long) maxChars * 4 + 16);
        String decoded = new String(bytes, start, take, charset);
        boolean cut = take < bytes.length - start;
        ParseWorker.Capped out = new ParseWorker.Capped(maxChars);
        StringBuilder piece = new StringBuilder();
        for (int i = 0; i < decoded.length(); i++) {
            char c = decoded.charAt(i);
            if (c == '\r') {
                if (i + 1 < decoded.length() && decoded.charAt(i + 1) == '\n') {
                    continue;
                }
                c = '\n';
            }
            if (c < 0x20 && c != '\n' && c != '\t' || c == 0x7F || (c >= 0x80 && c < 0xA0)) {
                continue;
            }
            piece.append(c);
            if (piece.length() >= 4096) {
                out.append(piece);
                piece.setLength(0);
            }
        }
        out.append(piece);
        String text = out.toString();
        if (cut && text.endsWith("�")) {
            text = text.substring(0, text.length() - 1);
        }
        if (text.isBlank()) {
            return ParseWorker.Result.error("empty");
        }
        return ParseWorker.Result.ok(text, cut || out.full() ? "cut" : null);
    }

    private static ParseWorker.Result streamed(byte[] bytes, int maxChars, int most) throws IOException {
        InputStream trickle = new ByteArrayInputStream(bytes) {
            @Override
            public synchronized int read(byte[] b, int off, int len) {
                return super.read(b, off, Math.min(len, most));
            }
        };
        Input.Limited in = new Input.Limited(trickle, Long.MAX_VALUE);
        ParseWorker.Result result = PlainText.read(in, maxChars);
        in.drain();
        return result;
    }

    /** Bytes that make a text reader work: line ends of every kind, controls, multi-byte and broken sequences. */
    private static byte[] file(SplittableRandom random) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        switch (random.nextInt(6)) {
            case 0 -> out.writeBytes(new byte[] {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF});
            case 1 -> out.writeBytes(new byte[] {(byte) 0xFF, (byte) 0xFE});
            case 2 -> out.writeBytes(new byte[] {(byte) 0xFE, (byte) 0xFF});
            default -> { }
        }
        int length = switch (random.nextInt(4)) {
            case 0 -> random.nextInt(40);
            case 1 -> random.nextInt(2000);
            case 2 -> 8000 + random.nextInt(400);
            default -> random.nextInt(60_000);
        };
        boolean nuls = random.nextInt(4) == 0;
        String[] pieces = {"a", "word ", "\r", "\n", "\r\n", "\t", "\u0007", "\u007f", "\u0085", "é", "’",
            "😀", " "};
        while (out.size() < length) {
            int roll = random.nextInt(100);
            if (roll < 3) {
                out.write(0x80 + random.nextInt(0x40));
            } else if (roll < 5) {
                out.write(0xC0 + random.nextInt(0x40));
            } else if (roll < 6 && nuls) {
                out.write(0);
            } else {
                out.writeBytes(pieces[random.nextInt(pieces.length)].getBytes(StandardCharsets.UTF_8));
            }
        }
        return out.toByteArray();
    }

    @Test
    void streamingAnswersAsTheWholeArrayDidOnRandomFiles() throws IOException {
        SplittableRandom random = new SplittableRandom(20261112);
        for (int round = 0; round < 3000; round++) {
            byte[] bytes = file(random);
            int maxChars = switch (random.nextInt(4)) {
                case 0 -> 1 + random.nextInt(20);
                case 1 -> 1 + random.nextInt(3000);
                default -> 1 + random.nextInt(80_000);
            };
            int most = random.nextBoolean() ? Integer.MAX_VALUE : 1 + random.nextInt(9000);
            ParseWorker.Result expected = reference(bytes, maxChars);
            ParseWorker.Result actual = streamed(bytes, maxChars, most);
            assertThat(actual).as("round %d, %d bytes, cap %d, reads of %d", round, bytes.length, maxChars, most)
                    .isEqualTo(expected);
        }
    }

    @Test
    void theEdgesAnswerAsBefore() throws IOException {
        byte[][] files = {
            new byte[0],
            "\r".getBytes(StandardCharsets.UTF_8),
            "a\r".getBytes(StandardCharsets.UTF_8),
            "a\r\r\nb\rc".getBytes(StandardCharsets.UTF_8),
            "   \n\t ".getBytes(StandardCharsets.UTF_8),
            {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF},
            {(byte) 0xFF, (byte) 0xFE, 'h', 0, 'i', 0, 'x'},
            {'a', (byte) 0xE2, (byte) 0x80},
            {'o', 'k', 0},
        };
        for (byte[] bytes : files) {
            for (int maxChars : new int[] {1, 2, 3, 1000}) {
                assertThat(streamed(bytes, maxChars, Integer.MAX_VALUE)).as("%d bytes, cap %d", bytes.length, maxChars)
                        .isEqualTo(reference(bytes, maxChars));
                assertThat(streamed(bytes, maxChars, 1)).isEqualTo(reference(bytes, maxChars));
            }
        }
        // A character cut by the bytes the cap allows (4 a char + 16) decodes to a replacement, which is dropped when
        // the file goes on, as before: controls (dropped) fill the bytes so the cap in characters isn't reached first.
        for (String lead : new String[] {"", "ab"}) {
            ByteArrayOutputStream cut = new ByteArrayOutputStream();
            cut.writeBytes(lead.getBytes(StandardCharsets.UTF_8));
            while (cut.size() < 26) {
                cut.write(0x07);
            }
            cut.writeBytes(new byte[] {(byte) 0xE2, (byte) 0x80, (byte) 0x99});
            byte[] bytes = cut.toByteArray();
            ParseWorker.Result expected = reference(bytes, 3);
            assertThat(expected).isEqualTo(lead.isEmpty() ? ParseWorker.Result.error("empty")
                    : ParseWorker.Result.ok("ab", "cut"));
            assertThat(streamed(bytes, 3, 7)).isEqualTo(expected);
        }
    }

    @Test
    void aFileFarLongerThanTheCapIsReadToItsEndWithoutHoldingIt() throws IOException {
        byte[] bytes = "line of words\r\n".repeat(400_000).getBytes(StandardCharsets.UTF_8);
        ParseWorker.Result result = streamed(bytes, 100, 65_536);
        assertThat(result).isEqualTo(reference(bytes, 100));
        assertThat(result.note()).isEqualTo("cut");
        assertThat(result.text()).hasSize(100);
    }
}
