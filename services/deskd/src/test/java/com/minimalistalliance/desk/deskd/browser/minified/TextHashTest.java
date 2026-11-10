package com.minimalistalliance.desk.deskd.browser.minified;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** deskd's half and deskd hash typed text the same way (review 3). The expected values come from proxy.js's own hash in Node. */
class TextHashTest {

    @Test
    void theJavaHashIsTheProxysHash() {
        assertThat(ActionProxy.textHash("")).isEqualTo("wvjl67o803");
        assertThat(ActionProxy.textHash("Ann")).isEqualTo("10lixtxfbxd");
        assertThat(ActionProxy.textHash("555123")).isEqualTo("d58idk9g9k");
        assertThat(ActionProxy.textHash("brass lamps")).isEqualTo("26qur95vvse");
        assertThat(ActionProxy.textHash("é漢😀")).isEqualTo("217al2woabn");
        assertThat(ActionProxy.textHash("x".repeat(65536))).isEqualTo("1nqutjrw0v7");
    }
}
