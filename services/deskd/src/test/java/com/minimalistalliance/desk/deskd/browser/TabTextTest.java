package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import org.junit.jupiter.api.Test;

class TabTextTest {

    @Test
    void controlAndBidiCharactersGo() {
        assertThat(TabText.clean("a\u0000b\nc\td\u007fe\u0085f", 100)).isEqualTo("abcdef");
        assertThat(TabText.clean("evil\u202Egnp.exe\u2066x\u200F", 100)).isEqualTo("evilgnp.exex");
        assertThat(TabText.clean("a\u2028b\u2029c", 100)).isEqualTo("abc");
    }

    /** Regression: U+061C has Bidi_Control=Yes too, and it stayed, so a title could still reorder. */
    @Test
    void everyBidiControlGoes() {
        String[] controls = {"\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"};
        for (String control : controls) {
            assertThat(TabText.clean("a" + control + "b", 100)).as("U+%04X", (int) control.charAt(0)).isEqualTo("ab");
        }
    }

    @Test
    void ordinaryTextStays() {
        assertThat(TabText.clean("Caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00 \u200d", 100)).isEqualTo("Caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00 \u200d");
    }

    @Test
    void itsCutAtTheLimitAndNeverInsideAPair() {
        assertThat(TabText.clean("x".repeat(500), 10)).hasSize(10);
        assertThat(TabText.clean("xxxxxxxxx\ud83d\ude00", 10)).isEqualTo("xxxxxxxxx");
        assertThat(TabText.clean("xxxxxxxx\ud83d\ude00", 10)).isEqualTo("xxxxxxxx\ud83d\ude00");
    }

    @Test
    void loneSurrogatesBecomeReplacementsSoJsonCanCarryThem() {
        String cleaned = TabText.clean("a\ud83db\ude00c\ud83d", 100);
        assertThat(cleaned).isEqualTo("a\ufffdb\ufffdc\ufffd");
        assertThat(Json.bytes(cleaned)).isNotEmpty();
        String inserted = TabText.insertable("a\ud83db\n\ud83d\ude00");
        assertThat(inserted).isEqualTo("a\ufffdb\n\ud83d\ude00");
        assertThat(Json.bytes(inserted)).isNotEmpty();
    }

    @Test
    void nullIsEmpty() {
        assertThat(TabText.clean(null, 10)).isEmpty();
    }
}
