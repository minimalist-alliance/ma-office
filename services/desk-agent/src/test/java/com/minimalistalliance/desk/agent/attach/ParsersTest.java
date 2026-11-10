package com.minimalistalliance.desk.agent.attach;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.provider.ProviderId;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** The reader child process on real files built in memory (ADR 0049). */
class ParsersTest {

    private static Parsers parsers;
    private static Preparer preparer;

    @BeforeAll
    static void start() {
        parsers = new Parsers(30);
        preparer = new Preparer(parsers);
    }

    @AfterAll
    static void stop() {
        parsers.close();
    }

    private static String read(String name, byte[] bytes) throws AttachException {
        var made = preparer.prepare(List.of(new Staging.Staged(name, bytes)), Caps.DEFAULT, ProviderId.ANTHROPIC,
                "claude-sonnet-5-5");
        return made.getFirst().text();
    }

    @Test
    void textFormatsAreReadAsTheyAre() throws Exception {
        assertThat(read("notes.md", "# Title\r\nline two".getBytes(StandardCharsets.UTF_8))).isEqualTo("# Title\nline two");
        assertThat(read("data.csv", "a,b\n1,2\n".getBytes(StandardCharsets.UTF_8))).contains("a,b").contains("1,2");
        assertThat(read("Main.java", "class A {}".getBytes(StandardCharsets.UTF_8))).isEqualTo("class A {}");
        assertThat(read("x.json", "{\"k\":1}".getBytes(StandardCharsets.UTF_8))).isEqualTo("{\"k\":1}");
    }

    @Test
    void controlCharactersAreDropped() throws Exception {
        assertThat(read("a.txt", "hi\u001b[31m there\u0007".getBytes(StandardCharsets.UTF_8))).isEqualTo("hi[31m there");
    }

    @Test
    void aPdfIsReadToText() throws Exception {
        assertThat(read("report.pdf", Fixtures.pdf(2, "Quarterly revenue"))).contains("Quarterly revenue page 1")
                .contains("Quarterly revenue page 2");
    }

    @Test
    void aPdfWithAFontThatIsNotEmbeddedIsStillReadUnderTheSandbox() throws Exception {
        assertThat(read("arial.pdf", Fixtures.pdfWithUnembeddedFont("Arial", "Plain words"))).contains("Plain words");
        assertThat(read("odd.pdf", Fixtures.pdfWithUnembeddedFont("NoSuchFont-Bold", "Odd words"))).contains("Odd words");
    }

    @Test
    void aPdfWithNoTextLayerSaysSo() {
        assertThatThrownBy(() -> read("scan.pdf", Fixtures.pdfWithoutText())).isInstanceOfSatisfying(AttachException.class,
                e -> assertThat(e.reason()).isEqualTo("no_text"));
    }

    @Test
    void aPdfPastThePageCapIsCutAndSaid() throws Exception {
        Caps caps = new Caps(5, 8L << 20, 5L << 20, 12L << 20, 100_000, 200_000, 2);
        var made = preparer.prepare(List.of(new Staging.Staged("long.pdf", Fixtures.pdf(5, "Row"))), caps,
                ProviderId.OPENAI, "gpt-6-sol");
        assertThat(made.getFirst().text()).contains("page 2").doesNotContain("page 3");
        assertThat(made.getFirst().note()).isEqualTo("cut");
    }

    @Test
    void officeFilesAreReadToText() throws Exception {
        assertThat(read("memo.docx", Fixtures.docx("Hello world", "Second paragraph"))).contains("Hello world\nSecond paragraph");
        assertThat(read("book.xlsx", Fixtures.xlsx())).contains("--- Sheet: Budget ---").contains("Name\tTotal")
                .contains("42\t\tinline");
        assertThat(read("deck.pptx", Fixtures.pptx())).contains("--- Slide 1 ---").contains("First slide")
                .contains("Notes: Say hello").contains("Second slide");
    }

    @Test
    void anOfficeFileWithoutItsMainPartIsUnreadable() {
        byte[] notWord = Fixtures.zip(Map.of("hello.txt", "hi".getBytes(StandardCharsets.UTF_8)));
        assertThatThrownBy(() -> read("fake.docx", notWord)).isInstanceOfSatisfying(AttachException.class,
                e -> assertThat(e.reason()).isEqualTo("unreadable"));
    }

    @Test
    void aZipBombStopsAtTheInflationBudget() {
        byte[] bomb = Fixtures.zipBomb("word/document.xml", 150);
        assertThat(bomb.length).isLessThan(1 << 20);
        long started = System.nanoTime();
        assertThatThrownBy(() -> read("bomb.docx", bomb)).isInstanceOfSatisfying(AttachException.class,
                e -> assertThat(e.reason()).isIn("too_complex", "unreadable"));
        assertThat((System.nanoTime() - started) / 1_000_000_000L).isLessThan(20);
    }

    @Test
    void aBombInAnUnwantedPartIsCountedToo() {
        byte[] bomb = Fixtures.zipBomb("media/huge.bin", 150);
        assertThatThrownBy(() -> read("bomb2.docx", bomb)).isInstanceOf(AttachException.class);
    }

    @Test
    void entityBombsInXmlAreRefused() {
        String xml = "<?xml version=\"1.0\"?><!DOCTYPE lolz [<!ENTITY a \"aaaaaaaaaa\"><!ENTITY b \"&a;&a;&a;&a;&a;&a;"
                + "&a;&a;&a;&a;\"><!ENTITY c \"&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;\">]><w:document xmlns:w=\"x\"><w:p><w:t>&c;"
                + "</w:t></w:p></w:document>";
        byte[] file = Fixtures.zip(Map.of("word/document.xml", xml.getBytes(StandardCharsets.UTF_8)));
        assertThatThrownBy(() -> read("lolz.docx", file)).isInstanceOf(AttachException.class);
    }

    @Test
    void garbageThatCallsItselfAPdfIsUnreadable() {
        byte[] junk = ("%PDF-1.7\n" + "x".repeat(2000)).getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> read("junk.pdf", junk)).isInstanceOfSatisfying(AttachException.class,
                e -> assertThat(e.reason()).isIn("unreadable", "too_complex"));
    }

    @Test
    void legacyOfficeAndUnknownBinariesAreNamedAsSuch() {
        byte[] ole = new byte[600];
        ole[0] = (byte) 0xD0;
        ole[1] = (byte) 0xCF;
        ole[2] = 0x11;
        ole[3] = (byte) 0xE0;
        assertThatThrownBy(() -> read("old.doc", ole)).isInstanceOfSatisfying(AttachException.class,
                e -> assertThat(e.reason()).isEqualTo("legacy_office"));
        byte[] exe = new byte[600];
        exe[0] = 'M';
        exe[1] = 'Z';
        assertThatThrownBy(() -> read("run.exe", exe)).isInstanceOfSatisfying(AttachException.class,
                e -> assertThat(e.reason()).isEqualTo("unsupported_type"));
    }

    @Test
    void textLongerThanTheCapIsCutAndSaid() throws Exception {
        var made = preparer.prepare(List.of(new Staging.Staged("big.txt", "a".repeat(300_000).getBytes(StandardCharsets.UTF_8))),
                Caps.DEFAULT, ProviderId.OPENAI, "gpt-6-sol");
        assertThat(made.getFirst().text()).hasSize(100_000);
        assertThat(made.getFirst().note()).isEqualTo("cut");
    }

    @Test
    void imagesNeedAModelThatTakesThemAndStayWithinTheirSize() throws Exception {
        byte[] png = Fixtures.png(800, 600);
        var made = preparer.prepare(List.of(new Staging.Staged("pic.png", png)), Caps.DEFAULT, ProviderId.ANTHROPIC,
                "claude-sonnet-5-5");
        assertThat(made.getFirst().kind()).isEqualTo(com.minimalistalliance.desk.agent.provider.Attachment.Kind.IMAGE);
        assertThat(made.getFirst().imageTokens()).isBetween(100L, 1700L);
        assertThatThrownBy(() -> preparer.prepare(List.of(new Staging.Staged("pic.png", Fixtures.png(800, 600))),
                Caps.DEFAULT, ProviderId.XAI, "grok-3")).isInstanceOfSatisfying(AttachException.class,
                        e -> assertThat(e.reason()).isEqualTo("no_vision"));
        assertThatThrownBy(() -> preparer.prepare(List.of(new Staging.Staged("huge.png", Fixtures.png(30000, 30000))),
                Caps.DEFAULT, ProviderId.ANTHROPIC, "claude-sonnet-5-5")).isInstanceOfSatisfying(AttachException.class,
                        e -> assertThat(e.reason()).isEqualTo("image_too_big"));
        assertThatThrownBy(() -> preparer.prepare(List.of(new Staging.Staged("cut.png", new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0})),
                Caps.DEFAULT, ProviderId.ANTHROPIC, "claude-sonnet-5-5")).isInstanceOfSatisfying(AttachException.class,
                        e -> assertThat(e.reason()).isEqualTo("unreadable"));
    }

    @Test
    void capsRefuseTooManyAndTooBig() {
        Caps caps = new Caps(2, 2048, 4096, 4096, 100_000, 200_000, 100);
        byte[] text = "x".repeat(3000).getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> preparer.prepare(List.of(new Staging.Staged("a.txt", text)), caps, ProviderId.OPENAI, "gpt-6-sol"))
                .isInstanceOfSatisfying(AttachException.class, e -> {
                    assertThat(e.reason()).isEqualTo("too_large");
                    assertThat(e.limit()).isEqualTo(2048);
                });
        byte[] small = "x".repeat(2000).getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> preparer.prepare(List.of(new Staging.Staged("a.txt", small), new Staging.Staged("b.txt", small.clone()),
                new Staging.Staged("c.txt", small.clone())), caps, ProviderId.OPENAI, "gpt-6-sol"))
                .isInstanceOfSatisfying(AttachException.class, e -> assertThat(e.reason()).isEqualTo("total_too_large"));
    }

    @Test
    void theStagedBytesAreZeroedAfterReading() throws Exception {
        byte[] bytes = "secret-marker".getBytes(StandardCharsets.UTF_8);
        preparer.prepare(List.of(new Staging.Staged("a.txt", bytes)), Caps.DEFAULT, ProviderId.OPENAI, "gpt-6-sol");
        assertThat(bytes).containsOnly((byte) 0);
    }
}
