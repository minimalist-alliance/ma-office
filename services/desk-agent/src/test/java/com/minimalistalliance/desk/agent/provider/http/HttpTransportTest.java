package com.minimalistalliance.desk.agent.provider.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class HttpTransportTest {

    /** A key never goes anywhere in clear text but this machine. */
    @Test
    void aBaseUrlIsHttpsOrLoopback() {
        assertThat(HttpTransport.baseUri("https://api.anthropic.com/").toString()).isEqualTo("https://api.anthropic.com");
        assertThat(HttpTransport.baseUri("http://127.0.0.1:8080").getPort()).isEqualTo(8080);
        assertThat(HttpTransport.baseUri("http://localhost:1/x").getPath()).isEqualTo("/x");
        for (String bad : new String[] {"http://api.openai.com", "ftp://127.0.0.1", "https://u:p@api.x.ai",
            "https://api.x.ai/?a=b", "api.x.ai"}) {
            assertThatThrownBy(() -> HttpTransport.baseUri(bad)).as(bad).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void sseEventsSplitOnBlankLinesWithCrlfCommentsAndMultilineData() throws Exception {
        String stream = ": comment\r\nevent: a\r\ndata: one\r\n\r\ndata: two\ndata: three\n\nevent: b\ndata:four\n";
        SseReader reader = new SseReader(new ByteArrayInputStream(stream.getBytes(StandardCharsets.UTF_8)));
        assertThat(reader.next()).isEqualTo(new SseReader.Event("a", "one"));
        assertThat(reader.next()).isEqualTo(new SseReader.Event(null, "two\nthree"));
        assertThat(reader.next()).isEqualTo(new SseReader.Event("b", "four"));
        assertThat(reader.next()).isNull();
    }

    @Test
    void anEndlessLineIsRefused() {
        byte[] line = new byte[SseReader.MAX_LINE + 10];
        java.util.Arrays.fill(line, (byte) 'a');
        SseReader reader = new SseReader(new ByteArrayInputStream(line));
        assertThatThrownBy(reader::next).hasMessageContaining("too long");
    }
}
