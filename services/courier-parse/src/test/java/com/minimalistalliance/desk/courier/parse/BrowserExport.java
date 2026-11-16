package com.minimalistalliance.desk.courier.parse;

import com.minimalistalliance.desk.courier.testkit.HostileHtml;
import com.minimalistalliance.desk.courier.testkit.MimeCorpus;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.SplittableRandom;
import org.junit.jupiter.api.Test;

/**
 * Writes the sanitizer's output for the real-browser check ({@code scripts/browser-check.mjs}): every hostile vector with
 * its counting URLs pointed at the check's own server, every corpus message's HTML, and mutated HTML. Runs only with
 * {@code -Dcourier.browser.out=DIR -Dcourier.browser.hit=http://127.0.0.1:PORT/hit}; otherwise it does nothing.
 */
class BrowserExport {

    @Test
    void export() throws Exception {
        String dir = System.getProperty("courier.browser.out");
        String hit = System.getProperty("courier.browser.hit");
        if (dir == null || hit == null) {
            return;
        }
        Path out = Path.of(dir);
        Files.createDirectories(out);
        int n = 0;
        for (HostileHtml.Vector v : HostileHtml.vectors(hit)) {
            n = write(out, n, "vector-" + v.name(), Html.sanitize(v.html(), new Html.Budget()).html());
        }
        for (MimeCorpus.Sample s : MimeCorpus.standard().toList()) {
            try {
                Map<String, Object> m = Mime.message(new ByteArrayInputStream(s.raw()), Mime.Deadline.none());
                n = write(out, n, "corpus-" + s.name(), (String) m.get("html"));
            } catch (Refusal refused) {
                // Refused mail has no HTML to show.
            }
        }
        SplittableRandom r = new SplittableRandom(Long.getLong("courier.browser.seed", 7L));
        var vectors = HostileHtml.vectors(hit);
        int fuzz = Integer.getInteger("courier.browser.fuzz", 5000);
        for (int i = 0; i < fuzz; i++) {
            String a = vectors.get(r.nextInt(vectors.size())).html();
            String b = vectors.get(r.nextInt(vectors.size())).html();
            String input = CourierFuzzTest.Mutate.html(a, b, r).replace("http://hit.invalid/hit", hit);
            n = write(out, n, "fuzz-" + i, Html.sanitize(input, new Html.Budget()).html());
        }
        // The control: vectors as they are, unsanitized, which the check must catch, or it proves nothing.
        Path control = Path.of(dir + "-control");
        Files.createDirectories(control);
        int c = 0;
        for (HostileHtml.Vector v : vectors) {
            c = write(control, c, "raw-" + v.name(), v.html());
        }
        System.out.println("browser export: " + n + " documents, " + c + " controls");
    }

    private static int write(Path out, int n, String name, String html) throws Exception {
        if (html == null || html.isEmpty()) {
            return n;
        }
        Files.writeString(out.resolve(String.format("%06d.html", n)), html, StandardCharsets.UTF_8);
        Files.writeString(out.resolve(String.format("%06d.name", n)), name, StandardCharsets.UTF_8);
        return n + 1;
    }
}
