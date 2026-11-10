package com.minimalistalliance.desk.deskd.browser.minified;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.InputStream;
import java.io.StringReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Properties;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

/**
 * One distiller, not two: deskd's {@code distiller.js} is the prototype's {@code extract.js} at the commit
 * {@code distiller.pin} names, byte for byte ({@code services/scripts/sync-distiller.sh}). A hand edit to deskd's copy
 * fails here, and so does a copy that isn't the prototype's at the pinned commit, wherever git has that commit.
 */
class DistillerPinTest {

    private static final String BASE = "/com/minimalistalliance/desk/deskd/browser/minified/";

    private static byte[] resource(String name) throws IOException {
        try (InputStream in = DistillerPinTest.class.getResourceAsStream(BASE + name)) {
            assertThat(in).as(name).isNotNull();
            return in.readAllBytes();
        }
    }

    private static Properties pin() throws IOException {
        Properties pin = new Properties();
        pin.load(new StringReader(new String(resource("distiller.pin"), java.nio.charset.StandardCharsets.UTF_8)));
        return pin;
    }

    @Test
    void deskdsCopyIsTheOneThePinNames() throws Exception {
        Properties pin = pin();
        assertThat(pin.getProperty("commit")).matches("[0-9a-f]{40}");
        assertThat(pin.getProperty("path")).isEqualTo("spikes/browser-bench/minified-proto/server/extract.js");
        String sum = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(resource("distiller.js")));
        assertThat(sum).as("distiller.js was edited by hand: run services/scripts/sync-distiller.sh").isEqualTo(pin.getProperty("sha256"));
    }

    @Test
    void deskdsCopyIsThePrototypesAtThePinnedCommit() throws Exception {
        Properties pin = pin();
        Path root = repoRoot();
        Assumptions.assumeTrue(root != null, "not in a git checkout");
        Process show = new ProcessBuilder("git", "-C", root.toString(), "show", pin.getProperty("commit") + ":" + pin.getProperty("path"))
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        byte[] prototype = show.getInputStream().readAllBytes();
        Assumptions.assumeTrue(show.waitFor(30, TimeUnit.SECONDS) && show.exitValue() == 0, "the pinned commit isn't fetched here");
        assertThat(resource("distiller.js")).as("deskd's distiller.js differs from the prototype at the pinned commit").isEqualTo(prototype);
    }

    @Test
    void whatDeskdCutsIsGoneAndWhatItCallsIsThere() {
        Scripts scripts = Scripts.load();
        // The distiller's part, before deskd's own half (which has a prepare of its own, deskd's).
        String top = scripts.top.substring(0, scripts.top.length() - scripts.frame.length());
        for (String name : Scripts.LEFT_OUT) {
            assertThat(top).as(name).doesNotContain("function " + name + "(");
        }
        assertThat(top).contains("value: Object.freeze({ extractText, lookup, quiet, epoch: EPOCH, setRules, hasRules: () => !!RULES })")
                .contains("M.setRules({").doesNotContain("addEventListener(t, guardHandler");
    }

    @Test
    void aPrototypeDeskdCantFollowFailsToLoadRatherThanShip() {
        String source = "(() => {\n  function hit(r) {\n    return 1;\n  }\n  const x = () => hit(1);\n"
                + "  Object.defineProperty(window, '__mdoc', {\n    value: Object.freeze({ hit }),\n  });\n})();\n";
        assertThatThrownBy(() -> Scripts.adapt(source, "", "{}")).hasMessageContaining("hit is still there");
        assertThatThrownBy(() -> Scripts.adapt("(() => {})();", "", "{}")).hasMessageContaining("no __mdoc export");
    }

    /** v9's adVendorBox has a hit of its own: a call to a function's own local is no call to the cut hit. */
    @Test
    void aFunctionsOwnLocalOfACutNameLoadsButACallElsewhereStillFails() {
        String export = "  Object.defineProperty(window, '__mdoc', {\n    value: 1,\n  });\n})();\n";
        String cut = "  function hit(r) {\n    return 1;\n  }\n";
        String own = "  function vendor(box) {\n    const hit = (p) => p > 1;\n    if (hit(box)) return true;\n    return false;\n  }\n";
        String adapted = Scripts.adapt("(() => {\n" + cut + own + export, "", "{}");
        assertThat(adapted).doesNotContain("function hit(").contains("if (hit(box)) return true;");

        String sibling = "  function other(box) {\n    return hit(box);\n  }\n";
        assertThatThrownBy(() -> Scripts.adapt("(() => {\n" + cut + own + sibling + export, "", "{}"))
                .hasMessageContaining("hit is still there");
        String before = "  function early(box) {\n    if (hit(box)) return 1;\n    const hit = 2;\n  }\n";
        assertThatThrownBy(() -> Scripts.adapt("(() => {\n" + cut + before + export, "", "{}"))
                .hasMessageContaining("hit is still there");
    }

    private static Path repoRoot() throws InterruptedException {
        try {
            Process top = new ProcessBuilder("git", "rev-parse", "--show-toplevel").redirectError(ProcessBuilder.Redirect.DISCARD).start();
            String out = new String(top.getInputStream().readAllBytes()).strip();
            return top.waitFor(10, TimeUnit.SECONDS) && top.exitValue() == 0 && !out.isEmpty() && Files.isDirectory(Path.of(out)) ? Path.of(out) : null;
        } catch (IOException e) {
            return null;
        }
    }
}
