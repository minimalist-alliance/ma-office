package com.minimalistalliance.desk.agent.attach.worker;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.io.IOUtils;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.encryption.InvalidPasswordException;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDButton;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;
import org.apache.pdfbox.pdmodel.interactive.form.PDSignatureField;
import org.apache.pdfbox.pdmodel.interactive.form.PDTerminalField;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;

/**
 * A PDF's text a page at a time, with each line's box (0 to 1 of the page's crop box, y from the top), and its empty
 * signature and form fields: what deskd needs to diff two versions page by page and mark the changed lines on the drawn
 * page. Nothing here draws, writes or runs anything of the file's (PDFBox runs no script).
 */
final class PdfPages {

    static final int MAX_LINES = 300;
    /** Lines with boxes in the whole answer (deskd reads at most 400,000 JSON tokens, Security DOC-L1). */
    static final int MAX_LINES_TOTAL = 20_000;
    static final int MAX_FIELDS = 2000;

    private PdfPages() {}

    /** The answer, or a reason. */
    record Read(Map<String, Object> json, String reason) {}

    static Read read(Input input, int maxChars, int maxPages) {
        try (input; PDDocument document = Loader.loadPDF(input, IOUtils.createMemoryOnlyStreamCache())) {
            int pages = document.getNumberOfPages();
            Lines stripper = new Lines();
            stripper.setSortByPosition(true);
            int left = maxChars;
            int linesLeft = MAX_LINES_TOTAL;
            boolean cut = pages > maxPages;
            List<Map<String, Object>> out = new ArrayList<>();
            for (int n = 1; n <= Math.min(pages, maxPages); n++) {
                PDPage page = document.getPage(n - 1);
                PDRectangle box = page.getCropBox();
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("n", n);
                boolean turned = page.getRotation() % 180 != 0;
                float w = turned ? box.getHeight() : box.getWidth();
                float h = turned ? box.getWidth() : box.getHeight();
                p.put("w", (double) w);
                p.put("h", (double) h);
                if (left <= 0) {
                    p.put("text", "");
                    p.put("lines", List.of());
                    cut = true;
                    out.add(p);
                    continue;
                }
                stripper.begin(w, h);
                stripper.setStartPage(n);
                stripper.setEndPage(n);
                String text = ParseWorker.clean(stripper.getText(document)).strip();
                if (text.length() > left) {
                    text = text.substring(0, left);
                    cut = true;
                }
                left -= text.length();
                p.put("text", text);
                List<Map<String, Object>> lines = stripper.lines();
                if (linesLeft < lines.size()) {
                    lines = lines.subList(0, Math.max(0, linesLeft));
                    cut = true;
                }
                linesLeft -= lines.size();
                p.put("lines", lines);
                out.add(p);
            }
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("v", 1);
            json.put("kind", "pdf");
            json.put("pageCount", pages);
            json.put("cut", cut);
            json.put("pages", out);
            json.put("sections", List.of());
            json.put("fields", fields(document));
            return new Read(json, null);
        } catch (InvalidPasswordException e) {
            return new Read(null, "encrypted");
        } catch (ParseWorker.Bomb e) {
            return new Read(null, "too_complex");
        } catch (IOException | RuntimeException e) {
            if (Boolean.getBoolean("ma.attach.debug")) {
                e.printStackTrace();
            }
            return new Read(null, "unreadable");
        }
    }

    /** Signature fields, those not signed, and other fields left empty: counts only. */
    static Map<String, Object> fields(PDDocument document) {
        int signatures = 0;
        int unsigned = 0;
        int empty = 0;
        try {
            // No fix-ups: they'd build appearances, which is drawing the file's own content for nothing.
            PDAcroForm form = document.getDocumentCatalog().getAcroForm(null);
            if (form != null) {
                Iterator<PDField> it = form.getFieldTree().iterator();
                int seen = 0;
                while (it.hasNext() && seen++ < MAX_FIELDS) {
                    PDField field = it.next();
                    if (field instanceof PDSignatureField sig) {
                        signatures++;
                        if (sig.getValue() == null) {
                            unsigned++;
                        }
                    } else if (field instanceof PDTerminalField t && !(t instanceof PDButton) && !t.isReadOnly()) {
                        String v = t.getValueAsString();
                        if (v == null || v.isBlank()) {
                            empty++;
                        }
                    }
                }
            }
        } catch (RuntimeException e) {
            // A broken form counts as none.
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("signatures", signatures);
        out.put("signaturesEmpty", unsigned);
        out.put("formEmpty", empty);
        return out;
    }

    /** The stripper, collecting each line's text and the box of its glyphs for one page at a time. */
    static final class Lines extends PDFTextStripper {
        private final List<Map<String, Object>> lines = new ArrayList<>();
        private final StringBuilder text = new StringBuilder();
        private float pageW = 1;
        private float pageH = 1;
        private float x0;
        private float y0;
        private float x1;
        private float y1;
        private boolean any;

        Lines() throws IOException {
            super();
        }

        void begin(float w, float h) {
            lines.clear();
            text.setLength(0);
            any = false;
            pageW = w <= 0 ? 1 : w;
            pageH = h <= 0 ? 1 : h;
        }

        List<Map<String, Object>> lines() {
            flush();
            return List.copyOf(lines);
        }

        @Override
        protected void writeString(String string, List<TextPosition> positions) throws IOException {
            super.writeString(string, positions);
            text.append(string);
            for (TextPosition t : positions) {
                float x = t.getXDirAdj();
                float top = t.getYDirAdj() - t.getHeightDir();
                float right = x + t.getWidthDirAdj();
                float bottom = t.getYDirAdj();
                if (!any) {
                    x0 = x;
                    y0 = top;
                    x1 = right;
                    y1 = bottom;
                    any = true;
                } else {
                    x0 = Math.min(x0, x);
                    y0 = Math.min(y0, top);
                    x1 = Math.max(x1, right);
                    y1 = Math.max(y1, bottom);
                }
            }
        }

        @Override
        protected void writeWordSeparator() throws IOException {
            super.writeWordSeparator();
            text.append(' ');
        }

        @Override
        protected void writeLineSeparator() throws IOException {
            super.writeLineSeparator();
            flush();
        }

        @Override
        protected void endPage(PDPage page) throws IOException {
            flush();
            super.endPage(page);
        }

        private void flush() {
            String t = ParseWorker.clean(text.toString()).strip();
            text.setLength(0);
            if (any && !t.isEmpty() && lines.size() < MAX_LINES) {
                Map<String, Object> line = new LinkedHashMap<>();
                line.put("t", t.length() > 500 ? t.substring(0, 500) : t);
                line.put("b", List.of(norm(x0 / pageW), norm(y0 / pageH), norm((x1 - x0) / pageW), norm((y1 - y0) / pageH)));
                lines.add(line);
            }
            any = false;
        }

        private static double norm(double v) {
            if (Double.isNaN(v)) {
                return 0;
            }
            return Math.round(Math.max(0, Math.min(1, v)) * 10000.0) / 10000.0;
        }
    }
}
