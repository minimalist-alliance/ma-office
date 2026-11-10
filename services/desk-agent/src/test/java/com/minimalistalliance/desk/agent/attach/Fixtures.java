package com.minimalistalliance.desk.agent.attach;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;

/** Files built in memory for the attachment tests: nothing is read from or written to disk. */
public final class Fixtures {

    private Fixtures() {}

    public static byte[] pdf(int pages, String line) {
        try (PDDocument document = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            for (int i = 0; i < pages; i++) {
                PDPage page = new PDPage();
                document.addPage(page);
                try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                    content.beginText();
                    content.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 12);
                    content.newLineAtOffset(72, 700);
                    content.showText(line + " page " + (i + 1));
                    content.endText();
                }
            }
            document.save(out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A PDF whose font is named but not embedded (the reader must map it to a system font, and find none or some). */
    public static byte[] pdfWithUnembeddedFont(String fontName, String line) {
        try (PDDocument document = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            PDPage page = new PDPage();
            document.addPage(page);
            org.apache.pdfbox.cos.COSDictionary dict = new org.apache.pdfbox.cos.COSDictionary();
            dict.setItem(org.apache.pdfbox.cos.COSName.TYPE, org.apache.pdfbox.cos.COSName.FONT);
            dict.setItem(org.apache.pdfbox.cos.COSName.SUBTYPE, org.apache.pdfbox.cos.COSName.TRUE_TYPE);
            dict.setName(org.apache.pdfbox.cos.COSName.BASE_FONT, fontName);
            dict.setItem(org.apache.pdfbox.cos.COSName.ENCODING, org.apache.pdfbox.cos.COSName.WIN_ANSI_ENCODING);
            org.apache.pdfbox.pdmodel.font.PDFont font = org.apache.pdfbox.pdmodel.font.PDFontFactory.createFont(dict);
            try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                content.beginText();
                content.setFont(font, 12);
                content.newLineAtOffset(72, 700);
                content.showText(line);
                content.endText();
            }
            document.save(out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    public static byte[] pdfWithoutText() {
        try (PDDocument document = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            document.addPage(new PDPage());
            document.save(out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    public static byte[] zip(Map<String, byte[]> parts) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream(); ZipOutputStream zip = new ZipOutputStream(out)) {
            for (Map.Entry<String, byte[]> part : parts.entrySet()) {
                zip.putNextEntry(new ZipEntry(part.getKey()));
                zip.write(part.getValue());
                zip.closeEntry();
            }
            zip.finish();
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    public static byte[] docx(String... paragraphs) {
        StringBuilder body = new StringBuilder();
        for (String paragraph : paragraphs) {
            body.append("<w:p><w:r><w:t>").append(paragraph).append("</w:t></w:r></w:p>");
        }
        Map<String, byte[]> parts = new LinkedHashMap<>();
        parts.put("[Content_Types].xml", utf8("<Types/>"));
        parts.put("word/document.xml", utf8("<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats"
                + ".org/wordprocessingml/2006/main\"><w:body>" + body + "</w:body></w:document>"));
        return zip(parts);
    }

    public static byte[] xlsx() {
        Map<String, byte[]> parts = new LinkedHashMap<>();
        parts.put("xl/worksheets/sheet1.xml", utf8("<worksheet><sheetData>"
                + "<row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></row>"
                + "<row r=\"2\"><c r=\"A2\"><v>42</v></c><c r=\"C2\" t=\"inlineStr\"><is><t>inline</t></is></c></row>"
                + "</sheetData></worksheet>"));
        parts.put("xl/sharedStrings.xml", utf8("<sst><si><t>Name</t></si><si><r><t>Total</t></r></si></sst>"));
        parts.put("xl/workbook.xml", utf8("<workbook xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/"
                + "relationships\"><sheets><sheet name=\"Budget\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"));
        parts.put("xl/_rels/workbook.xml.rels", utf8("<Relationships><Relationship Id=\"rId1\" "
                + "Target=\"worksheets/sheet1.xml\"/></Relationships>"));
        return zip(parts);
    }

    public static byte[] pptx() {
        Map<String, byte[]> parts = new LinkedHashMap<>();
        parts.put("ppt/slides/slide2.xml", utf8("<p:sld xmlns:p=\"urn:p\" xmlns:a=\"urn:a\"><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>"));
        parts.put("ppt/slides/slide1.xml", utf8("<p:sld xmlns:p=\"urn:p\" xmlns:a=\"urn:a\"><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>"));
        parts.put("ppt/notesSlides/notesSlide1.xml", utf8("<p:notes xmlns:p=\"urn:p\" xmlns:a=\"urn:a\"><a:p><a:r><a:t>Say hello</a:t></a:r></a:p></p:notes>"));
        return zip(parts);
    }

    /** A real PNG header with the declared size and nothing after it: enough for the header check, not a picture. */
    public static byte[] png(int width, int height) {
        byte[] bytes = new byte[64];
        byte[] magic = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
        System.arraycopy(magic, 0, bytes, 0, 8);
        bytes[8] = 0;
        bytes[11] = 13;
        bytes[12] = 'I';
        bytes[13] = 'H';
        bytes[14] = 'D';
        bytes[15] = 'R';
        for (int i = 0; i < 4; i++) {
            bytes[16 + i] = (byte) (width >>> (24 - 8 * i));
            bytes[20 + i] = (byte) (height >>> (24 - 8 * i));
        }
        return bytes;
    }

    public static byte[] jpeg(int width, int height) {
        return new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 4, 0, 0, (byte) 0xFF, (byte) 0xC0, 0, 11,
            8, (byte) (height >> 8), (byte) height, (byte) (width >> 8), (byte) width, 1, 1, 0x11, 0, 0, 0, 0};
    }

    /** A zip of one entry that inflates to {@code megabytes} of zeros: a few KB on the wire. */
    public static byte[] zipBomb(String entry, int megabytes) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream(); ZipOutputStream zip = new ZipOutputStream(out)) {
            zip.putNextEntry(new ZipEntry(entry));
            byte[] zeros = new byte[1 << 20];
            for (int i = 0; i < megabytes; i++) {
                zip.write(zeros);
            }
            zip.closeEntry();
            zip.finish();
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    public static long crc(byte[] bytes) {
        CRC32 crc = new CRC32();
        crc.update(bytes);
        return crc.getValue();
    }
}
