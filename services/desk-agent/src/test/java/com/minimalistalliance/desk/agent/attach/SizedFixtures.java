package com.minimalistalliance.desk.agent.attach;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.SplittableRandom;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.graphics.color.PDDeviceRGB;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;

/**
 * Files of a given size, for the worker's memory at the per-file ceiling ({@code scripts/measure-attach.sh --sizes} and
 * the worker's 20 MiB tests). Built in memory and the same on every run (a fixed seed). Each is at most the size asked
 * and within about 1% of it:
 * <ul>
 * <li>{@link #text}: lines of random words, some with a curly apostrophe, an en dash or an accented letter;</li>
 * <li>{@link #textPdf}: dense pages of words, its content streams deflated as PDF writers do;</li>
 * <li>{@link #imagePdf}: a page per 2 MiB picture (random bytes labelled JPEG, never decoded for text) and a line;</li>
 * <li>{@link #docx}, {@link #pptx}: text in their XML (about 40% and 10% of the size, deflated) and pictures for the
 * rest, stored, as Office keeps JPEGs;</li>
 * <li>{@link #xlsx}: one sheet of data rows (numbers and shared strings) and nothing else, deflated: the heavy case.</li>
 * </ul>
 */
public final class SizedFixtures {

    private static final int PICTURE = 2 << 20;

    private SizedFixtures() {}

    /** Random words, with now and then a character outside ASCII when {@code prose} (prose has them; Helvetica's WinAnsi too). */
    static final class Words {
        private final SplittableRandom random;
        private final boolean prose;

        Words(long seed, boolean prose) {
            this.random = new SplittableRandom(seed);
            this.prose = prose;
        }

        String word() {
            int length = 2 + random.nextInt(9);
            char[] letters = new char[length];
            for (int i = 0; i < length; i++) {
                letters[i] = (char) ('a' + random.nextInt(26));
            }
            String word = new String(letters);
            if (prose) {
                switch (random.nextInt(120)) {
                    case 0 -> word = word + "’s";
                    case 1 -> word = "café";
                    case 2 -> word = "–";
                    default -> { }
                }
            }
            return word;
        }

        String line(int chars) {
            StringBuilder line = new StringBuilder(chars + 12);
            while (line.length() < chars) {
                if (!line.isEmpty()) {
                    line.append(' ');
                }
                line.append(word());
            }
            return line.toString();
        }

        void bytes(byte[] into) {
            for (int i = 0; i < into.length; i += 8) {
                long value = random.nextLong();
                for (int j = 0; j < 8 && i + j < into.length; j++) {
                    into[i + j] = (byte) (value >>> (8 * j));
                }
            }
        }

        int number(int bound) {
            return random.nextInt(bound);
        }
    }

    // ---------------------------------------------------------------- text

    public static byte[] text(int size) {
        Words words = new Words(1, true);
        ByteArrayOutputStream out = new ByteArrayOutputStream(size);
        while (out.size() < size) {
            byte[] line = (words.line(60 + words.number(40)) + "\n").getBytes(StandardCharsets.UTF_8);
            out.write(line, 0, Math.min(line.length, size - out.size()));
        }
        byte[] bytes = out.toByteArray();
        // A line cut inside a character: end on ASCII instead, so the file is valid UTF-8 to its last byte.
        for (int i = Math.max(0, bytes.length - 4); i < bytes.length; i++) {
            if ((bytes[i] & 0x80) != 0) {
                bytes[i] = '.';
            }
        }
        return bytes;
    }

    // ----------------------------------------------------------------- pdf

    public static byte[] textPdf(int size) {
        int[] probe = {20, 120};
        int a = textPdfPages(probe[0], size).length;
        int b = textPdfPages(probe[1], size).length;
        double perPage = (b - a) / (double) (probe[1] - probe[0]);
        int pages = Math.max(1, (int) ((size - (a - perPage * probe[0])) / perPage));
        byte[] pdf = textPdfPages(pages, size);
        while (pdf.length > size && pages > 1) {
            pages -= Math.max(1, (int) Math.ceil((pdf.length - size) / perPage));
            pdf = textPdfPages(pages, size);
        }
        return pdf;
    }

    private static byte[] textPdfPages(int pages, int size) {
        Words words = new Words(2, false);
        try (PDDocument document = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream(size)) {
            PDType1Font font = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
            for (int i = 0; i < pages; i++) {
                PDPage page = new PDPage();
                document.addPage(page);
                try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                    content.beginText();
                    content.setFont(font, 8);
                    content.setLeading(10);
                    content.newLineAtOffset(40, 760);
                    content.showText("Page " + (i + 1));
                    for (int line = 0; line < 70; line++) {
                        content.newLine();
                        content.showText(words.line(110));
                    }
                    content.endText();
                }
            }
            document.save(out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    public static byte[] imagePdf(int size) {
        int pages = Math.max(1, size / PICTURE);
        byte[] small = imagePdfPictures(pages, 1024);
        int picture = Math.max(1024, (size - (small.length - pages * 1024)) / pages);
        byte[] pdf = imagePdfPictures(pages, picture);
        while (pdf.length > size && picture > 1024) {
            picture -= (pdf.length - size + pages - 1) / pages;
            pdf = imagePdfPictures(pages, picture);
        }
        return pdf;
    }

    private static byte[] imagePdfPictures(int pages, int picture) {
        Words words = new Words(3, false);
        byte[] bytes = new byte[picture];
        try (PDDocument document = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            PDType1Font font = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
            for (int i = 0; i < pages; i++) {
                PDPage page = new PDPage();
                document.addPage(page);
                COSStream stream = document.getDocument().createCOSStream();
                words.bytes(bytes);
                try (OutputStream raw = stream.createRawOutputStream()) {
                    raw.write(bytes);
                }
                stream.setItem(COSName.FILTER, COSName.DCT_DECODE);
                PDImageXObject image = new PDImageXObject(new PDStream(stream), null);
                image.setWidth(1600);
                image.setHeight(1200);
                image.setBitsPerComponent(8);
                image.setColorSpace(PDDeviceRGB.INSTANCE);
                try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                    content.drawImage(image, 72, 300, 468, 351);
                    content.beginText();
                    content.setFont(font, 11);
                    content.newLineAtOffset(72, 260);
                    content.showText("Figure " + (i + 1) + ": " + words.line(60));
                    content.endText();
                }
            }
            document.save(out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------------------------------------------------------------- zips

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    /** The parts deflated, then stored pictures under {@code media} to bring the zip to {@code size}. */
    private static byte[] padded(Map<String, byte[]> parts, String media, int size) {
        int base = zip(parts, media, List.of()).length;
        int room = size - base;
        if (room <= 0) {
            return zip(parts, media, List.of());
        }
        int count = (room + PICTURE - 1) / PICTURE;
        int perEntry = 30 + 46 + 2 * (media.length() + 12);
        List<Integer> sizes = new ArrayList<>();
        int each = Math.max(0, (room - count * perEntry) / count);
        for (int i = 0; i < count; i++) {
            sizes.add(each);
        }
        byte[] zip = zip(parts, media, sizes);
        int last = sizes.size() - 1;
        sizes.set(last, Math.max(0, sizes.get(last) + size - zip.length));
        return zip(parts, media, sizes);
    }

    private static byte[] zip(Map<String, byte[]> parts, String media, List<Integer> pictures) {
        Words random = new Words(4, false);
        try (ByteArrayOutputStream out = new ByteArrayOutputStream(); ZipOutputStream zip = new ZipOutputStream(out)) {
            for (Map.Entry<String, byte[]> part : parts.entrySet()) {
                zip.putNextEntry(new ZipEntry(part.getKey()));
                zip.write(part.getValue());
                zip.closeEntry();
            }
            for (int i = 0; i < pictures.size(); i++) {
                byte[] bytes = new byte[pictures.get(i)];
                random.bytes(bytes);
                ZipEntry entry = new ZipEntry(media + String.format("image%03d.jpeg", i + 1));
                entry.setMethod(ZipEntry.STORED);
                entry.setSize(bytes.length);
                entry.setCompressedSize(bytes.length);
                CRC32 crc = new CRC32();
                crc.update(bytes);
                entry.setCrc(crc.getValue());
                zip.putNextEntry(entry);
                zip.write(bytes);
                zip.closeEntry();
            }
            zip.finish();
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    public static byte[] docx(int size) {
        Words words = new Words(5, true);
        StringBuilder body = new StringBuilder();
        body.append("<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/"
                + "main\"><w:body>");
        int text = size / 5 * 2;
        while (body.length() < text) {
            body.append("<w:p><w:pPr><w:pStyle w:val=\"Normal\"/></w:pPr><w:r><w:t xml:space=\"preserve\">")
                    .append(words.line(300 + words.number(300))).append("</w:t></w:r></w:p>");
        }
        body.append("</w:body></w:document>");
        Map<String, byte[]> parts = new LinkedHashMap<>();
        parts.put("[Content_Types].xml", utf8("<Types/>"));
        parts.put("word/document.xml", utf8(body.toString()));
        return padded(parts, "word/media/", size);
    }

    public static byte[] pptx(int size) {
        Words words = new Words(6, true);
        Map<String, byte[]> parts = new LinkedHashMap<>();
        parts.put("[Content_Types].xml", utf8("<Types/>"));
        int text = size / 10;
        int written = 0;
        for (int slide = 1; written < text; slide++) {
            StringBuilder xml = new StringBuilder("<p:sld xmlns:p=\"urn:p\" xmlns:a=\"urn:a\"><p:cSld><p:spTree>");
            for (int p = 0; p < 8; p++) {
                xml.append("<p:sp><p:txBody><a:p><a:r><a:rPr lang=\"en-US\"/><a:t>").append(words.line(120))
                        .append("</a:t></a:r></a:p></p:txBody></p:sp>");
            }
            xml.append("</p:spTree></p:cSld></p:sld>");
            String notes = "<p:notes xmlns:p=\"urn:p\" xmlns:a=\"urn:a\"><a:p><a:r><a:t>" + words.line(400)
                    + "</a:t></a:r></a:p></p:notes>";
            parts.put("ppt/slides/slide" + slide + ".xml", utf8(xml.toString()));
            parts.put("ppt/notesSlides/notesSlide" + slide + ".xml", utf8(notes));
            written += xml.length() + notes.length();
        }
        return padded(parts, "ppt/media/", size);
    }

    /** One sheet of rows until the zip is about {@code size}: shared strings, whole numbers, decimals and dates. */
    public static byte[] xlsx(int size) {
        Words words = new Words(7, true);
        int pool = 20_000;
        StringBuilder shared = new StringBuilder("<sst count=\"" + pool + "\">");
        for (int i = 0; i < pool; i++) {
            shared.append("<si><t>").append(words.line(4 + words.number(20))).append("</t></si>");
        }
        shared.append("</sst>");
        try (ByteArrayOutputStream out = new ByteArrayOutputStream(size); ZipOutputStream zip = new ZipOutputStream(out)) {
            Map<String, byte[]> parts = new LinkedHashMap<>();
            parts.put("[Content_Types].xml", utf8("<Types/>"));
            parts.put("xl/workbook.xml", utf8("<workbook xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/"
                    + "2006/relationships\"><sheets><sheet name=\"Data\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"));
            parts.put("xl/_rels/workbook.xml.rels", utf8("<Relationships><Relationship Id=\"rId1\" "
                    + "Target=\"worksheets/sheet1.xml\"/></Relationships>"));
            parts.put("xl/sharedStrings.xml", utf8(shared.toString()));
            for (Map.Entry<String, byte[]> part : parts.entrySet()) {
                zip.putNextEntry(new ZipEntry(part.getKey()));
                zip.write(part.getValue());
                zip.closeEntry();
            }
            zip.putNextEntry(new ZipEntry("xl/worksheets/sheet1.xml"));
            Writer sheet = new java.io.OutputStreamWriter(zip, StandardCharsets.UTF_8);
            sheet.write("<worksheet><sheetData>");
            String[] columns = {"A", "B", "C", "D", "E", "F", "G", "H"};
            // The deflater holds up to about 64 KiB before out sees it; stop short of that and the central directory.
            for (int row = 1; out.size() < size - (160 << 10); row++) {
                StringBuilder xml = new StringBuilder(400);
                xml.append("<row r=\"").append(row).append("\">");
                for (int c = 0; c < columns.length; c++) {
                    String ref = columns[c] + row;
                    switch (c) {
                        case 0, 3, 6 -> xml.append("<c r=\"").append(ref).append("\" t=\"s\"><v>")
                                .append(words.number(pool)).append("</v></c>");
                        case 1 -> xml.append("<c r=\"").append(ref).append("\"><v>").append(words.number(1_000_000))
                                .append("</v></c>");
                        case 5 -> xml.append("<c r=\"").append(ref).append("\" s=\"2\"><v>")
                                .append(40_000 + words.number(10_000)).append("</v></c>");
                        default -> xml.append("<c r=\"").append(ref).append("\" s=\"1\"><v>")
                                .append(words.number(100_000)).append('.').append(words.number(100)).append("</v></c>");
                    }
                }
                xml.append("</row>");
                sheet.write(xml.toString());
                if (row % 64 == 0) {
                    sheet.flush();
                }
            }
            sheet.write("</sheetData></worksheet>");
            sheet.flush();
            zip.closeEntry();
            zip.finish();
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Every kind {@code measure-attach.sh --sizes} reads, by the name it prints. */
    public static Map<String, byte[]> all(int size) {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("text", text(size));
        files.put("pdf-text", textPdf(size));
        files.put("pdf-image", imagePdf(size));
        files.put("docx", docx(size));
        files.put("xlsx", xlsx(size));
        files.put("pptx", pptx(size));
        return files;
    }
}
