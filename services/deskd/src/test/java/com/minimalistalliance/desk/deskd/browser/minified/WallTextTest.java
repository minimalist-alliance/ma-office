package com.minimalistalliance.desk.deskd.browser.minified;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

/** A wall drawn by another site's frame is told apart as the prototype's kit does (its classify_wall). */
class WallTextTest {

    @Test
    void aTermsWallNeedsAnAgreeAndNoOtherWayOut() {
        String terms = "Terms of Use & Privacy By clicking Accept and Continue, you confirm you agree to the Terms of Use.";
        assertThat(WallText.classify(terms, List.of("Accept and Continue"))).isEqualTo("terms");
        assertThat(WallText.classify(terms, List.of("Accept and Continue", "Reject all"))).isEqualTo("consent");
        assertThat(WallText.classify(terms, List.of("Accept and Continue", "Manage settings"))).isEqualTo("other");
        assertThat(WallText.classify(terms, List.of("I agree", "Close"))).isEqualTo("nag");
        assertThat(WallText.classify("Subscribe for more", List.of("Continue"))).isEqualTo("other");
        assertThat(WallText.classify("", List.of())).isEqualTo("other");
    }
}
