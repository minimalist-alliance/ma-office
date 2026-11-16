package com.minimalistalliance.desk.courier.testkit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Expect;
import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Outcome;
import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Sample;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/** The corpus's own promises: deterministic, big enough, every row backed by a file, every expectation consistent. */
class MimeCorpusTest {

    private static final Set<String> REASONS = Set.of(MimeCorpus.TOO_LARGE, MimeCorpus.TOO_DEEP, MimeCorpus.TOO_MANY_PARTS,
            MimeCorpus.TIMEOUT, MimeCorpus.MALFORMED, MimeCorpus.TOO_COMPLEX);
    private static final Set<String> FAMILIES = Set.of("basic", "charset", "encoding", "header", "structure", "attachment", "html",
            "links", "bulk", "malformed", "limits", "mutation");

    @Test
    void theSameSeedGivesTheSameBytes() throws Exception {
        String first = sha256(MimeCorpus.generated(MimeCorpus.DEFAULT_SEED, MimeCorpus.STANDARD_COUNT));
        String second = sha256(MimeCorpus.generated(MimeCorpus.DEFAULT_SEED, MimeCorpus.STANDARD_COUNT));
        assertThat(second).isEqualTo(first);
        assertThat(sha256(MimeCorpus.generated(MimeCorpus.DEFAULT_SEED + 1, 200))).isNotEqualTo(sha256(MimeCorpus.generated(MimeCorpus.DEFAULT_SEED, 200)));
        // A shorter run is a prefix of a longer one, and any sample can be made alone.
        assertThat(sha256(MimeCorpus.generated(MimeCorpus.DEFAULT_SEED, 300)))
                .isEqualTo(sha256(MimeCorpus.generated(MimeCorpus.DEFAULT_SEED, 1000).limit(300)));
        System.out.println("corpus: generated(" + MimeCorpus.DEFAULT_SEED + ", " + MimeCorpus.STANDARD_COUNT + ") SHA-256 " + first);
    }

    @Test
    void theStandardSetIsBigUniqueAndUnder60Mb() {
        List<Sample> all = MimeCorpus.standard().toList();
        int hand = MimeCorpus.handWritten().size();
        assertThat(all).hasSize(hand + MimeCorpus.STANDARD_COUNT);
        assertThat(all.size()).isGreaterThanOrEqualTo(5000);
        Set<String> names = new HashSet<>();
        for (Sample s : all) {
            assertThat(names.add(s.name())).as("unique " + s.name()).isTrue();
        }
        long bytes = all.stream().mapToLong(s -> s.raw().length).sum();
        assertThat(bytes).isLessThan(60L * 1024 * 1024);
        Map<String, Long> byFamily = all.stream().collect(Collectors.groupingBy(Sample::family, TreeMap::new, Collectors.counting()));
        Map<String, Long> bytesByFamily = all.stream().collect(Collectors.groupingBy(Sample::family, TreeMap::new,
                Collectors.summingLong(s -> s.raw().length)));
        System.out.println("corpus: standard() " + all.size() + " samples (" + hand + " hand-written), " + bytes + " bytes, largest "
                + all.stream().mapToInt(s -> s.raw().length).max().orElse(0));
        System.out.println("corpus: by family " + byFamily);
        System.out.println("corpus: bytes by family " + bytesByFamily);
    }

    @Test
    void everyRowHasItsFileAndEveryFileItsRow() throws Exception {
        Path dir = Path.of(MimeCorpusTest.class.getResource("/courier-testkit/mime").toURI());
        Set<String> files;
        try (Stream<Path> list = Files.list(dir)) {
            files = list.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".eml")).map(n -> n.substring(0, n.length() - 4))
                    .collect(Collectors.toSet());
        }
        List<Sample> hand = MimeCorpus.handWritten();
        Set<String> rows = hand.stream().map(Sample::name).collect(Collectors.toSet());
        assertThat(rows).hasSize(hand.size());
        assertThat(rows).isEqualTo(files);
        assertThat(hand.size()).isGreaterThanOrEqualTo(27 + 60);
        // deskd's 27 come first, byte for byte as deskd has them.
        assertThat(hand.subList(0, 27)).extracting(Sample::name).contains("gmail-alternative", "too-many-parts", "binary-attachment");
        for (Sample s : hand) {
            assertThat(s.raw()).as(s.name()).isEqualTo(Files.readAllBytes(dir.resolve(s.name() + ".eml")));
        }
    }

    @Test
    void everyExpectationIsConsistent() {
        Stream.concat(MimeCorpus.standard(), limitSamples()).forEach(s -> {
            Expect e = s.expect();
            assertThat(s.family()).as(s.name()).isIn(FAMILIES);
            switch (e.outcome()) {
                case REFUSED -> {
                    assertThat(e.reason()).as(s.name()).isIn(REASONS);
                    assertThat(e.subject()).isNull();
                    assertThat(e.word()).isNull();
                }
                case READ -> {
                    assertThat(e.reason()).isNull();
                    assertThat(e.from()).as(s.name() + " from").isNotNull().isEqualTo(Mime.lower(e.from())).contains("@");
                    if (e.word() != null) {
                        assertThat(Langs.isCheckWord(e.word())).as(s.name() + " word " + e.word()).isTrue();
                    }
                    if (e.attachments() != null) {
                        assertThat(e.attachments()).isNotNegative();
                    }
                }
                case EITHER -> assertThat(e.reason()).isNull();
            }
        });
    }

    @Test
    void generatedFamiliesAllAppearAndOnlyMutationsAreEither() {
        List<Sample> gen = MimeCorpus.generated(MimeCorpus.DEFAULT_SEED, MimeCorpus.STANDARD_COUNT).toList();
        assertThat(gen.stream().map(Sample::family).collect(Collectors.toSet()))
                .containsExactlyInAnyOrder("charset", "encoding", "header", "structure", "attachment", "html", "links", "mutation");
        for (Sample s : gen) {
            assertThat(s.name()).isEqualTo("gen-" + s.family() + "-" + s.name().substring(s.name().lastIndexOf('-') + 1));
            assertThat(s.expect().outcome()).as(s.name()).isEqualTo(s.family().equals("mutation") ? Outcome.EITHER : Outcome.READ);
        }
        // Every charset of the list turns up.
        String all = gen.stream().filter(s -> s.family().equals("charset")).map(s -> Mime.lower(new String(s.raw(), StandardCharsets.ISO_8859_1)))
                .collect(Collectors.joining("\n"));
        for (Langs.Cs cs : Langs.CHARSETS) {
            assertThat(all).as(cs.label()).containsAnyOf("charset=" + cs.label(), "charset=\"" + cs.label());
        }
        // Small runs still cover every family.
        assertThat(MimeCorpus.generated(1, 25).map(Sample::family).collect(Collectors.toSet())).hasSize(8);
    }

    @Test
    void largeIsExactlyItsSizeAndOverLimitIsOneByteOver() throws Exception {
        for (int size : new int[] {600, 601, 602, 603, 777, 4096, 1_000_000, 1_000_003}) {
            Sample s = MimeCorpus.large(size);
            assertThat(s.raw()).as("large " + size).hasSize(size);
            assertThat(s.expect().outcome()).isEqualTo(Outcome.READ);
        }
        Sample million = MimeCorpus.large(1_000_000);
        jakarta.mail.internet.MimeMessage m = new jakarta.mail.internet.MimeMessage(Oracle.SESSION, new ByteArrayInputStream(million.raw()));
        jakarta.mail.Multipart mp = (jakarta.mail.Multipart) m.getContent();
        assertThat(mp.getCount()).isEqualTo(2);
        byte[] attached = mp.getBodyPart(1).getInputStream().readAllBytes();
        assertThat(attached.length).isBetween(1_000_000 * 57 / 78 - 1000, 1_000_000 * 57 / 78);
        assertThat(MimeCorpus.large(1_000_000)).isEqualTo(million);
        assertThatThrownBy(() -> MimeCorpus.large(100)).isInstanceOf(IllegalArgumentException.class);

        Sample atLimit = MimeCorpus.large(MimeCorpus.MAX_BYTES);
        assertThat(atLimit.raw()).hasSize(41_943_040);
        assertThat(atLimit.expect().outcome()).isEqualTo(Outcome.READ);
        Sample over = MimeCorpus.overLimit();
        assertThat(over.name()).isEqualTo("over-limit");
        assertThat(over.raw()).hasSize(41_943_041);
        assertThat(over.expect()).isEqualTo(Expect.refused("too_large"));
        // Valid all the way through: the last line closes the multipart.
        assertThat(new String(over.raw(), over.raw().length - 40, 40, StandardCharsets.US_ASCII)).endsWith("--\r\n");
    }

    @Test
    void tooDeepNestsExactlyThatDeep() throws Exception {
        for (int depth : new int[] {1, 2, 19, 20, 21, 25, 100}) {
            Sample s = MimeCorpus.tooDeep(depth);
            assertThat(Oracle.multipartDepth(Oracle.parse(s.raw()))).as("depth " + depth).isEqualTo(depth);
            assertThat(s.expect().outcome()).isEqualTo(depth <= 20 ? Outcome.READ : Outcome.REFUSED);
            if (depth > 20) {
                assertThat(s.expect().reason()).isEqualTo("too_deep");
            }
        }
        assertThatThrownBy(() -> MimeCorpus.tooDeep(0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void tooManyPartsHasExactlyThatManyParts() throws Exception {
        for (int parts : new int[] {1, 2, 3, 1999, 2000, 2001, 2500}) {
            Sample s = MimeCorpus.tooManyParts(parts);
            assertThat(Oracle.entities(Oracle.parse(s.raw()))).as("parts " + parts).isEqualTo(parts);
            assertThat(s.expect().outcome()).isEqualTo(parts <= 2000 ? Outcome.READ : Outcome.REFUSED);
            if (parts <= 2000) {
                assertThat(s.expect().attachments()).isEqualTo(Math.max(0, parts - 2));
            } else {
                assertThat(s.expect().reason()).isEqualTo("too_many_parts");
            }
        }
    }

    /** The on-demand samples, small enough to check every run. */
    static Stream<Sample> limitSamples() {
        return Stream.of(MimeCorpus.large(2048), MimeCorpus.large(300_000), MimeCorpus.tooDeep(1), MimeCorpus.tooDeep(20), MimeCorpus.tooDeep(21),
                MimeCorpus.tooManyParts(1), MimeCorpus.tooManyParts(2000), MimeCorpus.tooManyParts(2001));
    }

    private static String sha256(Stream<Sample> samples) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        samples.forEach(s -> {
            md.update(s.name().getBytes(StandardCharsets.UTF_8));
            md.update((byte) 0);
            md.update(s.raw());
            md.update(s.expect().toString().getBytes(StandardCharsets.UTF_8));
        });
        return HexFormat.of().formatHex(md.digest());
    }
}
