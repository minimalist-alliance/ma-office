package com.minimalistalliance.desk.agent.attach;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The heap bound on pictures in flight (ADR 0049). */
class ImageBudgetTest {

    @Test
    void picturesInFlightShareOneLimitAndReleaseGivesItBack() {
        ImageBudget budget = new ImageBudget();
        assertThat(budget.tryClaim(8L << 20)).isTrue();
        assertThat(budget.tryClaim(5L << 20)).isFalse();
        assertThat(budget.tryClaim(4L << 20)).isTrue();
        assertThat(budget.held()).isEqualTo(12L << 20);
        budget.release(8L << 20);
        assertThat(budget.tryClaim(5L << 20)).isTrue();
        budget.release(100L << 20);
        assertThat(budget.held()).isZero();
        assertThat(budget.tryClaim(-1)).isFalse();
    }

    @Test
    void stagingSaysHowManyPictureBytesAMessageHas() throws Exception {
        try (Staging staging = new Staging(new MutableClock(Rig.START), 64L << 20)) {
            byte[] png = Fixtures.png(100, 100);
            staging.put("owner", "manager", "upload-img1", "a.png", png.length, 0, png, Caps.DEFAULT);
            staging.put("owner", "manager", "upload-txt1", "a.txt", 5, 0, "hello".getBytes(), Caps.DEFAULT);
            assertThat(staging.pictureBytes("owner", "manager", List.of("upload-img1", "upload-txt1")))
                    .isEqualTo(png.length);
            assertThat(staging.pictureBytes("owner", "manager", List.of("upload-txt1", "nope"))).isZero();
            assertThat(staging.pictureBytes("other", "manager", List.of("upload-img1"))).isZero();
            assertThat(staging.pictureBytes("owner", "manager", List.of("upload-img1", "upload-img1"))).isEqualTo(png.length);
        }
    }

    @Test
    void oneMessagesPicturesCantPassTheLimitWhateverTheOwnersCapsSay() throws Exception {
        Caps wide = Caps.CEILING;
        try (Parsers parsers = new Parsers(30)) {
            Preparer preparer = new Preparer(parsers);
            byte[] big = new byte[(int) (5L << 20)];
            System.arraycopy(Fixtures.png(100, 100), 0, big, 0, 64);
            List<Staging.Staged> files = List.of(new Staging.Staged("a.png", big.clone()),
                    new Staging.Staged("b.png", big.clone()), new Staging.Staged("c.png", big.clone()));
            assertThatThrownBy(() -> preparer.prepare(files, wide, ProviderId.ANTHROPIC, "claude-sonnet-5-5"))
                    .isInstanceOfSatisfying(AttachException.class, e -> {
                        assertThat(e.reason()).isEqualTo("total_too_large");
                        assertThat(e.limit()).isEqualTo(ImageBudget.LIMIT);
                    });
            // Zeroed even so.
            assertThat(files.getFirst().bytes()).containsOnly(0);
        }
    }
}
