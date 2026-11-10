package com.minimalistalliance.desk.agent.attach.worker;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import javax.xml.XMLConstants;
import javax.xml.stream.XMLInputFactory;
import javax.xml.stream.XMLStreamConstants;
import javax.xml.stream.XMLStreamException;
import javax.xml.stream.XMLStreamReader;

/**
 * Word, Excel and PowerPoint files (the zip-and-XML formats) read to text with the JDK's own parsers, no library. The
 * zip is read as a stream and every byte it inflates is counted, whether the part is wanted or not, so a bomb stops
 * at {@link #MAX_INFLATED}; XML is read with DTDs and external entities off, so there are no entity bombs.
 */
final class OfficeText {

    static final long MAX_INFLATED = 120L << 20;
    static final int MAX_ENTRIES = 4000;
    static final int MAX_SHEETS = 30;
    static final int MAX_ROWS = 50_000;
    static final int MAX_SHARED = 400_000;

    private static final Pattern SLIDE = Pattern.compile("ppt/slides/slide(\\d{1,5})\\.xml");
    private static final Pattern NOTES = Pattern.compile("ppt/notesSlides/notesSlide(\\d{1,5})\\.xml");

    private OfficeText() {}

    static ParseWorker.Result read(String kind, byte[] bytes, int maxChars) {
        try {
            return switch (kind) {
                case "docx" -> docx(bytes, maxChars);
                case "xlsx" -> xlsx(bytes, maxChars);
                default -> pptx(bytes, maxChars);
            };
        } catch (XMLStreamException | IOException e) {
            if (Boolean.getBoolean("ma.attach.debug")) {
                e.printStackTrace();
            }
            return ParseWorker.Result.error("unreadable");
        }
    }

    // ------------------------------------------------------------------ zip

    /** Counts what is inflated across the whole pass. */
    private static final class Budget {
        long inflated;
        int entries;
    }

    private static final class Counted extends FilterInputStream {
        private final Budget budget;

        Counted(InputStream in, Budget budget) {
            super(in);
            this.budget = budget;
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            if (b >= 0) {
                count(1);
            }
            return b;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int n = super.read(buffer, offset, length);
            if (n > 0) {
                count(n);
            }
            return n;
        }

        /** The XML reader closes what it reads at the end of a part; the zip goes on to the next. */
        @Override
        public void close() {}

        private void count(long n) {
            budget.inflated += n;
            if (budget.inflated > MAX_INFLATED) {
                throw new ParseWorker.Bomb();
            }
        }
    }

    /** A part wanted from a pass: its name, and what to do with its bytes. */
    private interface Take {
        boolean wants(String name);

        void part(String name, InputStream in) throws IOException, XMLStreamException;
    }

    private static void walk(byte[] bytes, Take take) throws IOException, XMLStreamException {
        Budget budget = new Budget();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (++budget.entries > MAX_ENTRIES) {
                    throw new ParseWorker.Bomb();
                }
                Counted in = new Counted(zip, budget);
                if (!entry.isDirectory() && take.wants(entry.getName())) {
                    take.part(entry.getName(), in);
                }
                // Reading on to the entry's end, counted: the budget covers the parts that are skipped too.
                byte[] sink = new byte[1 << 14];
                while (in.read(sink) >= 0) {
                    // Counted, discarded.
                }
            }
        }
    }

    private static XMLStreamReader xml(InputStream in) throws XMLStreamException {
        XMLInputFactory factory = XMLInputFactory.newFactory();
        factory.setProperty(XMLInputFactory.SUPPORT_DTD, false);
        factory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
        factory.setProperty(XMLInputFactory.IS_REPLACING_ENTITY_REFERENCES, true);
        factory.setProperty(XMLInputFactory.IS_COALESCING, true);
        factory.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        return factory.createXMLStreamReader(in);
    }

    // ----------------------------------------------------------------- docx

    private static ParseWorker.Result docx(byte[] bytes, int maxChars) throws IOException, XMLStreamException {
        ParseWorker.Capped out = new ParseWorker.Capped(maxChars);
        boolean[] found = new boolean[1];
        walk(bytes, new Take() {
            @Override
            public boolean wants(String name) {
                return name.equals("word/document.xml") && !found[0];
            }

            @Override
            public void part(String name, InputStream in) throws IOException, XMLStreamException {
                found[0] = true;
                XMLStreamReader reader = xml(in);
                boolean inText = false;
                while (reader.hasNext() && !out.full()) {
                    int event = reader.next();
                    if (event == XMLStreamConstants.START_ELEMENT) {
                        switch (reader.getLocalName()) {
                            case "t" -> inText = true;
                            case "tab" -> out.append('\t');
                            case "br", "cr" -> out.append('\n');
                            default -> { }
                        }
                    } else if (event == XMLStreamConstants.CHARACTERS && inText) {
                        out.append(reader.getText());
                    } else if (event == XMLStreamConstants.END_ELEMENT) {
                        switch (reader.getLocalName()) {
                            case "t" -> inText = false;
                            case "p" -> out.append('\n');
                            case "tc" -> out.append('\t');
                            default -> { }
                        }
                    }
                }
            }
        });
        return finish(found[0], out);
    }

    // ----------------------------------------------------------------- pptx

    private static ParseWorker.Result pptx(byte[] bytes, int maxChars) throws IOException, XMLStreamException {
        Map<Integer, String> slides = new TreeMap<>();
        Map<Integer, String> notes = new HashMap<>();
        int[] chars = new int[1];
        walk(bytes, new Take() {
            @Override
            public boolean wants(String name) {
                return SLIDE.matcher(name).matches() || NOTES.matcher(name).matches();
            }

            @Override
            public void part(String name, InputStream in) throws IOException, XMLStreamException {
                if (chars[0] > maxChars) {
                    return;
                }
                Matcher slide = SLIDE.matcher(name);
                boolean isSlide = slide.matches();
                Matcher match = isSlide ? slide : NOTES.matcher(name);
                match.matches();
                int number = Integer.parseInt(match.group(1));
                ParseWorker.Capped text = new ParseWorker.Capped(maxChars);
                XMLStreamReader reader = xml(in);
                boolean inText = false;
                while (reader.hasNext() && !text.full()) {
                    int event = reader.next();
                    if (event == XMLStreamConstants.START_ELEMENT && reader.getLocalName().equals("t")) {
                        inText = true;
                    } else if (event == XMLStreamConstants.CHARACTERS && inText) {
                        text.append(reader.getText());
                    } else if (event == XMLStreamConstants.END_ELEMENT) {
                        if (reader.getLocalName().equals("t")) {
                            inText = false;
                        } else if (reader.getLocalName().equals("p")) {
                            text.append('\n');
                        }
                    }
                }
                chars[0] += text.length();
                (isSlide ? slides : notes).put(number, text.toString());
            }
        });
        if (slides.isEmpty()) {
            return ParseWorker.Result.error("unreadable");
        }
        ParseWorker.Capped out = new ParseWorker.Capped(maxChars);
        for (Map.Entry<Integer, String> slide : slides.entrySet()) {
            out.append("--- Slide " + slide.getKey() + " ---\n");
            out.append(slide.getValue().strip());
            out.append("\n");
            String note = notes.get(slide.getKey());
            if (note != null && !note.isBlank()) {
                out.append("Notes: " + note.strip() + "\n");
            }
            out.append("\n");
            if (out.full()) {
                break;
            }
        }
        return finish(true, out);
    }

    // ----------------------------------------------------------------- xlsx

    private static ParseWorker.Result xlsx(byte[] bytes, int maxChars) throws IOException, XMLStreamException {
        // Pass 1: the sheets' names and where they are, and the shared strings the cells point to.
        List<String[]> sheets = new ArrayList<>();
        Map<String, String> targets = new HashMap<>();
        List<String> shared = new ArrayList<>();
        long[] sharedChars = new long[1];
        boolean[] workbook = new boolean[1];
        walk(bytes, new Take() {
            @Override
            public boolean wants(String name) {
                return name.equals("xl/workbook.xml") || name.equals("xl/_rels/workbook.xml.rels")
                        || name.equals("xl/sharedStrings.xml");
            }

            @Override
            public void part(String name, InputStream in) throws IOException, XMLStreamException {
                XMLStreamReader reader = xml(in);
                if (name.equals("xl/workbook.xml")) {
                    workbook[0] = true;
                    while (reader.hasNext()) {
                        if (reader.next() == XMLStreamConstants.START_ELEMENT && reader.getLocalName().equals("sheet")
                                && sheets.size() < MAX_SHEETS) {
                            String id = null;
                            for (int i = 0; i < reader.getAttributeCount(); i++) {
                                if (reader.getAttributeLocalName(i).equals("id")) {
                                    id = reader.getAttributeValue(i);
                                }
                            }
                            sheets.add(new String[] {reader.getAttributeValue(null, "name"), id});
                        }
                    }
                } else if (name.endsWith(".rels")) {
                    while (reader.hasNext()) {
                        if (reader.next() == XMLStreamConstants.START_ELEMENT
                                && reader.getLocalName().equals("Relationship")) {
                            String id = reader.getAttributeValue(null, "Id");
                            String target = reader.getAttributeValue(null, "Target");
                            if (id != null && target != null) {
                                targets.put(id, target.startsWith("/") ? target.substring(1) : "xl/" + target);
                            }
                        }
                    }
                } else {
                    StringBuilder current = null;
                    boolean inText = false;
                    while (reader.hasNext()) {
                        int event = reader.next();
                        if (event == XMLStreamConstants.START_ELEMENT) {
                            if (reader.getLocalName().equals("si")) {
                                current = new StringBuilder();
                            } else if (reader.getLocalName().equals("t") && current != null) {
                                inText = true;
                            }
                        } else if (event == XMLStreamConstants.CHARACTERS && inText) {
                            current.append(reader.getText());
                        } else if (event == XMLStreamConstants.END_ELEMENT) {
                            if (reader.getLocalName().equals("t")) {
                                inText = false;
                            } else if (reader.getLocalName().equals("si") && current != null) {
                                if (shared.size() >= MAX_SHARED || (sharedChars[0] += current.length()) > (8 << 20)) {
                                    throw new ParseWorker.Bomb();
                                }
                                shared.add(current.toString());
                                current = null;
                            }
                        }
                    }
                }
            }
        });
        if (!workbook[0] || sheets.isEmpty()) {
            return ParseWorker.Result.error("unreadable");
        }
        // Pass 2: each wanted sheet's cells, in the workbook's order.
        Map<String, String> byPath = new HashMap<>();
        walk(bytes, new Take() {
            @Override
            public boolean wants(String name) {
                return targets.containsValue(name) && !byPath.containsKey(name);
            }

            @Override
            public void part(String name, InputStream in) throws IOException, XMLStreamException {
                byPath.put(name, sheet(xml(in), shared, maxChars));
            }
        });
        ParseWorker.Capped out = new ParseWorker.Capped(maxChars);
        for (String[] sheet : sheets) {
            String path = targets.get(sheet[1]);
            String body = path == null ? null : byPath.get(path);
            if (body == null) {
                continue;
            }
            out.append("--- Sheet: " + sheet[0] + " ---\n");
            out.append(body);
            out.append("\n");
            if (out.full()) {
                break;
            }
        }
        return finish(true, out);
    }

    private static String sheet(XMLStreamReader reader, List<String> shared, int maxChars) throws XMLStreamException {
        ParseWorker.Capped out = new ParseWorker.Capped(maxChars);
        List<String> row = new ArrayList<>();
        int rows = 0;
        String type = null;
        int column = 0;
        StringBuilder value = null;
        boolean inValue = false;
        boolean inInline = false;
        while (reader.hasNext() && !out.full()) {
            int event = reader.next();
            if (event == XMLStreamConstants.START_ELEMENT) {
                switch (reader.getLocalName()) {
                    case "row" -> row.clear();
                    case "c" -> {
                        type = reader.getAttributeValue(null, "t");
                        column = columnOf(reader.getAttributeValue(null, "r"), row.size());
                        value = new StringBuilder();
                    }
                    case "v" -> inValue = true;
                    case "t" -> inInline = value != null;
                    default -> { }
                }
            } else if (event == XMLStreamConstants.CHARACTERS && (inValue || inInline) && value != null) {
                value.append(reader.getText());
            } else if (event == XMLStreamConstants.END_ELEMENT) {
                switch (reader.getLocalName()) {
                    case "v" -> inValue = false;
                    case "t" -> inInline = false;
                    case "c" -> {
                        if (value != null) {
                            String cell = value.toString();
                            if ("s".equals(type)) {
                                try {
                                    int index = Integer.parseInt(cell.strip());
                                    cell = index >= 0 && index < shared.size() ? shared.get(index) : "";
                                } catch (NumberFormatException e) {
                                    cell = "";
                                }
                            } else if ("b".equals(type)) {
                                cell = cell.strip().equals("1") ? "TRUE" : "FALSE";
                            }
                            while (row.size() < column && row.size() < 16_384) {
                                row.add("");
                            }
                            if (column < 16_384) {
                                row.add(cell.replace('\t', ' ').replace('\n', ' '));
                            }
                        }
                        value = null;
                        type = null;
                    }
                    case "row" -> {
                        int end = row.size();
                        while (end > 0 && row.get(end - 1).isEmpty()) {
                            end--;
                        }
                        if (end > 0) {
                            out.append(String.join("\t", row.subList(0, end)));
                            out.append('\n');
                        }
                        if (++rows >= MAX_ROWS) {
                            return out.toString();
                        }
                    }
                    default -> { }
                }
            }
        }
        return out.toString();
    }

    /** Zero-based column of a cell reference like {@code C7}; the next free column when it has none. */
    private static int columnOf(String reference, int next) {
        if (reference == null) {
            return next;
        }
        int column = 0;
        int i = 0;
        while (i < reference.length() && Character.isLetter(reference.charAt(i))) {
            column = column * 26 + (Character.toUpperCase(reference.charAt(i)) - 'A' + 1);
            i++;
            if (column > 20_000) {
                return 20_000;
            }
        }
        return i == 0 ? next : column - 1;
    }

    private static ParseWorker.Result finish(boolean found, ParseWorker.Capped out) {
        if (!found) {
            return ParseWorker.Result.error("unreadable");
        }
        String text = out.toString().strip();
        if (text.isEmpty()) {
            return ParseWorker.Result.error("empty");
        }
        return ParseWorker.Result.ok(text, out.full() ? "cut" : null);
    }
}
