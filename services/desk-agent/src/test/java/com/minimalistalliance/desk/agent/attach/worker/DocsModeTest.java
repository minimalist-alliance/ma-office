package com.minimalistalliance.desk.agent.attach.worker;

import static org.assertj.core.api.Assertions.assertThat;

import tools.jackson.jr.ob.JSON;
import com.minimalistalliance.desk.agent.attach.DocsFixtures;
import com.minimalistalliance.desk.agent.attach.Fixtures;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** The documents mode in process (deskd {@code API.md} §25): its lines, each kind's answer, the boxes, render and refusals. */
class DocsModeTest {

    @BeforeAll
    static void warm() {
        new DocsMode().warmUp();
    }

    record Out(String line, byte[] body, String refused) {}

    static Out serve(String line, byte[] input) throws IOException {
        String[] refusedHolder = new String[1];
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        String[] note = new String[1];
        InputStream in = new ByteArrayInputStream(input);
        new DocsMode().serve(line, in, new com.minimalistalliance.desk.courier.parse.WorkerMode.Reply() {
            @Override
            public boolean ok(String n, byte[] b) throws IOException {
                note[0] = n;
                body.write(b);
                return true;
            }

            @Override
            public void refuse(String reason) {
                refusedHolder[0] = reason;
            }

            @Override
            public void drain() {
                try {
                    in.transferTo(java.io.OutputStream.nullOutputStream());
                } catch (IOException e) {
                    // gone
                }
            }
        }, 10_000);
        return new Out(note[0], body.toByteArray(), refusedHolder[0]);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> json(Out out) throws IOException {
        assertThat(out.refused()).isNull();
        return (Map<String, Object>) JSON.std.anyFrom(new String(out.body(), StandardCharsets.UTF_8));
    }

    @Test
    void linesAreReadStrictly() {
        assertThat(DocsMode.parse("docs1 read pdf 100000 500")).isNotNull();
        assertThat(DocsMode.parse("docs1 render 3 800")).isNotNull();
        for (String bad : List.of("docs1", "docs1 read", "docs1 read exe 10 10", "docs1 read pdf 010 10", "docs1 read pdf -1 10",
                "docs1 read pdf 200001 10", "docs1 read pdf 10 501", "docs1 read pdf 10 10 x", "docs1  read pdf 10 10",
                "docs1 render 0 800", "docs1 render 1 199", "docs1 render 1 1601", "docs1 render 1 800 9", "docs2 read pdf 1 1",
                "docs1 read pdf 1\t1", "docs1 read pdf 1 1é", "docs1 render 501 800")) {
            assertThat(DocsMode.parse(bad)).as(bad).isNull();
        }
    }

    @Test
    void aBadLineIsBadRequest() throws IOException {
        assertThat(serve("docs1 read exe 1 1", new byte[10]).refused()).isEqualTo("bad_request");
    }

    @Test
    @SuppressWarnings("unchecked")
    void aPdfIsReadPageByPageWithEachLinesBox() throws IOException {
        byte[] pdf = DocsFixtures.pdf(DocsFixtures.contract("Rosa Ortiz", 2, 6), true, false, null);
        Map<String, Object> m = json(serve("docs1 read pdf 200000 500", pdf));
        assertThat(m.get("v")).isEqualTo(1);
        assertThat(m.get("pageCount")).isEqualTo(6);
        assertThat(m.get("cut")).isEqualTo(false);
        List<Map<String, Object>> pages = (List<Map<String, Object>>) m.get("pages");
        assertThat(pages).hasSize(6);
        Map<String, Object> p3 = pages.get(2);
        assertThat(p3.get("n")).isEqualTo(3);
        assertThat((String) p3.get("text")).contains("Payment is due on 1 December 2026.");
        List<Map<String, Object>> lines = (List<Map<String, Object>>) p3.get("lines");
        assertThat(lines).isNotEmpty();
        Map<String, Object> pay = lines.stream().filter(l -> ((String) l.get("t")).startsWith("Payment is due")).findFirst().orElseThrow();
        List<Number> b = (List<Number>) pay.get("b");
        assertThat(b).hasSize(4);
        for (Number v : b) {
            assertThat(v.doubleValue()).isBetween(0.0, 1.0);
        }
        // Below the clauses: the box is in the page's lower part, from the top, and narrow in height.
        assertThat(b.get(1).doubleValue()).isGreaterThan(0.2);
        assertThat(b.get(3).doubleValue()).isLessThan(0.05);
        Map<String, Object> fields = (Map<String, Object>) m.get("fields");
        assertThat(fields.get("signatures")).isEqualTo(1);
        assertThat(fields.get("signaturesEmpty")).isEqualTo(1);
        assertThat(fields.get("formEmpty")).isEqualTo(1);
    }

    @Test
    @SuppressWarnings("unchecked")
    void aSignedFieldIsNotEmpty() throws IOException {
        byte[] pdf = DocsFixtures.pdf(DocsFixtures.contract("Rosa Ortiz", 2, 2), true, true, null);
        Map<String, Object> fields = (Map<String, Object>) json(serve("docs1 read pdf 200000 500", pdf)).get("fields");
        assertThat(fields.get("signatures")).isEqualTo(1);
        assertThat(fields.get("signaturesEmpty")).isEqualTo(0);
    }

    @Test
    @SuppressWarnings("unchecked")
    void theCapsCutAndSaySo() throws IOException {
        byte[] pdf = DocsFixtures.pdf(DocsFixtures.report(20));
        Map<String, Object> pages = json(serve("docs1 read pdf 200000 5", pdf));
        assertThat(pages.get("pageCount")).isEqualTo(20);
        assertThat((List<?>) pages.get("pages")).hasSize(5);
        assertThat(pages.get("cut")).isEqualTo(true);
        Map<String, Object> chars = json(serve("docs1 read pdf 1000 500", pdf));
        int total = ((List<Map<String, Object>>) chars.get("pages")).stream().mapToInt(p -> ((String) p.get("text")).length()).sum();
        assertThat(total).isLessThanOrEqualTo(1000);
        assertThat(chars.get("cut")).isEqualTo(true);
    }

    @Test
    void aPageIsDrawnAsAJpegAtTheWidthAsked() throws IOException {
        byte[] pdf = DocsFixtures.pdf(DocsFixtures.contract("Northwind", 1, 3));
        Out out = serve("docs1 render 2 800", pdf);
        assertThat(out.refused()).isNull();
        assertThat(out.line()).matches("jpeg 800 [0-9]+");
        BufferedImage img = ImageIO.read(new ByteArrayInputStream(out.body()));
        assertThat(img.getWidth()).isEqualTo(800);
        assertThat(img.getHeight()).isEqualTo(Integer.parseInt(out.line().split(" ")[2]));
        assertThat(img.getHeight()).isBetween(1000, 1060);
        // White paper at the corner, ink somewhere in the middle.
        assertThat(img.getRGB(2, 2) & 0xFFFFFF).isGreaterThan(0xF0F0F0);
    }

    @Test
    void aVeryTallPageIsDrawnSmaller() throws IOException {
        byte[] tall;
        try (org.apache.pdfbox.pdmodel.PDDocument d = new org.apache.pdfbox.pdmodel.PDDocument();
                ByteArrayOutputStream o = new ByteArrayOutputStream()) {
            d.addPage(new org.apache.pdfbox.pdmodel.PDPage(new org.apache.pdfbox.pdmodel.common.PDRectangle(600, 14000)));
            d.save(o);
            tall = o.toByteArray();
        }
        Out out = serve("docs1 render 1 1600", tall);
        String[] f = out.line().split(" ");
        assertThat((long) Integer.parseInt(f[1]) * Integer.parseInt(f[2])).isLessThanOrEqualTo(PdfRender.MAX_PIXELS);
    }

    @Test
    void refusals() throws IOException {
        byte[] pdf = DocsFixtures.pdf(DocsFixtures.contract("Acme", 1, 2));
        assertThat(serve("docs1 render 3 800", pdf).refused()).isEqualTo("not_found");
        byte[] locked = DocsFixtures.pdf(DocsFixtures.contract("Acme", 1, 2), false, false, "pw-123");
        assertThat(serve("docs1 read pdf 1000 10", locked).refused()).isEqualTo("encrypted");
        assertThat(serve("docs1 render 1 800", locked).refused()).isEqualTo("encrypted");
        assertThat(serve("docs1 read pdf 1000 10", "not a pdf at all".getBytes(StandardCharsets.US_ASCII)).refused()).isEqualTo("unreadable");
        assertThat(serve("docs1 read docx 1000 10", Fixtures.zipBomb("word/document.xml", 150)).refused()).isIn("too_complex", "unreadable");
        assertThat(serve("docs1 read pdf 1000 10", new byte[(40 << 20) + 1]).refused()).isEqualTo("too_large");
    }

    @Test
    @SuppressWarnings("unchecked")
    void aScanHasPagesWithNoText() throws IOException {
        Map<String, Object> m = json(serve("docs1 read pdf 1000 10", Fixtures.pdfWithoutText()));
        assertThat((Integer) m.get("pageCount")).isGreaterThan(0);
        assertThat(((List<Map<String, Object>>) m.get("pages")).get(0).get("text")).isEqualTo("");
    }

    @Test
    @SuppressWarnings("unchecked")
    void officeFilesAndTextAreAReadingView() throws IOException {
        Map<String, Object> docx = json(serve("docs1 read docx 100000 500", Fixtures.docx("Meeting notes", "Ship it.")));
        List<Map<String, Object>> s = (List<Map<String, Object>>) docx.get("sections");
        assertThat(s).extracting(x -> x.get("text")).contains("Meeting notes", "Ship it.");
        assertThat((List<?>) docx.get("pages")).isEmpty();
        Map<String, Object> pptx = json(serve("docs1 read pptx 100000 500", Fixtures.pptx()));
        assertThat((List<?>) pptx.get("pages")).isNotEmpty();
        assertThat((List<Map<String, Object>>) pptx.get("sections")).allMatch(x -> "slide".equals(x.get("kind")));
        Map<String, Object> xlsx = json(serve("docs1 read xlsx 100000 500", Fixtures.xlsx()));
        List<Map<String, Object>> sheets = (List<Map<String, Object>>) xlsx.get("sections");
        assertThat(sheets).isNotEmpty().allMatch(x -> "sheet".equals(x.get("kind")) && x.get("rows") instanceof List);
        Map<String, Object> text = json(serve("docs1 read text 100000 500", "Plain\u001b notes\n".getBytes(StandardCharsets.UTF_8)));
        assertThat(((List<Map<String, Object>>) text.get("pages")).get(0).get("text")).isEqualTo("Plain notes");
    }

    @Test
    void jsonIsAlwaysValidWhateverTheText() throws IOException {
        String nasty = "q\"uote \\ back   sep \ud800 lone " + "\u0007bell";
        Map<String, Object> m = json(serve("docs1 read text 100000 500", nasty.getBytes(StandardCharsets.UTF_8)));
        assertThat(m.get("kind")).isEqualTo("text");
    }
}
