package com.minimalistalliance.desk.agent.attach.worker;

import com.minimalistalliance.desk.courier.parse.WorkerMode;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The parse sandbox's documents mode (deskd {@code API.md} §25; the draft ADR "Documents" decision 5): deskd's
 * {@code docs} module asks the sandbox's one worker ({@code courier-parse}'s {@code CourierWorker}, found through
 * {@link WorkerMode}) for a document's text per page, each line's box and its empty signature fields, and for a PDF
 * page drawn as a JPEG. The original bytes never leave the sandbox: only text and freshly drawn pixels do.
 *
 * <p>Two request lines, strict (at most {@link #MAX_LINE} bytes; decimals with no sign or leading zero):
 * <ul>
 * <li>{@code docs1 read <kind> <maxChars> <maxPages>}, kind {@code pdf docx xlsx pptx text}: {@code OK} then one JSON
 *     object, {@code docs-read 1} ({@link #read});</li>
 * <li>{@code docs1 render <page> <width>}, a PDF: {@code OK jpeg <w> <h>} then the image ({@link PdfRender}).</li>
 * </ul>
 * Refusals: {@code encrypted}, {@code unreadable}, {@code too_complex}, {@code too_large}, {@code not_found} (a page past
 * the end), {@code unsupported}, {@code bad_request}; the worker's own deadline answers {@code timeout}.
 */
public final class DocsMode implements WorkerMode {

    static final String WORD = "docs1";
    static final int MAX_LINE = 64;
    static final int MAX_CHARS = 200_000;
    static final int MAX_PAGES = 500;
    static final int MIN_WIDTH = 200;
    static final int MAX_WIDTH = 1600;
    private static final Pattern DECIMAL = Pattern.compile("[1-9][0-9]{0,6}");
    static final List<String> KINDS = List.of("pdf", "docx", "xlsx", "pptx", "text");

    /** A request, read. */
    record Request(String op, String kind, int a, int b) {}

    @Override
    public String word() {
        return WORD;
    }

    @Override
    public void warmUp() {
        PdfRender.warmUp();
    }

    /** The line, or null when it isn't one of the two shapes exactly. */
    static Request parse(String line) {
        if (line == null || line.length() > MAX_LINE - 1) {
            return null;
        }
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c < 0x20 || c > 0x7E) {
                return null;
            }
        }
        String[] f = line.split(" ", -1);
        if (f.length < 2 || !f[0].equals(WORD)) {
            return null;
        }
        if (f[1].equals("read") && f.length == 5 && KINDS.contains(f[2]) && DECIMAL.matcher(f[3]).matches()
                && DECIMAL.matcher(f[4]).matches()) {
            int chars = Integer.parseInt(f[3]);
            int pages = Integer.parseInt(f[4]);
            return chars <= MAX_CHARS && pages <= MAX_PAGES ? new Request("read", f[2], chars, pages) : null;
        }
        if (f[1].equals("render") && f.length == 4 && DECIMAL.matcher(f[2]).matches() && DECIMAL.matcher(f[3]).matches()) {
            int page = Integer.parseInt(f[2]);
            int width = Integer.parseInt(f[3]);
            return page <= MAX_PAGES && width >= MIN_WIDTH && width <= MAX_WIDTH ? new Request("render", "pdf", page, width) : null;
        }
        return null;
    }

    @Override
    public void serve(String line, InputStream in, Reply reply, long millis) throws IOException {
        Request request = parse(line);
        if (request == null) {
            reply.drain();
            reply.refuse("bad_request");
            return;
        }
        Answer answer;
        try {
            answer = request.op().equals("read") ? read(request.kind(), in, request.a(), request.b())
                    : PdfRender.render(Input.read(in, ParseWorker.MAX_INPUT), request.a(), request.b());
        } catch (TooLarge e) {
            answer = Answer.refused("too_large");
        } catch (ParseWorker.Bomb e) {
            answer = Answer.refused("too_complex");
        } catch (IOException e) {
            answer = Answer.refused("input".equals(e.getMessage()) ? "too_large" : "unreadable");
        }
        reply.drain();
        if (answer.reason() != null) {
            reply.refuse(answer.reason());
        } else {
            reply.ok(answer.note(), answer.body());
        }
    }

    /** What a request comes to: a note and a body, or a reason. */
    record Answer(String note, byte[] body, String reason) {
        static Answer ok(String note, byte[] body) {
            return new Answer(note, body, null);
        }

        static Answer refused(String reason) {
            return new Answer(null, null, reason);
        }
    }

    /** Over the sandbox's 40 MiB. */
    static final class TooLarge extends IOException {
        private static final long serialVersionUID = 1L;

        TooLarge() {
            super("too_large", null);
        }
    }

    /** {@code docs1 read}: the document's text as pages or sections, as {@code docs-read 1} JSON. */
    static Answer read(String kind, InputStream in, int maxChars, int maxPages) throws IOException {
        Map<String, Object> out;
        if (kind.equals("pdf")) {
            Input input;
            try {
                input = Input.read(in, ParseWorker.MAX_INPUT);
            } catch (IOException e) {
                throw "input".equals(e.getMessage()) ? new TooLarge() : e;
            }
            PdfPages.Read read = PdfPages.read(input, maxChars, maxPages);
            if (read.reason() != null) {
                return Answer.refused(read.reason());
            }
            out = read.json();
        } else {
            ParseWorker.Result result = ParseWorker.read(kind, in, maxChars, maxPages);
            if (result.reason() != null && !result.reason().equals("empty") && !result.reason().equals("no_text")) {
                return Answer.refused(switch (result.reason()) {
                    case "encrypted" -> "encrypted";
                    case "unsupported_type" -> "unsupported";
                    default -> "unreadable";
                });
            }
            out = sections(kind, ParseWorker.clean(result.text()), "cut".equals(result.note()));
        }
        return Answer.ok("", MiniJson.write(out).getBytes(StandardCharsets.UTF_8));
    }

    /** The reading view of an Office file or a text: pages for slides and text, sections in order for the rest. */
    static Map<String, Object> sections(String kind, String text, boolean cut) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("v", 1);
        out.put("kind", kind);
        List<Map<String, Object>> pages = new ArrayList<>();
        List<Map<String, Object>> sections = new ArrayList<>();
        switch (kind) {
            case "text" -> {
                if (!text.isBlank()) {
                    pages.add(page(1, text.strip()));
                }
            }
            case "pptx" -> {
                int n = 0;
                StringBuilder body = null;
                for (String line : text.split("\n", -1)) {
                    java.util.regex.Matcher m = SLIDE.matcher(line);
                    if (m.matches()) {
                        if (body != null) {
                            addSlide(pages, sections, n, body.toString().strip());
                        }
                        n = Integer.parseInt(m.group(1));
                        body = new StringBuilder();
                    } else if (body != null) {
                        body.append(line).append('\n');
                    }
                }
                if (body != null) {
                    addSlide(pages, sections, n, body.toString().strip());
                }
            }
            case "xlsx" -> {
                Map<String, Object> sheet = null;
                List<List<String>> rows = null;
                for (String line : text.split("\n", -1)) {
                    java.util.regex.Matcher m = SHEET.matcher(line);
                    if (m.matches()) {
                        sheet = new LinkedHashMap<>();
                        sheet.put("kind", "sheet");
                        sheet.put("text", m.group(1));
                        rows = new ArrayList<>();
                        sheet.put("rows", rows);
                        sections.add(sheet);
                    } else if (rows != null && !line.isBlank() && rows.size() < MAX_ROWS) {
                        rows.add(cells(line));
                    }
                }
            }
            default -> { // docx: paragraphs, and runs of tabbed lines as a table
                List<List<String>> table = null;
                for (String line : text.split("\n", -1)) {
                    if (line.isBlank()) {
                        table = null;
                        continue;
                    }
                    if (line.indexOf('\t') >= 0) {
                        if (table == null) {
                            Map<String, Object> t = new LinkedHashMap<>();
                            t.put("kind", "table");
                            t.put("text", "");
                            table = new ArrayList<>();
                            t.put("rows", table);
                            sections.add(t);
                        }
                        if (table.size() < MAX_ROWS) {
                            table.add(cells(line));
                        }
                        continue;
                    }
                    table = null;
                    Map<String, Object> p = new LinkedHashMap<>();
                    p.put("kind", line.length() <= 80 && !line.endsWith(".") && HEADING.matcher(line).matches() ? "h" : "p");
                    p.put("text", line.strip());
                    sections.add(p);
                }
            }
        }
        out.put("pageCount", pages.size());
        out.put("cut", cut);
        out.put("pages", pages);
        out.put("sections", sections);
        out.put("fields", Map.of("signatures", 0, "signaturesEmpty", 0, "formEmpty", 0));
        return out;
    }

    static final int MAX_ROWS = 200;
    static final int MAX_COLS = 30;
    private static final Pattern SLIDE = Pattern.compile("--- Slide (\\d{1,5}) ---");
    private static final Pattern SHEET = Pattern.compile("--- Sheet: (.{0,200}) ---");
    /** A short line in title case or capitals, no sentence: shown as a heading in the reading view only. */
    private static final Pattern HEADING = Pattern.compile("(?:[0-9.]+ )?\\p{Lu}[^\\t]{0,79}");

    private static void addSlide(List<Map<String, Object>> pages, List<Map<String, Object>> sections, int n, String body) {
        pages.add(page(n, body));
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("kind", "slide");
        s.put("text", body);
        sections.add(s);
    }

    private static List<String> cells(String line) {
        String[] parts = line.split("\t", -1);
        List<String> out = new ArrayList<>();
        for (int i = 0; i < parts.length && i < MAX_COLS; i++) {
            out.add(parts[i].strip());
        }
        return out;
    }

    static Map<String, Object> page(int n, String text) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("n", n);
        p.put("text", text);
        return p;
    }
}
