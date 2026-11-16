package com.minimalistalliance.desk.agent.attach.worker;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Iterator;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.io.IOUtils;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.encryption.InvalidPasswordException;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;

/**
 * One PDF page drawn in the sandbox as a JPEG (white paper, RGB, no metadata): what the office's viewer shows in place of
 * the file. At {@code width} pixels across (200 to 1,600), at most {@link #MAX_PIXELS} in all (a very tall or wide page is
 * drawn smaller), in memory only.
 */
final class PdfRender {

    static final long MAX_PIXELS = 4_000_000L;
    static final int MAX_ANSWER = 4 << 20;
    static final float QUALITY = 0.85f;

    private PdfRender() {}

    static DocsMode.Answer render(Input input, int pageNumber, int width) {
        try (input; PDDocument document = Loader.loadPDF(input, IOUtils.createMemoryOnlyStreamCache())) {
            if (pageNumber > document.getNumberOfPages()) {
                return DocsMode.Answer.refused("not_found");
            }
            PDPage page = document.getPage(pageNumber - 1);
            PDRectangle box = page.getCropBox();
            boolean turned = page.getRotation() % 180 != 0;
            float pw = Math.max(1f, turned ? box.getHeight() : box.getWidth());
            float ph = Math.max(1f, turned ? box.getWidth() : box.getHeight());
            float scale = width / pw;
            if ((double) width * ph * scale > MAX_PIXELS) {
                scale = (float) Math.sqrt(MAX_PIXELS / (pw * (double) ph));
            }
            if (pw * scale < 1 || ph * scale < 1 || pw * scale > 20_000 || ph * scale > 20_000) {
                return DocsMode.Answer.refused("too_complex");
            }
            PDFRenderer renderer = new PDFRenderer(document);
            renderer.setSubsamplingAllowed(true);
            BufferedImage image = renderer.renderImage(pageNumber - 1, scale, ImageType.RGB);
            byte[] jpeg = jpeg(image, QUALITY);
            if (jpeg.length > MAX_ANSWER) {
                jpeg = jpeg(image, 0.6f);
            }
            if (jpeg.length > MAX_ANSWER) {
                return DocsMode.Answer.refused("too_complex");
            }
            return DocsMode.Answer.ok("jpeg " + image.getWidth() + " " + image.getHeight(), jpeg);
        } catch (InvalidPasswordException e) {
            return DocsMode.Answer.refused("encrypted");
        } catch (ParseWorker.Bomb | OutOfMemoryError e) {
            return DocsMode.Answer.refused("too_complex");
        } catch (IOException | RuntimeException e) {
            if (Boolean.getBoolean("ma.attach.debug")) {
                e.printStackTrace();
            }
            return DocsMode.Answer.refused("unreadable");
        }
    }

    /** The default mapper with an empty font list (its class is package-private, so its public setter by reflection). */
    static void noSystemFonts() {
        try {
            org.apache.pdfbox.pdmodel.font.FontMapper mapper = org.apache.pdfbox.pdmodel.font.FontMappers.instance();
            java.lang.reflect.Method set = mapper.getClass().getMethod("setProvider", org.apache.pdfbox.pdmodel.font.FontProvider.class);
            set.setAccessible(true);
            set.invoke(mapper, new org.apache.pdfbox.pdmodel.font.FontProvider() {
                @Override
                public String toDebugString() {
                    return "none";
                }

                @Override
                public java.util.List<? extends org.apache.pdfbox.pdmodel.font.FontInfo> getFontInfo() {
                    return java.util.List.of();
                }
            });
        } catch (ReflectiveOperationException | RuntimeException e) {
            // Left as it is: a font the manager refuses then makes that page unreadable, never anything worse.
        }
    }

    static byte[] jpeg(BufferedImage image, float quality) throws IOException {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
        if (!writers.hasNext()) {
            throw new IOException("jpeg");
        }
        ImageWriter writer = writers.next();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(256 * 1024);
        try (MemoryCacheImageOutputStream out = new MemoryCacheImageOutputStream(bytes)) {
            writer.setOutput(out);
            ImageWriteParam param = writer.getDefaultWriteParam();
            param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            param.setCompressionQuality(quality);
            writer.write(null, new IIOImage(image, null, null), param);
        } finally {
            writer.dispose();
        }
        return bytes.toByteArray();
    }

    /**
     * Before the security manager: PDFBox's font mapping (it looks for the system's fonts once, and falls back to its own
     * bundled ones), its glyph lists, the renderer, the text stripper and ImageIO's JPEG writer, each set up by drawing and
     * reading a small PDF of our own. No font cache is written: the cache's folder is pointed at one that can't be made.
     *
     * <p><b>No system fonts.</b> PDFBox finds the system's font files at set-up but opens each lazily, the first time a page
     * names it, which the manager then refuses. So the mapper is given no fonts at all: every font a PDF doesn't embed is
     * drawn with PDFBox's own bundled one (Liberation Sans, from its jar), the same on every desk, and nothing outside the
     * jars is ever opened.
     */
    static void warmUp() {
        if (System.getProperty("pdfbox.fontcache") == null) {
            System.setProperty("pdfbox.fontcache", "/nonexistent-docs-font-cache");
        }
        noSystemFonts();
        try (PDDocument document = new PDDocument()) {
            PDPage page = new PDPage(PDRectangle.A4);
            document.addPage(page);
            try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                content.beginText();
                content.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 12);
                content.newLineAtOffset(72, 720);
                content.showText("Warm 1");
                content.setFont(new PDType1Font(Standard14Fonts.FontName.TIMES_BOLD), 12);
                content.newLineAtOffset(0, -16);
                content.showText("Warm 2");
                content.endText();
                content.addRect(72, 600, 100, 50);
                content.fill();
            }
            ByteArrayOutputStream saved = new ByteArrayOutputStream();
            document.save(saved);
            try (PDDocument again = Loader.loadPDF(saved.toByteArray())) {
                new PDFTextStripper().getText(again);
                PdfPages.Lines lines = new PdfPages.Lines();
                lines.begin(595, 842);
                lines.getText(again);
                PDFRenderer renderer = new PDFRenderer(again);
                BufferedImage image = renderer.renderImage(0, 0.5f, ImageType.RGB);
                jpeg(image, QUALITY);
                PdfPages.fields(again);
            }
        } catch (IOException | RuntimeException e) {
            // Rendering then fails closed under the manager as unreadable, never as anything worse.
        }
    }
}
