package com.minimalistalliance.desk.agent.attach.worker;

import java.io.IOException;
import java.io.Writer;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.encryption.InvalidPasswordException;
import org.apache.pdfbox.text.PDFTextStripper;

/** A PDF's text layer, page order, up to a page cap and a character cap. A scan has none, and says so. */
final class PdfText {

    private PdfText() {}

    static ParseWorker.Result read(byte[] bytes, int maxChars, int maxPages) {
        ParseWorker.Capped out = new ParseWorker.Capped(maxChars);
        boolean pagesCut;
        try (PDDocument document = Loader.loadPDF(bytes)) {
            int pages = document.getNumberOfPages();
            pagesCut = pages > maxPages;
            PDFTextStripper stripper = new PDFTextStripper();
            stripper.setStartPage(1);
            stripper.setEndPage(Math.min(pages, maxPages));
            try {
                stripper.writeText(document, new CappedWriter(out));
            } catch (Full e) {
                // The cap, not a failure.
            }
        } catch (InvalidPasswordException e) {
            return ParseWorker.Result.error("encrypted");
        } catch (IOException e) {
            return ParseWorker.Result.error("unreadable");
        }
        String text = out.toString().strip();
        if (text.isEmpty()) {
            return ParseWorker.Result.error("no_text");
        }
        return ParseWorker.Result.ok(text, out.full() || pagesCut ? "cut" : null);
    }

    /** Thrown to stop the stripper once the cap is reached. */
    private static final class Full extends IOException {
        private static final long serialVersionUID = 1L;

        Full() {
            super("cap");
        }
    }

    private static final class CappedWriter extends Writer {
        private final ParseWorker.Capped out;

        CappedWriter(ParseWorker.Capped out) {
            this.out = out;
        }

        @Override
        public void write(char[] buffer, int offset, int length) throws IOException {
            if (!out.append(new String(buffer, offset, length))) {
                throw new Full();
            }
        }

        @Override
        public void flush() {}

        @Override
        public void close() {}
    }
}
