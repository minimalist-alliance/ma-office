package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.text.Normalizer;
import org.junit.jupiter.api.Test;

class PathRulesTest {

    private static String reason(Object path) {
        try {
            PathRules.parse(path, false, "path");
            return "ok";
        } catch (RpcException e) {
            return (String) e.details().get("reason");
        }
    }

    @Test
    void goodPathsParseIntoComponents() throws Exception {
        assertThat(PathRules.parse("a/b/c.txt", false, "path")).containsExactly("a", "b", "c.txt");
        assertThat(PathRules.parse("", true, "path")).isEmpty();
        assertThat(PathRules.parse(".hidden/ok .dot", false, "path")).containsExactly(".hidden", "ok .dot");
        assertThat(PathRules.parse("a/.uploads", false, "path")).containsExactly("a", ".uploads");
    }

    @Test
    void theRootIsOnlyWhereAMethodAllowsIt() {
        assertThat(reason("")).isEqualTo("empty");
        assertThatThrownBy(() -> PathRules.parse(5L, false, "path")).isInstanceOf(RpcException.class)
                .extracting(e -> ((RpcException) e).code()).isEqualTo("bad_request");
    }

    @Test
    void emptyComponentsAreRefused() {
        assertThat(reason("/a")).isEqualTo("empty");
        assertThat(reason("a/")).isEqualTo("empty");
        assertThat(reason("a//b")).isEqualTo("empty");
    }

    @Test
    void dotsAreRefused() {
        assertThat(reason("a/./b")).isEqualTo("dots");
        assertThat(reason("a/../b")).isEqualTo("dots");
        assertThat(reason("..")).isEqualTo("dots");
        assertThat(reason("...")).isEqualTo("ok");
    }

    @Test
    void controlCharactersBackslashesAndBidiOverridesAreRefused() {
        assertThat(reason("a\u0000b")).isEqualTo("chars");
        assertThat(reason("a\nb")).isEqualTo("chars");
        assertThat(reason("a\u007fb")).isEqualTo("chars");
        assertThat(reason("a\u0085b")).isEqualTo("chars");
        assertThat(reason("a\\b")).isEqualTo("chars");
        assertThat(reason("a‮b")).isEqualTo("chars");
        assertThat(reason("a⁦b")).isEqualTo("chars");
        assertThat(reason("a\ud800b")).isEqualTo("chars");
    }

    @Test
    void nonNfcNamesAreRefusedNotRewritten() {
        String decomposed = Normalizer.normalize("é", Normalizer.Form.NFD);
        assertThat(decomposed).hasSize(2);
        assertThat(reason(decomposed + ".txt")).isEqualTo("nfc");
        assertThat(reason("é.txt")).isEqualTo("ok");
    }

    @Test
    void lengthLimitsAreInBytes() {
        assertThat(reason("a".repeat(255))).isEqualTo("ok");
        assertThat(reason("a".repeat(256))).isEqualTo("length");
        // 128 two-byte characters are 256 bytes.
        assertThat(reason("é".repeat(128))).isEqualTo("length");
        assertThat(reason("é".repeat(127))).isEqualTo("ok");
        String ok = ("b".repeat(100) + "/").repeat(10) + "b";
        assertThat(ok.length()).isLessThanOrEqualTo(1024);
        assertThat(reason(ok)).isEqualTo("ok");
        assertThat(reason(("c".repeat(200) + "/").repeat(6))).isEqualTo("length");
        assertThat(reason(("c".repeat(200) + "/").repeat(5) + "c".repeat(100))).isEqualTo("length");
    }

    @Test
    void uploadsAndTrashAreReservedAtTheRootOnly() {
        assertThat(reason(".uploads")).isEqualTo("reserved");
        assertThat(reason(".trash/x")).isEqualTo("reserved");
        assertThat(reason("a/.trash")).isEqualTo("ok");
        assertThat(reason(".uploads2")).isEqualTo("ok");
    }

    @Test
    void foldingIgnoresCase() {
        assertThat(PathRules.fold("README.md")).isEqualTo(PathRules.fold("readme.MD"));
    }
}
