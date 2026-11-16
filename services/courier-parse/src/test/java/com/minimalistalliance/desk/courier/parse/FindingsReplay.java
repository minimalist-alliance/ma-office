package com.minimalistalliance.desk.courier.parse;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** Replays the fuzzer's kept inputs ({@code -Dcourier.findings=DIR}) and prints what the oracle saw. Does nothing without it. */
class FindingsReplay {

    @Test
    void replay() throws Exception {
        String dir = System.getProperty("courier.findings");
        if (dir == null) {
            return;
        }
        try (var files = Files.list(Path.of(dir))) {
            for (Path p : files.sorted().toList()) {
                String input = Files.readString(p, StandardCharsets.UTF_8);
                Html.Result r = Html.sanitize(input, new Html.Budget());
                System.out.println("== " + p.getFileName() + " escapes " + HostileHtmlTest.escapes(r.html()) + " verify "
                        + (r.html() == null || Html.verify(r.html())));
                System.out.println("in:  " + input.replace("\n", "\\n").substring(0, Math.min(600, input.length())));
                System.out.println("out: " + (r.html() == null ? null : r.html().replace("\n", "\\n").substring(0, Math.min(600, r.html().length()))));
            }
        }
    }
}
