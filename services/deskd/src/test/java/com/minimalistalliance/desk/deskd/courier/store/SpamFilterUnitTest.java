package com.minimalistalliance.desk.deskd.courier.store;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The learning filter's pieces (draft ADR "Courier's store" §17), without a store. */
class SpamFilterUnitTest {

    @Test
    void sipHashMatchesTheReferenceVectors() {
        // SipHash-2-4, key 00 01 .. 0f, from the paper's appendix and the reference implementation's vectors.
        long k0 = 0x0706050403020100L;
        long k1 = 0x0f0e0d0c0b0a0908L;
        assertThat(SpamFilter.sipHash24(k0, k1, new byte[0])).isEqualTo(0x726fdb47dd0e0e31L);
        byte[] fifteen = new byte[15];
        for (int i = 0; i < 15; i++) {
            fifteen[i] = (byte) i;
        }
        assertThat(SpamFilter.sipHash24(k0, k1, fifteen)).isEqualTo(0xa129ca6149be45e5L);
        byte[] eight = new byte[8];
        for (int i = 0; i < 8; i++) {
            eight[i] = (byte) i;
        }
        assertThat(SpamFilter.sipHash24(k0, k1, eight)).isEqualTo(0x93f5f5799a932462L);
    }

    @Test
    void chiSquareIsASurvivalFunction() {
        assertThat(SpamFilter.chi2Q(0, 10)).isEqualTo(1.0);
        assertThat(SpamFilter.chi2Q(1_000, 10)).isLessThan(1e-100);
        assertThat(SpamFilter.chi2Q(10, 10)).isBetween(0.4, 0.5);
    }

    @Test
    void cluesCombineTowardTheirSide() {
        List<long[]> spammy = List.of(new long[] {40, 0}, new long[] {35, 1}, new long[] {30, 0});
        List<long[]> wanted = List.of(new long[] {0, 40}, new long[] {1, 35}, new long[] {0, 30});
        assertThat(SpamFilter.combine(spammy, 40, 40)).isGreaterThan(0.95);
        assertThat(SpamFilter.combine(wanted, 40, 40)).isLessThan(0.05);
        assertThat(SpamFilter.combine(List.of(), 40, 40)).isEqualTo(0.5);
        assertThat(SpamFilter.combine(List.of(new long[] {5, 5}), 40, 40)).isEqualTo(0.5);
    }

    @Test
    void featuresMarkEachFieldAndReadSpacelessScriptsInPairs() {
        Set<String> f = SpamFilter.features("Cheap MEDS today", "deals@pills.example", "Pill Shop",
                "Buy now at https://pills.example/buy and \u4fbf\u5b9c\u7684\u836f", List.<String[]>of(new String[] {"x.zip", "application/zip", "archive_programs"}),
                true, "fail");
        assertThat(f).contains("s:cheap", "s:meds", "from:deals@pills.example", "fromd:pills.example", "fn:pill", "buy",
                "url:pills.example", "c:\u4fbf\u5b9c", "att:ext:zip", "att:danger:archive_programs", "x:bulk", "x:dmarc:fail");
        assertThat(f).doesNotContain("at", "x:noname");
        assertThat(SpamFilter.features(null, null, null, null, null, false, null)).contains("x:nofrom", "x:noname", "x:nosubject", "x:notext",
                "x:dmarc:none");
    }

    @Test
    void featuresAreCappedWhateverTheText() {
        StringBuilder huge = new StringBuilder();
        for (int i = 0; i < 20_000; i++) {
            huge.append("word").append(i).append(' ');
        }
        assertThat(SpamFilter.features("s", "a@b.example", null, huge.toString(), List.of(), false, null)).hasSizeLessThanOrEqualTo(SpamFilter.MAX_TOKENS);
    }
}
