package com.minimalistalliance.desk.agent.attach.worker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.attach.Caps;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** ADR 0097's request line, read strictly: what it accepts, and every malformed shape refused. */
class ParseRequestTest {

    private static ParseRequest read(String text) throws IOException, ParseRequest.Malformed {
        return ParseRequest.read(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void aWellFormedLineIsRead() throws Exception {
        assertThat(read("parse1 pdf 100000 100\n")).isEqualTo(new ParseRequest("pdf", 100000, 100));
        for (String kind : new String[] {"text", "pdf", "docx", "xlsx", "pptx"}) {
            assertThat(read("parse1 " + kind + " 1 1\n").kind()).isEqualTo(kind);
        }
        assertThat(read("parse1 text 2000000 500\n")).isEqualTo(new ParseRequest("text", 2_000_000, 500));
    }

    @Test
    void theLineIsWhatDeskAgentWrites() throws Exception {
        ParseRequest request = new ParseRequest("xlsx", 123456, 7);
        assertThat(new String(request.header(), StandardCharsets.US_ASCII)).isEqualTo("parse1 xlsx 123456 7\n");
        assertThat(read(new String(request.header(), StandardCharsets.US_ASCII))).isEqualTo(request);
        assertThat(new ParseRequest("pptx", ParseRequest.MAX_CHARS, ParseRequest.MAX_PAGES).header().length)
                .isLessThanOrEqualTo(ParseRequest.MAX_LINE);
    }

    @Test
    void nothingAfterTheNewlineIsConsumed() throws Exception {
        InputStream in = new ByteArrayInputStream("parse1 text 1000 1\nthe file".getBytes(StandardCharsets.US_ASCII));
        ParseRequest.read(in);
        assertThat(new String(in.readAllBytes(), StandardCharsets.US_ASCII)).isEqualTo("the file");
    }

    @Test
    void theBoundsAreAdr0097sCeilings() {
        assertThat(ParseRequest.MAX_CHARS).isEqualTo(2_000_000);
        assertThat(ParseRequest.MAX_PAGES).isEqualTo(500);
        // Attachments (attach/Caps) ask for less, so the sidecar never cuts one.
        assertThat(ParseRequest.MAX_CHARS).isGreaterThanOrEqualTo(Caps.CEILING.maxFileChars());
        assertThat(ParseRequest.MAX_PAGES).isGreaterThanOrEqualTo(Caps.CEILING.maxPdfPages());
        assertThat(new ParseRequest("pptx", 2_000_000, 500).header()).hasSize(24);
        assertThat((long) ParseRequest.MAX_BYTES).isEqualTo(Caps.CEILING.maxFileBytes());
        assertThat(ParseRequest.MAX_BYTES).isLessThan(ParseWorker.MAX_INPUT);
    }

    @ParameterizedTest
    @ValueSource(strings = {
        // the word and the version
        "parse2 text 1000 1\n", "parse text 1000 1\n", "PARSE1 text 1000 1\n", "ma-parse 1 text 1000 1\n",
        // the kind
        "parse1 doc 1000 1\n", "parse1 PDF 1000 1\n", "parse1 image 1000 1\n", "parse1  1000 1\n",
        "parse1 pdf\u0000 1000 1\n",
        // out of range
        "parse1 text 0 1\n", "parse1 text 2000001 1\n", "parse1 text 1000 0\n", "parse1 text 1000 501\n",
        "parse1 text 9999999 1\n", "parse1 text 2000000 501\n",
        // not plain decimal
        "parse1 text 1e3 1\n", "parse1 text +1000 1\n", "parse1 text -1000 1\n", "parse1 text 0x10 1\n",
        "parse1 text 01000 1\n", "parse1 text 1000 01\n", "parse1 text 1,000 1\n", "parse1 text 1000.0 1\n",
        "parse1 text ١٢ 1\n", "parse1 text 1000 2147483648\n",
        // spacing and fields
        "parse1 text 1000\n", "parse1 text 1000 1 extra\n", "parse1 text 1000 1 \n", " parse1 text 1000 1\n",
        "parse1  text 1000 1\n", "parse1\ttext 1000 1\n", "parse1 text 1000 1\r\n", "\n", "parse1\n",
    })
    void aMalformedLineIsRefused(String line) {
        assertThatThrownBy(() -> read(line)).isInstanceOf(ParseRequest.Malformed.class);
    }

    @Test
    void aLineWithNoNewlineInItsFirst64BytesIsRefused() {
        String padded = "parse1 text 1000 1" + " ".repeat(45) + "\n";
        assertThat(padded.length()).isEqualTo(64);
        assertThatThrownBy(() -> read(padded)).isInstanceOf(ParseRequest.Malformed.class);
        assertThatThrownBy(() -> read("x".repeat(100))).isInstanceOf(ParseRequest.Malformed.class);
        assertThatThrownBy(() -> read("parse1 text " + "1".repeat(60) + " 1\n"))
                .isInstanceOf(ParseRequest.Malformed.class);
    }

    @Test
    void aMissingLineIsRefused() {
        assertThatThrownBy(() -> read("")).isInstanceOf(ParseRequest.Malformed.class);
        assertThatThrownBy(() -> read("parse1 text 1000 1")).isInstanceOf(ParseRequest.Malformed.class);
    }

    @Test
    void desk_agentCannotBuildALineOutOfRange() {
        assertThatThrownBy(() -> new ParseRequest("doc", 1000, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ParseRequest("text", 2_000_001, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ParseRequest("pdf", 1000, 501)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ParseRequest("pdf", 0, 1)).isInstanceOf(IllegalArgumentException.class);
    }
}
