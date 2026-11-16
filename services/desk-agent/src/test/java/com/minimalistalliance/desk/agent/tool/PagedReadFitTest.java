package com.minimalistalliance.desk.agent.tool;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * A paged reader's page as the model reads it ({@link AgentTools#fitPage}): within the run loop's cut of
 * {@link ManagerAgent#MAX_RESULT_CHARS}, with {@code next} moved back to just after what was kept, so reading on from
 * {@code next} again and again gives the whole file, page or note with nothing skipped and nothing twice. Before, deskd's
 * 128 Ki page of a file was cut at 20,000 characters with its {@code next} after the text, so it was lost, and a page of a
 * web page or a note just as full lost its {@code next} the same way.
 */
class PagedReadFitTest {

    private static final int LIMIT = ManagerAgent.MAX_RESULT_CHARS;

    /** The JSON the model reads: the fenced one's second line, or the whole. */
    private static Map<String, Object> parsed(String out, boolean untrusted) throws Exception {
        if (untrusted) {
            String[] lines = out.split("\n", 2);
            assertThat(lines[0]).startsWith("Untrusted content from ");
            Map<String, Object> wrap = Json.parseObject(lines[1].getBytes(StandardCharsets.UTF_8));
            return Json.parseObject(((String) wrap.get("content")).getBytes(StandardCharsets.UTF_8));
        }
        return Json.parseObject(out.getBytes(StandardCharsets.UTF_8));
    }

    /** deskd's text page of a file: decoded from the byte offset, up to 128 Ki characters, as AgentFiles.textPage reads. */
    private static Map<String, Object> deskdTextPage(byte[] file, long offset) throws Exception {
        int want = (int) Math.min(file.length - offset, 128L * 1024 * 3 + 4);
        ByteBuffer bytes = ByteBuffer.wrap(file, (int) offset, want);
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        CharBuffer chars = CharBuffer.allocate(128 * 1024);
        boolean end = offset + want >= file.length;
        assertThat(decoder.decode(bytes, chars, end).isError()).isFalse();
        chars.flip();
        long next = bytes.position();
        Map<String, Object> page = new LinkedHashMap<>();
        page.put("path", "big.txt");
        page.put("text", chars.toString());
        page.put("offset", offset);
        page.put("next", next >= file.length ? null : next);
        return page;
    }

    private static String mixed(int units) {
        StringBuilder b = new StringBuilder();
        String[] pieces = {"plain words ", "é", "日本語", "😀", "\"quoted\"", "\n", "\t", "\\", "\u0001", "</script>"};
        int i = 0;
        while (b.length() < units) {
            b.append(pieces[i++ % pieces.length]);
        }
        return b.toString();
    }

    @Test
    void aFullTextPageFitsAndReadingOnFromNextGivesTheWholeFileExactly() throws Exception {
        String original = mixed(400_000);
        byte[] file = original.getBytes(StandardCharsets.UTF_8);
        StringBuilder read = new StringBuilder();
        long offset = 0;
        int pages = 0;
        while (true) {
            Map<String, Object> page = deskdTextPage(file, offset);
            String out = AgentTools.fitPage("files_read", page, true, LIMIT);
            assertThat(out.length()).isLessThanOrEqualTo(LIMIT);
            Map<String, Object> seen = parsed(out, true);
            String text = (String) seen.get("text");
            // Nothing ends in half a character.
            assertThat(text.isEmpty() || !Character.isHighSurrogate(text.charAt(text.length() - 1))).isTrue();
            read.append(text);
            pages++;
            if (seen.get("next") == null) {
                break;
            }
            long next = ((Number) seen.get("next")).longValue();
            assertThat(next).isEqualTo(offset + text.getBytes(StandardCharsets.UTF_8).length);
            offset = next;
            assertThat(pages).isLessThan(500);
        }
        assertThat(read.toString()).isEqualTo(original);
        assertThat(pages).isGreaterThan(20);
    }

    @Test
    void theCursorComesBeforeTheTextSoAnyCutStillKeepsIt() throws Exception {
        Map<String, Object> page = new LinkedHashMap<>();
        page.put("path", "a.txt");
        page.put("text", "x".repeat(130_000));
        page.put("offset", 0L);
        page.put("next", 130_000L);
        String out = AgentTools.fitPage("files_read", page, false, LIMIT);
        assertThat(out.indexOf("\"next\"")).isLessThan(out.indexOf("\"text\""));
        Map<String, Object> seen = parsed(out, false);
        assertThat((String) seen.get("note")).contains("offset set to next");
        assertThat(((Number) seen.get("next")).longValue()).isEqualTo(((String) seen.get("text")).length());
    }

    @Test
    void aPageThatFitsIsAsDeskdSentIt() throws Exception {
        Map<String, Object> page = new LinkedHashMap<>();
        page.put("path", "a.txt");
        page.put("text", "short");
        page.put("offset", 10L);
        page.put("next", null);
        Map<String, Object> seen = parsed(AgentTools.fitPage("files_read", page, true, LIMIT), true);
        assertThat(seen).containsEntry("text", "short").doesNotContainKey("note");
        assertThat(((Number) seen.get("offset")).longValue()).isEqualTo(10L);
        assertThat(seen.get("next")).isNull();
    }

    @Test
    void aWebPageAndANoteCountTheirOwnCharactersFromFrom() throws Exception {
        for (String tool : List.of("browser_read", "notebook_read")) {
            String key = tool.equals("notebook_read") ? "markdown" : "text";
            String body = mixed(20_000);
            Map<String, Object> page = new LinkedHashMap<>();
            page.put("tabId", "at-1");
            page.put(key, body);
            page.put("from", 40_000L);
            page.put("next", 60_000L);
            String out = AgentTools.fitPage(tool, page, true, LIMIT);
            assertThat(out.length()).as(tool).isLessThanOrEqualTo(LIMIT);
            Map<String, Object> seen = parsed(out, true);
            String kept = (String) seen.get(key);
            assertThat(body).startsWith(kept);
            assertThat(((Number) seen.get("next")).longValue()).as(tool).isEqualTo(40_000L + kept.length());
            assertThat((String) seen.get("note")).contains("from set to next");
        }
    }

    @Test
    void aDocumentsPageCountsCharactersFromItsOffset() throws Exception {
        Map<String, Object> page = new LinkedHashMap<>();
        page.put("path", "a.pdf");
        page.put("type", "pdf");
        page.put("text", "é".repeat(60_000));
        page.put("offset", 131_072L);
        page.put("next", 191_072L);
        Map<String, Object> seen = parsed(AgentTools.fitPage("files_read", page, true, LIMIT), true);
        String kept = (String) seen.get("text");
        assertThat(((Number) seen.get("next")).longValue()).isEqualTo(131_072L + kept.length());
    }

    @Test
    void aResultMadeOfCharactersJsonEscapesStillFits() throws Exception {
        List<String> worst = new ArrayList<>(List.of("\"".repeat(60_000), "\u0001".repeat(60_000), "\\\n".repeat(30_000)));
        for (String text : worst) {
            Map<String, Object> page = new LinkedHashMap<>();
            page.put("tabId", "at-1");
            page.put("text", text);
            page.put("from", 0L);
            page.put("next", null);
            String out = AgentTools.fitPage("browser_read", page, true, LIMIT);
            assertThat(out.length()).isLessThanOrEqualTo(LIMIT);
            Map<String, Object> seen = parsed(out, true);
            assertThat(text).startsWith((String) seen.get("text"));
            assertThat(((Number) seen.get("next")).longValue()).isEqualTo(((String) seen.get("text")).length());
        }
    }
}
