package com.minimalistalliance.desk.agent.provider;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class CutTest {

    @Test
    void textWithinTheLimitIsKept() {
        assertThat(Cut.chars("abc", 3)).isEqualTo("abc");
    }

    @Test
    void aCutNeverSplitsASurrogatePair() {
        String text = "ab😀cd";
        assertThat(Cut.chars(text, 3)).isEqualTo("ab");
        assertThat(Cut.chars(text, 4)).isEqualTo("ab😀");
        assertThat(Cut.chars("😀", 1)).isEmpty();
    }
}
