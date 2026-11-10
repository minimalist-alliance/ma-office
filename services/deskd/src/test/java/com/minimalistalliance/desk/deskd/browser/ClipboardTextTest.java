package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Random;
import org.junit.jupiter.api.Test;

class ClipboardTextTest {

    private static String randomText(Random random, int codePoints) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < codePoints; i++) {
            int point = switch (random.nextInt(5)) {
                case 0 -> random.nextInt(0x80);
                case 1 -> 0x80 + random.nextInt(0x800 - 0x80);
                case 2 -> 0x800 + random.nextInt(0xD800 - 0x800);
                case 3 -> 0xE000 + random.nextInt(0x10000 - 0xE000);
                default -> 0x10000 + random.nextInt(0x110000 - 0x10000);
            };
            text.appendCodePoint(point);
        }
        return text.toString();
    }

    @Test
    void measureCountsUtf8AsTheJdkWritesItAndNuls() {
        Random random = new Random(1);
        for (int i = 0; i < 200; i++) {
            String text = randomText(random, 50) + "\0";
            ClipboardText.Measure measure = ClipboardText.measure(text);
            assertThat(measure.utf8Bytes()).isEqualTo(text.getBytes(StandardCharsets.UTF_8).length);
            assertThat(measure.nulChars()).isEqualTo((int) text.chars().filter(c -> c == 0).count());
            assertThat(ClipboardText.toDesk(text, measure)).isEqualTo(text.replace("\0", "").getBytes(StandardCharsets.UTF_8));
        }
    }

    @Test
    void halfASurrogatePairIsntWholeCharacters() {
        for (String text : new String[] {"a\uD83D", "\uDE00b", "\uD83Dx\uDE00", "\uDE00\uD83D"}) {
            assertThat(ClipboardText.measure(text).wholeCharacters()).as(text).isFalse();
        }
        assertThat(ClipboardText.measure("😀").utf8Bytes()).isEqualTo(4);
    }

    @Test
    void textThatsOnlyNulsIsEmpty() {
        assertThat(ClipboardText.measure("\0\0").emptyWithoutNul()).isTrue();
        assertThat(ClipboardText.measure("").emptyWithoutNul()).isTrue();
        assertThat(ClipboardText.measure("\0a").emptyWithoutNul()).isFalse();
    }

    @Test
    void fromTheDeskBadBytesBecomeReplacementCharactersAndNulsGo() {
        byte[] raw = {'a', 0, (byte) 0xFF, 'b', (byte) 0xE2, (byte) 0x98, 'c',
            (byte) 0xED, (byte) 0xA0, (byte) 0x80, (byte) 0xC0, (byte) 0x80, '\n', '\t'};
        String text = ClipboardText.fromDesk(raw);
        assertThat(text).doesNotContain("\0").startsWith("a�b�c").endsWith("\n\t");
        // An overlong NUL is not a NUL: it's bytes that aren't UTF-8.
        assertThat(text.chars().filter(c -> c == 0xFFFD).count()).isGreaterThanOrEqualTo(4);
        assertThat(ClipboardText.fromDesk(new byte[] {0, 0})).isNull();
        assertThat(ClipboardText.fromDesk(new byte[0])).isNull();
        assertThat(ClipboardText.fromDesk("☃".getBytes(StandardCharsets.UTF_8))).isEqualTo("☃");
    }

    @Test
    void replyJsonBytesIsWhatTheJsonWriterWrites() {
        for (int c = 0; c < 0x10000; c++) {
            if (Character.isSurrogate((char) c)) {
                continue;
            }
            String text = String.valueOf((char) c);
            assertThat(ClipboardText.replyJsonBytes(text)).as("U+%04X", c).isEqualTo(jsonBytes(text));
        }
        Random random = new Random(2);
        for (int i = 0; i < 50; i++) {
            String text = randomText(random, 200);
            assertThat(ClipboardText.replyJsonBytes(text)).isEqualTo(jsonBytes(text));
        }
    }

    private static long jsonBytes(String text) {
        return Json.bytes(Collections.singletonMap("text", text)).length;
    }
}
